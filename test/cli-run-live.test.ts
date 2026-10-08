import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { readEvents } from "../src/events/event-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { eventsOfType, writeOrchestratorMarker } from "./log-fixtures.js";
import { pathReplace, writeScript } from "./fakes/fake-commands.js";
import { gitOnlyBinDir, makeRepo, sh, tmpdir, writeConfig } from "./repo-fixtures.js";
import { fakePi, fakePiIdle } from "./fakes/fake-pi.js";
import { loadLoopState } from "../src/loop/loop-state.js";
import { fastConfig } from "./orchestrator-fixtures.js";
import { cli, exitCode, spawnCli } from "./helpers/cli-harness.js";
import { sleep, waitForFile } from "./helpers/wait.js";

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
    // The message names the running pid and the fix (`tumwater stop` / Ctrl+C), so the
    // operator who just tried to start a second fleet does not have to go looking.
    assert.match(r.stderr, new RegExp(`pid ${process.pid}`));
    assert.match(r.stderr, /tumwater stop/);
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

/** Write the config every full-run lifecycle test shares: only the clean role enabled. One
 * enabled role keeps the startup burst small; a no-op pi ends every tick as no_change so
 * nothing is committed while the test observes the harness. `mutate` adjusts the config
 * before it is written (the agentBin test sets the agent binary there). */
function onlyCleanRole(repo: string, mutate?: (cfg: TumwaterConfig) => void): void {
  const cfg = defaultConfig();
  for (const [id, role] of Object.entries(cfg.roles)) if (id !== "clean") role.enabled = false;
  mutate?.(cfg);
  writeConfig(repo, cfg);
}

/** `run --gui`'s default dashboard port. The live test skips when it is already taken, because
 * a second binder would fail to bind and prove nothing about `run --gui`. */
const DASHBOARD_PORT = 7180;

/** True when nothing is listening on `port` on loopback — the live test can then let `run --gui`
 * bind it and can confirm it is free again after teardown. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** One GET of a dashboard path, resolved once the body is fully read; a connection error or a
 * stalled response rejects so the caller fails instead of hanging. */
function getDashboardBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 5_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("dashboard request timed out")));
  });
}

/** Poll `GET /` until the dashboard answers or the deadline passes, so a boot that printed its
 * banner but has not bound yet does not fail the test on the first try. */
async function waitForDashboard(port: number, ms = 30_000): Promise<string> {
  const deadline = performance.now() + ms;
  for (;;) {
    try {
      return await getDashboardBody(port, "/");
    } catch {
      if (performance.now() > deadline) throw new Error(`dashboard on port ${port} never answered`);
      await sleep(200);
    }
  }
}

/** Poll until `port` is bindable again, or the deadline passes. */
async function waitForPortFree(port: number, ms = 15_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() <= deadline) {
    if (await portFree(port)) return true;
    await sleep(200);
  }
  return false;
}

/** The shape every spawned `run` lifecycle test shares: start the fleet against `restore`'s
 * environment (fakePi, pathReplace), wait for the banner + orchestrator-started event, run
 * the body, then always kill() the whole tree and undo the environment — in that order, so a
 * thrown assertion still reaps the generation its pipes are holding (BUGS.md 2026-09-30). */
async function withRunningFleet(
  repo: string,
  restore: () => void,
  body: (s: ReturnType<typeof spawnCli>) => Promise<void>,
): Promise<void> {
  const s = spawnCli(repo, ["run"]);
  try {
    await s.waitFor(
      (out) => out.includes("tumwater running on branch main") && out.includes("orchestrator started (pid"),
      "the run banner and orchestrator event",
    );
    await body(s);
  } finally {
    s.kill();
    restore();
  }
}

test("run starts the fleet, prints its banner, and stops cleanly on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run lifecycle");

  onlyCleanRole(repo);
  await withRunningFleet(repo, fakePi("exit 0"), async (s) => {
    assert.match(s.out(), /loops: clean/);

    // The top-level process is the supervisor (src/process/supervisor.ts), not the orchestrator:
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
  });
});

// BUGS.md 2026-09-30: kill() is the cleanup every spawnCli test's finally relies on, including
// after a failed assertion that never reached the test's own SIGTERM step. It used to SIGKILL
// the supervisor alone, leaving the stdio-inherited orchestrator generation alive with the
// test's pipes — the file never exited and a `node … | tail` tool call hung the tick. The
// generation's death is what closes the pipes, so stdout reaching EOF after kill() alone is
// the observable that the whole tree is gone.
test("kill() alone tears down the whole run tree: the pipes close, nothing is orphaned", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run kill teardown");
  onlyCleanRole(repo);

  await withRunningFleet(repo, fakePi("exit 0"), async (s) => {
    // No SIGTERM here — kill() is the only stop, the exact shape of a finally after a failed
    // assertion. The supervisor gets SIGTERM and forwards it (graceful stop); anything still
    // alive after the grace gets the process-group SIGKILL. Either way the generation dies
    // and the pipes close.
    s.kill();
    const eof = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`stdout never closed — a generation still holds the pipes; output:\n${s.out()}`)),
        15_000,
      );
      s.child.stdout?.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    const code = await exitCode(s.child);
    await eof;
    assert.equal(code, 0, `expected a clean supervisor exit; output so far:\n${s.out()}`);
  });
});

// Criterion 1 of plans/portability.md §5/7: with pi absent from PATH but agentBin set to an
// absolute path, the fleet starts and ticks normally. The lifecycle mirrors the SIGTERM test
// above, but PATH holds only git — the agent binary comes from tumwater.json alone.
test("run starts and ticks with agentBin when pi is absent from PATH", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run agentBin lifecycle");

  // A bin dir with git (the repo checks and every git call need it) and the agent stub —
  // and no pi anywhere on PATH.
  const binDir = gitOnlyBinDir();
  const stub = path.join(binDir, "agent-stub");
  writeScript(stub, "exit 0");
  onlyCleanRole(repo, (cfg) => (cfg.agentBin = stub));

  // spawnCli copies process.env, so the child sees this PATH.
  await withRunningFleet(repo, pathReplace(binDir), async (s) => {
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  });
});

// Ctrl+C from a terminal reaches BOTH processes (same foreground group), so the supervisor's
// SIGINT handler only marks stopping — it must not forward or abort, or a plain `kill -INT`
// of the supervisor would tear down a fleet whose orchestrator never saw the signal. Teardown
// stays SIGTERM-only; this pins that split end to end (the SIGTERM half above covers the rest).
test("run survives a SIGINT aimed at the supervisor alone and still stops on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run sigint");

  onlyCleanRole(repo);
  await withRunningFleet(repo, fakePi("exit 0"), async (s) => {
    // SIGINT to the supervisor alone: it marks stopping but must not touch the child.
    s.child.kill("SIGINT");
    await sleep(3000); // past a poll cycle; a forwarding regression would be done by now
    assert.equal(s.child.exitCode, null, "the supervisor must keep running after a SIGINT aimed at it alone");
    assert.ok(
      fs.existsSync(orchestratorStatePath(repo)),
      `SIGINT to the supervisor must not tear down the fleet; output so far:\n${s.out()}`,
    );
    const info = readJson(orchestratorStatePath(repo)) as { pid: number };
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
  });
});

// `run --for <duration>`: the windowed run boots the daemon-shaped fleet, stops itself at the
// deadline through the same graceful stop a Ctrl+C runs, prints the deadline line and the
// summary, and exits 0 — no operator signal needed.
test("run --for boots, stops itself at the deadline, and prints the summary", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run for window");

  onlyCleanRole(repo);
  const restore = fakePi("exit 0");
  const s = spawnCli(repo, ["run", "--for", "3s"]);
  try {
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit at the deadline; output so far:\n${s.out()}`);
    assert.match(s.out(), /tumwater running on branch main · for 3s ·/);
    assert.match(s.out(), /deadline reached — stopping/);
    assert.match(s.out(), /stopping — waiting for in-flight ticks/);
    assert.match(s.out(), /once: \d+ ticks?/);
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
    // A deadline stop the run asked for is not the fleet dying: no supervisor_exit trace.
    assert.equal(eventsOfType(repo, "supervisor_exit").length, 0,
      `a deadline stop must not be recorded as a fleet death:\n${JSON.stringify(readEvents(repo))}`);
  } finally {
    s.kill();
    restore();
  }
});

// `run --gui`: one command boots the fleet and serves the browser dashboard (the `tumwater gui`
// server on its defaults) from the supervisor, so the dashboard outlives orchestrator
// generations and dies with the fleet. This is the only test that exercises the wiring end to
// end, so it skips cleanly (t.skip, not an early return that would read as a pass) when port 7180
// is already taken by another dashboard.
test("run --gui serves the dashboard from the supervisor and frees the port on SIGTERM", async (t) => {
  if (!(await portFree(DASHBOARD_PORT))) {
    t.skip(`port ${DASHBOARD_PORT} is already in use; skipping the live run --gui test`);
    return;
  }
  const repo = makeRepo();
  await initProject(repo, "cli run gui");
  onlyCleanRole(repo);
  const restore = fakePi("exit 0");
  const s = spawnCli(repo, ["run", "--gui"]);
  try {
    await s.waitFor(
      (out) =>
        out.includes("tumwater running on branch main") &&
        out.includes(`tumwater gui at http://127.0.0.1:${DASHBOARD_PORT}`),
      "the run banner and the dashboard banner",
    );
    const body = await waitForDashboard(DASHBOARD_PORT);
    assert.match(body, /tumwater/i, `GET / serves the tumwater page; body starts: ${body.slice(0, 120)}`);

    // SIGTERM reaches the supervisor alone; it forwards to the orchestrator generation and
    // aborts the dashboard, and both must be gone when the supervisor exits.
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected a clean supervisor exit after SIGTERM; output so far:\n${s.out()}`);
    assert.ok(
      await waitForPortFree(DASHBOARD_PORT),
      `the dashboard port must be free after the supervisor exits; output so far:\n${s.out()}`,
    );
  } finally {
    s.kill();
    restore();
  }
});

test("run --gui --once fails before boot with the rival-shapes message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run gui once");
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--gui", "--once");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--gui cannot be combined with --once/);
  } finally {
    restore();
  }
});

// Ctrl+C from a terminal also reaches the orchestrator generation itself (same foreground
// group): cmdRun's own SIGINT handler must stop the fleet gracefully — announce, abort
// in-flight ticks — and hand both processes a clean exit, and a SECOND Ctrl+C must force the
// generation out at once (exit 130) instead of waiting on a teardown that is not progressing.
// Neither half was pinned: the supervisor-only SIGINT test above deliberately never signals
// the child, and SIGTERM only covers the graceful half of the child's handling.
test("a SIGINT reaching the orchestrator generation stops the fleet cleanly", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run child sigint");

  onlyCleanRole(repo);
  await withRunningFleet(repo, fakePi("exit 0"), async (s) => {
    const info = readJson(orchestratorStatePath(repo)) as { pid: number };

    // SIGINT straight to the orchestrator generation: the graceful stop path (announce, abort).
    process.kill(info.pid, "SIGINT");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after the generation's SIGINT; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — waiting for in-flight ticks/,
      "the generation announces the graceful stop");
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
    // A stop the operator asked for is not the fleet dying: no supervisor_exit trace.
    assert.equal(eventsOfType(repo, "supervisor_exit").length, 0,
      `a clean Ctrl+C must not be recorded as a fleet death:\n${JSON.stringify(readEvents(repo))}`);
  });
});

test("a second Ctrl+C forces the orchestrator generation out at once", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run double sigint");

  onlyCleanRole(repo);
  // The graceful stop must still be pending when the second Ctrl+C lands: with an instant pi
  // nothing is in flight, the first stop finishes before the second, and the second kill hits
  // a gone pid (ESRCH, CI 2026-10-01). This pi ignores the abort's SIGTERM, and the detached
  // `sleep` it leaves behind holds pi's stdout pipe open, so terminateChild's 10 s SIGKILL can
  // reap pi without ending the in-flight tick — the graceful stop stays pending until the
  // second Ctrl+C forces the exit (BUGS.md 2026-10-07). Waiting for the first stop's
  // announcement alone still raced that 10 s grace against a loaded host's scheduling; the
  // pipe holder removes the race. The forced exit skips the teardown, so the test reaps pi's
  // group and the holder itself.
  const scratch = tmpdir("double-sigint-");
  const started = path.join(scratch, "pi-pid");
  const holder = path.join(scratch, "holder-pid");
  // `env: {}` is deliberate: the holder must not carry TUMWATER_RUN, or runPi's exit sweep
  // would kill it and release the pipe again. `stdio: ["ignore", 1, 2]` inherits pi's stdout
  // pipe; `detached: true` puts the holder in its own group, out of reach of pi's group sweep.
  const hold =
    `const{spawn}=require("child_process"),fs=require("fs");` +
    `const c=spawn("sleep",["120"],{detached:true,stdio:["ignore",1,2],env:{}});` +
    `fs.writeFileSync(${JSON.stringify(holder)},String(c.pid));c.unref();`;
  const reap = (file: string): void => {
    try {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (pid > 0) process.kill(-pid, "SIGKILL"); // Never kill(-0): that is this test's own group.
    } catch {
      // Not written yet or already gone.
    }
  };
  try {
    await withRunningFleet(
      repo,
      fakePi(`trap '' TERM; echo $$ > '${started}'; ${JSON.stringify(process.execPath)} -e '${hold}'; sleep 300`),
      async (s) => {
        const info = readJson(orchestratorStatePath(repo)) as { pid: number };
        await waitForFile(started);
        await waitForFile(holder);
        s.child.once("exit", () => {
          reap(started);
          reap(holder);
        });

        // The first Ctrl+C starts the graceful stop; the second must not queue behind it —
        // the operator pressed it to force the issue, so the generation exits 130 at once.
        // The second waits for the first handler's announcement, not a fixed gap: signals do
        // not queue, so two SIGINTs sent before a loaded generation is scheduled coalesce into
        // one and the run takes the graceful path (the `expected the forced exit code` flakes,
        // BUGS.md 2026-09-30).
        process.kill(info.pid, "SIGINT");
        await s.waitFor((out) => out.includes("stopping — waiting for in-flight ticks"), "the first Ctrl+C's stop");
        // Wait out terminateChild's SIGTERM → SIGKILL grace: the moment a loaded host's
        // scheduling used to let the old test's graceful stop finish under it. The holder
        // keeps the tick pending past pi's death, so the second Ctrl+C still finds the stop in
        // flight. A bounded wait keeps a wedged harness from hanging the test.
        const piPid = Number(fs.readFileSync(started, "utf8"));
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try {
            process.kill(piPid, 0);
          } catch {
            break; // pi was SIGKILLed and reaped: the grace has elapsed.
          }
          await sleep(50);
        }
        // A beat past pi's death: without the holder the stop settles here and the generation
        // is gone before the second Ctrl+C; the holder keeps it in flight for the signal.
        await sleep(250);
        process.kill(info.pid, "SIGINT");
        const code = await exitCode(s.child);
        assert.equal(code, 130, `expected the forced exit code; output so far:\n${s.out()}`);
        // The generation died unasked (a forced exit, not a clean stop): the supervisor records
        // the death and hands the operator the child's code back.
        const down = eventsOfType(repo, "supervisor_exit");
        assert.equal(down.length, 1, `expected one supervisor_exit event:\n${JSON.stringify(readEvents(repo))}`);
        assert.equal(down[0]?.code, 130);
      },
    );
  } finally {
    reap(started);
    reap(holder);
  }
});

// The `--role` guards of `run` (cmdRun): scoping is a once-round concept, the filter is
// validated against the ENABLED role ids, and the startup gate is asked before any of it.
// These were pinned only in the e2e tier (orchestrator-once.e2e.test.ts), which `npm test`
// does not run — so a regression here sailed through the gate the suite actually enforces.
// All four fail inside the supervisor parent before any generation spawns, so each run is a
// fast, deterministic child exit with nothing to reap.

test("run --role without --once fails with its own message before any fleet boots", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role guard");

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--role is only valid with --once/,
      "daemon `run --role` stays an error: scoping is a once-round concept");
    // The guard fires before the supervisor spawns a generation: nothing started, nothing died.
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "no orchestrator marker was written");
    assert.equal(readEvents(repo).length, 0, "no events — the fleet never booted");
  } finally {
    restore();
  }
});

test("run --once --role rejects an unknown id with the shared unknown-role wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role unknown");

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--once", "--role", "no-such-loop");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: no-such-loop \(valid ids: /,
      "an unknown id fails fast with the one unknownRoleMessage wording");
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  } finally {
    restore();
  }
});

test("run --once --role validates against enabled ids: a disabled built-in reads as unknown", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role disabled");

  // A scoped round that booted a disabled role's runner would run nothing while claiming to
  // serve the operator who just queued that loop a prompt — so a disabled id must fail here,
  // with the same wording as a wholly unknown id (the catalog is not the target list).
  const cfg = defaultConfig();
  cfg.roles.clean!.enabled = false;
  writeConfig(repo, cfg);
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: clean \(valid ids: /,
      "a disabled id is not a role this round can run");
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  } finally {
    restore();
  }
});

test("the startup gate is asked before the --role guards: a not-ready repo reports the gate", async () => {
  // A git repo with commits but no tumwater.json: if the --role guard ran first, stderr would
  // say "--role is only valid with --once"; the gate running first must name the real problem.
  const repo = makeRepo();

  const r = await cli(repo, "run", "--role", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not initialized/, "the gate's verdict, not the flag's");
  assert.equal(readEvents(repo).length, 0, "no events — nothing booted to trace");
});

test("run --once --role ticks only the scoped role through the real CLI and exits 0", async () => {
  // The scoped round's happy path. Until now only the e2e tier pinned a successful --once
  // round (orchestrator-once.e2e.test.ts), so the gating suite never ran one: the wiring this
  // exercises — the startup gate, the role filter into runOrchestrator, the once banner, the
  // summary, and the exit — could regress with `npm test` staying green.
  const repo = makeRepo();
  await initProject(repo, "cli run once scoped");
  writeConfig(repo, fastConfig(["clean", "dry"]));

  // fakePiIdle ends every tick as nothing-to-do, so the round exits on its own without
  // landing anything — the round's own exit is the observable, not a merge.
  const restore = fakePiIdle();
  try {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /tumwater once on branch main/, `the once banner: ${r.stdout}`);
    assert.match(r.stdout, /loops: clean\n/, `the banner names only the scoped role: ${r.stdout}`);
    assert.match(r.stdout, /once: 1 tick — 1 no_change/,
      `the summary counts only the scoped role's tick: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\bdry\b/, `the unscoped role must be invisible: ${r.stdout}`);
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "the scoped role ticked exactly once");
    assert.equal(loadLoopState(repo, "dry").ticks, 0, "the unscoped role never ran");
  } finally {
    restore();
  }
});
