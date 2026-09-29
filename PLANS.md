# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### `tumwater doctor --json` — the pre-flight report as machine-readable data, finishing the scriptable-surface series (planned 2026-09-28)

**Goal.** doctor already "exits 0/1 so it can be scripted" (src/doctor.ts module comment), and its own doc comment calls it "the pre-flight sibling of `status --json`" — but a script that passes/fails on the verdict can only learn *which* check failed and *why* by parsing the aligned prose lines, which change shape whenever `renderDoctor` evolves. `status --json`, `report --json`, `logs --json`, `history --json` have all landed (Done entries 2026-09-28) and `backlog --json` is planned below; `doctor` is the last scriptable surface still prose-only. This plan gives it the same `--json` flag; the payload is the `DoctorReport` object itself — the collector's own payload, not a re-parse of the render (the `report --json` precedent).

**Approach.**

- src/doctor-checks.ts: no change — `DoctorReport` (`{ header: string; checks: Array<{ name: string } & { level: "ok" | "warn" | "fail"; detail: string }>; verdict: string }`) is already pure JSON (strings and lowercase keys only, no Dates or functions), so the flag serializes it verbatim.
- src/doctor.ts: no change — `runDoctor` (lines 411-443) already returns the full `DoctorReport`; the CLI is the only place that folds it into prose.
- src/cli.ts, the `doctor` case (lines 132-140): change `rejectUnknownArgs("doctor", args, [])` to `rejectUnknownArgs("doctor", args, [{ names: ["--json"] }])` (the `status`/`report`/`history` cases' pattern), then `say(args.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctor(report))`. The `if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1;` line runs unchanged in both forms — warnings still never fail the exit.
- src/ui/doctor-report.ts: no change — plain `tumwater doctor` output stays byte-identical and its tests hold untouched.
- src/help.ts, the `doctor` stanza (line 35): `  tumwater doctor` becomes `  tumwater doctor [--json]` re-padded so the description column stays at column 35 exactly like the `tumwater status [--json]` line above it (2 leading spaces + 32-char command field, i.e. 10 spaces after `doctor [--json]` — the current 18), and a trailing phrase in the sibling wording style, e.g. `… (read-only; exit 0/1; --json prints the report object — header, the checks array with level, name, and detail, and verdict)`. `helpTopic`/`helpStanzas` derive from this text; test/help.test.ts only asserts the topic starts at `^  tumwater doctor`, which still holds — no test change there.
- README.md, the Audit row (line 43): extend the `tumwater doctor` mention the way the same row already treats `report --json`, e.g. `tumwater doctor` (pre-flight; `--json` prints the report as JSON, for scripts).
- Tests in test/doctor.test.ts (the CLI section, lines ~974-1048, which already drives doctor through the real `cli()`/`cliWithEnv()` entry points):
  - `doctor --json` output parses with `JSON.parse`; the document carries `header` (string), `checks` (array of `{name, level, detail}`), and `verdict` (string); the `(name, level, detail)` tuples equal, in order, the check lines the plain `doctor` render prints for the same fixtures — so the two forms cannot drift.
  - A failing environment (reuse the broken-repo fixture style of the existing fail tests) with `--json` still exits 1 and its `checks` carry `level: "fail"`; a healthy fixture exits 0.
  - The existing `doctor rejects unknown arguments` test (line 1040, `--verbose` → `takes no arguments`) keeps passing unchanged: `--verbose` is still an unknown flag beside the new `--json`.

**Files touched:** src/cli.ts, src/help.ts, README.md, test/doctor.test.ts. (src/doctor.ts, src/doctor-checks.ts, src/ui/doctor-report.ts are deliberately untouched.)

**Acceptance criteria.**

- `tumwater doctor --json` prints one JSON document parseable by `JSON.parse` with keys `header`, `checks`, `verdict`; `checks` lists every check in `runDoctor`'s fixed order with `level` one of `ok`/`warn`/`fail` and `detail` text identical to the plain render's lines.
- Exit-code semantics are unchanged in both forms: 1 when any check is `fail`, 0 otherwise; warnings never fail the exit. The flag never emits prose — a JSON document in every exit-0 case.
- Plain `tumwater doctor` output is byte-identical to before (renderDoctor tests untouched); `doctor --verbose` is still rejected with `takes no arguments`; `tumwater help doctor` names `--json`; `npm run test` passes.

### `tumwater backlog --json` — the project backlog as machine-readable data, completing the `--json` pattern (planned 2026-09-28)

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

## Done

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

### Pause countdown — show when a timed pause auto-resumes (`status`/TUI header badge, GUI pause badge) (planned 2026-09-25, refined 2026-09-28, done 2026-09-28)

**Depends on** the "Timed pause" entry — now under `## Done`, landed 2026-09-28: `pause --for`
exists and `pausedUntil` is on the snapshot (src/ui/status.ts) and the payload
(src/ui/status-payload.ts), so the dependency is satisfied and this lands against the current
build.

**Goal.** The Timed pause plan deliberately leaves the display out: every surface shows a timed
pause as plain `paused`, indistinguishable from an indefinite one, so an operator cannot see at
a glance whether the fleet will come back on its own or needs a manual `resume`. Show the
countdown where the pause is already visible.

**Approach.**

1. **src/ui/status-model.ts** — `pauseBadge(pausedUntil: number | undefined, now: number): string`,
   shaped like the neighboring `budgetBadge`/`landingBadge`: empty when `pausedUntil` is absent
   or in the past (the parent plan's read side already treats an expired marker as unpaused, so
   the badge never lies); otherwise ` · paused — auto-resumes in <humanSeconds(until - now)>`,
   reusing the exported `humanSeconds` so one helper owns duration phrasing. The badge is
   fleet-scoped: the snapshot's `pausedUntil` is the fleet marker's deadline (see the parent
   plan's item 5), so the header badge stands exactly when the fleet itself is timed-paused —
   a role-only timed pause leaves the header unchanged (its loop row already reads `paused`),
   and no badge can ever claim the fleet will auto-resume while an indefinite fleet pause
   stands beside a timed one.
2. **src/ui/status-render.ts** — append `${pauseBadge(snap.pausedUntil, now)}` to the header
   line (the `tumwater · …` push, after `budgetBadge`), reusing the render's existing one-clock
   `now`. `tumwater status` and the TUI's status pane both go through `renderStatus`
   (src/ui/tui.ts imports it), so they pick the badge up unchanged.
3. **src/ui/gui-client-operator.ts** — `renderPauseBadge`, the header's fleet pause/resume
   control (it renders into the `#pausewrap` element the `d.paused ? " · paused — resume" :
   " · pause"` branch; gui-client.ts only calls the function, the client JS template lives in
   gui-client-operator.ts — edit there): the badge keeps its existing `d.paused` gate and, when
   the payload's `pausedUntil` stands on top of it, renders ` · paused — auto-resumes in 12m —
   resume` as the link text (recomputed on each 1 s poll, like the rest of the badge — that is
   why the countdown is client-side rather than a preformatted payload badge: the ticking
   number must re-render between polls); a pause without a deadline keeps today's wording. The
   link keeps its resume behavior either way — lifting early stays one click. No endpoint or
   payload change: `pausedUntil` is already on the payload (src/ui/status-payload.ts, dropped
   from the JSON when undefined, with a comment reserving it for exactly this consumer), and
   `pausedUntil` standing implies `d.paused` (the snapshot omits the field unless the fleet
   marker stands unexpired).

**Files touched:** src/ui/status-model.ts, src/ui/status-render.ts, src/ui/gui-client-operator.ts;
tests in test/status-model.test.ts, test/status-render.test.ts, test/gui-operator.test.ts (the
pause badge and its POST toggle are already covered there — extend those cases; the badge is
client-side rendering over the payload the parent plan already pins).

**Acceptance criteria.** (a) `pauseBadge` reads empty for an absent or past `pausedUntil` and
` · paused — auto-resumes in <duration>` for a future one, with the duration exactly
`humanSeconds(until - now)` at the passed `now`. (b) The `tumwater status`/TUI header shows the
badge only while a fleet timed pause stands — a `pause` without `--for` and a role-only timed
pause (`pause --role <id> --for 2h`) both render today's header unchanged — and an expired
deadline renders nothing, matching the unpaused read. (c) The GUI's pause badge shows the
countdown while a fleet timed pause stands (its `pausedUntil`) and today's ` · paused — resume`
otherwise, and remains a working resume link in both states. (d) Full suite passes.

Landed 2026-09-28 (feature): re-land after review — the GUI countdown calls the page's shared
humanSeconds helper (gui-client.ts, in scope at the splice point) instead of adding a client copy
of the bucketing; the TS badge and its tests are unchanged in shape from the plan.

### `tumwater history [--role <id>] [-n N]` — one row per completed tick, newest first (planned 2026-09-28, done 2026-09-28)

**Goal.** The dashboards show each loop's *last* result and `tumwater logs` streams raw event
lines, but an operator asking "what did the fleet do over the last hour — which ticks burned
money, which failed, what did they say" must scroll and mentally pair `tick_start`/`tick_end`
lines. Every datum already rides the event log (src/loop.ts logs `tick_start {tick}` and
`tick_end {tick, result, summary, error, tokens?, costUsd?}`), so a read-only table view is a
thin rendering over an existing record — the same shape `logs` already has, tick-shaped.

**Approach.** One new read-only command beside `logs`, reusing its plumbing.

1. **src/ui/history.ts** (new file, the observing half like src/ui/log-commands.ts) — a pure
   collector `tickRows(events, limit, role)` plus the printing `cmdHistory(root, args)`. Read
   the log through the existing cached tail scan `readEvents(root, limit * 2 + 50)` (a larger
   window than the ask, since `tick_start`s and unrelated events interleave with the `tick_end`
   rows it scans for), then take the newest `limit` `tick_end` events: one row per completed
   tick — local time, loop, tick number, result, duration (`tick_end.ts − tick_start.ts`,
   paired on the same `loop` and `tick`; a start outside the scanned window — log rotation, or
   a `skipped` tick that never started — renders `—`, never a fabricated duration), tokens and
   cost when the event carries them (omitted when absent, matching the payload's omit-when-zero
   convention), then the summary or the error, truncated to keep each row one line. Newest
   first. Default `-n 20`; `parseCountFlag` bounds it to a new `HISTORY_MAX_TICKS = 200` (same
   shape as the report's window bound: more rows only re-read more log with no added signal).
   `--role <id>` filters by loop via `parseRoleFlag` (config-aware, exactly as `cmdLogs` reads
   it, so user-defined loops work). No `-f`: `logs -f` already follows raw events and a
   re-following table adds nothing; history is a one-shot window. An empty or missing log
   prints `no ticks yet` and exits 0 — read-only, stdout only, no state file created.
2. **src/cli.ts** — a `history` dispatch case beside `logs`: `rejectUnknownArgs("history",
   args, [{ names: ["-n"], value: true, valueName: "<count>" }, ROLE_FLAG])`, then
   `requireReadyRepo` and `cmdHistory`.
3. **src/help.ts** — one stanza in HELP between `logs` and `backlog` (the per-command view
   derives from the full text, so one edit covers `tumwater help history`).
4. **README.md** — one row in the usage table ("Watch per-tick history | `tumwater history
   [--role <id>] [-n N]`").

**Files touched:** src/ui/history.ts, src/cli.ts, src/help.ts, README.md; tests in
test/cli-history.test.ts (the collector's pairing/filter/bounds as unit cases plus one CLI
smoke run over a seeded event log, the pattern test/cli-logs.test.ts already uses).

**Acceptance criteria.** (a) `tumwater history` prints the last 20 completed ticks newest-first,
one row each, with time, loop, tick number, result, duration, tokens/cost when present, and the
summary (or error) truncated to one line; a tick whose start is not in the scanned window shows
`—` for duration. (b) `--role <id>` restricts rows to that loop, including user-defined ids;
`-n` accepts 1–200 and fails zero, negative, and non-numeric values with the standard
`fail()` message. (c) Unknown flags are rejected by the standard gate; an empty or missing event
log prints `no ticks yet` and exits 0. (d) `tumwater help history` shows the command's stanza.
(e) Full suite passes.

**Landed as planned** (2026-09-28, feature): the entry's files-touched list is exactly what
changed — src/ui/history.ts (new: `tickRows` collector + `cmdHistory`, with
`HISTORY_DEFAULT_TICKS`/`HISTORY_MAX_TICKS` beside it), the `history` dispatch case in
src/cli.ts (gate → `requireReadyRepo` → `cmdHistory`, between `logs` and `backlog`), one
stanza in src/help.ts, one README usage-table row, and test/cli-history.test.ts (5 collector
unit cases + 4 CLI smoke runs). One implementation detail beyond the text: the row's usage
cell renders tokens and cost through the shared `compactTokens`/`usd` formats so the table
and the event feed cannot drift. Full suite: 1899 pass, 1 skipped.

### Timed pause — `tumwater pause [--role <id>] --for <duration>` auto-resumes (planned 2026-09-25, refined 2026-09-28, done 2026-09-28)

**Goal.** Today's pause is indefinite: the marker (`.tumwater/state/paused.json`, `{ at }`) or a
paused role (`.tumwater/state/paused-roles.json`, `{ roles, at }`) stands until a manual `resume`
lifts it, so an operator quieting the fleet for a meeting or a manual repo session must remember
to come back — forget, and the fleet idles forever with nothing on the dashboards saying why.
Add a duration: `tumwater pause --for 30m` (fleet) or `tumwater pause --role cleanup --for 2h`
pauses until the deadline, then the existing pause machinery releases it by itself.

**Approach.** One shared deadline per marker — the marker already carries one `at`; it gains one
optional `until` (ms epoch) covering the whole set. Per-role deadlines would need a map plus
per-role transition logic for no observed need; pausing three roles at three times is three
commands, the last write winning with its own deadline.

1. **src/cli-args.ts** — `parseDurationFlag(flag, raw)`, shaped like `parseCountFlag`: accepts
   `<n><s|m|h|d>` (e.g. `45s`, `90m`, `2h`, `1d`), rejects zero, negatives, a missing or unknown
   unit, and a missing value via `fail()`; returns the duration in ms. No absolute `--at` form —
   one way of saying it.
2. **src/cli.ts** — the marker-command arg gate (`runMarkerCommand`'s `rejectUnknownArgs(command,
   args, [ROLE_FLAG])`) accepts `--for <duration>` for `pause` only; the other marker commands
   keep rejecting it.
3. **src/fleet-state.ts** — `pauseFleet(root, untilMs?)` writes `{ at, until? }`, `pauseRole`
   writes `{ roles, at, until? }`; the read side (`isFleetPaused`, `pausedRoles`) treats a marker
   whose `until` is in the past as not paused, and `pauseFleet`/`pauseRole` likewise treat an
   expired marker as absent, so a `pause` after expiry reports a fresh pause, never the stale
   "already paused". `resume`/`resumeRole` are unchanged — they lift early. Consequence: the
   orchestrator's existing poll-diff (`src/orchestrator.ts` ~lines 374–391, `isFleetPaused`/
   `pausedRoles` → `role_resumed` logging and the paused skip branches) sees the expiry as an
   ordinary unpaused transition — auto-resume needs **no new scheduler code**.
4. **src/operator-commands.ts** — `cmdPause` parses `--for` and passes the deadline through;
   `rolePauseMessage` (and the fleet branch's confirmation, which phrases its own sentence)
   names the auto-resume when a deadline stands: "… paused for 30m — resumes automatically at
   14:05". A `--for` on an already-paused marker overwrites the deadline (extend or shorten)
   and says so, rather than the idempotent no-op.
5. **src/ui/status.ts** `snapshot` + **src/ui/status-payload.ts** — expose `pausedUntil`
   (ms epoch): the FLEET marker's standing deadline, absent when the fleet is not timed-paused
   (no marker, no `--for`, or an expired `until` — the read side already treats expiry as
   unpaused). Fleet-scoped on purpose: an earliest-deadline rule across the role markers too
   would make a header badge claim an auto-resume that a co-standing indefinite fleet pause (or
   a role-only pause, which is not a fleet pause at all) contradicts. A `pausedUntil(root)`
   helper in fleet-state.ts owns the read beside `isFleetPaused`/`pausedRoles` (one module for
   every marker consumer); role-marker deadlines are not surfaced in the dashboards — the loop
   rows keep plain `paused` and the pause confirmation already names the resume time. Rendering
   a live countdown in `status`/TUI/GUI is deliberately out of scope: they already read the
   same markers and show the expired pause as unpaused, which is correct; the countdown is this
   file's "Pause countdown" entry.

**Files touched:** src/cli-args.ts, src/cli.ts, src/fleet-state.ts, src/operator-commands.ts,
src/ui/status.ts, src/ui/status-payload.ts; tests in test/cli-args.test.ts,
test/fleet-state.test.ts, test/operator-commands.test.ts, test/status.test.ts.

**Acceptance criteria.** (a) `pause --for 30m` and `pause --role <id> --for 2h` write the
matching marker with `until = now + duration` and confirm with the auto-resume time. (b) With
`until` in the past, `isFleetPaused`/`pausedRoles` read false, the orchestrator's transition
logging fires as for a manual resume, the dashboards show unpaused, and a subsequent `pause`
reports a fresh pause. (c) `resume` (fleet or `--role`) lifts a timed pause early with today's
wording; pausing with `--for` over an existing marker overwrites the deadline and reports it.
(d) `parseDurationFlag` rejects zero, negative, unit-less, unknown-unit, and missing values with
the standard `fail()` shape, and `pause` alone (no `--for`) behaves exactly as today. (e)
`status --json` carries `pausedUntil` only while a fleet timed pause stands (absent for an
indefinite fleet pause, a role-only pause, and an expired `until`). (f) Full suite passes.

**Done 2026-09-28 by feature.** Landed as specified, with two shape notes: the pause confirmations phrase the duration through a `durationLabel` helper beside `parseDurationFlag` (src/cli-args.ts) fed from the parsed value rather than `until - now`, so a few ms of clock skew between the two reads cannot turn "30m" into "1799999ms"; and src/help.ts's pause line now names `--for <dur>` so the flag is discoverable. Also touched beyond the list: test/cli-operators.test.ts — the pause gate's flag-list rejection message gained `--for <duration>`, `resume` is pinned to still reject it, and a CLI-level timed pause test covers the marker end to end.

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
