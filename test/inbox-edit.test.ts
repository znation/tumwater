import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { editListedPrompt, editQueuedFile, editRolePrompt, readQueuedPromptBody } from "../src/inbox/inbox-edit.js";
import { enqueuePrompt, enqueueRolePrompt, queuedFiles, queuedRolePromptRecords, queuedRolePrompts } from "../src/inbox/inbox.js";
import { cancelListedPrompt } from "../src/inbox/inbox-cancel.js";
import { DIRECTOR_PROMPT_MAX_CHARS, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { imageReferencePaths } from "../src/inbox/inbox-attachments.js";
import { notBeforeMs } from "../src/inbox/prompt-not-before.js";
import { queueFileStamp } from "../src/files/file-queue.js";
import { roleInboxDir } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { errnoError, withThrowingFs } from "./helpers/fs-faults.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";

/** src/inbox/inbox-edit.ts's own tests: the edit half of the prompt queues — rewriting one queued
 * prompt's text in place, by per-role position or by list-wide numbering — mirrors
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

  // One prompt_edited event under the target role, previewing the new text.
  const events = eventsOfType(root, "prompt_edited");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "bugfix");
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
  const newText = "tumwater:not-before ask the role to fix the marker vocabulary";
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

test("editRolePrompt refuses an over-cap replacement, like every enqueue path", () => {
  const root = tmpdir();
  enqueuePrompt(root, "short enough");

  // The edited text rides into the target run's prefill exactly like a queued prompt, so
  // the submission cap applies: an edit must not smuggle in the megabyte a submit rejects.
  const overCap = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.throws(
    () => editRolePrompt(root, DIRECTOR_ROLE, 1, overCap),
    /shorten it to at most/,
  );
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["short enough"], "nothing touched on failure");
  assert.equal(eventsOfType(root, "prompt_edited").length, 0, "no event on a failed edit");
});

test("editRolePrompt measures and stores one text, so padding cannot smuggle an over-cap edit", () => {
  const root = tmpdir();
  enqueuePrompt(root, "short enough");

  // The cap probe trims, but the write did not: a body at exactly the cap, padded with
  // whitespace the probe discards, was measured as fitting and stored whole — an over-cap
  // queue file larger than any submission the same cap admits.
  const padded = " ".repeat(8) + "x".repeat(DIRECTOR_PROMPT_MAX_CHARS) + " ".repeat(8);
  const outcome = editRolePrompt(root, DIRECTOR_ROLE, 1, padded);
  assert.equal(outcome.status, "edited");
  const written = outcome.status === "edited" ? outcome.newText : "";
  assert.equal(written.length, DIRECTOR_PROMPT_MAX_CHARS, "the stored text satisfies the cap it was measured against");
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["x".repeat(DIRECTOR_PROMPT_MAX_CHARS)]);
});

test("editRolePrompt returns gone when the file disappears between listing and reading", () => {
  const root = tmpdir();
  enqueuePrompt(root, "raced");

  // The director dequeued it concurrently: readFileSync hits ENOENT before any write is
  // even attempted — the race the edit shares with takeCancelledPrompt.
  withThrowingFs("readFileSync", errnoError("ENOENT"), () => {
    assert.deepEqual(editRolePrompt(root, DIRECTOR_ROLE, 1, "new"), { status: "gone" }); // no throw
  });
  // A prompt the director just dequeued ran — it was not edited, so no event is logged.
  assert.equal(eventsOfType(root, "prompt_edited").length, 0);
});

test("editRolePrompt rethrows EACCES (a permission failure is not a race)", () => {
  const root = tmpdir();
  enqueuePrompt(root, "locked");
  withThrowingFs("readFileSync", errnoError("EACCES"), () => {
    assert.throws(() => editRolePrompt(root, DIRECTOR_ROLE, 1, "new"), /EACCES|permission/);
  });
});

test("editListedPrompt resolves the --list numbering like cancel: one hit, ambiguity, miss", () => {
  const root = tmpdir();
  enqueuePrompt(root, "for the director");

  // No --role, position 1: only the director's queue is long enough, so the edit lands
  // there — the outcome names the role.
  const listed = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1, "edited");
  assert.equal(listed.status, "edited");
  assert.equal(listed.status !== "edited" ? null : listed.role, DIRECTOR_ROLE);
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["edited"]);
  assert.deepEqual(queuedRolePrompts(root, "clean"), []);

  // Several roles hold the position: an ambiguity the caller reports with the --role
  // escape hatch — nothing is edited.
  enqueueRolePrompt(root, "clean", "also first for clean");
  const ambiguous = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1, "edited");
  assert.deepEqual(ambiguous, { status: "ambiguous", roles: [DIRECTOR_ROLE, "clean"] });
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["edited"], "an ambiguity edits nothing");
  assert.deepEqual(queuedRolePrompts(root, "clean"), ["also first for clean"]);

  // No role holds the position (both queues hold one entry): a miss carrying the largest
  // queue length.
  const missing = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 3, "edited");
  assert.deepEqual(missing, { status: "missing", queued: 1 });
  assert.equal(eventsOfType(root, "prompt_edited").length, 1, "only the one resolved edit logged");
});

/** The shared resolveListedQueue refactor must not have moved cancel's behavior: the same
 * scope and position resolve to the same role for both verbs, and both touch only that
 * role's queue. */
test("editListedPrompt and cancelListedPrompt resolve the same position to the same role", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "clean", "only entry anywhere");
  const cancelled = cancelListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.status !== "cancelled" ? null : cancelled.role, "clean");
  assert.deepEqual(queuedRolePrompts(root, "clean"), []);

  enqueueRolePrompt(root, "clean", "back again");
  const edited = editListedPrompt(root, [DIRECTOR_ROLE, "clean"], 1, "edited in the same role");
  assert.equal(edited.status, "edited");
  assert.equal(edited.status !== "edited" ? null : edited.role, "clean");
  assert.deepEqual(queuedRolePrompts(root, "clean"), ["edited in the same role"]);
});

/** An edit replaces the prompt's text, not its attachments: the image reference lines (and
 * so the sibling files they name) must survive, or the receiving role reads no image and the
 * file is orphaned with `--edit` giving no way to restore it. */
test("editRolePrompt keeps an attached prompt's image reference and its file", () => {
  const root = tmpdir();
  submitRolePrompt(root, "feature", "screenshot this", [
    { name: "shot.png", dataBase64: Buffer.from("png-bytes").toString("base64") },
  ]);
  const before = queuedRolePrompts(root, "feature")[0] as string;
  const imagePath = imageReferencePaths(before)[0] as string;
  assert.ok(fs.existsSync(imagePath), "the attachment file exists before the edit");

  const outcome = editRolePrompt(root, "feature", 1, "screenshot that");
  assert.equal(outcome.status, "edited");

  const after = queuedRolePrompts(root, "feature")[0] as string;
  assert.match(after, /^screenshot that/);
  assert.equal(imageReferencePaths(after)[0], imagePath, "the reference line survives the edit");
  assert.equal(fs.existsSync(imagePath), true, "the image file is not orphaned");
});

test("editRolePrompt with images appends new reference lines after the carried set, under the same deferral", () => {
  const root = tmpdir();
  const dueMs = Date.now() + 45 * 60_000;
  submitRolePrompt(
    root,
    "feature",
    "screenshot this",
    [{ name: "one.png", dataBase64: Buffer.from("one").toString("base64") }],
    dueMs,
  );
  // The prompt is deferred, so read it through the records (queuedRolePrompts filters to
  // deliverable prompts); the edit still carries the marker over.
  const carried = imageReferencePaths(queuedRolePromptRecords(root, "feature")[0]?.text as string);

  const outcome = editRolePrompt(root, "feature", 1, "screenshot that", [
    { name: "two.jpg", dataBase64: Buffer.from("two").toString("base64") },
  ]);
  assert.equal(outcome.status, "edited");

  const after = queuedRolePromptRecords(root, "feature")[0]?.text as string;
  const refs = imageReferencePaths(after);
  assert.equal(refs.length, 2, "the carried reference plus the new one");
  assert.equal(refs[0], carried[0], "the carried reference stays first");
  assert.ok(fs.existsSync(refs[0]!), "the carried image survives");
  assert.ok(fs.existsSync(refs[1]!), "the new image was saved");
  assert.match(after, /^screenshot that$/m);
  // The deferral rides the same queue file, unchanged.
  assert.equal(queuedRolePromptRecords(root, "feature")[0]?.notBeforeMs, dueMs);
  assert.equal(eventsOfType(root, "prompt_edited").length, 1);
});

test("editRolePrompt's new image does not overwrite the prompt's existing same-extension image", () => {
  const root = tmpdir();
  submitRolePrompt(root, "feature", "screenshot this", [
    { name: "one.png", dataBase64: Buffer.from("original-bytes").toString("base64") },
  ]);
  const existing = imageReferencePaths(queuedRolePrompts(root, "feature")[0] as string)[0] as string;
  const stem = path.basename(existing, ".png");

  const outcome = editRolePrompt(root, "feature", 1, "still screenshotted", [
    { name: "two.png", dataBase64: Buffer.from("new-bytes").toString("base64") },
  ]);
  assert.equal(outcome.status, "edited");

  const refs = imageReferencePaths(queuedRolePrompts(root, "feature")[0] as string);
  assert.equal(refs.length, 2);
  assert.equal(refs[0], existing, "the existing reference is unchanged");
  assert.equal(path.basename(refs[1]!), `${stem}-2.png`, "the new image dedups to -2");
  assert.deepEqual(fs.readFileSync(existing), Buffer.from("original-bytes"), "the existing file is byte-unchanged");
  assert.deepEqual(fs.readFileSync(refs[1]!), Buffer.from("new-bytes"));
});

test("editRolePrompt refuses an image count over four before saving any image", () => {
  const root = tmpdir();
  const images = [1, 2, 3, 4].map((n) => ({
    name: `${n}.png`,
    dataBase64: Buffer.from(`img-${n}`).toString("base64"),
  }));
  submitRolePrompt(root, "feature", "four images", images);
  const before = queuedRolePrompts(root, "feature")[0] as string;
  assert.equal(imageReferencePaths(before).length, 4);
  const dir = roleInboxDir(root, "feature");
  const dirBefore = fs.readdirSync(dir).sort();

  assert.throws(
    () =>
      editRolePrompt(root, "feature", 1, "five images", [
        { name: "5.png", dataBase64: Buffer.from("img-5").toString("base64") },
      ]),
    /at most 4 images per prompt \(got 5\)/,
  );
  assert.deepEqual(queuedRolePrompts(root, "feature"), [before], "the queue is untouched");
  assert.deepEqual(fs.readdirSync(dir).sort(), dirBefore, "no image was saved");
});

test("editRolePrompt removes the image it just saved when the composed text is over the cap", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, DIRECTOR_ROLE, "short");
  const dir = roleInboxDir(root, DIRECTOR_ROLE);
  const before = fs.readdirSync(dir).sort();

  // The body alone fits the cap; the appended reference line pushes the composed text over,
  // so the save must be unwound along with the failed edit.
  assert.throws(
    () =>
      editRolePrompt(root, DIRECTOR_ROLE, 1, "x".repeat(DIRECTOR_PROMPT_MAX_CHARS), [
        { name: "big.png", dataBase64: Buffer.from("bytes").toString("base64") },
      ]),
    /shorten it to at most/,
  );
  assert.deepEqual(queuedRolePrompts(root, DIRECTOR_ROLE), ["short"], "nothing edited");
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "the just-saved image was unlinked");
});

/** Seed a queue file at an exact basename, so the file-addressed entry points can be driven
 * without depending on enqueueRolePrompt's stamp. */
function seedQueueFile(root: string, role: string, name: string, text: string): string {
  const dir = roleInboxDir(root, role);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

/** editQueuedFile is editRolePrompt's file-addressed twin: the dashboard's edit affordance
 * names the queue file a 1 s-stale poll showed, so the write can never land on another entry. */
test("editQueuedFile rewrites one named queue file in place and returns the edit outcome", () => {
  const root = tmpdir();
  const file = seedQueueFile(root, "qa", "q.md", "old text");
  seedQueueFile(root, "qa", "sibling.md", "sibling text");

  const outcome = editQueuedFile(root, "qa", "q.md", "new text");
  assert.deepEqual(outcome, { status: "edited", oldText: "old text", newText: "new text" });
  assert.equal(fs.readFileSync(file, "utf8"), "new text", "the named file holds the new body");
  assert.equal(path.basename(file), "q.md", "the queue file is not replaced");
  assert.equal(fs.readFileSync(path.join(roleInboxDir(root, "qa"), "sibling.md"), "utf8"), "sibling text");
  assert.deepEqual(queuedRolePrompts(root, "qa"), ["new text", "sibling text"]);

  const events = eventsOfType(root, "prompt_edited");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "qa");
});

test("editQueuedFile refuses a name failing queueFileNameProblem, touching nothing", () => {
  const root = tmpdir();
  const file = seedQueueFile(root, "qa", "q.md", "old");
  for (const bad of ["../x.md", "q.txt"]) {
    assert.throws(() => editQueuedFile(root, "qa", bad, "new"), /file/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "old", "a rejected name changes nothing");
  assert.deepEqual(queuedRolePrompts(root, "qa"), ["old"]);
  assert.equal(eventsOfType(root, "prompt_edited").length, 0);
});

test("editQueuedFile returns gone when the named file has vanished", () => {
  const root = tmpdir();
  assert.deepEqual(editQueuedFile(root, "qa", "q.md", "new"), { status: "gone" });
});

test("editQueuedFile keeps an attached prompt's image reference and its file", () => {
  const root = tmpdir();
  const imagePath = path.join(roleInboxDir(root, "qa"), "q.png");
  seedQueueFile(root, "qa", "q.md", `old text\n\n[image attached: ${imagePath}]`);
  fs.writeFileSync(imagePath, "png-bytes");

  const outcome = editQueuedFile(root, "qa", "q.md", "new text");
  assert.equal(outcome.status, "edited");
  const after = fs.readFileSync(path.join(roleInboxDir(root, "qa"), "q.md"), "utf8");
  assert.match(after, /^new text/);
  assert.equal(imageReferencePaths(after)[0], imagePath, "the reference line survives the edit");
  assert.equal(fs.existsSync(imagePath), true, "the image file is not orphaned");
});

/** readQueuedPromptBody is the editor's read half: it must show the text a user edits, never
 * the deferral marker or the attachment reference block, both of which the edit carries over
 * untouched. */
test("readQueuedPromptBody strips the not-before marker and the image reference lines", () => {
  const root = tmpdir();
  const dueMs = Date.now() + 45 * 60_000;
  submitRolePrompt(
    root,
    "qa",
    "read me",
    [{ name: "shot.png", dataBase64: Buffer.from("png-bytes").toString("base64") }],
    dueMs,
  );
  const name = path.basename(queuedFiles(root, "qa")[0] as string);

  assert.equal(readQueuedPromptBody(root, "qa", name), "read me", "marker and reference block stripped");
  assert.equal(readQueuedPromptBody(root, "qa", "missing.md"), null, "a vanished file reads as gone");
  assert.throws(() => readQueuedPromptBody(root, "qa", "../x.md"), /file/);
});
