import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+X role-model editor on a role's Transcript view (PLANS.md): the terminal twin of the
// dashboard role drawer's Model overrides editor and `tumwater role <id> --model`/`--clear-model`.
// Pre-filled with the viewed role's own `roles.<base>.model` override read from the FILE, Enter
// writes through the shared setRoleModelFields, an empty or whitespace-only line clears it, and
// Esc and Ctrl+T cancel by restoring the prompt draft. The unit-level scope on tui-keys.test.ts
// pins the instance→base mapping; this file drives the full TUI.
test("Ctrl+X edits the viewed role's model override; Enter saves a model id or tier, empty clears, Esc and Ctrl+T exit", async () => {
  const repo = await makeTuiRepo(); // one enabled role: clean
  const cfgPath = path.join(repo, "tumwater.json");
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → clean's transcript
    assert.match(tui.lastFrame(), /Transcript: clean \(1\/1\)/);

    // A draft prompt first — leaving role-model mode must restore it byte-for-byte.
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+X opens pre-filled with the (unset) override and flashes the hint; the footer's
    // hint branch names the mode's own save/cancel keys, and the prompt line labels the mode
    // with the brand tone.
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's model override/);
    assert.equal(tui.lines().at(-1), "role model ›"); // the brand labels the mode
    assert.match(tui.lastFrame(), /Enter save role model/);

    // Enter on a model id persists it to tumwater.json as roles.clean.model and returns to
    // prompt mode with the saved draft restored.
    for (const ch of "claude-3-7-sonnet") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model override set to claude-3-7-sonnet/);
    let cfg = readJson(cfgPath) as { roles?: Record<string, { model?: string }> };
    assert.equal(cfg.roles?.clean?.model, "claude-3-7-sonnet");
    assert.equal(tui.lines().at(-1), "director › draft prompt"); // previous prompt restored

    // Re-entering pre-fills the just-saved override.
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /edit clean's model override/);
    assert.equal(tui.lines().at(-1), "role model › claude-3-7-sonnet");

    // Enter on a tier name (strong) writes that literal through the same setter.
    for (let i = 0; i < "claude-3-7-sonnet".length; i++) tui.key(undefined, "backspace");
    for (const ch of "strong") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model override set to strong/);
    cfg = readJson(cfgPath) as { roles?: Record<string, { model?: string }> };
    assert.equal(cfg.roles?.clean?.model, "strong", "a tier name is written literally");

    // A whitespace-only line on Enter clears the key and flashes the cleared wording.
    tui.key(undefined, "x", { ctrl: true });
    for (let i = 0; i < "strong".length; i++) tui.key(undefined, "backspace");
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model override cleared/);
    cfg = readJson(cfgPath) as { roles?: Record<string, { model?: string }> };
    assert.equal(cfg.roles?.clean?.model, undefined, "the key is removed");

    // Clearing a key the file never set is a no-op that leaves the file bytes unchanged — even
    // though the catalog seeds a model for every built-in role, the editor judges presence
    // against the FILE, so the seed is not mistaken for an operator override.
    const before = fs.readFileSync(cfgPath, "utf8");
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "role model ›", "an unset override pre-fills empty, not the seed");
    tui.key(undefined, "return"); // the pre-filled line is empty → clear
    assert.match(tui.lastFrame(), /clean: model override cleared/);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "clearing an absent key leaves the file unchanged");

    // Esc cancels back to prompt mode with the previous text restored.
    tui.key(undefined, "x", { ctrl: true });
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › draft prompt");

    // Ctrl+T also restores the draft (and cycles away from the view).
    for (const ch of "again") tui.key(ch, ch);
    tui.key(undefined, "x", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › draft promptagain", "Ctrl+T restores the draft");
  });
});

// The prompt-line editors share one line, so the role-model editor must not enter while another
// holds it (and vice versa); each flashes the way out.
test("Ctrl+X is mutually exclusive with the other prompt-line editors", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    for (const ch of "draft prompt") tui.key(ch, ch);

    // Ctrl+B (budget) holds the line first; Ctrl+X must flash the way out, not open.
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "x", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the budget edit first/);
    assert.equal(tui.lines().at(-1), "daily cap $", "still in budget mode");
    tui.key(undefined, "escape"); // out of budget mode

    // Role-model mode open; Ctrl+B must flash the way out and leave role-model mode alone.
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "role model ›");
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the role model edit first/);
    assert.equal(tui.lines().at(-1), "role model ›", "the role-model editor keeps the line");
    tui.key(undefined, "escape");
  });
});

// The per-role controls and pane arms must stay inert while the role-model editor holds the
// prompt line, exactly like the sibling interval editor: Ctrl+P/W would otherwise open a second
// pause/wake prompt-line editor and Ctrl+A/V write run state, and Ctrl+G/E scope/window and
// Ctrl+N sub-view cycle would act while the editor owns the line.
test("Ctrl+X holds the line against the per-role controls and the transcript pane arms", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → clean's transcript
    tui.key(undefined, "x", { ctrl: true });
    assert.equal(tui.lines().at(-1), "role model ›");
    for (const ch of "sonnet") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "role model › sonnet");

    // Per-role controls (Ctrl+P pause, Ctrl+W wake, Ctrl+A abort, Ctrl+V counters) are
    // excluded while the editor holds the line: none opens a pause/wake editor or writes run
    // state, and the pending model text survives untouched.
    for (const name of ["p", "w", "a", "v"]) {
      tui.key(undefined, name, { ctrl: true });
      assert.equal(
        tui.lines().at(-1),
        "role model › sonnet",
        `Ctrl+${name.toUpperCase()} must not disturb the role-model editor`,
      );
    }

    // Pane arms are excluded too: Ctrl+N stays on the transcript sub-view (it does not cycle
    // to the notebook), and Ctrl+G/E scope/window do not act — the role-model line still owns
    // the prompt line.
    for (const name of ["n", "g", "e"]) {
      tui.key(undefined, name, { ctrl: true });
      assert.equal(
        tui.lines().at(-1),
        "role model › sonnet",
        `Ctrl+${name.toUpperCase()} must not act while the role-model editor holds the line`,
      );
    }

    // Enter still commits the held model value, proving the editor survived every stray key.
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /clean: model override set to sonnet/);
  });
});
