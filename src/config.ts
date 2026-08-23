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

/** Validate user-supplied tumwater.json values before defaults are filled in, so a typo
 * fails fast with an actionable message instead of misbehaving at runtime — e.g. a
 * non-numeric tickTimeoutSeconds becomes NaN and kills every pi run instantly, and a
 * non-numeric logMaxBytes rotates the event log on every write. Collects every problem
 * so one edit can fix them all; throws a single Error listing them. */
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
  for (const key of ["provider", "model", "thinking"]) checkString(r, "", key);
  if ("piArgs" in r) {
    const v = r.piArgs;
    if (!Array.isArray(v) || !v.every((a) => typeof a === "string"))
      problems.push(`piArgs must be an array of strings (got ${show(v)})`);
  }
  checkNumber(r, "", "maxConcurrent", (n) => Number.isInteger(n) && n >= 1, "an integer of at least 1");
  checkNumber(r, "", "minTickIntervalSeconds", (n) => n >= 0, "a number of 0 or more");
  checkNumber(r, "", "tickTimeoutSeconds", (n) => n > 0, "a number greater than 0");
  checkNumber(r, "", "logMaxBytes", (n) => n > 0, "a number greater than 0");
  checkNumber(r, "", "sessionRetentionDays", (n) => n >= 0, "a number of 0 or more");

  if ("idleBackoff" in r) {
    const b = r.idleBackoff;
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      problems.push(`idleBackoff must be an object (got ${show(b)})`);
    } else {
      checkNumber(b as Record<string, unknown>, "idleBackoff.", "initialSeconds", (n) => n >= 0, "a number of 0 or more");
      checkNumber(b as Record<string, unknown>, "idleBackoff.", "factor", (n) => n >= 1, "a number of at least 1");
      checkNumber(b as Record<string, unknown>, "idleBackoff.", "maxSeconds", (n) => n >= 0, "a number of 0 or more");
    }
  }

  if ("roles" in r) {
    const roles = r.roles;
    if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
      problems.push(`roles must be an object mapping role ids to settings (got ${show(roles)})`);
    } else {
      for (const [id, rc] of Object.entries(roles as Record<string, unknown>)) {
        if (typeof rc !== "object" || rc === null || Array.isArray(rc)) {
          problems.push(`roles.${id} must be an object (got ${show(rc)})`);
          continue;
        }
        const o = rc as Record<string, unknown>;
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
