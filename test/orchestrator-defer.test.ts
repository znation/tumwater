/** Unit-tier coverage for the orchestrator's backlog-aware deferral (src/orchestrator.ts's
 * scheduling pass) — the contracts the gating `npm test` never pinned: the deferral block and
 * its once-mode settle ran only in the e2e tier, so `npm test` (the declared check) reported
 * the block uncovered even though the behavior was verified. The rules live here:
 *
 * - Need over idleness: a due maintenance role whose last tick did nothing stays deferred
 *   while the backlog is open — in once mode the deferral is the role's round answer
 *   ("deferred"), the tick_deferred event logs the episode, and no tick runs.
 * - Demand over need: a fresh operator wake (`wokenAt` newer than the last tick's end — the
 *   same predicate isEligible's min-gap exemption keys on) overrides the deferral; an explicit
 *   "try again now" is a demand, not idle maintenance, so the role ticks even with the backlog
 *   open. No other test, unit or e2e, pins this rule.
 * - Episodes end and restart cleanly: across a live run's polls, a queued prompt that makes a
 *   deferred role due via its inbox silently ends the deferral episode (no event — the tick
 *   itself is the answer), and the next scheduled deferral is a NEW episode that logs again.
 * - Search mode: bugfix is not a maintenance role, but while BUGS.md `## Open` is empty it
 *   defers like one — keyed on the work-landed verdict ALONE (the backlog-open shortcut must
 *   not stand in for the git-range query), so an idle search tick with nothing new on main
 *   waits and an empty backlog never blocks it from ticking once work has landed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop-state.js";
import { readBranchHead } from "../src/git/git.js";
import { queuedRolePromptCount } from "../src/inbox/inbox.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import {
  awaitSettledTick,
  makeFastRepo,
  onceRound,
  startIdleOrchestrator,
  stopOrchestrator,
} from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";
import { eventsOfType } from "./log-fixtures.js";
import { waitFor } from "./wait.js";

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

test("once: bugfix in search mode defers on the work-landed verdict alone, backlog or none", async () => {
  const repo = await makeFastRepo("once search-mode deferral test", ["bugfix"]);
  // The backlog is left at initProject's empty template: BUGS.md `## Open` and PLANS.md
  // `## Planned` both empty, so workBacklogOpen is false and the deferral rests entirely on
  // the work-landed query — the seeded state's lastMainHead IS main's head, so nothing has
  // landed since the idle tick and the search waits. The seed must carry the bugfix role
  // itself: saveLoopState keys the state file off the state's role field.
  saveLoopState(repo, { ...idleDueState(repo), role: "bugfix" });
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(
      exit.settled?.get("bugfix"),
      "deferred",
      "an idle search tick with nothing new on main defers even with the backlog empty",
    );
    assert.equal(exit.ticksRun?.get("bugfix"), 0, "the searching bugfix ran no tick");
    assert.equal(loadLoopState(repo, "bugfix").ticks, 1, "nothing ticked past the seeded history");
    assert.deepEqual(
      eventsOfType(repo, "tick_deferred").map((e) => e.loop),
      ["bugfix"],
      "the search-mode deferral logs its episode like any other",
    );
  } finally {
    restore();
  }
});

test("live: an inbox demand ends a deferral episode silently, and the next deferral logs a fresh episode", async () => {
  const repo = await makeFastRepo("deferral episode reset test", ["clean"]);
  openBacklog(repo);
  saveLoopState(repo, idleDueState(repo));
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Episode one: the backlog defers the due maintenance tick and the event logs once.
    await waitFor(() => eventsOfType(repo, "tick_deferred").length >= 1, "the first deferral episode");

    // A queued prompt makes the role due via its inbox — the demand runs the tick the
    // backlog would have kept deferred, announced by a wake (reason inbox).
    submitRolePrompt(repo, "clean", "an explicit demand");
    await awaitSettledTick(repo, "clean", 2, "the demand's tick to finish");
    const wake = eventsOfType(repo, "wake").find((e) => e.loop === "clean");
    assert.ok(wake, "the demand is announced with a wake event");
    assert.equal(wake?.reason, "inbox");
    assert.equal(queuedRolePromptCount(repo, "clean"), 0, "the tick consumed the queued prompt");

    // The demand silently ended episode one. With the backlog still open, the role's next
    // scheduled tick defers again — and that fresh episode logs its own tick_deferred: the
    // stale in-memory episode flag must not swallow it.
    await waitFor(() => eventsOfType(repo, "tick_deferred").length >= 2, "the fresh deferral episode");
    assert.equal(loadLoopState(repo, "clean").ticks, 2, "still deferred: the backlog holds");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
