/** Harness-mediated config WRITES — the four operator-editor mutators behind the operator
 * surfaces (the TUI's Ctrl+B editor, the GUI's /api/budget endpoint, `tumwater config
 * set`/`unset`), addressed by key through config-keys.ts. The shared write MACHINERY these
 * verbs run on — the load → validate → atomic-write idiom, the cross-process lock, and the
 * raw/preserve-role helpers — lives in config-write-core.ts, which the director's staged
 * request (config-request.ts) also consumes; every writer here loads fresh (bypassing
 * config.ts's stat cache), validates before writing, and writes atomically, because readers
 * poll tumwater.json every ~2 s. The read side — defaults, loading, saving, and the
 * role-selection helpers — lives in config.ts, the per-run model derivations in
 * config-views.ts, and the config KEY language — how keys are parsed, addressed and given
 * per-key value screeners — lives in config-keys.ts (both the write verbs here and the read
 * side / doctor share it). */
import { isDeepStrictEqual } from "node:util";
import { modelTierMap, type TumwaterConfig } from "./config-schema.js";
import { isJsonObject, objectOrEmpty } from "../files/json-object.js";
import { show } from "./config-field-checks.js";
import { canonicalConfigKey } from "./config-aliases.js";
import { unknownRoleMessage } from "../roles/roles.js";
import {
  loadConfig,
  collapseBackendAliases,
  knownRoleIdsCached,
} from "./config.js";
import {
  checkDailyBudgetUsd,
  checkProviderConcurrencyCap,
  checkQuietHours,
  parseConfigKey,
  PER_KEY_VALIDATORS,
  unknownConfigKeyError,
  unknownRoleFieldError,
} from "./config-keys.js";
import {
  writeConfigMutation,
  fail,
  rawConfigObject,
  without,
  preservingFileRoles,
  preserveFileRoles,
  withSectionOrDropped,
  type ConfigRecord,
} from "./config-write-core.js";

/** Set the daily cost budget cap in tumwater.json through the shared writer idiom (see
 * writeConfigMutation), after checkDailyBudgetUsd has screened the value with its own
 * actionable message — the one both dashboards flash. A cap the config already resolves to
 * (an omitted key resolves to the default) returns `unchanged: true` and writes nothing. */
export function setDailyBudgetUsd(
  root: string,
  value: number,
): { ok: true; unchanged?: true } | { ok: false; error: string } {
  const problem = checkDailyBudgetUsd(value);
  if (problem) return fail(problem);
  let unchanged = false;
  const result = writeConfigMutation(root, (cfg) => {
    if (cfg.maxDailyCostUsd === value) {
      unchanged = true;
      return cfg; // the loaded config itself: writeConfigMutation skips the write
    }
    const next = { ...cfg, maxDailyCostUsd: value };
    // A whole-config write: keep the file's own roles section (see preserveFileRoles).
    preserveFileRoles(root, next);
    return next;
  });
  return result.ok && unchanged ? { ok: true, unchanged: true } : result;
}

/** The top-level team keys whose value is a plain positive integer (validateConfig's
 * POSITIVE_INTEGER checks, config-validation.ts): the run-concurrency knobs plus the legacy
 * merge batch cap. For these, an exponent spelling like "4e1" is itself a JSON number (40)
 * that setConfigKey's JSON.parse would read past validateConfig's integer check and silently
 * write — the same silent misread the per-role instances/interval guards, the TUI team-key
 * editors, and the GUI Settings rows refuse — so setConfigKey refuses it, naming the key and
 * writing nothing. The per-provider map (maxConcurrentPerProvider.<provider>) has its own
 * checkProviderConcurrencyCap screen and is not in this set. */
const PLAIN_INTEGER_TOP_LEVEL_KEYS = new Set([
  "maxConcurrent",
  "mergeBatchMax",
  "maxConcurrentChecks",
  "worktreeSlots",
]);

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
 * confirm the change; on any failure the file is untouched
 * (see writeConfigMutation). A value equal to the resolved one is a no-op: nothing is written and
 * the result carries `unchanged`. */
export function setConfigKey(
  root: string,
  key: string,
  rawValue: string,
): { ok: true; value: unknown; oldValue: unknown; note?: string; unchanged?: true } | { ok: false; error: string } {
  key = canonicalConfigKey(key);
  const parsed = parseConfigKey(key);
  if (parsed.kind === "error") return fail(parsed.error);
  // Shape, before the JSON.parse, for every plain-positive-integer key this verb can write —
  // the top-level run-concurrency knobs and legacy merge batch cap, plus the integer-bound
  // team-scope keys that arrive as a dotted key (`maxConcurrentPerProvider.<provider>`,
  // `roles.<id>.instances`, the `bootstrap.untilPlansDone` section field): refuse an exponent
  // spelling ("4e1" → 40) that JSON.parse would read past validateConfig's integer check and
  // silently write, naming the key and writing nothing — the twin of the per-role guards, the
  // TUI team-key editors, and the GUI Settings rows. A non-exponent invalid falls through for
  // validateConfig (whose message names the key). Empty clears the key below.
  const trimmed = rawValue.trim();
  const isPlainIntegerKey =
    (parsed.kind === "top" && PLAIN_INTEGER_TOP_LEVEL_KEYS.has(key)) ||
    (parsed.kind === "map" && parsed.map === "maxConcurrentPerProvider") ||
    (parsed.kind === "role" && parsed.field === "instances") ||
    (parsed.kind === "section" && parsed.section === "bootstrap" && parsed.field === "untilPlansDone");
  if (
    isPlainIntegerKey &&
    trimmed !== "" &&
    !/^\d*\.?\d+$/.test(trimmed) &&
    /^\d+(\.\d+)?[eE][+-]?\d+$/.test(trimmed)
  )
    return fail(`${key} must be a plain integer — no exponent notation`);
  let unchanged: true | undefined; // set by a mutation callback when value equals the resolved one
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
      // team-wide field the shared validator's message would otherwise default to.
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
      return fail(`model.${parsed.tier} must be a model id (e.g. \`config set model.strong huggingface/zai-org/GLM-5.3-Flash:together:low\`) — got ${show(value)}`);
    }
    let oldValue: unknown;
    const result = writeConfigMutation(root, (cfg) => {
      const record = cfg as unknown as ConfigRecord;
      if (parsed.kind === "map") {
        const existing = (record[parsed.map] as Record<string, unknown> | undefined) ?? {};
        oldValue = existing[parsed.role];
        if (isDeepStrictEqual(oldValue, value)) {
          unchanged = true;
          return cfg;
        }
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
        if (isDeepStrictEqual(oldValue, value)) {
          unchanged = true;
          return cfg;
        }
        const next = { ...cfg, model: { ...existing, [parsed.tier]: value } } as unknown as TumwaterConfig;
        return preservingFileRoles(root, next);
      }
      if (parsed.kind === "section") {
        // Merge one field into the loaded section, keeping its other fields; validateConfig in
        // writeConfigMutation owns the value type, so a bad value fails there and writes nothing.
        const existing = (record[parsed.section] as Record<string, unknown> | undefined) ?? {};
        oldValue = existing[parsed.field];
        if (isDeepStrictEqual(oldValue, value)) {
          unchanged = true;
          return cfg;
        }
        const next = { ...cfg, [parsed.section]: { ...existing, [parsed.field]: value } };
        return preservingFileRoles(root, next);
      }
      if (parsed.kind === "agent") {
        // Merge one field of one backend's entry, preserving the other field and the other
        // backends. validateConfig in writeConfigMutation owns the value type, so a bad
        // value fails there and nothing is written.
        const backends = { ...(record.backends as Record<string, Record<string, unknown>> | undefined) };
        const entry = { ...(backends[parsed.id] ?? {}) };
        oldValue = entry[parsed.field];
        if (isDeepStrictEqual(oldValue, value)) {
          unchanged = true;
          return cfg;
        }
        entry[parsed.field] = value;
        backends[parsed.id] = entry;
        const next = { ...cfg, backends: backends } as unknown as TumwaterConfig;
        // Writers keep one spelling: the new pi form drops its legacy alias so the file can
        // never hold both (validateConfig's raw pass rejects a file that does).
        if (parsed.id === "pi") {
          const nextRecord = next as unknown as Record<string, unknown>;
          if (parsed.field === "bin") delete nextRecord.agentBin;
          else delete nextRecord.piArgs;
        }
        // Setting the nested claude reserve drops the top-level spelling, so the file can never
        // hold both (validateConfig rejects a file that does, mirroring the agentBin/piArgs pair).
        if (parsed.id === "claude" && parsed.field === "windowReserve") {
          const nextRecord = next as unknown as Record<string, unknown>;
          delete nextRecord.claudeWindowReserve;
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
      if (isDeepStrictEqual(oldValue, value)) {
        unchanged = true;
        return cfg;
      }
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
    if (unchanged) return { ok: true, value, oldValue, unchanged: true };
    // A string replaces a whole object tier entry, so its `backend` goes with it.
    if (parsed.kind === "tier" && isJsonObject(oldValue)) {
      const dropped =
        typeof oldValue.backend === "string" ? `backend ${show(oldValue.backend)}` : "its other keys";
      return {
        ok: true,
        value,
        oldValue,
        note: `model.${parsed.tier} was an object entry — the string replaces it, dropping ${dropped}`,
      };
    }
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
    if (isDeepStrictEqual(oldValue, value)) {
      unchanged = true;
      return cfg;
    }
    const next = { ...cfg, [key]: value };
    // `roles` merges per-entry at load (overlayDefaults seeds the catalog and lets the file
    // override one entry), so an unrelated whole-config write must not re-expand the file's
    // own roles section to the catalog — that would silently rewrite what the operator wrote.
    // When the key IS `roles` the value is the replacement, so it is left alone.
    if (key !== "roles") preserveFileRoles(root, next);
    // Writers keep one spelling: a whole-section `backends` set (the GUI Save path) drops the
    // legacy aliases the new pi form now carries, so the file can never hold both.
    // Writers keep one spelling: a whole-section `backends` set (the GUI Save path) drops the
    // legacy agentBin/piArgs aliases the new pi form now carries, so the file can never hold
    // both — the same collapseBackendAliases rule the whole-config writers (above and in
    // config.ts) use, so the alias policy cannot drift between the per-key arm and the others.
    if (key === "backends") return collapseBackendAliases(next);
    // Writers keep one spelling: a legacy top-level set drops the matching backends.pi field, so
    // the file can never hold both (validateConfig's raw pass rejects a file that does).
    if (key === "agentBin" || key === "piArgs") {
      const record = next as unknown as { backends?: Record<string, Record<string, unknown>> };
      const backends = { ...(record.backends ?? {}) };
      const entry = { ...(backends.pi ?? {}) };
      delete entry[key === "agentBin" ? "bin" : "args"];
      if (Object.keys(entry).length === 0) delete backends.pi;
      else backends.pi = entry;
      return { ...next, backends: backends };
    }
    // Writers keep one spelling: setting the top-level `claudeWindowReserve` drops the nested
    // `backends.claude.windowReserve`, so a supported `config set` never writes the rejected pair
    // (validateConfig still refuses a hand-edited file holding both).
    if (key === "claudeWindowReserve") {
      const record = next as unknown as { backends?: Record<string, Record<string, unknown>> };
      const backends = { ...(record.backends ?? {}) };
      const entry = { ...(backends.claude ?? {}) };
      delete entry.windowReserve;
      if (Object.keys(entry).length === 0) delete backends.claude;
      else backends.claude = entry;
      return { ...next, backends: backends };
    }
    return next;
  });
  if (!result.ok) return result;
  if (unchanged) return { ok: true, value, oldValue, unchanged: true };
  return { ok: true, value, oldValue };
}

/** Set a role's provider/model/thinking/backend override set in tumwater.json (`roles.<base>`),
 * the write behind the dashboard role drawer's Model overrides editor: one writeConfigMutation
 * rebuilds `roles.<base>` from the FILE's own `roles` section (the `rawConfigObject(root).roles` /
 * `objectOrEmpty` idiom setConfigKey's role branch uses, so the write never re-expands the
 * operator's partial section), and validateConfig's `roles.<id>` check (checkModelTriple,
 * modelShape "tier-name") owns the whole candidate, so a bad `thinking` level writes nothing.
 * An unknown base id writes nothing too — refused up front, because validateConfig is skipped
 * on the no-op path (a clear of fields a role the file never held changes nothing) and the
 * writer must not answer a phantom role "updated". `undefined` leaves that field as the file
 * has it; `""` deletes it (never stores an empty string, which checkStringField rejects), and
 * clearing the entry's last override removes `roles.<base>` entirely rather than leaving an
 * empty object (the file-wide no-empty-object invariant unsetConfigKey's `without` keeps).
 * An all-no-op call (every named field already absent-or-equal) returns the loaded config
 * unchanged and writeConfigMutation skips the write, so clearing keys the file never held
 * leaves its bytes identical. */
export function setRoleModelFields(
  root: string,
  base: string,
  fields: { provider?: string; model?: string; thinking?: string; backend?: string },
): { ok: true; unchanged?: true } | { ok: false; error: string } {
  // An unknown base id writes nothing. validateConfig owns the refusal when the write changes
  // the candidate, but it is skipped on the no-op path (clearing fields a role the file never
  // held changes nothing), so refuse the phantom role up front — the same knownRoleIds guard
  // the CLI's unsetConfigKey clear paths and the GUI's rejectBadRole use — rather than answer
  // a bogus id "updated".
  if (!knownRoleIdsCached(root).includes(base)) return fail(unknownRoleMessage(base, knownRoleIdsCached(root)));
  let unchanged: true | undefined; // set when no field differs from the file
  const result = writeConfigMutation(root, (cfg) => {
    const rawRolesCandidate = rawConfigObject(root).roles;
    const rawRoles = objectOrEmpty(rawRolesCandidate) as Record<string, Record<string, unknown>>;
    const rawEntryCandidate = rawRoles[base];
    const rawEntry = objectOrEmpty(rawEntryCandidate);
    const nextEntry = { ...rawEntry };
    let changed = false;
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue; // leave that field as the file has it
      if (value === "") {
        if (Object.prototype.hasOwnProperty.call(nextEntry, key)) {
          delete nextEntry[key];
          changed = true;
        }
      } else if (nextEntry[key] !== value) {
        nextEntry[key] = value;
        changed = true;
      }
    }
    if (!changed) {
      unchanged = true;
      return cfg; // writeConfigMutation skips the write — file bytes identical
    }
    const nextRoles = { ...rawRoles };
    // Clearing the entry's last override empties it — never leave an empty `roles.<base>: {}`
    // (the file-wide no-empty-object invariant unsetConfigKey's `without` keeps); an emptied
    // entry falls back to the catalog's defaults at load. When the section empties entirely,
    // drop the `roles` key too, exactly as unsetConfigKey's role branch does.
    if (Object.keys(nextEntry).length === 0) delete nextRoles[base];
    else nextRoles[base] = nextEntry;
    if (Object.keys(nextRoles).length === 0)
      return without(cfg as unknown as Record<string, unknown>, "roles") as unknown as TumwaterConfig;
    return { ...cfg, roles: nextRoles } as unknown as TumwaterConfig;
  });
  if (result.ok && unchanged) return { ok: true, unchanged: true };
  return result;
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
    if (parsed.kind === "section") {
      // Presence is judged against the FILE: a field only the default carries is a no-op
      // success, and an emptied section leaves the file.
      const rawSection = objectOrEmpty(raw[parsed.section]);
      if (!Object.hasOwn(rawSection, parsed.field)) return cfg;
      oldValue = rawSection[parsed.field];
      const existing = (record[parsed.section] as Record<string, unknown> | undefined) ?? {};
      return withSectionOrDropped(root, cfg, parsed.section, without(existing, parsed.field));
    }
    if (parsed.kind === "agent") {
      // Presence is judged against the FILE, so unsetting a field only the default (or the
      // legacy alias's resolved view) carries is a no-op success. The entry and the `backends`
      // section are dropped when they empty, so the file never keeps an empty object.
      const rawBackends = objectOrEmpty(raw.backends);
      const rawEntryCandidate = rawBackends[parsed.id];
      const rawEntry = objectOrEmpty(rawEntryCandidate);
      if (!Object.hasOwn(rawEntry, parsed.field)) return cfg; // absent file field: a no-op success
      oldValue = rawEntry[parsed.field];
      const backends = { ...(record.backends as Record<string, Record<string, unknown>> | undefined) };
      const entry = { ...(backends[parsed.id] ?? {}) };
      delete entry[parsed.field];
      if (Object.keys(entry).length === 0) delete backends[parsed.id];
      else backends[parsed.id] = entry;
      return withSectionOrDropped(root, cfg, "backends", backends);
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
