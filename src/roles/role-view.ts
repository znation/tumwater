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

import type { FallbackModelConfig, ModelTier } from "../config/config-schema.js";
import { defaultConfig, enabledRoleIds, isCustomRole, knownRoleIds, loadConfigSafe, parseJsonConfig } from "../config/config.js";
import { DIRECTOR_ROLE, customRole, roleById, roleTier, unknownRoleMessage } from "./roles.js";
import { queuedRolePromptCount } from "../inbox/inbox.js";
import { pausedRoles } from "../team/team-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { baseRoleOf, runnerIds, runnerPaused } from "./runner-ids.js";
import { roleCapVerdicts } from "../gates/role-cap-gates.js";
import { projectCapHit } from "../budget/budget.js";
import { yieldMultiplierFor } from "../scheduling/backoff.js";
import { quietHoursStatus } from "../scheduling/quiet-hours.js";
import { assembleRunPrompt } from "../run/run-prompt.js";
import { configForRole, resolvedModelFields, reviewedAfterMerge, reviewRunConfig, roleSeamTier, seamConcurrencyKey } from "../config/config-views.js";
import { fallbackPair, modelFallbackView, type ModelFallbackView } from "../config/config-fallbacks.js";
import { fallbackModelPair, piModelsPath, seamContextWindowForRole } from "../pi/pi-models.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { formatModelSelector } from "../config/model-selector.js";
import { roleImageInfo } from "../agent/image-input.js";
import { readPiListedModels } from "../pi/pi-listed-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { readClaudeAccount, type ClaudeBilling } from "../agent/claude/claude-account.js";
import { readAccount, windowEntries } from "../agent/subscription-account.js";
import { CONFIG_BASENAME, configPath, roleNotesPath } from "../paths.js";
import { coverageRows, readQaCoverage, type CoverageRow } from "../run/qa-coverage.js";
import { filingRows, readFeedbackFilings, type FilingRow } from "../run/feedback-filings.js";
import { readRegularTextOrNull, statOrNull } from "../files/files.js";
import { eventRole, eventUsage, readEvents } from "../events/event-read.js";
import { finiteNumber, objectOrEmpty } from "../files/json-object.js";
import { canonicalRoleId } from "./legacy-role-ids.js";
import { orchestratorAlive, readOrchestratorInfo, type ChainTierInfo } from "../team/orchestrator-info.js";

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
  /** The provider key this role's admission lease acquires (seamConcurrencyKey, the same
   * pure call the orchestrator's admission uses) — the key whose cap bounds the role's
   * concurrent runs (plans/provider-concurrency.md §8). Absent for a seam whose key
   * cannot be resolved (a cap-less default team). */
  providerKey?: string;
  /** The `maxConcurrentPerProvider` cap for `providerKey`, present only while such a map is
   * configured and the key resolves. The number the team line shows as `<key> inUse/cap`. */
  providerCap?: number;
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
  /** The active model-fallback episode (PLANS.md "Model failure fallback"), or null when
   * the role's runs are not running off-model. */
  modelFallback: ModelFallbackView | null;
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
  /** The resolved primary seam's declared context window in tokens, or null when it cannot
   * be known (a non-pi seam, an unresolvable provider/model pair, or a model pi's
   * definitions declare no window). The seam `- Next run:` previews, not the fallback. */
  contextWindow: number | null;
  /** The primary subscription window's type (`five_hour`), present only for a subscription
   * reading that reported a window — the renderer's "(5h window)". */
  billingWindow?: string;
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
  /** Whether the review gate reviews this role's commits AFTER they merge
   * (config-views.ts's reviewedAfterMerge, the one membership test the gate, the runner's
   * `already_queued` recovery arm and this view share). Present only while review is enabled
   * (`review.enabled !== false`) and `review.afterMerge` lists the role's base id — absent
   * for a pre-merge-reviewed role or when the gate is off, matching the absent-when-default
   * pattern of `instances`. */
  reviewedAfterMerge?: true;
  /** Whether the review gate is on at all (`review.enabled !== false`) — the browser twin of
   * `tumwater role <id> --review-after-merge`'s gate check, told apart from `reviewedAfterMerge`
   * so a before-merge-reviewed role (or a gate-off config) still renders its toggle. Present
   * only while the gate is on, independent of membership. */
  reviewEnabled?: true;
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
  const billingWindow = account?.billing === "subscription" ? windowEntries(account)[0]?.type : undefined;
  // pi's own saved default for a pi seam that resolves no model, read once beside the models
  // catalog this collector already takes as a seam (piSettingsPath). The config's `thinking`
  // wins over the default's because tumwater passes it to pi as `--thinking`, mirroring the
  // snapshot's modelFromPi rule. Any other seam stays unchanged and carries no `piDefault`.
  const runsPiWithoutAModel =
    (effective.agent === undefined || effective.agent === "pi") &&
    effective.provider === undefined &&
    effective.model === undefined;
  const piDefault = runsPiWithoutAModel ? readPiDefaultModel(piSettingsPath(modelsPath), root) : null;
  // The role's provider key and its cap (plans/provider-concurrency.md §8): the same pure
  // key the orchestrator's admission resolves for this role, answered from the same
  // piDefault seam the orchestrator carries, so `tumwater role <id>` names the exact key
  // whose cap bounds the role. The cap is the map's entry for that key, absent when no
  // `maxConcurrentPerProvider` map is set or the key has no entry (then the role is bounded
  // only by the team total, and the cap is omitted).
  const providerKey = seamConcurrencyKey(effective, piDefault);
  const providerCap =
    providerKey !== undefined ? cfg.maxConcurrentPerProvider?.[providerKey] : undefined;
  // The fallback story the operator sees: the declared pair, but the price-resolved pair when
  // one exists (a map with no `default` entry borrows another tier's free pair) and the
  // freeness verdict from the same read. `fallbackFree` false keeps the declared pair visible
  // so a refused fallback is still named.
  const declaredFallback = fallbackPair(cfg);
  // The opencode catalog answer (part 6b/7), read the way the budget gate reads it — always,
  // from the same team-global cache the startup gate seeds — so the fallback free-ness verdict
  // prices opencode pairs against the same snapshot as the gate. A conditional read cannot
  // decide up front which pair the verdict will price: `fallbackModelPair` may resolve to a
  // free pair BORROWED from another tier (a map whose `default` entry is priced borrows a
  // free pair elsewhere), which routes to opencode even when the role's own seam, the declared
  // default pair, and the review gate are not opencode. A null catalog would read that borrowed
  // opencode pair NOT free, so this view and the gate would disagree; reading always (as the
  // gate does) keeps them on one answer. OpenCode's `catalog` is threaded the way claude's
  // `account` is: absent, an opencode pair reads NOT free.
  const opencodeCatalog = readOpencodeCache(root);
  // The claude account answer (6a/7), read the way the budget gate reads it — always, so the
  // fallback price verdict sees the subscription even when claude is not this role's own seam
  // (a pi role may still fall back to claude). The lookup returns it only for "claude" (part
  // 2a/9) — no caller asks for another backend yet.
  const claudeFallbackAccount = readClaudeAccount(root);
  const accounts = (b: string) => (b === "claude" ? claudeFallbackAccount : null);
  const freeFallback = declaredFallback ? fallbackModelPair(cfg, modelsPath, accounts, opencodeCatalog) : null;
  const fallback = freeFallback ?? declaredFallback;
  // One state read serves both the model-fallback episode and the next-run preview below.
  const state = loadRunnerState(root, role);
  const episode = state.modelFallback;
  // The role's recent run outcomes, read from the event log (readEvents) so the command
  // answers with the team stopped and never touches live state. readEvents returns the log's
  // newest events in file (chronological) order, so filtering to this role's run_end events
  // and taking the last 8 yields the newest 8, reversed to newest-first. Durations and
  // summaries ride along only when the event carried them (a torn or empty line drops them),
  // and an empty result is omitted so a never-run role carries no `recentOutcomes` at all.
  // One event-log read serves both per-role facts — the recent outcomes and the spend sum — so
  // the two cannot drift on what they cover: filtered to this role's run_end events once, then
  // the outcome projection keeps the newest valid 8 while the usage fold sums the whole window.
  const events = readEvents(root);
  const runEnds = events.filter((ev) => ev.type === "run_end" && eventRole(ev) === role);
  // The event log is read without a shape filter, so a torn or hand-edited run_end line can
  // carry a non-numeric ts/durationMs or an empty result — the same foreign shape every other
  // consumer guards with finiteNumber. A line with no usable ts or result is as unusable as
  // an absent one (the same "a torn line carries no usable timestamp" rule eventRun/runStartMap
  // apply), so it contributes no outcome; a non-numeric durationMs is dropped like a missing one.
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
  // The role's own spend over the same retained window, summed per-run_end through the shared
  // eventUsage guard (a torn or hand-edited run_end line contributes nothing: a non-numeric
  // field reads as 0, and a line without a usable ts is as unusable as an absent one, matching
  // recentOutcomes's drop rule so a torn run never silently spends). Omitted when all three
  // sums are 0, keeping a never-costly role's JSON unchanged (the report's zero-means-absent
  // convention).
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
  // The per-role daily cap, answered by the verdict the scheduler's gate shares (roleCapVerdicts)
  // over the base role's instances, so the page cannot disagree with the hold. A cap of 0
  // disables (roleCapPaused's rule) and the director is exempt, so neither carries the field.
  const base = baseRoleOf(role);
  // The roles.<base>.minRunIntervalSeconds override, resolved through the base role like the
  // cap, quiet hours and instructions — an instance id shows (and can edit) the override its
  // runs carry. Presence is judged against the FILE (rawRoleField), not the merged cfg:
  // overlayDefaults seeds every built-in role's minRunIntervalSeconds from config.ts's catalog,
  // so the merged value would make steward/qa/... always look overridden and the drawer's
  // clear a no-op. undefined when unset, so the spread below drops it (the payload stays
  // byte-identical when there is no override).
  const rawInterval = rawRoleField(root, base, "minRunIntervalSeconds");
  const minRunIntervalOverride = typeof rawInterval === "number" ? rawInterval : undefined;
  // The raw provider/model/thinking/backend the FILE holds (roles.<base>), distinct from
  // the resolved provider/model/thinking/backend fields configForRole merges with the top
  // level — the drawer's Model overrides editor prefills from these, empty when unset.
  // Presence is judged against the FILE (rawRoleField) like minRunIntervalOverride, so a
  // config that relies on the top level or a tier name carries no override. Each is spread
  // only when a string, so a file with no overrides yields a payload byte-identical to
  // today's.
  const providerOverrideRaw = rawRoleField(root, base, "provider");
  const modelOverrideRaw = rawRoleField(root, base, "model");
  const thinkingOverrideRaw = rawRoleField(root, base, "thinking");
  const backendOverrideRaw = rawRoleField(root, base, "backend");
  const providerOverride = typeof providerOverrideRaw === "string" ? providerOverrideRaw : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw : undefined;
  const thinkingOverride = typeof thinkingOverrideRaw === "string" ? thinkingOverrideRaw : undefined;
  const backendOverride = typeof backendOverrideRaw === "string" ? backendOverrideRaw : undefined;
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
  // The role's notes, read for display. The same degradation as every other read here: a
  // missing, empty, or unreadable file is simply "no note yet". The director has none.
  // Alongside the read, the same path is stat'd once for the note's save instant (mtimeMs),
  // null when there is no note.
  let note: string | null = null;
  let noteSavedAt: number | null = null;
  if (role !== DIRECTOR_ROLE) {
    const notesPath = roleNotesPath(root, role);
    const text = readRegularTextOrNull(notesPath);
    note = text !== null && text.trim() !== "" ? text : null;
    if (note !== null) noteSavedAt = statOrNull(notesPath)?.mtimeMs ?? null;
  }
  // The windows the scheduler applies (gates/gate-polls.ts), through the same parser and
  // predicate; the director is exempt from both gates.
  const quietHours: NonNullable<RoleViewPayload["quietHours"]> = [];
  if (role !== DIRECTOR_ROLE) {
    const own = quietHoursStatus(cfg.quietHoursPerRole?.[baseRoleOf(role)], now);
    if (own.window !== null) quietHours.push({ scope: "role", window: own.window, inWindow: own.inWindow });
    const team = quietHoursStatus(cfg.quietHours, now);
    if (team.window !== null) quietHours.push({ scope: "fleet", window: team.window, inWindow: team.inWindow }); // vocabulary-ok: persisted --json scope value
  }
  // The resolved primary seam's declared context window. A run currently on the model
  // fallback may use a different window, which is the fallback's own documented state.
  const contextWindow = seamContextWindowForRole(cfg, role, root, modelsPath);
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
    ...(providerKey !== undefined ? { providerKey } : {}),
    ...(providerCap !== undefined ? { providerCap } : {}),
    fallback,
    fallbackFree: freeFallback !== null,
    modelFallback: modelFallbackView(episode, cfg, role),
    ...(account !== null ? { billing: account.billing, billingBackend } : {}),
    ...(billingWindow !== undefined ? { billingWindow } : {}),
    chainStep,
    ...roleImageInfo(cfg, role, modelsPath, readPiListedModels(root)),
    minRunIntervalSeconds: effective.minRunIntervalSeconds,
    ...(minRunIntervalOverride !== undefined ? { minRunIntervalOverride } : {}),
    ...(providerOverride !== undefined ? { providerOverride } : {}),
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(thinkingOverride !== undefined ? { thinkingOverride } : {}),
    ...(backendOverride !== undefined ? { backendOverride } : {}),
    // The configured parallel-runner count (roles.<base>.instances), present only when the
    // config sets it — unlike minRunIntervalSeconds no catalog seed fills built-ins' counts,
    // so the merged cfg tells presence exactly. Resolved through the base role like the
    // instructions and min-run-interval override.
    ...(cfg.roles[base]?.instances !== undefined ? { instances: cfg.roles[base].instances } : {}),
    // Whether the review gate reviews this role's commits after they merge — the role page's
    // `- Review: after merge` line. Present only while review is enabled and review.afterMerge
    // lists the role's base id, so a pre-merge-reviewed role or a gate-off config leaves the
    // payload (and its render) unchanged.
    ...(cfg.review.enabled && reviewedAfterMerge(cfg, role) ? { reviewedAfterMerge: true } : {}),
    // Whether the review gate is on at all (review.enabled !== false) — the gate toggle's
    // presence, distinct from reviewedAfterMerge's membership, so a before-merge-reviewed role
    // still gets the drawer's Review control while the gate runs.
    ...(cfg.review.enabled ? { reviewEnabled: true } : {}),
    // The roles.<base>.instructions override verbatim — resolved through the base role like
    // the cap and quiet hours, so an instance id shows (and can edit) the override its runs
    // carry (run-prompt reads config.roles[base]); null when unset.
    instructions: cfg.roles[baseRoleOf(role)]?.instructions ?? null,
    find: role === DIRECTOR_ROLE ? null : resolved.find,
    notes: note,
    noteSavedAt,
    // The qa observer's flow-coverage ledger (plans/observer-roles.md 2/2) — each flow's last
    // exercise and result in the prompt block's order (never-exercised first, then
    // stalest-first). Present only for the canonical qa id, so every other role's --json
    // payload and Markdown render stay byte-identical. The ledger read degrades to empty
    // coverage on a missing or torn file exactly as readQaCoverage already does.
    ...(role === "qa" ? { flowCoverage: coverageRows(readQaCoverage(root), now.getTime()) } : {}),
    // The feedback observer's per-install filing ledger (plans/feedback-role.md 2/2), the twin
    // of qa's flowCoverage block above: each issue this install filed, newest-first via the one
    // filingRows ordering the prompt block and the operator read share. Present only for the
    // canonical feedback id, so every other role's --json payload and Markdown render stay
    // byte-identical. The ledger read degrades to an empty list on a missing or torn file
    // exactly as readFeedbackFilings already does.
    ...(role === "feedback" ? { filings: filingRows(readFeedbackFilings(root)) } : {}),
    inboxCount: queuedRolePromptCount(root, role),
    // The resolved primary seam's declared context window in tokens, or null when it cannot
    // be known (a non-pi seam, an unresolvable provider/model pair, or a model with no
    // declared window) — the same seam `- Next run:` previews. Independent of the fallback.
    contextWindow,
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
    // already loaded for the model-fallback episode and the next-run preview, so no new
    // read path exists and the collector stays one loadRunnerState per role. `lastRunEndedAt`
    // is omitted (JSON unchanged) until the role has actually run.
    nextRunAt: state.nextRunAt,
    backoffSeconds: state.backoffSeconds,
    yieldMultiplier: yieldMultiplierFor(state),
    ...(state.lastRunEndedAt !== undefined ? { lastRunEndedAt: state.lastRunEndedAt } : {}),
    ...(quietHours.length > 0 ? { quietHours } : {}),
    ...(recentOutcomes.length > 0 ? { recentOutcomes } : {}),
    ...(usage.tokens !== 0 || usage.costUsd !== 0 || usage.notionalCostUsd !== 0 ? { usage } : {}),
    ...(dailyCap ? { dailyCap } : {}),
    ...(dailyCapHitAt !== undefined ? { dailyCapHitAt } : {}),
  };
}
