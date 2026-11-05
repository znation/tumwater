import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdRunDetail } from "../src/history/run-detail.js";
import type { FollowViewSeams } from "../src/cli/follow-view.js";
import type { HarnessEvent } from "../src/events/events.js";
import { eventsLogPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { initProject } from "../src/init/init.js";
import { cli } from "./helpers/cli-harness.js";
import { captureStdout } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `history <role> <n> -f` runs in-process with the follow's parent-death and TTY seams, the
// way cli-role-follow.test.ts drives `role -f`: mock only setInterval so each repaint and
// each parent-death poll is a tick, never a wall-clock budget the suite's concurrent load can
// starve. The seeded run is bugfix #3, in flight after one review event.

const CLEAR = "\x1b[H\x1b[2J";
const SEED: HarnessEvent[] = [
  { ts: 1000, source: "bugfix", type: "run_start", run: 3 } as HarnessEvent,
  { ts: 2000, source: "bugfix", type: "review_verdict", head: "abc", durationMs: 900 } as HarnessEvent,
];
const APPEND: HarnessEvent = { ts: 3000, source: "bugfix", type: "review_verdict", head: "def", durationMs: 900 } as HarnessEvent;

function seedRepo(): string {
  const repo = makeRepo();
  writeEvents(repo, SEED);
  return repo;
}

/** Start a follow on `repo` with `setInterval` mocked, drive it with `t.mock.timers.tick`:
 * wait (real time, generously) for the first frame to render — that is when the follow's
 * repaint and parent-death intervals exist as mock timers — then tick the 5 ms cadence until
 * `count` reads `waitForFrames` frames, flip the parent away, tick once more for the death
 * watch to end the follow, and confirm nothing repaints once it has. */
async function runFollow(
  t: TestContext,
  repo: string,
  args: string[],
  seams: FollowViewSeams,
  opts: { opts?: Record<string, unknown>; waitForFrames?: number; count: (out: string) => number; flipParent: () => void },
): Promise<string> {
  const waitForFrames = opts.waitForFrames ?? 2;
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdRunDetail(repo, args, false, opts.opts ?? {}, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    let out = cap.out();
    for (let i = 0; i < 3000 && opts.count(out) < 1 && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(opts.count(out) >= 1, "first frame rendered");
    for (let guard = 0; opts.count(out) < waitForFrames && guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(opts.count(out) >= waitForFrames, `got ${opts.count(out)} of ${waitForFrames} frames`);
    const repainted = out;
    opts.flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
    const settled = cap.out();
    t.mock.timers.tick(60_000); // retired-name-ok: node:test mock clock
    assert.equal(cap.out(), settled, "nothing printed after the follow ended");
    return repainted;
  } finally {
    // Flip and await even when an assertion above throws, so a failure never leaves the
    // follow's interval or watch running into real stdout or keeping the test process alive.
    opts.flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    try {
      await promise;
    } catch {
      // Rejection already recorded above.
    }
    t.mock.timers.reset();
    cap.restore();
  }
}

test("history <role> <n> -f repaints the run's trail until its parent exits, then prints nothing", async (t) => {
  const repo = seedRepo();
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["bugfix", "3"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    {
      opts: { follow: true },
      count: (o) => (o.match(/bugfix run #3 — /g) ?? []).length,
      flipParent: () => (parent.value = 1),
    },
  );
  assert.ok(out.includes("in flight"), "the in-flight header renders");
  assert.ok(out.includes("review approved abc"), "the seeded event renders");
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
  assert.ok(/\S\n\n\S/.test(out), "a piped follow separates frames with a blank line");
  assert.equal(process.exitCode ?? 0, 0, "a parent-death exit leaves the exit code at 0");
});

test("history <role> <n> --follow repaints too (long flag spelling)", async (t) => {
  const repo = seedRepo();
  const parent = { value: 4242 };
  await runFollow(
    t,
    repo,
    ["bugfix", "3"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    {
      opts: { follow: true },
      waitForFrames: 2,
      count: (o) => (o.match(/bugfix run #3 — /g) ?? []).length,
      flipParent: () => (parent.value = 1),
    },
  );
});

test("history <role> <n> -f shows an event appended between frames in the next frame", async (t) => {
  const repo = seedRepo();
  const parent = { value: 4242 };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdRunDetail(repo, ["bugfix", "3"], false, { follow: true }, { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    // Wait for the first frame (the one-review trail on screen).
    let out = cap.out();
    for (let i = 0; i < 3000 && !out.includes("bugfix run #3") && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    // Append a second review event to the log; the next repaint must carry it, and the first
    // frame must still show the one-review trail.
    fs.appendFileSync(eventsLogPath(repo), JSON.stringify(APPEND) + "\n");
    for (let guard = 0; guard < 10_000 && !out.includes("review approved def"); guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(out.includes("review approved def"), "the appended event shows in a later frame");
    const firstFrame = out.slice(0, out.indexOf("review approved def"));
    assert.ok(!firstFrame.includes("review approved def"), "the frame before the append is event-less");
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
  } finally {
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    try {
      await promise;
    } catch {
      // Rejection already recorded above.
    }
    t.mock.timers.reset();
    cap.restore();
  }
});

test("history <role> <n> -f clears the screen only on a TTY", async (t) => {
  const repo = seedRepo();
  const parent = { value: 4242 };
  const ttyOut = await runFollow(
    t,
    repo,
    ["bugfix", "3"],
    { ppid: () => parent.value, intervalMs: 5, tty: true },
    {
      opts: { follow: true },
      waitForFrames: 1,
      count: (o) => (o.match(/bugfix run #3 — /g) ?? []).length,
      flipParent: () => (parent.value = 1),
    },
  );
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
});

test("history <role> <n> -f --json is refused with no frame and no JSON", async () => {
  // The dispatcher (runTrailCommand) owns the refusal, so drive the real CLI process — the
  // in-process cmdRunDetail never sees --json and -f together. The repo is initialized so the
  // refusal is the first failure, not the ready-repo gate's.
  const repo = seedRepo();
  await initProject(repo, "run detail follow json");
  const r = await cli(repo, "history", "bugfix", "3", "-f", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /history --json prints one document; -f\/--follow repaints a live view/);
  assert.ok(!r.stdout.includes(CLEAR), "no clear-screen printed");
  assert.ok(!r.stdout.includes("bugfix run #3"), "no frame printed");
});

test("history <role> <n> -f with a missing run stays the one-shot not-found line, exit 0, no loop", async () => {
  const repo = seedRepo();
  const cap = captureStdout();
  try {
    // No mock timers armed: if the follow loop ever started, this would hang the suite —
    // the not-found answer must return before the loop.
    await cmdRunDetail(repo, ["bugfix", "99"], false, { follow: true }, { ppid: () => 4242, intervalMs: 5, tty: false });
    assert.match(cap.out(), /no run #99 for bugfix in the scanned window/);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
  } finally {
    cap.restore();
  }
});

test("history <role> <n> -f with --last pins the run resolved on the first frame", async (t) => {
  // --last resolves the newest COMPLETED run, so the pinned run #3 must be complete here —
  // the in-flight SEED alone would make the --last scan miss and the one-shot not-found line
  // stand instead of a follow.
  const repo = makeRepo();
  writeEvents(repo, [...SEED, { ts: 3500, source: "bugfix", type: "run_end", run: 3, result: "no_change" } as HarnessEvent]);
  const parent = { value: 4242 };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdRunDetail(repo, ["bugfix"], false, { last: true, follow: true }, { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    let out = cap.out();
    for (let i = 0; i < 3000 && !out.includes("bugfix run #3") && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    // A newer completed run (bugfix #4) lands in the log: --last would resolve it on a rerun,
    // but the follow keeps pinning #3 — the frame count stays on #3's trail.
    fs.appendFileSync(
      eventsLogPath(repo),
      JSON.stringify({ ts: 4000, source: "bugfix", type: "run_start", run: 4 } as HarnessEvent) +
        "\n" +
        JSON.stringify({ ts: 5000, source: "bugfix", type: "run_end", run: 4, result: "no_change" } as HarnessEvent) +
        "\n",
    );
    for (let guard = 0; guard < 10_000 && (out.match(/bugfix run #3 — /g) ?? []).length < 3; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(out.includes("bugfix run #3"), "the pinned run's trail keeps repainting");
    assert.ok(!out.includes("run #4"), "the newer completed run does not take over the view");
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
  } finally {
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    try {
      await promise;
    } catch {
      // Rejection already recorded above.
    }
    t.mock.timers.reset();
    cap.restore();
  }
});
