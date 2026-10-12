import test from "node:test";
import assert from "node:assert/strict";
import { checkPause, checkQuietHours } from "../src/doctor/doctor-holds.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
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

const qcfg = (c: object): TumwaterConfig => c as TumwaterConfig;
const at = (h: number, m = 0): Date => new Date(2026, 9, 12, h, m);

test("checkQuietHours: no config or an empty one is none configured", () => {
  assert.deepEqual(checkQuietHours(undefined, at(12)), { level: "ok", detail: "none configured" });
  assert.deepEqual(checkQuietHours(qcfg({}), at(12)), { level: "ok", detail: "none configured" });
});

test("checkQuietHours: a fleet window warns inside it (wrapping midnight) and is ok outside", () => {
  const cfg = qcfg({ quietHours: "23:00-07:00" });
  for (const [h, m] of [[23, 30], [1, 0]]) {
    const r = checkQuietHours(cfg, at(h!, m));
    assert.equal(r.level, "warn");
    assert.match(r.detail, /until 07:00/);
    assert.match(r.detail, /director is exempt/);
  }
  const out = checkQuietHours(cfg, at(12));
  assert.equal(out.level, "ok");
  assert.match(out.detail, /23:00-07:00/);
  assert.match(out.detail, /not in the window/);
});

test("checkQuietHours: a held per-role window is ok and named; an idle one is not", () => {
  const cfg = qcfg({ quietHoursPerRole: { cleanup: "09:00-17:00" } });
  const held = checkQuietHours(cfg, at(12));
  assert.equal(held.level, "ok");
  assert.match(held.detail, /cleanup until 17:00/);
  assert.deepEqual(checkQuietHours(cfg, at(18)), { level: "ok", detail: "per-role windows set, none holding now" });
});

test("checkQuietHours: the director's window is never named", () => {
  const r = checkQuietHours(qcfg({ quietHoursPerRole: { director: "00:00-23:59" } }), at(12));
  assert.doesNotMatch(r.detail, /director/);
});

test("checkQuietHours: fleet window plus a held role warns and names the role", () => {
  const r = checkQuietHours(qcfg({ quietHours: "09:00-17:00", quietHoursPerRole: { cleanup: "09:00-17:00" } }), at(12));
  assert.equal(r.level, "warn");
  assert.match(r.detail, /; quiet loops: cleanup until 17:00/);
});

test("checkQuietHours: a malformed window reads as none configured", () => {
  assert.deepEqual(checkQuietHours(qcfg({ quietHours: "nope" }), at(12)), { level: "ok", detail: "none configured" });
});
