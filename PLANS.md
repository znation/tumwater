# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### The dashboard and `tumwater status` raise a standing banner when the mirror's scan has gone quiet

(planned 2026-11-22 by the plan role)

**Problem.** `githubScanStalled` (src/github/github-issues-state.ts) answers "the mirror is
switched on, `gh` is ready, and no scan has written the ledger for over
`GITHUB_ISSUES_STALE_MS`" — but exactly one caller asks it: `checkGithubIssues`
(src/doctor/doctor-project-checks.ts), which prints its warn line only when the operator runs
`tumwater doctor`. Meanwhile the two surfaces the operator reads every day — `tumwater status` and
the always-on dashboard — already carry the sibling GitHub banners: `buildGithubScanAlerts`
(src/ui/team-alert-status.ts) raises the gray `github-error` when the last scan failed and the blue
`github-mirror` when open issues wait on unfinished entries, and `buildStatusAlerts` raises the
amber `github-gh` when `gh` is unreadable, sharing `ghUnreadableSentence` (src/github/gh.ts) with
the doctor so the CLI and the dashboard cannot drift on wording. A stalled scan is invisible on both
surfaces: the team silently stops mirroring the operator's issue tracker and nothing they look at
says so, because `githubIssuesForPoll` leaves `checkedAt` at whatever age it already had and
`buildGithubScanAlerts` reads only `lastError` and `unmirrored`. A 24 h director outage that the
24 h alert could never see (the doctor's own threshold is 3 days) is also invisible there.

**Approach.** One shared sentence, one new alert — the `ghUnreadableSentence` pattern applied to the
stall.

- In src/github/github-issues-state.ts, next to `githubScanStalled`, export
  `githubScanStalledSentence(repo: string, checkedAt: number, now: number): string` that returns the
  doctor's current warn wording verbatim:
  `gh ready — but the last scan checked ${repo} ${humanAgo(checkedAt, now)}, over ${GITHUB_ISSUES_STALE_MS / DAY_MS} days ago, so tumwater is not mirroring its open issues`.
  `checkGithubIssues` keeps its precedence and its gate unchanged — `gh` first, then the stalled
  branch, whose warn line becomes that one call — so the doctor's output text does not move.
- In src/status/status-data.ts, carry the stall onto the snapshot so it is decided where the ledger
  is already open, not at render time: add `githubScanStall?: { repo: string; checkedAt: number }`
  to `StatusSnapshot` (src/status/status-types.ts) beside `githubClose`; widen the private
  `githubIssuesForPoll` return to `Pick<StatusSnapshot, "githubIssues" | "githubScanStall">` and
  set the new field there only when `githubScanStalled(ledger, now)` is true — `githubIssuesForPoll`
  does not take `now` today, so give `snapshotHealthFields` a `now: number` parameter and pass the
  `now` that `snapshotForStatus` (and `snapshot`, which delegates to it) already holds; its single
  call site is in `snapshotForStatus`. Leave the field absent for a missing `githubIssues` section,
  an unreadable ledger, a ledger with no `checkedAt`, or a fresh scan. It is a snapshot field, not a
  `status --json` key: no `githubIssues`/`githubClose` key exists in src/ui/status-payload.ts today,
  so add none.
- In src/ui/team-alert-status.ts `buildGithubScanAlerts`, after the `github-error` push and before
  the `github-mirror` push, raise `key: "github-scan-stalled"`, `tone: "yellow"`,
  `severity: 70`, `seenAt: 0`, title `GitHub mirror`, detail
  `githubScanStalledSentence(snap.githubIssues.repo, stall.checkedAt, now)` read from
  `snap.githubScanStall`, gated on `githubScanGate(snap)` (the existing helper, already the
  `github-mirror` alert's gate) AND on that field being present — the alert-layer twin of the
  doctor's `gh`-first precedence, so a project whose `gh` is unreadable raises only `github-gh`, and
  a null `githubIssues` store or a fresh scan raises nothing. The running gate stays as it is:
  `teamAlerts` already passes `{ snap, now }` and its `Pick` already carries `running`, so no caller
  signature changes.
- Docs in the same commit: amend docs/config.md's `githubIssues` row to say the standing surfaces
  carry the stall too, and amend docs/invariants.md INV-DE1's stall sentence — it currently names
  `checkGithubIssues` as the predicate's only consumer — to name the doctor check and the yellow
  `github-scan-stalled` banner as its two consumers, and to state that both read the one shared
  sentence.

**Files touched.** src/github/github-issues-state.ts, src/doctor/doctor-project-checks.ts,
src/status/status-types.ts, src/status/status-data.ts, src/ui/team-alert-status.ts,
test/team-alert-status.test.ts, test/team-alerts.test.ts, test/status-data.test.ts,
docs/config.md, docs/invariants.md.

**Acceptance criteria.**

- Given a ledger whose `checkedAt` is four days old, `githubIssues` trusted, `githubIssues.enabled`
  true and `gh` ready, `tumwater doctor` prints the same warn line it prints today, character for
  character: `gh ready — but the last scan checked <repo> <humanAgo>, over 3 days ago, so tumwater
  is not mirroring its open issues` (test/doctor-checks.test.ts's existing assertion keeps passing
  unchanged).
- Given a `StatusSnapshot` whose `githubScanStall` is `{ repo: "a/b", checkedAt: now - 4*DAY_MS }`,
  `buildGithubScanAlerts` returns an alert whose `key` is `github-scan-stalled`, `tone` is
  `"yellow"` and `detail` is that same sentence, so `tumwater status` prints it as an `!`-marked
  attention line under the header and the dashboard lists it among the team-attention banners.
- Given the same stalled snapshot whose `lastError` is also set, the alerts come back in the order
  `github-error`, then `github-scan-stalled`, then `github-mirror`; given a snapshot whose
  `githubScanStall` is undefined — a fresh scan, a ledger with no `checkedAt`, no `githubIssues`
  section, or an unreadable ledger — no `github-scan-stalled` alert appears at all.
- Given a snapshot with `githubErrors: ["gh is not installed"]` and a `githubScanStall` set (the
  ledger went stale while `gh` is broken), the only GitHub alert raised is `github-gh` — the alert
  gate holds the stall behind `gh`, as the doctor's check does.
- Given a real ledger written on disk and `now` four days past its `checkedAt`, `snapshot(root,
  modelsPath, now)` carries `githubScanStall: { repo: "a/b", checkedAt: <that stamp> }`; given the
  same ledger stamped an hour ago, the field is absent — and test/status-data.test.ts's existing
  `deepEqual` on the whole snapshot is updated to say so, so a stale read is pinned to the field and
  a fresh one to its absence.
- The dashboard's ordered-banner test still sees the GitHub banners in a stated order, with the new
  key named in that list.

## Done
