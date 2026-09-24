import os from "node:os";
import path from "node:path";
import type { TumwaterConfig } from "./config-schema.js";
import { configForRole, enabledRoleIds, fallbackPair, reviewConfig } from "./config.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { isJsonObject } from "./json-object.js";
import { readJsonFile } from "./json-files.js";

/** pi's model definitions — the custom providers and models they serve, with each model's
 * declared cost. This is where a local (free) fleet differs from an API one: unpriced or
 * zero-cost models never accumulate spend against the daily budget cap, so the badge can
 * read n/a instead of a dollar figure that can never move. */
export function piModelsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}

interface PiModelDef {
  id: string;
  /** The model's declared cost — whatever the user's models.json holds, so read as unknown
   * and checked component by component rather than trusted. An absent field means unpriced. */
  cost?: unknown;
}

/** The cost components pi's models.json may declare. */
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** A model is free when it declares no cost at all, or a cost object whose every present
 * component is exactly zero. Anything else — a non-object cost (a string, a number, an array,
 * or null), or a present component that is not a finite number — is unresolvable and counts as
 * NOT free, the same safe direction pairFree takes for an unknown model: the badge must never
 * read "n/a" while a model it cannot price is in use, and reading a component off a null cost
 * would otherwise throw straight into the status poll. */
function costIsFree(cost: unknown): boolean {
  if (cost === undefined) return true;
  if (!isJsonObject(cost)) return false;
  const c = cost;
  return COST_KEYS.every((key) => {
    const p = c[key];
    return p === undefined || (typeof p === "number" && Number.isFinite(p) && p === 0);
  });
}

/** Per-poll cache of the parsed definitions, keyed by models path: both dashboards poll
 * fleetModelsFree every second while models.json changes only when a user edits it — and it
 * grows with the model catalog (every added provider/model entry), so an unchanged file costs
 * one stat per poll instead of a re-read plus JSON.parse of the whole catalog. Any write
 * invalidates via dev/ino/mtime/size (stat-cache.cachedByStat, same freshness check as the
 * other polled files in status.ts); a missing or malformed file yields null and is not cached,
 * so a mid-edit broken file recovers on the next poll exactly like before. */
const providersCache = new Map<string, StatKeyedValue<Map<string, PiModelDef[]>>>();

/** The parsed provider→models map from pi's definitions, or null when the file is missing,
 * unreadable, malformed, or not shaped like what pi writes (served stat-keyed — see above). */
function readPiProviders(modelsPath: string): Map<string, PiModelDef[]> | null {
  return cachedByStat(
    providersCache,
    modelsPath, // Keyed by path so distinct roots and test files never collide.
    modelsPath,
    () => {
      // readJsonFile is the shared "missing or torn reads as no data" policy for a JSON object
      // file; the nested providers/models shapes get the same isJsonObject guard.
      const doc = readJsonFile<Record<string, unknown>>(modelsPath);
      if (!doc) return null;
      const providers = doc.providers;
      if (!isJsonObject(providers)) return null;
      const out = new Map<string, PiModelDef[]>();
      for (const [name, pdef] of Object.entries(providers)) {
        if (!isJsonObject(pdef)) continue;
        const models = pdef.models;
        if (!Array.isArray(models)) continue;
        out.set(
          name,
          models.filter((m): m is PiModelDef => isJsonObject(m) && typeof m.id === "string"),
        );
      }
      return out;
    },
    // A copy: callers may treat the result as their own.
    (providers) => new Map([...providers].map(([name, models]) => [name, [...models]])),
  );
}

/** True when `provider`/`model` names a model pi's definitions price at zero — a "(cost n/a)"
 * pair. Anything unresolvable counts as NOT free: an omitted provider or model (pi's own
 * default), a missing or malformed definitions file, an unknown provider, or a model id the
 * file does not list. An unverified model may well be paid, and no caller here may treat
 * "I could not check" as "it is free" — the badge would lie, and the fallback would defeat
 * the very cap it exists to survive. */
function pairFree(
  providers: Map<string, PiModelDef[]> | null,
  provider: string | undefined,
  model: string | undefined,
): boolean {
  if (!providers || !provider || !model) return false;
  const def = providers.get(provider)?.find((m) => m.id === model);
  return def !== undefined && costIsFree(def.cost);
}

/** True when the configured fallback model (plans/fallback-model.md) is one the budget gate may
 * actually engage: configured at all, resolvable to a provider/model pair, and priced at zero in
 * pi's definitions. False for every other case — no fallback, a half-named pair that would fall
 * through to pi's own default, an unknown id, or a priced one — and the gate then pauses role
 * loops exactly as it did before this feature. */
export function fallbackModelFree(config: TumwaterConfig, modelsPath = piModelsPath()): boolean {
  const pair = fallbackPair(config);
  if (!pair) return false;
  return pairFree(readPiProviders(modelsPath), pair.provider, pair.model);
}

/** True when every model the fleet could use is free: each enabled role's effective
 * provider/model (configForRole — the director included, it is a catalog role) plus the
 * reviewer's while review is on. Every pair is judged by pairFree above, so an unresolvable one
 * counts as NOT free — the badge must never read n/a while spend it is tracking could still
 * reach the cap. With no enabled roles and review off there are no pairs at all, so the fleet
 * cannot spend and the answer is true. */
export function fleetModelsFree(config: TumwaterConfig, modelsPath = piModelsPath()): boolean {
  const pairs: Array<[string | undefined, string | undefined]> = [];
  for (const role of enabledRoleIds(config)) {
    const rc = configForRole(config, role);
    pairs.push([rc.provider, rc.model]);
  }
  if (config.review.enabled) {
    const rv = reviewConfig(config);
    pairs.push([rv.provider, rv.model]);
  }
  // No enabled roles and review off: nothing can spend, so the budget is n/a by
  // construction — no definitions file to consult.
  if (pairs.length === 0) return true;
  const providers = readPiProviders(modelsPath);
  return pairs.every(([provider, model]) => pairFree(providers, provider, model));
}
