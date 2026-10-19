import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";
import { setConfigKey } from "../src/config/config-write.js";
import { restartRequestPath } from "../src/paths.js";
import { isTeamPaused, scheduledStopAt } from "../src/team/team-state.js";

// Ctrl+L fallback editor on the Activity view (PLANS.md): the terminal twin of the dashboard
// Settings `Fallback (free at the spend cap)` field and `tumwater config set fallback`.
// Pre-filled with the team's top-level `fallback` (a bare selector string as-is, an array or map
// as compact JSON, empty when unset), Enter writes through the shared
// setConfigKey/unsetConfigKey family, an empty or whitespace-only line clears the key, a number
// flashes the validator's message and stays open, and Esc and Ctrl+T cancel by restoring the
// prompt draft. The unit-level scope on tui-keys.test.ts pins the Activity-vs-Transcript Ctrl+L
// split; this file drives the full TUI.
test("Ctrl+L edits the team's fallback; Enter saves a string and a tier map, invalid stays open, empty clears, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // start view is Activity
  const cfgPath = path.join(repo, "tumwater.json");
  const sel = "omlx/Qwen3.8-27B";
  const map = '{"strong":{"model":"omlx/Qwen3.8-27B"}}';
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving fallback mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+L opens with the footer's `fallback ›` prefix and the line empty when the config
    // leaves fallback unset; the flash names the key and the shape.
    tui.key(undefined, "l", { ctrl: true });
    assert.match(tui.lastFrame(), /edit the team's fallback model/);
    assert.match(tui.lastFrame(), /map by tier/);
    assert.equal(tui.lines().at(-1), "fallback ›"); // empty when unset
    assert.match(tui.lastFrame(), /Enter save the fallback/);

    // Enter on a selector string persists it to tumwater.json and returns to prompt mode.
    for (const ch of sel) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team fallback set to/);
    let cfg = readJson(cfgPath) as { fallback?: unknown };
    assert.equal(cfg.fallback, sel, "a bare string is written as the literal selector");
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the saved string as-is.
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), `fallback › ${sel}`);

    // Overwrite it with a JSON tier map; Enter persists the object.
    for (let i = 0; i < sel.length; i++) tui.key(undefined, "backspace");
    for (const ch of map) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team fallback set to/);
    cfg = readJson(cfgPath) as { fallback?: unknown };
    assert.deepEqual(cfg.fallback, { strong: { model: sel } }, "a JSON map is written as the object");

    // A number (42) flashes the validator's message, STAYS in edit mode with the text kept,
    // and writes nothing — the file is byte-identical.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), `fallback › ${map}`, "the map pre-fills as compact JSON");
    for (let i = 0; i < map.length; i++) tui.key(undefined, "backspace");
    for (const ch of "42") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /fallback must be a model id or a map by tier/);
    assert.equal(tui.lines().at(-1), "fallback › 42", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a number is not written");
    tui.key(undefined, "escape");

    // Esc cancels back to prompt mode with the previous text restored.
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    tui.key(undefined, "l", { ctrl: true });
    for (let i = 0; i < map.length; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team fallback cleared/);
    cfg = readJson(cfgPath) as { fallback?: unknown };
    assert.equal(cfg.fallback, undefined, "the key is removed");

    // Ctrl+T also exits fallback mode, restoring the draft (and cycles away from Activity).
    for (const ch of "x") tui.key(ch, ch);
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback ›");
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft promptx");
    assert.match(tui.lastFrame(), /\[Transcript/, "the view cycled away");
  });
});

// The prompt-line editors share one line, so the fallback editor must not enter while another
// holds it (and vice versa); each flashes the way out.
test("Ctrl+L is mutually exclusive with the other prompt-line editors, and Ctrl+L again exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+L must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "l", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Fallback mode open; Ctrl+B must flash the way out and leave it alone.
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the fallback edit first/);
    assert.equal(tui.lines().at(-1), "fallback ›", "the fallback editor keeps the line");

    // Fallback mode open; Ctrl+F (team pause) and `/` (search) must not open over it — their
    // held-registry guards keep the fallback draft from being discarded.
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isTeamPaused(repo), false, "Ctrl+F does not open the team pause over the fallback editor");
    assert.match(tui.lines().at(-1) ?? "", /^fallback ›/, "the fallback editor keeps the line");
    tui.key("/", "/");
    assert.doesNotMatch(tui.lastFrame(), /search events/, "`/` does not open the search over the fallback editor");
    assert.match(tui.lines().at(-1) ?? "", /^fallback ›/, "the fallback editor keeps the line through `/`");

    // Ctrl+L again while open cancels it and restores the draft.
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// The pause editor's three Activity-view arms (Ctrl+F pause, Ctrl+Q scheduled stop, Ctrl+R
// restart) and the shared `/` search editor guard their keys with their own held-flag lists
// (not heldEditorFlash), so the fallback editor must also keep them out: they stay inert while
// it holds the line — leaving the fallback editor (and its pre-filled text) untouched and the
// write still landing on Enter — and `onArrow`'s no-editor condition gains the flag too, so
// Up/Down cannot recall a submitted prompt into its text.
test("Ctrl+Q, Ctrl+R and Up/Down stay inert while the fallback editor holds the line on Activity", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Seed the recall history with a submitted prompt, so Up would paste it if it
    // reached the field.
    for (const ch of "previous prompt") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /added to the director's inbox/);

    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback ›");

    // They sit on the Activity view beside the fallback editor, but their held-flag guards keep
    // them from opening or firing over it on the shared prompt line.
    tui.key(undefined, "q", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback ›", "Ctrl+Q does not open the team-stop editor");
    assert.equal(scheduledStopAt(repo), undefined, "no scheduled stop is written");
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback ›", "Ctrl+R does not run the restart arm");
    assert.ok(!fs.existsSync(restartRequestPath(repo)), "the restart marker is not written");

    // Up/Down must not recall the submitted prompt into the fallback text — a recall would be a
    // paste, not an edit.
    tui.key(undefined, "up");
    assert.equal(tui.lines().at(-1), "fallback ›", "Up does not recall the submitted prompt into the fallback field");
    tui.key(undefined, "down");
    assert.equal(tui.lines().at(-1), "fallback ›", "Down does not recall into the fallback field either");

    // The fallback editor still holds the line: its Enter lands the write, leaving the draft clear.
    for (const ch of "omlx/Qwen3.8-27B") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team fallback set to/);
    const cfg = readJson(path.join(repo, "tumwater.json")) as { fallback?: unknown };
    assert.equal(cfg.fallback, "omlx/Qwen3.8-27B", "the fallback editor's Enter still lands");
  });
});

// Pre-filling reads the team's top-level key at open time, so a set config pre-fills the line
// even before the operator types anything — a bare string as-is, an array or map as JSON.
test("Ctrl+L pre-fills the key as-is or as compact JSON from a set fallback", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    setConfigKey(repo, "fallback", "omlx/Qwen3.8-27B");
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), "fallback › omlx/Qwen3.8-27B", "a bare string pre-fills as-is");
    tui.key(undefined, "l", { ctrl: true }); // cancel out

    setConfigKey(repo, "fallback", '["omlx/Qwen3.8-27B"]');
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'fallback › ["omlx/Qwen3.8-27B"]', "a step list pre-fills as compact JSON");
    tui.key(undefined, "l", { ctrl: true });

    setConfigKey(repo, "fallback", '{"strong":{"model":"omlx/Qwen3.8-27B"}}');
    tui.key(undefined, "l", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'fallback › {"strong":{"model":"omlx/Qwen3.8-27B"}}', "a tier map pre-fills as compact JSON");
  });
});
