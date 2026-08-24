# Adversarial review gate before merge

Planned 2026-08-24 · from the "Senior Tumwater" report (HN 49421554) · report item R1

## Goal

No diff reaches main unreviewed. After a loop commits its tick, an independent pi run — a fresh
session with no author context — reviews the diff against PRINCIPLES.md and either approves it for
merge or rejects it with reasons. Rigor is calibrated to blast radius: doc-only diffs skip the
gate; code diffs get the full adversarial pass.

## Motivation

HN commenter **BatFastard** keeps a 60k-LOC agent-built project grounded with "antagonistic agent
code and architecture reviews"; **izzydata**/**wek** argue verification is where engineering
expertise actually lives; **Ancapistani** says the senior skill is calibrating review rigor.
Tumwater has already paid for the gate's absence twice: a killed tick force-merged a syntactically
broken GUI page, and half-done feature work landed silently.

## Design

- **Placement** (`src/loop.ts`): in `runTick`, after `commitAll` and before `merge()`. The
  reviewer runs in the author's worktree (post-commit, so it can read the full tree); the harness
  hard-resets any stray working-tree edits the reviewer makes before merging — the reviewer's only
  output channel is its verdict.
- **Reviewer run** (`src/pi.ts` reuse): `runPi` with a *fresh* session every time (no
  `--continue`; sessionDir `.tumwater/sessions/_review/<role>`) so it has no sunk-cost context.
  Model/thinking come from a pseudo-role entry `review` in tumwater.json's `roles` map via the
  existing `configForRole`, so the strong model can review what the cheap model wrote.
- **Prompt** (`src/prompt.ts`): new `buildReviewPrompt(diff, summary, commitBody, principles)`.
  Instructions: adversarial stance — hunt for correctness bugs, principle violations, complexity
  growth, incomplete work; read surrounding code freely; do not edit anything; end with exactly
  `VERDICT: approve` or `VERDICT: reject` followed by numbered reasons. Diff comes from
  `git show <commit>` capped (~200 KB; over the cap, send `--stat` plus the largest files and note
  the truncation — an oversized diff is itself reviewable information).
- **Rigor calibration** (config, `src/types.ts` + `src/config.ts`): a `review` section:
  `{ enabled: true, exemptPaths: ["*.md", "docs/**"] }`. A diff whose files all match
  `exemptPaths` merges without review. Everything else gets the full pass. (Refusal notes and
  QA bug reports are md-only, so they stay cheap by construction.)
- **On reject**: do not merge. Reset the branch to main (the work is discarded — `recoverLeftover`
  must not resurrect it), log a `review_rejected` event carrying the reasons, store them in
  `LoopState.lastReview`, and inject them into the role's next tick prompt ("your previous change
  was rejected in review: … — address the objections or take a different approach"; the author's
  persistent session retains the full context of what it built). New `TickResult` value
  `"rejected"` rendered in status/GUI.
- **On approve**: proceed to the existing merge path unchanged.
- **Observability**: `review_start` / `review_verdict` events; the working-state cell shows
  `reviewing` during the pass; reviewer tokens/cost fold into the loop's totals.

## Files touched

`src/loop.ts`, `src/pi.ts` (none expected — reuse), `src/prompt.ts`, `src/types.ts`,
`src/config.ts`, `src/status.ts`, `src/gui-page.ts`, `src/events.ts` (formatEvent),
`test/review-gate.test.ts` (fake-pi shim scripting both verdicts, exemption paths, stray-edit
reset, reject → branch reset + next-prompt injection), README.

## Acceptance criteria

- A code diff only merges after a reviewer run ends `VERDICT: approve`; a reject leaves main
  untouched, resets the branch, records reasons, and the role's next prompt contains them.
- Md-only diffs (per exemptPaths) merge without a reviewer run.
- Reviewer stray edits never reach main. Reviewer runs use a fresh session each time.
- `review.enabled: false` restores today's behavior. `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) first (the review standard). The refusal plan's md-only
objection notes and the commit-body plan's structured messages both feed the reviewer richer
context but are not prerequisites.

## Out of scope

Reviewing merges of main into loop branches (conflict resolution keeps its existing verifier);
multi-reviewer quorums; human review checkpoints.
