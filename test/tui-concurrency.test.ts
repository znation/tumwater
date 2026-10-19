/** The TUI's run-cap editor (src/ui/tui/tui-editor-concurrency.ts, new with the Ctrl+N arm on
 * the Activity view): Ctrl+N opens the team `maxConcurrent` editor pre-filled from the file,
 * Enter writes a valid integer through the shared setter family (or clears the key on an
 * empty line), an invalid value flashes and stays open, and Esc/Ctrl+T restore the prompt
 * draft. The scope pin (Activity only, Backlog keeps Ctrl+N) and the frame's prefix/hint
 * branches live in the topic tests below. Uses the shared fake-TTY harness in
 * fixtures/tui-fixtures.ts. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

const configPath = (repo: string): string => path.join(repo, "tumwater.json");
const readConfig = (repo: string): { maxConcurrent?: unknown } =>
  JSON.parse(fs.readFileSync(configPath(repo), "utf8"));

test("Ctrl+N on Activity opens the run-cap editor pre-filled from the file, saving a valid integer writes it, and an invalid value stays open unchanged", async () => {
  const repo = await makeTuiRepo();
  const cfg = loadConfig(repo);
  cfg.maxConcurrent = 8;
  saveConfig(repo, cfg);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "n", { ctrl: true });
    assert.equal(tui.lines().at(-1), "run cap › 8", "the editor opens pre-filled from the file's maxConcurrent");
    assert.match(tui.lastFrame(), /maxConcurrent, an integer ≥ 1/);

    // Save a valid integer; the file holds a JSON number and the editor closes.
    for (let i = 0; i < 3; i++) tui.key(undefined, "backspace"); // clear "8"
    for (const ch of "10") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /max concurrent runs set to 10/);
    assert.match(tui.lines().at(-1)!, /^director ›/);
    assert.equal(readConfig(repo).maxConcurrent, 10, "a JSON number reaches tumwater.json");

    // A `0` is refused by the validator: the flash names maxConcurrent, the editor stays
    // open with the text kept, and the file is unchanged.
    tui.key(undefined, "n", { ctrl: true });
    for (let i = 0; i < 3; i++) tui.key(undefined, "backspace"); // clear "10"
    tui.key("0", "0");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /maxConcurrent must be an integer of at least 1/);
    assert.equal(tui.lines().at(-1), "run cap › 0", "invalid input keeps the editor open with the text kept");
    assert.equal(readConfig(repo).maxConcurrent, 10, "the file is byte-unchanged");

    // A non-integer word is refused the same way.
    for (let i = 0; i < 3; i++) tui.key(undefined, "backspace");
    for (const ch of "two") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /maxConcurrent must be an integer of at least 1/);
    assert.equal(tui.lines().at(-1), "run cap › two");
    assert.equal(readConfig(repo).maxConcurrent, 10, "the file is byte-unchanged");
  });
});

test("Enter trims surrounding whitespace before writing and flashing the run cap", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // The shared team-editor factory trims the line on Enter (the old pass-through editor
    // flashed the raw string), so a typed ` 9 ` saves and reports as `9`.
    tui.key(undefined, "n", { ctrl: true });
    for (let i = 0; i < 1; i++) tui.key(undefined, "backspace"); // clear the prefilled "6"
    tui.key(" ", " ");
    tui.key("9", "9");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /max concurrent runs set to 9/, "the flash shows the trimmed value, not the raw ` 9 `");
    assert.equal(readConfig(repo).maxConcurrent, 9, "the count is trimmed to the JSON number in tumwater.json");
  });
});

test("Enter on an empty line clears the run cap and flashes the reset wording", async () => {
  const repo = await makeTuiRepo();
  const cfg = loadConfig(repo);
  cfg.maxConcurrent = 12;
  saveConfig(repo, cfg);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "n", { ctrl: true });
    for (let i = 0; i < 3; i++) tui.key(undefined, "backspace"); // clear "12"
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /max concurrent runs reset to the default/);
    assert.match(tui.lines().at(-1)!, /^director ›/);
    assert.equal("maxConcurrent" in readConfig(repo), false, "the empty line removes the key (the default returns)");
  });
});

test("Esc and Ctrl+T cancel the run-cap editor and restore the prompt draft byte-for-byte", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "hello") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "director › hello");

    // Esc restores the pre-typed draft.
    tui.key(undefined, "n", { ctrl: true });
    assert.equal(tui.lines().at(-1), "run cap › 6", "pre-filled with the default maxConcurrent when the file has none set");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › hello");

    // Ctrl+T (from inside the editor) restores the draft and cycles the view.
    tui.key(undefined, "n", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › hello");
  });
});

test("Ctrl+N while another editor holds the line flashes the busy message and leaves that editor open", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "b", { ctrl: true }); // the budget editor holds the line
    assert.match(tui.lines().at(-1)!, /^daily cap \$/);
    tui.key(undefined, "n", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1)!, /^daily cap \$/, "the budget editor stays open; the run-cap editor did not open");
  });
});

// The run-cap editor (Ctrl+N) opens on the Activity view, where the pause editor's own
// direct-guard team arms (Ctrl+F pause, Ctrl+Q stop) and the Ctrl+R restart arm also live.
// Those editors guard their keys with their own held-flag checks rather than
// heldEditorFlash, so the run-cap editor must also keep them out: each stays inert while it
// holds the line — leaving the run-cap editor (and its pre-filled text) untouched and the
// write still landing on Enter, rather than letting the pause editor pile a duration onto the
// run-cap line and commit it as maxConcurrent on Enter (the wrong-write the shared guard
// prevents). The per-loop Ctrl+P/Ctrl+W and the per-role Ctrl+R arms live on a role's
// Transcript, where the run-cap editor (Activity-only) never holds the line, so they are not
// exercised here — the pause/prompt held-flag lists still name concurrency for that reason.
test("Ctrl+F, Ctrl+Q and Ctrl+R stay inert while the run-cap editor holds the line on Activity", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft prompt") tui.key(ch, ch);
    tui.key(undefined, "n", { ctrl: true });
    assert.equal(tui.lines().at(-1), "run cap \u203a 6");

    // None of the direct-guard teams arms may open over the run-cap editor on the shared line.
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(tui.lines().at(-1), "run cap \u203a 6", "Ctrl+F does not open the team-pause editor");
    tui.key(undefined, "q", { ctrl: true });
    assert.equal(tui.lines().at(-1), "run cap \u203a 6", "Ctrl+Q does not open the team-stop editor");
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "run cap \u203a 6", "Ctrl+R does not run the restart arm");
    // The shared `/` search editor opens on the Activity view, so it too must stay inert
    // while the run-cap editor holds the line — otherwise it would overlay the run cap and
    // steal its Enter for a wrong maxConcurrent write. The `/` falls through as ordinary
    // text, so the line stays a run-cap line (it does not become the search prompt).
    tui.key(undefined, "/");
    assert.match(tui.lines().at(-1)!, /^run cap \u203a/, "`/` does not open the shared search editor");
    tui.key(undefined, "backspace"); // drop the typed `/`, back to "run cap › 6"

    // The run-cap editor is still the one holding the line: its Enter lands the run cap.
    for (let i = 0; i < 1; i++) tui.key(undefined, "backspace"); // clear "6"
    for (const ch of "9") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /max concurrent runs set to 9/);
    assert.equal(tui.lines().at(-1), "director \u203a draft prompt");
    assert.equal(readConfig(repo).maxConcurrent, 9);
  });
});
