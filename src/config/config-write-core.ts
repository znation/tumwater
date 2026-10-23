/** The shared write MACHINERY for tumwater.json — the one home for the load →
 * validate → atomic-write idiom, the cross-process lock, and the raw/preserve-role
 * helpers that every writer shares. The operator-editor verbs (config-write.ts's
 * setConfigKey/unsetConfigKey/setRoleModelFields/setDailyBudgetUsd) are whole-config writes
 * with the
 * same traps — a fresh loadConfig that bypasses config.ts's stat cache, validateConfig over
 * the merged candidate, an atomic write because readers poll tumwater.json every ~2 s, a lock
 * that serializes separate-process writers, and a roles section that must never be re-expanded
 * from the catalog — so the idiom lives here, apart from the editor module.
 * (config-request.ts's applyConfigRequest hits the same traps but inlines its own load →
 * validate → write; it imports only withConfigLock and rawConfigObject from this module.)
 * The read side — defaults, loading, saving,
 * and the role-selection helpers — lives in config.ts, the per-run model derivations in
 * config-views.ts, the config KEY language in config-keys.ts, and the operator-editor verbs
 * in config-write.ts. */
import { configPath, configLockPath, CONFIG_BASENAME } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { objectOrEmpty } from "../files/json-object.js";
import { withStateLock } from "../concurrency/lock.js";
import { validateConfig } from "./config-validation.js";
import { loadConfig, parseJsonConfig, collapseBackendAliases } from "./config.js";
import type { TumwaterConfig } from "./config-schema.js";

/** Serialize a config write through the cross-process lock (paths.ts's configLockPath): the
 * CLI, a standalone dashboard's server, and the running team are separate processes, so an
 * unguarded read-modify-write lets one writer's whole-file write silently drop another's change
 * (the same lost update paused-roles.json already guards against). A lock that cannot be
 * acquired within the budget throws rather than writing unlocked — a silently lost config edit
 * is worse than a write that reports an error. */
const CONFIG_LOCK_TIMEOUT_MS = 10_000;
export function withConfigLock<T>(root: string, fn: () => T): T {
  // withStateLock creates the state dir the lock sits in (a CLI write may run before any state
  // file).
  return withStateLock(configLockPath(root), fn, CONFIG_LOCK_TIMEOUT_MS);
}

/** The error arm of the shared write-result union — one home for the `{ ok: false, error }`
 * constructor every writer's failure path returns (a broken on-disk file, a validation
 * problem, a failed write, a lost lock), so the shape cannot drift between callers. */
export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The one load → mutate → validate → atomic-write idiom the operator-editor verbs share
 * (setDailyBudgetUsd, setConfigKey, unsetConfigKey, setRoleModelFields): a fresh loadConfig that
 * bypasses config.ts's stat cache (a writer must see the latest file), the caller's mutation
 * applied in memory, validateConfig over the whole merged candidate, then writeJsonAtomic
 * (tmp file + rename) because readers poll tumwater.json every ~2 s. The whole load-to-write
 * sequence runs under withConfigLock, so two processes racing different keys cannot each write
 * from the same pre-race snapshot and lose one update. On any failure — a broken on-disk file,
 * a type-invalid candidate, a failed write, or a lock that cannot be acquired — the file is
 * left untouched (and no tmp remnant is left behind); the error surfaces as a string so
 * callers (both dashboards, the CLI) can print it without try/catch plumbing. */
export function writeConfigMutation(
  root: string,
  mutate: (cfg: TumwaterConfig) => TumwaterConfig,
): { ok: true } | { ok: false; error: string } {
  try {
    return withConfigLock(root, (): { ok: true } | { ok: false; error: string } => {
      let cfg: TumwaterConfig;
      try {
        cfg = loadConfig(root); // fresh — bypasses the stat cache on purpose
      } catch (err) {
        return fail(errorMessage(err)); // broken file: never overwrite it with defaults
      }
      const mutated = mutate(cfg);
      // An unset that finds nothing to remove returns the loaded config unchanged. Write nothing:
      // re-serializing the merged config would reformat tumwater.json (defaults expanded) and
      // break the no-op's "changes nothing" contract. The bytes stay identical; validation of an
      // already-validated config is unnecessary.
      if (mutated === cfg) return { ok: true };
      // Collapse legacy/new pi spellings before writing so a merged config (which always
      // carries the default piArgs) never lands both forms in the file.
      const candidate = collapseBackendAliases(mutated);
      try {
        validateConfig(candidate); // throws listing every problem — nothing is written on failure
      } catch (err) {
        return fail(errorMessage(err));
      }
      try {
        // The trailing newline is tumwater.json's convention (POSIX text file).
        writeJsonAtomic(configPath(root), candidate, true);
      } catch (err) {
        return fail(errorMessage(err));
      }
      return { ok: true };
    });
  } catch (err) {
    return fail(errorMessage(err)); // lock acquire timeout/failure — nothing written
  }
}

/** The loaded config viewed as an indexable record: the two known section shapes (a role's
 * field map, the `model` string or tier map) plus an open index signature, so a parsed
 * `config set`/`unset` key can be read and rebuilt by name. One home for the cast setConfigKey
 * and unsetConfigKey share; writeConfigMutation's validateConfig owns the type truth of the
 * merged candidate, so the cast is safe — a type-invalid merge fails there and nothing is
 * written. */
export interface ConfigRecord {
  roles?: Record<string, Record<string, unknown>>;
  model?: string | Record<string, string>;
  [key: string]: unknown;
}

/** A shallow copy of `obj` without `key` — the copy each `unsetConfigKey` branch edits
 * before it decides whether the removal emptied its container, and the shape the branch then
 * returns when it did (an emptied map, the last field of a `roles.<id>` entry, an emptied
 * `model` map), so tumwater.json never keeps an empty object. */
export function without<T extends Record<string, unknown>>(obj: T, key: string): T {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

/** The raw parsed tumwater.json as a plain object — the pre-defaults view `unsetConfigKey`'s
 * presence check needs, because the merged config always carries defaults a top-level key or a
 * `roles.<id>.<field>` (e.g. the seeded `minRunIntervalSeconds`) may never have been set to.
 * Read inside writeConfigMutation's lock; a missing or unparsable file is `{}` (loadConfig has
 * already rejected a broken file before a mutation runs, and an absent file is the bare
 * defaults — there is nothing to retract). */
export function rawConfigObject(root: string): Record<string, unknown> {
  const { raw } = parseJsonConfig(configPath(root), CONFIG_BASENAME);
  return objectOrEmpty(raw);
}

/** Reinstall the raw tumwater.json's `roles` section onto a whole-config write candidate (or
 * drop it when the file had none), so a bare `config set`/`unset` of an unrelated key never
 * re-expands the file's roles to the built-in catalog. `roles` merges per-entry at load, so
 * this is about the bytes the operator can read and edit, not the resolved view: omission
 * still cannot disable a role, and a partial section stays exactly as written. */
export function preserveFileRoles(root: string, candidate: TumwaterConfig): void {
  const record = candidate as unknown as Record<string, unknown>;
  const rawRoles = rawConfigObject(root).roles;
  if (rawRoles === undefined) delete record.roles;
  else record.roles = rawRoles;
}

/** preserveFileRoles, returning the candidate so a whole-config write branch can
 * `return preservingFileRoles(root, next)` after building it. */
export function preservingFileRoles<T extends TumwaterConfig>(root: string, candidate: T): T {
  preserveFileRoles(root, candidate);
  return candidate;
}

/** The config with top-level `key` set to `section`, or removed when `section` is empty — the
 * unset shape for the per-role maps, `model` tiers and `backends`, which never leave an empty
 * object in the file. A whole-config write, so the file's own roles section is kept. */
export function withSectionOrDropped(root: string, cfg: TumwaterConfig, key: string, section: object): TumwaterConfig {
  const next =
    Object.keys(section).length === 0 ? without(cfg as unknown as ConfigRecord, key) : { ...cfg, [key]: section };
  return preservingFileRoles(root, next as unknown as TumwaterConfig);
}
