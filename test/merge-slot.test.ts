/** Unit coverage for src/merge/merge-slot.ts's bookkeeping — the usage accounting that
 * charges a merge's own pi runs (reviewer + conflict resolution) to the AUTHORING role's live
 * state and records them on the merge_done/merge_failed event, the write-back, and the 4/5 marker's
 * per-change records. The full merge flow is pinned end-to-end through the pipeline
 * (orchestrator-fixtures.ts's mergeHead) in the runner and orchestrator tests, but those drive a
 * fake pi that reports no usage, so the nonzero-usage branches were never exercised: a merge whose
 * reviewer burns tokens and cost is exactly what feeds `tumwater report` and the daily budget cap,
 * and a broken fold there would silently lose that spend. These pin the accounting branches
 * directly. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addMergeChange,
  checkWaitStage,
  mergeChanges,
  mergeUsage,
  readMergeMarker,
  removeMergeChange,
  resolveWaitStage,
  setMergeChangeStatus,
  setMergeStage,
  writeMergeMarker,
  writeMergeOutcome,
} from "../src/merge/merge-slot.js";
import { eventsLogPath, mergeRefName, mergeStatePath, statePath } from "../src/paths.js";
import { refSha, setRef } from "../src/git/git.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { applyRunOutcome, ERROR_STREAK_WARN } from "../src/run/run-apply.js";
import { enqueueMerge, headMerge, queueDepth } from "../src/merge/merge-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { warningEvents, warningMessages } from "./fixtures/log-fixtures.js";
import { failRenameSyncOn, withReadOnlyDir } from "./helpers/fs-faults.js";
import { readClaudeAccount } from "../src/agent/claude/claude-account.js";
import type { RoleRunner } from "../src/runner/runner.js";
import type { MergeEntry } from "../src/merge/merge-queue.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import { mergeHead } from "./fixtures/orchestrator-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { makeRepo, pinOffMain, tmpdir } from "./fixtures/repo-fixtures.js";
import { checkRunNumber } from "./fixtures/merger-fixtures.js";
import { piRunResult } from "./fakes/fake-pi.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// These tests pin the sequential merge stages (the check, then the review).
process.env.TUMWATER_REVIEW_CHECK_OVERLAP = "0";

/** A minimal successful pi run carrying the given usage — only the fields the fold reads matter,
 * but PiRunResult is fully required, so the rest are neutral defaults. */
function piRun(outputTokens: number, costUsd: number): PiRunResult {
  return piRunResult({ outputTokens, costUsd });
}

/** Queue one merge in a fresh repo and return its entry plus the file a drop removes. */
function queued(root: string, role = "improve"): { entry: MergeEntry; file: string } {
  const entry: MergeEntry = { role, sha: "a".repeat(40), run: 3, summary: "add a thing", enqueuedAt: Date.now() };
  enqueueMerge(root, entry);
  const head = headMerge(root);
  assert.ok(head, "fixture sanity: the merge is queued");
  return head;
}

test("mergeUsage charges each run to both the authoring role and the merge's own accumulator", () => {
  const folded: PiRunResult[] = [];
  // mergeUsage keys the reviewer's fold by the review seam (PLANS.md "Mixed claude + pi
  // fleets, part 2/4"), so the stub author must carry a config; these tests don't assert on
  // the stamp, only on the cost/token accounting, so a default config is enough.
  const author = { foldMergeUsage: (run: PiRunResult) => folded.push(run), config: defaultConfig() } as unknown as RoleRunner;
  const { usage, foldUsage } = mergeUsage(author, tmpdir());

  foldUsage(piRun(120, 0.5));
  foldUsage(piRun(80, 0.5));

  assert.deepEqual(
    folded.map((r) => r.outputTokens),
    [120, 80],
    "every merge pi run reaches the authoring role's fold",
  );
  assert.equal(usage.tokens, 200, "and the merge's own accumulator sums its tokens");
  assert.equal(usage.cost, 1, "…and its cost");
});

// A subscription-paid merge is API-equivalent notional spend, never real money the daily cap
// charges (plans/agent-backends.md part 6a): its cost rides the merge_done event's notional field
// and its real field stays empty.
test("a subscription merge run folds as notional, and rides the event's notional field", () => {
  const root = makeRepo();
  const author = { foldMergeUsage: () => {}, config: defaultConfig() } as unknown as RoleRunner;
  const { usage, foldUsage } = mergeUsage(author, tmpdir());
  foldUsage(piRunResult({ outputTokens: 100, costUsd: 0.3, billing: "subscription" }));
  foldUsage(piRunResult({ outputTokens: 20, costUsd: 0.1, billing: "api" }));

  assert.equal(usage.cost, 0.1, "only the API run is real spend");
  assert.equal(usage.notionalCost, 0.3, "the subscription run is notional");

  const { entry, file } = queued(root);
  const state = freshRunnerState("improve");
  writeMergeOutcome(root, entry, state, "changed", 7, usage, file);

  const mergeDone = readEvents(root, 10).find((e) => e.type === "merge_done");
  assert.ok(mergeDone, "the merge logged a merge_done event");
  assert.equal(mergeDone.costUsd, 0.1, "the event's cost is the real share only");
  assert.equal(mergeDone.notionalCostUsd, 0.3, "the subscription share is notional");
});

// A claude reviewer's (or resolver's) five-hour window must reach claude-account.json when the
// merge fold sees it, not wait for the pi author's next run end — otherwise a mixed team's
// reviewer readings are lost every time (PLANS.md "Mixed claude + pi fleets, part 3/4"). The
// fold is best-effort like run-finalize.ts's: a run with no billing/window reading leaves the
// file untouched.
test("a merge run's five_hour reading reaches claude-account.json at fold time", () => {
  const root = makeRepo();
  const author = { foldMergeUsage: () => {}, config: defaultConfig() } as unknown as RoleRunner;
  const { foldUsage } = mergeUsage(author, root);

  assert.equal(readClaudeAccount(root), null, "no account file before any reading");
  foldUsage(
    piRunResult({
      agent: "claude",
      outputTokens: 100,
      costUsd: 0.3,
      billing: "subscription",
      rateWindows: [{ type: "five_hour", status: "allowed", utilization: 0.4 }],
    }),
  );

  const account = readClaudeAccount(root);
  assert.ok(account, "the fold wrote the account file");
  assert.equal(account.billing, "subscription", "the run's billing answer is recorded");
  assert.equal(account.windows.five_hour?.status, "allowed", "the five_hour reading is recorded");
  assert.equal(account.windows.five_hour?.utilization, 0.4);
});

test("a merge's nonzero usage rides its merge_done event and the entry is dropped", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshRunnerState("improve");
  state.phase = "review"; // an in-flight merge marker from the run lifecycle
  state.runs = entry.run;

  writeMergeOutcome(root, entry, state, "changed", 1234, { tokens: 320, cost: 0.42, providerCost: {} }, file);

  const mergeDone = readEvents(root, 10).find((e) => e.type === "merge_done");
  assert.ok(mergeDone, "the merge logged a merge_done event");
  assert.equal(mergeDone.source, "improve");
  assert.equal(mergeDone.commit, entry.sha);
  assert.equal(mergeDone.result, "changed");
  assert.equal(mergeDone.summary, entry.summary);
  assert.equal(mergeDone.durationMs, 1234);
  assert.equal(typeof mergeDone.queuedMs, "number");
  assert.ok(Number(mergeDone.queuedMs) >= 0 && Number(mergeDone.queuedMs) <= Date.now() - entry.enqueuedAt);
  assert.equal(mergeDone.tokens, 320, "the merge's own tokens are on the event");
  assert.equal(mergeDone.costUsd, 0.42, "…and its own cost");
  assert.equal(state.lastResult, "changed");
  assert.equal(state.commits, 1, "a merged change counts a commit");
  assert.equal(state.phase, undefined, "a non-aborted outcome ends the in-flight phase");
  assert.equal(loadRunnerState(root, "improve").commits, 1, "the folded state is persisted");
  assert.equal(queueDepth(root), 0, "the entry drops after its outcome");
});

test("a review-exempt merge (zero usage) omits the usage fields instead of logging zeros", () => {
  const root = makeRepo();
  const { entry, file } = queued(root, "organize");
  const state = freshRunnerState("organize");

  writeMergeOutcome(root, entry, state, "changed", 5, { tokens: 0, cost: 0, providerCost: {} }, file);

  const mergeDone = readEvents(root, 10).find((e) => e.type === "merge_done");
  assert.ok(mergeDone, "the merge logged a merge_done event");
  assert.ok(!("tokens" in mergeDone), `no tokens key on a zero-usage event: ${JSON.stringify(mergeDone)}`);
  assert.ok(!("costUsd" in mergeDone), `no costUsd key on a zero-usage event: ${JSON.stringify(mergeDone)}`);
});

test("an unwritable events feed still drops the settled entry — the queue never retries", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshRunnerState("improve");
  // A directory at the feed path makes every append throw EISDIR: the merge_done event cannot be
  // written, but the drop (and the marker removal its caller does next) must still happen —
  // otherwise the settled entry stays queued and the next drain re-verifies and re-merges it.
  fs.mkdirSync(eventsLogPath(root), { recursive: true });

  writeMergeOutcome(root, entry, state, "changed", 1000, { tokens: 10, cost: 0.1, providerCost: {} }, file);

  assert.equal(queueDepth(root), 0, "the outcome drops the entry even when its event cannot be logged");
  assert.equal(loadRunnerState(root, "improve").commits, 1, "the state write still persisted before the event");
});

test("a failed role-state save still logs the outcome and drops the settled entry", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshRunnerState("improve");
  const undo = failRenameSyncOn(statePath(root, "improve"), "EACCES fake");
  try {
    writeMergeOutcome(root, entry, state, "changed", 7, { tokens: 0, cost: 0, providerCost: {} }, file);
  } finally {
    undo();
  }

  assert.equal(queueDepth(root), 0, "the entry drops even when the state cannot be saved");
  assert.equal(fs.existsSync(file), false, "the queue file is gone");
  assert.equal(state.commits, 1, "the in-memory state holds the outcome");
  assert.equal(readEvents(root, 10).filter((e) => e.type === "merge_done").length, 1);
  const warnings = warningMessages(root);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /could not save the role's state: EACCES fake/);
});

test("an unexpected throw inside the merge degrades to an error outcome — the queue drains", async () => {
  const root = makeRepo();
  queued(root);
  // A poisoned entry: the sha names no commit anywhere in the repo (a lost pin, a corrupt
  // queue file), so the verification's ensureDetachedWorktree throws before any ref work —
  // exactly the "unexpected throw" the verification degrades (the pipeline's contract: a merge
  // never rejects; every outcome drops the entry; the change's marker record always goes).
  const author = makeRoleRunner(root, "improve");
  const { state } = author;
  state.phase = "review"; // the run lifecycle's in-flight merge marker on the author's state
  assert.ok(await refSha(root, mergeRefName("improve")) === null, "fixture sanity: no pin exists");

  const result = await mergeHead(root, author, defaultConfig(), "improve");

  assert.equal(result, "error", "the throw surfaces as an outcome, never a rejection");
  assert.equal(state.lastResult, "error");
  assert.ok(state.lastError && state.lastError.length > 0, "the error's message lands on the author's state");
  const failed = readEvents(root, 10).find((e) => e.type === "merge_failed");
  assert.ok(failed, "even a throw logs merge_failed");
  assert.equal(failed.result, "error");
  assert.equal(queueDepth(root), 0, "every outcome drops the entry — a poison entry must not wedge the drain");
  assert.equal(await refSha(root, mergeRefName("improve")), null, "no pin existed and the error path fabricates none");
  assert.equal(readMergeMarker(root), null, "the in-flight marker is removed even on the error path");
  assert.equal(loadRunnerState(root, "improve").lastResult, "error", "the outcome is persisted, not just folded in memory");
});

test("the write-back pairs the merge's result with the queued run's summary, across a reload", () => {
  // BUGS.md 2026-09-23: the queued run left the prior last-result pair in place and stashed
  // its own summary; the merge — here resolving in a later process on a disk-loaded state,
  // as a durable queue entry can — records its result beside THAT summary and consumes it.
  const root = makeRepo();
  const { entry, file } = queued(root);
  const runState = freshRunnerState("improve");
  applyRunOutcome(runState, defaultConfig(), "improve", { result: "no_change", summary: "found nothing" });
  applyRunOutcome(runState, defaultConfig(), "improve", {
    result: "queued",
    summary: `${entry.summary} (high friction: 90 turns / 45m)`,
    commit: entry.sha,
  });
  saveRunnerState(root, runState);
  const pending = loadRunnerState(root, "improve");
  assert.equal(pending.lastResult, "no_change", "fixture sanity: the prior pair is what persisted");

  writeMergeOutcome(root, entry, pending, "rejected", 10, { tokens: 0, cost: 0, providerCost: {} }, file);

  const saved = loadRunnerState(root, "improve");
  assert.equal(saved.lastResult, "rejected");
  assert.equal(saved.lastSummary, "add a thing (high friction: 90 turns / 45m)");
  assert.equal(saved.queuedSummary, undefined, "the persisted stash is consumed");
});

test("a rejection crossing the error-streak bar warns from the merge side, once per episode", () => {
  // BUGS.md 2026-09-30: a review rejection resolves AFTER the run's end-save, so the
  // streak-crossing warn belongs to writeMergeOutcome — same bar, same once-per-episode
  // shape the run side (finalizeRun) upholds. The two sites share one episode: a queued
  // run preserves the streak it was given, so a streak the run side already warned at
  // must not warn again here, and a crossing the run side never saw (2 → 3 at the
  // merge) warns from here instead.
  const cfg = defaultConfig();
  const root = makeRepo();
  const warnings = () => warningEvents(readEvents(root, 50));

  // Below the bar: the fast first retries stay silent.
  const low = freshRunnerState("improve");
  const first = queued(root);
  writeMergeOutcome(root, first.entry, low, "rejected", 5, { tokens: 0, cost: 0, providerCost: {} }, first.file);
  assert.equal(low.consecutiveErrors, 1, "the rejection counts even below the bar");
  assert.equal(warnings().length, 0, "a below-bar rejection warns nothing");

  // The crossing the run side never saw: two failed runs, a queued run preserving the
  // streak, then the merge's rejection does 2 → 3.
  const crossing = freshRunnerState("improve");
  applyRunOutcome(crossing, cfg, "improve", { result: "error" });
  applyRunOutcome(crossing, cfg, "improve", { result: "error" });
  applyRunOutcome(crossing, cfg, "improve", { result: "queued", commit: "c" });
  const second = queued(root);
  writeMergeOutcome(root, second.entry, crossing, "rejected", 5, { tokens: 0, cost: 0, providerCost: {} }, second.file);
  assert.equal(crossing.consecutiveErrors, ERROR_STREAK_WARN, "the merge did the crossing");
  const crossed = warnings();
  assert.equal(crossed.length, 1, "the merge-side crossing warns exactly once");
  assert.equal(crossed[0]!.source, "improve");
  assert.match(crossed[0]!.message as string, /^3 runs failed in a row: /);

  // The other half of the invariant: a rejection merge onto a streak the episode already
  // warned at (preserved across the queued run at the bar) must not warn again.
  const third = queued(root);
  applyRunOutcome(crossing, cfg, "improve", { result: "queued", commit: third.entry.sha });
  writeMergeOutcome(root, third.entry, crossing, "rejected", 5, { tokens: 0, cost: 0, providerCost: {} }, third.file);
  assert.equal(crossing.consecutiveErrors, ERROR_STREAK_WARN + 1);
  assert.equal(warnings().length, 1, "one warning per episode across both warn sites");
});

test("a failed merge logs merge_failed with its usage and counts no commit", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshRunnerState("improve");

  writeMergeOutcome(root, entry, state, "merge_conflict", 900, { tokens: 12, cost: 0.01, providerCost: {} }, file);

  const failed = readEvents(root, 10).find((e) => e.type === "merge_failed");
  assert.ok(failed, "a non-changed outcome logs merge_failed, not merged");
  assert.equal(failed.result, "merge_conflict");
  assert.equal(failed.summary, entry.summary);
  assert.equal(failed.tokens, 12, "spend on a failed merge is still recorded");
  assert.equal(state.lastResult, "merge_conflict");
  assert.equal(state.commits, 0, "a non-changed outcome is not a commit");
  assert.equal(queueDepth(root), 0, "every outcome drops the entry — retry rides the pin, not the queue");
});

test("merge_failed carries the reason mergeFailureReason derives, and omits it otherwise", () => {
  const usage = { tokens: 0, cost: 0, providerCost: {} };
  const run = (result: "rejected" | "merge_blocked" | "merge_conflict" | "changed", setup: (s: ReturnType<typeof freshRunnerState>) => void) => {
    const root = makeRepo();
    const { entry, file } = queued(root);
    const state = freshRunnerState("improve");
    setup(state);
    // A merge window wide enough that the save inside writeMergeOutcome cannot outlast it:
    // a 10ms window put startedAt after a fresh review whenever the save took longer.
    writeMergeOutcome(root, entry, state, result, 5_000, usage, file);
    return readEvents(root, 10).find((e) => e.type === (result === "changed" ? "merge_done" : "merge_failed"))!;
  };
  const rejected = run("rejected", (s) => {
    s.lastReview = { verdict: "reject", reasons: ["no test covers the new flag", "other"], at: Date.now() };
  });
  assert.equal(rejected.reason, "no test covers the new flag");
  const stale = run("rejected", (s) => {
    s.lastReview = { verdict: "reject", reasons: ["old"], at: Date.now() - 60_000 };
  });
  assert.ok(!("reason" in stale), "a review older than the merge is stale");
  const blocked = run("merge_blocked", (s) => {
    s.lastError = "merge failed: merge_blocked — check failed (`npm run test`): ✖ x";
  });
  assert.equal(blocked.reason, "check failed (`npm run test`): ✖ x");
  const conflict = run("merge_conflict", (s) => {
    s.lastError = "merge failed: merge_conflict";
  });
  assert.ok(!("reason" in conflict), "a bare result names no reason");
  assert.ok(!("reason" in run("changed", () => {})));
});

// The merge cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23): the merge path
// advances the marker's stage and the dashboards render it.
test("setMergeStage advances only its own role's record, and only its stage", () => {
  const root = makeRepo();
  // No marker — the shared gate running inside a run (leftover recovery): a no-op that
  // creates nothing; the gate must never invent merge state.
  setMergeStage(root, "clean", "reviewing");
  assert.equal(readMergeMarker(root), null);
  addMergeChange(root, { role: "bugfix", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  const before = readMergeMarker(root)!;
  // Another role's gate (one with no record of its own) must not restage it.
  setMergeStage(root, "clean", "reviewing");
  assert.deepEqual(readMergeMarker(root), before, "a gate with no record changes nothing");
  // The matching role's stage advances; identity (the snapshot cross-check's sha) and the
  // merge's startedAt (the cell's elapsed) are preserved.
  setMergeStage(root, "bugfix", "build-check");
  const after = readMergeMarker(root)!;
  assert.equal(after.changes![0]!.stage, "build-check");
  assert.ok(after.changes![0]!.stageSince! >= before.changes![0]!.stageSince!, "the transition re-stamped stageSince");
  assert.deepEqual([after.role, after.sha, after.startedAt, after.stage], [before.role, before.sha, before.startedAt, "build-check"]);
  // An older generation's one-change marker carries no records: no pipeline change is staged on it.
  const single = { role: "bugfix", sha: "b", summary: "s", startedAt: 2, stage: "merging" } as const;
  writeMergeMarker(root, single);
  setMergeStage(root, "bugfix", "reviewing");
  assert.deepEqual(readMergeMarker(root), single);
});

// The per-stage elapsed (PLANS.md 2026-10-15): each change's record stamps `stageSince` ONCE
// when it enters its current stage — at addMergeChange with its initial `rebasing`, and on
// each setMergeStage transition, leaving an unchanged stage alone.
test("addMergeChange and setMergeStage stamp stageSince on each stage entry", () => {
  const root = makeRepo();
  addMergeChange(root, { role: "alpha", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  const added = readMergeMarker(root)!.changes![0]!;
  assert.equal(added.stageSince, added.startedAt, "the initial rebasing stamps its own start");
  // A transition to another stage moves stageSince with it.
  const before = readMergeMarker(root)!.changes![0]!.stageSince!;
  setMergeStage(root, "alpha", "reviewing");
  const atReview = readMergeMarker(root)!.changes![0]!;
  assert.equal(atReview.stage, "reviewing");
  assert.ok(atReview.stageSince! >= before, "the transition re-stamps the new stage's entry");
  // Re-staging the same stage leaves stageSince alone (the existing unchanged-stage no-op).
  const stamp = readMergeMarker(root)!.changes![0]!.stageSince!;
  setMergeStage(root, "alpha", "reviewing");
  assert.equal(readMergeMarker(root)!.changes![0]!.stageSince, stamp, "an unchanged stage keeps its stamp");
  // A marker that never transitions keeps one stageSince equal to its start.
  const root2 = makeRepo();
  addMergeChange(root2, { role: "beta", sha: "b".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  const b = readMergeMarker(root2)!.changes![0]!;
  assert.equal(b.stageSince, b.startedAt, "a never-transitioned change's stageSince is its start");
  // A foreign stageSince is dropped by isMergeChange rather than read field-by-field.
  fs.writeFileSync(
    mergeStatePath(root2),
    JSON.stringify({
      role: "beta", sha: "b".repeat(40), summary: "s", startedAt: 1, stage: "rebasing", stageSince: "oops",
      changes: [{ role: "beta", sha: "b".repeat(40), summary: "s", status: "merging", stageSince: "oops" }],
    }),
  );
  assert.deepEqual(mergeChanges(readMergeMarker(root2)!).map((c) => c.role), [], "a bad stageSince record reads as absent");
});

// A check parked for its process-wide permit names the wait, not a running check — so a row
// whose check has not started never reads as one that has.
test("checkWaitStage shows check-wait while parked, then build-check once the permit arrives", () => {
  const root = makeRepo();
  addMergeChange(root, { role: "alpha", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  addMergeChange(root, { role: "beta", sha: "b".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set(["alpha"]));
  const stages = () => readMergeMarker(root)!.changes!.map((c) => `${c.role}=${c.stage}`);
  const hooks = checkWaitStage(root, ["alpha", "beta", "delta"]); // delta has no record: a no-op
  hooks.waiting();
  assert.deepEqual(stages(), ["alpha=check-wait", "beta=check-wait"]);
  hooks.granted();
  assert.deepEqual(stages(), ["alpha=build-check", "beta=build-check"]);
});

// The merge's conflict resolver parked for its agent permit names that wait, then resolving once
// granted — checkWaitStage's shape, for one role — so neither reads as the merge's git steps.
test("resolveWaitStage shows resolve-wait while parked, then resolving once the permit arrives", () => {
  const root = makeRepo();
  addMergeChange(root, { role: "alpha", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  addMergeChange(root, { role: "beta", sha: "b".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set(["alpha"]));
  const stages = () => readMergeMarker(root)!.changes!.map((c) => `${c.role}=${c.stage}`);
  const hooks = resolveWaitStage(root, "alpha");
  hooks.waiting();
  assert.deepEqual(stages(), ["alpha=resolve-wait", "beta=rebasing"], "only the resolving change's record moves");
  hooks.granted();
  assert.deepEqual(stages(), ["alpha=resolving", "beta=rebasing"]);
  resolveWaitStage(root, "delta").waiting(); // no record: a no-op
  assert.deepEqual(stages(), ["alpha=resolving", "beta=rebasing"]);
});

// The marker (BUGS.md 2026-09-23) carries one record per change the pipeline holds: each
// verification adds its own, the gates and the merge advance only their change's record, each
// outcome removes it, and the top level follows the first change in flight for observers that read
// only it.
test("the marker's records come and go per change, and its top level follows the first change in flight", () => {
  const root = makeRepo();
  const entries = Object.fromEntries(
    ["alpha", "beta", "gamma"].map((role) => [role, { role, sha: `${role}-sha`, run: 1, summary: `${role} work`, enqueuedAt: 1 }]),
  ) as Record<string, MergeEntry>;
  const records = () => readMergeMarker(root)!.changes!.map((c) => `${c.role}=${c.status}/${c.stage ?? "-"}`);

  // Two verifications at once: each opens its own record, with its own start, at its rebase onto
  // main.
  const before = Date.now();
  addMergeChange(root, entries.alpha!, new Set(["alpha"]));
  addMergeChange(root, entries.beta!, new Set(["alpha", "beta"]));
  setMergeStage(root, "beta", "reviewing");
  setMergeStage(root, "delta", "reviewing"); // no record: a no-op
  assert.deepEqual(records(), ["alpha=merging/rebasing", "beta=merging/reviewing"]);
  assert.ok(readMergeMarker(root)!.changes![0]!.startedAt! >= before, "the change's own start");
  assert.equal(readMergeMarker(root)!.role, "alpha", "the top level names the first change in flight");
  assert.equal(readMergeMarker(root)!.stage, "rebasing", "at that change's own stage");

  // alpha's verification approves it: it waits for the merge, and beta, still under review, becomes
  // the top level — with its own start and its own stage.
  setMergeStage(root, "alpha", "merging");
  setMergeChangeStatus(root, "alpha", "approved");
  const marker = readMergeMarker(root)!;
  assert.deepEqual(
    [marker.role, marker.sha, marker.stage, marker.startedAt],
    ["beta", "beta-sha", "reviewing", marker.changes![1]!.startedAt],
  );

  // A record the pipeline no longer holds (a crashed generation's) never rides along.
  addMergeChange(root, entries.gamma!, new Set(["beta", "gamma"]));
  assert.deepEqual(records(), ["beta=merging/reviewing", "gamma=merging/rebasing"]);
  addMergeChange(root, entries.alpha!, new Set(["alpha", "beta", "gamma"]));

  // The merge reaches alpha: re-entering `merging` keeps its first start and restages it
  // `merging` — the merge slot's own stage.
  const alphaStart = readMergeMarker(root)!.changes!.find((c) => c.role === "alpha")!.startedAt;
  setMergeChangeStatus(root, "alpha", "approved");
  setMergeChangeStatus(root, "alpha", "merging");
  const alpha = readMergeMarker(root)!.changes!.find((c) => c.role === "alpha")!;
  assert.equal(alpha.stage, "merging");
  assert.equal(alpha.startedAt, alphaStart, "the elapsed keeps counting from the verification's start");

  // Each outcome removes its record; the last one takes the marker with it.
  removeMergeChange(root, "beta");
  removeMergeChange(root, "delta"); // no record: a no-op
  assert.deepEqual(mergeChanges(readMergeMarker(root)!).map((c) => c.role), ["gamma", "alpha"]);
  removeMergeChange(root, "gamma");
  removeMergeChange(root, "alpha");
  assert.equal(readMergeMarker(root), null, "the marker goes with its last record");
});

// mergeChanges reads the shapes every generation wrote: an older generation's one-change
// marker is one `merging` record at the marker's stage.
test("mergeChanges reads a one-change marker as one merge record", () => {
  const single = { role: "clean", sha: "c", summary: "s", startedAt: 5, stage: "reviewing" } as const;
  assert.deepEqual(mergeChanges(single), [{ ...single, status: "merging" }]);
  // A top-level stageSince (a newer generation's one-change marker) rides the legacy record;
  // without one, the record carries none — backward compatible with the old generation.
  const withSince = { ...single, stageSince: 6 } as const;
  assert.equal(mergeChanges(withSince)[0]!.stageSince, 6, "a top-level stageSince rides the legacy record");
  assert.equal(mergeChanges(single)[0]!.stageSince, undefined);
});

test("a foreign changes shape or a null record degrades instead of crashing a merge", () => {
  const root = makeRepo();
  // `changes` present but not an array: as unusable as an absent field. The reads fall back to
  // the legacy top-level shape and the writers no-op — never `scalar.find`.
  writeFileDeep(mergeStatePath(root),
    JSON.stringify({ role: "improve", sha: "a", summary: "s", startedAt: 1, changes: "oops" }),
  );
  assert.doesNotThrow(() => setMergeChangeStatus(root, "improve", "approved"));
  assert.deepEqual(mergeChanges(readMergeMarker(root)!).map((c) => c.role), ["improve"]);

  // A record array carrying a null entry: the bad entries read as absent and the good one still
  // advances, so the pipeline and the observers keep working.
  fs.writeFileSync(
    mergeStatePath(root),
    JSON.stringify({
      role: "x",
      sha: "x",
      summary: "x",
      startedAt: 1,
      changes: [null, { role: "y", sha: "y".repeat(40), summary: "s", status: "merging" }],
    }),
  );
  assert.doesNotThrow(() => setMergeChangeStatus(root, "y", "approved"));
  const after = mergeChanges(readMergeMarker(root)!);
  assert.deepEqual(after.map((c) => c.role), ["y"]);
  assert.equal(after[0]!.status, "approved");
});

test("a queued merge's record names each phase while it runs: the gate's check, then the merge's in-lock check", async () => {
  const root = makeRepo();
  // A pinned change ahead of main, exactly what a run leaves behind for the pipeline.
  const sha = pinOffMain(
    root,
    (d) => fs.appendFileSync(path.join(d, "seed.txt"), "the work\n"),
    "the work",
  );
  await setRef(root, mergeRefName("improve"), sha);
  const entry: MergeEntry = { role: "improve", sha, run: 3, summary: "the work", enqueuedAt: Date.now() };
  enqueueMerge(root, entry);

  // Every observation point appends the marker's stage as the observers would read it: the
  // project's declared check runs the verification's gate pre-check, then the merge's in-lock
  // re-check. With no pre-merge reviewer, the deterministic gate approves on the green pre-check
  // and every merged commit is reviewed after landing (part 3d/3). The check itself moves main
  // by a code file, so the in-lock re-check has a rebased tree to verify — the merge step's own
  // long phase, which names itself a build check too. (An empty or doc-only move would leave the
  // verified tree's bytes, plus at most exempt paths, and the re-check would rightly be skipped.)
  const rec = path.join(tmpdir(), "stages");
  const stageOf = `sed -n 's/.*"stage": *"\\([a-z-]*\\)".*/\\1/p' '${mergeStatePath(root)}' | head -n 1`;
  // Run 1 of the declared check is the gate pre-check, run 2 the merge's in-lock re-check, so the
  // check moves main only on run 1: a second main move under the merge would leave the merge's
  // fast-forward target behind main and block it (the gate's own pre-check already moved main once
  // here so the in-lock re-check has a rebased tree to verify).
  const checkCount = path.join(root, ".checkcount");
  const config = {
    ...defaultConfig(),
    check: {
      command: `${checkRunNumber(checkCount)}if [ "$n" -eq 1 ]; then echo moved >> '${root}/main-moved.txt'; git -C '${root}' add main-moved.txt; git -C '${root}' commit -q -m 'main moves under the merge'; fi; echo "check:$(${stageOf})" >> '${rec}'`,
    },
  };
  const author = makeRoleRunner(root, "improve", config);

  const result = await mergeHead(root, author, config, "improve");

  assert.equal(result, "changed", `the merge succeeds: ${author.state.lastError ?? ""}`);
  assert.deepEqual(
    fs.readFileSync(rec, "utf8").trim().split("\n"),
    ["check:build-check", "check:build-check"],
    "the gate pre-check and the in-lock re-check each ran under their own stage",
  );
  assert.equal(readMergeMarker(root), null, "the marker is removed after the outcome");
});

// The marker is cross-process display state: observers poll it every second while a pipeline
// that can crash, redeploy, or fail its writes advances it. Reads see it missing, torn, or in
// an older generation's shape, and its writes can fail under them — these pin the no-op and
// degrade paths the module promises ("never throws").
test("setMergeChangeStatus and removeMergeChange no-op when the marker is absent or shapeless", () => {
  const root = makeRepo();
  // No marker file: neither call may invent one.
  setMergeChangeStatus(root, "improve", "approved");
  removeMergeChange(root, "improve");
  assert.equal(readMergeMarker(root), null, "no marker was invented");
  // A marker an older generation wrote carries no per-change records: there is no record to
  // advance, and the file is left exactly as it was.
  const legacy = { role: "improve", sha: "b", summary: "s", startedAt: 2, stage: "merging" } as const;
  writeMergeMarker(root, legacy);
  setMergeChangeStatus(root, "improve", "approved");
  assert.deepEqual(readMergeMarker(root), legacy, "a shapeless marker is untouched");
});

test("a kept legacy record without startedAt or stage never leaves the top level undefined", () => {
  const root = makeRepo();
  addMergeChange(root, { role: "beta", sha: "b".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  // Overwrite with a marker an older generation wrote: a merge record with no startedAt and
  // no stage of its own (the documented old shape).
  fs.writeFileSync(
    mergeStatePath(root),
    JSON.stringify({
      role: "beta",
      sha: "b".repeat(40),
      summary: "s",
      startedAt: 7,
      changes: [{ role: "beta", sha: "b".repeat(40), summary: "s", status: "merging" }],
    }),
  );
  // The next change's verification starts while beta still holds a record: the legacy record is
  // kept (its role is live) and becomes the headline — its missing fields must not write
  // `undefined` over the top level the observers read.
  addMergeChange(root, { role: "alpha", sha: "a".repeat(40), run: 2, summary: "s2", enqueuedAt: 1 }, new Set(["beta"]));
  const marker = readMergeMarker(root)!;
  assert.equal(marker.stage, "merging", "a stageless headline reads at the default stage");
  assert.equal(typeof marker.startedAt, "number", "a startless headline did not erase the marker's start");
  assert.deepEqual(marker.changes!.map((c) => c.role), ["beta", "alpha"], "the legacy record is kept");
});

test("a marker whose top level lost its stage falls back to merging on the next rewrite", () => {
  const root = makeRepo();
  addMergeChange(root, { role: "alpha", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  // A marker an older generation wrote: per-change records, but no top-level stage (the bare
  // elapsed label). The next status move rewrites it — the write must name a stage, not
  // propagate the missing one.
  fs.writeFileSync(
    mergeStatePath(root),
    JSON.stringify({
      role: "alpha",
      sha: "a".repeat(40),
      summary: "s",
      startedAt: 5,
      changes: [{ role: "alpha", sha: "a".repeat(40), summary: "s", status: "approved" }],
    }),
  );
  setMergeChangeStatus(root, "alpha", "done");
  const marker = readMergeMarker(root)!;
  assert.equal(marker.stage, "merging", "the rewritten marker names a stage again");
  assert.equal(marker.changes![0]!.status, "done");
});

test("a failing marker write never throws — the merge proceeds and the old frame stays", () => {
  const root = makeRepo();
  addMergeChange(root, { role: "improve", sha: "a".repeat(40), run: 1, summary: "s", enqueuedAt: 1 }, new Set());
  const before = readMergeMarker(root)!;
  // The state directory gone read-only: the atomic write cannot create its tmp file. The
  // marker is display-only, so the call must swallow the failure rather than fail a merge.
  const dir = path.dirname(mergeStatePath(root));
  withReadOnlyDir(dir, () => assert.doesNotThrow(() => setMergeStage(root, "improve", "reviewing")));
  assert.deepEqual(readMergeMarker(root), before, "the observers keep the previous frame");
});

test("a merge_failed outcome carries queuedMs too", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshRunnerState("improve");

  writeMergeOutcome(root, entry, state, "rejected", 10, { tokens: 0, cost: 0, providerCost: {} }, file);

  const failed = readEvents(root, 10).find((e) => e.type === "merge_failed");
  assert.ok(failed, "the merge logged a merge_failed event");
  assert.ok(Number(failed.queuedMs) >= 0 && Number(failed.queuedMs) <= Date.now() - entry.enqueuedAt);
});
