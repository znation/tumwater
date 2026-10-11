import test from "node:test";
import assert from "node:assert/strict";
import { clientScope, iconStub } from "./helpers/gui-client-scope.js";
import { GUI_CLIENT_FLEET_JS } from "../src/ui/gui/gui-client-fleet.js";

// The dashboard's fleet-view backlog panel (src/ui/gui/gui-client-fleet.ts's marked backlog
// region), exercised the way the page runs it: the shared view-model region supplies
// queuedPrompts/splitTitle, the format region supplies fmtAgo, and a recording paintPanel
// stands in for the DOM.

function backlogScope(backlogTab = "queued", extra: Record<string, unknown> = {}) {
  const panels: Record<string, string> = {};
  const scope = clientScope<{
    renderBacklog(d: object): void;
    beginQueuedEdit(role: string, file: string, text: string): void;
    endQueuedEdit(): void;
    setBacklogTab(tab: string): void;
  }>(["format", "view-model", "backlog"], ["renderBacklog", "beginQueuedEdit", "endQueuedEdit", "setBacklogTab"], {
    backlogTab,
    paintPanel: (id: string, html: string) => { panels[id] = html; },
    icon: iconStub,
    openEntryKey: () => null,
    store: () => {},
    lastStatus: undefined,
    ...extra,
  });
  return { scope, panels };
}

test("the Queued tab shows how long each prompt has waited, and unstamped ones as today", () => {
  const { scope, panels } = backlogScope();
  scope.renderBacklog({
    questions: [],
    plans: [],
    bugs: [],
    inboxPrompts: ["docs pass", "unstampable"],
    inboxFiles: ["a.md", "b.md"],
    // One real stamp (five minutes ago) and one null — a hand-placed queue file.
    inboxQueuedAt: [Date.now() - 5 * 60_000, null],
    roleInboxPrompts: { qa: [{ file: "q.md", preview: "run the qa suite", queuedAtMs: Date.now() - 7_200_000 }] },
  });
  const html = panels["backlog"] ?? "";
  // A stamped prompt carries its age in the meta line (fmtAgo's relative phrasing).
  assert.match(html, />for the director · queued 5m ago</);
  assert.match(html, />for the qa loop · queued 2h ago</);
  // A null stamp renders exactly today's meta text — the age is omitted, not an error.
  assert.match(html, />for the director<\/span>/, "the unstamped director prompt keeps the bare meta");
  // The cancel affordance is unchanged for both rows: the queue-file address and the role,
  // never a list position.
  assert.match(html, /data-action='promptcancel' data-file='a\.md' data-role='director'/);
  assert.match(html, /data-action='promptcancel' data-file='b\.md' data-role='director'/);
  assert.match(html, /data-action='promptcancel' data-file='q\.md' data-role='qa'/);
});

test("the Queued tab edits a prompt in place, and the poll cannot clobber the editor", () => {
  const { scope, panels } = backlogScope();
  const status = {
    questions: [], plans: [], bugs: [],
    inboxPrompts: ["docs pass"], inboxFiles: ["a.md"], inboxQueuedAt: [null],
    roleInboxPrompts: { qa: [{ file: "q.md", preview: "run the qa suite", queuedAtMs: null }] },
  };
  scope.renderBacklog(status);
  let html = panels["backlog"] ?? "";
  // Each queued row carries an Edit button beside Cancel, addressed by queue file and role.
  assert.match(html, /data-action='promptedit' data-file='a\.md' data-role='director'/);
  assert.match(html, /data-action='promptedit' data-file='q\.md' data-role='qa'/);
  // Opening the editor swaps the matched row for a textarea loaded with the body.
  scope.beginQueuedEdit("qa", "q.md", "new body");
  html = panels["backlog"] ?? "";
  assert.match(html, /<textarea id='queuedit' class='queuedit'>new body<\/textarea>/);
  assert.match(html, /data-action='prompteditsave' data-file='q\.md' data-role='qa'/);
  assert.match(html, /data-action='prompteditcancel' data-file='q\.md' data-role='qa'/);
  // The standing 1s poll repaints from the same payload; an open editor must survive it.
  const painted = panels["backlog"];
  scope.renderBacklog(status);
  assert.equal(panels["backlog"], painted, "no second paint while the editor is open");
  // Ending the edit paints the plain list again.
  scope.endQueuedEdit();
  html = panels["backlog"] ?? "";
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /data-action='promptedit' data-file='q\.md' data-role='qa'/);
  assert.match(html, /data-action='promptcancel' data-file='q\.md' data-role='qa'/);
});

test("switching tabs abandons an open Queued editor", () => {
  const status = {
    questions: [], plans: ["Ready (planned 2026-10-01)"], bugs: [],
    inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [],
    roleInboxPrompts: { qa: [{ file: "q.md", preview: "run the qa suite", queuedAtMs: null }] },
  };
  const { scope, panels } = backlogScope("queued", { lastStatus: status });
  scope.renderBacklog(status);
  scope.beginQueuedEdit("qa", "q.md", "new body");
  assert.match(panels["backlog"] ?? "", /<textarea/);
  scope.setBacklogTab("plans");
  const html = panels["backlog"] ?? "";
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /li-title'>Ready/);
});

test("the queued row's delegated handler carries the edit arms", () => {
  assert.match(GUI_CLIENT_FLEET_JS, /button\.rowaction\[data-action='promptedit'\]/);
  assert.match(GUI_CLIENT_FLEET_JS, /button\.rowaction\[data-action='prompteditsave'\]/);
  assert.match(GUI_CLIENT_FLEET_JS, /button\.rowaction\[data-action='prompteditcancel'\]/);
  assert.match(GUI_CLIENT_FLEET_JS, /"\/api\/prompt-text\?role="/);
  assert.match(GUI_CLIENT_FLEET_JS, /"\/api\/prompt-edit"/);
});

test("the other backlog tabs render unchanged alongside the queued age", () => {
  const { scope, panels } = backlogScope("questions");
  scope.renderBacklog({
    questions: ["Which backend? (asked 2026-10-01)"],
    plans: [],
    bugs: [],
    inboxPrompts: [],
    inboxFiles: [],
    inboxQueuedAt: [],
    roleInboxPrompts: {},
  });
  // With an empty queue the default tab falls back to questions and the queued age logic
  // never runs.
  const html = panels["backlog"] ?? "";
  assert.match(html, /Which backend?/);
  assert.match(html, /<i:question>/);
  assert.doesNotMatch(html, /· queued/);
});

// Every tab's rows carry the same markup as before when an entry is eligible: the hold tag
// (PLANS.md "Show backlog entry eligibility holds in the GUI and TUI backlog lists") rides
// beside the title only when the payload's parallel planHolds/bugHolds names one.

test("the Plans and Bugs tabs append each held entry's eligibility tag beside its title", () => {
  const base = { questions: [], plans: [], bugs: [], planHolds: [], bugHolds: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  const plans = backlogScope("plans");
  plans.scope.renderBacklog({
    ...base,
    plans: ["Worktree pool, part 3/5: second step (planned 2026-10-01)"],
    planHolds: [" [blocked: requires Worktree pool 2/5]"],
  });
  const plansHtml = plans.panels["backlog"] ?? "";
  assert.match(
    plansHtml,
    /li-title'>Worktree pool, part 3\/5: second step<\/span><span class='li-meta'>planned 2026-10-01<\/span><span class='li-meta'>\[blocked: requires Worktree pool 2\/5\]<\/span>/,
    "the tag rides beside the title/meta",
  );
  // The click still addresses the entry by tab and index, not by the mark.
  assert.match(plansHtml, /data-file='plans' data-index='0'/);

  const bugs = backlogScope("bugs");
  bugs.scope.renderBacklog({ ...base, bugs: ["A dead bug (reported 2026-10-01)"], bugHolds: [" [refused]"] });
  const bugsHtml = bugs.panels["backlog"] ?? "";
  assert.match(bugsHtml, /li-title'>A dead bug<\/span><span class='li-meta'>reported 2026-10-01<\/span><span class='li-meta'>\[refused\]<\/span>/);
});

test("an eligible Plans row is byte-identical whether or not the payload carries holds", () => {
  const payload = { questions: [], plans: ["Ready (planned 2026-10-01)"], bugs: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  const withHolds = backlogScope("plans");
  withHolds.scope.renderBacklog({ ...payload, planHolds: [""] });
  const without = backlogScope("plans");
  without.scope.renderBacklog(payload);
  assert.equal(withHolds.panels["backlog"], without.panels["backlog"]);
});

// The "In flight" stat tile counts the running set, not just the permit holders: a running
// director is genuinely in flight though it holds no maxConcurrent permit, so the tile must
// not read 0 beside a live Director row (BUGS.md 2026-10-06).
function statsScope(today: unknown = null) {
  const panels: Record<string, string> = {};
  const scope = clientScope<{ renderStats(d: object): void }>(["format", "view-model", "stats"], ["renderStats"], {
    today,
    paintPanel: (id: string, html: string) => { panels[id] = html; },
    icon: iconStub,
  });
  return { scope, panels };
}

test("the In flight tile counts a running director even though it holds no permit", () => {
  const { scope, panels } = statsScope();
  scope.renderStats({
    running: true,
    loops: [
      { role: "director", phase: "director working 1m", inFlight: false },
      { role: "feature", phase: "working 5s", inFlight: true },
    ],
  });
  const html = panels["stats"] ?? "";
  assert.match(html, /In flight<\/span><span class='stat-value'>2 <small>of 2 loops<\/small>/, "the tile counts both live loops");
  assert.match(html, />2 working</, "the subtitle names both as working");
});

test("the Landed today tile shows the work/maintenance commit split", () => {
  const { scope, panels } = statsScope({
    totals: { commits: 5, featuresDone: 4, bugsFixed: 2, workCommits: 2, maintenanceCommits: 3, ticks: 0, tokensOut: 0, costUsd: 0 },
  });
  scope.renderStats({ running: true, loops: [] });
  const html = panels["stats"] ?? "";
  assert.match(html, /4 features done · 2 bugs fixed · 2 work \/ 3 maintenance/, "the sub-line names the work vs upkeep split");
});
