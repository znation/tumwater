/** The declarative flag-vocabulary layer shared by every command's argument gate: the
 * FlagSpec shape, the per-flag specs (ROLE_FLAG, durationFlagSpec, REASON_FLAG, sinceFlagSpec,
 * N_FLAG, JSON_FLAG, grepFlagSpec, RUN_FLAG_SPECS), and the unknown-argument gate
 * (rejectUnknownArgs, with rejectEqualsForm). Split from cli/cli-args.ts, whose imperative
 * single-flag parsers (flagValue, parseCountFlag, parseDurationFlag, parseRoleFlag, ...)
 * stay there — one module per layer, so the vocabulary a command accepts and the parsers
 * its body re-runs are related by import rather than mixed in one file. The gate runs in
 * cli.ts before the ready-repo gate and every command body, so a bad flag (misspelled,
 * duplicated, missing or malformed value, equals-form spelling) fails fast with an
 * actionable message instead of the command silently running with default behavior. */
import { fail } from "./cli-output.js";
import { failOverDurationCap, parseCountFlag, parseDurationFlag, parsePortFlag, rejectRepeatFlag } from "./cli-args.js";
import { PAUSE_FOR_MAX_MS } from "../operator/operator-intent.js";
import { allRoleIds } from "../roles/roles.js";
import { didYouMean, suggestClosest, typoSuffix } from "../text/suggest.js";
import { gotSuffix } from "../text/text.js";
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
 * (rejectUnknownDoubleDash) print, so the message cannot drift between the two gates. The
 * valid-flags list is followed by text/suggest.ts's did-you-mean hint when the token is a near
 * miss of an accepted spelling (`--rol` → `--role`), the same annotation every other unknown-X
 * error carries; a token far from every flag gets only the list. A bare token that names (or
 * nearly names) a role id, on a command taking ROLE_FLAG, instead gets `did you mean \`--role
 * <id>\`?` (`tumwater wake feature`); `role` is exempt because it peels its own positional id,
 * so a stray second token there is not a missing flag. Custom (config-defined) roles get no
 * hint: this parse-time gate has no config, so only allRoleIds() are matched. */
function failUnknownArgument(command: string, arg: string, specs: readonly FlagSpec[]): never {
  const spellings = specs.flatMap((s) => s.names);
  const roleId =
    specs.includes(ROLE_FLAG) && !arg.startsWith("-") && command !== "role"
      ? suggestClosest(arg, allRoleIds())
      : null;
  const suffix = roleId !== null ? didYouMean(`--role ${roleId}`) : typoSuffix(arg, spellings);
  fail(`unknown argument: ${arg} (valid flags for tumwater ${command}: ${validFlagsList(specs)})${suffix}`);
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
/** The missing-or-flag-shaped-value error parseBranchFlag (cli/cli-args.ts) shares with
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

/** The missing-value error for `logs --transcript` (LOGS_TRANSCRIPT_FLAG's trailing gate). */
export const LOGS_TRANSCRIPT_VALUE_ERROR = "--transcript needs a role id (e.g. `--transcript feature`)";

/** The `--transcript <id>` flag spec of `logs`: the role whose agent transcript to print. A
 * separate constant from ROLE_FLAG because its missing-value text names `--transcript`. */
export const LOGS_TRANSCRIPT_FLAG: FlagSpec = {
  names: ["--transcript"],
  value: true,
  valueName: "<id>",
  missingValue: LOGS_TRANSCRIPT_VALUE_ERROR,
};

/** The `--for <duration>` flag spec factory, accepted by `pause` (the timed pause) and
 * `run` (the windowed run): one definition of the flag's spelling and value shape, beside
 * ROLE_FLAG, so the gate's accepted vocabulary and parseDurationFlag's error messages cannot
 * drift apart. `label` (e.g. "pause --for", "run --for") names the command in every message,
 * the same command-named pattern sinceFlagSpec follows: it rides into parseDurationFlag's
 * missing-value and malformed-duration messages as well as the over-cap one, so a trailing
 * `--for` reads `pause --for needs a value`, not a bare `--for needs a value`. validate
 * re-runs the shape parser at
 * the gate, so `pause --for xyz` and `run --for xyz` name the typo before the ready-repo gate
 * can mask it, and fails an over-cap value there too, so `pause --for 100d` in an
 * uninitialized directory names the cap instead of the not-initialized hint — the same
 * precedence the shape error already follows. An optional `hint` rides into that gate-level
 * cap message, exactly as the body's own check phrases it, so the wording cannot differ by
 * which check fired. The bodies keep their own cap checks: the GUI's and TUI's pause paths
 * reach the writers without this CLI gate and still need the bound beside them. */
export function durationFlagSpec(label: string, hint?: string): FlagSpec {
  return {
    names: ["--for"],
    value: true,
    valueName: "<duration>",
    missingValue: `${label} needs a value`,
    validate: (value) => {
      failOverDurationCap(label, parseDurationFlag(label, value), PAUSE_FOR_MAX_MS, hint);
    },
  };
}

/** The hint `pause --for`'s over-cap failure carries: the gate's durationFlagSpec and cmdPause's
 * own re-parse beside the writer must phrase it identically, so the wording lives here once.
 * Other `--for` users (`run --for`) take no hint — their ceiling is an ordinary bound. */
export const PAUSE_FOR_OVERFLOW_HINT =
  "for a longer or standing pause run bare `tumwater pause` (lift it with `tumwater resume`)";

/** The `--in <duration>` flag spec, accepted by `wake` alone (the scheduled wake): one
 * definition of the flag's spelling and value shape, beside durationFlagSpec, so the gate's
 * accepted vocabulary and parseDurationFlag's error messages cannot drift apart. validate
 * re-runs the shape parser at the gate, so `wake --in xyz` names the typo before the
 * ready-repo gate can mask it, and fails an over-cap value there too (the same ceiling
 * `pause --for` honors, the same not-initialized-masking rationale durationFlagSpec records).
 * missingValue names the command for a trailing `--in` (`wake --in needs a value`), the same
 * command-named pattern durationFlagSpec and sinceFlagSpec follow. */
function inFlagSpec(command: string): FlagSpec {
  return {
    names: ["--in"],
    value: true,
    valueName: "<duration>",
    missingValue: `${command} --in needs a value`,
    validate: (value) => {
      failOverDurationCap(`${command} --in`, parseDurationFlag(`${command} --in`, value), PAUSE_FOR_MAX_MS);
    },
  };
}

export const WAKE_IN_FLAG: FlagSpec = inFlagSpec("wake");

/** `tumwater stop --in <duration>`: the scheduled graceful stop, same shape and cap as wake's. */
export const STOP_IN_FLAG: FlagSpec = inFlagSpec("stop");

/** `tumwater stop --cancel`: drop the scheduled stop. */
export const STOP_CANCEL_FLAG: FlagSpec = { names: ["--cancel"] };

/** The `--cancel` flag spec for `tumwater wake --cancel`: drop pending scheduled wakes. */
export const WAKE_CANCEL_FLAG: FlagSpec = { names: ["--cancel"] };

/** `wake --list`: print the pending scheduled wakes instead of writing one. Takes no value. */
export const WAKE_LIST_FLAG: FlagSpec = { names: ["--list"] };

/** The `--reason <text>` flag spec, accepted by `pause` alone (the operator pause's why):
 * one definition of the flag's spelling and value shape, beside ROLE_FLAG and durationFlagSpec,
 * so the gate's accepted vocabulary cannot drift from cmdPause's parse. The missing-value
 * wording names its only command (the GREP_VALUE_ERROR idiom — each command's parser names
 * itself); the 200-char cap stays in pauseTeam beside the marker it bounds, and per-role
 * pauses carry no reason, so cmdPause rejects the `--role` + `--reason` combination. Exported
 * so the gate and the command body share one definition of what `pause` accepts. Its
 * missing-value wording is REASON_VALUE_ERROR, exported so cmdPause's own guard reads it too. */
export const REASON_VALUE_ERROR = "pause --reason needs a reason";

export const REASON_FLAG: FlagSpec = {
  names: ["--reason"],
  value: true,
  valueName: "<text>",
  missingValue: REASON_VALUE_ERROR,
};

/** The `--since <duration>` flag spec shared by the three windowed read-only views (logs,
 * history, report): one definition of the flag's spelling and value shape, beside ROLE_FLAG
 * and durationFlagSpec, so the gate's accepted vocabulary and parseDurationFlag's error messages
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

/** The `--ready` flag spec, accepted by `backlog`: keep only the entries no hold keeps from
 * being picked. Value-less, like STAT_FLAG. */
export const READY_FLAG: FlagSpec = { names: ["--ready"] };

/** Force re-probing of every claimed image-input model in `tumwater doctor` (part 2/5),
 * bypassing the 7-day cache: `--reprobe` (a value-less flag like JSON_FLAG). */
export const REPROBE_FLAG: FlagSpec = { names: ["--reprobe"] };

/** The `--problems` flag spec, accepted by `doctor`: print only the warn and fail rows. Value-less,
 * like REPROBE_FLAG. */
export const PROBLEMS_FLAG: FlagSpec = { names: ["--problems"] };

/** The `--kill-orphans` flag spec, accepted by `doctor`: first kill the orphaned processes the
 * orphans check lists, each with its descendants. Value-less, like PROBLEMS_FLAG. */
export const KILL_ORPHANS_FLAG: FlagSpec = { names: ["--kill-orphans"] };

/** The `--stat` flag spec, accepted by `diff --role`: print each patch as its `git diff --stat`
 * summary. Value-less, like JSON_FLAG. */
export const STAT_FLAG: FlagSpec = { names: ["--stat"] };

/** The `--patch` flag spec, accepted by `history <role> <n>`: append the run's commit patch.
 * Value-less, like STAT_FLAG. */
export const PATCH_FLAG: FlagSpec = { names: ["--patch"] };

/** The `--transcript` flag spec, accepted by `history <role> <n>`: append that run's agent
 * transcript to its trail. Value-less, like STAT_FLAG. */
export const TRANSCRIPT_FLAG: FlagSpec = { names: ["--transcript"] };

/** The `--prompt` flag spec: value-less, used by `logs` (the transcript view) and by the
 * `history <role>` trail (with `--transcript`). */
export const PROMPT_FLAG: FlagSpec = { names: ["--prompt"] };

/** The `--summary` flag spec, accepted by `history`: tally each role's tick outcomes instead of
 * printing the rows. Value-less, like STAT_FLAG. */
export const SUMMARY_FLAG: FlagSpec = { names: ["--summary"] };

/** The `--count` flag spec, accepted by `logs`: tally the selected window's event types
 * instead of printing the rows. Value-less, like SUMMARY_FLAG. */
export const COUNT_FLAG: FlagSpec = { names: ["--count"] };

/** The `--force` flag spec, accepted by `retire` (the only override-the-rails command): one
 * definition of the flag's spelling beside ROLE_FLAG and JSON_FLAG, so the gate's accepted
 * vocabulary cannot drift from the command body's `args.includes("--force")`. */
export const FORCE_FLAG: FlagSpec = { names: ["--force"] };

/** The `--dry-run` flag spec: preview a reclaim pass or a retire without changing anything. Beside
 * FORCE_FLAG so its spelling lives with the other boolean flags the gate admits. */
export const DRY_RUN_FLAG: FlagSpec = { names: ["--dry-run"] };

/** The `--last` flag spec for `tumwater tick <role> --last`: one definition of the flag's
 * spelling, beside JSON_FLAG, so tick's gate and cmdRunDetail's arity guards cannot disagree on
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

/** The `--type <event type>` flag spec of `logs`' exact-type filter, beside grepFlagSpec: one
 * definition of the flag's spelling and value shape, so the gate's accepted vocabulary cannot
 * drift. The missing-value wording names the command (each names its own command), so the
 * spec is a factory taking it — the same string parseTypeFlag fails with in the command body. */
export function typeFlagSpec(missingValue: string): FlagSpec {
  return { names: ["--type"], value: true, valueName: "<event type>", missingValue };
}

/** The `--result <class>` flag spec of `history`'s outcome filter, beside grepFlagSpec: one
 * definition of the flag's spelling and value shape, so the gate's accepted vocabulary cannot
 * drift. The missing-value wording names the command, so the spec is a factory taking it — the
 * same string the body fails with; which classes are accepted is the command body's rule
 * (history-data.ts's HISTORY_RESULT_CLASSES). */
export function resultFlagSpec(missingValue: string): FlagSpec {
  return { names: ["--result"], value: true, valueName: "<class>", missingValue };
}

/** `history --model <selector>[,...]`: keeps the runs that started on the listed models;
 * `missingValue` is the same string the command body fails with. */
export function modelFlagSpec(missingValue: string): FlagSpec {
  return { names: ["--model"], value: true, valueName: "<selector>", missingValue };
}

/** `history --by <role|model>`: how `--summary` groups its lines; `missingValue` is the same
 * string the command body fails with. */
export function byFlagSpec(missingValue: string): FlagSpec {
  return { names: ["--by"], value: true, valueName: "<role|model>", missingValue };
}

/** `tumwater run`'s flag vocabulary: `--branch <name>` (the target branch, parsed by
 * parseBranchFlag), `--once` (one full round of ticks, then exit), `--role <id>`
 * (scope a --once round to one role, parsed by parseRoleFlag), and `--gui` (also serve the
 * browser dashboard on its defaults; port/token selection stays on `tumwater gui`). Exported
 * so the caller's rejectUnknownArgs check and its tests share one definition of what `start`
 * (and its hidden alias `run`) accepts — before this vocabulary existed, run parsed --branch
 * and silently ignored every other flag, so a typo'd option ran the daemon with default
 * behavior. */
export const RUN_FLAG_SPECS: FlagSpec[] = [
  { names: ["--branch"], value: true, valueName: "<name>", missingValue: BRANCH_VALUE_ERROR },
  { names: ["--once"] },
  // `run --gui` is the one-command form of the dashboard: it boots the team and serves the
  // browser dashboard at its defaults, loopback on port 7180. The dashboard's own --port,
  // --all-interfaces, and --token stay on `tumwater gui`; widening them here would mean two
  // flag vocabularies to keep in step. `run --gui --once` is refused in cmdRun beside the
  // timer it arms.
  { names: ["--gui"] },
  // `run --tui` is the one-command form of the observer TUI: it boots the team and hosts the
  // same in-terminal TUI `tumwater tui` attaches from another terminal. Its flag vocabulary
  // stays at run's (`tumwater tui` takes no flags); `run --tui --once` is refused in cmdRun
  // beside the `--gui` rival.
  { names: ["--tui"] },
  // `run --for <duration>` (the windowed run): the same spec `pause --for` passes, so the
  // gate's accepted vocabulary and parseDurationFlag's error wording cannot drift; the
  // 90-day cap is the spec's own validate (shared with pause), and the --once rival rule
  // stays in cmdRun beside the timer it arms.
  durationFlagSpec("start --for"),
  ROLE_FLAG,
];

/** The one refusal for a trailing `gui --token` with no value, phrased for what the
 * flag actually needs — the spec's missingValue (so the gate's early report says it)
 * and cmdGui's own re-check share this one wording. */
export const TOKEN_VALUE_ERROR = "--token requires a non-empty secret (e.g. `--token s3cret`)";

/** `tumwater gui`'s flag vocabulary: `--port <n>` (the dashboard port, shape-checked by
 * parsePortFlag so `gui --port abc` is named before the ready-repo gate can mask it),
 * `--all-interfaces`, and `--token <secret>` (the dashboard auth token). Exported so
 * cli.ts's rejectUnknownArgs check and its tests share one definition of what `gui`
 * accepts, like every other command's spec in this module; cmdGui re-runs parsePortFlag
 * and the token emptiness check on the accepted args, so the gate and the body cannot
 * drift apart. */
export const GUI_FLAG_SPECS: FlagSpec[] = [
  {
    names: ["--port"],
    value: true,
    valueName: "<n>",
    validate: (value) => {
      parsePortFlag(value);
    },
  },
  { names: ["--all-interfaces"] },
  { names: ["--token"], value: true, valueName: "<secret>", missingValue: TOKEN_VALUE_ERROR },
];

/** Fail when any argument was not consumed by this command's known flags — a misspelled flag
 * (e.g. `--rol` instead of `--role`) would otherwise be silently ignored and the command runs with
 * default behavior, which is worse than an error: `reset-counters --rol x` zeroed every role
 * instead of one, and `gui --portt 8080` served on the default port. Valueless flags claim one
 * token; valued flags claim two — and a valued flag left without its value fails right here, with
 * the spec's missingValue wording: cli.ts runs this gate before the ready-repo gate and the command
 * bodies, so a missing value must be named before any environment check ("not a git repository")
 * can mask it from an operator typing `tumwater pause --role` outside an initialized repo. A
 * repeated flag fails: the parsers in cli/cli-args.ts read flags with indexOf, so a second
 * occurrence used to be silently dropped and the operator's later value (gui --port 8000 --port
 * 9000, logs -n 5 -n 10) never took effect — the same "may only be given once" rule parseInitArgs
 * and parsePromptArgs apply to their own flags. The check is keyed by spec, so alias spellings (-f
 * and --follow) count as one flag, while a flag-shaped VALUE claimed by an earlier flag is not a
 * repeat. */
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
      if (specs.length === 0) fail(`tumwater ${command} takes no arguments${gotSuffix(arg)}`);
      failUnknownArgument(command, arg, specs);
    }
    rejectRepeatFlag(seen.has(spec), spec.names[0]!);
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
