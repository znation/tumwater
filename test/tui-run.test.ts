import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { runTui } from "../src/tui.js";
import { makeRepo } from "./util.js";

/** A fake-TTY harness around runTui: no real terminal is involved. The isTTY flags are
 * faked, raw mode / resume / pause are stubbed and recorded, readline's keypress emitter
 * is no-op'd (so the test runner's stdin stream is never touched), every stdout write is
 * captured as a frame, and setInterval/clearInterval are stubbed so a failed test cannot
 * leave a live render timer behind. The keypress handler runTui registers on stdin is
 * intercepted and replayed with synthetic keys. */
function startTui(root: string) {
  const frames: string[] = [];
  const rawModes: boolean[] = [];
  let clearCalls = 0;
  let keypressHandler: ((str?: string, key?: readline.Key) => void) | null = null;

  const origWrite = process.stdout.write.bind(process.stdout);
  const origEmitKeypressEvents = readline.emitKeypressEvents;
  const origStdinOn = process.stdin.on.bind(process.stdin);
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  (process.stdout as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { columns?: number }).columns = 100;
  (process.stdout as { rows?: number }).rows = 40;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    frames.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdin as { setRawMode?: (on: boolean) => void }).setRawMode = (on) => rawModes.push(on);
  (process.stdin as { resume?: () => void }).resume = () => {};
  (process.stdin as { pause?: () => void }).pause = () => {};
  readline.emitKeypressEvents = (() => {}) as unknown as typeof origEmitKeypressEvents;
  process.stdin.on = ((ev: string, fn: (...args: unknown[]) => void) => {
    if (ev === "keypress") {
      keypressHandler = fn as (str?: string, key?: readline.Key) => void;
      return process.stdin; // not registered on the real stream: nothing emits keypress in tests
    }
    return origStdinOn(ev, fn);
  }) as unknown as typeof process.stdin.on;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearCalls += 1;
  }) as unknown as typeof clearInterval;

  // runTui's body runs synchronously up to its keypress await: by the time this returns,
  // one frame has been rendered and the handler is captured.
  const done = runTui(root);

  function key(str: string | undefined, name: string, extra: { ctrl?: boolean } = {}) {
    assert.ok(keypressHandler, "keypress handler registered by runTui");
    keypressHandler!(str, { name, ...extra });
  }
  const lastFrame = () => frames[frames.length - 1] ?? "";
  const lines = () => lastFrame().split("\n");

  function cleanup() {
    process.stdout.write = origWrite;
    (process.stdout as { isTTY?: boolean }).isTTY = undefined;
    (process.stdout as { columns?: number }).columns = undefined;
    (process.stdout as { rows?: number }).rows = undefined;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    delete (process.stdin as { resume?: unknown }).resume;
    delete (process.stdin as { pause?: unknown }).pause;
    readline.emitKeypressEvents = origEmitKeypressEvents;
    process.stdin.on = origStdinOn;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  /** Ctrl+C and wait for runTui to finish, then restore every patched global. */
  async function quit(): Promise<void> {
    key(undefined, "c", { ctrl: true });
    await done;
    cleanup();
  }

  return { key, lastFrame, lines, frames, rawModes, get clearCalls() { return clearCalls; }, quit };
}

/** A fresh initialized repo with exactly one non-director role enabled, so the Ctrl+T
 * view cycle (events → transcript → project status) is short and deterministic. */
async function makeTuiRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "Build a thing.");
  const cfg = loadConfig(repo);
  for (const [id, rc] of Object.entries(cfg.roles)) rc.enabled = id === "clean";
  saveConfig(repo, cfg);
  return repo;
}

test("runTui renders the fleet table and an empty recent-activity pane on start", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    const frame = tui.lastFrame();
    assert.match(frame, /recent activity/); // default view: recent events
    assert.match(frame, /\(no events yet\)/);
    assert.equal(tui.lines().at(-1), "> "); // empty prompt line at the bottom
    // The one enabled loop is listed as stopped (the orchestrator is not running).
    assert.match(frame, /clean/);
    assert.match(frame, /stopped/);
  } finally {
    await tui.quit();
  }
});

test("typing edits the prompt line; Enter queues it for the director", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    for (const ch of "fix the bug") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "> fix the bug");

    // Backspace deletes before the cursor; retype to restore.
    tui.key(undefined, "backspace");
    assert.equal(tui.lines().at(-1), "> fix the bu");
    tui.key("g", "g");

    tui.key(undefined, "return");
    const inbox = path.join(repo, ".tumwater", "inbox");
    const files = fs.readdirSync(inbox).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(inbox, files[0]!), "utf8"), "fix the bug");

    // The flash confirms the queue and the event feed picks up the enqueue.
    const frame = tui.lastFrame();
    assert.match(frame, /queued for the director loop/);
    assert.match(frame, /user prompt queued: fix the bug/);
    // The input line is cleared after submit.
    assert.equal(tui.lines().at(-1), "> ");

    // An empty Enter queues nothing more.
    tui.key(undefined, "return");
    assert.equal(fs.readdirSync(inbox).filter((f) => f.endsWith(".md")).length, 1);
  } finally {
    await tui.quit();
  }
});

/** Replace a file's first `_None yet._` placeholder (under its first section) with an entry. */
function seedEntry(root: string, file: string, heading: string): void {
  const p = path.join(root, file);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("_None yet._", `${heading}\n`));
}

test("Ctrl+T cycles events → transcript → project status with real content", async () => {
  const repo = await makeTuiRepo();
  // Seed the clean loop's pi log with one assistant turn so the transcript pane has
  // something real to show (the user message must never render).
  const logDir = path.join(repo, ".tumwater", "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "clean.pi.jsonl"),
    [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", timestamp: Date.now(), content: [] } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "tidied the imports" }] },
      }),
    ].join("\n") + "\n",
  );

  const tui = startTui(repo);
  try {
    assert.match(tui.lastFrame(), /recent activity/);

    tui.key(undefined, "t", { ctrl: true });
    let frame = tui.lastFrame();
    assert.match(frame, /transcript: clean — Ctrl\+T to cycle/);
    assert.match(frame, /tidied the imports/); // assistant text renders…
    assert.doesNotMatch(frame, /Build a thing/); // …but never the user's tick prompt

    tui.key(undefined, "t", { ctrl: true });
    frame = tui.lastFrame();
    assert.match(frame, /project status — Ctrl\+T to cycle/);
    // One plan and one bug seeded above render under their counted subheaders; the empty
    // questions section renders (none).
    seedEntry(repo, "PLANS.md", "### Add a --json flag");
    seedEntry(repo, "BUGS.md", "### Crashes on empty input");
    tui.key(undefined, "left"); // any keypress re-renders the current view
    frame = tui.lastFrame();
    assert.match(frame, /plans \(1\):/);
    assert.match(frame, /Add a --json flag/);
    assert.match(frame, /open bugs \(1\):/);
    assert.match(frame, /Crashes on empty input/);
    assert.match(frame, /open questions \(0\):/);
    assert.match(frame, /\(none\)/);

    tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /recent activity/); // wraps back to events
  } finally {
    await tui.quit();
  }
});

test("open questions add a nudge line above the activity pane", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  try {
    assert.doesNotMatch(tui.lastFrame(), /awaiting answers/); // seeded QUESTIONS.md is empty

    // Post a question under ## Open (the first "_None yet._" placeholder).
    seedEntry(repo, "QUESTIONS.md", "### Q1: which database?");

    // Any keypress re-renders; the nudge appears and the question counts in the header.
    tui.key(undefined, "left");
    assert.match(tui.lastFrame(), /questions: 1 awaiting answers/);
  } finally {
    await tui.quit();
  }
});

test("runTui refuses to start without an interactive terminal", async () => {
  const repo = await makeTuiRepo();
  // Force the non-TTY state regardless of where the test runner itself is attached
  // (e.g. `tumwater tui | cat` must fail with a clear error, not crash or hang).
  const origIn = (process.stdin as { isTTY?: boolean }).isTTY;
  const origOut = (process.stdout as { isTTY?: boolean }).isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = undefined;
  (process.stdout as { isTTY?: boolean }).isTTY = undefined;
  try {
    await assert.rejects(runTui(repo), /needs an interactive terminal/);
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = origIn;
    (process.stdout as { isTTY?: boolean }).isTTY = origOut;
  }
});

test("Ctrl+C exits cleanly: raw mode off, stdin paused, render timer cleared", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  assert.equal(tui.rawModes.length, 1); // setRawMode(true) on entry
  await tui.quit();
  assert.deepEqual(tui.rawModes, [true, false]);
  assert.equal(tui.frames.at(-1), "\n"); // final newline after the last frame
  assert.ok(tui.clearCalls >= 1, "the render interval is cleared on exit");
});
