import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+O quiet-hours editor on a role's Transcript view (PLANS.md): the terminal twin of the
// dashboard drawer's `Quiet hours` row and `tumwater role <id> --quiet-hours`. Pre-filled with
// the viewed role's own `quietHoursPerRole.<base>` window, Enter writes through the shared
// setConfigKey/unsetConfigKey family, an empty or whitespace-only line clears the key, Esc and
// Ctrl+T cancel by restoring the prompt draft, and a malformed window flashes the
// checkQuietHours message and stays open. The unit-level scope on tui-keys.test.ts pins the
// dotted-key, director, and instance→base writes; this file drives the full TUI.
test("Ctrl+O edits the viewed role's quiet hours; Enter saves, empty clears, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → clean's transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);

    // A draft prompt first — leaving quiet mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+O opens pre-filled with the (unset) window and flashes the hint;
    // the footer's hint branch names the mode's own save/cancel keys.
    tui.key(undefined, "o", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's quiet hours/);
    assert.equal(tui.lines().at(-1), "quiet hours ›"); // the brand labels the mode
    assert.match(tui.lastFrame(), /Enter save quiet hours/);

    // Enter on a valid window persists it to tumwater.json and returns to prompt mode.
    for (const ch of "23:00-07:00") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: quiet hours set to 23:00-07:00/);
    let cfg = readJson(cfgPath) as { quietHoursPerRole?: Record<string, string> };
    assert.equal(cfg.quietHoursPerRole?.clean, "23:00-07:00");
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the saved window.
    tui.key(undefined, "o", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's quiet hours/);
    assert.equal(tui.lines().at(-1), "quiet hours › 23:00-07:00");

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    for (let i = 0; i < 11; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: quiet hours cleared/);
    cfg = readJson(cfgPath) as { quietHoursPerRole?: Record<string, string> };
    assert.equal(cfg.quietHoursPerRole?.clean, undefined, "the key is removed");

    // Clearing a key the file never set is a no-op that leaves the file bytes unchanged.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "o", { ctrl: true });
    tui.key(undefined, "return"); // the pre-filled line is empty → unset
    assert.match(tui.lastFrame(), /clean: quiet hours cleared/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "clearing an absent key leaves the file unchanged");

    // An invalid window flashes the checkQuietHours message naming the dotted key, STAYS in
    // edit mode with the text kept, and writes nothing.
    tui.key(undefined, "o", { ctrl: true });
    for (const ch of "nope") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /quietHoursPerRole\.clean/);
    assert.equal(tui.lines().at(-1), "quiet hours › nope", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an invalid window is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// The prompt-line editors share one line, so the quiet editor must not enter while another
// holds it (and vice versa); each flashes the way out. Ctrl+T exits quiet mode too — view
// cycling is orthogonal to the editor, so it never strands the pre-filled text.
test("Ctrl+O is mutually exclusive with the other prompt-line editors, and Ctrl+T exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+O must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "o", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Quiet mode open; Ctrl+B must flash the way out and leave quiet mode alone.
    tui.key(undefined, "o", { ctrl: true });
    assert.equal(tui.lines().at(-1), "quiet hours ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the quiet hours first/);
    assert.equal(tui.lines().at(-1), "quiet hours ›", "the quiet editor keeps the line");

    // Ctrl+T exits quiet mode (restoring the draft) and cycles away from the view.
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    assert.match(tui.lastFrame(), /\[Backlog\]/, "the view cycled away");
  });
});

// The budget↔quiet direction above proves heldEditorFlash's shared guard. But the role-prompt
// (Ctrl+R) and pause (Ctrl+F, and the per-loop Ctrl+P/Ctrl+W) editors guard their keys with
// their own direct held-flag checks rather than heldEditorFlash, so quiet-hours mode must also
// keep them out: each stays inert while the quiet editor holds the line, leaving the quiet
// editor (and its pre-filled text) untouched and the write still lands on Enter.
test("Ctrl+R, Ctrl+F, Ctrl+P and Ctrl+W stay inert while the quiet editor holds the line", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);
    tui.key(undefined, "o", { ctrl: true });
    assert.equal(tui.lines().at(-1), "quiet hours ›");

    // None of the direct-guard editors may open over the quiet editor on the shared line.
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "quiet hours ›", "Ctrl+R does not open the role-prompt editor");
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(tui.lines().at(-1), "quiet hours ›", "Ctrl+F does not open the team-pause editor");
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), "quiet hours ›", "Ctrl+P does not open the loop-pause editor");
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "quiet hours ›", "Ctrl+W does not open the wake editor");

    // The quiet editor is still the one holding the line: its Enter lands the window.
    for (const ch of "23:00-07:00") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: quiet hours set to 23:00-07:00/);
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// Ctrl+O means the event-type/outcome/problems cycle on the Activity, History and Health
// views — the quiet editor may only take the line on a role's Transcript, so the other views
// keep their own Ctrl+O (the prompt line is untouched).
test("Ctrl+O on Activity, History and Health keeps their own meaning, not the quiet editor", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Activity (the start view): Ctrl+O cycles the event-type filter, leaving the prompt.
    for (const ch of "prompt") tui.key(ch, ch);
    tui.key(undefined, "o", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "Activity's Ctrl+O never opens the editor");

    // History (after 5 Ctrl+T: activity → clean transcript → backlog → usage → failures → history)
    for (let i = 0; i < 5; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[History\]/);
    tui.key(undefined, "o", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "History's Ctrl+O cycle keeps the prompt");

    // Health (History → Pending → Queued → Health)
    for (let i = 0; i < 3; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Health\]/);
    tui.key(undefined, "o", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "Health's Ctrl+O toggle keeps the prompt");
  });
});
