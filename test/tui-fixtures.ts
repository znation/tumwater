/** The TUI tests' fake-TTY harness, shared by tui.test.ts and its topic-named slices
 * (tui-operator-keys.test.ts): startTui patches stdout/stdin/readline and the render
 * timers so runTui runs headless with synthetic keypresses and no live timer can survive
 * a failed test, and makeTuiRepo builds a fresh initialized repo with exactly one enabled
 * role so the Ctrl+T view cycle (events → transcript → project status) is short and
 * deterministic. Extracted from tui.test.ts so each topic file imports it instead of
 * carrying its own copy. */
import readline from "node:readline";
import assert from "node:assert/strict";
import { initProject } from "../src/init.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { runTui } from "../src/ui/tui.js";
import { makeRepo } from "./repo-fixtures.js";


/** A fake-TTY harness around runTui: no real terminal is involved. The isTTY flags are
 * faked, raw mode / resume / pause are stubbed and recorded, readline's keypress emitter
 * is no-op'd (so the test runner's stdin stream is never touched), every stdout write is
 * captured as a frame, and setInterval/clearInterval are stubbed so a failed test cannot
 * leave a live render timer behind. The keypress handler runTui registers on stdin is
 * intercepted and replayed with synthetic keys. */
export function startTui(root: string, size?: { rows?: number; columns?: number }) {
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
  // Optional size override for degenerate-window tests: 0 is a real report (a pty with no
  // TIOCSWINSZ), so the guard is `!== undefined`, not truthiness.
  if (size?.columns !== undefined) (process.stdout as { columns?: number }).columns = size.columns;
  if (size?.rows !== undefined) (process.stdout as { rows?: number }).rows = size.rows;
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

  function press(str: string | undefined, name: string, extra: { ctrl?: boolean } = {}) {
    assert.ok(keypressHandler, "keypress handler registered by runTui");
    keypressHandler!(str, { name, ...extra });
  }
  const rawFrame = () => frames[frames.length - 1] ?? "";
  // Frames as the eye reads them: color and attribute codes stripped (the screen-clear code
  // stays); rawFrame keeps them for the styling tests.
  const lastFrame = () => rawFrame().replace(/\x1b\[[0-9;]*m/g, "");
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
    press(undefined, "c", { ctrl: true });
    await done;
    cleanup();
  }

  return { key: press, lastFrame, rawFrame, lines, frames, rawModes, get clearCalls() { return clearCalls; }, quit };
}

/** Runs body against a started fake TUI and quits it in a finally even when body throws —
 * the single home of the startTui/quit pairing the topic tests repeat, so a failing
 * assertion can never leak the patched stdout/stdin/readline globals into the next test.
 * size passes through to startTui for the degenerate-window and widened-terminal tests. */
export async function withTui<R>(
  repo: string,
  body: (tui: ReturnType<typeof startTui>) => Promise<R> | R,
  size?: { rows?: number; columns?: number },
): Promise<R> {
  const tui = startTui(repo, size);
  try {
    return await body(tui);
  } finally {
    await tui.quit();
  }
}

/** A fresh initialized repo with exactly one non-director role enabled, so the Ctrl+T
 * view cycle (events → transcript → project status) is short and deterministic. */
export async function makeTuiRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "Build a thing.");
  const cfg = loadConfig(repo);
  for (const [id, rc] of Object.entries(cfg.roles)) rc.enabled = id === "clean";
  saveConfig(repo, cfg);
  return repo;
}
