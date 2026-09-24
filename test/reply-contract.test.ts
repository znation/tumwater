import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTHING_TO_DO,
  REFUSED_SENTINEL,
  extractFlow,
  extractRefusal,
  hasVerdictLine,
  isNegatedRefusal,
  isNothingToDo,
  labeledLine,
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

// isNegatedRefusal (BUGS.md 2026-09-23): four ticks ended ordinary work-completed replies
// with `TUMWATER_REFUSED: none` — the prompt lists the line beside the reply-contract fields,
// so a compliant model fills it in — and the harness destroyed their tested work. A reason
// that negates the refusal is not a refusal.

test("isNegatedRefusal negates empty, none, and n/a in every recorded shape", () => {
  for (const reason of [undefined, null, "", "   ", "none", "NONE", "n/a", "N/A", "(none)", "(n/a)", "(none — no entry refused this run)", "none — bug filed normally"])
    assert.ok(isNegatedRefusal(reason), `negated: ${JSON.stringify(reason)}`);
});

test("isNegatedRefusal keeps a real reason a refusal", () => {
  for (const reason of [
    "it would delete user data",
    "conflicts with PRINCIPLES.md",
    "nonone of the above",
    "annotation, not refusal",
  ])
    assert.ok(!isNegatedRefusal(reason), `a refusal: ${JSON.stringify(reason)}`);
});

test("extractRefusal returns the first parseable line when several exist", () => {
  const text = `${REFUSED_SENTINEL}: first reason\n${REFUSED_SENTINEL}: second reason`;
  assert.equal(extractRefusal(text), "first reason");
});

// labeledLine is the shared parser every reply-field extraction goes through (SUMMARY/WHY/
// RISK/VERIFIED in commit-message.ts, the TUMWATER_REFUSED reason above). These tests pin its
// full contract directly — including the bare-label branch, which only surfaces when a label
// line carries no content of its own.

test("labeledLine returns the trimmed value of the first matching line", () => {
  assert.equal(labeledLine("SUMMARY: did a thing\nWHY: because", "SUMMARY"), "did a thing");
  assert.equal(labeledLine("  SUMMARY:   indented and padded  ", "SUMMARY"), "indented and padded");
});

test("labeledLine matches only whole labels at line start, not words containing them", () => {
  // A longer label sharing the prefix must not match — but a later real line still does.
  assert.equal(labeledLine("SUMMARYX: nope\nSUMMARY: real", "SUMMARY"), "real");
  assert.equal(labeledLine("MY_SUMMARY: nope", "SUMMARY"), null);
});

test("labeledLine returns the first match when several lines carry the label", () => {
  assert.equal(labeledLine("A: one\nA: two", "A"), "one");
});

test("labeledLine captures the following line when a label line carries no content", () => {
  // The value pattern is \\s*(.+)\\s*$ and \\s spans newlines, so a bare (or whitespace-only)
  // label line swallows the next line as its value. This leniency is what lets a model that
  // wraps after "TUMWATER_REFUSED:" still hand over its reason; pin it so tightening the regex
  // to stay on one line becomes a deliberate, test-visible change.
  assert.equal(labeledLine("preamble\nSUMMARY:\nthe real summary", "SUMMARY"), "the real summary");
  assert.equal(labeledLine("SUMMARY:   \nwrapped value", "SUMMARY"), "wrapped value");
});

test("labeledLine returns null when a bare label has no following content", () => {
  assert.equal(labeledLine("preamble\nSUMMARY:", "SUMMARY"), null);
  assert.equal(labeledLine("preamble\nSUMMARY:\n", "SUMMARY"), null);
  assert.equal(labeledLine("no labels here at all", "SUMMARY"), null);
});

test("labeledLine matches each label independently (a swallowed line is not consumed)", () => {
  // A bare WHY swallows the RISK line as its value, but the RISK label still matches on its
  // own — extracting one field never hides another.
  const text = "WHY: \nRISK: real risk";
  assert.equal(labeledLine(text, "WHY"), "RISK: real risk");
  assert.equal(labeledLine(text, "RISK"), "real risk");
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

// The `qa` observer ends each tick with a result-carrying FLOW line (plans/observer-roles.md
// 2/2); the harness parses it to rotate the flow menu. Anchored at line start through
// labeledLine, so a mid-sentence mention cannot advance the ledger, and the verdict is
// required: a bare name is not a pass the run never declared.

test("extractFlow parses a result-carrying FLOW line", () => {
  assert.deepEqual(extractFlow("ran the flow\nFLOW: status — passed"), { flow: "status", result: "passed" });
  assert.deepEqual(extractFlow("FLOW: prompt - bug"), { flow: "prompt", result: "bug" });
  assert.deepEqual(extractFlow("FLOW: run (real) — passed"), { flow: "run (real)", result: "passed" });
});

test("extractFlow requires the verdict and keeps hyphens in the name", () => {
  // A bare `FLOW: <name>` — or a reply truncated mid-verdict — is not a result (BUGS.md
  // 2026-09-23): returning null leaves the rotation unadvanced instead of latching a pass.
  assert.equal(extractFlow("FLOW: status"), null);
  assert.equal(extractFlow("FLOW: gui-budget-cap — pa"), null);
  assert.deepEqual(extractFlow("FLOW: reset-counters — passed"), {
    flow: "reset-counters",
    result: "passed",
  });
});

test("extractFlow returns null when absent, empty, or only mid-sentence", () => {
  assert.equal(extractFlow("no flow line here\nSUMMARY: did it"), null);
  assert.equal(extractFlow("FLOW:"), null);
  assert.equal(extractFlow("I considered FLOW: status but did not run it"), null);
});
