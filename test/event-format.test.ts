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

// The live concurrency-cap change event (PLANS.md, Live maxConcurrent): a routine state
// change like counters_reset — a plain line carrying from → to in that order, no warning prefix.
test("formatEvent renders the maxConcurrent change event plainly with from and to", () => {
  const line = formatEvent({
    ts: 0,
    loop: "harness",
    type: "max_concurrent_changed",
    from: 1,
    to: 4,
  } as never);
  assert.match(line, /harness\s+maxConcurrent changed: 1 → 4/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "max_concurrent_changed" } as never);
  assert.match(bare, /maxConcurrent changed:/);
});

// The live session-retention change event (PLANS.md, Live sessionRetentionDays): a routine
// state change like max_concurrent_changed — a plain line carrying from → to, no warning prefix.
test("formatEvent renders the retention change event plainly with from and to", () => {
  const line = formatEvent({
    ts: 0,
    loop: "harness",
    type: "retention_changed",
    from: 30,
    to: 1,
  } as never);
  assert.match(line, /harness\s+sessionRetentionDays changed: 30 → 1/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "retention_changed" } as never);
  assert.match(bare, /sessionRetentionDays changed:/);
});

// Per-tick usage in the event feed (PLANS.md): tick_end carries this tick's tokens and cost so
// operators see where spend went — after result/summary/error, "·"-separated like the budget
// badge. Zero or absent fields render byte-identical to a pre-feature line (no trailing sep).
test("formatEvent renders per-tick usage on tick_end after result, summary, and error", () => {
  // Both parts, in order: tokens first (compactTokens), then two-decimal cost.
  const both = formatEvent({
    ts: 0,
    loop: "feature",
    type: "tick_end",
    tick: 7,
    result: "changed",
    summary: "add per-tick usage",
    tokens: 18400,
    costUsd: 0.37,
  } as never);
  assert.match(
    both,
    /tick #7 changed — add per-tick usage · 18\.4k tok · \$0\.37$/,
    `both parts must render in order after the summary: ${both}`,
  );

  // Tokens-only (the local-model case where pi reports no cost): just the token part.
  const tokensOnly = formatEvent({
    ts: 0,
    loop: "feature",
    type: "tick_end",
    tick: 8,
    result: "no_change",
    tokens: 1234,
  } as never);
  assert.match(tokensOnly, /tick #8 no_change · 1234 tok$/, `tokens-only must render just the token part: ${tokensOnly}`);

  // Cost rides after an error payload too (error ticks are exactly where spend matters).
  const withError = formatEvent({
    ts: 0,
    loop: "bugfix",
    type: "tick_end",
    tick: 9,
    result: "error",
    error: "boom",
    tokens: 500,
    costUsd: 1.5,
  } as never);
  assert.match(withError, /tick #9 error — boom · 500 tok · \$1\.50$/, `cost is two decimals after the error: ${withError}`);

  // Zero or absent fields render byte-identical to today's line — no trailing separator.
  const zero = formatEvent({
    ts: 0,
    loop: "clean",
    type: "tick_end",
    tick: 5,
    result: "no_change",
    tokens: 0,
    costUsd: 0,
  } as never);
  const absent = formatEvent({ ts: 0, loop: "clean", type: "tick_end", tick: 5, result: "no_change" } as never);
  assert.equal(zero, absent, `zero fields must render exactly like absent ones: ${JSON.stringify([zero, absent])}`);
  assert.match(absent, /tick #5 no_change$/);
});

// The user-abort feature's events (PLANS.md, abort plan item (f)): when the orchestrator
// consumes a role's abort marker it logs tick_aborted under that loop, and the killed tick
// ends with result "user_aborted". These are the lines an operator reads in logs/TUI/GUI to
// see that their `tumwater abort` landed — routine state changes, not warnings.
test("formatEvent renders tick_aborted plainly under the role's loop", () => {
  const line = formatEvent({ ts: 0, loop: "feature", type: "tick_aborted" } as never);
  assert.match(
    line,
    /feature\s+tick aborted by user/,
    `the abort must name the role and say who did it: ${line}`,
  );
  assert.ok(!line.includes("warning"), `a user-initiated abort is routine, not a warning: ${line}`);
});

test("formatEvent renders a user_aborted tick_end with its result verbatim", () => {
  // "user_aborted" (deliberate stop) must stay distinct from "aborted" (harness shutdown):
  // the result word is what tells them apart in the feed. The aborted outcome carries no
  // summary or error, so the line ends at the result — a regression appending an empty
  // payload would print "— undefined".
  const line = formatEvent({ ts: 0, loop: "feature", type: "tick_end", tick: 12, result: "user_aborted" } as never);
  assert.match(line, /tick #12 user_aborted$/, `the result must render verbatim with no suffix: ${line}`);
  assert.ok(!line.includes("warning"), `a deliberate stop is not a warning: ${line}`);

  // The kill can land after pi already streamed turns on the tick; runRolePi folds that
  // partial spend, so usage still rides on the end line like every other result.
  const withUsage = formatEvent({
    ts: 0,
    loop: "feature",
    type: "tick_end",
    tick: 12,
    result: "user_aborted",
    tokens: 900,
    costUsd: 0.25,
  } as never);
  assert.match(
    withUsage,
    /tick #12 user_aborted · 900 tok · \$0\.25$/,
    `partial spend must still show on the aborted end line: ${withUsage}`,
  );
});

test("formatEvent renders the self-redeploy events and the build stamp on orchestrator_start", () => {
  // Build provenance (src/build-info.ts, src/redeploy.ts): a stale build is the one fact about
  // the fleet nothing inside it can otherwise see, so its events must name both commits.
  const start = formatEvent({ ts: 0, loop: "harness", type: "orchestrator_start", pid: 7, build: "abcdef1234567890" } as never);
  assert.match(start, /orchestrator started \(pid 7, build abcdef12\)/);
  const bare = formatEvent({ ts: 0, loop: "harness", type: "orchestrator_start", pid: 7 } as never);
  assert.match(bare, /orchestrator started \(pid 7\)$/, "no stamp: the pre-stamp line, byte for byte");

  const stale = formatEvent({
    ts: 0, loop: "harness", type: "build_stale", build: "a".repeat(40), head: "b".repeat(40), aheadCommits: 12,
  } as never);
  assert.match(stale, /build aaaaaaaa is stale — main bbbbbbbb is 12 commit\(s\) ahead in src\//);
  assert.doesNotMatch(stale, /warning/, "staleness is a state, not a warning");

  const pending = formatEvent({ ts: 0, loop: "harness", type: "restart_pending", head: "b".repeat(40) } as never);
  assert.match(pending, /restart pending — main bbbbbbbb is green; compiling and draining/);

  const restart = formatEvent({
    ts: 0, loop: "harness", type: "restart", from: "a".repeat(40), to: "b".repeat(40), drainedMs: 5 * 60_000, abortedTicks: 2,
  } as never);
  assert.match(restart, /restarting onto build bbbbbbbb \(drained 5m, 2 tick\(s\) will resume on the new build\)/);
  const clean = formatEvent({
    ts: 0, loop: "harness", type: "restart", from: "a".repeat(40), to: "b".repeat(40), drainedMs: 0, abortedTicks: 0,
  } as never);
  assert.match(clean, /\(drained 0m\)$/, "nothing aborted: no resume clause");
});

test("formatEvent tells a cut-off resume from a restart resume", () => {
  const cut = formatEvent({ ts: 0, loop: "improve", type: "resume", cause: "cut-off" } as never);
  assert.match(cut, /resuming the run cut off at the context ceiling/);
  const restart = formatEvent({ ts: 0, loop: "improve", type: "resume", cause: "restart" } as never);
  assert.match(restart, /resuming the tick a shutdown interrupted/);
  // Events written by builds that predate the cause field render the restart wording.
  assert.equal(formatEvent({ ts: 0, loop: "improve", type: "resume" } as never), restart);
});
