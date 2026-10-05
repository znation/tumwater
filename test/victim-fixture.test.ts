import { sleep } from "./wait.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { pidAlive } from "../src/process.js";
import { tmpdir } from "./repo-fixtures.js";
import { armVictimKill, exitWithOwnerEnv, ownerAliveSh } from "./victim-fixture.js";

// The owner watch (exit-with-owner.ts) that the victim fixtures and every other long-lived
// test child ride on. A child started under exitWithOwnerEnv must leave once its owner dies,
// however it died — and so must the node processes that child starts in turn, the shape of a
// `run` supervisor's generation or a dashboard's re-exec'd child, which a test never spawns
// itself (the 2026-10-05 leak scan found `cli.js run`, `gui` and `logs -f` children of killed
// test processes alive at PPID 1, along with idle stand-ins and fake-script wait loops).

test("a child under exitWithOwnerEnv and the node grandchild it starts both exit once their owner is SIGKILLed", async (t) => {
  const dir = tmpdir();
  const pidsFile = path.join(dir, "pids");
  // The owner is a stand-in test process (the host). It spawns the child through the helper;
  // the child starts a detached grandchild with a plain inherited environment, the way the
  // CLI's own children are started; both idle until killed.
  const fixture = new URL("./victim-fixture.js", import.meta.url).href;
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });",
    "g.unref();",
    "require('node:fs').writeFileSync(process.argv[1], `${process.pid} ${g.pid}`);",
    "setInterval(() => {}, 1 << 30);",
  ].join("\n");
  const hostScript = [
    `const { exitWithOwnerEnv } = await import(${JSON.stringify(fixture)});`,
    `const { spawn } = await import("node:child_process");`,
    `spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}, process.argv[1]], { stdio: "ignore", env: exitWithOwnerEnv() });`,
    "setInterval(() => {}, 1 << 30);",
  ].join("\n");
  // The host is owned by this process in turn, so a failure here cannot strand it either.
  const host = spawn(process.execPath, ["--input-type=module", "-e", hostScript, pidsFile], {
    stdio: "ignore",
    env: exitWithOwnerEnv(),
  });
  armVictimKill(t, host);
  const readPids = (): number[] => {
    try {
      return fs.readFileSync(pidsFile, "utf8").trim().split(" ").map(Number).filter((n) => n > 0);
    } catch {
      return [];
    }
  };
  const upDeadline = Date.now() + 10_000;
  while (readPids().length < 2 && Date.now() < upDeadline) await sleep(25);
  const pids = readPids();
  assert.equal(pids.length, 2, "the child recorded its own pid and its grandchild's");
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone — the expected outcome.
      }
    }
  });
  assert.ok(pids.every(pidAlive), "both idle while their owner lives");
  process.kill(host.pid as number, "SIGKILL");
  const goneDeadline = Date.now() + 10_000;
  while (pids.some(pidAlive) && Date.now() < goneDeadline) await sleep(50);
  assert.deepEqual(pids.filter(pidAlive), [], "the child and its grandchild followed their killed owner out");
});

test("exitWithOwnerEnv appends the preload once and names the owner", () => {
  const once = exitWithOwnerEnv({ NODE_OPTIONS: "--max-old-space-size=4096" }, 4242);
  assert.equal(once.TUMWATER_TEST_OWNER_PID, "4242");
  assert.match(once.NODE_OPTIONS ?? "", /^--max-old-space-size=4096 --import=file:\/\/\S+\/exit-with-owner\.js$/);
  const twice = exitWithOwnerEnv(once, 777);
  assert.equal(twice.NODE_OPTIONS, once.NODE_OPTIONS, "an inherited preload is not added again");
  assert.equal(twice.TUMWATER_TEST_OWNER_PID, "777", "the nearer owner wins");
  assert.match(exitWithOwnerEnv({}).NODE_OPTIONS ?? "", /^--import=file:/, "no inherited NODE_OPTIONS means just the preload");
});

test("ownerAliveSh holds for a live owner and fails for a gone one", async () => {
  assert.equal(spawnSync("sh", ["-c", ownerAliveSh()]).status, 0, "this process is alive");
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  assert.notEqual(spawnSync("sh", ["-c", ownerAliveSh(gone.pid as number)]).status, 0, "a reaped child is gone");
});
