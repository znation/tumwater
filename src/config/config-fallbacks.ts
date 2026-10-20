// vocabulary: plain
/** The budget/tier FALLBACK side of the config views, split out of config-views.ts: how the
 * team falls back at the daily spend cap — which free pair each tier runs on
 * (resolveTierFallbacks and its BORROW_ORDER), the per-role fallback config a model-failure
 * or cap episode hands a role (fallbackRoleConfig, applyFallbackModel), and the surfaces
 * that name those pairs (seamsInUse, modelFallbackView, tierFallbackLabels). The per-seam
 * resolution these build on — how one role/reviewer/resolver provider/model/thinking resolves
 * (configForRole, reviewConfig, withModelOverrides, …) — stays in config-views.ts, so the
 * one-way dependency runs fallback → seam and never back. Pure, like its sibling: no I/O and
 * no caching. */
import {
  MODEL_TIERS,
  type FallbackModelConfig,
  type FallbackStep,
  type ModelSelectorEntry,
  type ModelTier,
  type TumwaterConfig,
} from "./config-schema.js";
import { formatModelSelector, isAgentId, parseModelSelector, routeModel } from "./model-selector.js";
import { modelPairName } from "../budget/budget.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { enabledRoleIds } from "./config.js";
import { modelFallbackActive, type ModelFallbackState } from "../runner/model-fallback.js";
import {
  FALLBACK_REVIEW_TIMEOUT_S,
  REVIEW_TIMEOUT_S,
  configForRole,
  isTierName,
  resolvedModelFields,
  resolverConfig,
  reviewConfig,
  reviewRunConfig,
  roleSeamTier,
  topTierBackend,
  topTierSelector,
  withModelOverrides,
  type ResolvedModelConfig,
} from "./config-views.js";

/** The resolved model fields of a pure `fallback` selector string: parsed as a pure selector
 * (no legacy provider in scope), with the ambient top-level thinking when the selector
 * carries none. fallbackPair's map and string branches and tierOwnChain share this
 * assembly, so all three read one rule for how a `fallback` selector resolves. */
function fallbackSelectorFields(
  selector: string,
  config: TumwaterConfig,
  backend?: string,
): Pick<FallbackModelConfig, "provider" | "model" | "thinking"> {
  const parsed = parseModelSelector(selector);
  if (backend !== undefined) {
    // An explicit step backend is the pair's agent and takes the id as written (routeModel);
    // the provider keeps its seam-keyed meaning: pi's own provider, else the backend's name.
    const routed = routeModel(parsed.provider, parsed.model, config.backend ?? "pi", "default", backend);
    return resolvedModelFields(
      backend !== "pi" ? backend : parsed.provider,
      routed.model,
      parsed.thinking ?? config.thinking,
    );
  }
  return resolvedModelFields(
    seamKeyedFallbackProvider(config, parsed.provider),
    parsed.model,
    parsed.thinking ?? config.thinking,
  );
}

/** A fallback pair's provider keyed by the seam it routes to (PLANS.md "Mixed claude + pi
 * fleets, part 2/4"): a pair that routes to a non-pi backend carries that backend's name as
 * its provider — `claude/claude-sonnet-5-5` and a bare `claude-sonnet-5-5` on a claude
 * team both read `claude` — so the budget gate's handback (gate-polls.ts's tickOnPair
 * against the tick's seamHoldKey capture, runner-run.ts's setTickPair) matches a tick on
 * either selector form. The same routing rule as routeModel: a provider naming an agent is
 * that agent, no provider runs on the config's `agent`, anything else is pi, which keeps
 * its own provider (a bare pi selector keeps undefined, exactly as before). */
function seamKeyedFallbackProvider(
  config: TumwaterConfig,
  provider: string | undefined,
): string | undefined {
  const agent = provider === undefined ? config.backend : isAgentId(provider) ? provider : "pi";
  return agent !== "pi" ? agent : provider;
}

/** The team-level fallback pair: the `default` tier's resolved pair under
 * resolveTierFallbacks' borrow order, or null when the tier resolves to pause. The
 * selector-string `fallback` (plans/model-tiers.md), the legacy `fallbackModel` object, and
 * the map form all feed one resolution — a map with no `default` entry (or a `"pause"` one)
 * borrows another tier's pair exactly as the budget gate does, so this view and the gate
 * cannot disagree about which model the team would engage. `usable` filters the pairs that
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
 * through tierOwnChain (the default tier's own fallback) and so fallbackPair's resolution,
 * which keeps the object and the string/map forms on one rule without recursing. */
function legacyFallbackPair(config: TumwaterConfig): FallbackModelConfig | null {
  const fbo = config.fallbackModel;
  if (!fbo) return null;
  // The top-level model is a selector too (parsed the same way withModelOverrides does), so a
  // fallback field that omits model borrows the parsed id, never the raw selector string.
  const topSel = topTierSelector(config, "default");
  const provider = seamKeyedFallbackProvider(config, fbo.provider ?? topSel?.provider ?? config.provider);
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
  /** The 0-based index in the supplying tier's chain of the step `pair` came from, set only
   * for a later step (absent means the first step, or no pair): a first-step resolution keeps
   * the `{ pair, from }` shape every existing consumer compares against. */
  step?: number;
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

/** Exported for imageRerouteTarget (src/agent/image-input.ts), which walks a rerouting role's
 * tier through the same borrow order the budget fallback uses (skipping the tier itself), and
 * for the doctor's `image input` check naming the tier a text-only role reroutes to. */
export { BORROW_ORDER };

type FallbackChain = FallbackStep | FallbackStep[];

/** A tier's OWN fallback chain, first step first — what the `fallback` key declares at that
 * tier's map entry (a selector or a list of them), or (default only) the string/list form of
 * `fallback` or the legacy `fallbackModel` object (a one-element chain). Empty when the tier
 * declares nothing or declares `"pause"` (an explicit opt-out, which also makes it
 * unborrowable: a tier with no own fallback offers nothing to borrow). Each step is parsed
 * like fallbackPair: a pure selector, with the ambient top-level thinking when the selector
 * carries none. */
function tierOwnChain(config: TumwaterConfig, tier: ModelTier): FallbackModelConfig[] {
  const fb = config.fallback;
  let raw: FallbackChain | undefined;
  if (fb !== undefined) {
    // The top-level string/list form names the default tier's own chain; `"pause"` is rejected
    // by validation but defensively names no model (matching the map entries below).
    if (typeof fb === "string" || Array.isArray(fb)) raw = tier === "default" ? fb : undefined;
    else raw = fb[tier];
  } else if (tier === "default") {
    // The legacy `fallbackModel` object is the default tier's own fallback, with its
    // provider/thinking fields and the top-level borrow precedence.
    const legacy = legacyFallbackPair(config);
    if (legacy === null) return [];
    const primaryClaude = withModelOverrides(config, tier, {}).agent === "claude";
    return [legacy.provider === "claude" && primaryClaude ? { ...legacy, extraUsage: true } : legacy];
  }
  if (raw === undefined || raw === "pause") return [];
  // A Claude step after an earlier Claude model — the tier's primary counts — may spend extra
  // usage; the first Claude model stays on the subscription. Position alone decides.
  let claudeSeen = withModelOverrides(config, tier, {}).agent === "claude";
  return (Array.isArray(raw) ? raw : [raw])
    .filter((s) => s !== "pause")
    .map((s) => {
      const step: { backend?: string; model: string; maxDailyCostUsd?: number } =
        typeof s === "string" ? { model: s } : s;
      const fields = fallbackSelectorFields(step.model, config, step.backend);
      const extraUsage = fields.provider === "claude" && claudeSeen;
      if (fields.provider === "claude") claudeSeen = true;
      return {
        ...fields,
        ...(step.maxDailyCostUsd !== undefined ? { maxDailyCostUsd: step.maxDailyCostUsd } : {}),
        ...(extraUsage ? { extraUsage } : {}),
      };
    });
}

/** Every step of every tier's own chain, as the pair and its 0-based index in that chain — the
 * enumeration the budget gate keys its breakers by and seamsInUse checks binaries over. */
export function tierChainSteps(
  config: TumwaterConfig,
): { tier: ModelTier; step: number; pair: FallbackModelConfig }[] {
  return MODEL_TIERS.flatMap((tier) =>
    tierOwnChain(config, tier).map((pair, step) => ({ tier, step, pair })),
  );
}

const stepField = (step: number): { step?: number } => (step > 0 ? { step } : {});

/** Which free pair each tier runs on at the daily cap (plans/model-tiers.md "Budget fallback
 * by tier", part 5a/8). A tier runs the first `usable(pair)` step of its own declared chain;
 * otherwise it borrows the first usable step of another tier's OWN chain — never one that
 * tier itself borrowed — in BORROW_ORDER's order; otherwise it pauses (`pair: null`). The
 * engine is pure: the caller supplies `usable` (part 5b/8 wires it to pair pricing and the
 * fallback breaker), so the same rules are testable with a stub and the gates cannot disagree
 * with each other. A config with no fallback at all resolves every tier to pause, and a single
 * `fallback: F` reads as default's own pair, which small and strong then borrow — today's
 * behavior. */
export function resolveTierFallbacks(
  config: TumwaterConfig,
  usable: (pair: FallbackModelConfig) => boolean,
): TierFallbackMap {
  const firstUsable = (tier: ModelTier): { pair: FallbackModelConfig; step: number } | undefined => {
    const chain = tierOwnChain(config, tier);
    const step = chain.findIndex((p) => usable(p));
    return step < 0 ? undefined : { pair: chain[step]!, step };
  };
  const resolve = (tier: ModelTier): TierFallback => {
    const mine = firstUsable(tier);
    if (mine) return { pair: mine.pair, from: null, ...stepField(mine.step) };
    for (const t of BORROW_ORDER[tier]) {
      if (t === tier) continue;
      const theirs = firstUsable(t);
      if (theirs) return { pair: theirs.pair, from: t, ...stepField(theirs.step) };
    }
    return { pair: null, from: null };
  };
  return { small: resolve("small"), default: resolve("default"), strong: resolve("strong") };
}

/** The config a role's ticks run on while a model-fallback episode is active (PLANS.md "Model
 * failure fallback, part 1/2"): the role's tier pair from resolveTierFallbacks (the tier's own
 * pair, else BORROW_ORDER's borrow), shaped like configForRole — provider/model/thinking over
 * the role's own and top-level values, plus the role's minRunIntervalSeconds. Null when the
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
    minRunIntervalSeconds: rc?.minRunIntervalSeconds ?? config.minRunIntervalSeconds,
  };
}

/** One seam the team can spawn, with the human label that names it and the resolved routing
 * a run gets — the single enumeration the startup gate, doctor, and the claude-account seed
 * and live-edit reload sweep, so a seam that exists only as a fallback is checked exactly like
 * a primary one. `agent` names the routed backend, `provider`/`model`/`thinking` the resolved
 * selector (provider is pi's and undefined for a non-pi backend). */
interface SeamInUse {
  /** The label naming this seam in doctor's routing table and doctor/live-edit messages: a
   * role id, "review", "resolver", "director", or a `fallback:<tier>` name. */
  label: string;
  agent?: string;
  provider?: string;
  model?: string;
  thinking?: string;
}

/** Every seam the team can spawn, each with its label: every enabled role's resolved config
 * (configForRole), the review gate when it is on (reviewRunConfig), the conflict resolver
 * (resolverConfig), the director (a catalog role, named explicitly so it is never missed), and
 * each tier's budget fallback (resolveTierFallbacks) — the model-failure fallback
 * (fallbackRoleConfig) runs the same tier pair, so one enumeration covers it. Deduplicated by
 * label + routed pair so a seam reached through several surfaces is listed once. Read by the
 * startup gate's agent list, doctor's pair sweep (and so its binary/credential/version checks
 * and routing table), and the live-edit reload's newly-routed-backend check — no surface can
 * miss a seam that exists only as a fallback. */
export function seamsInUse(config: TumwaterConfig): SeamInUse[] {
  const seams = new Map<string, SeamInUse>();
  const add = (label: string, cfg: Pick<ResolvedModelConfig, "agent" | "provider" | "model" | "thinking">): void => {
    const key = `${label}\0${cfg.agent ?? ""}\0${cfg.provider ?? ""}\0${cfg.model ?? ""}\0${cfg.thinking ?? ""}`;
    seams.set(key, {
      label,
      agent: cfg.agent,
      provider: cfg.provider,
      model: cfg.model,
      thinking: cfg.thinking,
    });
  };
  for (const role of enabledRoleIds(config)) add(role, configForRole(config, role));
  if (config.review.enabled) add("review", reviewRunConfig(config));
  add("resolver", resolverConfig(config));
  add("director", configForRole(config, DIRECTOR_ROLE));
  for (const { tier, step, pair } of tierChainSteps(config)) {
    add(
      step === 0 ? `fallback:${tier}` : `fallback:${tier}#${step}`,
      withModelOverrides(config, tier, { provider: pair.provider, model: pair.model, thinking: pair.thinking }),
    );
  }
  return [...seams.values()];
}

/** The active model-fallback episode (RunnerState.modelFallback) resolved for display: the
 * pair the role's ticks run on, when the episode began, and the provider-class failure that
 * tripped it. */
export interface ModelFallbackView {
  provider?: string;
  model?: string;
  thinking?: string;
  /** The backend the fallback pair routes to — its own id for a non-pi agent (`claude`),
   * else `pi` — carried so the role view qualifies the pair the same way every other
   * surface does (PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7). */
  backend?: string;
  since: number;
  reason: string;
}

/** Build a ModelFallbackView for an episode, or null while the episode is not running the
 * fallback (no episode, or a due probe on the primary). role-view.ts's
 * RoleViewPayload.modelFallback and status/status-data.ts's per-role row both build this
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
    ...(episodeConfig.agent !== undefined && episodeConfig.agent !== "pi" ? { backend: episodeConfig.agent } : {}),
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

/** Drop a model-override seam's provider/model/backend/thinking fields — the one rule the fallback
 * view's role and reviewer strips share, so a field on that triple cannot be dropped from one
 * and left on the other (where it would reach a priced model after the cap). */
function stripModel<
  T extends { provider?: string; model?: string; backend?: string; thinking?: string },
>(o: T): T {
  const { provider: _p, model: _m, backend: _b, thinking: _t, ...rest } = o;
  return rest as T;
}

/** Drop only a seam's explicit backend, for a tier-name entry kept through the cap: the tier
 * reference stays valid, but a paid `backend` pinned beside it must not outlive the cap. */
function stripBackend<T extends { backend?: string }>(o: T): T {
  const { backend: _b, ...rest } = o;
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
      keepTierNames && isTierName(rc?.model) ? stripBackend(rc) : stripModel(rc),
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
      return [id, isTierName(rc?.model) ? stripBackend(rc) : stripModel(rc)];
    }),
  );
}

/** The config as seen by a role running on the free fallback model
 * (plans/fallback-model.md): the fallback's provider/model/thinking installed as the top-level
 * values AND every per-role and reviewer model override dropped, so that EVERY seam that could
 * otherwise reach a priced model — an author run, its reviewer, a conflict resolver — resolves
 * to the one free pair. Dropping the overrides is the point: a role pinned to a paid model in
 * tumwater.json must not keep spending after the cap is reached. The one other change is the
 * reviewer's time budget, raised to at least FALLBACK_REVIEW_TIMEOUT_S: a budget sized for the
 * budgeted model's turns times out every review on a slower free one (a configured
 * `review.timeoutSeconds` above the floor stands, and reviewRunConfig still caps it at
 * runTimeoutSeconds). Everything else (intervals, thresholds, exempt paths, the cap itself) is
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
    const model: Partial<Record<ModelTier, string | ModelSelectorEntry>> = {};
    const stepCaps: Record<string, number> = {};
    for (const tier of MODEL_TIERS) {
      // A free seam keeps the tier's own primary selector — the backend namespace a resolved
      // seam has cleared, plus the ambient thinking level `topTierSelector` alone omits. A moved
      // seam gets its pair selector, which already carries that ambient level.
      const seam = withModelOverrides(config, tier, {});
      if (free?.(seam)) {
        const own = topTierSelector(config, tier);
        // A tier entry that names a backend keeps it as an object entry: a bare selector string
        // would route by namespace and drop the backend the entry chose.
        const backend = topTierBackend(config, tier);
        if (own !== undefined) {
          const thinking = own.thinking ?? config.thinking;
          if (backend !== undefined)
            model[tier] = {
              backend,
              model: formatModelSelector({ ...own, thinking: undefined }),
              ...(thinking !== undefined ? { thinking } : {}),
            };
          else model[tier] = formatModelSelector({ ...own, thinking });
        }
        // A tier with no top-level selector — `agent: "claude"` riding its agent default —
        // has no own selector to carry the level, so name the routed default plus it.
        else if (seam.model !== undefined) {
          const routed = { provider: seam.provider, model: seam.model };
          model[tier] =
            backend !== undefined
              ? {
                  backend,
                  model: formatModelSelector(routed),
                  ...(seam.thinking !== undefined ? { thinking: seam.thinking } : {}),
                }
              : formatModelSelector({ ...routed, thinking: seam.thinking });
        }
        continue;
      }
      const sel = selectorOf(resolved[tier]);
      if (sel !== undefined) model[tier] = sel;
      const cap = resolved[tier].pair?.maxDailyCostUsd;
      if (cap !== undefined) stepCaps[modelPairName(resolved[tier].pair)] = cap;
    }
    return {
      ...config,
      ...(Object.keys(stepCaps).length > 0 ? { fallbackStepCaps: stepCaps } : {}),
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
