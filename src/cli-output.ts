/** Terminal output and exit helpers shared by every command in cli.ts and the command
 * modules: the one home of how a tumwater CLI command writes to the user (stdout lines,
 * `--json` documents, and the uniform failure exit) so the write targets and exit
 * convention cannot drift per call site. Argument parsing lives beside it in
 * cli-args.ts — a parser that fails calls fail() from this module. */

/** Write one line to stdout — the `say(text)` idiom every CLI command's user-facing output
 * renders through (status lines, confirmations, report bodies, log events), the stdout twin
 * of fail() below: `process.stdout.write(text + "\n")`, spelled once so the trailing newline
 * and the write target cannot drift per call site. Text carrying its own interior newlines
 * (multi-line reports) passes through verbatim; say() only supplies the final newline. */
export function say(text: string): void {
  process.stdout.write(text + "\n");
}

/** Print a value as pretty-printed (2-space) JSON — the `--json` output every CLI query
 * command (status, history, report, config) renders through: say()'s stdout line, with the
 * pretty-print spelling (indent 2) decided once so the machine-readable surface cannot
 * drift per command. The compact prints that are part of a sentence (config get's one-line
 * value) stay hand-rolled — this helper is the whole-document form. */
export function sayJson(value: unknown): void {
  say(JSON.stringify(value, null, 2));
}

/** Print a query command's result as `--json` or human text — the shared convention behind
 * doctor/report --since/diff/backlog --json: the flag prints the collector's own payload
 * pretty-printed, not a re-parse of the render, so every exit-0 output is parseable. The
 * payload may arrive already collected (doctor/report/diff's shape) or as a thunk (backlog's,
 * whose Markdown view is its own collection of the same files): the `--json` branch is chosen
 * FIRST, then the payload is resolved exactly once inside the branch that consumes it — a
 * thunk never runs for a discarded result, so the human path never gathers the JSON document
 * and vice versa. (status --json stays hand-rolled in cli.ts: its JSON document and human
 * table collect different data, so neither branch can feed the other.) */
export function sayJsonOrRender<T>(args: string[], payload: T | (() => T), render: (payload: T) => string): void {
  const resolve = () => (typeof payload === "function" ? (payload as () => T)() : payload);
  if (args.includes("--json")) sayJson(resolve());
  else say(render(resolve()));
}

/** The single uniform failure exit for CLI flag/argument validation and command preflight:
 * write a `tumwater: <message>` line to stderr and exit 1. Declared `never` because every
 * caller relies on it stopping execution — code after a fail() call is unreachable. */
export function fail(message: string): never {
  process.stderr.write(`tumwater: ${message}\n`);
  process.exit(1);
}