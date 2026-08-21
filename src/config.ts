import fs from "node:fs";
import type { AutomatonConfig, RoleConfig } from "./types.js";
import { allRoleIds } from "./roles.js";
import { configPath } from "./paths.js";

export function defaultConfig(): AutomatonConfig {
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

/** Load automaton.json, filling in defaults for anything missing. */
export function loadConfig(root: string): AutomatonConfig {
  const file = configPath(root);
  const base = defaultConfig();
  if (!fs.existsSync(file)) return base;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AutomatonConfig>;
  const merged: AutomatonConfig = {
    ...base,
    ...raw,
    idleBackoff: { ...base.idleBackoff, ...(raw.idleBackoff ?? {}) },
    piArgs: raw.piArgs ?? base.piArgs,
    roles: { ...base.roles },
  };
  for (const [id, rc] of Object.entries(raw.roles ?? {})) {
    merged.roles[id] = { ...(merged.roles[id] ?? { enabled: true }), ...rc };
  }
  return merged;
}

export function saveConfig(root: string, config: AutomatonConfig): void {
  fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

/** Ids of the enabled roles, in config.roles order (catalog order for known ids). */
export function enabledRoleIds(config: AutomatonConfig): string[] {
  return Object.entries(config.roles)
    .filter(([, rc]) => rc.enabled)
    .map(([id]) => id);
}

/** The config as seen by one role's pi runs: role-level provider/model/thinking
 * overrides applied over the top-level values. */
export function configForRole(config: AutomatonConfig, role: string): AutomatonConfig {
  const rc = config.roles[role];
  if (!rc) return config;
  return {
    ...config,
    provider: rc.provider ?? config.provider,
    model: rc.model ?? config.model,
    thinking: rc.thinking ?? config.thinking,
  };
}
