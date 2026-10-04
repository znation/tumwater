/** The declarative flag-vocabulary layer shared by every command's argument gate: the
 * FlagSpec shape, the per-flag specs (ROLE_FLAG, DURATION_FLAG, REASON_FLAG, sinceFlagSpec,
 * N_FLAG, JSON_FLAG, grepFlagSpec, RUN_FLAG_SPECS), and the unknown-argument gate
 * (rejectUnknownArgs, with rejectEqualsForm). Split from cli-args.ts, whose imperative
 * single-flag parsers (flagValue, parseCountFlag, parseDurationFlag, parseRoleFlag, ...)
 * stay there — one module per layer, so the vocabulary a command accepts and the parsers
 * its body re-runs are related by import rather than mixed in one file. The gate runs in
 * cli.ts before the ready-repo gate and every command body, so a bad flag (misspelled,
 * duplicated, missing or malformed value, equals-form spelling) fails fast with an
 * actionable message instead of the command silently running with default behavior. */
import { fail } from "./cli-output.js";
import { parseCountFlag, parseDurationFlag } from "./cli-args.js";
export interface FlagSpec {
  /** Every accepted spelling, e.g. ["-f", "--follow"]. */
  names: string[];
  /** True when the flag consumes one following token as its value. */
  value?: boolean;
  /** How the value is named in error messages (e.g. "<id>"); defaults to "<value>". */
  valueName?: string;
  /** The error when the flag appears as the last argument with no value. Defaults to
   * `<first spelling> needs a value`, what the generic parse helpers (parseCountFlag,
   * parsePortFlag, parseDurationFlag) print; set it when the command's own parser phrases
   * the missing value more specifically, so this gate's early report — it runs before the
   * ready-repo gate and every command body — says exactly what that parser would have said. */
  missingValue?: string;
  /** Validate the flag's value SHAPE at the gate: call the same pure parse helper the
   * command body re-runs (parseCountFlag, parsePortFlag, parseDurationFlag) so a malformed
   * value (`--since bogus`, `-n 0`, `--port abc`) is named with the parser's own wording
   * before the ready-repo gate can mask it behind "not a git repository" — the same early
   * report missingValue gives the no-value case. Shape only: caps and rival-flag rules stay
   * in the command body, which orders them against its other flags deliberately. The body
   * re-running the identical pure helper cannot drift from what the gate accepted. */
  validate?: (value: string) => void;
}

/** One command's accepted flag list as error-message text (`--file <path>, --branch <name>, …`),
 * derived from the specs — the one home of the rendering, so the lists the error messages
 * print cannot drift from the vocabulary they name. */
function validFlagsList(specs: readonly FlagSpec[]): string {
  return specs
    .map((s) => s.names.join("/") + (s.value ? ` ${s.valueName ?? "<value>"}` : ""))
    .join(", ");
}

/** The unknown-double-dash gate for the two parsers whose positionals are free-form text
 * (init's brief, prompt's message) and therefore cannot use rejectUnknownArgs wholesale:
 * each `--`-prefixed token must be a known flag spelling or it fails with the same
 * "unknown argument … (valid flags for tumwater CMD: …)" wording rejectUnknownArgs prints,
 * the list derived from the specs so adding a flag admits it everywhere at once. Equals-form
 * spellings of known flags fail first with rejectEqualsForm's message, as the generic gate
 * does. Non-double-dash tokens pass through untouched (the caller decides what they mean —
 * prompt content or a positional). Two call sites: parseInitArgs and parsePromptArgs. */
export function rejectUnknownDoubleDash(
  command: string,
  args: readonly string[],
  specs: readonly FlagSpec[],
): void {
  const known = new Set(specs.flatMap((s) => s.names));
  for (const arg of args) {
    rejectEqualsForm(arg, specs);
    if (arg.startsWith("--") && !known.has(arg)) failUnknownArgument(command, arg, specs);
  }
}

/** The one refusal for a token naming no known flag: the generic wording both the spec-parsed
 * gate (rejectUnknownArgs) and the free-form parsers' double-dash gate
 * (rejectUnknownDoubleDash) print, so the message cannot drift between the two gates. */
function failUnknownArgument(command: string, arg: string, specs: readonly FlagSpec[]): never {
  fail(`unknown argument: ${arg} (valid flags for tumwater ${command}: ${validFlagsList(specs)})`);
}

/** A `--flag=value` token's flag name ("--role" from "--role=feature"), or null when the
 * token is not in equals form. "--=x" and bare "--" carry no flag name and stay null. */
function equalsFormFlag(arg: string): string | null {
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  return eq > 2 ? arg.slice(0, eq) : null;
}

/** The one refusal for the `--flag=value` spelling this CLI does not accept: the flag named
 * before the "=" is KNOWN, so the caller's generic "unknown argument" would misreport a real
 * flag as a misspelling — instead name the offending token and the accepted space-separated
 * spelling. Silent for tokens not in equals form or naming no known flag, so the caller's own
 * unknown-argument error still fires. Runs in every parser's unknown-flag gate (the
 * rejectUnknownArgs loop, parseInitArgs, parsePromptArgs), so no command accepts or
 * misreports the form. */
export function rejectEqualsForm(
  arg: string,
  specs: readonly { names: readonly string[]; value?: boolean; valueName?: string }[],
): void {
  const name = equalsFormFlag(arg);
  if (name === null) return;
  const spec = specs.find((s) => s.names.includes(name));
  if (!spec) return;
  fail(
    spec.value
      ? `${arg} is not accepted — give the value as a separate token: \`${spec.names[0]} ${spec.valueName ?? "<value>"}\``
      : `${arg} is not accepted — ${spec.names[0]} takes no value (give it on its own)`,
  );
}

/** The missing-value error parseRoleFlag and parsePromptArgs share with ROLE_FLAG's trailing
 * gate below, so the three wordings cannot drift (the drift-guard test imports it). */
export const ROLE_VALUE_ERROR = "--role needs a role id (e.g. `--role feature`)";
/** The missing-or-flag-shaped-value error parseBranchFlag (cli-args.ts) shares with
 * RUN_FLAG_SPECS' --branch entry, for the same no-drift reason. */
export const BRANCH_VALUE_ERROR = "--branch needs a branch name (e.g. `--branch release/2.0`)";

/** The `--role <id>` flag spec, shared by every role-targeting command (logs, reset-counters,
 * wake, abort, pause, resume): one definition of the flag's spelling and value shape so the
 * accepted vocabulary and its rendering in rejectUnknownArgs' error messages cannot drift
 * apart. */
export const ROLE_FLAG: FlagSpec = {
  names: ["--role"],
  value: true,
  valueName: "<id>",
  missingValue: ROLE_VALUE_ERROR,
};

/** The `--for <duration>` flag spec, accepted by `pause` (the timed pause) and `run` (the
 * windowed run): one definition of the flag's spelling and value shape, beside ROLE_FLAG, so
 * the gate's accepted vocabulary and parseDurationFlag's error messages cannot drift apart.
 * validate re-runs the shape parser at the gate, so `pause --for xyz` and `run --for xyz`
 * name the typo before the ready-repo gate can mask it; the 90-day cap stays in cmdPause and
 * cmdRun beside the timers/writers they feed. */
export const DURATION_FLAG: FlagSpec = {
  names: ["--for"],
  value: true,
  valueName: "<duration>",
  validate: (value) => {
    parseDurationFlag("--for", value);
  },
};

/** The `--in <duration>` flag spec, accepted by `wake` alone (the scheduled wake): one
 * definition of the flag's spelling and value shape, beside DURATION_FLAG, so the gate's
 * accepted vocabulary and parseDurationFlag's error messages cannot drift apart. validate
 * re-runs the shape parser at the gate, so `wake --in xyz` names the typo before the
 * ready-repo gate can mask it; the 90-day cap stays in cmdWake beside the writer it feeds
 * (the same ceiling `pause --for` honors). */
export const WAKE_IN_FLAG: FlagSpec = {
  names: ["--in"],
  value: true,
  valueName: "<duration>",
  validate: (value) => {
    parseDurationFlag("--in", value);
  },
};

/** The `--reason <text>` flag spec, accepted by `pause` alone (the operator pause's why):
 * one definition of the flag's spelling and value shape, beside ROLE_FLAG and DURATION_FLAG,
 * so the gate's accepted vocabulary cannot drift from cmdPause's parse. The missing-value
 * wording names its only command (the GREP_VALUE_ERROR idiom — each command's parser names
 * itself); the 200-char cap stays in pauseFleet beside the marker it bounds, and per-role
 * pauses carry no reason, so cmdPause rejects the `--role` + `--reason` combination.
 * Exported so the gate and the command body share one definition of what `pause` accepts. */
export const REASON_FLAG: FlagSpec = {
  names: ["--reason"],
  value: true,
  valueName: "<text>",
  missingValue: "pause --reason needs a reason",
};

/** The `--since <duration>` flag spec shared by the three windowed read-only views (logs,
 * history, report): one definition of the flag's spelling and value shape, beside ROLE_FLAG
 * and DURATION_FLAG, so the gate's accepted vocabulary and parseDurationFlag's error messages
 * cannot drift apart. The error wording differs per command — every failure names its own
 * command with the flag (`logs --since needs a value`, `logs --since needs a duration like
 * 45s, 90m, 1h30m, or 2d (got …)`), the same label the command body's parseSinceFlag rides into
 * its messages and the over-cap check already uses — so the spec is a factory taking it,
 * the same pattern grepFlagSpec arms its missing-value error with. validate re-runs the shape
 * parser at the gate; each window's 7-day cap and its rival-flag rules stay in the command
 * body beside the window read they bound. */
export function sinceFlagSpec(label: string): FlagSpec {
  return {
    names: ["--since"],
    value: true,
    valueName: "<duration>",
    missingValue: `${label} needs a value`,
    validate: (value) => {
      parseDurationFlag(label, value);
    },
  };
}

/** The `-n <count>` flag spec, shared by the two tail views that take a row count (logs,
 * history): one definition of the flag's spelling and value shape, beside sinceFlagSpec, so the
 * gate's accepted vocabulary and parseCountFlag's error messages cannot drift apart. validate
 * re-runs the shape parser at the gate; the bodies keep their own defaults and rival rules. */
export const N_FLAG: FlagSpec = {
  names: ["-n"],
  value: true,
  valueName: "<count>",
  validate: (value) => {
    parseCountFlag("-n", value);
  },
};

/** The `--json` flag spec, shared by every command with a machine-readable form (status,
 * doctor, logs, history, tick, diff, backlog, role, report, prompt --list): one definition of
 * the flag's spelling, beside ROLE_FLAG and sinceFlagSpec, so the gate's accepted vocabulary
 * cannot drift apart. It takes no value and carries no per-command wording — unlike its
 * siblings it needs neither a factory nor a missing-value error — so the constant is the
 * whole spec, and the render-vs-JSON switch stays in each command body beside its render. */
export const JSON_FLAG: FlagSpec = { names: ["--json"] };

/** The `--last` flag spec for `tumwater tick <role> --last`: one definition of the flag's
 * spelling, beside JSON_FLAG, so tick's gate and cmdTick's arity guards cannot disagree on
 * what the command admits. Like --json it takes no value and needs no wording — the
 * command body owns the meaning (resolve the newest completed tick instead of numbering
 * one) and the arity rules it implies. */
export const LAST_FLAG: FlagSpec = { names: ["--last"] };

/** The `--grep <text>` flag spec shared by the two filtering views (logs, history): one
 * definition of the flag's spelling and value shape, beside ROLE_FLAG and sinceFlagSpec, so the
 * gate's accepted vocabulary cannot drift apart. The missing-value wording differs per command
 * (each names its own command), so the spec is a factory taking it — the same string
 * parseGrepFlag fails with in the command body. */
export function grepFlagSpec(missingValue: string): FlagSpec {
  return { names: ["--grep"], value: true, valueName: "<text>", missingValue };
}

/** `tumwater run`'s flag vocabulary: `--branch <name>` (the target branch, parsed by
 * parseBranchFlag), `--once` (one full round of ticks, then exit), and `--role <id>`
 * (scope a --once round to one loop, parsed by parseRoleFlag). Exported so the
 * caller's rejectUnknownArgs check and its tests share one definition of what `run`
 * accepts — before this vocabulary existed, run parsed --branch and silently ignored
 * every other flag, so a typo'd option ran the daemon with default behavior. */
export const RUN_FLAG_SPECS: FlagSpec[] = [
  { names: ["--branch"], value: true, valueName: "<name>", missingValue: BRANCH_VALUE_ERROR },
  { names: ["--once"] },
  // `run --for <duration>` (the windowed run): the same spec `pause --for` passes, so the
  // gate's accepted vocabulary and parseDurationFlag's error wording cannot drift; the
  // 90-day cap and the --once rival rule stay in cmdRun beside the timer they arm.
  DURATION_FLAG,
  ROLE_FLAG,
];

/** Fail when any argument was not consumed by this command's known flags — a misspelled flag
 * (e.g. `--rol` instead of `--role`) would otherwise be silently ignored and the command runs
 * with default behavior, which is worse than an error: `reset-counters --rol x` zeroed every
 * loop instead of one, and `gui --portt 8080` served on the default port. Valueless flags claim
 * one token; valued flags claim two — and a valued flag left without its value fails right
 * here, with the spec's missingValue wording: cli.ts runs this gate before the ready-repo gate
 * and the command bodies, so a missing value must be named before any environment check ("not
 * a git repository") can mask it from an operator typing `tumwater pause --role` outside an
 * initialized repo. A repeated flag fails: the parsers in cli-args.ts read flags with indexOf, so a second occurrence used to be silently dropped and the
 * operator's later value (gui --port 8000 --port 9000, logs -n 5 -n 10) never took effect —
 * the same "may only be given once" rule parseInitArgs and parsePromptArgs apply to their
 * own flags. The check is keyed by spec, so alias spellings (-f and --follow) count as one
 * flag, while a flag-shaped VALUE claimed by an earlier flag is not a repeat. */
export function rejectUnknownArgs(command: string, args: string[], specs: FlagSpec[]): void {
  if (args.length === 0) return;
  const claim = new Map<string, FlagSpec>();
  for (const spec of specs) for (const name of spec.names) claim.set(name, spec);
  const seen = new Set<FlagSpec>();
  const consumed = new Array<boolean>(args.length).fill(false);
  for (let i = 0; i < args.length; i++) {
    if (consumed[i]) continue;
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    const spec = claim.get(arg);
    if (spec === undefined) {
      // An equals-form token names a real flag; refuse it with its own message before the
      // generic "unknown argument" misreports `--role=feature` as a misspelling.
      rejectEqualsForm(arg, specs);
      if (specs.length === 0) fail(`tumwater ${command} takes no arguments`);
      failUnknownArgument(command, arg, specs);
    }
    if (seen.has(spec)) fail(`${spec.names[0]} may only be given once`);
    seen.add(spec);
    if (spec.value && i === args.length - 1)
      fail(spec.missingValue ?? `${spec.names[0]} needs a value`);
    // The value exists (the trailing-no-value case failed above): name a malformed one now,
    // before the ready-repo gate or any environment check can mask it.
    if (spec.value) spec.validate?.(args[i + 1] ?? "");
    const n = spec.value ? 2 : 1;
    for (let j = 0; j < n && i + j < args.length; j++) consumed[i + j] = true;
  }
}

