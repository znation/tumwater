import fs from "node:fs";
import type { TumwaterConfig, RoleConfig } from "./types.js";
import { allRoleIds } from "./roles.js";
import { configPath } from "./paths.js";

export function defaultConfig(): TumwaterConfig {
  const roles: Record<string, RoleConfig> = {};
  for (const id of allRoleIds()) roles[id] = { enabled: true };
  return {
    piArgs: [],
    maxConcurrent: 6,
    minTickIntervalSeconds: 20,
    tickTimeoutSeconds: 1800,
    quietTimeoutSeconds: 1800,
    logMaxBytes: 16 * 1024 * 1024,
    sessionRetentionDays: 7,
    idleBackoff: { initialSeconds: 120, factor: 2, maxSeconds: 3600 },
    roles,
  };
}

/** Render a value for an error message. */
function show(v: unknown): string {
  return v === undefined ? "missing" : (JSON.stringify(v) ?? String(v));
}

/** JSON type name for top-level error messages ("an array", "null", "string", …). */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

/** Every key tumwater.json may hold, by level. Anything else is a typo that would be
 * silently ignored at runtime — the intended setting falls back to its default with no
 * warning — so it fails fast here instead (e.g. `tickTimeoutSecondss` does nothing).
 * Keep in sync with TumwaterConfig/BackoffConfig/RoleConfig in types.ts. */
const TOP_LEVEL_KEYS = [
  "provider",
  "model",
  "thinking",
  "piArgs",
  "maxConcurrent",
  "minTickIntervalSeconds",
  "tickTimeoutSeconds",
  "quietTimeoutSeconds",
  "logMaxBytes",
  "sessionRetentionDays",
  "idleBackoff",
  "roles",
];
const BACKOFF_KEYS = ["initialSeconds", "factor", "maxSeconds"];
const ROLE_ENTRY_KEYS = ["enabled", "instructions", "provider", "model", "thinking"];

/** Collect the keys present in `obj` but not in `known` into problems, naming where they
 * were found and listing what is valid so one edit fixes them. */
function checkKnownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key))
      problems.push(`unknown key "${key}" in ${where} (valid keys: ${known.join(", ")})`);
  }
}

/** Validate user-supplied tumwater.json values before defaults are filled in, so a typo
 * fails fast with an actionable message instead of misbehaving at runtime — e.g. a
 * non-numeric tickTimeoutSeconds becomes NaN and kills every pi run instantly, a
 * non-numeric logMaxBytes rotates the event log on every write, an unknown role id (a
 * misspelled entry under `roles`) spawns a phantom loop that errors every tick, and an
 * unknown key is silently ignored so the intended setting never takes effect. Collects
 * every problem so one edit can fix them all; throws a single Error listing them. */
export function validateConfig(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`tumwater.json must be a JSON object (got ${typeName(raw)})`);
  }
  const problems: string[] = [];

  const checkString = (obj: Record<string, unknown>, prefix: string, key: string): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "string") problems.push(`${prefix}${key} must be a string (got ${show(v)})`);
  };

  const checkNumber = (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    ok: (n: number) => boolean,
    what: string,
  ): void => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v) || !ok(v))
      problems.push(`${prefix}${key} must be ${what} (got ${show(v)})`);
  };

  const r = raw as Record<string, unknown>;
  checkKnownKeys(r, TOP_LEVEL_KEYS, "tumwater.json", problems);
  for (const key of ["provider", "model", "thinking"]) checkString(r, "", key);
  if ("piArgs" in r) {
    const v = r.piArgs;
    if (!Array.isArray(v) || !v.every((a) => typeof a === "string"))
      problems.push(`piArgs must be an array of strings (got ${show(v)})`);
  }
  checkNumber(r, "", "maxConcurrent", (n) => Number.isInteger(n) && n >= 1, "an integer of at least 1");
  checkNumber(r, "", "minTickIntervalSeconds", (n) => n >= 0, "a number of 0 or more");
  checkNumber(r, "", "tickTimeoutSeconds", (n) => n > 0, "a number greater than 0");
  checkNumber(r, "", "quietTimeoutSeconds", (n) => n >= 0, "a number of 0 or more (0 disables)");
  checkNumber(r, "", "logMaxBytes", (n) => n > 0, "a number greater than 0");
  checkNumber(r, "", "sessionRetentionDays", (n) => n >= 0, "a number of 0 or more");

  if ("idleBackoff" in r) {
    const b = r.idleBackoff;
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      problems.push(`idleBackoff must be an object (got ${show(b)})`);
    } else {
      const o = b as Record<string, unknown>;
      checkKnownKeys(o, BACKOFF_KEYS, "idleBackoff", problems);
      checkNumber(o, "idleBackoff.", "initialSeconds", (n) => n >= 0, "a number of 0 or more");
      checkNumber(o, "idleBackoff.", "factor", (n) => n >= 1, "a number of at least 1");
      checkNumber(o, "idleBackoff.", "maxSeconds", (n) => n >= 0, "a number of 0 or more");
    }
  }

  if ("roles" in r) {
    const roles = r.roles;
    if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
      problems.push(`roles must be an object mapping role ids to settings (got ${show(roles)})`);
    } else {
      for (const [id, rc] of Object.entries(roles as Record<string, unknown>)) {
        // An id outside the catalog cannot work: tickPrompt has no prompt for it and the
        // loop would error every tick forever. Reject it here with the valid ids — the same
        // message shape `tumwater logs --role` uses for a bad flag value.
        if (!allRoleIds().includes(id)) {
          problems.push(`roles.${id} is not a known role (valid ids: ${allRoleIds().join(", ")})`);
          continue;
        }
        if (typeof rc !== "object" || rc === null || Array.isArray(rc)) {
          problems.push(`roles.${id} must be an object (got ${show(rc)})`);
          continue;
        }
        const o = rc as Record<string, unknown>;
        checkKnownKeys(o, ROLE_ENTRY_KEYS, `roles.${id}`, problems);
        for (const key of ["instructions", "provider", "model", "thinking"])
          checkString(o, `roles.${id}.`, key);
        if ("enabled" in o && typeof o.enabled !== "boolean")
          problems.push(`roles.${id}.enabled must be true or false (got ${show(o.enabled)})`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid tumwater.json:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Load tumwater.json, filling in defaults for anything missing. Throws an Error with an
 * actionable message when the file is malformed or holds invalid values (see validateConfig). */
export function loadConfig(root: string): TumwaterConfig {
  const file = configPath(root);
  const base = defaultConfig();
  if (!fs.existsSync(file)) return base;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`tumwater.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  validateConfig(raw);
  const cfg = raw as Partial<TumwaterConfig>;
  const merged: TumwaterConfig = {
    ...base,
    ...cfg,
    idleBackoff: { ...base.idleBackoff, ...(cfg.idleBackoff ?? {}) },
    piArgs: cfg.piArgs ?? base.piArgs,
    roles: { ...base.roles },
  };
  for (const [id, rc] of Object.entries(cfg.roles ?? {})) {
    merged.roles[id] = { ...(merged.roles[id] ?? { enabled: true }), ...rc };
  }
  return merged;
}

/** Load tumwater.json without throwing: either the validated config or the error message.
 * Used by the orchestrator's live-reload poll, where a broken file must not stop the fleet —
 * callers keep their last-known-good config and surface `error` as a warning. */
export function loadConfigSafe(root: string): { config?: TumwaterConfig; error?: string } {
  try {
    return { config: loadConfig(root) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist a config after validating it, so an invalid tumwater.json can never be written. */
export function saveConfig(root: string, config: TumwaterConfig): void {
  validateConfig(config);
  fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

/** Ids of the enabled roles, in config.roles order (catalog order for known ids). */
export function enabledRoleIds(config: TumwaterConfig): string[] {
  return Object.entries(config.roles)
    .filter(([, rc]) => rc.enabled)
    .map(([id]) => id);
}

/** The config as seen by one role's pi runs: role-level provider/model/thinking
 * overrides applied over the top-level values. */
export function configForRole(config: TumwaterConfig, role: string): TumwaterConfig {
  const rc = config.roles[role];
  if (!rc) return config;
  return {
    ...config,
    provider: rc.provider ?? config.provider,
    model: rc.model ?? config.model,
    thinking: rc.thinking ?? config.thinking,
  };
}
