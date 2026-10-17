import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { pathReplace, writeScript } from "./fakes/fake-commands.js";
import { gitOnlyBinDir, makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { fakePi, fakePiIdle, withPi } from "./fakes/fake-pi.js";
import { cli, exitCode } from "./helpers/cli-harness.js";
import { onlyCleanRole, withRunningTeam } from "./helpers/run-live-harness.js";

// A running team's boot output and SIGTERM shutdown: the banner and roster, the
// supervisor_exit trace when a generation dies unasked, SIGTERM forwarded to the child, kill()'s
// whole-tree teardown, and the agentBin startup path. The pre-boot guards live in
// cli-run-guards.test.ts, the terminal-Ctrl+C handling in cli-run-sigint.test.ts, the forced
// second Ctrl+C in cli-run-force-exit.test.ts, the --for/--gui live modes in
// cli-run-window.test.ts, and the scoped --once round in cli-run-once.test.ts.

test("a generation that dies unasked leaves a supervisor_exit event: the team is never down without a trace", async () => {
  // BUGS.md 2026-09-23: a respawned child exited "not initialized" and events.jsonl simply ended.
  // Here the child dies at startup on something outside the startup gate (every role disabled —
  // the orchestrator's own refusal), so the supervisor passes the gate, spawns, and must record
  // the death itself; the gate re-asked afterwards passes, so the event carries no guessed reason.
  const repo = makeRepo();
  await initProject(repo, "cli run team down");
  const cfg = defaultConfig();
  for (const role of Object.values(cfg.roles)) role.enabled = false;
  writeConfig(repo, cfg);
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no roles enabled/);
    const down = eventsOfType(repo, "supervisor_exit");
    assert.equal(down.length, 1, `expected one supervisor_exit event:\n${JSON.stringify(readEvents(repo))}`);
    assert.equal(down[0]!.generation, 1);
    assert.equal(down[0]!.code, 1);
    assert.equal(down[0]!.reason, undefined, "the gate passes: no reason is invented");
  });
});

test("a team that goes down unasked runs the notify hook once", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run team down notify");
  const out = path.join(tmpdir("notify-team-down-"), "out.txt");
  const cfg = defaultConfig();
  for (const role of Object.values(cfg.roles)) role.enabled = false;
  cfg.notify = `echo "$TUMWATER_EVENT_TYPE|$TUMWATER_EVENT_SOURCE" >> ${out}`;
  writeConfig(repo, cfg);
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    const lines = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter((l) => l !== "") : []);
    const deadline = Date.now() + 10_000;
    while (lines().length < 1 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(lines(), ["supervisor_exit|tumwater"]);
  });
});

test("run starts the team, prints its banner, and stops cleanly on SIGTERM", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run lifecycle");

  onlyCleanRole(repo);
  await withRunningTeam(repo, fakePi("exit 0"), async (s) => {
    assert.match(s.out(), /roles: clean/);

    // The top-level process is the supervisor (src/process/supervisor.ts), not the orchestrator:
    // the event stream names the orchestrator's own pid, which must be a different process.
    const m = /tumwater started \(pid (\d+)/.exec(s.out());
    assert.ok(m, `expected an "tumwater started (pid …)" event:\n${s.out()}`);
    assert.notEqual(Number(m[1]), s.child.pid, "the orchestrator must run as the supervisor's child");

    // SIGTERM reaches only the supervisor from a plain kill; it forwards it to the child,
    // which takes the graceful stop path (announce, abort in-flight ticks), and the
    // supervisor exits with the child's code.
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.match(s.out(), /stopping — finishing current runs/);

    // Graceful shutdown removed the info file: a stale marker would make every later
    // `tumwater run` refuse to start.
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  });
});

test("run's banner lists one loop per instance, so the CLI roster matches the runners (part 5b/7)", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run instances banner");
  onlyCleanRole(repo, (cfg) => {
    cfg.roles.feature = { ...(cfg.roles.feature ?? { enabled: true }), enabled: true, instances: 2 };
  });
  await withRunningTeam(repo, fakePiIdle(), async (s) => {
    // Startup's `enabled` must be `loopIds`, not `enabledRoleIds`: the roster the banner names
    // is the roster the orchestrator starts runners for.
    assert.match(s.out(), /roles: [^\n]*feature, feature-2/);
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

  await withRunningTeam(repo, fakePi("exit 0"), async (s) => {
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
// absolute path, the team starts and ticks normally. The lifecycle mirrors the SIGTERM test
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
  await withRunningTeam(repo, pathReplace(binDir), async (s) => {
    s.child.kill("SIGTERM");
    const code = await exitCode(s.child);
    assert.equal(code, 0, `expected clean exit after SIGTERM; output so far:\n${s.out()}`);
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "orchestrator info file removed");
  });
});
