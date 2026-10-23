# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Codex backend, part 3b/9: The status header and the GUI budget tile name each backend's window (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/ui/badges.ts src/ui/status-render.ts src/ui/status-payload.ts src/ui/gui/gui-client-operator.ts test/badges.test.ts test/status-header.test.ts test/gui-client.test.ts)

**Goal.** The header badge and the GUI budget tile render each subscription backend's window under that backend's name; a claude-only team's text is byte-identical.

**Approach.**
- src/ui/badges.ts: `claudeWindowBadge(claudeWindow, now, moved)` becomes `subscriptionWindowBadge(blocks, now, moved)`, rendering `${block.label} ${windowLabel(block.primary.type)}` + utilization percent or status word + the "<label> model jobs wait until HH:MM" hold clause (the label replaces the hardcoded "claude"). The badge shows `blocks[0]` (the list is already most-constrained-first). `budgetBadge(budget, claudeWindow, now, chain)` becomes `budgetBadge(budget, windows, only, now, chain)`: the `if (only) return window` replacement and the "beside the spend" join are unchanged over the new arguments. `claudeWindowTone(claudeWindow)` becomes `subscriptionWindowTone(blocks)` reading `blocks[0]`.
- src/ui/status-render.ts and src/ui/status-payload.ts: pass `snap.subscriptionWindows` and `snap.subscriptionOnly` to `budgetBadge` and the tone; the payload's preformatted `budgetBadge` string is that same function's output.
- src/ui/gui/gui-client-operator.ts: `budgetCardHtml(b, cw, chain)` and `windowLinesHtml` take the block list and `only`; they emit one window line per block (same per-line markup) and name the held block's label in the "held until" line.

**Acceptance criteria.**
- Existing badge and status-header tests for a claude-only snapshot pass with byte-identical strings.
- With a `sub` block ordered first, the header badge reads `Sub 7d · 40%` and the tile lists both `Claude 5h …` and `Sub 7d …`; with claude first, the header keeps `Claude 5h …`.
- `npm test` passes.

### Codex backend, part 3d/9: The report's API-equivalent line names each subscription backend (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/events/events.ts src/run/run-finalize.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts test/report.test.ts test/report-data.test.ts)

**Goal.** The report prints one "<label> subscription, API-equivalent: $X estimated" line per subscription backend with notional spend, instead of one hardcoded "claude subscription" line.

**Approach.**
- src/run/run-finalize.ts: the `run_end` event carries `agent: usage.agent` when the run reported billing or rate windows (the same condition that writes the account file), so the fold can attribute notional spend to a backend; document the new field in src/events/events.ts's `run_end` comment.
- src/report/report-fold.ts: a `notionalByBackend` map beside `notionalByProvider`, accumulated from each `run_end`'s `agent` — falling back to `"claude"` when `agent` is absent and `billing === "subscription"`, the same legacy default old window events get.
- src/report/report-types.ts and src/report/report-data.ts: carry `notionalByBackend` through the fold → day → totals exactly as `notionalByProvider` is carried; absent when empty.
- src/report/report-render.ts: `notionalLine` becomes one line per backend with notional spend, `${backendDisplayName(backend)} subscription, API-equivalent: $X estimated`; keep a single generic line for the total when only old-log totals are known.

**Acceptance criteria.**
- A report over runs of two subscription backends prints two labeled notional lines; a claude-only report's line is byte-identical to today; the totals' `notionalCostUsd` still equals the sum.
- Old `run_end` events without `agent` still count their notional under claude (the legacy default).
- `npm test` passes.

### Codex backend, part 3e/9: Doctor's window row names each subscription backend, the reserve labels name the key, and docs say the display is per backend (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/doctor/doctor-holds.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts docs/backends.md test/doctor-holds.test.ts test/doctor.test.ts test/gui-client-settings.test.ts)

**Goal.** `tumwater doctor` reports one window row per subscription backend in use (a codex team gets a `codex window` row), the reserve editors name the `backends.<id>.windowReserve` key, and docs/backends.md states the display is per backend.

**Approach.**
- src/doctor/doctor-holds.ts: `checkClaudeWindow` becomes `checkSubscriptionWindow(backend, root, now, chain, config)` — the same body over `readAccount(root, backend)` and `windowObservation(backend, …)`, with every "claude" phrase replaced by `backendDisplayName(backend)`.
- src/doctor/doctor.ts: the one "claude window" step becomes two conditional steps, `claude window` and `codex window`, each returning null when that backend has no subscription account (the same omit-a-row pattern as "pi extensions").
- src/doctor/doctor-check-names.ts: add `"codex window"` after `"claude window"`, so the closed name union still covers every step and `tumwater doctor codex window` parses.
- src/ui/gui/gui-client-settings.ts and src/ui/tui/tui-editor-claude-reserve.ts: the label and editor hint read "Claude window reserve (backends.claude.windowReserve)".
- docs/backends.md: the window-display paragraph says the windows are shown per backend.

**Acceptance criteria.**
- A codex subscription account makes doctor print a `codex window` row and a claude one makes `claude window`; a pi-only team prints neither; each row's text names its own label.
- The settings label test asserts the new text; the TUI editor hint names the key.
- `npm test` passes.

### Codex backend, part 8/9: Codex billing, free-ness and windows: the account fed from runs, the API-key refusal, the context window, effort levels and image input from the catalog (planned 2026-10-20 by user; requires parts 3a/9, 3b/9 and 7/9 landed; design in plans/codex-backend.md "Spend, free-ness, window, images"; touches src/pi/pi-models.ts src/agent/codex/codex-backend.ts src/agent/codex/codex-catalog.ts (new) src/agent/codex/codex-account.ts (new) src/gates/startup-gate.ts src/config/config-live.ts and their tests)

**Goal.** A Codex job on a ChatGPT subscription counts as free to the budget gate while its windows serve, moves down its chain when a window is used up or past its reserve, and shows its windows on the badge. That works through parts 1/9–3/9's per-backend machinery with no Codex special case outside src/agent/codex/. An API-key Codex login is refused, because Codex reports no cost.

**Approach.**
- src/agent/codex/codex-catalog.ts (new): `readCodexCatalog(home)` parses `models_cache.json` under the run's `CODEX_HOME` (or `~/.codex`). For each model it returns `{levels, defaultLevel, contextWindow: context_window × effective_context_window_percent / 100, images: input_modalities includes "image"}`. A missing or malformed file reads as an empty catalog.
- The adapter uses the catalog:
  - `codexEffort(thinking, catalog[model]?.levels)` drops a level the model does not list;
  - `imageInput` reads `images`, and a model missing from the catalog answers false.
- src/pi/pi-models.ts:
  - `seamFree`'s `codex` arm is `accounts("codex")?.billing === "subscription"`.
  - `seamContextWindow`'s `codex` arm reads the catalog's `contextWindow`.
- src/agent/codex/codex-account.ts (new): `seedCodexAccount(root, config)`, the counterpart of `seedClaudeAccount`.
  - It runs `codex login status` with the run env, bounded at 10 s.
  - "Logged in using ChatGPT" writes `{billing: "subscription"}`. Plan and windows arrive with the first run's rollout.
  - "an API key" writes `{billing: "api"}`.
  - Anything else writes nothing.
- src/gates/startup-gate.ts and src/config/config-live.ts seed it when codex is in use, as they seed claude. A codex job on `billing: "api"` is a startup problem: "Codex is logged in with an API key; tumwater runs Codex on a ChatGPT subscription only — run `CODEX_HOME=<home> codex login --device-auth`".
- A run's rollout reading reaches the codex account through part 1/9's `observeAccount`. Holds, moves, the reserve and the display then follow from parts 2/9 and 3/9.

**Acceptance criteria.**
- With a seeded subscription codex account:
  - a Codex fallback step is accepted as a budget fallback for a priced primary;
  - at the cap, a Codex job keeps running;
  - an all-Codex team's badge shows the Codex windows instead of the spend.
- A rejected `five_hour` reading in the codex account moves Codex default-tier jobs to their next step, places a `codex` hold only for jobs with no step, and logs `subscription_window_limited {backend: "codex"}` once. Claude jobs are untouched.
- `backends.codex.windowReserve: { "seven_day": 0.7 }` with a `seven_day` reading at 0.71 moves Codex jobs and logs `subscription_window_reserved`.
- `seamContextWindow` for `gpt-6.1-sol` with the fixture catalog is 475000. `imageInput("gpt-6-luna")` is true. An unknown model is null and false.
- A fake `codex login status` printing "Logged in using an API key" makes the startup gate refuse a codex job with the message above.
- `npm test` passes.

### Codex backend, part 9/9: Doctor checks the Codex install, login, home and models; session retention; docs; and an opt-in `smoke:codex` live check (planned 2026-10-20 by user; requires part 8/9 landed; design in plans/codex-backend.md "CODEX_HOME and sessions", "Spend, free-ness, window, images", "Risks" and "Hand steps"; touches src/doctor/doctor-model-checks.ts src/doctor/doctor-checks.ts src/doctor/doctor-check-names.ts src/doctor/doctor.ts src/agent/codex/codex-backend.ts src/agent/session-ledger.ts src/orchestrator/retention.ts docs/backends.md docs/config.md README.md scripts/smoke-codex.mjs (new) package.json and their tests)

**Goal.** An operator can set Codex up from doctor's output alone, the team's Codex sessions are pruned like every other session, and one live command proves the production invocation still works after a Codex upgrade.

**Approach.**
- Doctor gets a `codex` check group, shown when any job routes to codex:
  - the binary resolves, and `codex --version` is at least `CODEX_MIN_VERSION` (0.163.0, the probed version);
  - `codex login status` under the run's home: ChatGPT passes; an API key fails with the startup-gate message; not logged in fails, naming `CODEX_HOME=<home> codex login --device-auth`;
  - the home: `backends.codex.configDir` unset warns that team runs share the operator's `~/.codex` (trust entries, sessions in the resume picker, skills, a global AGENTS.md);
  - each Codex model is in the catalog, with its window and any thinking level it lacks;
  - the account: `credits.has_credits` true warns that a run crossing a limit may spend credits tumwater cannot count (design §7);
  - leaks: the home's `AGENTS.md`, `skills/` beyond `.system`, `hooks`, and the target repo's `.codex/config.toml` MCP servers, each named;
  - the size of the home's `sessions/`.
- Retention: the existing pruning (src/orchestrator/retention.ts, src/agent/session-ledger.ts) deletes the ledger's expired Codex sessions with `codex delete --force <id>` under the run's env (bounded at 10 s). Without `--force` Codex refuses to delete without a terminal (design finding 21). When the delete fails, pruning removes the rollout file.
- docs/backends.md gets a "Codex (`backend: "codex"`)" section: what it runs, the home and its one login, subscription-only billing, the windows and reserve, what is disabled and why, sessions, and the sandbox choice. docs/config.md covers the `backends.codex` keys. README.md lists Codex among the backends.
- scripts/smoke-codex.mjs (new; `npm run smoke:codex`, not in `npm test`) runs the exact production invocation in a throwaway git repo:
  - a fresh run that edits a file and runs a command;
  - a resume that recalls it;
  - a SIGTERM mid-command, after which no marked process is left;
  - an end-of-run note through `tumwater-notes`;
  - an assertion that the first request is under 10,000 input tokens (8,059 on 0.163.0), which catches an isolation regression;
  - a 90-second command that the model must poll to completion, with no `codex_command_abandoned`;
  - an assertion that the rollout gave a `five_hour` and a `seven_day` reading.

**Acceptance criteria.**
- Doctor tests on fake-codex:
  - each row's pass, warn and fail cases above;
  - a version below 0.163.0 fails;
  - a pi-only team shows no codex group.
- Retention test: an expired codex ledger record gets one `codex delete --force <id>` on the fake, and its rollout is gone. A fresh one is kept.
- `npm run smoke:codex --help` (or a dry-run flag) prints its steps without spawning codex.
- docs/backends.md's Codex section names `backends.codex.configDir`, `codex login --device-auth` and `windowReserve`.
- `npm test` passes.

### An operator `tumwater revert` logs an `operator_revert` event, so the reverted run's trail and history name the revert and the role it undid (planned 2026-10-23 by the plan role; independent of every eligible plan and of the Codex backend series; touches src/events/events.ts src/events/event-labels.ts src/events/event-format.ts src/operator/revert.ts src/run/run-detail-data.ts src/run/run-detail-render.ts docs/cli.md test/operator-revert.test.ts test/run-detail-data.test.ts test/run-detail.test.ts test/event-format.test.ts)

**Goal.** An operator who runs `tumwater revert` on a merged change leaves a trace the team can read. Today only the automatic main-watch revert logs an event (`main_revert`), and the run trail matches only `main_revert`; `revertedOf`'s doc comment says so in as many words ("an operator `tumwater revert` logs no `main_revert` and stays uncovered"). After this plan, `tumwater history <role> <n>`, the TUI's History trail and the dashboard's History drill-down all show `· reverted <sha> (by operator)` for a change an operator took back, and the event feed names it.

**Approach.**
- `src/events/events.ts`: add `"operator_revert"` to `HarnessEvent["type"]` with a comment that names its writer (an operator `tumwater revert`, src/operator/revert.ts) and its payload: `commit` (the reverted commit), `revert` (the inverse commit), `runner` (the role the reverted commit's stamp names, omitted for a hand-made, director or harness commit) and `subject`. It is deliberately distinct from `main_revert`: the revert guardrails and doctor warnings (`revertWarnings`, src/baseline/main-guardrails.ts; `test/doctor-holds.test.ts`) count `main_revert` and must not count an operator's deliberate revert.
- `src/events/event-labels.ts`: add `operator_revert: "operator revert"`. The file's `Record<HarnessEvent["type"], string>` makes the compiler demand it.
- `src/events/event-format.ts`: add a `case "operator_revert"` in the same shape as the existing `main_revert` case: `reverted <short commit> (by operator) as <short revert>`, naming the runner when the event carries one.
- `src/operator/revert.ts`:
  - Extract the stamped-role check `revertFollowUp` already performs into a helper `revertedRole(subject): string | null` (null when `stampedRole` is undefined, `operator` or `tumwater`) and use it in both `revertFollowUp` and the new log site.
  - In `revertMergedCommit`, after `revertCommitIn` succeeds and while the primary lock is held, call `logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "operator_revert", commit: full, revert: reverted.sha, subject, ...(role === null ? {} : { runner: role }) })`. Best-effort, so a failed event write never turns a successful revert into a refusal. No import cycle: `src/events/events.ts` imports no operator module.
- `src/run/run-detail-data.ts`: `RunDetail["reverted"]` gains `kind: "main" | "operator"`; `revertedOf` accepts `operator_revert` beside `main_revert`, keeping the same `runner`-and-`commit` match (the run's role, and its `mergedSha` or `runCommitSha`), and returns `failingTests: []` with `kind: "operator"` for it. Update the two doc comments that say operator reverts stay uncovered.
- `src/run/run-detail-render.ts`: keep the `· reverted <sha>` clause, append ` (failing: <test>)` for a `main` revert that names one, and ` (by operator)` for an `operator` revert.
- `docs/cli.md`, the "Watch run history" row: after the existing `main_revert` clause, add the operator twin — a change an operator reverted adds `reverted <sha> (by operator)`.

**Tests.**
- `test/operator-revert.test.ts`: a new test seeds a `tumwater(feature): …`-stamped commit, reverts it, and asserts one `operator_revert` (`eventsOfType`, test/fixtures/log-fixtures.ts) with the reverted sha as `commit`, the new HEAD as `revert`, and `runner: "feature"`; a second reverts a normal commit and asserts the event has no `runner`.
- `test/run-detail-data.test.ts`: the two existing `deepEqual` expectations gain `kind: "main"`; a new test matches an `operator_revert` to the run's landed sha (with `failingTests: []`, `kind: "operator"`), and a wrong runner or wrong commit leaves `reverted` null.
- `test/run-detail.test.ts`: the existing render literal gains `kind: "main"`; a new assertion renders an operator revert's `· reverted <sha> (by operator)` header.
- `test/event-format.test.ts`: one case for the new type's line.

**Acceptance criteria.**
- `tumwater revert <sha>` logs exactly one `operator_revert` carrying the reverted commit, the inverse, the subject, and the stamped role when there is one; the CLI, the GUI and the TUI all reach it through `revertMergedCommit`, so all three log it once.
- An operator revert of a role's landed change makes that run's `readRunDetail(...).reverted` non-null with `kind: "operator"` and `failingTests: []`, and its rendered header line ends `(by operator)`; an automatic `main_revert` still yields `kind: "main"` and its first failing test.
- `main_revert` guardrail and doctor counts are unchanged by an operator revert (nothing that matches `main_revert` matches the new type).
- The updated run-detail-data and run-detail render tests, plus the new operator-revert and event-format tests, pass; `docs/invariants.md` is edited only if its run-trail/revert section pins the match (check INV-L1 before finishing).
- `npm run test:gate` passes.

### `tumwater report` prices main's red time per day: how long main had no passing full check (planned 2026-10-23 by the plan role; shares src/report and src/ui/gui/gui-client-report*.ts with the in-flight `Reverts by role` entry and the blocked Codex part 3d/9, but only adds new fields, lines and a chart beside theirs, so whichever lands second rebases over them; src/baseline/main-guardrails.ts is touched by no waiting entry; touches src/report/report-main-red.ts (new) src/report/report-types.ts src/report/report-fold.ts src/report/report-data.ts src/report/report-render.ts src/baseline/main-guardrails.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts docs/cli.md test/report-main-red.test.ts (new) test/report-data.test.ts test/report.test.ts test/gui-client-report.test.ts)

**Goal.** The usage report shows each day's count of failed full-suite checks (`checkFailures`) and its passing-check medians, but never the wall-clock time main spent red — the span every code role was held and every merge blocked. `redMainWarning` (src/baseline/main-guardrails.ts) already derives the current spell, but only for the doctor/selfcheck "right now" warning; `grep -rn 'main_red' src/report` finds nothing. After this plan `tumwater report`, `report --since`, `report --json`, the TUI's Usage pane and the dashboard's Usage view name main's red time per day (`**Main red:** 10-22 1h 3m · 10-23 12m`), from the same `main_check`/`main_red_hold` rule G1 uses.

**Approach.**
- src/baseline/main-guardrails.ts: extract the predicates `redMainWarning` builds inline, without behavior change (its existing tests pass untouched): export `ranFullMainCheck(ev)` (a `main_check` with numeric `durationMs` > 0 — the `relevant` filter's check half), `isRedMain(ev)` (`main_red_hold`, or a failed `main_check` that ran), and `isPassingMainCheck(ev)` (a `main_check` that ran and passed). `redMainWarning`'s `relevant`/`red`/`passes` filters call them; their doc comments name the new report caller and say the rule is one home so the report and G1 cannot disagree about whether main is red.
- New src/report/report-main-red.ts: pure `mainRedMinutesByDay(events, fromMs, toMs): Map<string, number>`. Keep the events with a numeric `ts` in `[fromMs, toMs)` in ts order; a spell opens at a red event while none is open (a further red while open keeps the earliest start) and closes at the next `isPassingMainCheck` event; a spell still open at the end runs to `toMs`. Split every spell across local calendar days (`dayKey`) with Date-field midnight arithmetic (the `dayAt` walk, so a DST shift cannot leak an hour into the next day), summing ms per `YYYY-MM-DD`; return only nonzero entries. Doc comment: the rule is G1's; a spell already open before `fromMs` is not counted because its opener lies outside the window; this is main's own red time, not any role's.
- src/report/report-fold.ts: `ReportFoldEntry` gains `redEvents: HarnessEvent[]` (seeded `[]` on the full read), and `foldEventInto` appends the event when `isRedMain(ev) || isPassingMainCheck(ev)` — only the two shapes the interval walk needs, so the retained list stays tiny across the append-only fold (`foldLineInto` reaches the same `foldEventInto`, so an appended pass closes a spell a cache rebuild would have closed).
- src/report/report-types.ts: `ReportDay` gains `mainRedMs?: number` (team-only, absent when zero, like `checkMedianMs`); `SinceReport` gains `mainRedMs: number` (always present, 0 when none).
- src/report/report-data.ts: `collectReport` calls `mainRedMinutesByDay(foldEntry.redEvents, dayAt(days - 1, now).getTime(), now.getTime())` once and sets `day.mainRedMs` on each series day that has one, in the team branch only (a role-scoped report leaves it unset, exactly as `checkFailures` is team-only). `collectReportSince` calls the same helper over `raw.events` with `[cutoff, end)` and returns the summed map as `mainRedMs`.
- src/report/report-render.ts: in `renderReportMarkdown`'s per-day block, after the `Red merge checks` line, push `**Main red:** ${days.map((d) => `${monthDay(d.date)} ${durationLabel(ms)}`).join(" · ")}` for the days that carry `mainRedMs` (no line when none, team-only); in `renderSinceReportMarkdown`, push `**Main red:** ${durationLabel(data.mainRedMs)}` when `data.mainRedMs > 0`.
- src/ui/gui/gui-client-report-chart.ts: add `chartMainRedMs(data)` = `reportSvg(data.series, (d) => [{ value: Number(d.mainRedMs) || 0, color: "#dc2626", title: d.date + ": " + fmtSpan(Number(d.mainRedMs) || 0) + " main red" }], (v) => fmtSpan(v), false)`, gated by `seriesHasScalar(data, "mainRedMs")`.
- src/ui/gui/gui-client-report.ts: append `(seriesHasScalar(d, "mainRedMs") ? block("Main red time", chartMainRedMs(d), "per day · no passing full check") : "") +` after the `Red merge checks` block chain.
- docs/cli.md, the `tumwater report` rows: name the `Main red` line and that it is main's own red wall-clock from `main_check`/`main_red_hold` (team-only).

**Tests.**
- test/report-main-red.test.ts (new): hand-built events — a `main_red_hold` at T closed by a passing `main_check` 40 min later yields 40 min on that day; a spell crossing local midnight splits across two day keys summing to the span; an open spell counts to `toMs`; a failed `main_check` with `durationMs: 0` opens nothing and a passed one with `durationMs: 0` closes nothing; a second red while open keeps the first start; events at or outside the bounds are ignored.
- test/report-data.test.ts: seed a `main_red_hold` plus a later passing `main_check` in one day; assert that day's `mainRedMs` and its absence on the other day; a role-scoped `collectReport` leaves every day unset; `collectReportSince` sums it.
- test/report.test.ts: `renderReportMarkdown` prints `**Main red:** <MM-DD> <span>` only for days that carry one and omits it on a role-scoped report (the `Red merge checks` pattern); `renderSinceReportMarkdown` prints the line for a positive window total and omits it at zero.
- test/gui-client-report.test.ts: the day-report block chain contains the gated `block("Main red time", chartMainRedMs(d))` call when `mainRedMs` is present, and `seriesHasScalar(d, "mainRedMs")` is false for a red-free series.

**Acceptance criteria.**
- A day whose `main_red_hold` is closed by a later passing full `main_check` reports the elapsed wall-clock as that day's `mainRedMs`; a spell crossing midnight splits across both days summing to the whole span; a spell still open at the window end counts to the end.
- A `main_check` that did not run (`durationMs: 0`, cached or inherited) neither opens nor closes a spell; a `main_red_hold` alone still counts to the window end.
- The line and field are team-only: a role-scoped day report and `report --json --role <id>` carry no `mainRedMs`, and a red-free window renders no line; `--since` carries the window total.
- The dashboard's Usage view renders the `Main red time` chart only when a day carries a nonzero `mainRedMs`.
- `redMainWarning`'s output is unchanged by the predicate extraction (its tests pass untouched); `npm run test:gate` passes.

## Split validateConfig's section rules out of the single validation gate by theme (planned 2026-10-22 by the organize role, plan-only)

src/config/config-validation.ts is the project's second-largest module (748 lines, ~3.7× the
200-line median) and ~607 of those lines are one function, `validateConfig`, a single sequential
pass that walks every section of tumwater.json. The doc already factors the generic machinery
(schema rules, the NumberRule table, the known-role/unknown-key guards) into
config-field-checks.ts, but every section's own rules still live inside the one gate, so any
edit to one section means reading and re-walking the whole pass and lands as one giant diff. The
gate is a single function, so it cannot be split piecemeal in one run; land this as a plan.

The split preserves `validateConfig` as the one export every caller imports (only four callers:
config.ts, config-write-core.ts, config-request.ts, config-example.ts; they keep importing it
unchanged) and keeps behavior and message byte-identical: the section validators only re-locate
where each today-appended problem is produced, in the same order.

**Target structure** — the two largest, most self-contained blocks move out first, each into a
new module that appends problems exactly as the gate does today. The model blocks are
interleaved with the gate's other sections: the top-level `model`/`provider` block runs before
`agentBin`/`baseBranch`/`backends`, but the `fallback`/`fallbackModel` block runs after the
numeric/`check`/`idleBackoff`/`review` sections (lines 224–277 and 473–508 in today's gate). So
the model module exports TWO functions — `validateModelBlock(r, problems, helpers)` for the
top-level selector/map block and `validateFallbackBlock(r, problems, helpers)` for the
fallback/fallbackModel shape — and the gate calls each at the point where its block runs today;
the agents module stays one function. This keeps problem order byte-identical, which a single
model-module function called once could not (a one-call design would emit fallback problems
before the agents and middle-section problems they follow today).
- New src/config/config-validation-model.ts — the model-declaration surface, as two entry points:
  `validateModelBlock` — top-level `model` selector vs map-by-tier and each tier entry's
  `model`/`provider`/`thinking`, the empty-half selector checks, backend-resolution, the
  retired-is-a-backend spelling and the legacy-provider form; and `validateFallbackBlock` — the
  `fallback` (string vs map) checks and the free-fallback-model (`fallbackModel`) shape.
- New src/config/config-validation-agents.ts — the agent-execution surface: `agentBin`,
  `baseBranch`, the claude/codex `configDir` scan, the codex `-c <key>=…` arity-aware scan, the
  `agents`/`piArgs` passthrough reserved-flag checks, and the legacy piArgs back-compat pair.
- src/config/config-validation.ts keeps `validateConfig` as the gate: bind the generic checkers
  once, call the two model-module functions and the agents-module function in the same order their
  blocks run today, and keep the
  per-role and cross-field sections (roles.<id> task/instructions/customRoles/instances,
  review.afterMerge names, per-role caps, per-role quiet hours, maxConcurrentPerProvider,
  claudeWindowReserve, and the idleBackoff cross-field pair) for a later pass.

**Cost it removes**: a section's rules become findable and testable in isolation instead of being
one undifferentiated stretch of a 600-line pass; a per-theme diff replaces a whole-gate diff.

**Files touched**: src/config/config-validation.ts; new src/config/config-validation-model.ts and
src/config/config-validation-agents.ts; docs/invariants.md only if it pins the gate's shape.

**Acceptance criteria.**
- The two new modules hold exactly the model and agent section rules, nothing else; the gate
  binds checkers once and calls them in the same order their blocks run today.
- Behaviour and messages unchanged: `validateConfig` produces identical problems for the same
  input before and after (the existing config validation tests pass untouched).
- A file only mentioning a model/backend key still validates identically pre- and post-split.
- grep over src, tests and docs finds no stale path or name for the moved blocks.
- `npm run test:gate` and `npm test` pass.

## Done
