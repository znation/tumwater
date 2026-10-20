import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cachedBaselineVerdict,
  checkMainBaseline,
  noteGreenBaseline,
  noteInheritedGreen,
  persistBaselineVerdicts,
} from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineVerdictsPath } from "../src/paths.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// Main's green baseline verdicts survive a team restart (persistBaselineVerdicts in
// src/baseline/main-baseline.ts). The mirror is process-wide state, so these tests live in their
// own file: every other suite file keeps the cache in memory only.

const sha = (n: number) => n.toString(16).padStart(40, "0");

function savedGreens(root: string): unknown {
  return JSON.parse(fs.readFileSync(baselineVerdictsPath(root), "utf8"));
}

test("greens are mirrored to the state dir as they are recorded, observed and inherited alike", () => {
  const root = tmpdir("persist-");
  persistBaselineVerdicts(root);
  noteGreenBaseline(sha(1));
  noteInheritedGreen(sha(2), sha(1));
  const saved = savedGreens(root) as { greens: Array<{ sha: string; inheritedFrom?: string }> };
  assert.deepEqual(saved.greens.slice(-2), [{ sha: sha(1) }, { sha: sha(2), inheritedFrom: sha(1) }]);
});

test("a new generation starts from the saved greens and does not re-run the suite on them", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  writeFileDeep(baselineVerdictsPath(root), JSON.stringify({ greens: [{ sha: headSha(root) }] }));
  persistBaselineVerdicts(root);
  assert.equal(cachedBaselineVerdict(headSha(root)), "green");
  assert.equal((await checkMainBaseline(wt, defaultConfig())).baseline?.status, "green");
  assert.equal(runsOf(counter), 0, "the previous generation's verdict answered");
});

test("a red the watch recorded loads with its failing tests; a green a run turned red leaves the greens", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture("improve", `echo run >> ${counter}; exit 1`);
  persistBaselineVerdicts(root);
  noteInheritedGreen(headSha(root), sha(3)); // a carry-over the suite then contradicts
  assert.ok(JSON.stringify(savedGreens(root)).includes(headSha(root)));
  const observed = await checkMainBaseline(wt, defaultConfig(), undefined, false, false, undefined, true);
  assert.equal(observed.baseline?.status, "red");
  assert.deepEqual((savedGreens(root) as { greens: unknown[] }).greens.filter((g) => JSON.stringify(g).includes(headSha(root))), [], "the red replaced it on disk too");
});

test("a torn file or malformed entries read as no data", () => {
  const root = tmpdir("persist-torn-");
  writeFileDeep(baselineVerdictsPath(root), "{ not json");
  assert.doesNotThrow(() => persistBaselineVerdicts(root));
  fs.writeFileSync(
    baselineVerdictsPath(root),
    JSON.stringify({ greens: [{ sha: "not-a-sha" }, 7, { sha: sha(9), inheritedFrom: 5 }] }),
  );
  persistBaselineVerdicts(root);
  assert.equal(cachedBaselineVerdict("not-a-sha"), undefined);
  assert.equal(cachedBaselineVerdict(sha(9)), "green", "a well-formed SHA loads; a malformed carry-over source is dropped");
});

test("a restart reloads a saved red with its failing tests, and a new run keeps them", async () => {
  const root = tmpdir("persist-red-");
  writeFileDeep(baselineVerdictsPath(root),
    JSON.stringify({ reds: [{ sha: sha(7), script: "test", failingTests: ["a", "b"] }, { sha: "nope" }] }),
  );
  persistBaselineVerdicts(root);
  assert.equal(cachedBaselineVerdict(sha(7)), "red");
  noteGreenBaseline(sha(8)); // any write mirrors the cache again
  const saved = savedGreens(root) as { reds: Array<{ sha: string }> };
  assert.deepEqual(
    saved.reds.filter((r) => r.sha === sha(7)),
    [{ sha: sha(7), script: "test", failingTests: ["a", "b"] }],
  );
});
