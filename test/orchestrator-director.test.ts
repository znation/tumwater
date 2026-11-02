/** Unit-tier coverage for the live orchestrator's scheduling pass
 * (src/orchestrator/orchestrator.ts) — the director's two exemptions and the merge queue's place
 * outside scheduling, contracts the gating `npm test` never pinned (the same approach
 * orchestrator-defer.test.ts takes: the block ran only in the e2e tier, so the unit suite
 * reported it uncovered even though the behavior was verified):
 *
 * - No permit for the director: `tumwater prompt` queues a director request and the director
 *   runs it immediately — the scheduling pass creates the director's task with no-op
 *   acquire/release closures (`usesSlot = role !== DIRECTOR_ROLE`), so it never queues behind
 *   maxConcurrent. Pinned with a slot-holding role run: with one permit and a role pi that
 *   holds it for minutes, the director's own pi run still sees two roles in flight.
 * - No team gate for the director: an operator pause (`tumwater pause`, the marker file)
 *   holds every role's next run but exempts the director — an explicit human prompt outranks
 *   the pause. The director runs while the paused role never starts one.
 * - The merge queue is not a scheduling gate (Subtract part 3a/7, which retired merge queue
 *   3/5's interlock): a role whose queued merge is still in flight starts its next run anyway.
 *   Pinned by overlap: the merge's own conflict-resolution run (the queued change's rebase onto
 *   main conflicts; a session ending `-conflict` parks until the test releases it) is parked
 *   while the role, woken by a queued prompt, runs and settles. No pre-merge reviewer is
 *   involved.
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
import { saveRunnerState } from "../src/runner/runner-state.js";
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
  // The gate is deterministic after Subtract part 3b/7: the recovered pin passes the diff
  // rules, merges on main, and the queue drains before the once round exits.
  const sha = pinOffMain(repo, (d) => fs.writeFileSync(path.join(d, "kept.txt"), "kept\n"), "kept director change");
  await setRef(repo, mergeRefName("director"), sha);
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.runsDone?.get("director"), 1, "the director got its recovery run");
    assert.ok(eventsOfType(repo, "merged").some((e) => e.commit === sha), "the pin merged");
    assert.equal(eventsOfType(repo, "merge_failed").length, 0, "the recovered pin did not fail");
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

test("merge queue: a role whose queued merge is still resolving a conflict starts its next run anyway", async () => {
  const repo = await makeFastRepo("merge queue scheduling test", ["clean"]);
  // Every merge lands on the deterministic gate and is reviewed after landing (part 3d/3), so
  // no pre-merge reviewer verdict drives the outcome; the merge's own run is then its parked
  // conflict-resolution pi run — the queued change conflicts with main on rebase, and the
  // resolver (session tumwater-clean-1-conflict) parks until the test releases it. The queue is
  // a merge-side fact only (Subtract part 3a/7), so a clean woken while that run is parked must
  // run and settle without waiting for its merge.
  const cfg = loadConfig(repo);
  saveConfig(repo, {
    ...cfg,
    // A long post-run gap keeps clean off its own clock after any run: only the test's queued
    // prompt wakes it while the merge is parked.
    roles: { ...cfg.roles, clean: { ...cfg.roles.clean!, minRunIntervalSeconds: 300 } },
  });
  // Keep clean's scheduled clock out of the window: a fresh role is due on poll 0 (nextRunAt
  // 0), and a run that ends before the merge reaches its conflict would prove no overlap. The
  // test wakes clean with a queued prompt once the conflict-resolution run is parked.
  const state = loadRunnerState(repo, "clean");
  state.nextRunAt = Date.now() + 10 * 60_000;
  saveRunnerState(repo, state);
  const log = path.join(tmpdir(), "interlock-prompts.log");
  const parked = path.join(tmpdir(), "interlock-conflict-parked");
  const release = path.join(tmpdir(), "interlock-conflict-release");
  // Record every run's argv; on the conflict-resolution run touch the parked marker and hold
  // until the release file appears, then resolve the conflicted seed.txt; idle others.
  const restore = fakePi(
    `prev=""; n=""\n` +
      `for a in "$@"; do if [ "$prev" = "-n" ]; then n="$a"; fi; prev="$a"; done\n` +
      `${logPromptsTo(log)}\n` +
      `case "$n" in\n` +
      `  *-conflict) touch '${parked}'; while [ ! -f '${release}' ] && ${ownerAliveSh()}; do sleep 0.1; done; echo combined > seed.txt;;\n` +
      `esac\n` +
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  );
  // A queued change main no longer holds, whose rebase onto main conflicts: the change edits
  // seed.txt to "branch", then main advances it to "main", so rebasing conflicts on seed.txt.
  const conflictSha = (() => {
    const g = (args: string[]) => {
      const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    g(["checkout", "-b", "interlock-fixture"]);
    fs.writeFileSync(path.join(repo, "seed.txt"), "branch\n");
    g(["add", "seed.txt"]);
    g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "interlock sentinel change"]);
    const sha = g(["rev-parse", "HEAD"]);
    g(["checkout", "main"]);
    fs.writeFileSync(path.join(repo, "seed.txt"), "main\n");
    g(["add", "seed.txt"]);
    g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "main moves under the sentinel"]);
    return sha;
  })();
  enqueueMerge(repo, {
    role: "clean",
    sha: conflictSha,
    run: 1,
    summary: "interlock sentinel change",
    enqueuedAt: Date.now(),
  });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(parked), "the queued change's conflict-resolution run to be in flight");
    // The merge is parked in conflict and its entry is still queued; wake clean now.
    const before = loadRunnerState(repo, "clean").runs;
    submitRolePrompt(repo, "clean", "tidy one thing");
    await awaitSettledRun(repo, "clean", before + 1, "clean's run while its queued merge is still resolving");
    assert.equal(queueDepth(repo), 1, "clean's run settled while its merge was still queued and parked");
    const runs = readRunBlocks(log);
    const conflictIdx = runs.findIndex((b) => sessionOf(b).endsWith("-conflict"));
    const runIdx = runs.findLastIndex(
      (b) => sessionOf(b).startsWith("tumwater-clean-") && !sessionOf(b).endsWith("-conflict"),
    );
    assert.ok(conflictIdx >= 0, "the queued change's merge ran a conflict-resolution run");
    assert.ok(
      conflictIdx < runIdx,
      "the role's run started after its merge's own run was already parked — the queue held nothing back",
    );
    fs.writeFileSync(release, "");
    await waitFor(() => queueDepth(repo) === 0, "the queued merge to settle and drop", 30_000);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("restart hand-off: an in-flight merge outliving its deadline is aborted, not waited out", async () => {
  const repo = await makeFastRepo("restart hand-off abort test", ["clean"]);
  // Fast merge "Defaults" merges clean on its gate alone and reviews it AFTER it lands. This
  // test pins the restart hand-off aborting an IN-FLIGHT merge, held by a parked conflict
  // resolver: the queued change edits interlock-note.txt and main edits it too, so the merge
  // reaches its one resolution run, which parks until the hand-off's deadline aborts it.
  const cfg = loadConfig(repo);
  const parked = path.join(tmpdir(), "handoff-abort-parked");
  saveConfig(repo, {
    ...cfg,
    roles: { ...cfg.roles, clean: { ...cfg.roles.clean!, minRunIntervalSeconds: 300 } },
  });
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *-conflict) touch '${parked}'; exec sleep 60;; esac; done`,
  );
  // The queued entry no longer holds clean's own runs (Subtract part 3a/7), so a just-ran seed
  // and the 300 s gap above keep role runs off: the parked resolver is the only work the
  // hand-off waits on — the drain's bounded wait, then its abort callback, is what this pins.
  const state = loadRunnerState(repo, "clean");
  state.lastRunEndedAt = Date.now();
  saveRunnerState(repo, state);
  enqueueMerge(repo, {
    role: "clean",
    sha: shaOnSideBranch(repo),
    run: 1,
    summary: "hand-off sentinel change",
    enqueuedAt: Date.now(),
  });
  // Main edits the same file after the pin, so the merge's rebase conflicts and its resolver
  // parks. Staleness is re-evaluated only when main moves: stale once the resolver is parked.
  fs.writeFileSync(path.join(repo, "interlock-note.txt"), "main's edit\n");
  sh(repo, "git", "add", "interlock-note.txt");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main edits the interlock note");
  const { redeployer, swaps } = scriptedRedeployer(repo, { stale: () => fs.existsSync(parked) });
  const { run, stop } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffMergeWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(parked), "the merge's parked conflict resolver to be in flight");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the merge");
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
