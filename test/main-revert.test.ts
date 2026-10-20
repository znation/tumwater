import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { revertSkipReason, routeMainCulprit, runMainRevert, type MainCulprit } from "../src/baseline/main-revert.js";
import { defaultConfig } from "../src/config/config.js";
import { assignPendingReverts, drainMerge } from "../src/merge/merge-drain.js";
import { newMergePipeline, type MergePipelineContext } from "../src/merge/merge-pipeline.js";
import { queuedFiles } from "../src/inbox/inbox.js";
import { baselineFixture } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { baseRoleOf } from "../src/roles/runner-ids.js";
import { roleInboxDir, revertedPendingPath, rejectedRefName, statePath } from "../src/paths.js";
import { errnoError, failRenameSyncOn, patchFsMethod } from "./helpers/fs-faults.js";
import { applyRevision, applyWithConflicts } from "../src/runner/revision.js";
import { clearSupersededRejection } from "../src/run/run-apply.js";
import { logEvent } from "../src/events/events.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

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

test("a conflicting revert whose heal prompt cannot be queued resolves and warns once that it was not queued", async () => {
  const { root, found } = await redMain("improve", true);
  const before = headSha(root);
  const inbox = roleInboxDir(root, "bugfix");
  const restore = patchFsMethod("writeFileSync", (orig) => (target, ...rest) => {
    if (String(target).startsWith(inbox)) throw errnoError("ENOSPC");
    return orig(target, ...rest);
  });
  try {
    await runMainRevert(root, "main", defaultConfig(), found[0]!);
  } finally {
    restore();
  }
  assert.equal(headSha(root), before);
  assert.equal(queuedFiles(root, "bugfix").length, 0);
  assert.equal(eventsOfType(root, "main_revert").length, 0);
  const warnings = warningMessages(root);
  assert.equal(warnings.filter((m) => m.includes("could not revert") && /could not queue the heal prompt for bugfix: .*ENOSPC/.test(m)).length, 1);
  assert.equal(warnings.filter((m) => m.includes("queued the heal prompt") && !m.includes("could not queue")).length, 0);
});

test("a skipped culprit whose heal prompt cannot be queued resolves and warns once that it was not queued", async () => {
  const { root, found } = await redMain(undefined);
  const inbox = roleInboxDir(root, "bugfix");
  const restore = patchFsMethod("writeFileSync", (orig) => (target, ...rest) => {
    if (String(target).startsWith(inbox)) throw errnoError("ENOSPC");
    return orig(target, ...rest);
  });
  const started: MainCulprit[] = [];
  try {
    await routeMainCulprit(root, "main", found[0]!, (c) => started.push(c));
  } finally {
    restore();
  }
  assert.equal(started.length, 0);
  assert.equal(queuedFiles(root, "bugfix").length, 0);
  const warnings = warningMessages(root);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes("no role runner merged it"));
  assert.match(warnings[0]!, /could not queue the heal prompt for bugfix: .*ENOSPC/);
});

test("a named culprit starts its revert, and a skipped one queues the heal prompt instead", async () => {
  const named = await redMain("improve");
  const started: MainCulprit[] = [];
  await routeMainCulprit(named.root, "main", named.found[0]!, (c) => started.push(c));
  assert.deepEqual(started, [named.found[0]]);
  assert.equal(queuedFiles(named.root, "bugfix").length, 0);
  const skipped = await redMain(undefined);
  const none: MainCulprit[] = [];
  await routeMainCulprit(skipped.root, "main", skipped.found[0]!, (c) => none.push(c));
  assert.equal(none.length, 0);
  assert.equal(queuedFiles(skipped.root, "bugfix").length, 1);
});

test("a post-review revert whose reviewer hand-off throws resolves and warns that the reasons were not sent", async () => {
  const { root, found } = await redMain("improve", true);
  const c: MainCulprit = { ...found[0]!, postReview: { reasons: ["r"] } };
  await runMainRevert(root, "main", defaultConfig(), c, undefined, () => {
    throw new Error("EACCES");
  });
  const warnings = warningMessages(root);
  assert.equal(warnings.filter((m) => m.includes("could not send the reviewer's reasons to its role: EACCES")).length, 1);
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

function pendingRoot(entries: unknown[]): { root: string; ctxOf: (runners: RoleRunner[]) => MergePipelineContext } {
  const root = tmpdir();
  writeFileDeep(revertedPendingPath(root), JSON.stringify({ reverted: entries }));
  const ctxOf = (runners: RoleRunner[]) => ({ root, mainBranch: "main", runners }) as unknown as MergePipelineContext;
  return { root, ctxOf };
}

const SHA = "a".repeat(40);

test("a torn reverted.json entry is dropped and the well-formed one is still handed back", async () => {
  const { root, ctxOf } = pendingRoot([
    null,
    { commit: 7 },
    { commit: SHA, role: "improve", reasons: "x" },
    { commit: SHA, role: "improve", reasons: ["first", 3] },
  ]);
  const runner = fakeRunner("improve");
  await assignPendingReverts(ctxOf([runner]));
  assert.equal(runner.state.revision?.sha, SHA);
  assert.deepEqual(runner.state.lastReview?.reasons, ["first"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(revertedPendingPath(root), "utf8")), { reverted: [] });
});

test("a hand-back whose state save fails warns and still counts as assigned", async () => {
  const { root, ctxOf } = pendingRoot([{ commit: SHA, role: "improve", reasons: ["r"] }]);
  const runner = fakeRunner("improve");
  const undo = failRenameSyncOn(statePath(root, "improve"), "state write refused");
  try {
    await assignPendingReverts(ctxOf([runner]));
  } finally {
    undo();
  }
  assert.equal(runner.state.revision?.sha, SHA);
  assert.deepEqual(JSON.parse(fs.readFileSync(revertedPendingPath(root), "utf8")), { reverted: [] });
  const warnings = eventsOfType(root, "warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.source, "improve");
  assert.match(String(warnings[0]?.message), /state write refused/);
});

test("a failed reverted.json rewrite warns, and the next poll does not hand the commit out twice", async () => {
  const { root, ctxOf } = pendingRoot([{ commit: SHA, role: "feature", reasons: ["r"] }]);
  const first = fakeRunner("feature");
  const second = fakeRunner("feature-2");
  const ctx = ctxOf([first, second]);
  const undo = patchFsMethod("renameSync", (orig) => (a, b) => {
    if (b === revertedPendingPath(root)) throw new Error("pending write refused");
    return orig(a, b);
  });
  try {
    await assignPendingReverts(ctx);
  } finally {
    undo();
  }
  assert.equal(first.state.revision?.sha, SHA);
  assert.match(String(eventsOfType(root, "warning").at(-1)?.message), /pending write refused/);
  await assignPendingReverts(ctx);
  assert.equal(second.state.revision, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(revertedPendingPath(root), "utf8")), { reverted: [] });
});
