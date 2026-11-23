# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

### The `tumwater status` header and the dashboard's team panel gain a `QA:` badge, so a flow-coverage
  stall shows at a glance instead of only in `tumwater doctor` (planned 2026-11-23 by the plan role)

**Why:** the `qa` observer's flow-coverage ledger is the only team-facing ledger with no glance surface. Its
coverage rows appear in the qa role detail (`flowCoverage`, src/roles/role-view.ts — `tumwater role qa` and
the dashboard's qa drawer), but that is a drill-down an operator opens only after deciding to ask. The
sibling ledgers each ride the always-visible surfaces: ci parity the `CI:` badge and remote CI the `github:`
badge on the `tumwater status` header and the dashboard's team panel (one poll reader plus one badge/tone
pair in src/ui/badges.ts each), and the GitHub-issues mirror an amber alert built from `githubScanStall`
(src/ui/team-alert-status.ts's `github-scan-stalled` alert). qa's stall is decided by `qaCoverageStalled`
(`QA_COVERAGE_STALE_MS = 3 * DAY_MS`, src/observer/qa-coverage.ts) and reaches the operator only as the
`tumwater doctor` `qa coverage` warn (`checkQaCoverage`, src/doctor/doctor-project-checks.ts) —
docs/invariants.md's INV-BW3 records that row as the predicate's only consumer: "the single predicate
deciding when the `qa` observer's flow coverage has gone quiet, read by the doctor `qa coverage` warn". qa
used to have a second surface, the `qa-stale` team-alert banner, and it was deliberately deleted
(PLANS-DONE's plan that removed `pushQaStaleAlert` and `qaCoverageAlert` and kept `snap.ciParity` because
the `ci parity` row still read it); nothing was put back. An operator who watches the dashboard rather than
running the doctor learns nothing about flow coverage at all — not that it is fresh, and not that it has
silently aged past three days.

**Approach:** mirror the remote-CI badge exactly — a snapshot field, one stat-cached poll reader, a
badge/tone pair, a header span pair, a payload badge/tone pair plus the raw block, and a team-panel row.
Nothing in
src/observer/qa-coverage.ts or src/doctor/ changes: the predicate, the row and its wording stay as they
are, and the badge answers from the same predicate so the two surfaces cannot drift.

1. src/status/status-polls.ts: export `interface QaCoverageStatus { flow: string; lastRunAt: number;
   stale: boolean }` beside `CiParityStatus`/`RemoteCiStatus`, documented the same way (`flow` is the
   newest exercised flow, `lastRunAt` its stamp so each renderer formats the age from its own clock,
   `stale` is `qaCoverageStalled`'s verdict at poll time; absent when no ledger exists). Export
   `qaCoverageForPoll(root, now)` beside `remoteCiForPoll`: it reads the ledger through `cachedByStat`
   with a module-level `Map<string, StatKeyedValue<QaCoverage>>` (loader `() => readQaCoverage(root)`, clone
   a shallow copy so a caller cannot mutate the cached ledger) — a missing file never reaches the loader,
   since `cachedByStat` drops its entry when the file has no stat — and then derives the verdict from that
   ledger with the poll's `now`. Cache the ledger, never the verdict: `stale` and the age must follow the
   clock while the file stands still, which is why `remoteCiForPoll` caches only the record. The verdict is
   `newestExercise(coverage)` (null means no badge — return undefined, no throw, the same omission policy)
   plus `qaCoverageStalled(coverage, now)`.
2. src/status/status-types.ts: `qaCoverage?: QaCoverageStatus` beside `ciParity?`/`remoteCi?`, imported
   from `./status-polls.js` in that file's existing import of `CiParityStatus`/`RemoteCiStatus`, with the
   same "absent when no record exists, so the surfaces render exactly as before the badge existed" clause.
3. src/status/status-data.ts: `qaCoverage: qaCoverageForPoll(root, now)` in `snapshotHealthFields`'s return
   object, right after `remoteCi: remoteCiForPoll(root)` (that helper already takes the poll's `now`), and
   the reader added to that file's existing import from `./status-polls.js`.
4. src/ui/badges.ts: `qaBadge(status: StatusSnapshot["qaCoverage"], now: number): string` returning `""`
   for a missing status, else the ` · `-prefixed string the other badge builders return:
   ` · QA: fresh — <flow> <age> ago` when `stale` is false, ` · QA: stale — <flow> <age> ago` when true,
   the age from `humanAgo(lastRunAt, now)` as in `ciParityBadge`. `qaBadgeTone(status)` returns
   `"yellow"` for a stale record and `"blue"` for a fresh one (the header's palette — `diskBadge`'s held
   state uses `yellow` the same way), `undefined` when there is no status. The label is uppercase `QA`
   for the reason `ciParityBadge`'s comment records: the browser sidebar's `badgeLabel` upcases only the
   first character, so `qa:` would render as `Qa:`.
5. src/ui/status-render.ts: one entry at the end of `headerHealthSpans`'s array, after the remote-ci
   `badgeSpans` call — `...badgeSpans(qaBadge(snap.qaCoverage, now), qaBadgeTone(snap.qaCoverage))` — plus
   the two names in that file's import from `./badges.js`. `badgeSpans` returns no span for an empty badge,
   so a snapshot without the field keeps the header byte-identical.
6. src/ui/status-payload.ts: `qaCoverageBadge: qaBadge(snap.qaCoverage, now)` and `qaCoverageTone:
   qaBadgeTone(snap.qaCoverage)` beside `ciParityBadge`/`ciParityTone` and `remoteCiBadge`/`remoteCiTone`,
   with the same "empty string/no tone without a record, so the panel renders exactly as before" comment.
   The payload also carries the raw block like the other machine-readable twins:
   `...(snap.qaCoverage ? { qaCoverage: snap.qaCoverage } : {})`.
7. src/ui/gui/gui-client-team.ts: a sidebar row after the remote-CI row and before the disk row, guarded
   on `d.qaCoverageBadge`, drawn as `row(d.qaCoverageTone === "yellow" ? "amber" : d.qaCoverageTone,
   icon("check"), esc(badgeLabel(d.qaCoverageBadge)), <title naming the three-day window and pointing at
   the doctor row>)` — the remote-CI row's shape, with the tone translated because the sidebar palette in
   gui-styles.ts has no `.t-yellow` (it defines `.t-amber`, and the disk row picks its own `amber` for the
   state the header renders yellow).
8. docs/how-it-works.md: extend the qa sentence in the observer-ledger paragraph ("The `qa` observer
   keeps its own flow-coverage ledger the same way, and a coverage ledger whose newest exercise is over
   three days old raises the doctor `qa coverage` warn through the one `qaCoverageStalled` predicate") to
   say the same predicate drives a `QA: fresh` / `QA: stale` badge on the `tumwater status` header and the
   dashboard's team panel, and that the doctor row stays the exact surface.
9. docs/invariants.md INV-BW3: add `src/status/status-polls.ts` (`qaCoverageForPoll`) and
   `src/ui/badges.ts` (`qaBadge`, `qaBadgeTone`) to **Binds.**, and in **Pinned by.** name
   `test/status-polls.test.ts` (the `qaCoverageForPoll` cases) and `test/status-header.test.ts` (the badge
   cases) as pinning that the badge answers from `qaCoverageStalled`. The guarantee sentence keeps its
   wording except for the reader list: name the badge as the second surface that reads the predicate, so
   the invariant still states one home for the decision.

**Files touched:** src/status/status-polls.ts, src/status/status-types.ts, src/status/status-data.ts,
src/ui/badges.ts, src/ui/status-render.ts, src/ui/status-payload.ts, src/ui/gui/gui-client-team.ts,
docs/how-it-works.md, docs/invariants.md, test/status-polls.test.ts, test/status-header.test.ts,
test/badges.test.ts, test/status-payload.test.ts, test/gui-client-team.test.ts. No change to
src/observer/qa-coverage.ts, src/doctor/doctor.ts, src/doctor/doctor-project-checks.ts, or any CLI file —
the stall predicate, the `qa coverage` row and `tumwater doctor`'s row list keep their current wording and
behaviour, so docs/cli.md stays as it is.

**Acceptance criteria.**
- Given a snapshot whose `qaCoverage` is `{ flow: "login flow", lastRunAt: <30 minutes before the render
  clock>, stale: false }`, `renderStatus`'s header line contains ` · QA: fresh — login flow `; given
  `stale: true` and a `lastRunAt` four days before the render clock, it contains
  ` · QA: stale — login flow 4d ago` (the same contains-style match the ci-parity header test makes).
- Given a snapshot with no `qaCoverage` field, the header line is byte-identical to the same snapshot
  before this change (the existing header tests keep passing unchanged).
- `qaBadge(undefined, now)` answers `""` and `qaBadgeTone(undefined)` answers `undefined`; `qaBadgeTone`
  answers `"yellow"` for a `{ stale: true, … }` status and `"blue"` for a `{ stale: false, … }` one.
- Given a project whose `.tumwater/state/qa-coverage.json` is missing, `qaCoverageForPoll(root, now)`
  answers `undefined`; given a ledger with two well-formed flows whose newest `lastRunAt` is 4 days old, it
  answers `{ flow: <the newest flow>, lastRunAt: <that entry's lastRunAt>, stale: true }`; a ledger whose
  newest entry is 1 hour old answers `stale: false`; a ledger holding only malformed entries answers
  `undefined`, the same reading `readQaCoverage` gives the doctor row.
- Two `qaCoverageForPoll(root, now)` calls over an unchanged ledger answer equal objects; after the ledger
  file is rewritten, the next call answers the new entry's flow and stamp (the shape of the existing
  `remoteCiForPoll` stat-cache test in test/status-polls.test.ts). Over that same unchanged ledger, a call
  with a `now` inside `QA_COVERAGE_STALE_MS` of the newest entry answers `stale: false` and a later call
  with a `now` past it answers `stale: true` — the cache holds the ledger, not the verdict.
- The badge and the doctor row cannot disagree on one written ledger: with a newest entry 4 days old,
  `checkQaCoverage(root, now)` answers a `warn` and `qaCoverageForPoll` answers `stale: true`; with `now`
  inside `QA_COVERAGE_STALE_MS` of that same entry, the row answers ok and the poll reader answers
  `stale: false`.
- The payload test's shape (test/status-payload.test.ts's remote-CI case): given a project with no
  `.tumwater/state/qa-coverage.json`, `statusPayload(repo, now)` answers `qaCoverageBadge: ""` and
  `qaCoverageTone: undefined` and carries no `qaCoverage` key; after a ledger is written at
  `qaCoveragePath(repo)` with one flow `"login flow"` at `lastRunAt: now - 4 * DAY_MS`, the same call
  answers `qaCoverageBadge` exactly ` · QA: stale — login flow 4d ago`, `qaCoverageTone: "yellow"` and a
  `qaCoverage` block `{ flow: "login flow", lastRunAt: <that stamp>, stale: true }`; with
  `lastRunAt: now - 60_000` it answers ` · QA: fresh — login flow 1m ago` and tone `"blue"`.
- The team panel renders a row whose label is `QA: stale` (uppercased through `badgeLabel`) carrying the
  `t-amber` class when the payload carries `qaCoverageBadge`/`qaCoverageTone: "yellow"`, a `t-blue` row for
  `qaCoverageTone: "blue"`, and no `QA` row when `qaCoverageBadge` is `""` — asserted in
  test/gui-client-team.test.ts beside the existing ci-parity and remote-CI rows.
- docs/invariants.md's INV-BW3 **Binds.** list names `qaCoverageForPoll`, `qaBadge` and `qaBadgeTone`, and
  the guard checks (backlog-structure, plan-citations, invariants-doc, cli-doc, config-doc) stay green.

**Independent of** the two waiting dashboard card plans: it touches none of
src/gui/gui-salvage-commands.ts, src/gui/gui-issues-commands.ts, src/github/**, gui-server.ts routes,
src/ui/gui/gui-client-settings.ts, src/ui/gui/gui-client-boot.ts, test/gui-client-settings.test.ts, or
docs/cli.md — so a runner can take it alongside either without a conflict.

## Done
