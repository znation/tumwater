import { isJsonObject } from "../files/json-object.js";

/** One renamed config key. `"top"` is a top-level key; `"role"` is a field of every
 * `roles.<id>` entry. */
interface ConfigKeyRename {
  from: string;
  to: string;
  scope: "top" | "role";
}

/** The one table of renamed config keys: tumwater.json may spell either name, load reads both,
 * and every writer writes only `to`. */
const CONFIG_KEY_RENAMES: readonly ConfigKeyRename[] = [
  { from: "landBatchMax", to: "mergeBatchMax", scope: "top" },
  { from: "maintenancePerWorkLanding", to: "maintenancePerWorkMerge", scope: "top" },
  { from: "tickTimeoutSeconds", to: "runTimeoutSeconds", scope: "top" },
  { from: "minTickIntervalSeconds", to: "minRunIntervalSeconds", scope: "top" },
  { from: "minTickIntervalSeconds", to: "minRunIntervalSeconds", scope: "role" },
];

/** Move every old key of one object to its new name. Returns a copy when anything moved. */
function renameIn(
  obj: Record<string, unknown>,
  scope: ConfigKeyRename["scope"],
  prefix: string,
  renamed: string[],
  problems: string[],
): Record<string, unknown> {
  let out = obj;
  for (const r of CONFIG_KEY_RENAMES) {
    if (r.scope !== scope || !Object.hasOwn(obj, r.from)) continue;
    if (Object.hasOwn(obj, r.to)) {
      problems.push(`${prefix}${r.from} and ${prefix}${r.to} are both set — keep ${prefix}${r.to} (${r.from} is its old name)`);
      continue;
    }
    if (out === obj) out = { ...obj };
    out[r.to] = out[r.from];
    delete out[r.from];
    renamed.push(`${prefix}${r.from} → ${prefix}${r.to}`);
  }
  return out;
}

/** Rewrite a parsed config (or director request) so it carries only current key names. Pure:
 * the input is never mutated, and a non-object passes through unchanged. `renamed` lists each
 * `<from> → <to>` applied; `problems` names each pair the file set both ways. */
export function normalizeConfigKeys(raw: unknown): { raw: unknown; renamed: string[]; problems: string[] } {
  const renamed: string[] = [];
  const problems: string[] = [];
  if (!isJsonObject(raw)) return { raw, renamed, problems };
  let out = renameIn(raw, "top", "", renamed, problems);
  if (isJsonObject(out.roles)) {
    let roles: Record<string, unknown> = out.roles;
    for (const [id, entry] of Object.entries(out.roles)) {
      if (!isJsonObject(entry)) continue;
      const next = renameIn(entry, "role", `roles.${id}.`, renamed, problems);
      if (next !== entry) {
        if (roles === out.roles) roles = { ...out.roles };
        roles[id] = next;
      }
    }
    if (roles !== out.roles) out = { ...out, roles };
  }
  return { raw: out, renamed, problems };
}

/** Map a key a person typed to its current spelling: a top-level old name, a dotted key whose
 * first segment is an old top-level name, or `roles.<id>.<old field>`. Anything else passes
 * through unchanged. */
export function canonicalConfigKey(key: string): string {
  const parts = key.split(".");
  const first = parts[0] ?? "";
  const top = CONFIG_KEY_RENAMES.find((r) => r.scope === "top" && r.from === first);
  if (top) return [top.to, ...parts.slice(1)].join(".");
  if (parts.length === 3 && first === "roles") {
    const role = CONFIG_KEY_RENAMES.find((r) => r.scope === "role" && r.from === parts[2]);
    if (role) return `roles.${parts[1]}.${role.to}`;
  }
  return key;
}
