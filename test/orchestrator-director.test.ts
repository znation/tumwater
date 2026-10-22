/** Unit-tier coverage for the live orchestrator's scheduling pass
 * (src/orchestrator/orchestrator.ts) — the
 * director's two exemptions and the merge-queue interlock, contracts the gating `npm test`
 * never pinned (the same approach orchestrator-defer.test.ts takes: the block ran only in the
 * e2e tier, so the unit suite reported it uncovered even though the behavior was verified):
 *
 * - No permit for the director: `tumwater prompt` queues a director request and the director
 *   runs it immediately — the scheduling pass creates the director's task with no-op
 *   acquire/release closures (`usesSlot = role !== DIRECTOR_ROLE`), so it never queues behind
 *   maxConcurrent. Pinned with a slot-holding role run: with one permit and a role pi that
 *   holds it for minutes, the director's own pi run still sees two roles in flight.
 * - No team gate for the director: an operator pause (`tumwater pause`, the marker file)
 *   holds every role's next run but exempts the director — an explicit human prompt outranks
 *   the pause. The director runs while the paused role never starts one.
 * - Merge queue 3/5 interlock: a role with a queued merge starts no new run until the
 *   merge ends — the poll lists the queue once and skips that role's reservation. Pinned by
 *   prompt order: the queued change's review run (its summary is in the reviewer's prompt)
 *   completes before the role's own run prompt runs.
 * - The restart hand-off's deadline: a self-redeploy with an in-flight merge and no role
 *   run waits only handoffMergeWindowMs for it, then aborts it and exits — the drain's
 *   abort callback (the shutdown path's last resort), which only the e2e tier exercised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { enqueueMerge, queueDepth } from "../src/merge/merge-queue.js";
import { pauseTeam } from "../src/team/team-state.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import {
  FAST_POLL_MS,
  awaitSettledRun,
  makeFastRepo,
  onceRound,
  scriptedRedeployer,
  startLiveOrchestrator,
  startRedeployRun,
  stopOrchestrator,
} from "./fixtures/orchestrator-fixtures.js";
import { fakePi, fakePiIdle, logPromptsTo, readRunBlocks } from "./fakes/fake-pi.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { waitFor } from "./helpers/wait.js";
import { setRef } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { ownerAliveSh } from "./fixtures/victim-fixture.js";

// A failed review retries in place (src/review/review.ts); the pause between tries is not tested.
process.env.TUMWATER_REVIEW_RETRY_DELAY_MS = "0";

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

/** One real commit that main does not hold, for a queued merge to verify: a side branch off
 * main with one file added, checked back out to main. Returns the commit's sha. */
function shaOnSideBranch(repo: string): string {
  const g = (args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(["checkout", "-b", "interlock-fixture"]);
  fs.writeFileSync(path.join(repo, "interlock-note.txt"), "queued merge fixture\n");
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
  // The role's run takes the team's one permit and holds it for minutes; the director's run
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
  submitRolePrompt(repo, "director", "what is the team working on?");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "director", 1, "the director's prompt run");
    const samplesText = () => {
      try {
        return fs.readFileSync(samples, "utf8");
      } catch {
        return "";
      }
    };
    await waitFor(() => samplesText().includes("director:2"), "the director's run sampling two roles in flight");
    assert.equal(loadRunnerState(repo, "director").runs, 1, "the director ran once");
    assert.equal(loadRunnerState(repo, "clean").running, true, "the role run still holds the only permit");
    assert.equal(
      eventsOfType(repo, "run_end").some((e) => e.source === "clean"),
      false,
      "the permit holder is still mid-run while the director finishes",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("director: once recovers a kept merge pin and drains the queue before exit", async () => {
  const repo = await makeFastRepo("once director leftover", ["director"]);
  const sha = pinOffMain(repo, (d) => fs.writeFileSync(path.join(d, "kept.txt"), "kept\n"), "kept director change");
  await setRef(repo, mergeRefName("director"), sha);
  // A reviewer that rejects ends the merge rejected; an idle reply is a review_error, which the
  // pipeline re-queues after 60 s and a once round would wait for.
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: reject")}'; exit 0;; esac; done\n` +
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  );
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.runsDone?.get("director"), 1, "the director got its recovery run");
    assert.ok(eventsOfType(repo, "merge_queued").some((e) => e.commit === sha), "the pin was re-queued");
    assert.equal(queueDepth(repo), 0, "the merge queue drained before exit");
    assert.equal(eventsOfType(repo, "prompt_taken").length, 0);
  } finally {
    restore();
  }
});

test("director: a team pause holds role runs but not the director's queued prompt", async () => {
  const repo = await makeFastRepo("director pause exemption test", ["clean", "director"]);
  assert.equal(pauseTeam(repo), true, "the team pause marker is standing before the run starts");
  const restore = fakePiIdle();
  submitRolePrompt(repo, "director", "summarize the team's state");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "director", 1, "the director's prompt run under the pause");
    assert.equal(loadRunnerState(repo, "director").runs, 1, "the director ran despite the pause");
    assert.equal(
      eventsOfType(repo, "run_start").some((e) => e.source === "clean"),
      false,
      "the paused role started no run",
    );
    assert.equal(loadRunnerState(repo, "clean").runs, 0, "the paused role ran nothing");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("merge queue interlock: a role with a queued merge starts no run until the merge ends", async () => {
  const repo = await makeFastRepo("merge queue interlock test", ["clean"]);
  const log = path.join(tmpdir(), "interlock-prompts.log");
  const restore = recordingIdlePi(log);
  // A queued change main does not hold: its verify runs a real review run (the idle reply has no
  // verdict, so the merge ends rejected and the entry is dropped), and until that outcome
  // the interlock must keep clean's own run from starting.
  enqueueMerge(repo, {
    role: "clean",
    sha: shaOnSideBranch(repo),
    run: 1,
    summary: "interlock sentinel change",
    enqueuedAt: Date.now(),
  });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => queueDepth(repo) === 0, "the queued merge to settle and drop", 30_000);
    await awaitSettledRun(repo, "clean", 1, "clean's first run after the interlock released it");
    const runs = readRunBlocks(log);
    const reviewIdx = runs.findIndex((b) => b.includes("interlock sentinel change"));
    const runIdx = runs.findIndex((b) => sessionOf(b).startsWith("tumwater-clean-"));
    assert.ok(reviewIdx >= 0, "the queued change got a review run");
    assert.ok(runIdx >= 0, "clean eventually got its own run");
    assert.ok(reviewIdx < runIdx, "the review finished before the role's run started — the interlock held the role back");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "only the post-interlock run counted");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("restart hand-off: an in-flight merge outliving its deadline is aborted, not waited out", async () => {
  const repo = await makeFastRepo("restart hand-off abort test", ["clean"]);
  // Fast merge "Defaults" merge clean on its gate alone (reviewed AFTER it lands); this test
  // pins the restart hand-off aborting an IN-FLIGHT merge held by a pre-merge reviewer, so opt
  // clean back into pre-merge review (review.afterMerge [] — the merge must be held by a review
  // that the hand-off can then abort).
  const cfg = loadConfig(repo);
  saveConfig(repo, { ...cfg, review: { ...cfg.review, afterMerge: [] } });
  const reviewing = path.join(tmpdir(), "handoff-abort-reviewing");
  // The queued change's reviewer run holds the merge in flight (a minute-long review); the
  // interlock keeps clean itself from running, so the verify is the only work the hand-off waits
  // on — the drain's bounded wait, then its abort callback, is what this pins.
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${reviewing}'; exec sleep 60;; esac; done`,
  );
  enqueueMerge(repo, {
    role: "clean",
    sha: shaOnSideBranch(repo),
    run: 1,
    summary: "hand-off sentinel change",
    enqueuedAt: Date.now(),
  });
  // Staleness is re-evaluated only when main moves: stale once the reviewer is running, and
  // the test moves main then — the restart takes effect mid-review, with no role run in flight.
  const { redeployer, swaps } = scriptedRedeployer(repo, { stale: () => fs.existsSync(reviewing) });
  const { run, stop } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffMergeWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(reviewing), "the verify's reviewer run to be in flight");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the verify");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1, "the new build was swapped in");
    assert.ok(
      eventsOfType(repo, "warning").some((e) => /outlived its .*deadline/.test(String(e.message))),
      "the hand-off announced the lapse before stopping",
    );
    assert.deepEqual(
      eventsOfType(repo, "merge_failed").map((e) => `${e.source}:${String(e.result)}`),
      ["clean:aborted"],
      "the outlived merge ended aborted, not merged",
    );
  } finally {
    await stop();
    restore();
  }
});
