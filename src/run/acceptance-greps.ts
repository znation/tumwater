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
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      const next = cmd[i + 1];
      if (c === "\\" && (next === '"' || next === "\\")) {
        cur += next;
        i++;
      } else if (c === '"') quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\") {
      if (i + 1 < cmd.length) cur += cmd[++i];
      inWord = true;
    } else if (/[|;&<>$()`]/.test(c)) {
      return undefined;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote !== null) return undefined;
  if (inWord) words.push(cur);
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
