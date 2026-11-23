# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned
_None yet._

### `tumwater report` tallies the GitHub-issues mirror by outcome, so an operator reads what the team did about the issue tracker in a window instead of counting log lines (planned 2026-11-22 by the plan role; independent in files of the other entry still in `## Planned` (the one naming `src/github/issue-scan.ts`) — that one takes `src/github/issue-scan.ts`, `src/github/github-issues-state.ts`, `docs/config.md` and `docs/steering.md` and never `src/report/`, while this one takes `src/report/` and never the scanner or the ledger, and both add a distinct `docs/invariants.md` line so whichever lands second rebases on an additive list item; `grep -c github src/report/*.ts` prints 0 in all nine report files, and `grep -c 'GitHub issues by outcome' PLANS-DONE.md docs/cli.md` prints 0 — no planned entry, archived plan, or docs row names a report-side issue tally; the four event types it folds are all on main (`github_issue_queued`, `github_issue_closed`, `github_issue_declined`, `github_issue_upstream_closed` in `src/events/events.ts`); touches src/report/report-usage-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-since-data.ts src/report/report-render.ts src/report/report-since-render.ts docs/cli.md docs/invariants.md test/report-usage-fold.test.ts test/report-data.test.ts test/report-cli.test.ts)

**Needs review 2026-11-22 by feature: plan defect — nothing to build: this entry's deliverable is already merged and the entry is a stranded duplicate of its own archived twin (main a5e1a9c24 "Add `tumwater report` GitHub-issues outcome tally by outcome", an ancestor of HEAD; its archived heading — the identical text of this entry, plus `— done 2026-11-22 by the feature role` — sits at PLANS-DONE.md:8, where 14 `githubIssuesByOutcome` mentions and 3 `GitHub issues by outcome` lines live; the entry was put back into `## Planned` afterwards by ec883c64b, which added it again as a new `### ` heading — `git show ec883c64b -- PLANS.md` adds 1 such heading, and a5e1a9c24 had removed 1). Every criterion holds on main: `grep -c githubIssuesByOutcome` prints 3/3/1/3/1/1 across the six named src files and 3/8/5 across the three named test files, `docs/cli.md` names `GitHub issues by outcome` (1), and INV-R5 carries the outcome-map Guarantee sentence with both new **Pinned by** titles.**

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

### The `salvage patches` doctor row and its standing alert say how long a kept patch has before session retention prunes it, so an operator never learns about the deadline from a gone file (planned 2026-11-22 by the plan role; the landed dashboard salvage-View plan recorded this gap verbatim as a follow-up (PLANS-DONE.md "**Not covered (follow-ups).** ... the `salvage-patches` alert counts them but never says one is going stale, and session retention can still prune a kept patch an operator never opened") and `grep -c "session retention prunes them" src` prints exactly one hit, the row's remedy clause, which states the threat without a date; `grep -rn "prunes in\|session retention is off\|at the next prune pass" src docs test` printed 0 before this entry; independent in files of both `## Planned` entries — the report-tally entry takes `src/report/` and docs/cli.md's `tumwater report` row, the issues-View entry takes `src/github/github-issues-render.ts`, `src/cli/cli-query-commands.ts`, `src/gui/gui-*issues*`, `src/ui/gui/gui-client-settings.ts` and docs/cli.md's `tumwater issues` row, and neither names `src/doctor/`, `src/ui/team-alert-standings.ts` or the `tumwater status` row; this one edits no `docs/invariants.md` line at all (INV-T6 already pins that the amber detail is `checkSalvagePatches`'s warn sentence whole, and INV-BQ5 already pins the prune window, so both guarantees are unchanged and need no edit); touches src/doctor/doctor-salvage.ts src/doctor/doctor.ts src/ui/team-alert-standings.ts docs/cli.md docs/how-it-works.md docs/config.md test/doctor-checks.test.ts test/team-alerts.test.ts)

**Problem.** A kept workspace patch under `.tumwater/salvage/` is deleted by the session-retention pass
(`pruneFileHalves`, src/orchestrator/retention.ts — `pruneOldFiles(salvageDir(root), days)`), and the only
warning an operator gets is the doctor `salvage patches` row and the standing amber `salvage-patches`
alert, whose warn sentence ends "... before session retention prunes them". That says a deadline exists
and never says when: the row already prints the oldest patch's age (`oldest 1h`) but not the window it is
measured against (`sessionRetentionDays`, default 7, `0` disables pruning — `RetentionPruner`'s
constructor), so an operator looking at a 6-day-old patch cannot tell it is hours out, and one looking at
a team with `sessionRetentionDays: 0` cannot tell it will never be pruned at all. `checkSalvagePatches`
(src/doctor/doctor-salvage.ts) reads no config today; both of its call sites have one at hand —
`doctorSteps` already receives `config` (from `loadConfigSafe`) and `buildStandingAlerts` already
destructures `config` from its `StandingAlertsInput` — so the number can be passed rather than guessed.
`collectSalvagePatches` (src/status/status-salvage.ts) already carries each patch's `savedAt` (the file's
mtime, the very field `pruneOldFiles` compares), so no new read is needed.

**Approach.** One sentence, phrased once, in the row that the alert already copies verbatim.

- `src/doctor/doctor-salvage.ts`: `checkSalvagePatches(root, retentionDays: number, now: number = Date.now())`
  — a required window parameter, so no surface can silently claim a window the team does not run. Add a
  module-private `retentionClause(oldestSavedAt: number, retentionDays: number, now: number): string` that
  returns the clause inserted between the named-patch list and the remedy:
  - `retentionDays > 0`, deadline ahead (`deadline = oldestSavedAt + retentionDays * DAY_MS`, `DAY_MS` from
    src/text/datetime.ts): `; session retention prunes a patch older than ${retentionDays}d, so the oldest
    goes in ${humanUntil(deadline, now)}` (`humanUntil` is src/text/datetime.ts's future-direction
    countdown — s/m/h/d buckets).
  - `retentionDays > 0`, deadline already passed (a stopped team, a failed pass): `; session retention prunes
    a patch older than ${retentionDays}d, so the oldest goes at the next prune pass` — never a `0s` countdown.
  - `retentionDays === 0`: `; session retention is off, so these patches are never pruned`.
  The warn sentence becomes `${count} kept for you (oldest ${age}, ${file}): ${named}${more}` + the clause +
  ` — apply one with \`tumwater salvage --apply <n>\`, or read one with \`tumwater salvage --show <n>\` or
  delete one with \`tumwater salvage --drop <n>\`` — the stale "before session retention prunes them" tail
  moves into the clause. The ok sentence stays byte-identical, the level stays warn in all three window
  shapes (a disabled window is information, not a new warning), and the row still writes nothing.
- `src/doctor/doctor.ts`: the `salvage patches` step passes the window the team runs,
  `config?.sessionRetentionDays ?? defaultConfig().sessionRetentionDays`, the same last-good/default
  fallback shape `doctor-contention-checks.ts` uses for `maxConcurrentChecks`; a config that will not load is
  the `init` row's and the standing `config-problem` alert's to name, and this row's doc comment says so.
- `src/ui/team-alert-standings.ts`: `pushSalvagePatchesAlert(out, root, config.sessionRetentionDays)` —
  `buildStandingAlerts` already has `config` in hand (`configForStatus`'s last-known-good read), so the alert
  arm passes it to `checkSalvagePatches` and keeps copying the row's warn sentence whole through
  `pushDoctorTwinAlert`. No new alert, key, tone or action; no change to any other arm.
- Docs, one sentence each: docs/cli.md's `tumwater status` row, the `salvage-patches` clause (the alert now
  names the retention window and says outright when it is off); docs/how-it-works.md's kept-patches sentence
  (the row and alert name how long the oldest has left); docs/config.md's `sessionRetentionDays` row (kept
  salvage patches report their deadline on `tumwater doctor` and `tumwater status`).

**Acceptance criteria.**

- Given one patch saved 1 h ago and `sessionRetentionDays: 1`, `checkSalvagePatches(root, 1, now)` returns
  `warn` and a detail containing, in this order: `1 salvaged workspace patch kept for you`, `oldest 1h`,
  `1. a.patch`, `; session retention prunes a patch older than 1d, so the oldest goes in 23h`,
  `` tumwater salvage --apply <n> ``.
- Given the same 1 h-old patch and `retentionDays: 0`, the detail contains
  `; session retention is off, so these patches are never pruned`, still reads `warn`, and names no countdown.
- Given a patch 2 h old and `retentionDays: 1`, the detail contains
  `so the oldest goes at the next prune pass` and matches neither `/goes in 0s/` nor `/goes in -/`.
- With no patch and with a `pending/<role>/`-only tree, the ok details are byte-identical to today's.
- `tumwater status`'s amber `salvage-patches` alert detail equals the row's warn sentence for the same
  tree and the same configured window — including the `sessionRetentionDays: 0` form — and an absent
  `salvagePatches` snapshot still raises nothing.
- Every existing `checkSalvagePatches` call in test/doctor-checks.test.ts gains the window argument; no
  other row name, `--json` key (`salvagePatches`' `{ position, file, savedAt, bytes }` shape) or dashboard
  card output changes (test/doctor.test.ts's row-name list and test/status-payload.test.ts's salvage suite
  pass untouched).

**Not covered (follow-ups).** `tumwater salvage`'s own list still prints each patch's age but not its
deadline; the dashboard's salvage card rows do the same; a kept patch that will outlive a never-restarted
team is not separately named.

**One plausible bug this pins.** Swapping the deadline test (reading `deadline < now` as the countdown arm)
would print `goes in 0s` for a patch the pass has not reached yet and `at the next prune pass` for one with
23 h left — the 1 h/1 d case pins the 23 h figure and the 2 h/1 d case pins the passed-deadline wording, so
either swap fails one of them. A row that passed `defaultConfig().sessionRetentionDays` instead of the
loaded config would answer the 0-window criterion with a 7 d countdown.

## Done
