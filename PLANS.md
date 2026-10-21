# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-20 by feature: too large for one run** — the src change (routeModel, seamKeyedFallbackProvider, validation, alias row, BudgetSlice) is small, but a trial run left ~155 failing tests in ~25 files beyond the six listed: doctor, gate-polls, budget-gates, status-budget, role-view, pi-models, claude-run and others still spell raw configs with `agent: "claude"`, bare `claude-…` models under pi, `claude/<id>` fallbacks and resolved pairs. Part 4/5's fixture migration did not reach them; they need their own part (suggest 4b/5) before this one.

**User decision 2026-10-20 (recorded by the director role): merge this without waiting for the operator to migrate tumwater.json first. The break when the live config reloads is accepted; the operator fixes it after the merge. The migration is: `model` drops the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }`. Each load error must name that exact edit, because the operator works from those messages.**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (`isAgentId(provider)`) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule; a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isAgentId(seam.provider)` branch goes once no resolved seam carries a namespace provider. `AGENT_IDS`' doc comment drops "doubles as the selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -rn 'isAgentId(provider)\|startsWith("claude-")' src` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field; `npm test` passes.

### Failure digest window: `tumwater report --failures --since <duration> --until <duration>` digests a bounded past window that ends before now, compared against the window of the same length just before it (planned 2026-10-20 by the plan role; independent of every eligible plan. Touches src/report/report.ts + src/failure/failure-data.ts + src/failure/failure-render.ts + src/cli/help.ts + docs/cli.md + test/report.test.ts)

**Goal.** `report --since --until` (PLANS-DONE.md "Report window") totals a past window, but `cmdReport` (src/report/report.ts) rejects `--until` with `--failures`: `report --until does not apply to --failures: the digest compares its window against the equal-length window before it`. That reason does not rule the shape out. A bounded window `[now − since, now − until)` has a length of its own (`since − until`), and the window of that length right before it is just as well defined. Today an operator asking "what failed during yesterday's incident" (`--failures --since 1d --until 20h`) gets refused, or gets every later run mixed in by dropping `--until`. When this was planned, `grep -n 'untilMs' src/failure/*.ts` printed nothing.

Behavior, decided:
- The current window is `[now − sinceMs, now − untilMs)`. An event exactly at the end is dropped, the same edge `collectReportSince` uses. Its length is `L = sinceMs − untilMs`. The prior window is `[now − sinceMs − L, now − sinceMs)`. With no `--until`, everything is unchanged: L = sinceMs, and the current window still ends at `<= now`.
- `--until` keeps its existing rules in `cmdReport`: it requires `--since` and must be shorter than it. These checks already run before the `--failures` dispatch.
- The header uses `boundedWindowLine` (src/text/datetime.ts), the same line the usage report prints, followed by ` · <runs> runs`. The empty-window line reads `no events from <since> to <until> ago`. The Deltas heading names L: `## Deltas vs the preceding <durationLabel(L)>`.
- `--json` adds `untilMs` and `toIso` to the digest only when bounded. This matches `SinceReport`'s `untilMs`/`toIso` (src/report/report-data.ts).
- The dashboard, the TUI and `selfcheck-digest.ts` keep calling `collectFailureReportSince` with no until (notes: GUI/TUI have no `--until` twins). They are unchanged.

**Approach.**
1. src/failure/failure-data.ts:
   - `FailureReportData` gains `untilMs?: number; // the --until bound; absent when the window ends now` and `toIso?: string; // window end as ISO; set only with untilMs`.
   - `collectFailureReportSince(root, sinceMs, role?, untilMs?)` gains a 4th optional parameter. Compute `end = untilMs === undefined ? now : now - untilMs`, `length = sinceMs - (untilMs ?? 0)`, `cutoff = now - sinceMs` and `priorFrom = cutoff - length`. The current-partition test becomes `ev.ts >= cutoff && (untilMs === undefined ? ev.ts <= now : ev.ts < end)`. The prior test stays `ev.ts >= priorFrom && ev.ts < cutoff`, now with the new `priorFrom`. The read (`readWindowEvents(root, dayKey(priorFrom))`) and the coverage proof (`eventWindowCovers(raw, priorFrom)`) use the new `priorFrom`.
   - The `window` argument becomes `days: Math.ceil(length / 86_400_000)`, `to: dayKey(end)`, `sinceMs`, `fromIso`, and, only when `untilMs` is defined, `untilMs` and `toIso: new Date(end).toISOString()`. Widen `assembleFailureReport`'s `window` parameter type with the same two optional keys and spread them into the returned data the way `sinceMs`/`fromIso` already flow. Update the doc comment to describe the bounded case.
2. src/failure/failure-render.ts, `renderFailureMarkdown`:
   - Header: when `data.untilMs !== undefined && data.toIso !== undefined`, print `boundedWindowLine(durationLabel(data.sinceMs!), durationLabel(data.untilMs), data.fromIso!, data.toIso)`. Otherwise keep the current `sinceWindowLine`/`reportWindow` branches. Append ` · ${data.runs} runs` as now. Import `boundedWindowLine` from ../text/datetime.js.
   - The `!data.hasEvents` line: in the bounded case print `no events from ${durationLabel(sinceMs)} to ${durationLabel(untilMs)} ago`.
   - Deltas heading: in the bounded case use `durationLabel(data.sinceMs! - data.untilMs)`.
3. src/report/report.ts, `cmdReport`: delete the `if (untilMs !== null && args.includes("--failures")) fail(...)` guard, and pass `untilMs ?? undefined` as `collectFailureReportSince`'s 4th argument. Update the comment above the dispatch.
4. src/cli/help.ts: the `tumwater report --failures --since <duration> [--role …] [--json]` synopsis becomes `tumwater report --failures --since <duration> [--until <duration>] [--role <id>[,<id>...]] [--json]`. Append to its description "; --until <duration> ends both windows' span that long ago". In the `report --since … [--until <duration>]` stanza, change `(requires --since;\n not with --failures)` to `(requires --since)`. Re-wrap each stanza to its column.
5. docs/cli.md, "Audit" row: in the `report --since <duration> [--until <duration>]` parenthetical, change `and does not combine with `--failures`` so it no longer claims the exclusion: "(it requires `--since` and must be shorter than it)". In the `report --failures` parenthetical, after "compared against the equal-length window before it", add "; `--until <duration>` ends that window that long ago, and the preceding window then has the bounded window's length".

**Tests** (test/report.test.ts; add `collectFailureReportSince` via `import { collectFailureReportSince } from "../src/failure/failure-data.js";`):
- In "report --until is refused without --since, when not shorter, and with --failures": drop the `--failures` case and rename the test to "report --until is refused without --since and when not shorter". Add a case `["--since", "6h", "--until", "6h", "--failures"]` that matches `/report --until \(.*\) must be shorter than --since/`.
- New "report --failures --since --until digests only the bounded window and compares the same length before it". Seed `writeEvents` with `run_end` events for role `feature`, each `result: "error"`, with `error` text: at `ago(8 * HOUR)` ("prior-a"), `ago(3 * HOUR)` ("current-b") and `ago(HOUR / 2)` ("after-c"). Run `runCli(root, "report", "--failures", "--since", "6h", "--until", "1h")`. Assert exit 0, a match on `/window: 6h to 1h ago \(since .*, until .*\) · 1 runs/` and on `/## Deltas vs the preceding 5h/`. With `--json`, assert `runs === 1`, `untilMs === HOUR` and `typeof toIso === "string"`. The run at 8 h falls in the prior window `[11h, 6h)`, so the JSON `deltas` row for `feature` has `runs === 1` and `prevRuns === 1` (`DeltaRow`, failure-data.ts).
- New "collectFailureReportSince with untilMs drops events at or after the window end": with the same seed, `collectFailureReportSince(root, 6 * HOUR, undefined, HOUR).runs === 1`, and `collectFailureReportSince(root, 6 * HOUR).runs === 2`, which also shows the unbounded call is unchanged. Also assert that the unbounded result has no `untilMs` key.

**Acceptance criteria.**
- `tumwater report --failures --since 6h --until 1h` prints the digest of the 6h→1h-ago window under `window: 6h to 1h ago (since …, until …) · N runs`, with `## Deltas vs the preceding 5h`. `--json` carries `untilMs` and `toIso`.
- `--until` with `--failures` is still refused without `--since`, or when it is not shorter than `--since`. The "does not apply to --failures" error is gone: `grep -rn 'does not apply to --failures' src test docs` prints nothing.
- `report --failures --since <d>` without `--until`, the dashboard, the TUI and the selfcheck digest print what they printed before. The existing failure-digest tests in test/report.test.ts, test/failure-render.test.ts and test/gui-endpoints.test.ts pass unchanged.
- `npm run test:gate` passes.

### Dashboard API window end: `GET /api/report?sinceMs=&untilMs=` and `GET /api/history?sinceMs=&untilMs=` serve a bounded past window that ends before now, the twins of `report --since --until` and `history --since --until` (planned 2026-10-20 by the plan role; independent of every eligible plan. "Run transcript search in the dashboard" edits `handleRun` in the same src/gui/gui-endpoints.ts, a different function, so whichever lands second rebases. "Failure digest window" owns `/api/failures`' window end: this plan leaves `handleFailures` unchanged. Touches src/gui/gui-args.ts + src/gui/gui-endpoints.ts + test/gui-endpoints.test.ts)

**Goal.** The CLI can window a past span: `report --since 4d --until 3d` (PLANS-DONE.md "Report window") and `history --since 4d --until 3d` (PLANS-DONE.md "Run history window"). Both collectors already take the bound: `collectReportSince(root, sinceMs, role, untilMs)` (src/report/report-data.ts) and `readRunRowsSince(root, sinceMs, role, untilMs)` (src/history/history-data.ts). The dashboard's HTTP API cannot ask for that window. `handleReport` and `handleHistory` (src/gui/gui-endpoints.ts) pass only `sinceMs`, and an `untilMs` query parameter is silently ignored, so a script asking `/api/report?sinceMs=345600000&untilMs=259200000` gets the whole 4-day window with nothing to say the bound was dropped. When this was planned, `grep -n 'untilMs' src/gui/*.ts` printed only the pause handlers' unrelated `untilMs` locals in src/gui/gui-team-commands.ts.

**Approach.**
1. src/gui/gui-args.ts: add `export function untilMsQuery(q: URLSearchParams, res: http.ServerResponse, sinceMs: number | undefined): number | undefined | null`, beside `sinceMsQuery`, with a doc comment in its style. Rules, in this order:
   - `q.get("untilMs") === null` → return `undefined` (no bound; the window ends now).
   - `sinceMs === undefined` → `badRequest(res, "untilMs requires sinceMs (it ends a sinceMs window that long ago)")`, return `null`. This is the CLI's "--until requires --since".
   - Otherwise parse through `intQuery(q, res, "untilMs", "positive")`; a `null` result (the 400 is already sent) returns `null`. No separate cap is needed, because the next rule bounds it below the already-capped `sinceMs`.
   - `untilMs >= sinceMs` → `badRequest(res, \`untilMs (${untilMs}) must be shorter than sinceMs (${sinceMs})\`)`, return `null`. This is the CLI's "must be shorter than --since".
   - Else return the parsed number.
2. src/gui/gui-endpoints.ts `handleReport`: after `reportScope`, `const untilMs = untilMsQuery(q, res, scope.sinceMs); if (untilMs === null) return;`. Then pass `untilMs` as the fourth argument of `collectReportSince`. `renderSinceReportMarkdown` already prints `boundedWindowLine`'s `window: <since> to <until> ago (…)` header when `untilMs` is set. The days shape is unchanged: it has no `sinceMs`, so the helper's second rule rejects `?days=7&untilMs=…` with a 400 instead of ignoring it. Add `untilMsQuery` to the existing `./gui-args.js` import, and add `[&untilMs=<ms>]` to the handler's doc comment.
3. `handleHistory`, in the `sinceMs` branch: after `sinceMsQuery`, call `untilMsQuery(q, res, sinceMs)`, return on `null`, and call `readRunRowsSince(root, sinceMs, role, untilMs ?? null)`. In the count branch, before `intQuery(q, res, "n", …)`, call `if (untilMsQuery(q, res, undefined) === null) return;` so `?n=20&untilMs=…` is a 400, not silently ignored. `covered` and `note` are unchanged: `readRunRowsSince`'s `covered` is the far edge's either way. Update the doc comment.
4. No dashboard client change. The report and History pickers keep their trailing-window buttons. Choosing a UI for a past window (stepping back by the window's length, for example) is a later plan. This plan gives scripts and that later UI the server half. `handleFailures` is left alone until "Failure digest window" adds the collector's bound.

**Tests** (test/gui-endpoints.test.ts, using its existing `serveReport` and `serveHistory` helpers and `writeEvents` from ./fixtures/log-fixtures.js):
- New test "handleReport's ?untilMs ends the since window that long ago". Seed `run_end` events at now−30 min (tokens 111) and now−3 h (tokens 999). `?sinceMs=14400000&untilMs=3600000` → 200, and `markdown` matches `/window: 4h to 1h ago/` and `/999 output tokens/` and does not match `/111/`. Compare the shape, not the bytes, against the collector: each call reads its own `Date.now()`, so the header's timestamps can differ by a millisecond. 400 cases: `?untilMs=3600000` (no sinceMs) and `?days=7&untilMs=3600000` give 400 with error matching /requires sinceMs/; `?sinceMs=3600000&untilMs=3600000` gives 400 matching /must be shorter than sinceMs/; `?sinceMs=3600000&untilMs=abc` gives 400.
- New test "handleHistory's ?untilMs drops the window's newer rows". Seed clean run 9 (`run_start` now−30 min, `run_end` now−20 min) and feature run 1 (`run_end` now−5 min). `?sinceMs=7200000&untilMs=600000` rows deep-equal `readRunRowsSince(root, 7200000, null, 600000).rows`, and the mapped `[role, run]` pairs are `[["clean", 9]]`. `?n=20&untilMs=600000` and `?untilMs=600000` give 400 matching /requires sinceMs/; `?sinceMs=600000&untilMs=600000` gives 400.

**Acceptance criteria.**
- `/api/report?sinceMs=S&untilMs=U` (U < S) serves `{ markdown }` rendered by `renderSinceReportMarkdown(collectReportSince(root, S, roles, U))`: the bounded window header and only the events in `[now − S, now − U)`.
- `/api/history?sinceMs=S&untilMs=U` serves the rows of `readRunRowsSince(root, S, role, U)`, and `grep` and `summary` compose with it as they do without it.
- `untilMs` without `sinceMs`, `untilMs >= sinceMs`, or a non-positive-integer `untilMs` is a 400 on both endpoints. Nothing ignores it silently.
- Requests without `untilMs` answer exactly as before: the existing handleReport and handleHistory tests pass unchanged.
- `npm run test:gate` passes.

### Dashboard event-log window: `GET /api/logs?sinceMs=` serves the event feed of a trailing time window, the twin of `tumwater logs --since <duration>` (planned 2026-10-20 by the plan role; independent of every eligible plan. Touches src/gui/gui-endpoints.ts `handleLogs` + test/gui-endpoints.test.ts. "Dashboard API window end" edits `handleReport`/`handleHistory` in the same file and src/gui/gui-args.ts; this plan edits neither of those functions nor gui-args.ts)

**Goal.** `tumwater logs --since 2h` (`cmdLogs`, src/cli/log-commands.ts) prints every event of a time window through `readEventsSince` (src/events/event-window.ts), with the sparse-window note when the log does not reach back that far. The dashboard's event search, `handleLogs` (src/gui/gui-endpoints.ts), only knows `?n=` — the newest N events, clamped to `LOGS_SEARCH_MAX_EVENTS` — so "which events matched `land` in the last 6h" cannot be asked of the server, and a busy log's 6h can exceed any count. `/api/history` already has the window shape (`?sinceMs=`, `sinceMsQuery`, `LOGS_SINCE_MAX_MS`, `covered`/`note`); `/api/logs` gets the same one.

Behavior, decided:
- `?sinceMs=S` answers `{ events, covered, note }`: `events` are `readEventsSince(root, S).events` filtered by the existing `role` and `grep` rules, oldest-first as `eventFeedItem` objects; `covered` is `readEventsSince`'s `covered`; `note` is `SPARSE_WINDOW_NOTE` when `covered` is false, else `""` — the `/api/history` window shape.
- `sinceMs` with `n` is a 400 with `handleHistory`'s wording: `"sinceMs cannot be combined with n (a count and a window are rival shapes)"` (the CLI's "-n and --since are rival shapes").
- `sinceMs` parses through `sinceMsQuery(q, res, LOGS_SINCE_MAX_MS, (ms) => \`sinceMs is capped at ${humanSeconds(LOGS_SINCE_MAX_MS / 1000)} (got ${ms})\`)` — the same call `handleHistory` makes, so the cap and wording match `logs --since`/`history --since`.
- No row cap in the window branch: `logs --since` prints the whole window, and `LOGS_SINCE_MAX_MS` already bounds its span.
- Without `sinceMs`, the response is unchanged (`{ events }`, n-scanned).
- No dashboard client change (src/ui/gui/gui-client-feed.ts keeps calling `?n=`); a window picker for the feed is a later plan. `untilMs` on this endpoint is also a later plan, once "Dashboard API window end" has landed `untilMsQuery`.

**Approach.** src/gui/gui-endpoints.ts:
1. Import `readEventsSince` from ../events/event-window.js (extend an existing event-window import line) and `sinceMsQuery` from ./gui-args.js if not already imported (`handleHistory` uses it, so it is; verify with grep). `humanSeconds` is already in scope (used by `handleHistory`).
2. In `handleLogs`, read `role`, `grep` and `needle` first, and build `const keep = (e: HarnessEvent) => (role === null || eventRole(e) === role) && (needle === null || eventMatchesGrep(e, needle));` (import the `HarnessEvent` type if it is not in scope). Then, before the `n` parse: `if (q.get("sinceMs") !== null) { if (q.get("n") !== null) { badRequest(...); return; } const sinceMs = sinceMsQuery(...); if (sinceMs === null) return; const { events, covered } = readEventsSince(root, sinceMs); sendJson(res, 200, { events: events.filter(keep).map(eventFeedItem), covered, note: covered ? "" : SPARSE_WINDOW_NOTE }); return; }`. The existing n branch then filters with `keep`, unchanged in behavior.
3. Update the doc comment's first line to `GET /api/logs?n=N|sinceMs=S[&grep=<text>][&role=<id>]` and add a sentence describing the window branch (readEventsSince, the rival-shape 400, the LOGS_SINCE_MAX_MS cap, covered/note as /api/history's window answers).

**Tests** (test/gui-endpoints.test.ts, using `serveLogs` and `writeEvents`):
- New "handleLogs ?sinceMs serves the trailing window's events, composing grep and role". Seed with `ts: Date.now() - …`: a feature `run_end` summary "landed old" at now−3h, a feature `run_end` summary "landed new" at now−30min, a bugfix `run_end` summary "landed other" at now−20min. `?sinceMs=3600000` → status 200, two events (the 30min and 20min ones, oldest-first), `covered === true`, `note === ""`. `?sinceMs=3600000&role=feature` → only the 30min one. `?sinceMs=3600000&grep=other` → only the bugfix one. Assert on each item's `ts` (`eventFeedItem` returns `{ ts, source, type, result?, message }`).
- New "handleLogs refuses sinceMs with n, a malformed sinceMs, and one over the cap". `?sinceMs=3600000&n=5` → 400 matching /rival shapes/; `?sinceMs=abc` and `?sinceMs=0` → 400; `?sinceMs=${LOGS_SINCE_MAX_MS + 1}` → 400 matching /capped at/ (import `LOGS_SINCE_MAX_MS` from ../src/events/event-window.js if the file does not already).
- The existing handleLogs tests pass unchanged (the n branch still answers `{ events }` only).

**Acceptance criteria.**
- `/api/logs?sinceMs=S[&role=][&grep=]` answers `{ events, covered, note }` holding exactly the role/grep-matching events with `ts >= now − S`, oldest-first as feed items.
- `sinceMs` with `n`, a non-positive or malformed `sinceMs`, or one above `LOGS_SINCE_MAX_MS` is a 400.
- Requests without `sinceMs` answer as before; the existing `handleLogs` tests pass unchanged.
- `npm run test:gate` passes.

## Done
