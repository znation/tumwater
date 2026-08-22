import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { piArgs } from "../src/pi.js";
import { defaultConfig } from "../src/config.js";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { loadLoopState } from "../src/state.js";
import { assistantLine, fakePi, makeRepo, tmpdir } from "./util.js";

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
