/** Terminal output and exit helpers shared by every command in cli.ts and the command
 * modules: the one home of how a tumwater CLI command writes to the user (stdout lines,
 * `--json` documents, and the uniform failure exit) so the write targets and exit
 * convention cannot drift per call site. Argument parsing lives beside it in
 * cli/cli-args.ts — a parser that fails calls fail() from this module. */
import { stripTerminalControls } from "../text/text.js";

/** The raw stdout write every helper below funnels through: one `process.stdout.write(text +
 * "\n")`, so the trailing newline and write target cannot drift per call site and the one
 * boundary that sanitizes (say) and the ones that must not (the JSON writers) share it. */
function writeLine(text: string): void {
  process.stdout.write(text + "\n");
}

/** Write one line to stdout — the `say(text)` idiom every CLI command's user-facing output
 * renders through (status lines, confirmations, report bodies, log events), the stdout twin
 * of fail() below. This is a terminal boundary: the text is stripped of terminal control
 * characters (stripTerminalControls) so model-written summaries, errors, backlog titles, and
 * transcripts cannot emit an OSC/CSI sequence into the operator's shell. Text carrying its own
 * interior newlines (multi-line reports) keeps them; say() only supplies the final newline and
 * never touches data — `--json` goes through sayJson/sayJsonLine below. */
export function say(text: string): void {
  writeLine(stripTerminalControls(text));
}

/** Print a value as pretty-printed (2-space) JSON — the `--json` output every CLI query
 * command (status, history, report, config) renders through: the pretty-print spelling
 * (indent 2) decided once so the machine-readable surface cannot drift per command. Writes
 * raw, deliberately bypassing say()'s terminal sanitization: JSON is a data surface, and
 * JSON.stringify escapes C0 but not DEL/C1, so sanitizing here would alter the bytes. */
export function sayJson(value: unknown): void {
  writeLine(JSON.stringify(value, null, 2));
}

/** One compact JSON document per line — the raw NDJSON/compact-value twin of sayJson, for
 * `--json` streams (logs) and single machine values (config get). Also bypasses say()'s
 * terminal sanitization so the data surface stays byte-exact. */
export function sayJsonLine(value: unknown): void {
  writeLine(JSON.stringify(value));
}

/** Print a query command's result as `--json` or human text — the shared convention behind
 * doctor/report --since/diff/backlog --json: the flag prints the collector's own payload
 * pretty-printed, not a re-parse of the render, so every exit-0 output is parseable. The
 * payload may arrive already collected (doctor/report/diff's shape) or as a thunk (backlog's,
 * whose Markdown view is its own collection of the same files): the `--json` branch is chosen
 * FIRST, then the payload is resolved exactly once inside the branch that consumes it — a
 * thunk never runs for a discarded result, so the human path never gathers the JSON document
 * and vice versa. (status --json stays hand-rolled in cli/cli-query-commands.ts: its JSON
 * document and human table collect different data, so neither branch can feed the other.) */
export function sayJsonOrRender<T>(args: string[], payload: T | (() => T), render: (payload: T) => string): void {
  const resolve = () => (typeof payload === "function" ? (payload as () => T)() : payload);
  if (args.includes("--json")) sayJson(resolve());
  else say(render(resolve()));
}

/** The single uniform failure exit for CLI flag/argument validation and command preflight:
 * write a `tumwater: <message>` line to stderr and exit 1. Declared `never` because every
 * caller relies on it stopping execution — code after a fail() call is unreachable. Like
 * say(), this is a terminal boundary: the message is stripped of terminal control characters,
 * because a validation error echoes values from tumwater.json (validateConfig through
 * loadConfigSafe), and JSON.stringify escapes C0 but not DEL/C1 — a config value carrying a
 * raw C1 sequence would otherwise reach the operator's terminal as-is. */
export function fail(message: string): never {
  process.stderr.write(`tumwater: ${stripTerminalControls(message)}\n`);
  process.exit(1);
}
