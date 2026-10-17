import test from "node:test";
import assert from "node:assert/strict";
import { clientScope, iconStub } from "./helpers/gui-client-scope.js";
import { GUI_CLIENT_TEAM_JS } from "../src/ui/gui/gui-client-team.js";
import { GUI_PAGE } from "../src/ui/gui/gui-page.js";

// The dashboard's team-view backlog panel (src/ui/gui/gui-client-team.ts's marked backlog
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
    beginBacklogNew(kind: string): void;
    toggleBacklogSeries(name: string): void;
  }>(["format", "labels", "view-model", "backlog"], ["renderBacklog", "beginQueuedEdit", "endQueuedEdit", "setBacklogTab", "beginBacklogNew", "toggleBacklogSeries"], {
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
  assert.match(html, />for the qa role · queued 2h ago</);
  // A null stamp renders exactly today's meta text — the age is omitted, not an error.
  assert.match(html, />for the director<\/span>/, "the unstamped director prompt keeps the bare meta");
  // The cancel affordance is unchanged for both rows: the queue-file address and the role,
  // never a list position.
  assert.match(html, /data-action='promptcancel' data-file='a\.md' data-role='director'/);
  assert.match(html, /data-action='promptcancel' data-file='b\.md' data-role='director'/);
  assert.match(html, /data-action='promptcancel' data-file='q\.md' data-role='qa'/);
});

// Each role's queue head carries no Move to top (a no-op there); every later row of that
// role does, addressed by the same queue-file basename and role as Cancel and Edit — so a
// stale poll can never reorder the wrong prompt.
test("the Queued tab paints a Move to top button on every row except its role's first", () => {
  const { scope, panels } = backlogScope();
  scope.renderBacklog({
    questions: [], plans: [], bugs: [],
    inboxPrompts: ["first", "second"],
    inboxFiles: ["a.md", "b.md"],
    inboxQueuedAt: [null, null],
    roleInboxPrompts: {
      qa: [
        { file: "q1.md", preview: "qa one", queuedAtMs: null },
        { file: "q2.md", preview: "qa two", queuedAtMs: null },
      ],
    },
  });
  const html = panels["backlog"] ?? "";
  // The second row of each role group carries the button, addressed like Cancel/Edit.
  assert.match(html, /data-action='prompttop' data-file='b\.md' data-role='director'/);
  assert.match(html, /data-action='prompttop' data-file='q2\.md' data-role='qa'/);
  // Neither role's first row (its queue head) carries one.
  assert.doesNotMatch(html, /data-action='prompttop' data-file='a\.md'/);
  assert.doesNotMatch(html, /data-action='prompttop' data-file='q1\.md'/);
  assert.equal((html.match(/data-action='prompttop'/g) || []).length, 2);
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
  assert.match(GUI_CLIENT_TEAM_JS, /button\.rowaction\[data-action='promptedit'\]/);
  assert.match(GUI_CLIENT_TEAM_JS, /button\.rowaction\[data-action='prompteditsave'\]/);
  assert.match(GUI_CLIENT_TEAM_JS, /button\.rowaction\[data-action='prompteditcancel'\]/);
  assert.match(GUI_CLIENT_TEAM_JS, /button\.rowaction\[data-action='prompttop'\]/);
  assert.match(GUI_CLIENT_TEAM_JS, /"\/api\/prompt-text\?role="/);
  assert.match(GUI_CLIENT_TEAM_JS, /"\/api\/prompt-edit"/);
  assert.match(GUI_CLIENT_TEAM_JS, /"\/api\/prompt-top"/);
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
  bugs.scope.renderBacklog({ ...base, bugs: ["A dead bug (reported 2026-10-01)"], bugHolds: [" [blocked: refused]"] });
  const bugsHtml = bugs.panels["backlog"] ?? "";
  assert.match(bugsHtml, /li-title'>A dead bug<\/span><span class='li-meta'>reported 2026-10-01<\/span><span class='li-meta'>\[blocked: refused\]<\/span>/);
});

test("an eligible Plans row is byte-identical whether or not the payload carries holds", () => {
  const payload = { questions: [], plans: ["Ready (planned 2026-10-01)"], bugs: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  const withHolds = backlogScope("plans");
  withHolds.scope.renderBacklog({ ...payload, planHolds: [""] });
  const without = backlogScope("plans");
  without.scope.renderBacklog(payload);
  assert.equal(withHolds.panels["backlog"], without.panels["backlog"]);
  const unblocked = backlogScope("plans");
  unblocked.scope.renderBacklog({ ...payload, planHolds: [""], planBlocked: [false] });
  assert.equal(unblocked.panels["backlog"], without.panels["backlog"]);
});

test("the Plans tab lists pickable rows first and blocked rows under a Blocked divider", () => {
  const base = { questions: [], plans: [], bugs: [], planHolds: [], bugHolds: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  const plans = backlogScope("plans");
  plans.scope.renderBacklog({
    ...base,
    plans: ["Alpha", "Bravo", "Charlie", "Delta"],
    planHolds: [" [blocked: refused]", "", " [blocked: refused]", ""],
    planBlocked: [true, false, true, false],
  });
  const html = plans.panels["backlog"] ?? "";
  const at = (s: string) => html.indexOf(s);
  assert.ok(at("Bravo") > 0 && at("Bravo") < at("Delta"));
  assert.ok(at("Delta") < at("Blocked (2)"));
  assert.ok(at("Blocked (2)") < at("Alpha"));
  assert.ok(at("Alpha") < at("Charlie"));
  assert.match(html, /data-file='plans' data-index='0'><span class='li-title'>Alpha/);
  assert.match(html, /data-file='plans' data-index='2'><span class='li-title'>Charlie/);

  const bugs = backlogScope("bugs");
  bugs.scope.renderBacklog({ ...base, bugs: ["Dead", "Live"], bugHolds: [" [blocked: refused]", ""], bugBlocked: [true, false] });
  const bugsHtml = bugs.panels["backlog"] ?? "";
  assert.ok(bugsHtml.indexOf("Live") < bugsHtml.indexOf("Blocked (1)"));
  assert.ok(bugsHtml.indexOf("Blocked (1)") < bugsHtml.indexOf("Dead"));
});

test("the Plans tab shows a blocked series as one row that expands on click", () => {
  const { scope, panels } = backlogScope("plans");
  const slot = { name: "S", label: "S, 2 blocked parts (2/3–3/3)" };
  const status = {
    questions: [], bugs: [], bugHolds: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {},
    plans: ["Ready", "S1", "S2", "S3", "Other"],
    planHolds: ["", "", " [blocked: requires S]", " [blocked: requires S]", " [refused]"],
    planBlocked: [false, false, true, true, true],
    planSeries: [null, null, slot, slot, null],
  };
  scope.renderBacklog(status);
  let html = panels["backlog"] ?? "";
  assert.match(html, /Blocked \(3\)/);
  assert.equal(html.split("data-action='seriestoggle'").length - 1, 1);
  assert.match(html, /S, 2 blocked parts \(2\/3–3\/3\)/);
  assert.ok(html.includes("Other"));
  assert.ok(!html.includes("data-index='2'") && !html.includes("data-index='3'"));
  scope.toggleBacklogSeries("S");
  html = panels["backlog"] ?? "";
  const at = (s: string) => html.indexOf(s);
  assert.ok(at("seriestoggle") < at("data-index='2'"));
  assert.ok(at("data-index='2'") < at("data-index='3'"));
  assert.ok(at("data-index='3'") < at("data-index='4'"));
  scope.toggleBacklogSeries("S");
  assert.ok(!(panels["backlog"] ?? "").includes("data-index='2'"));
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
    roles: [
      { role: "director", phase: "director working 1m", inFlight: false },
      { role: "feature", phase: "working 5s", inFlight: true },
    ],
  });
  const html = panels["stats"] ?? "";
  assert.match(html, /In flight<\/span><span class='stat-value'>2 <small>of 2 roles<\/small>/, "the tile counts both live loops");
  assert.match(html, />2 working</, "the subtitle names both as working");
});

test("the Landed today tile shows the work/maintenance commit split", () => {
  const { scope, panels } = statsScope({
    totals: { commits: 5, featuresDone: 4, bugsFixed: 2, workCommits: 2, maintenanceCommits: 3, runs: 0, tokensOut: 0, costUsd: 0 },
  });
  scope.renderStats({ running: true, roles: [] });
  const html = panels["stats"] ?? "";
  assert.match(html, /4 features done · 2 bugs fixed · 2 work \/ 3 maintenance/, "the sub-line names the work vs upkeep split");
});

// The Activity card's narrowing (src/ui/gui/gui-client-team.ts's marked activity region): the
// Loop picker and Search box narrow the event window the card already carries, exactly as the
// History view's do. The scope runs the shared format/view-model/panel/role regions renderFeed
// reaches, with the DOM, persistence, and panel paint stubbed.
function feedScope(recalled: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const panels: Record<string, string> = {};
  const stores: Record<string, string> = {};
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const els: Record<string, { value: string; innerHTML: string; children: unknown[]; addEventListener: (type: string, fn: (ev: unknown) => void) => void }> = {};
  const $ = (id: string) => (els[id] ||= {
    value: "", innerHTML: "", children: [],
    addEventListener: (type: string, fn: (ev: unknown) => void) => { (listeners[id + ":" + type] ||= []).push(fn); },
  });
  const scope = clientScope<{ renderFeed(d: object): void; clearFeedFilter(): void; setFeedType(type: string): void }>(
    ["format", "labels", "view-model", "click-delegate", "activity", "report-role"],
    ["renderFeed", "clearFeedFilter", "setFeedType"],
    {
      recall: (key: string) => recalled[key] ?? null,
      store: (key: string, value: string) => { stores[key] = String(value); },
      paintPanel: (id: string, html: string) => { panels[id] = html; },
      markActive: () => {},
      icon: iconStub,
      lastStatus: undefined,
      // The debounced /api/logs fetch needs these free variables bound; the default answers an
      // empty slice so the unfiltered tests never touch the network or throw a stray timer.
      getJson: async () => ({ events: [] }),
      pollSignal: () => ({}),
      $,
      ...extra,
    },
  );
  return {
    scope,
    panels,
    stores,
    els,
    fire: (id: string, type: string, ev: unknown) => (listeners[id + ":" + type] || []).forEach((f) => f(ev)),
  };
}

// The 250 ms debounce plus a margin: enough for the searchFeed timer to fire and its fetch to
// settle before the assertions run.
const feedSettle = () => new Promise((r) => setTimeout(r, 320));

test("the Activity feed narrows to one loop when its Loop picker is set", () => {
  const { scope, panels } = feedScope({ "feed-role": "feature" });
  scope.renderFeed({
    roles: [{ role: "feature" }, { role: "bugfix" }],
    eventItems: [
      { ts: Date.now(), source: "feature", type: "merged", message: "did a feature thing" },
      { ts: Date.now(), source: "bugfix", type: "question_posted", message: "did a bugfix thing" },
    ],
  });
  const html = panels["feed"] ?? "";
  assert.match(html, /did a feature thing/);
  assert.doesNotMatch(html, /did a bugfix thing/, "the other loop's event is filtered out");
});

test("the Activity feed's Search matches loop, type, and message case-insensitively", () => {
  const items = [
    { ts: Date.now(), source: "qa", type: "merged", message: "the suite FAILED" },
    { ts: Date.now(), source: "qa", type: "question_posted", message: "all green" },
  ];
  const lower = feedScope({ "feed-grep": "failed" });
  lower.scope.renderFeed({ roles: [], eventItems: items });
  assert.match(lower.panels["feed"] ?? "", /the suite FAILED/, "a lower-cased needle matches an upper-cased message");
  assert.doesNotMatch(lower.panels["feed"] ?? "", /all green/);
  const upper = feedScope({ "feed-grep": "GREEN" });
  upper.scope.renderFeed({ roles: [], eventItems: items });
  assert.match(upper.panels["feed"] ?? "", /all green/, "an upper-cased needle matches a lower-cased message");
  assert.doesNotMatch(upper.panels["feed"] ?? "", /the suite FAILED/);
});

test("a filter that removes every carried event paints the clearable empty state", () => {
  const carried = { ts: Date.now(), source: "qa", type: "merged", message: "boom" };
  const filtered = feedScope({ "feed-grep": "no-such-text" });
  filtered.scope.renderFeed({ roles: [], eventItems: [carried] });
  const html = filtered.panels["feed"] ?? "";
  assert.match(html, /No recent events match this filter/);
  assert.match(html, /data-action='feedclear'/);
  // An event window that is empty to begin with keeps today's wording, filter or not.
  const empty = feedScope({ "feed-grep": "no-such-text" });
  empty.scope.renderFeed({ roles: [], eventItems: [] });
  const emptyHtml = empty.panels["feed"] ?? "";
  assert.match(emptyHtml, /No events yet/);
  assert.doesNotMatch(emptyHtml, /No recent events match this filter/);
});

test("an in-progress Search value survives a status poll", () => {
  const { scope, els } = feedScope();
  const box = els.feedgrep!;
  box.value = "half-typed";
  scope.renderFeed({
    roles: [],
    eventItems: [{ ts: Date.now(), source: "qa", type: "merged", message: "landed one" }],
  });
  assert.equal(box.value, "half-typed", "renderFeed leaves the box's live value alone");
});

test("a Notable-only cull keeps the notable wording, not the filter empty state", () => {
  const { scope, panels } = feedScope({ "feed-role": "qa" });
  scope.renderFeed({
    roles: [{ role: "qa" }],
    eventItems: [{ ts: Date.now(), source: "qa", type: "run_start", message: "working" }],
  });
  const html = panels["feed"] ?? "";
  assert.match(html, /Nothing notable lately/, "the Notable choice, not the Loop picker, emptied the feed");
  assert.doesNotMatch(html, /No recent events match this filter/);
});

test("with neither filter set the Activity feed paints the unfiltered rows byte-for-byte", () => {
  const payload = {
    roles: [{ role: "qa" }],
    eventItems: [
      { ts: Date.now(), source: "qa", type: "merged", message: "landed one" },
      { ts: Date.now(), source: "qa", type: "question_posted", message: "needs you" },
    ],
  };
  const plain = feedScope();
  plain.scope.renderFeed(payload);
  const empty = feedScope({ "feed-role": "", "feed-grep": "" });
  empty.scope.renderFeed(payload);
  assert.equal(empty.panels["feed"], plain.panels["feed"], "empty filters are a no-op, not a markup change");
  assert.match(plain.panels["feed"] ?? "", /landed one/);
  assert.match(plain.panels["feed"] ?? "", /needs you/);
});

test("an active Search fetches /api/logs and paints a slice beyond the carried window", async () => {
  const payload = { roles: [], eventItems: [{ ts: Date.now(), source: "qa", type: "merged", message: "carried row" }] };
  const calls: string[] = [];
  const getJson = async (path: string) => {
    calls.push(path);
    return { events: [{ ts: 1, source: "feature", type: "merge_failed", result: "rejected", message: "old failure" }] };
  };
  const { scope, panels } = feedScope({ "feed-grep": "failure" }, { getJson, lastStatus: payload });
  scope.renderFeed(payload);
  // The carried window narrows at once, before the debounce fires: the far event is not there yet.
  assert.doesNotMatch(panels["feed"] ?? "", /old failure/);
  await feedSettle();
  assert.deepEqual(calls, ["/api/logs?grep=failure"]);
  assert.match(panels["feed"] ?? "", /old failure/, "the server's slice replaces the carried window");
  assert.doesNotMatch(panels["feed"] ?? "", /carried row/);
});

test("the search query carries only the non-empty Loop and Search filters", async () => {
  const calls: string[] = [];
  const payload = { roles: [{ role: "qa" }], eventItems: [] };
  const { scope } = feedScope({ "feed-role": "qa", "feed-grep": "boom" }, {
    getJson: async (path: string) => { calls.push(path); return { events: [] }; },
    lastStatus: payload,
  });
  scope.renderFeed(payload);
  await feedSettle();
  assert.deepEqual(calls, ["/api/logs?grep=boom&role=qa"]);
});

test("a server search with no matches names the searched slice, not the carried window", async () => {
  const payload = { roles: [], eventItems: [{ ts: Date.now(), source: "qa", type: "merged", message: "carried row" }] };
  const { scope, panels } = feedScope({ "feed-grep": "carried" }, {
    getJson: async () => ({ events: [] }),
    lastStatus: payload,
  });
  scope.renderFeed(payload);
  await feedSettle();
  const html = panels["feed"] ?? "";
  assert.match(html, /No events match this filter in the log's recent slice/);
  assert.doesNotMatch(html, /No recent events match this filter/);
});

test("a stale search response never paints over a newer filter", async () => {
  const payload = { roles: [], eventItems: [] };
  const calls: string[] = [];
  const resolvers: ((v: unknown) => void)[] = [];
  const getJson = (path: string) => new Promise((resolve) => { calls.push(path); resolvers.push(resolve); });
  const { scope, panels, fire } = feedScope({ "feed-grep": "first" }, { getJson, lastStatus: payload });
  scope.renderFeed(payload);
  await feedSettle();
  assert.deepEqual(calls, ["/api/logs?grep=first"]);
  // A newer keystroke issues a newer request while the first is still in flight.
  fire("feedgrep", "input", { target: { value: "second" } });
  await feedSettle();
  assert.deepEqual(calls, ["/api/logs?grep=first", "/api/logs?grep=second"]);
  // The newer answer lands, then the stale one — which must not repaint.
  resolvers[1]!({ events: [{ ts: 2, source: "qa", type: "merged", message: "second match" }] });
  await new Promise((r) => setTimeout(r, 10));
  resolvers[0]!({ events: [{ ts: 1, source: "qa", type: "merge_failed", message: "first match" }] });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(panels["feed"] ?? "", /second match/);
  assert.doesNotMatch(panels["feed"] ?? "", /first match/);
});

test("a failed search paints the endpoint-version note", async () => {
  const payload = { roles: [], eventItems: [] };
  const { scope, panels } = feedScope({ "feed-grep": "x" }, {
    getJson: async () => { throw new Error("HTTP 404 — not found"); },
    lastStatus: payload,
  });
  scope.renderFeed(payload);
  await feedSettle();
  const html = panels["feed"] ?? "";
  assert.match(html, /Search unavailable/);
  assert.match(html, /may predate the \/api\/logs endpoint/);
});

test("clearing the filter restores the windowed feed byte-for-byte", async () => {
  const payload = {
    roles: [{ role: "qa" }],
    eventItems: [
      { ts: Date.now(), source: "qa", type: "merged", message: "landed one" },
      { ts: Date.now(), source: "qa", type: "question_posted", message: "needs you" },
    ],
  };
  const { scope, panels } = feedScope({ "feed-grep": "one" }, {
    getJson: async () => ({ events: [{ ts: 1, source: "qa", type: "merge_failed", message: "server row" }] }),
    lastStatus: payload,
  });
  scope.renderFeed(payload);
  await feedSettle();
  assert.match(panels["feed"] ?? "", /server row/);
  scope.clearFeedFilter();
  const plain = feedScope();
  plain.scope.renderFeed(payload);
  assert.equal(panels["feed"], plain.panels["feed"], "no-filter markup is byte-identical after clearing");
});

test("the Activity feed tallies its present event types like logs --count", () => {
  // Default feed filter is Notable, so carry the routine tick rows too via the All choice.
  const { scope, panels } = feedScope({ feed: "all" });
  scope.renderFeed({
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "a" },
      { ts: 2, source: "qa", type: "run_end", message: "b" },
      { ts: 3, source: "qa", type: "run_end", message: "c" },
      { ts: 4, source: "qa", type: "question_posted", message: "d" },
      { ts: 5, source: "qa", type: "question_posted", message: "e" },
      { ts: 6, source: "qa", type: "run_start", message: "f" },
      { ts: 7, source: "qa", type: "run_start", message: "g" },
      { ts: 8, source: "qa", type: "merged", message: "h" },
    ],
  });
  const html = panels["feed"] ?? "";
  // One N × <type> chip per present type, count-descending then type-name ascending.
  assert.match(html, /3 × run finished/);
  assert.match(html, /2 × question posted/);
  assert.match(html, /2 × run started/);
  assert.match(html, /1 × merged/);
  // Order: the 3-count first, then the tied 2-counts alphabetically, then the 1-count.
  assert.equal(html.indexOf("3 × run finished") < html.indexOf("2 × question posted"), true, "most frequent first");
  assert.equal(html.indexOf("2 × question posted") < html.indexOf("2 × run started"), true, "a count tie breaks by type name ascending");
  assert.equal(html.indexOf("2 × run started") < html.indexOf("1 × merged"), true, "count-descending holds past the tie");
  assert.doesNotMatch(html, /0 ×/);
  // The chip shows the label; the raw type stays reachable as its title.
  assert.match(html, /title='run_end'>3 × run finished/);
});

test("the Notable cull tallies only the notable rows", () => {
  const { scope, panels } = feedScope(); // default Notable filter
  scope.renderFeed({
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "a" },
      { ts: 2, source: "qa", type: "run_end", message: "b" },
      { ts: 3, source: "qa", type: "merged", message: "c" },
      { ts: 4, source: "qa", type: "question_posted", message: "d" },
    ],
  });
  const html = panels["feed"] ?? "";
  assert.match(html, /1 × merged/);
  assert.match(html, /1 × question posted/);
  assert.doesNotMatch(html, /run_end/, "routine rows the Notable view hides are not tallied");
});

test("a filter that removes every row and an empty feed paint no tally", () => {
  const carried = { ts: 1, source: "qa", type: "merged", message: "boom" };
  const filtered = feedScope({ "feed-grep": "no-such-text" });
  filtered.scope.renderFeed({ roles: [], eventItems: [carried] });
  assert.doesNotMatch(filtered.panels["feed"] ?? "", /feed-tally/, "a filter that empties the feed paints no chips");
  const empty = feedScope();
  empty.scope.renderFeed({ roles: [], eventItems: [] });
  assert.doesNotMatch(empty.panels["feed"] ?? "", /feed-tally/, "an empty window paints no chips");
});

test("the Activity feed tallies the server-backed /api/logs slice it displays", async () => {
  const payload = { roles: [{ role: "qa" }], eventItems: [] };
  const { scope, panels } = feedScope({ feed: "all", "feed-grep": "needle" }, {
    getJson: async () => ({
      events: [
        { ts: 1, source: "qa", type: "merged", message: "needle one" },
        { ts: 2, source: "qa", type: "merge_failed", message: "needle two" },
        { ts: 3, source: "qa", type: "merged", message: "needle three" },
        { ts: 4, source: "qa", type: "run_end", result: "failed", message: "needle four" },
      ],
    }),
    lastStatus: payload,
  });
  scope.renderFeed(payload);
  await feedSettle();
  const html = panels["feed"] ?? "";
  // The server slice folds the same rows the <li> list paints (older merged x2, then a
  // merge_failed and a failed run_end): two merged, one merge_failed, one run_end.
  assert.match(html, /2 × merged/);
  assert.match(html, /1 × merge failed/);
  assert.match(html, /1 × run finished/);
  assert.doesNotMatch(html, /0 ×/);
});

test("the activity feed's type chip narrows to that exact event type", () => {
  const { scope, panels } = feedScope({ feed: "all", "feed-type": "run_end" });
  scope.renderFeed({
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "run row" },
      { ts: 2, source: "qa", type: "run_start", message: "start row" },
      { ts: 3, source: "qa", type: "merged", message: "merge row" },
    ],
  });
  const html = panels["feed"] ?? "";
  assert.match(html, /run row/);
  assert.doesNotMatch(html, /start row/);
  assert.doesNotMatch(html, /merge row/);
  assert.match(html, /data-type='run_end'[^>]*aria-pressed='true'/, "the selected type's chip is active");
});

test("the tally chips are buttons carrying data-type, marked active when selected", () => {
  const payload = {
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "run row" },
      { ts: 2, source: "qa", type: "run_start", message: "start row" },
    ],
  };
  const { scope, panels } = feedScope({ feed: "all" }, { lastStatus: payload });
  scope.renderFeed(payload);
  let html = panels["feed"] ?? "";
  assert.match(html, /<button type='button' class='chip mono' data-type='run_end'/);
  assert.match(html, /<button type='button' class='chip mono' data-type='run_start'/);
  assert.doesNotMatch(html, /<span class='chip mono'/, "chips are buttons, not spans");
  // Select a type: only its rows show and its chip carries active + aria-pressed.
  scope.setFeedType("run_end");
  html = panels["feed"] ?? "";
  assert.match(html, /class='chip mono active' data-type='run_end' title='run_end' aria-pressed='true'/);
  assert.doesNotMatch(html, /data-type='run_start'[^>]*active/, "the other chip is not marked active");
  assert.match(html, /run row/);
  assert.doesNotMatch(html, /start row/);
});

test("the type chip composes with the Loop and Search filters", () => {
  const roleFiltered = feedScope({ feed: "all", "feed-role": "qa", "feed-type": "run_end" });
  roleFiltered.scope.renderFeed({
    roles: [{ role: "qa" }],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "keep me" },
      { ts: 2, source: "feature", type: "run_end", message: "other role" },
      { ts: 3, source: "qa", type: "merged", message: "other type" },
    ],
  });
  let html = roleFiltered.panels["feed"] ?? "";
  assert.match(html, /keep me/);
  assert.doesNotMatch(html, /other role/, "the Loop picker still culls first");
  assert.doesNotMatch(html, /other type/, "the type chip narrows after the role");
  // A Search that already narrowed one type still narrows to the selected type.
  const grepFiltered = feedScope({ feed: "all", "feed-grep": "alpha", "feed-type": "run_end" });
  grepFiltered.scope.renderFeed({
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "alpha run" },
      { ts: 2, source: "qa", type: "run_end", message: "beta run" },
      { ts: 3, source: "qa", type: "merged", message: "alpha merge" },
    ],
  });
  html = grepFiltered.panels["feed"] ?? "";
  assert.match(html, /alpha run/);
  assert.doesNotMatch(html, /beta run/);
  assert.doesNotMatch(html, /alpha merge/);
});

test("the type chip narrows the server-backed slice too", async () => {
  const payload = { roles: [{ role: "qa" }], eventItems: [] };
  const { scope, panels } = feedScope({ feed: "all", "feed-role": "qa", "feed-grep": "needle" }, {
    getJson: async () => ({
      events: [
        { ts: 1, source: "qa", type: "merged", message: "needle one" },
        { ts: 2, source: "qa", type: "merge_failed", message: "needle two" },
        { ts: 3, source: "qa", type: "merged", message: "needle three" },
      ],
    }),
    lastStatus: payload,
  });
  scope.renderFeed(payload);
  await feedSettle();
  let html = panels["feed"] ?? "";
  assert.match(html, /needle one/);
  assert.match(html, /needle two/);
  scope.setFeedType("merged");
  html = panels["feed"] ?? "";
  assert.match(html, /needle one/);
  assert.match(html, /needle three/);
  assert.doesNotMatch(html, /needle two/, "the type narrows the server rows the card displays");
  assert.match(html, /data-type='merged'[^>]*aria-pressed='true'/, "the selected type's chip is active");
  assert.match(html, /data-type='merge_failed'/, "both present types stay one click away in the chips");
});

test("a type naming no present event still paints the chips and the clearable empty state", () => {
  const { scope, panels } = feedScope({ feed: "all", "feed-type": "run_end" });
  scope.renderFeed({
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "merged", message: "a merge" },
      { ts: 2, source: "qa", type: "question_posted", message: "a question" },
    ],
  });
  const html = panels["feed"] ?? "";
  assert.match(html, /No recent events match this filter/);
  assert.match(html, /data-action='feedclear'/);
  // The chip set is built from the pre-type rows, so present types stay listed, not an empty row.
  assert.match(html, /data-type='merged'/);
  assert.match(html, /data-type='question_posted'/);
  assert.doesNotMatch(html, /data-type='run_end' title='run_end'>/, "no chip for the absent type");
});

test("clearing the filter resets the type chip too", () => {
  const payload = {
    roles: [{ role: "qa" }],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "run row" },
      { ts: 2, source: "qa", type: "merged", message: "merge row" },
    ],
  };
  const { scope, panels, stores } = feedScope({ feed: "all", "feed-type": "run_end" }, { lastStatus: payload });
  scope.renderFeed(payload);
  assert.match(panels["feed"] ?? "", /run row/);
  assert.doesNotMatch(panels["feed"] ?? "", /merge row/);
  scope.clearFeedFilter();
  assert.equal(stores["feed-type"], "", "the type is persisted as cleared");
  assert.equal(stores["feed-role"], "", "the role is persisted as cleared");
  assert.equal(stores["feed-grep"], "", "the search is persisted as cleared");
  assert.match(panels["feed"] ?? "", /merge row/, "the feed repaints unfiltered");
});

test("clicking a type chip selects it and clicking the active chip clears it", () => {
  const payload = {
    roles: [],
    eventItems: [
      { ts: 1, source: "qa", type: "run_end", message: "run row" },
      { ts: 2, source: "qa", type: "merged", message: "merge row" },
    ],
  };
  const El = class Element {};
  const hit = (sel: string, dataset: Record<string, string>) => {
    const t = new El();
    (t as unknown as { closest: (q: string) => unknown }).closest = (q: string) => (q === sel ? { dataset } : null);
    return t;
  };
  const { scope, panels, stores, fire } = feedScope({ feed: "all" }, { lastStatus: payload, Element: El });
  scope.renderFeed(payload);
  assert.match(panels["feed"] ?? "", /run row/);
  assert.match(panels["feed"] ?? "", /merge row/);
  // Click the merged chip: it is not the current type (none), so it gets selected.
  fire("feed", "click", { target: hit("button[data-type]", { type: "merged" }) });
  assert.equal(stores["feed-type"], "merged");
  assert.match(panels["feed"] ?? "", /merge row/);
  assert.doesNotMatch(panels["feed"] ?? "", /run row/);
  // Click the now-active merged chip again: it clears the type, re-showing everything.
  fire("feed", "click", { target: hit("button[data-type]", { type: "merged" }) });
  assert.equal(stores["feed-type"], "", "clicking the active chip lifts the filter");
  assert.match(panels["feed"] ?? "", /run row/);
  assert.match(panels["feed"] ?? "", /merge row/);
});

test("the Activity filter persists its choices and the page ships the controls in the card head", () => {
  assert.match(GUI_CLIENT_TEAM_JS, /store\("feed-role"/);
  assert.match(GUI_CLIENT_TEAM_JS, /store\("feed-grep"/);
  assert.match(GUI_CLIENT_TEAM_JS, /store\("feed-type"/);
  const card = GUI_PAGE.slice(GUI_PAGE.indexOf('aria-labelledby="activity-title"'));
  const head = card.slice(0, card.indexOf("</header>"));
  assert.match(head, /id="feedrole"/);
  assert.match(head, /id="feedgrep"/);
});

test("the Plans and Bugs tabs offer a New form that survives polls and drops on a tab switch", () => {
  const status = { questions: ["Q (asked 2026-10-01)"], plans: [], bugs: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  for (const [tab, kind, label] of [["plans", "plan", "New plan"], ["bugs", "bug", "File a bug"]] as const) {
    const { scope, panels } = backlogScope(tab, { lastStatus: status });
    scope.renderBacklog(status);
    assert.match(panels["backlog"] ?? "", new RegExp(`data-action='backlognew' data-kind='${kind}'>${label}<`));
    scope.beginBacklogNew(kind);
    const html = panels["backlog"] ?? "";
    assert.match(html, /<input id='backlognew'/);
    assert.match(html, /<textarea id='backlognewbody'/);
    assert.match(GUI_CLIENT_TEAM_JS, /body: bodyBox \? bodyBox\.value : ""/);
    assert.match(html, new RegExp(`data-action='backlognewsave' data-kind='${kind}'`));
    assert.match(html, /data-action='backlognewcancel'/);
    scope.renderBacklog(status);
    assert.equal(panels["backlog"], html, "a poll keeps the open form");
    scope.setBacklogTab(tab === "plans" ? "bugs" : "plans");
    assert.doesNotMatch(panels["backlog"] ?? "", /<input id='backlognew'/);
  }
  for (const tab of ["questions", "queued"]) {
    const { scope, panels } = backlogScope(tab, { lastStatus: status });
    scope.renderBacklog(status);
    assert.doesNotMatch(panels["backlog"] ?? "", /backlognew/);
  }
});

test("the Questions tab's Answer button opens the entry drawer instead of drafting", () => {
  const { scope, panels } = backlogScope("questions");
  scope.renderBacklog({ questions: ["Which backend?"], plans: [], bugs: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} });
  const html = panels["backlog"] ?? "";
  assert.match(html, /backloglink' data-file='questions' data-index='0'>Answer</);
  assert.doesNotMatch(html, /data-act='answer'/);
});

test("the stat tile sub line wraps and reserves two lines instead of truncating", () => {
  const rule = /\.stat-sub \{([^}]*)\}/.exec(GUI_PAGE)?.[1] ?? "";
  assert.ok(rule, "page carries a .stat-sub rule");
  assert.doesNotMatch(rule, /nowrap|ellipsis/);
  assert.match(rule, /min-height: calc\(2 \* 1\.4em\)/);
  assert.match(rule, /line-height: 1\.4/);
});

test("the Questions tab lists answered questions under the open ones", () => {
  const base = { questions: [], plans: ["P (planned 2026-10-01)"], bugs: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  const answeredQuestions = [{ title: "Which <b>?", decision: "Answered 2026-10-02: A" }, { title: "Second", decision: "" }];
  const q = backlogScope("questions");
  q.scope.renderBacklog({ ...base, answeredQuestions });
  const html = q.panels["backlog"] ?? "";
  assert.ok(html.indexOf("No open questions") < html.indexOf("Answered recently"));
  assert.ok(html.indexOf("Answered recently") < html.indexOf("Which &lt;b&gt;?"));
  assert.match(html, /Answered 2026-10-02: A/);
  assert.match(html, /Second/);
  assert.match(html, /data-file='answered' data-index='0'/);
  assert.match(html, /data-file='answered' data-index='1'/);
  assert.doesNotMatch(html, /Answer<\/button>/);
  const act = backlogScope("questions", { openEntryKey: () => "answered:1" });
  act.scope.renderBacklog({ ...base, answeredQuestions });
  const rows = (act.panels["backlog"] ?? "").split("list-item t-gray");
  assert.doesNotMatch(rows[1] ?? "", /^ active/);
  assert.match(rows[2] ?? "", /^ active/);
  for (const extra of [{}, { answeredQuestions: [] }]) {
    const old = backlogScope("questions");
    old.scope.renderBacklog({ ...base, ...extra });
    assert.doesNotMatch(old.panels["backlog"] ?? "", /Answered recently/);
  }
  const plans = backlogScope("plans");
  plans.scope.renderBacklog({ ...base, answeredQuestions });
  assert.doesNotMatch(plans.panels["backlog"] ?? "", /Answered recently/);
});

test("the Plans and Bugs tabs list finished entries under the open ones", () => {
  const base = { questions: [], plans: ["P (planned 2026-10-01)"], bugs: [], inboxPrompts: [], inboxFiles: [], inboxQueuedAt: [], roleInboxPrompts: {} };
  const donePlans = [{ title: "A <b>x</b>", completedOn: "2026-10-05" }, { title: "Old (split 2026-10-01 from W)", completedOn: null }];
  const fixedBugs = [{ title: "Bug one", completedOn: "2026-10-06" }];
  const plans = backlogScope("plans");
  plans.scope.renderBacklog({ ...base, donePlans, fixedBugs });
  const html = plans.panels["backlog"] ?? "";
  assert.ok(html.indexOf(">P") < html.indexOf("Done recently"));
  assert.ok(html.indexOf("Done recently") < html.indexOf("A &lt;b&gt;x&lt;/b&gt;"));
  assert.match(html, /done 2026-10-05/);
  assert.match(html, /Old \(split 2026-10-01 from W\)<\/span><\/button><\/div>/);
  const rows = html.slice(html.indexOf("Done recently"));
  assert.match(rows, /data-file='done' data-index='0'/);
  assert.match(rows, /data-file='done' data-index='1'/);
  assert.doesNotMatch(html, /Fixed recently|Bug one/);
  const bugs = backlogScope("bugs");
  bugs.scope.renderBacklog({ ...base, donePlans, fixedBugs });
  const bhtml = bugs.panels["backlog"] ?? "";
  assert.match(bhtml, /Fixed recently/);
  assert.match(bhtml, /fixed 2026-10-06/);
  assert.match(bhtml, /data-file='fixed' data-index='0'/);
  assert.doesNotMatch(bhtml, /Done recently|A &lt;b&gt;/);
  for (const extra of [{}, { donePlans: [], fixedBugs: [] }]) {
    for (const key of ["plans", "bugs"]) {
      const t = backlogScope(key);
      t.scope.renderBacklog({ ...base, ...extra });
      assert.doesNotMatch(t.panels["backlog"] ?? "", /Done recently|Fixed recently/);
    }
  }
  const q = backlogScope("questions");
  q.scope.renderBacklog({ ...base, donePlans, fixedBugs });
  assert.doesNotMatch(q.panels["backlog"] ?? "", /Done recently|Fixed recently/);
});
