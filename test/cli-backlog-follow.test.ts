import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cmdBacklog } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, seedOpenBug, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { cli } from "./helpers/cli-harness.js";

// `backlog -f` runs in-process with the follow's parent-death and TTY seams, driving the
// follow deterministically the way status-follow.test.ts drives `status -f`: mock only
// setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve (status-follow was quarantined twice,
// 2026-10-21, because a real 5 ms repaint interval fired too slowly on a loaded machine to
// meet a 5 s polling budget; logical time has no jitter to eat).

const CLEAR = "\x1b[H\x1b[2J";

/** A repo whose PLANS.md ## Planned holds `body` and BUGS.md an open bug, flushed past the
 * previous test's runner output (backlog has no requireReadyRepo gate, but the init keeps the
 * seeding shape aligned with the other follow tests). */
async function seedBacklogRepo(body: string, name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  writeBacklogFile(repo, "PLANS.md", [
    { heading: "## Planned", body },
    { heading: "## Done" },
  ]);
  seedOpenBug(repo);
  await sleep(50);
  return repo;
}

/** Start a follow on `repo` with `setInterval` mocked, drive it with `t.mock.timers.tick`:
 * wait (real time, generously) for the readiness gate to pass and the first frame to render —
 * that is when the follow's repaint and parent-death intervals exist as mock timers — then
 * tick the 5 ms cadence until `count` reads `waitForFrames` frames, flip the parent away,
 * tick once more for the death-watch to end the follow, and confirm nothing repaints once it
 * has. Returns the output captured before the parent flip, with the follow already resolved. */
async function runFollow(
  t: TestContext,
  repo: string,
  args: string[],
  seams: Parameters<typeof cmdBacklog>[2],
  waitForFrames: number,
  count: (out: string) => number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  // The follow's promise is driven by mock ticks, so it is awaited only after the death-watch
  // tick resolves it; the rejection branch records a real follow failure (surfaced below) while
  // still setting `done`, so the waits terminate and no rejection goes unhandled.
  const promise = cmdBacklog(repo, args, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    }
  );
  try {
    // The follow renders its first frame synchronously as soon as its readiness gate passes, so
    // the initial frame's appearance marks when the repaint interval and parent-death poll are
    // registered (as mock timers). Before that, ticks would be no-ops, so wait for it in real
    // time — this depends only on the gate (a git read), not on the 5 ms cadence the flake was
    // about, so a generous bound is safe and costs nothing on the success path.
    let out = cap.out();
    for (let i = 0; i < 3000 && count(out) < 1 && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(count(out) >= 1, "first frame rendered after the readiness gate");
    // Drive the repaint interval deterministically: each 5 ms tick fires one frame.
    for (let guard = 0; count(out) < waitForFrames && guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(count(out) >= waitForFrames, `got ${count(out)} of ${waitForFrames} frames`);
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

const ALPHA = "### Alpha (planned 2026-01-01 by operator)\n\nBody.";

test("backlog -f repaints until its parent exits, then prints nothing", async (t) => {
  const repo = await seedBacklogRepo(ALPHA, "backlog follow");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /Alpha/);
  assert.match(out, /An open bug/);
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("backlog -f --ready keeps only ready entries and names the hidden count", async (t) => {
  const repo = await seedBacklogRepo(
    "### Ready plan (planned 2026-01-01 by operator)\n\nBody.\n\n### Refused plan (planned 2026-01-02 by operator)\n\n**Refused 2026-10-07 by feature: no**",
    "backlog follow ready",
  );
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["--ready", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/### Ready plan/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /### Ready plan/);
  assert.doesNotMatch(out, /Refused plan/, "a --ready follow never shows held entries");
  assert.match(out, /_\((\d+) held entries hidden; run `tumwater backlog` to see them\)_/);
});

test("backlog -f --grep keeps only matching entries", async (t) => {
  const repo = await seedBacklogRepo(
    "### Zebra plan (planned 2026-01-01 by operator)\n\n**Goal.** Feed the zebra.\n\n### Other plan (planned 2026-01-02 by operator)\n\nOther body.",
    "backlog follow grep",
  );
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f", "--grep", "Zebra"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/### Zebra plan/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /### Zebra plan/);
  assert.doesNotMatch(out, /### Other plan/, "a --grep follow keeps only matching entries");
});

test("backlog -f --json is refused", async () => {
  const repo = await seedBacklogRepo(ALPHA, "backlog follow json");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdBacklog(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /backlog --json prints one document/);
    assert.ok(!cap.out().includes("# tumwater backlog"), "no backlog heading printed");
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
  } finally {
    cap.restore();
  }
});

test("backlog --grep -f does not enter follow mode over its own pattern", async () => {
  const repo = await seedBacklogRepo(
    "### Dash-f plan (planned 2026-01-01 by operator)\n\nThe -f flag lives in this body.",
    "backlog grep dash-f pattern",
  );
  // The pattern "-f" used to be read as the follow flag itself: the command hung following
  // the backlog instead of grepping for the literal text. cli() bounds the run at 20 s, so a
  // plain exit-0 with one matched snapshot frame IS the assertion — pre-fix this test times out.
  const r = await cli(repo, "backlog", "--grep", "-f");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dash-f plan/);
  assert.equal((r.stdout.match(/Dash-f plan/g) ?? []).length, 1, "one snapshot frame, then it exited");
});

test("backlog -f clears the screen only on a TTY", async (t) => {
  const repo = await seedBacklogRepo(ALPHA, "backlog follow tty");
  let parent = { value: 4242 };
  const ttyOut = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, 1, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
  parent = { value: 4242 };
  const pipedOut = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
  assert.ok(!pipedOut.includes(CLEAR), "non-TTY follow never clears the screen");
});
