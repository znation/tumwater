import test from "node:test";
import assert from "node:assert/strict";
import { buildGithubScanAlerts, buildStatusAlerts } from "../src/ui/team-alert-status.js";
import { formatClock } from "../src/text/datetime.js";
import type { ModelCheckInfo } from "../src/team/team-orchestrator-info-types.js";
import type { StatusSnapshot } from "../src/status/status-types.js";

// team-alert-status.ts's buildStatusAlerts: the status and role-phase alerts build the
// per-domain alert list this run reads. The chain/budget/disk/install/failing/stuck arms are
// pinned through teamAlerts (test/team-alerts.test.ts); the model-check alert is the one arm no
// test reached — a failed provider/model pair must name the pair, why it failed, the seams it
// serves, and the next probe, and clear on its own when the pair answers.

const base = {
  budget: { spentUsd: 1, capUsd: 10, capHitAt: null, free: true, fallback: null },
  chain: {},
  budgetPausedRoles: [],
};

const alertsFor = (modelChecks: ModelCheckInfo[]) =>
  buildStatusAlerts({ snap: { ...base, modelChecks }, roles: [] });

test("one failed pair raises one modelcheck alert naming the pair and the way out", () => {
  const probeAt = Date.UTC(2026, 10, 12, 14, 30, 0); // 14:30 local
  const [alert] = alertsFor([
    { pair: "DeepSeek-V4-Flash", status: "failed", seams: ["default"], reason: "no reply", probeAt, failures: 2 },
  ]);
  assert.ok(alert, "a failed pair must raise the modelcheck alert");
  assert.equal(alert?.key, "modelcheck");
  assert.equal(alert?.tone, "red");
  assert.equal(alert?.title, "DeepSeek-V4-Flash failed its model check — runs on it wait");
  assert.equal(
    alert?.detail,
    `DeepSeek-V4-Flash (default) gave no reply; checking again at ${formatClock(probeAt)}`,
  );
  assert.deepEqual(alert?.actions, [{ label: "Re-check now", act: "model-check" }]);
});

test("a wrong-answer reply is quoted; more than one pair raises the plural heading", () => {
  const [alert] = alertsFor([
    { pair: "gpt-4o", status: "failed", seams: [], reason: "wrong answer", reply: "42" },
    { pair: "claude-3.5", status: "failed", seams: [], reason: "no reply", detail: "timeout" },
  ]);
  assert.ok(alert);
  assert.equal(alert?.title, "2 models failed their model check — runs on them wait");
  // Each failed pair gets its own sentence joined with ` · `; the whole thing is one action.
  assert.equal(alert?.detail, 'gpt-4o replied "42" instead of the probe\'s one-word answer · claude-3.5 gave no reply (timeout)');
  assert.equal(alert?.actions.length, 1, "one action re-checks every failed pair");
});

test("a failed pair without a probe time and on no seam keeps the bare sentence", () => {
  const [alert] = alertsFor([{ pair: "llama-free", status: "failed", seams: [], reason: "no reply" }]);
  assert.ok(alert);
  assert.equal(alert?.detail, "llama-free gave no reply");
});

test("verified and checking pairs raise nothing; an absent modelChecks block raises nothing", () => {
  assert.deepEqual(
    alertsFor([
      { pair: "DeepSeek-V4-Flash", status: "verified", seams: ["default"] },
      { pair: "gpt-4o", status: "checking", seams: ["strong"] },
    ]),
    [],
    "only a failed status raises the alert",
  );
  assert.deepEqual(buildStatusAlerts({ snap: base, roles: [] }), [], "no modelChecks block: nothing");
});

// The session-prune banner (team-alert-status.ts pushMaintenanceAlert): blue, first in the list,
// with the progress, the ETA when there is one, the start time and the restart warning.
const pruneSnap = (maintenance: NonNullable<StatusSnapshot["maintenance"]>) => ({ ...base, maintenance });

test("a session-prune pass raises a blue banner that leads the status alerts", () => {
  const startedAt = Date.UTC(2026, 10, 21, 22, 38, 0);
  const alerts = buildStatusAlerts({
    snap: {
      ...pruneSnap({ pid: 4242, task: "session-prune", backend: "codex", done: 1204, total: 3944, startedAt, halfStartedAt: startedAt, updatedAt: startedAt + 1, etaMs: 48 * 60_000 }),
      modelChecks: [{ pair: "DeepSeek-V4-Flash", status: "failed", seams: ["default"], reason: "no reply", probeAt: startedAt, failures: 2 }],
    },
    roles: [],
  });
  assert.equal(alerts[0]?.key, "maintenance", "the banner explains every other symptom, so it sorts first");
  assert.equal(alerts[1]?.key, "modelcheck");
  const [banner] = alerts;
  assert.equal(banner?.tone, "blue");
  assert.equal(banner?.title, "Cleaning up expired sessions in the background");
  assert.equal(
    banner?.detail,
    `deleting expired codex sessions: 1,204 / 3,944 · about 48 min left · started ${formatClock(startedAt)}.`,
  );
  assert.deepEqual(banner?.actions, [], "the banner offers no action");
});

test("a session-prune pass with no ETA yet omits the ETA clause and names session files", () => {
  const startedAt = Date.UTC(2026, 10, 21, 22, 38, 0);
  const [banner] = buildStatusAlerts({
    snap: pruneSnap({ pid: 4242, task: "session-prune", backend: "files", done: 3, total: 40, startedAt, halfStartedAt: startedAt, updatedAt: startedAt }),
    roles: [],
  });
  assert.equal(
    banner?.detail,
    `deleting expired session files: 3 / 40 · started ${formatClock(startedAt)}.`,
  );
});

test("no session-prune marker raises no maintenance banner", () => {
  const alerts = buildStatusAlerts({ snap: base, roles: [] });
  assert.equal(alerts.some((a) => a.key === "maintenance"), false);
});

// The poll-stall alert (team-alert-status.ts pushPollStallAlert): amber, no action, titled with
// the stall threshold in minutes, and it names the last stamp so the operator can see the age.
test("a stalled poll loop raises an amber alert naming the threshold and the last stamp", () => {
  const lastPollAt = Date.UTC(2026, 10, 21, 22, 36, 0);
  const alerts = buildStatusAlerts({ snap: { ...base, pollStalled: { lastPollAt } }, roles: [] });
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert?.key, "pollStalled");
  assert.equal(alert?.tone, "amber");
  assert.equal(alert?.title, "Orchestrator hasn't polled for 3m — it may be blocked");
  assert.equal(alert?.detail, `last poll stamped at ${formatClock(lastPollAt)}; no role is scheduled until it resumes.`);
  assert.deepEqual(alert?.actions, [], "the alert offers no action");
});

// The GitHub close alert (team-alert-status.ts pushGithubCloseAlert): blue, no action, and one
// sentence per count: a fix waiting for a push, and an issue whose entries were all retired.
test("a fix waiting for a push raises a blue alert naming the repo; retired-only issues add a clause", () => {
  const waiting = buildStatusAlerts({
    snap: { ...base, githubClose: { repo: "o/r", waitingPush: 1, retiredOnly: 0 } },
    roles: [],
  });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]?.key, "github-close");
  assert.equal(waiting[0]?.tone, "blue");
  assert.equal(waiting[0]?.title, "1 GitHub issue is fixed on main and closes when you push main to o/r");
  assert.deepEqual(waiting[0]?.actions, [], "the alert offers no action");

  const both = buildStatusAlerts({
    snap: { ...base, githubClose: { repo: "o/r", waitingPush: 1, retiredOnly: 1 } },
    roles: [],
  });
  assert.equal(
    both[0]?.title,
    "1 GitHub issue is fixed on main and closes when you push main to o/r · 1 mirrored issue's entries were all retired — close or re-file it on GitHub",
  );
});

test("no GitHub close figures raise no GitHub close alert", () => {
  assert.equal(buildStatusAlerts({ snap: base, roles: [] }).some((a) => a.key === "github-close"), false);
});

test("no stalled poll raises no poll-stall alert", () => {
  const alerts = buildStatusAlerts({ snap: base, roles: [] });
  assert.equal(alerts.some((a) => a.key === "pollStalled"), false);
});

// The GitHub issues alerts (plans/github-issues.md, part 3/5): the amber gh banner rides the
// status builder; the gray scan-failure and blue mirror banners follow the backlog alerts.
const ghSnap = (githubIssues: NonNullable<StatusSnapshot["githubIssues"]>) => ({ ...base, githubIssues });
const ghSummary = (over: Partial<NonNullable<StatusSnapshot["githubIssues"]>>) => ({
  repo: "acme/widgets",
  gh: "ok" as const,
  checkedAt: Date.UTC(2026, 10, 21, 10, 0, 0),
  unmirrored: 0,
  untrusted: 0,
  waitingPush: 0,
  mirrorLabel: "tumwater",
  upstreamClosed: 0,
  ...over,
});

test("an unauthenticated gh raises one amber github-gh alert with the doctor's sentence", () => {
  const alerts = buildStatusAlerts({ snap: ghSnap(ghSummary({ gh: "unauthenticated" })), roles: [] });
  const [alert] = alerts.filter((a) => a.key === "github-gh");
  assert.equal(alerts.length, 1);
  assert.equal(alert?.tone, "amber");
  assert.equal(alert?.title, "Can't read GitHub issues for acme/widgets");
  assert.equal(
    alert?.detail,
    "gh is not logged in — run `gh auth login` so tumwater can read acme/widgets's issues, or set githubIssues.enabled to false",
  );
});

test("a missing gh raises the amber alert with the missing-gh sentence", () => {
  const [alert] = buildStatusAlerts({ snap: ghSnap(ghSummary({ gh: "missing" })), roles: [] });
  assert.equal(alert?.key, "github-gh");
  assert.equal(
    alert?.detail,
    "gh is missing — install GitHub CLI (https://cli.github.com) so tumwater can read acme/widgets's issues, or set githubIssues.enabled to false",
  );
});

test("a healthy gh with nothing waiting raises none of the GitHub alerts", () => {
  const snap = ghSnap(ghSummary({}));
  assert.deepEqual(buildStatusAlerts({ snap, roles: [] }), []);
  assert.deepEqual(buildGithubScanAlerts({ snap, now: Date.UTC(2026, 10, 21, 10, 5, 0) }), []);
});

test("two unmirrored and three untrusted issues name the configured label in one blue alert", () => {
  const alerts = buildGithubScanAlerts({ snap: ghSnap(ghSummary({ unmirrored: 2, untrusted: 3 })), now: 0 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.key, "github-mirror");
  assert.equal(alerts[0]?.tone, "blue");
  assert.equal(
    alerts[0]?.detail,
    "2 open issues on acme/widgets are waiting for the director to mirror them · 3 from outside collaborators are not mirrored — add the label `tumwater` to let one in",
  );
});

test("a zero count drops its clause from the blue alert", () => {
  const [alert] = buildGithubScanAlerts({ snap: ghSnap(ghSummary({ unmirrored: 2, mirrorLabel: "ship-it" })), now: 0 });
  assert.equal(
    alert?.detail,
    "2 open issues on acme/widgets are waiting for the director to mirror them",
  );
  const [outside] = buildGithubScanAlerts({ snap: ghSnap(ghSummary({ untrusted: 1, mirrorLabel: "ship-it" })), now: 0 });
  assert.equal(
    outside?.detail,
    "1 from outside collaborators is not mirrored — add the label `ship-it` to let one in",
  );
});

test("a failed scan raises the gray error alert with its reason and age", () => {
  const now = Date.UTC(2026, 10, 21, 10, 5, 0);
  const [alert] = buildGithubScanAlerts({
    snap: ghSnap(ghSummary({ gh: "error", reason: "gh api failed: rate limit exceeded" })),
    now,
  });
  assert.equal(alert?.key, "github-error");
  assert.equal(alert?.tone, "gray");
  assert.equal(alert?.title, "Last GitHub issue scan failed");
  assert.ok(alert?.detail.startsWith("gh api failed: rate limit exceeded · checked "));
  assert.ok(alert?.detail.endsWith(" ago"));
});

// The mirror's scan gone quiet (the standing-banner plan): the amber `github-scan-stalled` banner
// rides the scan builder, between the gray failure and the blue mirror-waiting banner, and speaks
// the doctor's sentence.
const stallNow = Date.UTC(2026, 10, 21, 10, 0, 0);
const stalled = (over: Partial<NonNullable<StatusSnapshot["githubScanStall"]>> = {}) => ({
  repo: "acme/widgets",
  checkedAt: stallNow - 4 * 86_400_000,
  ...over,
});

test("a stalled scan raises one amber github-scan-stalled banner with the doctor's sentence", () => {
  const snap = { ...ghSnap(ghSummary({})), githubScanStall: stalled() };
  const alerts = buildGithubScanAlerts({ snap, now: stallNow });
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert?.key, "github-scan-stalled");
  assert.equal(alert?.tone, "amber");
  assert.equal(alert?.title, "GitHub mirror");
  assert.equal(
    alert?.detail,
    "the last scan checked acme/widgets 4d ago, over 3 days ago, so tumwater is not mirroring its open issues",
  );
});

test("a failed and stalled scan orders the banners gray, amber, blue", () => {
  const snap = {
    ...ghSnap(ghSummary({ gh: "error" as const, reason: "gh api failed", unmirrored: 1, untrusted: 1 })),
    githubScanStall: stalled(),
  };
  assert.deepEqual(
    buildGithubScanAlerts({ snap, now: stallNow }).map((a) => a.key),
    ["github-error", "github-scan-stalled", "github-mirror"],
  );
});

test("an unreadable gh keeps the stall banner behind it", () => {
  // The alert twin of checkGithubIssues' precedence: the gh banner names the cause, so a stale
  // ledger on top of it raises nothing extra.
  for (const gh of ["missing", "unauthenticated"] as const) {
    const snap = { ...ghSnap(ghSummary({ gh })), githubScanStall: stalled() };
    const scan = buildGithubScanAlerts({ snap, now: stallNow });
    assert.deepEqual(scan.map((a) => a.key), [], `no scan banner with gh ${gh}`);
    const status = buildStatusAlerts({ snap, roles: [] });
    assert.deepEqual(status.map((a) => a.key), ["github-gh"]);
  }
});

test("no stall field, or no ledger, raises no stall banner", () => {
  // A fresh scan: the ledger is present and current, githubIssuesForPoll leaves the field off.
  assert.deepEqual(
    buildGithubScanAlerts({ snap: ghSnap(ghSummary({})), now: stallNow }).map((a) => a.key),
    [],
  );
  // A snapshot with no ledger section at all: the builder returns before the stall arm.
  assert.deepEqual(buildGithubScanAlerts({ snap: { githubScanStall: stalled() }, now: stallNow }), []);
});

// The upstream-close count (INV-DG2): the mirror's one standing signal for issues GitHub closed
// upstream that this workspace never merged a fix for. Blue, and its detail is the doctor row's one
// sentence over the same count.
test("two upstream closes raise one blue github-upstream-closes banner with the doctor's sentence", () => {
  const alerts = buildGithubScanAlerts({ snap: ghSnap(ghSummary({ upstreamClosed: 2 })), now: stallNow });
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert?.key, "github-upstream-closes");
  assert.equal(alert?.tone, "blue");
  assert.equal(alert?.title, "GitHub issues closed upstream");
  assert.equal(alert?.detail, "2 open issues on acme/widgets were closed upstream with no fix merged by tumwater");
  assert.deepEqual(alert?.actions, []);
});

test("one upstream close agrees with its count", () => {
  const [alert] = buildGithubScanAlerts({ snap: ghSnap(ghSummary({ upstreamClosed: 1 })), now: stallNow });
  assert.equal(alert?.detail, "1 open issue on acme/widgets was closed upstream with no fix merged by tumwater");
});

test("a zero upstream-close count raises no banner and moves no other banner", () => {
  // The blue mirror banner and the upstream-close banner are separate arms at separate keys.
  const both = buildGithubScanAlerts({
    snap: ghSnap(ghSummary({ unmirrored: 1, upstreamClosed: 2 })),
    now: stallNow,
  });
  assert.deepEqual(both.map((a) => a.key), ["github-mirror", "github-upstream-closes"]);
  assert.deepEqual(
    buildGithubScanAlerts({ snap: ghSnap(ghSummary({ unmirrored: 1, upstreamClosed: 0 })), now: stallNow }).map((a) => a.key),
    ["github-mirror"],
  );
});

test("the upstream-close banner sits after every existing scan banner", () => {
  const snap = {
    ...ghSnap(ghSummary({ gh: "error" as const, reason: "gh api failed", unmirrored: 1, untrusted: 1, upstreamClosed: 4 })),
    githubScanStall: stalled(),
  };
  assert.deepEqual(
    buildGithubScanAlerts({ snap, now: stallNow }).map((a) => a.key),
    ["github-error", "github-scan-stalled", "github-mirror", "github-upstream-closes"],
  );
});
