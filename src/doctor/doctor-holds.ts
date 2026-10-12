import { pausedRoles, pausedRolesUntil, standingFleetPause } from "../fleet/fleet-state.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { parseQuietHours, quietHoursStatus, quietWindowEnd, roleQuietHold } from "../scheduling/quiet-hours.js";
import { humanSeconds, secondsUntil } from "../text/datetime.js";
import { pauseReasonSuffix } from "../text/phrases.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** The standing-hold checks: `pause` (checkPause) and `quiet hours` (checkQuietHours), both
 * read-only reports of deliberate holds on ticking.
 *
 * The `pause` check: names a standing operator pause so doctor does not print "ready to run"
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

/** The `quiet hours` check: names the fleet quiet window and any per-role windows holding now,
 * so doctor does not print "ready to run" over a fleet that starts no tick until the window
 * ends. Read-only: membership comes from the scheduler's own parser and predicate
 * (quietHoursStatus, roleQuietHold), so the verdict cannot disagree with the gate. A fleet
 * window holding is a warn because it stops every loop (the director is exempt); held per-role
 * windows are ok because the operator chose those roles by name. A malformed value reads as
 * unset here — checkInit owns that error. `now` is injected so tests never read the clock. */
export function checkQuietHours(config: TumwaterConfig | undefined, now: Date = new Date()): CheckOutcome {
  const fleet = quietHoursStatus(config?.quietHours, now);
  const perRole = config?.quietHoursPerRole;
  const roleKeys = Object.keys(perRole ?? {}).filter((k) => k !== DIRECTOR_ROLE);
  const held = roleKeys.filter((k) => roleQuietHold(perRole, k, now)).sort();
  const anyRoleWindow = roleKeys.some((k) => {
    const parsed = parseQuietHours(perRole?.[k]);
    return parsed.ok && parsed.window !== null;
  });
  const phrases: string[] = [];
  if (fleet.window !== null) {
    phrases.push(
      fleet.inWindow
        ? `quiet now (${fleet.window}) — no role loop starts a tick until ${quietWindowEnd(fleet.window)}; the director is exempt`
        : `${fleet.window} (not in the window now)`,
    );
  }
  if (held.length > 0) {
    phrases.push(`quiet loops: ${held.map((k) => `${k} until ${quietWindowEnd(String(perRole?.[k]))}`).join(", ")}`);
  } else if (anyRoleWindow) {
    phrases.push("per-role windows set, none holding now");
  }
  if (phrases.length === 0) return okOutcome("none configured");
  const detail = phrases.join("; ");
  return fleet.inWindow ? warnOutcome(detail) : okOutcome(detail);
}
