import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { dequeueRolePrompt, enqueueRolePrompt, inboxSize, queuedFiles, queuedRolePrompts, takeQueuedFile } from "../src/inbox/inbox.js";
import { cancelQueuedFile } from "../src/inbox/inbox-cancel.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { imageReferenceLines, imageReferencePaths, savePromptImages } from "../src/inbox/inbox-attachments.js";
import { roleInboxDir } from "../src/paths.js";
import type { LoopState } from "../src/runner/runner-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// pending-prompt.ts holds the requeue policy for every tick outcome that leaves a user
// request unfulfilled — the subtle fresh-vs-resume bookkeeping runner.ts rides on. These tests
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
  assert.notEqual(takeQueuedFile(file), null); // the user cancels it mid-flight

  pending.reclaimForResume(s, true);
  assert.equal(pending.get(), null);
  assert.equal(s.resumePromptFile, undefined);
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** One image as submitRolePrompt takes it. */
function png(name: string): { name: string; dataBase64: string } {
  return { name, dataBase64: PNG.toString("base64") };
}

test("settleImages removes a fulfilled request's images and keeps a requeued request's", () => {
  const root = tmpdir();
  // Fulfilled: dequeued, recorded with its queue file, then settled with no requeue — the
  // image goes by the file's stem.
  const file = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", file, [png("a.png")]);
  assert.ok("paths" in saved);
  const text = "look" + imageReferenceLines(saved.paths);
  const pending = new PendingPrompt(root, "qa");
  dequeueRolePrompt(root, "qa"); // consume the original queue entry, as a tick would
  pending.record(text, file);
  assert.ok(fs.existsSync(saved.paths[0]!));
  pending.settleImages();
  assert.ok(!fs.existsSync(saved.paths[0]!), "a fulfilled request's image is removed");

  // Unfulfilled: the request is handed back to the queue, so its image must survive the
  // settle for the next tick to read — moved to the requeued file's stem.
  const file2 = enqueueRolePrompt(root, "qa", "look again");
  const saved2 = savePromptImages(root, "qa", file2, [png("b.png")]);
  assert.ok("paths" in saved2);
  const text2 = "look again" + imageReferenceLines(saved2.paths);
  const pending2 = new PendingPrompt(root, "qa");
  dequeueRolePrompt(root, "qa"); // consume the original queue entry, as a tick would
  pending2.record(text2, file2);
  pending2.requeueUnfulfilled(text2);
  pending2.settleImages();
  const moved = imageReferencePaths(queuedRolePrompts(root, "qa")[0]!)[0];
  assert.ok(moved, "the requeued copy keeps its reference");
  assert.ok(fs.existsSync(moved!), "a requeued request's image survives for the next tick");
  assert.ok(!fs.existsSync(saved2.paths[0]!), "the image moved off the old stem");
});

test("cancel removes an image a requeue moved to the new queue file's stem", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", file, [png("a.png")]);
  assert.ok("paths" in saved);
  const text = "look" + imageReferenceLines(saved.paths);
  const pending = new PendingPrompt(root, "qa");
  dequeueRolePrompt(root, "qa"); // consume the original queue entry, as a tick would
  pending.record(text, file);
  pending.requeueUnfulfilled(text);
  pending.settleImages();
  const requeuedFile = queuedFiles(root, "qa")[0]!;
  const moved = imageReferencePaths(queuedRolePrompts(root, "qa")[0]!)[0]!;
  assert.ok(fs.existsSync(moved), "the requeue moved the image");
  assert.equal(cancelQueuedFile(root, "qa", path.basename(requeuedFile)).status, "cancelled");
  assert.ok(!fs.existsSync(moved), "cancel removed the requeued prompt's image");
});

test("a requeue whose prompt lost one attachment still carries the survivors", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", file, [png("a.png"), png("b.png")]);
  assert.ok("paths" in saved);
  const text = "look" + imageReferenceLines(saved.paths);
  const pending = new PendingPrompt(root, "qa");
  dequeueRolePrompt(root, "qa"); // consume the original queue entry, as a tick would
  pending.record(text, file);
  fs.rmSync(saved.paths[1]!); // one attachment vanishes out of band before the requeue
  pending.requeueUnfulfilled(text);
  pending.settleImages();
  const requeuedFile = queuedFiles(root, "qa")[0]!;
  const requeuedText = queuedRolePrompts(root, "qa")[0]!;
  const survivor = imageReferencePaths(requeuedText)[0]!;
  assert.ok(fs.existsSync(survivor), "the surviving attachment moved to the new queue file's stem");
  assert.ok(!fs.existsSync(saved.paths[0]!), "the old-stem name is gone");
  assert.match(requeuedText, /\[image attachments dropped: 1 image file was missing/);
  assert.equal(cancelQueuedFile(root, "qa", path.basename(requeuedFile)).status, "cancelled");
  assert.ok(!fs.existsSync(survivor), "cancel sweeps the survivor, so no image is orphaned");
});

test("settleImages never deletes a file named by hand-typed prompt text", () => {
  const root = tmpdir();
  const dir = roleInboxDir(root, "qa");
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(dir, "unrelated.png");
  fs.writeFileSync(victim, PNG);
  const file = enqueueRolePrompt(root, "qa", "keep");
  const pending = new PendingPrompt(root, "qa");
  pending.record(`keep\n\n[image attached: ${victim}]`, file);
  pending.settleImages();
  assert.ok(fs.existsSync(victim), "a hand-typed writer-shaped line is content, not an attachment");
});

/** A user prompt enqueued while the interrupted tick's request sits re-queued — the
 * interleaving the reclaim must see through. */
function enqueueLater(dir: string, text: string): void {
  enqueueRolePrompt(dir, "feature", text);
}
