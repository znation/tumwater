/** `tumwater role <id>`'s command body, split out of cli-query-commands.ts so that module
 * keeps only the read-only query commands (status, diff, queue, backlog). cli.ts's dispatcher
 * routes to cmdRole here exactly as it routes cmdStatus to cli-query-commands or cmdConfig to
 * cli-config-commands. cmdRole is the one query-named command that also writes: it renders a
 * role's standing and next-run prompts and carries eleven per-role write flags (notes,
 * instructions, quiet-hours, daily cap, min-run-interval, instances, enable/disable, and the
 * provider/model/thinking/backend), each through the same setConfigKey/unsetConfigKey core
 * `config set`/`config unset` use. It lives in its own file because its mixed
 * positional/flag vocabulary and its write branches are its own, not the query commands'. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { failFollowJsonRival, flagValue } from "./cli-args.js";
import { FOLLOW_FLAG, hasFollowFlag, JSON_FLAG, ROLE_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { defaultConfig, knownRoleIds, loadConfigSafe } from "../config/config.js";
import { rolePayload } from "../roles/role-view.js";
import { renderRoleMarkdown } from "../roles/role-render.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../roles/roles.js";
import { saveRoleNote } from "../roles/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { errorMessage, isExponentSpelling, isPlainDecimal } from "../text/text.js";
import { readPromptFileArg } from "./cli-prompt-file.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";
import { INSTANCE_ROLES, baseRoleOf } from "../roles/runner-ids.js";
import { setConfigKey, unsetConfigKey } from "../config/config-write.js";

/** `role`'s notes-write flags: clear the note, or replace it from a file (`-` for stdin). */
const CLEAR_NOTES_SPEC = { names: ["--clear-notes"] };
const NOTES_FILE_SPEC = { names: ["--notes-file"], value: true, valueName: "<path>" };

/** `role`'s instructions-override flags: clear it, or replace it from a file (`-` for stdin). */
const CLEAR_INSTRUCTIONS_SPEC = { names: ["--clear-instructions"] };
const INSTRUCTIONS_FILE_SPEC = { names: ["--instructions-file"], value: true, valueName: "<path>" };

/** `role`'s quiet-hours write flags: clear the window, or set it to a daily local-time window. */
const CLEAR_QUIET_HOURS_SPEC = { names: ["--clear-quiet-hours"] };
const QUIET_HOURS_SPEC = { names: ["--quiet-hours"], value: true, valueName: "<window>" };

/** `role`'s daily-cap write flags: clear the cap, or set it to a USD amount (0 disables). */
const CLEAR_CAP_SPEC = { names: ["--clear-cap"] };
const CAP_SPEC = { names: ["--cap"], value: true, valueName: "<usd>" };

/** A plain-decimal count like `.5`, `05` or `00.5` that Number() reads but JSON.parse cannot
 * (JSON forbids a leading dot and a leading zero), so a `role` numeric write must spell it back
 * in JSON form (`0.5` for `00.5`) before setConfigKey, whose JSON.parse fallback would
 * otherwise store the literal string. The same plain-decimal rule the TUI's and GUI's editors
 * apply (`Number()`), so the terminal admits exactly the spellings they do. Returns null for
 * text that is not a plain decimal, so the caller leaves it untouched (the config validator
 * owns the rest). */
function plainDecimalToJson(raw: string): string | null {
  return isPlainDecimal(raw) ? String(Number(raw)) : null;
}

/** `role`'s min-run-interval write flags: clear it, or set it to a second count (0 is
 * back-to-back). */
const CLEAR_MIN_RUN_INTERVAL_SPEC = { names: ["--clear-min-run-interval"] };
const MIN_RUN_INTERVAL_SPEC = { names: ["--min-run-interval"], value: true, valueName: "<seconds>" };

/** `role`'s instances write flags: clear the count, or set it to a parallel-runner count
 * (an integer from 1 to 8; only feature and bugfix split). */
const CLEAR_INSTANCES_SPEC = { names: ["--clear-instances"] };
const INSTANCES_SPEC = { names: ["--instances"], value: true, valueName: "<n>" };

/** `role`'s enabled-state write flags: enable or disable the role, written to
 * roles.<base>.enabled. */
const ENABLE_SPEC = { names: ["--enable"] };
const DISABLE_SPEC = { names: ["--disable"] };

/** `role`'s model-triple write flags: clear the field, or set it, written to
 * roles.<base>.provider/.model/.thinking. model and provider take an id; thinking takes a
 * pi `--thinking` level (off|minimal|low|medium|high|xhigh|max). */
const CLEAR_PROVIDER_SPEC = { names: ["--clear-provider"] };
const PROVIDER_SPEC = { names: ["--provider"], value: true, valueName: "<id>" };
const CLEAR_MODEL_SPEC = { names: ["--clear-model"] };
const MODEL_SPEC = { names: ["--model"], value: true, valueName: "<id>" };
const CLEAR_THINKING_SPEC = { names: ["--clear-thinking"] };
const THINKING_SPEC = { names: ["--thinking"], value: true, valueName: "<level>" };
const CLEAR_BACKEND_SPEC = { names: ["--clear-backend"] };
const BACKEND_SPEC = { names: ["--backend"], value: true, valueName: "<id>" };

/** Peel `tumwater role <id>`'s positional id off the argument list: the first token that is
 * neither a flag nor the value of a --role, --notes-file, --instructions-file,
 * --quiet-hours, --cap, --min-run-interval, --instances, --provider, --model,
 * --thinking or --backend flag. Returns the id (null when absent) and the remaining
 * arguments — flags only, ready for rejectUnknownArgs and sayJsonOrRender. The id may
 * also arrive as
 * --role <id>, the flag spelling every other role-targeting command shares; the
 * collector's caller rejects both spellings at once rather than silently picking one.
 * Lives here because it exists only for this one
 * command's mixed positional/flag vocabulary. */
function peelRolePositional(args: string[]): { id: string | null; rest: string[] } {
  const valueIdx = new Set<number>();
  for (const flag of ["--role", "--notes-file", "--instructions-file", "--quiet-hours", "--cap", "--min-run-interval", "--instances", "--provider", "--model", "--thinking", "--backend"]) {
    const at = args.indexOf(flag);
    if (at >= 0) valueIdx.add(at + 1);
  }
  let id: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    // A non-flag token that is not a value-taking flag's value is the positional,
    // taken once; everything else — flags and their values alike — rides in rest for
    // rejectUnknownArgs and flagValue to claim.
    if (!arg.startsWith("-") && id === null && !valueIdx.has(i)) {
      id = arg;
      continue;
    }
    rest.push(arg);
  }
  return { id, rest };
}

/** Refuse an unknown role id with the shared unknownRoleMessage wording before a per-role
 * config write resolves the id. Every `tumwater role` write branch starts with the same
 * prelude — load the config (falling back to defaultConfig so built-in roles resolve) and
 * throw the unknown-role error unless the id appears — so this keeps that check in one place.
 * The caller then derives `baseRoleOf(id)` for the write key. */
function requireKnownRole(root: string, id: string): void {
  const cfg = loadConfigSafe(root).config ?? defaultConfig();
  if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
}

/** Refuse the one mistake a per-role config write must reject up front: handing both a
 * set flag and its clear twin at once (e.g. `--model` with `--clear-model`). `setFlag`/
 * `clearFlag` are the exact spellings the refusal names (the clear twin is not always
 * `--clear` + the set flag — `--notes-file`'s twin is `--clear-notes`). The --json refusal
 * no longer lives here: the per-role hold writes (quiet hours, daily cap, min run interval,
 * instances) honor --json and print their own acknowledgement, while the prose-only writes
 * (notes, instructions, the model-override fields, enable/disable) each refuse it with
 * their own noun. Every set/clear write branch opens with the same two-line prelude, so
 * this keeps the set/clear-rival check in one place. */
function rejectSetAndClear(rest: string[], setFlag: string, clearFlag: string): void {
  if (rest.includes(setFlag) && rest.includes(clearFlag))
    fail(`give ${clearFlag} or ${setFlag}, not both`);
}

/** The config-key write the per-role hold branches (quiet hours, daily cap, min run
 * interval, instances, and the model-override fields) share: with `clear`, or an empty
 * typed value, unset `key` under `base`; else set it. `serialize` shapes the value
 * `setConfigKey` stores (it JSON-encodes nothing itself) and `display` gives the human
 * phrase for the confirmation line. The caller returns right after. The instructions branch
 * keeps its own block: its value is a file's text, so an empty value is a legitimate write,
 * not a clear. A no-op (a value the key already resolves to, or a clear of a key the file
 * never held) reports itself and writes nothing. With `json`, the confirmation is one
 * acknowledgement object in place of the prose line — a set prints
 * `{ command: "role", action: "set", role: base, key, status: "set" | "unchanged",
 * value }` (a no-op set is `unchanged`) and a clear prints `{ command: "role", action:
 * "clear", role: base, key, status: "cleared", oldValue }` (`not_set`, with no `oldValue`,
 * when the file never held the key) — so a script can hold a role without parsing the
 * prose. The prose line is the default; `json` only switches the output, never the write. */
function writeRoleConfigKey(
  root: string,
  base: string,
  clear: boolean,
  raw: string,
  key: string,
  noun: string,
  serialize: (value: string) => string,
  display: (value: string) => string,
  json: boolean,
): void {
  if (clear || raw.trim() === "") {
    const result = unsetConfigKey(root, key);
    if (!result.ok) fail(result.error);
    if (json) {
      sayJson(
        result.oldValue === undefined
          ? { command: "role", action: "clear", role: base, key, status: "not_set" }
          : { command: "role", action: "clear", role: base, key, status: "cleared", oldValue: result.oldValue },
      );
    } else {
      say(
        result.oldValue === undefined
          ? `${base}: ${noun} is not set in tumwater.json, so nothing was cleared`
          : `${base}: ${noun} cleared`,
      );
    }
  } else {
    const result = setConfigKey(root, key, serialize(raw));
    if (!result.ok) fail(result.error);
    if (json) {
      sayJson({ command: "role", action: "set", role: base, key, status: result.unchanged ? "unchanged" : "set", value: result.value });
    } else {
      say(
        result.unchanged
          ? `${base}: ${noun} is already ${display(raw)}, so tumwater.json was not written`
          : `${base}: ${noun} set to ${display(raw)}`,
      );
    }
  }
}

/** Resolve the role id from the positional and the --role flag: require one of them,
 * canonicalize it (legacy ids → spur/cvariant), and refuse both spellings at once with
 * the same wording. Split out of cmdRole so the collector's own body stays a thin
 * dispatch. */
function resolveRoleId(positional: string | null, flagId: string | null): string {
  const typedId = positional ?? flagId;
  if (!typedId) fail("tumwater role needs a role id");
  const id = canonicalRoleId(typedId);
  if (positional !== null && flagId !== null && flagId !== positional)
    fail("give the role id once — as the positional or as --role <id>, not both");
  return id;
}

/** `tumwater role <id>`'s notes/instructions text-write flag group: the two file-shaped
 * writes and their clear twins, with each write kind tallied in the notes-then-
 * instructions order the shared-invocation refusal names them. Owns the group's flag
 * spellings and write kinds; the rest of parseWriteFlags owns only the field and tally
 * order. */
function parseTextWriteFlags(rest: string[]): {
  fields: { notesWrite: boolean; clear: boolean; notesFile: string | null | undefined; instructionsWrite: boolean; clearInst: boolean; instFile: string | null | undefined };
  writes: string[];
} {
  const clear = rest.includes("--clear-notes");
  const notesFile = flagValue(rest, "--notes-file");
  const clearInst = rest.includes("--clear-instructions");
  const instFile = flagValue(rest, "--instructions-file");
  const notesWrite = clear || rest.includes("--notes-file");
  const instructionsWrite = clearInst || rest.includes("--instructions-file");
  const writes: string[] = [];
  if (notesWrite) writes.push("notes");
  if (instructionsWrite) writes.push("instructions");
  return { fields: { notesWrite, clear, notesFile, instructionsWrite, clearInst, instFile }, writes };
}

/** `tumwater role <id>`'s quiet-hours flag group: the window write and its clear twin,
 * owning the group's flag spellings and the single `quiet-hours` write kind. */
function parseQuietHoursFlag(rest: string[]): {
  fields: { quietWrite: boolean; clearQuiet: boolean };
  writes: string[];
} {
  const clearQuiet = rest.includes("--clear-quiet-hours");
  const quietWrite = clearQuiet || rest.includes("--quiet-hours");
  const writes: string[] = [];
  if (quietWrite) writes.push("quiet-hours");
  return { fields: { quietWrite, clearQuiet }, writes };
}

/** `tumwater role <id>`'s cap and min-run-interval flag group: the two per-role holds'
 * writes and their clear twins, with the write kinds tallied in the cap-then-
 * min-run-interval order the shared-invocation refusal names them. Owns the group's flag
 * spellings and write kinds. */
function parseCapAndIntervalFlags(rest: string[]): {
  fields: { capWrite: boolean; clearCap: boolean; intervalWrite: boolean; clearInterval: boolean };
  writes: string[];
} {
  const clearCap = rest.includes("--clear-cap");
  const clearInterval = rest.includes("--clear-min-run-interval");
  const capWrite = clearCap || rest.includes("--cap");
  const intervalWrite = clearInterval || rest.includes("--min-run-interval");
  const writes: string[] = [];
  if (capWrite) writes.push("cap");
  if (intervalWrite) writes.push("min-run-interval");
  return { fields: { capWrite, clearCap, intervalWrite, clearInterval }, writes };
}

/** `tumwater role <id>`'s instances flag group: the instance-count write and its clear
 * twin, owning the group's flag spellings and the single `instances` write kind. */
function parseInstancesFlag(rest: string[]): {
  fields: { instancesWrite: boolean; clearInstances: boolean };
  writes: string[];
} {
  const clearInstances = rest.includes("--clear-instances");
  const instancesWrite = clearInstances || rest.includes("--instances");
  const writes: string[] = [];
  if (instancesWrite) writes.push("instances");
  return { fields: { instancesWrite, clearInstances }, writes };
}

/** `tumwater role <id>`'s model-writing flag group: the provider/model/thinking/backend
 * writes and their clear twins, with the write kinds tallied in the provider, model,
 * thinking, backend order the shared-invocation refusal names them. Owns the group's flag
 * spellings and write kinds. */
function parseModelWriteFlags(rest: string[]): {
  fields: { providerWrite: boolean; clearProvider: boolean; modelWrite: boolean; clearModel: boolean; thinkingWrite: boolean; clearThinking: boolean; backendWrite: boolean; clearBackend: boolean };
  writes: string[];
} {
  const clearProvider = rest.includes("--clear-provider");
  const clearModel = rest.includes("--clear-model");
  const clearThinking = rest.includes("--clear-thinking");
  const clearBackend = rest.includes("--clear-backend");
  const providerWrite = clearProvider || rest.includes("--provider");
  const modelWrite = clearModel || rest.includes("--model");
  const thinkingWrite = clearThinking || rest.includes("--thinking");
  const backendWrite = clearBackend || rest.includes("--backend");
  const writes: string[] = [];
  if (providerWrite) writes.push("provider");
  if (modelWrite) writes.push("model");
  if (thinkingWrite) writes.push("thinking");
  if (backendWrite) writes.push("backend");
  return { fields: { providerWrite, clearProvider, modelWrite, clearModel, thinkingWrite, clearThinking, backendWrite, clearBackend }, writes };
}

/** `tumwater role <id>`'s enable/disable flag group: the two state writes, with the write
 * kinds tallied in the enable-then-disable order the shared-invocation refusal names
 * them. Owns the group's flag spellings and write kinds. */
function parseEnableWriteFlags(rest: string[]): {
  fields: { enable: boolean; disable: boolean };
  writes: string[];
} {
  const enable = rest.includes("--enable");
  const disable = rest.includes("--disable");
  const writes: string[] = [];
  if (enable) writes.push("enable");
  if (disable) writes.push("disable");
  return { fields: { enable, disable }, writes };
}

/** The flag-parse prelude of `tumwater role <id>`, split out of cmdRole so the collector
 * reads as a flat tally plus a dispatch. Given the flag-only rest (after rejectUnknownArgs
 * and the needs-a-value prelude have run), fold every write flag into its boolean clear
 * twin and its write-kind, tally the enabled write kinds in cmdRole's order, and return
 * the locals each write helper needs plus that tally. The parse delegates to six named
 * helpers — parseTextWriteFlags, parseQuietHoursFlag, parseCapAndIntervalFlags,
 * parseInstancesFlag, parseModelWriteFlags and parseEnableWriteFlags — each owning its
 * own flag spellings and write kinds; this body owns only the field order and the tally
 * order, the latter being the order the shared-invocation refusal names the writes in. Pure:
 * mutates nothing, only reads rest. The both-ids and needs-a-value refusals stay in
 * cmdRole before this runs, so they keep firing regardless of which write (or none) the
 * flags describe. */
function parseWriteFlags(rest: string[]) {
  const { fields: text, writes: textWrites } = parseTextWriteFlags(rest);
  const { fields: quiet, writes: quietWrites } = parseQuietHoursFlag(rest);
  const { fields: capInterval, writes: capIntervalWrites } = parseCapAndIntervalFlags(rest);
  const { fields: instances, writes: instancesWrites } = parseInstancesFlag(rest);
  const { fields: model, writes: modelWrites } = parseModelWriteFlags(rest);
  const { fields: enableDisable, writes: enableDisableWrites } = parseEnableWriteFlags(rest);
  return {
    ...text,
    ...quiet,
    ...capInterval,
    ...instances,
    ...model,
    ...enableDisable,
    writes: [...textWrites, ...quietWrites, ...instancesWrites, ...capIntervalWrites, ...modelWrites, ...enableDisableWrites],
  };
}

/** `tumwater role <id>`'s notes write: clear the note or replace it from --notes-file. The
 * director has no notes, so its id is refused before the known-role check; every other write
 * resolves the role, reads the file (or clears) and saves the note through saveRoleNote. */
function writeNotes(root: string, id: string, rest: string[], clear: boolean, notesFile: string): void {
  rejectSetAndClear(rest, "--notes-file", "--clear-notes");
  if (rest.includes("--json")) fail("--json does not apply to a notes write");
  if (id === DIRECTOR_ROLE) fail("the director has no notes");
  requireKnownRole(root, id);
  const text = clear ? "" : readPromptFileArg(notesFile || fail("--notes-file needs a path"));
  try {
    say(`${id}: ${saveRoleNote(roleNotesPath(root, id), text)}`);
  } catch (err) {
    fail(errorMessage(err));
  }
}

/** `tumwater role <id>`'s instructions-override write: the file-shaped twin of the notes
 * flags, but the value lands in roles.<base>.instructions (run-prompt reads
 * config.roles[base]) through the same setConfigKey/unsetConfigKey core `config
 * set`/`config unset` use, so validateConfig enforces the 4096-char cap and the write is
 * atomic. The director is allowed here (its override reaches its own runs), unlike the notes
 * branch's director refusal. */
function writeInstructions(root: string, id: string, rest: string[], clearInst: boolean, instFile: string): void {
  rejectSetAndClear(rest, "--instructions-file", "--clear-instructions");
  if (rest.includes("--json")) fail("--json does not apply to an instructions write");
  requireKnownRole(root, id);
  const base = baseRoleOf(id);
  if (clearInst) {
    const result = unsetConfigKey(root, `roles.${base}.instructions`);
    if (!result.ok) fail(result.error);
    say(`${base}: instructions cleared`);
  } else {
    const text = readPromptFileArg(instFile || fail("--instructions-file needs a path"));
    const result = setConfigKey(root, `roles.${base}.instructions`, JSON.stringify(text));
    if (!result.ok) fail(result.error);
    say(`${base}: instructions saved (${text.length} chars)`);
  }
}

/** `tumwater role <id>`'s quiet-hours write: the third write kind, the terminal twin of
 * `config set quietHoursPerRole.<base> <window>`. The window lands in
 * quietHoursPerRole.<base> through the same setConfigKey/unsetConfigKey core config
 * set/unset use, so checkQuietHours (with the typed key as its label) and validateConfig own
 * validation and the write is atomic. The director is exempt — its quietHoursPerRole.director
 * entry is inert (the gate and doctor both exempt it), like the notes branch's director
 * refusal. */
function writeQuietHours(root: string, id: string, rest: string[], clearQuiet: boolean, json: boolean): void {
  rejectSetAndClear(rest, "--quiet-hours", "--clear-quiet-hours");
  requireKnownRole(root, id);
  if (id === DIRECTOR_ROLE) fail("the director has no quiet hours");
  const base = baseRoleOf(id);
  const window = flagValue(rest, "--quiet-hours") ?? "";
  writeRoleConfigKey(root, base, clearQuiet, window, `quietHoursPerRole.${base}`, "quiet hours", (v) => JSON.stringify(v), (v) => v, json);
}

/** `tumwater role <id>`'s daily-cap write: the terminal twin of `config set
 * maxDailyCostUsdPerRole.<base> <usd>`, the two remaining per-role holds' write the
 * dashboard and the TUI already own. The value lands in maxDailyCostUsdPerRole.<base>
 * through the same setConfigKey/unsetConfigKey core `config set`/`config unset` use, so
 * checkDailyBudgetUsd (with the typed key as its label) and validateConfig own validation
 * and the write is atomic. The director is exempt — it has no cap, like the notes and
 * quiet-hours branches' director refusals. */
function writeDailyCap(root: string, id: string, rest: string[], clearCap: boolean, json: boolean): void {
  rejectSetAndClear(rest, "--cap", "--clear-cap");
  requireKnownRole(root, id);
  if (id === DIRECTOR_ROLE) fail("the director has no daily cap");
  const base = baseRoleOf(id);
  const cfgKey = `maxDailyCostUsdPerRole.${base}`;
  const cap = flagValue(rest, "--cap") ?? "";
  // Shape, before the write: a spelling that is not a plain decimal but that JSON.parse
  // would still read as a non-negative USD amount (an exponent like "1e2" → 100) would
  // otherwise sail past both plainDecimalToJson (which only rewrites JSON-unparseable
  // spellings like `05`) and checkDailyBudgetUsd's non-negative check and silently write
  // the misread — the same silent misread the TUI Ctrl+B budget editor and the GUI cap
  // drawer now reject. Every non-exponent spelling JSON reads as a non-negative USD is
  // already a plain decimal, so the exponent form is exactly the silent-write set; hex,
  // negative and non-numeric spellings fall through to the write path, whose
  // validateConfig message names the key.
  if (isExponentSpelling(cap.trim()))
    fail(`${cfgKey} must be a plain dollar amount like 25, 12.50, or .5 — no +/-, exponent, or hex notation`);
  writeRoleConfigKey(root, base, clearCap, cap, cfgKey, "daily cap", (v) => plainDecimalToJson(v) ?? v, (v) => v, json);
}

/** `tumwater role <id>`'s min-run-interval write: the terminal twin of `config set
 * roles.<base>.minRunIntervalSeconds <seconds>`, the fourth per-role hold's write. The
 * value lands in roles.<base>.minRunIntervalSeconds through the same
 * setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
 * roles.<id>.minRunIntervalSeconds DURATION_NON_NEGATIVE check owns validation and the
 * write is atomic. Unlike the notes/quiet-hours/cap branches there is no director refusal:
 * the director runs on the same clock. */
function writeMinRunInterval(root: string, id: string, rest: string[], clearInterval: boolean, json: boolean): void {
  rejectSetAndClear(rest, "--min-run-interval", "--clear-min-run-interval");
  requireKnownRole(root, id);
  const base = baseRoleOf(id);
  const cfgKey = `roles.${base}.minRunIntervalSeconds`;
  const secs = flagValue(rest, "--min-run-interval") ?? "";
  // Shape, before the write: a spelling that is not a plain decimal but that JSON.parse
  // would still read as a non-negative second count (an exponent like "1e2" → 100) would
  // otherwise sail past both plainDecimalToJson (which only rewrites JSON-unparseable
  // spellings like `05`) and validateConfig's non-negative check and silently write the
  // misread — the same silent misread the TUI Ctrl+S editor and the GUI interval drawer
  // now reject. Every non-exponent spelling JSON reads as a non-negative count is already a
  // plain decimal, so the exponent form is exactly the silent-write set; hex, negative and
  // non-numeric spellings fall through to the write path, whose validateConfig message
  // names the key.
  if (isExponentSpelling(secs.trim()))
    fail(`${cfgKey} must be a plain second count like 300, 0.5, or .5 — no +/-, exponent, or hex notation`);
  writeRoleConfigKey(root, base, clearInterval, secs, cfgKey, "min run interval", (v) => plainDecimalToJson(v) ?? v, (v) => `${v}s`, json);
}

/** `tumwater role <id>`'s instances write: the terminal twin of `config set
 * roles.<base>.instances <n>`, the last per-role hold's write. The count lands in
 * roles.<base>.instances through the same setConfigKey/unsetConfigKey core `config
 * set`/`config unset` use, so validateConfig's roles.<id>.instances INSTANCE_COUNT check
 * owns the bound and the write is atomic. As with min run interval there is no director (or
 * non-instance-role) refusal of its own: validateConfig's `!INSTANCE_ROLES.has(id)` branch
 * answers for the director and every custom role, and an unset/empty value clears the key. */
function writeInstances(root: string, id: string, rest: string[], clearInstances: boolean, json: boolean): void {
  rejectSetAndClear(rest, "--instances", "--clear-instances");
  const loaded = loadConfigSafe(root);
  const cfg = loaded.config ?? defaultConfig();
  if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
  const base = baseRoleOf(id);
  const cfgKey = `roles.${base}.instances`;
  const n = flagValue(rest, "--instances") ?? "";
  // Shape, before the write: a spelling that is not a plain integer but that JSON.parse
  // would still read as a 1–8 count (an exponent like "2e0" → 2) would otherwise sail past
  // both plainDecimalToJson and validateConfig's INSTANCE_COUNT integer check and silently
  // write the misread — the same silent misread the cap and min-run-interval writes refuse.
  // Every non-exponent spelling that JSON reads as an integer in range is already a plain
  // integer, so the exponent form is exactly the silent-write set; every exponent — in range
  // or out ("9e0" → 9 too) — is refused here, while fractional, hex, negative and plain
  // out-of-range integer spellings fall through to the write path, whose validateConfig
  // message names the key.
  if (isExponentSpelling(n.trim()))
    fail(`${cfgKey} must be a plain integer from 1 to 8 — no exponent notation`);
  // An absent count already means 1 (instanceCount's default), so asking for 1 is a no-op —
  // but only for a role that may split; any other role falls through to validateConfig's refusal.
  // A tumwater.json that fails to load is no basis for "already": fall through to the failure.
  if (loaded.config && !clearInstances && n.trim() === "1" && INSTANCE_ROLES.has(base) && cfg.roles[base]?.instances === undefined) {
    if (json)
      sayJson({ command: "role", action: "set", role: base, key: cfgKey, status: "unchanged", value: 1 });
    else say(`${base}: instances is already 1, so tumwater.json was not written`);
    return;
  }
  writeRoleConfigKey(root, base, clearInstances, n, `roles.${base}.instances`, "instances", (v) => v, (v) => v, json);
}

/** `tumwater role <id>`'s model-writing branches — provider, model, thinking and backend —
 * are one shape: each lands the role's field in roles.<base>.<field> (the terminal twin of
 * `config set roles.<base>.<field> <value>` and `config unset`) through the same
 * setConfigKey/unsetConfigKey core, so validateConfig owns the id — checkModelTripleField
 * ("tier-name" shape: model accepts a tier name, thinking a THINKING_LEVELS level) for the
 * provider/model/thinking fields that configForRole resolves through seamOverrides,
 * checkEntryBackend for backend (`pi`, `claude`, `opencode` or `codex`, refusing an unknown
 * one and a model that cannot pair with it) — and each write is atomic. No director refusal:
 * each is accepted exactly as --min-run-interval is, and an instance id writes its base
 * role's key. Every branch calls writeRoleConfigKey with the same JSON-encode/identity
 * shaping, differing only in the flag spellings, the key field and the noun the confirmation
 * line names — one table, one body. */
function writeModelField(root: string, id: string, rest: string[], field: string, clear: boolean, flag: string, clearFlag: string, noun: string): void {
  rejectSetAndClear(rest, flag, clearFlag);
  if (rest.includes("--json")) fail(`--json does not apply to a ${noun} write`);
  requireKnownRole(root, id);
  const base = baseRoleOf(id);
  const value = flagValue(rest, flag) ?? "";
  writeRoleConfigKey(root, base, clear, value, `roles.${base}.${field}`, noun, (v) => JSON.stringify(v), (v) => v, false);
}

/** `tumwater role <id>`'s enable/disable write: the scoped write for the enabled state
 * `tumwater role <id>` already renders, the terminal twin of `config set
 * roles.<base>.enabled true|false`. The value lands in roles.<base>.enabled through the same
 * setConfigKey core config set uses, so validateConfig's checkBoolean (the roles.<id>.
 * prefix) owns the type and the write stays atomic and applies live. The director cannot be
 * disabled: with it disabled runnerIds omits it and no role dequeues the operator's inbox,
 * so that refusal is explicit (enabling stays allowed). knownRoleIds holds every catalog and
 * custom role whether or not it is enabled, so a currently-disabled id resolves; an instance
 * id writes its base role's key. A role already in the asked-for state is reported as such
 * and the file is left alone. */
function writeEnableDisable(root: string, id: string, rest: string[], enable: boolean, disable: boolean): void {
  if (rest.includes("--json")) fail("--json does not apply to an enable/disable write");
  requireKnownRole(root, id);
  if (disable && id === DIRECTOR_ROLE) fail("the director cannot be disabled");
  const base = baseRoleOf(id);
  const state = enable ? "enabled" : "disabled";
  if (loadConfigSafe(root).config?.roles[base]?.enabled === enable) {
    say(`${base}: already ${state}`);
    return;
  }
  const result = setConfigKey(root, `roles.${base}.enabled`, enable ? "true" : "false");
  if (!result.ok) fail(result.error);
  say(`${base}: ${state}`);
}

/** `tumwater role <id>`: one role's standing prompt and next run's assembled prompt, with
 * `-f/--follow` repainting it until Ctrl+C or the parent process exits. The follow is the
 * read-only form: `--json` and every write flag keep their one-shot forms and are refused
 * with it, so no repaint can write config repeatedly. */
export async function cmdRole(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // No requireReadyRepo gate, like backlog: role-view degrades (missing state files →
  // fresh defaults, a missing queue directory an empty inbox), so the command inspects
  // a repo the team never started in — and a torn one — instead of refusing (a team
  // workspace still refuses).
  const { id: positional, rest } = peelRolePositional(args);
  // A value-taking write flag immediately followed by a `--`-flag means the operator forgot its
  // value: `role qa --model --json` (or `--model --provider pi`, `--model --thinking high`)
  // would otherwise take the next flag as the model id and fail later (or in
  // rejectUnknownArgs) with a confusing message ("--json does not apply to a model write",
  // "unknown argument: y") instead of naming the actual slip. Refuse up front with the flag's
  // own needs-a-value wording — the same spirit as `config set`'s flag-looking-value guard.
  // Only a `--` (double-dash) token reads as a flag: a single-dash token like `-1` is a
  // negative-number value that must reach the setters' own bound checks, and a single-dash
  // `-` stdin value (the file flags' `-`) is left to the readers.
  for (const flag of ["--provider", "--model", "--thinking", "--backend", "--cap", "--min-run-interval", "--instances", "--quiet-hours", "--notes-file", "--instructions-file"]) {
    const at = rest.indexOf(flag);
    const next = at >= 0 ? rest[at + 1] : undefined;
    if (next?.startsWith("--"))
      fail(`${flag} needs a value (the next token ${JSON.stringify(next)} is a flag, not a value)`);
  }
  rejectUnknownArgs("role", rest, [ROLE_FLAG, JSON_FLAG, FOLLOW_FLAG, CLEAR_NOTES_SPEC, NOTES_FILE_SPEC, CLEAR_INSTRUCTIONS_SPEC, INSTRUCTIONS_FILE_SPEC, CLEAR_QUIET_HOURS_SPEC, QUIET_HOURS_SPEC, ENABLE_SPEC, DISABLE_SPEC, CLEAR_CAP_SPEC, CAP_SPEC, CLEAR_MIN_RUN_INTERVAL_SPEC, MIN_RUN_INTERVAL_SPEC, CLEAR_INSTANCES_SPEC, INSTANCES_SPEC, CLEAR_PROVIDER_SPEC, PROVIDER_SPEC, CLEAR_MODEL_SPEC, MODEL_SPEC, CLEAR_THINKING_SPEC, THINKING_SPEC, CLEAR_BACKEND_SPEC, BACKEND_SPEC]);
  refuseTeamWorkspace(root);
  // The id is required: positional (`tumwater role <id>`) or --role <id> (the flag
  // spelling every other role-targeting command shares). Both at once is a mistake, not
  // a silent pick of one.
  const flagId = flagValue(rest, "--role") ?? null;
  const id = resolveRoleId(positional, flagId);
  const f = parseWriteFlags(rest);
  if (f.writes.length > 1)
    fail(`${f.writes.join(" and ")} writes cannot share one invocation`);
  const follow = hasFollowFlag(rest);
  // The live form is read-only: a JSON document is one snapshot, not a repaint, and a write
  // flag would repeat its write every couple of seconds — refuse each before any output, the
  // shared wording the sibling follow views use for the same conflicts.
  if (follow) {
    if (rest.includes("--json")) failFollowJsonRival("role --json");
    if (f.writes.length > 0) fail(`-f/--follow repaints the role read-only; ${f.writes[0]} writes — drop one of them`);
  }
  if (f.writes.length === 0) {
    if (follow) {
      // Outside the loop, so an unknown id throws the one-shot form's unknownRoleMessage
      // once instead of being swallowed frame by frame by followView's per-frame catch. Each
      // frame re-reads config, runner state, events and notes, so the role's last run, spend
      // and next-run schedule are current; followView ends on Ctrl+C or the parent's death
      // returning normally, leaving process.exitCode untouched.
      rolePayload(root, id);
      await followView(() => renderRoleMarkdown(rolePayload(root, id)), seams);
      return;
    }
    // The unknown-role answer (exit 1, unknownRoleMessage's wording) lives in the
    // collector; here the id just has to be non-null for the thunk's types.
    sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown);
    return;
  }
  // Exactly one write kind is active (refused above if more), so dispatch on it by name. The
  // per-write logic lives in the named helpers below; these closures only wire the args.
  const dispatch: Record<string, () => void> = {
    notes: () => writeNotes(root, id, rest, f.clear, f.notesFile ?? ""),
    instructions: () => writeInstructions(root, id, rest, f.clearInst, f.instFile ?? ""),
    "quiet-hours": () => writeQuietHours(root, id, rest, f.clearQuiet, rest.includes("--json")),
    cap: () => writeDailyCap(root, id, rest, f.clearCap, rest.includes("--json")),
    "min-run-interval": () => writeMinRunInterval(root, id, rest, f.clearInterval, rest.includes("--json")),
    instances: () => writeInstances(root, id, rest, f.clearInstances, rest.includes("--json")),
    provider: () => writeModelField(root, id, rest, "provider", f.clearProvider, "--provider", "--clear-provider", "provider"),
    model: () => writeModelField(root, id, rest, "model", f.clearModel, "--model", "--clear-model", "model"),
    thinking: () => writeModelField(root, id, rest, "thinking", f.clearThinking, "--thinking", "--clear-thinking", "thinking"),
    backend: () => writeModelField(root, id, rest, "backend", f.clearBackend, "--backend", "--clear-backend", "backend"),
    enable: () => writeEnableDisable(root, id, rest, true, false),
    disable: () => writeEnableDisable(root, id, rest, false, true),
  };
  const first = f.writes[0]!;
  dispatch[first]!();
}
