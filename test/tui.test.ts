import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import assert from "node:assert/strict";
import { logEvent } from "../src/events.js";
import { submitPrompt } from "../src/inbox.js";
import { initProject } from "../src/init.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { enqueueLanding } from "../src/land-queue.js";
import { runTui } from "../src/ui/tui.js";
import {
  applyKey,
  inputViewWindow,
  parseBudgetInput,
  renderInputView,
  tuiTerminalError,
} from "../src/ui/tui-input.js";
import {
  backlogLines,
  entryBodyWindow,
  moveEntrySelection,
  stepEntryScroll,
} from "../src/ui/tui-backlog.js";
import { cutSplitsSurrogatePair, formatDate } from "../src/text.js";
import { makeRepo, tmpdir } from "./util.js";

const key = (name: string, extra: Partial<{ ctrl: boolean; meta: boolean }> = {}) => ({ name, ...extra });

test("applyKey inserts printable characters at the cursor", () => {
  assert.deepEqual(applyKey("", 0, "h", key("h")), { text: "h", cursor: 1 });
  // Typing at the end appends (the pre-existing behavior).
  assert.deepEqual(applyKey("hello", 5, "!", key("!")), { text: "hello!", cursor: 6 });
  // Typing mid-text inserts at the cursor and shifts it right.
  assert.deepEqual(applyKey("hello world", 6, "X", key("X")), { text: "hello Xworld", cursor: 7 });
});

test("applyKey inserts multi-character strings (IME composition) advancing the cursor fully", () => {
  // readline delivers composed IME text as one keypress whose str holds the whole string
  // and has no special name; the cursor must land after ALL of it, not one unit in.
  assert.deepEqual(applyKey("", 0, "你好", {}), { text: "你好", cursor: 2 });
  assert.deepEqual(applyKey("ab cd", 2, "xy", {}), { text: "abxy cd", cursor: 4 });
});

test("applyKey moves the cursor with left/right and clamps at both ends", () => {
  assert.deepEqual(applyKey("abc", 1, undefined, key("left")), { text: "abc", cursor: 0 });
  assert.deepEqual(applyKey("abc", 0, undefined, key("left")), { text: "abc", cursor: 0 });
  assert.deepEqual(applyKey("abc", 2, undefined, key("right")), { text: "abc", cursor: 3 });
  assert.deepEqual(applyKey("abc", 3, undefined, key("right")), { text: "abc", cursor: 3 });
});

test("applyKey backspace deletes before the cursor; delete after it", () => {
  assert.deepEqual(applyKey("hello", 5, undefined, key("backspace")), { text: "hell", cursor: 4 });
  assert.deepEqual(applyKey("hello world", 6, undefined, key("backspace")), { text: "helloworld", cursor: 5 });
  assert.deepEqual(applyKey("hello", 0, undefined, key("backspace")), { text: "hello", cursor: 0 });
  // Cursor just before the space: forward-delete removes it.
  assert.deepEqual(applyKey("hello world", 5, undefined, key("delete")), { text: "helloworld", cursor: 5 });
  // Cursor after the space: forward-delete removes the next character instead.
  assert.deepEqual(applyKey("hello world", 6, undefined, key("delete")), { text: "hello orld", cursor: 6 });
  assert.deepEqual(applyKey("hello", 5, undefined, key("delete")), { text: "hello", cursor: 5 });
});

test("applyKey backspace/delete remove a whole astral character, never a lone surrogate", () => {
  // 😀 (U+1F600) is two UTF-16 code units; typing it lands the cursor right after both.
  const emoji = "\u{1f600}";
  assert.equal(emoji.length, 2);
  // Backspace just after a typed emoji removes BOTH units (the pre-fix behavior left a lone
  // high surrogate that terminals render as a U+FFFD box).
  let state = applyKey("", 0, emoji, {});
  assert.deepEqual(state, { text: emoji, cursor: 2 });
  state = applyKey(state.text, state.cursor, undefined, key("backspace"));
  assert.deepEqual(state, { text: "", cursor: 0 });
  // Backspace mid-text removes the whole pair, keeping the neighbours intact.
  state = applyKey("a\u{1f600}b", 3, undefined, key("backspace"));
  assert.deepEqual(state, { text: "ab", cursor: 1 });
  // Forward-delete at the start of a pair removes BOTH units (cursor stays put).
  state = applyKey("a\u{1f600}b", 1, undefined, key("delete"));
  assert.deepEqual(state, { text: "ab", cursor: 1 });
  // A BMP character is still removed one unit at a time (no regression).
  state = applyKey("a\u00e9b", 2, undefined, key("backspace"));
  assert.deepEqual(state, { text: "ab", cursor: 1 });
});

test("applyKey never strands the cursor inside a surrogate pair", () => {
  const emoji = "\u{1f600}";
  // left/right step over the whole astral character instead of into the middle of its pair:
  // a cursor at the low half of the pair would let backspace/delete cut it in half.
  assert.deepEqual(applyKey(emoji, 2, undefined, key("left")), { text: emoji, cursor: 0 });
  assert.deepEqual(applyKey(emoji, 0, undefined, key("right")), { text: emoji, cursor: 2 });
  assert.deepEqual(applyKey(`a${emoji}b`, 3, undefined, key("left")), { text: `a${emoji}b`, cursor: 1 });
  // A cursor handed in mid-pair (stale state) is snapped to the pair's start, so neither
  // edit direction can leave a lone surrogate behind.
  const backspaced = applyKey(emoji, 1, undefined, key("backspace"));
  assert.deepEqual(backspaced, { text: emoji, cursor: 0 });
  const deleted = applyKey(emoji, 1, undefined, key("delete"));
  assert.deepEqual(deleted, { text: "", cursor: 0 });
});

test("a typo is fixable without retyping the rest of the prompt", () => {
  // Typed "dar k mode" (stray space); meant "dark mode". Move back over it and delete.
  let state = { text: "dar k mode", cursor: 10 };
  for (let i = 0; i < 6; i++) state = applyKey(state.text, state.cursor, undefined, key("left"));
  assert.equal(state.cursor, 4); // just after the stray space
  state = applyKey(state.text, state.cursor, undefined, key("backspace"));
  assert.deepEqual(state, { text: "dark mode", cursor: 3 });
});

test("applyKey ignores control and meta characters but clamps a stale cursor", () => {
  assert.deepEqual(applyKey("ab", 1, "\x03", key("c", { ctrl: true })), { text: "ab", cursor: 1 });
  assert.deepEqual(applyKey("ab", 1, "é", key("e", { meta: true })), { text: "ab", cursor: 1 });
  // An out-of-range cursor (stale after a submit) is clamped instead of corrupting the edit.
  assert.deepEqual(applyKey("ab", 9, "x", key("x")), { text: "abx", cursor: 3 });
});

test("parseBudgetInput maps empty to disabled and validates the rest", () => {
  assert.deepEqual(parseBudgetInput(""), { ok: true, value: 0 }, "empty means no cap");
  assert.deepEqual(parseBudgetInput("   "), { ok: true, value: 0 }, "whitespace-only is empty too");
  assert.deepEqual(parseBudgetInput("25"), { ok: true, value: 25 });
  assert.deepEqual(parseBudgetInput("12.34"), { ok: true, value: 12.34 }, "fractional dollars allowed");
  assert.deepEqual(parseBudgetInput(".5"), { ok: true, value: 0.5 }, "leading-dot decimals stay admitted");
  for (const bad of [
    "abc",
    "-1",
    "Infinity",
    "1e999",
    // Non-decimal notations must not set a cap: Number() would read hex as 16 and finite
    // exponent notation as 100 — regression for the TUI accepting both as dollar amounts.
    "0x10",
    "1e2",
    "+5",
    // Absurd digit counts overflow to Infinity: the isFinite backstop still rejects them.
    "9".repeat(410),
  ]) {
    const r = parseBudgetInput(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.match(r.error, /number of 0 or more/);
  }
});

test("renderInputView shows short prompts whole and long ones as a cursor window", () => {
  assert.equal(renderInputView("hi", 2, 80), "hi");
  // Cursor at the end: tail window with a leading ellipsis (the pre-existing behavior).
  const long = "a".repeat(50);
  assert.equal(renderInputView(long, 50, 10), "…" + "a".repeat(7));
  // Cursor in the middle: the window keeps it at the right edge.
  const text = "abcdefghijklmnopqrst"; // 20 chars
  assert.equal(renderInputView(text, 10, 8), "…ghijk");
  // Cursor near the start: no ellipsis when the window begins at index 0.
  assert.equal(renderInputView(text, 3, 8), "abcde");
});

test("the rendered prompt line never exceeds the terminal width", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  for (let width = 4; width <= 60; width++) {
    for (const cursor of [0, 5, Math.floor(text.length / 2), text.length]) {
      const line = "> " + renderInputView(text, cursor, width);
      assert.ok(line.length <= width, `width ${width}, cursor ${cursor}: ${line.length} cols`);
    }
  }
});

test("renderInputView windows astral text without a lone surrogate or a hidden cursor", () => {
  // Regression: a pair straddling the tail window's left edge used to leave a lone low
  // surrogate *and* start the window past the cursor. The two-emoji line fits whole once the
  // window is allowed to floor to index 0 (no ellipsis column is spent).
  assert.equal(renderInputView("\u{1f600}\u{1f600}", 4, 6), "\u{1f600}\u{1f600}");
  // Cursor at the end of a four-emoji line: re-anchor to the cursor rather than dropping
  // the tail. The window is one whole emoji at the right edge.
  assert.equal(renderInputView("\u{1f600}".repeat(4), 8, 6), "…\u{1f600}");

  // Regression: a cursor on an astral character in a room-1/2 window used to leave an
  // empty window (start === end), which renderInputView drew as a bare ellipsis — the whole
  // prompt line blank at width 4–5. The window now falls back to the character under the
  // cursor, and the ellipsis is dropped when it no longer fits beside it.
  assert.deepEqual(inputViewWindow("ab\u{1f600}\u{1f600}", 4, 2), { start: 4, end: 6 });
  assert.deepEqual(inputViewWindow("ab\u{1f600}\u{1f600}", 5, 2), { start: 4, end: 6 });
  assert.deepEqual(inputViewWindow("\u{1f600}\u{1f600}", 4, 1), { start: 2, end: 4 });
  assert.equal(renderInputView("ab\u{1f600}\u{1f600}", 4, 5), "…\u{1f600}");
  assert.equal(renderInputView("ab\u{1f600}\u{1f600}", 4, 4), "\u{1f600}");
  assert.equal(renderInputView("\u{1f600}\u{1f600}", 4, 4), "\u{1f600}");

  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const samples = ["a".repeat(40), "\u{1f600}".repeat(8), "x\u{1f600}y\u00e9\u{1f600}z".repeat(3)];
  for (const text of samples) {
    for (let width = 4; width <= 24; width++) {
      const room = Math.max(1, width - 3);
      for (let cursor = 0; cursor <= text.length; cursor++) {
        // Mid-pair cursors are not editable states (applyKey snaps them); the boundary ones
        // are what the window must keep visible.
        if (cutSplitsSurrogatePair(text, cursor)) continue;
        const where = `width ${width}, cursor ${cursor}`;
        const view = renderInputView(text, cursor, width);
        assert.ok(!loneSurrogate.test(view), `${where}: ${JSON.stringify(view)} has a lone surrogate`);
        assert.ok(("> " + view).length <= width, `${where}: ${JSON.stringify(view)} exceeds the width`);
        assert.ok(view.length > 0, `${where}: ${JSON.stringify(view)} is empty`);
        // The window must keep the (clamped) cursor inside it — the property the rejected
        // fix broke: it dropped tail units so the cursor fell off the right edge.
        const { start, end } = inputViewWindow(text, cursor, room);
        const c = Math.max(0, Math.min(cursor, text.length));
        assert.ok(start < end, `${where}: window [${start},${end}) is empty`);
        assert.ok(start <= c && c <= end, `${where}: window [${start},${end}) hides the cursor`);
        // renderInputView mirrors this window, dropping the ellipsis when the whole-character
        // fallback no longer leaves it room beside the slice.
        const slice = text.slice(start, end);
        const withEllipsis = start > 0 ? `…${slice}` : slice;
        const expected = withEllipsis.length <= width - 2 ? withEllipsis : slice;
        assert.equal(expected, text.length <= room ? text : view, `${where}: window/render drift`);
      }
    }
  }
});

test("backlogLines renders subheaders with counts, entries in order", () => {
  assert.deepEqual(backlogLines(["plan A"], ["bug B"], []), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
    "open questions (0):",
    "(none)",
  ]);
  assert.deepEqual(backlogLines(["plan A"], ["bug B"], ["question Q"]), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
    "open questions (1):",
    "question Q",
  ]);
});

test("backlogLines renders (none) under an empty section's subheader", () => {
  assert.deepEqual(backlogLines([], ["bug B"], []), [
    "plans (0):",
    "(none)",
    "open bugs (1):",
    "bug B",
    "open questions (0):",
    "(none)",
  ]);
  assert.deepEqual(backlogLines(["plan A"], [], []), [
    "plans (1):",
    "plan A",
    "open bugs (0):",
    "(none)",
    "open questions (0):",
    "(none)",
  ]);
});

test("backlogLines with nothing at all is a single self-explanatory line", () => {
  assert.deepEqual(backlogLines([], [], []), ["(no planned features, open bugs, or open questions)"]);
});

// Entry browsing in the project-status pane (PLANS.md "Read backlog entries in full"): the
// cursor math and body rendering are pure, so they are pinned here without a TTY.

test("moveEntrySelection opens the first entry on down and the last on up from list mode", () => {
  assert.equal(moveEntrySelection(3, null, "down"), 0);
  assert.equal(moveEntrySelection(3, null, "up"), 2);
});

test("moveEntrySelection wraps at both ends across the flat entry list", () => {
  // Three entries: plans (indices 0-1) then bugs (index 2). Down from a plan's last index
  // crosses into the next section; up from the first wraps to the last.
  assert.equal(moveEntrySelection(3, 1, "down"), 2); // plans → bugs boundary
  assert.equal(moveEntrySelection(3, 2, "down"), 0); // wraps back to the first plan
  assert.equal(moveEntrySelection(3, 0, "up"), 2); // wraps from the front to the end
  assert.equal(moveEntrySelection(3, 2, "up"), 1);
});

test("moveEntrySelection with no entries stays in list mode", () => {
  assert.equal(moveEntrySelection(0, null, "down"), null);
  assert.equal(moveEntrySelection(0, null, "up"), null);
  assert.equal(moveEntrySelection(0, 5, "down"), null); // a stale selection also clears
});

test("entryBodyWindow at offset zero clips each line and keeps the head within budget", () => {
  const body = "a very long first line that will not fit\nsecond line\nthird line";
  assert.deepEqual(entryBodyWindow(body, 0, 2, 10), { lines: ["a very lo…", "second li…"], total: 3 });
  // Lines that fit are untouched; the head window is unchanged from today's entryBodyLines.
  assert.deepEqual(entryBodyWindow("short\nalso short", 0, 5, 80), { lines: ["short", "also short"], total: 2 });
  // A bare heading has an empty body: one self-explanatory placeholder line, zero total
  // (so the scroll affordance never appears for it).
  assert.deepEqual(entryBodyWindow("", 0, 3, 100), { lines: ["(no details for this entry)"], total: 0 });
});

test("entryBodyWindow pages through the middle and tail of a long body", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  // Middle window: lines 3-5 (offset 2, budget 3).
  assert.deepEqual(entryBodyWindow(body, 2, 3, 80), { lines: ["line 3", "line 4", "line 5"], total: 10 });
  // Tail window: the last three lines.
  assert.deepEqual(entryBodyWindow(body, 7, 3, 80), { lines: ["line 8", "line 9", "line 10"], total: 10 });
});

test("entryBodyWindow clamps an offset past either end (a resize or budget shrink cannot strand it)", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  // An offset far beyond the tail clamps to the last possible window.
  assert.deepEqual(entryBodyWindow(body, 99, 3, 80), { lines: ["line 8", "line 9", "line 10"], total: 10 });
  // A negative offset clamps to the head.
  assert.deepEqual(entryBodyWindow(body, -5, 3, 80), { lines: ["line 1", "line 2", "line 3"], total: 10 });
});

test("stepEntryScroll pages down to the tail and back up to the head, clamped at both ends", () => {
  // Ten lines, budget three → maxOffset 7. From the head each PgDn advances one page…
  assert.equal(stepEntryScroll(0, 10, 3, "down"), 3);
  assert.equal(stepEntryScroll(3, 10, 3, "down"), 6);
  // …until it clamps at the tail (offset 7 shows lines 8-10) and stays put.
  assert.equal(stepEntryScroll(6, 10, 3, "down"), 7);
  assert.equal(stepEntryScroll(7, 10, 3, "down"), 7);
  // PgUp mirrors: back up one page per press, clamped at the head.
  assert.equal(stepEntryScroll(7, 10, 3, "up"), 4);
  assert.equal(stepEntryScroll(4, 10, 3, "up"), 1);
  assert.equal(stepEntryScroll(1, 10, 3, "up"), 0);
  assert.equal(stepEntryScroll(0, 10, 3, "up"), 0);
});

test("stepEntryScroll is a no-op when the body fits its budget", () => {
  // A single window: every step lands on (and stays at) the head.
  assert.equal(stepEntryScroll(0, 3, 5, "down"), 0);
  assert.equal(stepEntryScroll(2, 3, 5, "up"), 0); // even a stale offset resets to the head
  assert.equal(stepEntryScroll(9, 0, 4, "down"), 0); // an empty body has no window at all
});

/** A fake-TTY harness around runTui: no real terminal is involved. The isTTY flags are
 * faked, raw mode / resume / pause are stubbed and recorded, readline's keypress emitter
 * is no-op'd (so the test runner's stdin stream is never touched), every stdout write is
 * captured as a frame, and setInterval/clearInterval are stubbed so a failed test cannot
 * leave a live render timer behind. The keypress handler runTui registers on stdin is
 * intercepted and replayed with synthetic keys. */
function startTui(root: string) {
  const frames: string[] = [];
  const rawModes: boolean[] = [];
  let clearCalls = 0;
  let keypressHandler: ((str?: string, key?: readline.Key) => void) | null = null;

  const origWrite = process.stdout.write.bind(process.stdout);
  const origEmitKeypressEvents = readline.emitKeypressEvents;
  const origStdinOn = process.stdin.on.bind(process.stdin);
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  (process.stdout as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { columns?: number }).columns = 100;
  (process.stdout as { rows?: number }).rows = 40;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    frames.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdin as { setRawMode?: (on: boolean) => void }).setRawMode = (on) => rawModes.push(on);
  (process.stdin as { resume?: () => void }).resume = () => {};
  (process.stdin as { pause?: () => void }).pause = () => {};
  readline.emitKeypressEvents = (() => {}) as unknown as typeof origEmitKeypressEvents;
  process.stdin.on = ((ev: string, fn: (...args: unknown[]) => void) => {
    if (ev === "keypress") {
      keypressHandler = fn as (str?: string, key?: readline.Key) => void;
      return process.stdin; // not registered on the real stream: nothing emits keypress in tests
    }
    return origStdinOn(ev, fn);
  }) as unknown as typeof process.stdin.on;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearCalls += 1;
  }) as unknown as typeof clearInterval;

  // runTui's body runs synchronously up to its keypress await: by the time this returns,
  // one frame has been rendered and the handler is captured.
  const done = runTui(root);

  function press(str: string | undefined, name: string, extra: { ctrl?: boolean } = {}) {
    assert.ok(keypressHandler, "keypress handler registered by runTui");
    keypressHandler!(str, { name, ...extra });
  }
  const lastFrame = () => frames[frames.length - 1] ?? "";
  const lines = () => lastFrame().split("\n");

  function cleanup() {
    process.stdout.write = origWrite;
    (process.stdout as { isTTY?: boolean }).isTTY = undefined;
    (process.stdout as { columns?: number }).columns = undefined;
    (process.stdout as { rows?: number }).rows = undefined;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    delete (process.stdin as { resume?: unknown }).resume;
    delete (process.stdin as { pause?: unknown }).pause;
    readline.emitKeypressEvents = origEmitKeypressEvents;
    process.stdin.on = origStdinOn;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  /** Ctrl+C and wait for runTui to finish, then restore every patched global. */
  async function quit(): Promise<void> {
    press(undefined, "c", { ctrl: true });
    await done;
    cleanup();
  }

  return { key: press, lastFrame, lines, frames, rawModes, get clearCalls() { return clearCalls; }, quit };
}

/** A fresh initialized repo with exactly one non-director role enabled, so the Ctrl+T
 * view cycle (events → transcript → project status) is short and deterministic. */
async function makeTuiRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "Build a thing.");
  const cfg = loadConfig(repo);
  for (const [id, rc] of Object.entries(cfg.roles)) rc.enabled = id === "clean";
  saveConfig(repo, cfg);
  return repo;
}

test("runTui renders the fleet table and an empty recent-activity pane on start", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    const frame = tui.lastFrame();
    assert.match(frame, /recent activity/); // default view: recent events
    assert.match(frame, /\(no events yet\)/);
    assert.equal(tui.lines().at(-1), "> "); // empty prompt line at the bottom
    // The one enabled loop is listed as stopped (the orchestrator is not running).
    assert.match(frame, /clean/);
    assert.match(frame, /stopped/);
  } finally {
    await tui.quit();
  }
});

// Merge queue 4/5 — the TUI header shows the land queue badge while anything is queued or
// landing, and nothing when idle (the badge is empty at depth 0, so every existing
// header byte stays intact). The frame carries renderStatus's full output, header line
// included; the badge lands well inside the faked 100 columns (the budget badge after it
// is what clips on a long name).
test("runTui shows the land queue badge in the header while a landing is queued", async () => {
  const repo = await makeTuiRepo();
  enqueueLanding(repo, {
    role: "clean",
    sha: "abc1234",
    tick: 1,
    summary: "tidy something",
    enqueuedAt: Date.now(),
  });
  const tui = startTui(repo);
  try {
    assert.match(tui.lastFrame(), /· land queue: 1/);
  } finally {
    await tui.quit();
  }
});

test("runTui shows no land queue badge when the queue is idle", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    assert.doesNotMatch(tui.lastFrame(), /land queue/);
  } finally {
    await tui.quit();
  }
});

test("typing edits the prompt line; Enter queues it for the director", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    for (const ch of "fix the bug") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "> fix the bug");

    // Backspace deletes before the cursor; retype to restore.
    tui.key(undefined, "backspace");
    assert.equal(tui.lines().at(-1), "> fix the bu");
    tui.key("g", "g");

    tui.key(undefined, "return");
    const inbox = path.join(repo, ".tumwater", "inbox");
    const files = fs.readdirSync(inbox).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(inbox, files[0]!), "utf8"), "fix the bug");

    // The flash confirms the queue and the event feed picks up the enqueue.
    const frame = tui.lastFrame();
    assert.match(frame, /queued for the director loop/);
    assert.match(frame, /user prompt queued: fix the bug/);
    // The input line is cleared after submit.
    assert.equal(tui.lines().at(-1), "> ");

    // An empty Enter queues nothing more.
    tui.key(undefined, "return");
    assert.equal(fs.readdirSync(inbox).filter((f) => f.endsWith(".md")).length, 1);
  } finally {
    await tui.quit();
  }
});

test("a failed prompt submit keeps the text and flashes the error instead of losing it", async () => {
  // Regression: the TUI cleared the input line before calling submitPrompt and left the call
  // unguarded, so a queue write failure (disk full, permissions) both silently dropped the
  // operator's prompt and threw out of the keypress handler, killing the TUI. The GUI's prompt
  // form already keeps the text and flashes the error on failure; the TUI must match.
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).includes(`${path.sep}inbox${path.sep}`)) {
      throw new Error("ENOSPC: no space left on device, write");
    }
    return (origWriteFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as unknown as typeof fs.writeFileSync;
  try {
    for (const ch of "fix the bug") tui.key(ch, ch);
    tui.key(undefined, "return");

    const frame = tui.lastFrame();
    assert.match(frame, /error: ENOSPC/); // the reason is surfaced, not swallowed
    assert.doesNotMatch(frame, /queued for the director loop/);
    // The text is kept so it can be resubmitted once the failure is fixed.
    assert.equal(tui.lines().at(-1), "> fix the bug");
    const inbox = path.join(repo, ".tumwater", "inbox");
    assert.equal(fs.readdirSync(inbox).filter((f) => f.endsWith(".md")).length, 0);
  } finally {
    fs.writeFileSync = origWriteFileSync;
    await tui.quit();
  }
});

/** Replace a file's first `_None yet._` placeholder (under its first section) with an entry. */
function seedEntry(root: string, file: string, heading: string): void {
  const p = path.join(root, file);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("_None yet._", `${heading}\n`));
}

/** Local-noon timestamp `daysAgo` days before today — a fixed hour keeps the fixture from
 * straddling midnight between seeding and collectReport's own clock read. */
function atNoon(daysAgo: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

test("Ctrl+T cycles events → transcript → project status → usage report with real content", async () => {
  const repo = await makeTuiRepo();
  // Seed the clean loop's pi log with one assistant turn so the transcript pane has
  // something real to show (the user message must never render).
  const logDir = path.join(repo, ".tumwater", "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "clean.pi.jsonl"),
    [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", timestamp: Date.now(), content: [] } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "tidied the imports" }] },
      }),
    ].join("\n") + "\n",
  );
  // Seed the event log with explicit ts values (logEvent always stamps Date.now(), so direct
  // append is the controllable path): ticks across two roles on two days plus one merge.
  const eventsFile = path.join(repo, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.writeFileSync(
    eventsFile,
    [
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.5 }),
      JSON.stringify({ ts: atNoon(0), loop: "clean", type: "tick_end", tick: 2, result: "no_change", tokens: 150 }),
      JSON.stringify({ ts: atNoon(0), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
    ].join("\n") + "\n",
  );

  const tui = startTui(repo);
  try {
    assert.match(tui.lastFrame(), /recent activity/);

    tui.key(undefined, "t", { ctrl: true });
    let frame = tui.lastFrame();
    assert.match(frame, /transcript: clean — Ctrl\+T to cycle/);
    assert.match(frame, /tidied the imports/); // assistant text renders…
    assert.doesNotMatch(frame, /Build a thing/); // …but never the user's tick prompt

    tui.key(undefined, "t", { ctrl: true });
    frame = tui.lastFrame();
    assert.match(frame, /project status — Ctrl\+T to cycle/);
    // One plan and one bug seeded above render under their counted subheaders; the empty
    // questions section renders (none).
    seedEntry(repo, "PLANS.md", "### Add a --json flag");
    seedEntry(repo, "BUGS.md", "### Crashes on empty input");
    tui.key(undefined, "left"); // any keypress re-renders the current view
    frame = tui.lastFrame();
    assert.match(frame, /plans \(1\):/);
    assert.match(frame, /Add a --json flag/);
    assert.match(frame, /open bugs \(1\):/);
    assert.match(frame, /Crashes on empty input/);
    assert.match(frame, /open questions \(0\):/);
    assert.match(frame, /\(none\)/);

    tui.key(undefined, "t", { ctrl: true }); // → usage report
    frame = tui.lastFrame();
    assert.match(frame, /usage report — Ctrl\+T to cycle/);
    // The pane shows the same Markdown `tumwater report` prints for this root and window:
    // the Totals line plus a day row per seeded event (tokens bucketed by local day).
    assert.match(frame, /Totals:/);
    assert.match(frame, new RegExp(`\\| ${formatDate(new Date(atNoon(1))).slice(5)} \\| 500`));
    assert.match(frame, new RegExp(`\\| ${formatDate(new Date(atNoon(0))).slice(5)} \\| 150`));

    tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /recent activity/); // wraps back to events
  } finally {
    await tui.quit();
  }
});

test("project status browses entries in full with up/down and resets on Ctrl+T", async () => {
  const repo = await makeTuiRepo();
  // One plan with a real body (the seeded placeholder file has none) so browsing shows more
  // than the heading, plus one bare bug to cross into the next section.
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### Add a --json flag (planned 2026-09-05)",
      "",
      "**Goal.** Machine-readable status output.",
      "",
      "A second body line, kept verbatim.",
      "",
      "## Done",
      "",
      "_None yet._",
    ].join("\n") + "\n",
  );
  seedEntry(repo, "BUGS.md", "### Crashes on empty input");

  const tui = startTui(repo);
  try {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    let frame = tui.lastFrame();
    assert.match(frame, /project status — Ctrl\+T to cycle/);
    assert.match(frame, /Add a --json flag/); // list mode shows the heading…
    assert.doesNotMatch(frame, /Machine-readable status output/); // …but not its body

    tui.key(undefined, "down"); // opens the first entry's full body
    frame = tui.lastFrame();
    assert.match(frame, /plan: Add a --json flag \(planned 2026-09-05\) — ↑↓ browse · Ctrl\+T cycle/);
    assert.match(frame, /Machine-readable status output/);
    assert.match(frame, /A second body line, kept verbatim/);

    tui.key(undefined, "down"); // crosses into the bugs section (the bare bug)
    frame = tui.lastFrame();
    assert.match(frame, /bug: Crashes on empty input — ↑↓ browse · Ctrl\+T cycle/);
    assert.match(frame, /no details for this entry/); // a bare heading has an empty body

    tui.key(undefined, "up"); // back to the plan (index 0 — the FIRST entry)
    assert.match(tui.lastFrame(), /plan: Add a --json flag/);
    tui.key(undefined, "down"); // crosses into the bugs section again — index 1 is the LAST entry…
    assert.match(tui.lastFrame(), /bug: Crashes on empty input/);
    tui.key(undefined, "down"); // …so this one wraps from the last back to the first
    assert.match(tui.lastFrame(), /plan: Add a --json flag/);

    tui.key(undefined, "t", { ctrl: true }); // leaves the view and clears the selection…
    assert.match(tui.lastFrame(), /usage report —/); // …onto the usage-report pane (no events seeded)
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true }); // → project status again
    frame = tui.lastFrame();
    assert.match(frame, /project status — Ctrl\+T to cycle/); // list mode restored…
    assert.doesNotMatch(frame, /Machine-readable status output/); // …body no longer shown
  } finally {
    await tui.quit();
  }
});

/** The "body line NN" numbers currently shown in the pane (ANSI codes ignored). */
function visibleBodyLines(frame: string): number[] {
  const out: number[] = [];
  for (const m of frame.matchAll(/body line (\d{2})/g)) out.push(Number(m[1]));
  return out;
}

test("PgDn/PgUp page the selected entry's body, clamped at both ends", async () => {
  const repo = await makeTuiRepo();
  // One plan whose 80-line body overflows any pane budget this fake TTY can produce
  // (rows=40 → budget ≤ ~33), so paging has real room in both directions.
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### Long body plan (planned 2026-09-05)",
      "",
      ...Array.from({ length: 80 }, (_, i) => `body line ${String(i + 1).padStart(2, "0")}`),
      "",
      "## Done",
      "",
      "_None yet._",
    ].join("\n") + "\n",
  );

  const tui = startTui(repo);
  try {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "down"); // open the plan's full body

    let frame = tui.lastFrame();
    assert.match(frame, /plan: Long body plan \(planned 2026-09-05\) — ↑↓ browse · PgUp\/PgDn scroll · Ctrl\+T cycle/);
    // The head window shows the first budget-many lines.
    let win = visibleBodyLines(frame);
    assert.ok(win.length >= 3, `pane shows a real window: ${win.length} lines`);
    assert.deepEqual(win, Array.from({ length: win.length }, (_, i) => i + 1));

    // One PgDn advances exactly one page (the window is far from the tail at this size).
    tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    win = visibleBodyLines(frame);
    const b = win.length;
    assert.deepEqual(win, Array.from({ length: b }, (_, i) => i + b + 1)); // lines B+1..2B

    // Repeated PgDn clamps at the tail: the last line is visible and further presses are no-ops.
    for (let i = 0; i < 30; i++) tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    win = visibleBodyLines(frame);
    assert.equal(win[win.length - 1], 80, "tail line visible at the clamp");
    const tailFrame = frame;
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tailFrame, "PgDn past the tail is a no-op");

    // PgUp mirrors back to the head and clamps there.
    for (let i = 0; i < 30; i++) tui.key(undefined, "pageup");
    frame = tui.lastFrame();
    win = visibleBodyLines(frame);
    assert.equal(win[0], 1, "head line visible again at the top clamp");
    const headFrame = frame;
    tui.key(undefined, "pageup");
    assert.equal(tui.lastFrame(), headFrame, "PgUp past the head is a no-op");
  } finally {
    await tui.quit();
  }
});

test("PgUp/PgDn are ignored in project-status list mode (no entry selected)", async () => {
  const repo = await makeTuiRepo();
  seedEntry(repo, "PLANS.md", "### Add a --json flag"); // something to show in the list

  const tui = startTui(repo);
  try {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true }); // → project status (list mode)
    assert.match(tui.lastFrame(), /plans \(1\):/);

    const listFrame = tui.lastFrame();
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), listFrame, "PgDn with no selection re-renders the same list");
    tui.key(undefined, "pageup");
    assert.equal(tui.lastFrame(), listFrame, "…and so does PgUp");
  } finally {
    await tui.quit();
  }
});

test("a stale entry selection falls back to the empty list when entries disappear", async () => {
  const repo = await makeTuiRepo();
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### Add a --json flag (planned 2026-09-05)",
      "",
      "**Goal.** Machine-readable status output.",
      "",
      "## Done",
      "",
      "_None yet._",
    ].join("\n") + "\n",
  );

  const tui = startTui(repo);
  try {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "down"); // open the plan's body (selection now active)
    assert.match(tui.lastFrame(), /Machine-readable status output/);

    // The entry is removed from PLANS.md while selected (a loop landed an edit).
    fs.writeFileSync(
      path.join(repo, "PLANS.md"),
      ["# Plans", "", "## Planned", "", "_None yet._", "", "## Done", "", "_None yet._"].join("\n") + "\n",
    );

    // A keypress in the stale state: PgDn takes the no-entries path of the page handler…
    tui.key(undefined, "pagedown");
    const frame = tui.lastFrame();
    assert.match(frame, /project status — Ctrl\+T to cycle/); // list-mode header restored
    assert.match(frame, /\(no planned features, open bugs, or open questions\)/);
    assert.doesNotMatch(frame, /Machine-readable status output/); // …and the body is gone
  } finally {
    await tui.quit();
  }
});

test("open questions add a nudge line above the activity pane", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    assert.doesNotMatch(tui.lastFrame(), /awaiting answers/); // seeded QUESTIONS.md is empty

    // Post a question under ## Open (the first "_None yet._" placeholder).
    seedEntry(repo, "QUESTIONS.md", "### Q1: which database?");

    // Any keypress re-renders; the nudge appears and the question counts in the header.
    tui.key(undefined, "left");
    assert.match(tui.lastFrame(), /questions: 1 awaiting answers/);
  } finally {
    await tui.quit();
  }
});

test("queued prompts render numbered above the activity pane and shrink its budget", async () => {
  const repo = await makeTuiRepo();
  // Seed enough events that the recent-activity pane is full at the default budget, so a
  // shrinking budget visibly drops body lines instead of just showing fewer than it could.
  for (let i = 1; i <= 30; i++) logEvent(repo, { loop: "clean", type: "tick_start", tick: i });

  const tui = startTui(repo);
  try {
    // Nothing queued → no numbered lines anywhere in the frame.
    assert.doesNotMatch(tui.lastFrame(), /^\d+\. /m);

    // Body lines run from after the pane header to the blank line before the hint.
    const bodyLen = () => {
      const ls = tui.lines();
      const h = ls.findIndex((l) => l.includes("recent activity"));
      let n = 0;
      for (let i = h + 1; i < ls.length && (ls[i] ?? "") !== ""; i++) n++;
      return n;
    };
    const full = bodyLen();

    submitPrompt(repo, "fix the login bug");
    submitPrompt(repo, "z".repeat(120)); // overlong: preview truncated to 80 chars upstream
    tui.key(undefined, "left"); // any keypress re-renders with a fresh snapshot

    const ls = tui.lines();
    const h = ls.findIndex((l) => l.includes("recent activity"));
    assert.equal(ls[h - 2], "1. fix the login bug", "first queue line sits above the pane");
    assert.ok((ls[h - 1] ?? "").startsWith("2. "), "second queue line is numbered in order");
    // The overlong prompt's preview is ≤80 chars, so its line fits the terminal width.
    assert.ok((ls[h - 1] ?? "").length <= 100);

    // Each queue line consumes exactly one line of budget: the full pane lost two body lines.
    assert.equal(bodyLen(), full - 2);

    // A narrower terminal clips each queue line to its width — no wrap, no scroll.
    (process.stdout as { columns?: number }).columns = 60;
    tui.key(undefined, "left");
    const ls2 = tui.lines();
    const h2 = ls2.findIndex((l) => l.includes("recent activity"));
    for (const line of [ls2[h2 - 2], ls2[h2 - 1]]) {
      assert.ok(line !== undefined && line.length <= 60, `queue line fits the width: ${JSON.stringify(line)}`);
    }
    (process.stdout as { columns?: number }).columns = 100;
  } finally {
    await tui.quit();
  }
});

test("runTui refuses to start without an interactive terminal", async () => {
  const repo = await makeTuiRepo();
  // Force the non-TTY state regardless of where the test runner itself is attached
  // (e.g. `tumwater tui | cat` must fail with a clear error, not crash or hang).
  const origIn = (process.stdin as { isTTY?: boolean }).isTTY;
  const origOut = (process.stdout as { isTTY?: boolean }).isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = undefined;
  (process.stdout as { isTTY?: boolean }).isTTY = undefined;
  try {
    await assert.rejects(
      runTui(repo),
      /needs an interactive terminal: neither stdin \(prompt input\) nor stdout \(the dashboard\) is a TTY/,
    );
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = origIn;
    (process.stdout as { isTTY?: boolean }).isTTY = origOut;
  }
});

test("tuiTerminalError names the missing stream and points at the non-interactive views", () => {
  assert.equal(
    tuiTerminalError(false, false),
    "tumwater tui needs an interactive terminal: neither stdin (prompt input) nor stdout (the dashboard) is a TTY — use `tumwater status` or `tumwater gui` for a non-interactive view",
  );
  assert.equal(
    tuiTerminalError(false, true),
    "tumwater tui needs an interactive terminal: stdin (prompt input) is not a TTY — use `tumwater status` or `tumwater gui` for a non-interactive view",
  );
  assert.equal(
    tuiTerminalError(true, false),
    "tumwater tui needs an interactive terminal: stdout (the dashboard) is not a TTY — use `tumwater status` or `tumwater gui` for a non-interactive view",
  );
});

test("Ctrl+C exits cleanly: raw mode off, stdin paused, render timer cleared", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  assert.equal(tui.rawModes.length, 1); // setRawMode(true) on entry
  await tui.quit();
  assert.deepEqual(tui.rawModes, [true, false]);
  assert.equal(tui.frames.at(-1), "\n"); // final newline after the last frame
  assert.ok(tui.clearCalls >= 1, "the render interval is cleared on exit");
});

// Ctrl+B budget-edit mode on the prompt line (PLANS.md, editable daily cost budget): the
// single interactive surface edits the cap in place — pre-filled with the current cap, Enter
// saves through the shared setter (which writes tumwater.json), Esc/Ctrl+T restore the draft.
test("Ctrl+B edits the daily budget; Enter saves, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // defaultConfig: maxDailyCostUsd 50 (enabled)
  const tui = startTui(repo);
  try {
    // A draft prompt first — leaving budget mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B enters budget-edit mode pre-filled with the current cap and flashes a hint.
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /edit daily cost budget/);
    assert.equal(tui.lines().at(-1), "> 50");

    // Enter on a valid value persists it to tumwater.json and returns to prompt mode.
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "25") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget set to \$25/);
    let cfg = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8")) as { maxDailyCostUsd: number };
    assert.equal(cfg.maxDailyCostUsd, 25);
    assert.equal(tui.lines().at(-1), "> draft prompt"); // previous prompt text restored

    // Invalid input flashes the error and STAYS in edit mode so it can be fixed.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "> 25"); // re-entered pre-filled with the new cap
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "abc") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget must be a number/);
    assert.equal(tui.lines().at(-1), "> abc", "still in edit mode with the text kept");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "> draft prompt");

    // Empty means "no cap": clear the line and Enter disables the budget.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "> 25");
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget disabled/);
    cfg = JSON.parse(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8")) as { maxDailyCostUsd: number };
    assert.equal(cfg.maxDailyCostUsd, 0);

    // A disabled cap pre-fills an empty line (empty means "no cap" on save)…
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "> ");
    // …and Ctrl+T exits budget mode too — cycling the view and restoring the draft.
    tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /transcript: clean/);
    assert.equal(tui.lines().at(-1), "> draft prompt");

    // The footer hint advertises the key.
    assert.match(tui.lastFrame(), /Ctrl\+B edit budget/);
  } finally {
    await tui.quit();
  }
});

// Free-state budget (BUGS.md, 2026-09-14): a fleet whose models are all free has no spend
// a cap could bind, so Ctrl+B flashes a notice instead of opening the editor — the prompt
// line stays byte-for-byte (no pre-filled cap, nothing to save on Enter).
test("Ctrl+B flashes a notice instead of opening the editor on an all-free fleet", async () => {
  const repo = await makeTuiRepo();
  // snapshot() resolves pi's model catalog at $HOME/.pi/agent/models.json (src/pi-models.ts):
  // aim a temp home at an unpriced model the repo config points at, so the fleet reads free.
  const home = tmpdir("tui-free-home-");
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { "lm-studio": { models: [{ id: "qwen3.8-27b" }] } } }),
  );
  const cfg = loadConfig(repo);
  cfg.provider = "lm-studio";
  cfg.model = "qwen3.8-27b";
  saveConfig(repo, cfg);
  const oldHome = process.env.HOME;
  process.env.HOME = home; // must be set before the first render so Ctrl+B reads the free flag
  try {
    const tui = startTui(repo);
    try {
      // A draft prompt — the notice must leave it byte-for-byte intact.
      for (const ch of "draft prompt") tui.key(ch, ch);
      tui.key(undefined, "b", { ctrl: true });
      assert.match(tui.lastFrame(), /budget n\/a — all models free/);
      assert.equal(tui.lines().at(-1), "> draft prompt", "the editor never opened — prompt untouched");
      assert.match(tui.lastFrame(), /Ctrl\+B edit budget/, "the footer hint is unchanged");
    } finally {
      await tui.quit();
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

// Ctrl+B is a TOGGLE: pressing it while already in budget-edit mode takes the exit branch
// (exitBudgetMode) — the previous draft comes back byte-for-byte, and a following entry
// re-fills the cap. Esc and Ctrl+T exits are pinned above; this pins the third exit.
test("Ctrl+B again exits budget-edit mode, restoring the draft byte-for-byte", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    for (const ch of "keep me") tui.key(ch, ch);
    tui.key(undefined, "b", { ctrl: true }); // enter: pre-filled with the current cap
    assert.equal(tui.lines().at(-1), "> 50");

    // The same key in edit mode toggles out (the exit branch), restoring the draft.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "> keep me");

    // The toggle is symmetric: re-entering re-fills the cap, and the draft survives a
    // second round-trip through the editor.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "> 50");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "> keep me");
  } finally {
    await tui.quit();
  }
});

// PgDn/PgUp in the usage-report view (the last view of the Ctrl+T cycle) page the cached
// report within the pane's line budget, clamped at both ends. The 14-day report is 24
// lines (8 chrome + 14 day rows + 2); a dozen queued prompts each consume one line of
// the budget, so the window (≤ ~21 lines at rows=40) is strictly smaller than the report
// and paging has real room in both directions.
test("the usage-report pane pages with PgDn/PgUp, clamped at both ends", async () => {
  const repo = await makeTuiRepo();
  for (let i = 1; i <= 12; i++) submitPrompt(repo, `prompt ${i}`);

  const tui = startTui(repo);
  try {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "t", { ctrl: true }); // → usage report
    let frame = tui.lastFrame();
    assert.match(frame, /usage report/);
    assert.match(frame, /# tumwater usage report/); // head window shows the title
    assert.doesNotMatch(frame, /\*\*Ticks by role:\*\*/); // …and not the tail

    // Repeated PgDn advances pages and clamps at the tail: the tail line is visible and
    // the title has scrolled out of the window.
    for (let i = 0; i < 8; i++) tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    assert.match(frame, /\*\*Ticks by role:\*\*/);
    assert.doesNotMatch(frame, /# tumwater usage report/);
    const tailFrame = frame;
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tailFrame, "PgDn past the tail is a no-op");

    // PgUp mirrors back to the head and clamps there.
    for (let i = 0; i < 8; i++) tui.key(undefined, "pageup");
    frame = tui.lastFrame();
    assert.match(frame, /# tumwater usage report/);
    assert.doesNotMatch(frame, /\*\*Ticks by role:\*\*/);
    const headFrame = frame;
    tui.key(undefined, "pageup");
    assert.equal(tui.lastFrame(), headFrame, "PgUp past the head is a no-op");
  } finally {
    await tui.quit();
  }
});

// Enter in budget-edit mode saves through setDailyBudgetUsd, which reads the config FRESH
// (bypassing the display's last-known-good fallback). A broken file therefore fails the
// save while the TUI keeps rendering: the error flashes, the mode stays open so the value
// can be retried, and the broken file is never overwritten with defaults.
test("a budget save on a broken config flashes the error and stays in edit mode", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  const original = fs.readFileSync(cfgPath, "utf8");
  const tui = startTui(repo); // first render: the display caches this last-known-good config
  try {
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "> 50");

    // Break the config AFTER the first render: render falls back to the cached copy, but
    // the saver's fresh loadConfig hits the broken file.
    fs.writeFileSync(cfgPath, "{ not valid json\n");
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "30") tui.key(ch, ch);
    tui.key(undefined, "return");

    assert.match(tui.lastFrame(), /not valid JSON/); // the load failure flashes
    assert.equal(tui.lines().at(-1), "> 30", "still in edit mode with the value kept");
    assert.match(fs.readFileSync(cfgPath, "utf8"), /not valid json/, "the broken file is not overwritten");

    // Once the file is valid again the same draft saves — staying open was a retry, not a dead end.
    fs.writeFileSync(cfgPath, original);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget set to \$30/);
    assert.equal(tui.lines().at(-1), "> ");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { maxDailyCostUsd: number };
    assert.equal(cfg.maxDailyCostUsd, 30);
  } finally {
    await tui.quit();
  }
});
