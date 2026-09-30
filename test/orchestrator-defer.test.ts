/** Unit-tier coverage for the orchestrator's backlog-aware deferral (src/orchestrator.ts's
 * scheduling pass) — the contracts the gating `npm test` never pinned: the deferral block and
 * its once-mode settle ran only in the e2e tier, so `npm test` (the declared check) reported
 * the block uncovered even though the behavior was verified. Two rules live here:
 *
 * - Need over idleness: a due maintenance role whose last tick did nothing stays deferred
 *   while the backlog is open — in once mode the deferral is the role's round answer
 *   ("deferred"), the tick_deferred event logs the episode, and no tick runs.
 * - Demand over need: a fresh operator wake (`wokenAt` newer than the last tick's end — the
 *   same predicate isEligible's min-gap exemption keys on) overrides the deferral; an explicit
 *   "try again now" is a demand, not idle maintenance, so the role ticks even with the backlog
 *   open. No other test, unit or e2e, pins this rule.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";
import { loadConfig } from "../src/config.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop-state.js";
import { readBranchHead } from "../src/git.js";
import { FAST_POLL_MS, makeFastRepo } from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";
import { eventsOfType } from "./log-fixtures.js";

/** Run one once round in-process with the repo's on-disk config, failing loudly if the round
 * does not exit on its own — the same guard orchestrator-once.test.ts applies (a once round
 * that hangs is the bug `--once` exists to avoid). */
function onceRound(
  repo: string,
): Promise<{ restart: boolean; settled?: ReadonlyMap<string, string>; ticksRun?: ReadonlyMap<string, number> }> {
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: new AbortController().signal,
    pollMs: FAST_POLL_MS,
    once: true,
  });
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("once round did not exit on its own")), 30_000);
    t.unref();
  });
  return Promise.race([done, timeout]);
}

/** The state a finished no_change tick on the current main head leaves on disk, due now. */
function idleDueState(repo: string) {
  return {
    ...freshLoopState("clean"),
    ticks: 1,
    lastResult: "no_change" as const,
    lastMainHead: readBranchHead(repo, "main") ?? "",
    nextRunAt: Date.now() - 1000, // due: the deferral, not the clock, keeps it from running
  };
}

/** An open backlog on disk: one entry under PLANS.md `## Planned`. */
function openBacklog(repo: string): void {
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    "# Plans\n\n## Planned\n\n### a queued feature (planned 2026-09-30)\n",
  );
}

test("once: a due maintenance role with an open backlog settles as deferred, runs no tick, and logs the episode", async () => {
  const repo = await makeFastRepo("once unit deferral test", ["clean"]);
  openBacklog(repo);
  saveLoopState(repo, idleDueState(repo));
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "deferred", "the deferral is the role's round answer, not idle");
    assert.equal(exit.ticksRun?.get("clean"), 0, "the deferred role ran no tick");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "nothing ticked past the seeded history");
    assert.deepEqual(
      eventsOfType(repo, "tick_deferred").map((e) => e.loop),
      ["clean"],
      "the deferral is logged once on the transition in, not silent",
    );
  } finally {
    restore();
  }
});

test("once: a fresh operator wake overrides the deferral — the demand ticks despite the open backlog", async () => {
  const repo = await makeFastRepo("once unit wake-override test", ["clean"]);
  openBacklog(repo);
  saveLoopState(repo, {
    ...idleDueState(repo),
    lastTickEndedAt: Date.now() - 60_000,
    wokenAt: Date.now() - 1000, // newer than the last tick's end: an explicit "try again now"
  });
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.ticksRun?.get("clean"), 1, "the demand runs the tick the backlog would have deferred");
    assert.equal(loadLoopState(repo, "clean").ticks, 2, "the tick really ran");
    assert.deepEqual(eventsOfType(repo, "tick_deferred"), [], "no deferral episode: the demand preempted it");
  } finally {
    restore();
  }
});
