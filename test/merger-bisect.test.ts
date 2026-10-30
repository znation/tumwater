import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refSha } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { defaultConfig } from "../src/config/config.js";
import { mainSha, sh } from "./fixtures/repo-fixtures.js";
import { withApprovePi } from "./fakes/fake-pi.js";
import {
  declareCheck,
  batchFixture,
  runBatch,
  batchChecks,
  checkAfterGates,
  countingCheck,
  advanceMain,
} from "./fixtures/merger-fixtures.js";

// The bisect slice of the merge tests (see merger.test.ts for the split and what each file
// holds): mergeApproved's red-stack bisect, main's baseline deciding who owns a change red
// alone, and the doc-only stacks that pay no check. The reviewer runs are real pi subprocesses
// behind the fake shim.

// ── A red stack check merges the largest passing prefix ─────────
// Not N more gates: the batch bisects in queue order, merges each green prefix with one ff,
// and attributes the one change a check ran red over alone through main's own baseline.

test("a stack of three whose second change breaks the check merges the first, rejects the second, re-queues the third", async () => {
  const roles = ["alpha", "beta", "gamma"];
  const { root, shas, states, wiringFor } = await batchFixture(roles);
  const mainBefore = mainSha(root);
  // beta breaks the suite — but only on the stacked tree (its own gate passed: an
  // interaction the stack check exists to catch).
  checkAfterGates(root, 3, `[ -f "$INIT_CWD/beta.txt" ] && { echo "planted failure: beta breaks the suite"; exit 1; }`);
  await withApprovePi(async () => {
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
      "only the passing prefix merged",
    );
    // beta: rejected deterministically with the check's own output, no pi run.
    assert.equal(states.beta!.lastReview?.verdict, "reject");
    assert.match(states.beta!.lastReview!.reasons[0]!, /^check failed \(.*\): planted failure: beta breaks the suite$/);
    assert.equal(states.beta!.unreviewFailures, 0);
    const rejected = eventsOfType(root, "review_rejected");
    assert.deepEqual(rejected.map((e) => e.source), ["beta"], "one review_rejected, for beta");
    assert.equal(await refSha(root, mergeRefName("beta")), null, "the rejection deleted beta's ref");
    // gamma: unattempted — entry and ref kept for the next drain.
    assert.equal(await refSha(root, mergeRefName("gamma")), shas.gamma!, "gamma keeps its pin for the next drain");
    assert.equal(await refSha(root, mergeRefName("alpha")), null, "alpha merged: its ref is gone");
    // Main's baseline was a cache hit (alpha's prefix seeded it).
    assert.equal(
      readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline").length,
      0,
      "the prefix merge seeded main green, so attribution ran no baseline check",
    );
  });
});

test("a stack whose every change passes still takes exactly one batch check", async () => {
  const roles = ["alpha", "beta", "gamma"];
  const { root, shas, wiringFor } = await batchFixture(roles);
  checkAfterGates(root, 3, "true");
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed", "changed"]);
    assert.deepEqual(batchChecks(root).map((e) => e.status), ["passed"], "one check over the whole stack");
    assert.equal(eventsOfType(root, "merged").length, 3);
  });
});

test("a stack check that fails only main's known failures merges the whole stack in one check", async () => {
  const roles = ["alpha", "beta"];
  const { root, shas, wiringFor } = await batchFixture(roles);
  declareCheck(root, `#!/bin/sh\necho '✖ X (1ms)'\nexit 1\n`);
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(batchChecks(root).length, 1, "one check over the whole stack, no bisect");
    assert.equal(eventsOfType(root, "merged").length, 2);
  });
});

// ── A stack whose delta ahead of its assembly base is doc-only pays no check ────────────
// A doc-only delta cannot break the build — the gate skips its pre-check for one, and
// verifyMerge's exempt arm skips its in-lock re-check (BUGS.md 2026-09-30: a docs-only
// change batched with others, or left alone as a bisect's last step, paid a full suite run
// and could be rejected on its failure).

test("a stack whose every change is doc-only merges with no batch check", async () => {
  // The check fails anything it actually runs on, so a skip that stops holding fails the test
  // loudly (bisect → red alone → rejected) instead of quietly via a count.
  const roles = ["alpha", "beta"];
  const { root, shas, wiringFor } = await batchFixture(roles, {
    edit: (r, role) => fs.appendFileSync(path.join(r, `${role}.md`), `docs by ${role}\n`),
  });
  declareCheck(root, "#!/bin/sh\necho \"a doc-only stack must never run me\"; exit 1\n");
  const mainBefore = mainSha(root);
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(batchChecks(root).length, 0, "a doc-only stack runs no check at all");
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by beta", "work by alpha"],
      "both doc changes merged, in queue order",
    );
  });
});

test("a doc-only stack that breaks backlog structure merges as one, for the main watch", async () => {
  // The exemption is a fast path — and since part 3m/3 a repairable finding (here, a duplicated
  // "## Notes" section from two changes each adding one) no longer refuses anything: the stack
  // merges whole on the exemption and the main watch reports the broken backlog structure on
  // main's tip after it lands.
  const roles = ["alpha", "beta"];
  const { root, shas, wiringFor } = await batchFixture(roles, {
    // A backlog on main for both pins' diffs to be measured against.
    seed: (r) =>
      fs.writeFileSync(
        path.join(r, "PLANS.md"),
        "# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n_None yet._\n",
      ),
    edit: (r, role) => {
      // Each change alone adds one new section title — the gate's structure check passes it.
      // Stacked, the two additions duplicate "## Notes": the doc-only stack merges anyway.
      const md = fs.readFileSync(path.join(r, "PLANS.md"), "utf8");
      fs.writeFileSync(
        path.join(r, "PLANS.md"),
        role === "alpha" ? md.replace("## Done", "## Notes\n\nalpha's notes\n\n## Done") : `${md}\n## Notes\n\nbeta's notes\n`,
      );
    },
  });
  // The check fails anything it actually runs on, so a skip that stops holding fails the
  // test loudly instead of quietly via a count.
  declareCheck(root, '#!/bin/sh\necho "a doc-only stack must never run me"; exit 1\n');
  const mainBefore = mainSha(root);
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(batchChecks(root).length, 0, "the doc-only stack runs no batch check");
    assert.equal(
      readEvents(root).filter((e) => e.type === "build_check").length,
      0,
      "no check of any scope ran — the doc-only stack merges on the exemption",
    );
    assert.deepEqual(
      eventsOfType(root, "warning").filter((e) => String(e.message).includes("merge blocked")),
      [],
      "no merge-block warning: the duplicated heading lands for the main watch",
    );
    assert.deepEqual(
      sh(root, "git", "log", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by beta", "work by alpha"],
      "both doc changes reached main, in queue order",
    );
  });
});

test("a red stack's doc-only remainder merges on the exemption, without another check", async () => {
  // The incident's shape: the code prefix merges through the bisect, and the size-1 doc-only
  // remainder mergeStack is then left with must not pay a suite run of its own.
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
    // alpha is the code change the red check implicates; beta is the doc-only remainder.
    edit: (r, role) => fs.appendFileSync(path.join(r, role === "beta" ? "beta.md" : "alpha.txt"), "work\n"),
  });
  // Run 1: alpha's gate pre-check (beta's verify is exempt — no pre-check). Run 2: the whole
  // stack, planted red. Run 3: alpha alone, green — it merges. The remainder is beta alone.
  countingCheck(root, `if [ "$n" = "2" ]; then echo "planted failure"; exit 1; fi`);
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.deepEqual(
      batchChecks(root).map((e) => e.status),
      ["failed", "passed"],
      "the red stack check and the code prefix's — the doc-only remainder pays no third",
    );
    assert.equal(eventsOfType(root, "merged").length, 2);
  });
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
    await withApprovePi(async () => {
      const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

      assert.deepEqual(batchChecks(root).map((e) => e.status), ["failed", "failed"]);
      const baselineChecks = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline");
      assert.deepEqual(baselineChecks.map((e) => e.status), [baseline === "red" ? "failed" : "skipped"]);
      assert.equal(mainSha(root), tip, "nothing merged");
      assert.equal(results[1]!.result, undefined, "beta is unattempted: entry and ref kept");
      assert.ok(await refSha(root, mergeRefName("beta")));
      if (baseline === "red") {
        assert.equal(results[0]!.result, "main_red");
        assert.ok(await refSha(root, mergeRefName("alpha")), "the pin is kept for a re-merge once main is green");
        assert.match(states.alpha.lastError ?? "", /main \S+ is red — not this change's failure/);
        assert.equal(eventsOfType(root, "review_rejected").length, 0);
      } else {
        assert.equal(results[0]!.result, "rejected");
        assert.equal(await refSha(root, mergeRefName("alpha")), null);
        const reasons = states.alpha.lastReview!.reasons;
        assert.match(reasons[0]!, /: planted failure$/);
        assert.match(reasons.at(-1)!, /baseline was unavailable \(its check was skipped \(toolchain\)\), so the failed merge check is attributed to this change$/);
      }
    });
  });
}
