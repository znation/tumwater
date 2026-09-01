import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readEvents } from "../src/events.js";
import {
  cancelPrompt,
  dequeuePrompt,
  enqueuePrompt,
  inboxSize,
  queuedPrompts,
  submitPrompt,
} from "../src/inbox.js";
import { tmpdir } from "./util.js";

test("inbox is FIFO and dequeues to empty", () => {
  const dir = tmpdir();
  assert.equal(inboxSize(dir), 0);
  assert.equal(dequeuePrompt(dir), null);
  enqueuePrompt(dir, "first");
  enqueuePrompt(dir, "second");
  assert.equal(inboxSize(dir), 2);
  assert.equal(dequeuePrompt(dir), "first");
  assert.equal(dequeuePrompt(dir), "second");
  assert.equal(dequeuePrompt(dir), null);
});

test("submitPrompt trims, enqueues, and logs a prompt_enqueued event", () => {
  const dir = tmpdir();
  const long = "x".repeat(120);
  const queued = submitPrompt(dir, `  ${long}  `);
  assert.equal(queued, long); // trimmed
  assert.equal(inboxSize(dir), 1);
  assert.equal(dequeuePrompt(dir), long);
  const events = readEvents(dir).filter((e) => e.type === "prompt_enqueued");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "director");
  assert.equal(
    String(events[0]?.preview),
    `${"x".repeat(79)}…`, // preview capped at 80 chars, ellipsis included (truncate)
  );
});

test("submitPrompt's event preview never carries a lone surrogate", () => {
  const dir = tmpdir();
  submitPrompt(dir, `${"x".repeat(78)}🎉y`); // the emoji straddles the cut point (code unit 79)
  const events = readEvents(dir).filter((e) => e.type === "prompt_enqueued");
  assert.equal(events.length, 1);
  // The pair is dropped whole rather than split: no lone high surrogate at the cut.
  assert.equal(String(events[0]?.preview), `${"x".repeat(78)}…`);
});

// --- queuedPrompts / cancelPrompt (director inbox management) ---

test("queuedPrompts returns full text in execution order; empty or missing inbox reads []", () => {
  const dir = tmpdir();
  assert.deepEqual(queuedPrompts(dir), []); // no inbox directory at all
  enqueuePrompt(dir, "first");
  enqueuePrompt(dir, "second\nwith a newline");
  // Full text (not previews), oldest first — the same order dequeuePrompt pops by.
  assert.deepEqual(queuedPrompts(dir), ["first", "second\nwith a newline"]);
});

test("cancelPrompt removes by 1-based position and reports the cancelled text", () => {
  const dir = tmpdir();
  enqueuePrompt(dir, "alpha");
  enqueuePrompt(dir, "beta");
  enqueuePrompt(dir, "gamma");

  assert.deepEqual(cancelPrompt(dir, 2), { status: "cancelled", text: "beta" });
  // Siblings keep their relative positions.
  assert.deepEqual(queuedPrompts(dir), ["alpha", "gamma"]);

  // Exactly one prompt_cancelled event under the director loop, like its enqueued sibling.
  const events = readEvents(dir).filter((e) => e.type === "prompt_cancelled");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "director");
  assert.equal(String(events[0]?.preview), "beta");
});

test("cancelPrompt's event preview is truncated to 80 chars and surrogate-safe", () => {
  const dir = tmpdir();
  enqueuePrompt(dir, `${"x".repeat(78)}🎉y`); // the emoji straddles code unit 79
  cancelPrompt(dir, 1);
  const events = readEvents(dir).filter((e) => e.type === "prompt_cancelled");
  assert.equal(events.length, 1);
  // The pair is dropped whole rather than split: no lone high surrogate at the cut.
  assert.equal(String(events[0]?.preview), `${"x".repeat(78)}…`);
});

test("cancelPrompt errors on out-of-range positions without touching any file", () => {
  const dir = tmpdir();
  enqueuePrompt(dir, "alpha");
  for (const pos of [0, -1, 2, 99]) {
    assert.throws(() => cancelPrompt(dir, pos), /no prompt at position/);
  }
  assert.deepEqual(queuedPrompts(dir), ["alpha"], "nothing touched on failure");
});

test("cancelPrompt returns gone when the file disappears between listing and removal", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced");

  // The director dequeued it concurrently: rmSync hits ENOENT after our read succeeded.
  const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  t.mock.method(fs, "rmSync", (() => {
    throw enoent;
  }) as typeof fs.rmSync);
  try {
    assert.deepEqual(cancelPrompt(dir, 1), { status: "gone" }); // no throw
  } finally {
    t.mock.restoreAll();
  }
  // A prompt the director just dequeued ran — it was not cancelled, so no event is logged.
  assert.equal(readEvents(dir).filter((e) => e.type === "prompt_cancelled").length, 0);
});
