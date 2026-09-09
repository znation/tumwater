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

test("cancelPrompt returns gone when the file disappears between listing and reading", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced");

  // The director dequeued it concurrently: readFileSync hits ENOENT before any removal is
  // even attempted — the earlier half of the same race the rmSync test above covers.
  const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  t.mock.method(fs, "readFileSync", (() => {
    throw enoent;
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual(cancelPrompt(dir, 1), { status: "gone" }); // no throw
  } finally {
    t.mock.restoreAll();
  }
  // A prompt the director just dequeued ran — it was not cancelled, so no event is logged.
  assert.equal(readEvents(dir).filter((e) => e.type === "prompt_cancelled").length, 0);
});

test("cancelPrompt rethrows non-ENOENT errors instead of reporting them as gone", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "locked");
  const eacces: NodeJS.ErrnoException = Object.assign(new Error("EACCES"), { code: "EACCES" });

  // A permission failure is not a race with the director. Reporting it as "gone" would exit
  // clean and tell the user their prompt was taken when nothing happened — both catch blocks
  // must discriminate on ENOENT specifically.
  t.mock.method(fs, "readFileSync", (() => {
    throw eacces;
  }) as typeof fs.readFileSync);
  assert.throws(
    () => cancelPrompt(dir, 1),
    (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === "EACCES",
  );
  t.mock.restoreAll();

  t.mock.method(fs, "rmSync", (() => {
    throw eacces;
  }) as typeof fs.rmSync);
  assert.throws(
    () => cancelPrompt(dir, 1),
    (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === "EACCES",
  );
  t.mock.restoreAll();

  // The prompt is still queued and nothing was logged.
  assert.deepEqual(queuedPrompts(dir), ["locked"]);
  assert.equal(readEvents(dir).filter((e) => e.type === "prompt_cancelled").length, 0);
});

test("dequeuePrompt returns null when the file disappears between listing and reading", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced");

  // A concurrent `tumwater prompt --cancel` removed it after the directory was listed:
  // readFileSync hits ENOENT before any removal is even attempted. The director must see an
  // empty inbox (skip its tick) instead of failing with a raw ENOENT.
  const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  t.mock.method(fs, "readFileSync", (() => {
    throw enoent;
  }) as typeof fs.readFileSync);
  try {
    assert.equal(dequeuePrompt(dir), null); // no throw
  } finally {
    t.mock.restoreAll();
  }
});

test("dequeuePrompt returns null when the file disappears between reading and removal", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced");

  // The cancel won after our read: rmSync hits ENOENT. The prompt was cancelled, so it must
  // not be executed — null (skip), never the text we already read.
  const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  t.mock.method(fs, "rmSync", (() => {
    throw enoent;
  }) as typeof fs.rmSync);
  try {
    assert.equal(dequeuePrompt(dir), null); // no throw, and the read text is not returned
  } finally {
    t.mock.restoreAll();
  }
});

test("dequeuePrompt rethrows non-ENOENT errors instead of reporting them as an empty queue", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "locked");
  const eacces: NodeJS.ErrnoException = Object.assign(new Error("EACCES"), { code: "EACCES" });

  // A permission failure is not a race with a cancel. Returning null would make the director
  // skip its tick while the prompt stays queued — both catch blocks must discriminate on
  // ENOENT specifically, like cancelPrompt's.
  t.mock.method(fs, "readFileSync", (() => {
    throw eacces;
  }) as typeof fs.readFileSync);
  assert.throws(
    () => dequeuePrompt(dir),
    (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === "EACCES",
  );
  t.mock.restoreAll();

  t.mock.method(fs, "rmSync", (() => {
    throw eacces;
  }) as typeof fs.rmSync);
  assert.throws(
    () => dequeuePrompt(dir),
    (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === "EACCES",
  );
  t.mock.restoreAll();

  // The prompt is still queued.
  assert.deepEqual(queuedPrompts(dir), ["locked"]);
});

test("queuedPrompts skips a file that vanishes between listing and reading", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "first");
  const second = enqueuePrompt(dir, "second"); // returns the queued file's path

  // A concurrent dequeue removes one file after the directory was listed: a polled snapshot
  // must skip it instead of crashing on the ENOENT.
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    if (args[0] === second) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return original(...(args as [string | URL, "utf8"]));
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual(queuedPrompts(dir), ["first"]);
  } finally {
    t.mock.restoreAll();
  }
});
