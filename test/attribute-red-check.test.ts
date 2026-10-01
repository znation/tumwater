import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { attributeRedCheck } from "../src/landing-core.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, loadLoopState, saveLoopState, type LoopState } from "../src/loop-state.js";
import { refSha, setRef } from "../src/git.js";
import { landingRefName } from "../src/paths.js";
import { readEvents } from "../src/event-read.js";
import { shortSha } from "../src/text.js";
import type { BuildCheck } from "../src/build-check-detect.js";
import type { BuildCheckOutcome, BuildCheckRun } from "../src/build-check.js";
import { mainSha, makeRepo, tmpdir } from "./repo-fixtures.js";
import { baselineFixture, fakeNpm } from "./loop-fixtures.js";

// Unit coverage for attributeRedCheck (src/landing-core.ts): the gate's final attribution
// step, shared by a batch bisect's last move and a single landing's in-lock check at the
// failure limit. The red change's verdict is not the test's subject — main's OWN verdict at
// its current tip is (the land-queue 1/3 rule): main green → the change broke the check and
// is rejected deterministically; main red → the failure is main's, the change is recoverable;
// no verdict → reject, the safe default, with the why in the reasons. The check run itself is
// exercised in build-check.test.ts and main-red.test.ts; here the fake npm decides the
// baseline verdict so all three attributions are reachable.

const ROLE = "alpha";
const CHANGE_REASON = "test failed: expected 2 to be 3";

/** A red check over one change's tree, as a landing's in-lock check reports it. */
function red(): { check: BuildCheck; outcome: BuildCheckOutcome } {
  return {
    check: { kind: "npm", rootDir: process.cwd(), script: "test" },
    outcome: { status: "failed", script: "test", outputTail: [CHANGE_REASON] },
  };
}

/** A role state carrying strike-count history, so the test can watch what attribution does
 * to it (the reset on a rejection, the leave-alone on a main_red). */
function seededState(root: string): LoopState {
  const s = freshLoopState(ROLE);
  s.unreviewFailures = 3;
  saveLoopState(root, s);
  return s;
}

function reviewRejectedEvents(root: string): { loop: string; head: string; reasons: string[] }[] {
  return readEvents(root)
    .filter((e) => e.type === "review_rejected")
    .map((e) => {
      const r = e as { loop: string; head?: string; reasons?: string[] };
      return { loop: r.loop, head: r.head ?? "", reasons: r.reasons ?? [] };
    });
}

test("attributeRedCheck rejects deterministically when main's own tip is green", async () => {
  // The manifest's script text is unique per test, so each repo's main sha — the baseline
  // verdict cache's key — is unique in-process too.
  const { root } = baselineFixture(ROLE, "attr-green-marker");
  const restore = fakeNpm("echo ok; exit 0");
  try {
    const head = mainSha(root);
    await setRef(root, landingRefName(ROLE), head);
    const state = seededState(root);
    const result = await attributeRedCheck(
      { root, mainBranch: "main", config: defaultConfig() },
      ROLE,
      head,
      "landing check",
      red(),
      state,
    );
    assert.equal(result, "rejected", "main green means the change broke the check");
    assert.equal(state.unreviewFailures, 0, "the strike count reset with the rejection");
    assert.equal(state.lastReview?.verdict, "reject");
    assert.deepEqual(state.lastReview?.reasons, [
      `build check failed (\`npm run test\`): ${CHANGE_REASON}`,
    ]);
    assert.equal(state.lastReview?.head, head);
    assert.equal(await refSha(root, landingRefName(ROLE)), null, "the pin was deleted");
    assert.deepEqual(reviewRejectedEvents(root), [
      { loop: ROLE, head, reasons: [`build check failed (\`npm run test\`): ${CHANGE_REASON}`] },
    ]);
    const saved = loadLoopState(root, ROLE);
    assert.equal(saved.unreviewFailures, 0, "the reset was persisted");
    assert.equal(saved.lastReview?.verdict, "reject", "the review was persisted");
  } finally {
    restore();
  }
});

test("attributeRedCheck returns main_red and keeps the change recoverable when main itself is red", async () => {
  const { root } = baselineFixture(ROLE, "attr-red-marker");
  const restore = fakeNpm("echo baseline-failure; exit 1");
  try {
    const head = mainSha(root);
    await setRef(root, landingRefName(ROLE), head);
    const state = seededState(root);
    const result = await attributeRedCheck(
      { root, mainBranch: "main", config: defaultConfig() },
      ROLE,
      head,
      "landing check",
      red(),
      state,
    );
    assert.equal(result, "main_red", "the failure is main's, not the change's");
    assert.equal(
      state.lastError,
      `landing check failed: main ${shortSha(head)} is red — not this change's failure`,
    );
    assert.equal(state.lastReview, undefined, "no rejection was recorded against the author");
    assert.equal(state.unreviewFailures, 3, "the strike count was left untouched");
    assert.equal(
      await refSha(root, landingRefName(ROLE)),
      head,
      "the pin was kept so recovery can re-land once main is green",
    );
    assert.deepEqual(reviewRejectedEvents(root), [], "no rejection event for main's own red");
    const saved = loadLoopState(root, ROLE);
    assert.equal(saved.lastError, state.lastError, "the attribution was persisted");
  } finally {
    restore();
  }
});

test("attributeRedCheck rejects with the unavailable why when main's baseline cannot be had", async () => {
  // A repo declaring no build check: mainTipVerdict reads `unavailable` ("it declares no
  // check"), and the safe default still rejects — but says so in the reasons.
  const root = makeRepo(path.join(tmpdir("attr-red-none-"), "project"));
  const head = mainSha(root);
  await setRef(root, landingRefName(ROLE), head);
  const state = seededState(root);
  const result = await attributeRedCheck(
    { root, mainBranch: "main", config: defaultConfig() },
    ROLE,
    head,
    "batch check",
    red(),
    state,
  );
  assert.equal(result, "rejected", "no verdict still rejects — the safe default");
  assert.deepEqual(state.lastReview?.reasons, [
    `build check failed (\`npm run test\`): ${CHANGE_REASON}`,
    "main's own baseline was unavailable (it declares no check), so the red batch check is attributed to this change",
  ]);
  assert.equal(state.unreviewFailures, 0, "the strike count reset with the rejection");
  assert.equal(await refSha(root, landingRefName(ROLE)), null, "the pin was deleted");
  const saved = loadLoopState(root, ROLE);
  assert.equal(saved.lastReview?.verdict, "reject", "the rejection was persisted");
});

// BUGS.md 2026-09-30: an unverified red — a run that spanned a host sleep past the tolerance,
// the tree never judged — is not the change's failure and not a strike. Attribution asks
// main's verdict only when the check produced one; here the ref stays for recovery's re-land
// and the recorded reason names the sleep instead of a test failure. Both spellings of
// "unverified" count: runScopedBuildCheck's explicit flag at the merge scopes, and a run
// carrying its own sleep evidence (the gate-shaped outcome).
test("attributeRedCheck keeps the ref and records no strike for an unverified red", async () => {
  const { root } = baselineFixture(ROLE, "attr-unverified-marker");
  const restore = fakeNpm("echo ok; exit 0");
  try {
    const head = mainSha(root);
    await setRef(root, landingRefName(ROLE), head);
    const state = seededState(root);
    const flag: { check: BuildCheck; outcome: BuildCheckOutcome } = {
      check: { kind: "npm", rootDir: process.cwd(), script: "test" },
      outcome: {
        status: "failed",
        script: "test",
        outputTail: ["batch build check ran while the host slept 119s mid-run; the tree is unverified"],
        unverified: true,
      },
    };
    const result = await attributeRedCheck(
      { root, mainBranch: "main", config: defaultConfig() },
      ROLE,
      head,
      "batch check",
      flag,
      state,
    );
    assert.equal(result, "merge_blocked", "the pin stays for the next attempt, as for any retriable landing");
    assert.equal(state.unreviewFailures, 3, "no strike: nothing judged this diff");
    assert.equal(await refSha(root, landingRefName(ROLE)), head, "the ref was not deleted");
    assert.match(state.lastError ?? "", /host slept 119s mid-run/, "the sleep is what the state records");
    assert.equal(reviewRejectedEvents(root).length, 0, "no rejection was logged");

    // The other spelling: a plain failed outcome whose run carries the sleep evidence (the
    // gate-scope shape, no flag) is unverified too.
    const state2 = seededState(root);
    const measured: { check: BuildCheck; outcome: BuildCheckOutcome } = {
      check: { kind: "npm", rootDir: process.cwd(), script: "test" },
      outcome: {
        status: "failed",
        script: "test",
        outputTail: ["landing build check ran while the host slept 59s mid-run; the tree is unverified"],
        run: { sleptMs: 59_000 } as BuildCheckRun,
      },
    };
    const result2 = await attributeRedCheck(
      { root, mainBranch: "main", config: defaultConfig() },
      ROLE,
      head,
      "landing check",
      measured,
      state2,
    );
    assert.equal(result2, "merge_blocked");
    assert.equal(state2.unreviewFailures, 3, "no strike here either");
    assert.equal(await refSha(root, landingRefName(ROLE)), head, "the ref still was not deleted");
  } finally {
    restore();
  }
});
