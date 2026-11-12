import test from "node:test";
import assert from "node:assert/strict";
import { buildStatusAlerts } from "../src/ui/team-alert-status.js";
import { formatClock } from "../src/text/datetime.js";
import type { ModelCheckInfo } from "../src/team/team-orchestrator-info.js";

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
