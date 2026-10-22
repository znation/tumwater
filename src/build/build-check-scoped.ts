import {
  BUILD_CHECK_TIMEOUT_MS,
  type BuildCheck,
  detectBuildCheck,
  gateCommandOf,
  mergeCommandOf,
} from "./build-check-detect.js";
import {
  runBuildCheck,
  checkScriptName,
  checkTimeoutMs,
  type BuildCheckOutcome,
} from "./build-check.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import {
  MERGE_SCOPES,
  SCOPE_WORDS,
  buildCheckEvent,
  buildCheckSkipWarning,
  runWithCleanRetry,
  installFailedPhrase,
  killedPhrase,
  loadedHostPhrase,
  timedOutPhrase,
  DEADLINE_LATE_TOLERANCE_MS,
  logCheckWaitEvent,
  SLEEP_SPAN_TOLERANCE_MS,
  sleptPhrase,
  starvedDeadlineMs,
  UNVERIFIED_TREE,
  type BuildCheckScope,
} from "./build-check-events.js";
import { CHECK_TIER, type PermitWaitHooks, withCheckPermit } from "../concurrency/check-permit.js";
import type { CheckConfigSlice } from "../config/config-schema.js";
import { sampleHostLoad, sampleSleepClock, type LoadSampler, type SleepSampler } from "./host-sleep.js";
import { type InstallRunner, npmInstall } from "./dep-install.js";

/** Run the project's declared check for a named scope — the detect → run → build_check event →
 * skip-warning sequence the review gate's pre-check (scope "gate"), the merge path's in-lock
 * re-check (scope "merge"), and the batch merger's one check over the whole stacked tree (scope
 * "batch") previously each ran inline, kept in one place so the event's shape and the skip warning
 * cannot drift between them. Split out of build-check.ts — which keeps the check's execution and
 * outcome classification (runBuildCheck, BuildCheckOutcome) — because orchestration is its own
 * concern: the permit, the event emission, the verdict-less retry, the merge-scope unverified
 * remapping, and the skip warning. Every run is an event with its cost: the deterministic checks
 * are where the team's compute goes after the authoring run, and "how long does npm test take per
 * merge" must be answerable from the feed, not by timing it by hand. Returns null when no check is
 * declared (nothing to run — the caller passes, exactly as before this split), otherwise the
 * declared check plus its classified outcome. A "skipped" outcome also logs its standard warning
 * here (wording keyed on the scope, the timeout as actually set — and, when its deadline fired
 * late, as actually enforced); "failed" and "passed" are the caller's to decide (deterministic
 * reject vs. verifiedHead / baseline seeding). A timeout or signal kill at a merge scope is
 * remapped to a deterministic "failed" — the tree is unverified, so it must not merge. A check
 * killed by a signal the harness did not send is retried once at any scope — the first run's death
 * says nothing about the tree (it is another run's `pkill`), so one verdict from a clean attempt is
 * owed before the skip is honored; a timeout whose deadline demonstrably fired late (the harness's
 * own host-sleep evidence) earns that same one retry at any scope, and a failed run the host slept
 * through does too; each attempt is priced as its own build_check event, carrying when the check
 * itself ran (buildCheckRunFields). A configured `check.gateCommand` replaces the command at scope
 * "gate" only (same cwd and timeout); the in-lock command (Fast merge "Defaults", mergeCommandOf) —
 * `check.mergeCommand` when set, else `check.gateCommand`, else the full check — replaces it at the
 * merge and batch scopes, and those events then carry `full: false`. The red-main baseline, which
 * detects on its own, keeps running check.command. `permitWait` hears
 * about a wait for the check permit (the merge cell's "waiting for a check slot"). Never throws. */
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
  sampleLoad: LoadSampler = sampleHostLoad,
): Promise<{ check: BuildCheck; outcome: BuildCheckOutcome } | null> {
  const swapped = scope === "gate" ? gateCommandOf(config) : MERGE_SCOPES.has(scope) ? mergeCommandOf(config) : undefined;
  const check = detectBuildCheck(
    wt,
    swapped === undefined ? config : { check: { ...config?.check, command: swapped } },
  );
  if (!check) return null;
  const cheaper = scope !== "gate" && swapped !== undefined;
  // A configured check.timeoutSeconds bounds either kind; otherwise an npm check runs under the
  // caller's bound. Effective here so the reason text and the skip warning agree with what
  // runBuildCheck enforced.
  // A merge scope under a starved host gets a longer deadline (starvedDeadlineMs): the check
  // runs as long as the team's load stretches it, and a kill at the unstretched bound would
  // only measure the load (BUGS.md 2026-10-12). The load sampled here is also what the
  // unverified reason names.
  const load = sampleLoad();
  const effectiveMs = MERGE_SCOPES.has(scope)
    ? starvedDeadlineMs(checkTimeoutMs(check, timeoutMs), load)
    : checkTimeoutMs(check, timeoutMs);
  const runCheck = { ...check, timeoutMs: effectiveMs };
  // One permit covers both attempts (the killed-check retry re-runs under the permit it
  // holds); durationMs prices the run itself, not the wait for a permit.
  let durationMs = 0;
  const raw = await withCheckPermit(
    config,
    MERGE_SCOPES.has(scope) ? CHECK_TIER.merge : CHECK_TIER.other,
    async () => {
      // One permit covers both attempts (the killed-check retry re-runs under the permit it
      // holds); durationMs prices the run itself, not the wait for a permit. A check the
      // harness did not stop itself says nothing about the tree; a timeout whose deadline
      // demonstrably fired late, and a failed run the host slept through, are the same weather
      // — at every scope each owes one retry from a clean attempt, and the second attempt's
      // outcome stands (runWithCleanRetry). The verdict-less first attempt is priced as its own
      // event (the feed must answer how long a check took), then the final event below records
      // the retry's classified outcome.
      const { outcome, durationMs: d } = await runWithCleanRetry(
        () => runBuildCheck(wt, runCheck, timeoutMs, undefined, sampleSleep, install),
        (first, dur) => logEventBestEffort(root, buildCheckEvent(role, scope, first, dur, cheaper)),
      );
      durationMs = d;
      return outcome;
    },
    {
      waiting: () => permitWait?.waiting?.(),
      granted: () => permitWait?.granted?.(),
      waited: (waitedMs, parked) => logCheckWaitEvent(root, role, scope, waitedMs, parked),
    },
    `${role} ${scope}`,
  );
  // A signal kill at a merge scope, or a timeout whose deadline fired on time (real slowness, a
  // genuinely hung or oversized suite), made no verdict about the tree — and this is the check
  // whose whole job is to catch a semantic conflict before it merges, so it rejects
  // deterministically — the author keeps its commit and retries. A timeout whose deadline fired
  // late has already had its retry above: the lateness is the harness's own evidence the host
  // slept, so a second verdict-less attempt is recorded as unverified rather than read again as
  // weather (BUGS.md 2026-09-28). no-npm and a broken toolchain still say nothing about the tree,
  // and the gate scope still proceeds to the model reviewer, which the merge path's own check backs
  // up. A retry that ALSO slept made no clean verdict either: it is recorded as unverified — not
  // attributed to the change, not cached as a red baseline — rather than read as a second
  // deterministic failure (BUGS.md 2026-09-30). A retry that passed stands: the tree went green
  // under the project's own check, even if the host napped through parts of it.
  const sleepFailed = raw.status === "failed" && (raw.run?.sleptMs ?? 0) > SLEEP_SPAN_TOLERANCE_MS;
  // A failed dependency install is the same at a merge scope: nothing ran against the tree as its
  // lockfile pins it, so it must not merge (BUGS.md 2026-10-01).
  const unverifiedSkip =
    MERGE_SCOPES.has(scope) &&
    (((raw.status === "skipped" &&
      (raw.skipReason === "timeout" || raw.skipReason === "killed" || raw.skipReason === "install")) ||
      sleepFailed));
  const unverifiedReason =
    raw.skipReason === "install"
      ? installFailedPhrase(SCOPE_WORDS[scope].label, raw.install, UNVERIFIED_TREE)
      : raw.skipReason === "killed"
      ? killedPhrase(
          SCOPE_WORDS[scope].label,
          raw.killedBy ? { signal: raw.killedBy, durationMs } : undefined,
          UNVERIFIED_TREE,
        )
      : sleepFailed
        ? sleptPhrase(SCOPE_WORDS[scope].label, raw.run!.sleptMs!, UNVERIFIED_TREE)
        : `${SCOPE_WORDS[scope].label} ${timedOutPhrase(effectiveMs, raw.run)}; ${UNVERIFIED_TREE}${
            // An on-time kill (the late-deadline wording already names its own cause) names the
            // starved host when the load average says the team was the check's competition.
            (raw.run?.deadlineLateMs ?? 0) > DEADLINE_LATE_TOLERANCE_MS ? "" : loadedHostPhrase(load)
          }`;
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
  logEventBestEffort(root, buildCheckEvent(role, scope, outcome, durationMs, cheaper));
  if (outcome.status === "skipped") {
    // Environmental — deliberately NOT fail-closed, so a hung build script cannot wedge every
    // code run into the 3-strike discard (gate) or a merge behind the merge lock.
    const w = SCOPE_WORDS[scope];
    warnEventBestEffort(
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
    warnEventBestEffort(root, role, `${unverifiedReason}; rejecting the merge`);
  }
  return { check, outcome };
}
