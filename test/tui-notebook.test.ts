import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { enqueueRolePrompt } from "../src/inbox/inbox.js";
import { roleNotesPath } from "../src/paths.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+N notebook mode: on a loop's transcript, the pane swaps the live transcript for the
// loop's notebook and next tick's prompt (PLANS.md "Inspect a loop's notebook and next tick
// prompt in the TUI"), and swaps back — the terminal view of what the dashboard drawer shows.

/** Seed a loop's notebook file. */
function seedNote(repo: string, role: string, text: string): void {
  const note = roleNotesPath(repo, role);
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, text);
}

test("Ctrl+N shows the viewed loop's notebook and next tick prompt, and toggles back", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "the scheduler lives in fleet.ts\n");
  enqueueRolePrompt(repo, "clean", "check the scheduler first");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (the one enabled role: clean)
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);
    assert.match(tui.lastFrame(), /Ctrl\+N notebook/); // the hint offers the switch

    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /Notebook: clean \(1\/1\)/); // the tab strip names the mode
    assert.match(tui.lastFrame(), /## Notebook/);
    assert.match(tui.lastFrame(), /the scheduler lives in fleet\.ts/);
    assert.match(tui.lastFrame(), /## Next tick prompt/);
    // The assembled prompt opens the block (the queued prompt embeds further down, past the
    // pane window): the preview seam's output is what renders, not a placeholder.
    assert.match(tui.lastFrame(), /You are the "clean" loop/);
    assert.match(tui.lastFrame(), /Ctrl\+N transcript/); // the hint offers the way back

    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);
    assert.match(tui.lastFrame(), /Ctrl\+N notebook/);

    // Ctrl+T away and back also lands on the live transcript, not a stale notebook.
    tui.key(undefined, "t", { ctrl: true }); // → backlog
    tui.key(undefined, "t", { ctrl: true }); // → usage
    tui.key(undefined, "t", { ctrl: true }); // → failures
    tui.key(undefined, "t", { ctrl: true }); // → history
    tui.key(undefined, "t", { ctrl: true }); // → activity
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);
    assert.doesNotMatch(tui.lastFrame(), /## Notebook/);
  });
});

test("a loop with no notebook shows the none-yet placeholder, not the transcript's empty note", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /## Notebook/);
    assert.match(tui.lastFrame(), /_\(none yet — the role's own earlier ticks write it/);
    assert.doesNotMatch(tui.lastFrame(), /\(no transcript yet\)/);
  });
});

test("PgUp/PgDn page the notebook body and clamp at both ends", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", Array.from({ length: 60 }, (_, i) => `note line ${i + 1}`).join("\n"));
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /## Notebook/); // head shows the heading…
    assert.match(tui.lastFrame(), /note line 1\b/);

    tui.key(undefined, "pagedown");
    assert.doesNotMatch(tui.lastFrame(), /## Notebook/); // …and one page scrolls past it
    assert.match(tui.lastFrame(), /note line \d+/);

    for (let i = 0; i < 10; i++) tui.key(undefined, "pageup"); // clamps at the head
    assert.match(tui.lastFrame(), /## Notebook/);
    assert.match(tui.lastFrame(), /note line 1\b/);

    // Clamp at the tail: the last page is the last page — another PgDn repaints the same window.
    for (let i = 0; i < 20; i++) tui.key(undefined, "pagedown");
    const tail = tui.lastFrame();
    assert.doesNotMatch(tail, /note line 1\b/); // the head scrolled away
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tail);
  });
});
