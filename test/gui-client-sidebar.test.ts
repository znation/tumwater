/** The dashboard sidebar's main-check row (gui-client-team.ts's renderSidebar, marked
 * `sidebar` region): it must render the payload's preformatted mainCounts fragment, not
 * re-derive `pass/tests` from the raw counts — that re-derivation dropped the skipped count
 * and made a fully green suite with one skip read like one failure (BUGS.md 2026-09-30),
 * drifting from the header badge the same payload already carries. */
import test from "node:test";
import assert from "node:assert/strict";
import { clientScope, iconStub } from "./helpers/gui-client-scope.js";

function sidebarScope(): { renderSidebar: (d: unknown) => void; panels: Record<string, string> } {
  const panels: Record<string, string> = {};
  const { renderSidebar } = clientScope<{ renderSidebar: (d: unknown) => void }>(
    ["restart-button", "sidebar"],
    ["renderSidebar"],
    {
      offline: false,
      $: () => ({ textContent: "" }),
      plural: (n: number, word: string) => `${n} ${n === 1 ? word : word + "s"}`,
      capitalize: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
      icon: iconStub,
      shortSha: (s: string) => String(s).slice(0, 8),
      localizeInstants: (s: string) => s,
      fmtAgo: () => "just now",
      mergeTitle: () => "",
      paintPanel: (id: string, html: string) => { panels[id] = html; },
      renderBudgetBadge: () => {},
      renderPauseBadge: () => {},
      renderStopControl: () => {},
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
    /<button type='button' class='alert-icon' data-act='restart' title='Restart onto the update now'><i:refresh><\/button>/,
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
  assert.match(panels.statuschips!, /Version <span class='mono'>aaaaaaaa<\/span> · 3 commits behind/,
    "the stale row keeps its text and plural behind-count");
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: true, aheadCommits: 1 },
  });
  assert.match(panels.statuschips!, /· 1 commit behind/,
    "a single commit behind reads singular, matching badges.ts");
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: false, aheadCommits: 0 },
  });
  assert.match(panels.statuschips!, /Version <span class='mono'>aaaaaaaa<\/span>(?! · \d+ behind)/,
    "the fresh row keeps its text and shows no behind-count");
});

// BUGS.md 2026-10-29: a build current against the newest passing commit while main's tip moved
// the code on read like an up-to-date team; the row now says the update waits for main's check.
test("a build waiting for main's check reads amber with no restart button", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    build: { sha: "a".repeat(40), stale: false, aheadCommits: 0, waitingForCheck: { head: "c".repeat(40), aheadCommits: 6 } },
  });
  assert.match(panels.statuschips!, /class='row t-amber'[^>]*><i:refresh>Version <span class='mono'>aaaaaaaa<\/span> · update waits for main's check/);
  assert.doesNotMatch(panels.statuschips!, /data-act/, "a forced restart would land on the same build, so no button");
});

// The disk floor (plans/disk-floor.md, part 4/4): the sidebar renders the payload's
// preformatted diskBadge — the same string the TUI/status header carries — so the hold reads
// the same on both dashboards. An empty badge (no disk block, or comfortable space) leaves
// the sidebar untouched.
test("the sidebar's disk row mirrors the header badge, hold named", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    disk: { freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true, lastReclaim: { at: Date.now() - 300_000, mode: "pressure", freedGB: 3.24 } },
    diskBadge: " · disk 8.2 GB free — holding new work",
  });
  assert.match(panels.statuschips!, /Disk 8\.2 GB free — holding new work/,
    "the hold rides the row");
  assert.match(panels.statuschips!, /data-act='reclaim'/, "a held disk's icon is the reclaim button");

  renderSidebar({
    running: true,
    pid: 123,
    disk: { freeGB: 30, holdGB: 10, reclaimGB: 40, held: false },
    diskBadge: " · disk 30.0 GB free",
  });
  assert.match(panels.statuschips!, /Disk 30\.0 GB free/, "below the reclaim threshold still informs");
  assert.match(panels.statuschips!, /data-act='reclaim'/, "the reclaim band offers the button");

  renderSidebar({
    running: true,
    pid: 123,
    disk: { freeGB: 50, holdGB: 10, reclaimGB: 40, held: false, lastReclaim: { at: Date.now() - 300_000, mode: "pressure", freedGB: 3.24 } },
    diskBadge: "",
  });
  assert.doesNotMatch(panels.statuschips!, /data-act='reclaim'/, "a recovered disk has no reclaim button");

  renderSidebar({ running: true, pid: 123, diskBadge: "" });
  assert.doesNotMatch(panels.statuschips!, /Disk /, "an empty badge leaves the sidebar unchanged");
});

test("the sidebar shows a Stops in row only for a windowed run", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({ running: true, pid: 123, runWindowBadge: " · stops in 2h" });
  assert.match(panels.statuschips!, /Stops in 2h/);
  renderSidebar({ running: true, pid: 123, runWindowBadge: "" });
  assert.doesNotMatch(panels.statuschips!, /Stops in/);
});

test("the sidebar renders the ci parity badge beside the Main check row", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({
    running: true,
    pid: 123,
    ciParityBadge: " · ci: stale — covered abcdef0 5m ago",
    ciParityTone: "blue",
  });
  // badgeLabel upcases the first character for the row's label style, toned by the shared map.
  assert.match(panels.statuschips!, /Ci: stale — covered abcdef0 5m ago/);
  assert.match(panels.statuschips!, /t-blue/, "a stale badge is toned blue");

  renderSidebar({ running: true, pid: 123, ciParityBadge: "", ciParityTone: undefined });
  assert.doesNotMatch(panels.statuschips!, /Ci: /, "an empty badge leaves the panel unchanged");
});

test("the Stops in row's explanation names stop --in for a scheduled stop and start --for otherwise", () => {
  const { renderSidebar, panels } = sidebarScope();
  renderSidebar({ running: true, pid: 123, runWindowBadge: " · stops in 2h", runStopsAt: 5, scheduledStopAt: 5 });
  assert.match(panels.statuschips!, /stop --in/);
  renderSidebar({ running: true, pid: 123, runWindowBadge: " · stops in 2h", runStopsAt: 5, scheduledStopAt: 9 });
  assert.match(panels.statuschips!, /start --for/);
  renderSidebar({ running: true, pid: 123, runWindowBadge: " · stops in 2h", runStopsAt: 5 });
  assert.match(panels.statuschips!, /start --for/);
});
