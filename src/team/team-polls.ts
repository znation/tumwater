import { errorStorm, errorStormKnob, type ErrorStorm } from "./error-storm.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { teamHold, TEAM_OPEN, type TeamHold, type HoldObservation } from "./team-hold.js";
import { claudeWindowUsedUp, windowReserved, type ClaudeAccount, type ClaudeWindow } from "../agent/claude/claude-account.js";
import type { HarnessEventInput } from "../events/events.js";
import { sortedRoles } from "../failure/failure-cluster.js";
import { FAILURE_SPREAD_WINDOW_MS, failureSpread, type FailureSpread } from "./failure-spread.js";
import type { LoopState } from "../loop/loop-state.js";
import type { ModelTier } from "../config/config-schema.js";
import type { BackendFailureKind } from "../pi/pi.js";
import { groupBy } from "../collections.js";

/** The orchestrator's three team-health polls — the wiring half of the team-wide failure
 * alarms (src/team/team-hold.ts, src/team/error-storm.ts,
 * src/team/failure-spread.ts): each poll gathers
 * the observations its alarm's pure reducer steps with, steps it, and logs exactly one event
 * per episode crossing, so the alarm modules stay unit-testable without a team and these
 * own the only event emission. Split out of tick-timing.ts — which had grown from the
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
 * healthy one keep ticking (PLANS.md 2026-10-05). A provider whose hold re-opened STAYS in
 * the map — its kind, provider, relapse count, and re-open time are the memory the next
 * storm's relapse test needs — so "held" is always read through team/team-hold.ts's
 * heldProviders() (until non-null), never bare key presence: a lifted hold must never
 * keep blocking. Events carry the provider when one is configured (an undefined provider
 * — pi's default — omits it, so an unconfigured team's events render exactly as before).
 * `windowTiers` is the budget poll's window move (tier → the pair its work went to), stamped on
 * the subscription window's limited event; `reserve` is the config's `claudeWindowReserve`, whose
 * crossings hold like a rejected window (but never the director) and log
 * pollClaudeWindowReserve's event instead of the limited one. Returns the new map for the
 * caller to keep. Exported as a unit-test seam, like its sibling polls below. */
export function pollTeamHold(
  root: string,
  prev: ReadonlyMap<string | undefined, TeamHold>,
  runners: readonly HoldInputs[],
  now: number,
  account: ClaudeAccount | null = null,
  windowTiers: Partial<Record<ModelTier, string>> = {},
  reserve?: Record<string, number>,
): Map<string | undefined, TeamHold> {
  const window = claudeWindowObservation(account, now, reserve);
  const observations = window === null ? holdObservations(runners) : [...holdObservations(runners), window];
  const byProvider = groupBy(observations, (o) => o.provider);
  const next = new Map<string | undefined, TeamHold>();
  // Every provider the map already knows, plus every provider this poll observed: a hold
  // standing with no fresh observations still re-opens at its own deadline (its event),
  // and an open provider with no observations just passes through unchanged.
  for (const provider of new Set([...prev.keys(), ...byProvider.keys()])) {
    const pPrev = prev.get(provider) ?? { ...TEAM_OPEN, provider };
    const pNext = teamHold(pPrev, byProvider.get(provider) ?? [], now);
    next.set(provider, pNext);
    const providerFields = provider === undefined ? {} : { provider };
    const limitedEvent = (): void => {
      // The subscription window's own crossing event, once per rejected window rather than
      // once per failure storm. It names the window type and the deadline the hold lifts at.
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "claude_window_limited",
        ...providerFields,
        windowType: window?.windowType,
        resetsAt: pNext.until,
        // Where each moved tier's work went (the budget poll's window move); absent when
        // nothing moved, so a no-fallback team's event is today's.
        ...(Object.keys(windowTiers).length > 0 ? { tiers: windowTiers } : {}),
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
        // A reserve crossing logs claude_window_reserved (pollClaudeWindowReserve), not this.
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
        logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "claude_window_reset", ...providerFields });
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
 * `claude` until the last such deadline — the account-level throttle of plans/agent-backends.md
 * §8. Only subscription billing produces one: an API-billed run's windows never hold (the plan's
 * "API claude seams tick"), and a missing account file reads exactly as today's behavior. The
 * reader has already flipped a past-`resetsAt` window to `reset`, and the `resetsAt > now` guard
 * here lets the hold lift on its own even from a stale file. */
export function claudeWindowObservation(
  account: ClaudeAccount | null,
  now: number,
  reserve?: Record<string, number>,
): HoldObservation | null {
  const furthest = claudeWindowUsedUp(account, now, false, reserve);
  if (furthest === null) return null;
  return {
    role: "claude",
    provider: "claude",
    kind: "subscription-window",
    at: now,
    windowType: furthest.type,
    resetsAt: furthest.resetsAt,
    ...(furthest.reserve === true ? { reserve: true as const } : {}),
  };
}

/** Log at most one subscription-window event per window key. The reserve and the warning polls
 * (below) both walk the account's windows for the first one that crosses its mark this poll and
 * log exactly one event for it, deduplicated by the `type:resetsAt` key so many polls across one
 * window log once (a later window's crossing is its own key). They differ only in WHICH window
 * marks (the reserve fraction vs the `allowed_warning` status) and the event's payload, so the
 * shared traversal, the "reset instant already past" skip, the key build, the key dedup, and the
 * return-key contract live here and each caller supplies the mark-and-payload predicate
 * (`eventFor` returns the event to log, or null to skip that window). */
function logWindowEventOnce(
  root: string,
  prevKey: string | null,
  account: ClaudeAccount | null,
  now: number,
  eventFor: (type: string, w: ClaudeWindow) => HarnessEventInput | null,
): string | null {
  if (account?.billing !== "subscription") return prevKey;
  for (const [type, w] of Object.entries(account.windows)) {
    const ev = eventFor(type, w);
    if (ev === null) continue;
    // A window whose reset instant is in the past (or unreadable) no longer marks a crossing.
    if (typeof w.resetsAt === "number" && w.resetsAt <= now) continue;
    const key = `${type}:${w.resetsAt ?? ""}`;
    if (key === prevKey) return prevKey;
    logEventBestEffort(root, ev);
    return key;
  }
  return prevKey;
}

/** One poll of the reserve crossing: the first window at or past its `claudeWindowReserve`
 * fraction logs `claude_window_reserved` once; `prevKey` is the `type:resetsAt` it was logged
 * for, the same once-per-window memory as pollClaudeWindowWarning. Returns the key to keep. */
export function pollClaudeWindowReserve(
  root: string,
  prevKey: string | null,
  account: ClaudeAccount | null,
  now: number,
  reserve: Record<string, number> | undefined,
): string | null {
  if (reserve === undefined) return prevKey;
  return logWindowEventOnce(root, prevKey, account, now, (type, w) => {
    const fraction = reserve[type];
    if (!windowReserved(w, fraction) || typeof w.resetsAt !== "number") return null;
    return {
      source: TUMWATER_SOURCE,
      type: "claude_window_reserved",
      windowType: type,
      utilization: w.utilization,
      reserve: fraction,
      resetsAt: w.resetsAt,
    };
  });
}

/** One poll of the subscription-window warning: the first `allowed_warning` window logs
 * `claude_window_warning` once, and `prevWarnedKey` is the window key (`type:resetsAt`) it was
 * logged for, so many polls across one window warn once while a later window's warning is its
 * own crossing. Returns the key to keep; null before any warning and until the first. */
export function pollClaudeWindowWarning(
  root: string,
  prevWarnedKey: string | null,
  account: ClaudeAccount | null,
  now: number,
): string | null {
  return logWindowEventOnce(root, prevWarnedKey, account, now, (type, w) => {
    if (w.status !== "allowed_warning") return null;
    return {
      source: TUMWATER_SOURCE,
      type: "claude_window_warning",
      windowType: type,
      ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}),
    };
  });
}

/** One poll of the team-wide error-storm warning (src/team/error-storm.ts): gather each runner's
 * current error streak (LoopState.consecutiveErrors/lastError — the same fields the per-role
 * "consecutive tick failures" warning reads, the director's included, since its failures are
 * the team's evidence too), step the pure reducer, and log exactly one warning per episode,
 * like the per-role warning's once-per-streak-crossing shape: on the quiet→storm crossing,
 * naming the roles, the shared normalized cause, and the config knob when the cause has one
 * (a team timing out together means runTimeoutSeconds does not fit the serving model).
 * Storms clear silently — the members' own recoveries already tell that story — and the
 * reducer's `prev` pass-through keeps a held storm event-free. Returns the new storm for the
 * caller to keep. Exported as a unit-test seam, like pollTeamHold above. */
export function pollErrorStorm(
  root: string,
  prev: ErrorStorm,
  runners: readonly { role: string; state: Pick<LoopState, "consecutiveErrors" | "lastError"> }[],
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

/** One poll of the team-wide wide-shallow storm alarm (src/team/failure-spread.ts): gather each
 * runner's latest provider-failure observations — the same two the team hold reads, the
 * director's included, since its failures are the team's evidence too — step the pure
 * reducer, and log exactly one warning per episode: on the quiet→active crossing (and again
 * when a DIFFERENT kind becomes the episode while one is sounding, the reducer's new-episode
 * rule), naming the failure count, the kind, the window, and the roles behind it. The wiring
 * keys its log off active/kind, not object identity — `recent` moves almost every poll, so
 * unlike the hold's poll there is no prev pass-through to compare. Exported as a unit-test
 * seam, like pollTeamHold above. */
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
