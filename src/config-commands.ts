import { loadConfigSafe } from "./config.js";
import { fail, say, sayJson } from "./cli-output.js";
import { setConfigKey, unknownConfigKeyError } from "./config-write.js";

/** The `tumwater config` command's CLI layer (split out of operator-commands.ts, which holds
 * only the operator-intent marker commands): with no arguments, print the effective merged
 * config — exactly what `loadConfig(root)` returns — as pretty JSON, so an operator
 * debugging scheduling or custom-loop wiring sees what the fleet would actually load instead
 * of overlaying defaults onto tumwater.json by hand. A query, not a writer: no redaction (the
 * config holds no secrets — provider keys belong to pi's own env) and no transformation,
 * including the per-role entries custom loops merge into. `get <key>` prints that one key's
 * resolved value (defaults merged in, exactly what the no-arg dump prints) as JSON, failing
 * with the valid top-level keys on an unknown one. An optional key nothing sets (model,
 * provider, fallbackModel, …) prints `null` — JSON's no-value — because JSON.stringify of an
 * absent key is the undefined *value*, which say would render as the bare word `undefined`:
 * not parseable JSON for a script and indistinguishable from a crash for a human. `set <key>
 * <value>` writes one top-level key through setConfigKey and prints one confirmation line
 * naming the key and its new value; a running fleet picks the change up on its next ~2 s
 * config poll (newLiveConfigReload). A malformed or invalid tumwater.json fails with
 * validateConfig's actionable message and prints no JSON — the same surfacing doctor's config
 * check produces. The reading/writing halves live beside it in config.ts and config-write.ts;
 * this file holds only the command shell around them. */

/** The config command's malformed-shapes usage line: cli.ts's arity gate fails a non-get/set
 * or wrongly-shaped subcommand with it, and cmdConfig repeats it as the defensive tail for an
 * argument the gate somehow missed. One constant so the synopsis cannot drift between the two
 * sites (mirrors tick-detail.ts's TICK_USAGE). */
export const CONFIG_USAGE =
  "usage: tumwater config [get <key> | set <key> <value>] (bare config prints the whole resolved config)";

export async function cmdConfig(root: string, args: string[] = []): Promise<void> {
  const [sub, key, ...rest] = args;
  if (sub === "get") {
    const k = key ?? "";
    // setConfigKey's shared unknown-key error, so a typo'd key reads the same whichever
    // verb misspelled it.
    const unknown = unknownConfigKeyError(k);
    if (unknown) fail(unknown);
    const { config, error } = loadConfigSafe(root);
    if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
    const value = (config as unknown as Record<string, unknown>)[k];
    say(JSON.stringify(value === undefined ? null : value)); // Absent optional key → JSON null.
    return;
  }
  if (sub === "set") {
    const result = setConfigKey(root, key ?? "", rest[0] ?? "");
    if (!result.ok) fail(result.error);
    say(`set ${key} to ${JSON.stringify((result as { value: unknown }).value)}`);
    return;
  }
  // Bare config, or anything else: the whole-config dump is the default, and cli.ts's arity
  // check has already rejected a malformed get/set — this usage line is the defensive tail.
  if (sub !== undefined) fail(CONFIG_USAGE);
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  sayJson(config);
}
