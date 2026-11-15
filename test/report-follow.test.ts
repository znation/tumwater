import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cmdReport } from "../src/report/report.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { followSeams, runFollowedView } from "./fixtures/follow-fixtures.js";

// `report -f` runs in-process with the follow's parent-death and TTY seams, driving the
// follow deterministically the way status-follow.test.ts drives `status -f`: mock only
// setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve. report has no ready-repo gate (its
// collectors degrade to zeros on a missing file), so the repo is just a makeRepo() tmpdir —
// the first frame renders synchronously as soon as the follow starts.

const CLEAR = "\x1b[H\x1b[2J";
const USAGE_HEADING = "# tumwater usage report";
const FAILURE_HEADING = "# tumwater failure digest";

/** Start a `report -f` follow on `repo` with `setInterval` mocked, drive it with
 * `t.mock.timers.tick`: tick the 5 ms cadence until `waitForFrames` frames have repainted,
 * flip the parent away, tick once more for the death-watch to end the follow, and confirm
 * nothing repaints once it has. Returns the output captured before the parent flip, with the
 * follow already resolved. */
async function runFollow(
  t: TestContext,
  repo: string,
  args: string[],
  seams: NonNullable<Parameters<typeof cmdReport>[2]>,
  heading: string,
  waitForFrames: number,
  flipParent: () => void,
): Promise<string> {
  // The frame counter is the report's heading; the orchestration is the shared helper.
  return runFollowedView(
    t,
    (seams) => cmdReport(repo, args, seams),
    seams,
    (o) => (o.match(new RegExp(heading, "g")) ?? []).length,
    waitForFrames,
    flipParent,
  );
}

test("report -f repaints until its parent exits, then prints nothing", async (t) => {
  const repo = makeRepo();
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["-f"], followSeams(() => parent.value), USAGE_HEADING, 2, () => (parent.value = 1));
  assert.ok(out.includes(USAGE_HEADING), "frames carry the usage report heading");
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("report -f --failures repaints the failure digest", async (t) => {
  const repo = makeRepo();
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["--failures", "-f"], followSeams(() => parent.value), FAILURE_HEADING, 2, () => (parent.value = 1));
  assert.ok(out.includes(FAILURE_HEADING), "frames carry the failure digest heading");
});

test("report -f --json is refused", async () => {
  const repo = makeRepo();
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdReport(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /report --json prints one document/);
    assert.equal(cap.out(), "", "no report heading or clear-screen printed");
  } finally {
    cap.restore();
  }
});

test("report -f --since is refused", async () => {
  const repo = makeRepo();
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdReport(repo, ["-f", "--since", "1d"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /report --since/);
    assert.equal(cap.out(), "", "no report heading printed");
  } finally {
    cap.restore();
  }
});

test("report -f clears the screen only on a TTY", async (t) => {
  const repo = makeRepo();
  let parent = { value: 4242 };
  const ttyOut = await runFollow(t, repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, USAGE_HEADING, 1, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
  parent = { value: 4242 };
  const pipedOut = await runFollow(t, repo, ["-f"], followSeams(() => parent.value), USAGE_HEADING, 1, () => (parent.value = 1));
  assert.ok(!pipedOut.includes(CLEAR), "non-TTY follow never clears the screen");
});
