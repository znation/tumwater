# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned
_None yet._

### The GitHub-issues mirror's upstream closes get one standing signal: the `tumwater doctor  
  github issues` row and the team's alert band name how many issues GitHub closed upstream that  
  this workspace never merged a fix for

**Goal.** The mirror records every issue GitHub closed upstream that this workspace never merged a
fix for — the ledger's `upstreamClosed` list, written by `recordUpstreamCloses`
(`src/github/issue-scan.ts`) and governed by INV-DG1 (`docs/invariants.md`, *The GitHub issues
mirror: an issue GitHub closed upstream has one record*) — but no standing surface says it exists.
An operator learns the loss only by choosing to look: `tumwater issues --lost`, or the list header's
`, N closed upstream` clause (`issuesHeader`, `src/github/github-issues-render.ts`). The scan-stall
plan named exactly this as its follow-up (PLANS-DONE.md, *Not covered (follow-ups)*: "No
dashboard/`status` alert … and no change to `githubIssuesSummary`"), and INV-DG1's own text says why
the loss is invisible to the alert band: a lost issue drops its `waitingPush` promise, so
`githubCloseForStatus` raises no `github-close` banner for it and the queue never offers it. Give
that one fact a phrasing the doctor and the alert band share.

**Approach (the count folded once, one sentence, three readers).**

- `src/github/github-issues-state.ts`: add `upstreamClosed: number` to `GithubIssuesSummary` beside
  `unmirrored`/`untrusted`, and fill it in `githubIssuesSummary` with
  `(Array.isArray(ledger.upstreamClosed) ? ledger.upstreamClosed : []).length` — the identical fold
  `issuesHeader` applies to the same list as `upstreamClosedCount`, over the rows
  `readGithubIssues` already screens with `isGithubIssueRow`. Then add one exported sentence beside
  `githubScanStalledSentence` in that module, taking the repo and the count: one form for a count of
  1, one for many, naming the repo and that tumwater never merged a fix for them. No age clause — a
  loss says the same thing however fresh or stale the scan is.
- No new snapshot field: `StatusSnapshot.githubIssues` (`src/status/status-types.ts`) already carries
  the summary, filled by `githubIssuesForPoll` (`src/status/status-data.ts`).
- `checkGithubIssues` (`src/doctor/doctor-project-checks.ts`, the `github issues` row) keeps every arm
  it has — null with no mirror, the two unreadable-`gh` warns first, then the
  `githubScanStalled`/`GITHUB_ISSUES_STALE_MS` warn — and appends the sentence to its ok detail only
  when the count is above zero, so `gh ready — tumwater mirrors <repo>'s open issues` still starts the
  row byte-identically, exactly as the stall half leaves the readiness-only row's wording intact.
- `buildGithubScanAlerts` (`src/ui/team-alert-status.ts`) gains one arm after
  `pushGithubMirrorAlert`: a count above zero yields a blue banner keyed
  `github-upstream-closes`, title `GitHub issues closed upstream`, detail the shared sentence. Blue
  because it asks nothing of the operator — the director has no issue to take and the team has no
  retry to run — the rule the gray `github-error` arm and the blue `github-mirror` arm already
  follow. `teamAlerts` (`src/ui/team-alerts.ts`) keeps its section order (status, standings, backlog,
  githubScan, tail), so no existing banner moves.
- No browser-side count and no icon entry: the alerts band paints whatever the payload's `alerts`
  array carries (`src/ui/gui/gui-client-team.ts`, `renderAlerts`/`alertParts`), and
  `alertParts` already falls back to `icon("info")` for a key absent from `ALERT_ICONS`
  (`src/ui/gui/gui-client-model.ts`) — the same fallback the existing `github-mirror`,
  `github-error` and `github-scan-stalled` keys ride. The issues card keeps its own
  `N closed upstream` line from `GET /api/issues` (`src/ui/gui/gui-client-settings.ts`).

**Files touched:** `src/github/github-issues-state.ts` (summary field + sentence),
`src/doctor/doctor-project-checks.ts`, `src/ui/team-alert-status.ts`, and their tests
(the sentence's unit test in `test/github-issues-state.test.ts` — a new file beside its module, the
predicate's current cases live in `test/github-issue-scan.test.ts` — plus `test/doctor-checks.test.ts`,
`test/team-alert-status.test.ts`, `test/team-alerts.test.ts`, `test/status-data.test.ts`), and
`docs/invariants.md` (a new `### INV-DG2` in INV-DG1's section, written in INV-DE1's shape —
**Guarantee**/**Binds**/**Pinned by** —
`grep -c INV-DG docs/invariants.md` prints 1 and INV-DG2 appears nowhere, so the id is free),
`docs/feature-doctor.md` (the `github issues` entry in the "Main and the build" bullet) and
`docs/how-it-works.md` (the paragraph naming the mirror's surfaces).

**Acceptance criteria:**
- A ledger with `gh: "ok"`, a fresh `checkedAt` and `upstreamClosed` holding two rows:
  `checkGithubIssues` answers `level: "ok"` with a detail that begins
  `gh ready — tumwater mirrors znation/tumwater's open issues` and continues with the sentence naming
  both issues; the same fixture with `upstreamClosed` absent or `[]` answers the detail exactly as
  pinned today, so the byte-identical assertions in `test/doctor-checks.test.ts` ("checkGithubIssues
  stays ok at the window boundary and with no ledger file at all", "a stalled ledger never outranks an
  unreadable gh") pass unedited.
- That same two-row ledger stamped one millisecond past `GITHUB_ISSUES_STALE_MS` still answers the
  stall warn with no loss clause — the warn arm returns before the ok path, so a stalled mirror is
  reported once.
- `snapshot()` over that fixture carries `githubIssues.upstreamClosed === 2`; a fixture with no
  `upstreamClosed` key carries `0`; a fixture whose `upstreamClosed` holds one row
  `isGithubIssueRow` rejects counts only the surviving row. The assertions in
  `test/status-data.test.ts` that deep-equal the whole `githubIssues` object gain that one key and
  nothing else.
- `buildGithubScanAlerts` over a snapshot carrying that summary yields a banner keyed
  `github-upstream-closes`, tone `blue`, whose detail is the sentence the doctor row prints; over a
  summary with `upstreamClosed: 0` it yields none, and a snapshot with no `githubIssues` still yields
  `[]`. `alertNeedsYou` (`src/ui/team-alerts.ts`) is false for it, so the dashboard's needs-you count
  and page title do not move, while `tumwater status`'s banner block does print the line — that block
  lists every alert, not only needs-you ones (`alertLines`, `src/ui/status-render.ts`).
- The hand-written `GithubIssuesSummary` fixtures in `test/team-alert-status.test.ts` and
  `test/team-alerts.test.ts` gain the field, and every alert-count and alert-order assertion already
  in those files — including "a failed and stalled scan orders the banners gray, amber, blue" —
  passes unchanged at `upstreamClosed: 0`.
- The doctor row and the banner cannot disagree on one written ledger: a test hand-writes one ledger
  file and asserts the row's clause and the banner's detail carry the same count.
- `GET /api/status`, `tumwater status --json`, `GET /api/issues`, `tumwater issues --lost` and
  `--json` gain no new field; `src/doctor/doctor-check-names.ts` gains no row.

**Invariant (INV-DG2, in INV-DG1's section):** the mirror's upstream-close record has one standing
signal and one count source — the doctor row's clause and the banner's detail both render the one
sentence over `GithubIssuesSummary.upstreamClosed`, which is the length of the ledger's
`upstreamClosed` list as screened by `isGithubIssueRow`, the same list `issuesHeader` counts as
`upstreamClosedCount`; pinned by the tests above.

**Do not:** change what `recordUpstreamCloses` writes, the `ISSUE_ROW_LIST_MAX` cap
(`keepNewestIssueRows`), the `upstreamClosed` schema, or `tumwater issues --lost`/`--json`; spawn `gh`
from a status poll or a doctor surface beyond the runners `checkGithubIssues` already holds (the `gh`
spawn stays at its one site, `src/github/gh.ts`); tone the banner amber or red, or give it an
`actions` entry; add a new poll in `src/status/status-polls.ts` or a new snapshot field — the summary
it needs is already polled; and add no second count source (no fresh ledger read in the CLI render,
the alert builder or the browser bundle).

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

