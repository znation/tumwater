import { sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_DRAWER_JS } from "../src/ui/gui/gui-client-drawer.js";
import { GUI_CLIENT_DRAWER_CONFIG_JS } from "../src/ui/gui/gui-client-drawer-config.js";
import { clientRegion, ESC_LINE, iconStub } from "./helpers/gui-client-scope.js";

// The dashboard's detail drawer, browser-side (src/ui/gui/gui-client-drawer.ts): the open/close
// state machine over roles and backlog entries with its #role/<role> hash
// routing, the role drawer's paint (unknown role, a working role's actions and metrics), the
// backlog entry's load with its stale-response guard, and the transcript line classifier.
// The pattern test/gui-client.test.ts uses: the real format and view-model regions of the
// served script plus the drawer blob, run in one function scope with stand-ins for the DOM
// and the server.

interface FakeEl {
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  listeners: Record<string, (ev?: unknown) => void>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
}

interface DrawerScope {
  openRoleId(): string | null;
  toggleDrawerChangeStat(): void;
  openEntryKey(): string | null;
  startNoteEdit(role: string, text: string): void;
  stopNoteEdit(): void;
  startCapEdit(role: string, capUsd: number): void;
  stopCapEdit(): void;
  startInstructionsEdit(role: string, text: string): void;
  stopInstructionsEdit(): void;
  startQuietEdit(role: string, window: string): void;
  stopQuietEdit(): void;
  startIntervalEdit(role: string, value: number | string): void;
  stopIntervalEdit(): void;
  startInstancesEdit(role: string, value: number | string): void;
  stopInstancesEdit(): void;
  startModelEdit(role: string, seed: { provider: string; model: string; thinking: string; backend: string }): void;
  stopModelEdit(): void;
  loadDrawerRole(role: string): Promise<void>;
  toggleRole(role: string): void;
  toggleTranscriptPrompts(): void;
  setTranscriptGrep(value: string): void;
  toggleEntry(file: string, index: number): void;
  renderRoleDrawer(d: object): void;
  drawerChangeHtml(view: unknown): string;
  overlapDetailHtml(rows: unknown): string;
  mergeSummary(d: object, role: string): string;
  transcriptHtml(lines: string[]): string;
  loadRoleRuns(force: boolean): Promise<void>;
  refreshEntry(): Promise<void>;
  refreshDrawer(): Promise<void>;
}

/** Run the drawer blob after the script's own esc() and the real format and view-model
 * regions, with `inject` bound as free variables, and hand back the names asked for. */
function drawerScope(names: string[], inject: Record<string, unknown>): DrawerScope {
  const keys = Object.keys(inject);
  const code = [ESC_LINE, clientRegion("format"), clientRegion("labels"), clientRegion("view-model"), clientRegion("pending-table"), GUI_CLIENT_DRAWER_JS, GUI_CLIENT_DRAWER_CONFIG_JS,
    `return { ${names.join(", ")} };`].join("\n");
  const run = new Function(...keys, code) as (...args: unknown[]) => DrawerScope;
  return run(...keys.map((k) => inject[k]));
}

/** Let the blob's fire-and-forget async loads (runs, transcript, entry) settle. */
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
        innerHTML: "", textContent: "", hidden: true, scrollTop: 0, clientHeight: 100, scrollHeight: 100,
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
    renderTeam: () => {},
    location,
    history: {
      replaceState(_s: unknown, _t: string, hash: string) { historyLog.push(hash); location.hash = hash; },
    },
    activeView: "team",
    pill: (info: { tone: string; label: string }) => `<pill ${info.tone}:${info.label}>`,
    icon: iconStub,
    abortConfirming: () => false,
    disableConfirming: () => false,
    confirmSlot: (_repaint: unknown) => ({ armed: () => false, disarm: () => {}, arm: () => {} }),
    rolePauseMenuOpen: () => false,
    ROLE_PAUSE_CHOICES: [[3600, "1h"]],
    roleWakeMenuOpen: () => false,
    ROLE_WAKE_CHOICES: [[1800, "30m"], [3600, "1h"]],
    phaseDetail: () => "phase detail",
    // Mirrors the real helper: an instance row also matches a wake naming its base role.
    scheduledWakesFor: (l: { role: string; instanceOf?: string }, d: { scheduledWake?: { atMs: number; roles: string[] }; scheduledWakes?: Array<{ atMs: number; roles: string[] }> }) =>
      (d.scheduledWakes ?? (d.scheduledWake ? [d.scheduledWake] : [])).filter(
        (w) => w.atMs > Date.now() && (w.roles.includes(l.role) || (l.instanceOf && w.roles.includes(l.instanceOf))),
      ),
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

/** A team status whose only role is a working, in-flight, unpaused "clean". */
function workingStatus() {
  const now = Date.now();
  return {
    running: true,
    pausedRoles: [] as string[],
    pausedLoops: [] as string[], // retired-name-ok: serialized /api key
    roles: [{
      role: "clean", phase: "working · writing tests", inFlight: true,
      currentWork: "Adding drawer tests", lastResult: "changed", lastSummary: "did the thing",
      lastRunEndedAt: now - 60_000, commits: 2, runs: 5, generated: 12_345, peakCtx: 90_000,
      todayUsd: 1.5, costUsd: 3, nextRunAt: now + 30_000, yieldMultiplier: 1, backoffSeconds: 0,
    }],
  };
}

test("opening a role routes the hash, toggling the same role closes it back to the team view", async () => {
  const t = openDrawer(["toggleRole", "openRoleId"], { status: workingStatus() });
  t.scope.toggleRole("clean");
  assert.equal(t.scope.openRoleId(), "clean");
  assert.ok(t.historyLog.includes("#role/clean"), `hash not routed: ${t.historyLog}`);
  assert.equal(t.el("drawer").hidden, false);
  assert.equal(t.el("scrim").hidden, false);
  await flush();

  t.scope.toggleRole("clean");
  assert.equal(t.scope.openRoleId(), null);
  assert.equal(t.el("drawer").hidden, true);
  assert.equal(t.el("scrim").hidden, true);
  assert.ok(t.historyLog.includes("#team"), `hash not restored: ${t.historyLog}`);

  t.scope.toggleRole("bugfix");
  assert.equal(t.scope.openRoleId(), "bugfix");
  // The scrim's click closes whatever is open — wired at script-eval time.
  t.el("scrim").listeners["click"]?.();
  assert.equal(t.scope.openRoleId(), null);
});

test("switching roles while a role drawer is open moves it without closing", () => {
  const t = openDrawer(["toggleRole", "openRoleId"], { status: workingStatus() });
  t.scope.toggleRole("clean");
  t.scope.toggleRole("bugfix");
  assert.equal(t.scope.openRoleId(), "bugfix");
});

test("the role drawer for a role the team no longer has says so, paints no actions, and still renders its pending change", async () => {
  const t = openDrawer(["toggleRole"], {
    status: { roles: [] },
    responses: { "/api/diff?role=gone": { state: "ready", branch: "tumwater/gone", mainBranch: "main", ahead: 1, commits: [{ sha: "deadbee", subject: "unlanded" }], diff: "diff --git a/x b/x\n", dirtyFiles: [] } },
  });
  t.scope.toggleRole("gone");
  assert.match(t.paintedFor("drawerhead"), /no longer part of the team/);
  assert.equal(t.paintedFor("draweractions"), "");
  // The change section renders for a role absent from statusPayload.roles, so a disabled
  // role's unmerged patch is still visible in its drawer.
  assert.match(t.paintedFor("drawermeta"), /Pending change/);
  await flush();
  const meta = t.paintedFor("drawermeta");
  assert.match(meta, /tumwater\/gone/);
  assert.match(meta, /deadbee unlanded/);
  assert.match(meta, /<pre class='mono diff'>diff --git a\/x b\/x/);
});

test("the drawer's Pending change section toggles between the full patch and the diffstat, and reopens on the full patch", async () => {
  const change = (diff: string) => ({ state: "ready", branch: "tumwater/gone", mainBranch: "main", ahead: 1, commits: [{ sha: "deadbee", subject: "unlanded" }], diff, dirtyFiles: [] });
  const t = openDrawer(["toggleRole", "toggleDrawerChangeStat"], {
    status: { roles: [] },
    responses: { "/api/diff?role=gone": change("diff --git a/x b/x\n"), "/api/diff?stat=1&role=gone": change(" x | 1 +\n") },
  });
  t.scope.toggleRole("gone");
  await flush();
  let meta = t.paintedFor("drawermeta");
  assert.match(meta, /data-change-stat/);
  assert.match(meta, />Stat only</);
  assert.match(meta, /diff --git a\/x b\/x/);
  t.scope.toggleDrawerChangeStat();
  await flush();
  meta = t.paintedFor("drawermeta");
  assert.match(meta, / x \| 1 \+/);
  assert.match(meta, />Full patch</);
  assert.doesNotMatch(meta, /diff --git/);
  t.scope.toggleDrawerChangeStat();
  await flush();
  meta = t.paintedFor("drawermeta");
  assert.match(meta, /diff --git a\/x b\/x/);
  assert.match(meta, />Stat only</);
  t.scope.toggleDrawerChangeStat();
  await flush();
  t.scope.toggleRole("gone");
  t.scope.toggleRole("gone");
  await flush();
  assert.equal(t.jsonCalls.filter((c) => c.startsWith("/api/diff")).pop(), "/api/diff?role=gone");
  assert.match(t.paintedFor("drawermeta"), />Stat only</);
});

test("an idle role's drawer offers Wake later…, and its open chooser lists one button per duration", () => {
  const idle = () => {
    const status = workingStatus();
    status.roles[0]!.phase = "sleeping";
    status.roles[0]!.inFlight = false;
    return status;
  };
  const closed = openDrawer(["toggleRole"], { status: idle() });
  closed.scope.toggleRole("clean");
  const closedActions = closed.paintedFor("draweractions");
  assert.match(closedActions, /data-action='wake-in'/);
  assert.doesNotMatch(closedActions, /data-for=/);
  const open = openDrawer(["toggleRole"], { status: idle(), overrides: { roleWakeMenuOpen: () => true } });
  open.scope.toggleRole("clean");
  const openActions = open.paintedFor("draweractions");
  assert.match(openActions, /data-action='wake-in' data-for='1800'/);
  assert.match(openActions, /data-action='wake-in' data-for='3600'/);
  assert.doesNotMatch(openActions, /data-for='0'/);
  assert.match(openActions, />in 1h</);
});

test("an idle role's drawer offers Cancel scheduled wake only while a future wake names it", () => {
  const actionsFor = (scheduledWake: unknown, instanceOf?: string, scheduledWakes?: unknown) => {
    const status = workingStatus() as unknown as { roles: Array<{ phase: string; inFlight: boolean; instanceOf?: string }>; scheduledWake?: unknown; scheduledWakes?: unknown };
    if (scheduledWakes !== undefined) status.scheduledWakes = scheduledWakes;
    if (instanceOf) status.roles[0]!.instanceOf = instanceOf;
    status.roles[0]!.phase = "sleeping";
    status.roles[0]!.inFlight = false;
    if (scheduledWake !== undefined) status.scheduledWake = scheduledWake;
    const t = openDrawer(["toggleRole"], { status: status as never });
    t.scope.toggleRole("clean");
    return t.paintedFor("draweractions");
  };
  const soon = Date.now() + 60_000;
  assert.match(actionsFor({ atMs: soon, roles: ["clean"] }), /data-action='wake-cancel'/);
  assert.doesNotMatch(actionsFor(undefined), /data-action='wake-cancel'/);
  assert.doesNotMatch(actionsFor({ atMs: soon, roles: ["other"] }), /data-action='wake-cancel'/);
  assert.doesNotMatch(actionsFor({ atMs: Date.now() - 1000, roles: ["clean"] }), /data-action='wake-cancel'/);
  // A wake naming only the base role is not cancelled by an exact-id cancel of the instance.
  assert.doesNotMatch(actionsFor({ atMs: soon, roles: ["base"] }, "base"), /data-action='wake-cancel'/);
  // A role named only by a later wake in the list still offers the cancel.
  assert.match(actionsFor({ atMs: soon, roles: ["other"] }, undefined, [{ atMs: soon, roles: ["other"] }, { atMs: soon + 1000, roles: ["clean"] }]), /data-action='wake-cancel'/);
  // An instance row: the earliest wake names only its base, a later one names its own id.
  assert.match(actionsFor(undefined, "base", [{ atMs: soon, roles: ["base"] }, { atMs: soon + 1000, roles: ["clean"] }]), /data-action='wake-cancel'/);
});

test("the role drawer paints a working role's actions, metrics, runs, and transcript with the real formatters", async () => {
  const now = Date.now();
  const t = openDrawer(["toggleRole", "loadRoleRuns"], {
    status: workingStatus(),
    responses: {
      "/api/history?n=8&role=clean": { rows: [
        { run: 3, ts: now - 120_000, result: "changed", detail: "tidied the drawer", durationMs: 65_000, time: "12:00:00" },
        { run: 2, ts: now - 240_000, result: "changed", detail: "raced the cutoff", durationMs: 119_999, time: "11:58:00" },
      ] },
      "/api/transcript?role=clean&n=200": { lines: ["── run 3", "→ npm test"] },
    },
  });
  t.scope.toggleRole("clean");
  await flush();

  const actions = t.paintedFor("draweractions");
  assert.match(actions, /data-action='prompt'/);
  assert.match(actions, /data-action='abort'/);
  assert.match(actions, /Stop this run/);
  assert.match(actions, /btn-danger/);
  assert.match(actions, /data-action='pause'/);
  assert.match(actions, /data-action='pause-for'/);
  assert.match(actions, /data-action='reset-counters'/);
  assert.doesNotMatch(actions, /data-action='resume'/);
  assert.doesNotMatch(actions, /data-action='wake-in'/, "a live role shows Abort, not a wake control");
  assert.match(actions, /<i:stop>/);

  const head = t.paintedFor("drawerhead");
  assert.match(head, /<pill blue:Working>/);
  assert.match(head, /clean/);
  assert.match(head, /<span class='muted'>phase detail<\/span>/);

  const meta = t.paintedFor("drawermeta");
  assert.match(meta, /Working on/);
  assert.match(meta, /Adding drawer tests/);
  assert.match(meta, /Merged<\/span> — did the thing/);
  assert.match(meta, /Tokens, this run<\/dt><dd title='12\.3k'>12\.3k</);
  assert.match(meta, /Peak context, this run<\/dt><dd title='90\.0k'>90\.0k</);
  assert.match(meta, /Spent today<\/dt><dd title='\$1\.50'>\$1\.50</);
  assert.match(meta, /1m ago/); // the last run's age, through the real fmtAgo
  // A role with no lastMergedAt reports never merged in its drawer kv.
  assert.match(meta, /Last merged<\/dt><dd title='never'>never</);
  // The fetched run rows render with the real result/age/span formatters.
  assert.match(meta, /#3 · /);
  assert.match(meta, /tidied the drawer/);
  assert.match(meta, /2m ago/);
  assert.match(meta, />65s</); // fmtSpan(65_000)
  assert.match(meta, />2m</); // fmtSpan(119_999) rounds into the minute arm, never "120s"

  // The transcript rendered through transcriptHtml and pinned to the bottom.
  const pre = t.el("transcript");
  assert.match(pre.innerHTML, /<span class='l-sep'>── run 3<\/span>/);
  assert.match(pre.innerHTML, /<span class='l-tool'>→ npm test<\/span>/);
  assert.equal(pre.scrollTop, pre.scrollHeight);
});

// Part 3c/… — the drawer's `Peak context` row prints the payload's preformatted share label
// when the role resolves a declared window (`90.0k (70%)`), and keeps the bare peak from its
// own fmtTokens when the payload carries none — so the dashboard shows how close a run came to
// pi's compaction point without re-resolving the window.
test("the drawer's Peak context row reads a declared window's share label", async () => {
  const status = workingStatus() as unknown as { roles: Array<Record<string, unknown>> };
  const labelled = { ...status, roles: [{ ...status.roles[0], peakCtxLabel: "90.0k (70%)" }] };
  const t = openDrawer(["toggleRole"], { status: labelled as never });
  t.scope.toggleRole("clean");
  const meta = t.paintedFor("drawermeta");
  assert.match(meta, /Peak context, this run<\/dt><dd title='90\.0k \(70%\)'>90\.0k \(70%\)</);

  // Without a label the drawer keeps the bare fmtTokens peak (the existing behavior).
  const bare = openDrawer(["toggleRole"], { status: workingStatus() });
  bare.scope.toggleRole("clean");
  const bareMeta = bare.paintedFor("drawermeta");
  assert.match(bareMeta, /Peak context, this run<\/dt><dd title='90\.0k'>90\.0k</);
});

test("the role drawer shows a two-click Disable on an enabled role and none on the director", async () => {
  // An enabled non-director role carries a Disable button in its action row.
  const enabled = openDrawer(["toggleRole"], { status: workingStatus() });
  enabled.scope.toggleRole("clean");
  await flush();
  const actions = enabled.paintedFor("draweractions");
  assert.match(actions, /data-action='disable'/);
  assert.match(actions, /Disable/);
  assert.match(actions, /btn-danger/);
  // With the confirm armed, the first-clicked button reads the confirm label.
  const armed = openDrawer(["toggleRole"], {
    status: workingStatus(),
    overrides: { disableConfirming: () => true },
  });
  armed.scope.toggleRole("clean");
  await flush();
  assert.match(armed.paintedFor("draweractions"), /Click again to disable/);
  // The director cannot be disabled, so its drawer shows no Disable button.
  const directorStatus = workingStatus();
  directorStatus.roles[0]!.role = "director";
  const dir = openDrawer(["toggleRole"], { status: directorStatus });
  dir.scope.toggleRole("director");
  await flush();
  const dirActions = dir.paintedFor("draweractions");
  assert.doesNotMatch(dirActions, /data-action='disable'/);
  assert.doesNotMatch(dirActions, /Disable/);
});

test("loadRoleRuns throttles repeat polls to one fetch per 5 s unless forced, and skips when closed", async () => {
  const t = openDrawer(["toggleRole", "loadRoleRuns"], { status: workingStatus() });
  t.scope.toggleRole("clean");
  await flush();
  const historyCalls = () => t.jsonCalls.filter((p) => p === "/api/history?n=8&role=clean").length;
  const afterOpen = historyCalls(); // openRole's own force=true load
  assert.ok(afterOpen >= 1);

  await t.scope.loadRoleRuns(false);
  assert.equal(historyCalls(), afterOpen); // inside the 5 s window: throttled
  await t.scope.loadRoleRuns(true);
  assert.equal(historyCalls(), afterOpen + 1); // force bypasses the window

  t.scope.toggleRole("clean"); // closed: no role to load for
  await t.scope.loadRoleRuns(true);
  assert.equal(historyCalls(), afterOpen + 1);
});

test("a stale backlog response for a since-replaced entry is ignored", async () => {
  const deferred: Array<{ path: string; resolve: (v: unknown) => void }> = [];
  const t = openDrawer(["toggleEntry", "openEntryKey"], {
    status: { roles: [] },
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
  assert.match(t.paintedFor("entrybody"), /data-act='entry-cancel' data-arg='plans:1'/);
});

test("the entry drawer offers Release this entry only on a refused entry", async () => {
  const t = openDrawer(["toggleEntry"], {
    status: { roles: [] },
    responses: {
      "/api/backlog?file=plans&index=0": { title: "Held", body: "**Refused 2026-10-16 by feature: x**", refused: true },
      "/api/backlog?file=plans&index=1": { title: "Open", body: "body", refused: false },
      "/api/backlog?file=plans&index=2": { title: "NeedsReview", body: "**Needs review 2026-10-16 by feature: x**", refused: false },
      "/api/backlog?file=plans&index=3": { title: "HeldForOperator", body: "**Needs review 2026-10-16 by feature: x (held 3)**", refused: false, heldForOperator: true },
    },
  });
  t.scope.toggleEntry("plans", 0);
  await flush();
  assert.match(t.paintedFor("entrybody"), /data-act='entry-release' data-arg='plans:0'/);
  t.scope.toggleEntry("plans", 2);
  await flush();
  assert.doesNotMatch(t.paintedFor("entrybody"), /entry-release/);
  t.scope.toggleEntry("plans", 3);
  await flush();
  assert.doesNotMatch(t.paintedFor("entrybody"), /entry-release/);
  t.scope.toggleEntry("plans", 1);
  await flush();
  assert.doesNotMatch(t.paintedFor("entrybody"), /entry-release/);
});

test("a done plan or fixed bug entry opens read-only with its kind and body", async () => {
  const t = openDrawer(["toggleEntry"], {
    status: { roles: [] },
    responses: {
      "/api/backlog?file=done&index=0": { title: "Shipped (done 2026-10-05)", body: "Did **it**.", refused: false },
      "/api/backlog?file=fixed&index=0": { title: "Squashed (fixed 2026-10-06)", body: "Cause.", refused: false },
    },
  });
  t.scope.toggleEntry("done", 0);
  await flush();
  assert.match(t.paintedFor("drawerhead"), /Done plan/);
  assert.match(t.paintedFor("entrybody"), /<md>Did \*\*it\*\*\.<\/md>/);
  assert.doesNotMatch(t.paintedFor("entrybody"), /data-act='mention'|entry-edit|entry-cancel|entry-top|entry-release|drawer-actions/);
  t.scope.toggleEntry("fixed", 0);
  await flush();
  assert.match(t.paintedFor("drawerhead"), /Fixed bug/);
});

test("an answered question entry opens read-only with its kind and body", async () => {
  const t = openDrawer(["toggleEntry"], {
    status: { roles: [] },
    responses: {
      "/api/backlog?file=answered&index=0": { title: "Which?", body: "Context.\n\n**Answered 2026-10-05: A**", refused: false },
    },
  });
  t.scope.toggleEntry("answered", 0);
  await flush();
  assert.match(t.paintedFor("drawerhead"), /Answered question/);
  assert.match(t.paintedFor("entrybody"), /<md>Context\./);
  assert.doesNotMatch(t.paintedFor("entrybody"), /answertext|answer-record|data-act='mention'|entry-edit|entry-cancel|entry-top|entry-release/);
});

test("the entry drawer offers Move to top on every plan entry but the first", async () => {
  const t = openDrawer(["toggleEntry"], {
    status: { roles: [] },
    responses: {
      "/api/backlog?file=plans&index=0": { title: "A", body: "body", refused: false },
      "/api/backlog?file=plans&index=1": { title: "B", body: "body", refused: false },
    },
  });
  t.scope.toggleEntry("plans", 1);
  await flush();
  assert.match(t.paintedFor("entrybody"), /data-act='entry-top' data-arg='plans:1'/);
  t.scope.toggleEntry("plans", 0);
  await flush();
  assert.doesNotMatch(t.paintedFor("entrybody"), /entry-top/);
});

test("an open question entry offers the composer's answer action, an empty body says so", async () => {
  const t = openDrawer(["toggleEntry"], {
    status: { roles: [] },
    responses: { "/api/backlog?file=questions&index=2": { title: "Which backend?", body: "" } },
  });
  t.scope.toggleEntry("questions", 2);
  await flush();
  assert.match(t.paintedFor("drawerhead"), /Open question/);
  assert.match(t.paintedFor("entrybody"), /id='answertext'/);
  assert.match(t.paintedFor("entrybody"), /data-act='answer-record' data-arg='2'/);
  assert.match(t.paintedFor("entrybody"), /data-act='answer' data-arg='2'/);
  assert.match(t.paintedFor("entrybody"), /No details for this entry\./);
  assert.doesNotMatch(t.paintedFor("entrybody"), /entry-cancel/);
});

test("closing the drawer silences refreshDrawer", async () => {
  const t = openDrawer(["toggleEntry", "refreshDrawer"], {
    status: { roles: [] },
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

test("mergeSummary picks the held change for a role, in both in-flight shapes, and stays empty otherwise", () => {
  const t = openDrawer(["mergeSummary"]);
  const single = { mergeQueue: { inFlight: { role: "clean", summary: "Sole change" } } };
  assert.equal(t.scope.mergeSummary(single, "clean"), "Sole change");
  assert.equal(t.scope.mergeSummary(single, "other"), "");
  const batch = { mergeQueue: { inFlight: { changes: [{ role: "a", summary: "A" }, { role: "b", summary: "B" }] } } };
  assert.equal(t.scope.mergeSummary(batch, "b"), "B");
  assert.equal(t.scope.mergeSummary(batch, "c"), "");
  assert.equal(t.scope.mergeSummary({}, "a"), "");
  assert.equal(t.scope.mergeSummary({ mergeQueue: { inFlight: { changes: [{ role: "a", summary: "" }] } } }, "a"), "");
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
  assert.match(t.scope.drawerChangeHtml({ state: "absent" }), /No workspace yet/);
  assert.match(t.scope.drawerChangeHtml({ state: "no-base", mainBranch: "ghost" }), /Main branch ghost/);
  assert.match(t.scope.drawerChangeHtml({ state: "ready", ahead: 0, commits: [], dirtyFiles: [] }), /No unlanded work/);
  assert.match(t.scope.drawerChangeHtml(null), /unavailable/);
  assert.match(t.scope.drawerChangeHtml({}), /No unlanded work/);
});

test("overlapDetailHtml paints each role's path-scoped change, loading, and error rows", () => {
  const t = openDrawer(["overlapDetailHtml", "drawerChangeHtml"]);
  const html = t.scope.overlapDetailHtml([
    { role: "feature-2", state: "ok", view: { state: "ready", path: "src/a.ts", mainBranch: "main", ahead: 2, commits: [], dirtyFiles: [] } },
    { role: "qa", state: "ok", view: {
      state: "ready", path: "src/a.ts", branch: "tumwater/qa", mainBranch: "main", ahead: 1,
      commits: [{ sha: "abc12345", subject: "touch a" }], diff: "diff --git a/src/a.ts b/src/a.ts\n+line\n", dirtyFiles: [],
    } },
    { role: "clean", state: "error", message: "<boom>" },
    { role: "docs", state: "loading" },
  ]);
  assert.match(html, /<h3 class='mono'>feature #2<\/h3>/);
  assert.match(html, /No pending change to src\/a\.ts\./);
  assert.match(html, /limited to src\/a\.ts/);
  assert.match(html, /diff --git a\/src\/a\.ts/);
  assert.match(html, /&lt;boom&gt;/);
  assert.match(html, /Loading…/);
});

test("transcriptHtml classifies run separators, tool calls, thinking, and warnings, escaping each line", () => {
  const t = openDrawer(["transcriptHtml"]);
  assert.equal(
    t.scope.transcriptHtml(["── run 3", "→ npm test", "· thinking out loud", "⚠ retrying", "plain <line>"]),
    "<span class='l-sep'>── run 3</span>\n" +
    "<span class='l-tool'>→ npm test</span>\n" +
    "<span class='l-think'>· thinking out loud</span>\n" +
    "<span class='l-warn'>⚠ retrying</span>\n" +
    "plain &lt;line&gt;",
  );
  // The blank line separates runs, but never before the first line.
  assert.equal(t.scope.transcriptHtml(["── a"]), "<span class='l-sep'>── a</span>");
});

test("a role with no notes or queued prompt shows the placeholder lines", async () => {
  const t = openDrawer(["toggleRole"], { status: workingStatus() });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<h3>Notes<\/h3>/);
  assert.match(role, /No notes yet\./);
  assert.match(role, /<summary>Next run's prompt<\/summary>/);
  assert.match(role, /Nothing to run \(empty inbox\)\./);
});

test("the drawer's Notes section names when the note was last saved, and a note-less role adds no age line", async () => {
  const t = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: "a stale note", nextPrompt: null, noteSavedAt: Date.now() - 6 * 60_000 } },
  });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /a stale note/);
  assert.match(role, /Last saved /);
  assert.match(role, /ago/);

  // A note-less payload (no noteSavedAt) still shows only the placeholder, no age line.
  const t2 = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null } },
  });
  t2.scope.toggleRole("clean");
  await flush();
  const role2 = t2.paintedFor("drawerrole");
  assert.match(role2, /No notes yet\./);
  assert.doesNotMatch(role2, /Last saved/);
});

test("the role drawer renders its notes and next prompt, refetching when the drawer switches roles", async () => {
  const statusRow = (role: string) => ({
    role, phase: "sleeping", inFlight: false, currentWork: "", lastResult: "changed", lastSummary: "x",
    lastRunEndedAt: Date.now() - 60_000, commits: 1, runs: 2, generated: 100, peakCtx: 100,
    todayUsd: 0, costUsd: 0, nextRunAt: Date.now() + 30_000, yieldMultiplier: 1, backoffSeconds: 0,
  });
  const t = openDrawer(["toggleRole", "renderRoleDrawer"], {
    status: { running: true, pausedRoles: [], pausedLoops: [], roles: [statusRow("clean"), statusRow("bugfix")] }, // retired-name-ok: serialized /api key
    responses: {
      "/api/role?role=clean": { notes: "clean keeps the tree tidy", nextPrompt: "the clean next prompt" },
      "/api/role?role=bugfix": { notes: "bugfix watches the open bugs", nextPrompt: "the bugfix next prompt" },
    },
  });
  t.scope.toggleRole("clean");
  await flush();
  const first = t.paintedFor("drawerrole");
  assert.match(first, /clean keeps the tree tidy/);
  assert.match(first, /the clean next prompt/);

  // A status poll rewrites drawermeta (its run-age text changes) but must not repaint
  // drawerrole: an innerHTML rewrite would collapse an opened Next run's prompt.
  const rolePaints = t.painted.filter(([id]) => id === "drawerrole").length;
  const metaPaints = t.painted.filter(([id]) => id === "drawermeta").length;
  const older = statusRow("clean");
  older.lastRunEndedAt -= 5_000;
  const polled = { running: true, pausedRoles: [], pausedLoops: [], roles: [older, statusRow("bugfix")] }; // retired-name-ok: serialized /api key
  t.scope.renderRoleDrawer(polled);
  assert.ok(t.painted.filter(([id]) => id === "drawermeta").length > metaPaints, "drawermeta repaints on the poll");
  assert.equal(t.painted.filter(([id]) => id === "drawerrole").length, rolePaints, "drawerrole is not repainted");

  // Switching refetches the new role's payload rather than leaving the first role's text cached.
  t.scope.toggleRole("bugfix");
  await flush();
  const second = t.paintedFor("drawerrole");
  assert.match(second, /bugfix watches the open bugs/);
  assert.match(second, /the bugfix next prompt/);
  assert.doesNotMatch(second, /clean keeps the tree tidy/);
});

test("the drawer's Notes section offers Edit and Clear with a note, Edit alone without, and an edit holds its captured text", async () => {
  const responses: Record<string, unknown> = { "/api/role?role=clean": { notes: "first note", nextPrompt: null } };
  const t = openDrawer(["toggleRole", "renderRoleDrawer", "startNoteEdit", "stopNoteEdit", "loadDrawerRole"], { status: workingStatus(), responses });
  t.scope.toggleRole("clean");
  await flush();
  let role = t.paintedFor("drawerrole");
  assert.match(role, /data-act='note-edit' data-arg='clean'/);
  assert.match(role, /data-act='note-clear' data-arg='clean'/);

  // Editing shows the captured text in a textarea; a changed payload leaves the panel alone.
  t.scope.startNoteEdit("clean", "first note");
  role = t.paintedFor("drawerrole");
  assert.match(role, /<textarea id='noteedittext' rows='12'[^>]*>first note<\/textarea>/);
  assert.match(role, /data-act='note-save'/);
  assert.match(role, /data-act='note-discard'/);
  const paints = t.painted.filter(([id]) => id === "drawerrole").length;
  responses["/api/role?role=clean"] = { notes: "someone else's note", nextPrompt: null };
  await t.scope.loadDrawerRole("clean");
  t.scope.renderRoleDrawer(workingStatus());
  assert.equal(t.paintedFor("drawerrole"), role);
  assert.ok(t.painted.filter(([id]) => id === "drawerrole").length >= paints);
  assert.doesNotMatch(t.paintedFor("drawerrole"), /someone else/);

  // Discarding returns to the (refetched) note view.
  t.scope.stopNoteEdit();
  assert.match(t.paintedFor("drawerrole"), /someone else&#39;s note/);

  // No notes: Edit only.
  responses["/api/role?role=clean"] = { notes: null, nextPrompt: null };
  await t.scope.loadDrawerRole("clean");
  role = t.paintedFor("drawerrole");
  assert.match(role, /data-act='note-edit'/);
  assert.doesNotMatch(role, /note-clear/);
});

// Recent run outcomes (the `tumwater role <id>` section) ripple into the role drawer's
// role panel: the payload's recentOutcomes render as a Recent outcomes list with each
// outcome's relative age, result label, summary, and duration.
test("the role drawer shows the recent run outcomes from the role payload", async () => {
  const now = Date.now();
  const responses: Record<string, unknown> = {
    "/api/role?role=clean": {
      notes: null,
      nextPrompt: null,
      recentOutcomes: [
        { ts: now - 60_000, result: "changed", durationMs: 30_000, summary: "added a thing" },
        { ts: now - 120_000, result: "no_change", summary: "nothing to do" },
      ],
    },
  };
  const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<h3>Recent outcomes/);
  assert.match(role, /Merged/); // result "changed" renders as its labeled word
  assert.match(role, /added a thing/);
  assert.match(role, /30s/); // the duration span
  assert.match(role, /No change/); // result "no_change"
  assert.match(role, /nothing to do/);
});

test("a role with no recent outcomes shows no Recent outcomes section", async () => {
  const t = openDrawer(["toggleRole"], { status: workingStatus() });
  t.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(t.paintedFor("drawerrole"), /Recent outcomes/);
});

// The qa flow-coverage ledger (rolePayload's flowCoverage) ripples into the role drawer like
// the recent run outcomes: a Flow coverage section naming each flow's last exercise and result.
test("the drawer renders the qa flow coverage and shows none without it", async () => {
  const t = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: {
      "/api/role?role=qa": {
        notes: null,
        nextPrompt: null,
        flowCoverage: [
          { flow: "init", lastRunAt: Date.now() - 5 * 60_000, result: "passed" },
          { flow: "gui", lastRunAt: null, result: null },
          { flow: "review", lastRunAt: Date.now() - 60_000, result: "bug", summary: "<id> & \"quoted\"" },
        ],
      },
    },
  });
  t.scope.toggleRole("qa");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<h3>Flow coverage/);
  assert.match(role, /init/);
  assert.match(role, /gui.*never exercised/);
  // A bug summary is escaped exactly once: the literal &lt;id&gt; (not &amp;lt;id&amp;gt;).
  assert.match(role, /&lt;id&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(role, /&amp;lt;id/);

  // A payload without flowCoverage (the existing notes/prompt cases) renders no such section.
  const t2 = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: "a note", nextPrompt: null } },
  });
  t2.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(t2.paintedFor("drawerrole"), /Flow coverage/);
});

// The feedback observer's per-install filing ledger (rolePayload's filings) ripples into the
// role drawer like the qa flow coverage: a Filings section naming each issue this install filed.
test("the drawer renders the feedback filings and shows none without them", async () => {
  const t = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: {
      "/api/role?role=feedback": {
        notes: null,
        nextPrompt: null,
        filings: [{ issue: 12, title: "post-review churn miscounted", filedAt: Date.now() - 60_000 }],
      },
    },
  });
  t.scope.toggleRole("feedback");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /Filings/);
  assert.match(role, /#12 post-review churn miscounted/);

  // A payload without filings (the existing notes/prompt cases) renders no such section.
  const t2 = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: "a note", nextPrompt: null } },
  });
  t2.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(t2.paintedFor("drawerrole"), /Filings/);
});

// The role drawer's Configuration section mirrors `tumwater role <id>`'s field labels and
// wording family from the same /api/role payload (rolePayload), so the page and the CLI read
// one role's configuration identically: model/tier, provider cap, image reading (with the
// reroute target), budget fallback pair, billing, min run interval, queued
// prompts, and the clamped instructions/find text. Absent fields render no row, so a
// cap-less or notes-only payload keeps an empty section.
test("the role drawer renders the Configuration section from the role payload", async () => {
  const responses: Record<string, unknown> = {
    "/api/role?role=clean": {
      notes: null,
      nextPrompt: null,
      model: "deepseek/deepseek-v4",
      modelTier: "strong",
      imageInput: false,
      imageReroute: "strong (claude-opus-5-5)",
      fallback: { provider: "omlx", model: "Qwen3.8" },
      fallbackFree: true,
      billing: "subscription",
      billingWindow: "five_hour",
      minRunIntervalSeconds: 30,
      inboxCount: 4,
      instructions: "say the version on every reply\nkeep it short",
      find: "look for redundant code",
    },
  };
  const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<h3>Configuration<\/h3>/);
  assert.match(role, /<dt>Model<\/dt><dd[^>]*>deepseek\/deepseek-v4 \(strong tier\)<\/dd>/);
  assert.match(role, /<dt>Images<\/dt><dd[^>]*>no — reruns on strong \(claude-opus-5-5\)<\/dd>/);
  assert.match(role, /<dt>Budget fallback<\/dt><dd[^>]*>omlx\/Qwen3\.8 \(free\)<\/dd>/);
  assert.match(role, /<dt>Billing<\/dt><dd[^>]*>subscription \(five_hour window\)<\/dd>/);
  assert.match(role, /<dt>Min run interval<\/dt><dd title='30s \(team default\)'>30s \(team default\)<button[^>]*data-act='interval-edit'[^>]*>Set interval<\/button><\/dd>/);
  assert.match(role, /<dt>Queued prompts<\/dt><dd[^>]*>4<\/dd>/);
  // Instructions and find text clamp to one line with the verbatim text in the tooltip; the
  // instructions row always renders an Edit button (the control below replaces the sentence).
  assert.match(role, /<dt>Instructions override<\/dt><dd title='say the version on every reply\nkeep it short'>say the version on every reply keep it short/);
  assert.match(role, /data-act='instructions-edit' data-arg='clean'>Edit<\/button>/);
  assert.match(role, /<dt>Find text<\/dt><dd title='look for redundant code'>look for redundant code<\/dd>/);
});

// The drawer's Configuration fallback row names a non-pi fallback's backend namespace the same
// way role-render's fallback line does (fallbackPairLabel), so the page and `tumwater role <id>`
// agree on which model a claude seam's budget fallback runs: a non-pi budget pair keeps its
// namespace exactly once even when the model id shares it.
test("the Configuration fallback row names a non-pi fallback's backend namespace", async () => {
  const responses: Record<string, unknown> = {
    "/api/role?role=clean": {
      notes: null,
      nextPrompt: null,
      model: "deepseek/deepseek-v4",
      modelTier: "strong",
      fallback: { backend: "claude", provider: "claude", model: "claude-haiku-5-5" },
      fallbackFree: true,
    },
  };
  const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<dt>Budget fallback<\/dt><dd[^>]*>claude\/claude-haiku-5-5 \(free\)<\/dd>/);
});

// Context-window visibility: the Configuration section names the resolved seam's declared
// window, guarded so an older payload that lacks the field renders no row.
test("the Configuration section names the resolved seam's context window", async () => {
  const mk = (extra: object) => openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, model: "pi/local", modelTier: "default", ...extra } },
  });

  const known = mk({ contextWindow: 65536 });
  known.scope.toggleRole("clean");
  await flush();
  assert.match(known.paintedFor("drawerrole"), /<dt>Context window<\/dt><dd[^>]*>65\.5k tokens<\/dd>/);

  const unknown = mk({ contextWindow: null });
  unknown.scope.toggleRole("clean");
  await flush();
  assert.match(unknown.paintedFor("drawerrole"), /<dt>Context window<\/dt><dd[^>]*>unknown<\/dd>/);

  // An older payload without the fields renders no Context window row.
  const legacy = mk({});
  legacy.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(legacy.paintedFor("drawerrole"), /Context window/);
});

test("the Configuration section names after-merge review only when the payload carries it", async () => {
  const mk = (extra: object) => openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, model: "pi/local", modelTier: "default", ...extra } },
  });

  const known = mk({ reviewEnabled: true, reviewedAfterMerge: true });
  known.scope.toggleRole("clean");
  await flush();
  assert.match(known.paintedFor("drawerrole"), /<dt>Review<\/dt><dd[^>]*>after merge/);
  assert.match(known.paintedFor("drawerrole"), /<button type='button' class='btn btn-sm' data-act='review-toggle' data-arg='clean'>Review before merge<\/button>/);

  // A before-merge role with the gate on still gets the row and the opposite button.
  const before = mk({ reviewEnabled: true });
  before.scope.toggleRole("clean");
  await flush();
  assert.match(before.paintedFor("drawerrole"), /<dt>Review<\/dt><dd[^>]*>before merge/);
  assert.match(before.paintedFor("drawerrole"), /data-act='review-toggle' data-arg='clean'>Review after merge<\/button>/);

  const absent = mk({});
  absent.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(absent.paintedFor("drawerrole"), /<dt>Review<\/dt>/);

  // The director shows no Review toggle — its membership can never be written
  // (validateConfig's review.afterMerge rule refuses it), so a rendered button could only ever
  // answer 400; the cap and quiet-hours rows carry the same director exemption.
  const directorStatus = workingStatus();
  directorStatus.roles[0]!.role = "director";
  const director = openDrawer(["toggleRole"], {
    status: directorStatus,
    responses: { "/api/role?role=director": { notes: null, nextPrompt: null, reviewEnabled: true, reviewedAfterMerge: true } },
  });
  director.scope.toggleRole("director");
  await flush();
  assert.doesNotMatch(director.paintedFor("drawerrole"), /<dt>Review<\/dt>/);
});

test("the Configuration section paints a Quiet hours own-window row and a read-only fleet row", async () => {
  const mk = (extra: object) => openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, model: "pi/default", modelTier: "default", minRunIntervalSeconds: 30, ...extra } },
  });
  const t = mk({ quietHours: [
    { scope: "role", window: "23:00-07:00", inWindow: true },
    { scope: "fleet", window: "12:00-13:00", inWindow: false },
  ] });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  // The own window is an always-shown editable row; the fleet window a read-only row.
  assert.match(role, /<dt>Quiet hours<\/dt><dd[^>]*>23:00-07:00 \(own window; holding now — quiet until 07:00\).*data-act='quiet-edit' data-arg='clean'>Edit<\/button>/);
  assert.match(role, /<dt>Quiet hours<\/dt><dd[^>]*>12:00-13:00 \(team window; not holding now\)<\/dd>/);
  // A payload with no quiet-hours entries still shows the own-window row ("no own window").
  const none = mk({});
  none.scope.toggleRole("clean");
  await flush();
  const noneRole = none.paintedFor("drawerrole");
  assert.match(noneRole, /<dt>Quiet hours<\/dt><dd[^>]*>no own window/);
  assert.match(noneRole, /data-act='quiet-edit' data-arg='clean'>Set quiet hours<\/button>/);
});

test("the quiet-hours own-window editor prefills the window and the director has no own-window row", async () => {
  const t = openDrawer(["toggleRole", "startQuietEdit", "stopQuietEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, inboxCount: 0, quietHours: [{ scope: "role", window: "23:00-07:00", inWindow: true }] } },
  });
  t.scope.toggleRole("clean");
  await flush();
  let role = t.paintedFor("drawerrole");
  assert.match(role, /data-act='quiet-edit' data-arg='clean'>Edit<\/button>/);
  // Editing swaps in an input prefilled with the current window plus Save/Discard.
  t.scope.startQuietEdit("clean", "23:00-07:00");
  role = t.paintedFor("drawerrole");
  assert.match(role, /<input id='quieteditinput' type='text' placeholder='23:00-07:00' value='23:00-07:00'>/);
  assert.match(role, /data-act='quiet-save' data-arg='clean'/);
  assert.match(role, /data-act='quiet-discard' data-arg='clean'/);
  // Discarding restores the sentence and button.
  t.scope.stopQuietEdit();
  role = t.paintedFor("drawerrole");
  assert.match(role, /data-act='quiet-edit' data-arg='clean'>Edit<\/button>/);
  assert.doesNotMatch(role, /quieteditinput/);

  // The director renders no own-window row (its fleet row stays), unlike a non-director role.
  const directorStatus = workingStatus();
  directorStatus.roles[0]!.role = "director";
  const dir = openDrawer(["toggleRole"], {
    status: directorStatus,
    responses: { "/api/role?role=director": { notes: null, nextPrompt: null, inboxCount: 0, quietHours: [{ scope: "fleet", window: "12:00-13:00", inWindow: false }] } },
  });
  dir.scope.toggleRole("director");
  await flush();
  const dirRole = dir.paintedFor("drawerrole");
  assert.doesNotMatch(dirRole, /data-act='quiet-edit'/);
  assert.match(dirRole, /<dt>Quiet hours<\/dt><dd[^>]*>12:00-13:00 \(team window; not holding now\)<\/dd>/);
});

test("the Configuration section omits absent fields (cap-less team, no fallback, image-\nyes, notes-only)", async () => {
  // A cap-less team carries no provider row; no fallbacks, no images-reroute.
  const partial = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": {
      notes: null, nextPrompt: null, model: "pi/default", modelTier: "default", imageInput: true,
    } },
  });
  partial.scope.toggleRole("clean");
  await flush();
  let role = partial.paintedFor("drawerrole");
  assert.match(role, /<dt>Images<\/dt><dd[^>]*>yes<\/dd>/);
  assert.doesNotMatch(role, /<dt>Provider<\/dt>/);
  assert.doesNotMatch(role, /Model fallback/);
  assert.doesNotMatch(role, /Budget fallback/);
  assert.doesNotMatch(role, /<dt>Billing<\/dt>/);
  assert.doesNotMatch(role, /Min run interval/);

  // A notes-only payload renders just the always-on Daily cap and Instructions rows — no

  // The Daily
  // cap row always renders for a non-director role (cap or not), so a bare payload still
  // shows a Configuration section built from that one row.
  const minimal = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: "a note", nextPrompt: null } },
  });
  minimal.scope.toggleRole("clean");
  await flush();
  const minimalRole = minimal.paintedFor("drawerrole");
  assert.match(minimalRole, /<h3>Configuration<\/h3>/);
  assert.match(minimalRole, /<dt>Daily cap<\/dt><dd[^>]*>no cap/);
  assert.doesNotMatch(minimalRole, /<dt>Model<\/dt>/);
});

// The role drawer's Spend row mirrors role-render.ts's Spend line from the same /api/role
// usage payload: how much the role burned over its retained event window. Present only when
// usage is non-zero on the payload; an absent or all-zero usage renders no Spend row.
test("the role drawer renders a Spend row from the role payload's usage", async () => {
  const responses: Record<string, unknown> = {
    "/api/role?role=clean": {
      notes: null,
      nextPrompt: null,
      inboxCount: 0,
      usage: { tokens: 12500, costUsd: 0.05, notionalCostUsd: 0.05 },
    },
  };
  const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<dt>Spend<\/dt><dd[^>]*>\$0\.05 · 12\.5k tokens · \$0\.05 notional<\/dd>/);

  // A zero notional omits the notional suffix.
  const noNotional = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, inboxCount: 0, usage: { tokens: 1200, costUsd: 0.01, notionalCostUsd: 0 } } },
  });
  noNotional.scope.toggleRole("clean");
  await flush();
  assert.match(noNotional.paintedFor("drawerrole"), /<dt>Spend<\/dt><dd[^>]*>\$0\.01 · 1200 tokens<\/dd>/);

  // No usage on the payload: no Spend row.
  const none = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, inboxCount: 0 } },
  });
  none.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(none.paintedFor("drawerrole"), /<dt>Spend<\/dt>/);
});

test("the role drawer always renders a Daily cap row for a non-director role, and the cap editor replaces it while editing", async () => {
  const withCap = openDrawer(["toggleRole", "startCapEdit", "stopCapEdit"], {
    status: workingStatus(),
    responses: {
      "/api/role?role=clean": {
        notes: null,
        nextPrompt: null,
        inboxCount: 0,
        dailyCap: { capUsd: 1, spentUsd: 1.2, over: true, roleIds: ["clean", "clean-2"] },
      },
    },
  });
  withCap.scope.toggleRole("clean");
  await flush();
  let role = withCap.paintedFor("drawerrole");
  // Cap present: the spend sentence and an Edit cap button — the alert's path's end.
  assert.match(role, /<dt>Daily cap<\/dt><dd[^>]*>\$1\.20 of \$1\.00 spent today \(holding now — no new runs until local midnight\) · shared by clean, clean-2/);
  assert.match(role, /data-act='cap-edit' data-arg='clean'>Edit cap<\/button>/);
  // Editing swaps in an input prefilled with the current cap plus Save/Discard.
  withCap.scope.startCapEdit("clean", 1);
  role = withCap.paintedFor("drawerrole");
  assert.match(role, /<input id='capeditinput' type='number' min='0' step='0.01' value='1'/);
  assert.match(role, /data-act='cap-save' data-arg='clean'/);
  assert.match(role, /data-act='cap-discard' data-arg='clean'/);
  // Discarding restores the sentence and button.
  withCap.scope.stopCapEdit();
  role = withCap.paintedFor("drawerrole");
  assert.match(role, /data-act='cap-edit' data-arg='clean'>Edit cap<\/button>/);
  assert.doesNotMatch(role, /capeditinput/);

  // No cap on the payload: the row shows "no cap" and a Set a cap button.
  const none = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, inboxCount: 0 } },
  });
  none.scope.toggleRole("clean");
  await flush();
  const noneRole = none.paintedFor("drawerrole");
  assert.match(noneRole, /<dt>Daily cap<\/dt><dd[^>]*>no cap/);
  assert.match(noneRole, /data-act='cap-edit' data-arg='clean'>Set a cap<\/button>/);

  // Under the cap with a forecast: the row appends · ~cap at HH:MM.
  const underCap = openDrawer(["toggleRole"], {
    status: workingStatus(),
    responses: {
      "/api/role?role=clean": {
        notes: null,
        nextPrompt: null,
        inboxCount: 0,
        dailyCap: { capUsd: 1, spentUsd: 0.6, over: false, roleIds: ["clean"] },
        dailyCapHitAt: new Date(2026, 9, 16, 20, 0, 0).getTime(),
      },
    },
  });
  underCap.scope.toggleRole("clean");
  await flush();
  const underRole = underCap.paintedFor("drawerrole");
  assert.match(underRole, /<dt>Daily cap<\/dt><dd[^>]*>\$0\.60 of \$1\.00 spent today \(not holding\) · ~cap at 20:00/);

  // The director shows no cap row.
  const directorStatus = workingStatus();
  directorStatus.roles[0]!.role = "director";
  const dir = openDrawer(["toggleRole"], {
    status: directorStatus,
    responses: {
      "/api/role?role=director": { notes: null, nextPrompt: null, inboxCount: 0, dailyCap: { capUsd: 1, spentUsd: 0, over: false } },
    },
  });
  dir.scope.toggleRole("director");
  await flush();
  assert.doesNotMatch(dir.paintedFor("drawerrole"), /Daily cap/);
});

// The standing-instructions row always renders for every role (override or not) because its
// Edit/Save control is how the director-s and instance runs' instructions get written from
// the dashboard — the same always-shown rationale as the Daily cap row. Its editor prefills
// the current text, and a role with no override seeds an empty textarea so Save-with-empty
// clears.
test("the instructions row always renders and its editor prefills the override, seeded empty when none", async () => {
  const withInst = openDrawer(["toggleRole", "startInstructionsEdit", "stopInstructionsEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, inboxCount: 0, instructions: "Stay small.\nBe terse." } },
  });
  withInst.scope.toggleRole("clean");
  await flush();
  let role = withInst.paintedFor("drawerrole");
  // The override text is clamped with the verbatim text in the tooltip, plus an Edit button.
  assert.match(role, /<dt>Instructions override<\/dt><dd title='Stay small.\nBe terse.'>Stay small. Be terse./);
  assert.match(role, /data-act='instructions-edit' data-arg='clean'>Edit<\/button>/);
  // Editing swaps in a textarea prefilled with the override plus Save/Discard.
  withInst.scope.startInstructionsEdit("clean", "Stay small.\nBe terse.");
  role = withInst.paintedFor("drawerrole");
  assert.match(role, /<textarea id='instructionsedittext' rows='10' class='mono'/);
  assert.match(role, /data-act='instructions-save' data-arg='clean'/);
  assert.match(role, /data-act='instructions-discard' data-arg='clean'/);
  // Discarding restores the sentence and button.
  withInst.scope.stopInstructionsEdit();
  role = withInst.paintedFor("drawerrole");
  assert.match(role, /data-act='instructions-edit' data-arg='clean'>Edit<\/button>/);
  assert.doesNotMatch(role, /instructionsedittext/);

  // A role with no override still shows the row, its Edit control, and — once editing — an
  // empty textarea (so Save with an empty buffer clears).
  const none = openDrawer(["toggleRole", "startInstructionsEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, inboxCount: 0 } },
  });
  none.scope.toggleRole("clean");
  await flush();
  const noneRole = none.paintedFor("drawerrole");
  assert.match(noneRole, /<dt>Instructions override<\/dt><dd title=''>No standing instructions\./);
  assert.match(noneRole, /data-act='instructions-edit' data-arg='clean'>Edit<\/button>/);
  none.scope.startInstructionsEdit("clean", "");
  assert.match(none.paintedFor("drawerrole"), /<textarea id='instructionsedittext'[^>]*><\/textarea>/);
});

// The min run interval row renders for every role whose payload names an interval (always —
// the effective value is the role's override or the team default), tagging which it is, with
// a Set interval/Edit control to write the per-role override — the last per-role hold the
// drawer edits. Its editor prefills the override, seeded empty when none, so Save-with-empty
// clears.
test("the min run interval row tags override vs team default and its editor prefills the override", async () => {
  const withOv = openDrawer(["toggleRole", "startIntervalEdit", "stopIntervalEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, minRunIntervalSeconds: 300, minRunIntervalOverride: 300 } },
  });
  withOv.scope.toggleRole("clean");
  await flush();
  let role = withOv.paintedFor("drawerrole");
  // An override tags the body and shows an Edit control.
  assert.match(role, /<dt>Min run interval<\/dt><dd title='300s \(override\)'>300s \(override\)<button[^>]*data-act='interval-edit'[^>]*>Edit<\/button><\/dd>/);
  // Editing swaps in an input prefilled with the override plus Save/Discard.
  withOv.scope.startIntervalEdit("clean", 300);
  role = withOv.paintedFor("drawerrole");
  assert.match(role, /<input id='intervaleditinput' type='number' min='0' step='1' value='300'/);
  assert.match(role, /data-act='interval-save' data-arg='clean'/);
  assert.match(role, /data-act='interval-discard' data-arg='clean'/);
  // Discarding restores the sentence and button.
  withOv.scope.stopIntervalEdit();
  role = withOv.paintedFor("drawerrole");
  assert.match(role, /data-act='interval-edit' data-arg='clean'>Edit<\/button>/);
  assert.doesNotMatch(role, /intervaleditinput/);

  // A role with no override tags the team default and offers a Set interval control; once
  // editing, the input is seeded empty (so Save with an empty buffer clears).
  const none = openDrawer(["toggleRole", "startIntervalEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, minRunIntervalSeconds: 20 } },
  });
  none.scope.toggleRole("clean");
  await flush();
  const noneRole = none.paintedFor("drawerrole");
  assert.match(noneRole, /<dt>Min run interval<\/dt><dd title='20s \(team default\)'>20s \(team default\)<button[^>]*data-act='interval-edit'[^>]*>Set interval<\/button><\/dd>/);
  none.scope.startIntervalEdit("clean", "");
  assert.match(none.paintedFor("drawerrole"), /<input id='intervaleditinput'[^>]*value=''/);
});

// The Instances row is the parallel-runner count (roles.<base>.instances) — the last
// per-role hold the drawer edits. It renders only for a role that may split (its base,
// an instance strip, is feature or bugfix), reads the count from the role payload tagged
// `(set)` or falls back to 1 tagged `(default)`, and while open prefills an editor that
// survives a poll repaint.
test("the Instances row renders only for split-capable roles, tags set vs default, and prefills its editor", async () => {
  const splitStatus = (role: string) => {
    const now = Date.now();
    return {
      running: true, pausedRoles: [], pausedLoops: [], // retired-name-ok: serialized /api key
      roles: [{ role, phase: "working", inFlight: true, currentWork: "", lastResult: "", lastSummary: "",
        lastRunEndedAt: now - 60000, commits: 0, runs: 1, generated: 0, peakCtx: 0, todayUsd: 0, costUsd: 0,
        nextRunAt: now + 30000, yieldMultiplier: 1, backoffSeconds: 0 }],
    };
  };
  // With the count in the payload, the body reads `N (set)` and offers an Edit control.
  const withSet = openDrawer(["toggleRole", "startInstancesEdit", "stopInstancesEdit"], {
    status: splitStatus("feature"),
    responses: { "/api/role?role=feature": { notes: null, nextPrompt: null, instances: 3 } },
  });
  withSet.scope.toggleRole("feature");
  await flush();
  assert.match(withSet.paintedFor("drawerrole"), /<dt>Instances<\/dt><dd title='3 \(set\)'>3 \(set\)<button[^>]*data-act='instances-edit'[^>]*>Edit<\/button><\/dd>/);
  // Opening the editor seeds the count; the painted input survives a poll repaint.
  withSet.scope.startInstancesEdit("feature", 3);
  const editing = withSet.paintedFor("drawerrole");
  assert.match(editing, /<input id='instanceseditinput' type='number' min='1' max='8' step='1' value='3'/);
  assert.match(editing, /data-act='instances-save' data-arg='feature'/);
  assert.match(editing, /data-act='instances-discard' data-arg='feature'/);
  assert.equal(withSet.paintedFor("drawerrole"), editing, "an open edit repaints the same seeded input");
  withSet.scope.stopInstancesEdit();
  assert.match(withSet.paintedFor("drawerrole"), /data-act='instances-edit' data-arg='feature'>Edit<\/button>/);
  assert.doesNotMatch(withSet.paintedFor("drawerrole"), /instanceseditinput/);
  // An instance id splits too: its base strip is feature, so it renders the same row.
  const inst = openDrawer(["toggleRole"], {
    status: splitStatus("feature-2"),
    responses: { "/api/role?role=feature-2": { notes: null, nextPrompt: null, instances: 4 } },
  });
  inst.scope.toggleRole("feature-2");
  await flush();
  assert.match(inst.paintedFor("drawerrole"), /<dt>Instances<\/dt><dd title='4 \(set\)'>4 \(set\)<button[^>]*data-act='instances-edit'[^>]*>Edit<\/button><\/dd>/);
  // Without the count the body reads `1 (default)` and offers a Set instances control.
  const withDefault = openDrawer(["toggleRole"], {
    status: splitStatus("feature"),
    responses: { "/api/role?role=feature": { notes: null, nextPrompt: null } },
  });
  withDefault.scope.toggleRole("feature");
  await flush();
  assert.match(withDefault.paintedFor("drawerrole"), /<dt>Instances<\/dt><dd title='1 \(default\)'>1 \(default\)<button[^>]*data-act='instances-edit'[^>]*>Set instances<\/button><\/dd>/);
  // A role that cannot split (steward/director) renders no Instances row at all.
  for (const r of ["steward", "director"]) {
    const t = openDrawer(["toggleRole"], {
      status: splitStatus(r),
      responses: { [`/api/role?role=${r}`]: { notes: null, nextPrompt: null, instances: 3 } },
    });
    t.scope.toggleRole(r);
    await flush();
    assert.doesNotMatch(t.paintedFor("drawerrole"), /<dt>Instances<\/dt>/);
  }
});

// A default pi team runs on pi's own saved default model: rolePayload sets `piDefault`
// (a formatted selector) and leaves `provider`/`model` undefined, and the CLI's role view
// names that default in its Model line (modelLine's `pi default (…)` branch). The
// Configuration section must render the same model for such a role, so the page and
// `tumwater role <id>` agree on what the role runs on even in the no-explicit-model case.
test("the Configuration Model row names pi's saved default when no explicit model is set", async () => {
  const responses: Record<string, unknown> = {
    "/api/role?role=clean": {
      notes: null,
      nextPrompt: null,
      backend: "pi",
      piDefault: "deepseek/deepseek-v4",
      modelTier: "default",
    },
  };
  const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
  t.scope.toggleRole("clean");
  await flush();
  const role = t.paintedFor("drawerrole");
  assert.match(role, /<h3>Configuration<\/h3>/);
  assert.match(role, /<dt>Model<\/dt><dd[^>]*>pi default \(deepseek\/deepseek-v4\) \(default tier\)<\/dd>/);
});

// A seam that resolves neither half — an opencode role with no `model` (BACKEND_DEFAULT_MODELS
// .opencode is `{}`, so routeModel fills no default) or a pi role whose settings hold no
// readable default — carries no provider/model/piDefault. Like the CLI's `tumwater role <id>`
// Model line (modelLine's `<backend> default` branch), the drawer must still name the backend
// default so the page and the role view agree on what an unresolved role runs on.
test("the Configuration Model row names the backend default when no model resolves", async () => {
  for (const backend of ["opencode", "pi"]) {
    const responses: Record<string, unknown> = {
      "/api/role?role=clean": { notes: null, nextPrompt: null, backend, modelTier: "default" },
    };
    const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
    t.scope.toggleRole("clean");
    await flush();
    const role = t.paintedFor("drawerrole");
    assert.match(role, /<h3>Configuration<\/h3>/);
    assert.match(role, new RegExp(`<dt>Model</dt><dd[^>]*>${backend} default \\(default tier\\)</dd>`));
  }
});

// A resolved pair with a thinking level: role-render.ts's Model line appends
// ` (thinking: <level>)` whenever the payload carries `thinking` (no piDefault), and the
// drawer's Model row must carry the same suffix so the page and `tumwater role <id>` agree
// on what the role runs on. Pinned also for the piDefault branch (suffix must not double a
// selector that already embeds the level) and the no-thinking case (row unchanged).
test("the Configuration Model row names the resolved thinking level", async () => {
  const cases: Array<{ payload: Record<string, unknown>; expect: string }> = [
    // A resolved pair with a thinking level renders the same suffixed string role-render's
    // Model line produces, plus the tier suffix.
    {
      payload: { notes: null, nextPrompt: null, provider: "deepseek", model: "deepseek-v4", thinking: "high", modelTier: "strong" },
      expect: "deepseek/deepseek-v4 (thinking: high) (strong tier)",
    },
    // A piDefault selector already embeds its effective level, so the suffix is not doubled.
    {
      payload: { notes: null, nextPrompt: null, backend: "pi", piDefault: "deepseek/deepseek-v4", thinking: "high", modelTier: "default" },
      expect: "pi default (deepseek/deepseek-v4) (default tier)",
    },
    // No thinking level: the row renders exactly as before, whatever the pair.
    {
      payload: { notes: null, nextPrompt: null, provider: "deepseek", model: "deepseek-v4", modelTier: "strong" },
      expect: "deepseek/deepseek-v4 (strong tier)",
    },
  ];
  for (const c of cases) {
    const responses: Record<string, unknown> = { "/api/role?role=clean": c.payload };
    const t = openDrawer(["toggleRole"], { status: workingStatus(), responses });
    t.scope.toggleRole("clean");
    await flush();
    const role = t.paintedFor("drawerrole");
    assert.match(role, /<h3>Configuration<\/h3>/);
    const escaped = c.expect.replace(/[()]/g, (ch) => "\\" + ch);
    assert.match(role, new RegExp(`<dt>Model</dt><dd[^>]*>${escaped}</dd>`));
  }
});

// The Model overrides row (roles.<base>.*, rolePayload's providerOverride/modelOverride/
// thinkingOverride) is the one per-role write the read-only Model row leaves out — the
// dashboard half of the CLI's --provider/--model/--thinking. Always shown (every role), its
// body names the raw overrides or `no overrides`, and its editor prefills the three inputs
// from the payload's raw overrides.
test("the Model overrides row names the raw triple and its editor prefills the raw overrides", async () => {
  const withOv = openDrawer(["toggleRole", "startModelEdit", "stopModelEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, model: "claude/claude-opus-5", modelTier: "strong", providerOverride: "claude", modelOverride: "claude-opus-5", thinkingOverride: "high" } },
  });
  withOv.scope.toggleRole("clean");
  await flush();
  let role = withOv.paintedFor("drawerrole");
  // The body names the payload's raw overrides joined by ·, with an Edit control.
  assert.match(role, /<dt>Model overrides<\/dt><dd title='provider: claude · model: claude-opus-5 · thinking: high'>provider: claude · model: claude-opus-5 · thinking: high<button[^>]*data-act='model-edit'[^>]*>Edit<\/button><\/dd>/);
  // Editing swaps in three inputs prefilled with the raw overrides plus Save/Discard.
  withOv.scope.startModelEdit("clean", { provider: "claude", model: "claude-opus-5", thinking: "high", backend: "" });
  role = withOv.paintedFor("drawerrole");
  assert.match(role, /<input id='modeleditprovider'[^>]*value='claude'>/);
  assert.match(role, /<input id='modeleditmodel'[^>]*value='claude-opus-5'>/);
  assert.match(role, /<input id='modeleditthinking'[^>]*value='high'>/);
  assert.match(role, /data-act='model-save' data-arg='clean'/);
  assert.match(role, /data-act='model-discard' data-arg='clean'/);
  // Discarding restores the sentence and button.
  withOv.scope.stopModelEdit();
  role = withOv.paintedFor("drawerrole");
  assert.match(role, /data-act='model-edit' data-arg='clean'>Edit<\/button>/);
  assert.doesNotMatch(role, /modeleditprovider/);

  // A role with no raw overrides says `no overrides` and offers a Set model control; the
  // editor seeds empty inputs.
  const none = openDrawer(["toggleRole", "startModelEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, model: "pi/default", modelTier: "default" } },
  });
  none.scope.toggleRole("clean");
  await flush();
  const noneRole = none.paintedFor("drawerrole");
  assert.match(noneRole, /<dt>Model overrides<\/dt><dd title='no overrides'>no overrides<button[^>]*data-act='model-edit'[^>]*>Set model<\/button><\/dd>/);
  none.scope.startModelEdit("clean", { provider: "", model: "", thinking: "", backend: "" });
  assert.match(none.paintedFor("drawerrole"), /<input id='modeleditprovider'[^>]*value=''>/);
});

test("the Model overrides editor shows and saves the backend field", async () => {
  // A role with a backend override renders it in the body and prefills the backend input.
  const withBackend = openDrawer(["toggleRole", "startModelEdit"], {
    status: workingStatus(),
    responses: { "/api/role?role=clean": { notes: null, nextPrompt: null, model: "pi/default", modelTier: "default", providerOverride: "claude", backendOverride: "claude" } },
  });
  withBackend.scope.toggleRole("clean");
  await flush();
  const body = withBackend.paintedFor("drawerrole");
  assert.match(body, /<dt>Model overrides<\/dt><dd title='provider: claude · backend: claude'>provider: claude · backend: claude<button/);
  withBackend.scope.startModelEdit("clean", { provider: "claude", model: "", thinking: "", backend: "claude" });
  assert.match(withBackend.paintedFor("drawerrole"), /<input id='modeleditbackend'[^>]*value='claude'>/);
});

test("the drawer's Show prompts toggle swaps the transcript between plain and prompt lines", async () => {
  const t = openDrawer(["toggleRole", "toggleTranscriptPrompts"], {
    status: workingStatus(),
    responses: {
      "/api/transcript?role=clean&n=200": { lines: ["── run", "  plain-line"] },
      "/api/transcript?role=clean&n=200&prompt=1": { lines: ["── run", "  prompt-line", "  plain-line"] },
    },
  });
  t.scope.toggleRole("clean");
  await flush();
  assert.match(t.paintedFor("transcript"), /plain-line/);
  assert.doesNotMatch(t.paintedFor("transcript"), /prompt-line/);

  t.scope.toggleTranscriptPrompts();
  await flush();
  assert.match(t.paintedFor("transcript"), /prompt-line/);
  assert.equal(t.el("transcriptprompts").textContent, "Hide prompts");

  t.scope.toggleTranscriptPrompts();
  await flush();
  assert.doesNotMatch(t.paintedFor("transcript"), /prompt-line/);
  assert.equal(t.el("transcriptprompts").textContent, "Show prompts");

  // Reopening starts plain again, even after leaving prompts on.
  t.scope.toggleTranscriptPrompts();
  await flush();
  t.scope.toggleRole("clean");
  t.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(t.paintedFor("transcript"), /prompt-line/);
});

test("the role drawer lists the role's waiting merges between Last result and the stats", async () => {
  const now = Date.now();
  const status = {
    ...workingStatus(),
    mergeQueue: { depth: 2, entries: [
      { role: "bugfix", sha: "aaaaaaaa11", run: 1, summary: "other", enqueuedAt: now },
      { role: "clean", sha: "bbbbbbbb22", run: 5, summary: "drawer queue", enqueuedAt: now },
    ] },
    mergeQueueLabels: ["", ""],
  };
  const t = openDrawer(["toggleRole"], { status });
  t.scope.toggleRole("clean");
  await flush();
  const meta = t.paintedFor("drawermeta");
  assert.match(meta, /<h3>Merge queue<\/h3>/);
  assert.match(meta, /2\. clean run #5 · bbbbbbbb · .* · drawer queue/);
  assert.doesNotMatch(meta, /other/);
  assert.ok(meta.indexOf("Last result") < meta.indexOf("Merge queue") && meta.indexOf("Merge queue") < meta.indexOf("Commits"));

  const plain = openDrawer(["toggleRole"], { status: workingStatus() });
  plain.scope.toggleRole("clean");
  await flush();
  assert.doesNotMatch(plain.paintedFor("drawermeta"), /Merge queue/);
});

test("the transcript search box narrows the live transcript through &grep and resets per role", async () => {
  const t = openDrawer(["toggleRole", "setTranscriptGrep"], {
    status: workingStatus(),
    responses: {
      "/api/transcript?role=clean&n=200&grep=Leak": { lines: ["── run", "  found the Leak"] },
    },
  });
  t.scope.toggleRole("clean");
  await flush();
  t.scope.setTranscriptGrep("  Leak ");
  await flush();
  assert.ok(t.jsonCalls.some((p) => p.endsWith("&grep=Leak")));
  assert.match(t.paintedFor("transcript"), /found the Leak/);

  t.scope.setTranscriptGrep("");
  await flush();
  assert.equal(t.jsonCalls.at(-1)?.includes("&grep"), false);

  t.scope.setTranscriptGrep("Leak");
  t.scope.toggleRole("clean");
  t.scope.toggleRole("clean");
  await flush();
  assert.equal(t.jsonCalls.at(-1)?.includes("&grep"), false);
});

test("a transcript search with no match says so", async () => {
  const t = openDrawer(["toggleRole", "setTranscriptGrep"], {
    status: workingStatus(),
    responses: { "/api/transcript?role=clean&n=200&grep=nomatch": { lines: [] } },
  });
  t.scope.toggleRole("clean");
  await flush();
  t.scope.setTranscriptGrep("nomatch");
  await flush();
  assert.match(t.paintedFor("transcript"), /No transcript entries match .*nomatch/);
  t.scope.setTranscriptGrep("<b>");
  await flush();
  assert.match(t.paintedFor("transcript"), /&lt;b&gt;/);
  assert.doesNotMatch(t.paintedFor("transcript"), /<b>/);
});
