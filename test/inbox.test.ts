import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";import {
  cancelPrompt,
  cancelRolePrompt,
  dequeuePrompt,
  dequeueRolePrompt,
  enqueuePrompt,
  enqueueRolePrompt,
  inboxSize,
  peekRolePrompt,
  queuedPrompts,
  queuedRolePromptEntries,
  queuedRolePrompts,
} from "../src/inbox.js";
import { notBeforeMs } from "../src/prompt-not-before.js";
import { queueFileStamp } from "../src/file-queue.js";
import { submitPrompt, submitRolePrompt } from "../src/inbox-submit.js";
import { eventsOfType } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";
import { errCode } from "../src/errno.js";
import { errnoError } from "./fs-faults.js";

/** Freeze the wall clock for the not-before tests and hand back the ticking handle: the
 * deliverability filters read Date.now(), so node:test's mock Date both pins the stamp math
 * and advances past a marker with one tick. The test context's own mock auto-restores after
 * the test, so one test's clock never leaks into its siblings. */
function mockTimersForInbox(t: TestContext): { tick: (ms: number) => void } {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  return { tick: (ms: number) => t.mock.timers.tick(ms) };
}

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

test("enqueueRolePrompt writes the queue file atomically — exact content, no tmp remnant", () => {
  const dir = tmpdir();
  enqueueRolePrompt(dir, "feature", "hello");
  enqueuePrompt(dir, "second");
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["hello"]);
  assert.deepEqual(queuedPrompts(dir), ["second"]);
  // The tmp+rename write must never leave a *.tmp-* stray behind: a dashboard polling the
  // queue would otherwise list or read one (queuedPrompts reads every .md file in the dir).
  const strays: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = fs.realpathSync(path.join(d, e.name));
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(".tmp-")) strays.push(p);
    }
  };
  walk(dir);
  assert.deepEqual(strays, []);
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
  const events = eventsOfType(dir, "prompt_cancelled");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "director");
  assert.equal(String(events[0]?.preview), "beta");
});

test("cancelPrompt's event preview is truncated to 80 chars and surrogate-safe", () => {
  const dir = tmpdir();
  enqueuePrompt(dir, `${"x".repeat(78)}🎉y`); // the emoji straddles code unit 79
  cancelPrompt(dir, 1);
  const events = eventsOfType(dir, "prompt_cancelled");
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
  const enoent = errnoError("ENOENT");
  t.mock.method(fs, "rmSync", (() => {
    throw enoent;
  }) as typeof fs.rmSync);
  try {
    assert.deepEqual(cancelPrompt(dir, 1), { status: "gone" }); // no throw
  } finally {
    t.mock.restoreAll();
  }
  // A prompt the director just dequeued ran — it was not cancelled, so no event is logged.
  assert.equal(eventsOfType(dir, "prompt_cancelled").length, 0);
});

test("cancelPrompt returns gone when the file disappears between listing and reading", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced");

  // The director dequeued it concurrently: readFileSync hits ENOENT before any removal is
  // even attempted — the earlier half of the same race the rmSync test above covers.
  const enoent = errnoError("ENOENT");
  t.mock.method(fs, "readFileSync", (() => {
    throw enoent;
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual(cancelPrompt(dir, 1), { status: "gone" }); // no throw
  } finally {
    t.mock.restoreAll();
  }
  // A prompt the director just dequeued ran — it was not cancelled, so no event is logged.
  assert.equal(eventsOfType(dir, "prompt_cancelled").length, 0);
});

test("cancelPrompt rethrows non-ENOENT errors instead of reporting them as gone", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "locked");
  const eacces = errnoError("EACCES");

  // A permission failure is not a race with the director. Reporting it as "gone" would exit
  // clean and tell the user their prompt was taken when nothing happened — both catch blocks
  // must discriminate on ENOENT specifically.
  t.mock.method(fs, "readFileSync", (() => {
    throw eacces;
  }) as typeof fs.readFileSync);
  assert.throws(
    () => cancelPrompt(dir, 1),
    (err: unknown) => errCode(err) === "EACCES",
  );
  t.mock.restoreAll();

  t.mock.method(fs, "rmSync", (() => {
    throw eacces;
  }) as typeof fs.rmSync);
  assert.throws(
    () => cancelPrompt(dir, 1),
    (err: unknown) => errCode(err) === "EACCES",
  );
  t.mock.restoreAll();

  // The prompt is still queued and nothing was logged.
  assert.deepEqual(queuedPrompts(dir), ["locked"]);
  assert.equal(eventsOfType(dir, "prompt_cancelled").length, 0);
});

test("dequeuePrompt returns null when the file disappears between listing and reading", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced");

  // A concurrent `tumwater prompt --cancel` removed it after the directory was listed:
  // readFileSync hits ENOENT before any removal is even attempted. The director must see an
  // empty inbox (skip its tick) instead of failing with a raw ENOENT.
  const enoent = errnoError("ENOENT");
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
  const enoent = errnoError("ENOENT");
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
  const eacces = errnoError("EACCES");

  // A permission failure is not a race with a cancel. Returning null would make the director
  // skip its tick while the prompt stays queued — both catch blocks must discriminate on
  // ENOENT specifically, like cancelPrompt's.
  t.mock.method(fs, "readFileSync", (() => {
    throw eacces;
  }) as typeof fs.readFileSync);
  assert.throws(
    () => dequeuePrompt(dir),
    (err: unknown) => errCode(err) === "EACCES",
  );
  t.mock.restoreAll();

  t.mock.method(fs, "rmSync", (() => {
    throw eacces;
  }) as typeof fs.rmSync);
  assert.throws(
    () => dequeuePrompt(dir),
    (err: unknown) => errCode(err) === "EACCES",
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
    if (args[0] === second) throw errnoError("ENOENT");
    return original(...(args as [string | URL, "utf8"]));
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual(queuedPrompts(dir), ["first"]);
  } finally {
    t.mock.restoreAll();
  }
});

test("dequeue survives the queue directory vanishing before the attachment cleanup", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "with images");

  // A concurrent cleanup (retention, an operator's rm -r) removes the whole queue directory
  // between the prompt's removal and the attachment-sibling sweep: readdirSync hits ENOENT.
  // The sweep is best-effort by contract ("a queue directory that is already gone leaves
  // nothing to clean") — the dequeue must still hand back the prompt text, never the error.
  // The first listing readdir (queuedFiles) must pass through; only the sweep's readdir fails.
  const original = fs.readdirSync.bind(fs);
  let calls = 0;
  t.mock.method(fs, "readdirSync", ((...args: unknown[]) => {
    if (++calls > 1) throw errnoError("ENOENT");
    return original(...(args as [string, never]));
  }) as typeof fs.readdirSync);
  try {
    assert.equal(dequeuePrompt(dir), "with images");
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(queuedPrompts(dir), [], "the prompt was still taken off the queue");
});

test("cancel survives the queue directory vanishing before the attachment cleanup", (t) => {
  const dir = tmpdir();
  enqueuePrompt(dir, "raced cleanup");

  // Same race on the cancel path: takeCancelledPrompt rides takeQueuedFile, so the same
  // vanished-directory tolerance applies — the operator sees a clean cancellation, and the
  // prompt_cancelled event is still logged.
  const original = fs.readdirSync.bind(fs);
  let calls = 0;
  t.mock.method(fs, "readdirSync", ((...args: unknown[]) => {
    if (++calls > 1) throw errnoError("ENOENT");
    return original(...(args as [string, never]));
  }) as typeof fs.readdirSync);
  try {
    assert.deepEqual(cancelPrompt(dir, 1), { status: "cancelled", text: "raced cleanup" });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(eventsOfType(dir, "prompt_cancelled").length, 1, "the event still logged");
});

// --- Per-role queues (PLANS.md "Per-role prompts 1/2") ---

test("per-role queues are separate from the director's queue and from each other", () => {
  const dir = tmpdir();
  // The director keeps its historical queue at the inbox root; roles get subdirectories.
  submitPrompt(dir, "for the director");
  submitRolePrompt(dir, "qa", "for qa");
  submitRolePrompt(dir, "qa", "second for qa");
  submitRolePrompt(dir, "docs", "for docs");
  assert.equal(inboxSize(dir), 1, "the director's queue is untouched by role submissions");
  assert.deepEqual(queuedRolePrompts(dir, "qa"), ["for qa", "second for qa"]);
  assert.deepEqual(queuedRolePrompts(dir, "docs"), ["for docs"]);
  assert.deepEqual(queuedRolePrompts(dir, "director"), ["for the director"]);

  // Dequeue is FIFO per queue, and one role's queue never serves another.
  assert.equal(dequeueRolePrompt(dir, "qa"), "for qa");
  assert.equal(dequeueRolePrompt(dir, "qa"), "second for qa");
  assert.equal(dequeueRolePrompt(dir, "qa"), null);
  assert.deepEqual(queuedRolePrompts(dir, "docs"), ["for docs"]);
  assert.equal(dequeueRolePrompt(dir, "docs"), "for docs");
  assert.equal(dequeuePrompt(dir), "for the director");
  assert.equal(dequeuePrompt(dir), null);
  // An empty (or never-created) queue reads as empty, like the director's.
  assert.deepEqual(queuedRolePrompts(dir, "telemetry"), []);
  assert.equal(dequeueRolePrompt(dir, "telemetry"), null);
});

test("submitRolePrompt and cancelRolePrompt log their events under the named loop", () => {
  const dir = tmpdir();
  submitRolePrompt(dir, "qa", "check the flow");
  submitRolePrompt(dir, "qa", "another");
  let events = eventsOfType(dir, "prompt_enqueued");
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.loop === "qa"));
  assert.equal(String(events[0]?.preview), "check the flow");

  // Cancel is per-queue: position 1 in qa's queue is qa's first prompt.
  const outcome = cancelRolePrompt(dir, "qa", 1);
  assert.deepEqual(outcome, { status: "cancelled", text: "check the flow" });
  events = eventsOfType(dir, "prompt_cancelled");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "qa");

  // Out-of-range positions throw with no side effects, exactly like the director's cancel.
  assert.throws(() => cancelRolePrompt(dir, "qa", 5), /no prompt at position 5/);
  assert.throws(() => cancelRolePrompt(dir, "docs", 1), /no prompt at position 1/);
});



test("a deferred prompt is not dequeued before its time and is the first popped after it", (t) => {
  const dir = tmpdir();
  const clock = mockTimersForInbox(t);
  const due = Date.now() + 90 * 60_000;
  enqueueRolePrompt(dir, "feature", "later", due);
  enqueueRolePrompt(dir, "feature", "earlier");
  // The deferred file rides in its enqueue: marker line, blank line, then the prompt — and
  // the marker keeps it out of the execution order until its time arrives.
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["earlier"]);
  assert.equal(dequeueRolePrompt(dir, "feature"), "earlier");
  assert.equal(dequeueRolePrompt(dir, "feature"), null);
  // Advance past the marker: the prompt becomes deliverable and pops first (only) — the
  // marker text rides along, as the plan leaves it for the opaquely-consuming tick.
  clock.tick(91 * 60_000);
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["tumwater:not-before " + new Date(due).toISOString() + "\n\nlater"]);
  assert.equal(dequeueRolePrompt(dir, "feature"), "tumwater:not-before " + new Date(due).toISOString() + "\n\nlater");
  assert.equal(dequeueRolePrompt(dir, "feature"), null);
});

test("a queue holding only deferred prompts dequeues null and reads as empty", (t) => {
  const dir = tmpdir();
  mockTimersForInbox(t);
  enqueueRolePrompt(dir, "feature", "later", Date.now() + 60_000);
  assert.equal(inboxSize(dir, "feature"), 0);
  assert.equal(dequeueRolePrompt(dir, "feature"), null);
  assert.equal(peekRolePrompt(dir, "feature"), null);
});

test("counts exclude deferred prompts and include them once due", (t) => {
  const dir = tmpdir();
  const clock = mockTimersForInbox(t);
  enqueueRolePrompt(dir, "feature", "later", Date.now() + 60_000);
  enqueueRolePrompt(dir, "feature", "now");
  assert.equal(inboxSize(dir, "feature"), 1);
  clock.tick(61_000);
  assert.equal(inboxSize(dir, "feature"), 2);
});

test("cancel by position still reaches a deferred entry", (t) => {
  const dir = tmpdir();
  mockTimersForInbox(t);
  enqueueRolePrompt(dir, "feature", "later", Date.now() + 60_000);
  const outcome = cancelRolePrompt(dir, "feature", 1);
  assert.deepEqual(outcome, { status: "cancelled", text: "tumwater:not-before " + new Date(Date.now() + 60_000).toISOString() + "\n\nlater" });
  assert.equal(inboxSize(dir, "feature"), 0);
});

test("operator content that merely starts with a marker-shaped line is never treated as plumbing", () => {
  const dir = tmpdir();
  // Only the writer's exact `tumwater:not-before <iso-utc>` shape is plumbing. A queued
  // prompt whose own first line starts with the prefix — e.g. one asking a loop to fix the
  // marker feature itself — must deliver verbatim, not be silently deferred or stripped.
  const spoof = "tumwater:not-before 2030-01-01\n\nfix the not-before marker feature";
  const f = enqueueRolePrompt(dir, "feature", spoof);
  assert.equal(notBeforeMs(fs.readFileSync(f, "utf8")), null);
  assert.deepEqual(queuedRolePrompts(dir, "feature"), [spoof]);
  assert.equal(dequeueRolePrompt(dir, "feature"), spoof);
  // Loose date spellings a hand-edited file might carry are malformed too: deliver now.
  for (const stamp of ["tomorrow", "Dec 25 2030", "2030-01-01T00:00:00Z"]) {
    const text = `tumwater:not-before ${stamp}\n\ncontent`;
    const g = enqueueRolePrompt(dir, "feature", "x");
    fs.writeFileSync(g, text);
    assert.equal(notBeforeMs(text), null, stamp);
    assert.deepEqual(queuedRolePrompts(dir, "feature"), [text], stamp);
    assert.equal(dequeueRolePrompt(dir, "feature"), text, stamp);
  }
});

test("a malformed or missing not-before marker reads as deliverable", () => {
  const dir = tmpdir();
  const f1 = enqueueRolePrompt(dir, "feature", "no marker");
  assert.equal(fs.readFileSync(f1, "utf8"), "no marker");
  assert.equal(dequeueRolePrompt(dir, "feature"), "no marker");
  // Hand-edited malformed markers never strand a prompt: unparseable stamps deliver.
  const f2 = enqueueRolePrompt(dir, "feature", "broken marker");
  fs.writeFileSync(f2, "tumwater:not-before not-a-timestamp\n\nbroken marker");
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["tumwater:not-before not-a-timestamp\n\nbroken marker"]);
  assert.equal(dequeueRolePrompt(dir, "feature"), "tumwater:not-before not-a-timestamp\n\nbroken marker");
  // A parseable stamp parses through notBeforeMs; entries carry it for the countdowns.
  const f3 = enqueueRolePrompt(dir, "feature", "stamped", 1_000_000_000);
  const text = fs.readFileSync(f3, "utf8");
  assert.match(text, /^tumwater:not-before \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\n\nstamped$/);
  assert.equal(notBeforeMs(text), 1_000_000_000);
  assert.deepEqual(queuedRolePromptEntries(dir, "feature"), [
    {
      file: path.basename(f3),
      preview: "stamped",
      queuedAtMs: queueFileStamp(path.basename(f3)),
      notBeforeMs: 1_000_000_000,
    },
  ]);
});
