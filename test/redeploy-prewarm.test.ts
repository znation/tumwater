import test from "node:test";
import assert from "node:assert/strict";
import { type RedeployDeps, RESTART_COOLDOWN_MS } from "../src/redeploy-policy.js";
import {
  HEAD_B,
  HEAD_C,
  HEAD_D,
  IDLE,
  driveToRestart,
  fakeDeps,
  harness,
  settle,
} from "./redeploy-fixtures.js";

// The cooldown/prewarm behaviour (src/redeployer.ts's poll, with the probe tracking it
// owns in src/redeploy-probes.ts; the RESTART_COOLDOWN_MS knob it defers with lives in
// src/redeploy-policy.ts): after a completed restart the fleet defers a
// second episode until the deadline lapses, and while it defers, the pending head's green check
// and staged compile prewarm once per SHA so the lapse reaches the swap directly. These tests
// share the scripted-effect fixtures in redeploy-fixtures.ts.

test("within the cooldown a second stale episode is deferred: no hold, status carries the deadline", async () => {
  // The 2026-09-11 churn complaint in miniature: main moves again an hour after a completed
  // swap — inside the 12 h window the fleet keeps ticking on the stale build instead of holding
  // for another drain (BUGS.md).
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(
    await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 60 * 60_000),
    "none",
    "no hold: ticks continue on the stale build",
  );
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C], "the deferred head's green check prewarms during the cooldown (BUGS.md 2026-09-30)");
  assert.deepEqual(f.calls.compile, [HEAD_B], "no compile prewarm while the check is unresolved");
  const status = r.status(swappedAt + 60 * 60_000);
  assert.equal(status.stale, true, "staleness stays visible");
  assert.equal(
    status.restartBlocked,
    `cooldown until ${new Date(swappedAt + RESTART_COOLDOWN_MS).toISOString()}`,
    "the deadline is published through the restartBlocked channel",
  );
  assert.equal(status.restartPending, undefined);
  // One warning per episode, not one per poll and not one per head: a landing mid-cooldown
  // adds no new information, so a different head in the same episode stays silent
  // (BUGS.md 2026-09-19).
  assert.equal(
    await r.poll(HEAD_D, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 61 * 60_000),
    "none",
    "a different head inside the same cooldown still defers",
  );
  const warnings = events.filter((e) => e.type === "warning");
  assert.equal(warnings.length, 1, "one warning for the whole cooldown episode, not one per head");
  assert.match(String(warnings[0]!.message), /cooldown until/);
  assert.deepEqual(types(), ["build_stale", "restart_pending", "restart", "warning"]);
});

test("during the cooldown the deferred head's check and compile prewarm, so the lapse reaches the swap on its first poll", async () => {
  // The 2026-09-30 shape: the fleet sat on a stale build for the full 12 h cooldown with the
  // newer head unverified, then paid green-check + compile + drain from zero when it lapsed
  // (BUGS.md). The prewarm runs both once per SHA inside the dead window, and the episode
  // adopts the finished trackers, so a single idle poll past the deadline swaps.
  const f = fakeDeps();
  const { r, types } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000), "none");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C], "the green check prewarms once for the deferred head");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 61 * 60_000), "none");
  assert.deepEqual(f.calls.compile, [HEAD_B, HEAD_C], "a green verdict prewarms the staged compile");
  f.compiled(true);
  await settle();
  assert.deepEqual(types(), ["build_stale", "restart_pending", "restart", "warning"], "the prewarm logs no state transitions of its own");
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "the lapse seeds the episode with the prewarmed verdicts already in hand",
  );
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 10),
    "restart",
    "no second check, no second compile: the next poll swaps",
  );
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C], "no second green check");
  assert.deepEqual(f.calls.compile, [HEAD_B, HEAD_C], "no second compile");
  assert.deepEqual(f.calls.swap, [HEAD_B, HEAD_C]);
});

test("a prewarmed green check that could not run is not adopted — the episode re-runs it", async () => {
  // A rejection is no verdict (BUGS.md 2026-09-16): adopting one would replay the same dead end
  // on every retry, so the episode's own fresh check decides. The cooldown is injected directly
  // via the restart record — no completed episode needed to arm it.
  const f = fakeDeps();
  const greenCalls: string[] = [];
  const deps: RedeployDeps = {
    ...f.deps,
    mainGreen: (h) => {
      greenCalls.push(h);
      if (greenCalls.length === 1) return Promise.reject(new Error("mirror worktree broke")); // the prewarm's check
      return Promise.resolve(true); // the episode's fresh check
    },
  };
  const swappedAt = 1_000_000;
  const { r } = harness(deps, true, undefined, { lastAt: swappedAt, record: () => {} });
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000), "none", "the cooldown defers; the prewarm's check rejects");
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 61 * 60_000), "none", "the rejection prewarms nothing further");
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "the lapse starts a FRESH green check instead of adopting the rejected one",
  );
  assert.deepEqual(greenCalls, [HEAD_C, HEAD_C]);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 10), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 20), "restart");
});

test("a prewarmed compile that could not run is not adopted — the episode recompiles", async () => {
  const f = fakeDeps();
  const compileCalls: string[] = [];
  let resolveFresh: (v: { ok: boolean; detail: string }) => void = () => {};
  const deps: RedeployDeps = {
    ...f.deps,
    compile: (h) => {
      compileCalls.push(h);
      if (compileCalls.length === 1) return Promise.reject(new Error("staging dir unwritable")); // the prewarm's compile
      return new Promise((r) => (resolveFresh = r)); // the episode's fresh compile
    },
  };
  const swappedAt = 1_000_000;
  const { r } = harness(deps, true, undefined, { lastAt: swappedAt, record: () => {} });
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000), "none", "the cooldown defers; the prewarm's check runs");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 61 * 60_000), "none", "the prewarm's compile rejects");
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "the lapse seeds the episode with the prewarmed green verdict",
  );
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 10),
    "hold",
    "the compile step starts a FRESH compile instead of adopting the rejected one",
  );
  assert.deepEqual(compileCalls, [HEAD_C, HEAD_C]);
  resolveFresh({ ok: true, detail: "" });
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 20), "restart");
});

test("a prewarmed compile that finished FAILED is not adopted — the episode recompiles", async () => {
  // A finished FAILED verdict ({ok:false, detail}, no rejected flag) IS a verdict about the
  // tree — but a transient one (a tsc timeout under load, a staging hiccup) must not be
  // latched into the episode's restart_blocked: the block decision rests on a verdict the
  // episode's own step produced, so the lapse recompiles at the cost of one bounded recompile.
  const f = fakeDeps();
  const compileCalls: string[] = [];
  let resolveFresh: (v: { ok: boolean; detail: string }) => void = () => {};
  const deps: RedeployDeps = {
    ...f.deps,
    compile: (h) => {
      compileCalls.push(h);
      if (compileCalls.length === 1) return Promise.resolve({ ok: false, detail: "tsc exited 2" }); // the prewarm's FAILED verdict
      return new Promise((r) => (resolveFresh = r)); // the episode's fresh compile
    },
  };
  const swappedAt = 1_000_000;
  const { r } = harness(deps, true, undefined, { lastAt: swappedAt, record: () => {} });
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000), "none", "the cooldown defers; the prewarm's check runs");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + 61 * 60_000), "none", "the prewarm's compile finishes FAILED");
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "the lapse seeds the episode with the prewarmed green verdict",
  );
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 10),
    "hold",
    "the compile step starts a FRESH compile instead of adopting the failed verdict",
  );
  assert.deepEqual(compileCalls, [HEAD_C, HEAD_C]);
  resolveFresh({ ok: true, detail: "" });
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 20), "restart");
});

test("past the cooldown deadline the same head proceeds to a restart without main moving again", async () => {
  // Re-evaluated on every poll rather than latched like blockedHead: once the deadline passes,
  // the current head proceeds even if main never moves again (BUGS.md 2026-09-11).
  const f = fakeDeps();
  const { r } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS - 1), "none", "one ms short of the deadline still defers");
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "past it: the new episode starts its green check",
  );
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 10), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 20),
    "restart",
    "the second restart lands past the deadline",
  );
  assert.deepEqual(f.calls.swap, [HEAD_B, HEAD_C]);
});
