import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { attributeRedCheck } from "../src/landing-core.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, loadLoopState, saveLoopState, type LoopState } from "../src/loop-state.js";
import { refSha, setRef } from "../src/git.js";
import { landingRefName } from "../src/paths.js";
import { readEvents } from "../src/events.js";
import { shortSha } from "../src/text.js";
import type { BuildCheck } from "../src/build-check-detect.js";
import type { BuildCheckOutcome } from "../src/build-check.js";
import { pathPrepend, writeScript } from "./fake-commands.js";
import { mainSha, makeRepo, tmpdir } from "./repo-fixtures.js";
import { baselineFixture } from "./loop-fixtures.js";

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

/** A fake `npm` whose exit decides main's baseline verdict for the duration of a test. */
function fakeNpm(script: string): () => void {
  const dir = tmpdir("fake-npm-");
  writeScript(path.join(dir, "npm"), script);
  return pathPrepend(dir);
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
