import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./repo-fixtures.js";
import {
  ELIDED_PREFIX,
  SHAKE_MAX_PERCENT,
  SHAKE_MIN_CHARS,
  SHAKE_PERCENT,
  SHAKE_PROTECTED_TOKENS,
  estimateTokens,
  shakeMessages,
  shakeNote,
  shakePlan,
  type FullOutputWriter,
  type ShakeEdit,
  type ShakeMessage,
  type ShakePlan,
  type ShakeUsage,
  default as contextShake,
} from "../src/pi-extension/context-shake.js";

// The bundled context-shake extension (src/pi-extension/context-shake.ts): at 70% of the
// window it replaces old bulky read/bash results with short pointers, so a small-window
// fallback model can finish instead of being summarized. The planner is pure; the adapter
// maps pi's turn_end context onto it.

const big = (chars: number): string => "x".repeat(chars);

/** A bash result bulky enough to be a candidate, with a recoverable full-output path. */
function bash(id: string, chars = 60_000, over: Partial<ShakeMessage> = {}): ShakeMessage {
  return {
    entryId: id,
    role: "toolResult",
    toolName: "bash",
    text: big(chars),
    fullOutputPath: `/tmp/${id}.log`,
    ...over,
  };
}

/** A filler message that pushes older messages outside the protected newest-tokens slice. */
function filler(tokens: number): ShakeMessage {
  return { role: "user", text: big(tokens * 4) };
}

/** Five equal fillers whose tokens sum to the protected newest-token slice. Put one after a
 * result to push it outside `SHAKE_PROTECTED_TOKENS`, the newest prefix the planner keeps. */
function protectedFillers(): ShakeMessage[] {
  return Array.from({ length: 5 }, () => filler(SHAKE_PROTECTED_TOKENS / 5));
}

const atPercent = (percent: number): ShakeUsage => ({ tokens: percent * 1000, contextWindow: 100_000, percent });

test("shakePlan stays empty below the first crossing", () => {
  const messages = [bash("a"), ...protectedFillers()];
  assert.equal(shakePlan(messages, atPercent(SHAKE_PERCENT - 1)).edits.length, 0);
  assert.equal(shakePlan(messages, { tokens: null, contextWindow: 0, percent: null }).edits.length, 0);
  assert.equal(shakePlan(messages, {}).edits.length, 0);
});

test("shakePlan elides the old bulky result and leaves the newest slice alone", () => {
  // Five 4k-token fillers (the whole protected slice) sit between the two results, so only the
  // older one is outside the newest 20k tokens.
  const messages = [bash("old"), ...protectedFillers(), bash("new")];
  const plan: ShakePlan = shakePlan(messages, atPercent(70));
  assert.deepEqual(plan.edits.map((e) => e.targetId), ["old"]);
  assert.equal(plan.elidedCount, 1);
  assert.ok(plan.reclaimedTokens >= 10_000);
  const edit: ShakeEdit = plan.edits[0]!;
  assert.match(edit.replacement, /^\[elided by tumwater: 60000 chars; full output in \/tmp\/old\.log\]$/);
});

test("shakePlan never selects edit, write, error, user or assistant messages", () => {
  for (const over of [
    { toolName: "edit" },
    { toolName: "write" },
    { toolName: "bash", isError: true },
    { role: "user", toolName: "bash" },
    { role: "assistant", toolName: "bash" },
  ] satisfies Array<Partial<ShakeMessage>>) {
    const messages = [bash("skip", 60_000, over), ...protectedFillers()];
    assert.equal(shakePlan(messages, atPercent(70)).edits.length, 0, JSON.stringify(over));
  }
});

test("shakePlan leaves short and already-elided results alone", () => {
  const short = [bash("short", SHAKE_MIN_CHARS - 500), ...protectedFillers()];
  assert.equal(shakePlan(short, atPercent(70)).edits.length, 0);
  const elided = [bash("again", 60_000, { text: `${ELIDED_PREFIX} 9 chars; full output in /tmp/x}` }), ...protectedFillers()];
  assert.equal(shakePlan(elided, atPercent(70)).edits.length, 0);
});

test("shakePlan leaves a long already-elided result alone instead of re-eliding it", () => {
  // The case above stops at the size floor, so it never reaches the startsWith(ELIDED_PREFIX)
  // guard. A pointer long enough to clear SHAKE_MIN_CHARS is the shape a bash result takes
  // once its full text is appended, and a second pass must still skip it: without the guard
  // the planner would replace a pointer with another pointer. The text is long enough that
  // the unguarded path would clear SHAKE_MIN_RECLAIM_TOKENS on its own, so the empty plan
  // below pins the guard rather than the recovery floor.
  const pointer = `${ELIDED_PREFIX} 60000 chars; full output in /tmp/old.log] ${big(60_000)}`;
  const messages = [bash("again", 0, { text: pointer }), ...protectedFillers()];
  assert.ok(pointer.length > SHAKE_MIN_CHARS);
  assert.ok(estimateTokens(pointer) > 10_000);
  assert.equal(shakePlan(messages, atPercent(70)).edits.length, 0);
});

test("shakePlan is empty when the whole pass would reclaim under the floor", () => {
  // ~5k tokens of result is below SHAKE_MIN_RECLAIM_TOKENS once the pointer is subtracted.
  const messages = [bash("small", 20_000), ...protectedFillers()];
  assert.equal(shakePlan(messages, atPercent(70)).edits.length, 0);
});

test("a bash result without a pi full-output path gets one written", () => {
  const messages = [bash("a", 60_000, { fullOutputPath: undefined, toolCallId: "t9" }), ...protectedFillers()];
  const calls: Array<[string, string | undefined]> = [];
  const writer: FullOutputWriter = (text, id) => {
    calls.push([text, id]);
    return "/tmp/written.log";
  };
  const plan = shakePlan(messages, atPercent(70), writer);
  assert.deepEqual(calls, [[big(60_000), "t9"]]);
  assert.equal(plan.edits.length, 1);
  assert.match(plan.edits[0]!.replacement, /full output in \/tmp\/written\.log\]/);
});

test("a bash result with no recoverable path is kept rather than lost", () => {
  const messages = [bash("a", 60_000, { fullOutputPath: undefined }), ...protectedFillers()];
  assert.equal(shakePlan(messages, atPercent(70)).edits.length, 0);
  assert.equal(shakePlan(messages, atPercent(70), () => null).edits.length, 0);
});

test("a read pointer without a path or offset names the file from line 1", () => {
  const read: ShakeMessage = { entryId: "r", role: "toolResult", toolName: "read", text: big(60_000) };
  const messages = [read, ...protectedFillers()];
  const plan = shakePlan(messages, atPercent(70));
  assert.equal(plan.edits.length, 1);
  assert.match(plan.edits[0]!.replacement, /60000 chars of the file:1-1; re-read the range/);
});

test("a read pointer counts the lines of a multi-line result", () => {
  // Two lines: offset 10 starts the range at 10 and ends it at 11.
  const read: ShakeMessage = {
    entryId: "r",
    role: "toolResult",
    toolName: "read",
    text: `${big(30_000)}\n${big(30_000)}`,
    readInput: { path: "src/big.ts", offset: 10 },
  };
  const messages = [read, ...protectedFillers()];
  const plan = shakePlan(messages, atPercent(70));
  assert.equal(plan.edits.length, 1);
  assert.match(plan.edits[0]!.replacement, /src\/big\.ts:10-11; re-read the range/);
});

test("a read pointer names the file and the range it elided", () => {
  const read: ShakeMessage = {
    entryId: "r",
    role: "toolResult",
    toolName: "read",
    text: big(60_000),
    readInput: { path: "src/big.ts", offset: 100, limit: 50 },
  };
  const messages = [read, ...protectedFillers()];
  const plan = shakePlan(messages, atPercent(70));
  assert.equal(plan.edits.length, 1);
  // No newlines in the filler text: one line, so the range is the offset alone.
  assert.match(plan.edits[0]!.replacement, /60000 chars of src\/big\.ts:100-100; re-read the range/);
});

test("percentOf falls back to tokens/contextWindow when pi gives no percent", () => {
  const messages = [bash("a"), ...protectedFillers()];
  // 70k/100k is exactly the first crossing; just under it and an unknowable window both plan
  // nothing.
  assert.equal(shakePlan(messages, { tokens: 70_000, contextWindow: 100_000 }).edits.length, 1);
  assert.equal(shakePlan(messages, { tokens: 69_999, contextWindow: 100_000 }).edits.length, 0);
  assert.equal(shakePlan(messages, { tokens: 70_000, contextWindow: 0 }).edits.length, 0);
});

test("shakePlan skips a bulky result with no session entry to edit", () => {
  const messages = [bash("a", 60_000, { entryId: undefined }), ...protectedFillers()];
  assert.equal(shakePlan(messages, atPercent(70)).edits.length, 0);
});

test("a fleet-sized context on the 1M primary plans nothing", () => {
  const messages = [bash("a"), ...protectedFillers()];
  const plan = shakePlan(messages, { tokens: 140_000, contextWindow: 1_048_575, percent: (140_000 / 1_048_575) * 100 });
  assert.equal(plan.edits.length, 0);
});

test("estimateTokens and the summary note are monotonic and compact", () => {
  assert.equal(estimateTokens("x".repeat(4_000)), 1_000);
  assert.ok(estimateTokens("x".repeat(8_000)) > estimateTokens("x".repeat(4_000)));
  assert.match(shakeNote(2, 12_300), /elided 2 old tool results \(~12\.3k tokens\)/);
});

// ---- adapter ----------------------------------------------------------------

interface CapturedHandlers {
  turn_end?: (event: object, ctx?: object) => unknown;
  tool_result?: (event: object, ctx?: object) => unknown;
}

function capture(): CapturedHandlers {
  const handlers: CapturedHandlers = {};
  contextShake({
    on: (event: string, handler: (event: object, ctx?: object) => unknown) => {
      handlers[event as keyof CapturedHandlers] = handler;
    },
  } as never);
  return handlers;
}

/** A turn_end event whose projected context holds one old readable result plus enough newer
 * filler to push it outside the protected slice. */
function turnEndEvent(): object {
  const fillerEntry = (i: number) => ({ sourceEntry: { id: `f${i}` }, messages: [{ role: "user", content: [{ type: "text", text: big(16_000) }] }] });
  return {
    context: {
      contextEntries: [
        {
          sourceEntry: { id: "call" },
          messages: [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/big.ts", offset: 7 } }] }],
        },
        {
          sourceEntry: { id: "r" },
          messages: [{ role: "toolResult", toolName: "read", toolCallId: "t1", isError: false, content: [{ type: "text", text: big(60_000) }] }],
        },
        ...[0, 1, 2, 3, 4].map(fillerEntry),
      ],
    },
  };
}

/** Mirror pi 1.0.0's `appendContextEdit` validation: a replacement is accepted only when it is
 * null or an object holding a string/array `content`. A bare string throws, and the boundary
 * discards the whole batch with it, so asserting the shape here is what keeps the adapter's
 * edits from silently vanishing. */
function assertPiReplacement(replacement: unknown): void {
  assert.ok(replacement === null || typeof replacement === "object", "replacement is null or an object");
  if (replacement === null) return;
  assert.ok("content" in replacement, "replacement has a content field");
  const content = (replacement as { content: unknown }).content;
  assert.ok(typeof content === "string" || Array.isArray(content), "content is a string or array");
}

test("shakeMessages maps a read result's input onto its pointer", () => {
  const messages = shakeMessages(turnEndEvent());
  const read = messages.find((m) => m.toolName === "read");
  assert.equal(read?.entryId, "r");
  assert.deepEqual(read?.readInput, { path: "src/big.ts", offset: 7, limit: undefined });
});

test("shakeMessages carries a bash result's full-output path from details", () => {
  const messages = shakeMessages({
    context: {
      contextEntries: [
        {
          sourceEntry: { id: "b" },
          messages: [
            { role: "toolResult", toolName: "bash", toolCallId: "t2", isError: false, details: { fullOutputPath: "/tmp/b.log" }, content: [{ type: "text", text: "out" }] },
          ],
        },
      ],
    },
  });
  assert.equal(messages[0]!.fullOutputPath, "/tmp/b.log");
  assert.equal(messages[0]!.toolName, "bash");
  assert.equal(messages[0]!.entryId, "b");
});

test("shakeMessages tolerates a tool result with no tool call id", () => {
  // A toolResult pi did not pair with an assistant call carries no toolCallId; the message
  // map must leave that field unset and skip the call lookup rather than reading a call for
  // an id it does not have. With no paired read call there is no readInput to attach.
  const messages = shakeMessages({
    context: {
      contextEntries: [
        { sourceEntry: { id: "r" }, messages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "body" }] }] },
      ],
    },
  });
  assert.equal(messages[0]!.toolCallId, undefined);
  assert.equal(messages[0]!.readInput, undefined);
  assert.equal(messages[0]!.text, "body");
});

test("shakeMessages tolerates entries without ids, missing messages, and non-array content", () => {
  const messages = shakeMessages({
    context: {
      contextEntries: [
        { sourceEntry: {}, messages: [{ role: "assistant", content: "not-array" }, { content: "no role either" }] },
        { sourceEntry: { id: "r" }, messages: [{ role: "toolResult", toolName: "read", toolCallId: "t1", content: [{ type: "text", text: big(60_000) }] }] },
        {},
      ],
    },
  });
  assert.equal(messages.length, 3, "an entry with no messages contributes nothing");
  assert.equal(messages[0]!.entryId, undefined, "a missing sourceEntry id leaves the message uneditable");
  assert.equal(messages[0]!.role, "assistant");
  assert.equal(messages[0]!.text, "", "a string content is not a text array");
  assert.equal(messages[1]!.role, undefined);
  assert.equal(messages[1]!.text, "");
  // The assistant content was not an array, so no tool call was recorded and the read result
  // carries no readInput.
  assert.equal(messages[2]!.readInput, undefined);
});

test("the adapter shakes once at 70%, again at 85%, and notes the next tool result", () => {
  const handlers = capture();
  assert.ok(handlers.turn_end && handlers.tool_result);
  const event = turnEndEvent();
  const ctx = (percent: number) => ({ getContextUsage: () => ({ tokens: percent * 1_000, contextWindow: 100_000, percent }) });

  assert.equal(handlers.turn_end(event, ctx(60)), undefined, "below 70% nothing happens");

  const first = handlers.turn_end(event, ctx(72)) as { entries: Array<{ type: string; targetId?: string; replacement?: unknown }> } | undefined;
  assert.ok(first, "the 70% crossing shakes");
  assert.deepEqual(first.entries.map((e) => e.type), ["context_edit"]);
  assert.equal(first.entries[0]!.targetId, "r");
  assertPiReplacement(first.entries[0]!.replacement);
  assert.match((first.entries[0]!.replacement as { content: string }).content, /60000 chars of src\/big\.ts:7-7; re-read the range/);
  assert.equal(handlers.turn_end(event, ctx(72)), undefined, "one pass per crossing");

  const result = handlers.tool_result({ content: [{ type: "text", text: "file body" }] }) as { content: Array<{ text: string }> };
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0]!.text, "file body");
  assert.match(result.content[1]!.text, /elided 1 old tool results/);
  assert.equal(handlers.tool_result({ content: [] }), undefined, "the note rides exactly one result");

  // A run that climbs back to 85% despite the first pass gets a second one.
  assert.ok(handlers.turn_end(event, ctx(SHAKE_MAX_PERCENT + 1)), "the 85% crossing shakes again");
  assert.equal(handlers.turn_end(event, ctx(SHAKE_MAX_PERCENT + 1)), undefined, "and only once");
});

test("the adapter tolerates missing usage and an empty context", () => {
  const handlers = capture();
  assert.equal(handlers.turn_end!({}), undefined);
  assert.equal(handlers.turn_end!({}, { getContextUsage: () => undefined }), undefined);
  assert.equal(handlers.turn_end!({}, { getContextUsage: () => { throw new Error("no session"); } }), undefined);
  assert.equal(handlers.turn_end!({ context: {} }, { getContextUsage: () => atPercent(90) }), undefined);
  // Usage pi could not reduce to a percentage (no percent, no usable window) is a no-op, not
  // a shake with an unknown fill.
  assert.equal(handlers.turn_end!({}, { getContextUsage: () => ({ tokens: 0, contextWindow: 0, percent: null }) }), undefined);
});

test("a read pointer clamps a non-positive or missing offset to line 1", () => {
  // `replacementFor`'s guard is `typeof offset === "number" && offset > 0`: an offset of 0 or
  // below is a number that never starts a range, so the pointer must say line 1 — the same as
  // a read input that names only the file — rather than "big.ts:0-0".
  for (const readInput of [{ path: "src/big.ts", offset: 0 }, { path: "src/big.ts", offset: -5 }, { path: "src/big.ts" }]) {
    const read: ShakeMessage = {
      entryId: "r",
      role: "toolResult",
      toolName: "read",
      text: big(60_000),
      readInput,
    };
    const messages = [read, ...protectedFillers()];
    const plan = shakePlan(messages, atPercent(70));
    assert.equal(plan.edits.length, 1);
    assert.match(plan.edits[0]!.replacement, /src\/big\.ts:1-1; re-read the range/, JSON.stringify(readInput));
  }
});

test("shakePlan tolerates a message with no text", () => {
  // `messages[i]?.text ?? ""` guards a projected context whose message flattened to no text
  // (an empty or unrecognized content shape): the token estimate must treat it as empty
  // rather than throwing on an undefined string.
  const messages = [bash("a"), { role: "user" } as ShakeMessage, ...protectedFillers()];
  assert.equal(shakePlan(messages, atPercent(70)).edits.length, 1);
});

test("shakePlan plans nothing for an empty message list", () => {
  assert.deepEqual(shakePlan([], atPercent(70)), { edits: [], reclaimedTokens: 0, elidedCount: 0 });
});

test("a result exactly at the size floor is skipped while an over-floor companion is elided", () => {
  // SHAKE_MIN_CHARS is inclusive: `text.length <= SHAKE_MIN_CHARS` skips the boundary itself.
  // The 60k-char companion clears SHAKE_MIN_RECLAIM_TOKENS on its own, so the plan is not empty
  // for an unrelated reason and the boundary is observable: under an exclusive `<` the 2,000-char
  // result would join the edits, changing the target list below.
  const messages = [bash("edge", SHAKE_MIN_CHARS), bash("big", 60_000), ...protectedFillers()];
  const plan = shakePlan(messages, atPercent(70));
  assert.deepEqual(plan.edits.map((e) => e.targetId), ["big"]);
});

test("shakeMessages leaves fullOutputPath unset when details carry no path", () => {
  const messages = shakeMessages({
    context: {
      contextEntries: [
        { sourceEntry: { id: "empty" }, messages: [{ role: "toolResult", toolName: "bash", toolCallId: "t1", details: {}, content: [{ type: "text", text: "out" }] }] },
        { sourceEntry: { id: "absent" }, messages: [{ role: "toolResult", toolName: "bash", toolCallId: "t2", content: [{ type: "text", text: "out" }] }] },
      ],
    },
  });
  assert.equal(messages[0]!.fullOutputPath, undefined);
  assert.equal(messages[1]!.fullOutputPath, undefined);
});

test("shakeMessages joins only the text parts of a mixed content array", () => {
  // A content array can interleave text with images, bare strings, and malformed text parts;
  // only objects carrying a string `text` on a `text` part belong in the flattened message.
  const messages = shakeMessages({
    context: {
      contextEntries: [
        {
          sourceEntry: { id: "m" },
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "first" }, "bare string", null, { type: "image" }, { type: "text", text: 42 }, { type: "text", text: "second" }],
            },
          ],
        },
      ],
    },
  });
  assert.equal(messages[0]!.text, "first\nsecond");
});

test("the adapter writes a bash result's full output and points the edit at it", () => {
  // The adapter wires the real full-output writer into shakePlan. A bash result pi has not
  // persisted yet must be written under the harness root and the pointer must name that path;
  // a temp `.tumwater/` fixture keeps the write off the repository's own state directory.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const prevCwd = process.cwd();
  const handlers = capture();
  const bashEntry = {
    sourceEntry: { id: "b" },
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "cat big" } }] },
      { role: "toolResult", toolName: "bash", toolCallId: "t9", isError: false, content: [{ type: "text", text: big(60_000) }] },
    ],
  };
  const fillerEntry = (i: number) => ({ sourceEntry: { id: `f${i}` }, messages: [{ role: "user", content: [{ type: "text", text: big(16_000) }] }] });
  const event = { context: { contextEntries: [bashEntry, ...[0, 1, 2, 3, 4].map(fillerEntry)] } };
  process.chdir(dir);
  try {
    const result = handlers.turn_end!(event, { getContextUsage: () => atPercent(72) }) as
      | { entries: Array<{ type: string; targetId?: string; replacement?: { content: string } }> }
      | undefined;
    assert.ok(result, "the bash crossing shakes");
    assert.equal(result.entries[0]!.targetId, "b");
    assert.match(result.entries[0]!.replacement!.content, /60000 chars; full output in .*t9\.log\]/);
    const written = fs.readFileSync(path.join(dir, ".tumwater", "log", "tool-output", "t9.log"), "utf8");
    assert.equal(written, big(60_000));
  } finally {
    process.chdir(prevCwd);
  }
});
