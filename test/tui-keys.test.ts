/** The framework-free keypress factory (src/ui/tui-keys.ts) driven directly — no terminal, no
 * readline event emitter, no ink: the factory only needs a root for its disk actions, a quit
 * callback, a render-request recorder, and (for the flash-expiry case) an injectable clock.
 * One case per handler family, per PLANS.md "TUI moves to ink, part 2a/3": prompt editing,
 * budget mode open/save/cancel, role-prompt mode, history recall, view cycling and paging,
 * and flash expiry. The full-TUI key behavior keeps its coverage in tui-operator-keys.test.ts
 * and tui.test.ts through the same dispatch. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { arrowDir, inkKeyToReadline, pageDir } from "../src/ui/tui-keymap.js";
import { createTuiKeys } from "../src/ui/tui-keys.js";
import { abortRequestPath } from "../src/paths.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";

/** A throwaway root for the factory's disk actions (config write, prompt inbox, backlog). */
const makeRoot = (): string => tmpdir("tui-keys-");

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

test("Ctrl+D quits through the dep, Ctrl+C flashes a no-task notice, and the modes are mutually exclusive", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 0, "Ctrl+C never quits");
  assert.equal(keys.state().flash, "no director task in flight");
  keys.handleKey(undefined, { ctrl: true, name: "d" });
  assert.equal(quitCount(), 1, "Ctrl+D calls the quit dep and nothing else");

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

test("Ctrl+C interrupts the director's in-flight tick: abort marker when in flight, notice when not", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  // A live harness marker (this process's pid) so requestAbort passes its liveness gate.
  writeOrchestratorMarker(root, ["director"]);
  keys.syncSnapshot(0, false, ["director"], false);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 0, "Ctrl+C quits nothing");
  assert.equal(keys.state().flash, "no director task in flight");
  assert.ok(!fs.existsSync(abortRequestPath(root, "director")), "no marker without a tick in flight");

  keys.syncSnapshot(0, false, ["director"], true);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 0);
  assert.match(keys.state().flash!, /abort requested for director/);
  assert.ok(fs.existsSync(abortRequestPath(root, "director")), "the abort marker is written");
});

// The ink bridge (PLANS.md "TUI moves to ink, part 2b/3"): ink's useInput hands the
// dispatch an (input, key) pair, the adapter maps it to the readline (str, key) shape
// handleKey was extracted with. One case per mapping family.
test("inkKeyToReadline maps ink's parsed keys to the readline shape the dispatch consumes", () => {
  // Printable text — single chars and whole composed strings — flows through as `str`.
  assert.deepEqual(inkKeyToReadline("x", {}), { str: "x", key: {} });
  assert.deepEqual(inkKeyToReadline(" ", {}), { str: " ", key: {} });
  assert.deepEqual(inkKeyToReadline("check the queue", {}), { str: "check the queue", key: {} });
  // Named keys map to their readline names with no str.
  assert.deepEqual(inkKeyToReadline("", { escape: true }), { str: undefined, key: { name: "escape" } });
  assert.deepEqual(inkKeyToReadline("\r", { return: true }), { str: undefined, key: { name: "return" } });
  assert.deepEqual(inkKeyToReadline("", { backspace: true }), { str: undefined, key: { name: "backspace" } });
  assert.deepEqual(inkKeyToReadline("", { backspace: true, meta: true }), { str: undefined, key: { name: "backspace", meta: true } });
  assert.deepEqual(inkKeyToReadline("", { delete: true }), { str: undefined, key: { name: "delete" } });
  assert.deepEqual(inkKeyToReadline("", { tab: true }), { str: undefined, key: { name: "tab" } });
  assert.deepEqual(inkKeyToReadline("", { upArrow: true }), { str: undefined, key: { name: "up" } });
  assert.deepEqual(inkKeyToReadline("", { downArrow: true }), { str: undefined, key: { name: "down" } });
  assert.deepEqual(inkKeyToReadline("", { leftArrow: true }), { str: undefined, key: { name: "left" } });
  assert.deepEqual(inkKeyToReadline("", { rightArrow: true }), { str: undefined, key: { name: "right" } });
  assert.deepEqual(inkKeyToReadline("", { pageUp: true }), { str: undefined, key: { name: "pageup" } });
  assert.deepEqual(inkKeyToReadline("", { pageDown: true }), { str: undefined, key: { name: "pagedown" } });
  assert.deepEqual(inkKeyToReadline("", { home: true }), { str: undefined, key: { name: "home" } });
  assert.deepEqual(inkKeyToReadline("", { end: true }), { str: undefined, key: { name: "end" } });
  // Ctrl+letter arrives as the bare letter in `input` with `ctrl` set — the dispatch's
  // Ctrl+C/Ctrl+B/Ctrl+T family reads key.ctrl + key.name.
  assert.deepEqual(inkKeyToReadline("c", { ctrl: true }), { str: undefined, key: { ctrl: true, name: "c" } });
  assert.deepEqual(inkKeyToReadline("T", { ctrl: true }), { str: undefined, key: { ctrl: true, name: "t" } });
  // Named keys win before ctrl: ink sets ctrl alongside ctrl+arrows too, and the arrow
  // must still map to its name, not to an empty ctrl+letter.
  assert.deepEqual(inkKeyToReadline("", { ctrl: true, upArrow: true }), { str: undefined, key: { name: "up" } });
  // Alt+letter maps to the meta shape applyKey's kill keys read (and stays out of the
  // printable-insert branch, which excludes meta).
  assert.deepEqual(inkKeyToReadline("x", { meta: true }), { str: undefined, key: { meta: true, name: "x" } });
  // An empty non-key input (ink suppresses text for unrecognized sequences) is inert.
  assert.deepEqual(inkKeyToReadline("", {}), { str: undefined, key: {} });
});

test("arrowDir and pageDir name the vertical direction the dispatch branches steer by", () => {
  // Arrows map to up/down; the other named keys and an undefined name are inert.
  assert.equal(arrowDir("up"), "up");
  assert.equal(arrowDir("down"), "down");
  assert.equal(arrowDir("pageup"), null);
  assert.equal(arrowDir("left"), null);
  assert.equal(arrowDir(undefined), null);
  // PgUp walks up and PgDn walks down — the inversion the scroll branches used to hand-roll.
  assert.equal(pageDir("pageup"), "up");
  assert.equal(pageDir("pagedown"), "down");
  assert.equal(pageDir("up"), null);
  assert.equal(pageDir(undefined), null);
});

// The adapter's output drives the real dispatch: one round-trip case per shape, through
// the same factory the readline path was tested with.
test("the adapter's output drives the dispatch exactly like the readline pairs did", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  const dispatch = (input: string, key: Parameters<typeof inkKeyToReadline>[1]) => {
    const mapped = inkKeyToReadline(input, key);
    keys.handleKey(mapped.str, mapped.key);
  };
  dispatch("h", {}); // typing
  dispatch("", { escape: true }); // escape outside any mode is inert
  assert.equal(keys.state().input, "h");
  dispatch("", { ctrl: true, upArrow: true }); // ctrl+arrow never moves the prompt cursor
  assert.equal(keys.state().cursor, 1);
  dispatch("", { backspace: true }); // backspace deletes
  assert.equal(keys.state().input, "");
  dispatch("i", {});
  dispatch("", { return: true }); // return submits into the inbox
  assert.equal(keys.state().input, "", "return submits and clears the prompt line");
  dispatch("", { ctrl: true }); // ctrl with empty input maps to an empty ctrl+letter: inert
  dispatch("c", { ctrl: true }); // Ctrl+C is the director interrupt, not a quit
  assert.equal(quitCount(), 0);
  assert.equal(keys.state().flash, "no director task in flight");
  dispatch("d", { ctrl: true }); // Ctrl+D quits through the mapped shape
  assert.equal(quitCount(), 1);
});