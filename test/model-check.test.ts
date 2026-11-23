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
  readModelCheckPairs,
  recheckModelChecks,
  recordModelCheck,
  rekeyModelChecks,
  startModelCheck,
  suspectModelCheck,
  busyModelCheck,
  writeModelCheckPairs,
  type ModelCheckPolicy,
} from "../src/model-check/model-check.js";
import { ModelCheckGate } from "../src/model-check/model-check-gate.js";
import { endedBeforeAnyReply, type PiRunResult } from "../src/pi/pi-run-result.js";
import { defaultConfig } from "../src/config/config.js";
import { configForRole, reviewConfig, seamPairName, type ResolvedModelConfig } from "../src/config/config-views.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { OrchestratorInfo } from "../src/team/team-orchestrator-info-types.js";
import { readOrchestratorInfo, writeOrchestratorInfo } from "../src/team/team-orchestrator-info.js";
import { checkFallbackModel, checkModelChecks } from "../src/doctor/doctor-fallback-checks.js";
import { teamAlerts } from "../src/ui/team-alerts.js";
import { rolePhase } from "../src/ui/status-model.js";
import { gateRoleConfig, pollBudgetGate, newBudgetGateState } from "../src/gates/budget-gates.js";
import { newTeamGateStates, pollTeamGates } from "../src/gates/gate-polls.js";
import { BYTES_PER_GB } from "../src/gates/disk-gates.js";
import { chainFragments } from "../src/ui/badges.js";
import { todayStamp } from "../src/budget/budget.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { modelChecksPath } from "../src/paths.js";
import { readJsonFile, writeJsonFile } from "../src/files/json-files.js";
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

test("recheckModelChecks clears every failed pair's back-off and leaves everything else as it was", () => {
  const verified = { pair: "v/x", status: "verified" as const, failures: 0, probeAt: null, retryMs: 0, probing: false, checkedAt: 1000 };
  const checking = { pair: "c/x", status: "checking" as const, failures: 0, probeAt: 1_000_000, retryMs: 0, probing: false };
  const failedBackedOff = { pair: "f/x", status: "failed" as const, failures: 2, probeAt: 9_000_000, retryMs: 120_000, probing: false, checkedAt: 8_000_000, reason: "wrong answer" as const, reply: "salad" };
  const failedInFlight = { pair: "p/x", status: "failed" as const, failures: 1, probeAt: 9_000_000, retryMs: 60_000, probing: true, checkedAt: 8_000_000, reason: "no reply" as const, reply: "" };
  const map = { "v/x": verified, "c/x": checking, "f/x": failedBackedOff, "p/x": failedInFlight };
  const rechecked = recheckModelChecks(map, 5_000_000);
  // The failed, not-in-flight pair probes on the next poll.
  assert.deepEqual([rechecked["f/x"]?.status, rechecked["f/x"]?.probeAt, rechecked["f/x"]?.failures, rechecked["f/x"]?.retryMs], ["failed", 5_000_000, 2, 120_000], "the failed pair's back-off is cleared; its failure count and retry base are kept");
  assert.deepEqual(dueModelChecks(rechecked, 5_000_000), ["c/x", "f/x"], "the forced pair is due at once");
  // The other three shapes are returned as their own entries, untouched.
  assert.equal(rechecked["v/x"], verified, "a verified pair is unchanged");
  assert.equal(rechecked["c/x"], checking, "a checking pair is unchanged");
  assert.equal(rechecked["p/x"], failedInFlight, "a failed pair whose probe is in flight is unchanged");
  // The input map is not mutated: the failed pair's probeAt is still its old value there.
  assert.equal(map["f/x"]?.probeAt, 9_000_000);
});

test("busyModelCheck defers a silent probe: verified stays verified, checking waits a retryMs, failed is untouched", () => {
  const verified = { pair: "v/x", status: "verified" as const, failures: 0, probeAt: null, retryMs: 0, probing: true, checkedAt: 1_000 };
  const checking = { pair: "c/x", status: "checking" as const, failures: 0, probeAt: 2_000, retryMs: 0, probing: true };
  const failed = { pair: "f/x", status: "failed" as const, failures: 2, probeAt: 9_000_000, retryMs: 120_000, probing: true, checkedAt: 8_000_000, reason: "no reply" as const, reply: "" };
  // A verified pair whose probe went silent over an answering pair: the slot is freed, nothing is
  // scheduled, and checkedAt moves to now — so suspectMinMs is what spaces the next probe.
  const deferred = busyModelCheck({ "v/x": verified }, "v/x", 300_000, POLICY);
  assert.deepEqual(
    [deferred["v/x"]?.status, deferred["v/x"]?.probeAt, deferred["v/x"]?.probing, deferred["v/x"]?.checkedAt, deferred["v/x"]?.failures],
    ["verified", null, false, 300_000, 0],
    "the pair stays verified with no probe scheduled and the check stamped at the deferral",
  );
  assert.deepEqual(dueModelChecks(deferred, 300_000), [], "the deferred probe does not re-fire at once");
  assert.equal(suspectModelCheck(deferred, "v/x", 300_000 + POLICY.suspectMinMs - 1, POLICY)["v/x"]?.probeAt, null, "the deferral re-arms the suspicion rate limit");
  assert.equal(suspectModelCheck(deferred, "v/x", 300_000 + POLICY.suspectMinMs, POLICY)["v/x"]?.probeAt, 300_000 + POLICY.suspectMinMs);
  // A checking pair waits the policy's first retry: a deferred verdict is not a failed probe, so
  // it neither starts nor grows a back-off.
  const deferredChecking = busyModelCheck({ "c/x": checking }, "c/x", 300_000, POLICY);
  assert.deepEqual(
    [deferredChecking["c/x"]?.status, deferredChecking["c/x"]?.probeAt, deferredChecking["c/x"]?.failures, deferredChecking["c/x"]?.retryMs],
    ["checking", 300_000 + POLICY.retryMs, 0, 0],
    "the checking pair stays checking with its next probe exactly one first retry away",
  );
  assert.deepEqual(dueModelChecks(deferredChecking, 300_000 + POLICY.retryMs - 1), [], "not due before that retry");
  assert.deepEqual(dueModelChecks(deferredChecking, 300_000 + POLICY.retryMs), ["c/x"]);
  // A failed pair keeps its own doubled back-off untouched.
  assert.equal(busyModelCheck({ "f/x": failed }, "f/x", 300_000, POLICY)["f/x"], failed, "a failed pair's entry is returned as it was");
});

/** A runner as the gate reads it: id, config, state, the config its next run uses, the
 * in-flight run's unanswered request (`waitingOn`), the hand-backs it took (`handBacks`), and the
 * pair/time a run had a model request answered (`setAnswered`, part 2/2's busy signal). */
function runner(role: string, config: TumwaterConfig, waitingOn: string | null = null) {
  const handBacks: string[] = [];
  let handed = false;
  let answeredPair: string | null = null;
  let answeredAt: number | null = null;
  return Object.assign(
    {
      role,
      config,
      state: freshRunnerState(role),
      runConfig: () => configForRole(config, role),
      unansweredRunPair: () => waitingOn,
      lastAnsweredAt: (pair: string) => (pair === answeredPair ? answeredAt : null),
      handBackRun: (cause: string) => {
        if (handed) return false;
        handed = true;
        handBacks.push(cause);
        return true;
      },
    } as unknown as RoleRunner,
    {
      handBacks,
      setAnswered: (pair: string, at: number): void => {
        answeredPair = pair;
        answeredAt = at;
      },
    },
  );
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

  // Startup: both pairs are probed at once, and every role waits for its own pair's verdict
  // (the reviewer's strong pair is not verified yet, but review is post-merge, so it holds no
  // role — only the post-merge review drain reads it).
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

test("a failed reviewer pair parks only the post-merge review drain, never the roles on verified pairs", async () => {
  const root = makeRepo();
  const config = teamConfig();
  const runners = ["feature", "plan", "director"].map((r) => runner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: runners.map((r) => r.role) };
  writeOrchestratorInfo(root, info);
  let now = 1_000_000;
  const { prober, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = () => gate.poll({ runners, liveConfig: config, roleConfig: config, info });

  // Startup: every pair is still checking, so every role waits on its own pair (the reviewer
  // pair, deepseek, is among them but contributes nothing to the held set — review is
  // post-merge, so it parks only the post-merge review drain).
  poll();
  assert.deepEqual([...poll()].sort(), ["director", "feature", "plan"], "every still-checking role waits on its own pair");

  // flint answers verified, deepseek answers with a failure. feature runs on flint and is
  // released; plan and director run on deepseek and stay held on it. Under the old reviewer
  // hold feature would also be held here (every role but the director while the reviewer's
  // pair is not verified) — it is not now.
  answer("hf/deepseek", { ok: false, reason: "no reply", reply: "", detail: "connect ECONNREFUSED" });
  answer("flintrunner/flint", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll()].sort(), ["director", "plan"], "only the roles on the failed strong pair are held; feature on the verified default pair runs");
  assert.equal(gate.held.has("feature"), false, "a failed reviewer pair no longer holds a role on another verified pair");
  assert.equal(gate.reviewHeld(), true, "the post-merge review drain waits while the reviewer's pair has not answered");

  // deepseek answers verified on its re-check: its roles run again and the drain runs too.
  now += 2 * POLICY.retryMs;
  poll();
  answer("hf/deepseek", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll()], [], "every pair verified: nothing is held");
  assert.equal(gate.reviewHeld(), false);

  // With review off the reviewer pair is absent: a failed strong pair holds only the roles on
  // it (plan and director) and the drain is never held. Its own repo: a gate over the repo above
  // would seed from the verdict store that team wrote (model-check.ts readModelCheckStore) and
  // probe nothing, which is the restart test's ground, not this one's.
  const rootOff = makeRepo();
  const off = { ...config, review: { ...config.review, enabled: false } };
  const runnersOff = ["feature", "plan", "director"].map((r) => runner(r, off));
  const infoOff: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: runnersOff.map((r) => r.role) };
  const probersOff = manualProber();
  const gateOff = new ModelCheckGate(rootOff, probersOff.prober, new AbortController().signal, POLICY, () => now);
  const pollOff = () => gateOff.poll({ runners: runnersOff, liveConfig: off, roleConfig: off, info: infoOff });
  pollOff();
  probersOff.answer("flintrunner/flint", { ok: true });
  probersOff.answer("hf/deepseek", { ok: false, reason: "no reply", reply: "", detail: "connect ECONNREFUSED" });
  await gateOff.settled();
  assert.deepEqual([...pollOff()].sort(), ["director", "plan"], "review off: a failed strong pair holds only the roles on it");
  assert.equal(gateOff.reviewHeld(), false, "review off: there is no reviewer pair, so the drain is never held");
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

test("the gate re-checks now: a re-check request re-probes a failed pair before its back-off comes due", async () => {
  const root = makeRepo();
  const config = teamConfig();
  const runners = ["feature", "plan"].map((r) => runner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 8_000_000;
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = () => gate.poll({ runners, liveConfig: config, roleConfig: config, info });
  poll();
  answer("hf/deepseek", { ok: true });
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "" });
  await gate.settled();
  assert.equal(asked.length, 2);
  // The failed default pair is now on its back-off: its probeAt is in the future, so the next
  // poll before that instant re-probes nothing.
  now += 1000;
  poll();
  assert.equal(asked.length, 2, "the failed pair waits out its back-off");
  // The operator asks for a re-check: the next poll probes the failed pair immediately, even
  // though the clock has not reached its old probeAt.
  gate.recheckNow();
  poll();
  assert.deepEqual(asked.slice(2), ["flintrunner/flint"], "the failed pair re-probes on the next poll");
  // The forced probe fails again: the back-off continues (doubles) rather than restarting.
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "" });
  await gate.settled();
  assert.equal(gate.checks["flintrunner/flint"]?.retryMs, 2 * POLICY.retryMs, "the back-off doubles on the second failure");
  // Requested again after that failure, the pair probes once more — and once it answers the
  // roles run again.
  gate.recheckNow();
  poll();
  assert.deepEqual(asked.slice(3), ["flintrunner/flint"], "a failed pair probes again on request");
  answer("flintrunner/flint", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll()], [], "the role runs again once the pair answers");
});

test("a probe that stays silent while the pair answers the team's own runs defers instead of failing (busy 2/2)", async () => {
  const root = makeRepo();
  const config = teamConfig();
  const feature = runner("feature", config);
  const runners = [feature, runner("plan", config)];
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 9_000_000;
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = () => gate.poll({ runners, liveConfig: config, roleConfig: config, info });
  poll();
  answer("flintrunner/flint", { ok: true });
  answer("hf/deepseek", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll()], []);

  // The pair is suspected (a run ended the way a serving fault does) and probed. While that probe
  // waits, feature's own run on flintrunner/flint has a model request answered at a later clock
  // time — the server is serving the team, it is just queueing the probe.
  now += POLICY.suspectMinMs;
  feature.setAnswered("flintrunner/flint", now + 1_000);
  gate.suspect("flintrunner/flint");
  poll();
  assert.deepEqual(asked.slice(2), ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
  await gate.settled();

  // Nothing failed: the pair stays verified, the role runs, no warning is logged, and the next
  // poll at the same clock starts no probe.
  const flint = gate.checks["flintrunner/flint"]!;
  assert.equal(flint.status, "verified", "a busy pair is not failed");
  assert.equal(flint.failures, 0, "a deferred probe is not a failure");
  assert.deepEqual([...poll()], [], "the role is not held and no probe re-fires at the same clock");
  assert.deepEqual([...gate.held], []);
  assert.deepEqual(warningEvents(readEvents(root)).map((e) => String(e.message)), [], "deferring logs no warning");
  assert.deepEqual(eventsOfType(root, "model_check_busy").map((e) => e.pair), ["flintrunner/flint"], "one informational event names the pair");
  assert.equal(eventsOfType(root, "model_check_passed").length, 0, "a deferred probe is not a pass either");

  // The discriminator: an answer that predates the probe is no evidence of life — a silent probe
  // then fails the pair and holds the role, as before.
  now += POLICY.suspectMinMs * 2;
  feature.setAnswered("flintrunner/flint", now - 1_000);
  gate.suspect("flintrunner/flint");
  poll();
  assert.deepEqual(asked.slice(3), ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
  await gate.settled();
  assert.equal(gate.checks["flintrunner/flint"]?.status, "failed", "an answer before the probe started fails the pair as today");
  assert.deepEqual([...poll()], ["feature"], "the role is held on it");
  assert.equal(warningEvents(readEvents(root)).length, 1, "and the failure warns once");

  // A wrong answer is a fault whatever the pair was doing for the team: it fails the pair.
  now += POLICY.retryMs;
  feature.setAnswered("flintrunner/flint", now + 1_000);
  gate.recheckNow();
  poll();
  assert.deepEqual(asked.slice(4), ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: false, reason: "wrong answer", reply: "salad" });
  await gate.settled();
  assert.equal(gate.checks["flintrunner/flint"]?.status, "failed", "a wrong answer fails the pair even while it answers the team");
  // A pair already failed keeps its own doubled back-off, and the busy signal does not defer it:
  // the answer lands after this probe starts, yet the silent probe still fails again and doubles.
  const retryBefore = gate.checks["flintrunner/flint"]?.retryMs;
  now += POLICY.retryMs * 2;
  feature.setAnswered("flintrunner/flint", now + 1_000);
  gate.recheckNow();
  poll();
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "" });
  await gate.settled();
  assert.equal(gate.checks["flintrunner/flint"]?.retryMs, 2 * retryBefore, "the failed pair's back-off doubles as today");
  assert.equal(eventsOfType(root, "model_check_busy").length, 1, "a failed pair's silent probe defers nothing");
});

test("a run waiting on an unanswered request re-checks its pair at the suspicion rate and is handed back once it fails", async () => {
  const root = makeRepo();
  const config = teamConfig();
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 7_000_000;
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const hung = runner("feature", config, "flintrunner/flint");
  const busy = runner("plan", config); // its requests are answered
  const poll = () => gate.poll({ runners: [hung, busy], liveConfig: config, roleConfig: config, info });
  poll();
  answer("flintrunner/flint", { ok: true });
  answer("hf/deepseek", { ok: true });
  await gate.settled();

  // Within suspectMinMs of the pair's last check the wait is noted but probes nothing; past it,
  // one probe, and no second while it is in flight.
  poll();
  assert.equal(asked.length, 2);
  now += POLICY.suspectMinMs;
  poll();
  poll();
  assert.deepEqual(asked.slice(2), ["flintrunner/flint"]);

  // The probe passes (the hang is not the probe's): the run keeps waiting, untouched, and is
  // looked at again a suspicion interval later.
  answer("flintrunner/flint", { ok: true });
  await gate.settled();
  assert.deepEqual([...poll()], []);
  assert.deepEqual(hung.handBacks, []);
  now += POLICY.suspectMinMs;
  poll();
  assert.deepEqual(asked.slice(3), ["flintrunner/flint"]);

  // This time it fails: the waiting run is handed back once, with a warning naming it; a run on
  // a pair that still answers is left alone.
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
  await gate.settled();
  poll();
  poll();
  assert.deepEqual(hung.handBacks, ["model-check"]);
  assert.deepEqual(busy.handBacks, []);
  const handedBack = warningEvents(readEvents(root)).filter((e) => String(e.message).startsWith("run handed back"));
  assert.deepEqual(handedBack.map((e) => e.source), ["feature"]);
  // The reviewer's hf/deepseek answers, but the default tier has no other pair: the run waits
  // for flint itself.
  assert.match(String(handedBack[0]?.message), / — the run resumes on this pair once it answers again$/);
});

test("a handed-back run is promised another pair only when its own tier's fallback answers", async () => {
  const root = makeRepo();
  const config = teamConfig();
  config.fallback = { default: "omlx/qwen" };
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 7_000_000;
  const { prober, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const hung = runner("feature", config, "flintrunner/flint");
  const poll = () => gate.poll({ runners: [hung], liveConfig: config, roleConfig: config, info });
  poll();
  for (const pair of ["flintrunner/flint", "hf/deepseek", "omlx/qwen"]) answer(pair, { ok: true });
  await gate.settled();
  now += POLICY.suspectMinMs;
  poll();
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
  await gate.settled();
  poll();
  assert.deepEqual(hung.handBacks, ["model-check"]);
  const handedBack = warningEvents(readEvents(root)).filter((e) => String(e.message).startsWith("run handed back"));
  assert.equal(handedBack.length, 1);
  assert.match(String(handedBack[0]?.message), / — the run resumes on a pair that answers$/);
});

test("a handed-back run is promised another pair when its tier borrows another tier's answering fallback", async () => {
  const root = makeRepo();
  const config = teamConfig();
  // Only strong declares a fallback; the default tier borrows it (default → strong → small).
  config.fallback = { strong: "omlx/qwen" };
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 7_000_000;
  const { prober, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const hung = runner("feature", config, "flintrunner/flint");
  const poll = () => gate.poll({ runners: [hung], liveConfig: config, roleConfig: config, info });
  poll();
  for (const pair of ["flintrunner/flint", "hf/deepseek", "omlx/qwen"]) answer(pair, { ok: true });
  await gate.settled();
  now += POLICY.suspectMinMs;
  poll();
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
  await gate.settled();
  poll();
  assert.deepEqual(hung.handBacks, ["model-check"]);
  const handedBack = warningEvents(readEvents(root)).filter((e) => String(e.message).startsWith("run handed back"));
  assert.equal(handedBack.length, 1);
  assert.match(String(handedBack[0]?.message), / — the run resumes on a pair that answers$/);
});

test("a handed-back run is not promised another pair when the only answering fallback is a chain its tier never borrows", async () => {
  const root = makeRepo();
  const config = teamConfig();
  // Only small declares a fallback, and strong never borrows it
  // (BORROW_ORDER.strong = strong → default).
  config.fallback = { small: "omlx/qwen" };
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  let now = 7_000_000;
  const { prober, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const hung = runner("plan", config, "hf/deepseek"); // plan sits at the strong tier
  const poll = () => gate.poll({ runners: [hung], liveConfig: config, roleConfig: config, info });
  poll();
  for (const pair of ["hf/deepseek", "omlx/qwen"]) answer(pair, { ok: true });
  await gate.settled();
  now += POLICY.suspectMinMs;
  poll();
  answer("hf/deepseek", { ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
  await gate.settled();
  poll();
  assert.deepEqual(hung.handBacks, ["model-check"]);
  const handedBack = warningEvents(readEvents(root)).filter((e) => String(e.message).startsWith("run handed back"));
  assert.equal(handedBack.length, 1);
  assert.match(String(handedBack[0]?.message), / — the run resumes on this pair once it answers again$/);
});

test("endedBeforeAnyReply: a failure with no reply counts; a reply, a 429, a refused request, a cap or an abort does not", () => {
  const failed = { ok: false, producedAssistantContent: false, contextExceeded: false, transientRateLimit: false };
  assert.equal(endedBeforeAnyReply(result({ ...failed, errorMessage: "connect ECONNREFUSED" })), true);
  assert.equal(endedBeforeAnyReply(result({ ...failed, quietKilled: true })), true, "no reply before the quiet kill");
  assert.equal(endedBeforeAnyReply(result({ ...failed, timedOut: true })), true, "no reply before the deadline");
  assert.equal(endedBeforeAnyReply(result({ ...failed, ok: true })), false, "a run that finished");
  assert.equal(endedBeforeAnyReply(result({ ...failed, producedAssistantContent: true })), false, "the model replied");
  assert.equal(endedBeforeAnyReply(result({ ...failed, aborted: true })), false, "tumwater stopped it");
  assert.equal(endedBeforeAnyReply(result({ ...failed, transientRateLimit: true })), false, "a 429 is an answer");
  assert.equal(endedBeforeAnyReply(result({ ...failed, contextExceeded: true })), false, "the request was refused");
  assert.equal(endedBeforeAnyReply(result({ ...failed, resumeMissing: true })), false, "the session was gone");
  assert.equal(endedBeforeAnyReply(result({ ...failed, budgetCapped: true })), false, "its own cap ended it");
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

/** A runner as the budget wiring reads and writes it, whose next run follows the config the
 * wiring assigned. */
function wiredRunner(role: string, config: TumwaterConfig): RoleRunner {
  const r = {
    role,
    config,
    budgetFallbackActive: false,
    state: freshRunnerState(role),
    runConfig: () => configForRole(r.config, role),
    runProvider: () => undefined,
    runModelPair: () => null,
    unansweredRunPair: () => null,
    handBackRun: () => false,
  };
  return r as unknown as RoleRunner;
}

/** The pair a runner's next run lands on. */
const runPair = (r: RoleRunner): string => `${r.runConfig().provider}/${r.runConfig().model}`;

test("below the cap, a tier whose primary failed runs on its verified fallback, and moves back once the primary answers", () => {
  const root = tmpdir("model-check-move-");
  const modelsPath = writeModelsFile(root, JSON.stringify({ providers: {} }));
  const config = teamConfig();
  config.fallback = { default: "omlx/qwen" };
  const runners = ["feature", "plan"].map((r) => wiredRunner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: 0, roles: ["feature", "plan"] };
  const verdicts: Record<string, "verified" | "failed"> = { "hf/deepseek": "verified", "flintrunner/flint": "failed" };
  const states = newTeamGateStates(config);
  const poll = () =>
    pollTeamGates(states, {
      root,
      runners,
      liveConfig: config,
      modelsPath,
      now: Date.now(),
      info,
      sampleFree: () => 100 * BYTES_PER_GB,
      modelCheckFailed: (pair) => verdicts[pair] === "failed",
      modelCheckVerified: (pair) => verdicts[pair] === "verified",
    });
  const switched = () => eventsOfType(root, "fallback_switched").map((e) => e.tiers);

  // The fallback has not answered yet: nothing moves, the default tier stays held on flint.
  let gates = poll();
  assert.equal(gates.roleConfig, config);
  assert.deepEqual([...gates.checkMoved], []);
  assert.equal(runPair(runners[0]!), "flintrunner/flint");
  assert.deepEqual(switched(), []);

  // It answers: default (and small, which inherits default's model) move to it; strong keeps
  // its primary, and so do the reviewer and the strong-tier role.
  verdicts["omlx/qwen"] = "verified";
  gates = poll();
  assert.deepEqual([...gates.checkMoved], ["small", "default"]);
  assert.equal(gates.gate, "open");
  assert.deepEqual(runners.map(runPair), ["omlx/qwen", "hf/deepseek"]);
  assert.equal(seamPairName(reviewConfig(gates.roleConfig)), "hf/deepseek");
  assert.ok(runners.every((r) => !r.budgetFallbackActive), "the image-reroute regime stays the cap's");
  const moved = { pair: "omlx/qwen", step: 1, of: 1, reason: "model-check" };
  assert.deepEqual(info.chain, { small: moved, default: moved });
  assert.equal(chainFragments(info.chain), "small → omlx/qwen (model check) · default → omlx/qwen (model check)");
  const to = { from: null, to: "omlx/qwen", reason: "model-check" };
  assert.deepEqual(switched(), [{ small: to, default: to }]);
  poll();
  assert.equal(switched().length, 1, "an unchanged move logs nothing more");

  // flint answers a re-check: both tiers move back, and the chain empties.
  verdicts["flintrunner/flint"] = "verified";
  gates = poll();
  assert.equal(gates.roleConfig, config);
  assert.deepEqual([...gates.checkMoved], []);
  assert.deepEqual(runners.map(runPair), ["flintrunner/flint", "hf/deepseek"]);
  assert.equal(info.chain, undefined);
  const back = { from: "omlx/qwen", to: null, reason: "available" };
  assert.deepEqual(switched()[1], { small: back, default: back });
});

test("the model check keeps probing a moved tier's primary, so the tier moves back when it answers", async () => {
  const root = makeRepo();
  const modelsPath = writeModelsFile(tmpdir("model-check-loop-"), JSON.stringify({ providers: {} }));
  const config = teamConfig();
  config.fallback = { default: "omlx/qwen" };
  const runners = ["feature", "plan"].map((r) => wiredRunner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: ["feature", "plan"] };
  let now = 2_000_000;
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const budget = newBudgetGateState(config);
  // One orchestrator poll: the budget gate assigns each runner its config, then the check polls.
  const cycle = () => {
    const view = pollBudgetGate(budget, {
      root,
      states: runners.map((r) => r.state),
      liveConfig: config,
      modelsPath,
      modelCheckFailed: (pair) => gate.failed(pair),
      modelCheckVerified: (pair) => gate.verified(pair),
    });
    for (const r of runners) r.config = gateRoleConfig(r.role, config, view.roleConfig);
    return gate.poll({ runners, liveConfig: config, roleConfig: view.roleConfig, checkMoved: view.checkMoved, info });
  };

  cycle();
  answer("hf/deepseek", { ok: true });
  answer("omlx/qwen", { ok: true });
  answer("flintrunner/flint", { ok: false, reason: "wrong answer", reply: "salad" });
  await gate.settled();
  // The poll after the verdicts moves feature to qwen, so nothing waits; flint stays checked
  // under its tier's primary label, failed and on its back-off.
  assert.deepEqual([...cycle()], []);
  assert.equal(runPair(runners[0]!), "omlx/qwen");
  const flint = readOrchestratorInfo(root)?.modelChecks?.find((c) => c.pair === "flintrunner/flint");
  assert.deepEqual([flint?.status, flint?.seams], ["failed", ["primary:small", "primary:default"]]);
  assert.deepEqual([...cycle()], [], "the next poll keeps the move (flint is not forgotten and re-checked)");
  assert.equal(asked.length, 3);

  // The back-off elapses: flint is probed again, answers, and the next poll moves feature back.
  now += POLICY.retryMs;
  cycle();
  assert.deepEqual(asked.slice(3), ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: true });
  await gate.settled();
  assert.deepEqual([...cycle()], []);
  assert.equal(runPair(runners[0]!), "flintrunner/flint");
  assert.deepEqual(eventsOfType(root, "model_check_passed").map((e) => e.pair), ["flintrunner/flint"]);
});

test("a check move keeps a role pinned to its own pair, also a bare id under the legacy provider", () => {
  const root = makeRepo();
  const modelsPath = writeModelsFile(tmpdir("model-check-pin-"), JSON.stringify({ providers: {} }));
  const config = defaultConfig();
  config.provider = "flintrunner";
  config.model = "flint";
  config.fallback = "omlx/qwen";
  config.roles = { ...config.roles, docs: { enabled: true, model: "other" } };
  const p = pollBudgetGate(newBudgetGateState(config), {
    root,
    states: [],
    liveConfig: config,
    modelsPath,
    modelCheckFailed: (pair) => pair === "flintrunner/flint",
    modelCheckVerified: (pair) => pair === "omlx/qwen",
  });
  assert.deepEqual([...p.checkMoved], ["small", "default", "strong"]);
  assert.equal(seamPairName(configForRole(p.roleConfig, "feature")), "omlx/qwen");
  assert.equal(seamPairName(configForRole(p.roleConfig, "docs")), "flintrunner/other", "the pin keeps its provider");
});

test("at the cap, a free primary that failed moves to a verified free step past a priced one", () => {
  const root = makeRepo();
  const free = { input: 0, output: 0 };
  const modelsPath = writeModelsFile(
    tmpdir("model-check-cap-"),
    JSON.stringify({
      providers: {
        flintrunner: { models: [{ id: "flint", cost: free }] },
        omlx: { models: [{ id: "qwen", cost: free }] },
        paid: { models: [{ id: "x", cost: { input: 1, output: 1 } }] },
      },
    }),
  );
  const config = teamConfig();
  config.maxDailyCostUsd = 0.000001;
  config.fallback = { default: ["paid/x", "omlx/qwen"] };
  const states = [{ ...freshRunnerState("feature"), dayStamp: todayStamp(), dayCostUsd: 5 }];
  const verified = new Set(["omlx/qwen", "paid/x", "hf/deepseek"]);
  const p = pollBudgetGate(newBudgetGateState(config), {
    root,
    states,
    liveConfig: config,
    modelsPath,
    modelCheckFailed: (pair) => pair === "flintrunner/flint",
    modelCheckVerified: (pair) => verified.has(pair),
  });
  assert.equal(p.onFallback, true);
  assert.deepEqual([...p.checkMoved], ["small", "default"], "strong's priced primary is the cap's to move");
  assert.equal(seamPairName(configForRole(p.roleConfig, "feature")), "omlx/qwen");
  // The step before qwen is priced, so the cap — not the check — is why default skips it.
  assert.deepEqual(p.chain.default, { pair: "omlx/qwen", step: 2, of: 2, reason: "cap", returnsAt: p.chain.default?.returnsAt });
  assert.equal(p.chain.strong?.pair, "omlx/qwen");

  // Without a verified free step the failed primary keeps its tier: held, not moved.
  verified.delete("omlx/qwen");
  const held = pollBudgetGate(newBudgetGateState(config), {
    root,
    states,
    liveConfig: config,
    modelsPath,
    modelCheckFailed: (pair) => pair === "flintrunner/flint",
    modelCheckVerified: (pair) => verified.has(pair),
  });
  assert.deepEqual([...held.checkMoved], []);
  assert.equal(seamPairName(configForRole(held.roleConfig, "feature")), "flintrunner/flint");
});

test("at the cap, a cap-moved tier steps past a free fallback step that failed its check", () => {
  const root = makeRepo();
  const free = { input: 0, output: 0 };
  const modelsPath = writeModelsFile(
    tmpdir("model-check-cap-step-"),
    JSON.stringify({
      providers: {
        paid: { models: [{ id: "x", cost: { input: 1, output: 1 } }] },
        local: { models: [{ id: "a", cost: free }, { id: "b", cost: free }] },
      },
    }),
  );
  const config = teamConfig();
  config.model = { default: "paid/x", strong: "hf/deepseek" };
  config.maxDailyCostUsd = 0.000001;
  config.fallback = { default: ["local/a", "local/b"] };
  const states = [{ ...freshRunnerState("feature"), dayStamp: todayStamp(), dayCostUsd: 5 }];
  const state = newBudgetGateState(config);
  const p = pollBudgetGate(state, {
    root,
    states,
    liveConfig: config,
    modelsPath,
    modelCheckFailed: (pair) => pair === "local/a",
  });
  // The chain and the installed view step past the failed step together: the roles run on
  // local/b, not wait on local/a.
  assert.equal(p.onFallback, true);
  assert.equal(p.chain.default?.pair, "local/b");
  assert.equal(p.chain.default?.reason, "model-check");
  assert.equal(seamPairName(configForRole(p.roleConfig, "feature")), "local/b");

  // The failure clears: the next poll re-installs local/a on the same state.
  const p2 = pollBudgetGate(state, {
    root,
    states,
    liveConfig: config,
    modelsPath,
    modelCheckFailed: () => false,
  });
  assert.equal(seamPairName(configForRole(p2.roleConfig, "feature")), "local/a");
});

test("at the cap, a tier keeps a free failed step installed when every free step failed its check", () => {
  const root = makeRepo();
  const free = { input: 0, output: 0 };
  const modelsPath = writeModelsFile(
    tmpdir("model-check-cap-all-failed-"),
    JSON.stringify({
      providers: {
        paid: { models: [{ id: "x", cost: { input: 1, output: 1 } }] },
        local: { models: [{ id: "a", cost: free }, { id: "b", cost: free }] },
      },
    }),
  );
  const config = teamConfig();
  config.model = { default: "paid/x", strong: "hf/deepseek" };
  config.maxDailyCostUsd = 0.000001;
  config.fallback = { default: ["local/a", "local/b"] };
  const states = [{ ...freshRunnerState("feature"), dayStamp: todayStamp(), dayCostUsd: 5 }];
  const p = pollBudgetGate(newBudgetGateState(config), {
    root,
    states,
    liveConfig: config,
    modelsPath,
    modelCheckFailed: (pair) => pair === "local/a" || pair === "local/b",
  });
  // The serving resolution pauses the tier, but the installed view keeps a free step: a parked
  // merge must not fall through to the priced primary the cap already spent.
  assert.equal(p.gate, "paused");
  assert.equal(seamPairName(configForRole(p.roleConfig, "feature")), "local/a");
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
  assert.deepEqual(alerts[0]?.actions, [{ label: "Re-check now", act: "model-check" }]);
});

test("a role the check holds reads `waiting: model check` in its row", () => {
  const s = { ...freshRunnerState("feature"), nextRunAt: Date.now() - 1000, skipReason: "model-check" as const };
  assert.equal(rolePhase(s, true), "waiting: model check");
});

/** The persisted verdict store (.tumwater/state/model-checks.json, src/paths.ts
 * modelChecksPath) as the test leaves it: `savedAt` plus the pairs exactly as given. */
function writeStore(root: string, savedAt: number | undefined, pairs: Record<string, unknown>): void {
  writeJsonFile(modelChecksPath(root), { ...(savedAt === undefined ? {} : { savedAt }), pairs });
}

/** One `verified` entry as the store holds it: nothing scheduled, suspicion is what re-probes. */
function verifiedEntry(pair: string, checkedAt: number): Record<string, unknown> {
  return { pair, status: "verified", failures: 0, probeAt: null, retryMs: 0, probing: false, checkedAt };
}

test("a restart over the persisted store keeps a failed pair's verdict and its earned back-off", async () => {
  const root = makeRepo();
  const config = teamConfig();
  const runners = ["feature", "plan", "director"].map((r) => runner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: runners.map((r) => r.role) };
  writeOrchestratorInfo(root, info);
  let now = 20_000_000;
  // The store a previous process left, written a minute ago: the default pair has failed three
  // times and is owed a 3x wait; the strong pair answered.
  writeStore(root, now - 60_000, {
    "flintrunner/flint": {
      pair: "flintrunner/flint", status: "failed", failures: 3, probeAt: now + POLICY.retryMs,
      retryMs: 3 * POLICY.retryMs, probing: false, checkedAt: now - 60_000, reason: "no reply", reply: "",
    },
    "hf/deepseek": verifiedEntry("hf/deepseek", now - 60_000),
  });
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = () => gate.poll({ runners, liveConfig: config, roleConfig: config, info });

  // The first poll of the restarted process: the failed pair's role is held with no probe at all,
  // because the recorded back-off is still running, and its counts survived the restart.
  assert.deepEqual([...poll()], ["feature"], "the failed pair's role stays held across the restart");
  assert.deepEqual(asked, [], "no probe while the recorded back-off still runs");
  assert.deepEqual(
    [gate.checks["flintrunner/flint"]?.failures, gate.checks["flintrunner/flint"]?.retryMs],
    [3, 3 * POLICY.retryMs],
    "the failure count and the earned back-off came off disk",
  );
  const published = readOrchestratorInfo(root)?.modelChecks ?? [];
  assert.equal(published.find((c) => c.pair === "flintrunner/flint")?.savedAt, now - 60_000, "the row carries the store's stamp");

  // Due on the recorded instant: one probe, and its failure is the fourth — the doubling continues
  // from the stored retryMs rather than restarting at the policy's first wait.
  now += POLICY.retryMs;
  poll();
  assert.deepEqual(asked, ["flintrunner/flint"]);
  answer("flintrunner/flint", { ok: false, reason: "no reply", reply: "", detail: "connect ECONNREFUSED" });
  await gate.settled();
  poll();
  assert.equal(gate.checks["flintrunner/flint"]?.retryMs, POLICY.maxRetryMs, "the back-off doubles from the stored 3x, capped");
  assert.deepEqual([...poll()], ["feature"]);

  // A second restart over the file that poll wrote: the fourth failure is there and still held.
  const prober2 = manualProber();
  const gate2 = new ModelCheckGate(root, prober2.prober, new AbortController().signal, POLICY, () => now);
  const poll2 = () => gate2.poll({ runners, liveConfig: config, roleConfig: config, info });
  assert.deepEqual([...poll2()], ["feature"]);
  assert.deepEqual(prober2.asked, [], "the second restart does not re-probe the back-off it just read");
  assert.equal(gate2.checks["flintrunner/flint"]?.failures, 4, "the failures counted in the previous process carried over");

  // And the store keeps a recovery: once the pair answers, that is what a reader reports.
  now += POLICY.maxRetryMs;
  poll2();
  assert.deepEqual(prober2.asked, ["flintrunner/flint"]);
  prober2.answer("flintrunner/flint", { ok: true });
  await gate2.settled();
  poll2();
  assert.equal(readModelCheckPairs(root)["flintrunner/flint"]?.status, "verified");
  const prober3 = manualProber();
  const gate3 = new ModelCheckGate(root, prober3.prober, new AbortController().signal, POLICY, () => now);
  assert.deepEqual([...gate3.poll({ runners, liveConfig: config, roleConfig: config, info })], []);
  assert.deepEqual(prober3.asked, [], "the third restart runs the roles at once on the stored verdict");

  // The store is not an observer source: the doctor reads the info block only, so a host with a
  // store file and no running team still reports the not-checked row.
  assert.deepEqual(checkModelChecks(false, null), {
    level: "ok",
    detail: "not checked — a running team checks each model pair before running on it",
  });
});

test("a store whose entry is corrupt is re-probed on the first poll, not held forever", async () => {
  const root = makeRepo();
  const config = teamConfig();
  config.model = { default: "local/flint", strong: "local/flint" }; // one pair for every seam
  const runners = ["feature"].map((r) => runner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: ["feature"] };
  writeOrchestratorInfo(root, info);
  let now = 30_000_000;
  // A hand-edited entry: an unknown status, a string back-off, and no scheduled probe — the
  // worst shape a failed pair could have, since no scheduled probe means nothing would re-check.
  writeStore(root, now - 60_000, { "local/flint": { status: "nope", retryMs: "x", probeAt: null } });
  const { prober, asked, answer } = manualProber();
  const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
  const poll = () => gate.poll({ runners, liveConfig: config, roleConfig: config, info });
  assert.deepEqual([...poll()], ["feature"]);
  assert.deepEqual(asked, ["local/flint"], "the corrupt entry's pair is probed at once");
  answer("local/flint", { ok: false, reason: "no reply", reply: "" });
  await gate.settled();
  poll();
  const body = readJsonFile<{ pairs: Record<string, { retryMs?: unknown; status?: unknown }>; savedAt?: unknown }>(
    modelChecksPath(root),
  );
  assert.equal(body?.pairs["local/flint"]?.status, "failed");
  assert.ok(
    typeof body?.pairs["local/flint"]?.retryMs === "number" && body.pairs["local/flint"]!.retryMs! >= POLICY.retryMs,
    `the rewritten retryMs is a finite number at least the first wait, got ${JSON.stringify(body?.pairs["local/flint"]?.retryMs)}`,
  );
});

test("a stale store re-probes every pair, a fresh one keeps verdicts and a far-off back-off", () => {
  const root = makeRepo();
  const config = teamConfig();
  const runners = ["feature", "plan", "director"].map((r) => runner(r, config));
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: [] };
  const now = 40_000_000;
  const pollOnce = (savedAt: number, flint: Record<string, unknown>): { asked: string[]; held: readonly string[]; gate: ModelCheckGate } => {
    writeStore(root, savedAt, { "flintrunner/flint": flint, "hf/deepseek": verifiedEntry("hf/deepseek", savedAt) });
    const { prober, asked } = manualProber();
    const gate = new ModelCheckGate(root, prober, new AbortController().signal, POLICY, () => now);
    const held = gate.poll({ runners, liveConfig: config, roleConfig: config, info });
    return { asked, held: [...held], gate };
  };
  const stale = now - POLICY.suspectMinMs - 1;
  const fresh = now - 60_000;
  // A verdict older than the suspicion interval is re-tested, not trusted: the stale store's
  // verified pair is probed on the first poll instead of letting its roles run on it.
  assert.deepEqual(
    pollOnce(stale, verifiedEntry("flintrunner/flint", stale)).asked.sort(),
    ["flintrunner/flint", "hf/deepseek"],
    "every pair of a stale store is probed on the first poll",
  );
  // A store with no stamp at all is treated the same way: it cannot be dated, so it is not trusted.
  writeStore(root, undefined, { "flintrunner/flint": verifiedEntry("flintrunner/flint", now) });
  const unstamp = manualProber();
  const gateUnstamp = new ModelCheckGate(root, unstamp.prober, new AbortController().signal, POLICY, () => now);
  gateUnstamp.poll({ runners, liveConfig: config, roleConfig: config, info });
  assert.deepEqual(unstamp.asked.sort(), ["flintrunner/flint", "hf/deepseek"], "an undated store is re-probed");
  // The same store one minute old starts no probe and holds nothing.
  const kept = pollOnce(fresh, verifiedEntry("flintrunner/flint", fresh));
  assert.deepEqual(kept.asked, [], "a fresh store's verdicts are kept");
  assert.deepEqual(kept.held, []);
  // A failed pair a day from its next probe stays held when the store is fresh...
  const far = fresh + 24 * 60 * 60_000;
  const heldPair = {
    pair: "flintrunner/flint", status: "failed", failures: 5, probeAt: far, retryMs: POLICY.maxRetryMs,
    probing: false, checkedAt: fresh, reason: "no reply", reply: "",
  };
  const waited = pollOnce(fresh, heldPair);
  assert.deepEqual(waited.asked, [], "the recorded back-off is respected, not restarted");
  assert.deepEqual(waited.held, ["feature"]);
  // ...and is re-probed at once when the store is stale, keeping its failure count.
  const reopened = pollOnce(stale, heldPair);
  assert.deepEqual(reopened.asked, ["flintrunner/flint", "hf/deepseek"]);
  assert.deepEqual(
    [reopened.gate.checks["flintrunner/flint"]?.failures, reopened.gate.checks["flintrunner/flint"]?.probeAt],
    [5, now],
    "the stale sweep re-arms the probe without losing the history",
  );
});

test("the persisted store never keeps a pair whose probe was in flight", () => {
  const root = tmpdir("model-check-store-");
  const map = {
    "a/one": { pair: "a/one", status: "failed" as const, failures: 1, probeAt: 500, retryMs: POLICY.retryMs, probing: false },
    "a/two": { pair: "a/two", status: "checking" as const, failures: 0, probeAt: 500, retryMs: 0, probing: true },
  };
  writeModelCheckPairs(root, map, 12_345);
  assert.deepEqual(Object.keys(readModelCheckPairs(root)), ["a/one"], "an in-flight probe dies with the process");
  const body = readJsonFile<{ savedAt?: unknown }>(modelChecksPath(root));
  assert.equal(body?.savedAt, 12_345, "the writer stamps the time it wrote");
  // A store with no stamp at all reads as "not fresh", which is what makes the gate re-probe.
  writeJsonFile(modelChecksPath(root), { pairs: { "a/one": map["a/one"] } });
  assert.deepEqual(Object.keys(readModelCheckPairs(root)), ["a/one"]);
});
