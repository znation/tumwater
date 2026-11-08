import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdSalvage } from "../src/cli/cli-salvage-command.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `salvage -f` runs in-process with the follow's repaint-interval and parent-death seams,
// the way cli-quarantine-follow.test.ts drives `quarantine -f` — a real interval (so the
// repaint loop's sync-frame paint is exercised) and a fake parent whose death resolves the
// follow.

const CLEAR = "\x1b[H\x1b[2J";

/** Seed a repo's salvage dir with the given kept patches plus a `pending/<role>/x.patch` and
 * a `notes.txt` that must both stay out of the list — the way cli-salvage.test.ts's
 * seedSalvage seeds its two patches, generalized for ordered multi-patch lists. */
function seedSalvage(repo: string, patches: { name: string; ageMs: number }[]): void {
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  fs.mkdirSync(salvagePendingDir(repo, "feature"), { recursive: true });
  fs.writeFileSync(path.join(salvagePendingDir(repo, "feature"), "x.patch"), "pending work");
  fs.writeFileSync(path.join(salvageDir(repo), "notes.txt"), "not a patch");
  const now = Date.now();
  for (const { name, ageMs } of patches) {
    const file = path.join(salvageDir(repo), name);
    fs.writeFileSync(file, `body of ${name}\n`);
    fs.utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
  }
}

/** Drive `salvage -f` in-process until `drive` (which gets the capture, a `done()` poll and
 * a `stop()` that flips the seam's parent to PID 1) returns. `stop()` is guaranteed to run
 * even if `drive` throws, so a failing branch never leaves the follow repainting into real
 * stdout. */
async function withSalvageFollow(
  seed: (repo: string) => void,
  args: string[],
  intervalMs: number,
  tty: boolean,
  drive: (h: { cap: { out: () => string }; done: () => boolean; stop: () => void; repo: string }) => Promise<void> | void,
): Promise<void> {
  const repo = makeRepo();
  seed(repo);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  const onDone = () => (done = true);
  const promise = cmdSalvage(repo, args, { ppid: () => parent, intervalMs, tty }).then(onDone);
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

test("salvage -f repaints the kept list until its parent exits, then prints nothing", async () => {
  await withSalvageFollow(
    (repo) =>
      seedSalvage(repo, [
        { name: "a.patch", ageMs: 3 * 3600_000 },
        { name: "b.patch", ageMs: 30_000 },
      ]),
    ["-f"],
    5,
    false,
    async ({ cap, done, stop }) => {
      await sleep(60);
      const frames = cap.out();
      assert.ok((frames.match(/salvaged workspace patches: 2/g) ?? []).length >= 2, "at least two frames repainted");
      assert.match(frames, /1\. a\.patch/, "oldest patch is listed first");
      assert.match(frames, /2\. b\.patch/);
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
      assert.ok(done(), "follow resolves once the parent is gone");
      const before = cap.out();
      await sleep(30);
      assert.equal(cap.out(), before, "nothing printed after the follow ended");
    },
  );
});

test("salvage -f re-reads .tumwater/salvage/ each frame — a newly kept patch appears in a later frame", async () => {
  await withSalvageFollow(
    (repo) => seedSalvage(repo, [{ name: "a.patch", ageMs: 3 * 3600_000 }]),
    ["-f"],
    5,
    false,
    async ({ cap, repo, done, stop }) => {
      // The first frame(s) show the seeded patch alone.
      await sleep(30);
      assert.match(cap.out(), /1\. a\.patch/);
      assert.doesNotMatch(cap.out(), /b\.patch/, "the later patch is not in the early frames");
      // A patch a run keeps mid-follow: the next repaint re-reads the dir and shows it.
      fs.writeFileSync(path.join(salvageDir(repo), "b.patch"), "newly kept patch\n");
      await sleep(40);
      assert.match(cap.out(), /2\. b\.patch/, "a patch kept mid-follow appears in a later frame");
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
      assert.ok(done(), "follow resolves once the parent is gone");
    },
  );
});

test("salvage -f --grep mid repaints only the matching patch under its whole-list number", async () => {
  await withSalvageFollow(
    (repo) =>
      seedSalvage(repo, [
        { name: "a.patch", ageMs: 3 * 3600_000 },
        { name: "mid.patch", ageMs: 2 * 3600_000 },
        { name: "z.patch", ageMs: 3600_000 },
      ]),
    ["-f", "--grep", "mid"],
    5,
    false,
    async ({ cap, done, stop }) => {
      await sleep(60);
      const frames = cap.out();
      assert.ok((frames.match(/salvaged workspace patches: 1/g) ?? []).length >= 2, "at least two filtered frames repainted");
      assert.match(frames, /2\. mid\.patch/, "the matching patch keeps its whole-list number");
      assert.doesNotMatch(frames, /a\.patch|z\.patch/, "non-matching patches never print");
      stop();
      for (let i = 0; i < 500 && !done(); i++) await sleep(10);
      assert.ok(done(), "follow resolves once the parent is gone");
      const before = cap.out();
      await sleep(30);
      assert.equal(cap.out(), before, "nothing printed after the follow ended");
    },
  );
});

test("salvage -f --json is refused before any frame, with no clear-screen", async () => {
  const repo = makeRepo();
  seedSalvage(repo, [{ name: "a.patch", ageMs: 3 * 3600_000 }]);
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdSalvage(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /salvage --json prints one document/);
    const out = cap.out();
    assert.doesNotMatch(out, /salvaged workspace patches/, "no salvage frame before the refusal");
    assert.ok(!out.includes(CLEAR), "no clear-screen before the refusal");
  } finally {
    cap.restore();
  }
});

test("salvage -f clears the screen only on a TTY", async () => {
  const seed = (repo: string) => seedSalvage(repo, [{ name: "a.patch", ageMs: 3 * 3600_000 }]);
  await withSalvageFollow(seed, ["-f"], 5, true, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(out.startsWith(CLEAR), `TTY follow starts with a clear-screen (first 20 chars: ${JSON.stringify(out.slice(0, 20))})`);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withSalvageFollow(seed, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(20);
    const out = cap.out();
    assert.ok(!out.includes(CLEAR), "non-TTY follow never clears the screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});
