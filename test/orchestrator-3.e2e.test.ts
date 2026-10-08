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
import { readLandingMarker, writeLandingMarker } from "../src/landing/landing-slot.js";
import { defaultConfig, saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import {
  abortRequestPath,
  branchName,
  landQueueDir,
  landingRefName,
  landingStatePath,
  worktreePath,
} from "../src/paths.js";
import { enqueueLanding, queueDepth } from "../src/landing/landing-queue.js";
import { setRef } from "../src/git/git.js";
import {
  fastConfig,
  landHead,
  landingRefExists,
  makeFastRepo,
  scriptedRedeployer,
  startRedeployRun,
  startLiveOrchestrator,
  stopOrchestrator,
} from "./orchestrator-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { eventsOfType, writeMarker } from "./log-fixtures.js";
import { makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { sleep, waitFor } from "./wait.js";
import { APPROVE_PI, assistantLine, leasedRoleShell } from "./pi-events.js";

const FAST_POLL_MS = 100;

/** Has `role`'s tick ended `queued` — committed and enqueued its landing? The tick_end event is
 * where that outcome lives: `lastResult` records only completed results, so a queued tick
 * leaves it at the prior outcome until the landing resolves (BUGS.md 2026-09-23). */
function tickQueued(repo: string, role: string): boolean {
  return readEvents(repo).some((e) => e.type === "tick_end" && e.loop === role && e.result === "queued");
}

/** Seed what a crash between the role's commit and the landing's entry drop leaves behind:
 * one real commit ahead of main — a child of main's head carrying the parent's full tree plus
 * one new `file` (a one-entry mktree would delete every other file, and the ff-merge would
 * rightly refuse to overwrite the operator's checkout) — pinned by `clean`'s landing ref, with
 * its queue entry enqueued under `label`. The restart-drain and torn-head drain tests both
 * construct this survivor; only the file and its label differ. Returns the pinned sha. */
function seedSurvivorCommit(repo: string, file: string, label: string): string {
  const gitIn = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", input }).trim();
  const blob = gitIn(["hash-object", "-w", "--stdin"], `${label}\n`);
  const parentTree = sh(repo, "git", "ls-tree", "HEAD");
  const tree = gitIn(["mktree"], `${parentTree}\n100644 blob ${blob}\t${file}\n`);
  const sha = gitIn(
    ["commit-tree", tree, "-p", sh(repo, "git", "rev-parse", "HEAD"), "-m", `tumwater(feature): ${label}`],
    "",
  );
  sh(repo, "git", "update-ref", `refs/heads/${branchName("clean")}`, sha);
  sh(repo, "git", "update-ref", landingRefName("clean"), sha);
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: label, enqueuedAt: Date.now() });
  return sha;
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
    await waitFor(() => tickQueued(repo, "clean"), "the tick to enqueue its landing");
    await waitFor(() => fs.existsSync(marker), "the landing's reviewer run to be in flight");

    // What `tumwater abort --role clean` does from the CLI side: drop the per-role marker.
    const markerFile = abortRequestPath(repo, "clean");
    writeMarker(markerFile, { at: Date.now() });

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
    const failed = eventsOfType(repo, "land_failed");
    assert.equal(failed.length, 1, "the aborted landing logged its failure");
    assert.equal(failed[0]!.result, "aborted");
    assert.equal(eventsOfType(repo, "tick_aborted").length, 0);
    assert.equal(loadLoopState(repo, "clean").ticks, 1);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a role with a queued or in-flight landing never starts a new tick (interlock)", async () => {
  // minTickInterval 0: the role is due on EVERY poll — only the interlock can hold it.
  const repo = await makeFastRepo("interlock e2e test", ["clean"]);
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
    await waitFor(() => tickQueued(repo, "clean"), "the tick to enqueue its landing");
    await waitFor(() => fs.existsSync(hang), "the landing's reviewer run to be in flight");

    // ~10 poll cycles pass with the role due on every one — yet no second tick starts: the
    // entry stays in the queue until the landing settles, and the interlock covers both the
    // queued and the in-flight phases with that one check.
    await sleep(1_200);
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "no second tick while its own landing is in flight");
    assert.equal(queueDepth(repo), 1, "the entry stays queued until the landing settles");
    // The pending change is not a completed result: the role's first tick had no prior one,
    // so the persisted last-result pair stays empty through the whole window (BUGS.md
    // 2026-09-23 — it used to read `queued`).
    assert.equal(loadLoopState(repo, "clean").lastResult, undefined, "the in-flight landing is not a last result");

    // Settle the test: a deliberate stop kills the hung landing and drops its entry.
    const markerFile = abortRequestPath(repo, "clean");
    writeMarker(markerFile, { at: Date.now() });
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "aborted",
      "the aborted landing to settle",
    );
    assert.equal(queueDepth(repo), 0, "the entry drops with the aborted landing");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a queue entry surviving a restart drains through the gate on next start", async () => {
  const repo = await makeFastRepo("restart drain e2e test", ["clean"]);
  // Review run approves; the role's own ticks find nothing to do.
  const restore = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // Seed exactly what a crash between commitAll and the landing's entry drop leaves behind:
  // one commit pinned by the landing ref, with its queue entry. The next start's drain
  // must land it through the gate.
  seedSurvivorCommit(repo, "crash.txt", "crash survivor");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "crash.txt")),
      "the surviving entry to drain onto main",
    );
    assert.equal(queueDepth(repo), 0, "the entry was consumed");
    assert.equal(
      eventsOfType(repo, "landed").length,
      1,
      "the surviving change landed through the gate",
    );
    assert.equal(
      eventsOfType(repo, "land_failed").length,
      0,
      "no failed landing",
    );
    assert.equal(loadLoopState(repo, "clean").commits, 1, "the landed change counts as one commit");
    assert.ok(!landingRefExists(repo, "clean"), "the pin is deleted with a successful landing");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("an entry whose sha main already holds is dropped at the drain without a landing run", async () => {
  const repo = await makeFastRepo("dedup drain e2e test", ["clean"]);
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
      eventsOfType(repo, "landed").length,
      1,
      "no second landed event",
    );
    assert.equal(
      eventsOfType(repo, "land_failed").length,
      0,
      "the dedup drop logs no failure",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a stale marker beside an already-merged queue head is cleared so an idle fleet reads clean", async () => {
  // The other crash ordering's residue: a landing wrote its 4/5 marker and the ff-merge made
  // main hold the entry's sha, but the process died before the write-back dropped the entry.
  // The dedup arm drops the entry; the marker must go with it, or a liveness-cross-checking
  // observer (status/TUI/GUI) keeps reading an in-flight landing that no process is running.
  const repo = await makeFastRepo("stale marker drain e2e test", ["clean"]);
  // Nothing-to-do runs: the drain must drop the entry without any author or reviewer run.
  const restore = fakePi(["printf '%s\\n' '" + assistantLine("TUMWATER_NOTHING_TO_DO") + "'"].join("\n"));
  const sha = sh(repo, "git", "rev-parse", "HEAD");
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "already merged", enqueuedAt: Date.now() });
  writeLandingMarker(repo, { role: "clean", sha, summary: "already merged", startedAt: Date.now(), stage: "merging" });
  assert.ok(fs.existsSync(landingStatePath(repo)), "fixture sanity: the stale marker exists");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => queueDepth(repo) === 0, "the already-merged entry to be dropped");
    assert.ok(
      !fs.existsSync(landingStatePath(repo)),
      "the stale marker naming the dropped head is cleared",
    );
    assert.equal(
      eventsOfType(repo, "landed").length,
      0,
      "the deduped entry ran no landing",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a torn queue-head file is dropped at the drain so the queue drains", async () => {
  // Seeds exactly what a hard crash mid-enqueueLanding leaves behind: a truncated queue
  // file that sorts before a live entry. headLanding reads null for the torn head and
  // nothing else drops it, so before the fix the live entry behind it never landed and
  // its role's interlock (a non-empty land queue) held the role's ticks forever.
  const repo = await makeFastRepo("torn head drain e2e test", ["clean"]);
  // The review run approves; the role's own ticks never start — the interlock holds from
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
  fs.writeFileSync(path.join(landQueueDir(repo), "0000000000-000000-1.json"), '{"role": "clean", "sha": "abc');
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "torn.txt")),
      "the live entry to drain behind the torn head",
    );
    assert.equal(
      eventsOfType(repo, "landed").length,
      1,
      "the live change landed through the gate",
    );
    assert.equal(
      eventsOfType(repo, "land_failed").length,
      0,
      "no failed landing",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "warning" && /land queue/.test(String(e.message))).length,
      1,
      "one harness warning for the torn head drop",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a landing whose pinned sha no longer exists degrades to an error outcome, not a throw", async () => {
  // The queue entry can outlive its commit: the pin ref is dropped or the dangling commit
  // gc'd while the entry waits (a crash between pin and drop, manual gc). The vet's checkout
  // throws on the uncheckable sha — vetRequest must turn that into a normal "error" outcome
  // with every bookkeeping step a real failure gets, instead of taking the landing pipeline
  // down with it.
  const repo = makeRepo();
  const sha = "0".repeat(40); // a commit git cannot check out
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "lost pin", enqueuedAt: Date.now() });
  const config = fastConfig(["clean"]);
  const author = makeLoopRunner(repo, "clean", config);

  const result = await landHead(repo, author, config, "clean");

  assert.equal(result, "error");
  // The git failure is recorded where the next tick's prompt reads it.
  assert.match(author.state.lastError ?? "", /invalid reference/);
  // The 4/5 in-flight marker is cleared, the entry dropped, and the failure logged —
  // the same tail a landed or rejected entry goes through.
  assert.ok(!fs.existsSync(landingStatePath(repo)), "the landing marker survives the error outcome");
  assert.equal(queueDepth(repo), 0, "the entry is dropped after the error outcome");
  const failed = eventsOfType(repo, "land_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.loop, "clean");
  assert.equal(failed[0]?.result, "error");
  assert.equal(failed[0]?.commit, sha);
  assert.equal(eventsOfType(repo, "landed").length, 0);
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
    writeMarker(markerFile, { at: Date.now() });

    // The fleet consumes the request within a poll cycle: kills the run and removes the marker.
    await waitFor(() => !fs.existsSync(markerFile), "the abort marker to be consumed");

    const aborted = () => eventsOfType(repo, "tick_aborted");
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
    // Measured from the tick's own end stamp, not a clock read after waitFor noticed the end:
    // that read trails the schedule by the poll and the host's load, which ate the 1 s of
    // slack a `> now + 29 s` check left on the 30 s backoff (BUGS.md 2026-10-01).
    assert.ok(s.nextRunAt - (s.lastTickEndedAt ?? 0) >= 29_000, "backed off, not immediate");

    // A request for a loop that is NOT running is a silent no-op: the marker is removed and
    // no event logged — clean itself (now idle in its backoff) …
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));
    await waitFor(() => !fs.existsSync(markerFile), "the idle-loop marker to be consumed");
    assert.equal(aborted().length, 1, "no event for an idle loop");

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

// ── The landing pipeline over a seeded queue (merge queue 5/5, land-queue speed 2c) ────────

/** Seed the land queue with one pinned single-commit entry per role (queue order = argument
 * order), built the way pinAndReset leaves them: a commit off main under the landing ref.
 * Pre-seeding — instead of letting the roles tick the entries in — makes the pipeline's start
 * deterministic: it vets EVERY entry from its first poll, before any tick can race it. */
async function seedLandQueue(repo: string, ...roles: string[]): Promise<void> {
  // The seed commits must not swallow the live config: initProject's initial commit tracks
  // tumwater.json, and any `reset --hard main` in the seed loop below resurrects the committed
  // copy over a live user edit. Untrack it on main (commit the deletion) and ignore it, the
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
    fs.writeFileSync(path.join(repo, `${role}.txt`), `${role}\n`);
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", `${role} work`);
    const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
    await setRef(repo, landingRefName(role), sha);
    enqueueLanding(repo, { role, sha, tick: 1, summary: `${role} work`, enqueuedAt: Date.now() });
  }
  sh(repo, "git", "checkout", "main");
}

test("an abort for one queued role stops only that role's vet and discards its pin; the other vet runs on", async () => {
  // The land-queue speed 2c rule through the live scheduler: every queued change is its own vet,
  // so `tumwater abort --role dry` reaches dry's vet alone — its reviewer killed, its outcome
  // `aborted`, its pin discarded — while clean's vet, reviewing beside it, runs on and lands.
  const repo = makeRepo();
  await initProject(repo, "vet abort e2e test");
  // A long minimum interval: nothing re-ticks while the test asserts the aftermath.
  const cfg = fastConfig(["clean", "dry"]);
  cfg.minTickIntervalSeconds = 300;
  saveConfig(repo, cfg);
  await seedLandQueue(repo, "clean", "dry");
  // The 300 s min-gap only throttles ticks AFTER the first: a never-run role has
  // lastTickEndedAt 0, so it is startup-eligible on poll one and — under load — can finish a
  // no-op tick before the asserts below read `ticks`. Seed both roles as freshly ticked so NO
  // tick can start for the next 300 s: "no tick ever started" then asserts a deterministic fact.
  for (const role of ["clean", "dry"]) {
    const s = loadLoopState(repo, role);
    s.lastTickEndedAt = Date.now();
    saveLoopState(repo, s);
  }
  // Each reviewer marks itself and parks until released (bounded ~60 s, so a failed assert can
  // never leave one spinning); the abort kills dry's.
  const dir = tmpdir("vet-abort-");
  const release = path.join(dir, "release");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      leasedRoleShell(),
      `case "$role" in clean) touch '${dir}/clean-reviewing';; dry) touch '${dir}/dry-reviewing';; esac`,
      `i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => fs.existsSync(path.join(dir, "clean-reviewing")) && fs.existsSync(path.join(dir, "dry-reviewing")),
      "both vets' reviewer runs to be in flight",
      60_000,
    );
    // What `tumwater abort --role dry` does from the CLI side.
    const markerFile = abortRequestPath(repo, "dry");
    writeMarker(markerFile, { at: Date.now() });

    await waitFor(
      () => loadLoopState(repo, "dry").lastResult === "aborted" && !landingRefExists(repo, "dry"),
      "dry's aborted vet to settle and discard its pin",
      60_000,
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(landingRefExists(repo, "clean"), "clean's pin is untouched");
    assert.equal(queueDepth(repo), 1, "only dry's entry was dropped");
    assert.deepEqual(
      readEvents(repo)
        .filter((e) => e.type === "land_failed")
        .map((e) => [e.loop, e.result]),
      [["dry", "aborted"]],
    );

    fs.writeFileSync(release, "");
    await waitFor(() => loadLoopState(repo, "clean").lastResult === "changed", "clean's vet to land", 60_000);
    assert.ok(fs.existsSync(path.join(repo, "clean.txt")), "clean landed on main");
    assert.ok(!fs.existsSync(path.join(repo, "dry.txt")), "the aborted change never did");
    assert.equal(eventsOfType(repo, "tick_aborted").length, 0, "no tick was running");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "the interlock held: no tick ever started");
    assert.equal(loadLoopState(repo, "dry").ticks, 0);
  } finally {
    fs.writeFileSync(release, ""); // never leave a review parked
    await stopOrchestrator(orch, restore);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a role rejected in its vet ticks again while another queued change is still in review", async () => {
  // BUGS.md 2026-09-23: a final verdict once kept its entry queued until a whole batch wrote
  // back, so the interlock skipped the rejected author's due tick every poll through every
  // later review, the stack check, and the ff. clean's reviewer rejects at once; dry's parks
  // until released, keeping a landing in flight while the test watches clean.
  const repo = await makeFastRepo("vet early drop e2e test", ["clean", "dry"]); // minTickInterval 0: due on every poll
  await seedLandQueue(repo, "clean", "dry");
  const dir = tmpdir("early-drop-");
  const held = path.join(dir, "dry-reviewing");
  const release = path.join(dir, "release");
  // Reviews tell the changes apart by their diff; dry's park is bounded (~60 s) so a failed
  // assert can never leave it spinning. Author runs (clean's fix tick): nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `case "$a" in *"clean.txt"*) printf '%s\\n' '${assistantLine("VERDICT: reject\n1. not needed")}'; exit 0;; esac`,
      `touch '${held}'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(held), "dry's review to be in flight — clean's verdict is already in", 60_000);
    // The interlock frees clean while dry's review is still parked: its due tick runs.
    await waitFor(() => loadLoopState(repo, "clean").ticks >= 1, "the rejected role's fix tick to start mid-landing", 30_000);
    assert.ok(!fs.existsSync(release), "dry's landing is still in flight: its review never returned");
    assert.equal(loadLoopState(repo, "dry").ticks, 0, "dry's entry is still queued, so the interlock still holds it");
    assert.deepEqual(
      readEvents(repo)
        .filter((e) => e.type === "land_failed")
        .map((e) => [e.loop, e.result]),
      [["clean", "rejected"]],
      "clean's outcome was written at its verdict",
    );

    fs.writeFileSync(release, "");
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "landed" && e.loop === "dry"),
      "dry to land",
      60_000,
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed" && e.loop === "clean").length,
      1,
      "clean's outcome was written once",
    );
  } finally {
    fs.writeFileSync(release, ""); // never leave dry's review parked
    await stopOrchestrator(orch, restore);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maxConcurrent 4 vets three queued changes at once on the live orchestrator, then merges them all", async () => {
  // Land-queue speed 2c through the scheduler's own wiring: every vet takes one of the shared
  // maxConcurrent permits (the authors are interlocked, so no role tick holds one), vetLimit
  // keeps the fourth for authoring, all three reviews run together (each records how many were
  // in flight as it started), and the merge slot lands every change.
  const repo = makeRepo();
  await initProject(repo, "vetting stage e2e test");
  const roles = ["feature", "bugfix", "clean"];
  const cfg = { ...fastConfig(roles), maxConcurrent: 4 };
  cfg.minTickIntervalSeconds = 300; // landings never tick; the seeded-queue drive needs no author runs
  saveConfig(repo, cfg);
  await seedLandQueue(repo, ...roles);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `d='${runDir}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX")`,
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${runDir}/samples.log'`,
      `sleep 3; rm -f "$f"; printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => eventsOfType(repo, "landed").length >= 3 && queueDepth(repo) === 0,
      "all three to land",
      60_000,
    );
    const samples = fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
    assert.equal(samples.length, 3, "one review per change");
    assert.equal(Math.max(...samples), 3, `the three reviews overlapped (in flight at each start: ${samples})`);
    assert.equal(eventsOfType(repo, "merged").length, 3, "every change merged");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a vet slot that can no longer be created is contained: the healthy change lands, the other drops as an error", async () => {
  // landVetted degrades failed landings to results, but a git-level failure in a stack's
  // assembly still throws, and the merge's catch must keep every entry queued (un-vetted, so
  // each is vetted afresh next poll) instead of escaping as an unhandled rejection; clean's
  // own re-vet degrades the same failure to an "error" outcome. Either way the queue must
  // drain: clean, whose just-freed slot cannot be re-created, drops as a terminal error, and
  // dry lands. Trigger: clean's own review run deletes its just-freed slot and makes the
  // worktrees parent unwritable before it approves, after seeding the shared `_merge` checkout
  // so dry's merge (part 2c) can still land.
  const repo = await makeFastRepo("lander worktree throw recovery test", ["clean", "dry"]);
  await seedLandQueue(repo, "clean", "dry");
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
      // The shared merge checkout must exist before the parent is locked (a vet on a pooled
      // slot does not create it): seed it, then remove clean's just-freed slot and lock the
      // parent, so clean can no longer re-vet (its slot cannot be re-created) while the seeded
      // shared `_merge` checkout survives and dry's change lands.
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
    // The failure was contained and the pipeline self-terminated: dry's change lands, while
    // clean's — whose lander worktree can no longer be created — drops as a terminal error
    // instead of silently vanishing or wedging the queue forever.
    await waitFor(
      () => fs.existsSync(path.join(repo, "dry.txt")) && queueDepth(repo) === 0,
      "dry's landing to land and the queue to drain",
      60_000,
    );
    assert.ok(fs.existsSync(path.join(repo, "dry.txt")), "dry's change landed on main");
    assert.ok(
      !fs.existsSync(path.join(repo, "clean.txt")),
      "clean's change did not land — its lander worktree was gone",
    );
    const cleanErrors = readEvents(repo).filter(
      (e) => e.type === "land_failed" && e.loop === "clean" && e.result === "error",
    );
    assert.ok(cleanErrors.length >= 1, "clean ended in a terminal error outcome");
    const merged = eventsOfType(repo, "merged");
    assert.equal(
      merged.filter((e) => e.loop === "dry").length,
      1,
      "exactly one merged event, and it is dry's",
    );
  } finally {
    // Restore before stopping: shutdown and later ticks must be able to create worktrees.
    fs.chmodSync(worktrees, 0o755);
    await stopOrchestrator(orch, restore);
  }
});

test("a restart's hand-off aborts the landings that outlive its deadline instead of waiting them out", async () => {
  // BUGS.md 2026-09-23, the 97-minute hand-off: a self-redeploy swaps while queued changes are
  // mid-review and no role tick is in flight, so poll returns `restart` at once with the
  // landings still running. Their reviewers each take a minute; the unbounded shutdown await sat
  // through every one of them in silence. Bounded, the hand-off announces the wait, aborts
  // every vet when the window lapses, and exits — the pins surviving for the new build.
  const repo = await makeFastRepo("restart hand-off test", ["clean", "dry"]);
  // Both roles are interlocked by their queued entries, so no role tick ever starts: the drain
  // has nothing to wait for and the restart lands mid-review — the incident's shape.
  await seedLandQueue(repo, "clean", "dry");
  const reviewing = path.join(tmpdir(), "handoff-reviewing");
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${reviewing}'; exec sleep 60;; esac; done`,
  );
  // Staleness is re-evaluated only when main moves: stale once the first vet's reviewer is
  // running, and the test moves main after that — so the restart arrives mid-review.
  const { redeployer, swaps } = scriptedRedeployer(repo, { stale: () => fs.existsSync(reviewing) });
  const { run, stop, signal } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffLandingWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(reviewing), "the first vet's reviewer run to be in flight");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the vets");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1, "the new build was swapped in");
    assert.ok(!signal.aborted, "the hand-off ended the run, not the test's safety stop");

    const events = readEvents(repo);
    const index = (pattern: RegExp) =>
      events.findIndex((e) => e.type === "warning" && pattern.test(String(e.message)));
    const restartAt = events.findIndex((e) => e.type === "restart");
    const waitAt = index(/^restart hand-off waiting on the in-flight landing of clean, dry/);
    const lapseAt = index(/the landing of clean, dry outlived its 0\.5s deadline — aborted/);
    const stopAt = events.findIndex((e) => e.type === "orchestrator_stop");
    assert.ok(restartAt >= 0 && waitAt > restartAt, "the wait is announced once the swap is done");
    assert.ok(lapseAt > waitAt && stopAt > lapseAt, "the lapse names what was awaited, before the stop");
    const handoffMs = events[stopAt]!.ts - events[restartAt]!.ts;
    assert.ok(handoffMs < 20_000, `the hand-off did not wait out the minute-long reviewers (${handoffMs}ms)`);

    // The aborted vets are recorded like any shutdown abort: both changes `aborted`, their pins
    // kept for the new build's recovery, nothing landed, and no in-flight marker left behind.
    const failed = events.filter((e) => e.type === "land_failed").map((e) => `${e.loop}:${String(e.result)}`);
    assert.deepEqual(failed.sort(), ["clean:aborted", "dry:aborted"]);
    assert.ok(landingRefExists(repo, "clean") && landingRefExists(repo, "dry"), "both pins survive for the next generation");
    assert.ok(!fs.existsSync(path.join(repo, "clean.txt")), "nothing landed");
    assert.equal(readLandingMarker(repo), null, "no stale in-flight marker is left for the next generation");
  } finally {
    await stop();
    restore();
  }
});

test("a restart's drain aborts only its permit-holding role ticks — the in-flight landing keeps its hand-off window, and a role enabled mid-run is cut off with the startup ones", async () => {
  // BUGS.md 2026-09-30, the 13 ms landing: clean's tick holds a permit past the drain window
  // while dry's landing is mid-review when the redeploy reaches the swap. The drain's abort used
  // to fire the harness's one internal stop, killing the landing before the hand-off could wait
  // the window it announces — the "waiting" warning followed 13 ms later by `land_failed …
  // aborted`, the review thrown away. And the role the drain DOES cut off here is one enabled
  // mid-run (config-live's runner creation), the second wiring the role-only stop must reach.
  const repo = await makeFastRepo("drain role-stop test", ["dry"]);
  await seedLandQueue(repo, "dry"); // dry is interlocked: its landing runs, its tick never starts
  const reviewing = path.join(tmpdir(), "rolestop-reviewing");
  const authoring = path.join(tmpdir(), "rolestop-authoring");
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${reviewing}'; exec sleep 60;; esac; done\n` +
      `touch '${authoring}'; sleep 5`,
  );
  const { redeployer, swaps } = scriptedRedeployer(repo, {
    drainMaxMs: 1000,
    stale: () => fs.existsSync(reviewing),
  });
  const { run, stop, signal } = startRedeployRun(repo, redeployer, {
    timeoutMs: 90_000,
    handoffLandingWindowMs: 500,
  });
  try {
    await waitFor(() => fs.existsSync(reviewing), "dry's vet reviewer to be in flight");
    // Enable clean mid-run — the live-reload path, not startup — and let its tick take a permit
    // BEFORE main moves: a held poll starts no tick, so the permit holder must predate the hold.
    saveConfig(repo, fastConfig(["clean", "dry"]));
    await waitFor(() => fs.existsSync(authoring), "the mid-run role's tick to hold a permit");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under the tick and the vet");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1, "the new build was swapped in");
    assert.ok(!signal.aborted, "the hand-off ended the run, not the test's safety stop");

    const events = readEvents(repo);
    const warnings = events.filter((e) => e.type === "warning" && e.loop === "harness");
    assert.ok(
      warnings.some((e) => String((e as unknown as { message: string }).message).includes("role clean enabled — starting ticks")),
      "clean joined through the live-reload path, so its wiring is the one under test",
    );
    const indexOf = (predicate: (e: (typeof events)[number]) => boolean) => events.findIndex(predicate);
    const restartAt = indexOf((e) => e.type === "restart");
    const waitAt = indexOf(
      (e) => e.type === "warning" && /restart hand-off waiting on the in-flight landing of dry/.test(String((e as unknown as { message: string }).message)),
    );
    const lapseAt = indexOf(
      (e) => e.type === "warning" && /the landing of dry outlived its 0\.5s deadline — aborted/.test(String((e as unknown as { message: string }).message)),
    );
    const cleanAbortedAt = indexOf((e) => e.type === "tick_end" && e.loop === "clean" && e.result === "aborted");
    const dryFailedAt = indexOf((e) => e.type === "land_failed" && e.loop === "dry");
    const stopAt = indexOf((e) => e.type === "orchestrator_stop");
    // The drain cut its permit holder off AT the swap, and the landing was aborted only past its
    // deadline — never straight at the swap (the 13 ms shape). Clean's cut-off and the wait
    // warning land within milliseconds of each other, so their ORDER would race; the lapse is
    // the anchor: a runner wired to the full signal instead of roleSignal survives the drain's
    // abort and dies only when the lapse fires its abort — after the lapse warning, half a
    // window (~500 ms) late — while a correctly wired one died long before it.
    assert.ok(restartAt >= 0, "the restart fired");
    assert.equal((events[restartAt] as unknown as { abortedTicks: number }).abortedTicks, 1, "the drain counted clean's cut-off tick");
    assert.ok(cleanAbortedAt > -1, "clean's in-flight tick ended aborted");
    assert.ok(cleanAbortedAt < lapseAt, "clean's tick was cut off by the drain at the swap, not at the hand-off's lapse");
    assert.ok(waitAt > restartAt && lapseAt > waitAt && dryFailedAt > lapseAt && stopAt > dryFailedAt, "the landing got the announced window: wait, lapse, abort, stop — in that order");

    // The landing's abort is the hand-off's, recorded like any shutdown abort: pin kept for the
    // next generation, nothing landed, no stale marker.
    assert.ok(landingRefExists(repo, "dry"), "dry's pin survives for the next generation");
    assert.equal(readLandingMarker(repo), null, "no stale in-flight marker is left for the next generation");
  } finally {
    await stop();
    restore();
  }
});
