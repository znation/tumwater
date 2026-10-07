# Revise rejected changes

Planned 2026-10-06 · refined 2026-10-07 (part 2/2: the re-review's prior context) · from the
2026-10-06 review-gate audit

## Goal

A change the review gate rejects goes back to its author for at most two revision rounds. The
author's next tick starts from the rejected diff re-applied onto current main as uncommitted
edits, fixes the named objections (or drops the change), and the result lands through the
normal gate. The re-review is shown the prior review's numbered objections and the interdiff
between the rejected version and the revision, and checks each objection first.

## Motivation

A 2026-10-06 audit of the review gate (events.jsonl since 2026-09-22) found a 14% rejection
rate, and rejected changes consumed about 21% of recorded authoring spend. Of the rejections
that were not build-check failures, 77% were fixable by a message fix, a BUGS/PLANS fix, or a
few-line code change — but the reject path discarded the work, so the author re-derived the
whole change from scratch and each rewrite drew a fresh, different set of objections. Showing
the re-review what the revision had to resolve closes the loop: an unresolved prior objection
is itself a finding, so rounds cannot drift onto unrelated complaints.

## Design

### Keep the rejected change

- `rejectedRefName(role)` (`src/paths.ts`) is `refs/tumwater/rejected/<role>`. On a gate
  rejection, `recordRejectedChange` (`src/landing/landing-core.ts`) points it at the rejected
  head and sets `LoopState.revision = { sha, round, at }` while the next round is within
  `REVISION_LIMIT`. Past the limit it clears the revision, deletes the ref, marks
  `lastReview.exhausted`, and logs a `revision` `exhausted` event. The director never revises.
- `REVISION_LIMIT = 2` (`src/loop/revision.ts`). Both a pinned change's rejection and the
  in-lock conflict-resolution re-review's rejection record the change the same way.
- The round rides the commit's harness-stamped `Revision: N` trailer
  (`src/git/commit-message.ts`) as well as `LandingEntry.revisionRound`, so a retriable
  revision whose queue marker is lost keeps its round through leftover recovery.

### Re-apply on the author's next tick

- `applyRevision` (`src/loop/revision.ts`) runs `git cherry-pick --no-commit
  <merge-base>..<sha>`, leaving the rejected diff as uncommitted edits on current main. A
  conflict aborts the cherry-pick, resets to main, returns false, logs a `revision` `conflict`
  event, and the prompt falls back to the plain rejected note plus a sentence that the diff no
  longer applies.
- `LoopRunner.runTick` (`src/loop/loop.ts`) applies the revision after the worktree is reset to
  main and the red-main gate, only for a role tick that dequeued no user request. `revisionRound`
  on the tick context records that this tick holds the rejected diff, so a pending revision a
  user-request tick leaves untouched is not mistaken for one.
- `buildRevisionNote` (`src/gates/gate-prompts.ts`) replaces the plain rejected note on a
  revision tick: it numbers the objections, asks for the smallest edit that resolves each, and
  offers the nothing-to-do sentinel for a change whose premise the objections disproved. A
  revision tick that declares nothing-to-do resets the worktree, clears the revision, and ends
  `no_change`.
- A landed revision deletes the rejected ref (`src/landing/landing-pipeline.ts`); a further
  rejection repoints or deletes it.

### The re-review's prior context

- `LandingEntry` and `LandRequest` carry `priorReview = { sha, reasons }`
  (`src/landing/landing-queue.ts`, `src/landing/landing-core.ts`). `stageTickLanding`
  (`src/tick/tick-stage.ts`) fills it from `LoopState.lastReview` only when the tick held the
  rejected diff. It rides the landing pipeline through `landing-vetting.ts` and
  `landing-drain.ts` onto the vet's `LandRequest`. A recovery landing (`src/loop/leftover.ts`)
  carries none, so an orphaned revision is reviewed like a fresh change.
- `revisionInterdiff` (`src/git/git-diff.ts`) runs `git range-diff --creation-factor=100
  <base-of-prior>..<prior> <base-of-head>..<head>`, where each base is that version's
  merge-base with main (`changeBaseRev` gains a `rev` argument). Measuring each side from its
  own base keeps main's movement between the two versions out of the interdiff. The output is
  capped like the ahead-of-main diff and is empty on any git failure, including a prior object
  that is gone. The high creation factor makes range-diff pair the versions even for a tiny
  change; at the default a small revision renders as two unrelated commits.
- `buildReviewPrompt` (`src/gates/gate-prompts.ts`) gains an optional prior-review block,
  placed after the author's commit body: the round, the numbered prior objections, the
  interdiff, and the instruction to check each objection first, with an unresolved one a
  rejection on its own. Without a prior review the block is absent and the prompt is unchanged.
  The literal `VERDICT:` still appears exactly twice.
- A revision's `review_start` event carries `revision: N`, rendered as `(revision N)` in
  `tumwater logs` (`src/review/review.ts`, `src/events/event-format.ts`).

## Limits

- The director never revises; its rejections are final.
- A recovered revision keeps its round from the commit trailer but is reviewed without the
  prior block, since the landed entry carries no `priorReview`.
- The revision still passes the full review gate: the prior context is additional, not a
  substitute for reviewing the whole diff.
