import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+S min-run-interval editor on a role's Transcript view (PLANS.md): the terminal twin of
// the dashboard drawer's `Min run interval` row and `tumwater role <id> --min-run-interval`.
// Pre-filled with the viewed role's own `roles.<base>.minRunIntervalSeconds` override read from
// the FILE, Enter writes through the shared setConfigKey/unsetConfigKey family, an empty or
// whitespace-only line clears the key, a non-numeric or negative value flashes the
// checkMinRunInterval message and stays open, and Esc and Ctrl+T cancel by restoring the prompt
// draft. The unit-level scope on tui-keys.test.ts pins the instance→base and director writes;
// this file drives the full TUI.
test("Ctrl+S edits the viewed role's min run interval; Enter saves, empty clears, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → clean's transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);

    // A draft prompt first — leaving interval mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+S opens pre-filled with the (unset) override and flashes the hint;
    // the footer's hint branch names the mode's own save/cancel keys, and the prompt
    // line labels the mode with the brand tone.
    tui.key(undefined, "s", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's min run interval/);
    assert.equal(tui.lines().at(-1), "min run interval ›"); // the brand labels the mode
    assert.match(tui.lastFrame(), /Enter save interval/);

    // Enter on a valid number persists it to tumwater.json as a JSON number and returns to
    // prompt mode.
    for (const ch of "120") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: min run interval set to 120s/);
    let cfg = readJson(cfgPath) as { roles?: Record<string, { minRunIntervalSeconds?: number }> };
    assert.equal(cfg.roles?.clean?.minRunIntervalSeconds, 120);
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the just-saved override.
    tui.key(undefined, "s", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's min run interval/);
    assert.equal(tui.lines().at(-1), "min run interval › 120");

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    for (let i = 0; i < 3; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: min run interval cleared/);
    cfg = readJson(cfgPath) as { roles?: Record<string, { minRunIntervalSeconds?: number }> };
    assert.equal(cfg.roles?.clean?.minRunIntervalSeconds, undefined, "the key is removed");

    // Clearing a key the file never set is a no-op that leaves the file bytes unchanged — even
    // though the catalog seeds minRunIntervalSeconds for every built-in role, the editor judges
    // presence against the FILE, so the seed is not mistaken for an operator override.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "s", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›", "an unset override pre-fills empty, not the seed");
    tui.key(undefined, "return"); // the pre-filled line is empty → unset
    assert.match(tui.lastFrame(), /clean: min run interval cleared/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "clearing an absent key leaves the file unchanged");

    // A non-numeric value flashes the checkMinRunInterval message naming the dotted key, STAYS
    // in edit mode with the text kept, and writes nothing.
    tui.key(undefined, "s", { ctrl: true });
    for (const ch of "nope") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /roles\.clean\.minRunIntervalSeconds/);
    assert.equal(tui.lines().at(-1), "min run interval › nope", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an invalid value is not written");

    // A negative value is likewise rejected, keeps the line, and writes nothing.
    for (let i = 0; i < 4; i++) tui.key(undefined, "backspace");
    for (const ch of "-5") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /roles\.clean\.minRunIntervalSeconds/);
    assert.equal(tui.lines().at(-1), "min run interval › -5", "a negative value is rejected and kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a negative value is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// The prompt-line editors share one line, so the interval editor must not enter while another
// holds it (and vice versa); each flashes the way out. Ctrl+T exits interval mode too — view
// cycling is orthogonal to the editor, so it never strands the pre-filled text.
test("Ctrl+S is mutually exclusive with the other prompt-line editors, and Ctrl+T exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+O (quiet) holds the line first; Ctrl+S must flash the way out, not open.
    tui.key(undefined, "o", { ctrl: true });
    tui.key(undefined, "s", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the quiet hours first/);
    assert.equal(tui.lines().at(-1), "quiet hours ›"); // still in quiet mode
    tui.key(undefined, "escape"); // out of quiet mode

    // Interval mode open; Ctrl+O must flash the way out and leave interval mode alone.
    tui.key(undefined, "s", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›");
    tui.key(undefined, "o", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the min run interval first/);
    assert.equal(tui.lines().at(-1), "min run interval ›", "the interval editor keeps the line");

    // Ctrl+T exits interval mode (restoring the draft) and cycles away from the view.
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    assert.match(tui.lastFrame(), /\[Backlog\]/, "the view cycled away");
  });
});

// The role-prompt (Ctrl+R), pause (Ctrl+F, and the per-role Ctrl+P/Ctrl+W) editors guard their
// keys with their own direct held-flag checks, so interval mode must also keep them out: each
// stays inert while the interval editor holds the line, and the write still lands on Enter.
test("Ctrl+R, Ctrl+F, Ctrl+P and Ctrl+W stay inert while the interval editor holds the line", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);
    tui.key(undefined, "s", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›");

    // None of the direct-guard editors may open over the interval editor on the shared line.
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›", "Ctrl+R does not open the role-prompt editor");
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›", "Ctrl+F does not open the team-pause editor");
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›", "Ctrl+P does not open the role-pause editor");
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "min run interval ›", "Ctrl+W does not open the wake editor");

    // The interval editor is still the one holding the line: its Enter lands the override.
    for (const ch of "60") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: min run interval set to 60s/);
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// Ctrl+S means the trailing-window cycle on the History view — the interval editor may only
// take the line on a role's Transcript, so History keeps its own Ctrl+S (the prompt line is
// untouched).
test("Ctrl+S on History keeps its trailing-window cycle, not the interval editor", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Activity (the start view): Ctrl+S opens the team-wide quiet-hours editor, not the
    // interval one — the interval editor only takes the line on a role's Transcript.
    for (const ch of "prompt") tui.key(ch, ch);
    tui.key(undefined, "s", { ctrl: true });
    assert.equal(tui.lines().at(-1), "team quiet hours ›", "Ctrl+S on Activity opens the team quiet editor, not the interval one");
    tui.key(undefined, "escape"); // cancel back to the prompt
    assert.equal(tui.lines().at(-1), "director › prompt");

    // History (after 5 Ctrl+T: activity → clean transcript → backlog → usage → failures → history).
    for (let i = 0; i < 5; i++) tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[History\]/);
    tui.key(undefined, "s", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › prompt", "History's Ctrl+S keeps the prompt line");
    assert.match(tui.lastFrame(), /Ctrl\+S/, "History still names its trailing-window Ctrl+S hint");
  });
});
