import type { BackoffConfig } from "../config/config-schema.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { RunResult } from "../run/run-outcome.js";
import { yieldScaledRole } from "../roles/roles.js";

/** The role's CLOCK policy: when a role runs next — the wake semantics (clearBackoff,
 * restoreMidRunWake), the backoff ladders (nextBackoffSeconds, scheduleBackoff, the error
 * ladder), the yield-scaled clock (the recentOutcomes ring and yieldMultiplier), and the
 * min-interval scheduler. Split out of run-outcome.ts — which keeps the run's outcome
 * vocabulary (RunResult, RunOutcome), with the state machine that applies a finished outcome
 * in run-apply.ts — because "what an outcome is / what applying it records" and "what the
 * role's clock does next" are different concerns that happen to touch the same RunnerState
 * object. No I/O here: every function mutates the caller's state in place (the caller's
 * object is authoritative across an in-flight run and saves it itself), so the policy is
 * unit-tested without touching a disk. */

/** Clear a role's backoff so its next orchestrator poll finds it immediately due: zero
 * backoffSeconds (so the next no_change/error run restarts the backoff ladder from the
 * bottom instead of climbing from wherever the team parked) and pull nextRunAt forward to
 * now. Pure: returns a new state and preserves everything else — counters (an
 * observation-window reset is zeroCounters' job), wake tracking (lastMainHead), and the
 * last-result fields. Scheduling operation, not observation-window reset: it exists so an
 * operator who fixed what the roles were failing on can say "try again" (BUGS.md
 * 2026-09-15: the team had no wake lever). Also stamps wokenAt, which is what lets
 * isEligible honor the demand over the role's min-run interval (RunnerState.wokenAt). */
export function clearBackoff(s: RunnerState, now: number): RunnerState {
  // wokenAt marks the wake as newer than the current gap window's opening run, which is
  // what lets isEligible honor the demand over the min-run interval (RunnerState.wokenAt):
  // without it a role that ran inside its own slow clock stays asleep for the rest of
  // the interval and both `tumwater wake` and a queued per-role prompt silently do nothing.
  return { ...s, backoffSeconds: 0, nextRunAt: now, wokenAt: now };
}

/** Re-apply a wake that was consumed while the just-ended run was still in flight. The run
 * holds the same state object wake() mutated in place, but applyRunOutcome's own schedule
 * overwrites the wake: lastRunEndedAt is re-stamped past wokenAt (so the min-gap exemption
 * reads stale) and nextRunAt is scheduled a fresh gap or backoff out — the operator's "try
 * again now" silently waits out the whole interval. Called by the run's end-save after
 * applyRunOutcome (src/run/run-apply.ts), it re-applies the demand exactly like a wake
 * arriving one poll after the run ended: backoff cleared, nextRunAt now, wokenAt re-armed
 * past the new gap window's opening. Returns whether a mid-run wake was found. Two cases
 * deliberately do not restore: a wake older than the run's start was already honored by the
 * run that just ran (the ordinary self-clearing must hold), and a cut-off/aborted outcome's
 * `resumePending` — the next run deliberately waits one interval from the compacted context,
 * and a mid-run wake must not shortcut that wait. */
export function restoreMidRunWake(s: RunnerState): boolean {
  if (s.resumePending) return false;
  if (s.wokenAt === undefined || s.wokenAt <= (s.lastRunStartedAt ?? 0)) return false;
  // clearBackoff stamps wokenAt = now, which must read NEWER than the end-save's
  // lastRunEndedAt for isEligible's exemption to fire — both are Date.now() reads, so a
  // same-millisecond tie would swallow the demand; floor it just past the end stamp.
  Object.assign(s, clearBackoff(s, Math.max(Date.now(), (s.lastRunEndedAt ?? 0) + 1)));
  return true;
}

/** Yield-scaled clocks: how long a role's own recent
 * results stretch its min-run gap. The ring (RunnerState.recentOutcomes) holds one char per
 * COUNTED run — a merge (`changed`/`queued`) is `L`, every other counted result is `n`;
 * the error class (`error`/`aborted`/`quiet_killed`) is no yield evidence either way and is
 * not recorded at all, so a run of backend failures neither stretches a role's clock nor
 * resets it. */
export const YIELD_RING = 20;
const YIELD_MERGE = "L";
/** Results that never enter the ring. */
const UNCOUNTED_RESULTS: ReadonlySet<RunResult> = new Set(["error", "aborted", "quiet_killed"]);

/** Record one finished run's result on the state's yield ring, oldest entries falling off
 * past YIELD_RING. Mutates `s` in place, called from applyRunOutcome (src/run/run-apply.ts)
 * beside the streak counters. */
export function pushYieldOutcome(s: RunnerState, result: RunResult): void {
  if (UNCOUNTED_RESULTS.has(result)) return;
  const ch = result === "changed" || result === "queued" ? YIELD_MERGE : "n";
  s.recentOutcomes = ((s.recentOutcomes ?? "") + ch).slice(-YIELD_RING);
}

const YIELD_MAX = 8;
/** How many recent counted runs the reset window spans — a merge anywhere in the last 10
 * keeps the multiplier at 1, and the same 10 empties are what start the doubling. */
const YIELD_RESET_RECENT = 10;
/** How many further empty runs double the multiplier again (10→×2, 15→×4, 20→×8). */
const YIELD_DOUBLE_STEP = 5;

/** The multiplier on a scalable role's minRunIntervalSeconds gap its recent yield earns:
 * 1 while any of the last 10 counted runs merged, otherwise doubling per 5 further empty
 * runs — 10 empties ×2, 15 ×4, 20 ×8 — capped at 8. `recent` is the ring's chars, oldest
 * first, as pushYieldOutcome recorded them. Pure; unit-tested beside the other ladder math.
 * A merge inside the last 10 resets the multiplier to 1 even when older empties remain in
 * the ring: one merge is the evidence the role's clock should trust, and the ring's older
 * half only matters once the merge has aged out of the recent window. */
export function yieldMultiplier(recent: string[]): number {
  if (recent.slice(-YIELD_RESET_RECENT).includes(YIELD_MERGE)) return 1;
  const empty = recent.filter((c) => c !== YIELD_MERGE).length;
  if (empty < YIELD_RESET_RECENT) return 1;
  return Math.min(YIELD_MAX, 2 ** (Math.floor((empty - YIELD_RESET_RECENT) / YIELD_DOUBLE_STEP) + 1));
}

/** The yield multiplier a runner's state earns: the role's recent-yield multiplier when
 * yieldScaledRole(role) holds, else 1 (a role outside the scalable set keeps its plain gap
 * whatever its ring says). The one assembly of the scalable-role test with yieldMultiplier,
 * so the scheduler's gap (isEligible) and the mirrors that DISPLAY that gap — the TUI's
 * next-run cell (status-render.ts's nextRunCell) and the JSON/GUI payload
 * (status-payload.ts) — cannot disagree about whether a quiet role's next run is stretched. */
export function yieldMultiplierFor(s: RunnerState): number {
  return yieldScaledRole(s.role) ? yieldMultiplier((s.recentOutcomes ?? "").split("")) : 1;
}

/** The `×N` yield-multiplier suffix a next-run display rides: `×4` when the multiplier is
 * above 1, else `""` — the quiet scalable role's stretched effective gap made visible (the
 * multiplier gates the scheduled gap in isEligible, so a `now`-due cell at ×4 is a role
 * waiting out its gap, not a broken clock). Shared by the status table's `next run` cell
 * (status-render.ts's nextRunCell) and the role view's Schedule line (role-render.ts) so the
 * two node surfaces cannot drift on how an above-1 multiplier is worded; the GUI renders the
 * same rule from its own separate-runtime copy (gui-client.ts's fmtNextRun). */
export function yieldMultiplierSuffix(mult: number): string {
  return mult > 1 ? ` ×${mult}` : "";
}

/** Next step of a backoff ladder: initial (capped) on the first step, then multiplied, capped. */
export function nextBackoffSeconds(current: number, ladder: BackoffConfig): number {
  const { initialSeconds, factor, maxSeconds } = ladder;
  if (current <= 0) return Math.min(initialSeconds, maxSeconds);
  return Math.min(current * factor, maxSeconds);
}

/** Advance the role's shared backoffSeconds on `ladder` and schedule its next run after it.
 * Every backing-off outcome (an unproductive run, a failed one, a deliberate stop, and the
 * quiet-kill fallback) funnels through here, so the seconds→ms conversion and the rule that
 * each ladder advances from the current value apply identically in all four arms. */
export function scheduleBackoff(s: RunnerState, ladder: BackoffConfig): void {
  s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, ladder);
  s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
}

/** Schedule the role's next run at its minimum interval — the role-resolved config's
 * minRunIntervalSeconds (a per-role slow clock), converted seconds→ms here so every outcome
 * arm that shares this cadence cannot drift apart. The productive-side counterpart of
 * scheduleBackoff: together the two own the whole "when does this role run again" decision. */
export function scheduleAtMinInterval(s: RunnerState, cfg: { minRunIntervalSeconds: number }): void {
  s.nextRunAt = Date.now() + cfg.minRunIntervalSeconds * 1000;
}

/** Backoff ladder for failed runs (`error` results). The idle ladder prices hour-long model
 * runs — its cap exists so a role that keeps finding nothing stops burning model time. A run
 * that fails (a broken toolchain, a dead pi subprocess) often never reaches the model, so it
 * climbs this short ladder, capped in minutes: one broken `git` must not park a team for the
 * idle ladder's 10-hour sleep (BUGS.md, the 2026-09-15 outage). One ladder, one sensible
 * default, no knob: the cap is the point. */
export const ERROR_BACKOFF: BackoffConfig = { initialSeconds: 30, factor: 2, maxSeconds: 600 };
