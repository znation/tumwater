import { shortSha } from "../text/format.js";
import { NEEDS_REPLAN_NOTE, NEEDS_REVIEW_NOTE } from "../roles/role-guidance.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { formatTimestamp } from "../text/datetime.js";
import { numberedList } from "../text/markdown.js";
import { SUMMARY_BLOCK, NOTHING_TO_DO } from "../verdict/reply-contract.js";
import { NO_REASONS } from "./gate-prompts.js";

/** The notes that carry the merge gate's verdicts back to the role that authored the change
 * (runner-run.ts, run-prompt.ts, main-red.ts): a rejected review, a revision round, a claim
 * assignment, a discarded conflict, and the red-main handoffs. The gate's own pi-run prompts —
 * conflict resolution, the review, the stage fix — live in gate-prompts.ts, with the conflict
 * hand-back note that shares the resolver prompt's conflict blocks. */

/** The note injected into a role's next run prompt after its previous change was rejected in
 * review. Every run starts a fresh pi session, so this is the only cross-run memory of what
 * was built and why it failed — it carries the full reasons, not a summary of them. The whole
 * `lastReview` rides in, not just the reasons: the timestamp and reviewed head let the author
 * weigh a stale objection against main's current state (main may have satisfied it since).
 * buildRunPrompt renders it at the very top of the run prompt, before the role charter, and its
 * phrasing makes fixing the objections this run's primary task (plans/reviewer-as-role.md part
 * 4/4) — the inescapable-first note the recurring-reason runs were missing. */
export function buildRejectedReviewNote(review: {
  reasons: string[];
  at?: number;
  head?: string;
  /** True when the change already used its last revision round: the rejected diff is gone, so
   * the note must not read as an invitation to revise it again. */
  exhausted?: boolean;
}, role?: string): string {
  const list = numberedList(review.reasons, NO_REASONS);
  let context = "";
  if (review.at !== undefined) {
    context = ` (${formatTimestamp(review.at)}`;
    if (review.head) context += `, head ${shortSha(review.head)}`;
    context += ")";
  }
  // On exhaustion the rejected diff is gone. Feature's rejected change often implemented a
  // PLANS.md entry, and re-authoring the same plan from scratch is what produced the long
  // rejection runs this note exists to end, so feature is sent to replan the entry instead.
  // A plan-less role has no downstream role to replan for it, so it is sent to its own
  // notes instead: it records the abandoned purpose and any instances that remain
  // unhandled, then takes a different theme on the next run. Re-authoring the same purpose
  // from the same objections is what restarted the round and produced the long rejection
  // runs this note exists to end. The markdown-only replan note merges review-exempt, but a
  // merged change clears the standing rejection (clearSupersededRejection, run-apply.ts), so
  // the instruction does not re-inject once the note has merged. `role` is the runner id, so
  // feature's instances (`feature-2`, …) are matched through their base role: matched bare,
  // they got the plan-less wording while their claim kept the same entry assigned, and
  // resolved the contradiction by refusing the plan (three Refused notes on 2026-10-21).
  let finality = "";
  if (review.exhausted) {
    finality =
      role !== undefined && baseRoleOf(role) === "feature"
        ? ` This was the change's final revision round — the same objection survived two revisions (or the chain hit its cap), so the rejected diff and ref are gone. If it implemented a PLANS.md entry, do not re-author it: append ${NEEDS_REPLAN_NOTE} under that entry's heading, with the numbered objections above quoted beneath it, and merge that markdown-only change and nothing else so the plan role can rewrite the plan. Otherwise, redo the change against current main.`
        : " This was the change's final revision round — the same objection survived two revisions (or the chain hit its cap), so the rejected diff and ref are gone. Do not re-author it. Record the abandoned purpose and any instances of it that remain unhandled in your notes, then take a different theme on this run: re-deriving the same purpose from the same objections is what produced the long rejection runs this note exists to end.";
  }
  const tail = finality === "" ? "" : `\n${finality.trim()}`;
  return `Your previous change was rejected; fix each numbered objection or drop the change — it is this run's primary task${context}:\n${list}${tail}`;
}

/** The note injected into a role's run prompt when its rejected change has been re-applied to
 * current main as uncommitted edits (plans/revise-rejected.md, runner/revision.ts's
 * applyRevision): this run's one task is to revise the change already in the worktree, not
 * author a new one. The prior objections are numbered so the author can work through them; a
 * revision round past the first also reaches here. The chain keeps revising while each round
 * fixes the prior objection; it ends only on a repeated objection or the backstop (BUGS.md
 * 2026-10-14). A pure function so its shape is pinned in tests. */
export function buildRevisionNote(
  review: { reasons: string[] },
  round: number,
): string {
  const list = numberedList(review.reasons, NO_REASONS);
  return `Your previously rejected change is already in the worktree as uncommitted edits — this
is revision ${round}. This run's ONE task is to revise it; do not author anything else.
The review objections were:\n${list}
Fix each numbered objection with the smallest edit that resolves it, and keep everything else as it
is. When an objection is about a build-check failure in a test the change does not touch that you
cannot reproduce, say so in RISK and keep the change as it is. Rewrite the closing block so it
describes the WHOLE change as it now stands:
${SUMMARY_BLOCK}
Add one Objection N: <done|dropped|unchanged-by-design because …> line to the closing block for
each numbered objection above (N is the objection's number): this run's commit body carries them,
so the re-review reads your answer to each objection beside the diff. Say "done" when the fix is in
this change, "dropped" when you removed what the objection targeted, or "unchanged-by-design because …"
when you kept it and why.
When an objection shows the change should not exist (its premise is disproven, it duplicates main,
or it has no reachable benefit), end your reply with the line ${NOTHING_TO_DO} instead, and
tumwater drops the change.`;
}

/** The note appended to a work instance's run prompt when it holds a claim (plans/parallel-
 * work-instances.md "Claims", part 4/7): the harness has already picked its entry, so the
 * charter's choosing step is replaced. A pure function so its shape is pinned in tests; the
 * range is optional because a claim whose entry was already released still gets the note. */
export function buildAssignmentNote(
  claim: { file: string; title: string; source: "assigned" | "staged" },
  range?: { start: number; end: number },
  missingPaths: readonly string[] = [],
): string {
  const where = range ? ` (${claim.file} lines ${range.start}-${range.end})` : ` (${claim.file})`;
  const intro =
    claim.source === "staged"
      ? `Your change moved ONE backlog entry, so it is now your task, replacing your charter's "pick one" step:`
      : `Tumwater has assigned you ONE backlog entry, replacing your charter's "pick one" step:`;
  const shown = missingPaths.slice(0, 10).map((p) => `\`${p}\``).join(", ");
  const rest = missingPaths.length - 10;
  const missingLine =
    missingPaths.length === 0
      ? ""
      : `\nThe entry names paths that do not exist in your checkout: ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Each was renamed or removed after the entry was written (find its successor with \`git log --follow --name-status -- <path>\` or by grepping for the symbols the entry names), or is a file the entry asks you to create.`;
  return `<assigned-entry>
${intro}
"${claim.title}"${where}.
Implement or fix only that entry. If it is too large for one run, append ${NEEDS_REVIEW_NOTE} under its heading and end your reply with that note alone. If it should not be done, append a Refused note under its heading with your objection and change nothing else. Do not edit any other backlog entry.${missingLine}
</assigned-entry>`;
}

/** The note appended to an unassigned work instance's prompt when siblings hold backlog entries
 * (plans/parallel-work-instances.md "an exclusion list of held titles"): those entries are
 * someone else's task, so choosing among the rest — or ending with nothing to do — is the
 * instance's whole job. A pure function so its shape is pinned in tests. */
export function buildHeldEntriesNote(titles: readonly string[]): string {
  return `<held-entries>
Sibling instances hold these backlog entries; do not pick, edit, or implement them, and do not edit their headings. If every remaining entry is held, treat the backlog as having nothing to do for you:
${titles.map((t) => `- "${t}"`).join("\n")}
</held-entries>`;
}

/** The longest title an entry list quotes: a PLANS.md heading's tail names the plan's dates and
 * every file it touches, which its range already leads to. */
const LISTED_TITLE_CHARS = 100;

/** The capped series-part range list shared by the merged-prerequisites and waiting-parts
 * notes: at most five `- "title"` lines, each naming the entry's heading line range in its
 * `file` (default: the plans file) with the title cut to LISTED_TITLE_CHARS, then one
 * `- …and N more` line for the rest, so the two notes list a part's neighbors identically. A pure
 * function so its shape is pinned in tests (test/gate-notes.test.ts). */
function entryRangeLines(entries: readonly { title: string; start: number; end: number; file?: string }[]): string[] {
  // Cut by code point, so an astral character is never split in half.
  const title = (t: string): string => {
    const cps = Array.from(t);
    return cps.length > LISTED_TITLE_CHARS ? `${cps.slice(0, LISTED_TITLE_CHARS).join("").trimEnd()}…` : t;
  };
  const lines = entries.slice(0, 5).map((e) => `- "${title(e.title)}" (${e.file ?? "PLANS.md"} lines ${e.start}-${e.end})`);
  if (entries.length > 5) lines.push(`- …and ${entries.length - 5} more`);
  return lines;
}

/** The note appended to a series part's assignment when parts it requires already merged: each
 * one's Done heading, file (PLANS-DONE.md once archived) and line range, so the implementer reads
 * exactly what that part changed instead of searching a history that runs to thousands of lines.
 * Lists at most five, then a count of the rest. A pure function so its shape is pinned in tests. */
export function buildMergedPrerequisitesNote(entries: readonly { title: string; start: number; end: number; file?: string }[]): string {
  const lines = entryRangeLines(entries);
  return `<merged-prerequisites>
Your assigned entry builds on parts that are already merged. Each one's Done entry records what it actually changed; read one by its range when your entry depends on its details, rather than searching the backlog files:
${lines.join("\n")}
</merged-prerequisites>`;
}

/** The note injected into a role's prompt after leftover recovery discarded its pinned change
 * at MERGE_CONFLICT_LIMIT (src/runner/leftover.ts): at the cap recovery ordinarily hands the
 * change back to its author with markers instead, so a discard means that lineage already used
 * its hand-back. The merge failures were harness-level, so without the note the author would
 * never learn its work is gone — or that redoing it from memory of the old diff would conflict
 * again. A pure function so its shape is pinned in tests. */
export function buildConflictDiscardNote(summary: string, attempts: number): string {
  return (
    `Your previous change ("${summary}") was discarded without merging: it conflicted with main ` +
    `${attempts} times and conflict resolution could not reconcile it. Main has moved on since you ` +
    `wrote it. If the change is still needed, redo it against current main, starting from main's ` +
    `current version of the files it touched rather than your earlier diff.`
  );
}

/** The note injected into the `ci` healer's prompt when main's own suite is red (PLANS.md
 * "Red-main handoff"): the gate's warning event is harness-level and no role prompt reads it, so
 * the healer — whose job is to make main green — is told what failed and that fixing it is this
 * run's task. The healer's normal charter is a starting point, not a fit — a red main keeps the
 * whole team working on it, and the gate's deterministic pre-check rejects any change that leaves
 * the suite red, so authoring anything else first is waste. A pure function so its shape is
 * pinned in tests; script/headline are optional because a red carries a failing script, but the
 * note must still read sensibly if it is ever absent. */
export function buildMainRedNote(sha: string, script?: string, headline?: string, tail?: readonly string[]): string {
  const what = script
    ? `${script}${headline ? `: ${headline}` : ""}`
    : (headline ?? "the project's declared check");
  // A red baseline already carries the check's bounded clipped tail (clipBuildTail, ≤12 lines:
  // the failing test's name, the error-message line, then the stack). Hoist it into the note so
  // the healer starts from the actual assertion and stack instead of the one-line headline —
  // often just the test name — and must burn its run reproducing the failure first. The tail is
  // fenced and labeled, and never touches the directive lines above, so the failure's own text
  // cannot read as instructions to the role. An absent, empty, or all-blank tail renders today's
  // exact note. */
  const output = (tail ?? []).map((l) => l.trim()).filter((l) => l !== "");
  const tailBlock =
    output.length > 0
      ? `\nFailing check output (${output.length} lines):\n\`\`\`\n${output.join("\n")}\n\`\`\`\n`
      : "";
  return `<main-red>
main's own suite is red at ${shortSha(sha)} (${what}). Every role keeps working on the red main, but no change that leaves the suite red merges until main is green.
This run your job is to make main green: reproduce that failure, fix it (add a regression test where one is feasible), and merge the fix.
The review gate's deterministic pre-check runs main + your change, so a change that leaves the suite red is rejected — do not author anything else first.
If the failure is environmental — flaky, load-sensitive, or a broken local toolchain — say so plainly in your reply rather than editing unrelated code.
${tailBlock}</main-red>`;
}

/** The note injected into every role's prompt but the `ci` healer's own while main is red with
 * named failures (the `<main-known-red>` block part 3a/3 dropped with the red-main authoring
 * gate, re-added by the "Every role may fix main's failing check" decision 2026-10-25): the
 * tests that already fail on main, and who owns them. The `ci` role owns the repair but does
 * not monopolize it — any role whose change touches what a named test covers, or that can land
 * a fix, fixes it in its own worktree and lets the change land normally. It is worded as
 * permission to proceed (a main that names its failures stops nobody), never as "leave them
 * alone". A pure function so its shape is pinned in tests; at most 20 tests are listed, then a
 * `…and N more` line. */
export function buildMainKnownRedNote(failingTests: readonly string[]): string {
  const shown = failingTests.slice(0, 20).map((t) => `- ${t}`);
  if (failingTests.length > 20) shown.push(`- …and ${failingTests.length - 20} more`);
  return `<main-known-red>
${shown.join("\n")}
Main's tip already fails these tests. The ci role owns them and fixes them on its own clock. A role whose change touches what they test, or that can land a fix for one, fixes it in its own worktree and lets the change land normally — never weaken or delete a test to make the suite pass.
</main-known-red>`;
}

/** The note appended to an assigned series part's prompt naming the later planned parts that
 * wait on it, so the implementer sees where its part ends and leaves their share alone. At most
 * five are listed, then a literal `- …and N more` line (the `moreSuffix` phrase renders inline,
 * not as a list line). A pure function so its shape is pinned in tests. */
export function buildWaitingPartsNote(entries: readonly { title: string; start: number; end: number }[]): string {
  const shown = entryRangeLines(entries);
  return `<waiting-parts>
Later parts of your series wait for yours to land, and each one plans its own share of the work: do none of it here, and keep in place the names and files they say your part leaves behind. Read one by its range when you need to know what it expects:
${shown.join("\n")}
</waiting-parts>`;
}
