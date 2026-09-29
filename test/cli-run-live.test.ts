import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { orchestratorStatePath } from "../src/paths.js";
import { eventsOfType, writeOrchestratorMarker } from "./log-fixtures.js";
import { writeScript } from "./fake-commands.js";
import { makeRepo, sh, tmpdir, writeConfig } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { cli, exitCode, spawnCli } from "./cli-harness.js";

// `tumwater run` through the real CLI entry point: startup guards, the banner, and the
// supervisor's shutdown semantics. These are the long-running commands, spawned with a live
// handle so the test can observe startup output and always reap the child. cli-run.test.ts
// pins the onceSummary unit seam; orchestrator-once.e2e.test.ts pins one full round.

test("run refuses a detached primary checkout", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run detached");
  sh(repo, "git", "checkout", "--detach");

  // pi must be on PATH to get past the earlier check; without the branch guard the
  // orchestrator would start with a null main branch.
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /primary checkout is detached/);
  } finally {
    restore();
  }
});

test("run refuses to start while another orchestrator is alive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run guard");

  // Record a live pid (this test process) as the running orchestrator; two fleets in one
  // repo would double-tick every loop and race on the merge lock.
  writeOrchestratorMarker(repo, []);

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /an orchestrator is already running/);
  } finally {
    fs.rmSync(orchestratorStatePath(repo), { force: true });
    restore();
  }
});

test("a generation that dies unasked leaves a supervisor_exit event: the fleet is never down without a trace", async () => {
  // BUGS.md 2026-09-23: a respawned child exited "not initialized" and events.jsonl simply ended.
  // Here the child dies at startup on something outside the startup gate (every role disabled —
  // the orchestrator's own refusal), so the supervisor passes the gate, spawns, and must record
  // the death itself; the gate re-asked afterwards passes, so the event carries no guessed reason.
  const repo = makeRepo();
  await initProject(repo, "cli run fleet down");
  const cfg = defaultConfig();
  for (const role of Object.values(cfg.roles)) role.enabled = false;
  writeConfig(repo, cfg);
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no roles enabled/);
    const down = eventsOfType(repo, "supervisor_exit");
    assert.equal(down.length, 1, `expected one supervisor_exit event:\n${JSON.stringify(readEvents(repo))}`);
    assert.equal(down[0]!.generation, 1);
    assert.equal(down[0]!.code, 1);
    assert.equal(down[0]!.reason, undefined, "the gate passes: no reason is invented");
  } finally {
    restore();
  }
});

test("run starts the fleet, prints its banner, and stops cleanly on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run lifecycle");

  // One enabled role keeps the startup burst small; a no-op pi ends every tick as
  // no_change so nothing is committed while we observe the harness itself.
  const cfg = defaultConfig();
  for (const [id, role] of Object.entries(cfg.roles)) if (id !== "clean") role.enabled = false;
  writeConfig(repo, cfg);

  const restore = fakePi("exit 0");
  const s = spawnCli(repo, ["run"]);
  try {
    await s.waitFor(
      (out) => out.includes("tumwater running on branch main") && out.includes("orchestrator started (pid"),
      "the run banner and orchestrator event",
    );
    assert.match(s.out(), /loops: clean/);

    // The top-level process is the supervisor (src/supervisor.ts), not the orchestrator:
    // the event stream names the orchestrator's own pid, which must be a different process.
    const m = s.out().match(/orchestrator started \(pid (\d+)/);
    assert.ok(m, `expected an "orchestrator started (pid …)" event:\n${s.out()}`);
    assert.notEqual(Number(m[1]), s.child.pid, "the orchestrator must run as the supervisor's child");

    // SIGTERM reaches only the supervisor from a plain kill; it forwards it to the child,
    // which takes the graceful stop path (announce, abort in-flight ticks), and the
    // supervisor exits with the child's code.
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — waiting for in-flight ticks/);

    // Graceful shutdown removed the info file: a stale marker would make every later
    // `tumwater run` refuse to start.
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  } finally {
    s.kill();
    restore();
  }
});

// Criterion 1 of plans/portability.md §5/7: with pi absent from PATH but agentBin set to an
// absolute path, the fleet starts and ticks normally. The lifecycle mirrors the SIGTERM test
// above, but PATH holds only git — the agent binary comes from tumwater.json alone.
test("run starts and ticks with agentBin when pi is absent from PATH", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run agentBin lifecycle");

  // One enabled role keeps the startup burst small; a no-op pi ends every tick as no_change.
  const cfg = defaultConfig();
  for (const [id, role] of Object.entries(cfg.roles)) if (id !== "clean") role.enabled = false;

  // A bin dir with git (the repo checks and every git call need it) and the agent stub —
  // and no pi anywhere on PATH.
  const binDir = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));
  const stub = path.join(binDir, "agent-stub");
  writeScript(stub, "exit 0");
  cfg.agentBin = stub;
  writeConfig(repo, cfg);

  const oldPath = process.env.PATH;
  process.env.PATH = binDir; // spawnCli copies process.env, so the child sees this PATH
  const s = spawnCli(repo, ["run"]);
  try {
    await s.waitFor(
      (out) => out.includes("tumwater running on branch main") && out.includes("orchestrator started (pid"),
      "the run banner and orchestrator event",
    );
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  } finally {
    s.kill();
    process.env.PATH = oldPath;
  }
});

// Ctrl+C from a terminal reaches BOTH processes (same foreground group), so the supervisor's
// SIGINT handler only marks stopping — it must not forward or abort, or a plain `kill -INT`
// of the supervisor would tear down a fleet whose orchestrator never saw the signal. Teardown
// stays SIGTERM-only; this pins that split end to end (the SIGTERM half above covers the rest).
test("run survives a SIGINT aimed at the supervisor alone and still stops on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run sigint");

  // One enabled role keeps the startup burst small; a no-op pi ends every tick as no_change.
  const cfg = defaultConfig();
  for (const [id, role] of Object.entries(cfg.roles)) if (id !== "clean") role.enabled = false;
  writeConfig(repo, cfg);

  const restore = fakePi("exit 0");
  const s = spawnCli(repo, ["run"]);
  try {
    await s.waitFor(
      (out) => out.includes("tumwater running on branch main") && out.includes("orchestrator started (pid"),
      "the run banner and orchestrator event",
    );

    // SIGINT to the supervisor alone: it marks stopping but must not touch the child.
    s.child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 3000)); // past a poll cycle; a forwarding regression would be done by now
    assert.equal(s.child.exitCode, null, "the supervisor must keep running after a SIGINT aimed at it alone");
    assert.ok(
      fs.existsSync(orchestratorStatePath(repo)),
      `SIGINT to the supervisor must not tear down the fleet; output so far:\n${s.out()}`,
    );
    const info = JSON.parse(fs.readFileSync(orchestratorStatePath(repo), "utf8")) as { pid: number };
    let alive = true;
    try {
      process.kill(info.pid, 0);
    } catch {
      alive = false; // ESRCH: the orchestrator died — it never received a signal.
    }
    assert.ok(alive, `orchestrator pid ${info.pid} died after a supervisor-only SIGINT`);

    // SIGTERM still tears everything down cleanly (forwarded to the child).
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — waiting for in-flight ticks/);
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  } finally {
    s.kill();
    restore();
  }
});
