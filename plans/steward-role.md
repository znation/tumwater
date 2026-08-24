# Steward role — whole-system judgment on a slow clock

Planned 2026-08-24 · from the "Senior Tumwater" report (HN 49421554) · report item R5

## Goal

A low-frequency `steward` role that does no feature work: it re-reads the initial prompt,
PRINCIPLES.md, PLANS.md, BUGS.md, QUESTIONS.md, and the shape of the codebase, then acts on the
deltas — pruning stale plans, merging duplicates, flagging drift from the initial prompt, and
keeping the complexity budget honest. It is the tech-lead layer that turns ten independent loops
into something resembling a team.

## Motivation

HN commenter **ben_w**: coding < development < engineering — the top layer is judgment nobody's
automating. **kypro**: someone must own complexity. **visarga**/**pianopatrick** report agent
projects disintegrating past tens of kLOC without exactly this oversight. Every current tumwater
role works bottom-up, one artifact at a time; the plan loop *adds* plans but nothing *curates*
them, and nothing compares the codebase to the project's reason for existing.

## Design

- **Role** (`src/roles.ts`): id `steward`, title "project steward", placed after `director` in
  catalog order (lowest tie-break priority — it should never outrank shipping work). Find prompt,
  in spirit: "Re-read the initial prompt, PRINCIPLES.md, PLANS.md, BUGS.md, and QUESTIONS.md, and
  skim the codebase's shape (sizes, module list, test count). Then make ONE curation move, the
  most valuable one: delete or merge stale/duplicative/superseded PLANS.md entries (with a one-line
  epitaph in the entry's place or in Done); flag drift between what's being built and the initial
  prompt as a PLANS.md note or a question; tighten or update a principle or complexity budget in
  PRINCIPLES.md; or record a structural risk in BUGS.md. You edit only markdown — never source."
- **Write access**: explicitly allowed to edit PRINCIPLES.md (the exception alongside the
  director; see [principles.md](principles.md)) and to delete PLANS.md entries — the only role so
  empowered.
- **Slow cadence**: add optional per-role `minTickIntervalSeconds` to `RoleConfig`
  (`src/types.ts`, `src/config.ts` validation, honored in `isEligible` and the runner's own
  scheduling in `src/orchestrator.ts`/`src/loop.ts`). Default for steward in `defaultConfig()`:
  21600 (6 h). This override is generally useful — the same knob later serves the QA role.
  Backoff still applies on no-change ticks, capped as usual.
- **Thinking budget**: dogfood config points steward at the strong model with high thinking via
  the existing per-role overrides; defaults leave it inheriting.
- **Complexity budget**: the steward maintains a short "Budgets" section in PRINCIPLES.md (total
  LOC trend, module-size ceiling, dependency count = 0). Its prompt tells it to measure (`wc -l`,
  file counts) before adjusting — numbers from the repo, not vibes.
- **Md-only diffs** keep steward ticks review-exempt under
  [review-gate.md](review-gate.md)'s path rules.

## Files touched

`src/roles.ts`, `src/types.ts`, `src/config.ts`, `src/orchestrator.ts`, `src/loop.ts` (interval
override plumbing), `tumwater.json` (enable + cadence), `test/steward.test.ts` (role prompt
contract; interval override honored in eligibility; catalog order), README roles list.

## Acceptance criteria

- The steward exists, enabled by default for new inits, with a 6 h default cadence honored by the
  scheduler (unit-testable via `isEligible` with a shortened override).
- Its prompt contains the curation move list, the markdown-only restriction, and the PLANS.md
  deletion/PRINCIPLES.md edit powers; prompt tests assert all three.
- Per-role `minTickIntervalSeconds` is validated config and works for any role.
- Dogfood: within its first day enabled, the steward has made at least one curation commit
  (md-only) — verified by observation, not by test. `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) and ideally [questions-outbox.md](questions-outbox.md) in
place (its escalation channel). Last of the markdown-layer items; before the QA role.

## Out of scope

Reviewing individual diffs (the gate's job); editing source; scheduling or reprioritizing other
loops directly (its lever is the shared markdown, not the scheduler).
