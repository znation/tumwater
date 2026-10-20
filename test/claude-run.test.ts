// The claude backend end to end (plans/agent-backends.md "The seam", "Sessions", PLANS.md
// "Agent backends, part 3c1/7"): `runAgent` drives the registered claude adapter against a
// PATH fake, folds its stream exactly as it folds pi's, and records the minted/resumed
// session id in the ledger. These tests set `config.agent = "claude"` directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent/run-agent.js";
import type { AgentRunSpec } from "../src/agent/agent-backend.js";
import { claudeBackend, claudeConfigDir, claudeProjectSlug, claudeTranscriptPath } from "../src/agent/claude/claude-backend.js";
import { readSessions, recordSession } from "../src/agent/session-ledger.js";
import { agentBinSourceLabel } from "../src/pi/pi-bin.js";
import { defaultConfig } from "../src/config/config.js";
import { configForRole } from "../src/config/config-views.js";
import type { PiRunOptions } from "../src/agent/run-agent.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { setEnv } from "./helpers/env.js";
import { fakeClaudeReplay, readRunBlocks, withClaudeReplay } from "./fakes/fake-claude.js";
import { writeScript } from "./fakes/fake-commands.js";
import {
  claudeAssistant,
  claudeInit,
  claudeResult,
  claudeText,
  claudeUnknown,
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
    nativeLogFile: path.join(dir, "native.jsonl"),
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
  await withClaudeReplay([
    claudeInit({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: "ignored-init-id" }),
    claudeAssistant({ id: "m1", blocks: [claudeText("done")], usage: { input: 10, output: 5 } }),
    claudeResult({ totalCostUsd: 0.02 }),
  ], async (fake) => {
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
  });
});

test("a third-party provider run is API billing even when init reports apiKeySource none", async () => {
  // plans/agent-backends.md §7: Bedrock/Vertex/Foundry are API billing, which is what
  // seedBilling and the smoke check's expectedBilling answer from the same environment. A
  // Foundry run's init can report apiKeySource "none", which the translator would otherwise
  // read as the claude.ai subscription; it must follow the provider switch instead.
  const dir = tmpdir();
  const restoreFoundry = setEnv("CLAUDE_CODE_USE_FOUNDRY", "1");
  try {
    await withClaudeReplay([
      claudeInit({ apiKeySource: "none", sessionId: "s1" }),
      claudeResult({ totalCostUsd: 0.01 }),
    ], async () => {
      const result = await runAgent(claudeRun(dir));
      assert.equal(result.billing, "api");
    });
  } finally {
    restoreFoundry();
  }
});

test("an unterminated final native line is still translated at stream end", async () => {
  // A backend may flush a complete JSON event and close without its trailing newline — the
  // last write landed, but its terminator did not. The native line buffer must feed that tail
  // at stream end, or the run's authoritative result (cost, final text) is silently dropped
  // and a successful run looks cost-unknown. The extra script strips the fixture's trailing
  // newline so the final `result` arrives only when the stream closes.
  const dir = tmpdir();
  await withClaudeReplay(
    [
      claudeInit({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: "s" }),
      claudeAssistant({ id: "m1", blocks: [claudeText("done")], usage: { input: 10, output: 5 } }),
      claudeResult({ totalCostUsd: 0.02 }),
    ],
    {
      extraScript: [
        `printf '%s' "$(cat "$streamFile")" > "$streamFile.trimmed" && mv "$streamFile.trimmed" "$streamFile"`,
      ],
    },
  async () => {
    const run = claudeRun(dir);
    const result = await runAgent(run);
    assert.equal(result.costUsd, 0.02, "the unterminated final result is still folded");
    assert.equal(result.finalText, "done");
  });
});

test("agent: claude with no model resolves the author tier default that reaches --model", async () => {
  // Part 4b/7's config routing, end to end: a config that names only the backend must spawn
  // claude with the default tier's model on the command line.
  const dir = tmpdir();
  await withClaudeReplay([
    claudeInit({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: "ignored-init-id" }),
    claudeResult({ totalCostUsd: 0.01 }),
  ], async (fake) => {
    const config = defaultConfig();
    config.backend = "claude";
    const run = claudeRun(dir, { config: configForRole(config, "feature") });
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argv.length, 1);
    assert.equal(argValue(argv[0]!, "--model"), "claude-sonnet-5-5", "the default-tier claude model runs");
  });
});

test("a run killed before its result still flushes the last assistant message", async () => {
  // A batching backend closes its folded assistant message only on the next event or the
  // result. A run the watchdog kills mid-turn sends neither, so run-agent must ask the
  // translator to flush at stream end (StreamTranslator.finalize) or the raw log readers lose
  // the last turn (BUGS.md 2026-10-09). The fake prints one assistant event and then sleeps
  // until the quiet watchdog kills it.
  const dir = tmpdir();
  await withClaudeReplay(
    [claudeAssistant({ id: "m1", blocks: [claudeText("still working")], usage: { output: 3 } })],
    { extraScript: ['cat "$streamFile"', "exec sleep 60"] },
  async () => {
    const run = claudeRun(dir, {
      config: { ...defaultConfig(), agent: "claude", model: "claude-sonnet-5-5", runTimeoutSeconds: 5, quietTimeoutSeconds: 1 },
    });
    const result = await runAgent(run);
    assert.equal(result.ok, false, "the killed run is a failure");
    const raw = fs.readFileSync(run.rawLogFile, "utf8");
    assert.match(raw, /"type":"message_end"/, "the flushed turn reaches the raw log");
    assert.match(raw, /still working/, "the pending assistant text is in the flushed message");
  });
});

test("a continueSession run resumes the recorded claude id in its own cwd", async () => {
  const dir = tmpdir();
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], async (fake) => {
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
  });
});

test("a ledger record whose cwd differs is not resumed", async () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  const sessions = path.join(tmpdir(), "sessions");
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], async (fake) => {
    await runAgent(claudeRun(dirA, { sessionDir: sessions }));
    await runAgent(claudeRun(dirB, { sessionDir: sessions, continueSession: true }));
    const runs = readRunBlocks(fake.argvFile);
    assert.ok(!runs[1]!.includes("--resume"), "another cwd's session is not resumable");
    assert.ok(runs[1]!.includes("--session-id"), "it mints a fresh session instead");
  });
});

test("claude's resumable predicate requires the kind, the recorded cwd, and a transcript", () => {
  const sessions = path.join(tmpdir(), "sessions");
  const cwd = fs.realpathSync(tmpdir());
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    recordSession(sessions, {
      agent: "claude",
      id: "rec-id",
      kind: "author",
      name: "n",
      cwd,
      at: Date.now(),
    });
    const transcript = claudeTranscriptPath(cwd, "rec-id");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "");
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "claude", cwd }),
      true,
      "a transcript at the recorded cwd is resumable",
    );
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "claude" }),
      true,
      "without a requested cwd the record's own cwd decides",
    );
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "claude", cwd: "/elsewhere" }),
      false,
      "a different cwd is not resumable",
    );
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "gate", agent: "claude", cwd }),
      false,
      "another kind's record is not resumable",
    );
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "pi", cwd }),
      false,
      "another agent's record is not resumable",
    );
    fs.rmSync(transcript);
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "claude", cwd }),
      false,
      "a missing transcript is not resumable",
    );
  } finally {
    restoreHome();
  }
});

test("claudeTranscriptPath follows CLAUDE_CONFIG_DIR and expands a leading ~", () => {
  assert.equal(
    claudeTranscriptPath("/w a/b", "r1", { CLAUDE_CONFIG_DIR: "/cfg/sc" }, "/home/x"),
    "/cfg/sc/projects/-w-a-b/r1.jsonl",
  );
  assert.equal(
    claudeTranscriptPath("/w a/b", "r1", { CLAUDE_CONFIG_DIR: "~/reloc" }, "/home/x"),
    "/home/x/reloc/projects/-w-a-b/r1.jsonl",
  );
  assert.equal(
    claudeTranscriptPath("/w a/b", "r1", {}, "/home/x"),
    "/home/x/.claude/projects/-w-a-b/r1.jsonl",
  );
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "~" }, "/home/x"), "/home/x");
});

test("a team config dir wins over the env in claudeConfigDir and the run env carries it", () => {
  // claudeConfigDir reads the configured dir before the env (plans/notes-command.md "Keeping
  // funes out of team runs"): the team's own dir is never overridden by an inherited var.
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/host/app" }, "/home/x", "~/team"), "/home/x/team");
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/host/app" }, "/home/x", "/abs/team"), "/abs/team");
  assert.equal(
    claudeTranscriptPath("/w", "id", { CLAUDE_CONFIG_DIR: "/host/app" }, "/home/x", "/home/x/team"),
    "/home/x/team/projects/-w/id.jsonl",
    "the transcript resolves under the configured dir",
  );
  // A run with backends.claude.configDir spawns claude with that dir as CLAUDE_CONFIG_DIR.
  const spec: AgentRunSpec = {
    cwd: fs.realpathSync(tmpdir()),
    prompt: "p",
    config: {
      ...defaultConfig(),
      agent: "claude",
      model: "claude-sonnet-5-5",
      backends: { claude: { configDir: "~/team-claude" } },
    },
    sessionDir: path.join(tmpdir(), "sessions"),
    sessionName: "t",
    kind: "author",
    agentBin: "claude",
    runMarker: "m",
  };
  const inv = claudeBackend.invocation(spec);
  assert.equal(inv.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), "team-claude"));
});

test("the resume check finds a transcript at a relocated CLAUDE_CONFIG_DIR", async () => {
  const sessions = path.join(tmpdir(), "sessions");
  const cwd = fs.realpathSync(tmpdir());
  const reloc = tmpdir();
  const restoreEnv = setEnv("CLAUDE_CONFIG_DIR", reloc);
  try {
    recordSession(sessions, {
      agent: "claude",
      id: "relocated-id",
      kind: "author",
      name: "n",
      cwd,
      at: Date.now(),
    });
    const transcript = claudeTranscriptPath(cwd, "relocated-id");
    assert.ok(
      transcript.startsWith(reloc + path.sep),
      `the transcript lives under the relocated dir: ${transcript}`,
    );
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "");
    // The default `~/.claude` tree is untouched, so only the relocated file is relevant.
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "claude", cwd }),
      true,
      "a transcript written at the relocated path is resumable",
    );
    fs.rmSync(transcript);
    assert.equal(
      claudeBackend.resumable!(sessions, { kind: "author", agent: "claude", cwd }),
      false,
      "removing the relocated transcript makes the run non-resumable",
    );
  } finally {
    restoreEnv();
  }
});

test("a ledger record whose transcript file is absent is not resumed", async () => {
  const dir = tmpdir();
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], async (fake) => {
    const run = claudeRun(dir);
    await runAgent(run);
    const firstId = readSessions(run.sessionDir)[0]!.id;
    fs.rmSync(claudeTranscriptPath(run.cwd, firstId));

    await runAgent({ ...run, continueSession: true });
    const secondArgs = readRunBlocks(fake.argvFile)[1]!;
    assert.ok(!secondArgs.includes("--resume"), "a missing transcript is not resumable");
    const secondId = argValue(secondArgs, "--session-id");
    assert.ok(secondId && secondId !== firstId, "a fresh id is minted instead");
  });
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

test("claude resolves its binary from TUMWATER_CLAUDE_BIN or backends.claude.bin", () => {
  const restore = setEnv("TUMWATER_CLAUDE_BIN", "/opt/claude");
  try {
    assert.deepEqual(claudeBackend.resolveBin({}), { bin: "/opt/claude", source: "env" });
    assert.equal(agentBinSourceLabel("env", "TUMWATER_CLAUDE_BIN"), "TUMWATER_CLAUDE_BIN");
  } finally {
    restore();
  }
  // Part 4c/7: the config entry names claude's binary too, and env stays the override.
  assert.deepEqual(
    claudeBackend.resolveBin({ backends: { claude: { bin: "/opt/claude" } } }),
    { bin: "/opt/claude", source: "config" },
  );
});

test("a claude spawn error names backends.claude.bin, not pi's agentBin", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    const run = claudeRun(dir);
    run.config = { ...run.config, backends: { claude: { bin: "/no/such/dir-xyz/claude-here" } } };
    const result = await runAgent(run);
    assert.equal(result.ok, false);
    assert.match(result.errorMessage ?? "", /failed to spawn \/no\/such\/dir-xyz\/claude-here/);
    assert.match(result.errorMessage ?? "", /resolved from backends\.claude\.bin in tumwater\.json/);
  } finally {
    restoreHome();
  }
});

test("a backend that exits before reading a large stdin prompt does not crash the run with EPIPE", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const bin = path.join(dir, "claude-exits");
  // A backend that dies at startup without draining its stdin: what a bad flag, an
  // unresumable session, or a not-logged-in startup does. With a prompt larger than the OS
  // pipe buffer, the runner's stdin write then fails EPIPE (write EPIPE on a dead reader).
  writeScript(bin, "exit 7");
  try {
    const run = claudeRun(dir, {
      prompt: "x".repeat(512 * 1024),
      config: { ...defaultConfig(), backend: "claude", model: "claude-sonnet-5-5", backends: { claude: { bin } } },
    });
    // The stdin stream's 'error' must be handled: unhandled it is thrown from the event loop
    // and takes the whole process down, before the run's own exit status is ever folded. The
    // sibling guard is git.ts's patchId, for a patch-id that dies before reading its input.
    const result = await runAgent(run);
    assert.equal(result.ok, false, "the run fails on the child's exit, not the parent's EPIPE");
  } finally {
    restoreHome();
  }
});

test("each run gets its own TMPDIR, removed when the run settles", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const bin = path.join(dir, "claude-tmp");
  const seen = path.join(dir, "seen-tmpdir");
  writeScript(bin, `printf %s "$TMPDIR" > '${seen}'; touch "$TMPDIR/x"`);
  try {
    const config = { ...defaultConfig(), agent: "claude" as const, model: "claude-sonnet-5-5", backends: { claude: { bin } } };
    await runAgent(claudeRun(dir, { config }));
    const first = fs.readFileSync(seen, "utf8");
    await runAgent(claudeRun(dir, { config }));
    const second = fs.readFileSync(seen, "utf8");
    assert.match(path.basename(first), /^tumwater-run-/);
    assert.notEqual(first, second, "two runs never share a scratch dir");
    assert.equal(fs.existsSync(first), false, "the run's TMPDIR is swept at settle");
  } finally {
    restoreHome();
  }
});

test("an unremovable scratch dir does not make the run throw", async () => {
  const dir = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const bin = path.join(dir, "claude-ro");
  writeScript(bin, `mkdir "$TMPDIR/ro" && touch "$TMPDIR/ro/f" && chmod 555 "$TMPDIR/ro"`);
  try {
    const config = { ...defaultConfig(), agent: "claude" as const, model: "claude-sonnet-5-5", backends: { claude: { bin } } };
    const result = await runAgent(claudeRun(dir, { config }));
    assert.equal(typeof result.ok, "boolean", "the run settles with a result");
  } finally {
    restoreHome();
  }
});

test("backends.claude.args reaches the fake's recorded argv after the harness flags", async () => {
  const dir = tmpdir();
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], async (fake) => {
    const run = claudeRun(dir);
    run.config = { ...run.config, backends: { claude: { args: ["--debug"] } } };
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const argv = readRunBlocks(fake.argvFile)[0]!.split("\n");
    assert.ok(argv.includes("--debug"), `passthrough arg reaches argv: ${argv.join(" ")}`);
    assert.ok(
      argv.indexOf("--debug") > argv.indexOf("--strict-mcp-config"),
      "passthrough args are appended after the harness flags",
    );
  });
});

test("the claude project slug turns every non-alphanumeric into a dash, as the fake assumes", () => {
  assert.equal(claudeProjectSlug("/work/a b"), "-work-a-b");
  assert.equal(claudeProjectSlug("/var/folders/x__y/T/z"), "-var-folders-x--y-T-z");
});

test("a claude run writes native lines beside the canonical raw log and warns once per unknown type", async () => {
  const dir = tmpdir();
  const warnings: string[] = [];
  await withClaudeReplay([
    claudeInit({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: "s1" }),
    claudeUnknown("mystery_event"),
    claudeAssistant({ id: "m1", blocks: [claudeText("done")], usage: { input: 10, output: 5 } }),
    claudeResult({ totalCostUsd: 0.02 }),
  ], async () => {
    const run = claudeRun(dir, { onAgentWarning: (w) => warnings.push(w) });
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);

    const native = fs.readFileSync(run.nativeLogFile, "utf8");
    assert.match(native, /"type":"system"/, "the native log keeps the raw claude line");
    assert.match(native, /"type":"mystery_event"/, "the native log keeps even an unmapped type");
    assert.match(native, /"type":"result"/);
    const raw = fs.readFileSync(run.rawLogFile, "utf8");
    assert.match(raw, /"type":"message_end"/, "the canonical log holds the translated line");
    assert.doesNotMatch(raw, /mystery_event/, "the canonical log drops the unmapped native line");

    assert.deepEqual(warnings, ["mystery_event"], "the unmapped type warns exactly once");
  });
});

test("a claude run with no native output writes no native lines and warns about nothing", async () => {
  const dir = tmpdir();
  const warnings: string[] = [];
  await withClaudeReplay([], async () => {
    const run = claudeRun(dir, { onAgentWarning: (w) => warnings.push(w) });
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(fs.readFileSync(run.nativeLogFile, "utf8"), "", "no native output writes no lines");
    assert.deepEqual(warnings, [], "a run with no activity warns about nothing");
  });
});

test("a result-less claude run warns cost_unknown exactly once", async () => {
  const dir = tmpdir();
  const warnings: string[] = [];
  await withClaudeReplay([
    claudeInit({ apiKeySource: "ANTHROPIC_API_KEY", sessionId: "s1" }),
    claudeAssistant({ id: "m1", blocks: [claudeText("partial")], usage: { input: 10, output: 5 } }),
  ], async () => {
    await runAgent(claudeRun(dir, { onAgentWarning: (w) => warnings.push(w) }));
    assert.deepEqual(warnings, ["cost_unknown"], "a run with activity but no result cost warns once");
  });
});

test("the native log rotates under logMaxBytes like the raw log", async () => {
  const dir = tmpdir();
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], async () => {
    const run = claudeRun(dir, {
      config: { ...defaultConfig(), agent: "claude", model: "claude-sonnet-5-5", logMaxBytes: 16 },
    });
    fs.mkdirSync(path.dirname(run.nativeLogFile), { recursive: true });
    fs.writeFileSync(run.nativeLogFile, "x".repeat(100) + "\n");
    await runAgent(run);
    assert.equal(
      fs.readFileSync(run.nativeLogFile + ".1", "utf8"),
      "x".repeat(100) + "\n",
      "the grown generation moves to .1",
    );
    assert.match(fs.readFileSync(run.nativeLogFile, "utf8"), /"type":"result"/, "the fresh log holds only this run");
  });
});

// The notes wiring from part 2/4: an authoring run with a note saves its note through the
// `tumwater-notes` command on PATH, so no `--mcp-config` reaches a Claude Code run and
// `--strict-mcp-config` (always in claude-args.ts) keeps every MCP server out. The notes path
// still rides the env beside the run marker.
test("an authoring run with notes carries the notes path but no MCP server", async () => {
  const dir = tmpdir();
  const envFile = path.join(dir, "notes-env.txt");
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], {
    extraScript: [`printf '%s\\n' "$TUMWATER_NOTES_PATH" >> "${envFile}"`],
  }, async (fake) => {
    const notes = path.join(dir, "state", "notes", "feature.md");
    const result = await runAgent(claudeRun(dir, { notesPath: notes }));
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const argv = readRunBlocks(fake.argvFile)[0]!.split("\n");
    assert.ok(!argv.includes("--mcp-config"), "an authoring run passes no MCP server");
    assert.ok(argv.includes("--strict-mcp-config"), "--strict-mcp-config stays, so no MCP server reaches the run");
    assert.equal(fs.readFileSync(envFile, "utf8").trim(), notes, "the notes path reaches the run");
  });
});

test("a claude run without a note passes no MCP config and no notes path", async () => {
  const dir = tmpdir();
  const envFile = path.join(dir, "notes-env.txt");
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], {
    extraScript: [`printf '[%s]' "$TUMWATER_NOTES_PATH" >> "${envFile}"`],
  }, async (fake) => {
    const result = await runAgent(claudeRun(dir));
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const argv = readRunBlocks(fake.argvFile)[0]!.split("\n");
    assert.ok(!argv.includes("--mcp-config"), "a run with no notes exposes no MCP server");
    assert.equal(fs.readFileSync(envFile, "utf8"), "[]", "and no TUMWATER_NOTES_PATH is set");
  });
});

test("a resumed claude run also carries no MCP server across --resume", async () => {
  const dir = tmpdir();
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], async (fake) => {
    const notes = path.join(dir, "notes.md");
    const run = claudeRun(dir, { notesPath: notes });
    assert.equal((await runAgent(run)).ok, true);
    const resumed = await runAgent({ ...run, continueSession: true, notesPath: notes });
    assert.equal(resumed.ok, true, `${resumed.errorMessage}`);
    const second = readRunBlocks(fake.argvFile)[1]!.split("\n");
    assert.ok(second.includes("--resume"), "the second run resumes");
    assert.ok(!second.includes("--mcp-config"), "no MCP server on the resume either");
  });
});

test("a claude run finds the notes shim dir first on its PATH", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const pathFile = path.join(dir, "path.txt");
  await withClaudeReplay([claudeResult({ totalCostUsd: 0 })], {
    extraScript: [`printf '%s\\n' "$PATH" >> "${pathFile}"`],
  }, async () => {
    const result = await runAgent(claudeRun(dir));
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const p = fs.readFileSync(pathFile, "utf8").trim();
    const binDir = path.join(dir, ".tumwater", "bin");
    assert.ok(
      p.startsWith(`${binDir}${path.delimiter}`),
      `the notes shim dir is first on PATH: ${p}`,
    );
  });
});
