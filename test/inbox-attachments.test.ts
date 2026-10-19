import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  imageReferenceLines,
  imageReferencePaths,
  movePromptImages,
  PROMPT_IMAGES_MAX_COUNT,
  promptImagesProblem,
  promptImageExtensionProblem,
  savePromptImages,
  stripVanishedImageReferences,
} from "../src/inbox/inbox-attachments.js";
import { cancelQueuedFile } from "../src/inbox/inbox-cancel.js";
import { dequeueRolePrompt, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { roleInboxDir } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

// A minimal PNG-shaped payload — the harness never opens the images, so only the bytes'
// round-trip through base64 matters here.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const png = (): { name: string; dataBase64: string } => ({ name: "shot.png", dataBase64: PNG.toString("base64") });

test("promptImagesProblem accepts valid images and names every rule it enforces", () => {
  assert.equal(promptImagesProblem([]), null);
  assert.equal(promptImagesProblem([png()]), null);
  assert.match(String(promptImagesProblem("nope")), /images must be an array/);
  assert.match(
    String(promptImagesProblem(Array.from({ length: PROMPT_IMAGES_MAX_COUNT + 1 }, png))),
    new RegExp(`at most ${PROMPT_IMAGES_MAX_COUNT} images`),
  );
  assert.match(String(promptImagesProblem([42])), /each image must be/);
  assert.match(String(promptImagesProblem([{ dataBase64: "aaaa" }])), /needs a file name/);
  assert.match(String(promptImagesProblem([{ name: "notes.txt", dataBase64: "aaaa" }])), /unsupported image type/);
  assert.match(String(promptImagesProblem([{ name: "shot.png" }])), /dataBase64/);
  assert.match(String(promptImagesProblem([{ name: "shot.png", dataBase64: "not@base64!" }])), /valid base64/);
  assert.match(
    String(promptImagesProblem([{ name: "shot.png", dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }])),
    /at most 5242880 \(5 MiB\) per image/,
  );
});

test("promptImageExtensionProblem names the near miss on a mistyped extension, the list alone otherwise", () => {
  // A listed extension is accepted, and a mistyped one names its match after the list.
  assert.equal(promptImageExtensionProblem("shot.png"), null);
  assert.match(String(promptImageExtensionProblem("shot.pnng")), /did you mean `\.png`/);
  // A far-off extension and a no-extension name get the list but no hint.
  assert.match(String(promptImageExtensionProblem("notes.txt")), /expected one of/);
  assert.doesNotMatch(String(promptImageExtensionProblem("notes.txt")), /did you mean/);
  assert.doesNotMatch(String(promptImageExtensionProblem("README")), /did you mean/);
});

test("savePromptImages writes beside the queue file under the same stem, sanitized and deduplicated", () => {
  const root = tmpdir();
  const queueFile = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", queueFile, [
    png(),
    { name: "second.png", dataBase64: PNG.toString("base64") },
    { name: "../../etc/passwd.jpeg", dataBase64: PNG.toString("base64") },
    { name: "my shot (1).png", dataBase64: PNG.toString("base64") },
  ]);
  assert.ok("paths" in saved);
  const dir = roleInboxDir(root, "qa");
  const stem = path.basename(queueFile, ".md");
  assert.equal(saved.paths.length, 4);
  for (const p of saved.paths) {
    assert.equal(path.dirname(p), dir, "images live beside the queue file");
    assert.ok(fs.existsSync(p), `${p} exists`);
    assert.deepEqual(fs.readFileSync(p), PNG);
  }
  assert.equal(path.basename(saved.paths[0]!), `${stem}.png`);
  assert.equal(path.basename(saved.paths[1]!), `${stem}-2.png`, "same-extension images get a -<n> suffix");
  assert.equal(path.basename(saved.paths[2]!), `${stem}.jpeg`, "directory components are stripped from client names");
  assert.equal(path.basename(saved.paths[3]!), `${stem}-3.png`, "disallowed characters are stripped from client names");
  // Fails closed: an unvalidated call writes nothing.
  const before = fs.readdirSync(dir);
  assert.ok("problem" in savePromptImages(root, "qa", queueFile, [{ name: "x.txt", dataBase64: "aaaa" }]));
  assert.deepEqual(fs.readdirSync(dir), before);
});

test("savePromptImages does not overwrite an image already beside the queue file", () => {
  const root = tmpdir();
  const queueFile = enqueueRolePrompt(root, "qa", "look");
  const stem = path.basename(queueFile, ".md");
  const existing = path.join(roleInboxDir(root, "qa"), `${stem}.png`);
  fs.writeFileSync(existing, Buffer.from("original"));

  // The same stem and extension already on disk: the new image dedups to `-2` and the
  // referenced existing file is byte-unchanged.
  const saved = savePromptImages(root, "qa", queueFile, [png()]);
  assert.ok("paths" in saved);
  assert.equal(path.basename(saved.paths[0]!), `${stem}-2.png`);
  assert.deepEqual(fs.readFileSync(existing), Buffer.from("original"));
});

test("savePromptImages removes its partial writes when a later image's write fails", () => {
  const root = tmpdir();
  const queueFile = enqueueRolePrompt(root, "qa", "look");
  const dir = roleInboxDir(root, "qa");
  const stem = path.basename(queueFile, ".md");
  // Make the second image's write fail (EISDIR) mid-loop, so the first write succeeds and
  // the second throws.
  const target = path.join(dir, `${stem}.jpg`);
  const restoreWrite = patchFsMethod("writeFileSync", (orig) => (file, data, ...rest) => {
    if (String(file) === target) {
      throw Object.assign(new Error("EISDIR: illegal operation on a directory, write"), { code: "EISDIR" });
    }
    return orig(file, data, ...rest);
  });
  try {
    assert.throws(() => savePromptImages(root, "qa", queueFile, [png(), { name: "b.jpg", dataBase64: PNG.toString("base64") }]));
  } finally {
    restoreWrite();
  }
  assert.ok(!fs.existsSync(path.join(dir, `${stem}.png`)), "the already-written first image is removed again");
});

test("savePromptImages removes the image whose own write throws after a partial write", () => {
  const root = tmpdir();
  const queueFile = enqueueRolePrompt(root, "qa", "look");
  const dir = roleInboxDir(root, "qa");
  const stem = path.basename(queueFile, ".md");
  const target = path.join(dir, `${stem}.png`);
  // The failing image is the one whose write never returns, so it is not yet in the written
  // list: leave a truncated file behind (as ENOSPC does) and throw. The pre-fix catch cleans
  // only earlier writes, so this partial file would survive in the inbox dir forever.
  const restoreWrite = patchFsMethod("writeFileSync", (orig) => (file, data, ...rest) => {
    if (String(file) === target) {
      orig(target, PNG.subarray(0, 4));
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    return orig(file, data, ...rest);
  });
  try {
    assert.throws(() => savePromptImages(root, "qa", queueFile, [png()]), /ENOSPC/);
  } finally {
    restoreWrite();
  }
  assert.ok(!fs.existsSync(target), "the half-written image is removed again");
});

test("savePromptImages keeps the validated extension when the client name's safe characters all strip away", () => {
  // `截图.png` validates (raw extname .png) but its basename sanitizes to ".png", whose
  // extname is "" — the saved file once landed extension-less, which pi's read tool cannot
  // render as an image and removeSameStemSiblings cannot match for cleanup (its next char
  // after the stem is neither "." nor "-"), orphaning the image in the queue dir forever.
  const root = tmpdir();
  const queueFile = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", queueFile, [
    { name: "截图.png", dataBase64: PNG.toString("base64") },
    { name: "Bildschirmfoto.jpeg", dataBase64: PNG.toString("base64") },
  ]);
  assert.ok("paths" in saved);
  const dir = roleInboxDir(root, "qa");
  const stem = path.basename(queueFile, ".md");
  assert.equal(path.basename(saved.paths[0]!), `${stem}.png`, "non-ASCII basename keeps its extension");
  assert.equal(path.basename(saved.paths[1]!), `${stem}.jpeg`, "so does a mixed-script one");
  for (const p of saved.paths) assert.ok(fs.existsSync(p) && !fs.existsSync(p + ".md"));
  // The cancel-side cleanup matches exactly these extension'd shapes and takes them with the
  // prompt (a dequeue leaves them for the tick to read; cancel removes them).
  assert.equal(cancelQueuedFile(root, "qa", path.basename(queueFile)).status, "cancelled");
  assert.deepEqual(fs.readdirSync(dir), [], "no orphaned image survives the cancel");
});

test("imageReferenceLines appends one absolute-path line per image", () => {
  assert.equal(imageReferenceLines([]), "");
  const lines = imageReferenceLines(["/tmp/a.png", "/tmp/b.png"]);
  assert.match(lines, /^\n\n\[image attached: \/tmp\/a\.png\]\n\[image attached: \/tmp\/b\.png\]$/);
});

test("submitRolePrompt with images queues text + reference lines and saves the files", () => {
  const root = tmpdir();
  const queued = submitRolePrompt(root, "qa", "check this screenshot", [png()]);
  assert.match(queued, /^check this screenshot\n\n\[image attached: .+\]$/);
  const [text] = queuedRolePrompts(root, "qa");
  assert.equal(text, queued, "the queue file carries the reference lines");
  const ref = queued.split("\n")[2]!;
  const image = ref.slice("[image attached: ".length, -1);
  assert.ok(path.isAbsolute(image), "the reference is absolute");
  assert.ok(fs.existsSync(image), "the referenced file exists on disk");
  // The director path shares the mechanics, queue at the inbox root.
  const directorQueued = submitRolePrompt(root, "director", "team-wide look", [png()]);
  assert.match(directorQueued, /\[image attached: .+\]/);
  assert.ok(fs.existsSync(directorQueued.split("\n")[2]!.slice("[image attached: ".length, -1)));
});

test("dequeuing keeps a prompt's image files for the run; cancelling removes them", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", file, [png(), { name: "b.png", dataBase64: PNG.toString("base64") }]);
  assert.ok("paths" in saved);
  const dir = roleInboxDir(root, "qa");
  // A sibling prompt's file that merely shares a stem prefix is never touched ("123-1" vs
  // "123-12").
  const neighbor = path.join(dir, `${path.basename(file, ".md")}2.md`);
  fs.writeFileSync(neighbor, "next prompt");
  assert.ok(fs.existsSync(saved.paths[0]!));
  assert.equal(dequeueRolePrompt(root, "qa"), "look");
  // Regression (BUGS.md 2026-10-11): the tick's pi agent reads these files during its run,
  // so a dequeue must leave them on disk; only fulfillment or cancel removes them.
  assert.ok(fs.existsSync(saved.paths[0]!), "dequeue keeps the first image for the run");
  assert.ok(fs.existsSync(saved.paths[1]!), "dequeue keeps the second image for the run");
  assert.ok(fs.existsSync(neighbor), "a different prompt's file survives");

  const file2 = enqueueRolePrompt(root, "qa", "look again");
  const saved2 = savePromptImages(root, "qa", file2, [png()]);
  assert.ok("paths" in saved2);
  const name = path.basename(file2);
  const outcome = cancelQueuedFile(root, "qa", name);
  assert.equal(outcome.status, "cancelled");
  assert.ok(!fs.existsSync(saved2.paths[0]!), "cancel removes the image with the prompt");
});

test("cancelling a prompt does not delete a hyphen-named sibling prompt's queue file", () => {
  const root = tmpdir();
  const dir = roleInboxDir(root, "qa");
  // Hand-placed queue files are supported (queueFileStamp reads them as unstamped), and a
  // hand-placed name may embed a hyphen: cancelling `a.md` must not destroy `a-notes.md` —
  // a different prompt whose file merely starts with a.md's stem followed by a hyphen.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.md"), "cancel me");
  fs.writeFileSync(path.join(dir, "a-notes.md"), "a different prompt");
  const outcome = cancelQueuedFile(root, "qa", "a.md");
  assert.equal(outcome.status, "cancelled");
  assert.ok(fs.existsSync(path.join(dir, "a-notes.md")), "the sibling prompt survives");
  // But the same-stem image-suffix shape savePromptImages writes (`<stem>-<n>.<image ext>`)
  // is still taken with the prompt.
  fs.writeFileSync(path.join(dir, "a-2.png"), PNG);
  fs.writeFileSync(path.join(dir, "a.md"), "cancel me again");
  const outcome2 = cancelQueuedFile(root, "qa", "a.md");
  assert.equal(outcome2.status, "cancelled");
  assert.ok(!fs.existsSync(path.join(dir, "a-2.png")), "the image suffix is removed");
});

test("a vanished image sibling is tolerated at dequeue", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", file, [png()]);
  assert.ok("paths" in saved);
  fs.rmSync(saved.paths[0]!); // something else removed it before the dequeue
  assert.equal(dequeueRolePrompt(root, "qa"), "look"); // no throw
});

test("stripVanishedImageReferences drops only vanished references and records the loss", () => {
  const root = tmpdir();
  const live = path.join(root, "live.png");
  fs.writeFileSync(live, PNG);
  const text = `check this\n\n[image attached: ${live}]\n[image attached: /nonexistent/gone.png]`;
  const stripped = stripVanishedImageReferences(text);
  assert.match(stripped.text, new RegExp(`\\[image attached: ${live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  assert.doesNotMatch(stripped.text, /gone\.png\]$/);
  assert.match(stripped.text, /\[image attachments dropped: 1 image file was missing/);
  assert.equal(stripped.dropped, 1);
  // No references, no change: the common case costs nothing.
  const plain = stripVanishedImageReferences("just text");
  assert.deepEqual(plain, { text: "just text", dropped: 0 });
});

test("requeueUnfulfilled never re-queues a dangling image reference", () => {
  const root = tmpdir();
  const queued = submitRolePrompt(root, "qa", "look at this", [png()]);
  const image = imageReferencePaths(queued)[0]!;
  assert.equal(dequeueRolePrompt(root, "qa"), queued); // the dequeue leaves the image on disk
  fs.rmSync(image); // ... but something outside the tick removed it before the requeue
  const pending = new PendingPrompt(root, "qa");
  pending.record(queued);
  pending.requeueUnfulfilled(pending.get());
  const requeued = queuedRolePrompts(root, "qa")[0]!;
  assert.ok(requeued.startsWith("look at this"));
  assert.doesNotMatch(requeued, /\[image attached: /, "no reference to a file that is gone");
  assert.match(requeued, /\[image attachments dropped: 1 image file was missing/);
});

test("movePromptImages carries saved attachments to the new stem and rewrites their lines", () => {
  const root = tmpdir();
  const dir = roleInboxDir(root, "qa");
  const from = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", from, [png()]);
  assert.ok("paths" in saved);
  const stranger = path.join(dir, "unrelated.png");
  fs.writeFileSync(stranger, PNG);
  const text = `look\n\n[image attached: ${saved.paths[0]!}]\n[image attached: ${stranger}]`;
  const to = enqueueRolePrompt(root, "qa", "unused holder for the new stem");
  const moved = movePromptImages(from, to, text);
  assert.equal(moved.problem, null);
  const toStem = path.basename(to, ".md");
  const movedPath = path.join(dir, `${toStem}${path.extname(saved.paths[0]!)}`);
  assert.ok(fs.existsSync(movedPath), "the saved attachment moved to the new stem");
  assert.ok(!fs.existsSync(saved.paths[0]!), "the old-stem name is gone");
  assert.match(moved.text, new RegExp(`\\[image attached: ${movedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  // A writer-shaped line naming a file the harness never saved beside this prompt is content.
  assert.match(moved.text, new RegExp(`\\[image attached: ${stranger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  assert.ok(fs.existsSync(stranger), "a hand-typed reference is left where it is");
});
