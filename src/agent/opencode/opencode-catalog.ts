/** The data half of OpenCode free-ness (plans/opencode-backend.md §7; part 6a/7): a bounded
 * fetch of models.dev's `api.json` — the catalog OpenCode itself caches (finding 10) — a parse
 * that keeps only the providers the config routes through OpenCode, a cache at
 * `.tumwater/state/opencode-models.json` that survives a failed fetch, and
 * `opencodeModelFree` as the one predicate part 6b/7's seam reads. No seam is wired here: that
 * is part 6b/7 (the budget gate), part 6c/7 (a billedAt demotion on an observed cost) and
 * part 7/7 (a startup-cache seed and doctor), so this module's only callers today are its own
 * tests. */

import { spawnSync } from "node:child_process";
import { isJsonObject, validEntries } from "../../files/json-object.js";
import { readJsonFile, writeJsonAtomic } from "../../files/json-files.js";
import { errorMessage } from "../../text/text.js";
import { opencodeModelsPath } from "../../paths.js";
import { logEventBestEffort, type HarnessEventInput } from "../../events/events.js";
import { opencodeQualifiedModel } from "./opencode-args.js";

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
 * automatically "not free" to opencodeModelFree. The body is untrusted network data: a malformed
 * provider or model is skipped, never thrown on. */
export function parseOpencodeCatalog(body: unknown, providers: readonly string[]): Record<string, OpencodeCatalogModel> {
  const out: Record<string, OpencodeCatalogModel> = {};
  const root = isJsonObject(body) ? body : {};
  // models.dev's api.json IS the provider map; OpenCode's cached copy wraps that map under `body`.
  const wrapped = root.body;
  const catalog = isJsonObject(wrapped) ? wrapped : root;
  for (const [provider, providerInfo] of Object.entries(catalog)) {
    if (provider !== "opencode" && !providers.includes(provider)) continue;
    if (!isJsonObject(providerInfo) || !isJsonObject(providerInfo.models)) continue;
    for (const [id, m] of Object.entries(providerInfo.models)) {
      if (!isJsonObject(m)) continue;
      // Only a present cost block marks a model free: a missing cost block is unknown price data,
      // and treating it as $0 is the unsafe direction for a budget gate.
      const cost = isJsonObject(m.cost) ? m.cost : undefined;
      const input = cost?.input ?? 0;
      const output = cost?.output ?? 0;
      const model: Record<string, unknown> = { free: cost !== undefined && input === 0 && output === 0 };
      if (cost !== undefined) {
        model.inputPerM = input;
        model.outputPerM = output;
      }
      if (isJsonObject(m.limit) && m.limit.context !== undefined) model.context = m.limit.context;
      if (isJsonObject(m.modalities) && Array.isArray(m.modalities.input)) {
        model.images = m.modalities.input.includes("image");
      }
      if (Array.isArray(m.reasoning_options)) {
        const efforts = m.reasoning_options
          .flatMap((r: unknown) =>
            isJsonObject(r) && r.type === "effort" && Array.isArray(r.values) ? (r.values as unknown[]) : [],
          );
        if (efforts.length > 0) model.efforts = efforts;
      }
      if (isOpencodeCatalogModel(model)) out[`${provider}/${id}`] = model;
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

/** The catalog cache key for an opencode run's resolved selector: the `<provider>/<model>`
 * form part 6a/7 keys the cache by. Delegates the bare-gateway-prefix rule to
 * opencode-args.ts's opencodeQualifiedModel (the single home), so the key a run is priced by
 * always matches the id a run is invoked by. */
export function opencodeModelKey(selector: string): string {
  return opencodeQualifiedModel(selector);
}

/** Options for observeOpencodeRun, every moving part injectable so the demo logic is testable
 * with no real event feed. */
interface OpencodeObserveOptions {
  /** The event-feed source (role id) for the `opencode_free_model_billed` event. */
  source: string;
  /** Overrides Date.now, for a deterministic `billedAt` stamp. */
  now?: () => number;
  /** Overrides the event logger (default logEventBestEffort), for tests. */
  log?: (event: HarnessEventInput) => void;
}

/** Demote a catalog-free model the moment a run bills it (part 6c/7): when a run reports a
 * nonzero cost on a model the cache calls free, mark that entry priced (`billedAt`) in the
 * cache and log `opencode_free_model_billed` {model, costUsd} once. A subsequent priced run on
 * the same model sees `billedAt` already set and stays silent, and the next
 * `opencodeModelFree` answer for it is false. A run reporting $0, a priced model, or an
 * unknown model leaves the cache untouched — a $0 run never demotes (missing and priced
 * models are already "not free" to opencodeModelFree). Best-effort like observeClaudeAccount:
 * the caller wraps the write/log in try/catch so an unwritable cache or feed never fails the
 * run that observed it. Returns the cache after the observation, or null when nothing changed. */
export function observeOpencodeRun(
  root: string,
  run: { model: string; costUsd: number },
  opts: OpencodeObserveOptions,
): OpencodeCatalogCache | null {
  const cache = readOpencodeCache(root);
  const entry = cache.models[run.model];
  if (entry === undefined || !entry.free || entry.billedAt !== undefined || run.costUsd <= 0) {
    return null;
  }
  entry.billedAt = opts.now !== undefined ? opts.now() : Date.now();
  writeOpencodeCache(root, cache);
  const log = opts.log !== undefined ? opts.log : (e: HarnessEventInput) => logEventBestEffort(root, e);
  log({ source: opts.source, type: "opencode_free_model_billed", model: run.model, costUsd: run.costUsd });
  return cache;
}

function isOpencodeCatalogModel(value: unknown): value is OpencodeCatalogModel {
  if (!isJsonObject(value) || typeof value.free !== "boolean") return false;
  const numbers = [value.inputPerM, value.outputPerM, value.context, value.billedAt];
  if (!numbers.every((n) => n === undefined || (typeof n === "number" && Number.isFinite(n)))) return false;
  if (value.images !== undefined && typeof value.images !== "boolean") return false;
  return (
    value.efforts === undefined ||
    (Array.isArray(value.efforts) && value.efforts.every((e) => typeof e === "string"))
  );
}

/** Read the cached catalog, or an empty one (fetchedAt 0, no models) when the file is missing
 * or malformed — the harness's no-data policy, so a torn write reads as "needs a refresh".
 * Exported so the opencode backend's adapter (part 6d/7) and doctor can read the same cache
 * without triggering a network fetch. The synchronous read the sync poll surfaces
 * (pollBudgetGate, collectBudget) use to thread the catalog-cache into their free-ness reads
 * (part 6b/7); the async refresh (which runs once per process at the startup gate) is what
 * fills the file in. Entries that are not well-formed catalog models are dropped, so a foreign
 * entry reads as a model missing from the cache — not free. */
export function readOpencodeCache(root: string): OpencodeCatalogCache {
  const existing = readJsonFile<Partial<OpencodeCatalogCache>>(opencodeModelsPath(root));
  if (existing !== null && typeof existing.fetchedAt === "number" && isJsonObject(existing.models)) {
    return {
      fetchedAt: existing.fetchedAt,
      cliVersion: typeof existing.cliVersion === "string" ? existing.cliVersion : undefined,
      models: validEntries(existing.models, isOpencodeCatalogModel),
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
 * the same models.dev data, so a new CLI may route to providers the old cache does not know.
 * `bin` is the configured opencode binary (default `opencode` on PATH), so the seed probes the
 * same binary the runs spawn. */
function readCliVersion(bin = "opencode"): string | undefined {
  try {
    const res = spawnSync(bin, ["--version"], { stdio: "pipe", encoding: "utf8", timeout: 5_000 });
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
  /** The configured opencode binary to probe for the version (default `opencode` on PATH), so
   * the seed checks the same binary the runs spawn instead of a different one on PATH. */
  cliBin?: string;
  /** Overrides Date.now, for a deterministic age check. */
  now?: () => number;
  /** Called once when a fetch fails but an old cache is kept (part 6a's "logs one warning"). */
  warn?: (message: string) => void;
}

/** Whether the cache is missing or older than CATALOG_CACHE_TTL_MS at `now`. The age rule
 * refreshOpencodeCatalog and the poll-driven refresh (newOpencodeCatalogRefresh) share. */
export function opencodeCatalogStale(cache: OpencodeCatalogCache, now: number): boolean {
  return cache.fetchedAt === 0 || now - cache.fetchedAt >= CATALOG_CACHE_TTL_MS;
}

/** Return a cache fresh enough to price by, fetching and persisting when the current one is
 * missing, stale (older than 24 h) or fetched by a different `opencode --version`. A failed
 * fetch keeps the old cache (logging one warning) so the team still prices by the last good
 * data; `billedAt` from the old cache survives a successful refresh (part 6c/7). A failed cache
 * write warns and returns the fetched catalog, so the next start fetches again. */
export async function refreshOpencodeCatalog(root: string, opts: OpencodeRefreshOptions): Promise<OpencodeCatalogCache> {
  const now = opts.now !== undefined ? opts.now() : Date.now();
  const version = opts.cliVersion !== undefined ? opts.cliVersion : readCliVersion(opts.cliBin);
  const current = readOpencodeCache(root);
  const fresh =
    !opencodeCatalogStale(current, now) &&
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
  try {
    writeOpencodeCache(root, cache);
  } catch (err) {
    opts.warn?.(`could not save the open code model catalog: ${errorMessage(err)}`);
  }
  return cache;
}
