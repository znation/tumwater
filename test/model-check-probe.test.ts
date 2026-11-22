// The model check's probe through the same backend path role runs take (runAgent), against
// PATH fakes of two backends with different native streams (pi, claude): a fake that answers,
// one that replies with garbage, and one that says nothing. No test reaches a real model.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MODEL_CHECK_MARKER, runModelCheck, type ModelCheckVerdict } from "../src/model-check/model-check-probe.js";
import { defaultConfig } from "../src/config/config.js";
import { configForRole } from "../src/config/config-views.js";
import { MODEL_CHECK_RUN_NAME, piLogPath, sessionsRootDir } from "../src/paths.js";
import type { SleepSample } from "../src/build/host-sleep.js";
import { scriptedSampler } from "./helpers/sleep-clock.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { claudeAssistant, claudeInit, claudeResult, claudeText } from "./fixtures/claude-events.js";
import { fakePiNoCheck, logPromptsTo, readRunBlocks } from "./fakes/fake-pi.js";
import { withClaudeReplay } from "./fakes/fake-claude.js";

/** The failed verdict `v` must be, narrowed (a failed assertion names what came back instead). */
function failure(v: ModelCheckVerdict): Extract<ModelCheckVerdict, { ok: false }> {
  if (!("reason" in v)) assert.fail(`expected a failed verdict, got ${JSON.stringify(v)}`);
  return v;
}

/** A pi seam on a local provider, as a role on the default tier resolves it. */
function piSeam() {
  const c = defaultConfig();
  c.model = "flintrunner/flint";
  return configForRole(c, "feature");
}

/** Run one probe under a fake pi whose script is `body` (the probe arrives as its prompt). */
async function probeWithPi(body: string) {
  const root = makeRepo();
  const restore = fakePiNoCheck(body);
  try {
    return { root, verdict: await runModelCheck(root, piSeam(), new AbortController().signal) };
  } finally {
    restore();
  }
}

test("pi: a model that answers verifies, and the probe reaches it as a long prompt on its own pair", async () => {
  const prompts = path.join(tmpdir("model-check-prompts-"), "argv.log");
  const { root, verdict } = await probeWithPi(
    `${logPromptsTo(prompts)}\nprintf '%s\\n' '${assistantLine("Isselmar")}'`,
  );
  assert.deepEqual(verdict, { ok: true });
  const [argv] = readRunBlocks(prompts);
  assert.ok(argv?.includes(MODEL_CHECK_MARKER), "the fake received the probe as its prompt");
  assert.match(argv ?? "", /--provider\nflintrunner\n/);
  assert.match(argv ?? "", /--model\nflint\n/);
  // The probe's transcript is kept beside the roles' logs; its throwaway session is not.
  assert.match(fs.readFileSync(piLogPath(root, MODEL_CHECK_RUN_NAME), "utf8"), /model check flintrunner\/flint/);
  assert.deepEqual(fs.readdirSync(path.join(sessionsRootDir(root), MODEL_CHECK_RUN_NAME)), []);
});

test("pi: word salad fails as a wrong answer quoting the reply", async () => {
  const salad = "the of river the and of Callow mills the the ".repeat(10);
  const verdict = failure((await probeWithPi(`printf '%s\\n' '${assistantLine(salad)}'`)).verdict);
  assert.equal(verdict.reason, "wrong answer");
  assert.ok(verdict.reply.startsWith("the of river the and of Callow"));
});

test("pi: a backend that returns nothing fails as no reply", async () => {
  assert.equal(failure((await probeWithPi("exit 0")).verdict).reason, "no reply");
  const refused = failure((await probeWithPi("echo 'connect ECONNREFUSED 127.0.0.1:8091' >&2; exit 1")).verdict);
  assert.equal(refused.reason, "no reply");
});

test("claude: the same probe through the claude backend verifies an answer and fails garbage", async () => {
  const seam = { ...configForRole(defaultConfig(), "feature"), agent: "claude", provider: undefined, model: "claude-haiku-5-5" };
  const run = async (text: string) =>
    withClaudeReplay(
      [claudeInit(), claudeAssistant({ id: "m1", blocks: [claudeText(text)], usage: { input: 300, output: 2 } }), claudeResult({ totalCostUsd: 0.0001 })],
      async (fake) => {
        const root = makeRepo();
        const verdict = await runModelCheck(root, seam, new AbortController().signal);
        const [stdin] = readRunBlocks(fake.stdinFile);
        assert.ok(stdin?.includes(MODEL_CHECK_MARKER), "claude received the probe on stdin");
        return verdict;
      },
    );
  assert.deepEqual(await run("Isselmar"), { ok: true });
  const wrong = failure(await run("Ostry"));
  assert.deepEqual([wrong.reason, wrong.reply], ["wrong answer", "Ostry"]);
});

test("an aborted probe is no evidence", async () => {
  const root = makeRepo();
  const restore = fakePiNoCheck("sleep 30");
  try {
    const controller = new AbortController();
    const pending = runModelCheck(root, piSeam(), controller.signal);
    setTimeout(() => controller.abort(), 200).unref();
    assert.deepEqual(await pending, { ok: null });
  } finally {
    restore();
  }
});

/** Two samples whose monotonic clock did not advance while the boot clock moved `ms` — the
 * shape a host asleep for `ms` reads as (sleptMsBetween reports `ms`). */
function sleepWindow(ms: number): [SleepSample, SleepSample] {
  return [{ bootMs: 0, monoNs: 0n }, { bootMs: ms, monoNs: 0n }];
}

/** A pi script that gives no reply on its first run and answers on the second. */
function noReplyThenAnswer(prompts: string, flag: string): string {
  return `${logPromptsTo(prompts)}\nif [ -f '${flag}' ]; then printf '%s\\n' '${assistantLine("Isselmar")}'; else touch '${flag}'; exit 0; fi`;
}

test("a no-reply probe across a host sleep is probed again, and the second answer stands", async () => {
  const prompts = path.join(tmpdir("model-check-retry-"), "argv.log");
  const flag = path.join(tmpdir("model-check-retry-flag-"), "first-done");
  const root = makeRepo();
  const restore = fakePiNoCheck(noReplyThenAnswer(prompts, flag));
  try {
    const verdict = await runModelCheck(root, piSeam(), new AbortController().signal, scriptedSampler(sleepWindow(600_000)));
    assert.deepEqual(verdict, { ok: true });
    assert.equal(readRunBlocks(prompts).length, 2, "the sleep-spanning no-reply probe was retried once");
  } finally {
    restore();
  }
});

test("a no-reply probe with no measured sleep is not retried", async () => {
  const prompts = path.join(tmpdir("model-check-quiet-"), "argv.log");
  const root = makeRepo();
  const restore = fakePiNoCheck(logPromptsTo(prompts));
  try {
    const verdict = failure(
      await runModelCheck(root, piSeam(), new AbortController().signal, scriptedSampler(sleepWindow(0))),
    );
    assert.equal(verdict.reason, "no reply");
    assert.equal(readRunBlocks(prompts).length, 1, "the probe ran once");
  } finally {
    restore();
  }
});

test("a wrong answer inside a host sleep is not retried", async () => {
  const prompts = path.join(tmpdir("model-check-wrong-"), "argv.log");
  const root = makeRepo();
  const restore = fakePiNoCheck(`${logPromptsTo(prompts)}\nprintf '%s\\n' '${assistantLine("Ostry")}'`);
  try {
    const verdict = failure(
      await runModelCheck(root, piSeam(), new AbortController().signal, scriptedSampler(sleepWindow(600_000))),
    );
    assert.deepEqual([verdict.reason, verdict.reply], ["wrong answer", "Ostry"]);
    assert.equal(readRunBlocks(prompts).length, 1, "the wrong answer was not probed again");
  } finally {
    restore();
  }
});

test("two no-reply probes in a row, both across sleeps, yield no reply after exactly two probes", async () => {
  const prompts = path.join(tmpdir("model-check-twice-"), "argv.log");
  const root = makeRepo();
  const restore = fakePiNoCheck(logPromptsTo(prompts));
  try {
    const verdict = failure(
      await runModelCheck(
        root,
        piSeam(),
        new AbortController().signal,
        scriptedSampler(sleepWindow(600_000)),
      ),
    );
    assert.equal(verdict.reason, "no reply");
    assert.equal(readRunBlocks(prompts).length, 2, "exactly two probes ran");
  } finally {
    restore();
  }
});
