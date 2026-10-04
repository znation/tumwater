import { fail } from "./cli-output.js";
import { knownRoleIdsCached } from "./config.js";
import { allRoleIds, unknownRoleMessage } from "./roles.js";
import { parsePositiveInt } from "./text.js";

/** CLI argument parsing and validation, shared by every command in cli.ts. The execution
 * layer calls these before running a command, so a bad flag fails fast with an actionable
 * message instead of the command silently running with default behavior. The plain-decimal
 * integer core (parsePositiveInt/parseNonNegativeInt) lives in text.ts — shared by these flags
 * and gui-args.ts's query-param validation, so one definition of a valid count/position covers both
 * input surfaces without the UI layer importing this module. The two commands whose positionals
 * are free-form prompt text (`init`, `prompt`) parse their own args in cli-command-args.ts —
 * their rules contradict this module's reject-everything-left-over contract, and `--file`'s
 * readFileSync would be this module's only I/O. Terminal output and the failure exit live in
 * cli-output.ts — this module's parsers fail through fail() from there, but they do not
 * write output of their own. */

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
  const i = args.indexOf("--grep");
  const rest = i >= 0 ? args.filter((_, j) => j !== i + 1) : args;
  const raw = flagValue(args, "--grep");
  if (raw === null) return { rest, pattern: null };
  if (raw === undefined || raw === "") fail(missingValueError);
  return { rest, pattern: raw };
}

/** Parse a `-n`-style count flag value: a positive integer, or fail with a clear message.
 * Unvalidated, NaN/0/negative limits make readEvents' `slice(-limit)` dump the whole log
 * (or drop leading lines) instead of showing the requested tail. With `max`, the count is
 * also capped — the shared `must be between 1 and <max>` wording — so a huge bound can't
 * grow the result until the process runs out of memory (report's per-day series, history's
 * scanned window). */
export function parseCountFlag(flag: string, raw: string | undefined, max?: number): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  const n = parsePositiveInt(raw);
  if (n === null) fail(`${flag} needs a positive integer (got ${JSON.stringify(raw)})`);
  if (max !== undefined && n > max)
    fail(`${flag} must be between 1 and ${max} (got ${JSON.stringify(raw)})`);
  return n;
}

/** Resolve a read-only command's `--role <id>` scope: the role id, or null when the flag is
 * absent. The id is validated against built-ins PLUS user-defined loops, read through
 * loadConfigCached (which never throws) so a transiently broken tumwater.json cannot take a
 * read-only view down — a broken file falls back to the built-in catalog rather than refusing
 * every id. Without --role no config is read. (State-changing commands instead resolve --role
 * against loadConfig and fail loudly on a broken file, as operator-commands.ts and
 * prompt-commands.ts do.) The id
 * set comes from config.knownRoleIdsCached, the one home of the cached-with-built-in-fallback
 * rule. Shared by the tail views that scope their output to one loop (cmdLogs, cmdHistory). */
export function parseRoleScope(root: string, args: string[]): string | null {
  if (!args.includes("--role")) return null;
  return parseRoleFlag(args, knownRoleIdsCached(root));
}

/** Parse the `--port` flag value: an integer in 1..65535, or fail with a clear message.
 * Port 0 would make Node pick an ephemeral port while the CLI prints :0 — a URL that
 * cannot be opened; out-of-range values only fail later via Node's raw RangeError. */
export function parsePortFlag(raw: string | undefined): number {
  if (raw === undefined) fail("--port needs a value");
  const n = parsePositiveInt(raw);
  if (n === null || n > 65535)
    fail(`--port must be an integer between 1 and 65535 (got ${JSON.stringify(raw)})`);
  return n;
}

/** Milliseconds per unit, the multiplier parseDurationFlag's regex group is applied to. */
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parse a `--for <duration>` flag value: `<n>` followed by one unit `s`/`m`/`h`/`d`
 * (e.g. `45s`, `90m`, `2h`, `1d`), or fail with a clear message; returns the duration in
 * milliseconds. Zero and negative durations would write a pause marker that reads as already
 * expired — a pause that pauses nothing — so they fail like any other malformed value. No
 * absolute `--at` form: one way of saying "pause for a while".
 * Exported for tests and for the pause confirmations' duration phrasing (durationLabel). */
export function parseDurationFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  const m = /^(\d+)([smhd])$/.exec(raw);
  if (!m || Number(m[1]) === 0)
    fail(`${flag} needs a duration like 45s, 90m, 2h, or 1d (got ${JSON.stringify(raw)})`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

/** The human phrase for a parseDurationFlag duration (`45000` → `45s`, `5400000` → `90m`):
 * the same `<n><unit>` vocabulary the parser accepts, so a pause confirmation echoes back a
 * form the operator could re-type. The largest unit the duration divides into evenly wins, so
 * a whole hour reads `1h`, not `60m`; sub-second remains are impossible (the parser's units
 * bottom out at seconds). Lives beside parseDurationFlag so phrase and parser cannot drift. */
export function durationLabel(ms: number): string {
  for (const [unit, size] of Object.entries(UNIT_MS).reverse() as [keyof typeof UNIT_MS, number][]) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`; // Unreachable: every whole-second duration divides into the `s` unit.
}

/** The shared over-cap check for duration-valued flags: fail with the one message shape —
 * `<flag> is capped at <max label> (got <value label>)` — so every capped duration names
 * both bounds in the same phrasing and the sites cannot drift apart (the same idiom the
 * --since windows and pause --for share). Callers parse the flag themselves and pass only
 * the parsed value and its cap; a value at or under the cap returns silently. An optional
 * hint appends command-specific guidance after the got-label, as pause --for points at the
 * standing-pause alternative. */
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

/** Read an optional `--since <duration>` window from a command's args and cap it: the one
 * home of the flagValue → parseDurationFlag → failOverDurationCap idiom the three windowed
 * read-only views (logs, history, report) share. Returns the parsed milliseconds, or null
 * when the flag is absent. A malformed value fails with parseDurationFlag's message and an
 * over-cap window with failOverDurationCap's, named `<label>` (e.g. "logs --since").
 * Rival-flag rules stay in each command body, checked on the returned non-null value — so a
 * malformed or over-cap `--since` fails on its own wording before a rival-flag check fires,
 * the same precedence a command with only --since shows. */
export function parseSinceFlag(args: string[], label: string, maxMs: number): number | null {
  const raw = flagValue(args, "--since");
  if (raw === null) return null;
  const ms = parseDurationFlag("--since", raw);
  failOverDurationCap(label, ms, maxMs);
  return ms;
}

/** Parse an optional `--role <id>` flag: the validated role id, or null when absent.
 * Shared by every command that scopes to one loop so their validation and error messages
 * cannot drift. `validIds` is the set of ids this command accepts — callers pass
 * knownRoleIds(config) so user-defined loops are accepted like built-ins; it defaults to the
 * catalog alone, which keeps in-process callers (and tests) that have no config working.
 */
export function parseRoleFlag(args: string[], validIds?: string[]): string | null {
  const role = flagValue(args, "--role");
  if (role === null) return null;
  if (!role) fail(ROLE_VALUE_ERROR);
  const ids = validIds ?? allRoleIds();
  if (!ids.includes(role)) fail(unknownRoleMessage(role, ids));
  return role;
}

/** Parse an optional `--branch <name>` flag: the named branch, or null when absent — the same
 * shape as parseRoleFlag, so every command that scopes to one branch validates identically.
 * A missing value fails fast instead of silently falling back to the checked-out branch. */
export function parseBranchFlag(args: string[]): string | null {
  const branch = flagValue(args, "--branch");
  if (branch === null) return null;
  if (!branch || branch.startsWith("-")) fail(BRANCH_VALUE_ERROR);
  return branch;
}

/** One flag in a command's fixed argument vocabulary: every spelling it accepts and whether
 * it takes one following token as its value (named for the error message). */
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
/** The missing-or-flag-shaped-value error parseBranchFlag shares with RUN_FLAG_SPECS'
 * --branch entry, for the same no-drift reason. */
const BRANCH_VALUE_ERROR = "--branch needs a branch name (e.g. `--branch release/2.0`)";

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

/** The `--for <duration>` flag spec, accepted by `pause` alone (the timed pause): one
 * definition of the flag's spelling and value shape, beside ROLE_FLAG, so the gate's accepted
 * vocabulary and parseDurationFlag's error messages cannot drift apart. validate re-runs the
 * shape parser at the gate, so `pause --for xyz` names the typo before the ready-repo gate
 * can mask it; the 90-day cap stays in cmdPause beside the writers it feeds. */
export const DURATION_FLAG: FlagSpec = {
  names: ["--for"],
  value: true,
  valueName: "<duration>",
  validate: (value) => {
    parseDurationFlag("--for", value);
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

/** The `--since <duration>` flag spec, shared by the three windowed read-only views (logs,
 * history, report): one definition of the flag's spelling and value shape, beside ROLE_FLAG
 * and DURATION_FLAG, so the gate's accepted vocabulary and parseDurationFlag's error messages
 * cannot drift apart. validate re-runs the shape parser at the gate; each window's 7-day cap
 * and its rival-flag rules stay in the command body beside the window read they bound. */
export const SINCE_FLAG: FlagSpec = {
  names: ["--since"],
  value: true,
  valueName: "<duration>",
  validate: (value) => {
    parseDurationFlag("--since", value);
  },
};

/** The `-n <count>` flag spec, shared by the two tail views that take a row count (logs,
 * history): one definition of the flag's spelling and value shape, beside SINCE_FLAG, so the
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
 * the flag's spelling, beside ROLE_FLAG and SINCE_FLAG, so the gate's accepted vocabulary
 * cannot drift apart. It takes no value and carries no per-command wording — unlike its
 * siblings it needs neither a factory nor a missing-value error — so the constant is the
 * whole spec, and the render-vs-JSON switch stays in each command body beside its render. */
export const JSON_FLAG: FlagSpec = { names: ["--json"] };

/** The `--grep <text>` flag spec shared by the two filtering views (logs, history): one
 * definition of the flag's spelling and value shape, beside ROLE_FLAG and SINCE_FLAG, so the
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
 * initialized repo. A repeated flag fails: the parsers
 * below read flags with indexOf, so a second occurrence used to be silently dropped and the
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
      const valid = specs
        .map((s) => s.names.join("/") + (s.value ? ` ${s.valueName ?? "<value>"}` : ""))
        .join(", ");
      fail(
        specs.length === 0
          ? `tumwater ${command} takes no arguments`
          : `unknown argument: ${arg} (valid flags for tumwater ${command}: ${valid})`,
      );
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

