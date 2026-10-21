// The codex native-to-canonical translator (plans/codex-backend.md "The stream translator and
// the rollout read that completes it", PLANS.md "Codex backend, part 6/9"). Capture lines go
// straight into the translator; the canonical lines it emits go straight into PiStreamParser,
// so these tests exercise the whole translation contract without a spawned process or a
// registered backend.
import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser } from "../src/pi/pi-stream.js";
import { codexTranslator, type CodexStreamTranslator } from "../src/agent/codex/codex-stream.js";
import {
  codexCaptures,
  codexContextWindow400,
  codexItem,
  codexUsedUpWindow,
} from "./fixtures/codex-events.js";

/** Translate native lines, then fold the canonical ones through the parser. */
function fold(lines: string[]): {
  parser: PiStreamParser;
  translator: CodexStreamTranslator;
  canonical: string[];
} {
  const translator = codexTranslator();
  const parser = new PiStreamParser();
  const canonical: string[] = [];
  for (const line of lines) canonical.push(...translator.translate(line));
  for (const line of canonical) parser.feed(line + "\n");
  return { parser, translator, canonical };
}

const parsed = (lines: string[]): Array<Record<string, unknown>> => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const types = (lines: string[]): string[] => parsed(lines).map((e) => e.type as string);

/** The message_end lines, keyed by toolCall name ("" for a text-only message). */
function toolCalls(lines: string[]): Map<string, Array<Record<string, unknown>>> {
  const byName = new Map<string, Array<Record<string, unknown>>>();
  for (const e of parsed(lines)) {
    if (e.type !== "message_end") continue;
    const content = (e.message as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined;
    for (const block of content ?? []) {
      if (block.type !== "toolCall") continue;
      const name = block.name as string;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(block);
    }
  }
  return byName;
}

test("edit-run.jsonl yields a session, an agent start, an edit and a bash tool call", () => {
  const { parser, canonical } = fold(codexCaptures.editRun);
  const t = types(canonical);
  assert.ok(t.includes("session"), "a thread.started becomes a session");
  assert.ok(t.includes("agent_start"), "and an agent start");
  const calls = toolCalls(canonical);
  const edits = calls.get("edit") ?? [];
  assert.equal(edits.length, 1, "one edit call");
  assert.deepEqual(edits[0]!.arguments, { path: "/work/repo/a.txt", kind: "update" }, "the edit names the changed path and kind");
  assert.ok(types(canonical).includes("tool_execution_start"), "the edit opens a call");
  const editStart = parsed(canonical).find((e) => e.type === "tool_execution_start" && e.toolName === "edit")!;
  assert.equal(editStart.toolCallId, "item_1-0", "the edit call is keyed by its item");
  const editEnd = parsed(canonical).find((e) => e.type === "tool_execution_end" && e.toolCallId === "item_1-0")!;
  assert.equal(editEnd.isError, false, "a completed file_change is not an error");

  const bashes = calls.get("bash") ?? [];
  assert.equal(bashes.length, 1, "one bash call");
  assert.equal((bashes[0]!.arguments as Record<string, unknown>).command, "cat a.txt && git status --short", "the wrapper and quoting are removed");
  const bashStart = parsed(canonical).find((e) => e.type === "tool_execution_start" && e.toolName === "bash")!;
  assert.equal(bashStart.toolCallId, "item_2", "the bash call is keyed by its item");
  const bashEnd = parsed(canonical).find((e) => e.type === "tool_execution_end" && e.toolCallId === "item_2")!;
  assert.equal(bashEnd.isError, false, "exit code 0 is not an error");
  assert.equal(bashEnd.result, "HELLO\n M a.txt\n?? done.txt\n", "the aggregated output rides the end");

  // Fed through PiStreamParser, the final text is the last agent message.
  assert.equal(parser.finalText, "apply_patch, clock__curr_time, exec_command, list_mcp_resource_templates, list_mcp_resources, read_mcp_resource, view_image, write_stdin\n\nDONE");
});

test("the session carries the factory's cwd and a clean run warns nothing abandoned", () => {
  const translator = codexTranslator({ cwd: "/work/repo" });
  const out = [...translator.translate(codexCaptures.editRun[0]!)]; // thread.started
  const session = parsed(out).find((e) => e.type === "session")!;
  assert.equal(session.id, "01a15c9d-6762-7931-814e-a3e6e64c1b51");
  assert.equal(session.cwd, "/work/repo", "the session carries the factory's cwd");

  // A clean, fully completed run never reports an abandoned command.
  const { translator: clean } = fold(codexCaptures.editRun);
  assert.ok(!clean.warnings().includes("codex_command_abandoned"), "a clean run warns nothing abandoned");
});

test("oversized-output.jsonl and a genuinely oversized result are capped at the bash limit", () => {
  // The capture's own output is already cut to ~4,000 chars (finding 18), so it passes through.
  const { canonical } = fold(codexCaptures.oversizedOutput);
  const end = parsed(canonical).find((e) => e.type === "tool_execution_end")!;
  const result = end.result as string;
  assert.ok(result.length <= 16_000, "the aggregated output is at most the bash cap plus the marker");
  assert.ok(result.startsWith("1\n"), "the first line survives");
  assert.ok(result.endsWith("200000\n"), "the last line survives");

  // The cap really engages on a megabyte: head and tail around a marker naming the cut.
  const huge = "AAA\n" + "x".repeat(500_000) + "\nZZZ\n";
  const translator = codexTranslator();
  const out = [
    ...translator.translate(JSON.stringify({ type: "item.started", item: { id: "c0", type: "command_execution", command: "cat big.txt" } })),
    ...translator.translate(
      JSON.stringify({ type: "item.completed", item: { id: "c0", type: "command_execution", command: "cat big.txt", aggregated_output: huge, exit_code: 0, status: "completed" } }),
    ),
  ];
  const bigEnd = parsed(out).find((e) => e.type === "tool_execution_end")!.result as string;
  assert.ok(bigEnd.length <= 16_000, "a megabyte is bounded to the bash cap");
  assert.ok(bigEnd.includes("truncated"), "the marker names the cut");
  assert.ok(bigEnd.endsWith("ZZZ\n"), "the real last line survives the bound");
});

test("abandoned-command.jsonl closes the open sleep as an error and warns once", () => {
  const { translator, canonical } = fold(codexCaptures.abandonedCommand);
  const ends = parsed(canonical).filter((e) => e.type === "tool_execution_end");
  assert.equal(ends.length, 1, "one tool end for the abandoned command");
  assert.equal(ends[0]!.toolCallId, "item_0");
  assert.equal(ends[0]!.isError, true, "the abandoned command is closed as an error");
  assert.equal(ends[0]!.result, "abandoned: the run ended while this command was still running");
  const abandoned = translator.warnings().filter((w) => w === "codex_command_abandoned");
  assert.equal(abandoned.length, 1, "codex_command_abandoned is warned once");
});

test("long-command.jsonl closes the run-long call with exit code 0", () => {
  const { canonical } = fold(codexCaptures.longCommand);
  const end = parsed(canonical).find((e) => e.type === "tool_execution_end" && e.toolCallId === "item_0")!;
  assert.equal(end.isError, false, "the ten-minute command's completed item is not an error");
  assert.equal(end.result, '', "an empty aggregated output stays empty");
});

test("sessionId() is undefined before thread.started and the thread id after", () => {
  const translator = codexTranslator();
  translator.translate(JSON.stringify({ type: "turn.started" }));
  assert.equal(translator.sessionId(), undefined, "no session before the thread names it");
  translator.translate(codexCaptures.editRun[0]!); // thread.started
  assert.equal(translator.sessionId(), "01a15c9d-6762-7931-814e-a3e6e64c1b51");
  assert.equal(translator.turnCompletedUsage(), undefined, "no usage before turn.completed");
});

test("unknown-model.jsonl classifies as configError", () => {
  const { parser } = fold(codexCaptures.unknownModel);
  assert.equal(parser.configError, true);
  assert.equal(parser.contextExceeded, false);
});

test("not-logged-in.jsonl classifies as configError with a reconnect event per retry", () => {
  const { parser, canonical } = fold(codexCaptures.notLoggedIn);
  assert.equal(parser.configError, true, "the 401 is a permanent config error");
  const reconnects = types(canonical).filter((t) => t === "auto_retry_start");
  // The capture holds nine "Reconnecting... n/5" top-level error lines (four over WebSocket,
  // five over HTTPS after the transport fallback); each becomes one canonical auto_retry_start.
  assert.equal(reconnects.length, 9, "one auto_retry_start per reconnect line");
});

test("a used-up usage window classifies as transientRateLimit with a rejected five_hour reading", () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 600;
  const { parser } = fold([codexUsedUpWindow(resetsAt)]);
  assert.equal(parser.transientRateLimit, true, "usage_limit_reached is a transient rate limit");
  const window = parser.rateWindows.find((w) => w.type === "five_hour");
  assert.equal(window?.status, "rejected", "the window it names is rejected");
  assert.ok(
    (parser.retryAfterSeconds ?? 0) > 590 && (parser.retryAfterSeconds ?? 0) <= 600,
    "retryAfterSeconds is derived from resets_at",
  );
});

test("a 400 invalid_request_error naming the context window is contextExceeded, not configError", () => {
  // By its code.
  const byCode = fold([codexContextWindow400({ code: "context_window_exceeded" })]);
  assert.equal(byCode.parser.contextExceeded, true);
  assert.equal(byCode.parser.configError, false);
  // By its message, when the code does not name the window.
  const byMessage = fold([codexContextWindow400({ code: "invalid_request_error", message: "prompt is too long for the context window" })]);
  assert.equal(byMessage.parser.contextExceeded, true);
  assert.equal(byMessage.parser.configError, false, "the context signal wins over the generic 400");
});

test("todo_list and web_search items are dropped silently with nothing in warnings", () => {
  const translator = codexTranslator();
  const out = [
    ...translator.translate(codexItem("started", { id: "t1", type: "todo_list" })),
    ...translator.translate(codexItem("completed", { id: "t1", type: "todo_list" })),
    ...translator.translate(codexItem("started", { id: "w1", type: "web_search" })),
    ...translator.translate(codexItem("completed", { id: "w1", type: "web_search" })),
  ];
  assert.deepEqual(out, [], "no canonical events for a dropped item type");
  assert.ok(!translator.warnings().some((w) => w.includes("todo_list") || w.includes("web_search")), "nothing is added to warnings");
});

test("sigterm-mid-command.jsonl finalizes to an error message", () => {
  const translator = codexTranslator();
  const parser = new PiStreamParser();
  for (const line of codexCaptures.sigtermMidCommand) {
    for (const canonical of translator.translate(line)) parser.feed(canonical + "\n");
  }
  const finals = translator.finalize();
  assert.equal(finals.length, 1, "finalize emits one error line");
  const end = JSON.parse(finals[0]!) as Record<string, unknown>;
  assert.equal((end.message as Record<string, unknown>).stopReason, "error");
  assert.equal((end.message as Record<string, unknown>).errorMessage, "codex exited without finishing its turn");
  for (const canonical of finals) parser.feed(canonical + "\n");
  assert.equal(parser.errorMessage, "codex exited without finishing its turn");
});

test("an unknown item type is listed once in warnings", () => {
  const translator = codexTranslator();
  for (const mode of ["started", "completed"] as const) {
    translator.translate(codexItem(mode, { id: "s1", type: "spawn_agent" }));
  }
  translator.translate(codexItem("started", { id: "s2", type: "spawn_agent" }));
  assert.deepEqual(
    translator.warnings().filter((w) => w === "item:spawn_agent"),
    ["item:spawn_agent"],
    "an unknown item type is warned exactly once",
  );
});

test("turnCompletedUsage() reports the stream's own figure", () => {
  const translator = codexTranslator();
  for (const line of codexCaptures.editRun) {
    translator.translate(line);
  }
  assert.deepEqual(translator.turnCompletedUsage(), {
    input: 32957,
    cacheRead: 15872,
    cacheWrite: 0,
    output: 298,
  });
  assert.ok(!translator.warnings().includes("codex_usage_partial"), "no usage-partial warning by default");
  translator.flagUsagePartial();
  assert.ok(translator.warnings().includes("codex_usage_partial"), "flagUsagePartial adds the warning");
});
