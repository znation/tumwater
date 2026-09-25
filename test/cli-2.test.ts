import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { loadLoopState } from "../src/state.js";
import { orchestratorStatePath, resetRequestPath } from "../src/paths.js";
import { lanAddresses } from "../src/ui/gui.js";
import {
  cli,
  cliWithEnv,
  exitCode,
  fakePi,
  makeRepo,
  seedCounters,
  sh,
  spawnCli,
  tmpdir,
  writeScript,
} from "./util.js";

// Second half of the CLI tests (see cli.test.ts for the split): gui, argument validation,
// status --json, tui, doctor, report, and run's lifecycle. The CLI runs main() on import and
// reports failures via process.exit, so it is tested as a child process through the spawn
// helpers in util.ts.

async function freeTcpPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("gui --port validates its range instead of listening on an unexpected port", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui validation");

  // Port 0 would listen on an ephemeral port while printing http://127.0.0.1:0.
  for (const bad of ["0", "-1", "99999", "abc"]) {
    const r = await cli(repo, "gui", "--port", bad);
    assert.equal(r.code, 1, `--port ${bad} should fail`);
    assert.match(r.stderr, /--port must be an integer between 1 and 65535/);
  }

  const noValue = await cli(repo, "gui", "--port");
  assert.equal(noValue.code, 1);
  assert.match(noValue.stderr, /--port needs a value/);

  // --all-interfaces is part of gui's vocabulary: with it present, a bad port still fails
  // on the port (not as an unknown argument).
  const withAll = await cli(repo, "gui", "--all-interfaces", "--port", "abc");
  assert.equal(withAll.code, 1);
  assert.match(withAll.stderr, /--port must be an integer/);
});

test("gui starts, prints its banner, and --all-interfaces names the LAN exposure", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui serve");

  // Default binding: the banner names localhost only, with no all-interfaces warning.
  const localPort = await freeTcpPort();
  const local = spawnCli(repo, ["gui", "--port", String(localPort)]);
  try {
    await local.waitFor((b) => b.includes(`tumwater gui at http://127.0.0.1:${localPort}`), "the gui banner", 30_000);
    assert.ok(!local.out().includes("ALL interfaces"), "default bind does not claim all interfaces");
  } finally {
    local.kill();
  }

  // --all-interfaces: the concrete LAN URLs and the no-auth warning join the banner.
  const lanPort = await freeTcpPort();
  const lan = spawnCli(repo, ["gui", "--port", String(lanPort), "--all-interfaces"]);
  try {
    await lan.waitFor((b) => b.includes("listening on ALL interfaces"), "the all-interfaces warning", 30_000);
    for (const addr of lanAddresses())
      assert.ok(
        lan.out().includes(`also at http://${addr}:${lanPort}`),
        `names the LAN address ${addr}`,
      );
  } finally {
    lan.kill();
  }
});

test("gui reports a friendly error when the port is already in use", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui busy port");

  // Occupy an ephemeral port so the CLI hits EADDRINUSE deterministically; without the
  // catch it printed Node's raw "listen EADDRINUSE: address already in use …" with no hint.
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const addr = blocker.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const r = await cli(repo, "gui", "--port", String(addr.port));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in use/);
    assert.match(r.stderr, /tumwater gui --port <n>/);
  } finally {
    blocker.close();
  }
});

test("gui --token demands a non-empty secret instead of serving unauthenticated", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui token validation");

  // A valueless --token is the same mistake as an empty one: an operator who asked for
  // protection must get a CLI error, never a server with no auth (this test also bounds a
  // regression that started serving — the spawn helper's timeout kills it and the exit
  // code / stderr assertions fail).
  const valueless = await cli(repo, "gui", "--token");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /--token requires a non-empty secret/);

  const empty = await cli(repo, "gui", "--token", "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /--token requires a non-empty secret/);
});

test("gui --token serves behind the gate and prints the token-bearing URL", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli gui token serve");

  const port = await freeTcpPort();
  const gui = spawnCli(repo, ["gui", "--port", String(port), "--token", "s3cret"]);
  try {
    // The banner URL carries the token: an operator pasting the printed link must land
    // inside the gate, not on a bare 401 with no hint of what is missing.
    await gui.waitFor(
      (b) => b.includes(`tumwater gui at http://127.0.0.1:${port}/?token=s3cret`),
      "the token-bearing banner",
      30_000,
    );
    // The gate is live from the first response: without the token, even the page is 401.
    const bare = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(bare.status, 401);
    assert.deepEqual(await bare.json(), { error: "token required" });
  } finally {
    gui.kill();
  }
});

test("commands reject unknown arguments instead of silently ignoring them", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli strict args");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  // A misspelled --role used to be ignored: reset-counters would zero EVERY loop instead of
  // the one named. Now it fails and leaves every counter (and no fleet marker) untouched.
  let r = await cli(repo, "reset-counters", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  assert.match(r.stderr, /--role <id>/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "no reset happened");
  assert.ok(!fs.existsSync(resetRequestPath(repo)), "no marker written");

  // A misspelled --port used to be ignored: gui would serve on the default port.
  r = await cli(repo, "gui", "--portt", "8080");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --portt/);

  // A doubled short flag used to be ignored: logs would run one-shot instead of following.
  r = await cli(repo, "logs", "-ff");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: -ff/);

  // `run` takes exactly one flag (--branch); anything else is rejected and names it.
  r = await cli(repo, "run", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --verbose/);
  assert.match(r.stderr, /valid flags for tumwater run: --branch <name>/);

  // ...including version and help, which used to accept anything silently: `version --json`
  // printed a version as if it had answered the query, and `help extra` printed usage.
  r = await cli(repo, "version", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);

  r = await cli(repo, "help", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--role", "clean");
  assert.equal(r.code, 0);
});

// --- status --json: machine-readable fleet state — the same document GET /api/status
// serves, printed with no server. The CLI runs as a child process, so the deep-equal below
// compares its parsed stdout against statusPayload(root) computed in this process for the
// same root; both read only from disk and nothing mutates the temp repo between the reads.

test("status --json prints the /api/status payload; bare status keeps the table", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli status json");
  seedCounters(repo, "feature");

  let r = await cli(repo, "status", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as Record<string, unknown>;
  // Top-level fields — the same document GET /api/status serves for this root. `pid` is
  // absent while no harness runs (undefined does not survive JSON.stringify).
  for (const field of ["running", "inbox", "inboxPrompts", "budget", "loops", "events", "plans", "bugs", "questions"]) {
    assert.ok(field in doc, `top-level ${field} present`);
  }
  assert.equal(doc.running, false, "no harness running");
  assert.ok(!("pid" in doc), "no pid while the harness is not running");

  // Per-loop fields on every row.
  const loops = doc.loops as Array<Record<string, unknown>>;
  assert.ok(loops.length > 0);
  for (const l of loops) {
    for (const field of ["role", "phase", "ticks", "commits", "generated", "peakCtx", "costUsd", "todayUsd", "lastResult", "lastSummary", "lastTickEndedAt"]) {
      assert.ok(field in l, `loop field ${field} present`);
    }
  }
  // Seeded counters surface verbatim — the JSON is state-file data, not a re-rendering.
  const feature = loops.find((l) => l.role === "feature");
  assert.ok(feature, "feature loop row present");
  assert.equal(feature!.ticks, 7);
  assert.equal(feature!.commits, 3);
  assert.equal(feature!.generated, 424242);
  assert.equal(feature!.costUsd, 1.5);

  // Deep-equal against the same root's payload in this process — one definition of fleet
  // state as JSON (status-payload.statusPayload) feeds both surfaces, so they cannot drift.
  // Both sides
  // go through a JSON round-trip: that is exactly what the endpoint and the flag emit.
  assert.deepEqual(doc, JSON.parse(JSON.stringify(statusPayload(repo))));

  // Bare status still renders the table — same command, human surface unchanged.
  r = await cli(repo, "status");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /loop/);
  assert.match(r.stdout, /last result/);
  assert.match(r.stdout, /feature/);

  // A misspelled flag is rejected like every other unknown argument.
  r = await cli(repo, "status", "--jsonn");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --jsonn/);
});

// --- tui: main()'s tui case (arg rejection → readiness gate → runTui) had no end-to-end
// test — every other command is driven through the CLI, but only runTui itself was tested
// in-process. A spawned child has no TTY, so the happy path ends in a clean error and the
// whole wiring is observable without a terminal.

test("tui gates on repo readiness, rejects extra args, and fails cleanly without a terminal", async () => {
  // Not a git repo: the readiness gate fires before any TUI work — a regression that dropped
  // requireReadyRepo here would crash deep in snapshot() instead of naming the fix.
  let r = await cli(tmpdir(), "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);

  const repo = makeRepo();
  await initProject(repo, "cli tui test");

  // A ready repo: runTui's TTY requirement surfaces as a clean CLI error (exit 1) and the
  // command exits rather than hanging — which also bounds this test if that ever regresses.
  r = await cli(repo, "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs an interactive terminal/);

  // Like every other no-flag command, tui rejects stray arguments instead of ignoring them.
  r = await cli(repo, "tui", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);
});

// --- doctor: pre-flight check through the real CLI entry point ---
// runDoctor/renderDoctor and each individual check are pinned in-process in
// test/doctor.test.ts; what is missing here is main()'s wiring — that doctor runs WITHOUT a
// readiness gate (it must report why the environment isn't ready, not refuse like status),
// renders the full report to stdout, rejects unknown arguments, and honors the exit-code
// contract that makes it scriptable: 0 when no check fails, 1 otherwise. Warnings never fail.

test("doctor runs outside a git repo — reports every problem instead of gating", async () => {
  // A bare directory with a PATH holding only git (no pi): every check's outcome is
  // deterministic, and the command must not refuse to run like status does. Without the
  // missing-gate regression this would print "not a git repository" to stderr and exit 1
  // without ever showing the other checks.
  const binDir = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));

  const r = await cliWithEnv(tmpdir(), { PATH: binDir }, ["doctor"]);
  assert.equal(r.code, 1, `expected exit 1 with failing checks:\n${r.stdout}\n${r.stderr}`);
  // The full report is printed — one line per check in fixed order, not the first error.
  assert.match(r.stdout, /tumwater doctor — harness not running/);
  assert.match(r.stdout, /ok\s+git binary/);
  assert.match(r.stdout, /fail\s+repo\s+not a git repository/);
  assert.match(r.stdout, /fail\s+init\s+not initialized/);
  assert.match(r.stdout, /fail\s+pi binary\s+pi not found on PATH/);
  assert.match(r.stdout, /ok\s+state dir/);
  assert.match(r.stdout, /ok\s+merge lock/);
  assert.match(r.stdout, /warn\s+project check/);
  // No ps on this PATH either: the orphan scan degrades to a warn instead of crashing doctor.
  assert.match(r.stdout, /warn\s+orphans\s+could not scan the process table/);
  // The verdict counts the fails (repo + init + pi) and nothing else.
  assert.match(r.stdout, /3 problems/);
});

test("doctor exits 0 on a ready repo; a stale merge lock warns without failing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor test");

  // A stale merge lock (dead pid) is a warning: it self-heals on the next merge, so it must
  // not flip the exit code — scripts key off 0/1 for real problems only.
  const lockDir = path.join(repo, ".tumwater", "merge.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "pid"), String(2_000_000_000)); // beyond any pid space

  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "doctor");
    assert.equal(r.code, 0, `expected exit 0 on a ready repo:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /tumwater doctor — harness not running/);
    for (const line of [
      /ok\s+git binary/,
      /ok\s+repo\s+repo at \S+ — on branch main/,
      /ok\s+init/,
      /ok\s+pi binary/,
      /ok\s+state dir/,
      /warn\s+merge lock\s+stale — will be broken on next merge/,
      /warn\s+project check/,
      // The real process-table scan: a fresh repo has no worktree, so no orphan either.
      /ok\s+orphans\s+none/,
    ]) {
      assert.match(r.stdout, line);
    }
    assert.match(r.stdout, /ready to run/);
  } finally {
    restore();
  }
});

test("doctor rejects unknown arguments", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor args");

  // Like every other no-flag command, doctor takes no arguments at all.
  const r = await cli(repo, "doctor", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);
});

// --- report: usage report through the real CLI entry point ---
// collectReport/renderReportMarkdown are pinned in-process in test/report.test.ts; what is
// missing here is main()'s wiring — that report runs WITHOUT a readiness gate (it degrades to
// zeros in any directory) and that --days shares /api/report's window bound: above it the
// command fails fast with the offending value instead of building an unbounded series.

test("report prints a zero-filled window outside a repo and honors --days", async () => {
  // No readiness gate: in a bare directory every source degrades to zeros, so the report
  // still renders (an all-zero default window).
  const r = await cli(tmpdir(), "report");
  assert.equal(r.code, 0, `expected exit 0 in any directory:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# tumwater usage report$/m);
  assert.match(r.stdout, /\(14 days\)/);

  const r2 = await cli(tmpdir(), "report", "--days", "3");
  assert.equal(r2.code, 0, `expected exit 0 with --days 3:\n${r2.stdout}\n${r2.stderr}`);
  assert.match(r2.stdout, /\(3 days\)/);
});

test("report --days above the shared bound fails fast with the offending value", async () => {
  const r = await cli(tmpdir(), "report", "--days", "91");
  assert.equal(r.code, 1, `expected exit 1 for --days 91:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /--days must be between 1 and 90 \(got "91"\)/);

  // The bound itself is allowed — the GUI clamps to it, so the CLI accepts exactly that.
  const ok = await cli(tmpdir(), "report", "--days", "90");
  assert.equal(ok.code, 0, `expected exit 0 at the bound:\n${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /\(90 days\)/);
});

// --- long-running commands (run): spawned with a live handle so the test can
// observe startup output and always reap the child. ---

// --- run: startup guards, banner, and graceful shutdown ---

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
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: [] }),
  );

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
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no roles enabled/);
    const down = readEvents(repo).filter((e) => e.type === "supervisor_exit");
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
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));

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
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));

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
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(cfg));

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

// --- gui: non-EADDRINUSE listen errors pass through the top-level handler ---

test("gui passes a permission error through with the raw message", async () => {
  // Privileged ports need root; as an unprivileged user this deterministically yields
  // EACCES, which the CLI must not swallow into the port-in-use hint. Skipped under root,
  // where port 80 would bind and serve forever.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const repo = makeRepo();
  await initProject(repo, "cli gui eacces");

  const r = await cli(repo, "gui", "--port", "80");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EACCES/);
});

test("gui --all-interfaces prints the reachable LAN URLs and serves until killed", async () => {
  // The success path of `tumwater gui` (banner, LAN URL lines, exposure warning) is only
  // reachable with a live child: startGui resolves once listening, then the CLI prints and
  // blocks. README documents that --all-interfaces "prints the LAN URLs it is reachable at";
  // lanAddresses' filter semantics are pinned in test/gui.test.ts (this e2e covers the
  // printing wiring against whatever interfaces this machine actually has).
  const repo = makeRepo();
  await initProject(repo, "cli gui all interfaces");

  // Claim a free port: bind an ephemeral listener, take its number, release it.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  // The URLs the CLI should print: every non-loopback IPv4 address of this machine —
  // computed here (the same filter lanAddresses applies) so the test checks the printed
  // lines against reality instead of a hardcoded IP. Empty on machines without one.
  const expected = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === "IPv4" && !a.internal))
    .map((a) => a.address);

  const s = spawnCli(repo, ["gui", "--port", String(port), "--all-interfaces"]);
  try {
    // Wait for the LAST of the three synchronous startup writes (banner → URL lines →
    // warning), so every line is present before asserting.
    await s.waitFor(
      (out) => out.includes(`tumwater gui at http://127.0.0.1:${port}`) && out.includes("listening on ALL interfaces"),
      "the gui banner and exposure warning",
    );

    // The no-auth exposure warning is printed whenever --all-interfaces is used.
    assert.match(s.out(), /listening on ALL interfaces — no auth; anyone reaching it can prompt the director/);

    // Every non-loopback IPv4 address gets exactly one URL line, and nothing else does:
    // a regression that also printed loopback or IPv6 would add extra lines (the count
    // check catches it), and dropping an interface would miss its line.
    for (const addr of expected) {
      assert.ok(s.out().includes(`also at http://${addr}:${port}`), `missing URL for ${addr}:\n${s.out()}`);
    }
    const alsoLines = s.out().split("\n").filter((l) => l.includes("also at http://"));
    assert.equal(alsoLines.length, expected.length, `exactly one line per LAN address:\n${s.out()}`);

    // The server is actually up and serving the dashboard (binding every interface
    // includes loopback).
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /<title>tumwater<\/title>/);
  } finally {
    s.kill();
  }
});
