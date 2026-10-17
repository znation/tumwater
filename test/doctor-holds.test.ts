import test from "node:test";
import assert from "node:assert/strict";
import { checkBudget, checkClaudeWindow, checkErrorStreaks, checkMainRed, checkMaintenanceQuota, checkPause, checkProviderHolds, checkQuietHours } from "../src/doctor/doctor-holds.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { pauseTeam, pauseRole } from "../src/team/team-state.js";
import { todayStamp } from "../src/budget/budget.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { humanSeconds } from "../src/text/datetime.js";
import { ERROR_STREAK_BREAKER, ERROR_STREAK_WARN } from "../src/tick/tick-apply.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

test("checkPause: no markers is ok", () => {
  assert.deepEqual(checkPause(tmpdir("tw-hold-")), { level: "ok", detail: "not paused" });
});

test("checkPause: an indefinite team pause warns and names resume", () => {
  const root = tmpdir("tw-hold-");
  pauseTeam(root);
  const out = checkPause(root);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /tumwater resume/);
});

test("checkPause: a timed team pause shows the countdown and reason", () => {
  const root = tmpdir("tw-hold-");
  const now = Date.now();
  pauseTeam(root, now + 90 * 60_000, "deploy freeze");
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

test("checkPause: team pause plus a paused role warns and names the role", () => {
  const root = tmpdir("tw-hold-");
  pauseTeam(root);
  pauseRole(root, "cleanup");
  const out = checkPause(root);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /cleanup/);
});

test("checkPause: an expired team pause reads as not paused", () => {
  const root = tmpdir("tw-hold-");
  pauseTeam(root, Date.now() - 1000);
  assert.equal(checkPause(root).detail, "not paused");
});

const qcfg = (c: object): TumwaterConfig => c as TumwaterConfig;
const at = (h: number, m = 0): Date => new Date(2026, 9, 12, h, m);

test("checkQuietHours: no config or an empty one is none configured", () => {
  assert.deepEqual(checkQuietHours(undefined, at(12)), { level: "ok", detail: "none configured" });
  assert.deepEqual(checkQuietHours(qcfg({}), at(12)), { level: "ok", detail: "none configured" });
});

test("checkQuietHours: a team window warns inside it (wrapping midnight) and is ok outside", () => {
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

test("checkQuietHours: team window plus a held role warns and names the role", () => {
  const r = checkQuietHours(qcfg({ quietHours: "09:00-17:00", quietHoursPerRole: { cleanup: "09:00-17:00" } }), at(12));
  assert.equal(r.level, "warn");
  assert.match(r.detail, /; quiet roles: cleanup until 17:00/);
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
  assert.match(r.detail, /over-cap model row/);
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
  assert.match(r.detail, /capped roles: feature \(/);
});

test("checkBudget: director spend is never named under a per-role cap", () => {
  const cfg = bcfg({ maxDailyCostUsd: 100, maxDailyCostUsdPerRole: { director: 1 } });
  const r = checkBudget(budgetRoot({ director: 5 }), cfg, null, BNOW);
  assert.doesNotMatch(r.detail, /capped roles/);
});

const MNOW = new Date(2026, 9, 12, 12, 0).getTime();
const mcfg = (c: object = {}): TumwaterConfig =>
  qcfg({ maintenancePerWorkMerge: 2, roles: { feature: { enabled: true }, clean: { enabled: true } }, ...c });
function mergedRoot(role: string, n: number): string {
  const root = tmpdir("tw-mq-");
  writeEvents(root, Array.from({ length: n }, (_, i) => ({ ts: MNOW - 3_600_000, loop: role, type: "merged", commit: `m${i}` })));
  return root;
}

test("checkMaintenanceQuota: under the allowance is ok and shows used/allowance", () => {
  const r = checkMaintenanceQuota(mergedRoot("clean", 3), mcfg(), true, MNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /3\/12 maintenance merges/);
});

test("checkMaintenanceQuota: a full window warns and names the held loops", () => {
  const r = checkMaintenanceQuota(mergedRoot("clean", 12), mcfg(), true, MNOW);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /12\/12/);
  assert.match(r.detail, /: clean$/);
});

test("checkMaintenanceQuota: a dead team's running flag is not in flight", () => {
  const root = mergedRoot("clean", 11);
  saveLoopState(root, { ...freshLoopState("clean"), running: true });
  assert.match(checkMaintenanceQuota(root, mcfg(), false, MNOW).detail, /^11\/12 /);
  const live = mergedRoot("clean", 11);
  saveLoopState(live, { ...freshLoopState("clean"), running: true });
  assert.equal(checkMaintenanceQuota(live, mcfg(), true, MNOW).level, "warn");
});

test("checkMaintenanceQuota: no maintenance role enabled is ok and says so", () => {
  const r = checkMaintenanceQuota(mergedRoot("clean", 12), mcfg({ roles: { feature: { enabled: true } } }), true, MNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /no maintenance role enabled$/);
});

test("checkMaintenanceQuota: unreadable config is not checked", () => {
  const r = checkMaintenanceQuota(tmpdir("tw-mq-"), undefined, true, MNOW);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /not checked/);
});

const CW_NOW = 1_800_000_000_000;

test("checkClaudeWindow: no account, or an API-billed rejected window, is ok", () => {
  const root = tmpdir("tw-hold-");
  const none = checkClaudeWindow(root, CW_NOW);
  assert.equal(none.level, "ok");
  assert.match(none.detail, /no subscription window reported/);
  writeClaudeAccount(root, {
    billing: "api",
    observedAt: CW_NOW,
    windows: { five_hour: { status: "rejected", resetsAt: CW_NOW + 7_200_000, observedAt: CW_NOW } },
  });
  assert.equal(checkClaudeWindow(root, CW_NOW).level, "ok");
});

test("checkClaudeWindow: a rejected subscription window warns with the countdown", () => {
  const root = tmpdir("tw-hold-");
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: CW_NOW,
    windows: { five_hour: { status: "rejected", resetsAt: CW_NOW + 7_200_000, observedAt: CW_NOW } },
  });
  const out = checkClaudeWindow(root, CW_NOW);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /5h window rejected/);
  assert.ok(out.detail.includes(humanSeconds(7200)));
});

test("checkClaudeWindow: a chain naming a moved tier says it moved to fallbacks", () => {
  const root = tmpdir("tw-hold-");
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: CW_NOW,
    windows: { five_hour: { status: "rejected", resetsAt: CW_NOW + 7_200_000, observedAt: CW_NOW } },
  });
  const chain = { default: { pair: "p/m", step: 2, of: 3, reason: "window" as const } };
  const out = checkClaudeWindow(root, CW_NOW, chain);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /5h window rejected — default moved to fallbacks until it resets in/);
  assert.doesNotMatch(out.detail, /wait/);
  const cfg = { model: { default: "claude/claude-sonnet-5-5", strong: "claude/claude-opus-5-5" } } as unknown as TumwaterConfig;
  assert.match(checkClaudeWindow(root, CW_NOW, chain, cfg).detail, /; small, strong wait$/);
});

test("checkClaudeWindow: overage, an elapsed reset, a warning, and no windows are all ok", () => {
  const root = tmpdir("tw-hold-");
  const seed = (w: Record<string, { status: string; resetsAt?: number; utilization?: number; isUsingOverage?: boolean; observedAt: number }>) =>
    writeClaudeAccount(root, { billing: "subscription", observedAt: CW_NOW, windows: w });
  seed({ five_hour: { status: "rejected", resetsAt: CW_NOW + 7_200_000, isUsingOverage: true, observedAt: CW_NOW } });
  assert.equal(checkClaudeWindow(root, CW_NOW).level, "ok");
  seed({ five_hour: { status: "rejected", resetsAt: CW_NOW, observedAt: CW_NOW - 1000 } });
  assert.equal(checkClaudeWindow(root, CW_NOW).level, "ok");
  seed({ five_hour: { status: "allowed_warning", utilization: 0.83, resetsAt: CW_NOW + 1000, observedAt: CW_NOW } });
  const warning = checkClaudeWindow(root, CW_NOW);
  assert.equal(warning.level, "ok");
  assert.match(warning.detail, /nearing its limit/);
  assert.match(warning.detail, /83% used/);
  seed({});
  assert.match(checkClaudeWindow(root, CW_NOW).detail, /no window reported yet/);
});

function streakRoot(streaks: Record<string, number>, lastError = "boom"): string {
  const root = tmpdir("tw-streak-");
  for (const [id, n] of Object.entries(streaks)) {
    saveLoopState(root, { ...freshLoopState(id), consecutiveErrors: n, lastError });
  }
  return root;
}

test("checkErrorStreaks: unreadable config is not checked", () => {
  const r = checkErrorStreaks(tmpdir("tw-streak-"), undefined);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /not checked/);
});

test("checkErrorStreaks: no streak, or one below the warn bar, is ok", () => {
  assert.deepEqual(checkErrorStreaks(tmpdir("tw-streak-"), bcfg({})), { level: "ok", detail: "no role failing repeatedly" });
  const r = checkErrorStreaks(streakRoot({ feature: ERROR_STREAK_WARN - 1 }), bcfg({}));
  assert.equal(r.level, "ok");
});

test("checkErrorStreaks: an unpaused loop at the warn bar warns with count and squashed last error", () => {
  const r = checkErrorStreaks(streakRoot({ feature: ERROR_STREAK_WARN }, "line one\n   line two"), bcfg({}));
  assert.equal(r.level, "warn");
  assert.match(r.detail, /failing run after run: feature: 3 failed runs — last error: line one line two/);
  assert.doesNotMatch(r.detail, /paused/);
});

test("checkErrorStreaks: a paused loop at the breaker bar names the resume command", () => {
  const root = streakRoot({ feature: ERROR_STREAK_BREAKER });
  pauseRole(root, "feature");
  const r = checkErrorStreaks(root, bcfg({}));
  assert.equal(r.level, "warn");
  assert.match(r.detail, /paused at the repeated-failure pause's bar/);
  assert.match(r.detail, /tumwater resume --role feature/);
});

test("checkErrorStreaks: instance 1 paused under feature-1 reads as paused and names that key", () => {
  const root = streakRoot({ feature: ERROR_STREAK_BREAKER });
  pauseRole(root, "feature-1");
  const r = checkErrorStreaks(root, bcfg({}));
  assert.match(r.detail, /paused at the repeated-failure pause's bar/);
  assert.match(r.detail, /tumwater resume --role feature-1`/);
});

test("checkErrorStreaks: a paused loop below the breaker is just paused", () => {
  const root = streakRoot({ feature: ERROR_STREAK_WARN });
  pauseRole(root, "feature");
  const r = checkErrorStreaks(root, bcfg({}));
  assert.match(r.detail, /feature: 3 failed runs, paused — last error/);
  assert.doesNotMatch(r.detail, /resume/);
});

test("checkErrorStreaks: a second instance is reported under its own id", () => {
  const cfg = qcfg({ roles: { feature: { enabled: true, instances: 2 } } });
  const r = checkErrorStreaks(streakRoot({ "feature-2": 5 }), cfg);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /feature #2: 5 failed runs/);
});

const RED = "main abc is red (npm test: 2 failing) — authoring skipped until main is green";

function redRoot(extra: Record<string, unknown> = {}): string {
  const root = tmpdir("tw-mainred-");
  saveLoopState(root, { ...freshLoopState("feature"), lastResult: "main_red", lastError: RED, lastRunEndedAt: 1000, ...extra });
  return root;
}

test("checkMainRed: unreadable config is not checked", () => {
  const r = checkMainRed(tmpdir("tw-mainred-"), undefined);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /not checked/);
});

test("checkMainRed: no loop at main_red is ok", () => {
  assert.deepEqual(checkMainRed(tmpdir("tw-mainred-"), bcfg({})), { level: "ok", detail: "no role waiting on main's check" });
});

test("checkMainRed: a held code loop warns naming it, the count, and the squashed error", () => {
  const r = checkMainRed(redRoot(), bcfg({}));
  assert.equal(r.level, "warn");
  assert.match(r.detail, /main's check is failing; 1 code role waiting: feature — main abc is red \(npm test: 2 failing\)/);
});

test("checkMainRed: a loop with a queued summary is ok", () => {
  assert.equal(checkMainRed(redRoot({ queuedSummary: "x" }), bcfg({})).level, "ok");
});

test("checkMainRed: a passed landing check newer than the red tick retires the hold", () => {
  const root = redRoot();
  writeEvents(root, [{ ts: 2000, loop: "feature", type: "build_check", scope: "merge", status: "passed" }]);
  assert.equal(checkMainRed(root, bcfg({})).level, "ok");
});

test("checkMainRed: the detail names the bugfix loop as repairer only when one is enabled", () => {
  const without = checkMainRed(redRoot(), bcfg({}));
  assert.match(without.detail, /no bugfix role is enabled/);
  const withBugfix = checkMainRed(redRoot(), qcfg({ roles: { feature: { enabled: true }, bugfix: { enabled: true } } }));
  assert.match(withBugfix.detail, /the bugfix role is exempt and repairs it/);
});

const PH_NOW = Date.now();

const providerHold = (o: Record<string, unknown>): Record<string, unknown> => ({ loop: "harness", type: "rate_limit_hold", ts: PH_NOW, holdMs: 3600_000, kind: "rate-limit", roles: ["feature", "qa"], ...o });
const providerResumed = (o: Record<string, unknown>): Record<string, unknown> => ({ loop: "harness", type: "rate_limit_resumed", ts: PH_NOW + 10_000, kind: "rate-limit", ...o });

function phRoot(lines: unknown[]): string {
  const root = tmpdir("tw-hold-");
  writeEvents(root, lines);
  return root;
}

test("checkProviderHolds: no rate_limit events read ok", () => {
  assert.deepEqual(checkProviderHolds(phRoot([]), PH_NOW), { level: "ok", detail: "no provider holds" });
});

test("checkProviderHolds: a standing hold warns naming provider, kind, roles, and re-open", () => {
  const out = checkProviderHolds(phRoot([providerHold({ provider: "deepinfra" })]), PH_NOW);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /deepinfra/);
  assert.match(out.detail, /rate-limit/);
  assert.match(out.detail, /feature, qa/);
  assert.match(out.detail, /re-opens in/);
});

test("checkProviderHolds: a resumed event clears the hold", () => {
  const out = checkProviderHolds(phRoot([providerHold({ provider: "deepinfra" }), providerResumed({ provider: "deepinfra" })]), PH_NOW);
  assert.deepEqual(out, { level: "ok", detail: "no provider holds" });
});

test("checkProviderHolds: a hold whose deadline passed reads ok", () => {
  const out = checkProviderHolds(phRoot([providerHold({ provider: "deepinfra", ts: PH_NOW, holdMs: 0 })]), PH_NOW);
  assert.deepEqual(out, { level: "ok", detail: "no provider holds" });
});

test("checkProviderHolds: a provider-undefined hold names pi's default backend", () => {
  const out = checkProviderHolds(phRoot([providerHold({})]), PH_NOW);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /pi's default backend/);
});

test("checkProviderHolds: other event types are ignored", () => {
  const out = checkProviderHolds(phRoot([{ loop: "feature", type: "run_end", ts: PH_NOW, tokens: 1 }, { loop: "feature", type: "merge_done", ts: PH_NOW, commit: "a" }]), PH_NOW);
  assert.deepEqual(out, { level: "ok", detail: "no provider holds" });
});

test("checkProviderHolds: a backend-failure kind is named verbatim", () => {
  const out = checkProviderHolds(phRoot([providerHold({ provider: "deepinfra", kind: "connection", roles: ["reviewer"] })]), PH_NOW);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /connection/);
  assert.match(out.detail, /reviewer/);
});
