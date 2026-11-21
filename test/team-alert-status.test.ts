import test from "node:test";
import assert from "node:assert/strict";
import { buildStatusAlerts } from "../src/ui/team-alert-status.js";
import { formatClock } from "../src/text/datetime.js";
import type { ModelCheckInfo } from "../src/team/team-orchestrator-info.js";
import type { StatusSnapshot } from "../src/status/status-data.js";

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
  assert.equal(banner?.title, "Cleaning up expired sessions — roles start when it finishes");
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

test("no stalled poll raises no poll-stall alert", () => {
  const alerts = buildStatusAlerts({ snap: base, roles: [] });
  assert.equal(alerts.some((a) => a.key === "pollStalled"), false);
});
