/** Harness-mediated config WRITES — the mutators behind the operator surfaces (the TUI's
 * Ctrl+B editor, the GUI's /api/budget endpoint) and the director's config requests. Each
 * one loads fresh (bypassing config.ts's stat cache), validates before writing, and writes
 * atomically, because readers poll tumwater.json every ~2 s. The read side — defaults,
 * loading, saving, and the role-selection helpers — lives in config.ts, the per-run
 * model derivations in config-views.ts, and the config KEY language — how keys are parsed,
 * addressed and given per-key value screeners — lives in config-keys.ts (both the write
 * verbs here and the read side / doctor share it). */
import fs from "node:fs";
import { modelTierMap, type TumwaterConfig } from "./config-schema.js";
import { configPath, configLockPath, configRequestPath, CONFIG_BASENAME } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject, objectOrEmpty } from "../files/json-object.js";
import { withStateLock } from "../concurrency/lock.js";
import { show } from "./config-field-checks.js";
import { validateConfig } from "./config-validation.js";
import { canonicalConfigKey, normalizeConfigKeys } from "./config-aliases.js";
import { loadConfig, parseJsonConfig, collapseAgentAliases } from "./config.js";
import {
  checkDailyBudgetUsd,
  checkProviderConcurrencyCap,
  checkQuietHours,
  parseConfigKey,
  PER_KEY_VALIDATORS,
  unknownConfigKeyError,
  unknownRoleFieldError,
} from "./config-keys.js";
/** Serialize a config write through the cross-process lock (paths.ts's configLockPath): the
 * CLI, a standalone dashboard's server, and the running fleet are separate processes, so an
 * unguarded read-modify-write lets one writer's whole-file write silently drop another's change
 * (the same lost update paused-roles.json already guards against). A lock that cannot be
 * acquired within the budget throws rather than writing unlocked — a silently lost config edit
 * is worse than a write that reports an error. */
const CONFIG_LOCK_TIMEOUT_MS = 10_000;
function withConfigLock<T>(root: string, fn: () => T): T {
  // withStateLock creates the state dir the lock sits in (a CLI write may run before any state
  // file).
  return withStateLock(configLockPath(root), fn, CONFIG_LOCK_TIMEOUT_MS);
}

/** The error arm of the shared write-result union — one home for the `{ ok: false, error }`
 * constructor every writer's failure path returns (a broken on-disk file, a validation
 * problem, a failed write, a lost lock), so the shape cannot drift between callers. */
function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The one load → mutate → validate → atomic-write idiom every top-level config writer
 * shares (setDailyBudgetUsd, setConfigKey): a fresh loadConfig that bypasses config.ts's
 * stat cache (a writer must see the latest file), the caller's mutation applied in memory,
 * validateConfig over the whole merged candidate, then writeJsonAtomic (tmp file + rename)
 * because readers poll tumwater.json every ~2 s. The whole load-to-write sequence runs under
 * withConfigLock, so two processes racing different keys cannot each write from the same
 * pre-race snapshot and lose one update. On any failure — a broken on-disk file, a
 * type-invalid candidate, a failed write, or a lock that cannot be acquired — the file is
 * left untouched (and no tmp remnant is left behind); the error surfaces as a string so
 * callers (both dashboards, the CLI) can print it without try/catch plumbing. */
function writeConfigMutation(
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
      const candidate = collapseAgentAliases(mutated);
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

/** Set the daily cost budget cap in tumwater.json through the shared writer idiom (see
 * writeConfigMutation), after checkDailyBudgetUsd has screened the value with its own
 * actionable message — the one both dashboards flash. */
export function setDailyBudgetUsd(
  root: string,
  value: number,
): { ok: true } | { ok: false; error: string } {
  const problem = checkDailyBudgetUsd(value);
  if (problem) return fail(problem);
  return writeConfigMutation(root, (cfg) => {
    const next = { ...cfg, maxDailyCostUsd: value };
    // A whole-config write: keep the file's own roles section (see preserveFileRoles).
    preserveFileRoles(root, next);
    return next;
  });
}

/** The loaded config viewed as an indexable record: the two known section shapes (a role's
 * field map, the `model` string or tier map) plus an open index signature, so a parsed
 * `config set`/`unset` key can be read and rebuilt by name. One home for the cast setConfigKey
 * and unsetConfigKey share; writeConfigMutation's validateConfig owns the type truth of the
 * merged candidate, so the cast is safe — a type-invalid merge fails there and nothing is
 * written. */
interface ConfigRecord {
  roles?: Record<string, Record<string, unknown>>;
  model?: string | Record<string, string>;
  [key: string]: unknown;
}

/** Set ONE top-level key of tumwater.json from its raw CLI text (`tumwater config set`'s
 * engine): the key must be a member of TOP_LEVEL_KEYS — the same protection checkKnownKeys
 * gives the file itself, so `config set modle x` cannot write a dead key the runtime would
 * silently ignore — and the value is JSON.parse(rawValue) when that parses, else the literal
 * string (so `set maxDailyCostUsd 20` is the number 20 and `set model gpt-5` is the string
 * "gpt-5"; the whole merged candidate is then validated, so a type mismatch like
 * `set maxDailyCostUsd "20"` fails with validateConfig's own message and the file stays
 * byte-identical). Top-level keys are replaced wholesale; a DOTTED key
 * (`maxDailyCostUsdPerRole.<role>`, `quietHoursPerRole.<role>`, `roles.<id>.<field>` —
 * parseConfigKey) merges ONE entry into the existing map/section, so an operator steers one
 * role at a time without re-typing the others. A dotted role field must be a member of
 * ROLE_ENTRY_KEYS (a did-you-mean suggestion otherwise, via text/suggest.ts's typoSuffix); a
 * typo'd role id and a type-invalid value are left for validateConfig to reject with its own
 * actionable message. Returns the parsed value and the previous one so the caller can
 * confirm the change; on any failure the file is untouched (see writeConfigMutation). */
export function setConfigKey(
  root: string,
  key: string,
  rawValue: string,
): { ok: true; value: unknown; oldValue: unknown } | { ok: false; error: string } {
  key = canonicalConfigKey(key);
  const parsed = parseConfigKey(key);
  if (parsed.kind === "error") return fail(parsed.error);
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue; // not JSON: the literal string, so `set model gpt-5` needs no quotes
  }
  if (parsed.kind !== "top") {
    const fieldError = parsed.kind === "role" ? unknownRoleFieldError(parsed.id, parsed.field) : null;
    if (fieldError) return fail(fieldError);
    if (parsed.kind === "map") {
      // Name the key the operator actually typed (`maxDailyCostUsdPerRole.qa`), not the
      // fleet-wide field the shared validator's message would otherwise default to.
      const label = `${parsed.map}.${parsed.role}`;
      const validator =
        parsed.map === "maxDailyCostUsdPerRole"
          ? checkDailyBudgetUsd
          : parsed.map === "maxConcurrentPerProvider"
            ? checkProviderConcurrencyCap
            : checkQuietHours;
      const problem = validator(value, label);
      if (problem) return fail(problem);
    }
    if (parsed.kind === "tier" && (typeof value !== "string" || value === "")) {
      return fail(`model.${parsed.tier} must be a model selector string (e.g. \`config set model.strong huggingface/zai-org/GLM-5.3-Flash:together:low\`) — got ${show(value)}`);
    }
    let oldValue: unknown;
    const result = writeConfigMutation(root, (cfg) => {
      const record = cfg as unknown as ConfigRecord;
      if (parsed.kind === "map") {
        const existing = (record[parsed.map] as Record<string, unknown> | undefined) ?? {};
        oldValue = existing[parsed.role];
        const next = { ...cfg, [parsed.map]: { ...existing, [parsed.role]: value } };
        return preservingFileRoles(root, next);
      }
      if (parsed.kind === "tier") {
        // Setting a tier on a string `model` promotes it to the map form rather than
        // overwriting the bare string — the other tiers' models survive (modelTierMap owns
        // that reading). validateConfig in writeConfigMutation owns the
        // type truth of the merged map, so the cast is safe: a type-invalid merge fails
        // there and nothing is written.
        const existing = modelTierMap(record.model);
        oldValue = existing[parsed.tier];
        const next = { ...cfg, model: { ...existing, [parsed.tier]: value } } as unknown as TumwaterConfig;
        return preservingFileRoles(root, next);
      }
      if (parsed.kind === "agent") {
        // Merge one field of one backend's entry, preserving the other field and the other
        // backends. validateConfig in writeConfigMutation owns the value type, so a bad
        // value fails there and nothing is written.
        const agents = { ...(record.agents as Record<string, Record<string, unknown>> | undefined) };
        const entry = { ...(agents[parsed.id] ?? {}) };
        oldValue = entry[parsed.field];
        entry[parsed.field] = value;
        agents[parsed.id] = entry;
        const next = { ...cfg, agents } as unknown as TumwaterConfig;
        // Writers keep one spelling: the new pi form drops its legacy alias so the file can
        // never hold both (validateConfig's raw pass rejects a file that does).
        if (parsed.id === "pi") {
          const nextRecord = next as unknown as Record<string, unknown>;
          if (parsed.field === "bin") delete nextRecord.agentBin;
          else delete nextRecord.piArgs;
        }
        return preservingFileRoles(root, next);
      }
      // Base the merge on the FILE's own roles, not the loaded (catalog-merged) map: an
      // unrelated dotted write must not re-expand the operator's partial section to every
      // built-in (see preserveFileRoles). A role absent from the file gets a fresh entry with
      // just this field; the catalog still fills its other defaults at load.
      const rawRolesCandidate = rawConfigObject(root).roles;
      const rawRoles = objectOrEmpty(rawRolesCandidate) as Record<string, Record<string, unknown>>;
      const rawEntryCandidate = rawRoles[parsed.id];
      const rawEntry = objectOrEmpty(rawEntryCandidate);
      oldValue = record.roles?.[parsed.id]?.[parsed.field];
      const roles = {
        ...rawRoles,
        [parsed.id]: { ...rawEntry, [parsed.field]: value },
      };
      // The merged entry is only partially typed here (the value is unknown until
      // validation); validateConfig below owns the type truth, so the cast is safe —
      // a type-invalid merge fails there and nothing is written.
      return { ...cfg, roles } as unknown as TumwaterConfig;
    });
    if (!result.ok) return result;
    return { ok: true, value, oldValue };
  }
  const unknown = unknownConfigKeyError(key);
  if (unknown) return fail(unknown);
  // Legacy `provider` / `fallbackModel` are accepted to FIX an existing value (a config
  // that already has one keeps the old meaning), but `config set` never adds them to a
  // config that lacks them — the new-form writers emit `model` and `fallback` only.
  if (key === "provider" || key === "fallbackModel") {
    const absent = (() => {
      try {
        const c = loadConfig(root); // fresh — bypasses the stat cache on purpose
        return (c as unknown as Record<string, unknown>)[key] === undefined;
      } catch {
        return false; // a broken file fails in writeConfigMutation with its own message
      }
    })();
    if (absent)
      return fail(`config set ${key}: this config has no ${key}, and a writer never adds legacy ${key} — set \`${key === "provider" ? "model" : "fallback"}\` instead`);
  }
  const perKeyValidator = PER_KEY_VALIDATORS[key];
  if (perKeyValidator) {
    const problem = perKeyValidator(value);
    if (problem) return fail(problem);
  }
  let oldValue: unknown;
  const result = writeConfigMutation(root, (cfg) => {
    oldValue = (cfg as unknown as Record<string, unknown>)[key];
    const next = { ...cfg, [key]: value };
    // `roles` merges per-entry at load (overlayDefaults seeds the catalog and lets the file
    // override one entry), so an unrelated whole-config write must not re-expand the file's
    // own roles section to the catalog — that would silently rewrite what the operator wrote.
    // When the key IS `roles` the value is the replacement, so it is left alone.
    if (key !== "roles") preserveFileRoles(root, next);
    // Writers keep one spelling: a whole-section `agents` set (the GUI Save path) drops the
    // legacy aliases the new pi form now carries, so the file can never hold both.
    if (key === "agents" && isJsonObject(value)) {
      const pi = isJsonObject(value.pi) ? value.pi : undefined;
      const record = next as unknown as Record<string, unknown>;
      if (pi?.bin !== undefined) delete record.agentBin;
      if (pi?.args !== undefined) delete record.piArgs;
      return next;
    }
    // Writers keep one spelling: a legacy top-level set drops the matching agents.pi field, so
    // the file can never hold both (validateConfig's raw pass rejects a file that does).
    if (key === "agentBin" || key === "piArgs") {
      const record = next as unknown as { agents?: Record<string, Record<string, unknown>> };
      const agents = { ...(record.agents ?? {}) };
      const entry = { ...(agents.pi ?? {}) };
      delete entry[key === "agentBin" ? "bin" : "args"];
      if (Object.keys(entry).length === 0) delete agents.pi;
      else agents.pi = entry;
      return { ...next, agents };
    }
    return next;
  });
  if (!result.ok) return result;
  return { ok: true, value, oldValue };
}

/** A shallow copy of `obj` without `key` — the copy each `unsetConfigKey` branch edits
 * before it decides whether the removal emptied its container, and the shape the branch then
 * returns when it did (an emptied map, the last field of a `roles.<id>` entry, an emptied
 * `model` map), so tumwater.json never keeps an empty object. */
function without<T extends Record<string, unknown>>(obj: T, key: string): T {
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
function rawConfigObject(root: string): Record<string, unknown> {
  const { raw } = parseJsonConfig(configPath(root), CONFIG_BASENAME);
  return objectOrEmpty(raw);
}

/** Reinstall the raw tumwater.json's `roles` section onto a whole-config write candidate (or
 * drop it when the file had none), so a bare `config set`/`unset` of an unrelated key never
 * re-expands the file's roles to the built-in catalog. `roles` merges per-entry at load, so
 * this is about the bytes the operator can read and edit, not the resolved view: omission
 * still cannot disable a role, and a partial section stays exactly as written. */
function preserveFileRoles(root: string, candidate: TumwaterConfig): void {
  const record = candidate as unknown as Record<string, unknown>;
  const rawRoles = rawConfigObject(root).roles;
  if (rawRoles === undefined) delete record.roles;
  else record.roles = rawRoles;
}

/** preserveFileRoles, returning the candidate so a whole-config write branch can
 * `return preservingFileRoles(root, next)` after building it. */
function preservingFileRoles<T extends TumwaterConfig>(root: string, candidate: T): T {
  preserveFileRoles(root, candidate);
  return candidate;
}

/** The config with top-level `key` set to `section`, or removed when `section` is empty — the
 * unset shape for the per-role maps, `model` tiers and `agents`, which never leave an empty
 * object in the file. A whole-config write, so the file's own roles section is kept. */
function withSectionOrDropped(root: string, cfg: TumwaterConfig, key: string, section: object): TumwaterConfig {
  const next =
    Object.keys(section).length === 0 ? without(cfg as unknown as ConfigRecord, key) : { ...cfg, [key]: section };
  return preservingFileRoles(root, next as unknown as TumwaterConfig);
}

/** Remove ONE value of tumwater.json from its raw CLI text (`tumwater config unset <key>`):
 * the inverse of setConfigKey. A bare top-level key is deleted (reverting to its default or
 * to absence); a dotted key (`maxDailyCostUsdPerRole.<role>`, `quietHoursPerRole.<role>`,
 * `model.<tier>`, `roles.<id>.<field>` — parseConfigKey) deletes that one entry or field,
 * preserving its siblings, so an operator retracts one role's override without re-typing the
 * rest. The containing map/`model` key is dropped when it empties, so the file never keeps an
 * empty object (a `roles.<id>` entry cannot empty through the CLI: loadConfig always seeds
 * `enabled`/`minRunIntervalSeconds`). Presence is judged against the raw FILE, not the merged
 * config: a key the file never set but the defaults fill in (a top-level `quietHours`/
 * `maxConcurrent`, a seeded `roles.<id>.minRunIntervalSeconds`) is nothing to remove, so the
 * mutation returns the loaded config unchanged and writeConfigMutation skips the write — the
 * file's bytes stay identical rather than being re-serialized with the defaults expanded.
 * Legacy `provider`/`fallbackModel` unset normally — only
 * `set` refuses to add them. Everything runs through writeConfigMutation (see there): the
 * cross-process lock, validateConfig over the whole merged candidate, and the atomic write
 * still own truth, so a rejected candidate leaves the file byte-identical. oldValue is the
 * file's own value removed, or `undefined` when the file never held it. */
export function unsetConfigKey(
  root: string,
  key: string,
): { ok: true; oldValue: unknown } | { ok: false; error: string } {
  key = canonicalConfigKey(key);
  const parsed = parseConfigKey(key);
  if (parsed.kind === "error") return fail(parsed.error);
  if (parsed.kind === "role") {
    const fieldError = unknownRoleFieldError(parsed.id, parsed.field);
    if (fieldError) return fail(fieldError);
  }
  if (parsed.kind === "top") {
    const unknown = unknownConfigKeyError(key);
    if (unknown) return fail(unknown);
  }
  let oldValue: unknown;
  const result = writeConfigMutation(root, (cfg) => {
    const raw = rawConfigObject(root); // the file's own keys, before defaults fill them in
    const record = cfg as unknown as ConfigRecord;
    if (parsed.kind === "top") {
      // Absent from the file (only a default carries it): nothing to remove.
      if (!Object.hasOwn(raw, parsed.key)) return cfg;
      oldValue = raw[parsed.key];
      const next = without(record, parsed.key) as unknown as TumwaterConfig;
      // An unrelated unset is a whole-config write too: keep the file's own roles section.
      if (parsed.key !== "roles") preserveFileRoles(root, next);
      return next;
    }
    if (parsed.kind === "map") {
      const rawMapCandidate = raw[parsed.map];
      const rawMap = objectOrEmpty(rawMapCandidate);
      if (!Object.hasOwn(rawMap, parsed.role)) return cfg; // absent file entry: a no-op success
      oldValue = rawMap[parsed.role];
      const existing = (record[parsed.map] as Record<string, unknown> | undefined) ?? {};
      const next = without(existing, parsed.role);
      return withSectionOrDropped(root, cfg, parsed.map, next);
    }
    if (parsed.kind === "tier") {
      // A string `model` resolves to { default } (modelTierMap); unsetting a tier the FILE
      // does not hold is a no-op that leaves the string untouched.
      const rawTiers = modelTierMap(raw.model);
      if (!Object.hasOwn(rawTiers, parsed.tier)) return cfg;
      oldValue = rawTiers[parsed.tier];
      const existing = modelTierMap(record.model);
      const next = without(existing, parsed.tier);
      return withSectionOrDropped(root, cfg, "model", next);
    }
    if (parsed.kind === "agent") {
      // Presence is judged against the FILE, so unsetting a field only the default (or the
      // legacy alias's resolved view) carries is a no-op success. The entry and the `agents`
      // section are dropped when they empty, so the file never keeps an empty object.
      const rawAgents = objectOrEmpty(raw.agents);
      const rawEntryCandidate = rawAgents[parsed.id];
      const rawEntry = objectOrEmpty(rawEntryCandidate);
      if (!Object.hasOwn(rawEntry, parsed.field)) return cfg; // absent file field: a no-op success
      oldValue = rawEntry[parsed.field];
      const agents = { ...(record.agents as Record<string, Record<string, unknown>> | undefined) };
      const entry = { ...(agents[parsed.id] ?? {}) };
      delete entry[parsed.field];
      if (Object.keys(entry).length === 0) delete agents[parsed.id];
      else agents[parsed.id] = entry;
      return withSectionOrDropped(root, cfg, "agents", agents);
    }
    const rawRolesCandidate = raw.roles;
    const rawRoles = objectOrEmpty(rawRolesCandidate);
    const rawEntryCandidate = rawRoles[parsed.id];
    const rawEntry = objectOrEmpty(rawEntryCandidate);
    if (!Object.hasOwn(rawEntry, parsed.field)) return cfg; // absent file field: a no-op success
    oldValue = rawEntry[parsed.field];
    // Base the removal on the FILE's own roles, not the loaded (catalog-merged) map: the
    // write must not re-expand the operator's partial section to every built-in.
    const existing = rawEntry; // the file's own entry (its field was present, checked above)
    const nextEntry = without(existing, parsed.field);
    if (Object.keys(nextEntry).length > 0)
      return { ...cfg, roles: { ...rawRoles, [parsed.id]: nextEntry } } as unknown as TumwaterConfig;
    // The entry emptied: drop it, and the whole `roles` section when it was the last one.
    const nextRoles = without(rawRoles, parsed.id);
    if (Object.keys(nextRoles).length === 0) return without(record, "roles") as unknown as TumwaterConfig;
    return { ...cfg, roles: nextRoles } as unknown as TumwaterConfig;
  });
  if (!result.ok) return result;
  return { ok: true, oldValue };
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
 * Roles entries for custom loops the request removes are stripped before validation, from the
 * FILE's own `roles` section rather than the catalog-merged map (the rule every other
 * whole-config write follows, see preserveFileRoles): loadConfig seeds one `roles.<name>` per
 * current custom loop and validateConfig rejects an id that is neither a catalog role nor a
 * requested custom-loop name, so without the strip a removal would never apply. Only
 * structurally valid names feed the strip — a malformed entry stays in the array for
 * validateConfig to reject.
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
    const unnormalized: unknown = JSON.parse(raw);
    if (!isJsonObject(unnormalized))
      throw new Error(`config request must be a JSON object (got ${show(unnormalized)})`);
    // Old key spellings read as the new ones; a request setting both fails with the pair named.
    const normalized = normalizeConfigKeys(unnormalized);
    if (normalized.problems.length > 0) throw new Error(normalized.problems.join("; "));
    const parsed = normalized.raw as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (key !== "customLoops") ignored.push(key);
    }
    const loops = parsed.customLoops;
    if (!Array.isArray(loops))
      throw new Error(`config request's customLoops must be an array (got ${show(loops)})`);
    // The load-to-write sequence is one critical section under withConfigLock: a concurrent
    // `config set`/dashboard write between the load and this write must not be dropped by the
    // whole-file overwrite (see writeConfigMutation).
    withConfigLock(root, () => {
      const current = loadConfig(root); // fresh — bypasses the stat cache: a writer sees the latest file
      // Strip roles.<id> entries for custom loops this request removes (see docstring).
      // Structurally valid names only; anything else stays for validateConfig to reject — never
      // dereference a request entry before validation.
      const requestedNames = new Set<string>();
      for (const entry of loops) {
        if (isJsonObject(entry) && typeof entry.name === "string") requestedNames.add(entry.name);
      }
      // Base the roles rewrite on the FILE's own section, not the loaded (catalog-merged)
      // map: this whole-config write must not re-expand a partial section to every built-in
      // (preserveFileRoles' rule). Only the removed custom loops' entries are stripped, and
      // only from what the file actually holds.
      const rawRolesCandidate = rawConfigObject(root).roles;
      const roles = isJsonObject(rawRolesCandidate)
        ? { ...(rawRolesCandidate) }
        : {};
      for (const c of current.customLoops) {
        if (!requestedNames.has(c.name)) delete roles[c.name];
      }
      const candidate = { ...current, customLoops: loops as TumwaterConfig["customLoops"] };
      const candidateRecord = candidate as unknown as Record<string, unknown>;
      if (rawRolesCandidate === undefined) delete candidateRecord.roles;
      else candidateRecord.roles = roles;
      // Collapse legacy/new pi spellings before writing so a merged config (which always
      // carries the default piArgs) never lands both forms in the file — the next load's raw
      // pass rejects a file holding both `piArgs` and `agents.pi.args`.
      const collapsed = collapseAgentAliases(candidate);
      validateConfig(collapsed); // throws listing every problem — nothing is written on failure
      writeJsonAtomic(configPath(root), collapsed, true);
      applied = collapsed.customLoops.map((c) => c.name);
    });
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
