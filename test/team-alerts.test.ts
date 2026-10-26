import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { alertNeedsYou, teamAlerts, type AlertRole, type BacklogHeadingDuplicate } from "../src/ui/team-alerts.js";
import { phaseTone, resultTone } from "../src/ui/tone.js";
import { clientScope } from "./helpers/gui-client-scope.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { planDependencyAlert, notifyFailures, primaryOverwriteBlocks, quarantineAlert, skippedMergeFiles, staleMerges, stalePrompts } from "../src/ui/alert-feeds.js";
import { strandedPlanEntriesFor } from "../src/backlog/backlog-structure.js";
import { renderStatus } from "../src/ui/status-render.js";
import { snapshot } from "../src/status/status-data.js";
import { makeRepo, writeBacklogFile, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { enqueueRolePrompt } from "../src/inbox/inbox.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { mergeQueueDir, quarantinePath, configPath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { postReviewPath } from "../src/paths.js";
import { defaultConfig } from "../src/config/config.js";
import { CI_PARITY_STALE_MS } from "../src/run/ci-parity.js";
import { QA_COVERAGE_STALE_MS } from "../src/run/qa-coverage.js";
import { writeMergeMarker } from "../src/merge/merge-slot.js";
import { warnEvent } from "../src/events/events.js";
import { notifyExitWarning } from "../src/events/notify.js";
import { FLAKY_WARNING_PREFIX } from "../src/review/known-flakes.js";

// team-alerts.ts's teamAlerts: what needs the operator, phrased once for the dashboard's alert
// banners and the TUI's attention lines.

type Snap = Parameters<typeof teamAlerts>[0];
const base: Snap = {
  running: true,
  budget: { spentUsd: 1, capUsd: 10, capHitAt: null, free: false, fallback: null },
  build: null,
  paused: false,
  inQuietHours: false,
  imageProbeFailures: [],
  capPaused: [],
  budgetPausedRoles: [],
  maintenanceQuota: { allowance: 0, used: 0, held: [] },
};

test("a healthy team raises nothing; a stopped one says how to start it", () => {
  assert.deepEqual(teamAlerts(base, [], [], Date.now()), []);
  const stopped = teamAlerts({ ...base, running: false }, [], [], Date.now());
  assert.deepEqual(stopped.map((a) => [a.key, a.tone]), [["stopped", "gray"]]);
  assert.equal(stopped.filter(alertNeedsYou).length, 0, "information does not count as needing you");
});

test("a tier on a fallback step raises one informational alert", () => {
  const chain = { default: { pair: "DeepSeek-V4-Flash", step: 2, of: 2, reason: "window" as const } };
  const alerts = teamAlerts({ ...base, chain }, [], [], Date.now());
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]?.detail ?? "", /^running on fallback: default → DeepSeek-V4-Flash/);
  assert.equal(alertNeedsYou(alerts[0]!), false);
  assert.deepEqual(teamAlerts({ ...base, chain: {} }, [], [], Date.now()), []);
});

test("a spent budget pauses the roles, or hands them to the free fallback", () => {
  const spent: Snap = {
    ...base,
    budget: { spentUsd: 10.5, capUsd: 10, capHitAt: null, free: false, fallback: null },
  };
  const [budget] = teamAlerts(spent, [], [], Date.now());
  assert.equal(budget?.key, "budget");
  assert.equal(budget?.tone, "red");
  assert.match(budget?.detail ?? "", /Spent \$10\.50 of the \$10 cap/);
  assert.deepEqual(budget?.actions.map((a) => a.act), ["budget"]);
  const onFallback = teamAlerts({ ...spent, budget: { ...spent.budget, fallback: { provider: "local", model: "small-model" } } }, [], [], Date.now());
  assert.equal(onFallback[0]?.key, "fallback");
  assert.equal(onFallback[0]?.tone, "blue", "the team keeps working, so it informs rather than alarms");
  assert.match(onFallback[0]?.detail ?? "", /^small-model carries them/);
  // A claude fallback (PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7): the pair's
  // provider IS the backend id, so it renders agent-qualified, never a bare model id.
  const claudeFallback = teamAlerts(
    { ...spent, budget: { ...spent.budget, fallback: { backend: "claude", provider: "claude", model: "claude-sonnet-5-5" } } },
    [],
    [],
    Date.now(),
  )[0];
  assert.equal(claudeFallback?.key, "fallback");
  assert.match(claudeFallback?.detail ?? "", /claude\/claude-sonnet-5-5 carries them/);
  assert.deepEqual(teamAlerts({ ...spent, budget: { ...spent.budget, free: true } }, [], [], Date.now()), [], "an all-free team has no cap to hit");
  assert.deepEqual(teamAlerts({ ...spent, budget: { ...spent.budget, capUsd: 0 } }, [], [], Date.now()), [], "no cap, nothing spent against it");

  // Tiered fallback (part 7b/8): with the snapshot's tier map standing (two or more distinct
  // pairs), the detail lists each tier's pair, borrowed ones marked, instead of naming just
  // the default tier's.
  const tiered = teamAlerts(
    { ...spent, budget: { ...spent.budget, fallback: { provider: "free", model: "qwen-free" }, tiers: { small: "free/qwen-free (from default)", default: "free/qwen-free", strong: "free/llama-free" } } },
    [], [], Date.now(),
  );
  assert.equal(tiered[0]?.key, "fallback");
  assert.match(tiered[0]?.detail ?? "", /^small: free\/qwen-free \(from default\), default: free\/qwen-free, strong: free\/llama-free carry them/);

  // The budget banner names the roles whose tier has no usable free pair (gate-polls.ts's
  // budgetPausedRoles): the roles that moved sit next to the ones that stopped, one sentence
  // each, so a spent cap never reads as if every role kept working. Each held id renders
  // through listRoleIds (a stale id still appears); with none held the detail is byte-identical
  // to the tier sentence above.
  const split = teamAlerts(
    {
      ...spent,
      budget: {
        ...spent.budget,
        fallback: { provider: "free", model: "qwen-free" },
        tiers: { small: "free/qwen-free (from default)", default: "free/qwen-free", strong: "free/llama-free" },
      },
      budgetPausedRoles: ["coverage", "docs", "stale-role"],
    },
    [], [], Date.now(),
  );
  assert.equal(split[0]?.key, "fallback");
  assert.match(
    split[0]?.detail ?? "",
    /coverage, docs, and stale-role have no free pair and stay paused until local midnight\.$/,
  );
  const noPaused = teamAlerts(
    {
      ...spent,
      budget: {
        ...spent.budget,
        fallback: { provider: "free", model: "qwen-free" },
        tiers: { small: "free/qwen-free (from default)", default: "free/qwen-free", strong: "free/llama-free" },
      },
    },
    [], [], Date.now(),
  )[0];
  assert.match(
    noPaused?.detail ?? "",
    /^small: free\/qwen-free \(from default\), default: free\/qwen-free, strong: free\/llama-free carry them at no cost until midnight\.$/,
    "empty budgetPausedRoles keeps today's exact tier sentence",
  );
});

// Quiet hours 2/2: the schedule holding the team informs rather than asks (blue, no
// actions), and only while the local clock is actually inside the window — outside it the
// header's standing quiet badge already carries the schedule, so an alert would be noise.
test("quiet hours raise one informational alert only while the window holds", () => {
  const outside = teamAlerts({ ...base, quietHours: "23:00-07:00", inQuietHours: false }, [], [], Date.now());
  assert.deepEqual(outside.filter((a) => a.key === "quiet"), []);

  const [quiet] = teamAlerts({ ...base, quietHours: "23:00-07:00", inQuietHours: true }, [], [], Date.now());
  assert.equal(quiet?.key, "quiet");
  assert.equal(quiet?.tone, "blue");
  assert.match(quiet?.title ?? "", /Quiet hours — roles start no new runs until 07:00/);
  assert.match(quiet?.detail ?? '', /\(23:00-07:00 local time, quietHours in tumwater.json\)/);
  assert.deepEqual(quiet?.actions, []);
  assert.equal(alertNeedsYou(quiet!), false, "a schedule is information, not a request");
});

test("role trouble, a stale build, questions, and a pause, most urgent first", () => {
  const now = Date.now();
  const roles: AlertRole[] = [
    { role: "bugfix", phase: "failing", errorStreak: true, inFlight: false, lastError: "429 Rate limit exceeded" },
    { role: "qa", phase: "failing", errorStreak: true, inFlight: false },
    { role: "feature", phase: "working 30m · turn 2 · tool call stalled: bash", errorStreak: false, inFlight: true, stuckMs: 720_000 },
    { role: "coverage", phase: "main's check is failing", errorStreak: false, inFlight: false },
    { role: "docs", phase: "working 1m · turn 1 · no agent output for 6m00s", errorStreak: false, inFlight: true, stuckMs: 360_000 },
    { role: "idle", phase: "sleeping (for 5m)", errorStreak: false, inFlight: false },
  ];
  const alerts = teamAlerts(
    { ...base, paused: true, pausedUntil: now + 12 * 60_000,
      build: { sha: "abc", builtAt: 0, stale: true, aheadCommits: 3, restartBlocked: "cooldown until 2026-09-30T10:00:54.269Z" } },
    ["Q1: which database? (asked 2026-09-29)", "Q2: tabs or spaces?"],
    roles,
    now,
  );
  assert.deepEqual(alerts.map((a) => a.key), ["mainred", "failing", "stuck", "build", "questions", "paused"]);
  const by = Object.fromEntries(alerts.map((a) => [a.key, a]));
  assert.equal(by.mainred?.title, "main's check is failing — 1 role is blocked");
  assert.equal(by.mainred?.detail, "Code roles keep authoring on top of a red main; the ci healer owns the failing check.");
  assert.equal(by.failing?.title, "bugfix and qa are failing run after run");
  assert.equal(by.failing?.detail, "bugfix: 429 Rate limit exceeded · qa: see its transcript");
  assert.deepEqual(by.failing?.actions.map((a) => [a.act, a.arg]), [["role", "bugfix"], ["role", "qa"]], "each failing role opens from the alert");
  assert.equal(by.stuck?.title, "feature and docs look stuck");
  // The tool-call stall gains the honest silence span from stuckMs (" for 12m00s"); the
  // "no agent output for 6m00s" phrase already carries its duration, so it does not double even
  // with a stuckMs present.
  assert.equal(by.stuck?.detail, "feature: tool call stalled: bash for 12m00s · docs: no agent output for 6m00s");
  assert.equal(by.build?.tone, "blue");
  assert.equal(by.build?.title, "Update available (3 commits behind) — restarts after cooldown; work continues");
  assert.match(by.build?.detail ?? "", /Work continues on the running build; the restart lands when the cooldown lapses or you force it \(cooldown until /, "a cooldown deferral reads work-continues with its deadline");
  assert.doesNotMatch(by.build?.detail ?? "", /T10:00:54/, "ISO instants read in local time");
  assert.equal(by.questions?.title, "2 questions need your answer");
  assert.equal(by.questions?.detail, "Q1: which database? — and 1 more", "a question's date note is metadata, not the question");
  assert.equal(by.paused?.title, "The team is paused and resumes in 12m");
  // A cooldown-deferred restart is informational (blue, no action): work continues, so it no
  // longer counts as needing the operator — the red/amber/indigo count drops to 5.
  assert.equal(alerts.filter(alertNeedsYou).length, 5);
  // A cooldown-deferred restart is the plan's whole point: the redeploy waits, the team does
  // not — blue "work continues" with the deadline, not the amber "restart blocked" of a real
  // block (PLANS.md 2026-10-23).
  const deferred = teamAlerts({ ...base, build: { sha: "abc", builtAt: 0, stale: true, aheadCommits: 1, restartBlocked: "cooldown until 2026-10-23T13:04:00.000Z" } }, [], [], now);
  assert.deepEqual(deferred.map((a) => [a.key, a.tone, a.title]), [["build", "blue", "Update available (1 commit behind) — restarts after cooldown; work continues"]]);
  // The in-flight drain that precedes the swap is the one stale state that actually holds new
  // work, so it keeps the plain wording rather than claiming work continues.
  const draining = teamAlerts({ ...base, build: { sha: "abc", builtAt: 0, stale: true, aheadCommits: 1, restartPending: true } }, [], [], now);
  assert.deepEqual(draining.map((a) => [a.key, a.tone, a.title]), [["build", "blue", "Update available (1 commit behind) — restarts when idle"]]);
  // A standing pause has no countdown; an expired deadline is not claimed.
  assert.equal(teamAlerts({ ...base, paused: true }, [], [], now)[0]?.title, "The team is paused");
  assert.equal(teamAlerts({ ...base, paused: true, pausedUntil: now - 1 }, [], [], now)[0]?.title, "The team is paused");

  // The operator's why (`pause --reason <text>`) states verbatim in the title, timed or not.
  const withWhy = teamAlerts({ ...base, paused: true, pauseReason: "deploying to prod" }, [], [], now);
  assert.equal(withWhy[0]?.title, "The team is paused — \"deploying to prod\"");
  const timedWhy = teamAlerts({ ...base, paused: true, pausedUntil: now + 12 * 60_000, pauseReason: "deploying to prod" }, [], [], now);
  assert.equal(timedWhy[0]?.title, "The team is paused and resumes in 12m — \"deploying to prod\"");
});

// The always-on red `mainred` alert names the failing test and the merge the main watch
// blamed from the snapshot's mainCheck.red detail, when the data exists; with none, today's
// generic wording stands (covered by the healthy/no-mainCheck cases above).
test("the mainred alert names the failing test and the culprit", () => {
  const now = Date.now();
  const alerts = teamAlerts(
    { ...base, mainCheck: { status: "failed", at: now, red: { failingTests: ["test/merge.test.ts"], culprit: { commit: "abc123", runner: "feature" } } } },
    [],
    [{ role: "coverage", phase: "main's check is failing", errorStreak: false, inFlight: false }],
    now,
  );
  const red = alerts.find((a) => a.key === "mainred");
  assert.equal(red?.title, "main's check is failing — 1 role is blocked");
  assert.match(red?.detail ?? "", /test\/merge\.test\.ts/);
  assert.match(red?.detail ?? "", /feature/);
  assert.deepEqual(red?.actions.map((a) => [a.act, a.arg]), [["view", "failures"]]);
});

// The alert copy's count forms beyond the two-role case above: a lone role reads singular,
// three or more list as "a, b, and c", and a failing set where no role recorded an error
// points at the transcripts instead of repeating an empty error list.
test("a lone failing or stuck role reads singular; three roles list as a, b, and c", () => {
  const now = Date.now();
  const [one] = teamAlerts(base, [], [{ role: "bugfix", phase: "failing", errorStreak: true, inFlight: false, lastError: "pi exited null" }], now);
  assert.equal(one?.title, "bugfix is failing run after run");
  assert.equal(one?.detail, "bugfix: pi exited null");
  const three: AlertRole[] = [
    { role: "bugfix", phase: "failing", errorStreak: true, inFlight: false },
    { role: "qa", phase: "failing", errorStreak: true, inFlight: false },
    { role: "docs", phase: "failing", errorStreak: true, inFlight: false },
  ];
  const [many] = teamAlerts(base, [], three, now);
  assert.equal(many?.title, "bugfix, qa, and docs are failing run after run");
  assert.equal(many?.detail, "The streak clears only on the next healthy run; the transcript names each failure.");
  assert.deepEqual(many?.actions.map((a) => a.arg), ["bugfix", "qa", "docs"]);
  const [stuckOne] = teamAlerts(
    base,
    [],
    [{ role: "feature", phase: "working 30m · turn 2 · tool call stalled: bash", errorStreak: false, inFlight: true }],
    now,
  );
  assert.equal(stuckOne?.key, "stuck");
  assert.equal(stuckOne?.title, "feature looks stuck");
  // No stuckMs: the fallback keeps today's detail — the stall cause with no duration suffix.
  assert.equal(stuckOne?.detail, "feature: tool call stalled: bash");
});

// A failing streak is the alert's tell, not the rendered phase: while a role's own run is in
// progress the phase reads "working"/"merging", but the red "failing run after run"
// banner must stay up (it clears only when the streak resets) — BUGS.md 2026-10-14. A plain
// working role with no streak raises nothing.
test("a streak behind a working label still raises the failing alert; a healthily working role raises none", () => {
  const now = Date.now();
  const streakWorking: AlertRole[] = [
    { role: "bugfix", phase: "working 30s · turn 2 · reading BUGS.md", errorStreak: true, inFlight: true, lastError: "review rejected: not converging" },
  ];
  const [alert] = teamAlerts(base, [], streakWorking, now);
  assert.equal(alert?.key, "failing");
  assert.equal(alert?.tone, "red");
  assert.equal(alert?.title, "bugfix is failing run after run");
  assert.equal(alert?.detail, "bugfix: review rejected: not converging");
  assert.deepEqual(alert?.actions.map((a) => [a.act, a.arg]), [["role", "bugfix"]]);

  const healthyWorking: AlertRole[] = [
    { role: "feature", phase: "working 30s · turn 1", errorStreak: false, inFlight: true },
    { role: "qa", phase: "merging 1s · build-check", errorStreak: false, inFlight: true },
  ];
  assert.equal(teamAlerts(base, [], healthyWorking, now).filter((a) => a.key === "failing").length, 0);
});

// The detail arms the two-role case above cannot reach: a fallback named by provider alone
// (model unset) or by nothing at all, and a stale build that is neither restart-blocked nor
// already restarting — the operator has to restart the team by hand, so the alert says so.
test("a fallback names its provider or nothing; a plain stale build asks for a manual restart", () => {
  const spent = (fallback: Snap["budget"]["fallback"]): Snap => ({
    ...base,
    budget: { spentUsd: 10, capUsd: 10, capHitAt: null, free: false, fallback },
  });
  const byProvider = teamAlerts(spent({ provider: "local" }), [], [], Date.now());
  assert.equal(byProvider[0]?.key, "fallback");
  assert.match(byProvider[0]?.detail ?? "", /^local carries them/);
  const unnamed = teamAlerts(spent({}), [], [], Date.now());
  assert.match(unnamed[0]?.detail ?? "", /^The fallback carries them/);

  const stale = teamAlerts({ ...base, build: { sha: "abc", builtAt: 0, stale: true, aheadCommits: 2 } }, [], [], Date.now());
  assert.deepEqual(stale.map((a) => [a.key, a.tone, a.title]), [
    ["build", "blue", "Update available (2 commits behind)"],
  ]);
  assert.equal(stale[0]?.detail, "Restart tumwater start to pick it up.");
});

// The dashboard colors phases and results in its own tones; the TUI in the terminal's. Both
// must tell the same story: what the page shows blue/violet/orange/indigo (work in progress)
// the terminal shows blue, and so on down the families.
// A role over its maxDailyCostUsdPerRole cap (status-model.ts "waiting: daily cap spent") and
// the maintenance allowance ("waiting: maintenance allowance used <used>/<allowance>") each
// stop whole roles and each get a team banner, so an operator sees why roles are idling without
// reading every row. The cap hold is an amber ask (raise the cap); the maintenance hold informs
// (gray, self-clearing — roles run again as work merges).
test("a role over its daily cap raises one amber role-cap alert; an empty hold raises none", () => {
  const held = teamAlerts(
    { ...base, capPaused: ["feature"] },
    [],
    [{ role: "feature", phase: "idle: daily cap spent", errorStreak: false, inFlight: false }],
    Date.now(),
  );
  const [cap] = held.filter((a) => a.key === "role-cap");
  assert.equal(cap?.tone, "amber");
  assert.match(cap?.title ?? "", /feature/);
  assert.match(cap?.detail ?? "", /maxDailyCostUsdPerRole/);
  assert.match(cap?.detail ?? "", /midnight/);
  assert.deepEqual(cap?.actions, [{ label: "Open feature", act: "role", arg: "feature" }]);
  assert.equal(alertNeedsYou(cap!), true, "a raise is needed — it asks");
  assert.deepEqual(
    teamAlerts({ ...base, capPaused: [] }, [], [], Date.now()).filter((a) => a.key === "role-cap"),
    [],
  );
  // A stale id no live role matches still names the held role in the copy.
  const stale = teamAlerts({ ...base, capPaused: ["gremlin"] }, [], [], Date.now()).filter((a) => a.key === "role-cap");
  assert.equal(stale.length, 1);
  assert.match(stale[0]?.detail ?? "", /gremlin/);
});

test("the maintenance allowance hold raises one gray maintenance alert; an empty hold raises none", () => {
  const organize = { role: "organize", phase: "waiting: maintenance allowance used 3/3", errorStreak: false, inFlight: false };
  const clean = { role: "clean", phase: "waiting: maintenance allowance used 3/3", errorStreak: false, inFlight: false };
  const held = teamAlerts(
    { ...base, maintenanceQuota: { allowance: 3, used: 3, held: ["organize", "clean"] } },
    [],
    [organize, clean],
    Date.now(),
  );
  const [maintenance] = held.filter((a) => a.key === "maintenance");
  assert.equal(maintenance?.tone, "gray");
  assert.match(maintenance?.detail ?? "", /3 of 3/);
  assert.match(maintenance?.detail ?? "", /organize/);
  assert.match(maintenance?.detail ?? "", /clean/);
  assert.deepEqual(maintenance?.actions, []);
  assert.equal(alertNeedsYou(maintenance!), false, "self-clearing — it informs, not asks");
  assert.deepEqual(
    teamAlerts({ ...base, maintenanceQuota: { allowance: 3, used: 1, held: [] } }, [], [], Date.now()).filter((a) => a.key === "maintenance"),
    [],
  );
});

// A standing provider failure hold (src/team/team-hold.ts `standingHolds`, published through
// the orchestrator info file): a provider storm holds roles on that provider, so an operator
// watching idle roles with no log open sees why. Self-clearing by design, so it informs (blue,
// no actions) like the quiet and maintenance alerts rather than asking.
test("a standing provider failure hold raises one blue provider-hold alert; an empty hold raises none", () => {
  const now = Date.now();
  const held = teamAlerts(
    { ...base, providerHolds: [{ provider: "deepinfra", until: now + 120_000, kind: "rate-limit" }] },
    [],
    [],
    now,
  );
  const [alert] = held.filter((a) => a.key === "provider-hold");
  assert.equal(alert?.tone, "blue");
  assert.match(alert?.title ?? "", /Provider limit is holding new runs/);
  assert.match(alert?.detail ?? "", /deepinfra/);
  assert.match(alert?.detail ?? "", /rate-limit/);
  assert.match(alert?.detail ?? "", /re-opens in 2m/);
  assert.deepEqual(alert?.actions, []);
  assert.equal(alertNeedsYou(alert!), false, "self-clearing — it informs, not asks");

  // A second entry with no provider names pi's default backend; the title turns plural.
  const two = teamAlerts(
    {
      ...base,
      providerHolds: [
        { provider: "deepinfra", until: now + 120_000, kind: "rate-limit" },
        { until: now + 60_000, kind: "connection" },
      ],
    },
    [],
    [],
    now,
  );
  const [pluralAlert] = two.filter((a) => a.key === "provider-hold");
  assert.match(pluralAlert?.title ?? "", /Provider limits are holding new runs/);
  assert.match(pluralAlert?.detail ?? "", /pi's default backend/);
  assert.match(pluralAlert?.detail ?? "", /connection/);

  // Absent or empty providerHolds raises none.
  assert.equal(teamAlerts(base, [], [], now).filter((a) => a.key === "provider-hold").length, 0);
  assert.equal(
    teamAlerts({ ...base, providerHolds: [] }, [], [], now).filter((a) => a.key === "provider-hold").length,
    0,
  );
});

test("the terminal's tones and the dashboard's tell the same story", () => {
  const { phaseInfo, resultInfo } = clientScope<{
    phaseInfo(phase: string): { tone: string };
    resultInfo(result: string): { tone: string };
  }>(["format", "labels", "view-model"], ["phaseInfo", "resultInfo"]);
  const family: Record<string, string | undefined> = { blue: "blue", violet: "blue", orange: "blue", indigo: "blue", red: "red", amber: "yellow", gray: undefined };
  for (const phase of ["working 1m", "reviewing 2m", "merging 1m · merging", "approved, waiting to merge", "waiting to start 5s", "failing", "main's check is failing",
    "paused", "waiting: budget spent", "waiting: daily cap spent", "waiting: low disk", "waiting: bootstrap", "sleeping (for 5m)", "due", "ready for messages", "stopped"]) {
    const page = phaseInfo(phase).tone;
    // Awaiting a slot is pipeline work (blue) in the terminal; the page draws it quietly gray.
    if (phase.startsWith("waiting to start")) continue;
    assert.equal(phaseTone(phase), family[page], `${phase}: page ${page}`);
  }
  const resultFamily: Record<string, string | undefined> = { green: "green", indigo: "cyan", red: "red", amber: "yellow", gray: undefined };
  for (const result of ["changed", "queued", "refused", "no_change", "merge_conflict", "merge_blocked", "rejected", "review_error", "error",
    "aborted", "quiet_killed", "user_aborted", "main_red", "skipped"]) {
    assert.equal(resultTone(result), resultFamily[resultInfo(result).tone], result);
  }
});

// The disk floor (plans/disk-floor.md, part 4/4): a hold raises one amber alert naming the
// reading and the floor. Below the reclaim threshold but not held is the header badge's
// quieter business, so it raises no alert; no disk block raises nothing.
test("a waiting: low disk raises one amber alert naming the free space and the floor", () => {
  const held = teamAlerts(
    { ...base, disk: { freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true } },
    [], [], Date.now(),
  );
  const [disk] = held.filter((a) => a.key === "disk");
  assert.equal(disk?.tone, "amber");
  assert.match(disk?.title ?? "", /8\.2 GB free/);
  assert.match(disk?.detail ?? "", /10 GB floor/);
  assert.deepEqual(
    teamAlerts({ ...base, disk: { freeGB: 30, holdGB: 10, reclaimGB: 40, held: false } }, [], [], Date.now()).filter((a) => a.key === "disk"),
    [],
    "low but not held: no alert",
  );
  assert.deepEqual(teamAlerts(base, [], [], Date.now()), [], "no disk block: nothing new");
});

// Image input, part 5/5 (plans/image-input.md "Surfaces"): the images alert. No alert when
// every enabled role reads images (or capability is unknown — an unknown seam is not counted
// as text-only). Blue when every text-only role has a reroute target (a blind read reruns — an
// inform, not an ask); amber when some text-only role has none (a blind read fails and image
// submissions are refused). A separate amber when a claimed model failed doctor's live probe.
test("images alert: parity needs no alert; a text-only team with targets is blue", () => {
  const vision: AlertRole[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: true, imageReroute: null },
    { role: "plan", phase: "idle", errorStreak: false, inFlight: false, imageInput: true, imageReroute: null },
  ];
  assert.deepEqual(teamAlerts(base, [], vision, Date.now()).filter((a) => a.key === "images"), []);
  // Unknown capability is not counted as text-only — no alert, matching the doctor's stance.
  const unknown: AlertRole[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: null, imageReroute: null },
  ];
  assert.deepEqual(teamAlerts(base, [], unknown, Date.now()).filter((a) => a.key === "images"), []);

  const rerouting: AlertRole[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: false, imageReroute: "strong (claude-opus-5-5)" },
    { role: "organize", phase: "idle", errorStreak: false, inFlight: false, imageInput: false, imageReroute: "strong (claude-opus-5-5)" },
  ];
  const [images] = teamAlerts(base, [], rerouting, Date.now()).filter((a) => a.key === "images");
  assert.equal(images?.tone, "blue");
  assert.equal(images?.title, "feature and organize run on models that can't read images");
  assert.match(images?.detail ?? "", /stops and reruns on strong \(claude-opus-5-5\)\./);
  assert.equal(alertNeedsYou(images!), false, "a rerun means nothing fails — it informs");
});

test("images alert: a text-only role with no target is amber and asks", () => {
  const noTarget: AlertRole[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: false, imageReroute: null },
    { role: "bugfix", phase: "idle", errorStreak: false, inFlight: false, imageInput: false, imageReroute: "strong (claude-opus-5-5)" },
  ];
  const [images] = teamAlerts(base, [], noTarget, Date.now()).filter((a) => a.key === "images");
  assert.equal(images?.tone, "amber");
  assert.equal(images?.title, "No configured model can read images for feature");
  assert.match(images?.detail ?? "", /image attachments to these roles are refused/);
  assert.equal(images?.actions[0]?.arg, "feature");
  assert.equal(alertNeedsYou(images!), true, "a blind read fails — it asks");
});

test("images alert: a cached probe failure is amber, whatever the roles resolved to", () => {
  const over = teamAlerts({ ...base, imageProbeFailures: ["local/vision"] }, [], [], Date.now());
  const [probe] = over.filter((a) => a.key === "images-probe");
  assert.equal(probe?.tone, "amber");
  assert.match(probe?.title ?? "", /failed doctor's probe/);
  assert.match(probe?.detail ?? "", /local\/vision declare image input but failed/);
  assert.equal(alertNeedsYou(probe!), true);
});

test("refused entries raise a standing amber alert right after the questions alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [{ file: "plans", index: 1, title: "Split X (planned 2026-10-14 by plan)" }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["refused", "amber", "1 refused entry waits on your decision"]]);
  assert.ok(one[0]!.detail.startsWith("Refused plan: Split X ·"));
  assert.ok(one[0]!.detail.includes("--release"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "plans:1" }]);
  const two = teamAlerts(base, [], [], now, [
    { file: "plans", index: 1, title: "A (planned 2026-10-14)" },
    { file: "bugs", index: 0, title: "B (reported 2026-10-14)" },
  ]);
  assert.equal(two[0]!.title, "2 refused entries wait on your decision");
  assert.ok(two[0]!.detail.includes("— and 1 more"));
  // The action lands on the first (named) refused entry: its file and 0-based row.
  assert.equal(two[0]!.actions[0]?.arg, "plans:1");
  const bug = teamAlerts(base, [], [], now, [{ file: "bugs", index: 3, title: "C (reported 2026-10-14)" }]);
  assert.ok(bug[0]!.detail.startsWith("Refused bug: C ·"));
  assert.equal(bug[0]!.actions[0]?.arg, "bugs:3");
  const both = teamAlerts(base, ["Q? (asked 2026-10-14)"], [], now, [{ file: "bugs", index: 0, title: "A" }]);
  assert.deepEqual(both.map((a) => a.key), ["questions", "refused"]);
  assert.deepEqual(teamAlerts(base, [], [], now), []);
});

test("operator-held entries raise an amber alert naming the entry and tumwater plan --release", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [{ file: "plans", index: 2, title: "Held (planned 2026-10-14 by plan)" }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["operator-held", "amber", "1 backlog entry is held for you to release"]]);
  assert.ok(one[0]!.detail.includes("Held"));
  assert.ok(one[0]!.detail.includes("--release"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "plans:2" }]);
  const two = teamAlerts(base, [], [], now, [], [
    { file: "plans", index: 0, title: "A (planned 2026-10-14)" },
    { file: "plans", index: 1, title: "B (planned 2026-10-14)" },
  ]);
  assert.equal(two[0]!.title, "2 backlog entries are held for you to release");
  assert.ok(two[0]!.detail.includes("— and 1 more"));
  assert.deepEqual(two[0]!.actions[0]?.arg, "plans:0");
  // A mixed list (a held plan and a held bug) names each entry with its own file and remedy,
  // so the bug is still handed its `tumwater bug --release` despite the plan being present.
  const mixed = teamAlerts(base, [], [], now, [], [
    { file: "plans", index: 0, title: "P (planned 2026-10-14)" },
    { file: "bugs", index: 3, title: "B" },
  ]);
  assert.equal(mixed[0]!.title, "2 backlog entries are held for you to release");
  assert.ok(mixed[0]!.detail.includes("Plan P") && mixed[0]!.detail.includes("tumwater plan --release"));
  assert.ok(mixed[0]!.detail.includes("Bug B") && mixed[0]!.detail.includes("tumwater bug --release"));
  // An empty list raises no operator-held alert; an empty list on the extra param is fine.
  assert.deepEqual(teamAlerts(base, [], [], now, [], []), []);
});

test("stalled entries raise a standing amber alert naming the first entry and the plan-role fix", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [{ file: "plans", index: 2, title: "Split me (planned 2026-10-20)", hold: "needs-review" }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stalled-entries", "amber", "1 backlog entry is stalled in review"]]);
  assert.ok(one[0]!.detail.includes("Split me"));
  assert.ok(one[0]!.detail.includes("Needs review"));
  assert.ok(one[0]!.detail.includes("plan role"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "plans:2" }]);
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [
    { file: "plans", index: 0, title: "A (planned 2026-10-14)", hold: "needs-review" },
    { file: "plans", index: 1, title: "B (planned 2026-10-14)", hold: "needs-review" },
  ]);
  assert.equal(two[0]!.title, "2 backlog entries are stalled in review");
  assert.ok(two[0]!.detail.includes("Needs review"));
  assert.deepEqual(two[0]!.actions[0]?.arg, "plans:0");
  // An empty list raises no stalled-entries alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], []), []);
  // With both an operator-held row and a stalled row, operator-held precedes stalled-entries.
  const both = teamAlerts(base, [], [], now, [], [{ file: "plans", index: 3, title: "Held (planned 2026-10-14)" }], [], [], [], null, [], [{ file: "plans", index: 2, title: "Split me (planned 2026-10-20)", hold: "needs-review" }]);
  assert.deepEqual(both.map((a) => a.key), ["operator-held", "stalled-entries"]);
});

test("a stalled bug raises the stalled-entries alert and a held bug the operator-held alert", () => {
  const now = Date.now();
  // A Needs-review bug, no stalled plan: one amber stalled-entries alert naming the bug.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [{ file: "bugs", index: 0, title: "Too-large bug", hold: "needs-review" }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stalled-entries", "amber", "1 backlog entry is stalled in review"]]);
  assert.ok(one[0]!.detail.includes("Bug"));
  assert.ok(one[0]!.detail.includes("Too-large bug"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "bugs:0" }]);
  // A bug whose note reached the operator threshold surfaces in the operator-held alert.
  const held = teamAlerts(base, [], [], now, [], [{ file: "bugs", index: 0, title: "Held bug" }], [], [], [], null, [], []);
  assert.deepEqual(held.map((a) => [a.key, a.tone, a.title]), [["operator-held", "amber", "1 backlog entry is held for you to release"]]);
  assert.ok(held[0]!.detail.includes("Bug"));
  assert.ok(held[0]!.detail.includes("tumwater bug --release"));
  assert.deepEqual(held[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "bugs:0" }]);
});

test("stale open bugs raise a standing amber alert right after the refused alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [{ index: 2, position: 3, title: "Bug hangs on shutdown", days: 3 }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stale-bugs", "amber", "1 open bug waited 3+ days for a fix"]]);
  assert.ok(one[0]!.detail.startsWith('#3 "Bug hangs on shutdown" has waited 3d for a fix'));
  assert.ok(one[0]!.detail.includes("tumwater bug --cancel 3"));
  assert.ok(one[0]!.detail.includes("check that the bugfix role is enabled and not failing"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "bugs:2" }]);
  // Callers feed oldest-first (staleOpenBugs sorts most-days-waited first), so the first entry
  // is the most-stale bug and the one the alert names.
  const three = teamAlerts(base, [], [], now, [], [], [
    { index: 4, position: 5, title: "B", days: 5 },
    { index: 6, position: 7, title: "C", days: 4 },
    { index: 0, position: 1, title: "A", days: 3 },
  ]);
  assert.equal(three[0]!.title, "3 open bugs waited 3+ days for a fix");
  assert.match(three[0]!.detail ?? "", /— and 1 more/);
  assert.equal(three[0]!.actions[0]?.arg, "bugs:4");
  const afterRefused = teamAlerts(base, ["Q?"], [], now, [{ file: "bugs", index: 0, title: "A" }], [], [{ index: 9, position: 10, title: "Z", days: 6 }]);
  assert.deepEqual(afterRefused.map((a) => a.key), ["questions", "refused", "stale-bugs"]);
  assert.deepEqual(teamAlerts(base, [], [], now), []);
  assert.deepEqual(teamAlerts(base, [], [], now, [], []), []);
});

test("the stale-questions alert names the oldest and folds the rest", () => {
  const now = Date.now();
  const two = teamAlerts(base, ["Q?"], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [
    { index: 2, position: 3, title: "Which database?", days: 8 },
    { index: 4, position: 5, title: "Tabs or spaces?", days: 7 },
  ]);
  // The questions arg makes the indigo questions alert precede the amber stale-questions one.
  assert.deepEqual(two.map((a) => a.key), ["questions", "stale-questions"]);
  const sq = two.filter((a) => a.key === "stale-questions");
  assert.deepEqual(sq.map((a) => [a.key, a.tone, a.title]), [["stale-questions", "amber", "2 open questions waited 7+ days for an answer"]]);
  const d = sq[0]!.detail ?? "";
  assert.ok(d.startsWith('#3 "Which database?" has waited 8d for an answer'), d);
  assert.ok(d.includes("· Tabs or spaces?"), d);
  assert.ok(d.includes("tumwater questions answer 3 \"<decision>\""), d);
  assert.ok(d.includes("or close it in QUESTIONS.md"), d);
  assert.deepEqual(sq[0]!.actions, [{ label: "Answer", act: "questions" }]);
  // A short-argument call (the existing pattern) raises no stale-questions alert.
  assert.deepEqual(teamAlerts(base, [], [], now), []);
  assert.equal(teamAlerts(base, [], [], now, [], [], [{ index: 0, position: 1, title: "B", days: 3 }]).filter((a) => a.key === "stale-questions").length, 0);
});

function daysAgo(n: number, now: number): string {
  return new Date(now - n * 86_400_000).toISOString().slice(0, 10);
}

test("staleOpenBugs and the surfaces carry a stale-bug alert from BUGS.md, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  writeBacklogFile(root, "BUGS.md", [
    {
      heading: "## Open",
      body: [
        `### Bug one (found by bugfix ${daysAgo(3, now)})`,
        "",
        "Repro.",
        "",
        `### Oldest bug (found by bugfix ${daysAgo(5, now)})`,
        "",
        "Repro.",
        "",
        `### Fresh (reported ${daysAgo(1, now)})`,
        "",
        `### Refused (found by bugfix ${daysAgo(9, now)})`,
        "",
        "**Refused 2026-10-10 by bugfix: not a bug**",
      ].join("\n"),
    },
    { heading: "## Fixed" },
  ]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string; actions?: Array<{ arg?: string }> }> };
  const alert = payload.alerts.find((a) => a.key === "stale-bugs");
  // staleOpenBugs names the longest-waited bug first even when it is not first in the file.
  assert.equal(alert?.title, "2 open bugs waited 3+ days for a fix");
  assert.ok(alert?.detail?.startsWith('#2 "Oldest bug" has waited 5d for a fix'));
  assert.equal(alert?.actions?.[0]?.arg, "bugs:1");
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /2 open bugs waited 3\+ days for a fix/);
  // The doctor's skip rules: a two-day-old bug, a refused bug, and a Needs-review-parked
  // old bug each yield no stale-bugs alert, on every surface.
  const clean = makeRepo();
  writeBacklogFile(clean, "BUGS.md", [
    { heading: "## Open", body: `### Fresh (reported ${daysAgo(2, now)})\n\n### Parked (found by bugfix ${daysAgo(9, now)})\n\n**Needs review ${daysAgo(0, now)} by bugfix: what would make it fail**` },
    { heading: "## Fixed" },
  ]);
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "stale-bugs"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /open bug waited/);
});

test("a failed notify page raises a standing amber alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], { count: 1, latestTs: now - 3600_000, message: "notify command exited with code 127 paging budget_paused" });
  // notifyFailure is the 18th positional argument; one position earlier
  // it would land in the skippedMergeFiles slot and raise no notify alert.
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["notify", "amber", "1 failed notify page in the last day"]]);
  assert.match(one[0]!.detail ?? "", /1h ago/);
  assert.match(one[0]!.detail ?? "", /code 127/);
  assert.match(one[0]!.detail ?? "", /tumwater notify --test/);
  assert.deepEqual(one[0]!.actions, []);
  // Two failures read plural; the detail names the latest only.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], { count: 2, latestTs: now - 2 * 3600_000, message: "notify command exited with code 1 paging paused" });
  assert.match(two[0]!.title, /2 failed notify pages in the last day/);
  assert.match(two[0]!.detail ?? "", /2h ago/);
  // A null last argument adds no alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], ), []);
  // With both a stale bug and a notify failure, the keys are [stale-bugs, notify].
  const both = teamAlerts(base, [], [], now, [], [], [{ index: 2, position: 3, title: "Bug hangs", days: 3 }], [], [], null, [], [], null, [], [], [], { count: 1, latestTs: now - 60_000, message: "notify command exited with code 127 paging paused" });
  assert.deepEqual(both.map((a) => a.key), ["stale-bugs", "notify"]);
});

test("notifyFailures and the surfaces carry a notify alert from failed pages, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  warnEvent(root, "tumwater", notifyExitWarning("budget_paused", 127, null) ?? "");
  assert.equal(notifyFailures(root, now)?.count, 1);
  assert.match(notifyFailures(root, now)?.message ?? "", /^notify command exited with code 127/);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string }> };
  assert.equal(payload.alerts.find((a) => a.key === "notify")?.title, "1 failed notify page in the last day");
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /failed notify page in the last day/);
  // A feature-sourced warning and a clean root each produce none.
  const foreign = makeRepo();
  warnEvent(foreign, "feature", notifyExitWarning("budget_paused", 127, null) ?? "");
  assert.equal(notifyFailures(foreign, now), null);
  assert.equal((statusPayload(foreign, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "notify"), undefined);
  const clean = makeRepo();
  assert.equal(notifyFailures(clean, now), null);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /failed notify page/);
  // A failure older than 24h produces none, on every surface.
  const old = makeRepo();
  warnEvent(old, "tumwater", notifyExitWarning("budget_paused", 127, null) ?? "");
  assert.equal(notifyFailures(old, now + 25 * 3600_000), null);
  assert.equal((statusPayload(old, now + 25 * 3600_000) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "notify"), undefined);
});

test("a merge refused by an uncommitted primary file raises one standing amber alert", () => {
  const now = Date.now();
  const blockObj = { count: 2, latestTs: now - 3600_000, message: "merge blocked: the merge would overwrite files in the primary checkout (uncommitted: PLANS.md) — commit, stash or remove them there" };
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, blockObj);
  // primaryOverwrite is the 19th positional argument, after notifyFailure (null); one position
  // earlier it would land in the validationGaps slot and raise no primary-overwrite alert.
  assert.deepEqual(alerts.map((a) => [a.key, a.tone, a.title]), [["primary-overwrite", "amber", "2 merges were refused by files uncommitted in your primary checkout"]]);
  assert.match(alerts[0]!.detail ?? "", /1h ago/);
  assert.match(alerts[0]!.detail ?? "", /uncommitted: PLANS.md/);
  assert.match(alerts[0]!.detail ?? "", /tumwater doctor --commit-backlog/);
  assert.deepEqual(alerts[0]!.actions, []);
  // One refusal reads singular.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, { count: 1, latestTs: now - 60_000, message: "merge blocked: the merge would overwrite files in the primary checkout (uncommitted: PLANS.md) — commit, stash or remove them there" });
  assert.match(one[0]!.title, /1 merge was refused/);
  // A null last argument adds no alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null), []);
});

test("primaryOverwriteBlocks and the surfaces carry a primary-overwrite alert from overwrite-block warnings, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  warnEvent(root, "feature", "merge blocked: the merge would overwrite files in the primary checkout (uncommitted: PLANS.md) — commit, stash or remove them there");
  assert.equal(primaryOverwriteBlocks(root, now)?.count, 1);
  assert.match(primaryOverwriteBlocks(root, now)?.message ?? "", /uncommitted: PLANS.md/);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string }> };
  assert.equal(payload.alerts.find((a) => a.key === "primary-overwrite")?.title, "1 merge was refused by files uncommitted in your primary checkout");
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /merge was refused by files uncommitted in your primary checkout/);
  // A warning without the marker, and a clean root, each produce none.
  const foreign = makeRepo();
  warnEvent(foreign, "feature", "pi exited 1");
  assert.equal(primaryOverwriteBlocks(foreign, now), null);
  assert.equal((statusPayload(foreign, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "primary-overwrite"), undefined);
  const clean = makeRepo();
  assert.equal(primaryOverwriteBlocks(clean, now), null);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /refused by files uncommitted/);
  // A warning older than the day-long window produces none, on every surface.
  const old = makeRepo();
  warnEvent(old, "feature", "merge blocked: the merge would overwrite files in the primary checkout (uncommitted: PLANS.md) — commit, stash or remove them there");
  assert.equal(primaryOverwriteBlocks(old, now + 25 * 3600_000), null);
  assert.equal((statusPayload(old, now + 25 * 3600_000) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "primary-overwrite"), undefined);
});

test("a stalled merge queue raises a standing amber alert right after the stale-prompt alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [], [], [{ role: "feature", summary: "add the parser", waitedMs: 7 * 3600_000 }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stale-merges", "amber", "1 queued merge waited 6+ hours to start"]]);
  assert.match(one[0]!.detail ?? "", /feature/);
  assert.match(one[0]!.detail ?? "", /add the parser/);
  assert.match(one[0]!.detail ?? "", /7h/);
  assert.match(one[0]!.detail ?? "", /tumwater queue/);
  assert.deepEqual(one[0]!.actions, []);
  // Callers feed oldest-first (staleMerges reads queuedMerges in queue-file order), so the
  // first element is the longest-waiting merge and the one the alert names; an empty list
  // argument adds none.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [
    { role: "feature", summary: "A", waitedMs: 7 * 3600_000 },
    { role: "organize", summary: "B", waitedMs: 6.5 * 3600_000 },
  ]);
  assert.match(two[0]!.title ?? "", /queued merges waited/);
  assert.deepEqual(teamAlerts(base, [], [], now), []);
  const withBugs = teamAlerts(base, [], [], now, [], [], [{ index: 0, position: 1, title: "B", days: 3 }], [], [{ role: "feature", summary: "S", waitedMs: 7 * 3600_000 }]);
  assert.deepEqual(withBugs.map((a) => a.key), ["stale-bugs", "stale-merges"]);
});

test("stale queued prompts raise a standing amber alert right after the stale-bug alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [], [{ role: "feature", position: 2, waitedMs: 25 * 60 * 60 * 1000 }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stale-prompts", "amber", "1 queued prompt waited 1+ day for its role"]]);
  assert.match(one[0]!.detail ?? "", /^inbox prompt for feature #2 has waited/);
  assert.match(one[0]!.detail ?? "", /paused, disabled, or failing/);
  assert.match(one[0]!.detail ?? "", /tumwater prompt --cancel 2 --role feature/);
  assert.deepEqual(one[0]!.actions, [{ label: "Open inbox", act: "queued" }]);
  // Callers feed oldest-first (stalePrompts sorts by queuedAtMs ascending), so the first entry
  // is the most-stale prompt and the one the alert names; the rest are folded like the refused
  // and questions alerts (three entries give the "— and 1 more" fold).
  const three = teamAlerts(base, [], [], now, [], [], [], [
    { role: "organize", position: 1, waitedMs: 27 * 60 * 60 * 1000 },
    { role: "feature", position: 3, waitedMs: 26 * 60 * 60 * 1000 },
    { role: "feature", position: 1, waitedMs: 25 * 60 * 60 * 1000 },
  ]);
  assert.match(three[0]!.title ?? "", /3 queued prompts waited/);
  assert.match(three[0]!.detail ?? "", /feature #3/);
  assert.match(three[0]!.detail ?? "", /— and 1 more/);
  const withBugs = teamAlerts(base, [], [], now, [], [], [{ index: 0, position: 1, title: "B", days: 3 }], [{ role: "feature", position: 1, waitedMs: 25 * 60 * 60 * 1000 }]);
  assert.deepEqual(withBugs.map((a) => a.key), ["stale-bugs", "stale-prompts"]);
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], []), []);
});

/** A repo whose tumwater.json lists the given roles, so listWideScope resolves them the way the
 * list-shaped views do (the same fixture the doctor's stale-prompt tests use). */
function promptRepo(roles: string[]): string {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ roles: Object.fromEntries(roles.map((r) => [r, { enabled: true }])) }));
  return root;
}

/** Enqueue a prompt for a role, then rename its queue file to an old 13-digit stamp
 * (`${stamp}-000000-1.md`, the name queueFileStamp parses into queuedAtMs) so the wait reads
 * as `stamp` instead of now. */
function stampPrompt(root: string, role: string, stamp: number, notBefore?: number): void {
  const file = enqueueRolePrompt(root, role, `prompt for ${role}`, notBefore);
  fs.renameSync(file, path.join(path.dirname(file), `${stamp}-000000-1.md`));
}

test("stalePrompts and the surfaces carry a stale-prompt alert from the inbox, and none without one", () => {
  const now = Date.now();
  const root = promptRepo(["feature"]);
  stampPrompt(root, "feature", now - 25 * 60 * 60 * 1000);
  assert.deepEqual(stalePrompts(root, now).map((p) => ({ role: p.role, position: p.position })), [{ role: "feature", position: 1 }]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string; actions?: Array<{ act?: string }> }> };
  const alert = payload.alerts.find((a) => a.key === "stale-prompts");
  assert.equal(alert?.title, "1 queued prompt waited 1+ day for its role");
  assert.match(alert?.detail ?? "", /feature #1/);
  assert.equal(alert?.actions?.[0]?.act, "queued");
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /queued prompt waited 1\+ day for its role/);
  // The doctor's skip rules: a prompt stamped exactly 24 h ago (not strictly past it; the
  // boundary is exercised under the shared `now`, since renderStatus stales against its own
  // fresh clock) and a deferred prompt whose not-before time is still in the future each add
  // no stale-prompt alert.
  const clean = promptRepo(["feature"]);
  stampPrompt(clean, "feature", now - 24 * 60 * 60 * 1000);
  stampPrompt(clean, "feature", now - 25 * 60 * 60 * 1000, now + 60 * 60 * 1000);
  assert.deepEqual(stalePrompts(clean, now), []);
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "stale-prompts"), undefined);
  // The render surface stales against its own clock (Date.now), so a clearly-fresh prompt
  // proves the surface stays quiet without depending on the exact-threshold boundary.
  const fresh = promptRepo(["feature"]);
  stampPrompt(fresh, "feature", now - 5 * 60 * 60 * 1000);
  assert.doesNotMatch(renderStatus(fresh, snapshot(fresh, undefined, now)), /queued prompt waited/);
});

test("staleMerges and the surfaces carry a stale-merge alert from the queue, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  fs.mkdirSync(mergeQueueDir(root), { recursive: true });
  enqueueMerge(root, { role: "feature", summary: "add the parser", enqueuedAt: now - 7 * 3600_000, sha: "abc1234", run: 1 });
  assert.deepEqual(staleMerges(root, now).map((m) => ({ role: m.role, summary: m.summary })), [{ role: "feature", summary: "add the parser" }]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "stale-merges");
  assert.equal(alert?.title, "1 queued merge waited 6+ hours to start");
  assert.match(alert?.detail ?? "", /feature/);
  assert.match(alert?.detail ?? "", /7h/);
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /1 queued merge waited 6\+ hours to start/);
  // The doctor's skip rules, on every surface: an in-flight marker for the only stale
  // entry's role yields none, an entry enqueued exactly at the threshold (not strictly past)
  // yields none, and an empty queue yields none.
  const inFlightRoot = makeRepo();
  fs.mkdirSync(mergeQueueDir(inFlightRoot), { recursive: true });
  enqueueMerge(inFlightRoot, { role: "feature", summary: "add the parser", enqueuedAt: now - 7 * 3600_000, sha: "abc1234", run: 1 });
  writeMergeMarker(inFlightRoot, { role: "feature", sha: "abc1234", summary: "add the parser", startedAt: now - 60_000, stage: "merging", changes: [{ role: "feature", sha: "abc1234", summary: "add the parser", status: "merging" }] });
  assert.deepEqual(staleMerges(inFlightRoot, now), []);
  const fresh = makeRepo();
  fs.mkdirSync(mergeQueueDir(fresh), { recursive: true });
  enqueueMerge(fresh, { role: "feature", summary: "add the parser", enqueuedAt: now - 6 * 3600_000, sha: "abc1234", run: 1 });
  assert.deepEqual(staleMerges(fresh, now), []);
  const freshPayload = statusPayload(fresh, now) as { alerts: Array<{ key: string }> };
  assert.equal(freshPayload.alerts.find((a) => a.key === "stale-merges"), undefined);
  const empty = makeRepo();
  assert.deepEqual(staleMerges(empty, now), []);
  assert.doesNotMatch(renderStatus(empty, snapshot(empty, undefined, now)), /queued merge waited/);
});

test("a skipped merge-queue file raises a standing amber alert right after the stale-merge alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, ["000-torn.json"]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["skipped-merges", "amber", "1 merge-queue file is unreadable"]]);
  assert.match(one[0]!.detail ?? "", /000-torn\.json/);
  assert.match(one[0]!.detail ?? "", /crashed enqueue's merge ref/);
  assert.deepEqual(one[0]!.actions, []);
  // Two paths fold the second through joinWithMore and switch the title to plural.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, ["000-torn.json", "999-foreign.json"]);
  assert.match(two[0]!.title ?? "", /merge-queue files are unreadable/);
  assert.match(two[0]!.detail ?? "", /999-foreign\.json/);
  // An empty argument adds none.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, []), []);
  // The stale-merge alert precedes the skipped-merge alert when both are present.
  const both = teamAlerts(base, [], [], now, [], [], [], [], [{ role: "feature", summary: "S", waitedMs: 7 * 3600_000 }], null, ["000-torn.json"]);
  assert.deepEqual(both.map((a) => a.key), ["stale-merges", "skipped-merges"]);
});

test("skippedMergeFiles and the surfaces carry a skipped-merge alert from the queue, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  fs.mkdirSync(mergeQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(mergeQueueDir(root), "000-torn.json"), '{"role":');
  fs.writeFileSync(path.join(mergeQueueDir(root), "999-foreign.json"), '{"nope":true}');
  assert.deepEqual(skippedMergeFiles(root).map((f) => path.basename(f)).sort(), ["000-torn.json", "999-foreign.json"]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "skipped-merges");
  assert.equal(alert?.title, "2 merge-queue files are unreadable");
  assert.match(alert?.detail ?? "", /000-torn\.json/);
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /merge-queue files are unreadable/);
  // A queue holding only a readable entry (and an absent queue) yield none.
  const clean = makeRepo();
  fs.mkdirSync(mergeQueueDir(clean), { recursive: true });
  enqueueMerge(clean, { role: "feature", summary: "add the parser", enqueuedAt: now, sha: "abc1234", run: 1 });
  assert.deepEqual(skippedMergeFiles(clean), []);
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "skipped-merges"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /merge-queue file/);
  const empty = makeRepo();
  assert.deepEqual(skippedMergeFiles(empty), []);
  assert.doesNotMatch(renderStatus(empty, snapshot(empty, undefined, now)), /merge-queue file/);
});
test("a stale flake quarantine raises a standing amber alert after the skipped-merge alert", () => {
  const now = Date.now();
  const quarantined = { count: 12, oldestTest: "test/old.test.ts", oldestFirstSeen: now - 4 * 24 * 3_600_000, warning: "quarantine holds 12 tests — over the 10-test ceiling" };
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], quarantined);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["quarantine", "amber", "12 tests in the flake quarantine — the gate is excusing their failures"]]);
  assert.match(one[0]!.detail ?? "", /quarantine holds 12 tests/);
  assert.match(one[0]!.detail ?? "", /test\/old\.test\.ts/);
  assert.match(one[0]!.detail ?? "", /4d ago/);
  assert.match(one[0]!.detail ?? "", /BUGS\.md/);
  assert.deepEqual(one[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A null argument adds no alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null), []);
  // With both a stale bug and a quarantine, stale-bugs precedes quarantine.
  const withBug = teamAlerts(base, [], [], now, [], [], [{ index: 2, position: 3, title: "Bug hangs", days: 3 }], [], [], null, [], [], quarantined);
  assert.deepEqual(withBug.map((a) => a.key), ["stale-bugs", "quarantine"]);
  // The skipped-merge alert precedes the quarantine one when both are present.
  const withSkip = teamAlerts(base, [], [], now, [], [], [], [], [], null, ["000-torn.json"], [], quarantined);
  assert.deepEqual(withSkip.map((a) => a.key), ["skipped-merges", "quarantine"]);
});


test("quarantineAlert and the surfaces carry a quarantine alert from an old or oversized list, and none from a fresh one", () => {
  const now = Date.now();
  const root = makeRepo();
  fs.mkdirSync(path.dirname(quarantinePath(root)), { recursive: true });
  fs.writeFileSync(quarantinePath(root), JSON.stringify({ tests: [{ test: "test/old.test.ts", firstSeen: now - 4 * 24 * 3_600_000, lastSeen: now, count: 1, bug: "A hidden flake" }] }));
  assert.equal(quarantineAlert(root, now)?.count, 1);
  assert.equal(quarantineAlert(root, now)?.oldestTest, "test/old.test.ts");
  assert.match(quarantineAlert(root, now)?.warning ?? "", /test\/old\.test\.ts/);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string; actions?: Array<{ label: string }> }> };
  const alert = payload.alerts.find((a) => a.key === "quarantine");
  assert.equal(alert?.title, "1 test in the flake quarantine — the gate is excusing their failures");
  assert.match(alert?.detail ?? "", /oldest: test\/old\.test\.ts/);
  assert.equal(alert?.actions?.[0]?.label, "See failures");
  assert.match(renderStatus(root, snapshot(root, undefined, now)), /flake quarantine/);
  // A fresh small list and an absent quarantine file each produce null and no alert.
  const fresh = makeRepo();
  fs.mkdirSync(path.dirname(quarantinePath(fresh)), { recursive: true });
  fs.writeFileSync(quarantinePath(fresh), JSON.stringify({ tests: [{ test: "test/ok.test.ts", firstSeen: now, lastSeen: now, count: 1 }] }));
  assert.equal(quarantineAlert(fresh, now), null);
  assert.equal((statusPayload(fresh, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "quarantine"), undefined);
  assert.doesNotMatch(renderStatus(fresh, snapshot(fresh, undefined, now)), /flake quarantine/);
  const empty = makeRepo();
  assert.equal(quarantineAlert(empty, now), null);
  assert.equal((statusPayload(empty, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "quarantine"), undefined);
  assert.doesNotMatch(renderStatus(empty, snapshot(empty, undefined, now)), /flake quarantine/);
});

test("root install drift raises one amber install alert naming up to five packages", () => {
  const installs = (rootInstallDrift?: string[]) =>
    teamAlerts({ ...base, rootInstallDrift }, [], [], Date.now()).filter((a) => a.key === "install");
  const two = installs(["ink", "typescript"]);
  assert.equal(two.length, 1);
  assert.equal(two[0]?.tone, "amber");
  assert.match((two[0]?.detail ?? ""), /ink, typescript/);
  assert.match((two[0]?.detail ?? ""), /npm install/);
  assert.deepEqual(installs(), []);
  assert.deepEqual(installs([]), []);
  const seven = (installs(["a", "b", "c", "d", "e", "f", "g"])[0]?.detail ?? "");
  assert.match(seven, /\(a, b, c, d, e, \+2 more\)/);
});

test("no declared check raises one amber no-check alert", () => {
  const alerts = (noDeclaredCheck?: boolean) =>
    teamAlerts({ ...base, noDeclaredCheck }, [], [], Date.now()).filter((a) => a.key === "no-check");
  const one = alerts(true);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.tone, "amber");
  assert.match(one[0]?.title ?? "", /safety gates are off/);
  assert.match(one[0]?.detail ?? "", /check\.command/);
  assert.match(one[0]?.detail ?? "", /build pre-check/);
  assert.match(one[0]?.detail ?? "", /red-main baseline/);
  assert.match(one[0]?.detail ?? "", /redeploy's green check/);
  // The automatic path: the plan role plans the check, the feature role declares it.
  assert.match(one[0]?.detail ?? "", /plan role will plan/);
  assert.match(one[0]?.detail ?? "", /feature role declare it/);
  assert.match(one[0]?.detail ?? "", /test\/typecheck\/build npm script/);
  assert.deepEqual(one[0]?.actions, []);
  assert.deepEqual(alerts(undefined), []);
  assert.deepEqual(alerts(false), []);
});

test("a marker-less brief raises one amber no-brief alert right after no-check", () => {
  const alerts = (noBrief?: boolean) =>
    teamAlerts({ ...base, noBrief }, [], [], Date.now()).filter((a) => a.key === "no-brief");
  const one = alerts(true);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.tone, "amber");
  assert.match(one[0]?.title ?? "", /prompt block/);
  assert.match(one[0]?.detail ?? "", /tumwater:prompt/);
  assert.match(one[0]?.detail ?? "", /tumwater init/);
  assert.deepEqual(one[0]?.actions, []);
  assert.deepEqual(alerts(undefined), []);
  assert.deepEqual(alerts(false), []);

  // With both flag states set, the always-on no-check emits before no-brief.
  const both = teamAlerts({ ...base, noDeclaredCheck: true, noBrief: true }, [], [], Date.now());
  assert.deepEqual(both.map((a) => a.key).filter((k) => k === "no-check" || k === "no-brief"), ["no-check", "no-brief"]);
  const healthy = teamAlerts({ ...base }, [], [], Date.now()).filter((a) => a.key === "no-brief");
  assert.deepEqual(healthy, [], "a healthy team still returns no no-brief alert");
});

test("a broken plan-dependency clause raises a standing amber alert right after the refused alert", () => {
  const now = Date.now();
  const msg = 'PLANS.md plan "S, part 2/2: b" names S 1/2 as a prerequisite without a `requires … landed` clause — the claim allocator ignores that wording and hands the part out now; write it as `requires part i/n landed`';
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], { kind: "misworded", message: msg });
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["plan-dependencies", "amber", "A plan's dependency wording holds nothing"]]);
  assert.equal(one[0]!.detail, msg);
  assert.deepEqual(one[0]!.actions, []);
  // The other three kinds map to their titles.
  const titles = (kind: "cycle" | "dangling" | "unparsed" | "misworded") =>
    teamAlerts(base, [], [], now, [], [], [], [], [], { kind, message: "m" })[0]!.title;
  assert.equal(titles("cycle"), "Plan dependency cycle blocks a whole series");
  assert.equal(titles("dangling"), "A plan requires a part no heading carries");
  assert.equal(titles("unparsed"), "A plan's requires clause names no readable part");
  // A null argument adds no alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null), []);
  // With both a stale bug and a dependency problem, the dependency alert precedes stale-bugs.
  const withBug = teamAlerts(base, [], [], now, [], [], [{ index: 2, position: 3, title: "Bug hangs", days: 3 }], [], [], { kind: "misworded", message: msg });
  assert.deepEqual(withBug.map((a) => a.key), ["plan-dependencies", "stale-bugs"]);
});

test("planDependencyAlert and the surfaces carry a plan-dependency alert from PLANS.md, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    {
      heading: "## Planned",
      body: [
        "### S, part 1/2: a",
        "",
        "body",
        "",
        "### S, part 2/2: b (blocked by part 1/2 above)",
        "",
        "body",
      ].join("\n"),
    },
    { heading: "## Done" },
  ]);
  assert.equal(planDependencyAlert(root)?.kind, "misworded");
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "plan-dependencies");
  assert.equal(alert?.title, "A plan's dependency wording holds nothing");
  assert.ok(alert?.detail?.includes("S 1/2"));
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /A plan's dependency wording holds nothing/);
  // A clean series pair (the child requires its planned parent, found under ## Done) yields none.
  const clean = makeRepo();
  writeBacklogFile(clean, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### S, part 2/2: b (requires part 1/2 landed)\n\nbody",
    },
    { heading: "## Done", body: "### S, part 1/2: a (done 2026-10-01)\n" },
  ]);
  assert.equal(planDependencyAlert(clean), null);
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "plan-dependencies"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /dependency wording holds nothing/);
});

test("stalledEntries and the surfaces carry a stalled-entries alert from PLANS.md, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    {
      heading: "## Planned",
      body: [
        "### Ready (planned 2026-10-04)",
        "",
        "body",
        "",
        "### Needs splitting (planned 2026-10-03)",
        "",
        "**Needs review 2026-10-20 by feature: too large for one run**",
        "",
        "### Needs rework (planned 2026-10-05)",
        "",
        "**Needs review 2026-10-21 by feature: rejected after 1 review round**",
      ].join("\n"),
    },
    { heading: "## Done" },
  ]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string; actions?: Array<{ arg?: string }> }> };
  const alert = payload.alerts.find((a) => a.key === "stalled-entries");
  assert.equal(alert?.title, "2 backlog entries are stalled in review");
  assert.ok(alert?.detail?.includes("Needs splitting"));
  assert.equal(alert?.actions?.[0]?.arg, "plans:1");
  const status = renderStatus(root, snapshot(root, undefined, now));
  assert.match(status, /2 backlog entries are stalled in review/);
  // A held-for-operator plan (a note at the held threshold) yields the operator-held alert
  // and no stalled-entries alert.
  const held = makeRepo();
  writeBacklogFile(held, "PLANS.md", [
    {
      heading: "## Planned",
      body: [
        "### At threshold (planned 2026-10-03)",
        "",
        "**Needs review 2026-10-07 by feature: too large for one run (held 3)**",
      ].join("\n"),
    },
    { heading: "## Done" },
  ]);
  const heldPayload = statusPayload(held, now) as { alerts: Array<{ key: string }> };
  assert.ok(heldPayload.alerts.find((a) => a.key === "operator-held"));
  assert.equal(heldPayload.alerts.find((a) => a.key === "stalled-entries"), undefined);
  // A PLANS.md with only eligible plans produces neither alert.
  const clean = makeRepo();
  writeBacklogFile(clean, "PLANS.md", [
    { heading: "## Planned", body: "### Ready (planned 2026-10-04)\n\nbody" },
    { heading: "## Done" },
  ]);
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "stalled-entries"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /entries are stalled in review/);
});

test("plans filed under the wrong backlog section raise a standing amber alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [
    { title: "Split me (planned 2026-10-20)", section: "Done" },
  ]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [
    ["stranded-plans", "amber", "A plan sits under the wrong backlog section"],
  ]);
  assert.ok((one[0]!.detail ?? "").includes("PLANS.md"));
  assert.ok((one[0]!.detail ?? "").includes("## Done"));
  assert.ok((one[0]!.detail ?? "").includes("Split me"));
  assert.ok((one[0]!.detail ?? "").includes("move it under ## Planned"));
  assert.ok((one[0]!.detail ?? "").includes("clean role"));
  assert.deepEqual(one[0]!.actions, []);
  // A two-entry list, the first in PLANS-DONE.md, titles plural and names archive + fix file.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [
    { title: "Carry on (done 2026-10-01)", section: "Done", file: "PLANS-DONE.md" },
    { title: "Split me (planned 2026-10-20)", section: "Done" },
  ]);
  assert.equal(two[0]!.title, "Plans sit under the wrong backlog section");
  assert.ok((two[0]!.detail ?? "").includes("PLANS-DONE.md"));
  assert.ok((two[0]!.detail ?? "").includes("in PLANS.md"));
  // No stranded plans add no alert; a plan-dependency problem precedes a stranded plan.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, []), []);
  const both = teamAlerts(base, [], [], now, [], [], [], [], [], { kind: "misworded", message: "m" }, [], [], null, [
    { title: "Split me (planned 2026-10-20)", section: "Done" },
  ]);
  assert.deepEqual(both.map((a) => a.key), ["plan-dependencies", "stranded-plans"]);
});

test("strandedPlanEntriesFor and the surfaces carry a stranded-plans alert from PLANS.md, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned" },
    { heading: "## Done", body: "### Stray plan (planned 2026-10-20)\n\nbody" },
  ]);
  assert.equal(strandedPlanEntriesFor(root).some((e) => e.title.includes("Stray plan")), true);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string }> };
  assert.equal(payload.alerts.find((a) => a.key === "stranded-plans")?.title, "A plan sits under the wrong backlog section");
  assert.match(renderStatus(root, snapshot(root, undefined, now)), /A plan sits under the wrong backlog section/);
  // A correctly-sectioned PLANS.md (planned under ## Planned) yields none.
  const clean = makeRepo();
  writeBacklogFile(clean, "PLANS.md", [
    { heading: "## Planned", body: "### Pocket plan (planned 2026-10-20)\n\nbody" },
    { heading: "## Done", body: "### Finished plan (done 2026-10-01)\n" },
  ]);
  assert.deepEqual(strandedPlanEntriesFor(clean), []);
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "stranded-plans"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /under the wrong backlog section/);
  // A missing PLANS.md also yields none.
  const bare = makeRepo();
  assert.deepEqual(strandedPlanEntriesFor(bare), []);
  assert.equal((statusPayload(bare, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "stranded-plans"), undefined);
});

test("duplicated backlog headings raise one amber alert folded like stranded plans", () => {
  const now = Date.now();
  const oneDup: BacklogHeadingDuplicate[] = [{ file: "PLANS.md", heading: "Done" }];
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], oneDup);
  assert.deepEqual(one.map((a) => [a.key, a.tone]), [["backlog-headings", "amber"]]);
  assert.equal(one[0]!.title, "1 duplicated backlog heading");
  assert.ok((one[0]!.detail ?? "").includes('PLANS.md "## Done"'));
  assert.ok((one[0]!.detail ?? "").includes("appears more than once"));
  assert.ok((one[0]!.detail ?? "").includes("remove the duplicate"));
  assert.deepEqual(one[0]!.actions, []);
  // Two rows title plural and fold the second through joinWithMore.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [
    { file: "PLANS.md", heading: "Done" },
    { file: "BUGS.md", heading: "Fixed" },
  ]);
  assert.equal(two[0]!.title, "2 duplicated backlog headings");
  assert.match(two[0]!.detail ?? "", /· "## Fixed" in BUGS.md/);
  // An empty list and the default add none.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], []), []);
  assert.deepEqual(teamAlerts(base, [], [], now), []);
  // With both a stranded plan and a duplicate, stranded-plans precedes backlog-headings.
  const both = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [
    { title: "Split me (planned 2026-10-20)", section: "Done" },
  ], [
    { file: "PLANS.md", heading: "Done" },
  ]);
  assert.deepEqual(both.map((a) => a.key), ["stranded-plans", "backlog-headings"]);
});

test("statusPayload and renderStatus carry a duplicated-heading alert from the backlog files, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned", body: "### A (planned 2026-01-01 by plan)\n\nbody" },
    { heading: "## Planned" },
    { heading: "## Done" },
  ]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "backlog-headings");
  assert.equal(alert?.title, "1 duplicated backlog heading");
  assert.ok(alert?.detail?.includes('PLANS.md "## Planned"'));
  assert.match(renderStatus(root, snapshot(root, undefined, now)), /duplicated backlog heading/);
  // A clean set of backlog files yields none on either surface.
  const clean = makeRepo();
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "backlog-headings"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /duplicated backlog heading/);
});

test("the finished-history alert follows the duplicated-heading alert and names the archive command", () => {
  const now = Date.now();
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Done", body: "### D1 (planned 2026-10-01, done 2026-10-02)\n\nbody" },
  ]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string; detail?: string; actions?: Array<unknown> }> };
  const alert = payload.alerts.find((a) => a.key === "backlog-archive");
  assert.equal(alert?.tone, "amber");
  assert.match(alert?.title ?? "", /finished history/);
  assert.match(alert?.detail ?? "", /PLANS\.md ## Done holds 1 finished entry/);
  assert.match(alert?.detail ?? "", /tumwater archive/);
  assert.deepEqual(alert?.actions, []);
  assert.match(renderStatus(root, snapshot(root, undefined, now)), /finished history/);
  // A clean pair of live files yields none.
  const clean = makeRepo();
  const cleanPayload = statusPayload(clean, now) as { alerts: Array<{ key: string }> };
  assert.equal(cleanPayload.alerts.find((a) => a.key === "backlog-archive"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /finished history/);
  // A duplicated heading plus finished history emits backlog-headings then backlog-archive.
  const both = makeRepo();
  writeBacklogFile(both, "PLANS.md", [
    { heading: "## Done", body: "### D1 (planned 2026-10-01, done 2026-10-02)\n\nbody" },
    { heading: "## Done" },
  ]);
  const bothKeys = (statusPayload(both, now) as { alerts: Array<{ key: string }> }).alerts
    .filter((a) => a.key === "backlog-headings" || a.key === "backlog-archive")
    .map((a) => a.key);
  assert.deepEqual(bothKeys, ["backlog-headings", "backlog-archive"]);
});

test("a bad Validation gap trace raises one amber alert", () => {
  const now = Date.now();
  const missing = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [{ title: "A fix", kind: "missing" }]);
  assert.deepEqual(missing.map((a) => [a.key, a.tone, a.title]), [["validation-gaps", "amber", "1 Fixed record has a validation-gap problem"]]);
  assert.match(missing[0]!.detail ?? "", /BUGS\.md "A fix"/);
  assert.match(missing[0]!.detail ?? "", /no \*\*Validation gap:\*\* line/);
  assert.match(missing[0]!.detail ?? "", /every Fixed entry writes exactly one known/);
  assert.match(missing[0]!.detail ?? "", /docs\/invariants\.md/);
  assert.deepEqual(missing[0]!.actions, []);
  // An unrecognized row names its tag; an unpinned row carries the docs/invariants nudge.
  const unrecognized = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [{ title: "A fix", kind: "unrecognized", tag: "no-reprod" }]);
  assert.match(unrecognized[0]!.detail ?? "", /unrecognized Validation gap tag "no-reprod"/);
  const unpinned = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [{ title: "A fix", kind: "unpinned" }]);
  assert.match(unpinned[0]!.detail ?? "", /unclear-invariant.*docs\/invariants\.md/);
  // Two rows pluralize the title and fold the second title.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [{ title: "One", kind: "missing" }, { title: "Two", kind: "unrecognized", tag: "x" }]);
  assert.deepEqual(two.map((a) => a.key), ["validation-gaps"]);
  assert.match(two[0]!.title ?? "", /Fixed records have validation-gap problems/);
  assert.match(two[0]!.detail ?? "", /"Two"/);
  // An empty array and the bare call add no validation-gaps alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], []), []);
  assert.equal(teamAlerts(base, [], [], now).filter((a) => a.key === "validation-gaps").length, 0);
  // A stranded plan precedes a validation problem when both are present.
  const both = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [{ title: "Split me (planned 2026-10-20)", section: "Done" }], [], [{ title: "A fix", kind: "missing" }]);
  assert.deepEqual(both.map((a) => a.key), ["stranded-plans", "validation-gaps"]);
});

test("the false-fixes alert names the first record and folds the rest", () => {
  const now = Date.now();
  const fixClaims = [
    { heading: "Phantom fix: details", missing: ["runScriptGroup", "signalTree"] },
    { heading: "Second phantom: details", missing: ["ghost"] },
  ];
  // fixClaims is the final positional argument, after validationGaps, notifyFailures,
  // primaryOverwrite, contention, flappedChecks, regressedFixes, postMergeChurn,
  // postReviewRisk, droppedPostReviews, mainRuleFailure, staleClaims and staleQuestions.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], fixClaims);
  const ff = alerts.filter((a) => a.key === "false-fixes");
  assert.deepEqual(ff.map((a) => [a.key, a.tone, a.title]), [["false-fixes", "amber", "2 Fixed records name code that is not on this tree"]]);
  assert.match(ff[0]!.detail ?? "", /BUGS\.md records "Phantom fix: details" as Fixed/);
  assert.match(ff[0]!.detail ?? "", /runScriptGroup, signalTree/);
  assert.match(ff[0]!.detail ?? "", /"Second phantom: details"/);
  assert.match(ff[0]!.detail ?? "", /land the fix or keep the bug Open \/ refresh a stale record/);
  assert.deepEqual(ff[0]!.actions, []);
  // An empty list and the bare call add no false-fixes alert.
  assert.equal(teamAlerts(base, [], [], now).filter((a) => a.key === "false-fixes").length, 0);
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, []), []);
});

test("statusPayload and renderStatus carry a validation-gaps alert from BUGS.md, and none without one", () => {
  const now = Date.now();
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    `# Bugs\n\n## Open\n\n### Still broken (found by qa 2026-09-22)\n\n**Fix:** someday.\n\n## Fixed\n\n### Entry 0: details (found by qa 2026-09-20, fixed 2026-09-21)\n\n**Symptom:** it broke.\n`,
  );
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "validation-gaps");
  assert.equal(alert?.title, "1 Fixed record has a validation-gap problem");
  assert.match(renderStatus(root, snapshot(root, undefined, now)), /1 Fixed record has a validation-gap problem/);
  // A clean repo (no BUGS.md) produces none on either surface.
  const clean = makeRepo();
  assert.equal((statusPayload(clean, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "validation-gaps"), undefined);
  assert.doesNotMatch(renderStatus(clean, snapshot(clean, undefined, now)), /validation-gap problem/);
});

test("a capacity bottleneck raises one standing amber alert carrying the doctor's detail", () => {
  const now = Date.now();
  const contention = [{ name: "provider slots", detail: "2 waits for a provider slot in the last 24h, 20m total, longest 10m (the omlx slot) — raise maxConcurrentPerProvider.omlx above 1" }];
  // contention is the 20th positional argument, after primaryOverwrite; one position earlier it
  // would land in the primaryOverwrite slot and raise no contention alert.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, contention);
  assert.deepEqual(alerts.map((a) => [a.key, a.tone]), [["contention", "amber"]]);
  assert.match(alerts[0]!.title ?? "", /1 capacity bottleneck/);
  assert.match(alerts[0]!.detail ?? "", /provider slots:/);
  assert.match(alerts[0]!.detail ?? "", /raise maxConcurrentPerProvider\.omlx/);
  assert.deepEqual(alerts[0]!.actions, []);
  // An empty last argument adds no alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null), []);
  // The full pipeline carries the same warning through statusPayload's alerts over seeded waits,
  // pinning the argument position end to end.
  const root = makeRepo();
  writeEvents(root, [
    { ts: now - 60_000, source: "tumwater", type: "slot_wait", message: "waited", role: "feature", purpose: "run", waitedMs: 600_000 },
    { ts: now - 60_000, source: "tumwater", type: "provider_wait", role: "feature", key: "omlx", waitedMs: 600_000 },
  ]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string }> };
  const contentionAlert = payload.alerts.find((a) => a.key === "contention");
  assert.equal(contentionAlert?.tone, "amber");
  assert.match(contentionAlert?.title ?? "", /capacity bottleneck/);
});
test("a flapping check raises one standing amber alert carrying the doctor's phrase", () => {
  const now = Date.now();
  const flapped = { count: 2, detail: 'checks flapped more than once in the last 24h: "database test failed" ×3 (and 1 more: "network test failed" ×2)' };
  // flappedChecks is the 17th argument after `now` (the 21st positional overall), after
  // contention ([]); one position earlier it would land in the contention slot and raise no
  // flapped-checks alert.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], flapped);
  const only = one.filter((a) => a.key === "flapped-checks");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /2 checks have flapped/);
  assert.match(only[0]!.detail ?? "", /flapped more than once in the last 24h/);
  assert.match(only[0]!.detail ?? "", /tumwater bug/);
  assert.deepEqual(only[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A null last argument adds none.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null), []);
  // End to end through statusPayload over the seeded warnings, pinning the argument position.
  const root = makeRepo();
  warnEvent(root, "bugfix", FLAKY_WARNING_PREFIX + "test failed after 3s");
  warnEvent(root, "bugfix", FLAKY_WARNING_PREFIX + "test failed after 9s");
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string; detail?: string }> };
  const flappedAlert = payload.alerts.find((a) => a.key === "flapped-checks");
  assert.equal(flappedAlert?.tone, "amber");
  assert.match(flappedAlert?.title ?? "", /1 check has flapped/);
  assert.match(flappedAlert?.detail ?? "", /tumwater bug/);
  const clean = makeRepo();
  assert.equal((statusPayload(clean, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "flapped-checks"), undefined);
});

test("a regressed Fixed record raises one standing amber alert carrying the doctor's sentence", () => {
  const now = Date.now();
  const y = stampDaysAgo(1, now);
  const detail = `BUGS.md Fixed record "quoted test regressed" quotes a test that failed again after its ${y} fix (${now}: ✖ aQuotedTestNameThatIsLongEnough failed again) — file it as a new bug with \`tumwater bug\`, quoting the test name and citing the Fixed record`;
  const regressed = { count: 1, detail };
  // regressedFixes is the 18th argument after `now` (the 22nd positional overall), after
  // contention and flappedChecks; one position earlier it would land in the flapped-checks slot
  // and raise no regressed-fixes alert.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, regressed);
  assert.deepEqual(alerts.map((a) => [a.key, a.tone]), [["regressed-fixes", "amber"]]);
  assert.match(alerts[0]!.title ?? "", /Fixed test has regressed/);
  assert.equal(alerts[0]!.detail, detail);
  assert.deepEqual(alerts[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A null last argument adds no alert.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null).filter((a) => a.key === "regressed-fixes").length, 0);
  // The full pipeline carries the same alert through statusPayload over a seeded Fixed record
  // and failure event, pinning the argument position end to end.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "BUGS.md"), `## Open\n\n## Fixed\n\n### \`test/x.test.ts\` "aQuotedTestNameThatIsLongEnough" flaked (found by bugfix ${stampDaysAgo(5, now)}) — fixed ${y}\n\nFix.\n\n`);
  writeEvents(root, [{ ts: now, source: "review", type: "warning", message: "✖ aQuotedTestNameThatIsLongEnough failed again" }]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string }> };
  const fixAlert = payload.alerts.find((a) => a.key === "regressed-fixes");
  assert.equal(fixAlert?.tone, "amber");
  assert.match(fixAlert?.title ?? "", /Fixed test has regressed/);
});

// A whole calendar day `n` days before `now`, as a `YYYY-MM-DD` stamp.
function stampDaysAgo(n: number, now: number = Date.now()): string {
  const d = new Date(now - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("a post-merge rejection burst raises one standing amber alert", () => {
  const now = Date.now();
  const churn = { count: 2, roles: [{ role: "bugfix", count: 1 }, { role: "clean", count: 1 }] };
  // postMergeChurn is the 19th argument after `now` (the 23rd positional overall), after
  // contention, flappedChecks and regressedFixes; one position earlier it would land in the
  // regressed-fixes slot and raise no post-merge-churn alert.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, churn);
  assert.deepEqual(alerts.map((a) => [a.key, a.tone]), [["post-merge-churn", "amber"]]);
  assert.match(alerts[0]!.title ?? "", /post-merge review rejections/);
  assert.match(alerts[0]!.detail ?? "", /bugfix/);
  assert.match(alerts[0]!.detail ?? "", /review\.afterMerge/);
  assert.match(alerts[0]!.detail ?? "", /stays there with the reviewer's recorded reasons/, "the churn detail reads the recorded-finding wording, not a pending revert");
  assert.doesNotMatch(alerts[0]!.detail ?? "", /revert|re-author/, "the churn detail reads the recorded-finding wording, not a pending revert");
  assert.deepEqual(alerts[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A null last argument adds none.
  assert.deepEqual(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null), []);
  // The full pipeline carries the same warning through statusPayload's alerts over seeded events,
  // pinning the argument position end to end.
  const root = makeRepo();
  writeEvents(root, [
    { ts: now - 60_000, source: "bugfix", type: "review_rejected", afterMerge: true },
    { ts: now - 60_000, source: "clean", type: "review_rejected", afterMerge: true },
  ]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string }> };
  const churnAlert = payload.alerts.find((a) => a.key === "post-merge-churn");
  assert.equal(churnAlert?.tone, "amber");
  assert.match(churnAlert?.title ?? "", /post-merge review rejections/);
});

test("an at-risk post-merge review raises one standing amber alert", () => {
  const now = Date.now();
  const postReviewRisk = { count: 1, detail: 'the post-merge review of improve ab12cd3e — "add x" — has ended without a verdict 2 times; one more failed run drops it and the commit stays on main unreviewed — fix the reviewer backend or accept the commit unreviewed deliberately' };
  // postReviewRisk is the 24th positional argument, after postMergeChurn and regressedFixes;
  // one position earlier it would land in the post-merge-churn slot and raise no alert.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, postReviewRisk);
  const only = one.filter((a) => a.key === "post-merge-risk");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /one failed run from being dropped/);
  assert.equal(only[0]!.detail, postReviewRisk.detail);
  assert.deepEqual(only[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A null last argument adds none.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null).find((a) => a.key === "post-merge-risk"), undefined);
  // End to end through statusPayload over a seeded at-risk review, pinning the argument position.
  const root = makeRepo();
  writeJsonFile(postReviewPath(root), { pending: [{ commit: "ab12cd3e".padEnd(40, "f"), role: "improve", summary: "add x", failures: 2 }] });
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "post-merge-risk");
  assert.equal(alert?.tone, "amber");
  assert.match(alert?.title ?? "", /one failed run from being dropped/);
  assert.match(alert?.detail ?? "", /improve ab12cd3e/);
  const clean = makeRepo();
  assert.equal((statusPayload(clean, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "post-merge-risk"), undefined);
});

test("a dropped post-merge review raises one standing amber alert", () => {
  const now = Date.now();
  const droppedPostReviews = { count: 2, latestTs: now - 60_000, latestMessage: "dropping the post-merge review of ab12cd3e after 3 failed runs; it stays on main unreviewed" };
  // droppedPostReviews is the 25th positional argument, after postReviewRisk; one position
  // earlier it would land in the post-merge-risk slot and raise no alert.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, droppedPostReviews);
  const only = one.filter((a) => a.key === "dropped-post-reviews");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /post-merge reviews were dropped in the last day/);
  assert.match(only[0]!.detail, /dropping the post-merge review of ab12cd3e/);
  assert.match(only[0]!.detail, /POST_REVIEW_FAILURE_LIMIT/);
  assert.deepEqual(only[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A trailing null adds none.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null).find((a) => a.key === "dropped-post-reviews"), undefined);
  // End to end through statusPayload over a seeded drop warning, pinning the reader and the
  // argument position.
  const root = makeRepo();
  writeEvents(root, [{ ts: now - 60_000, source: "bugfix", type: "warning", message: "dropping the post-merge review of ab12cd3e after 3 failed runs; it stays on main unreviewed" }]);
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string; detail?: string }> };
  const alert = payload.alerts.find((a) => a.key === "dropped-post-reviews");
  assert.equal(alert?.tone, "amber");
  assert.match(alert?.title ?? "", /post-merge review was dropped in the last day/);
  assert.match(alert?.detail ?? "", /ab12cd3e/);
  const clean2 = makeRepo();
  assert.equal((statusPayload(clean2, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "dropped-post-reviews"), undefined);
});

test("a main diff-rule failure raises one standing amber alert", () => {
  const now = Date.now();
  const mainRuleFailure = { count: 2, latestTs: now - 60_000, latestMessage: "main's tip ab12cd3e fails the diff rules: conflict markers in src/a.ts" };
  // mainRuleFailure is the 26th positional argument, after droppedPostReviews; one position
  // earlier it would land in the dropped-post-reviews slot and raise no alert.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, mainRuleFailure);
  const only = one.filter((a) => a.key === "main-diff-rules");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /diff-rule failures on main in the last day/);
  assert.match(only[0]!.detail, /main's tip ab12cd3e fails the diff rules: conflict markers in src\/a\.ts/);
  assert.match(only[0]!.detail, /tumwater revert/);
  assert.deepEqual(only[0]!.actions, [{ label: "See failures", act: "view", arg: "failures" }]);
  // A trailing null adds none.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null).find((a) => a.key === "main-diff-rules"), undefined);
});

test("a stalled ci parity raises the ci-stale alert", () => {
  const now = Date.now();
  // A stale record past the stall window raises exactly one amber ci-stale alert.
  const stalled = {
    state: "stale" as const,
    covered: "0123456789abcdef0123456789abcdef01234567",
    lastRunAt: now - CI_PARITY_STALE_MS - 60_000,
  };
  const alerts = teamAlerts({ ...base, ciParity: stalled }, [], [], now);
  const only = alerts.filter((a) => a.key === "ci-stale");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /not covered a tip in over 3 days/);
  assert.match(only[0]!.detail, /01234567/);
  assert.match(only[0]!.detail, /ci role/);
  assert.doesNotMatch(only[0]!.detail, /ago ago/, "humanAgo already appends \" ago\", the detail must not repeat it");
  assert.deepEqual(only[0]!.actions, [], "the fix is a role toggle the drawer already has, so no action button");

  // Inside the window the same record raises no ci-stale alert.
  const fresh = { state: "stale" as const, covered: "01234567", lastRunAt: now - CI_PARITY_STALE_MS };
  assert.equal(teamAlerts({ ...base, ciParity: fresh }, [], [], now).find((a) => a.key === "ci-stale"), undefined);
  // No record, and a current record, raise no ci-stale alert either.
  assert.equal(teamAlerts({ ...base, ciParity: undefined }, [], [], now).find((a) => a.key === "ci-stale"), undefined);
  assert.equal(teamAlerts({ ...base, ciParity: { state: "current", covered: "x", lastRunAt: 0 } }, [], [], now).find((a) => a.key === "ci-stale"), undefined);
});

test("a stalled qa coverage raises the qa-stale alert", () => {
  const now = Date.now();
  // The 25 preceding defaults (refused…fixClaims) are passed explicitly so the trailing
  // qaCoverage slot lands. A stalled value yields exactly one amber qa-stale alert.
  const stalled = { newestFlow: "status", newestAt: now - QA_COVERAGE_STALE_MS - 60_000, count: 1 };
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], stalled);
  const only = alerts.filter((a) => a.key === "qa-stale");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /not advanced in over 3 days/);
  assert.match(only[0]!.detail, /status/);
  assert.match(only[0]!.detail, /qa role/);
  assert.deepEqual(only[0]!.actions, [], "the fix is a role toggle the role drawer already has, so no action button");

  // A stored value yields no alerts unless it names a stall: fresh and empty ledgers both
  // arrive at teamAlerts as null (qaCoverageAlert is null for them).
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null).find((a) => a.key === "qa-stale"), undefined);
});

test("a stale workspace pin raises the workspace-pins alert", () => {
  const now = Date.now();
  // workspacePins is the trailing parameter; the 26 preceding values (refused…fixClaims then
  // qaCoverage, passed explicitly) are passed so the trailing slot lands, pinning the position.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, [{ role: "feature", dir: "_slot-1", ageMs: 25 * 3_600_000 }]);
  const only = alerts.filter((a) => a.key === "workspace-pins");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /workspace pinned past a day/);
  assert.ok(only[0]!.detail.includes("feature"));
  assert.ok(only[0]!.detail.includes("_slot-1"));
  assert.ok(only[0]!.detail.includes("25h"));
  assert.ok(only[0]!.detail.includes("tumwater doctor"));
  assert.deepEqual(only[0]!.actions, [{ label: "Open feature", act: "role", arg: "feature" }]);

  // An empty list adds no alert.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, []).filter((a) => a.key === "workspace-pins").length, 0);

  // Two pins pluralize the title and name both.
  const two = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, [
    { role: "feature", dir: "_slot-1", ageMs: 25 * 3_600_000 },
    { role: "bugfix", dir: "_slot-2", ageMs: 50 * 3_600_000 },
  ]).filter((a) => a.key === "workspace-pins");
  assert.equal(two.length, 1);
  assert.match(two[0]!.title, /workspaces pinned past a day/);
  assert.ok(two[0]!.detail.includes("feature"));
  assert.ok(two[0]!.detail.includes("bugfix"));
});

test("a maxConcurrentPerProvider misconfiguration raises one standing amber provider-caps alert", () => {
  const now = Date.now();
  const problem = 'cap key "omlx" resolves to no model job (a typo, or a provider not in use)';
  // providerCaps is the trailing parameter, after liveFinished and instancePool ([]); the 28
  // preceding values (refused…workspacePins, then liveFinished and instancePool, passed
  // explicitly) are filled so the trailing slot lands, pinning the position.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, [], [], [], [problem]);
  const only = alerts.filter((a) => a.key === "provider-caps");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title ?? "", /maxConcurrentPerProvider is misconfigured/);
  assert.ok(only[0]!.detail.includes(problem));
  assert.match(only[0]!.detail ?? "", /fix the map in tumwater.json/);
  assert.deepEqual(only[0]!.actions, []);
  // An empty (default) final argument adds no alert.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, []).filter((a) => a.key === "provider-caps").length, 0);
  // The full pipeline carries the same alert through statusPayload over a seeded map, pinning
  // the feed-to-builder wiring end to end.
  const root = makeRepo();
  writeJsonFile(configPath(root), { ...defaultConfig(), backend: "claude", model: { default: "m" }, maxConcurrent: 4, maxConcurrentPerProvider: { omlx: 3 } });
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string; detail?: string }> };
  const capsAlert = payload.alerts.find((a) => a.key === "provider-caps");
  assert.equal(capsAlert?.tone, "amber");
  assert.match(capsAlert?.title ?? "", /maxConcurrentPerProvider is misconfigured/);
  assert.ok((capsAlert?.detail ?? "").includes(problem));
  // A well-formed map (or no map) yields no alert.
  writeJsonFile(configPath(root), { ...defaultConfig(), backend: "pi", model: { default: "omlx/m" }, maxConcurrent: 4, maxConcurrentPerProvider: { omlx: 3 } });
  assert.equal((statusPayload(root, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "provider-caps"), undefined);
  writeJsonFile(configPath(root), { ...defaultConfig(), backend: "claude", model: { default: "m" }, maxConcurrent: 4 });
  assert.equal((statusPayload(root, now) as { alerts: Array<{ key: string }> }).alerts.find((a) => a.key === "provider-caps"), undefined);
});

test("a workspace pool below the run cap raises one standing amber instance-pool alert", () => {
  const now = Date.now();
  // instancePool is the trailing parameter; the 30 preceding values (refused…workspacePins
  // then liveFinished, passed explicitly) are passed so the trailing slot lands, pinning the
  // position after the workspace-pins slot.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, [], [], ["feature run instances but worktreeSlots 1 is below maxConcurrent 6"]);
  const only = alerts.filter((a) => a.key === "instance-pool");
  assert.equal(only.length, 1);
  assert.equal(only[0]!.tone, "amber");
  assert.match(only[0]!.title, /workspace pool smaller than the run cap/);
  assert.ok(only[0]!.detail.includes("feature run instances but worktreeSlots 1 is below maxConcurrent 6"));
  assert.deepEqual(only[0]!.actions, []);

  // Omitting the final argument (its [] default) adds no alert.
  assert.equal(teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [], [], [], null, [], []).filter((a) => a.key === "instance-pool").length, 0);

  // End to end: a repo whose feature role runs two instances against a worktreeSlots below
  // maxConcurrent carries the instance-pool alert on the shared status payload, wired from
  // the feed through the builder.
  const root = makeRepo();
  writeConfig(root, { roles: { feature: { instances: 2 } }, worktreeSlots: 1 });
  const payload = statusPayload(root, now) as { alerts: Array<{ key: string; tone?: string; title?: string; detail?: string; actions?: Array<unknown> }> };
  const ip = payload.alerts.filter((a) => a.key === "instance-pool");
  assert.equal(ip.length, 1);
  assert.equal(ip[0]!.tone, "amber");
  assert.match(ip[0]!.title!, /workspace pool smaller than the run cap/);
  assert.match(ip[0]!.detail!, /feature run instances but worktreeSlots 1 is below maxConcurrent 6/);
  assert.deepEqual(ip[0]!.actions, []);
});

test("the stale-claims alert names a gone and an idle claim", () => {
  const now = Date.now();
  // staleClaims is the trailing parameter; the 22 preceding defaults (refused…mainRuleFailure)
  // are passed explicitly so it lands in its slot.
  const alerts = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [
    { id: "feature-2", file: "PLANS.md", title: "Gone", kind: "gone", hours: 0 },
    { id: "bugfix-2", file: "BUGS.md", title: "An open bug", kind: "idle", hours: 25 },
  ]);
  const only = alerts.filter((a) => a.key === "stale-claims");
  assert.deepEqual(only.map((a) => [a.key, a.tone, a.title]), [["stale-claims", "amber", "2 work-instance claims are stale"]]);
  assert.ok(only[0]!.detail.includes('claimed plan "Gone" (feature-2) names an entry no longer listed'));
  assert.ok(only[0]!.detail.includes('claimed bug "An open bug" (bugfix-2) has been idle 25h'));
  assert.deepEqual(only[0]!.actions, [
    { label: "Open feature #2", act: "role", arg: "feature-2" },
    { label: "Open bugfix #2", act: "role", arg: "bugfix-2" },
  ]);
  // An empty list raises no stale-claims alert.
  const none = teamAlerts(base, [], [], now);
  assert.equal(none.filter((a) => a.key === "stale-claims").length, 0);
  // A single claim names its state with the singular verb.
  const one = teamAlerts(base, [], [], now, [], [], [], [], [], null, [], [], null, [], [], [], null, null, [], null, null, null, null, null, null, [
    { id: "feature-2", file: "PLANS.md", title: "Gone", kind: "gone", hours: 0 },
  ]);
  assert.deepEqual(one.filter((a) => a.key === "stale-claims").map((a) => a.title), ["1 work-instance claim is stale"]);
});
