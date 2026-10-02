/** The framework-free keypress factory (src/ui/tui-keys.ts) driven directly — no terminal, no
 * readline event emitter, no ink: the factory only needs a root for its disk actions, a quit
 * callback, a render-request recorder, and (for the flash-expiry case) an injectable clock.
 * One case per handler family, per PLANS.md "TUI moves to ink, part 2a/3": prompt editing,
 * budget mode open/save/cancel, role-prompt mode, history recall, view cycling and paging,
 * and flash expiry. The full-TUI key behavior keeps its coverage in tui-operator-keys.test.ts
 * and tui.test.ts through the same dispatch. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createTuiKeys } from "../src/ui/tui-keys.js";

/** A throwaway root for the factory's disk actions (config write, prompt inbox, backlog). */
const makeRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "tui-keys-"));

/** A handler wired to a controllable clock, a quit recorder, and a render-request recorder. */
function makeKeys(root: string, now: () => number) {
  const quit = (): number => (quit.count += 1);
  quit.count = 0;
  let renders = 0;
  const keys = createTuiKeys({ root, quit, requestRender: () => (renders += 1), now });
  return { keys, quitCount: () => quit.count, renders: () => renders };
}

test("applyKey edits the prompt line: typing, backspace, and cursor position flow through", () => {
  const root = makeRoot();
  const { keys, renders } = makeKeys(root, () => 0);
  for (const ch of "hi") keys.handleKey(ch, { name: ch });
  assert.equal(keys.state().input, "hi");
  assert.equal(keys.state().cursor, 2);
  keys.handleKey(undefined, { name: "backspace" });
  assert.equal(keys.state().input, "h");
  assert.equal(keys.state().cursor, 1);
  assert.ok(renders() >= 3, "every dispatched keypress requests a render");
});

test("budget mode opens pre-filled, saves the cap on Enter, and Esc cancels unchanged", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(50, false, []); // cap $50 visible to the handler
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  assert.equal(keys.state().input, "50");
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, false, "a saved cap leaves edit mode");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"));
  assert.equal(cfg.maxDailyCostUsd, 50);

  // Esc cancels: the pre-filled value never reaches config.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().budgetMode, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "tumwater.json"), "utf8")).maxDailyCostUsd, 50);

  // An invalid value flashes and STAYS in edit mode.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { ctrl: true, name: "u" }); // clear the pre-filled cap
  for (const ch of "abc") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, true, "invalid input keeps edit mode open");
  assert.match(keys.state().flash!, /must be a number/);
});

test("role-prompt mode opens for the viewed loop, submits, and Esc restores the draft", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  assert.equal(keys.state().input, "");
  for (const ch of "fix it") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().rolePromptFor, null, "submitting leaves role-prompt mode");
  const queue = path.join(root, ".tumwater", "inbox", "clean");
  assert.equal(fs.readdirSync(queue).filter((f) => f.endsWith(".md")).length, 1);

  // Esc cancels and restores the saved director draft.
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().rolePromptFor, null);
  assert.equal(fs.readdirSync(queue).length, 1, "a cancelled role prompt queues nothing");
});

test("history recall: a submitted prompt comes back on Up", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  for (const ch of "run the tests") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().input, "", "submitting clears the line");
  keys.handleKey(undefined, { name: "up" });
  assert.equal(keys.state().input, "run the tests");
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().input, "", "Down past the newest entry returns to the blank line");
});

test("Ctrl+T cycles the views and PgDn/PgUp page a selected backlog entry's body", () => {
  const root = makeRoot();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "## Planned\n\n### A plan (planned 2026-10-02 by test)\n\n" +
      Array.from({ length: 20 }, (_, i) => `body line ${i + 1}`).join("\n") + "\n",
  );
  const { keys, renders } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(5, 4); // the render-fed activity-pane budget
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → backlog (roleIds.length+1 = 1)
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedEntry, 0, "Down opens the first entry in full");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().entryScroll, 4, "PgDn advances the body window by the entry budget");
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().entryScroll, 0, "PgUp clamps back to the head");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().selectedEntry, null, "cycling away drops the selection");
  assert.ok(renders() > 0);
});

test("a flash notice expires on the injected clock", () => {
  const root = makeRoot();
  let t = 1_000_000;
  const { keys } = makeKeys(root, () => t);
  keys.syncSnapshot(0, true, []); // budget-free: Ctrl+B flashes instead of opening the editor
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().flash, "budget n/a — all models free");
  assert.equal(keys.state().budgetMode, false, "the notice replaces the editor, line untouched");
  t += 3000; // FLASH_MS has passed
  assert.equal(keys.state().flash, null, "the expired notice drops out of the rendered state");
  t -= 1500; // …and a mid-life read still shows it (expiry is a clock comparison, not a timer)
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().flash, "budget n/a — all models free");
});

test("Ctrl+C quits through the dep, and the modes are mutually exclusive", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 1, "Ctrl+C calls the quit dep and nothing else");

  keys.syncSnapshot(0, false, ["clean"]);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript
  keys.handleKey(undefined, { ctrl: true, name: "r" }); // role-prompt mode open
  keys.handleKey(undefined, { ctrl: true, name: "b" }); // budget refused
  assert.equal(keys.state().rolePromptFor, "clean", "Ctrl+B does not steal the line");
  assert.match(keys.state().flash!, /finish or cancel the prompt for clean first/);
  keys.handleKey(undefined, { name: "escape" }); // leave role mode
  keys.handleKey(undefined, { ctrl: true, name: "b" }); // budget opens now
  assert.equal(keys.state().budgetMode, true);
});