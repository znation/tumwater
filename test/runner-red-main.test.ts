/** The red-main/baseline slice of the runner e2e suite, extracted from runner-2.test.ts: a code
 * role's authoring run on a red main is no longer blocked — the red-main authoring block came
 * off with the pre-merge blocks (parts 3g/3–3j/3 and 3d/3–3f/3) — while the `ci` healer is handed
 * the failing tests (the surviving `<main-red>` note). Like every runner suite file it runs in
 * its own process (fakePi's global PATH swap requires it) and its top-level tests run
 * sequentially within it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eventsOfType, mainRedHolds } from "./fixtures/log-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { headSha, initializedRepo, makeMainRed, tmpdir } from "./fixtures/repo-fixtures.js";
import { logPromptsTo, withPi } from "./fakes/fake-pi.js";
import { APPROVE_PI, assistantLine } from "./fixtures/pi-events.js";
import { persistBaselineVerdicts } from "../src/baseline/main-baseline.js";
import { baselineVerdictsPath } from "../src/paths.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// --- Red-main hand-off (the gate is gone): a code role authors on a red main; only the `ci`
// healer still gets a note naming the failing tests.

test("a code role authors while main is red, ending on its own outcome", async () => {
  const repo = await initializedRepo();
  makeMainRed(repo, path.join(tmpdir(), "npm-runs"));
  const marker = path.join(tmpdir(), "pi-invoked");
  await withPi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "feature");
      const outcome = await runner.run();
      assert.notEqual(outcome.result, "main_red", "a code role is no longer blocked on a red main");
      assert.ok(fs.existsSync(marker), "the authoring run started on a red main");
    },
  );
});

test("the ci healer's fresh prompt carries the red-main handoff", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs");
  makeMainRed(repo, counter);
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "pi-invoked");
  await withPi(
    [
      logPromptsTo(promptsFile),
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: fix main", { tokens: 10, output: 10, cost: 0.01 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "ci");
      const outcome = await runner.run();
      assert.equal(outcome.result, "queued", "the healer authors on a red main");
      assert.ok(fs.existsSync(marker), "its pi run started");

      const run = fs.readFileSync(promptsFile, "utf8");
      assert.ok(run.includes("<main-red>"), "the run prompt carries the red-main note");
      assert.ok(run.includes("baseline-failure-line"), "…naming the failure headline");
      assert.ok(run.includes("test"), "…and the failing script");

      // The healer's check is priced in the feed under ci, and the red SHA warns once.
      const checks = eventsOfType(repo, "build_check");
      assert.equal(checks.length, 1);
      assert.equal(checks[0]!.source, "ci");
      assert.equal(checks[0]!.scope, "baseline");
      assert.equal(checks[0]!.status, "failed");
      assert.equal(mainRedHolds(repo).length, 1);
    },
  );
});

// Every other role proceeds on a red main, told which tests already fail (the restored
// <main-known-red> note) — read from the main watch's cached verdict, so the run pays no check.

test("a code role's red-main run carries the known-failures note without starting a check", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs");
  makeMainRed(repo, counter);
  const redSha = headSha(repo);
  // Seed the main watch's persisted verdict so the run reads it without running the check.
  writeFileDeep(
    baselineVerdictsPath(repo),
    JSON.stringify({ reds: [{ sha: redSha, script: "test", failingTests: ["test/fails.test.ts"] }] }),
  );
  persistBaselineVerdicts(repo);
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "pi-invoked");
  await withPi(
    [
      logPromptsTo(promptsFile),
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "feature");
      await runner.run();
      assert.ok(fs.existsSync(marker), "the authoring run started on a red main");
      const run = fs.readFileSync(promptsFile, "utf8");
      assert.ok(run.includes("<main-known-red>"), "the run prompt carries the known-failures note");
      assert.ok(run.includes("test/fails.test.ts"), "naming the failing test");
      assert.ok(!run.includes("<main-red>"), "a non-ci role gets no heal note");
      // No check ran: the npm script never touched its counter.
      assert.equal(fs.existsSync(counter), false, "no check ran");
    },
  );
});

test("a green main's run prompt carries no known-failures note", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs");
  makeMainRed(repo, counter);
  const sha = headSha(repo);
  // A green verdict for the same commit: no note is appended and no check runs.
  writeFileDeep(baselineVerdictsPath(repo), JSON.stringify({ greens: [{ sha }] }));
  persistBaselineVerdicts(repo);
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "pi-invoked");
  await withPi(
    [
      logPromptsTo(promptsFile),
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "feature");
      await runner.run();
      assert.ok(fs.existsSync(marker), "the authoring run started");
      const run = fs.readFileSync(promptsFile, "utf8");
      assert.ok(!run.includes("<main-known-red>"), "a green main appends no known-failures note");
      assert.equal(fs.existsSync(counter), false, "no check ran");
    },
  );
});
