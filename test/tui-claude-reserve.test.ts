import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";
import { setConfigKey } from "../src/config/config-write.js";

// Ctrl+Y claude subscription-window reserve editor on the Activity view (PLANS.md): the
// terminal twin of the dashboard Settings `Claude window reserve (JSON)` field and `tumwater
// config set claudeWindowReserve`. Pre-filled with the team's top-level `claudeWindowReserve`
// (compact JSON when set, empty when unset), Enter writes through the shared
// setConfigKey/unsetConfigKey family, an empty or whitespace-only line clears the key, a
// non-object or an out-of-range fraction flashes the validator's message and stays open, and
// Esc and Ctrl+T cancel by restoring the prompt draft. The unit-level scope on tui-keys.test.ts
// pins the Activity-vs-History Ctrl+Y split; this file drives the full TUI.
test("Ctrl+Y edits the team's claude window reserve; Enter saves, empty clears, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // start view is Activity
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving claude-reserve mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+Y opens with the footer's `claude reserve ›` prefix and the line empty when the
    // config leaves claudeWindowReserve unset; the flash names the key and the shape.
    tui.key(undefined, "y", { ctrl: true });
    assert.match(tui.lastFrame(), /edit the team's claude subscription-window reserve/);
    assert.match(tui.lastFrame(), /JSON object/);
    assert.equal(tui.lines().at(-1), "claude reserve ›"); // empty when unset
    assert.match(tui.lastFrame(), /Enter save claude reserve/);

    // Enter on a valid JSON object persists it to tumwater.json and returns to prompt mode.
    for (const ch of '{"seven_day":0.8}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /claude window reserve set to \{"seven_day":0\.8\}/);
    let cfg = readJson(cfgPath) as { claudeWindowReserve?: Record<string, number> };
    assert.deepEqual(cfg.claudeWindowReserve, { seven_day: 0.8 });
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the saved reserve as compact JSON.
    tui.key(undefined, "y", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'claude reserve › {"seven_day":0.8}');

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    for (let i = 0; i < 20; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /claude window reserve cleared/);
    cfg = readJson(cfgPath) as { claudeWindowReserve?: Record<string, number> };
    assert.equal(cfg.claudeWindowReserve, undefined, "the key is removed");

    // A non-object value (setConfigKey JSON-parses `0.5` into the number, which
    // validateConfig's claudeWindowReserve block rejects) or an out-of-range fraction flashes
    // the validator's message, STAYS in edit mode with the text kept, and writes nothing.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "y", { ctrl: true });
    for (const ch of "0.5") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /claudeWindowReserve must be an object mapping window types to fractions/);
    assert.equal(tui.lines().at(-1), "claude reserve › 0.5", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a non-object is not written");
    tui.key(undefined, "escape");

    // A fraction above 1 flashes the per-window-type validator message.
    tui.key(undefined, "y", { ctrl: true });
    for (const ch of '{"seven_day":1.5}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /claudeWindowReserve\.seven_day must be a fraction above 0 and at most 1/);
    assert.equal(tui.lines().at(-1), 'claude reserve › {"seven_day":1.5}', "still open with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an out-of-range fraction is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Ctrl+T also exits claude-reserve mode, restoring the draft (and cycles away from Activity).
    for (const ch of "x") tui.key(ch, ch);
    tui.key(undefined, "y", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft promptx");
    assert.match(tui.lastFrame(), /\[Transcript/, "the view cycled away");
  });
});

// The prompt-line editors share one line, so the claude-reserve editor must not enter while
// another holds it (and vice versa); each flashes the way out.
test("Ctrl+Y is mutually exclusive with the other prompt-line editors, and Ctrl+Y again exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+Y must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "y", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Claude-reserve mode open; Ctrl+B must flash the way out and leave it alone.
    tui.key(undefined, "y", { ctrl: true });
    assert.equal(tui.lines().at(-1), "claude reserve ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the claude reserve first/);
    assert.equal(tui.lines().at(-1), "claude reserve ›", "the claude-reserve editor keeps the line");

    // Ctrl+Y again while open cancels it and restores the draft.
    tui.key(undefined, "y", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// Pre-filling reads the team's top-level key at open time, so a set config pre-fills the line
// even before the operator types anything — the editor writes back through the same key.
test("Ctrl+Y pre-fills compact JSON from a set claudeWindowReserve", async () => {
  const repo = await makeTuiRepo();
  setConfigKey(repo, "claudeWindowReserve", '{"seven_day":0.8,"one_day":1}');
  await withTui(repo, async (tui) => {
    tui.key(undefined, "y", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'claude reserve › {"seven_day":0.8,"one_day":1}');
  });
});
