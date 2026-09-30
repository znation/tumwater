# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

_None yet._

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


### Bugfix defers like a maintenance role while BUGS.md has no open bugs (planned 2026-09-29, done 2026-09-29)

**Goal.** bugfix is a work role (`WORK_ROLES`, src/roles.ts), so `deferTick` (src/scheduling.ts) never defers it, and it wakes on every main move even when BUGS.md `## Open` is empty. In that state it runs its open-ended latent-bug hunt. From 2026-09-22 to 09-29 that produced 133 no_change ticks costing $2.27, the largest nothing-to-do spend of any role ([docs/commit-history-analysis.md](docs/commit-history-analysis.md), "Last 7 days"). With open bugs it is real work and must never wait. With none it is a search role and should schedule like one.

**Approach.**
- src/scheduling.ts `deferTick`: add an `openBugsNow: boolean` input, or pass the role's backlog emptiness. It defers `bugfix` under the same predicate as a `DEFERRABLE_ROLES` member (last result `no_change`, main seen before, no fresh operator wake, `DEFER_MAX_MS` cap), but **only while `openBugs(root)` is empty**. While any bug is open, bugfix never defers (today's behavior). Since the backlog-open clause is what keeps maintenance deferred, bugfix's version is "defer only while no feature/bugfix/director/human commit landed since its last tick". Its own backlog being empty is the precondition, not the deferral reason.
- src/orchestrator.ts, where `deferTick` is called for "scheduled"/"main moved" wakes: pass `openBugs(root).length === 0`. It already computes `openBugs` for `workBacklogOpen`, so reuse that read.
- `WORK_ROLES` keeps bugfix: slot ordering (`roleTier`/`fairOrder`) is unchanged.
- Update `deferTick`'s doc comment and the scheduling section of docs/how-it-works.md.

**Files touched:** src/scheduling.ts, src/orchestrator.ts, docs/how-it-works.md, test/scheduling.test.ts.

**Acceptance criteria.** With BUGS.md `## Open` empty, a bugfix whose last tick was `no_change` is deferred on a main move made only by maintenance roles, and runs on a feature/director/human landing, a fresh `wake`, or once `DEFER_MAX_MS` has passed. With one open bug it is never deferred. Other roles' deferral is unchanged (existing tests hold). `npm run test` passes.

**Implementation note (2026-09-29, feature).** Landed as planned, plus: `BUGFIX_ROLE` is now exported from src/roles.ts (scheduling.ts and orchestrator.ts name the role by constant); the orchestrator runs the work-landed git query for bugfix in search mode even when the feature backlog is open (its deferral keys on the verdict alone); and the four orchestrator e2e tests that used bugfix as a never-deferred heartbeat seed one open bug in BUGS.md so their premise keeps holding.

### A deterministic unused-export check in the suite (planned 2026-09-29, done 2026-09-29)

**Goal.** 28 of clean's 67 commits from 2026-09-22 to 09-29 un-exported a symbol that nothing outside its own file uses. Each costs a tick, a gate check, and a landing slot, for about 4 changed lines ([docs/commit-history-analysis.md](docs/commit-history-analysis.md)). tsconfig's `noUnusedLocals` does not cover exports. A test that fails on such an export catches it in the *author's* gate check, before it lands, and clean never needs a tick for it. PRINCIPLES.md allows no runtime dependencies (the TypeScript toolchain is the only dev-time exception), so the check is in-house.

**Approach.**
- New test/exports.test.ts: walk `src/**/*.ts`, collect top-level `export function|const|let|class|interface|type|enum <Name>` declarations, and fail when a name appears as a whole word in no *other* file under src/, test/, or scripts/. Tests count as users: exported-for-test is legitimate. Name each offender as `src/file.ts: Name` in the assertion message, with the fix ("drop `export`, or use it elsewhere"). A short, commented allowlist covers genuine entry points (e.g. the CLI's exported `main`, if any).
- The tree has **zero** violations on main `53745873` (checked by the same scan), so the test lands green and acts as a regression guard.
- src/roles.ts `clean`: add one line saying internal-only exports are caught by test/exports.test.ts, so do not spend a tick on them. Update the clean prompt pin if one exists.

**Files touched:** test/exports.test.ts (new), src/roles.ts, test/prompt.test.ts (if clean's text is pinned).

**Acceptance criteria.** Adding `export` to a file-local helper makes `npm run test` fail with that file and name. The current tree passes. The scan ignores `export` inside comments and template strings (at minimum, a line comment `// export const x` is not a declaration). The clean prompt names the check. `npm run test` passes.

### Cancel a queued prompt from the dashboard — the GUI's queued-prompts rows get a per-row cancel control, backed by a file-addressed `/api/prompt-cancel` (planned 2026-09-29, done 2026-09-29)

**Goal.** The dashboard's "queued prompts" section lists what will run next — the director's previews from `statusPayload`'s `inboxPrompts`, plus per-role `"r: N queued"` count lines — but every row is plain text with no affordance (src/ui/gui-client.ts, the `backlogList("queued prompts", …)` block; the comment even says "queued prompts stay plain — they have no body"). The CLI already has `tumwater prompt --cancel <n>` (src/ui/operator-commands.ts `cmdPrompt`, position-addressed over src/inbox.ts `cancelRolePrompt`), but an operator steering from the GUI must switch terminals to retract a prompt they just regretted. This plan gives every queued-prompt row in the dashboard a cancel link that removes exactly that prompt — addressed by its queue file, not by list position, so a 1 s-stale poll can never cancel the wrong entry — reusing the shared cancel core and the `prompt_cancelled` event shape.

**Approach.**

1. **File-addressed cancel core (src/inbox.ts).** New `cancelQueuedFile(root, role, name)`: resolve `roleInboxDir(root, role)` + `name`, rejecting any `name` that is not a plain basename (contains `/` or `\`, or equals `..`) — a traversal guard, since the name arrives over HTTP; then `takeQueuedFile(file)`, the race-safe read-and-remove the position-based `cancelRolePrompt` already shares with `dequeueRolePrompt`; then log one `prompt_cancelled` event under that loop with `promptPreview(text)` (exactly `cancelRolePrompt`'s event, logged only after successful removal) and return the same `CancelOutcome` (`"cancelled" | "gone"`). A vanished file reads as `"gone"` — a concurrent dequeue is a normal race, not an error.
2. **Addressable payload (src/ui/status.ts, src/ui/status-payload.ts).** Keep `inboxPrompts: string[]` untouched — the TUI consumes it (src/ui/tui.ts) and stays read-only. Add, from the same inbox pass: `inboxFiles: string[]` (the director queue's file basenames, same order as `inboxPrompts` — `snapshot()` already gets the directory listing; expose the names beside the previews) and `roleInboxPrompts: Record<string, { file: string; preview: string }[]>` for each non-director role with queued prompts, filled from `queuedRolePrompts` (the stat-keyed `promptCache` keeps an unchanged file at one stat per poll, so the common empty case costs nothing). The payload passes both through unchanged.
3. **Endpoint (src/ui/gui-endpoints.ts, routed in src/ui/gui.ts beside `handlePrompt`).** `handlePromptCancel`: POST `/api/prompt-cancel`, body `{"role": "feature", "file": "<stamp>-<seq>-<pid>.md"}` with `role` optional (defaults to the director). Discipline mirrors the sibling handlers: `readJsonObject` → 400 malformed / 413 oversized; a given role through the shared `rejectBadRole` → 400; a file name failing the basename guard → 400 (user-input error, nothing touched on disk); success → 200 `{ ok: true, status: "cancelled" | "gone", preview? }` — `"gone"` is data, like the CLI's "no longer queued" line, never a 500.
4. **Dashboard (src/ui/gui-client.ts).** The queued-prompts section renders each row (director and per-role, replacing the `"r: N queued"` count hack with actual per-prompt rows) as `preview <a href='#' class='rowaction' data-action='promptcancel' data-file='…' data-role='…'>cancel</a>`, wired through the existing delegated `a.rowaction` listener; the click POSTs and flashes the server message in the header ("cancelled: <preview>" / "no longer queued — <role> already took it"), and the next 1 s poll re-renders the section. `test/gui.test.ts`'s page-shape assertion on the `backlogList("queued prompts", …)` concat is updated to the new render.

**Files touched.** `src/inbox.ts`, `src/ui/status.ts`, `src/ui/status-payload.ts`, `src/ui/gui-endpoints.ts`, `src/ui/gui.ts`, `src/ui/gui-client.ts`; tests `test/status.test.ts`, `test/gui.test.ts`, `test/gui-server.test.ts`. No changes to the CLI (`cmdPrompt` stays position-based) or the TUI. Beyond the list above: `test/status-fixtures.ts` gained the two new required `StatusSnapshot` fields (`inboxFiles`, `roleInboxPrompts`) in its empty-queue fixture — the snapshot type grew, so every render test's fixture had to carry them; and `inbox.ts` factors the per-loop read pass into one `queuedRoleFileTexts` helper serving both `queuedRolePrompts` and the new `queuedRolePromptEntries`, so the previews and their file addresses come from a single pass and cannot drift apart.

**Acceptance criteria.**

- Every queued-prompt row in the dashboard's "queued prompts" section — director queue and per-role queues alike — carries a cancel link; clicking it removes that exact prompt's queue file, logs one `prompt_cancelled` event under that loop, and the row disappears on the next poll.
- Cancelling a prompt the loop already dequeued answers `"gone"` (HTTP 200) and removes nothing else — a prompt enqueued after the operator's poll snapshot is never the one cancelled.
- A `file` value with a path separator, `..`, or a non-`.md` name is rejected 400 with the queue's files untouched; an unknown `role` is rejected 400 with the shared `rejectBadRole` wording.
- `snapshot()`'s `inboxPrompts` stays `string[]` (TUI unchanged); `tumwater prompt --list/--cancel` behave exactly as before; `npm run test` passes.

### `tumwater doctor --json` — the pre-flight report as machine-readable data, finishing the scriptable-surface series (planned 2026-09-28, refined 2026-09-28, done 2026-09-29)

**Goal.** doctor already "exits 0/1 so it can be scripted" (src/doctor.ts module comment), and its own doc comment calls it "the pre-flight sibling of `status --json`" — but a script that passes/fails on the verdict can only learn *which* check failed and *why* by parsing the aligned prose lines, which change shape whenever `renderDoctor` evolves. `status --json`, `report --json`, `logs --json`, `history --json`, and `backlog --json` have all landed (Done entries 2026-09-28); `doctor` is the last scriptable surface still prose-only. This plan gives it the same `--json` flag; the payload is the `DoctorReport` object itself — the collector's own payload, not a re-parse of the render (the `report --json` precedent).

**Approach.**

- src/doctor-checks.ts: no change — `DoctorReport` (`{ header: string; checks: Array<{ name: string } & { level: "ok" | "warn" | "fail"; detail: string }>; verdict: string }`) is already pure JSON (strings and lowercase keys only, no Dates or functions), so the flag serializes it verbatim.
- src/doctor.ts: no change — `runDoctor` (lines 410-443) already returns the full `DoctorReport`; the CLI is the only place that folds it into prose.
- src/cli.ts, the `doctor` case (lines 132-140): change `rejectUnknownArgs("doctor", args, [])` to `rejectUnknownArgs("doctor", args, [{ names: ["--json"] }])` (the `status`/`report`/`history` cases' pattern), then `say(args.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctor(report))`. The `if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1;` line runs unchanged in both forms — warnings still never fail the exit.
- src/ui/doctor-report.ts: no change — plain `tumwater doctor` output stays byte-identical and its tests hold untouched.
- src/help.ts, the `doctor` stanza (line 35): `  tumwater doctor` becomes `  tumwater doctor [--json]` re-padded so the description stays at column 36 (1-indexed) exactly like every other usage line — the `tumwater status [--json]` usage line (line 24) is a 26-char command field plus 9 spaces, and `  tumwater doctor [--json]` is the same 26 chars, so the new line has exactly 9 spaces after `doctor [--json]` (the current line is a 17-char field plus 18 spaces), and a trailing phrase in the sibling wording style, e.g. `… (read-only; exit 0/1; --json prints the report object — header, the checks array with level, name, and detail, and verdict)`. `helpTopic`/`helpStanzas` derive from this text; the existing test/help.test.ts only asserts the topic starts at `^  tumwater doctor`, which still holds — but add one alignment pin there so the column is verified rather than trusted: `assert.match(HELP, /^  tumwater doctor \[--json\] {9}Pre-flight/m)` (`HELP` is already imported in that file; it is a new one-line test, e.g. beside the `HELP still lists the per-command help form itself` test).
- README.md, the Audit row (line 43): extend the `tumwater doctor` mention the way the same row already treats `report --json`, e.g. `tumwater doctor` (pre-flight; `--json` prints the report as JSON, for scripts).
- Tests in test/doctor.test.ts (the CLI section, lines ~974-1048, which already drives doctor through the real `cli()`/`cliWithEnv()` entry points):
  - `doctor --json` output parses with `JSON.parse`; the document carries `header` (string), `checks` (array of `{name, level, detail}`), and `verdict` (string); the `(name, level, detail)` tuples equal, in order, the check lines the plain `doctor` render prints for the same fixtures — so the two forms cannot drift.
  - A failing environment (reuse the broken-repo fixture style of the existing fail tests) with `--json` still exits 1 and its `checks` carry `level: "fail"`; a healthy fixture exits 0.
  - The existing `doctor rejects unknown arguments` test (line 1040, `--verbose`) keeps passing: `--verbose` is still an unknown flag beside the new `--json`.

**Files touched:** src/cli.ts, src/help.ts, README.md, test/doctor.test.ts, test/help.test.ts. (src/doctor.ts, src/doctor-checks.ts, src/ui/doctor-report.ts are deliberately untouched.)

**Acceptance criteria.**

- `tumwater doctor --json` prints one JSON document parseable by `JSON.parse` with keys `header`, `checks`, `verdict`; `checks` lists every check in `runDoctor`'s fixed order with `level` one of `ok`/`warn`/`fail` and `detail` text identical to the plain render's lines.
- Exit-code semantics are unchanged in both forms: 1 when any check is `fail`, 0 otherwise; warnings never fail the exit. The flag never emits prose — a JSON document in every exit-0 case.
- Plain `tumwater doctor` output is byte-identical to before (renderDoctor tests untouched); `doctor --verbose` is still rejected; `tumwater help doctor` names `--json`; the doctor usage line's description starts at the same column 36 as the `status [--json]` line (pinned in test/help.test.ts); `npm run test` passes.

**Implemented 2026-09-29 by feature, as planned, with one correction:** accepting `--json`
means `rejectUnknownArgs` no longer has an empty spec list, so `doctor --verbose` is rejected
as `unknown argument: --verbose (valid flags for tumwater doctor: --json)` — the same message
`status --verbose` produces — rather than `takes no arguments`. The test was updated to match
this shared-rejector contract; the entry above was corrected in place. Everything else landed
as written: CLI flag, help stanza re-padded to the same column as `status [--json]`, README
audit row, and two new CLI-level tests (payload-vs-render equality, failing-env exit code).

### `tumwater backlog --json` — the project backlog as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28)

**Goal.** `status --json`, `report --json`, `logs --json`, and `history --json` all exist so
scripts can read fleet state, spend, events, and per-tick results without screen-scraping — but
`backlog`, the fifth observability surface (the planned features, open bugs, and open questions
a loop is about to work from), still prints Markdown only, and its CLI test explicitly pins
`--json` as an unknown flag (test/backlog-report.test.ts asserts `backlog --json` fails with
`takes no arguments`). A script that wants to watch the backlog — e.g. "wake the feature loop
when a plan is unclaimed again" or feed the open entries to another agent — has no
machine-readable answer.
This plan gives `tumwater backlog` the same `--json` flag; the payload is exactly the three entry
arrays the Markdown renderer and the GUI's on-demand `/api/backlog` endpoint serve, so all
surfaces stay in sync by construction (siblings: the `logs --json`, `history --json`, and
`report --json` Done entries, all 2026-09-28).

**Approach.**

- src/backlog.ts (172 lines): add one exported function `backlogPayload(root): { plans: BacklogEntry[]; bugs: BacklogEntry[]; questions: BacklogEntry[] }` that calls the existing `plannedPlanEntries`, `openBugEntries`, and `openQuestionEntries` readers (lines 160-172) and returns their results in file order — entries keep `{title, body}` verbatim, and a missing/unreadable file degrades to `[]` exactly like today's readers, so the flag prints the pretty-printed all-empty object in a bare directory, never an error. Key names match the GUI endpoint's `file=` vocabulary (`plans`/`bugs`/`questions`).
- src/cli.ts, the `backlog` case (lines 163-169): change `rejectUnknownArgs("backlog", args, [])` to `rejectUnknownArgs("backlog", args, [{ names: ["--json"] }])` (the `status`/`history` cases' pattern), then branch on `args.includes("--json")`: print `JSON.stringify(backlogPayload(root), null, 2)` via `say` and skip the Markdown render. The command keeps its no-`requireReadyRepo` gate in both forms.
- src/ui/backlog-report.ts: no change — `renderBacklogMarkdown` keeps calling the three readers directly, so the plain form's output is byte-identical and its tests hold untouched.
- src/help.ts, the `backlog` stanza (line 54): `tumwater backlog` becomes `tumwater backlog [--json]` with the description re-aligned to the shared description column (drop 8 spaces from the gap to keep `One-shot status table`-style column alignment with the `status [--json]` line above) and a trailing phrase in the sibling wording style, e.g. `--json prints machine-readable backlog data — the three entry arrays as {title, body}, the same data the Markdown view renders`. `helpStanzas`/`helpTopic` derive the topic from this text, so no other help machinery changes.
- README.md, the usage-table row (line 40): extend the `tumwater backlog` mention from `(planned features, open bugs, open questions as Markdown)` to also name `--json` (the machine-readable form), matching how the same row already describes `logs --json`.
- Tests:
  - test/backlog-report.test.ts: the existing `tumwater backlog` test asserts `backlog --json` fails with `takes no arguments` — update that assertion to the new behavior and add: `--json` output parses with `JSON.parse`; its `plans`/`bugs`/`questions` arrays carry the fixtures' verbatim titles and bodies (matching what the Markdown render of the same fixtures shows, so the two forms cannot drift); `Done`/`Fixed`/`Answered` entries never leak in; a bare `tmpdir()` root prints the all-empty object and exits 0; an unknown extra flag beside `--json` still fails `rejectUnknownArgs`.
  - test/backlog-report.test.ts, the `tumwater help` test (the `tumwater backlog {17}Show planned features` regex): update the spacing to the new stanza.
  - Every other backlog test (renderer, GUI `/api/backlog`, TUI browse) passes unchanged.

**Files touched:** src/backlog.ts, src/cli.ts, src/help.ts, README.md, test/backlog-report.test.ts.

**Acceptance criteria.**

- `tumwater backlog --json` prints one JSON document parseable by `JSON.parse` with keys `plans`, `bugs`, `questions`, each an array of `{title, body}` objects identical to what the plain `tumwater backlog` Markdown render lists (same order, same verbatim text) and to what the GUI's `/api/backlog` serves per entry.
- In a directory with no backlog files, `tumwater backlog --json` prints the pretty-printed all-empty object and exits 0 — a JSON document in every exit-0 case, never prose.
- Plain `tumwater backlog` output is byte-identical to before; `tumwater help backlog` names `--json`; `npm run test` passes.

### `tumwater logs --json` — the event feed as machine-readable NDJSON, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28)

**Goal.** `status --json`, `report --json`, `history --json` and `config` already emit
machine-readable data so scripts can watch fleet state, spend and history without screen-scraping
— but the most granular observability surface, the event feed (`tumwater logs`), still only
prints human-rendered lines. A monitoring script that wants structured events (e.g. "alert me
when `land_failed` appears") must parse the formatted text, which changes shape whenever the
renderer evolves. `--json` closes the gap: the same events, one JSON object per line (NDJSON),
streamable both as a one-shot dump and live in follow mode.

**Approach.** Add a `--json` flag to `logs` that switches the event feed from `formatEvent`
rendering to `JSON.stringify(e)` per line — the raw `HarnessEvent` objects exactly as stored in
the event log (`src/events.ts`), so scripts read the canonical schema, not a paraphrase.
- **One-shot views:** the `-n` dump and the `--since` window print each event as one JSON line,
  in the same order the text view uses (log order for `-n` — the tail is chronological, not reversed — oldest-first for `--since`).
- **Filtering composes:** `--grep` filters before serialization (same `matchesGrep` rule), so
  `logs --json -n 200 --grep land_failed` returns only matching JSON lines.
- **Follow mode streams:** with `-f --json`, each event parsed from the tail prints its JSON
  line as it lands — a script can pipe the feed into `jq` continuously.
- **Exclusions stay exclusive:** `--role` (the pi transcript view) is human-oriented by nature
  and does NOT gain `--json`; `logs --role x --json` fails with a message naming both flags,
  consistent with the existing rival-shape rejections in `cmdLogs`.
- **Empty results stay silent in JSON mode:** the text-mode `no events matching "x"` /
  `no events in 1h` messages and the sparse-window note are skipped when `--json` is set —
  an empty output IS the machine-readable answer, and scripts shouldn't choke on prose.
- Keep the flag out of the `--role`/`--prompt`/`--since` rivalry checks except for the new
  `--role` exclusion; `--json` composes with everything else.

**Files touched.**
- `src/cli.ts`: add `{ names: ["--json"] }` to `logs`' `rejectUnknownArgs` list (line ~141).
- `src/ui/log-commands.ts`: `cmdLogs` reads `args.includes("--json")`; in the `-n` path, the
  `--since` path and the `followFile` callback, branch between `say(formatEvent(e))` and
  `say(JSON.stringify(e))`; gate the empty-result/sparse-note messages on `!json`; add the
  `--role + --json` rejection next to the existing `--grep`/`--since` rivalry fails.
- `src/help.ts`: update the `logs` usage line to `tumwater logs [-f] [-n N] [--since <duration>]
  [--grep <text>] [--json] [--role <id> [--prompt]]` with a note that `--json` prints the raw
  event objects as NDJSON.
- Tests: extend `test/cli-logs.test.ts` (basic `--json` dump parses as one JSON object per line
  with a `type` and numeric `ts`) and `test/cli-logs-filtering.test.ts` (`--grep` composes;
  `--role --json` fails; empty match prints nothing in JSON mode; `--since --json` is
  oldest-first NDJSON).

**Acceptance criteria.**
1. `tumwater logs -n 20 --json` prints exactly 20 lines, each a valid JSON object with `type`
   and numeric `ts`, matching the events in the log (verified in a fake-pi test).
2. `--json` composes with `-n`, `--grep`, `--since` and `-f`; the grep filter applies before
   serialization and follow streams JSON lines as events land.
3. `logs --role <id> --json` fails with a message naming both flags.
4. In JSON mode, empty results print nothing (no prose lines), and the sparse-window note is
   suppressed.
5. Text mode (without `--json`) renders exactly as today — no regression in the existing
   `cli-logs*` tests.
6. `npm run test` passes with the new assertions added.

**Landed 2026-09-28.** Implemented exactly as planned in `src/cli.ts` (the `--json` flag in
`logs`' `rejectUnknownArgs` list), `src/ui/log-commands.ts` (serialization in the `-n`, `--since`
and follow paths; `--role`/`--prompt` rejection; prose suppression in JSON mode), `src/help.ts`,
and README.md's check-state row. Tests in `test/cli-logs.test.ts` (dump order and follow streaming)
and `test/cli-logs-filtering.test.ts` (grep composition, empty-window silence, `--since` order, role
rejection, help). One correction: the plan's parenthetical claimed `-n` prints newest-first, but the
text view's `-n` has always printed its tail in log order — `--json` matches the text view, as the
criterion "same order the text view uses" intends, so the parenthetical above is fixed in place.


### `tumwater history --json` — the per-tick history as machine-readable data, completing the `--json` pattern (planned 2026-09-28, done 2026-09-28)

**Goal.** `status --json` and `report --json` exist (both landed 2026-09-28) so scripts can watch
fleet state and spend without a GUI server or screen-scraping — but the third observability
surface, per-tick history, still prints only an aligned table. A script that wants "which loops
errored in the last hour and what did each tick cost" has no machine-readable answer. This plan
gives `tumwater history` the same `--json` output shape; the payload doubles as the GUI's
`/api/history` response, so CLI and dashboard serve byte-identical data by construction.

**Approach.** The collector is already shared and pure — `readTickRows`/`tickRows` in
src/ui/history.ts (lines 44-103) feed both `cmdHistory`'s table and the GUI's
`handleHistory` (src/ui/gui-endpoints.ts:157-175, which sends `{ rows }` verbatim). The rows
almost are the JSON payload; three fields are lost to rendering and must be kept raw:

- src/ui/history.ts, `TickRow` (lines 38-46): add `ts: number` (the `tick_end` event's epoch ms —
  `time` is `formatTimestamp`'s human string and discards the instant), `tokens: number`, and
  `costUsd: number` (the raw values `tickRows` already computes at lines 56-57 before folding them
  into the rendered `usage` string; 0 when the event carries none, matching the omit-when-zero
  convention). The rendered `usage`/`time`/`detail` fields stay exactly as they are — the table
  keeps its shape and every existing test holds.
- src/cli.ts, the `history` case (lines 153-160): add `{ names: ["--json"] }` to
  `rejectUnknownArgs`'s vocabulary (the `status`/`report` cases' pattern).
- src/ui/history.ts, `cmdHistory` (lines 118-156): when `args.includes("--json")`, print
  `JSON.stringify({ rows }, null, 2)` and return before the table rendering — the `readTickRows`
  call, `-n` bounds check, and `--role` handling run exactly as before. The empty-log case prints
  `{"rows":[]}` (a JSON document always, never the prose `no ticks yet` — the `report --json`
  precedent: the flag's output must be parseable in every exit-0 case).
- src/help.ts, the `tumwater history` stanza (line 46): add `[--json]` with a phrase in the
  `status [--json]` stanza's wording style.
- The GUI needs no change: `handleHistory` sends `readTickRows`' rows verbatim, so it gains the
  three fields additively; the dashboard's history tab reads the fields it knows and ignores the
  rest.
- Tests in test/cli-history.test.ts (268 lines, already drives both `tickRows` and the CLI):
  `--json` output parses with `JSON.parse` and its rows carry the same loop/tick/result/detail as
  the table render of the same fixtures; `ts` equals the fixture's `tick_end` timestamp and
  `tokens`/`costUsd` equal the raw numbers (0 where the event carries none); empty log prints
  `{"rows":[]}` and exits 0; `--json` combines with `--role` and `-n` (bounds and role scope
  identical to the table path); an unknown extra flag beside `--json` still fails
  `rejectUnknownArgs`; every existing table-render test passes unchanged.

**Files touched:** src/ui/history.ts, src/cli.ts, src/help.ts, test/cli-history.test.ts.

**Acceptance criteria.**
- `tumwater history --json` prints one JSON document parseable by `JSON.parse` whose `rows` match
  `readTickRows(root, HISTORY_DEFAULT_TICKS, null)` for the same log, each row carrying `ts`,
  `tokens`, and `costUsd` as numbers alongside the existing rendered fields.
- `tumwater history --json --role <id> -n 5` returns exactly the same rows the plain form's table
  shows for those flags (one row per tick, newest first, window growth included).
- A log with no ticks prints `{"rows":[]}` and exits 0; `--json` never emits the prose
  `no ticks yet`.
- Plain `tumwater history` output is byte-identical to before (table tests unchanged);
  `tumwater help history` names `--json`; `npm run test` passes.

### `tumwater report --json` — the usage report as machine-readable data, beside `status --json` (planned 2026-09-28, done 2026-09-28)

**Goal.** Scripts and cron jobs can watch fleet spend and throughput (`report --days` series,
`report --since` totals) today only by parsing Markdown. `status --json` already established the
pattern — the exact payload the renderers consume, printed with `JSON.stringify(..., null, 2)`
(src/cli.ts, the `status` case). This plan gives `report` the same output shape so an operator can
track cost/outcomes programmatically without a running GUI server or screen-scraping.

**Approach.** The collectors already return the exact structures (`ReportData`/`ReportDay` in
src/report-data.ts:55-85, `SinceReport` in src/report-data.ts:87-110 — including
`coversFullWindow`, which a script needs to distinguish a sparse window from a truncated one);
the Markdown renderers in src/ui/report.ts are pure functions of them. So `--json` only swaps the
renderer for `JSON.stringify` of the collector's return value:

- src/cli.ts, the `report` case (~line 121): add `{ names: ["--json"] }` to `rejectUnknownArgs`'s
  vocabulary.
- src/ui/report.ts, `cmdReport` (lines 120-152): in both the `--since` branch and the `--days`
  branch, when `args.includes("--json")`, `say(JSON.stringify(<collector result>, null, 2))`
  instead of the Markdown render — collectors run exactly as before, bounds and cap checks
  untouched.
- `--failures --json` fails fast with `fail(...)` in the established combined-flag message style
  (cf. the `--since`/`--failures` mutual exclusions at lines 125-128): the failure digest is a
  clustered narrative with no agreed JSON shape, and inventing one is a separate plan if ever
  wanted — the error says so. `--since --days --json` keeps failing with the existing message.
- src/help.ts: extend the two `tumwater report` stanzas with `--json` ("machine-readable
  usage data — the collector's own payload, not the Markdown render") in the same wording style
  as the `status [--json]` stanza.
- Tests in test/report.test.ts (which already drives `cmdReport` through collectors and
  renders): `--json --days N` parses as JSON, round-trips `days`/`from`/`to`, and its `series`
  totals match the Markdown render of the same fixtures; `--json --since` parses and carries
  `coversFullWindow` and the totals; `--failures --json` fails with the message naming the
  exclusion. test/failure-report.test.ts:593 pins `--failure` (typo) as unknown — it must keep
  passing unchanged.

**Files touched:** src/cli.ts, src/ui/report.ts, src/help.ts, test/report.test.ts.

**Acceptance criteria.**
- `tumwater report --json --days 3` prints one JSON document parseable by `JSON.parse`, equal in
  content to `collectReport(root, 3)` for the same log fixtures.
- `tumwater report --json --since 2h` prints `collectReportSince`'s output verbatim, including
  `coversFullWindow` and the per-role maps.
- `tumwater report --json --failures` exits non-zero with the combined-flag message; plain
  `--days`/`--since`/`--failures` Markdown output is byte-identical to before.
- `tumwater help report` names `--json`; `npm run test` passes.

### GUI history tab — the dashboard shows the per-tick history `tumwater history` prints (planned 2026-09-28, done 2026-09-28)

**Goal.** The browser dashboard renders fleet state, transcripts, backlog, the event feed, the
usage report, and the failure digest — but not the per-tick history an operator reaches for
first after anything goes wrong: which loop ran, when, what it produced, what it cost, and
whether it passed. Today that answer exists only in a terminal (`tumwater history`). The data
and the collector both already exist — every row is derived from `tick_end` events by the pure
`tickRows(events, limit, role)` in src/ui/history.ts, written for exactly this kind of sharing
("the CLI and the tests share this collector") — so this is one GET endpoint plus one client
tab, no new state and no new collection logic.

**Approach.** Serve the collector's rows over a new read-only GET endpoint and render them as
a fourth dashboard view, following the /api/report + report-tab pattern end to end.

1. **src/ui/gui-endpoints.ts** — new `handleHistory(q, res, root)` for
   `GET /api/history?role=<id>&n=N`, placed beside handleReport (same comment style, same
   query-pre-parsed note). Rules fixed here so the implementer has no fork:
   - `n`: optional. Absent → `HISTORY_DEFAULT_TICKS` (20). Present → `parseNonNegativeInt`
     (returns null → 400 `n must be a non-negative integer (got …)`, the handleBacklog index
     discipline), then clamp to `[1, HISTORY_MAX_TICKS]` (200) like `windowDays` clamps days —
     the GUI clamps where the CLI fails fast, its established convention.
   - `role`: optional. Absent or empty string → all loops. Present → passed straight through
     as `tickRows`' role filter with no config validation (unlike /api/transcript's
     rejectBadRole): a filter is not a target, an id with no ticks legitimately yields zero
     rows, and validating would force the endpoint to read the config — /api/report and
     /api/failures read nothing but files, and history stays in that family.
   - Data: `tickRows(readEvents(root, n * 2 + 50), n, role)` — the identical window
     arithmetic `cmdHistory` uses (tick_start lines and unrelated events interleave with the
     tick_end rows, so the scanned window is twice the ask plus slack). `readEvents` scans the
     log file directly with its own stat-keyed cache, so the endpoint works with no fleet
     running, like the report endpoints.
   - Response: `sendJson(res, 200, { rows })` where rows are the `TickRow[]` as-is (time,
     loop, tick, result, durationMs nullable, usage string possibly empty, detail truncated
     client-side-visible at DETAIL_MAX=72 already by the collector). Errors: 400 JSON via
     sendJson for bad `n`; never 500 for a missing log (readEvents scans to []).
2. **src/ui/gui.ts** — one route line before the POST handlers:
   `} else if (req.method === "GET" && pathname === "/api/history") { handleHistory(target!.searchParams, res, root); }`,
   beside the other GET-data routes.
3. **src/ui/gui-page.ts** — the nav gains a fourth anchor
   (`<a href="#" id="tab-history">history</a>` after tab-failures) and the body a
   `<div id="history" hidden></div>` after #failures.
4. **src/ui/gui-client.ts** — `switchView` accepts "history": guard list, `#history` hidden
   toggle, `tab-history` active-class toggle, and `if (v === "history") fetchHistory();` on
   every activation (re-clicking refetches — same model as report/failures, no polling; history
   moves at tick granularity). Update the two `"fleet" | "report" | "failures"` comments to
   include history. The existing `viewnav` click listener needs no change (`a.id.slice(4)`
   already yields "history").
5. **src/ui/gui-client-history.ts** (new, beside gui-client-report.ts) — `fetchHistory()`:
   `getJson("/api/history")`, then render into #history a table with the CLI's seven columns
   (time, loop, tick as `#N`, result, duration — `durationMs === null` renders `—`, usage,
   detail), reusing the page's existing table styling; empty rows render the muted line
   `no ticks yet — click the tab again to refresh` (matching fetchFailures' muted header
   pattern). Server sends data, browser stays a thin viewer.
6. **test/gui-server.test.ts** — endpoint tests beside the existing /api/report and
   /api/backlog cases: seed an events.jsonl with interleaved tick_start/tick_end/unrelated
   events (the same pattern the history CLI tests use) and assert (a) rows match
   `tickRows`'s output — newest first, durations from tick_start pairs, `null` duration when
   the start is outside the window; (b) `role=<id>` filters to that loop and an id with no
   ticks returns `rows: []` with 200; (c) `n` clamps at 200 and a non-integer `n` returns
   400; (d) a missing event log returns `rows: []` with 200; (e) GET / returns HTML containing
   `tab-history` and `id="history"`.

**Files touched:** src/ui/gui-endpoints.ts, src/ui/gui.ts, src/ui/gui-page.ts,
src/ui/gui-client.ts, src/ui/gui-client-history.ts (new); tests in test/gui-server.test.ts.
No CLI, help, or README changes — the command set is untouched; the screenshot in docs/ is
refreshed by the docs loop whenever it next runs, not by this plan.

**Acceptance criteria.** (a) `GET /api/history` returns `{ rows }` identical to what
`tumwater history` derives for the same window (newest first, one row per completed tick),
with `role` filtering and `n` defaulting/clamping exactly as specified above. (b) The
dashboard gains a working history tab: click renders the rows as a table, re-click refetches,
an empty log shows the `no ticks yet` line, and the other tabs are unaffected. (c) All five
endpoint tests pass and the full suite passes. (d) No fleet needs to be running for the
tab or the endpoint to serve data.


**Done 2026-09-28 by feature.** Landed as specified: handleHistory beside handleReport
(same comment style, the handleBacklog 400 discipline for a non-count `n`, clamped to
[1, HISTORY_MAX_TICKS], the role filter passed through unvalidated), the /api/history
route before the POST handlers, the fourth nav anchor + #history container, switchView
wired to fetchHistory with re-click refetch, and gui-client-history.ts interpolated into
GUI_CLIENT_JS beside gui-client-report.ts. All five endpoint tests live in
test/gui-server.test.ts as planned; one file the plan did not name was touched:
test/gui-report.test.ts — its two page-markup regexes (the nav row and the hidden view
containers) named three tabs and had to widen to four.

### `logs --grep <text>` — show only the events whose type or rendered line matches (planned 2026-09-28, done 2026-09-28)

**Goal.** The event feed has count- and window-shaped tools (`-n`, the landed `--since`) but
no filter: an operator chasing `land_failed` or `review_rejected` lines must pipe `logs` through
an external grep, and `logs -f | grep` is a worse deal than it looks — the pipe dies when the
terminal's grep exits, while `logs -f` itself keeps following across log rotation (followFile
re-stats). Filtering belongs in the command that already owns reading and rendering the log.

**Approach.** One flag on the existing event view of `cmdLogs`, reusing its plumbing.

1. **src/ui/log-commands.ts** — in `cmdLogs`, before the `--role` branch: when `--grep` is
   present, `fail()` if it is combined with `--role` (`--prompt` already requires `--role`, so
   it is excluded too — the transcript view is pi's transcript, not the event log, and filtering
   rendered transcript entries is a different shape; the failure names both flags). Read the
   value directly (`args[args.indexOf("--grep") + 1]`), failing with
   `fail("logs --grep needs a pattern")` when it is missing — the same explicit-read shape the
   `--role` branch uses, since `--grep` is free-text, not an enum like `--role`. The match
   rule, fixed here so the implementer has no fork: case-insensitive substring against the
   haystack `` `${e.type} ${formatEvent(e)}` `` — the rendered line is what the operator would
   otherwise read (WYSIWYG), and prefixing the raw event type lets stable type ids
   (`review_rejected`, `land_failed`) be filtered even where the rendering paraphrases them.
   One local helper `matchesGrep(e, pattern)`. Apply it to both outputs: the initial
   `readEvents(root, limit)` window (note in the help text: `-n` is the number of events
   *scanned*, not printed — matches are the filtered subset, so `-n 200 --grep land_failed`
   may print 3 rows) and, when following, each event fed to the `followFile` callback, so the
   filter holds across rotation. When not following and the seeded window yields no matches,
   print `no events matching "<pattern>"` and exit 0 — the same gentle-empty convention the
   `--since` plan fixes for windows. Read-only, stdout only.
2. **src/cli.ts** — the `logs` case's `rejectUnknownArgs` list gains
   `{ names: ["--grep"], value: true, valueName: "<text>" }`.
3. **src/help.ts** — the logs stanza's event-view usage line becomes
   `tumwater logs [-f] [-n N] [--grep <text>]`, and its description notes that `-n` bounds the
   scan and matching is case-insensitive over the event type and rendered line (the
   per-command view derives from the full text, so one edit covers `tumwater help logs`).
4. **README.md** — extend the "Check state" table row with `tumwater logs --grep <text>`.

**Files touched:** src/ui/log-commands.ts, src/cli.ts, src/help.ts, README.md; tests in
test/cli-logs.test.ts (seed an events.jsonl directly, the pattern the file already uses: a
mixed log of several event types, then exercise the CLI — type-id matching, rendered-text
matching, case-insensitivity, the `--role` exclusion failure, the missing-value failure, the
empty-result line, and that `-n` bounds the scan window).

**Acceptance criteria.** (a) `tumwater logs --grep review_rejected` prints only events whose
type or rendered line contains the pattern, case-insensitively, oldest-first in the normal
line format, over the last `-n` (default 50) events scanned. (b) `--grep` with `--role` fails
naming both flags; a missing value fails with `logs --grep needs a pattern`. (c) With `-f`, the
filter applies to the seeded window and to every subsequently followed event. (d) No matches
and no `-f` prints `no events matching "<pattern>"` and exits 0. (e) `tumwater help logs`
shows the new flag and the scan-window note. (f) Full suite passes.

**Landed 2026-09-28 by feature.** Two deviations from the written approach, both
improvements: the `--grep` check sits at the top of `cmdLogs` (before the `--since` branch,
not just before the `--role` branch) and `--grep` also fails against `--since` naming both
flags — the `--since` branch returns before any later check could fire, so the plan's
placement would have silently dropped the filter instead of failing; and the help stanza's
usage line keeps `--since <duration>` while gaining `--grep <text>` (the plan's proposed line
dropped `--since`, which would have removed an existing flag from the help). Everything else
as written: `matchesGrep` over `` `${e.type} ${formatEvent(e)}` ``, the filter applied to
both the seeded window and the `followFile` callback, the empty-result line, and seven new
tests in test/cli-logs.test.ts. Suite 1925/1926 (1 skipped).

### `report --since <duration>` — totals over a trailing window, not whole days (planned 2026-09-28, done 2026-09-28)

**Goal.** `tumwater report` answers "how much has the fleet spent this week" but not "how much
since the 429 storm at 10:00": `--days` counts back whole local calendar days, so a sub-day
question rounds up to a full day and an operator reconstructing an incident's spend must count
`logs --since` lines by hand. The events already carry `ts` and `costUsd`, and
src/event-window.ts's `readWindowEvents` already reads a window with bounded backwards I/O, so
a trailing-window totals view is a small second consumer of the same plumbing — the sibling of
the landed `logs --since` (under `## Done` below; raw stream, aggregate here).

**Approach.**

1. **src/event-window.ts** — one constant beside `REPORT_MAX_DAYS`: `REPORT_SINCE_MAX_MS =
   7 × 24 × 60 × 60 × 1000`. Same rationale as the day bound: a longer window only re-reads
   more log without adding signal, and the log rotates at 16 MB anyway.
2. **src/report-data.ts** — a `SinceReport` interface (`sinceMs`, `fromIso` ISO string of the
   cutoff, `totals` {tokensOut, ticks, commits, costUsd}, `ticksByRole` and `costByRole`
   Records, `coversFullWindow`) and `collectReportSince(root, ms)`: capture one `cutoff =
   Date.now() - ms` instant; `fromKey = formatDate(new Date(cutoff))` (datetime.ts's
   `formatDate`, the same helper `eventDayKey` uses, so window key and event keys cannot
   disagree); `readWindowEvents(root, fromKey)`, filter to `typeof ev.ts === "number" &&
   ev.ts >= cutoff` (the day-keyed read may include earlier hours of the cutoff's own local
   day — over-read is at most one day's events); aggregate tick_end/merged exactly as
   `collectReport`'s loop does (same `typeof`-guarded tokens/cost handling, `eventRole` for
   the per-role maps). Backlog tallies (features done / bugs fixed) are **omitted**: they are
   counted from PLANS.md/BUGS.md `done`/`fixed` dates, which are day-granular file metadata
   that cannot subdivide a sub-day window — the render says so rather than showing a
   day-rounded number. Keep it a separate function, not a `collectReport` variant flag: the
   day collector's zero-filled series and file reads have no place in a window totals view.
3. **src/ui/report.ts** — `renderSinceReportMarkdown(data: SinceReport): string`, same voice
   as `renderReportMarkdown`:
   `# tumwater usage report`, blank line, `window: last <durationLabel(ms)> (since <local
   time of the cutoff, toLocaleString>)`, blank line, the same **Totals:** phrase minus the
   features/bugs cells, then `**Ticks by role:**` and `**Cost by role:**` lines built with
   the same rank-by-total-desc-then-name rule and zero-value omission as
   `renderReportMarkdown`'s (a zero-event window renders `-` for both role lines). When
   `coversFullWindow` is false, append a note line (`note: older events rotated out of the
   log`) so a sparse window is never mistaken for an idle fleet; when true, a final line
   `backlog tallies (features done / bugs fixed) need the day report (--days)` states the
   omission once, unconditionally. Pure function of the data — no clock reads.
4. **src/cli.ts** — the `report` case's `rejectUnknownArgs` list gains
   `{ names: ["--since"], value: true, valueName: "<duration>" }`. Before the existing flag
   reads: when `--since` is present, `fail()` if combined with `--days` or `--failures`
   (rival shapes: a series over whole days vs totals over a trailing window, and the failure
   digest has no windowed-since mode — each failure names both flags). Parse with the
   existing `parseDurationFlag("--since", …)` (src/cli-args.ts; `45s`/`90m`/`2h`/`1d`) and
   fail when it exceeds `REPORT_SINCE_MAX_MS`, naming the bound. Then write
   `renderSinceReportMarkdown(collectReportSince(root, ms))`.
5. **src/help.ts** — a third report usage line after the `--failures` one:
   `tumwater report --since <duration>` with a description naming the totals shape, the 7-day
   bound, and the `--days`/`--failures` exclusion (the per-command view derives from the
   full text, so one edit covers `tumwater help report`).
6. **README.md** — extend the "Audit" table's `tumwater report` row with
   `tumwater report --since <duration>`.

**Files touched:** src/event-window.ts, src/report-data.ts, src/ui/report.ts, src/cli.ts,
src/help.ts, README.md; tests in test/report.test.ts (seed events.jsonl directly with events
minutes and days old, the pattern the file already uses, then call `collectReportSince` and
`renderSinceReportMarkdown` — cutoff filtering across the day boundary, tick/commit/role
taggregation parity with a same-seed `collectReport` slice, the rotation note, the role-rank
order, and the zero window) and test/cli-report.test.ts if one exists for flag wiring, else
the same CLI-exercise pattern test/cli-logs.test.ts uses (mutual-exclusion failures, the
over-bound failure, and the rendered output).

**Acceptance criteria.** (a) `tumwater report --since 6h` prints a totals block covering only
events from the last 6 hours, with Ticks by role / Cost by role lines. (b) `--since` with
`--days` or `--failures` fails naming both flags; a duration over 7 days fails naming the
bound; a missing or malformed value fails with `parseDurationFlag`'s message. (c) A window
with no events prints zero totals and `-` role lines, exiting 0; a window whose start predates
the retained log carries the rotation note. (d) `tumwater help report` shows the new usage
line. (e) Full suite passes.

Sibling: the landed `logs --since` (under `## Done` below) composes for drill-down — the
totals flag answers "how much", the logs flag answers "what exactly"; neither depends on the
other.

**Refinement (2026-09-28, implementation notes).** Landed with three deltas from the approach
above, each closing a review objection on the first landing: (1) coverage is proven the same
three ways as the sibling `logs --since` — the day-key proof (`coversFullWindow`), the same-day
timestamp proof (the log's oldest retained event predating the cutoff instant), and an
empty-log clause (an empty or missing log has nothing that could have rotated away), so a
fresh directory's report never claims rotated events; (2) the render's rotation note uses the
sibling's hedged phrasing ("the log's oldest retained event lies inside this window; older
events may have rotated out") because a flat "rotated out" claim can be false for a log born
inside the window; (3) `collectReportSince` drops future-dated events (`ts > now`) exactly as
`collectReport`'s day-map guard does, so the collector's comment describes what the code does.
`SinceReport` keeps the planned shape (sinceMs, fromIso, totals, ticksByRole, costByRole,
coversFullWindow); the renderer lives beside `renderReportMarkdown` in src/ui/report.ts and
the CLI/help/README wiring follows the plan as written.


### `logs --since <duration>` — show the events of a time window, not a guess at a count (planned 2026-09-28, done 2026-09-28)

**Goal.** An operator reconstructing "what happened in the hour around that 429 storm" has only
count-shaped tools: `logs -n N` dumps the last N events and the operator guesses N until the
window appears, while `tumwater report --days` aggregates whole days and the landed
`history` command (under `## Done` below) renders tick-shaped rows over `tick_end` only — neither
shows the raw interleaved event stream of a bounded time window. Every event already carries
`ts`, and src/event-window.ts's `readWindowEvents` already reads a window with bounded backwards
I/O (day-keyed), so a `--since` flag is thin rendering over existing plumbing, not a new reader.

**Refinement (2026-09-28, after review of the first landing).** The rotation note was proven
wrong in two common cases and has been rebuilt: (1) coverage is now proven two ways — the
reader's day-key proof (`coversFullWindow`) or, for the same-day case the day key cannot decide,
a timestamp proof (the file's own oldest retained event predating the cutoff; the log is
append-only and chronological, so everything after it is present) — so `logs --since 1h` over a
log whose oldest event is 90 minutes old no longer claims rotation; (2) the note only ever rides
rows — an empty window prints no note, so a fresh install (no log file at all) is never told
data "rotated away" that never existed; and (3) the note is hedged (`note: the log's oldest
retained event lies inside this window; older events may have rotated out`), staying true
whether the cause is rotation or a young log.

**Approach.**

1. **src/event-window.ts** — one constant beside `REPORT_MAX_DAYS`: `LOGS_SINCE_MAX_MS = 7 ×
   24 × 60 × 60 × 1000`. Same rationale as the report bound: a longer window only re-reads more
   log and renders more lines without adding signal, and the log rotates at 16 MB
   (`EVENTS_MAX_BYTES` in src/events.ts) anyway, so a huge window mostly reads rotated-away
   nothing. No change to `readWindowEvents` itself — it already returns exactly what this
   consumer needs (oldest-first events plus `coversFullWindow`).
2. **src/ui/log-commands.ts** — in `cmdLogs`, before the existing flag reads: when `--since` is
   present, `fail()` if it is combined with `-f`, `-n`, or `--role` (`--prompt` already requires
   `--role`, so it is excluded too — follow means "from now", a count and a window are rival
   shapes, and the `--role` view is a pi transcript, not the event log; each failure names both
   flags). Parse the value with the existing `parseDurationFlag("--since", …)`
   (src/cli-args.ts, added by the timed-pause plan — `45s`/`90m`/`2h`/`1d`), and fail when it
   exceeds `LOGS_SINCE_MAX_MS`, naming the bound. Then: `cutoff = Date.now() - ms`; read
   `readWindowEvents(root, formatDate(new Date(cutoff)))` (`formatDate` from src/datetime.ts,
   the same helper `eventDayKey` uses, so the window key and the event keys cannot disagree);
   filter to `typeof ev.ts === "number" && ev.ts >= cutoff` (the day-keyed read may include
   earlier hours of the cutoff's own local day — over-read is at most one day's events); print
   the survivors oldest-first through `formatEvent`, the same loop the `-n` path uses. Coverage
   of the window is proven two ways: `coversFullWindow` (a retained line older than the
   window's first day) or the timestamp proof above (when the read reached the file start
   without the day-key proof, `window.events[0]` is the file's oldest retained event). When
   coverage is unproven and the window has rows, append the hedged note line after them so a
   sparse window is never mistaken for a quiet fleet. An empty window prints
   `no events in <durationLabel(ms)>` and exits 0 with no note — `durationLabel` (beside the
   parser) phrases the window back the way the operator typed it. Read-only, stdout only.
3. **src/cli.ts** — the `logs` case's `rejectUnknownArgs` list gains
   `{ names: ["--since"], value: true, valueName: "<duration>" }`.
4. **src/help.ts** — the `logs` stanza's first usage line becomes
   `tumwater logs [-f] [-n N] [--since <duration>]` with a description line noting the cap
   (the per-command view derives from the full text; the `--role` line is unchanged since
   `--since` excludes it).
5. **README.md** — extend the "Check state" table row with `tumwater logs --since <duration>`.

**Files touched:** src/event-window.ts, src/ui/log-commands.ts, src/cli.ts, src/help.ts,
README.md; tests in test/cli-logs.test.ts (seed an events.jsonl with events minutes and days
old by writing the file directly, the pattern the file already uses, then exercise the CLI —
window filtering, the same-day timestamp proof, the mutual-exclusion failures, the empty
window without a note, the hedged note after rows, and the help text).

**Acceptance criteria.** (a) `tumwater logs --since 30m` prints only events from the last 30
minutes, oldest-first, in the same line format as plain `logs`. (b) `--since` with `-f`, `-n`,
or `--role` fails naming both flags; a duration over 7 days fails naming the bound; a missing
or malformed value fails with `parseDurationFlag`'s message. (c) An empty window prints
`no events in <duration>` and exits 0 with no rotation note (a fresh install included); a
window whose completeness cannot be proven prints the hedged rotation note after the rows; a
window whose oldest retained event predates the cutoff — same day or not — prints no note.
(d) `tumwater help logs` shows the new flag. (e) Full suite passes.

Sibling: `logs --grep` (next entry) composes with this one — when both flags stand, the window
is read first and the pattern filters its events; this entry's mutual-exclusion list is
unchanged.

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
