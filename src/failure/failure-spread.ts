/** The fleet-wide wide-shallow storm alarm (BUGS.md 2026-09-30, part (2) of the
 * 2026-09-29 connection-storm entry): when many roles each fail a few times on one provider
 * failure kind, no existing bar trips — the per-role streak alarm needs one role DEEP
 * (ERROR_STREAK_WARN consecutive, src/tick/tick-apply.ts), the error-storm warning needs several
 * roles deep at once (src/failure/error-storm.ts), and the fleet hold needs failures COALESCED within
 * a two-minute window (src/fleet/fleet-hold.ts). A degraded backend that fails the fleet widely and
 * shallowly — six ticks across as many roles, each failure minutes apart — rides all three
 * gaps in silence. This alarm counts raw failures of one kind across roles in a rolling
 * window, independent of any role's streak depth: the fourth bar, shaped for the spread the
 * other three cannot see. POLICY, on the shape of its siblings (src/failure/error-storm.ts,
 * src/fleet/fleet-hold.ts): a pure reducer over the observations the orchestrator collects each
 * poll and the previous state, so the rule is unit-testable without a fleet and the
 * orchestrator owns only the wiring (the warning event). Like both siblings it has memory —
 * which failures still sit inside the window is a fact about the past no single poll's inputs
 * carry — so it is a reducer rather than a stateless predicate. */

import { type HoldKind, type HoldObservation } from "../fleet/fleet-hold.js";
import { rankCountEntries } from "./rank.js";

/** Failures of one kind within the window that trip the alarm. Six in thirty minutes: the
 * same magnitude as the 2026-09-29 storm's recorded cluster (10× across 7 roles) at the
 * density that distinguishes a storm from a day's ordinary scattering — and far above the
 * hold's bar (2 roles in 2 minutes), so a storm the hold already answered is old news here,
 * not a second alarm. One role's six failures trip it too, deliberately: six provider
 * failures of one kind in half an hour is a storm whatever its shape, and the event names the
 * roles so the operator sees which shape it took. */
export const FAILURE_SPREAD_COUNT = 6;

/** How recent a failure must be to count toward the alarm. Thirty minutes: wide enough that
 * failures spaced minutes apart — the shape a degraded backend produces against a staggered
 * fleet — read as one episode; narrow enough that a bad half-hour this morning does not alarm
 * all afternoon. */
export const FAILURE_SPREAD_WINDOW_MS = 30 * 60_000;

/** The alarm's cross-poll state: the failures still inside the window and whether the alarm
 * is sounding. In memory only — a restart mid-storm can re-log one warning, the same
 * concession its siblings make. */
export interface FailureSpread {
  /** The window's observations, oldest first — every failure seen that is still recent.
   * Deduplicated by (role, kind, at): a runner's latest-failure observation repeats every
   * poll until a newer run replaces it, and one failure must count once. */
  recent: readonly HoldObservation[];
  /** True while the alarm is sounding — the crossing already warned; stays until no kind
   * meets the bar, which re-arms it. */
  active: boolean;
  /** The kind the sounding alarm (or, while quiet, the last alarm) is about; null before the
   * first. Kept across a clear so the wiring can tell a re-trip of the same kind from a new
   * kind's episode. */
  kind: HoldKind | null;
}

/** The fleet's starting state: quiet, with no history. */
export const FAILURE_SPREAD_QUIET: FailureSpread = { recent: [], active: false, kind: null };

/** Step the alarm by one orchestrator poll: fold each observation into the window (skipping
 * ones older than the window and ones already folded — the same runner observation re-read
 * poll after poll), prune what aged out, and decide what is sounding now. The strongest kind
 * (most failures in the window, ties broken by kind for determinism) is the episode; the bar
 * is a plain failure count — no role's streak depth enters. Edge-triggered, like every
 * warning: the quiet→active crossing sounds the alarm (the wiring logs exactly one event),
 * a poll that still sees the same kind above the bar changes nothing the wiring can hear,
 * and a window that thins below the bar re-arms the alarm — a recurrence warns again. A
 * DIFFERENT kind reaching the bar while one is sounding is a new episode: one alarm at a
 * time, and the new kind names itself. The wiring keys its log off `active` and `kind`, not
 * object identity — `recent` moves almost every poll, so this reducer cannot return `prev`
 * itself the way its stateless-crossing siblings do. */
export function failureSpread(
  prev: FailureSpread,
  observations: readonly HoldObservation[],
  now: number,
): FailureSpread {
  const recent = prev.recent.filter((o) => now - o.at <= FAILURE_SPREAD_WINDOW_MS);
  for (const o of observations) {
    if (now - o.at > FAILURE_SPREAD_WINDOW_MS) continue;
    if (recent.some((r) => r.role === o.role && r.kind === o.kind && r.at === o.at)) continue;
    recent.push({ role: o.role, kind: o.kind, at: o.at });
  }
  const counts = new Map<HoldKind, number>();
  for (const o of recent) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const top = rankCountEntries(counts)[0];
  if (!top || top[1] < FAILURE_SPREAD_COUNT) {
    return { recent, active: false, kind: prev.kind };
  }
  return { recent, active: true, kind: top[0] };
}
