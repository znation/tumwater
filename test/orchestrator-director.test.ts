/** Unit-tier coverage for the live orchestrator's scheduling pass (src/orchestrator.ts) — the
 * director's two exemptions and the merge-queue interlock, contracts the gating `npm test`
 * never pinned (the same approach orchestrator-defer.test.ts takes: the block ran only in the
 * e2e tier, so the unit suite reported it uncovered even though the behavior was verified):
 *
 * - No permit for the director: `tumwater prompt` queues a director request and the director
 *   runs it immediately — the scheduling pass creates the director's task with no-op
 *   acquire/release closures (`usesSlot = role !== DIRECTOR_ROLE`), so it never queues behind
 *   maxConcurrent. Pinned with a slot-holding role tick: with one permit and a role pi that
 *   holds it for minutes, the director's own pi run still sees two loops in flight.
 * - No fleet gate for the director: an operator pause (`tumwater pause`, the marker file)
 *   holds every role's next tick but exempts the director — an explicit human prompt outranks
 *   the pause. The director ticks while the paused role never starts one.
 * - Merge queue 3/5 interlock: a role with a queued landing starts no new tick until the
 *   landing ends — the poll lists the queue once and skips that role's reservation. Pinned by
 *   prompt order: the queued change's review run (its summary is in the reviewer's prompt)
 *   completes before the role's own tick prompt runs.
 * - The restart hand-off's deadline: a self-redeploy with an in-flight landing and no role
 *   tick waits only handoffLandingWindowMs for it, then aborts it and exits — the drain's
 *   abort callback (the shutdown path's last resort), which only the e2e tier exercised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { loadLoopState } from "../src/loop-state.js";
import { enqueueLanding, queueDepth } from "../src/landing/landing-queue.js";
import { pauseFleet } from "../src/fleet-state.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import {
  FAST_POLL_MS,
  awaitSettledTick,
  makeFastRepo,
  scriptedRedeployer,
  startLiveOrchestrator,
  startRedeployRun,
  stopOrchestrator,
} from "./orchestrator-fixtures.js";
import { fakePi, fakePiIdle, logPromptsTo, readPromptRuns } from "./fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { eventsOfType } from "./log-fixtures.js";
import { waitFor } from "./wait.js";
import { sh, tmpdir } from "./repo-fixtures.js";
import { ownerAliveSh } from "./victim-fixture.js";

/** The session name (pi's `-n` value) of a run block recorded by logPromptsTo: the line after
 * the `-n` flag. Empty when the block records no session. */
function sessionOf(block: string): string {
  const lines = block.split("\n");
  const i = lines.indexOf("-n");
  return i >= 0 && i + 1 < lines.length ? lines[i + 1]! : "";
}

/** A fake pi that records every run's argv (logPromptsTo) and replies with the standard
 * nothing-to-do line: the interlock test's reviewer and role pi in one shim. */
function recordingIdlePi(log: string): () => void {
  return fakePi(`${logPromptsTo(log)}\nprintf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
}

/** One real commit that main does not hold, for a queued landing to vet: a side branch off
 * main with one file added, checked back out to main. Returns the commit's sha. */
function shaOnSideBranch(repo: string): string {
  const g = (args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(["checkout", "-b", "interlock-fixture"]);
  fs.writeFileSync(path.join(repo, "interlock-note.txt"), "queued landing fixture\n");
  g(["add", "interlock-note.txt"]);
  g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "interlock fixture change"]);
  const sha = g(["rev-parse", "HEAD"]);
  g(["checkout", "main"]);
  return sha;
}

test("director: a queued prompt runs without a permit even while the only slot is held", async () => {
  const repo = await makeFastRepo("director slot exemption test", ["clean", "director"]);
  saveConfig(repo, { ...loadConfig(repo), maxConcurrent: 1 });
  const runDir = tmpdir("director-slot-");
  const samples = path.join(runDir, "samples.log");
  // The role's run takes the fleet's one permit and holds it for minutes; the director's run
  // waits for that lock file (proof the role holds the slot), samples the in-flight count
  // with its own lock held, and only then replies — so a count of 2 is direct evidence the
  // director's pi ran beside the permit holder instead of behind it.
  const script = [
    `d='${runDir}'`,
    `prev=""; n=""`,
    `for a in "$@"; do if [ "$prev" = "-n" ]; then n="$a"; fi; prev="$a"; done`,
    `case "$n" in`,
    `  tumwater-director-*)`,
    `    while [ ! -f "$d/role.lock" ] && ${ownerAliveSh()}; do sleep 0.05; done`,
    `    touch "$d/dir.lock"`,
    `    c=0; for x in "$d"/*.lock; do c=$((c+1)); done`,
    `    echo "director:$c" >> "$d/samples.log"`,
    `    rm -f "$d/dir.lock"`,
    `    printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    `    ;;`,
    `  *)`,
    `    touch "$d/role.lock"`,
    `    c=0; for x in "$d"/*.lock; do c=$((c+1)); done`,
    `    echo "clean:$c" >> "$d/samples.log"`,
    `    sleep 300`,
    `    ;;`,
    `esac`,
  ].join("\n");
  const restore = fakePi(script);
  submitRolePrompt(repo, "director", "what is the fleet working on?");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledTick(repo, "director", 1, "the director's prompt tick");
    const samplesText = () => {
      try {
        return fs.readFileSync(samples, "utf8");
      } catch {
        return "";
      }
    };
    await waitFor(() => samplesText().includes("director:2"), "the director's run sampling two loops in flight");
    assert.equal(loadLoopState(repo, "director").ticks, 1, "the director ticked once");
    assert.equal(loadLoopState(repo, "clean").running, true, "the role tick still holds the only permit");
    assert.equal(
      eventsOfType(repo, "tick_end").some((e) => e.loop === "clean"),
      false,
      "the permit holder is still mid-tick while the director finishes",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("director: a fleet pause holds role ticks but not the director's queued prompt", async () => {
  const repo = await makeFastRepo("director pause exemption test", ["clean", "director"]);
  assert.equal(pauseFleet(repo), true, "the fleet pause marker is standing before the run starts");
  const restore = fakePiIdle();
  submitRolePrompt(repo, "director", "summarize the fleet's state");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledTick(repo, "director", 1, "the director's prompt tick under the pause");
    assert.equal(loadLoopState(repo, "director").ticks, 1, "the director ticked despite the pause");
    assert.equal(
      eventsOfType(repo, "tick_start").some((e) => e.loop === "clean"),
      false,
      "the paused role started no tick",
    );
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "the paused role ran nothing");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("merge queue interlock: a role with a queued landing starts no tick until the landing ends", async () => {
  const repo = await makeFastRepo("merge queue interlock test", ["clean"]);
  const log = path.join(tmpdir(), "interlock-prompts.log");
  const restore = recordingIdlePi(log);
  // A queued change main does not hold: its vet runs a real review run (the idle reply has no
  // verdict, so the landing ends rejected and the entry is dropped), and until that outcome
  // the interlock must keep clean's own tick from starting.
  enqueueLanding(repo, {
    role: "clean",
    sha: shaOnSideBranch(repo),
    tick: 1,
    summary: "interlock sentinel change",
    enqueuedAt: Date.now(),
  });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => queueDepth(repo) === 0, "the queued landing to settle and drop", 30_000);
    await awaitSettledTick(repo, "clean", 1, "clean's first tick after the interlock released it");
    const runs = readPromptRuns(log);
    const reviewIdx = runs.findIndex((b) => b.includes("interlock sentinel change"));
    const tickIdx = runs.findIndex((b) => sessionOf(b).startsWith("tumwater-clean-"));
    assert.ok(reviewIdx >= 0, "the queued change was vetted with a review run");
    assert.ok(tickIdx >= 0, "clean eventually ran its own tick");
    assert.ok(reviewIdx < tickIdx, "the review ran before the role's tick — the interlock held the role back");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "exactly the post-interlock tick ran");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("restart hand-off: an in-flight landing outliving its deadline is aborted, not waited out", async () => {
  const repo = await makeFastRepo("restart hand-off abort test", ["clean"]);
  const reviewing = path.join(tmpdir(), "handoff-abort-reviewing");
  // The queued change's reviewer run holds the landing in flight (a minute-long review); the
  // interlock keeps clean itself from ticking, so the vet is the only work the hand-off waits
  // on — the drain's bounded wait, then its abort callback, is what this pins.
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${reviewing}'; exec sleep 60;; esac; done`,
  );
  enqueueLanding(repo, {
    role: "clean",
    sha: shaOnSideBranch(repo),
    tick: 1,
    summary: "hand-off sentinel change",
    enqueuedAt: Date.now(),
  });
  // Staleness is re-evaluated only when main moves: stale once the reviewer is running, and
  // the test moves main then — the restart lands mid-review, with no role tick in flight.
  const { redeployer, swaps } = scriptedRedeployer(repo, { stale: () => fs.existsSync(reviewing) });
  const { run, stop } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffLandingWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(reviewing), "the vet's reviewer run to be in flight");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the vet");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1, "the new build was swapped in");
    assert.ok(
      eventsOfType(repo, "warning").some((e) => /outlived its .*deadline/.test(String(e.message))),
      "the hand-off announced the lapse before stopping",
    );
    assert.deepEqual(
      eventsOfType(repo, "land_failed").map((e) => `${e.loop}:${String(e.result)}`),
      ["clean:aborted"],
      "the outlived landing ended aborted, not merged",
    );
  } finally {
    await stop();
    restore();
  }
});
