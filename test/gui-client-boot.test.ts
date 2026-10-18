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
  return clientScope<{ switchView(v: string): void; route(): void; openLoopRole(): string | null }>(
    ["view-routing"], ["switchView", "route", "openLoopRole"],
    { $: (id: string) => els[id], openLoopRole: () => null, ...inject },
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
  let openRole: string | null = null;
  const scope = bootScope({
    location: { get hash() { return hash; } },
    lastStatus: { roles: [] },
    renderTeam: () => calls.push("renderTeam"),
    fetchHistory: () => calls.push("fetchHistory"),
    openLoopRole: () => openRole,
    openLoop: (role: string) => { calls.push("openLoop " + role); openRole = role; },
  }, log);

  // A fresh load straight to #role/feature: team is shown behind the drawer and the
  // feature drawer opens.
  scope.route();
  assert.deepEqual(calls, ["renderTeam", "openLoop feature"]);
  assert.equal(scope.openLoopRole(), "feature");

  // A poll-driven re-route to the same loop is a no-op: no rebuilt drawer (the live
  // transcript the reader is pinned to would reset) and no team re-render either.
  calls.length = 0;
  scope.route();
  assert.deepEqual(calls, [], "the already-open drawer is left alone");

  // Merge on a different loop's link does open that drawer.
  hash = "#role/qa";
  scope.route();
  assert.deepEqual(calls, ["openLoop qa"]);

  // A plain tab hash routes to that view (Back/Forward land here).
  hash = "#history";
  calls.length = 0;
  scope.route();
  assert.deepEqual(calls, ["fetchHistory"], "the history view fetched, team not re-painted");

  // A later #loop route on an already-routed page must not force team back on.
  hash = "#role/feature";
  calls.length = 0;
  log.length = 0;
  scope.route();
  assert.deepEqual(calls, ["openLoop feature"]);
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
        const msg = done({});
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

test("route still follows the legacy #loop/<role> and #fleet hashes", () => {
  const log: string[] = [];
  const calls: string[] = [];
  let hash = "#loop/qa";
  const scope = bootScope({
    location: { get hash() { return hash; } },
    lastStatus: { roles: [] },
    renderTeam: () => calls.push("renderTeam"),
    openLoopRole: () => null,
    openLoop: (role: string) => calls.push("openLoop " + role),
  }, log);
  scope.route();
  assert.deepEqual(calls, ["renderTeam", "openLoop qa"]);

  calls.length = 0;
  hash = "#fleet";
  scope.route();
  assert.deepEqual(calls, ["renderTeam"]);
  assert.equal(log.filter((l) => l.startsWith("tab-team ")).pop(), "tab-team aria-current=page");
});
