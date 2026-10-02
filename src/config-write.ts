/** Harness-mediated config WRITES — the mutators behind the operator surfaces (the TUI's
 * Ctrl+B editor, the GUI's /api/budget endpoint) and the director's config requests. Each
 * one loads fresh (bypassing config.ts's stat cache), validates before writing, and writes
 * atomically, because readers poll tumwater.json every ~2 s. The read side — defaults,
 * loading, saving, and the role-selection helpers — lives in config.ts, and the per-run
 * model derivations in config-views.ts. */
import fs from "node:fs";
import { TOP_LEVEL_KEYS, type TumwaterConfig } from "./config-schema.js";
import { configPath, configRequestPath } from "./paths.js";
import { errorMessage, suggestClosest } from "./text.js";
import { writeJsonAtomic } from "./json-files.js";
import { isJsonObject } from "./json-object.js";
import { show, validateConfig } from "./config-validation.js";
import { loadConfig } from "./config.js";
import { parseQuietHours } from "./quiet-hours.js";
/** One definition of "a valid daily budget cap" (the TUI's Ctrl+B editor and the GUI's
 * /api/budget endpoint both run their input through it): a finite number of 0 or more —
 * 0 disables the gate, fractional dollars allowed (the badge renders cents). Returns an
 * actionable error message for anything else so both surfaces can flash it without
 * try/catch plumbing. A value past Number.MAX_SAFE_INTEGER is rejected too: it stays
 * finite ("9"×25 → 1e24), so only this screen stands between a one-zero typo in the
 * browser's budget editor and an effectively uncapped budget (BUGS.md 2026-10-02, the
 * same rule the TUI's parseBudgetInput applies). */
export function checkDailyBudgetUsd(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    return `maxDailyCostUsd must be a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER}, 0 disables (got ${show(value)})`;
  return null;
}

/** One definition of "a valid quietHours window" (src/quiet-hours.ts owns the format):
 * "HH:MM-HH:MM" in local time, wrapping permitted, empty means off. parseQuietHours's
 * message is the one wording every surface (validateConfig, `config set`, the TUI/GUI
 * editors) shows, so they cannot drift apart on what a valid window is. */
export function checkQuietHours(value: unknown): string | null {
  const parsed = parseQuietHours(value);
  return parsed.ok ? null : parsed.error;
}

/** Per-key value validators `config set` (and the dashboard editors that call it) run
 * BEFORE the write, so a malformed value fails with its own actionable message instead of
 * waiting for validateConfig's whole-file report. */
const PER_KEY_VALIDATORS: Record<string, (value: unknown) => string | null> = {
  quietHours: checkQuietHours,
};

/** The one load → mutate → validate → atomic-write idiom every top-level config writer
 * shares (setDailyBudgetUsd, setConfigKey): a fresh loadConfig that bypasses config.ts's
 * stat cache (a writer must see the latest file), the caller's mutation applied in memory,
 * validateConfig over the whole merged candidate, then writeJsonAtomic (tmp file + rename)
 * because readers poll tumwater.json every ~2 s and two writers could race. On any
 * failure — a broken on-disk file, a type-invalid candidate, a failed write — the file is
 * left untouched (and no tmp remnant is left behind); the error surfaces as a string so
 * callers (both dashboards, the CLI) can print it without try/catch plumbing. */
function writeConfigMutation(
  root: string,
  mutate: (cfg: TumwaterConfig) => TumwaterConfig,
): { ok: true } | { ok: false; error: string } {
  let cfg: TumwaterConfig;
  try {
    cfg = loadConfig(root); // fresh — bypasses the stat cache on purpose
  } catch (err) {
    return { ok: false, error: errorMessage(err) }; // broken file: never overwrite it with defaults
  }
  const candidate = mutate(cfg);
  try {
    validateConfig(candidate); // throws listing every problem — nothing is written on failure
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  try {
    // The trailing newline is tumwater.json's convention (POSIX text file).
    writeJsonAtomic(configPath(root), candidate, true);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  return { ok: true };
}

/** Set the daily cost budget cap in tumwater.json through the shared writer idiom (see
 * writeConfigMutation), after checkDailyBudgetUsd has screened the value with its own
 * actionable message — the one both dashboards flash. */
export function setDailyBudgetUsd(
  root: string,
  value: number,
): { ok: true } | { ok: false; error: string } {
  const problem = checkDailyBudgetUsd(value);
  if (problem) return { ok: false, error: problem };
  return writeConfigMutation(root, (cfg) => ({ ...cfg, maxDailyCostUsd: value }));
}

/** The error `tumwater config get <key>` and `config set <key> <value>` both surface for a
 * key outside TOP_LEVEL_KEYS — the valid-keys list plus text.ts's did-you-mean suggestion —
 * or null when the key is known. One home for the phrasing so whichever verb misspells a
 * key, the typo reads the same. */
export function unknownConfigKeyError(key: string): string | null {
  if ((TOP_LEVEL_KEYS as readonly string[]).includes(key)) return null;
  const suggestion = suggestClosest(key, TOP_LEVEL_KEYS as readonly string[]);
  return `unknown config key "${key}" (valid top-level keys: ${TOP_LEVEL_KEYS.join(", ")})${
    suggestion ? ` — did you mean \`${suggestion}\`?` : ""
  }`;
}

/** Set ONE top-level key of tumwater.json from its raw CLI text (`tumwater config set`'s
 * engine): the key must be a member of TOP_LEVEL_KEYS — the same protection checkKnownKeys
 * gives the file itself, so `config set modle x` cannot write a dead key the runtime would
 * silently ignore — and the value is JSON.parse(rawValue) when that parses, else the literal
 * string (so `set maxDailyCostUsd 20` is the number 20 and `set model gpt-5` is the string
 * "gpt-5"; the whole merged candidate is then validated, so a type mismatch like
 * `set maxDailyCostUsd "20"` fails with validateConfig's own message and the file stays
 * byte-identical). Top-level keys only: nested sections (roles, review, check, idleBackoff,
 * fallbackModel) are replaced wholesale when named, and finer edits stay file-edited — one
 * op per run. Returns the parsed value and the previous one so the caller can confirm the
 * change; on any failure the file is untouched (see writeConfigMutation). */
export function setConfigKey(
  root: string,
  key: string,
  rawValue: string,
): { ok: true; value: unknown; oldValue: unknown } | { ok: false; error: string } {
  const unknown = unknownConfigKeyError(key);
  if (unknown) return { ok: false, error: unknown };
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue; // not JSON: the literal string, so `set model gpt-5` needs no quotes
  }
  const perKeyValidator = PER_KEY_VALIDATORS[key];
  if (perKeyValidator) {
    const problem = perKeyValidator(value);
    if (problem) return { ok: false, error: problem };
  }
  let oldValue: unknown;
  const result = writeConfigMutation(root, (cfg) => {
    oldValue = (cfg as unknown as Record<string, unknown>)[key];
    return { ...cfg, [key]: value };
  });
  if (!result.ok) return result;
  return { ok: true, value, oldValue };
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
