// PiStreamParser behavior tests, split out of test/pi.test.ts (2026-09-28): pure stream
// parsing — final text, usage, the nothing-to-do/refusal sentinels, error and rate-limit
// classification, compaction, progress counting, and open tool-call tracking. The tests that
// drive the parser through a real (fake-pi) process — the quiet watchdog, stall warnings, and
// runPi lifecycle — stay in test/pi.test.ts.
//
// test/pi-stream.test.ts's edge-shape unit tests (blank-line tolerance, keepalive progress,
// contentless turns, the onToolCallStart hook) merged in here on 2026-09-29: they tested the
// same class at the same level, so the parser now has exactly one unit-test home beside
// pi.test.ts's process-level runs.
import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser } from "../src/pi-stream.js";
import { REFUSED_SENTINEL } from "../src/reply-contract.js";
import { assistantLine, errorLine, thinkingOnlyLine } from "./pi-events.js";

test("parser keeps the last non-empty assistant text and sums usage", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it", { tokens: 100, output: 40, cost: 0.01 }) + "\n");
  parser.feed(assistantLine("final answer\nSUMMARY: do it", { tokens: 50, output: 10, cost: 0.02 }) + "\n");
  assert.equal(parser.finalText, "final answer\nSUMMARY: do it");
  assert.equal(parser.outputTokens, 50, "output sums across turns");
  assert.equal(parser.peakContextTokens, 100, "peak is the largest request context, not a sum");
  assert.ok(Math.abs(parser.costUsd - 0.03) < 1e-9);
  assert.equal(parser.stopReason, "stop");
  // plans/commit-bodies.md: turns counts completed assistant messages — it feeds
  // PiRunResult.turns, which the commit trailer and the high-friction flag read.
  assert.equal(parser.turns, 2, "one turn per assistant message_end");
});

test("parser counts zero turns when no assistant message completes", () => {
  // Structural events (turn boundaries), streaming updates, and user messages are not
  // completed assistant turns — only an assistant message_end counts one.
  const parser = new PiStreamParser();
  parser.feed(JSON.stringify({ type: "turn_start" }) + "\n");
  parser.feed(
    JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    }) + "\n",
  );
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    }) + "\n",
  );
  assert.equal(parser.turns, 0);
});

test("parser keeps a sentinel declared in an intermediate message (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("TUMWATER_NOTHING_TO_DO", { tokens: 10 }) + "\n");
  parser.feed(assistantLine("all done", { tokens: 5 }) + "\n");
  assert.equal(parser.finalText, "all done", "finalText stays the last message");
  assert.ok(parser.declaredNothingToDo, "sentinel from an earlier turn is not lost");
});

test("parser does not flag nothing-to-do when no message carries the sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it") + "\n");
  parser.feed(assistantLine("all done\nSUMMARY: x") + "\n");
  assert.equal(parser.declaredNothingToDo, false);
});

// The refusal flag and reason must survive later messages, mirroring the nothing-to-do sentinel
// (a compliant run emits the sentinel once, in its final message — but a closing remark after it
// must not erase the declaration).

test("parser records refused + reason from the sentinel line", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`declining\n${REFUSED_SENTINEL}: plan conflicts with PRINCIPLES.md`) + "\n");
  assert.equal(parser.refused, true);
  assert.equal(parser.refusedReason, "plan conflicts with PRINCIPLES.md");
});

test("parser keeps a refusal declared in an intermediate message (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: too risky to land`) + "\n");
  parser.feed(assistantLine("closing remarks about the refusal") + "\n");
  assert.equal(parser.finalText, "closing remarks about the refusal", "finalText stays the last message");
  assert.equal(parser.refused, true, "refusal from an earlier turn is not lost");
  assert.equal(parser.refusedReason, "too risky to land");
});

test("parser does not treat a bare sentinel as a refusal", () => {
  // BUGS.md 2026-09-23: the refusal comes only from an anchored line with a reason — a bare
  // sentinel is a mention, not a declaration, and must not route the tick to handleRefusal.
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}`) + "\n");
  assert.equal(parser.refused, false);
  assert.equal(parser.refusedReason, "");
});

test("parser does not treat a mid-sentence mention as a refusal", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`I would say ${REFUSED_SENTINEL}: no, let me keep going`) + "\n");
  assert.equal(parser.refused, false, "only an anchored line declares a refusal");
  assert.equal(parser.refusedReason, "");
});

test("parser clears the refusal when a negating reason follows it, last line wins both ways", () => {
  // BUGS.md 2026-09-23: `TUMWATER_REFUSED: none` on an ordinary work-completed reply must not
  // refuse; and the run's FINAL anchored line is its verdict in both directions — a real
  // reason after a negation refuses again, a negation after a real reason clears.
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: too risky to land`) + "\n");
  parser.feed(assistantLine(`reconsidered\n${REFUSED_SENTINEL}: none`) + "\n");
  assert.equal(parser.refused, false, "a negating reason clears an earlier refusal");
  assert.equal(parser.refusedReason, "");
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: on reflection, still too risky`) + "\n");
  assert.equal(parser.refused, true, "a real reason after a negation refuses again");
  assert.equal(parser.refusedReason, "on reflection, still too risky");
});

test("parser never refuses on a negating reason alone, in every recorded shape", () => {
  // The exact shapes the discarded ticks emitted (BUGS.md 2026-09-23): `none`, `(none — no
  // entry refused this run)`, and the empty reason a bare labeled line leaves.
  for (const text of [
    `${REFUSED_SENTINEL}: none`,
    `${REFUSED_SENTINEL}: (none — no entry refused this run)`,
    `${REFUSED_SENTINEL}: n/a`,
    `${REFUSED_SENTINEL}: N/A`,
    `${REFUSED_SENTINEL}:`,
  ]) {
    const parser = new PiStreamParser();
    parser.feed(assistantLine(`all done\nSUMMARY: shipped it\n${text}`) + "\n");
    assert.equal(parser.refused, false, `not a refusal: ${JSON.stringify(text)}`);
    assert.equal(parser.refusedReason, "");
  }
});

test("parser does not set refused when no message carries the sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("all done\nSUMMARY: fix it") + "\n");
  assert.equal(parser.refused, false);
  assert.equal(parser.refusedReason, "");
});

test("parser flags a contentless final message (generation cut off mid-stream)", () => {
  // A thinking-only LAST message is the cut-off signature (observed live: pi clamped
  // max_output_tokens to 16 near the declared context window and LM Studio reported the
  // truncation as a normal stop).
  const parser = new PiStreamParser();
  parser.feed(assistantLine("reading files") + "\n");
  parser.feed(thinkingOnlyLine("git.ts looks clean. Next let's check gui.ts (16:3", { output: 16 }) + "\n");
  assert.ok(parser.finalMessageContentless, "thinking-only final message is contentless");
  assert.equal(parser.finalText, "reading files", "earlier text is retained for the summary");

  // Only the LAST message counts: a substantive message after a cut-off clears the flag.
  const recovered = new PiStreamParser();
  recovered.feed(thinkingOnlyLine("hmm") + "\n");
  recovered.feed(assistantLine("SUMMARY: fix it") + "\n");
  assert.equal(recovered.finalMessageContentless, false);

  // A tool call is substantive content even without a text block.
  const toolOnly = new PiStreamParser();
  toolOnly.feed(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash" }],
        stopReason: "toolUse",
      },
    }) + "\n",
  );
  assert.equal(toolOnly.finalMessageContentless, false);
});

test("parser records that pi auto-compacted the session", () => {
  const parser = new PiStreamParser();
  assert.equal(parser.compacted, false);
  parser.feed(JSON.stringify({ type: "compaction_start", reason: "threshold" }) + "\n");
  assert.ok(parser.compacted);
});

test("parser handles chunked lines and ignores noise", () => {
  const parser = new PiStreamParser();
  const line = assistantLine("hello", { tokens: 5 });
  parser.feed(line.slice(0, 20));
  parser.feed(line.slice(20) + "\nnot json\n" + JSON.stringify({ type: "turn_start" }) + "\n");
  assert.equal(parser.finalText, "hello");
  assert.equal(parser.peakContextTokens, 5);
});

test("parser skips valid-JSON non-object lines without throwing or counting progress", () => {
  // pi's stream is one JSON object per line. A stray `null` used to throw a TypeError out of
  // feed() (reading `.errorMessage` off null), and a scalar passed the truthy check and was
  // counted as forward progress — resetting the hang watchdog for a line that proves nothing.
  const parser = new PiStreamParser();
  parser.feed("null\n5\n[]\n\"noise\"\n");
  assert.equal(parser.progressCount, 0, "non-object lines are not forward progress");
  parser.feed(JSON.stringify({ type: "turn_start" }) + "\n");
  assert.equal(parser.progressCount, 1, "a real event still counts");
});

test("parser records error messages and clears them after a later success", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
    }) + "\n",
  );
  assert.equal(parser.errorMessage, "Connection error.");
  assert.equal(parser.stopReason, "error");
  parser.feed(assistantLine("recovered") + "\n");
  assert.equal(parser.errorMessage, undefined);
  assert.equal(parser.stopReason, "stop");
});

test("parser flags the LM Studio predict-stream timeout as a transient server failure (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(
    errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.") + "\n",
  );
  assert.equal(parser.transientServerTimeout, true);
  assert.equal(parser.contextExceeded, false, "a timeout is not a context overflow");
  assert.equal(parser.stopReason, "error");
});

test("parser does not flag other errors as transient server timeouts", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine("Connection error.") + "\n");
  parser.feed(
    JSON.stringify({ type: "error", errorMessage: "request timed out after 30s" }) + "\n",
  );
  assert.equal(parser.transientServerTimeout, false);
});

test("parser flags a provider 429 rate-limit rejection as transient, with its Retry-After hint (regression, BUGS.md 2026-09-21)", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine('429 "Rate limit exceeded"') + "\n");
  assert.equal(parser.transientRateLimit, true);
  assert.equal(parser.retryAfterSeconds, undefined, "no hint in the observed fleet error text");
  assert.equal(parser.transientServerTimeout, false, "a rate limit is its own class, not a stream timeout");
});

test("parser captures a Retry-After delay from the rate-limit error text and ignores it on other errors", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine("Too Many Requests — retry after 30s") + "\n");
  assert.equal(parser.transientRateLimit, true);
  assert.equal(parser.retryAfterSeconds, 30);
  const other = new PiStreamParser();
  other.feed(errorLine("gateway retry after 30s") + "\n");
  assert.equal(other.transientRateLimit, false, "a Retry-After hint outside a rate limit is not one");
  assert.equal(other.retryAfterSeconds, undefined);
});

test("parser ignores user message_end events", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    }) + "\n",
  );
  assert.equal(parser.finalText, "");
});

// Progress counting feeds the quiet watchdog (runPi kills a run that stops making progress):
// structural/boundary events count; streaming deltas never do. pi's JSON protocol strips the
// cumulative message snapshot from message_update lines, so they carry nothing this parser
// acts on — and skipping them before parsing is what keeps a zombie stream's content-free
// keepalives (in any shape) from resetting the watchdog clock.

test("message updates never count as progress; boundary events do", () => {
  const parser = new PiStreamParser();
  // Current wire format: constant-size usage plus a small delta event, no cumulative message.
  const update = (delta: string) =>
    JSON.stringify({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
    }) + "\n";
  parser.feed(update("a"));
  parser.feed(update("ab"));
  assert.equal(parser.progressCount, 0, "deltas are not progress");
  parser.feed(JSON.stringify({ type: "turn_end" }) + "\n");
  assert.equal(parser.progressCount, 1, "structural events are progress");
});

test("message updates are skipped before parsing even in the old cumulative shape", () => {
  const parser = new PiStreamParser();
  // The pre-strip wire format carried a growing message snapshot; whatever arrives under the
  // message_update type is verifiably a delta and must not count as progress.
  parser.feed(
    JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "a".repeat(50) }] },
    }) + "\n",
  );
  assert.equal(parser.progressCount, 0);
});


test("parser tracks open tool calls across start, update, and end", () => {
  const parser = new PiStreamParser();
  assert.equal(parser.openToolCalls.length, 0);
  parser.feed(
    JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "find / -name x" } }) + "\n",
  );
  assert.deepEqual(
    parser.openToolCalls.map((c) => [c.id, c.label]),
    [["c1", "bash find / -name x"]],
    "the open call is tracked by id with a label that names the command",
  );
  const call = parser.openToolCalls[0];
  assert.ok(call, "one entry for the started call");
  // A content-bearing update moves the activity clock...
  call.lastActivityAt -= 60_000; // simulate a minute of silence
  parser.feed(
    JSON.stringify({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "some output" }] },
    }) + "\n",
  );
  assert.ok(call.lastActivityAt > Date.now() - 1000, "content update moves the clock");
  // ...but an empty-content one (bash emits it right after start) does not.
  call.lastActivityAt -= 60_000;
  const before = call.lastActivityAt;
  parser.feed(
    JSON.stringify({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
      partialResult: { content: [] },
    }) + "\n",
  );
  assert.equal(call.lastActivityAt, before, "empty-content update does not move the clock");
  // An end clears only its own call — parallel siblings stay tracked.
  parser.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/a/b.ts" } }) + "\n");
  parser.feed(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false }) + "\n");
  assert.deepEqual(parser.openToolCalls.map((c) => c.id), ["c2"]);
});

test("a start without toolName still names the command (or 'tool') in the open-call label", () => {
  const parser = new PiStreamParser();
  // pi omits toolName on some start events: the warning must name the bare command, with no
  // leading space and no empty name.
  parser.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", args: { command: "sleep 999" } }) + "\n");
  assert.deepEqual(
    parser.openToolCalls.map((c) => c.label),
    ["sleep 999"],
    "no toolName — the label is the bare command, not ' sleep 999' or ''",
  );
  // No name and no recognizable arg falls back to 'tool', like progress.ts's stall flag.
  parser.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", args: {} }) + "\n");
  assert.deepEqual(parser.openToolCalls.map((c) => c.label), ["sleep 999", "tool"]);
});


test("parser flags context-exceeded errors surfaced in retry events", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "auto_retry_start",
      attempt: 3,
      errorMessage:
        'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}',
    }) + "\n",
  );
  assert.equal(parser.contextExceeded, true);
  const clean = new PiStreamParser();
  clean.feed(JSON.stringify({ type: "auto_retry_start", errorMessage: "Connection error." }) + "\n");
  assert.equal(clean.contextExceeded, false);
});

test("feed skips blank and whitespace-only lines without delivering them to onLine", () => {
  const parser = new PiStreamParser();
  const seen: string[] = [];
  const good = assistantLine("hello", { tokens: 5 });

  // Leading, trailing, and interior blank lines — the whitespace case matters because pi can
  // end a chunk with a bare newline; feeding "" to the raw-log callback (or parsing it) would
  // both pollute the transcript and, for a non-whitespace-tolerant check, throw on JSON.parse.
  parser.feed(`\n  \n${good}\n\t\n\n`, (line) => seen.push(line));

  assert.deepEqual(seen, [good], "only the non-blank line reaches onLine");
  assert.equal(parser.finalText, "hello");
  assert.equal(parser.turns, 1, "the blank lines are not parsed as events");
  assert.equal(parser.progressCount, 1);
});

test("content-free tool_execution_updates do not count as progress (no keepalive reset of the hang watchdog)", () => {
  // progressCount drives runPi's quiet watchdog (src/pi.ts allowedSilenceMs): a zombie stream
  // that emits periodic content-free tool_execution_update keepalives must not reset it, the
  // same rule message_update deltas already obey. Only a content-bearing update counts.
  const parser = new PiStreamParser();
  const line = (event: Record<string, unknown>) => JSON.stringify(event) + "\n";
  parser.feed(
    line({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 600" } }) +
      line({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "" }] } }) +
      line({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [] } }) +
      line({ type: "tool_execution_update", toolCallId: "c1", partialResult: {} }),
  );
  assert.equal(parser.progressCount, 1, "only the start counts — keepalive updates do not reset the watchdog");
  assert.equal(parser.openToolCalls.length, 1, "the call stays tracked");
  parser.feed(
    line({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "alive" }] } }),
  );
  assert.equal(parser.progressCount, 2, "a content-bearing update is real progress");
});

test("an assistant message_end with no content array is handled as an empty, contentless turn", () => {
  const parser = new PiStreamParser();
  // No `content` field at all: messageText's `?? []` fallback and finalMessageContentless'
  // `msg.content ?? []` must both tolerate it (a TypeError here would crash the whole parse).
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { totalTokens: 7, output: 3, cost: { total: 0 } },
        stopReason: "stop",
      },
    }) + "\n",
  );

  assert.equal(parser.finalText, "", "no text blocks");
  assert.equal(parser.finalMessageContentless, true);
  assert.equal(parser.turns, 1);
  assert.equal(parser.outputTokens, 3);
  assert.equal(parser.peakContextTokens, 7);
});

test("onToolCallStart observes each tool call once, at its start, with pi's name and raw args", () => {
  const seen: Array<[string, unknown]> = [];
  const parser = new PiStreamParser((toolName, args) => seen.push([toolName, args]));
  const line = (event: Record<string, unknown>) => JSON.stringify(event) + "\n";
  parser.feed(
    line({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } }) +
      line({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "ok" }] } }) +
      line({ type: "tool_execution_end", toolCallId: "c1", result: {}, isError: false }) +
      // pi omits toolName on some start events: the hook still fires, with an empty name.
      line({ type: "tool_execution_start", toolCallId: "c2", args: { command: "ls" } }),
  );
  assert.deepEqual(seen, [
    ["bash", { command: "npm test" }],
    ["", { command: "ls" }],
  ]);
  // The hook only observes: the parser's own open-call tracking runs exactly as without it.
  assert.deepEqual(parser.openToolCalls.map((c) => c.id), ["c2"]);
});

