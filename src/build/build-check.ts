import { BUILD_CHECK_TIMEOUT_MS, type BuildCheck } from "./build-check-detect.js";
import { EXEC_MAX_BUFFER, execFileAsync } from "../process/process.js";
import { KILL_GRACE_MS, runScriptGroup } from "../process/process-group.js";
import { clipBuildTail } from "./build-check-report.js";
import { parseTestCounts, type TestCounts } from "./build-check-counts.js";
import { sampleSleepClock, sleptMsBetween, type SleepSampler } from "../scheduling/host-sleep.js";
import { type InstallRunner, npmInstall, syncInstall } from "./dep-install.js";

/** The deterministic build pre-check the review gate runs before any model reviewer: detect
 * the project's declared check (an npm script — `test` preferred per npm convention, then
 * `typecheck`, then `build`) by walking up to the installed root, run it in the worktree with a
 * hard timeout, and classify the outcome. Split out of review.ts — which
 * keeps the adversarial review gate itself — because this is a self-contained concern with its
 * own data model (BuildCheck/BuildCheckOutcome), detection algorithm (walk-up to the install — now build-check-detect.ts, its own pure
 * filesystem concern),
 * and execution/classification logic: deterministic process verification, distinct from the
 * model-based review. Its scoped orchestration — the permit, the build_check event, the
 * verdict-less retry, the merge-scope unverified remapping, and the skip warning — is a
 * separate concern and lives in build-check-scoped.ts. Reading the runner's summary counts — parseTestCounts/TestCounts — is
 * pure parsing with its own importers and lives in build-check-counts.ts. runScopedBuildCheck
 * (build-check-scoped.ts) is the shared detect → run → build_check
 * event → skip-warning sequence of the gate's pre-check (review.ts, via review-precheck.ts) and the landing path's
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
 * 2026-09-23), npm is not on PATH, the toolchain below the project is broken, or the tree's
 * lockfile pins dependencies the walk-up does not provide and installing them failed (install —
 * BUGS.md 2026-10-01; usually an unreachable registry). Shared with
 * main-baseline.ts's MainBaselineCheck, whose skip is the same environmental case family — the
 * string literals live in one place so a new reason can be added without two unions drifting
 * apart. */
export type BuildSkipReason = "timeout" | "killed" | "no-npm" | "toolchain" | "install";

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
  /** The runner's own summary counts (`ℹ tests/pass/fail/skipped N`), parsed from the combined
   * output on passed and failed outcomes — absent when the check printed no such block. The
   * harness attests these so no model has to restate them (PLANS.md 2026-09-29). */
  counts?: TestCounts;
  /** Set when the check first installed the tree's lockfile because its direct dependencies
   * were not what the walk-up resolved (dep-install.ts, BUGS.md 2026-10-01): the drifted names
   * and the install's own wall-clock. On an "install" skip, `detail` says how it failed. */
  install?: { packages: string[]; durationMs: number; detail?: string };
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
  /** Measured time the host spent suspended while the check ran (host-sleep.ts), or undefined
   * when the platform exposes no readable sleep clock. macOS measures the newest sleep's span
   * (kern.sleeptime → kern.waketime), so several sleeps inside one run are undercounted, never
   * overcounted; Linux differences the boottime clock against the monotonic one. BUGS.md
   * 2026-09-30: deadlineLateMs is set only when the harness's OWN deadline timer fired late, so
   * a sleep shorter than the check's remaining deadline but longer than a test's own wait
   * expired that wait at the next wake, the suite exited 1 inside the deadline, and the run
   * carried no mark of the sleep — every caller read a deterministic rejection of the change.
   * A sleep the run survived is not a verdict about the tree either way: this is the evidence
   * runScopedBuildCheck needs to retry such a failure from a clean attempt instead of
   * attributing it. */
  sleptMs?: number;
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
/** checkTimeoutMs and checkScriptName are shared with build-check-scoped.ts's
 * runScopedBuildCheck, whose reason text and event must agree with what runBuildCheck
 * enforced and ran. */
export function checkTimeoutMs(check: BuildCheck, fallbackMs: number): number {
  return check.kind === "command" ? check.timeoutMs : fallbackMs;
}

/** The name an outcome records for what ran: an npm check's script name, a configured
 * command's command verbatim. Kept as one field so the build_check event and every reason
 * headline keep their shape across both kinds. */
export function checkScriptName(check: BuildCheck): string {
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
  sampleSleep: SleepSampler = sampleSleepClock,
  install: InstallRunner = npmInstall,
): Promise<BuildCheckOutcome> {
  const script = checkScriptName(check);
  const effectiveMs = checkTimeoutMs(check, timeoutMs);
  // Environmental probe first: a toolchain broken below the project (git exiting 69 on an
  // invalidated Xcode license) would fail the check with noise unrelated to the tree and the
  // failure would be misread as a red build — run nothing, read it as a skip (BUGS.md 2026-09-15).
  if ((await probeToolchain()) === "broken") {
    return { status: "skipped", script, skipReason: "toolchain" };
  }
  // A tree whose lockfile pins direct dependencies the walk-up does not resolve (a change that
  // adds or bumps one — node_modules is gitignored, so the worktree resolves through a root
  // install that predates it) is installed first, into the tree itself: without it the check
  // fails TS2307 on a correct change and rejects it before any reviewer sees it (BUGS.md
  // 2026-10-01). An npm check only — a configured command owns its own environment. A failed
  // install made no verdict about the tree; runScopedBuildCheck treats it as unverified at the
  // merge scopes, so an uninstallable tree never lands. Never answer a missing dependency by
  // skipping instead (classifying a `Cannot find module` failure as environmental): that was
  // tried and reverted twice on 2026-10-01 by the user's decision — see BUGS.md's "Do not
  // reintroduce a missing-install skip" note for why it switches the gate off fleet-wide.
  let installed: BuildCheckOutcome["install"];
  if (check.kind === "npm") {
    const r = await syncInstall(wt, install);
    if (r && !r.ok)
      return {
        status: "skipped",
        script,
        skipReason: "install",
        install: { packages: r.packages, durationMs: r.durationMs, detail: r.detail },
      };
    if (r) installed = { packages: r.packages, durationMs: r.durationMs };
  }
  const outcome = await runDeclaredCheck(wt, check, script, effectiveMs, killGraceMs, sampleSleep);
  return installed ? { ...outcome, install: installed } : outcome;
}

/** runBuildCheck's run-and-classify step, once the probe and any owed install are done: spawn
 * the declared check as a process group under its deadline, bracketed by sleep samples, and
 * classify what it did. */
async function runDeclaredCheck(
  wt: string,
  check: BuildCheck,
  script: string,
  effectiveMs: number,
  killGraceMs: number,
  sampleSleep: SleepSampler,
): Promise<BuildCheckOutcome> {
  // Sleep evidence brackets the spawn: the opening sample is taken while the host is provably
  // awake (this code is running), so any sleep the closing sample can attribute began inside
  // the run's window. A platform with no readable clock leaves run.sleptMs unset — no evidence
  // recorded, not a wrong one.
  const sleepOpened = await sampleSleep();
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
  const sleptMs = sleptMsBetween(sleepOpened, await sampleSleep());
  if (sleptMs !== undefined) run.sleptMs = sleptMs;
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
  // Passed and failed outcomes both carry the runner's own summary counts when its output
  // printed a summary block: the harness attests the numbers so no model has to (PLANS.md
  // 2026-09-29). Skipped outcomes say nothing about the tree, so their output is not read.
  if (r.code === 0)
    return { status: "passed", script, run, counts: parseTestCounts(`${r.stdout}${r.stderr}`) };
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
      counts: parseTestCounts(output),
    };
  }
  // Spawn failed before anything ran — the runner is missing from PATH.
  return { status: "skipped", script, skipReason: "no-npm" };
}
