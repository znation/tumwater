import os from "node:os";
import path from "node:path";
import type { ClaudeAccount } from "../agent/claude/claude-account.js";
import type { FallbackModelConfig, TumwaterConfig } from "../config/config-schema.js";
import { enabledRoleIds } from "../config/config.js";
import { configForRole, resolverConfig, reviewConfig } from "../config/config-views.js";
import { fallbackPair } from "../config/config-fallbacks.js";
import { isAgentId } from "../config/model-selector.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { isJsonObject } from "../files/json-object.js";
import { readJsonFile } from "../files/json-files.js";
import { expandHomeTilde } from "../files/files.js";
import { declaredWindow } from "../pi-extension/context-window.js";
import { piSettingsPath, readPiDefaultModel } from "./pi-settings.js";

/** pi's model definitions — the custom providers and models they serve, with each model's
 * declared cost. This is where a local (free) team differs from an API one: unpriced or
 * zero-cost models never accumulate spend against the daily budget cap, so the badge can
 * read n/a instead of a dollar figure that can never move. */
export function piModelsPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return path.join(piAgentDir(env, homeDir), "models.json");
}

/** pi's config directory: `$PI_CODING_AGENT_DIR` when non-empty (a leading `~` expands against
 * the home dir), else `~/.pi/agent`. This mirrors pi's `getAgentDir`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(homeDir, ".pi", "agent");
  return expandHomeTilde(dir, homeDir);
}

export interface PiModelDef {
  id: string;
  /** The model's declared cost — whatever the user's models.json holds, so read as unknown
   * and checked component by component rather than trusted. An absent field means unpriced. */
  cost?: unknown;
  /** The input modalities pi's models.json declares for the model (e.g. `["text"]` or
   * `["text","image"]`). Kept through readPiProviders so the seam image-input resolver
   * (src/agent/image-input.ts) and the doctor's `image input` check can read it; absent — the
   * common case for a hand-written catalog — means pi treats the model as text-only. */
  input?: unknown;
  /** The context window, in tokens, pi's models.json declares for the model — what pi sizes
   * its compaction against. Read through declaredWindow, so an unusable value is no window. */
  contextWindow?: unknown;
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
 * teamModelsFree every second while models.json changes only when a user edits it — and it grows
 * with the model catalog (every added provider/model entry), so an unchanged file costs one stat
 * per poll instead of a re-read plus JSON.parse of the whole catalog. Any write invalidates via
 * dev/ino/mtime/size (stat-cache.cachedByStat, same freshness check as the other polled files in
 * status/status-polls.ts); a missing or malformed file yields null and is not cached, so a mid-edit
 * broken file recovers on the next poll exactly like before. */
const providersCache = new Map<string, StatKeyedValue<Map<string, PiModelDef[]>>>();

/** The parsed provider→models map from pi's definitions, or null when the file is missing,
 * unreadable, malformed, or not shaped like what pi writes (served stat-keyed — see above).
 * Exported for budget-gates.ts's per-tier resolution, which prices several candidate pairs
 * against the same snapshot instead of re-entering this cache per pair.
 */
/** A provider/model pair's claimed image input from pi's definitions: `true` when the model
 * declares `"image"` in its `input`, `false` when the pair resolves but declares no image
 * support (input absent, or present without `"image"` — pi's own text-only default for the
 * custom model), and `null` when the pair cannot be resolved at all (see resolveModelDef). The
 * null case is left to the doctor's `tier models` check, which already fails such pairs. */
export function piModelImageInput(
  providers: Map<string, PiModelDef[]> | null,
  provider: string | undefined,
  model: string | undefined,
): boolean | null {
  const def = resolveModelDef(providers, provider, model);
  if (!def) return null;
  return Array.isArray(def.input) ? def.input.includes("image") : false;
}

export function readPiProviders(modelsPath: string): Map<string, PiModelDef[]> | null {
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

/** The context window a run's model declares in pi's definitions, or null when it cannot be
 * known: a non-pi seam (its backend keeps its own catalog), an unresolvable pair, or a missing
 * or unusable `contextWindow`. A pi seam naming no provider/model runs on pi's saved default
 * (readPiDefaultModel), so that pair is looked up instead — exactly the model pi will start on. */
export function seamContextWindow(
  seam: { agent?: string; provider?: string; model?: string },
  projectRoot: string,
  modelsPath: string = piModelsPath(),
): number | null {
  const agent = seam.agent ?? (isAgentId(seam.provider) ? seam.provider : "pi");
  if (agent !== "pi") return null;
  let { provider, model } = seam;
  if (!provider || !model) {
    const piDefault = readPiDefaultModel(piSettingsPath(modelsPath), projectRoot);
    provider = piDefault?.provider;
    model = piDefault?.model;
  }
  return declaredWindow(resolveModelDef(readPiProviders(modelsPath), provider, model)?.contextWindow);
}

/** A provider's `baseUrl` from pi's models.json, or null when the file, the provider or the
 * field is missing — what doctor probes to tell a local server that is down from one that is up. */
export function piProviderBaseUrl(modelsPath: string, provider: string): string | null {
  const doc = readJsonFile<Record<string, unknown>>(modelsPath);
  const providers = doc?.providers;
  if (!isJsonObject(providers) || !Object.hasOwn(providers, provider)) return null;
  const pdef = providers[provider];
  return isJsonObject(pdef) && typeof pdef.baseUrl === "string" ? pdef.baseUrl : null;
}

/** Resolve a `provider`/`model` pair against pi's definitions — the shared first step of
 * pairFree and cacheReadUnpriced. Undefined when the pair cannot be resolved at all: an
 * omitted provider or model (pi's own default), a missing or malformed definitions file, an
 * unknown provider, or an id the provider does not list. Both callers read an unresolved pair
 * as "cannot verify" — never as free or unpriced — so the lookup and its null guards live here
 * once instead of being re-derived per resolver. */
function resolveModelDef(
  providers: Map<string, PiModelDef[]> | null,
  provider: string | undefined,
  model: string | undefined,
): PiModelDef | undefined {
  if (!providers || !provider || !model) return undefined;
  return providers.get(provider)?.find((m) => m.id === model);
}

/** True when `provider`/`model` names a model pi's definitions price at zero — a "(cost n/a)"
 * pair. Anything unresolvable counts as NOT free: an omitted provider or model (pi's own
 * default), a missing or malformed definitions file, an unknown provider, or a model id the
 * file does not list. An unverified model may well be paid, and no caller here may treat
 * "I could not check" as "it is free" — the badge would lie, and the fallback would defeat
 * the very cap it exists to survive. Private: the backend-aware `piPairFree` below wraps it
 * for every caller, so no site can price a non-pi backend as free by reaching pi's raw check.
 */
function pairFree(
  providers: Map<string, PiModelDef[]> | null,
  provider: string | undefined,
  model: string | undefined,
): boolean {
  const def = resolveModelDef(providers, provider, model);
  return def !== undefined && costIsFree(def.cost);
}

/** True when `provider`/`model` resolves in pi's definitions to a model priced above zero whose
 * cache reads carry no price — the undercount half of BUGS.md 2026-10-06: pi's cost fold then
 * bills every cache-read token at $0, so the daily budget can never see the real spend. False
 * for a pair that does not resolve (the sibling resolvers flag that), an unpriced model (its
 * spend is genuinely zero, so a zero cache price undercounts nothing), or a cost shape this
 * cannot read — the check reports a declared zero, never guesses one. */
export function cacheReadUnpriced(
  providers: Map<string, PiModelDef[]> | null,
  provider: string | undefined,
  model: string | undefined,
): boolean {
  const def = resolveModelDef(providers, provider, model);
  if (!def || !isJsonObject(def.cost)) return false;
  const input = def.cost.input;
  const cacheRead = def.cost.cacheRead;
  const inputPriced = typeof input === "number" && Number.isFinite(input) && input > 0;
  const cacheUnpriced =
    cacheRead === undefined || (typeof cacheRead === "number" && cacheRead === 0);
  return inputPriced && cacheUnpriced;
}

/** A seam's backend identity: the resolved `agent` when a seam carries one (configForRole,
 * reviewConfig and resolverConfig all do), else the agent its provider namespace names, else
 * pi. The shared shape the free predicate below judges and the fallback view preserves. */
interface SeamModel {
  agent?: string;
  provider?: string;
  model?: string;
}

/** True when the persisted account is spending into overage on any window: the subscription's
 * overflow bills real money, so a claude seam is not free while it does. Mirrors the per-run
 * split in `runCostIsReal` (src/pi/pi-run-result.ts) — a run that saw `isUsingOverage` counts as
 * API spend, and so does every seam an overage account would run (plans/agent-backends.md §7
 * "Overage is real money"). */
function accountUsesOverage(account: ClaudeAccount | null): boolean {
  return account !== null && Object.values(account.windows).some((w) => w.isUsingOverage === true);
}

/** Whether a seam may be called free: a subscription claude seam is free money (its marginal
 * cost is zero, plans/agent-backends.md "Free-ness"), and a pi seam is free when pi's own
 * models.json prices it at zero. A subscription that is spending into overage is NOT free: that
 * overflow is API-priced real money, exactly as `runCostIsReal` treats a run that saw
 * `isUsingOverage`. Everything else is NOT free — an API-billed claude seam, an overage
 * subscription claude seam, an unresolvable or priced pi pair, and any other backend — so the
 * badge never reads n/a while spend it cannot see could still reach the cap. The one central
 * rule: the budget gate, the fallback view, and the status free-ness read all judge seams
 * through it (plans/agent-backends.md "Free-ness" and "Every seam, checked"). */
export function seamFree(
  providers: Map<string, PiModelDef[]> | null,
  seam: SeamModel,
  account: ClaudeAccount | null = null,
): boolean {
  const agent = seam.agent ?? (isAgentId(seam.provider) ? seam.provider : "pi");
  // One free-ness rule per backend: pi's pair price, claude's subscription, and nothing for any
  // other backend (its spend could still reach the cap, so the badge must not read n/a). Part 6/7
  // adds opencode's arm here and changes nothing else.
  switch (agent) {
    case "pi":
      return pairFree(providers, seam.provider, seam.model);
    case "claude":
      return account?.billing === "subscription" && !accountUsesOverage(account);
    default:
      return false;
  }
}

/** Whether a fallback-config pair may be called free: a `claude/<id>` pair is free while the
 * account bills a subscription and is not using overage, and a pi provider/model is free when
 * models.json prices it at zero. A non-claude agent namespace, or an unresolvable pi pair, is
 * refused — the badge must not read n/a while a backend whose billing it cannot see runs.
 * Exported so the budget gate (src/gates/budget-gates.ts) and the status pause set
 * (src/status/status-data.ts) judge fallback pairs with the same predicate the free-ness view
 * does — neither may engage a backend their own badge would not call free. */
export function piPairFree(
  providers: Map<string, PiModelDef[]> | null,
  provider: string | undefined,
  model: string | undefined,
  account: ClaudeAccount | null = null,
): boolean {
  return seamFree(providers, { provider, model }, account);
}

/** The free fallback pair the budget gate would engage for the team, or null when none is
 * usable: the price-aware resolution of the default tier (fallbackPair over
 * resolveTierFallbacks' borrow order), so a map whose `default` entry is absent or priced
 * still names the free pair the tier borrows. Null for a missing, unresolvable, or priced
 * pair — the gate's refusal, and the pair the badge/doctor must not advertise. */
export function fallbackModelPair(
  config: TumwaterConfig,
  modelsPath = piModelsPath(),
  account: ClaudeAccount | null = null,
): FallbackModelConfig | null {
  const providers = readPiProviders(modelsPath);
  return fallbackPair(config, (p) => piPairFree(providers, p.provider, p.model, account));
}

/** True when the configured fallback model (plans/fallback-model.md) is one the budget gate may
 * actually engage: configured at all, resolvable to a provider/model pair, and priced at zero in
 * pi's definitions. False for every other case — no fallback, a half-named pair that would fall
 * through to pi's own default, an unknown id, or a priced one — and the gate then pauses role
 * loops exactly as it did before this feature. */
export function fallbackModelFree(
  config: TumwaterConfig,
  modelsPath = piModelsPath(),
  account: ClaudeAccount | null = null,
): boolean {
  return fallbackModelPair(config, modelsPath, account) !== null;
}

/** True when every model the team could use is free: each enabled role's effective
 * provider/model (configForRole — the director included, it is a catalog role, resolved at
 * its tier per plans/model-tiers.md) plus the reviewer's while review is on, plus the
 * `strong` tier's own model whenever any role is enabled — the conflict resolver (part 4/8)
 * runs on strong, so the budget must never read n/a while a priced strong model can spend.
 * Every pair is judged by `seamFree` above: a subscription claude seam is free, a pi seam is
 * free when models.json prices it at zero, and everything else counts as NOT free — the badge
 * must never read n/a while spend it is tracking could still reach the cap. With no enabled
 * roles and review off there are no pairs at all, so the team cannot spend and the answer is
 * true. `account` is the persisted claude billing answer (6a/7's reader), absent meaning "no
 * subscription". */
export function teamModelsFree(
  config: TumwaterConfig,
  modelsPath = piModelsPath(),
  account: ClaudeAccount | null = null,
): boolean {
  const pairs: Array<{ agent: string | undefined; provider: string | undefined; model: string | undefined }> = [];
  for (const role of enabledRoleIds(config)) {
    const rc = configForRole(config, role);
    pairs.push({ agent: rc.agent, provider: rc.provider, model: rc.model });
  }
  if (config.review.enabled) {
    const rv = reviewConfig(config);
    pairs.push({ agent: rv.agent, provider: rv.provider, model: rv.model });
  }
  // The conflict resolver's strong tier (part 4/8): priced whenever any seam can run, read
  // through the same resolved view the resolver runs on so its backend is known too.
  if (pairs.length > 0) {
    const strong = resolverConfig(config);
    pairs.push({ agent: strong.agent, provider: strong.provider, model: strong.model });
  }
  // No enabled roles and review off: nothing can spend, so the budget is n/a by
  // construction — no definitions file to consult.
  if (pairs.length === 0) return true;
  const providers = readPiProviders(modelsPath);
  return pairs.every((seam) => seamFree(providers, seam, account));
}
