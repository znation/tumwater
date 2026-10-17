import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { movePromptToTop } from "../src/inbox/inbox-top.js";
import {
  dequeueRolePrompt,
  enqueueRolePrompt,
  inboxSize,
  queuedFiles,
  queuedRolePromptRecords,
  queuedRolePrompts,
  removeSameStemSiblings,
} from "../src/inbox/inbox.js";
import { imageReferencePaths } from "../src/inbox/inbox-attachments.js";
import { notBeforeMs } from "../src/inbox/prompt-not-before.js";
import { queueFileStamp } from "../src/files/file-queue.js";
import { roleInboxDir } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { errnoError, withThrowingFs } from "./helpers/fs-faults.js";

/** src/inbox/inbox-top.ts's own tests: moving one queued prompt to the head of its role's
 * queue (`tumwater prompt --top <n>`) — position addressing, the race policy, the deferral
 * carry-over, the attachment carry-over, and the prompt_topped event. Mirrors the cancel and
 * edit coverage, since top shares their position resolution and race policy. */

test("movePromptToTop moves the Nth queued prompt to the head, text byte-identical, and logs prompt_topped", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "feature", "first");
  enqueueRolePrompt(root, "feature", "second");
  const third = enqueueRolePrompt(root, "feature", "third");
  const thirdText = fs.readFileSync(third, "utf8");
  // The queue's smallest stamp is the first enqueued prompt's; the moved file takes one below.
  const minStamp = Math.min(
    ...queuedFiles(root, "feature").map((f) => queueFileStamp(path.basename(f)) as number),
  );

  const outcome = movePromptToTop(root, "feature", 3);
  assert.deepEqual(outcome, { status: "topped", preview: "third" });

  // The moved prompt now leads the queue: its file was renamed to a stamp below the old
  // minimum, so it is the oldest (first) entry; the text is byte-identical.
  const after = queuedFiles(root, "feature");
  assert.equal(after.length, 3);
  const movedFile = after[0] as string;
  assert.notEqual(movedFile, third, "the moved prompt has a new (smaller-stamp) file name");
  assert.equal(fs.readFileSync(movedFile, "utf8"), thirdText, "the moved text is byte-identical");
  assert.equal(queueFileStamp(path.basename(movedFile)), minStamp - 1);
  assert.equal(fs.existsSync(third), false, "the old queue file was removed");
  assert.deepEqual(queuedRolePrompts(root, "feature"), ["third", "first", "second"]);
  // The loop dequeues the moved prompt first.
  assert.equal(dequeueRolePrompt(root, "feature"), "third");

  // One prompt_topped event under the target role, previewing the moved prompt.
  const events = eventsOfType(root, "prompt_topped");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "feature");
  assert.equal(String(events[0]?.preview), "third");
});

test("movePromptToTop refuses position 1 (already first) and errors out of range with no side effects", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "feature", "only");

  assert.throws(() => movePromptToTop(root, "feature", 1), /already first/);
  for (const bad of [0, 2, 99]) {
    assert.throws(() => movePromptToTop(root, "feature", bad), /no prompt at position/);
  }
  assert.deepEqual(queuedRolePrompts(root, "feature"), ["only"], "nothing touched on failure");
  assert.equal(eventsOfType(root, "prompt_topped").length, 0, "no event on a failed move");
});

test("movePromptToTop returns gone when the file disappears between listing and reading", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "feature", "a");
  enqueueRolePrompt(root, "feature", "b");

  // The loop dequeued the target concurrently: the read hits ENOENT before any rename — the
  // same race the cancel/edit paths share — reported as gone, never a throw.
  withThrowingFs("readFileSync", errnoError("ENOENT"), () => {
    assert.deepEqual(movePromptToTop(root, "feature", 2), { status: "gone" });
  });
  assert.equal(eventsOfType(root, "prompt_topped").length, 0, "no event on a raced-out move");
});

/** A reorder must carry an attached prompt's image to the new queue file's stem, or the
 * fulfill/cancel sweep (removeSameStemSiblings, keyed on that stem) would never find it. */
test("movePromptToTop carries an attached image to the new stem and leaves no old-stem leak", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "feature", "first");
  enqueueRolePrompt(root, "feature", "second");
  const third = enqueueRolePrompt(root, "feature", "third");
  const oldStem = path.basename(third, ".md");
  const oldImage = path.join(roleInboxDir(root, "feature"), `${oldStem}.png`);
  fs.writeFileSync(oldImage, "png-bytes");
  fs.writeFileSync(third, `third\n\n[image attached: ${oldImage}]`);

  const outcome = movePromptToTop(root, "feature", 3);
  assert.equal(outcome.status, "topped");
  const newFile = queuedFiles(root, "feature")[0] as string;
  const newStem = path.basename(newFile, ".md");
  assert.notEqual(newStem, oldStem);

  // The reference line now names a path under the new stem, and that file exists.
  const ref = imageReferencePaths(fs.readFileSync(newFile, "utf8"))[0] as string;
  assert.ok(ref, "the reference line survived the move");
  assert.equal(fs.existsSync(ref), true, "the image file moved with the prompt");
  assert.ok(path.basename(ref).startsWith(newStem), "the referenced basename matches the new stem");
  assert.equal(fs.existsSync(oldImage), false, "no same-stem sibling is left under the old stem");

  // The fulfilling sweep under the new file finds and removes the moved image.
  removeSameStemSiblings(root, "feature", newFile);
  assert.equal(fs.existsSync(ref), false, "the new-stem image is swept with its prompt");
});

/** A prompt's --at deferral rides in its text; the rename must keep it, or a deferred prompt
 * moved to the front would be delivered early. */
test("movePromptToTop preserves a --at deferral: a future prompt is still not deliverable early", () => {
  const root = tmpdir();
  const dueMs = Date.now() + 60 * 60_000;
  enqueueRolePrompt(root, "feature", "deferred-one", dueMs);
  enqueueRolePrompt(root, "feature", "deferred-two", dueMs);

  // Move position 2 to the head: both are still deferred, so neither becomes deliverable.
  const outcome = movePromptToTop(root, "feature", 2);
  assert.equal(outcome.status, "topped");
  assert.equal(inboxSize(root, "feature"), 0, "a deferred prompt is not counted as deliverable");
  assert.equal(dequeueRolePrompt(root, "feature"), null, "a deferred prompt is not delivered early");

  // The moved prompt sits at the head of the queue and still carries its marker.
  const records = queuedRolePromptRecords(root, "feature");
  assert.equal(records.length, 2);
  assert.ok(String(records[0]?.text).includes("deferred-two"), "the moved (deferred) prompt is first");
  assert.equal(notBeforeMs(records[0]?.text as string), dueMs, "the deferral survives the move");
  assert.equal(records[0]?.notBeforeMs, dueMs);
});

/** Among the deliverable prompts, the moved one is the next delivered — the reorder is a real
 * order change, not just a rename with no delivery consequence. */
test("movePromptToTop makes the moved prompt the next delivered", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "feature", "first");
  enqueueRolePrompt(root, "feature", "second");
  enqueueRolePrompt(root, "feature", "third");

  const move = movePromptToTop(root, "feature", 2);
  assert.equal(move.status, "topped");
  // "second" was position 2; after the move it leads the queue and is the first delivered.
  assert.deepEqual(queuedRolePrompts(root, "feature"), ["second", "first", "third"]);
  assert.equal(dequeueRolePrompt(root, "feature"), "second");
});
