import test from "node:test";
import assert from "node:assert/strict";
import { checkBudget, checkPause, checkQuietHours } from "../src/doctor/doctor-holds.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { pauseFleet, pauseRole } from "../src/fleet/fleet-state.js";
import { todayStamp } from "../src/budget/budget.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
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

const BNOW = new Date(2026, 9, 12, 12, 0).getTime();
function budgetRoot(spend: Record<string, number>, stamp = todayStamp(BNOW)): string {
  const root = tmpdir("tw-budget-");
  for (const [role, usd] of Object.entries(spend)) {
    saveLoopState(root, { ...freshLoopState(role), dayCostUsd: usd, dayStamp: stamp });
  }
  return root;
}
const bcfg = (c: object): TumwaterConfig =>
  qcfg({ roles: { feature: { enabled: true }, director: { enabled: true } }, ...c });

test("checkBudget: unreadable config is not checked", () => {
  const r = checkBudget(tmpdir("tw-budget-"), undefined, null, BNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /not checked/);
});

test("checkBudget: cap 0 reports no daily cap", () => {
  const r = checkBudget(budgetRoot({ feature: 3 }), bcfg({ maxDailyCostUsd: 0 }), null, BNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /no daily cap/);
});

test("checkBudget: under 80% is ok", () => {
  const r = checkBudget(budgetRoot({ feature: 2 }), bcfg({ maxDailyCostUsd: 10 }), null, BNOW);
  assert.deepEqual(r, { level: "ok", detail: "$2.00 of $10.00 today" });
});

test("checkBudget: past 80% is ok and says so", () => {
  const r = checkBudget(budgetRoot({ feature: 8 }), bcfg({ maxDailyCostUsd: 10 }), null, BNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /past 80%/);
});

test("checkBudget: a reached cap warns and points at the fallback row", () => {
  const r = checkBudget(budgetRoot({ feature: 10 }), bcfg({ maxDailyCostUsd: 10 }), null, BNOW);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /daily cap reached/);
  assert.match(r.detail, /fallback row/);
});

test("checkBudget: a published figure overrides the persisted sum both ways", () => {
  const cfg = bcfg({ maxDailyCostUsd: 10 });
  assert.equal(checkBudget(budgetRoot({ feature: 1 }), cfg, { spentUsd: 10, capUsd: 10 }, BNOW).level, "warn");
  assert.equal(checkBudget(budgetRoot({ feature: 10 }), cfg, { spentUsd: 1, capUsd: 10 }, BNOW).level, "ok");
});

test("checkBudget: a state stamped yesterday counts $0", () => {
  const root = budgetRoot({ feature: 10 }, todayStamp(BNOW - 86_400_000));
  assert.deepEqual(checkBudget(root, bcfg({ maxDailyCostUsd: 10 }), null, BNOW), { level: "ok", detail: "$0.00 of $10.00 today" });
});

test("checkBudget: a per-role cap reached is named and stays ok", () => {
  const cfg = bcfg({ maxDailyCostUsd: 100, maxDailyCostUsdPerRole: { feature: 1 } });
  const r = checkBudget(budgetRoot({ feature: 1.5 }), cfg, null, BNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /capped loops: feature \(/);
});

test("checkBudget: director spend is never named under a per-role cap", () => {
  const cfg = bcfg({ maxDailyCostUsd: 100, maxDailyCostUsdPerRole: { director: 1 } });
  const r = checkBudget(budgetRoot({ director: 5 }), cfg, null, BNOW);
  assert.doesNotMatch(r.detail, /capped loops/);
});
