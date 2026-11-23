# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned
_None yet._

### An issue GitHub closed upstream stops holding the `waitingPush` banner, so the blue "push main and it closes" alert can no longer stand forever (planned 2026-11-22 by the plan role; independent in behavior of every waiting entry — `grep -c "waitingPush" PLANS.md` printed 0 before this entry, and no waiting entry names `src/github/issue-scan.ts` or `githubCloseForStatus`; the waiting dashboard entry and the waiting `--lost` entry both edit `docs/invariants.md` (a new INV in the `INV-DE` section, and INV-DG1's **Binds**/**Pinned by** lists) while this one edits INV-DG1's **Guarantee.** prose and the same two lists, so whichever lands second rebases there — every change is an additive list item or a different sentence; touches src/github/issue-scan.ts src/github/github-issues-state.ts docs/invariants.md docs/config.md docs/steering.md test/github-issue-scan.test.ts test/github-issue-close.test.ts)

**Problem.** An issue whose fix commits are on local main but not yet on GitHub's copy is recorded in
the ledger's `waitingPush` map (`closeOne`, src/github/issue-close.ts), and `githubCloseForStatus`
(src/github/github-issues-state.ts) folds `Object.keys(ledger.waitingPush ?? {}).length` into the
snapshot's `githubClose` field, which `pushGithubCloseAlert` (src/ui/team-alert-status.ts) turns into
the standing blue `github-close` banner titled
`1 GitHub issue is fixed on main and closes when you push main to o/r`. If GitHub closes that issue
upstream, the promise in that sentence can never be kept: the issue is gone, `gh issue close` would
close nothing, and the banner stands for as long as the ledger does — the same never-clearing-banner
class INV-DE4 fixed for declined issues. Nothing drops the record: `recordUpstreamCloses`
(src/github/issue-scan.ts) documents and INV-DG1 pins that "nothing else in it changes —
`waitingPush`, `closed`, `queued` and `declined` records stay owed", and test/github-issue-scan.test.ts
"an upstream-close record whose issue the ledger still lists open is never queued or closed again"
builds exactly that pairing (`upstreamClosed: [row8(2_000)]` beside `waitingPush: { "8": ["abc1234"] }`).
Meanwhile docs/steering.md already promises the opposite of a hold — of a lost row, "Such a row is
never mirrored and never counted as unmirrored, so it holds nothing up — it is the mirror's own
record, not a request." Dropping the entry costs no capability: the ledger's `waitingPush` map has
three readers (`grep -rn "waitingPush" src` — `closeOne` in src/github/issue-close.ts writes and clears
it, `foldIssueState`/`issueStateLines` in src/github/github-issues-render.ts print it as the
`waiting for a push of <shas>` detail line, and `githubCloseForStatus` counts it for the snapshot), and
candidacy for a close never consults it — `closeCandidates` re-derives the fix commits through
`fixCommits` — so an issue that comes back open gets a fresh record from the next close pass.

**Approach.** Let the same fold that records the loss settle the push hold, for every number the list
holds so a ledger written by the current build self-heals.

- `recordUpstreamCloses` (src/github/issue-scan.ts): after the `upstreamClosed` list is stored (the
  non-empty branch, so the `rows.length === 0` early return stays as it is), rebuild
  `ledger.waitingPush` with the copy-then-`delete` idiom `closeOne` already uses —
  `const waiting = { ...(ledger.waitingPush ?? {}) }`, delete every key whose number appears in the
  stored `upstreamClosed` list, then assign it back and `delete ledger.waitingPush` when it came out
  empty, so the file holds no empty map. A number that is not in the list keeps its entry, and
  `closed`, `queued` and `declined` records are untouched, as before: they are the read's history and
  `isReopened`'s clock, not a promise of a future close. Only a complete listing reaches this code —
  `scanGithubIssues` calls the helper solely when `capped === false` — so a capped, failed or absent
  listing still settles nothing, INV-DG1's evidence rule unchanged.
- Update the doc comment that states the old rule: `recordUpstreamCloses`'s "nothing else in it
  changes — `waitingPush`, `closed`, `queued` and `declined` records stay owed" sentence, naming the
  `waitingPush` exception and why (the banner's promise cannot be kept for an issue GitHub shut). The
  `GithubIssuesLedger.waitingPush` field comment (src/github/github-issues-state.ts) gains the same
  one-clause exception, since the record is now dropped by the scan as well as cleared by the closer.
- `docs/invariants.md`: amend INV-DG1's **Guarantee.** in the `## The GitHub issues mirror: an issue
  GitHub closed upstream has one record` section — the "Nothing else in the ledger is touched by a loss"
  sentence keeps `closed`, `queued` and `declined` as staying owed and gains the `waitingPush` exception
  stated as a binding rule (a complete listing drops the entry, a capped or failed one does not, and the
  surfaces therefore cannot raise the push banner for a lost issue); add the new test names below to
  **Pinned by.** and keep **Binds.** naming `recordUpstreamCloses` (add
  `src/github/github-issues-state.ts`'s `githubCloseForStatus` there, since the guarantee now reaches the
  banner count). Same section, same `DG` prefix — a second section for one prefix is a documented
  problem in test/invariants-doc.test.ts.
- `docs/config.md`'s `githubIssues` row: its upstream-close sentence ends "those records are never
  mirrored, never counted as unmirrored, and close nothing" — append that such an issue also stops
  holding the fixes-waiting-for-a-push count, so the surfaces' wording matches.
- `docs/steering.md`: the lost-issue paragraph's "so it holds nothing up" clause gains the push banner
  as one of the things it no longer holds up.

**Files touched.** `recordUpstreamCloses` (src/github/issue-scan.ts), the `waitingPush` field comment
(src/github/github-issues-state.ts), `docs/invariants.md`, `docs/config.md`, `docs/steering.md`,
test/github-issue-scan.test.ts, test/github-issue-close.test.ts. `issue-close.ts`, `status-data.ts` and
`team-alert-status.ts` need no edit: the banner reads the map it is given.

**Acceptance criteria.**

- In test/github-issue-scan.test.ts, a scan whose first listing reports #8 (with the ledger then
  carrying `waitingPush: { "8": ["abc1234"] }`, `closed: { "8": … }`, `queued: { "8": … }` and
  `declined: { "8": … }`) and whose second complete listing reports none leaves `#8` in
  `upstreamClosed`, and the written ledger has no `waitingPush` entry for `"8"` while its `closed`,
  `queued` and `declined` records for `"8"` read exactly as they did before the scan — a loss settles
  the push hold and nothing else.
- A ledger hand-written with `upstreamClosed: [row8(…)]` **and** a stale `waitingPush: { "8": [...] }`
  (the shape the previous build wrote) comes back from the next complete scan with that entry gone, so
  the banner clears on an existing install without a role touching it; a `waitingPush` entry for a
  number the list does not hold survives the same scan.
- A case in test/github-issue-close.test.ts, beside the existing
  "the status figures count waiting fixes and retired-only issues, and are absent when neither holds"
  one: write a ledger whose `upstreamClosed` holds #8 and whose `waitingPush` holds only `"8"`, and
  `githubCloseForStatus(dir)` (already imported there) reads `undefined` — so `tumwater status` and the
  dashboard print no `github-close` banner at all for a lost issue — while the same ledger with one more
  `waitingPush` entry for a number the list does not hold reads `{ repo: "o/r", waitingPush: 1, retiredOnly: 0 }`.
- A scan whose listing stopped at `MAX_ISSUE_PAGES` (the fixture the existing
  "the listing stops at five pages, so a repo with 600 issues yields 500" case builds), and a scan whose
  `gh` could not read the repo, leave that `waitingPush` entry in place: only a listing known to be
  complete settles it.
- After the scan in the first criterion, `tumwater issues --show <n>` on the lost row prints its
  `closed upstream — last seen open <ago>` line and no `waiting for a push of <sha>` line for it, while
  an open issue whose fix still waits still prints that line — the second half already pinned by
  test/github-issues-render.test.ts's `waitingPush` cases, which stay unedited (no render change).
- `grep -n "stay owed" docs/invariants.md` lands inside INV-DG1 and the same entry names `waitingPush`
  as the one record a complete listing drops; `test/invariants-doc.test.ts`'s honesty check passes with
  every title cited in **Pinned by.** appearing verbatim in the file it names.

Verify: `npm run build`, then
`node scripts/check-permit.mjs node dist/test/test-runner.js github-issue-scan github-issue-close github-issues-render team-alert-status status-data doctor-checks invariants-doc config-doc backlog-structure backlog-pending backlog-eligibility plans-citations plan-citations`.

**Not covered (follow-ups).** Nothing raises a signal *for* a loss on the surfaces — the status snapshot,
the dashboard banners and the doctor's `github issues` row still say nothing about issues GitHub closed
upstream; that is a new alert/doctor-row entry, not this one. `closed`, `queued` and `declined` records
still survive a loss on purpose (they are the read's history and `isReopened`'s clock). A loss seen only
through a capped listing settles nothing, so on a repo past `MAX_ISSUE_PAGES` the banner can still stand
— the same evidence rule INV-DG1 already pins.

### `tumwater report` tallies the GitHub-issues mirror by outcome, so an operator reads what the team did about the issue tracker in a window instead of counting log lines (planned 2026-11-22 by the plan role; independent in files of the other entry still in `## Planned` (the one naming `src/github/issue-scan.ts`) — that one takes `src/github/issue-scan.ts`, `src/github/github-issues-state.ts`, `docs/config.md` and `docs/steering.md` and never `src/report/`, while this one takes `src/report/` and never the scanner or the ledger, and both add a distinct `docs/invariants.md` line so whichever lands second rebases on an additive list item; `grep -c github src/report/*.ts` prints 0 in all nine report files, and `grep -c 'GitHub issues by outcome' PLANS-DONE.md docs/cli.md` prints 0 — no planned entry, archived plan, or docs row names a report-side issue tally; the four event types it folds are all on main (`github_issue_queued`, `github_issue_closed`, `github_issue_declined`, `github_issue_upstream_closed` in `src/events/events.ts`); touches src/report/report-usage-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-since-data.ts src/report/report-render.ts src/report/report-since-render.ts docs/cli.md docs/invariants.md test/report-usage-fold.test.ts test/report-data.test.ts test/report-cli.test.ts)

**Goal.** The mirror records four outcomes in `events.jsonl` — an issue queued to the director, a
mirrored issue closed by its fix, an issue the director declined, and an issue GitHub closed
upstream — and no report reads them: `grep -c github src/report/*.ts` prints 0 in every report file,
so the only way to see the team's issue-tracker work over a window is to grep the log by hand. Add a
team-only `githubIssuesByOutcome` tally to the usage report, printed as one ranked line in the day and
`--since` reports and carried in their `--json`.

**Approach.** Fold it where every event already passes, then surface it the way `deferredByReason`
and `mergeFailedByReason` — the two existing reason-keyed, team-only maps — are surfaced, so the day
and window reports cannot drift (INV-R5's one-fold guarantee).

- `src/report/report-usage-fold.ts`: add a required `githubIssuesByOutcome: Record<string, number>`
  to `UsageFold`, seeded `{}` in `zeroUsageFold` beside `mergeFailedByReason`, and a module-private
  `foldGithubIssues(target, ev)` arm added to the `foldUsageEvent` dispatch chain. Key the bucket off
  `ev.type` alone: `github_issue_queued` → `queued`, `github_issue_closed` → `closed`,
  `github_issue_declined` → `declined`, `github_issue_upstream_closed` → `lost`. `lost` is the word the
  CLI already prints for an upstream-closed row (`IssueState`'s third state, added by the landed
  `tumwater issues --lost` plan), so one word names one outcome in both surfaces. The events carry no
  role, so the map is a team attribution keyed by outcome — the same stance `mergeFailedByReason`
  documents — and a parallel tally, never subtracted from anything.
- `src/report/report-types.ts`: add optional `githubIssuesByOutcome?: Record<string, number>` to
  `ReportDay` (zero means absent) and to `SinceReport`, documented like `deferredByReason`.
- `src/report/report-data.ts`: in `applyTeamDay` only, `setMapIfNonempty(day, "githubIssuesByOutcome",
  fold.githubIssuesByOutcome)`. `DayMapKey` is a mapped type over `ReportDay`'s `Record<string,
  number>` fields, so the write site type-checks and `rankedBy` accepts the field with no cast.
  `applyRoleDay` leaves it unset, the same as the merge and deferral maps.
- `src/report/report-since-data.ts`: add `"githubIssuesByOutcome"` to the
  `Partial<Pick<SinceReport, …>>` group of `sinceRoleMaps` and return
  `...nonemptyObj<SinceReport>("githubIssuesByOutcome", scopedByRole(acc.githubIssuesByOutcome, bases))`
  — the exact shape `deferredByReason` uses (a full map for the team, an empty one for a role-scoped
  window, absent when the window has no such event).
- `src/report/report-render.ts`: a module-private `pushReportGithubIssueLines(lines, data)` called
  after `pushReportMergeLines` in `renderReportMarkdown`, gated `data.role === undefined`, whose body
  is `pushPresentRankedLine(lines, "GitHub issues by outcome", rankedBy(data.series,
  "githubIssuesByOutcome"))`.
- `src/report/report-since-render.ts`: the twin `pushSinceGithubIssueLines(lines, data)` called after
  `pushSinceCommitLines` in `renderSinceReportMarkdown`, gated the same way, reading
  `rankedRoleMap(data.githubIssuesByOutcome ?? {})`.
- No dashboard chart: the GUI's Usage pane keeps its current blocks; the field simply rides along in
  the series payload.

**Acceptance criteria.**

- `test/report-usage-fold.test.ts`: folding one event of each type into `zeroUsageFold()` leaves
  `githubIssuesByOutcome` `{ queued: 1, closed: 1, declined: 1, lost: 1 }`; folding two
  `github_issue_queued` events leaves `{ queued: 2 }`; an event of any other type adds no key.
- `tumwater report` (team, default window) over an events file holding 3 `github_issue_queued`,
  2 `github_issue_closed`, 1 `github_issue_declined` and 1 `github_issue_upstream_closed` prints
  `**GitHub issues by outcome:** queued — 3 · closed — 2 · declined — 1 · lost — 1` (count descending,
  outcome name ascending on a tie), positioned after the merge-failure lines; a window with no such
  event prints no such line, so every existing report fixture's output is byte-unchanged.
- `test/report-data.test.ts`: `collectReport` sets `githubIssuesByOutcome` on the day that holds the
  events, omits the key on a day with none (`!"githubIssuesByOutcome" in day`), and leaves it unset on
  every day of a `--role`-scoped series; `collectReportSince`'s map equals the day series folded, the
  INV-R5 agreement check extended with the new field.
- `test/report-cli.test.ts`: `tumwater report --json`'s last series day and `tumwater report --since 2d
  --json`'s `githubIssuesByOutcome` both equal `{ queued: 3, closed: 2, declined: 1, lost: 1 }` for
  those events; `tumwater report --role feature` (day and `--since`, markdown and JSON) shows no
  outcome line and no key.
- `docs/cli.md`'s `tumwater report` row names the new team-only line beside `Merge failures by reason`
  and `Deferred runs by reason` (`test/cli-doc.test.ts` passes unchanged); `docs/invariants.md` INV-R5's
  **Pinned by** list gains the fold case that names each outcome once.

**One plausible bug this pins.** A fold arm keyed on the wrong event type (e.g.
`github_issue_closed` bucketed as `lost`) shows in the ranked line's name, and a day collector that
set the map in `applyRoleDay` too would make a `--role` report print a line the `--since` report
omits — the scoped-criterion above catches that drift.

## Done
