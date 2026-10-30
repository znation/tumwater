// The model check (src/model-check/): the probe's verdict on a reply, the per-pair state machine,
// the per-poll gate's holds/events/publish over a fake prober, and the doctor/alert/role-row
// surfaces that read what it publishes. The probe through real backend fakes is in
// model-check-probe.test.ts; the whole loop through runOrchestrator in
// orchestrator-model-check.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeModelReply,
  MODEL_CHECK_ANSWER,
  MODEL_CHECK_MARKER,
  MODEL_CHECK_PROMPT,
  REPLY_EXCERPT_CHARS,
  type ModelCheckVerdict,
} from "../src/model-check/model-check-probe.js";
import {
  dueModelChecks,
  modelCheckFailed,
  modelCheckHolds,
  recordModelCheck,
  rekeyModelChecks,
  startModelCheck,
  suspectModelCheck,
  type ModelCheckPolicy,
} from "../src/model-check/model-check.js";
import { ModelCheckGate } from "../src/model-check/model-check-gate.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import { defaultConfig } from "../src/config/config.js";
import { configForRole, type ResolvedModelConfig } from "../src/config/config-views.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { OrchestratorInfo } from "../src/team/team-orchestrator-info.js";
import { readOrchestratorInfo, writeOrchestratorInfo } from "../src/team/team-orchestrator-info.js";
import { checkFallbackModel, checkModelChecks } from "../src/doctor/doctor-fallback-checks.js";
import { teamAlerts } from "../src/ui/team-alerts.js";
import { rolePhase } from "../src/ui/status-model.js";
import { pollBudgetGate, newBudgetGateState } from "../src/gates/budget-gates.js";
import { todayStamp } from "../src/budget/budget.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { readyRepo } from "./fixtures/doctor-fixtures.js";
import { writeModelsFile } from "./fixtures/models-fixtures.js";
import { eventsOfType, warningEvents } from "./fixtures/log-fixtures.js";
import { readEvents } from "../src/events/event-read.js";

/** A finished run's result with only the fields the verdict reads set. */
function result(over: Partial<PiRunResult>): PiRunResult {
  return { finalText: "", aborted: false, timedOut: false, quietKilled: false, ...over } as PiRunResult;
}

/** The failed verdict `v` must be, narrowed (a failed assertion names what came back instead). */
function failure(v: ModelCheckVerdict): Extract<ModelCheckVerdict, { ok: false }> {
  if (!("reason" in v)) assert.fail(`expected a failed verdict, got ${JSON.stringify(v)}`);
  return v;
}

const POLICY: ModelCheckPolicy = { retryMs: 60_000, maxRetryMs: 4 * 60_000, suspectMinMs: 10 * 60_000 };

test("the probe prompt is a few hundred tokens and carries its marker and answer", () => {
  // Flint's broken kernel only ran past ~32 tokens: a short probe would have passed it. A rough
  // 4-chars-per-token estimate keeps the prompt in the 150–300 token band.
  const tokens = MODEL_CHECK_PROMPT.length / 4;
  assert.ok(tokens >= 150 && tokens <= 300, `~${Math.round(tokens)} tokens`);
  assert.ok(MODEL_CHECK_PROMPT.includes(MODEL_CHECK_MARKER));
  assert.ok(MODEL_CHECK_PROMPT.includes(MODEL_CHECK_ANSWER), "the answer is in the paragraph");
});

test("judgeModelReply: the answer verifies, garbage and silence fail, an abort is no evidence", () => {
  assert.deepEqual(judgeModelReply(result({ finalText: "Isselmar" })), { ok: true });
  assert.deepEqual(judgeModelReply(result({ finalText: "The Varrow joins the isselmar." })), { ok: true });
  // Word salad from a broken prefill: the reply is quoted, cut to the excerpt length.
  const salad = "the of river the and of Callow mills the the ".repeat(20);
  const wrong = failure(judgeModelReply(result({ finalText: salad, stopReason: "length" })));
  assert.equal(wrong.reason, "wrong answer");
  assert.ok(wrong.reply.length <= REPLY_EXCERPT_CHARS, "the excerpt is bounded");
  assert.ok(wrong.reply.startsWith("the of river the and"));
  // A run that never answered: the run's own error, or the timeout, names why.
  assert.deepEqual(judgeModelReply(result({ ok: false, errorMessage: "connect ECONNREFUSED 127.0.0.1:8091" })), {
    ok: false,
    reason: "no reply",
    reply: "",
    detail: "connect ECONNREFUSED 127.0.0.1:8091",
  });
  const timedOut = failure(judgeModelReply(result({ timedOut: true })));
  assert.equal(timedOut.reason, "no reply");
  assert.match(timedOut.detail ?? "", /no answer within \d+s/);
  assert.deepEqual(judgeModelReply(result({ aborted: true, finalText: "" })), { ok: null });
});

test("the state machine: new pairs are due, verdicts verify or back off, suspicion re-checks", () => {
  let map = rekeyModelChecks({}, ["a/x", "b/y"], 1000);
  assert.deepEqual(dueModelChecks(map, 1000), ["a/x", "b/y"], "a pair seen for the first time is checked at once");
  assert.ok(modelCheckHolds(map["a/x"]), "an unchecked pair holds its roles");
  map = startModelCheck(map, "a/x");
  assert.deepEqual(dueModelChecks(map, 1000), ["b/y"], "one probe per pair in flight");
  map = recordModelCheck(map, "a/x", { ok: true }, 2000, POLICY);
  assert.equal(map["a/x"]?.status, "verified");
  assert.ok(!modelCheckHolds(map["a/x"]));
  assert.ok(!modelCheckHolds(undefined), "a pair the check does not track holds nothing");

  // Failures back off from the first wait, doubling to the cap.
  const fail: ModelCheckVerdict = { ok: false, reason: "wrong answer", reply: "salad" };
  map = recordModelCheck(startModelCheck(map, "b/y"), "b/y", fail, 2000, POLICY);
  assert.deepEqual([map["b/y"]?.status, map["b/y"]?.failures, map["b/y"]?.probeAt], ["failed", 1, 62_000]);
  assert.ok(modelCheckFailed(map, "b/y") && !modelCheckFailed(map, "a/x"));
  assert.deepEqual(dueModelChecks(map, 61_999), []);
  assert.deepEqual(dueModelChecks(map, 62_000), ["b/y"]);
  map = recordModelCheck(map, "b/y", fail, 62_000, POLICY);
  assert.equal(map["b/y"]?.retryMs, 120_000);
  map = recordModelCheck(map, "b/y", fail, 182_000, POLICY);
  map = recordModelCheck(map, "b/y", fail, 422_000, POLICY);
  assert.equal(map["b/y"]?.retryMs, 240_000, "capped at maxRetryMs");
  // An aborted probe frees the slot and records nothing.
  const aborted = recordModelCheck(startModelCheck(map, "b/y"), "b/y", { ok: null }, 500_000, POLICY);
  assert.deepEqual({ ...aborted["b/y"], probing: true }, { ...map["b/y"], probing: true });
  assert.equal(aborted["b/y"]?.probing, false);
  // An answer clears the failure.
  map = recordModelCheck(map, "b/y", { ok: true }, 700_000, POLICY);
  assert.deepEqual([map["b/y"]?.status, map["b/y"]?.failures, map["b/y"]?.reply], ["verified", 0, undefined]);

  // Suspicion re-checks a verified pair, at most once per suspectMinMs; the pair stays verified.
  assert.equal(suspectModelCheck(map, "a/x", 2000 + POLICY.suspectMinMs - 1, POLICY)["a/x"]?.probeAt, null);
  const suspected = suspectModelCheck(map, "a/x", 2000 + POLICY.suspectMinMs, POLICY);
  assert.deepEqual(dueModelChecks(suspected, 2000 + POLICY.suspectMinMs), ["a/x"]);
  assert.equal(suspected["a/x"]?.status, "verified");

  // A pair no seam uses any more is dropped, and checked afresh if it comes back.
  map = rekeyModelChecks(map, ["a/x"], 800_000);
  assert.deepEqual(Object.keys(map), ["a/x"]);
  assert.equal(rekeyModelChecks(map, ["a/x", "b/y"], 900_000)["b/y"]?.status, "checking");
});

/** A runner as the gate reads it: id, config, state, and the config its next run uses. */
function runner(role: string, config: TumwaterConfig): RoleRunner {
  return { role, config, state: freshRunnerState(role), runConfig: () => configForRole(config, role) } as unknown as RoleRunner;
}

/** A team on a local default tier and a hosted strong tier, with review on. */
function teamConfig(): TumwaterConfig {
  const c: TumwaterConfig = defaultConfig();
  c.model = { default: "flintrunner/flint", strong: "hf/deepseek" };
  for (const [id, role] of Object.entries(c.roles)) role.enabled = ["feature", "plan", "director"].includes(id);
  return c;
}

/** A prober whose answers the test releases by hand, recording each seam it was asked about. */
function manualProber() {
  const asked: string[] = [];
  const pending = new Map<string, (v: ModelCheckVerdict) => void>();
  const signals: AbortSignal[] = [];
  const prober = (seam: ResolvedModelConfig, signal: AbortSignal): Promise<ModelCheckVerdict> => {
    const pair = `${seam.provider}/${seam.model}`;
    asked.push(pair);
    signals.push(signal);
    return new Promise((resolve) => pending.set(pair, resolve));
  };
  const answer = (pair: string, v: ModelCheckVerdict): void => {
    const r = pending.get(pair);
    assert.ok(r, `no probe in flight for ${pair}`);
    pending.delete(pair);
    r(v);
  };
  return { prober, asked, answer, signals };
}

test("the gate holds a pair's roles until it answers, warns once on failure, and resumes on a re-check", async () => {
  const root = makeRepo();
  const config = teamConfig();
  const runners = ["feature", "plan", "director"].map((r) => runner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: runners.map((r) => r.role) };
  writeOrchestratorInfo(root, info);
  let now = 1_000_000;
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = () => gate.poll({ runners, liveConfig: config, roleConfig: config, info });

  // Startup: both pairs are probed at once, and every role waits for its pair's verdict (the
  // reviewer's pair, strong, also holds every role but the director).
  assert.deepEqual([...poll()].sort(), ["director", "feature", "plan"]);
  assert.deepEqual(asked.sort(), ["flintrunner/flint", "hf/deepseek"]);
  assert.deepEqual([...poll()].sort(), ["director", "feature", "plan"], "no second probe while one is in flight");
  assert.equal(asked.length, 2);

  // strong answers, default replies with salad: only the default-tier role waits.
  answer("hf/deepseek", { ok: true });
  answer("flintrunner/flint", { ok: false, reason: "wrong answer", reply: "the of the river and of the" });
  await gate.settled();
  assert.deepEqual([...poll()], ["feature"]);
  assert.deepEqual([...gate.held], ["feature"], "the start gate reads the latest held set");
  const warnings = warningEvents(readEvents(root)).map((e) => String(e.message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^model check failed: flintrunner\/flint replied "the of the river and of the" instead of the probe's one-word answer — runs on it wait \(feature/);
  assert.match(warnings[0]!, /next check in 1m$/);
  const published = readOrchestratorInfo(root)?.modelChecks ?? [];
  const flint = published.find((c) => c.pair === "flintrunner/flint");
  assert.deepEqual(
    [flint?.status, flint?.reason, flint?.reply, flint?.probeAt, flint?.seams[0]],
    ["failed", "wrong answer", "the of the river and of the", now + POLICY.retryMs, "feature"],
  );
  assert.equal(published.find((c) => c.pair === "hf/deepseek")?.status, "verified");

  // Not due yet: no re-probe. Due: it re-probes; a second failure stays quiet and backs off.
  now += POLICY.retryMs - 1;
  poll();
  assert.equal(asked.length, 2);
  now += 1;
  poll();
  assert.deepEqual(asked.slice(2), ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "connect ECONNREFUSED" });
  await gate.settled();
  assert.deepEqual([...poll()], ["feature"]);
  assert.equal(warningEvents(readEvents(root)).length, 1, "a failed re-check does not warn again");
  assert.equal(readOrchestratorInfo(root)?.modelChecks?.find((c) => c.pair === "flintrunner/flint")?.detail, "connect ECONNREFUSED");

  // The server is fixed: the next re-check answers, the role runs again, and the lift is logged.
  now += 2 * POLICY.retryMs;
  poll();
  answer("flintrunner/flint", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll()], []);
  const passed = eventsOfType(root, "model_check_passed");
  assert.deepEqual(passed.map((e) => [e.pair, e.failures]), [["flintrunner/flint", 2]]);
});

test("the gate re-checks a suspected pair, follows a config edit, and aborts its probes on close", async () => {
  const root = makeRepo();
  let config = teamConfig();
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 5_000_000;
  const { prober, asked, answer, signals } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = (c: TumwaterConfig) =>
    gate.poll({ runners: ["feature", "plan"].map((r) => runner(r, c)), liveConfig: c, roleConfig: c, info });
  poll(config);
  answer("flintrunner/flint", { ok: true });
  answer("hf/deepseek", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll(config)], []);

  // A run on flint ended without changes and without declaring nothing-to-do: re-check it, while
  // its roles keep running on the verdict they had.
  now += POLICY.suspectMinMs;
  gate.suspect("flintrunner/flint");
  assert.deepEqual([...poll(config)], []);
  assert.deepEqual(asked.slice(2), ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: false, reason: "wrong answer", reply: "salad" });
  await gate.settled();
  assert.deepEqual([...poll(config)], ["feature"]);

  // A config edit that moves the default tier to another pair checks that pair before the role
  // runs on it, and forgets the old one.
  config = { ...config, model: { default: "omlx/qwen", strong: "hf/deepseek" } };
  assert.deepEqual([...poll(config)], ["feature"]);
  assert.deepEqual(asked.slice(3), ["omlx/qwen"]);
  assert.ok(!Object.keys(gate.checks).includes("flintrunner/flint"));

  // Shutdown aborts the probe in flight.
  const closed = gate.close();
  assert.equal(signals.at(-1)?.aborted, true);
  answer("omlx/qwen", { ok: null });
  await closed;
});

test("a failed fallback step is skipped by the budget gate's chain at the cap", () => {
  const root = makeRepo();
  const modelsPath = writeModelsFile(
    tmpdir("model-check-models-"),
    JSON.stringify({ providers: { local: { models: [{ id: "a" }, { id: "b" }] } } }),
  );
  const config = defaultConfig();
  config.maxDailyCostUsd = 0.000001;
  config.fallback = ["local/a", "local/b"];
  // Spend is read from the role states: feature has spent past the cap today.
  const states = [{ ...freshRunnerState("feature"), dayStamp: todayStamp(), dayCostUsd: 5 }];
  const healthy = pollBudgetGate(newBudgetGateState(config), { root, states, liveConfig: config, modelsPath });
  assert.equal(healthy.servingResolved.default.pair?.model, "a");
  const failedA = pollBudgetGate(newBudgetGateState(config), {
    root,
    states,
    liveConfig: config,
    modelsPath,
    modelCheckFailed: (pair) => pair === "local/a",
  });
  assert.equal(failedA.servingResolved.default.pair?.model, "b", "the chain steps past the failed pair");
  assert.equal(failedA.gate, "fallback");
});

test("doctor's model check row and over-cap row read the running team's verdicts", () => {
  assert.deepEqual(checkModelChecks(false, null), {
    level: "ok",
    detail: "not checked — a running team checks each model pair before running on it",
  });
  assert.equal(checkModelChecks(true, null).detail, "off for this team (a --once round)");
  const at = new Date(2026, 9, 30, 3, 15, 0).getTime();
  const row = checkModelChecks(true, [
    { pair: "hf/deepseek", status: "verified", seams: ["plan", "review"], checkedAt: at },
    { pair: "omlx/qwen", status: "checking", seams: ["fallback:default"] },
    { pair: "flintrunner/flint", status: "failed", seams: ["feature", "bugfix"], failures: 2, reason: "wrong answer", reply: "the of and", probeAt: at },
  ]);
  assert.equal(row.level, "warn");
  assert.equal(
    row.detail,
    'hf/deepseek — answered 03:15:00; omlx/qwen — checking; flintrunner/flint — failed: replied "the of and" instead of the probe\'s one-word answer; feature, bugfix wait; next check 03:15:00',
  );
  assert.equal(checkModelChecks(true, [{ pair: "hf/deepseek", status: "verified", seams: [] }]).level, "ok");

  // The free fallback's row: the check's verdict replaces "serving not verified".
  const models = writeModelsFile(tmpdir("model-check-doctor-"), JSON.stringify({ providers: { local: { models: [{ id: "free-model", cost: { input: 0, output: 0 } }] } } }));
  const repo = readyRepo();
  writeConfig(repo, { fallbackModel: { provider: "local", model: "free-model" } });
  assert.equal(checkFallbackModel(repo, models).detail, "local/free-model — priced at zero (cost n/a), serving not verified");
  assert.equal(
    checkFallbackModel(repo, models, null, [{ pair: "local/free-model", status: "verified", seams: ["fallback:default"] }]).detail,
    "local/free-model — priced at zero (cost n/a), answered the running team's model check",
  );
  const failed = checkFallbackModel(repo, models, null, [
    { pair: "local/free-model", status: "failed", seams: ["fallback:default"], reason: "no reply", reply: "", detail: "connect ECONNREFUSED", probeAt: at },
  ]);
  assert.equal(failed.level, "warn");
  assert.equal(
    failed.detail,
    "local/free-model is priced at zero but failed the running team's model check — it gave no reply (connect ECONNREFUSED); at the cap roles skip it until it answers (next check 03:15:00)",
  );
});

test("a failed pair raises one red alert naming it and its reply; a checking pair raises none", () => {
  const base = {
    running: true,
    budget: { spentUsd: 1, capUsd: 10, capHitAt: null, free: false, fallback: null },
    budgetPausedRoles: [],
  } as Parameters<typeof teamAlerts>[0];
  assert.deepEqual(teamAlerts({ ...base, modelChecks: [{ pair: "omlx/qwen", status: "checking", seams: ["feature"] }] }, [], [], Date.now()), []);
  const at = new Date(2026, 9, 30, 3, 15, 0).getTime();
  const alerts = teamAlerts(
    {
      ...base,
      modelChecks: [{ pair: "flintrunner/flint", status: "failed", seams: ["feature", "bugfix"], reason: "wrong answer", reply: "the of and", probeAt: at }],
    },
    [],
    [],
    Date.now(),
  );
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0]?.key, alerts[0]?.tone], ["modelcheck", "red"]);
  assert.equal(alerts[0]?.title, "flintrunner/flint failed its model check — runs on it wait");
  assert.equal(
    alerts[0]?.detail,
    'flintrunner/flint (feature, bugfix) replied "the of and" instead of the probe\'s one-word answer; checking again at 03:15:00',
  );
});

test("a role the check holds reads `waiting: model check` in its row", () => {
  const s = { ...freshRunnerState("feature"), nextRunAt: Date.now() - 1000, skipReason: "model-check" as const };
  assert.equal(rolePhase(s, true), "waiting: model check");
});
