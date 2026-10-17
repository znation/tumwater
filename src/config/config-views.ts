// vocabulary: plain
/** The config AS SEEN BY A RUN — the per-seam resolution half of the config views, split out
 * of config.ts: which provider/model/thinking a role, the reviewer, or the conflict resolver
 * resolves to, and which timeout a reviewer run gets. The budget/tier fallback side — which
 * free pair the team runs on at the daily cap, and the per-role fallback config (fallbackPair,
 * resolveTierFallbacks, applyFallbackModel, …) — lives in config-fallbacks.ts, which builds on
 * this module one-way. No I/O and no caching — the persistence side (defaults, loading,
 * saving, the role-selection helpers) lives in config.ts, the write side in config-write.ts. */
import { MODEL_TIERS, type AgentConfig, type FallbackModelConfig, type ModelTier, type TumwaterConfig } from "./config-schema.js";
import { formatModelSelector, isAgentId, parseModelSelector, routeModel, type ModelSelector } from "./model-selector.js";
import { modelPairName } from "../budget/budget.js";
import { isJsonObject } from "../files/json-object.js";
import { DIRECTOR_ROLE, roleById } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";

/** A config whose model seam has been RESOLVED — the view functions' return type: `model`
 * is the concrete selector id piArgs consumes (the tier map, if any, has been resolved to
 * the seam's tier), so consumers of a role/reviewer/fallback view never see a map. `agent`
 * names the agent backend the selector routes to (plans/agent-backends.md); a provider naming
 * a registered agent id wins, any other provider routes to pi, a bare id or no model routes to
 * the top-level `backend`. */
export type ResolvedModelConfig = Omit<TumwaterConfig, "model"> & {
  model?: string;
  /** The routed backend id; typed as a string so a test can register a fake backend under an
   * id outside the config schema's reserved set (src/agent/agent-backend.ts). */
  agent?: string;
};

/** The effective `backends.<id>` entry as a run sees it (plans/agent-backends.md "Back-compat"):
 * the file's own entry, with the legacy top-level `agentBin`/`piArgs` read as the pi backend's
 * `bin`/`args` when the new form leaves a field absent. Pure — it never writes those legacy
 * values back into `config.backends`, so a config write that re-serializes the merged config
 * cannot leak a second spelling into the file (which validateConfig would then reject).
 * pi-backend.ts and claude-backend.ts read `.bin` through resolveAgentBin (pi-bin.ts);
 * claude-backend.ts reads `.args` for passthrough argv. */
export function resolvedAgentConfig(
  config: { backends?: Record<string, AgentConfig>; agentBin?: string; piArgs?: string[] },
  id: string,
): AgentConfig {
  const entry = config.backends?.[id];
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
export function isTierName(s: string | undefined): s is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(s as string);
}

/** The top-level `model` resolved at one tier (plans/model-tiers.md "Which tier each seam
 * uses"): a string form is the `default` tier's selector — parsed under the legacy
 * top-level `provider`, the old configs' meaning; a map form takes the tier's own entry,
 * else `default`'s (a tier left out inherits `default`), as a pure selector. Undefined
 * leaves pi's own default in charge. Map-form + legacy provider is a validation error, so
 * no legacy provider is in scope for a map's entries. */
export function topTierSelector(config: TumwaterConfig, tier: ModelTier): ModelSelector | undefined {
  if (typeof config.model === "string")
    return parseModelSelector(config.model, config.provider);
  if (isJsonObject(config.model)) {
    const sel = config.model[tier] ?? config.model.default;
    return sel !== undefined ? parseModelSelector(sel) : undefined;
  }
  return undefined;
}

/** The selector one seam's tier resolves to at the top level — the tier's own map entry,
 * else `default`'s, else none (pi's own default). The pricing view (teamModelsFree) and
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
 * override — so `o.model` here is always a selector string, never a tier reference.
 *
 * Exported so imageRerouteTarget (src/agent/image-input.ts) can probe a peer tier's
 * top-level model (`withModelOverrides(config, tier, {})`, the same shape resolverConfig
 * builds strong with) and reshape a tier's fallback pair into a runnable config — the
 * tier-config builder the plan names. */
export function withModelOverrides(
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
  const routed = routeModel(provider, model, config.backend ?? "pi", tier);
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
 * over the top-level values, plus the per-role minRunIntervalSeconds (a slow clock for
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
    minRunIntervalSeconds: rc.minRunIntervalSeconds ?? config.minRunIntervalSeconds,
  };
}

/** The config a role's ticks SCHEDULE from: configForRole, except that while the new-project
 * bootstrap is active (plans/work-ratio.md, part 2/2) the plan role schedules on the GLOBAL
 * minRunIntervalSeconds rather than its per-role 3600 s slow clock, so a young project gets a
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
    return { ...resolved, minRunIntervalSeconds: config.minRunIntervalSeconds };
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

/** The reviewer's wall-clock floor while the budget fallback carries the team. The free model
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
 * the tick's. A smaller runTimeoutSeconds still wins. A still-progressing gate run gets one
 * extension of the same length (src/pi/pi-watchdogs.ts), so the effective ceiling on a large
 * diff's review is twice this budget. */
export function reviewRunConfig(config: TumwaterConfig): ResolvedModelConfig {
  const cfg = reviewConfig(config);
  return {
    ...cfg,
    runTimeoutSeconds: Math.min(cfg.runTimeoutSeconds, config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S),
  };
}

/** The optional provider/model/thinking fields of a resolved model seam, with each unset
 * (empty) field left out so the result carries only what was resolved — the one home of that
 * assembly. The fallback layer (config-fallbacks.ts's fallbackSelectorFields and
 * fallbackPair/tierOwnFallback/modelFallbackView) and role-view's RoleViewPayload (its
 * model fields) all build a triple this way and follow the same rule — an absent or empty
 * value is
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

/** The `model` selector a run actually starts on, as an event/payload field: the resolved
 * provider/model/thinking triple formatted as one selector string, or an empty object when
 * no model id is resolved (pi's own default) — the key stays absent rather than empty, the
 * same empty-means-unset rule resolvedModelFields applies to the raw halves. One home of
 * that assembly and guard, shared by the two run-start event writers (loop-tick.ts's run_start,
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

/** The key a resolved seam's team hold is filed under and the scheduler checks a role
 * against: a non-pi backend's own id (claude seams carry no pi provider), else the pi
 * provider (undefined for pi's own default). The failure hold and the subscription-window
 * hold both key on this, so a hold and the roles it gates cannot drift two ways. */
export function seamHoldKey(
  cfg: Pick<ResolvedModelConfig, "agent" | "provider">,
): string | undefined {
  return cfg.agent !== undefined && cfg.agent !== "pi" ? cfg.agent : cfg.provider;
}

/** The `modelPairName` a resolved seam's run is charged under (LoopState.dayCostByPair): the
 * routed backend's id stands in for the provider on a non-pi seam, exactly as the fallback
 * pairs carry it (config-fallbacks.ts's seamKeyedFallbackProvider), so a run and the chain
 * step it ran on name one key. */
export function seamPairName(
  cfg: Pick<ResolvedModelConfig, "agent" | "provider" | "model">,
): string {
  return modelPairName({ provider: seamHoldKey(cfg), model: cfg.model });
}

/** The key a resolved seam's run counts against the per-provider cap
 * (plans/provider-concurrency.md §2): its hold key, else — for a pi seam that names no model
 * at all and so runs pi's saved default — the default provider from pi's settings
 * (`piDefault`, the caller's cached readPiDefaultModel result, so this view stays free of
 * I/O). A bare id with no provider, or a seam whose pi settings cannot name a default, yields
 * undefined: only the team total bounds it. HF sub-provider pins (`huggingface/…:deepinfra`)
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

/** The team's model wiring as one human-readable label, for the live-reload `model_changed`
 * event: null when no tier resolves to a model (pi's own default), the single selector when
 * every set tier agrees (the string-form `model`), and the `small=…, default=…, strong=…`
 * list when the tiers differ. Reading EVERY tier makes an edit to any tier's entry change the
 * label. Each tier's label is agent-qualified (agentQualifiedSelector), so flipping the
 * top-level `agent` over a bare-id model relabels every tier and the reload now emits
 * `model_changed` — a team's backend is part of what it runs (PLANS.md "Mixed claude + pi
 * fleets, part 3/4"), and an edit that moves a bare id to another backend must not read as
 * "nothing changed". */
export function teamModelLabel(config: TumwaterConfig): string | null {
  const entries = MODEL_TIERS.map((tier) => {
    const sel = tierModel(config, tier);
    if (!sel) return null;
    const { agent } = routeModel(sel.provider, sel.model, config.backend ?? "pi", tier);
    return { tier, label: agentQualifiedSelector({ ...sel, agent }) };
  }).filter((e): e is { tier: ModelTier; label: string } => e !== null);
  if (entries.length === 0) return null;
  if (entries.every((e) => e.label === entries[0]!.label)) return entries[0]!.label;
  return entries.map((e) => `${e.tier}=${e.label}`).join(", ");
}

/** One fallback pair rendered for display, agent-qualified (PLANS.md "Mixed claude + pi
 * fleets, part 3/4" gap 7): a pair routed to a non-pi backend — its `provider` is that
 * backend's id, per seamKeyedFallbackProvider, so `claude` — renders as `claude/claude-sonnet-5-5`,
 * the same agent-qualified form every other surface carries; a pi pair keeps the bare model
 * byte-identical to before (the badge, the team alert and `tumwater role` all name the
 * model a pi fallback runs, never its provider). Falls back through the provider to the
 * caller's `<agent> default` label when both halves are absent. One home so the three display
 * surfaces cannot render one fallback two ways. */
export function fallbackDisplayPair(
  pair: { provider?: string; model?: string } | null,
  agentDefault: string,
): string {
  const p = pair ?? {};
  if (p.model !== undefined)
    return p.provider !== undefined && isAgentId(p.provider) ? `${p.provider}/${p.model}` : p.model;
  if (p.provider !== undefined) return p.provider;
  return agentDefault;
}
