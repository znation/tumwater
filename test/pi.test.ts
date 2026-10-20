/** The runPi wire: spawning the configured agentBin (and the LaunchServices preload), the
 * spawn-error and missing-binary paths, the raw-log marker and flush contract, stdout/stderr
 * stream decoding, the stall-warning classification (startPiWatchdogs beside the parser),
 * the session lifecycle, exit-code leniency, and the stderr backend-failure and
 * fallback-clone matchers. The watchdog TIMING policy — the quiet kill, the zero-byte
 * startup grace, and the gate run's deadline extension — lives in test/pi-watchdogs.test.ts. */
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  MODEL_FALLBACK_CLONE,
  TRANSIENT_PI_CRASH,
  runPi,
} from "../src/pi/pi.js";
import { PiStreamParser } from "../src/pi/pi-stream.js";
import { claudeTranslator } from "../src/agent/claude/claude-stream.js";
import { NO_LAUNCH_SERVICES_CHECK_IN, withoutLaunchServicesCheckIn } from "../src/process/process.js";
import { messageUpdateHasContent, toolUpdateHasContent } from "../src/pi/pi-event-line.js";
import { startPiWatchdogs } from "../src/pi/pi-watchdogs.js";
import { defaultConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { gitOnlyBinDir, makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { logFlagsTo, readRunLines, withIdlePi, withPi } from "./fakes/fake-pi.js";
import { pathReplace, writeScript } from "./fakes/fake-commands.js";
import { waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { claudeAssistant, claudeToolUse } from "./fixtures/claude-events.js";
import { patchFsMethod } from "./helpers/fs-faults.js";
import { runPiFixture, runFakePi, runPiVerified } from "./helpers/pi-run-harness.js";

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

test("runPi writes the prompt to pi's stdin and keeps it out of pi's argv, fresh and on --continue", async () => {
  // BUGS.md 2026-10-18: as the last argv element the prompt showed in every pi's `ps` line, so
  // one agent's `pkill -f "npm run test"` killed every pi run on the host. A raw writeScript
  // fake (not fakePi, whose PROMPT_FROM_STDIN shim appends stdin to the args) records argv
  // and stdin apart, the way real pi 1.2.0 reads a piped stdin as its first message.
  const dir = tmpdir();
  const bin = path.join(dir, "pi");
  const argv = path.join(dir, "argv.log");
  const stdin = path.join(dir, "stdin.log");
  writeScript(
    bin,
    `{ printf '%s\\n' "$@"; echo ---; } >> '${argv}'\n{ cat; echo; echo ---; } >> '${stdin}'\n` +
      `printf '%s\\n' '${assistantLine("ok")}'`,
  );
  const config = defaultConfig();
  config.agentBin = bin;
  const prompt = "Run `npm run test` before you reply.\nEnd with SUMMARY:";
  for (const continueSession of [false, true]) {
    const result = await runPi(runPiFixture(dir, { config, prompt, continueSession }));
    assert.equal(result.ok, true, `expected the fake pi to succeed: ${result.errorMessage}`);
  }
  const runs = fs.readFileSync(argv, "utf8").split("---\n").filter(Boolean);
  assert.equal(runs.length, 2);
  for (const run of runs) assert.ok(!run.includes("npm run test"), `the prompt leaked into argv:\n${run}`);
  assert.ok(runs[1]!.includes("--continue"), "the second run resumes");
  assert.equal(fs.readFileSync(stdin, "utf8"), `${prompt}\n---\n${prompt}\n---\n`);
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

/** Run a fake pi that opens one tool call (`command`, optionally `toolName`) and then hangs,
 * collecting the stall warnings. `configure` mutates the watchdogs before the run; `during`
 * runs once the call is on the raw log — before the run ends — and receives the logical clock
 * and the warnings so far, so a test can advance time and inspect a warning mid-run. Set
 * `timeouts: true` to mock the tick deadline (config.runTimeoutSeconds) too. Returns the run
 * result and the warnings. */
async function withStalledToolCall(
  t: TestContext,
  opts: {
    command: string;
    toolName?: string;
    configure: (config: ReturnType<typeof defaultConfig>) => void;
    during?: (clock: ReturnType<typeof watchdogClock>, stallWarnings: string[]) => void;
    timeouts?: boolean;
  },
): Promise<{ result: Awaited<ReturnType<typeof runPi>>; warnings: string[] }> {
  const dir = tmpdir();
  const config = defaultConfig();
  opts.configure(config);
  const warnings: string[] = [];
  const clock = watchdogClock(t, { timeouts: opts.timeouts });
  const result = await withPi(
    [
      `printf '%s\n' '${JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "c1",
        ...(opts.toolName === undefined ? {} : { toolName: opts.toolName }),
        args: { command: opts.command },
      })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
    async () => {
      const runOpts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
      const run = runPi(runOpts);
      await waitForLogLines(runOpts.rawLogFile, "tool_execution_start");
      opts.during?.(clock, warnings);
      return run;
    },
  );
  return { result, warnings };
}

test("a stalled call without toolName warns with the bare command named", async (t) => {
  // The warning (2 s) lands before the kill (5 s of silence): exact on logical time, where a
  // real-time 1s gap lost that ordering to jitter under concurrent suites (BUGS.md 2026-09-18).
  const { result, warnings } = await withStalledToolCall(t, {
    command: "sleep 999",
    configure: (config) => {
      config.quietTimeoutSeconds = 5;
      config.toolCallStallSeconds = 2;
    },
    during: (clock) => clock.advance(30_000), // past the stall threshold, then past the quiet window
  });
  assert.equal(result.quietKilled, true, "the run still ends via the quiet watchdog");
  assert.match(
    warnings[0] ?? "",
    /^tool call stalled: sleep 999 — no output for \d+[sm]/,
    "the warning names the bare command even though pi omitted toolName",
  );
});

test("toolUpdateHasContent sees real text, not empty or content-less updates", () => {
  assert.equal(toolUpdateHasContent({ content: [{ type: "text", text: "out" }] }), true);
  assert.equal(toolUpdateHasContent({ content: [] }), false, "bash's post-start update is empty");
  assert.equal(toolUpdateHasContent({ content: [{ type: "text", text: "   " }] }), false, "whitespace-only is not output");
  assert.equal(toolUpdateHasContent(undefined), false);
  assert.equal(toolUpdateHasContent(null), false);
  assert.equal(toolUpdateHasContent("plain string"), false);
});

test("messageUpdateHasContent sees a delta carrying text, not a keepalive", () => {
  const update = (delta: unknown) => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
  assert.equal(messageUpdateHasContent(update("All")), true, "a thinking delta is real generation");
  assert.equal(messageUpdateHasContent(update("")), false, "an empty delta is a keepalive");
  assert.equal(messageUpdateHasContent(update("   ")), false, "whitespace-only is not content");
  assert.equal(messageUpdateHasContent(update(undefined)), false);
  // The pre-strip shape carried a message snapshot and no delta event at all.
  assert.equal(messageUpdateHasContent({ type: "message_update", message: { role: "assistant" } }), false);
  assert.equal(messageUpdateHasContent({ type: "message_update" }), false);
  assert.equal(messageUpdateHasContent(undefined), false);
  assert.equal(messageUpdateHasContent("plain string"), false);
});

// The stall warning itself: one event per stalled call, naming the command, while the quiet
// watchdog still owns the kill.

test("a stalled tool call warns once with the command named", async (t) => {
  // 5s/2s: see the sibling above — the warning fires while the run is still alive, and every
  // later check before the kill must stay quiet about the same call.
  const { result, warnings } = await withStalledToolCall(t, {
    toolName: "bash",
    command: "sleep 999",
    configure: (config) => {
      config.quietTimeoutSeconds = 5;
      config.toolCallStallSeconds = 2;
    },
    during: (clock) => clock.advance(30_000), // several checks past the stall threshold, then the kill
  });
  assert.equal(result.quietKilled, true, "the run still ends via the quiet watchdog");
  assert.equal(warnings.length, 1, "one warning per stalled call — not one per interval tick");
  assert.match(warnings[0] ?? "", /^tool call stalled: bash sleep 999 — no output for \d+[sm]/);
});

// A piped command's silence is the prescribed shape (BUGS.md 2026-09-28), but the command
// itself can hang past any healthy verify run's duration (BUGS.md 2026-10-06): there the
// evidence is wall-clock, and the warning names the open duration instead of silence.

test("a piped command open past the buffered wall-clock threshold warns even though it holds its bytes", async (t) => {
  // The quiet watchdog must not win the race: its silence window (2× quiet after the first
  // byte, no progress events in this fixture) must outlast the 10-min buffered floor.
  const { result, warnings } = await withStalledToolCall(t, {
    toolName: "bash",
    command: "sleep 999 | tail -1",
    configure: (config) => {
      config.quietTimeoutSeconds = 700;
      config.toolCallStallSeconds = 300;
    },
    during: (clock, stallWarnings) => {
      clock.advance(610_000); // past the 10-minute buffered wall-clock floor (max(2×300s, 10 min))
      assert.equal(stallWarnings.length, 1, "the buffered hang is warned once, by duration");
      assert.match(
        stallWarnings[0] ?? "",
        /^tool call stalled: bash sleep 999 \| tail -1 — no exit for \d+m/,
        "a buffered call's warning names the open duration, not silence",
      );
      clock.advance(900_000); // total 1510s > 2× quiet: the quiet watchdog still owns the kill
    },
  });
  assert.equal(result.quietKilled, true, "the kill remains the quiet watchdog's");
  assert.equal(warnings.length, 1, "one warning per stalled call — not one per interval tick");
});

test("a claude call driven through the translator waits out the buffered threshold while a pi call warns at the silence threshold", async (t) => {
  // claude never sends content-bearing tool updates, so silence carries no hang signal for
  // any of its calls: each is judged by the buffered threshold
  // (plans/agent-backends.md "Watchdogs and progress"). The claude call comes from the real
  // translator → parser path, so the test also proves claude's call is observable while the
  // tool runs, not just that the classification branch works on a fabricated call. A bare
  // `sleep` is an unbuffered shape on pi, where silence stays meaningful. Driving
  // startPiWatchdogs alone isolates the classification from the spawn; the deadline's real
  // setTimeout sits an hour out, so only the mocked stall interval fires.
  const clock = watchdogClock(t);
  const claudeWarnings: string[] = [];
  const piWarnings: string[] = [];
  const translator = claudeTranslator();
  const parser = new PiStreamParser();
  for (const canonical of translator.translate(
    claudeAssistant({ id: "m1", blocks: [claudeToolUse("t1", "Bash", { command: "sleep 999" })], stopReason: "tool_use" }),
  ))
    parser.feed(canonical + "\n");
  assert.equal(parser.openToolCalls.length, 1, "the translator opened the claude call");
  // One fixed open-call entry: a fresh `lastActivityAt` on every read would chase the clock
  // and never stall.
  const piOpenCall = [{ id: "c2", label: "bash sleep 999", command: "sleep 999", lastActivityAt: Date.now() }];
  const claudeWd = startPiWatchdogs({
    progressCount: () => parser.progressCount,
    openToolCalls: () => parser.openToolCalls,
    tickTimeoutMs: 3_600_000,
    quietMs: 0,
    stallMs: 300_000,
    agent: "claude",
    kill: () => {},
    onToolCallStalled: (message) => claudeWarnings.push(message),
  });
  const piWd = startPiWatchdogs({
    progressCount: () => parser.progressCount,
    openToolCalls: () => piOpenCall,
    tickTimeoutMs: 3_600_000,
    quietMs: 0,
    stallMs: 300_000,
    agent: "pi",
    kill: () => {},
    onToolCallStalled: (message) => piWarnings.push(message),
  });
  clock.advance(301_000); // past toolCallStallSeconds (300 s), short of the buffered floor (max(2×300s, 10m) = 600 s)
  assert.deepEqual(claudeWarnings, [], "a claude call past toolCallStallSeconds is not yet stalled");
  assert.equal(piWarnings.length, 1, "a pi unbuffered call still warns at toolCallStallSeconds");
  assert.match(piWarnings[0] ?? "", /^tool call stalled: bash sleep 999 — no output for \d+[sm]$/);
  clock.advance(300_000); // now 601 s, past the buffered floor
  assert.equal(claudeWarnings.length, 1, "the claude call warns once past the buffered threshold");
  assert.match(claudeWarnings[0] ?? "", /^tool call stalled: bash sleep 999 — no exit for 10m$/);
  claudeWd.stop();
  piWd.stop();
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
  await withPi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "true" } })}'`,
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false })}'`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
    async () => {
      const result = await runPi(
        runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) }),
      );
      assert.equal(result.ok, true);
      assert.deepEqual(warnings, []);
    },
  );
});

test("toolCallStallSeconds 0 disables the stall warning", async (t) => {
  const { result, warnings } = await withStalledToolCall(t, {
    toolName: "bash",
    command: "sleep 999",
    configure: (config) => {
      config.quietTimeoutSeconds = 2; // the kill still happens...
      config.toolCallStallSeconds = 0; // ...but no warning accompanies it
    },
    during: (clock) => clock.advance(10_000),
  });
  assert.equal(result.quietKilled, true);
  assert.deepEqual(warnings, []);
});

// The unbuffered sibling of the buffered-duration test above: a silent call the interval
// first notices only after a minute is named in whole minutes. The threshold must exceed the
// 30 s interval period, or an earlier check always warns in seconds first.

test("an unbuffered call silent past a minute warns in whole minutes", async (t) => {
  const { result, warnings } = await withStalledToolCall(t, {
    toolName: "bash",
    command: "sleep 999",
    timeouts: true,
    configure: (config) => {
      config.runTimeoutSeconds = 700; // the deadline ends the run after the warning
      config.quietTimeoutSeconds = 0; // the quiet kill must not win before the 2-minute warning
      config.toolCallStallSeconds = 120; // the first check to see silence is at ~2 min, past 60 s
    },
    during: (clock, stallWarnings) => {
      clock.advance(121_000); // past the 2-minute threshold, so the warning is a whole-minute one
      assert.equal(stallWarnings.length, 1, "the multi-minute silence is warned once");
      assert.match(
        stallWarnings[0] ?? "",
        /^tool call stalled: bash sleep 999 — no output for \d+m$/,
        "past a minute the silence is named in whole minutes, not seconds",
      );
      clock.advance(600_000); // past the 700 s deadline: the tick timeout ends the run
    },
  });
  assert.equal(result.timedOut, true, "with the quiet watchdog disabled the deadline bounds the run");
  assert.equal(result.quietKilled, false);
  assert.equal(warnings.length, 1, "one warning per stalled call");
});

// Both watchdog windows off is the one config that schedules no quiet interval at all: no
// silence kill, no stall warning — the tick deadline is the only clock left.

test("disabling both quiet and stall windows leaves only the tick deadline, with no warning", async (t) => {
  const { result, warnings } = await withStalledToolCall(t, {
    toolName: "bash",
    command: "sleep 999",
    timeouts: true,
    configure: (config) => {
      config.runTimeoutSeconds = 2;
      config.quietTimeoutSeconds = 0;
      config.toolCallStallSeconds = 0;
    },
    during: (clock) => clock.advance(10_000), // well past both disabled windows
  });
  assert.equal(result.timedOut, true, "the tick deadline owns the end of the run");
  assert.equal(result.quietKilled, false, "no quiet interval runs to kill it");
  assert.deepEqual(warnings, [], "no stall interval runs to warn");
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
  await withPi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm run test 2>&1 | tail -8" } })}'`,
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "npm run test -- --runInBand --detectOpenHandles > /tmp/quiet.log" } })}'`,
      `exec sleep 30`,
    ].join("\n"),
    async () => {
      const opts = runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) });
      const run = runPi(opts);
      await waitForLogLines(opts.rawLogFile, "tool_execution_start");
      clock.advance(30_000); // well past the stall threshold, then past the quiet window
      const result = await run;
      assert.equal(result.quietKilled, true, "the quiet watchdog still owns the kill");
      assert.deepEqual(warnings, [], "piped or redirected stdout makes silence meaningless");
    },
  );
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
  // error (the tick-level regression for this lives in test/runner.test.ts).
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
  await withPi(
    [
      `printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"h\\303'`,
      `sleep 0.3`,
      `printf '\\251llo"}],"usage":{"totalTokens":5,"output":5,"cost":{"total":0}},"stopReason":"stop"}}\n'`,
    ].join("\n"),
    async () => {
      const result = await runPi(runPiFixture(dir));
      assert.equal(result.ok, true);
      assert.equal(result.finalText, "héllo", "the split character decodes intact");
      assert.equal(result.turns, 1);
      // The raw log is written from the same decoded lines — it must be clean too.
      assert.ok(!fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").includes("\uFFFD"));
    },
  );
});

test("a multi-byte character straddling a stderr chunk boundary survives intact", async () => {
  // The stderr buffer is built with a raw Buffer.toString("utf8") per chunk — unlike
  // stdout's StringDecoder — and it is where the run's failure message and the
  // stderr-keyed matchers (crash, stream-severed, config) read. A non-ASCII character whose
  // bytes split across two 'data' events is replaced with U+FFFD, garbling that text. The
  // fake pi writes its stderr in two paced writes with é's UTF-8 bytes (0xC3 0xA9) split
  // between them, then exits non-zero so the stderr becomes the reported errorMessage.
  const dir = tmpdir();
  await withPi(
    [
      `printf 'boom h\\303' >&2`,
      `sleep 0.3`,
      `printf '\\251llo' >&2`,
      `exit 1`,
    ].join("\n"),
    async () => {
      const result = await runPi(runPiFixture(dir));
      assert.equal(result.ok, false);
      assert.match(result.errorMessage ?? "", /boom héllo/, "the split character decodes intact");
    },
  );
});

// Session lifecycle: every tick starts a fresh pi session (context never accumulates
// across ticks); --continue exists only for the within-tick transient retry.

test("every tick starts a fresh pi session", async () => {
  const repo = makeRepo();
  await initProject(repo, "fresh session test");
  const argsFile = path.join(tmpdir(), "argv.log");
  // The prompt argument spans many lines, so record only the flags, one run per line.
  await withPi(
    [logFlagsTo(argsFile), `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "clean");
      await runner.tick();
      await runner.tick();
      const runs = readRunLines(argsFile);
      assert.equal(runs.length, 2);
      for (const [i, run] of runs.entries()) {
        assert.ok(!run.includes("--continue"), `tick ${i + 1} must not resume a prior session`);
        assert.ok(run.includes("-n"), `tick ${i + 1} names its fresh session`);
      }
    },
  );
});

test("a context-exceeded error fails the tick with the real cause", async () => {
  const repo = makeRepo();
  await initProject(repo, "context overflow test");
  await withPi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Context size has been exceeded." })}'`,
      `exit 1`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "clean");
      assert.equal((await runner.tick()).result, "error");
      assert.ok(runner.state.lastError, "the error is surfaced on the loop state");
    },
  );
});

// Run markers: every run writes one marker line to the shared raw log before any of pi's
// output, carrying the run's kind and (when set) its label, so the dashboards can demultiplex
// interleaved author and gate runs by marker and every transcript surface can render
// `── review @ <ts> ──` for a labeled one.

test("a labeled run writes exactly one kind+label marker line as the raw log's first line", async () => {
  const dir = tmpdir();
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: approve", { tokens: 5 })}'`, async () => {
    await runPiVerified(runPiFixture(dir, { kind: "gate", label: "review" }));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").replace(/,"ts":\d+/, "");
    assert.equal(
      content,
      `{"type":"tumwater_run","kind":"gate","agent":"pi","label":"review"}\n${assistantLine("VERDICT: approve", { tokens: 5 })}\n`,
      "the marker precedes every pi output line and appears exactly once",
    );
  });
});

test("an unlabeled run writes one kind-only marker and no label", async () => {
  const dir = tmpdir();
  await withPi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`, async () => {
    await runPiVerified(runPiFixture(dir));
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").replace(/,"ts":\d+/, "");
    assert.equal(
      content,
      `{"type":"tumwater_run","kind":"author","agent":"pi"}\n${assistantLine("done", { tokens: 5 })}\n`,
      "the author run's marker carries only its kind",
    );
  });
});

test("a failed labeled run still flushes its marker (the stale-marker case)", async () => {
  // A reviewer spawn that dies before emitting anything leaves the marker alone in the log.
  // The renderer consumes its label at the next agent_start, so it can mislabel at most the
  // following separator and never leaks past one run — pinned here at the source.
  const dir = tmpdir();
  await withPi("exit 1", async () => {
    const before = Date.now();
    await runPi(runPiFixture(dir, { kind: "gate", label: "review" }));
    const after = Date.now();
    const content = fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8");
    assert.equal(content.endsWith("\n"), true);
    const marker = JSON.parse(content.trimEnd());
    const { ts, ...rest } = marker;
    assert.deepEqual(rest, { type: "tumwater_run", kind: "gate", agent: "pi", label: "review" });
    assert.ok(ts >= before && ts <= after);
  });
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
  // One fresh fake per stream open, so a runPiVerified retry cannot append to the previous
  // attempt's buffered writes. The target path comes from the createWriteStream call so the
  // native log (a second stream) lands in its own file, not the raw log being asserted.
  const makeStalled = (target: string) => {
    let pending = "";
    return Object.assign(new EventEmitter(), {
      write: (data: string) => {
        pending += data;
        return true;
      },
      end: (cb?: () => void) => {
        // The threadpool "completes" the queued writes one macrotask after end().
        setImmediate(() => {
          fs.appendFileSync(target, pending);
          cb?.();
        });
      },
    });
  };
  await withPi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`, async () => {
    const restoreStream = patchFsMethod(
      "createWriteStream",
      () => (target: unknown) => makeStalled(String(target)),
    );
    try {
      await runPiVerified(runPiFixture(dir, { rawLogFile: file }));
      const content = fs.readFileSync(file, "utf8").replace(/,"ts":\d+/, "");
      assert.equal(
        content,
        `{"type":"tumwater_run","kind":"author","agent":"pi"}\n${assistantLine("done", { tokens: 5 })}\n`,
        "the raw log is complete on the turn runPi resolves — nothing may still be in flight",
      );
    } finally {
      restoreStream();
    }
  });
});

test("a broken raw log degrades to a lost log, never a stuck tick", async () => {
  // The stream dies instead of finishing ('error' fires, 'finish' never does): runPi must
  // still settle with the run's real result rather than hang the runner.
  const dir = tmpdir();
  const brokenEvents = new EventEmitter();
  const broken = Object.assign(brokenEvents, {
    write: (_data: string) => true,
    end: () => {
      setImmediate(() => brokenEvents.emit("error", new Error("ENOSPC: no space left on device")));
    },
  });
  await withPi(`printf '%s\n' '${assistantLine("done", { tokens: 5 })}'`, async () => {
    const restoreStream = patchFsMethod("createWriteStream", () => () => broken);
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
      restoreStream();
    }
  });
});

test("a missing pi binary fails the tick with an error", async () => {
  const repo = makeRepo();
  await initProject(repo, "spawn failure test");
  // A PATH with git but no pi, so only the pi spawn fails.
  const binDir = gitOnlyBinDir();
  const restorePath = pathReplace(binDir);
  try {
    const runner = makeRoleRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(String(runner.state.lastError), /failed to spawn pi/);
  } finally {
    restorePath();
  }
});

// pi crashing on malformed JSON (a torn model-server chunk): five ticks in the first 18 days died
// with "Unterminated string in JSON at position N" as their only error, one of them 2 h 39 m of
// director work. The session survives on disk, so the harness treats it as transient
// (src/runner/runner-pi.ts retries once with --continue) — flagged from pi's stderr at exit,
// and only for exits the harness itself did not cause.
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
  // The pattern itself is what the runner relies on: pin the phrasings Node's JSON.parse produces.
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
  // A provider pausing itself team-wide surfaces the same prose on stderr as in an event.
  const paused = await runFakePi(
    `printf '%s\\n' "503 Provider 'deepinfra' is currently failing for model 'deepseek-ai/DeepSeek-V4.1-Flash' and has been paused by the provider" >&2\nexit 1`,
  );
  assert.equal(paused.transientBackend, true);
  assert.equal(paused.backendKind, "server");
});

// pi's stderr warning when a requested model id has no exact definition: pi clones the
// provider's default model, inheriting that default's price and context window, so a
// mistyped or vendor-suffixed id silently misprices the run (BUGS.md 2026-10-06). Captured
// from stderr so the runner's warning event can name it.
test("runPi captures pi's fallback-clone stderr warning for an undefined model id", async () => {
  const r = await runFakePi(
    `printf '%s\\n' 'Warning: Model "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra" not found for provider "huggingface". Using custom model id.' >&2\nprintf '%s\\n' '${assistantLine("done", { tokens: 5 })}'`,
  );
  assert.equal(r.ok, true);
  assert.match(r.fallbackClone ?? "", /not found for provider "huggingface"/);
  // The pattern itself is what the runner relies on: pin the spelling pi emits.
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

// --- Blind image reads (plans/image-input.md "Detecting a blind read") ---
// A read whose result text carries pi's non-vision note is flagged blind; the runner kills
// an AUTHORING run at once (before any further output), while a GATE run only records it.

test("an authoring run that reads an image on a blind model is killed and fails", async () => {
  const dir = tmpdir();
  const calls: Array<[string, "fail" | "logged"]> = [];
  // pi emits the read start, its end carrying the non-vision note, then would go on — but
  // the runner must kill it before that next event.
  await withPi(
    [
      `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/x/shot.png" } })}'`,
      `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "Read image file [png]\\n[Current model does not support images. The image will be omitted from this request.]" }] }, isError: false })}'`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
    async () => {
      const result = await runPi(
        runPiFixture(dir, {
          kind: "author",
          onBlindRead: (path, action) => calls.push([path, action]),
        }),
      );
      assert.equal(result.ok, false, "the blind read fails the authoring run");
      assert.deepEqual(result.imageBlind, { path: "/x/shot.png" });
      assert.match(result.errorMessage ?? "", /read \/x\/shot\.png, but .* cannot read images/);
      assert.deepEqual(calls, [["/x/shot.png", "fail"]], "the authoring run earned the fail action");
    },
  );
});

test("a gate run that reads an image on a blind model is logged, not killed", async () => {
  const dir = tmpdir();
  const calls: Array<[string, "fail" | "logged"]> = [];
  await withPi(
    [
      `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/x/shot.png" } })}'`,
      `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "Read image file [png]\\n[Current model does not support images. The image will be omitted from this request.]" }] }, isError: false })}'`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
    ].join("\n"),
    async () => {
      const result = await runPi(
        runPiFixture(dir, {
          kind: "gate",
          onBlindRead: (path, action) => calls.push([path, action]),
        }),
      );
      // A gate run is NOT killed: it kept going and finished its verdict.
      assert.equal(result.ok, true, "a gate blind read does not fail the run");
      assert.deepEqual(result.imageBlind, { path: "/x/shot.png" }, "the read is still recorded");
      assert.deepEqual(calls, [["/x/shot.png", "logged"]], "the gate run earned the logged action");
    },
  );
});

test("a pi run finds the notes shim dir first on its PATH", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const pathFile = path.join(dir, "path.txt");
  await withPi(
    `printf '%s\n' '${assistantLine("done", { tokens: 1 })}'\nprintf '%s\\n' "$PATH" >> "${pathFile}"`,
    async () => {
      const result = await runPi(runPiFixture(dir));
      assert.equal(result.ok, true, `${result.errorMessage}`);
      const p = fs.readFileSync(pathFile, "utf8").trim();
      const binDir = path.join(dir, ".tumwater", "bin");
      assert.ok(
        p.startsWith(`${binDir}${path.delimiter}`),
        `the notes shim dir is first on PATH: ${p}`,
      );
    },
  );
});

// BUGS.md 2026-10-18: a session dir with no `.tumwater` ancestor (a lab script, a smoke run, a
// prompt-lab replay) must not mint one. Pre-fix, runAgent installed the notes shim under
// `teamRootOf(sessionDir)`, whose no-ancestor fallback — dirname(dirname(sessionDir)) — landed on
// the shared $TMPDIR, writing `$TMPDIR/.tumwater/bin/tumwater-notes` and breaking every other
// suite on the host (findTumwaterRoot/writeFullOutput).
test("a run with no .tumwater ancestor mints none above its session dir (regression)", async () => {
  // The run owns a fresh temporary subtree, so the walk from its session dir has no `.tumwater`
  // ancestor (the fix guarantees no run mints `$TMPDIR/.tumwater`, so the suite's per-run root
  // stays clean). Pre-fix, teamRootOf's no-ancestor fallback — dirname(dirname(sessionDir)) —
  // landed INSIDE `top` and wrote `<top>/.tumwater/bin/tumwater-notes` here (BUGS.md 2026-10-18).
  const top = tmpdir();
  const sessions = path.join(top, "a", "sessions");
  fs.mkdirSync(path.join(top, "a"));
  await withIdlePi(async () => {
    const result = await runPi(runPiFixture(top, { sessionDir: sessions }));
    assert.equal(result.ok, true, `${result.errorMessage}`);
  });
  // No `.tumwater` appears anywhere in the tree the run owned above its session dir.
  for (let dir = sessions; ; dir = path.dirname(dir)) {
    assert.equal(
      fs.existsSync(path.join(dir, ".tumwater")),
      false,
      `no .tumwater minted at ${path.join(dir, ".tumwater")}`,
    );
    if (dir === top) break;
  }
});
