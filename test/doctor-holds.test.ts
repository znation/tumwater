import test from "node:test";
import assert from "node:assert/strict";
import { checkPause } from "../src/doctor/doctor-holds.js";
import { pauseFleet, pauseRole } from "../src/fleet/fleet-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

test("checkPause: no markers is ok", () => {
  assert.deepEqual(checkPause(tmpdir("tw-hold-")), { level: "ok", detail: "not paused" });
});

test("checkPause: an indefinite fleet pause warns and names resume", () => {
  const root = tmpdir("tw-hold-");
  pauseFleet(root);
  const out = checkPause(root);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /tumwater resume/);
});

test("checkPause: a timed fleet pause shows the countdown and reason", () => {
  const root = tmpdir("tw-hold-");
  const now = Date.now();
  pauseFleet(root, now + 90 * 60_000, "deploy freeze");
  const out = checkPause(root, now);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /auto-resumes in/);
  assert.match(out.detail, /"deploy freeze"/);
});

test("checkPause: paused roles alone are ok and named", () => {
  const root = tmpdir("tw-hold-");
  pauseRole(root, "cleanup");
  const out = checkPause(root);
  assert.equal(out.level, "ok");
  assert.match(out.detail, /cleanup/);
});

test("checkPause: fleet pause plus a paused role warns and names the role", () => {
  const root = tmpdir("tw-hold-");
  pauseFleet(root);
  pauseRole(root, "cleanup");
  const out = checkPause(root);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /cleanup/);
});

test("checkPause: an expired fleet pause reads as not paused", () => {
  const root = tmpdir("tw-hold-");
  pauseFleet(root, Date.now() - 1000);
  assert.equal(checkPause(root).detail, "not paused");
});
