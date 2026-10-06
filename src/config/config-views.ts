/** The config AS SEEN BY A RUN — pure derivations over a TumwaterConfig, split out of
 * config.ts: which provider/model/thinking a role, the reviewer, or the budget fallback
 * resolves to, and which timeout a reviewer run gets. No I/O and no caching — the
 * persistence side (defaults, loading, saving, the role-selection helpers) lives in
 * config.ts, the write side in config-write.ts. */
import type { FallbackModelConfig, TumwaterConfig } from "./config-schema.js";
import { parseModelSelector } from "../model-selector.js";
import type { ModelSelector } from "../model-selector.js";

/** Apply a sub-config's optional provider/model/thinking overrides over the top-level
 * values — the one place that fallback lives, so adding an override field touches only
 * this. Every string `model` — the top level's and a section's — is a selector
 * (`provider/id[:thinking]`, plans/model-tiers.md): parsed into the triple piArgs consumes,
 * with a legacy provider in scope (the section's own, else the top level's) making the whole
 * string a bare id under it — the old configs' meaning. An explicit `thinking` key wins over a selector's `:level` suffix, and a
 * suffix beats the ambient top-level thinking, as the key it overrides would. */
function withModelOverrides(
  config: TumwaterConfig,
  o: { provider?: string; model?: string; thinking?: string },
): TumwaterConfig {
  // The top-level model string is itself a selector; it parses under the top level's own
  // legacy provider. A section's own model parses under the section's provider, else the
  // top level's — the old configs' meaning.
  const topSel =
    config.model !== undefined ? parseModelSelector(config.model, config.provider) : undefined;
  const ownSel =
    o.model !== undefined ? parseModelSelector(o.model, o.provider ?? config.provider) : undefined;
  return {
    ...config,
    provider: ownSel ? ownSel.provider : (o.provider ?? topSel?.provider ?? config.provider),
    model: ownSel ? ownSel.model : (topSel?.model ?? config.model),
    thinking: o.thinking ?? ownSel?.thinking ?? topSel?.thinking ?? config.thinking,
  };
}

/** The config as seen by one role: role-level provider/model/thinking overrides applied
 * over the top-level values, plus the per-role minTickIntervalSeconds (a slow clock for
 * roles that should act rarely) falling back to the global value when unset. */
export function configForRole(config: TumwaterConfig, role: string): TumwaterConfig {
  const rc = config.roles[role];
  if (!rc) return config;
  return {
    ...withModelOverrides(config, rc),
    minTickIntervalSeconds: rc.minTickIntervalSeconds ?? config.minTickIntervalSeconds,
  };
}

/** The config as seen by the review gate's pi runs: the top-level `review` section's
 * optional provider/model/thinking overrides applied over the top-level values — so a
 * strong model can review what the cheap model wrote. Reads its own `review` section on
 * purpose (not via configForRole): a pseudo-role entry under `roles` would fail validation
 * (unknown role id) and, if accepted, spawn a runner with no catalog prompt. */
export function reviewConfig(config: TumwaterConfig): TumwaterConfig {
  return withModelOverrides(config, config.review);
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
export function reviewRunConfig(config: TumwaterConfig): TumwaterConfig {
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
 * equivalent `fallbackModel` object. One definition so the freeness check (src/pi/pi-models.ts), the
 * dashboards' badge, and applyFallbackModel below cannot disagree about WHICH model the
 * budget gate would engage. */
export function fallbackPair(config: TumwaterConfig): FallbackModelConfig | null {
  if (config.fallback !== undefined) {
    const sel: ModelSelector = parseModelSelector(config.fallback);
    const thinking = sel.thinking ?? config.thinking;
    return {
      ...(sel.provider ? { provider: sel.provider } : {}),
      ...(sel.model ? { model: sel.model } : {}),
      ...(thinking ? { thinking } : {}),
    };
  }
  const fb = config.fallbackModel;
  if (!fb) return null;
  // The top-level model is a selector too (parsed the same way withModelOverrides does), so a
  // fallback field that omits model borrows the parsed id, never the raw selector string.
  const topSel =
    config.model !== undefined ? parseModelSelector(config.model, config.provider) : undefined;
  const provider = fb.provider ?? topSel?.provider ?? config.provider;
  const model = fb.model ?? topSel?.model ?? config.model;
  const thinking = fb.thinking ?? topSel?.thinking ?? config.thinking;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
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
 * untouched, so the gate keeps re-evaluating against the same numbers. Returns `config`
 * unchanged when no fallback is configured. */
export function applyFallbackModel(config: TumwaterConfig): TumwaterConfig {
  const pair = fallbackPair(config);
  if (!pair) return config;
  const stripModel = <T extends { provider?: string; model?: string; thinking?: string }>(o: T): T => {
    const { provider: _p, model: _m, thinking: _t, ...rest } = o;
    return rest as T;
  };
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
