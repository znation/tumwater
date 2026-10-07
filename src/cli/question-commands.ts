/** The CLI layer of `tumwater questions` — the open-question outbox command: list the open
 * questions in QUESTIONS.md numbered, or `answer <n> <decision>` one, which moves its entry
 * from `## Open` to `## Answered` with a dated operator answer. Split out of cli.ts because
 * the markdown surgery it performs is more than a dispatch case: the answer path must cut
 * exactly one `### ` block (fence-aware, like every backlog reader in backlog-md.ts) and extend
 * a missing `## Answered` section with the file's documented skeleton, so the loop→human→loop
 * round trip never corrupts the file the loops read at their next tick. */
import path from "node:path";
import { fail, say, sayJson } from "./cli-output.js";
import { fencedHeadingTitle, fenceTracker, nextSectionHeading } from "../backlog/backlog-md.js";
import { openQuestionEntries } from "../backlog/backlog.js";
import { collapseWhitespace, trimLeadingBlankLines, trimTrailingBlankLines, truncate } from "../text/text.js";
import { readTextOrNull, writeTextAtomic } from "../files/files.js";
import { formatDate } from "../text/datetime.js";
import { numberedList } from "../text/markdown.js";

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

/** `tumwater questions` with no arguments: the open questions numbered from 1 in file order,
 * one line each (`prompt --list`'s shape), or one line when none are open. Reads through
 * openQuestionEntries, so a missing or unreadable QUESTIONS.md degrades to "no open
 * questions" like every backlog reader. */
export function openQuestionList(root: string): string {
  const questions = openQuestionEntries(root);
  if (questions.length === 0) return "no open questions";
  return numberedList(questions.map((q) => `${q.title}${firstBodySuffix(q.body)}`));
}

/** The same list as data for `--json` (the backlog --json pattern: a JSON document in every
 * exit-0 case, never prose): each entry's 1-based position (the number `answer` consumes),
 * its verbatim heading text, and its full body. */
export function questionListPayload(root: string): {
  questions: { position: number; title: string; body: string }[];
} {
  return {
    questions: openQuestionEntries(root).map((q, i) => ({
      position: i + 1,
      title: q.title,
      body: q.body,
    })),
  };
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

/** `tumwater questions answer <n> <decision>`: move the Nth open question's full block —
 * heading plus body, verbatim — from `## Open` to the end of `## Answered`, followed by a
 * `**Answered <today> by operator:** <decision>` paragraph stamped with the local date — the
 * decision is free-form operator prose, so it folds to one line (collapseWhitespace, the pause
 * `--reason` precedent): verbatim multi-line text could carry a line that starts with `## ` or
 * `### ` and grow a phantom section no reader wrote. The Open section that is left empty regains
 * its `_None yet._` placeholder; a file with no
 * `## Answered` section gains one. An out-of-range position fails with the
 * `prompt --cancel` wording and exits 1. Returns the answered question's title for the
 * confirmation line, plus the collapsed decision that actually landed in the file so callers
 * report what was written rather than the caller's raw whitespace. */
export function answerQuestion(root: string, n: number, rawDecision: string): { title: string; decision: string } {
  const decision = collapseWhitespace(rawDecision);
  const file = path.join(root, "QUESTIONS.md");
  const md = readTextOrNull(file);
  const lines = md === null ? null : md.split("\n");
  const scan = lines === null ? null : scanQuestions(lines);
  const openCount = scan === null ? 0 : scan.blocks.length;
  if (scan === null || n < 1 || n > scan.blocks.length) {
    fail(`no question at position ${n} (${openCount} open)`);
  }
  const scanned = scan as { openIdx: number; answeredIdx: number; openEnd: number; fenceOpen: boolean; blocks: OpenEntryBlock[] };
  // A fence inside ## Open left unclosed runs to EOF (CommonMark), so the whole tail — the
  // real ## Answered section included — reads as quoted body of the still-open entry. Acting
  // on that degraded read moves Answered content inside the moved block's fence and grows a
  // second ## Answered at the file's end, while the question still lists as open: refuse
  // instead, and tell the operator the one local repair (close or remove the fence).
  if (scanned.fenceOpen) {
    fail("QUESTIONS.md's ## Open section holds an unclosed code fence — every reader quotes the rest of the file as that entry's body, so answering would corrupt the file; close or remove the fence and re-run");
  }
  const block = scanned.blocks[n - 1] as OpenEntryBlock;
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
  const answerLines = moved.concat("", `**Answered ${formatDate(new Date())} by operator:** ${decision}`, "");
  if (scanned.answeredIdx === -1) {
    // No ## Answered section: grow the file's end with the skeleton section plus the block.
    let out = rebuilt.join("\n");
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += `\n## Answered\n\n${answerLines.join("\n")}`;
    writeTextAtomic(file, out);
    return { title: block.title, decision };
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
  return { title: block.title, decision };
}

/** The one confirmation line `questions answer` prints in prose mode: which position was
 * answered and which entry moved — `--json` swaps it for the answer result payload. */
export function sayAnswered(position: number, title: string, json: boolean, decision: string): void {
  if (json) sayJson({ answered: position, question: title, decision });
  else say(`answered question ${position}: ${title} — moved to ## Answered`);
}

/** One entry point for the list modes so cli.ts stays a dispatcher: --json prints the payload
 * document (an empty outbox still prints it), prose prints the numbered lines or the empty
 * line. */
export function sayQuestionList(root: string, json: boolean): void {
  if (json) sayJson(questionListPayload(root));
  else say(openQuestionList(root));
}
