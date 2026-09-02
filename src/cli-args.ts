import fs from "node:fs";
import { allRoleIds } from "./roles.js";

/** CLI argument parsing and validation, shared by every command in cli.ts. The execution
 * layer calls these before running a command, so a bad flag fails fast with an actionable
 * message instead of the command silently running with default behavior. */

export function fail(message: string): never {
  process.stderr.write(`tumwater: ${message}\n`);
  process.exit(1);
}

/** Parse a `-n`-style count flag value: a positive integer, or fail with a clear message.
 * Unvalidated, NaN/0/negative limits make readEvents' `slice(-limit)` dump the whole log
 * (or drop leading lines) instead of showing the requested tail. */
export function parseCountFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} needs a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

/** Parse the `--port` flag value: an integer in 1..65535, or fail with a clear message.
 * Port 0 would make Node pick an ephemeral port while the CLI prints :0 — a URL that
 * cannot be opened; out-of-range values only fail later via Node's raw RangeError. */
export function parsePortFlag(raw: string | undefined): number {
  if (raw === undefined) fail("--port needs a value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    fail(`--port must be an integer between 1 and 65535 (got ${JSON.stringify(raw)})`);
  return n;
}

/** Parse an optional `--role <id>` flag: the validated role id, or null when absent.
 * Shared by every command that scopes to one loop so their validation and error messages
 * cannot drift. */
export function parseRoleFlag(args: string[]): string | null {
  const i = args.indexOf("--role");
  if (i < 0) return null;
  const role = args[i + 1];
  if (!role) fail("--role needs a role id (e.g. `--role feature`)");
  if (!allRoleIds().includes(role)) fail(`unknown role: ${role} (valid ids: ${allRoleIds().join(", ")})`);
  return role;
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

/** Fail when any argument was not consumed by this command's known flags — a misspelled flag
 * (e.g. `--rol` instead of `--role`) would otherwise be silently ignored and the command runs
 * with default behavior, which is worse than an error: `reset-counters --rol x` zeroed every
 * loop instead of one, and `gui --portt 8080` served on the default port. Valueless flags claim
 * one token; valued flags claim two (a trailing flag with no value claims only itself — the
 * command's own parser reports the missing value first). Duplicates keep their existing
 * behavior: the first occurrence wins. */
export function rejectUnknownArgs(command: string, args: string[], specs: FlagSpec[]): void {
  if (args.length === 0) return;
  const claim = new Map<string, number>();
  for (const spec of specs) for (const name of spec.names) claim.set(name, spec.value ? 2 : 1);
  const consumed = new Array<boolean>(args.length).fill(false);
  for (let i = 0; i < args.length; i++) {
    if (consumed[i]) continue;
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    const n = claim.get(arg);
    if (n === undefined) {
      const valid = specs
        .map((s) => s.names.join("/") + (s.value ? ` ${s.valueName ?? "<value>"}` : ""))
        .join(", ");
      fail(
        specs.length === 0
          ? `tumwater ${command} takes no arguments`
          : `unknown argument: ${arg} (valid flags for tumwater ${command}: ${valid})`,
      );
    }
    for (let j = 0; j < n && i + j < args.length; j++) consumed[i + j] = true;
  }
}

/** `tumwater init` argument handling. Every other command runs rejectUnknownArgs, but init's
 * positionals are free-form prompt text, so that helper (which rejects ANY unconsumed token)
 * can't be used wholesale. The rules instead: a double-dash token must be `--file`, given at
 * most once; with `--file` present nothing else may follow it; single-dash positionals are
 * prompt content, not flags. Without these checks a misspelled --file would be baked into the
 * initial prompt — injected into every tick of every loop until someone edits README.md.
 */
export function parseInitArgs(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--file") {
      fail(`unknown argument: ${arg} (valid flags for tumwater init: --file <path>)`);
    }
  }
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    if (args.filter((a) => a === "--file").length > 1) fail("--file may only be given once");
    const file = args[fileFlag + 1];
    if (!file) fail("--file needs a path");
    const extra = args.find((_, i) => i !== fileFlag && i !== fileFlag + 1);
    if (extra !== undefined) {
      fail(`unexpected argument ${JSON.stringify(extra)} — with --file the prompt comes from the file`);
    }
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      // A raw ENOENT/EISDIR names the path but not its role; say this was the --file prompt.
      fail(`cannot read prompt file ${JSON.stringify(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return args.join(" ");
}

/** The three modes of `tumwater prompt`: enqueue free-form text (the default), list the
 * queue, or cancel one entry by its 1-based position. */
type PromptArgs =
  | { mode: "enqueue"; text: string }
  | { mode: "list" }
  | { mode: "cancel"; position: number };

/** `tumwater prompt` argument handling, following parseInitArgs' pattern. Like init's,
 * positionals are free-form prompt content — but a double-dash token must be a real flag
 * (`--list`, `--cancel <n>`), or it would be baked into the queued prompt (the same class of
 * bug parseInitArgs fixed: today `tumwater prompt --foo text` enqueues "--foo text").
 * Single-dash positionals remain prompt content. `--list` and `--cancel` are mutually
 * exclusive and may not combine with positional text.
 */
export function parsePromptArgs(args: string[]): PromptArgs {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--list" && arg !== "--cancel") {
      fail(`unknown argument: ${arg} (valid flags for tumwater prompt: --list, --cancel <n>)`);
    }
  }
  const listFlag = args.indexOf("--list");
  const cancelFlag = args.indexOf("--cancel");
  if (args.filter((a) => a === "--list").length > 1) fail("--list may only be given once");
  if (args.filter((a) => a === "--cancel").length > 1) fail("--cancel may only be given once");
  if (listFlag >= 0 && cancelFlag >= 0) fail("--list and --cancel are mutually exclusive");

  if (listFlag >= 0) {
    const extra = args.find((_, i) => i !== listFlag);
    if (extra !== undefined) {
      fail(`unexpected argument ${JSON.stringify(extra)} — with --list there is no prompt text`);
    }
    return { mode: "list" };
  }

  if (cancelFlag >= 0) {
    const raw = args[cancelFlag + 1];
    if (!raw || raw.startsWith("--")) fail(`--cancel needs a position number`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) fail(`--cancel needs a positive integer (got ${JSON.stringify(raw)})`);
    // The position is the only token --cancel may carry; anything else alongside it would be
    // prompt text, and this mode has none.
    const extra = args.find((_, i) => i !== cancelFlag && i !== cancelFlag + 1);
    if (extra !== undefined) {
      fail(`unexpected argument ${JSON.stringify(extra)} — with --cancel there is no prompt text`);
    }
    return { mode: "cancel", position: n };
  }

  const text = args.join(" ").trim();
  if (!text) fail("prompt text required");
  return { mode: "enqueue", text };
}
