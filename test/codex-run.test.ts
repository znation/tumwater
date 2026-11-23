// The codex backend end to end (plans/codex-backend.md §4, §5, §6): `runAgent` drives the
// registered codex adapter against a PATH fake, reads the authoritative rollout after each
// run, mints a second (thread-id) ledger record once the stream names the session, resumes by
// id through the same rollout check, and reports the run's usage and windows from the rollout.
// These tests set `config.agent = "codex"` directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "../src/agent/agent-run.js";
import { readSessions, recordSession } from "../src/agent/session-ledger.js";
import { codexBackend, setCodexTrustLookupTimeoutMs } from "../src/agent/codex/codex-backend.js";
import { codexTranslator } from "../src/agent/codex/codex-stream.js";
import { patchFsMethod } from "./helpers/fs-faults.js";
import { defaultConfig } from "../src/config/config.js";
import { suiteRerunWarning, type ToolCallStart } from "../src/review/suite-rerun.js";
import type { PiRunOptions } from "../src/agent/agent-run.js";
import { backendById, type AgentBackend, type AgentRunSpec } from "../src/agent/agent-backend.js";
import { withCwd } from "./helpers/env.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withCodexReplay, readRunBlocks, fakeCodexAppServer } from "./fakes/fake-codex.js";
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

/** A minimal AgentRunSpec shaped for the codex adapter's `prepare` (part 5/9): a team root
 * under `dir` with `.tumwater` (so the trust lookup writes its cache there and its warnings
 * land on the run's own root), a configured codex home, and the given codex `bin`.
 * `prepare` reads only config, cwd, sessionDir and agentBin, so this covers it. */
function prepareRunSpec(dir: string, opts: { bin: string }): AgentRunSpec {
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
    kind: "author",
    agentBin: opts.bin,
    runMarker: "mark",
  };
}

test("two codex runs started together share one app-server (prepare single-flight)", async () => {
  // The async `prepare` step (plans/codex-write-guard.md "Trust (parts 4–5)"): resolves the
  // guard's trust by spawning `app-server`, single-flighted per (home, definition), so two
  // concurrent runs start one `app-server`, and a third after the fact starts none.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const fake = fakeCodexAppServer();
  try {
    const spec = prepareRunSpec(dir, { bin: fake.bin });
    await Promise.all([codexBackend.prepare!(spec), codexBackend.prepare!(spec)]);
    assert.equal(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n").length, 1, "concurrent runs share one app-server");
    // A third prepare reads the resolved trust and starts no app-server (cache hit).
    await codexBackend.prepare!(spec);
    assert.equal(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n").length, 1);
  } finally {
    fake.restore();
  }
});

test("a real codex run warms the write guard trust once per build", async () => {
  // Every codex run's `prepare` (part 5/9) resolves the write guard's trust from the same
  // binary it then runs, so a real run starts one app-server and a repeat run on the same
  // build (same home and version) spawns none.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    const run = codexRun(dir);
    const first = await runAgent(run);
    assert.equal(first.ok, true, `${first.errorMessage}`);
    assert.equal(fs.readFileSync(fake.serverCallsFile, "utf8").trim().split("\n").length, 1, "a real run warms trust with one app-server");
    const second = await runAgent(run);
    assert.equal(second.ok, true, `${second.errorMessage}`);
    assert.equal(fs.readFileSync(fake.serverCallsFile, "utf8").trim().split("\n").length, 1, "a repeat run on the same build spawns no app-server");
  });
});

test("an unset backends.codex.configDir defaults the run's sessions to the team home, not ~/.codex", async () => {
  // Part 1/2 (BUGS.md): a run with no `backends.codex.configDir` used to inherit the
  // operator's `~/.codex`, burying team sessions there. The default is now the per-root team
  // home `<root>/.tumwater/codex-home`; the fake writes its rollout under `$CODEX_HOME`, so
  // the rollout's landing spot and the recorded env prove which home the run env pointed Codex
  // at. Point HOME at a temp dir so an `~/.codex` default would land there, never the operator's.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const run: PiRunOptions = {
    ...codexRun(dir),
    config: { ...defaultConfig(), agent: "codex", model: "gpt-6-luna", backends: {} },
  };
  const realHome = process.env.HOME;
  process.env.HOME = tmpdir("codex-run-empty-home-");
  try {
    await withCodexReplay(codexCaptures.editRun, async (fake) => {
      const result = await runAgent(run);
      assert.equal(result.ok, true, `${result.errorMessage}`);
      const thread = readSessions(run.sessionDir)[1]!.id;
      const teamHome = path.join(dir, ".tumwater", "codex-home");
      const rollout = path.join(teamHome, "sessions", "2026-10-21", `rollout-0000-${thread}.jsonl`);
      assert.ok(fs.existsSync(rollout), "the fresh run's rollout lands under the team home");
      assert.ok(
        !fs.existsSync(path.join(process.env.HOME!, ".codex", "sessions", "2026-10-21", `rollout-0000-${thread}.jsonl`)),
        "no rollout under the old default ~/.codex",
      );
      const env = fs.readFileSync(fake.envFile, "utf8");
      assert.match(env, new RegExp(`^CODEX_HOME=${escaped(teamHome)}$`, "m"), "the run env sets CODEX_HOME to the team home");
    });
  } finally {
    process.env.HOME = realHome;
  }
});

/** Regex-escape a path fragment for a `new RegExp` string. */
function escaped(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$" + "&");
}

test("a fresh and a resumed run carry the write guard's hook and trust, and never bypass hook trust (part 6/9)", async () => {
  // Part 6/9: `invocation` turns the trust `prepare` warmed into two `-c` values (finding 1
  // and 2), so every real codex run's argv carries the hook and its trust together, with the
  // fake's key and a sha256: hash, and no argv ever passes --dangerously-bypass-hook-trust.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withCodexReplay(codexCaptures.editRun, async (fake) => {
    const run = codexRun(dir);
    const first = await runAgent(run);
    assert.equal(first.ok, true, `${first.errorMessage}`);
    const second = await runAgent({ ...run, continueSession: true });
    assert.equal(second.ok, true, `${second.errorMessage}`);
    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argv.length, 2);
    for (const block of argv) {
      const args = argLines(block);
      assert.equal(args.filter((a) => a.startsWith("hooks.PreToolUse=[")).length, 1, "the hook -c is present");
      assert.equal(
        args.filter((a) =>
          a.startsWith('hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:'),
        ).length,
        1,
        "the trust -c rides beside the hook with the fake's key and a sha256: hash",
      );
      assert.ok(!args.includes("--dangerously-bypass-hook-trust"), "no argv ever bypasses hook trust");
    }
  });
});

test("a codex run whose trust lookup fails carries neither guard -c value (part 6/9)", async () => {
  // A failed lookup (the fake lists the hook under a `user` source, so the session-flag match
  // fails) records `off`; the invocation then passes no guard -c, leaving today's argv.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const fake = fakeCodexAppServer({ mismatch: true });
  try {
    const spec = prepareRunSpec(dir, { bin: fake.bin });
    await codexBackend.prepare!(spec);
    const { args } = codexBackend.invocation(codexRun(dir) as unknown as AgentRunSpec);
    assert.ok(!args.some((a) => a.startsWith("hooks.PreToolUse=") || a.startsWith("hooks.state=")), "no guard -c when trust is off");
  } finally {
    fake.restore();
  }
});

test("pi, claude and opencode backends have no prepare, so they start no app-server", () => {
  // Only the codex adapter needs the async trust lookup; pi, claude and opencode resolve their
  // runs synchronously, so they register no `prepare` and can never spawn an app-server.
  for (const id of ["pi", "claude", "opencode"]) {
    assert.equal(backendById(id)!.prepare, undefined, `${id} has no prepare hook`);
  }
});

test("a hanging app-server resolves off after the bound and warns once across three runs", async () => {
  // A trust lookup that hangs turns the write guard off: prepare never throws (both concurrent
  // runs still start after the bounded wait), the off state and the warning are recorded once
  // per process per (home, definition), and a third run reads the recorded off state without
  // starting another app-server or warning again.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const eventsFile = path.join(dir, ".tumwater", "log", "events.jsonl");
  const fake = fakeCodexAppServer({ hang: true });
  setCodexTrustLookupTimeoutMs(4000);
  try {
    const spec = prepareRunSpec(dir, { bin: fake.bin });
    await Promise.all([codexBackend.prepare!(spec), codexBackend.prepare!(spec)]);
    await codexBackend.prepare!(spec);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter((l) => l !== "");
    const off = events.filter((l) => l.includes("codex write guard off:"));
    assert.equal(off.length, 1, "the write-guard-off warning is logged exactly once");
    assert.match(JSON.parse(off[0]!).message, /codex write guard off: codex hook trust lookup timed out/);
    assert.equal(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n").length, 1, "the three runs shared one (hanging) lookup");
  } finally {
    setCodexTrustLookupTimeoutMs(15_000);
    fake.restore();
  }
});

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

/** A rollout head long enough to sit past the tail scan's small-file threshold (8 KiB), so the
 * read of it must go through the chunked window, never `fs.readFileSync`. */
/** A turn_context line naming the model that actually ran. */
function codexTurnContextLine(model: string): string {
  return JSON.stringify({ timestamp: "2026-10-21T00:00:00.000Z", type: "turn_context", payload: { type: "turn_context", turn_id: "turn-a", model } });
}

function rolloutFiller(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ timestamp: "2026-10-21T00:00:00.000Z", type: "response_item", payload: { type: "reasoning", id: `r-${i}`, pad: "p".repeat(60) } }),
  ).join("\n");
}

test("afterRun reads a grown rollout's usage from its tail, with no whole-file read of it", () => {
  const root = tmpdir();
  const home = path.join(root, "codex-home");
  codexResumeRoot(root, home);
  const rollout = path.join(home, "sessions", "2026-10-21", `rollout-0000-${THREAD_ID}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(
    rollout,
    [
      rolloutFiller(400),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }),
      codexTurnContextLine("gpt-6-luna"),
      JSON.stringify({
        type: "token_usage_record",
        payload: { turn_id: "turn-a", turn_token_usage: { input_tokens: 1000, cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 40 } },
      }),
    ].join("\n") + "\n",
  );
  const run = codexRun(root) as unknown as Parameters<NonNullable<AgentBackend["afterRun"]>>[0];
  const translator = codexTranslator({});
  // A rollout is Codex's record of the whole thread and grows without bound, so afterRun must
  // never decode it whole: the only whole-file read of it is fs.readFileSync, and with that call
  // forbidden for this path the reading still comes out exact.
  const undo = patchFsMethod("readFileSync", (orig) => (...args: unknown[]) => {
    if (String(args[0]) === rollout) throw new Error("afterRun read the rollout whole");
    return orig(...args);
  });
  try {
    const lines = codexBackend.afterRun!(run, { args: [], env: {}, sessionId: THREAD_ID }, translator).map((l) => JSON.parse(l) as Record<string, unknown>);
    const usage = lines.find((e) => e.type === "run_usage")!;
    assert.equal(usage.input, 700, "the tail window holds the turn's own usage");
    assert.equal(usage.output, 40);
    assert.ok(!translator.warnings().includes("codex_usage_partial"), translator.warnings().join(", "));
  } finally {
    undo();
  }
});
