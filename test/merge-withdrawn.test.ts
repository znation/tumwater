/** Tests for src/merge/merge-withdrawn.ts and its two merge checks: a queued change whose backlog
 * entry main no longer lists is dropped unmerged, in the verify and again in the merge lock. The
 * repos are real git, the changes pinned the way a run's staging pins them. The 2026-11-02
 * incident: feature-2's change for a plan the operator had deleted from PLANS.md the day before
 * merged as 8ed0d3eec. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange } from "../src/merge/merge-core.js";
import { verifyRequest } from "../src/merge/merge-batch.js";
import { withdrawnEntries } from "../src/merge/merge-withdrawn.js";
import { refSha, setRef } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { APPROVE_PI, batchWiring, declareCheck, makeCtx, request } from "./fixtures/merger-fixtures.js";

const ROLE = "feature-2";

const entry = (name: string) => `### ${name} (planned 2026-01-01 by operator)\n\nBody ${name}.\n`;
const plans = (...names: string[]) => ["# Plans", "", "## Planned", "", ...names.map(entry), "## Done", ""].join("\n");
const BETA = { file: "PLANS.md" as const, key: "beta", title: "Beta (planned 2026-01-01 by operator)" };

/** Commit `md` as main's PLANS.md, staging only that file so the declared check stays untracked. */
function commitPlans(root: string, md: string, message: string): string {
  fs.writeFileSync(path.join(root, "PLANS.md"), md);
  sh(root, "git", "add", "PLANS.md");
  sh(root, "git", "commit", "-m", message);
  return mainSha(root);
}

/** A repo whose main plans Alpha and Beta, and feature-2's change pinned off it: code plus, when
 * `movesBeta`, Beta moved out of `## Planned` into `## Done` (what a feature run that finished
 * the plan commits). A passing check is declared, as the merger tests declare one. */
async function pinnedPlanChange(movesBeta = true): Promise<{ root: string; sha: string }> {
  const root = makeRepo();
  commitPlans(root, plans("Alpha", "Beta"), "plans");
  const sha = pinOffMain(
    root,
    (d) => {
      fs.writeFileSync(path.join(d, "beta.ts"), "export const beta = true;\n");
      if (movesBeta) {
        const done = plans("Alpha").replace("## Done\n", "## Done\n\n### Beta (planned 2026-01-01 by operator; done 2026-01-02 by the feature role)\n");
        fs.writeFileSync(path.join(d, "PLANS.md"), done);
      }
    },
    "implement beta",
  );
  declareCheck(root, "#!/bin/sh\necho ok\n");
  await setRef(root, mergeRefName(ROLE), sha);
  return { root, sha };
}

/** The operator withdraws Beta on main: its entry is deleted from `## Planned`, not finished. */
function withdrawBeta(root: string): string {
  return commitPlans(root, plans("Alpha"), "withdraw beta");
}

const WITHDRAWN_WARNING = 'dropped the change for "Beta" unmerged: PLANS.md on main no longer lists it under ## Planned';

test("the verify drops a change for a plan the operator deleted from main: nothing merges and the pin is gone", async () => {
  await withPi(APPROVE_PI, async () => {
    const { root, sha } = await pinnedPlanChange();
    const withdrawnMain = withdrawBeta(root);
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);

    const verdict = await verifyRequest(ctx, request(sha, { role: ROLE }), batchWiring(ctx));

    assert.deepEqual(verdict, { kind: "result", result: "withdrawn" });
    assert.equal(mainSha(root), withdrawnMain, "main did not move");
    assert.equal(await refSha(root, mergeRefName(ROLE)), null, "no recovery can bring the change back");
    assert.equal(state.lastError, `withdrawn — ${WITHDRAWN_WARNING}`);
    assert.deepEqual(warningMessages(root), [WITHDRAWN_WARNING]);
  });
});

test("the verify drops a change whose recorded claim main deleted, though its diff never touched PLANS.md", async () => {
  await withPi(APPROVE_PI, async () => {
    const { root, sha } = await pinnedPlanChange(false);
    withdrawBeta(root);
    const { ctx } = makeCtx(root, freshRunnerState(ROLE));
    const verdict = await verifyRequest(ctx, request(sha, { role: ROLE, claim: BETA }), batchWiring(ctx));
    assert.deepEqual(verdict, { kind: "result", result: "withdrawn" });
  });
});

test("a plan still listed on main merges: the guard leaves a change that finishes its own entry alone", async () => {
  await withPi(APPROVE_PI, async () => {
    const { root, sha } = await pinnedPlanChange();
    // Main moves on elsewhere in PLANS.md (a new plan on top), keeping Beta listed.
    commitPlans(root, plans("Gamma", "Alpha", "Beta"), "plan gamma");
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const req = request(sha, { role: ROLE, claim: BETA });

    // Part 4/4: one mergeApprovedChange call owns the change's one gate — it checks withdrawal
    // (Beta is still listed, so none), runs the gate (the declared check passes), then merges.
    assert.equal(await mergeApprovedChange(ctx, req), "changed");

    const merged = sh(root, "git", "show", "main:PLANS.md");
    assert.doesNotMatch(merged.split("## Done")[0]!, /### Beta/, "Beta left Planned with the merge");
    assert.deepEqual(warningMessages(root), []);
  });
});

test("the merge lock drops a change whose plan main deleted after its verify approved it", async () => {
  await withPi(APPROVE_PI, async () => {
    const { root, sha } = await pinnedPlanChange();
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const req = request(sha, { role: ROLE, claim: BETA });
    const verdict = await verifyRequest(ctx, req, batchWiring(ctx));
    assert.equal(verdict.kind, "approved", "Beta is still listed when the verify runs");

    // The operator withdraws Beta while the approved change waits for the merge slot.
    const withdrawnMain = withdrawBeta(root);
    // Part 4/4: the merge call still drops the withdrawn change before its gate — the
    // withdrawal check precedes reviewQueuedChange inside mergeApprovedChange.
    const result = await mergeApprovedChange(ctx, { ...req, sha: verdict.kind === "approved" ? verdict.sha : sha });

    assert.equal(result, "withdrawn");
    assert.equal(mainSha(root), withdrawnMain, "main did not move");
    assert.equal(await refSha(root, mergeRefName(ROLE)), null);
    assert.equal(state.lastError, `withdrawn — ${WITHDRAWN_WARNING}`);
    assert.deepEqual(warningMessages(root), [WITHDRAWN_WARNING]);
  });
});

test("an ungated merge drops a withdrawn change before its gate runs: no gate, nothing merges", async () => {
  const rec = path.join(tmpdir("merge-withdrawn-gate-"), "seen");
  await withPi(APPROVE_PI, async () => {
    const { root, sha } = await pinnedPlanChange();
    // The declared check logs every run: a line would prove the gate started on the withdrawn
    // change, so the log's absence is the proof this path drops it before the gate (the in-lock
    // withdrawn check would otherwise reach the same outcome after a gate ran and hid the order).
    declareCheck(root, `#!/bin/sh\ngit rev-parse HEAD >> ${rec}\necho ok\n`);
    const withdrawnMain = withdrawBeta(root);
    const state = freshRunnerState(ROLE);
    const { ctx } = makeCtx(root, state);
    const req = request(sha, { role: ROLE, claim: BETA });

    const result = await mergeApprovedChange(ctx, req);

    assert.equal(result, "withdrawn");
    assert.equal(mainSha(root), withdrawnMain, "main did not move");
    assert.equal(await refSha(root, mergeRefName(ROLE)), null, "the pin is gone");
    assert.ok(!fs.existsSync(rec), "no gate run: the check never logged a head");
    assert.equal(state.lastError, `withdrawn — ${WITHDRAWN_WARNING}`);
    assert.deepEqual(warningMessages(root), [WITHDRAWN_WARNING]);
  });
});

test("withdrawnEntries reads only the work roles' own sections, and an unreadable side never drops work", async () => {
  const { root, sha } = await pinnedPlanChange();
  withdrawBeta(root);
  assert.deepEqual(await withdrawnEntries(root, "main", ROLE, sha), [{ key: "beta", title: BETA.title }]);
  // A plan run reworks Planned by design, and a bugfix run's section is BUGS.md's Open.
  assert.deepEqual(await withdrawnEntries(root, "main", "plan", sha), []);
  assert.deepEqual(await withdrawnEntries(root, "main", "bugfix", sha, BETA), []);
  // A pin whose commit is gone, or a main with no PLANS.md, reads as nothing withdrawn.
  assert.deepEqual(await withdrawnEntries(root, "main", ROLE, "0".repeat(40), BETA), []);
  assert.deepEqual(await withdrawnEntries(root, "no-such-branch", ROLE, sha, BETA), []);
});
