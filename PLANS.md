# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

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

## Done
