import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";
import { setConfigKey } from "../src/config/config-write.js";

// Ctrl+X agent-backends editor on the Activity view (PLANS.md): the terminal twin of the
// dashboard Settings `Agent backends (JSON)` field and `tumwater config set backends`.
// Pre-filled with the team's top-level `backends` (compact JSON when set, empty when unset),
// Enter writes through the shared setConfigKey/unsetConfigKey family, an empty or
// whitespace-only line clears the key, a non-object or a non-object entry flashes the
// validator's message and stays open with the file untouched, a legacy `agentBin` collapses to
// the single `backends.pi.bin` spelling on a whole-section save, and Esc and Ctrl+T cancel by
// restoring the prompt draft. The unit-level scope on tui-keys.test.ts pins the
// Activity-vs-other-views Ctrl+X split; this file drives the full TUI.
test("Ctrl+X edits the team's agent backends; Enter saves, empty clears, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // start view is Activity
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving backends mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+X opens with the footer's `agent backends ›` prefix and the line empty when the
    // config leaves `backends` unset; the flash names the key and the JSON-object shape.
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /edit the team's agent backends/);
    assert.match(tui.lastFrame(), /JSON object/);
    assert.equal(tui.lines().at(-1), "agent backends ›"); // empty when unset
    assert.match(tui.lastFrame(), /Enter save agent backends/);

    // Enter on a valid JSON object persists it to tumwater.json and returns to prompt mode.
    for (const ch of '{"pi":{"bin":"/opt/pi"}}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /agent backends set to \{"pi":\{"bin":"\/opt\/pi"\}\}/);
    let cfg = readJson(cfgPath) as { backends?: Record<string, Record<string, unknown>> };
    assert.deepEqual(cfg.backends, { pi: { bin: "/opt/pi" } });
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the saved section as compact JSON.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'agent backends › {"pi":{"bin":"/opt/pi"}}');

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    for (let i = 0; i < 30; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /agent backends cleared/);
    cfg = readJson(cfgPath) as { backends?: Record<string, Record<string, unknown>> };
    assert.equal(cfg.backends, undefined, "the key is removed");

    // A non-object value (setConfigKey JSON-parses `pi` into the literal string, which
    // validateConfig's section block rejects) or a non-object entry flashes the validator's
    // message, STAYS in edit mode with the text kept, and writes nothing.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "x", { ctrl: true });
    for (const ch of "pi") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /backends must be an object/);
    assert.equal(tui.lines().at(-1), "agent backends › pi", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a non-object is not written");
    tui.key(undefined, "escape");

    // A non-object entry ({"pi":5}) flashes the per-entry validator message.
    tui.key(undefined, "x", { ctrl: true });
    for (const ch of '{"pi":5}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /backends\.pi must be an object with optional bin and args/);
    assert.equal(tui.lines().at(-1), 'agent backends › {"pi":5}', "still open with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a non-object entry is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Ctrl+T also exits backends mode, restoring the draft (and cycles away from Activity).
    for (const ch of "x") tui.key(ch, ch);
    tui.key(undefined, "x", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft promptx");
    assert.match(tui.lastFrame(), /\[Transcript/, "the view cycled away");
  });
});

// The prompt-line editors share one line, so the backends editor must not enter while another
// holds it (and vice versa); each flashes the way out.
test("Ctrl+X is mutually exclusive with the other prompt-line editors, and Ctrl+X again exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+X must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Backends mode open; Ctrl+B must flash the way out and leave it alone.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "agent backends ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the agent backends first/);
    assert.equal(tui.lines().at(-1), "agent backends ›", "the backends editor keeps the line");

    // Ctrl+X again while open cancels it and restores the draft.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// Pre-filling reads the team's top-level key at open time, so a set config pre-fills the line
// even before the operator types anything — the editor writes back through the same key.
test("Ctrl+X pre-fills compact JSON from a set backends", async () => {
  const repo = await makeTuiRepo();
  setConfigKey(repo, "backends", '{"pi":{"bin":"/opt/pi"}}');
  await withTui(repo, async (tui) => {
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'agent backends › {"pi":{"bin":"/opt/pi"}}');
  });
});

// Saving over a file that carries the legacy top-level `agentBin` collapses to the single
// `backends.pi.bin` spelling: the whole-section set runs collapseAgentAliases, so the file
// never holds both forms.
test("Ctrl+X saving over a legacy agentBin leaves exactly the backends.pi.bin spelling", async () => {
  const repo = await makeTuiRepo();
  setConfigKey(repo, "agentBin", "/old/pi");
  const cfgPath = path.join(repo, "tumwater.json");
  assert.match(fs.readFileSync(cfgPath, "utf8"), /agentBin/, "the fixture seeds the legacy spelling");
  await withTui(repo, async (tui) => {
    // The legacy top-level alias is not under `backends`, so the line pre-fills empty.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "agent backends ›", "the legacy alias leaves the line empty");
    for (const ch of '{"pi":{"bin":"/opt/pi"}}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /agent backends set to/);
    const file = fs.readFileSync(cfgPath, "utf8");
    assert.doesNotMatch(file, /agentBin/, "the legacy agentBin is gone");
    const cfg = readJson(cfgPath) as {
      agentBin?: string;
      backends?: Record<string, Record<string, unknown>>;
    };
    assert.equal(cfg.agentBin, undefined, "no legacy top-level agentBin remains");
    assert.deepEqual(cfg.backends, { pi: { bin: "/opt/pi" } }, "the new spelling is the only one");
  });
});
