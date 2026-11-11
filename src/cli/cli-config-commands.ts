import fs from "node:fs";
import { configPath, CONFIG_BASENAME } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { loadConfigSafe, knownRoleIds, nonDefaultConfigEntries } from "../config/config.js";
import { fail, say, sayJson, sayJsonLine } from "./cli-output.js";
import {
  setConfigKey,
  unsetConfigKey,
  replaceConfigText,
} from "../config/config-write.js";
import { canonicalConfigKey } from "../config/config-aliases.js";
import { parseConfigKey, unknownConfigKeyError, unknownRoleFieldError } from "../config/config-keys.js";
import { modelTierMap } from "../config/config-schema.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { rejectFlagLookingValue } from "./cli-args.js";
import { editInEditor } from "./cli-editor.js";
import { unknownRoleMessage } from "../roles/roles.js";

/** The `tumwater config` command's CLI layer (split out of operator/operator-commands.ts, which
 * keeps the other operator-command bodies): with no arguments, print the effective merged
 * config — exactly what `loadConfig(root)` returns — as pretty JSON, so an operator
 * debugging scheduling or custom-role wiring sees what the team would actually load instead
 * of overlaying defaults onto tumwater.json by hand. `--diff` prints only the resolved
 * settings that differ from the built-in defaults — every changed top-level setting and
 * each changed role as `roles.<id>` — so an operator sees what this repo changed without
 * diffing the whole dump by hand; a pure read of the same resolved config.
 * A query, not a writer: no redaction (the
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
 * sites (mirrors run-detail.ts's RUN_DETAIL_USAGE). */
export const CONFIG_USAGE =
  "usage: tumwater config [get <key> | set <key> <value> [--json] | unset <key> [--json] | edit [--file <path>] [--json] | --diff] (bare config prints the whole resolved config; --diff prints only the non-default settings; edit opens the whole file in $VISUAL/$EDITOR or takes its replacement from --file, validating and writing it atomically)";

/** Removes one trailing `--json` from a `set` or `unset` invocation so the arity gate in
 * cli.ts and the verb dispatch here see the shaped args (`config set <key> <value> --json` →
 * `set <key> <value>` + the flag), while every other shape — a `get`, a bare config, `--diff`,
 * or a `set`/`unset` with no trailing flag — is returned untouched. The `set model --json`
 * case is the rule's whole reason: a `set` with exactly three tokens carries no real value
 * after the key, so its lone trailing token is the flag-looking *value* the verb already
 * refuses, not a `--json` to peel; a `set` needs more than three and an `unset` more than two
 * before a `--json` is a real flag rather than the key or value. cli.ts's arity gate calls it
 * before its count checks, and `cmdConfig` calls it once more on the original args before
 * dispatching, so both see identical shaped args. */
export function peelConfigJson(args: string[]): { args: string[]; json: boolean } {
  const verb = args[0];
  const needs = verb === "set" ? 3 : verb === "unset" ? 2 : verb === "edit" ? 1 : -1;
  if (needs >= 0 && args.length > needs && args[args.length - 1] === "--json")
    return { args: args.slice(0, -1), json: true };
  return { args, json: false };
}

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
  if (parsed.kind === "role") {
    const ids = knownRoleIds(config);
    if (!ids.includes(parsed.id)) fail(unknownRoleMessage(parsed.id, ids));
    const fieldError = unknownRoleFieldError(parsed.id, parsed.field);
    if (fieldError) fail(fieldError);
  } else if (parsed.kind === "map") {
    // Role-keyed maps check the role catalog: a typo'd role id is refused the way set's
    // validator treats it.
    const ids = knownRoleIds(config);
    if (!ids.includes(parsed.role)) fail(unknownRoleMessage(parsed.role, ids));
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

/** The `config get` verb: screen the key through screenOperableKey, then print its resolved
 * value (defaults merged in) as JSON, or JSON null when nothing sets it. */
async function configGet(root: string, key: string | undefined): Promise<void> {
  const { parsed, config } = screenOperableKey(root, key ?? "");
  const value = resolvedConfigValue(config, parsed, key ?? "");
  sayJsonLine(value === undefined ? null : value); // Absent optional key → JSON null.
}

/** The `config unset` verb: screen the key, remove it, and confirm what, if anything, was
 * removed (or what the key now resolves to). */
async function configUnset(root: string, key: string | undefined, json = false): Promise<void> {
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
    if (json) {
      const ack: Record<string, unknown> = {
        command: "config",
        action: "unset",
        key: k,
        status: "not_set",
      };
      if (now !== undefined) ack.resolved = now;
      sayJsonLine(ack);
      return;
    }
    say(
      `${k} is not set in tumwater.json, so nothing was removed` +
        (now === undefined ? "" : ` (it resolves to ${resolves})`),
    );
    return;
  }
  if (json) {
    // The script-facing twin of the prose below: one compact acknowledgement object whose
    // status names what happened, with `oldValue` when the file held the key and `resolved`
    // when it still resolves after removal. sayJsonLine, not sayJson: the contract is the
    // whole stdout as one line, so a script can JSON.parse stdout directly (sayJson's
    // two-space pretty print would span many lines).
    const ack: Record<string, unknown> = {
      command: "config",
      action: "unset",
      key: k,
      status: "removed",
      oldValue: result.oldValue,
    };
    if (now !== undefined) ack.resolved = now;
    sayJsonLine(ack);
    return;
  }
  const was = JSON.stringify(result.oldValue);
  say(`unset ${k} (was ${was}${now === undefined ? "" : `; now resolves to ${resolves}`})`);
}

/** The `config --diff` verb: print only the resolved settings that differ from the built-in
 * defaults — every changed top-level setting and each changed role as `roles.<id>` — as
 * pretty JSON, so an operator sees what this repo changed without diffing the whole dump by
 * hand. Read-only, like the dump: a malformed tumwater.json fails with validateConfig's
 * message and no JSON. A surplus argument after `--diff` fails CONFIG_USAGE — the defensive
 * tail behind cli.ts's sole-argument gate, for a direct caller. */
async function configDiff(root: string, extra: string | undefined): Promise<void> {
  if (extra !== undefined) fail(CONFIG_USAGE);
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  sayJson(Object.fromEntries(nonDefaultConfigEntries(config)));
}

/** The `config set` verb: write one value through setConfigKey (refusing a flag-looking
 * value first) and confirm the write or that it was already that value. */
async function configSet(
  root: string,
  key: string | undefined,
  rest: string[],
  json = false,
): Promise<void> {
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
  const rk = canonicalConfigKey(key ?? "");
  const value = (result as { value: unknown }).value;
  const unchanged = Boolean((result as { unchanged?: true }).unchanged);
  // The script-facing twin of the prose confirmation: one compact acknowledgement object
  // whose status names the outcome — `set` when the file changed, `unchanged` when it
  // already resolved to that value. sayJsonLine, not sayJson: the whole stdout must be one
  // line so a script can JSON.parse it (sayJson's two-space pretty print spans many lines).
  // A `--json` write carries no prose: with-json prints only the object.
  if (json) {
    const ack: Record<string, unknown> = {
      command: "config",
      action: "set",
      key: rk,
      value,
      status: unchanged ? "unchanged" : "set",
    };
    const note = (result as { note?: string }).note;
    if (note) ack.note = note;
    else if (key === "roles")
      ack.note =
        "the built-in role catalog still merges per entry — disable a role with `tumwater config set roles.<id>.enabled false`, not by omitting it";
    sayJsonLine(ack);
    return;
  }
  if (unchanged) {
    say(`${rk} is already ${JSON.stringify(value)}, so tumwater.json was not written`);
    return;
  }
  say(`set ${rk} to ${JSON.stringify(value)}`);
  const note = (result as { note?: string }).note;
  if (note) say(`note: ${note}`);
  // A bare `roles` set replaces the FILE's section, but the built-in catalog always merges
  // per entry at load, so the replacement cannot disable a role by omission. Say so here
  // rather than let the confirmation imply the role is gone.
  if (key === "roles")
    say(
      "note: the built-in role catalog still merges per entry — disable a role with `tumwater config set roles.<id>.enabled false`, not by omitting it",
    );
}

/** The bare-config tail: the whole resolved config as pretty JSON, refusing a surplus
 * subcommand the arity gate somehow missed. */
async function configDump(root: string, sub: string | undefined): Promise<void> {
  // Bare config, or anything else: the whole-config dump is the default, and cli.ts's arity
  // check has already rejected a malformed get/set — this usage line is the defensive tail.
  if (sub !== undefined) fail(CONFIG_USAGE);
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  sayJson(config);
}

/** The `config edit` verb: replace the whole tumwater.json through the validated whole-file
 * writer (`replaceConfigText`), so a multi-key change goes through the same lock, validation and
 * atomic write as `set`/`unset` instead of a hand edit. With `--file <path>`, the replacement
 * text is read from that path (a flag-looking path is refused first; an unreadable path fails
 * naming it). With no `--file`, the current tumwater.json is opened in `$VISUAL`/`$EDITOR`
 * (`{}` when the file is absent) and the saved buffer is the replacement; a buffer that trims to
 * the current file's text is reported `config unchanged` without calling the writer. On success
 * the file is printed updated or unchanged; with `--json` the acknowledgement object is the
 * whole stdout and no prose is printed. A malformed buffer, a non-object, or an invalid setting
 * fails with the writer's message and leaves the file byte-identical, and prints no JSON.
 */
async function configEdit(root: string, args: string[], json: boolean): Promise<void> {
  // `args` is the verb's full argument list (shaped after the `edit` subcommand): the arity
  // gate has made it either [] (editor form) or ["--file", <path>]. A flag-looking path is
  // refused before any read, and a duplicate or surplus --file fails the config usage.
  let text: string;
  if (args[0] === "--file") {
    const p = args[1];
    if (!p || args.length !== 2 || args.filter((t) => t === "--file").length > 1) fail(CONFIG_USAGE);
    rejectFlagLookingValue("--file", p);
    try {
      text = fs.readFileSync(p, "utf8");
    } catch (err) {
      fail(`cannot read config file ${p}: ${errorMessage(err)}`);
    }
  } else {
    let current = "{}";
    try {
      current = fs.readFileSync(configPath(root), "utf8");
    } catch {
      current = "{}"; // absent file — the bare defaults, so the editor starts from an empty object
    }
    text = editInEditor(current, CONFIG_BASENAME, "pass --file <path>");
    if (text.trim() === current.trim()) {
      if (json) sayJsonLine({ command: "config", action: "edit", file: CONFIG_BASENAME, status: "unchanged" });
      else say("config unchanged");
      return;
    }
  }
  const result = replaceConfigText(root, text);
  if (!result.ok) fail(result.error);
  if (json) {
    sayJsonLine({ command: "config", action: "edit", file: CONFIG_BASENAME, status: result.changed ? "set" : "unchanged" });
    return;
  }
  say(result.changed ? `config updated in ${CONFIG_BASENAME}` : "config unchanged");
}

/** The `tumwater config` command body: bare prints the resolved config; `--diff` prints only
 * the non-default subset; `get` and `unset` screen their key through screenOperableKey, while
 * `set` writes through setConfigKey and `edit` writes the whole file through replaceConfigText.
 * Each verb's guards and confirmation wording live in one named helper — configGet,
 * configUnset, configSet, configEdit, configDump, configDiff — that this dispatcher delegates to.
 */
export async function cmdConfig(root: string, args: string[] = []): Promise<void> {
  // Peel once before dispatch, mirroring cli.ts's arity gate, so `set <key> <value> --json`
  // reaches configSet shaped and flagged (a `set` carrying exactly one trailing token is the
  // flag-looking *value* peelConfigJson leaves for the verb's own refusal).
  const { args: shaped, json } = peelConfigJson(args);
  const [sub, key, ...rest] = shaped;
  if (sub === "--diff") return configDiff(root, key);
  if (sub === "get") return configGet(root, key);
  if (sub === "unset") return configUnset(root, key, json);
  if (sub === "set") return configSet(root, key, rest, json);
  if (sub === "edit") return configEdit(root, shaped.slice(1), json);
  return configDump(root, sub);
}
