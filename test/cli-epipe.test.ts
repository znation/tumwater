import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawnCli } from "./helpers/cli-harness.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

// A closed stdout pipe: `tumwater status | head -1` (or a follow view piped into a reader
// that exits, `logs -f | grep -q`) closes the reader's end of the pipe while the command
// keeps writing. Node's process.stdout then fails the next write with EPIPE, and with no
// 'error' listener that failure is thrown from the event loop as an uncaught exception — a
// stack trace and a crash exit where the reader deliberately stopped reading. The CLI's
// main() installs an EPIPE guard, so a closed pipe ends the command quietly with exit 0
// instead of a crash. `salvage -f` is the test vehicle: a follow view that needs no repo,
// so a plain temp dir suffices, and it repaints a frame every two seconds, so the first
// frame proves the child is live before the pipe is closed and the next tick hits the
// EPIPE.

/** The child's exit as { code, signal }, rejecting after `ms` — a child that never exits
 * when its pipe reader closed is the regression this test guards against. */
function exitedWithin(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the child did not exit after its stdout pipe closed")), ms);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("a follow view whose stdout pipe closes exits 0 quietly, not with an EPIPE crash", async () => {
  const repo = makeRepo();
  const { child, waitFor, kill } = spawnCli(repo, ["salvage", "-f"]);
  try {
    await waitFor((o) => o.includes("no salvaged workspace patches are kept for you"), "the first salvage -f frame");
    // The pipe reader closes (what `head` does after its line): the child's next repaint
    // write fails EPIPE.
    child.stdout?.destroy();
    const { code, signal } = await exitedWithin(child, 15_000);
    assert.equal(signal, null, "the child must not die on a signal");
    assert.equal(code, 0, "a closed pipe is a clean end, not a crash");
  } finally {
    kill();
  }
});
