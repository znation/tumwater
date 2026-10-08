import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { enqueueRolePrompt, inboxSize, queuedRolePrompts, takeQueuedFile } from "../src/inbox/inbox.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import type { LoopState } from "../src/loop/loop-state.js";
import { tmpdir } from "./repo-fixtures.js";

// pending-prompt.ts holds the requeue policy for every tick outcome that leaves a user
// request unfulfilled — the subtle fresh-vs-resume bookkeeping loop.ts rides on. These tests
// pin that policy directly against a real queue directory (the same mechanics inbox.test.ts
// exercises), because a wrong requeue either loses a user request or runs it twice.

function state(): LoopState {
  return { loop: "feature", state: "idle" } as unknown as LoopState;
}

/** resumePromptFile via a function boundary — reading the property directly after an
 * `assert.equal(..., undefined)` narrows it for the rest of the test, and the requeue's
 * assignment happens inside PendingPrompt where TypeScript cannot see it. */
function resumeFile(s: LoopState): string | undefined {
  return s.resumePromptFile;
}

test("record keeps the first non-null prompt and ignores nulls; get starts null", () => {
  const dir = tmpdir();
  const pending = new PendingPrompt(dir, DIRECTOR_ROLE);
  assert.equal(pending.get(), null);
  pending.record(null);
  assert.equal(pending.get(), null);
  pending.record("first request");
  pending.record(null);
  assert.equal(pending.get(), "first request");
  pending.record("second request");
  assert.equal(pending.get(), "second request");
});

test("clear drops the recorded prompt without requeueing it", () => {
  const dir = tmpdir();
  const pending = new PendingPrompt(dir, DIRECTOR_ROLE);
  pending.record("do a thing");
  pending.clear();
  assert.equal(pending.get(), null);
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 0);
});

test("requeueUnfulfilled puts the prompt back in the role's own queue — never across loops", () => {
  const dir = tmpdir();
  const pending = new PendingPrompt(dir, "feature");
  pending.requeueUnfulfilled("retry me");
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["retry me"]);
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 0);

  const director = new PendingPrompt(dir, DIRECTOR_ROLE);
  director.requeueUnfulfilled("retry me too");
  assert.deepEqual(queuedRolePrompts(dir, DIRECTOR_ROLE), ["retry me too"]);
});

test("requeueUnfulfilled ignores null; requeuePendingUnfulfilled requeues and clears memory", () => {
  const dir = tmpdir();
  const pending = new PendingPrompt(dir, DIRECTOR_ROLE);
  pending.requeueUnfulfilled(null);
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 0);

  pending.record("half-done request");
  pending.requeuePendingUnfulfilled();
  assert.deepEqual(queuedRolePrompts(dir, DIRECTOR_ROLE), ["half-done request"]);
  assert.equal(pending.get(), null);

  // With nothing recorded (the common case once the pi run is accounted for), the catch
  // handler must not enqueue an empty prompt.
  pending.requeuePendingUnfulfilled();
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 1);
});

test("requeueForResume: director takes the plain path; a role loop records the queue file", () => {
  const dir = tmpdir();
  const s = state();

  const director = new PendingPrompt(dir, DIRECTOR_ROLE);
  director.requeueForResume(s, "resume me");
  assert.deepEqual(queuedRolePrompts(dir, DIRECTOR_ROLE), ["resume me"]);
  assert.equal(s.resumePromptFile, undefined);

  const feature = new PendingPrompt(dir, "feature");
  feature.requeueForResume(s, "resume me");
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["resume me"]);
  const recorded = resumeFile(s);
  assert.ok(recorded, "role loops must record the queue file for the reclaim");
  assert.ok(recorded.includes("feature"), "the file lives in the role's own queue");
});

test("requeueForResume ignores null without touching the resume record", () => {
  const dir = tmpdir();
  const s = state();
  new PendingPrompt(dir, "feature").requeueForResume(s, null);
  assert.equal(inboxSize(dir, "feature"), 0);
  assert.equal(s.resumePromptFile, undefined);
});

test("reclaimForResume consumes the flag even when not resuming — a stale record never survives", () => {
  const dir = tmpdir();
  const s = state();
  const pending = new PendingPrompt(dir, "feature");
  pending.requeueForResume(s, "queued for restart");
  const file = s.resumePromptFile!;

  pending.reclaimForResume(s, false);
  assert.equal(s.resumePromptFile, undefined);
  // Not resuming: the prompt stays queued for a later fresh tick; memory keeps its value.
  assert.equal(inboxSize(dir, "feature"), 1);
  fs.rmSync(file);
});

test("reclaimForResume takes the exact recorded file, not whatever enqueued meanwhile", () => {
  const dir = tmpdir();
  const s = state();
  const pending = new PendingPrompt(dir, "feature");
  pending.requeueForResume(s, "the interrupted request");
  const file = s.resumePromptFile!;
  enqueueLater(dir, "a newer request");

  pending.reclaimForResume(s, true);
  assert.equal(pending.get(), "the interrupted request");
  assert.equal(s.resumePromptFile, undefined);
  // The reclaim removed its file; the newer one stays queued.
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["a newer request"]);
  assert.ok(!fs.existsSync(file));
});

test("reclaimForResume reclaims nothing when the file was cancelled meanwhile", () => {
  const dir = tmpdir();
  const s = state();
  const pending = new PendingPrompt(dir, "feature");
  pending.requeueForResume(s, "cancelled before the resume");
  const file = s.resumePromptFile!;
  assert.notEqual(takeQueuedFile(dir, "feature", file), null); // the user cancels it mid-flight

  pending.reclaimForResume(s, true);
  assert.equal(pending.get(), null);
  assert.equal(s.resumePromptFile, undefined);
});

/** A user prompt enqueued while the interrupted tick's request sits re-queued — the
 * interleaving the reclaim must see through. */
function enqueueLater(dir: string, text: string): void {
  enqueueRolePrompt(dir, "feature", text);
}
