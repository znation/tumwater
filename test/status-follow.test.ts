import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cmdStatus } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `status -f` runs in-process with the follow's parent-death and TTY seams, driving the
// follow deterministically the way cli-log-commands.test.ts drives `logs -f`: mock only
// setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve. status-follow was quarantined twice
// (2026-10-21) because a real 5 ms repaint interval fired too slowly on a loaded machine
// to meet a 5 s polling budget; logical time has no jitter to eat.

const CLEAR = "\x1b[H\x1b[2J";

/** A ready repo with a fresh team, flushed past the previous test's runner output. */
async function readyRepo(name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  return repo;
}

/** Start a follow on `repo` with `setInterval` mocked, drive it with `t.mock.timers.tick`:
 * wait (real time, generously) for the readiness gate to pass and the first frame to render —
 * that is when the follow's repaint and parent-death intervals exist as mock timers — then
 * tick the 5 ms cadence until `waitForFrames` frames have repainted, flip the parent away,
 * tick once more for the death-watch to end the follow, and confirm nothing repaints once it
 * has. Returns the output captured before the parent flip, with the follow already resolved. */
async function runFollow(t: TestContext, repo: string, args: string[], seams: Parameters<typeof cmdStatus>[2], waitForFrames: number, flipParent: () => void): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  // The follow's promise is driven by mock ticks, so it is awaited only after the death-watch
  // tick resolves it; the rejection branch records a real follow failure (surfaced below) while
  // still setting `done`, so the waits terminate and no rejection goes unhandled.
  const promise = cmdStatus(repo, args, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    }
  );
  try {
    const frames = (out: string) => (out.match(/tumwater ·/g) ?? []).length;
    // The follow renders its first frame synchronously as soon as its readiness gate passes, so
    // the initial frame's appearance marks when the repaint interval and parent-death poll are
    // registered (as mock timers). Before that, ticks would be no-ops, so wait for it in real
    // time — this depends only on the gate (a git read), not on the 5 ms cadence the flake was
    // about, so a generous bound is safe and costs nothing on the success path.
    let out = cap.out();
    for (let i = 0; i < 3000 && frames(out) < 1 && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(frames(out) >= 1, "first frame rendered after the readiness gate");
    // Drive the repaint interval deterministically: each 5 ms tick fires one frame.
    for (let guard = 0; frames(out) < waitForFrames && guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(frames(out) >= waitForFrames, `got ${frames(out)} of ${waitForFrames} frames`);
    const repainted = out;
    // Flip the parent away; the death-watch poll (same 5 ms cadence) fires on the next tick.
    flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
    // Nothing is repainted once the follow ended: both intervals were cleared on resolve, so
    // advancing the mock clock far cannot change the captured output.
    const settled = cap.out();
    t.mock.timers.tick(60_000); // retired-name-ok: node:test mock clock
    assert.equal(cap.out(), settled, "nothing printed after the follow ended");
    return repainted;
  } finally {
    // Flip and await even when an assertion above throws, so a failure never leaves the follow's
    // interval or watch running into real stdout or keeping the test process alive.
    flipParent();
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

test("status -f repaints until its parent exits, then prints nothing", async (t) => {
  const repo = await readyRepo("status follow");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, () => (parent.value = 1));
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("status -f --role keeps only the listed role's rows", async (t) => {
  const repo = await readyRepo("status follow role");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["--role", "feature", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, () => (parent.value = 1));
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

test("status -f clears the screen only on a TTY", async (t) => {
  const repo = await readyRepo("status follow tty");
  let parent = { value: 4242 };
  const ttyOut = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, 1, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
  parent = { value: 4242 };
  const pipedOut = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, () => (parent.value = 1));
  assert.ok(!pipedOut.includes(CLEAR), "non-TTY follow never clears the screen");
});

test("status -f strips terminal controls from rendered data", async (t) => {
  // A project whose name (the repo basename, which the header renders as `tumwater · <name>`)
  // carries a terminal escape sequence: hostile content the follow reprints raw on each frame.
  // The one-shot `status` sanitizes at say(); the follow bypasses say(), so it must strip the
  // controls itself. Regression: before the fix the ESC-and-bracket sequence appeared verbatim.
  const hostile = path.join(tmpdir(), `evil\x1b[31msite`);
  const repo = makeRepo(hostile);
  await initProject(repo, "hostile name");
  await sleep(50);
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, () => (parent.value = 1));
  assert.ok(!out.includes("evil\x1b[31m"), "the hostile control sequence is stripped before it reaches the terminal");
});
