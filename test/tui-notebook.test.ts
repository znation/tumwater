import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { enqueueRolePrompt } from "../src/inbox/inbox.js";
import { roleNotesPath } from "../src/paths.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+N notes mode: on a loop's transcript, the pane swaps the live transcript for the
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
  seedNote(repo, "clean", "the scheduler lives in team.ts\n");
  enqueueRolePrompt(repo, "clean", "check the scheduler first");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (the one enabled role: clean)
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);
    assert.match(tui.lastFrame(), /Ctrl\+N notes/); // the hint offers the switch

    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /Notes: clean \(1\/1\)/); // the tab strip names the mode
    assert.match(tui.lastFrame(), /## Notes/);
    assert.match(tui.lastFrame(), /the scheduler lives in team\.ts/);
    assert.match(tui.lastFrame(), /## Next run's prompt/);
    // The assembled prompt opens the block (the queued prompt embeds further down, past the
    // pane window): the preview seam's output is what renders, not a placeholder.
    assert.match(tui.lastFrame(), /You are the "clean" role/);
    assert.match(tui.lastFrame(), /Ctrl\+N change/); // the notebook's next step is the change view

    // The second Ctrl+N shows the collected pending change (this fixture holds no worktree, so
    // the collector degrades; the tab label is what the step is pinned on).
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /Change: clean \(1\/1\)/);
    assert.match(tui.lastFrame(), /Ctrl\+N transcript/); // the hint offers the way back

    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);
    assert.match(tui.lastFrame(), /Ctrl\+N notes/);

    // Ctrl+T away and back also lands on the live transcript, not a stale notebook.
    tui.key(undefined, "t", { ctrl: true }); // → backlog
    tui.key(undefined, "t", { ctrl: true }); // → usage
    tui.key(undefined, "t", { ctrl: true }); // → failures
    tui.key(undefined, "t", { ctrl: true }); // → history
    tui.key(undefined, "t", { ctrl: true }); // → pending
    tui.key(undefined, "t", { ctrl: true }); // → queued
    tui.key(undefined, "t", { ctrl: true }); // → health
    tui.key(undefined, "t", { ctrl: true }); // → brief
    tui.key(undefined, "t", { ctrl: true }); // → activity
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);
    assert.doesNotMatch(tui.lastFrame(), /## Notes/);
  });
});

test("a loop with no notebook shows the none-yet placeholder, not the transcript's empty note", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /## Notes/);
    assert.match(tui.lastFrame(), /_\(none yet — the role's own earlier runs write them/);
    assert.doesNotMatch(tui.lastFrame(), /\(no transcript yet\)/);
  });
});

test("PgUp/PgDn page the notebook body and clamp at both ends", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", Array.from({ length: 60 }, (_, i) => `note line ${i + 1}`).join("\n"));
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /## Notes/); // head shows the heading…
    assert.match(tui.lastFrame(), /note line 1\b/);

    tui.key(undefined, "pagedown");
    assert.doesNotMatch(tui.lastFrame(), /## Notes/); // …and one page scrolls past it
    assert.match(tui.lastFrame(), /note line \d+/);

    for (let i = 0; i < 10; i++) tui.key(undefined, "pageup"); // clamps at the head
    assert.match(tui.lastFrame(), /## Notes/);
    assert.match(tui.lastFrame(), /note line 1\b/);

    // Clamp at the tail: the last page is the last page — another PgDn repaints the same window.
    for (let i = 0; i < 20; i++) tui.key(undefined, "pagedown");
    const tail = tui.lastFrame();
    assert.doesNotMatch(tail, /note line 1\b/); // the head scrolled away
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tail);
  });
});

test("Ctrl+X twice in the notebook view clears the loop's notebook; the first press only arms", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "stale note\n");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /Ctrl\+X clear notes/);
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "stale note\n");
    assert.match(tui.lastFrame(), /press Ctrl\+X again/);
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "");
    assert.match(tui.lastFrame(), /notes cleared/);
    assert.match(tui.lastFrame(), /_\(none yet — the role's own earlier runs write them/);
  });
});

test("another key between the two Ctrl+X presses disarms the notebook clear", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "keep me\n");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    tui.key(undefined, "pagedown");
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "keep me\n");
  });
});

test("Ctrl+X on the live transcript leaves the notebook alone", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "keep me\n");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "keep me\n");
  });
});

// Ctrl+E on the notes view replaces a role's notes from a typed file path — the terminal twin
// of `tumwater role <id> --notes-file <path>` and the dashboard drawer's textarea. The write
// goes through the same saveRoleNote the CLI and the drawer share, so the 4 KB cap and its
// wording cannot drift.

test("Ctrl+E replaces a role's notes from a typed file path", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "stale note\n");
  const replacement = path.join(repo, "replacement-note.md");
  fs.writeFileSync(replacement, "the new scheduler note\nmultiline\n");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript
    tui.key(undefined, "n", { ctrl: true }); // → notes
    assert.match(tui.lastFrame(), /Ctrl\+E edit/); // the hint offers the replace
    tui.key(undefined, "e", { ctrl: true }); // open the notes editor
    assert.match(tui.lastFrame(), /replace clean's notes from a file/);
    for (const ch of replacement) tui.key(ch, ch); // type the path character by character
    tui.key(undefined, "return");
    // The note file holds the replacement verbatim and the notes view repaints it.
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "the new scheduler note\nmultiline\n");
    assert.match(tui.lastFrame(), /notes saved/);
    assert.match(tui.lastFrame(), /the new scheduler note/);
    assert.match(tui.lastFrame(), /multiline/);
  });
});

test("an empty or nonexistent notes-file path flashes and stays in the editor", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "keep me\n");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    tui.key(undefined, "e", { ctrl: true });
    tui.key(undefined, "return"); // an empty path
    assert.match(tui.lastFrame(), /a file path is required/);
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "keep me\n");
    const missing = path.join(repo, "no-such-note.md");
    for (const ch of missing) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /no such file/);
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "keep me\n");
    assert.match(tui.lastFrame(), /keep me/); // the seeded note still renders
  });
});

test("Esc cancels the notes editor, restores the prompt draft, and writes nothing", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "keep me\n");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    for (const ch of "a director draft") tui.key(ch, ch); // a prompt draft to restore
    tui.key(undefined, "e", { ctrl: true });
    for (const ch of "other/path.md") tui.key(ch, ch);
    tui.key(undefined, "escape");
    assert.match(tui.lastFrame(), /notes edit cancelled/);
    assert.match(tui.lastFrame(), /a director draft/); // the prompt draft came back
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "keep me\n");
  });
});

test("a file over the notes byte cap flashes saveRoleNote's message and writes nothing", async () => {
  const repo = await makeTuiRepo();
  seedNote(repo, "clean", "keep me\n");
  const big = path.join(repo, "big-note.md");
  fs.writeFileSync(big, "x".repeat(5000));
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "n", { ctrl: true });
    tui.key(undefined, "e", { ctrl: true });
    for (const ch of big) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /shorten it to at most 4096 bytes/);
    assert.equal(fs.readFileSync(roleNotesPath(repo, "clean"), "utf8"), "keep me\n");
  });
});
