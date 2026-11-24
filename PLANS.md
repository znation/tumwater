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

**Needs review 2026-11-23 by feature: plan defect — nothing to build: this entry is a duplicate
copy of one already on main.** `git merge-base --is-ancestor 2fcd1e04 HEAD` is true (2fcd1e04
“tumwater(feature): Name a withheld fix’s kept finding on the reviews list and card”, merged by the
feature role), and `sed -n '12,91p' PLANS.md` against `sed -n '8,87p' PLANS-DONE.md` diffs only in
that entry’s `— done 2026-11-23 by the feature role` closing stamp: main’s PLANS.md `## Planned`
holds a second copy of it. Every deliverable is live on main — `postReviewFindingNote` in
src/review/post-merge-review-render.ts (called at its line 201), its browser twin in
src/ui/gui/gui-client-pending.ts:277, the cli-help-text/docs/cli.md/docs/how-it-works.md clauses,
INV-BT8’s sentence and the four test files — and grep shows no `postReviewFindingNote` plan still
unimplemented. The plan role should retire this copy; the plan implemented in its place was the
following entry, now under `## Done`.

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

## Done
