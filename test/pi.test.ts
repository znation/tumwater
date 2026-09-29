import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRANSIENT_PI_CRASH,
  commandBuffersOutput,
  piArgs,
  runPi,
  type PiRunOptions,
} from "../src/pi.js";
import { NO_LAUNCH_SERVICES_CHECK_IN, signalTree, withoutLaunchServicesCheckIn } from "../src/process.js";
import { toolUpdateHasContent } from "../src/pi-event-line.js";
import type { PiRunResult } from "../src/pi.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { configForRole } from "../src/config-views.js";
import { initProject } from "../src/init.js";
import { pidAlive } from "../src/process.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { gitOnlyBinDir, makeRepo, tmpdir } from "./repo-fixtures.js";
import { fakePi, logFlagsTo } from "./fake-pi.js";
import { waitForLogLines, watchdogClock } from "./wait.js";
import { assistantLine } from "./pi-events.js";

// The quiet watchdog's kill is reported as quietKilled, not timedOut: a hung tool call leaves
// its session and worktree edits intact, so the loop resumes them instead of discarding hours
// of work for the next tick's reset (BUGS.md 2026-09-12).
//
// The watchdog tests below run it on logical time (watchdogClock): each waits until the raw
// log shows the fake pi's output — so the parser has counted it — then advances the clock
// past the window it pins. Their windows used to be real seconds, widened after every
// loaded-machine flake (BUGS.md 2026-09-18, 2026-09-21); on logical time the ordering they
// assert is exact, and crossing a window costs nothing.

test("a stalled run is reported as quiet-killed, not timed out", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // the watchdog checks every second and kills after ~2 s of silence
  const clock = watchdogClock(t);
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const opts = runPiFixture(dir, { config });
    const run = runPi(opts);
    await waitForLogLines(opts.rawLogFile, "tool_execution_start");
    clock.advance(10_000); // silence well past the 2 s window
    const result = await run;
    assert.equal(result.ok, false);
    assert.equal(result.quietKilled, true, "the watchdog kill is reported as quiet-killed");
    assert.equal(result.timedOut, false, "a hung tool call is not a tick timeout");
    assert.match(result.errorMessage ?? "", /killed as hung/);
  } finally {
    restore();
  }
});

// BUGS.md 2026-09-23: under full-suite load a run's first output could land past the quiet
// window measured from runPi's start — the OS had not yet scheduled the process, so the
// watchdog killed a run that never had the chance to speak. The doubled window that fix
// granted a zero-progress run still false-killed under merge-check load: the kill check can
// fire before the child's first bytes exist at all (fork/exec starved by the same load, or
// bytes written but not yet drained — a firing timer phase precedes the poll phase that
// delivers stdout). The fix gave a byte-silent run no quiet kill at all; BUGS.md 2026-09-29
// replaced that unbounded exemption (which delegated its bound to tickTimeoutSeconds, and
// the live 54000 s config left a wedged run 15 hours in a slot) with a finite zero-byte
// bound of max(two quiet windows, 30 min). This pins that ordinary startup latency — a
// minute of byte-silence, far past the old single and doubled windows — still does not
// kill a run; the 30-minute bound is tested separately below.
test("a run that is slow to speak is not quiet-killed during startup", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 5; // old single window killed a silent run at the ~7.5 s check
  const go = path.join(dir, "go");
  const clock = watchdogClock(t);
  const restore = fakePi(
    [
      `while [ ! -f '${go}' ]; do sleep 0.02; done`, // byte-silent until the test says go
      `printf '%s\n' '${assistantLine("done\nSUMMARY: spoke late")}'`,
    ].join("\n"),
  );
  try {
    const run = runPi(runPiFixture(dir, { config }));
    // A minute of silence before the first byte: past the old single window (5 s) and the
    // doubled startup window (10 s) alike, and well under the 30-minute zero-byte bound.
    clock.advance(60_000);
    fs.writeFileSync(go, "");
    const result = await run;
    assert.equal(result.quietKilled, false, "startup latency is not a hung tool call");
    assert.equal(result.ok, true, "the run completes once pi finally speaks");
  } finally {
    restore();
  }
});

// BUGS.md 2026-09-29: the 2026-09-23 zero-byte exemption was unbounded — a run that never
// emits a byte was bounded only by tickTimeoutSeconds, which operators raise for unrelated
// reasons (the live config's 54000 s left a wedged model connection 15 hours in a
// concurrency slot). The zero-byte bound is now max(two quiet windows, 30 min), independent
// of the tick timeout. This pins that a byte-silent run is reaped by the quiet watchdog —
// reported quietKilled, so the loop resumes it — with a tick timeout set far beyond the
// bound; under the old exemption this run never settles short of the real 2 h timeout.
test("a run that never emits a byte is quiet-killed at 30 minutes regardless of the tick timeout", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // zero-byte bound = max(2 × 2 s, 30 min) = 30 min
  config.tickTimeoutSeconds = 7200; // far beyond the zero-byte bound: it must not be the reaper
  const clock = watchdogClock(t);
  const restore = fakePi(
    // exec so SIGTERM reaches the sleeper directly and the run ends promptly; the script
    // writes nothing, so sawOutput stays false for the whole run.
    `exec sleep 30`,
  );
  try {
    const run = runPi(runPiFixture(dir, { config }));
    clock.advance(31 * 60_000); // one minute past the 30-minute zero-byte bound
    const result = await run;
    assert.equal(result.quietKilled, true, "a byte-silent run is reaped by the quiet watchdog");
    assert.equal(result.timedOut, false, "the tick timeout is not the zero-byte bound");
    assert.match(result.errorMessage ?? "", /killed as hung/);
  } finally {
    restore();
  }
});

// Open-tool-call tracking feeds the stall warning (BUGS.md 2026-09-13 sibling): a hung
// command must be nameable while it is still open, and content-free updates must not mask
// its silence the way they cannot reset the quiet watchdog.

// Criterion 3 of plans/portability.md §5/7: a wrapper script at agentBin (export an env
// var, exec the real pi) produces byte-identical tick behavior. PATH holds no pi here, so
// passing at all proves the spawn went through agentBin.
test("runPi spawns the configured agentBin — a wrapper script behaves like the real pi", async () => {
  const dir = tmpdir();
  const realDir = path.join(dir, "real");
  const wrapDir = path.join(dir, "wrap");
  fs.mkdirSync(realDir, { recursive: true });
  fs.mkdirSync(wrapDir, { recursive: true });
  const realBin = path.join(realDir, "pi-real");
  // The stub renders its env into the reply text, so the test can see the wrapper ran.
  // The stub renders its env into the reply text: the env value is a printf ARGUMENT
  // substituted into the JSON's text field, so no external tools are needed (PATH is empty).
  const jsonTemplate = assistantLine("wrapped:RANVAL").replace("RANVAL", "%s");
  fs.writeFileSync(realBin, `#!/bin/sh\nprintf '${jsonTemplate}\\n' "$AGENT_WRAPPER_RAN"\n`);
  fs.chmodSync(realBin, 0o755);
  const wrapper = path.join(wrapDir, "pi-wrapper");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport AGENT_WRAPPER_RAN=1\nexec "${realBin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const config = defaultConfig();
  config.agentBin = wrapper;
  const oldPath = process.env.PATH;
  process.env.PATH = ""; // no pi anywhere on PATH — only agentBin can resolve
  try {
    const result = await runPi(runPiFixture(dir, { config }));
    assert.equal(result.ok, true, `expected the wrapper-run pi to succeed: ${result.errorMessage}`);
    assert.match(result.finalText, /wrapped:1/, "the wrapper exported its env var before exec");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runPi starts pi with the LaunchServices preload in NODE_OPTIONS on macOS, so neither pi nor its tool calls check in", async () => {
  // BUGS.md 2026-09-28: pi sets its process title at startup and every npm a tool call runs sets
  // one too; on macOS each would leak a launchservicesd port. The fake renders its NODE_OPTIONS
  // into the reply text — the preload has no double quotes or backslashes, so the JSON holds.
  const template = assistantLine("opts:RANVAL").replace("RANVAL", "%s");
  const result = await runFakePi(`printf '${template}\\n' "$NODE_OPTIONS"`);
  assert.equal(result.ok, true, `expected the fake pi to succeed: ${result.errorMessage}`);
  assert.equal(result.finalText, `opts:${withoutLaunchServicesCheckIn(process.env).NODE_OPTIONS ?? ""}`);
  if (process.platform === "darwin") assert.ok(result.finalText.includes(NO_LAUNCH_SERVICES_CHECK_IN), result.finalText);
});

test("runPi's spawn-error message names the resolved binary and its source", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.agentBin = "/no/such/dir-xyz/pi-here";
  const result = await runPi(runPiFixture(dir, { config }));
  assert.equal(result.ok, false);
  assert.match(result.errorMessage ?? "", /failed to spawn \/no\/such\/dir-xyz\/pi-here/);
  assert.match(result.errorMessage ?? "", /resolved from agentBin in tumwater\.json/);
});

test("a stalled call without toolName warns with the bare command named", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  // The warning (2 s) lands before the kill (5 s of silence): exact on logical time, where a
  // real-time 1s gap lost that ordering to jitter under concurrent suites (BUGS.md 2026-09-18).
  config.quietTimeoutSeconds = 5;
  config.toolCallStallSeconds = 2;
  const warnings: string[] = [];
  const clock = watchdogClock(t);
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", args: { command: "sleep 999" } })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const opts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
    const run = runPi(opts);
    await waitForLogLines(opts.rawLogFile, "tool_execution_start");
    clock.advance(30_000); // past the stall threshold, then past the quiet window
    const result = await run;
    assert.equal(result.quietKilled, true, "the run still ends via the quiet watchdog");
    assert.match(
      warnings[0] ?? "",
      /^tool call stalled: sleep 999 — no output for \d+[sm]/,
      "the warning names the bare command even though pi omitted toolName",
    );
  } finally {
    restore();
  }
});

test("toolUpdateHasContent sees real text, not empty or content-less updates", () => {
  assert.equal(toolUpdateHasContent({ content: [{ type: "text", text: "out" }] }), true);
  assert.equal(toolUpdateHasContent({ content: [] }), false, "bash's post-start update is empty");
  assert.equal(toolUpdateHasContent({ content: [{ type: "text", text: "   " }] }), false, "whitespace-only is not output");
  assert.equal(toolUpdateHasContent(undefined), false);
  assert.equal(toolUpdateHasContent(null), false);
  assert.equal(toolUpdateHasContent("plain string"), false);
});

// The stall warning itself: one event per stalled call, naming the command, while the quiet
// watchdog still owns the kill.

test("a stalled tool call warns once with the command named", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  // 5s/2s: see the sibling above — the warning fires while the run is still alive, and every
  // later check before the kill must stay quiet about the same call.
  config.quietTimeoutSeconds = 5;
  config.toolCallStallSeconds = 2;
  const warnings: string[] = [];
  const clock = watchdogClock(t);
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const opts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
    const run = runPi(opts);
    await waitForLogLines(opts.rawLogFile, "tool_execution_start");
    clock.advance(30_000); // several checks past the stall threshold, then the kill
    const result = await run;
    assert.equal(result.quietKilled, true, "the run still ends via the quiet watchdog");
    assert.equal(warnings.length, 1, "one warning per stalled call — not one per interval tick");
    assert.match(warnings[0] ?? "", /^tool call stalled: bash sleep 999 — no output for \d+[sm]/);
  } finally {
    restore();
  }
});

test("no stall warning when the tool call ends before the threshold", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  // 5s: this run completes instead of hanging, so the window is only a ceiling — but at 2s it
  // could expire during process spawn under load and quiet-kill a run that asserts ok (BUGS.md).
  config.quietTimeoutSeconds = 5;
  // The real default: nothing this fast can trip it.
  assert.equal(config.toolCallStallSeconds, 300);
  const warnings: string[] = [];
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "true" } })}'`,
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false })}'`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const result = await runPi(
      runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(warnings, []);
  } finally {
    restore();
  }
});

test("toolCallStallSeconds 0 disables the stall warning", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // the kill still happens...
  config.toolCallStallSeconds = 0; // ...but no warning accompanies it
  const warnings: string[] = [];
  const clock = watchdogClock(t);
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  try {
    const opts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
    const run = runPi(opts);
    await waitForLogLines(opts.rawLogFile, "tool_execution_start");
    clock.advance(10_000);
    const result = await run;
    assert.equal(result.quietKilled, true);
    assert.deepEqual(warnings, []);
  } finally {
    restore();
  }
});

// The stall warning must not fire on a command whose stdout is piped or redirected — the
// tick prompt prescribes exactly that shape for verification runs, so their silence is the
// prescribed shape, not a hang (BUGS.md 2026-09-28).

test("commandBuffersOutput classifies the redirect shapes", () => {
  const buffered = [
    "npm run test 2>&1 | tail -8", // the prescribed shape: the pipe holds every byte
    "npm run test > /tmp/out.log",
    "npm run test >> /tmp/out.log",
    "npm run test &> /tmp/out.log", // both streams leave
    "npm run test 2> /tmp/err.log > /dev/null", // the > redirects stdout
    'grep "a > b" file', // errs toward buffered on unparseable shapes
  ];
  const live = [
    "sleep 999", // bare: pi's pipe stays open, silence means something
    "npm run test 2>&1", // stderr dups onto stdout's destination — pi's pipe
    "npm run test 2> /tmp/err.log", // only stderr leaves; stdout still streams
    "npm run test 2>> /tmp/err.log", // stderr appends; the >> pair is one operator
    "npm run test >&1", // stdout dups onto itself
  ];
  for (const c of buffered) assert.equal(commandBuffersOutput(c), true, `buffered: ${c}`);
  for (const c of live) assert.equal(commandBuffersOutput(c), false, `live: ${c}`);
});

test("a stalled piped-stdout call warns nothing; the redirect is found in the full command, not the truncated label", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 5;
  config.toolCallStallSeconds = 2;
  const warnings: string[] = [];
  const clock = watchdogClock(t);
  // One command piped through tail (the prescribed shape) and one whose redirect operator
  // sits past char 32 — describeToolCall truncates the label there, so only the call's full
  // raw command can reveal the `>`; both must stay unwarned while they stall.
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm run test 2>&1 | tail -8" } })}'`,
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "npm run test -- --runInBand --detectOpenHandles > /tmp/quiet.log" } })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  try {
    const opts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
    const run = runPi(opts);
    await waitForLogLines(opts.rawLogFile, "tool_execution_start");
    clock.advance(30_000); // well past the stall threshold, then past the quiet window
    const result = await run;
    assert.equal(result.quietKilled, true, "the quiet watchdog still owns the kill");
    assert.deepEqual(warnings, [], "piped or redirected stdout makes silence meaningless");
  } finally {
    restore();
  }
});

// A killed tick must take its tool-call grandchildren with it. pi runs detached as its own
// process group leader and terminateChild signals the group (BUGS.md 2026-09-20); the old
// single-PID kill left a backgrounded tool-call process orphaned to launchd forever. The
// fakePi script backgrounds a spinner that does NOT exec, so it is a genuine grandchild —
// the exec-based kill tests above cannot catch this.
//
// The kill is test-driven (abort signal) instead of quiet-watchdog-driven, and the shim
// records the grandchild's pid BEFORE printing any output: the watchdog fires on wall-clock
// silence, so on a loaded machine it could kill the whole group while the shim was still
// starting up — before the grandchild had written its pid file — and the test died reading
// that missing file (the ENOENT that turned main red, 2026-09-22). Waiting for the file and
// killing only after it exists leaves no race: the test fails with a clear message if the
// shim never starts, and the abort exercises the same terminateChild group kill.
test("a killed run leaves no grandchild behind (regression)", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  // Far beyond the test's span: the quiet watchdog must not fire — this test drives the kill.
  config.quietTimeoutSeconds = 60;
  const pidFile = path.join(dir, "grandchild.pid");
  // The spinner redirects its stdio so it does not hold pi's pipes open — exactly the shape
  // of a real tool call, and what lets runPi settle while the leak lives on.
  const restore = fakePi(
    [
      `sh -c 'echo $$ > ${pidFile}; while :; do :; done' >/dev/null 2>&1 &`,
      `until [ -f ${pidFile} ]; do sleep 0.05; done`,
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  const controller = new AbortController();
  let pid = 0;
  const run = runPi(runPiFixture(dir, { config, signal: controller.signal }));
  try {
    // Wait until the grandchild has recorded itself — the write the old version raced.
    const recordDeadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) && Date.now() < recordDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(fs.existsSync(pidFile), "the grandchild recorded its pid within 10s");
    controller.abort();
    const result = await run;
    assert.equal(result.aborted, true, "the run ends killed by the abort");
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0, "the grandchild recorded its pid");
    // The group signal is asynchronous relative to runPi's resolution: poll until the OS
    // has reaped the grandchild (or the assertion below fails on a leak that never dies).
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive, false, "the tool-call grandchild is gone after the run resolves");
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    restore();
  }
});

// A run that ENDS NORMALLY must take its backgrounded tool-call processes with it too (BUGS.md
// 2026-09-23): qa's GUI check backgrounded `cd … && node … gui --all-interfaces &`, its own
// cleanup killed the list's subshell instead of the server, pi exited 0, and the unauthenticated
// server listened on the LAN for 7.5 hours — still in the group pi led. Both shapes of the
// Repro: `(… &)` (the subshell forks and exits, orphaning at once) and `cmd && … &` (the whole
// list is the background job, so `$!` names its subshell — the qa trap). Each sleep records its
// own pid (`exec` keeps it), and the shim waits (bounded) for both pid files before exiting, so
// the test never races their writes.
test("a run that exits normally leaves no backgrounded tool-call process behind (regression)", async () => {
  const dir = tmpdir();
  const subshellPidFile = path.join(dir, "subshell.pid");
  const listPidFile = path.join(dir, "list.pid");
  const pidFiles = [subshellPidFile, listPidFile];
  const sleeper = (pidFile: string) => `sh -c 'echo $$ > ${pidFile}; exec sleep 3600'`;
  // A backstop, far beyond the test's span: were an orphan ever to hold 'close' open, the run
  // fails on the tick timeout instead of hanging the file.
  const config = defaultConfig();
  config.tickTimeoutSeconds = 30;
  const restore = fakePi(
    [
      // The "tool call" runs in its own shell whose stdio is off pi's pipes, as a real tool
      // call's is — otherwise the `&&` list's subshell holds pi's stdout open while it waits
      // on its sleep, and the pre-fix run never closes instead of resolving with its orphans
      // alive. `exec` (not a `{ …; } >` group, whose saved copy of the old stdout the forked
      // list inherits) leaves no descriptor of pi's behind.
      `( exec >/dev/null 2>&1; (${sleeper(subshellPidFile)} &); true && ${sleeper(listPidFile)} & )`,
      `n=0; until [ -s ${subshellPidFile} ] && [ -s ${listPidFile} ] || [ $n -ge 200 ]; do sleep 0.05; n=$((n+1)); done`,
      `printf '%s\n' '${assistantLine("Everything checked out.")}'`,
      `exit 0`,
    ].join("\n"),
  );
  const readPid = (f: string) => {
    try {
      return Number(fs.readFileSync(f, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  const seenDead = new Set<number>();
  try {
    const result = await runPi(runPiFixture(dir, { config }));
    assert.equal(result.ok, true, "the run ends normally — no kill path is involved");
    assert.equal(result.aborted || result.timedOut || result.quietKilled, false);
    const pids = pidFiles.map(readPid);
    assert.ok(pids.every((pid) => pid > 0), "both backgrounded sleeps recorded their pids");
    // The group signal is asynchronous relative to runPi's resolution: poll until the OS has
    // reaped both sleeps (the assertion below fails on a leak that never dies).
    const deadline = Date.now() + 5000;
    while (seenDead.size < pids.length && Date.now() < deadline) {
      for (const pid of pids) if (!pidAlive(pid)) seenDead.add(pid);
      if (seenDead.size < pids.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(
      pids.filter((pid) => !seenDead.has(pid)),
      [],
      "every backgrounded sleep is gone after a normal exit",
    );
  } finally {
    // Never leak a sleep, whichever assertion failed: SIGKILL every recorded pid not seen dead
    // (one seen dead is left alone — its pid may already be recycled).
    for (const pid of pidFiles.map(readPid)) {
      if (pid <= 0 || seenDead.has(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    restore();
  }
});

// The sweep's contract with signalTree: a group that died with its leader is the normal case
// after an exit, so signalling it reports "nothing received this" instead of throwing — which
// is what lets the post-exit sweep skip arming a SIGKILL at a pgid no process holds any more.
test("signalTree reports whether the signal reached a live group, and tolerates a gone one", async () => {
  const done = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
  await new Promise((r) => done.on("exit", r));
  assert.equal(signalTree(done, "SIGTERM"), false, "an exited leader's empty group receives nothing");

  const live = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    await new Promise((r) => live.on("spawn", r));
    const exited = new Promise<NodeJS.Signals | null>((r) => live.on("exit", (_code, signal) => r(signal)));
    assert.equal(signalTree(live, "SIGTERM"), true, "a live group receives the signal");
    assert.equal(await exited, "SIGTERM");
  } finally {
    live.kill("SIGKILL");
  }
});

test("piArgs reflects config", () => {
  const config = defaultConfig();
  config.provider = "anthropic";
  config.model = "sonnet";
  config.thinking = "high";
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  assert.deepEqual(args.slice(0, 3), ["--print", "--mode", "json"]);
  for (const expected of ["--provider", "anthropic", "--model", "sonnet", "--thinking", "high", "--no-skills"]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
});

// The bundled bounded-output extension rides on every pi run (PLANS.md "Bound tool output
// head+tail with a tumwater pi extension") — loaded before user piArgs so a user flag wins.

test("piArgs loads the bundled bounded-output extension before user piArgs", () => {
  const config = defaultConfig();
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  const eIndex = args.indexOf("-e");
  assert.ok(eIndex !== -1, "-e flag present");
  const extPath = args[eIndex + 1]!;
  // Tests run compiled from dist/test/, so resolving the same relative URL the code uses
  // points at dist/src/pi-extension/bounded-output.js — existing after npm run build.
  const expected = fileURLToPath(new URL("../src/pi-extension/bounded-output.js", import.meta.url));
  assert.equal(extPath, expected);
  assert.ok(path.isAbsolute(extPath), "extension path is absolute");
  assert.ok(fs.existsSync(extPath), `extension exists in dist: ${extPath}`);
  assert.ok(eIndex < args.indexOf("--no-skills"), "user piArgs still come after the extension");
});

test("piArgs skips the extension for non-pi agents, keeps it for a configured pi path", () => {
  const base = { config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" };
  assert.ok(!piArgs({ ...base, agentBin: "/usr/local/bin/other-agent" }).includes("-e"));
  assert.ok(piArgs({ ...base, agentBin: "/opt/tools/pi" }).includes("-e"));
});

test("piArgs omits unset options", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(!args.includes("--provider"));
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--thinking"));
});

test("role overrides flow through to the pi argv and round-trip via config files", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ model: "cheap", roles: { bugfix: { enabled: true, model: "expensive", provider: "anthropic" } } }),
  );
  const config = loadConfig(dir);
  const args = piArgs({ config: configForRole(config, "bugfix"), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(args.includes("expensive"));
  assert.ok(args.includes("anthropic"));
  const cheap = piArgs({ config: configForRole(config, "clean"), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(cheap.includes("cheap"));
  assert.ok(!cheap.includes("anthropic"));
});

/** The standard runPi fixture: a run against `dir` with the minimal prompt, a fresh
 * defaultConfig(), and throwaway session/raw-log paths — the shape every test starts from,
 * stated once so a new required runPi field lands in one place. `over` overrides any field
 * (config included), so a test states only what differs from this default; the returned
 * options object is passed to runPi or runPiVerified by the caller. */
function runPiFixture(dir: string, over: Partial<PiRunOptions> = {}): PiRunOptions {
  return {
    cwd: dir,
    prompt: "p",
    config: defaultConfig(),
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile: path.join(dir, "raw.jsonl"),
    ...over,
  };
}

/** Run the fake pi through runPi with throwaway dirs and return the distilled result. */
async function runFakePi(script: string) {
  const dir = tmpdir();
  const restore = fakePi(script);
  try {
    return await runPi(runPiFixture(dir));
  } finally {
    restore();
  }
}

// The suite runs under fleet load — review gates and main-baseline checks spawn full suites
// alongside — where spawning the fake pi or opening its log can transiently fail. Without a
// retry that environmental failure lands as a misleading raw-log content assertion in the
// tests below (a 2026-09-09 gate rejection of an unrelated GUI change was exactly this). A
// real log regression fails both attempts; only runs where pi produced nothing are retried.
async function runPiVerified(opts: Parameters<typeof runPi>[0]): Promise<PiRunResult> {
  const first = await runPi(opts);
  if (first.ok || first.turns > 0) return first;
  fs.rmSync(opts.rawLogFile, { force: true }); // attempt one may have left a partial log
  await new Promise((r) => setTimeout(r, 250)); // let the resource pressure clear
  const second = await runPi(opts);
  if (second.ok || second.turns > 0) return second;
  throw new Error(
    `fake pi produced no output twice in a row — environmental (fleet load), not a log regression: ${first.errorMessage ?? "no error"}`,
  );
}

test("a non-zero pi exit with assistant text still counts as a successful run", async () => {
  // Documented lenient behavior (BUGS.md, spurious-warning fix, cause 4): pi can exit
  // non-zero after producing output; the work is real, so the tick must not be an error.
  const result = await runFakePi(
    [`printf '%s\n' '${assistantLine("done", { tokens: 10 })}'`, "exit 1"].join("\n"),
  );
  assert.equal(result.ok, true, "non-zero exit with assistant text is leniently ok");
  assert.equal(result.finalText, "done");
  assert.equal(result.timedOut, false);
});

test("a non-zero pi exit without assistant text is a failed run", async () => {
  // The other half of the same branch: no output means nothing landed, so it must stay an
  // error (the tick-level regression for this lives in test/loop.test.ts).
  const result = await runFakePi(`echo 'pi exploded' >&2\nexit 1`);
  assert.equal(result.ok, false);
  assert.match(result.errorMessage ?? "", /pi exploded|exited 1/);
});

test("a multi-byte character straddling a stdout chunk boundary survives intact", async () => {
  // pi's JSONL arrives in arbitrary chunks; decoding each Buffer with toString("utf8")
  // replaces any non-ASCII character whose bytes split across two 'data' events with U+FFFD,
  // garbling the parsed text (commit subjects, summaries, transcripts). The fake pi writes
  // one line in two paced writes with é's UTF-8 bytes (0xC3 0xA9) split between them — the
  // sleep guarantees the first write is drained as its own chunk, so the boundary falls
  // inside the character. Pre-fix this produced "h\uFFFD\uFFFDllo".
  const dir = tmpdir();
  const restore = fakePi(
    [
      `printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"h\\303'`,
      `sleep 0.3`,
      `printf '\\251llo"}],"usage":{"totalTokens":5,"output":5,"cost":{"total":0}},"stopReason":"stop"}}\n'`,
    ].join("\n"),
  );
  try {
    const result = await runPi(runPiFixture(dir));
    assert.equal(result.ok, true);
    assert.equal(result.finalText, "héllo", "the split character decodes intact");
    assert.equal(result.turns, 1);
    // The raw log is written from the same decoded lines — it must be clean too.
    assert.ok(!fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").includes("\uFFFD"));
  } finally {
    restore();
  }
});

// Session lifecycle: every tick starts a fresh pi session (context never accumulates
// across ticks); --continue exists only for the within-tick transient retry.

test("piArgs starts fresh sessions with a name and resumes with --continue", () => {
  const base = { config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n1" };
  const fresh = piArgs(base);
  assert.ok(fresh.includes("-n"), "fresh runs are named");
  assert.ok(!fresh.includes("--continue"));
  const resumed = piArgs({ ...base, continueSession: true });
  assert.ok(resumed.includes("--continue"), "the within-tick retry resumes the session");
  assert.ok(!resumed.includes("-n"), "resumed runs keep their existing name");
});

test("every tick starts a fresh pi session", async () => {
  const repo = makeRepo();
  await initProject(repo, "fresh session test");
  const argsFile = path.join(tmpdir(), "argv.log");
  // The prompt argument spans many lines, so record only the flags, one run per line.
  const restore = fakePi(
    [logFlagsTo(argsFile), `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "clean");
    await runner.tick();
    await runner.tick();
    const runs = fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
    assert.equal(runs.length, 2);
    for (const [i, run] of runs.entries()) {
      assert.ok(!run.includes("--continue"), `tick ${i + 1} must not resume a prior session`);
      assert.ok(run.includes("-n"), `tick ${i + 1} names its fresh session`);
    }
  } finally {
    restore();
  }
});

test("a context-exceeded error fails the tick with the real cause", async () => {
  const repo = makeRepo();
  await initProject(repo, "context overflow test");
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Context size has been exceeded." })}'`,
      `exit 1`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "clean");
    assert.equal((await runner.tick()).result, "error");
    assert.ok(runner.state.lastError, "the error is surfaced on the loop state");
  } finally {
    restore();
  }
});

// Run labels: a labeled run (the review gate) writes one marker line to the shared raw log
// before any of pi's output, so every transcript surface can render `── review @ <ts> ──` for
// it. Unlabeled author runs write no marker — their logs stay byte-identical.

test("runPi with a label writes exactly one marker line as the raw log's first line", async () => {
  const dir = tmpdir();
  const restore = fakePi(`printf '%s\n' '${assistantLine("VERDICT: approve", { tokens: 5 })}'`);
  try {
    await runPiVerified(runPiFixture(dir, { label: "review" }));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(
      content,
      `{"type":"tumwater_run","label":"review"}\n${assistantLine("VERDICT: approve", { tokens: 5 })}\n`,
      "the marker precedes every pi output line and appears exactly once",
    );
  } finally {
    restore();
  }
});

test("runPi without a label leaves the raw log byte-identical to today's shape", async () => {
  const dir = tmpdir();
  const restore = fakePi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`);
  try {
    await runPiVerified(runPiFixture(dir));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(content, `${assistantLine("done", { tokens: 5 })}\n`, "no marker line for unlabeled runs");
  } finally {
    restore();
  }
});

test("a failed labeled run still flushes its marker (the stale-marker case)", async () => {
  // A reviewer spawn that dies before emitting anything leaves the marker alone in the log.
  // The renderer consumes it at the next agent_start, so it can mislabel at most the following
  // separator and never leaks past one run — pinned here at the source.
  const dir = tmpdir();
  const restore = fakePi("exit 1");
  try {
    await runPi(runPiFixture(dir, { label: "review" }));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(content, `{"type":"tumwater_run","label":"review"}\n`);
  } finally {
    restore();
  }
});

// Flush-before-resolve: raw-log writes complete on libuv's threadpool, so runPi must not
// settle until the log has actually hit disk — a tick that dies right after settling (an
// abort during a restart drain, a supervisor swap) would otherwise lose its last lines, and
// under load readers see an empty or marker-only file. Pinned with a stalled stream: it
// buffers everything and lands it one macrotask after end(), so resolve-before-flush code
// reads back an incomplete log on the very turn runPi settles.
test("runPi resolves only after the raw log has flushed (stalled-stream regression)", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "raw.jsonl");
  const restore = fakePi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`);
  const realCreateWriteStream = fs.createWriteStream;
  // One fresh fake per stream open, so a runPiVerified retry cannot append to the previous
  // attempt's buffered writes.
  const makeStalled = () => {
    let pending = "";
    return Object.assign(new EventEmitter(), {
      write: (data: string) => {
        pending += data;
        return true;
      },
      end: (cb?: () => void) => {
        // The threadpool "completes" the queued writes one macrotask after end().
        setImmediate(() => {
          fs.appendFileSync(file, pending);
          cb?.();
        });
      },
    });
  };
  (fs as unknown as { createWriteStream: unknown }).createWriteStream = () => makeStalled();
  try {
    await runPiVerified(runPiFixture(dir, { rawLogFile: file }));
    const content = fs.readFileSync(file, "utf8");
    assert.equal(
      content,
      `${assistantLine("done", { tokens: 5 })}\n`,
      "the raw log is complete on the turn runPi resolves — nothing may still be in flight",
    );
  } finally {
    restore();
    (fs as unknown as { createWriteStream: unknown }).createWriteStream = realCreateWriteStream;
  }
});

test("a broken raw log degrades to a lost log, never a stuck tick", async () => {
  // The stream dies instead of finishing ('error' fires, 'finish' never does): runPi must
  // still settle with the run's real result rather than hang the loop.
  const dir = tmpdir();
  const restore = fakePi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`);
  const realCreateWriteStream = fs.createWriteStream;
  const brokenEvents = new EventEmitter();
  const broken = Object.assign(brokenEvents, {
    write: (_data: string) => true,
    end: () => {
      setImmediate(() => brokenEvents.emit("error", new Error("ENOSPC: no space left on device")));
    },
  });
  (fs as unknown as { createWriteStream: unknown }).createWriteStream = () => broken;
  try {
    const result = await Promise.race([
      runPi(runPiFixture(dir)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("runPi hung on a broken raw log")), 5000),
      ),
    ]);
    assert.equal(result.ok, true, "the run itself succeeded; only its log is lost");
    assert.equal(result.finalText, "done");
  } finally {
    restore();
    (fs as unknown as { createWriteStream: unknown }).createWriteStream = realCreateWriteStream;
  }
});

test("a missing pi binary fails the tick with an error", async () => {
  const repo = makeRepo();
  await initProject(repo, "spawn failure test");
  // A PATH with git but no pi, so only the pi spawn fails.
  const binDir = gitOnlyBinDir();
  const oldPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(String(runner.state.lastError), /failed to spawn pi/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// pi crashing on malformed JSON (a torn model-server chunk): five ticks in the first 18 days died
// with "Unterminated string in JSON at position N" as their only error, one of them 2 h 39 m of
// director work. The session survives on disk, so the harness treats it as transient (loop.ts
// retries once with --continue) — flagged from pi's stderr at exit, and only for exits the
// harness itself did not cause.
test("runPi flags a JSON.parse crash on pi's stderr as a transient pi crash", async () => {
  const r = await runFakePi(
    `echo 'SyntaxError: Unterminated string in JSON at position 2781 (line 1 column 2782)' >&2\nexit 1`,
  );
  assert.equal(r.ok, false);
  assert.equal(r.transientPiCrash, true);
  assert.match(r.errorMessage ?? "", /Unterminated string in JSON/);
});

test("runPi does not flag ordinary crashes or harness kills as transient pi crashes", async () => {
  const crashed = await runFakePi(`echo 'TypeError: cannot read properties of undefined' >&2\nexit 1`);
  assert.equal(crashed.transientPiCrash, false, "an unrelated crash is not transient");
  // The pattern itself is what the loop relies on: pin the phrasings Node's JSON.parse produces.
  for (const line of [
    "Unterminated string in JSON at position 9088 (line 1 column 9089)",
    "Expected ',' or '}' after property value in JSON at position 12",
    "Unexpected end of JSON input",
    "Unexpected token 'x', \"xyz\" is not valid JSON",
  ]) {
    assert.ok(TRANSIENT_PI_CRASH.test(line), line);
  }
  assert.equal(TRANSIENT_PI_CRASH.test("Error: spawn ENOENT"), false);
});
