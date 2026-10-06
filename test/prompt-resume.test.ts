import test from "node:test";
import assert from "node:assert/strict";
import { buildResumePrompt } from "../src/prompt/prompt-followup.js";
import { NOTHING_TO_DO } from "../src/verdict/reply-contract.js";
import { oneLine } from "./oracles.js";

// The resume bridge (src/prompt/prompt-followup.ts buildResumePrompt): the prompt sent into the SAME pi
// session as an interrupted run, which already carries the original prompt and work — so it
// only bridges the gap. Its contract matters: without the restated sentinel/SUMMARY rules the
// harness could not parse a resumed tick's end. One home for every cause's bridge, extracted
// from test/prompt.test.ts, where the cluster was scattered across three regions.

test("buildResumePrompt tells the resumed session to finish the same task", () => {
  const p = buildResumePrompt("feature");
  // Names the role and explains why this run is different: a restart mid-run, with the
  // worktree left exactly as it was.
  assert.match(p, /"feature"/);
  assert.match(p, /restarted/i);
  // A tool call may have been cut off by the restart — verify its effect before relying on it.
  assert.match(p, /verify its effect/i);
  // Continue the interrupted task rather than picking a new one.
  assert.match(p, /Continue the SAME task/);
  // The harness contract that lets a resumed tick end cleanly is restated: one focused
  // task, no git commits by pi, and the sentinel + SUMMARY line the harness parses.
  assert.match(p, /ONE focused task/);
  assert.match(p, /Never create, amend, or revert git commits/);
  assert.ok(p.includes(NOTHING_TO_DO));
  assert.ok(
    p.includes("SUMMARY: <imperative one-line description of the change, at most 72 characters>"),
  );
});

test("buildResumePrompt differs across roles only in the role name", () => {
  const a = buildResumePrompt("feature");
  const b = buildResumePrompt("clean").replaceAll('"clean"', '"feature"');
  assert.equal(b, a, "no per-role drift in the bridge instructions");
});

// BUGS.md 2026-09-12 (fixed 2026-09-13): a quiet-killed run resumes with its session and edits
// intact — the bridge must name the real cause so the resumed session does not re-run the hung
// command unchanged, instead of lying that "the harness was restarted".
test("buildResumePrompt names a quiet-kill so the session does not re-run the hung command", () => {
  const p = buildResumePrompt("bugfix", "hung-tool");
  assert.match(p, /"bugfix"/);
  // The real cause is named: no progress long enough to trip the hang watchdog — not a restart.
  assert.match(p, /hang watchdog/i);
  assert.doesNotMatch(p, /restarted/i);
  // The killed tool call must not be re-run unchanged; its effect needs verifying.
  assert.match(p, /do not re-run it unchanged/);
  assert.match(p, /verify the effect/i);
  // Same task continues, same closing contract as every other bridge.
  assert.match(p, /Continue the SAME task/);
  assert.ok(p.includes(NOTHING_TO_DO));
});

// The fourth resume cause — a run the tick time limit stopped while it was still making
// progress (loop.ts's quiet_killed with resumeCause "timeout"). Its bridge differs from a
// restart's in the load-bearing way: the limit will bite again, so the resumed run must
// budget against it rather than only verifying a cut-off tool call.
test("buildResumePrompt names a tick timeout and asks for a finish that fits the limit", () => {
  const p = buildResumePrompt("coverage", "timeout");
  assert.match(p, /"coverage"/);
  // The real cause is named: the tick time limit, framed as slow — not a failed run, not a
  // restart — so the resumed session does not treat its preserved work as suspect.
  assert.match(p, /tick time limit/i);
  assert.match(p, /a slow run, not a failed one/i);
  assert.doesNotMatch(p, /restarted/i);
  // The limit will bite again: finish small and within it, without re-exploring.
  assert.match(p, /budget against/i);
  assert.match(p, /smallest change that completes the task coherently/);
  assert.match(p, /Do not restart broad exploration/);
  // Same task continues, same closing contract as every other bridge.
  assert.match(p, /Finish the SAME task/);
  assert.ok(p.includes(NOTHING_TO_DO));
});

// The fifth resume cause — a run the budget gate reopened mid-flight on the fallback model,
// handed back to the primary (PLANS.md 2026-09-30). Its bridge must name the model move (the
// session continues on a different backend, which no other cause says) without claiming a
// restart, and the four existing causes' texts must stay untouched.
test("buildResumePrompt names a budget handback's move back to the primary", () => {
  const p = buildResumePrompt("feature", "budget-resumed");
  assert.match(p, /"feature"/);
  assert.match(p, /budget has reopened/i);
  assert.match(p, /fallback model/);
  assert.match(p, /primary model/);
  assert.doesNotMatch(p, /restarted/i);
  assert.match(p, /worktree is exactly as you left it/i);
  // Same task continues, same closing contract as every other bridge.
  assert.match(p, /Continue the SAME task/);
  assert.ok(p.includes(NOTHING_TO_DO));

  // The new branch changed no existing cause's text: the default restart bridge mentions
  // neither model, and the other named causes neither.
  assert.doesNotMatch(buildResumePrompt("feature"), /fallback model|primary model/);
  assert.doesNotMatch(buildResumePrompt("bugfix", "hung-tool"), /fallback model|primary model/);
  assert.doesNotMatch(buildResumePrompt("coverage", "timeout"), /fallback model|primary model/);
  assert.doesNotMatch(buildResumePrompt("clean", "cut-off"), /fallback model|primary model/);
});

test("buildResumePrompt names a context-ceiling cut-off and asks for the smallest finish", () => {
  const p = buildResumePrompt("clean", "cut-off");
  assert.match(p, /"clean"/);
  assert.match(p, /ran out of context before it could finish/);
  assert.match(p, /compacted the session/);
  assert.match(p, /Do NOT re-read the codebase/);
  assert.match(p, /smallest change that\s+completes it/);
  assert.match(p, /scope it down to what is\s+already complete/);
  assert.doesNotMatch(p, /restarted/, "a cut-off is not a restart — the bridge must not claim one");
  // The harness contract is restated on both bridges.
  assert.match(p, /ONE focused task/);
  assert.match(p, /Never create, amend, or revert git commits/);
  assert.ok(p.includes(NOTHING_TO_DO));
  assert.ok(p.includes("SUMMARY: <imperative one-line description of the change, at most 72 characters>"));
  assert.equal(buildResumePrompt("clean"), buildResumePrompt("clean", "restart"), "restart is the default cause");
});

test("the cut-off resume bridge carries a numeric re-reading budget and the plain-text ending rule", () => {
  const p = oneLine(buildResumePrompt("feature", "cut-off"));
  assert.match(p, /at most ~10 tool calls of re-reading, and never the same file twice/);
  assert.match(p, /Your last message is plain text — never a tool call or an announcement of a next step/);
  // The restart bridge shares the ending rule but never the cut-off text.
  const restart = oneLine(buildResumePrompt("feature"));
  assert.match(restart, /Your last message is plain text/);
  assert.doesNotMatch(restart, /ran out of context/);
});
