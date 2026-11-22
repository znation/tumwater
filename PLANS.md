# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### The mirror ledger keeps the row of an issue tumwater closed, so `tumwater issues` can still name what it closed

(planned 2026-11-22 by the plan role)

**Problem.** `tumwater issues` answers "what has the mirror seen, and what did tumwater do about
it?", but the answer loses its own best entries: the moment `closeFixedIssues`
(src/github/issue-close.ts) closes issue #7 it drops #7 from `ledger.open` and records only
`ledger.closed["7"] = { at, shas }` (`closeOne`, the line `ledger.closed = { ...(ledger.closed ??
{}), [key]: { at: now, shas } }`) — an instant and the closing shas, with no title, url, author or
body. Every read path folds tumwater's state onto `ledger.open` rows only (`issueRows` and
`foldIssueState` in src/github/github-issues-render.ts; `cmdIssues` and `cmdIssuesShow` in
src/cli/cli-query-commands.ts), so a closed issue renders nowhere: absent from the list, from
`--grep`, from `--show <n>` and from `--json`. Two finished plans chose that limit from the reader's
side — closed issues are not listed "the closed list holds no title", and `--json` reports open
issues only for the same reason (both in PLANS-DONE.md, the `tumwater issues` mirror read and its
`--show` follow-up). This plan removes the limit where it is set, in the ledger.

**Approach.** Keep the row the closer already has, in a second list beside `open`, and let the
existing fold render it.

- `src/github/github-issues-state.ts`: `GithubIssuesLedger` gains
  `closedRows?: GithubIssueRow[]`, declared beside `closed`, optional so a ledger written before
  this change still reads. `readGithubIssues` filters it with the existing row guard
  (`isGithubIssueRow`) exactly as it filters `open`, so a hand-edited or foreign-generation list of
  junk degrades to fewer rows, never a throw.
- `src/github/issue-close.ts`, `closeOne`: at the step that writes `ledger.closed[key]`, also move
  the row out of `ledger.open` and into `ledger.closedRows` — the same row object, its `updatedAt`
  replaced by the close instant's ISO string (so the list's age segment reads as the close age), its
  `bodyExcerpt` kept so `--show` can still print why the issue existed. `closeOne` is the only place
  the list grows, and it trims it there to the 50 rows whose close instant is newest, so the ledger
  file cannot grow past ~50 kept bodies on top of what `closed` already holds.
- `src/github/issue-scan.ts`, `scanGithubIssues`: when a scan's fresh `open` list contains a number
  that is in `previous.closedRows`, that row leaves `closedRows` — the issue is open again, and
  `isReopened` (src/github/github-issues-state.ts) still reads the retained `closed[key]` marker to
  mark it a reopen and re-offer it. `...(previous ?? {})` already carries an unknown key forward, so
  a scan that sees neither change neither list. No other scan change: `closeCandidates` iterates
  `ledger.open` only, so a row in `closedRows` is never a close candidate again.
- `src/github/github-issues-render.ts`: `issueRows` folds `ledger.open` (ascending by number, as
  today) followed by `ledger.closedRows` (same order), so positions number across both and
  `issueRowAt`, `grepIssueRows` and the detail view need no change. `foldIssueState` gains a
  `wasClosed: true` on a row taken from `closedRows`, which is what distinguishes a listed closed
  issue from an open issue that still carries a stale `closed` marker after a reopen. That flag is
  also what `issueAge` reads: an open row's age segment stays `updated <ago>` and a closed row's
  reads `closed <ago>` (its `updatedAt` is the close instant), so the list never shows a closed
  issue as if it were live. `IssuesHeader` gains
  gains `closedCount: (ledger.closedRows ?? []).length` in `issuesHeader`, and `renderIssues`
  inserts `, <n> closed by tumwater` after the open count and before `, checked <ago>` when
  `closedCount > 0` and nothing at all when it is 0, so a ledger with no closed rows keeps its header
  byte-identical. `src/cli/cli-query-commands.ts` needs no change of its own: `cmdIssues`,
  `cmdIssuesShow` and `issuesJson` all reach the ledger through `issueRows` and `issuesHeader`.
  `docs/cli.md`'s "Read the GitHub-issues mirror" row gains the closed count in its header
  description and says the numbered list ends with the issues tumwater closed, each with
  `closed <ago>` in place of `updated <ago>`.

**Files.** `src/github/github-issues-state.ts`, `src/github/issue-close.ts`,
`src/github/issue-scan.ts`, `src/github/github-issues-render.ts`,
`docs/cli.md`; tests `test/github-issue-close.test.ts`, `test/github-issue-scan.test.ts`,
`test/github-issues-render.test.ts`, `test/cli-issues.test.ts`.

**Not covered (follow-ups).** No `--closed`/`--open` filter and no cap knob; no change to
`githubIssuesSummary`, the `status` row, its alerts or the doctor's `github issues` check; no change
to `githubCloseForStatus`'s sha-safety gate or to `closeCandidates`'s rule for who may close. The
detail view's out-of-range wording keeps its current text — `no GitHub issue at position N (github
issues mirror holds <M> open issues)` — even when M counts closed rows; three existing assertions in
test/cli-issues.test.ts pin it, and rewording it is separate work. `docs/invariants.md` gains no
section here: the pending `githubScanStalled` plan takes the next free prefix (INV-DE), and this
change states no new cross-file guarantee that a prefix would pin beyond the tests below.

**Acceptance.**
- In test/github-issue-close.test.ts: after `closeFixedIssues` closes #7, `ledger.closed["7"]` holds
  `{ at: NOW, shas }` as today, #7 is in no other list, and `closedRows` holds one row for #7 whose
  `title`, `url` and `author` are the ones from the row it replaced and whose `updatedAt` is the ISO
  form of `NOW`. A second pass over the same ledger makes `gh issue close` never run for #7 again:
  the fake runner records no further `close` call.
- In test/github-issue-close.test.ts: 60 candidates closed in one pass (60 distinct issues, each
  with a finished mirroring entry and its fix commit on the branch) leave `closedRows` holding
  exactly the 50 rows whose close instant is newest.
- In test/github-issue-scan.test.ts: a closed #7 written by `closeFixedIssues` survives two more
  `pollGithubIssues` scans with its number and title intact; when the fake `gh open` fixture starts
  reporting #7 open again, one later scan lists #7 in `open`, holds no `closedRows` entry for it,
  keeps `closed["7"]`, and the row reads as reopened (`isReopened` true, and the queue offers it
  again with the reopened preamble naming the last closing sha).
- In test/cli-issues.test.ts: a ledger file with no `closedRows` key at all still reads and prints
  its list and header byte-identically to today's assertions; a ledger whose `closedRows` is
  `["not-a-row", null]` prints the same list with no closed rows and exits 0.
- In test/github-issues-render.test.ts: a ledger with open #10 and `closedRows` [#9] whose
  `closed["9"].at` is three days before `now` returns rows `[[1, 9], [2, 10]]` in that order — closed
  rows last regardless of number — with #9's row carrying `wasClosed: true` and its list line ending
  `, closed 3d ago`; #10's row has no `wasClosed` and its line ends `, updated <ago>`.
- In test/cli-issues.test.ts, for a ledger with open #7 and #8 and `closedRows` [#9] (marker three
  days old): `tumwater issues` prints three numbered rows, #9 last and its line ending
  `, closed 3d ago`, under a header line ending `2 open, 1 closed by tumwater, checked <ago>`; `tumwater issues --show 3` prints #9's title and the
  `closed 3d ago: <sha>` state line; `tumwater issues --json` serves three issues whose #9 object
  carries `wasClosed: true` and whose #7/#8 objects do not; `tumwater issues --grep 9` keeps #9 under
  its whole-list position 3, and a pattern matching nothing still prints
  `no GitHub issues match "<pattern>"`.

## Done
