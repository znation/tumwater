// The claude native-to-canonical translator (plans/agent-backends.md "Canonical event
// stream", PLANS.md "Agent backends, part 3a/7"). Fixture lines go straight into the
// translator; the canonical lines it emits go straight into PiStreamParser, so these tests
// exercise the whole translation contract without a spawned process or a registered backend.
import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser } from "../src/pi/pi-stream.js";
import { claudeTranslator, type ClaudeStreamTranslator } from "../src/agent/claude/claude-stream.js";
import {
  claudeApiRetry,
  claudeAssistant,
  claudeCompactBoundary,
  claudeInit,
  claudeRateLimit,
  claudeResult,
  claudeText,
  claudeThinking,
  claudeToolResult,
  claudeToolUse,
  claudeUnknown,
} from "./fixtures/claude-events.js";

/** Translate native lines, then fold the canonical ones through the parser. */
function fold(lines: string[]): {
  parser: PiStreamParser;
  translator: ClaudeStreamTranslator;
  canonical: string[];
} {
  const translator = claudeTranslator();
  const parser = new PiStreamParser();
  const canonical: string[] = [];
  for (const line of lines) canonical.push(...translator.translate(line));
  for (const line of canonical) parser.feed(line + "\n");
  return { parser, translator, canonical };
}

const types = (lines: string[]): string[] => lines.map((line) => (JSON.parse(line) as { type: string }).type);

test("split-block assistant events fold to one message_end with usage counted once", () => {
  const usage = { input: 10, cacheRead: 90, output: 5 };
  const { parser, translator, canonical } = fold([
    claudeAssistant({ id: "msg-1", blocks: [claudeText("working")], usage }),
    // Same id, same usage repeated, second content block (finding 5).
    claudeAssistant({ id: "msg-1", blocks: [claudeToolUse("t1", "Bash", { command: "ls" })], usage }),
    claudeToolResult("t1"),
    claudeResult({ totalCostUsd: 0.05 }),
  ]);

  assert.equal(canonical.filter((l) => l.includes('"message_end"')).length, 1, "one message_end per id");
  assert.equal(parser.turns, 1, "one turn per folded message");
  assert.equal(parser.outputTokens, 5, "usage counted once, not once per block event");
  assert.equal(parser.promptTokens, 100, "prompt tokens = input + cacheRead");
  assert.equal(parser.costUsd, 0.05, "the result's total_cost_usd is authoritative");
  assert.deepEqual(
    canonical.filter((l) => JSON.parse(l).type === "tool_execution_start").map((l) => JSON.parse(l).toolName),
    ["bash"],
    "the tool_use block starts a canonical tool execution under its mapped name",
  );
  assert.ok(!translator.warnings().includes("cost_unknown"), "a result supplies the cost");
});

test("a tool_use block opens the canonical call while claude runs the tool, before its result", () => {
  // The open-call trackers (runPi's stall warning, the dashboard flag) can only judge a call
  // while it is open. claude emits the assistant tool_use message before it runs the tool and
  // the user tool_result only after, so the translator must open the canonical call at the
  // former; emitting it only at the closing user event would show start and end together and
  // leave the call invisible for the whole run (plans/agent-backends.md "Watchdogs and
  // progress").
  const translator = claudeTranslator();
  const parser = new PiStreamParser();
  const feed = (line: string): void => {
    for (const canonical of translator.translate(line)) parser.feed(canonical + "\n");
  };
  feed(claudeAssistant({ id: "m1", blocks: [claudeToolUse("t1", "Bash", { command: "sleep 999" })], stopReason: "tool_use" }));
  assert.equal(parser.openToolCalls.length, 1, "the call is open while the tool runs");
  assert.equal(parser.openToolCalls[0]?.command, "sleep 999", "the raw command rides the open call");
  feed(claudeToolResult("t1"));
  assert.equal(parser.openToolCalls.length, 0, "the tool result closes it");
});

test("the result's usage replaces the per-message output-token snapshots", () => {
  const { parser } = fold([
    claudeAssistant({ id: "m1", blocks: [claudeText("a")], usage: { input: 4, output: 2 } }),
    claudeAssistant({ id: "m2", blocks: [claudeText("b")], usage: { input: 4, output: 3 } }),
    claudeResult({ totalCostUsd: 0.5, outputTokens: 1000 }),
  ]);
  assert.equal(parser.outputTokens, 1000);
});

test("a run with no result keeps cost 0 and reports cost_unknown", () => {
  const { parser, translator } = fold([
    claudeAssistant({ id: "msg-1", blocks: [claudeText("hi")], usage: { input: 4, output: 2 } }),
  ]);
  assert.equal(parser.costUsd, 0);
  assert.ok(translator.warnings().includes("cost_unknown"), "no run_cost means the cost is unknown");
});

test("an edit tool call maps to edit, carries the path alias, and pins firstEditTurn", () => {
  const { parser, canonical } = fold([
    claudeAssistant({
      id: "msg-1",
      blocks: [claudeToolUse("t1", "Edit", { file_path: "/wt/a.ts", old_string: "a", new_string: "b" })],
      usage: { input: 3, output: 1 },
    }),
    claudeToolResult("t1"),
    claudeResult({ totalCostUsd: 0.01 }),
  ]);
  assert.equal(parser.firstEditTurn, 1);
  const start = JSON.parse(canonical.find((l) => JSON.parse(l).type === "tool_execution_start")!) as {
    toolName: string;
    args: Record<string, unknown>;
  };
  assert.equal(start.toolName, "edit");
  assert.equal(start.args.path, "/wt/a.ts", "describeToolCall reads the path alias");
  assert.equal(start.args.file_path, "/wt/a.ts", "the original input is preserved");
});

test("a native tool name colliding with an Object.prototype key still maps by name", () => {
  // The tool-name table is a plain object, so a lookup by a name like "constructor" or
  // "__proto__" returns the inherited property (a function or object) instead of falling back
  // to the lower-cased native name; JSON.stringify then drops or corrupts the canonical
  // event's toolName. The translator's contract is forward-compatible with arbitrary names
  // (MCP servers name their own tools), so the lookup must own-property-check like claude-args
  // does for EFFORT_BY_THINKING.
  const names = ["constructor", "toString", "hasOwnProperty", "__proto__"];
  const { canonical } = fold([
    claudeAssistant({
      id: "msg-1",
      blocks: names.map((n, i) => claudeToolUse(`t${i}`, n, { command: `run ${n}` })),
      usage: { output: 1 },
    }),
    claudeToolResult("t0"),
    claudeResult({ totalCostUsd: 0.01 }),
  ]);
  const starts = canonical
    .filter((l) => JSON.parse(l).type === "tool_execution_start")
    .map((l) => JSON.parse(l).toolName);
  assert.deepEqual(starts, names.map((n) => n.toLowerCase()));
});

test("classifies API errors from the result's structured signals", () => {
  const cases: Array<{
    name: string;
    opts: Parameters<typeof claudeResult>[0];
    expected: Partial<Record<"configError" | "transientRateLimit" | "transientBackend" | "contextExceeded" | "budgetCapped" | "resumeMissing", boolean>>;
    backendKind?: string;
  }> = [
    { name: "404 unknown model", opts: { isError: true, apiErrorStatus: 404, text: "model missing" }, expected: { configError: true } },
    {
      name: "not logged in",
      opts: { isError: true, apiErrorStatus: null, text: "Not logged in · Please run /login" },
      expected: { configError: true },
    },
    { name: "429", opts: { isError: true, apiErrorStatus: 429 }, expected: { transientRateLimit: true } },
    { name: "529", opts: { isError: true, apiErrorStatus: 529 }, expected: { transientBackend: true }, backendKind: "server" },
    { name: "prompt too long", opts: { isError: true, text: "prompt is too long" }, expected: { contextExceeded: true } },
    {
      name: "prompt too long under a 400",
      opts: { isError: true, apiErrorStatus: 400, text: "prompt is too long" },
      expected: { contextExceeded: true },
    },
    {
      name: "budget cap",
      opts: { isError: true, terminalReason: "error_max_budget_usd" },
      expected: { budgetCapped: true },
    },
    {
      name: "resume missing",
      opts: { isError: true, text: "No conversation found with session ID: x" },
      expected: { resumeMissing: true },
    },
    // Text fallbacks, reached when claude leaves `api_error_status` null or omits it.
    {
      name: "rate limit in text",
      opts: { isError: true, text: "rate limit reached, retry later" },
      expected: { transientRateLimit: true },
    },
    {
      name: "overloaded in text",
      opts: { isError: true, text: "Overloaded" },
      expected: { transientBackend: true },
      backendKind: "server",
    },
    {
      name: "connection in text",
      opts: { isError: true, text: "connection refused" },
      expected: { transientBackend: true },
      backendKind: "connection",
    },
    {
      name: "timeout in text",
      opts: { isError: true, text: "request timed out" },
      expected: { transientBackend: true },
      backendKind: "timeout",
    },
    {
      name: "401 in text under a null status",
      opts: { isError: true, apiErrorStatus: null, text: "API error 401" },
      expected: { configError: true },
    },
    {
      name: "an error text naming no known signal",
      opts: { isError: true, text: "something odd happened" },
      expected: {},
    },
  ];
  for (const c of cases) {
    const { parser } = fold([claudeResult(c.opts)]);
    for (const flag of ["configError", "transientRateLimit", "transientBackend", "contextExceeded", "budgetCapped", "resumeMissing"] as const) {
      assert.equal(
        Boolean(parser[flag]),
        c.expected[flag] === true,
        `${c.name}: ${flag}`,
      );
    }
    if (c.backendKind !== undefined) assert.equal(parser.backendFailureKind, c.backendKind, `${c.name}: kind`);
  }
});

test("a SIGTERM aborted_tools result carries no error classification", () => {
  const { parser } = fold([
    claudeAssistant({ id: "msg-1", blocks: [claudeText("partial")], usage: { output: 2 } }),
    claudeResult({ isError: true, terminalReason: "aborted_tools", text: "killed", totalCostUsd: 0.02 }),
  ]);
  assert.equal(parser.transientRateLimit, false);
  assert.equal(parser.transientBackend, false);
  assert.equal(parser.configError, false);
  assert.equal(parser.contextExceeded, false);
  assert.equal(parser.budgetCapped, false);
  assert.equal(parser.resumeMissing, false);
  assert.equal(parser.costUsd, 0.02, "the partial cost still books");
});

test("init reports billing and the rate-limit window, newest per type", () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const { parser } = fold([
    claudeInit({ apiKeySource: "none", cwd: "/wt", sessionId: "s1" }),
    claudeRateLimit({ type: "five_hour", status: "allowed", utilization: 0.4, isUsingOverage: true }),
    claudeRateLimit({ type: "five_hour", status: "rejected", resetsAt: future }),
  ]);
  assert.equal(parser.billing, "subscription");
  assert.equal(parser.usedOverage, true, "an earlier overage reading is not forgotten");
  assert.equal(parser.rateWindows.length, 1, "the newest reading per type replaces the older");
  assert.equal(parser.rateWindows[0]?.status, "rejected");
  assert.equal(parser.transientRateLimit, true, "a rejected window is a transient rate limit");
  assert.ok(
    (parser.retryAfterSeconds ?? 0) > 590 && (parser.retryAfterSeconds ?? 0) <= 600,
    "retryAfterSeconds is derived from resetsAt",
  );
});

test("a 2.1.295 rate_limit_event yields one reading per unifiedWindows entry", () => {
  const { parser } = fold([
    claudeRateLimit({
      type: "five_hour",
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.18, resetsAt: 1790000000 },
        seven_day: { utilization: 0.29, resetsAt: 1790400000 },
      },
    }),
  ]);
  const by = new Map(parser.rateWindows.map((w) => [w.type, w]));
  assert.equal(by.size, 2);
  assert.equal(by.get("five_hour")?.utilization, 0.18);
  assert.equal(by.get("five_hour")?.status, "allowed", "the top-level status goes to the binding window");
  assert.equal(by.get("seven_day")?.utilization, 0.29);
  assert.equal(by.get("seven_day")?.resetsAt, 1790400000);
});

test("init maps apiKeySource to API billing", () => {
  const { parser } = fold([claudeInit({ apiKeySource: "ANTHROPIC_API_KEY" })]);
  assert.equal(parser.billing, "api");
});

test("retries and compaction translate to the canonical events the transcript renders", () => {
  const { parser, canonical } = fold([
    claudeApiRetry({ attempt: 2, maxRetries: 5, errorStatus: 503, error: "overloaded" }),
    claudeCompactBoundary(),
  ]);
  assert.deepEqual(types(canonical), ["auto_retry_start", "compaction_start"]);
  assert.equal(parser.compacted, true);
});

test("an unmapped native type is reported once and does not fail the run", () => {
  const translator = claudeTranslator();
  translator.translate(claudeUnknown("task_started"));
  translator.translate(claudeUnknown("task_started"));
  translator.translate(claudeInit());
  assert.deepEqual(translator.warnings(), ["task_started"]);
});

test("a content block pi has no vocabulary for is dropped without failing the run", () => {
  // claude may add block types over time (server_tool_use, image, ...). The translator's
  // contract is forward-compatible: an unknown block is dropped while the known blocks around
  // it still fold into the message.
  const { canonical } = fold([
    claudeAssistant({
      id: "msg-1",
      blocks: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
        claudeText("kept"),
      ],
      usage: { output: 1 },
    }),
    claudeResult({ totalCostUsd: 0.001 }),
  ]);
  const messageEnd = JSON.parse(canonical.find((l) => JSON.parse(l).type === "message_end")!) as {
    message: { content: Array<{ type: string; text?: string }> };
  };
  assert.deepEqual(messageEnd.message.content.map((b) => b.type), ["text"], "the unknown block is dropped");
  assert.equal(messageEnd.message.content[0]?.text, "kept", "the surrounding known block survives");
});

test("thinking blocks translate to canonical thinking content", () => {
  const { canonical } = fold([
    claudeAssistant({ id: "msg-1", blocks: [claudeThinking("hmm"), claudeText("done")], usage: { output: 1 } }),
    claudeResult({ totalCostUsd: 0.001 }),
  ]);
  const messageEnd = JSON.parse(canonical.find((l) => JSON.parse(l).type === "message_end")!) as {
    message: { content: Array<{ type: string }> };
  };
  assert.deepEqual(
    messageEnd.message.content.map((b) => b.type),
    ["thinking", "text"],
  );
});

/** The stream-end flush a translator may expose, read structurally so the test compiles before
 * the seam declares it (it fails on the assertion, not on the type). */
const finalize = (t: ClaudeStreamTranslator): string[] =>
  (t as { finalize?: () => string[] }).finalize?.() ?? [];

test("a killed run's unclosed assistant message flushes at stream end", () => {
  // claude emits one event per content block; the translator emits its folded message_end only
  // when the NEXT message, a user event, or the result closes it. A run the harness kills (the
  // quiet watchdog, the run deadline, a shutdown) never sends that closing event, so without a
  // stream-end flush the last assistant message is dropped from the canonical stream and the
  // raw log — the very turn a timed-out review's transcript needs (BUGS.md 2026-10-09).
  const translator = claudeTranslator();
  assert.deepEqual(
    translator.translate(claudeAssistant({ id: "msg-1", blocks: [claudeText("still working")], usage: { output: 3 } })),
    [],
    "the split-block message stays pending until it closes",
  );
  const flushed = finalize(translator);
  assert.equal(flushed.filter((l) => JSON.parse(l).type === "message_end").length, 1, "finalize emits the pending message_end");
  // The runner folds finalize's lines through the parser like any other canonical line.
  const parser = new PiStreamParser();
  for (const line of flushed) parser.feed(line + "\n");
  assert.equal(parser.turns, 1, "the flushed turn counts");
  assert.match(parser.finalText, /still working/, "the flushed text reaches the final reply");
  // A normal result already flushed the message; finalize on that same run emits nothing.
  const closed = claudeTranslator();
  closed.translate(claudeAssistant({ id: "msg-2", blocks: [claudeText("done")], usage: {} }));
  assert.ok(closed.translate(claudeResult({ totalCostUsd: 0.01 })).length > 0);
  assert.deepEqual(finalize(closed), [], "a completed run's finalize is empty");
});

test("thinking_tokens estimates and tool_progress heartbeats are known events and raise no warning", () => {
  const translator = claudeTranslator();
  const lines = [
    JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 275, estimated_tokens_delta: 225 }),
    JSON.stringify({ type: "tool_progress", tool_use_id: "toolu_1-heartbeat-1", tool_name: "Bash", parent_tool_use_id: "toolu_1", elapsed_time_seconds: 60, heartbeat: true }),
  ];
  for (const line of lines) assert.deepEqual(translator.translate(line), []);
  assert.ok(!translator.warnings().some((w) => w.startsWith("agent_unknown_event") || w.includes("thinking_tokens") || w.includes("tool_progress")), "no unknown-event warning");
});
