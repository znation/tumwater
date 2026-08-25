import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { assistantLine, fakePi, makeRepo, sh } from "./util.js";

async function initializedRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "quiet watchdog test");
  return repo;
}

test("a pi run that goes silent is killed as hung and never commits partial work", async () => {
  const repo = await initializedRepo();
  // Emits one line (so it is not silent from birth), writes a partial edit, then hangs
  // like an interactive tool waiting for stdin. `exec` so the signal reaches sleep.
  const restore = fakePi(
    [`printf '%s\n' '${assistantLine("starting work")}'`, `echo partial > partial.txt`, `exec sleep 60`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 1;
    config.tickTimeoutSeconds = 3600; // The watchdog, not the tick timeout, must fire.
    const runner = new LoopRunner(repo, "improve", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const started = Date.now();
    const outcome = await runner.tick();
    assert.ok(Date.now() - started < 30_000, "killed by the watchdog, not the tick timeout");
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
    assert.equal(sh(repo, "git", "rev-parse", "main"), before, "nothing landed on main");
    assert.ok(!fs.existsSync(path.join(repo, "partial.txt")));
  } finally {
    restore();
  }
});

test("a slow but talkative pi run is not killed by the quiet watchdog", async () => {
  const repo = await initializedRepo();
  // Streams a line every ~300ms for ~2.4s — always slower than the 1s quiet window would
  // allow if it were measuring total runtime, but never silent longer than the window.
  const chatter = Array.from({ length: 8 }, () => `sleep 0.3\nprintf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`);
  const restore = fakePi([...chatter, `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"));
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 1;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "run completed despite taking longer than the quiet window");
  } finally {
    restore();
  }
});

test("quietTimeoutSeconds 0 disables the watchdog", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [`sleep 2`, `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 0;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change");
  } finally {
    restore();
  }
});

test("config validation accepts 0 and rejects negatives for quietTimeoutSeconds", async () => {
  const { validateConfig } = await import("../src/config.js");
  validateConfig({ quietTimeoutSeconds: 0 });
  validateConfig({ quietTimeoutSeconds: 1800 });
  assert.throws(() => validateConfig({ quietTimeoutSeconds: -5 }), /quietTimeoutSeconds/);
  assert.throws(() => validateConfig({ quietTimeoutSeconds: "long" }), /quietTimeoutSeconds/);
});

test("a zombie stream dripping content-free keepalive updates is killed as hung", async () => {
  const repo = await (async () => {
    const r = makeRepo();
    await initProject(r, "zombie stream test");
    return r;
  })();
  // Emits an identical empty message_update every 200ms forever — bytes without progress,
  // exactly what a dead generation's kept-alive connection looks like.
  const keepalive = JSON.stringify({
    type: "message_update",
    message: { role: "assistant", content: [], usage: { totalTokens: 0 } },
  });
  const restore = fakePi(
    [`while true; do`, `  printf '%s\n' '${keepalive}'`, `  sleep 0.2`, `done`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 1;
    config.tickTimeoutSeconds = 3600;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const started = Date.now();
    const outcome = await runner.tick();
    assert.ok(Date.now() - started < 30_000, "killed by the progress watchdog");
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
  } finally {
    restore();
  }
});

test("message updates whose content grows count as progress and keep the run alive", async () => {
  const { PiStreamParser } = await import("../src/pi.js");
  const parser = new PiStreamParser();
  const update = (text: string) =>
    JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  parser.feed(update("a"));
  parser.feed(update("ab"));
  const afterGrowth = parser.progressCount;
  assert.ok(afterGrowth >= 2, "growing updates are progress");
  parser.feed(update("ab"));
  parser.feed(update("ab"));
  assert.equal(parser.progressCount, afterGrowth, "size-identical keepalive updates are not progress");
  parser.feed(JSON.stringify({ type: "turn_end" }) + "\n");
  assert.equal(parser.progressCount, afterGrowth + 1, "structural events are progress");
});

test("the per-message high-water mark resets so a short message after a long one still counts", async () => {
  const { PiStreamParser } = await import("../src/pi.js");
  const parser = new PiStreamParser();
  const update = (text: string) =>
    JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

  // Message one streams to a large size, setting the high-water mark.
  parser.feed(update("a".repeat(50)));
  parser.feed(update("a".repeat(200)));
  const afterFirst = parser.progressCount;
  assert.equal(afterFirst, 2, "growing updates of message one are progress");

  // A structural event ends the message and must reset the mark to zero...
  parser.feed(JSON.stringify({ type: "turn_end" }) + "\n");
  const afterBoundary = parser.progressCount;
  assert.equal(afterBoundary, afterFirst + 1);

  // ...so a second, much shorter message still registers progress as it streams.
  // Without the reset its size never exceeds the first message's high-water mark and a
  // healthy run alternating long/short messages would look like a zombie to the watchdog.
  parser.feed(update("b".repeat(50)));
  assert.equal(
    parser.progressCount,
    afterBoundary + 1,
    "a shorter next message must still count as progress",
  );
});

test("thinking-only growth counts as progress (reasoning models stream thinking before text)", async () => {
  const { PiStreamParser } = await import("../src/pi.js");
  const parser = new PiStreamParser();
  const thinkUpdate = (thinking: string) =>
    JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking }] } }) + "\n";

  // A run that spends minutes streaming a reasoning block with no text yet must not be
  // killed as hung: growth in the thinking blocks is real progress.
  parser.feed(thinkUpdate("hmm"));
  assert.equal(parser.progressCount, 1);
  parser.feed(thinkUpdate("hmm, let me think harder"));
  assert.equal(parser.progressCount, 2, "growing thinking is progress");
  parser.feed(thinkUpdate("hmm, let me think harder")); // identical size: a keepalive
  assert.equal(parser.progressCount, 2);
});
