import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { revertSkipReason, runMainRevert, type MainCulprit } from "../src/baseline/main-revert.js";
import { defaultConfig } from "../src/config/config.js";
import { assignPendingReverts, drainMerge } from "../src/merge/merge-drain.js";
import { newMergePipeline, type MergePipelineContext } from "../src/merge/merge-pipeline.js";
import { queuedFiles } from "../src/inbox/inbox.js";
import { baselineFixture } from "./fixtures/runner-fixtures.js";
import { headSha, sh } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { baseRoleOf } from "../src/roles/runner-ids.js";
import { revertedPendingPath, rejectedRefName } from "../src/paths.js";
import { applyRevision, applyWithConflicts } from "../src/runner/revision.js";
import { clearSupersededRejection } from "../src/tick/tick-apply.js";
import { logEvent } from "../src/events/events.js";

const FAILING = "printf '✖ first (1.2ms)\\n✖ failing tests:\\n✖ first (1.2ms)\\n'";

function change(root: string, file: string, content: string): string {
  fs.writeFileSync(path.join(root, file), content);
  sh(root, "git", "add", "--", file);
  sh(root, "git", "commit", "-m", `edit ${file}`);
  return headSha(root);
}

/** G green, A green, B (bad.txt) red; the watch's culprit callback collects what it is handed. */
async function redMain(runner: string | undefined, laterEditToB = false) {
  const root = baselineFixture("improve", `[ -f bad.txt ] && { ${FAILING}; exit 1; }; echo ok`).root;
  const found: MainCulprit[] = [];
  const watch = createMainWatch(root, "main", (c) => found.push(c));
  const poll = async (): Promise<void> => {
    watch.poll(headSha(root), false, defaultConfig());
    await watch.idle();
  };
  await poll();
  change(root, "a.txt", "a");
  const b = change(root, "bad.txt", "b");
  if (runner !== undefined) logEvent(root, { source: runner, type: "merged", commit: b, summary: "breaks a test" });
  if (laterEditToB) change(root, "bad.txt", "b2");
  change(root, "README.md", "docs");
  await poll();
  return { root, b, found, poll };
}

test("a named culprit is reverted on main, main_revert is logged and the next verdict is green", async () => {
  const { root, b, found, poll } = await redMain("improve");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.commit, b);
  assert.equal(await revertSkipReason(root, "main", found[0]!), null);
  await runMainRevert(root, "main", defaultConfig(), found[0]!);
  const reverts = eventsOfType(root, "main_revert");
  assert.equal(reverts.length, 1);
  assert.equal(reverts[0]?.commit, b);
  assert.equal(reverts[0]?.revert, headSha(root));
  assert.ok(!fs.existsSync(path.join(root, "bad.txt")));
  assert.match(sh(root, "git", "log", "-1", "--format=%s"), /^tumwater\(tumwater\): Revert /);
  assert.equal(queuedFiles(root, "bugfix").length, 0);
  await poll();
  assert.equal(eventsOfType(root, "main_check").at(-1)?.status, "passed");
  assert.equal(await revertSkipReason(root, "main", found[0]!), "a revert of it already merged");
});

test("a revert that conflicts leaves main alone and queues the heal prompt naming the culprit", async () => {
  const { root, b, found } = await redMain("improve", true);
  const before = headSha(root);
  await runMainRevert(root, "main", defaultConfig(), found[0]!);
  assert.equal(headSha(root), before);
  assert.equal(eventsOfType(root, "main_revert").length, 0);
  const files = queuedFiles(root, "bugfix");
  assert.equal(files.length, 1);
  const prompt = fs.readFileSync(files[0]!, "utf8");
  assert.ok(prompt.includes(b.slice(0, 7)) && prompt.includes("first"), prompt);
});

test("a director-merged, runnerless or revert culprit is skipped", async () => {
  const { root, found } = await redMain("director");
  assert.equal(await revertSkipReason(root, "main", found[0]!), "the director merged it");
  const noRunner = await redMain(undefined);
  assert.equal(await revertSkipReason(noRunner.root, "main", noRunner.found[0]!), "no role runner merged it");
  const revert = change(root, "r.txt", "r");
  sh(root, "git", "commit", "--amend", "-m", "tumwater(operator): Revert abc1234");
  const c: MainCulprit = { commit: headSha(root), runner: "improve", failingTests: [], tip: revert };
  assert.equal(await revertSkipReason(root, "main", c), "it is itself a revert");
});

test("drainMerge starts a pending revert before any merge pick and frees the slot", async () => {
  const { root, found } = await redMain("improve");
  const p = newMergePipeline();
  p.revert = found[0]!;
  const ctx = { root, mainBranch: "main", liveConfig: defaultConfig() } as unknown as MergePipelineContext;
  drainMerge(ctx, p);
  assert.ok(p.merge !== null);
  assert.equal(p.revert, null);
  await p.merge.promise;
  assert.equal(p.merge, null);
  assert.equal(eventsOfType(root, "main_revert").length, 1);
});

function fakeRunner(role: string, state: Partial<RunnerState> = {}): RoleRunner {
  return { role, baseRole: baseRoleOf(role), state: { ...freshRunnerState(role), ...state } } as unknown as RoleRunner;
}

async function revertWith(runners: RoleRunner[], role = "improve") {
  const { root, b, found } = await redMain(role);
  const p = newMergePipeline();
  p.revert = found[0]!;
  const ctx = { root, mainBranch: "main", liveConfig: defaultConfig(), runners } as unknown as MergePipelineContext;
  drainMerge(ctx, p);
  await p.merge!.promise;
  return { root, b, ctx };
}

test("a reverted change goes back to its own runner as a revision naming the failing test", async () => {
  const runner = fakeRunner("improve");
  const { root, b } = await revertWith([runner]);
  assert.equal(runner.state.revision?.sha, b);
  assert.equal(runner.state.revision?.round, 1);
  assert.match(runner.state.lastReview?.reasons[0] ?? "", /reverted after merge: turned main red — .*first/);
  assert.equal(sh(root, "git", "rev-parse", rejectedRefName("improve")).trim(), b);
});

test("a busy own runner hands the revision to a free runner of the same base role, else it waits", async () => {
  const busy = fakeRunner("feature", { running: true });
  const other = fakeRunner("feature-2");
  const { root, b } = await revertWith([busy, other], "feature");
  assert.equal(busy.state.revision, undefined);
  assert.equal(other.state.revision?.sha, b);
  assert.equal(sh(root, "git", "rev-parse", rejectedRefName("feature-2")).trim(), b);
});

test("with no free runner the revision waits in reverted.json and is assigned once one frees", async () => {
  const busy = fakeRunner("improve", { running: true });
  const { root, b, ctx } = await revertWith([busy]);
  const pending = JSON.parse(fs.readFileSync(revertedPendingPath(root), "utf8")).reverted;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].commit, b);
  assert.equal(pending[0].role, "improve");
  await assignPendingReverts(ctx);
  assert.equal(busy.state.revision, undefined);
  busy.state.running = false;
  await assignPendingReverts(ctx);
  assert.equal((busy.state as RunnerState).revision?.sha, b);
  assert.deepEqual(JSON.parse(fs.readFileSync(revertedPendingPath(root), "utf8")), { reverted: [] });
});

test("the reverted commit re-applies onto the post-revert main as uncommitted edits", async () => {
  const runner = fakeRunner("improve");
  const { root, b } = await revertWith([runner]);
  assert.equal(await applyRevision(root, "main", runner.state.revision!.sha), true);
  assert.equal(fs.readFileSync(path.join(root, "bad.txt"), "utf8"), "b");
  assert.match(sh(root, "git", "status", "--porcelain"), /bad\.txt/);
  sh(root, "git", "reset", "--hard", "main");
  const applied = await applyWithConflicts(root, "main", b);
  assert.deepEqual(applied, { applied: true, conflicted: [] });
  assert.equal(fs.readFileSync(path.join(root, "bad.txt"), "utf8"), "b");
});

test("a standing reverted verdict is cleared like a rejection once the revision is resolved", () => {
  const s = freshRunnerState("improve");
  s.lastReview = { verdict: "reverted", reasons: ["x"], head: "abc", at: 1 };
  clearSupersededRejection(s);
  assert.equal(s.lastReview, undefined);
});
