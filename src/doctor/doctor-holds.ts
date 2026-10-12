import { pausedRoles, pausedRolesUntil, standingFleetPause } from "../fleet/fleet-state.js";
import { humanSeconds, secondsUntil } from "../text/datetime.js";
import { pauseReasonSuffix } from "../text/phrases.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** The `pause` check: names a standing operator pause so doctor does not print "ready to run"
 * over a fleet that starts no tick. Read-only: it reads the same fleet and per-role pause
 * markers the scheduler reads (standingFleetPause, pausedRoles, pausedRolesUntil — all treat
 * an expired marker as absent), so its verdict cannot disagree with what the fleet does. A
 * fleet pause is a warn because it stops every loop; paused roles are ok because the operator
 * chose them by name and every other loop keeps ticking. `now` only drives the countdowns. */
export function checkPause(root: string, now: number = Date.now()): CheckOutcome {
  const fleet = standingFleetPause(root);
  const roles = pausedRoles(root);
  let rolesPhrase = "";
  if (roles.length > 0) {
    const until = pausedRolesUntil(root);
    rolesPhrase = `paused loops: ${roles.join(", ")}${until !== undefined ? ` (auto-resume in ${humanSeconds(secondsUntil(until, now))})` : ""}`;
  }
  if (!fleet) return rolesPhrase ? okOutcome(rolesPhrase) : okOutcome("not paused");
  const head =
    fleet.until !== undefined
      ? `fleet paused — auto-resumes in ${humanSeconds(secondsUntil(fleet.until, now))}`
      : "fleet paused — no loop starts a tick until `tumwater resume`";
  return warnOutcome(`${head}${pauseReasonSuffix(fleet.reason)}${rolesPhrase ? `; ${rolesPhrase}` : ""}`);
}
