import { fail } from "../terminal.js";
import { knownRoleIdsCached } from "../config/config.js";
import { allRoleIds, unknownRoleMessage } from "../roles/roles.js";
import { gotSuffix, parsePositiveInt, splitCommaList } from "../text/text.js";
import { durationLabel, durationSlipClause, parseDurationMs } from "../text/duration.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** CLI argument parsing and validation, shared by every command in cli.ts. The execution
 * layer calls these before running a command, so a bad flag fails fast with an actionable
 * message instead of the command silently running with default behavior. The plain-decimal
 * integer core (parsePositiveInt/parseNonNegativeInt) lives in text.ts — shared by these flags
 * and gui/gui-args.ts's query-param validation, so one definition of a valid count/position
 * covers both input surfaces without the UI layer importing this module. The two commands
 * whose positionals are free-form prompt text (`init`, `prompt`) parse their own args in
 * cli/cli-command-args.ts — their rules contradict this module's reject-everything-left-over
 * contract, and `--file`'s readFileSync would be this module's only I/O. The declarative
 * flag-vocabulary layer — the FlagSpec shape, the per-flag specs, and the unknown-argument
 * gate — lives in cli/cli-flag-specs.ts; this module keeps the imperative single-flag parsers
 * its specs re-run. Terminal output and the failure exit live in terminal.ts — this
 * module's parsers fail through fail() from there, but they do not write output of their own. */

/** The missing-value error parseRoleFlag and parsePromptArgs (cli-command-args.ts) share with
 * the --role spec's trailing gate in cli-flag-specs.ts, so the three wordings cannot drift
 * (the drift-guard test imports it). */
export const ROLE_VALUE_ERROR = "--role needs a role id (e.g. `--role feature`)";
/** The missing-or-flag-shaped-value error parseBranchFlag shares with START_FLAG_SPECS'
 * --branch entry (cli-flag-specs.ts), for the same no-drift reason. */
export const BRANCH_VALUE_ERROR = "--branch needs a branch name (e.g. `--branch release/2.0`)";
/** The one refusal for a trailing `gui --token` with no value — the spec's missingValue
 * (so the gate's early report says it) and tokenValueProblem's re-check share this one
 * wording. */
export const TOKEN_VALUE_ERROR = "--token requires a non-empty secret (e.g. `--token s3cret`)";
/** The env var that carries the dashboard gate token: `gui --token` and the `run --gui`/`start
 * --gui` supervisor each write it, and a spawned or re-exec'd dashboard child reads it back —
 * process env is what a spawn hands a child intact and what reexecSelf propagates, whereas argv
 * is what /proc/<pid>/cmdline exposes to every local user and what a reload re-runs verbatim, so
 * the secret travels by env, never argv. One definition, shared by the dashboard command
 * (gui/gui-command.ts, which reads it) and the supervisor (cli-start-supervisor.ts, which writes
 * it into the child's env), so a rename or drift in either can never silently open the dashboard
 * unauthenticated. It lives here (not in gui/gui-command.ts, which the `start`/`run` supervisor
 * cannot import without pulling the GUI server graph onto the boot path) because both sides
 * already import this module for the `--token` validator (tokenValueProblem) below. */
export const GUI_TOKEN_ENV = "TUMWATER_GUI_TOKEN";

/** Peel a positional-first command's bare tokens off the argument list: every flag-shaped
 * token rides in rest for rejectUnknownArgs, every bare token is a positional. For a
 * no-valued-flags command (history: `--json` alone) the split is a prefix test — a negative
 * run number (`history bugfix -3`) arrives flag-shaped and fails the unknown-arg gate, which
 * is the right answer for a non-positive n anyway. The generic flag/positional split that the
 * read-only listing commands lean on, so it lives here with the CLI's other argument helpers,
 * shared by cli.ts's history case and cli-doctor-command.ts. */
export function peelPositionals(args: string[]): {
  positionals: string[];
  rest: string[];
} {
  const positionals: string[] = [];
  const rest: string[] = [];
  for (const arg of args) (arg.startsWith("-") ? rest : positionals).push(arg);
  return { positionals, rest };
}

/** The `history` listing flags that take a separate value token. */
const HISTORY_LISTING_VALUED_FLAGS = ["-n", "--since", "--until", "--grep", "--result", "--role", "--model", "--by"];

/** True when `history`'s args are the one-run trail form (`history <role> <n>`, `history
 * <role> --last`, bare `history --last`): `--last`, or a token that is neither a flag nor the
 * value of a listing-form valued flag. A valued flag's value is skipped by position, so
 * `--grep -x` stays a listing. */
export function historyTrailForm(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (HISTORY_LISTING_VALUED_FLAGS.includes(arg)) i++;
    else if (!arg.startsWith("-") || arg === "--last") return true;
  }
  return false;
}

/** The raw value token that follows a valued flag in `args`: null when the flag is absent,
 * the following token when present (undefined when the flag is the final argument, so the
 * parse helpers fail with their `needs a value` messages rather than the caller silently
 * applying its default). The one place for the indexOf/args[i+1] pairing every value-flag
 * site repeated by hand, so the pairing's edge cases — a trailing valued flag, an
 * empty-string value — are decided in exactly one spot. Callers that also need the flag's
 * index (to claim the pair against stray arguments) keep their own indexOf, which the
 * parseInitArgs/parsePromptArgs claim bookkeeping does. */
export function flagValue(args: string[], flag: string): string | null | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1];
}

/** The optional value token of an optional-value flag (`wake --cancel [<n>]`): null when the
 * flag is absent, when it is the final argument, or when the following token starts with `-`
 * (a bare `--cancel --role qa` reads `--role` as the next flag, not as the value) — otherwise
 * the following token. This is the read the command body uses, the exact complement of
 * consumeFlagOccurrence's claim rule in cli-flag-specs.ts (a value the gate did NOT claim is
 * null here too), so the gate and the body cannot disagree about whether a token was taken. */
export function optionalFlagValue(args: string[], flag: string): string | null {
  const raw = flagValue(args, flag);
  return raw !== null && raw !== undefined && !raw.startsWith("-") ? raw : null;
}

/** The one validation of a `--token <secret>` value, shared by `tumwater gui` (cmdGui) and
 * `tumwater start --gui` (cmdStart) so the value checks and their wording cannot drift
 * between the two callers. Returns null when the token is fine (or absent), the error text
 * the caller `fail()`s otherwise: TOKEN_VALUE_ERROR for a valueless or empty `--token`, and a
 * flag-looking-value message when the value starts with `--` (a valued flag claims the next
 * token even when it is a known flag, so `--token --all-interfaces` would otherwise serve with
 * the literal secret "--all-interfaces"). `example` names the command form the operator
 * typed (e.g. "tumwater gui" or "tumwater start --gui") in the copyable fix, so the
 * message names whichever command the secret was meant for. */
export function tokenValueProblem(args: string[], example: string): string | null {
  const raw = flagValue(args, "--token");
  if (raw === null) return null;
  if (raw === undefined || raw === "") return TOKEN_VALUE_ERROR;
  if (raw.startsWith("--"))
    return `--token got the flag-looking value "${raw}" instead of a secret — write the secret as its own argument (e.g. \`${example} --token s3cret --all-interfaces\`)`;
  return null;
}

/** The "each flag at most once" rule at a flag fold: fail the occurrence after the first with
 * the shared wording (`<flag> may only be given once`), `seen` being the caller's accumulator
 * for that flag. One home for the wording the spec-driven gate (cli-flag-specs.ts), the
 * free-form parsers' pre-scan (cli-command-args.ts), and the bespoke command shells
 * (cli-backlog.ts, cli-backlog-view.ts, cli-query-commands.ts) all apply, so a repeat
 * cannot be reported as a different error on one surface. Called per occurrence rather than
 * pre-scanned at every site, so a malformed invocation still reports whichever error its token
 * order reaches first. */
export function rejectRepeatFlag(seen: boolean, flag: string): void {
  if (seen) fail(`${flag} may only be given once`);
}

/** Refuse a `--`-token in a valued flag's position — `--result --last` must not treat `--last`
 * as its value. Both `history` forms used to swallow the following `--` token in the value
 * slot: the trail's `--result`/`--model` then failed downstream with a misleading "--result
 * needs --last" wording — the operator DID write `--last` — and the listing's `--model`
 * silently treated `--last` as a model filter and matched no rows. Returns the value
 * unchanged when it is not a `--` token; only a `--` token reads as a flag, so a single-dash
 * token and the intentional-text filters (grep, type) are not refused. `flag` names the
 * valued flag the way its missing-value error names the command (e.g. `history --model`). */
export function rejectFlagLookingValue(flag: string, value: string | null | undefined): string | null | undefined {
  if (typeof value === "string" && value.startsWith("--"))
    fail(`${flag} needs a value (the next token ${JSON.stringify(value)} is a flag, not a value)`);
  return value;
}

/** The shared body of the `parse*Flag` helpers (grep, type, result, model): the flag's
 * value (null when absent) alongside `rest`, the args with the value token removed, failing
 * with `missingValueError` when the flag is valueless or its value is empty.
 * `guardFlagValue` opts the flag into rejectFlagLookingValue, the same refusal the history
 * listing (cmdHistory) applies to its own `--result`/`--model` and `role <id>`'s write flags
 * and `config set` make. The value-scored filters (grep, type) deliberately keep a
 * flag-shaped token as filter text and so stay off this guard. */
function takeValuedFlag(
  args: string[],
  flag: string,
  missingValueError: string,
  guardFlagValue = false,
): { rest: string[]; value: string | null } {
  const i = args.indexOf(flag);
  const rest = i >= 0 ? args.filter((_, j) => j !== i + 1) : args;
  const raw = flagValue(args, flag);
  if (raw === null) return { rest, value: null };
  const checked = guardFlagValue ? rejectFlagLookingValue(flag, raw) : raw;
  if (checked === undefined || checked === "") fail(missingValueError);
  return { rest, value: checked };
}

/** Parse an optional `--grep <text>` filter flag for the filtering views (logs, history): the
 * substring pattern, or null when absent, returned alongside `rest` — the args with the
 * flag's value token removed. The value token leaves the list because a flag-shaped token
 * sitting at the --grep value's position IS the pattern, not the flag it spells (`logs --grep
 * -f` greps for the text "-f"): every rival-flag scan the caller runs must go over `rest`, or
 * the pattern impersonates a rival flag and a rival check misfires on the pattern. A valueless
 * or empty pattern fails with the caller's wording — each view names its own command — the
 * same error the --grep gate spec (grepFlagSpec) reports earlier for the trailing-no-value
 * case. Lives beside flagValue, whose indexOf/value pairing it builds on, so the views'
 * scans cannot drift apart. */
export function parseGrepFlag(args: string[], missingValueError: string): { rest: string[]; pattern: string | null } {
  const { rest, value } = takeValuedFlag(args, "--grep", missingValueError);
  return { rest, pattern: value };
}

/** Parse an optional `--type <eventType>` exact-type filter flag for the event feed view
 * (logs): the exact type id, or null when absent, returned alongside `rest` — the args with
 * the flag's value token removed, exactly like parseGrepFlag. It mirrors that parser and not
 * a bare flagValue read because the value token must leave the list: `logs --type --since`
 * treats "--since" as the type text, not the flag, so the rival-flag and --since scans run
 * over `rest` and cannot misfire on the pattern. A valueless or empty type fails with the
 * caller's wording (each view names its own command) — the same error the `--type` gate spec
 * (typeFlagSpec) reports earlier for the trailing-no-value case. */
export function parseTypeFlag(args: string[], missingValueError: string): { rest: string[]; type: string | null } {
  const { rest, value } = takeValuedFlag(args, "--type", missingValueError);
  return { rest, type: value };
}

/** Parse an optional `--result <class>[,...]` flag for the history trail form: the raw value
 * (null when absent) alongside `rest`, the args with the value token removed so a class name
 * cannot be read as a positional. Validation of the classes belongs to the caller
 * (parseHistoryResultList); a valueless or empty value fails with `missingValueError`. */
export function parseResultFlag(args: string[], missingValueError: string): { rest: string[]; raw: string | null } {
  const { rest, value } = takeValuedFlag(args, "--result", missingValueError, true);
  return { rest, raw: value };
}

/** Parse an optional `--status <state>[,...]` flag for the post-merge review view: the raw value
 * (null when absent) alongside `rest`, the args with the value token removed so a state name
 * cannot be read as a positional. Validation of the states belongs to the caller
 * (cmdReviews); a valueless or empty value fails with `missingValueError`. */
export function parseStatusFlag(args: string[], missingValueError: string): { rest: string[]; raw: string | null } {
  const { rest, value } = takeValuedFlag(args, "--status", missingValueError, true);
  return { rest, raw: value };
}

/** Parse an optional `--model <selector>[,...]` flag for the history trail form: the raw value
 * (null when absent) alongside `rest`, the args with the value token removed so a selector
 * cannot be read as a positional. Validation belongs to the caller (parseHistoryModelList); a
 * valueless or empty value fails with `missingValueError`. */
export function parseModelFlag(args: string[], missingValueError: string): { rest: string[]; raw: string | null } {
  const { rest, value } = takeValuedFlag(args, "--model", missingValueError, true);
  return { rest, raw: value };
}

/** Parse a `-n`-style count flag value: a positive integer, or fail with a clear message.
 * Unvalidated, NaN/0/negative limits make readEvents' `slice(-limit)` dump the whole log
 * (or drop leading lines) instead of showing the requested tail. With `max`, the count is
 * also capped — the shared `must be between 1 and <max>` wording — so a huge bound can't
 * grow the result until the process runs out of memory (report's per-day series, history's
 * scanned window). */
export function parseCountFlag(flag: string, raw: string | undefined, max?: number): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  // A `--`-token in the count's slot is the operator's slipped value (`logs -n --json`, a
  // `--cancel --json`), never a count — counts never start with `-`, so refuse it up front
  // with rejectFlagLookingValue's shared wording instead of reporting the dropped flag as a
  // malformed count ("got \"--json\""). A single-dash token like `-5` is a malformed count
  // and still reads as one. The sibling parsePositionFlag applies the same guard.
  rejectFlagLookingValue(flag, raw);
  const n = parsePositiveInt(raw);
  if (n === null) fail(`${flag} needs a positive integer${gotSuffix(raw)}`);
  if (max !== undefined && n > max)
    fail(`${flag} must be between 1 and ${max}${gotSuffix(raw)}`);
  return n;
}

/** Parse a position-valued flag's `--cancel <n>` / `--edit <n>` number: a positive integer,
 * failing with the flag's own example when the value is missing and with the shared
 * positive-int wording (parseCountFlag's branch) when it is malformed. Positions carry the
 * `(e.g. …)` example because a bare count flag's `needs a value` reads thin next to the `<n>`
 * the operator typed; `example` is the spelling shown back to them. One home for the two
 * failure messages and the plain-decimal rule, shared by the prompt queue's parser
 * (cli-command-args.ts) and the bug/plan backlog shells (cli-backlog.ts), so the rule cannot
 * drift to Number() at one site. */
export function parsePositionFlag(flag: string, raw: string | undefined, example: string): number {
  if (raw === undefined) fail(`${flag} needs a position number (e.g. \`${example}\`)`);
  // The same slipped-`--`-flag guard parseCountFlag applies: a position never starts with
  // `-`, so `--cancel --json` (or any `--`-token) names its own slipped flag rather than
  // reporting "(got \"--json\")" as a malformed position number.
  rejectFlagLookingValue(flag, raw);
  const n = parsePositiveInt(raw);
  if (n === null) fail(`${flag} needs a positive integer${gotSuffix(raw)}`);
  return n;
}

/** Scan a queue-style command's edge-triggered flags in one pass: the one valued position
 * flag `--<flag> <n>` (at most once, parsed through parsePositionFlag with the caller's
 * `example` spelling), the `--json` boolean (at most once), any extra boolean edge flags in
 * `extraBooleans` (each at most once), `--help`/`-h` tolerated (dropped), and every other
 * token collected into `rest` for the caller's rejectUnknownArgs. Returns the parsed position,
 * the --json flag, the extra booleans' presence (for the --done/--ready variants), and rest.
 * One home for the scan loop the position-flag command shells used to repeat by hand
 * (`--cancel`, `--top`, `--release`, `--accept`, `--show`), so the at-most-once wording, the
 * plain-decimal rule, and the help-tolerance rule cannot drift among them. */
export function scanPositionArgs(
  args: string[],
  flag: string,
  example: string,
  extraBooleans: readonly string[] = [],
): { json: boolean; flags: Readonly<Record<string, boolean>>; position: number | null; rest: string[] } {
  let json = false;
  let position: number | null = null;
  const flags: Record<string, boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (extraBooleans.includes(arg)) {
      rejectRepeatFlag(flags[arg] === true, arg);
      flags[arg] = true;
      continue;
    }
    if (arg === flag) {
      rejectRepeatFlag(position !== null, flag);
      position = parsePositionFlag(flag, args[i + 1], example);
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg);
  }
  return { json, flags, position, rest };
}

/** Resolve a read-only command's `--role <id>` scope: the role id, or null when the flag is
 * absent. The id is validated against built-ins PLUS user-defined roles, read through
 * loadConfigCached (which never throws) so a transiently broken tumwater.json cannot take a
 * read-only view down — a broken file falls back to the built-in catalog rather than refusing
 * every id. Without --role no config is read. (State-changing commands instead resolve --role
 * against loadConfig and fail loudly on a broken file, as cli-operator-commands.ts and
 * prompt-commands.ts do.) The id
 * set comes from config.knownRoleIdsCached, the one home of the cached-with-built-in-fallback
 * rule. Shared by the tail views that scope their output to one role (cmdLogs, cmdHistory). */
export function parseRoleScope(
  root: string,
  args: string[],
  flag = "--role",
  missingValue = ROLE_VALUE_ERROR,
): string | null {
  if (!args.includes(flag)) return null;
  return parseRoleFlag(args, knownRoleIdsCached(root), flag, missingValue);
}

/** Resolve `history --role <id>[,<id>...]`: the listed role ids (canonical, deduplicated,
 * first-seen order), or null when the flag is absent (no config read then, as parseRoleScope).
 * Each piece is validated like parseRoleScope's id; empty pieces are dropped, and a value with
 * no piece left fails with ROLE_VALUE_ERROR. */
export function parseRoleListScope(root: string, args: string[]): string[] | null {
  return args.includes("--role") ? parseRoleListFlag(args, knownRoleIdsCached(root)) : null;
}

/** Parse `--role <id>[,<id>...]`: the listed role ids (canonical, deduplicated, first-seen
 * order), or null when the flag is absent. Empty pieces are dropped, and a value with no piece
 * left fails with ROLE_VALUE_ERROR. `validIds` defaults to the built-in catalog, as
 * parseRoleFlag. */
export function parseRoleListFlag(args: string[], validIds?: string[]): string[] | null {
  const typed = flagValue(args, "--role");
  if (typed === null) return null;
  rejectFlagLookingValue("--role", typed);
  const pieces = splitCommaList(typed ?? "");
  if (pieces.length === 0) fail(ROLE_VALUE_ERROR);
  const ids = validIds ?? allRoleIds();
  const out: string[] = [];
  for (const piece of pieces) {
    const role = canonicalRoleId(piece);
    if (!ids.includes(role)) fail(unknownRoleMessage(role, ids));
    if (!out.includes(role)) out.push(role);
  }
  return out;
}

/** Parse the `--port` flag value: an integer in 1..65535, or fail with a clear message.
 * Port 0 would make Node pick an ephemeral port while the CLI prints :0 — a URL that
 * cannot be opened; out-of-range values only fail later via Node's raw RangeError. */
export function parsePortFlag(raw: string | undefined): number {
  if (raw === undefined) fail("--port needs a value");
  // A `--`-token in the slot is the operator's slipped next flag (`gui --port --json`),
  // never a port number — a port never starts with `-` — so refuse it up front with
  // rejectFlagLookingValue's shared wording, the same guard history's --result/--model/--by
  // and the count/position/duration/role flag homes apply, instead of reporting the next
  // flag as a malformed number.
  rejectFlagLookingValue("--port", raw);
  const n = parsePositiveInt(raw);
  if (n === null || n > 65535)
    fail(`--port must be an integer between 1 and 65535${gotSuffix(raw)}`);
  return n;
}

/** Parse a `--for <duration>` flag value: one or more `<n><unit>` components in strictly
 * descending unit order (e.g. `45s`, `90m`, `1h30m`, `1d`), or fail with a clear message;
 * returns the duration in milliseconds. Zero and negative durations would write a pause
 * marker that reads as already expired — a pause that pauses nothing — so they fail like
 * any other malformed value. No absolute `--at` form: one way of saying "pause for a while".
 * The `<n><unit>` grammar is text/duration.ts's parseDurationMs, whose echo (durationLabel)
 * this wrapper's failure messages reuse; exported for tests and for the pause confirmations'
 * duration phrasing. */
export function parseDurationFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  // A `--`-token in the value slot is the operator's slipped value (`start --for --json`),
  // never a duration — durations never start with `-` — so refuse it up front with
  // rejectFlagLookingValue's shared wording, the same guard history's --result/--model/--by,
  // reviews --status and role-command's write flags apply, instead of misreading the next
  // flag as a duration and reporting it as malformed ("got \"--json\"").
  rejectFlagLookingValue(flag, raw);
  const ms = parseDurationMs(raw);
  if (ms === null)
    fail(
      `${flag} needs a duration like 45s, 90m, 1h30m, or 2d${gotSuffix(raw)}${durationSlipClause(raw)}`,
    );
  return ms;
}

/** The shared over-cap check for duration-valued flags: fail with the one message shape —
 * `<flag> is capped at <max label> (got <value label>)` — so every capped duration names
 * both bounds in the same phrasing and the sites cannot drift apart (the same idiom the
 * --since windows and pause --for share). Callers parse the flag themselves and pass only
 * the parsed value and its cap; a value at or under the cap returns silently. An optional
 * hint appends command-specific guidance after the got-label, as pause --for points at the
 * standing-pause alternative. The `got cap` labels come from text/duration.ts's
 * durationLabel, so the bound an operator retypes echoes the same vocabulary the parser
 * accepts. */
export function failOverDurationCap(flag: string, ms: number, maxMs: number, hint?: string): void {
  if (ms <= maxMs) return;
  fail(`${flag} is capped at ${durationLabel(maxMs)} (got ${durationLabel(ms)})${hint ? ` — ${hint}` : ""}`);
}

/** The shared rival-shape failure: `<subject> cannot be combined with <rival> (<why>)` —
 * the sentence shape every mutually-exclusive flag pair fails through, so the wording around
 * the two flags cannot drift per command (logs --since vs -f/-n/--role, logs --grep vs
 * --since, history --since vs -n, report --since vs --days/--failures). Callers keep their
 * own presence checks and their own why-clauses; this owns only the sentence around them,
 * exactly as failOverDurationCap above owns the cap sentence. Declared never like fail(). */
export function failRivalShapes(subject: string, rival: string, why: string): never {
  fail(`${subject} cannot be combined with ${rival} (${why})`);
}

/** The shared why-clause for a trailing-window view's `-f/--follow` rival: follow is an
 * unbounded "from now on" read, while `--since` opens a bounded past window, so the two are
 * mutually exclusive on the same grounds in all three windowed views (logs, history, report).
 * One clause so the three sites cannot drift on what follow means and why it excludes
 * `--since`; the subject keeps the command's own name. */
export function failFollowSinceRival(command: string): never {
  return failRivalShapes(
    `${command} --since`,
    "-f/--follow",
    'follow means "from now on"; --since shows a bounded past window',
  );
}

/** The shared failure for a `-f/--follow` view asked for with `--json`: a live view repaints
 * one document, so it cannot also print a single JSON snapshot. One sentence so the surviving
 * follow views (status, diff, backlog, quarantine, doctor, reviews, report, questions,
 * prompt --list, plan|bug --list, role, history --summary, the history <role> <n> trail, and
 * salvage) cannot drift on why the pair is refused; the label is the operator-facing name of
 * the view, as each command spells it. Declared never like fail(). */
export function failFollowJsonRival(label: string): never {
  return fail(`${label} prints one document; -f/--follow repaints a live view — drop one of them`);
}

/** Guard a trailing-window command's `--until <window>` against its `--since <window>` pair —
 * the shared fail sentences the three windowed views (logs, history, report) print, so the
 * wording cannot drift per command. Now invoked through the composed parseSinceUntilFlags
 * (whose three call sites are the views), hence unexported: a caller reaching for the pair
 * rule by hand is spelling the idiom the composed helper exists to own. When `--until` is
 * present but `--since` is not, it fails
 * `` `${label} --until requires --since` ``; when both are present and the until window reaches
 * or exceeds the since window, it fails `` `${label} --until (<until>) must be shorter than
 * --since (<since>)` `` — each named through the same durationLabel the parser reads, so an
 * operator could retype the window. `sinceMs` is the command's parsed `--since` window (null
 * when it read the day-shape instead), the single value the until window must stay below.
 * Returns silently when both checks pass, like failOverDurationCap above. */
function failUntilShorterThanSince(
  label: string,
  untilMs: number | null,
  sinceMs: number | null,
): void {
  if (untilMs === null) return;
  if (sinceMs === null) fail(`${label} --until requires --since`);
  if (sinceMs !== null && untilMs >= sinceMs)
    fail(`${label} --until (${durationLabel(untilMs)}) must be shorter than --since (${durationLabel(sinceMs)})`);
}

/** Read an optional `--since <duration>` window from a command's args and cap it: the one
 * home of the flagValue → parseDurationFlag → failOverDurationCap idiom the three windowed
 * read-only views (logs, history, report) share. Returns the parsed milliseconds, or null
 * when the flag is absent. Every failure names the command with the flag — `<label>`
 * (e.g. "logs --since") rides into parseDurationFlag's missing-value and malformed-duration
 * messages, the same wording the over-cap check already uses, so all three errors read
 * "logs --since …" instead of the malformed and missing-value forms naming a bare "--since".
 * Rival-flag rules stay in each command body, checked on the returned non-null value — so a
 * malformed or over-cap `--since` fails on its own wording before a rival-flag check fires,
 * the same precedence a command with only --since shows. `flag` defaults to `--since`; the
 * three windowed views read both windows through the composed parseSinceUntilFlags below.
 */
export function parseSinceFlag(args: string[], label: string, maxMs: number, flag = "--since"): number | null {
  const raw = flagValue(args, flag);
  if (raw === null) return null;
  const ms = parseDurationFlag(label, raw);
  failOverDurationCap(label, ms, maxMs);
  return ms;
}

/** The `--since <duration>` / `--until <duration>` trailing-window pair the three windowed
 * read-only views (logs, history, report) read from a command's args: both windows through
 * parseSinceFlag (one cap for the pair, the command naming every failure the windows carry)
 * and then the pair's own rule through failUntilShorterThanSince — the validate-since,
 * validate-until, check-the-pair sequence, so the three bodies cannot drift on what each
 * failure names or on which one fires first. `command` is the bare command name; it rides
 * into every message. Returns each window's parsed milliseconds, null when the flag is
 * absent. Rival-flag rules stay in each command body, as they do for a lone `--since`: a
 * malformed or over-cap value fails on its own wording before any rival check. */
export function parseSinceUntilFlags(
  args: string[],
  command: string,
  maxMs: number,
): { sinceMs: number | null; untilMs: number | null } {
  const sinceMs = parseSinceFlag(args, `${command} --since`, maxMs);
  const untilMs = parseSinceFlag(args, `${command} --until`, maxMs, "--until");
  failUntilShorterThanSince(command, untilMs, sinceMs);
  return { sinceMs, untilMs };
}

/** Parse an optional `--role <id>` flag: the validated role id, or null when absent.
 * Shared by every command that scopes to one role so their validation and error messages
 * cannot drift. `validIds` is the set of ids this command accepts — callers pass
 * knownRoleIds(config) so user-defined roles are accepted like built-ins; it defaults to the
 * catalog alone, which keeps in-process callers (and tests) that have no config working.
 */
export function parseRoleFlag(
  args: string[],
  validIds?: string[],
  flag = "--role",
  missingValue = ROLE_VALUE_ERROR,
): string | null {
  const typed = flagValue(args, flag);
  if (typed === null) return null;
  // A `--`-token in the id's slot is the operator's slipped value (`--role --json`), never a
  // role id — role ids are bare words that never start with `-` — so refuse it up front with
  // rejectFlagLookingValue's shared wording, the same guard history's --result/--model/--by
  // and reviews --status apply, instead of reporting the next flag as an "unknown role".
  rejectFlagLookingValue(flag, typed);
  if (!typed) fail(missingValue);
  const role = canonicalRoleId(typed);
  const ids = validIds ?? allRoleIds();
  if (!ids.includes(role)) fail(unknownRoleMessage(role, ids));
  return role;
}

/** Parse an optional `--branch <name>` flag: the named branch, or null when absent — the same
 * shape as parseRoleFlag, so every command that scopes to one branch validates identically.
 * A missing value fails fast instead of silently falling back to the checked-out branch. A
 * `--`-token in the slot is the operator's slipped next flag (`run --branch --json`), never a
 * branch name — a branch name never starts with `-` — so refuse it up front with
 * rejectFlagLookingValue's shared wording, the same guard every other value slot applies,
 * instead of reporting the next flag as a missing name. */
export function parseBranchFlag(args: string[]): string | null {
  const branch = flagValue(args, "--branch");
  if (branch === null) return null;
  rejectFlagLookingValue("--branch", branch);
  if (!branch || branch.startsWith("-")) fail(BRANCH_VALUE_ERROR);
  return branch;
}

/** One flag in a command's fixed argument vocabulary: every spelling it accepts and whether
 * it takes one following token as its value (named for the error message). */
