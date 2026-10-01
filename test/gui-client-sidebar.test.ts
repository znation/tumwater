/** The dashboard sidebar's main-check row (gui-client-fleet.ts's renderSidebar, marked
 * `sidebar` region): it must render the payload's preformatted mainCounts fragment, not
 * re-derive `pass/tests` from the raw counts — that re-derivation dropped the skipped count
 * and made a fully green suite with one skip read like one failure (BUGS.md 2026-09-30),
 * drifting from the header badge the same payload already carries. */
import test from "node:test";
import assert from "node:assert/strict";
import { clientScope, iconStub } from "./gui-client-scope.js";

function sidebarScope(): { renderSidebar: (d: unknown) => void; panels: Record<string, string> } {
  const panels: Record<string, string> = {};
  const { renderSidebar } = clientScope<{ renderSidebar: (d: unknown) => void }>(
    ["sidebar"],
    ["renderSidebar"],
    {
      offline: false,
      $: () => ({ textContent: "" }),
      plural: (n: number, word: string) => `${n} ${word}`,
      icon: iconStub,
      shortSha: (s: string) => String(s).slice(0, 8),
      localizeInstants: (s: string) => s,
      fmtAgo: () => "just now",
      landingTitle: () => "",
      paintPanel: (id: string, html: string) => { panels[id] = html; },
      renderBudgetBadge: () => {},
      renderPauseBadge: () => {},
    },
  );
  return { renderSidebar, panels };
}

test("the sidebar's main row renders the payload's counts fragment, skips and failures named", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    mainCheck: { sha: "a".repeat(40), status: "passed", counts: { tests: 2430, pass: 2429, fail: 0, skipped: 1 }, at: 0 },
    mainCounts: "2429/2430 (1 skipped)",
    mainCheckBadge: " · main aaaaaaaa: green · 2429/2430 (1 skipped)",
  });
  assert.match(panels.statuschips!, /Main green · 2429\/2430 \(1 skipped\)/, "the skip is named in the row, matching the header badge");

  renderSidebar({
    running: true,
    pid: 123,
    mainCheck: { sha: "a".repeat(40), status: "failed", counts: { tests: 2430, pass: 2427, fail: 2, skipped: 1 }, at: 0 },
    mainCounts: "2427/2430 (2 failed · 1 skipped)",
    mainCheckBadge: " · main aaaaaaaa: red · 2427/2430 (2 failed · 1 skipped)",
  });
  assert.match(panels.statuschips!, /Main red · 2427\/2430 \(2 failed · 1 skipped\)/, "a failure is named explicitly too");
});

test("the sidebar's main row shows no counts when the payload carries none", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    mainCheck: { sha: "a".repeat(40), status: "skipped" },
    mainCounts: "",
    mainCheckBadge: " · main aaaaaaaa: skipped",
  });
  assert.match(panels.statuschips!, /Main skipped(?! ·)/, "no counts fragment when the payload ships none");
});

test("a stale build renders the sidebar Build row's refresh icon as the restart button, like the alert's", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: true, aheadCommits: 3 },
  });
  // The exact markup alertParts() emits for the build alert's restartable icon: the global
  // [data-act='restart'] handler in gui-client-boot.ts dispatches it with no new wiring.
  assert.match(panels.statuschips!,
    /<button type='button' class='alert-icon' data-act='restart' title='Restart onto the new build now'><i:refresh><\/button>/,
    "the stale build's icon is the same restart button the alert carries");
});

test("a fresh build keeps the sidebar Build row's refresh icon inert", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: false, aheadCommits: 0 },
  });
  assert.match(panels.statuschips!, /<i:refresh>/, "the glyph is still there");
  assert.doesNotMatch(panels.statuschips!, /data-act/, "no data-act when the build is current");
});

test("the Build row's text and behind-count are unchanged in both cases", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: true, aheadCommits: 3 },
  });
  assert.match(panels.statuschips!, /Build <span class='mono'>aaaaaaaa<\/span> · 3 behind/,
    "the stale row keeps its text and behind-count");
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: false, aheadCommits: 0 },
  });
  assert.match(panels.statuschips!, /Build <span class='mono'>aaaaaaaa<\/span>(?! · \d+ behind)/,
    "the fresh row keeps its text and shows no behind-count");
});
