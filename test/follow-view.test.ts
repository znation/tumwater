import test from "node:test";
import assert from "node:assert/strict";
import { followView } from "../src/cli/follow-view.js";
import { captureStdout } from "./helpers/exit-capture.js";

// `followView`'s first frame is painted (and awaited) outside the repaint loop, so a throw
// or rejection in that first read used to propagate out of followView and kill the whole
// interactive follow command, while the identical failure a tick later was caught and
// skipped by the loop's `painting` guard. This test pins the first frame to the same guard:
// a failed first frame is skipped and the follow repaints on the next tick instead of dying.
// Only setInterval is mocked (like status-follow.test.ts), so each repaint and each
// parent-death poll is a mock-clock tick rather than a wall-clock budget.
test("followView rides through a first-frame failure and repaints on the next tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const parent = { value: 4242 };
  let calls = 0;
  let done = false;
  let failure: unknown = null;
  const cap = captureStdout();
  const promise = followView(
    () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("transient git read failure"));
      return Promise.resolve(`frame${calls}`);
    },
    { ppid: () => parent.value, intervalMs: 5, tty: false },
  ).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    // Let the first-paint microtask chain settle so the repaint interval and parent-death
    // poll register as mock timers (the first paint fails, and with the guard the loop then
    // registers them). The chain is several `.then` hops deep, so yield repeatedly.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // Flip the parent and tick once: the repaint interval (registered before the death poll)
    // retries the frame on this tick, painting frame2, then the death poll ends the follow.
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    await Promise.resolve(); // let the repaint's paint microtask land before reading stdout
    assert.ok(done, "follow resolves even though its first frame failed");
    assert.equal(failure, null, "a first-frame failure never rejects the follow");
    assert.equal(calls, 2, "the follow retried the frame on the next tick");
    assert.match(cap.out(), /frame2/, "the retried frame is painted");
  } finally {
    // Flip and await even on a failing assertion so no follow or interval outlives the test.
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
