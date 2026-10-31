/** One role's read-only inspection payload — the collector behind `tumwater role <id>`:
 * what the role IS (catalog entry or custom, enabled, paused, tier), what it RUNS ON
 * (resolved provider/model, the budget fallback pair), what it CARRIES (the instructions
 * override and the role's own find text verbatim), and what its NEXT run's prompt will
 * read like, assembled through the preview seam so nothing queued is consumed. Split out
 * of cli.ts like backlogPayload and status/status-data.ts's snapshot so the collector is testable
 * without the CLI and one renderer consumes exactly this shape. Every read degrades like
 * backlogPayload does — a missing tumwater.json is the defaults, a missing state file a
 * fresh state, a missing queue directory an empty inbox — so the command works with the
 * team stopped and never throws on a torn repo. */

import type { FallbackModelConfig, ModelTier, TumwaterConfig } from "../config/config-schema.js";
import { defaultConfig, enabledRoleIds, isCustomRole, knownRoleIds, loadConfigSafe, parseJsonConfig } from "../config/config.js";
import { DIRECTOR_ROLE, customRole, roleById, roleTier, unknownRoleMessage, type Role } from "./roles.js";
import { queuedRolePromptCount } from "../inbox/inbox.js";
import { pausedRoles } from "../team/team-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import type { RunnerState } from "../runner/runner-state.js";
import { baseRoleOf, runnerIds, runnerPaused } from "./runner-ids.js";
import { roleCapVerdicts } from "../gates/role-cap-gates.js";
import { projectCapHit } from "../budget/budget.js";
import { yieldMultiplierFor } from "../scheduling/backoff.js";
import { quietHoursStatus } from "../scheduling/quiet-hours.js";
import { assembleRunPrompt } from "../run/run-prompt.js";
import { configForRole, resolvedModelFields, reviewRunConfig, roleSeamTier, type ResolvedModelConfig } from "../config/config-views.js";
import { fallbackPair } from "../config/config-fallbacks.js";
import { fallbackModelPair, piModelsPath, seamContextWindowForRole } from "../pi/pi-models.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { formatModelSelector, type ModelSelector } from "../config/config-model-selector.js";
import { roleImageInfo } from "../agent/image-input.js";
import { readPiListedModels } from "../pi/pi-listed-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { readClaudeAccount, type ClaudeBilling } from "../agent/claude/claude-account.js";
import { readAccount, type SubscriptionAccount } from "../agent/subscription-account.js";
import { CONFIG_BASENAME, configPath, roleNotesPath } from "../paths.js";
import { coverageRows, readQaCoverage, type CoverageRow } from "../run/qa-coverage.js";
import { filingRows, readFeedbackFilings, type FilingRow } from "../run/feedback-filings.js";
import { readRegularTextOrNull, statOrNull } from "../files/files.js";
import { eventRole, eventUsage, readEvents } from "../events/event-read.js";
import { finiteNumber, objectOrEmpty } from "../files/json-object.js";
import { canonicalRoleId } from "./legacy-role-ids.js";
import { orchestratorAlive, readOrchestratorInfo, type ChainTierInfo } from "../team/team-orchestrator-info.js";

/** What `tumwater role <id>` reports about one role — the payload both the `--json`
 * document and the Markdown renderer consume (one shape, two surfaces). */
export interface RoleViewPayload {
  /** The role's id as the caller named it. */
  id: string;
  /** The catalog title, or "user-defined role" for a customRoles entry. */
  title: string;
  /** True when the id resolves through config.customRoles, not the built-in catalog. */
  custom: boolean;
  /** Whether the role is enabled in tumwater.json (a disabled role never runs). */
  enabled: boolean;
  /** Whether a per-role pause marker currently holds the role. */
  paused: boolean;
  /** Scheduling tier (roleTier): 0 work, 1 maintenance/observer — how fairOrder slots it. */
  tier: number;
  /** The model seam tier (roleSeamTier) this role's pi runs resolve at: a tier-name
   * `roles.<id>.model` names it directly, else the model catalog's assignment. Always
   * present — the operator can see which tier a role rides even when no tier map is
   * declared and every role rides `default`. */
  modelTier: ModelTier;
  /** The resolved model wiring (configForRole): role overrides applied over top-level. */
  provider?: string;
  model?: string;
  thinking?: string;
  /** The backend this seam routes to (configForRole's `agent`, plans/agent-backends.md):
   * `pi` unless a selector's provider names another agent or the top-level `agent` does.
   * Drives the renderer's `<agent> default` label and the agent-qualified selector string. */
  backend: string;
  /** pi's own saved default model (readPiDefaultModel) as a formatted selector, present only
   * for a pi seam that resolves neither a provider nor a model — the name the role runs when
   * tumwater.json names none. The effective `thinking` wins over the default's, matching
   * status-data.ts's snapshot. Absent for every other seam, so the JSON shape is unchanged. */
  piDefault?: string;
  /** The budget gate's fallback pair, or null when none is configured. */
  fallback: FallbackModelConfig | null;
  /** Whether that fallback is actually free in pi's definitions — what makes the gate
   * willing to engage it. Meaningful only when `fallback` is non-null. */
  fallbackFree: boolean;
  /** The subscription backend whose billing this answer reads (the role's own non-pi seam,
   * else the review gate's non-pi backend — today's claude precedence generalized, so a
   * codex role or a pi author on a codex reviewer names codex here): `"claude"`, `"codex"`, …
   * — the id the renderer labels a window with. Absent for a pi seam with no non-pi reviewer,
   * so old payloads stay byte-identical (plans/codex-backend.md "Groundwork", part 3c/9). */
  billingBackend?: string;
  /** The billing of the backend in play (plans/agent-backends.md §7/§8, PLANS.md part
   * 6d/7): "subscription" or "api" from the account file, absent for a pi seam or when no
   * account read exists. */
  billing?: ClaudeBilling;
  /** Whether the role's own model reads images (plans/image-input.md "Surfaces", part 5/5):
   * true / false / null (unknown), always present so the role page and the status rows share
   * one capability answer. */
  imageInput: boolean | null;
  /** The role's image reroute target as `<tier> (<model>)`, or null when no other tier reads
   * images — the role page's `Images: no — reruns on …` line. */
  imageReroute: string | null;
  /** The resolved primary seam's declared context window in tokens, or null when it cannot
   * be known (a non-pi seam, an unresolvable provider/model pair, or a model pi's
   * definitions declare no window). The seam `- Next run:` previews, not the fallback. */
  contextWindow: number | null;
  /** Where the running orchestrator has this role's tier moved on its fallback chain (its
   * `chain` block), or null when no orchestrator is alive or the tier is on its primary. */
  chainStep: ChainTierInfo | null;
  /** The effective min-run interval: the role's override or the global value. */
  minRunIntervalSeconds: number;
  /** The role's own min-run-interval override (roles.<base>.minRunIntervalSeconds), present
   * only when set — so a payload without one renders the team default and every existing
   * `role --json` golden stays byte-identical. */
  minRunIntervalOverride?: number;
  /** The role's own raw provider override (the FILE's roles.<base>.provider), present only
   * when the file sets it — distinct from the resolved `provider` field, which merges the
   * top-level value. Read through the base role, so an instance id shows the override its
   * runs carry. Absent when unset, so a payload without one stays byte-identical. */
  providerOverride?: string;
  /** The role's own raw model override (roles.<base>.model), present only when set. */
  modelOverride?: string;
  /** The role's own raw thinking override (roles.<base>.thinking), present only when set. */
  thinkingOverride?: string;
  /** The role's own raw backend override (roles.<base>.backend), present only when the file
   * sets it — distinct from the resolved `backend` field, which reflects selectors and the
   * top-level agent. Read through the base role, so an instance id shows the override its
   * runs carry. Absent when unset, so a payload without one stays byte-identical. */
  backendOverride?: string;
  /** The configured parallel-runner count (roles.<base>.instances), present only when set —
   * so a payload without one stays byte-identical to before. Resolved through the base role
   * like the min-run-interval override, so an instance id shows the count its runs carry. */
  instances?: number;
  /** The roles.<id>.instructions override verbatim, or null when unset. */
  instructions: string | null;
  /** The role's own find-something-to-do text verbatim (a custom role's `task`), or null
   * for the director — it has no find text; its queued prompts ARE its work. */
  find: string | null;
  /** The role's notes: the note its own earlier runs wrote, or
   * null when there is none (missing, empty, or unreadable). Always null for the director. */
  notes: string | null;
  /** The epoch-ms instant the note file was last modified (`fs.statSync(...).mtimeMs`) — the
   * operator twin of the `<role-notes>` prompt block's `last saved <day>` age, so the role
   * view can name how stale a note is. Null exactly when `notes` is null (a missing, empty
   * or unreadable note is still "no note yet"). Always null for the director, which has no
   * note. The stat shares the one note path with the read; no second file read. */
  noteSavedAt: number | null;
  /** Prompts currently queued for this role (the director's count includes the shared
   * inbox, which IS its queue). */
  inboxCount: number;
  /** The next run's assembled prompt, verbatim, through the preview seam — or null when
   * the role has nothing to run (a director with an empty inbox). */
  nextPrompt: string | null;
  /** The role's persisted schedule (runner-state.ts): the epoch-ms instant before which it
   * must not run again and the backoff in seconds it is currently serving (0 when not
   * backing off) — the same two fields the status `next run` cell reads. `nextRunAt` is 0
   * for a role that has never been scheduled; `backoffSeconds` is 0 unless a wake-clearing
   * backoff is in force. */
  nextRunAt: number;
  backoffSeconds: number;
  /** The quiet-hours windows that govern this role, the role's own (`quietHoursPerRole`, looked
   * up by base role as the gate does) first and the team-wide `quietHours` second, each with
   * whether the local clock sits inside it now. Absent when no window parses and for the
   * director, which both gates exempt. */
  quietHours?: Array<{ scope: "role" | "fleet"; window: string; inWindow: boolean }>;
  /** The yield multiplier the role's recent-yield ring earns right now — the same
   * `×N` the status `next run` cell rides (status-render.ts's nextRunCell reads
   * yieldMultiplierFor) — so the role view's Schedule cannot understate a quiet
   * yield-scaled role's effective gap. 1 for every role outside the scalable set and
   * for a scalable role whose recent ring still holds a merge. */
  yieldMultiplier: number;
  /** When the role's last run ended, epoch ms — absent for a never-run role, so the
   * JSON shape stays unchanged until the role has acted. */
  lastRunEndedAt?: number;
  /** The role's recent run outcomes — the newest up to 8 `run_end` results read from the
   * event log, ordered newest-first, each with its time, result, duration, and summary.
   * Absent when the role has no `run_end` events, so the JSON shape is unchanged for a
   * never-run role. Read straight from the event log so the command runs with the team
   * stopped and never touches the live state. */
  recentOutcomes?: Array<{ ts: number; result: string; durationMs?: number; summary?: string }>;
  /** The `qa` observer's flow-coverage ledger (plans/observer-roles.md 2/2), surfaced to its
   * one reader: each flow's last exercise and result in the prompt block's order
   * (never-exercised first, then stalest-first) via qa-coverage.ts's `coverageRows`. Present
   * only for the canonical `qa` id, so every other role's `--json` payload and Markdown render
   * stay byte-identical. The ledger read degrades to empty coverage on a missing or torn file
   * exactly as `readQaCoverage` already does. */
  flowCoverage?: CoverageRow[];
  /** The `feedback` observer's per-install filing ledger (plans/feedback-role.md 2/2), surfaced
   * to its one reader: each GitHub issue this install already filed, newest-first (via
   * feedback-filings.ts's `filingRows`), so the operator sees what the role filed, when, and
   * under what title — the twin of `qa`'s `flowCoverage` above. Present only for the canonical
   * `feedback` id, so every other role's `--json` payload and Markdown render stay
   * byte-identical. The ledger read degrades to an empty list on a missing or torn file exactly
   * as `readFeedbackFilings` already does. */
  filings?: FilingRow[];
  /** The role's own spend over its retained event window — tokens, real cost, and notional
   * (subscription) cost summed from the same `run_end` events `recentOutcomes` reads, each
   * folded through the shared `eventUsage` finiteness guard so a torn field contributes 0.
   * The sum's window is the single `readEvents` call `recentOutcomes` already makes, so the
   * two per-role facts cannot drift on what they cover. Absent when all three are 0 (the
   * report's zero-means-absent convention), so a never-costly role's JSON is unchanged. */
  usage?: { tokens: number; costUsd: number; notionalCostUsd: number };
  /** The role's `maxDailyCostUsdPerRole` cap and today's spend against it, from the same
   * `roleCapVerdicts` the scheduler's gate and the status `capPaused` observer fold: `over` is
   * whether the role is held until local midnight, `spentUsd` the base role's instances' summed
   * spend today, `roleIds` the instances sharing the cap. Absent when no cap above 0 applies
   * (and for the director), so a team without per-role caps keeps its JSON shape. */
  dailyCap?: { capUsd: number; spentUsd: number; over: boolean; roleIds: string[] };
  /** The role's own cap's `projectCapHit({ spentUsd, capUsd }, now)` forecast instant — when
   * today's burn reaches the cap, the per-role twin of the team budget badge's `~cap at HH:MM`.
   * Present only while a forecast stands (under the cap and burning), so a capped-but-over,
   * zero-spend, or no-cap payload keeps its current JSON shape. */
  dailyCapHitAt?: number;
}

/** The roles.<base>.<field> value the FILE actually holds, or undefined when the file never
 * set that field. Needed only for the seeded per-role fields: overlayDefaults fills every
 * built-in role's minRunIntervalSeconds from config.ts's catalog, so the merged config cannot
 * tell an operator-set override from a seeded default. This reads the same raw file view
 * unsetConfigKey judges presence against (configPath + CONFIG_BASENAME + objectOrEmpty), so
 * the override tag and the drawer's clear path agree with what unsetting can actually remove. */
export function rawRoleField(root: string, roleId: string, field: string): unknown {
  const { raw } = parseJsonConfig(configPath(root), CONFIG_BASENAME);
  const rawRoles = objectOrEmpty(raw).roles as Record<string, unknown> | undefined;
  const entry = rawRoles && typeof rawRoles === "object" ? rawRoles[roleId] : undefined;
  const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
  if (!obj) return undefined;
  return obj[field];
}

/** The identity and agent-seam resolution behind `tumwater role <id>`: the catalog/custom/
 * director look-up (with the one unknown-role throw, which the CLI's main catch turns into
 * `tumwater: <message>` exit 1), the DIRECTOR_ROLE empty-find pseudo-entry, and the resolved
 * model/agent configuration and the billing backend in play (the role's own non-pi seam,
 * else the review gate's non-pi backend). Returns the facts the payload's identity, seam and
 * billing groups read. */
function resolveRoleConfig(
  root: string,
  cfg: TumwaterConfig,
  role: string,
  catalog: Role | undefined,
  customEntry: { name: string; task: string } | undefined,
): {
  resolved: { title: string; find: string };
  effective: ResolvedModelConfig;
  billingBackend?: string;
  account: SubscriptionAccount | null;
  chainStep: ChainTierInfo | null;
} {
  // The director is inspectable like any role but has no catalog entry: a pseudo-Role whose
  // find text is empty (rolePayload nulls it below — the director's queued prompts ARE its
  // work), so the unknown-role throw only fires for ids nothing can answer.
  const resolved =
    catalog ??
    (customEntry ? customRole(customEntry.name, customEntry.task)
    : role === DIRECTOR_ROLE ? { id: DIRECTOR_ROLE, title: DIRECTOR_ROLE, find: "" }
    : undefined);
  // roleById maps any `feature-N` to its base whatever the config runs, so an instance id
  // counts only when knownRoleIds (the ids the config runs) holds it.
  if (!resolved || !knownRoleIds(cfg).includes(role)) {
    // The one unknown-role answer (unknownRoleMessage): the CLI's main catch turns the throw
    // into `tumwater: <message>` with exit 1, so the collector keeps the wording and the CLI
    // stays a thin peel-parse-print layer.
    throw new Error(unknownRoleMessage(role, knownRoleIds(cfg)));
  }
  const effective = configForRole(cfg, role);
  // The subscription backend whose billing is in play — the role's OWN seam when it routes
  // to a non-pi backend, else the review gate's backend when the reviewer runs a non-pi
  // backend (today's claude precedence generalized off the literal "claude", part 3c/9;
  // PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7): a pi author on a claude/codex
  // reviewer still shows where its changes' spend lands. Read that backend's account; the
  // account file is team-global, so either seam reads the same answer. Its subscription
  // window's primary type rides along for the renderer's label.
  const roleBackend = effective.agent !== undefined && effective.agent !== "pi" ? effective.agent : undefined;
  const reviewAgent = reviewRunConfig(cfg).agent;
  const reviewBackend =
    cfg.review.enabled && reviewAgent !== undefined && reviewAgent !== "pi" ? reviewAgent : undefined;
  const billingBackend = roleBackend ?? reviewBackend;
  const account = billingBackend !== undefined ? readAccount(root, billingBackend) : null;
  const info = readOrchestratorInfo(root);
  const chainStep = (orchestratorAlive(root, info) && info?.chain?.[roleSeamTier(cfg, role)]) || null;
  return { resolved, effective, billingBackend, account, chainStep };
}

/** The pi-seam saved-default read (one concern): whether the role's seam resolves neither a
 * provider nor a model (so it runs pi's own saved default) and, when it does, that default as
 * a formatted selector. Read once beside the models catalog the collector already takes as a
 * seam. The config's `thinking` wins over the default's because tumwater passes it to pi as
 * `--thinking`, mirroring the snapshot's modelFromPi rule. Any other seam stays unchanged and
 * carries no `piDefault`. */
function resolvePiDefault(
  modelsPath: string,
  root: string,
  effective: ResolvedModelConfig,
): ModelSelector | null {
  const runsPiWithoutAModel =
    (effective.agent === undefined || effective.agent === "pi") &&
    effective.provider === undefined &&
    effective.model === undefined;
  return runsPiWithoutAModel ? readPiDefaultModel(piSettingsPath(modelsPath), root) : null;
}

/** The budget-gate fallback story the operator sees: the declared pair, but the price-resolved
 * pair when one exists (a map with no `default` entry borrows another tier's free pair) and the
 * freeness verdict from the same read. `fallbackFree` false keeps the declared pair visible so
 * a refused fallback is still named. Reads the opencode catalog and claude account the way the
 * gate reads them — always, so the verdict prices pairs against the same snapshot the gate uses
 * and a borrowed opencode pair reads free exactly where the gate would engage it. */
function resolveFallbackStory(
  cfg: TumwaterConfig,
  modelsPath: string,
  root: string,
): { fallback: FallbackModelConfig | null; freeFallback: FallbackModelConfig | null } {
  const declaredFallback = fallbackPair(cfg);
  // The opencode catalog answer (part 6b/7), read the way the budget gate reads it — always,
  // from the same team-global cache the startup gate seeds — so the fallback free-ness verdict
  // prices opencode pairs against the same snapshot as the gate. A conditional read cannot
  // decide up front which pair the verdict will price: `fallbackModelPair` may resolve to a
  // free pair BORROWED from another tier (a map whose `default` entry is priced borrows a
  // free pair elsewhere), which routes to opencode even when the role's own seam, the declared
  // default pair, and the review gate are not opencode. A null catalog would read that borrowed
  // opencode pair NOT free, so this view and the gate would disagree.
  const opencodeCatalog = readOpencodeCache(root);
  // The claude account answer (6a/7), read the way the budget gate reads it — always, so the
  // fallback price verdict sees the subscription even when claude is not this role's own seam
  // (a pi role may still fall back to claude). The lookup returns it only for "claude" (part
  // 2a/9) — no caller asks for another backend yet.
  const claudeFallbackAccount = readClaudeAccount(root);
  const accounts = (b: string) => (b === "claude" ? claudeFallbackAccount : null);
  const freeFallback = declaredFallback ? fallbackModelPair(cfg, modelsPath, accounts, opencodeCatalog) : null;
  const fallback = freeFallback ?? declaredFallback;
  return { fallback, freeFallback };
}

/** The per-role run-history fold over one `readEvents` read: the newest up-to-8 run_end
 * outcomes and the role's spend sum over the same retained window, so the two per-role facts
 * cannot drift on what they cover. A torn run_end line contributes no outcome and no spend
 * (the shared finiteNumber / eventUsage guards). */
function historyOf(root: string, role: string): {
  recentOutcomes?: RoleViewPayload["recentOutcomes"];
  usage?: RoleViewPayload["usage"];
} {
  const events = readEvents(root);
  const runEnds = events.filter((ev) => ev.type === "run_end" && eventRole(ev) === role);
  const recentOutcomes = runEnds
    .filter((ev) => {
      return finiteNumber(ev.ts, null) !== null && typeof ev.result === "string" && ev.result !== "";
    })
    .slice(-8)
    .map((ev) => ({
      ts: ev.ts,
      result: ev.result as string,
      ...(finiteNumber(ev.durationMs, null) !== null ? { durationMs: ev.durationMs as number } : {}),
      ...(typeof ev.summary === "string" && ev.summary !== "" ? { summary: ev.summary } : {}),
    }))
    .reverse();
  const usage = runEnds.reduce<{ tokens: number; costUsd: number; notionalCostUsd: number }>(
    (acc, ev) => {
      if (finiteNumber(ev.ts, null) === null) return acc;
      const u = eventUsage(ev);
      acc.tokens += u.tokens;
      acc.costUsd += u.costUsd;
      acc.notionalCostUsd += u.notionalCostUsd;
      return acc;
    },
    { tokens: 0, costUsd: 0, notionalCostUsd: 0 },
  );
  return {
    ...(recentOutcomes.length > 0 ? { recentOutcomes } : {}),
    ...(usage.tokens !== 0 || usage.costUsd !== 0 || usage.notionalCostUsd !== 0 ? { usage } : {}),
  };
}

/** The per-role daily cap, answered by the same verdict the scheduler's gate shares
 * (roleCapVerdicts) over the base role's instances, so the page cannot disagree with the hold.
 * A cap of 0 disables (roleCapPaused's rule) and the director is exempt, so neither carries the
 * field. The `~cap at HH:MM` forecast rides along only while one stands (under the cap and
 * burning). */
function dailyCapOf(
  cfg: TumwaterConfig,
  role: string,
  state: RunnerState,
  root: string,
  now: Date,
): { dailyCap?: RoleViewPayload["dailyCap"]; dailyCapHitAt?: number } {
  const base = baseRoleOf(role);
  const capUsd = cfg.maxDailyCostUsdPerRole?.[base];
  let dailyCap: RoleViewPayload["dailyCap"];
  let dailyCapHitAt: number | undefined;
  if (role !== DIRECTOR_ROLE && typeof capUsd === "number" && Number.isFinite(capUsd) && capUsd > 0) {
    const ids = runnerIds(cfg).filter((id) => baseRoleOf(id) === base);
    if (!ids.includes(role)) ids.push(role);
    const runners = ids.map((id) => ({ role: id, state: id === role ? state : loadRunnerState(root, id) }));
    const verdict = roleCapVerdicts(runners, cfg.maxDailyCostUsdPerRole, now.getTime()).get(base);
    if (verdict) {
      dailyCap = { capUsd, spentUsd: verdict.spentUsd, over: verdict.over, roleIds: verdict.roleIds };
      const hitAt = projectCapHit({ spentUsd: verdict.spentUsd, capUsd }, now.getTime());
      if (hitAt !== null) dailyCapHitAt = hitAt;
    }
  }
  return { ...(dailyCap ? { dailyCap } : {}), ...(dailyCapHitAt !== undefined ? { dailyCapHitAt } : {}) };
}

/** The notes read, the quiet-hours windows and the resolved seam window that govern this role:
 * the note file's text and save instant (one stat sharing the note path), the role's own
 * (`quietHoursPerRole`, looked up by base role as the gate does) and team-wide windows with
 * whether the local clock sits inside each now, and the resolved seam's declared context
 * window. The director has no note, is exempt from both quiet-hours gates, and still resolves a
 * window like any role. */
function notesAndWindowsOf(
  root: string,
  role: string,
  cfg: TumwaterConfig,
  now: Date,
  modelsPath: string,
): { note: string | null; noteSavedAt: number | null; quietHours?: RoleViewPayload["quietHours"]; contextWindow: number | null } {
  let note: string | null = null;
  let noteSavedAt: number | null = null;
  if (role !== DIRECTOR_ROLE) {
    const notesPath = roleNotesPath(root, role);
    const text = readRegularTextOrNull(notesPath);
    note = text !== null && text.trim() !== "" ? text : null;
    if (note !== null) noteSavedAt = statOrNull(notesPath)?.mtimeMs ?? null;
  }
  const quietHours: NonNullable<RoleViewPayload["quietHours"]> = [];
  if (role !== DIRECTOR_ROLE) {
    const own = quietHoursStatus(cfg.quietHoursPerRole?.[baseRoleOf(role)], now);
    if (own.window !== null) quietHours.push({ scope: "role", window: own.window, inWindow: own.inWindow });
    const team = quietHoursStatus(cfg.quietHours, now);
    if (team.window !== null) quietHours.push({ scope: "fleet", window: team.window, inWindow: team.inWindow }); // vocabulary-ok: persisted --json scope value
  }
  const contextWindow = seamContextWindowForRole(cfg, role, root, modelsPath);
  return {
    note,
    noteSavedAt,
    ...(quietHours.length > 0 ? { quietHours } : {}),
    contextWindow,
  };
}

/** The raw-file precedence reads (roles.<base>, judged against the FILE not the merged cfg, so
 * an operator-set override is told apart from a seeded default): the min-run-interval override
 * and the four provider/model/thinking/backend overrides the drawer's Model overrides editor
 * prefills from. Each is spread only when the file actually holds it, so a payload without one
 * stays byte-identical. */
function overrideFieldsOf(root: string, base: string): {
  minRunIntervalOverride?: number;
  providerOverride?: string;
  modelOverride?: string;
  thinkingOverride?: string;
  backendOverride?: string;
} {
  // The roles.<base>.minRunIntervalSeconds override, resolved through the base role like the
  // cap, quiet hours and instructions — an instance id shows (and can edit) the override its
  // runs carry. Presence is judged against the FILE (rawRoleField), not the merged cfg:
  // overlayDefaults seeds every built-in role's minRunIntervalSeconds from config.ts's catalog,
  // so the merged value would make steward/qa/... always look overridden and the drawer's
  // clear a no-op. undefined when unset, so the spread below drops it.
  const rawInterval = rawRoleField(root, base, "minRunIntervalSeconds");
  const providerOverrideRaw = rawRoleField(root, base, "provider");
  const modelOverrideRaw = rawRoleField(root, base, "model");
  const thinkingOverrideRaw = rawRoleField(root, base, "thinking");
  const backendOverrideRaw = rawRoleField(root, base, "backend");
  return {
    ...(typeof rawInterval === "number" ? { minRunIntervalOverride: rawInterval } : {}),
    ...(typeof providerOverrideRaw === "string" ? { providerOverride: providerOverrideRaw } : {}),
    ...(typeof modelOverrideRaw === "string" ? { modelOverride: modelOverrideRaw } : {}),
    ...(typeof thinkingOverrideRaw === "string" ? { thinkingOverride: thinkingOverrideRaw } : {}),
    ...(typeof backendOverrideRaw === "string" ? { backendOverride: backendOverrideRaw } : {}),
  };
}

/** Assemble the `RoleViewPayload` object literal in today's order — the single shape both the
 * `--json` document and the Markdown renderer consume stays byte-identical to the pre-split
 * collector. Every field the caller read conditionally is spread only when present, exactly as
 * before. */
function assemblePayload(params: {
  root: string;
  role: string;
  cfg: TumwaterConfig;
  state: RunnerState;
  resolved: { title: string; find: string };
  effective: ResolvedModelConfig;
  billingBackend?: string;
  account: SubscriptionAccount | null;
  chainStep: ChainTierInfo | null;
  piDefault: ModelSelector | null;
  fallback: FallbackModelConfig | null;
  freeFallback: FallbackModelConfig | null;
  history: { recentOutcomes?: RoleViewPayload["recentOutcomes"]; usage?: RoleViewPayload["usage"] };
  cap: { dailyCap?: RoleViewPayload["dailyCap"]; dailyCapHitAt?: number };
  notes: { note: string | null; noteSavedAt: number | null; quietHours?: RoleViewPayload["quietHours"]; contextWindow: number | null };
  overrides: {
    minRunIntervalOverride?: number;
    providerOverride?: string;
    modelOverride?: string;
    thinkingOverride?: string;
    backendOverride?: string;
  };
  base: string;
  modelsPath: string;
  now: Date;
}): RoleViewPayload {
  const { root, role, cfg, state, resolved, effective, billingBackend, account, chainStep, piDefault, fallback, freeFallback, history, cap, notes, overrides, base, modelsPath, now } = params;
  return {
    id: role,
    title: resolved.title,
    custom: isCustomRole(cfg, role),
    enabled: enabledRoleIds(cfg).includes(role),
    paused: runnerPaused(new Set(pausedRoles(root)), role),
    tier: roleTier(role),
    modelTier: roleSeamTier(cfg, role),
    ...resolvedModelFields(effective.provider, effective.model, effective.thinking),
    ...(piDefault
      ? {
          piDefault: formatModelSelector({
            ...piDefault,
            thinking: effective.thinking ?? piDefault.thinking,
          }),
        }
      : {}),
    backend: effective.agent ?? "pi",
    fallback,
    fallbackFree: freeFallback !== null,
    ...(account !== null ? { billing: account.billing, billingBackend } : {}),
    chainStep,
    ...roleImageInfo(cfg, role, modelsPath, readPiListedModels(root)),
    minRunIntervalSeconds: effective.minRunIntervalSeconds,
    ...overrides,
    // The configured parallel-runner count (roles.<base>.instances), present only when the
    // config sets it — unlike minRunIntervalSeconds no catalog seed fills built-ins' counts,
    // so the merged cfg tells presence exactly. Resolved through the base role like the
    // instructions and min-run-interval override.
    ...(cfg.roles[base]?.instances !== undefined ? { instances: cfg.roles[base].instances } : {}),
    // The roles.<base>.instructions override verbatim — resolved through the base role like
    // the cap and quiet hours, so an instance id shows (and can edit) the override its runs
    // carry (run-prompt reads config.roles[base]); null when unset.
    instructions: cfg.roles[baseRoleOf(role)]?.instructions ?? null,
    find: role === DIRECTOR_ROLE ? null : resolved.find,
    notes: notes.note,
    noteSavedAt: notes.noteSavedAt,
    // The qa observer's flow-coverage ledger (plans/observer-roles.md 2/2) — each flow's last
    // exercise and result in the prompt block's order (never-exercised first, then
    // stalest-first). Present only for the canonical qa id, so every other role's --json
    // payload and Markdown render stay byte-identical.
    ...(role === "qa" ? { flowCoverage: coverageRows(readQaCoverage(root), now.getTime()) } : {}),
    // The feedback observer's per-install filing ledger (plans/feedback-role.md 2/2), the twin
    // of qa's flowCoverage block above: each issue this install filed, newest-first via the one
    // filingRows ordering the prompt block and the operator read share. Present only for the
    // canonical feedback id, so every other role's --json payload and Markdown render stay
    // byte-identical.
    ...(role === "feedback" ? { filings: filingRows(readFeedbackFilings(root)) } : {}),
    inboxCount: queuedRolePromptCount(root, role),
    // The resolved primary seam's declared context window in tokens, or null when it cannot
    // be known — the same seam `- Next run:` previews. Independent of the fallback.
    contextWindow: notes.contextWindow,
    // The preview seam: the queued prompt (if any) is read, not consumed, so an inspection
    // never costs the role its queued work — the property the run-prompt test pins.
    nextPrompt:
      assembleRunPrompt({
        root,
        config: cfg,
        role,
        state,
        preview: true,
      })?.prompt ?? null,
    // The role's schedule — surfaced read-only from the same persisted state rolePayload
    // already loaded for the next-run preview, so no new read path exists and the collector
    // stays one loadRunnerState per role. `lastRunEndedAt`
    // is omitted (JSON unchanged) until the role has actually run.
    nextRunAt: state.nextRunAt,
    backoffSeconds: state.backoffSeconds,
    yieldMultiplier: yieldMultiplierFor(state),
    ...(state.lastRunEndedAt !== undefined ? { lastRunEndedAt: state.lastRunEndedAt } : {}),
    ...(notes.quietHours ? { quietHours: notes.quietHours } : {}),
    ...history,
    ...cap,
  };
}

/** Collect one role's inspection payload. `modelsPath` overrides pi's model definitions location
 * — a test seam, like status/status-data.ts's snapshot — consulted only when a fallback pair is
 * configured (the freeness verdict needs the definitions; nothing else does). */
export function rolePayload(
  root: string,
  typedRole: string,
  modelsPath = piModelsPath(),
  now: Date = new Date(),
): RoleViewPayload {
  const role = canonicalRoleId(typedRole);
  // loadConfigSafe (not loadConfigCached's hold-last-good machinery — this is a one-shot
  // command, not a poller): a broken or missing file degrades to the defaults, so the
  // command still answers for built-in roles on a torn repo.
  const { config } = loadConfigSafe(root);
  const cfg = config ?? defaultConfig();
  const catalog = roleById(role);
  const customEntry = cfg.customRoles.find((c) => c.name === role);

  // One state read serves the next-run preview, the schedule, and the daily-cap verdict below.
  const state = loadRunnerState(root, role);
  const base = baseRoleOf(role);

  const { resolved, effective, billingBackend, account, chainStep } = resolveRoleConfig(
    root,
    cfg,
    role,
    catalog,
    customEntry,
  );
  const piDefault = resolvePiDefault(modelsPath, root, effective);
  const { fallback, freeFallback } = resolveFallbackStory(cfg, modelsPath, root);
  const history = historyOf(root, role);
  const cap = dailyCapOf(cfg, role, state, root, now);
  const notes = notesAndWindowsOf(root, role, cfg, now, modelsPath);
  const overrides = overrideFieldsOf(root, base);

  return assemblePayload({
    root,
    role,
    cfg,
    state,
    resolved,
    effective,
    billingBackend,
    account,
    chainStep,
    piDefault,
    fallback,
    freeFallback,
    history,
    cap,
    notes,
    overrides,
    base,
    modelsPath,
    now,
  });
}
