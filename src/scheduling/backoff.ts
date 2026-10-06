import type { BackoffConfig } from "../config/config-schema.js";
import type { LoopState } from "../loop/loop-state.js";
import type { TickResult } from "../tick/tick-outcome.js";

/** The loop's CLOCK policy: when a loop runs next — the wake semantics (clearBackoff,
 * restoreMidTickWake), the backoff ladders (nextBackoffSeconds, scheduleBackoff, the error
 * ladder), the yield-scaled clock (the recentOutcomes ring and yieldMultiplier), and the
 * min-interval scheduler. Split out of tick-outcome.ts — which keeps the tick's outcome
 * vocabulary (TickResult, TickOutcome), with the state machine that applies a finished outcome
 * in tick-apply.ts — because "what an outcome is / what applying it records" and "what the
 * loop's clock does next" are different concerns that happen to touch the same LoopState
 * object. No I/O here: every function mutates the caller's state in place (the caller's
 * object is authoritative across an in-flight tick and saves it itself), so the policy is
 * unit-tested without touching a disk. */

/** Clear a loop's backoff so its next orchestrator poll finds it immediately due: zero
 * backoffSeconds (so the next no_change/error tick restarts the backoff ladder from the
 * bottom instead of climbing from wherever the fleet parked) and pull nextRunAt forward to
 * now. Pure: returns a new state and preserves everything else — counters (an
 * observation-window reset is zeroCounters' job), wake tracking (lastMainHead), and the
 * last-result fields. Scheduling operation, not observation-window reset: it exists so an
 * operator who fixed what the loops were failing on can say "try again" (BUGS.md
 * 2026-09-15: the fleet had no wake lever). Also stamps wokenAt, which is what lets
 * isEligible honor the demand over the role's min-tick interval (LoopState.wokenAt). */
export function clearBackoff(s: LoopState, now: number): LoopState {
  // wokenAt marks the wake as newer than the current gap window's opening tick, which is
  // what lets isEligible honor the demand over the min-tick interval (LoopState.wokenAt):
  // without it a loop that ticked inside its own slow clock stays asleep for the rest of
  // the interval and both `tumwater wake` and a queued per-role prompt silently do nothing.
  return { ...s, backoffSeconds: 0, nextRunAt: now, wokenAt: now };
}

/** Re-apply a wake that was consumed while the just-ended tick was still in flight. The tick
 * holds the same state object wake() mutated in place, but applyTickOutcome's own schedule
 * overwrites the wake: lastTickEndedAt is re-stamped past wokenAt (so the min-gap exemption
 * reads stale) and nextRunAt is scheduled a fresh gap or backoff out — the operator's "try
 * again now" silently waits out the whole interval. Called by the tick's end-save after
 * applyTickOutcome (src/tick/tick-apply.ts), it re-applies the demand exactly like a wake
 * arriving one poll after the tick ended: backoff cleared, nextRunAt now, wokenAt re-armed
 * past the new gap window's opening. Returns whether a mid-tick wake was found. Two cases
 * deliberately do not restore: a wake older than the tick's start was already honored by the
 * tick that just ran (the ordinary self-clearing must hold), and a cut-off/aborted outcome's
 * `resumePending` — the next run deliberately waits one interval from the compacted context,
 * and a mid-tick wake must not shortcut that wait. */
export function restoreMidTickWake(s: LoopState): boolean {
  if (s.resumePending) return false;
  if (s.wokenAt === undefined || s.wokenAt <= (s.lastTickStartedAt ?? 0)) return false;
  // clearBackoff stamps wokenAt = now, which must read NEWER than the end-save's
  // lastTickEndedAt for isEligible's exemption to fire — both are Date.now() reads, so a
  // same-millisecond tie would swallow the demand; floor it just past the end stamp.
  Object.assign(s, clearBackoff(s, Math.max(Date.now(), (s.lastTickEndedAt ?? 0) + 1)));
  return true;
}

/** Yield-scaled clocks (PLANS.md "Yield-scaled clocks"): how long a role's own recent
 * results stretch its min-tick gap. The ring (LoopState.recentOutcomes) holds one char per
 * COUNTED tick — a landing (`changed`/`queued`) is `L`, every other counted result is `n`;
 * the error class (`error`/`aborted`/`quiet_killed`) is no yield evidence either way and is
 * not recorded at all, so a run of backend failures neither stretches a role's clock nor
 * resets it. */
export const YIELD_RING = 20;
const YIELD_LAND = "L";
/** Results that never enter the ring. */
const UNCOUNTED_RESULTS: ReadonlySet<TickResult> = new Set(["error", "aborted", "quiet_killed"]);

/** Record one finished tick's result on the state's yield ring, oldest entries falling off
 * past YIELD_RING. Mutates `s` in place, called from applyTickOutcome (src/tick/tick-apply.ts)
 * beside the streak counters. */
export function pushYieldOutcome(s: LoopState, result: TickResult): void {
  if (UNCOUNTED_RESULTS.has(result)) return;
  const ch = result === "changed" || result === "queued" ? YIELD_LAND : "n";
  s.recentOutcomes = ((s.recentOutcomes ?? "") + ch).slice(-YIELD_RING);
}

const YIELD_MAX = 8;

/** The multiplier on a scalable role's minTickIntervalSeconds gap its recent yield earns:
 * 1 while any of the last 10 counted ticks landed, otherwise doubling per 5 further empty
 * ticks — 10 empties ×2, 15 ×4, 20 ×8 — capped at 8. `recent` is the ring's chars, oldest
 * first, as pushYieldOutcome recorded them. Pure; unit-tested beside the other ladder math.
 * A landing inside the last 10 resets the multiplier to 1 even when older empties remain in
 * the ring: one landing is the evidence the role's clock should trust, and the ring's older
 * half only matters once the landing has aged out of the recent window. */
export function yieldMultiplier(recent: string[]): number {
  if (recent.slice(-10).includes(YIELD_LAND)) return 1;
  const empty = recent.filter((c) => c !== YIELD_LAND).length;
  if (empty < 10) return 1;
  return Math.min(YIELD_MAX, 2 ** (Math.floor((empty - 10) / 5) + 1));
}

/** Next step of a backoff ladder: initial (capped) on the first step, then multiplied, capped. */
export function nextBackoffSeconds(current: number, ladder: BackoffConfig): number {
  const { initialSeconds, factor, maxSeconds } = ladder;
  if (current <= 0) return Math.min(initialSeconds, maxSeconds);
  return Math.min(current * factor, maxSeconds);
}

/** Advance the loop's shared backoffSeconds on `ladder` and schedule its next tick after it.
 * Every backing-off outcome (an unproductive tick, a failed one, a deliberate stop, and the
 * quiet-kill fallback) funnels through here, so the seconds→ms conversion and the rule that
 * each ladder advances from the current value apply identically in all four arms. */
export function scheduleBackoff(s: LoopState, ladder: BackoffConfig): void {
  s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, ladder);
  s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
}

/** Schedule the loop's next tick at its minimum interval — the role-resolved config's
 * minTickIntervalSeconds (a per-role slow clock), converted seconds→ms here so every outcome
 * arm that shares this cadence cannot drift apart. The productive-side counterpart of
 * scheduleBackoff: together the two own the whole "when does this loop run again" decision. */
export function scheduleAtMinInterval(s: LoopState, cfg: { minTickIntervalSeconds: number }): void {
  s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
}

/** Backoff ladder for failed ticks (`error` results). The idle ladder prices hour-long model
 * runs — its cap exists so a loop that keeps finding nothing stops burning model time. A tick
 * that fails (a broken toolchain, a dead pi subprocess) often never reaches the model, so it
 * climbs this short ladder, capped in minutes: one broken `git` must not park a fleet for the
 * idle ladder's 10-hour sleep (BUGS.md, the 2026-09-15 outage). One ladder, one sensible
 * default, no knob: the cap is the point. */
export const ERROR_BACKOFF: BackoffConfig = { initialSeconds: 30, factor: 2, maxSeconds: 600 };
