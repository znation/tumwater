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

## Done
