import { sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_DRAWER_JS } from "../src/ui/gui/gui-client-drawer.js";
import { clientRegion, ESC_LINE, iconStub } from "./gui-client-scope.js";

// The dashboard's detail drawer, browser-side (src/ui/gui/gui-client-drawer.ts): the open/close
// state machine over loops and backlog entries with its #loop/<role> hash
// routing, the loop drawer's paint (unknown role, a working loop's actions and metrics), the
// backlog entry's load with its stale-response guard, and the transcript line classifier.
// The pattern test/gui-client.test.ts uses: the real format and view-model regions of the
// served script plus the drawer blob, run in one function scope with stand-ins for the DOM
// and the server.

type FakeEl = {
  innerHTML: string;
  hidden: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  listeners: Record<string, (ev?: unknown) => void>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
};

type DrawerScope = {
  openLoopRole(): string | null;
  openEntryKey(): string | null;
  toggleLoop(role: string): void;
  toggleEntry(file: string, index: number): void;
  renderLoopDrawer(d: object): void;
  drawerChangeHtml(view: unknown): string;
  landingSummary(d: object, role: string): string;
  transcriptHtml(lines: string[]): string;
  loadLoopTicks(force: boolean): Promise<void>;
  refreshEntry(): Promise<void>;
  refreshDrawer(): Promise<void>;
};

/** Run the drawer blob after the script's own esc() and the real format and view-model
 * regions, with `inject` bound as free variables, and hand back the names asked for. */
function drawerScope(names: string[], inject: Record<string, unknown>): DrawerScope {
  const keys = Object.keys(inject);
  const code = [ESC_LINE, clientRegion("format"), clientRegion("view-model"), GUI_CLIENT_DRAWER_JS,
    `return { ${names.join(", ")} };`].join("\n");
  const run = new Function(...keys, code) as (...args: unknown[]) => DrawerScope;
  return run(...keys.map((k) => inject[k]));
}

/** Let the blob's fire-and-forget async loads (ticks, transcript, entry) settle. */
const flush = async () => {
  await sleep(0);
  await sleep(0);
};

/** The DOM stand-ins, paint recorder, hash log, and fetch recorder one drawer test runs
 * against. `responses` maps the getJson path each async load calls to its payload. */
function drawerEnv(opts: { status?: object | null; responses?: Record<string, unknown>; overrides?: Record<string, unknown> } = {}) {
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    let node = els.get(id);
    if (!node) {
      node = {
        innerHTML: "", hidden: true, scrollTop: 0, clientHeight: 100, scrollHeight: 100,
        listeners: {},
        addEventListener(type, fn) { node!.listeners[type] = fn; },
      };
      els.set(id, node);
    }
    return node;
  };
  const painted: Array<[string, string]> = [];
  const lastPaint: Record<string, string> = {};
  const historyLog: string[] = [];
  const jsonCalls: string[] = [];
  const responses = opts.responses ?? {};
  const location = { hash: "" };
  const env: Record<string, unknown> = {
    $: el,
    lastPaint,
    paintPanel: (id: string, html: string): boolean => {
      if (lastPaint[id] === html) return false;
      lastPaint[id] = html;
      painted.push([id, html]);
      el(id).innerHTML = html;
      return true;
    },
    lastStatus: opts.status ?? null,
    renderFleet: () => {},
    location,
    history: {
      replaceState(_s: unknown, _t: string, hash: string) { historyLog.push(hash); location.hash = hash; },
    },
    activeView: "fleet",
    pill: (info: { tone: string; label: string }) => `<pill ${info.tone}:${info.label}>`,
    icon: iconStub,
    abortConfirming: () => false,
    phaseDetail: () => "phase detail",
    clickClosest: () => null,
    rowAction: () => {},
    renderMarkdown: (md: string) => `<md>${md}</md>`,
    errorPanel: (title: string) => `<err>${title}</err>`,
    getJson: (path: string) => {
      jsonCalls.push(path);
      const d = responses[path];
      return Promise.resolve(d ?? (path.includes("/api/transcript") ? { lines: [] } : path.includes("/api/history") ? { rows: [] } : {}));
    },
    pollSignal: () => null,
    ...(opts.overrides ?? {}),
  };
  const paintedFor = (id: string): string => [...painted].reverse().find(([i]) => i === id)?.[1] ?? "";
  return { env, painted, paintedFor, historyLog, jsonCalls, el };
}

/** A scope over the drawer with the given names, plus its env. */
function openDrawer(names: string[], opts: Parameters<typeof drawerEnv>[0] = {}): { scope: DrawerScope } & ReturnType<typeof drawerEnv> {
  const env = drawerEnv(opts);
  return { scope: drawerScope(names, env.env), ...env };
}

/** A fleet status whose only loop is a working, in-flight, unpaused "clean". */
function workingStatus() {
  const now = Date.now();
  return {
    running: true,
    pausedRoles: [] as string[],
    loops: [{
      role: "clean", phase: "working · writing tests", inFlight: true,
      currentWork: "Adding drawer tests", lastResult: "changed", lastSummary: "did the thing",
      lastTickEndedAt: now - 60_000, commits: 2, ticks: 5, generated: 12_345, peakCtx: 90_000,
      todayUsd: 1.5, costUsd: 3, nextRunAt: now + 30_000, yieldMultiplier: 1, backoffSeconds: 0,
    }],
  };
}

test("opening a loop routes the hash, toggling the same role closes it back to the fleet view", async () => {
  const t = openDrawer(["toggleLoop", "openLoopRole"], { status: workingStatus() });
  t.scope.toggleLoop("clean");
  assert.equal(t.scope.openLoopRole(), "clean");
  assert.ok(t.historyLog.includes("#loop/clean"), `hash not routed: ${t.historyLog}`);
  assert.equal(t.el("drawer").hidden, false);
  assert.equal(t.el("scrim").hidden, false);
  await flush();

  t.scope.toggleLoop("clean");
  assert.equal(t.scope.openLoopRole(), null);
  assert.equal(t.el("drawer").hidden, true);
  assert.equal(t.el("scrim").hidden, true);
  assert.ok(t.historyLog.includes("#fleet"), `hash not restored: ${t.historyLog}`);

  t.scope.toggleLoop("bugfix");
  assert.equal(t.scope.openLoopRole(), "bugfix");
  // The scrim's click closes whatever is open — wired at script-eval time.
  t.el("scrim").listeners["click"]?.();
  assert.equal(t.scope.openLoopRole(), null);
});

test("switching roles while a loop drawer is open moves it without closing", () => {
  const t = openDrawer(["toggleLoop", "openLoopRole"], { status: workingStatus() });
  t.scope.toggleLoop("clean");
  t.scope.toggleLoop("bugfix");
  assert.equal(t.scope.openLoopRole(), "bugfix");
});

test("the loop drawer for a role the fleet no longer has says so, paints no actions, and still renders its pending change", async () => {
  const t = openDrawer(["toggleLoop"], {
    status: { loops: [] },
    responses: { "/api/diff?role=gone": { state: "ready", branch: "tumwater/gone", mainBranch: "main", ahead: 1, commits: [{ sha: "deadbee", subject: "unlanded" }], diff: "diff --git a/x b/x\n", dirtyFiles: [] } },
  });
  t.scope.toggleLoop("gone");
  assert.match(t.paintedFor("drawerhead"), /no longer part of the fleet/);
  assert.equal(t.paintedFor("draweractions"), "");
  // The change section renders for a role absent from statusPayload.loops, so a disabled
  // loop's unlanded patch is still visible in its drawer.
  assert.match(t.paintedFor("drawermeta"), /Pending change/);
  await flush();
  const meta = t.paintedFor("drawermeta");
  assert.match(meta, /tumwater\/gone/);
  assert.match(meta, /deadbee unlanded/);
  assert.match(meta, /<pre class='mono diff'>diff --git a\/x b\/x/);
});

test("the loop drawer paints a working loop's actions, metrics, ticks, and transcript with the real formatters", async () => {
  const now = Date.now();
  const t = openDrawer(["toggleLoop", "loadLoopTicks"], {
    status: workingStatus(),
    responses: {
      "/api/history?n=8&role=clean": { rows: [{ tick: 3, ts: now - 120_000, result: "changed", detail: "tidied the drawer", durationMs: 65_000, time: "12:00:00" }] },
      "/api/transcript?role=clean&n=200": { lines: ["── tick 3", "→ npm test"] },
    },
  });
  t.scope.toggleLoop("clean");
  await flush();

  const actions = t.paintedFor("draweractions");
  assert.match(actions, /data-action='prompt'/);
  assert.match(actions, /data-action='abort'/);
  assert.match(actions, /Abort this tick/);
  assert.match(actions, /btn-danger/);
  assert.match(actions, /data-action='pause'/);
  assert.doesNotMatch(actions, /data-action='resume'/);
  assert.match(actions, /<i:stop>/);

  const head = t.paintedFor("drawerhead");
  assert.match(head, /<pill blue:Working>/);
  assert.match(head, /clean/);
  assert.match(head, /<span class='muted'>phase detail<\/span>/);

  const meta = t.paintedFor("drawermeta");
  assert.match(meta, /Working on/);
  assert.match(meta, /Adding drawer tests/);
  assert.match(meta, /Landed<\/span> — did the thing/);
  assert.match(meta, /Tokens, this tick<\/dt><dd title='12\.3k'>12\.3k</);
  assert.match(meta, /Peak context, this tick<\/dt><dd title='90\.0k'>90\.0k</);
  assert.match(meta, /Spent today<\/dt><dd title='\$1\.50'>\$1\.50</);
  assert.match(meta, /1m ago/); // the last tick's age, through the real fmtAgo
  // The fetched tick rows render with the real result/age/span formatters.
  assert.match(meta, /#3 · /);
  assert.match(meta, /tidied the drawer/);
  assert.match(meta, /2m ago/);
  assert.match(meta, />65s</); // fmtSpan(65_000)

  // The transcript rendered through transcriptHtml and pinned to the bottom.
  const pre = t.el("transcript");
  assert.match(pre.innerHTML, /<span class='l-sep'>── tick 3<\/span>/);
  assert.match(pre.innerHTML, /<span class='l-tool'>→ npm test<\/span>/);
  assert.equal(pre.scrollTop, pre.scrollHeight);
});

test("loadLoopTicks throttles repeat polls to one fetch per 5 s unless forced, and skips when closed", async () => {
  const t = openDrawer(["toggleLoop", "loadLoopTicks"], { status: workingStatus() });
  t.scope.toggleLoop("clean");
  await flush();
  const historyCalls = () => t.jsonCalls.filter((p) => p === "/api/history?n=8&role=clean").length;
  const afterOpen = historyCalls(); // openLoop's own force=true load
  assert.ok(afterOpen >= 1);

  await t.scope.loadLoopTicks(false);
  assert.equal(historyCalls(), afterOpen); // inside the 5 s window: throttled
  await t.scope.loadLoopTicks(true);
  assert.equal(historyCalls(), afterOpen + 1); // force bypasses the window

  t.scope.toggleLoop("clean"); // closed: no role to load for
  await t.scope.loadLoopTicks(true);
  assert.equal(historyCalls(), afterOpen + 1);
});

test("a stale backlog response for a since-replaced entry is ignored", async () => {
  const deferred: Array<{ path: string; resolve: (v: unknown) => void }> = [];
  const t = openDrawer(["toggleEntry", "openEntryKey"], {
    status: { loops: [] },
    overrides: {
      getJson: (path: string) => new Promise<unknown>((resolve) => deferred.push({ path, resolve })),
    },
  });
  t.scope.toggleEntry("plans", 0);
  await flush();
  t.scope.toggleEntry("plans", 1); // the reader moved on before entry 0 answered
  await flush();
  assert.equal(t.scope.openEntryKey(), "plans:1");

  const old = deferred.find((d) => d.path === "/api/backlog?file=plans&index=0");
  assert.ok(old, "entry 0 never fetched");
  old.resolve({ title: "Old entry", body: "old body" });
  await flush();
  assert.ok(!t.painted.some(([, html]) => html.includes("Old entry")), "a stale entry response was painted");

  const fresh = deferred.find((d) => d.path === "/api/backlog?file=plans&index=1");
  assert.ok(fresh, "entry 1 never fetched");
  fresh.resolve({ title: "New entry (planned 2026-09-30 by plan loop)", body: "**why**" });
  await flush();
  assert.match(t.paintedFor("drawerhead"), /Planned feature · planned 2026-09-30 by plan loop/);
  assert.match(t.paintedFor("drawerhead"), /New entry/);
  assert.match(t.paintedFor("entrybody"), /<md>\*\*why\*\*<\/md>/);
  assert.match(t.paintedFor("entrybody"), /data-act='mention' data-arg='plans:1'/);
});

test("an open question entry offers the composer's answer action, an empty body says so", async () => {
  const t = openDrawer(["toggleEntry"], {
    status: { loops: [] },
    responses: { "/api/backlog?file=questions&index=2": { title: "Which backend?", body: "" } },
  });
  t.scope.toggleEntry("questions", 2);
  await flush();
  assert.match(t.paintedFor("drawerhead"), /Open question/);
  assert.match(t.paintedFor("entrybody"), /data-act='answer' data-arg='2'/);
  assert.match(t.paintedFor("entrybody"), /No details for this entry\./);
});

test("closing the drawer silences refreshDrawer", async () => {
  const t = openDrawer(["toggleEntry", "refreshDrawer"], {
    status: { loops: [] },
    responses: { "/api/backlog?file=questions&index=2": { title: "Which backend?", body: "" } },
  });
  t.scope.toggleEntry("questions", 2);
  await flush();
  t.scope.toggleEntry("questions", 2); // the same row closes it
  assert.equal(t.el("drawer").hidden, true);
  const paintsBefore = t.painted.length;
  await t.scope.refreshDrawer();
  assert.equal(t.painted.length, paintsBefore, "a closed drawer still refreshed");
});

test("landingSummary picks the held change for a role, in both in-flight shapes, and stays empty otherwise", () => {
  const t = openDrawer(["landingSummary"]);
  const single = { landQueue: { inFlight: { role: "clean", summary: "Sole change" } } };
  assert.equal(t.scope.landingSummary(single, "clean"), "Sole change");
  assert.equal(t.scope.landingSummary(single, "other"), "");
  const batch = { landQueue: { inFlight: { changes: [{ role: "a", summary: "A" }, { role: "b", summary: "B" }] } } };
  assert.equal(t.scope.landingSummary(batch, "b"), "B");
  assert.equal(t.scope.landingSummary(batch, "c"), "");
  assert.equal(t.scope.landingSummary({}, "a"), "");
  assert.equal(t.scope.landingSummary({ landQueue: { inFlight: { changes: [{ role: "a", summary: "" }] } } }, "a"), "");
});

test("drawerChangeHtml renders the full patch for a ready view and degrades the rest", () => {
  const t = openDrawer(["drawerChangeHtml"]);
  const ready = {
    state: "ready", branch: "tumwater/feature", mainBranch: "main", ahead: 1,
    commits: [{ sha: "abc12345", subject: "add the thing" }],
    diff: "diff --git a/x b/x\n+line\n",
    dirtyFiles: ["x"],
    uncommittedDiff: "diff --git a/y b/y\n",
  };
  const html = t.scope.drawerChangeHtml(ready);
  assert.match(html, /tumwater\/feature/);
  assert.match(html, /1 commit/);
  assert.match(html, /abc12345 add the thing/);
  assert.match(html, /<pre class='mono diff'>diff --git a\/x b\/x/);
  assert.match(html, /Uncommitted: x/);
  assert.match(html, /diff --git a\/y b\/y/);
  // Degraded states name their situation; a malformed payload never renders a half-view.
  assert.match(t.scope.drawerChangeHtml({ state: "absent" }), /No worktree yet/);
  assert.match(t.scope.drawerChangeHtml({ state: "no-base", mainBranch: "ghost" }), /Main branch ghost/);
  assert.match(t.scope.drawerChangeHtml({ state: "ready", ahead: 0, commits: [], dirtyFiles: [] }), /No unlanded work/);
  assert.match(t.scope.drawerChangeHtml(null), /unavailable/);
  assert.match(t.scope.drawerChangeHtml({}), /No unlanded work/);
});

test("transcriptHtml classifies run separators, tool calls, thinking, and warnings, escaping each line", () => {
  const t = openDrawer(["transcriptHtml"]);
  assert.equal(
    t.scope.transcriptHtml(["── tick 3", "→ npm test", "· thinking out loud", "⚠ retrying", "plain <line>"]),
    "<span class='l-sep'>── tick 3</span>\n" +
    "<span class='l-tool'>→ npm test</span>\n" +
    "<span class='l-think'>· thinking out loud</span>\n" +
    "<span class='l-warn'>⚠ retrying</span>\n" +
    "plain &lt;line&gt;",
  );
  // The blank line separates runs, but never before the first line.
  assert.equal(t.scope.transcriptHtml(["── a"]), "<span class='l-sep'>── a</span>");
});
