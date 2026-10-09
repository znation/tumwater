/** The error-degradation paths of landVetted (src/landing/landing-batch.ts) — the catches that turn a
 * THROWN failure (not a returned one) during the merge stage into a per-change "error" with
 * the message on the role's state, instead of losing an already-landed prefix or crashing the
 * merge slot. The wiring's runPi is the one stubbed call that can throw its way out
 * (landing-merge.ts's conflict resolver awaits it unwrapped), so each test makes main conflict with a
 * pinned change and the resolver blow up. The batch and single-change flows are pinned
 * end-to-end in lander.test.ts / lander-restack.test.ts with a resolver that always succeeds; these
 * pin what happens when it cannot run at all. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { landVetted, vetRequest, type BatchRoleWiring } from "../src/landing/landing-batch.js";
import { refSha } from "../src/git/git.js";
import { landingRefName } from "../src/paths.js";
import { mainSha } from "./fixtures/repo-fixtures.js";
import { withApprovePi } from "./fakes/fake-pi.js";
import { advanceMain, batchFixture, makeBatchCtx, request, runBatch } from "./fixtures/lander-fixtures.js";

/** The fixture's wiring with a conflict resolver that always throws — the merge stage's pi
 * run failing as a thrown error, the shape these catches exist for. */
function throwingWiring(wiringFor: (role: string) => BatchRoleWiring): (role: string) => BatchRoleWiring {
  return (role: string) => ({
    ...wiringFor(role),
    runPi: async () => {
      throw new Error("resolver exploded");
    },
  });
}

test("a single vetted change whose conflict resolver throws degrades to 'error' with the pin kept for recovery", async () => {
  // The pin appends to shared.txt; main rewrites the whole file after the vet, so the merge's
  // rebase is an add/add conflict and the resolver is the only way through — and it throws.
  const { root, shas, states, wiringFor } = await batchFixture(["alpha"], {
    edit: (r) => fs.appendFileSync(path.join(r, "shared.txt"), "alpha's line\n"),
  });
  await withApprovePi(async () => {
    const ctx = makeBatchCtx(root);
    const v = await vetRequest(ctx, request(shas.alpha!, { role: "alpha" }), wiringFor("alpha"));
    assert.equal(v.kind, "stack");
    if (v.kind !== "stack") return;
    const mainAtMerge = advanceMain(root, "shared.txt", "main rewrote the file\n");
    const results = await landVetted(ctx, [{ ...request(shas.alpha!, { role: "alpha" }), sha: v.sha }], throwingWiring(wiringFor));
    assert.deepEqual(results, ["error"]);
    assert.match(states.alpha!.lastError ?? "", /resolver exploded/);
    // Nothing half-landed: main sits at the moved tip, and the pin survives so the next
    // drain (or leftover recovery) can re-land the change.
    assert.equal(mainSha(root), mainAtMerge);
    assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha!);
  });
});

test("a stack abandoned to one-at-a-time keeps the prefix that landed and degrades a throwing resolver to that change alone", async () => {
  // Both changes append to shared.txt from the same base: the stack's cherry-pick of beta
  // onto main+alpha conflicts, the batch abandons to one-at-a-time, alpha lands cleanly, and
  // beta's merge hits the same conflict — where its resolver throws.
  const { root, shas, states, wiringFor } = await batchFixture(["alpha", "beta"], {
    edit: (r, role) => fs.appendFileSync(path.join(r, "shared.txt"), `${role}'s line\n`),
  });
  await withApprovePi(async () => {
    const results = (await runBatch(root, shas, ["alpha", "beta"], throwingWiring(wiringFor))).map((r) => r.result);
    assert.deepEqual(results, ["changed", "error"]);
    assert.match(states.beta!.lastError ?? "", /resolver exploded/);
    // Alpha's landing is real on main; beta's bytes never got there.
    const shared = fs.readFileSync(path.join(root, "shared.txt"), "utf8");
    assert.match(shared, /alpha's line/);
    assert.doesNotMatch(shared, /beta's line/);
    // Beta's pin is kept for the next drain's recovery.
    assert.notEqual(await refSha(root, landingRefName("beta")), null);
  });
});
