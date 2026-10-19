import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

const SEED = "huggingface/Qwen/Qwen2.5-7B-Instruct";
const MAP = `{"strong":"${SEED}"}`;

// Ctrl+A team-model editor on the Activity view (PLANS.md): the terminal twin of the dashboard
// Settings `Model` field and `tumwater config set model`. Pre-filled from the file's top-level
// `model` (a bare selector string as-is, a tier map as compact JSON, empty when unset), Enter
// writes through the shared setConfigKey/unsetConfigKey family — which JSON-parses the text, so
// a bare id stays a literal string while `{"strong":"..."}` becomes the map, and validateConfig
// owns the value's truth (a number flashes the model validator's message and stays open) — an
// empty line clears the key, Esc and Ctrl+T cancel by restoring the prompt draft.
test("Ctrl+A edits the team's model; a selector string and a tier map save, a number stays open, empty clears, Esc restores the draft", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  // Seed a bare selector string so the open pre-fills it as-is.
  {
    const cfg = loadConfig(repo);
    cfg.model = SEED;
    saveConfig(repo, cfg);
  }
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving model mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // The bare Activity hint advertises the Ctrl+A team-model editor.
    assert.match(tui.lastFrame(), /Ctrl\+A model/);

    // Ctrl+A opens pre-filled with the file's `model` and flashes the hint; the footer's hint
    // branch names the mode's own save/cancel keys.
    tui.key(undefined, "a", { ctrl: true });
    assert.match(tui.lastFrame(), /edit the team's model/);
    assert.equal(tui.lines().at(-1), `model › ${SEED}`);
    assert.match(tui.lastFrame(), /Enter save the model/);

    // Backspace the seed, type a JSON tier map, Enter → the object is written.
    for (let i = 0; i < SEED.length; i++) tui.key(undefined, "backspace");
    for (const ch of MAP) tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team model set to \{"strong":.*\}/);
    const cfgMap = readJson(cfgPath) as { model?: { strong?: string } };
    assert.equal(cfgMap.model?.strong, SEED, "the map's strong tier lands in tumwater.json");
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the map as compact JSON.
    tui.key(undefined, "a", { ctrl: true });
    assert.equal(tui.lines().at(-1), `model › ${MAP}`);

    // A number (42) flashes the model validator's message, STAYS open with the text kept, and
    // writes nothing — the file stays byte-identical.
    const beforeInvalid = fs.readFileSync(cfgPath, "utf8");
    for (let i = 0; i < MAP.length; i++) tui.key(undefined, "backspace");
    for (const ch of "42") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(
      tui.lastFrame(),
      /model must be a model id or a map by tier \(small, default, strong\)/,
    );
    assert.equal(tui.lines().at(-1), "model › 42", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), beforeInvalid, "an invalid model is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Re-open (pre-filled with the map again), clear the line, Enter → the key disappears and
    // the flash names the cleared wording.
    tui.key(undefined, "a", { ctrl: true });
    assert.equal(tui.lines().at(-1), `model › ${MAP}`);
    for (let i = 0; i < MAP.length; i++) tui.key(undefined, "backspace");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team model cleared/);
    const cfgCleared = readJson(cfgPath) as { model?: unknown };
    assert.equal(cfgCleared.model, undefined, "the key is removed from tumwater.json");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Clearing a key the file no longer has is a no-op that leaves the file bytes unchanged.
    const beforeAbsent = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "a", { ctrl: true }); // the pre-filled line is empty now
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /team model cleared/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), beforeAbsent, "clearing an absent key leaves the file unchanged");
  });
});

// The prompt-line editors share one line, so the model editor must not enter while another
// holds it (and vice versa); each flashes the way out. Ctrl+T exits model mode too — view
// cycling is orthogonal to the editor, so it never strands the pre-filled text.
test("Ctrl+A is mutually exclusive with the other prompt-line editors, and Ctrl+T exits it", async () => {
  const repo = await makeTuiRepo();
  {
    const cfg = loadConfig(repo);
    cfg.model = SEED;
    saveConfig(repo, cfg);
  }
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+A must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "a", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Model mode open; Ctrl+B must flash the way out and leave model mode alone.
    tui.key(undefined, "a", { ctrl: true });
    assert.equal(tui.lines().at(-1), `model › ${SEED}`);
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the model edit first/);
    assert.equal(tui.lines().at(-1), `model › ${SEED}`, "the model editor keeps the line");
    // Ctrl+F (pause) and Ctrl+Q (scheduled stop) must NOT open their editors over the model
    // line: model holds the line, so they are inert and the model text stays.
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(tui.lines().at(-1), `model › ${SEED}`, "Ctrl+F does not open pause over the model editor");
    tui.key(undefined, "q", { ctrl: true });
    assert.equal(tui.lines().at(-1), `model › ${SEED}`, "Ctrl+Q does not open the stop editor over the model editor");
    // Ctrl+R on Activity applies the pending self-redeploy — it must NOT fire over the model
    // editor's line. A restart would write a request marker and flash its apply wording, so
    // the frame must stay free of that flash; the `!session.held.model` clause in the pause
    // editor's Ctrl+R arm (the same pattern the quiet, slots and notify editors pin) keeps it
    // out, and the model text stays on the line.
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), `model › ${SEED}`, "Ctrl+R does not restart while the model editor holds the line");
    assert.doesNotMatch(tui.lastFrame(), /restart requested|no update is waiting|current with main/, "Ctrl+R does not flash a restart over the model editor");
    // Up/Down do not recall prompt history into the model editor's text.
    tui.key(undefined, "up");
    assert.equal(tui.lines().at(-1), `model › ${SEED}`, "Up does not recall history into the model text");

    // Ctrl+T exits model mode (restoring the draft) and cycles away from the view.
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    assert.match(tui.lastFrame(), /\[Transcript/, "the view cycled away");
  });
});

// The / search must not open over the model editor even when model is unset (its prefill is
// empty, which is exactly when the old / guard — `session.input === ""` and no held.model
// check — let search steal the line).
test("Ctrl+A model editor holds the line against / search when model is unset", async () => {
  const repo = await makeTuiRepo();
  // Leave `model` unset so the editor opens on an empty prefill.
  await withTui(repo, async (tui) => {
    tui.key(undefined, "a", { ctrl: true });
    assert.equal(tui.lines().at(-1), "model ›", "open pre-fills empty when model unset");
    tui.key("/", "/");
    // / does not open search over the model editor; it types into the model text instead.
    assert.equal(tui.lines().at(-1), "model › /", "/ types into the model line, not search");
  });
});
