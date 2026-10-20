// vocabulary: plain
import { loadConfigSafe, knownRoleIds } from "../config/config.js";
import { fail, say, sayJson, sayJsonLine } from "./cli-output.js";
import {
  setConfigKey,
  unsetConfigKey,
} from "../config/config-write.js";
import { canonicalConfigKey } from "../config/config-aliases.js";
import { parseConfigKey, unknownConfigKeyError, unknownRoleFieldError } from "../config/config-keys.js";
import { modelTierMap } from "../config/config-schema.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { unknownRoleMessage } from "../roles/roles.js";

/** The `tumwater config` command's CLI layer (split out of operator/operator-commands.ts, which
 * keeps the other operator-command bodies): with no arguments, print the effective merged
 * config — exactly what `loadConfig(root)` returns — as pretty JSON, so an operator
 * debugging scheduling or custom-role wiring sees what the team would actually load instead
 * of overlaying defaults onto tumwater.json by hand. A query, not a writer: no redaction (the
 * config holds no secrets — provider keys belong to pi's own env) and no transformation,
 * including the per-role entries custom roles merge into. `get <key>` prints that one key's
 * resolved value (defaults merged in, exactly what the no-arg dump prints) as JSON, failing
 * with the valid top-level keys on an unknown one. An optional key nothing sets (model,
 * provider, fallbackModel, …) prints `null` — JSON's no-value — because JSON.stringify of an
 * absent key is the undefined *value*, which say would render as the bare word `undefined`:
 * not parseable JSON for a script and indistinguishable from a crash for a human. `set <key>
 * <value>` writes one top-level key through setConfigKey and prints one confirmation line
 * naming the key and its new value; `unset <key>` removes one value through unsetConfigKey
 * (the inverse of set) and confirms what, if anything, was removed. A running team picks the
 * change up on its next ~2 s config poll (newLiveConfigReload). A malformed or invalid
 * tumwater.json fails with validateConfig's actionable message and prints no JSON — the same
 * surfacing doctor's config check produces. The reading/writing halves live beside it in
 * config.ts and config-write.ts; this file holds only the command shell around them. */

/** The config command's malformed-shapes usage line: cli.ts's arity gate fails a non-get/set
 * or wrongly-shaped subcommand with it, and cmdConfig repeats it as the defensive tail for an
 * argument the gate somehow missed. One constant so the synopsis cannot drift between the two
 * sites (mirrors run-detail.ts's TICK_USAGE). */
export const CONFIG_USAGE =
  "usage: tumwater config [get <key> | set <key> <value> | unset <key>] (bare config prints the whole resolved config)";

/** The key screens `config get` and `config unset` run before resolving or removing a value:
 * the shape parser's own error; the shared unknown-top-level-key message; then, for a dotted
 * key, the catalog's known-role check and the shared unknown-role-field message. A dotted key
 * naming a role the catalog (plus customRoles) does not know can never resolve, and a silent
 * `null`/removal for it would read as a real unset when the operator misspelled the id. Fails
 * the process with whichever message applies; returns the parsed key and the freshly loaded
 * config for the caller's own read/mutation. (An unknown role id in the FILE is already a
 * validation error — this is the same rule at the CLI boundary.) */
function screenOperableKey(root: string, key: string) {
  const k = canonicalConfigKey(key);
  const parsed = parseConfigKey(k); // shape only — the verbs below own the unknown-key wording
  if (parsed.kind === "error") fail(parsed.error);
  if (parsed.kind === "top") {
    const unknown = unknownConfigKeyError(k); // the shared unknown-key error, so a typo'd key reads the same whichever verb misspelled it
    if (unknown) fail(unknown);
  }
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  if (parsed.kind === "map" || parsed.kind === "role") {
    const id = parsed.kind === "map" ? parsed.role : parsed.id;
    const ids = knownRoleIds(config);
    if (!ids.includes(id)) fail(unknownRoleMessage(id, ids));
    if (parsed.kind === "role") {
      const fieldError = unknownRoleFieldError(parsed.id, parsed.field);
      if (fieldError) fail(fieldError);
    }
  }
  return { parsed, config };
}

/** The resolved value of one screened key in a loaded config (defaults merged in): what `config
 * get` prints and what `config unset` reports the key now resolves to. Undefined when nothing
 * sets it. */
function resolvedConfigValue(
  config: TumwaterConfig,
  parsed: ReturnType<typeof parseConfigKey>,
  key: string,
): unknown {
  const record = config as unknown as Record<string, unknown>;
  return parsed.kind === "map"
    ? (record[parsed.map] as Record<string, unknown> | undefined)?.[parsed.role]
    : parsed.kind === "tier"
      ? modelTierMap(record.model)[parsed.tier] // a string is shorthand for { default }
      : parsed.kind === "agent"
        ? (record.backends as Record<string, Record<string, unknown>> | undefined)?.[parsed.id]?.[
            parsed.field
          ]
        : parsed.kind === "section"
          ? (record[parsed.section] as Record<string, unknown> | undefined)?.[parsed.field]
        : parsed.kind === "role"
          ? (record.roles as Record<string, Record<string, unknown>> | undefined)?.[parsed.id]?.[
              parsed.field
            ]
          : record[canonicalConfigKey(key)];
}

/** The `tumwater config` command body: bare prints the resolved config; `get` and `unset`
 * screen their key through screenOperableKey, while `set` writes through setConfigKey. */
export async function cmdConfig(root: string, args: string[] = []): Promise<void> {
  const [sub, key, ...rest] = args;
  if (sub === "get") {
    const { parsed, config } = screenOperableKey(root, key ?? "");
    const value = resolvedConfigValue(config, parsed, key ?? "");
    sayJsonLine(value === undefined ? null : value); // Absent optional key → JSON null.
    return;
  }
  if (sub === "unset") {
    // cli.ts's arity gate requires exactly two args (`unset <key>`) before cmdConfig runs;
    // this is the defensive tail for a direct caller, matching the bare-config tail below.
    if (key === undefined) fail(CONFIG_USAGE);
    const k = canonicalConfigKey(key);
    // The same screens get runs first, so a typo'd top-level key, role id, or role field
    // fails identically — unsetConfigKey's own parse/field checks are the mutation-side
    // backstop, not the wording the operator sees.
    const { parsed } = screenOperableKey(root, k);
    const result = unsetConfigKey(root, k);
    if (!result.ok) fail(result.error);
    // The reload only feeds the message, so a failed one leaves `now` undefined.
    const reloaded = loadConfigSafe(root).config;
    const now = reloaded === undefined ? undefined : resolvedConfigValue(reloaded, parsed, k);
    const resolves = now === undefined ? "" : JSON.stringify(now);
    if (result.oldValue === undefined) {
      say(
        `${k} is not set in tumwater.json, so nothing was removed` +
          (now === undefined ? "" : ` (it resolves to ${resolves})`),
      );
    } else {
      const was = JSON.stringify(result.oldValue);
      say(`unset ${k} (was ${was}${now === undefined ? "" : `; now resolves to ${resolves}`})`);
    }
    return;
  }
  if (sub === "set") {
    // A flag-looking value is a dropped `--` in disguise: `config set model --json` would
    // otherwise take the literal string "--json" as the value (the JSON-parse fallback
    // swallows any token) and validateConfig's string keys accept it silently — the same
    // shape gui/gui-command.ts's --token gate refuses, where the value the next flag holds is never
    // what the operator meant. Refuse before setConfigKey reads it; a value that really
    // does begin with `--` has no legitimate shape among the config keys' values
    // (identifiers, durations, windows, JSON scalars and arrays), so nothing is lost.
    const raw = rest[0] ?? "";
    if (raw.startsWith("--"))
      fail(
        `config set got the flag-looking value ${JSON.stringify(raw)} instead of a value — is a flag missing its value, or did a token slip into the value's position? (e.g. \`tumwater config set model gpt-5\`)`,
      );
    const result = setConfigKey(root, key ?? "", raw);
    if (!result.ok) fail(result.error);
    if ((result as { unchanged?: true }).unchanged) {
      say(`${canonicalConfigKey(key ?? "")} is already ${JSON.stringify((result as { value: unknown }).value)}, so tumwater.json was not written`);
      return;
    }
    say(`set ${canonicalConfigKey(key ?? "")} to ${JSON.stringify((result as { value: unknown }).value)}`);
    const note = (result as { note?: string }).note;
    if (note) say(`note: ${note}`);
    // A bare `roles` set replaces the FILE's section, but the built-in catalog always merges
    // per entry at load, so the replacement cannot disable a role by omission. Say so here
    // rather than let the confirmation imply the role is gone.
    if (key === "roles")
      say(
        "note: the built-in role catalog still merges per entry — disable a role with `tumwater config set roles.<id>.enabled false`, not by omitting it",
      );
    return;
  }
  // Bare config, or anything else: the whole-config dump is the default, and cli.ts's arity
  // check has already rejected a malformed get/set — this usage line is the defensive tail.
  if (sub !== undefined) fail(CONFIG_USAGE);
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  sayJson(config);
}
