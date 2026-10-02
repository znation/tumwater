import test from "node:test";
import assert from "node:assert/strict";
import { CHECK_TIER, withCheckPermit } from "../src/check-permit.js";
import { runScopedBuildCheck } from "../src/build-check.js";
import { readEvents } from "../src/event-read.js";
import { buildCheckFixture } from "./loop-fixtures.js";
import { sleep } from "./wait.js";

// A held permit is module-global state, so every test must let its work finish (and any
// rejected run hand its permit back) before the next one starts — a leaked permit would
// park every later acquire in this file.

// Flush microtasks so "has the caller queued yet" is deterministic rather than
// timing-dependent (same pattern as test/semaphore.test.ts).
const flush = () => new Promise<void>((r) => setImmediate(r));

test("withCheckPermit bounds concurrency to the configured cap", async () => {
  const cfg = { maxConcurrentChecks: 2 };
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, () =>
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(15);
      running -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("withCheckPermit calls its wait hooks only when the permit is not free", async () => {
  const cfg = { maxConcurrentChecks: 1 };
  const calls: string[] = [];
  const hooks = { waiting: () => calls.push("waiting"), granted: () => calls.push("granted") };
  // A free permit: no wait, no hooks.
  await withCheckPermit(cfg, CHECK_TIER.other, async () => calls.push("ran-free"), hooks);
  assert.deepEqual(calls, ["ran-free"]);
  calls.length = 0;
  // A held permit: the second caller announces its wait, then the grant, then runs.
  let releaseFirst!: () => void;
  const first = withCheckPermit(cfg, CHECK_TIER.other, () => new Promise<void>((r) => (releaseFirst = r)));
  await flush();
  const second = withCheckPermit(cfg, CHECK_TIER.other, async () => calls.push("ran"), hooks);
  await flush();
  assert.deepEqual(calls, ["waiting"], "parked behind the held permit");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["waiting", "granted", "ran"]);
});

test("a valid config raises the cap for the next checks", async () => {
  // The default cap is 2; three concurrent checks can only all run if the config's
  // maxConcurrentChecks was applied to the shared semaphore at acquire time.
  const cfg = { maxConcurrentChecks: 3 };
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 3 }, () =>
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(15);
      running -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(peak, 3);
});

test("an invalid or missing config falls back to the default cap", async () => {
  // Raise the shared cap to 3 first so the fallback (default 2) is actually observable:
  // without the fallback these three checks would all run at once.
  await withCheckPermit({ maxConcurrentChecks: 3 }, CHECK_TIER.other, async () => {});
  let running = 0;
  let peak = 0;
  const run = () =>
    withCheckPermit(undefined as never, CHECK_TIER.other, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(15);
      running -= 1;
    });
  // Missing, sub-one, and non-integer caps must all take the default, never a value the
  // semaphore could not grant under.
  await Promise.all([run(), run(), run()]);
  assert.equal(peak, 2);

  await Promise.all([
    withCheckPermit({ maxConcurrentChecks: 0 }, CHECK_TIER.other, () => sleep(15)),
    withCheckPermit({ maxConcurrentChecks: 1.5 }, CHECK_TIER.other, () => sleep(15)),
    withCheckPermit({ maxConcurrentChecks: -2 }, CHECK_TIER.other, () => sleep(15)),
  ]);
});

test("a failing check still releases its permit", async () => {
  const cfg = { maxConcurrentChecks: 1 };
  await assert.rejects(
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // If the permit leaked, this acquire would hang forever — race it against a timeout so
  // the regression fails the test instead of hanging the suite.
  let released = false;
  await Promise.race([
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      released = true;
    }),
    sleep(1000).then(() => {
      throw new Error("permit was not released after a failing check");
    }),
  ]);
  assert.equal(released, true);
});

test("a nested withCheckPermit runs under the permit already held", async () => {
  // At a cap of 1 a non-reentrant inner call could never be granted: the only permit is
  // held by the very call waiting for it. Reentrancy is what keeps this from deadlocking.
  let innerRan = false;
  await withCheckPermit({ maxConcurrentChecks: 1 }, CHECK_TIER.other, async () => {
    await withCheckPermit({ maxConcurrentChecks: 1 }, CHECK_TIER.other, async () => {
      innerRan = true;
    });
    assert.equal(innerRan, true, "the nested call ran inside the held permit");
  });
});

test("a merge-tier waiter is granted ahead of an earlier other-tier waiter", async () => {
  // A merge-scope check runs inside the merge lock, so every check it waits behind is
  // lock-hold time for every other landing — the merge tier must jump the queue.
  // The holder parks on a test-controlled gate, not a timer: a timer can expire under
  // load before both waiters are queued, and the release then hands the permit to the
  // only waiter present (the other-tier one) — the queue-jump the test asserts on never
  // gets a chance to happen. With the gate, the holder cannot release until both
  // waiters are parked, so the grant order is observable by construction.
  const cfg = { maxConcurrentChecks: 1 };
  const granted: string[] = [];
  let releaseHolder: () => void = () => {};
  const holderGate = new Promise<void>((r) => {
    releaseHolder = r;
  });
  const holder = withCheckPermit(cfg, CHECK_TIER.other, async () => {
    await holderGate;
    granted.push("holder");
  });
  await flush(); // holder now holds the only permit
  const other = withCheckPermit(cfg, CHECK_TIER.other, async () => {
    granted.push("other");
  });
  await flush(); // other is parked in the queue first
  const merge = withCheckPermit(cfg, CHECK_TIER.merge, async () => {
    granted.push("merge");
  });
  await flush(); // merge is parked behind it, at the better tier
  releaseHolder(); // only now can the permit change hands — both waiters are queued
  await Promise.all([holder, other, merge]);
  assert.deepEqual(granted, ["holder", "merge", "other"]);
});

// ── Process-wide check cap (PLANS.md "Land-queue speed 2b"): every full suite takes one permit
// from a single semaphore sized by config.maxConcurrentChecks, so a burst of landings cannot
// stack suites on the host. The cap lives in src/check-permit.ts; these tests drive it through
// runScopedBuildCheck (the checks' real entry point) as well as withCheckPermit directly.

const ROLE = "improve";

/** Let every already-queued continuation run, so a permit that could be granted has been. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("at the default cap of 2, a third concurrent check starts only after one of the first two finishes", async () => {
  const { root, wt } = buildCheckFixture();
  // The sleep keeps the first two in flight long enough that an uncapped third would start
  // beside them. Every timing below is the harness's own: each build_check event carries the
  // run's spawnedAt/settledAt, stamped as the permit holder spawns and reaps its check — not
  // stamps the check's shell writes, whose node startup a loaded host delays by seconds, so a
  // first-wave run's "start" could land after the other's end and misname the waiter.
  const results = await Promise.all(
    [1, 2, 3].map(() => runScopedBuildCheck(root, ROLE, "gate", wt, { check: { command: "sleep 1" } }, 30_000)),
  );
  const finishedAt = Date.now();
  for (const r of results) assert.equal(r!.outcome.status, "passed");
  const events = readEvents(root)
    .filter((ev) => ev.type === "build_check")
    .map((ev) => ({ spawnedAt: Number(ev.spawnedAt), settledAt: Number(ev.settledAt), durationMs: Number(ev.durationMs) }))
    .sort((x, y) => x.spawnedAt - y.spawnedAt);
  assert.equal(events.length, 3, "the third still runs once a permit frees");
  // The waiter is the last to spawn; it must have spawned only after a first-wave run settled.
  const [first, second, waiter] = events as [(typeof events)[0], (typeof events)[0], (typeof events)[0]];
  const firstFreed = Math.min(first.settledAt, second.settledAt);
  assert.ok(second.spawnedAt < firstFreed, "two run at once");
  assert.ok(waiter.spawnedAt >= firstFreed, "the third check waited for a permit");
  // The event prices the run, not the wait: the waiter's run began no earlier than the first
  // freed permit, so its duration fits between then and the end. A wait-inclusive duration
  // would exceed that by the whole first-wave run (≥ the 1 s sleep), however loaded the host.
  const bound = finishedAt - firstFreed;
  assert.ok(
    waiter.durationMs <= bound,
    `waiter durationMs ${waiter.durationMs} > ${bound}ms since the first permit freed — it includes the permit wait`,
  );
});

test("a check that fails or times out still releases its permit", { timeout: 30_000 }, async () => {
  // At a cap of 1 a leaked permit parks every later check forever — the test timeout is the
  // backstop that turns that hang into a failure.
  const { root, wt } = buildCheckFixture();
  const one = { maxConcurrentChecks: 1 };
  const failed = await runScopedBuildCheck(root, ROLE, "gate", wt, { ...one, check: { command: "exit 1" } }, 30_000);
  assert.equal(failed!.outcome.status, "failed");
  for (const scope of ["gate", "landing"] as const) {
    const timedOut = await runScopedBuildCheck(
      root,
      ROLE,
      scope,
      wt,
      { ...one, check: { command: "sleep 5", timeoutSeconds: 0.4 } },
      30_000,
    );
    assert.equal(timedOut!.outcome.status, scope === "gate" ? "skipped" : "failed", `${scope}: timed out`);
  }
  const passed = await runScopedBuildCheck(root, ROLE, "gate", wt, { ...one, check: { command: "true" } }, 30_000);
  assert.equal(passed!.outcome.status, "passed", "the permit came back after every failure and timeout");
});

test("the check cap resizes from each caller's live config without preempting a running check", { timeout: 10_000 }, async () => {
  const one = { maxConcurrentChecks: 1 };
  const started: string[] = [];
  let releaseA!: () => void;
  const a = withCheckPermit(one, CHECK_TIER.other, () => new Promise<void>((resolve) => (releaseA = resolve)));
  const b = withCheckPermit(one, CHECK_TIER.other, async () => void started.push("b"));
  await settle();
  assert.equal(started.length, 0, "at a cap of 1, b waits behind the running a");
  // A live edit to 2 applies at the next acquire: the parked b is admitted beside a, then c.
  const c = withCheckPermit({ maxConcurrentChecks: 2 }, CHECK_TIER.other, async () => void started.push("c"));
  await Promise.all([b, c]);
  assert.deepEqual(started, ["b", "c"]);
  // Shrinking back to 1 never preempts a: the next check waits until a finishes.
  const d = withCheckPermit(one, CHECK_TIER.other, async () => void started.push("d"));
  await settle();
  assert.deepEqual(started, ["b", "c"], "a shrink caps new grants while a still runs");
  releaseA();
  await Promise.all([a, d]);
  assert.deepEqual(started, ["b", "c", "d"]);
});

test("a queued merge-scope check is granted the next permit ahead of queued gate checks", { timeout: 10_000 }, async () => {
  // A landing's check runs inside the merge lock, so every check it waited behind would be
  // lock-hold time for every other landing.
  const one = { maxConcurrentChecks: 1 };
  const order: string[] = [];
  let release!: () => void;
  const held = withCheckPermit(one, CHECK_TIER.other, () => new Promise<void>((resolve) => (release = resolve)));
  const gate = withCheckPermit(one, CHECK_TIER.other, async () => void order.push("gate"));
  const landing = withCheckPermit(one, CHECK_TIER.merge, async () => void order.push("landing"));
  await settle();
  release();
  await Promise.all([held, gate, landing]);
  assert.deepEqual(order, ["landing", "gate"]);
});

test("a check-permit request from inside a held permit runs under it instead of deadlocking", { timeout: 10_000 }, async () => {
  // At a cap of 1 a second wait from the holder could never be granted — its own holder is the
  // one blocking it. No call path nests today; this pins that a future one cannot wedge checks.
  const one = { maxConcurrentChecks: 1 };
  const inner = await withCheckPermit(one, CHECK_TIER.merge, () =>
    withCheckPermit(one, CHECK_TIER.other, async () => "nested"),
  );
  assert.equal(inner, "nested");
  // And the outer permit came back: a fresh request is granted at once.
  assert.equal(await withCheckPermit(one, CHECK_TIER.other, async () => "after"), "after");
});
