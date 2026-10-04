import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  imageReferenceLines,
  PROMPT_IMAGES_MAX_COUNT,
  promptImagesProblem,
  savePromptImages,
  stripVanishedImageReferences,
} from "../src/inbox-attachments.js";
import { cancelQueuedFile } from "../src/inbox-cancel.js";
import { dequeueRolePrompt, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox.js";
import { submitRolePrompt } from "../src/inbox-submit.js";
import { PendingPrompt } from "../src/pending-prompt.js";
import { roleInboxDir } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";

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

test("savePromptImages removes its partial writes when a later image's write fails", () => {
  const root = tmpdir();
  const queueFile = enqueueRolePrompt(root, "qa", "look");
  const dir = roleInboxDir(root, "qa");
  const stem = path.basename(queueFile, ".md");
  // Occupy the second image's target path with a directory, so the first write succeeds
  // and the second throws (EISDIR) mid-loop.
  fs.mkdirSync(path.join(dir, `${stem}.jpg`));
  assert.throws(() => savePromptImages(root, "qa", queueFile, [png(), { name: "b.jpg", dataBase64: PNG.toString("base64") }]));
  assert.ok(!fs.existsSync(path.join(dir, `${stem}.png`)), "the already-written first image is removed again");
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
  // And the dequeue-side cleanup takes them with the prompt, as it does every extension'd image.
  assert.equal(dequeueRolePrompt(root, "qa"), "look");
  assert.deepEqual(fs.readdirSync(dir), [], "no orphaned image survives the dequeue");
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
  const directorQueued = submitRolePrompt(root, "director", "fleet-wide look", [png()]);
  assert.match(directorQueued, /\[image attached: .+\]/);
  assert.ok(fs.existsSync(directorQueued.split("\n")[2]!.slice("[image attached: ".length, -1)));
});

test("dequeuing and cancelling a prompt remove its same-stem image files", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "qa", "look");
  const saved = savePromptImages(root, "qa", file, [png(), { name: "b.png", dataBase64: PNG.toString("base64") }]);
  assert.ok("paths" in saved);
  const dir = roleInboxDir(root, "qa");
  // A sibling prompt's file that merely shares a stem prefix is never touched ("123-1" vs "123-12").
  const neighbor = path.join(dir, `${path.basename(file, ".md")}2.md`);
  fs.writeFileSync(neighbor, "next prompt");
  assert.ok(fs.existsSync(saved.paths[0]!));
  assert.equal(dequeueRolePrompt(root, "qa"), "look");
  assert.ok(!fs.existsSync(saved.paths[0]!), "dequeue removed the image");
  assert.ok(!fs.existsSync(saved.paths[1]!), "dequeue removed the second image");
  assert.ok(fs.existsSync(neighbor), "a different prompt's file survives");

  const file2 = enqueueRolePrompt(root, "qa", "look again");
  const saved2 = savePromptImages(root, "qa", file2, [png()]);
  assert.ok("paths" in saved2);
  const name = path.basename(file2);
  const outcome = cancelQueuedFile(root, "qa", name);
  assert.equal(outcome.status, "cancelled");
  assert.ok(!fs.existsSync(saved2.paths[0]!), "cancel removed the image with the prompt");
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
  assert.match(stripped.text, /\[image attachments dropped: 1 image file was consumed/);
  assert.equal(stripped.dropped, 1);
  // No references, no change: the common case costs nothing.
  const plain = stripVanishedImageReferences("just text");
  assert.deepEqual(plain, { text: "just text", dropped: 0 });
});

test("requeueUnfulfilled never re-queues a dangling image reference", () => {
  const root = tmpdir();
  const queued = submitRolePrompt(root, "qa", "look at this", [png()]);
  assert.equal(dequeueRolePrompt(root, "qa"), queued); // the dequeue consumed the image file
  const pending = new PendingPrompt(root, "qa");
  pending.record(queued);
  pending.requeueUnfulfilled(pending.get());
  const requeued = queuedRolePrompts(root, "qa")[0]!;
  assert.ok(requeued.startsWith("look at this"));
  assert.doesNotMatch(requeued, /\[image attached: /, "no reference to a file that is gone");
  assert.match(requeued, /\[image attachments dropped: 1 image file was consumed/);
});
