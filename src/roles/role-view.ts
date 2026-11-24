/** One role's read-only inspection payload — the collector behind `tumwater role <id>`:
 * what the role IS (catalog entry or custom, enabled, paused, tier), what it RUNS ON
 * (resolved provider/model, the budget fallback pair), what it CARRIES (the instructions
 * override and the role's own find text verbatim), and what its NEXT run's prompt will
 * read like, assembled through the preview seam so nothing queued is consumed. Split out
 * of cli.ts like backlogPayload and status/status-data.ts's snapshot so the collector is testable
 * without the CLI and one renderer consumes exactly this shape. Every read degrades like
 * backlogPayload does — a missing tumwater.json is the defaults, a missing state file a
 * fresh state, a missing queue directory an empty inbox — so the command works with the
 * team stopped and never throws on a torn repo. The payload's shape lives in
 * role-view-types.ts; this module owns only the collection that fills it. */

import type { FallbackModelConfig, TumwaterConfig } from "../config/config-schema.js";
import type { RoleViewPayload } from "./role-view-types.js";
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
import { configForRole, resolvedModelFields, reviewRunConfig, roleSeamTier, type ResolvedModelConfig } from "../config/config-views.js";
import { fallbackPair } from "../config/config-fallbacks.js";
import { fallbackModelPair, piModelsPath, seamContextWindowForRole } from "../pi/pi-models.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { formatModelSelector } from "../config/config-model-selector.js";
import { roleImageInfo } from "../agent/image-input.js";
import { readPiListedModels } from "../pi/pi-listed-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { readClaudeAccount, type ClaudeBilling } from "../agent/claude/claude-account.js";
import { readAccount, windowEntries } from "../agent/subscription-account.js";
import { CONFIG_BASENAME, configPath, roleLessonsPath, roleNotesPath } from "../paths.js";
import { parseRoleLessonsText, roleLessonsText } from "./role-notes-write.js";
import { coverageRows, readQaCoverage, type CoverageRow } from "../observer/qa-coverage.js";
import type { RunnerState } from "../runner/runner-state-types.js";
import { filingRows, readFeedbackFilings, type FilingRow } from "../observer/feedback-filings.js";
import { readRegularTextOrNull, statOrNull } from "../files/files.js";
import { eventRole, eventUsage, readEvents } from "../events/event-read.js";
import { finiteNumber, objectOrEmpty } from "../files/json-object.js";
import { canonicalRoleId } from "./legacy-role-ids.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/team-orchestrator-info.js";
import type { ChainTierInfo } from "../team/team-orchestrator-info-types.js";

/** The roles.<base>.<field> value the FILE actually holds, or undefined when the file never
 * set that field. Needed only for the seeded per-role fields: overlayDefaults fills every
 * built-in role's minRunIntervalSeconds from config.ts's catalog, so the merged config cannot
 * tell an operator-set override from a seeded default. This reads the same raw file view
 * unsetConfigKey judges presence against (configPath + CONFIG_BASENAME + objectOrEmpty), so
 * the override tag and the drawer's clear path agree with what unsetting can actually remove. */
function rawRoleField(root: string, roleId: string, field: string): unknown {
  const { raw } = parseJsonConfig(configPath(root), CONFIG_BASENAME);
  const rawRoles = objectOrEmpty(raw).roles as Record<string, unknown> | undefined;
  const entry = rawRoles && typeof rawRoles === "object" ? rawRoles[roleId] : undefined;
  const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
  if (!obj) return undefined;
  return obj[field];
}

/** "Which id resolves, and which id is unknown?": the catalog/custom/DIRECTOR resolution and
 * its one unknown-role throw — the first block of the collector, lifted out so the answer to
 * that question reads from one name. The throw still fires before any account or info read. */
function resolveRoleIdentity(
  typedRole: string,
  cfg: TumwaterConfig,
): { role: string; resolved: { title: string; find: string } } {
  const role = canonicalRoleId(typedRole);
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
  return { role, resolved };
}

/** "Whose subscription pays for this role?" — the billing seam: the role's OWN non-pi
 * backend when it has one, else the review gate's, plus that backend's account and its
 * subscription window's primary type. Lifted out of the collector's middle block; `account`
 * is null and `billingWindow` undefined when no non-pi seam is in play, so the caller's
 * conditional spread stays unchanged. */
function resolveBillingSeam(
  root: string,
  cfg: TumwaterConfig,
  effective: ResolvedModelConfig,
): { billingBackend?: string; account: { billing: ClaudeBilling } | null; billingWindow?: string } {
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
  const billingWindow = account?.billing === "subscription" ? windowEntries(account)[0]?.type : undefined;
  return { billingBackend, account, billingWindow };
}

/** "Is this role's tier moved on the orchestrator's chain?" — the chain step for the role's
 * seam tier: present only while the orchestrator is alive and its chain names the tier. */
function resolveChainStep(root: string, cfg: TumwaterConfig, role: string): ChainTierInfo | null {
  const info = readOrchestratorInfo(root);
  return (orchestratorAlive(root, info) && info?.chain?.[roleSeamTier(cfg, role)]) || null;
}

/** The identity/config half of the collector — "what is this role, and how is it configured?":
 * the catalog/custom/DIRECTOR resolution (and its one unknown-role throw), the effective model
 * wiring via configForRole, the subscription backend whose billing is in play plus that backend's
 * account, the orchestrator chain step, the base role, and the raw per-role overrides read from
 * the FILE (roles.<base>), each present only when the file sets it. Returns every piece the
 * assembly spread needs, resolved through the base role so an instance id shows the overrides its
 * runs carry. */
function resolveRoleConfig(
  root: string,
  typedRole: string,
  cfg: TumwaterConfig,
): {
  role: string;
  resolved: { title: string; find: string };
  effective: ResolvedModelConfig;
  billingBackend?: string;
  account: { billing: ClaudeBilling } | null;
  billingWindow?: string;
  chainStep: ChainTierInfo | null;
  base: string;
} {
  const { role, resolved } = resolveRoleIdentity(typedRole, cfg);
  const effective = configForRole(cfg, role);
  const { billingBackend, account, billingWindow } = resolveBillingSeam(root, cfg, effective);
  const chainStep = resolveChainStep(root, cfg, role);
  const base = baseRoleOf(role);
  return {
    role,
    resolved,
    effective,
    billingBackend,
    account,
    ...(billingWindow !== undefined ? { billingWindow } : {}),
    chainStep,
    base,
  };
}

/** The raw per-role override fields — "what does the role's FILE override on its own?": the
 * roles.<base>.minRunIntervalSeconds/provider/model/thinking/backend values read from the raw
 * file (rawRoleField), presence judged against the FILE not the merged cfg — overlayDefaults
 * seeds every built-in role's minRunIntervalSeconds from the catalog, so the merged value
 * would make steward/qa/... always look overridden and the drawer's clear a no-op. Each is
 * present only when the file sets it, so a payload with no overrides stays byte-identical. */
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
  return {
    minRunIntervalOverride,
    providerOverride,
    modelOverride,
    thinkingOverride,
    backendOverride,
  };
}

/** The pi-seam saved default — "what does a model-less pi run use?": pi's own saved default
 * model, read only for a pi seam that resolves neither a provider nor a model. The config's
 * `thinking` wins over the default's because tumwater passes it to pi as `--thinking`,
 * mirroring the snapshot's modelFromPi rule; any other seam stays unchanged and carries no
 * `piDefault`. The read lives beside the models catalog this collector already takes as a seam
 * (piSettingsPath). */
function resolvePiDefault(
  root: string,
  modelsPath: string,
  effective: ResolvedModelConfig,
): {
  piDefault?: string;
} {
  // pi's own saved default for a pi seam that resolves no model, read once beside the models
  // catalog this collector already takes as a seam (piSettingsPath). The config's `thinking`
  // wins over the default's because tumwater passes it to pi as `--thinking`, mirroring the
  // snapshot's modelFromPi rule. Any other seam stays unchanged and carries no `piDefault`.
  const runsPiWithoutAModel =
    (effective.agent === undefined || effective.agent === "pi") &&
    effective.provider === undefined &&
    effective.model === undefined;
  const piDefaultRaw = runsPiWithoutAModel ? readPiDefaultModel(piSettingsPath(modelsPath), root) : null;
  const piDefault = piDefaultRaw
    ? formatModelSelector({ ...piDefaultRaw, thinking: effective.thinking ?? piDefaultRaw.thinking })
    : undefined;
  return { piDefault };
}

/** The budget-gate fallback story — "what does this role fall back to, and is it free?": the
 * declared pair, but the price-resolved pair when one exists (a map with no `default` entry
 * borrows another tier's free pair) and the freeness verdict, priced through the same
 * always-read opencode/claude answers the budget gate reads so the view and the gate stay on
 * one answer. `fallbackFree` false keeps the declared pair visible so a refused fallback is
 * still named. */
function resolveFallbackStory(cfg: TumwaterConfig, modelsPath: string, root: string): {
  fallback: FallbackModelConfig | null;
  fallbackFree: boolean;
} {
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
  return { fallback, fallbackFree: freeFallback !== null };
}

/** The run-history fold — "what did this role recently do and cost?": the single
 * readEvents(root) call filtered once to this role's run_end events, then the outcome
 * projection keeps the newest valid 8 while the usage fold sums the whole window, so the two
 * per-role facts keep sharing one event-log read and cannot drift on what they cover. */
function historyOf(
  root: string,
  role: string,
): {
  recentOutcomes: NonNullable<RoleViewPayload["recentOutcomes"]>;
  usage: NonNullable<RoleViewPayload["usage"]>;
} {
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
  return { recentOutcomes, usage };
}

/** The per-role daily cap — "what is this role's cap and where is it hit?": the per-role
 * daily cap and its forecast hit instant, answered by the verdict the scheduler's gate shares
 * (roleCapVerdicts) over the base role's instances (the extra sibling loadRunnerState reads
 * living here), so the page cannot disagree with the hold. The role's OWN state file read (for
 * the cap's sibling set) is the one `state` already loaded by the preview helper — no second
 * read for the role itself. */
function dailyCapOf(
  root: string,
  cfg: TumwaterConfig,
  role: string,
  now: Date,
  state: RunnerState,
): {
  dailyCap: RoleViewPayload["dailyCap"];
  dailyCapHitAt?: number;
} {
  // The per-role daily cap, answered by the verdict the scheduler's gate shares (roleCapVerdicts)
  // over the base role's instances, so the page cannot disagree with the hold. A cap of 0
  // disables (roleCapPaused's rule) and the director is exempt, so neither carries the field.
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
  return { dailyCap, dailyCapHitAt };
}

/** The role's note for the operator surface, read whole, and the instant it was last saved:
 * "what note does this role's inspection carry, and when was it last saved?" The note text is
 * read through readRegularTextOrNull (lstat-guarded: a symlink dropped at the notes path reads
 * as absent, so an outside file's text is never pulled in — INV-G3), then a missing, empty, or
 * whitespace-only file is "no note yet" (null) rather than an error. The same path is stat'd
 * once for the save instant (mtimeMs), null when there is no note. The director carries none. */
function roleNoteAndSavedAt(root: string, role: string): { note: string | null; noteSavedAt: number | null } {
  if (role === DIRECTOR_ROLE) return { note: null, noteSavedAt: null };
  const notesPath = roleNotesPath(root, role);
  const text = readRegularTextOrNull(notesPath);
  const note = text !== null && text.trim() !== "" ? text : null;
  const noteSavedAt = note !== null ? statOrNull(notesPath)?.mtimeMs ?? null : null;
  return { note, noteSavedAt };
}

/** The role's persisted lessons, rendered whole for display: "what lessons does the role
 * carry, and does a corrupted store degrade to null?" Read through readRegularTextOrNull
 * (lstat-guarded: a symlink dropped at the lessons path reads as absent, so an outside file's
 * text is never pulled into the operator surface — INV-G3). A missing or empty store is "no
 * lessons" (null); a corrupted file degrades to null rather than failing the inspection, the
 * same tolerance the note read gives a torn note. The director carries none. */
function roleLessons(root: string, role: string): string | null {
  if (role === DIRECTOR_ROLE) return null;
  const lessonsText = readRegularTextOrNull(roleLessonsPath(root, role));
  try {
    const store = parseRoleLessonsText(lessonsText ?? "");
    return store.lessons.length > 0 ? roleLessonsText(store.lessons) : null;
  } catch {
    return null;
  }
}

/** The quiet-hours windows the scheduler applies for this role (gates/gate-polls.ts): the role's
 * own (looked up by base role as the gate does) first, then the team-wide window, through the
 * same parser and predicate. The director is exempt from both gates and carries none. */
function roleQuietHours(
  cfg: TumwaterConfig,
  role: string,
  now: Date,
): NonNullable<RoleViewPayload["quietHours"]> {
  const quietHours: NonNullable<RoleViewPayload["quietHours"]> = [];
  if (role !== DIRECTOR_ROLE) {
    const own = quietHoursStatus(cfg.quietHoursPerRole?.[baseRoleOf(role)], now);
    if (own.window !== null) quietHours.push({ scope: "role", window: own.window, inWindow: own.inWindow });
    const team = quietHoursStatus(cfg.quietHours, now);
    if (team.window !== null) quietHours.push({ scope: "fleet", window: team.window, inWindow: team.inWindow }); // vocabulary-ok: persisted --json scope value
  }
  return quietHours;
}

/** The notes, quiet-hours windows, and the resolved seam window — "what does this role carry in
 * notes, when is it quiet, and how large is its context window?": the note read with its save
 * instant (the stat shares the one note path with the read), the quiet-hours windows the
 * scheduler applies (the role's own first and the team-wide second), and the resolved primary
 * seam's declared context window (the same seam `- Next run:` previews). The director is exempt
 * from the note and the windows. */
function notesAndWindowsOf(
  root: string,
  cfg: TumwaterConfig,
  role: string,
  now: Date,
  modelsPath: string,
): {
  note: string | null;
  noteSavedAt: number | null;
  lessons: string | null;
  quietHours: NonNullable<RoleViewPayload["quietHours"]>;
  contextWindow: number | null;
} {
  const { note, noteSavedAt } = roleNoteAndSavedAt(root, role);
  const lessons = roleLessons(root, role);
  const quietHours = roleQuietHours(cfg, role, now);
  // The resolved primary seam's declared context window. A run currently on the model
  // fallback may use a different window, which is the fallback's own documented state.
  const contextWindow = seamContextWindowForRole(cfg, role, root, modelsPath);
  return { note, noteSavedAt, lessons, quietHours, contextWindow };
}

/** The role's persisted schedule (runner-state-types.ts) surfaced read-only in the payload: the
 * epoch-ms instant before which it must not run again, the backoff it is currently serving
 * (0 when not), the yield multiplier its recent-yield ring earns right now, and — absent until
 * the role has run — when its last run ended. One shape, shared by `previewRun`'s return and
 * `AssemblePayloadParams`, so the two read the same four fields. */
interface RoleScheduleView {
  nextRunAt: number;
  backoffSeconds: number;
  yieldMultiplier: number;
  lastRunEndedAt?: number;
}

/** The run preview and schedule half — "what will its next run look like?": the one
 * loadRunnerState read for this role (its own state file, shared with the cap helper's sibling
 * set), the prompt assembled through the preview seam (read, never consumed, so an inspection
 * costs the role nothing queued), and the schedule fields surfaced read-only from that same
 * state. */
function previewRun(
  root: string,
  cfg: TumwaterConfig,
  role: string,
): {
  state: RunnerState;
  nextPrompt: string | null;
  schedule: RoleScheduleView;
} {
  // One state read serves the next-run preview below.
  const state = loadRunnerState(root, role);
  const nextPrompt =
    assembleRunPrompt({
      root,
      config: cfg,
      role,
      state,
      preview: true,
    })?.prompt ?? null;

  return {
    state,
    nextPrompt,
    schedule: {
      nextRunAt: state.nextRunAt,
      backoffSeconds: state.backoffSeconds,
      yieldMultiplier: yieldMultiplierFor(state),
      ...(state.lastRunEndedAt !== undefined ? { lastRunEndedAt: state.lastRunEndedAt } : {}),
    },
  };
}

/** The per-role observer ledgers — "what did the observer roles record?": the qa flow-coverage
 * block and the feedback filings block, each guarded to its canonical role id, so the
 * qa/feedback ledgers read from one helper and every other role's payload stays byte-identical. */
function observerLedgers(
  role: string,
  root: string,
  now: Date,
): {
  flowCoverage?: CoverageRow[];
  filings?: FilingRow[];
} {
  return {
    // The qa observer's flow-coverage ledger (plans/observer-roles.md 2/2) — each flow's last
    // exercise and result in the prompt block's order (never-exercised first, then
    // stalest-first). Present only for the canonical qa id, so every other role's --json
    // payload and Markdown render stay byte-identical. The ledger read degrades to empty
    // coverage on a missing or torn file exactly as readQaCoverage already does.
    ...(role === "qa" ? { flowCoverage: coverageRows(readQaCoverage(root), now.getTime()) } : {}),
    // The feedback observer's per-install filing ledger (plans/feedback-role.md 2/2), the twin
    // of qa's flowCoverage block above: each issue this install already filed, newest-first via
    // the one filingRows ordering the prompt block and the operator read share. Present only for
    // the canonical feedback id, so every other role's --json payload and Markdown render stay
    // byte-identical. The ledger read degrades to an empty list on a missing or torn file
    // exactly as readFeedbackFilings already does.
    ...(role === "feedback" ? { filings: filingRows(readFeedbackFilings(root)) } : {}),
  };
}

/** Collect one role's inspection payload. `modelsPath` overrides pi's model definitions location
 * — a test seam, like status/status-data.ts's snapshot — consulted only when a fallback pair is
 * configured (the freeness verdict needs the definitions; nothing else does). The collector is a
 * thin spread of named helpers, one per concern: identity/config resolution, the model seam and
 * fallback story, the run-outcomes+usage fold, the cap/notes/quiet-hours posture, the run preview
 * and schedule, and the observer ledgers. Each read happens exactly once (one loadConfigSafe, one
 * readEvents, one loadRunnerState for the role), and the helpers return exactly the pieces the
 * assembly spread needs. */
/** The pieces `rolePayload`'s collectors resolve, passed whole to the payload builders. */
interface AssemblePayloadParams {
  role: string;
  resolved: { title: string; find: string };
  cfg: TumwaterConfig;
  root: string;
  effective: ResolvedModelConfig;
  piDefault?: string;
  backend: string;
  fallback: FallbackModelConfig | null;
  fallbackFree: boolean;
  account: { billing: ClaudeBilling } | null;
  billingBackend?: string;
  billingWindow?: string;
  chainStep: ChainTierInfo | null;
  modelsPath: string;
  minRunIntervalOverride?: number;
  providerOverride?: string;
  modelOverride?: string;
  thinkingOverride?: string;
  backendOverride?: string;
  base: string;
  note: string | null;
  noteSavedAt: number | null;
  lessons: string | null;
  flowCoverage?: CoverageRow[];
  filings?: FilingRow[];
  contextWindow: number | null;
  nextPrompt: string | null;
  schedule: RoleScheduleView;
  quietHours: NonNullable<RoleViewPayload["quietHours"]>;
  recentOutcomes: NonNullable<RoleViewPayload["recentOutcomes"]>;
  usage: NonNullable<RoleViewPayload["usage"]>;
  dailyCap: RoleViewPayload["dailyCap"];
  dailyCapHitAt?: number;
}

// The payload's identity: who the role is and where it sits in the config.
function identityFields(p: AssemblePayloadParams): Partial<RoleViewPayload> {
  const { role, resolved, cfg, root } = p;
  return {
    id: role,
    title: resolved.title,
    custom: isCustomRole(cfg, role),
    enabled: enabledRoleIds(cfg).includes(role),
    paused: runnerPaused(new Set(pausedRoles(root)), role),
    tier: roleTier(role),
    modelTier: roleSeamTier(cfg, role),
  };
}

// The payload's model seam: the resolved seam and its fallback, billing, and image story.
function modelFields(p: AssemblePayloadParams): Partial<RoleViewPayload> {
  const { effective, piDefault, backend, fallback, fallbackFree, account, billingBackend, billingWindow, chainStep, cfg, role, modelsPath, root } = p;
  return {
    ...resolvedModelFields(effective.provider, effective.model, effective.thinking),
    ...(piDefault ? { piDefault } : {}),
    backend,
    fallback,
    fallbackFree,
    ...(account !== null ? { billing: account.billing, billingBackend } : {}),
    ...(billingWindow !== undefined ? { billingWindow } : {}),
    chainStep,
    ...roleImageInfo(cfg, role, modelsPath, readPiListedModels(root)),
    minRunIntervalSeconds: effective.minRunIntervalSeconds,
  };
}

// The payload's role overrides: the per-role knobs and the base role's instances and
// instructions, each present only when the config sets it.
function overrideFields(p: AssemblePayloadParams): Partial<RoleViewPayload> {
  const { minRunIntervalOverride, providerOverride, modelOverride, thinkingOverride, backendOverride, cfg, base, role } = p;
  return {
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
    // The roles.<base>.instructions override verbatim — resolved through the base role like
    // the cap and quiet hours, so an instance id shows (and can edit) the override its runs
    // carry (run-prompt reads config.roles[base]); null when unset.
    instructions: cfg.roles[baseRoleOf(role)]?.instructions ?? null,
  };
}

// The payload's role context: the search text, notes, observer ledgers, and the next-run
// preview seam.
function contextFields(p: AssemblePayloadParams): Partial<RoleViewPayload> {
  const { role, resolved, note, noteSavedAt, lessons, flowCoverage, filings, contextWindow, nextPrompt, root } = p;
  return {
    find: role === DIRECTOR_ROLE ? null : resolved.find,
    notes: note,
    noteSavedAt,
    lessons,
    ...(flowCoverage !== undefined ? { flowCoverage } : {}),
    ...(filings !== undefined ? { filings } : {}),
    inboxCount: queuedRolePromptCount(root, role),
    // The resolved primary seam's declared context window in tokens, or null when it cannot
    // be known (a non-pi seam, an unresolvable provider/model pair, or a model with no
    // declared window) — the same seam `- Next run:` previews. Independent of the fallback.
    contextWindow,
    // The preview seam: the queued prompt (if any) is read, not consumed, so an inspection
    // never costs the role its queued work — the property the run-prompt test pins.
    nextPrompt,
  };
}

// The payload's schedule: the role's persisted run schedule and its quiet hours.
function scheduleFields(p: AssemblePayloadParams): Partial<RoleViewPayload> {
  const { schedule, quietHours } = p;
  return {
    // The role's schedule — surfaced read-only from the same persisted state rolePayload
    // already loaded for the next-run preview, so no new read path exists and the collector
    // stays one loadRunnerState per role. `lastRunEndedAt`
    // is omitted (JSON unchanged) until the role has actually run.
    ...schedule,
    ...(quietHours.length > 0 ? { quietHours } : {}),
  };
}

// The payload's usage: the run-outcome history, the token/cost fold, and the daily cap.
function usageFields(p: AssemblePayloadParams): Partial<RoleViewPayload> {
  const { recentOutcomes, usage, dailyCap, dailyCapHitAt } = p;
  return {
    ...(recentOutcomes.length > 0 ? { recentOutcomes } : {}),
    ...(usage.tokens !== 0 || usage.costUsd !== 0 || usage.notionalCostUsd !== 0 ? { usage } : {}),
    ...(dailyCap ? { dailyCap } : {}),
    ...(dailyCapHitAt !== undefined ? { dailyCapHitAt } : {}),
  };
}

/** Assemble the returned `RoleViewPayload` object literal in today's key order, so the `--json`
 * document and the Markdown renderer (one shape, two surfaces) stay byte-identical. Every field
 * is spread from the named builders' results in exactly the order `rolePayload` produces today:
 * `identityFields`, `modelFields`, `overrideFields`, `contextFields`, `scheduleFields`, and
 * `usageFields`; nothing moves or disappears, so the split never changes a payload. */
function assemblePayload(p: AssemblePayloadParams): RoleViewPayload {
  return {
    ...identityFields(p),
    ...modelFields(p),
    ...overrideFields(p),
    ...contextFields(p),
    ...scheduleFields(p),
    ...usageFields(p),
  } as RoleViewPayload;
}

/** Collect one role's inspection payload. `modelsPath` overrides pi's model definitions location
 * — a test seam, like status/status-data.ts's snapshot — consulted only when a fallback pair is
 * configured (the freeness verdict needs the definitions; nothing else does). The collector is a
 * thin spread of named helpers, one per concern: identity/config resolution, the pi seam's saved
 * default, the fallback story, the run-history fold, the daily cap, the notes/windows read, the
 * raw override fields, the next-run preview, and the observer ledgers, assembled by
 * `assemblePayload`. Each read happens exactly once (one loadConfigSafe, one readEvents, one
 * loadRunnerState for the role), and the helpers return exactly the pieces the assembly spread
 * needs. */
export function rolePayload(
  root: string,
  typedRole: string,
  modelsPath = piModelsPath(),
  now: Date = new Date(),
): RoleViewPayload {
  const { config } = loadConfigSafe(root);
  const cfg = config ?? defaultConfig();
  const identity = resolveRoleConfig(root, typedRole, cfg);
  const { role, resolved, effective, billingBackend, account, billingWindow, chainStep, base } = identity;
  const { piDefault } = resolvePiDefault(root, modelsPath, effective);
  const { fallback, fallbackFree } = resolveFallbackStory(cfg, modelsPath, root);
  const preview = previewRun(root, cfg, role);
  const { state, nextPrompt, schedule } = preview;
  const { recentOutcomes, usage } = historyOf(root, role);
  const { dailyCap, dailyCapHitAt } = dailyCapOf(root, cfg, role, now, state);
  const { note, noteSavedAt, lessons, quietHours, contextWindow } = notesAndWindowsOf(root, cfg, role, now, modelsPath);
  const overrides = overrideFieldsOf(root, base);
  const { minRunIntervalOverride, providerOverride, modelOverride, thinkingOverride, backendOverride } = overrides;
  const ledgers = observerLedgers(role, root, now);
  const { flowCoverage, filings } = ledgers;
  return assemblePayload({
    role,
    resolved,
    cfg,
    root,
    effective,
    piDefault,
    backend: effective.agent ?? "pi",
    fallback,
    fallbackFree,
    account,
    billingBackend,
    billingWindow,
    chainStep,
    modelsPath,
    minRunIntervalOverride,
    providerOverride,
    modelOverride,
    thinkingOverride,
    backendOverride,
    base,
    note,
    noteSavedAt,
    lessons,
    flowCoverage,
    filings,
    contextWindow,
    nextPrompt,
    schedule,
    quietHours,
    recentOutcomes,
    usage,
    dailyCap,
    dailyCapHitAt,
  });
}
