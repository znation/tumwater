// The model check's unanswered-request trigger (plans/model-check.md "In-flight runs"): a run
// whose model request goes unanswered is evidence about its pair, the shape of the 2026-10-29
// deepinfra hang (HTTP 200, then only SSE pings, for hours). A real runner runs a fake pi that
// sends one request and never hears back; on the logical watchdog clock the request passes
// toolCallStallSeconds, the model check re-checks the pair, and once the pair fails the run is
// handed back resumably and resumes on the model-check bridge.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { ModelCheckGate } from "../src/model-check/model-check-gate.js";
import type { ModelCheckVerdict } from "../src/model-check/model-check-probe.js";
import type { ResolvedModelConfig } from "../src/config/config-views.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { piLogPath } from "../src/paths.js";
import type { OrchestratorInfo } from "../src/team/team-orchestrator-info.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { initializedRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { assistantLine, errorLine } from "./fixtures/pi-events.js";
import { fakePi, TOUCH_SESSION, withPi } from "./fakes/fake-pi.js";
import { waitForLogLines, watchdogClock } from "./helpers/wait.js";

/** pi's line for a model request going out on local/flint. */
const REQUEST_START = JSON.stringify({
  type: "message_start",
  message: { role: "assistant", content: [], provider: "local", model: "flint", stopReason: "pending" },
});

/** A team of one `clean` role on local/flint, with a 2 s stall threshold and a quiet window long
 * enough that only the hand-back can end the hung run. */
function flintConfig() {
  const config = defaultConfig();
  config.provider = "local";
  config.model = "flint";
  config.toolCallStallSeconds = 2;
  config.quietTimeoutSeconds = 600;
  for (const [id, role] of Object.entries(config.roles)) role.enabled = id === "clean";
  return config;
}

test("a request left unanswered past the stall threshold re-checks its pair, and a failed pair hands the run back", async (t) => {
  const repo = await initializedRepo();
  const prompts = path.join(tmpdir(), "prompts.log");
  const config = flintConfig();
  const info: OrchestratorInfo = { pid: process.pid, startedAt: Date.now(), roles: ["clean"] };
  const asked: string[] = [];
  const answers: ((v: ModelCheckVerdict) => void)[] = [];
  const prober = (seam: ResolvedModelConfig): Promise<ModelCheckVerdict> => {
    asked.push(`${seam.provider}/${seam.model}`);
    return new Promise((resolve) => answers.push(resolve));
  };
  const clock = watchdogClock(t);
  const gate = new ModelCheckGate(repo, prober, new AbortController().signal, {
    retryMs: 60_000,
    maxRetryMs: 60_000,
    suspectMinMs: 1_000,
  });
  const runner = makeRoleRunner(repo, "clean", config);
  const poll = () => gate.poll({ runners: [runner], liveConfig: config, roleConfig: config, info });

  // The pair answers its first probe: verified, the role runs.
  poll();
  assert.deepEqual(asked, ["local/flint"]);
  answers.shift()!({ ok: true });
  await gate.settled();
  assert.deepEqual([...poll()], []);

  // The run sends one request and hears nothing back.
  let restore = fakePi([TOUCH_SESSION, `printf '%s\\n' '${REQUEST_START}'`, `exec sleep 30`].join("\n"));
  let settled = false;
  const runDone = runner.run().finally(() => (settled = true));
  try {
    await waitForLogLines(piLogPath(repo, "clean"), "message_start");
    assert.equal(runner.unansweredRunPair(), null, "not unanswered before the stall threshold");
    // Past the 2 s threshold at the watchdog's first check (every 30 s with this quiet window),
    // and far short of the 600 s quiet kill.
    clock.advance(31_000);
    assert.equal(runner.unansweredRunPair(), "local/flint");
    assert.ok(warningMessages(repo).some((w) => w.startsWith("model request unanswered: local/flint")));

    // The check's poll re-checks the pair the run waits on, while the role keeps its verdict.
    assert.deepEqual([...poll()], []);
    assert.deepEqual(asked, ["local/flint", "local/flint"], "the waiting run's pair is probed again");
    poll();
    assert.equal(asked.length, 2, "no second probe while one is in flight");

    // The probe gets no reply either: the pair fails, the role is held, and the hung run is
    // handed back — once, however many polls see it before it ends.
    answers.shift()!({ ok: false, reason: "no reply", reply: "", detail: "no answer within 300s" });
    await gate.settled();
    assert.deepEqual([...poll()], ["clean"]);
    poll();
    const outcome = await runDone;
    assert.equal(outcome.result, "aborted");
    assert.equal(outcome.resumeCause, "model-check");
    const handedBack = warningMessages(repo).filter((w) => w.startsWith("run handed back:"));
    assert.deepEqual(handedBack, [
      "run handed back: its model request to local/flint is unanswered and the pair failed its model check — the run resumes on a pair that answers",
    ]);
    assert.equal(runner.unansweredRunPair(), null, "the settled run waits on nothing");
    const s = loadRunnerState(repo, "clean");
    assert.ok(s.resumePending, "the session is kept for a resume");
    assert.equal(s.resumeCause, "model-check");
  } finally {
    if (!settled) runner.abortRun();
    await runDone.catch(() => {});
    restore();
  }

  // The pair answers again: the role resumes the same session on the model-check bridge.
  clock.release();
  restore = fakePi(
    [
      TOUCH_SESSION,
      `printf '%s\\n' "$__pi_prompt" >> '${prompts}'`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const resumed = await runner.run();
    assert.equal(resumed.result, "no_change");
    assert.match(fs.readFileSync(prompts, "utf8"), /tumwater's model check then found that model was not answering/);
    assert.equal(loadRunnerState(repo, "clean").resumeCause, undefined, "the cause rode the resume");
  } finally {
    restore();
  }
});

test("a run that fails before any model reply carries RunOutcome.unanswered; one that replied does not", async () => {
  const repo = await initializedRepo();
  const config = flintConfig();
  await withPi(`printf '%s\\n' '${errorLine("connect ECONNREFUSED 127.0.0.1:8080")}'\nexit 1`, async () => {
    const outcome = await makeRoleRunner(repo, "clean", config).run();
    assert.equal(outcome.result, "error");
    assert.equal(outcome.unanswered, true);
  });
  await withPi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`, async () => {
    const outcome = await makeRoleRunner(repo, "clean", config).run();
    assert.equal(outcome.result, "no_change");
    assert.equal(outcome.unanswered, undefined);
  });
});
