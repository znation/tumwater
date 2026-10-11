/** The framework-free keypress factory (src/ui/tui/tui-keys.ts) driven directly — no terminal, no
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
import { arrowDir, inkKeyToReadline, pageDir } from "../src/ui/tui/tui-keymap.js";
import { createTuiKeys } from "../src/ui/tui/tui-keys.js";
import { enqueueLanding, readLandingQueue } from "../src/landing/landing-queue.js";
import { renderLandingQueue } from "../src/landing/landing-queue-render.js";
import { abortRequestPath } from "../src/paths.js";
import { writeEvents, writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { readJson } from "./helpers/json-read.js";

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
  const cfg = readJson(path.join(root, "tumwater.json")) as { maxDailyCostUsd: number };
  assert.equal(cfg.maxDailyCostUsd, 50);

  // Esc cancels: the pre-filled value never reaches config.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().budgetMode, false);
  assert.equal((readJson(path.join(root, "tumwater.json")) as { maxDailyCostUsd: number }).maxDailyCostUsd, 50);

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

test("Ctrl+T cycles on through Usage and Failures to History, which caches and pages the tick rows", () => {
  const root = makeRoot();
  // Twelve completed ticks so the history pane's rows overflow the pane budget and page.
  writeEvents(
    root,
    Array.from({ length: 12 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 60_000,
      loop: "feature",
      type: "tick_end",
      tick: i + 1,
      result: "changed",
    })),
  );
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(5, 4);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage → failures → history
  assert.equal(keys.state().view, 4, "History is the last view (roleIds.length + 4)");
  assert.match(keys.state().paneCache ?? "", /feature #12/, "the newest tick's row is cached for the pane");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 5, "PgDn advances the history window by the event budget");
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().paneScroll, 0, "PgUp clamps back to the head");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 5, "Pending follows History (roleIds.length + 5)");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0, "cycling past Pending wraps to Activity");
  assert.equal(keys.state().paneCache, null, "leaving History and Pending drops the cache");
});

test("Ctrl+G cycles the report scope and recomputes the Usage and Failures cache", () => {
  const root = makeRoot();
  // One failed feature tick with tokens: it lands in the usage report's totals and the
  // failure digest's per-role table, so scoping to clean changes both renders.
  writeEvents(root, [
    { ts: Date.now(), loop: "feature", type: "tick_start", tick: 1 },
    { ts: Date.now(), loop: "feature", type: "tick_end", tick: 1, result: "error", tokens: 500, costUsd: 0.5 },
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  assert.equal(keys.state().scopeRole, null, "a fresh TUI starts fleet-wide");

  // Off a report view the key only moves the scope; no cache is computed.
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, null, "the cycle wraps back to the fleet");

  // Usage: each press recomputes the cached Markdown, and the scoped text differs.
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 4);
  const fleetUsage = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  assert.equal(keys.state().scopeRole, "feature");
  const featureUsage = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → clean
  assert.equal(keys.state().scopeRole, "clean");
  const cleanUsage = keys.state().paneCache;
  assert.notEqual(featureUsage, fleetUsage, "the feature-scoped usage cache differs from the fleet-wide one");
  assert.notEqual(cleanUsage, fleetUsage, "the clean-scoped usage cache differs from the fleet-wide one");

  // Failures under the same clean scope caches a digest unlike the fleet-wide one.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → failures (view 5), scope clean
  assert.equal(keys.state().view, 5);
  const cleanFailures = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // clean → fleet
  assert.equal(keys.state().scopeRole, null);
  assert.notEqual(cleanFailures, keys.state().paneCache, "the scoped failure digest differs from the fleet-wide one");
});

test("Ctrl+G cycles base roles only, so an instance id never labels another scope's body", () => {
  const root = makeRoot();
  // One failed feature tick with tokens, so the Usage body carries the collected `role` line.
  writeEvents(root, [
    { ts: Date.now(), loop: "feature", type: "tick_start", tick: 1 },
    { ts: Date.now(), loop: "feature", type: "tick_end", tick: 1, result: "error", tokens: 500, costUsd: 0.5 },
  ]);
  const { keys } = makeKeys(root, () => 0);
  // The roster names an instance; the scoped collectors fold it into `feature`.
  keys.syncSnapshot(0, false, ["feature", "feature-2"]);

  const seen: Array<string | null> = [];
  for (let i = 0; i < 2; i++) {
    keys.handleKey(undefined, { ctrl: true, name: "g" });
    seen.push(keys.state().scopeRole);
  }
  assert.deepEqual(seen, ["feature", null], "feature-2 collects feature's body, so the cycle skips it");

  // On the Usage pane the tab-strip scope and the collected body's own `role:` name agree.
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 4);
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // fleet → feature
  assert.equal(keys.state().scopeRole, "feature");
  assert.match(keys.state().paneCache ?? "", /^role: feature$/m, "the scoped body names the role the scope shows");
});

test("Ctrl+G on the History view cycles the raw roster ids and recomputes the scoped cache", () => {
  const root = makeRoot();
  // One completed tick per loop, so each exact-loop scope has its own row set: feature-2 is
  // a distinct scope, unlike the report panes' base-role aggregation.
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "tick_end", tick: 1, result: "changed" },
    { ts: 1_700_000_060_000, loop: "feature-2", type: "tick_end", tick: 1, result: "none" },
    { ts: 1_700_000_120_000, loop: "clean", type: "tick_end", tick: 1, result: "changed" },
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2", "clean"]);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4)
  assert.equal(keys.state().view, 7);
  assert.equal(keys.state().historyRole, null, "History opens fleet-wide");

  const fleet = keys.state().paneCache;
  assert.match(fleet ?? "", /feature #1/, "the fleet-wide read holds feature's row");
  assert.match(fleet ?? "", /feature-2 #1/, "...and the instance's row");

  const seen: Array<string | null> = [];
  const caches: Array<string | null> = [];
  for (let i = 0; i < 4; i++) {
    keys.handleKey(undefined, { ctrl: true, name: "g" });
    seen.push(keys.state().historyRole);
    caches.push(keys.state().paneCache);
  }
  assert.deepEqual(seen, ["feature", "feature-2", "clean", null], "the raw roster ids each get their own slot");
  assert.match(caches[0] ?? "", /^role: feature$/m, "the scoped cache names its loop");
  assert.match(caches[0] ?? "", /feature #1/);
  assert.doesNotMatch(caches[0] ?? "", /feature-2/, "an instance's rows stay out of its base loop's scope");
  assert.match(caches[1] ?? "", /feature-2 #1/);
  assert.notEqual(caches[0], fleet, "the feature-scoped cache differs from the fleet-wide one");
  assert.notEqual(caches[1], caches[0], "feature-2 is its own scope, unlike the report cycle");

  // Budget mode owns the prompt line: the History scope must not move.
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature again
  assert.equal(keys.state().historyRole, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().historyRole, "feature", "Ctrl+G is inert in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode owns it the same way; it opens from a transcript view, scope kept.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // history → pending
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // pending → activity
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // activity → transcript feature
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().historyRole, "feature", "Ctrl+G is inert in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });

  // A roster that drops the scoped loop clears the History scope.
  keys.syncSnapshot(0, false, ["clean"]);
  assert.equal(keys.state().historyRole, null, "a roster drop clears the stale history scope");
});

test("Ctrl+G is inert while an editor holds the prompt line, and a shrinking roster clears the scope", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(50, false, ["feature", "clean"]);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "feature");

  // Budget mode owns the prompt line: Ctrl+G must not cycle the scope.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "feature", "Ctrl+G is inert in budget mode");
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode owns it the same way.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature transcript
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "feature", "Ctrl+G is inert in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });

  // A roster that still names the role keeps the scope; one that drops it resets.
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  assert.equal(keys.state().scopeRole, "feature", "a still-present role keeps its scope");
  keys.syncSnapshot(0, false, ["clean"]);
  assert.equal(keys.state().scopeRole, null, "a roster drop clears the stale scope");
});

test("syncSnapshot recomputes an on-screen report pane when it clears a retired scope", () => {
  const root = makeRoot();
  // A failed feature tick with tokens: scoping to the fleet and to feature render differently.
  writeEvents(root, [
    { ts: Date.now(), loop: "feature", type: "tick_start", tick: 1 },
    { ts: Date.now(), loop: "feature", type: "tick_end", tick: 1, result: "error", tokens: 500, costUsd: 0.5 },
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  const fleetUsage = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  assert.notEqual(keys.state().paneCache, fleetUsage, "the feature-scoped body differs from the fleet one");

  // A rename keeps the roster length but retires the scoped name: the scope drops and the
  // still-visible pane body must recompute fleet-wide to match the tab strip and hint.
  keys.syncSnapshot(0, false, ["feat", "clean"]);
  assert.equal(keys.state().scopeRole, null);
  assert.equal(keys.state().paneCache, fleetUsage, "the pane body follows the cleared scope");
});

test("Ctrl+S cycles the History pane's trailing window, re-reads the rows, and resets the scroll", () => {
  const root = makeRoot();
  const now = Date.now();
  // One tick 30 minutes old (inside 1h) and one three days old (only inside 7d).
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "tick_end", tick: 1, result: "changed" },
    { ts: now - 3 * 24 * 60 * 60_000, loop: "feature", type: "tick_end", tick: 2, result: "changed" },
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(1, 1); // a one-line budget so the two rows can scroll
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().view, 4, "History is roleIds.length + 4");
  assert.equal(keys.state().historySince, null, "History opens on the default window");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.match(keys.state().paneCache ?? "", /feature #2/, "the default newest-N read carries both");
  assert.doesNotMatch(keys.state().paneCache ?? "", /window: last/);

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the seeded rows overflow the one-line budget");

  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h");
  assert.match(keys.state().paneCache ?? "", /window: last 1h/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /result:/, "a window without an outcome filter names no result header");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #2/, "the 1h window drops the three-day-old tick");
  assert.equal(keys.state().paneScroll, 0, "a window change re-enters the body at its head");

  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "6h");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1d");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "7d");
  assert.match(keys.state().paneCache ?? "", /feature #2/, "7d reaches the three-day-old tick");
  assert.match(keys.state().paneCache ?? "", /oldest retained event/, "the 7d read hedges its coverage with the sparse-window note");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, null, "the cycle wraps to the default window");
  assert.match(keys.state().paneCache ?? "", /feature #2/, "the default read carries both rows again");
});

test("Ctrl+S is inert in the prompt-line modes and off the History view only moves the label", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: Date.now() - 60_000, loop: "feature", type: "tick_end", tick: 1, result: "changed" }]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // Off the History view, Ctrl+S advances the window without computing a cache.
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h");
  assert.equal(keys.state().paneCache, null, "no History pane is showing");

  // Budget mode holds the prompt line: Ctrl+S leaves the window alone.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h", "Ctrl+S does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode holds it too: open it on a transcript view and try Ctrl+S.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript clean
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h", "Ctrl+S does nothing in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+E cycles the Usage and Failures panes' trailing report window and resets the scroll", () => {
  const root = makeRoot();
  const now = Date.now();
  // One feature tick 30 minutes old (inside 1h) and one three days old (only inside 7d), with
  // distinct token counts so the windowed usage totals name which ticks they aggregated. Both
  // are errors so the failure digest's window tick count names the same split.
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "tick_end", tick: 1, result: "error", tokens: 100 },
    { ts: now - 3 * 24 * 60 * 60_000, loop: "feature", type: "tick_end", tick: 2, result: "error", tokens: 1_000_000 },
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(1, 1); // a one-line budget so the report body can scroll
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 2, "Usage is roleIds.length + 2");
  assert.equal(keys.state().reportSince, null, "the report pane opens on the default day window");
  assert.match(keys.state().paneCache ?? "", /1\.0M/, "the default day report aggregates both ticks");
  assert.match(keys.state().paneCache ?? "", /2 ticks/);

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the usage body overflows the one-line budget");

  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h");
  assert.match(keys.state().paneCache ?? "", /window: last 1h/);
  assert.match(keys.state().paneCache ?? "", /100 output tokens/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /1\.0M/, "the 1h window drops the three-day-old tick's tokens");
  assert.equal(keys.state().paneScroll, 0, "a window change re-enters the body at its head");

  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "6h");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1d");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "7d");
  assert.match(keys.state().paneCache ?? "", /window: last 7d/);
  assert.match(keys.state().paneCache ?? "", /1\.0M/, "7d reaches the three-day-old tick");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, null, "the cycle wraps to the default window");
  assert.match(keys.state().paneCache ?? "", /1\.0M/, "the default read aggregates both ticks again");

  // Failures: the same Ctrl+E cycle over the digest, whose window line names its tick count.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → failures
  assert.equal(keys.state().view, 3, "Failures is roleIds.length + 3");
  assert.equal(keys.state().reportSince, null, "the digest opens on the default day window");
  assert.match(keys.state().paneCache ?? "", /· 2 ticks/, "the default digest aggregates both error ticks");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the digest body overflows the one-line budget");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h");
  assert.match(keys.state().paneCache ?? "", /window: last 1h/);
  assert.match(keys.state().paneCache ?? "", /· 1 ticks/, "the 1h digest drops the three-day-old error tick");
  assert.equal(keys.state().paneScroll, 0, "a window change re-enters the digest at its head");
});

test("Ctrl+E is inert in the prompt-line modes and off the report views only moves the label", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: Date.now() - 60_000, loop: "feature", type: "tick_end", tick: 1, result: "error", tokens: 100 }]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // Off the report views, Ctrl+E advances the window without computing a cache.
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h");
  assert.equal(keys.state().paneCache, null, "no report pane is showing");

  // Budget mode holds the prompt line: Ctrl+E leaves the window alone.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h", "Ctrl+E does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode holds it too: open it on a transcript view and try Ctrl+E.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript clean
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h", "Ctrl+E does nothing in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+O cycles the History pane's outcome class, filters rows by historyClass, and resets the scroll", () => {
  const root = makeRoot();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 60_000, loop: "feature", type: "tick_end", tick: 1, result: "changed" },
    { ts: now - 50_000, loop: "feature", type: "tick_end", tick: 2, result: "no_change" },
    { ts: now - 40_000, loop: "feature", type: "tick_end", tick: 3, result: "error" },
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(1, 1); // a one-line budget so the three rows can scroll
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().historyResult, "all", "History opens unfiltered");
  const all = keys.state().paneCache ?? "";
  assert.match(all, /feature #1/);
  assert.match(all, /feature #2/);
  assert.match(all, /feature #3/);
  assert.doesNotMatch(all, /result:/);

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the seeded rows overflow the one-line budget");

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "changes");
  assert.match(keys.state().paneCache ?? "", /^result: changes\n/, "the header names the class");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #2/, "the no-change row is filtered out");
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #3/, "the error row is filtered out");
  assert.equal(keys.state().paneScroll, 0, "a class change re-enters the body at its head");

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "none");
  assert.match(keys.state().paneCache ?? "", /feature #2/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "problems");
  assert.match(keys.state().paneCache ?? "", /feature #3/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "all", "the cycle wraps to no filter");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.match(keys.state().paneCache ?? "", /feature #3/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /result:/);
});

test("Ctrl+O composes with the Ctrl+S window and names an emptied filter", () => {
  const root = makeRoot();
  const now = Date.now();
  // The only "changed" tick is three days old; a "no_change" tick sits inside 1h.
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "tick_end", tick: 1, result: "no_change" },
    { ts: now - 3 * 24 * 60 * 60_000, loop: "feature", type: "tick_end", tick: 2, result: "changed" },
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // → changes
  assert.match(keys.state().paneCache ?? "", /feature #2/);
  keys.handleKey(undefined, { ctrl: true, name: "s" }); // → 1h
  assert.equal(keys.state().historySince, "1h");
  const cache = keys.state().paneCache ?? "";
  assert.match(cache, /window: last 1h/);
  assert.match(cache, /result: changes/);
  assert.match(cache, /no ticks with result "changes"/);
  assert.doesNotMatch(cache, /feature #/);
});

test("Ctrl+O over a zero-row read keeps the pane's no-ticks note, not a filter-empty claim", () => {
  const root = makeRoot();
  writeEvents(root, []);
  const { keys } = makeKeys(root, () => Date.now());
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().paneCache, "", "an empty log opens on the pane's own no-ticks note");
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // → changes
  assert.equal(keys.state().historyResult, "changes");
  assert.equal(keys.state().paneCache, "", "an empty log is not blamed on the outcome filter");
});

test("Ctrl+O is inert in the prompt-line modes and off the History view only moves the label", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: Date.now() - 60_000, loop: "feature", type: "tick_end", tick: 1, result: "changed" }]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // Off the History view, Ctrl+O advances the class without computing a cache.
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "changes");
  assert.equal(keys.state().paneCache, null, "no History pane is showing");

  // Budget mode holds the prompt line: Ctrl+O leaves the class alone.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "changes", "Ctrl+O does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode holds it too: open it on a transcript view and try Ctrl+O.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript clean
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "changes", "Ctrl+O does nothing in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("the Pending pane caches the rendered fleet roster when collectPending resolves, and a cycle away drops it", async () => {
  const root = makeRoot();
  const fleet = {
    mainBranch: "main",
    roles: [
      { role: "feature", branch: "tumwater/feature", state: "ready" as const, ahead: 2, commits: [], dirtyFiles: [] },
      { role: "clean", branch: "tumwater/clean", state: "ready" as const, ahead: 0, commits: [], dirtyFiles: ["a.ts"] },
    ],
  };
  let resolvePending!: (view: typeof fleet) => void;
  const pending = new Promise<typeof fleet>((resolve) => (resolvePending = resolve));
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    collectPending: () => pending,
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  assert.equal(
    keys.state().paneCache,
    "land queue empty",
    "the cache holds the queue (empty here) before the collector resolves",
  );
  const before = renders;

  resolvePending(fleet);
  await pending;
  assert.equal(
    keys.state().paneCache,
    "land queue empty\n\nfeature: 2 commits ahead of main\nclean: 0 commits ahead of main, 1 uncommitted file",
    "the pane caches the queue above renderFleetChange's roster text",
  );
  assert.ok(renders > before, "a resolution repaints the pane");
});

test("the Pending pane renders the durable land queue on entry, above the resolved fleet roster", async () => {
  const root = makeRoot();
  enqueueLanding(root, { role: "feature", sha: "a".repeat(40), tick: 3, summary: "add a thing", enqueuedAt: 0 });
  const fleet = {
    mainBranch: "main",
    roles: [
      { role: "feature", branch: "tumwater/feature", state: "ready" as const, ahead: 2, commits: [], dirtyFiles: [] },
      { role: "clean", branch: "tumwater/clean", state: "ready" as const, ahead: 0, commits: [], dirtyFiles: ["a.ts"] },
    ],
  };
  let resolvePending!: (view: typeof fleet) => void;
  const pending = new Promise<typeof fleet>((resolve) => (resolvePending = resolve));
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => pending,
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  // The queue needs no git read, so it is already rendered when the collector is still in flight.
  assert.equal(keys.state().paneCache, renderLandingQueue(readLandingQueue(root), 0));

  resolvePending(fleet);
  await pending;
  assert.equal(
    keys.state().paneCache,
    renderLandingQueue(readLandingQueue(root), 0) +
      "\n\nfeature: 2 commits ahead of main\nclean: 0 commits ahead of main, 1 uncommitted file",
    "the two-role roster is appended below the same queue text",
  );
});

test("a Pending collector resolution after the operator cycled away does not cache onto the new view", async () => {
  const root = makeRoot();
  const fleet = { mainBranch: "main", roles: [] };
  let resolveLate!: (view: typeof fleet) => void;
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    collectPending: () => new Promise<typeof fleet>((resolve) => (resolveLate = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // cycle away before it resolves
  assert.equal(keys.state().view, 0);
  resolveLate(fleet);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, null, "a late resolution does not cache onto Activity");
});

test("a Pending collector resolution after the roster size changed does not cache onto the shifted view", async () => {
  const root = makeRoot();
  const fleet = { mainBranch: "main", roles: [] };
  let resolveLate!: (view: typeof fleet) => void;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => new Promise<typeof fleet>((resolve) => (resolveLate = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending (index 5, no roles)
  assert.equal(keys.state().view, 5);
  const queueText = keys.state().paneCache; // the immediate queue set, before the collector resolves
  // A role appears while the collector is in flight: index 5 now maps to History, not Pending.
  keys.syncSnapshot(0, false, ["feature"], false);
  assert.equal(keys.state().view, 5, "the clamp keeps the raw index");
  resolveLate(fleet);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    keys.state().paneCache,
    queueText,
    "the late resolution must not cache the fleet roster onto the shifted History pane",
  );
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
