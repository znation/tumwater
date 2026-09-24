import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser } from "../src/pi-stream.js";
import { assistantLine } from "./util.js";

/** Focused unit coverage for the pi stdout parser's edge shapes — the branches pi.test.ts's
 * end-to-end runs do not reach. The module exists so this parsing can be exercised without a
 * subprocess (see its header), so these live apart from the process-level pi tests. */

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
