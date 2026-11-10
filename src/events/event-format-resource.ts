import type { HarnessEvent } from "./events.js";
import { backendKindPhrase, holdPhrase, rolesPhrase, rendersAsBackendFailure } from "../text/phrases.js";
import { textOr } from "../text/text.js";
import { isJsonObject, stringList } from "../files/json-object.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { gigabytes, windowResetPhrase, windowSuffix, providerAt, providerScope, backendLabel, subscriptionWindowPhrase } from "./event-format-fragments.js";

/** A model_check_passed event's failed-probe count, as a suffix: none for a torn or zero
 * count, else " after N failed checks". */
function modelCheckFailuresSuffix(failures: unknown): string {
  return typeof failures === "number" && failures > 0
    ? ` after ${failures} failed ${failures === 1 ? "check" : "checks"}`
    : "";
}

/** The disk-floor pair and the reclaim pass: disk_low names the free space and the floor,
 * disk_ok the recovery, disk_reclaim the mode, the worktrees it freed from, and the free
 * space now. */
function diskEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "disk_low":
      // Routine state change, like team_paused — no warning prefix: the hold IS the harness
      // handling the low disk, and naming the free space and the floor tells the operator
      // whether to clear space or lower diskHoldGB in tumwater.json.
      return `waiting: low disk — ${gigabytes(e.freeGB)} free on the workspaces volume (floor ${gigabytes(e.holdGB)}); new work waits until space recovers`;
    case "disk_ok":
      return `disk recovered — ${gigabytes(e.freeGB)} free on the workspaces volume; new work starts again`;
    case "disk_reclaim": {
      // Routine maintenance, no warning prefix: the pass freed space so the hold need not
      // engage. Naming the mode, the worktrees, and the delta tells the operator what and why.
      const names = stringList(e.worktrees);
      const from = names.length > 0 ? names.join(", ") : "?";
      return `disk reclaim (${textOr(e.mode, "pressure")}) — freed ${gigabytes(e.freedGB)} from ${from}; ${gigabytes(e.freeGB)} free now`;
    }
    default: return textOr(e.type);
  }
}

/** The quiet-hours pair, sharing the window suffix: what stops while the window is set and
 * what the window's end re-opens. */
function quietHoursEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "quiet_hours_started": {
      // Routine hold, like disk_low — no warning prefix: the window is configured, and the line
      // says what stops and what keeps running. pollQuietHoursGate may send no window.
      return `waiting: quiet hours${windowSuffix(e)} — roles start no new runs until the window ends; the director still runs`;
    }
    case "quiet_hours_ended": {
      return `quiet hours ended${windowSuffix(e)} — roles start runs again`;
    }
    default: return textOr(e.type);
  }
}

/** The rate-limit hold and its lift: each names the backend-failure kind itself, since "429"
 * would be a lie about a connection error, and the provider-limit kind otherwise. */
function rateLimitEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "rate_limit_hold": {
      // Routine state change, like team_paused — no warning prefix: the hold IS the harness
      // handling the storm. Names who saw the failure and when the team re-opens on its own.
      // The rate-limit kind keeps the wording every historical event has; a backend-failure
      // kind names itself instead, since "429" would be a lie about a connection error.
      const roles = rolesPhrase(e.roles, "several roles");
      if (rendersAsBackendFailure(e.kind))
        return `waiting: backend failing (${backendKindPhrase(e.kind)})${providerAt(e)} — ${roles} hit backend failures; roles on ${providerScope(e)} start no new runs ${holdPhrase(e.holdMs, e.escalation)} (director keeps running)`;
      return `waiting: provider limit${providerAt(e)} — ${roles} rate-limited by the provider; roles on ${providerScope(e)} start no new runs ${holdPhrase(e.holdMs, e.escalation)} (director keeps running)`;
    }
    case "rate_limit_resumed": {
      // The ended hold's kind rides the resumed event (pollTeamHold logs it), so the lift
      // names what actually ended — the same split as the hold line above: "429 hold lifted"
      // after a connection-error hold would be a lie about a connection error.
      if (rendersAsBackendFailure(e.kind))
        return `backend recovered (${backendKindPhrase(e.kind)})${providerAt(e)} — roles on ${providerScope(e)} run again`;
      return `provider limit lifted${providerAt(e)} — roles on ${providerScope(e)} run again`;
    }
    default: return textOr(e.type);
  }
}

/** The subscription-window limited/reset pair: the limited line moves each tier's model jobs
 * to its fallback backend when one is configured, and has them wait otherwise. */
function subscriptionWindowEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "subscription_window_limited":
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: waiting is the
      // harness handling the account's own throttle. Names the window, the reset, and which
      // seams stop, so the operator knows why the backend held and what keeps running.
      // With a fallback the work moves rather than waits: `tiers` names where each moved tier's
      // work went (the budget poll's window move), the director and any tier with no fallback
      // still wait.
      {
        const moved = fallbackTierEntries(isJsonObject(e.tiers) ? e.tiers : undefined);
        if (moved.length > 0)
          return `${subscriptionWindowPhrase(e)} rejected — ${backendLabel(e)} model jobs move to ${moved.join(", ")}${windowResetPhrase(e)} (director keeps waiting)`;
      }
      return `waiting: ${subscriptionWindowPhrase(e)} rejected — ${backendLabel(e)} model jobs wait${windowResetPhrase(e)} (director keeps running)`;
    case "subscription_window_reset":
      return `${backendLabel(e)} subscription window reset — ${backendLabel(e)} model jobs run again`;
    default: return textOr(e.type);
  }
}

function modelCheckPassedMessage(e: HarnessEvent): string {
  // The lift of a model-check hold, like rate_limit_resumed — no warning prefix: the failed
  // check's own warning named the fault, and this names the pair that recovered.
  return `model check passed: ${textOr(e.pair)} answers again${modelCheckFailuresSuffix(e.failures)} — its roles run again`;
}

export function resourceEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "disk_low":
      return diskEventMessage(e);
    case "disk_ok":
      return diskEventMessage(e);
    case "disk_reclaim":
      return diskEventMessage(e);
    case "quiet_hours_started":
      return quietHoursEventMessage(e);
    case "quiet_hours_ended":
      return quietHoursEventMessage(e);
    case "rate_limit_hold":
      return rateLimitEventMessage(e);
    case "rate_limit_resumed":
      return rateLimitEventMessage(e);
    case "subscription_window_limited":
      return subscriptionWindowEventMessage(e);
    case "subscription_window_reset":
      return subscriptionWindowEventMessage(e);
    case "model_check_passed":
      return modelCheckPassedMessage(e);
    default: return textOr(e.type);
  }
}
