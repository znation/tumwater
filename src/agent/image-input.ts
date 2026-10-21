/** The seam's answer to "who in this team can read images" (plans/image-input.md
 * "Capability"). One resolver, `seamImageInput`, is the only place that rule lives; the doctor
 * (src/doctor/doctor-model-checks.ts) and the later reroute parts both read it, so the answer
 * is never reached two ways. It lives at runtime level because it needs the backend registry:
 * a claude seam is always capable through the AgentBackend.imageInput hook, a pi seam reads the
 * model's `input` in models.json, and any other backend answers null unless it declares a hook. */

import type { TumwaterConfig } from "../config/config-schema.js";
import type { ModelTier, FallbackModelConfig } from "../config/config-schema.js";
import type { ResolvedModelConfig } from "../config/config-views.js";
import { configForRole, roleSeamTier, withModelOverrides } from "../config/config-views.js";
import { BORROW_ORDER, resolveTierFallbacks } from "../config/config-fallbacks.js";
import { seamAgent } from "../config/model-selector.js";
import { modelLabel } from "./backend-traits.js";
import { piModelImageInput, piPairFree, piModelsPath, readPiProviders, type PiModelDef } from "../pi/pi-models.js";
import { piListedImageInput, type PiListedModels } from "../pi/pi-listed-models.js";
import type { ClaudeAccount } from "./claude/claude-account.js";
import { backendById } from "./agent-backend.js";
import { imageProbeEntryFresh, imageProbeKey, type ImageProbeCache } from "../doctor/image-probe.js";

/** The subset of a resolved seam the capability resolver reads: an `agent` when the config
 * routed one, else a `provider`/`model` pair. ResolvedModelConfig and the doctor's SeamPair
 * both satisfy it structurally. */
interface SeamLike {
  agent?: string;
  provider?: string;
  model?: string;
}

/** One seam's image-input capability (plans/image-input.md "Capability"): `true` when the
 * seam's backend declares image support, `false` when it is text-only, `null` when it cannot
 * be answered from what the team knows (a pair neither models.json nor the pi listing names, a
 * backend with no hook and no catalog entry).
 *
 * The backend bookends: a backend with an `imageInput` hook (claude → true) owns the answer;
 * the default pi backend leaves it to models.json's `input` field, where absent means text-only
 * (pi's own default for a custom model); a pair absent from models.json answers what
 * `pi --list-models` last said (src/pi/pi-listed-models.ts), else null.
 * `probes` is the doctor's live-probe cache (part 2/5): a claimed pi seam whose probe FAILED
 * reads false — a claim is only as good as the verified
 * answer — while a cached pass (or an unprobed claim) stands on the catalog. claude seams are
 * never probed, so the hook answer is never overridden. */
export function seamImageInput(
  seam: SeamLike,
  providers: Map<string, PiModelDef[]> | null,
  probes?: ImageProbeCache,
  listed: PiListedModels | null = null,
): boolean | null {
  const backendId = seamAgent(seam);
  const backend = backendById(backendId);
  // A backend with an imageInput hook owns the answer outright (claude: true for every model).
  if (backend?.imageInput !== undefined) return backend.imageInput(seam.model);
  // An unknown backend without a hook has no catalog to consult — unknown, never assume.
  if (backendId !== "pi") return null;
  const base =
    piModelImageInput(providers, seam.provider, seam.model) ?? piListedImageInput(listed, seam.provider, seam.model);
  if (base !== true) return base;
  // A claimed pi seam whose live probe failed (fresh, claim unchanged) reads false. Only pi is
  // probed, so the probe key carries the pi backend.
  const entry = probes?.[imageProbeKey(backendId, seam.provider, seam.model)];
  if (entry?.verdict === "fail" && imageProbeEntryFresh(entry)) return false;
  return true;
}

/** Which set of pairs a reroute may look among: the primary tiers (the model each tier's
 * top-level selector names) normally, or — while the budget gate is on fallback or the role is
 * in a model-fallback episode — only the tiers' free fallback pairs, so a reroute never spends
 * past the daily cap. */
type RerouteRegime = "primary" | "fallback";

/** A reroute candidate resolved fully: which tier it sits on (so a surface can name "reroutes
 * to strong (…)", the same borrow order the budget fallback uses) and that tier's runnable
 * config. */
interface ImageReroute {
  tier: ModelTier;
  config: ResolvedModelConfig;
}

/** The image-capable reroute target for `role`, or null when no peer tier can read images
 * (plans/image-input.md "Reroute target"). Walks the role's seam tier through BORROW_ORDER,
 * skipping the tier itself — small → default → strong, default → strong → small, strong →
 * default (a strong-tier seam never drops to small, the same rule as the budget fallback) —
 * and takes the first tier whose model reads images. `regime` picks the pair set (see
 * RerouteRegime); `modelsPath` and `account` are injectable so tests need no real pi install
 * or account. */
export function imageReroute(
  config: TumwaterConfig,
  role: string,
  regime: RerouteRegime = "primary",
  modelsPath: string = piModelsPath(),
  account: ClaudeAccount | null = null,
  probes?: ImageProbeCache,
  providers: Map<string, PiModelDef[]> | null = null,
  listed: PiListedModels | null = null,
): ImageReroute | null {
  const tier = roleSeamTier(config, role);
  const candidates = BORROW_ORDER[tier].filter((t) => t !== tier);
  if (candidates.length === 0) return null;
  const providerMap = providers ?? readPiProviders(modelsPath);
  const capable = (rc: ResolvedModelConfig): boolean => seamImageInput(rc, providerMap, probes, listed) === true;
  if (regime === "primary") {
    for (const t of candidates) {
      const rc = withModelOverrides(config, t, {});
      if (capable(rc)) return { tier: t, config: rc };
    }
    return null;
  }
  // Fallback regime: only the tiers' free fallback pairs qualify (resolveTierFallbacks over the
  // price check), never a priced primary model — a reroute must not spend past the cap.
  const resolved = resolveTierFallbacks(config, (p: FallbackModelConfig) =>
    piPairFree(providerMap, p, account),
  );
  for (const t of candidates) {
    const pair = resolved[t].pair;
    if (!pair) continue;
    const rc = withModelOverrides(config, t, {
      provider: pair.provider,
      model: pair.model,
      thinking: pair.thinking,
    });
    if (capable(rc)) return { tier: t, config: rc };
  }
  return null;
}

/** The config of imageReroute, for callers that want only the target model. */
export function imageRerouteTarget(
  config: TumwaterConfig,
  role: string,
  regime: RerouteRegime = "primary",
  modelsPath: string = piModelsPath(),
  account: ClaudeAccount | null = null,
  probes?: ImageProbeCache,
  providers: Map<string, PiModelDef[]> | null = null,
  listed: PiListedModels | null = null,
): ResolvedModelConfig | null {
  return imageReroute(config, role, regime, modelsPath, account, probes, providers, listed)?.config ?? null;
}

/** A seam's model as one readable token, the same label the doctor's `image input` check uses
 * (`claude/<id>` for a claude seam, `provider/model` for pi). The one home of the label, so
 * the surface strings (the images alert, the role page, the status rows) and the doctor report
 * cannot drift, and delegates to backend-traits' modelLabel. */
export function seamImageLabel(
  backend: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): string {
  return modelLabel(backend, provider, model);
}

/** The per-role image-input surface (plans/image-input.md "Surfaces"): one call gives a caller
 * both the role's own capability (`imageInput`, seamImageInput's true/false/null) and its
 * reroute target as the display label `<tier> (<model>)` or null when no peer tier reads
 * images. Shared by the status rows, the role page, and the submit gate so the three surfaces
 * can never disagree about what one role can read or where its image prompts run. */
interface RoleImageInfo {
  /** Whether the role's own model reads images (`true`), is text-only (`false`), or the team
   * cannot tell (null — an unknown pair the `tier models` check already flags). */
  imageInput: boolean | null;
  /** The reroute target as `<tier> (<model>)`, or null when no other tier reads images. */
  imageReroute: string | null;
}

/** Compute RoleImageInfo for one role. `modelsPath` and `probes` are injectable; the providers
 * catalog is read (stat-cached) here and also handed to imageReroute so a poll that asks many
 * roles still parses the catalog once. All reads mirror the doctor's `image input` check, so
 * the surface and the check agree about capability. */
export function roleImageInfo(
  config: TumwaterConfig,
  role: string,
  modelsPath: string = piModelsPath(),
  probes?: ImageProbeCache,
  listed: PiListedModels | null = null,
): RoleImageInfo {
  const providers = readPiProviders(modelsPath);
  const rc = configForRole(config, role);
  const imageInput = seamImageInput(rc, providers, probes, listed);
  const rr = imageReroute(config, role, "primary", modelsPath, null, probes, providers, listed);
  const imageRerouteStr = rr
    ? `${rr.tier} (${seamImageLabel(rr.config.agent, rr.config.provider, rr.config.model)})`
    : null;
  return { imageInput, imageReroute: imageRerouteStr };
}
