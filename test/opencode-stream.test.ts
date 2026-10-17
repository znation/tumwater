// The opencode native-to-canonical translator (plans/opencode-backend.md §6, PLANS.md
// "OpenCode backend, part 4/7"). Real 2.0.32 captures from test/fixtures/opencode-captures/
// go straight into the translator; the canonical lines it emits go straight into
// PiStreamParser, so these tests exercise the whole translation contract without a spawned
// process or a registered backend.
import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser } from "../src/pi/pi-stream.js";
import { opencodeExportLines, opencodeTranslator, type OpencodeStreamTranslator } from "../src/agent/opencode/opencode-stream.js";
import {
  opencodeCaptures,
  opencodeContextOverflow,
  opencodeMalformed,
  opencodeRateLimit,
  opencodeServerError,
} from "./fixtures/opencode-events.js";

/** Translate native lines (then a finalize), and fold the canonical ones through the parser. */
function fold(lines: string[]): {
  parser: PiStreamParser;
  translator: OpencodeStreamTranslator;
  canonical: string[];
} {
  const translator = opencodeTranslator({ cwd: "/work" });
  const parser = new PiStreamParser();
  const canonical: string[] = [];
  for (const line of lines) canonical.push(...translator.translate(line));
  canonical.push(...translator.finalize());
  for (const line of canonical) parser.feed(line + "\n");
  return { parser, translator, canonical };
}

const types = (lines: string[]): string[] => lines.map((line) => (JSON.parse(line) as { type: string }).type);

test("edit-run.jsonl: session, agent_start, three message_ends each with its tool execution, and the final text flushed", () => {
  const { canonical } = fold(opencodeCaptures.editRun);
  const seq = types(canonical);
  assert.deepEqual(seq.slice(0, 2), ["session", "agent_start"], "the run announces itself once");
  // The streamed part is three (message_end + tool_execution_start + tool_execution_end) triples.
  assert.deepEqual(
    seq.slice(2, 2 + 9),
    [
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
    ],
    "one message_end per step, each followed by its tool execution",
  );
  // The final text ("DONE") arrives with no open step_start and is flushed by finalize().
  assert.deepEqual(seq.slice(-1), ["message_end"], "the trailing text becomes a message_end, not a dropped line");
  const tools = canonical
    .filter((l) => JSON.parse(l).type === "tool_execution_start")
    .map((l) => (JSON.parse(l) as { toolName: string }).toolName);
  assert.deepEqual(tools, ["read", "edit", "bash"], "read → edit → bash, shell mapped to bash");
});

test("edit-run.jsonl folds to finalText DONE, then opencodeExportLines forces the export's authoritative tokens", () => {
  const { parser, canonical } = fold(opencodeCaptures.editRun);
  // Finalize-white flushes the trailing "DONE" so the parser sees it.
  assert.equal(parser.finalText, "DONE", "the never-finished final text is not lost");

  // The export overrides the summed streamed step tokens (the stream dropped the last step).
  const beforePeak = parser.peakContextTokens;
  const exportJson = JSON.parse(opencodeCaptures.editRunExport);
  assert.deepEqual(types(opencodeExportLines(exportJson)), ["run_cost", "run_usage"], "run_cost then run_usage");
  for (const line of opencodeExportLines(exportJson)) parser.feed(line + "\n");
  assert.equal(parser.outputTokens, 433, "export output");
  assert.equal(parser.promptTokens, 3223 + 7680, "export input + cacheRead");
  assert.equal(parser.cacheReadTokens, 7680, "export cacheRead");
  assert.equal(parser.peakContextTokens, beforePeak, "the export's cumulative total stays off the per-request peak");
  assert.equal(parser.costUsd, 0, "export cost 0");
  assert.ok(canonical.length > 0);
});

test("a missing or non-object info.tokens makes opencodeExportLines return [] for usage_partial", () => {
  // Part 5/7 logs `opencode_usage_partial` when opencodeExportLines returns []; a missing or
  // malformed `info.tokens` must yield [] — never a zeroed run_usage masquerading as real usage.
  const base = { info: { cost: 0.01, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } };
  assert.equal(opencodeExportLines(base).length, 2, "a well-formed export yields run_cost and run_usage");
  for (const missing of [
    { info: { cost: 0.01 } },
    { info: { cost: 0.01, tokens: null } },
    { info: { cost: 0.01, tokens: "nope" } },
    { info: { cost: 0.01, tokens: [3, 1] } },
  ]) {
    assert.deepEqual(opencodeExportLines(missing), [], `malformed tokens returns []: ${JSON.stringify(missing)}`);
  }
  assert.deepEqual(opencodeExportLines({ info: { tokens: {} } }), [], "no cost also returns []");
});

test("parallel-tools.jsonl: one message_end with two toolCalls, then two tool executions", () => {
  const { canonical } = fold(opencodeCaptures.parallelTools);
  const seq = types(canonical);
  const firstMessage = seq.indexOf("message_end");
  assert.deepEqual(
    seq.slice(firstMessage, firstMessage + 5),
    ["message_end", "tool_execution_start", "tool_execution_end", "tool_execution_start", "tool_execution_end"],
    "one message then both executions",
  );
  const message = JSON.parse(canonical[firstMessage]!).message as { content: { type: string; name: string }[] };
  assert.deepEqual(
    message.content.filter((c) => c.type === "toolCall").map((c) => c.name),
    ["read", "bash"],
    "two toolCall blocks in the message",
  );
});

test("oversized-output.jsonl: the bash call carries the canonical command seq 1 200000", () => {
  const { canonical } = fold(opencodeCaptures.oversizedOutput);
  const start = canonical.map((l) => JSON.parse(l)).find((l) => l.type === "tool_execution_start") as {
    toolName: string;
    args: { command: string };
  };
  assert.equal(start.toolName, "bash");
  assert.equal(start.args.command, "seq 1 200000", "suite-rerun detection reads the command");
});

test("mcp-notes-end-of-run.jsonl: the role-notes tool follows the run's reads and bash calls", () => {
  const { canonical } = fold(opencodeCaptures.mcpNotesEndOfRun);
  const tools = canonical
    .filter((l) => JSON.parse(l).type === "tool_execution_start")
    .map((l) => (JSON.parse(l) as { toolName: string }).toolName);
  assert.deepEqual(tools, ["glob", "bash", "read", "tumwater_role_notes"], "read and bash come before the end-of-run note");
  assert.equal(tools[tools.length - 1], "tumwater_role_notes", "the note is saved at the run's end, past the first-request MCP gap");
});

test("both free-tier refusals fold to transientBackend and warn opencode_free_tier_refused once", () => {
  for (const capture of [opencodeCaptures.freeTierRefused, opencodeCaptures.freeTierRefusedReadDenied]) {
    const { parser, translator } = fold(capture);
    assert.equal(parser.transientBackend, true, "the 403 provider.auth folds to a transient backend");
    assert.equal(parser.backendFailureKind, "server");
    assert.deepEqual(
      translator.warnings().filter((w) => w === "opencode_free_tier_refused"),
      ["opencode_free_tier_refused"],
      "warned exactly once",
    );
  }
});

test("a provider.auth that is NOT a 403 folds to configError, not the free tier", () => {
  // All real captures are 403 {type: provider.auth, status 403} refusals, so the typed guard's
  // OTHER cluster — a 401 bad-credential auth failure — would slip through the old over-broad
  // "any provider.auth → free tier" condition untested. A provider.auth WITH a non-403 status
  // is a config error (the 401 row), not a transient free-tier refusal.
  const badCredential = fold([
    JSON.stringify({
      type: "error",
      sessionID: "ses_1",
      error: { type: "provider.auth", message: "Invalid API key (status 401)", status: 401 },
    }),
  ]);
  assert.equal(badCredential.parser.configError, true, "a 401 provider.auth is a config error");
  assert.equal(badCredential.parser.transientBackend, false, "not a transient backend");
  assert.ok(
    !badCredential.translator.warnings().includes("opencode_free_tier_refused"),
    "a 401 auth failure is not a free-tier refusal",
  );
  // The 403 twin (the real capture) still folds to the free-tier transient backend, so the two
  // statuses stay distinct.
  const refused = fold(opencodeCaptures.freeTierRefused);
  assert.equal(refused.parser.transientBackend, true, "the 403 provider.auth stays a free-tier refusal");
});

test("unknown-model, unavailable-variant and malformed-session-id fold to configError", () => {
  for (const capture of [
    opencodeCaptures.unknownModel,
    opencodeCaptures.unavailableVariant,
    opencodeCaptures.malformedSessionId,
  ]) {
    const { parser } = fold(capture);
    assert.equal(parser.configError, true, "a provider.no-route / unknown model id is a config error");
  }
  // malformed-session-id is the one raised before any session exists (`sessionID: ""`), so it
  // alone emits no session or agent_start; the other two carry a real session id and announce it.
  const preSession = fold(opencodeCaptures.malformedSessionId);
  assert.equal(
    types(preSession.canonical).every((t) => t === "message_end"),
    true,
    "no session or agent_start before one exists",
  );
});

test("the synthetic 429 folds to transientRateLimit with the echoed Retry-After hint", () => {
  const { parser } = fold([opencodeRateLimit()]);
  assert.equal(parser.transientRateLimit, true);
  assert.equal(parser.retryAfterSeconds, 30);
});

test("synthetic 5xx folds to transientBackend/server and context overflow to contextExceeded", () => {
  const server = fold([opencodeServerError()]);
  assert.equal(server.parser.transientBackend, true);
  assert.equal(server.parser.backendFailureKind, "server");
  const ctx = fold([opencodeContextOverflow()]);
  assert.equal(ctx.parser.contextExceeded, true);
});

test("a tool_use with status error closes its execution as isError", () => {
  const { canonical } = fold([
    JSON.stringify({
      type: "step_start",
      sessionID: "ses_1",
      part: { type: "step-start" },
    }),
    JSON.stringify({
      type: "tool_use",
      sessionID: "ses_1",
      part: { type: "tool", id: "t1", tool: "shell", state: { status: "error", input: { command: "ls" }, error: "boom" } },
    }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_1",
      part: { type: "step-finish", cost: 0, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } },
    }),
  ]);
  const end = JSON.parse(canonical.find((l) => JSON.parse(l).type === "tool_execution_end")!) as { isError: boolean };
  assert.equal(end.isError, true, "a failed call closes errored");
});

test("patch maps to edit and native input.path is preserved", () => {
  const { canonical } = fold([
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    JSON.stringify({
      type: "tool_use",
      sessionID: "ses_1",
      part: { type: "tool", id: "t1", tool: "patch", state: { status: "completed", input: { path: "/x" } } },
    }),
  ]);
  const start = JSON.parse(canonical.find((l) => JSON.parse(l).type === "tool_execution_start")!) as {
    toolName: string;
    args: Record<string, unknown>;
  };
  assert.equal(start.toolName, "edit", "patch→edit");
  assert.equal(start.args.path, "/x", "native input.path is preserved");
});

test("an unknown event type is warned once however often it appears, and a malformed line once", () => {
  const translator = opencodeTranslator({ cwd: "/work" });
  translator.translate(JSON.stringify({ type: "weird", sessionID: "ses_1", part: { type: "weird" } }));
  translator.translate(JSON.stringify({ type: "weird", sessionID: "ses_1", part: { type: "weird" } }));
  translator.translate(JSON.stringify({ type: "archive", sessionID: "ses_1", part: { type: "archive" } }));
  assert.deepEqual(translator.warnings(), ["weird", "archive"], "each first-seen once, in order");

  const malformed = opencodeTranslator({ cwd: "/work" });
  const out = [
    ...malformed.translate(opencodeMalformed("one")),
    ...malformed.translate(opencodeMalformed("two")),
  ];
  assert.ok(out.every((l) => JSON.parse(l).type !== "message_end"), "no canonical event from a malformed line");
  assert.deepEqual(malformed.warnings(), ["malformed"], "one warning for both malformed lines");
});

test("finalize() flushes a cut-off mid-step buffer as a message_end without usage", () => {
  const translator = opencodeTranslator({ cwd: "/work" });
  const parser = new PiStreamParser();
  for (const line of translator.translate(
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
  ))
    parser.feed(line + "\n");
  for (const line of translator.translate(JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "half a thought" } })))
    parser.feed(line + "\n");
  const flushed = translator.finalize();
  for (const line of flushed) parser.feed(line + "\n");
  assert.deepEqual(types(flushed), ["message_end"], "one flushed message_end");
  const message = JSON.parse(flushed[0]!).message as { role: string; content: { text: string }[]; usage?: unknown };
  assert.deepEqual(
    message.content.map((c) => c.text),
    ["half a thought"],
    "the buffered blocks are preserved",
  );
  assert.equal(message.usage, undefined, "a cut-off step carries no usage");
  assert.equal(parser.turns, 1);
  assert.equal(parser.outputTokens, 0);
});
