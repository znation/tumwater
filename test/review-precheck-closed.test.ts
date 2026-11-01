/** The review gate's build pre-check when it makes no verdict about the tree, so the gate fails
 * closed: an abort mid-check stops the check and fails as aborted; a shutdown during a failing
 * pre-check fails before main is consulted; a pre-check whose every attempt spans a host sleep
 * is unverified, not the change's failure, and the warning names the sleep. Each keeps the
 * commit for a re-merge and writes no rejection. Split from review-precheck.test.ts (a red
 * main); the other sibling slices are review-precheck-verdict.test.ts (the gate deciding
 * alone), review-precheck-green.test.ts (a green main or none) and
 * review-precheck-watch.test.ts (the attribution when the main watch verifies main). The shared
 * scaffolding lives in fixtures/gate-fixtures.ts and fixtures/precheck-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review/review.js";
import { aheadOfMain, headOf } from "../src/git/git.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { gateCtx, reviewGate, ROLE } from "./fixtures/gate-fixtures.js";
import { buildCheckEvents, gateBuildFixture, uniqueMain } from "./fixtures/precheck-fixtures.js";
import { scriptedSampler, woke } from "./helpers/sleep-clock.js";
import { waitForFile } from "./helpers/wait.js";
import { quarantinedTests } from "../src/review/known-flakes.js";

test("an abort mid-check stops the gate's build pre-check and fails closed as aborted", async () => {
  // A declared check that parks on its own tree (main's baseline passes at once — the fixture's
  // worktree script is what matters) and then sleeps, so an abort fired after the marker appears
  // really interrupts a long-running check instead of one about to finish. The abort is the
  // verify's controller signal (a user abort or a shutdown both fire it), which the gate now
  // hands to its check; `reviewPinnedChange` settles the verify `aborted` on this result.
  const parked = path.join(tmpdir(), `precheck-parked-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const { root, wt } = await gateBuildFixture(`touch '${parked}'; sleep 30`);
  try {
    const controller = new AbortController();
    const gate = (async () => {
      const { state, result } = await reviewGate(root, wt, { signal: controller.signal });
      return { state, result };
    })();
    await waitForFile(parked, 30_000);
    controller.abort();
    const started = Date.now();
    const { state, result } = await gate;
    assert.ok(Date.now() - started < 20_000, "returned well under the 30 s sleep");
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted, "the harness's stop fails closed as aborted");
    assert.deepEqual(buildCheckEvents(root), ["gate:skipped"], "one build_check attempt, no retry, no baseline");
    assert.deepEqual(quarantinedTests(root), [], "the aborted check quarantines nothing");
    assert.equal(
      warningMessages(root).some((w) => w.includes("gate check failed then passed on retry")),
      false,
      "no flaky-warning on an abort",
    );
    assert.equal(await aheadOfMain(wt, "main"), 1, "the commit is kept for another attempt");
    assert.equal(state.lastReview, undefined, "no review bookkeeping on an abort");
  } finally {
    fs.rmSync(parked, { force: true });
  }
});

test("a shutdown during a failing pre-check fails closed before main is consulted, keeping the commit", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  uniqueMain(root);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const { state, result } = await reviewGate(root, wt, { signal: controller.signal });
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted);
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed"], "main's check never ran");
    assert.equal(await aheadOfMain(wt, "main"), 1); // the work commit stays; re-merged next run
    assert.equal(state.lastReview, undefined); // no bookkeeping on abort
  });
});

// BUGS.md 2026-09-30: a pre-check whose every attempt spanned a host sleep made no verdict
// about the tree. The gate attributes nothing — no main consultation, no strike, no
// rejection — the commit stays for a re-merge, and the warning names the sleep.
test("a pre-check that sleeps and fails on every attempt keeps the commit and reports the sleep", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const state = freshRunnerState(ROLE);
  state.unreviewFailures = 1; // an earlier reviewer strike stays exactly as it was
  const head = await headOf(wt, "HEAD");
  // runScopedBuildCheck retries a slept failure internally, so two attempts, four samples —
  // each attempt opens awake and closes after a 119 s sleep.
  // runScopedBuildCheck retries a slept failure internally, and the gate's own flake re-run
  // then runs the same scoped check again — four attempts, eight samples, each opening awake
  // and closing after a 119 s sleep.
  const sampler = scriptedSampler([
    woke(1_000), woke(121_000, 2_000),
    woke(121_000), woke(241_000, 122_000),
    woke(241_000), woke(361_000, 242_000),
    woke(361_000), woke(481_000, 362_000),
  ]);
  const result = await reviewAheadOfMain({ ...gateCtx(root, wt), sampleSleep: sampler }, state);
  assert.equal(result.decision, "failed");
  assert.equal(result.unverified, true, "the failure is unverified, not the change's");
  assert.equal(result.mainRed, undefined, "main was never consulted — the check made no verdict");
  assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
  assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
  assert.equal(state.lastReview, undefined, "no rejection recorded against the author");
  assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-merge");
  assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:failed", "gate:failed"], "each attempt is priced");
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("gate check ran while the host slept 119s mid-run; the tree is unverified")),
    `the warning names the sleep; got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(!warnings.some((m) => m.includes("flaky")), "a sleep is never mislabeled a flaky test");
  assert.ok(!warnings.some((m) => m.startsWith("check failed")), "no test-failure headline");
});
