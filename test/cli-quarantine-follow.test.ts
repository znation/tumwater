import test from "node:test";
import assert from "node:assert/strict";
import { cmdQuarantine } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { quarantinePath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// `quarantine -f` runs in-process with the follow's repaint-interval and parent-death seams,
// the way cli-queue-follow.test.ts drives `queue -f` — a real interval (so the repaint loop's
// sync-frame paint is exercised) and a fake parent whose death resolves the follow.

const CLEAR = "\x1b[H\x1b[2J";

/** Write the quarantine file the way the CLI's own tests do: `{ tests: [...] }`. */
function writeQuarantine(repo: string, tests: unknown[]): void {
  writeFileDeep(quarantinePath(repo), JSON.stringify({ tests }));
}

/** One quarantined-test row, the shape `loadQuarantine` reads. */
function qrow(test: string, ageMs: number): unknown {
  const now = Date.now();
  return { test, firstSeen: now - ageMs, lastSeen: now, count: 1, bug: "" };
}

/** Drive `quarantine -f` in-process until `drive` (which gets the capture, a `done()` poll and
 * a `stop()` that flips the seam's parent to PID 1) returns. `stop()` is guaranteed to run even
 * if `drive` throws, so a failing branch never leaves the follow repainting into real stdout. */
async function withQuarantineFollow(
  seed: (repo: string) => void,
  args: string[],
  intervalMs: number,
  tty: boolean,
  drive: (h: { cap: { out: () => string }; done: () => boolean; stop: () => void; repo: string }) => Promise<void> | void,
): Promise<void> {
  const repo = makeRepo();
  await initProject(repo, "quarantine follow");
  seed(repo);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  const onDone = () => (done = true);
  const promise = cmdQuarantine(repo, args, { ppid: () => parent, intervalMs, tty }).then(onDone);
  try {
    await drive({ cap, done: () => done, stop: () => (parent = 1), repo });
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

test("quarantine -f repaints the list until its parent exits, then prints nothing", async () => {
  await withQuarantineFollow(
    (repo) => writeQuarantine(repo, [qrow("test/aaa.test.ts", 3_600_000), qrow("test/bbb.test.ts", 7_200_000)]),
    ["-f"],
    5,
    false,
    async ({ cap, done, stop }) => {
      await sleep(60);
      const frames = cap.out();
      assert.ok((frames.match(/flake quarantine: 2 tests/g) ?? []).length >= 2, "at least two frames repainted");
      assert.match(frames, /1\. test\/bbb\.test\.ts/, "rows are oldest first");
      assert.match(frames, /2\. test\/aaa\.test\.ts/);
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
      assert.ok(done(), "follow resolves once the parent is gone");
      const before = cap.out();
      await sleep(30);
      assert.equal(cap.out(), before, "nothing printed after the follow ended");
    },
  );
});

test("quarantine -f re-reads the file each frame — a rewrite shows in the next frame", async () => {
  await withQuarantineFollow(
    (repo) => writeQuarantine(repo, [qrow("test/aaa.test.ts", 3_600_000)]),
    ["-f"],
    5,
    false,
    async ({ cap, repo, done, stop }) => {
      // The first frame(s) show the seeded entry alone.
      await sleep(30);
      assert.match(cap.out(), /test\/aaa\.test\.ts/);
      // Replace the whole list: the next repaint re-reads the file and shows the new entry.
      writeQuarantine(repo, [qrow("test/zzz.test.ts", 1_800_000)]);
      await sleep(40);
      assert.match(cap.out(), /test\/zzz\.test\.ts/, "the rewritten entry appears in a later frame");
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
    },
  );
});

test("quarantine -f --json is refused before any frame", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine follow json");
  writeQuarantine(repo, [qrow("test/aaa.test.ts", 3_600_000)]);
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdQuarantine(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /quarantine --json prints one document/);
    const out = cap.out();
    assert.doesNotMatch(out, /flake quarantine/, "no quarantine frame before the refusal");
    assert.ok(!out.includes(CLEAR), "no clear-screen before the refusal");
  } finally {
    cap.restore();
  }
});

test("quarantine -f clears the screen only on a TTY", async () => {
  const seed = (repo: string) => writeQuarantine(repo, [qrow("test/aaa.test.ts", 3_600_000)]);
  await withQuarantineFollow(seed, ["-f"], 5, true, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(out.startsWith(CLEAR), `TTY follow starts with a clear-screen (first 20 chars: ${JSON.stringify(out.slice(0, 20))})`);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withQuarantineFollow(seed, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(!out.includes(CLEAR), "non-TTY follow never clears the screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});
