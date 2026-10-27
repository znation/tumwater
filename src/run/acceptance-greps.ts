/** The pre-queue self-check's acceptance-grep runner: a finished plan entry that says a `grep …`
 * "finds nothing" is checked by running that grep in the worktree, so a change is not rejected
 * for an acceptance grep that still matches. Only the strict "matches nothing" form runs;
 * criteria worded "prints only …" need judgement and stay out. Staging-only (stage-check.ts). */

import { execFileAsync } from "../process/process.js";
import { moreSuffix } from "../text/phrases.js";
import { collapseWhitespace, truncate } from "../text/text.js";

const MAX_CRITERIA = 5;
const GREP_TIMEOUT_MS = 20_000;

const EMPTY_PHRASE_RE = new RegExp(
  "^\\s*(?:(?:finds|prints|returns|outputs|matches|lists) nothing|is empty|lists none|" +
    "(?:prints|finds|lists|returns|gives|shows) no (?:lines?|hits?|matches?|output))",
  "i",
);
const ALLOWANCE_RE = /apart from|except|excluding|other than|besides|beyond/i;

/** The backticked `grep …`/`git grep …` commands in `body` that the text says match nothing
 * ("finds nothing", "is empty", …), without duplicates, in body order, at most five. A criterion
 * whose sentence (up to the next `.` or `;`) allows some hits ("apart from", "except", …) is
 * dropped. */
export function emptyGrepCriteria(body: string): string[] {
  const text = collapseWhitespace(body);
  const found: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const cmd = m[1] ?? "";
    if (!/^(?:git )?grep /.test(cmd)) continue;
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const phrase = EMPTY_PHRASE_RE.exec(rest);
    if (phrase === null) continue;
    const sentence = rest.slice(0, rest.search(/[.;]/) === -1 ? undefined : rest.search(/[.;]/));
    if (ALLOWANCE_RE.test(sentence)) continue;
    if (!found.includes(cmd)) found.push(cmd);
    if (found.length >= MAX_CRITERIA) break;
  }
  return found;
}

/** A minimal shell-word split of a `grep …`/`git grep …` command, or undefined when it uses
 * shell syntax (an unquoted `|;&<>$()` or backtick) or leaves a quote open. Nothing runs through
 * a shell, so `*` stays literal. */
export function grepArgv(cmd: string): { file: "grep" | "git"; args: string[] } | undefined {
  const words = splitShellWords(cmd);
  return words === undefined ? undefined : grepInvocation(words);
}

/** The mutable scan state the shell-word helpers share: the words built so far, the character
 * buffer of the word in progress, whether a word is currently open, and which quote (if any) is
 * open. */
interface WordScan {
  words: string[];
  cur: string;
  inWord: boolean;
  quote: "'" | '"' | null;
}

/** Take one character at `i` inside a single-quoted run (`s.quote === "'"`): a `'` closes the
 * quote, anything else stays literal. Returns the index after the character. Inside single
 * quotes everything is literal. */
function takeSingleQuoted(cmd: string, i: number, s: WordScan): number {
  const c = cmd[i] as string;
  if (c === "'") s.quote = null;
  else s.cur += c;
  return i + 1;
}

/** Take one character at `i` inside a double-quoted run (`s.quote === '"'`): a `\\`-escaped
 * `"` or `\\` appends the escaped character and consumes two characters, a `"` closes the
 * quote, anything else stays literal. Returns the index after the consumed character(s). Double
 * quotes honour only `\"` and `\\`. */
function takeDoubleQuoted(cmd: string, i: number, s: WordScan): number {
  const c = cmd[i] as string;
  const next = cmd[i + 1];
  if (c === "\\" && (next === '"' || next === "\\")) {
    s.cur += next;
    return i + 2;
  }
  if (c === '"') s.quote = null;
  else s.cur += c;
  return i + 1;
}

/** Take one character at `i` outside any quote, or return `undefined` when it is refused shell
 * syntax: an unquoted `'`/`"` opens the quote and marks a word, an unquoted `\\` appends the
 * next character (if any) and marks a word, an unquoted `|;&<>$()` or backtick refuses the
 * command, whitespace ends a word (pushing `cur` when one is open) and resets the buffer, and
 * anything else appends and marks a word. Returns the index after the consumed character(s), or
 * `undefined` for the shell refusal. */
function takeUnquoted(cmd: string, i: number, s: WordScan): number | undefined {
  const c = cmd[i] as string;
  if (c === "'" || c === '"') {
    s.quote = c;
    s.inWord = true;
    return i + 1;
  }
  if (c === "\\") {
    if (i + 1 < cmd.length) {
      s.cur += cmd[i + 1];
      s.inWord = true;
      return i + 2;
    }
    s.inWord = true;
    return i + 1;
  }
  if (/[|;&<>$()`]/.test(c)) return undefined;
  if (/\s/.test(c)) {
    if (s.inWord) s.words.push(s.cur);
    s.cur = "";
    s.inWord = false;
    return i + 1;
  }
  s.cur += c;
  s.inWord = true;
  return i + 1;
}

/** Walk the whole command, dispatching each character to the quote-aware helper, and reject an
 * unterminated quote. Returns the word list. */
function splitShellWords(cmd: string): string[] | undefined {
  const s: WordScan = { words: [], cur: "", inWord: false, quote: null };
  let i = 0;
  while (i < cmd.length) {
    if (s.quote === "'") i = takeSingleQuoted(cmd, i, s);
    else if (s.quote === '"') i = takeDoubleQuoted(cmd, i, s);
    else {
      const next = takeUnquoted(cmd, i, s);
      if (next === undefined) return undefined;
      i = next;
    }
  }
  if (s.quote !== null) return undefined;
  if (s.inWord) s.words.push(s.cur);
  return s.words;
}

/** The shape pick: what invocation does this word list name? `git grep …` gives file `git` and
 * the args after `git`; `grep …` gives file `grep` and the args after `grep`; anything else is
 * not a grep we run. */
function grepInvocation(words: string[]): { file: "grep" | "git"; args: string[] } | undefined {
  if (words[0] === "git" && words[1] === "grep") return { file: "git", args: words.slice(1) };
  if (words[0] === "grep") return { file: "grep", args: words.slice(1) };
  return undefined;
}

/** Run each entry's matches-nothing greps in `wt`; one finding per entry, for its first grep that
 * still prints lines. An exit of 1 passes; any other failure (exit 2, timeout, spawn error) skips
 * the criterion, since an unrunnable command is not evidence. */
export async function acceptanceGrepFindings(
  wt: string,
  entries: { title: string; body: string }[],
): Promise<string[]> {
  const findings: string[] = [];
  for (const entry of entries) {
    for (const cmd of emptyGrepCriteria(entry.body)) {
      const argv = grepArgv(cmd);
      if (argv === undefined) continue;
      const out = await execFileAsync(argv.file, argv.args, { cwd: wt, timeout: GREP_TIMEOUT_MS }).then(
        (r) => r.stdout,
        () => "",
      );
      const lines = out.split("\n").filter((l) => l !== "");
      if (lines.length === 0) continue;
      const shown = lines.slice(0, 5).map((l) => truncate(l, 200)).join("; ");
      findings.push(
        `PLANS.md's finished entry "${truncate(entry.title, 160)}" says \`${cmd}\` matches nothing, but it prints ` +
          `${lines.length} line(s): ${shown}${moreSuffix(lines.length - 5)} — fix those lines, or correct the claim if the criterion is wrong`,
      );
      break;
    }
  }
  return findings;
}
