# Adversarial review gate before merge

Planned 2026-08-24 · refined 2026-08-25 (failure handling, crash path, exemption semantics,
state plumbing; stale file refs after the status-layer split) · from the "Senior Tumwater" report
(HN 49421554) · report item R1

## Goal

No diff reaches main unreviewed. After a loop commits its tick, an independent pi run — a fresh
session with no author context — reviews the diff against PRINCIPLES.md and either approves it for
merge or rejects it with reasons. Rigor is calibrated to blast radius: doc-only diffs skip the
gate; code diffs get the full adversarial pass. The invariant is *structural*: both paths that can
move a commit into main (a fresh tick's merge, and `recoverLeftover`'s salvage) pass through the
same gate, so no crash or abort path can smuggle unreviewed work in.

## Motivation

HN commenter **BatFastard** keeps a 60k-LOC agent-built project grounded with "antagonistic agent
code and architecture reviews"; **izzydata**/**wek** argue verification is where engineering
expertise actually lives; **Ancapistani** says the senior skill is calibrating review rigor.
Tumwater has already paid for the gate's absence twice: a killed tick force-merged a syntactically
broken GUI page, and half-done feature work landed silently.

## Design

### Placement (`src/loop.ts`)

In `runTick`, after `commitAll` and before `merge()`. The reviewer runs in the author's worktree
(post-commit, so it can read the full tree); the harness hard-resets any stray working-tree edits
the reviewer makes before merging — the reviewer's only output channel is its verdict.

- **Outside the merge lock.** Review happens before `merge()` acquires the shared merge lock, so
  other loops keep merging while one loop is under review (a review run can take minutes).
- **Budget:** the reviewer reuses `runPi` with the same signal and quiet watchdog; give it its own
  timeout of `tickTimeoutSeconds`. Worst-case tick duration becomes 2 × `tickTimeoutSeconds`
  (author + reviewer) — the same order as today's transient-retry worst case.

### Reviewer run (`src/pi.ts` reuse)

`runPi` with a *fresh* session every time: no `--continue`, and because pi is launched with
`-n <sessionName>` when not continuing, use a **unique name per run** —
`tumwater-review-<role>-<tick>`, mirroring the author runs — under sessionDir
`.tumwater/sessions/_review/<role>/`. (A fixed name would let pi resume an old review's context;
old files are cleaned by the existing age-based prune at orchestrator start.) Model/thinking come
from a pseudo-role entry `review` in tumwater.json's `roles` map via the existing `configForRole`,
so the strong model can review what the cheap model wrote. No code change needed for this: config
validation already accepts unknown role ids, `enabledRoleIds` skips it (no runner spawned), and
`configForRole` applies its provider/model/thinking overrides regardless of `enabled`. The dogfood
tumwater.json gains `"review": { "enabled": false }` plus any model override.

### Prompt (`src/prompt.ts`)

New `buildReviewPrompt(diff, summary, commitBody, principles)`. Instructions: adversarial stance —
hunt for correctness bugs, principle violations, complexity growth, incomplete work; read
surrounding code freely; do not edit anything; end with exactly `VERDICT: approve` or
`VERDICT: reject` followed by numbered reasons. Diff comes from `git show <commit>` capped (~200 KB;
over the cap, send `--stat` plus the largest files and note the truncation — an oversized diff is
itself reviewable information). **Verdict parsing:** scan the run's assistant text (any message,
like the nothing-to-do sentinel) for the last `/^VERDICT:\s*(approve|reject)/m`; anything else is a
failed review, not an approval.

### Rigor calibration (`src/types.ts` + `src/config.ts`)

A `review` section: `{ enabled: true, exemptPaths: ["*.md", "docs/**"] }`. A diff whose files all
match `exemptPaths` merges without review; a diff with even one non-exempt file gets the full pass.
(Refusal notes and QA bug reports are md-only, so they stay cheap by construction.)

**Exemption semantics** (small pure helper, e.g. `isExemptPath(relPath, patterns)` in
`src/review.ts`, unit-tested): a pattern containing no `/` matches the file's **basename** at any
depth (`*.md` exempts `docs/notes.md` too); a pattern containing `/` matches the full repo-relative
path, where `*` matches within one path segment and `**` across segments (`docs/**` = everything
under `docs/`). Exemption is per-diff: *every* changed file in the commit must match some pattern.

### On approve

Proceed to the existing merge path unchanged; record `lastApprovedHead` (the reviewed branch HEAD)
in LoopState — see crash path below.

### On reject

Do not merge. Reset the branch to main (work discarded), log a `review_rejected` event carrying the
reasons, store them in `LoopState.lastReview`, and inject them into the role's next tick prompt
("your previous change was rejected in review: … — address the objections or take a different
approach"; the author's persistent session retains the full context of what it built). New
`TickResult` value `"rejected"` rendered in status/GUI. Scheduling: treat like `changed` (reset
backoff, `nextRunAt = now + minTickIntervalSeconds`) so the author addresses the objections on its
next eligible tick rather than sleeping through them; repeated rejects stay visible via events.

### On review failure (no parseable verdict, pi error, or timeout) — fail closed, retry next tick

Do not merge **and do not reset**: leave the commit on the branch and end the tick with a new
`TickResult` `"review_error"` (rendered like an error; backoff as for errors). The work is intact
on the branch, so the *next* tick's `recoverLeftover` re-reviews it — a transient model-server
failure self-heals without losing work. **Bounded:** track consecutive review failures per HEAD in
LoopState (`unreviewFailures`, reset when the reviewed HEAD changes or a review succeeds); after 3,
discard the leftover (reset branch to main) with a `warning` event — a misconfigured reviewer model
cannot wedge a loop into re-reviewing the same commit forever.

### Crash path: `recoverLeftover` routes through the gate

Today `runTick` starts with `recoverLeftover`, which merges any commits ahead of main **without**
review — so a crash or abort between `commitAll` and the review (or during it) would land unreviewed
work on the next tick, silently breaking the invariant. Fix: `recoverLeftover` no longer merges
blindly. When leftovers exist:

1. If the leftover HEAD equals `lastApprovedHead`, merge directly — already reviewed; this is what
   a `merge_blocked` retry hits and must not burn another review run.
2. Otherwise run the same reviewer over the combined leftover diff (`git diff <main>...<head>`,
   capped as above): approve → record `lastApprovedHead`, then merge (existing summary); reject →
   reset + record reasons exactly like a tick reject; fail → leave for retry under the 3-strike cap.

This makes the invariant structural: both paths into main pass through review. Note the prompt is
built before recovery in `runTick`, so reasons recorded during this tick's recovery surface on the
*following* tick — acceptable, say nothing cleverer. Leftovers are rare (crash/abort/reject only),
so the extra reviewer run costs nothing in steady state.

### Director ticks

Not exempt by role: a director diff touching non-exempt paths is reviewed like any other (director
ticks are usually md-only → exempt by construction). No special-casing.

### State and dashboard plumbing (`src/types.ts`, `src/status-render.ts`)

- `LoopState` gains optional fields: `phase?: "pi" | "review"` (set + saved around the reviewer
  run, cleared at tick end alongside `running`), `lastReview?: { verdict: string; reasons: string[];
  head?: string; at: number }`, `lastApprovedHead?: string`, `unreviewFailures?: number`.
- `loopPhase`/`workingDetail` (src/status-render.ts — the presentation layer; status.ts only
  collects snapshots and passes loop fields through unchanged): when `s.running && s.phase ===
  "review"`, render `reviewing <elapsed>` instead of the pi live detail. No changes to gui.ts or
  gui-page.ts: `statusPayload` already calls `loopPhase` for the GUI's state cell, and new result
  values flow through as plain strings via `lastResult`/`lastSummary`.
- New outcomes `"rejected"` / `"review_error"` rendered in the status table and GUI like other
  results (with reason/summary text).

### Observability

`review_start` / `review_verdict` events (verdict event carries approve/reject + first line of
reasons); `review_failed` on unparseable/failed runs; reviewer tokens/cost fold into the loop's
totals (`generatedTokens`/`totalCostUsd`). The new event types join the `HarnessEvent.type`
union (src/types.ts) and get plain rendering in `formatEvent` (src/event-format.ts — it no longer
lives in src/events.ts).

## Files touched

`src/loop.ts`, `src/prompt.ts`, `src/types.ts`, `src/config.ts` (review section + validation),
`src/review.ts` (new: exemption matcher, verdict parsing, review-run orchestration shared by the
tick and recoverLeftover paths), `src/status-render.ts` (`loopPhase`/`workingDetail` reviewing
state — not src/status.ts), `src/event-format.ts` (review event rendering — formatEvent no longer
lives in src/events.ts), `tumwater.json` (dogfood: `"review": { "enabled": false }` + model override),
`test/review-gate.test.ts` (fake-pi shim scripting both verdicts; exemption matcher unit tests —
basename vs path patterns, all-files-must-match; approve merges / reject resets + next-prompt
injection; review failure leaves commit and re-reviews next tick; 3-strike discard; recoverLeftover
reviews leftovers but skips `lastApprovedHead`; stray-edit reset; fresh session naming), README.

## Acceptance criteria

- A code diff only merges after a reviewer run ends `VERDICT: approve`; a reject leaves main
  untouched, resets the branch, records reasons, and the role's next prompt contains them.
- Md-only diffs (per exemptPaths) merge without a reviewer run; one non-exempt file in an otherwise
  md diff triggers review. Exemption matcher unit tests cover `*.md` at depth and `docs/**`.
- A failed/verdict-less review never merges: the commit stays on the branch, the tick ends
  `review_error`, and the next tick's recovery re-reviews it; after 3 consecutive failures for one
  HEAD the leftover is discarded with a warning.
- Simulated crash between commit and review (commit left ahead of main) does not land unreviewed:
  the next tick reviews before merging. An already-approved HEAD (`lastApprovedHead`) merges without
  re-review.
- Reviewer stray edits never reach main; reviewer runs use a fresh uniquely-named session each time;
  the merge lock is not held during review (another loop can merge concurrently — testable with two
  fake-pi loops).
- `review.enabled: false` restores today's behavior exactly. Status/GUI show `reviewing` while a
  pass runs and render `rejected`/`review_error`. `npm test` passes.

## Dependencies & sequencing

Wants [principles.md](principles.md) first (the review standard). The refusal plan's md-only
objection notes and the commit-body plan's structured messages both feed the reviewer richer
context but are not prerequisites.

## Out of scope

Reviewing merges of main into loop branches (conflict resolution keeps its existing verifier);
multi-reviewer quorums; human review checkpoints.
