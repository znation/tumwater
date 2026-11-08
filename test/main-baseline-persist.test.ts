import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baselineCache,
  cachedBaselineVerdict,
  checkMainBaseline,
  noteGreenBaseline,
  noteInheritedGreen,
  persistBaselineVerdicts,
  settleRedByRerun,
} from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineVerdictsPath } from "../src/paths.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { readJson } from "./helpers/json-read.js";

// Main's green baseline verdicts survive a team restart (persistBaselineVerdicts in
// src/baseline/main-baseline.ts). The mirror is process-wide state, so these tests live in their
// own file: every other suite file keeps the cache in memory only.

const sha = (n: number) => n.toString(16).padStart(40, "0");

function savedGreens(root: string): unknown {
  return readJson(baselineVerdictsPath(root));
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

test("a fresh full run stamps checkedAt, and it survives a restart on green and red alike", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  persistBaselineVerdicts(root);
  const green = await checkMainBaseline(wt, defaultConfig());
  const greenAt = green.baseline?.checkedAt;
  assert.ok(typeof greenAt === "number" && Number.isFinite(greenAt), "the observed green carries a checkedAt");
  const savedGreen = (savedGreens(root) as { greens: Array<{ sha: string; checkedAt?: number }> })
    .greens.find((g) => g.sha === headSha(root));
  assert.ok(savedGreen?.checkedAt === greenAt, "the saved green carries the same checkedAt");

  // A fresh red on a new head of the checked worktree: its stamp is a later wall-clock moment.
  fs.writeFileSync(path.join(wt, "bump"), "x\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "bump");
  const red = await checkMainBaseline(wt, { ...defaultConfig(), check: { command: "exit 1" } }, undefined, true);
  const redAt = red.baseline?.checkedAt;
  assert.ok(typeof redAt === "number" && Number.isFinite(redAt), "the observed red carries a checkedAt");
  if (greenAt !== undefined && redAt !== undefined) assert.ok(redAt >= greenAt);
  const savedRed = (savedGreens(root) as { reds: Array<{ sha: string; checkedAt?: number }> })
    .reds.find((r) => r.sha === headSha(wt));
  assert.ok(savedRed?.checkedAt === redAt, "the saved red carries the same checkedAt");
});

test("a saved red's failingOffenders round-trip a restart, and a pre-capture verdict restores none", () => {
  const root = tmpdir("persist-offenders-");
  writeFileDeep(
    baselineVerdictsPath(root),
    JSON.stringify({
      reds: [
        { sha: sha(71), script: "test", failingTests: ["scan A"], failingOffenders: { "scan A": ["src/a.ts:1 (cols)"] } },
        { sha: sha(72), script: "test", failingTests: ["scan B"] }, // saved before the capture: no field
      ],
    }),
  );
  persistBaselineVerdicts(root);
  const cache = baselineCache as unknown as Map<string, { failingOffenders?: Record<string, string[]> }>;
  assert.deepEqual(cache.get(sha(71))?.failingOffenders, { "scan A": ["src/a.ts:1 (cols)"] });
  assert.equal(cache.get(sha(72))?.failingOffenders, undefined, "a pre-capture verdict restores no offenders");

  noteGreenBaseline(sha(73)); // any write re-mirrors the cache
  const saved = savedGreens(root) as { reds: Array<{ sha: string; failingOffenders?: Record<string, string[]> }> };
  assert.deepEqual(
    saved.reds.find((r) => r.sha === sha(71))?.failingOffenders,
    { "scan A": ["src/a.ts:1 (cols)"] },
    "the re-mirrored red keeps its offender lists",
  );
  assert.ok(
    !("failingOffenders" in (saved.reds.find((r) => r.sha === sha(72)) ?? {})),
    "a red with no offenders mirrors without the field",
  );
});

test("a stamped green and red load back with their stamps through a restart", () => {
  const root = tmpdir("persist-stamps-");
  writeFileDeep(
    baselineVerdictsPath(root),
    JSON.stringify({
      greens: [{ sha: sha(40), checkedAt: 111 }],
      reds: [{ sha: sha(41), script: "test", failingTests: [], checkedAt: 222 }],
    }),
  );
  persistBaselineVerdicts(root);
  const cache = baselineCache as unknown as Map<string, { checkedAt?: number }>;
  assert.equal(cache.get(sha(40))?.checkedAt, 111, "the stamped green loads stamped");
  assert.equal(cache.get(sha(41))?.checkedAt, 222, "the stamped red loads stamped");
  const saved = savedGreens(root) as { greens: Array<{ sha: string; checkedAt?: number }>; reds: Array<{ sha: string; checkedAt?: number }> };
  assert.ok(saved.greens.some((g) => g.sha === sha(40) && g.checkedAt === 111), "the re-mirrored green keeps its stamp");
  assert.ok(saved.reds.some((r) => r.sha === sha(41) && r.checkedAt === 222), "the re-mirrored red keeps its stamp");
});

test("a saved file without checkedAt loads with the field absent, not as 0", () => {
  const root = tmpdir("persist-no-at-");
  writeFileDeep(
    baselineVerdictsPath(root),
    JSON.stringify({ greens: [{ sha: sha(4), checkedAt: 1234 }], reds: [{ sha: sha(5), script: "test", failingTests: ["t"], checkedAt: 5678 }] }),
  );
  persistBaselineVerdicts(root);
  const cache = baselineCache as unknown as Map<string, { checkedAt?: number }>;
  assert.equal(cache.get(sha(4))?.checkedAt, 1234, "a stamped green loads stamped");
  assert.equal(cache.get(sha(5))?.checkedAt, 5678, "a stamped red loads stamped");

  writeFileDeep(
    baselineVerdictsPath(root),
    JSON.stringify({ greens: [{ sha: sha(6) }, { sha: sha(66), inheritedFrom: sha(1) }], reds: [{ sha: sha(77), script: "test", failingTests: [] }] }),
  );
  persistBaselineVerdicts(root);
  assert.equal(cache.get(sha(6))?.checkedAt, undefined, "an older-generation green loads unstamped, not 0");
  assert.equal(cache.get(sha(66))?.checkedAt, undefined, "an older-generation inherited green loads unstamped");
  assert.equal(cache.get(sha(77))?.checkedAt, undefined, "an older-generation red loads unstamped, not 0");
});

test("a rerun-confirmed red keeps the full run's checkedAt; a rerun-promoted green does too", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture("improve", `echo run >> ${counter}; exit 1`);
  persistBaselineVerdicts(root);
  const red = await checkMainBaseline(wt, defaultConfig(), undefined, true);
  const redAt = red.baseline?.checkedAt;
  const settledRed = settleRedByRerun(headSha(root), ["x"]);
  assert.equal(settledRed?.checkedAt, redAt, "the narrowed red carries the full run's stamp");
  const settledGreen = settleRedByRerun(headSha(root), []);
  assert.equal(settledGreen?.checkedAt, redAt, "the promoted green carries the full run's stamp, not a new one");
  assert.equal(cachedBaselineVerdict(headSha(root)), "green");
});

test("inherited and merge-seeded greens carry no checkedAt and save without it", () => {
  const root = tmpdir("persist-inherit-");
  persistBaselineVerdicts(root);
  noteGreenBaseline(sha(10));
  noteInheritedGreen(sha(11), sha(10));
  const saved = savedGreens(root) as { greens: Array<{ sha: string; checkedAt?: number; inheritedFrom?: string }> };
  const seeded = saved.greens.find((g) => g.sha === sha(10));
  const inherited = saved.greens.find((g) => g.sha === sha(11));
  assert.deepEqual(seeded, { sha: sha(10) }, "the merge-seeded green saves without checkedAt");
  assert.deepEqual(inherited, { sha: sha(11), inheritedFrom: sha(10) }, "the inherited green saves without checkedAt");
});
