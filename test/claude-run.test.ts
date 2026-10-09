// The claude backend end to end (plans/agent-backends.md "The seam", "Sessions", PLANS.md
// "Agent backends, part 3c1/7"): `runAgent` drives the registered claude adapter against a
// PATH fake, folds its stream exactly as it folds pi's, and records the minted/resumed
// session id in the ledger. The adapter is not yet selectable from tumwater.json (part 4/7),
// so these tests set `config.agent = "claude"` directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "../src/agent/run-agent.js";
import { claudeBackend, claudeProjectSlug, claudeTranscriptPath } from "../src/agent/claude/claude-backend.js";
import { readSessions } from "../src/agent/session-ledger.js";
import { agentBinSourceLabel } from "../src/pi/pi-bin.js";
import { defaultConfig } from "../src/config/config.js";
import type { PiRunOptions } from "../src/agent/run-agent.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { setEnv } from "./helpers/env.js";
import { fakeClaudeReplay, readRunBlocks } from "./fakes/fake-claude.js";
import {
  claudeAssistant,
  claudeInit,
  claudeResult,
  claudeText,
} from "./fixtures/claude-events.js";

/** A run against `dir` with claude selected and a concrete model resolved — the shape every
 * test starts from. */
function claudeRun(dir: string, over: Partial<PiRunOptions> = {}): PiRunOptions {
  return {
    // Canonicalize: the fake's `pwd` (and the real claude's own cwd) resolves symlinks, so a
    // logical /var path would compute a different project slug than the adapter's run.cwd.
    cwd: fs.realpathSync(dir),
    prompt: "p",
    config: { ...defaultConfig(), agent: "claude", model: "claude-sonnet-5-5" },
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile: path.join(dir, "raw.jsonl"),
    kind: "author",
    ...over,
  };
}

/** One block's argv split into its lines, and the value of `flag` (the next line), or
 * undefined when the flag is absent. */
function argValue(block: string, flag: string): string | undefined {
  const args = block.split("\n");
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

test("runAgent runs the claude backend on a fake and folds its stream", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const fake = fakeClaudeReplay([
    claudeInit({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: "ignored-init-id" }),
    claudeAssistant({ id: "m1", blocks: [claudeText("done")], usage: { input: 10, output: 5 } }),
    claudeResult({ totalCostUsd: 0.02 }),
  ]);
  try {
    const run = claudeRun(dir);
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(result.costUsd, 0.02, "the final result's total_cost_usd is authoritative");
    assert.equal(result.finalText, "done");
    const raw = fs.readFileSync(run.rawLogFile, "utf8");
    assert.match(raw, /"type":"tumwater_run","kind":"author","agent":"claude"/);
    assert.match(raw, /"type":"message_end"/, "the raw log holds the canonical line readers render");

    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argv.length, 1);
    assert.ok(argv[0]!.includes("--session-id"), `fresh run mints a session id: ${argv[0]}`);
    assert.ok(!argv[0]!.includes("--resume"), "a fresh run does not resume");

    const sessions = readSessions(run.sessionDir);
    assert.equal(sessions.length, 1, "one ledger line for the one run");
    const record = sessions[0]!;
    assert.equal(record.agent, "claude");
    assert.equal(record.kind, "author");
    assert.equal(record.cwd, fs.realpathSync(dir));
    assert.equal(argValue(argv[0]!, "--session-id"), record.id, "the ledger carries the argv id");
    assert.ok(
      fs.existsSync(claudeTranscriptPath(run.cwd, record.id)),
      "the fake wrote the transcript the resume check reads",
    );
  } finally {
    fake.restore();
    restoreHome();
  }
});

test("a continueSession run resumes the recorded claude id in its own cwd", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const fake = fakeClaudeReplay([claudeResult({ totalCostUsd: 0 })]);
  try {
    const run = claudeRun(dir);
    const first = await runAgent(run);
    assert.equal(first.ok, true, `${first.errorMessage}`);
    const freshId = argValue(readRunBlocks(fake.argvFile)[0]!, "--session-id");
    assert.ok(freshId, "the first run minted an id");

    const second = await runAgent({ ...run, continueSession: true });
    assert.equal(second.ok, true, `${second.errorMessage}`);
    const secondArgs = readRunBlocks(fake.argvFile)[1]!;
    assert.equal(argValue(secondArgs, "--resume"), freshId, "the continue resumes the recorded id");
    assert.ok(!secondArgs.includes("--session-id"), "a resume does not also mint a fresh id");
  } finally {
    fake.restore();
    restoreHome();
  }
});

test("a ledger record whose cwd differs is not resumed", async () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  const sessions = path.join(tmpdir(), "sessions");
  const restoreHome = setEnv("HOME", tmpdir());
  const fake = fakeClaudeReplay([claudeResult({ totalCostUsd: 0 })]);
  try {
    await runAgent(claudeRun(dirA, { sessionDir: sessions }));
    await runAgent(claudeRun(dirB, { sessionDir: sessions, continueSession: true }));
    const runs = readRunBlocks(fake.argvFile);
    assert.ok(!runs[1]!.includes("--resume"), "another cwd's session is not resumable");
    assert.ok(runs[1]!.includes("--session-id"), "it mints a fresh session instead");
  } finally {
    fake.restore();
    restoreHome();
  }
});

test("a ledger record whose transcript file is absent is not resumed", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const fake = fakeClaudeReplay([claudeResult({ totalCostUsd: 0 })]);
  try {
    const run = claudeRun(dir);
    await runAgent(run);
    const firstId = readSessions(run.sessionDir)[0]!.id;
    fs.rmSync(claudeTranscriptPath(run.cwd, firstId));

    await runAgent({ ...run, continueSession: true });
    const secondArgs = readRunBlocks(fake.argvFile)[1]!;
    assert.ok(!secondArgs.includes("--resume"), "a missing transcript is not resumable");
    const secondId = argValue(secondArgs, "--session-id");
    assert.ok(secondId && secondId !== firstId, "a fresh id is minted instead");
  } finally {
    fake.restore();
    restoreHome();
  }
});

test("the spawned env strips CLAUDECODE and CLAUDE_CODE_SESSION_ID and stdin carries the prompt", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const restoreClaudecode = setEnv("CLAUDECODE", "1");
  const restoreSession = setEnv("CLAUDE_CODE_SESSION_ID", "host-session");
  const fake = fakeClaudeReplay([claudeResult({ totalCostUsd: 0 })], {
    extraScript: [
      `echo "env:CLAUDECODE=\${CLAUDECODE-<unset>}" >> "$stdinFile"`,
      `echo "env:CLAUDE_CODE_SESSION_ID=\${CLAUDE_CODE_SESSION_ID-<unset>}" >> "$stdinFile"`,
    ],
  });
  try {
    await runAgent(claudeRun(dir, { prompt: "the prompt" }));
    const stdin = fs.readFileSync(fake.stdinFile, "utf8");
    assert.match(stdin, /env:CLAUDECODE=<unset>/, "the host session's CLAUDECODE was scrubbed");
    assert.match(
      stdin,
      /env:CLAUDE_CODE_SESSION_ID=<unset>/,
      "the host session's CLAUDE_CODE_SESSION_ID was scrubbed",
    );
    assert.ok(readRunBlocks(fake.stdinFile)[0]!.includes("the prompt"), "stdin carries the prompt");
  } finally {
    fake.restore();
    restoreSession();
    restoreClaudecode();
    restoreHome();
  }
});

test("claude classifies a not-logged-in stderr as a config error and leaves a killed run alone", () => {
  assert.deepEqual(
    claudeBackend.classifyExit({ code: 1, stderr: "Not logged in · Please run /login", killed: false }),
    { configError: true },
  );
  assert.deepEqual(
    claudeBackend.classifyExit({ code: null, stderr: "Not logged in", killed: true }),
    {},
    "a harness-killed run has its own cause",
  );
  assert.deepEqual(claudeBackend.classifyExit({ code: 1, stderr: "boom", killed: false }), {});
});

test("claude rejects a run with no resolved model", async () => {
  const dir = tmpdir();
  const run = claudeRun(dir);
  delete (run.config as { model?: string }).model;
  await assert.rejects(runAgent(run), /no model resolved/);
});

test("claude resolves its binary from TUMWATER_CLAUDE_BIN and names it in the source label", () => {
  const restore = setEnv("TUMWATER_CLAUDE_BIN", "/opt/claude");
  try {
    assert.deepEqual(claudeBackend.resolveBin({}), { bin: "/opt/claude", source: "env" });
    assert.equal(agentBinSourceLabel("env", "TUMWATER_CLAUDE_BIN"), "TUMWATER_CLAUDE_BIN");
  } finally {
    restore();
  }
});

test("the claude project slug turns every non-alphanumeric into a dash, as the fake assumes", () => {
  assert.equal(claudeProjectSlug("/work/a b"), "-work-a-b");
  assert.equal(claudeProjectSlug("/var/folders/x__y/T/z"), "-var-folders-x--y-T-z");
});
