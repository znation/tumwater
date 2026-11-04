/** The review gate's attribution under a config where the main watch used to verify main (a
 * `check.gateCommand`, so `check.mergeCommand` falls back to it): a pre-check that fails twice is
 * decided at main's tip at once, never by waiting on the watch. Named failures are re-run alone
 * when a re-run command exists, else main's full check runs fresh; a nameless failure runs the
 * gate command at the tip. The other attribution slices are review-precheck.test.ts (a red
 * main) and review-precheck-green.test.ts (a green main or none). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review/review.js";
import { headOf } from "../src/git/git.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { defaultConfig } from "../src/config/config.js";
import type { CheckConfig } from "../src/config/config-schema.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { mainRedNotTheseFailures } from "../src/text/phrases.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { projManifest, writeScript } from "./fakes/fake-commands.js";
import { commitIn, mainSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { gateCtx, ROLE } from "./fixtures/gate-fixtures.js";

/** A gate command in effect and the full check detected from package.json, as in this repo's own
 * tumwater.json: the main watch verifies main (watchVerifiesMain). */
const WATCH_CONFIG = { ...defaultConfig(), check: { gateCommand: "npm run build" } as CheckConfig };

/** Fails test X where `x-broken.txt` exists and test Y where `y-broken.txt` does. */
const TOOL =
  "#!/bin/sh\nout=0\n[ -f x-broken.txt ] && { echo '✖ X (1ms)'; out=1; }\n[ -f y-broken.txt ] && { echo '✖ Y (1ms)'; out=1; }\nexit $out\n";

/** Commit `file` on main with content no other test shares, so its SHA has no cached verdict
 * (the baseline cache is process-wide and keyed by SHA). Returns main's new SHA. */
function commitOnMain(root: string, file: string): string {
  fs.writeFileSync(path.join(root, file), `${process.pid}-${Date.now()}-${Math.random()}\n`);
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", `main adds ${file}`);
  return mainSha(root);
}

/** A repo whose main declares `build: buildcheck-tool` and moves to a SHA of its own. */
function watchedRepo(): string {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), TOOL);
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build: "buildcheck-tool" }));
  sh(root, "git", "add", "package.json");
  sh(root, "git", "commit", "-m", "declare the check");
  commitOnMain(root, "unique.txt");
  return root;
}

/** Run the main watch once on main's tip, as the orchestrator poll does. */
async function watchMain(root: string): Promise<void> {
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, WATCH_CONFIG);
  await watch.idle();
}

/** A change off main's tip that breaks test X. */
async function breakingChange(root: string): Promise<{ wt: string; head: string }> {
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "x-broken.txt"), "x\n");
  commitIn(wt, "change breaks X");
  return { wt, head: await headOf(wt, "HEAD") };
}

const baselineRuns = (root: string): number =>
  readEvents(root).filter((e) => e.type === "build_check" && e.scope === "baseline").length;

const gateRuns = (root: string): string[] =>
  readEvents(root)
    .filter((e) => e.type === "build_check" && e.scope === "gate")
    .map((e) => String(e.status));

test("a twice-failed gate with no re-run command runs main's check fresh", async () => {
  const root = watchedRepo();
  await watchMain(root);
  const watched = baselineRuns(root);
  assert.equal(watched, 1, "the watch ran main's check once, green");
  const { wt } = await breakingChange(root);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config: WATCH_CONFIG }, state);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.deepEqual(gateRuns(root), ["failed", "failed"]);
    assert.equal(baselineRuns(root), watched + 1, "main's check ran fresh at its tip");
    assert.match(state.lastReview?.reasons[0] ?? "", /X/);
  });
});

test("a twice-failed gate whose base the watch checked red is rejected for the failures main does not share", async () => {
  const root = watchedRepo();
  const red = commitOnMain(root, "y-broken.txt");
  await watchMain(root);
  const watched = baselineRuns(root);
  const { wt } = await breakingChange(root);
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config: WATCH_CONFIG }, state);
    assert.equal(result.decision, "rejected", "main fails Y, not X: X is the change's own");
    assert.equal(state.lastReview?.reasons.at(-1), mainRedNotTheseFailures(red, ["X"]));
    assert.equal(baselineRuns(root), watched + 1, "main's check ran fresh at its tip");
  });
});

test("a twice-failed gate on a red main that names no test goes on to review", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n");
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build: "buildcheck-tool" }));
  sh(root, "git", "add", "package.json");
  sh(root, "git", "commit", "-m", "declare a check that never compiles");
  commitOnMain(root, "unique.txt");
  await watchMain(root);
  const { wt } = await breakingChange(root);
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config: WATCH_CONFIG }, state);
    assert.equal(result.decision, "approved", "main's gate command fails too: the failure is main's");
    assert.deepEqual(gateRuns(root), ["failed", "failed", "failed"], "the gate command ran at main's tip");
  });
});

test("a twice-failed gate asks main's tip even when the watch has not caught up", async () => {
  const root = watchedRepo();
  await watchMain(root);
  commitOnMain(root, "moved.txt"); // main moves on; the watch has not run on it yet
  const watched = baselineRuns(root);
  const { wt } = await breakingChange(root);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config: WATCH_CONFIG }, state);
    assert.equal(result.decision, "rejected", "main's tip answers at once, with no watch wait");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.equal(baselineRuns(root), watched + 1, "the gate ran main's check at its tip");
    assert.match(state.lastReview?.reasons[0] ?? "", /X/);
  });
});

/** WATCH_CONFIG with a re-run command: the npm script again, with the failing tests appended. */
const RERUN_CONFIG = { ...WATCH_CONFIG, check: { ...WATCH_CONFIG.check, rerunCommand: "npm run build --" } as CheckConfig };

const rerunRuns = (root: string): string[] =>
  readEvents(root)
    .filter((e) => e.type === "build_check" && e.scope === "rerun")
    .map((e) => String(e.status));

test("a twice-failed gate re-runs only its failing tests on main's tip, not main's check", async () => {
  const root = watchedRepo();
  await watchMain(root);
  commitOnMain(root, "moved.txt");
  const watched = baselineRuns(root);
  const { wt } = await breakingChange(root);
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config: RERUN_CONFIG }, state);
    assert.equal(result.decision, "rejected", "X passes on main's tip: the change broke it");
    assert.equal(baselineRuns(root), watched, "main's full check did not run");
    assert.deepEqual(rerunRuns(root), ["passed"], "only X ran on main's tip");
  });
});

test("a failing test the re-run finds failing on main's tip too is main's, and the change goes on", async () => {
  const root = watchedRepo();
  await watchMain(root);
  commitOnMain(root, "x-broken.txt"); // main breaks X after the watch's last verdict
  const watched = baselineRuns(root);
  const { wt } = await breakingChange(root);
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config: RERUN_CONFIG }, state);
    assert.notEqual(result.decision, "rejected");
    assert.equal(baselineRuns(root), watched, "main's full check did not run");
    assert.deepEqual(rerunRuns(root), ["failed"]);
    assert.ok(
      warningMessages(root).some((m) => /^gate check fails only tests main [0-9a-f]{8} fails too: X; going on to review$/.test(m)),
      JSON.stringify(warningMessages(root)),
    );
  });
});
