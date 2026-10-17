import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { flushImmediate } from "./helpers/wait.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+V image attach on the Activity view's prompt line: the terminal twin of
// `tumwater prompt --attach <path>` and the dashboard composer's drop/paste. Enter reads the
// typed path through the CLI reader's rules (readPromptImageFiles) and stores it as a pending
// attachment, Enter on the director prompt then sends it with the stored images through the
// existing submitPrompt images argument.

function typePath(tui: { key(str: string | undefined, name: string, extra?: { ctrl?: boolean }): void }, p: string): void {
  for (const ch of p) tui.key(ch, ch);
}

test("Ctrl+V attaches an image path; Enter sends it with the next director prompt", async () => {
  const repo = await makeTuiRepo();
  const shot = path.join(repo, "shot.png");
  fs.writeFileSync(shot, "png-bytes");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "v", { ctrl: true }); // attach mode on the Activity view
    assert.match(tui.lastFrame(), /attach an image path — Enter to attach, Esc to cancel/);
    typePath(tui, shot);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /attached shot\.png/);
    // The prompt prefix names the pending image count beside the target.
    assert.equal(tui.lines().at(-1), "director (1 image) ›");

    for (const ch of "look at this") tui.key(ch, ch);
    tui.key(undefined, "return");
    const queued = queuedRolePrompts(repo, "director");
    assert.equal(queued.length, 1);
    const text = queued[0] as string;
    const ref = /^\[image attached: (.+)\]$/m.exec(text);
    assert.ok(ref, "the queued prompt carries a [image attached: …] reference line");
    assert.ok(text.startsWith("look at this\n\n[image attached: "), `text is ${JSON.stringify(text)}`);
    const saved = ref![1] as string;
    assert.ok(path.isAbsolute(saved) && fs.existsSync(saved), "the reference names the saved absolute image path");
    // A successful send consumes the pending images; the prefix shows no count.
    assert.equal(tui.lines().at(-1), "director ›");
  });
});

test("a second Ctrl+V in attach mode cancels the path edit and keeps the pending image", async () => {
  const repo = await makeTuiRepo();
  const shot = path.join(repo, "shot.png");
  fs.writeFileSync(shot, "png-bytes");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "v", { ctrl: true }); // open attach mode
    typePath(tui, shot);
    tui.key(undefined, "return"); // attach one image
    assert.match(tui.lastFrame(), /attached shot\.png/);
    assert.equal(tui.lines().at(-1), "director (1 image) ›");

    // Reopen attach mode, then press Ctrl+V again: the second press toggles the editor OFF
    // (its own flag is excluded from the busy guard, so it is not "busy"), flashes
    // "cancelled", and leaves the already-saved pending image in place.
    tui.key(undefined, "v", { ctrl: true });
    assert.match(tui.lastFrame(), /attach an image path/);
    tui.key(undefined, "v", { ctrl: true });
    assert.match(tui.lastFrame(), /image attach cancelled/);
    assert.doesNotMatch(tui.lastFrame(), /finish or cancel the image attach/);
    assert.doesNotMatch(tui.lastFrame(), /image attach cleared/);
    assert.equal(tui.lines().at(-1), "director (1 image) ›");
  });
});

test("the attach editor is Activity-only: Ctrl+V on the Transcript view never opens it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Activity-only: on the Transcript view (Ctrl+T first) Ctrl+V is the reset-counters arm,
    // not the attach editor, so no attach prompt (and no clearing flash) appears — the editor
    // guard keeps this Activity view's key off every other view.
    tui.key(undefined, "t", { ctrl: true }); // events → clean's transcript
    tui.key(undefined, "v", { ctrl: true });
    assert.doesNotMatch(tui.lastFrame(), /attach an image path/);
    assert.doesNotMatch(tui.lastFrame(), /image attach cleared/);
  });
});

test("attach edges: empty clears, Esc keeps, a bad type refuses, and the fifth hits the count cap", async () => {
  const repo = await makeTuiRepo();
  const shot = path.join(repo, "shot.png");
  fs.writeFileSync(shot, "png-bytes");
  const notes = path.join(repo, "notes.txt");
  fs.writeFileSync(notes, "not an image");
  await withTui(repo, async (tui) => {
    // Attach one image, then an empty-path Enter clears the pending attachment.
    tui.key(undefined, "v", { ctrl: true });
    typePath(tui, shot);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /attached shot\.png/);
    assert.equal(tui.lines().at(-1), "director (1 image) ›");
    tui.key(undefined, "v", { ctrl: true });
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /image attach cleared/);
    assert.equal(tui.lines().at(-1), "director ›");

    // Esc closes the editor and keeps the pending image.
    tui.key(undefined, "v", { ctrl: true });
    typePath(tui, shot);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /attached shot\.png/);
    tui.key(undefined, "v", { ctrl: true });
    tui.key(undefined, "escape");
    assert.doesNotMatch(tui.lastFrame(), /image attach cleared/);
    assert.equal(tui.lines().at(-1), "director (1 image) ›");

    // A notes.txt path flashes the extension rule and adds nothing.
    tui.key(undefined, "v", { ctrl: true });
    typePath(tui, notes);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /unsupported image type/);
    // The refusal stays in the attach editor with the typed path; the pending image is kept.
    assert.match(tui.lines().at(-1) as string, /director \(1 image\) ›/);
    tui.key(undefined, "escape");

    // Attach three more (4 total), then a fifth Enter flashes the count cap and adds nothing.
    for (let i = 0; i < 3; i++) {
      tui.key(undefined, "v", { ctrl: true });
      typePath(tui, shot);
      tui.key(undefined, "return");
      await flushImmediate(); // let ink's input subscription settle each attach before the next toggle
    }
    assert.equal(tui.lines().at(-1), "director (4 images) ›");
    tui.key(undefined, "v", { ctrl: true });
    typePath(tui, shot);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /at most 4 images/);
    // The count-cap refusal stays in the attach editor with the typed path; the pending four
    // images are kept and nothing is added.
    assert.match(tui.lines().at(-1) as string, /director \(4 images\) ›/);
  });
});
