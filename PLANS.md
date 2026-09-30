# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### `tumwater diff` fleet-wide — one line per loop holding pending work, no `--role` needed (planned 2026-09-29)

- **Goal.** Between a loop's commit and its merge, its work lives only on its branch and
  worktree. The Done entry "`tumwater diff --role <id>` — show the change a loop holds"
  (planned/done 2026-09-29, above) answers that for one named loop, but a fleet-wide "what
  is every loop about to land?" still means querying each role by hand — the one fleet view
  without an all-roles form, since every other one (status, logs, history, backlog, report)
  has it. Give `tumwater diff` a no-`--role` form: one line per loop that holds pending
  work, and `--json` prints the roster as data. This plan builds on that Done entry's
  module, `src/ui/change-preview.ts`; it changes nothing about the per-role view.
- **Approach.** In src/ui/change-preview.ts, beside `collectRoleChange`/`renderRoleChange`,
  add: a `FleetRoleChange` interface — one entry per role with `role`, `branch`, `state`
  (`"absent" | "no-base" | "ready"`, the RoleChangeView states), `ahead`, `commits`
  (`{sha, subject}[]`), `dirtyFiles` — i.e. the RoleChangeView fields minus the
  `diff`/`uncommittedDiff` patch strings (the patches stay in the per-role view; a
  fleet-wide patch dump would be 13 roles × 200 KB); a `FleetChangeView` of
  `{mainBranch: string, roles: FleetRoleChange[]}`; a `collectFleetChanges(root)` that
  maps `knownRoleIdsCached(root)` (src/config.ts — built-in plus custom loop ids, config
  order; disabled roles included, since a loop stopped mid-flight still holds its branch)
  to `collectRoleChange(root, role)` and drops the two patch fields per entry — reusing
  `collectRoleChange` keeps the `absent`/`no-base` degradation logic single-homed, and the
  patch git-diffs it computes for nothing only run for roles actually holding work, each
  capped by the module's `DIFF_MAX_BYTES`; and a `renderFleetChange(views)` that skips
  entries that are `no-base` or hold nothing (`ahead === 0 && dirtyFiles.length === 0`),
  prints one line per remaining role in roster order — `<role>: <ahead> commit(s) ahead of
  <mainBranch>`, gaining `, <n> uncommitted file(s)` when `n > 0` (pluralization via
  src/text.ts's `plural` where it fits) — prints `no pending changes` when no line remains,
  and reuses the per-role `main branch <name> does not exist` line when every entry is
  `no-base` (`mainBranch` resolves fleet-wide in `resolveMainBranch`, so that condition is
  fleet-wide) — every degraded case exit 0, like the per-role view. In src/cli.ts's
  `case "diff"`: `parseRoleFlag` already returns null for an absent flag and fails on an
  empty or unknown value, so replace the `if (role === null) fail("diff needs --role…")`
  branch with the fleet path — absent `--role` runs `sayJsonOrRender(args, await
  collectFleetChanges(root), renderFleetChange)`; present `--role` keeps the existing
  `collectRoleChange` path untouched; the `rejectUnknownArgs` spec is unchanged. In
  src/help.ts add a `  tumwater diff [--json]` stanza (one line per loop holding pending
  work — ahead-of-main commit count and uncommitted-file count, no patch; the `--role`
  form is the full view; `--json` prints the `{mainBranch, roles}` roster) above the
  existing `--role` form; `helpStanzas`/`helpTopic` group both under `diff` because both
  carry the same command token, like `logs`' two forms. In README.md extend the usage
  table's diff row to note that without `--role` it lists every loop's pending change in
  one line each. In test/cli-diff.test.ts (existing; the "fails fast" test at its
  `missing` case currently pins the old behavior) update that test so a bare `diff` no
  longer fails — the missing-`--role` failure assertions are replaced, while empty
  `--role`, unknown role, and stray-flag failures keep their existing wording — and add:
  on a seeded repo where the feature worktree holds one unlanded commit plus one dirty
  file (the file's `seededFeatureRepo`-style setup, plus a dirty append), `tumwater diff`
  exits 0 printing exactly the `feature` line with both counts and no lines for other
  roles; with nothing pending anywhere it prints `no pending changes` (exit 0); a
  configured-missing baseBranch (the existing test's `ghost` setup) prints
  `main branch ghost does not exist` (exit 0); `tumwater diff --json` parses to
  `{mainBranch, roles}` with `mainBranch` `"main"`, one entry per known role in
  `knownRoleIdsCached` order, the holding role carrying `ahead`/`commits`/`dirtyFiles`,
  and no `diff`/`uncommittedDiff` keys on any entry.
- **Files touched.** src/ui/change-preview.ts (+~70 lines: the two interfaces,
  `collectFleetChanges`, `renderFleetChange`), src/cli.ts (+~10 in `case "diff"`),
  src/help.ts (+1 stanza), README.md (1 usage-table line), test/cli-diff.test.ts
  (+~110 lines including the updated fail-fast test).
- **Acceptance criteria.**
  1. On a seeded fleet where the feature worktree holds one unlanded commit and one dirty
     file and no other role holds work, `tumwater diff` exits 0 printing exactly one
     pending line — `feature: 1 commit ahead of main, 1 uncommitted file` — with no lines
     for other roles; with nothing pending anywhere it prints `no pending changes`.
  2. A configured-missing baseBranch prints `main branch <name> does not exist` (exit 0);
     empty `--role`, unknown role, and unknown flags still fail with the existing
     wording; `tumwater diff --role <id>` output is byte-identical to before.
  3. `tumwater diff --json` prints the roster: `mainBranch` names the resolved baseline,
     `roles` holds one entry per known role in `knownRoleIdsCached` order with
     `state`/`ahead`/`commits`/`dirtyFiles` and no patch fields.
  4. `npm run test` passes; `tumwater help diff` shows both forms.

## Done

### `tumwater diff --role <id>` — show the change a loop holds: its branch's unlanded commits and its worktree's uncommitted edits (planned 2026-09-29, done 2026-09-29)

- **Goal.** Between a loop's commit and its merge, the change lives only on the role's branch —
  and mid-tick, uncommitted edits live only in its worktree. The dashboards show a text label
  for this (the GUI drawer's `landingSummary`) but no operator surface shows the actual change:
  an operator auditing "what is the feature loop about to land?" must git-spelunk
  `.tumwater/worktrees/<role>` by hand. Every other fleet view (status, logs, history,
  backlog, report) is a CLI command; the pending change is the one view without one. Give it
  `tumwater diff --role <id>`.
- **Approach.** Everything the command needs already exists; this plan wires it, it invents
  nothing. New src/ui/change-preview.ts exports `collectRoleChange(root, role)` and
  `renderRoleChange(view)`: resolve `mainBranch` the way doctor's checkRepo resolves the
  fleet's target — a configured `baseBranch` in tumwater.json wins (`run --branch` is
  per-invocation and invisible to a later CLI query), then `currentBranch(root)` (src/git.ts),
  then "main" — so the diff compares against the branch the fleet actually lands on; a
  resolved main that does not exist degrades to a `main branch <name> does not exist` line
  (exit 0). The role's branch and worktree come from
  `branchName(role)` and `worktreePath(root, role)` (src/paths.ts). When the worktree dir is
  missing or `gitTry(wt, "rev-parse", "--git-dir")` returns null, the view is `absent` — a
  fresh fleet or never-run loop renders `no worktree for <role>` (exit 0), so the command
  degrades like report does rather than requiring a ready repo. Otherwise collect both halves:
  the committed half via `aheadOfMain(wt, mainBranch)` (src/git.ts),
  `gitTry(wt, "log", "--oneline", "<main>..HEAD")` for the subject list, and
  `aheadOfMainDiff(wt, mainBranch)` (src/git-diff.ts) for the patch — its existing 200 KB cap
  with the --stat-plus-largest-files fallback is reused verbatim, so the output can never be
  unbounded; the uncommitted half via `changedFiles(wt)` (src/git-diff.ts, porcelain) for the
  file list and `gitTry(wt, "diff", "HEAD")` capped the same way for the patch — `HEAD` so a
  staged edit shows in the patch its porcelain file list already counts (plain `git diff`
  covers unstaged only; untracked paths appear in the file list alone). The render prints the
  commit log one line per commit, the committed patch, then `uncommitted (N files)` with the
  same shape; when both halves are empty it prints `no pending change for <role>`. In
  src/cli.ts add `case "diff"`: no `requireReadyRepo` gate (absent worktrees degrade, per
  above), `rejectUnknownArgs` with the shared `ROLE_FLAG` spec, `parseRoleFlag` for the value
  — `--role` is required here, so an absent value fails with the existing
  `ROLE_VALUE_ERROR` wording, and a missing `--role` fails pointing at `tumwater help diff`.
  `--json` prints
  the collector's own payload (`{role, branch, mainBranch, state, ahead, commits: [{sha,
  subject}], diff, dirtyFiles, uncommittedDiff}` — `mainBranch` names the baseline the diff
  was computed against, and `state` is `absent` (no usable worktree), `no-base` (resolved
  main branch missing), or `ready`), following the `--json` series' collector-payload rule. Add
  the HELP stanza in src/help.ts (one form, under the logs/history family) and a README usage
  table row so the doc stays accurate.
- **Files touched.** src/ui/change-preview.ts (new, ~90 lines), src/cli.ts (+~12),
  src/help.ts (+1 stanza), README.md (+1 table row), test/cli-diff.test.ts (new, ~130 lines,
  built on test/repo-fixtures.ts and test/cli-harness.ts like the other CLI command tests).

  First landed 2026-09-29, rejected in review on two points, re-landed the same day: the
  baseline now resolves `baseBranch`-first like doctor/status instead of
  `currentBranch(root) ?? "main"` (with a `no-base` degrade for a configured-but-missing
  branch, and `mainBranch` added to the JSON payload so scripts see what was compared
  against), and the uncommitted patch uses `git diff HEAD` so a staged edit is actually in
  the patch its file list counts. Tests pin both fixes: the baseBranch-counts-differently
  case and the staged-only-edit case.
- **Acceptance criteria.**
  1. On a seeded fleet, a commit on `tumwater/feature` ahead of main makes
     `tumwater diff --role feature` print that commit's subject and a patch naming its
     changed file; a dirty worktree adds the `uncommitted (N files)` section naming the dirty
     paths; both empty prints `no pending change for feature` (exit 0).
  2. A role with no worktree yet prints `no worktree for <role>` (exit 0); missing or empty
     `--role` fails with the usage line / ROLE_VALUE_ERROR; an unknown flag is rejected.
  3. `tumwater diff --role feature --json` prints the payload above with `ahead` and the raw
     diff as data.
  4. `npm run test` passes; the new stanza appears in `tumwater help` and `tumwater help diff`.

### `tumwater history --since <duration>` — window-shaped tick history, completing the `--since` pattern (planned 2026-09-29, done 2026-09-29)

- **Goal.** `tumwater history` answers "the last N ticks" only: an operator auditing "what
  happened since the last failed landing" or "over the last hour" must guess a count. The two
  sibling observability commands already speak durations — `logs --since <duration>` and
  `report --since <duration>` (both capped at 7d) — so history is the odd one out. Give it the
  same window shape over the same record.
- **Approach.** Everything the window needs already exists; this plan wires it, it invents
  nothing. In src/history-data.ts (113 lines) add `readTickRowsSince(root, sinceMs, role)`
  beside `readTickRows`, mirroring cmdLogs' since path (src/ui/log-commands.ts lines 90–113):
  `cutoff = Date.now() - sinceMs`; `readWindowEvents(root, dayKey(cutoff))` — the shared
  rotation-spanning reader (src/event-window.ts), so the archive `events.jsonl.1` is covered
  for free; filter events to `typeof e.ts === "number" && e.ts >= cutoff` (the day-keyed read
  may include earlier hours of the cutoff's day); then reuse the existing pure `tickRows`
  with `limit = events.length` (newest first, role filter intact) and return
  `{ rows, covered }` where `covered` is `eventWindowCovers(window, cutoff)` — the exact
  predicate cmdLogs uses, so the two surfaces cannot disagree about when the window is proven.
  In src/ui/history.ts's `cmdHistory`: `--since <duration>` is a rival shape to `-n`
  (same rule and wording shape as logs' "a count and a window are rival shapes"), parsed with
  the shared `parseDurationFlag` and capped with `failOverDurationCap` against the existing
  `LOGS_SINCE_MAX_MS` (reuse that constant — same log, same cap; no third cap value).
  `--role` composes with `--since` here (history's `--role` is a filter, not the rival view
  logs guards against), and `--json` works unchanged: an empty window prints nothing in JSON
  mode (`{"rows":[]}`, the report --json precedent) and `no ticks in <duration>` in table
  mode (reuse `durationLabel`, as cmdLogs does); when rows exist and `covered` is false,
  print cmdLogs' hedged note verbatim — "note: the log's oldest retained event lies inside
  this window; older events may have rotated out" — only in table mode, only after rows.
  Update the `rejectUnknownArgs` list for history in src/cli.ts (add
  `{ names: ["--since"], value: true, valueName: "<duration>" }`) and the HELP text's history
  line in src/help.ts to match. The GUI's /api/history stays count-shaped this round — the
  dashboard's history tab asks for rows, not windows; extending the endpoint is a follow-up
  only if an operator asks for it.
- **Files touched.** src/history-data.ts (+~35), src/ui/history.ts (+~25), src/cli.ts (+2),
  src/help.ts (+1 line of help text), test/history-data.test.ts and test/ui-history.test.ts
  (new window cases, ~80 total).
- **Done 2026-09-29 by feature, as planned.** Two deviations from the entry as written:
  the project consolidated history's tests into test/cli-history.test.ts (there are no
  test/history-data.test.ts or test/ui-history.test.ts files — the new window cases live
  there, ~100 lines), and the README's per-tick-history usage row was updated to show the
  new flag so the doc stays accurate. Help-text line wrapping keeps "machine-readable
  history data" on one line so the existing help-stanza pin keeps matching.
- **Acceptance criteria.**
  1. A seeded log spanning several days: `history --since 2h` returns exactly the tick_end
     events at or after the cutoff (role filter composes), newest first, with paired durations
     where the tick_start survives the read; `--json` emits the same rows with raw ts/tokens/
     costUsd and `{"rows":[]}` for an empty window.
  2. `--since` combined with `-n` fails with the rival-shape message; an over-cap or malformed
     duration fails through the shared helpers with the same wording shape logs --since uses.
  3. When the window's oldest retained event lies inside the window (rotation or idleness),
     the hedged note prints after the table in table mode only — never in `--json` output.
  4. No `--since`: behavior is byte-identical to today (default 20 rows, `-n` ceiling 200,
     existing tests pass unchanged).
  5. `npm run test` green.

### Windowed event reads span the rotation boundary: `readWindowEvents` continues into `events.jsonl.1` (planned 2026-09-29, done 2026-09-29)

- **Goal.** Every windowed consumer of the event log — `logs --since`, the usage report's
  `--days`/`--since` collectors, the failure digest's day-windowed pass, and the GUI endpoints
  that reuse them — reads only the live `events.jsonl`. The log rotates at 16 MB into
  `events.jsonl.1` (files.ts `rotateIfLarge`), and on a busy fleet a 16 MB file holds less
  than the default 14-day window, so the readers silently degrade to a truncated view plus a
  "note: older events may have rotated out" line even though the missing events sit right
  there in the archive on disk. The archive is written today and read by nothing.
- **Approach.** `readWindowEvents` (src/event-window.ts) already scans the live file backwards
  in chunks with an early stop and computes `coversFullWindow`. Split the per-file backwards
  scan into a helper and call it twice: after the live-file scan, while `coversFullWindow` is
  still false, scan `events.jsonl.1` the same way; its in-window events are strictly older
  than the live file's, so prepending them keeps the oldest-first ordering every consumer
  assumes, and the dedup-free concatenation is safe because rotation moves the whole file —
  the two files share no lines. `coversFullWindow` becomes true when either file's oldest
  retained event predates the window, so the existing rotation note (`ui/report.ts` line ~81,
  `ui/log-commands.ts`'s covered check) stays exactly right in both directions: it vanishes
  once the archive completes the window and still appears when even the archive starts inside
  it. Add `eventsArchivePath` (root) → `eventsLogPath(root) + ".1"` to src/paths.ts as the
  single home beside `eventsLogPath` — keep the one-archive retention as is (opinionated
  default; the note still tells the truth when the archive itself is not old enough).
  No consumer changes: src/ui/log-commands.ts, src/report-data.ts (both call sites), and
  src/failure-data.ts get archive coverage through the shared reader unchanged. The
  count-bounded scans (`readEvents`' default tail, history-data.ts's window ladder) are out
  of scope — they answer "the last N ticks", not a time window.
- **Files touched.** src/paths.ts (+4), src/event-window.ts (restructure of `readWindowEvents`,
  roughly +40 net), test/event-window.test.ts (new rotation-boundary cases, ~100).
- **Acceptance criteria.**
  1. A fixture planting `events.jsonl.1` (older days) beside a live `events.jsonl` (today):
     `readWindowEvents` with a window spanning the boundary returns events from both files,
     oldest-first, in-window only; `collectReport`'s per-day series sums to the seeded totals
     across the boundary.
  2. `coversFullWindow` is true when the archive's oldest event predates the window start and
     false when the archive's oldest event is still inside it — the report's and
     `logs --since`'s rotation notes track it in both directions.
  3. Missing or empty `events.jsonl.1` (the normal case): `readWindowEvents` returns exactly
     today's `{ events, coversFullWindow }` behavior — the existing test/event-window.test.ts
     cases pass unchanged.
  4. Torn/corrupt lines in the archive follow the same skip policy as the live file
     (`parseEventLine`), and a window that lies entirely inside the live file never touches
     the archive.
  5. `npm run test` green.

### Count the landing slot's spend in the usage report: `landed`/`land_failed` usage folds into `tumwater report` totals, with a reviewer-and-conflict-resolution breakdown line (planned 2026-09-29, done 2026-09-29)

**Goal.** The usage report claims to answer "where did the money go", but it counts only
`tick_end` events: `src/report-data.ts` `foldUsageEvent` handles `tick_end` and `merged` and
nothing else, while the landing slot stamps the reviewer's and conflict-resolution runs'
tokens and cost onto the `landed`/`land_failed` events it logs (`src/landing-slot.ts`
`writeLandingOutcome`, `...(usage.tokens > 0 ? { tokens: usage.tokens } : {})` — the same
`eventUsage`-compatible keys `tick_end` carries). Every landed change goes through the
landing slot, so a busy fleet's reviewer spend — often a large share of total cost — is
invisible in `tumwater report`, `report --since`, and their `--json` payloads, while the
daily budget *does* charge those same runs (`src/tick-usage.ts` `fold` →
`recordDailyCost`, reached via `src/loop.ts` `foldLandingUsage`). The operator sees a report
smaller than the budget header's day spend with nothing explaining the difference. This plan
folds landing usage into the report totals and shows it as its own line, so the report and
the budget finally agree and the reviewer's share of spend is visible.

**Approach.**

1. **Collector (`src/report-data.ts`).** Extend `foldUsageEvent`: on `landed` or
   `land_failed`, add `eventUsage(ev)`'s tokens/cost to two new accumulators on `UsageFold`
   (`landingTokens`, `landingCostUsd`) — NOT to the existing totals fields, so the fold stays
   one pass — and count events as `landingRuns` the way `ticks` counts `tick_end` (the day
   collector passes `ticks: undefined`; mirror that with a `landingRuns?: number` field).
   Then `collectReportSince` adds the three fields to `SinceReport`'s surface
   (`landingRuns`, `landingTokens`, `landingCostUsd`) and `collectReport` folds them into each
   `ReportDay` (`tokensOut`/`costUsd` per day grow by the landing amounts, keeping the day
   series summing to totals) plus day-level `landingCostUsd` for the series bar context.
   Totals semantics: `totals.tokensOut` and `totals.costUsd` INCLUDE landing spend from the
   same events the budget charges, so report == budget; the separate landing fields say how
   much of it was reviewer/conflict work. No double counting exists by construction: landing
   runs fold after their tick's `tick_end` fired (the authoring tick ends `queued`), and the
   landing accumulator only ever sees the slot's own pi runs.
2. **Renderers (`src/ui/report.ts`).** `renderReportMarkdown` and
   `renderSinceReportMarkdown` each gain one line under the Totals line, e.g.
   `of which landing runs: 12 runs · 45.2k tokens · $0.84 (reviewer + conflict resolution)` —
   omitted entirely when `landingRuns === 0` (the same zero-means-absent rule the cost-by-role
   line follows), so a fleet with no landing spend renders exactly as today. The `--json`
   payloads need no renderer work: they print the collector's object, which now carries the
   new fields.
3. **Docs (`src/help.ts`, `README.md`).** The `report`/`report --since` stanzas say "tokens
   counts work ticks; totals also include landing runs (reviewer + conflict resolution)" in
   one added sentence — the help text's existing habit of naming what a number counts
   (`-n` bounds the scanned window, not the printed rows).

**Note 2026-09-29, feature run.** Landed with three deviations from the draft, none changing
the acceptance criteria: (1) the day series carries `landingRuns` and `landingTokens` as well
as `landingCostUsd` (all sparse — absent until the day folds a landing event), because the day
report's totals line needs the run count and there is no per-role map a day could derive it
from, unlike ticks/`ticksByRole` — so `foldUsageEvent` counts `landingRuns` on every fold
target rather than gating it the way `ticks` is; (2) the day's `tokensOut`/`costUsd` grow by
the landing amounts right after the event pass (the budget charges these same events, so the
series keeps summing to the totals), while `collectReportSince` combines the landing
accumulators into its surfaced totals itself; (3) the type-literal fallout ran wider than
exact-field-set assertions: the `ReportData`/`SinceReport` literals in test/report.test.ts
(totals gained the three required fields) and the one `ReportData` literal in
test/gui-report.test.ts needed updating, so that file joins the touched list for real.

**Files touched:** `src/report-data.ts`, `src/ui/report.ts`, `src/help.ts`, `README.md` (the
usage table's report row), `test/report.test.ts`, `test/gui-report.test.ts` (its `ReportData`
literal gained the totals fields).

**Acceptance criteria.**

- A fixture log holding one `tick_end` (tokens A, cost a) and one `landed` (tokens B, cost b)
  yields a report whose totals read A+B tokens and a+b cost, with the landing line showing
  exactly B/b and 1 run; `land_failed` with usage folds identically; `merged` still counts
  only as a commit.
- `report --since` behaves identically over a trailing window, and both `--json` payloads
  carry `landingRuns`/`landingTokens`/`landingCostUsd` (day series carries `landingCostUsd`).
- A log with no `landed`/`land_failed` events renders byte-identical to today's output (no
  landing line, totals unchanged).
- The failure digest is deliberately untouched: its time-and-spend fold stays tick-shaped
  (`tick_end` only) — a landing is not a tick, and its outcome table keys on tick results.
- `npm run test` passes, including the updated report fixtures. — All met (suite 2183/2184, 1 skipped).


### Fleet-wide backend-failure hold: extend the 429 storm hold to connection, 5xx, and model-load failures (planned 2026-09-29, done 2026-09-29)

**Goal.** The only cross-role failure response is the 429 storm hold (src/rate-limit-hold.ts `rateLimitHold`, fed by `transientRateLimit` in src/pi-stream.ts via src/tick-usage.ts `lastRateLimit`). Other backend-wide failures are unclassified: "Connection error.", "Request timed out", 5xx "Internal Server Error", "Failed to load model", and memory-guard rejections or aborts. Each fails every role separately, and each role backs off on its own `ERROR_BACKOFF` ladder. That is ~100 ticks all time (mostly the local-model era) and 7 in the last week ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). When one backend is down, every role learns it separately.

**Approach.** (refined 2026-09-29: pinned the event shape, the kind semantics, and the memory-guard scope; dropped a status-header badge the code never had — the events already surface the hold.)
- src/pi-stream.ts: add `transientBackend = false` beside `transientServerTimeout`/`transientRateLimit` (the flags block near line 111) and a module-private `TRANSIENT_BACKEND` regex beside the existing ones near line 50, matching the error texts pi actually surfaces: connection error/refused/reset, `Request timed out`, the 5xx phrases (`Internal Server Error`, `Bad Gateway`, `Service Unavailable`, `Gateway Timeout`), and `Failed to load model`. Set the flag in the same `for` loop that checks the other two (near line 199), alongside `TRANSIENT_RATE_LIMIT`. Keep rate-limit matched separately and checked first, so a 429 stays a 429. Memory-guard failures are out of scope: no src/ code classifies them today, so there is no text to match.
- Export a pure `backendKind: "connection" | "timeout" | "server" | "model-load"` classifier on PiStreamParser (a small function beside `RETRY_AFTER`'s use), so the observation carries a kind without re-matching the text later. `retryAfterSeconds` stays undefined for backend kinds.
- src/tick-usage.ts `fold`: beside the `lastRateLimit` stamp, add `lastBackendFailure?: { at: number; kind: BackendFailureKind }`, stamped under the same rule — `run.transientBackend && !run.ok`, with `at: Date.now()`.
- src/rate-limit-hold.ts: generalize rather than add a second reducer. `RateLimitObservation` gains `kind: "rate-limit" | BackendFailureKind`; `RateLimitHold` gains `kind: string` (null-while-open like `until`). In `rateLimitHold`'s storm filter, observations count toward one storm only when their kinds match, and `roles` collects within that kind; `retryAfterMs` is unchanged (backend kinds carry no hint). A relapse is a new storm **of the same kind** within `RATE_LIMIT_RELAPSE_MS` of the re-open — a different kind starts fresh at the base. Rename the exported surface honestly: `rateLimitHold`→`fleetHold`, `RateLimitHold`→`FleetHold`, `RATE_LIMIT_OPEN`→`FLEET_OPEN`; call sites are only src/tick-timing.ts, src/orchestrator.ts (the `rateHold` declaration and `pollRateLimitHold` call), and the tests.
- src/tick-timing.ts `pollRateLimitHold`: gather each runner's `lastRateLimit` (kind "rate-limit") and `lastBackendFailure` into one observations array. Keep the existing event types — no `backend_hold`/`backend_resumed` pair — but add `kind` to the `rate_limit_hold` event payload (src/events.ts widens the payload type).
- Render the kind where the events render: src/event-format.ts `case "rate_limit_hold"` (near line 159) and src/failure-state-change.ts `case "rate_limit_hold"` (near line 93) lead with the kind for non-rate-limit holds, e.g. `backend hold (connection error) — <roles> …`; a `"rate-limit"` kind keeps today's exact wording. No new event types means src/ui and the digest need no other change.
- The director's exemption is untouched: its observations still count as evidence (src/tick-timing.ts already includes the director's runs), and the gating sites in src/orchestrator.ts (`startHeld` near line 388 and the `usesSlot` check near line 575) are unchanged.

**Note 2026-09-29, feature run.** Landed with five deviations from the draft, none changing the acceptance criteria: (1) `BackendFailureKind` is defined in src/pi-stream.ts beside the `backendKind` classifier and re-exported through src/pi.ts with `PiRunResult` (which now carries `transientBackend` + `backendKind`, threaded in `resultFromParser`'s single construction site); (2) `FleetHold.kind` is NOT null-while-open as drafted — nulling it at re-open would erase the one fact the same-kind relapse test needs (the re-opened state is what the next storm compares against) — so it holds the last hold's kind while open and is null only before the first hold; (3) `pollRateLimitHold`'s runner parameter became a structural exported `HoldInputs` type (src/tick-timing.ts) instead of `Pick<LoopRunner, …>`: the runner's hold getters are readonly and the test stands in plain mutable objects; (4) the shared kind phrase lives in src/text.ts (`backendKindPhrase`, beside `rateLimitHoldPhrase` — both renderers already import text.ts); (5) the hold-poll tests stayed in test/orchestrator-seams.test.ts, where they already lived, so that file joins the touched list instead of test/tick-timing.test.ts (which never tested the poll), alongside test/event-format.test.ts, test/failure-state-change.test.ts, and test/fake-pi.ts (the new result default).

**Files touched:** src/pi-stream.ts, src/pi.ts, src/tick-usage.ts, src/rate-limit-hold.ts, src/tick-timing.ts, src/loop.ts (the `lastBackendFailure` getter, beside `lastRateLimit`), src/events.ts (the rate_limit_hold comment), src/text.ts, src/event-format.ts, src/failure-state-change.ts, src/orchestrator.ts (rename only), and tests in test/pi-parser.test.ts (home of the parser unit tests since 2026-09-29, when test/pi-stream.test.ts merged into it), test/rate-limit-hold.test.ts, test/tick-usage.test.ts, test/orchestrator-seams.test.ts, test/event-format.test.ts, test/failure-state-change.test.ts, test/fake-pi.ts.

**Acceptance criteria.** The new regex classifies the listed connection/5xx/model-load texts and does not claim 429 texts. `fold` stamps `lastBackendFailure` only when the run ended on it, with the kind and no retry hint. Two distinct roles ending on the same backend kind within `RATE_LIMIT_STORM_WINDOW_MS` open a hold carrying that kind; two roles on *different* kinds, or two hits from one role, do not. A relapse of the same kind escalates and caps at `RATE_LIMIT_HOLD_CAP_MS`; a different kind after a hold re-opens starts at the base. A 429 storm behaves byte-for-byte as today (same hold math, same event wording). The `rate_limit_hold` event carries `kind`, rendered with backend wording in the feed and the digest. The director is not held. `npm run test` passes. — All met (suite 2155/2156, 1 skipped).

### Retire the README freshness stamp: `tumwater status` reports main's last green check (planned 2026-09-29, done 2026-09-29)

**Goal.** The readme role's contract (src/roles.ts, the `readme` role's `find`) makes the status section carry `Current main (<sha>): build clean, suite N/N`, and says "a moved main makes the stamp stale, so syncs still run after landings". Every landing therefore schedules a README commit. That is 184 of readme's 231 commits all time and 60 in the last 7 days (9% of all commits), and 1% of readme's lines survive ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). Volatile state does not belong in a committed file. The harness can report it live instead. Depends on the harness-attested suite counts plan above for the counts.

**Approach.**
- src/roles.ts `readme`: the status section carries (a) the capability summary and (b) the open-work pointer, and no stamp. Delete the "moved main makes the stamp stale" sentence. The readme role syncs when user-facing surfaces drifted (commands, flags, config keys, docs), and `git log <last readme commit>..main` replaces `<stamped sha>..main` as its delta, found via the role's own `Tick: readme #N` commit trailer. Update the pin in test/prompt.test.ts.
- src/ui/status.ts `snapshot`: add `mainCheck: { sha?, status, counts?, at }` — the newest `build_check` at the `landing`/`batch`/`baseline` scope in the event tail. The sha is the main commit the check verified: a `landed` event after the check names it (landing/batch checks run pre-merge), otherwise main's current tip (a baseline check runs ON the tip, and a later landing would have logged a newer check); the tip is read synchronously from the ref files, so src/git.ts's `currentBranchFromHeadFile` is now exported for it.
- A display-ready `mainCheckBadge` (` · main <sha>: green · N/N (N skipped)`) lives beside the other header badges in src/ui/status-model.ts and renders in the `tumwater status` header (src/ui/status-render.ts) and the GUI header (src/ui/gui-client.ts, via the payload's preformatted badge — the same pattern buildBadge uses).
- README.md: delete the stamp line from the managed status section in the same change. docs/how-it-works.md and the init template name no stamp, so they needed nothing.

**Files touched:** src/roles.ts, src/ui/status.ts, src/ui/status-payload.ts, src/ui/status-model.ts (the shared badge, added beyond the plan: the payload and the header must render one string), src/ui/status-render.ts (header), src/ui/gui-client.ts (header consumer, likewise added), src/git.ts (exported an existing private helper the sync snapshot needed), README.md, and tests in test/prompt.test.ts, test/status.test.ts, and test/status-render.test.ts.

**Acceptance criteria.** The readme prompt no longer mentions a freshness stamp or `<stamped sha>`. `status --json` carries `mainCheck` with the newest merge-scope check's sha, status, and counts (absent before any check). The status header renders it. README.md has no `Current main (` line. `npm run test` passes. — All met (suite 2134/2135, 1 skipped). First landed 2026-09-29 but rejected in review for a producer/consumer field mismatch — the sha derivation read the `landed` event's `sha`, a field production never logs (writeLandingOutcome logs `commit`) — and re-landed the same day reading `commit`, with tests using the real event shape and the payload omitting `mainCheck` entirely before any check.

### Time and spend by outcome in the failure digest (planned 2026-09-29, done 2026-09-29)

**Goal.** The failure digest (src/failure-report.ts `renderFailureMarkdown`) counts ticks by outcome per role. A 200 ms error and a 30-minute timeout therefore weigh the same, and nothing ranks agent-hours or dollars lost by cause. `tick_end` carries no duration (src/loop.ts, the `tick_end` `logEvent`). Only `tumwater history` pairs it with `tick_start`, and it never sums the result. The 2026-09-22 timeout episode (97 ticks, ~55 agent-hours discarded) read as 97 identical errors ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)).

**Note 2026-09-29, feature run.** Landed with three deviations from the draft, none changing the acceptance criteria: (1) the shared tick-start pairing helper lives in src/events.ts (`tickStartMap`) rather than src/ui/history.ts — the codebase keeps collectors free of core→ui imports, and history.ts still switched to it; (2) the table's error-class bucket holds every non-landed, non-no_change result (review gate and merge-gate outcomes price in too), while the loss ranking clusters only `error`/`aborted`/`quiet_killed` as drafted — the other error-class results carry no message a cluster can own; (3) the byte-bound test moved 6 → 7 KB for the new section's worst case (one 3-cell row per configured role + 5 loss-cause lines). `report --failures --json` now prints the collector's `FailureReportData` — the old "clustered narrative with no agreed JSON shape" refusal is retired, since the digest now has a stable data shape.

### Yield-scaled clocks: a search role whose recent ticks land nothing ticks less often (planned 2026-09-29, done 2026-09-29)

**Goal.** Maintenance and search roles tick on a fixed clock plus the idle ladder. The idle ladder resets on any main move, so a role that keeps finding nothing keeps paying for it. From 2026-09-22 to 09-29, perf spent $1.17 on 41 no_change ticks against $0.48 on its 15 landings, and qa spent $0.38 on 23 no_change ticks for 2 landings ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). A role's own recent yield should stretch its interval, and one landing should restore it.

**Approach.**
- src/loop-state.ts `LoopState`: added `recentOutcomes?: string` — a ring of one-char codes, `L` for a landing (`changed`/`queued`) and `n` for a counted empty, last YIELD_RING=20 entries, maintained by `applyTickOutcome` (src/tick-outcome.ts). `error`/`aborted`/`quiet_killed` are not yield evidence and never enter the ring, so backend failures neither stretch nor reset a role's clock.
- A pure `yieldMultiplier(recent: string[]): number` (beside `nextBackoffSeconds`): 1 while any of the last 10 counted ticks landed, otherwise 2 at 10 empties, doubling per 5 further empties (15 → 4, 20 → 8), capped at 8. `isEligible` (src/scheduling.ts) multiplies the role's effective `minTickIntervalSeconds` gap by it — the gap check runs first, so the multiplication gates the "main moved" wake too, which is where the cost comes from.
- Applies to `DEFERRABLE_ROLES`, the observer roles (qa, telemetry), and bugfix (predicate `yieldScaledRole` in src/roles.ts). Deviation from the draft: bugfix scales regardless of whether BUGS.md has open bugs — isEligible does not read the backlog, and ten consecutive empty ticks are empty-yield evidence however many bugs are recorded; demand prioritization stays deferTick's job. Never feature, plan, or director; a pending inbox prompt or a fresh `wake` bypasses the gap entirely.
- Surface: `tumwater status` and `status --json` show `×N` beside the next-run time when the multiplier is above 1, so an operator can see why a role is quiet.

**Files touched:** src/loop-state.ts, src/tick-outcome.ts, src/roles.ts, src/scheduling.ts, src/ui/status-model.ts (the shared `yieldMultiplierFor`), src/ui/status-render.ts (the next-run cell — where the cell actually lives, not status-model as first drafted), src/ui/status-payload.ts (the `yieldMultiplier` JSON field), src/ui/gui-client.ts (the GUI's fmtNextRun twin), docs/how-it-works.md, and tests in test/tick-outcome.test.ts, test/scheduling.test.ts, test/status-render.test.ts, and test/gui.test.ts (the lockstep twin).

**Acceptance criteria.** Ten consecutive no_change ticks give a multiplier of 2, and it caps at 8. One `changed`/`queued` tick resets it to 1. Error-class results neither raise nor reset it. A role at ×4 with a 20 s gap does not tick on a main move within 80 s. `wake` and inbox prompts bypass it. feature, plan, and director are never scaled. `npm run test` passes.

**Note 2026-09-29, second run.** The first implementation was rejected in review for riding unclaimed work: its diff carried the dry role's test/orchestrator-3.e2e.test.ts refactor (then unlanded on main) and the objection about its dropped failure-path abort+drain. That refactor has since landed on main on its own (eb7b1235); this run re-implemented the plan on current main, so the diff contains only this plan's files — test/orchestrator-3.e2e.test.ts is untouched.

### Plan just in time: stop refining while plans wait, and anchor plans on symbols (planned 2026-09-29, done 2026-09-29)

**Goal.** 113 of plan's 193 commits all time, and 16 of 45 from 2026-09-22 to 09-29, re-audit or refine a waiting plan because landings moved its anchors ("re-audit … after 95 landings of drift"). The role prompt invites this ("if PLANS.md already has several unimplemented plans, prefer refining the weakest existing plan"). The plans also cite line numbers (`src/cli.ts, the doctor case (lines 132-140)`), which drift on nearly every landing, although feature greps for symbols anyway ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)).

**Approach.**
- src/roles.ts `plan`: replace the "prefer refining the weakest existing plan" clause with: when PLANS.md `## Planned` already holds two or more plans without a Needs-review note, end with the nothing-to-do sentinel. Feature has work, and a waiting plan is refined by the feature run that picks it up, against the code as it is then. The Needs-review split rule stays first.
- src/role-guidance.ts `PLAN_SIZING` (shared with the director): anchor on file paths and symbol names (functions, types, constants, test names), never on line numbers or ranges, because line anchors go stale with every landing.
- src/roles.ts `feature`: one line saying that when a plan's anchors no longer match, correct the entry in the same change instead of refusing.
- Pin the new wording in test/prompt.test.ts.

**Files touched:** src/roles.ts, src/role-guidance.ts, test/prompt.test.ts. (Implementation: `NOTHING_TO_DO` is now imported into src/roles.ts from src/reply-contract.js so the plan prompt ends with the literal sentinel, and the plan-role test also pins that the "refining the weakest" clause is gone.)

**Acceptance criteria.** The plan prompt tells the role to stop at two or more waiting plans and no longer says "prefer refining the weakest". `PLAN_SIZING` forbids line-number anchors. The feature prompt allows in-place anchor correction. The prompt pins pass, and `npm run test` passes.

### Harness-attested suite counts: parse the gate check's `node --test` summary and hand it to the reviewer (planned 2026-09-29, done 2026-09-29)

**Goal.** The VERIFIED line of every commit body is model-written (src/prompt.ts `SUMMARY_BLOCK`, e.g. `"npm test, 182 pass"`), and the reviewer's checklist rejects a VERIFIED claim the diff disproves (src/gate-prompts.ts `buildReviewPrompt`). From 2026-09-22 to 09-29, 151 of 686 reviews were rejected, and roughly 113 of those reasons cite a record claim, most often a count or SHA ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). The harness already runs the suite at the gate. Today it keeps only green/red plus a failure tail, and even throws away the `ℹ pass N` lines (src/build-check-report.ts `FRAMING_LINE`). The harness should own the counts, so a model can no longer get them wrong.

**Approach.**
- src/build-check.ts: add `counts?: { tests: number; pass: number; fail: number; skipped: number }` to `BuildCheckOutcome`. Fill it from the combined stdout/stderr on both passed and failed outcomes with a pure `parseTestCounts(output): counts | undefined` that matches node's `ℹ tests N`, `ℹ pass N`, `ℹ fail N`, and `ℹ skipped N` summary lines (the last block wins). A project whose check prints no such block gets `undefined`, and nothing else changes.
- src/build-check-events.ts `buildCheckEvent`: include `counts` when present, so `build_check` events record it.
- src/review.ts, where `verifiedByHarness` is set: append the counts, e.g. `` `npm test` (the project's declared check) passed — 2065 pass, 0 fail, 1 skipped of 2066 ``.
- src/gate-prompts.ts checklist item 2: the reviewer checks that the claimed *commands* and observations match the diff. Counts are harness-attested and appear above. A count missing from VERIFIED is not a finding.
- src/prompt.ts `SUMMARY_BLOCK`: VERIFIED asks for what was run and observed beyond the suite total ("npm test; repro script showed X before, Y after"). Drop the `182 pass` example so authors stop restating counts. Update the prompt pins in test/prompt.test.ts.

**Files touched:** src/build-check.ts, src/build-check-events.ts, src/review.ts, src/gate-prompts.ts, src/prompt.ts, and tests in test/build-check.test.ts, test/review.test.ts, and test/prompt.test.ts.

**Acceptance criteria.** `parseTestCounts` reads the real runner's summary, including `skipped`, returns `undefined` for output with no summary, and takes the last block when several appear. A passing gate check's `build_check` event carries `counts`. The review prompt names the counts when the check passed. `SUMMARY_BLOCK` no longer shows a count example, and the review checklist says counts are harness-attested. `npm run test` passes.

- Bugfix defers like a maintenance role while BUGS.md has no open bugs (planned 2026-09-29, done 2026-09-29; commit 550f3bbd)
- A deterministic unused-export check in the suite (planned 2026-09-29, done 2026-09-29; commit 9a66e789)
- Cancel a queued prompt from the dashboard — the GUI's queued-prompts rows get a per-row cancel control, backed by a file-addressed `/api/prompt-cancel` (planned 2026-09-29, done 2026-09-29; commit 0d23f313)
- `tumwater doctor --json` — the pre-flight report as machine-readable data, finishing the scriptable-surface series (planned 2026-09-28, done 2026-09-29; commit bfb37aaf)
- `tumwater backlog --json` — the project backlog as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit 933d2bdf)
- `tumwater logs --json` — the event feed as machine-readable NDJSON, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit b87d724c)
- `tumwater history --json` — the per-tick history as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28; commit 4aba2051)
- `tumwater report --json` — the usage report as machine-readable data, beside `status --json` (planned 2026-09-28, done 2026-09-28; commit ad5dfce4)
- GUI history tab — the dashboard shows the per-tick history `tumwater history` prints (planned 2026-09-28, done 2026-09-28; commit 495525f6)
- `logs --grep <text>` — show only the events whose type or rendered line matches (planned 2026-09-28, done 2026-09-28; commit 713835af)
- `report --since <duration>` — totals over a trailing window, not whole days (planned 2026-09-28, done 2026-09-28; commit 2060487d)
- `logs --since <duration>` — show the events of a time window, not a guess at a count (planned 2026-09-28, done 2026-09-28; commit e20948b4)

- Pause countdown — show when a timed pause auto-resumes (`status`/TUI header badge, GUI pause badge) (planned 2026-09-25, done 2026-09-28; commit 00cf2e98)
- `tumwater history [--role <id>] [-n N]` — one row per completed tick, newest first (planned 2026-09-28, done 2026-09-28; commit 5d0f978e)
- Timed pause — `tumwater pause [--role <id>] --for <duration>` auto-resumes (planned 2026-09-25, done 2026-09-28; commit 670fb0a1)

- Per-role prompts 2/2 — surface the per-role queue on the dashboards (planned 2026-09-25, done 2026-09-25; commit f91ed2b2)
- `tumwater run --once --role <id>` — one round scoped to a single role (planned 2026-09-25, done 2026-09-25; commit 758e6de1)
- Next-run visibility — show when each sleeping loop will tick again (`tumwater status`, TUI, GUI) (planned 2026-09-25, done 2026-09-25; commit ce24d771)
- Per-role prompts 1/2 — `tumwater prompt --role <id> <text...>`: steer one loop directly from the terminal (planned 2026-09-25, done 2026-09-25; commit 761af2b7)
- `tumwater run --once` — one full round of ticks (every enabled role once, landings drained), then exit (planned 2026-09-25, done 2026-09-25; commit 52cbadd1)
- `tumwater backlog` — read the project's planned features, open bugs, and open questions from the terminal (planned 2026-09-25, done 2026-09-25; commit 3251fd9a)
- TUI per-loop controls — pause/resume, abort, and wake the loop whose transcript you are viewing (planned 2026-09-25, done 2026-09-25; commit 84e17230)
- Per-role pause 2/2 — dashboard per-row pause toggle (planned 2026-09-25, done 2026-09-25; commit 568b7cc8)
- Per-role pause 1/2 — `tumwater pause --role <id>` / `resume --role <id>`: quiet one loop while the fleet keeps working (planned 2026-09-25, done 2026-09-25; commit 88903ade)
- `tumwater config` — print the effective merged config as JSON (planned 2026-09-25, done 2026-09-25; commit 4fa76fca)
- `tumwater stop` — stop a running fleet from another terminal (planned 2026-09-24, done 2026-09-25; commit 69568f58)
- Land-queue speed 2c — Split landing into a parallel vetting stage and a serial merge stage (planned 2026-09-23, done 2026-09-24; commit 84af95b)
- Land-queue speed 1/3 — Take the build-fix run out of the landing slot: retry a failed gate check once, then hand the failure to whoever caused it (planned 2026-09-23, done 2026-09-24; commits 4e9bf7f, 91ef22a)
- Land-queue speed 2a — Approvals survive a clean rebase: key them by patch-id, not sha (planned 2026-09-23, done 2026-09-24; commit 689a293)
- Land-queue speed 3c — One writer to main: route leftover recovery through the land queue (planned 2026-09-23, done 2026-09-24; commit 3206c2e)
- Land-queue speed 3d — When a batch check is red, land the largest passing prefix (planned 2026-09-23, done 2026-09-24; commit c35f78c)
- Land-queue speed 2b — One process-wide cap on concurrent build checks: `maxConcurrentChecks` (planned 2026-09-23, done 2026-09-24; commit 16e25b1)
- Land-queue speed 3e — Optional cheaper per-change gate check; the full suite runs once per stack (planned 2026-09-23, done 2026-09-24; commit 46c0bde)
- Land-queue speed 3a — Give the reviewer its own time budget (planned 2026-09-23, done 2026-09-24; commit 376547d)
- 7b/7 — `tumwater init --adopt` and `--dry-run`: adopt an existing repo without touching its README (planned 2026-09-23, done 2026-09-24; commit 063d9b4)
- Give every failure an automated trace: retire the recurring `no-observability` validation gap (planned 2026-09-26, done 2026-09-24; commit 199ed60)
- Land-queue speed 2d — Per-change landing markers so the dashboards show what is really happening (planned 2026-09-23, done 2026-09-24; commits 127157a, 95f848c)
- Land-queue speed 3b — Tell the reviewer, as a rule, not to re-run a verified suite (planned 2026-09-23, done 2026-09-24; commit 07d205e)
- 7a/7 — Resolve the project brief as `TUMWATER.md`, with README.md as the compatibility path (planned 2026-09-23, done 2026-09-23; commit 3be47ac)
- Wake and abort from the GUI dashboard (planned 2026-09-25, done 2026-09-23; commit d947041)
- 6/7 — Make the project's verification command configurable (planned 2026-09-14, done 2026-09-25; commit 4924a54)
- Optional shared-token auth for the GUI dashboard — `gui --token <secret>` (planned 2026-09-23, done 2026-09-23; commit 66c5af0)
- Cost by role in the usage report (planned 2026-09-25, done 2026-09-23; commit 6e1bf39)
- Bound tool output head+tail with a tumwater pi extension (planned 2026-09-23, done 2026-09-24; commit d964507)
- Tell ticks to fan out independent tool calls in one turn (planned 2026-09-23, done 2026-09-23; commit 449985c)
- 5/7 — Make the agent binary configurable (planned 2026-09-14, done 2026-09-24; commit ff4beee)
- 4b/7 — Untrack this repo's own config without deleting it (planned 2026-09-14, done 2026-09-22; commit 48b3474)
- 4a/7 — Seed an untracked config from a tracked template (planned 2026-09-14, done 2026-09-22; commit 0733811)
- 3/7 — Harness-mediated config writes: take custom loops off the commit path (planned 2026-09-14, done 2026-09-23; commit 726e3cc)
- 2/7 — Resolve the repo root, and target any branch (planned 2026-09-14, done 2026-09-22; commit c033ad1)
- Fix a failed landing build check on the spot instead of rejecting (planned 2026-09-21, done 2026-09-23; commit 4803c07)
- Landing gate checks latest main: rebase the pinned change before the build pre-check (planned 2026-09-21, done 2026-09-21; commit f0993fc)
- 1/7 — GitHub Actions CI and a publishable npm package (planned 2026-09-14, done 2026-09-21; commit e6a4228)

- 4c/7 — Move README's rig notes into docs/backends.md (planned 2026-09-14, done 2026-09-21; commit dfa6d26)
- TUI failures pane — the failure digest in the Ctrl+T cycle (planned 2026-09-20, done 2026-09-21; commit c92c549)
- Fleet pause from the dashboard — a click-to-pause control in the GUI header (planned 2026-09-20, done 2026-09-21; commit f265dd7)

- Human-friendly numbers in the report tab's chart labels (planned 2026-09-20, done 2026-09-21; commit 6926014)
- Failure digest in the GUI — a `failures` tab beside `report` (planned 2026-09-19, done 2026-09-19; commit d4d734e)
- Live config-change event — surface what a tumwater.json edit changed (planned 2026-09-19, done 2026-09-19; commit 1767778)
- Red-main handoff — point the bugfix loop at the failing suite when main is red (planned 2026-09-19, done 2026-09-19; commit cfac056)
- Repair traces — record what made each bug hard to validate (planned 2026-09-17, done 2026-09-19; commit 794e170)
- Show the exact prompt each run received — `tumwater logs --role <id> --prompt` (planned 2026-09-19, done 2026-09-19; commit 30f3124)
- Observer roles 2/2 — a flow-coverage ledger so `qa` can rotate (planned 2026-09-17, done 2026-09-19; commit 492cbeb)
- Feature loop hands oversized plans to the plan loop instead of splitting them inline (planned 2026-09-18, done 2026-09-19; commit ac97ec6)
- Telemetry 2/2 — a `telemetry` role that reads the digest and files bugs (planned 2026-09-17, done 2026-09-19; commit 24ded35)
- Telemetry 1/2 — a deterministic failure digest over the fleet's own event log (planned 2026-09-17, done 2026-09-18; commit 39dfc33)
- Observer roles 1/2 — stop scheduling a passing check as an idle tick (planned 2026-09-17, done 2026-09-18; commit c1ad951)
- TUI/GUI auto-reload when a newer build lands on disk (planned 2026-09-13, done 2026-09-18; commit 614ff78)
- Merge queue 5/5 — coalesce the build check across queued landings (planned 2026-09-08, done 2026-09-18; commit 8a3e6a1)
- Fallback model — keep working for free once the daily budget is spent (planned 2026-09-18, done 2026-09-18; commit 7ab1275)
- Merge queue 4/5 — surface the land queue on status and both dashboards (planned 2026-09-08, done 2026-09-15; commit 776fa0f)

- GUI report charts: show a label on each bar segment at the cursor on mouse hover (planned 2026-09-14, done 2026-09-15; commit b56c96f)
- Merge queue 3/5 — asynchronous landing via a durable land queue (planned 2026-09-08, done 2026-09-14; commit bdec4f1)
- Remove the per-loop tokens/sec column from the TUI/GUI tables (planned 2026-09-14, done 2026-09-14; commit b5180be)
- Merge queue 2/5 — land in a per-role detached worktree (planned 2026-09-08, done 2026-09-13; commit a90a1ac)

- Show per-loop token generation rate (5-minute moving average) in the TUI/GUI (planned 2026-09-08, done 2026-09-13; commit 8477f9b)
- User-defined loops 3/3 — dashboard identification: mark user-defined loops on both surfaces (planned 2026-09-07, done 2026-09-13; commit 332e072)
- User-defined loops 2/3 — director control surface: add/remove/rearrange from the prompt box (planned 2026-09-07, done 2026-09-12; commit 0b1db0a)
- User-defined loops 1/3 — config plumbing: `customLoops` in tumwater.json (planned 2026-09-07, done 2026-09-12; commit 7aaa69a)
- Show the GUI loop table's last tick with relative age — match the TUI's "· Nm ago" (planned 2026-09-11, done 2026-09-12; commit 8865aa8)
- Make the daily cost budget editable from the TUI/GUI (planned 2026-09-07, done 2026-09-12; commit e8bdd24)
- Sort the GUI loop table by state category, then last tick (planned 2026-09-09, done 2026-09-11; commit fafebbe)
- TUI "usage report" pane in the Ctrl+T cycle — report 3/3 (planned 2026-09-10, done 2026-09-11; commit dd32fc5)
- GUI "report" tab with SVG dashboard — report 2/3 (planned 2026-09-10, done 2026-09-10; commit 465f1f6)
- Usage report core + `tumwater report` CLI subcommand — report 1/3 (planned 2026-09-10, done 2026-09-10; commit 542e49a)
- Prioritize loops by need — defer unneeded maintenance ticks and order work roles first (planned 2026-09-08, done 2026-09-10; commits 1406be5, b2ddeb6)
- Merge queue 1/5 — landing takes a worktree and a ref (planned 2026-09-08, done 2026-09-08; commit 8665dca)
- Label review-gate runs in loop transcripts (planned 2026-09-07, done 2026-09-08; commit 7730bb1)
- Read backlog entries in full from the TUI/GUI dashboards (planned 2026-09-05, done 2026-09-07; commits 2c85ea4, 1a5fff9)
- Fleet pause — `tumwater pause` / `tumwater resume` (planned 2026-09-05, done 2026-09-06; commits 9481eeb, 7c56ca1, b76fab1)
- Pre-flight environment check — `tumwater doctor` (planned 2026-09-05, done 2026-09-06; commits 784d487, be36b71)
- Machine-readable fleet state — `tumwater status --json` (planned 2026-09-05, done 2026-09-05; commit e46b811)
- Red-main baseline check — skip authoring runs while main is red (planned 2026-09-04, done 2026-09-05; commits 377cf0f, e7ef65c)
- Steward curation of BUGS.md's Fixed history — compress old fixed bugs to one-line records (planned 2026-09-04, done 2026-09-05; commit 24f39e2)
- Steward curation of PLANS.md's Done history — compress old done plans to one-line epitaphs (planned 2026-09-04, done 2026-09-04; commit 81c50a2)
- Section-aware tick reads — stop paying for history every tick (planned 2026-09-04, done 2026-09-04; commit 7516413)

- Bound README's status section — state, not log (planned 2026-09-03, done 2026-09-04; commit 9e00d29)
- Run the project's own test suite in the deterministic pre-merge gate (planned 2026-09-04, done 2026-09-04; commit 495570f)
- Abort a single loop's in-flight tick — `tumwater abort --role <id>` (planned 2026-09-03, done 2026-09-04; commits b37e600, 6b52731, 0d4c41b, 7a9fa8d, ff42635)
- Per-loop today spend — which loop is eating the day's budget (planned 2026-09-02, done 2026-09-03; commits c17893d, 02a8661)
- Steward role — whole-system judgment on a slow clock (planned 2026-08-24, done 2026-09-02; commits 6e3f487, be6dc56, bf42c98)
- Per-tick usage in the event feed — tokens and cost on every tick_end (planned 2026-09-02, done 2026-09-02; commit 3e4086a)
- Director inbox management — list and cancel queued prompts (planned 2026-09-01, done 2026-09-02; commits 53c0477, 349482e, 9c20312, da86dbd)
- Live sessionRetentionDays — re-prune old pi sessions without a restart (planned 2026-08-31, done 2026-09-02; commits eaa9848, 349482e, 157215f)
- Show queued director prompts in TUI/GUI (planned 2026-09-01, done 2026-09-01; commit 55af189)
- Live maxConcurrent — resize the concurrency cap without a restart (planned 2026-08-31, done 2026-09-01; commit af61b7e)
- Self-explaining commit bodies (planned 2026-08-24, done 2026-08-31; commits b41185d, 0f73491, d930959, 4021c1d)
- Daily cost budget — cap the fleet's autonomous spend (planned 2026-08-30, done 2026-08-31; commits 041fd55, 01c28ce, 07d5bf6, 2fbfb49, 92a4ffe, b589e09)
- The right to refuse, and friction as a signal (planned 2026-08-24, done 2026-08-30; commits c2f541a, 0326a2a, 82c7631, bc479b6, c477ce9, 7212a7e, 8e6eeae)
- Questions outbox — loops that know when to ask (planned 2026-08-24, done 2026-08-29; commits 2547b4d, 0294f45, 1a48edc, 931ca26)
- Adversarial review gate before merge (planned 2026-08-24, done 2026-08-29; commits 74224e9, 8ea49b8, 93d14f5, 038519a, 36b0adc, 50ef9eb)
- QA role — exercising the product like a user (planned 2026-08-24, done 2026-08-28; commit 6859e43)
- Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, done 2026-08-26; commit 9ef07d9)
- PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24, done 2026-08-26; commit abd2963)
- Show open bugs and planned features in the TUI/GUI (planned 2026-08-24, done 2026-08-26; commit 7023381)
- Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25, done 2026-08-25; commit 39bfe9d)
- CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25, done 2026-08-25; commit 5374aa5)
- Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25; commit 82c7910)
- Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25; commit 52fcfa2)
- Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, done 2026-08-24; commit d36cb17)
- Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, done 2026-08-23; commit 48f45a1)
- Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21; commit 9ddd731)
- Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21; commit 3e002c9)
- Web GUI (done 2026-08-20; commit 2182085)
- pi-driven merge conflict resolution (done 2026-08-20; commit 2182085)
- Per-role model/effort overrides (done 2026-08-20; commit 2182085)
- Log rotation and session pruning (done 2026-08-20; commit 2182085)
