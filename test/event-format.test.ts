import test from "node:test";
import assert from "node:assert/strict";
import { eventMessage, eventResult, formatEvent, outcomeText, usageText } from "../src/events/event-format.js";
import { EVENT_TYPE_LABELS } from "../src/events/event-labels.js";
import type { HarnessEvent } from "../src/events/events.js";
import { formatTimestamp } from "../src/text/datetime.js";
import { truncate } from "../src/text/text.js";
import { displayWidth } from "../src/text/text-width.js";

test("formatEvent renders provider_concurrency_changed like its maxConcurrent sibling", () => {
  const line = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "provider_concurrency_changed",
    provider: "omlx",
    from: 1,
    to: 2,
  } as never);
  assert.match(line, /concurrency for omlx changed: 1 → 2/);
});

test("formatEvent renders image_blind naming the file, the model, and the action", () => {
  const fail = formatEvent({
    ts: 0,
    source: "improve",
    type: "image_blind",
    run: 7,
    path: "/x/shot.png",
    model: "huggingface/deepseek",
    action: "fail",
  } as never);
  assert.match(fail, /blind image read: \/x\/shot\.png on huggingface\/deepseek — run failed/);

  const logged = formatEvent({
    ts: 0,
    source: "improve",
    type: "image_blind",
    path: "/x/shot.png",
    model: "huggingface/deepseek",
    action: "logged",
  } as never);
  assert.match(logged, /blind image read: \/x\/shot\.png on huggingface\/deepseek \(gate run logged\)/);
});

test("formatEvent renders image_reroute naming the hop and the preflight distinction", () => {
  const followup = formatEvent({
    ts: 0,
    source: "feature",
    type: "image_reroute",
    run: 7,
    from: "local/text",
    to: "local/vision",
    tier: "strong",
    preflight: false,
  } as never);
  assert.match(followup, /image rerouted to local\/vision \(strong\)/);
  assert.match(followup, /after a blind read on local\/text/);

  const preflight = formatEvent({
    ts: 0,
    source: "feature",
    type: "image_reroute",
    run: 8,
    to: "local/vision",
    tier: "strong",
    preflight: true,
  } as never);
  assert.match(preflight, /image attachment routed to local\/vision \(strong\)/);
  assert.match(preflight, /no failed run/);
});

test("formatEvent renders the image-reroute resume cause as a fresh-session handoff", () => {
  const line = formatEvent({
    ts: 0,
    source: "feature",
    type: "resume",
    cause: "image-reroute",
  } as never);
  assert.match(line, /handing the blind-read run off to a fresh session on an image-capable model/);
  assert.match(line, /uncommitted edits kept/);
});

test("formatEvent renders each type as one line", () => {
  const cases = [
    { ts: 0, source: "clean", type: "run_start", run: 3 },
    { ts: 0, source: "clean", type: "run_end", run: 3, result: "changed", summary: "tidy up" },
    { ts: 0, source: "clean", type: "run_end", run: 4, result: "error", error: "boom" },
    { ts: 0, source: "clean", type: "merged", commit: "abcdef1234567890", summary: "tidy up" },
    { ts: 0, source: "tumwater", type: "orchestrator_start", pid: 1 },
    { ts: 0, source: "director", type: "prompt_enqueued", preview: "do x" },
  ] as const;
  for (const e of cases) {
    const line = formatEvent(e as never);
    assert.ok(line.includes(e.source === "tumwater" ? "tumwater" : e.source), `line should name the source: ${line}`);
    assert.ok(!line.includes("\n"));
  }
  assert.match(formatEvent(cases[1] as never), /tidy up/);
  assert.match(formatEvent(cases[2] as never), /boom/);
  assert.match(formatEvent(cases[3] as never), /abcdef12/);
});

test("formatEvent prints an instance id as its role label and the harness source as tumwater", () => {
  const run = formatEvent({ ts: 0, source: "feature-2", type: "run_end", run: 12, result: "no_change" } as never);
  assert.match(run, /^\S+ \S+ feature #2 run #12 no change$/);
  const start = formatEvent({ ts: 0, source: "tumwater", type: "orchestrator_start", pid: 1 } as never);
  assert.match(start, /^\S+ \S+ tumwater   tumwater started \(pid 1\)$/);
});

test("formatEvent renders a corrupt event ts as the em dash, never NaN", () => {
  // The event log is read without a ts filter (readEvents/scanEventTail push any parsed
  // object), so a corrupt `ts` reaches this renderer through the real paths. new Date(NaN)
  // as the leading column printed "NaN-NaN-NaN NaN:NaN:NaN" on every such line.
  for (const ts of [NaN, Infinity, "oops"]) {
    const line = formatEvent({ ts, source: "clean", type: "wake", reason: "main moved" } as never);
    assert.ok(!line.includes("NaN"), `corrupt ts must not print NaN: ${line}`);
    assert.ok(line.startsWith("— "), `corrupt ts must render the time as the dash: ${line}`);
  }
});

test("formatEvent renders a corrupt event's role as ? like the reports", () => {
  // The event log is read without a filter, so a torn or hand-edited event with no role (or
  // an empty one) reaches this renderer. String(undefined) printed the literal "undefined" in
  // the role column; eventRole's "?" is the rule the usage report and failure digest apply.
  for (const source of [undefined, ""]) {
    const line = formatEvent({ ts: 0, source, type: "wake", reason: "main moved" } as never);
    assert.ok(line.includes("?"), `corrupt loop must render ?: ${line}`);
    assert.ok(!line.includes("undefined"), `corrupt loop must not render undefined: ${line}`);
  }
});

test("formatEvent renders a corrupt event's run as #0, never undefined or NaN", () => {
  // The log is read without a shape filter, so a torn or hand-edited run_start/run_end can
  // carry no run ("#undefined") or a non-numeric one ("#NaN"). eventRun's 0 is the one
  // rule; runs are 1-based, so 0 is visibly not a real run.
  for (const run of [undefined, NaN, Infinity, "oops"] as const) {
    for (const type of ["run_start", "run_end"] as const) {
      const line = formatEvent({ ts: 0, source: "clean", type, run, result: "changed" } as never);
      assert.ok(line.includes("#0"), `corrupt run must render #0: ${line}`);
      assert.ok(!/undefined|NaN/.test(line), `corrupt run must not print undefined or NaN: ${line}`);
    }
  }
});

test("formatEvent keeps the role column aligned when a role name holds a wide character", () => {
  // The role column is padded so every line's message starts at the same display column.
  // A custom role name carrying a wide character (CJK, emoji) is one UTF-16 code unit but
  // two terminal columns per char, so a String#padEnd cell rendered wider than its column
  // and that row's message sat right of every ASCII row's (BUGS.md, event feed sibling of
  // the aligned-tables fix).
  const ts = 0;
  const ascii = formatEvent({ ts, source: "bugfix", type: "wake", reason: "main moved" } as never);
  const wide = formatEvent({ ts, source: "翻译", type: "wake", reason: "main moved" } as never);
  // Both lines share the identical time prefix, so the role column starts right after it.
  const time = formatTimestamp(ts);
  const messageColumn = (line: string) =>
    displayWidth(line.slice(time.length + 1).split("woke")[0]!);
  assert.equal(messageColumn(ascii), 11, `expected the 10-wide role column plus a space: ${ascii}`);
  assert.equal(messageColumn(wide), messageColumn(ascii), `wide-character row misaligned: ${wide}`);
});

test("formatEvent renders wake reasons and warning messages operators rely on", () => {
  // These are the diagnostic lines read in logs/TUI/GUI when figuring out why a role woke or
  // what went wrong: the reason and message payloads must survive formatting.
  const wake = formatEvent({ ts: 0, source: "clean", type: "wake", reason: "main moved" } as never);
  assert.match(wake, /woke \(main moved\)/, `wake line must carry its reason: ${wake}`);

  const warn = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "warning",
    message: "tumwater.json invalid — keeping current config",
  } as never);
  assert.match(warn, /warning: tumwater\.json invalid/, `warning line must carry its message: ${warn}`);

  const stop = formatEvent({ ts: 0, source: "tumwater", type: "orchestrator_stop" } as never);
  assert.match(stop, /tumwater stopped/);
  assert.match(
    formatEvent({ ts: 0, source: "tumwater", type: "orchestrator_stop", cause: "restart" } as never),
    / tumwater stopped to restart onto the new build$/,
  );
});

test("formatEvent carries the reason on non-changed run outcomes", () => {
  // The event feed is where operators see why a run did not merge its work. refused and
  // rejected runs log their reason in `summary`, merge failures log lastError in `error` —
  // showing only "changed"/"error" left those outcomes as bare result words.
  const refused = formatEvent({
    ts: 0,
    source: "feature",
    type: "run_end",
    run: 7,
    result: "refused",
    summary: "plan harms the architecture",
  } as never);
  assert.match(refused, /run #7 refused — plan harms the architecture/, `refusal reason must show: ${refused}`);

  const rejected = formatEvent({
    ts: 0,
    source: "feature",
    type: "run_end",
    run: 8,
    result: "rejected",
    summary: "adds a runtime dep",
  } as never);
  assert.match(rejected, /run #8 rejected in review — adds a runtime dep/, `rejection detail must show: ${rejected}`);

  const mergeFailed = formatEvent({
    ts: 0,
    source: "bugfix",
    type: "run_end",
    run: 9,
    result: "merge_conflict",
    error: "merge failed: merge_conflict",
  } as never);
  assert.match(mergeFailed, /run #9 merge conflict — merge failed: merge_conflict/, `merge failure must show its error: ${mergeFailed}`);

  // review_error runs carry both (summary = gate detail, error = "review failed: …"); the
  // summary is the more specific of the two and wins.
  const reviewError = formatEvent({
    ts: 0,
    source: "feature",
    type: "run_end",
    run: 10,
    result: "review_error",
    summary: "no parseable VERDICT line in the reviewer's reply",
    error: "review failed: no parseable VERDICT line in the reviewer's reply",
  } as never);
  assert.match(reviewError, /run #10 review failed — no parseable VERDICT line/);
});

test("formatEvent renders a no-change run with no summary or error suffix", () => {
  // The third arm of the run_end ternary is the empty string: a regression that gave every
  // result a suffix would print "— undefined" on every idle run in every display surface.
  const line = formatEvent({ ts: 0, source: "clean", type: "run_end", run: 5, result: "no_change" } as never);
  assert.match(line, /run #5 no change$/, `no-change run must end at the result: ${line}`);
});

test("formatEvent degrades gracefully for unknown event types", () => {
  // The default branch is a safety net: HarnessEvent's union has no exhaustiveness check, so a
  // type added in events.ts without a case here would otherwise render empty or crash on every
  // display surface. Pin the graceful fallback.
  const line = formatEvent({ ts: 0, source: "clean", type: "brand_new_type" } as never);
  assert.match(line, /clean\s+brand_new_type/, `unknown types must still render their name: ${line}`);
});

test("formatEvent renders run_start's model after the run number, and omits it when absent", () => {
  const withModel = formatEvent({ ts: 0, source: "feature", type: "run_start", run: 3, model: "prov/m1" } as never);
  assert.match(withModel, /feature\s+run #3 started on prov\/m1$/);
  const bare = formatEvent({ ts: 0, source: "feature", type: "run_start", run: 3 } as never);
  assert.match(bare, /feature\s+run #3 started$/);
});

test("formatEvent renders counters_reset plainly, naming all roles when several are affected", () => {
  const single = formatEvent({ ts: 0, source: "clean", type: "counters_reset" } as never);
  assert.match(single, /clean\s+counters reset \(runs, merges, tokens, cost\)/);
  const multi = formatEvent(
    { ts: 0, source: "tumwater", type: "counters_reset", roles: ["feature", "bugfix"] } as never,
  );
  assert.match(multi, /tumwater\s+counters reset for feature, bugfix \(runs, merges, tokens, cost\)/);
});

// The review-gate lines are what operators read in logs/TUI/GUI when a merge stalls on the
// gate: head is truncated to 8 chars, only the first rejection reason shows, and the optional
// payloads (approval reason, reasons list) must degrade instead of printing "undefined".
test("formatEvent renders the review-gate events with truncated heads and safe fallbacks", () => {
  const head = "0123456789abcdef"; // full hash as logged by review.ts

  const start = formatEvent({ ts: 0, source: "feature", type: "review_start", head } as never);
  assert.match(start, /feature\s+reviewing 01234567 before merge$/);
  assert.ok(!start.includes("89abcdef"), `full hash must not leak into the line: ${start}`);

  // Model-tiers part 2/8 (PLANS.md): when the run's model is configured it renders after the
  // existing text; an old event without the field must still read unchanged.
  const startWithModel = formatEvent(
    { ts: 0, source: "feature", type: "review_start", head, model: "prov/r1:high" } as never,
  );
  assert.match(startWithModel, /reviewing 01234567 before merge on prov\/r1:high$/);

  // A revision merge labels its round (plans/revise-rejected.md part 2/2); a fresh one has
  // no revision field and renders exactly as before.
  const startRevision = formatEvent(
    { ts: 0, source: "feature", type: "review_start", head, revision: 2 } as never,
  );
  assert.match(startRevision, /reviewing 01234567 \(revision 2\) before merge$/);

  // A resumed review continues a timed-out reviewer's
  // session; the flag switches the verb so the feed reads it as a resume, not a fresh run.
  // The revision and model suffixes append exactly as they do on a from-scratch review.
  const startResumed = formatEvent(
    { ts: 0, source: "feature", type: "review_start", head, resumed: true } as never,
  );
  assert.match(startResumed, /review resumed 01234567 before merge$/);
  const startResumedRevision = formatEvent(
    { ts: 0, source: "feature", type: "review_start", head, resumed: true, revision: 3 } as never,
  );
  assert.match(startResumedRevision, /review resumed 01234567 \(revision 3\) before merge$/);
  // An explicit false — or an absent flag — still reads as a fresh review.
  const startNotResumed = formatEvent(
    { ts: 0, source: "feature", type: "review_start", head, resumed: false } as never,
  );
  assert.match(startNotResumed, /reviewing 01234567 before merge$/);

  // Approvals carry reason = verdict.reasons[0], which is undefined when the reviewer gave
  // none: the suffix must vanish, not print "— undefined".
  const bareApproval = formatEvent({ ts: 0, source: "feature", type: "review_verdict", head } as never);
  assert.match(bareApproval, /review approved 01234567$/);

  const approval = formatEvent(
    { ts: 0, source: "feature", type: "review_verdict", head, reason: "principles upheld" } as never,
  );
  assert.match(approval, /review approved 01234567 — principles upheld/);

  // A bare `VERDICT: reject` reply parses to an empty reasons list; several reasons show only
  // the first plus a count of the rest (the full list rides along in state.lastReview for the
  // author's next run) — the second reason's text itself must not leak into the one-liner.
  const rejected = formatEvent(
    { ts: 0, source: "feature", type: "review_rejected", head, reasons: ["adds a runtime dep", "second reason"] } as never,
  );
  assert.match(rejected, /review rejected 01234567 — adds a runtime dep/);
  assert.match(rejected, /\+1 more — the author's next run carries every reason/);
  assert.ok(!rejected.includes("second reason"), `only the first reason shows: ${rejected}`);

  const singleReject = formatEvent(
    { ts: 0, source: "feature", type: "review_rejected", head, reasons: ["adds a runtime dep"] } as never,
  );
  assert.ok(!singleReject.includes("more"), `one reason renders without a more-count: ${singleReject}`);

  const bareReject = formatEvent(
    { ts: 0, source: "feature", type: "review_rejected", head, reasons: [] } as never,
  );
  assert.match(bareReject, /review rejected 01234567 — no reasons given/);

  // A torn or hand-edited event line could carry a non-array reasons field; the fallback must
  // still render instead of crashing every display surface.
  const malformed = formatEvent(
    { ts: 0, source: "feature", type: "review_rejected", head, reasons: "oops" } as never,
  );
  assert.match(malformed, /no reasons given/);

  const failed = formatEvent(
    {
      ts: 0,
      source: "feature",
      type: "review_failed",
      head,
      message: "no parseable VERDICT line in the reviewer's reply",
    } as never,
  );
  assert.match(failed, /review failed for 01234567: no parseable VERDICT line/);
  assert.match(failed, /\(commit kept for re-review\)/);
});

// The questions-outbox feature emits question_posted alongside merged (emission is pinned in
// test/merge-to-main.test.ts and test/runner.test.ts); this pins what operators actually read in
// logs,
// the TUI activity pane, and the GUI feed: the new Open heading verbatim on a plain line —
// routine operation, not a warning.
test("formatEvent renders question_posted with the posted heading and no warning prefix", () => {
  const line = formatEvent({
    ts: 0,
    source: "feature",
    type: "question_posted",
    question: "Should we support multiple repos per team?",
  } as never);
  assert.match(
    line,
    /feature\s+question posted: Should we support multiple repos per team\?/,
    `the posted heading must show verbatim: ${line}`,
  );
  assert.ok(!line.includes("warning"), `a posted question is routine, not a warning: ${line}`);
});

test("formatEvent names the question's number and answer command when position is valid", () => {
  const base = { ts: 0, source: "feature", type: "question_posted", question: "Which storage?" };
  const line = formatEvent({ ...base, position: 3, open: 3 } as never);
  assert.ok(
    line.includes('question posted: Which storage? — question 3 in `tumwater questions`; answer it with `tumwater questions answer 3 "<decision>"`'),
    line,
  );
  assert.ok(!line.includes("warning"), line);
  const plain = formatEvent(base as never);
  for (const position of [0, "3", 1.5]) {
    assert.equal(formatEvent({ ...base, position } as never), plain);
  }
});

test("formatEvent renders entry_refused with the reason and files and no warning prefix", () => {
  const line = formatEvent({ ts: 0, source: "feature", type: "entry_refused", reason: "too risky", files: ["PLANS.md"] } as never);
  assert.match(line, /entry refused: too risky \(PLANS\.md\)/);
  assert.ok(!line.includes("warning"), line);
});

test("formatEvent names the refused entry, with a count when several are held", () => {
  const two = formatEvent({ ts: 0, source: "feature", type: "entry_refused", reason: "too risky", files: ["PLANS.md"], entries: ["Add X", "Add Y"] } as never);
  assert.match(two, /entry refused: "Add X" \(and 1 more\): too risky \(PLANS\.md\)/);
  const one = formatEvent({ ts: 0, source: "feature", type: "entry_refused", reason: "too risky", files: ["PLANS.md"], entries: ["Add X"] } as never);
  assert.match(one, /entry refused: "Add X": too risky/);
  assert.ok(!one.includes("more"), one);
});

// The director inbox's prompt_cancelled event (director inbox management plan): a plain line
// like its prompt_enqueued sibling — routine operation, not a warning.
test("formatEvent renders prompt_cancelled plainly with the preview", () => {
  const line = formatEvent({
    ts: 0,
    source: "director",
    type: "prompt_cancelled",
    preview: "add dark mode",
  } as never);
  assert.match(line, /director\s+message removed from the inbox: add dark mode/, `the preview must show: ${line}`);
  assert.ok(!line.includes("warning"), `a cancelled prompt is routine, not a warning: ${line}`);

  // A torn or hand-edited event line could carry no preview; the fallback must render "?",
  // never String(undefined)'s literal "undefined".
  const bare = formatEvent({ ts: 0, source: "director", type: "prompt_cancelled" } as never);
  assert.match(bare, /message removed from the inbox: \?$/);
  assert.ok(!bare.includes("undefined"), `corrupt preview must not render undefined: ${bare}`);
});

test("formatEvent renders the resume event", () => {
  const line = formatEvent({ ts: 0, source: "feature", type: "resume" } as never);
  assert.match(line, /feature\s+resuming the run a shutdown interrupted \(same agent session and workspace\)/);
});

// Per-run usage in the event feed (PLANS.md): run_end carries this run's tokens and cost so
// operators see where spend went — after result/summary/error, "·"-separated like the budget
// badge. Zero or absent fields render byte-identical to a pre-feature line (no trailing sep).
test("formatEvent renders per-run usage on run_end after result, summary, and error", () => {
  // Both parts, in order: tokens first (compactTokens), then two-decimal cost.
  const both = formatEvent({
    ts: 0,
    source: "feature",
    type: "run_end",
    run: 7,
    result: "changed",
    summary: "add per-run usage",
    tokens: 18400,
    costUsd: 0.37,
  } as never);
  assert.match(
    both,
    /run #7 merged — add per-run usage · 18\.4k tok · \$0\.37$/,
    `both parts must render in order after the summary: ${both}`,
  );

  // Tokens-only (the local-model case where pi reports no cost): just the token part.
  const tokensOnly = formatEvent({
    ts: 0,
    source: "feature",
    type: "run_end",
    run: 8,
    result: "no_change",
    tokens: 1234,
  } as never);
  assert.match(tokensOnly, /run #8 no change · 1234 tok$/, `tokens-only must render just the token part: ${tokensOnly}`);

  // Cost rides after an error payload too (error runs are exactly where spend matters).
  const withError = formatEvent({
    ts: 0,
    source: "bugfix",
    type: "run_end",
    run: 9,
    result: "error",
    error: "boom",
    tokens: 500,
    costUsd: 1.5,
  } as never);
  assert.match(withError, /run #9 error — boom · 500 tok · \$1\.50$/, `cost is two decimals after the error: ${withError}`);

  // Zero or absent fields render byte-identical to today's line — no trailing separator.
  const zero = formatEvent({
    ts: 0,
    source: "clean",
    type: "run_end",
    run: 5,
    result: "no_change",
    tokens: 0,
    costUsd: 0,
  } as never);
  const absent = formatEvent({ ts: 0, source: "clean", type: "run_end", run: 5, result: "no_change" } as never);
  assert.equal(zero, absent, `zero fields must render exactly like absent ones: ${JSON.stringify([zero, absent])}`);
  assert.match(absent, /run #5 no change$/);
});

// The user-abort feature's events (PLANS.md, abort plan item (f)): when the orchestrator
// consumes a role's abort marker it logs run_aborted under that role, and the killed run
// ends with result "user_aborted". These are the lines an operator reads in logs/TUI/GUI to
// see that their `tumwater abort` landed — routine state changes, not warnings.
test("formatEvent renders run_aborted plainly under its role", () => {
  const line = formatEvent({ ts: 0, source: "feature", type: "run_aborted" } as never);
  assert.match(
    line,
    /feature\s+run stopped by you/,
    `the abort must name the role and say who did it: ${line}`,
  );
  assert.ok(!line.includes("warning"), `a user-initiated abort is routine, not a warning: ${line}`);
});

// Need-based scheduling (src/scheduling/scheduling.ts): a maintenance run held back because its
// last
// run did nothing and no work has merged since. Routine state, not a warning — but the line
// must name the role and its cause, since it is the only signal that a role is being deferred.
test("formatEvent renders run_deferred with the clause that deferred it", () => {
  const backlog = formatEvent({ ts: 0, source: "clean", type: "run_deferred", reason: "backlog" } as never);
  assert.match(
    backlog,
    /clean\s+deferred — feature\/bugfix backlog open$/,
    `a backlog deferral must say so: ${backlog}`,
  );
  const noWork = formatEvent({ ts: 0, source: "clean", type: "run_deferred", reason: "no-work" } as never);
  assert.match(
    noWork,
    /clean\s+deferred — nothing merged since the last run$/,
    `a no-work deferral must say so: ${noWork}`,
  );
  const full = formatEvent({ ts: 0, source: "plan", type: "run_deferred", reason: "plans-full" } as never);
  assert.match(full, /plan\s+deferred — plan backlog at its target$/);
  // A torn line or a pre-field event has no clause recorded: fall back to the old spelling.
  const legacy = formatEvent({ ts: 0, source: "clean", type: "run_deferred" } as never);
  assert.match(
    legacy,
    /clean\s+deferred — nothing merged since the last run$/,
    `a reason-less deferral falls back to no-work: ${legacy}`,
  );
  for (const line of [backlog, noWork, legacy])
    assert.ok(!line.includes("warning"), `a deferral is routine, not a warning: ${line}`);
});

test("formatEvent renders a user_aborted run_end with its result verbatim", () => {
  // "user_aborted" (deliberate stop) must stay distinct from "aborted" (harness shutdown):
  // the result word is what tells them apart in the feed. The aborted outcome carries no
  // summary or error, so the line ends at the result — a regression appending an empty
  // payload would print "— undefined".
  const line = formatEvent({ ts: 0, source: "feature", type: "run_end", run: 12, result: "user_aborted" } as never);
  assert.match(line, /run #12 stopped by you$/, `the result must render verbatim with no suffix: ${line}`);
  assert.ok(!line.includes("warning"), `a deliberate stop is not a warning: ${line}`);

  // The kill can land after pi already streamed turns on the run; runRolePi folds that
  // partial spend, so usage still rides on the end line like every other result.
  const withUsage = formatEvent({
    ts: 0,
    source: "feature",
    type: "run_end",
    run: 12,
    result: "user_aborted",
    tokens: 900,
    costUsd: 0.25,
  } as never);
  assert.match(
    withUsage,
    /run #12 stopped by you · 900 tok · \$0\.25$/,
    `partial spend must still show on the aborted end line: ${withUsage}`,
  );
});

test("formatEvent renders the self-redeploy events and the build stamp on orchestrator_start", () => {
  // Build provenance (src/build/build-info.ts, src/redeploy/redeploy.ts): a stale build is the one
  // fact about
  // the team nothing inside it can otherwise see, so its events must name both commits.
  const start = formatEvent({ ts: 0, source: "tumwater", type: "orchestrator_start", pid: 7, build: "abcdef1234567890" } as never);
  assert.match(start, /tumwater started \(pid 7, version abcdef12\)/);
  const bare = formatEvent({ ts: 0, source: "tumwater", type: "orchestrator_start", pid: 7 } as never);
  assert.match(bare, /tumwater started \(pid 7\)$/, "no stamp: the pre-stamp line, byte for byte");

  const stale = formatEvent({
    ts: 0, source: "tumwater", type: "build_stale", build: "a".repeat(40), head: "b".repeat(40), aheadCommits: 12,
  } as never);
  assert.match(stale, /update available \(12 commits behind\) — restarts when idle/);
  assert.doesNotMatch(stale, /warning/, "staleness is a state, not a warning");

  const pending = formatEvent({ ts: 0, source: "tumwater", type: "restart_pending", head: "b".repeat(40) } as never);
  assert.match(pending, /restart pending — main bbbbbbbb is green; finishing current runs/);

  const restart = formatEvent({
    ts: 0, source: "tumwater", type: "restart", from: "a".repeat(40), to: "b".repeat(40), finishedMs: 5 * 60_000, abortedRuns: 2,
  } as never);
  assert.match(restart, /restarting onto update bbbbbbbb \(finished current work in 5m, 2 run\(s\) resume after the restart\)/);
  const clean = formatEvent({
    ts: 0, source: "tumwater", type: "restart", from: "a".repeat(40), to: "b".repeat(40), finishedMs: 0, abortedRuns: 0,
  } as never);
  assert.match(clean, /\(finished current work in 0m\)$/, "nothing aborted: no resume clause");

  // A torn or hand-edited numeric field reads as zero, never NaN: "NaN commits", "after
  // NaNm", and "true tick(s)" would all mislead an operator, and `String`/`Number`
  // coercions otherwise leak them through.
  const staleTorn = formatEvent({
    ts: 0, source: "tumwater", type: "build_stale", build: "a".repeat(40), head: "b".repeat(40), aheadCommits: "12",
  } as never);
  assert.match(staleTorn, /\(0 commits behind\)/, `corrupt aheadCommits must read zero: ${staleTorn}`);
  assert.doesNotMatch(staleTorn, /NaN/);
  const restartTorn = formatEvent({
    ts: 0, source: "tumwater", type: "restart", from: "a".repeat(40), to: "b".repeat(40), finishedMs: "x", abortedRuns: "2",
  } as never);
  assert.match(restartTorn, /\(finished current work in 0m\)$/, `corrupt drain/abort counts must read zero: ${restartTorn}`);
  assert.doesNotMatch(restartTorn, /NaN|true tick/);

  // BUGS.md 2026-09-23: a refused restart names both builds and the reason; a dead team says so.
  const refused = formatEvent({
    ts: 0, source: "tumwater", type: "restart_refused", from: "a".repeat(40), to: "b".repeat(40), reason: "not initialized",
  } as never);
  assert.match(refused, /restart onto update bbbbbbbb refused — the new version could not start here: not initialized; staying on version aaaaaaaa/);
  // A blocked restart is a different verdict (redeploy latched this head, and only main
  // moving ends it): the line must name the blocked head, the reason, and the build that
  // stays — the refused wording would mislead an operator into repairing the wrong thing.
  const blocked = formatEvent({
    ts: 0, source: "tumwater", type: "restart_blocked", from: "a".repeat(40), to: "b".repeat(40), reason: "main is red",
  } as never);
  assert.match(blocked, /restart blocked for main bbbbbbbb — main is red; staying on version aaaaaaaa until main moves/);
  const down = formatEvent({ ts: 0, source: "tumwater", type: "supervisor_exit", generation: 2, code: 1, reason: "not initialized" } as never);
  assert.match(down, /tumwater is down — restart 2 exited 1: not initialized; start it again with `tumwater start`/);
  const killed = formatEvent({ ts: 0, source: "tumwater", type: "supervisor_exit", generation: 1, code: null, signal: "SIGKILL" } as never);
  assert.match(killed, /tumwater is down — restart 1 was killed by SIGKILL; start it again/);
});

test("formatEvent tells a cut-off resume from a restart resume", () => {
  const cut = formatEvent({ ts: 0, source: "improve", type: "resume", cause: "cut-off" } as never);
  assert.match(cut, /resuming the run cut off at the context ceiling/);
  const restart = formatEvent({ ts: 0, source: "improve", type: "resume", cause: "restart" } as never);
  assert.match(restart, /resuming the run a shutdown interrupted/);
  // Events written by builds that predate the cause field render the restart wording.
  assert.equal(formatEvent({ ts: 0, source: "improve", type: "resume" } as never), restart);
  // A cross-agent handoff keeps the worktree but starts a fresh session — its own line.
  const handoff = formatEvent({ ts: 0, source: "improve", type: "resume", cause: "handoff" } as never);
  assert.match(handoff, /handing the interrupted run off to a fresh session on another agent/);
});

test("formatEvent prices the gates: build_check lines and review durations", () => {
  const gate = formatEvent({ ts: 0, source: "feature", type: "build_check", scope: "gate", status: "passed", script: "test", durationMs: 57_000 } as never);
  assert.match(gate, /check \(gate\): test passed \(in 57s\)/);
  const baseline = formatEvent({ ts: 0, source: "clean", type: "build_check", scope: "baseline", status: "failed", script: "test", durationMs: 130_000 } as never);
  assert.match(baseline, /check \(baseline\): test failed \(in 2m\)/);
  // script carries the FULL command for a configured-command check (an npm prefix would
  // misrender it), so the line shows the bare name for both kinds.
  const command = formatEvent({ ts: 0, source: "feature", type: "build_check", scope: "merge", status: "passed", script: "cargo test", durationMs: 90_000 } as never);
  assert.match(command, /check \(merge\): cargo test passed \(in 90s\)/);
  const approved = formatEvent({ ts: 0, source: "feature", type: "review_verdict", head: "a".repeat(40), reason: "ok", durationMs: 5 * 60_000 } as never);
  assert.match(approved, /review approved aaaaaaaa — ok \(in 5m\)$/);
  // Events from builds that predate durationMs render exactly as before.
  const legacy = formatEvent({ ts: 0, source: "feature", type: "review_verdict", head: "a".repeat(40), reason: "ok" } as never);
  assert.match(legacy, /review approved aaaaaaaa — ok$/);
  const rejected = formatEvent({ ts: 0, source: "feature", type: "review_rejected", head: "a".repeat(40), reasons: ["dup"], durationMs: 61_000 } as never);
  assert.match(rejected, /review rejected aaaaaaaa — dup \(in 61s\)$/);
});

// The merge queue's events (merge queue 3/5): the feed shows the queue's state changes — the
// run's enqueue, the slot's completion (with the merge's own spend), and the slot's failure.
test("formatEvent renders merge_queued, landed, and merge_failed", () => {
  // Every line starts with the wall-clock time and the padded role name — assert the payload.
  const queued = formatEvent({ ts: 0, source: "clean", type: "merge_queued", commit: "abcdef1234567890", summary: "tidy up" } as never);
  assert.match(queued, /clean\s+waiting to merge abcdef12 — tidy up$/, `merge_queued must name the sha and summary: ${queued}`);

  // Spent nothing (review-exempt or zero-usage reviewer): renders bare, like run_end.
  const bare = formatEvent({ ts: 0, source: "clean", type: "merge_done", commit: "abcdef1234567890", result: "changed", durationMs: 1234 } as never);
  assert.match(bare, /clean\s+merge of abcdef12 done \(in 1s\)$/, `zero-usage merge renders bare: ${bare}`);
  // The merge's own spend rides after the duration, "·"-separated like run_end (minutes
  // at two minutes and up, compact tokens at 10k and up — the shared text.ts rules).
  const withUsage = formatEvent({
    ts: 0,
    source: "clean",
    type: "merge_done",
    commit: "abcdef1234567890",
    result: "changed",
    durationMs: 130_000,
    tokens: 12_345,
    costUsd: 0.05,
  } as never);
  assert.match(withUsage, /merge of abcdef12 done \(in 2m\) · 12\.3k tok · \$0\.05$/, `usage must ride after the duration: ${withUsage}`);

  // A failed merge names the outcome — the detail lives in the review/merge events themselves.
  const failed = formatEvent({ ts: 0, source: "clean", type: "merge_failed", commit: "abcdef1234567890", result: "merge_conflict", durationMs: 500 } as never);
  assert.match(failed, /merge of abcdef12 failed \(merge conflict\) \(in 1s\)$/, `merge_failed must name the outcome: ${failed}`);
  const named = formatEvent({ ts: 0, source: "clean", type: "merge_failed", commit: "abcdef1234567890", result: "merge_conflict", durationMs: 500, summary: "tidy up" } as never);
  assert.match(named, /merge of abcdef12 failed \(merge conflict\) \(in 1s\) — tidy up$/);
  const long = formatEvent({ ts: 0, source: "clean", type: "merge_failed", commit: "abcdef1234567890", result: "merge_conflict", durationMs: 500, summary: "x".repeat(200) } as never);
  assert.ok(long.endsWith(` — ${truncate("x".repeat(200), 80)}`), `long summary clipped: ${long}`);
  const reasoned = formatEvent({ ts: 0, source: "clean", type: "merge_failed", commit: "abcdef1234567890", result: "rejected", reason: "no test covers the new flag" } as never);
  assert.match(reasoned, /failed \(rejected in review: no test covers the new flag\)/);
  const longReason = formatEvent({ ts: 0, source: "clean", type: "merge_failed", commit: "abcdef1234567890", result: "rejected", reason: "y".repeat(300) } as never);
  assert.ok(longReason.includes(`(rejected in review: ${truncate("y".repeat(300), 120)})`), `long reason cut to 120: ${longReason}`);
  assert.ok(longReason.includes("…"), "the cut ends in an ellipsis");
});

// Every payload on HarnessEvent arrives loosely typed off the NDJSON log, so a torn or
// hand-edited line can omit any field. The feed's fallbacks ("?", pi's default provider,
// "several roles") must render — the operator reading `logs` during an incident sees these
// lines, and a blank or undefined-injected line would be worse than the degraded truth.
test("formatEvent renders the fallback sides of optional payload fields", () => {
  // budget_fallback without provider/model: the switch still happened; name the unknown.
  const fallbackBare = formatEvent({ ts: 0, source: "tumwater", type: "budget_fallback", spentUsd: 10.5, capUsd: 10 } as never);
  assert.match(
    fallbackBare,
    /over-cap model — \$10\.50 of \$10\.00 daily cost reached; roles continue on pi's default provider\/pi's default model \(cost n\/a\)$/,
    `absent backend must read as pi's defaults: ${fallbackBare}`,
  );

  // With the per-tier map (part 7b/8, carried only for two or more distinct pairs), each
  // tier's pair is listed in tier order and the borrowed one carries its `(from …)` suffix.
  const fallbackTiers = formatEvent({
    ts: 0, source: "tumwater", type: "budget_fallback", spentUsd: 10.5, capUsd: 10,
    tiers: { small: "free/qwen-free (from default)", default: "free/qwen-free", strong: "free/llama-free" },
  } as never);
  assert.match(
    fallbackTiers,
    /over-cap model — \$10\.50 of \$10\.00 daily cost reached; roles continue on small: free\/qwen-free \(from default\), default: free\/qwen-free, strong: free\/llama-free \(cost n\/a\)$/,
    `the tier map must list every tier's pair: ${fallbackTiers}`,
  );
  // A torn line's non-map or partial tiers fall back to the single-pair sentence.
  assert.match(
    formatEvent({ ts: 0, source: "tumwater", type: "budget_fallback", spentUsd: 10.5, capUsd: 10, tiers: "garbage" } as never),
    /continue on pi's default provider\/pi's default model/,
    "a torn tiers field must not break the line",
  );
  assert.match(
    formatEvent({ ts: 0, source: "tumwater", type: "budget_fallback", spentUsd: 10.5, capUsd: 10, tiers: { default: "free/qwen-free" } } as never),
    /continue on pi's default provider\/pi's default model/,
    "a one-entry tiers field (never emitted) keeps the single-pair text",
  );

  // A demoted fallback whose failure count was lost still reads — the "?" says a field is
  // missing, not that nothing failed.
  const demotedBare = formatEvent({
    ts: 0, source: "tumwater", type: "budget_paused", spentUsd: 10.5, capUsd: 10, fallbackDemoted: "omlx/qwen",
  } as never);
  assert.match(
    demotedBare,
    /\(over-cap model omlx\/qwen is not serving — \? runs failed in a row on it; one trial run retries it after a cool-down\)/,
    `absent failure count must degrade to "?": ${demotedBare}`,
  );

  // role_paused/role_resumed carry the role loosely; without one the line still names its kind.
  const pausedBare = formatEvent({ ts: 0, source: "tumwater", type: "role_paused" } as never);
  assert.match(pausedBare, /role \? paused — it starts no new runs/, `absent role must read "?": ${pausedBare}`);
  const resumedBare = formatEvent({ ts: 0, source: "tumwater", type: "role_resumed" } as never);
  assert.match(resumedBare, /role \? resumed — it runs again$/, `absent role must read "?": ${resumedBare}`);

  // rate_limit_hold whose roles payload is not an array (a torn line): "several roles" beats
  // crashing the feed or joining a string's characters.
  const holdBare = formatEvent({
    ts: 0, source: "tumwater", type: "rate_limit_hold", roles: "feature", holdMs: 60_000, escalation: 0,
  } as never);
  assert.match(
    holdBare,
    /waiting: provider limit — several roles rate-limited by the provider/, `a non-array roles payload must read "several roles": ${holdBare}`,
  );

  // restart without finishedMs/abortedRuns (the old event shape, or a torn line): zero
  // defaults, and no resume clause.
  const restartBare = formatEvent({ ts: 0, source: "tumwater", type: "restart", from: "a".repeat(40), to: "b".repeat(40) } as never);
  assert.match(restartBare, /\(finished current work in 0m\)$/, `absent drain/abort counts must default to zero: ${restartBare}`);
});

// eventResult — the activity feeds' outcome key: a run's result, else a merge's or build
// check's status, else undefined. Single-homes the extraction the status payload's eventItem
// and the TUI's eventTone both render through, so the two surfaces cannot key differently.
test("eventResult takes a run's result, else a merge's or build check's status, else undefined", () => {
  assert.equal(eventResult({ ts: 0, source: "x", type: "run_end", result: "changed" }), "changed");
  assert.equal(eventResult({ ts: 0, source: "x", type: "merge_done", status: "merged" }), "merged");
  assert.equal(eventResult({ ts: 0, source: "x", type: "build_check", status: "failed" }), "failed");
  // A status is only a fallback: when both ride one event the run's result wins.
  assert.equal(eventResult({ ts: 0, source: "x", type: "run_end", result: "error", status: "failed" }), "error");
  // Non-string values (a number smuggled into the loose payload) are not an outcome.
  assert.equal(eventResult({ ts: 0, source: "x", type: "run_end", result: 7 } as never), undefined);
  assert.equal(eventResult({ ts: 0, source: "x", type: "wake" }), undefined);
});

// outcomeText — eventResult as a display cell: the same extraction with "?" for an absent
// outcome, so a torn run_end renders like eventRole's role and eventRun's run rather than
// String(undefined)'s literal "undefined". eventResult must stay undefined for the tone and
// filter keys, so the corrupt-field guard lives here, not there.
test("outcomeText renders eventResult or ? for a missing or non-string outcome", () => {
  assert.equal(outcomeText({ ts: 0, source: "x", type: "run_end", result: "changed" }), "changed");
  assert.equal(outcomeText({ ts: 0, source: "x", type: "merge_done", status: "merged" }), "merged");
  assert.equal(outcomeText({ ts: 0, source: "x", type: "run_end" }), "?");
  // A non-string value smuggled into the loose payload is not an outcome.
  assert.equal(outcomeText({ ts: 0, source: "x", type: "run_end", result: 7 } as never), "?");
});

test("formatEvent renders a corrupt outcome as ?, never undefined", () => {
  const runEnd = formatEvent({ ts: 0, source: "clean", type: "run_end", run: 5 } as never);
  assert.match(runEnd, /run #5 \?$/);
  const mergeFailed = formatEvent({ ts: 0, source: "clean", type: "merge_failed", commit: "abc1234", result: 7 } as never);
  assert.match(mergeFailed, /failed \(\?\)/);
  const build = formatEvent({ ts: 0, source: "clean", type: "build_check", scope: "merge", script: "test" } as never);
  assert.match(build, /check \(merge\): test \?$/);
});

// Every free-text payload eventMessage interpolates must survive a torn or hand-edited line:
// a missing field renders textOr's "?" (and a missing sha shortSha's) rather than the literal
// "undefined" that String(undefined) would print, and a foreign value (object/array) renders
// the same placeholder rather than String(...)'s "[object Object]". Both reach the feed, the
// TUI, and the GUI through formatEvent/eventMessage.
test("formatEvent never renders undefined or [object Object] for corrupt event fields", () => {
  const corrupt: HarnessEvent[] = [
    { ts: 0, source: "clean", type: "merged", commit: "abcdef1234567890" } as never,
    { ts: 0, source: "clean", type: "merge_queued" } as never,
    { ts: 0, source: "feature", type: "question_posted" } as never,
    { ts: 0, source: "feature", type: "wake" } as never,
    { ts: 0, source: "tumwater", type: "orchestrator_start" } as never,
    { ts: 0, source: "director", type: "prompt_enqueued" } as never,
    { ts: 0, source: "feature", type: "review_start" } as never,
    { ts: 0, source: "feature", type: "review_failed" } as never,
    { ts: 0, source: "feature", type: "revision" } as never,
    { ts: 0, source: "feature", type: "conflict_handback" } as never,
    { ts: 0, source: "tumwater", type: "build_check" } as never,
    { ts: 0, source: "tumwater", type: "max_concurrent_changed" } as never,
    { ts: 0, source: "tumwater", type: "retention_changed" } as never,
    { ts: 0, source: "tumwater", type: "restart_refused" } as never,
    { ts: 0, source: "tumwater", type: "restart_blocked" } as never,
    { ts: 0, source: "tumwater", type: "supervisor_exit" } as never,
    { ts: 0, source: "tumwater", type: "warning" } as never,
  ];
  for (const e of corrupt) {
    const line = formatEvent(e);
    assert.ok(!line.includes("undefined"), `${e.type} must not render undefined: ${line}`);
  }
  // A hand-edited field can also hold a foreign value, which String(...) would render as
  // "[object Object]"; textOr substitutes its placeholder instead.
  const foreign: HarnessEvent[] = [
    { ts: 0, source: "feature", type: "run_end", run: 5, result: "changed", summary: { a: 1 } } as never,
    { ts: 0, source: "feature", type: "run_end", run: 5, result: "error", error: ["boom"] } as never,
    { ts: 0, source: "feature", type: "review_verdict", head: "abcdef12", reason: { a: 1 } } as never,
    { ts: 0, source: "tumwater", type: "dep_install", status: "failed", error: { a: 1 } } as never,
    { ts: 0, source: "tumwater", type: "budget_paused", fallbackRejected: { a: 1 } } as never,
    { ts: 0, source: "tumwater", type: "budget_paused", fallbackDemoted: "free/model", failures: { a: 1 } } as never,
    { ts: 0, source: "tumwater", type: "role_streak_paused", role: { a: 1 }, streak: { a: 1 } } as never,
    { ts: 0, source: "tumwater", type: "model_fallback_started", provider: { a: 1 }, model: { a: 1 }, reason: { a: 1 } } as never,
    // Array-valued fields can be corrupt too: stringList drops foreign entries, so a
    // hand-edited packages/keys/reasons array never joins to "[object Object]".
    { ts: 0, source: "tumwater", type: "dep_install", packages: ["pi", { a: 1 }] } as never,
    { ts: 0, source: "tumwater", type: "config_changed", keys: ["maxConcurrent", { a: 1 }] } as never,
    { ts: 0, source: "feature", type: "review_rejected", head: "abcdef12", reasons: [{ a: 1 }, "bad"] } as never,
    { ts: 0, source: "tumwater", type: "disk_reclaim", worktrees: [{ a: 1 }, "wt-1"] } as never,
    // rolesPhrase is the one reader behind three event-feed lines; a foreign entry is dropped
    // there too, so none of them renders "[object Object]".
    { ts: 0, source: "tumwater", type: "counters_reset", roles: [{ a: 1 }, "feature"] } as never,
    { ts: 0, source: "tumwater", type: "budget_handback", roles: [{ a: 1 }, "feature"] } as never,
    { ts: 0, source: "tumwater", type: "rate_limit_hold", roles: [{ a: 1 }, "feature"] } as never,
    { ts: 0, source: "tumwater", type: "counters_reset", roles: [{ a: 1 }] } as never,
  ];
  for (const e of foreign) {
    const line = formatEvent(e);
    assert.ok(!line.includes("[object Object]"), `${e.type} with foreign values must render a placeholder: ${line}`);
  }
  // parseEventLine admits any JSON object, so a typeless event reaches eventMessage's default
  // branch; it must read the placeholder, not "undefined".
  const typeless = formatEvent({ ts: 0, source: "tumwater" } as never);
  assert.ok(!typeless.includes("undefined"), `a typeless event must not render undefined: ${typeless}`);
});

// usageText's either-part-omitted rule has a third shape the run_end/landed tests never hit:
// cost without tokens (a provider that reports spend but not token counts). The separator
// must not appear before the money, and a fully empty usage must contribute nothing at all.
test("usageText renders cost-only usage without a dangling separator", () => {
  assert.equal(usageText({ ts: 0, source: "x", type: "run_end", costUsd: 0.05 } as never), "$0.05");
  assert.equal(usageText({ ts: 0, source: "x", type: "run_end", tokens: 0, costUsd: 0 } as never), "");
  // In a sentence context the cost-only fragment rides the same " · " glue — and an event
  // with no usage contributes neither text nor separator.
  const costOnly = formatEvent({ ts: 0, source: "clean", type: "run_end", run: 5, result: "changed", costUsd: 0.05 } as never);
  assert.match(costOnly, /run #5 merged · \$0\.05$/, `cost-only usage: ${costOnly}`);
  assert.doesNotMatch(costOnly, /tok/);
  const noUsage = formatEvent({ ts: 0, source: "clean", type: "run_end", run: 6, result: "changed" } as never);
  assert.doesNotMatch(noUsage, / · /, `a usage-free run_end must carry no usage clause: ${noUsage}`);
});

// The director inbox's prompt_edited event (inbox-edit.ts): the third queued-prompt lifecycle
// line, beside the prompt_enqueued and prompt_cancelled siblings — routine operation, not a
// warning, with the same preview rendering.
test("formatEvent renders prompt_edited plainly with the preview", () => {
  const line = formatEvent({
    ts: 0,
    source: "director",
    type: "prompt_edited",
    preview: "add dark mode, then verify",
  } as never);
  assert.match(line, /director\s+inbox message edited: add dark mode, then verify/, `the edited text must show: ${line}`);
  assert.ok(!line.includes("warning"), `an edited prompt is routine, not a warning: ${line}`);

  // A torn or hand-edited event line could carry no preview; the fallback must render "?",
  // never String(undefined)'s literal "undefined".
  const bare = formatEvent({ ts: 0, source: "director", type: "prompt_edited" } as never);
  assert.match(bare, /inbox message edited: \?$/);
  assert.ok(!bare.includes("undefined"), `corrupt preview must not render undefined: ${bare}`);
});

test("formatEvent renders prompt_taken plainly with the run and preview", () => {
  const line = formatEvent({ ts: 0, source: "perf", type: "prompt_taken", run: 7, preview: "fix x" });
  assert.match(line, /inbox message taken by run #7: fix x/);
  assert.ok(!line.includes("warning"), `a taken prompt is routine: ${line}`);
});

// The root install's dep_install event (build/dep-install.ts syncRootInstall): the operator's
// line for the checkout catching up with main's lockfile — routine when it passed, with the
// failed packages and reason carried when it did not. Both shapes belong in the feed's tests
// because the error clause is conditional: an absent detail must leave no dangling separator.
test("formatEvent renders dep_install with packages, status, duration, and an optional error", () => {
  const passed = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "dep_install",
    packages: ["pi", "ink"],
    status: "passed",
    durationMs: 4_200,
  } as never);
  assert.match(
    passed,
    /tumwater\s+root install \(pi, ink\) passed \(in 4s\)$/,
    `a passed install must name the packages, status, and duration with no error clause: ${passed}`,
  );
  assert.ok(!passed.includes("warning"), `a passed install is routine, not a warning: ${passed}`);

  const failed = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "dep_install",
    packages: ["ink"],
    status: "failed",
    durationMs: 0,
    error: "npm install exited 1",
  } as never);
  assert.match(
    failed,
    /tumwater\s+root install \(ink\) failed — npm install exited 1 \(in 0s\)$/,
    `a failed install must carry the reason after the status: ${failed}`,
  );
});

test("formatEvent reads a torn non-number durationMs as absent, like minutes", () => {
  // A hand-edited event can quote the number; a bare Number("4200") would coerce it and
  // render a duration the event never recorded. The shared finiteNumber rule keeps it absent.
  const quoted = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "dep_install",
    packages: ["ink"],
    status: "passed",
    durationMs: "4200",
  } as never);
  assert.doesNotMatch(quoted, /\(in \d/, `a quoted duration must read absent: ${quoted}`);
  // The same event with a real number still renders its duration.
  const real = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "dep_install",
    packages: ["ink"],
    status: "passed",
    durationMs: 4_200,
  } as never);
  assert.match(real, /\(in 4s\)$/);
});

test("formatEvent renders model_changed with the new selector, or pi's default", () => {
  const changed = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "model_changed",
    from: "prov-a/model-a",
    to: "prov-b/model-b",
  } as never);
  assert.match(changed, /tumwater\s+model changed — now prov-b\/model-b$/);
  const cleared = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "model_changed",
    from: "prov-a/model-a",
    to: null,
  } as never);
  assert.match(cleared, /tumwater\s+model changed — now pi's default$/);
});

test("formatEvent renders the model-fallback episode start and end", () => {
  const started = formatEvent({
    ts: 0,
    source: "bugfix",
    type: "model_fallback_started",
    provider: "backup",
    model: "f1",
    reason: "server",
  } as never);
  assert.match(started, /bugfix\s+model fallback — backup\/f1 engaged \(primary failing: server\)$/);
  const ended = formatEvent({
    ts: 0,
    source: "bugfix",
    type: "model_fallback_ended",
    provider: "primary",
    model: "m1",
    durationMs: 5 * 60_000,
  } as never);
  assert.match(ended, /bugfix\s+model fallback ended — back on primary\/m1 after 5m$/);
  // A torn durationMs is not NaN minutes: the episode length reads as 0.
  const endedTorn = formatEvent({
    ts: 0,
    source: "bugfix",
    type: "model_fallback_ended",
    provider: "primary",
    model: "m1",
    durationMs: "five",
  } as never);
  assert.match(endedTorn, /after 0m$/, `corrupt durationMs must read zero: ${endedTorn}`);
  assert.doesNotMatch(endedTorn, /NaN/);
});

test("formatEvent renders an opencode free model billed as demoted from free to priced", () => {
  const line = formatEvent({
    ts: 0,
    source: "feature",
    type: "opencode_free_model_billed",
    model: "opencode/deepseek-v4.1-flash-free",
    costUsd: 0.05,
  } as never);
  assert.match(line, /feature\s+opencode opencode\/deepseek-v4\.1-flash-free billed \$0\.05 — demoted from free to priced$/);
  // A torn cost reads as $0, never NaN or undefined.
  const torn = formatEvent({
    ts: 0,
    source: "feature",
    type: "opencode_free_model_billed",
    model: "opencode/m",
    costUsd: "five",
  } as never);
  assert.match(torn, /\$0\.00 — demoted from free to priced$/);
  assert.doesNotMatch(torn, /NaN|undefined/);
});

test("formatEvent renders slot_wait with the wait, purpose, and pool shape", () => {
  const line = formatEvent({
    ts: 0,
    source: "clean",
    type: "slot_wait",
    role: "clean",
    purpose: "verify",
    waitedMs: 31_000,
    slots: 4,
    pinned: 1,
  } as never);
  assert.match(line, /waited 31s to start/);
  assert.match(line, /clean check/);
  assert.match(line, /4 workspaces, 1 pinned/);
});

test("formatEvent renders check_wait with the wait and the role", () => {
  const line = formatEvent({
    ts: 0,
    source: "feature",
    type: "check_wait",
    role: "feature",
    scope: "merge",
    waitedMs: 45_000,
  } as never);
  assert.match(line, /waited 45s for a check slot/);
  assert.match(line, /feature merge check/);
  const base = { ts: 0, source: "feature", type: "check_wait", role: "feature", scope: "merge", waitedMs: 45_000 };
  const held = formatEvent({ ...base, heldBy: ["feature-2 merge", "main baseline"], limit: 2 } as never);
  assert.match(held, /\(feature merge check; held by feature-2 merge, main baseline of maxConcurrentChecks 2\)/);
  assert.doesNotMatch(formatEvent({ ...base, heldBy: [] } as never), /held by/);
  assert.doesNotMatch(formatEvent({ ...base, heldBy: "x" } as never), /held by/);
});

test("formatEvent renders provider_wait naming the key and the run cap when none", () => {
  const keyed = formatEvent({
    ts: 0,
    source: "feature",
    type: "provider_wait",
    role: "feature",
    waitedMs: 120_000,
    key: "omlx",
  } as never);
  assert.match(keyed, /waited 2m for a omlx slot \(feature\)/);
  const keyless = formatEvent({
    ts: 0,
    source: "feature",
    type: "provider_wait",
    role: "feature",
    waitedMs: 30_000,
  } as never);
  assert.match(keyless, /waited 30s for a run slot \(feature\)/);
  const base = { ts: 0, source: "feature", type: "provider_wait", role: "feature", waitedMs: 120_000 };
  assert.match(
    formatEvent({ ...base, cap: "provider", limit: 2, key: "omlx" } as never),
    /waited 2m for a omlx slot \(feature; maxConcurrentPerProvider\.omlx is 2\)/,
  );
  const team = formatEvent({ ...base, cap: "team", limit: 3, key: "omlx" } as never);
  assert.match(team, /waited 2m for a run slot \(feature; maxConcurrent is 3\)/);
  assert.doesNotMatch(team, /omlx/);
  assert.match(formatEvent({ ...base, cap: "team", limit: "x" } as never), /for a run slot \(feature\)/);
});

test("formatEvent renders claim assignment and release lines", () => {
  const assigned = formatEvent({ ts: 0, source: "feature-2", type: "claim", action: "assigned", key: "plan a", title: "Plan A" } as never);
  assert.match(assigned, /feature #2\s+assigned "Plan A"/);
  const released = formatEvent({ ts: 0, source: "feature-2", type: "claim", action: "released", key: "plan a", title: "Plan A", reason: "left" } as never);
  assert.match(released, /released "Plan A" \(left\)/);
  // A torn event: the reason falls back to "?", never the literal "undefined".
  const torn = formatEvent({ ts: 0, source: "feature", type: "claim", action: "released", title: "Plan A" } as never);
  assert.match(torn, /released "Plan A" \(\?\)/);
  assert.doesNotMatch(torn, /undefined/);
});

test("eventMessage gives every event type its own line, never the bare code", () => {
  for (const type of Object.keys(EVENT_TYPE_LABELS)) {
    assert.notEqual(eventMessage({ ts: 0, source: "tumwater", type } as never), type, type);
  }
});

test("formatEvent renders quiet hours, a forced restart, and a backend check in words", () => {
  const line = (e: Record<string, unknown>) => formatEvent({ ts: 0, source: "tumwater", ...e } as never);
  const started = line({ type: "quiet_hours_started", window: "23:00-07:00" });
  assert.match(started, /quiet hours \(23:00-07:00\)/);
  assert.match(started, /no new runs/);
  const bare = line({ type: "quiet_hours_started" });
  assert.doesNotMatch(bare, /undefined|\(\)/);
  assert.match(line({ type: "quiet_hours_ended" }), /roles start runs again/);
  assert.match(line({ type: "restart_forced", build: "abcdef1234567890" }), /abcdef12/);
  const found = line({ type: "backend_binary", agent: "claude", found: true });
  assert.match(found, /claude/);
  assert.match(found, /binary found/);
  assert.match(eventMessage({ ts: 0, source: "tumwater", type: "backend_binary", agent: "claude", found: false } as never), /^warning:/);
});
