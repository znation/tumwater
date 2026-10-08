import test from "node:test";
import assert from "node:assert/strict";
import { clientScope } from "./helpers/gui-client-scope.js";

// The dashboard's view routing (src/ui/gui/gui-client-boot.ts's view-routing region): the
// #fragment-driven switchView/route pair the page's tabs, Back/Forward buttons, and
// #loop/<role> drawer links all run through. The pattern test/gui-client.test.ts uses:
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
  for (const id of ["fleet-view", "history", "report", "failures", "pending", "settings-view", "tab-fleet", "tab-history", "tab-usage", "tab-failures", "tab-pending", "tab-settings"]) {
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
    lastStatus: { loops: [] },
    renderFleet: () => calls.push("renderFleet"),
    fetchHistory: () => calls.push("fetchHistory"),
    fetchReport: () => calls.push("fetchReport"),
    fetchFailures: () => calls.push("fetchFailures"),
    fetchPending: () => calls.push("fetchPending"),
  }, log);

  scope.switchView("history");
  // Only the history section is visible, and only its tab carries the active mark —
  // the others are hidden and lose any stale aria-current from a previous view.
  assert.equal(log.filter((l) => l.startsWith("history ")).join("|"), "history hidden=false");
  assert.equal(log.filter((l) => l.startsWith("fleet-view ")).join("|"), "fleet-view hidden=true");
  assert.equal(log.filter((l) => l.startsWith("tab-history ")).join("|"), "tab-history active+|tab-history aria-current=page");
  assert.equal(log.filter((l) => l.startsWith("tab-fleet ")).join("|"), "tab-fleet active-|tab-fleet -aria-current");
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

test("switchView falls back to fleet for an unknown view and repaints fleet from the last status", () => {
  const log: string[] = [];
  const calls: string[] = [];
  const scope = bootScope({
    lastStatus: { loops: [] },
    renderFleet: (d: unknown) => calls.push("renderFleet " + JSON.stringify(d)),
    fetchHistory: () => calls.push("fetchHistory"),
  }, log);

  scope.switchView("bogus");
  // The unknown name became fleet: its section shows, its tab leads, and the last
  // status payload is what got painted (no fetch happens for the fallback).
  assert.equal(log.filter((l) => l.startsWith("fleet-view ")).join("|"), "fleet-view hidden=false");
  assert.equal(log.filter((l) => l.startsWith("tab-fleet ")).join("|"), "tab-fleet active+|tab-fleet aria-current=page");
  assert.deepEqual(calls, ["renderFleet {\"loops\":[]}"]);

  // With no status ever received, the fallback still routes but paints nothing —
  // the pre-poll boot state must not crash on a missing payload.
  const quietLog: string[] = [];
  const quiet = bootScope({ lastStatus: null, renderFleet: () => calls.push("renderFleet") }, quietLog);
  quiet.switchView("bogus");
  assert.equal(quietLog.filter((l) => l.startsWith("fleet-view ")).join("|"), "fleet-view hidden=false");
});

test("route follows #loop/<role> into the drawer over fleet, and idempotently on re-route", () => {
  const log: string[] = [];
  const calls: string[] = [];
  let hash = "#loop/feature";
  let openRole: string | null = null;
  const scope = bootScope({
    location: { get hash() { return hash; } },
    lastStatus: { loops: [] },
    renderFleet: () => calls.push("renderFleet"),
    fetchHistory: () => calls.push("fetchHistory"),
    openLoopRole: () => openRole,
    openLoop: (role: string) => { calls.push("openLoop " + role); openRole = role; },
  }, log);

  // A fresh load straight to #loop/feature: fleet is shown behind the drawer and the
  // feature drawer opens.
  scope.route();
  assert.deepEqual(calls, ["renderFleet", "openLoop feature"]);
  assert.equal(scope.openLoopRole(), "feature");

  // A poll-driven re-route to the same loop is a no-op: no rebuilt drawer (the live
  // transcript the reader is pinned to would reset) and no fleet re-render either.
  calls.length = 0;
  scope.route();
  assert.deepEqual(calls, [], "the already-open drawer is left alone");

  // Landing on a different loop's link does open that drawer.
  hash = "#loop/qa";
  scope.route();
  assert.deepEqual(calls, ["openLoop qa"]);

  // A plain tab hash routes to that view (Back/Forward land here).
  hash = "#history";
  calls.length = 0;
  scope.route();
  assert.deepEqual(calls, ["fetchHistory"], "the history view fetched, fleet not re-painted");

  // A later #loop route on an already-routed page must not force fleet back on.
  hash = "#loop/feature";
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
    lastStatus: { loops: [] },
    renderFleet: () => calls.push("renderFleet"),
    fetchHistory: () => calls.push("fetchHistory"),
  }, log);

  // decodeURIComponent("%") throws; the raw fragment is no known view, so routing falls back
  // to fleet. The assertion that matters is doesNotThrow: route() runs before pollLoop() at
  // boot, so a throw here would abort the served script and freeze the whole dashboard.
  assert.doesNotThrow(() => scope.route());
  assert.equal(log.filter((l) => l.startsWith("fleet-view ")).join("|"), "fleet-view hidden=false");
  assert.deepEqual(calls, ["renderFleet"]);
});
