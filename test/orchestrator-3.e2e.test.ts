/** Third slice of the orchestrator e2e suite (after orchestrator.e2e.test.ts and
 * orchestrator-2.e2e.test.ts) — split so node --test runs the slices in parallel processes:
 * top-level tests within one file run sequentially, while each test FILE gets its own process
 * (and its own PATH, which fakePi's global PATH swap requires). The slices are balanced by
 * measured per-test duration (~17 s each at 2026-09-20); keep them roughly equal when moving
 * tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";
import { landQueuedEntry, writeLandingMarker } from "../src/landing-slot.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { enqueuePrompt } from "../src/inbox.js";
import { logEvent, readEvents } from "../src/events.js";
import { loadLoopState, saveLoopState } from "../src/state.js";
import { readOrchestratorInfo } from "../src/fleet-state.js";
import { abortRequestPath, branchName, landQueueDir, landingRefName, landingStatePath, worktreePath } from "../src/paths.js";
import { enqueueLanding, headLanding, queueDepth } from "../src/land-queue.js";
import { refSha, setRef } from "../src/git.js";
import { checkMainBaseline } from "../src/main-baseline.js";
import { type RedeployDeps, Redeployer } from "../src/redeploy.js";
import {
  assistantLine,
  fastConfig,
  fakePi,
  landWork,
  makeRepo,
  sh,
  startLiveOrchestrator,
  tmpdir,
  waitFor,
} from "./util.js";

const FAST_POLL_MS = 100;

/** Does `role`'s pinned landing ref still exist? `git rev-parse --verify` exits nonzero once
 * the ref is gone, so its absence is the postcondition the abort tests assert. Waiting on the
 * abort outcome alone races the discard: a deliberate stop's `discardPinnedRefs` runs in the
 * landing slot's `finally`, AFTER `writeLandingOutcome` has already recorded `lastResult`
 * (the load-sensitive-test class in BUGS.md, 2026-09-18). */
function landingRefExists(repo: string, role: string): boolean {
  try {
    sh(repo, "git", "rev-parse", "--verify", landingRefName(role));
    return true;
  } catch {
    return false; // a missing ref makes rev-parse --verify exit nonzero
  }
}

test("a user abort during a landing kills it and discards the pinned ref", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort landing e2e test");
  // A long minimum interval: the aborted role must NOT start a second tick while the test
  // asserts the aftermath (a fresh tick would re-enqueue and re-pin and muddy the asserts).
  const cfg = fastConfig(["clean"]);
  cfg.minTickIntervalSeconds = 300;
  saveConfig(repo, cfg);
  // Author run: make a change and finish. Review run (its prompt contains VERDICT): touch the
  // marker, then hang until the abort kills it — the landing stays in flight for as long as
  // the abort marker sits on disk.
  const marker = path.join(tmpdir(), "clean-reviewing");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${marker}'; exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The tick commits + enqueues; the landing slot picks the entry up and starts its
    // reviewer run — by merge queue 3/5 this is where `tumwater abort --role` reaches it.
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "queued",
      "the tick to enqueue its landing",
    );
    await waitFor(() => fs.existsSync(marker), "the landing's reviewer run to be in flight");

    // What `tumwater abort --role clean` does from the CLI side: drop the per-role marker.
    const markerFile = abortRequestPath(repo, "clean");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));

    // The fleet consumes the request, aborts the in-flight landing, and the drain discards
    // the pinned ref: a deliberate stop kills the work under review, the landing's
    // counterpart of the pre-3/5 mid-review user abort. (A shutdown abort keeps the ref.)
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "aborted" && !landingRefExists(repo, "clean"),
      "the aborted landing to settle and discard its pinned ref",
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "the entry was dropped after the aborted landing");
    assert.ok(!landingRefExists(repo, "clean"), "the pinned commit was discarded with the deliberate stop");

    // The landing, not the tick, was aborted: one land_failed, no tick_aborted, no second tick.
    const failed = readEvents(repo).filter((e) => e.type === "land_failed");
    assert.equal(failed.length, 1, "the aborted landing logged its failure");
    assert.equal(failed[0]!.result, "aborted");
    assert.equal(readEvents(repo).filter((e) => e.type === "tick_aborted").length, 0);
    assert.equal(loadLoopState(repo, "clean").ticks, 1);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a role with a queued or in-flight landing never starts a new tick (interlock)", async () => {
  const repo = makeRepo();
  await initProject(repo, "interlock e2e test");
  // minTickInterval 0: the role is due on EVERY poll — only the interlock can hold it.
  saveConfig(repo, fastConfig(["clean"]));
  // Author run: first time a change, after that nothing to do. Review run: touch the marker,
  // then hang until the test's abort kills it — the landing stays in flight through the window.
  const hang = path.join(tmpdir(), "interlock-hang");
  const did = path.join(tmpdir(), "interlock-did");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${hang}'; exec sleep 30;; esac; done`,
      `if [ -f '${did}' ]; then printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; else touch '${did}'; printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'; fi`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The tick commits + enqueues; the landing slot picks the entry up and its reviewer hangs.
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "queued",
      "the tick to enqueue its landing",
    );
    await waitFor(() => fs.existsSync(hang), "the landing's reviewer run to be in flight");

    // ~10 poll cycles pass with the role due on every one — yet no second tick starts: the
    // entry stays in the queue until the landing settles, and the interlock covers both the
    // queued and the in-flight phases with that one check.
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "no second tick while its own landing is in flight");
    assert.equal(queueDepth(repo), 1, "the entry stays queued until the landing settles");

    // Settle the test: a deliberate stop kills the hung landing and drops its entry.
    const markerFile = abortRequestPath(repo, "clean");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "aborted",
      "the aborted landing to settle",
    );
    assert.equal(queueDepth(repo), 0, "the entry drops with the aborted landing");
  } finally {
    restore();
    await orch.stop();
  }
});

test("a queue entry surviving a restart drains through the gate on next start", async () => {
  const repo = makeRepo();
  await initProject(repo, "restart drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // Review run approves; the role's own ticks find nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // Seed exactly what a crash between commitAll and the landing's entry drop leaves behind:
  // one commit (a child of main's head, same full tree plus one file) reachable from the
  // role's branch, pinned by the landing ref, with its queue entry. The next start's drain
  // must land it through the gate.
  const gitIn = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", input }).trim();
  const blob = gitIn(["hash-object", "-w", "--stdin"], "crash survivor\n");
  // The parent's full tree plus the new file — a one-entry mktree would DELETE every other
  // file and the ff-merge would rightly refuse to overwrite the operator's checkout.
  const parentTree = sh(repo, "git", "ls-tree", "HEAD");
  const tree = gitIn(["mktree"], `${parentTree}\n100644 blob ${blob}\tcrash.txt\n`);
  const sha = gitIn(
    ["commit-tree", tree, "-p", sh(repo, "git", "rev-parse", "HEAD"), "-m", "tumwater(feature): crash survivor"],
    "",
  );
  sh(repo, "git", "update-ref", `refs/heads/${branchName("clean")}`, sha);
  sh(repo, "git", "update-ref", landingRefName("clean"), sha);
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "crash survivor", enqueuedAt: Date.now() });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "crash.txt")),
      "the surviving entry to drain onto main",
    );
    assert.equal(queueDepth(repo), 0, "the entry was consumed");
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      1,
      "the surviving change landed through the gate",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed").length,
      0,
      "no failed landing",
    );
    assert.equal(loadLoopState(repo, "clean").commits, 1, "the landed change counts as one commit");
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("clean"));
    } catch {
      refGone = true;
    }
    assert.ok(refGone, "the pin is deleted with a successful landing");
  } finally {
    restore();
    await orch.stop();
  }
});

test("an entry whose sha main already holds is dropped at the drain without a landing run", async () => {
  const repo = makeRepo();
  await initProject(repo, "dedup drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // Every reviewer run increments its own counter — a deduped drain must burn none of them.
  const rev = path.join(tmpdir(), "interlock-review-count");
  const did = path.join(tmpdir(), "dedup-did");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) n=$(cat '${rev}' 2>/dev/null || echo 0); echo $((n+1)) > '${rev}'; printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `if [ -f '${did}' ]; then printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; else touch '${did}'; printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'; fi`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // One real change lands end to end…
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "changed" && fs.existsSync(path.join(repo, "hello.txt")),
      "the change to land on main",
    );
    // …and the crash-between-ff-and-drop residue is simulated: the same sha re-enqueued.
    const sha = sh(repo, "git", "rev-parse", "HEAD");
    enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "stale duplicate", enqueuedAt: Date.now() });
    await waitFor(() => queueDepth(repo) === 0, "the stale entry to be dropped");
    assert.equal(
      fs.readFileSync(rev, "utf8").trim(),
      "1",
      "exactly one reviewer run: the stale entry was deduped, not re-landed",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      1,
      "no second landed event",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed").length,
      0,
      "the dedup drop logs no failure",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a stale marker beside an already-merged queue head is cleared so an idle fleet reads clean", async () => {
  // The other crash ordering's residue: a landing wrote its 4/5 marker and the ff-merge made
  // main hold the entry's sha, but the process died before the write-back dropped the entry.
  // The dedup arm drops the entry; the marker must go with it, or a liveness-cross-checking
  // observer (status/TUI/GUI) keeps reading an in-flight landing that no process is running.
  const repo = makeRepo();
  await initProject(repo, "stale marker drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // Nothing-to-do runs: the drain must drop the entry without any author or reviewer run.
  const restore = fakePi(["printf '%s\\n' '" + assistantLine("TUMWATER_NOTHING_TO_DO") + "'"].join("\n"));
  const sha = sh(repo, "git", "rev-parse", "HEAD");
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "already merged", enqueuedAt: Date.now() });
  writeLandingMarker(repo, { role: "clean", sha, summary: "already merged", startedAt: Date.now() });
  assert.ok(fs.existsSync(landingStatePath(repo)), "fixture sanity: the stale marker exists");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => queueDepth(repo) === 0, "the already-merged entry to be dropped");
    assert.ok(
      !fs.existsSync(landingStatePath(repo)),
      "the stale marker naming the dropped head is cleared",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      0,
      "the deduped entry ran no landing",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a torn queue-head file is dropped at the drain so the queue drains", async () => {
  // Seeds exactly what a hard crash mid-enqueueLanding leaves behind: a truncated queue
  // file that sorts before a live entry. headLanding reads null for the torn head and
  // nothing else drops it, so before the fix the live entry behind it never landed and
  // its role's interlock (a non-empty landingFor) held the role's ticks forever.
  const repo = makeRepo();
  await initProject(repo, "torn head drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // The review run approves; the role's own ticks never start — the interlock holds from
  // the first poll, because the entry is queued before the orchestrator starts.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // One real commit ahead of main (a child of main's head, full tree plus one file),
  // pinned and queued — the same construction the restart-drain test uses.
  const gitIn = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", input }).trim();
  const blob = gitIn(["hash-object", "-w", "--stdin"], "torn survivor\n");
  const parentTree = sh(repo, "git", "ls-tree", "HEAD");
  const tree = gitIn(["mktree"], `${parentTree}\n100644 blob ${blob}\ttorn.txt\n`);
  const sha = gitIn(
    ["commit-tree", tree, "-p", sh(repo, "git", "rev-parse", "HEAD"), "-m", "tumwater(feature): torn survivor"],
    "",
  );
  sh(repo, "git", "update-ref", `refs/heads/${branchName("clean")}`, sha);
  sh(repo, "git", "update-ref", landingRefName("clean"), sha);
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "torn survivor", enqueuedAt: Date.now() });
  // The torn file sorts BEFORE the live entry: an interrupted write of the same shape.
  fs.writeFileSync(path.join(landQueueDir(repo), "0000000000-000000-1.json"), '{"role": "clean", "sha": "abc');
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "torn.txt")),
      "the live entry to drain behind the torn head",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      1,
      "the live change landed through the gate",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed").length,
      0,
      "no failed landing",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "warning" && /land queue/.test(String(e.message))).length,
      1,
      "one harness warning for the torn head drop",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a landing whose pinned sha no longer exists degrades to an error outcome, not a throw", async () => {
  // The queue entry can outlive its commit: the pin ref is dropped or the dangling commit
  // gc'd while the entry waits (a crash between pin and drop, manual gc). landChange throws
  // on the uncheckable sha — the landQueuedEntry catch-all must turn that into a normal
  // "error" outcome with every bookkeeping step a real failure gets, instead of taking the
  // landing slot down with it.
  const repo = makeRepo();
  const sha = "0".repeat(40); // a commit git cannot check out
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "lost pin", enqueuedAt: Date.now() });
  const { entry, file } = headLanding(repo)!;
  const config = fastConfig(["clean"]);
  const author = new LoopRunner(repo, "clean", config, "main");

  const result = await landQueuedEntry(repo, entry, file, author, config, "main", new AbortController().signal);

  assert.equal(result, "error");
  // The git failure is recorded where the next tick's prompt reads it.
  assert.match(author.state.lastError ?? "", /invalid reference/);
  // The 4/5 in-flight marker is cleared, the entry dropped, and the failure logged —
  // the same tail a landed or rejected entry goes through.
  assert.ok(!fs.existsSync(landingStatePath(repo)), "the landing marker survives the error outcome");
  assert.equal(queueDepth(repo), 0, "the entry is dropped after the error outcome");
  const failed = readEvents(repo).filter((e) => e.type === "land_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.loop, "clean");
  assert.equal(failed[0]?.result, "error");
  assert.equal(failed[0]?.commit, sha);
  assert.equal(readEvents(repo).filter((e) => e.type === "landed").length, 0);
  // The degraded outcome is persisted on the author's state, like any other tick result.
  assert.equal(loadLoopState(repo, "clean").lastResult, "error");
  assert.equal(loadLoopState(repo, "clean").lastError, author.state.lastError);
});

// --- abort requests (PLANS.md, abort plan): the marker-file plumbing that reaches LoopRunner's
// user-abort branch — consumption, kill, event, and the silent no-op shapes. The loop-level
// semantics themselves are pinned in test/loop.test.ts; the CLI side in test/cli.test.ts. ---

test("an abort request kills an in-flight tick, consumes its marker, and logs one event", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort e2e test");
  // Only clean ticks; a long backoff so the aborted loop stays idle while the no-op cases
  // below are asserted (no second tick can start and muddy the event count).
  const cfg = defaultConfig();
  cfg.minTickIntervalSeconds = 0;
  cfg.idleBackoff = { initialSeconds: 30, factor: 1, maxSeconds: 30 };
  for (const id of Object.keys(cfg.roles)) cfg.roles[id]!.enabled = id === "clean";
  saveConfig(repo, cfg);
  // A slow fake pi: writes a half-done edit then hangs until killed — the tick is in flight
  // for as long as the marker sits on disk.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => fs.existsSync(path.join(worktreePath(repo, "clean"), "partial.txt")),
      "a tick to be in flight",
    );

    // Reproduce what `tumwater abort --role clean` does from the CLI side: drop the per-role
    // marker. (The CLI path itself is covered in test/cli.test.ts.)
    const markerFile = abortRequestPath(repo, "clean");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));

    // The fleet consumes the request within a poll cycle: kills the run and removes the marker.
    await waitFor(() => !fs.existsSync(markerFile), "the abort marker to be consumed");

    const aborted = () => readEvents(repo).filter((e) => e.type === "tick_aborted");
    assert.equal(aborted().length, 1, "exactly one tick_aborted event");
    assert.equal(aborted()[0]?.loop, "clean", "filed under the role's loop");

    // The killed run ends user_aborted: half-done work discarded (worktree reset to main),
    // backed off instead of resuming promptly.
    await waitFor(() => !loadLoopState(repo, "clean").running, "the aborted tick to finish");
    const s = loadLoopState(repo, "clean");
    assert.equal(s.lastResult, "user_aborted");
    assert.ok(!s.resumePending, "a deliberate stop leaves nothing to resume");
    assert.ok(
      !fs.existsSync(path.join(worktreePath(repo, "clean"), "partial.txt")),
      "half-done work was discarded",
    );
    assert.ok(s.nextRunAt > Date.now() + 29_000, "backed off, not immediate");

    // A request for a loop that is NOT running is a silent no-op: the marker is removed and
    // no event logged — clean itself (now idle in its backoff) …
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));
    await waitFor(() => !fs.existsSync(markerFile), "the idle-loop marker to be consumed");
    assert.equal(aborted().length, 1, "no event for an idle loop");

    // … and the same holds for a disabled role, which has no runner at all (the no-runner shape).
    for (const role of ["feature", "bugfix"]) {
      const m = abortRequestPath(repo, role);
      fs.mkdirSync(path.dirname(m), { recursive: true });
      fs.writeFileSync(m, JSON.stringify({ at: Date.now() }));
    }
    await waitFor(
      () => !fs.existsSync(abortRequestPath(repo, "feature")) && !fs.existsSync(abortRequestPath(repo, "bugfix")),
      "the disabled roles' markers to be consumed",
    );
    assert.equal(aborted().length, 1, "no event for a role with no runner");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Self-redeploy (src/redeploy.ts) wired into the scheduler ---

/** A Redeployer whose effects are scripted: main is always stale and green, the compile succeeds
 * at once, and the swap only records itself — so the orchestrator's half of the contract (hold,
 * drain, abort, exit) is what these tests pin. */
function scriptedRedeployer(
  repo: string,
  opts: { drainMaxMs?: number; compileOk?: boolean; stale?: () => boolean } = {},
) {
  const swaps: string[] = [];
  const deps: RedeployDeps = {
    staleness: async () => ({ stale: opts.stale ? opts.stale() : true, aheadCommits: 4 }),
    mainGreen: async () => true,
    compile: async () => ({ ok: opts.compileOk ?? true, detail: opts.compileOk === false ? "tsc exited 2" : "" }),
    swap: (h) => {
      swaps.push(h);
    },
  };
  // Events go to the repo's log exactly as cmdRun wires them, so the assertions below read the
  // same events.jsonl an operator would.
  const redeployer = new Redeployer(
    { sha: "0".repeat(40), builtAt: 1, root: "/proj" },
    true,
    deps,
    (e) => logEvent(repo, e),
    opts.drainMaxMs,
  );
  return { redeployer, swaps };
}

test("a stale self-hosted build drains the fleet, swaps, and returns restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "self-redeploy test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo);
  // A prompt for the director sits in the inbox: while a restart is pending nothing new starts
  // — director included — so it must still be queued when the process hands over.
  enqueuePrompt(repo, "hello director");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const exit = await runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: controller.signal,
      pollMs: FAST_POLL_MS,
      redeploy: redeployer,
    });
    assert.deepEqual(exit, { restart: true });
    const head = sh(repo, "git", "rev-parse", "HEAD");
    assert.deepEqual(swaps, [head], "the compiled head was swapped into dist");
    const types = readEvents(repo).map((e) => e.type);
    assert.ok(types.indexOf("build_stale") < types.indexOf("restart_pending"), "stale, then pending");
    assert.ok(types.indexOf("restart_pending") < types.indexOf("restart"), "pending, then restart");
    assert.ok(types.indexOf("restart") < types.indexOf("orchestrator_stop"), "the stop follows the restart");
    assert.equal(fs.readdirSync(path.join(repo, ".tumwater/inbox")).length, 1, "the held director prompt survives for the next generation");
    assert.equal(readOrchestratorInfo(repo), null, "the info file is removed like any other stop");
  } finally {
    clearTimeout(timeout);
    restore();
  }
});

test("the orchestrator publishes the build's staleness in orchestrator.json while it runs", async () => {
  const repo = makeRepo();
  await initProject(repo, "build status test");
  saveConfig(repo, fastConfig(["clean"]));
  const cfg = loadConfig(repo);
  cfg.autoRestart = false; // observe only: no drain, no restart
  saveConfig(repo, cfg);
  const restore = fakePi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer } = scriptedRedeployer(repo);
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal, pollMs: FAST_POLL_MS, redeploy: redeployer });
  try {
    await waitFor(() => readOrchestratorInfo(repo)?.build?.stale === true, "stale build published");
    const info = readOrchestratorInfo(repo)!;
    assert.equal(info.build?.sha, "0".repeat(40));
    assert.equal(info.build?.aheadCommits, 4);
    assert.equal(readEvents(repo).filter((e) => e.type === "restart_pending").length, 0, "autoRestart off: never drains");
    const start = readEvents(repo).find((e) => e.type === "orchestrator_start")!;
    assert.equal(start.build, "0".repeat(40), "the start event names the build");
  } finally {
    controller.abort();
    await done.catch(() => undefined);
    restore();
  }
});

test("a drain past its cap aborts the in-flight tick resumably and still restarts", async () => {
  const repo = makeRepo();
  await initProject(repo, "drain cap test");
  saveConfig(repo, fastConfig(["clean"]));
  // The tick never finishes on its own: only the drain cap (or a stop) can end it.
  const partial = path.join(worktreePath(repo, "clean"), "partial.txt");
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  // Staleness is re-evaluated only when main moves (a per-head verdict), so: let the first tick
  // start against a fresh build, then move main — the recomputation finds the build stale with
  // that tick in flight, which is exactly the situation the drain cap exists for.
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => fs.existsSync(partial) });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const run = runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: controller.signal,
      pollMs: FAST_POLL_MS,
      redeploy: redeployer,
    });
    await waitFor(() => fs.existsSync(partial), "the tick to start");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running tick");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]!.result, "aborted", "the drain cap aborted the tick like a shutdown would");
    assert.equal(loadLoopState(repo, "clean").resumePending, true, "…so it resumes on the new build");
    const restart = readEvents(repo).find((e) => e.type === "restart")!;
    assert.equal(restart.abortedTicks, 1);
  } finally {
    clearTimeout(timeout);
    restore();
  }
});

test("an in-flight director tick is waited for, not aborted, when the drain window elapses", async () => {
  // The 2026-09-08 incident end to end: a human prompt outlives the drain cap. Role ticks are
  // aborted resumably at the cap; the director's tick must run to completion — no swap and no
  // abort until it finishes (BUGS.md).
  const repo = makeRepo();
  await initProject(repo, "director drain test");
  saveConfig(repo, fastConfig(["director"]));
  // The prompt's run outlives the window: it marks itself started (so staleness can flip while
  // it is in flight), then sleeps past the cap before answering.
  const marker = path.join(worktreePath(repo, "director"), "started.txt");
  const restore = fakePi(`touch started.txt\nsleep 2\nprintf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => fs.existsSync(marker) });
  enqueuePrompt(repo, "a long human prompt");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const run = runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: controller.signal,
      pollMs: FAST_POLL_MS,
      redeploy: redeployer,
    });
    await waitFor(() => fs.existsSync(marker), "the director tick to start");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running prompt");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
    assert.equal(ends.length, 1);
    assert.notEqual(ends[0]!.result, "aborted", "the director tick finished on its own — the hold waited it out");
    const restart = readEvents(repo).find((e) => e.type === "restart")!;
    assert.ok(Number(restart.drainedMs) > 500, `the hold ran past the drain window (${String(restart.drainedMs)}ms)`);
    assert.equal(restart.abortedTicks, 0);
  } finally {
    clearTimeout(timeout);
    restore();
  }
});

test("a failed compile leaves the fleet running the old build", async () => {
  const repo = makeRepo();
  await initProject(repo, "compile failure test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo, { compileOk: false });
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal, pollMs: FAST_POLL_MS, redeploy: redeployer });
  try {
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "warning" && /rebuild of .* failed/.test(String(e.message))),
      "compile-failure warning",
    );
    // Still running: ticks keep coming after the failure was recorded. clean is deferrable
    // (need-based prioritization) and main has not moved since its startup tick — a work
    // landing supplies the wake for the post-failure tick. The in-flight startup tick must
    // finish first: its end-of-tick head refresh would swallow a concurrent landing into
    // lastMainHead, leaving deferral nothing to react to.
    await waitFor(
      () => !loadLoopState(repo, "clean").running && loadLoopState(repo, "clean").lastMainHead !== "",
      "the startup tick to finish",
    );
    landWork(repo);
    const before = readEvents(repo).filter((e) => e.type === "tick_start").length;
    await waitFor(() => readEvents(repo).filter((e) => e.type === "tick_start").length > before, "ticks resume after the hold lifts");
    assert.deepEqual(swaps, []);
  } finally {
    controller.abort();
    await done.catch(() => undefined);
    restore();
  }
});

// ── Merge queue 5/5 — the batch slot ─────────────────────────────────────────────────────

/** Seed the land queue with one pinned single-commit entry per role (queue order = argument
 * order), built the way pinAndReset leaves them: a commit off main under the landing ref.
 * Pre-seeding — instead of letting the roles tick the entries in — makes the drain's batch
 * deterministic: the slot sees BOTH entries on its first poll, before any tick can race it. */
async function seedLandQueue(
  repo: string,
  ...args: string[]
): Promise<void> {
  // An optional leading "2" tag distinguishes a role's second change (the cap test's phase 2
  // re-seeds the same roles on a moved main): same file + same content would be an empty commit.
  let roles = args;
  let tag = "";
  if (args.length > 1 && args[0] === "2") {
    tag = "2";
    roles = args.slice(1);
  }
  // The seed commits must not swallow the live config: initProject's initial commit tracks
  // tumwater.json, and any `reset --hard main` in the seed loop below resurrects the committed
  // copy over a live user edit — the cap test saves a new config between phases and would
  // silently read the old one. Untrack it on main (commit the deletion) and ignore it, the
  // way real projects keep a live config out of the tree; the untrack must land on main
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
  sh(repo, "git", "checkout", "--detach");
  for (const role of roles) {
    // Each pin stands alone on main: the two queued landings are independent changes.
    sh(repo, "git", "reset", "--hard", "main");
    fs.writeFileSync(path.join(repo, `${role}${tag}.txt`), `${role}${tag}\n`);
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", `${role}${tag} work`);
    const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
    await setRef(repo, landingRefName(role), sha);
    enqueueLanding(repo, { role, sha, tick: 1, summary: `${role}${tag} work`, enqueuedAt: Date.now() });
  }
  sh(repo, "git", "checkout", "main");
}

test("the drain coalesces two queued landings into one batch: one shared check, one fast-forward", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch drain e2e test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  await seedLandQueue(repo, "clean", "dry");
  // The project's declared check, counting its runs — the batching proof: a coalesced batch
  // runs gate, gate, BATCH (3 runs). Two sequential single landings would run gate, gate,
  // LANDING (the second landing's in-lock re-check after main moved under it).
  const count = path.join(tmpdir(), "batch-checkcount");
  const tool = path.join(repo, "node_modules", ".bin", "buildcheck-tool");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!/bin/sh\necho $(( $(cat ${count} 2>/dev/null || echo 0) + 1 )) > ${count}\necho ok\n`);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool" } }),
  );
  // Review runs: approve. Author runs (after the landing frees the roles): nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const seed = sh(repo, "git", "rev-parse", "main");
    await waitFor(
      () =>
        loadLoopState(repo, "clean").lastResult === "changed" && loadLoopState(repo, "dry").lastResult === "changed",
      "both batched changes to land",
      60_000,
    );
    assert.equal(sh(repo, "git", "rev-list", "--count", `${seed}..main`), "2", "both changes are on main");
    assert.equal(queueDepth(repo), 0, "both entries drained");
    assert.equal(await refSha(repo, landingRefName("clean")), null, "clean's ref went");
    assert.equal(await refSha(repo, landingRefName("dry")), null, "dry's ref went");
    const landed = readEvents(repo).filter((e) => e.type === "landed");
    assert.equal(landed.length, 2, "one landed event per change");
    assert.equal(readEvents(repo).filter((e) => e.type === "merged").length, 2);
    const checks = readEvents(repo).filter((e) => e.type === "build_check");
    // The orchestrator also seeds the green baseline (scope "baseline") somewhere in the
    // middle, so assert counts, not positions: the coalescing proof is that there is ONE
    // shared "batch" check and NO per-landing in-lock "landing" re-check — two sequential
    // single landings would have produced one.
    assert.equal(checks.filter((e) => e.scope === "gate").length, 2, "one gate pre-check per change");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 1, "ONE shared batch check over the stacked tree");
    assert.equal(checks.filter((e) => e.scope === "landing").length, 0, "no in-lock per-landing re-check");
    assert.ok(checks.every((e) => e.status === "passed"));
  } finally {
    restore();
    await orch.stop();
  }
});

test("an abort for a NON-HEAD batched role kills the whole batch and discards every pinned ref", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch abort e2e test");
  // A long minimum interval: nothing re-ticks while the test asserts the aftermath.
  const cfg = fastConfig(["clean", "dry"]);
  cfg.minTickIntervalSeconds = 300;
  saveConfig(repo, cfg);
  await seedLandQueue(repo, "clean", "dry");
  // The 300 s min-gap only throttles ticks AFTER the first: a never-run role has
  // lastTickEndedAt 0, so it is startup-eligible on poll one and — under load — can finish a
  // no-op tick before the asserts below read `ticks`, which is exactly the race that reddened
  // this test twice. Seed both roles as freshly ticked so NO tick can start for the next
  // 300 s; "the interlock held: no tick ever started" then asserts a deterministic fact (the
  // deeper interlock itself is pinned by the in-flight-landing test above).
  for (const role of ["clean", "dry"]) {
    const s = loadLoopState(repo, role);
    s.lastTickEndedAt = Date.now();
    saveLoopState(repo, s);
  }
  // The head's reviewer run touches the marker and then hangs — the batch stays in flight
  // until the abort kills it.
  const marker = path.join(tmpdir(), "batch-reviewing");
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${marker}'; exec sleep 30;; esac; done`,
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(marker), "the batch's head reviewer run to be in flight", 60_000);
    // What `tumwater abort --role dry` does from the CLI side: a marker for the SECOND
    // batched role — the one that has never even started its gate. Before 5/5 this request
    // could only match the head's landing; now it matches ANY batched role and kills the
    // whole slot unit.
    const markerFile = abortRequestPath(repo, "dry");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));

    await waitFor(
      () =>
        loadLoopState(repo, "clean").lastResult === "aborted" &&
        loadLoopState(repo, "dry").lastResult === "aborted" &&
        !landingRefExists(repo, "clean") &&
        !landingRefExists(repo, "dry"),
      "the aborted batch to settle and discard every pinned ref",
      60_000,
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(!fs.existsSync(path.join(repo, "clean.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "both entries were dropped");
    for (const role of ["clean", "dry"]) {
      assert.ok(
        !landingRefExists(repo, role),
        `${role}'s pinned commit was discarded — dry's only goes in the batch's ref-discard loop`,
      );
    }
    const failed = readEvents(repo).filter((e) => e.type === "land_failed");
    assert.equal(failed.length, 2, "one land_failed per batched change");
    assert.ok(failed.every((e) => e.result === "aborted"));
    assert.equal(readEvents(repo).filter((e) => e.type === "tick_aborted").length, 0, "no tick was running");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "the interlock held: no tick ever started");
    assert.equal(loadLoopState(repo, "dry").ticks, 0);
  } finally {
    restore();
    await orch.stop();
  }
});

test("landBatchMax caps the stack and live-reloads: five queue as 3+2 batches, then singles at cap 1", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch cap e2e test");
  const cfg = fastConfig(["feature", "bugfix", "clean", "dry", "perf"]);
  cfg.minTickIntervalSeconds = 300; // landings never tick; the seeded-queue drive needs no author runs
  saveConfig(repo, cfg);
  await seedLandQueue(repo, "feature", "bugfix", "clean", "dry", "perf");
  const count = path.join(tmpdir(), "cap-checkcount");
  const tool = path.join(repo, "node_modules", ".bin", "buildcheck-tool");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!/bin/sh\necho $(( $(cat ${count} 2>/dev/null || echo 0) + 1 )) > ${count}\necho ok\n`);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool" } }),
  );
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  const scopeCounts = () => {
    const checks = readEvents(repo).filter((e) => e.type === "build_check");
    return {
      gate: checks.filter((e) => e.scope === "gate").length,
      batch: checks.filter((e) => e.scope === "batch").length,
      landing: checks.filter((e) => e.scope === "landing").length,
      merged: readEvents(repo).filter((e) => e.type === "merged").length,
    };
  };
  try {
    // Phase 1: the default cap 3 lands five queued changes as two batches (3 + 2).
    // Count the landed events, not lastResult: the roles' first ticks (minTick 300 defers
    // only the second) run right after the landing and overwrite lastResult with no_change.
    await waitFor(
      () => readEvents(repo).filter((e) => e.type === "landed").length >= 5 && queueDepth(repo) === 0,
      "all five to land",
      60_000,
    );
    let s = scopeCounts();
    assert.equal(s.batch, 2, "cap 3: one shared check per batch, two batches");
    assert.equal(s.gate, 5, "one gate pre-check per change, in both batches");
    assert.equal(s.landing, 0, "the batch path never re-checks per landing");
    assert.equal(s.merged, 5, "one merged event per change");
    // The acceptance criterion: the batch-landed tip is green-seeded, so a baseline check
    // against the new main is a cache hit, not another script run. (The single path's
    // in-lock check seeds too — but no single has landed yet, and the ticks are deferred, so
    // this hit can only come from the batch's noteGreenBaseline.)
    const runsBefore = Number(fs.readFileSync(count, "utf8"));
    await checkMainBaseline(repo, defaultConfig());
    assert.equal(Number(fs.readFileSync(count, "utf8")), runsBefore, "the stacked tip is green-seeded: no re-run");

    // Phase 2: cap 1, LIVE — no restart: the next drain reads the reloaded config and takes
    // the single path, where each landing re-checks in lock (main moved under every pin).
    saveConfig(repo, { ...cfg, landBatchMax: 1 });
    await seedLandQueue(repo, "2", "feature", "bugfix", "clean");
    await waitFor(
      () => readEvents(repo).filter((e) => e.type === "landed").length >= 8 && queueDepth(repo) === 0,
      "the singles to land",
      60_000,
    );
    s = scopeCounts();
    assert.equal(s.batch, 2, "cap 1: the new landings took the single path — no third batch check");
    assert.equal(s.gate, 8, "the singles each gated — after the pre-gate rebase, on the synced tree");
    // The pre-gate rebase (PLANS.md 2026-09-21) checks the synced tree in the gate itself,
    // so the in-lock landing re-check is a no-op skip: the deterministic coverage that used
    // to run at `landing` scope now runs at `gate` scope on exactly the tree that lands.
    assert.equal(s.landing, 0, "the gate checks the synced tree; the in-lock re-check is a skip");
    assert.equal(s.merged, 8);
  } finally {
    restore();
    await orch.stop();
  }
});

test("an unexpected throw from the batch keeps every entry for re-drain and is contained", async () => {
  // The drain's catch: landBatch degrades failed landings to results, but a git-level failure
  // in the stack assembly still throws (unlike Phase A's worktree ensure, the assembly's is
  // unguarded). The catch must keep EVERY entry queued — none dropped, the write-back runs
  // only after landBatch returns — and let the next poll re-drain, instead of escaping
  // startLanding's body as an unhandled rejection. Trigger: during the SECOND gate run
  // (dry's — the head role's gate already approved), delete the head role's lander worktree
  // and make its parent unwritable, so the assembly's ensureDetachedWorktree cannot
  // re-create it and throws.
  const repo = makeRepo();
  await initProject(repo, "batch throw recovery test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  await seedLandQueue(repo, "clean", "dry");
  const worktrees = path.join(repo, ".tumwater", "worktrees");
  const headWt = path.join(worktrees, "_land-clean");
  const count = path.join(tmpdir(), "batch-throw-gatecount");
  const armed = path.join(tmpdir(), "batch-throw-armed");
  const restore = fakePi(
    [
      `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'`,
      `for a in "$@"; do case "$a" in`,
      `*"VERDICT:"*)`,
      `if [ "$n" = 2 ] && [ ! -e '${armed}' ]; then touch '${armed}'; rm -rf '${headWt}'; chmod 555 '${worktrees}'; fi`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(armed), "the second gate to arm the corruption", 60_000);
    // The throw was contained and the re-drain self-terminated: dry's entry survived the
    // throw (kept queued, its gate verdict persisted) and lands on the next poll, while
    // clean's — whose lander worktree can no longer be created — drops as a terminal error
    // instead of silently vanishing or wedging the queue forever.
    await waitFor(
      () => fs.existsSync(path.join(repo, "dry.txt")) && queueDepth(repo) === 0,
      "dry's re-drained landing to land and the queue to drain",
      60_000,
    );
    assert.ok(fs.existsSync(path.join(repo, "dry.txt")), "dry's change landed on main");
    assert.ok(
      !fs.existsSync(path.join(repo, "clean.txt")),
      "clean's change did not land — its assembly worktree was gone",
    );
    const cleanErrors = readEvents(repo).filter(
      (e) => e.type === "land_failed" && e.loop === "clean" && e.result === "error",
    );
    assert.ok(cleanErrors.length >= 1, "clean's re-drain ended in a terminal error outcome");
    const merged = readEvents(repo).filter((e) => e.type === "merged");
    assert.equal(
      merged.filter((e) => e.loop === "dry").length,
      1,
      "exactly one merged event, and it is dry's",
    );
  } finally {
    // Restore before stopping: shutdown and later ticks must be able to create worktrees.
    fs.chmodSync(worktrees, 0o755);
    restore();
    await orch.stop();
  }
});
