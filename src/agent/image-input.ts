/** The seam's answer to "who in this fleet can read images" (plans/image-input.md
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
import { isAgentId } from "../config/model-selector.js";
import { piModelImageInput, piPairFree, piModelsPath, readPiProviders, type PiModelDef } from "../pi/pi-models.js";
import type { ClaudeAccount } from "./claude/claude-account.js";
import { agentBackend, DEFAULT_AGENT } from "./agent-backend.js";
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
 * be answered from what the fleet knows (an unknown pair, a backend with no hook and no
 * catalog entry — the doctor's `tier models` check already fails such pairs).
 *
 * The backend bookends: a backend with an `imageInput` hook (claude → true) owns the answer;
 * the default pi backend leaves it to models.json's `input` field, where absent means text-only
 * (pi's own default for a custom model). `probes` is the doctor's live-probe cache (part 2/5): a
 * claimed pi seam whose probe FAILED reads false — a claim is only as good as the verified
 * answer — while a cached pass (or an unprobed claim) stands on the catalog. claude seams are
 * never probed, so the hook answer is never overridden. */
export function seamImageInput(
  seam: SeamLike,
  providers: Map<string, PiModelDef[]> | null,
  probes?: ImageProbeCache,
): boolean | null {
  const agent = seam.agent ?? (isAgentId(seam.provider) ? seam.provider : DEFAULT_AGENT);
  const backend = agentBackend(agent);
  // A backend with an imageInput hook owns the answer outright (claude: true for every model).
  if (backend?.imageInput !== undefined) return backend.imageInput(seam.model);
  // An unknown backend without a hook has no catalog to consult — unknown, never assume.
  if (agent !== "pi") return null;
  const base = piModelImageInput(providers, seam.provider, seam.model);
  if (base !== true) return base;
  // A claimed pi seam whose live probe failed (fresh, claim unchanged) reads false. Only pi is
  // probed, so the probe key carries the pi agent.
  const entry = probes?.[imageProbeKey(agent, seam.provider, seam.model)];
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
): ImageReroute | null {
  const tier = roleSeamTier(config, role);
  const candidates = BORROW_ORDER[tier].filter((t) => t !== tier);
  if (candidates.length === 0) return null;
  const providerMap = providers ?? readPiProviders(modelsPath);
  const capable = (rc: ResolvedModelConfig): boolean => seamImageInput(rc, providerMap, probes) === true;
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
    piPairFree(providerMap, p.provider, p.model, account),
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
): ResolvedModelConfig | null {
  return imageReroute(config, role, regime, modelsPath, account, probes, providers)?.config ?? null;
}

/** A seam's model as one readable token, the same label the doctor's `image input` check uses
 * (`claude/<id>` for a claude seam, `provider/model` for pi). The one home of the label, so
 * the surface strings (the images alert, the role page, the status rows) and the doctor report
 * cannot drift. `agent === "claude"` reads the backend-owned answer; a pi seam shows its pair. */
export function seamImageLabel(
  agent: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): string {
  return agent === "claude" ? (model ?? "claude backend") : `${provider ?? "?"}/${model ?? "?"}`;
}

/** The per-loop image-input surface (plans/image-input.md "Surfaces"): one call gives a caller
 * both the loop's own capability (`imageInput`, seamImageInput's true/false/null) and its
 * reroute target as the display label `<tier> (<model>)` or null when no peer tier reads
 * images. Shared by the status rows, the role page, and the submit gate so the three surfaces
 * can never disagree about what one loop can read or where its image prompts run. */
interface RoleImageInfo {
  /** Whether the loop's own model reads images (`true`), is text-only (`false`), or the fleet
   * cannot tell (null — an unknown pair the `tier models` check already flags). */
  imageInput: boolean | null;
  /** The reroute target as `<tier> (<model>)`, or null when no other tier reads images. */
  imageReroute: string | null;
}

/** Compute RoleImageInfo for one loop. `modelsPath` and `probes` are injectable; the providers
 * catalog is read (stat-cached) here and also handed to imageReroute so a poll that asks many
 * loops still parses the catalog once. All reads mirror the doctor's `image input` check, so
 * the surface and the check agree about capability. */
export function roleImageInfo(
  config: TumwaterConfig,
  role: string,
  modelsPath: string = piModelsPath(),
  probes?: ImageProbeCache,
): RoleImageInfo {
  const providers = readPiProviders(modelsPath);
  const rc = configForRole(config, role);
  const imageInput = seamImageInput(rc, providers, probes);
  const rr = imageReroute(config, role, "primary", modelsPath, null, probes, providers);
  const imageRerouteStr = rr
    ? `${rr.tier} (${seamImageLabel(rr.config.agent, rr.config.provider, rr.config.model)})`
    : null;
  return { imageInput, imageReroute: imageRerouteStr };
}
