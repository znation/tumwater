// The codex backend end to end (plans/codex-backend.md §4, §5, §6): `runAgent` drives the
// registered codex adapter against a PATH fake, reads the authoritative rollout after each
// run, mints a second (thread-id) ledger record once the stream names the session, resumes by
// id through the same rollout check, and reports the run's usage and windows from the rollout.
// These tests set `config.agent = "codex"` directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "../src/agent/run-agent.js";
import { readSessions, recordSession } from "../src/agent/session-ledger.js";
import { codexBackend } from "../src/agent/codex/codex-backend.js";
import { codexTranslator } from "../src/agent/codex/codex-stream.js";
import { defaultConfig } from "../src/config/config.js";
import { suiteRerunWarning, type ToolCallStart } from "../src/review/suite-rerun.js";
import type { PiRunOptions } from "../src/agent/run-agent.js";
import type { AgentBackend } from "../src/agent/agent-backend.js";
import { withCwd } from "./helpers/env.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withCodexReplay, readRunBlocks } from "./fakes/fake-codex.js";
import { codexCaptures } from "./fixtures/codex-events.js";

/** A run against `dir` with codex selected and a concrete model resolved, whose team config
 * points Codex's home at a directory under `dir` (so the fake writes its rollout there and a
 * resume finds it). The session dir lives under `dir/.tumwater`. */
function codexRun(dir: string, over: Partial<PiRunOptions> = {}): PiRunOptions {
  return {
    cwd: fs.realpathSync(dir),
    prompt: "p",
    config: {
      ...defaultConfig(),
      agent: "codex",
      model: "gpt-6-luna",
      backends: { codex: { configDir: path.join(dir, "codex-home") } },
    },
    sessionDir: path.join(dir, ".tumwater", "sessions", "t"),
    sessionName: "t",
    rawLogFile: path.join(dir, ".tumwater", "log", "t.codex.jsonl"),
    nativeLogFile: path.join(dir, ".tumwater", "log", "t.codex.native.jsonl"),
    kind: "author",
    ...over,
  };
}

/** One argv block's arguments, with the blank separator lines the fake's RUN_MARKER split
 * leaves between runs dropped (a later run's block begins with a newline). */
function argLines(block: string): string[] {
  return block.split("\n").filter((s) => s !== "");
}

/** The rollout a run of `run` left for its stream-minted thread id: written by the fake under
 * the run's configured `CODEX_HOME` (the team configDir). */
function rolloutPath(run: PiRunOptions, id: string): string {
  return path.join(run.config.backends!.codex!.configDir!, "sessions", "2026-10-21", `rollout-0000-${id}.jsonl`);
}

test("a fresh codex run replays the fake, reads the rollout, and folds its usage", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    const run = codexRun(dir);
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.match(result.finalText ?? "", /DONE/, "the stream's final text is the run's final text");
    // The rollout is authoritative: input 700 (1000 − 300 cached) + cacheRead 300 + output 40.
    assert.equal(result.promptTokens, 1000);
    assert.equal(result.cacheReadTokens, 300);
    assert.equal(result.outputTokens, 40);
    assert.equal(result.billing, "subscription", "a plus plan_type bills the subscription");
    // A fresh run is `exec … -m <model> … -`, never a resume.
    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argv.length, 1);
    const args = argLines(argv[0]!);
    assert.equal(args[0], "exec");
    assert.notEqual(args[1], "resume");
    assert.ok(args.includes("-m"), "the model flag is on every run");
    assert.equal(args[args.indexOf("-m") + 1], "gpt-6-luna");
    assert.ok(readRunBlocks(fake.stdinFile)[0]!.includes("p"), "stdin carries the prompt");
  });
});

test("the ledger holds a pre-spawn record and a stream-minted thread-id record", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    const run = codexRun(dir);
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const sessions = readSessions(run.sessionDir);
    assert.equal(sessions.length, 2, "pre-spawn name record plus the stream-minted thread record");
    assert.equal(sessions[0]!.id, run.sessionName, "the pre-spawn record carries the session name");
    const thread = fs.readFileSync(fake.ledgerFile, "utf8").trim().split("\n")[0];
    assert.ok(thread, "the fake recorded the stream's thread id");
    assert.equal(sessions[1]!.id, thread, "the stream-minted record carries the thread id");
    assert.equal(sessions[1]!.name, run.sessionName);
    assert.equal(sessions[1]!.cwd, run.cwd);
  });
});

test("a continue resumes the recorded thread id with exec resume and -m", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    const run = codexRun(dir);
    const first = await runAgent(run);
    assert.equal(first.ok, true, `${first.errorMessage}`);
    const thread = readSessions(run.sessionDir)[1]!.id;
    const second = await runAgent({ ...run, continueSession: true });
    assert.equal(second.ok, true, `${second.errorMessage}`);
    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argv.length, 2);
    const args = argLines(argv[1]!);
    assert.equal(args[0], "exec");
    assert.equal(args[1], "resume");
    assert.equal(args[2], thread, "the continue resumes the recorded thread id");
    assert.ok(args.includes("-m"));
    assert.equal(args[args.indexOf("-m") + 1], "gpt-6-luna", "a resume keeps the model flag");
  });
});

test("a deleted rollout makes the follow-up run fresh", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    const run = codexRun(dir);
    const first = await runAgent(run);
    assert.equal(first.ok, true, `${first.errorMessage}`);
    const thread = readSessions(run.sessionDir)[1]!.id;
    fs.rmSync(rolloutPath(run, thread));
    const second = await runAgent({ ...run, continueSession: true });
    assert.equal(second.ok, true, `${second.errorMessage}`);
    const args = argLines(readRunBlocks(fake.argvFile)[1]!);
    assert.equal(args[0], "exec");
    assert.notEqual(args[1], "resume", "a missing rollout means a fresh thread, and the runner hands off");
  });
});

test("a rollout reporting seven_day at 72% reads a 0.72 window and subscription billing", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const canned = [
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"@THREAD@"}}',
    '{"type":"token_usage_record","payload":{"type":"token_usage_record","turn_id":"@THREAD@","turn_token_usage":{"input_tokens":500,"cached_input_tokens":100,"cache_write_input_tokens":0,"output_tokens":10}}}',
    '{"type":"event_msg","payload":{"type":"token_count","turn_id":"@THREAD@","rate_limits":{"plan_type":"plus","secondary":{"used_percent":72,"window_minutes":10080,"resets_at":1793142293},"rate_limit_reached_type":null}}}',
  ].join("\n");
  await withCodexReplay(codexCaptures.editRun, { cannedRollout: canned }, async () => {
    const result = await runAgent(codexRun(dir));
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(result.billing, "subscription");
    const sevenDay = result.rateWindows?.find((w) => w.type === "seven_day");
    assert.equal(sevenDay?.utilization, 0.72, "the seven_day window reads 72%");
  });
});

test("a reviewer codex run that runs npm test is seen as a suite rerun", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  // A canned reviewer stream: one command runs `npm test`, then the reviewer answers.
  const rerunStream = [
    '{"type":"thread.started","thread_id":"01a15c9d-6762-7931-814e-a3e6e64c1b51"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'npm test\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'npm test\'","aggregated_output":"ok","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"DONE"}}',
    '{"type":"turn.completed"}',
  ];
  await withCodexReplay(rerunStream, async () => {
    const calls: ToolCallStart[] = [];
    const result = await runAgent({
      ...codexRun(dir),
      kind: "gate",
      onToolCallStart: (toolName, args) => calls.push({ toolName, args }),
    });
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.ok(calls.some((c) => c.toolName === "bash"), "the command reached the tool-call seam");
    assert.ok(suiteRerunWarning(calls), "the reviewer's npm test reads as a suite rerun");
  });
});

test("the catalog gates the effort the run sends and answers image input (part 8/9)", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  // A fixture catalog under the run's CODEX_HOME listing only low and xhigh for gpt-6-luna
  // (no high), with image input.
  const catalogHome = path.join(dir, "codex-home");
  fs.mkdirSync(path.join(catalogHome, "sessions", "2026-10-21"), { recursive: true });
  fs.writeFileSync(
    path.join(catalogHome, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-luna",
          context_window: 272000,
          effective_context_window_percent: 95,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
          default_reasoning_level: "low",
          input_modalities: ["text", "image"],
        },
      ],
    }),
  );
  const baseConfig = () => ({
    ...defaultConfig(),
    agent: "codex",
    model: "gpt-6-luna",
    backends: { codex: { configDir: catalogHome } },
  });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    // high is not among the fixture's levels, so no effort flag is sent.
    const run = codexRun(dir, { config: { ...baseConfig(), thinking: "high" } });
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const args = argLines(readRunBlocks(fake.argvFile)[0]!);
    assert.ok(!args.some((a) => a.startsWith("model_reasoning_effort=")), "a level the model does not list is dropped");

    // xhigh IS cataloged, so it rides as the effort (`-c model_reasoning_effort=xhigh`).
    const run2 = codexRun(dir, { config: { ...baseConfig(), thinking: "xhigh" } });
    const result2 = await runAgent(run2);
    assert.equal(result2.ok, true, `${result2.errorMessage}`);
    const args2 = argLines(readRunBlocks(fake.argvFile)[1]!);
    assert.ok(args2.includes("model_reasoning_effort=xhigh"), "a cataloged level is sent");

    // The same home answers imageInput, read by walking up from the process's cwd to its root.
    const cwdRoot = tmpdir();
    fs.mkdirSync(path.join(cwdRoot, ".tumwater"), { recursive: true });
    fs.writeFileSync(path.join(cwdRoot, "tumwater.json"), JSON.stringify({ backends: { codex: { configDir: catalogHome } } }));
    withCwd(cwdRoot, () => {
      assert.equal(codexBackend.imageInput!("gpt-6-luna"), true, "a cataloged image model reads images");
      assert.equal(codexBackend.imageInput!("no-such-model"), false, "a model missing from the catalog is blind");
    });
  });
});

/** A team root whose `backends.codex.configDir` points at `home`, the shape `resumable` and
 * `afterRun` walk up to when resolving the run's home. */
function codexResumeRoot(root: string, home: string): void {
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ backends: { codex: { configDir: home } } }));
}

/** The `resumable` hook (the seam's id-scoped resume gate, agent-backend.ts:198) is the
 * resume rule `resolveCodexSession` already holds for `invocation`, so it must agree with it:
 * a codex record whose id is a real thread id AND whose rollout exists under the configured
 * home is resumable; anything else — no matching record, a non-UUID id, or a rollout that
 * never landed — is fresh. The run-level resume tests reach `resolveCodexSession` inside
 * `invocation`, never this hook, so its branches are pinned here directly. */
const THREAD_ID = "01a15c9d-6762-7931-814e-a3e6e64c1b51";

function writeThreadRollout(home: string, id: string): void {
  fs.mkdirSync(path.join(home, "sessions", "2026-10-21"), { recursive: true });
  fs.writeFileSync(path.join(home, "sessions", "2026-10-21", `rollout-0000-${id}.jsonl`), "x");
}

test("resumable accepts a codex record whose thread rollout exists under the configured home", () => {
  const root = tmpdir();
  const home = path.join(root, "codex-home");
  codexResumeRoot(root, home);
  const sessionDir = path.join(root, ".tumwater", "sessions", "t");
  recordSession(sessionDir, { agent: "codex", id: THREAD_ID, kind: "author", name: "t", cwd: root, at: 1_730_000_000_000 });
  writeThreadRollout(home, THREAD_ID);
  assert.equal(codexBackend.resumable!(sessionDir, { kind: "author", agent: "codex", cwd: root }), true);
});

test("resumable declines when the ledger holds no matching codex record", () => {
  const sessionDir = path.join(tmpdir(), ".tumwater", "sessions", "t");
  assert.equal(codexBackend.resumable!(sessionDir, { kind: "author", agent: "codex", cwd: "/x" }), false);
});

test("resumable declines a record whose id is not a thread UUID even with a rollout present", () => {
  const root = tmpdir();
  const home = path.join(root, "codex-home");
  codexResumeRoot(root, home);
  const sessionDir = path.join(root, ".tumwater", "sessions", "t");
  recordSession(sessionDir, { agent: "codex", id: "not-a-thread-id", kind: "author", name: "t", cwd: root, at: 1_730_000_000_000 });
  writeThreadRollout(home, "not-a-thread-id");
  assert.equal(codexBackend.resumable!(sessionDir, { kind: "author", agent: "codex", cwd: root }), false);
});

test("resumable declines a UUID record whose rollout never landed under the home", () => {
  const root = tmpdir();
  const home = path.join(root, "codex-home");
  codexResumeRoot(root, home);
  const sessionDir = path.join(root, ".tumwater", "sessions", "t");
  recordSession(sessionDir, { agent: "codex", id: THREAD_ID, kind: "author", name: "t", cwd: root, at: 1_730_000_000_000 });
  assert.equal(codexBackend.resumable!(sessionDir, { kind: "author", agent: "codex", cwd: root }), false);
});

test("afterRun with no session id falls back to the stream usage and flags it partial", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const translator = codexTranslator({});
  // afterRun reads only `run.config` (its model and the resolved codex home), so the run
  // builder's full AgentRunSpec-shaped object stands in for a real resolved spec here.
  const run = codexRun(dir) as unknown as Parameters<NonNullable<AgentBackend["afterRun"]>>[0];
  const lines = codexBackend.afterRun!(run, { args: [], env: {} }, translator);
  assert.deepEqual(lines, []);
  assert.ok(translator.warnings().includes("codex_usage_partial"), translator.warnings().join(", "));
});
