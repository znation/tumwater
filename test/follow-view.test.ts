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

// A SYNC frame (status, backlog, report all pass sync frameText reads) that throws on a
// repaint tick must be skipped and retried like the async path's `.catch`, not thrown out of
// the setInterval callback as an uncaught exception that kills the whole interactive follow —
// before the guard, the identical transient failure was skipped a tick later (async) but fatal
// on a sync tick, a different outcome for the same failure depending only on the read's sync/async
// shape. This test pins the sync read (and its paint) to the same skip-and-retry policy.
test("followView rides through a sync frame throw on a tick and repaints on the next", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  // The runner sets TUMWATER_SUPERVISOR_PID (see its suiteEnv), so followView's parent watch
  // compares the polling ppid against that expected pid. Match it so the watch stays down
  // across the throwing and recovered ticks, then flip it to end the follow; when the runner
  // did not set it, any distinct ppid keeps the watch down until flipped.
  const expected = process.env.TUMWATER_SUPERVISOR_PID
    ? Number(process.env.TUMWATER_SUPERVISOR_PID)
    : 4242;
  const parent = { value: expected };
  let calls = 0;
  let done = false;
  let failure: unknown = null;
  const cap = captureStdout();
  const promise = followView(
    () => {
      calls += 1;
      if (calls === 1) return Promise.resolve("frame1");
      if (calls === 2) throw new Error("transient sync read failure"); // the sync-path fault
      return `frame${calls}`;
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
    // Let the first-paint chain settle so the repaint interval and parent-death poll register.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // Tick 1 (parent still alive): the sync read throws before painting — it must be skipped,
    // not thrown out of the setInterval callback. Tick 2: the sync read recovers and paints
    // frame3. Only then flip the parent and tick once more for the death-watch to end it.
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    await Promise.resolve();
    assert.ok(done, "follow resolves even though a sync frame threw on a tick");
    assert.equal(failure, null, "a sync tick throw never rejects the follow");
    assert.ok(calls >= 3, "the follow retried the frame after the sync throw");
    assert.match(cap.out(), /frame3/, "the recovered sync frame is painted");
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
