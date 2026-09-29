import { BUILD_CHECK_TIMEOUT_MS, type BuildCheck, detectBuildCheck, gateCommandOf } from "./build-check-detect.js";
import { logEvent, warnEvent } from "./events.js";
import {
  MERGE_SCOPES,
  SCOPE_WORDS,
  buildCheckEvent,
  buildCheckSkipWarning,
  DEADLINE_LATE_TOLERANCE_MS,
  killedPhrase,
  timedOutPhrase,
  type BuildCheckScope,
} from "./build-check-events.js";
import { CHECK_TIER, withCheckPermit } from "./check-permit.js";
import { EXEC_MAX_BUFFER, execFileAsync } from "./process.js";
import { KILL_GRACE_MS, runScriptGroup } from "./process-group.js";
import { clipBuildTail } from "./build-check-report.js";

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
 * in-lock re-check (landing-merge.ts). The red-main baseline gate (main-red.ts) reuses this same
 * detection and execution from main-baseline.ts to verify main itself once per SHA before an
 * authoring run is spent on top of it. The detached process-group runner runBuildCheck uses
 * (runScriptGroup) is this module's only runtime concern in process-group.ts — its run record
 * (BuildCheckRun, below) stays here beside the outcome it rides on; process-group.ts imports
 * the type back (no runtime cycle), and the signals it escalates with come from signalTree in
 * process.ts. Formatting and description of a check's failure output — clipReason/MAX_REASON_CHARS
 * (which bound one line of machine text, shared with parseVerdict in review-verdict.ts),
 * clipBuildTail, failureHeadline, describeCheck and checkFailureReasons — are presentation, not
 * execution, and live in build-check-report.ts (type-only back-reference here — no runtime cycle);
 * the build_check event's shape and the skip-warning wording live beside it in
 * build-check-events.ts (type-only back-reference here — no runtime cycle). */

// A check whose correctness must not depend on model compliance is run by the harness, not
// asked of the reviewer (plans/review-gate.md): the reviewer may not run state-changing
// commands, and `npm run build` is exactly that — type errors are invisible to a model that
// cannot compile. Detection of WHICH check to run (the walk-up to the installed root and the
// declared script) lives in build-check-detect.ts; this file runs and classifies it.

// ── Execution ─────────────────────────────────────────────────────────────────────────────

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
  /** Set when runScopedBuildCheck remapped a verdict-less merge-scope outcome (a kill, or a
   * timeout whose deadline fired on time) to "failed": the tree is unverified, not red.
   * checkFailureReasons passes such reasons through verbatim — the "build check failed" prefix
   * would send the author hunting a test failure that never happened (BUGS.md 2026-09-28). */
  unverified?: boolean;
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
 * a local script needs no network. No PATH setup is needed even though the worktree
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
          maxBuffer: EXEC_MAX_BUFFER,
        })
      : await runScriptGroup("npm", ["run", check.script], {
          cwd: wt,
          timeoutMs: effectiveMs,
          killGraceMs,
          maxBuffer: EXEC_MAX_BUFFER,
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
      // A check the harness did not stop itself says nothing about the tree — its death is
      // another run's doing. At a merge scope, a timeout whose deadline demonstrably fired
      // late is the same weather: the harness's own evidence (run.deadlineLateMs, the
      // measurement BUGS.md 2026-09-21 added) says the deadline passed while the host slept or
      // the harness stalled, so the check ran seconds and was killed at a wake — it made no
      // verdict about the tree and was not a slow suite. Both owe one retry from a clean
      // attempt; the second attempt's outcome stands. The verdict-less first attempt is priced
      // as its own event (the feed must answer how long a check took), then the final event
      // below records the retry's classified outcome.
      const lateDeadlineTimeout =
        first.status === "skipped" &&
        first.skipReason === "timeout" &&
        MERGE_SCOPES.has(scope) &&
        (first.run?.deadlineLateMs ?? 0) > DEADLINE_LATE_TOLERANCE_MS;
      if (first.status !== "skipped" || (first.skipReason !== "killed" && !lateDeadlineTimeout))
        return first;
      logEvent(root, buildCheckEvent(role, scope, first, durationMs));
      const retryStart = Date.now();
      const retry = await runBuildCheck(wt, check, timeoutMs);
      durationMs = Date.now() - retryStart;
      return retry;
    },
  );
  // A signal kill at a merge scope, or a timeout whose deadline fired on time (real slowness,
  // a genuinely hung or oversized suite), made no verdict about the tree — and this is the
  // check whose whole job is to catch a semantic conflict before it lands, so it rejects
  // deterministically — the author keeps its commit and retries. A timeout whose deadline
  // fired late has already had its retry above: the lateness is the harness's own evidence the
  // host slept, so a second verdict-less attempt is recorded as unverified rather than read
  // again as weather (BUGS.md 2026-09-28). no-npm and a broken toolchain still say nothing
  // about the tree, and the gate scope still proceeds to the model reviewer, which the landing
  // path's own check backs up.
  const unverifiedSkip =
    raw.status === "skipped" &&
    (raw.skipReason === "timeout" || raw.skipReason === "killed") &&
    MERGE_SCOPES.has(scope);
  const unverifiedReason =
    raw.skipReason === "killed"
      ? killedPhrase(
          SCOPE_WORDS[scope].label,
          raw.killedBy ? { signal: raw.killedBy, durationMs } : undefined,
          "the tree is unverified",
        )
      : `${SCOPE_WORDS[scope].label} ${timedOutPhrase(effectiveMs, raw.run)}; the tree is unverified`;
  const outcome: BuildCheckOutcome = unverifiedSkip
    ? {
        status: "failed",
        script: checkScriptName(check),
        outputTail: [unverifiedReason],
        run: raw.run,
        unverified: true,
      }
    : raw;
  logEvent(root, buildCheckEvent(role, scope, outcome, durationMs));
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
