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

// `tumwater start`'s pre-boot guards, every one failing inside the CLI before any generation
// spawns: the detached-primary-checkout and already-running refusals, the --gui/--once and
// --role flag guards, the role-id validation, and the startup gate that is asked first. Each
// is a fast, deterministic child exit with nothing to reap. The running-team lifecycle and
// shutdown tests live in cli-start-shutdown.test.ts, the terminal-Ctrl+C handling in
// cli-start-sigint.test.ts, the forced second-Ctrl+C exit in cli-start-force-exit.test.ts, the
// --for/--gui live modes in cli-start-window.test.ts, and the scoped --once round in
// cli-start-once.test.ts.

test("run refuses a detached primary checkout", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run detached");
  sh(repo, "git", "checkout", "--detach");

  // pi must be on PATH to get past the earlier check; without the branch guard the
  // orchestrator would start with a null main branch.
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /your checkout is detached/);
  });
});

test("run refuses to start while another orchestrator is alive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run guard");

  // Record a live pid (this test process) as the running orchestrator; two teams in one
  // repo would double-run every role and race on the merge lock.
  writeOrchestratorMarker(repo, []);

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /an orchestrator is already running/);
    // The message names the running pid and the fix (`tumwater stop` / Ctrl+C), so the
    // operator who just tried to start a second team does not have to go looking.
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

// `--port` names the `--gui` dashboard's port; alone it names no port for `run`, so it is
// refused before any boot (a valid value already passed the spec's shape gate — `run --port
// abc` fails earlier, in the dispatcher, with parsePortFlag's wording).
test("run --port without --gui fails before boot with the --port-requires--gui message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run port");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--port", "8123");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--port is only valid with --gui/);
  });
});

// --all-interfaces and --token are dashboard-only flags too: alone they name nothing `run`
// starts, so each is refused before any boot with the same shape as the --port guard above,
// naming the one-command form that makes it valid. (A valid --token value already passed the
// spec's shape gate in the dispatcher.)
test("run --all-interfaces without --gui fails before boot with the requires--gui message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run all-interfaces");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--all-interfaces");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--all-interfaces is only valid with --gui/);
  });
});

test("run --token without --gui fails before boot with the requires--gui message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run token");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--token", "s3cret");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--token is only valid with --gui/);
  });
});

// A malformed --token is refused before any boot, so a bad secret never leaves the team running
// behind a dashboard that exited: a flag-looking value (--token claims the next token even when
// it is a known flag) fails with tokenValueProblem's shared wording and writes no events, and a
// valueless trailing --token fails at the dispatcher's spec gate with TOKEN_VALUE_ERROR.
test("run --gui --token --all-interfaces fails before boot with the flag-looking-value message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run token flag-looking");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--gui", "--token", "--all-interfaces");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--token got the flag-looking value "--all-interfaces" instead of a secret/);
    assert.equal(readEvents(repo).length, 0, "no events — the run never booted");
  });
});

test("run --gui --token fails before boot with the spec's non-empty-secret message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run token valueless");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--gui", "--token");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--token requires a non-empty secret/);
  });
});

// A TUI owns the terminal, so `run --tui` refuses before boot when this supervisor's stdin or
// stdout is not a TTY (piped, as under a script or this harness) — failing fast with the
// actionable tuiTerminalError instead of pointlessly booting a team and only then crashing on
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

// A JSON document owns stdout, so --json refuses the two modes that paint their own banner
// there, before any boot — the same fail-fast rival-shapes wording as the --gui/--once pair.
test("run --for --json --gui fails before boot with the rival-shapes message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run for json gui");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--for", "1s", "--json", "--gui");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--json cannot be combined with --gui/);
    assert.equal(readEvents(repo).length, 0, "no events — the run never booted");
  });
});

test("run --for --json --tui fails before boot with the rival-shapes message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run for json tui");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--for", "1s", "--json", "--tui");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--json cannot be combined with --tui/);
    assert.equal(readEvents(repo).length, 0, "no events — the run never booted");
  });
});

// The `--role` guards of `run` (cmdStart): scoping is a once-round concept, the filter is
// validated against the ENABLED role ids, and the startup gate is asked before any of it.
// These were pinned only in the e2e tier (orchestrator-once.e2e.test.ts), which `npm test`
// does not run — so a regression here sailed through the gate the suite actually enforces.
// All four fail inside the supervisor parent before any generation spawns, so each run is a
// fast, deterministic child exit with nothing to reap.

test("run --role without --once fails with its own message before any team boots", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role guard");

  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--role is only valid with --once/,
      "daemon `run --role` stays an error: scoping is a once-round concept");
    // The guard fires before the supervisor spawns a generation: nothing started, nothing died.
    assert.ok(!fs.existsSync(orchestratorStatePath(repo)), "no orchestrator marker was written");
    assert.equal(readEvents(repo).length, 0, "no events — the team never booted");
  });
});

test("run --once --role rejects an unknown id with the shared unknown-role wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role unknown");

  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--once", "--role", "no-such-role");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: no-such-role \(valid ids: /,
      "an unknown id fails fast with the one unknownRoleMessage wording");
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  });
});

test("run --once --role names a disabled built-in as disabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role disabled");

  // A scoped round that booted a disabled role's runner would run nothing while claiming to
  // serve the operator who just queued that role a prompt — so a disabled id must fail here,
  // naming the role as disabled, not unknown.
  const cfg = defaultConfig();
  cfg.roles.clean!.enabled = false;
  writeConfig(repo, cfg);
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /clean is disabled, so a --once round cannot run it — enable it with `tumwater role clean --enable`/);
    assert.doesNotMatch(r.stderr, /unknown role/);
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  });
});

test("run --once --role rejects a list naming a disabled role before booting", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role list disabled");
  const cfg = defaultConfig();
  cfg.roles.readme!.enabled = false;
  writeConfig(repo, cfg);
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean,readme");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /readme is disabled/);
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

test("run --once --role keeps the unknown-role wording and hint for a typo", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run role typo");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--once", "--role", "cleen");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: cleen \(valid ids: /);
    assert.match(r.stderr, /did you mean `clean`/);
    assert.equal(readEvents(repo).length, 0, "no events — the round never started");
  });
});
