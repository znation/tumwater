/** The TUI's notify-hook editor (src/ui/tui/tui-editor-notify.ts, new with the Ctrl+E arm on
 * the Activity view): Ctrl+E opens the team `notify` editor pre-filled from the file, Enter
 * writes a command through the shared setter family (or clears the key on an empty line), an
 * invalid non-string value flashes and stays open with the file byte-identical, and
 * Esc/Ctrl+T restore the prompt draft. The mutually-exclusive busy guard with the budget
 * editor runs both directions. The scope pin (Activity only, other views keep Ctrl+E) and
 * the frame's prefix/hint branches live in the topic tests below. Uses the shared fake-TTY
 * harness in fixtures/tui-fixtures.ts. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

const configPath = (repo: string): string => path.join(repo, "tumwater.json");
const readConfig = (repo: string): { notify?: unknown } =>
  JSON.parse(fs.readFileSync(configPath(repo), "utf8"));
const configBytes = (repo: string): Buffer => fs.readFileSync(configPath(repo));

test("Ctrl+E on Activity opens the notify editor pre-filled from the file, a command Enter saves it, and a non-string is refused unchanged", async () => {
  const repo = await makeTuiRepo();
  const cfg = loadConfig(repo);
  cfg.notify = "notify-me --event x";
  saveConfig(repo, cfg);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "e", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook › notify-me --event x", "the editor opens pre-filled from the file's notify");
    assert.match(tui.lastFrame(), /notify, the shell command run on notable events/);

    // Enter on a command writes that literal string and the editor closes.
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /notify hook set to notify-me --event x/);
    assert.match(tui.lines().at(-1)!, /^director ›/);
    assert.equal(readConfig(repo).notify, "notify-me --event x");

    // A number is refused by the validator: the flash names notify, the editor stays open
    // with the text kept, and the file is byte-identical.
    const before = configBytes(repo);
    tui.key(undefined, "e", { ctrl: true });
    for (let i = 0; i < "notify-me --event x".length; i++) tui.key(undefined, "backspace");
    tui.key("42", "42");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /notify must be a string/);
    assert.equal(tui.lines().at(-1), "notify hook › 42", "a non-string keeps the editor open with the text kept");
    assert.deepEqual(configBytes(repo), before, "the file is byte-identical after a refused write");
  });
});

test("Enter on an empty line clears the notify hook and flashes the cleared wording", async () => {
  const repo = await makeTuiRepo();
  const cfg = loadConfig(repo);
  cfg.notify = "notify-me";
  saveConfig(repo, cfg);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "e", { ctrl: true });
    for (let i = 0; i < "notify-me".length; i++) tui.key(undefined, "backspace"); // clear the pre-fill
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /notify hook cleared/);
    assert.match(tui.lines().at(-1)!, /^director ›/);
    assert.equal("notify" in readConfig(repo), false, "the empty line removes the key");

    // Empty-clear on a hook that is absent leaves the file bytes unchanged.
    const before = configBytes(repo);
    tui.key(undefined, "e", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook ›", "pre-filled empty when the file has no notify");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /notify hook cleared/);
    assert.deepEqual(configBytes(repo), before, "an already-absent hook leaves the file byte-identical");
  });
});

test("Esc and Ctrl+T cancel the notify editor and restore the prompt draft byte-for-byte", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "hello") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "director › hello");

    // Esc restores the pre-typed draft.
    tui.key(undefined, "e", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook ›", "pre-filled empty when the file has none set");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › hello");

    // Ctrl+T (from inside the editor) restores the draft and cycles the view.
    tui.key(undefined, "e", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › hello");
  });
});

test("Ctrl+E and other editors are mutually exclusive with the notify editor via the busy guard", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // With the budget editor open, Ctrl+E flashes the busy message and leaves it open.
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lines().at(-1)!, /^daily cap \$/);
    tui.key(undefined, "e", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.match(tui.lines().at(-1)!, /^daily cap \$/, "the budget editor stays open; the notify editor did not open");

    // With the notify editor open, another editor flashes the busy message and stays out.
    tui.key(undefined, "escape"); // close the budget editor
    tui.key(undefined, "e", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the notify hook first/);
    assert.equal(tui.lines().at(-1), "notify hook ›", "the notify editor stays open");
  });
});

// The notify editor (Ctrl+E) opens on the Activity view, where the pause editor's own
// direct-guard team arms (Ctrl+F pause, Ctrl+Q stop) and the Ctrl+R restart arm also live.
// Those editors guard their keys with their own held-flag checks rather than
// heldEditorFlash, so the notify editor must also keep them out: each stays inert while it
// holds the line — leaving the notify editor (and its pre-filled text) untouched and the
// write still landing on Enter, rather than letting the pause editor pile a duration onto
// the notify line and commit it as the notify hook on Enter (the wrong-write the shared
// guard prevents). The `/` search editor, a sibling of the same direct-guard family on
// Activity, must likewise stay out. The per-role Ctrl+P/Ctrl+W and the per-role Ctrl+R arms
// live on a role's Transcript, where the notify editor (Activity-only) never holds the line,
// so they are not exercised here — the pause/prompt held-flag lists still name notify for
// that reason.
test("Ctrl+F, Ctrl+Q, Ctrl+R and `/` stay inert while the notify editor holds the line on Activity", async () => {
  const repo = await makeTuiRepo(); // no notify set, so the editor pre-fills EMPTY
  await withTui(repo, async (tui) => {
    tui.key(undefined, "e", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook ›");

    // The `/` search editor and the Ctrl+R self-redeploy arm open here on an EMPTY line and
    // admit the shared Activity view on their own: `/` needs session.input === "" and Ctrl+R
    // fires without touching the prompt line. So pressing them before any command text is
    // typed is what truly exercises the notify held-flag — a non-empty line would blunt the
    // `/` press on its own, and asserting the line text cannot distinguish an inert Ctrl+R
    // from a restart that fires but leaves the line unchanged. The notify flag is the only
    // thing keeping these two out.

    // Ctrl+R on Activity applies the pending self-redeploy — it must not fire over the notify
    // editor's line (a restart would write a request marker and flash its apply wording, so
    // the frame must stay free of that flash).
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook ›", "Ctrl+R does not restart while the notify editor holds the line");
    assert.doesNotMatch(tui.lastFrame(), /restart requested|no update is waiting|current with main/, "Ctrl+R does not flash a restart over the notify editor");

    // The shared `/` search editor opens on Activity's empty line — it must not take the line
    // over the notify editor (the notify guard, not the empty-line check, keeps it out). It
    // falls through as ordinary text, so the line stays a notify line and no search-mode
    // flash appears.
    tui.key(undefined, "/");
    assert.equal(tui.lines().at(-1), "notify hook › /", "`/` falls through as text instead of opening the search editor");
    assert.doesNotMatch(tui.lastFrame(), /search events: Enter to filter/, "no search-mode flash");

    // Ctrl+F and Ctrl+Q must not open their pause/stop editors over the notify line.
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook › /", "Ctrl+F does not open the team-pause editor");
    tui.key(undefined, "q", { ctrl: true });
    assert.equal(tui.lines().at(-1), "notify hook › /", "Ctrl+Q does not open the team-stop editor");

    // The notify editor is still the one holding the line: clear the stray `/`, type the
    // hook, and its Enter lands the notify hook.
    tui.key(undefined, "backspace");
    for (const ch of "hook cmd") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /notify hook set to hook cmd/);
    assert.equal(readConfig(repo).notify, "hook cmd");
  });
});
