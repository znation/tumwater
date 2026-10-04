import {
  BUILD_CHECK_TIMEOUT_MS,
  type BuildCheck,
  detectBuildCheck,
  gateCommandOf,
} from "./build-check-detect.js";
import {
  runBuildCheck,
  checkScriptName,
  checkTimeoutMs,
  type BuildCheckOutcome,
} from "./build-check.js";
import { logEvent, warnEvent } from "./events.js";
import {
  MERGE_SCOPES,
  SCOPE_WORDS,
  buildCheckEvent,
  buildCheckSkipWarning,
  DEADLINE_LATE_TOLERANCE_MS,
  installFailedPhrase,
  killedPhrase,
  timedOutPhrase,
  SLEEP_SPAN_TOLERANCE_MS,
  sleptPhrase,
  type BuildCheckScope,
} from "./build-check-events.js";
import { CHECK_TIER, type PermitWaitHooks, withCheckPermit } from "./check-permit.js";
import type { CheckConfigSlice } from "./config-schema.js";
import { sampleSleepClock, type SleepSampler } from "./host-sleep.js";
import { type InstallRunner, npmInstall } from "./dep-install.js";

/** Run the project's declared check for a named scope — the detect → run → build_check
 * event → skip-warning sequence the review gate's pre-check (scope "gate"), the landing
 * path's in-lock re-check (scope "landing"), and the batch lander's one check over the whole
 * stacked tree (scope "batch") previously each ran inline, kept in one place so
 * the event's shape and the skip warning cannot drift between the two surfaces. Split out of
 * build-check.ts — which keeps the check's execution and outcome classification
 * (runBuildCheck, BuildCheckOutcome) — because orchestration is its own concern: the permit,
 * the event emission, the verdict-less retry, the merge-scope unverified remapping, and the
 * skip warning. Every run is an event with its cost: the deterministic checks are where the
 * fleet's compute goes after the authoring run, and "how long does npm test take per merge"
 * must be answerable from the feed, not by timing it by hand. Returns null when no check is
 * declared (nothing to run — the caller passes, exactly as before this split), otherwise the
 * declared check plus its classified outcome. A "skipped" outcome also logs its standard
 * warning here (wording keyed on the scope, the timeout as actually set — and, when its
 * deadline fired late, as actually enforced); "failed" and "passed" are the caller's to
 * decide (deterministic reject vs. verifiedHead / baseline seeding). A timeout or signal kill
 * at a merge scope is remapped to a deterministic "failed" — the tree is unverified, so it
 * must not land. A check killed by a signal the harness did not send is retried once at any
 * scope — the first run's death says nothing about the tree (it is another run's `pkill`), so
 * one verdict from a clean attempt is owed before the skip is honoured; each attempt is priced
 * as its own build_check event, carrying when the check itself ran (buildCheckRunFields).
 * A configured `check.gateCommand` replaces the command at scope "gate" only (same cwd and
 * timeout); the landing and batch scopes — and the red-main baseline, which detects on its
 * own — keep running check.command. `permitWait` hears about a wait for the check permit (the
 * landing cell's "waiting for a check slot"). Never throws. */
export async function runScopedBuildCheck(
  root: string,
  role: string,
  scope: BuildCheckScope,
  wt: string,
  config?: CheckConfigSlice,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
  sampleSleep: SleepSampler = sampleSleepClock,
  install: InstallRunner = npmInstall,
  permitWait?: PermitWaitHooks,
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
      const first = await runBuildCheck(wt, check, timeoutMs, undefined, sampleSleep, install);
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
      // A FAILED run the host slept through is the same weather seen from the other side: the
      // sleep expired a test's own wall-clock wait at the wake, the suite exited 1 inside the
      // deadline, and until the measured sleptMs existed nothing marked the run — the failure
      // read as a deterministic rejection of the change (BUGS.md 2026-09-30). It owes the same
      // clean retry as the verdict-less attempts above, at every scope: a retry that passes
      // verifies the tree exactly like a first-time pass, and one that fails again is
      // classified below.
      const sleepFailed =
        first.status === "failed" && (first.run?.sleptMs ?? 0) > SLEEP_SPAN_TOLERANCE_MS;
      if (
        (first.status !== "skipped" || (first.skipReason !== "killed" && !lateDeadlineTimeout)) &&
        !sleepFailed
      )
        return first;
      logEvent(root, buildCheckEvent(role, scope, first, durationMs));
      const retryStart = Date.now();
      const retry = await runBuildCheck(wt, check, timeoutMs, undefined, sampleSleep, install);
      durationMs = Date.now() - retryStart;
      return retry;
    },
    permitWait,
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
  // A retry that ALSO slept made no clean verdict either: it is recorded as unverified — not
  // attributed to the change, not cached as a red baseline — rather than read as a second
  // deterministic failure (BUGS.md 2026-09-30). A retry that passed stands: the tree went
  // green under the project's own check, even if the host napped through parts of it.
  const sleepFailed = raw.status === "failed" && (raw.run?.sleptMs ?? 0) > SLEEP_SPAN_TOLERANCE_MS;
  // A failed dependency install is the same at a merge scope: nothing ran against the tree as
  // its lockfile pins it, so it must not land (BUGS.md 2026-10-01).
  const unverifiedSkip =
    MERGE_SCOPES.has(scope) &&
    (((raw.status === "skipped" &&
      (raw.skipReason === "timeout" || raw.skipReason === "killed" || raw.skipReason === "install")) ||
      sleepFailed));
  const unverifiedReason =
    raw.skipReason === "install"
      ? installFailedPhrase(SCOPE_WORDS[scope].label, raw.install, "the tree is unverified")
      : raw.skipReason === "killed"
      ? killedPhrase(
          SCOPE_WORDS[scope].label,
          raw.killedBy ? { signal: raw.killedBy, durationMs } : undefined,
          "the tree is unverified",
        )
      : sleepFailed
        ? sleptPhrase(SCOPE_WORDS[scope].label, raw.run!.sleptMs!, "the tree is unverified")
        : `${SCOPE_WORDS[scope].label} ${timedOutPhrase(effectiveMs, raw.run)}; the tree is unverified`;
  const outcome: BuildCheckOutcome = unverifiedSkip
    ? {
        status: "failed",
        script: checkScriptName(check),
        outputTail: [unverifiedReason],
        run: raw.run,
        unverified: true,
        ...(raw.install ? { install: raw.install } : {}),
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
        outcome.install,
      ),
    );
  } else if (unverifiedSkip) {
    warnEvent(root, role, `${unverifiedReason}; rejecting the merge`);
  }
  return { check, outcome };
}