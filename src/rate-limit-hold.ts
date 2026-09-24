/** The fleet-wide 429 hold (BUGS.md 2026-09-21, spun out of the fixed 429-retry entry
 * 2026-09-22): when several roles see the provider rate-limit them within a short window, role
 * loops start no new ticks until the hold re-opens. The per-run transient retry
 * (src/loop-pi.ts) already gives each 429 one wait-and-retry, but it has no cross-role view —
 * with maxConcurrent loops issuing requests against one fleet-wide limit, each burns its retry
 * straight into a storm the fleet is collectively sustaining. POLICY only, on the shape of the
 * budget gate (src/budget.ts): pure functions of the observations the orchestrator collects
 * each poll and the previous hold, so the rule is unit-testable without a fleet and the
 * orchestrator owns only the wiring (the transition events and the scheduling skip). Unlike the
 * budget gate this one has memory — when the hold ends and how often it has relapsed are facts
 * about the past no single poll's inputs carry — so it is a reducer over RateLimitHold rather
 * than a stateless function. */

/** Distinct roles whose pi runs ended on a 429 within RATE_LIMIT_STORM_WINDOW_MS that trip the
 * hold. Two, not one: a single role's 429 is exactly what the per-run retry already answers, and
 * the hold exists for the cross-role amplification it cannot see. Two, not three: calibrated on
 * the 2026-09-21 storm, whose clusters (improve + coverage 48 s apart at 18:13, dry + feature
 * 6 s apart at 19:06, bugfix + perf 18 s apart on 09-22 05:50) had two roles in the window as
 * often as three, while the six isolated 429s logged since the retry landed sit 4–20 minutes
 * apart and trip nothing. A false trip costs one base hold; a missed storm costs the day. */
export const RATE_LIMIT_STORM_ROLES = 2;

/** How recent a 429 must be to count toward a storm. Two minutes: wide enough that roles whose
 * requests are staggered by a turn's generation time still read as one storm (the observed
 * clusters span 6–80 s), narrow enough that unrelated one-off 429s minutes apart never add up. */
export const RATE_LIMIT_STORM_WINDOW_MS = 2 * 60_000;

/** The first hold of a fresh storm. One minute: provider rate limits are metered in per-minute
 * buckets, so a minute is the shortest pause that lets the bucket refill — and short enough that
 * a false trip barely dents the fleet's throughput. */
export const RATE_LIMIT_HOLD_BASE_MS = 60_000;

/** Upper bound on any single hold, whatever Retry-After or the relapse doubling asks for: one
 * generous hint, or a storm that outlasts every re-open (2026-09-21's ran from 16:00 to past
 * 23:30), must still re-probe the provider a few times an hour rather than park the fleet for
 * it. Doubling from the base reaches it on the fourth consecutive relapse (1, 2, 4, 8, 15 min). */
export const RATE_LIMIT_HOLD_CAP_MS = 15 * 60_000;

/** A storm that trips again within this long of the previous hold re-opening is the same
 * storm — the hold was too short — so the next one doubles instead of restarting at the base.
 * Five minutes: longer than the storm window, because the re-opened fleet's first ticks take a
 * few turns to reach the provider again; a fleet that stays clear that long has recovered, and
 * its next storm starts fresh at the base. */
export const RATE_LIMIT_RELAPSE_MS = 5 * 60_000;

/** One role's most recent pi run that ended on a provider 429 (LoopRunner.lastRateLimit). Only
 * the latest per role matters: the storm test counts distinct roles, never a role's repeats. */
export interface RateLimitObservation {
  role: string;
  /** Epoch ms the run ended on the 429. */
  at: number;
  /** The provider's Retry-After hint from that run's error text, when it sent one. */
  retryAfterSeconds?: number;
}

/** The hold's state across polls. Open while `until` is null. */
export interface RateLimitHold {
  /** Epoch ms the current hold re-opens at; null while the fleet is open. */
  until: number | null;
  /** The distinct roles (sorted) whose 429s tripped the current hold — empty while open. The
   * rate_limit_hold event's answer to "who saw it". */
  roles: string[];
  /** Consecutive relapses behind the current (or last) hold: 0 for a fresh storm, +1 for each
   * hold that tripped within RATE_LIMIT_RELAPSE_MS of the previous re-open. Doubles the base. */
  escalation: number;
  /** Epoch ms the last hold re-opened; null before the first. A 429 observed at or before it
   * never counts toward the next storm: it is the storm that hold already answered (the
   * observations that tripped it, and any an in-flight tick hit while it held — that tick's own
   * retry is already waiting it out). Also the reference point for a relapse. */
  reopenedAt: number | null;
}

/** The fleet's starting state: open, with no history. */
export const RATE_LIMIT_OPEN: RateLimitHold = { until: null, roles: [], escalation: 0, reopenedAt: null };

/** Step the hold by one orchestrator poll: from `prev` and every role's latest 429, decide what
 * holds at `now`. A held fleet stays held until `until` and then re-opens by itself — nothing
 * can get stuck, the same guarantee the budget gate's stateless re-evaluation gives. An open
 * fleet trips when RATE_LIMIT_STORM_ROLES distinct roles each ended a run on a 429 within the
 * storm window (and after the last re-open), for the longest of the escalated base hold and the
 * furthest Retry-After deadline among those observations (each measured from its own 429, since
 * that is when the provider said it), capped at RATE_LIMIT_HOLD_CAP_MS. Returns `prev` itself
 * when nothing changed, so a caller can compare `until` across the step to find transitions. */
export function rateLimitHold(
  prev: RateLimitHold,
  observations: readonly RateLimitObservation[],
  now: number,
): RateLimitHold {
  if (prev.until !== null) {
    if (now < prev.until) return prev;
    return { until: null, roles: [], escalation: prev.escalation, reopenedAt: now };
  }
  const storm = observations.filter(
    (o) => (prev.reopenedAt === null || o.at > prev.reopenedAt) && now - o.at <= RATE_LIMIT_STORM_WINDOW_MS,
  );
  const roles = [...new Set(storm.map((o) => o.role))].sort();
  if (roles.length < RATE_LIMIT_STORM_ROLES) return prev;
  const relapse = prev.reopenedAt !== null && now - prev.reopenedAt <= RATE_LIMIT_RELAPSE_MS;
  const escalation = relapse ? prev.escalation + 1 : 0;
  const retryAfterMs = Math.max(0, ...storm.map((o) => o.at + (o.retryAfterSeconds ?? 0) * 1000 - now));
  const holdMs = Math.min(RATE_LIMIT_HOLD_CAP_MS, Math.max(RATE_LIMIT_HOLD_BASE_MS * 2 ** escalation, retryAfterMs));
  return { until: now + holdMs, roles, escalation, reopenedAt: prev.reopenedAt };
}
