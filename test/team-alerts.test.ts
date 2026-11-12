import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { alertNeedsYou, teamAlerts, type AlertRole } from "../src/ui/team-alerts.js";
import { phaseTone, resultTone } from "../src/ui/tone.js";
import { clientScope } from "./helpers/gui-client-scope.js";
import { defaultConfig } from "../src/config/config.js";
import { ROLE_NOTES_MAX_BYTES } from "../src/roles/role-notes-write.js";
import { roleNotesPath, salvageDir } from "../src/paths.js";
import { PRINCIPLES_MAX_CHARS } from "../src/prompt/principles.js";
import { BRIEF_TEXT_MAX_CHARS, PROMPT_END, PROMPT_START } from "../src/brief/brief.js";
import { renderStatus } from "../src/ui/status-render.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { snapshotWith } from "./fixtures/status-fixtures.js";
import type { StatusSnapshot } from "../src/status/status-data.js";

type StandingFlags = Pick<
  StatusSnapshot,
  "noDeclaredCheck" | "noBrief" | "briefTruncated" | "roleNotesOverCap" | "salvagePatches" |
    "principlesTruncated" | "configProblem"
>;

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
  const orphan = { count: 2, pids: [11, 12], firstSeenAt: Date.now() - 2 * 3_600_000, detail: "2 orphaned processes (PPID 1): pid 11 (age 01:00, cpu 0:41.20) node run.js — nothing reaps these; `tumwater doctor --kill-orphans` kills each with its descendants" };
  const alerts = teamAlerts(base, [], [], Date.now(), undefined, orphan);
  const o = alerts.find((a) => a.key === "orphans");
  assert.ok(o, "a red orphan scan must raise the standing orphans alert");
  assert.equal(o?.tone, "amber");
  assert.match(o?.detail ?? "", /^2 orphaned processes \(PPID 1\)/);
  // A clean scan raises nothing.
  const clean = teamAlerts(base, [], [], Date.now(), undefined, null);
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
    { role: "docs", phase: "working 1m · turn 1 · no agent output for 6m00s", errorStreak: false, inFlight: true, stuckMs: 360_000 },
    { role: "idle", phase: "sleeping (for 5m)", errorStreak: false, inFlight: false },
  ];
  const alerts = teamAlerts(
    base,
    ["Q1: which database? (asked 2026-09-29)", "Q2: tabs or spaces?"],
    roles,
    now,
  );
  assert.deepEqual(alerts.map((a) => a.key), ["failing", "stuck", "questions"]);
  const by = Object.fromEntries(alerts.map((a) => [a.key, a]));
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
  assert.equal(alerts.filter(alertNeedsYou).length, 3);
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
  for (const phase of ["working 1m", "reviewing 2m", "merging 1m · merging", "waiting to start 5s", "failing",
    "paused", "waiting: budget spent", "waiting: daily cap spent", "waiting: low disk", "waiting: bootstrap", "sleeping (for 5m)", "due", "ready for messages", "stopped"]) {
    const page = phaseInfo(phase).tone;
    // Awaiting a slot is pipeline work (blue) in the terminal; the page draws it quietly gray.
    if (phase.startsWith("waiting to start")) continue;
    assert.equal(phaseTone(phase), family[page], `${phase}: page ${page}`);
  }
  const resultFamily: Record<string, string | undefined> = { green: "green", indigo: "cyan", red: "red", amber: "yellow", gray: undefined };
  for (const result of ["changed", "queued", "refused", "no_change", "merge_conflict", "merge_blocked", "rejected", "review_error", "error",
    "aborted", "quiet_killed", "user_aborted", "skipped"]) {
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

// The standing doctor-twin alerts (docs/cli.md's `tumwater status` row): a snapshot whose raw
// flag stands raises the standing amber alert on the one shared source — the status banner, the
// dashboard and the TUI all render it from teamAlerts. Pre-fix the raw --json key stood with no
// rendered alert on any surface (BUGS.md 2026-10-31).
test("the standing amber alerts raise from the snapshot's raw flags, worded like their doctor rows", () => {
  const root = makeRepo();
  const config = defaultConfig();
  const raise = (flags: StandingFlags) => {
    const snap = { ...base, ...flags };
    return teamAlerts(snap, [], [], Date.now(), undefined, null, { snap, config, root });
  };
  const has = (flags: StandingFlags, key: string) => raise(flags).find((a) => a.key === key);

  // no-check: a fresh repo declares no build check — the doctor row's warn is the alert's detail.
  const noCheck = has({ noDeclaredCheck: true }, "no-check");
  assert.ok(noCheck, "a noDeclaredCheck snapshot raises the standing no-check alert");
  assert.equal(noCheck?.tone, "amber");
  assert.match(noCheck?.detail ?? "", /plan role will plan this project's check and the feature role declare it/);
  assert.ok(!has({}, "no-check"), "a check-declared snapshot raises nothing");

  // no-brief: a marker-less README is the silent state doctor warns on.
  fs.writeFileSync(path.join(root, "README.md"), "# p\n\nNo prompt block here.\n");
  const noBrief = has({ noBrief: true }, "no-brief");
  assert.ok(noBrief, "a noBrief snapshot raises the standing no-brief alert");
  assert.equal(noBrief?.tone, "amber");
  assert.match(noBrief?.detail ?? "", /no tumwater:prompt markers/);
  assert.ok(!has({}, "no-brief"), "the flag gates the alert: no flag, no alert");

  // brief-truncated: an over-cap block truncates every role's prompt at the read cap.
  fs.writeFileSync(path.join(root, "README.md"), `# p\n\n${PROMPT_START}\n${"x".repeat(BRIEF_TEXT_MAX_CHARS + 1)}\n${PROMPT_END}\n`);
  const truncated = has({ briefTruncated: true }, "brief-truncated");
  assert.ok(truncated, "a briefTruncated snapshot raises the standing brief-truncated alert");
  assert.equal(truncated?.tone, "amber");
  assert.match(truncated?.detail ?? "", /over the 4096-character read cap/);
  fs.writeFileSync(path.join(root, "README.md"), `# p\n\n${PROMPT_START}\nA brief.\n${PROMPT_END}\n`);
  assert.ok(!has({ briefTruncated: false }, "brief-truncated"), "a resolved brief raises nothing");

  // role-notes-truncated: an over-bound note reaches the role's prompt as only its head.
  fs.mkdirSync(path.dirname(roleNotesPath(root, "clean")), { recursive: true });
  fs.writeFileSync(roleNotesPath(root, "clean"), "x".repeat(ROLE_NOTES_MAX_BYTES + 1));
  const notes = has({ roleNotesOverCap: [{ role: "clean", chars: ROLE_NOTES_MAX_BYTES + 1 }] }, "role-notes-truncated");
  assert.ok(notes, "a roleNotesOverCap snapshot raises the standing role-notes-truncated alert");
  assert.equal(notes?.tone, "amber");
  assert.match(notes?.title ?? "", /1 role note over the 4096-character read bound/);
  assert.match(notes?.detail ?? "", /clean \(4097\)/);

  // instance-pool: the trigger is the CONFIGURED pool — a multi-instance role above 1 while
  // worktreeSlots sits below maxConcurrent — read from the config, so it stands even on a
  // stopped team where no slotPool snapshot exists.
  const poolSnap = { ...base };
  const withPool = (mutate: (c: ReturnType<typeof defaultConfig>) => void) => {
    const poolConfig = defaultConfig();
    mutate(poolConfig);
    return teamAlerts(poolSnap, [], [], Date.now(), undefined, null, { snap: poolSnap as StatusSnapshot, config: poolConfig, root });
  };
  const pool = withPool((c) => {
    c.roles["feature"] = { enabled: true, instances: 3 };
    c.worktreeSlots = 3; // below maxConcurrent 6
  }).find((a) => a.key === "instance-pool");
  assert.ok(pool, "a small pool with a multi-instance role raises the standing instance-pool alert");
  assert.equal(pool?.tone, "amber");
  assert.match(pool?.detail ?? "", /feature run instances but worktreeSlots 3 is below maxConcurrent 6/);
  // The default pool (unset worktreeSlots = maxConcurrent + 1) never contends.
  assert.ok(!withPool((c) => { c.roles["feature"] = { enabled: true, instances: 3 }; }).some((a) => a.key === "instance-pool"), "a default pool raises nothing");
  // A single-instance role never contends, however small the pool.
  assert.ok(!withPool((c) => { c.worktreeSlots = 3; }).some((a) => a.key === "instance-pool"), "no multi-instance role: nothing");

  // principlesTruncated: an over-cap PRINCIPLES.md truncates every role's <principles> block,
  // but raises no standing alert — the orchestrator queues the director a consolidation prompt
  // instead, so the over-cap state now surfaces only as the --json key and the doctor row.
  fs.writeFileSync(path.join(root, "PRINCIPLES.md"), "x".repeat(PRINCIPLES_MAX_CHARS + 1));
  assert.ok(!has({ principlesTruncated: true }, "principles-truncated"), "an over-cap principlesTruncated snapshot raises no alert");
  fs.rmSync(path.join(root, "PRINCIPLES.md"));
  assert.ok(!has({ principlesTruncated: false }, "principles-truncated"), "a no/under-cap principlesTruncated snapshot raises nothing");

  // config-problem: a non-empty configProblem stands from the snapshot string the `--json`
  // key carries — the sibling of the doctor `init` row's config-validity failure.
  const cfgProblem = has({ configProblem: "tumwater.json is missing — the team is running on its last known-good config (/x/tumwater.json)" }, "config-problem");
  assert.ok(cfgProblem, "a configProblem snapshot raises the standing config-problem alert");
  assert.equal(cfgProblem?.tone, "amber");
  assert.equal(cfgProblem?.title, "tumwater.json cannot be loaded — the team keeps its last good config");
  assert.match(cfgProblem?.detail ?? "", /fix or restore tumwater\.json; the running team keeps its last good config until it loads again/);
  assert.ok(!has({}, "config-problem"), "absent configProblem raises nothing");

  // salvage-patches: an operator-kept patch under .tumwater/salvage/ raises the alert with the
  // doctor row's detail; none raises nothing.
  fs.mkdirSync(salvageDir(root), { recursive: true });
  fs.writeFileSync(path.join(salvageDir(root), "a.patch"), "body");
  const salvage = has({ salvagePatches: [{ position: 1, file: "a.patch", savedAt: Date.now(), bytes: 4 }] }, "salvage-patches");
  assert.ok(salvage, "a salvagePatches snapshot raises the standing salvage-patches alert");
  assert.equal(salvage?.tone, "amber");
  assert.equal(salvage?.title, "Salvaged workspace patches kept for you");
  assert.match(salvage?.detail ?? "", /salvaged workspace patch kept for you/);
  assert.match(salvage?.detail ?? "", /1\. a\.patch/);
  assert.match(salvage?.detail ?? "", /tumwater salvage --drop/);
  assert.ok(!has({}, "salvage-patches"), "no kept patch raises nothing");
});

// The same alerts on the CLI surface: renderStatus composes the banners from the snapshot's
// raw flags, so `tumwater status` prints what docs/cli.md promises — not only --json.
test("tumwater status prints the standing no-check banner from the snapshot's flag", () => {
  const root = makeRepo();
  const flagged = { ...snapshotWith([{ role: "clean" }]), noDeclaredCheck: true };
  assert.match(renderStatus(root, flagged as StatusSnapshot), /No build check declared/);
  assert.doesNotMatch(renderStatus(root, snapshotWith([{ role: "clean" }])), /No build check declared/);
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

