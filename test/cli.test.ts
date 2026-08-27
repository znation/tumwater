import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { orchestratorStatePath, piLogPath, resetRequestPath } from "../src/paths.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process: the built dist/src/cli.js with cwd set to a temp repo.
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with an explicit env override (merged over process.env). The timeout
 * bounds tests that would otherwise hang if a command regresses to not exiting. */
function cliWithEnv(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  return cliWithEnv(cwd, {}, args);
}

test("help and no command print usage", async () => {
  const dir = tmpdir();
  for (const args of [[], ["help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /tumwater init/);
    assert.match(r.stdout, /tumwater prompt/);
  }
});

test("version prints the package version", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const r = await cli(tmpdir(), "version");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("unknown command fails with a hint", async () => {
  const r = await cli(tmpdir(), "frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("status refuses repos that are not ready", async () => {
  // Not a git repo.
  let r = await cli(tmpdir(), "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);

  // A git repo without tumwater.json.
  const bare = makeRepo();
  r = await cli(bare, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not initialized/);

  // tumwater.json present but no commits yet.
  const uncommitted = tmpdir();
  sh(uncommitted, "git", "init", "-b", "main");
  fs.writeFileSync(path.join(uncommitted, "tumwater.json"), JSON.stringify(defaultConfig()));
  r = await cli(uncommitted, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no commits yet/);
});

test("init creates the harness files and is idempotent", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /created README\.md/);
  for (const f of ["README.md", "PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(fs.existsSync(path.join(repo, f)), `${f} exists`);
  }
  r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already initialized; nothing to do/);
});

test("init --file reads the prompt from a file and rejects a missing path", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "prompt.md"), "Build a thing.\nWith care.\n");
  let r = await cli(repo, "init", "--file", "prompt.md");
  assert.equal(r.code, 0);
  assert.equal(readInitialPrompt(repo), "Build a thing.\nWith care.");

  const bare = makeRepo();
  r = await cli(bare, "init", "--file");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file needs a path/);
});

test("prompt queues for the director and logs an event; empty text fails", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt test");

  let r = await cli(repo, "prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prompt text required/);

  r = await cli(repo, "prompt", "add dark mode");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the director loop/);
  assert.equal(inboxSize(repo), 1);
  assert.equal(dequeuePrompt(repo), "add dark mode");

  // The queueing is visible in `logs`.
  r = await cli(repo, "logs", "-n", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /user prompt queued: add dark mode/);
});

test("logs -n validates its value instead of misbehaving", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs validation");

  // Unvalidated, these made readEvents' slice(-limit) dump the whole log (NaN/0)
  // or drop leading lines (negative).
  for (const bad of ["abc", "0", "-5", "2.5"]) {
    const r = await cli(repo, "logs", "-n", bad);
    assert.equal(r.code, 1, `-n ${bad} should fail`);
    assert.match(r.stderr, /-n needs a positive integer/);
  }

  // A bare -n used to silently fall back to the default of 50.
  const noValue = await cli(repo, "logs", "-n");
  assert.equal(noValue.code, 1);
  assert.match(noValue.stderr, /-n needs a value/);

  // A valid -n still works.
  const ok = await cli(repo, "logs", "-n", "3");
  assert.equal(ok.code, 0);
});

test("run fails fast with a clear message when pi is missing from PATH", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run validation");

  // A PATH that has git (so the repo checks pass) but no pi: without the startup check,
  // the orchestrator would start and every tick of every loop would die with
  // "failed to spawn pi: spawn pi ENOENT".
  const binDir = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));

  const r = await cliWithEnv(repo, { PATH: binDir }, ["run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pi not found on PATH/);
});

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

  // Commands with no flags reject any argument at all.
  for (const [cmd, extra] of [
    ["run", "--verbose"],
    ["status", "--json"],
  ] as const) {
    r = await cli(repo, cmd, extra);
    assert.equal(r.code, 1, `${cmd} ${extra}`);
    assert.match(r.stderr, /takes no arguments/);
  }

  // Stray non-flag tokens are rejected too.
  r = await cli(repo, "reset-counters", "--role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);
  assert.equal(loadLoopState(repo, "feature").ticks, 7, "no reset happened");

  // Valid combinations still work.
  r = await cli(repo, "logs", "-n", "3", "--role", "clean");
  assert.equal(r.code, 0);
});

// --- logs --role (per-role pi transcript) ---

test("logs --role validates the role id and reports a missing transcript", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli test");

  let r = await cli(repo, "logs", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);

  r = await cli(repo, "logs", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // A valid id whose loop never ran: friendly message, exit 0.
  r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no transcript yet for clean/);
});
// --- reset-counters ---

/** Seed a role's state file with non-zero counters plus scheduling fields. */
function seedCounters(repo: string, role: string): void {
  const s = freshLoopState(role);
  s.ticks = 7;
  s.commits = 3;
  s.generatedTokens = 424242;
  s.totalCostUsd = 1.5;
  s.peakContextTokens = 65536; // last tick's peak — cleared by the reset
  s.nextRunAt = Date.now() + 60_000;
  s.backoffSeconds = 15;
  s.lastMainHead = "deadbeef";
  saveLoopState(repo, s);
}

test("reset-counters zeroes counters in every role's state file and writes the fleet marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  const r = await cli(repo, "reset-counters");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for/);
  assert.match(r.stdout, /running fleet picks this up within ~2s/);

  for (const role of ["feature", "clean"]) {
    const s = loadLoopState(repo, role);
    assert.equal(s.ticks, 0, `${role} ticks`);
    assert.equal(s.commits, 0, `${role} commits`);
    assert.equal(s.generatedTokens, 0, `${role} tokens`);
    assert.equal(s.totalCostUsd, 0, `${role} cost`);
    // Scheduling and wake tracking are untouched.
    assert.ok(s.nextRunAt > Date.now(), `${role} keeps its sleep window`);
    assert.equal(s.backoffSeconds, 15, `${role} backoff preserved`);
    assert.equal(s.lastMainHead, "deadbeef", `${role} wake tracking preserved`);
    // Per-tick semantics: a fresh observation window clears the last tick's peak too,
    // or sleeping loops would keep showing their old value until they next tick.
    assert.equal(s.peakContextTokens, 0, `${role} per-tick peak ctx cleared`);
  }

  // The marker a running fleet consumes lists every role in the config.
  const marker = JSON.parse(fs.readFileSync(resetRequestPath(repo), "utf8")) as {
    at: number;
    roles: string[];
  };
  assert.ok(marker.at > 0);
  assert.deepEqual([...marker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());
});

test("reset-counters --role targets one loop; unknown or missing role fails without side effects", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters role test");
  seedCounters(repo, "feature");
  seedCounters(repo, "clean");

  let r = await cli(repo, "reset-counters", "--role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /counters reset for feature/);
  const f = loadLoopState(repo, "feature");
  assert.equal(f.ticks, 0);
  assert.equal(f.commits, 0);
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "other roles untouched");
  const marker = JSON.parse(fs.readFileSync(resetRequestPath(repo), "utf8")) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);

  // Unknown role: clear failure, no state changes, no marker.
  fs.rmSync(resetRequestPath(repo));
  r = await cli(repo, "reset-counters", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);
  assert.equal(loadLoopState(repo, "feature").ticks, 0, "already-reset role unchanged");
  assert.equal(loadLoopState(repo, "clean").ticks, 7, "other roles untouched on failure");
  assert.ok(!fs.existsSync(resetRequestPath(repo)), "no marker written on failure");

  // A bare --role fails cleanly too.
  r = await cli(repo, "reset-counters", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);
});

test("logs --role prints the rendered pi transcript and -n limits entries", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli render test");
  const TS1 = 1787222691956;
  const TS2 = TS1 + 3_600_000;
  const file = piLogPath(repo, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "x" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tick prompt one (must not appear)" }], timestamp: TS1 } }),
      JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: "streaming noise" } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "look at the files first" },
            { type: "text", text: "Reading PLANS.md." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/PLANS.md" } },
          ],
          stopReason: "stop",
        },
      }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tick prompt two (must not appear)" }], timestamp: TS2 } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second run done" }], stopReason: "stop" } }),
    ].join("\n") + "\n",
  );

  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  let r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0);
  // Both runs render in order: separator stamped from the user message, then the turn.
  assert.ok(r.stdout.includes(`── run @ ${stamp(TS1)} ──`), r.stdout);
  assert.ok(r.stdout.includes("· look at the files first"), r.stdout);
  assert.ok(r.stdout.includes("  Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("→ read PLANS.md"), r.stdout);
  assert.ok(r.stdout.includes(`── run @ ${stamp(TS2)} ──`), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
  // User prompts and streaming deltas never leak into the transcript.
  assert.ok(!r.stdout.includes("must not appear"));
  assert.ok(!r.stdout.includes("streaming noise"));

  // -n limits to the last N entries: only the second run's turn remains.
  r = await cli(repo, "logs", "--role", "clean", "-n", "1");
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
});

// --- long-running commands (run, logs -f): spawned with a live handle so the test can
// observe startup output, exercise the follow behavior, and always reap the child. ---

interface SpawnedCli {
  out: () => string;
  /** Resolves once `pred` matches the captured stdout; fails the test with the output on timeout. */
  waitFor(pred: (out: string) => boolean, what: string, ms?: number): Promise<void>;
  kill(): void;
}

function spawnCli(cwd: string, args: string[]): { child: ChildProcess } & SpawnedCli {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env });
  let buffer = "";
  child.stdout?.on("data", (d) => (buffer += d));
  return {
    child,
    out: () => buffer,
    waitFor(pred, what, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (pred(buffer)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > ms) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for ${what}; output so far:\n${buffer}`));
          }
        }, 100);
      });
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    },
  };
}

/** Wait for the child's exit code; null on timeout so a hung command fails the test instead of hanging it. */
function exitCode(child: ChildProcess, ms = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.once("close", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

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
    await s.waitFor((out) => out.includes("tumwater running on branch main"), "the run banner");
    assert.match(s.out(), /loops: clean/);

    // SIGTERM triggers the graceful stop path (not a kill): it announces, aborts the
    // orchestrator, and lets in-flight ticks finish before exiting 0.
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

// --- logs -f: the follow half of both log commands is only reachable with a live child ---

test("logs -f prints the current window and follows newly appended events", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs follow");

  // Seed one real event through the same path the TUI/GUI/CLI use.
  submitPrompt(repo, "first prompt");

  const s = spawnCli(repo, ["logs", "-f"]);
  try {
    await s.waitFor((out) => out.includes("user prompt queued: first prompt"), "the seeded event");

    // A new event appended while following must appear without a restart (500ms poll).
    submitPrompt(repo, "second prompt");
    await s.waitFor((out) => out.includes("user prompt queued: second prompt"), "the live event");
  } finally {
    s.kill();
  }
});

test("logs --role -f prints each turn exactly once across the initial window and follow", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli transcript follow");

  // One completed run on disk; a second is appended while following.
  const file = piLogPath(repo, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [JSON.stringify({ type: "session", version: 3, id: "x" }), assistantLine("first turn text")].join("\n") + "\n",
  );

  const s = spawnCli(repo, ["logs", "--role", "clean", "-f"]);
  try {
    await s.waitFor((out) => out.includes("first turn text"), "the initial window");

    fs.appendFileSync(file, assistantLine("second turn text") + "\n");
    await s.waitFor((out) => out.includes("second turn text"), "the live turn");

    // The follow renderer starts fresh at the window's end: a regression that re-fed the
    // initial lines would print the first turn twice.
    const out = s.out();
    assert.equal(out.split("first turn text").length - 1, 1, `first turn printed once:\n${out}`);
    assert.equal(out.split("second turn text").length - 1, 1, `second turn printed once:\n${out}`);
  } finally {
    s.kill();
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
