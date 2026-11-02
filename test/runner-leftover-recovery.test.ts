/** The runner e2e suite's leftover-recovery slice — how a committed-but-unmerged change (the
 * merge pin) is recovered by a later run: re-merged through the gate, dropped with an
 * author-facing reason once it exhausts the merge-conflict cap, or failed closed so a
 * shutdown mid-merge survives for next-start recovery. Extracted from runner-3.test.ts
 * (2026-09-29) so the topic has a name instead of nine rows in a numbered grab-bag. The
 * suite's slices run one test FILE per process (each file gets its own process and PATH,
 * which fakePi's global PATH swap requires — see runner-3.test.ts's header), so this file
 * runs in parallel with the numbered ones; the header's keep-them-equal balance rule applies
 * to moves between the existing slices, not to a new topic file. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MERGE_CONFLICT_LIMIT } from "../src/runner/runner-leftover.js";
import { defaultConfig } from "../src/config/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox/inbox.js";
import { readEvents } from "../src/events/event-read.js";
import { setRef } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { enqueueMerge, headMerge, queueDepth } from "../src/merge/merge-queue.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeRoleRunner, roleWt, runAbortedDirectorMerge } from "./fixtures/runner-fixtures.js";
import { mergeHead, mergeRefExists } from "./fixtures/orchestrator-fixtures.js";
import { assertClean, headSha, initializedRepo, mainSha, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";

/** Simulate an interrupted run's leftover — the crash state every test in this file starts
 * from: detach, commit work main does not contain, return to main, and pin the commit with the
 * role's merge ref — the on-disk state a shutdown between the run's commitAll and its
 * merge leaves. Returns the pinned sha. */
async function pinLeftover(
  repo: string,
  file: string,
  content: string,
  message: string,
  role = "improve",
): Promise<string> {
  const sha = pinOffMain(repo, (d) => fs.writeFileSync(path.join(d, file), content), message);
  await setRef(repo, mergeRefName(role), sha);
  return sha;
}
import { conflictingMainEdit, seedBranchEdit, withPi } from "./fakes/fake-pi.js";
import { APPROVE_PI, assistantLine, reviewerPi } from "./fixtures/pi-events.js";

// A failed review retries in place (src/review/review.ts); the pause between tries is not tested.
process.env.TUMWATER_REVIEW_RETRY_DELAY_MS = "0";
// The crash path of plans/merge-queue.md invariant 7: a shutdown between the run's commitAll
// and its merge leaves the pin on disk (the branch is already reset to main). The next run
// must re-merge that sha through the SAME gate — reviewed, never smuggled in unreviewed.
test("a merge pin left behind by an interrupted run is re-merged through the gate on the next run", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit not contained in main, pinned by the merge ref, with the
  // role branch back at main.
  const sha = await pinLeftover(repo, "crash.txt", "interrupted work\n", "interrupted run's commit");

  // The next run's recovery puts the pin on the merge queue; the merge slot re-merges it
  // through the full gate: approve → merge. The authoring branch would make a change, so a run
  // that authored instead of ending on the recovery would show up as a second queued entry.
  const authored = path.join(tmpdir(), "authored");
  await withPi(
    [
      APPROVE_PI,
      `touch "${authored}"`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: new work")}'`,
      `echo new > new.txt`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      const outcome = await runner.run();

      // Merge-queue speed 3c — main has one writer: the run QUEUES the leftover like a fresh
      // changed run and never merges it itself.
      assert.equal(outcome.result, "queued");
      assert.equal(outcome.commit, sha);
      assert.equal(outcome.summary, "recovered leftover work from improve: interrupted run's commit");
      assert.ok(!fs.existsSync(authored), "the recovery run ran no authoring pass");
      assert.notEqual(mainSha(repo), sha, "nothing merged inside the run");
      const runEvents = readEvents(repo);
      assert.deepEqual(
        runEvents.filter((e) => e.type === "merge_queued").map((e) => e.commit),
        [sha],
        "the run logged exactly one merge_queued, for the pin",
      );
      assert.equal(runEvents.filter((e) => e.type === "merged").length, 0, "no in-run merged");
      assert.equal(queueDepth(repo), 1);
      assert.equal(headMerge(repo)?.entry.sha, sha);
      // The interlock state the orchestrator reads: the queued summary waits for the merge.
      assert.equal(runner.state.queuedSummary?.sha, sha);

      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "changed");
      // The interrupted work merged on main via recovery — reviewed, not smuggled in.
      assert.equal(mainSha(repo), sha);
      assert.ok(fs.existsSync(path.join(repo, "crash.txt")), "the recovered file is on main");
      const merged = eventsOfType(repo, "merged");
      assert.ok(
        merged.some(
          (e) => String(e.summary) === "recovered leftover work from improve: interrupted run's commit",
        ),
        "recovery is recorded as a merge of the leftover work, naming its subject",
      );
      assert.ok(!mergeRefExists(repo, "improve"), "the pin was deleted once the work merged");
    },
  );
});

// A pin whose every merge ended in a conflict the resolver could not settle used to re-queue
// forever once recovery stopped merging in-run (3c): the role never authored again. At
// MERGE_CONFLICT_LIMIT recovery hands the pin back to its author: the diff is re-applied over
// current main with the markers in place, and the author resolves them in the same run
// (PLANS.md "Robust conflict landing, part 2/2").
test("a pin at the merge-conflict cap is handed back and the run resolves it in place", async () => {
  const repo = await initializedRepo();
  // The pin edits seed.txt; main then moves the same line, so re-applying the pin conflicts.
  const sha = await pinLeftover(repo, "seed.txt", "branch version\n", "work main outgrew");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "commit", "-am", "main moved the same line");

  const prompts = path.join(tmpdir(), "prompts.log");
  await withPi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      // Resolve the markers the hand-back left, then finish normally.
      `echo resolved > seed.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: resolved the hand-back")}'`,
      `echo new > new.txt`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      runner.state.mergeConflicts = { sha, count: MERGE_CONFLICT_LIMIT };
      const outcome = await runner.run();

      assert.equal(outcome.result, "queued", "the run authored and queued the resolved change");
      assert.notEqual(outcome.commit, sha);
      assert.equal(outcome.recoveredLeftover, undefined, "not a recovery run");
      const prompt = fs.readFileSync(prompts, "utf8");
      assert.match(prompt, /conflict-handback/);
      assert.match(prompt, /Conflicted files:\n- seed\.txt \(conflict hunks at lines 1-\d+\)\n/);
      assert.match(prompt, /main moved the same line/, "the prompt shows what main changed");
      assert.doesNotMatch(prompt, /was discarded without merging/);
      assert.equal(runner.state.conflictHandback?.reason, "merge");
      assert.equal(runner.state.conflictHandback?.applied, true, "the hand-back was applied this run");
      assert.equal(runner.state.mergeConflicts, undefined, "the streak ended with the hand-back");
      const queued = eventsOfType(repo, "merge_queued").map((e) => e.commit);
      assert.deepEqual(queued, [outcome.commit], "the resolved change was queued");
      assert.equal(headMerge(repo)?.entry.sha, outcome.commit);
      assert.deepEqual(
        eventsOfType(repo, "conflict_handback").map((e) => e.action),
        ["queued", "applied"],
        "the hand-back is logged queued then applied",
      );
    },
  );
});

// The other side of the same cap: when the lineage already used its one hand-back and still
// conflicts, recovery drops the pin and the prompt tells the author its work is gone, so it
// redoes the change against current main instead of re-applying the stale diff.
test("a pin at the cap whose lineage already used its hand-back is discarded and the author starts fresh", async () => {
  const repo = await initializedRepo();
  // The pin edits seed.txt; main then moves the same line, so re-applying the pin would conflict.
  const sha = await pinLeftover(repo, "seed.txt", "branch version\n", "work main outgrew");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "commit", "-am", "main moved the same line");

  const prompts = path.join(tmpdir(), "prompts.log");
  await withPi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo fresh > fresh.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: redid the change on current main")}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      runner.state.mergeConflicts = { sha, count: MERGE_CONFLICT_LIMIT };
      // A hand-back is already on record for this lineage, so the cap means discard, not hand back.
      runner.state.conflictHandback = { sha, at: Date.now(), reason: "merge", applied: false };
      const outcome = await runner.run();

      assert.equal(outcome.result, "queued", "the run authored a fresh change and queued it");
      assert.notEqual(outcome.commit, sha);
      const prompt = fs.readFileSync(prompts, "utf8");
      assert.match(prompt, /was discarded without merging/);
      assert.match(prompt, /"work main outgrew"/, "the note names the discarded change by its subject");
      assert.doesNotMatch(prompt, /conflict-handback/);
      assert.equal(runner.state.mergeConflicts, undefined, "the conflict streak is cleared");
      assert.equal(runner.state.conflictHandback, undefined, "the stale hand-back is cleared");
      assert.equal(runner.state.conflictDiscard, undefined, "the delivered note is cleared once the author commits");
      assert.equal(headMerge(repo)?.entry.sha, outcome.commit, "the queue holds only the fresh change");
      assert.deepEqual(eventsOfType(repo, "merge_queued").map((e) => e.commit), [outcome.commit]);
      assert.ok(
        eventsOfType(repo, "warning").some((e) => String(e.message).includes('discarding leftover')),
        "a warning names the discard",
      );
    },
  );
});

// A persisted hand-back whose diff cannot be re-applied at all — the object is gone, or the apply
// fails for a reason other than a conflict — is dropped rather than retried every run: the
// merge ref goes with it, the failure is logged, and the author starts fresh on current main.
test("a hand-back whose diff no longer applies is dropped and the author starts fresh", async () => {
  const repo = await initializedRepo();
  const missing = "0".repeat(40);
  const prompts = path.join(tmpdir(), "handback-failed-prompts.log");
  await withPi(
    [
      `printf '%s\n' "$@" >> "${prompts}"`,
      `echo fresh > fresh.txt`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: started fresh")}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      runner.state.conflictHandback = { sha: missing, at: Date.now(), reason: "merge", applied: false };
      const outcome = await runner.run();

      assert.equal(outcome.result, "queued", "the run authored a fresh change and queued it");
      const prompt = fs.readFileSync(prompts, "utf8");
      assert.doesNotMatch(prompt, /conflict-handback/, "the author is not asked to resolve a diff that is gone");
      assert.equal(runner.state.conflictHandback, undefined, "the unappliable hand-back is dropped");
      assert.deepEqual(
        eventsOfType(repo, "conflict_handback").map((e) => [e.action, e.sha]),
        [["failed", missing]],
        "the failure is logged with the hand-back's sha",
      );
      assert.equal(headMerge(repo)?.entry.sha, outcome.commit, "only the fresh change is queued");
    },
  );
});

// A director run dequeues its user prompt before recovery runs; a run that ends on the
// recovery never ran that prompt, so it must go back to the inbox — the same policy as every
// other unfulfilled director outcome. (A user abort of the queued recovery merge is the
// merge slot's to handle now: merge-drain.test.ts pins that it discards the pin.)
test("a director run that ends on leftover recovery puts its user prompt back", async () => {
  const repo = await initializedRepo();
  const sha = await pinLeftover(repo, "crash.txt", "interrupted work\n", "interrupted director commit", "director");
  const ran = path.join(tmpdir(), "ran");
  await withPi(`touch "${ran}"; printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`, async () => {
    enqueuePrompt(repo, "important request");
    const runner = makeRoleRunner(repo, "director");
    const outcome = await runner.run();
    assert.equal(outcome.result, "queued", "the director's leftover went on the merge queue");
    assert.equal(headMerge(repo)?.entry.sha, sha);
    assert.ok(!fs.existsSync(ran), "no pi run: the prompt was never executed");
    assert.equal(inboxSize(repo), 1, "the prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
  });
});

test("a promptless director with a kept pin re-queues it, runs no pi, and keeps a pending image reroute", async () => {
  const repo = await initializedRepo();
  const sha = await pinLeftover(repo, "crash.txt", "interrupted work\n", "interrupted director commit", "director");
  const ran = path.join(tmpdir(), "ran");
  await withPi(`touch "${ran}"; printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`, async () => {
    const runner = makeRoleRunner(repo, "director");
    runner.state.imageReroute = { tier: "default" };
    const outcome = await runner.run();
    assert.equal(outcome.result, "queued");
    assert.equal(headMerge(repo)?.entry.sha, sha);
    assert.ok(!fs.existsSync(ran), "no pi run");
    assert.equal(eventsOfType(repo, "prompt_taken").length, 0);
    assert.deepEqual(runner.state.imageReroute, { tier: "default" }, "the reroute waits for a prompt");
  });
});

test("a promptless director whose pin hit the conflict cap keeps it untouched and skips, owing the hand-back to its next prompt", async () => {
  const repo = await initializedRepo();
  const sha = await pinLeftover(repo, "seed.txt", "branch version\n", "director work main outgrew", "director");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "commit", "-am", "main moved the same line");
  const ran = path.join(tmpdir(), "ran");
  await withPi(`touch "${ran}"; printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`, async () => {
    const runner = makeRoleRunner(repo, "director");
    runner.state.mergeConflicts = { sha, count: MERGE_CONFLICT_LIMIT };
    const outcome = await runner.run();
    assert.equal(outcome.result, "skipped");
    assert.ok(!fs.existsSync(ran), "no pi run");
    assert.ok(mergeRefExists(repo, "director"), "the pin is kept for its hand-back");
    assert.deepEqual(runner.state.mergeConflicts, { sha, count: MERGE_CONFLICT_LIMIT });
    assert.equal(runner.state.conflictHandback, undefined, "the hand-back is still owed");
    assert.equal(headMerge(repo), null, "nothing was queued");
  });
});

test("a promptless director with no pin skips and touches nothing", async () => {
  const repo = await initializedRepo();
  const runner = makeRoleRunner(repo, "director");
  const outcome = await runner.run();
  assert.equal(outcome.result, "skipped");
  assert.equal(headMerge(repo), null);
});

// The no-pin crash window: a shutdown between the run's commitAll and its pin write leaves the
// commit on the role branch with NO merge ref. Recovery must fall back to the branch tip so
// invariant 1 (a shutdown between commit and merge loses nothing) holds whether or not the
// pin survived.
test("an unpinned commit ahead of main is recovered from the branch tip", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit on the role branch, no merge ref written.
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "unpinned.txt"), "committed but unpinned\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "the pin write never happened");
  const sha = headSha(wt);

  // The next run's recovery finds no ref but a branch ahead of main: it re-merges the tip.
  await withPi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      assert.equal((await runner.run()).result, "queued", "recovery adopted and queued the tip");
      // The role worktree is freed as soon as the adopted pin holds the commit.
      assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "changed");

      // The unpinned work merged on main via recovery — reviewed, not smuggled in.
      assert.equal(mainSha(repo), sha);
      assert.ok(fs.existsSync(path.join(repo, "unpinned.txt")), "the recovered file is on main");
      const merged = eventsOfType(repo, "merged");
      assert.ok(
        merged.some(
          (e) => String(e.summary) === "recovered leftover work from improve: the pin write never happened",
        ),
        "recovery is recorded as a merge of the leftover work, naming its subject",
      );
      // The role worktree is clean at main whatever recovery did.
      assertClean(roleWt(repo, "improve"));
      assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    },
  );
});

// The interlock relief (plans/interlock-relief.md part 2/4, now team-wide per part 3i/3): when
// a role has a queued change and its branch is at main, recovery reports `already_queued`, and
// that arm falls through to author instead of ending the run — the fall-through IS the run the
// scheduler admits (part 3/4). The relief holds for every role: no role waits on a reviewer, so
// no role's `already_queued` membership test ends the run.
test("a role with an already_queued recovery falls through to author", async () => {
  const repo = await initializedRepo();
  enqueueMerge(repo, { role: "bugfix", sha: "a".repeat(40), run: 3, summary: "queued change", enqueuedAt: Date.now() });
  const authored = path.join(tmpdir(), "authored");
  await withPi(
    [
      `touch "${authored}"`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: follow-up work")}'`,
      `echo followup > followup.txt`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "bugfix");
      const outcome = await runner.run();

      assert.ok(fs.existsSync(authored), "the already_queued run reached the author");
      // The authored follow-up is held on the branch (part 1/4): the role still has a queued entry.
      assert.equal(outcome.result, "queued", "the run ended queued, holding its commit on the branch");
      assert.equal(headMerge(repo)?.entry.sha, "a".repeat(40), "the queued entry is untouched");
    },
  );
});

test("an already_queued recovery from any role falls through to author", async () => {
  const repo = await initializedRepo();
  enqueueMerge(repo, { role: "improve", sha: "a".repeat(40), run: 3, summary: "queued change", enqueuedAt: Date.now() });
  const authored = path.join(tmpdir(), "authored");
  await withPi(
    [`touch "${authored}"`, `printf '%s\n' '${assistantLine("ok\nSUMMARY: follow-up work")}'`, `echo followup > followup.txt`].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      const outcome = await runner.run();

      assert.ok(fs.existsSync(authored), "the already_queued run reached the author for any role");
      // The authored follow-up is held on the branch (part 1/4): the role still has a queued entry.
      assert.equal(outcome.result, "queued", "the run ended queued, holding its commit on the branch");
      assert.equal(headMerge(repo)?.entry.sha, "a".repeat(40), "the queued entry is untouched");
    },
  );
});

test("an unmergeable leftover is retried on the next run and keeps its merge pin", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // routes through): approve, so recovery reaches the merge and can fail there. Phase
  // 1 (run 1): branch edit + conflicting main advance. Every conflict-resolution run
  // (detected by markers in seed.txt) leaves the markers: unresolvable, both runs.
  await withPi(
    [
      reviewerPi(`VERDICT: approve\n1. checked the diff; it holds`),
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      ...seedBranchEdit(),
      ...conflictingMainEdit(repo),
      `elif grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  : # leave the markers in place (unresolvable)`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      assert.equal((await runner.run()).result, "queued");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");

      // Run 2: recovery re-queues the pin, and its merge goes through the same gate (the early
      // approved return — no reviewer run — since the first merge's gate already signed off on
      // this HEAD) and hits the same unresolvable conflict.
      assert.equal((await runner.run()).result, "queued");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");

      // merge_conflict is non-terminal: a fresh-context retry may resolve what two consecutive
      // attempts could not (a bounded attempt count ships with merge queue 3/5; review failures
      // have their own strike cap). The pin survives for the next run's retry, and main keeps
      // its version either way.
      const pinned = sh(repo, "git", "rev-parse", "--verify", mergeRefName("improve")).trim();
      assert.ok(pinned.length === 40, "the unmergeable commit is kept for the next run's retry");
      assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n");
      assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    },
  );
});

// A failed gate on a re-queued leftover keeps its pinned commit for the next run's retry — the
// keep, not discard, a pre-merge review failure used to leave. Re-pointed to a deterministic gate
// rejection (a conflicting re-apply leaves unresolved conflict markers, so the merge ends
// `merge_conflict` and the pin survives) so the case no longer drives the pre-merge reviewer. The
// reviewer-run fake below only approves so the merge can reach the conflict; part 3h/3 removed
// that run and the approve goes unused.
test("a failed gate keeps the recovered pinned commit for the next run's retry", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // routes through): approve, so recovery reaches the merge and can fail there. Phase
  // 1 (run 1): branch edit + conflicting main advance. Every conflict-resolution run
  // (detected by markers in seed.txt) leaves the markers: unresolvable, both runs.
  await withPi(
    [
      reviewerPi(`VERDICT: approve\n1. checked the diff; it holds`),
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      ...seedBranchEdit(),
      ...conflictingMainEdit(repo),
      `elif grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  : # leave the markers in place (unresolvable)`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      assert.equal((await runner.run()).result, "queued");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
      // The failed merge's commit is pinned for the next run's retry; the worktree is clean.
      assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
      const pinned = sh(repo, "git", "rev-parse", "--verify", mergeRefName("improve")).trim();
      assert.ok(pinned.length === 40, "the failed merge's commit is pinned for the next run's retry");

      assert.equal((await runner.run()).result, "queued", "run 2 re-queued the pin");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");

      // The pin survives the second failure too, just as a failed review's pin did, and the role
      // worktree stays clean at main whatever recovery does.
      assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
      const wt = roleWt(repo, "improve");
      assertClean(wt, "no uncommitted edits remain");
      // Run 2's own result was `queued`; the first merge's failure (still in the shared
      // `lastError` when run 2 started) must not latch onto its `run_end` as the run's error
      // (BUGS.md 2026-09-21). The merge_conflict events above are where the merge failures live.
      const runEnds = eventsOfType(repo, "run_end");
      const run2End = runEnds[runEnds.length - 1]!;
      assert.equal(run2End.result, "queued");
      assert.equal(run2End.error, undefined, "a healthy run's run_end carries no stale merge error");
    },
  );
});

test("a shutdown mid-merge fails closed: the pinned commit survives for next-start recovery", async () => {
  const repo = await initializedRepo();
  // Author run (the run prompt): make a change and finish. The director's merge then runs its
  // gate (the declared check parks until released), and the shutdown aborts it — simulating
  // Ctrl+C while the MERGE is under its gate. Since merge queue 3/5 the gate runs in the
  // merge, not the run, so the shutdown hits the merge's signal — the same wiring the
  // orchestrator's pipeline uses. The park is the deterministic gate check, not the reviewer.
  await runAbortedDirectorMerge(repo);
});
