import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { setEnv } from "./helpers/env.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+B budget-edit mode on the prompt line (PLANS.md, editable daily cost budget): the
// single interactive surface edits the cap in place — pre-filled with the current cap, Enter
// saves through the shared setter (which writes tumwater.json), Esc/Ctrl+T restore the draft.
test("Ctrl+B edits the daily budget; Enter saves, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // defaultConfig: maxDailyCostUsd 50 (enabled)
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving budget mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B enters budget-edit mode pre-filled with the current cap and flashes a hint.
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /edit daily cost budget/);
    assert.equal(tui.lines().at(-1), "daily cap $ 50");

    // Enter on a valid value persists it to tumwater.json and returns to prompt mode.
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "25") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget set to \$25/);
    let cfg = readJson(path.join(repo, "tumwater.json")) as { maxDailyCostUsd: number };
    assert.equal(cfg.maxDailyCostUsd, 25);
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt text restored

    // Invalid input flashes the error and STAYS in edit mode so it can be fixed.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $ 25"); // re-entered pre-filled with the new cap
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "abc") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget must be a number/);
    assert.equal(tui.lines().at(-1), "daily cap $ abc", "still in edit mode with the text kept");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");
    // The Activity view's hint advertises the key.
    assert.match(tui.lastFrame(), /Ctrl\+B daily cap/);

    // Empty means "no cap": clear the line and Enter disables the budget.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $ 25");
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget disabled/);
    cfg = readJson(path.join(repo, "tumwater.json")) as { maxDailyCostUsd: number };
    assert.equal(cfg.maxDailyCostUsd, 0);

    // A disabled cap pre-fills an empty line (empty means "no cap" on save)…
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $");
    // …and Ctrl+T exits budget mode too — cycling the view and restoring the draft.
    tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Transcript: clean/);
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

// Free-state budget (BUGS.md, 2026-09-14): a fleet whose models are all free has no spend
// a cap could bind, so Ctrl+B flashes a notice instead of opening the editor — the prompt
// line stays byte-for-byte (no pre-filled cap, nothing to save on Enter).
test("Ctrl+B flashes a notice instead of opening the editor on an all-free fleet", async () => {
  const repo = await makeTuiRepo();
  // snapshot() resolves pi's model catalog at $HOME/.pi/agent/models.json (src/pi/pi-models.ts):
  // aim a temp home at an unpriced model the repo config points at, so the fleet reads free.
  const home = tmpdir("tui-free-home-");
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { "lm-studio": { models: [{ id: "qwen3.8-27b" }] } } }),
  );
  const cfg = loadConfig(repo);
  cfg.provider = "lm-studio";
  cfg.model = "qwen3.8-27b";
  saveConfig(repo, cfg);
  const restoreHome = setEnv("HOME", home); // must be set before the first render so Ctrl+B reads the free flag
  try {
    await withTui(repo, async (tui) => {
      // A draft prompt — the notice must leave it byte-for-byte intact.
      for (const ch of "draft prompt") tui.key(ch, ch);
      tui.key(undefined, "b", { ctrl: true });
      assert.match(tui.lastFrame(), /budget n\/a — all models free/);
      assert.equal(tui.lines().at(-1), "director › draft prompt", "the editor never opened — prompt untouched");
      assert.match(tui.lastFrame(), /Ctrl\+B daily cap/, "the footer hint is unchanged");
    });
  } finally {
    restoreHome();
  }
});

// Ctrl+B is a TOGGLE: pressing it while already in budget-edit mode takes the exit branch
// (exitBudgetMode) — the previous draft comes back byte-for-byte, and a following entry
// re-fills the cap. Esc and Ctrl+T exits are pinned above; this pins the third exit.
test("Ctrl+B again exits budget-edit mode, restoring the draft byte-for-byte", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "keep me") tui.key(ch, ch);
    tui.key(undefined, "b", { ctrl: true }); // enter: pre-filled with the current cap
    assert.equal(tui.lines().at(-1), "daily cap $ 50");

    // The same key in edit mode toggles out (the exit branch), restoring the draft.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › keep me");

    // The toggle is symmetric: re-entering re-fills the cap, and the draft survives a
    // second round-trip through the editor.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $ 50");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › keep me");
  });
});

// Enter in budget-edit mode saves through setDailyBudgetUsd, which reads the config FRESH
// (bypassing the display's last-known-good fallback). A broken file therefore fails the
// save while the TUI keeps rendering: the error flashes, the mode stays open so the value
// can be retried, and the broken file is never overwritten with defaults.
test("a budget save on a broken config flashes the error and stays in edit mode", async () => {
  const repo = await makeTuiRepo();
  const cfgPath = path.join(repo, "tumwater.json");
  const original = fs.readFileSync(cfgPath, "utf8");
  // The first render caches this last-known-good config.
  await withTui(repo, async (tui) => {
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $ 50");

    // Break the config AFTER the first render: render falls back to the cached copy, but
    // the saver's fresh loadConfig hits the broken file.
    fs.writeFileSync(cfgPath, "{ not valid json\n");
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "30") tui.key(ch, ch);
    tui.key(undefined, "return");

    assert.match(tui.lastFrame(), /not valid JSON/); // the load failure flashes
    assert.equal(tui.lines().at(-1), "daily cap $ 30", "still in edit mode with the value kept");
    assert.match(fs.readFileSync(cfgPath, "utf8"), /not valid json/, "the broken file is not overwritten");

    // Once the file is valid again the same draft saves — staying open was a retry, not a dead end.
    fs.writeFileSync(cfgPath, original);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /budget set to \$30/);
    assert.equal(tui.lines().at(-1), "director ›");
    const cfg = readJson(cfgPath) as { maxDailyCostUsd: number };
    assert.equal(cfg.maxDailyCostUsd, 30);
  });
});
