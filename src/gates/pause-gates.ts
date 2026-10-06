/** The operator pause (`tumwater pause`) and the per-role pause (`tumwater pause --role <id>`),
 * as the orchestrator polls them each cycle. Extracted from orchestrator.ts's poll loop: the
 * marker reads, the edge-triggered pause/resume events, and the cross-poll bookkeeping are one
 * concern beside the other fleet gates (src/budget.ts's budget gate, src/fleet/fleet-hold.ts's
 * fleet hold) — the orchestrator owns only the wiring. */

import { isFleetPaused, pausedRoles } from "../fleet/fleet-state.js";
import { logEvent } from "../events/events.js";

/** The previous poll's pause state, so each pause/resume crossing logs exactly one event
 * instead of once per ~2s poll. In memory only: a restart mid-pause logs one event on the
 * first poll after it, and the marker keeps gating regardless. */
export interface PauseGateState {
  prevUserPaused: boolean;
  prevPausedRoles: Set<string>;
}

/** A fresh poll's pause state: the operator pause (presence of the marker file — pausing
 * before startup starts an already-paused fleet, removing the marker mid-run unblocks roles
 * on their next eligibility without a restart) and the per-role pause's set. */
interface PauseGates {
  userPaused: boolean;
  pausedRoles: Set<string>;
}

/** A fresh pause-gate state: nothing seen paused yet, so the first poll of an unpaused fleet
 * logs nothing. */
export function newPauseGateState(): PauseGateState {
  return { prevUserPaused: false, prevPausedRoles: new Set() };
}

/** Operator pause (`tumwater pause`): the budget gate's sibling with a different trigger —
 * human intent instead of spend. The marker is persistent state (presence means paused until
 * `resume` removes it), so one existsSync per cycle reads it fresh. The director is exempt for
 * the same reason as under the budget gate — a human typing prompts outranks an operator gate
 * (queued prompts simply wait in the inbox if full silence is wanted). In-flight ticks finish;
 * only NEW ticks are blocked, because the gate sits before isEligible.
 *
 * Per-role pause (`tumwater pause --role <id>`): the operator pause's narrower sibling — the
 * same persistent marker read fresh per cycle, but one named loop instead of the fleet. Unlike
 * the fleet pause the director is NOT exempt: the operator named the role deliberately, and its
 * queued prompts simply wait in the inbox (the same effect the fleet pause has on the director).
 * In-flight ticks finish; only NEW ticks are blocked (the gate sits before isEligible). */
export function pollPauseGates(root: string, state: PauseGateState): PauseGates {
  const userPaused = isFleetPaused(root);
  if (userPaused !== state.prevUserPaused) {
    logEvent(root, { loop: "harness", type: userPaused ? "fleet_paused" : "fleet_resumed" });
    state.prevUserPaused = userPaused;
  }
  const pausedRolesNow = pausedRoles(root);
  const pausedRolesSet = new Set(pausedRolesNow);
  for (const r of pausedRolesNow)
    if (!state.prevPausedRoles.has(r)) logEvent(root, { loop: "harness", type: "role_paused", role: r });
  for (const r of state.prevPausedRoles)
    if (!pausedRolesSet.has(r)) logEvent(root, { loop: "harness", type: "role_resumed", role: r });
  state.prevPausedRoles = pausedRolesSet;
  return { userPaused, pausedRoles: pausedRolesSet };
}
