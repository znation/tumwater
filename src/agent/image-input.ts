/** The seam's answer to "who in this team can read images" (plans/image-input.md
 * "Capability"). One resolver, `seamImageInput`, is the only place that rule lives, so the
 * answer is never reached two ways. It lives at runtime level because it needs the backend
 * registry: a claude seam is always capable through the AgentBackend.imageInput hook, a pi
 * seam reads the model's `input` in models.json, and any other backend answers null unless it
 * declares a hook. */

import type { TumwaterConfig } from "../config/config-schema.js";
import { configForRole } from "../config/config-views.js";
import { seamAgent } from "../config/model-selector.js";
import { piModelImageInput, piModelsPath, readPiProviders, type PiModelDef } from "../pi/pi-models.js";
import { piListedImageInput, type PiListedModels } from "../pi/pi-listed-models.js";
import { backendById } from "./agent-backend.js";

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
 * A claim in models.json is trusted without a live probe (the doctor's live probe was
 * subtracted): a claimed pi seam reads true on the catalog. claude seams are answered by the
 * hook. */
export function seamImageInput(
  seam: SeamLike,
  providers: Map<string, PiModelDef[]> | null,
  listed: PiListedModels | null = null,
): boolean | null {
  const backendId = seamAgent(seam);
  const backend = backendById(backendId);
  // A backend with an imageInput hook owns the answer outright (claude: true for every model).
  if (backend?.imageInput !== undefined) return backend.imageInput(seam.model);
  // An unknown backend without a hook has no catalog to consult — unknown, never assume.
  if (backendId !== "pi") return null;
  return piModelImageInput(providers, seam.provider, seam.model) ?? piListedImageInput(listed, seam.provider, seam.model);
}

/** The per-role image-input surface (plans/image-input.md "Surfaces"): one call gives a caller
 * the role's own capability (`imageInput`, seamImageInput's true/false/null) and (still, until
 * 5h removes it) a reroute target that is now always null. Shared by the status rows, the role
 * page, and the submit gate so the three surfaces can never disagree about what one role can
 * read. */
interface RoleImageInfo {
  /** Whether the role's own model reads images (`true`), is text-only (`false`), or the team
   * cannot tell (null — an unknown pair the `tier models` check already flags). */
  imageInput: boolean | null;
  /** The reroute target as `<tier> (<model>)`, or null when no other tier reads images. */
  imageReroute: string | null;
}

/** Compute RoleImageInfo for one role. `modelsPath` and `listed` are injectable; the providers
 * catalog is read (stat-cached) here. The reroute field is a literal null — the peer-tier image
 * reroute was subtracted (part 5g/6), so no role names a reroute target; 5h removes the field. */
export function roleImageInfo(
  config: TumwaterConfig,
  role: string,
  modelsPath: string = piModelsPath(),
  listed: PiListedModels | null = null,
): RoleImageInfo {
  const providers = readPiProviders(modelsPath);
  const rc = configForRole(config, role);
  const imageInput = seamImageInput(rc, providers, listed);
  return { imageInput, imageReroute: null };
}
