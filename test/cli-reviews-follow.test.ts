import test from "node:test";
import assert from "node:assert/strict";
import { cmdReviews } from "../src/cli/cli-review-commands.js";
import { initProject } from "../src/init/init.js";
import { postReviewPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// `reviews -f` runs in-process with the follow's repaint-interval and parent-death seams,
// the way cli-quarantine-follow.test.ts drives `quarantine -f` — a real interval (so the
// repaint loop's sync-frame paint is exercised) and a fake parent whose death resolves the
// follow.

const CLEAR = "\x1b[H\x1b[2J";

/** Write the post-merge review queue file the way the CLI's own tests do: `{ pending: [...] }`. */
function writeReviews(repo: string, pending: unknown[]): void {
  writeFileDeep(postReviewPath(repo), JSON.stringify({ pending }));
}

/** The same two entries cli-reviews.test.ts seeds: improve (waiting) then clean (rejected). */
function seedPending(): unknown[] {
  return [
    { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
    { commit: "b".repeat(40), role: "clean", summary: "rejected", rejected: ["no tests"] },
  ];
}

/** Drive `reviews -f` in-process until `drive` (which gets the capture, a `done()` poll and
 * a `stop()` that flips the seam's parent to PID 1) returns. `stop()` is guaranteed to run even
 * if `drive` throws, so a failing branch never leaves the follow repainting into real stdout. */
async function withReviewsFollow(
  seed: (repo: string) => void,
  args: string[],
  intervalMs: number,
  tty: boolean,
  drive: (h: { cap: { out: () => string }; done: () => boolean; stop: () => void; repo: string }) => Promise<void> | void,
): Promise<void> {
  const repo = makeRepo();
  await initProject(repo, "reviews follow");
  seed(repo);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  const onDone = () => (done = true);
  const promise = cmdReviews(repo, args, { ppid: () => parent, intervalMs, tty }).then(onDone);
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

test("reviews -f repaints the queue until its parent exits, then prints nothing", async () => {
  await withReviewsFollow(
    (repo) => writeReviews(repo, seedPending()),
    ["-f"],
    5,
    false,
    async ({ cap, done, stop }) => {
      await sleep(60);
      const frames = cap.out();
      assert.ok(
        (frames.match(/post-merge review queue \(2 entries\):/g) ?? []).length >= 2,
        "at least two frames repainted",
      );
      assert.match(frames, /1\. improve a{8}/, "FIFO: the waiting entry is first");
      assert.match(frames, /2\. clean b{8} · rejected · \[rejected — no tests\]/);
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
      assert.ok(done(), "follow resolves once the parent is gone");
      const before = cap.out();
      await sleep(30);
      assert.equal(cap.out(), before, "nothing printed after the follow ended");
    },
  );
});

test("reviews -f re-reads the queue file each frame — a rewrite shows in the next frame", async () => {
  await withReviewsFollow(
    (repo) => writeReviews(repo, [{ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }]),
    ["-f"],
    5,
    false,
    async ({ cap, repo, done, stop }) => {
      // The first frame(s) show the seeded entry alone.
      await sleep(30);
      assert.match(cap.out(), /tidy the parser/);
      // Replace the whole queue: the next repaint re-reads the file and shows the new entry.
      writeReviews(repo, [{ commit: "c".repeat(40), role: "feature", summary: "brand new entry" }]);
      await sleep(40);
      assert.match(cap.out(), /brand new entry/, "the rewritten entry appears in a later frame");
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
    },
  );
});

test("reviews -f keeps --role and --status scoping on every frame", async () => {
  const seed = (repo: string) => writeReviews(repo, seedPending());
  await withReviewsFollow(seed, ["-f", "--role", "clean"], 5, false, async ({ cap, done, stop }) => {
    await sleep(40);
    const out = cap.out();
    assert.match(out, /post-merge review queue \(1 of 2, --role clean\):/);
    assert.match(out, /2\. clean b{8} · rejected · \[rejected — no tests\]/, "the scoped entry keeps its whole-queue position");
    assert.doesNotMatch(out, /improve/, "the unscoped entry never appears");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withReviewsFollow(seed, ["-f", "--status", "rejected"], 5, false, async ({ cap, done, stop }) => {
    await sleep(40);
    const out = cap.out();
    assert.match(out, /post-merge review queue \(1 of 2, --status rejected\):/);
    assert.match(out, /2\. clean b{8} · rejected · \[rejected — no tests\]/);
    assert.doesNotMatch(out, /tidy the parser/, "the unscoped entry never appears");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});

test("reviews -f --json is refused before any frame", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews follow json");
  writeReviews(repo, seedPending());
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdReviews(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /reviews --json prints one document/);
    const out = cap.out();
    assert.doesNotMatch(out, /post-merge review queue/, "no queue frame before the refusal");
    assert.ok(!out.includes(CLEAR), "no clear-screen before the refusal");
  } finally {
    cap.restore();
  }
});

test("reviews -f --status with an unknown state is refused before any frame", async () => {
  const repo = makeRepo();
  await initProject(repo, "reviews follow status test");
  writeReviews(repo, seedPending());
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdReviews(repo, ["-f", "--status", "bogus"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /waiting/);
    assert.match(err, /failing/);
    assert.match(err, /rejected/);
    const out = cap.out();
    assert.doesNotMatch(out, /post-merge review queue/, "no queue frame before the refusal");
  } finally {
    cap.restore();
  }
});

test("reviews -f clears the screen only on a TTY", async () => {
  const seed = (repo: string) => writeReviews(repo, seedPending());
  await withReviewsFollow(seed, ["-f"], 5, true, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(out.startsWith(CLEAR), `TTY follow starts with a clear-screen (first 20 chars: ${JSON.stringify(out.slice(0, 20))})`);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withReviewsFollow(seed, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(!out.includes(CLEAR), "non-TTY follow never clears the screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});
