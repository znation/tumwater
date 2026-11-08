import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue } from "../src/merge/merge-drain.js";
import {
  abortableMerges,
  mergeTasks,
  type InFlightMerge,
} from "../src/merge/merge-pipeline.js";
import { mergeStartHeld } from "../src/orchestrator/orchestrator-poll.js";
import { consumeAbortRequests } from "../src/operator/operator-requests.js";
import { queueDepth, queuedMergeFiles } from "../src/merge/merge-queue.js";
import { abortRequestPath, mergeQueueDir, mergeRefName, mergeStatePath, statePath } from "../src/paths.js";
import { deleteRef, refSha } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { readMergeMarker } from "../src/merge/merge-slot.js";
import { defaultConfig } from "../src/config/config.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { writeJsonFile } from "../src/files/json-files.js";
import {
  APPROVE,
  allTasks,
  busySlot,
  drained,
  makePipeline,
  pump,
  pumpUntil,
  queueChanges,
  runnersFor,
} from "./fixtures/merge-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
/** Third slice of the merge-drain suite (see merge-pipeline.test.ts for the split): an abort
 * whose pin is already gone, an approved change waiting while a later entry still verifies, the
 * reviewer hold, the merge cell's stage, and the plumbing-throw recoveries. The review gate's
 * pi runs are real subprocesses behind the fake shim. */

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

// ── An abort whose pin is already gone ──────────────────────────────────────────────────
// discardPinnedRefs's documented edge: a pin that is already gone is not an error. The ref
// can vanish between the operator's abort and the settle — the gate itself deletes a pin at
// its rejection verdict (merge-core.ts), and an outside cleanup can drop tumwater refs — so the
// settle that discards an aborted approved change must tolerate a missing ref end to end:
// deleteRef's gitTry swallows the absent-ref failure, and the drain's own catch stands
// behind it for any other plumbing failure. No test pinned the settle against a vanished
// pin before this one.

test("abort --role settles an in-flight merge whose pinned ref is already gone without throwing", async () => {
  const root = makeRepo();
  // beta first, so the merge task merges beta and is then stopped short of alpha — the change
  // the abort settles.
  await queueChanges(root, ["beta", "alpha"]);
  const flags = tmpdir("abort-pin-gone-");
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-checked")}'; fi; ` +
        `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checked")}'; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["beta", "alpha"], undefined, config), { config });
  pipeline.merge = busySlot(); // both changes verify and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    // Both changes' checks done — the durable check-start signal (part 2/4), read instead of
    // the approved map: the slot then frees into one merge task holding both changes.
    await pumpUntil(
      ctx,
      pipeline,
      () =>
        fs.existsSync(path.join(flags, "beta-checked")) &&
        fs.existsSync(path.join(flags, "alpha-checked")),
      "both changes to be verified",
      30_000,
    );

    pipeline.merge = null; // the busy slot frees: the merge task starts, merging beta then alpha
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge task is in flight");

    // The abort lands while beta's merge is in flight, so alpha — the one change left in the
    // task — settles aborted at its next step. The pin vanishes before the task's finally,
    // exactly as the ref can vanish between the operator's abort and the settle: the discard
    // must tolerate a missing ref end to end (deleteRef's gitTry swallows the absent-ref
    // failure), or the aborted merge's settle would throw out of the task.
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));
    await deleteRef(root, mergeRefName("alpha"));

    const [settled] = await Promise.allSettled([merge.promise]);
    assert.equal(settled?.status, "fulfilled", "the settle resolves: the missing ref is not an error");
    assert.equal(pipeline.merge, null, "the merge slot freed");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_failed" && e.source === "alpha").map((e) => e.result),
      ["aborted"],
      "the stopped change's outcome was still written and reported",
    );
    assert.equal(loadRunnerState(root, "alpha").lastResult, "aborted", "the abort folded into the stopped change's state");
    assert.deepEqual(eventsOfType(root, "merged").map((e) => e.source), ["beta"], "the first queued change merged before the abort");
    assert.equal(queueDepth(root), 0, "both queue entries were dropped");
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "the aborted change's pin is gone");
    assert.equal(await refSha(root, mergeRefName("beta")), null, "the merged change's pin was consumed by its merge");
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("an aborted merge settles despite an unwritable state file: no throw, entry dropped, pin discarded", async () => {
  const root = makeRepo();
  // beta first, so the merge task merges beta and is then stopped short of alpha — the change
  // the abort settles, whose state file is unwritable.
  await queueChanges(root, ["beta", "alpha"]);
  const flags = tmpdir("abort-unwritable-");
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-checked")}'; fi; ` +
        `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checked")}'; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["beta", "alpha"], undefined, config), { config });
  pipeline.merge = busySlot(); // both changes verify and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    // Both changes approved and waiting for the merge slot — not merely checked: the slot
    // must free into ONE merge task holding both changes, so the abort lands on the merge
    // (while beta is mid-merge), alpha settles aborted through the merge task's settle, and
    // the merge task's finally discards its pin. Waiting on the check's flag files instead
    // was racy: the verifications finish their deterministic gate after the flag lands, so an
    // abort consumed in that window stopped alpha's own verification — whose settle threw on
    // the broken queue entry and (before the fix) skipped the pin discard, failing this very
    // assertion on the re-verified pin.
    await pumpUntil(
      ctx,
      pipeline,
      () => pipeline.approved.has("beta") && pipeline.approved.has("alpha"),
      "both changes to be approved and waiting for the merge slot",
      30_000,
    );

    pipeline.merge = null; // the busy slot frees: the merge task starts, merging beta then alpha
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge task is in flight");

    // The stopped change's outcome write hits an unwritable state file: the state path becomes
    // a non-empty directory, so writeJsonAtomic's rename fails (EISDIR) — the shape an ENOSPC
    // or an immutable state path takes. The queue file is broken the same way, so the settle's
    // dropMerge (fs.rmSync, not recursive) fails too. The task's settle runs behind
    // guardMergeTask, so a throw anywhere here must surface as a warning, never a rejection out
    // of the task, and the operator's abort must still drop the change and its pin rather than
    // leave it to be re-verified and merged next poll.
    const stateFile = statePath(root, "alpha");
    fs.rmSync(stateFile, { recursive: true, force: true });
    fs.mkdirSync(stateFile, { recursive: true });
    fs.writeFileSync(path.join(stateFile, "keep"), "");
    const queueFile = queuedMergeFiles(root).find((q) => q.entry.role === "alpha")!.file;
    fs.rmSync(queueFile);
    fs.mkdirSync(queueFile);

    // Flag the user abort synchronously before the merge task's first await resumes, so the
    // change the merge had not reached settles aborted.
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));

    const [settled] = await Promise.allSettled([merge.promise]);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.equal(pipeline.merge, null, "the merge slot freed despite the failed state write");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_failed" && e.source === "alpha").map((e) => e.result),
      ["aborted"],
      "the stopped change's outcome event was still written",
    );
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "the aborted change's pin was discarded");
    assert.equal(await refSha(root, mergeRefName("beta")), null, "the merged change's pin was consumed by its merge");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("could not save the role's state"),
      ),
      "the failed state write is warned about, not swallowed",
    );
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("merge task for beta, alpha"),
      ),
      "the settle-path failure is warned about through the task's guard, not thrown",
    );
  } finally {
    // The planted directory queue file would break the settled tasks' cleanup; restore a
    // usable queue directory before they run it.
    const dir = mergeQueueDir(root);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a user-aborted verification discards its pin even when its settle's queue drop fails", async () => {
  const root = makeRepo();
  await queueChanges(root, ["alpha"]);
  const flags = tmpdir("abort-verify-unwritable-");
  // The check starts by signaling its marker and then holding the verification in flight, so
  // the abort lands on the verification (never reaching the merge): its settle then hits the
  // planted directory queue file and throws. A user abort mid-check settles the verification
  // "aborted" (review-precheck's aborted skip), and the settle must still discard the pin — or
  // the stopped change's pin survives to be re-verified and merged next poll, against the
  // operator's abort. The merge task's finally and settleAbortedApproved discard outside the
  // throwing settle; this test pins the verification path to the same rule.
  const config = {
    ...defaultConfig(),
    check: { command: `touch '${path.join(flags, "alpha-checking")}'; sleep 1` },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha"], undefined, config), { config });
  const bg = pump(ctx, pipeline);
  try {
    await pumpUntil(
      ctx,
      pipeline,
      () => fs.existsSync(path.join(flags, "alpha-checking")),
      "the verification's check to start",
      30_000,
    );
    // The settle's drop fails: the queue file becomes a non-empty directory, so dropMerge's
    // fs.rmSync (not recursive) throws EISDIR — the shape an ENOSPC or immutable queue file
    // takes on disk.
    const queueFile = queuedMergeFiles(root).find((q) => q.entry.role === "alpha")!.file;
    fs.rmSync(queueFile);
    fs.mkdirSync(queueFile);
    // Flag the user abort while the verification is mid-check.
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));

    await pumpUntil(
      ctx,
      pipeline,
      () => mergeTasks(pipeline).length === 0,
      "the aborted verification to settle",
      30_000,
    );
    assert.equal(
      await refSha(root, mergeRefName("alpha")),
      null,
      "the aborted verification's pin was discarded despite the failed settle drop",
    );
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("merge task for alpha"),
      ),
      "the settle-path failure is warned about through the task's guard, not thrown",
    );
  } finally {
    // The planted directory queue file would break the settled task's cleanup; restore a
    // usable queue directory before it runs.
    const dir = mergeQueueDir(root);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

// Part 3s/3 retires the two reviewer-held shutdown/abort cases the earlier revision held in
// `reviewing` through the fake reviewer (a shutdown reaching every verification and keeping its
// pins, and `abort --role` stopping one verify while another runs on): the deterministic gate
// can hold a verification only through its single check.command, and that check's process group
// is killed only by its own timeout — never by a shutdown or a deliberate `abort --role` — so no
// gate-hold can suspend a verification across an abort and settle it "aborted". Those abort and
// shutdown-of-a-verification subjects live on in the end-to-end twin (part 3v/3's
// test/orchestrator-3.e2e.test.ts) and the leftover-recovery twin (part 3u/3); the gate check's
// own mid-flight hold is covered in merge-pipeline.test.ts by "one head is gated at a time".

// The reviewer-hold (part 3i/3): a hold on the reviewer's provider parks only the post-merge
// review drain — its no-role verdict — never a role start, verify or landing. The production
// pollMergeDrain start gate and these tests drive one exported predicate (mergeStartHeld), so
// the wiring cannot drift.

test("mergeStartHeld holds only the no-role drain under a reviewer hold", () => {
  assert.equal(mergeStartHeld(true, true, "feature"), true, "a restart/disk hold holds a role");
  assert.equal(mergeStartHeld(false, true, "feature"), false, "no role start is held by the reviewer");
  assert.equal(mergeStartHeld(false, true, "dedupe"), false, "every role drains while the reviewer is held — no exemption exists");
  assert.equal(mergeStartHeld(false, true, undefined), true, "the no-role verdict stays held (what drainPostReviews and mergeApprovedChange read)");
  assert.equal(mergeStartHeld(true, false, "dedupe"), true, "a restart/disk hold still holds every role");
});

test("approved entries merge while the reviewer's provider is held", async () => {
  const root = makeRepo();
  const roles = ["feature", "dedupe"];
  await queueChanges(root, roles);
  const config = defaultConfig();
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  try {
    // Open gate, merge slot held busy. The wait is on the queue, not the approved map (part
    // 2/4) — both queued means the slot can free, and the merged events are the durable
    // signal that both landed once it frees.
    pipeline.merge = busySlot();
    await pumpUntil(ctx, pipeline, () => queueDepth(root) === 2, "both changes to be queued");
    assert.equal(queueDepth(root), 2, "no merge has run yet");

    // Free the slot and close the reviewer hold with the production predicate: no role's merge
    // is held by the reviewer, so both approved entries drain.
    pipeline.merge = null;
    ctx.startHeld = (role?: string) => mergeStartHeld(false, true, role);
    await pumpUntil(
      ctx,
      pipeline,
      () => eventsOfType(root, "merged").length === 2 && drained(root, pipeline)(),
      "both changes to merge while the reviewer is held",
    );
    assert.equal(queueDepth(root), 0, "the approved entries merged despite the reviewer hold");
    // Each change merges as its own commit (rebased onto main's tip), so the original pinned shas
    // are rewritten and are not main ancestors — assert main holds each change's content instead.
    assert.equal(sh(root, "git", "show", "main:feature.txt").trim(), "work by feature", "the approved feature change merged while the reviewer's provider was held");
    assert.equal(sh(root, "git", "show", "main:dedupe.txt").trim(), "work by dedupe", "the dedupe change merged too");
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a fresh entry verifies and merges while the reviewer's provider is held — no role is parked", async () => {
  const root = makeRepo();
  const roles = ["feature", "dedupe"];
  await queueChanges(root, roles);
  const config = defaultConfig();
  const held = (role?: string) => mergeStartHeld(false, true, role);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config, held });
  try {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "both fresh entries to verify and merge while the reviewer is held", 30_000);
    assert.equal(queueDepth(root), 0, "the reviewer hold parks no role — both entries drained");
    assert.equal(ctx.startHeld(), true, "the no-role startHeld (what drainPostReviews reads) is true under the reviewer hold");
    // Both fresh changes merge as their own commits (each rebased onto main's tip), so assert
    // main holds each change's content rather than the pinned shas (rewritten, not ancestors).
    assert.equal(sh(root, "git", "show", "main:feature.txt").trim(), "work by feature", "the fresh feature entry merged despite the reviewer hold");
    assert.equal(sh(root, "git", "show", "main:dedupe.txt").trim(), "work by dedupe", "the fresh dedupe entry merged too — every role drains while the reviewer is held");
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});


// The merge cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23) through the pipeline: each
// change's own record carries its stage, so a change's stage must leave the gate stage the moment
// its gate returns — otherwise its finished gate's last turns sit in the cell, accruing a false
// `no pi output` flag, for as long as it waits for its merge — and one change's verify must
// advance only its own record. Part 3s/3 re-points the observation to the deterministic gate (the
// pre-check): a change leaves `build-check` the moment its gate returns — a failed pre-check drops
// its record outright, a passed one advances it to approved/merging — and the model reviewer no
// longer records any stage here. The stage sequence below is a single timeline: the drain
// serializes verifications, so the second does not start (no record) until the first verification
// task ends, and a busy merge slot until both are done verifying.
for (const headVerdict of ["reject", "approve"] as const) {
  test(`a head ${headVerdict === "reject" ? "rejected" : "approved"} in its verification leaves build-check when its gate returns; the stack check names itself`, async () => {
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    await queueChanges(root, roles);
    const rec = path.join(tmpdir(), "stages");
    // Every record as `role=status/stage`, read from the live marker by whichever run records it.
    const script = path.join(tmpdir(), "stages.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";\n` +
        `let m = {};\ntry { m = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch {}\n` +
        `process.stdout.write((m.changes ?? []).map((c) => c.role + "=" + c.status + "/" + (c.stage ?? "-")).join(","));\n`,
    );
    const stagesOf = `'${process.execPath}' '${script}' '${mergeStatePath(root)}'`;
    // The check command is the deterministic gate's only stage observer, and the head's verdict:
    // the reject case fails the declared check on alpha's tree, so its gate resolves on the
    // pre-check (a deterministic rejection never shows as reviewing) and alpha's record leaves
    // build-check at once; the approve case's gate resolves on a passed check. The gate's
    // approval records no stage (the pre-merge reviewer that once would have is gone, part
    // 3h/3), so the rec holds only the pre-check's own build-check lines either way.
    const checkRecord = `echo "check:$(${stagesOf})" >> '${rec}'`;
    // Beta's own check-start flag — the durable signal (part 3e/6) the slot-free wait uses; it
    // touches only on beta's verification tree (beta.txt present), never on main's tip.
    const flags = tmpdir("head-verdict-");
    const betaFlag = `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checking")}'; fi`;
    const config = {
      ...defaultConfig(),
      check: {
        command:
          headVerdict === "reject"
            ? `${checkRecord}; ${betaFlag}; if [ -f alpha.txt ]; then printf '%s\n' "planted failure: alpha is red"; exit 1; fi`
            : `${checkRecord}; ${betaFlag}`,
      },
    };
    const restore = fakePi(APPROVE());
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 1, config });
    pipeline.merge = busySlot();
    try {
      await pumpUntil(ctx, pipeline, () => fs.existsSync(path.join(flags, "beta-checking")), "beta to be gated", 30_000);
      pipeline.merge = null;
      await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      // The head's own verification: its pre-check, with beta still queued and showing nothing.
      // Then beta's verify runs with the head's record already off the gate's stages (approved, or
      // gone with its rejection) — beta's transitions advance only beta's own record.
      const alphaAfter = headVerdict === "reject" ? "" : "alpha=approved/merging,";
      // The reject case's failing check runs three times before its deterministic rejection: the
      // gate's first run, its one flake re-run, and main's tip check (the attribution runs main's
      // own check, recorded while alpha is still in build-check). Every line is alpha's
      // build-check stage — its record leaves it only when the gate returns and rejects it.
      const alphaChecks =
        headVerdict === "reject"
          ? ["check:alpha=merging/build-check", "check:alpha=merging/build-check", "check:alpha=merging/build-check"]
          : ["check:alpha=merging/build-check"];
      const verifies = [...alphaChecks, `check:${alphaAfter}beta=merging/build-check`];
      if (headVerdict === "reject") {
        assert.deepEqual(seen, verifies, "a rejected verification leaves build-check; nothing merges");
        assert.equal(loadRunnerState(root, "alpha").lastResult, "rejected");
      } else {
        // Both verifies pass their gate; with the batch path gone (part 4m/3) each approved
        // change then merges one at a time through mergeApprovedChange — no shared stack check
        // runs, so no further build-check stage line is recorded.
        assert.deepEqual(seen, verifies, "each approved change merges one at a time: no shared stack check");
        assert.equal(loadRunnerState(root, "alpha").lastResult, "changed");
      }
      assert.equal(loadRunnerState(root, "beta").lastResult, "changed");
      assert.equal(readMergeMarker(root), null, "the marker is gone once the merge is done");
    } finally {
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  });
}

// ── A plumbing throw in the merge slot ────────────────────────────────────────────────────
// mergeApprovedChange's first merge attempt propagates an unexpected throw (nothing has merged),
// and startMerge's catch is what keeps the team alive: every entry stays queued, unapproved, the
// head author's state records the error, and the next poll re-verifies from the surviving pins.

test("a plumbing throw in the merge keeps every entry queued and unapproved, records the error, and recovers on the next poll", async () => {
  const root = makeRepo();
  const mainBefore = mainSha(root);
  await queueChanges(root, ["alpha", "beta"]);
  const flags = tmpdir("plumbing-throw-");
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-checked")}'; fi; ` +
        `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checked")}'; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"], undefined, config), { config });
  pipeline.merge = busySlot();
  // The sabotage target, repaired in the finally even when an assert throws first.
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    // Both checks done — the durable check-start signal (part 2/4): the slot frees into one
    // merge task holding both changes, and the broken plumbing throws the head's merge.
    await pumpUntil(
      ctx,
      pipeline,
      () =>
        fs.existsSync(path.join(flags, "alpha-checked")) &&
        fs.existsSync(path.join(flags, "beta-checked")),
      "both changes to be verified",
      30_000,
    );

    // Break the merge's plumbing: the registered-worktrees home becomes a plain file, so the
    // the merge's worktree setup (the verification ran in a different pooled slot) fails hard in
    // git — not a verdict, a throw, out of mergeApprovedChange's first attempt.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    fs.writeFileSync(worktreesHome, "not a directory");

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");
    await merge.promise; // resolves, never rejects — the drain caught the throw

    assert.equal(pipeline.merge, null, "the merge slot freed for the next attempt");
    assert.equal(queueDepth(root), 2, "every entry stays queued");
    assert.equal(readMergeMarker(root), null, "the marker is gone — no approved marker remains: each change is verified afresh from its pin next poll");
    assert.ok(loadRunnerState(root, "alpha").lastError, "the head author's persisted state names the failure");
    assert.equal(eventsOfType(root, "merged").length, 0, "nothing was reported merged");
    assert.equal(mainSha(root), mainBefore, "nothing merged");

    // Repair the plumbing and let the next poll re-verify from the surviving pins: the queue
    // still drains, which is the recovery the catch exists to preserve. Git may have
    // recreated the directory during the failed attempt, so remove whatever stands there.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain after the repair");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes merged after the retry");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, mergeRefName(role)), null, `${role}'s ref was deleted once merged`);
    }
  } finally {
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a failing state write in the merge's error path still frees the merge slot and warns", async () => {
  const root = makeRepo();
  await queueChanges(root, ["alpha", "beta"]);
  const flags = tmpdir("merge-error-state-");
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-checked")}'; fi; ` +
        `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checked")}'; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"], undefined, config), { config });
  pipeline.merge = busySlot();
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(
      ctx,
      pipeline,
      () =>
        fs.existsSync(path.join(flags, "alpha-checked")) &&
        fs.existsSync(path.join(flags, "beta-checked")),
      "both changes to be verified",
      30_000,
    );

    // Break the merge's plumbing so mergeApprovedChange throws, then break the head author's state
    // file so the catch's saveRunnerState throws too — the exact unwritable-state failure the
    // guard exists for. The catch must not let that second throw skip the settle loop and the
    // finally, or p.merge stays set forever and every later merge is wedged.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    fs.writeFileSync(worktreesHome, "not a directory");
    const stateFile = statePath(root, "alpha");
    fs.rmSync(stateFile, { recursive: true, force: true });
    fs.mkdirSync(stateFile, { recursive: true });
    fs.writeFileSync(path.join(stateFile, "keep"), "");

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");
    const [settled] = await Promise.allSettled([merge.promise]);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.equal(pipeline.merge, null, "the merge slot freed despite the failed state write");
    assert.equal(queueDepth(root), 2, "every entry stays queued and unapproved");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes('the merge error for alpha could not be saved'),
      ),
      "the failed state write is warned about, not swallowed",
    );
  } finally {
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a throw settling an aborted merge still frees the merge slot", async () => {
  // The settle loops run inside the merge task's try whose finally is the only place the slot
  // is freed (p.merge = null) and shutdown is detached. The second loop settles every role a
  // user abort left unmerged — settleOne → settleMergeOutcome → dropMerge — and dropMerge
  // rethrows a non-ENOENT fs error (removeQueueFile). A throw there must not skip the finally,
  // or p.merge stays set forever and every later merge on the team is wedged behind it.
  const root = makeRepo();
  await queueChanges(root, ["alpha", "beta"]);
  const flags = tmpdir("abort-settle-throw-");
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-checked")}'; fi; ` +
        `if [ -f beta.txt ]; then touch '${path.join(flags, "beta-checked")}'; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"], undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(
      ctx,
      pipeline,
      () =>
        fs.existsSync(path.join(flags, "alpha-checked")) &&
        fs.existsSync(path.join(flags, "beta-checked")),
      "both changes to be verified",
      30_000,
    );

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");

    // Plant the settle path's fault, then flag the user abort, both synchronously before the
    // merge task's first await resumes: every queue file becomes a directory, so the second
    // loop's dropMerge (fs.rmSync without recursive) throws EISDIR the moment it settles an
    // unmerged role — the shape an ENOSPC or immutable queue file takes on disk.
    for (const { file } of queuedMergeFiles(root)) {
      fs.rmSync(file);
      fs.mkdirSync(file);
    }
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));

    const [settled] = await Promise.allSettled([merge.promise]);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.equal(pipeline.merge, null, "the merge slot freed despite the settle-path throw");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("merge task"),
      ),
      "the settle-path failure is warned about, not swallowed",
    );
  } finally {
    // Restore a usable queue directory so the settled tasks' cleanup does not fight the plant.
    const dir = mergeQueueDir(root);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a git failure inside the gate's reject path settles the verification as an error outcome, naming the failure in the author's state", async () => {
  const root = makeRepo();
  const role = "improve";
  const shas = await queueChanges(root, [role]);
  // A stale index.lock in the worktree's gitdir — the wreckage of a crashed concurrent git —
  // planted by the declared check itself (the deterministic gate), so it exists by the time the
  // gate's reject path resets the worktree (after the check's failure, before the pin delete).
  // resetWorktreeToMain's
  // `git reset --hard` throws, the throw rides out of the gate and verifyRequest, and the drain
  // must turn it into the terminal "error" outcome — never a rejected task promise, which
  // would leave the entry queued and its author interlocked forever.
  const config = {
    ...defaultConfig(),
    check: { command: `if [ -f improve.txt ]; then gd=$(sed 's/^gitdir: //' "$PWD/.git"); touch "$gd/index.lock"; printf '%s\n' "planted failure: the change is red"; exit 1; fi` },
  };
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role], undefined, config), { cap: 1, config });
  await withPi(APPROVE(), async () => {
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the failed verification to settle", 30_000);
  });
  await Promise.allSettled(allTasks(pipeline));

  const state = loadRunnerState(root, role);
  assert.equal(state.lastResult, "error", "the outcome folded into the author's state as an error");
  assert.match(state.lastError ?? "", /index\.lock/, "the persisted state names the git failure that threw");
  const failed = readEvents(root).filter((e) => e.type === "merge_failed" && e.source === role);
  assert.equal(failed.length, 1, "one merge_failed event, logged once by the settle");
  assert.equal(failed[0]!.result, "error");
  assert.equal(failed[0]!.commit, shas[role], "the event names the commit whose verification failed");
  assert.equal(
    await refSha(root, mergeRefName(role)),
    shas[role],
    "the pin survives the error outcome (only a rejection deletes it) for the next re-merge",
  );
});

test("an unwritable state file on a settling merge warns instead of rejecting the task promise", async () => {
  const root = makeRepo();
  const role = "improve";
  await queueChanges(root, [role]);
  const stateFile = statePath(root, role);
  fs.mkdirSync(stateFile, { recursive: true });
  fs.writeFileSync(path.join(stateFile, "keep"), "");
  // Break the author's state write: the state file becomes a non-empty directory, so
  // writeJsonAtomic's rename fails (EISDIR) — the shape an ENOSPC or an immutable state path
  // takes. The outcome write happens in the verification's fire-and-forget task, which nothing
  // awaits during normal operation, so a throw there must be warned about, never left as an
  // unhandled rejection that takes the orchestrator down.
  // Part 3s/3: the rejection comes from the deterministic gate (a failing declared check), not a
  // reviewer verdict, so the settle still writes the rejected outcome into the unwritable state.
  // The check fails only on the change's own tree (where improve.txt exists), so the gate's
  // attribution re-check on main's tip — which holds no change file — stays green and the
  // settle records `rejected`.
  const config = { ...defaultConfig(), check: { command: `if [ -f improve.txt ]; then printf '%s\n' "planted failure: the change is red"; exit 1; fi` } };
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, [role], undefined, config), { cap: 1, config });
  const restore = fakePi(APPROVE());
  try {
    await drainMergeQueue(ctx, pipeline);
    const pending = allTasks(pipeline);
    assert.equal(pending.length, 1, "the rejected verification started");
    const [settled] = await Promise.allSettled(pending);
    assert.equal(settled?.status, "fulfilled", "the task promise settles rather than rejecting");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("could not save the role's state"),
      ),
      "the state-write failure is warned about, not swallowed",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});
