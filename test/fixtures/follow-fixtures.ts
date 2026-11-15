/** Follow-view test fixtures shared by the `-f/--follow` tests.
 *
 * `followSeams` spells the one-line seam shape those tests use — a parent-death watch (`ppid`),
 * a fast 5 ms repaint cadence (`intervalMs`), and no live TTY (`tty: false`) — with only `ppid`
 * varying (most tests pass `() => parent.value` so a `flipParent` in the body can kill the poll).
 * A fresh object per call, so a seam cannot leak across tests. Deliberately NOT a stand-in for
 * (kept as inline literals): a seam that keeps the live TTY (`tty: true`), one that omits `tty`
 * to exercise the `?? isTTY` default, or one that widens `intervalMs` (a deliberate slower
 * cadence) — those set a value, not the common stand-in.
 *
 * `runFollowedView` drives one follow deterministically, the way every follow test does it: enable
 * only the `setInterval` mock so each repaint and each parent-death poll is a `tick` (never a
 * wall-clock budget the suite's concurrent load can starve), start `invoke` on the mock clock —
 * the command bound to the test's own repo/args and command specifics — wait in real time for the
 * first frame (that is when the repaint and parent-death intervals exist as mock timers), tick the
 * 5 ms cadence until `count` reads `waitForFrames` frames, flip the parent away, tick once more for
 * the death-watch to end the follow, and confirm nothing repaints once it has. Returns the output
 * captured before the parent flip, with the follow already resolved; a real follow rejection is
 * rethrown after the flip. `count` is the per-view frame counter (the heading the view repaints);
 * the one non-conforming follow — doctor, whose async frames separate the tick from the paint and
 * drain one in-flight frame — keeps its own bespoke body and does not route through this. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { FollowViewSeams } from "../../src/follow-view.js";
import { captureStdout } from "../helpers/exit-capture.js";
import { sleep } from "../helpers/wait.js";

export function followSeams(ppid: () => number): FollowViewSeams {
  return { ppid, intervalMs: 5, tty: false };
}

export async function runFollowedView(
  t: TestContext,
  invoke: (seams: FollowViewSeams | undefined) => Promise<void>,
  seams: FollowViewSeams | undefined,
  count: (out: string) => number,
  waitForFrames: number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  // The follow's promise is driven by mock ticks, so it is awaited only after the death-watch tick
  // resolves it; the rejection branch records a real follow failure (rethrown below) while still
  // setting `done`, so the waits terminate and no rejection goes unhandled.
  const promise = invoke(seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    // The follow renders its first frame as soon as its readiness gate passes, so the frame's
    // appearance marks when the repaint and parent-death intervals are registered (as mock
    // timers). Before that, ticks would be no-ops, so wait for it in real time — this depends
    // only on the gate, not on the 5 ms cadence the flake was about, so a generous bound is
    // safe and costs nothing on the success path.
    let out = cap.out();
    for (let i = 0; i < 3000 && count(out) < 1 && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(count(out) >= 1, "first frame rendered");
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
