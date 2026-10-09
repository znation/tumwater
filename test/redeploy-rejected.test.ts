/** The Redeployer's REJECTED-vs-verdict boundary: a check or compile that could not run — a
 * spawn failure, a thrown promise, a swap that never happened — says nothing about the tree, so
 * the episode must drop and retry rather than latch the head as blocked. Extracted from
 * redeployer.test.ts, whose remaining tests cover the episode lifecycle (hold, drain, restart),
 * the cooldown and its prewarm, and the production wiring. */

import test from "node:test";
import assert from "node:assert/strict";
import { HEAD_B, HEAD_C, IDLE, fakeDeps, harness, settle } from "./fixtures/redeploy-fixtures.js";
import { warningEvents } from "./fixtures/log-fixtures.js";

test("a compile that never ran is a rejection, not a verdict: retried instead of blocked", async () => {
  // `tsc exited ENOENT` is execFile's spawn-failure code, not a compiler exit: the compile said
  // nothing about the tree, so latching the head ("no retry until main moves") pins the fleet
  // on the stale build even after the environment recovers (BUGS.md 2026-09-28). Like the
  // REJECTED green check, the episode is dropped and the next poll re-attempts.
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  await r.poll(HEAD_B, IDLE, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, IDLE, true);
  f.compiled(false, "could not start the compile: spawn mirror ENOENT", true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "dropped, not blocked: nothing was verified about the tree");
  assert.deepEqual(types(), ["build_stale", "restart_pending", "warning"]);
  assert.match(String(events.at(-1)!.message), /could not start the rebuild of bbbbbbbb/);
  assert.equal(r.status().restartBlocked, undefined, "no latch: repairing the environment must be enough");
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "the next poll re-attempts without main moving");
  f.green(true);
  await settle();
  await r.poll(HEAD_B, IDLE, true);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "restart", "a repaired environment redeploys the same head");
  assert.deepEqual(f.calls.compile, [HEAD_B, HEAD_B]);
});

test("a rejected compile warns once per head, not once per retry", async () => {
  // The rejection path re-attempts on every poll while the environment is broken, so a warning
  // per attempt would flood the digest exactly as the latched ENOENT cluster did (64 in a day).
  // The dedupe key is the head: the same head's repeated rejection stays quiet; a new head that
  // also cannot compile is a new episode and warns again (BUGS.md 2026-09-28). The same key
  // holds the state stream quiet: a retry re-enters "compiling" without ever leaving it, so a
  // second restart_pending per head would pin the digest's newest transition there forever.
  const pending = (head: string) => events.filter((e) => e.type === "restart_pending" && e.head === head).length;
  const f = fakeDeps();
  const { r, events } = harness(f.deps);
  // Each retry emits its own restart_pending; the dedupe claim is about warnings.
  const warnings = () => warningEvents(events);
  const rejectOnce = async (head: string) => {
    await r.poll(head, IDLE, true);
    f.green(true);
    await settle();
    await r.poll(head, IDLE, true);
    f.compiled(false, "could not start the compile: spawn mirror ENOENT", true);
    await settle();
    assert.equal(await r.poll(head, IDLE, true), "none", "dropped, not blocked");
  };
  await rejectOnce(HEAD_B);
  assert.equal(warnings().length, 1);
  assert.equal(pending(HEAD_B), 1);
  assert.match(String(warnings()[0]!.message), /could not start the rebuild of bbbbbbbb/);
  await rejectOnce(HEAD_B);
  assert.equal(warnings().length, 1, "the same head's repeated rejection warns once, not per attempt");
  assert.equal(pending(HEAD_B), 1, "and its in-progress state event is logged once, not once per doomed retry");
  assert.deepEqual(f.calls.compile, [HEAD_B, HEAD_B], "and the compile was still re-attempted for the head");
  await rejectOnce(HEAD_C);
  assert.equal(warnings().length, 2, "a different head is a new episode and warns again");
  assert.equal(pending(HEAD_C), 1, "the new head's compile start is a fresh state event");
  assert.match(String(warnings().at(-1)!.message), /could not start the rebuild of cccccccc/);
});

test("a swap failure is reported and blocks like a compile failure", async () => {
  const f = fakeDeps({
    swap: () => {
      throw new Error("EACCES: dist is read-only");
    },
  });
  const { r, events } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.match(String(events.at(-1)!.message), /swapping the new build into place failed: EACCES/);
  assert.equal(r.status().restartBlocked, "swapping the new build into place failed");
});

// The tracked background promises are documented to never reject (mainIsGreen and compileStaged
// both catch internally), but a regression can still let one through, and the two tracked checks
// are treated differently: a REJECTED green check is a "could not run", not a red verdict — drop
// the pending head, warn once, retry on the next poll (BUGS.md 2026-09-16); a rejected compile
// is a failed step and blocks with its error text. These drive track()'s rejection handler,
// which the resolved-failure tests above cannot reach.

test("a thrown green check is a 'could not run': drop, warn once, retry — no latched red", async () => {
  let checks = 0;
  const f = fakeDeps({
    mainGreen: () => {
      checks++;
      return Promise.reject(new Error("baseline check blew up"));
    },
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  await settle(); // the rejection lands in the tracked slot
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "a thrown check ends the hold without a verdict");
  assert.deepEqual(events.map((e) => e.type), ["build_stale", "warning"]);
  assert.match(
    String(events.at(-1)!.message),
    /green check of bbbbbbbb could not run: baseline check blew up/,
  );
  assert.equal(r.status().restartBlocked, undefined, "no latched block");
  // The next poll re-checks the same head instead of waiting for main to move — a retry, not a latch.
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  assert.equal(checks, 2, "the green check re-ran");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none");
  assert.equal(warningEvents(events).length, 1, "one warning per episode");
});

test("a green check that fails once and then recovers still reaches the swap: the fleet self-heals", async () => {
  let checks = 0;
  const f = fakeDeps({
    mainGreen: () => {
      checks++;
      return checks === 1 ? Promise.reject(new Error("git broke mid-check")) : Promise.resolve(true);
    },
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "first check failed: dropped, not blocked");
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "retry starts");
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "recovered check is green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, IDLE, true), "restart");
  assert.equal(checks, 2);
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.deepEqual(f.calls.swap, [HEAD_B]);
  assert.deepEqual(events.map((e) => e.type), ["build_stale", "warning", "restart_pending", "restart"]);
});

test("a thrown compile is a rejection, not a verdict: its error text rides the warning, nothing is latched", async () => {
  // The production deps.compile wraps the mirror worktree checkout around compileStaged
  // (src/redeploy/redeploy.ts), so an environment failure there — a git lock, a full disk — surfaces as
  // a REJECTED promise, not the rejected flag a spawn failure inside tsc's own run produces.
  // Same class, different shape: it says nothing about the tree, so it must be retried, not
  // latched, or the fleet stays pinned on the stale build after the environment recovers
  // (BUGS.md 2026-09-28). The warning still carries compiled.error — the "compile threw"
  // fallback would hide what actually broke.
  const f = fakeDeps({
    mainGreen: async () => true,
    compile: () => Promise.reject(new Error("tsc exploded")),
  });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold");
  await settle(); // green resolves; the next poll starts the compile
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "compile runs in the background");
  await settle(); // the rejection lands in the tracked slot
  assert.equal(await r.poll(HEAD_B, IDLE, true), "none", "dropped, not blocked: nothing was verified about the tree");
  assert.deepEqual(events.map((e) => e.type), ["build_stale", "restart_pending", "warning"]);
  assert.match(String(events.at(-1)!.message), /rebuild of bbbbbbbb could not run: tsc exploded — retrying on the next poll/);
  assert.equal(r.status().restartBlocked, undefined, "no latch: repairing the environment must be enough");
  assert.equal(await r.poll(HEAD_B, IDLE, true), "hold", "the next poll re-attempts without main moving");
});
