import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_FLAKY_WARNING_PREFIX } from "../src/review/known-flakes.js";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { aheadOfMain, refSha, setRef } from "../src/git/git.js";
import { readSlotsState } from "../src/git/slots-state.js";
import { mergeWorktreePath, rejectedRefName, statePath } from "../src/paths.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { assertClean, headSha, mainSha, pinOffMain, sh, tmpdir, makeRepo } from "./fixtures/repo-fixtures.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { withPi } from "./fakes/fake-pi.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  reviewerPi,
  request,
  verifyAndMerge,
  declareCheck,
  advanceMain,
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
// Split so node --test runs the slices in parallel processes and each fits the gate's 30 s
// budget: this file holds the verify and single-change merges (approval, rejection, abort,
// conflict resolution, the rebase onto main); merger-check.test.ts the pre-check and in-lock
// merge check verdicts (retries, flakes, false-fix md-only changes); merger-batch.test.ts the
// batch basics, aborts and the per-change status hook; merger-restack.test.ts the re-stack on a
// moved main; merger-bisect.test.ts the red-stack bisect; merger-fallback.test.ts the
// one-at-a-time fallback. Shared fixtures live in test/fixtures/merger-fixtures.ts. Keep each
// slice well under the budget in measured duration when moving tests between them.

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
  // which briefEditReason rejects before any check runs (part 3h/3 removed the pre-merge
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
  // deterministic — no fake pi run is needed and none survived part 3h/3's removal of the
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
// before any reviewer run — so the cases drive no model reviewer and survived the reviewer's
// removal in part 3h/3 (a brief-block edit is one of the three findings the part 3m/3
// narrowing keeps in the gate's scope). The reviewer's no-parseable-verdict retry path dies
// with the reviewer and is retired.

test("a resolution the re-review rejects deletes the pin and merges nothing", async () => {
  // Re-pointed (part 4a/3): the re-review now rejects on a deterministic diff-rule finding —
  // the resolution rewrites the brief block, which briefEditReason rejects before any reviewer
  // run (part 3h/3 removed the reviewer). A brief-block edit is one of the three findings the
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
