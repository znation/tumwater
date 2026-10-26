import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BATCH_RESTACK_ATTEMPTS } from "../src/merge/merge-stack.js";
import { refSha } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { mainSha, sh } from "./fixtures/repo-fixtures.js";
import { withApprovePi } from "./fakes/fake-pi.js";
import { waitForFile } from "./helpers/wait.js";
import {
  makeCtx,
  request,
  verifyAndMerge,
  checkRunNumber,
  declareCheck,
  batchFixture,
  runBatch,
  countingCheck,
  commitOnMain,
  parkUntil,
  batchChecks,
} from "./fixtures/merger-fixtures.js";

// The re-stack slice of the merge tests (see merger.test.ts for the split and what each
// file holds): mergeApproved's merge over N approved changes — stacked into one worktree, one
// shared build check, one fast-forward — when main moves under it. The reviewer runs are real pi
// subprocesses behind the fake shim; the fallback's conflict resolver is the wiring's stub.

// ── A fast-forward lost to a moved main: re-stack, not merge_blocked (BUGS.md 2026-09-23) ──
// Main moves while the batch's shared check runs — the window is the whole check, and a human
// commit still writes main outside the merge queue. The stack was
// assembled on the old tip, so its single ff fails; the batch must re-stack on the new tip
// and go round again rather than send every approved change back through recovery.

test("a batch whose base main moves mid-check through a run-path merge re-stacks and merges", async () => {
  // The Repro exactly: a slow batch check, and while it runs another writer merges on main (here
  // a third role's own verify and merge). The ff loses, the batch re-stacks on the new tip,
  // re-checks it (the racer is code, not docs), and merges both changes on top of the racer.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"]);
  const mainBefore = mainSha(root);
  const started = path.join(root, ".batch-started");
  const release = path.join(root, ".batch-release");
  countingCheck(root, `if [ "$n" = "3" ]; then ${parkUntil(started, release)}; fi`);
  try {
    await withApprovePi(async () => {
      const batch = runBatch(root, shas, ["alpha", "beta"], wiringFor);
      // `.batch-started` appears only after the two verifies' gate pre-checks and a real `git
      // commit` on main (commitOnMain) — real git work a saturated full-suite run can stretch
      // past the 30 s default, so wait on the suite norm; the poll returns the instant the file
      // appears, so a generous deadline costs nothing on the happy path (BUGS.md 2026-10-26).
      await waitForFile(started, 60_000); // the batch's shared check is running on the old tip
      const { ctx } = makeCtx(root, freshRunnerState("gamma"));
      assert.equal(await verifyAndMerge(ctx, request(shas.gamma!, { role: "gamma" })), "changed", "the racer merged");
      fs.writeFileSync(release, "");

      const results = await batch;

      assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "re-stacked, not merge_blocked");
      assert.deepEqual(
        sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
        ["work by beta", "work by alpha", "work by gamma"],
        "the stack merged on top of the racer, in queue order",
      );
      const merged = eventsOfType(root, "merged");
      assert.deepEqual(merged.map((e) => e.source), ["gamma", "alpha", "beta"]);
      assert.equal(merged[2]!.commit, mainSha(root), "the re-stacked tip is main's head");
      assert.deepEqual(
        batchChecks(root).map((e) => e.status),
        ["passed", "passed"],
        "the first check, then one re-check of the re-stacked tree",
      );
      assert.equal(await refSha(root, mergeRefName("alpha")), null, "merged: the head's ref is gone");
      assert.equal(await refSha(root, mergeRefName("beta")), null, "and the stacked change's");
    });
  } finally {
    fs.writeFileSync(release, ""); // never leave the parked check waiting out its bound
  }
});

test("a fast-forward lost to a doc-only commit re-stacks without a second batch check", async () => {
  // The exempt case: the tree the re-stack builds is the checked tree plus doc-only bytes —
  // the gate's own exemption test says that cannot break the build, so no second check runs.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const mainBefore = mainSha(root);
  countingCheck(root, `if [ "$n" = "3" ]; then ${commitOnMain(root, "NOTES.md", "a doc edit")}; fi`);
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by beta", "work by alpha", "concurrent NOTES.md"],
    );
    assert.equal(batchChecks(root).length, 1, "the doc-only re-stack reused the first check's verdict");
    assert.equal(eventsOfType(root, "merged").length, 2);
  });
});

test("a batch that loses the fast-forward race on every attempt keeps every ref as merge_blocked", async () => {
  // Main moves (with code) during EVERY batch check — the first and each re-stack's re-check.
  // Past BATCH_RESTACK_ATTEMPTS the batch gives up to leftover recovery: every approved change
  // keeps its ref and nothing merges.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const mainBefore = mainSha(root);
  countingCheck(root, `if [ "$n" -ge 3 ]; then ${commitOnMain(root, "race.txt", "main moved")}; fi`);
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["merge_blocked", "merge_blocked"]);
    assert.equal(batchChecks(root).length, 1 + BATCH_RESTACK_ATTEMPTS, "the first check plus one per re-stack");
    assert.equal(
      sh(root, "git", "rev-list", "--count", `${mainBefore}..main`),
      String(1 + BATCH_RESTACK_ATTEMPTS),
      "only the concurrent commits are new on main",
    );
    assert.equal(await refSha(root, mergeRefName("alpha")), shas.alpha!, "the head keeps its ref");
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta!, "and the stacked change keeps its");
    assert.equal(eventsOfType(root, "merged").length, 0, "nothing merged");
  });
});

test("a re-stack that conflicts with what main gained falls back to one-at-a-time", async () => {
  // Main gains a beta.txt of its own mid-check: the re-stack's pick of beta's change conflicts,
  // so the batch abandons to the per-change path exactly as a first-assembly conflict does —
  // alpha merges singly, beta resolves through the single path's conflict resolver.
  const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
    resolve: (wt) => fs.writeFileSync(path.join(wt, "beta.txt"), "both\n"),
  });
  countingCheck(root, `if [ "$n" = "3" ]; then ${commitOnMain(root, "beta.txt", "main beta")}; fi`);
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "both merged one at a time");
    assert.equal(batchChecks(root).length, 1, "the conflicting re-stack never reached a second batch check");
    assert.equal(calls.length, 1, "one resolution run, for the conflicting change");
    assert.equal(sh(root, "git", "show", "main:beta.txt"), "both", "the resolution merged on main");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"));
    assert.equal(await refSha(root, mergeRefName("beta")), null, "the fallback deleted its ref");
  });
});

test("an abort between re-stack attempts stops the batch: aborted, refs kept, nothing merges", async () => {
  // A shutdown that arrives while the first batch check runs must not start a re-stack (and
  // its possible second full check) after the lost race.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const started = path.join(root, ".batch-started");
  const release = path.join(root, ".batch-release");
  countingCheck(
    root,
    `if [ "$n" = "3" ]; then ${commitOnMain(root, "race.txt", "main moved")}; ${parkUntil(started, release)}; fi`,
  );
  try {
    await withApprovePi(async () => {
      const controller = new AbortController();
      const batch = runBatch(root, shas, ["alpha", "beta"], wiringFor, controller);
      // Same load-sensitive wait on the shared check's `.batch-started` (see the comment above):
      // a saturated run can take past 30 s to reach the batch check's touch, so use the suite norm.
      await waitForFile(started, 60_000);
      const mainMid = mainSha(root);
      controller.abort();
      fs.writeFileSync(release, "");

      const results = await batch;

      assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"]);
      assert.equal(batchChecks(root).length, 1, "no re-stack check after the abort");
      assert.equal(mainSha(root), mainMid, "nothing merged after the racer");
      assert.equal(await refSha(root, mergeRefName("alpha")), shas.alpha!, "an abort keeps the refs for recovery");
      assert.equal(await refSha(root, mergeRefName("beta")), shas.beta!);
    });
  } finally {
    fs.writeFileSync(release, "");
  }
});

test("a one-change merge merges on its own: one ff, one merged event", async () => {
  await withApprovePi(async () => {
    const { root, shas, wiringFor } = await batchFixture(["alpha"]);

    const results = await runBatch(root, shas, ["alpha"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed"]);
    assert.equal(mainSha(root), shas.alpha!, "merged through mergeApprovedChange: the pin itself on an unmoved main");
    assert.equal(eventsOfType(root, "merged").length, 1);
  });
});

test("a red stack check that does not reproduce bisects: both changes merge, neither rejected", async () => {
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  // The check fails on its THIRD run only: the two gate pre-checks pass, the batch's one
  // shared check fails, and every bisect step's check passes again — a flake. One red run
  // never rejects a change: beta's own prefix is checked, not inferred red.
  const count = path.join(root, ".checkcount");
  declareCheck(
    root,
    `#!/bin/sh\n${checkRunNumber(count)}[ "$n" = "3" ] && { echo "planted batch failure"; exit 1; }\necho ok\n`,
  );
  await withApprovePi(async () => {

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "each prefix merges on its own green check");
    const checks = eventsOfType(root, "build_check");
    assert.deepEqual(
      checks.map((e) => [e.scope, e.status]),
      [
        ["gate", "passed"],
        ["gate", "passed"],
        ["batch", "failed"],
        ["batch", "passed"],
        ["batch", "passed"],
      ],
      "two gate pre-checks, the red stack check, then alpha's prefix and beta on top of it",
    );
    assert.equal(eventsOfType(root, "review_rejected").length, 0, "nobody rejected");
    assert.equal(eventsOfType(root, "merged").length, 2);
  });
});

test("a batch whose files are dirty in the primary checkout is blocked before its check", async () => {
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  const mainBefore = mainSha(root);
  fs.writeFileSync(path.join(root, "alpha.txt"), "dirty\n");
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["merge_blocked", "merge_blocked"]);
    assert.equal(batchChecks(root).length, 0);
    const warnings = warningMessages(root);
    assert.deepEqual(
      warnings.filter((w) => w.startsWith("merge blocked:")),
      ["merge blocked: the merge would overwrite files in the primary checkout (untracked: alpha.txt) — commit, stash or remove them there"],
    );
    assert.ok(!warnings.some((w) => w.includes("fast-forward failed")));
    assert.equal(mainSha(root), mainBefore);
  });
});
