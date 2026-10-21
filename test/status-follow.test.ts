import test from "node:test";
import assert from "node:assert/strict";
import { cmdStatus } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `status -f` runs in-process with the follow's repaint-interval and parent-death seams, the
// way history-follow.test.ts drives `history -f`.

const CLEAR = "\x1b[H\x1b[2J";

/** Drive `status -f` in-process until `drive` (which gets the capture, a `done()` poll and a
 * `stop()` that flips the seam's parent to PID 1) returns. `stop()` is guaranteed to run even
 * if `drive` throws, so a failing branch never leaves the follow repainting into real stdout. */
async function withFollow(args: string[], intervalMs: number, tty: boolean, drive: (h: { cap: { out: () => string }; done: () => boolean; stop: () => void }) => Promise<void> | void): Promise<void> {
  const repo = makeRepo();
  await initProject(repo, "status follow");
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  const onDone = () => (done = true);
  const promise = cmdStatus(repo, args, { ppid: () => parent, intervalMs, tty }).then(onDone);
  try {
    await drive({ cap, done: () => done, stop: () => (parent = 1) });
  } finally {
    parent = 1;
    try {
      await promise;
    } catch {
      // The follow failed; whatever it printed is already captured. Nothing to rethrow here.
    }
    cap.restore();
  }
}

test("status -f repaints until its parent exits, then prints nothing", async () => {
  await withFollow(["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(60);
    const frames = cap.out();
    assert.ok((frames.match(/tumwater ·/g) ?? []).length >= 2, "at least two frames repainted");
    assert.ok(!frames.includes(CLEAR), "no clear-screen on a non-TTY follow");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
    assert.ok(done(), "follow resolves once the parent is gone");
    const before = cap.out();
    await sleep(30);
    assert.equal(cap.out(), before, "nothing printed after the follow ended");
  });
});

test("status -f --role keeps only the listed role's rows", async () => {
  await withFollow(["--role", "feature", "-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(60);
    const out = cap.out();
    assert.match(out, /feature/);
    assert.doesNotMatch(out, /clean/, "a scoped follow keeps only the listed role's rows");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});

test("status -f --json is refused", async () => {
  const repo = makeRepo();
  await initProject(repo, "status follow");
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdStatus(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /-f\/--follow repaints a live view/);
    const out = cap.out();
    assert.doesNotMatch(out, /tumwater ·/, "no table header before the refusal");
    assert.ok(!out.includes(CLEAR), "no frame printed before the refusal");
  } finally {
    cap.restore();
  }
});

test("status -f clears the screen only on a TTY", async () => {
  await withFollow(["-f"], 5, true, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(out.startsWith(CLEAR), `TTY follow starts with a clear-screen (first 20 chars: ${JSON.stringify(out.slice(0, 20))})`);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withFollow(["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(!out.includes(CLEAR), "non-TTY follow never clears the screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});
