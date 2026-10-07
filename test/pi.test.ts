import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  MODEL_FALLBACK_CLONE,
  TRANSIENT_PI_CRASH,
  runPi,
} from "../src/pi/pi.js";
import { NO_LAUNCH_SERVICES_CHECK_IN, withoutLaunchServicesCheckIn } from "../src/process/process.js";
import { toolUpdateHasContent } from "../src/pi/pi-event-line.js";
import { defaultConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { gitOnlyBinDir, makeRepo, tmpdir } from "./repo-fixtures.js";
import { fakePi, logFlagsTo, readRunLines } from "./fake-pi.js";
import { pathReplace } from "./fake-commands.js";
import { waitForLogLines, watchdogClock } from "./wait.js";
import { assistantLine } from "./pi-events.js";
import { runPiFixture, runFakePi, runPiVerified } from "./pi-run-harness.js";
import { ownerAliveSh } from "./victim-fixture.js";

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
      `while [ ! -f '${go}' ] && ${ownerAliveSh()}; do sleep 0.02; done`, // byte-silent until the test says go
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
  const restorePath = pathReplace(""); // no pi anywhere on PATH — only agentBin can resolve
  try {
    const result = await runPi(runPiFixture(dir, { config }));
    assert.equal(result.ok, true, `expected the wrapper-run pi to succeed: ${result.errorMessage}`);
    assert.match(result.finalText, /wrapped:1/, "the wrapper exported its env var before exec");
  } finally {
    restorePath();
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

// A piped command's silence is the prescribed shape (BUGS.md 2026-09-28), but the command
// itself can hang past any healthy verify run's duration (BUGS.md 2026-10-06): there the
// evidence is wall-clock, and the warning names the open duration instead of silence.

test("a piped command open past the buffered wall-clock threshold warns even though it holds its bytes", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  // The quiet watchdog must not win the race: its silence window (2× quiet after the first
  // byte, no progress events in this fixture) must outlast the 10-min buffered floor.
  config.quietTimeoutSeconds = 700;
  config.toolCallStallSeconds = 300;
  const warnings: string[] = [];
  const clock = watchdogClock(t);
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999 | tail -1" } })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const opts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
    const run = runPi(opts);
    await waitForLogLines(opts.rawLogFile, "tool_execution_start");
    clock.advance(610_000); // past the 10-minute buffered wall-clock floor (max(2×300s, 10 min))
    assert.equal(warnings.length, 1, "the buffered hang is warned once, by duration");
    assert.match(
      warnings[0] ?? "",
      /^tool call stalled: bash sleep 999 \| tail -1 — no exit for \d+m/,
      "a buffered call's warning names the open duration, not silence",
    );
    clock.advance(900_000); // total 1510s > 2× quiet: the quiet watchdog still owns the kill
    const result = await run;
    assert.equal(result.quietKilled, true, "the kill remains the quiet watchdog's");
    assert.equal(warnings.length, 1, "one warning per stalled call — not one per interval tick");
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
// prescribed shape, not a hang (BUGS.md 2026-09-28). The classifier's own shape table lives
// in test/command-shape.test.ts.

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

test("a multi-byte character straddling a stderr chunk boundary survives intact", async () => {
  // The stderr buffer is built with a raw Buffer.toString("utf8") per chunk — unlike
  // stdout's StringDecoder — and it is where the run's failure message and the
  // stderr-keyed matchers (crash, stream-severed, config) read. A non-ASCII character whose
  // bytes split across two 'data' events is replaced with U+FFFD, garbling that text. The
  // fake pi writes its stderr in two paced writes with é's UTF-8 bytes (0xC3 0xA9) split
  // between them, then exits non-zero so the stderr becomes the reported errorMessage.
  const dir = tmpdir();
  const restore = fakePi(
    [
      `printf 'boom h\\303' >&2`,
      `sleep 0.3`,
      `printf '\\251llo' >&2`,
      `exit 1`,
    ].join("\n"),
  );
  try {
    const result = await runPi(runPiFixture(dir));
    assert.equal(result.ok, false);
    assert.match(result.errorMessage ?? "", /boom héllo/, "the split character decodes intact");
  } finally {
    restore();
  }
});

// Session lifecycle: every tick starts a fresh pi session (context never accumulates
// across ticks); --continue exists only for the within-tick transient retry.

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
    const runs = readRunLines(argsFile);
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

// Run markers: every run writes one marker line to the shared raw log before any of pi's
// output, carrying the run's kind and (when set) its label, so the dashboards can demultiplex
// interleaved author and gate runs by marker and every transcript surface can render
// `── review @ <ts> ──` for a labeled one.

test("a labeled run writes exactly one kind+label marker line as the raw log's first line", async () => {
  const dir = tmpdir();
  const restore = fakePi(`printf '%s\n' '${assistantLine("VERDICT: approve", { tokens: 5 })}'`);
  try {
    await runPiVerified(runPiFixture(dir, { kind: "gate", label: "review" }));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(
      content,
      `{"type":"tumwater_run","kind":"gate","label":"review"}\n${assistantLine("VERDICT: approve", { tokens: 5 })}\n`,
      "the marker precedes every pi output line and appears exactly once",
    );
  } finally {
    restore();
  }
});

test("an unlabeled run writes one kind-only marker and no label", async () => {
  const dir = tmpdir();
  const restore = fakePi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`);
  try {
    await runPiVerified(runPiFixture(dir));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(
      content,
      `{"type":"tumwater_run","kind":"author"}\n${assistantLine("done", { tokens: 5 })}\n`,
      "the author run's marker carries only its kind",
    );
  } finally {
    restore();
  }
});

test("a failed labeled run still flushes its marker (the stale-marker case)", async () => {
  // A reviewer spawn that dies before emitting anything leaves the marker alone in the log.
  // The renderer consumes its label at the next agent_start, so it can mislabel at most the
  // following separator and never leaks past one run — pinned here at the source.
  const dir = tmpdir();
  const restore = fakePi("exit 1");
  try {
    await runPi(runPiFixture(dir, { kind: "gate", label: "review" }));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(content, `{"type":"tumwater_run","kind":"gate","label":"review"}\n`);
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
      `{"type":"tumwater_run","kind":"author"}\n${assistantLine("done", { tokens: 5 })}\n`,
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
  const restorePath = pathReplace(binDir);
  try {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(String(runner.state.lastError), /failed to spawn pi/);
  } finally {
    restorePath();
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

// The provider severing the in-flight HTTP stream: undici rejects with the bare word
// "terminated", and pi can die on it with that word as its only stderr — the 2026-09-30
// digest's #2 loss cause, which fell through every transient layer because the word matched
// none of them (BUGS.md 2026-09-30). The stderr spelling classifies like the pi-event one.
test("runPi flags undici's bare terminated on stderr as a stream-severed backend failure", async () => {
  const r = await runFakePi(`echo terminated >&2\nexit 1`);
  assert.equal(r.ok, false);
  assert.equal(r.transientBackend, true);
  assert.equal(r.backendKind, "stream-severed");
  assert.equal(r.transientPiCrash, false, "one exit has one cause — this is not the JSON-parse crash");
  assert.equal(r.errorMessage, "terminated");
  // End-anchored on purpose: an unrelated error that merely contains the word must not
  // read as a severed stream.
  const unrelated = await runFakePi(`echo 'worker terminated with exit code 1' >&2\nexit 1`);
  assert.equal(unrelated.transientBackend, false);
  assert.equal(unrelated.backendKind, undefined);
});

// A provider-wide backend failure on stderr with no pi event for it: pi dies on the provider's
// own request timeout, the 2026-10-07 window's #1 loss cause, and previously fell through
// every transient layer because the close handler matched only the crash and stream-severed
// stderr spellings (BUGS.md 2026-10-07). The stderr text now classifies through the same
// TRANSIENT_BACKEND/backendKind rule as a pi event errorMessage.
test("runPi classifies a request timeout on stderr as the timeout backend kind", async () => {
  const r = await runFakePi(`echo 'Request timed out.' >&2\nexit 1`);
  assert.equal(r.ok, false);
  assert.equal(r.transientBackend, true);
  assert.equal(r.backendKind, "timeout");
  assert.equal(r.transientPiCrash, false, "one exit has one cause — this is not the JSON-parse crash");
  assert.equal(r.errorMessage, "Request timed out.");
  // The same rule covers every backend spelling the event path already classifies, not just
  // the timeout: a connection failure on stderr carries the connection kind too.
  const connection = await runFakePi(`echo 'Connection error.' >&2\nexit 1`);
  assert.equal(connection.transientBackend, true);
  assert.equal(connection.backendKind, "connection");
});

// pi's stderr warning when a requested model id has no exact definition: pi clones the
// provider's default model, inheriting that default's price and context window, so a
// mistyped or vendor-suffixed id silently misprices the run (BUGS.md 2026-10-06). Captured
// from stderr so the loop's warning event can name it.
test("runPi captures pi's fallback-clone stderr warning for an undefined model id", async () => {
  const r = await runFakePi(
    `printf '%s\\n' 'Warning: Model "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra" not found for provider "huggingface". Using custom model id.' >&2\nprintf '%s\\n' '${assistantLine("done", { tokens: 5 })}'`,
  );
  assert.equal(r.ok, true);
  assert.match(r.fallbackClone ?? "", /not found for provider "huggingface"/);
  // The pattern itself is what the loop relies on: pin the spelling pi emits.
  assert.ok(MODEL_FALLBACK_CLONE.test(r.fallbackClone ?? ""));

  // An ordinary run that prints no such line carries no clone.
  const clean = await runFakePi(`printf '%s\\n' '${assistantLine("done", { tokens: 5 })}'`);
  assert.equal(clean.fallbackClone, undefined);
});

// The clone warning arrives at the START of a run, and runPi keeps only stderr's last 64 KiB
// to bound memory. A chatty run that prints more than that after the warning must still
// surface the mispriced id — otherwise the feature goes silent on exactly the noisiest runs.
test("runPi keeps a fallback-clone warning printed before a large stderr tail", async () => {
  const r = await runFakePi(
    [
      `printf '%s\\n' 'Warning: Model "x:deepinfra" not found for provider "huggingface". Using custom model id.' >&2`,
      `yes 'stderr filler line' | head -c 70000 >&2`,
      `printf '%s\\n' '${assistantLine("done", { tokens: 5 })}'`,
    ].join("\n"),
  );
  assert.equal(r.ok, true);
  assert.match(r.fallbackClone ?? "", /not found for provider "huggingface"/);
});
