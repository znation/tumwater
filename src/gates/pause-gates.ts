/** The operator pause (`tumwater pause`) and the per-role pause (`tumwater pause --role <id>`), as
 * the orchestrator polls them each cycle. Extracted from orchestrator.ts's poll loop: the marker
 * reads, the edge-triggered pause/resume events, and the cross-poll bookkeeping are one concern
 * beside the other team gates (src/budget/budget.ts's budget gate, src/team/team-hold.ts's team
 * hold) — the orchestrator owns only the wiring. */

import { standingRolePause, standingTeamPause } from "../team/team-state.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";

/** The previous poll's pause state, so each pause/resume crossing logs exactly one event
 * instead of once per ~2s poll. In memory only: a restart mid-pause logs one event on the
 * first poll after it, and the marker keeps gating regardless. The previous poll's deadlines
 * (`prevTeamUntil`, `prevRolesUntil`) let a resume say its timed pause ran out (`expired`); a
 * restart mid-pause starts them undefined, so a resume on its first crossing is never marked
 * expired. */
export interface PauseGateState {
  prevUserPaused: boolean;
  prevPausedRoles: Set<string>;
  prevTeamUntil?: number;
  prevRolesUntil?: number;
}

/** A fresh poll's pause state: the operator pause (presence of the marker file — pausing
 * before startup starts an already-paused team, removing the marker mid-run unblocks roles
 * on their next eligibility without a restart) and the per-role pause's set. */
interface PauseGates {
  userPaused: boolean;
  pausedRoles: Set<string>;
}

/** A fresh pause-gate state: nothing seen paused yet, so the first poll of an unpaused team
 * logs nothing. */
export function newPauseGateState(): PauseGateState {
  return { prevUserPaused: false, prevPausedRoles: new Set() };
}

/** Operator pause (`tumwater pause`): the budget gate's sibling with a different trigger —
 * human intent instead of spend. The marker is persistent state (presence means paused until
 * `resume` removes it), so one existsSync per cycle reads it fresh. The director is exempt for
 * the same reason as under the budget gate — a human typing prompts outranks an operator gate
 * (queued prompts simply wait in the inbox if full silence is wanted). In-flight runs finish;
 * only NEW runs are blocked, because the gate sits before isEligible.
 *
 * Per-role pause (`tumwater pause --role <id>`): the operator pause's narrower sibling — the
 * same persistent marker read fresh per cycle, but one named role instead of the team. Unlike
 * the team pause the director is NOT exempt: the operator named the role deliberately, and its
 * queued prompts simply wait in the inbox (the same effect the team pause has on the director).
 * In-flight runs finish; only NEW runs are blocked (the gate sits before isEligible).
 * A timed role pause's `role_paused` events carry its shared deadline as `until`:
 * `standingRolePause` returns it only while the set is non-empty and an expired marker reads as
 * empty, so a logged `until` is the live deadline. */
export function pollPauseGates(root: string, state: PauseGateState): PauseGates {
  const marker = standingTeamPause(root);
  const userPaused = marker !== null;
  if (userPaused !== state.prevUserPaused) {
    logEventBestEffort(
      root,
      marker
        ? {
            source: TUMWATER_SOURCE,
            type: "team_paused",
            ...(marker.until !== undefined ? { until: marker.until } : {}),
            ...(marker.reason ? { reason: marker.reason } : {}),
          }
        : {
            source: TUMWATER_SOURCE,
            type: "team_resumed",
            ...(state.prevTeamUntil !== undefined && state.prevTeamUntil <= Date.now() ? { expired: true } : {}),
          },
    );
    state.prevUserPaused = userPaused;
  }
  state.prevTeamUntil = marker?.until;
  const { roles: pausedRolesNow, until: rolesUntil } = standingRolePause(root);
  const rolesExpired = state.prevRolesUntil !== undefined && state.prevRolesUntil <= Date.now();
  const pausedRolesSet = new Set(pausedRolesNow);
  for (const r of pausedRolesNow)
    if (!state.prevPausedRoles.has(r))
      logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "role_paused", role: r, ...(rolesUntil !== undefined ? { until: rolesUntil } : {}) });
  for (const r of state.prevPausedRoles)
    if (!pausedRolesSet.has(r))
      logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "role_resumed", role: r, ...(rolesExpired ? { expired: true } : {}) });
  state.prevPausedRoles = pausedRolesSet;
  state.prevRolesUntil = rolesUntil;
  return { userPaused, pausedRoles: pausedRolesSet };
}
