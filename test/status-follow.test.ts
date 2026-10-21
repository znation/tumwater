import test from "node:test";
import assert from "node:assert/strict";
import { cmdStatus } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `status -f` runs in-process with the follow's parent-death and TTY seams, the way
// history-follow.test.ts drives `history -f`.

const CLEAR = "\x1b[H\x1b[2J";

/** A ready repo with a fresh team, flushed past the previous test's runner output. */
async function readyRepo(name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  return repo;
}

/** Start a follow on `repo`, wait until `waitForFrames` frames are repainted, flip the parent
 * away, and wait for the follow to end. Returns the output captured before the parent flip,
 * with the follow already resolved. */
async function runFollow(repo: string, args: string[], seams: Parameters<typeof cmdStatus>[2], waitForFrames: number, stop: () => void): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  // Keep the follow's promise so the finally can flip the parent and await it to completion;
  // the rejection branch records a real follow failure (surfaced below) while still setting
  // `done`, so the waits terminate and no rejection goes unhandled.
  const promise = cmdStatus(repo, args, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    }
  );
  try {
    // Poll for the requested frame count rather than sleeping a fixed hop: under the suite's
    // concurrent load a real 5 ms interval can take far longer than wall-clock sleep to fire,
    // so a fixed wait would flaky-fail on a busy machine (status-follow was quarantined for
    // exactly that). Bound the poll so a genuinely dead follow fails fast instead of hanging.
    const frames = (out: string) => (out.match(/tumwater ·/g) ?? []).length;
    let out = cap.out();
    for (let i = 0; i < 500 && frames(out) < waitForFrames && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(frames(out) >= waitForFrames, `got ${frames(out)} of ${waitForFrames} frames`);
    stop();
    for (let i = 0; i < 500 && !done; i++) await sleep(10);
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
    return out;
  } finally {
    // Flip the parent and await the follow even when an assertion above throws, so a frame-count
    // failure never leaves the follow's repaint interval running into real stdout or keeping the
    // test process alive.
    stop();
    try {
      await promise;
    } catch {
      // Rejection already recorded above.
    }
    cap.restore();
  }
}

test("status -f repaints until its parent exits, then prints nothing", async () => {
  const repo = await readyRepo("status follow");
  const parent = { value: 4242 };
  const out = await runFollow(repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, () => (parent.value = 1));
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
  // Nothing more is repainted once the follow ended (the timer was cleared on resolve): a
  // fresh capture stays empty over a settle.
  const cap = captureStdout();
  try {
    await sleep(30);
    assert.equal(cap.out(), "", "nothing printed after the follow ended");
  } finally {
    cap.restore();
  }
});

test("status -f --role keeps only the listed role's rows", async () => {
  const repo = await readyRepo("status follow role");
  const parent = { value: 4242 };
  const out = await runFollow(repo, ["--role", "feature", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, () => (parent.value = 1));
  assert.match(out, /feature/);
  assert.doesNotMatch(out, /clean/, "a scoped follow keeps only the listed role's rows");
});

test("status -f --json is refused", async () => {
  const repo = await readyRepo("status follow json");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdStatus(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /-f\/--follow repaints a live view/);
    assert.equal(cap.out(), "", "no table header or frame printed");
  } finally {
    cap.restore();
  }
});

test("status -f clears the screen only on a TTY", async () => {
  const repo = await readyRepo("status follow tty");
  let parent = { value: 4242 };
  const ttyOut = await runFollow(repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, 1, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
  parent = { value: 4242 };
  const pipedOut = await runFollow(repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, () => (parent.value = 1));
  assert.ok(!pipedOut.includes(CLEAR), "non-TTY follow never clears the screen");
});
