import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  consumeAbortRequests,
  consumeReclaimRequest,
  consumeResetRequest,
  cancelScheduledWakes,
  consumeWakeRequest,
  pendingScheduledWakes,
  type AbortableMerge,
} from "../src/operator/operator-requests.js";
import { readEvents } from "../src/events/event-read.js";
import {
  abortRequestPath,
  eventsLogPath,
  reclaimRequestPath,
  resetRequestPath,
  scheduledWakeDir,
  statePath,
  wakeRequestPath,
  STATE_DIR,
} from "../src/paths.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { loadRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { readJsonFile } from "../src/files/json-files.js";
import { eventsOfType, writeMarker } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** A recording stand-in for RoleRunner covering exactly the surface operator/operator-requests.ts
 * touches: role, in-memory running flag, and the three mutators it calls. */
interface FakeRunner {
  role: string;
  state: { running: boolean };
  resets: number;
  wakes: number;
  aborts: number;
  resetCounters(): void;
  wake(): void;
  abortTick(): void;
}

function fakeRunner(role: string, running = false): FakeRunner {
  const r: FakeRunner = {
    role,
    state: { running },
    resets: 0,
    wakes: 0,
    aborts: 0,
    resetCounters() {
      r.resets++;
    },
    wake() {
      r.wakes++;
    },
    abortTick() {
      r.aborts++;
    },
  };
  return r;
}

function asRunners(...rs: FakeRunner[]): RoleRunner[] {
  return rs as unknown as RoleRunner[];
}

function stateDir(root: string): string {
  return path.join(root, STATE_DIR);
}

test("consumeResetRequest is a no-op without a marker", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  consumeResetRequest(root, asRunners(a));
  assert.equal(a.resets, 0);
  assert.equal(eventsOfType(root, "counters_reset").length, 0);
});

test("consumeResetRequest resets only the named roles and logs one role event", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  const b = fakeRunner("clean");
  writeMarker(resetRequestPath(root), { roles: ["coverage"] });
  consumeResetRequest(root, asRunners(a, b));
  assert.equal(a.resets, 1);
  assert.equal(b.resets, 0);
  assert.equal(fs.existsSync(resetRequestPath(root)), false);
  const events = eventsOfType(root, "counters_reset");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "coverage");
});

test("consumeResetRequest resets every role and logs a harness event when the marker names several", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  const b = fakeRunner("clean");
  writeMarker(resetRequestPath(root), { roles: ["coverage", "clean"] });
  consumeResetRequest(root, asRunners(a, b));
  assert.equal(a.resets, 1);
  assert.equal(b.resets, 1);
  const events = eventsOfType(root, "counters_reset");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "tumwater");
  assert.deepEqual(events[0]?.roles, ["coverage", "clean"]);
});

test("consumeResetRequest treats a corrupt marker as all roles (superset is safe)", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  const b = fakeRunner("clean");
  writeMarker(resetRequestPath(root), { roles: "not-an-array" });
  consumeResetRequest(root, asRunners(a, b));
  assert.equal(a.resets, 1);
  assert.equal(b.resets, 1);
  assert.equal(fs.existsSync(resetRequestPath(root)), false);
});

test("consumeResetRequest consumes a marker naming an unknown role without resetting anyone", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  writeMarker(resetRequestPath(root), { roles: ["ghost"] });
  consumeResetRequest(root, asRunners(a));
  assert.equal(a.resets, 0);
  assert.equal(fs.existsSync(resetRequestPath(root)), false);
  assert.equal(eventsOfType(root, "counters_reset").length, 0);
});

test("consumeResetRequest zeroes a named role that has no live runner through its state file", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  // A disabled role keeps its persisted state but has no runner, so the CLI (which writes only
  // the marker while a team is live) can reach it only here: the consumer is the state file's
  // single writer while the team runs.
  saveRunnerState(root, { ...loadRunnerState(root, "docs"), role: "docs", runs: 7, commits: 3 });
  writeMarker(resetRequestPath(root), { roles: ["docs"] });
  consumeResetRequest(root, asRunners(a));
  assert.equal(a.resets, 0);
  const s = readJsonFile<{ runs: number; commits: number }>(statePath(root, "docs"));
  assert.equal(s?.runs, 0, "the runnerless role's counters are zeroed on disk");
  assert.equal(s?.commits, 0);
  assert.equal(fs.existsSync(resetRequestPath(root)), false);
  const events = eventsOfType(root, "counters_reset");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "docs");
});

test("consumeWakeRequest clears the schedule of a named role that has no live runner", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  saveRunnerState(root, {
    ...loadRunnerState(root, "docs"),
    role: "docs",
    backoffSeconds: 300,
    nextRunAt: Date.now() + 300_000,
  });
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["docs"] });
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 0);
  const s = readJsonFile<{ backoffSeconds: number; nextRunAt: number }>(statePath(root, "docs"));
  assert.equal(s?.backoffSeconds, 0, "the runnerless role's schedule is cleared on disk");
  assert.ok((s?.nextRunAt ?? 0) > 0, "the wake pulls nextRunAt to the consume instant");
  const events = eventsOfType(root, "wake");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "docs");
  assert.equal(events[0]?.reason, "operator");
});

test("consumeWakeRequest wakes only the named roles and logs the operator reason", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  const b = fakeRunner("clean");
  writeMarker(wakeRequestPath(root), { roles: ["clean"] });
  consumeWakeRequest(root, asRunners(a, b));
  assert.equal(a.wakes, 0);
  assert.equal(b.wakes, 1);
  assert.equal(fs.existsSync(wakeRequestPath(root)), false);
  const events = eventsOfType(root, "wake");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "clean");
  assert.equal(events[0]?.reason, "operator");
});

test("consumeWakeRequest with no marker changes nothing", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 0);
  assert.equal(readEvents(root).length, 0);
});

test("consumeWakeRequest leaves a scheduled wake in place before its deadline", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["coverage"], notBeforeMs: Date.now() + 60_000 });
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 0, "a wake not yet due must wake nothing");
  assert.equal(fs.existsSync(wakeRequestPath(root)), true, "the marker must survive for a later poll to retry");
  assert.equal(eventsOfType(root, "wake").length, 0);
});

test("consumeWakeRequest consumes a scheduled wake at its deadline", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  const b = fakeRunner("clean");
  writeMarker(wakeRequestPath(root), { at: Date.now() - 60_000, roles: ["coverage"], notBeforeMs: Date.now() });
  consumeWakeRequest(root, asRunners(a, b));
  assert.equal(a.wakes, 1, "the deadline-crossing poll applies the wake");
  assert.equal(b.wakes, 0);
  assert.equal(fs.existsSync(wakeRequestPath(root)), false);
  const events = eventsOfType(root, "wake");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "coverage");
});

test("consumeWakeRequest reads a non-numeric notBeforeMs as immediate", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["coverage"], notBeforeMs: "soon" });
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 1, "defensive: validation happens at the CLI, the consumer only gates on numbers");
  assert.equal(fs.existsSync(wakeRequestPath(root)), false);
});

test("consumeWakeRequest reads a non-finite notBeforeMs as immediate", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  // A hand edit's overflow literal parses to Infinity; as a deadline it would hold
  // `notBefore > Date.now()` true forever, stranding the marker (nothing else deletes it).
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["coverage"] });
  fs.writeFileSync(wakeRequestPath(root), `{"at":${Date.now()},"roles":["coverage"],"notBeforeMs":1e999}`);
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 1, "a deadline no clock can reach reads as immediate, like a non-number");
  assert.equal(fs.existsSync(wakeRequestPath(root)), false);
});

test("consumeWakeRequest wakes every named role when a wake event cannot be logged", () => {
  const root = tmpdir();
  // events.jsonl as a directory makes logEvent throw (EISDIR) on the first role's wake event.
  // Pre-fix the throw escaped the consumer, ending the orchestrator poll and starving the
  // second role and the marker removal.
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  const a = fakeRunner("coverage");
  const b = fakeRunner("clean");
  const marker = wakeRequestPath(root);
  writeMarker(marker, { roles: ["coverage", "clean"] });
  assert.doesNotThrow(() => consumeWakeRequest(root, asRunners(a, b)));
  assert.equal(a.wakes, 1);
  assert.equal(b.wakes, 1, "one role's failed log must not skip the next");
  assert.equal(fs.existsSync(marker), false, "the applied wake is acknowledged despite the failed log");
});

test("consumeResetRequest resets and acknowledges when its event cannot be logged", () => {
  const root = tmpdir();
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  const a = fakeRunner("coverage");
  const marker = resetRequestPath(root);
  writeMarker(marker, { roles: ["coverage"] });
  assert.doesNotThrow(() => consumeResetRequest(root, asRunners(a)));
  assert.equal(a.resets, 1);
  assert.equal(fs.existsSync(marker), false, "the applied reset is acknowledged despite the failed log");
});

test("consumeAbortRequests tolerates a missing .tumwater directory", () => {
  const root = tmpdir(); // never created — the fresh-repo case the catch exists for
  const a = fakeRunner("coverage", true);
  assert.doesNotThrow(() => consumeAbortRequests(root, asRunners(a), []));
  assert.equal(a.aborts, 0);
});

test("consumeAbortRequests aborts a running role's tick and logs run_aborted", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage", true);
  const marker = abortRequestPath(root, "coverage");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(a), []);
  assert.equal(a.aborts, 1);
  assert.equal(fs.existsSync(marker), false);
  const events = eventsOfType(root, "run_aborted");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "coverage");
});

test("consumeAbortRequests silently clears a marker for an idle role", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage", false);
  const marker = abortRequestPath(root, "coverage");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(a), []);
  assert.equal(a.aborts, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(eventsOfType(root, "run_aborted").length, 0);
});

test("consumeAbortRequests clears a marker for a role with no runner at all", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage", true);
  const marker = abortRequestPath(root, "disabled-role");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(a), []);
  assert.equal(a.aborts, 0);
  assert.equal(fs.existsSync(marker), false);
});

test("consumeAbortRequests marks and aborts the in-flight merge for any batched role", () => {
  const root = tmpdir();
  const controller = new AbortController();
  const inFlightMerge: AbortableMerge = {
    roles: ["clean", "coverage"],
    userAborted: false,
    controller,
  };
  const marker = abortRequestPath(root, "coverage");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(), [inFlightMerge]);
  assert.equal(inFlightMerge.userAborted, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(fs.existsSync(marker), false);
});

test("consumeAbortRequests stops whichever of several in-flight merges holds the role, and only that one", () => {
  // Land-queue speed 2c: each change being verified is its own unit, beside the merge slot's.
  const root = tmpdir();
  const unit = (roles: string[]): AbortableMerge => ({ roles, userAborted: false, controller: new AbortController() });
  const verifyA = unit(["clean"]);
  const verifyB = unit(["coverage"]);
  const merge = unit(["feature", "dedupe"]);
  writeMarker(abortRequestPath(root, "coverage"), { at: 1 });
  writeMarker(abortRequestPath(root, "dedupe"), { at: 1 });
  consumeAbortRequests(root, asRunners(), [verifyA, verifyB, merge]);
  assert.equal(verifyA.userAborted || verifyA.controller.signal.aborted, false, "another verify runs on");
  assert.equal(verifyB.userAborted && verifyB.controller.signal.aborted, true);
  assert.equal(merge.userAborted && merge.controller.signal.aborted, true, "a stacked role stops the stack");
});

test("consumeAbortRequests ignores non-abort files in the state directory", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage", true);
  fs.mkdirSync(stateDir(root), { recursive: true });
  fs.writeFileSync(path.join(stateDir(root), "paused.json"), "{}");
  fs.writeFileSync(path.join(stateDir(root), "abort-not-json.txt"), "{}");
  consumeAbortRequests(root, asRunners(a), []);
  assert.equal(a.aborts, 0);
  assert.equal(readEvents(root).length, 0);
});

test("consumeAbortRequests consumes every marker when one tick abort cannot be logged", () => {
  const root = tmpdir();
  // events.jsonl as a directory makes logEvent throw (EISDIR) at the first marker's
  // run_aborted append. The pre-fix broad catch swallowed that throw and skipped every
  // abort request that sorted after it, so the second marker never got its turn.
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  const a = fakeRunner("coverage", true);
  const b = fakeRunner("clean", true);
  const markerA = abortRequestPath(root, "coverage");
  const markerB = abortRequestPath(root, "clean");
  writeMarker(markerA, { at: 1 });
  writeMarker(markerB, { at: 1 });
  assert.doesNotThrow(() => consumeAbortRequests(root, asRunners(a, b), []));
  assert.equal(fs.existsSync(markerA), false, "the first marker is consumed despite the failed log");
  assert.equal(fs.existsSync(markerB), false, "one marker's failure must not skip the next");
  assert.equal(a.aborts + b.aborts, 2, "both running ticks were aborted");
});

test("consumeAbortRequests keeps a marker whose abort side effect throws, without skipping later ones", () => {
  const root = tmpdir();
  const bad = fakeRunner("coverage", true);
  bad.abortTick = () => {
    throw new Error("boom");
  };
  const good = fakeRunner("clean", true);
  const markerBad = abortRequestPath(root, "coverage");
  const markerGood = abortRequestPath(root, "clean");
  writeMarker(markerBad, { at: 1 });
  writeMarker(markerGood, { at: 1 });
  assert.doesNotThrow(() => consumeAbortRequests(root, asRunners(bad, good), []));
  assert.equal(fs.existsSync(markerBad), true, "a failed side effect leaves its marker for the next poll");
  assert.equal(fs.existsSync(markerGood), false, "the later marker is still consumed");
  assert.equal(good.aborts, 1);
});

test("consumeResetRequest survives an unwritable runnerless state file instead of ending the poll", () => {
  const root = tmpdir();
  // The state path exists (so the runnerless branch reaches it) but is a directory, so the
  // atomic write's rename onto it fails: the same shape an unwritable state file takes.
  fs.mkdirSync(statePath(root, "docs"), { recursive: true });
  writeMarker(resetRequestPath(root), { roles: ["docs"] });
  assert.doesNotThrow(() => consumeResetRequest(root, []));
  assert.equal(fs.existsSync(resetRequestPath(root)), false, "the consumed marker is still removed");
  assert.equal(eventsOfType(root, "warning").length, 1, "the failed save is reported, not swallowed");
});

test("consumeWakeRequest survives an unwritable runnerless state file", () => {
  const root = tmpdir();
  fs.mkdirSync(statePath(root, "docs"), { recursive: true });
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["docs"] });
  assert.doesNotThrow(() => consumeWakeRequest(root, []));
  assert.equal(fs.existsSync(wakeRequestPath(root)), false, "the consumed marker is still removed");
  assert.equal(eventsOfType(root, "warning").length, 1);
  assert.equal(eventsOfType(root, "wake").length, 0, "a failed save logs no wake event for an unwoken role");
});

test("consumeWakeRequest keeps a live runner whose wake save fails from skipping later ones", () => {
  const root = tmpdir();
  const bad = fakeRunner("coverage");
  bad.wake = () => {
    throw new Error("ENOSPC");
  };
  const good = fakeRunner("clean");
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["coverage", "clean"] });
  assert.doesNotThrow(() => consumeWakeRequest(root, asRunners(bad, good)));
  assert.equal(good.wakes, 1, "the role after the failed one is still woken");
  assert.equal(fs.existsSync(wakeRequestPath(root)), false);
  assert.equal(eventsOfType(root, "warning").length, 1);
});

test("consumeReclaimRequest arms one manual pass and removes the marker", () => {
  const root = tmpdir();
  const marker = reclaimRequestPath(root);
  writeMarker(marker, { at: 1 });
  let manual = 0;
  consumeReclaimRequest(root, {
    requestManual() {
      manual++;
    },
  });
  assert.equal(manual, 1);
  assert.equal(fs.existsSync(marker), false, "the marker is consumed");
});

test("consumeReclaimRequest with no marker changes nothing", () => {
  const root = tmpdir();
  let manual = 0;
  consumeReclaimRequest(root, {
    requestManual() {
      manual++;
    },
  });
  assert.equal(manual, 0);
});

function scheduledWake(root: string, name: string, roles: string[], notBeforeMs: number): string {
  const file = path.join(scheduledWakeDir(root), name);
  writeMarker(file, { at: Date.now(), roles, notBeforeMs });
  return file;
}

test("consumeWakeRequest applies an immediate wake.json but leaves a future scheduled file", () => {
  const root = tmpdir();
  const feature = fakeRunner("feature");
  const plan = fakeRunner("plan");
  const file = scheduledWake(root, "1-1-aa.json", ["feature"], Date.now() + 60_000);
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["plan"] });
  consumeWakeRequest(root, asRunners(feature, plan));
  assert.equal(plan.wakes, 1);
  assert.equal(feature.wakes, 0);
  assert.equal(fs.existsSync(wakeRequestPath(root)), false);
  assert.equal(fs.existsSync(file), true, "the scheduled wake survives");
  writeMarker(file, { at: Date.now(), roles: ["feature"], notBeforeMs: Date.now() - 1 });
  consumeWakeRequest(root, asRunners(feature, plan));
  assert.equal(feature.wakes, 1);
  assert.equal(fs.existsSync(file), false);
  assert.ok(eventsOfType(root, "wake").some((e) => e.source === "feature" && e.reason === "operator"));
});

test("consumeWakeRequest wakes everyone for a corrupt scheduled file and ignores tmp leftovers", () => {
  const root = tmpdir();
  const a = fakeRunner("feature");
  const bad = path.join(scheduledWakeDir(root), "1-1-bad.json");
  fs.mkdirSync(scheduledWakeDir(root), { recursive: true });
  fs.writeFileSync(bad, "{not json");
  const tmp = path.join(scheduledWakeDir(root), "1-1-x.json.tmp-123");
  fs.writeFileSync(tmp, "{}");
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 1);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(tmp), true);
});

test("a legacy wake.json with a future deadline stays in place", () => {
  const root = tmpdir();
  const a = fakeRunner("feature");
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["feature"], notBeforeMs: Date.now() + 60_000 });
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 0);
  assert.equal(fs.existsSync(wakeRequestPath(root)), true);
});

test("pendingScheduledWakes lists future entries by deadline and deletes nothing", () => {
  const root = tmpdir();
  const now = Date.now();
  scheduledWake(root, "1.json", ["b"], now + 20_000);
  scheduledWake(root, "2.json", ["a"], now + 10_000);
  const past = scheduledWake(root, "3.json", ["c"], now - 1);
  const corrupt = path.join(scheduledWakeDir(root), "4.json");
  fs.writeFileSync(corrupt, "{nope");
  assert.deepEqual(pendingScheduledWakes(root, now), [
    { roles: ["a"], atMs: now + 10_000 },
    { roles: ["b"], atMs: now + 20_000 },
  ]);
  assert.ok(fs.existsSync(past) && fs.existsSync(corrupt));
});

test("cancelScheduledWakes removes pending files and leaves a due one", () => {
  const root = tmpdir();
  const a = scheduledWake(root, "1-1-aa.json", ["feature"], Date.now() + 60_000);
  const b = scheduledWake(root, "2-1-bb.json", ["qa"], Date.now() + 90_000);
  const due = scheduledWake(root, "3-1-cc.json", ["plan"], Date.now() - 1);
  assert.equal(cancelScheduledWakes(root), 2);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
  assert.equal(fs.existsSync(due), true);
});

test("cancelScheduledWakes with a role drops only that role", () => {
  const root = tmpdir();
  const at = Date.now() + 60_000;
  const only = scheduledWake(root, "1-1-aa.json", ["qa"], at);
  const shared = scheduledWake(root, "2-1-bb.json", ["qa", "feature"], at);
  const other = scheduledWake(root, "3-1-cc.json", ["feature"], at);
  assert.equal(cancelScheduledWakes(root, ["qa"]), 2);
  assert.equal(fs.existsSync(only), false);
  const rewritten = readJsonFile<{ roles: string[]; notBeforeMs: number }>(shared);
  assert.deepEqual(rewritten?.roles, ["feature"]);
  assert.equal(rewritten?.notBeforeMs, at);
  assert.deepEqual(readJsonFile<{ roles: string[] }>(other)?.roles, ["feature"]);
});

test("cancelScheduledWakes with a role list drops each listed role", () => {
  const root = tmpdir();
  const at = Date.now() + 60_000;
  const a = scheduledWake(root, "1-1-aa.json", ["qa"], at);
  const b = scheduledWake(root, "2-1-bb.json", ["qa", "feature", "clean"], at);
  const c = scheduledWake(root, "3-1-cc.json", ["clean"], at);
  const d = scheduledWake(root, "4-1-dd.json", ["feature"], at);
  assert.equal(cancelScheduledWakes(root, ["qa", "clean"]), 3);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(c), false);
  const rewritten = readJsonFile<{ roles: string[]; notBeforeMs: number }>(b);
  assert.deepEqual(rewritten?.roles, ["feature"]);
  assert.equal(rewritten?.notBeforeMs, at);
  assert.deepEqual(readJsonFile<{ roles: string[] }>(d)?.roles, ["feature"]);
});

test("cancelScheduledWakes tolerates a missing directory", () => {
  assert.equal(cancelScheduledWakes(tmpdir()), 0);
});
