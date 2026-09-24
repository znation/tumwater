import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BUILD_CHECK_TIMEOUT_MS, type BuildCheck, detectBuildCheck, gateCommandOf } from "./build-check-detect.js";
import { defaultConfig } from "./config.js";
import { logEvent, warnEvent } from "./events.js";
import { Semaphore } from "./semaphore.js";
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
 * runner, a wedged worker) is SIGKILLed — and the check settles then, whether or not the tree
 * ever closed its pipes, so a timed-out check is bounded at its deadline plus this grace. The
 * default of runBuildCheck's killGraceMs parameter, which tests shrink — pinning that the
 * escalation is armed on timeout (never at spawn: a healthy check that merely outlasts the
 * grace period must run to completion), that a surviving grandchild is taken down before the
 * check settles, and that a tree the SIGTERM already took down does not wait out the grace. */
const KILL_GRACE_MS = 10_000;

/** How late a check's deadline timer may fire before the timeout's wording stops naming the
 * configured bound alone. Normal timer lag is milliseconds; past this the warning and the
 * merge-scope reason name the wall-clock time the deadline actually fired and how late (see
 * BuildCheckRun.deadlineLateMs), because "timed out after 300s" for a check that ran 712 s is
 * the false claim BUGS.md 2026-09-21 recorded. The exact lateness is on the build_check event
 * either way; this only keeps sub-second jitter out of the one-line warning. */
const DEADLINE_LATE_TOLERANCE_MS = 5_000;

/** Why a declared check reached no verdict: the script never finished (timeout), the script
 * died on a signal the harness did not send (killed — e.g. another run's `pkill`, BUGS.md
 * 2026-09-23), npm is not on PATH, or the toolchain below the project is broken. Shared with
 * main-baseline.ts's MainBaselineCheck, whose skip is the same environmental case family — the
 * string literals live in one place so a new reason can be added without two unions drifting
 * apart. */
export type BuildSkipReason = "timeout" | "killed" | "no-npm" | "toolchain";

/** What the deterministic build check concluded. "passed": proceed to the reviewer unchanged.
 * "failed": a started process exited nonzero — a deterministic REJECTION with the clipped
 * output tail as machine-generated reasons (no pi run consumed). "skipped": environmental
 * (timeout, an external signal kill, no npm on PATH, or a broken toolchain) — warn and still
 * proceed to the model review; deliberately NOT fail-closed so a hung build script cannot wedge every code tick into
 * the 3-strike discard, and a toolchain broken below the project (BUGS.md 2026-09-15) cannot be
 * misread as a red build of the tree. runScopedBuildCheck remaps a timeout or a signal kill at
 * a merge scope (landing/batch) to "failed": a suite that never finished is unverified, not
 * environmental. */
export interface BuildCheckOutcome {
  status: "passed" | "failed" | "skipped";
  /** The script that was run (or attempted). */
  script: string;
  /** Clipped tail of the combined output on failure — last ≤10 meaningful lines (non-blank,
   * npm banner excluded), each clipped to MAX_REASON_CHARS. */
  outputTail?: string[];
  /** Why no verdict was reached ("skipped"). */
  skipReason?: BuildSkipReason;
  /** On a "killed" skip: the signal that stopped the check — the harness's own timeout is
   * classified as "timeout", so this is always a signal it did not send. */
  killedBy?: NodeJS.Signals;
  /** When the check's process group ran — absent when nothing was spawned (a broken toolchain,
   * no npm). */
  run?: BuildCheckRun;
}

/** When one check's process group actually ran, as runScriptGroup observed it: carried on
 * every outcome that spawned anything, so the build_check event and the skip warning report
 * the bound that was actually enforced, not only the one that was configured. BUGS.md
 * 2026-09-21: every skipped check recorded 331–1158 s against a "300 s" timeout. Measured
 * cause: the fleet's host (a laptop in clamshell maintenance sleep) slept through the
 * deadline. libuv's clock on macOS counts time asleep (process.hrtime() since boot equals wall
 * uptime on a host logging hundreds of sleeps a day), so a deadline that passes while it sleeps
 * fires at the first wake after it, when the check has often run only seconds. Nothing can
 * enforce a wall-clock bound on a sleeping host; what the harness can do is say so. */
export interface BuildCheckRun {
  /** Epoch ms at spawn and at settle. settledAt − spawnedAt is the check itself; the rest of a
   * caller's durationMs is the toolchain probe and the harness's own overhead. */
  spawnedAt: number;
  settledAt: number;
  /** The deadline the run was armed with. */
  timeoutMs: number;
  /** Set only when the deadline fired: how far past timeoutMs, by the wall clock, its timer
   * actually ran. Near zero normally; large when the harness could not run the timer on time,
   * because the host was asleep or the event loop was stalled. */
  deadlineLateMs?: number;
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
 * signal), whether the check's timeout fired, what the script printed, whether it never
 * spawned at all, and when it ran. */
interface ScriptGroupResult {
  code?: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
  run: BuildCheckRun;
}

/** True while any process in the group led by `pid` still exists: a signal-0 probe of the
 * group, where EPERM still means a member exists. Local to the build check, whose timed-out
 * run settles on the whole group being gone, never on the leader's close alone. */
function groupAlive(pid: number | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How often a timed-out run re-probes its process group between the deadline's SIGTERM and
 * the grace's SIGKILL. Nothing else wakes the check when the last member goes: a grandchild
 * that finishes a SIGTERM handler after the leader closed, or one launchd has not yet reaped,
 * has no event of its own. */
const GROUP_POLL_MS = 50;

/** Run `cmd args` detached — its own process group, exactly like pi — and settle exactly once.
 * The timeout is enforced GROUP-WIDE, never against the direct child alone: execFileAsync's
 * `timeout` option signalled npm and nothing else, so everything below it (`node --test` → one
 * worker per file) survived and reparented to PID 1 for as long as twelve days (BUGS.md
 * 2026-09-21). Before the deadline the run settles on the process's close. When the deadline
 * fires the whole group gets SIGTERM, and the run settles as soon as nothing in the group is
 * left (probed on the leader's close and every GROUP_POLL_MS) — or at killGraceMs after the
 * deadline, after SIGKILLing whatever survived (a SIGTERM-trapping runner, a wedged worker, a
 * grandchild still holding the pipes, so the close never comes), whichever is first. A
 * timed-out check is therefore bounded at timeoutMs + killGraceMs of the harness's own clock
 * whatever its tree does, and its tree is gone when the caller sees the outcome: no teardown
 * overlaps the caller's retry or the next check. At settle the pipes are destroyed and the
 * child unref'd, so a descendant that escaped the group cannot keep the harness's handles open.
 * The escalation is armed when the deadline fires, never at spawn: a healthy check that merely
 * outlasts the grace period must run to completion (the 2026-09-22 review-gate catch — a timer
 * armed at spawn SIGKILLed every healthy check longer than KILL_GRACE_MS and misclassified it
 * as a timeout, freezing all merge-scope checks). The run's spawn and settle times, and how
 * late the deadline timer actually fired, come back as `run`: the harness's own clock is not
 * the wall clock whenever the host sleeps or the event loop stalls (see BuildCheckRun), and the
 * discrepancy must be visible rather than hidden behind the configured bound. Captured output
 * is capped at maxBuffer per stream (further chunks are dropped — classification reads the
 * tail), so a chatty script can neither wedge the check nor balloon memory. Never throws; a
 * spawn failure (npm missing from PATH) is reported as spawnError. */
function runScriptGroup(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; killGraceMs: number; maxBuffer: number },
): Promise<ScriptGroupResult> {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    // Set when the deadline fires — its presence IS "timed out".
    let deadlineLateMs: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let groupPoll: NodeJS.Timeout | undefined;
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
    const finish = (result: Pick<ScriptGroupResult, "code" | "signal" | "spawnError">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearInterval(groupPoll);
      const timedOut = deadlineLateMs !== undefined;
      if (timedOut) {
        // Nothing more is read once the deadline has fired: a pipe holder that escaped the
        // group (a setsid'd daemon) must not keep the harness's handles, or the harness
        // itself, alive.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      const run: BuildCheckRun = { spawnedAt, settledAt: Date.now(), timeoutMs: opts.timeoutMs };
      if (timedOut) run.deadlineLateMs = deadlineLateMs;
      resolve({ ...result, timedOut, stdout, stderr, run });
    };
    const deadlineTimer = setTimeout(() => {
      // Wall-clock lateness, the same clock the callers' durationMs is measured on: a deadline
      // the host slept through, or an event loop too busy to run it, fires late by exactly this.
      deadlineLateMs = Math.max(0, Date.now() - spawnedAt - opts.timeoutMs);
      signalTree(child, "SIGTERM");
      // The SIGTERM took the whole tree down: settle as soon as the group is gone instead of
      // waiting out the grace.
      groupPoll = setInterval(() => {
        if (!groupAlive(child.pid)) finish({ signal: "SIGTERM" });
      }, GROUP_POLL_MS);
      killTimer = setTimeout(() => {
        signalTree(child, "SIGKILL");
        finish({ signal: "SIGTERM" });
      }, opts.killGraceMs);
    }, opts.timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Before the deadline this is the spawn failing (npm missing from PATH). After it, it can
      // only be a teardown signal that could not be delivered: the run is a timeout either way,
      // settled by the group probe or the grace timer.
      if (deadlineLateMs === undefined) finish({ spawnError: err });
    });
    child.on("close", (code, signal) => {
      if (deadlineLateMs === undefined) {
        finish({ code: code ?? undefined, signal: signal ?? undefined });
      } else if (!groupAlive(child.pid)) {
        finish({ signal: "SIGTERM" });
      }
      // Otherwise something in the group outlived the leader: the poll settles the run when it
      // goes, or the grace timer SIGKILLs it and settles the run then.
    });
  });
}

/** The human/prompt-facing name of a check (plans/portability.md §6/7): the tick prompt and
 * the gate's check reasons name the actual verification command instead of asserting npm —
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
  const run = r.run;
  // The harness's own timeout: environmental — warn and proceed. A timed-out check's whole
  // process tree is already gone: runScriptGroup settles only once the group is (SIGTERM at
  // the deadline, SIGKILL at the grace for anything that survived). `run` says when the
  // deadline actually fired, which the warning reports when it was late.
  if (r.timedOut) return { status: "skipped", script, skipReason: "timeout", run };
  // The tree died on a signal the harness did NOT send (runScriptGroup resolves its own
  // timeout with timedOut already set, so a signal reaching this line is external — another
  // run's `pkill`, an operator's cleanup): the outcome says nothing about the tree, but it is
  // not a timeout, and its skip reason and warning must say so instead of claiming the 300 s
  // bound fired (BUGS.md 2026-09-23). npm re-raises a script child's signal death, so the
  // group leader is what closes with the signal.
  if (r.signal) return { status: "skipped", script, skipReason: "killed", killedBy: r.signal, run };
  if (r.code === 0) return { status: "passed", script, run };
  // A started process that exited nonzero is a deterministic failure of the build itself —
  // unless its output names a broken toolchain: then the environment, not the tree, killed it,
  // and the same skip semantics apply (never a deterministic rejection, never a red baseline).
  if (typeof r.code === "number") {
    const output = `${r.stdout}${r.stderr}`;
    if (toolchainErrorInOutput(output)) {
      return { status: "skipped", script, skipReason: "toolchain", run };
    }
    return {
      status: "failed",
      script,
      outputTail: clipBuildTail(output),
      run,
    };
  }
  // Spawn failed before anything ran — the runner is missing from PATH.
  return { status: "skipped", script, skipReason: "no-npm" };
}

// ── Process-wide check cap ────────────────────────────────────────────────────────────────

/** One process-wide bound on concurrent runs of the declared check (config.maxConcurrentChecks,
 * PLANS.md "Land-queue speed 2b"): every full suite the harness runs — runScopedBuildCheck's
 * gate/landing/batch scopes and main-baseline.ts's checkMainBaseline, which runs the suite
 * directly — takes a permit here first, so a burst of landings cannot stack suites on the host
 * beside the authors' own test runs (the suite has load-sensitive tests). Separate from the
 * orchestrator's maxConcurrent semaphore: a role tick holds one of those while it waits here,
 * but a check permit is held only around the check process itself — never across a pi run, the
 * merge lock, or another check — so no permit holder waits on anything a waiter holds. Sized at
 * each acquire from the caller's live config (checkCap), so a tumwater.json edit applies to the
 * next check; Semaphore.setCapacity never preempts a running check on a shrink. */
const checkPermits = new Semaphore(defaultConfig().maxConcurrentChecks);

/** Set while the current async context holds a check permit: a nested withCheckPermit runs
 * inside the permit it already has instead of queueing for a second one — at a cap of 1 that
 * second wait could never be granted (its own holder is the one blocking it). No call path
 * nests today; this keeps a future one from deadlocking the fleet's checks. */
const holdingPermit = new AsyncLocalStorage<true>();

/** Waiting-queue tiers (Semaphore.acquire): a merge-scope check runs inside the merge lock, so
 * it is granted the next free permit ahead of queued gate and baseline checks — every check it
 * waited behind would be lock-hold time for every other landing. A running check is never
 * preempted. */
export const CHECK_TIER = { merge: 0, other: 1 } as const;

/** The live cap: config.maxConcurrentChecks when it is a positive integer (validateConfig
 * enforces that for tumwater.json), the default otherwise — a caller passing a partial config
 * (the tests' `{ check }`) or none gets the default, never a cap the semaphore could not grant
 * under. */
function checkCap(config: { maxConcurrentChecks?: number } | undefined): number {
  const n = config?.maxConcurrentChecks;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : defaultConfig().maxConcurrentChecks;
}

/** Run `run` under one process-wide check permit (see checkPermits), resizing the cap from the
 * live config first and releasing in a finally — a check that fails, times out, or throws still
 * gives its permit back. Reentrant (holdingPermit): called again from inside `run`, it runs the
 * inner work under the permit already held. */
export async function withCheckPermit<T>(
  config: { maxConcurrentChecks?: number } | undefined,
  tier: number,
  run: () => Promise<T>,
): Promise<T> {
  if (holdingPermit.getStore()) return run();
  checkPermits.setCapacity(checkCap(config));
  await checkPermits.acquire(tier);
  try {
    return await holdingPermit.run(true, run);
  } finally {
    checkPermits.release();
  }
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

/** Scopes whose outcome gates a merge to main: runScopedBuildCheck remaps a timeout or an
 * external signal kill at these scopes to a deterministic "failed" — the tree is unverified,
 * and these are the last checks before main. The gate scope's pre-check stays fail-open
 * because the model reviewer and the landing path's own check still stand behind it
 * (BUGS.md: a landing build check that times out must not merge unverified). */
const MERGE_SCOPES: ReadonlySet<BuildCheckScope> = new Set(["landing", "batch"]);

/** How a timed-out check is described: "timed out after <bound>s" when the deadline fired on
 * time, and otherwise the wall-clock time it actually fired at, with the configured bound and
 * the lateness beside it — so no warning or reject reason claims a bound the run did not keep
 * (BUGS.md 2026-09-21: "timed out after 300s" for checks that ran 331–1158 s, each one a host
 * that slept through the deadline). The bound is the run's own when it has one — what
 * runScriptGroup actually armed — and the caller's otherwise. Shared by buildCheckSkipWarning
 * and runScopedBuildCheck's merge-scope reason. */
function timedOutPhrase(timeoutMs: number, run?: BuildCheckRun): string {
  const bound = run?.timeoutMs ?? timeoutMs;
  const late = run?.deadlineLateMs ?? 0;
  if (late <= DEADLINE_LATE_TOLERANCE_MS) return `timed out after ${bound / 1000}s`;
  const secs = (ms: number) => Math.round(ms / 100) / 10;
  return (
    `timed out after ${secs(bound + late)}s (its ${bound / 1000}s deadline fired ${secs(late)}s ` +
    "late: the host was asleep or the harness stalled)"
  );
}

/** The one-line warning for an environmental check skip, keyed on why the check could not run.
 * `label` names the check in the feed and `proceeding` says what happens despite the skip; the
 * scoped check (SCOPE_WORDS above) and the red-main baseline gate (main-red.ts) differ only in
 * those two words, so the mapping lives here once instead of drifting per surface. A "killed"
 * skip carries the caller's `killed` info when it has it — the signal and the check's real
 * wall-clock, not the timeout bound — and a signal-less form otherwise, so the warning never
 * again names a timeout that did not fire. A "timeout" skip names the bound the run was armed
 * with, and when the caller passes the run and its deadline fired late, the time it really
 * fired at (timedOutPhrase). */
export function buildCheckSkipWarning(
  skipReason: BuildSkipReason,
  label: string,
  proceeding: string,
  timeoutMs: number,
  killed?: { signal: string; durationMs: number },
  run?: BuildCheckRun,
): string {
  if (skipReason === "no-npm") return `no npm on PATH; skipping ${label}`;
  if (skipReason === "toolchain") return `the toolchain is broken; skipping ${label}; ${proceeding}`;
  if (skipReason === "killed") {
    return killed
      ? `${label} was killed by ${killed.signal} after ${killed.durationMs / 1000}s; ${proceeding}`
      : `${label} was killed by an external signal; ${proceeding}`;
  }
  return `${label} ${timedOutPhrase(timeoutMs, run)}; ${proceeding}`;
}

/** The build_check event's record of when the check itself ran (BuildCheckRun): spawn and
 * settle times on every run, plus the armed bound and the deadline's lateness when it fired.
 * Spread into every build_check event — runScopedBuildCheck's here, and the baseline loggers in
 * main-red.ts and redeploy.ts — so the feed can separate the check's own wall-clock from the
 * probe around it, and a deadline that fired late from one that fired on time. Empty when
 * nothing was spawned. */
export function buildCheckRunFields(outcome: BuildCheckOutcome): Record<string, number> {
  const run = outcome.run;
  if (!run) return {};
  return {
    spawnedAt: run.spawnedAt,
    settledAt: run.settledAt,
    ...(run.deadlineLateMs === undefined
      ? {}
      : { timeoutMs: run.timeoutMs, deadlineLateMs: run.deadlineLateMs }),
  };
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
 * on the scope, the timeout as actually set — and, when its deadline fired late, as actually
 * enforced); "failed" and "passed" are the caller's to decide (deterministic reject vs.
 * verifiedHead / baseline seeding). A timeout or signal kill at a
 * merge scope is remapped to a deterministic "failed" — the tree is unverified, so it must
 * not land. A check killed by a signal the harness did not send is retried once at any scope
 * — the first run's death says nothing about the tree (it is another run's `pkill`), so one
 * verdict from a clean attempt is owed before the skip is honoured; each attempt is priced
 * as its own build_check event, carrying when the check itself ran (buildCheckRunFields).
 * A configured `check.gateCommand` replaces the command at scope "gate" only (same cwd and
 * timeout); the landing and batch scopes — and the red-main baseline, which detects on its
 * own — keep running check.command. Never throws. */
export async function runScopedBuildCheck(
  root: string,
  role: string,
  scope: BuildCheckScope,
  wt: string,
  config?: {
    check?: { command: string; gateCommand?: string; cwd?: string; timeoutSeconds?: number };
    maxConcurrentChecks?: number;
  },
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
): Promise<{ check: BuildCheck; outcome: BuildCheckOutcome } | null> {
  const gateCommand = scope === "gate" ? gateCommandOf(config) : undefined;
  const check = detectBuildCheck(
    wt,
    gateCommand === undefined ? config : { check: { ...config?.check, command: gateCommand } },
  );
  if (!check) return null;
  // A configured command carries its own timeout (check.timeoutSeconds); an npm check runs
  // under the caller's. Effective here so the reason text and the skip warning agree with
  // what runBuildCheck enforced.
  const effectiveMs = checkTimeoutMs(check, timeoutMs);
  // One permit covers both attempts (the killed-check retry re-runs under the permit it
  // holds); durationMs prices the run itself, not the wait for a permit.
  let durationMs = 0;
  const raw = await withCheckPermit(
    config,
    MERGE_SCOPES.has(scope) ? CHECK_TIER.merge : CHECK_TIER.other,
    async () => {
      const startedAt = Date.now();
      const first = await runBuildCheck(wt, check, timeoutMs);
      durationMs = Date.now() - startedAt;
      if (first.status !== "skipped" || first.skipReason !== "killed") return first;
      // A check the harness did not stop itself says nothing about the tree — its death is
      // another run's doing — so retry once; the second attempt's outcome stands. The killed
      // first attempt is priced as its own event (the feed must answer how long a check took),
      // then the final event below records the retry's classified outcome.
      logEvent(root, {
        loop: role,
        type: "build_check",
        scope,
        status: first.status,
        script: checkScriptName(check),
        durationMs,
        ...buildCheckRunFields(first),
      });
      const retryStart = Date.now();
      const retry = await runBuildCheck(wt, check, timeoutMs);
      durationMs = Date.now() - retryStart;
      return retry;
    },
  );
  // A timeout or signal kill at a merge scope is not environmental: no verdict about the tree
  // was reached, and this is the check whose whole job is to catch a semantic conflict before
  // it lands, so it rejects deterministically — the author keeps its commit and retries.
  // no-npm and a broken toolchain still say nothing about the tree, and the gate scope still
  // proceeds to the model reviewer, which the landing path's own check backs up.
  const unverifiedSkip =
    raw.status === "skipped" &&
    (raw.skipReason === "timeout" || raw.skipReason === "killed") &&
    MERGE_SCOPES.has(scope);
  const unverifiedReason =
    raw.skipReason === "killed"
      ? `${SCOPE_WORDS[scope].label} was killed by ${raw.killedBy} after ${durationMs / 1000}s; the tree is unverified`
      : `${SCOPE_WORDS[scope].label} ${timedOutPhrase(effectiveMs, raw.run)}; the tree is unverified`;
  const outcome: BuildCheckOutcome = unverifiedSkip
    ? { status: "failed", script: checkScriptName(check), outputTail: [unverifiedReason], run: raw.run }
    : raw;
  logEvent(root, {
    loop: role,
    type: "build_check",
    scope,
    status: outcome.status,
    script: checkScriptName(check),
    durationMs,
    ...buildCheckRunFields(outcome),
  });
  if (outcome.status === "skipped") {
    // Environmental — deliberately NOT fail-closed, so a hung build script cannot wedge every
    // code tick into the 3-strike discard (gate) or a merge behind the merge lock.
    const w = SCOPE_WORDS[scope];
    warnEvent(
      root,
      role,
      buildCheckSkipWarning(
        outcome.skipReason!,
        w.label,
        w.proceeding,
        effectiveMs,
        outcome.skipReason === "killed" && outcome.killedBy
          ? { signal: outcome.killedBy, durationMs }
          : undefined,
        outcome.run,
      ),
    );
  } else if (unverifiedSkip) {
    warnEvent(root, role, `${unverifiedReason}; rejecting the merge`);
  }
  return { check, outcome };
}
