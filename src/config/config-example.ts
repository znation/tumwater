import fs from "node:fs";
import type { TumwaterConfig } from "./config-schema.js";
import { defaultConfig, overlayDefaults, parseJsonConfig } from "./config.js";
import { CONFIG_BASENAME, configPath, EXAMPLE_CONFIG_BASENAME, exampleConfigPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { isJsonObject } from "../files/json-object.js";
import { validateConfig } from "./config-validation.js";

/** The tumwater.example.json template concern: seeding a fresh tumwater.json from the tracked
 * template, judging whether the template can serve at all, and reporting what it would add.
 * Split out of config.ts so the load/save/validate core does not own this init- and doctor-
 * facing surface (plans/portability.md §4a/7). */

/** Read the tracked tumwater.example.json, or `undefined` when it is absent: the single
 * existsSync + parseJsonConfig pass every example-template reader goes through, so the
 * file is parsed once per call instead of each site restating the read and its problem
 * check (seedConfig previously parsed the template twice — once inside its
 * exampleConfigProblem guard, once for its own overlay). The problem is returned, not
 * thrown: each caller decides what a broken template means for it. */
function parseExampleTemplate(root: string): { raw: unknown; problem?: string } | undefined {
  const file = exampleConfigPath(root);
  if (!fs.existsSync(file)) return undefined;
  const { raw, problem } = parseJsonConfig(file, EXAMPLE_CONFIG_BASENAME);
  return { raw, problem };
}

/** Build the config `init` seeds a fresh tumwater.json with (plans/portability.md §4a/7): the
 * tracked tumwater.example.json overlaid on the defaults when the project ships one, the bare
 * defaults when it does not. Never throws: an unparseable or invalid template falls back to the
 * defaults, because init must not die on a bad template — the user's own tumwater.json is what
 * validation protects. */
export function seedConfig(root: string): TumwaterConfig {
  const base = defaultConfig();
  // Absent and broken both seed the bare defaults: no template, or one that cannot serve.
  // One read serves both the can-it-serve judgment and the overlay: a file torn between
  // the check and the use within this single parse falls back with the same semantics the
  // old double read gave it.
  const template = parseExampleTemplate(root);
  if (template === undefined || template.problem !== undefined) return base;
  try {
    validateConfig(template.raw, EXAMPLE_CONFIG_BASENAME);
  } catch {
    return base;
  }
  return overlayDefaults(base, template.raw as Partial<TumwaterConfig>);
}

/** Why tumwater.example.json cannot serve as a seed template, or null when it can: null when
 * the file is absent or parses and validates, a human message naming the file when it exists
 * but is unparseable or holds invalid values. This is the only signal a broken template ever
 * gets — seedConfig falls back to the bare defaults and exampleDrift reports no drift, so
 * without it the operator's template intent (their roles/intervals baseline for fresh clones)
 * is ignored with nothing anywhere saying so. doctor's init check surfaces the message. */
export function exampleConfigProblem(root: string): string | null {
  const template = parseExampleTemplate(root);
  if (template === undefined) return null;
  const { raw, problem } = template;
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
  const config = configPath(root);
  const template = parseExampleTemplate(root);
  if (!fs.existsSync(config) || template === undefined) return [];
  const local = parseJsonConfig(config, CONFIG_BASENAME);
  if (template.problem !== undefined || local.problem !== undefined) return [];
  if (!isJsonObject(template.raw) || !isJsonObject(local.raw)) return [];
  return Object.keys(template.raw).filter((k) => !(k in (local.raw as object)));
}