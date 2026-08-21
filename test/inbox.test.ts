import test from "node:test";
import assert from "node:assert/strict";
import { readEvents } from "../src/events.js";
import { dequeuePrompt, enqueuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
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
  assert.equal(String(events[0]?.preview), "x".repeat(80)); // preview capped at 80 chars
});
