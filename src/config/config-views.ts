/** The config AS SEEN BY A RUN — pure derivations over a TumwaterConfig, split out of
 * config.ts: which provider/model/thinking a role, the reviewer, or the budget fallback
 * resolves to, and which timeout a reviewer run gets. No I/O and no caching — the
 * persistence side (defaults, loading, saving, the role-selection helpers) lives in
 * config.ts, the write side in config-write.ts. */
import { MODEL_TIERS, type AgentConfig, type FallbackModelConfig, type ModelTier, type TumwaterConfig } from "./config-schema.js";
import { formatModelSelector, parseModelSelector, routeModel, type ModelSelector } from "./model-selector.js";
import { isJsonObject } from "../files/json-object.js";
import { modelPairName } from "../budget/budget.js";
import { DIRECTOR_ROLE, roleById } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { modelFallbackActive, type ModelFallbackState } from "../loop/model-fallback.js";

/** A config whose model seam has been RESOLVED — the view functions' return type: `model`
 * is the concrete selector id piArgs consumes (the tier map, if any, has been resolved to
 * the seam's tier), so consumers of a role/reviewer/fallback view never see a map. `agent`
 * names the agent backend the selector routes to (plans/agent-backends.md); a provider naming
 * a registered agent id wins, any other provider routes to pi, a bare id or no model routes to
 * the top-level `agent`. */
export type ResolvedModelConfig = Omit<TumwaterConfig, "model" | "agent"> & {
  model?: string;
  /** The routed backend id; typed as a string so a test can register a fake backend under an
   * id outside the config schema's reserved set (src/agent/agent-backend.ts). */
  agent?: string;
};

/** The effective `agents.<id>` entry as a run sees it (plans/agent-backends.md "Back-compat"):
 * the file's own entry, with the legacy top-level `agentBin`/`piArgs` read as the pi backend's
 * `bin`/`args` when the new form leaves a field absent. Pure — it never writes those legacy
 * values back into `config.agents`, so a config write that re-serializes the merged config
 * cannot leak a second spelling into the file (which validateConfig would then reject).
 * pi-backend.ts and claude-backend.ts read `.bin` through resolveAgentBin (pi-bin.ts);
 * claude-backend.ts reads `.args` for passthrough argv. */
export function resolvedAgentConfig(
  config: { agents?: Record<string, AgentConfig>; agentBin?: string; piArgs?: string[] },
  id: string,
): AgentConfig {
  const entry = config.agents?.[id];
  // A view must own its array: returning the config's own `args` reference would let a caller
  // that appends passthrough argv silently mutate the loaded config, breaking the
  // purity promised above. `args` is the only mutable field, so a sliced copy suffices.
  if (id !== "pi") {
    if (entry === undefined) return {};
    return entry.args === undefined ? { ...entry } : { ...entry, args: entry.args.slice() };
  }
  return { bin: entry?.bin ?? config.agentBin, args: (entry?.args ?? config.piArgs ?? []).slice() };
}

/** True when `s` names one of the three tiers — the form `roles.<id>.model` /
 * `review.model` may take to point at that tier of the top-level `model` map. */
function isTierName(s: string | undefined): s is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(s as string);
}

/** The top-level `model` resolved at one tier (plans/model-tiers.md "Which tier each seam
 * uses"): a string form is the `default` tier's selector — parsed under the legacy
 * top-level `provider`, the old configs' meaning; a map form takes the tier's own entry,
 * else `default`'s (a tier left out inherits `default`), as a pure selector. Undefined
 * leaves pi's own default in charge. Map-form + legacy provider is a validation error, so
 * no legacy provider is in scope for a map's entries. */
function topTierSelector(config: TumwaterConfig, tier: ModelTier): ModelSelector | undefined {
  if (typeof config.model === "string")
    return parseModelSelector(config.model, config.provider);
  if (isJsonObject(config.model)) {
    const sel = config.model[tier] ?? config.model.default;
    return sel !== undefined ? parseModelSelector(sel) : undefined;
  }
  return undefined;
}

/** The selector one seam's tier resolves to at the top level — the tier's own map entry,
 * else `default`'s, else none (pi's own default). The pricing view (fleetModelsFree) and
 * the later tiered-fallback parts read this instead of re-deriving the resolution, so the
 * argv builder and the budget cannot disagree about which model a tier names. */
export function tierModel(config: TumwaterConfig, tier: ModelTier): ModelSelector | undefined {
  return topTierSelector(config, tier);
}

/** Apply a sub-config's optional provider/model/thinking overrides over the top-level
 * values — the one place that fallback lives, so adding an override field touches only
 * this. Every string `model` — the top level's and a section's — is a selector
 * (`provider/id[:thinking]`, plans/model-tiers.md): parsed into the triple piArgs consumes,
 * with a legacy provider in scope (the section's own, else the top level's) making the whole
 * string a bare id under it — the old configs' meaning. An explicit `thinking` key wins over
 * a selector's `:level` suffix, and a suffix beats the ambient top-level thinking, as the
 * key it overrides would.
 *
 * `tier` is the seam's effective tier, already resolved by the caller from any tier-name
 * override — so `o.model` here is always a selector string, never a tier reference. */
function withModelOverrides(
  config: TumwaterConfig,
  tier: ModelTier,
  o: { provider?: string; model?: string; thinking?: string },
): ResolvedModelConfig {
  // The top-level model resolves at the seam's tier: a string form is the default tier's
  // selector; a map form takes the tier's entry, else `default`'s.
  const topSel = topTierSelector(config, tier);
  const ownSel =
    o.model !== undefined ? parseModelSelector(o.model, o.provider ?? config.provider) : undefined;
  const provider = ownSel ? ownSel.provider : (o.provider ?? topSel?.provider ?? config.provider);
  const model = ownSel ? ownSel.model : topSel?.model;
  // The routed backend decides whether the provider half survives: a pi provider name is kept,
  // a backend namespace such as `claude` is dropped (that backend takes no provider).
  const routed = routeModel(provider, model, config.agent ?? "pi", tier);
  return {
    ...config,
    provider: routed.agent === "pi" ? provider : undefined,
    model: routed.model,
    thinking: o.thinking ?? ownSel?.thinking ?? topSel?.thinking ?? config.thinking,
    agent: routed.agent,
  };
}

/** The provider/model/thinking overrides a config section (a role entry or `review`) carries
 * into withModelOverrides: a tier-name `model` already chose the seam's tier, so it is not a
 * selector and drops out here. Shared by configForRole and reviewConfig. */
function seamOverrides(s: { provider?: string; model?: string; thinking?: string }): {
  provider?: string;
  model?: string;
  thinking?: string;
} {
  return {
    provider: s.provider,
    model: isTierName(s.model) ? undefined : s.model,
    thinking: s.thinking,
  };
}

/** The tier a role's model resolves at: a tier-name `roles.<id>.model` names it directly, and
 * every other role rides the model catalog's assignment. Exported for the per-tier budget gate's
 * pause set (src/gates/gate-polls.ts, part 5c/8) and the dashboards' per-role budget pause
 * (src/status/status-data.ts), which must resolve the SAME tier the seams resolve — the hold an
 * operator sees is the hold the scheduler enforces. */
export function roleSeamTier(config: TumwaterConfig, role: string): ModelTier {
  const m = config.roles[baseRoleOf(role)]?.model;
  if (isTierName(m)) return m;
  if (role === DIRECTOR_ROLE) return "strong";
  return roleById(role)?.tier ?? "default";
}

/** The config as seen by one role: role-level provider/model/thinking overrides applied
 * over the top-level values, plus the per-role minTickIntervalSeconds (a slow clock for
 * roles that should act rarely) falling back to the global value when unset. The role's
 * model resolves at its effective tier (roleSeamTier): a `model` map serves the tier the
 * catalog assigns (or `roles.<id>.model` names), a string form is the default tier. */
export function configForRole(config: TumwaterConfig, role: string): ResolvedModelConfig {
  const rc = config.roles[baseRoleOf(role)];
  const resolved = withModelOverrides(
    config,
    roleSeamTier(config, role),
    rc ? seamOverrides(rc) : {},
  );
  if (!rc) return resolved;
  return {
    ...resolved,
    minTickIntervalSeconds: rc.minTickIntervalSeconds ?? config.minTickIntervalSeconds,
  };
}

/** The config a role's ticks SCHEDULE from: configForRole, except that while the new-project
 * bootstrap is active (plans/work-ratio.md, part 2/2) the plan role schedules on the GLOBAL
 * minTickIntervalSeconds rather than its per-role 3600 s slow clock, so a young project gets a
 * steady stream of plans for feature. One home for the rule: isEligible enforces the same gap
 * when it decides whether plan may start, and loop-tick.ts hands this config to applyTickOutcome so
 * nextRunAt is scheduled from the same figure instead of the role default. */
export function scheduleConfigForRole(
  config: TumwaterConfig,
  role: string,
  bootstrapActive: boolean,
): ResolvedModelConfig {
  const resolved = configForRole(config, role);
  if (bootstrapActive && baseRoleOf(role) === "plan") {
    return { ...resolved, minTickIntervalSeconds: config.minTickIntervalSeconds };
  }
  return resolved;
}

/** The config as seen by the review gate's pi runs: the top-level `review` section's
 * optional provider/model/thinking overrides applied over the top-level values — so a
 * strong model can review what the cheap model wrote. Reads its own `review` section on
 * purpose (not via configForRole): a pseudo-role entry under `roles` would fail validation
 * (unknown role id) and, if accepted, spawn a runner with no catalog prompt. The reviewer's
 * model resolves at the `strong` tier — the seam where model quality matters most — unless
 * `review.model` names another tier. */
export function reviewConfig(config: TumwaterConfig): ResolvedModelConfig {
  const rm = config.review.model;
  return withModelOverrides(
    config,
    isTierName(rm) ? rm : "strong",
    seamOverrides(config.review),
  );
}

/** The config the landing conflict resolver runs on (plans/model-tiers.md, part 4/8): the
 * strong tier's model installed over the config the landing was handed — resolution is rare,
 * tolerant of latency, and edits code inside landing, so it rides the seam where model quality
 * matters most. It reads whatever config the landing carries — the role's per-tier budget
 * fallback view — so it follows the budget fallback's config (part 5a/8). No other overrides:
 * the session dir, raw log,
 * transient retry, and usage folding stay the authoring run's. */
export function resolverConfig(config: TumwaterConfig): ResolvedModelConfig {
  return withModelOverrides(config, "strong", {});
}

/** Default wall-clock budget for one reviewer run (`review.timeoutSeconds`). The reviewer holds
 * the landing slot the whole queue waits on, and its only other limits were the tick's budget
 * and the quiet watchdog: reviews measured 2026-09-22/23 ran 2.3 min median, 9.2 min p90 and
 * 24.6 min max, while earlier days had 1.5–3.5 h reviews. 15 min clears the ordinary review and
 * kills a wedged one in minutes instead of the tick's hours. */
export const REVIEW_TIMEOUT_S = 900;

/** The reviewer's wall-clock floor while the budget fallback carries the fleet. The free model
 * is typically local and far slower per turn than the budgeted one it replaces, but a review
 * still needs the same number of turns: measured 2026-09-30, 1,081 reviews on the budgeted
 * model took 7 turns at p50 and 15 at p90, while the local fallback managed one turn every
 * ~150–220 s — so REVIEW_TIMEOUT_S fit 4–7 turns, and none of the 21 reviews started in the
 * 09-28..09-30 fallback windows ever returned a verdict (14 timed out; BUGS.md 2026-09-30).
 * Every code change then looped review → timeout → re-land until midnight. An hour fits ~20
 * turns, past the p90 review. */
export const FALLBACK_REVIEW_TIMEOUT_S = 3600;

/** The config as seen by the gate's reviewer run: the reviewer's model wiring (reviewConfig)
 * with its own time budget — `review.timeoutSeconds`, default REVIEW_TIMEOUT_S — overriding
 * the tick's. A smaller tickTimeoutSeconds still wins. A still-progressing gate run gets one
 * extension of the same length (src/pi/pi-watchdogs.ts), so the effective ceiling on a large
 * diff's review is twice this budget. */
export function reviewRunConfig(config: TumwaterConfig): ResolvedModelConfig {
  const cfg = reviewConfig(config);
  return {
    ...cfg,
    tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S),
  };
}

/** The optional provider/model/thinking fields of a resolved model seam, with each unset
 * (empty) field left out so the result carries only what was resolved — the one home of that
 * assembly. Four call sites build a triple this way and follow the same rule:
 * fallbackSelectorFields (shared by fallbackPair's map and string branches and
 * tierOwnFallback), fallbackPair's legacy-object branch, role-view's RoleViewPayload (its
 * model fields), and modelFallbackView (the episode pair) — an absent or empty value is
 * omitted rather than written as undefined/"" (an empty selector field would read as
 * "override present," so it must not appear). */
export function resolvedModelFields(
  provider: string | undefined,
  model: string | undefined,
  thinking: string | undefined,
): Pick<FallbackModelConfig, "provider" | "model" | "thinking"> {
  const fields: Pick<FallbackModelConfig, "provider" | "model" | "thinking"> = {};
  if (provider) fields.provider = provider;
  if (model) fields.model = model;
  if (thinking) fields.thinking = thinking;
  return fields;
}

/** The resolved model fields of a pure `fallback` selector string: parsed as a pure selector
 * (no legacy provider in scope), with the ambient top-level thinking when the selector
 * carries none. fallbackPair's map and string branches and tierOwnFallback share this
 * assembly, so all three read one rule for how a `fallback` selector resolves. */
function fallbackSelectorFields(
  selector: string,
  config: TumwaterConfig,
): Pick<FallbackModelConfig, "provider" | "model" | "thinking"> {
  const parsed = parseModelSelector(selector);
  return resolvedModelFields(parsed.provider, parsed.model, parsed.thinking ?? config.thinking);
}

/** The `model` selector a run actually starts on, as an event/payload field: the resolved
 * provider/model/thinking triple formatted as one selector string, or an empty object when
 * no model id is resolved (pi's own default) — the key stays absent rather than empty, the
 * same empty-means-unset rule resolvedModelFields applies to the raw halves. One home of
 * that assembly and guard, shared by the two run-start event writers (loop-tick.ts's tick_start,
 * review.ts's review_start) and the per-loop status snapshot (status-data.ts) so the three
 * observability surfaces cannot disagree about which model a run starts on. A non-pi agent is
 * named as the selector's provider namespace (agentQualifiedSelector), so a claude run reads
 * `claude/claude-sonnet-5-5` in every surface instead of a bare model id. */
export function modelSelectorField(
  cfg: Pick<ResolvedModelConfig, "provider" | "model" | "thinking" | "agent">,
): { model?: string } {
  const { model } = cfg;
  return model ? { model: agentQualifiedSelector({ ...cfg, model }) } : {};
}

/** The resolved seam as one selector string, agent-qualified: a non-pi backend id is the
 * selector's provider namespace (`claude/claude-sonnet-5-5`), the form routeModel parses back
 * into that agent; a pi seam keeps `provider/model[:thinking]` byte-identical to before, since
 * pi's providers are real model providers, not a backend namespace. `model` is required — the
 * caller has already guarded that a model resolved (modelSelectorField). */
export function agentQualifiedSelector(cfg: {
  provider?: string;
  model: string;
  thinking?: string;
  agent?: string;
}): string {
  const base = formatModelSelector({ provider: cfg.provider, model: cfg.model, thinking: cfg.thinking });
  return cfg.agent && cfg.agent !== "pi" ? `${cfg.agent}/${base}` : base;
}

/** The key a resolved seam's fleet hold is filed under and the scheduler checks a role
 * against: a non-pi backend's own id (claude seams carry no pi provider), else the pi
 * provider (undefined for pi's own default). The failure hold and the subscription-window
 * hold both key on this, so a hold and the roles it gates cannot drift two ways. */
export function seamHoldKey(
  cfg: Pick<ResolvedModelConfig, "agent" | "provider">,
): string | undefined {
  return cfg.agent !== undefined && cfg.agent !== "pi" ? cfg.agent : cfg.provider;
}

/** The key a resolved seam's run counts against the per-provider cap
 * (plans/provider-concurrency.md §2): its hold key, else — for a pi seam that names no model
 * at all and so runs pi's saved default — the default provider from pi's settings
 * (`piDefault`, the caller's cached readPiDefaultModel result, so this view stays free of
 * I/O). A bare id with no provider, or a seam whose pi settings cannot name a default, yields
 * undefined: only the fleet total bounds it. HF sub-provider pins (`huggingface/…:deepinfra`)
 * share the base provider, and billing does not split claude, because this reuses the hold key
 * — "omlx is held" and "omlx is full" name the same thing on every surface. */
export function seamConcurrencyKey(
  cfg: Pick<ResolvedModelConfig, "agent" | "provider" | "model">,
  piDefault?: ModelSelector | null,
): string | undefined {
  const hold = seamHoldKey(cfg);
  if (hold !== undefined) return hold;
  if (cfg.model === undefined) return piDefault?.provider;
  return undefined;
}

/** The fleet's model wiring as one human-readable label, for the live-reload `model_changed`
 * event: null when no tier resolves to a model (pi's own default), the single selector when
 * every set tier agrees (the string-form `model`), and the `small=…, default=…, strong=…`
 * list when the tiers differ. Reading EVERY tier makes an edit to any tier's entry change the
 * label. */
export function fleetModelLabel(config: TumwaterConfig): string | null {
  const entries = MODEL_TIERS.map((tier) => {
    const sel = tierModel(config, tier);
    return sel ? { tier, label: formatModelSelector(sel) } : null;
  }).filter((e): e is { tier: ModelTier; label: string } => e !== null);
  if (entries.length === 0) return null;
  if (entries.every((e) => e.label === entries[0]!.label)) return entries[0]!.label;
  return entries.map((e) => `${e.tier}=${e.label}`).join(", ");
}

/** The fleet-level fallback pair: the `default` tier's resolved pair under
 * resolveTierFallbacks' borrow order, or null when the tier resolves to pause. The
 * selector-string `fallback` (plans/model-tiers.md), the legacy `fallbackModel` object, and
 * the map form all feed one resolution — a map with no `default` entry (or a `"pause"` one)
 * borrows another tier's pair exactly as the budget gate does, so this view and the gate
 * cannot disagree about which model the fleet would engage. `usable` filters the pairs that
 * may supply the answer: the default predicate admits every declared pair (the config-only
 * view), while a pricing predicate (src/pi/pi-models.ts's fallbackModelPair) yields the pair
 * the gate would actually engage when a declared `default` pair is priced and a free pair
 * exists at another tier. One definition so the freeness check, the dashboards' badge, the
 * doctor, and applyFallbackModel below cannot disagree. */
export function fallbackPair(
  config: TumwaterConfig,
  usable: (pair: FallbackModelConfig) => boolean = () => true,
): FallbackModelConfig | null {
  return resolveTierFallbacks(config, usable).default.pair;
}

/** The legacy `fallbackModel` object resolved to a pair: its own fields over the top-level
 * values, the same precedence every other override section uses. Private — reached only
 * through tierOwnFallback (the default tier's own fallback) and so fallbackPair's resolution,
 * which keeps the object and the string/map forms on one rule without recursing. */
function legacyFallbackPair(config: TumwaterConfig): FallbackModelConfig | null {
  const fbo = config.fallbackModel;
  if (!fbo) return null;
  // The top-level model is a selector too (parsed the same way withModelOverrides does), so a
  // fallback field that omits model borrows the parsed id, never the raw selector string.
  const topSel = topTierSelector(config, "default");
  const provider = fbo.provider ?? topSel?.provider ?? config.provider;
  const model = fbo.model ?? topSel?.model;
  const thinking = fbo.thinking ?? topSel?.thinking ?? config.thinking;
  return resolvedModelFields(provider, model, thinking);
}

/** One tier's budget-fallback resolution (plans/model-tiers.md "Budget fallback by tier"):
 * `pair` is the free pair the tier runs on at the cap, or null when the tier pauses; `from`
 * is the tier whose OWN fallback supplied the pair, or null when the tier runs its own. */
export interface TierFallback {
  pair: FallbackModelConfig | null;
  from: ModelTier | null;
}

/** The resolution of all three tiers, keyed by tier name. */
export type TierFallbackMap = Record<ModelTier, TierFallback>;

/** The order a tier borrows other tiers' own fallbacks in, after trying its own: small
 * climbs (small → default → strong), default keeps near itself (default → strong → small),
 * and strong never drops to a small model (strong → default → pause) — a weak reviewer or
 * planner does more harm than a paused one. */
const BORROW_ORDER: Record<ModelTier, readonly ModelTier[]> = {
  small: ["small", "default", "strong"],
  default: ["default", "strong", "small"],
  strong: ["strong", "default"],
};

/** A tier's OWN fallback pair — what the `fallback` key declares at that tier's map entry,
 * or (default only) the string form of `fallback` or the legacy `fallbackModel` object — or
 * undefined when the tier declares nothing or declares `"pause"` (an explicit opt-out, which
 * also makes it unborrowable: a tier with no own fallback offers nothing to borrow). Parsed
 * like fallbackPair: a pure selector, with the ambient top-level thinking when the selector
 * carries none. */
function tierOwnFallback(config: TumwaterConfig, tier: ModelTier): FallbackModelConfig | undefined {
  const fb = config.fallback;
  let selector: string | undefined;
  if (fb !== undefined) {
    // The top-level string form names the default tier's own fallback; `"pause"` is rejected
    // by validation but defensively names no model (matching the map entries below).
    if (typeof fb === "string") selector = tier === "default" && fb !== "pause" ? fb : undefined;
    else {
      const raw = fb[tier];
      if (raw !== undefined && raw !== "pause") selector = raw;
    }
  } else if (tier === "default") {
    // The legacy `fallbackModel` object is the default tier's own fallback, with its
    // provider/thinking fields and the top-level borrow precedence.
    return legacyFallbackPair(config) ?? undefined;
  }
  if (selector === undefined) return undefined;
  return fallbackSelectorFields(selector, config);
}

/** Which free pair each tier runs on at the daily cap (plans/model-tiers.md "Budget fallback
 * by tier", part 5a/8). A tier runs its own declared fallback when `usable(pair)`; otherwise
 * it borrows another tier's OWN fallback — never one that tier itself borrowed — in
 * BORROW_ORDER's order; otherwise it pauses (`pair: null`). The engine is pure: the caller
 * supplies `usable` (part 5b/8 wires it to pair pricing and the fallback breaker), so the
 * same rules are testable with a stub and the gates cannot disagree with each other. A
 * config with no fallback at all resolves every tier to pause, and a single `fallback: F`
 * reads as default's own pair, which small and strong then borrow — today's behavior. */
export function resolveTierFallbacks(
  config: TumwaterConfig,
  usable: (pair: FallbackModelConfig) => boolean,
): TierFallbackMap {
  const own = (tier: ModelTier) => {
    const pair = tierOwnFallback(config, tier);
    return pair !== undefined && usable(pair) ? pair : undefined;
  };
  const resolve = (tier: ModelTier): TierFallback => {
    const mine = own(tier);
    if (mine) return { pair: mine, from: null };
    for (const t of BORROW_ORDER[tier]) {
      if (t === tier) continue;
      const theirs = own(t);
      if (theirs) return { pair: theirs, from: t };
    }
    return { pair: null, from: null };
  };
  return { small: resolve("small"), default: resolve("default"), strong: resolve("strong") };
}

/** The config a role's ticks run on while a model-fallback episode is active (PLANS.md "Model
 * failure fallback, part 1/2"): the role's tier pair from resolveTierFallbacks (the tier's own
 * pair, else BORROW_ORDER's borrow), shaped like configForRole — provider/model/thinking over
 * the role's own and top-level values, plus the role's minTickIntervalSeconds. Null when the
 * tier resolves to pause (no fallback configured), so the feature stays off. Pure. */
export function fallbackRoleConfig(config: TumwaterConfig, role: string): ResolvedModelConfig | null {
  const tier = roleSeamTier(config, role);
  const pair = resolveTierFallbacks(config, () => true)[tier].pair;
  if (pair === null) return null;
  const rc = config.roles[baseRoleOf(role)];
  return {
    ...withModelOverrides(config, tier, {
      provider: pair.provider,
      model: pair.model,
      thinking: pair.thinking,
    }),
    minTickIntervalSeconds: rc?.minTickIntervalSeconds ?? config.minTickIntervalSeconds,
  };
}

/** The active model-fallback episode (LoopState.modelFallback) resolved for display: the
 * pair the role's ticks run on, when the episode began, and the provider-class failure that
 * tripped it. */
export interface ModelFallbackView {
  provider?: string;
  model?: string;
  thinking?: string;
  since: number;
  reason: string;
}

/** Build a ModelFallbackView for an episode, or null while the episode is not running the
 * fallback (no episode, or a due probe on the primary). role-view.ts's
 * RoleViewPayload.modelFallback and status/status-data.ts's per-loop row both build this
 * shape, so one function keeps the two surfaces from disagreeing about the pair, its start,
 * and its reason. `now` is the caller's clock (the status snapshot passes its own poll
 * clock), so a row and its poll agree on what "active" means. */
export function modelFallbackView(
  episode: ModelFallbackState | undefined,
  config: TumwaterConfig,
  role: string,
  now = Date.now(),
): ModelFallbackView | null {
  if (episode === undefined || !modelFallbackActive(episode, now)) return null;
  const episodeConfig = fallbackRoleConfig(config, role);
  if (episodeConfig === null) return null;
  return {
    ...resolvedModelFields(episodeConfig.provider, episodeConfig.model, episodeConfig.thinking),
    since: episode.since,
    reason: episode.reason,
  };
}

/** The per-tier fallback labels the observability surfaces render (part 7b/8): tier →
 * `provider/model[ (from <tier>)]` for every tier the resolution gives a pair, in tier order.
 * The `(from …)` suffix marks a borrowed pair — a strong-tier borrow is the fact an operator
 * reading the feed or the badge can act on. Tiers resolved to pause are left out: the badge
 * and the event name the pairs that RUN, the pause story lives on the pause events and the
 * per-role rows. */
export function tierFallbackLabels(resolved: TierFallbackMap): Partial<Record<ModelTier, string>> {
  const out: Partial<Record<ModelTier, string>> = {};
  for (const tier of MODEL_TIERS) {
    const r = resolved[tier];
    if (r.pair !== null)
      out[tier] = modelPairName(r.pair) + (r.from !== null ? ` (from ${r.from})` : "");
  }
  return out;
}

/** True when the resolution hands out two or more DISTINCT pairs — the condition under which
 * the tiered surfaces (the budget_fallback event, the header badge) switch from today's
 * single-pair text to the tier list: a single fallback whose pair the other tiers borrow
 * resolves every tier to the same pair, and that stays on the single-pair text, byte
 * identical to the pre-tier surfaces. */
export function tiersResolveDistinctPairs(resolved: TierFallbackMap): boolean {
  const pairs = MODEL_TIERS.map((t) => resolved[t].pair)
    .filter((p) => p !== null)
    .map((p) => modelPairName(p));
  return new Set(pairs).size >= 2;
}

/** Drop a model-override seam's provider/model/thinking fields — the one rule the fallback
 * view's role and reviewer strips share, so a field on that triple cannot be dropped from one
 * and left on the other (where it would reach a priced model after the cap). */
function stripModel<T extends { provider?: string; model?: string; thinking?: string }>(o: T): T {
  const { provider: _p, model: _m, thinking: _t, ...rest } = o;
  return rest as T;
}

/** The reviewer config as the fallback view sees it: model seam stripped, and its time budget
 * raised to at least FALLBACK_REVIEW_TIMEOUT_S (a budget sized for the budgeted model's turns
 * times out every review on a slower free one; a configured value above the floor stands). The
 * one home of that rule, shared by both fallback branches. */
function fallbackReview(review: TumwaterConfig["review"]): TumwaterConfig["review"] {
  return {
    ...stripModel(review),
    timeoutSeconds: Math.max(review.timeoutSeconds ?? REVIEW_TIMEOUT_S, FALLBACK_REVIEW_TIMEOUT_S),
  };
}

/** Every `roles.<id>` entry with its model seam stripped. With `keepTierNames`, an entry whose
 * model is a tier name is left untouched: the resolved tier map now serves that tier itself, so
 * the reference stays valid (stripping it would lose the role's tier). */
function stripRoleModels(
  roles: TumwaterConfig["roles"],
  keepTierNames: boolean,
): TumwaterConfig["roles"] {
  return Object.fromEntries(
    Object.entries(roles).map(([id, rc]) => [
      id,
      keepTierNames && isTierName(rc?.model) ? rc : stripModel(rc),
    ]),
  );
}

/** Every `roles.<id>` entry with its model seam stripped, except a seam `free` calls free — a
 * subscription claude role keeps its own model through the cap rather than moving to the
 * fallback (plans/agent-backends.md "Free-ness"). With `keepTierNames`, an entry whose model is
 * a tier name is left untouched: the resolved tier map now serves that tier itself, so the
 * reference stays valid (stripping it would lose the role's tier). */
function freeRoleModels(
  config: TumwaterConfig,
  free?: (seam: { agent?: string; provider?: string; model?: string }) => boolean,
): TumwaterConfig["roles"] {
  return Object.fromEntries(
    Object.entries(config.roles).map(([id, rc]) => {
      if (rc && free?.(withModelOverrides(config, roleSeamTier(config, id), rc))) return [id, rc];
      return [id, isTierName(rc?.model) ? rc : stripModel(rc)];
    }),
  );
}

/** The config as seen by a role loop running on the free fallback model
 * (plans/fallback-model.md): the fallback's provider/model/thinking installed as the top-level
 * values AND every per-role and reviewer model override dropped, so that EVERY seam that could
 * otherwise reach a priced model — an author run, its reviewer, a conflict resolver — resolves
 * to the one free pair. Dropping the overrides is the point: a role pinned to a paid model in
 * tumwater.json must not keep spending after the cap is reached. The one other change is the
 * reviewer's time budget, raised to at least FALLBACK_REVIEW_TIMEOUT_S: a budget sized for the
 * budgeted model's turns times out every review on a slower free one (a configured
 * `review.timeoutSeconds` above the floor stands, and reviewRunConfig still caps it at
 * tickTimeoutSeconds). Everything else (intervals, thresholds, exempt paths, the cap itself) is
 * unchanged when no fallback is configured. With a per-tier `resolved` map (resolveTierFallbacks,
 * part 5a/8) the model map is rewritten to the resolved pairs instead — each seam keeps its
 * tier: `model[tier]` becomes the tier's pair as a selector string, a tier resolved to pause
 * is left out (it inherits default's entry, harmless because the gate holds its roles), raw
 * per-role selector overrides are dropped so a paid pin cannot keep spending, and tier-name
 * role overrides (`roles.<id>.model: "strong"`) are kept since the map now serves the tier
 * itself. The director's exemption lives in the gates (roleForConfig), not here. A
 * subscription claude seam is never moved (`free`): the gate passes one predicate over the
 * resolved seam, so a free tier keeps its own primary in the map — with the ambient thinking
 * level it resolved with — a free role keeps its own override, and a free reviewer keeps its own
 * model, while every priced seam still lands on its tier's fallback pair. */
export function applyFallbackModel(
  config: TumwaterConfig,
  resolved?: TierFallbackMap,
  free?: (seam: { agent?: string; provider?: string; model?: string }) => boolean,
): TumwaterConfig {
  if (resolved) {
    const selectorOf = (f: TierFallback) =>
      f.pair
        ? formatModelSelector({
            provider: f.pair.provider,
            model: f.pair.model ?? "",
            thinking: f.pair.thinking,
          })
        : undefined;
    const model: Partial<Record<ModelTier, string>> = {};
    for (const tier of MODEL_TIERS) {
      // A free seam keeps the tier's own primary selector — the backend namespace a resolved
      // seam has cleared, plus the ambient thinking level `topTierSelector` alone omits. A moved
      // seam gets its pair selector, which already carries that ambient level.
      const seam = withModelOverrides(config, tier, {});
      if (free?.(seam)) {
        const own = topTierSelector(config, tier);
        if (own !== undefined)
          model[tier] = formatModelSelector({ ...own, thinking: own.thinking ?? config.thinking });
        // A tier with no top-level selector — `agent: "claude"` riding its agent default —
        // has no own selector to carry the level, so name the routed default plus it.
        else if (seam.model !== undefined)
          model[tier] = formatModelSelector({
            provider: seam.provider,
            model: seam.model,
            thinking: seam.thinking,
          });
        continue;
      }
      const sel = selectorOf(resolved[tier]);
      if (sel !== undefined) model[tier] = sel;
    }
    return {
      ...config,
      provider: undefined,
      model,
      thinking: undefined,
      review: free?.(reviewConfig(config)) ? config.review : fallbackReview(config.review),
      roles: freeRoleModels(config, free),
    };
  }
  const pair = fallbackPair(config);
  if (!pair) return config;
  return {
    ...config,
    provider: pair.provider,
    model: pair.model,
    thinking: pair.thinking,
    review: fallbackReview(config.review),
    roles: stripRoleModels(config.roles, false),
  };
}
