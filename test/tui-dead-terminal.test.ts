import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { runTui, type TuiStdin, type TuiStdout } from "../src/ui/tui/tui.js";
import { makeTuiRepo } from "./fixtures/tui-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { CLI } from "./helpers/cli-harness.js";
import { exitWithOwnerEnv } from "./fixtures/victim-fixture.js";
import { sleep, waitFor, within } from "./helpers/wait.js";

/** A fake stream that fails the way a closed terminal does: a write reports success (the
 * bytes went into the pty buffer), then a later tick fails EIO — the reader is gone.
 * `failEIO` emits the EIO error event, standing in for the terminal dying. runTui renders
 * into it, so the listener it installs on the stream is what turns the uncaught EIO crash
 * into a clean quit. */
function deadTerminalStreams(): {
  stdin: TuiStdin;
  stdout: TuiStdout & { failEIO(): void; fail(code: string): void };
} {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
  }) as unknown as TuiStdin;
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    rows: 40,
    columns: 120,
    write: () => true,
  });
  const stdout = stream as unknown as TuiStdout & { failEIO(): void; fail(code: string): void };
  stdout.fail = (code: string) => {
    const err = Object.assign(new Error(`write ${code}`), { code });
    stream.emit("error", err);
  };
  stdout.failEIO = () => stdout.fail("EIO");
  return { stdin, stdout };
}

test("a runTui whose terminal dies (EIO on a stream write) quits instead of crashing on an uncaught exception", async () => {
  const repo = await makeTuiRepo();
  const uncaughts: unknown[] = [];
  const onUncaught = (e: unknown) => uncaughts.push(e);
  process.on("uncaughtException", onUncaught);
  const { stdin, stdout } = deadTerminalStreams();
  const done = runTui(repo, { stdin, stdout });
  try {
    // Let the first frame render and the input subscription mount, then the terminal dies.
    await sleep(50);
    stdout.failEIO();
    assert.equal(
      await within(done, 5_000),
      true,
      "runTui must settle after its terminal dies — it took the quit teardown, not a crash",
    );
    assert.equal(
      uncaughts.length,
      0,
      `no uncaught exception escaped the dead-terminal EIO (got ${uncaughts.length})`,
    );
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("a non-EIO stdout error still propagates instead of being swallowed by the dead-terminal guard", async () => {
  const repo = await makeTuiRepo();
  const { stdin, stdout } = deadTerminalStreams();
  const controller = new AbortController();
  const done = runTui(repo, { stdin, stdout, abortSignal: controller.signal });
  try {
    await sleep(50);
    assert.throws(
      () => stdout.fail("ENOSPC"),
      (err: unknown) => (err as { code?: string }).code === "ENOSPC",
      "a real I/O failure must escape the listener, not be treated as a dead terminal",
    );
  } finally {
    controller.abort();
    assert.equal(await within(done, 5_000), true, "the abort still ends the run cleanly");
  }
});

// The runTui test above injects a fake stdout and never installs cli.ts's own write guard,
// so it cannot catch the regression the guard deferral fixes: main()'s guard runs first and
// re-throws EIO before the TUI's listener. This drives the real CLI entry in a fake TTY whose
// next write fails EIO after the first frame, and requires a clean exit 0 — reverting either
// the guard's EIO deferral or runTui's listener makes the child die on the uncaught exception.
test("a real CLI-hosted TUI exits 0 when its terminal dies: the guard defers EIO to the TUI quit", async () => {
  const repo = await makeTuiRepo();
  const dir = tmpdir("tw-tui-eio-");
  const trigger = path.join(dir, "fail-now");
  const shim = path.join(dir, "fake-eio-tty.cjs");
  await fs.promises.writeFile(
    shim,
    [
      "// A spawned child has no terminal; stand one in, then fail the next write EIO once the trigger file appears.",
      "const fs = require('node:fs');",
      "process.stdin.isTTY = true;",
      "process.stdout.isTTY = true;",
      "process.stdin.setRawMode = () => {};",
      "process.stdout.columns = 120;",
      "process.stdout.rows = 40;",
      "const realWrite = process.stdout.write.bind(process.stdout);",
      "process.stdout.write = (chunk, ...rest) => {",
      "  const result = realWrite(chunk, ...rest);",
      "  if (fs.existsSync(process.env.TUMWATER_EIO_TRIGGER)) {",
      "    const err = Object.assign(new Error('write EIO'), { code: 'EIO' });",
      "    process.nextTick(() => process.stdout.emit('error', err));",
      "  }",
      "  return result;",
      "};",
      "// An idle TUI skips byte-identical repaints, so force one write after the test arms",
      "// the trigger; that write then fails EIO like a dead terminal's next frame would.",
      "const pump = setInterval(() => {",
      "  if (fs.existsSync(process.env.TUMWATER_EIO_TRIGGER)) {",
      "    clearInterval(pump);",
      "    process.stdout.write('');",
      "  }",
      "}, 100);",
    ].join("\n"),
  );
  const env = exitWithOwnerEnv({ ...process.env, TUMWATER_EIO_TRIGGER: trigger });
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require ${shim}`.trim();
  const child = spawn(process.execPath, [CLI, "tui"], { cwd: repo, env, detached: true });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  try {
    await waitFor(() => out.includes("[Activity]"), "the TUI's first frame");
    fs.writeFileSync(trigger, "");
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 20_000);
      child.once("close", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    assert.equal(code, 0, `an EIO on a dead terminal must end the TUI cleanly; output so far:\n${out}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    }
  }
});
