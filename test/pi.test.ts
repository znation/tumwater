import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PiStreamParser, findOnPath, piArgs, runPi } from "../src/pi.js";
import { configForRole, defaultConfig, loadConfig } from "../src/config.js";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { loadLoopState } from "../src/state.js";
import { assistantLine, errorLine, fakePi, makeRepo, thinkingOnlyLine, tmpdir } from "./util.js";

test("findOnPath locates executables like spawn would resolve them", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  assert.equal(findOnPath("pi", dir), bin);

  // A directory named like the binary is not a match (spawn would fail on it too).
  const dirs = tmpdir();
  fs.mkdirSync(path.join(dirs, "pi"));
  assert.equal(findOnPath("pi", dirs), null);

  // Non-executable files are skipped; empty PATH segments are ignored.
  const noexec = tmpdir();
  const plain = path.join(noexec, "pi");
  fs.writeFileSync(plain, "#!/bin/sh\n");
  fs.chmodSync(plain, 0o644);
  assert.equal(findOnPath("pi", `${noexec}::${dir}`), bin);

  // Missing binary or empty PATH.
  assert.equal(findOnPath("definitely-missing-xyz", dir), null);
  assert.equal(findOnPath("pi", ""), null);
});

test("parser keeps the last non-empty assistant text and sums usage", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it", { tokens: 100, output: 40, cost: 0.01 }) + "\n");
  parser.feed(assistantLine("final answer\nSUMMARY: do it", { tokens: 50, output: 10, cost: 0.02 }) + "\n");
  assert.equal(parser.finalText, "final answer\nSUMMARY: do it");
  assert.equal(parser.outputTokens, 50, "output sums across turns");
  assert.equal(parser.peakContextTokens, 100, "peak is the largest request context, not a sum");
  assert.ok(Math.abs(parser.costUsd - 0.03) < 1e-9);
  assert.equal(parser.stopReason, "stop");
});

test("parser keeps a sentinel declared in an intermediate message (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("TUMWATER_NOTHING_TO_DO", { tokens: 10 }) + "\n");
  parser.feed(assistantLine("all done", { tokens: 5 }) + "\n");
  assert.equal(parser.finalText, "all done", "finalText stays the last message");
  assert.ok(parser.declaredNothingToDo, "sentinel from an earlier turn is not lost");
});

test("parser does not flag nothing-to-do when no message carries the sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it") + "\n");
  parser.feed(assistantLine("all done\nSUMMARY: x") + "\n");
  assert.equal(parser.declaredNothingToDo, false);
});

test("parser flags a contentless final message (generation cut off mid-stream)", () => {
  // A thinking-only LAST message is the cut-off signature (observed live: pi clamped
  // max_output_tokens to 16 near the declared context window and LM Studio reported the
  // truncation as a normal stop).
  const parser = new PiStreamParser();
  parser.feed(assistantLine("reading files") + "\n");
  parser.feed(thinkingOnlyLine("git.ts looks clean. Next let's check gui.ts (16:3", { output: 16 }) + "\n");
  assert.ok(parser.finalMessageContentless, "thinking-only final message is contentless");
  assert.equal(parser.finalText, "reading files", "earlier text is retained for the summary");

  // Only the LAST message counts: a substantive message after a cut-off clears the flag.
  const recovered = new PiStreamParser();
  recovered.feed(thinkingOnlyLine("hmm") + "\n");
  recovered.feed(assistantLine("SUMMARY: fix it") + "\n");
  assert.equal(recovered.finalMessageContentless, false);

  // A tool call is substantive content even without a text block.
  const toolOnly = new PiStreamParser();
  toolOnly.feed(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash" }],
        stopReason: "toolUse",
      },
    }) + "\n",
  );
  assert.equal(toolOnly.finalMessageContentless, false);
});

test("parser records that pi auto-compacted the session", () => {
  const parser = new PiStreamParser();
  assert.equal(parser.compacted, false);
  parser.feed(JSON.stringify({ type: "compaction_start", reason: "threshold" }) + "\n");
  assert.ok(parser.compacted);
});

test("parser handles chunked lines and ignores noise", () => {
  const parser = new PiStreamParser();
  const line = assistantLine("hello", { tokens: 5 });
  parser.feed(line.slice(0, 20));
  parser.feed(line.slice(20) + "\nnot json\n" + JSON.stringify({ type: "turn_start" }) + "\n");
  assert.equal(parser.finalText, "hello");
  assert.equal(parser.peakContextTokens, 5);
});

test("parser records error messages and clears them after a later success", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
    }) + "\n",
  );
  assert.equal(parser.errorMessage, "Connection error.");
  assert.equal(parser.stopReason, "error");
  parser.feed(assistantLine("recovered") + "\n");
  assert.equal(parser.errorMessage, undefined);
  assert.equal(parser.stopReason, "stop");
});

test("parser flags the LM Studio predict-stream timeout as a transient server failure (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(
    errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.") + "\n",
  );
  assert.equal(parser.transientServerTimeout, true);
  assert.equal(parser.contextExceeded, false, "a timeout is not a context overflow");
  assert.equal(parser.stopReason, "error");
});

test("parser does not flag other errors as transient server timeouts", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine("Connection error.") + "\n");
  parser.feed(
    JSON.stringify({ type: "error", errorMessage: "request timed out after 30s" }) + "\n",
  );
  assert.equal(parser.transientServerTimeout, false);
});

test("parser ignores user message_end events", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    }) + "\n",
  );
  assert.equal(parser.finalText, "");
});

test("piArgs reflects config", () => {
  const config = defaultConfig();
  config.provider = "anthropic";
  config.model = "sonnet";
  config.thinking = "high";
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  assert.deepEqual(args.slice(0, 3), ["--print", "--mode", "json"]);
  for (const expected of ["--provider", "anthropic", "--model", "sonnet", "--thinking", "high", "--no-skills"]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
});

test("piArgs omits unset options", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(!args.includes("--provider"));
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--thinking"));
});

test("role overrides flow through to the pi argv and round-trip via config files", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ model: "cheap", roles: { bugfix: { enabled: true, model: "expensive", provider: "anthropic" } } }),
  );
  const config = loadConfig(dir);
  const args = piArgs({ config: configForRole(config, "bugfix"), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(args.includes("expensive"));
  assert.ok(args.includes("anthropic"));
  const cheap = piArgs({ config: configForRole(config, "clean"), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(cheap.includes("cheap"));
  assert.ok(!cheap.includes("anthropic"));
});

/** Run the fake pi through runPi with throwaway dirs and return the distilled result. */
async function runFakePi(script: string) {
  const dir = tmpdir();
  const restore = fakePi(script);
  try {
    return await runPi({
      cwd: dir,
      prompt: "p",
      config: defaultConfig(),
      sessionDir: path.join(dir, "sessions"),
      sessionName: "t",
      rawLogFile: path.join(dir, "raw.jsonl"),
    });
  } finally {
    restore();
  }
}

test("a non-zero pi exit with assistant text still counts as a successful run", async () => {
  // Documented lenient behavior (BUGS.md, spurious-warning fix, cause 4): pi can exit
  // non-zero after producing output; the work is real, so the tick must not be an error.
  const result = await runFakePi(
    [`printf '%s\n' '${assistantLine("done", { tokens: 10 })}'`, "exit 1"].join("\n"),
  );
  assert.equal(result.ok, true, "non-zero exit with assistant text is leniently ok");
  assert.equal(result.finalText, "done");
  assert.equal(result.timedOut, false);
});

test("a non-zero pi exit without assistant text is a failed run", async () => {
  // The other half of the same branch: no output means nothing landed, so it must stay an
  // error (the tick-level regression for this lives in test/loop.test.ts).
  const result = await runFakePi(`echo 'pi exploded' >&2\nexit 1`);
  assert.equal(result.ok, false);
  assert.match(result.errorMessage ?? "", /pi exploded|exited 1/);
});

// Session persistence: pi sessions survive across ticks and are dropped when poisoned.

test("piArgs starts fresh sessions with a name and resumes with --continue", () => {
  const base = { config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n1" };
  const fresh = piArgs(base);
  assert.ok(fresh.includes("-n"), "fresh runs are named");
  assert.ok(!fresh.includes("--continue"));
  const resumed = piArgs({ ...base, continueSession: true });
  assert.ok(resumed.includes("--continue"), "later ticks resume the role session");
  assert.ok(!resumed.includes("-n"), "resumed runs keep their existing name");
});

test("a loop's pi session persists across ticks", async () => {
  const repo = makeRepo();
  await initProject(repo, "session persistence test");
  const argsFile = path.join(tmpdir(), "argv.log");
  // The prompt argument spans many lines, so record only the flags, one run per line.
  const restore = fakePi(
    [
      `flags=""`,
      `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
      `echo "run:$flags" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    await runner.tick();
    await runner.tick();
    const runs = fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
    assert.equal(runs.length, 2);
    assert.ok(!runs[0]?.includes("--continue"), "first tick starts a fresh session");
    assert.ok(runs[0]?.includes("-n"), "first tick names its session");
    assert.ok(runs[1]?.includes("--continue"), "second tick resumes the session");
    assert.ok(!runs[1]?.includes("-n"));
    // Persisted, so a restarted orchestrator also resumes.
    assert.equal(loadLoopState(repo, "clean").hasSession, true);
  } finally {
    restore();
  }
});

test("parser flags context-exceeded errors surfaced in retry events", async () => {
  const { PiStreamParser } = await import("../src/pi.js");
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "auto_retry_start",
      attempt: 3,
      errorMessage:
        'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}',
    }) + "\n",
  );
  assert.equal(parser.contextExceeded, true);
  const clean = new PiStreamParser();
  clean.feed(JSON.stringify({ type: "auto_retry_start", errorMessage: "Connection error." }) + "\n");
  assert.equal(clean.contextExceeded, false);
});

test("a context-exceeded error drops the poisoned session immediately", async () => {
  const repo = makeRepo();
  await initProject(repo, "context overflow test");
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = fakePi(
    [
      `flags=""`,
      `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
      `echo "run:$flags" >> "${argsFile}"`,
      `printf '%s\n' '${JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Context size has been exceeded." })}'`,
      `exit 1`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    runner.state.hasSession = true; // Pretend earlier ticks built up a session.
    assert.equal((await runner.tick()).result, "error");
    assert.equal(runner.state.hasSession, false, "poisoned session dropped");
    await runner.tick();
    const runs = fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
    assert.ok(runs[1] && !runs[1].includes("--continue"), "next tick starts fresh");
  } finally {
    restore();
  }
});

test("two consecutive error ticks drop the session as self-healing", async () => {
  const repo = makeRepo();
  await initProject(repo, "consecutive error test");
  const restore = fakePi(`echo boom >&2\nexit 1`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    await runner.tick();
    assert.equal(runner.state.hasSession, true, "one error keeps the session");
    assert.equal(runner.state.consecutiveErrors, 1);
    await runner.tick();
    assert.equal(runner.state.hasSession, false, "second consecutive error drops it");
    assert.equal(runner.state.consecutiveErrors, 0);
  } finally {
    restore();
  }
});

test("a spawn failure does not mark a session as resumable", async () => {
  const repo = makeRepo();
  await initProject(repo, "spawn failure test");
  // A PATH with git but no pi, so only the pi spawn fails.
  const binDir = tmpdir();
  const { execSync } = await import("node:child_process");
  fs.symlinkSync(execSync("which git", { encoding: "utf8" }).trim(), path.join(binDir, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.ok(!runner.state.hasSession);
  } finally {
    process.env.PATH = oldPath;
  }
});
