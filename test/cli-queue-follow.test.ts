import test from "node:test";
import assert from "node:assert/strict";
import { cmdQueue } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { enqueueMerge, type MergeEntry } from "../src/merge/merge-queue.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `queue -f` runs in-process with the follow's repaint-interval and parent-death seams, the
// way status-follow.test.ts drives `status -f`.

const CLEAR = "\x1b[H\x1b[2J";

/** A waiting merge, the shape `enqueueMerge` persists. */
function entry(role: string, sha: string, run = 1, summary = `summary from ${role} #${run}`): MergeEntry {
  return { role, sha, run, summary, enqueuedAt: Date.now() };
}

/** Drive `queue -f` in-process until `drive` (which gets the capture, a `done()` poll and a
 * `stop()` that flips the seam's parent to PID 1) returns. `stop()` is guaranteed to run even
 * if `drive` throws, so a failing branch never leaves the follow repainting into real stdout. */
async function withQueueFollow(seed: (repo: string) => void, args: string[], intervalMs: number, tty: boolean, drive: (h: { cap: { out: () => string }; done: () => boolean; stop: () => void }) => Promise<void> | void): Promise<void> {
  const repo = makeRepo();
  await initProject(repo, "queue follow");
  seed(repo);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  const onDone = () => (done = true);
  const promise = cmdQueue(repo, args, { ppid: () => parent, intervalMs, tty }).then(onDone);
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

test("queue -f repaints until its parent exits, then prints nothing", async () => {
  await withQueueFollow((repo) => {
    enqueueMerge(repo, entry("improve", "a".repeat(40), 3, "tidy the parser"));
  }, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(60);
    const frames = cap.out();
    assert.ok((frames.match(/merge queue \(1\):/g) ?? []).length >= 2, "at least two frames repainted");
    assert.match(frames, /1\. improve run #3/);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
    assert.ok(done(), "follow resolves once the parent is gone");
    const before = cap.out();
    await sleep(30);
    assert.equal(cap.out(), before, "nothing printed after the follow ended");
  });
});

test("queue -f --role keeps only the listed role's entries in every frame", async () => {
  await withQueueFollow((repo) => {
    enqueueMerge(repo, entry("clean", "b".repeat(40)));
    enqueueMerge(repo, entry("improve", "a".repeat(40)));
  }, ["--role", "clean", "-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(60);
    const out = cap.out();
    assert.match(out, /1\. clean run/);
    assert.doesNotMatch(out, /improve/, "a scoped follow keeps only the listed role's merges");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});

test("queue -f --json is refused", async () => {
  const repo = makeRepo();
  await initProject(repo, "queue follow json");
  enqueueMerge(repo, entry("improve", "a".repeat(40)));
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdQueue(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /queue --json prints one document/);
    const out = cap.out();
    assert.doesNotMatch(out, /merge queue/, "no queue frame before the refusal");
    assert.ok(!out.includes(CLEAR), "no clear-screen before the refusal");
  } finally {
    cap.restore();
  }
});

test("queue -f clears the screen only on a TTY", async () => {
  const seed = (repo: string) => enqueueMerge(repo, entry("improve", "a".repeat(40)));
  await withQueueFollow(seed, ["-f"], 5, true, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(out.startsWith(CLEAR), `TTY follow starts with a clear-screen (first 20 chars: ${JSON.stringify(out.slice(0, 20))})`);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withQueueFollow(seed, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(!out.includes(CLEAR), "non-TTY follow never clears the screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});
