/** Tests for src/prompt/gate-notes.ts — the notes that carry the merge gate's verdicts back to
 * the author role. Split out of gate-prompts.test.ts, which keeps the gate's pi-run prompts. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMergedPrerequisitesNote,
  buildMainKnownRedNote,
  buildMainRedNote,
  buildWaitingPartsNote,
  buildRejectedReviewNote,
} from "../src/prompt/gate-notes.js";
import { NEEDS_REPLAN_NOTE } from "../src/roles/role-guidance.js";

// The rejected-review note is the ONLY cross-tick memory of a failed change: every tick
// starts a fresh pi session, so if this note loses or mangles the reviewer's reasons the
// author role retries the same rejected work with no idea why it was refused.

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

// A rejection persists until a later reviewed merge overwrites it, and the paths that never reach a
// model review (the md-only exemption) leave it standing: without the timestamp an objection main
// has since satisfied keeps riding every later prompt as if fresh (BUGS.md, undated rejection
// note).
test("buildRejectedReviewNote dates the verdict and names the reviewed head", () => {
  const at = new Date(2026, 8, 24, 1, 20, 32).getTime();
  const note = buildRejectedReviewNote({ reasons: ["md-only edit"], at, head: "127157a4deadbeef" });
  assert.match(note, /rejected in review \(2026-09-24 01:20:32, head 127157a4\):/);
});

test("buildRejectedReviewNote omits the context when the review recorded neither time nor head", () => {
  const note = buildRejectedReviewNote({ reasons: ["md-only edit"] });
  assert.match(note, /rejected in review:/);
});

// A change that used its last revision round must not be re-authored from scratch: the same
// purpose would come back and the round would restart at 1 forever. Feature is sent to replan
// the PLANS.md entry it implemented; a plan-less role is sent to its notebook to record the
// abandoned purpose and take a different theme.
test("an exhausted feature rejection tells feature to replan, not re-author", () => {
  const note = buildRejectedReviewNote({ reasons: ["still wrong"], exhausted: true }, "feature");
  assert.ok(note.includes(NEEDS_REPLAN_NOTE), "names the replan note");
  assert.match(note, /do not re-author it/);
  assert.doesNotMatch(note, /re-author it from current main/);
  assert.ok(!buildRejectedReviewNote({ reasons: ["still wrong"], exhausted: true }, "bugfix").includes(NEEDS_REPLAN_NOTE));
});

// A plan-less role has no entry to replan, so its exhaustion note must not invite it to
// re-author: the same purpose re-derived from the same objections is the role this note ends.
test("an exhausted plan-less rejection records the purpose in the notes instead of re-authoring", () => {
  const note = buildRejectedReviewNote({ reasons: ["still wrong"], exhausted: true }, "bugfix");
  assert.match(note, /[Dd]o not re-author it/);
  assert.match(note, /abandoned purpose/);
  assert.match(note, /notes/);
  assert.match(note, /different theme/);
  assert.doesNotMatch(note, /re-author it from current main/);
});

// The red-main handoff note is the only signal a red main reaches the healer through: the
// harness warning event is team-level and no role prompt reads it, so this note's shape is
// the contract that points `bugfix` at the failing suite.
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

test("buildMainRedNote folds a bounded failing-check tail into the block before </main-red>", () => {
  const note = buildMainRedNote("abcdef1234567890", "test", "1) foo fails", [
    "1) foo fails",
    "AssertionError: x",
    "at Object.<anonymous>",
  ]);
  assert.match(note, /^<main-red>/);
  assert.match(note, /<\/main-red>$/);
  assert.ok(note.includes("1) foo fails"), "carries the failing test's name");
  assert.ok(note.includes("AssertionError: x"), "carries the assertion message");
  assert.ok(note.includes("at Object.<anonymous>"), "carries the stack line verbatim");
  assert.match(note, /Failing check output \(3 lines\)/);
  // The tail sits inside the block and below the directive lines, so the failure's own text
  // cannot be misread as instructions — and never leaks past the closing fence.
  assert.ok(note.indexOf("</main-red>") > note.indexOf("AssertionError: x"));
  assert.ok(note.indexOf("at Object.<anonymous>") < note.indexOf("</main-red>"));
});

test("buildMainRedNote renders the exact plain note for an absent, empty, or all-blank tail", () => {
  const plain = buildMainRedNote("abcdef1234567890", "test", "1) foo fails");
  for (const tail of [undefined, [], ["  "]]) {
    assert.equal(buildMainRedNote("abcdef1234567890", "test", "1) foo fails", tail), plain);
  }
});


test("buildMergedPrerequisitesNote lists each entry's title and range and caps at five", () => {
  const one = buildMergedPrerequisitesNote([{ title: "S, part 1/3: a", start: 10, end: 20 }]);
  assert.ok(one.startsWith("<merged-prerequisites>"));
  assert.ok(one.includes('"S, part 1/3: a" (PLANS.md lines 10-20)'));
  assert.ok(one.endsWith("</merged-prerequisites>"));
  const seven = buildMergedPrerequisitesNote(
    Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, start: i, end: i + 1 })),
  );
  assert.equal(seven.split("\n").filter((l) => l.startsWith('- "')).length, 5);
  assert.ok(seven.includes("- …and 2 more"));
  assert.ok(!seven.includes('"t5"'));
});

test("buildWaitingPartsNote lists each part's title and range and caps at five", () => {
  const one = buildWaitingPartsNote([{ title: "S, part 2/3: b", start: 10, end: 20 }]);
  assert.ok(one.startsWith("<waiting-parts>"));
  assert.ok(one.includes('"S, part 2/3: b" (PLANS.md lines 10-20)'));
  assert.ok(one.endsWith("</waiting-parts>"));
  const seven = buildWaitingPartsNote(Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, start: i, end: i + 1 })));
  assert.equal(seven.split("\n").filter((l) => l.startsWith('- "')).length, 5);
  assert.ok(seven.includes("- …and 2 more"));
  assert.ok(!seven.includes('"t5"'));
});

test("the prerequisite and waiting-part lists cut long titles at 100 characters", () => {
  const long = `S, part 2/3: b (planned 2026-10-17 by the plan role; touches ${"src/x.ts ".repeat(20).trim()})`;
  const entries = [{ title: long, start: 10, end: 20 }];
  for (const build of [buildMergedPrerequisitesNote, buildWaitingPartsNote]) {
    const note = build(entries);
    assert.ok(!note.includes(long));
    const quoted = /- "([^"]*)" \(PLANS\.md lines 10-20\)/.exec(note)?.[1];
    assert.ok(quoted?.endsWith("…"), String(quoted));
    assert.equal(Array.from(quoted!).length, 101, "100 characters, then the ellipsis");
    assert.ok(build([{ title: "Short title", start: 1, end: 2 }]).includes('"Short title"'));
  }
});

test("buildMainKnownRedNote lists the failing tests, at most 20, in a <main-known-red> block", () => {
  const note = buildMainKnownRedNote(["a fails", "b fails"]);
  assert.ok(note.startsWith("<main-known-red>") && note.endsWith("</main-known-red>"));
  assert.ok(note.includes("- a fails\n- b fails\n"));
  assert.ok(note.includes("a change merges when it adds no new failures"));
  const many = buildMainKnownRedNote(Array.from({ length: 23 }, (_, i) => `t${i}`));
  assert.ok(many.includes("- t19\n") && !many.includes("- t20\n"));
  assert.ok(many.includes("- …and 3 more"));
});
