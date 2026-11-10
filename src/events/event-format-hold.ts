import type { HarnessEvent } from "./events.js";
import { budgetPhrase, teamPausePhrase, teamResumePhrase, rolePausePhrase, roleResumePhrase, PAUSE_EXPIRED_SUFFIX } from "../text/phrases.js";
import { isNonBlankString, squash, textOr } from "../text/text.js";
import { pauseSuffix } from "./event-format-fragments.js";

/** The team-and-role pause/resume lines: team_paused and team_resumed, then the
 * per-role pair. A pause names its until/reason suffix and who keeps running;
 * a resumed line appends the expired-pause suffix when the pause timed out. */

function pauseResumeEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "team_paused":
      // Routine state change, like counters_reset — no warning prefix.
      return `${teamPausePhrase()}${pauseSuffix(e.until, e.reason)} (director keeps running)`;
    case "team_resumed":
      return teamResumePhrase() + (e.expired === true ? PAUSE_EXPIRED_SUFFIX : "");
    case "role_paused":
      // Routine state change, like team_paused — no warning prefix.
      return `${rolePausePhrase(textOr(e.role))}${pauseSuffix(e.until, undefined)} (the rest of the team keeps running)`;
    case "role_resumed":
      return roleResumePhrase(textOr(e.role)) + (e.expired === true ? PAUSE_EXPIRED_SUFFIX : "");
    default: return textOr(e.type);
  }
}

/** The repeated-failure pause line: a role that failed N runs in a row is paused;
 * the line names the streak depth, the last error when one is recorded, and the
 * lift command. */

function roleFailureEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "role_streak_paused":
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: the pause IS the
      // harness handling the failure. Names the streak depth and the lift command, so the
      // operator knows why the role stopped and what to do about it; names the last error
      // when one is recorded.
      return `role ${textOr(e.role)} paused — ${textOr(e.streak)} runs failed in a row${isNonBlankString(e.lastError) ? ` — last error: ${squash(e.lastError, 120)}` : ""}; fix the cause and resume it (tumwater resume --role <id>)`;
    default: return textOr(e.type);
  }
}

/** The per-role cap lines: role_cap_warning is the early page beside role_cap_paused
 * (the spent-cap pause), and role_cap_resumed its lift; each names the spend against
 * the role's own cap and the lift paths. */

function roleCapEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "role_cap_warning":
      // The per-role early page beside role_cap_paused: the cap is not reached yet, so say so —
      // the operator still has room to raise it before the role stops.
      return `role ${textOr(e.role)} at ${budgetPhrase(e.spentUsd, e.capUsd)} of its daily cap — it keeps running; raise or remove the cap in tumwater.json before it pauses`;
    case "role_cap_paused":
      // Routine state change, like budget_paused — no warning prefix: the pause IS the harness
      // holding the role's own spend line. Names the role, its spend vs its cap, and the two
      // lift paths, so the operator knows why the role stopped and what to do about it.
      return `role ${textOr(e.role)} paused — ${budgetPhrase(e.spentUsd, e.capUsd)} of its daily cap spent; it starts no new runs until the cap is raised or removed in tumwater.json or the local day rolls over`;
    case "role_cap_resumed":
      return `role ${textOr(e.role)} resumed — it is under its daily cap again and runs again`;
    default: return textOr(e.type);
  }
}

/** The maintenance-admission lines: the maintenance-allowance hold and its reopen
 * (each naming the window's maintenance/work counts) and bootstrap_complete, the
 * team's bootstrap finishing and the maintenance roles being admitted. */

function maintenanceAdmissionEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "maintenance_quota_hold":
      // Routine state change, like role_cap_paused — no warning prefix: the hold IS the harness
      // keeping maintenance merges in proportion to work. Names the window's counts so the
      // operator can see why the hygiene roles stopped and what would re-open them.
      return `waiting: maintenance allowance used — ${textOr(e.maint)} maintenance merges against an allowance of ${textOr(e.allowance)} in the last 24h (${textOr(e.work)} work); the maintenance roles wait until the window rolls over`;
    case "maintenance_quota_resumed":
      return `maintenance allowance reopened — ${textOr(e.maint)} maintenance merges against an allowance of ${textOr(e.allowance)} in the last 24h; the maintenance roles run again`;
    case "bootstrap_complete":
      // Routine state change, like counters_reset — no warning prefix: the team just finished
      // its bootstrap and the maintenance roles are admitted.
      return `bootstrap complete — ${textOr(e.plansDone)}/${textOr(e.untilPlansDone)} plans done; the maintenance roles now run`;
    default: return textOr(e.type);
  }
}

export function holdEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "team_paused":
      return pauseResumeEventMessage(e);
    case "team_resumed":
      return pauseResumeEventMessage(e);
    case "role_paused":
      return pauseResumeEventMessage(e);
    case "role_resumed":
      return pauseResumeEventMessage(e);
    case "role_streak_paused":
      return roleFailureEventMessage(e);
    case "role_cap_warning":
      return roleCapEventMessage(e);
    case "role_cap_paused":
      return roleCapEventMessage(e);
    case "role_cap_resumed":
      return roleCapEventMessage(e);
    case "maintenance_quota_hold":
      return maintenanceAdmissionEventMessage(e);
    case "maintenance_quota_resumed":
      return maintenanceAdmissionEventMessage(e);
    case "bootstrap_complete":
      return maintenanceAdmissionEventMessage(e);
    default: return textOr(e.type);
  }
}
