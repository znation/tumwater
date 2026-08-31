import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTHING_TO_DO,
  REFUSED_SENTINEL,
  extractRefusal,
  hasVerdictLine,
  isNothingToDo,
  verdictLines,
} from "../src/reply-contract.js";

test("isNothingToDo detects the sentinel", () => {
  assert.ok(isNothingToDo(`some reasoning\n${NOTHING_TO_DO}`));
  assert.ok(!isNothingToDo("all done\nSUMMARY: x"));
});

// The TUMWATER_REFUSED line blocks a PLANS.md/BUGS.md entry and routes a tick to handleRefusal
// (plans/refusal-and-thrash.md), so its detection semantics are load-bearing: pi.ts's boolean
// scan is deliberately loose (whole-reply includes), while the REASON extraction is anchored at
// line start so prose that merely mentions the sentinel cannot set it.

test("extractRefusal returns the trimmed reason from a line-start sentinel", () => {
  const text = `I will not force this plan.\n${REFUSED_SENTINEL}: it would delete user data\nSUMMARY: refused`;
  assert.equal(extractRefusal(text), "it would delete user data");
});

test("extractRefusal tolerates leading whitespace and extra spaces after the colon", () => {
  assert.equal(extractRefusal(`  ${REFUSED_SENTINEL}:    spaced out reason`), "spaced out reason");
});

test("extractRefusal returns null for a bare sentinel with no reason", () => {
  assert.equal(extractRefusal(`${REFUSED_SENTINEL}`), null);
  assert.equal(extractRefusal(`preamble\n${REFUSED_SENTINEL}:\n`), null, "colon but empty reason");
});

test("extractRefusal ignores mid-sentence mentions (line-start anchor)", () => {
  const text = `I considered ${REFUSED_SENTINEL}: no, that is not what I meant`;
  assert.equal(extractRefusal(text), null);
});

test("extractRefusal returns the first parseable line when several exist", () => {
  const text = `${REFUSED_SENTINEL}: first reason\n${REFUSED_SENTINEL}: second reason`;
  assert.equal(extractRefusal(text), "first reason");
});

// The verdict line is anchored at line start so prose that merely mentions "VERDICT:"
// mid-sentence cannot set the outcome — the prompt asks for exactly one, on its own line.

test("hasVerdictLine detects a VERDICT line at line start", () => {
  assert.ok(hasVerdictLine("VERDICT: approve"));
  assert.ok(hasVerdictLine("Some preamble.\nVERDICT: reject\n1. reason"));
});

test("hasVerdictLine ignores mid-sentence mentions and unknown verdicts", () => {
  assert.ok(!hasVerdictLine('I would say "VERDICT: approve" but let me check first'));
  assert.ok(!hasVerdictLine("VERDICT: maybe"));
  assert.ok(!hasVerdictLine("looks good to me, merging"));
});

test("verdictLines returns every verdict line in order with positions", () => {
  const text = "first\nVERDICT: approve\nthen\nVERDICT: reject";
  assert.deepEqual(verdictLines(text), [
    { index: 6, end: 22, verdict: "approve" },
    { index: 28, end: 43, verdict: "reject" },
  ]);
});

test("verdictLines is empty when no line matches", () => {
  assert.deepEqual(verdictLines("mentions VERDICT: approve inline"), []);
});
