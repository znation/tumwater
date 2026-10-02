import fs from "node:fs";
import type { TumwaterConfig } from "./config-schema.js";
import { defaultConfig, overlayDefaults, parseJsonConfig } from "./config.js";
import { CONFIG_BASENAME, configPath, EXAMPLE_CONFIG_BASENAME, exampleConfigPath } from "./paths.js";
import { errorMessage } from "./text.js";
import { isJsonObject } from "./json-object.js";
import { validateConfig } from "./config-validation.js";

/** The tumwater.example.json template concern: seeding a fresh tumwater.json from the tracked
 * template, judging whether the template can serve at all, and reporting what it would add.
 * Split out of config.ts so the load/save/validate core does not own this init- and doctor-
 * facing surface (plans/portability.md §4a/7). */

/** Build the config `init` seeds a fresh tumwater.json with (plans/portability.md §4a/7): the
 * tracked tumwater.example.json overlaid on the defaults when the project ships one, the bare
 * defaults when it does not. Never throws: an unparseable or invalid template falls back to the
 * defaults, because init must not die on a bad template — the user's own tumwater.json is what
 * validation protects. */
export function seedConfig(root: string): TumwaterConfig {
  const base = defaultConfig();
  const file = exampleConfigPath(root);
  // Absent and broken both seed the bare defaults: no template, or one that cannot serve.
  if (!fs.existsSync(file) || exampleConfigProblem(root) !== null) return base;
  // The template already passed exampleConfigProblem's read; reparse here instead of threading
  // the earlier raw through, so a file torn between the two reads seeds the bare defaults.
  const { raw, problem } = parseJsonConfig(file, EXAMPLE_CONFIG_BASENAME);
  if (problem !== undefined) return base;
  return overlayDefaults(base, raw as Partial<TumwaterConfig>);
}

/** Why tumwater.example.json cannot serve as a seed template, or null when it can: null when
 * the file is absent or parses and validates, a human message naming the file when it exists
 * but is unparseable or holds invalid values. This is the only signal a broken template ever
 * gets — seedConfig falls back to the bare defaults and exampleDrift reports no drift, so
 * without it the operator's template intent (their roles/intervals baseline for fresh clones)
 * is ignored with nothing anywhere saying so. doctor's init check surfaces the message. */
export function exampleConfigProblem(root: string): string | null {
  const file = exampleConfigPath(root);
  if (!fs.existsSync(file)) return null;
  const { raw, problem } = parseJsonConfig(file, EXAMPLE_CONFIG_BASENAME);
  if (problem !== undefined) return problem;
  try {
    validateConfig(raw, EXAMPLE_CONFIG_BASENAME);
  } catch (err) {
    return errorMessage(err);
  }
  return null;
}

/** Top-level keys the tracked template sets that the local tumwater.json lacks
 * (plans/portability.md §4a/7): what doctor's init check reports as template drift. Whole-key
 * only — sub-objects are reported as units, and a key present in both files is the local file's
 * business even when the values differ (deep diffing is a bigger design than this needs). []
 * when either file is missing or unparseable: with no template there is nothing to drift from,
 * and a broken local file is checkInit's fail, not a drift line. */
export function exampleDrift(root: string): string[] {
  const example = exampleConfigPath(root);
  const config = configPath(root);
  if (!fs.existsSync(example) || !fs.existsSync(config)) return [];
  const template = parseJsonConfig(example, EXAMPLE_CONFIG_BASENAME);
  const local = parseJsonConfig(config, CONFIG_BASENAME);
  if (template.problem !== undefined || local.problem !== undefined) return [];
  if (!isJsonObject(template.raw) || !isJsonObject(local.raw)) return [];
  return Object.keys(template.raw).filter((k) => !(k in (local.raw as object)));
}