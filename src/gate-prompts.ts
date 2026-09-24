import { shortSha } from "./text.js";
import { dateLine } from "./prompt.js";

/** Prompts for the landing gate's pi runs — the runs the merge/review pipeline starts, not the
 * role loops' authoring ticks (those live in prompt.ts): conflict resolution after a rebase
 * (merge.ts), the adversarial pre-merge review (review.ts), and the notes that carry the gate's
 * verdicts back to the loop that authored the change (loop.ts, main-red.ts). The
 * machine-detectable half of the gate's reply contract — verdict constants and detection for
 * parsing a reviewer's VERDICT line — lives in reply-contract.ts. */

/** The prompt for resolving merge conflicts left in a loop's worktree. `today` pins the date
 * line (prompt.ts's dateLine) for tests; omitted, it is the local day. */
export function buildConflictPrompt(roleId: string, files: string[], today?: string): string {
  return `You are the "${roleId}" loop of tumwater, an autonomous development harness. A rebase of
your work branch onto main stopped on conflicts; the conflict markers are sitting in the
worktree now. Resolve them.

${dateLine(today)}

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

Resolve every conflict marker (<<<<<<<, =======, >>>>>>>) by combining the intent of BOTH sides:
"ours" is this branch's change, "theirs" is the latest main. Do not simply pick one side unless
the two changes are genuinely alternatives. Keep the project building and its tests passing.

Rules for this run:
- Edit files only. Never run any git command that changes state (no add, commit, merge, rebase,
  reset, checkout) — the harness concludes the rebase for you. Reading git state is fine.
- Read only the conflicted files and what they directly reference (\`grep -n '<<<<<<<' FILE\`
  finds each marker; read around it in ranges) — not the codebase at large.
- Never touch the .tumwater directory or tumwater.json.
- When every marker is resolved and the project is consistent, just stop.`;
}

/** The prompt for the adversarial pre-merge review gate: a fresh-session pi run that sees
 * only the diff and project context — never the author's session — and replies with exactly
 * one VERDICT line plus numbered reasons (see parseVerdict in src/review.ts). `verifiedByHarness`
 * names the project's own check the gate's deterministic pre-check already ran green on this
 * exact tree (e.g. "`npm run test` passed"), so the reviewer spends its run on what a green suite
 * cannot show instead of re-running it. The no-re-run instruction is its own line in the rules
 * list, not a clause in the context paragraph: stated there, reviewers read past it and re-ran
 * the suite in scratch copies under /tmp while holding the landing slot (BUGS.md 2026-09-23). It
 * appears only when a verified result exists: after a timed-out, killed, or skipped pre-check no
 * green run stands behind the tree, and a reviewer running the suite itself is doing its job.
 * `today` pins the date line (prompt.ts's dateLine) for tests; omitted, it is the local day. The
 * text must contain the literal "VERDICT:" exactly twice — the two advertised forms — because a
 * prompt test derives the accepted forms from it. */
export function buildReviewPrompt(
  diff: string,
  summary?: string,
  commitBody?: string,
  principles?: string,
  highFriction?: boolean,
  verifiedByHarness?: string,
  today?: string,
): string {
  const parts = [
    `You are an adversarial code reviewer for tumwater, an autonomous development harness. A
loop's change is about to be merged to main; you decide whether it may land. You have no context
from the authoring run — judge only what is in front of you, and assume nothing until you have
checked it.`,
    dateLine(today),
  ];
  if (highFriction)
    parts.push(
      `This change was flagged HIGH-FRICTION by the harness: its authoring run burned far more
assistant turns or wall-clock time than this project's thresholds. Difficulty is a signal that
the work may not fit the system — apply extra scrutiny to whether the change should exist at all,
not just whether it is correct.`,
    );
  if (summary) parts.push(`The author's summary of the change:\n${summary}`);
  if (commitBody)
    parts.push(
      `The author's commit body (claimed motivation, risk, verification — check these claims against the diff):\n${commitBody}`,
    );
  if (verifiedByHarness)
    parts.push(
      `The harness already ran the project's own check on this exact tree and it passed:
${verifiedByHarness}. Spend your run on what a green check cannot show: wrong behavior the tests
never exercise, claims the diff does not back, work left half-done.`,
    );
  if (principles) {
    parts.push(
      `Design principles this project holds — your review standard; a violation of one is a finding:\n<principles>\n${principles}\n</principles>`,
    );
  }
  parts.push(`The full diff this merge will land (everything the branch is ahead of main):\n<diff>\n${diff}\n</diff>`);
  // Right after the scratch-copy allowance it qualifies: a scratch copy stays fine for measuring
  // something, but a copy made to run the suite is the re-run this line forbids.
  const noRerunRule = verifiedByHarness
    ? `
- Do not re-run the check named above or the project's full test suite: the harness's green run
  is the verified result. Copying the tree elsewhere to run it — rsync or cp into a temp
  directory, reinstalling dependencies there (\`npm ci\`) — counts as re-running it. Running one
  specific test file for a concrete reason you can name is fine.`
    : "";
  parts.push(
    `Review adversarially: hunt for correctness bugs, violations of the project's principles,
unjustified complexity growth, and incomplete or half-done work. Read surrounding code in the
repo to check claims against reality — a diff that does more than it claims is a finding — but
read only what the diff touches: the changed functions, their callers, and the tests that cover
them, in ranges (\`grep -n\`, \`sed -n\`), not the repository at large. Batch the independent reads
(the diff's files, their callers, their tests) as sibling tool calls in one turn — turns, not
tool calls, are the expensive unit — and keep anything that depends on a prior result sequential.

Check, in this order:
1. Does the diff do exactly what the summary and WHY claim — no more, no less? An unclaimed
   change is a finding.
2. Are the VERIFIED claims consistent with the diff (commands, files, test counts)? A claim you
   can disprove is a rejection.
3. Do new or changed tests exercise the new behavior — would they fail without the change?
4. For a planned feature or recorded bug, does the change deliver what its PLANS.md/BUGS.md
   entry promises (files touched, acceptance criteria), and is the entry updated to match? An
   entry records intent at recording time; when the change responds to a newer user instruction
   on the same topic, judge it against that newer purpose — contradicting an older recorded fix
   direction is not itself a defect. Reject only if the change is incoherent or incomplete for
   its stated purpose, or leaves the existing entry stale and contradictory (updating the entry
   in place is the author's duty).
5. Does anything violate a principle above, or grow complexity the WHY does not justify?
Reject only for concrete, verifiable defects you can name; when the change is correct, complete
for its stated purpose, and within the principles, taste alone is not a rejection.

Rules for this run:
- Do not edit any file in the worktree. Never run a command that changes state (no git
  add/commit/merge/rebase/reset, no writes in the worktree) — your only output channel is the
  verdict below. Reading files and git history is fine; a scratch copy under the system temp
  directory is fine when you need to run something.${noRerunRule}
- Weigh the change against its stated purpose; do not approve work you did not actually check.
- End your reply with exactly one line in this form:
  VERDICT: approve   or   VERDICT: reject
  followed by numbered reasons (for an approval, state what you checked and why it holds).`,
  );
  return parts.join("\n\n");
}

/** The note injected into a role's next tick prompt after its previous change was rejected in
 * review. Every tick starts a fresh pi session, so this is the only cross-tick memory of what
 * was built and why it failed — it carries the full reasons, not a summary of them. */
export function buildRejectedReviewNote(reasons: string[]): string {
  const list =
    reasons.length > 0 ? reasons.map((r, i) => `${i + 1}. ${r}`).join("\n") : "(no reasons recorded)";
  return `Your previous change was rejected in review:\n${list}\nAddress the objections or take a different approach.`;
}

/** The note injected into a role's prompt after leftover recovery discarded its pinned change
 * at MERGE_CONFLICT_LIMIT (src/leftover.ts): the landing failures were harness-level, so without
 * it the author would never learn its work is gone — or that redoing it from memory of the old
 * diff would conflict again. A pure function so its shape is pinned in tests. */
export function buildConflictDiscardNote(summary: string, attempts: number): string {
  return (
    `Your previous change ("${summary}") was discarded without landing: it conflicted with main ` +
    `${attempts} times and conflict resolution could not reconcile it. Main has moved on since you ` +
    `wrote it. If the change is still needed, redo it against current main, starting from main's ` +
    `current version of the files it touched rather than your earlier diff.`
  );
}

/** The note injected into the `bugfix` healer's prompt when main's own suite is red (PLANS.md
 * "Red-main handoff"): the gate's warning event is harness-level and no role prompt reads it, so
 * the one role allowed to author on a red main is told what failed and that fixing it is this
 * tick's job. The healer's normal charter is a starting point, not a fit — a red main blocks
 * every other code role, and the gate's deterministic pre-check rejects any change that leaves
 * the suite red, so authoring anything else first is waste. A pure function so its shape is
 * pinned in tests; script/headline are optional because a red carries a failing script, but the
 * note must still read sensibly if it is ever absent. */
export function buildMainRedNote(sha: string, script?: string, headline?: string): string {
  const what = script
    ? `${script}${headline ? `: ${headline}` : ""}`
    : (headline ?? "the project's declared check");
  return `<main-red>
main's own suite is red at ${shortSha(sha)} (${what}). Every code-producing role is skipping authoring and no change merges until main is green.
This tick your job is to make main green: reproduce that failure, fix it (add a regression test where one is feasible), and land the fix.
The review gate's deterministic pre-check runs main + your change, so a change that leaves the suite red is rejected — do not author anything else first.
If the failure is environmental — flaky, load-sensitive, or a broken local toolchain — say so plainly in your reply rather than editing unrelated code.
</main-red>`;
}
