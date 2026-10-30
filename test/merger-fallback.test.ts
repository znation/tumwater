import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refSha } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { mainSha, sh } from "./fixtures/repo-fixtures.js";
import { withApprovePi } from "./fakes/fake-pi.js";
import {
  request,
  checkRunNumber,
  declareCheck,
  makeBatchCtx,
  batchFixture,
  verifyThenMerge,
  runBatch,
  advanceMain,
} from "./fixtures/merger-fixtures.js";

// The fallback slice of the merge tests (see merger.test.ts for the split and what each file
// holds): mergeApproved's one-at-a-time fallback — an un-assemblable stack, a rebase or
// cherry-pick conflict — and the verify and bisect failures that degrade to a terminal error.
// The reviewer runs are real pi subprocesses behind the fake shim; the fallback's conflict
// resolver is the wiring's stub.

test("an un-assemblable stack's fallback merges pins from an older main with one review per change, not two", async () => {
  // BUGS.md 2026-09-23 (the Repro): the fallback once re-gated each approved head, rebasing
  // it before its gate — main had moved (the entries before it merged, and here main was ahead
  // of every pin to begin with) — so the exact-sha approved short-circuit never hit and each
  // change paid a second full gate: the reviewer count ended at 2N. It must end at N. (A red
  // stack check bisects instead; a cherry-pick conflict is what abandons to the fallback.)
  const { root, shas, wiringFor } = await batchFixture(["alpha", "beta"], {
    edit: (root, role) => {
      fs.writeFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
      fs.writeFileSync(path.join(root, "shared.txt"), `${role}\n`); // the stack's pick of beta conflicts
    },
    resolve: (wt) => fs.writeFileSync(path.join(wt, "shared.txt"), "both\n"),
  });
  advanceMain(root, "main.txt", "merged after the pins\n");
  declareCheck(root, "#!/bin/sh\necho ok\n");
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"], "the fallback merges both");
    assert.deepEqual(
      readEvents(root)
        .filter((e) => e.type === "build_check")
        .map((e) => [e.scope, e.status]),
      [
        ["gate", "passed"],
        ["gate", "passed"],
        ["gate", "passed"],
      ],
      "no stack check (the assembly conflicted); each change's rebase-rewritten tree is judged by a gate-scope check — beta's by its re-review pre-check, which the in-lock re-check then skips (rebasedHead === verifiedHead) and seeds the baseline with",
    );
    for (const f of ["main.txt", "alpha.txt", "beta.txt"]) {
      assert.ok(fs.existsSync(path.join(root, f)), `main holds ${f}`);
    }
  });
});

test("a verify's rebase conflict leaves the fallback's resolver to merge it", async () => {
  // The rule for a pin whose pre-gate rebase conflicts: rebaseOntoMain aborts and restores the
  // pin, and mergeToMain's resolver merges it at the merge — the fallback, merging an approved
  // head, neither re-gates it nor anything behind it.
  await withApprovePi(async () => {
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
    assert.equal(calls.length, 1, "one resolution run, for alpha's conflict with main");
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution merged");
    assert.ok(fs.existsSync(path.join(root, "beta.txt")), "and beta on top of it");
  });
});

test("a cherry-pick conflict abandons to one-at-a-time and the conflicting change resolves as a single merge", async () => {
  await withApprovePi(async () => {
    // Both roles rewrite the same line: the cherry-pick of the second onto the first conflicts.
    const { root, shas, wiringFor, calls } = await batchFixture(["alpha", "beta"], {
      edit: (root, role) => fs.writeFileSync(path.join(root, "seed.txt"), `${role}\n`),
      resolve: (wt) => {
        fs.writeFileSync(path.join(wt, "seed.txt"), "both\n"); // resolve the rebase conflict
      },
    });

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(fs.readFileSync(path.join(root, "seed.txt"), "utf8"), "both\n", "the resolution merged on main");
    assert.equal(calls.length, 1, "one resolution run — only the conflicting change needs it");
    assert.equal(eventsOfType(root, "merged").length, 2);
    assert.equal(await refSha(root, mergeRefName("beta")), null, "the fallback deleted its ref");
  });
});

test("a lost pin degrades its verify to a terminal error instead of starving the queue", async () => {
  // The queue entry can outlive its commit (a crash between pin and drop, or an outside gc): its
  // sha no longer resolves, so the verify's checkout throws. The verify must degrade that request
  // to a terminal "error" — the pipeline's write-back then drops its entry — rather than let the
  // throw escape: a permanently uncheckable entry would re-fail on every poll with its author
  // interlocked forever. The other changes' verifies and merge are untouched by it.
  await withApprovePi(async () => {
    const { root, shas, states, wiringFor, folded } = await batchFixture(["alpha", "beta", "gamma"]);
    sh(root, "git", "update-ref", "-d", mergeRefName("alpha")); // the pin is gone
    const mainBefore = mainSha(root);
    const lost = "0".repeat(40); // a sha git cannot check out

    const results = await verifyThenMerge(
      makeBatchCtx(root),
      [
        request(lost, { role: "alpha" }),
        request(shas.beta!, { role: "beta" }),
        request(shas.gamma!, { role: "gamma" }),
      ],
      wiringFor,
    );

    assert.deepEqual(results.map((r) => r.result), ["error", "changed", "changed"], "the uncheckable pin is terminal; the rest merge");
    assert.ok(states.alpha.lastError, "the git failure is recorded where the next run's prompt reads it");
    assert.equal(folded.get("alpha"), undefined, "no reviewer run for the uncheckable pin");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "beta and gamma merged");
    assert.deepEqual(eventsOfType(root, "merged").map((e) => e.source), ["beta", "gamma"]);
  });
});

test("a first bisect step that cannot merge after a red stack check degrades to error and leaves the rest unattempted", async () => {
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
  await withApprovePi(async () => {
    const mainBefore = mainSha(root);

    const results = await runBatch(root, shas, ["alpha", "beta"], wiringFor);

    assert.equal(results[0]!.result, "error", "the first fallback entry's throw is a terminal error");
    assert.ok(states.alpha!.lastError, "the failure is visible in the role's state");
    assert.equal(results[1]!.result, undefined, "the rest stay unattempted for the next drain");
    assert.equal(await refSha(root, mergeRefName("alpha")), shas.alpha!, "an error keeps its ref for recovery");
    assert.equal(await refSha(root, mergeRefName("beta")), shas.beta!, "and so does the unattempted one");
    assert.equal(mainSha(root), mainBefore, "nothing merged");
  });
});
