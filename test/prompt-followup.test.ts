import test from "node:test";
import assert from "node:assert/strict";
import { buildCutOffNote, buildSummaryRequestPrompt } from "../src/prompt/prompt-followup.js";
import { NOTHING_TO_DO } from "../src/verdict/reply-contract.js";

// The follow-up prompts (src/prompt/prompt-followup.ts): the missing-summary recovery and the
// cut-off note, extracted from test/prompt.test.ts. The resume bridge's own suite — the
// fourth member of the family — lives beside this file in prompt-resume.test.ts.

test("buildCutOffNote counts the failed runs and offers nothing-to-do as the honest exit", () => {
  const one = buildCutOffNote(1);
  assert.match(one, /^Your previous run as this loop ran out of context before landing anything/);
  assert.match(one, /grep first, read in ranges, cap\s+command output/);
  assert.ok(one.includes(NOTHING_TO_DO));
  assert.match(buildCutOffNote(3), /^Your previous 3 runs as this loop/);
});

test("buildSummaryRequestPrompt asks for exactly the closing block and nothing else", () => {
  // The follow-up for a changed tick whose reply lacked SUMMARY (src/loop/loop.ts requestSummary):
  // it must name every label the commit-message parser reads and forbid further tool use.
  const p = buildSummaryRequestPrompt();
  assert.match(p, /did not include the required closing block/);
  assert.match(p, /no tool calls, no other text/);
  for (const label of ["SUMMARY:", "WHY:", "RISK:", "VERIFIED:"]) assert.ok(p.includes(label), label);
  assert.doesNotMatch(p, /VERDICT/, "must never read as a reviewer run");
});

// The harness attests the suite counts (PLANS.md 2026-09-29), so the VERIFIED line asks for
// what was run and observed beyond the total and no longer models a count ("182 pass") —
// authors restating counts was the top record-claim rejection at the review gate.
test("the VERIFIED line asks for observations beyond the suite total, not a count", () => {
  const p = buildSummaryRequestPrompt();
  assert.match(p, /beyond the suite total \(the harness attests the counts\)/);
  assert.match(p, /repro script showed X before, Y after/);
  assert.doesNotMatch(p, /182 pass/, "the count example is gone");
});
