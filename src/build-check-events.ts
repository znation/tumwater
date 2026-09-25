/** The presentation half of the build check: the scope vocabulary, the environmental-skip
 * warning's wording, and the build_check event's shape. Split out of build-check.ts — which
 * keeps the deterministic execution and classification (detect → spawn → classify) — because
 * wording and event construction are how the check is *described*, not how it *runs*: they
 * change when feed wording or event fields change, and several surfaces outside build-check.ts
 * (main-red.ts's baseline logger, redeploy.ts's mirror) construct the same event without ever
 * running a check. This module imports only types from build-check.js, so no runtime cycle.
 * runScopedBuildCheck (build-check.ts) is the only caller that both runs a check and uses this
 * wording; the baseline surfaces use the event/warning helpers alone. */

import type { HarnessEventInput } from "./events.js";
import type { BuildCheckOutcome, BuildCheckRun, BuildSkipReason } from "./build-check.js";

/** The scopes named in a build_check event logged from runScopedBuildCheck. The red-main
 * baseline names its own ("baseline") from main-red.ts, because the one-run-per-SHA cache and
 * in-flight dedup live in checkMainBaseline — the event there is logged by the paying role via
 * the onRun hook. */
export type BuildCheckScope = "gate" | "landing" | "batch";

/** How late a check's deadline timer may fire before the timeout's wording stops naming the
 * configured bound alone. Normal timer lag is milliseconds; past this the warning and the
 * merge-scope reason name the wall-clock time the deadline actually fired and how late (see
 * BuildCheckRun.deadlineLateMs), because "timed out after 300s" for a check that ran 712 s is
 * the false claim BUGS.md 2026-09-21 recorded. The exact lateness is on the build_check event
 * either way; this only keeps sub-second jitter out of the one-line warning. */
const DEADLINE_LATE_TOLERANCE_MS = 5_000;

/** Per-scope wording for the environmental-skip warning. The call sites' current messages
 * are identical apart from these words, so keying them on the scope keeps each surface's feed
 * line byte-for-byte what it is today. */
export const SCOPE_WORDS: Record<BuildCheckScope, { label: string; proceeding: string }> = {
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
export const MERGE_SCOPES: ReadonlySet<BuildCheckScope> = new Set(["landing", "batch"]);

/** How a timed-out check is described: "timed out after <bound>s" when the deadline fired on
 * time, and otherwise the wall-clock time it actually fired at, with the configured bound and
 * the lateness beside it — so no warning or reject reason claims a bound the run did not keep
 * (BUGS.md 2026-09-21: "timed out after 300s" for checks that ran 331–1158 s, each one a host
 * that slept through the deadline). The bound is the run's own when it has one — what
 * runScriptGroup actually armed — and the caller's otherwise. Shared by buildCheckSkipWarning
 * and runScopedBuildCheck's merge-scope reason. */
export function timedOutPhrase(timeoutMs: number, run?: BuildCheckRun): string {
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
 * Spread into every build_check event by buildCheckEvent below, so the feed can separate the
 * check's own wall-clock from the probe around it, and a deadline that fired late from one
 * that fired on time. Empty when nothing was spawned. */
function buildCheckRunFields(outcome: BuildCheckOutcome): Record<string, number> {
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

/** The one home of the build_check event's shape — `{ loop, type: "build_check", scope,
 * status, script, durationMs }` plus the run-timing fields (buildCheckRunFields above) —
 * so the feed's most expensive event type cannot drift a field between its four surfaces:
 * runScopedBuildCheck's two priced events in build-check.ts (the killed retry and the final
 * verdict) and the red-main baseline loggers (main-red.ts's baselineCheckLogger, redeploy.ts's redeploy
 * mirror), which all paid the run whose timings the event carries. */
export function buildCheckEvent(
  loop: string,
  scope: BuildCheckScope | "baseline",
  outcome: Pick<BuildCheckOutcome, "status" | "script" | "run">,
  durationMs: number,
): HarnessEventInput {
  return {
    loop,
    type: "build_check",
    scope,
    status: outcome.status,
    script: outcome.script,
    durationMs,
    ...buildCheckRunFields(outcome),
  };
}
