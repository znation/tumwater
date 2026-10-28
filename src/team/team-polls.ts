import { errorStorm, errorStormKnob, type ErrorStorm } from "./team-error-storm.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { teamHold, TEAM_OPEN, type TeamHold, type HoldObservation } from "./team-hold.js";
import { claudeWindowUsedUp, type ClaudeAccount } from "../agent/claude/claude-account.js";
import { sortedRoles } from "../failure/failure-cluster.js";
import { FAILURE_SPREAD_WINDOW_MS, failureSpread, type FailureSpread } from "./team-failure-spread.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { BackendFailureKind } from "../pi/pi.js";
import { groupBy } from "../collections.js";

/** The orchestrator's three team-health polls — the wiring half of the team-wide failure
 * alarms (src/team/team-hold.ts, src/team/team-error-storm.ts,
 * src/team/team-failure-spread.ts): each poll gathers
 * the observations its alarm's pure reducer steps with, steps it, and logs exactly one event
 * per episode crossing, so the alarm modules stay unit-testable without a team and these
 * own the only event emission. Split out of run-timing.ts — which had grown from the
 * orchestrator's timing/scheduling seams into also carrying this polling family — so the
 * timing seams read as timing again and the team-health polls read as one family. */

/** A runner as the hold poll reads it: the role, its two episodic observations, both
 * optional (a runner with neither simply contributes nothing), and the provider its runs
 * resolve to (the run's resolved config — configForRole; undefined when pi's own default
 * is in charge). Structural, so tests stand in plain objects for the runner — its real
 * getters are readonly, and only these fields are ever read. */
export interface HoldInputs {
  role: string;
  provider?: string;
  lastRateLimit?: { at: number; retryAfterSeconds?: number; provider?: string };
  lastBackendFailure?: { at: number; kind: BackendFailureKind; provider?: string };
}

/** The HoldObservation list both team-wide failure polls step their reducer with, gathered
 * from each runner's two episodic fields: lastRateLimit (stamped "rate-limit", carrying the
 * server's retry-after when present) and lastBackendFailure. One copy of that flatMap so the
 * two polls' observation sets cannot drift on shape or fields — the spread reads the same two
 * fields the hold reads (its poll's own words), it simply does not use retry-after. */
function holdObservations(runners: readonly HoldInputs[]): HoldObservation[] {
  return runners.flatMap((r) => [
    // Each stamp is filed under the backend that ACTUALLY failed (its own provider, the
    // failing run's seam hold key — PLANS.md "Mixed claude + pi fleets, part 2/4"), falling
    // back to the runner's own provider when the stamp carries none (a pre-part-2/4 stamp, or
    // an unconfigured pi-default seam): a 429 storm on a claude reviewer must hold `claude`,
    // not the pi author's provider it folded through.
    ...(r.lastRateLimit
      ? [{ role: r.role, provider: r.lastRateLimit.provider ?? r.provider, kind: "rate-limit" as const, at: r.lastRateLimit.at, retryAfterSeconds: r.lastRateLimit.retryAfterSeconds }]
      : []),
    ...(r.lastBackendFailure
      ? [{ role: r.role, provider: r.lastBackendFailure.provider ?? r.provider, kind: r.lastBackendFailure.kind, at: r.lastBackendFailure.at }]
      : []),
  ]);
}

/** The holds map's per-provider team-wide failure hold poll. One hold per provider: each
 * provider's own hold steps with ONLY its own providers' observations — the reducer's
 * provider+kind grouping made per-provider stepping equivalent to grouping there — so a
 * 429 storm at the reviewer's provider holds the roles on that provider while roles on a
 * healthy one keep running (PLANS.md 2026-10-05). A provider whose hold re-opened STAYS in
 * the map — its kind, provider, relapse count, and re-open time are the memory the next
 * storm's relapse test needs — so "held" is always read through team/team-hold.ts's
 * heldProviders() (until non-null), never bare key presence: a lifted hold must never
 * keep blocking. Events carry the provider when one is configured (an undefined provider
 * — pi's default — omits it, so an unconfigured team's events render exactly as before).
 * `observations` is the per-subscription-backend hold
 * observations (one per backend in use), each stamped by the caller from its account via
 * windowObservation. The gate no longer passes them (Subtract part 5u/6), but the seam stays
 * for the doctor's read and the unit tests. Returns the new map for the caller to keep.
 * Exported as a unit-test seam, like its sibling polls below. */
export function pollTeamHold(
  root: string,
  prev: ReadonlyMap<string | undefined, TeamHold>,
  runners: readonly HoldInputs[],
  now: number,
  observations: readonly HoldObservation[] = [],
): Map<string | undefined, TeamHold> {
  const steps = [...holdObservations(runners), ...observations];
  const byProvider = groupBy(steps, (o) => o.provider);
  const next = new Map<string | undefined, TeamHold>();
  // Every provider the map already knows, plus every provider this poll observed: a hold
  // standing with no fresh observations still re-opens at its own deadline (its event),
  // and an open provider with no observations just passes through unchanged.
  for (const provider of new Set([...prev.keys(), ...byProvider.keys()])) {
    const pPrev = prev.get(provider) ?? { ...TEAM_OPEN, provider };
    const pNext = teamHold(pPrev, byProvider.get(provider) ?? [], now);
    next.set(provider, pNext);
    const providerFields = provider === undefined ? {} : { provider };
    // The subscription-window observation (if any) for THIS provider: the window that opened
    // (or would open) its hold, whose window type the limited event names. The events' backend
    // is the provider itself (a subscription-window hold always carries a string provider — a
    // rejected window or reserve crossing never keys the undefined-pi default) — the reset, in
    // particular, fires after the window's observation has already gone (the account flipped to
    // reset), so it cannot read its backend back from a still-present observation.
    const subObs = byProvider.get(provider)?.find((o) => o.kind === "subscription-window");
    const limitedEvent = (): void => {
      // The subscription window's own crossing event, once per rejected window rather than
      // once per failure storm. It names the window type and the deadline the hold lifts at.
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "subscription_window_limited",
        backend: provider!,
        ...providerFields,
        windowType: subObs?.windowType,
        resetsAt: pNext.until,
      });
    };
    if (
      pPrev.until !== null && pPrev.kind === "subscription-window" && pPrev.reserve === true &&
      pNext.until !== null && pNext.kind === "subscription-window" && pNext.reserve !== true
    ) {
      // A reserve hold hardened into a rejected window: the operator hears the limit now.
      limitedEvent();
    } else if (pPrev.until === null && pNext.until !== null) {
      if (pNext.kind === "subscription-window" && pNext.reserve === true) {
        // A reserve crossing logs nothing here; the reserve event loop was removed (5u/6).
      } else if (pNext.kind === "subscription-window") {
        limitedEvent();
      } else {
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "rate_limit_hold",
          ...providerFields,
          kind: pNext.kind,
          roles: pNext.roles,
          holdMs: pNext.until - now,
          escalation: pNext.escalation,
        });
      }
    } else if (pPrev.until !== null && pNext.until === null) {
      if (pNext.kind === "subscription-window") {
        logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "subscription_window_reset", backend: provider!, ...providerFields });
      } else {
        // The ended hold's kind rides the resumed event: the hold's own event names its kind, so
        // the lift must be able to name what actually ended too — "429 hold lifted" after a
        // connection-error hold is the same lie the hold line's kind split removed
        // (BUGS.md 2026-09-29).
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "rate_limit_resumed",
          ...providerFields,
          kind: pNext.kind,
        });
      }
    }
  }
  return next;
}

/** The hold observation one subscription account's usage windows imply, or null: a window
 * reading `rejected` with no overage and a future `resetsAt` holds every seam on provider
 * `backend` until the last such deadline — the account-level throttle of plans/agent-backends.md
 * §8. Only subscription billing produces one: an API-billed run's windows never hold (the plan's
 * "API claude seams run"), and a missing account file reads exactly as today's behavior. The
 * reader has already flipped a past-`resetsAt` window to `reset`, and the `resetsAt > now` guard
 * here lets the hold lift on its own even from a stale file. */
export function windowObservation(
  backend: string,
  account: ClaudeAccount | null,
  now: number,
  reserve?: Record<string, number>,
): HoldObservation | null {
  const furthest = claudeWindowUsedUp(account, now, false, reserve);
  if (furthest === null) return null;
  return {
    role: backend,
    provider: backend,
    kind: "subscription-window",
    at: now,
    windowType: furthest.type,
    resetsAt: furthest.resetsAt,
    ...(furthest.reserve === true ? { reserve: true as const } : {}),
  };
}

/** One poll of the team-wide error-storm warning (src/team/team-error-storm.ts): gather each
 * runner's current error streak (RunnerState.consecutiveErrors/lastError — the same fields the
 * per-role "consecutive run failures" warning reads, the director's included, since its failures
 * are the team's evidence too), step the pure reducer, and log exactly one warning per episode,
 * like the per-role warning's once-per-streak-crossing shape: on the quiet→storm crossing,
 * naming the roles, the shared normalized cause, and the config knob when the cause has one (a
 * team timing out together means runTimeoutSeconds does not fit the serving model). Storms clear
 * silently — the members' own recoveries already tell that story — and the reducer's `prev`
 * pass-through keeps a held storm event-free. Returns the new storm for the
 * caller to keep. Exported as a unit-test seam, like pollTeamHold above. */
export function pollErrorStorm(
  root: string,
  prev: ErrorStorm,
  runners: readonly { role: string; state: Pick<RunnerState, "consecutiveErrors" | "lastError"> }[],
): ErrorStorm {
  const observations = runners.map((r) => ({
    role: r.role,
    consecutiveErrors: r.state.consecutiveErrors ?? 0,
    lastError: r.state.lastError,
  }));
  const next = errorStorm(prev, observations);
  if (next.key !== null && next.key !== prev.key) {
    const knob = errorStormKnob(next.key);
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "warning",
      message:
        `error storm — ${next.roles.length} roles failing consecutively on one shared cause ` +
        `(${next.key})${knob ? ` — ${knob} likely does not fit the serving model` : ""}: ` +
        next.roles.join(", "),
      roles: next.roles,
      cause: next.key,
      ...(knob ? { knob } : {}),
    });
  }
  return next;
}

/** One poll of the team-wide wide-shallow storm alarm (src/team/team-failure-spread.ts): gather
 * each runner's latest provider-failure observations — the same two the team hold reads, the
 * director's included, since its failures are the team's evidence too — step the pure reducer,
 * and log exactly one warning per episode: on the quiet→active crossing (and again when a
 * DIFFERENT kind becomes the episode while one is sounding, the reducer's new-episode rule),
 * naming the failure count, the kind, the window, and the roles behind it. The wiring keys its
 * log off active/kind, not object identity — `recent` moves almost every poll, so unlike the
 * hold's poll there is no prev pass-through to compare. Exported as a unit-test seam, like
 * pollTeamHold above. */
export function pollFailureSpread(
  root: string,
  prev: FailureSpread,
  runners: readonly HoldInputs[],
  now: number,
): FailureSpread {
  const observations = holdObservations(runners);
  const next = failureSpread(prev, observations, now);
  if (next.active && (!prev.active || next.kind !== prev.kind)) {
    const episode = next.recent.filter((o) => o.kind === next.kind);
    const roles = sortedRoles(new Set(episode.map((o) => o.role)));
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "warning",
      message:
        `failure spread — ${episode.length} provider failures of one kind (${next.kind}) within ` +
        `${Math.round(FAILURE_SPREAD_WINDOW_MS / 60_000)} min across ${roles.length} roles ` +
        `(wide-shallow storm: no role's streak and no close coincidence explains it) — ` +
        roles.join(", "),
      kind: next.kind,
      roles,
      windowMs: FAILURE_SPREAD_WINDOW_MS,
      count: episode.length,
    });
  }
  return next;
}
