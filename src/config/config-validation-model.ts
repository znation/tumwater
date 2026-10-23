/** The model-declaration section rules of tumwater.json validation: the top-level `model`
 * selector-or-map block, and the fallback/fallbackModel block. Extracted from the single
 * validateConfig gate (config-validation.ts) so a model-key edit lands as a per-theme diff
 * instead of a whole-gate one. The two blocks run at different points of the gate — the
 * top-level model block before the agent and numeric sections, the fallback block after the
 * review section — so this module exports two entry points, each called where its block runs
 * today, keeping problem order byte-identical.
 *
 * These rules sit on top of the generic machinery in config-field-checks.ts and
 * config-selector-checks.ts; the helpers passed in are the closures the gate binds once
 * (the problems-bound checkers and the r-derived backend/legacy-provider resolution shared
 * with the gate's own remaining sections). */

import {
  MODEL_TRIPLE_KEYS,
  SELECTOR_ENTRY_KEYS,
  THINKING_LEVELS,
  TIER_MAP_KEYS,
} from "./config-schema.js";
import { isJsonObject } from "../files/json-object.js";
import { isNonBlankString } from "../text/text.js";
import {
  checkKnownKeys,
  checkObjectSection,
  show,
} from "./config-field-checks.js";
import {
  checkEntryBackend,
  checkFallbackList,
  checkFallbackStep,
  checkRetiredSelector,
  checkSelectorHalves,
  checkSelectorValue,
} from "./config-selector-checks.js";

/** The closures the gate binds once and hands to the model blocks: the problems-bound field
 * checkers and the r-derived backend resolution. */
interface ModelBlockHelpers {
  checkModelTriple: (
    obj: Record<string, unknown>,
    prefix: string,
    modelShape?: "selector" | "tier-map" | "tier-name",
  ) => void;
  checkString: (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    allowEmpty?: boolean,
  ) => void;
  topBackend: string;
  checkLegacyProvider: (provider: unknown, at: string, backend: string) => void;
}

/** Validate the top-level `model` selector-or-map block and its provider/backend resolution.
 * Keeps the exact problem order the gate produced at this point: the selector/tier-map check,
 * the empty-half check, the retired-spelling no-provider check, the legacy-provider pair and
 * each tier entry. */
export function validateModelBlock(
  r: Record<string, unknown>,
  problems: string[],
  helpers: ModelBlockHelpers,
): void {
  const { checkModelTriple, checkString, topBackend, checkLegacyProvider } = helpers;
  // The top level's `model` may be a selector string or a map by tier (plans/model-tiers.md);
  // provider/thinking validate as before. A string selector that parses to an empty provider
  // or model half is reported separately (checkSelectorHalves).
  checkModelTriple(r, "", "tier-map");
  checkSelectorHalves(r, "", "model", r.provider, problems);
  if (r.provider === undefined) checkRetiredSelector("model", r.model, topBackend, problems);
  checkLegacyProvider(r.provider, "", topBackend);
  // A map's entries are selector strings too, resolved by config-views' topTierSelector with
  // parseModelSelector; the keyed check above sees only the object, so each entry runs the
  // same empty-half check (the map form cannot coexist with a legacy provider, so it parses
  // as a pure selector).
  if (isJsonObject(r.model))
    for (const [tier, sel] of Object.entries(r.model)) {
      if (!isJsonObject(sel)) {
        checkSelectorValue(`model.${tier}`, sel, undefined, problems);
        checkRetiredSelector(`model.${tier}`, sel, topBackend, problems);
        continue;
      }
      // An object tier entry: the model written beside the backend that runs it.
      const at = `model.${tier}`;
      checkKnownKeys(sel, SELECTOR_ENTRY_KEYS, at, problems);
      checkString(sel, `${at}.`, "model", false);
      const t = sel.thinking;
      if (t !== undefined && !(isNonBlankString(t) && THINKING_LEVELS.has(t)))
        problems.push(`${at}.thinking must be one of ${[...THINKING_LEVELS].join(", ")} (got ${show(t)})`);
      checkEntryBackend(sel, at, problems);
      checkSelectorValue(`${at}.model`, sel.model, undefined, problems);
      checkRetiredSelector(`${at}.model`, sel.model, typeof sel.backend === "string" ? sel.backend : topBackend, problems);
    }
}

/** The fallback helpers the gate binds once and hands to the fallback block: `tierBackend`
 * (the backend a tier's fallback steps inherit) and `eachTierBackend` plus the shared
 * legacy-provider pair check. */
interface FallbackBlockHelpers {
  checkModelTriple: (
    obj: Record<string, unknown>,
    prefix: string,
    modelShape?: "selector" | "tier-map" | "tier-name",
  ) => void;
  checkLegacyProvider: (provider: unknown, at: string, backend: string) => void;
  tierBackend: (tier: string) => string;
  eachTierBackend: (check: (backend: string, out: string[]) => void) => void;
}

/** Validate the `fallback` string-or-map block and the free-fallback-model (`fallbackModel`)
 * shape. The single call site in the gate is the point where these problems are appended
 * today, so the order across the whole pass is unchanged. */
export function validateFallbackBlock(
  r: Record<string, unknown>,
  problems: string[],
  helpers: FallbackBlockHelpers,
): void {
  const { checkModelTriple, checkLegacyProvider, tierBackend, eachTierBackend } = helpers;
  // The free fallback model (plans/fallback-model.md): shape only — whether the named pair is
  // actually cost-free is a question about pi's models.json, not about this file, so it is
  // answered at run time (src/pi/pi-models.ts) rather than failing a load here. An empty object is
  // rejected: it names nothing, so it would silently never engage.
  // The selector-string shorthand `fallback` (plans/model-tiers.md) validates as one non-empty
  // string; the map form takes per-tier entries whose values are selector strings or "pause"
  // (each tier's entry is consulted when that tier runs at the cap; part 5a/8). Setting both
  // forms — or the map form and `fallbackModel` — is an error naming both keys, since which
  // one wins is not a question the file should ever pose.
  if ("fallback" in r && r.fallback !== undefined) {
    const f = r.fallback;
    if (isJsonObject(f)) {
      checkKnownKeys(f, TIER_MAP_KEYS, "fallback", problems);
      for (const [tier, v] of Object.entries(f)) {
        if (Array.isArray(v)) checkFallbackList(`fallback.${tier}`, v, problems, tierBackend(tier));
        else if (isJsonObject(v)) checkFallbackStep(`fallback.${tier}`, v, problems, tierBackend(tier));
        else if (!isNonBlankString(v))
          problems.push(
            `fallback.${tier} must be a non-empty model id or "pause" (got ${show(v)})`,
          );
        else if (v !== "pause")
          // An entry is a pure selector (config-views' fallbackSelectorFields parses it with
          // no legacy provider in scope); "pause" names no model and stays valid.
          {
            checkSelectorValue(`fallback.${tier}`, v, undefined, problems);
            checkRetiredSelector(`fallback.${tier}`, v, tierBackend(tier), problems);
          }
      }
    } else if (Array.isArray(f)) {
      eachTierBackend((b, out) => checkFallbackList("fallback", f, out, b));
    } else if (!isNonBlankString(f)) {
      problems.push(`fallback must be a model id or a map by tier (got ${show(f)})`);
    } else if (f === "pause") {
      problems.push(
        `fallback "pause" is only valid as a tier map value — a string fallback must name a model id`,
      );
    } else {
      // A selector-string fallback still parses to halves: report an empty one.
      checkSelectorHalves({ fallback: f }, "", "fallback", undefined, problems);
      eachTierBackend((b, out) => checkRetiredSelector("fallback", f, b, out));
    }
  }
  if ("fallback" in r && "fallbackModel" in r)
    problems.push(`fallback and fallbackModel both name the budget fallback — keep only one (got fallback ${show(r.fallback)} and fallbackModel ${show(r.fallbackModel)})`);
  checkObjectSection(r, "fallbackModel", problems, (o) => {
    checkKnownKeys(o, MODEL_TRIPLE_KEYS, "fallbackModel", problems);
    checkModelTriple(o, "fallbackModel.");
    // legacyFallbackPair (config-fallbacks.ts) forces a fallbackModel that names its own
    // provider onto backend pi whatever the team's backend, so a legacy provider that is a
    // backend id there is the same silent-pi-pair flaw the checks above reject.
    checkLegacyProvider(o.provider, "fallbackModel.", "pi");
    if (!("provider" in o) && !("model" in o))
      problems.push(`fallbackModel must name a provider or a model (got ${show(o)})`);
  });
}
