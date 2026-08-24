# The right to refuse, and friction as a signal

Planned 2026-08-24 · from the "Senior Tumwater" report (HN 49421554) · report item R2

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
- **Loop** (`src/loop.ts`): outcome `refused` (new `TickResult`). If the run left only the
  md objection edit, commit it as `tumwater(<role>): refuse — <reason>` and merge (md-only, so
  review-exempt by construction); if it left code changes too, discard them and keep only a logged
  event — a refusal must not half-ship. Backoff as for `no_change`; `lastSummary` becomes the
  reason so dashboards show it.
- **Thrash detection** (`src/loop.ts` + `src/progress.ts` counters): pi runs autonomously, so
  mid-run intervention is out of scope — instead measure after: if a changed tick used more than
  `thrashTurns` assistant turns (config, default 40) or more than `thrashMinutes` (default 60),
  mark the outcome `highFriction: true`, note it in the commit body ("high-friction change:
  N turns / M minutes"), log a `warning` event, and — once the review gate exists — include the
  flag in the review prompt so the reviewer applies extra scrutiny. Friction becomes data instead
  of disappearing.
- **Prompt encouragement** (`src/roles.ts`): the feature role's find text gains one line: a plan
  that resists implementation is a finding — refuse with the objection recorded rather than
  forcing it.
- **Dashboards**: `refused` rendered like `no_change` but with the reason; totals unaffected.

## Files touched

`src/prompt.ts`, `src/pi.ts`, `src/loop.ts`, `src/types.ts`, `src/config.ts` (thrash thresholds +
validation), `src/roles.ts`, `src/status.ts`, `src/gui-page.ts`, `src/events.ts`,
`test/refusal.test.ts` (sentinel parse; md-only refusal commits and merges; refusal with code
changes discards them; thrash flag set past thresholds), README.

## Acceptance criteria

- A fake-pi run ending `TUMWATER_REFUSED: reason` with a PLANS.md note yields outcome `refused`,
  the note lands on main, no code lands, and the dashboards show the reason.
- A refusal that also edited code discards the code edits entirely.
- A changed tick past either thrash threshold carries the high-friction flag in its commit body
  and a warning event.
- Config validation covers the new thresholds; `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) (something concrete to refuse against). Pairs with
[review-gate.md](review-gate.md): the reviewer is the enforcement arm, refusal is the authoring
arm. Implementable before the gate.

## Out of scope

Mid-run intervention (requires pi RPC mode — a possible future migration); automatic plan
deletion on refusal (steward's call, [steward-role.md](steward-role.md)).
