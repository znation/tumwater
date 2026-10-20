import path from "node:path";
import type { ModelSelector } from "../config/model-selector.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { isJsonObject } from "../files/json-object.js";
import { readJsonFile } from "../files/json-files.js";

/** pi's own saved-default model, read from pi's `settings.json` beside the models catalog —
 * the name a role row shows when `tumwater.json` resolves no model and pi starts on its own
 * default. This mirrors step 3 of pi 1.2.0's start-up model choice, "saved default from
 * settings" (`findInitialModel` in pi's `dist/core/model-resolver.js`), for a run tumwater
 * starts without `--provider`/`--model`. The reader does NOT model pi's last step: when the
 * default pair is missing from pi's catalog or has no auth, pi picks the first available
 * model — tumwater cannot resolve that pattern (see `enabledModels` below), so it shows
 * nothing rather than a name pi may not run. */

/** pi's `settings.json` path, derived from the models catalog path so the two files share one
 * seam: `snapshot` and `rolePayload` already take `modelsPath`, and the default
 * `piModelsPath()` follows `$PI_CODING_AGENT_DIR` through `piAgentDir`. The secret-leak gate
 * derives `auth.json` the same way. */
export function piSettingsPath(modelsPath: string): string {
  return path.join(path.dirname(modelsPath), "settings.json");
}

/** Per-poll cache of the parsed default, keyed by settings path: the snapshot runs on every
 * poll while settings.json changes only when a user edits it, so an unchanged file costs one
 * stat per poll instead of a re-read plus JSON.parse. Any write invalidates via
 * dev/ino/mtime/size (stat-cache.cachedByStat, same freshness check as the other polled files);
 * a missing or malformed file yields null and is not cached, so a mid-edit broken file recovers
 * on the next poll exactly like before. */
const settingsCache = new Map<string, StatKeyedValue<ModelSelector>>();

/** The keys of pi's settings.json that decide the saved default (findInitialModel's inputs):
 * the default pair, its preferred thinking, and the two scope patterns — `enabledModels`
 * (pi starts on the first scoped model instead) and the project-local override file's own
 * settings. */
const DEFAULT_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "enabledModels",
  "modelThinkingLevels",
] as const;

/** The model pi starts on when tumwater names none, or null when it cannot be known. Mirrors
 * step 3 of pi 1.2.0's start-up model choice ("saved default from settings") for a run started
 * without `--provider`/`--model`. Null when the file is missing, unreadable, or not a JSON
 * object; when `defaultProvider` and `defaultModel` are not both non-empty strings (pi uses a
 * saved default only as a pair); when `enabledModels` is a non-empty array (pi then starts on
 * the first scoped model, a pattern tumwater does not resolve); or when
 * `<projectRoot>/.pi/settings.json` exists and names any of the default keys — pi merges that
 * file over the global one only for a project it trusts, and tumwater cannot tell whether it
 * does, so showing nothing is better than naming a model pi may not run. Otherwise returns
 * `{ provider, model }` with `thinking` from `modelThinkingLevels["<provider>/<model>"]` when
 * that is a string, else from `defaultThinkingLevel` when that is a string — pi's precedence. */
export function readPiDefaultModel(
  settingsPath: string,
  projectRoot: string,
): ModelSelector | null {
  return cachedByStat(
    settingsCache,
    settingsPath, // Keyed by path so distinct roots and test files never collide.
    settingsPath,
    () => readPiDefaultModelUncached(settingsPath, projectRoot),
    (defaultModel) => ({ ...defaultModel }),
  );
}

function readPiDefaultModelUncached(
  settingsPath: string,
  projectRoot: string,
): ModelSelector | null {
  // readJsonFile is the shared "missing or torn reads as no data" policy for a JSON object
  // file; the nested shapes get the same isJsonObject guard.
  const doc = readJsonFile<Record<string, unknown>>(settingsPath);
  if (!doc) return null;
  const { defaultProvider, defaultModel } = doc;
  if (typeof defaultProvider !== "string" || defaultProvider === "") return null;
  if (typeof defaultModel !== "string" || defaultModel === "") return null;
  if (Array.isArray(doc.enabledModels) && doc.enabledModels.length > 0) return null;
  // A project-local override that names any default key means pi's final choice depends on
  // whether it trusts the project — unknowable to tumwater, so show nothing.
  const proj = readJsonFile<Record<string, unknown>>(path.join(projectRoot, ".pi", "settings.json"));
  if (proj) {
    for (const key of DEFAULT_KEYS) {
      if (proj[key] !== undefined) return null;
    }
  }
  const key = `${defaultProvider}/${defaultModel}`;
  const levels = doc.modelThinkingLevels;
  const level = isJsonObject(levels) ? levels[key] : undefined;
  let thinking: string | undefined;
  if (typeof level === "string") thinking = level;
  else if (typeof doc.defaultThinkingLevel === "string") thinking = doc.defaultThinkingLevel;
  return thinking !== undefined
    ? { provider: defaultProvider, model: defaultModel, thinking }
    : { provider: defaultProvider, model: defaultModel };
}
