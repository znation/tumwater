import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cachedBaselineVerdict } from "../src/baseline/main-baseline.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { defaultConfig } from "../src/config/config.js";
import { mainSha } from "./fixtures/repo-fixtures.js";
import { withApprovePi } from "./fakes/fake-pi.js";
import {
  batchFixture,
  runBatch,
  batchChecks,
  declareCheck,
  checkAfterGates,
  verifyThenMerge,
  makeBatchCtx,
  request,
} from "./fixtures/merger-fixtures.js";

// What a merged stack seeds into main's red-main baseline cache (mergeStack's `seed`): only a
// full batch check that PASSED on exactly the merged tip marks it green. Every other merge
// shape leaves the verdict unknown, so the main watch checks that tip itself.

const roles = ["alpha", "beta"];

test("a stack whose batch check passed seeds the merged tip green", async () => {
  const { root, shas, wiringFor } = await batchFixture(roles);
  checkAfterGates(root, 2, "true");
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.deepEqual(batchChecks(root).map((e) => e.status), ["passed"]);
    assert.equal(cachedBaselineVerdict(mainSha(root)), "green");
  });
});

test("a stack that fails only main's known failures merges but seeds nothing", async () => {
  const { root, shas, wiringFor } = await batchFixture(roles);
  declareCheck(root, `#!/bin/sh\necho '✖ X (1ms)'\nexit 1\n`);
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(batchChecks(root).length, 1, "one check over the whole stack, no bisect");
    assert.equal(cachedBaselineVerdict(mainSha(root)), undefined);
  });
});

test("a doc-only stack runs no check and seeds nothing", async () => {
  const { root, shas, wiringFor } = await batchFixture(roles, {
    edit: (r, role) => fs.appendFileSync(path.join(r, `${role}.md`), `docs by ${role}\n`),
  });
  declareCheck(root, "#!/bin/sh\necho \"a doc-only stack must never run me\"; exit 1\n");
  await withApprovePi(async () => {
    const results = await runBatch(root, shas, roles, wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    assert.equal(batchChecks(root).length, 0);
    assert.equal(cachedBaselineVerdict(mainSha(root)), undefined);
  });
});

test("a stack merged on check.mergeCommand runs it as a non-full batch check and seeds nothing", async () => {
  const { root, shas, wiringFor } = await batchFixture(roles);
  // The full check passes the two gate pre-checks and fails anything after them.
  checkAfterGates(root, 2, "exit 1");
  const ctx = makeBatchCtx(root, { ...defaultConfig(), check: { command: "", mergeCommand: "echo cheap" } });
  await withApprovePi(async () => {
    const results = await verifyThenMerge(ctx, roles.map((role) => request(shas[role]!, { role })), wiringFor);

    assert.deepEqual(results.map((r) => r.result), ["changed", "changed"]);
    const checks = batchChecks(root);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.script, "echo cheap");
    assert.equal(checks[0]?.full, false);
    assert.equal(cachedBaselineVerdict(mainSha(root)), undefined);
  });
});
