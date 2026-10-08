/** The loop e2e suite's merge-conflict slice — what happens when the landing's merge meets
 * resistance: a rebase conflict the resolution run clears, one it cannot, a stray pi commit
 * that stops the rebase twice, a dirty primary checkout that blocks the fast-forward, and
 * the pinned leftover a later tick recovers from a failed merge. Extracted from
 * loop-5.test.ts (2026-09-29) so the topic has a name instead of five rows in a numbered
 * grab-bag. The suite's slices run one test FILE per process (each file gets its own process
 * and PATH, which fakePi's global PATH swap requires — see loop-5.test.ts's header), so this
 * file runs in parallel with the numbered ones; the header's keep-them-equal balance rule
 * applies to moves between the existing slices, not to a new topic file. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { landingRefName } from "../src/paths.js";
import { eventsOfType } from "./log-fixtures.js";
import { makeLoopRunner, roleWt } from "./loop-fixtures.js";
import { landHead } from "./orchestrator-fixtures.js";
import { assertClean, initializedRepo, sh, tmpdir } from "./repo-fixtures.js";
import { conflictingMainEdit, fakePi, seedBranchEdit } from "./fake-pi.js";
import { APPROVE_PI, assistantLine, reviewerPi } from "./pi-events.js";
test("a rebase conflict is resolved by a second pi run and lands with linear history", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): edit seed.txt on the branch AND advance main with a conflicting
  // edit. Phase 2 (the resolution run): replace the conflict markers with a resolution.
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      APPROVE_PI,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      ...seedBranchEdit(),
      ...conflictingMainEdit(repo),
      `else`,
      // The resolution run emits two assistant turns on purpose (plans/commit-bodies.md
      // item c): if it leaked into the trailer's count, the Tick line below would read
      // turns 3 instead of turns 1.
      `  printf '%s\\n' '${assistantLine("looking at the conflict markers")}'`,
      `  printf '%s\\n' '${assistantLine("resolved\nSUMMARY: merged both sides")}'`,
      `  echo resolved > seed.txt`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    // The tick commits and enqueues; the LANDING is where the conflict is resolved now —
    // phase 2 (the resolution run) runs inside landHead.
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    // The resolution landed as a plain rebased commit: no merge commits on main.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
    // Self-explaining commit bodies (plans/commit-bodies.md item c): the trailer counts
    // only the authoring run's turns — the reviewer and conflict-resolution runs fold into
    // tickTurns after the trailer string is already assembled.
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 1 · ctx 0$/m);
    // Routine conflict → pi-resolve → land is normal operation, not something to warn
    // about: the merged event and tick_end already cover observability.
    const warnings = eventsOfType(repo, "warning");
    assert.equal(
      warnings.length,
      0,
      `expected no warning events, got: ${JSON.stringify(warnings.map((w) => w.message))}`,
    );
  } finally {
    restore();
  }
});

test("an unresolvable conflict aborts cleanly and reports merge_conflict", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      APPROVE_PI,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      ...seedBranchEdit(),
      ...conflictingMainEdit(repo),
      `fi`, // Phase 2 does nothing: the conflict markers stay.
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    const wt = roleWt(repo, "improve");
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
    // No rebase is left in progress: the checkout is clean, not stopped mid-rebase with
    // conflict markers. (After the pool the role's checkout is detached on release, so the
    // old symbolic-ref assertion no longer applies.)
  } finally {
    restore();
  }
});

// A pi that commits during the tick (forbidden by the prompt, but a confused pi might do it)
// leaves an extra commit under the harness's own commit. When the merge's rebase stops on
// the stray one and the resolution run ALSO commits its resolution, `rebase --continue`
// replays the remaining authoring commit onto that stray commit, hits a SECOND conflict,
// and throws — landing-merge.ts's catch must abort cleanly and report merge_conflict instead of
// crashing or landing broken work (the only path that reaches it; see continueRebase's doc
// comment). Phase detection in the shim: reviewer runs carry VERDICT:, resolution runs find
// conflict markers in seed.txt, everything else is the authoring run.
test("a stray pi commit makes rebase --continue stop a second time: aborted, merge_conflict", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      APPROVE_PI,
      // Phase 2 (the resolution run): seed.txt carries conflict markers — resolve them, then
      // commit anyway. That stray commit is what `rebase --continue` replays the remaining
      // authoring commit onto.
      `if grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  echo resolved > seed.txt`,
      `  git add -A && git commit -m "stray resolver commit"`,
      `else`,
      // Phase 1 (the tick): pi commits its first edit itself (a stray commit the harness
      // never reviewed as such), then leaves a second edit uncommitted — the harness's
      // commitAll lands it on top, so the branch is two commits ahead of main. Main advances
      // with an edit that conflicts with the STRAY one, so the rebase stops there first.
      `  echo branch change 1 > seed.txt`,
      `  git add -A && git commit -m "stray authoring commit"`,
      `  echo branch change 2 > seed.txt`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      ...conflictingMainEdit(repo),
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the tick commits and enqueues; the conflict is the landing's");
    assert.equal(
      await landHead(repo, runner, defaultConfig(), "improve"),
      "merge_conflict",
      "the second conflict is reported, not crashed on",
    );
    // Nothing landed: main keeps its version…
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    // …and both of the tick's commits are kept for recovery — pinned by the landing ref (the
    // pin names the top commit, which contains the stray one below it).
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the tick's commits are kept for recovery via the pin");
    const wt = roleWt(repo, "improve");
    // No rebase is left in progress: no conflict markers survive, and the checkout is clean.
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
  } finally {
    restore();
  }
});

test("a dirty primary checkout blocks the fast-forward: merge_blocked, commit kept for recovery", async () => {
  const repo = await initializedRepo();
  // The user has uncommitted edits to seed.txt in the PRIMARY checkout (on main). The tick's
  // branch changes the same file, so `git merge --ff-only` must refuse to overwrite the local
  // edit — the one way ffMainTo fails after a clean rebase. A broken failure path here
  // would either clobber the user's work or report "changed" for work that never landed.
  const restore = fakePi(
    [
      // The review gate (any run whose prompt asks for a VERDICT) approves, so the tick reaches
      // the merge and can be blocked there.
      APPROVE_PI,
      ...seedBranchEdit(),
    ].join("\n"),
  );
  try {
    fs.writeFileSync(path.join(repo, "seed.txt"), "user's uncommitted edit\n");
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_blocked");
    // The user's local edit survives — the blocked merge must not touch it.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "user's uncommitted edit\n");
    // main did not move; the tick's commit is kept in its landing pin for the next tick's
    // recovery — and the role worktree is clean at main whatever the landing outcome.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the blocked commit is pinned for recovery");
    assertClean(roleWt(repo, "improve"), "role worktree clean at main");
    assert.match(sh(repo, "git", "show", "main:seed.txt"), /^seed$/);
    // The failure is recorded on the state; the retry rides the next tick's leftover recovery
    // at the role's NORMAL cadence — the tick itself was productive (it committed), so no
    // idle backoff applies to a landing failure.
    assert.equal(runner.state.lastError, "merge failed: merge_blocked");
    assert.ok(runner.state.nextRunAt > Date.now());
  } finally {
    restore();
  }
});

test("leftover commits from a failed merge are recovered on the next tick", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  const m2 = path.join(tmpdir(), "phase2");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // now routes through): approve, so the leftover may land. Phase 1 (tick 1): edit
  // seed.txt on the branch AND advance main with a conflicting edit. Phase 2 (tick 1's
  // resolution run): leave the markers — the merge fails and the tick's commit is left
  // stranded on the branch. Phase 3 (the re-queued landing's resolution run): resolve them
  // this time.
  const restore = fakePi(
    [
      reviewerPi(`VERDICT: approve\n1. checked the diff; it holds`),
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      ...seedBranchEdit(),
      ...conflictingMainEdit(repo),
      `elif [ ! -f "${m2}" ]; then`,
      `  touch "${m2}"`, // Unresolvable on the first attempt.
      `else`,
      `  if grep -q '<<<<<<<' seed.txt 2>/dev/null; then echo resolved > seed.txt`,
      `  else printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    // Tick 1 commits and enqueues; its landing hits the conflict and fails (the m2 phase
    // leaves the markers): that conflict state is what tick 2's recovery must salvage.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
    // The landing's commit is pinned by its landing ref: that is what recovery must salvage.
    // (The role branch itself is clean at main — the pin is the leftover now.)
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the failed merge's commit is pinned for recovery");

    // Tick 2's recovery puts the pin back on the land queue and ends the tick there; the
    // landing slot then lands it.
    assert.equal((await runner.tick()).result, "queued", "tick 2 re-queued the leftover instead of authoring");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    // The stranded work landed on main via recovery.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    const merged = eventsOfType(repo, "merged");
    assert.ok(
      merged.some((e) => String(e.summary) === "recovered leftover work from improve: branch edit of seed"),
      "recovery is recorded as a merge of the leftover work, naming its subject",
    );
    // The branch is reset to main afterwards, so nothing is stranded twice.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});
