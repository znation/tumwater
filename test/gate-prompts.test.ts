/** Tests for src/gates/gate-prompts.ts — the landing gate's prompts: conflict resolution after a
 * rebase, the adversarial pre-merge review, and the notes that carry the gate's verdicts back
 * to the author loop. Split out of prompt.test.ts, which keeps the role-loop prompt builders'
 * tests; gate prompts are started by the harness's merge/review pipeline, not the role ticks,
 * so their contracts live beside their own module. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConflictPrompt,
  buildMainRedNote,
  buildRejectedReviewNote,
  buildReviewPrompt,
} from "../src/gates/gate-prompts.js";
import { parseVerdict } from "../src/review/review-verdict.js";
import { NOTHING_TO_DO } from "../src/reply-contract.js";
import { TEST_RUNNER_RULE } from "../src/prompt/prompt.js";
import { oneLine } from "./oracles.js";

// The conflict prompt drives pi's one-shot merge-conflict resolution run. Its contract is
// load-bearing in ways the loop-level fake-pi tests cannot see (the fake ignores prompt
// content): pi must know exactly which files hold markers, what "ours"/"theirs" mean, and —
// critically — that it may not touch git state itself, or its own commit/rebase would collide
// with the harness's continueRebase.

test("buildConflictPrompt names the role and lists every conflicted file", () => {
  const p = buildConflictPrompt("bugfix", ["src/git.ts", "docs/notes.md"]);
  assert.match(p, /"bugfix" loop/);
  // The situation is explained: a rebase onto main stopped on conflicts in the worktree.
  assert.match(p, /A rebase of\nyour work branch onto main stopped on conflicts/);
  // Every conflicted file is listed as its own bullet so pi knows exactly where to look —
  // the harness later re-checks markers in precisely these files.
  assert.ok(
    p.includes("Conflicted files:\n- src/git.ts\n- docs/notes.md"),
    "each conflicted file on its own line",
  );
});

test("buildConflictPrompt defines ours/theirs and asks for a combined resolution", () => {
  const p = buildConflictPrompt("feature", ["a.txt"]);
  // Picking the wrong side silently drops work: the prompt must define which side is which.
  assert.match(p, /"ours" is this branch's change/);
  assert.match(p, /"theirs" is the latest main/);
  assert.match(p, /combining the intent of BOTH sides/i);
});

test("buildConflictPrompt drops the branch's edit where main deliberately removed or replaced it", () => {
  const p = buildConflictPrompt("feature", ["a.txt"]);
  assert.match(p, /deliberately removed or replaced/);
  assert.match(p, /the branch's edit is dropped/);
  assert.match(p, /Never merge\s+the branch's version back in/);
});

test("buildConflictPrompt treats backlog section headings as structure, not text", () => {
  const p = buildConflictPrompt("feature", ["PLANS.md", "src/git.ts"]);
  // The failure this pins (PLANS.md 2026-09-30, part 1/3): a conflict resolution kept both
  // sides' `## Done` headings, and a new plan landed under the first one, outside Planned.
  assert.match(p, /markdown backlog file \(PLANS\.md, BUGS\.md, QUESTIONS\.md\)/);
  assert.match(p, /section headings are structure, not text/);
  assert.match(p, /exactly one of each\n  \`## \` heading/);
  assert.match(p, /every \`### \` entry sits under the section its own side put it in/);
  assert.match(p, /stays under \`## Planned\` even when the other side moved entries/);
});

test("buildConflictPrompt forbids state-changing git commands (harness concludes the rebase)", () => {
  const p = buildConflictPrompt("clean", ["a.txt"]);
  // If pi committed or continued the rebase itself, the harness's continueRebase would
  // collide with it — the prompt keeps pi to file edits only.
  assert.match(p, /Edit files only/);
  assert.match(p, /no add, commit, merge, rebase/);
  assert.match(p, /the harness concludes the rebase for you/i);
  // Reading git state stays allowed — resolving well may need it.
  assert.match(p, /Reading git state is fine/i);
});

// BUGS.md 2026-10-05: told only to keep the tests passing, a resolver guessed `npx vitest run` in
// a node:test repo and killed the suite's tests mid-run. The prompt names the project's own check
// the way the tick rules do, and carries the shared test-runner rule either way.
test("buildConflictPrompt names the project's declared check and forbids a guessed test runner", () => {
  const npm = oneLine(buildConflictPrompt("organize", ["a.ts"], { kind: "npm", rootDir: ".", script: "test" }));
  assert.match(npm, /Keep the project building and its tests passing — verify with `npm run test` \(the project's declared check\)\./);
  const configured = oneLine(
    buildConflictPrompt("organize", ["a.ts"], { kind: "command", command: "pytest -q", cwd: "/tmp/r", timeoutMs: 1000 }),
  );
  assert.match(configured, /verify with `pytest -q` \(the project's declared check\)\./);
  // No check: the generic sentence, with no command to name.
  const none = buildConflictPrompt("organize", ["a.ts"]);
  assert.match(none, /Keep the project building and its tests passing\.\n/);
  assert.doesNotMatch(none, /verify with/);
  for (const p of [npm, configured, oneLine(none)]) assert.ok(p.includes(oneLine(TEST_RUNNER_RULE)), "the test-runner rule");
});

test("buildConflictPrompt keeps the project building and ends by stopping", () => {
  const p = buildConflictPrompt("improve", ["a.txt"]);
  // The harness only re-checks conflict markers after this run; keeping the build green
  // is pi's own diligence, so the prompt must ask for it.
  assert.match(p, /Keep the project building and its tests passing/);
  // The run's only job is resolving the markers: it ends by stopping — no new task,
  // no sentinel or SUMMARY line (this flow parses neither from pi's reply).
  assert.match(p, /just stop/i);
  assert.ok(!p.includes(NOTHING_TO_DO), "no tick sentinel in a conflict run");
});

// The rejected-review note is the ONLY cross-tick memory of a failed change: every tick
// starts a fresh pi session, so if this note loses or mangles the reviewer's reasons the
// author loop retries the same rejected work with no idea why it was refused.

test("buildRejectedReviewNote carries every reason, numbered in order", () => {
  const note = buildRejectedReviewNote({ reasons: ["violates zero-deps principle", "half-done: no tests"] });
  assert.match(note, /rejected in review/);
  assert.ok(note.includes("1. violates zero-deps principle\n2. half-done: no tests"), "numbered list");
  assert.match(note, /Address the objections or take a different approach/);
});

test("buildRejectedReviewNote degrades to a placeholder when no reasons were recorded", () => {
  const note = buildRejectedReviewNote({ reasons: [] });
  assert.ok(note.includes("(no reasons recorded)"), "says so rather than listing nothing");
  assert.match(note, /rejected in review/);
});

// A rejection persists until a later reviewed landing overwrites it, and the paths that never
// reach a model review (the md-only exemption) leave it standing: without the timestamp an
// objection main has since satisfied keeps riding every later prompt as if fresh (BUGS.md,
// undated rejection note).
test("buildRejectedReviewNote dates the verdict and names the reviewed head", () => {
  const at = new Date(2026, 8, 24, 1, 20, 32).getTime();
  const note = buildRejectedReviewNote({ reasons: ["md-only edit"], at, head: "127157a4deadbeef" });
  assert.match(note, /rejected in review \(2026-09-24 01:20:32, head 127157a4\):/);
});

test("buildRejectedReviewNote omits the context when the review recorded neither time nor head", () => {
  const note = buildRejectedReviewNote({ reasons: ["md-only edit"] });
  assert.match(note, /rejected in review:/);
});

// The red-main handoff note is the only signal a red main reaches the healer through: the
// harness warning event is fleet-level and no role prompt reads it, so this note's shape is
// the contract that points `bugfix` at the failing suite (PLANS.md "Red-main handoff").
test("buildMainRedNote names the short SHA, script, and failure headline in a <main-red> block", () => {
  const note = buildMainRedNote("abcdef1234567890", "test", "1) foo fails");
  assert.match(note, /^<main-red>/);
  assert.match(note, /<\/main-red>$/);
  assert.ok(note.includes("abcdef12"), "carries the shortened SHA");
  assert.ok(note.includes("test: 1) foo fails"), "names the script and headline together");
  assert.match(note, /make main green/);
  assert.match(note, /reproduce that failure/);
  assert.match(note, /regression test/);
  assert.match(note, /review gate's deterministic pre-check/);
  assert.match(note, /environmental/);
});

test("buildMainRedNote degrades when the script or headline is absent", () => {
  const noHeadline = buildMainRedNote("abcdef1234567890", "test");
  assert.ok(noHeadline.includes("(test)"), "a scriptless failure tail still names the script");
  const neither = buildMainRedNote("abcdef1234567890");
  assert.ok(neither.includes("the project's declared check"), "falls back to a readable phrase");
});


// Prompt contract for the review gate (src/review/review.ts): the reviewer is told to end with
// exactly one VERDICT line, and a reply without a parseable line fails the review closed —
// three such failures discard the commit. If the form the prompt advertises ever drifts from
// what parseVerdict accepts, every real merge starts failing; no e2e test can catch it because
// the fake pi emits whatever the test tells it to.

test("buildReviewPrompt advertises exactly the verdict forms parseVerdict accepts", () => {
  const prompt = oneLine(buildReviewPrompt("diff body"));
  assert.match(prompt, /End your reply with exactly one line in this form/);
  // The instruction names both forms as line-start "VERDICT: <word>" tokens — nothing else.
  const advertised = [...prompt.matchAll(/VERDICT:\s*(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(advertised, ["approve", "reject"]);
  // A reply written exactly as instructed — preamble, the final line in the advertised form,
  // then numbered reasons — must parse to that verdict with its reasons in order.
  for (const v of ["approve", "reject"]) {
    const reply = `I checked the diff against the principles.\nVERDICT: ${v}\n1. build passes\n2. no new deps`;
    assert.deepEqual(parseVerdict(reply), { verdict: v, reasons: ["build passes", "no new deps"] });
  }
});

test("buildReviewPrompt embeds diff, summary, commit body, and principles verbatim", () => {
  const prompt = buildReviewPrompt(
    "diff-body-marker",
    "summary-marker",
    "body-marker",
    "principles-marker",
  );
  assert.ok(prompt.includes("<diff>\ndiff-body-marker\n</diff>"));
  assert.match(prompt, /The author's summary of the change:\nsummary-marker/);
  assert.match(prompt, /claimed motivation, risk, verification — check these claims against the diff\):\nbody-marker/);
  assert.ok(prompt.includes("<principles>\nprinciples-marker\n</principles>"));
});

test("buildReviewPrompt omits optional sections when their arguments are absent", () => {
  const prompt = buildReviewPrompt("diff-only");
  assert.ok(!prompt.includes("The author's summary of the change:"), "no empty summary section");
  assert.ok(!prompt.includes("The author's commit body"), "no empty commit-body section");
  assert.ok(!prompt.includes("<principles>"), "no principles block without a file");
});

test("the review prompt carries the fan-out rule in its reading budget and still advertises VERDICT exactly twice", () => {
  const prompt = buildReviewPrompt("diff body");
  const flat = oneLine(prompt);
  assert.match(flat, /Batch the independent reads/);
  assert.match(flat, /sibling tool calls in one turn/);
  assert.match(flat, /turns, not tool calls, are the expensive unit/);
  assert.match(flat, /keep anything that depends on a prior result sequential/);
  // The verdict contract is untouched: exactly the two advertised forms, nothing else.
  assert.equal([...prompt.matchAll(/VERDICT:/g)].length, 2);
});


test("buildReviewPrompt carries the reviewer checklist and a reading budget", () => {
  const prompt = oneLine(buildReviewPrompt("diff body"));
  assert.match(prompt, /Read only what the diff touches: the changed functions, their callers, and the tests that cover them/);
  // The local-model retune (2026-10-01): the fallback model's reviews spent their first turns
  // re-fetching the inline diff, then timed out — so the procedure says the diff is already here
  // and bounds the turns.
  assert.match(prompt, /The diff above is current — read it there; do not fetch it again with `git diff`/);
  assert.match(prompt, /Only when it opens with a "\[diff truncated: …\]" note/);
  assert.match(prompt, /Most reviews need two to four turns of tool calls/);
  assert.match(prompt, /stop reading and write the verdict/);
  assert.match(prompt, /Check, in this order: 1\. Does the diff do exactly what the summary and WHY claim/);
  assert.match(prompt, /2\. Are the VERIFIED claims consistent with the diff/);
  // Suite counts are the harness's own attestation (PLANS.md 2026-09-29): the checklist sends
  // the reviewer to the passed-check line instead of judging a stated total.
  assert.match(prompt, /Suite counts are the harness's own attestation/);
  assert.match(prompt, /a count missing from VERIFIED is not a finding/);
  // A miscounted author-stated total is not a rejection on its own (2026-10-01: several fleet
  // rejections of correct changes were off-by-one test counts) — the reviewer judges the tests.
  assert.match(prompt, /neither is an author-stated count that differs from it: judge whether the tests exist and exercise the change \(check 3\), not the author's arithmetic/);
  assert.match(prompt, /3\. Do new or changed tests exercise the new behavior — would they fail without the change\?/);
  assert.match(prompt, /4\. For a planned feature or recorded bug, does the change deliver what its PLANS\.md\/BUGS\.md entry promises/);
  // A newer user instruction supersedes an older recorded entry ("latest instruction wins"): the
  // reviewer judges against the newer purpose and only rejects stale entries or incoherent work.
  assert.match(prompt, /judge it against that newer purpose — contradicting an older recorded fix direction is not itself a defect/);
  assert.match(prompt, /leaves the existing entry stale and contradictory \(updating the entry in place is the author's duty\)/);
  assert.match(prompt, /5\. Does anything violate a principle above/);
  assert.match(prompt, /Reject only for concrete, verifiable defects you can name/);
  // A scratch copy under temp is allowed (reviewers measure there); the worktree stays untouched.
  assert.match(prompt, /a scratch copy under the system temp directory is fine/);
  assert.match(prompt, /Do not edit any file in the worktree/);
});

test("buildReviewPrompt names the harness's green pre-check when given, and omits the section otherwise", () => {
  const withCheck = buildReviewPrompt("diff", undefined, undefined, undefined, undefined, "`npm run test` passed");
  assert.match(
    withCheck,
    /The harness already ran the project's own check on this exact tree and it passed:\n`npm run test` passed\./,
  );
  assert.match(oneLine(withCheck), /Spend your run on what a green check cannot show/);
  const without = buildReviewPrompt("diff");
  assert.ok(!without.includes("The harness already ran"), "no pre-check section without a verdict");
  // The verdict-form contract survives the extra section: still exactly the two advertised forms.
  const advertised = [...oneLine(withCheck).matchAll(/VERDICT:\s*(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(advertised, ["approve", "reject"]);
  assert.equal([...withCheck.matchAll(/VERDICT:/g)].length, 2);
});

// BUGS.md 2026-09-23: reviewers told "Do not spend your run re-running it" in the context
// paragraph re-ran the suite in scratch copies under /tmp anyway. The rule is now its own line in
// the rules list — naming the scratch-copy route as a re-run and allowing one specific test — and
// it exists only behind a verified pre-check: with no green run (timed out, killed, skipped, no
// declared check) a reviewer running the suite itself is doing its job.
test("the review prompt's no-re-run rule is one rules-list line, present only behind a verified pre-check", () => {
  const withCheck = buildReviewPrompt("diff", undefined, undefined, undefined, undefined, "`npm run test` passed");
  const rules = withCheck.slice(withCheck.indexOf("Rules for this run:"));
  assert.match(
    rules,
    /\n- Do not re-run the check named above or the project's full test suite: the harness's green run\n  is the verified result\./,
    "a rules-list item of its own",
  );
  const flat = oneLine(rules);
  assert.match(
    flat,
    /reinstalling dependencies there \(for an npm project, `npm ci`; otherwise its equivalent\) — counts as re-running it\./,
  );
  assert.match(flat, /Running one specific test file for a concrete reason you can name is fine\./);
  // It qualifies the scratch-copy allowance, so it follows it directly.
  assert.match(flat, /directory is fine when you need to run something\. - Do not re-run the check named above/);
  // Stated once: the old in-paragraph sentence is gone, and no other "re-run" instruction repeats it.
  const flatAll = oneLine(withCheck);
  assert.doesNotMatch(flatAll, /Do not spend your run re-running it/);
  assert.equal([...flatAll.matchAll(/Do not re-run/g)].length, 1);
  assert.equal([...withCheck.matchAll(/VERDICT:/g)].length, 2);

  const without = oneLine(buildReviewPrompt("diff"));
  assert.doesNotMatch(without, /Do not re-run|re-running it/, "no verified result, no rule");
  assert.match(without, /directory is fine when you need to run something\. - Run tests only through the project's declared check/);
  assert.equal([...without.matchAll(/VERDICT:/g)].length, 2);
});

test("buildConflictPrompt bounds reading to the conflicted files", () => {
  const p = oneLine(buildConflictPrompt("dry", ["src/a.ts"]));
  assert.match(p, /Read only the conflicted files and what they directly reference/);
  assert.match(p, /`grep -n '<<<<<<<' FILE`/);
});
