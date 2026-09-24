import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BUILD_CHECK_TIMEOUT_MS, type BuildCheck, detectBuildCheck } from "./build-check-detect.js";
import { logEvent, warnEvent } from "./events.js";
import { truncate } from "./text.js";
import { signalTree } from "./pi.js";

const execFileAsync = promisify(execFile);

/** The deterministic build pre-check the review gate runs before any model reviewer: detect
 * the project's declared check (an npm script — `test` preferred per npm convention, then
 * `typecheck`, then `build`) by walking up to the installed root, run it in the worktree with a
 * hard timeout, and classify the outcome. Split out of review.ts — which
 * keeps the adversarial review gate itself — because this is a self-contained concern with its
 * own data model (BuildCheck/BuildCheckOutcome), detection algorithm (walk-up to the install — now build-check-detect.ts, its own pure
 * filesystem concern),
 * and execution/classification logic: deterministic process verification, distinct from the
 * model-based review. runScopedBuildCheck below is the shared detect → run → build_check
 * event → skip-warning sequence of the gate's pre-check (review.ts) and the landing path's
 * in-lock re-check (merge.ts). The red-main baseline gate (main-red.ts) reuses this same
 * detection and execution from main-baseline.ts to verify main itself once per SHA before an
 * authoring run is spent on top of it. clipReason/MAX_REASON_CHARS live here too — they bound one line of machine text, shared
 * by clipBuildTail and parseVerdict in review.ts — so that helper has a single home. */

/** Per-reason length cap with ellipsis — bounds one line of machine-generated or reviewer
 * text so it cannot bloat persisted state (shared by clipBuildTail here and parseVerdict in
 * review.ts). */
const MAX_REASON_CHARS = 300;

/** Cap one line of text to MAX_REASON_CHARS with an ellipsis (unchanged when it fits). */
export function clipReason(r: string): string {
  return truncate(r, MAX_REASON_CHARS);
}

// A check whose correctness must not depend on model compliance is run by the harness, not
// asked of the reviewer (plans/review-gate.md): the reviewer may not run state-changing
// commands, and `npm run build` is exactly that — type errors are invisible to a model that
// cannot compile. Detection of WHICH check to run (the walk-up to the installed root and the
// declared script) lives in build-check-detect.ts; this file runs and classifies it.

// ── Execution ─────────────────────────────────────────────────────────────────────────────

/** Hard cap on one build check run — a hung script (watch mode) must not wedge the tick, and
 * a timeout is environmental, never fail-closed. A parameter of runBuildCheck so tests can
 * shorten it. Defined in build-check-detect.ts (the configured command's timeoutSeconds
 * resolves against it there) and re-exported here, where every consumer imports it. */
export { BUILD_CHECK_TIMEOUT_MS } from "./build-check-detect.js";

/** SIGTERM → SIGKILL escalation window once a build check's timeout has FIRED: the whole
 * process group gets SIGTERM, and anything still alive this much later (a SIGTERM-trapping
 * runner, a wedged worker) is SIGKILLed. The default of runBuildCheck's killGraceMs
 * parameter, which tests shrink — pinning both that the escalation is armed on timeout
 * (never at spawn: a healthy check that merely outlasts the grace period must run to
 * completion) and that a surviving grandchild is taken down. */
const KILL_GRACE_MS = 10_000;

/** Why a declared check reached no verdict: the script never finished (timeout), npm is not on
 * PATH, or the toolchain below the project is broken. Shared with main-baseline.ts's
 * MainBaselineCheck, whose skip is the same three-way environmental case — the string literals
 * live in one place so a new reason can be added without two unions drifting apart. */
export type BuildSkipReason = "timeout" | "no-npm" | "toolchain";

/** What the deterministic build check concluded. "passed": proceed to the reviewer unchanged.
 * "failed": a started process exited nonzero — a deterministic REJECTION with the clipped
 * output tail as machine-generated reasons (no pi run consumed). "skipped": environmental
 * (timeout, no npm on PATH, or a broken toolchain) — warn and still proceed to the model
 * review; deliberately NOT fail-closed so a hung build script cannot wedge every code tick into
 * the 3-strike discard, and a toolchain broken below the project (BUGS.md 2026-09-15) cannot be
 * misread as a red build of the tree. runScopedBuildCheck remaps a timeout at a merge scope
 * (landing/batch) to "failed": a suite that never finished is unverified, not environmental. */
export interface BuildCheckOutcome {
  status: "passed" | "failed" | "skipped";
  /** The script that was run (or attempted). */
  script: string;
  /** Clipped tail of the combined output on failure — last ≤10 meaningful lines (non-blank,
   * npm banner excluded), each clipped to MAX_REASON_CHARS. */
  outputTail?: string[];
  /** Why no verdict was reached ("skipped"). */
  skipReason?: BuildSkipReason;
}

/** Probe the check's environment BEFORE spending a run on it: `git --version`, unambiguous
 * and fast, and it exercises the same binary (and the same xcrun shim on macOS) a
 * git-dependent check would. "broken" — git ran and refused to work, e.g. exit 69 on an
 * invalidated Xcode license — is the environmental case: it would fail EVERY check with noise
 * unrelated to the tree, and a failure so read is a false red build (BUGS.md 2026-09-15: exactly
 * that made the harness's own suite fail and latched a false "main is red" on a green tree). It
 * must read as a skip — warn-and-proceed — like no-npm, never as a deterministic rejection.
 * "missing" (git absent from PATH) is NOT broken: a check whose script never touches git runs
 * fine without it, so the check proceeds. Never throws. */
async function probeToolchain(): Promise<"ok" | "broken" | "missing"> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 10_000 });
    return "ok";
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    // A string errno is a spawn failure (no binary at all); a numeric exit is git running and
    // failing. A probe timeout (a string signal) reads as "missing" — proceed, and the check's
    // own timeout bounds the worst case.
    return typeof code === "number" ? "broken" : "missing";
  }
}

/** Toolchain-level failure signatures in a check's output. A run that died on one of these
 * was killed by the environment, not the tree: its nonzero exit says nothing about the code
 * (BUGS.md 2026-09-15 — an invalidated Xcode license put both of these into the harness's own
 * suite output and the harness latched a false red main on a green tree). The probe above
 * catches a broken git before anything runs; this catches what it cannot — a sub-tool that
 * the probe cannot see (xcrun under a working git) or a suite whose runner reported the
 * failure in its own output. */
const TOOLCHAIN_ERROR_PATTERNS: Array<RegExp> = [
  /you have not agreed to the \S+ license/i,
  /xcrun: error/i,
];

function toolchainErrorInOutput(output: string): boolean {
  return TOOLCHAIN_ERROR_PATTERNS.some((p) => p.test(output));
}

/** A line that NAMES a failure rather than framing it: Node prints an unhandled error's message
 * ABOVE its stack and property dump (`Error: ENOENT: …`, `AssertionError [ERR_ASSERTION]: …`),
 * so a ten-line tail window that cuts the stack can cut the message too. The pattern is used to
 * PRESERVE that line, never to skip lines: an over-broad "skip property lines" rule would drop
 * real diff content like `actual: 1,` / `expected: 2,` and pick a trailing `diff: 'simple'`
 * instead (BUGS.md 2026-09-19). It matches `<Something>Error: …` / `<Something>Error [CODE]: …`. */
const ERROR_MESSAGE_LINE = /^\S*Error\b[^:]*:\s/;

/** Keep the TAIL of a build's combined output: last ≤10 meaningful lines, each via clipReason —
 * so a chatty build cannot bloat persisted state or the injected next-tick note. Blank lines
 * and npm's own script banner (`> pkg@1.0 script`, `> <command>`) are dropped: they name the
 * script that ran, not what broke in it. When the ten-line window cuts off the error-message
 * line that sits above the stack, the nearest such line is kept as well (eleven lines at most),
 * so failureHeadline can name the failure instead of a stack frame or an error property. */
export function clipBuildTail(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^>\s/.test(l));
  const tail = lines.slice(-10);
  const message = [...lines.slice(0, -10)].reverse().find((l) => ERROR_MESSAGE_LINE.test(l));
  return (message ? [message, ...tail] : tail).map(clipReason);
}

/** The line of a clipped failure tail (clipBuildTail) worth putting in a one-line warning.
 * clipBuildTail keeps the LAST ten meaningful lines (plus the error-message line above the
 * window when it would otherwise be cut), so a check that died on an unhandled rejection ends
 * mid-stack and the tail's FIRST line is a frame: every red-main warning logged before
 * 2026-09-18 read "main <sha> is red (test: at process.processTicksAndRejections
 * (node:internal/...))" — where, never what, which is why a false red that blocked the fleet
 * for hours could not be diagnosed from the event feed at all (BUGS.md). Prefer the first line
 * that is not framing — a stack frame, or node:test's summary/framing lines (below) — and fall
 * back to the tail's first line when every line is framing, so a caller always has something
 * to print. Only framing is skipped — an assertion diff,
 * a compiler error and a bare "1) test name" all read as the headline they are. Lives beside
 * clipBuildTail, whose output it interprets, so every consumer of a check's tail — the red-main
 * gate (main-red.ts) and the review gate (review.ts) — shares one "which line is the
 * headline" answer. node:test's spec reporter ends a failing run with its summary block
 * (`ℹ pass 0`, `ℹ todo 0`, `ℹ duration_ms …`) followed by the `✖ failing tests:` detail
 * (a bare `test at <file>:<line>` marker, then the failure's own message); when both fit in
 * the ten-line window the first non-frame line was a summary counter, and the headline named
 * nothing again (BUGS.md 2026-09-22) — so summary and section-framing lines are skipped like
 * frames, while a failure line (`✖ <message>`) and an assertion diff still read as the
 * headline they are. */
const FRAMING_LINE = /^(?:at\s|ℹ\s|✖ failing tests:|test at \S+:\d+:\d+)/;

export function failureHeadline(tail: readonly string[] | undefined): string | undefined {
  if (!tail?.length) return undefined;
  return tail.find((line) => !FRAMING_LINE.test(line)) ?? tail[0];
}

/** What one runScriptGroup attempt observed — enough for runBuildCheck to classify the
 * outcome exactly as execFile's rejection used to: how the process ended (exit code or
 * signal), whether the check's timeout fired, what the script printed, and whether it
 * never spawned at all. */
interface ScriptGroupResult {
  code?: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
}

/** Run `cmd args` detached — its own process group, exactly like pi — and settle exactly
 * once: on the process's exit or when timeoutMs fires, whichever comes first. The timeout is
 * enforced GROUP-WIDE, never against the direct child alone: execFileAsync's `timeout` option
 * signalled npm and nothing else, so everything below it (`node --test` → one worker per
 * file) survived and reparented to PID 1 for as long as twelve days (BUGS.md 2026-09-21).
 * When the timeout fires the whole group gets SIGTERM, and anything still alive after
 * killGraceMs — a SIGTERM-trapping runner, a wedged worker — is SIGKILLed. The escalation is
 * armed HERE, when the timeout fires, never at spawn: a healthy check that merely outlasts
 * the grace period must run to completion (the 2026-09-22 review-gate catch — a timer armed
 * at spawn SIGKILLed every healthy check longer than KILL_GRACE_MS and misclassified it as a
 * timeout, freezing all merge-scope checks). The escalation timer is unref'd and survives
 * the group leader's exit on purpose: npm dying on the SIGTERM must not cancel the SIGKILL a
 * lingering grandchild still needs; resolving at timeout-fire keeps the caller's latency
 * bounded while the teardown finishes in the background. Captured output is capped at
 * maxBuffer per stream (further chunks are dropped — classification reads the tail), so a
 * chatty script can neither wedge the check nor balloon memory. Never throws; a spawn
 * failure (npm missing from PATH) is reported as spawnError. */
function runScriptGroup(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; killGraceMs: number; maxBuffer: number },
): Promise<ScriptGroupResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutSize < opts.maxBuffer) {
        stdoutSize += chunk.length;
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrSize < opts.maxBuffer) {
        stderrSize += chunk.length;
        stderr += chunk;
      }
    });
    const finish = (result: Omit<ScriptGroupResult, "timedOut" | "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      // The SIGKILL escalation is cancelled only when the timeout never fired: once it has,
      // the escalation must survive the group leader's exit (npm dies on the SIGTERM; a
      // trapped grandchild does not) and still reach the rest of the group. unref'd below,
      // so it never keeps the harness process alive.
      if (!timedOut) clearTimeout(killTimer);
      resolve({ ...result, timedOut, stdout, stderr });
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalTree(child, "SIGKILL"), opts.killGraceMs);
      killTimer.unref();
      finish({ signal: "SIGTERM" });
    }, opts.timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => finish({ spawnError: err }));
    child.on("close", (code, signal) => {
      // After the timeout fired this run is already classified; the group teardown (if any
      // is still needed) continues on the escalation timer in the background.
      finish({ code: code ?? undefined, signal: signal ?? undefined });
    });
  });
}

/** The human/prompt-facing name of a check (plans/portability.md §6/7): the tick prompt and
 * the build-fix prompt name the actual verification command instead of asserting npm —
 * "verify with `pytest -q`" in a Python repo, "`npm run test`" in an npm one. */
export function describeCheck(check: BuildCheck): string {
  return check.kind === "npm" ? `\`npm run ${check.script}\`` : `\`${check.command}\``;
}

/** The timeout a check actually runs under: a configured command carries its own
 * (check.timeoutSeconds → detectBuildCheck's timeoutMs), an npm check takes the caller's.
 * One resolution so the run, the event, and the skip warning cannot disagree. */
function checkTimeoutMs(check: BuildCheck, fallbackMs: number): number {
  return check.kind === "command" ? check.timeoutMs : fallbackMs;
}

/** The name an outcome records for what ran: an npm check's script name, a configured
 * command's command verbatim. Kept as one field so the build_check event and every reason
 * headline keep their shape across both kinds. */
function checkScriptName(check: BuildCheck): string {
  return check.kind === "npm" ? check.script : check.command;
}

/** Probe the toolchain (see probeToolchain), then run the declared check in the worktree —
 * `npm run <script>` (cwd = wt) for the npm kind, `check.command` through a shell
 * (`sh -c`, cwd = check.cwd) for the configured-command kind — capturing combined output
 * with a hard timeout enforced GROUP-WIDE — the process tree, not just the top process —
 * and classified per BuildCheckOutcome. Never throws: every outcome is classified. Running
 * a local script needs no network. No env manipulation is needed even though the worktree
 * has no node_modules of its own (gitignored): npm's run-script walks UP from the project
 * path, adding EVERY level's `node_modules/.bin` to the script's PATH (@npmcli/run-script
 * setPATH), so the toolchain at check.rootDir — an ancestor of wt by detectBuildCheck
 * construction — is resolvable without any help. The script still runs in wt, compiling the
 * branch state — which is what this check exists for; build-check.test.ts pins the
 * no-node_modules-worktree resolution. A configured command's cwd is resolved by
 * detectBuildCheck against the worktree the detection started from. */
export async function runBuildCheck(
  wt: string,
  check: BuildCheck,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
): Promise<BuildCheckOutcome> {
  const script = checkScriptName(check);
  const effectiveMs = checkTimeoutMs(check, timeoutMs);
  // Environmental probe first: a toolchain broken below the project (git exiting 69 on an
  // invalidated Xcode license) would fail the check with noise unrelated to the tree and the
  // failure would be misread as a red build — run nothing, read it as a skip (BUGS.md 2026-09-15).
  if ((await probeToolchain()) === "broken") {
    return { status: "skipped", script, skipReason: "toolchain" };
  }
  const r =
    check.kind === "command"
      ? await runScriptGroup("sh", ["-c", check.command], {
          cwd: check.cwd,
          timeoutMs: effectiveMs,
          killGraceMs,
          maxBuffer: 32 * 1024 * 1024,
        })
      : await runScriptGroup("npm", ["run", check.script], {
          cwd: wt,
          timeoutMs: effectiveMs,
          killGraceMs,
          maxBuffer: 32 * 1024 * 1024,
        });
  // Spawn failed before anything ran — the runner is missing from PATH.
  if (r.spawnError) return { status: "skipped", script, skipReason: "no-npm" };
  // The timeout fired (or the tree died on a signal): environmental — warn and proceed. A
  // timed-out check's whole process tree is already being taken down group-wide by
  // runScriptGroup (SIGTERM now, SIGKILL after the grace if anything survived).
  if (r.timedOut || r.signal) return { status: "skipped", script, skipReason: "timeout" };
  if (r.code === 0) return { status: "passed", script };
  // A started process that exited nonzero is a deterministic failure of the build itself —
  // unless its output names a broken toolchain: then the environment, not the tree, killed it,
  // and the same skip semantics apply (never a deterministic rejection, never a red baseline).
  if (typeof r.code === "number") {
    const output = `${r.stdout}${r.stderr}`;
    if (toolchainErrorInOutput(output)) {
      return { status: "skipped", script, skipReason: "toolchain" };
    }
    return {
      status: "failed",
      script,
      outputTail: clipBuildTail(output),
    };
  }
  // Spawn failed before anything ran — the runner is missing from PATH.
  return { status: "skipped", script, skipReason: "no-npm" };
}

/** The scopes named in a build_check event logged from this helper. The red-main baseline
 * names its own ("baseline") from main-red.ts, because the one-run-per-SHA cache and in-flight
 * dedup live in checkMainBaseline — the event there is logged by the paying role via the onRun
 * hook. */
type BuildCheckScope = "gate" | "landing" | "batch";

/** Per-scope wording for the environmental-skip warning. The call sites' current messages
 * are identical apart from these words, so keying them on the scope keeps each surface's feed
 * line byte-for-byte what it is today. */
const SCOPE_WORDS: Record<BuildCheckScope, { label: string; proceeding: string }> = {
  gate: { label: "build check", proceeding: "proceeding to model review" },
  landing: { label: "landing build check", proceeding: "proceeding to merge" },
  // The batch's next step after the check is the fast-forward — the same phrase the landing
  // scope uses (gate says "proceeding to model review" because its next step is the reviewer).
  batch: { label: "batch build check", proceeding: "proceeding to merge" },
};

/** Scopes whose outcome gates a merge to main. A timeout here leaves the tree unverified, and
 * these are the last checks before main, so it rejects deterministically; the gate scope's
 * pre-check stays fail-open because the model reviewer and the landing path's own check still
 * stand behind it (BUGS.md: a landing build check that times out must not merge unverified). */
const MERGE_SCOPES: ReadonlySet<BuildCheckScope> = new Set(["landing", "batch"]);

/** The one-line warning for an environmental check skip, keyed on why the check could not run.
 * `label` names the check in the feed and `proceeding` says what happens despite the skip; the
 * scoped check (SCOPE_WORDS above) and the red-main baseline gate (main-red.ts) differ only in
 * those two words, so the three-way mapping lives here once instead of drifting per surface. */
export function buildCheckSkipWarning(
  skipReason: BuildSkipReason,
  label: string,
  proceeding: string,
  timeoutMs: number,
): string {
  if (skipReason === "no-npm") return `no npm on PATH; skipping ${label}`;
  if (skipReason === "toolchain") return `the toolchain is broken; skipping ${label}; ${proceeding}`;
  return `${label} timed out after ${timeoutMs / 1000}s; ${proceeding}`;
}

/** Run the project's declared check for a named scope — the detect → run → build_check
 * event → skip-warning sequence the review gate's pre-check (scope "gate"), the landing
 * path's in-lock re-check (scope "landing"), and the batch lander's one check over the whole
 * stacked tree (scope "batch") previously each ran inline, kept in one place so
 * the event's shape and the skip warning cannot drift between the two surfaces. Every run is
 * an event with its cost: the deterministic checks are where the fleet's compute goes after
 * the authoring run, and "how long does npm test take per merge" must be answerable from the
 * feed, not by timing it by hand. Returns null when no check is declared (nothing to run —
 * the caller passes, exactly as before this split), otherwise the declared check plus its
 * classified outcome. A "skipped" outcome also logs its standard warning here (wording keyed
 * on the scope, the timeout as actually set); "failed" and "passed" are the caller's to decide
 * (deterministic reject vs. verifiedHead / baseline seeding). A timeout at a merge scope is
 * remapped to a deterministic "failed" — the tree is unverified, so it must not land. Never
 * throws. */
export async function runScopedBuildCheck(
  root: string,
  role: string,
  scope: BuildCheckScope,
  wt: string,
  config?: { check?: { command: string; cwd?: string; timeoutSeconds?: number } },
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
): Promise<{ check: BuildCheck; outcome: BuildCheckOutcome } | null> {
  const check = detectBuildCheck(wt, config);
  if (!check) return null;
  // A configured command carries its own timeout (check.timeoutSeconds); an npm check runs
  // under the caller's. Effective here so the reason text and the skip warning agree with
  // what runBuildCheck enforced.
  const effectiveMs = checkTimeoutMs(check, timeoutMs);
  const startedAt = Date.now();
  const raw = await runBuildCheck(wt, check, timeoutMs);
  // A timeout at a merge scope is not environmental: no verdict about the tree was reached,
  // and this is the check whose whole job is to catch a semantic conflict before it lands, so
  // it rejects deterministically — the author keeps its commit and retries. no-npm and a
  // broken toolchain still say nothing about the tree, and the gate scope still proceeds to
  // the model reviewer, which the landing path's own check backs up.
  const mergeTimeout =
    raw.status === "skipped" && raw.skipReason === "timeout" && MERGE_SCOPES.has(scope);
  const timeoutReason = `${SCOPE_WORDS[scope].label} timed out after ${effectiveMs / 1000}s; the tree is unverified`;
  const outcome: BuildCheckOutcome = mergeTimeout
    ? { status: "failed", script: checkScriptName(check), outputTail: [timeoutReason] }
    : raw;
  logEvent(root, {
    loop: role,
    type: "build_check",
    scope,
    status: outcome.status,
    script: checkScriptName(check),
    durationMs: Date.now() - startedAt,
  });
  if (outcome.status === "skipped") {
    // Environmental — deliberately NOT fail-closed, so a hung build script cannot wedge every
    // code tick into the 3-strike discard (gate) or a merge behind the merge lock.
    const w = SCOPE_WORDS[scope];
    warnEvent(root, role, buildCheckSkipWarning(outcome.skipReason!, w.label, w.proceeding, effectiveMs));
  } else if (mergeTimeout) {
    warnEvent(root, role, `${timeoutReason}; rejecting the merge`);
  }
  return { check, outcome };
}
