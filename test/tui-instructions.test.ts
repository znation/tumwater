import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+L replace-standing-instructions editor on a role's Transcript view (PLANS.md): the
// terminal twin of `tumwater role <id> --instructions-file` and the dashboard drawer's
// Instructions editor. It takes a typed file path, reads it verbatim, and writes the base
// role's `roles.<base>.instructions` through the shared setConfigKey/unsetConfigKey family;
// an empty/whitespace-only file clears the key, Enter/Esc/Ctrl+T restore the prompt draft,
// and empty/missing/over-cap paths flash and stay. The unit-level scope on tui-keys.test.ts
// pins the dotted-key, instance→base, director, and mutual-exclusion writes; this file drives
// the full TUI.
test("Ctrl+L replaces the viewed role's standing instructions from a file; empty clears, Esc and Ctrl+T restore", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean
  const cfgPath = path.join(repo, "tumwater.json");
  const instructionsOf = (): string | undefined =>
    (readJson(cfgPath) as { roles?: Record<string, { instructions?: string }> }).roles?.clean?.instructions;
  const instructionsFile = path.join(repo, "instructions.txt");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → clean's transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);

    // A draft prompt first — leaving instructions mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+L opens the editor on the blank prompt line, flashing the framing and naming the
    // mode's own save/cancel keys and prefix.
    tui.key(undefined, "l", { ctrl: true });
    assert.match(tui.lastFrame(), /replace clean's instructions from a file/);
    assert.equal(tui.lines().at(-1), "instructions for clean ›"); // the brand labels the mode
    assert.match(tui.lastFrame(), /Enter save instructions/);

    // Esc cancels back to prompt mode with the previous text restored, writing nothing.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    assert.equal(instructionsOf(), undefined, "Esc writes nothing");

    // Enter on a path to a non-empty file writes roles.clean.instructions (a JSON string) and
    // returns to prompt mode with the draft restored.
    fs.writeFileSync(instructionsFile, "answer every question in two lines");
    tui.key(undefined, "l", { ctrl: true });
    for (const ch of instructionsFile) tui.key(ch, ch); // type the path character by character
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: instructions saved \(\d+ chars\)/);
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored
    assert.equal(instructionsOf(), "answer every question in two lines");

    // A whitespace-only file removes the key and flashes the cleared wording.
    fs.writeFileSync(instructionsFile, "   \n");
    tui.key(undefined, "l", { ctrl: true });
    for (const ch of instructionsFile) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: instructions cleared/);
    assert.equal(instructionsOf(), undefined, "a whitespace-only file removes the override");
  });
});

// The failure paths stay in the editor so the operator can fix the path, and the over-cap write
// leaves tumwater.json byte-unchanged.
test("Ctrl+L with an empty, missing, or over-cap path flashes and stays", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript

    // An empty path flashes and stays in the editor.
    tui.key(undefined, "l", { ctrl: true });
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /a file path is required/);
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "an empty path stays open");
    tui.key(undefined, "escape");

    // A missing file flashes and stays.
    const missing = path.join(repo, "nope.txt");
    tui.key(undefined, "l", { ctrl: true });
    for (const ch of missing) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /no such file:/);
    assert.match(tui.lines().at(-1) ?? "", /^instructions for clean ›/, "a missing file stays open");
    tui.key(undefined, "escape");

    // A file over ROLE_INSTRUCTIONS_MAX_CHARS flashes the setConfigKey error naming the dotted
    // key, stays open, and leaves the file byte-unchanged.
    const before = fs.readFileSync(cfgPath, "utf8");
    const big = path.join(repo, "big-instructions.txt");
    fs.writeFileSync(big, "a".repeat(4097));
    tui.key(undefined, "l", { ctrl: true });
    for (const ch of big) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /roles\.clean\.instructions/);
    assert.match(tui.lines().at(-1) ?? "", /^instructions for clean ›/, "an over-cap write stays open");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an over-cap write leaves the file unchanged");
  });
});

// The prompt-line editors share one line, so the instructions editor must not enter while
// another holds it (and vice versa); each flashes the way out. Ctrl+T exits instructions mode
// too — view cycling is orthogonal to the editor, so it never strands the opened path.
test("Ctrl+L is mutually exclusive with the other prompt-line editors, and Ctrl+T exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+L must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "l", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Instructions mode open; Ctrl+B must flash the way out and leave it alone.
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the instructions edit first/);
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "the instructions editor keeps the line");

    // Ctrl+T exits instructions mode (restoring the draft) and cycles away from the view.
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    assert.match(tui.lastFrame(), /\[Backlog\]/, "the view cycled away");
  });
});

// The pause editor's team and per-loop arms (tui-editor-pause.ts) and the transcript pane's
// notebook arm (tui-pane-transcript.ts) each restate the held-editor mutual-exclusion guard, and
// each must also honor the instructions editor's held flag: while Ctrl+L is open on a role
// transcript, team pause/stop, per-loop pause/abort/wake/reset, the role-prompt editor, and the
// notebook toggle all stay inert and leave the prompt line with the instructions editor (the
// reviewer's missed-flag paths).
test("the pause and notebook arms stay inert while Ctrl+L holds the line", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›");

    // Team pause (Ctrl+F) and scheduled stop (Ctrl+Q): no pause/stop editor opens, no flash.
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+F does not open the team pause editor");
    tui.key(undefined, "q", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+Q does not open the stop editor");

    // Per-loop controls on the transcript: pause/abort/reset/wake all stay inert.
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+P does not open the per-loop pause editor");
    tui.key(undefined, "a", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+A does not abort the loop");
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+W does not open the per-loop wake editor");
    tui.key(undefined, "v", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+V does not reset the loop's counters");

    // The transcript pane's notebook toggle (Ctrl+N) stays inert and the notes view does not open.
    tui.key(undefined, "n", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+N does not open the notes view while Ctrl+L is open");
    assert.doesNotMatch(tui.lastFrame(), /clean's notes/, "notes mode did not open");

    // The transcript's role-prompt editor (Ctrl+R) stays inert while Ctrl+L holds the line.
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instructions for clean ›", "Ctrl+R does not open the role-prompt editor while Ctrl+L is open");

    // Still holding the line: Esc exits instructions mode with the prompt draft restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director ›");
  });
});

// Ctrl+L is the Activity view's team-fallback editor (and the instructions editor on a role's
// Transcript); the non-transcript views other than Activity have no Ctrl+L arm, so Backlog,
// History and Health ignore it (the prompt line is untouched).
test("Ctrl+L opens the fallback editor on Activity, and leaves the prompt line alone on Backlog, History and Health", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Activity (the start view): Ctrl+L is the team-fallback editor.
    for (const ch of "prompt") tui.key(ch, ch);
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback ›", "Activity's Ctrl+L opens the fallback editor");
    tui.key(undefined, "escape"); // exit, restoring the prompt draft

    // Backlog (after 2 Ctrl+T: activity → clean transcript → backlog).
    for (let i = 0; i < 2; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Backlog\]/);
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "Backlog's Ctrl+L changes nothing");

    // History (Backlog → Usage → Failures → History).
    for (let i = 0; i < 3; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[History\]/);
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "History's Ctrl+L changes nothing");

    // Health (History → Pending → Queued → Health).
    for (let i = 0; i < 3; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Health\]/);
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "Health's Ctrl+L changes nothing");
  });
});
