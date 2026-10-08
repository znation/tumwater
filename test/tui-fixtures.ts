/** The TUI tests' fake-TTY harness, shared by tui.test.ts and its topic-named slices
 * (tui-operator-keys.test.ts): startTui patches stdout, injects a fake stdin stream, and
 * stubs the render timers so runTui runs headless with synthetic keypresses and no live
 * timer can survive a failed test, and makeTuiRepo builds a fresh initialized repo with
 * exactly one enabled role so the Ctrl+T view cycle (events → transcript → project status)
 * is short and deterministic. Extracted from tui.test.ts so each topic file imports it
 * instead of carrying its own copy. */
import { EventEmitter } from "node:events";
import { initProject } from "../src/init/init.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { runTui, type TuiStdin } from "../src/ui/tui/tui.js";
import { makeRepo } from "./repo-fixtures.js";
import { flushImmediate } from "./helpers/wait.js";

/** One keypress's raw terminal bytes, encoded for ink's input parser: control letters
 * arrive as their C0 code (\x14 = Ctrl+T), named keys as their escape sequences, and
 * printable text as itself — parseKeypress decodes each back into the same key. */
const RAW_SEQUENCE: Record<string, string> = {
  return: "\r",
  backspace: "\x7f",
  delete: "\x1b[3~",
  // Escape as the kitty CSI-u form (\x1b[27u), not the bare \x1b byte: a lone ESC byte is
  // ambiguous (it may begin an escape sequence), so ink's input parser holds it pending
  // and only flushes it on a timer — the CSI-u form parses complete, so the fixture's
  // synchronous frame assertions see the keypress immediately, like a terminal that
  // reports keys in kitty mode would deliver it.
  escape: "\x1b[27u",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  f1: "\x1bOP",
};

/** A fake stdin with the surface ink's input handling consumes: the TTY flag, raw mode
 * (recorded), the ref/encoding calls, and a Readable.read-style drain — `enqueue` buffers
 * a chunk and fires `readable`, and ink's readable listener reads chunks until null. */
function makeFakeStdin(onRawMode: (on: boolean) => void): EventEmitter & {
  isTTY: boolean;
  setRawMode(on: boolean): void;
  setEncoding(): void;
  ref(): void;
  unref(): void;
  read(): string | null;
  enqueue(chunk: string): void;
} {
  const queue: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (on: boolean) => onRawMode(on),
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    read: () => (queue.length > 0 ? (queue.shift() as string) : null),
    enqueue: (chunk: string) => {
      queue.push(chunk);
      stream.emit("readable");
    },
  });
  return stream;
}

/** A fake-TTY harness around runTui: no real terminal is involved. The fake stdin is
 * injected through TuiSeams so ink claims it (raw mode recorded, every stdout write
 * captured — the ink renderer writes each changed frame as a begin-sync escape, the
 * frame's bytes, and an end-sync escape — `frames` keeps only the chunks that carry
 * rendered text, `chunks` keeps every byte), and setInterval/clearInterval are stubbed so
 * a failed test cannot leave a live render timer behind. Keys are pressed as raw terminal
 * bytes into the fake stdin, so ink's input parser consumes them the same way it consumes
 * a real terminal's. */
export function startTui(root: string, size?: { rows?: number; columns?: number }) {
  const chunks: string[] = [];
  const frames: string[] = [];
  const rawModes: boolean[] = [];
  let clearCalls = 0;

  const origWrite = process.stdout.write.bind(process.stdout);
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
    const s = String(chunk);
    chunks.push(s);
    // A rendered frame always carries text; ink's cursor-hide/show and sync-bracket
    // escapes are byte-only writes and stay out of `frames` (counted separately).
    if (s.replace(ESCAPES, "").trim() !== "") frames.push(s);
    return true;
  }) as unknown as typeof process.stdout.write;
  const stdin = makeFakeStdin((on) => rawModes.push(on));

  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearCalls += 1;
  }) as unknown as typeof clearInterval;

  // runTui's body runs synchronously up to its main await; ink's input subscription mounts
  // with its tree's effects, which withTui flushes with one macrotask tick before the
  // test body presses any key.
  const done = runTui(root, { stdin: stdin as unknown as TuiStdin });

  /** Press one key as its raw terminal bytes, the way a real keyboard delivers it: ink's
   * input parser decodes the bytes and the useTuiKeys hook dispatches the parsed key. */
  function press(str: string | undefined, name: string, extra: { ctrl?: boolean } = {}) {
    const raw = extra.ctrl
      ? String.fromCharCode(name.charCodeAt(0) - 96) // Ctrl+letter: its C0 control code
      : (RAW_SEQUENCE[name] ?? str ?? name);
    stdin.enqueue(raw);
  }
  const rawFrame = () => frames[frames.length - 1] ?? "";
  // Frames as the eye reads them: every escape sequence stripped (styling, cursor motion,
  // ink's erase-and-rewrite plumbing) — the rendered text survives verbatim, and ink's
  // full-frame rewrites mean the last frame's text is the whole screen.
  const lastFrame = () => rawFrame().replace(ESCAPES, "");
  const lines = () => {
    const l = lastFrame().split("\n");
    if (l.length > 1 && l[l.length - 1] === "") l.pop(); // ink ends a frame with a newline
    return l;
  };

  function cleanup() {
    process.stdout.write = origWrite;
    (process.stdout as { isTTY?: boolean }).isTTY = undefined;
    (process.stdout as { columns?: number }).columns = undefined;
    (process.stdout as { rows?: number }).rows = undefined;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }

  /** Ctrl+D (shell EOF — the TUI's quit key) and wait for runTui to finish, then restore
   * every patched global. The extra tick after `done` lets ink's deferred raw-mode teardown
   * microtask (queued at unmount) run before assertions read `rawModes`. */
  async function quit(): Promise<void> {
    press(undefined, "d", { ctrl: true });
    await done;
    await flushImmediate();
    cleanup();
  }

  return { key: press, lastFrame, rawFrame, lines, chunks, frames, rawModes, get clearCalls() { return clearCalls; }, quit };
}

/** Every escape sequence the ink renderer writes: CSI styling and cursor motion, plus the
 * synchronized-update brackets (\x1b[?2026h/l) and cursor hide/show. */
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Runs body against a started fake TUI and quits it in a finally even when body throws —
 * the single home of the startTui/quit pairing the topic tests repeat, so a failing
 * assertion can never leak the patched stdout/stdin/readline globals into the next test.
 * size passes through to startTui for the degenerate-window and widened-terminal tests.
 * One macrotask elapses after startTui and before body runs: ink's input subscription and
 * raw mode mount with the component tree's effects, so the first pressed key meets a
 * subscribed handler. */
export async function withTui<R>(
  repo: string,
  body: (tui: ReturnType<typeof startTui>) => Promise<R> | R,
  size?: { rows?: number; columns?: number },
): Promise<R> {
  const tui = startTui(repo, size);
  await flushImmediate();
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
