import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";
import { setConfigKey } from "../src/config/config-write.js";

// Ctrl+P per-provider-concurrency-caps editor on the Activity view (PLANS.md): the terminal
// twin of the dashboard Settings `Provider concurrency caps (JSON)` field and `tumwater config
// set maxConcurrentPerProvider`. Pre-filled with the team's top-level `maxConcurrentPerProvider`
// (compact JSON when set, empty when unset), Enter writes through the shared
// setConfigKey/unsetConfigKey family, an empty or whitespace-only line clears the key, a
// non-object or a non-positive-integer cap flashes the validator's message and stays open, and
// Esc and Ctrl+T cancel by restoring the prompt draft. The unit-level scope on tui-keys.test.ts
// pins the Activity-vs-Transcript Ctrl+P split; this file drives the full TUI.
test("Ctrl+P edits the team's provider caps; Enter saves, empty clears, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // start view is Activity
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving provider-caps mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+P opens with the footer's `provider caps ›` prefix and the line empty when the
    // config leaves maxConcurrentPerProvider unset; the flash names the key and the shape.
    tui.key(undefined, "p", { ctrl: true });
    assert.match(tui.lastFrame(), /edit the team's provider concurrency caps/);
    assert.match(tui.lastFrame(), /JSON object/);
    assert.equal(tui.lines().at(-1), "provider caps ›"); // empty when unset
    assert.match(tui.lastFrame(), /Enter save provider caps/);

    // Enter on a valid JSON object persists it to tumwater.json and returns to prompt mode.
    for (const ch of '{"anthropic":2}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /provider concurrency caps set to \{"anthropic":2\}/);
    let cfg = readJson(cfgPath) as { maxConcurrentPerProvider?: Record<string, number> };
    assert.deepEqual(cfg.maxConcurrentPerProvider, { anthropic: 2 });
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the saved caps as compact JSON.
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'provider caps › {"anthropic":2}');

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    for (let i = 0; i < 15; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /provider concurrency caps cleared/);
    cfg = readJson(cfgPath) as { maxConcurrentPerProvider?: Record<string, number> };
    assert.equal(cfg.maxConcurrentPerProvider, undefined, "the key is removed");

    // A non-object value (setConfigKey JSON-parses `anthropic` into the literal string, which
    // validateConfig's map block rejects) or a non-positive-integer cap flashes the validator's
    // message, STAYS in edit mode with the text kept, and writes nothing.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "p", { ctrl: true });
    for (const ch of "anthropic") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /maxConcurrentPerProvider must be an object mapping provider names/);
    assert.equal(tui.lines().at(-1), "provider caps › anthropic", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a non-object is not written");
    tui.key(undefined, "escape");

    // A cap of 0 (a non-positive integer) flashes the per-provider validator message.
    tui.key(undefined, "p", { ctrl: true });
    for (const ch of '{"anthropic":0}') tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /maxConcurrentPerProvider\.anthropic must be an integer of at least 1/);
    assert.equal(tui.lines().at(-1), 'provider caps › {"anthropic":0}', "still open with the text kept");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "a non-positive cap is not written");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Ctrl+T also exits provider-caps mode, restoring the draft (and cycles away from Activity).
    for (const ch of "x") tui.key(ch, ch);
    tui.key(undefined, "p", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft promptx");
    assert.match(tui.lastFrame(), /\[Transcript/, "the view cycled away");
  });
});

// The prompt-line editors share one line, so the provider-caps editor must not enter while
// another holds it (and vice versa); each flashes the way out.
test("Ctrl+P is mutually exclusive with the other prompt-line editors, and Ctrl+P again exits it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+P must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "p", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1) ?? "", /daily cap \$/); // still in budget mode
    tui.key(undefined, "escape"); // out of budget mode

    // Provider-caps mode open; Ctrl+B must flash the way out and leave it alone.
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), "provider caps ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the provider caps first/);
    assert.equal(tui.lines().at(-1), "provider caps ›", "the provider-caps editor keeps the line");

    // Ctrl+P again while open cancels it and restores the draft.
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// Pre-filling reads the team's top-level key at open time, so a set config pre-fills the line
// even before the operator types anything — the editor writes back through the same key.
test("Ctrl+P pre-fills compact JSON from a set maxConcurrentPerProvider", async () => {
  const repo = await makeTuiRepo();
  setConfigKey(repo, "maxConcurrentPerProvider", '{"openai":1,"anthropic":2}');
  await withTui(repo, async (tui) => {
    tui.key(undefined, "p", { ctrl: true });
    assert.equal(tui.lines().at(-1), 'provider caps › {"openai":1,"anthropic":2}');
  });
});
