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

## Done
