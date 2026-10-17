import test from "node:test";
import assert from "node:assert/strict";
import { alertNeedsYou, teamAlerts, type AlertLoop } from "../src/ui/team-alerts.js";
import { phaseTone, resultTone } from "../src/ui/tone.js";
import { clientScope } from "./helpers/gui-client-scope.js";

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

test("a spent budget pauses the loops, or hands them to the free fallback", () => {
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
    { ...spent, budget: { ...spent.budget, fallback: { provider: "claude", model: "claude-sonnet-5-5" } } },
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

test("loop trouble, a stale build, questions, and a pause, most urgent first", () => {
  const now = Date.now();
  const loops: AlertLoop[] = [
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
    loops,
    now,
  );
  assert.deepEqual(alerts.map((a) => a.key), ["mainred", "failing", "stuck", "build", "questions", "paused"]);
  const by = Object.fromEntries(alerts.map((a) => [a.key, a]));
  assert.equal(by.mainred?.title, "main's check is failing — 1 role is blocked");
  assert.equal(by.failing?.title, "bugfix and qa are failing run after run");
  assert.equal(by.failing?.detail, "bugfix: 429 Rate limit exceeded · qa: see its transcript");
  assert.deepEqual(by.failing?.actions.map((a) => [a.act, a.arg]), [["role", "bugfix"], ["role", "qa"]], "each failing loop opens from the alert");
  assert.equal(by.stuck?.title, "feature and docs look stuck");
  // The tool-call stall gains the honest silence span from stuckMs (" for 12m00s"); the
  // "no agent output for 6m00s" phrase already carries its duration, so it does not double even
  // with a stuckMs present.
  assert.equal(by.stuck?.detail, "feature: tool call stalled: bash for 12m00s · docs: no agent output for 6m00s");
  assert.equal(by.build?.tone, "amber");
  assert.equal(by.build?.title, "Update available (3 commits behind) — restart blocked");
  assert.doesNotMatch(by.build?.detail ?? "", /T10:00:54/, "ISO instants read in local time");
  assert.equal(by.questions?.title, "2 questions need your answer");
  assert.equal(by.questions?.detail, "Q1: which database? — and 1 more", "a question's date note is metadata, not the question");
  assert.equal(by.paused?.title, "The team is paused and resumes in 12m");
  assert.equal(alerts.filter(alertNeedsYou).length, 6);
  // A build that is only behind (the restart will happen on its own) informs.
  const pending = teamAlerts({ ...base, build: { sha: "abc", builtAt: 0, stale: true, aheadCommits: 1, restartPending: true } }, [], [], now);
  assert.deepEqual(pending.map((a) => [a.key, a.tone, a.title]), [["build", "blue", "Update available (1 commit behind) — restarts when idle"]]);
  // A standing pause has no countdown; an expired deadline is not claimed.
  assert.equal(teamAlerts({ ...base, paused: true }, [], [], now)[0]?.title, "The team is paused");
  assert.equal(teamAlerts({ ...base, paused: true, pausedUntil: now - 1 }, [], [], now)[0]?.title, "The team is paused");

  // The operator's why (`pause --reason <text>`) states verbatim in the title, timed or not.
  const withWhy = teamAlerts({ ...base, paused: true, pauseReason: "deploying to prod" }, [], [], now);
  assert.equal(withWhy[0]?.title, "The team is paused — \"deploying to prod\"");
  const timedWhy = teamAlerts({ ...base, paused: true, pausedUntil: now + 12 * 60_000, pauseReason: "deploying to prod" }, [], [], now);
  assert.equal(timedWhy[0]?.title, "The team is paused and resumes in 12m — \"deploying to prod\"");
});

// The alert copy's count forms beyond the two-loop case above: a lone loop reads singular,
// three or more list as "a, b, and c", and a failing set where no loop recorded an error
// points at the transcripts instead of repeating an empty error list.
test("a lone failing or stuck loop reads singular; three loops list as a, b, and c", () => {
  const now = Date.now();
  const [one] = teamAlerts(base, [], [{ role: "bugfix", phase: "failing", errorStreak: true, inFlight: false, lastError: "pi exited null" }], now);
  assert.equal(one?.title, "bugfix is failing run after run");
  assert.equal(one?.detail, "bugfix: pi exited null");
  const three: AlertLoop[] = [
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

// A failing streak is the alert's tell, not the rendered phase: while a loop's own tick runs
// the phase reads "working"/"landing", but the red "failing run after run" banner must stay
// up (it clears only when the streak resets) — BUGS.md 2026-10-14. A plain working loop with no
// streak raises nothing.
test("a streak behind a working label still raises the failing alert; a healthily working loop raises none", () => {
  const now = Date.now();
  const streakWorking: AlertLoop[] = [
    { role: "bugfix", phase: "working 30s · turn 2 · reading BUGS.md", errorStreak: true, inFlight: true, lastError: "review rejected: not converging" },
  ];
  const [alert] = teamAlerts(base, [], streakWorking, now);
  assert.equal(alert?.key, "failing");
  assert.equal(alert?.tone, "red");
  assert.equal(alert?.title, "bugfix is failing run after run");
  assert.equal(alert?.detail, "bugfix: review rejected: not converging");
  assert.deepEqual(alert?.actions.map((a) => [a.act, a.arg]), [["role", "bugfix"]]);

  const healthyWorking: AlertLoop[] = [
    { role: "feature", phase: "working 30s · turn 1", errorStreak: false, inFlight: true },
    { role: "qa", phase: "merging 1s · build-check", errorStreak: false, inFlight: true },
  ];
  assert.equal(teamAlerts(base, [], healthyWorking, now).filter((a) => a.key === "failing").length, 0);
});

// The detail arms the two-loop case above cannot reach: a fallback named by provider alone
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
// every enabled loop reads images (or capability is unknown — an unknown seam is not counted
// as text-only). Blue when every text-only loop has a reroute target (a blind read reruns — an
// inform, not an ask); amber when some text-only loop has none (a blind read fails and image
// submissions are refused). A separate amber when a claimed model failed doctor's live probe.
test("images alert: parity needs no alert; a text-only team with targets is blue", () => {
  const vision: AlertLoop[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: true, imageReroute: null },
    { role: "plan", phase: "idle", errorStreak: false, inFlight: false, imageInput: true, imageReroute: null },
  ];
  assert.deepEqual(teamAlerts(base, [], vision, Date.now()).filter((a) => a.key === "images"), []);
  // Unknown capability is not counted as text-only — no alert, matching the doctor's stance.
  const unknown: AlertLoop[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: null, imageReroute: null },
  ];
  assert.deepEqual(teamAlerts(base, [], unknown, Date.now()).filter((a) => a.key === "images"), []);

  const rerouting: AlertLoop[] = [
    { role: "feature", phase: "idle", errorStreak: false, inFlight: false, imageInput: false, imageReroute: "strong (claude-opus-5-5)" },
    { role: "organize", phase: "idle", errorStreak: false, inFlight: false, imageInput: false, imageReroute: "strong (claude-opus-5-5)" },
  ];
  const [images] = teamAlerts(base, [], rerouting, Date.now()).filter((a) => a.key === "images");
  assert.equal(images?.tone, "blue");
  assert.equal(images?.title, "feature and organize run on models that can't read images");
  assert.match(images?.detail ?? "", /stops and reruns on strong \(claude-opus-5-5\)\./);
  assert.equal(alertNeedsYou(images!), false, "a rerun means nothing fails — it informs");
});

test("images alert: a text-only loop with no target is amber and asks", () => {
  const noTarget: AlertLoop[] = [
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

test("images alert: a cached probe failure is amber, whatever the loops resolved to", () => {
  const over = teamAlerts({ ...base, imageProbeFailures: ["local/vision"] }, [], [], Date.now());
  const [probe] = over.filter((a) => a.key === "images-probe");
  assert.equal(probe?.tone, "amber");
  assert.match(probe?.title ?? "", /failed doctor's probe/);
  assert.match(probe?.detail ?? "", /local\/vision declare image input but failed/);
  assert.equal(alertNeedsYou(probe!), true);
});

test("refused entries raise a standing amber alert right after the questions alert", () => {
  const now = Date.now();
  const one = teamAlerts(base, [], [], now, ["Split X (planned 2026-10-14 by plan)"]);
  assert.deepEqual(one.map((a) => [a.key, a.tone, a.title]), [["refused", "amber", "1 refused entry waits on your decision"]]);
  assert.ok(one[0]!.detail.startsWith("Split X ·"));
  assert.ok(one[0]!.detail.includes("--release"));
  assert.deepEqual(one[0]!.actions, [{ label: "Open backlog", act: "backlog" }]);
  const two = teamAlerts(base, [], [], now, ["A (planned 2026-10-14)", "B (reported 2026-10-14)"]);
  assert.equal(two[0]!.title, "2 refused entries wait on your decision");
  assert.ok(two[0]!.detail.includes("— and 1 more"));
  const both = teamAlerts(base, ["Q? (asked 2026-10-14)"], [], now, ["A"]);
  assert.deepEqual(both.map((a) => a.key), ["questions", "refused"]);
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
