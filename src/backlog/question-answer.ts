// vocabulary: plain
/** The QUESTIONS.md reader/writer core — the shared home of the open-question outbox logic: listing
 * the open questions in QUESTIONS.md and answering one, which moves its entry from `## Open` to
 * `## Answered` with a dated operator answer. It does the markdown surgery — cut exactly one
 * `### ` block (fence-aware, like every backlog reader in backlog-md.ts) and extend a missing
 * `## Answered` section with the file's documented skeleton — so the loop→human→loop round trip
 * never corrupts the file the loops read at their next tick. Pure: no subprocess and no CLI
 * output helpers, so every surface can drive it without ending the process.
 *
 * Shared by every read/answer surface: the CLI's `tumwater questions` command body wraps it in
 * src/cli/question-commands.ts (the say/fail/editor layer), while the TUI's answer box
 * (src/ui/tui/tui-keys.ts) and the dashboard's POST route (src/gui/gui-endpoint-commands.ts)
 * import the non-exiting answer core directly. It lives with the rest of the BUGS/PLANS/QUESTIONS
 * markdown (src/backlog/), not under src/cli/, so the non-command surfaces never depend on the
 * CLI command package for domain logic.
 */
import path from "node:path";
import { fencedHeadingTitle, fenceTracker, nextSectionHeading } from "./backlog-md.js";
import { answeredQuestionEntries, openQuestionEntries, ageInDays, ageSuffix } from "./backlog.js";
import type { BacklogEntry } from "./backlog.js";
import { normalizeEntryBody } from "./backlog-write.js";
import { collapseWhitespace, trimLeadingBlankLines, trimTrailingBlankLines, truncate } from "../text/text.js";
import { readTextOrNull, writeTextAtomic } from "../files/files.js";
import { formatDate } from "../text/datetime.js";
import { numberedList } from "../text/markdown.js";
import { withStateLock } from "../concurrency/lock.js";
import { primaryWorktreeLockPath } from "../paths.js";
/** Cap on a question's one-line body preview, so one very long first line cannot dominate
 * the `questions` list. */
const BODY_PREVIEW_MAX = 100;

/** The ` -- <ellipsized body>` suffix one prose list line carries for its question's first
 * body line: the `prompt --list` numbered shape, so an operator can tell two open questions
 * apart without opening the file. Truncated through text.ts's truncate — the one ellipsis
 * rule — so the preview is never longer than BODY_PREVIEW_MAX and never splits a surrogate
 * pair. Omitted for a heading-only entry. */
function firstBodySuffix(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return "";
  return ` — ${truncate(line, BODY_PREVIEW_MAX)}`;
}

/** The open question's filing stamp, `YYYY-MM-DD`, read from the heading's `(asked by <who>
 * YYYY-MM-DD)` clause — the first `YYYY-MM-DD` after an `asked by` word in the title text — or
 * null when the heading carries no such clause. Taken from the title text only, not the body:
 * the stamp is the entry's own, and the body may name other dates. */
export function questionFilingDate(title: string): string | null {
  const m = /(?:asked by)\b[^)]*?\b(\d{4}-\d{2}-\d{2})/.exec(title);
  return m === null ? null : (m[1] as string);
}

/** The role id named in the heading's `(asked by <role> …)` clause — the first word after
 * `asked by` — or null when the heading has no such clause. Taken from the title only, like
 * questionFilingDate. */
export function questionAsker(title: string): string | null {
  const m = /\(asked by ([A-Za-z0-9_-]+)/.exec(title);
  return m === null ? null : (m[1] as string);
}

/** The ` · since <date> (…)` suffix naming how long an open question has waited for an answer,
 * from its heading's stamp (see questionFilingDate), or "" when the heading is undated —
 * rendered through backlog.ts's ageSuffix, the one place the wording lives (shared with the
 * plans/bugs list's entryAgeSuffix), which floors at 0 through ageInDays so a future stamp
 * reads `(today)`. */
export function questionAgeSuffix(title: string, now: number = Date.now()): string {
  const date = questionFilingDate(title);
  return date === null ? "" : ageSuffix(date, now);
}

/** `tumwater questions` with no arguments: the open questions numbered from 1 in file order,
 * one line each (`prompt --list`'s shape), or one line when none are open. Reads through
 * openQuestionEntries, so a missing or unreadable QUESTIONS.md degrades to "no open
 * questions" like every backlog reader. */
export function openQuestionList(root: string): string {
  const questions = openQuestionEntries(root);
  if (questions.length === 0) return "no open questions";
  return numberedList(questions.map((q) => `${q.title}${questionAgeSuffix(q.title)}${firstBodySuffix(q.body)}`));
}

/** The same list as data for `--json` (the backlog --json pattern: a JSON document in every
 * exit-0 case, never prose): each entry's 1-based position (the number `answer` consumes),
 * its verbatim heading text, and its full body. */
export function questionListPayload(root: string): {
  questions: { position: number; title: string; body: string; since?: string; ageDays?: number }[];
} {
  return {
    questions: openQuestionEntries(root).map((q, i) => {
      const sent: { position: number; title: string; body: string; since?: string; ageDays?: number } = {
        position: i + 1,
        title: q.title,
        body: q.body,
      };
      const since = questionFilingDate(q.title);
      if (since !== null) {
        sent.since = since;
        sent.ageDays = ageInDays(since);
      }
      return sent;
    }),
  };
}

/** The date in an answer stamp paragraph (`**Answered <date> by …`). */
const ANSWER_DATE_RE = /\*\*Answered (\d{4}-\d{2}-\d{2})\b/;

/** The first answer stamp's date in an answered entry's body, or null when it has none. The
 * stamp is a body paragraph, so this reads the body, not the heading. */
function answerDate(body: string): string | null {
  const m = ANSWER_DATE_RE.exec(body);
  return m === null ? null : (m[1] as string);
}

/** The first body line that starts with `**Answered `, markup stripped, whitespace collapsed
 * and truncated; "" when no line matches. */
function answerPreview(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.startsWith("**Answered "));
  if (line === undefined) return "";
  return truncate(collapseWhitespace(line.replaceAll("**", "")), BODY_PREVIEW_MAX);
}

/** The newest `count` answered questions, newest first (the file appends, so it is reversed),
 * and how many older ones were left out. */
function answeredQuestionsNewestFirst(root: string, count: number): { entries: BacklogEntry[]; older: number } {
  const all = answeredQuestionEntries(root).reverse();
  return { entries: all.slice(0, count), older: Math.max(0, all.length - count) };
}

/** `tumwater questions --answered`: bullets, not numbers, because `questions answer <n>`
 * positions address only `## Open`. */
export function answeredQuestionList(root: string, count: number): string {
  const { entries, older } = answeredQuestionsNewestFirst(root, count);
  if (entries.length === 0) return "no answered questions";
  const lines = ["answered questions in QUESTIONS.md, newest first:"];
  for (const e of entries) {
    const preview = answerPreview(e.body);
    lines.push(`- ${e.title}${preview === "" ? "" : ` — ${preview}`}`);
  }
  if (older > 0) lines.push(`(${older} older; -n <count> shows more)`);
  return lines.join("\n");
}

/** The same list as data for `--json`. */
export function answeredQuestionPayload(
  root: string,
  count: number,
): { questions: { title: string; body: string; answeredOn: string | null }[]; older: number } {
  const { entries, older } = answeredQuestionsNewestFirst(root, count);
  return {
    questions: entries.map((e) => ({ title: e.title, body: e.body, answeredOn: answerDate(e.body) })),
    older,
  };
}

/** The dashboard's compact form of the `--answered` list: the same titles and truncated
 * `**Answered …` lines, newest first, without bodies so each poll stays small. */
export function answeredQuestionSummaries(root: string, count: number): { title: string; decision: string }[] {
  return answeredQuestionsNewestFirst(root, count).entries.map((e) => ({ title: e.title, decision: answerPreview(e.body) }));
}

/** One open entry's extent in the raw file: its heading line and the line index where its
 * block ends — the next `### ` heading (fence-aware: a `### ` inside a code fence is quoted
 * content, never a boundary), or the end of the `## Open` section. */
interface OpenEntryBlock {
  start: number;
  end: number;
  title: string;
}

/** Locate QUESTIONS.md's `## Open` and `## Answered` section heading lines (fence-aware) and
 * every open entry's block between them. Returns null when the file has no `## Open` section
 * at all — then there is nothing to answer, whatever the position. */
function scanQuestions(lines: string[]): { openIdx: number; answeredIdx: number; openEnd: number; fenceOpen: boolean; blocks: OpenEntryBlock[] } | null {
  const fenced = fenceTracker();
  let openIdx = -1;
  let answeredIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const title = fencedHeadingTitle(line, fenced, "## ");
    if (title !== null) {
      if (title === "Open" && openIdx === -1) openIdx = i;
      else if (title === "Answered" && answeredIdx === -1) answeredIdx = i;
    }
  }
  if (openIdx === -1) return null;
  // A fresh tracker for this walk: the first loop consumed every line and left the tracker in
  // its end-of-file state, so reusing it here would quote all Open headings whenever a fence
  // after the Open section runs unclosed to EOF — and `answer` would refuse a question the
  // list just showed.
  const fencedBlocks = fenceTracker();
  // The section's end is the next `## ` heading of ANY title, fence-aware — the same boundary
  // rule sectionLines applies, so the entries `--list` numbers (sectionEntries →
  // parseEntryDetails) and the blocks `answer` moves can never disagree about where Open
  // stops. Ending at the first `## Answered` instead would run the walk through any
  // intermediate section and let one answer move another section's entries.
  const openEnd = nextSectionHeading(lines, openIdx + 1, fencedBlocks);
  const blocks: OpenEntryBlock[] = [];
  // A fresh tracker for this walk too: the openEnd walk consumed the lines up to the section's
  // end, so a fence in Open left unclosed at that boundary (an unclosed fence runs openEnd to
  // EOF) would leave the shared tracker inside and quote every `### ` heading — answer would
  // then see no blocks, or answer a later entry, on a file `--list` just numbered.
  const fencedEntries = fenceTracker();
  let current: OpenEntryBlock | null = null;
  for (let i = openIdx + 1; i < openEnd; i++) {
    const line = lines[i] ?? "";
    const entryTitle = fencedHeadingTitle(line, fencedEntries, "### ");
    if (entryTitle !== null) {
      if (current !== null) current.end = i;
      current = { start: i, end: openEnd, title: entryTitle };
      blocks.push(current);
    }
  }
  return { openIdx, answeredIdx, openEnd, fenceOpen: fencedEntries.open(), blocks };
}

/** What `tryAnswerQuestion` did: `answered` wrote the file; the rest refuse as data and leave it
 * untouched — `missing` (no Nth open question, `open` counts them), `moved` (the block at the
 * position is not the `expectedTitle` the caller saw) and `fenced` (an unclosed fence in
 * `## Open`). */
export type AnswerOutcome =
  | { status: "answered"; title: string; decision: string }
  | { status: "missing"; open: number }
  | { status: "moved"; title: string }
  | { status: "fenced" };

export const UNCLOSED_FENCE_MESSAGE =
  "QUESTIONS.md's ## Open section holds an unclosed code fence — every reader quotes the rest of the file as that entry's body, so answering would corrupt the file; close or remove the fence and re-run";

/** The non-exiting answer core, for callers (the dashboard server) that must not end the
 * process: runs the whole read-modify-write under the cross-process primary-worktree lock
 * (paths.ts), shared with `tumwater bug`/`plan` and a landing's working-tree fast-forward, so an
 * answer and a landed change to QUESTIONS.md cannot each overwrite the other's whole-file write.
 * With `expectedTitle`, a block at position `n` titled otherwise is `moved` and nothing is
 * written; the comparison runs inside the lock, after the scan. */
export function tryAnswerQuestion(root: string, n: number, rawDecision: string, expectedTitle?: string, keepLines = false): AnswerOutcome {
  return withStateLock(primaryWorktreeLockPath(root), () => answerQuestionLocked(root, n, rawDecision, expectedTitle, keepLines));
}
/** `tumwater questions answer <n> <decision>`: move the Nth open question's full block —
 * heading plus body, verbatim — from `## Open` to the end of `## Answered`, followed by a
 * `**Answered <today> by the user:** <decision>` paragraph stamped with the local date — the
 * positional decision is free-form operator prose, so it folds to one line (collapseWhitespace,
 * the pause `--reason` precedent): verbatim multi-line text could carry a line that starts with
 * `## ` or `### ` and grow a phantom section no reader wrote. The `--file` form (`keepLines`)
 * keeps the lines, behind bodyStructureProblem — the guard `plan --file` uses — applied by its
 * caller; a multi-line decision follows the stamp after a blank line. The Open section that is
 * left empty regains its `_None yet._` placeholder; a file with no `## Answered` section gains
 * one. Returns the outcome (see `AnswerOutcome`); on `answered` the title for the confirmation
 * line, plus the collapsed decision that actually landed in the file so callers report what was
 * written rather than the caller's raw whitespace. */
function answerQuestionLocked(root: string, n: number, rawDecision: string, expectedTitle: string | undefined, keepLines: boolean): AnswerOutcome {
  const decision = keepLines ? normalizeEntryBody(rawDecision) : collapseWhitespace(rawDecision);
  const file = path.join(root, "QUESTIONS.md");
  const md = readTextOrNull(file);
  const lines = md === null ? null : md.split("\n");
  const scan = lines === null ? null : scanQuestions(lines);
  const openCount = scan === null ? 0 : scan.blocks.length;
  if (scan === null || n < 1 || n > scan.blocks.length) {
    return { status: "missing", open: openCount };
  }
  const scanned = scan;
  // A fence inside ## Open left unclosed runs to EOF (CommonMark), so the whole tail — the
  // real ## Answered section included — reads as quoted body of the still-open entry. Acting
  // on that degraded read moves Answered content inside the moved block's fence and grows a
  // second ## Answered at the file's end, while the question still lists as open: refuse
  // instead, and tell the operator the one local repair (close or remove the fence).
  if (scanned.fenceOpen) {
    return { status: "fenced" };
  }
  const block = scanned.blocks[n - 1] as OpenEntryBlock;
  if (expectedTitle !== undefined && block.title !== expectedTitle) return { status: "moved", title: block.title };
  const moved = lines!.slice(block.start, block.end);
  trimTrailingBlankLines(moved);

  // Cut the block out of ## Open: everything before it, everything from its end on. When the
  // section is left with no content at all, restore the `_None yet._` placeholder the skeleton
  // carries, so an empty outbox still reads as an intentionally empty section.
  // Emptiness is judged against the Open section only (openIdx+1 .. openEnd): with an
  // intermediate section between Open and Answered, judging against answeredIdx would keep
  // the placeholder from returning and, worse, the empty rebuild would drop that section.
  const openContent = lines!.slice(scanned.openIdx + 1, scanned.openEnd);
  const remaining = openContent.filter((_, i) => i < block.start - scanned.openIdx - 1 || i >= block.end - scanned.openIdx - 1);
  const openEmpty = remaining.every((l) => l.trim() === "");
  const rebuilt: string[] = [];
  if (openEmpty) {
    rebuilt.push(
      ...lines!.slice(0, scanned.openIdx + 1),
      "",
      "_None yet._",
      // Resume at the section that followed Open (openEnd, not answeredIdx — an intermediate
      // section between the two must survive) with the blank separator line the dropped Open
      // content used to carry, so `_None yet._` never reads as a paragraph glued to a heading.
      "",
      ...lines!.slice(scanned.openEnd),
    );
  } else {
    rebuilt.push(...lines!.slice(0, block.start), ...lines!.slice(block.end));
  }

  // Append the block at the end of ## Answered: before the next `## ` heading when one
  // follows, at the file's end otherwise — the section is last in the documented skeleton.
  const stamp = `**Answered ${formatDate(new Date())} by the user:**`;
  const stamped = decision.includes("\n") ? [stamp, "", ...decision.split("\n")] : [`${stamp} ${decision}`];
  const answerLines = moved.concat("", ...stamped, "");
  if (scanned.answeredIdx === -1) {
    // No ## Answered section: grow the file's end with the skeleton section plus the block.
    let out = rebuilt.join("\n");
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += `\n## Answered\n\n${answerLines.join("\n")}`;
    writeTextAtomic(file, out);
    return { status: "answered", title: block.title, decision };
  }
  const fenced2 = fenceTracker();
  let answeredAt = -1;
  const placeholderAt: number[] = [];
  for (let i = 0; i < rebuilt.length; i++) {
    const line = rebuilt[i] ?? "";
    if (fenced2.inside(line)) continue;
    if (answeredAt === -1) {
      if (fencedHeadingTitle(line, fenced2, "## ") === "Answered") answeredAt = i;
    } else if (fencedHeadingTitle(line, fenced2, "## ") !== null) {
      break; // The Answered section's end: a placeholder beyond it is another section's.
    } else if (line.trim() === "_None yet._") {
      placeholderAt.push(i);
    }
  }
  // A section holding only its `_None yet._` skeleton placeholder must lose the placeholder
  // when a real entry lands there: the placeholder means "no entries", so leaving it above
  // the moved block makes ## Answered claim to be empty while holding an answered question.
  // Fence-aware: a `_None yet._` line quoted inside a fenced block is quoted content, never
  // the placeholder.
  if (placeholderAt.length > 0) {
    const dropped = new Set(placeholderAt);
    const stripped = rebuilt.filter((_, i) => !dropped.has(i));
    rebuilt.length = 0;
    rebuilt.push(...stripped);
  }
  const insertAt = nextSectionHeading(rebuilt, answeredAt + 1, fenced2);
  const head = rebuilt.slice(0, insertAt);
  const tail = rebuilt.slice(insertAt);
  trimTrailingBlankLines(head);
  trimLeadingBlankLines(tail);
  const result = head.concat("", answerLines, tail);
  writeTextAtomic(file, result.join("\n"));
  return { status: "answered", title: block.title, decision };
}
