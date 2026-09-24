import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  consumeAbortRequests,
  consumeResetRequest,
  consumeWakeRequest,
  type AbortableLanding,
} from "../src/operator-requests.js";
import { readEvents } from "../src/events.js";
import {
  abortRequestPath,
  resetRequestPath,
  wakeRequestPath,
  STATE_DIR,
} from "../src/paths.js";
import type { LoopRunner } from "../src/loop.js";
import { tmpdir } from "./util.js";

/** A recording stand-in for LoopRunner covering exactly the surface operator-requests.ts
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

function writeMarker(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test("consumeResetRequest is a no-op without a marker", () => {
  const root = tmpdir();
  const a = fakeRunner("coverage");
  consumeResetRequest(root, asRunners(a));
  assert.equal(a.resets, 0);
  assert.equal(readEvents(root).filter((e) => e.type === "counters_reset").length, 0);
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
  const events = readEvents(root).filter((e) => e.type === "counters_reset");
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
  const events = readEvents(root).filter((e) => e.type === "counters_reset");
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
  assert.equal(readEvents(root).filter((e) => e.type === "counters_reset").length, 0);
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
  const events = readEvents(root).filter((e) => e.type === "wake");
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
  const events = readEvents(root).filter((e) => e.type === "tick_aborted");
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
  assert.equal(readEvents(root).filter((e) => e.type === "tick_aborted").length, 0);
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
