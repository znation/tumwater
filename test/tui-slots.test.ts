import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { setConfigKey } from "../src/config/config-write.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+W worktree-pool editor on the prompt line: the terminal twin of the dashboard Settings
// `Worktree slots` field and `tumwater config set worktreeSlots`. The Activity view opens it
// pre-filled from tumwater.json's `worktreeSlots` (empty when unset), Enter saves through the
// shared setter (which writes tumwater.json, validateConfig owning the value's truth), an empty
// line unsets the key (restoring the default), invalid input stays open with the file untouched,
// and Esc/Ctrl+T/Ctrl+W restore the draft.
test("Ctrl+W on Activity edits the worktree pool size; Enter saves, invalid stays open, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // no worktreeSlots written: pre-fills empty
  await withTui(repo, async (tui) => {
    // A draft prompt first — leaving slots mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+W enters slots-edit mode: pre-filled empty (the key is unset) and a hint flash.
    tui.key(undefined, "w", { ctrl: true });
    assert.match(tui.lastFrame(), /worktreeSlots/);
    assert.equal(tui.lines().at(-1), "worktree slots ›");

    // Enter on a valid integer persists it to tumwater.json as a JSON number and returns.
    for (const ch of "9") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /worktree slots set to 9/);
    let cfg = readJson(path.join(repo, "tumwater.json")) as { worktreeSlots?: number };
    assert.equal(cfg.worktreeSlots, 9);
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt text restored

    // Re-entering pre-fills the saved value.
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "worktree slots › 9");

    // Invalid input flashes the validator's message and STAYS in edit mode so it can be fixed,
    // with the file byte-identical.
    const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
    tui.key(undefined, "backspace");
    for (const ch of "two") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /worktreeSlots must be an integer of at least 1/);
    assert.equal(tui.lines().at(-1), "worktree slots › two", "still in edit mode with the text kept");
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "the file is byte-identical");

    // 0 also fails the same screen and stays open.
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    tui.key(undefined, "backspace");
    for (const ch of "0") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /worktreeSlots must be an integer of at least 1/);
    assert.equal(tui.lines().at(-1), "worktree slots › 0");
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "0 writes nothing");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Re-enter, leave with an empty (unset) line: Enter removes the key, flashing the reset
    // wording.
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "worktree slots › 9");
    tui.key(undefined, "backspace");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /worktree slots reset to the default/);
    cfg = readJson(path.join(repo, "tumwater.json")) as { worktreeSlots?: number };
    assert.equal(cfg.worktreeSlots, undefined, "the key is removed from the file");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Ctrl+T also exits slots mode — cycling the view and restoring the draft. Re-enter (the
    // key is unset again, so the line pre-fills empty), then Ctrl+T leaves both.
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "worktree slots ›");
    tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Transcript: clean/);
    assert.equal(tui.lines().at(-1), "director › draft prompt");
  });
});

test("Ctrl+W and Ctrl+B are mutually exclusive: each flashes the busy guard and leaves the open editor alone", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // With the budget editor open (Ctrl+B), Ctrl+W flashes the busy way out and leaves it open.
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $ 50");
    tui.key(undefined, "w", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.equal(tui.lines().at(-1), "daily cap $ 50", "budget stays open");
    tui.key(undefined, "escape");

    // With the slots editor open, Ctrl+B flashes the busy way out and leaves IT open.
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "worktree slots ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the worktree slots first/);
    assert.equal(tui.lines().at(-1), "worktree slots ›", "slots stays open");
    tui.key(undefined, "escape");
  });
});

test("Ctrl+W defaults to an unset pool size and an empty Enter leaves the file unchanged when the key is absent", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "worktree slots ›", "unset pre-fills an empty line");
    tui.key(undefined, "return"); // whitespace-only: nothing to unset, a no-op success
    assert.match(tui.lastFrame(), /worktreeSlots is not set in tumwater\.json, so nothing was cleared/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "an absent key leaves the file unchanged");
    assert.equal(tui.lines().at(-1), "director ›");
  });
});

test("Ctrl+W pre-fills a seeded worktreeSlots and Ctrl+W again exits restoring the draft", async () => {
  const repo = await makeTuiRepo();
  const seed = setConfigKey(repo, "worktreeSlots", "12");
  assert.equal(seed.ok, true);
  await withTui(repo, async (tui) => {
    for (const ch of "keep me") tui.key(ch, ch);
    tui.key(undefined, "w", { ctrl: true }); // enter: pre-filled with the seeded value
    assert.equal(tui.lines().at(-1), "worktree slots › 12");

    // The same key in edit mode toggles out (the exit branch), restoring the draft.
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › keep me");

    // The toggle is symmetric: re-entering re-fills the value, and the draft survives a second
    // round-trip through the editor.
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(tui.lines().at(-1), "worktree slots › 12");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › keep me");
  });
});

// While the slots editor holds the prompt line, the other prompt-line gestures that ignore it
// must not sneak in: Ctrl+R (forced self-redeploy) must not drop a restart marker mid-edit, and
// `/` must not open the search editor (which would leave BOTH held.slots and held.search set).
test("Ctrl+W excludes the Ctrl+R restart and the `/` search while it holds the line", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "w", { ctrl: true }); // enter slots mode on the empty default line
    assert.equal(tui.lines().at(-1), "worktree slots ›");

    // Ctrl+R with the editor open restarts nothing: no marker is dropped and the editor stays.
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(
      fs.existsSync(path.join(repo, ".tumwater", "restart.json")),
      false,
      "Ctrl+R in slots mode must not write the restart marker",
    );
    assert.equal(tui.lines().at(-1), "worktree slots ›", "still in slots mode");

    // `/` on the empty line types into the editor instead of opening search (which would set
    // held.search while held.slots is already set — breaking the mutual exclusion).
    tui.key("/", "/");
    assert.equal(tui.lines().at(-1), "worktree slots › /", "`/` types into the editor, search stays closed");
  });
});
