import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isKnownFlake, MERGE_FLAKY_WARNING_PREFIX, quarantinedTests } from "../src/review/known-flakes.js";
import { MERGE_CHECK_FAILURE_LIMIT } from "../src/merge/merge-check-failures.js";
import { mergeApprovedChange, reviewPinnedChange } from "../src/merge/merge-core.js";
import { aheadOfMain, refSha, setRef } from "../src/git/git.js";
import { readSlotsState } from "../src/git/slots-state.js";
import { mergeRefName, mergeWorktreePath, rejectedRefName, statePath } from "../src/paths.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { assertClean, headSha, mainSha, pinOffMain, sh, tmpdir, makeRepo } from "./fixtures/repo-fixtures.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { piRanMarker, withApprovePi, withPi } from "./fakes/fake-pi.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  reviewerPi,
  request,
  verifyAndMerge,
  declareCheck,
  batchFixture,
  runBatch,
  advanceMain,
  perRoleReviewerPi,
  runBatchRecorded,
  afterMergeConfig,
  checkRunNumber,
} from "./fixtures/merger-fixtures.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

// Unit coverage for the two halves of a merge — merge-batch.ts's verifyRequest (checkout in
// _land-<role>, rebase onto main, merge-core.ts's review gate) and mergeApproved (the merge: one
// change through mergeApprovedChange, or a stack with one check, one fast-forward, the re-stack,
// 3d's prefix bisect and the one-at-a-time fallback) — driven here in queue order exactly as the
// merge pipeline runs them (merge-drain.ts). The reviewer run is a real pi subprocess behind
// the fake shim; merge-to-main.ts's conflict resolver goes through the wiring's runPi, which is
// stubbed.
//
// Split in three so node --test runs them in parallel processes: this file holds the verify and
// single-change merges, the batch basics, aborts and the per-change status hook;
// merger-restack.test.ts the re-stack on a moved main; merger-bisect.test.ts the red-stack bisect
// and the one-at-a-time fallback. Shared fixtures live in test/fixtures/merger-fixtures.ts. Keep
// the three roughly equal in measured duration when moving tests between them.

test("an approved merge merges on main and deletes the ref", async () => {
  // The merge's bookkeeping rides the deterministic gate, not the pre-merge reviewer: a passing
  // declared check is the approval that survives part 3h/3's removal of the model reviewer, so
  // no assertion here pins the reviewer's verdict or usage fold (part 3p/3).
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha, wt } = await pinnedFixture();
      declareCheck(root, "#!/bin/sh\necho ok\n");
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      assert.equal(mainSha(root), sha, "the pinned commit is main's head");
      assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0, "never red, no flake");
      assert.equal(await refSha(root, REF), null, "the pin was deleted on merge");
      assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree stayed clean at main");
    },
  );
});

test("the gate's verdict is durable on disk before the run's end save", async () => {
  // Regression (2026-09-14): state was written to disk only at run boundaries, so a
  // sudden death after the gate's verdict (power loss, kill -9) left the last
  // run-boundary snapshot on disk — a stale verdict for work already superseded —
  // and every later run acted on it. The verdict must be durable before the run's tail
  // (the merge plus the still-to-come authoring run) can die unsaved. Part 3p/3 asserts the
  // durable approval record (the approved head), not the reviewer's verdict, so the case
  // survives part 3h/3's removal of the pre-merge reviewer; the deterministic gate approval
  // is a passing declared check.
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      declareCheck(root, "#!/bin/sh\necho ok\n");
      const state = freshRunnerState(ROLE);
      // What disk holds at run start: a stale approval for a superseded head. The verify must
      // overwrite it with the current approval before the run's tail can die unsaved.
      state.lastApprovedHead = "0".repeat(40);
      saveRunnerState(root, state);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      // Read back from disk, not the in-memory object: without an immediate persist the file
      // still holds the seeded stale approval and the new verdict would be lost to the crash.
      const onDisk = readJson(statePath(root, ROLE)) as RunnerState;
      assert.equal(onDisk.lastApprovedHead, sha, "the approval is durable on disk, not just in memory");
    },
  );
});

test("a rejected merge merges nothing: role worktree clean at main, ref deleted, reasons recorded", async () => {
  // Re-pointed (part 3p/3): the rejection is deterministic — the change rewrites the brief block,
  // which briefEditReason rejects before any check or reviewer runs (part 3h/3 will remove the
  // reviewer). A brief-block edit is one of the three findings part 3m/3 keeps in the gate's
  // narrowed scope, so unlike a conflict marker this trigger survives that narrowing. The
  // bookkeeping is unchanged; the recorded reason is the diff rule's own finding, asserted only
  // to be present, not pinned to its wording.
  const root = makeRepo();
  const prompt = (body: string) =>
    `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
  // main carries a README.md with a brief block, which the change then rewrites.
  fs.writeFileSync(path.join(root, "README.md"), prompt("original"));
  sh(root, "git", "add", "README.md");
  sh(root, "git", "commit", "-q", "-m", "seed the brief");
  const mainBefore = mainSha(root);
  // The change is one commit on main's tip that adds the code work and rewrites the brief,
  // pinned by the merge ref so main stays at the seed commit (a fresh single-commit pin makes
  // the verify's rebase a no-op, so the gate judges the brief edit directly).
  sh(root, "git", "checkout", "-q", mainBefore);
  fs.writeFileSync(path.join(root, "seed.txt"), "the work\n");
  fs.writeFileSync(path.join(root, "README.md"), prompt("rewritten"));
  sh(root, "git", "add", "seed.txt", "README.md");
  sh(root, "git", "commit", "-q", "-m", "the work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "-q", "main");
  await setRef(root, REF, sha);
  const wt = await ensureWorktree(root, ROLE, "main");
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);

  assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");

  assert.equal(mainSha(root), mainBefore, "nothing merged on main");
  assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree is clean at main");
  assertClean(wt, "no stray edits in the role worktree");
  assert.equal(await refSha(root, REF), null, "a rejection is terminal: the pin goes too");
  assert.equal(state.lastReview?.verdict, "reject", "the deterministic gate's rejection is recorded");
  assert.ok(state.lastReview?.reasons?.length, "the diff rule's reason is recorded");
});

test("an abort before the gate returns aborted and keeps the ref", async () => {
  // Re-pointed (part 3z/3): the abort is observed before the gate ever starts, so it is fully
  // deterministic — no fake pi run is needed and none will survive part 3h/3's removal of the
  // pre-merge reviewer. The abort bookkeeping (nothing merged, pin kept for the next run's
  // recovery) is unchanged.
  const { root, sha } = await pinnedFixture();
  const state = freshRunnerState(ROLE);
  const mainBefore = mainSha(root);
  const { ctx, controller } = makeCtx(root, state);
  controller.abort(); // a shutdown that arrives before the merge's gate starts

  assert.equal(await verifyAndMerge(ctx, request(sha)), "aborted");

  assert.equal(mainSha(root), mainBefore, "nothing merged on main");
  assert.equal(await refSha(root, REF), sha, "an aborted merge keeps its pin for recovery");
});

test("a conflicting merge gets one resolution run and then merges", async () => {
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      // A passing declared check is the deterministic approval that survives part 3h/3's
      // removal of the pre-merge reviewer (part 3p/3); the resolution flow is unchanged.
      declareCheck(root, "#!/bin/sh\necho ok\n");
      // Advance main with a conflicting edit after the pin — the common concurrent case.
      advanceMain(root, "seed.txt", "main\n");

      const state = freshRunnerState(ROLE);
      const { ctx, calls } = makeCtx(root, state, (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "combined\n"); // resolve the markers
      });

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "combined\n");
      assert.equal(calls.length, 1, "exactly one resolution attempt per merge");
      assert.match(calls[0]!.session, /tumwater-improve-7-conflict/, "named after the role and run");
      assert.equal(await refSha(root, REF), null, "the pin was deleted on merge");
      // The rebase rewrote the pinned commit onto main's advance: linear history, no merge commits.
      assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
    },
  );
});

// The re-review gate over a diverging resolution (merge-core.ts's recheckResolved) has one
// non-approval outcome these cases reach deterministically: a REJECT (the verdict is final —
// the pin is deleted, nothing merges). Re-pointed (part 4a/3): the rejection is now the
// deterministic gate's — the resolution rewrites the brief block, which briefEditReason rejects
// before any reviewer run — so the cases drive no model reviewer and survive the reviewer's
// removal in part 3h/3 (a brief-block edit is one of the three findings the part 3m/3
// narrowing keeps in the gate's scope). The reviewer's no-parseable-verdict retry path dies
// with the reviewer and is retired.

test("a resolution the re-review rejects deletes the pin and merges nothing", async () => {
  // Re-pointed (part 4a/3): the re-review now rejects on a deterministic diff-rule finding —
  // the resolution rewrites the brief block, which briefEditReason rejects before any reviewer
  // run (part 3h/3 removes the reviewer). A brief-block edit is one of the three findings the
  // part 3m/3 narrowing keeps in the gate's scope, so the trigger survives it. The re-review
  // bookkeeping is unchanged: the pin is deleted, review_rejected is logged, the resolved
  // change owes one revision and its rejected ref keeps the head the re-review judged.
  await withPi(
    reviewerPi("VERDICT: approve"), // the verify's approve; the re-review rejects on the diff rule
    async () => {
      const root = makeRepo();
      const prompt = (body: string) =>
        `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
      // main carries a seed commit with a brief block and the file the pin will conflict on, so
      // the pin's own diff (seed.txt only) leaves the brief untouched and the verify approves.
      fs.writeFileSync(path.join(root, "README.md"), prompt("original"));
      fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
      sh(root, "git", "add", "README.md", "seed.txt");
      sh(root, "git", "commit", "-q", "-m", "seed the brief and seed");
      const sha = pinOffMain(
        root,
        (d) => fs.writeFileSync(path.join(d, "seed.txt"), "seed\nthe work\n"),
        "the work",
      );
      await setRef(root, REF, sha);
      await ensureWorktree(root, ROLE, "main");
      // Advance main with a conflicting edit to seed.txt after the pin — the common concurrent
      // case (the brief on main is unchanged, so the verify still approves).
      advanceMain(root, "seed.txt", "seed\nmain\n");
      const state = freshRunnerState(ROLE);
      const mainBefore = mainSha(root);
      const { ctx, calls } = makeCtx(root, state, (wt) => {
        // The resolver edits seed.txt to resolve the conflict AND rewrites the brief — the re-
        // review's deterministic gate rejects the resolution on briefEditReason.
        fs.writeFileSync(path.join(wt, "seed.txt"), "seed\ncombined\n");
        fs.writeFileSync(path.join(wt, "README.md"), prompt("rewritten"));
      });

      assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");

      assert.equal(mainSha(root), mainBefore, "nothing merged on main");
      assert.equal(await refSha(root, REF), null, "a rejected re-review is final: the pin is deleted");
      assert.equal(state.lastError, "merge failed: conflict resolution rejected on re-review");
      assert.equal(eventsOfType(root, "review_rejected").length, 1, "the rejection is logged");
      // A re-review rejection sends the resolved change back for revision too (plans/revise-
      // rejected.md): round 1 is recorded and the rejected ref keeps the head the re-review judged
      // alive, even though the merge pin itself is deleted.
      assert.equal(state.revision?.round, 1, "a re-review rejection owes one revision");
      assert.equal(await refSha(root, rejectedRefName(ROLE)), state.lastReview?.head);
      // The resolution run went through the wiring stub.
      assert.equal(calls.length, 1);
      // Terminal rejection deletes the pin; the shared `_merge` checkout persists (plans/
      // worktree-pool.md, part 2c) — the resolution is discarded by dropping the pin, not the
      // checkout, so the next merge reuses it.
      assert.equal(fs.existsSync(mergeWorktreePath(root)), true, "the shared _merge checkout persists on rejection");
    },
  );
});

test("an unwritable state file mid-review still folds the reviewer runs and settles a rejected re-review", async () => {
  // Re-pointed (part 4a/3): the rejection is the deterministic gate's — the resolution rewrites
  // the brief block, a finding that survives the part 3m/3 narrowing — as in the rejection case
  // above. The case's own subject survives too: an unwritable state file does not derail the
  // rejected re-review (the pin is deleted and the rejection is logged) and the failed save
  // warns. The reviewer-run folding this case used to assert dies with the reviewer; the title
  // is kept because docs/invariants.md (INV-CL1) pins this case for the recheckResolved saves.
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const root = makeRepo();
      const prompt = (body: string) =>
        `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
      fs.writeFileSync(path.join(root, "README.md"), prompt("original"));
      fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
      sh(root, "git", "add", "README.md", "seed.txt");
      sh(root, "git", "commit", "-q", "-m", "seed the brief and seed");
      const sha = pinOffMain(
        root,
        (d) => fs.writeFileSync(path.join(d, "seed.txt"), "seed\nthe work\n"),
        "the work",
      );
      await setRef(root, REF, sha);
      await ensureWorktree(root, ROLE, "main");
      advanceMain(root, "seed.txt", "seed\nmain\n");

      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state, (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "seed\ncombined\n");
        fs.writeFileSync(path.join(wt, "README.md"), prompt("rewritten"));
      });
      const stateTmp = `${statePath(root, ROLE)}.tmp-`;
      const undo = patchFsMethod("writeFileSync", (orig) => (...args) => {
        const file = args[0];
        if (typeof file === "string" && file.startsWith(stateTmp)) throw errnoError("ENOSPC");
        return orig(...args);
      });
      try {
        assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");
      } finally {
        undo();
      }

      assert.equal(await refSha(root, REF), null, "the rejected pin is deleted");
      assert.equal(eventsOfType(root, "review_rejected").length, 1, "the rejection is logged");
      assert.ok(
        warningMessages(root).some((m) => m.startsWith("could not save the role's state")),
        "a failed save warns",
      );
    },
  );
});

test("a merge pinned behind main's advance is rebased onto main BEFORE the gate and merges both", async () => {
  // PLANS.md 2026-09-21: the gate must review main's CURRENT tree. Advance main after the
  // pin with a non-conflicting commit, then check the gate saw the rebased tree — if the
  // gate ran on the stale pin, main's fix would not be under review and a red main would
  // cascade through every queued merge.
  const rec = path.join(tmpdir("merger-rec-"), "seen");
  await withPi(
    reviewerPi("VERDICT: approve"), // the verify's approve; the passing declared check is the deterministic gate
    async () => {
      const { root, sha } = await pinnedFixture();
      // A passing declared check is the deterministic gate that survives part 3h/3's removal of
      // the pre-merge reviewer, and it records the HEAD it ran at, so the "gate reviewed the
      // rebased tree" assertion rides the gate, not the reviewer (part 3p/3).
      declareCheck(root, `#!/bin/sh\ngit rev-parse HEAD >> ${rec}\necho ok\n`);
      // Land the declared check as its own commit separate from the "fix main" commit below, so
      // the gate's `npm run` resolves the check inside the merger worktree (the change's tree
      // inherits it from main) instead of climbing to the bare repo — and the "fix main" commit
      // stages only the intended fix file.
      sh(root, "git", "add", "package.json", "node_modules");
      sh(root, "git", "commit", "-m", "declare the project check");
      fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
      sh(root, "git", "add", "fix.txt");
      sh(root, "git", "commit", "-m", "fix main");
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "changed");

      // main holds both: main's fix underneath, the rebased change on top (linear, no merge).
      const mainHead = mainSha(root);
      assert.notEqual(mainHead, sha, "main moved past the pin: the change was rebased onto the fix");
      assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "seed\nthe work\n");
      assert.equal(fs.readFileSync(path.join(root, "fix.txt"), "utf8"), "main fix\n");
      assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
      // The declared check ran in the merger worktree at the SYNCED head — the pre-check tree is
      // exactly what became main, and the merge ref tracked it (deleted on merge here).
      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      assert.equal(seen[0], mainHead, "the gate reviewed the rebased tree, not the stale pin");
      assert.equal(await refSha(root, REF), null, "the pin was deleted on merge");
    },
  );
});

test("a synced rebase moves the merge ref so a failed gate keeps the tree that can merge", async () => {
  // The strike-cap tell compares the merger worktree's HEAD against req.sha: when the
  // pre-gate rebase rewrote the pin, the request (and the ref) must name the synced head, or
  // an under-cap failure would look like a strike-cap discard and delete the pinned work.
  await withPi(
    reviewerPi("VERDICT: approve"), // never reached: the failing declared check keeps the pin (main_red)
    async () => {
      const { root, sha } = await pinnedFixture();
      // The deterministic gate: a failing declared check on a red main reports main_red and keeps
      // the pin, so the "failed gate keeps the tree that can merge" outcome rides the gate, not a
      // reviewer failure (part 3p/3).
      declareCheck(root, "#!/bin/sh\necho 'error TS9001: boom' >&2\nexit 1\n");
      fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
      sh(root, "git", "add", "-A");
      sh(root, "git", "commit", "-m", "fix main");
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);

      assert.equal(await verifyAndMerge(ctx, request(sha)), "main_red");

      // Nothing merged (main still holds the fix commit), so the synced head is not main's
      // head — it is the rebased commit the verify's pooled slot sits at.
      const slot = readSlotsState(root).slots.find((s) => s.lastRole === ROLE)?.dir;
      assert.ok(slot, "the verify released the pooled slot it leased");
      const syncedHead = headSha(slot);
      assert.notEqual(syncedHead, sha, "the rebase rewrote the pin onto main's fix");
      assert.equal(
        await refSha(root, REF),
        syncedHead,
        "the ref tracks the rebased commit, not the stale pin",
      );
    },
  );
});

test("the merge checkout is shared, kept detached, and persists at a terminal outcome", async () => {
  await withPi(
    reviewerPi("VERDICT: approve"),
    async () => {
      const { root, sha } = await pinnedFixture();
      // Main moves after the pin so the in-lock rebase rewrites the tree and the merge check
      // runs; the first red is non-terminal (kept), the second hits the failure limit and is
      // attributed against main's own (green) verdict, so it rejects terminally.
      const tip = advanceMain(root, `main-per-role-${process.pid}-${Date.now()}.txt`, "main moves on\n");
      noteGreenBaseline(tip);
      const state = freshRunnerState(ROLE);
      const { ctx } = makeCtx(root, state);
      ctx.config = { ...ctx.config, check: { command: "echo 'error: planted merge failure'; exit 1" } };
      const mergeWt = mergeWorktreePath(root);

      // Non-terminal: the first red keeps the pin for a re-merge; the merge checkout persists.
      assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "the first red keeps the pin for one retry");
      assert.equal(await refSha(root, REF), sha, "the pin names the original pinned sha");
      assert.ok(fs.existsSync(mergeWt), "_merge exists after a non-terminal outcome");
      assert.equal(
        fs.existsSync(path.join(root, ".tumwater", "worktrees", `_land-${ROLE}`)),
        false,
        "no legacy _land-<role> checkout is created for a merge",
      );
      // Detached: no branch ref is checked out there — rebasing it never moves a role branch.
      let detached = false;
      try {
        sh(mergeWt, "git", "symbolic-ref", "--short", "HEAD");
      } catch {
        detached = true; // a detached HEAD makes symbolic-ref exit nonzero
      }
      assert.ok(detached, "_merge is detached (rebasing never moves a role branch)");

      // Terminal: at the failure limit a green main rejects the change — the pin goes, the
      // shared checkout stays for the next merge.
      assert.equal(await mergeApprovedChange(ctx, request(sha)), "rejected", "at the failure limit a green main rejects");
      assert.equal(await refSha(root, REF), null, "the pin is gone on rejection");
      assert.ok(fs.existsSync(mergeWt), "_merge persists at the terminal rejection");
      assert.equal(mainSha(root), tip, "nothing merged");
    },
  );
});
// A gate pre-check failure that survives its one re-run is attributed through main's own baseline
// verdict (src/review/review.ts), and the merge's ref lifecycle follows the two outcomes: a green
// main's reject deletes the pin, a red main's no-strike failure keeps it for the next re-merge.
// Neither spends a pi run. makeRepo's seed commit is byte-identical across tests run in the same
// second and the baseline cache is keyed by SHA, so the red case moves main to a commit of its own
// before asking.

test("a failing pre-check on a green main rejects the merge and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  // The gate scope fails while the declared check — what main's fresh re-check runs — passes:
  // main is green, so the change's failure is its own.
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the rejection is
  // the deterministic gate's, so pi never runs and the marker's absence is the meaningful proof of
  // "no pi run" (part 3p/3; no reviewer drives the rejection).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo ok", gateCommand: "echo 'error TS2345: boom' >&2; exit 1" } };
    assert.equal(await verifyAndMerge(ctx, request(sha)), "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
  });
});

// A change whose gate passes but whose in-lock merge check goes red (a cheaper
// check.gateCommand, say) used to come back merge_blocked on every re-merge, its role never
// authoring again. The first red keeps the pin for one retry; at MERGE_CHECK_FAILURE_LIMIT the
// red is judged by main's own verdict, like a red gate check.
for (const main of ["green", "red"] as const) {
  test(`a single merge's red in-lock check retries once, then ${main === "green" ? "rejects on a green main" : "keeps its pin as main_red"}`, async () => {
    assert.equal(MERGE_CHECK_FAILURE_LIMIT, 2);
    const { root, sha } = await pinnedFixture();
    // Main moves after the pin, so the in-lock rebase rewrites it and the merge check runs.
    const tip = advanceMain(root, `main-${main}-${process.pid}-${Date.now()}.txt`, "main moves on\n");
    if (main === "green") noteGreenBaseline(tip); // what main's own last merge left behind
    const state = freshRunnerState(ROLE);
    const { ctx, calls } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo 'error: planted merge failure'; exit 1" } };

    assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "the first red keeps the pin for one retry");
    assert.equal(await refSha(root, REF), sha);
    assert.equal(state.mergeCheckFailures?.count, 1);
    assert.match(state.lastError ?? "", /^merge failed: merge_blocked — check failed .*planted merge failure/);

    const second = await mergeApprovedChange(ctx, request(sha));
    if (main === "green") {
      assert.equal(second, "rejected", "the change broke the check: rejected with its output");
      assert.equal(await refSha(root, REF), null, "the pin is gone");
      assert.equal(state.lastReview?.verdict, "reject");
      assert.match(state.lastReview!.reasons[0]!, /planted merge failure/);
      assert.equal(eventsOfType(root, "review_rejected").length, 1);
    } else {
      assert.equal(second, "main_red", "main fails too: not this change's failure");
      assert.equal(await refSha(root, REF), sha, "the pin is kept for a re-merge once main is green");
      assert.match(state.lastError ?? "", /^merge check failed: main \S+ is red — not this change's failure$/);
      assert.equal(eventsOfType(root, "review_rejected").length, 0);
    }
    assert.equal(state.mergeCheckFailures, undefined, "the streak ends at the attribution");
    assert.equal(calls.length, 0, "no model run");
    assert.equal(mainSha(root), tip, "nothing merged");
  });
}

for (const main of ["green", "red"] as const) {
  test(`an unwritable state file during a red merge check's attribution still settles its verdict (${main} main)`, async () => {
    const { root, sha } = await pinnedFixture();
    const tip = advanceMain(root, `main-enospc-${main}-${process.pid}-${Date.now()}.txt`, "main moves on\n");
    if (main === "green") noteGreenBaseline(tip);
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo 'error: planted merge failure'; exit 1" } };
    assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");

    const prefix = `${statePath(root, ROLE)}.tmp-`;
    const restore = patchFsMethod("writeFileSync", (orig) => (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(prefix)) throw errnoError("ENOSPC");
      return orig(...args);
    });
    let second;
    try {
      second = await mergeApprovedChange(ctx, request(sha));
    } finally {
      restore();
    }
    if (main === "green") {
      assert.equal(second, "rejected");
      assert.equal(await refSha(root, REF), null, "the pin is gone");
      assert.equal(eventsOfType(root, "review_rejected").length, 1);
    } else {
      assert.equal(second, "main_red");
      assert.equal(await refSha(root, REF), sha, "the pin is kept");
      assert.equal(eventsOfType(root, "review_rejected").length, 0);
    }
    assert.ok(warningMessages(root).some((m) => m.startsWith("could not save the role's state")));
  });
}

// The first red of a patch's in-lock merge check is the retry that exists for load flakes — the
// whole point is to re-merge a flaky test green. It is also the one signal that could name the
// flaky test, and until now the reason was written only into lastError, which the leftover-recovery
// run overwrites a second later, so the flaky test could never be identified (BUGS.md 2026-10-14).
// The kept-for-re-merge path now logs a warning naming the failing test, so the digest and a later
// audit can still name it.
test("a kept-for-re-merge red merge check logs a warning naming the failing test", async () => {
  const { root, sha } = await pinnedFixture();
  // Main moves after the pin so the in-lock rebase rewrites the tree and the merge check runs.
  const tip = advanceMain(root, `main-red-warn-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  ctx.config = { ...ctx.config, check: { command: "echo '✖ the flaky test (1.2ms)'; exit 1" } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "the first red keeps the pin for one re-merge");
  assert.equal(await refSha(root, REF), sha, "the pin is kept");

  const warning = warningMessages(root).find((m) => m.includes("merge check failed (kept for one retry)"));
  assert.ok(warning, "the kept-for-re-merge red is recorded durably as a warning");
  assert.match(warning!, /the flaky test/, "the warning names the failing test");
  assert.equal(mainSha(root), tip, "nothing merged");
});

test("a red merge check that passes on its kept-pin retry logs a merge-check flake warning", async () => {
  const { root, sha } = await pinnedFixture();
  const tip = advanceMain(root, `main-flake-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  ctx.config = { ...ctx.config, check: { command: "echo '✖ the flaky test (1.2ms)'; exit 1" } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");
  assert.match(state.mergeCheckFailures?.headline ?? "", /the flaky test/);

  ctx.config = { ...ctx.config, check: { command: "true" } };
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed");
  const flaky = warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX));
  assert.equal(flaky.length, 1);
  assert.match(flaky[0]!, /the flaky test/);
  // failureHeadline strips the duration, so the gate looks up the bare headline.
  assert.ok(isKnownFlake(root, "✖ the flaky test"));
});

test("a red in-lock merge check whose immediate re-run passes merges and quarantines the failing test", async () => {
  const { root, sha } = await pinnedFixture();
  const tip = advanceMain(root, `main-requarantine-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  noteGreenBaseline(tip);
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  const flag = path.join(tmpdir(), "merge-flaky-once");
  ctx.config = {
    ...ctx.config,
    check: { command: `if [ -f '${flag}' ]; then exit 0; fi; touch '${flag}'; echo '✖ the flaky test (1.2ms)'; exit 1` },
  };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed", "the re-run passed, so the change merges");
  assert.deepEqual(quarantinedTests(root), ["the flaky test"]);
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 1);
});

test("a stale red strike of another pin is not recorded as a flake when a different pin merges", async () => {
  const { root, sha } = await pinnedFixture();
  const state = freshRunnerState(ROLE);
  state.mergeCheckFailures = { patchId: "not-this-pin", count: 1, headline: "✖ stale test" };
  const { ctx } = makeCtx(root, state);

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed");
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0);
});

// A fix-claim-blocked merge used to be kept like a lost fast-forward race and re-merged on
// every recovery, each retry paying a fresh conflict-resolver run against the same block —
// five resolver sessions for one pin on 2026-10-01. The block is a deterministic property of
// the tree ahead of main, so it is counted like a red merge check: the first block keeps
// the pin for one differently-rebased retry, and the second rejects the change with the
// block's reason (no model run, no main-tip verdict needed).
async function fixClaimFixture(): Promise<{ root: string; sha: string }> {
  const { root } = await pinnedFixture();
  // Seed BUGS.md on main with the bug Open; the pin's md-only commit moves it to Fixed
  // naming a symbol that exists nowhere on the tree — falseFixReason's block.
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### A bug (found 2026-10-02)\n\n**Symptom:** x.\n",
  );
  sh(root, "git", "add", "BUGS.md");
  sh(root, "git", "commit", "-m", "seed bugs");
  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "## Open\n\n### Another bug (found 2026-10-02)\n\n**Symptom:** y.\n\n" +
      "## Fixed\n\n### A bug (found 2026-10-02, fixed 2026-10-02)\n\n" +
      "**Fix:** `phantomSymbolName` in src/nowhere.ts now holds.\n",
  );
  // BUGS.md only: a `git add -A` here would sweep the role worktree's
  // .tumwater/worktrees/improve entry into the pin and the diff would not be md-only.
  sh(root, "git", "add", "BUGS.md");
  sh(root, "git", "commit", "-m", "fix claim");
  const sha = headSha(root);
  sh(root, "git", "checkout", "main");
  await setRef(root, REF, sha);
  // Main moves after the pin, so the in-lock rebase rewrites the head and verifyMerge's
  // exempt arm runs its cross-checks (a no-op rebase would skip them).
  advanceMain(root, `main-unrelated-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  return { root, sha };
}

test("a fix-claim-blocked merge retries once, then rejects with the block reason", async () => {
  assert.equal(MERGE_CHECK_FAILURE_LIMIT, 2);
  const { root, sha } = await fixClaimFixture();
  const state = freshRunnerState(ROLE);
  const { ctx, calls } = makeCtx(root, state);

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "the first block keeps the pin for one retry");
  assert.equal(await refSha(root, REF), sha);
  assert.equal(state.mergeCheckFailures?.count, 1);
  assert.match(state.lastError ?? "", /merge failed: merge_blocked — .*phantomSymbolName/);
  assert.equal(state.mergeCheckFailures?.headline, undefined, "a cross-check block stores no flake headline");
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0);

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "rejected", "the second identical block is attributed to the change");
  assert.equal(await refSha(root, REF), null, "the pin is gone");
  assert.equal(state.mergeCheckFailures, undefined, "the streak ends at the attribution");
  assert.match(state.lastReview!.reasons[0]!, /phantomSymbolName/);
  assert.equal(eventsOfType(root, "review_rejected").length, 1);
  assert.equal(calls.length, 0, "no model run — no resolver, no reviewer");
});

test("a fix-claim-blocked first attempt followed by a green merge logs no merge-check flake", async () => {
  const { root, sha } = await fixClaimFixture();
  const state = freshRunnerState(ROLE);
  const { ctx } = makeCtx(root, state);
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");
  // The claimed symbol now exists on main, so the retry's cross-checks pass.
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  advanceMain(root, "src/nowhere.ts", "export const phantomSymbolName = 1;\n");
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "changed");
  assert.equal(warningMessages(root).filter((m) => m.startsWith(MERGE_FLAKY_WARNING_PREFIX)).length, 0);
});

test("an unverified red in-lock check — the run timed out — keeps the pin without a strike", async () => {
  // The merge half of BUGS.md 2026-09-30: at the merge scopes a timed-out check made no
  // verdict about the tree, so it is not a strike against the patch (the red-attribution
  // helper's own unverified arm is pinned in attribute-red-check.test.ts — this drives the
  // same weather through a real merge, where the in-lock check's timeout is remapped to
  // unverified before mergeCheckRed ever sees it).
  const { root, sha } = await pinnedFixture();
  const tip = advanceMain(root, `main-unverified-${process.pid}-${Date.now()}.txt`, "main moves on\n");
  const state = freshRunnerState(ROLE);
  const { ctx, calls } = makeCtx(root, state);
  ctx.config = { ...ctx.config, check: { command: "sleep 5", timeoutSeconds: 1 } };

  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked", "an unverified red is retriable, like any merge_blocked");
  assert.equal(await refSha(root, REF), sha, "the pin stays for the next attempt");
  assert.equal(state.mergeCheckFailures, undefined, "no strike: the check never judged the tree");
  assert.match(state.lastError ?? "", /the tree is unverified/, "the state names the verdict-less run, not a test failure");
  assert.equal(mainSha(root), tip, "nothing merged");

  // A second attempt is the same weather: still no strike, still recoverable — an unverified
  // check can never accumulate into the strike-cap attribution that deletes the pin.
  assert.equal(await mergeApprovedChange(ctx, request(sha)), "merge_blocked");
  assert.equal(state.mergeCheckFailures, undefined, "the streak never opens on an unverified red");
  assert.equal(await refSha(root, REF), sha);
  assert.equal(calls.length, 0, "no model run");
});

test("a failing pre-check on a red main keeps the pin, records no rejection, and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  const unique = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, unique), "main moved\n");
  sh(root, "git", "add", unique);
  sh(root, "git", "commit", "-m", "main moves on its own");
  const newMainSha = mainSha(root);
  const marker = piRanMarker();
  // A fake pi on PATH that WOULD touch the marker if the merge path invoked it: the red-main keep
  // is the deterministic gate's, so pi never runs and the marker's absence is the meaningful proof
  // of "no pi run" (part 3p/3; no reviewer drives it).
  await withPi(`touch '${marker}'\n`, async () => {
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    assert.equal(await verifyAndMerge(ctx, request(sha)), "main_red", "not a reviewer failure");
    const pinned = await refSha(root, REF);
    assert.ok(pinned, "the pin survives a red main");
    // The pre-gate sync rebased the pin onto the moved main; the gate left it exactly there.
    assert.equal(sh(root, "git", "rev-parse", `${pinned}~1`), newMainSha);
    assert.ok(sh(root, "git", "show", `${pinned}:seed.txt`).includes("the work"), "the pin still names the work");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.match(state.lastError ?? "", /^gate check failed: main [0-9a-f]+ is red — not this change's failure$/);
    assert.ok(!readEvents(root).some((e) => e.type === "review_rejected"));
  });
});

// ── The merge: mergeApproved (merge queue 5/5, land-queue speed 2c) ─────────────────────────
// The merge over N roles' approved merges: stacked into one worktree, one shared build check,
// one fast-forward. The reviewer runs (each change's verify) are real pi subprocesses behind the
// fake shim; the fallback merges' conflict resolver goes through the wiring's runPi stub.

test("an all-rejected batch returns a defined result for every request without throwing", async () => {
  // The review re-audit found this exact shape crashing: |S| == 0 made the merger index the
  // empty stack and throw, and the drain's catch kept every entry — a queue leak. Now the
  // batch simply returns: every request terminal, nothing to merge, refs gone.
  // Both changes carry a conflict marker, so the deterministic gate's diff rule rejects each
  // before any reviewer runs (part 3p/3).
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
    edit: (d) => fs.appendFileSync(path.join(d, "change.txt"), "<<<<<<< HEAD\n"),
  });
  const mainBefore = mainSha(root);

  const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

  assert.deepEqual(results.map((r) => r.result), ["rejected", "rejected"], "every request has a terminal result");
  assert.equal(mainSha(root), mainBefore, "nothing merged");
  assert.equal(await refSha(root, mergeRefName("alpha")), null, "a rejection deletes its ref");
  assert.equal(await refSha(root, mergeRefName("beta")), null, "and the next request's too — the batch merges nothing");
});

test("a green batch stacks every approved change, fast-forwards main once, and logs per-change events", async () => {
  const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"]);
  // No pre-merge reviewer verdict: each change's approval is the gate's deterministic green
  // build pre-check (review.afterMerge acts on a pre-check that passed).
  declareCheck(root, "#!/bin/sh\necho ok\n");
  const mainBefore = mainSha(root);

  const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, undefined, afterMergeConfig(["alpha", "beta"]));

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
  const config = afterMergeConfig(["alpha", "beta"]);
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
  const config = afterMergeConfig(["alpha", "beta"]);
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
  // beta's change carries a conflict marker, so the deterministic gate's diff rule rejects it
  // before any reviewer runs; alpha and gamma approve through the deterministic check (part 3p/3).
  await withPi(perRoleReviewerPi({}), async () => {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"], {
      edit: (d, role) =>
        fs.appendFileSync(path.join(d, `${role}.txt`), role === "beta" ? "<<<<<<< HEAD\n" : `work by ${role}\n`),
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
