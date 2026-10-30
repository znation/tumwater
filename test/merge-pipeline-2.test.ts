import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainMergeQueue, settleAbortedApproved } from "../src/merge/merge-drain.js";
import {
  abortableMerges,
  type InFlightMerge,
} from "../src/merge/merge-pipeline.js";
import { mergeStartHeld } from "../src/orchestrator/orchestrator-poll.js";
import { consumeAbortRequests } from "../src/operator/operator-requests.js";
import { queueDepth, queuedMergeFiles } from "../src/merge/merge-queue.js";
import { abortRequestPath, mergeRefName, mergeStatePath, statePath } from "../src/paths.js";
import { deleteRef, isMergedInto, refSha } from "../src/git/git.js";
import { readEvents } from "../src/events/event-read.js";
import { readMergeMarker } from "../src/merge/merge-slot.js";
import { defaultConfig } from "../src/config/config.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { writeJsonFile } from "../src/files/json-files.js";
import {
  APPROVE,
  allTasks,
  busyMergePipeline,
  busySlot,
  drained,
  makePipeline,
  pump,
  pumpUntil,
  queueChanges,
  rowReader,
  runnersFor,
} from "./fixtures/merge-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { waitFor, waitForFile } from "./helpers/wait.js";

/** Third slice of the merge-drain suite (see merge-pipeline.test.ts for the split): an abort
 * whose pin is already gone, a merge while an earlier entry still verifies, the reviewer hold,
 * the merge cell's stage, and the plumbing-throw recoveries. The review gate's pi runs are real
 * subprocesses behind the fake shim. */

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

test("abort --role settles an approved change whose pin is already gone without throwing", async () => {
  const root = makeRepo();
  const shas = await queueChanges(root, ["alpha", "beta"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]));
  pipeline.merge = busySlot(); // both changes verify and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => pipeline.approved.has("alpha") && pipeline.approved.has("beta"), "both changes to be approved", 30_000);

    // The pin vanishes before the abort lands: the race the catch exists for.
    await deleteRef(root, mergeRefName("alpha"));
    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));
    await settleAbortedApproved(root, pipeline); // must resolve: the missing ref is not an error

    assert.ok(!pipeline.approved.has("alpha"), "the aborted entry left the pipeline");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merge_failed" && e.source === "alpha").map((e) => e.result),
      ["aborted"],
      "the outcome was still written and reported",
    );
    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's queue entry dropped with its outcome; beta still waits, approved",
    );
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta, "beta's pin was untouched");
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("an aborted approved change settles despite an unwritable state file: no throw, entry dropped, pin discarded", async () => {
  const root = makeRepo();
  const shas = await queueChanges(root, ["alpha", "beta"]);
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]));
  pipeline.merge = busySlot(); // both changes verify and then wait for the merge slot
  const bg = pump(ctx, pipeline);
  try {
    await waitFor(() => pipeline.approved.has("alpha") && pipeline.approved.has("beta"), "both changes to be approved", 30_000);

    // The abort's outcome write hits an unwritable state file: the state path becomes a
    // non-empty directory, so writeJsonAtomic's rename fails (EISDIR) — the shape an ENOSPC or
    // an immutable state path takes. settleAbortedApproved runs in the poll body with nothing to
    // guard it, so a throw here would end the team, and the operator's abort must still drop
    // the change and its pin rather than leave it to be re-verified and merged next poll.
    const stateFile = statePath(root, "alpha");
    fs.rmSync(stateFile, { recursive: true, force: true });
    fs.mkdirSync(stateFile, { recursive: true });
    fs.writeFileSync(path.join(stateFile, "keep"), "");

    writeJsonFile(abortRequestPath(root, "alpha"), { at: Date.now() });
    consumeAbortRequests(root, [], abortableMerges(pipeline));
    await settleAbortedApproved(root, pipeline); // must resolve, not reject out of the poll

    assert.ok(!pipeline.approved.has("alpha"), "the aborted entry left the pipeline");
    assert.deepEqual(
      queuedMergeFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's queue entry dropped with its abort; beta still waits, approved",
    );
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "alpha's pin was discarded");
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta, "beta's pin was untouched");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && String(e.message).includes("could not save the role's state"),
      ),
      "the failed state write is warned about, not swallowed",
    );
  } finally {
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("an approved change merges while an earlier queue entry is still verifying", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-ahead-");
  // Part 3s/3: hold the head in flight through the deterministic gate, not the reviewer: the
  // check blocks alpha on its release file while beta's passes, so beta merges ahead of the held
  // queue head. The block keys off alpha.txt (present only in alpha's verification worktree), so
  // the gate's attribution re-check on main's tip — which holds it — neither blocks nor matches.
  const config = {
    ...defaultConfig(),
    check: {
      command:
        `if [ -f alpha.txt ]; then touch '${path.join(flags, "alpha-blocking")}'; ` +
        `i=0; while [ ! -f '${path.join(flags, "alpha-release")}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; fi`,
    },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 3, config });
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-blocking"));
    await waitFor(() => readEvents(root).some((e) => e.type === "merge_done" && e.source === "beta"), "beta to merge", 30_000);

    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta merged ahead of the queue head");
    assert.equal(await isMergedInto(root, shas.alpha!, "main"), false);
    assert.deepEqual([...pipeline.verifying.keys()], ["alpha"], "the head is still in review");
    assert.match(rowOf("alpha"), /^merging \d+s · checking \d+s$/, "the head's row shows its own verification");
    assert.equal(rowOf("beta"), "due", "beta's row is back to its own state");

    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await waitFor(drained(root, pipeline), "alpha to merge", 30_000);
    assert.deepEqual(
      eventsOfType(root, "merged").map((e) => e.source),
      ["beta", "alpha"],
      "each merged as soon as it was approved",
    );
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
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
// own mid-flight hold is covered above by "an approved change merges while an earlier queue entry
// is still verifying".

// The reviewer-hold (part 3i/3): a hold on the reviewer's provider parks only the post-merge
// review drain — its no-role verdict — never a role start, verify or landing. The production
// pollMergeDrain start gate and these tests drive one exported predicate (mergeStartHeld), so
// the wiring cannot drift.

test("mergeStartHeld holds only the no-role drain under a reviewer hold", () => {
  assert.equal(mergeStartHeld(true, true, "feature"), true, "a restart/disk hold holds a role");
  assert.equal(mergeStartHeld(false, true, "feature"), false, "no role start is held by the reviewer");
  assert.equal(mergeStartHeld(false, true, "dedupe"), false, "every role drains while the reviewer is held — no afterMerge exemption exists");
  assert.equal(mergeStartHeld(false, true, undefined), true, "the no-role verdict stays held (what drainPostReviews and mergeApproved read)");
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
    // Open gate, merge slot held busy: both changes verify and sit approved without merging.
    pipeline.merge = busySlot();
    await pumpUntil(
      ctx,
      pipeline,
      () => pipeline.approved.has("feature") && pipeline.approved.has("dedupe"),
      "both changes to be approved",
    );
    assert.equal(queueDepth(root), 2, "no merge has run yet");

    // Free the slot and close the reviewer hold with the production predicate: no role's merge
    // is held by the reviewer, so both approved entries drain.
    pipeline.merge = null;
    ctx.startHeld = (role?: string) => mergeStartHeld(false, true, role);
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the approved entries to merge while the reviewer is held");
    assert.equal(queueDepth(root), 0, "the approved entries merged despite the reviewer hold");
    // The two approved changes merge as one stack's combined commit, so the original pinned shas
    // are branch tips, not main ancestors — assert main holds each change's content instead.
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
    // Both fresh changes merge as one stack's combined commit, so assert main holds each
    // change's content rather than the pinned shas (branch tips, not ancestors).
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
// longer records any stage here. The stage sequence below is a single timeline: one permit, so the
// second verify parks (no record) until the first frees it, and a busy merge slot until both are
// done verifying.
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
    // build-check at once; the approve case's gate resolves on a passed check. The model reviewer
    // still approves a passed pre-check (until part 3h/3), but it records no stage, so the rec
    // holds only the pre-check's own build-check lines either way.
    const checkRecord = `echo "check:$(${stagesOf})" >> '${rec}'`;
    const config = {
      ...defaultConfig(),
      check: {
        command:
          headVerdict === "reject"
            ? `${checkRecord}; if [ -f alpha.txt ]; then printf '%s\n' "planted failure: alpha is red"; exit 1; fi`
            : checkRecord,
      },
    };
    const restore = fakePi(APPROVE());
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 1, config });
    pipeline.merge = busySlot();
    try {
      await pumpUntil(ctx, pipeline, () => pipeline.approved.has("beta"), "beta to be approved");
      pipeline.merge = null;
      await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      // The head's own verification: its pre-check, with beta parked and showing nothing. Then
      // beta's verify runs with the head's record already off the gate's stages (approved, or
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
        assert.deepEqual(seen, verifies, "a one-change merge goes through on its own: no stack check, no re-check on an unmoved main");
        assert.equal(loadRunnerState(root, "alpha").lastResult, "rejected");
      } else {
        assert.deepEqual(
          seen,
          [...verifies, "check:alpha=merging/build-check,beta=merging/build-check"],
          "the shared stack check runs under build-check on every stacked change",
        );
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
// mergeApproved's first assembly attempt propagates an unexpected throw (nothing has merged), and
// startMerge's catch is what keeps the team alive: every entry stays queued, unapproved, the
// head author's state records the error, and the next poll re-verifies from the surviving pins.

test("a plumbing throw in the merge keeps every entry queued and unapproved, records the error, and recovers on the next poll", async () => {
  const { root, mainBefore, restore, ctx, pipeline } = await busyMergePipeline();
  // The sabotage target, repaired in the finally even when an assert throws first.
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");

    // Break the merge's plumbing: the registered-worktrees home becomes a plain file, so the
    // stack's worktree setup (the verification ran in a different pooled slot) fails hard in git —
    // not a verdict, a throw, out of mergeApproved's first attempt.
    fs.rmSync(worktreesHome, { recursive: true, force: true });
    fs.writeFileSync(worktreesHome, "not a directory");

    pipeline.merge = null; // the busy slot frees
    await drainMergeQueue(ctx, pipeline);
    const merge = pipeline.merge as InFlightMerge | null;
    assert.ok(merge, "the merge started");
    await merge.promise; // resolves, never rejects — the drain caught the throw

    assert.equal(pipeline.merge, null, "the merge slot freed for the next attempt");
    assert.equal(queueDepth(root), 2, "every entry stays queued");
    assert.equal(pipeline.approved.size, 0, "nothing stays approved: each change is verified afresh from its pin");
    assert.ok(loadRunnerState(root, "alpha").lastError, "the head author's persisted state names the failure");
    assert.equal(readMergeMarker(root), null, "the merge's marker records were removed with its task");
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
  const { root, restore, ctx, pipeline } = await busyMergePipeline();
  const worktreesHome = path.join(root, ".git", "worktrees");
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.approved.size === 2, "both changes to be approved");

    // Break the merge's plumbing so mergeApproved throws, then break the head author's state
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
  // attribution re-check on main's tip — which holds no change file — stays green and the settle
  // records `rejected`, not `main_red`.
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
