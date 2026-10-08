import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  consumeAbortRequests,
  consumeReclaimRequest,
  consumeResetRequest,
  consumeWakeRequest,
  type AbortableLanding,
} from "../src/operator/operator-requests.js";
import { readEvents } from "../src/events/event-read.js";
import {
  abortRequestPath,
  eventsLogPath,
  reclaimRequestPath,
  resetRequestPath,
  statePath,
  wakeRequestPath,
  STATE_DIR,
} from "../src/paths.js";
import type { LoopRunner } from "../src/loop/loop.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { readJsonFile } from "../src/files/json-files.js";
import { eventsOfType, writeMarker } from "./log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** A recording stand-in for LoopRunner covering exactly the surface operator/operator-requests.ts
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

function asRunners(...rs: FakeRunner[]): LoopRunner[] {
  return rs as unknown as LoopRunner[];
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

test("consumeResetRequest resets only the named roles and logs one loop event", () => {
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
  assert.equal(events[0]?.loop, "coverage");
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
  assert.equal(events[0]?.loop, "harness");
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
  // the marker while a fleet is live) can reach it only here: the consumer is the state file's
  // single writer while the fleet runs.
  saveLoopState(root, { ...loadLoopState(root, "docs"), role: "docs", ticks: 7, commits: 3 });
  writeMarker(resetRequestPath(root), { roles: ["docs"] });
  consumeResetRequest(root, asRunners(a));
  assert.equal(a.resets, 0);
  const s = readJsonFile<{ ticks: number; commits: number }>(statePath(root, "docs"));
  assert.equal(s?.ticks, 0, "the runnerless role's counters are zeroed on disk");
  assert.equal(s?.commits, 0);
  assert.equal(fs.existsSync(resetRequestPath(root)), false);
  const events = eventsOfType(root, "counters_reset");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "docs");
});

test("consumeWakeRequest clears the schedule of a named role that has no live runner", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  saveLoopState(root, {
    ...loadLoopState(root, "docs"),
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
  assert.equal(events[0]?.loop, "docs");
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
  assert.equal(events[0]?.loop, "clean");
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
  assert.equal(events[0]?.loop, "coverage");
});

test("consumeWakeRequest reads a non-numeric notBeforeMs as immediate", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  writeMarker(wakeRequestPath(root), { at: Date.now(), roles: ["coverage"], notBeforeMs: "soon" });
  consumeWakeRequest(root, asRunners(a));
  assert.equal(a.wakes, 1, "defensive: validation happens at the CLI, the consumer only gates on numbers");
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

test("consumeAbortRequests aborts a running role's tick and logs tick_aborted", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage", true);
  const marker = abortRequestPath(root, "coverage");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(a), []);
  assert.equal(a.aborts, 1);
  assert.equal(fs.existsSync(marker), false);
  const events = eventsOfType(root, "tick_aborted");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.loop, "coverage");
});

test("consumeAbortRequests silently clears a marker for an idle role", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage", false);
  const marker = abortRequestPath(root, "coverage");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(a), []);
  assert.equal(a.aborts, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(eventsOfType(root, "tick_aborted").length, 0);
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

test("consumeAbortRequests marks and aborts the in-flight landing for any batched role", () => {
  const root = tmpdir();
  const controller = new AbortController();
  const landing: AbortableLanding = {
    roles: ["clean", "coverage"],
    userAborted: false,
    controller,
  };
  const marker = abortRequestPath(root, "coverage");
  writeMarker(marker, { at: 1 });
  consumeAbortRequests(root, asRunners(), [landing]);
  assert.equal(landing.userAborted, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(fs.existsSync(marker), false);
});

test("consumeAbortRequests stops whichever of several in-flight landings holds the role, and only that one", () => {
  // Land-queue speed 2c: each change being vetted is its own unit, beside the merge slot's.
  const root = tmpdir();
  const unit = (roles: string[]): AbortableLanding => ({ roles, userAborted: false, controller: new AbortController() });
  const vetA = unit(["clean"]);
  const vetB = unit(["coverage"]);
  const merge = unit(["feature", "dry"]);
  writeMarker(abortRequestPath(root, "coverage"), { at: 1 });
  writeMarker(abortRequestPath(root, "dry"), { at: 1 });
  consumeAbortRequests(root, asRunners(), [vetA, vetB, merge]);
  assert.equal(vetA.userAborted || vetA.controller.signal.aborted, false, "another vet runs on");
  assert.equal(vetB.userAborted && vetB.controller.signal.aborted, true);
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
  // tick_aborted append. The pre-fix broad catch swallowed that throw and skipped every
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
