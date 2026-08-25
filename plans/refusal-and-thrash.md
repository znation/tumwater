# The right to refuse, and friction as a signal

Planned 2026-08-24 · refined 2026-08-25 (discard semantics, md-only detection, thrash data
sources) · from the "Senior Tumwater" report (HN 49421554) · report item R2

## Goal

Loops can decline work. A loop that concludes its task would harm the architecture — or that keeps
fighting back — stops, records *why* durably, and ends the tick as a first-class `refused` outcome
instead of shipping a forced fit. High-friction ticks that do ship are flagged for extra review
scrutiny.

## Motivation

HN commenter **kypro**: "complexity simply must have limits… someone must manage it" — agents that
never refuse produce unmaintainable codebases. **matsemann**: discovering a feature is harder than
expected was historically a signal it didn't fit the system; LLMs "happily chug along," shipping
hacks upon hacks. Today's prompts say "do ONE task" and offer only done/nothing-to-do; refusal is
not in the vocabulary.

## Design

- **Sentinel protocol** (`src/prompt.ts`): alongside `TUMWATER_NOTHING_TO_DO`, add
  `TUMWATER_REFUSED: <one-line reason>`. New COMMON_RULES bullet: "If partway in you conclude the
  task would harm the project — it violates PRINCIPLES.md, grows complexity without justification,
  or keeps fighting back — revert nothing yourself; record your objection as a note in PLANS.md
  (for a planned feature: annotate its entry) or BUGS.md, and end your reply with the sentinel.
  That recording edit is the only change a refusing run should leave."
- **Parser** (`src/pi.ts`): `PiStreamParser` detects the sentinel in any assistant message (same
  pattern as `declaredNothingToDo`) and captures the reason → `PiRunResult.refused` /
  `refusedReason`.
- **Loop** (`src/loop.ts`): outcome `refused` (new `TickResult`). The harness classifies what
  the run left behind with a new git helper `changedFiles(wt): string[]` (parse
  `git status --porcelain`, paths only — covers modified, untracked, and deleted; no such lister
  exists today, only `isDirty`). Then:
  - **All changed files are markdown** (`*.md`): commit them as
    `tumwater(<role>): refuse — <reason>` via the existing `commitAll` and merge (md-only, so
    review-exempt by construction under [review-gate.md](review-gate.md)).
  - **Non-markdown changes are present**: a refusal must not half-ship, but the objection note is
    the durable record and must survive. Stage only the markdown files (`git add -- <paths>`),
    commit them with the same subject, then discard every remaining change — `git reset --hard
    HEAD` for tracked edits plus `git clean -fd` for untracked files (the committed note is safe at
    HEAD). Fold this into one small helper in src/git.ts. Merge as above.
  - **No markdown note was left**: nothing to commit — reset the worktree to main and let the
    sentinel's reason live only in the event + `lastSummary`.
  Backoff as for `no_change` (`nextBackoffSeconds`, the existing scheduling line); set
  `lastResult = "refused"` and make `lastSummary` the reason — the status/GUI result cell renders
  arbitrary strings, so no new rendering code is needed.
- **Thrash detection** (`src/loop.ts`, measured at tick end): pi runs autonomously, so mid-run
  intervention is out of scope — instead measure after: if a changed tick used more than
  `thrashTurns` assistant turns (config, default 40) or ran longer than `thrashMinutes` (default
  60), mark the outcome `highFriction: true`, log a `warning` event, and — once the review gate
  exists — include the flag in the review prompt so the reviewer applies extra scrutiny. The
  commit-body note ("high-friction change: N turns / M minutes") lands with
  [commit-bodies.md](commit-bodies.md), which already reserves that trailer line; until then the
  event and `lastSummary` carry it. Friction becomes data instead of disappearing.
  Data sources: turn count is a small `PiStreamParser` addition (a counter over assistant
  message-end events) exposed as `PiRunResult.turns` — commit-bodies.md needs the same field for
  its trailer, so
  whichever plan lands first adds it and the other reuses; duration is wall-clock in `runTick`
  (no parser change). Do not reuse `progress.ts`'s live counters: those describe the log tail for
  dashboards, not a finished run's totals.
- **Prompt encouragement** (`src/roles.ts`): the feature role's find text gains one line: a plan
  that resists implementation is a finding — refuse with the objection recorded rather than
  forcing it.
- **Dashboards**: `refused` rendered like `no_change` but with the reason; totals unaffected.

## Files touched

`src/prompt.ts`, `src/pi.ts` (sentinel + turn counter), `src/git.ts` (`changedFiles` + the
selective commit/discard helper), `src/loop.ts`, `src/types.ts` (TickResult, PiRunResult.turns,
config fields), `src/config.ts` (thrash thresholds + validation), `src/roles.ts`,
`test/refusal.test.ts` (sentinel parse; md-only refusal commits and merges; mixed refusal keeps
the note and discards tracked *and* untracked code changes; no-note refusal resets cleanly;
thrash flag set past either threshold), README. No status-render/gui-page change: `refused`
shows up in both tables for free once `lastResult` is set.

## Acceptance criteria

- A fake-pi run ending `TUMWATER_REFUSED: reason` with a PLANS.md note yields outcome `refused`,
  the note lands on main, and both dashboards show the reason in the result cell.
- A refusal that also edited code keeps the markdown note (committed and merged) and discards
  every non-markdown change — tracked modifications and untracked files alike; a refusal with no
  note at all resets the worktree to main and still records the reason via event + lastSummary.
- A changed tick past either thrash threshold is flagged `highFriction` with a warning event;
  once commit-bodies.md has landed the same tick's commit carries the reserved trailer line.
- Config validation covers the new thresholds; `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) (something concrete to refuse against). Pairs with
[review-gate.md](review-gate.md): the reviewer is the enforcement arm, refusal is the authoring
arm. Implementable before the gate.

## Out of scope

Mid-run intervention (requires pi RPC mode — a possible future migration); automatic plan
deletion on refusal (steward's call, [steward-role.md](steward-role.md)).
