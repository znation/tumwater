import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cmdBacklog } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, seedOpenBug, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { cli } from "./helpers/cli-harness.js";
import { followSeams, runFollowedView } from "./fixtures/follow-fixtures.js";

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
  return runFollowedView(t, (seams) => cmdBacklog(repo, args, seams), seams, count, waitForFrames, flipParent);
}

const ALPHA = "### Alpha (planned 2026-01-01 by operator)\n\nBody.";

test("backlog -f repaints until its parent exits, then prints nothing", async (t) => {
  const repo = await seedBacklogRepo(ALPHA, "backlog follow");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f"], followSeams(() => parent.value), 2, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
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
  const out = await runFollow(t, repo, ["--ready", "-f"], followSeams(() => parent.value), 2, (o) => (o.match(/### Ready plan/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /### Ready plan/);
  assert.doesNotMatch(out, /Refused plan/, "a --ready follow never shows held entries");
  assert.match(out, /_\((\d+) held entries hidden; run `tumwater backlog` to see them\)_/);
});

test("backlog -f --held keeps only held entries and names the unheld count", async (t) => {
  const repo = await seedBacklogRepo(
    "### Ready plan (planned 2026-01-01 by operator)\n\nBody.\n\n### Refused plan (planned 2026-01-02 by operator)\n\n**Refused 2026-10-07 by feature: no**",
    "backlog follow held",
  );
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["--held", "-f"], followSeams(() => parent.value), 2, (o) => (o.match(/### Refused plan/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /### Refused plan/);
  assert.doesNotMatch(out, /### Ready plan/, "a --held follow never shows unheld entries");
  assert.match(out, /\(2 unheld entries hidden; run `tumwater backlog` to see them\)/);
});

test("backlog -f --grep keeps only matching entries", async (t) => {
  const repo = await seedBacklogRepo(
    "### Zebra plan (planned 2026-01-01 by operator)\n\n**Goal.** Feed the zebra.\n\n### Other plan (planned 2026-01-02 by operator)\n\nOther body.",
    "backlog follow grep",
  );
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f", "--grep", "Zebra"], followSeams(() => parent.value), 2, (o) => (o.match(/### Zebra plan/g) ?? []).length, () => (parent.value = 1));
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
  const pipedOut = await runFollow(t, repo, ["-f"], followSeams(() => parent.value), 1, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
  assert.ok(!pipedOut.includes(CLEAR), "non-TTY follow never clears the screen");
});
