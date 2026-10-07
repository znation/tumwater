/** Detecting a reviewer run that re-ran the full suite on a tree the gate's pre-check already
 * verified — pure string logic over the bash command lines a pi run started, no subprocess or
 * file I/O. The review prompt tells such a reviewer not to (src/gates/gate-prompts.ts), but on
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
import { squash } from "../text/text.js";
import { moreSuffix } from "../text/phrases.js";

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

/** npm's global options that consume the next word as their value (`npm --prefix /tmp/rev
 * test`, `npm -C /tmp/rev test`, `npm --registry http://r npm test`): a scanner that skips only
 * flag tokens reads `/tmp/rev` as the subcommand and the line reads as an innocuous npm call.
 * `--flag=value` form needs no entry — it is one token and starts with `-`. Kept to the options
 * a suite-running reviewer plausibly reaches for; an unlisted value-taking flag costs one missed
 * warning, exactly what this table exists to prevent (BUGS.md 2026-09-29). */
const NPM_VALUE_FLAGS = new Set([
  "--prefix",
  "-C",
  "--cache",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--loglevel",
  "--workspace",
  "-w",
  "--omit",
]);

/** The same for node's own options before the entry point (`node --max-old-space-size 4096
 * dist/test/test-runner.js`): `--eval`'s value is code the value-skipping scan should not
 * mistake for the runner path. */
const NODE_VALUE_FLAGS = new Set([
  "--max-old-space-size",
  "--stack-size",
  "--require",
  "-r",
  "--conditions",
  "--cpu-prof-dir",
  "--eval",
  "-e",
]);

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
 * the script, so it counts as a filter whatever its shape. A value-taking flag's value is the
 * flag's, not the script's, so `npm test --prefix /tmp/rev` is unfiltered too. */
function hasFilter(args: readonly string[], valueFlags?: ReadonlySet<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") return i < args.length - 1;
    if (!a.startsWith("-")) return true;
    if (valueFlags?.has(a)) i++; // the flag consumes the next word as its value
  }
  return false;
}

/** Index of the first word at or after `from` that is not an option flag — counting the next
 * word as part of any value-taking flag in `valueFlags` — or -1. */
function firstNonFlag(words: readonly string[], from: number, valueFlags?: ReadonlySet<string>): number {
  for (let i = from; i < words.length; i++) {
    const w = words[i] ?? "";
    if (!w.startsWith("-")) return i;
    if (valueFlags?.has(w)) i++; // the flag consumes the next word as its value
  }
  return -1;
}

/** True when one command segment's words run the full suite or reinstall dependencies. */
function segmentRunsFullSuite(words: readonly string[]): boolean {
  const bin = path.basename(words[0] ?? "");
  if (bin === "npm") {
    // Value-skipping everywhere npm flags can appear, including after the subcommand (`npm run
    // --prefix /tmp/rev test`): without it the flag's value reads as the subcommand or script
    // name and a copied-tree suite run goes unflagged (BUGS.md 2026-09-29).
    const sub = firstNonFlag(words, 1, NPM_VALUE_FLAGS);
    if (sub < 0) return false;
    const name = words[sub] ?? "";
    // Reinstalling dependencies is the setup of a scratch-copy suite run; a dry run installs
    // nothing (a reviewer checking a lockfile change).
    if (NPM_CI.has(name)) return !words.includes("--dry-run");
    if (NPM_TEST.has(name)) return !hasFilter(words.slice(sub + 1), NPM_VALUE_FLAGS);
    if (NPM_RUN.has(name)) {
      const script = firstNonFlag(words, sub + 1, NPM_VALUE_FLAGS);
      return script >= 0 && words[script] === "test" && !hasFilter(words.slice(script + 1), NPM_VALUE_FLAGS);
    }
    return false;
  }
  if (bin === "node") {
    // `node dist/test/test-runner.js` — what `npm test` runs after compiling. The runner must be
    // node's entry point: a `sed -n 1,80p test/test-runner.ts` read or a `pkill -f test-runner`
    // names the file without running it.
    const entry = firstNonFlag(words, 1, NODE_VALUE_FLAGS);
    return entry >= 0 && (words[entry] ?? "").endsWith("test-runner.js") && !hasFilter(words.slice(entry + 1), NODE_VALUE_FLAGS);
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
  const more = moreSuffix(reruns.length - 1);
  return `reviewer re-ran the suite the harness's pre-check already verified: ${squash(first, 160)}${more}`;
}
