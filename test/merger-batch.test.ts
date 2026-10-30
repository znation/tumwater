import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewPinnedChange } from "../src/merge/merge-core.js";
import { refSha, setRef } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { headSha, mainSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { withApprovePi, withPi } from "./fakes/fake-pi.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  reviewerPi,
  request,
  declareCheck,
  batchFixture,
  runBatch,
  perRoleReviewerPi,
  runBatchRecorded,
  afterMergeConfig,
  checkRunNumber,
} from "./fixtures/merger-fixtures.js";

// The batch slice of the merge tests (see merger.test.ts for the split and what each file
// holds): mergeApproved's batch basics, its aborts, and the per-change status hook.

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

// ── The merge: mergeApproved (merge queue 5/5, land-queue speed 2c) ─────────────────────────
// The merge over N roles' approved merges: stacked into one worktree, one shared build check,
// one fast-forward. The reviewer runs (each change's verify) are real pi subprocesses behind the
// fake shim; the fallback merges' conflict resolver goes through the wiring's runPi stub.

test("an all-rejected batch returns a defined result for every request without throwing", async () => {
  // The review re-audit found this exact shape crashing: |S| == 0 made the merger index the
  // empty stack and throw, and the drain's catch kept every entry — a queue leak. Now the
  // batch simply returns: every request terminal, nothing to merge, refs gone.
  // Both changes leak a secret, so the deterministic gate's diff rule rejects each
  // before any reviewer runs (part 3p/3; the gate's scope is the three unrepairable rules).
  const SECRET = "batch-rejected-secret-888888888888";
  process.env.TUMWATER_TEST_SECRET = SECRET;
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
      edit: (d) => fs.appendFileSync(path.join(d, "change.txt"), `${SECRET}\n`),
    });
    const mainBefore = mainSha(root);

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["rejected", "rejected"], "every request has a terminal result");
    assert.equal(mainSha(root), mainBefore, "nothing merged");
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "a rejection deletes its ref");
    assert.equal(await refSha(root, mergeRefName("beta")), null, "and the next request's too — the batch merges nothing");
  } finally {
    delete process.env.TUMWATER_TEST_SECRET;
  }
});

test("a green batch stacks every approved change, fast-forwards main once, and logs per-change events", async () => {
  const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"]);
  // No pre-merge reviewer verdict: each change's approval is the gate's deterministic green
  // build pre-check, and every merged commit is reviewed after landing (part 3d/3).
  declareCheck(root, "#!/bin/sh\necho ok\n");
  const mainBefore = mainSha(root);

  const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, undefined, afterMergeConfig());

  assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
  assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes merged on main");
  const merged = eventsOfType(root, "merged");
  assert.equal(merged.length, 2, "one merged event per change, in queue order");
  assert.equal(merged[0]!.commit, sh(root, "git", "rev-parse", "main~1"), "the head is the first new commit on main");
  assert.notEqual(merged[0]!.commit, shas.alpha!, "the head re-committed onto the fresh main base");
  assert.equal(merged[1]!.commit, mainSha(root), "the stacked tip is main's head");
  assert.notEqual(merged[1]!.commit, shas.beta!, "the second change re-committed on top of the first");
  assert.equal(await refSha(root, mergeRefName("alpha")), null, "the ff deleted the head's ref");
  assert.equal(await refSha(root, mergeRefName("beta")), null, "and the stacked one's");
  assert.equal(states.alpha.lastApprovedHead, shas.alpha!, "the verdict persisted per role");
  assert.equal(states.beta.lastApprovedHead, shas.beta!);
});

test("the batch fixture's pins are backdated so a same-second pick cannot reproduce a pin's sha (regression)", async () => {
  // The green-batch test's "the head re-committed" assertion broke when a pin and its
  // same-wall-clock-second cherry-pick — identical tree, parent, identity, message and
  // timezone — got the SAME sha from git. The fix backdates every pin's committer time so a
  // "now" pick can never fall in the pin's second. This pins THAT fix: if the fixture ever
  // stops backdating pins, this fails (the pin lands at "now").
  const { root, shas } = await batchFixture(["alpha"]);
  const pinCommitterEpoch = Number(sh(root, "git", "show", "-s", "--format=%ct", shas.alpha!));
  const aYearAgo = Math.floor(Date.now() / 1000) - 31536000;
  assert.ok(
    pinCommitterEpoch < aYearAgo,
    `a pin must be backdated well before now so a same-second pick cannot reproduce it (got committer epoch ${pinCommitterEpoch})`,
  );
});

test("a batch stacks every commit of a multi-commit pin, not its head alone", async () => {
  // The regression this pins: picking a pin's single head would merge only its last diff and
  // orphan the work beneath it — the stack must pick the whole range from main to that head.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  declareCheck(root, "#!/bin/sh\necho ok\n");
  const config = afterMergeConfig();
  sh(root, "git", "checkout", "--detach", shas.alpha!);
  fs.writeFileSync(path.join(root, "more.txt"), "more by alpha\n");
  sh(root, "git", "add", "more.txt");
  sh(root, "git", "commit", "-m", "more alpha work");
  shas.alpha = headSha(root);
  await setRef(root, mergeRefName("alpha"), shas.alpha);
  sh(root, "git", "checkout", "main");
  const mainBefore = mainSha(root);
  const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, undefined, config);
  assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
  // THREE commits on main: both of alpha's, then beta's — none orphaned.
  assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "3");
  assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "the work beneath the head merged");
  assert.ok(sh(root, "git", "show", "main:more.txt").includes("more by alpha"));
  assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
  assert.equal(await refSha(root, mergeRefName("alpha")), null);
  assert.equal(await refSha(root, mergeRefName("beta")), null);
});

test("an abort mid-batch routes every request without a terminal outcome to aborted, refs kept", async () => {
  await withPi(`exec sleep 30`, async () => { // never reached: the signal is already aborted
    const roles = ["alpha", "beta", "gamma"];
    const { root, shas, wiringFor, folded } = await batchFixture(roles);
    const mainBefore = mainSha(root);
    const controller = new AbortController();
    controller.abort(); // a shutdown (or a user stop for any batched role) before the batch starts

    const results = await runBatch(root, shas, roles, wiringFor, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted", "aborted"]);
    for (const role of roles) {
      assert.equal(await refSha(root, mergeRefName(role)), shas[role]!, `an abort keeps ${role}'s ref for recovery`);
    }
    assert.equal(mainSha(root), mainBefore, "nothing merged");
    // Every verify sees the stop before its gate starts: no reviewer spend on any of them.
    assert.equal(folded.size, 0, "no reviewer ran");
  });
});

// BUGS.md 2026-09-23 — a stopping batch ends at its next step boundary, not only where a pi
// run notices the abort: the restart hand-off aborts a merge that outlived its deadline, and
// steps that spawn no pi (an approved-head short-circuit, the stack's assembly and shared
// check) must not carry on regardless.

test("an aborted batch merges nothing even when every gate would short-circuit on an approved head", async () => {
  await withPi(`exec sleep 30`, async () => { // never reached: no gate starts
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
    // Both heads already approved (a re-drained batch): every gate would short-circuit with
    // no pi run, so only the between-steps check can see the abort.
    states.alpha.lastApprovedHead = shas.alpha!;
    states.beta.lastApprovedHead = shas.beta!;
    const mainBefore = mainSha(root);
    const controller = new AbortController();
    controller.abort();

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"]);
    assert.equal(mainSha(root), mainBefore, "nothing merged");
    assert.equal(await refSha(root, mergeRefName("alpha")), shas.alpha!, "the refs survive for recovery");
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta!);
    assert.equal(folded.size, 0, "no gate ran a pi");
  });
});

test("an abort during a gate build check settles the batch aborted with nothing merged and no shared check", async () => {
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const dir = tmpdir("gate-abort-");
  const announce = path.join(dir, "announce");
  const release = path.join(dir, "release");
  const checkCount = path.join(root, ".checkcount");
  // The check runs from the repo root (the npm walk-up's package root), one run per gate in
  // queue order: run 1 is alpha's verify gate, run 2 beta's. Alpha's passes green; beta's parks
  // in flight until the abort kills it, so the batch is stopped at a step boundary that spawns
  // no pi (BUGS.md 2026-09-23), before the shared check would assemble.
  declareCheck(
    root,
    `#!/bin/sh\n` +
      checkRunNumber(checkCount) +
      `if [ "$n" -eq 2 ]; then touch '${announce}'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; fi\n` +
      `echo ok\n`,
  );
  const config = afterMergeConfig();
  const mainBefore = mainSha(root);
  const controller = new AbortController();
  // Fire the abort the moment beta's gate build check is in flight — the merge is stopped at a
  // step boundary that spawns no pi (BUGS.md 2026-09-23), before the shared check would assemble.
  const watcher = setInterval(() => {
    if (fs.existsSync(announce)) {
      controller.abort();
      clearInterval(watcher);
    }
  }, 5);
  watcher.unref();
  const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, controller, config);
  clearInterval(watcher);

  assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"], "both changes read aborted");
  assert.equal(mainSha(root), mainBefore, "nothing merged");
  assert.equal(await refSha(root, mergeRefName("alpha")), shas.alpha!, "the refs survive for recovery");
  assert.equal(await refSha(root, mergeRefName("beta")), shas.beta!);
  const checks = eventsOfType(root, "build_check");
  assert.equal(checks.filter((e) => e.scope === "gate").length, 2, "both gates ran their pre-check");
  assert.equal(checks.filter((e) => e.scope === "batch").length, 0, "the shared check never started");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an abort during a one-change merge's gate build check stops it before it merges", async () => {
  // The one-change (and fallback) merges go through mergeApprovedChange, which runs no gate
  // of its own. A stop that arrives after the verify is observed by the verify's parked gate
  // build check (bug 2026-09-23), which settles the change `aborted` before anything merges.
  const { root, shas, wiringFor } = await batchFixture(["alpha"]);
  const dir = tmpdir("one-gate-abort-");
  const announce = path.join(dir, "announce");
  const release = path.join(dir, "release");
  const checkCount = path.join(root, ".checkcount");
  // The sole gate check (run 1) parks in flight until the abort kills it — the stop a reviewer
  // run used to observe, now observed by the verify's gate build check (BUGS.md 2026-09-23).
  declareCheck(
    root,
    `#!/bin/sh\n${checkRunNumber(checkCount)}if [ "$n" -eq 1 ]; then touch '${announce}'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; fi\necho ok\n`,
  );
  const mainBefore = mainSha(root);
  const controller = new AbortController();
  const watcher = setInterval(() => {
    if (fs.existsSync(announce)) {
      controller.abort();
      clearInterval(watcher);
    }
  }, 5);
  watcher.unref();
  const results = await runBatch(root, shas, ["alpha"], wiringFor, controller);
  clearInterval(watcher);

  assert.deepEqual(results.map((r) => r.result), ["aborted"]);
  assert.equal(mainSha(root), mainBefore, "nothing merged");
  assert.equal(await refSha(root, mergeRefName("alpha")), shas.alpha!, "the ref survives for recovery");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The per-change status hook (BUGS.md 2026-09-23): the drain mirrors these reports into the
// 4/5 marker so each batched role's row reads its own change's state — the batch must report
// every step, or a finished change keeps a live `merging` row (or an in-flight one shows none).

test("a merge reports each change as it reaches it: the stack merges together, and a rejected change never reaches it", async () => {
  // beta's change leaks a secret, so the deterministic gate's diff rule rejects it
  // before any reviewer runs; alpha and gamma approve through the deterministic check (part 3p/3).
  await withPi(perRoleReviewerPi({}), async () => {
    const SECRET = "merge-reject-secret-123456789012";
    process.env.TUMWATER_TEST_SECRET = SECRET;
    try {
      const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"], {
        edit: (d, role) =>
          fs.appendFileSync(path.join(d, `${role}.txt`), role === "beta" ? `${SECRET}\n` : `work by ${role}\n`),
      });
      declareCheck(root, "#!/bin/sh\necho ok\n");
      const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta", "gamma"], wiringFor);
      assert.deepEqual(results, ["changed", "rejected", "changed"]);
      assert.deepEqual(seen, [
        "alpha:merging", // the stack's shared check + ff: every stacked change merges together
        "gamma:merging",
        "alpha:done", // merged: the merge is done with them
        "gamma:done",
      ]);
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  });
});

test("an abandoned stack reports one change merging at a time, the rest back to awaiting their turn", async () => {
  await withApprovePi(async () => {
    // Both roles rewrite the same line: the stack's cherry-pick conflicts and the merge
    // abandons to one-at-a-time.
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
      resolve: (wt) => fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"),
    });
    const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta"], wiringFor);
    assert.deepEqual(results, ["changed", "changed"]);
    assert.deepEqual(seen, [
      "alpha:merging", // the stack attempt
      "beta:merging",
      "alpha:approved", // abandoned: back to awaiting their turn…
      "beta:approved",
      "alpha:merging", // …and each merges alone, then is done
      "alpha:done",
      "beta:merging",
      "beta:done",
    ]);
  });
});

test("the gate re-pins the merge ref to the head its verdict judged", async () => {
  // reviewPinnedChange's last act: track the pin to the head the verdict judged, so a merge
  // that cannot finish leaves recovery re-merging that tree, not a stale pin. When the
  // merger worktree sits past the queued sha (work moved after queueing), the worktree's HEAD
  // is the judged tree — the ref must follow it, or a later blocked merge re-merges the wrong
  // tree.
  await withPi(
    reviewerPi("VERDICT: approve"), // the verify's approve; the passing declared check is the deterministic gate
    async () => {
      const { root, sha, wt } = await pinnedFixture();
      // A passing declared check is the deterministic approval (part 3p/3): the gate judges the
      // worktree's head, and reviewPinnedChange re-pins the ref to that judged head.
      declareCheck(root, "#!/bin/sh\necho ok\n");
      fs.appendFileSync(path.join(wt, "extra.txt"), "work after queueing\n");
      sh(wt, "git", "add", "-A");
      sh(wt, "git", "commit", "-m", "later work");
      const judged = headSha(wt);
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      const outcome = await reviewPinnedChange(ctx, request(sha), wt, state, ctx.foldUsage);

      assert.equal(outcome.kind, "gate");
      if (outcome.kind !== "gate") return;
      assert.equal(outcome.sha, judged, "the outcome names the judged head, not the queued sha");
      assert.equal(await refSha(root, REF), judged, "the pin moved to the judged head");
    },
  );
});
