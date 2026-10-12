import { pausedRoles, pausedRolesUntil, standingFleetPause } from "../fleet/fleet-state.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { commitTier, DIRECTOR_ROLE } from "../roles/roles.js";
import { budgetReached, budgetWarning, fleetDailyCost } from "../budget/budget.js";
import { roleCapVerdicts } from "../gates/role-cap-gates.js";
import { readLandingQueue } from "../landing/landing-queue.js";
import { MAINTENANCE_DAILY_FLOOR } from "../gates/maintenance-quota.js";
import { heldByMainRed, mainCheckForPoll, maintenanceQuotaForPoll } from "../status/status-polls.js";
import { loadLoopState } from "../loop/loop-state.js";
import { baseRoleOf, loopIds } from "../roles/loop-ids.js";
import { ERROR_STREAK_BREAKER, ERROR_STREAK_WARN } from "../tick/tick-apply.js";
import { squash } from "../text/text.js";
import { usd } from "../text/format.js";
import { parseQuietHours, quietHoursStatus, quietWindowEnd, roleQuietHold } from "../scheduling/quiet-hours.js";
import { humanSeconds, secondsUntil } from "../text/datetime.js";
import { budgetPhrase, pauseReasonSuffix, plural } from "../text/phrases.js";
import { claudeWindowEntries, claudeWindowLabel, readClaudeAccount } from "../agent/claude/claude-account.js";
import { claudeWindowObservation } from "../fleet/fleet-polls.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** The standing-hold checks: `pause` (checkPause), `quiet hours` (checkQuietHours), and `budget`
 * (checkBudget), `claude window` (checkClaudeWindow), `maintenance quota` (checkMaintenanceQuota), and
 * `error streaks` (checkErrorStreaks), all read-only reports of holds on ticking.
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

/** The `budget` check: today's fleet spend against `maxDailyCostUsd`, plus base roles over their
 * own `maxDailyCostUsdPerRole` cap. Read-only and built on the scheduler's own definitions
 * (fleetDailyCost, budgetReached, roleCapVerdicts), so the verdict cannot disagree with the gate.
 * `published` is the running scheduler's figure (it includes runs charged since the last save)
 * and wins over the persisted sum, as in status. A reached fleet cap is a warn because role loops
 * run on their tier fallback or hold until local midnight (the `fallback` row says which);
 * per-role caps reached alone are ok because the operator chose them by name. */
export function checkBudget(
  root: string,
  config: TumwaterConfig | undefined,
  published: { spentUsd: number; capUsd: number } | null,
  now: number = Date.now(),
): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const states = loopIds(config).map((id) => loadLoopState(root, id));
  const spent = published?.spentUsd ?? fleetDailyCost(states, now);
  const caps = config.maxDailyCostUsdPerRole;
  const capped = [...roleCapVerdicts(states.map((s) => ({ role: s.role, state: s })), caps, now)]
    .filter(([, v]) => v.over)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([base, v]) => `${base} (${budgetPhrase(v.spentUsd, caps?.[base])})`);
  const cappedPhrase = capped.length > 0 ? `; capped loops: ${capped.join(", ")}` : "";
  const cap = config.maxDailyCostUsd;
  if (!(cap > 0)) return okOutcome(`no daily cap; ${usd(spent)} spent today${cappedPhrase}`);
  const view = { spentUsd: spent, capUsd: cap };
  const phrase = budgetPhrase(spent, cap);
  if (budgetReached(view)) {
    return warnOutcome(
      `daily cap reached — ${phrase} today; role loops run on their tier fallback or hold until local midnight (see the fallback row)${cappedPhrase}`,
    );
  }
  if (budgetWarning(view)) return okOutcome(`${phrase} today — past 80% of the cap${cappedPhrase}`);
  return okOutcome(`${phrase} today${cappedPhrase}`);
}

/** The `maintenance quota` check: rolling-24 h maintenance landings against the allowance
 * (`maintenancePerWorkLanding` per work landing + the daily floor), naming the maintenance loops
 * held when it is full. Read-only and built on the same verdict the scheduler and status use
 * (maintenanceQuotaForPoll). Only a live fleet's running loops and landing queue count as in
 * flight, since a dead fleet's leftover `running` flag and queue drain nothing. A held allowance
 * is a warn because it stops a whole tier. */
export function checkMaintenanceQuota(
  root: string,
  config: TumwaterConfig | undefined,
  aliveFleet: boolean,
  now: number = Date.now(),
): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const loops = loopIds(config)
    .map((id) => loadLoopState(root, id))
    .map((s) => ({ role: s.role, running: aliveFleet && s.running === true }));
  const queued = aliveFleet ? new Set(readLandingQueue(root).entries.map((e) => e.role)) : new Set<string>();
  const { allowance, used, held } = maintenanceQuotaForPoll(root, config.maintenancePerWorkLanding, loops, queued, now);
  if (held.length > 0) {
    return warnOutcome(
      `allowance reached — ${used}/${allowance} maintenance landings in the last 24h; held until the window rolls under: ${[...held].sort().join(", ")}`,
    );
  }
  const base = `${used}/${allowance} maintenance landings in the last 24h (${config.maintenancePerWorkLanding} per work landing + ${MAINTENANCE_DAILY_FLOOR} floor)`;
  const anyMaintenance = loops.some((l) => commitTier(l.role) === "maintenance");
  return okOutcome(anyMaintenance ? base : `${base}; no maintenance loop enabled`);
}

/** The `claude window` check: whether a rejected subscription window holds the subscription claude
 * seams. Read-only and built on claudeWindowObservation, the verdict the scheduler's fleet hold
 * uses, so it cannot disagree with the hold. A hold is a warn because it stops every subscription
 * claude seam until the window resets; otherwise the most constrained window's state is reported
 * as ok (a rejected window spending overage reads `rejected` here: overage spends, it does not
 * hold). API-billed claude never holds. */
export function checkClaudeWindow(root: string, now: number = Date.now()): CheckOutcome {
  const account = readClaudeAccount(root, now);
  if (account?.billing !== "subscription") return okOutcome("no subscription window reported");
  const held = claudeWindowObservation(account, now);
  if (held?.kind === "subscription-window" && held.windowType !== undefined && held.resetsAt !== undefined) {
    return warnOutcome(
      `${claudeWindowLabel(held.windowType)} window rejected — subscription claude seams hold until it resets in ${humanSeconds(secondsUntil(held.resetsAt, now))}`,
    );
  }
  const top = claudeWindowEntries(account)[0];
  if (top === undefined) return okOutcome("subscription; no window reported yet");
  const pct = typeof top.utilization === "number" ? ` (${Math.round(top.utilization * 100)}% used)` : "";
  const label = claudeWindowLabel(top.type);
  return okOutcome(
    top.status === "allowed_warning" ? `${label} window nearing its limit${pct}` : `${label} window ${top.status}${pct}`,
  );
}

/** The `error streaks` check: names each enabled loop whose `consecutiveErrors` is at or past
 * ERROR_STREAK_WARN, with its streak and last error, and whether it is paused. Read-only; it reads
 * the same `consecutiveErrors` the error-streak breaker and `fleetAlerts` read, and the same
 * `pausedRoles` marker the scheduler reads. The marker does not record who wrote it, so a paused
 * loop at ERROR_STREAK_BREAKER's bar is described, not attributed to the breaker. A warn, not a
 * fail: a failing loop does not stop the fleet from running. */
export function checkErrorStreaks(root: string, config: TumwaterConfig | undefined): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const failing = loopIds(config)
    .map((id) => loadLoopState(root, id))
    .filter((s) => (s.consecutiveErrors ?? 0) >= ERROR_STREAK_WARN)
    .sort((a, b) => a.role.localeCompare(b.role));
  if (failing.length === 0) return okOutcome("no loop failing consecutively");
  const paused = new Set(pausedRoles(root));
  const phrases = failing.map((s) => {
    const n = s.consecutiveErrors ?? 0;
    let phrase = `${s.role}: ${n} failed ticks`;
    if (paused.has(s.role)) {
      phrase +=
        n >= ERROR_STREAK_BREAKER
          ? `, paused at the error-streak breaker's bar — \`tumwater resume --role ${s.role}\` once the cause is fixed`
          : ", paused";
    }
    if (s.lastError) phrase += ` — last error: ${squash(s.lastError, 120)}`;
    return phrase;
  });
  return warnOutcome(`failing tick after tick: ${phrases.join("; ")}`);
}

/** The `main red` check: names the code loops the red-main gate (mainRedGate) holds, ending
 * each blocked tick `main_red` while main's suite is red. Read-only: it asks heldByMainRed,
 * the predicate the status phase's `main red` label reads, so the two cannot disagree. A warn,
 * not a fail: a red main does not stop the fleet from running. */
export function checkMainRed(root: string, config: TumwaterConfig | undefined): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const mainCheck = mainCheckForPoll(root, config);
  const ids = loopIds(config);
  const held = ids
    .map((id) => loadLoopState(root, id))
    .filter((s) => heldByMainRed(s, mainCheck))
    .sort((a, b) => a.role.localeCompare(b.role));
  if (held.length === 0) return okOutcome("no loop held by a red main");
  const err = held.find((s) => s.lastError)?.lastError;
  const cause = err ? ` — ${squash(err, 160)}` : "";
  const healer = ids.some((id) => baseRoleOf(id) === "bugfix")
    ? "; the bugfix loop is exempt and repairs it"
    : "; no bugfix loop is enabled to repair it — fix main by hand or enable bugfix";
  return warnOutcome(`red main holds ${plural(held.length, "code loop")}: ${held.map((s) => s.role).join(", ")}${cause}${healer}`);
}
