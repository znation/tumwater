import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refSha } from "../src/git.js";
import { landingRefName } from "../src/paths.js";
import { readEvents } from "../src/events.js";
import { fakePi, sh, tmpdir } from "./util.js";
import {
  request,
  checkRunNumber,
  declareCheck,
  APPROVE_PI,
  makeBatchCtx,
  batchFixture,
  vetThenMerge,
  runBatch,
  batchChecks,
  checkAfterGates,
  advanceMain,
} from "./lander-fixtures.js";

// Third slice of the landing tests (see lander.test.ts for the split and what each file
// holds): landVetted's red-stack bisect and its one-at-a-time fallback. The reviewer runs are
// real pi subprocesses behind the fake shim; the fallback's conflict resolver is the wiring's
// stub.

// ── A red stack check lands the largest passing prefix (PLANS.md land-queue 3d) ─────────
// Not N more gates: the batch bisects in queue order, lands each green prefix with one ff,
// and attributes the one change a check ran red over alone through main's own baseline.

test("a stack of three whose second change breaks the check lands the first, rejects the second, re-queues the third", async () => {
  const roles = ["alpha", "beta", "gamma"];
  const { root, shas, states, wiringFor, folded } = await batchFixture(roles);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  // beta breaks the suite — but only on the stacked tree (its own gate passed: an
  // interaction the stack check exists to catch).
  checkAfterGates(root, 3, `[ -f "$INIT_CWD/beta.txt" ] && { echo "planted failure: beta breaks the suite"; exit 1; }`);
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "rejected", undefined]);
    assert.deepEqual(
      batchChecks(root).map((e) => e.status),
      ["failed", "passed", "failed"],
      "three batch checks: the whole stack, alpha's prefix, then beta alone on top of it",
    );
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by alpha"],
      "only the passing prefix landed",
    );
    // beta: rejected deterministically with the check's own output, no pi run.
    assert.equal(states.beta!.lastReview?.verdict, "reject");
    assert.match(states.beta!.lastReview!.reasons[0]!, /^build check failed \(.*\): planted failure: beta breaks the suite$/);
    assert.equal(states.beta!.unreviewFailures, 0);
    const rejected = readEvents(root).filter((e) => e.type === "review_rejected");
    assert.deepEqual(rejected.map((e) => e.loop), ["beta"], "one review_rejected, for beta");
    assert.equal(await refSha(root, landingRefName("beta")), null, "the rejection deleted beta's ref");
    // gamma: unattempted — entry and ref kept for the next drain.
    assert.equal(await refSha(root, landingRefName("gamma")), shas.gamma!, "gamma keeps its pin for the next drain");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "alpha landed: its ref is gone");
    // No model run past the vets, and main's baseline was a cache hit (alpha's prefix seeded it).
    assert.equal(readEvents(root).filter((e) => e.type === "review_start").length, 3, "one review per change, in its vet only");
    for (const role of roles) assert.equal(folded.get(role)!.length, 1, `${role}: only its vet's reviewer run`);
    assert.equal(
      readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline").length,
      0,
      "the prefix landing seeded main green, so attribution ran no baseline check",
    );
  } finally {
    restore();
  }
});

test("a stack whose every change passes still takes exactly one batch check", async () => {
  const roles = ["alpha", "beta", "gamma"];
  const { root, shas, wiringFor } = await batchFixture(roles);
  checkAfterGates(root, 3, "true");
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed", "changed"]);
    assert.deepEqual(batchChecks(root).map((e) => e.status), ["passed"], "one check over the whole stack");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 3);
  } finally {
    restore();
  }
});

// The head change fails alone on main's tip, so main's own baseline decides who owns the red:
// a red main keeps the pin (not the author's failure), an unavailable baseline rejects.
for (const baseline of ["red", "unavailable"] as const) {
  test(`a change red alone on a main whose baseline is ${baseline} ${baseline === "red" ? "keeps its pin as main_red" : "is rejected, saying so"}`, async () => {
    const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"]);
    // A main tip no other test's cache can know: the baseline check must actually run.
    const tip = advanceMain(root, "main.txt", `${root}\n`);
    // Runs 1-2: the gates. Runs 3-4: the whole stack, then alpha alone — both red. Run 5: main's
    // own baseline, red or broken-toolchain (an environmental skip: no verdict).
    const baselineRun =
      baseline === "red" ? `echo "main is broken too"; exit 1` : `echo "xcrun: error: planted toolchain"; exit 1`;
    checkAfterGates(root, 2, `if [ "$n" -le 4 ]; then echo "planted failure"; exit 1; else ${baselineRun}; fi`);
    const restore = fakePi(APPROVE_PI);
    try {
      const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

      assert.deepEqual(batchChecks(root).map((e) => e.status), ["failed", "failed"]);
      const baselineChecks = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline");
      assert.deepEqual(baselineChecks.map((e) => e.status), [baseline === "red" ? "failed" : "skipped"]);
      assert.equal(sh(root, "git", "rev-parse", "main"), tip, "nothing landed");
      assert.equal(results[1]!.result, undefined, "beta is unattempted: entry and ref kept");
      assert.ok(await refSha(root, landingRefName("beta")));
      if (baseline === "red") {
        assert.equal(results[0]!.result, "main_red");
        assert.ok(await refSha(root, landingRefName("alpha")), "the pin is kept for a re-land once main is green");
        assert.equal(states.alpha.lastReview?.verdict, "approve", "no rejection recorded against the author");
        assert.equal(states.alpha.unreviewFailures, 0, "and no strike");
        assert.match(states.alpha.lastError ?? "", /main \S+ is red — not this change's failure/);
        assert.equal(readEvents(root).filter((e) => e.type === "review_rejected").length, 0);
      } else {
        assert.equal(results[0]!.result, "rejected");
        assert.equal(await refSha(root, landingRefName("alpha")), null);
        const reasons = states.alpha.lastReview!.reasons;
        assert.match(reasons[0]!, /: planted failure$/);
        assert.match(reasons.at(-1)!, /baseline was unavailable \(its check was skipped \(toolchain\)\), so the red batch check is attributed to this change$/);
      }
    } finally {
      restore();
    }
  });
}

test("an un-assemblable stack's fallback lands pins from an older main with one review per change, not two", async () => {
  // BUGS.md 2026-09-23 (the Repro): the fallback once re-gated each approved head, rebasing
  // it before its gate — main had moved (the entries before it landed, and here main was ahead
  // of every pin to begin with) — so the exact-sha approved short-circuit never hit and each
  // change paid a second full gate: the reviewer count ended at 2N. It must end at N. (A red
  // stack check bisects instead; a cherry-pick conflict is what abandons to the fallback.)
  const { root, shas, wiringFor, folded } = await batchFixture(["alpha", "beta"], {
    edit: (root, role) => {
      fs.writeFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
      fs.writeFileSync(path.join(root, "shared.txt"), `${role}\n`); // the stack's pick of beta conflicts
    },
    resolve: (wt) => fs.writeFileSync(path.join(wt, "shared.txt"), "both\n"),
  });
  advanceMain(root, "main.txt", "landed after the pins\n");
  declareCheck(root, "#!/bin/sh\necho ok\n");
  const restore = fakePi(APPROVE_PI);
  try {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "the fallback lands both");
    const reviews = readEvents(root).filter((e) => e.type === "review_start");
    assert.equal(reviews.length, 2, "one model review per change (N), not a second one in the fallback (2N)");
    assert.equal(folded.get("alpha")!.length, 1);
    assert.equal(folded.get("beta")!.length, 1);
    assert.deepEqual(
      readEvents(root)
        .filter((e) => e.type === "build_check")
        .map((e) => [e.scope, e.status]),
      [
        ["gate", "passed"],
        ["gate", "passed"],
        ["landing", "passed"],
      ],
      "no stack check (the assembly conflicted); alpha's approved head lands as judged; beta's resolved rebase onto alpha is re-checked in-lock",
    );
    for (const f of ["main.txt", "alpha.txt", "beta.txt"]) {
      assert.ok(fs.existsSync(path.join(root, f)), `main holds ${f}`);
    }
  } finally {
    restore();
  }
});

test("a vet reviews each pin rebased onto main's current tip, so no reviewer's checkout is behind main", async () => {
  // BUGS.md 2026-09-23: d13cf2e was reviewed as its bare pin, five main commits behind; the
  // reviewer's checks against current main read those commits as the change deleting them
  // and rejected sound work as "reverts landed main work". Every vet runs the pre-gate rebase
  // (syncPinToMain): every review_start names a synced head, and the reviewer's own checkout
  // contains main's tip.
  const rec = path.join(tmpdir("batch-rec-"), "seen");
  const restore = fakePi(
    `if git merge-base --is-ancestor main HEAD; then echo synced >> ${rec}; else echo behind >> ${rec}; fi\n` +
      APPROVE_PI,
  );
  try {
    const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"]);
    const mainTip = advanceMain(root, "main.txt", "landed after the pins\n");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.deepEqual(fs.readFileSync(rec, "utf8").trim().split("\n"), ["synced", "synced"], "no reviewer sat behind main");
    // Keyed by role: in the pipeline the two vets run at once, so their review_start order is a race.
    const starts = readEvents(root).filter((e) => e.type === "review_start");
    assert.equal(starts.length, 2);
    const heads = new Map(starts.map((e) => [e.loop, String(e.head)]));
    for (const role of ["alpha", "beta"] as const) {
      const head = heads.get(role)!;
      assert.notEqual(head, shas[role], `${role} was reviewed rebased, not as its stale pin`);
      assert.equal(sh(root, "git", "rev-parse", `${head}~1`).trim(), mainTip, `${role} sits directly on main's tip`);
      assert.equal(states[role].lastApprovedHead, head, "the verdict names the head it judged");
    }
    assert.ok(fs.existsSync(path.join(root, "main.txt")), "main's own commit survived the landing");
  } finally {
    restore();
  }
});

test("a vet's rebase conflict reviews the bare pin and the fallback's resolver lands it", async () => {
  // The rule for a pin whose pre-gate rebase conflicts: rebaseOntoMain aborts and restores the
  // pin, the gate reviews the pinned tree, and mergeToMain's resolver lands it at the merge —
  // and the fallback, landing an approved head, must neither re-review the resolved change nor
  // the one behind it.
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) =>
        role === "alpha"
          ? fs.writeFileSync(path.join(root, "seed.txt"), "alpha\n")
          : fs.appendFileSync(path.join(root, "beta.txt"), "work by beta\n"),
      resolve: (wt) => fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"),
    });
    advanceMain(root, "seed.txt", "main\n"); // conflicts with alpha's rewrite of the same line

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    // Keyed by role: in the pipeline the two vets run at once, so their review_start order is a race.
    const starts = readEvents(root).filter((e) => e.type === "review_start");
    assert.equal(starts.length, 2, "one review per change: the fallback re-reviewed neither");
    const heads = new Map(starts.map((e) => [e.loop, e.head]));
    assert.equal(heads.get("alpha"), shas.alpha!, "alpha's rebase conflicted: its gate judged the restored pin");
    assert.notEqual(heads.get("beta"), shas.beta!, "beta's clean rebase was reviewed synced");
    assert.equal(calls.length, 1, "one resolution run, for alpha's conflict with main");
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution landed");
    assert.ok(fs.existsSync(path.join(root, "beta.txt")), "and beta on top of it");
  } finally {
    restore();
  }
});

test("a cherry-pick conflict abandons to one-at-a-time and the conflicting change resolves as a single landing", async () => {
  const restore = fakePi(APPROVE_PI);
  try {
    // Both roles rewrite the same line: the cherry-pick of the second onto the first conflicts.
    const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
      resolve: (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"); // resolve the rebase conflict
      },
    });

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution landed on main");
    assert.equal(calls.length, 1, "one resolution run — only the conflicting change needs it");
    assert.equal(readEvents(root).filter((e) => e.type === "merged").length, 2);
    assert.equal(await refSha(root, landingRefName("beta")), null, "the fallback deleted its ref");
  } finally {
    restore();
  }
});

test("a lost pin degrades its vet to a terminal error instead of starving the queue", async () => {
  // The queue entry can outlive its commit (a crash between pin and drop, or an outside gc):
  // its sha no longer resolves, so the vet's checkout throws. The vet must degrade that request
  // to a terminal "error" — the pipeline's write-back then drops its entry — rather than let the
  // throw escape: a permanently uncheckable entry would re-fail on every poll with its author
  // interlocked forever. The other changes' vets and merge are untouched by it.
  const restore = fakePi(APPROVE_PI);
  try {
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta", "gamma"]);
    sh(root, "git", "update-ref", "-d", landingRefName("alpha")); // the pin is gone
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const lost = "0".repeat(40); // a sha git cannot check out

    const results = await vetThenMerge(
      makeBatchCtx(root),
      [
        request(lost, { role: "alpha" }),
        request(shas.beta!, { role: "beta" }),
        request(shas.gamma!, { role: "gamma" }),
      ],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["error", "changed", "changed"], "the uncheckable pin is terminal; the rest land");
    assert.ok(states.alpha.lastError, "the git failure is recorded where the next tick's prompt reads it");
    assert.equal(folded.get("alpha"), undefined, "no reviewer run for the uncheckable pin");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "beta and gamma landed");
    assert.deepEqual(readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop), ["beta", "gamma"]);
  } finally {
    restore();
  }
});

test("an unlandable first bisect step after a red stack check degrades to error and leaves the rest unattempted", async () => {
  // A red stack check bisects; past the first stack attempt the fallback's throw contract
  // applies to every step: the throw is a terminal error for the change at the step's front,
  // and the batch stops so the rest stay unattempted (entry + ref intact) for the next drain.
  const { root, shas, wiringFor, states } = await batchFixture(["alpha", "beta"]);
  // Runs 1-2 are the gate pre-checks (pass); run 3 is the batch's one shared check: make it
  // fail AND make every later worktree recreate fail, so the bisect's first prefix cannot
  // even be assembled. npm runs the script at the package root, so the
  // worktrees dir is named by absolute path — the test's own sandbox, nothing above it.
  const count = path.join(root, ".checkcount");
  const worktrees = path.join(root, ".tumwater", "worktrees");
  declareCheck(
    root,
    `#!/bin/sh\n${checkRunNumber(count)}if [ "$n" = "3" ]; then rm -rf ${worktrees}; touch ${worktrees}; echo "error TS2345: boom" >&2; exit 1; fi\necho ok\n`,
  );
  const restore = fakePi(APPROVE_PI);
  try {
    const mainBefore = sh(root, "git", "rev-parse", "main");

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.equal(results[0]!.result, "error", "the first fallback entry's throw is a terminal error");
    assert.ok(states.alpha!.lastError, "the failure is visible in the role's state");
    assert.equal(results[1]!.result, undefined, "the rest stay unattempted for the next drain");
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!, "an error keeps its ref for recovery");
    assert.equal(await refSha(root, landingRefName("beta")), shas.beta!, "and so does the unattempted one");
    assert.equal(sh(root, "git", "rev-parse", "main"), mainBefore, "nothing landed");
  } finally {
    restore();
  }
});
