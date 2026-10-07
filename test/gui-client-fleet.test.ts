import test from "node:test";
import assert from "node:assert/strict";
import { clientScope, iconStub } from "./gui-client-scope.js";

// The dashboard's fleet-view backlog panel (src/ui/gui/gui-client-fleet.ts's marked backlog
// region), exercised the way the page runs it: the shared view-model region supplies
// queuedPrompts/splitTitle, the format region supplies fmtAgo, and a recording paintPanel
// stands in for the DOM.

function backlogScope(backlogTab = "queued") {
  const panels: Record<string, string> = {};
  const scope = clientScope<{ renderBacklog(d: object): void }>(["format", "view-model", "backlog"], ["renderBacklog"], {
    backlogTab,
    paintPanel: (id: string, html: string) => { panels[id] = html; },
    icon: iconStub,
    openEntryKey: () => null,
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

// The "In flight" stat tile counts the running set, not just the permit holders: a running
// director is genuinely in flight though it holds no maxConcurrent permit, so the tile must
// not read 0 beside a live Director row (BUGS.md 2026-10-06).
function statsScope() {
  const panels: Record<string, string> = {};
  const scope = clientScope<{ renderStats(d: object): void }>(["format", "view-model", "stats"], ["renderStats"], {
    today: null,
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
