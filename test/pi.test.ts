import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSIENT_PI_CRASH, piArgs, resolveAgentBin, runPi, type PiRunOptions } from "../src/pi.js";
import { PiStreamParser } from "../src/pi-stream.js";
import { toolUpdateHasContent } from "../src/pi-event-line.js";
import type { PiRunResult } from "../src/types.js";
import { REFUSED_SENTINEL } from "../src/reply-contract.js";
import { configForRole, defaultConfig, loadConfig } from "../src/config.js";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { assistantLine, errorLine, fakePi, makeRepo, thinkingOnlyLine, tmpdir } from "./util.js";

// plans/portability.md §5/7: the agent binary is TUMWATER_PI_BIN → agentBin → "pi". The
// resolver is precedence only (no filesystem calls — resolvability is the preflight sites'
// job); a path-shaped value is normalized against the process cwd AT RESOLUTION TIME, so
// the spawn — which runs with each tick's worktree as cwd — lands on the same file the run
// preflight and doctor checked.
test("resolveAgentBin: TUMWATER_PI_BIN beats agentBin beats the PATH default", () => {
  assert.deepEqual(resolveAgentBin({}), { bin: "pi", source: "default" });
  assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
    bin: "/opt/pi/bin/pi",
    source: "config",
  });

  process.env.TUMWATER_PI_BIN = "/x/pi-override";
  try {
    assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
      bin: "/x/pi-override",
      source: "env",
    });
    // A whitespace value falls through to config, so an empty export cannot wedge the fleet.
    process.env.TUMWATER_PI_BIN = "  ";
    assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
      bin: "/opt/pi/bin/pi",
      source: "config",
    });
    process.env.TUMWATER_PI_BIN = "";
    assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
      bin: "/opt/pi/bin/pi",
      source: "config",
    });
  } finally {
    delete process.env.TUMWATER_PI_BIN;
  }
});

test("resolveAgentBin normalizes a path-shaped value against the process cwd; a bare name is left to PATH", () => {
  const rel = resolveAgentBin({ agentBin: "bin/pi" });
  assert.equal(rel.source, "config");
  assert.equal(rel.bin, path.resolve("bin/pi")); // absolute, so the worktree cwd cannot redirect it

  const envRel = resolveAgentBin({});
  process.env.TUMWATER_PI_BIN = "./scripts/pi";
  try {
    const r = resolveAgentBin({});
    assert.equal(r.source, "env");
    assert.equal(r.bin, path.resolve("scripts/pi"));
  } finally {
    delete process.env.TUMWATER_PI_BIN;
  }
  assert.equal(envRel.bin, "pi"); // sanity: no env leak into the default case

  assert.equal(resolveAgentBin({ agentBin: "pi-wrapper" }).bin, "pi-wrapper");
  assert.equal(resolveAgentBin({ agentBin: "pi-wrapper" }).source, "config");
});

test("parser keeps the last non-empty assistant text and sums usage", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it", { tokens: 100, output: 40, cost: 0.01 }) + "\n");
  parser.feed(assistantLine("final answer\nSUMMARY: do it", { tokens: 50, output: 10, cost: 0.02 }) + "\n");
  assert.equal(parser.finalText, "final answer\nSUMMARY: do it");
  assert.equal(parser.outputTokens, 50, "output sums across turns");
  assert.equal(parser.peakContextTokens, 100, "peak is the largest request context, not a sum");
  assert.ok(Math.abs(parser.costUsd - 0.03) < 1e-9);
  assert.equal(parser.stopReason, "stop");
  // plans/commit-bodies.md: turns counts completed assistant messages — it feeds
  // PiRunResult.turns, which the commit trailer and the high-friction flag read.
  assert.equal(parser.turns, 2, "one turn per assistant message_end");
});

test("parser counts zero turns when no assistant message completes", () => {
  // Structural events (turn boundaries), streaming updates, and user messages are not
  // completed assistant turns — only an assistant message_end counts one.
  const parser = new PiStreamParser();
  parser.feed(JSON.stringify({ type: "turn_start" }) + "\n");
  parser.feed(
    JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    }) + "\n",
  );
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    }) + "\n",
  );
  assert.equal(parser.turns, 0);
});

test("parser keeps a sentinel declared in an intermediate message (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("TUMWATER_NOTHING_TO_DO", { tokens: 10 }) + "\n");
  parser.feed(assistantLine("all done", { tokens: 5 }) + "\n");
  assert.equal(parser.finalText, "all done", "finalText stays the last message");
  assert.ok(parser.declaredNothingToDo, "sentinel from an earlier turn is not lost");
});

test("parser does not flag nothing-to-do when no message carries the sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it") + "\n");
  parser.feed(assistantLine("all done\nSUMMARY: x") + "\n");
  assert.equal(parser.declaredNothingToDo, false);
});

// The refusal flag and reason must survive later messages, mirroring the nothing-to-do sentinel
// (a compliant run emits the sentinel once, in its final message — but a closing remark after it
// must not erase the declaration).

test("parser records refused + reason from the sentinel line", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`declining\n${REFUSED_SENTINEL}: plan conflicts with PRINCIPLES.md`) + "\n");
  assert.equal(parser.refused, true);
  assert.equal(parser.refusedReason, "plan conflicts with PRINCIPLES.md");
});

test("parser keeps a refusal declared in an intermediate message (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: too risky to land`) + "\n");
  parser.feed(assistantLine("closing remarks about the refusal") + "\n");
  assert.equal(parser.finalText, "closing remarks about the refusal", "finalText stays the last message");
  assert.equal(parser.refused, true, "refusal from an earlier turn is not lost");
  assert.equal(parser.refusedReason, "too risky to land");
});

test("parser sets refused with an empty reason for a bare sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}`) + "\n");
  assert.equal(parser.refused, true);
  assert.equal(parser.refusedReason, "", "no parseable reason — the loop falls back to 'no reason given'");
});

test("parser flags a mid-sentence mention but leaves the reason empty", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`I would say ${REFUSED_SENTINEL}: no, let me keep going`) + "\n");
  assert.equal(parser.refused, true, "boolean scan is deliberately loose (whole-reply includes)");
  assert.equal(parser.refusedReason, "", "anchored extraction rejects the mid-sentence mention");
});

test("parser keeps the first parseable reason across messages", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: original objection`) + "\n");
  parser.feed(assistantLine(`${REFUSED_SENTINEL}: a later, different line`) + "\n");
  assert.equal(parser.refusedReason, "original objection", "first reason wins; a compliant run emits the sentinel once");
});

test("parser does not set refused when no message carries the sentinel", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("all done\nSUMMARY: fix it") + "\n");
  assert.equal(parser.refused, false);
  assert.equal(parser.refusedReason, "");
});

test("parser flags a contentless final message (generation cut off mid-stream)", () => {
  // A thinking-only LAST message is the cut-off signature (observed live: pi clamped
  // max_output_tokens to 16 near the declared context window and LM Studio reported the
  // truncation as a normal stop).
  const parser = new PiStreamParser();
  parser.feed(assistantLine("reading files") + "\n");
  parser.feed(thinkingOnlyLine("git.ts looks clean. Next let's check gui.ts (16:3", { output: 16 }) + "\n");
  assert.ok(parser.finalMessageContentless, "thinking-only final message is contentless");
  assert.equal(parser.finalText, "reading files", "earlier text is retained for the summary");

  // Only the LAST message counts: a substantive message after a cut-off clears the flag.
  const recovered = new PiStreamParser();
  recovered.feed(thinkingOnlyLine("hmm") + "\n");
  recovered.feed(assistantLine("SUMMARY: fix it") + "\n");
  assert.equal(recovered.finalMessageContentless, false);

  // A tool call is substantive content even without a text block.
  const toolOnly = new PiStreamParser();
  toolOnly.feed(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash" }],
        stopReason: "toolUse",
      },
    }) + "\n",
  );
  assert.equal(toolOnly.finalMessageContentless, false);
});

test("parser records that pi auto-compacted the session", () => {
  const parser = new PiStreamParser();
  assert.equal(parser.compacted, false);
  parser.feed(JSON.stringify({ type: "compaction_start", reason: "threshold" }) + "\n");
  assert.ok(parser.compacted);
});

test("parser handles chunked lines and ignores noise", () => {
  const parser = new PiStreamParser();
  const line = assistantLine("hello", { tokens: 5 });
  parser.feed(line.slice(0, 20));
  parser.feed(line.slice(20) + "\nnot json\n" + JSON.stringify({ type: "turn_start" }) + "\n");
  assert.equal(parser.finalText, "hello");
  assert.equal(parser.peakContextTokens, 5);
});

test("parser skips valid-JSON non-object lines without throwing or counting progress", () => {
  // pi's stream is one JSON object per line. A stray `null` used to throw a TypeError out of
  // feed() (reading `.errorMessage` off null), and a scalar passed the truthy check and was
  // counted as forward progress — resetting the hang watchdog for a line that proves nothing.
  const parser = new PiStreamParser();
  parser.feed("null\n5\n[]\n\"noise\"\n");
  assert.equal(parser.progressCount, 0, "non-object lines are not forward progress");
  parser.feed(JSON.stringify({ type: "turn_start" }) + "\n");
  assert.equal(parser.progressCount, 1, "a real event still counts");
});

test("parser records error messages and clears them after a later success", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
    }) + "\n",
  );
  assert.equal(parser.errorMessage, "Connection error.");
  assert.equal(parser.stopReason, "error");
  parser.feed(assistantLine("recovered") + "\n");
  assert.equal(parser.errorMessage, undefined);
  assert.equal(parser.stopReason, "stop");
});

test("parser flags the LM Studio predict-stream timeout as a transient server failure (regression)", () => {
  const parser = new PiStreamParser();
  parser.feed(
    errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.") + "\n",
  );
  assert.equal(parser.transientServerTimeout, true);
  assert.equal(parser.contextExceeded, false, "a timeout is not a context overflow");
  assert.equal(parser.stopReason, "error");
});

test("parser does not flag other errors as transient server timeouts", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine("Connection error.") + "\n");
  parser.feed(
    JSON.stringify({ type: "error", errorMessage: "request timed out after 30s" }) + "\n",
  );
  assert.equal(parser.transientServerTimeout, false);
});

test("parser flags a provider 429 rate-limit rejection as transient, with its Retry-After hint (regression, BUGS.md 2026-09-21)", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine('429 "Rate limit exceeded"') + "\n");
  assert.equal(parser.transientRateLimit, true);
  assert.equal(parser.retryAfterSeconds, undefined, "no hint in the observed fleet error text");
  assert.equal(parser.transientServerTimeout, false, "a rate limit is its own class, not a stream timeout");
});

test("parser captures a Retry-After delay from the rate-limit error text and ignores it on other errors", () => {
  const parser = new PiStreamParser();
  parser.feed(errorLine("Too Many Requests — retry after 30s") + "\n");
  assert.equal(parser.transientRateLimit, true);
  assert.equal(parser.retryAfterSeconds, 30);
  const other = new PiStreamParser();
  other.feed(errorLine("gateway retry after 30s") + "\n");
  assert.equal(other.transientRateLimit, false, "a Retry-After hint outside a rate limit is not one");
  assert.equal(other.retryAfterSeconds, undefined);
});

test("parser ignores user message_end events", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    }) + "\n",
  );
  assert.equal(parser.finalText, "");
});

// Progress counting feeds the quiet watchdog (runPi kills a run that stops making progress):
// structural/boundary events count; streaming deltas never do. pi's JSON protocol strips the
// cumulative message snapshot from message_update lines, so they carry nothing this parser
// acts on — and skipping them before parsing is what keeps a zombie stream's content-free
// keepalives (in any shape) from resetting the watchdog clock.

test("message updates never count as progress; boundary events do", () => {
  const parser = new PiStreamParser();
  // Current wire format: constant-size usage plus a small delta event, no cumulative message.
  const update = (delta: string) =>
    JSON.stringify({
      type: "message_update",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
    }) + "\n";
  parser.feed(update("a"));
  parser.feed(update("ab"));
  assert.equal(parser.progressCount, 0, "deltas are not progress");
  parser.feed(JSON.stringify({ type: "turn_end" }) + "\n");
  assert.equal(parser.progressCount, 1, "structural events are progress");
});

test("message updates are skipped before parsing even in the old cumulative shape", () => {
  const parser = new PiStreamParser();
  // The pre-strip wire format carried a growing message snapshot; whatever arrives under the
  // message_update type is verifiably a delta and must not count as progress.
  parser.feed(
    JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "a".repeat(50) }] },
    }) + "\n",
  );
  assert.equal(parser.progressCount, 0);
});

// The quiet watchdog's kill is reported as quietKilled, not timedOut: a hung tool call leaves
// its session and worktree edits intact, so the loop resumes them instead of discarding hours
// of work for the next tick's reset (BUGS.md 2026-09-12).

test("a stalled run is reported as quiet-killed, not timed out", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // the watchdog checks every second and kills after ~2 s of silence
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const result = await runPi(runPiFixture(dir, { config }));
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
// watchdog killed a run that never had the chance to speak. A run with zero progress gets
// one extra full quiet window before the kill; this pins that a slow-to-speak run completes
// where the old single window killed it.
test("a run that is slow to speak is not quiet-killed during startup", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 5; // old single window killed a silent run at the ~7.5 s check
  const restore = fakePi(
    [
      `sleep 8`, // speaks past the old kill point, inside the doubled startup window
      `printf '%s\n' '${assistantLine("done\nSUMMARY: spoke late")}'`,
    ].join("\n"),
  );
  try {
    const result = await runPi(runPiFixture(dir, { config }));
    assert.equal(result.quietKilled, false, "startup latency is not a hung tool call");
    assert.equal(result.ok, true, "the run completes once pi finally speaks");
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

test("runPi's spawn-error message names the resolved binary and its source", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.agentBin = "/no/such/dir-xyz/pi-here";
  const result = await runPi(runPiFixture(dir, { config }));
  assert.equal(result.ok, false);
  assert.match(result.errorMessage ?? "", /failed to spawn \/no\/such\/dir-xyz\/pi-here/);
  assert.match(result.errorMessage ?? "", /resolved from agentBin in tumwater\.json/);
});

test("parser tracks open tool calls across start, update, and end", () => {
  const parser = new PiStreamParser();
  assert.equal(parser.openToolCalls.length, 0);
  parser.feed(
    JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "find / -name x" } }) + "\n",
  );
  assert.deepEqual(
    parser.openToolCalls.map((c) => [c.id, c.label]),
    [["c1", "bash find / -name x"]],
    "the open call is tracked by id with a label that names the command",
  );
  const call = parser.openToolCalls[0];
  assert.ok(call, "one entry for the started call");
  // A content-bearing update moves the activity clock...
  call.lastActivityAt -= 60_000; // simulate a minute of silence
  parser.feed(
    JSON.stringify({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "some output" }] },
    }) + "\n",
  );
  assert.ok(call.lastActivityAt > Date.now() - 1000, "content update moves the clock");
  // ...but an empty-content one (bash emits it right after start) does not.
  call.lastActivityAt -= 60_000;
  const before = call.lastActivityAt;
  parser.feed(
    JSON.stringify({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
      partialResult: { content: [] },
    }) + "\n",
  );
  assert.equal(call.lastActivityAt, before, "empty-content update does not move the clock");
  // An end clears only its own call — parallel siblings stay tracked.
  parser.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/a/b.ts" } }) + "\n");
  parser.feed(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false }) + "\n");
  assert.deepEqual(parser.openToolCalls.map((c) => c.id), ["c2"]);
});

test("a start without toolName still names the command (or 'tool') in the open-call label", () => {
  const parser = new PiStreamParser();
  // pi omits toolName on some start events: the warning must name the bare command, with no
  // leading space and no empty name.
  parser.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", args: { command: "sleep 999" } }) + "\n");
  assert.deepEqual(
    parser.openToolCalls.map((c) => c.label),
    ["sleep 999"],
    "no toolName — the label is the bare command, not ' sleep 999' or ''",
  );
  // No name and no recognizable arg falls back to 'tool', like progress.ts's stall flag.
  parser.feed(JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", args: {} }) + "\n");
  assert.deepEqual(parser.openToolCalls.map((c) => c.label), ["sleep 999", "tool"]);
});

test("a stalled call without toolName warns with the bare command named", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  // 5s/2s: the warning must land before the kill, and a 1s gap loses that ordering to jitter
  // under concurrent suites (BUGS.md 2026-09-18).
  config.quietTimeoutSeconds = 5;
  config.toolCallStallSeconds = 2;
  const warnings: string[] = [];
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", args: { command: "sleep 999" } })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const result = await runPi(
      runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) }),
    );
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

test("a stalled tool call warns once with the command named", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  // 5s/2s: see the sibling above — the one-warning-per-call invariant needs the warning to fire
  // while the run is still alive, which a 1s margin cannot guarantee under load.
  config.quietTimeoutSeconds = 5;
  config.toolCallStallSeconds = 2;
  const warnings: string[] = [];
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
  );
  try {
    const result = await runPi(
      runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) }),
    );
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

test("toolCallStallSeconds 0 disables the stall warning", async () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // the kill still happens...
  config.toolCallStallSeconds = 0; // ...but no warning accompanies it
  const warnings: string[] = [];
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  try {
    const result = await runPi(
      runPiFixture(dir, { config, onToolCallStalled: (message) => warnings.push(message) }),
    );
    assert.equal(result.quietKilled, true);
    assert.deepEqual(warnings, []);
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
    [
      `flags=""`,
      `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
      `echo "run:$flags" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
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

test("parser flags context-exceeded errors surfaced in retry events", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "auto_retry_start",
      attempt: 3,
      errorMessage:
        'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}',
    }) + "\n",
  );
  assert.equal(parser.contextExceeded, true);
  const clean = new PiStreamParser();
  clean.feed(JSON.stringify({ type: "auto_retry_start", errorMessage: "Connection error." }) + "\n");
  assert.equal(clean.contextExceeded, false);
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
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
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
  const binDir = tmpdir();
  fs.symlinkSync(execSync("which git", { encoding: "utf8" }).trim(), path.join(binDir, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
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
