import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";
import { loadConfig, saveConfig } from "../src/config/config.js";

// Ctrl+G parallel-runner-count editor on a role's Transcript view (PLANS.md): the terminal twin
// of `tumwater role <id> --instances` and the dashboard drawer's instance-count editor.
// Pre-filled with the viewed role's own `roles.<base>.instances` override read from the FILE,
// Enter writes through the shared setConfigKey/unsetConfigKey family, an empty or whitespace-only
// line clears the key, an out-of-range or non-integer value or a non-instance role flashes the
// validateConfig message and stays open, and Esc and Ctrl+T cancel by restoring the prompt draft.
// The unit-level scope on tui-keys.test.ts pins the instance→base write and the view split; this
// file drives the full TUI.

/** A repo with only the feature role enabled (the one role that may split), so one Ctrl+T from
 * Activity reaches its Transcript. */
async function makeFeatureRepo(): Promise<string> {
  const repo = await makeTuiRepo(); // clean enabled only
  const cfg = loadConfig(repo);
  const roles = cfg.roles as Record<string, { enabled?: boolean }>;
  for (const rc of Object.values(roles)) rc.enabled = false;
  roles.feature = { ...roles.feature, enabled: true };
  saveConfig(repo, cfg);
  return repo;
}

test("Ctrl+G edits the viewed role's parallel-runner count; Enter saves, empty clears, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeFeatureRepo(); // roster: feature
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → feature's transcript
    assert.match(tui.lastFrame(), /Transcript: feature \(1\/1\)/);

    // A draft prompt first — leaving instances mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+G opens with the footer's `instances ›` prefix and the line empty when the config
    // leaves `roles.feature.instances` unset; the flash names the role and the 1-8 /
    // feature-and-bugfix shape.
    tui.key(undefined, "g", { ctrl: true });
    assert.match(tui.lastFrame(), /edit feature's parallel-runner count/);
    assert.match(tui.lastFrame(), /integer 1-8/);
    assert.equal(tui.lines().at(-1), "instances ›"); // empty when unset
    assert.match(tui.lastFrame(), /Enter save instances/);

    // Enter on a valid count persists it to tumwater.json as a JSON number and returns to
    // prompt mode.
    for (const ch of "3") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /feature: instances set to 3/);
    let cfg = readJson(cfgPath) as { roles?: Record<string, { instances?: number }> };
    assert.equal(cfg.roles?.feature?.instances, 3);
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the just-saved count.
    tui.key(undefined, "g", { ctrl: true });
    assert.match(tui.lastFrame(), /edit feature's parallel-runner count/);
    assert.equal(tui.lines().at(-1), "instances › 3");

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    for (let i = 0; i < 3; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /feature: instances cleared/);
    cfg = readJson(cfgPath) as { roles?: Record<string, { instances?: number }> };
    assert.equal(cfg.roles?.feature?.instances, undefined, "the key is removed");

    // Clearing a key the file never set is a no-op that leaves the file bytes unchanged.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "g", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instances ›", "an unset count pre-fills empty, not 1");
    tui.key(undefined, "return"); // the pre-filled line is empty → unset
    assert.match(tui.lastFrame(), /feature: instances cleared/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "clearing an absent key leaves the file unchanged");

    // A `0` (below the 1-8 bound) flashes the validateConfig message, STAYS in edit mode with
    // the text kept, and writes nothing.
    tui.key(undefined, "g", { ctrl: true });
    for (const ch of "0") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /roles\.feature\.instances/);
    assert.equal(tui.lines().at(-1), "instances › 0", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an out-of-range value is not written");

    // A `9` (above the 1-8 bound) is likewise rejected, keeps the line, and writes nothing.
    for (let i = 0; i < 1; i++) tui.key(undefined, "backspace");
    for (const ch of "9") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /roles\.feature\.instances/);
    assert.equal(tui.lines().at(-1), "instances › 9", "an out-of-range value is rejected and kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "an out-of-range value is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Re-open and Ctrl+T exits too, restoring the draft while cycling away from the view.
    tui.key(undefined, "g", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    assert.match(tui.lastFrame(), /\[Backlog\]/, "the view cycled away");
  });
});

test("a non-instance role's Transcript refuses the instances write and stays open", async () => {
  const repo = await makeTuiRepo(); // roster: clean (a non-instance role)
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);

    tui.key(undefined, "g", { ctrl: true });
    assert.equal(tui.lines().at(-1), "instances ›");
    for (const ch of "3") tui.key(ch, ch);
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /roles\.clean\.instances/);
    assert.equal(tui.lines().at(-1), "instances › 3", "a non-instance role stays open with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "nothing is written under clean");
  });
});

test("Ctrl+G is mutually exclusive with the other prompt-line editors, flashing the way out", async () => {
  const repo = await makeTuiRepo(); // roster: clean
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript

    // Ctrl+B (budget) holds the line first; Ctrl+G must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /daily cap/);
    tui.key(undefined, "g", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lastFrame(), /daily cap \$/, "still in budget mode");
  });
});
