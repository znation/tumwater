/** Third slice of the orchestrator e2e suite (after orchestrator.e2e.test.ts and
 * orchestrator-2.e2e.test.ts) — split so the tier stays balanced: top-level tests within one
 * file run sequentially, while each test FILE gets its own process (and its own PATH, which
 * fakePi's global PATH swap requires); the runner runs the tier's files one at a time
 * (`--test-concurrency=1`, node 20.10+) so a loaded host cannot stretch their wall-clock waits.
 * The slices are balanced by
 * measured per-test duration (~17 s each at 2026-09-20); keep them roughly equal when moving
 * tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readMergeMarker, writeMergeMarker } from "../src/merge/merge-slot.js";
import { defaultConfig, saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import {
  abortRequestPath,
  branchName,
  mergeQueueDir,
  mergeRefName,
  mergeStatePath,
} from "../src/paths.js";
import { enqueueMerge, queueDepth } from "../src/merge/merge-queue.js";
import { setRef } from "../src/git/git.js";
import {
  fastConfig,
  mergeHead,
  mergeRefExists,
  makeFastRepo,
  scriptedRedeployer,
  startRedeployRun,
  startLiveOrchestrator,
  stopOrchestrator,
} from "./fixtures/orchestrator-fixtures.js";
import { makeRoleRunner, roleWt } from "./fixtures/runner-fixtures.js";
import { eventsOfType, writeMarker } from "./fixtures/log-fixtures.js";
import { headSha, makeRepo, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi } from "./fakes/fake-pi.js";
import { sleep, waitFor } from "./helpers/wait.js";
import { APPROVE_PI, assistantLine, leasedRoleShell } from "./fixtures/pi-events.js";

const FAST_POLL_MS = 100;

/** Has `role`'s run ended `queued` — committed and enqueued its merge? The run_end event is
 * where that outcome lives: `lastResult` records only completed results, so a queued run
 * leaves it at the prior outcome until the merge resolves (BUGS.md 2026-09-23). */
function runQueued(repo: string, role: string): boolean {
  return readEvents(repo).some((e) => e.type === "run_end" && e.source === role && e.result === "queued");
}

/** Seed what a crash between the role's commit and the merge's entry drop leaves behind:
 * one real commit ahead of main — a child of main's head carrying the parent's full tree plus
 * one new `file` (a one-entry mktree would delete every other file, and the ff-merge would
 * rightly refuse to overwrite the operator's checkout) — pinned by `clean`'s merge ref, with
 * its queue entry enqueued under `label`. The restart-drain and torn-head drain tests both
 * construct this survivor; only the file and its label differ. Returns the pinned sha. */
function seedSurvivorCommit(repo: string, file: string, label: string): string {
  const gitIn = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", input }).trim();
  const blob = gitIn(["hash-object", "-w", "--stdin"], `${label}\n`);
  const parentTree = sh(repo, "git", "ls-tree", "HEAD");
  const tree = gitIn(["mktree"], `${parentTree}\n100644 blob ${blob}\t${file}\n`);
  const sha = gitIn(
    ["commit-tree", tree, "-p", headSha(repo), "-m", `tumwater(feature): ${label}`],
    "",
  );
  sh(repo, "git", "update-ref", `refs/heads/${branchName("clean")}`, sha);
  sh(repo, "git", "update-ref", mergeRefName("clean"), sha);
  enqueueMerge(repo, { role: "clean", sha, run: 1, summary: label, enqueuedAt: Date.now() });
  return sha;
}

test("a user abort during a merge kills it and discards the pinned ref", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort merge e2e test");
  // A long minimum interval: the aborted role must NOT start a second run while the test
  // asserts the aftermath (a fresh run would re-enqueue and re-pin and muddy the asserts).
  const cfg = fastConfig(["clean"]);
  cfg.minRunIntervalSeconds = 300;
  // Author run: make a change and finish. The gate check on the change's tree (hello.txt
  // present) touches the marker and parks, holding the merge in flight for as long as the
  // abort marker sits on disk; main's baseline sees no hello.txt and passes at once.
  const marker = path.join(tmpdir(), "clean-reviewing");
  cfg.check = {
    command: `if [ -e hello.txt ]; then touch '${marker}'; exec sleep 30; fi; exit 0`,
  };
  saveConfig(repo, cfg);
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The run commits + enqueues; the merge slot picks the entry up and starts its
    // reviewer run — by merge queue 3/5 this is where `tumwater abort --role` reaches it.
    await waitFor(() => runQueued(repo, "clean"), "the run to enqueue its merge");
    await waitFor(() => fs.existsSync(marker), "the merge's gate check to be in flight");

    // What `tumwater abort --role clean` does from the CLI side: drop the per-role marker.
    const markerFile = abortRequestPath(repo, "clean");
    writeMarker(markerFile, { at: Date.now() });

    // The team consumes the request, aborts the in-flight merge, and the drain discards
    // the pinned ref: a deliberate stop kills the work under review, the merge's
    // counterpart of the pre-3/5 mid-review user abort. (A shutdown abort keeps the ref.)
    await waitFor(
      () => loadRunnerState(repo, "clean").lastResult === "aborted" && !mergeRefExists(repo, "clean"),
      "the aborted merge to settle and discard its pinned ref",
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing merged on main");
    assert.equal(queueDepth(repo), 0, "the entry was dropped after the aborted merge");
    assert.ok(!mergeRefExists(repo, "clean"), "the pinned commit was discarded with the deliberate stop");

    // The merge, not the run, was aborted: one merge_failed, no run_aborted, no second run.
    const failed = eventsOfType(repo, "merge_failed");
    assert.equal(failed.length, 1, "the aborted merge logged its failure");
    assert.equal(failed[0]!.result, "aborted");
    assert.equal(eventsOfType(repo, "run_aborted").length, 0);
    assert.equal(loadRunnerState(repo, "clean").runs, 1);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a role with a queued or in-flight merge never starts a new run (interlock)", async () => {
  // minRunInterval 0: the role is due on EVERY poll — only the interlock can hold it.
  const repo = await makeFastRepo("interlock e2e test", ["clean"]);
  // Author run: first time a change, after that nothing to do. The gate check on the change's
  // tree (hello.txt present) touches the marker and parks, holding the merge in flight through
  // the window; main's baseline sees no hello.txt and passes at once.
  const hang = path.join(tmpdir(), "interlock-hang");
  const did = path.join(tmpdir(), "interlock-did");
  const cfg = fastConfig(["clean"]);
  cfg.check = { command: `if [ -e hello.txt ]; then touch '${hang}'; exec sleep 30; fi; exit 0` };
  saveConfig(repo, cfg);
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `if [ -f '${did}' ]; then printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; else touch '${did}'; printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'; fi`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The run commits + enqueues; the merge slot picks the entry up and its reviewer hangs.
    await waitFor(() => runQueued(repo, "clean"), "the run to enqueue its merge");
    await waitFor(() => fs.existsSync(hang), "the merge's gate check to be in flight");

    // ~10 poll cycles pass with the role due on every one — yet no second run starts: the
    // entry stays in the queue until the merge settles, and the interlock covers both the
    // queued and the in-flight phases with that one check.
    await sleep(1_200);
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "no second run while its own merge is in flight");
    assert.equal(queueDepth(repo), 1, "the entry stays queued until the merge settles");
    // The pending change is not a completed result: the role's first run had no prior one,
    // so the persisted last-result pair stays empty through the whole window (BUGS.md
    // 2026-09-23 — it used to read `queued`).
    assert.equal(loadRunnerState(repo, "clean").lastResult, undefined, "the in-flight merge is not a last result");

    // Settle the test: a deliberate stop kills the hung merge and drops its entry.
    const markerFile = abortRequestPath(repo, "clean");
    writeMarker(markerFile, { at: Date.now() });
    await waitFor(
      () => loadRunnerState(repo, "clean").lastResult === "aborted",
      "the aborted merge to settle",
    );
    assert.equal(queueDepth(repo), 0, "the entry drops with the aborted merge");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a queue entry surviving a restart drains through the gate on next start", async () => {
  const repo = await makeFastRepo("restart drain e2e test", ["clean"]);
  // Review run approves; the role's own runs find nothing to do.
  const restore = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // Seed exactly what a crash between commitAll and the merge's entry drop leaves behind:
  // one commit pinned by the merge ref, with its queue entry. The next start's drain
  // must merge it through the gate.
  seedSurvivorCommit(repo, "crash.txt", "crash survivor");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "crash.txt")),
      "the surviving entry to drain onto main",
    );
    assert.equal(queueDepth(repo), 0, "the entry was consumed");
    assert.equal(
      eventsOfType(repo, "merge_done").length,
      1,
      "the surviving change merged through the gate",
    );
    assert.equal(
      eventsOfType(repo, "merge_failed").length,
      0,
      "no failed merge",
    );
    assert.equal(loadRunnerState(repo, "clean").commits, 1, "the merged change counts as one commit");
    assert.ok(!mergeRefExists(repo, "clean"), "the pin is deleted with a successful merge");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("an entry whose sha main already holds is dropped at the drain without a merge run", async () => {
  const repo = await makeFastRepo("dedup drain e2e test", ["clean"]);
  // No pre-merge reviewer run remains to be deduped (part 3h/3 stops reviewAttempt from running
  // the model reviewer), so the dedup is asserted through the merge_done count alone. Part 3g/3
  // still queues a post-merge review for the merge that lands here and the fake settles it.
  const did = path.join(tmpdir(), "dedup-did");
  const restore = fakePi(
    [
      APPROVE_PI,
      `if [ -f '${did}' ]; then printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; else touch '${did}'; printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'; fi`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // One real change merges end to end…
    await waitFor(
      () => loadRunnerState(repo, "clean").lastResult === "changed" && fs.existsSync(path.join(repo, "hello.txt")),
      "the change to merge on main",
    );
    // …and the crash-between-ff-and-drop residue is simulated: the same sha re-enqueued.
    const sha = headSha(repo);
    enqueueMerge(repo, { role: "clean", sha, run: 1, summary: "stale duplicate", enqueuedAt: Date.now() });
    await waitFor(() => queueDepth(repo) === 0, "the stale entry to be dropped");
    assert.equal(
      eventsOfType(repo, "merge_done").length,
      1,
      "no second merge_done event: the stale entry was deduped, not re-merged",
    );
    assert.equal(
      eventsOfType(repo, "merge_failed").length,
      0,
      "the dedup drop logs no failure",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a stale marker beside an already-merged queue head is cleared so an idle team reads clean", async () => {
  // The other crash ordering's residue: a merge wrote its 4/5 marker and the ff-merge made
  // main hold the entry's sha, but the process died before the write-back dropped the entry.
  // The dedup arm drops the entry; the marker must go with it, or a liveness-cross-checking
  // observer (status/TUI/GUI) keeps reading an in-flight merge that no process is running.
  const repo = await makeFastRepo("stale marker drain e2e test", ["clean"]);
  // Nothing-to-do runs: the drain must drop the entry without any author or reviewer run.
  const restore = fakePi(["printf '%s\\n' '" + assistantLine("TUMWATER_NOTHING_TO_DO") + "'"].join("\n"));
  const sha = headSha(repo);
  enqueueMerge(repo, { role: "clean", sha, run: 1, summary: "already merged", enqueuedAt: Date.now() });
  writeMergeMarker(repo, { role: "clean", sha, summary: "already merged", startedAt: Date.now(), stage: "merging" });
  assert.ok(fs.existsSync(mergeStatePath(repo)), "fixture sanity: the stale marker exists");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => queueDepth(repo) === 0, "the already-merged entry to be dropped");
    assert.ok(
      !fs.existsSync(mergeStatePath(repo)),
      "the stale marker naming the dropped head is cleared",
    );
    assert.equal(
      eventsOfType(repo, "merge_done").length,
      0,
      "the deduped entry ran no merge",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a torn queue-head file is dropped at the drain so the queue drains", async () => {
  // Seeds exactly what a hard crash mid-enqueueMerge leaves behind: a truncated queue
  // file that sorts before a live entry. headMerge reads null for the torn head and
  // nothing else drops it, so before the fix the live entry behind it never merged and
  // its role's interlock (a non-empty merge queue) held the role's runs forever.
  const repo = await makeFastRepo("torn head drain e2e test", ["clean"]);
  // The review run approves; the role's own runs never start — the interlock holds from
  // the first poll, because the entry is queued before the orchestrator starts.
  const restore = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // One real commit ahead of main, pinned and queued — the same construction the
  // restart-drain test uses.
  seedSurvivorCommit(repo, "torn.txt", "torn survivor");
  // The torn file sorts BEFORE the live entry: an interrupted write of the same shape.
  fs.writeFileSync(path.join(mergeQueueDir(repo), "0000000000-000000-1.json"), '{"role": "clean", "sha": "abc');
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "torn.txt")),
      "the live entry to drain behind the torn head",
    );
    assert.equal(
      eventsOfType(repo, "merge_done").length,
      1,
      "the live change merged through the gate",
    );
    assert.equal(
      eventsOfType(repo, "merge_failed").length,
      0,
      "no failed merge",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "warning" && String(e.message).includes('merge queue')).length,
      1,
      "one harness warning for the torn head drop",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a merge whose pinned sha no longer exists degrades to an error outcome, not a throw", async () => {
  // The queue entry can outlive its commit: the pin ref is dropped or the dangling commit
  // gc'd while the entry waits (a crash between pin and drop, manual gc). The verify's checkout
  // throws on the uncheckable sha — verifyRequest must turn that into a normal "error" outcome
  // with every bookkeeping step a real failure gets, instead of taking the merge pipeline
  // down with it.
  const repo = makeRepo();
  const sha = "0".repeat(40); // a commit git cannot check out
  enqueueMerge(repo, { role: "clean", sha, run: 1, summary: "lost pin", enqueuedAt: Date.now() });
  const config = fastConfig(["clean"]);
  const author = makeRoleRunner(repo, "clean", config);

  const result = await mergeHead(repo, author, config, "clean");

  assert.equal(result, "error");
  // The git failure is recorded where the next run's prompt reads it.
  assert.match(author.state.lastError ?? "", /invalid reference/);
  // The 4/5 in-flight marker is cleared, the entry dropped, and the failure logged —
  // the same tail a merged or rejected entry goes through.
  assert.ok(!fs.existsSync(mergeStatePath(repo)), "the merge marker survives the error outcome");
  assert.equal(queueDepth(repo), 0, "the entry is dropped after the error outcome");
  const failed = eventsOfType(repo, "merge_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.source, "clean");
  assert.equal(failed[0]?.result, "error");
  assert.equal(failed[0]?.commit, sha);
  assert.equal(eventsOfType(repo, "merge_done").length, 0);
  // The degraded outcome is persisted on the author's state, like any other run result.
  assert.equal(loadRunnerState(repo, "clean").lastResult, "error");
  assert.equal(loadRunnerState(repo, "clean").lastError, author.state.lastError);
});

// --- abort requests: the marker-file plumbing that reaches RoleRunner's
// user-abort branch — consumption, kill, event, and the silent no-op shapes. The runner-level
// semantics themselves are pinned in test/runner.test.ts; the CLI side in test/cli.test.ts. ---

test("an abort request kills an in-flight run, consumes its marker, and logs one event", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort e2e test");
  // Only clean runs; a long backoff so the aborted role stays idle while the no-op cases
  // below are asserted (no second run can start and muddy the event count).
  const cfg = defaultConfig();
  cfg.minRunIntervalSeconds = 0;
  cfg.idleBackoff = { initialSeconds: 30, factor: 1, maxSeconds: 30 };
  // Both disk thresholds off (fastConfig's rule): the disk floor reads the host's real
  // free space, and a hosted runner under the 10 GB default would hold clean's runs.
  cfg.diskHoldGB = 0;
  cfg.diskReclaimGB = 0;
  for (const id of Object.keys(cfg.roles)) cfg.roles[id]!.enabled = id === "clean";
  saveConfig(repo, cfg);
  // A slow fake pi: writes a half-done edit then hangs until killed — the run is in flight
  // for as long as the marker sits on disk.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => fs.existsSync(path.join(roleWt(repo, "clean"), "partial.txt")),
      "a run to be in flight",
    );

    // Reproduce what `tumwater abort --role clean` does from the CLI side: drop the per-role
    // marker. (The CLI path itself is covered in test/cli.test.ts.)
    const markerFile = abortRequestPath(repo, "clean");
    writeMarker(markerFile, { at: Date.now() });

    // The team consumes the request within a poll cycle: kills the run and removes the marker.
    await waitFor(() => !fs.existsSync(markerFile), "the abort marker to be consumed");

    const aborted = () => eventsOfType(repo, "run_aborted");
    assert.equal(aborted().length, 1, "exactly one run_aborted event");
    assert.equal(aborted()[0]?.source, "clean", "filed under the role");

    // The killed run ends user_aborted: half-done work discarded (worktree reset to main),
    // backed off instead of resuming promptly.
    await waitFor(() => !loadRunnerState(repo, "clean").running, "the aborted run to finish");
    const s = loadRunnerState(repo, "clean");
    assert.equal(s.lastResult, "user_aborted");
    assert.ok(!s.resumePending, "a deliberate stop leaves nothing to resume");
    assert.ok(
      !fs.existsSync(path.join(roleWt(repo, "clean"), "partial.txt")),
      "half-done work was discarded",
    );
    // Measured from the run's own end stamp, not a clock read after waitFor noticed the end:
    // that read trails the schedule by the poll and the host's load, which ate the 1 s of
    // slack a `> now + 29 s` check left on the 30 s backoff (BUGS.md 2026-10-01).
    assert.ok(s.nextRunAt - (s.lastRunEndedAt ?? 0) >= 29_000, "backed off, not immediate");

    // A request for a role that is NOT running is a silent no-op: the marker is removed and
    // no event logged — clean itself (now idle in its backoff) …
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));
    await waitFor(() => !fs.existsSync(markerFile), "the idle-role marker to be consumed");
    assert.equal(aborted().length, 1, "no event for an idle role");

    // … and the same holds for a disabled role, which has no runner at all (the no-runner shape).
    for (const role of ["feature", "bugfix"]) {
      const m = abortRequestPath(repo, role);
      writeMarker(m, { at: Date.now() });
    }
    await waitFor(
      () => !fs.existsSync(abortRequestPath(repo, "feature")) && !fs.existsSync(abortRequestPath(repo, "bugfix")),
      "the disabled roles' markers to be consumed",
    );
    assert.equal(aborted().length, 1, "no event for a role with no runner");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// ── The merge pipeline over a seeded queue (merge queue 5/5, merge-queue speed 2c) ────────

/** Seed the merge queue with one pinned single-commit entry per role (queue order = argument
 * order), built the way pinAndReset leaves them: a commit off main under the merge ref.
 * Pre-seeding — instead of letting the roles run the entries in — makes the pipeline's start
 * deterministic: it verifies EVERY entry from its first poll, before any run can race it. */
async function seedMergeQueue(repo: string, ...roles: string[]): Promise<void> {
  // The seed commits must not swallow the live config: initProject's initial commit tracks
  // tumwater.json, and any `reset --hard main` in the seed loop below resurrects the committed
  // copy over a live user edit. Untrack it on main (commit the deletion) and ignore it, the
  // way real projects keep a live config out of the tree; the untrack must merge on main
  // BEFORE the loop, since a bare `rm --cached` would be undone by the first reset --hard.
  const gi = path.join(repo, ".gitignore");
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!existing.split("\n").includes("tumwater.json")) {
    fs.writeFileSync(gi, existing + "tumwater.json\n");
  }
  try {
    // Commit the .gitignore alongside the untrack: if main tracks the ignore rule, every later
    // checkout/reset round trip keeps it in the worktree, and the live config stays an ignored
    // untracked file instead of being deleted (checkout drops a tracked .gitignore on a branch
    // that lacks it, un-ignoring and then removing the file it guarded).
    sh(repo, "git", "add", ".gitignore");
    sh(repo, "git", "rm", "--cached", "tumwater.json");
    sh(repo, "git", "commit", "-m", "untrack live config");
  } catch {
    // Not tracked — the gitignore line above still keeps future `add -A`s from swallowing it.
  }
  for (const role of roles) {
    // Each pin stands alone on main: the two queued merges are independent changes.
    const sha = pinOffMain(
      repo,
      (d) => fs.writeFileSync(path.join(d, `${role}.txt`), `${role}\n`),
      `${role} work`,
      { reset: true },
    );
    await setRef(repo, mergeRefName(role), sha);
    enqueueMerge(repo, { role, sha, run: 1, summary: `${role} work`, enqueuedAt: Date.now() });
  }
}

test("an abort for one queued role stops only that role's verify and discards its pin; the other verify runs on", async () => {
  // The merge-queue speed 2c rule through the live scheduler: every queued change is its own
  // verify, so `tumwater abort --role dedupe` reaches dedupe's verify alone — its reviewer killed,
  // its outcome `aborted`, its pin discarded — while clean's verify, reviewing beside it, runs on
  // and merges.
  const repo = makeRepo();
  await initProject(repo, "verify abort e2e test");
  // A long minimum interval: nothing re-runs while the test asserts the aftermath.
  const cfg = fastConfig(["clean", "dedupe"]);
  cfg.minRunIntervalSeconds = 300;
  const dir = tmpdir("verify-abort-");
  const release = path.join(dir, "release");
  // Each change's gate check parks in its verify's check slot until released (bounded ~60 s, so
  // a failed assert can never leave one spinning); the abort kills dedupe's. main's baseline
  // sees neither change file and passes at once. maxConcurrentChecks 2 lets both parked checks
  // run at once, so neither holds the other's check permit.
  cfg.maxConcurrentChecks = 2;
  cfg.check = {
    command:
      `if [ -e dedupe.txt ]; then touch '${dir}/dedupe-reviewing'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; exit 0; fi; ` +
      `if [ -e clean.txt ]; then touch '${dir}/clean-reviewing'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; exit 0; fi; ` +
      `exit 0`,
  };
  saveConfig(repo, cfg);
  await seedMergeQueue(repo, "clean", "dedupe");
  // The 300 s min-gap only throttles runs AFTER the first: a never-run role has
  // lastRunEndedAt 0, so it is startup-eligible on poll one and — under load — can finish a
  // no-op run before the asserts below read `runs`. Seed both roles as freshly ran so NO
  // run can start for the next 300 s: "no run ever started" then asserts a deterministic fact.
  for (const role of ["clean", "dedupe"]) {
    const s = loadRunnerState(repo, role);
    s.lastRunEndedAt = Date.now();
    saveRunnerState(repo, s);
  }
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => fs.existsSync(path.join(dir, "clean-reviewing")) && fs.existsSync(path.join(dir, "dedupe-reviewing")),
      "both verifies' gate checks to be in flight",
      60_000,
    );
    // What `tumwater abort --role dedupe` does from the CLI side.
    const markerFile = abortRequestPath(repo, "dedupe");
    writeMarker(markerFile, { at: Date.now() });

    await waitFor(
      () => loadRunnerState(repo, "dedupe").lastResult === "aborted" && !mergeRefExists(repo, "dedupe"),
      "dedupe's aborted verify to settle and discard its pin",
      60_000,
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(mergeRefExists(repo, "clean"), "clean's pin is untouched");
    assert.equal(queueDepth(repo), 1, "only dedupe's entry was dropped");
    assert.deepEqual(
      readEvents(repo)
        .filter((e) => e.type === "merge_failed")
        .map((e) => [e.source, e.result]),
      [["dedupe", "aborted"]],
    );

    fs.writeFileSync(release, "");
    await waitFor(() => loadRunnerState(repo, "clean").lastResult === "changed", "clean's verify to merge", 60_000);
    assert.ok(fs.existsSync(path.join(repo, "clean.txt")), "clean merged on main");
    assert.ok(!fs.existsSync(path.join(repo, "dedupe.txt")), "the aborted change never did");
    assert.equal(eventsOfType(repo, "run_aborted").length, 0, "no run was in flight");
    assert.equal(loadRunnerState(repo, "clean").runs, 0, "the interlock held: no run ever started");
    assert.equal(loadRunnerState(repo, "dedupe").runs, 0);
  } finally {
    fs.writeFileSync(release, ""); // never leave a check parked
    await stopOrchestrator(orch, restore);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a role rejected in its verify runs again while another queued change is still in review", async () => {
  // BUGS.md 2026-09-23: a final verdict once kept its entry queued until a whole batch wrote
  // back, so the interlock skipped the rejected author's due run every poll through every
  // later review, the stack check, and the ff. clean's gate check fails on its tree and
  // rejects; dedupe's gate check parks until released, keeping a merge in flight while the
  // test watches clean.
  const repo = await makeFastRepo("verify early drop e2e test", ["clean", "dedupe"]); // minRunInterval 0: due on every poll
  await seedMergeQueue(repo, "clean", "dedupe");
  const dir = tmpdir("early-drop-");
  const held = path.join(dir, "dedupe-reviewing");
  const release = path.join(dir, "release");
  // The gate check keys off the change files: main's baseline sees neither and exits 0 at
  // once. clean's tree (clean.txt present) fails deterministically on its run, so the gate
  // attributes it to clean (main is green) and rejects with no reviewer run; dedupe's tree
  // (dedupe.txt present) parks until released, bounded (~60 s) so a failed assert can never
  // leave it spinning. Author runs (clean's fix run): nothing to do.
  const cfg = fastConfig(["clean", "dedupe"]);
  cfg.check = {
    command:
      `if [ -e clean.txt ]; then exit 1; fi; ` +
      `if [ -e dedupe.txt ]; then touch '${held}'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; exit 0; fi; ` +
      `exit 0`,
  };
  saveConfig(repo, cfg);
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(held), "dedupe's gate check to be in flight — clean's verdict is already in", 60_000);
    // The interlock frees clean while dedupe's gate check is still parked: its due run starts.
    await waitFor(() => loadRunnerState(repo, "clean").runs >= 1, "the rejected role's fix run to start mid-merge", 30_000);
    assert.ok(!fs.existsSync(release), "dedupe's merge is still in flight: its gate check never returned");
    assert.equal(loadRunnerState(repo, "dedupe").runs, 0, "dedupe's entry is still queued, so the interlock still holds it");
    assert.deepEqual(
      readEvents(repo)
        .filter((e) => e.type === "merge_failed")
        .map((e) => [e.source, e.result]),
      [["clean", "rejected"]],
      "clean's outcome was written at its verdict",
    );

    fs.writeFileSync(release, "");
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "merge_done" && e.source === "dedupe"),
      "dedupe to merge",
      60_000,
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "merge_failed" && e.source === "clean").length,
      1,
      "clean's outcome was written once",
    );
  } finally {
    fs.writeFileSync(release, ""); // never leave dedupe's review parked
    await stopOrchestrator(orch, restore);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maxConcurrent 4 verifies three queued changes at once on the live orchestrator, then merges them all", async () => {
  // Merge-queue speed 2c through the scheduler's own wiring: every verify takes one of the shared
  // maxConcurrent permits (the authors are interlocked, so no role run holds one), verifyLimit
  // keeps the fourth for authoring, all three gate checks run together (each records how many
  // were in flight as it started), and the merge slot merges every change. Sampling now lives
  // in the declared check, not the reviewer run: each gate check parks ~3 s and counts its
  // fellow gate checks in samples.log on exactly the change's own tree. A per-change once
  // marker (one sample each) keeps the in-lock re-check and any post-merge run from skewing
  // the count, and main's baseline sees no change file and passes at once.
  const repo = makeRepo();
  await initProject(repo, "verification stage e2e test");
  const roles = ["feature", "bugfix", "clean"];
  const cfg = { ...fastConfig(roles), maxConcurrent: 4 };
  cfg.minRunIntervalSeconds = 300; // merges never run; the seeded-queue drive needs no author runs
  cfg.maxConcurrentChecks = 3; // no check permit serializes the three parked checks
  const runDir = tmpdir();
  cfg.check = {
    command:
      `d='${runDir}/runs'; mkdir -p "$d"; ` +
      `for r in feature bugfix clean; do ` +
      `if [ -e "$r.txt" ] && [ ! -e "$d/$r.sampled" ]; then ` +
      `touch "$d/$r.sampled"; f=$(mktemp "$d/run.XXXXXX"); ` +
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${runDir}/samples.log'; ` +
      `sleep 3; rm -f "$f"; exit 0; fi; done; exit 0`,
  };
  saveConfig(repo, cfg);
  await seedMergeQueue(repo, ...roles);
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => eventsOfType(repo, "merge_done").length >= 3 && queueDepth(repo) === 0,
      "all three to merge",
      60_000,
    );
    const samples = fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
    assert.equal(samples.length, 3, "one sample per change");
    assert.equal(Math.max(...samples), 3, `the three gate checks overlapped (in flight at each start: ${samples})`);
    assert.equal(eventsOfType(repo, "merged").length, 3, "every change merged");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a verify slot that can no longer be created is contained: the healthy change merges, the other drops as an error", async () => {
  // mergeApproved degrades failed merges to results, but a git-level failure in a stack's
  // assembly still throws, and the merge's catch must keep every entry queued (un-approved, so
  // each is reviewed afresh next poll) instead of escaping as an unhandled rejection; clean's
  // own re-verify degrades the same failure to an "error" outcome. Either way the queue must
  // drain: clean, whose just-freed slot cannot be re-created, drops as a terminal error, and
  // dedupe merges. Trigger: clean's own review run deletes its just-freed slot and makes the
  // worktrees parent unwritable before it approves, after seeding the shared `_merge` checkout
  // so dedupe's change (part 2c) can still merge.
  const repo = await makeFastRepo("merger worktree throw recovery test", ["clean", "dedupe"]);
  await seedMergeQueue(repo, "clean", "dedupe");
  const worktrees = path.join(repo, ".tumwater", "worktrees");
  const mergeWt = path.join(worktrees, "_merge");
  const armed = path.join(tmpdir(), "worktree-throw-armed");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in`,
      `*"VERDICT:"*)`,
      leasedRoleShell(),
      `case "$role" in clean) if [ ! -e '${armed}' ]; then`,
      `  touch '${armed}'; slot="$PWD"; cd /;`,
      // The shared merge checkout must exist before the parent is locked (a verify on a pooled
      // slot does not create it): seed it, then remove clean's just-freed slot and lock the
      // parent, so clean can no longer re-verify (its slot cannot be re-created) while the seeded
      // shared `_merge` checkout survives and dedupe's change merges.
      `  git -C '${repo}' worktree add --detach '${mergeWt}' main >/dev/null 2>&1;`,
      `  rm -rf "$slot"; chmod 555 '${worktrees}'`,
      `fi;; esac`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(armed), "clean's review to arm the corruption", 60_000);
    // The failure was contained and the pipeline self-terminated: dedupe's change merges, while
    // clean's — whose merger worktree can no longer be created — drops as a terminal error
    // instead of silently vanishing or wedging the queue forever.
    await waitFor(
      () => fs.existsSync(path.join(repo, "dedupe.txt")) && queueDepth(repo) === 0,
      "dedupe's merge to finish and the queue to drain",
      60_000,
    );
    assert.ok(fs.existsSync(path.join(repo, "dedupe.txt")), "dedupe's change merged on main");
    assert.ok(
      !fs.existsSync(path.join(repo, "clean.txt")),
      "clean's change did not merge — its merger worktree was gone",
    );
    const cleanErrors = readEvents(repo).filter(
      (e) => e.type === "merge_failed" && e.source === "clean" && e.result === "error",
    );
    assert.ok(cleanErrors.length >= 1, "clean ended in a terminal error outcome");
    const merged = eventsOfType(repo, "merged");
    assert.equal(
      merged.filter((e) => e.source === "dedupe").length,
      1,
      "exactly one merged event, and it is dedupe's",
    );
  } finally {
    // Restore before stopping: shutdown and later runs must be able to create worktrees.
    fs.chmodSync(worktrees, 0o755);
    await stopOrchestrator(orch, restore);
  }
});

test("a restart's hand-off aborts the merges that outlive its deadline instead of waiting them out", async () => {
  // BUGS.md 2026-09-23, the 97-minute hand-off: a self-redeploy swaps while queued changes are
  // mid-review and no role run is in flight, so poll returns `restart` at once with the
  // merges still running. Their reviewers each take a minute; the unbounded shutdown await sat
  // through every one of them in silence. Bounded, the hand-off announces the wait, aborts
  // every verify when the window lapses, and exits — the pins surviving for the new build.
  const repo = await makeFastRepo("restart hand-off test", ["clean", "dedupe"]);
  // Both roles are interlocked by their queued entries, so no role run ever starts: the drain
  // has nothing to wait for and the restart takes effect mid-build-check — the incident's shape.
  await seedMergeQueue(repo, "clean", "dedupe");
  const reviewing = path.join(tmpdir(), "handoff-reviewing");
  // Each change's gate check parks in its verify's build pre-check (one of them touches the
  // marker and sleeps 60 s), holding both merges in flight until the hand-off's lapse aborts
  // them; main's baseline sees neither change file and passes at once.
  const cfg = fastConfig(["clean", "dedupe"]);
  cfg.check = { command: `if [ -e clean.txt ] || [ -e dedupe.txt ]; then touch '${reviewing}'; exec sleep 60; fi; exit 0` };
  saveConfig(repo, cfg);
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
  );
  // Staleness is re-evaluated only when main moves: stale once the first verify's reviewer is
  // running, and the test moves main after that — so the restart arrives mid-review.
  const { redeployer, swaps } = scriptedRedeployer(repo, { stale: () => fs.existsSync(reviewing) });
  const { run, stop, signal } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffMergeWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(reviewing), "the first verify's gate check to be in flight");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the verifies");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1, "the new build was swapped in");
    assert.ok(!signal.aborted, "the hand-off ended the run, not the test's safety stop");

    const events = readEvents(repo);
    const index = (pattern: RegExp) =>
      events.findIndex((e) => e.type === "warning" && pattern.test(String(e.message)));
    const restartAt = events.findIndex((e) => e.type === "restart");
    const waitAt = index(/^restart waiting on the merge in progress for clean, dedupe/);
    const lapseAt = index(/the merge for clean, dedupe outlived its 0\.5s deadline — aborted/);
    const stopAt = events.findIndex((e) => e.type === "orchestrator_stop");
    assert.ok(restartAt >= 0 && waitAt > restartAt, "the wait is announced once the swap is done");
    assert.ok(lapseAt > waitAt && stopAt > lapseAt, "the lapse names what was awaited, before the stop");
    const handoffMs = events[stopAt]!.ts - events[restartAt]!.ts;
    assert.ok(handoffMs < 20_000, `the hand-off did not wait out the minute-long reviewers (${handoffMs}ms)`);

    // The aborted verifies are recorded like any shutdown abort: both changes `aborted`, their pins
    // kept for the new build's recovery, nothing merged, and no in-flight marker left behind.
    const failed = events.filter((e) => e.type === "merge_failed").map((e) => `${e.source}:${String(e.result)}`);
    assert.deepEqual(failed.sort(), ["clean:aborted", "dedupe:aborted"]);
    assert.ok(mergeRefExists(repo, "clean") && mergeRefExists(repo, "dedupe"), "both pins survive for the next generation");
    assert.ok(!fs.existsSync(path.join(repo, "clean.txt")), "nothing merged");
    assert.equal(readMergeMarker(repo), null, "no stale in-flight marker is left for the next generation");
  } finally {
    await stop();
    restore();
  }
});

test("a restart's drain aborts only its permit-holding role runs — the in-flight merge keeps its hand-off window, and a role enabled mid-run is cut off with the startup ones", async () => {
  // BUGS.md 2026-09-30, the 13 ms merge: clean's run holds a permit past the drain window
  // while dedupe's merge is mid-review when the redeploy reaches the swap. The drain's abort used
  // to fire the harness's one internal stop, killing the merge before the hand-off could wait
  // the window it announces — the "waiting" warning followed 13 ms later by `merge_failed …
  // aborted`, the review thrown away. And the role the drain DOES cut off here is one enabled
  // mid-run (config-live's runner creation), the second wiring the role-only stop must reach.
  const repo = await makeFastRepo("drain role-stop test", ["dedupe"]);
  await seedMergeQueue(repo, "dedupe"); // dedupe is interlocked: its merge runs, its run never starts
  const reviewing = path.join(tmpdir(), "rolestop-reviewing");
  const authoring = path.join(tmpdir(), "rolestop-authoring");
  // dedupe's gate check parks in its verify's build pre-check (touches the marker and sleeps
  // 60 s), holding the merge in flight through the announced hand-off window; main's baseline
  // sees no dedupe.txt and passes at once.
  const cfg = fastConfig(["dedupe"]);
  cfg.check = { command: `if [ -e dedupe.txt ]; then touch '${reviewing}'; exec sleep 60; fi; exit 0` };
  saveConfig(repo, cfg);
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done\n` +
      `touch '${authoring}'; sleep 5`,
  );
  const { redeployer, swaps } = scriptedRedeployer(repo, {
    drainMaxMs: 1000,
    stale: () => fs.existsSync(reviewing),
  });
  const { run, stop, signal } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffMergeWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(reviewing), "dedupe's verify gate check to be in flight");
    // Enable clean mid-run — the live-reload path, not startup — and let its run take a permit
    // BEFORE main moves: a held poll starts no run, so the permit holder must predate the hold.
    saveConfig(repo, fastConfig(["clean", "dedupe"]));
    await waitFor(() => fs.existsSync(authoring), "the mid-run role's run to hold a permit");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the run and the verify");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1, "the new build was swapped in");
    assert.ok(!signal.aborted, "the hand-off ended the run, not the test's safety stop");

    const events = readEvents(repo);
    const warnings = events.filter((e) => e.type === "warning" && e.source === "tumwater");
    assert.ok(
      warnings.some((e) => String((e as unknown as { message: string }).message).includes("role clean enabled — starting runs")),
      "clean joined through the live-reload path, so its wiring is the one under test",
    );
    const indexOf = (predicate: (e: (typeof events)[number]) => boolean) => events.findIndex(predicate);
    const restartAt = indexOf((e) => e.type === "restart");
    const waitAt = indexOf(
      (e) => e.type === "warning" && String((e as unknown as { message: string }).message).includes('restart waiting on the merge in progress for dedupe'),
    );
    const lapseAt = indexOf(
      (e) => e.type === "warning" && String((e as unknown as { message: string }).message).includes('the merge for dedupe outlived its 0.5s deadline — aborted'),
    );
    const cleanAbortedAt = indexOf((e) => e.type === "run_end" && e.source === "clean" && e.result === "aborted");
    const dedupeFailedAt = indexOf((e) => e.type === "merge_failed" && e.source === "dedupe");
    const stopAt = indexOf((e) => e.type === "orchestrator_stop");
    // The drain cut its permit holder off AT the swap, and the merge was aborted only past its
    // deadline — never straight at the swap (the 13 ms shape). Clean's cut-off and the wait
    // warning arrive within milliseconds of each other, so their ORDER would race; the lapse is
    // the anchor: a runner wired to the full signal instead of roleSignal survives the drain's
    // abort and dies only when the lapse fires its abort — after the lapse warning, half a
    // window (~500 ms) late — while a correctly wired one died long before it.
    assert.ok(restartAt >= 0, "the restart fired");
    const restartEvent = events[restartAt];
    assert.ok(restartEvent !== undefined && "abortedRuns" in restartEvent, "the restart event carries abortedRuns");
    assert.equal(restartEvent.abortedRuns, 1, "the drain counted clean's cut-off run");
    assert.ok(cleanAbortedAt > -1, "clean's in-flight run ended aborted");
    assert.ok(cleanAbortedAt < lapseAt, "clean's run was cut off by the drain at the swap, not at the hand-off's lapse");
    assert.ok(waitAt > restartAt && lapseAt > waitAt && dedupeFailedAt > lapseAt && stopAt > dedupeFailedAt, "the merge got the announced window: wait, lapse, abort, stop — in that order");

    // The merge's abort is the hand-off's, recorded like any shutdown abort: pin kept for the
    // next generation, nothing merged, no stale marker.
    assert.ok(mergeRefExists(repo, "dedupe"), "dedupe's pin survives for the next generation");
    assert.equal(readMergeMarker(repo), null, "no stale in-flight marker is left for the next generation");
  } finally {
    await stop();
    restore();
  }
});
