import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { makeRepo, sh, writeConfig } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { cli } from "./helpers/cli-harness.js";

// `tumwater run`'s pre-boot guards, every one failing inside the CLI before any generation
// spawns: the detached-primary-checkout and already-running refusals, the --gui/--once and
// --role flag guards, the role-id validation, and the startup gate that is asked first. Each
// is a fast, deterministic child exit with nothing to reap. The running-fleet lifecycle and
// shutdown tests live in cli-run-shutdown.test.ts, the terminal-Ctrl+C handling in
// cli-run-sigint.test.ts, the forced second-Ctrl+C exit in cli-run-force-exit.test.ts, the
// --for/--gui live modes in cli-run-window.test.ts, and the scoped --once round in
// cli-run-once.test.ts.

test("run refuses a detached primary checkout", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run detached");
  sh(repo, "git", "checkout", "--detach");

  // pi must be on PATH to get past the earlier check; without the branch guard the
  // orchestrator would start with a null main branch.
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /primary checkout is detached/);
  });
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

test("run --gui --once fails before boot with the rival-shapes message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run gui once");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--gui", "--once");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--gui cannot be combined with --once/);
  });
});

test("run --tui --once fails before boot with the rival-shapes message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run tui once");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--tui", "--once");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--tui cannot be combined with --once/);
  });
});

// A TUI owns the terminal, so `run --tui` refuses before boot when this supervisor's stdin or
// stdout is not a TTY (piped, as under a script or this harness) — failing fast with the
// actionable tuiTerminalError instead of pointlessly booting a fleet and only then crashing on
// runTui's own guard. This guards suite runs the CLI with piped stdio, so the bare `--tui`
// shape lands on the guard, not on a real terminal.
test("run --tui fails before boot when the terminal is not interactive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run tui tty");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--tui");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /tumwater tui needs an interactive terminal/);
  });
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

  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--role is only valid with --once/,
      "daemon `run --role` stays an error: scoping is a once-round concept");
    // The guard fires before the supervisor spawns a generation: nothing started, nothing died.
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "no orchestrator marker was written");
    assert.equal(readEvents(repo).length, 0, "no events — the fleet never booted");
  });
});

test("run --once --role rejects an unknown id with the shared unknown-role wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role unknown");

  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--once", "--role", "no-such-loop");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: no-such-loop \(valid ids: /,
      "an unknown id fails fast with the one unknownRoleMessage wording");
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  });
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
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: clean \(valid ids: /,
      "a disabled id is not a role this round can run");
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  });
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
