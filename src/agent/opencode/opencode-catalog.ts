// vocabulary: plain
/** The data half of OpenCode free-ness (plans/opencode-backend.md §7; part 6a/7): a bounded
 * fetch of models.dev's `api.json` — the catalog OpenCode itself caches (finding 10) — a parse
 * that keeps only the providers the config routes through OpenCode, a cache at
 * `.tumwater/state/opencode-models.json` that survives a failed fetch, and
 * `opencodeModelFree` as the one predicate part 6b/7's seam reads. No seam is wired here: that
 * is part 6b/7 (the budget gate), part 6c/7 (a billedAt demotion on an observed cost) and
 * part 7/7 (a startup-cache seed and doctor), so this module's only callers today are its own
 * tests. */

import { spawnSync } from "node:child_process";
import { readJsonFile, writeJsonAtomic } from "../../files/json-files.js";
import { opencodeModelsPath } from "../../paths.js";

/** models.dev's catalog, the data OpenCode caches in its database `kv` table (finding 10). */
const CATALOG_URL = "https://models.dev/api.json";

/** The fetch bound (finding 10; the plan's 30 s): OpenCode prices from the same endpoint at
 * most once a day, so a slow or wedged network must not hold the team up. */
const CATALOG_FETCH_TIMEOUT_MS = 30_000;

/** How long a fetched cache is trusted before it is refreshed. */
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** One model the config routes through OpenCode: whether it is free (input and output cost both
 * 0 in the catalog) plus the fields later parts read (per-M prices for doctor, the context
 * window, image input and the effort levels for part 6d/7). `billedAt`, set by part 6c/7 when a
 * run reports a nonzero cost on a catalog-free model, demotes a free model to priced and is the
 * only field that must survive a cache refresh. */
interface OpencodeCatalogModel {
  /** Input and output cost are both 0 in the catalog. */
  free: boolean;
  /** Input cost per million tokens. */
  inputPerM?: number;
  /** Output cost per million tokens. */
  outputPerM?: number;
  /** `limit.context` — the model's context window. */
  context?: number;
  /** `modalities.input` includes `"image"`. */
  images?: boolean;
  /** The `values` of the `reasoning_options` entries whose `type` is `"effort"` — the thinking
   * levels a variant `#level` may select (finding 9). */
  efforts?: string[];
  /** Set when an observed cost marks this catalog-free model priced (part 6c/7). */
  billedAt?: number;
}

/** The cached catalog: when it was fetched (epoch ms), the `opencode --version` that fetched
 * it (a version change forces a refresh), and the kept models keyed `<provider>/<model>`. */
export interface OpencodeCatalogCache {
  fetchedAt: number;
  cliVersion?: string;
  models: Record<string, OpencodeCatalogModel>;
}

/** An injectable catalog GET: takes the URL and timeout bound and returns the parsed JSON body,
 * throwing on any failure. The default is node's built-in `fetch`; tests supply a fake so no
 * real network is touched. */
export type CatalogFetch = (url: string, timeoutMs: number) => Promise<unknown>;

const defaultFetch: CatalogFetch = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`models.dev catalog ${res.status} ${res.statusText}`);
  return res.json();
};

/** GET models.dev's catalog, bounded at 30 s. Returns the parsed JSON body, or the injected
 * (or default) fetch throws on a failure. So a spare `opencode` binary is never needed just to
 * cable this up; the version check that forces a refresh lives in refreshOpencodeCatalog. */
export async function fetchOpencodeCatalog(fetchFn: CatalogFetch = defaultFetch): Promise<unknown> {
  return fetchFn(CATALOG_URL, CATALOG_FETCH_TIMEOUT_MS);
}

/** Parse models.dev's `api.json` into the models the config routes through OpenCode: always the
 * `opencode` provider, plus every provider named in `providers` (the config's
 * `opencode/<provider>/…` routes — `opencode-go` and so on). The live `GET /api.json` returns
 * the provider map at the top level; OpenCode's cached copy wraps that same map under a `body`
 * key (the 2.0.32 capture in test/fixtures), so both shapes are accepted. Each kept model is
 * keyed `<provider>/<model>`. A model never present yields no entry, so an unknown model is
 * automatically "not free" to opencodeModelFree. */
export function parseOpencodeCatalog(body: unknown, providers: readonly string[]): Record<string, OpencodeCatalogModel> {
  const out: Record<string, OpencodeCatalogModel> = {};
  const root = body as { body?: unknown } | null;
  // models.dev's api.json IS the provider map; OpenCode's cached copy wraps that map under `body`.
  const wrapped = root?.body;
  const catalog =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : ((body ?? {}) as Record<string, unknown>);
  for (const [provider, providerRaw] of Object.entries(catalog)) {
    if (provider !== "opencode" && !providers.includes(provider)) continue;
    const providerInfo = providerRaw as { models?: Record<string, unknown> } | null;
    if (providerInfo?.models === undefined) continue;
    for (const [id, raw] of Object.entries(providerInfo.models)) {
      const m = raw as {
        cost?: { input?: number; output?: number };
        limit?: { context?: number };
        modalities?: { input?: string[] };
        reasoning_options?: { type?: string; values?: string[] }[];
      } | null;
      // Only a present cost block marks a model free: a missing cost block is unknown price data,
      // and treating it as $0 is the unsafe direction for a budget gate.
      const cost = m?.cost;
      const input = cost?.input ?? 0;
      const output = cost?.output ?? 0;
      const model: OpencodeCatalogModel = { free: cost !== undefined && input === 0 && output === 0 };
      if (cost !== undefined) {
        model.inputPerM = input;
        model.outputPerM = output;
      }
      if (m?.limit?.context !== undefined) model.context = m.limit.context;
      if (m?.modalities?.input !== undefined) model.images = m.modalities.input.includes("image");
      const efforts = m?.reasoning_options
        ?.filter((r) => r.type === "effort")
        .flatMap((r) => r.values ?? []);
      if (efforts !== undefined && efforts.length > 0) model.efforts = efforts;
      out[`${provider}/${id}`] = model;
    }
  }
  return out;
}

/** True when the catalog says the model is free and no run has marked it billed (part 6c/7).
 * A model missing from the cache, a priced one, and a free one with `billedAt` set are all not
 * free — the safe direction for a budget gate. */
export function opencodeModelFree(cache: OpencodeCatalogCache, model: string): boolean {
  const entry = cache.models[model];
  return entry !== undefined && entry.free && entry.billedAt === undefined;
}

/** Read the cached catalog, or an empty one (fetchedAt 0, no models) when the file is missing
 * or malformed — the harness's no-data policy, so a torn write reads as "needs a refresh". */
function loadOpencodeCache(root: string): OpencodeCatalogCache {
  const existing = readJsonFile<Partial<OpencodeCatalogCache>>(opencodeModelsPath(root));
  if (existing !== null && typeof existing.fetchedAt === "number" && existing.models !== undefined && typeof existing.models === "object" && !Array.isArray(existing.models)) {
    return {
      fetchedAt: existing.fetchedAt,
      cliVersion: typeof existing.cliVersion === "string" ? existing.cliVersion : undefined,
      models: existing.models,
    };
  }
  return { fetchedAt: 0, models: {} };
}

/** Persist the catalog cache atomically under `.tumwater/state/`. */
export function writeOpencodeCache(root: string, cache: OpencodeCatalogCache): void {
  writeJsonAtomic(opencodeModelsPath(root), cache);
}

/** Read the installed opencode CLI's version, undefined when it cannot be read (no binary, a
 * timeout, or a spawn failure). A changed version forces a catalog refresh: OpenCode serves from
 * the same models.dev data, so a new CLI may route to providers the old cache does not know. */
function readCliVersion(): string | undefined {
  try {
    const res = spawnSync("opencode", ["--version"], { stdio: "pipe", encoding: "utf8", timeout: 5_000 });
    const version = res.stdout?.trim();
    return version === undefined || version === "" ? undefined : version;
  } catch {
    return undefined;
  }
}

/** Options for refreshOpencodeCatalog, every moving part injectable so the cache logic is
 * testable with no network and no real CLI. */
interface OpencodeRefreshOptions {
  /** The providers the config routes through OpenCode (`opencode/<provider>/…`), passed to
   * parseOpencodeCatalog. */
  providers: readonly string[];
  /** Overrides the default models.dev fetch. */
  fetch?: CatalogFetch;
  /** Overrides the `opencode --version` probe. */
  cliVersion?: string;
  /** Overrides Date.now, for a deterministic age check. */
  now?: () => number;
  /** Called once when a fetch fails but an old cache is kept (part 6a's "logs one warning"). */
  warn?: (message: string) => void;
}

/** Return a cache fresh enough to price by, fetching and persisting when the current one is
 * missing, stale (older than 24 h) or fetched by a different `opencode --version`. A failed
 * fetch keeps the old cache (logging one warning) so the team still prices by the last good
 * data; `billedAt` from the old cache survives a successful refresh (part 6c/7). */
export async function refreshOpencodeCatalog(root: string, opts: OpencodeRefreshOptions): Promise<OpencodeCatalogCache> {
  const now = opts.now !== undefined ? opts.now() : Date.now();
  const version = opts.cliVersion !== undefined ? opts.cliVersion : readCliVersion();
  const current = loadOpencodeCache(root);
  const fresh =
    current.fetchedAt !== 0 &&
    now - current.fetchedAt < CATALOG_CACHE_TTL_MS &&
    (version === undefined || current.cliVersion === version);
  if (fresh) return current;
  let body: unknown;
  try {
    body = await fetchOpencodeCatalog(opts.fetch);
  } catch {
    opts.warn?.(`open code model catalog fetch failed; keeping the cached copy`);
    return current.fetchedAt === 0 ? { fetchedAt: 0, cliVersion: version, models: {} } : current;
  }
  const parsed = parseOpencodeCatalog(body, opts.providers);
  for (const key of Object.keys(parsed)) {
    const fresh = parsed[key];
    const old = current.models[key];
    if (fresh !== undefined && old?.billedAt !== undefined) fresh.billedAt = old.billedAt;
  }
  const cache: OpencodeCatalogCache = { fetchedAt: now, cliVersion: version, models: parsed };
  writeOpencodeCache(root, cache);
  return cache;
}
