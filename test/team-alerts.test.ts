import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { alertNeedsYou, teamAlerts, type AlertRole, type BacklogHeadingDuplicate } from "../src/ui/team-alerts.js";
import { phaseTone, resultTone } from "../src/ui/tone.js";
import { clientScope } from "./helpers/gui-client-scope.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { planDependencyAlert } from "../src/ui/alert-feeds.js";
import { strandedPlanEntriesFor } from "../src/backlog/backlog-structure.js";
import { renderStatus } from "../src/ui/status-render.js";
import { snapshot } from "../src/status/status-data.js";
import { makeRepo, writeBacklogFile } from "./fixtures/repo-fixtures.js";

// team-alerts.ts's teamAlerts: what needs the operator, phrased once for the dashboard's alert
// banners and the TUI's attention lines.

type Snap = Parameters<typeof teamAlerts>[0];
const base: Snap = {
  running: true,
  budget: { spentUsd: 1, capUsd: 10, capHitAt: null, free: false, fallback: null },
  budgetPausedRoles: [],
};

test("a red doctor orphan scan raises the standing amber orphans alert naming the count", () => {
  // The alert-feed half (refreshOrphanAlert) supplies the doctor-row sentence; here we pin that
  // teamAlerts renders it as a standing amber banner, so a red `orphans` row is never silent on
  // the dashboard or TUI again (BUGS.md 2026-10-28).
  const orphan = { count: 2, detail: "2 orphaned processes (PPID 1): pid 11 (age 01:00, cpu 0:41.20) node run.js — nothing reaps these; `tumwater doctor --kill-orphans` kills each with its descendants" };
  const alerts = teamAlerts(base, [], [], Date.now(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, orphan);
  const o = alerts.find((a) => a.key === "orphans");
  assert.ok(o, "a red orphan scan must raise the standing orphans alert");
  assert.equal(o?.tone, "amber");
  assert.match(o?.detail ?? "", /^2 orphaned processes \(PPID 1\)/);
  // A clean scan raises nothing.
  const clean = teamAlerts(base, [], [], Date.now(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
  assert.ok(!clean.some((a) => a.key === "orphans"));
});

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

test("role trouble and questions, most urgent first", () => {
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
    base,
    ["Q1: which database? (asked 2026-09-29)", "Q2: tabs or spaces?"],
    roles,
    now,
  );
  assert.deepEqual(alerts.map((a) => a.key), ["mainred", "failing", "stuck", "questions"]);
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
  assert.equal(by.questions?.title, "2 questions need your answer");
  assert.equal(by.questions?.detail, "Q1: which database? — and 1 more", "a question's date note is metadata, not the question");
  assert.equal(alerts.filter(alertNeedsYou).length, 4);
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
});

// The dashboard colors phases and results in its own tones; the TUI in the terminal's. Both
// must tell the same story: what the page shows blue/violet/orange/indigo (work in progress)
// the terminal shows blue, and so on down the families.
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

test("stalled entries raise a standing amber alert naming the first entry and the plan-role fix", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], null, [{ file: "plans", index: 2, title: "Split me (planned 2026-10-20)", hold: "needs-review" }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stalled-entries", "amber", "1 backlog entry is stalled in review"]]);
  assert.ok(one[0]!.detail.includes("Split me"));
  assert.ok(one[0]!.detail.includes("Needs review"));
  assert.ok(one[0]!.detail.includes("plan role"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "plans:2" }]);
  const two = teamAlerts(base, [], [], now, [], null, [
    { file: "plans", index: 0, title: "A (planned 2026-10-14)", hold: "needs-review" },
    { file: "plans", index: 1, title: "B (planned 2026-10-14)", hold: "needs-review" },
  ]);
  assert.equal(two[0]!.title, "2 backlog entries are stalled in review");
  assert.ok(two[0]!.detail.includes("Needs review"));
  assert.deepEqual(two[0]!.actions[0]?.arg, "plans:0");
  // An empty list raises no stalled-entries alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], null, []), []);
});

test("a stalled bug raises the stalled-entries alert", () => {
  const now = Date.now();
  // A Needs-review bug, no stalled plan: one amber stalled-entries alert naming the bug.
  const one = teamAlerts(base, [], [], now, [], null, [{ file: "bugs", index: 0, title: "Too-large bug", hold: "needs-review" }]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["stalled-entries", "amber", "1 backlog entry is stalled in review"]]);
  assert.ok(one[0]!.detail.includes("Bug"));
  assert.ok(one[0]!.detail.includes("Too-large bug"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog", arg: "bugs:0" }]);
});

test("the stale-questions alert names the oldest and folds the rest", () => {
  const now = Date.now();
  const two = teamAlerts(base, ["Q?"], [], now, [], null, [], [], [], [], [
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

test("a broken plan-dependency clause raises a standing amber alert right after the refused alert", () => {
  const now = Date.now();
  const msg = 'PLANS.md plan "S, part 2/2: b" names S 1/2 as a prerequisite without a `requires … landed` clause — the claim allocator ignores that wording and hands the part out now; write it as `requires part i/n landed`';
  const one = teamAlerts(base, [], [], now, [], { kind: "misworded", message: msg });
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["plan-dependencies", "amber", "A plan's dependency wording holds nothing"]]);
  assert.equal(one[0]!.detail, msg);
  assert.deepEqual(one[0]!.actions, []);
  // The other three kinds map to their titles.
  const titles = (kind: "cycle" | "dangling" | "unparsed" | "misworded") =>
    teamAlerts(base, [], [], now, [], { kind, message: "m" })[0]!.title;
  assert.equal(titles("cycle"), "Plan dependency cycle blocks a whole series");
  assert.equal(titles("dangling"), "A plan requires a part no heading carries");
  assert.equal(titles("unparsed"), "A plan's requires clause names no readable part");
  // A null argument adds no alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], null), []);
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
  // An old (held N) note now reads as a Needs-review hold like any other: it raises the
  // stalled-entries alert (the operator-held alert and its exclusion are gone).
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
  const heldPayload = statusPayload(held, now) as { alerts: Array<{ key: string; title?: string }> };
  assert.equal(heldPayload.alerts.find((a) => a.key === "operator-held"), undefined);
  assert.equal(heldPayload.alerts.find((a) => a.key === "stalled-entries")?.title, "1 backlog entry is stalled in review");
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

test("bugfix wait-for-the-next-failure notes do not surface as stalled; a too-large note does", () => {
  const now = Date.now();
  // A BUGS.md holding only the bugfix role's wait notes ("by bugfix") raises no
  // stalled-entries alert: those parks are evidence waits that selfcheck clears, not the
  // plan role's stalled work.
  const wait = makeRepo();
  writeBacklogFile(wait, "BUGS.md", [
    {
      heading: "## Open",
      body: [
        "### Flaky a (found by bugfix 2026-10-20)",
        "",
        "**Needs review 2026-10-26 by bugfix: the next failure's message names the cause**",
        "",
        "### Flaky b (found by bugfix 2026-10-21)",
        "",
        "**Needs review 2026-10-26 by bugfix: the next failure's message names the cause**",
      ].join("\n"),
    },
    { heading: "## Fixed" },
  ]);
  const waitPayload = statusPayload(wait, now) as { alerts: Array<{ key: string }> };
  assert.equal(waitPayload.alerts.find((a) => a.key === "stalled-entries"), undefined);
  assert.doesNotMatch(renderStatus(wait, snapshot(wait, undefined, now)), /entries are stalled in review/);
  // The same BUGS.md with the plan role's too-large note does raise it.
  const tooLarge = makeRepo();
  writeBacklogFile(tooLarge, "BUGS.md", [
    {
      heading: "## Open",
      body: [
        "### Too-large bug (found by bugfix 2026-10-20)",
        "",
        "**Needs review 2026-10-26 by feature: too large for one run**",
      ].join("\n"),
    },
    { heading: "## Fixed" },
  ]);
  const tooLargePayload = statusPayload(tooLarge, now) as { alerts: Array<{ key: string; title?: string }> };
  assert.equal(tooLargePayload.alerts.find((a) => a.key === "stalled-entries")?.title, "1 backlog entry is stalled in review");
  // A mix: the two bugfix waits stay out of the count, the one too-large note counts.
  const mixed = makeRepo();
  writeBacklogFile(mixed, "BUGS.md", [
    {
      heading: "## Open",
      body: [
        "### Flaky a (found by bugfix 2026-10-20)",
        "",
        "**Needs review 2026-10-26 by bugfix: the next failure's message names the cause**",
        "",
        "### Too-large bug (found by bugfix 2026-10-21)",
        "",
        "**Needs review 2026-10-26 by feature: too large for one run**",
      ].join("\n"),
    },
    { heading: "## Fixed" },
  ]);
  const mixedPayload = statusPayload(mixed, now) as { alerts: Array<{ key: string; title?: string }> };
  assert.equal(mixedPayload.alerts.find((a) => a.key === "stalled-entries")?.title, "1 backlog entry is stalled in review");
});

test("plans filed under the wrong backlog section raise a standing amber alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, [], null, [], [
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
  const two = teamAlerts(base, [], [], now, [], null, [], [
    { title: "Carry on (done 2026-10-01)", section: "Done", file: "PLANS-DONE.md" },
    { title: "Split me (planned 2026-10-20)", section: "Done" },
  ]);
  assert.equal(two[0]!.title, "Plans sit under the wrong backlog section");
  assert.ok((two[0]!.detail ?? "").includes("PLANS-DONE.md"));
  assert.ok((two[0]!.detail ?? "").includes("in PLANS.md"));
  // No stranded plans add no alert; a plan-dependency problem precedes a stranded plan.
  assert.deepEqual(teamAlerts(base, [], [], now, [], null, [], []), []);
  const both = teamAlerts(base, [], [], now, [], { kind: "misworded", message: "m" }, [], [
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
  const one = teamAlerts(base, [], [], now, [], null, [], [], oneDup);
  assert.deepEqual(one.map((a) => [a.key, a.tone]), [["backlog-headings", "amber"]]);
  assert.equal(one[0]!.title, "1 duplicated backlog heading");
  assert.ok((one[0]!.detail ?? "").includes('PLANS.md "## Done"'));
  assert.ok((one[0]!.detail ?? "").includes("appears more than once"));
  assert.ok((one[0]!.detail ?? "").includes("remove the duplicate"));
  assert.deepEqual(one[0]!.actions, []);
  // Two rows title plural and fold the second through joinWithMore.
  const two = teamAlerts(base, [], [], now, [], null, [], [], [
    { file: "PLANS.md", heading: "Done" },
    { file: "BUGS.md", heading: "Fixed" },
  ]);
  assert.equal(two[0]!.title, "2 duplicated backlog headings");
  assert.match(two[0]!.detail ?? "", /· "## Fixed" in BUGS.md/);
  // An empty list and the default add none.
  assert.deepEqual(teamAlerts(base, [], [], now, [], null, [], [], []), []);
  assert.deepEqual(teamAlerts(base, [], [], now), []);
  // With both a stranded plan and a duplicate, stranded-plans precedes backlog-headings.
  const both = teamAlerts(base, [], [], now, [], null, [], [
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
  const missing = teamAlerts(base, [], [], now, [], null, [], [], [], [{ title: "A fix", kind: "missing" }]);
  assert.deepEqual(missing.map((a) => [a.key, a.tone, a.title]), [["validation-gaps", "amber", "1 Fixed record has a validation-gap problem"]]);
  assert.match(missing[0]!.detail ?? "", /BUGS\.md "A fix"/);
  assert.match(missing[0]!.detail ?? "", /no \*\*Validation gap:\*\* line/);
  assert.match(missing[0]!.detail ?? "", /every Fixed entry writes exactly one known/);
  assert.match(missing[0]!.detail ?? "", /docs\/invariants\.md/);
  assert.deepEqual(missing[0]!.actions, []);
  // An unrecognized row names its tag; an unpinned row carries the docs/invariants nudge.
  const unrecognized = teamAlerts(base, [], [], now, [], null, [], [], [], [{ title: "A fix", kind: "unrecognized", tag: "no-reprod" }]);
  assert.match(unrecognized[0]!.detail ?? "", /unrecognized Validation gap tag "no-reprod"/);
  const unpinned = teamAlerts(base, [], [], now, [], null, [], [], [], [{ title: "A fix", kind: "unpinned" }]);
  assert.match(unpinned[0]!.detail ?? "", /unclear-invariant.*docs\/invariants\.md/);
  // Two rows pluralize the title and fold the second title.
  const two = teamAlerts(base, [], [], now, [], null, [], [], [], [{ title: "One", kind: "missing" }, { title: "Two", kind: "unrecognized", tag: "x" }]);
  assert.deepEqual(two.map((a) => a.key), ["validation-gaps"]);
  assert.match(two[0]!.title ?? "", /Fixed records have validation-gap problems/);
  assert.match(two[0]!.detail ?? "", /"Two"/);
  // An empty array and the bare call add no validation-gaps alert.
  assert.deepEqual(teamAlerts(base, [], [], now, [], null, [], [], [], []), []);
  assert.equal(teamAlerts(base, [], [], now).filter((a) => a.key === "validation-gaps").length, 0);
  // A stranded plan precedes a validation problem when both are present.
  const both = teamAlerts(base, [], [], now, [], null, [], [{ title: "Split me (planned 2026-10-20)", section: "Done" }], [], [{ title: "A fix", kind: "missing" }]);
  assert.deepEqual(both.map((a) => a.key), ["stranded-plans", "validation-gaps"]);
});

test("the false-fixes alert names the first record and folds the rest", () => {
  const now = Date.now();
  const fixClaims = [
    { heading: "Phantom fix: details", missing: ["runScriptGroup", "signalTree"] },
    { heading: "Second phantom: details", missing: ["ghost"] },
  ];
  // fixClaims is the final positional argument, after validationGaps and staleQuestions.
  const alerts = teamAlerts(base, [], [], now, [], null, [], [], [], [], [], fixClaims);
  const ff = alerts.filter((a) => a.key === "false-fixes");
  assert.deepEqual(ff.map((a) => [a.key, a.tone, a.title]), [["false-fixes", "amber", "2 Fixed records name code that is not on this tree"]]);
  assert.match(ff[0]!.detail ?? "", /BUGS\.md records "Phantom fix: details" as Fixed/);
  assert.match(ff[0]!.detail ?? "", /runScriptGroup, signalTree/);
  assert.match(ff[0]!.detail ?? "", /"Second phantom: details"/);
  assert.match(ff[0]!.detail ?? "", /land the fix or keep the bug Open \/ refresh a stale record/);
  assert.deepEqual(ff[0]!.actions, []);
  // An empty list and the bare call add no false-fixes alert.
  assert.equal(teamAlerts(base, [], [], now).filter((a) => a.key === "false-fixes").length, 0);
  assert.deepEqual(teamAlerts(base, [], [], now, [], null, [], [], [], [], [], []), []);
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

