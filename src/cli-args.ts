import fs from "node:fs";
import { knownRoleIds, loadConfigCached } from "./config.js";
import { allRoleIds } from "./roles.js";
import { errorMessage, parsePositiveInt } from "./text.js";

/** CLI argument parsing and validation, shared by every command in cli.ts. The execution
 * layer calls these before running a command, so a bad flag fails fast with an actionable
 * message instead of the command silently running with default behavior. The plain-decimal
 * integer core (parsePositiveInt/parseNonNegativeInt) lives in text.ts — shared by these flags
 * and gui.ts's query-param validation, so one definition of a valid count/position covers both
 * input surfaces without the UI layer importing this module. */

/** Write one line to stdout — the `say(text)` idiom every CLI command's user-facing output
 * renders through (status lines, confirmations, report bodies, log events), the stdout twin
 * of fail() below: `process.stdout.write(text + "\n")`, spelled once so the trailing newline
 * and the write target cannot drift per call site. Text carrying its own interior newlines
 * (multi-line reports) passes through verbatim; say() only supplies the final newline. */
export function say(text: string): void {
  process.stdout.write(text + "\n");
}

/** The single uniform failure exit for CLI flag/argument validation and command preflight:
 * write a `tumwater: <message>` line to stderr and exit 1. Declared `never` because every
 * caller relies on it stopping execution — code after a fail() call is unreachable. */
export function fail(message: string): never {
  process.stderr.write(`tumwater: ${message}\n`);
  process.exit(1);
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

/** Parse a `-n`-style count flag value: a positive integer, or fail with a clear message.
 * Unvalidated, NaN/0/negative limits make readEvents' `slice(-limit)` dump the whole log
 * (or drop leading lines) instead of showing the requested tail. */
export function parseCountFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  const n = parsePositiveInt(raw);
  if (n === null) fail(`${flag} needs a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

/** Resolve a read-only command's `--role <id>` scope: the role id, or null when the flag is
 * absent. The id is validated against built-ins PLUS user-defined loops, read through
 * loadConfigCached (which never throws) so a transiently broken tumwater.json cannot take a
 * read-only view down — a broken file falls back to the built-in catalog rather than refusing
 * every id. Without --role no config is read. (State-changing commands instead resolve --role
 * against loadConfig and fail loudly on a broken file, as operator-commands.ts does.) Shared
 * by the tail views that scope their output to one loop (cmdLogs, cmdHistory). */
export function parseRoleScope(root: string, args: string[]): string | null {
  if (!args.includes("--role")) return null;
  const { config } = loadConfigCached(root);
  return parseRoleFlag(args, config ? knownRoleIds(config) : allRoleIds());
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

/** Parse an optional `--role <id>` flag: the validated role id, or null when absent.
 * Shared by every command that scopes to one loop so their validation and error messages
 * cannot drift. `validIds` is the set of ids this command accepts — callers pass
 * knownRoleIds(config) so user-defined loops are accepted like built-ins; it defaults to the
 * catalog alone, which keeps in-process callers (and tests) that have no config working.
 */
export function parseRoleFlag(args: string[], validIds?: string[]): string | null {
  const role = flagValue(args, "--role");
  if (role === null) return null;
  if (!role) fail("--role needs a role id (e.g. `--role feature`)");
  const ids = validIds ?? allRoleIds();
  if (!ids.includes(role)) fail(`unknown role: ${role} (valid ids: ${ids.join(", ")})`);
  return role;
}

/** Parse an optional `--branch <name>` flag: the named branch, or null when absent — the same
 * shape as parseRoleFlag, so every command that scopes to one branch validates identically.
 * A missing value fails fast instead of silently falling back to the checked-out branch. */
export function parseBranchFlag(args: string[]): string | null {
  const branch = flagValue(args, "--branch");
  if (branch === null) return null;
  if (!branch || branch.startsWith("-"))
    fail("--branch needs a branch name (e.g. `--branch release/2.0`)");
  return branch;
}

/** One flag in a command's fixed argument vocabulary: every spelling it accepts and whether
 * it takes one following token as its value (named for the error message). */
interface FlagSpec {
  /** Every accepted spelling, e.g. ["-f", "--follow"]. */
  names: string[];
  /** True when the flag consumes one following token as its value. */
  value?: boolean;
  /** How the value is named in error messages (e.g. "<id>"); defaults to "<value>". */
  valueName?: string;
}

/** The `--role <id>` flag spec, shared by every role-targeting command (logs, reset-counters,
 * wake, abort, pause, resume): one definition of the flag's spelling and value shape so the
 * accepted vocabulary and its rendering in rejectUnknownArgs' error messages cannot drift
 * apart. */
export const ROLE_FLAG: FlagSpec = { names: ["--role"], value: true, valueName: "<id>" };

/** The `--for <duration>` flag spec, accepted by `pause` alone (the timed pause): one
 * definition of the flag's spelling and value shape, beside ROLE_FLAG, so the gate's accepted
 * vocabulary and parseDurationFlag's error messages cannot drift apart. */
export const DURATION_FLAG: FlagSpec = { names: ["--for"], value: true, valueName: "<duration>" };

/** `tumwater run`'s flag vocabulary: `--branch <name>` (the target branch, parsed by
 * parseBranchFlag), `--once` (one full round of ticks, then exit), and `--role <id>`
 * (scope a --once round to one loop, parsed by parseRoleFlag). Exported so the
 * caller's rejectUnknownArgs check and its tests share one definition of what `run`
 * accepts — before this vocabulary existed, run parsed --branch and silently ignored
 * every other flag, so a typo'd option ran the daemon with default behavior. */
export const RUN_FLAG_SPECS: FlagSpec[] = [
  { names: ["--branch"], value: true, valueName: "<name>" },
  { names: ["--once"] },
  ROLE_FLAG,
];

/** Fail when any argument was not consumed by this command's known flags — a misspelled flag
 * (e.g. `--rol` instead of `--role`) would otherwise be silently ignored and the command runs
 * with default behavior, which is worse than an error: `reset-counters --rol x` zeroed every
 * loop instead of one, and `gui --portt 8080` served on the default port. Valueless flags claim
 * one token; valued flags claim two (a trailing flag with no value claims only itself — the
 * command's own parser reports the missing value first). A repeated flag fails: the parsers
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
    const n = spec.value ? 2 : 1;
    for (let j = 0; j < n && i + j < args.length; j++) consumed[i + j] = true;
  }
}

/** Fail when any token is not at one of the `claimed` positions — the shared "no extra tokens"
 * check for commands whose positionals are free-form prompt text (init, prompt): with their
 * flags present, every other token would be silently baked into the prompt. Names the first
 * stray token in the standard `unexpected argument <json> — <reason>` shape so the call sites'
 * messages cannot drift. */
function failStrayArg(args: string[], reason: string, ...claimed: number[]): void {
  const extra = args.find((_, i) => !claimed.includes(i));
  if (extra !== undefined) fail(`unexpected argument ${JSON.stringify(extra)} — ${reason}`);
}

/** init's valueless flags (plans/portability.md §7/7, correction 1): each at most once, and
 * never prompt content. */
const INIT_BOOLEAN_FLAGS: readonly string[] = ["--adopt", "--dry-run"];

/** `tumwater init` argument handling. Every other command runs rejectUnknownArgs, but init's
 * positionals are free-form prompt text, so that helper (which rejects ANY unconsumed token)
 * can't be used wholesale. The rules instead: a double-dash token must be `--file`,
 * `--branch`, `--adopt` or `--dry-run`, each given at most once; with `--file` present nothing
 * but the other flags may accompany it; a `--branch <name>` pair and the two booleans are never
 * prompt content; single-dash positionals are prompt content, not flags. Without these checks a
 * misspelled --file would be baked into the initial prompt — injected into every tick of every
 * loop until someone edits the project brief. */
export function parseInitArgs(args: string[]): {
  prompt: string;
  branch: string | null;
  adopt: boolean;
  dryRun: boolean;
} {
  const known = ["--file", "--branch", ...INIT_BOOLEAN_FLAGS];
  for (const arg of args) {
    if (arg.startsWith("--") && !known.includes(arg)) {
      fail(
        `unknown argument: ${arg} (valid flags for tumwater init: --file <path>, --branch <name>, --adopt, --dry-run)`,
      );
    }
  }
  for (const flag of known) {
    if (args.filter((a) => a === flag).length > 1) fail(`${flag} may only be given once`);
  }
  const branch = parseBranchFlag(args);
  const adopt = args.includes("--adopt");
  const dryRun = args.includes("--dry-run");
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    const file = args[fileFlag + 1];
    if (!file) fail("--file needs a path");
    const claimed = [fileFlag, fileFlag + 1];
    const branchFlag = args.indexOf("--branch");
    if (branchFlag >= 0) claimed.push(branchFlag, branchFlag + 1);
    for (const flag of INIT_BOOLEAN_FLAGS) {
      if (args.includes(flag)) claimed.push(args.indexOf(flag));
    }
    failStrayArg(args, "with --file the prompt comes from the file", ...claimed);
    try {
      return { prompt: fs.readFileSync(file, "utf8"), branch, adopt, dryRun };
    } catch (err) {
      // A raw ENOENT/EISDIR names the path but not its role; say this was the --file prompt.
      fail(`cannot read prompt file ${JSON.stringify(file)}: ${errorMessage(err)}`);
    }
  }
  // Everything except the --branch pair and the booleans is prompt text; the join keeps
  // single-dash tokens as content, exactly as before — with no flag present this is the old
  // args.join(" ").
  const promptTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--branch") i++; // Skip the pair's value too.
    else if (!INIT_BOOLEAN_FLAGS.includes(arg)) promptTokens.push(arg);
  }
  return { prompt: promptTokens.join(" "), branch, adopt, dryRun };
}

/** The three modes of `tumwater prompt`: enqueue free-form text (the default), list the
 * queue, or cancel one entry by its 1-based position. `role` is the raw `--role <id>` value
 * (null when absent) — cli.ts validates it against the live config, since this parser has no
 * config to read. */
type PromptArgs =
  | { mode: "enqueue"; role: string | null; text: string }
  | { mode: "list"; role: string | null }
  | { mode: "cancel"; role: string | null; position: number };

/** `tumwater prompt` argument handling, following parseInitArgs' pattern. Like init's,
 * positionals are free-form prompt content — but a double-dash token must be a real flag
 * (`--role <id>`, `--list`, `--cancel <n>`), or it would be baked into the queued prompt (the
 * same class of bug parseInitArgs fixed: today `tumwater prompt --foo text` enqueues
 * "--foo text"). Single-dash positionals remain prompt content. `--list` and `--cancel` are
 * mutually exclusive and may not combine with positional text; `--role` is accepted in every
 * mode (PLANS.md "Per-role prompts 1/2") and is never prompt content. */
export function parsePromptArgs(args: string[]): PromptArgs {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--list" && arg !== "--cancel" && arg !== "--role") {
      fail(`unknown argument: ${arg} (valid flags for tumwater prompt: --role <id>, --list, --cancel <n>)`);
    }
  }
  const listFlag = args.indexOf("--list");
  const cancelFlag = args.indexOf("--cancel");
  if (args.filter((a) => a === "--list").length > 1) fail("--list may only be given once");
  if (args.filter((a) => a === "--cancel").length > 1) fail("--cancel may only be given once");
  if (listFlag >= 0 && cancelFlag >= 0) fail("--list and --cancel are mutually exclusive");

  const roleFlag = args.indexOf("--role");
  if (args.filter((a) => a === "--role").length > 1) fail("--role may only be given once");
  const roleRaw = roleFlag >= 0 ? args[roleFlag + 1] : undefined;
  if (roleFlag >= 0 && (!roleRaw || roleRaw.startsWith("--"))) {
    fail("--role needs a role id (e.g. `--role feature`)");
  }
  const role = roleRaw ?? null;
  // The flag and its value are never prompt content: --role is a scope, not text. Only claimed
  // when actually present — negative indexes would over-claim real tokens.
  const roleClaim = roleFlag >= 0 ? [roleFlag, roleFlag + 1] : [];

  if (listFlag >= 0) {
    failStrayArg(args, "with --list there is no prompt text", listFlag, ...roleClaim);
    return { mode: "list", role };
  }

  if (cancelFlag >= 0) {
    const raw = args[cancelFlag + 1];
    // A missing value is its own error, carrying an example like --role's message; a
    // flag-looking value falls through to parsePositiveInt and is named in the got-value
    // message like every other count/duration flag — a bare-text error that swallowed the
    // offending token left `tumwater prompt --cancel --role feature` guessing what arrived.
    if (raw === undefined) fail(`--cancel needs a position number (e.g. \`--cancel 2\`)`);
    const n = parsePositiveInt(raw);
    if (n === null) fail(`--cancel needs a positive integer (got ${JSON.stringify(raw)})`);
    // The position is the only token --cancel may carry; anything else alongside it would be
    // prompt text, and this mode has none.
    failStrayArg(args, "with --cancel there is no prompt text", cancelFlag, cancelFlag + 1, ...roleClaim);
    return { mode: "cancel", role, position: n };
  }

  // Everything except the --role pair is prompt text; the join keeps multi-word requests as
  // one string exactly like the pre-1/2 behavior.
  const text = args
    .filter((_, i) => !roleClaim.includes(i))
    .join(" ")
    .trim();
  if (!text) fail("prompt text required");
  return { mode: "enqueue", role, text };
}
