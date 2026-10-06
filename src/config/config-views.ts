/** The config AS SEEN BY A RUN — pure derivations over a TumwaterConfig, split out of
 * config.ts: which provider/model/thinking a role, the reviewer, or the budget fallback
 * resolves to, and which timeout a reviewer run gets. No I/O and no caching — the
 * persistence side (defaults, loading, saving, the role-selection helpers) lives in
 * config.ts, the write side in config-write.ts. */
import type { FallbackModelConfig, ModelTier, TumwaterConfig } from "./config-schema.js";
import { MODEL_TIERS } from "./config-schema.js";
import { parseModelSelector } from "../model-selector.js";
import type { ModelSelector } from "../model-selector.js";
import { isJsonObject } from "../files/json-object.js";
import { modelPairName } from "../budget/budget.js";
import { formatModelSelector } from "../model-selector.js";
import { roleById } from "../roles/roles.js";

/** A config whose model seam has been RESOLVED — the view functions' return type: `model`
 * is the concrete selector id piArgs consumes (the tier map, if any, has been resolved to
 * the seam's tier), so consumers of a role/reviewer/fallback view never see a map. */
export type ResolvedModelConfig = Omit<TumwaterConfig, "model"> & { model?: string };

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
 * string a bare id under it — the old configs' meaning. An explicit `thinking` key wins over a selector's `:level` suffix, and a
 * suffix beats the ambient top-level thinking, as the key it overrides would.
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
  return {
    ...config,
    provider: ownSel ? ownSel.provider : (o.provider ?? topSel?.provider ?? config.provider),
    model: ownSel ? ownSel.model : topSel?.model,
    thinking: o.thinking ?? ownSel?.thinking ?? topSel?.thinking ?? config.thinking,
  };
}

/** The effective tier of one role's pi runs: a tier name in `roles.<id>.model` names it
 * explicitly, else the role's catalog tier (user-defined loops and the director, which is
 * not in ROLES, run `default`). */
/** The tier a role's model resolves at: a tier-name `roles.<id>.model` names it directly, and
 * every other role rides the model catalog's assignment. Exported for the per-tier budget gate's
 * pause set (src/gates/gate-polls.ts, part 5c/8) and the dashboards' per-role budget pause
 * (src/status/status-data.ts), which must resolve the SAME tier the seams resolve — the hold an
 * operator sees is the hold the scheduler enforces. */
export function roleSeamTier(config: TumwaterConfig, role: string): ModelTier {
  const m = config.roles[role]?.model;
  if (isTierName(m)) return m;
  return roleById(role)?.tier ?? "default";
}

/** The config as seen by one role: role-level provider/model/thinking overrides applied
 * over the top-level values, plus the per-role minTickIntervalSeconds (a slow clock for
 * roles that should act rarely) falling back to the global value when unset. The role's
 * model resolves at its effective tier (roleSeamTier): a `model` map serves the tier the
 * catalog assigns (or `roles.<id>.model` names), a string form is the default tier. */
export function configForRole(config: TumwaterConfig, role: string): ResolvedModelConfig {
  const rc = config.roles[role];
  const resolved = withModelOverrides(
    config,
    roleSeamTier(config, role),
    rc
      ? {
          provider: rc.provider,
          model: isTierName(rc.model) ? undefined : rc.model,
          thinking: rc.thinking,
        }
      : {},
  );
  if (!rc) return resolved;
  return {
    ...resolved,
    minTickIntervalSeconds: rc.minTickIntervalSeconds ?? config.minTickIntervalSeconds,
  };
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
    {
      provider: config.review.provider,
      model: isTierName(rm) ? undefined : rm,
      thinking: config.review.thinking,
    },
  );
}

/** The config the landing conflict resolver runs on (plans/model-tiers.md, part 4/8): the
 * strong tier's model installed over the config the landing was handed — resolution is rare,
 * tolerant of latency, and edits code inside landing, so it rides the seam where model quality
 * matters most. It reads whatever config the landing carries, so it follows the budget
 * fallback's config once part 5/8 lands. No other overrides: the session dir, raw log,
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
 * the tick's. A smaller tickTimeoutSeconds still wins. */
export function reviewRunConfig(config: TumwaterConfig): ResolvedModelConfig {
  const cfg = reviewConfig(config);
  return {
    ...cfg,
    tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S),
  };
}

/** The provider/model pair a configured fallback resolves to — its own fields over the
 * top-level ones, the same precedence every other override section uses — or null when no
 * fallback is configured. The selector-string `fallback` (plans/model-tiers.md) and the
 * legacy `fallbackModel` object both feed it, `fallback` first; validation rejects a file
 * carrying both, so the order only breaks ties for hand-built configs. A selector string
 * parses as a pure selector — `fallback` is a new key, so no legacy `provider` in scope
 * bends its meaning; the acceptance rule is that a `fallback` string engages exactly like the
 * equivalent `fallbackModel` object. The map form (plans/model-tiers.md) is consulted per
 * tier only in part 5/8 — until then a map uses its `default` entry, and a `pause` default
 * names no model at all. One definition so the freeness check (src/pi/pi-models.ts), the
 * dashboards' badge, and applyFallbackModel below cannot disagree about WHICH model the
 * budget gate would engage. */
export function fallbackPair(config: TumwaterConfig): FallbackModelConfig | null {
  const fb = config.fallback;
  if (fb !== undefined) {
    if (fb === "pause") return null; // Rejected by validation; defensive against hand-built configs.
    if (typeof fb !== "string") {
      // Map form: until part 5/8 a map uses its `default` entry; a `pause` default names no
      // model at all.
      const sel = fb.default;
      if (sel === undefined || sel === "pause") return null;
      const parsed = parseModelSelector(sel);
      const thinking = parsed.thinking ?? config.thinking;
      return {
        ...(parsed.provider ? { provider: parsed.provider } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }
    const sel: ModelSelector = parseModelSelector(fb);
    const thinking = sel.thinking ?? config.thinking;
    return {
      ...(sel.provider ? { provider: sel.provider } : {}),
      ...(sel.model ? { model: sel.model } : {}),
      ...(thinking ? { thinking } : {}),
    };
  }
  const fbo = config.fallbackModel;
  if (!fbo) return null;
  // The top-level model is a selector too (parsed the same way withModelOverrides does), so a
  // fallback field that omits model borrows the parsed id, never the raw selector string.
  const topSel = topTierSelector(config, "default");
  const provider = fbo.provider ?? topSel?.provider ?? config.provider;
  const model = fbo.model ?? topSel?.model;
  const thinking = fbo.thinking ?? topSel?.thinking ?? config.thinking;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
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
    if (typeof fb === "string") selector = tier === "default" ? fb : undefined;
    else {
      const raw = fb[tier];
      if (raw !== undefined && raw !== "pause") selector = raw;
    }
  } else if (tier === "default" && config.fallback === undefined) {
    // The legacy object (fallbackPair) resolves the default tier's own fallback, with its
    // provider/thinking fields and the top-level borrow precedence.
    return fallbackPair(config) ?? undefined;
  }
  if (selector === undefined) return undefined;
  const parsed = parseModelSelector(selector);
  const thinking = parsed.thinking ?? config.thinking;
  return {
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(thinking ? { thinking } : {}),
  };
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
 * itself. The director's exemption lives in the gates (roleForConfig), not here. */
export function applyFallbackModel(config: TumwaterConfig, resolved?: TierFallbackMap): TumwaterConfig {
  const stripModel = <T extends { provider?: string; model?: string; thinking?: string }>(o: T): T => {
    const { provider: _p, model: _m, thinking: _t, ...rest } = o;
    return rest as T;
  };
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
      const sel = selectorOf(resolved[tier]);
      if (sel !== undefined) model[tier] = sel;
    }
    return {
      ...config,
      provider: undefined,
      model,
      thinking: undefined,
      review: {
        ...stripModel(config.review),
        timeoutSeconds: Math.max(config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S, FALLBACK_REVIEW_TIMEOUT_S),
      },
      roles: Object.fromEntries(
        Object.entries(config.roles).map(([id, rc]) => [
          id,
          isTierName(rc?.model) ? rc : stripModel(rc),
        ]),
      ),
    };
  }
  const pair = fallbackPair(config);
  if (!pair) return config;
  return {
    ...config,
    provider: pair.provider,
    model: pair.model,
    thinking: pair.thinking,
    review: {
      ...stripModel(config.review),
      timeoutSeconds: Math.max(config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S, FALLBACK_REVIEW_TIMEOUT_S),
    },
    roles: Object.fromEntries(Object.entries(config.roles).map(([id, rc]) => [id, stripModel(rc)])),
  };
}
