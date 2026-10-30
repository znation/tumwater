import test from "node:test";
import assert from "node:assert/strict";
import { clientScope } from "./helpers/gui-client-scope.js";

// The dashboard's view routing (src/ui/gui/gui-client-boot.ts's view-routing region): the
// #fragment-driven switchView/route pair the page's tabs, Back/Forward buttons, and
// #role/<role> drawer links all run through. The pattern test/gui-client.test.ts uses:
// clientScope runs the marked region with stand-ins for the DOM and the render helpers.

/** A fake DOM element good enough for switchView: hidden, classList, and the aria
 * attributes the tab toggling drives, each change recorded for the assertions. */
function fakeEl(log: string[], tag: string) {
  let hidden = true;
  return {
    get hidden() { return hidden; },
    set hidden(v: boolean) { hidden = v; log.push(`${tag} hidden=${v}`); },
    classList: { toggle(cls: string, on: boolean) { log.push(`${tag} ${cls}${on ? "+" : "-"}`); } },
    setAttribute(k: string, v: string) { log.push(`${tag} ${k}=${v}`); },
    removeAttribute(k: string) { log.push(`${tag} -${k}`); },
  };
}

/** A scope over the view-routing region with every section and tab pre-built, so the
 * assertions read the elements' final state. */
function bootScope(inject: Record<string, unknown>, log: string[]) {
  const els: Record<string, ReturnType<typeof fakeEl>> = {};
  for (const id of ["team-view", "history", "report", "failures", "pending", "settings-view", "tab-team", "tab-history", "tab-usage", "tab-failures", "tab-pending", "tab-settings"]) {
    els[id] = fakeEl(log, id);
  }
  return clientScope<{ switchView(v: string): void; route(): void; openRoleId(): string | null }>(
    ["view-routing"], ["switchView", "route", "openRoleId"],
    { $: (id: string) => els[id], openRoleId: () => null, ...inject },
  );
}

test("switchView shows one view's section, marks its tab, and refetches that view's data", () => {
  const log: string[] = [];
  const calls: string[] = [];
  const scope = bootScope({
    lastStatus: { roles: [] },
    renderTeam: () => calls.push("renderTeam"),
    fetchHistory: () => calls.push("fetchHistory"),
    fetchReport: () => calls.push("fetchReport"),
    fetchFailures: () => calls.push("fetchFailures"),
    fetchPending: () => calls.push("fetchPending"),
  }, log);

  scope.switchView("history");
  // Only the history section is visible, and only its tab carries the active mark —
  // the others are hidden and lose any stale aria-current from a previous view.
  assert.equal(log.filter((l) => l.startsWith("history ")).join("|"), "history hidden=false");
  assert.equal(log.filter((l) => l.startsWith("team-view ")).join("|"), "team-view hidden=true");
  assert.equal(log.filter((l) => l.startsWith("tab-history ")).join("|"), "tab-history active+|tab-history aria-current=page");
  assert.equal(log.filter((l) => l.startsWith("tab-team ")).join("|"), "tab-team active-|tab-team -aria-current");
  // The view's own fetch ran, and no other view's did.
  assert.deepEqual(calls, ["fetchHistory"]);

  // A different view swaps the visible section and fetches its own source.
  calls.length = 0;
  log.length = 0;
  scope.switchView("usage");
  assert.equal(log.filter((l) => l.startsWith("report ")).join("|"), "report hidden=false");
  assert.deepEqual(calls, ["fetchReport"]);

  // The Pending view routes like its siblings and marks its own tab.
  calls.length = 0;
  log.length = 0;
  scope.switchView("pending");
  assert.equal(log.filter((l) => l.startsWith("pending ")).join("|"), "pending hidden=false");
  assert.equal(log.filter((l) => l.startsWith("tab-pending ")).join("|"), "tab-pending active+|tab-pending aria-current=page");
  assert.deepEqual(calls, ["fetchPending"]);
});

test("switchView falls back to team for an unknown view and repaints team from the last status", () => {
  const log: string[] = [];
  const calls: string[] = [];
  const scope = bootScope({
    lastStatus: { roles: [] },
    renderTeam: (d: unknown) => calls.push("renderTeam " + JSON.stringify(d)),
    fetchHistory: () => calls.push("fetchHistory"),
  }, log);

  scope.switchView("bogus");
  // The unknown name became team: its section shows, its tab leads, and the last
  // status payload is what got painted (no fetch happens for the fallback).
  assert.equal(log.filter((l) => l.startsWith("team-view ")).join("|"), "team-view hidden=false");
  assert.equal(log.filter((l) => l.startsWith("tab-team ")).join("|"), "tab-team active+|tab-team aria-current=page");
  assert.deepEqual(calls, ["renderTeam {\"roles\":[]}"]);

  // With no status ever received, the fallback still routes but paints nothing —
  // the pre-poll boot state must not crash on a missing payload.
  const quietLog: string[] = [];
  const quiet = bootScope({ lastStatus: null, renderTeam: () => calls.push("renderTeam") }, quietLog);
  quiet.switchView("bogus");
  assert.equal(quietLog.filter((l) => l.startsWith("team-view ")).join("|"), "team-view hidden=false");
});

test("route follows #role/<role> into the drawer over team, and idempotently on re-route", () => {
  const log: string[] = [];
  const calls: string[] = [];
  let hash = "#role/feature";
  let openedRole: string | null = null;
  const scope = bootScope({
    location: { get hash() { return hash; } },
    lastStatus: { roles: [] },
    renderTeam: () => calls.push("renderTeam"),
    fetchHistory: () => calls.push("fetchHistory"),
    openRoleId: () => openedRole,
    openRole: (role: string) => { calls.push("openRole " + role); openedRole = role; },
  }, log);

  // A fresh load straight to #role/feature: team is shown behind the drawer and the
  // feature drawer opens.
  scope.route();
  assert.deepEqual(calls, ["renderTeam", "openRole feature"]);
  assert.equal(scope.openRoleId(), "feature");

  // A poll-driven re-route to the same role is a no-op: no rebuilt drawer (the live
  // transcript the reader is pinned to would reset) and no team re-render either.
  calls.length = 0;
  scope.route();
  assert.deepEqual(calls, [], "the already-open drawer is left alone");

  // Merge on a different role's link does open that drawer.
  hash = "#role/qa";
  scope.route();
  assert.deepEqual(calls, ["openRole qa"]);

  // A plain tab hash routes to that view (Back/Forward land here).
  hash = "#history";
  calls.length = 0;
  scope.route();
  assert.deepEqual(calls, ["fetchHistory"], "the history view fetched, team not re-painted");

  // A later #role route on an already-routed page must not force team back on.
  hash = "#role/feature";
  calls.length = 0;
  log.length = 0;
  scope.route();
  assert.deepEqual(calls, ["openRole feature"]);
  assert.deepEqual(log, [], "no view switch behind the drawer once routed — history stays visible");
});

test("route survives a malformed percent-escape in the fragment instead of aborting boot", () => {
  const log: string[] = [];
  const calls: string[] = [];
  const scope = bootScope({
    location: { hash: "#%" },
    lastStatus: { roles: [] },
    renderTeam: () => calls.push("renderTeam"),
    fetchHistory: () => calls.push("fetchHistory"),
  }, log);

  // decodeURIComponent("%") throws; the raw fragment is no known view, so routing falls back
  // to team. The assertion that matters is doesNotThrow: route() runs before pollLoop() at
  // boot, so a throw here would abort the served script and freeze the whole dashboard.
  assert.doesNotThrow(() => scope.route());
  assert.equal(log.filter((l) => l.startsWith("team-view ")).join("|"), "team-view hidden=false");
  assert.deepEqual(calls, ["renderTeam"]);
});

test("answer-record posts the trimmed answer for the Nth question, and nothing when empty", () => {
  const posts: unknown[] = [];
  const flashes: string[] = [];
  const mk = (value: string) => clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus: { questions: ["First", "Which backend? · asked by plan"] },
      $: () => ({ value }),
      showFlash: (m: string) => flashes.push(m),
      postAction: (path: string, body: unknown) => posts.push([path, body]),
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  mk("  use sqlite \n").runAct("answer-record", "1");
  assert.deepEqual(posts, [["/api/question-answer", { position: 2, title: "Which backend? · asked by plan", decision: "use sqlite" }]]);
  mk("   ").runAct("answer-record", "1");
  assert.equal(posts.length, 1);
  assert.deepEqual(flashes, ["Write an answer first"]);
});

test("the refused banner's backlog action opens the named file's tab and lands on its row", () => {
  const calls: string[] = [];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      activeView: "team",
      setBacklogTab: (t: string) => calls.push("tab " + t),
      toggleEntry: (f: string, i: number) => calls.push("entry " + f + ":" + i),
      $: () => ({ scrollIntoView: () => {} }),
    },
  );
  // The banner's refused alert now carries `file:index`; the action must switch the backlog
  // card to that file's tab and open the row there, rather than leave the card on its old tab.
  scope.runAct("backlog", "bugs:1");
  scope.runAct("backlog", "plans:0");
  // No target (legacy/defensive) keeps the old behavior: open the card on its current tab.
  scope.runAct("backlog", "");
  assert.deepEqual(calls, ["tab bugs", "entry bugs:1", "tab plans", "entry plans:0"]);
});

test("entry-cancel arms on the first click and posts the cancel on the second", () => {
  const posts: unknown[] = [];
  let armed = false;
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus: { plans: ["A", "B (planned 2026-10-12 by plan)"] },
      entryCancelArmed: () => armed,
      armEntryCancel: () => { armed = true; },
      disarmEntryCancel: () => { armed = false; },
      closeDrawer: () => {},
      postAction: (path: string, body: unknown) => posts.push([path, body]),
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  scope.runAct("entry-cancel", "plans:1");
  assert.deepEqual(posts, []);
  scope.runAct("entry-cancel", "plans:1");
  assert.deepEqual(posts, [["/api/backlog-cancel", { kind: "plan", position: 2, title: "B (planned 2026-10-12 by plan)" }]]);
  // Firing disarms: the next click on the same position only re-arms.
  scope.runAct("entry-cancel", "plans:1");
  assert.equal(posts.length, 1);
  scope.runAct("entry-cancel", "plans:7");
  assert.equal(posts.length, 1);
});

test("entry-release posts the release at once for plans and bugs", () => {
  const posts: unknown[] = [];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus: { plans: ["A", "B"], bugs: ["C"] },
      closeDrawer: () => {},
      postAction: (path: string, body: unknown) => posts.push([path, body]),
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  scope.runAct("entry-release", "plans:1");
  scope.runAct("entry-release", "bugs:0");
  assert.deepEqual(posts, [
    ["/api/backlog-release", { kind: "plan", position: 2, title: "B" }],
    ["/api/backlog-release", { kind: "bug", position: 1, title: "C" }],
  ]);
});

test("entry-release and entry-top toasts name a held entry instead of the role", () => {
  const cases: [string, string, string, string][] = [
    ["entry-release", "/api/backlog-release", "released", "will pick it up"],
    ["entry-top", "/api/backlog-top", "moved_to_top", "takes it next"],
  ];
  for (const [act, post, status, role] of cases) {
    const toast = (d: object): string => {
      let out = "";
      const scope = clientScope<{ runAct(a: string, b: string): void }>(
        ["run-act"], ["runAct"],
        {
          lastStatus: { plans: ["A"], bugs: [] },
          closeDrawer: () => {},
          postAction: (p: string, _body: unknown, cb: (d: object) => string) => {
            assert.equal(p, post);
            out = cb(d);
          },
          splitTitle: (t: string) => ({ title: t }),
          uncommittedTail: () => "",
        },
      );
      scope.runAct(act, "plans:0");
      return out;
    };
    const held = toast({ status, heldNote: "still held [blocked: needs review]: x", committed: true, lifted: "refused" });
    assert.ok(held.includes("still held [blocked: needs review]") && !held.includes(role));
    assert.ok(toast({ status, committed: true, lifted: "refused" }).includes(role));
  }
});

test("entry-top posts the reorder at once for plans and bugs", () => {
  const posts: unknown[] = [];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus: { plans: ["A", "B"], bugs: ["C"] },
      closeDrawer: () => {},
      postAction: (path: string, body: unknown) => posts.push([path, body]),
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  scope.runAct("entry-top", "plans:1");
  scope.runAct("entry-top", "bugs:0");
  assert.deepEqual(posts, [
    ["/api/backlog-top", { kind: "plan", position: 2, title: "B" }],
    ["/api/backlog-top", { kind: "bug", position: 1, title: "C" }],
  ]);
});

test("entry-cancel re-arms instead of firing when the entry at that position changed", () => {
  const posts: unknown[] = [];
  let armed: string | null = null;
  const status: { plans: string[] } = { plans: ["A", "B"] };
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus: status,
      entryCancelArmed: (_k: string, t: string) => armed === t,
      armEntryCancel: (_k: string, t: string) => { armed = t; },
      disarmEntryCancel: () => { armed = null; },
      closeDrawer: () => {},
      postAction: (path: string, body: unknown) => posts.push([path, body]),
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  scope.runAct("entry-cancel", "plans:1");
  status.plans = ["A", "C"];
  scope.runAct("entry-cancel", "plans:1");
  assert.deepEqual(posts, []);
  scope.runAct("entry-cancel", "plans:1");
  assert.equal(posts.length, 1);
});

test("entry-edit starts the form; entry-edit-save posts the edit unless the title is blank", () => {
  const posts: unknown[] = [];
  const flashes: string[] = [];
  const started: unknown[] = [];
  const boxes: Record<string, { value: string }> = { entryedittitle: { value: "  " }, entryeditbody: { value: "l1\n\nl2" } };
  const lastStatus: { plans: string[] } = { plans: ["A", "B (planned 2026-10-12 by plan)"] };
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus,
      entryEditing: { key: "plans:1", title: "B (planned 2026-10-12 by plan)" },
      $: (id: string) => boxes[id],
      startEntryEdit: (k: string, t: string) => started.push([k, t]),
      stopEntryEdit: () => {},
      refreshEntry: () => {},
      closeDrawer: () => {},
      showFlash: (m: string) => flashes.push(m),
      postAction: (path: string, body: unknown) => posts.push([path, body]),
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  scope.runAct("entry-edit", "plans:1");
  assert.deepEqual(started, [["plans:1", "B (planned 2026-10-12 by plan)"]]);
  scope.runAct("entry-edit-save", "plans:1");
  assert.deepEqual(posts, []);
  assert.deepEqual(flashes, ["Write a title first"]);
  boxes.entryedittitle!.value = " New ";
  // The list shifts while the form is open: the save still carries the captured title.
  lastStatus.plans = ["X", "A", "B (planned 2026-10-12 by plan)"];
  scope.runAct("entry-edit-save", "plans:1");
  assert.deepEqual(posts, [["/api/backlog-edit", { kind: "plan", position: 2, title: "B (planned 2026-10-12 by plan)", newTitle: "New", newBody: "l1\n\nl2" }]]);
});

test("note-save posts the textarea, note-clear needs a second click, note-discard posts nothing", () => {
  const posts: unknown[] = [];
  const events: string[] = [];
  let armed = false;
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "feature", state: "ok", view: { notes: "old" } },
      $: (id: string) => (id === "noteedittext" ? { value: "new\ntext" } : null),
      startNoteEdit: (r: string, t: string) => events.push(`edit ${r} ${t}`),
      stopNoteEdit: () => events.push("stop"),
      noteClearArmed: () => armed,
      armNoteClear: () => { armed = true; },
      disarmNoteClear: () => { armed = false; },
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => { posts.push([path, body]); events.push(done({ message: "notebook saved (8 bytes)" })); },
    },
  );
  scope.runAct("note-edit", "feature");
  assert.deepEqual(events, ["edit feature old"]);
  scope.runAct("note-discard", "feature");
  assert.deepEqual(posts, []);
  scope.runAct("note-clear", "feature");
  assert.deepEqual(posts, []);
  scope.runAct("note-clear", "feature");
  assert.deepEqual(posts, [["/api/role-notes", { role: "feature", text: "" }]]);
  scope.runAct("note-save", "feature");
  assert.deepEqual(posts[1], ["/api/role-notes", { role: "feature", text: "new\ntext" }]);
  assert.deepEqual(events.slice(-2), ["load feature", "notebook saved (8 bytes)"]);
});

test("cap-edit opens the cap editor, cap-save posts the parsed cap, cap-discard closes it, and an invalid field posts nothing", () => {
  const posts: unknown[] = [];
  let reply: unknown = {};
  const flashes: string[] = [];
  const events: string[] = [];
  const field = { value: "2", validity: { badInput: false } };
  const capState: { current: unknown } = { current: null };
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "clean", state: "ok", view: { dailyCap: { capUsd: 1 } } },
      $: (id: string) => (id === "capeditinput" ? field : null),
      startCapEdit: (r: string, v: number) => events.push(`edit ${r} ${v}`),
      stopCapEdit: () => events.push("stop"),
      capEditing: capState,
      showFlash: (m: string) => flashes.push(m),
      parseBudgetField: (raw: string) => {
        const t = String(raw).trim();
        const n = Number(t);
        if (t === "" || !Number.isFinite(n) || n < 0) return { ok: false, error: "the cap must be a number of 0 or more" };
        return { ok: true, value: n };
      },
      fmtCap: (n: number) => "$" + n.toFixed(2).replace(/\.00$/, ""),
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => {
        posts.push([path, body]);
        // postAction toasts the callback's message — record it as the flash.
        const msg = done(reply);
        flashes.push(msg);
        events.push(msg);
      },
    },
  );
  // cap-edit opens the editor with the current cap.
  scope.runAct("cap-edit", "clean");
  assert.deepEqual(events, ["edit clean 1"]);
  // cap-save posts the parsed value and flashes the set wording.
  scope.runAct("cap-save", "clean");
  assert.deepEqual(posts[0], ["/api/role-cap", { role: "clean", maxDailyCostUsd: 2 }]);
  assert.deepEqual(flashes, ["Daily cap set to $2"]);
  assert.deepEqual(events.slice(-2), ["load clean", "Daily cap set to $2"]);
  // A 0 value flashes the removed wording.
  field.value = "0";
  scope.runAct("cap-save", "clean");
  assert.deepEqual(posts[1], ["/api/role-cap", { role: "clean", maxDailyCostUsd: 0 }]);
  assert.deepEqual(flashes[1], "Daily cap removed");
  // A reply flagged unchanged flashes the no-op wording.
  reply = { unchanged: true };
  scope.runAct("cap-save", "clean");
  assert.equal(flashes[2], "Daily cap unchanged");
  reply = {};
  flashes.length = 2;
  // A non-numeric field flashes the parse error and posts nothing.
  flashes.length = 0;
  posts.length = 0;
  field.value = "abc";
  scope.runAct("cap-save", "clean");
  assert.deepEqual(posts, []);
  assert.deepEqual(flashes, ["error: the cap must be a number of 0 or more"]);
  // cap-discard closes the editor.
  events.length = 0;
  scope.runAct("cap-discard", "clean");
  assert.deepEqual(events, ["stop"]);
});



test("instructions-edit opens the editor, instructions-save posts the textarea, instructions-discard posts nothing", () => {
  const posts: unknown[] = [];
  const events: string[] = [];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "clean", state: "ok", view: { instructions: "Stay small." } },
      $: (id: string) => (id === "instructionsedittext" ? { value: "new text" } : null),
      startInstructionsEdit: (r: string, t: string) => events.push(`edit ${r} ${t}`),
      stopInstructionsEdit: () => events.push("stop"),
      instructionsEditing: { current: null },
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => {
        posts.push([path, body]);
        // postAction toasts the callback's message — record it as an event.
        events.push(done({ message: "clean: instructions saved (8 chars)" }));
      },
    },
  );
  // instructions-edit seeds the editor with the current override.
  scope.runAct("instructions-edit", "clean");
  assert.deepEqual(events, ["edit clean Stay small."]);
  // instructions-save posts the textarea's text and refetches the role.
  scope.runAct("instructions-save", "clean");
  assert.deepEqual(posts, [["/api/role-instructions", { role: "clean", text: "new text" }]]);
  assert.deepEqual(events.slice(-2), ["load clean", "clean: instructions saved (8 chars)"]);
  // instructions-discard closes the editor, posting nothing.
  events.length = 0;
  scope.runAct("instructions-discard", "clean");
  assert.deepEqual(posts, [["/api/role-instructions", { role: "clean", text: "new text" }]]);
  assert.deepEqual(events, ["stop"]);
});

test("quiet-edit seeds the editor from the own window, quiet-save posts it, quiet-discard posts nothing", () => {
  const posts: unknown[] = [];
  const events: string[] = [];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "clean", state: "ok", view: { quietHours: [{ scope: "role", window: "23:00-07:00", inWindow: true }] } },
      $: (id: string) => (id === "quieteditinput" ? { value: "20:00-06:00" } : null),
      startQuietEdit: (r: string, w: string) => events.push(`edit ${r} ${w}`),
      stopQuietEdit: () => events.push("stop"),
      quietEditing: { current: null },
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => {
        posts.push([path, body]);
        // postAction toasts the callback's message — record it as an event.
        events.push(done({ message: "clean: quiet hours set to 20:00-06:00" }));
      },
    },
  );
  // quiet-edit seeds the editor with the role's own window.
  scope.runAct("quiet-edit", "clean");
  assert.deepEqual(events, ["edit clean 23:00-07:00"]);
  // quiet-save posts the input's window (an empty value would hit the server's clear branch)
  // and refetches the role.
  scope.runAct("quiet-save", "clean");
  assert.deepEqual(posts, [["/api/role-quiet-hours", { role: "clean", window: "20:00-06:00" }]]);
  assert.deepEqual(events.slice(-2), ["load clean", "clean: quiet hours set to 20:00-06:00"]);
  // quiet-discard closes the editor, posting nothing.
  events.length = 0;
  scope.runAct("quiet-discard", "clean");
  assert.deepEqual(posts, [["/api/role-quiet-hours", { role: "clean", window: "20:00-06:00" }]]);
  assert.deepEqual(events, ["stop"]);
});

test("interval-edit opens the editor, interval-save posts the interval (empty input posts null), interval-discard posts nothing", () => {
  const posts: unknown[] = [];
  const flashes: string[] = [];
  const events: string[] = [];
  const field = { value: "300", validity: { badInput: false } };
  const intervalState: { current: unknown } = { current: null };
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "clean", state: "ok", view: { minRunIntervalOverride: 300 } },
      $: (id: string) => (id === "intervaleditinput" ? field : null),
      startIntervalEdit: (r: string, v: number | string) => events.push(`edit ${r} ${v}`),
      stopIntervalEdit: () => events.push("stop"),
      intervalEditing: intervalState,
      showFlash: (m: string) => flashes.push(m),
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => {
        posts.push([path, body]);
        // postAction toasts the callback's message — record it as the flash.
        const msg = done({ message: "clean: min run interval set to 300s" });
        flashes.push(msg);
        events.push(msg);
      },
    },
  );
  // interval-edit seeds the editor with the current override.
  scope.runAct("interval-edit", "clean");
  assert.deepEqual(events, ["edit clean 300"]);
  // interval-save posts the interval and flashes the server's message.
  scope.runAct("interval-save", "clean");
  assert.deepEqual(posts[0], ["/api/role-interval", { role: "clean", minRunIntervalSeconds: 300 }]);
  assert.deepEqual(flashes[0], "clean: min run interval set to 300s");
  assert.deepEqual(events.slice(-2), ["load clean", "clean: min run interval set to 300s"]);
  // An empty input posts null (the server clears the override).
  field.value = "  ";
  posts.length = 0;
  scope.runAct("interval-save", "clean");
  assert.deepEqual(posts[0], ["/api/role-interval", { role: "clean", minRunIntervalSeconds: null }]);
  // A non-numeric field flashes the number error and posts nothing.
  flashes.length = 0;
  posts.length = 0;
  field.value = "abc";
  field.validity.badInput = true;
  scope.runAct("interval-save", "clean");
  assert.deepEqual(posts, []);
  assert.deepEqual(flashes, ["error: the interval must be a number of 0 or more — leave it empty for the team default"]);
  // A type=number input accepts exponent/hex spellings the browser parses ("1e2" → 100), so
  // badInput is false — the plain-decimal shape guard must reject it, not silently save 100s.
  flashes.length = 0;
  field.validity.badInput = false;
  field.value = "1e2";
  scope.runAct("interval-save", "clean");
  assert.deepEqual(posts, [], "an exponent spelling is not posted");
  assert.deepEqual(flashes, ["error: the interval must be a plain second count like 300, 0.5, or .5 — no +/-, exponent, or hex notation"]);
  // interval-discard closes the editor, posting nothing.
  events.length = 0;
  scope.runAct("interval-discard", "clean");
  assert.deepEqual(events, ["stop"]);
});

test("instances-edit opens the editor, instances-save posts the count (empty input posts null), instances-discard posts nothing", () => {
  const posts: unknown[] = [];
  const flashes: string[] = [];
  const events: string[] = [];
  const field = { value: "3", validity: { badInput: false } };
  const instancesState: { current: unknown } = { current: null };
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "feature", state: "ok", view: { instances: 3 } },
      $: (id: string) => (id === "instanceseditinput" ? field : null),
      startInstancesEdit: (r: string, v: number | string) => events.push(`edit ${r} ${v}`),
      stopInstancesEdit: () => events.push("stop"),
      instancesEditing: instancesState,
      showFlash: (m: string) => flashes.push(m),
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => {
        posts.push([path, body]);
        // postAction toasts the callback's message — record it as the flash.
        const msg = done({ message: "feature: instances set to 3" });
        flashes.push(msg);
        events.push(msg);
      },
    },
  );
  // instances-edit seeds the editor with the current count.
  scope.runAct("instances-edit", "feature");
  assert.deepEqual(events, ["edit feature 3"]);
  // instances-save posts the count and flashes the server's message.
  scope.runAct("instances-save", "feature");
  assert.deepEqual(posts[0], ["/api/role-instances", { role: "feature", instances: 3 }]);
  assert.deepEqual(flashes[0], "feature: instances set to 3");
  assert.deepEqual(events.slice(-2), ["load feature", "feature: instances set to 3"]);
  // An empty input posts null (the server clears the count back to the default 1).
  field.value = "  ";
  posts.length = 0;
  scope.runAct("instances-save", "feature");
  assert.deepEqual(posts[0], ["/api/role-instances", { role: "feature", instances: null }]);
  // A non-numeric field flashes the number error and posts nothing.
  flashes.length = 0;
  posts.length = 0;
  field.value = "abc";
  field.validity.badInput = true;
  scope.runAct("instances-save", "feature");
  assert.deepEqual(posts, []);
  assert.deepEqual(flashes, ["error: the instances must be an integer from 1 to 8 — leave it empty for the default 1"]);
  // A type=number input accepts exponent spellings the browser parses ("2e0" → 2), so badInput
  // is false — the plain-decimal shape guard must reject it, not silently save 2.
  flashes.length = 0;
  posts.length = 0;
  field.validity.badInput = false;
  field.value = "2e0";
  scope.runAct("instances-save", "feature");
  assert.deepEqual(posts, [], "an exponent spelling is not posted");
  assert.deepEqual(flashes, ["error: the instances must be a plain integer like 2 — no +/-, exponent, or hex notation — leave it empty for the default 1"]);
  // instances-discard closes the editor, posting nothing.
  events.length = 0;
  scope.runAct("instances-discard", "feature");
  assert.deepEqual(events, ["stop"]);
});

test("model-edit seeds the editor from the raw overrides, model-save posts the trimmed set, model-discard posts nothing", () => {
  const posts: unknown[] = [];
  const events: string[] = [];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      drawerRole: { role: "clean", state: "ok", view: { providerOverride: "claude", modelOverride: "claude-opus-5", thinkingOverride: "high", backendOverride: "claude" } },
      $: (id: string) => ({ "modeleditprovider": { value: " claude " }, "modeleditmodel": { value: "claude-opus-5" }, "modeleditthinking": { value: "high" }, "modeleditbackend": { value: " claude " } }[id] || null),
      startModelEdit: (r: string, seed: object) => events.push(`edit ${r} ${JSON.stringify(seed)}`),
      stopModelEdit: () => events.push("stop"),
      modelEditing: { current: null },
      loadDrawerRole: (r: string) => events.push(`load ${r}`),
      postAction: (path: string, body: unknown, done: (d: unknown) => string) => {
        posts.push([path, body]);
        // postAction toasts the callback's message — record it as an event.
        events.push(done({ message: "clean: model updated" }));
      },
    },
  );
  // model-edit seeds the editor with the payload's raw overrides.
  scope.runAct("model-edit", "clean");
  assert.deepEqual(events, ["edit clean " + JSON.stringify({ provider: "claude", model: "claude-opus-5", thinking: "high", backend: "claude" })]);
  // model-save posts the four trimmed input values and flashes the server's message.
  scope.runAct("model-save", "clean");
  assert.deepEqual(posts[0], ["/api/role-model", { role: "clean", provider: "claude", model: "claude-opus-5", thinking: "high", backend: "claude" }]);
  assert.deepEqual(events.slice(-2), ["load clean", "clean: model updated"]);
  // model-discard closes the editor, posting nothing.
  events.length = 0;
  scope.runAct("model-discard", "clean");
  assert.deepEqual(posts, [["/api/role-model", { role: "clean", provider: "claude", model: "claude-opus-5", thinking: "high", backend: "claude" }]]);
  assert.deepEqual(events, ["stop"]);
});

test("route still follows the legacy #loop/<role> and #fleet hashes", () => {
  const log: string[] = [];
  const calls: string[] = [];
  let hash = "#loop/qa";
  const scope = bootScope({
    location: { get hash() { return hash; } },
    lastStatus: { roles: [] },
    renderTeam: () => calls.push("renderTeam"),
    openRoleId: () => null,
    openRole: (role: string) => calls.push("openRole " + role),
  }, log);
  scope.route();
  assert.deepEqual(calls, ["renderTeam", "openRole qa"]);

  calls.length = 0;
  hash = "#fleet";
  scope.route();
  assert.deepEqual(calls, ["renderTeam"]);
  assert.equal(log.filter((l) => l.startsWith("tab-team ")).pop(), "tab-team aria-current=page");
});

test("entry-edit-save words an edited, unchanged and gone reply", () => {
  const messages: string[] = [];
  const replies: unknown[] = [
    { status: "edited", title: "B", committed: true },
    { status: "unchanged", title: "B" },
    { status: "gone" },
    { status: "edited", title: "B", heldNote: "still held [blocked: refused]: no role takes it until that clears", committed: true },
  ];
  const scope = clientScope<{ runAct(a: string, b: string): void }>(
    ["run-act"], ["runAct"],
    {
      lastStatus: { plans: ["A", "B"] },
      entryEditing: { key: "plans:1", title: "B" },
      $: (id: string) => ({ entryedittitle: { value: "B" }, entryeditbody: { value: "" } })[id],
      stopEntryEdit: () => {},
      closeDrawer: () => {},
      uncommittedTail: () => "",
      postAction: (_path: string, _body: unknown, msg: (d: unknown) => string) => {
        for (const d of replies) messages.push(msg(d));
      },
      splitTitle: (t: string) => ({ title: t }),
    },
  );
  scope.runAct("entry-edit-save", "plans:1");
  assert.deepEqual(messages, [
    "Edited “B” in PLANS.md",
    "No change to “B” — PLANS.md was not written",
    "That entry was removed or moved — refreshed",
    "Edited “B” in PLANS.md — still held [blocked: refused]: no role takes it until that clears",
  ]);
});
