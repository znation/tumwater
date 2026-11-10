import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runTui, type TuiStdin, type TuiStdout } from "../src/ui/tui/tui.js";
import { makeTuiRepo } from "./fixtures/tui-fixtures.js";
import { sleep, within } from "./helpers/wait.js";

/** A fake stream that fails the way a closed terminal does: a write reports success (the
 * bytes went into the pty buffer), then a later tick fails EIO — the reader is gone.
 * `failEIO` emits the EIO error event, standing in for the terminal dying. runTui renders
 * into it, so the listener it installs on the stream is what turns the uncaught EIO crash
 * into a clean quit. */
function deadTerminalStreams(): {
  stdin: TuiStdin;
  stdout: TuiStdout & { failEIO(): void };
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
  const stdout = stream as unknown as TuiStdout & { failEIO(): void };
  stdout.failEIO = () => {
    const err = Object.assign(new Error("write EIO"), { code: "EIO" });
    stream.emit("error", err);
  };
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
