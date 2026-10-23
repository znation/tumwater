# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

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

### The day report's backlog lag median: how long a finished plan or bug waited from filing to done (planned 2026-10-23 by the plan role; shares src/report/report-types.ts, src/report/report-data.ts, src/report/report-render.ts and the src/ui/gui report files with the in-flight `tumwater report` main-red and review-duration entries — it adds a different field, line and chart beside theirs, so whichever lands later rebases; touches src/backlog, which no waiting entry touches; touches src/backlog/backlog-md.ts src/backlog/backlog.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts docs/cli.md test/backlog.test.ts test/report-data.test.ts test/report.test.ts test/gui-client-report.test.ts)

**Goal.** The usage report shows each day's throughput (`features done` / `bugs fixed`) but never how long the items it closed had waited since filing, so a day that closes two stale plans looks the same as one that closes two fresh ones. Add `backlogLagMedianDays` per day: the lower median, over the entries completed that day whose heading carries both a filing and a completion stamp, of the filing-to-done span in whole calendar days. (`tumwater backlog --list` already shows an open entry's age; nothing shows the age at which entries were closed.)

**Approach.**
- src/backlog/backlog-md.ts: add `entryLags(md, sectionTitle, dateRe, filingRe): { done: string; lagDays: number }[]`, walking exactly the lines `entryDates` counts (the `### ` headings and `- ` epitaphs that close a trailing `(…; commit …)`) with the same `headingMetadata`/`trailingParenthetical` rules: `done = lastDate(meta, dateRe)`, `filed = firstDate(meta, filingRe)`, and push `{ done, lagDays: daysBetween(filed, done) }` only when both exist and `lagDays >= 0`. `firstDate` stays module-local; `filingRe` is a parameter so `STAMP_DATE_RE` (backlog.ts) keeps its one home. Import `daysBetween` from src/text/datetime.ts (a pure text helper, like this module). Update `firstDate`'s doc comment: `entryDates` and `entryLags` are now both callers.
- src/backlog/backlog.ts: add `sectionCompletionLags(root, fileName, sectionTitle, dateRe): { date: string; lagDays: number }[]` beside `sectionCompletionDates`, the same stat-cached file reader with its own `lagCache` (key `${file}\u0000${sectionTitle}\u0000${dateRe.source}\u0000${dateRe.flags}`), calling `entryLags(md, sectionTitle, dateRe, STAMP_DATE_RE)`. A missing or unreadable file yields `[]`.
- src/report/report-types.ts: `ReportDay` gains `backlogLagMedianDays?: number` (team-only, absent when the day has none, like `checkMedianMs`), documented as the lower median of the whole-day filing-to-done lags of the entries completed that day.
- src/report/report-data.ts: in `collectReport`'s team branch (`role === undefined`), beside the `validationGaps` loop, collect a `Map<string, number[]>` from `sectionCompletionLags` over `finishedFiles("PLANS.md")` with `DONE_DATE_RE` and `finishedFiles("BUGS.md")` with `FIXED_DATE_RE`; for each `{ date, lagDays }` whose `date` is a `byDate` key, push into that day's list, then set `day.backlogLagMedianDays = lowerMedian(lags)`. (`collectReportSince` has no day series, so the `--since` report is unchanged, like the other day-granular backlog tallies.)
- src/report/report-render.ts: in `renderReportMarkdown`, after the `**Commits:**` line, under its own `data.role === undefined` guard, push `**Backlog lag median:** ${cells}` where `cells` joins `` `${monthDay(d.date)} ${d.backlogLagMedianDays}d` `` for each day that carries the field (no line when none); values are whole days from `daysBetween`, so a plain `${n}d` is exact where `medianLine`'s `shortSpanPhrase` would print minutes.
- src/ui/gui/gui-client-report-chart.ts: add `chartBacklogLagMedian(data)` = `reportSvg(data.series, (d) => [{ value: Number(d.backlogLagMedianDays) || 0, color: "#0891b2", title: d.date + ": " + (Number(d.backlogLagMedianDays) || 0) + "d median backlog lag" }], (v) => Math.round(v) + "d", false)` and `seriesHasBacklogLagMedian(data)` = `seriesHasScalar(data, "backlogLagMedianDays")`, beside their siblings.
- src/ui/gui/gui-client-report.ts: append `(seriesHasBacklogLagMedian(d) ? block("Backlog lag median", chartBacklogLagMedian(d), "per day · filing to done") : "")` to the day-report block chain, beside the `Backlog items done` block.
- docs/cli.md: the `tumwater report` row names the new `Backlog lag median` line (per day, whole days from each finished entry's filing stamp to its done/fixed stamp, team report only).

**Tests.**
- test/backlog.test.ts: `entryLags` over a `## Done` fixture returns `{ done: "2026-10-04", lagDays: 3 }` for a heading `(planned 2026-10-01 …; done 2026-10-04)`; a heading with no filing stamp and one whose filing is after its done yield nothing; a `- ` epitaph bullet is read the same way; a wrapped heading whose stamp continues on the next line still pairs.
- test/report-data.test.ts: a `## Done`/`## Fixed` fixture with two entries completed the same day (lags 2 and 4) gives that day `backlogLagMedianDays === 2` (the lower median) and no other day; a completion with no filing stamp still counts toward `featuresDone` but leaves the day's median unset when it is the day's only completion; a role-scoped `collectReport` leaves every day unset.
- test/report.test.ts: `renderReportMarkdown` prints `**Backlog lag median:** <MM-DD> <N>d` for the day that carries one and omits the line when no day does, and on a role-scoped report.
- test/gui-client-report.test.ts: the day-report block chain contains the `seriesHasBacklogLagMedian`/`chartBacklogLagMedian` gate, and `seriesHasScalar(d, "backlogLagMedianDays")` is false for a lag-free series.

**Acceptance criteria.**
- A day on which a finished plan or bug that carries both stamps completed reports the lower median of those completions' filing-to-done spans in whole days as `backlogLagMedianDays`; a day with no such entry carries no field and the line is omitted (zero means absent).
- Entries with no filing stamp or a filing later than completion contribute nothing; `- ` epitaph bullets count like `### ` headings, matching the entry detection `featuresDone`/`bugsFixed` uses.
- The field and line are team-only: a role-scoped day report and `report --json --role <id>` carry no `backlogLagMedianDays`; the `--since` report is unchanged.
- The dashboard renders the `Backlog lag median` chart only when a day carries the field.
- The existing per-day lines render unchanged (their tests pass untouched); `npm run test:gate` passes.

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
