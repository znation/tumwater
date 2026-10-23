/** The Codex model catalog (plans/codex-backend.md design finding 14 — "Spend, free-ness,
 * window, images" part 8/9): tumwater reads a Codex model's effort levels, default effort,
 * context window and image input from `$CODEX_HOME/models_cache.json`, the file the CLI itself
 * refreshes and `codex debug models` prints. Before part 8/9 the adapter assumed every Codex
 * model had every effort and read every image; the catalog refines both, and seats the context
 * window `seamContextWindow` reports for a codex seam. There are no prices in the catalog — the
 * whole file knows nothing of cost — so free-ness never reads here; the codex account
 * (codex-account.ts) owns billing.
 *
 * A missing, unreadable or malformed file reads as an empty catalog, the same "no data" policy
 * pi's models.json reader uses: the adapter then answers blind (no effort gating, no images,
 * no window), which is the safe direction for the window and image checks. The parse itself is
 * pure and build-agnostic — no registry, config or subprocess — so the adapter, pi's
 * seamContextWindow and the doctor can read one answer without dragging a runtime in. */
import os from "node:os";
import path from "node:path";
import { cachedByStat, type StatKeyedValue } from "../../files/stat-cache.js";
import { finiteNumber, isJsonObject } from "../../files/json-object.js";
import { readJsonFile } from "../../files/json-files.js";
import { expandHomeTilde } from "../../files/files.js";

/** One model's catalog entry: the effort levels the model itself lists (so a thinking level
 * the model does not support is never sent), its default effort, the context window in tokens
 * (`context_window × effective_context_window_percent / 100`), and whether its
 * `input_modalities` include `"image"`. */
export interface CodexCatalogEntry {
  /** The model's `supported_reasoning_levels` efforts, in catalog order. */
  levels: string[];
  /** The model's `default_reasoning_level`, when named. */
  defaultLevel?: string;
  /** The effective context window in tokens, scaled by the percent the CLI reports. */
  contextWindow: number;
  /** True when the model's `input_modalities` includes `"image"`. */
  images: boolean;
}

/** The team's Codex home for a run: `backends.codex.configDir`, a leading `~` expanded, else
 * the CLI's default `~/.codex` — a run with no configured home keeps the operator's
 * `CODEX_HOME`, which is exactly Codex's own default home, so the catalog and the sessions
 * live there too and a known home always exists. Pure. Shared by the adapter, pi's
 * seamContextWindow and the codex-account seed, so all three read one home. */
export function codexHome(config: { configDir?: string }): string {
  const dir = config.configDir;
  if (dir === undefined) return path.join(os.homedir(), ".codex");
  return expandHomeTilde(dir, os.homedir());
}

/** Where a home's model catalog lives: `$CODEX_HOME/models_cache.json`. */
export function codexModelsPath(home: string): string {
  return path.join(home, "models_cache.json");
}

/** Per-catalog cache of the parsed entries, keyed by the models_cache path: the status
 * surfaces read the window every poll while the file changes only when the CLI refreshes it —
 * and it grows with the model catalog — so an unchanged file costs one stat per poll instead
 * of a re-read plus a JSON.parse of the whole file. Any write invalidates via
 * dev/ino/mtime/size (stat-cache.cachedByStat, the same freshness check pi's providers use). */
const catalogCache = new Map<string, StatKeyedValue<Map<string, CodexCatalogEntry>>>();

/** The parsed model catalog from `$CODEX_HOME/models_cache.json`, keyed by model slug, or an
 * empty map when the file is missing, unreadable, malformed or not shaped like what the CLI
 * writes. A model's entry is kept only when it names a usable slug and context_window; a
 * missing `effective_context_window_percent` reads as no window (the model is dropped), since
 * the window is the whole point of the entry. The returned map is a copy — callers may treat
 * their result as their own. */
export function readCodexCatalog(home: string): Map<string, CodexCatalogEntry> {
  const modelsPath = codexModelsPath(home);
  return (
    cachedByStat(
      catalogCache,
      modelsPath,
      modelsPath,
      () => {
        const out = new Map<string, CodexCatalogEntry>();
        // readJsonFile is the shared "missing or torn reads as no data" policy for a JSON
        // object file; the nested `models` array gets the same isJsonObject/Array guards.
        const doc = readJsonFile<Record<string, unknown>>(modelsPath);
        if (doc === null) return out;
        const models = doc.models;
        if (!Array.isArray(models)) return out;
        for (const model of models) {
          const entry = parseModelEntry(model);
          if (entry !== undefined) out.set(entry.slug, entry.entry);
        }
        return out;
      },
      (models) =>
        new Map([...models].map(([slug, entry]) => [slug, { ...entry, levels: [...entry.levels] }])),
    ) ?? new Map<string, CodexCatalogEntry>()
  );
}

/** One catalog model entry as the map needs it: the slug to key by plus the parsed entry. The
 * entry is kept only when the slug and context window are usable; any other missing field
 * (levels, modalities, default level) just reads as absent on the entry. */
function parseModelEntry(
  model: unknown,
): { slug: string; entry: CodexCatalogEntry } | undefined {
  if (!isJsonObject(model) || typeof model.slug !== "string") return undefined;
  const context = finiteNumber(model.context_window, Number.NaN);
  const percent = finiteNumber(model.effective_context_window_percent, Number.NaN);
  if (!Number.isFinite(context) || !Number.isFinite(percent)) return undefined;
  const levels: string[] = [];
  if (Array.isArray(model.supported_reasoning_levels)) {
    for (const level of model.supported_reasoning_levels) {
      if (isJsonObject(level) && typeof level.effort === "string") levels.push(level.effort);
    }
  }
  const modalities = model.input_modalities;
  return {
    slug: model.slug,
    entry: {
      levels,
      ...(typeof model.default_reasoning_level === "string"
        ? { defaultLevel: model.default_reasoning_level }
        : {}),
      contextWindow: Math.round((context * percent) / 100),
      images: Array.isArray(modalities) && modalities.includes("image"),
    },
  };
}
