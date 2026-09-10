import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TumwaterConfig } from "./types.js";
import { configForRole, enabledRoleIds, reviewConfig } from "./config.js";

/** pi's model definitions — the custom providers and models they serve, with each model's
 * declared cost. This is where a local (free) fleet differs from an API one: unpriced or
 * zero-cost models never accumulate spend against the daily budget cap, so the badge can
 * read n/a instead of a dollar figure that can never move. */
export function piModelsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}

/** One model's declared cost in pi's definitions; an absent field means unpriced (free). */
interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface PiModelDef {
  id: string;
  cost?: ModelCost;
}

/** A model is free when it declares no cost at all, or a cost whose every component is zero. */
function costIsFree(cost: ModelCost | undefined): boolean {
  if (cost === undefined) return true;
  const parts = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  return parts.every((p) => p === undefined || p <= 0);
}

/** The parsed provider→models map from pi's definitions, or null when the file is missing,
 * unreadable, malformed, or not shaped like what pi writes. */
function readPiProviders(modelsPath: string): Map<string, PiModelDef[]> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(modelsPath, "utf8");
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const providers = (doc as { providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null) return null;
  const out = new Map<string, PiModelDef[]>();
  for (const [name, pdef] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof pdef !== "object" || pdef === null) continue;
    const models = (pdef as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    out.set(
      name,
      models.filter(
        (m): m is PiModelDef => typeof m === "object" && m !== null && typeof (m as PiModelDef).id === "string",
      ),
    );
  }
  return out;
}

/** True when every model the fleet could use is free: each enabled role's effective
 * provider/model (configForRole — the director included, it is a catalog role) plus the
 * reviewer's while review is on. Any unresolvable pair — omitted values (pi's own default),
 * missing or malformed definitions file, unknown provider or model id — counts as NOT free:
 * an unverified model may well be paid, and the badge must never read n/a while spend it is
 * tracking could still reach the cap. With no enabled roles and review off there are no
 * pairs at all, so the fleet cannot spend and the answer is true. */
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
  if (!providers) return false;
  for (const [provider, model] of pairs) {
    if (!provider || !model) return false; // pi's own default — cannot verify it is free
    const def = providers.get(provider)?.find((m) => m.id === model);
    if (def === undefined || !costIsFree(def.cost)) return false;
  }
  return true;
}
