/** The fleet-wide backend-failure hold — the generalization of the 429 storm hold (BUGS.md
 * 2026-09-21, spun out of the fixed 429-retry entry 2026-09-22; generalized 2026-09-29,
 * PLANS.md): when several roles see the provider fail them the same way within a short window
 * — a 429 storm, or the connection down, a 5xx spell, or the model failing to load — role
 * loops start no new ticks until the hold re-opens. The per-run transient retry
 * (src/loop/loop-pi.ts) already gives each transient failure one wait-and-retry, but it has no
 * cross-role view — with maxConcurrent loops issuing requests against one backend, each burns
 * its retry straight into a storm the fleet is collectively sustaining. POLICY only, on the
 * shape of the budget gate (src/budget.ts): pure functions of the observations the
 * orchestrator collects each poll and the previous hold, so the rule is unit-testable without
 * a fleet and the orchestrator owns only the wiring (the transition events and the scheduling
 * skip). Unlike the budget gate this one has memory — when the hold ends and how often it has
 * relapsed are facts about the past no single poll's inputs carry — so it is a reducer over
 * FleetHold rather than a stateless function.
 *
 * One storm is one KIND of failure: observations count together only when their kinds match
 * (a "rate-limit" kind for 429s, a backend-failure kind — "connection", "timeout", "server",
 * "model-load" — from src/pi/pi-stream.ts backendKind otherwise). Two roles hitting the provider
 * with two different failures are two unrelated incidents, each still answered by the per-run
 * retry; a hold is for the fleet collectively sustaining one failure. */

/** Distinct roles whose pi runs ended on the SAME failure kind within
 * HOLD_STORM_WINDOW_MS that trip the hold. Two, not one: a single role's failure is
 * exactly what the per-run retry already answers, and the hold exists for the cross-role
 * amplification it cannot see. Two, not three: calibrated on the 2026-09-21 storm, whose
 * clusters (improve + coverage 48 s apart at 18:13, dry + feature 6 s apart at 19:06, bugfix +
 * perf 18 s apart on 09-22 05:50) had two roles in the window as often as three, while the six
 * isolated 429s logged since the retry landed sit 4–20 minutes apart and trip nothing. A false
 * trip costs one base hold; a missed storm costs the day. */
import { sortedRoles } from "../failure/failure-cluster.js";
import type { BackendFailureKind } from "../pi/pi-stream.js";

const HOLD_STORM_ROLES = 2;

/** How recent a failure must be to count toward a storm. Two minutes: wide enough that roles
 * whose requests are staggered by a turn's generation time still read as one storm (the
 * observed clusters span 6–80 s), narrow enough that unrelated one-off failures minutes apart
 * never add up. */
export const HOLD_STORM_WINDOW_MS = 2 * 60_000;

/** The first hold of a fresh storm. One minute: provider rate limits are metered in
 * per-minute buckets, so a minute is the shortest pause that lets the bucket refill — and
 * short enough that a false trip barely dents the fleet's throughput. Backend-failure kinds
 * carry no Retry-After hint, so this base is their whole first hold too. */
export const HOLD_BASE_MS = 60_000;

/** Upper bound on any single hold, whatever Retry-After or the relapse doubling asks for: one
 * generous hint, or a storm that outlasts every re-open (2026-09-21's ran from 16:00 to past
 * 23:30), must still re-probe the provider a few times an hour rather than park the fleet for
 * it. Doubling from the base reaches it on the fourth consecutive relapse (1, 2, 4, 8, 15 min). */
export const HOLD_CAP_MS = 15 * 60_000;

/** A storm that trips again within this long of the previous hold re-opening is the same
 * storm — the hold was too short — so the next one doubles instead of restarting at the base.
 * Five minutes: longer than the storm window, because the re-opened fleet's first ticks take a
 * few turns to reach the provider again; a fleet that stays clear that long has recovered, and
 * its next storm starts fresh at the base. A RELAPSE IS PER KIND: the same kind re-tripping
 * inside the window escalates, while a different kind after a re-open is a new incident at the
 * base — one failure recovering into another says nothing about the first one's depth. */
export const HOLD_RELAPSE_MS = 5 * 60_000;

/** The failure kinds a hold can be about: the rate-limit kind for 429 storms, and the
 * backend-failure kinds src/pi/pi-stream.ts's classifier produces for the non-429 texts —
 * imported as a type rather than re-spelled, so the classifier's kind list and the hold's
 * stay one list by construction: a kind the classifier starts producing is holdable without
 * a second edit here, and the two spellings cannot drift apart. */
export type HoldKind = "rate-limit" | BackendFailureKind;

/** One role's most recent pi run that ended on a provider failure (LoopRunner.lastRateLimit
 * for the "rate-limit" kind, LoopRunner.lastBackendFailure for the backend kinds). Only the
 * latest per role matters: the storm test counts distinct roles, never a role's repeats. */
export interface HoldObservation {
  role: string;
  /** Which backend served the failing run (the resolved config's provider; undefined when
   * none is configured — pi's own default backend, which every unconfigured role shares).
   * The second axis the storm test groups by (PLANS.md 2026-10-05): a 429 storm at the
   * reviewer's provider must not stop authors on a healthy one, so observations count
   * together only when both provider AND kind match. */
  provider?: string;
  /** Which failure the run ended on — the field the storm test groups by. */
  kind: HoldKind;
  /** Epoch ms the run ended on the failure. */
  at: number;
  /** The provider's Retry-After hint from that run's error text, when it sent one. Only the
   * rate-limit kind carries one; backend kinds leave it undefined, and the hold math gives
   * them the base. */
  retryAfterSeconds?: number;
}

/** The hold's state across polls. Open while `until` is null. */
export interface FleetHold {
  /** Which backend this hold is about — the provider the storm's failures came from
   * (undefined when the runs ran on pi's default, no provider configured). Kept across a
   * re-open like `kind`, for the same reason: the relapse test compares the NEXT storm's
   * provider and kind against the hold that just ended. */
  provider: string | undefined;
  /** Epoch ms the current hold re-opens at; null while the fleet is open. */
  until: number | null;
  /** Which failure kind the current (or last) hold is about — null before the fleet's first
   * hold. Kept across a re-open (unlike `roles`, which clears) because the same-kind relapse
   * test below compares the NEXT storm's kind against it: nulling it while open would erase
   * the one fact the relapse rule needs. A relapse of the same kind escalates; a different
   * kind starts at the base. */
  kind: HoldKind | null;
  /** The distinct roles (sorted) whose failures tripped the current hold — empty while open.
   * The rate_limit_hold event's answer to "who saw it". */
  roles: string[];
  /** Consecutive relapses behind the current (or last) hold: 0 for a fresh storm, +1 for each
   * hold that tripped within HOLD_RELAPSE_MS of the previous re-open with the same
   * kind. Doubles the base. */
  escalation: number;
  /** Epoch ms the last hold re-opened; null before the first. A failure observed at or before
   * it never counts toward the next storm: it is the storm that hold already answered (the
   * observations that tripped it, and any an in-flight tick hit while it held — that tick's
   * own retry is already waiting it out). Also the reference point for a relapse. */
  reopenedAt: number | null;
}

/** The fleet's starting state: open, with no history. Providers are map keys elsewhere
 * (pollFleetHold keeps one hold per provider), so undefined means "pi's default backend" —
 * the grouping an unconfigured fleet (every existing config before providers) lands in. */
export const FLEET_OPEN: FleetHold = {
  provider: undefined,
  until: null,
  kind: null,
  roles: [],
  escalation: 0,
  reopenedAt: null,
};

/** The providers (pi's default included as undefined) whose fleet hold STANDS — `until`
 * non-null. A provider whose hold has re-opened stays in the holds map (its kind, relapse
 * count, and re-open time are the memory the next storm's relapse test needs), so key
 * presence alone must never read as "held": this is the one predicate every consumer —
 * the scheduling pass and both permit-time closures — goes through. */
export function heldProviders(
  holds: ReadonlyMap<string | undefined, FleetHold>,
): ReadonlySet<string | undefined> {
  const held = new Set<string | undefined>();
  for (const [provider, hold] of holds) if (hold.until !== null) held.add(provider);
  return held;
}

/** Step the hold by one orchestrator poll: from `prev` and every role's latest failure
 * observations, decide what holds at `now`. A held fleet stays held until `until` and then
 * re-opens by itself — nothing can get stuck, the same guarantee the budget gate's stateless
 * re-evaluation gives. An open fleet trips when HOLD_STORM_ROLES distinct roles each
 * ended a run on the same failure kind within the storm window (and after the last re-open) —
 * the first qualifying kind in observation order wins, since one poll can hold about only one
 * kind — for the longest of the escalated base hold and, for a rate-limit storm, the furthest
 * Retry-After deadline among those observations (each measured from its own 429, since that is
 * when the provider said it), capped at HOLD_CAP_MS. Returns `prev` itself when
 * nothing changed, so a caller can compare `until` across the step to find transitions. */
export function fleetHold(
  prev: FleetHold,
  observations: readonly HoldObservation[],
  now: number,
): FleetHold {
  if (prev.until !== null) {
    if (now < prev.until) return prev;
    // kind and provider stay: the next storm's relapse test compares against the hold that
    // just ended.
    return {
      provider: prev.provider,
      until: null,
      kind: prev.kind,
      roles: [],
      escalation: prev.escalation,
      reopenedAt: now,
    };
  }
  const recent = observations.filter(
    (o) => (prev.reopenedAt === null || o.at > prev.reopenedAt) && now - o.at <= HOLD_STORM_WINDOW_MS,
  );
  // Group the recent failures by provider+kind (in first-seen order, so the pick is
  // deterministic) and hold about the first pair that has enough distinct roles behind it.
  // undefined providers share one key: an unconfigured fleet is one backend by construction.
  const byProviderKind = new Map<string, { provider: string | undefined; kind: HoldKind; group: HoldObservation[] }>();
  for (const o of recent) {
    const key = `${o.provider ?? ""}\n${o.kind}`;
    const entry = byProviderKind.get(key) ?? { provider: o.provider, kind: o.kind, group: [] };
    if (entry.group.length === 0) byProviderKind.set(key, entry);
    entry.group.push(o);
  }
  let storm: HoldObservation[] = [];
  let kind: HoldKind | null = null;
  let provider: string | undefined;
  for (const entry of byProviderKind.values()) {
    const roles = new Set(entry.group.map((o) => o.role));
    if (roles.size >= HOLD_STORM_ROLES) {
      storm = entry.group;
      kind = entry.kind;
      provider = entry.provider;
      break;
    }
  }
  if (kind === null) return prev;
  const roles = sortedRoles(new Set(storm.map((o) => o.role)));
  // A relapse is per provider AND kind: the same storm re-tripping inside the window
  // escalates, while a different kind — or the same kind at a DIFFERENT provider — after a
  // re-open is a new incident at the base.
  const relapse =
    prev.kind !== null &&
    prev.kind === kind &&
    prev.provider === provider &&
    prev.reopenedAt !== null &&
    now - prev.reopenedAt <= HOLD_RELAPSE_MS;
  const escalation = relapse ? prev.escalation + 1 : 0;
  const retryAfterMs = Math.max(0, ...storm.map((o) => o.at + (o.retryAfterSeconds ?? 0) * 1000 - now));
  const holdMs = Math.min(HOLD_CAP_MS, Math.max(HOLD_BASE_MS * 2 ** escalation, retryAfterMs));
  return { provider, until: now + holdMs, kind, roles, escalation, reopenedAt: prev.reopenedAt };
}
