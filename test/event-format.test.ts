import test from "node:test";
import assert from "node:assert/strict";
import { formatEvent } from "../src/event-format.js";

test("formatEvent renders each type as one line", () => {
  const cases = [
    { ts: 0, loop: "clean", type: "tick_start", tick: 3 },
    { ts: 0, loop: "clean", type: "tick_end", tick: 3, result: "changed", summary: "tidy up" },
    { ts: 0, loop: "clean", type: "tick_end", tick: 4, result: "error", error: "boom" },
    { ts: 0, loop: "clean", type: "merged", commit: "abcdef1234567890", summary: "tidy up" },
    { ts: 0, loop: "harness", type: "orchestrator_start", pid: 1 },
    { ts: 0, loop: "director", type: "prompt_enqueued", preview: "do x" },
  ] as const;
  for (const e of cases) {
    const line = formatEvent(e as never);
    assert.ok(line.includes(e.loop), `line should name the loop: ${line}`);
    assert.ok(!line.includes("\n"));
  }
  assert.match(formatEvent(cases[1] as never), /tidy up/);
  assert.match(formatEvent(cases[2] as never), /boom/);
  assert.match(formatEvent(cases[3] as never), /abcdef12/);
});

test("formatEvent renders wake reasons and warning messages operators rely on", () => {
  // These are the diagnostic lines read in logs/TUI/GUI when figuring out why a loop woke or
  // what went wrong: the reason and message payloads must survive formatting.
  const wake = formatEvent({ ts: 0, loop: "clean", type: "wake", reason: "main moved" } as never);
  assert.match(wake, /woke \(main moved\)/, `wake line must carry its reason: ${wake}`);

  const warn = formatEvent({
    ts: 0,
    loop: "harness",
    type: "warning",
    message: "tumwater.json invalid — keeping current config",
  } as never);
  assert.match(warn, /warning: tumwater\.json invalid/, `warning line must carry its message: ${warn}`);

  const stop = formatEvent({ ts: 0, loop: "harness", type: "orchestrator_stop" } as never);
  assert.match(stop, /orchestrator stopped/);
});

test("formatEvent carries the reason on non-changed tick outcomes", () => {
  // The event feed is where operators see why a tick did not land its work. refused and
  // rejected ticks log their reason in `summary`, merge failures log lastError in `error` —
  // showing only "changed"/"error" left those outcomes as bare result words.
  const refused = formatEvent({
    ts: 0,
    loop: "feature",
    type: "tick_end",
    tick: 7,
    result: "refused",
    summary: "plan harms the architecture",
  } as never);
  assert.match(refused, /tick #7 refused — plan harms the architecture/, `refusal reason must show: ${refused}`);

  const rejected = formatEvent({
    ts: 0,
    loop: "feature",
    type: "tick_end",
    tick: 8,
    result: "rejected",
    summary: "adds a runtime dep",
  } as never);
  assert.match(rejected, /tick #8 rejected — adds a runtime dep/, `rejection detail must show: ${rejected}`);

  const mergeFailed = formatEvent({
    ts: 0,
    loop: "bugfix",
    type: "tick_end",
    tick: 9,
    result: "merge_conflict",
    error: "merge failed: merge_conflict",
  } as never);
  assert.match(mergeFailed, /tick #9 merge_conflict — merge failed: merge_conflict/, `merge failure must show its error: ${mergeFailed}`);

  // review_error ticks carry both (summary = gate detail, error = "review failed: …"); the
  // summary is the more specific of the two and wins.
  const reviewError = formatEvent({
    ts: 0,
    loop: "feature",
    type: "tick_end",
    tick: 10,
    result: "review_error",
    summary: "no parseable VERDICT line in the reviewer's reply",
    error: "review failed: no parseable VERDICT line in the reviewer's reply",
  } as never);
  assert.match(reviewError, /tick #10 review_error — no parseable VERDICT line/);
});

test("formatEvent renders a no-change tick with no summary or error suffix", () => {
  // The third arm of the tick_end ternary is the empty string: a regression that gave every
  // result a suffix would print "— undefined" on every idle tick in every display surface.
  const line = formatEvent({ ts: 0, loop: "clean", type: "tick_end", tick: 5, result: "no_change" } as never);
  assert.match(line, /tick #5 no_change$/, `no-change tick must end at the result: ${line}`);
});

test("formatEvent degrades gracefully for unknown event types", () => {
  // The default branch is a safety net: HarnessEvent's union has no exhaustiveness check, so a
  // type added in types.ts without a case here would otherwise render empty or crash on every
  // display surface. Pin the graceful fallback.
  const line = formatEvent({ ts: 0, loop: "clean", type: "brand_new_type" } as never);
  assert.match(line, /clean\s+brand_new_type/, `unknown types must still render their name: ${line}`);
});

test("formatEvent renders counters_reset plainly, naming all roles when several are affected", () => {
  const single = formatEvent({ ts: 0, loop: "clean", type: "counters_reset" } as never);
  assert.match(single, /clean\s+counters reset \(ticks, commits, tokens, cost\)/);
  const multi = formatEvent(
    { ts: 0, loop: "harness", type: "counters_reset", roles: ["feature", "bugfix"] } as never,
  );
  assert.match(multi, /harness\s+counters reset for feature, bugfix \(ticks, commits, tokens, cost\)/);
});

// The review-gate lines are what operators read in logs/TUI/GUI when a merge stalls on the
// gate: head is truncated to 8 chars, only the first rejection reason shows, and the optional
// payloads (approval reason, reasons list) must degrade instead of printing "undefined".
test("formatEvent renders the review-gate events with truncated heads and safe fallbacks", () => {
  const head = "0123456789abcdef"; // full hash as logged by review.ts

  const start = formatEvent({ ts: 0, loop: "feature", type: "review_start", head } as never);
  assert.match(start, /feature\s+reviewing 01234567 before merge/);
  assert.ok(!start.includes("89abcdef"), `full hash must not leak into the line: ${start}`);

  // Approvals carry reason = verdict.reasons[0], which is undefined when the reviewer gave
  // none: the suffix must vanish, not print "— undefined".
  const bareApproval = formatEvent({ ts: 0, loop: "feature", type: "review_verdict", head } as never);
  assert.match(bareApproval, /review approved 01234567$/);

  const approval = formatEvent(
    { ts: 0, loop: "feature", type: "review_verdict", head, reason: "principles upheld" } as never,
  );
  assert.match(approval, /review approved 01234567 — principles upheld/);

  // A bare `VERDICT: reject` reply parses to an empty reasons list; several reasons show only
  // the first (the rest ride along in state.lastReview for the author's next tick).
  const rejected = formatEvent(
    { ts: 0, loop: "feature", type: "review_rejected", head, reasons: ["adds a runtime dep", "second reason"] } as never,
  );
  assert.match(rejected, /review rejected 01234567 — adds a runtime dep/);
  assert.ok(!rejected.includes("second reason"), `only the first reason shows: ${rejected}`);

  const bareReject = formatEvent(
    { ts: 0, loop: "feature", type: "review_rejected", head, reasons: [] } as never,
  );
  assert.match(bareReject, /review rejected 01234567 — no reasons given/);

  // A torn or hand-edited event line could carry a non-array reasons field; the fallback must
  // still render instead of crashing every display surface.
  const malformed = formatEvent(
    { ts: 0, loop: "feature", type: "review_rejected", head, reasons: "oops" } as never,
  );
  assert.match(malformed, /no reasons given/);

  const failed = formatEvent(
    {
      ts: 0,
      loop: "feature",
      type: "review_failed",
      head,
      message: "no parseable VERDICT line in the reviewer's reply",
    } as never,
  );
  assert.match(failed, /review failed for 01234567: no parseable VERDICT line/);
  assert.match(failed, /\(commit kept for re-review\)/);
});

// The questions-outbox feature emits question_posted alongside merged (emission is pinned in
// test/merge.test.ts and test/loop.test.ts); this pins what operators actually read in logs,
// the TUI activity pane, and the GUI feed: the new Open heading verbatim on a plain line —
// routine operation, not a warning.
test("formatEvent renders question_posted with the posted heading and no warning prefix", () => {
  const line = formatEvent({
    ts: 0,
    loop: "feature",
    type: "question_posted",
    question: "Should we support multiple repos per fleet?",
  } as never);
  assert.match(
    line,
    /feature\s+question posted: Should we support multiple repos per fleet\?/,
    `the posted heading must show verbatim: ${line}`,
  );
  assert.ok(!line.includes("warning"), `a posted question is routine, not a warning: ${line}`);
});

// The director inbox's prompt_cancelled event (director inbox management plan): a plain line
// like its prompt_enqueued sibling — routine operation, not a warning.
test("formatEvent renders prompt_cancelled plainly with the preview", () => {
  const line = formatEvent({
    ts: 0,
    loop: "director",
    type: "prompt_cancelled",
    preview: "add dark mode",
  } as never);
  assert.match(line, /director\s+user prompt cancelled: add dark mode/, `the preview must show: ${line}`);
  assert.ok(!line.includes("warning"), `a cancelled prompt is routine, not a warning: ${line}`);

  // A torn or hand-edited event line could carry no preview; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "director", type: "prompt_cancelled" } as never);
  assert.match(bare, /user prompt cancelled:/);
});

test("formatEvent renders the resume event", () => {
  const line = formatEvent({ ts: 0, loop: "feature", type: "resume" } as never);
  assert.match(line, /feature\s+resuming the tick a shutdown interrupted \(same pi session and worktree\)/);
});

// The daily cost budget's transition events (plans/daily-cost-budget.md): routine state
// changes like counters_reset — plain lines carrying the spend and cap that triggered them,
// no warning prefix.
test("formatEvent renders the budget transition events plainly with spend and cap", () => {
  const paused = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_paused",
    spentUsd: 50.123,
    capUsd: 50,
  } as never);
  assert.match(paused, /harness\s+budget paused — \$50\.12 of \$50\.00 daily cost reached/);
  assert.ok(!paused.includes("warning"), "a routine state change is not a warning");

  const resumed = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_resumed",
    spentUsd: 12.345,
    capUsd: 50,
  } as never);
  assert.match(resumed, /harness\s+budget resumed \(\$12\.35 of \$50\.00 today\)/);

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "budget_paused" } as never);
  assert.match(bare, /budget paused — \$0\.00 of \$0\.00 daily cost reached/);
});
