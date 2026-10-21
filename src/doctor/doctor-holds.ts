import { roleLabel } from "../roles/role-labels.js";
import { pausedRoles, pausedRolesUntil, standingTeamPause } from "../team/team-state.js";
import { MODEL_TIERS, type ModelTier, type TumwaterConfig } from "../config/config-schema.js";
import { withModelOverrides } from "../config/config-views.js";
import type { ChainTierInfo } from "../team/orchestrator-info.js";
import { commitTier, DIRECTOR_ROLE } from "../roles/roles.js";
import { budgetReached, budgetWarning, teamDailyCost } from "../budget/budget.js";
import { roleCapVerdicts } from "../gates/role-cap-gates.js";
import { readMergeQueue } from "../merge/merge-queue.js";
import { MAINTENANCE_DAILY_FLOOR } from "../gates/maintenance-quota.js";
import { heldByMainRed, mainCheckForPoll, maintenanceQuotaForPoll } from "../status/status-polls.js";
import type { RunnerState } from "../runner/runner-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { baseRoleOf, runnerIds, runnerPaused } from "../roles/runner-ids.js";
import { ERROR_STREAK_BREAKER, ERROR_STREAK_WARN } from "../run/run-apply.js";
import { squash } from "../text/text.js";
import { usd } from "../text/format.js";
import { parseQuietHours, quietHoursStatus, quietWindowEnd, roleQuietHold } from "../scheduling/quiet-hours.js";
import { DAY_MS, HOUR_MS, humanUntil } from "../text/datetime.js";
import { budgetPhrase, pauseReasonSuffix, plural } from "../text/phrases.js";
import { claudeUtilizationPct, claudeWindowEntries, claudeWindowLabel, readClaudeAccount } from "../agent/claude/claude-account.js";
import { claudeWindowObservation } from "../team/team-polls.js";
import { readEventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";
import { redMainWarning, revertWarnings } from "../baseline/main-guardrails.js";
import { loadQuarantine } from "../review/known-flakes.js";

/** The standing-hold checks: `pause` (checkPause), `quiet hours` (checkQuietHours), and `budget`
 * (checkBudget), `claude window` (checkClaudeWindow), `maintenance quota`
 * (checkMaintenanceQuota), and `error streaks` (checkErrorStreaks), all read-only reports of
 * holds on running. */
export function loadRunnerStates(root: string, config: TumwaterConfig): RunnerState[] {
  return runnerIds(config)
    .map((id) => loadRunnerState(root, id))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/** The `pause` check: names a standing operator pause so doctor does not print "ready to run"
 * over a team that starts no run. Read-only: it reads the same team and per-role pause
 * markers the scheduler reads (standingTeamPause, pausedRoles, pausedRolesUntil — all treat
 * an expired marker as absent), so its verdict cannot disagree with what the team does. A
 * team pause is a warn because it stops every role; paused roles are ok because the operator
 * chose them by name and every other role keeps running. `now` only drives the countdowns. */
export function checkPause(root: string, now: number = Date.now()): CheckOutcome {
  const team = standingTeamPause(root);
  const roles = pausedRoles(root);
  let rolesPhrase = "";
  if (roles.length > 0) {
    const until = pausedRolesUntil(root);
    rolesPhrase = `paused roles: ${roles.join(", ")}${until !== undefined ? ` (auto-resume in ${humanUntil(until, now)})` : ""}`;
  }
  if (!team) return rolesPhrase ? okOutcome(rolesPhrase) : okOutcome("not paused");
  const head =
    team.until !== undefined
      ? `team paused — auto-resumes in ${humanUntil(team.until, now)}`
      : "team paused — no role starts a run until `tumwater resume`";
  return warnOutcome(`${head}${pauseReasonSuffix(team.reason)}${rolesPhrase ? `; ${rolesPhrase}` : ""}`);
}

/** The `quiet hours` check: names the team quiet window and any per-role windows holding now,
 * so doctor does not print "ready to run" over a team that starts no run until the window
 * ends. Read-only: membership comes from the scheduler's own parser and predicate
 * (quietHoursStatus, roleQuietHold), so the verdict cannot disagree with the gate. A team
 * window holding is a warn because it stops every role (the director is exempt); held per-role
 * windows are ok because the operator chose those roles by name. A malformed value reads as
 * unset here — checkInit owns that error. `now` is injected so tests never read the clock. */
export function checkQuietHours(config: TumwaterConfig | undefined, now: Date = new Date()): CheckOutcome {
  const team = quietHoursStatus(config?.quietHours, now);
  const perRole = config?.quietHoursPerRole;
  const roleKeys = Object.keys(perRole ?? {}).filter((k) => k !== DIRECTOR_ROLE);
  const held = roleKeys.filter((k) => roleQuietHold(perRole, k, now)).sort();
  const anyRoleWindow = roleKeys.some((k) => {
    const parsed = parseQuietHours(perRole?.[k]);
    return parsed.ok && parsed.window !== null;
  });
  const phrases: string[] = [];
  if (team.window !== null) {
    phrases.push(
      team.inWindow
        ? `quiet now (${team.window}) — no role starts a run until ${quietWindowEnd(team.window)}; the director is exempt`
        : `${team.window} (not in the window now)`,
    );
  }
  if (held.length > 0) {
    phrases.push(`quiet roles: ${held.map((k) => `${k} until ${quietWindowEnd(String(perRole?.[k]))}`).join(", ")}`);
  } else if (anyRoleWindow) {
    phrases.push("per-role windows set, none holding now");
  }
  if (phrases.length === 0) return okOutcome("none configured");
  const detail = phrases.join("; ");
  return team.inWindow ? warnOutcome(detail) : okOutcome(detail);
}

/** The `budget` check: today's team spend against `maxDailyCostUsd`, plus base roles over their
 * own `maxDailyCostUsdPerRole` cap. Read-only and built on the scheduler's own definitions
 * (teamDailyCost, budgetReached, roleCapVerdicts), so the verdict cannot disagree with the gate.
 * `published` is the running scheduler's figure (it includes runs charged since the last save)
 * and wins over the persisted sum, as in status. A reached team cap is a warn because roles
 * run on their tier fallback or hold until local midnight (the `fallback` row says which);
 * per-role caps reached alone are ok because the operator chose them by name. */
export function checkBudget(
  root: string,
  config: TumwaterConfig | undefined,
  published: { spentUsd: number; capUsd: number } | null,
  now: number = Date.now(),
): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const states = loadRunnerStates(root, config);
  const spent = published?.spentUsd ?? teamDailyCost(states, now);
  const caps = config.maxDailyCostUsdPerRole;
  const capped = [...roleCapVerdicts(states.map((s) => ({ role: s.role, state: s })), caps, now)]
    .filter(([, v]) => v.over)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([base, v]) => `${base} (${budgetPhrase(v.spentUsd, caps?.[base])})`);
  const cappedPhrase = capped.length > 0 ? `; capped roles: ${capped.join(", ")}` : "";
  const cap = config.maxDailyCostUsd;
  if (!(cap > 0)) return okOutcome(`no daily cap; ${usd(spent)} spent today${cappedPhrase}`);
  const view = { spentUsd: spent, capUsd: cap };
  const phrase = budgetPhrase(spent, cap);
  if (budgetReached(view)) {
    return warnOutcome(
      `daily cap reached — ${phrase} today; roles run on their over-cap model or hold until local midnight (see the over-cap model row)${cappedPhrase}`,
    );
  }
  if (budgetWarning(view)) return okOutcome(`${phrase} today — past 80% of the cap${cappedPhrase}`);
  return okOutcome(`${phrase} today${cappedPhrase}`);
}

/** The `maintenance quota` check: rolling-24 h maintenance merges against the allowance
 * (`maintenancePerWorkMerge` per work merge + the daily floor), naming the maintenance roles held
 * when it is full. Read-only and built on the same verdict the scheduler and status use
 * (maintenanceQuotaForPoll). Only a live team's running roles and merge queue count as in flight,
 * since a dead team's leftover `running` flag and queue drain nothing. A held allowance is a warn
 * because it stops a whole tier. */
export function checkMaintenanceQuota(
  root: string,
  config: TumwaterConfig | undefined,
  aliveTeam: boolean,
  now: number = Date.now(),
): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const runners = loadRunnerStates(root, config).map((s) => ({ role: s.role, running: aliveTeam && s.running === true }));
  const queued = aliveTeam ? new Set(readMergeQueue(root).entries.map((e) => e.role)) : new Set<string>();
  const { allowance, used, held } = maintenanceQuotaForPoll(root, config.maintenancePerWorkMerge, runners, queued, now);
  if (held.length > 0) {
    return warnOutcome(
      `allowance reached — ${used}/${allowance} maintenance merges in the last 24h; held until the window rolls under: ${[...held].sort().join(", ")}`,
    );
  }
  const base = `${used}/${allowance} maintenance merges in the last 24h (${config.maintenancePerWorkMerge} per work merge + ${MAINTENANCE_DAILY_FLOOR} floor)`;
  const anyMaintenance = runners.some((l) => commitTier(l.role) === "maintenance");
  return okOutcome(anyMaintenance ? base : `${base}; no maintenance role enabled`);
}

/** The `claude window` check: whether a rejected subscription window holds the subscription claude
 * seams. Read-only and built on claudeWindowObservation, the verdict the scheduler's team hold
 * uses, so it cannot disagree with the hold. A hold is a warn because it stops every subscription
 * claude seam until the window resets; otherwise the most constrained window's state is reported
 * as ok (a rejected window spending overage reads `rejected` here: overage spends, it does not
 * hold). API-billed claude never holds. */
export function checkClaudeWindow(
  root: string,
  now: number = Date.now(),
  chain?: Partial<Record<ModelTier, ChainTierInfo>>,
  config?: TumwaterConfig,
): CheckOutcome {
  const account = readClaudeAccount(root, now);
  if (account?.billing !== "subscription") return okOutcome("no subscription window reported");
  const held = claudeWindowObservation(account, now);
  if (held?.kind === "subscription-window" && held.windowType !== undefined && held.resetsAt !== undefined) {
    const label = claudeWindowLabel(held.windowType);
    const resets = humanUntil(held.resetsAt, now);
    const moved = MODEL_TIERS.filter((t) => {
      const reason = chain?.[t]?.reason;
      return reason === "window" || reason === "reserve";
    });
    if (moved.length > 0) {
      const waiting = MODEL_TIERS.filter((t) => !chain?.[t] && config !== undefined && withModelOverrides(config, t, {}).agent === "claude");
      return warnOutcome(
        `${label} window rejected — ${moved.join(", ")} moved to fallbacks until it resets in ${resets}${waiting.length > 0 ? `; ${waiting.join(", ")} wait` : ""}`,
      );
    }
    return warnOutcome(
      `${label} window rejected — subscription claude model jobs wait until it resets in ${resets}`,
    );
  }
  const top = claudeWindowEntries(account)[0];
  if (top === undefined) return okOutcome("subscription; no window reported yet");
  const pct = typeof top.utilization === "number" ? ` (${claudeUtilizationPct(top.utilization)}% used)` : "";
  const label = claudeWindowLabel(top.type);
  return okOutcome(
    top.status === "allowed_warning" ? `${label} window nearing its limit${pct}` : `${label} window ${top.status}${pct}`,
  );
}

/** How far back the `provider hold` check reads for hold/resume crossings. The longest a
 * hold can stay is HOLD_CAP_MS (team-hold's 15-minute cap that escalation doubles against),
 * so a window a comfortable multiple of that covers any standing hold's crossing event plus
 * its resume — an older resumed event must not be missed or a re-opened provider reads held. */
const HOLD_CHECK_WINDOW_MS = 2 * HOUR_MS;

/** The `provider hold` check: names each provider whose team-wide failure hold
 * (src/team/team-hold.ts, polled by pollTeamHold) stands now — a 429/backend-failure storm
 * that stops the roles on that provider from starting new runs until it re-opens. Read-only:
 * it infers the standing set from the event log's own `rate_limit_hold`/`rate_limit_resumed`
 * crossings, the events pollTeamHold writes, so it cannot disagree with the hold. A standing
 * hold is a warn (as with the `claude window` row) because it stops every role on that
 * provider; `now` is injected so a test can pin a hold standing before its deadline and
 * re-opened after. The ended hold's kind rides the resumed event (see pollTeamHold), and any
 * resumed event ends that provider's current hold whatever its kind. */
export function checkProviderHolds(root: string, now: number = Date.now()): CheckOutcome {
  let events: HarnessEvent[];
  try {
    events = readEventsSince(root, HOLD_CHECK_WINDOW_MS).events;
  } catch (err) {
    return warnOutcome(`could not read the event log for provider holds: ${errorMessage(err)}`);
  }
  const standing = new Map<string | undefined, { end: number; kind: unknown; roles: unknown }>();
  for (const ev of events) {
    if (ev.type === "rate_limit_hold") {
      const provider = typeof ev.provider === "string" ? ev.provider : undefined;
      const end = (typeof ev.ts === "number" ? ev.ts : 0) + (typeof ev.holdMs === "number" ? ev.holdMs : 0);
      standing.set(provider, { end, kind: ev.kind, roles: ev.roles });
    } else if (ev.type === "rate_limit_resumed") {
      standing.delete(typeof ev.provider === "string" ? ev.provider : undefined);
    }
  }
  const held = [...standing.entries()]
    .filter(([, h]) => h.end > now)
    .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
  if (held.length === 0) return okOutcome("no provider holds");
  const lines = held.map(([provider, h]) => {
    const name = provider ?? "pi's default backend";
    const roles = Array.isArray(h.roles) && h.roles.length > 0 ? `; roles: ${h.roles.join(", ")}` : "";
    return `${name} (${h.kind}) holds until it re-opens in ${humanUntil(h.end, now)}${roles}`;
  });
  return warnOutcome(lines.join("; "));
}

/** The `error streaks` check: names each enabled role whose `consecutiveErrors` is at or past
 * ERROR_STREAK_WARN, with its streak and last error, and whether it is paused. Read-only; it reads
 * the same `consecutiveErrors` the error-streak breaker and `teamAlerts` read, and the same
 * `pausedRoles` marker the scheduler reads. The marker does not record who wrote it, so a paused
 * role at ERROR_STREAK_BREAKER's bar is described, not attributed to the breaker. A warn, not a
 * fail: a failing role does not stop the team from running. */
export function checkErrorStreaks(root: string, config: TumwaterConfig | undefined): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const failing = loadRunnerStates(root, config)
    .filter((s) => (s.consecutiveErrors ?? 0) >= ERROR_STREAK_WARN);
  if (failing.length === 0) return okOutcome("no role failing repeatedly");
  const paused = new Set(pausedRoles(root));
  const phrases = failing.map((s) => {
    const n = s.consecutiveErrors ?? 0;
    let phrase = `${roleLabel(s.role)}: ${n} failed runs`;
    if (runnerPaused(paused, s.role)) {
      const key = paused.has(s.role) ? s.role : paused.has(baseRoleOf(s.role)) ? baseRoleOf(s.role) : `${s.role}-1`;
      phrase +=
        n >= ERROR_STREAK_BREAKER
          ? `, paused at the repeated-failure pause's bar — \`tumwater resume --role ${key}\` once the cause is fixed`
          : ", paused";
    }
    if (s.lastError) phrase += ` — last error: ${squash(s.lastError, 120)}`;
    return phrase;
  });
  return warnOutcome(`failing run after run: ${phrases.join("; ")}`);
}

/** The `main red` check: names the code roles the red-main gate (mainRedGate) holds, ending
 * each blocked run `main_red` while main's suite is red, and warns when main has been red over
 * RED_MAIN_WARN_MS even with no role held (the red-main gate's guardrail, G1). Read-only: it
 * asks heldByMainRed, the predicate the status phase's `main red` label reads, so the two
 * cannot disagree on the held roles, and redMainWarning over the event trail, so both phrases
 * can appear in one row. A warn, not a fail: a red main does not stop the team from running.
 * `now` is injected so a test can pin a red's age. */
export function checkMainRed(
  root: string,
  config: TumwaterConfig | undefined,
  now: number = Date.now(),
): CheckOutcome {
  if (config === undefined) return okOutcome("not checked — tumwater.json unreadable");
  const mainCheck = mainCheckForPoll(root, config);
  const ids = runnerIds(config);
  const held = loadRunnerStates(root, config)
    .filter((s) => heldByMainRed(s, mainCheck));
  const phrases: string[] = [];
  if (held.length > 0) {
    const err = held.find((s) => s.lastError)?.lastError;
    const cause = err ? ` — ${squash(err, 160)}` : "";
    const healer = ids.some((id) => baseRoleOf(id) === "bugfix")
      ? "; the bugfix role is exempt and repairs it"
      : "; no bugfix role is enabled to repair it — fix main by hand or enable bugfix";
    phrases.push(`main's check is failing; ${plural(held.length, "code role")} waiting: ${held.map((s) => roleLabel(s.role)).join(", ")}${cause}${healer}`);
  }
  const events = readEventsSince(root, DAY_MS).events;
  const red = redMainWarning(events, now);
  if (red !== null) phrases.push(red);
  phrases.push(...revertWarnings(events, loadQuarantine(root), now));
  if (phrases.length === 0) return okOutcome("no role waiting on main's check");
  return warnOutcome(phrases.join("; "));
}
