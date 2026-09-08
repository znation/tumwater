# Harness-level merge queue — land changes outside the authoring tick

Planned 2026-09-08, requested by the user (design discussion transcript: role-branch strategy).
Shared architecture for the five `Merge queue N/5` entries in PLANS.md; each of those is
independently landable and cross-references this document for the invariants below.

## The problem

A tick today is `reset → pi → commit → review gate → rebase → ff-merge`, all inside one
`LoopRunner.runTick` and all holding one of the `maxConcurrent` author slots (orchestrator.ts
acquires the semaphore around the whole tick). The two most expensive steps after `commitAll`
— the deterministic build pre-check (`npm test` on the branch) and the adversarial reviewer run
— do no authoring, yet they occupy an author slot for their whole duration. With
`maxConcurrent: 2` that means a role under review blocks a second role from authoring at all.

## The decision

Move review-and-land out of the authoring tick into harness-owned code that runs on its own
budget, and let the author's slot free the moment its commit exists.

**Not a "merge" role.** Everything the lander does is deterministic — pick the head of a queue,
rebase, run the suite, fast-forward — except conflict resolution, which is already a pi run
(merge.ts's `resolveConflict`). A role would spend a model run and its context deciding what a
loop of git commands decides better, and it would cut against the standing principle that all
git operations belong to the harness, never to pi. The lander is orchestrator code.

**Role branches keep being reset to main every tick.** The tick-start `reset --hard main` is not
overhead; it is how a role learns what every other role landed. Nothing here makes a role branch
long-lived, and no change accumulates more than one commit ahead of main.

## Invariants (none of the five entries may break these)

1. **Nothing reaches main unreviewed.** Every path that moves a commit into main routes through
   `reviewAheadOfMain` over the full `main...HEAD` diff first — the contract in
   plans/review-gate.md, unchanged. The lander is one more caller of the same gate, not a
   bypass.
2. **Linear history.** Landing stays rebase-onto-main then fast-forward (merge.ts). No merge
   commits, no remote is touched.
3. **One in-flight landing per role.** A role with a queued or landing change is not eligible to
   tick. This is what preserves today's review-feedback contract: `state.lastReview`'s rejection
   reasons always reach the author's *next* prompt (loop.ts's `tickPrompt`), and a role can never
   stack two commits on one another. The throughput win comes from *cross-role* parallelism —
   role B authors while role A's change is under review — not from letting one role run ahead.
4. **One commit ahead of main, always.** A queued change is exactly one commit; its sha is
   pinned by `refs/tumwater/landing/<role>` so resetting the role's branch cannot orphan it.
5. **Landing costs belong to the author.** The reviewer run and any conflict-resolution run fold
   into the *authoring* role's counters (generatedTokens, cost, daily budget), not into a
   pseudo-role — the dashboards keep attributing spend to the loop that caused it.
6. **A wedged lander must not freeze main.** Queue entries carry an attempt count and inherit the
   review gate's existing strike cap (`REVIEW_FAILURE_LIMIT`): past it the entry is discarded
   with a warning, exactly as leftover recovery does today.
7. **Fail closed on interruption.** A shutdown mid-landing leaves the queue entry and its ref on
   disk; the next start re-lands it through the same gate (`-recovery` session suffix).

## Shape

- `.tumwater/worktrees/_land-<role>` — one detached worktree per role where that role's change is
  reviewed and rebased. Per-role rather than one shared `_land` so two landings never wait on each
  other and 2/5 introduces no new lock; the leading underscore is the existing
  reserved-name convention (cf. the `_main` redeploy mirror). node_modules resolves by the
  build-check's existing walk-up to the repo root.
- `.tumwater/land-queue/` — durable file queue in the inbox.ts idiom (timestamped filenames, one
  JSON entry per file), so a crash loses nothing and any process can inspect it.
- `refs/tumwater/landing/<role>` — the pin from invariant 4.
- The merge lock (`.tumwater/merge.lock`) keeps its current, narrower job: guarding main's ref
  during the fast-forward.

## Sequencing

1. **1/5** — generalize the landing surface to take a worktree and a ref (seam only, no behavior
   change).
2. **2/5** — land in the per-role detached worktree, still synchronously inside the tick. The
   role's branch is reset to main the moment its commit is pinned.
3. **3/5** — make it asynchronous: the durable queue, the `queued` tick result, the orchestrator
   drain, state write-back, and the eligibility interlock. This is where the throughput win lands.
4. **4/5** — surface the queue on `status --json`, the TUI, and the GUI.
5. **5/5** — coalesce the deterministic build check across several queued landings (one suite run
   for a stack), falling back to one-at-a-time on red so attribution stays exact.

## Deliberately out of scope

Persistent, accumulating role branches. They were considered together with this queue and
rejected: divergence time is the dominant cost of a multi-role fleet, the tick-start reset is the
coordination protocol, and a review reject stops being a free `reset --hard main` once commits
stack. If a task is too big for one tick, the answer is a bounded WIP carry over the existing
`resumePending` machinery — not a long-lived branch.
