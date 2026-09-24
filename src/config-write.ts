/** Harness-mediated config WRITES — the mutators behind the operator surfaces (the TUI's
 * Ctrl+B editor, the GUI's /api/budget endpoint) and the director's config requests. Each
 * one loads fresh (bypassing config.ts's stat cache), validates before writing, and writes
 * atomically, because readers poll tumwater.json every ~2 s. The read side — defaults,
 * loading, saving, and the role/model derivations — lives in config.ts. */
import fs from "node:fs";
import type { TumwaterConfig } from "./config-schema.js";
import { configPath, configRequestPath } from "./paths.js";
import { errorMessage } from "./text.js";
import { writeJsonAtomic } from "./json-files.js";
import { isJsonObject } from "./json-object.js";
import { show, validateConfig } from "./config-validation.js";
import { loadConfig } from "./config.js";
/** One definition of "a valid daily budget cap" (the TUI's Ctrl+B editor and the GUI's
 * /api/budget endpoint both run their input through it): a finite number of 0 or more —
 * 0 disables the gate, fractional dollars allowed (the badge renders cents). Returns an
 * actionable error message for anything else so both surfaces can flash it without
 * try/catch plumbing. */
export function checkDailyBudgetUsd(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return `maxDailyCostUsd must be a number of 0 or more, 0 disables (got ${show(value)})`;
  return null;
}

/** Set the daily cost budget cap in tumwater.json: fresh loadConfig (no stat cache — a
 * writer must see the latest file), validate the value, mutate ONLY that key, and write
 * atomically (writeJsonAtomic: tmp file + rename) because this is the first in-harness
 * WRITER of the config while readers poll it every ~2 s and two dashboards could save
 * concurrently. A broken or missing-on-disk config surfaces as an error string instead of
 * throwing, so both UIs can flash it; on any failure the file (and no tmp remnant) is left
 * untouched. */
export function setDailyBudgetUsd(
  root: string,
  value: number,
): { ok: true } | { ok: false; error: string } {
  const problem = checkDailyBudgetUsd(value);
  if (problem) return { ok: false, error: problem };
  let cfg: TumwaterConfig;
  try {
    cfg = loadConfig(root); // fresh — bypasses the stat cache on purpose
  } catch (err) {
    return { ok: false, error: errorMessage(err) }; // broken file: never overwrite it with defaults
  }
  const file = configPath(root);
  try {
    // The trailing newline is tumwater.json's convention (POSIX text file).
    writeJsonAtomic(file, { ...cfg, maxDailyCostUsd: value }, true);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  return { ok: true };
}

/** Consume the director's config-write request file (plans/portability.md §3/7). After its pi
 * run the director may leave `.tumwater-config-request.json` at its worktree root:
 * `{ "customLoops": [ { "name", "task" }, … ] }` — the whole array, replacing the current one.
 * Applied atomically to the live config with setDailyBudgetUsd's idiom (fresh loadConfig that
 * bypasses the stat cache, validateConfig, then writeJsonAtomic — readers poll every ~2 s), so
 * the orchestrator's live reload starts the new loop with no commit, no review gate, and no
 * merge, and the request file never enters a diff.
 *
 * The permitted key set is enforced here, not in prose: `customLoops` is accepted and every
 * other top-level key is collected into `ignored` and dropped (the caller logs the warning that
 * names them). Validation runs BEFORE any write and nothing here dereferences a request entry
 * first — a structurally malformed entry (`[null]`, a non-string name) is left for
 * validateConfig to reject, so on failure nothing is written and the previous config stays
 * live. The request file is deleted on EVERY path (including every failure), so a malformed
 * request cannot retry forever and the file cannot survive into `git add -A`.
 *
 * Roles entries for custom loops the request removes are stripped before validation:
 * loadConfig seeds one `roles.<name>` per current custom loop and validateConfig rejects an
 * id that is neither a catalog role nor a requested custom-loop name, so without the strip a
 * removal would never apply. Only structurally valid names feed the strip — a malformed entry
 * stays in the array for validateConfig to reject.
 *
 * Returns null when no request file exists. `applied` names the custom loops now live (empty
 * unless the write happened); `ignored` lists the discarded top-level keys; `error`, when set,
 * names why nothing (or only part of the work) was done — the caller turns it and `ignored`
 * into warning events. */
export function applyConfigRequest(
  root: string,
  wt: string,
): { applied: string[]; ignored: string[]; error?: string } | null {
  const requestFile = configRequestPath(wt);
  let raw: string;
  try {
    raw = fs.readFileSync(requestFile, "utf8");
  } catch {
    return null; // no request this tick
  }

  const ignored: string[] = [];
  let applied: string[] = [];
  let error: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed))
      throw new Error(`config request must be a JSON object (got ${show(parsed)})`);
    for (const key of Object.keys(parsed)) {
      if (key !== "customLoops") ignored.push(key);
    }
    const loops = parsed.customLoops;
    if (!Array.isArray(loops))
      throw new Error(`config request's customLoops must be an array (got ${show(loops)})`);
    const current = loadConfig(root); // fresh — bypasses the stat cache: a writer sees the latest file
    // Strip roles.<id> entries for custom loops this request removes (see docstring). Structurally
    // valid names only; anything else stays for validateConfig to reject — never dereference a
    // request entry before validation.
    const requestedNames = new Set<string>();
    for (const entry of loops) {
      if (isJsonObject(entry) && typeof entry.name === "string") requestedNames.add(entry.name);
    }
    const roles = { ...current.roles };
    for (const c of current.customLoops) {
      if (!requestedNames.has(c.name)) delete roles[c.name];
    }
    const candidate: TumwaterConfig = { ...current, customLoops: loops as TumwaterConfig["customLoops"], roles };
    validateConfig(candidate); // throws listing every problem — nothing is written on failure
    applied = candidate.customLoops.map((c) => c.name);
    writeJsonAtomic(configPath(root), candidate, true);
  } catch (err) {
    applied = []; // no write happened, or it must not be reported as applied
    error = errorMessage(err);
  }

  // Delete the request on EVERY path — success, rejection, malformed JSON — so it can never be
  // staged by commitAll, reach a review gate, or retry forever. A failed unlink is surfaced as
  // an error so the caller logs it (the file would otherwise survive into the diff).
  try {
    fs.unlinkSync(requestFile);
  } catch (err) {
    error ??= `config request file could not be deleted: ${errorMessage(err)}`;
  }
  return { applied, ignored, error };
}
