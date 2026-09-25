import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LANDING_CHECK_FAILURE_LIMIT, landApprovedChange } from "../src/lander.js";
import type { BatchRoleWiring } from "../src/land-batch.js";
import { aheadOfMain, refSha, setRef } from "../src/git.js";
import { landingRefName, landWorktreePath, statePath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { readEvents } from "../src/events.js";
import { noteGreenBaseline } from "../src/main-baseline.js";
import type { LoopState } from "../src/types.js";
import { fakePi, sh, tmpdir } from "./util.js";
import {
  ROLE,
  REF,
  makeCtx,
  pinnedFixture,
  reviewerPi,
  request,
  vetAndLand,
  declareCheck,
  APPROVE_PI,
  batchFixture,
  runBatch,
  replyLine,
  reviewerByRole,
  awaitEvent,
  advanceMain,
  perRoleReviewerPi,
  runBatchRecorded,
} from "./lander-fixtures.js";

// Unit coverage for the two halves of a landing — land-batch.ts's vetRequest (checkout in
// _land-<role>, rebase onto main, lander.ts's review gate) and landVetted (the merge: one change
// through landApprovedChange, or a stack with one check, one fast-forward, the re-stack, 3d's
// prefix bisect and the one-at-a-time fallback) — driven here in queue order exactly as the
// landing pipeline runs them (landing-drain.ts). The reviewer run is a real pi subprocess behind
// the fake shim; merge.ts's conflict resolver goes through the wiring's runPi, which is stubbed.
//
// Split in three so node --test runs them in parallel processes: this file holds the vet and
// single-change landings, the batch basics, aborts and the per-change status hook;
// lander-2.test.ts the re-stack on a moved main; lander-3.test.ts the red-stack bisect and
// the one-at-a-time fallback. Shared fixtures live in test/lander-fixtures.ts. Keep the three
// roughly equal in measured duration when moving tests between them.

test("an approved landing lands on main and deletes the ref", async () => {
  const restore = fakePi(
    reviewerPi("VERDICT: approve"),
  );
  try {
    const { root, sha, wt } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "changed");

    assert.equal(sh(root, "git", "rev-parse", "main"), sha, "the pinned commit is main's head");
    assert.equal(await refSha(root, REF), null, "the pin was deleted on landing");
    assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree stayed clean at main");
    assert.equal(folded.length, 1, "the reviewer run's usage folds into the tick counters");
    assert.equal(state.lastReview?.verdict, "approve");
  } finally {
    restore();
  }
});

test("the gate's verdict is durable on disk before the tick's end save", async () => {
  // Regression (2026-09-14): state was written to disk only at tick boundaries, so a
  // sudden death after the gate's verdict (power loss, kill -9) left the last
  // tick-boundary snapshot on disk — a stale "reject" for work already superseded —
  // and every later tick got a "your previous change was rejected" note about work
  // that was already on main. The verdict must be durable before the tick's tail
  // (the landing plus the still-to-come authoring run) can die unsaved.
  const restore = fakePi(
    reviewerPi("VERDICT: approve"),
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    // What disk holds at tick start: the superseded rejection's verdict.
    state.lastReview = {
      verdict: "reject",
      reasons: ["build check failed (test): stale"],
      head: "0".repeat(40),
      at: Date.now() - 3_600_000,
    };
    saveLoopState(root, state);
    const { ctx } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "changed");

    // Read back from disk, not the in-memory object: without an immediate persist the
    // file still holds the seeded reject and the stale note would survive the crash.
    const onDisk = JSON.parse(fs.readFileSync(statePath(root, ROLE), "utf8")) as LoopState;
    assert.equal(onDisk.lastReview?.verdict, "approve", "the approve is durable on disk, not just in memory");
    assert.equal(onDisk.lastApprovedHead, sha, "the approved head is durable");
  } finally {
    restore();
  }
});

test("a rejected landing lands nothing: role worktree clean at main, ref deleted, reasons recorded", async () => {
  const restore = fakePi(
    reviewerPi("VERDICT: reject\n1. breaks the zero-dep rule"),
  );
  try {
    const { root, sha, wt } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const { ctx } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "rejected");

    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.equal(await aheadOfMain(wt, "main"), 0, "the role worktree is clean at main");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "no stray edits in the role worktree");
    assert.equal(await refSha(root, REF), null, "a rejection is terminal: the pin goes too");
    assert.deepEqual(state.lastReview?.reasons, ["breaks the zero-dep rule"]);
  } finally {
    restore();
  }
});

test("a verdict-less failure under the strike cap returns review_error and keeps the ref", async () => {
  const restore = fakePi(
    reviewerPi("I think this is fine overall."),
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const { ctx } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "review_error");

    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.ok(state.lastError?.startsWith("review failed:"), `lastError names the failure: ${state.lastError}`);
    assert.equal(await refSha(root, REF), sha, "under the cap the pin stays for next-tick recovery");
  } finally {
    restore();
  }
});

test("three verdict-less failures discard the landing and delete the ref", async () => {
  const restore = fakePi(
    reviewerPi("I think this is fine overall."),
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE); // one state object across all three attempts
    const mainBefore = sh(root, "git", "rev-parse", "main");

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { ctx } = makeCtx(root, state);
      assert.equal(await vetAndLand(ctx, request(sha)), "review_error");
      assert.equal(await refSha(root, REF), sha, `attempt ${attempt} is under the cap: pin kept`);
    }

    const { ctx } = makeCtx(root, state);
    assert.equal(await vetAndLand(ctx, request(sha)), "review_error", "the discard reports like a failure");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.equal(await refSha(root, REF), null, "past the strike cap the pin is deleted with it");
  } finally {
    restore();
  }
});

test("an abort mid-review returns aborted and keeps the ref", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: the signal is already aborted
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const { ctx, controller } = makeCtx(root, state);
    controller.abort(); // a shutdown that lands before the reviewer starts

    assert.equal(await vetAndLand(ctx, request(sha)), "aborted");

    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed on main");
    assert.equal(await refSha(root, REF), sha, "an aborted landing keeps its pin for recovery");
  } finally {
    restore();
  }
});

test("a conflicting landing gets one resolution run and then lands", async () => {
  const restore = fakePi(
    reviewerPi("VERDICT: approve"),
  );
  try {
    const { root, sha } = await pinnedFixture();
    // Advance main with a conflicting edit after the pin — the common concurrent case.
    fs.writeFileSync(path.join(root, "seed.txt"), "main\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "conflicting main edit");

    const state = freshLoopState(ROLE);
    const { ctx, calls } = makeCtx(root, state, (wt) => {
      fs.writeFileSync(path.join(wt, "seed.txt"), "combined\n"); // resolve the markers
    });

    assert.equal(await vetAndLand(ctx, request(sha)), "changed");

    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "combined\n");
    assert.equal(calls.length, 1, "exactly one resolution attempt per landing");
    assert.match(calls[0]!.session, /tumwater-improve-7-conflict/, "named after the role and tick");
    assert.equal(await refSha(root, REF), null, "the pin was deleted on landing");
    // The rebase rewrote the pinned commit onto main's advance: linear history, no merge commits.
    assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
  } finally {
    restore();
  }
});

test("a landing pinned behind main's advance is rebased onto main BEFORE the gate and lands both", async () => {
  // PLANS.md 2026-09-21: the gate must review main's CURRENT tree. Advance main after the
  // pin with a non-conflicting commit, then check the reviewer saw the rebased tree — if the
  // gate ran on the stale pin, main's fix would not be under review and a red main would
  // cascade through every queued landing.
  const rec = path.join(tmpdir("lander-rec-"), "seen");
  const restore = fakePi(
    `git rev-parse HEAD >> ${rec}\n` +
      reviewerPi("VERDICT: approve"),
  );
  try {
    const { root, sha } = await pinnedFixture();
    fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "fix main");
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "changed");

    // main holds both: main's fix underneath, the rebased change on top (linear, no merge).
    const mainHead = sh(root, "git", "rev-parse", "main").trim();
    assert.notEqual(mainHead, sha, "main moved past the pin: the change was rebased onto the fix");
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "seed\nthe work\n");
    assert.equal(fs.readFileSync(path.join(root, "fix.txt"), "utf8"), "main fix\n");
    assert.equal(sh(root, "git", "log", "--merges", "--oneline"), "");
    // The reviewer ran in the lander worktree at the SYNCED head — the pre-check/review tree
    // is exactly what became main, and the landing ref tracked it (deleted on landing here).
    const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
    assert.equal(seen[0], mainHead, "the gate reviewed the rebased tree, not the stale pin");
    assert.equal(await refSha(root, REF), null, "the pin was deleted on landing");
  } finally {
    restore();
  }
});

test("a synced rebase moves the landing ref so a failed gate keeps the tree that can land", async () => {
  // The strike-cap tell compares the lander worktree's HEAD against req.sha: when the
  // pre-gate rebase rewrote the pin, the request (and the ref) must name the synced head, or
  // an under-cap failure would look like a strike-cap discard and delete the pinned work.
  const restore = fakePi(
    reviewerPi("I think this is fine overall."),
  );
  try {
    const { root, sha } = await pinnedFixture();
    fs.writeFileSync(path.join(root, "fix.txt"), "main fix\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", "fix main");
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "review_error");

    // Nothing landed (main still holds the fix commit), so the synced head is not main's
    // head — it is the rebased commit the lander worktree sits at.
    const syncedHead = sh(landWorktreePath(root, ROLE), "git", "rev-parse", "HEAD").trim();
    assert.notEqual(syncedHead, sha, "the rebase rewrote the pin onto main's fix");
    assert.equal(
      await refSha(root, REF),
      syncedHead,
      "the ref tracks the rebased commit, not the stale pin",
    );
  } finally {
    restore();
  }
});

test("the lander worktree is per-role and detached at the pinned sha", async () => {
  const restore = fakePi(
    reviewerPi("VERDICT: approve"),
  );
  try {
    const { root, sha } = await pinnedFixture();
    const state = freshLoopState(ROLE);
    const { ctx } = makeCtx(root, state);

    assert.equal(await vetAndLand(ctx, request(sha)), "changed");

    const landWt = landWorktreePath(root, ROLE);
    assert.ok(fs.existsSync(landWt), "_land-<role> exists after a landing");
    assert.equal(sh(landWt, "git", "rev-parse", "HEAD"), sha, "it holds the landed tree");
    // Detached: no branch ref is checked out there — rebasing it never moves a role branch.
    let detached = false;
    try {
      sh(landWt, "git", "symbolic-ref", "--short", "HEAD");
    } catch {
      detached = true; // a detached HEAD makes symbolic-ref exit nonzero
    }
    assert.ok(detached, "_land-<role> is detached at the pinned sha");
  } finally {
    restore();
  }
});
// A gate pre-check failure that survives its one re-run is attributed through main's own
// baseline verdict (src/review.ts), and the landing's ref lifecycle follows the two outcomes: a
// green main's reject deletes the pin, a red main's no-strike failure keeps it for the next
// re-land. Neither spends a pi run. makeRepo's seed commit is byte-identical across tests run in
// the same second and the baseline cache is keyed by SHA, so the red case moves main to a commit
// of its own before asking.

test("a failing pre-check on a green main rejects the landing and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  noteGreenBaseline(sh(root, "git", "rev-parse", "main")); // what the last landing left behind
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\n${reviewerPi("VERDICT: approve")}`);
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    assert.equal(await vetAndLand(ctx, request(sha)), "rejected");
    assert.equal(await refSha(root, REF), null, "rejected: the pin is gone");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
    assert.equal(folded.length, 0, "nothing to fold");
    assert.equal(state.lastReview?.verdict, "reject");
  } finally {
    restore();
  }
});

// A change whose gate passes but whose in-lock landing check goes red (a cheaper
// check.gateCommand, say) used to come back merge_blocked on every re-land, its role never
// authoring again. The first red keeps the pin for one retry; at LANDING_CHECK_FAILURE_LIMIT the
// red is judged by main's own verdict, like a red gate check.
for (const main of ["green", "red"] as const) {
  test(`a single landing's red in-lock check retries once, then ${main === "green" ? "rejects on a green main" : "keeps its pin as main_red"}`, async () => {
    assert.equal(LANDING_CHECK_FAILURE_LIMIT, 2);
    const { root, sha } = await pinnedFixture();
    // Main moves after the pin, so the in-lock rebase rewrites it and the landing check runs.
    const tip = advanceMain(root, `main-${main}-${process.pid}-${Date.now()}.txt`, "main moves on\n");
    if (main === "green") noteGreenBaseline(tip); // what main's own last landing left behind
    const state = freshLoopState(ROLE);
    const { ctx, calls } = makeCtx(root, state);
    ctx.config = { ...ctx.config, check: { command: "echo 'error: planted landing failure'; exit 1" } };

    assert.equal(await landApprovedChange(ctx, request(sha)), "merge_blocked", "the first red keeps the pin for one retry");
    assert.equal(await refSha(root, REF), sha);
    assert.equal(state.landingCheckFailures?.count, 1);
    assert.match(state.lastError ?? "", /^merge failed: merge_blocked — build check failed .*planted landing failure/);

    const second = await landApprovedChange(ctx, request(sha));
    if (main === "green") {
      assert.equal(second, "rejected", "the change broke the check: rejected with its output");
      assert.equal(await refSha(root, REF), null, "the pin is gone");
      assert.equal(state.lastReview?.verdict, "reject");
      assert.match(state.lastReview!.reasons[0]!, /planted landing failure/);
      assert.equal(readEvents(root).filter((e) => e.type === "review_rejected").length, 1);
    } else {
      assert.equal(second, "main_red", "main fails too: not this change's failure");
      assert.equal(await refSha(root, REF), sha, "the pin is kept for a re-land once main is green");
      assert.match(state.lastError ?? "", /^landing check failed: main \S+ is red — not this change's failure$/);
      assert.equal(readEvents(root).filter((e) => e.type === "review_rejected").length, 0);
    }
    assert.equal(state.landingCheckFailures, undefined, "the streak ends at the attribution");
    assert.equal(calls.length, 0, "no model run");
    assert.equal(sh(root, "git", "rev-parse", "main"), tip, "nothing landed");
  });
}

test("a failing pre-check on a red main keeps the pin, records no rejection, and spends no pi run", async () => {
  const { root, sha } = await pinnedFixture();
  declareCheck(root, "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  const unique = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, unique), "main moved\n");
  sh(root, "git", "add", unique);
  sh(root, "git", "commit", "-m", "main moves on its own");
  const mainSha = sh(root, "git", "rev-parse", "main");
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\n${reviewerPi("VERDICT: approve")}`);
  try {
    const state = freshLoopState(ROLE);
    const { ctx, folded } = makeCtx(root, state);
    assert.equal(await vetAndLand(ctx, request(sha)), "main_red", "not a reviewer failure");
    const pinned = await refSha(root, REF);
    assert.ok(pinned, "the pin survives a red main");
    // The pre-gate sync rebased the pin onto the moved main; the gate left it exactly there.
    assert.equal(sh(root, "git", "rev-parse", `${pinned}~1`), mainSha);
    assert.ok(sh(root, "git", "show", `${pinned}:seed.txt`).includes("the work"), "the pin still names the work");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.equal(folded.length, 0);
    assert.equal(state.unreviewFailures ?? 0, 0, "no strike");
    assert.equal(state.lastReview?.verdict, "failed", "no rejection recorded against the author");
    assert.match(state.lastError ?? "", /^gate check failed: main [0-9a-f]+ is red — not this change's failure$/);
    assert.ok(!readEvents(root).some((e) => e.type === "review_rejected"));
  } finally {
    restore();
  }
});

// ── The merge: landVetted (merge queue 5/5, land-queue speed 2c) ─────────────────────────
// The merge over N roles' vetted landings: stacked into one worktree, one shared build check,
// one fast-forward. The reviewer runs (each change's vet) are real pi subprocesses behind the
// fake shim; the fallback landings' conflict resolver goes through the wiring's runPi stub.

test("an all-rejected batch returns a defined result for every request without throwing", async () => {
  // The review re-audit found this exact shape crashing: |S| == 0 made the lander index the
  // empty stack and throw, and the drain's catch kept every entry — a queue leak. Now the
  // batch simply returns: every request terminal, nothing to land, refs gone.
  const restore = fakePi(
    reviewerPi("VERDICT: reject\n1. no"),
  );
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["rejected", "rejected"], "every request has a terminal result");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "a rejection deletes its ref");
    assert.equal(await refSha(root, landingRefName("beta")), null, "and the next request's too — the batch lands nothing");
  } finally {
    restore();
  }
});

test("a green batch stacks every approved change, fast-forwards main once, and logs per-change events", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes landed on main");
    const merged = readEvents(root).filter((e) => e.type === "merged");
    assert.equal(merged.length, 2, "one merged event per change, in queue order");
    assert.equal(merged[0]!.commit, sh(root, "git", "rev-parse", "main~1"), "the head is the first new commit on main");
    assert.notEqual(merged[0]!.commit, shas.alpha!, "the head re-committed onto the fresh main base");
    assert.equal(merged[1]!.commit, sh(root, "git", "rev-parse", "main"), "the stacked tip is main's head");
    assert.notEqual(merged[1]!.commit, shas.beta!, "the second change re-committed on top of the first");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "the ff deleted the head's ref");
    assert.equal(await refSha(root, landingRefName("beta")), null, "and the stacked one's");
    assert.equal(folded.get("alpha")!.length, 1, "the gate's reviewer run folded into its own role");
    assert.equal(folded.get("beta")!.length, 1);
    assert.equal(states.alpha.lastApprovedHead, shas.alpha!, "the verdict persisted per role");
    assert.equal(states.beta.lastApprovedHead, shas.beta!);
  } finally {
    restore();
  }
});

test("a batch stacks every commit of a multi-commit pin, not its head alone", async () => {
  // The regression this pins: picking a pin's single head would land only its last diff and
  // orphan the work beneath it — the stack must pick the whole range from main to that head.
  const { root, shas, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
  sh(root, "git", "checkout", "--detach", shas.alpha!);
  fs.writeFileSync(path.join(root, "more.txt"), "more by alpha\n");
  sh(root, "git", "add", "more.txt");
  sh(root, "git", "commit", "-m", "more alpha work");
  shas.alpha = sh(root, "git", "rev-parse", "HEAD");
  await setRef(root, landingRefName("alpha"), shas.alpha);
  sh(root, "git", "checkout", "main");
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);
    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    // THREE commits on main: both of alpha's, then beta's — none orphaned.
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "3");
    assert.ok(sh(root, "git", "show", "main:alpha.txt").includes("work by alpha"), "the work beneath the head landed");
    assert.ok(sh(root, "git", "show", "main:more.txt").includes("more by alpha"));
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
    assert.equal(await refSha(root, landingRefName("alpha")), null);
    assert.equal(await refSha(root, landingRefName("beta")), null);
    assert.equal(folded.get("alpha")!.length, 1);
    assert.equal(folded.get("beta")!.length, 1);
  } finally {
    restore();
  }
});

test("an abort mid-batch routes every request without a terminal outcome to aborted, refs kept", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: the signal is already aborted
  try {
    const roles = ["alpha", "beta", "gamma"];
    const { root, shas, wiringFor, folded } = await batchFixture(roles);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    controller.abort(); // a shutdown (or a user stop for any batched role) before the batch starts

    const results = await runBatch(root, shas, roles, wiringFor, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted", "aborted"]);
    for (const role of roles) {
      assert.equal(await refSha(root, landingRefName(role)), shas[role]!, `an abort keeps ${role}'s ref for recovery`);
    }
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    // Every vet sees the stop before its gate starts: no reviewer spend on any of them.
    assert.equal(folded.size, 0, "no reviewer ran");
  } finally {
    restore();
  }
});

// BUGS.md 2026-09-23 — a stopping batch ends at its next step boundary, not only where a pi
// run notices the abort: the restart hand-off aborts a landing that outlived its deadline, and
// steps that spawn no pi (an approved-head short-circuit, the stack's assembly and shared
// check) must not carry on regardless.

test("an aborted batch lands nothing even when every gate would short-circuit on an approved head", async () => {
  const restore = fakePi(`exec sleep 30`); // never reached: no gate starts
  try {
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta"]);
    // Both heads already approved (a re-drained batch): every gate would short-circuit with
    // no pi run, so only the between-steps check can see the abort.
    states.alpha.lastApprovedHead = shas.alpha!;
    states.beta.lastApprovedHead = shas.beta!;
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    controller.abort();

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"]);
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the refs survive for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
    assert.equal(folded.size, 0, "no gate ran a pi");
  } finally {
    restore();
  }
});

test("an abort after the last gate approved stops the batch before its shared check", async () => {
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"]);
  // beta's approval is the last gate to finish: its review holds until alpha's verdict is on
  // record, as it must when the two vets run at once.
  const restore = fakePi(
    reviewerByRole({ beta: `${awaitEvent(root, "alpha", "review_verdict")}${replyLine("VERDICT: approve")}` }),
  );
  try {
    declareCheck(root, "#!/bin/sh\necho ok\n");
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    // The stop lands the moment beta's gate hands back its approval — after every gate, before
    // the stack is assembled and checked.
    const stopAfterBeta = (role: string): BatchRoleWiring => {
      const w = wiringFor(role);
      return role === "beta"
        ? {
            ...w,
            foldUsage: (run) => {
              w.foldUsage(run);
              controller.abort();
            },
          }
        : w;
    };

    const results = await runBatch(root, shas, ["alpha", "beta"], stopAfterBeta, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted", "aborted"], "both approved changes read aborted");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the refs survive for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!);
    const checks = readEvents(root).filter((e) => e.type === "build_check");
    assert.equal(checks.filter((e) => e.scope === "gate").length, 2, "both gates ran their pre-check");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 0, "the shared check never started");
  } finally {
    restore();
  }
});

test("an abort after the gate stops a one-change merge before it lands", async () => {
  // The one-change (and fallback) landings go through landApprovedChange, which runs no gate
  // of its own — only its own abort check sees a stop that arrived after the vet.
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha"]);
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const controller = new AbortController();
    const stopAfterGate = (role: string): BatchRoleWiring => {
      const w = wiringFor(role);
      return {
        ...w,
        foldUsage: (run) => {
          w.foldUsage(run);
          controller.abort();
        },
      };
    };

    const results = await runBatch(root, shas, ["alpha"], stopAfterGate, controller);

    assert.deepEqual(results.map((r) => r.result), ["aborted"]);
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "the ref survives for recovery");
  } finally {
    restore();
  }
});

// The per-change status hook (BUGS.md 2026-09-23): the drain mirrors these reports into the
// 4/5 marker so each batched role's row reads its own change's state — the batch must report
// every step, or a finished change keeps a live `landing` row (or an in-flight one shows none).

test("a merge reports each change as it reaches it: the stack lands together, and a rejected change never reaches it", async () => {
  const restore = fakePi(perRoleReviewerPi({ beta: "VERDICT: reject\n1. no" }));
  try {
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta", "gamma"]);
    const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta", "gamma"], wiringFor);
    assert.deepEqual(results, ["changed", "rejected", "changed"]);
    assert.deepEqual(seen, [
      "alpha:landing", // the stack's shared check + ff: every stacked change lands together
      "gamma:landing",
      "alpha:done", // landed: the merge is done with them
      "gamma:done",
    ]);
  } finally {
    restore();
  }
});

test("an abandoned stack reports one change landing at a time, the rest back to awaiting their turn", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    // Both roles rewrite the same line: the stack's cherry-pick conflicts and the merge
    // abandons to one-at-a-time.
    const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
      resolve: (wt) => fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"),
    });
    const { results, seen } = await runBatchRecorded(root, shas, ["alpha", "beta"], wiringFor);
    assert.deepEqual(results, ["changed", "changed"]);
    assert.deepEqual(seen, [
      "alpha:landing", // the stack attempt
      "beta:landing",
      "alpha:vetted", // abandoned: back to awaiting their turn…
      "beta:vetted",
      "alpha:landing", // …and each lands alone, then is done
      "alpha:done",
      "beta:landing",
      "beta:done",
    ]);
  } finally {
    restore();
  }
});
