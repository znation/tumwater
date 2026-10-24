/** `tumwater role <id>`'s command body, split out of cli-query-commands.ts so that module
 * keeps only the read-only query commands (status, diff, queue, backlog). cli.ts's dispatcher
 * routes to cmdRole here exactly as it routes cmdStatus to cli-query-commands or cmdConfig to
 * config-commands. cmdRole is the one query-named command that also writes: it renders a
 * role's standing and next-run prompts and carries ten per-role write flags (notes,
 * instructions, quiet-hours, daily cap, min-run-interval, instances, enable/disable, and the
 * provider/model/thinking triple), each through the same setConfigKey/unsetConfigKey core
 * `config set`/`config unset` use. It lives in its own file because its mixed
 * positional/flag vocabulary and its write branches are its own, not the query commands'. */

import { fail, say, sayJsonOrRender } from "./cli-output.js";
import { flagValue } from "./cli-args.js";
import { JSON_FLAG, ROLE_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { defaultConfig, knownRoleIds, loadConfigSafe } from "../config/config.js";
import { rolePayload } from "../roles/role-view.js";
import { renderRoleMarkdown } from "../roles/role-render.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../roles/roles.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { readPromptFileArg } from "./cli-command-args.js";
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
  return /^\d*\.?\d+$/.test(raw) ? String(Number(raw)) : null;
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

/** Peel `tumwater role <id>`'s positional id off the argument list: the first token that is
 * neither a flag nor the value of a --role, --notes-file, --instructions-file,
 * --quiet-hours, --cap, --min-run-interval, --instances, --provider, --model or
 * --thinking flag. Returns the id (null when absent) and the remaining arguments — flags
 * only, ready for rejectUnknownArgs and sayJsonOrRender. The id may also arrive as
 * --role <id>, the flag spelling every other role-targeting command shares; the
 * collector's caller rejects both spellings at once rather than silently picking one.
 * Lives here because it exists only for this one
 * command's mixed positional/flag vocabulary. */
function peelRolePositional(args: string[]): { id: string | null; rest: string[] } {
  const valueIdx = new Set<number>();
  for (const flag of ["--role", "--notes-file", "--instructions-file", "--quiet-hours", "--cap", "--min-run-interval", "--instances", "--provider", "--model", "--thinking"]) {
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

/** The config-key write the six per-role hold branches (quiet hours, daily cap, min run
 * interval, provider, model and thinking) share: with `clear`, or an empty typed value, unset
 * `key` under `base`; else set it. `serialize` shapes the value `setConfigKey` stores (it
 * JSON-encodes nothing itself) and `display` gives the human phrase for the confirmation
 * line. The caller returns right after. The instructions branch keeps its own block: its
 * value is a file's text, so an empty value is a legitimate write, not a clear. A no-op (a
 * value the key already resolves to, or a clear of a key the file never held) reports itself
 * and writes nothing. */
function writeRoleConfigKey(
  root: string,
  base: string,
  clear: boolean,
  raw: string,
  key: string,
  noun: string,
  serialize: (value: string) => string,
  display: (value: string) => string,
): void {
  if (clear || raw.trim() === "") {
    const result = unsetConfigKey(root, key);
    if (!result.ok) fail(result.error);
    say(
      result.oldValue === undefined
        ? `${base}: ${noun} is not set in tumwater.json, so nothing was cleared`
        : `${base}: ${noun} cleared`,
    );
  } else {
    const result = setConfigKey(root, key, serialize(raw));
    if (!result.ok) fail(result.error);
    say(
      result.unchanged
        ? `${base}: ${noun} is already ${display(raw)}, so tumwater.json was not written`
        : `${base}: ${noun} set to ${display(raw)}`,
    );
  }
}

/** `tumwater role <id>`: one role's standing prompt and next run's assembled prompt. */
export async function cmdRole(root: string, args: string[]): Promise<void> {
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
  // negative-number value that must reach the setters' own bound checks, and the file flags'
  // `-` stdin value is not in this set at all.
  for (const flag of ["--provider", "--model", "--thinking", "--cap", "--min-run-interval", "--instances", "--quiet-hours"]) {
    const at = rest.indexOf(flag);
    const next = at >= 0 ? rest[at + 1] : undefined;
    if (next?.startsWith("--"))
      fail(`${flag} needs a value (the next token ${JSON.stringify(next)} is a flag, not a value)`);
  }
  rejectUnknownArgs("role", rest, [ROLE_FLAG, JSON_FLAG, CLEAR_NOTES_SPEC, NOTES_FILE_SPEC, CLEAR_INSTRUCTIONS_SPEC, INSTRUCTIONS_FILE_SPEC, CLEAR_QUIET_HOURS_SPEC, QUIET_HOURS_SPEC, ENABLE_SPEC, DISABLE_SPEC, CLEAR_CAP_SPEC, CAP_SPEC, CLEAR_MIN_RUN_INTERVAL_SPEC, MIN_RUN_INTERVAL_SPEC, CLEAR_INSTANCES_SPEC, INSTANCES_SPEC, CLEAR_PROVIDER_SPEC, PROVIDER_SPEC, CLEAR_MODEL_SPEC, MODEL_SPEC, CLEAR_THINKING_SPEC, THINKING_SPEC]);
  refuseTeamWorkspace(root);
  // The id is required: positional (`tumwater role <id>`) or --role <id> (the flag
  // spelling every other role-targeting command shares). Both at once is a mistake, not
  // a silent pick of one.
  const flagId = flagValue(rest, "--role") ?? null;
  const typedId = positional ?? flagId;
  if (!typedId) fail("tumwater role needs a role id");
  const id = canonicalRoleId(typedId);
  if (positional !== null && flagId !== null && flagId !== positional)
    fail("give the role id once — as the positional or as --role <id>, not both");
  const clear = rest.includes("--clear-notes");
  const notesFile = flagValue(rest, "--notes-file");
  const clearInst = rest.includes("--clear-instructions");
  const instFile = flagValue(rest, "--instructions-file");
  const clearQuiet = rest.includes("--clear-quiet-hours");
  const clearCap = rest.includes("--clear-cap");
  const clearInterval = rest.includes("--clear-min-run-interval");
  const clearInstances = rest.includes("--clear-instances");
  const clearProvider = rest.includes("--clear-provider");
  const clearModel = rest.includes("--clear-model");
  const clearThinking = rest.includes("--clear-thinking");
  const notesWrite = clear || rest.includes("--notes-file");
  const instructionsWrite = clearInst || rest.includes("--instructions-file");
  const quietWrite = clearQuiet || rest.includes("--quiet-hours");
  const capWrite = clearCap || rest.includes("--cap");
  const intervalWrite = clearInterval || rest.includes("--min-run-interval");
  const instancesWrite = clearInstances || rest.includes("--instances");
  const providerWrite = clearProvider || rest.includes("--provider");
  const modelWrite = clearModel || rest.includes("--model");
  const thinkingWrite = clearThinking || rest.includes("--thinking");
  const enable = rest.includes("--enable");
  const disable = rest.includes("--disable");
  const writes: string[] = [];
  if (notesWrite) writes.push("notes");
  if (instructionsWrite) writes.push("instructions");
  if (quietWrite) writes.push("quiet-hours");
  if (instancesWrite) writes.push("instances");
  if (capWrite) writes.push("cap");
  if (intervalWrite) writes.push("min-run-interval");
  if (providerWrite) writes.push("provider");
  if (modelWrite) writes.push("model");
  if (thinkingWrite) writes.push("thinking");
  if (enable) writes.push("enable");
  if (disable) writes.push("disable");
  if (writes.length > 1)
    fail(`${writes.join(" and ")} writes cannot share one invocation`);
  if (notesWrite) {
    if (clear && rest.includes("--notes-file")) fail("give --clear-notes or --notes-file, not both");
    if (rest.includes("--json")) fail("--json does not apply to a notes write");
    if (id === DIRECTOR_ROLE) fail("the director has no notes");
    requireKnownRole(root, id);
    const text = clear ? "" : readPromptFileArg(notesFile || fail("--notes-file needs a path"));
    try {
      say(`${id}: ${saveRoleNote(roleNotesPath(root, id), text)}`);
    } catch (err) {
      fail(errorMessage(err));
    }
    return;
  }
  // The instructions-override write: the file-shaped twin of the notes flags, but the value
  // lands in roles.<base>.instructions (run-prompt reads config.roles[base]) through the
  // same setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig
  // enforces the 4096-char cap and the write is atomic. The director is allowed here (its
  // override reaches its own runs), unlike the notes branch's director refusal.
  if (instructionsWrite) {
    if (clearInst && rest.includes("--instructions-file")) fail("give --clear-instructions or --instructions-file, not both");
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
    return;
  }
  // The quiet-hours write: the third write kind, the terminal twin of `config set
  // quietHoursPerRole.<base> <window>`. The window lands in quietHoursPerRole.<base> through
  // the same setConfigKey/unsetConfigKey core config set/unset use, so checkQuietHours (with
  // the typed key as its label) and validateConfig own validation and the write is atomic.
  // The director is exempt — its quietHoursPerRole.director entry is inert (the gate and
  // doctor both exempt it), like the notes branch's director refusal.
  if (quietWrite) {
    if (clearQuiet && rest.includes("--quiet-hours")) fail("give --clear-quiet-hours or --quiet-hours, not both");
    if (rest.includes("--json")) fail("--json does not apply to a quiet-hours write");
    requireKnownRole(root, id);
    if (id === DIRECTOR_ROLE) fail("the director has no quiet hours");
    const base = baseRoleOf(id);
    const window = flagValue(rest, "--quiet-hours") ?? "";
    writeRoleConfigKey(root, base, clearQuiet, window, `quietHoursPerRole.${base}`, "quiet hours", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  // The daily-cap write: the terminal twin of `config set maxDailyCostUsdPerRole.<base>
  // <usd>`, the two remaining per-role holds' write the dashboard and the TUI already own.
  // The value lands in maxDailyCostUsdPerRole.<base> through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so checkDailyBudgetUsd
  // (with the typed key as its label) and validateConfig own validation and the write is
  // atomic. The director is exempt — it has no cap, like the notes and quiet-hours branches'
  // director refusals.
  if (capWrite) {
    if (clearCap && rest.includes("--cap")) fail("give --clear-cap or --cap, not both");
    if (rest.includes("--json")) fail("--json does not apply to a cap write");
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
    if (cap.trim() !== "" && plainDecimalToJson(cap) === null && /^\d+(\.\d+)?[eE][+-]?\d+$/.test(cap.trim()))
      fail(`${cfgKey} must be a plain dollar amount like 25, 12.50, or .5 — no +/-, exponent, or hex notation`);
    writeRoleConfigKey(root, base, clearCap, cap, cfgKey, "daily cap", (v) => plainDecimalToJson(v) ?? v, (v) => v);
    return;
  }
  // The min-run-interval write: the terminal twin of `config set
  // roles.<base>.minRunIntervalSeconds <seconds>`, the fourth per-role hold's write. The
  // value lands in roles.<base>.minRunIntervalSeconds through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
  // roles.<id>.minRunIntervalSeconds DURATION_NON_NEGATIVE check owns validation and the
  // write is atomic. Unlike the notes/quiet-hours/cap branches there is no director refusal:
  // the director runs on the same clock.
  if (intervalWrite) {
    if (clearInterval && rest.includes("--min-run-interval")) fail("give --clear-min-run-interval or --min-run-interval, not both");
    if (rest.includes("--json")) fail("--json does not apply to a min-run-interval write");
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
    if (secs.trim() !== "" && plainDecimalToJson(secs) === null && /^\d+(\.\d+)?[eE][+-]?\d+$/.test(secs.trim()))
      fail(`${cfgKey} must be a plain second count like 300, 0.5, or .5 — no +/-, exponent, or hex notation`);
    writeRoleConfigKey(root, base, clearInterval, secs, cfgKey, "min run interval", (v) => plainDecimalToJson(v) ?? v, (v) => `${v}s`);
    return;
  }
  // The instances write: the terminal twin of `config set roles.<base>.instances <n>`, the
  // last per-role hold's write. The count lands in roles.<base>.instances through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
  // roles.<id>.instances INSTANCE_COUNT check owns the bound and the write is atomic. As
  // with min run interval there is no director (or non-instance-role) refusal of its own:
  // validateConfig's `!INSTANCE_ROLES.has(id)` branch answers for the director and every
  // custom role, and an unset/empty value clears the key.
  if (instancesWrite) {
    if (clearInstances && rest.includes("--instances")) fail("give --clear-instances or --instances, not both");
    if (rest.includes("--json")) fail("--json does not apply to an instances write");
    const loaded = loadConfigSafe(root);
    const cfg = loaded.config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const n = flagValue(rest, "--instances") ?? "";
    // An absent count already means 1 (instanceCount's default), so asking for 1 is a no-op —
    // but only for a role that may split; any other role falls through to validateConfig's refusal.
    // A tumwater.json that fails to load is no basis for "already": fall through to the failure.
    if (loaded.config && !clearInstances && n.trim() === "1" && INSTANCE_ROLES.has(base) && cfg.roles[base]?.instances === undefined) {
      say(`${base}: instances is already 1, so tumwater.json was not written`);
      return;
    }
    writeRoleConfigKey(root, base, clearInstances, n, `roles.${base}.instances`, "instances", (v) => v, (v) => v);
    return;
  }
  // The model-triple writes: the terminal twins of `config set roles.<base>.provider|model|thinking
  // <value>` and `config unset` — the three fields configForRole resolves through seamOverrides.
  // `tumwater role <id>` renders them as its Model: line. Each lands in roles.<base>.<field>.
  // Through setConfigKey/unsetConfigKey, validateConfig's checkModelTripleField ("tier-name"
  // shape) owns validation (model accepts a tier name; thinking must be a THINKING_LEVELS level)
  // and each write is atomic. No director refusal: accepted exactly as --min-run-interval is.
  if (providerWrite) {
    if (clearProvider && rest.includes("--provider")) fail("give --clear-provider or --provider, not both");
    if (rest.includes("--json")) fail("--json does not apply to a provider write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const provider = flagValue(rest, "--provider") ?? "";
    writeRoleConfigKey(root, base, clearProvider, provider, `roles.${base}.provider`, "provider", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  if (modelWrite) {
    if (clearModel && rest.includes("--model")) fail("give --clear-model or --model, not both");
    if (rest.includes("--json")) fail("--json does not apply to a model write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const model = flagValue(rest, "--model") ?? "";
    writeRoleConfigKey(root, base, clearModel, model, `roles.${base}.model`, "model", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  if (thinkingWrite) {
    if (clearThinking && rest.includes("--thinking")) fail("give --clear-thinking or --thinking, not both");
    if (rest.includes("--json")) fail("--json does not apply to a thinking write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const level = flagValue(rest, "--thinking") ?? "";
    writeRoleConfigKey(root, base, clearThinking, level, `roles.${base}.thinking`, "thinking", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  // The enable/disable write: the scoped write for the enabled state `tumwater role <id>`
  // already renders, the terminal twin of `config set roles.<base>.enabled true|false`. The
  // value lands in roles.<base>.enabled through the same setConfigKey core config set uses, so
  // validateConfig's checkBoolean (the roles.<id>. prefix) owns the type and the write stays
  // atomic and applies live. The director cannot be disabled: with it disabled runnerIds omits
  // it and no role dequeues the operator's inbox, so that refusal is explicit (enabling stays
  // allowed). knownRoleIds holds every catalog and custom role whether or not it is enabled, so
  // a currently-disabled id resolves; an instance id writes its base role's key. A role already
  // in the asked-for state is reported as such and the file is left alone.
  if (enable || disable) {
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
    return;
  }
  // The unknown-role answer (exit 1, unknownRoleMessage's wording) lives in the
  // collector; here the id just has to be non-null for the thunk's types.
  sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown);
}
