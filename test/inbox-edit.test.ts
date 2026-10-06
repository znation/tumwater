import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { editListedPrompt, editRolePrompt } from "../src/inbox/inbox-edit.js";
import { enqueuePrompt, enqueueRolePrompt, queuedRolePromptRecords, queuedRolePrompts } from "../src/inbox/inbox.js";
import { cancelListedPrompt } from "../src/inbox/inbox-cancel.js";
import { notBeforeMs } from "../src/prompt/prompt-not-before.js";
import { queueFileStamp } from "../src/file-queue.js";
import { eventsOfType } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";
import { errnoError } from "./fs-faults.js";
import { DIRECTOR_ROLE } from "../src/roles.js";

/** src/inbox/inbox-edit.ts's own tests: the edit half of the prompt queues — rewriting one queued
 * prompt's text in place, by per-loop position or by list-wide numbering — mirrors
 * inbox.test.ts's cancel coverage: position addressing, the race policy, the deferral
 * carry-over, and the prompt_edited event. */

test("editRolePrompt rewrites one queued prompt in place — same file, same stamp, same position", () => {
  const root = tmpdir();
  const first = enqueueRolePrompt(root, "bugfix", "typo text");
  enqueueRolePrompt(root, "bugfix", "second");
  const stampBefore = queueFileStamp(path.basename(first));

  const outcome = editRolePrompt(root, "bugfix", 1, "fixed text");
  assert.deepEqual(outcome, { status: "edited", oldText: "typo text", newText: "fixed text" });

  // Same queue file, rewritten in place: the enqueue stamp the filename carries is
  // untouched and the second entry is untouched.
  assert.equal(fs.existsSync(first), true, "the queue file was not replaced");
  assert.equal(queueFileStamp(path.basename(first)), stampBefore, "the filename is unchanged");
  assert.deepEqual(queuedRolePrompts(root, "bugfix"), ["fixed text", "second"]);

  // One prompt_edited event under the target loop, previewing the new text.
  const events = eventsOfType(root, "prompt_edited");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "bugfix");
  assert.equal(String(events[0]?.preview), "fixed text");
});

test("editRolePrompt carries a pending --at deferral over — same not-before time, new content, no doubled marker", () => {
  const root = tmpdir();
  const dueMs = Date.now() + 45 * 60 * 1000;
  const file = enqueueRolePrompt(root, "bugfix", "stale instruction", dueMs);

  const outcome = editRolePrompt(root, "bugfix", 1, "corrected instruction");
  assert.deepEqual(outcome, { status: "edited", oldText: "stale instruction", newText: "corrected instruction" });

  // The written file keeps exactly one writer-shaped marker, carrying the same not-before
  // time the prompt was queued with, over the new text.
  const text = fs.readFileSync(file, "utf8");
  assert.equal((text.match(/tumwater:not-before /g) ?? []).length, 1, "the marker is not doubled");
  assert.equal(notBeforeMs(text), dueMs, "the deferral survives the edit unchanged");
  assert.ok(text.endsWith("corrected instruction"));
  // The record the listing reads agrees: same deferral, new content.
  const records = queuedRolePromptRecords(root, "bugfix");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.notBeforeMs, dueMs);
  assert.ok(String(records[0]?.text).endsWith("corrected instruction"));
});

test("editRolePrompt keeps a non-deferred prompt marker-free even when the new text resembles a marker", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "bugfix", "ordinary prompt");

  // The new text starts with the marker prefix but is not the writer's marker shape
  // (no full ISO stamp line plus blank separator) — it is content, and the edit must not
  // promote it to plumbing by prepending anything or leave a marker behind.
  const newText = "tumwater:not-before ask the loop to fix the marker vocabulary";
  const outcome = editRolePrompt(root, "bugfix", 1, newText);
  assert.deepEqual(outcome, { status: "edited", oldText: "ordinary prompt", newText });
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text, newText, "no marker was prepended or appended");
  assert.equal(notBeforeMs(text), null, "the prompt stays deliverable now");
});

test("editRolePrompt errors on out-of-range positions without touching any file", () => {
  const root = tmpdir();
  enqueuePrompt(root, "alpha");
  for (const pos of [0, -1, 2, 99]) {
    assert.throws(() => editRolePrompt(root, DIRECTOR_ROLE, pos, "new"), /no prompt at position/);
  }
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["alpha"], "nothing touched on failure");
  assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a failed edit");
});

test("editRolePrompt returns gone when the file disappears between listing and reading", (t: TestContext) => {
  const root = tmpdir();
  enqueuePrompt(root, "raced");

  // The director dequeued it concurrently: readFileSync hits ENOENT before any write is
  // even attempted — the race the edit shares with takeCancelledPrompt.
  const enoent = errnoError("ENOENT");
  t.mock.method(fs, "readFileSync", (() => {
    throw enoent;
  }) as typeof fs.readFileSync);
  try {
    assert.deepEqual(editRolePrompt(root, DIRECTOR_ROLE, 1, "new"), { status: "gone" }); // no throw
  } finally {
    t.mock.restoreAll();
  }
  // A prompt the director just dequeued ran — it was not edited, so no event is logged.
  assert.equal(eventsOfType(root, "prompt_edited").length, 0);
});

function mockRead(t: TestContext, err: NodeJS.ErrnoException): void {
  t.mock.method(fs, "readFileSync", (() => {
    throw err;
  }) as typeof fs.readFileSync);
}

test("editRolePrompt rethrows EACCES (a permission failure is not a race)", (t: TestContext) => {
  const root = tmpdir();
  enqueuePrompt(root, "locked");
  mockRead(t, errnoError("EACCES"));
  assert.throws(() => editRolePrompt(root, DIRECTOR_ROLE, 1, "new"), /EACCES|permission/);
});

test("editListedPrompt resolves the --list numbering like cancel: one hit, ambiguity, miss", () => {
  const root = tmpdir();
  enqueuePrompt(root, "for the director");

  // No --role, position 1: only the director's queue is long enough, so the edit lands
  // there — the outcome names the loop.
  const listed = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1, "edited");
  assert.equal(listed.status, "edited");
  assert.equal(listed.status !== "edited" ? null : listed.role, DIRECTOR_ROLE);
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["edited"]);
  assert.deepEqual(queuedRolePrompts(root, "clean"), []);

  // Several loops hold the position: an ambiguity the caller reports with the --role
  // escape hatch — nothing is edited.
  enqueueRolePrompt(root, "clean", "also first for clean");
  const ambiguous = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1, "edited");
  assert.deepEqual(ambiguous, { status: "ambiguous", roles: [DIRECTOR_ROLE, "clean"] });
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["edited"], "an ambiguity edits nothing");
  assert.deepEqual(queuedRolePrompts(root, "clean"), ["also first for clean"]);

  // No loop holds the position (both queues hold one entry): a miss carrying the largest
  // queue length.
  const missing = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 3, "edited");
  assert.deepEqual(missing, { status: "missing", queued: 1 });
  assert.equal(eventsOfType(root, "prompt_edited").length, 1, "only the one resolved edit logged");
});

/** The shared resolveListedQueue refactor must not have moved cancel's behavior: the same
 * scope and position resolve to the same loop for both verbs, and both touch only that
 * loop's queue. */
test("editListedPrompt and cancelListedPrompt resolve the same position to the same loop", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "clean", "only entry anywhere");
  const cancelled = cancelListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.status !== "cancelled" ? null : cancelled.role, "clean");
  assert.deepEqual(queuedRolePrompts(root, "clean"), []);

  enqueueRolePrompt(root, "clean", "back again");
  const edited = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1, "edited in the same loop");
  assert.equal(edited.status, "edited");
  assert.equal(edited.status !== "edited" ? null : edited.role, "clean");
  assert.deepEqual(queuedRolePrompts(root, "clean"), ["edited in the same loop"]);
});