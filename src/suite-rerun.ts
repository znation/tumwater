/** Detecting a reviewer run that re-ran the full suite on a tree the gate's pre-check already
 * verified — pure string logic over the bash command lines a pi run started, no subprocess or
 * file I/O. The review prompt tells such a reviewer not to (src/gate-prompts.ts), but on
 * 2026-09-23 two reviewers that got the instruction copied their lander worktree to /tmp and ran
 * `npm ci` and `npm test` there anyway, holding the landing slot and loading the shared host;
 * 102 of 429 retained review sessions ran a suite or `npm ci` themselves (BUGS.md 2026-09-23).
 * The prompt is the fix, this is the tripwire: review.ts feeds the reviewer's tool calls through
 * suiteRerunWarning and logs a warning when the rule was broken, so the digest can count it.
 *
 * The patterns are the ones reviewers actually used: `npm test` / `npm run test` (and npm's
 * aliases for them) with no filter argument, tumwater's own `node …/test-runner.js` with no
 * filter, and `npm ci`. A filter argument (`npm test gui`, `test-runner.js merge`) selects
 * specific test files, which the prompt allows for a concrete reason, so it is never flagged; a
 * project whose declared check is a configured non-npm command goes undetected (the prompt rule
 * still covers it). A shell-parse heuristic, not a shell: quoted text is treated as data, and
 * compound lines are split on their operators. A warning costs one event row, so an edge case
 * that slips through either way is cheap. */

import path from "node:path";
import { collapseWhitespace, truncate } from "./text.js";

/** One tool call as pi started it (a `tool_execution_start` event): the tool's name — empty
 * when pi omitted it — and its raw args (bash: `{ command }`). */
export interface ToolCallStart {
  toolName: string;
  args: unknown;
}

/** npm's names for its `test`, `run-script`, and `ci` commands (npm's own alias tables), so
 * `npm t` and `npm run-script test` count the same as `npm test`. */
const NPM_TEST = new Set(["test", "t", "tst"]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_CI = new Set(["ci", "clean-install", "ic", "install-clean", "isntall-clean"]);

/** Words that can precede the command itself in one segment of a shell line (`do npm test` in
 * a for loop, `time npm test`, `env CI=1 npm test`) — skipped before the command is read. */
const PREFIX_WORDS = new Set(["do", "then", "else", "time", "exec", "nohup", "env", "command", "!"]);

/** Where one shell line splits into separate commands: `&&`, `||`, `;`, `|`, newlines, subshell
 * and group brackets, and a backgrounding `&` — but not the `&` of a redirection (`2>&1`, `&>`). */
const SEGMENT_SPLIT = /&&|\|\||[;|\n(){}]|(?<![<>])&(?!>)/;

/** A redirection operator standing alone (`>`, `2>`, `>>`, `&>`, `<`): its target is the next
 * word. */
const BARE_REDIRECT = /^\d*(?:>>?|&>>?|<)$/;

/** A redirection with its target attached (`2>&1`, `>out.txt`, `<<EOF`). */
const ATTACHED_REDIRECT = /^\d*(?:>|&>|<)/;

/** The words of one command segment with redirections removed — a redirect target is a path,
 * not an argument, so `npm test > /tmp/out.txt 2>&1` must read as `npm test` with no filter —
 * and with leading keywords and environment assignments (`TRACE=1 node …`) skipped. */
function commandWords(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (BARE_REDIRECT.test(token)) i++; // drop the operator and its target
    else if (!ATTACHED_REDIRECT.test(token)) words.push(token);
  }
  let start = 0;
  while (start < words.length) {
    const w = words[start] ?? "";
    if (!PREFIX_WORDS.has(w) && !/^[A-Za-z_]\w*=/.test(w)) break;
    start++;
  }
  return words.slice(start);
}

/** True when `args` (what follows the script or subcommand) carries a positional argument — a
 * test filter — rather than only option flags. Anything after a bare `--` is passed through to
 * the script, so it counts as a filter whatever its shape. */
function hasFilter(args: readonly string[]): boolean {
  const dashDash = args.indexOf("--");
  if (dashDash >= 0 && dashDash < args.length - 1) return true;
  return args.some((a) => !a.startsWith("-"));
}

/** Index of the first word at or after `from` that is not an option flag, or -1. */
function firstNonFlag(words: readonly string[], from: number): number {
  for (let i = from; i < words.length; i++) if (!(words[i] ?? "").startsWith("-")) return i;
  return -1;
}

/** True when one command segment's words run the full suite or reinstall dependencies. */
function segmentRunsFullSuite(words: readonly string[]): boolean {
  const bin = path.basename(words[0] ?? "");
  if (bin === "npm") {
    const sub = firstNonFlag(words, 1);
    if (sub < 0) return false;
    const name = words[sub] ?? "";
    // Reinstalling dependencies is the setup of a scratch-copy suite run; a dry run installs
    // nothing (a reviewer checking a lockfile change).
    if (NPM_CI.has(name)) return !words.includes("--dry-run");
    if (NPM_TEST.has(name)) return !hasFilter(words.slice(sub + 1));
    if (NPM_RUN.has(name)) {
      const script = firstNonFlag(words, sub + 1);
      return script >= 0 && words[script] === "test" && !hasFilter(words.slice(script + 1));
    }
    return false;
  }
  if (bin === "node") {
    // `node dist/src/test-runner.js` — what `npm test` runs after compiling. The runner must be
    // node's entry point: a `sed -n 1,80p src/test-runner.ts` read or a `pkill -f test-runner`
    // names the file without running it.
    const entry = firstNonFlag(words, 1);
    return entry >= 0 && (words[entry] ?? "").endsWith("test-runner.js") && !hasFilter(words.slice(entry + 1));
  }
  return false;
}

/** True when one bash command line runs the project's full test suite (no filter) or `npm ci`
 * anywhere in it — `cd /tmp/revrun && npm test 2>&1 | tail -15` does, `npm test gui` does not.
 * Exported for its own unit tests. */
export function runsFullSuite(command: string): boolean {
  // Quoted text is data (a `grep -E "a|npm test"` pattern, an echoed label), never a command:
  // blank it before splitting so its operators cannot cut out a phantom `npm test` segment.
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return unquoted.split(SEGMENT_SPLIT).some((segment) => segmentRunsFullSuite(commandWords(segment)));
}

/** The bash command line of one started tool call, or undefined for any other tool. pi omits
 * toolName on some start events, so a nameless call carrying a string `command` counts too. */
function bashCommand(call: ToolCallStart): string | undefined {
  if (call.toolName !== "bash" && call.toolName !== "") return undefined;
  const command = (call.args as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" ? command : undefined;
}

/** The warning for a reviewer run whose tool calls re-ran the full suite on a tree the harness
 * already verified, or undefined when none did. One warning per run, naming the first offending
 * command (clipped) and how many more followed, behind a fixed prefix so the digest clusters
 * every occurrence together. The caller decides whether a verified result existed. */
export function suiteRerunWarning(calls: readonly ToolCallStart[]): string | undefined {
  const reruns = calls.map(bashCommand).filter((c): c is string => c !== undefined && runsFullSuite(c));
  const first = reruns[0];
  if (first === undefined) return undefined;
  const more = reruns.length > 1 ? ` (+${reruns.length - 1} more)` : "";
  return `reviewer re-ran the suite the harness's pre-check already verified: ${truncate(collapseWhitespace(first), 160)}${more}`;
}
