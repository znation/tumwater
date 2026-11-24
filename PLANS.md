# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### A post-merge review whose reviewer's fix was withheld names the kept finding on the `tumwater
  reviews` list and the dashboard card, not only under `reviews --show`

**Goal.** INV-BT8 keeps the reviewer's objection alive when its own repair is withheld by its
pre-check: `settleWithheldReviewerFix` (src/merge/merge-post-review-drain.ts) records one failed
review run and rides the reviewer's objection in `PostReview.finding`
(src/review/post-merge-review.ts) so the entry stays open. But the one surface that prints it is
the detail view — `renderPostReviewDetail`'s `Reviewer's finding:` block — and the two surfaces an
operator actually scans, `renderPostReviews`' list line and the dashboard's Post-merge reviews
card, print only `postReviewStatusLabel`, whose `failing` branch names the failed-run count and the
pre-check's own reason. So the row a quota wall leaves behind reads
`1. feature a1b2c3d4 · 2h ago · add the parser · [1 failed review run — last: fix pre-check withheld the repair: …]`
and the thing worth acting on — what the reviewer objected to — is invisible until the operator
already knows to run `tumwater reviews --show 1`. `grep -rn "Reviewer's finding" src test docs`
prints it only in `renderPostReviewDetail`, its test and `docs/invariants.md`: no list, card, help
or CLI-doc surface names it, and PLANS-DONE.md holds no entry containing "finding kept".

**Approach (one bracket, one home, two renderers).**

- src/review/post-merge-review-render.ts: add `export function postReviewFindingNote(entry: PostReview): string`, beside
  `postReviewBackoffNote`, returning `""` unless `entry.finding` is a non-empty array **and**
  `postReviewState(entry)` is `"failing"`; otherwise
  `reviewer's finding — ${squash(entry.finding[0], 60)}${moreSuffix(entry.finding.length - 1)}`
  (the file's existing `squash` import; add `moreSuffix` from src/text/phrases.ts — its ` (+N more)`
  shape is already the capped-list convention). The `"failing"` guard is the whole rule and it is
  load-bearing: a settled `rejected` row already prints those reasons in its own bracket, and
  `settleMergedReviewerFix` spreads `...entry`, so a `fixed` row can carry a stale `finding` from an
  earlier withheld run — neither should gain a second, duplicating bracket. Keeping it out of
  `postReviewStatusLabel` follows the same reason `postReviewBackoffNote` is out: that switch picks
  ONE label by precedence and an entry can hold a finding and a live provider-failure deadline at once.
- `renderPostReviews`: append the bracket as ` · [<note>]` after the status suffix and before the
  provider-failure bracket, under no clock guard. With no `finding` the line stays byte-identical.
- src/ui/gui/gui-client-pending.ts: the hand-kept browser twin of the same note inside the
  `postReviewsHtml` line builder (beside its `postReviewStatusLabel` twin), rendering the same bytes
  through the file's `squashText(x, 60)` and an inline `(+N more)` tail, wrapped in
  `<span class='mono'>` like the other brackets. `statusPayload` already carries `finding` —
  src/ui/status-payload.ts drops only `body` (`readPostReviews(root).map(({ body: _dropped, ...rest }) => rest)`) —
  so no payload, endpoint or route change is needed.
- Docs and help, in the same commit: the `tumwater reviews` list block in src/cli/cli-help-text.ts
  names the bracket next to the existing `[provider failure — retrying in <duration>]` sentence;
  docs/cli.md's `Check state` table row (the one that carries the whole `tumwater reviews …`
  description, beside the `tumwater status` one) gains the matching clause in its `reviews` clause;
  docs/how-it-works.md's
  Post-merge reviews card paragraph names it as the browser twin, beside its provider-failure
  countdown clause.
- docs/invariants.md, INV-BT8: one sentence in the guarantee — the kept finding is named on every
  observer of the queue, and only on a still-open `failing` row, so a `fixed` row never reprints an
  objection its landed repair answered; and name the new tests in that section's **Pinned by** list.

**Files touched:** src/review/post-merge-review-render.ts, src/ui/gui/gui-client-pending.ts,
src/cli/cli-help-text.ts, docs/cli.md, docs/how-it-works.md, docs/invariants.md,
test/post-merge-review-render.test.ts, test/gui-client-pending.test.ts, test/cli-reviews.test.ts,
test/help.test.ts.

**Acceptance criteria.**

- An entry with `finding: ["breaks the contract"]` and `failures: 1` renders its `tumwater reviews`
  list line as `… · [1 failed review run] · [reviewer's finding — breaks the contract]` (the finding
  bracket after the status bracket), and `renderPostReviews` of an entry with no `finding`, or with
  `finding: []`, is byte-identical to today's line.
- Two findings render the first squashed to 60 with the count of the rest: the line ends
  `[reviewer's finding — <first squashed to 60>… (+1 more)]`.
- A `rejected` entry that also carries `finding` and a `fixed` entry that carries a stale `finding`
  gain no finding bracket; their lines stay as today, and a `waiting` entry with `finding` and no
  `failures` gains none.
- The dashboard card's row for the same `failing` entry carries
  `<span class='mono'>[reviewer's finding — breaks the contract]</span>` after its status span; a
  `fixed` or `rejected` row with a `finding` does not, and the card still renders no `undefined`.
- `tumwater reviews` run against a written `post-review.json` holding one withheld entry prints the
  finding bracket in its stdout (CLI child test), and `tumwater help reviews` names it.
- `GET /api/status`, `tumwater status --json` and `tumwater reviews --json` gain no new field, and
  `postReviewMatchesGrep`, `postReviewState`, `POST_REVIEW_STATES`, `postReviewStatusLabel` and
  `renderPostReviewDetail` are unchanged.
- The `cli-doc` / `docs-commands` stage checks stay green with the help text and docs/cli.md row
  updated in step.

**Do not:** change `settleWithheldReviewerFix`, `PostReview.finding`'s schema or what the drain
writes; fold the bracket into `postReviewStatusLabel`; print it on a `fixed` or `rejected` row; add
a flag, a new endpoint, a `--json` key, or a second finding source in the browser bundle; touch
`--grep`'s field list (it already searches `finding` whole).

### The `post-merge reviews` doctor row names a review parked inside its provider-failure backoff,
so a stalled review queue is never a silently green row (planned 2026-11-23 by the plan role; two
other changes edit the post-review surfaces this reads — the waiting `## Planned` entry (its
finding bracket, in src/review/post-merge-review-render.ts, src/ui/gui/gui-client-pending.ts,
src/cli/cli-help-text.ts, docs/cli.md, docs/how-it-works.md and docs/invariants.md INV-BT8) and an
unmerged planned change (the backoff bracket, same render/card files plus docs/invariants.md
INV-BT6's **Binds**) — this entry edits none of those except docs/invariants.md, and there the
INV-BT6 paragraph, so whichever of the INV-BT6 edits lands second rebases it; touches
src/doctor/doctor-backlog.ts src/doctor/doctor.ts
test/doctor-backlog.test.ts docs/invariants.md)

**Goal.** A review the reviewer backend cannot finish on infrastructure grounds is kept by
INV-BT5 — it is not counted in `failures` and never filed — and INV-BT6 parks it: `unreviewed`
(src/merge/merge-post-review-drain.ts) skips any entry whose `notBeforeMs` is in the future, so the
drain leaves it alone until the deadline passes. The at-risk bar this row reads
(`POST_REVIEW_AT_RISK_FAILURES = POST_REVIEW_FAILURE_LIMIT - 1`, src/doctor/doctor-backlog.ts)
counters only verdict-less *content* failures, which a transient failure never bumps, so a queue of
entries each sitting behind an escalating `notBeforeMs` leaves `checkPostReviews` at exactly
`no post-merge review is one failed run from being dropped` — in src/doctor the only `notBeforeMs`
reader is `checkStalePrompts`'s, and that is a **prompt** field (`deliverableAt`,
src/inbox/prompt-not-before.ts), not a post-review entry's, so no doctor surface reads a review
backoff. The operator sees a green row while the queue has stopped moving.

**Approach (one new selection, one new phrase, one caller).**

- src/doctor/doctor-backlog.ts: beside `POST_REVIEW_AT_RISK_FAILURES` add
  `export const POST_REVIEW_PARKED_STREAK = 2;` (doc-comment it: the drain stamps `notBeforeMs` on
  the *first* transient failure too, with the one-minute team-hold base, so the bar is what makes
  the row meaningful — a single hiccup that clears in a minute is noise, a second consecutive one
  means the pause has escalated and the wall is still up) and an
  `interface ParkedPostReview { commit: string; role: string;
  summary: string; notBeforeMs: number; consecutiveTransientFailures: number }` beside
  `AtRiskPostReview`. Add `export function parkedPostReviews(root: string, now: number): ParkedPostReview[]`,
  one traversal beside `atRiskPostReviews` in the same shape: keep entries with
  `rejected === undefined && fixed === undefined && (notBeforeMs ?? 0) > now &&
  (consecutiveTransientFailures ?? 0) >= POST_REVIEW_PARKED_STREAK`, in the same file (FIFO) order
  as `atRiskPostReviews`, and deliberately exclude anything at `failures >=
  POST_REVIEW_AT_RISK_FAILURES` — the at-risk phrase already names that entry, so no entry is
  named twice in one row. `readPostReviews` already normalizes both fields
  (`parsePostReview`, src/review/post-merge-review.ts), so neither needs a coercion here.
- Add `export function parkedPostReviewsPhrase(rows: readonly ParkedPostReview[], now: number): string | null`,
  modelled on `atRiskPostReviewsPhrase`: the first entry in full — role, short commit, quoted
  summary and the countdown — the rest folded through `andMore`, e.g.
  `the post-merge review of feature a1b2c3d4 — add the parser — is parked by 3 consecutive provider
  failures and resumes in 4m`, using `humanUntil(first.notBeforeMs, now)` (src/text/datetime.ts —
  add it to that file's existing import of `humanSeconds, humanSince, HOUR_MS, DAY_MS`).
  Return `null` for an empty list. The `(notBeforeMs ?? 0) > now` filter holds by construction, so
  `humanUntil`'s past-instant `0s` clamp can never show here.
- `checkPostReviews(root, now = Date.now())`: three arms, at-risk first. At-risk non-null: the
  existing `warnOutcome(atRiskPhrase)` plus, when the parked list is non-empty, one appended clause
  built in the same template style — `` `${atRiskPhrase}; ${parked.length} more ` +
  `post-merge review${parked.length === 1 ? "" : "s"} parked by provider failures` `` — so the at-risk
  advice still ends its own sentence and the parked count rides after it. At-risk null and parked
  non-null: `warnOutcome(parkedPostReviewsPhrase(parked, now))`. Both empty: the existing ok
  outcome text, unchanged. Never a `fail` — the checkStaleQueuedMerges and at-risk precedent: a
  failing reviewer backend is operator signal, not a broken environment.
- src/doctor/doctor.ts: pass the clock the way the neighbouring stale rows do —
  `{ name: "post-merge reviews", run: () => checkPostReviews(root, Date.now()) }`, the exact shape
  `checkStaleQueuedMerges(root, Date.now())` and `checkStalePrompts(root, Date.now())` already use
  in that list. No new import, no row rename, no new row.
- Do not name the pause's cap in the row's wording and do not import `HOLD_CAP_MS`/`HOLD_BASE_MS`
  into src/doctor: `reviewBackoffMs` (src/merge/merge-post-review-drain.ts) delegates to
  `escalatedHoldMs` in src/team/team-hold.ts, whose base/cap constants are that module's business,
  so the phrase counts down with `humanUntil` instead of quoting a number that could drift.
- docs/invariants.md INV-BT6: name the third reader of `notBeforeMs`'s meaning in **Binds**
  (`src/doctor/doctor-backlog.ts` — `parkedPostReviews`, `parkedPostReviewsPhrase`,
  `checkPostReviews`) and add this entry's new doctor test names to **Pinned by**.

**Acceptance criteria.**

- A `post-review.json` holding one entry with `notBeforeMs` 4 minutes ahead, `consecutiveTransientFailures: 2`
  and no `failures` key makes `tumwater doctor`'s `post-merge reviews` row read `warn`, and its
  detail names that entry's role, short sha and summary and counts down with `in 4m`; the row for a
  queue with no entry like that keeps reading `no post-merge review is one failed run from being dropped`.
- An entry with `consecutiveTransientFailures: 1` and a future `notBeforeMs`, and an entry whose
  `notBeforeMs` is in the past, each leave the row at that same ok detail on their own.
- One entry at the at-risk bar and one parked entry in the same queue produce a single `warn` row
  that carries both clauses, and no entry appears twice in it.
- `parkedPostReviews(root, now)` returns `[]` for a `fixed` entry and for a `rejected` entry, each
  carrying `notBeforeMs` in the future and `consecutiveTransientFailures: 3`.
- The `invariants-doc`, `backlog-structure` and `stage` guards stay green with the INV-BT6 edit in
  step.

**Do not:** change `unreviewed`, `settleWithheldReviewerFix`, the drain's backoff arithmetic,
`reviewBackoffMs`, `escalatedHoldMs`, `POST_REVIEW_AT_RISK_FAILURES`, `atRiskPostReviews` or
`atRiskPostReviewsPhrase`; change the at-risk row's wording, level or ok text; raise the row to
`fail`; add a second doctor row, a glance badge, a status/`--json` payload field, a dashboard
surface or a `--show` line; import `HOLD_CAP_MS`/`HOLD_BASE_MS` into src/doctor; touch
src/review/post-merge-review-render.ts or src/ui/gui/gui-client-pending.ts (the waiting entry
owns them).

## Done
