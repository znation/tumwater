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
      `printf '%s\n' '${assistantLine("AUTOMATON_NOTHING_TO_DO")}'`,
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
