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
export const DEADLINE_LATE_TOLERANCE_MS = 5_000;

/** How much measured sleep (BuildCheckRun.sleptMs, host-sleep.ts) inside one check's run the
 * harness treats as none. Normal dark wakes are seconds; the sleep-caused failures BUGS.md
 * 2026-09-30 recorded spanned 59–252 s of a 116–275 s run. A run carrying more than this much
 * measured suspension is not a verdict about the tree: it is retried once from a clean attempt,
 * and a retry that also sleeps is recorded as unverified. Aligned with the deadline tolerance
 * above so neither measurement's noise floor crosses into policy on its own. */
export const SLEEP_SPAN_TOLERANCE_MS = 5_000;

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

/** The `<label> was killed by <signal> after <secs>s; <proceeding>` sentence for an external
 * signal kill — the one home of that phrasing, shared by buildCheckSkipWarning's "killed" skip
 * warning and runScopedBuildCheck's merge-scope unverified reason, so the two surfaces render
 * the same kill identically. A kill the caller could not attribute to a signal is described as
 * an external signal rather than pretending the timeout fired. */
export function killedPhrase(
  label: string,
  killed: { signal: string; durationMs: number } | undefined,
  proceeding: string,
): string {
  return killed
    ? `${label} was killed by ${killed.signal} after ${killed.durationMs / 1000}s; ${proceeding}`
    : `${label} was killed by an external signal; ${proceeding}`;
}

/** The `<label> ran while the host slept <secs>s mid-run; <proceeding>` sentence for a check
 * whose run spanned a measured host sleep — the one home of that phrasing, beside killedPhrase
 * and timedOutPhrase, so the merge-scope unverified reason and any later warning render the
 * same sleep identically. The measured amount is the run's own sleptMs (host-sleep.ts); it is
 * what makes this a statement about the host rather than a guess at one. */
export function sleptPhrase(label: string, sleptMs: number, proceeding: string): string {
  const secs = Math.round(sleptMs / 100) / 10;
  return `${label} ran while the host slept ${secs}s mid-run; ${proceeding}`;
}

/** The `the dependency install (<pkgs>) failed[: <detail>]; skipping <label>; <proceeding>`
 * sentence for an "install" skip — the tree's lockfile pinned dependencies the walk-up did not
 * provide and installing them failed (dep-install.ts). One home, beside killedPhrase and
 * sleptPhrase, for the skip warning and the merge-scope unverified reason. A caller with no
 * install record (the red-main baseline's MainBaselineCheck) gets the name-less form. */
export function installFailedPhrase(
  label: string,
  install: { packages: string[]; detail?: string } | undefined,
  proceeding: string,
): string {
  const pkgs = install && install.packages.length > 0 ? ` (${install.packages.join(", ")})` : "";
  const detail = install?.detail ? `: ${install.detail}` : "";
  return `the dependency install${pkgs} failed${detail}; skipping ${label}; ${proceeding}`;
}

/** Did this outcome make no verdict about the tree? runScopedBuildCheck records that verdict-
 * less shape explicitly (`unverified: true`) at the merge scopes; a gate-scope failure carries
 * only the run's own sleep evidence (BuildCheckRun.sleptMs), so both spellings count. The
 * consumers that attribute a red — review.ts's gate, landing-core.ts's attribution, the
 * red-main baseline — ask this instead of re-deriving the evidence, so the attribution policy
 * cannot drift between them (BUGS.md 2026-09-30). */
export function unverifiedTreeOutcome(outcome: { unverified?: boolean; run?: BuildCheckRun }): boolean {
  return outcome.unverified === true || (outcome.run?.sleptMs ?? 0) > SLEEP_SPAN_TOLERANCE_MS;
}

/** The one-line warning for an environmental check skip, keyed on why the check could not run.
 * `label` names the check in the feed and `proceeding` says what happens despite the skip; the
 * scoped check (SCOPE_WORDS above) and the red-main baseline gate (main-red.ts) differ only in
 * those two words, so the mapping lives here once instead of drifting per surface. A "killed"
 * skip carries the caller's `killed` info when it has it — the signal and the check's real
 * wall-clock, not the timeout bound — and a signal-less form otherwise, so the warning never
 * again names a timeout that did not fire. A "timeout" skip names the bound the run was armed
 * with, and when the caller passes the run and its deadline fired late, the time it really
 * fired at (timedOutPhrase). An "install" skip names the drifted packages and how the install
 * failed when the caller has the outcome's install record (installFailedPhrase). */
export function buildCheckSkipWarning(
  skipReason: BuildSkipReason,
  label: string,
  proceeding: string,
  timeoutMs: number,
  killed?: { signal: string; durationMs: number },
  run?: BuildCheckRun,
  install?: { packages: string[]; detail?: string },
): string {
  if (skipReason === "no-npm") return `no npm on PATH; skipping ${label}`;
  if (skipReason === "install") return installFailedPhrase(label, install, proceeding);
  if (skipReason === "toolchain") return `the toolchain is broken; skipping ${label}; ${proceeding}`;
  if (skipReason === "killed") return killedPhrase(label, killed, proceeding);
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
    // The measured host sleep inside the run (host-sleep.ts), when the platform could measure
    // one — the field BUGS.md 2026-09-30 added so a sleep that finishes inside the deadline
    // still leaves its trace on the feed.
    ...(run.sleptMs === undefined ? {} : { sleptMs: run.sleptMs }),
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
  outcome: Pick<BuildCheckOutcome, "status" | "script" | "run" | "counts" | "install">,
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
    // The harness's own attestation of the runner's summary (parseTestCounts), carried on
    // passed and failed outcomes when the check printed a summary block.
    ...(outcome.counts ? { counts: outcome.counts } : {}),
    // The lockfile install the check ran first (dep-install.ts): which direct dependencies had
    // drifted, and what the install cost — priced apart from the check's own durationMs.
    ...(outcome.install
      ? {
          installed: outcome.install.packages,
          installMs: outcome.install.durationMs,
          ...(outcome.install.detail ? { installError: outcome.install.detail } : {}),
        }
      : {}),
  };
}
