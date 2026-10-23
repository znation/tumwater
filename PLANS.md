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

### Write guard on Codex, part 1/9: List the paths an `apply_patch` text writes (planned 2026-10-23 by user; independent of every Planned entry; design in plans/codex-write-guard.md "The hook (parts 1–2)"; touches src/agent/codex/codex-patch-paths.ts (new) test/codex-patch-paths.test.ts (new))

**Goal.** The codex write guard has to know which files a patch writes before Codex applies it. Codex's PreToolUse payload carries the patch text, not a path (plans/codex-write-guard.md finding 4). This part adds the pure parser the hook will use; nothing calls it yet.

**Approach.**
- src/agent/codex/codex-patch-paths.ts (new): `patchWritePaths(patch: string): string[]`.
- It returns the path after each line that begins at column 0 with `*** Add File: `, `*** Delete File: `, `*** Update File: ` or `*** Move to: `, trimmed of trailing whitespace and `\r`, in order and without duplicates.
- Paths are kept as written. The caller resolves relative ones against the run's directory.
- Only a line starting exactly with `*** ` is a header. A hunk line (`+`, `-`, a space, `@@`) never counts, even when its text reads `*** Update File: …` after its prefix.
- A text without `*** Begin Patch` or `*** End Patch` is still scanned. A truncated patch still writes the files it names, so the guard must not trust the markers.

**Tests.** test/codex-patch-paths.test.ts:
- the live payload's patch, `*** Begin Patch\n*** Update File: /abs/repo/notes.md\n@@\n-primary\n+GUARD_TEST\n*** End Patch`, yields `["/abs/repo/notes.md"]`;
- one patch with an Add, a Delete, and an Update followed by `*** Move to: b/new.ts` yields all four paths in order;
- a hunk line `+*** Update File: evil.ts` is not counted;
- CRLF line endings and trailing spaces are stripped;
- a repeated path is listed once;
- empty text yields `[]`.

**Acceptance criteria.**
- `patchWritePaths` is pure: no filesystem and no imports beyond node built-ins.
- Every case above passes.
- `npm run test:gate` passes.

### Write guard on Codex, part 2/9: The PreToolUse hook refuses an `apply_patch` outside the run's worktree (planned 2026-10-23 by user; requires part 1/9 landed; design in plans/codex-write-guard.md "The hook (parts 1–2)" and findings 4–5; touches src/agent/codex/codex-write-guard.ts (new) src/agent/codex/write-guard-hook.ts (new) docs/invariants.md test/codex-write-guard.test.ts (new))

**Goal.** Add the hook a codex run will call before every `apply_patch`, deciding with the same rule pi, claude and OpenCode use (`strayWriteRefusal`, src/agent/write-guard.ts). This part only adds the hook; part 6/9 makes runs use it.

**Approach.**
- src/agent/codex/codex-write-guard.ts (new): `codexWriteRefusal(payload: unknown): string | null`.
  - It acts only when `tool_name` is `"apply_patch"` and `tool_input.command` is a string; anything else returns null.
  - The run's directory is the payload's `cwd`, which is Codex's session cwd. Every shell call is its own `zsh -lc`, so a `cd` cannot move it. With no `cwd`, it returns null.
  - For each path from `patchWritePaths(tool_input.command)`, in order, it returns the first non-null `strayWriteRefusal(path, cwd)`. A relative path resolves from `cwd`, as Codex resolves it.
- src/agent/codex/write-guard-hook.ts (new) is the entry codex runs, with no arguments:
  - it reads its stdin as JSON and calls `codexWriteRefusal`;
  - on a refusal it prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<refusal>}}` and a newline;
  - otherwise it prints nothing, and it exits 0 either way;
  - any failure of its own (bad JSON, a throw) prints nothing, so a broken hook lets the patch run and the stray-write warning in runner-run.ts still sees a stray write.
- **Why no argument naming the worktree,** unlike claude's hook: Codex trusts a hook by a hash of its whole definition (plans/codex-write-guard.md finding 3). A per-worktree argument would need a trust lookup per slot, while a command fixed per build needs one.
- Follow the doc-comment shape of src/agent/claude/claude-write-guard.ts and write-guard-hook.ts.
- docs/invariants.md: under "Write guard", add the next free `INV-CW` id (INV-CW4 if still free: check `grep -n '^### INV-CW' docs/invariants.md` first). It is "a codex `apply_patch` to a path under the team root but outside the payload's cwd checkout is denied with `strayWriteRefusal`'s text, and the hook prints nothing for any other call or for input it cannot read", pinned by the tests below.

**Tests.** test/codex-write-guard.test.ts, with the same team fixture as test/write-guard.test.ts (a root, `_slot-1` as the worktree, `_slot-2` as another):
- an Update of `<root>/src/a.ts` from `cwd: <wt>` is refused, and the reason names `<wt>/src/a.ts`;
- an Update of `src/a.ts` (relative) passes;
- a patch whose `*** Move to:` leaves the worktree is refused;
- `tool_name: "Bash"` returns null, and so does a payload with no `cwd`;
- the compiled hook, spawned as `node dist/src/agent/codex/write-guard-hook.js` with a stray payload on stdin, prints the deny JSON and exits 0;
- the same with an in-worktree payload prints nothing and exits 0;
- with `not json` on stdin it prints nothing and exits 0.

**Acceptance criteria.**
- The hook's output for a refused patch parses as the JSON above, with `permissionDecisionReason` equal to `strayWriteRefusal`'s text.
- No path is refused when the payload names no `cwd`.
- `npm run test:gate` passes.

### Write guard on Codex, part 3/9: The hook's definition and its two `-c` flags, and `hooks` keys reserved from the passthrough (planned 2026-10-23 by user; requires part 2/9 landed; design in plans/codex-write-guard.md "The flags (part 3)" and findings 1–2; touches src/agent/codex/codex-write-guard.ts src/agent/codex/codex-args.ts src/config/config-validation.ts test/codex-write-guard.test.ts test/codex-args.test.ts test/config-validation.test.ts)

**Goal.** Build the exact `-c` values that install the hook and trust it, without wiring them into runs yet. Make sure an operator's `backends.codex.args` cannot replace either.

**Approach.**
- src/agent/codex/codex-write-guard.ts gains three exports:
  - `codexWriteGuardDefinition(nodeBin = process.execPath)` returns `{ matcher: "^apply_patch$", command, timeout: 30 }`. `command` is `n=<nodeBin quoted>; [ -x "$n" ] || n=node; exec "$n" <hook quoted>`, built like claude-write-guard.ts's `writeGuardSettings`. The hook path comes from `fileURLToPath(new URL("./write-guard-hook.js", import.meta.url))`, so a staged build runs its own copy.
  - `codexHookArg(definition)` returns the value `hooks.PreToolUse=[{matcher=<s>,hooks=[{type="command",command=<s>,timeout=30}]}]`.
  - `codexHookTrustArg(trust: { key: string; hash: string })` returns `hooks.state={<key>={trusted_hash=<hash>}}`, in the inline-table spelling. The dotted `hooks.state."<key>".trusted_hash=` spelling is ignored by Codex because the key contains dots (finding 2).
  - One `tomlString(s)` helper writes every TOML basic string, escaping `\`, `"` and control characters.
- Reserve `hooks`: a `-c`/`--config` passthrough whose key is `hooks` or starts with `hooks.` is refused. Codex is last-wins, so it could otherwise replace the guard or its trust.
  - Add a prefix rule beside `HARNESS_CODEX_CONFIG_KEYS` in codex-args.ts, for example `HARNESS_CODEX_CONFIG_KEY_PREFIXES = ["hooks"]` and an `isHarnessCodexConfigKey(key)` that both screens call.
  - The screens are config-validation.ts's `checkCodexConfigKeys` and any check codexArgs makes on its passthrough.
  - The problem text names the key as the existing one does ("…passes the config key hooks.PreToolUse, which tumwater manages — drop it or use another key").

**Tests.**
- test/codex-write-guard.test.ts:
  - `codexHookArg` and `codexHookTrustArg` produce the exact strings for a fixed definition and trust;
  - a `nodeBin` and hook path containing `'`, `"` and a space round-trip: the definition's `command` run through `sh -c` with a stray payload on stdin still prints the deny JSON;
  - `tomlString` escapes `\`, `"` and a control character.
- test/codex-args.test.ts: `isHarnessCodexConfigKey` is true for `hooks`, `hooks.PreToolUse` and `hooks.state` and false for `hooksy` and `model_provider`. The existing reserved keys stay true.
- test/config-validation.test.ts: `backends.codex.args` of `["-c", "hooks.PreToolUse=[]"]`, `["--config=hooks.state={}"]` and `["-c", "hooks={}"]` each report the key. `["-c", "model_provider=\"x\""]` still passes.

**Acceptance criteria.**
- Nothing in a run's argv changes in this part.
- The three passthrough spellings above are refused at config validation.
- `npm run test:gate` passes.

### Write guard on Codex, part 4/9: Ask codex for the hook's trust key and hash through `hooks/list`, and cache them per build and Codex version (planned 2026-10-23 by user; requires part 3/9 landed; design in plans/codex-write-guard.md "Trust (parts 4–5)" and finding 3; touches src/agent/codex/codex-hook-trust.ts (new) src/paths.ts test/fakes/fake-codex.ts docs/invariants.md test/codex-hook-trust.test.ts (new))

**Goal.** Codex runs a session-flag hook only with the right `trusted_hash`. The hash is opaque: no simple digest of the definition matched (finding 3). So tumwater asks Codex for it, once per build and Codex version.

**Approach.**
- src/agent/codex/codex-hook-trust.ts (new): `lookupCodexHookTrust({ bin, env, cwd, definition, timeoutMs = 15_000 }): Promise<{ key: string; hash: string }>`.
  - It spawns `<bin> -c <codexHookArg(definition)> app-server` in `cwd` with `env`, using the harness's own spawn helper with process-group kill. It kills the group when done, on timeout and on error.
  - Over stdio, one JSON object per line, it sends `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"tumwater","version":<tumwater version>}}}`, then `{"jsonrpc":"2.0","method":"initialized"}`, then `{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":[cwd]}}`.
  - It reads the reply to id 2 and returns the first hook in `result.data[*].hooks` with `source: "sessionFlags"`, `eventName: "preToolUse"` and `command` equal to `definition.command`, giving `{ key, hash: currentHash }`. It never hardcodes the key, which was `/<session-flags>/config.toml:pre_tool_use:0:0` on 0.163.0.
  - It rejects on timeout, on child exit before the reply, on a JSON-RPC error, and on "codex listed no session-flag PreToolUse hook with this command". It needs no login and makes no model request (verified with an empty `CODEX_HOME`).
- `codexHookTrust({ root, bin, env, cwd, definition })` caches in `codexHookTrustPath(root)` (new in src/paths.ts: `.tumwater/state/codex-hook-trust.json`).
  - The cache key is the trimmed output of `<bin> --version` plus `JSON.stringify(definition)`, each entry `{ key, hash, checkedAt }`.
  - A hit returns without spawning `app-server`. A miss looks up and writes the entry through `writeJsonAtomic`.
  - With `root` undefined (a hand run with no `.tumwater` root) it looks up and caches nothing. It never creates a `.tumwater` directory: a hand run once minted a phantom `$TMPDIR/.tumwater` and reddened every suite on the host (plans/codex-write-guard.md "Visibility").
- test/fakes/fake-codex.ts: the shim answers `app-server`.
  - It reads the JSON-RPC lines and answers `initialize` with `{}` and `hooks/list` with one sessionFlags preToolUse hook whose `command` is parsed from the `-c hooks.PreToolUse=` argument and whose `currentHash` is `sha256:` plus the sha256 of that command.
  - It appends each app-server start to a calls file the test can count. A test switch makes it hang, for the timeout case.
- docs/invariants.md: the next free `INV-CW` id. It is "the trust key and hash come from Codex's own `hooks/list` for the exact definition, are cached per Codex version and definition, and a lookup that times out leaves no child behind", pinned by the tests below.

**Tests.** test/codex-hook-trust.test.ts, on the fake:
- a lookup returns the fake's key and `sha256:` hash;
- a second `codexHookTrust` with the same version and definition starts no `app-server` (the calls file has one line);
- a changed `timeout` or a changed `--version` output looks up again;
- a hanging fake rejects within `timeoutMs` (set to 500 ms in the test), and the child's pid is gone afterwards;
- a fake whose list holds no matching hook rejects with the message above;
- `root` undefined writes no file.

**Acceptance criteria.**
- No Codex run's argv changes yet, and no code path calls the lookup outside the tests.
- `npm run test:gate` passes.

### Write guard on Codex, part 5/9: An async `prepare` step on agent backends; codex's resolves the guard's trust before a run (planned 2026-10-23 by user; requires part 4/9 landed; design in plans/codex-write-guard.md "Trust (parts 4–5)"; also edited by the open Codex backend parts 8/9 and 9/9 in other functions of src/agent/codex/codex-backend.ts, so whichever lands later rebases; touches src/agent/agent-backend.ts src/agent/run-agent.ts src/agent/codex/codex-backend.ts test/agent-backend.test.ts test/codex-run.test.ts)

**Goal.** `AgentBackend.invocation()` is synchronous, but the trust lookup spawns `codex app-server`. Resolve it in an awaited step before the invocation is built, without blocking the event loop and without one `app-server` per run.

**Approach.**
- src/agent/agent-backend.ts: `AgentBackend` gains optional `prepare?(run: AgentRunSpec): Promise<void>`, documented as "work the invocation needs that cannot be synchronous; never throws a run away".
- src/agent/run-agent.ts: right before `backend.invocation(runSpec)` (today around line 304), `await backend.prepare?.(runSpec)` inside a try/catch. A throw is logged as a `warning` (source `tumwater`) through `logEventBestEffort` on the run's root (`nearestTumwaterRoot(opts.sessionDir)`, skipped with no root), and the run continues.
- src/agent/codex/codex-backend.ts: `prepare(run)` resolves the guard's trust for `codexWriteGuardDefinition()` under the run's codex env (`CODEX_HOME` as `invocation` computes it).
  - It goes through `codexHookTrust` with `root = nearestTumwaterRoot(run.sessionDir)` and `cwd = run.cwd`.
  - It is single-flight: one in-flight promise per process per (home, definition), shared by concurrent runs.
  - The result is a module-level state that `invocation` reads synchronously: `{ trust }` or `{ off: reason }`.
  - A failed lookup records `off` and logs one `warning` per process per (home, definition): `codex write guard off: <reason>`.
- Nothing uses the stored trust yet. This part only warms it, so a codex run now starts one `app-server` per new build and Codex version, and none on a cache hit.

**Tests.**
- test/agent-backend.test.ts (or a run-agent test beside it): a backend whose `prepare` throws still spawns its run and logs one warning; a backend without `prepare` behaves as before.
- test/codex-run.test.ts, on the fake:
  - two codex runs started together start one `app-server`;
  - a hanging `app-server` lets both runs start after the bounded wait and logs `codex write guard off:` once across three runs;
  - a pi run and a claude run start no `app-server`.

**Acceptance criteria.**
- No backend's argv changes.
- A failing lookup never fails or delays a run beyond the 15 s bound.
- `npm run test:gate` passes.

### Write guard on Codex, part 6/9: Codex runs carry the trusted write-guard hook (planned 2026-10-23 by user; requires part 5/9 landed; design in plans/codex-write-guard.md "Runs (part 6)" and findings 1, 2 and 5; also edited by the open Codex backend parts 8/9 and 9/9 in other functions of src/agent/codex/codex-backend.ts; touches src/agent/codex/codex-args.ts src/agent/codex/codex-backend.ts docs/invariants.md test/codex-args.test.ts test/codex-run.test.ts)

**Goal.** Turn the guard on. A codex run whose `apply_patch` would land under the team root but outside its worktree is refused with the shared refusal, as pi, claude and OpenCode runs are.

**Approach.**
- src/agent/codex/codex-args.ts: `CodexArgOptions` gains `guardArgs?: string[]`. codexArgs inserts it after the harness's own `-c` keys and before `-m`, on fresh and resumed (`exec resume`) runs alike. The passthrough cannot override it, because part 3/9 reserved `hooks`.
- src/agent/codex/codex-backend.ts: `invocation` reads the state `prepare` stored.
  - With `{ trust }` it passes `guardArgs: ["-c", codexHookArg(definition), "-c", codexHookTrustArg(trust)]`.
  - With `{ off }`, or no state, it passes neither. An untrusted hook would be skipped silently anyway.
  - It never passes `--dangerously-bypass-hook-trust`. That flag would run the target repo's own `.codex` hooks unreviewed and add an `error` item to every run's stream (findings 1 and 4).
- docs/invariants.md: the next free `INV-CW` id. It is "a codex run carries the guard's hook and its trust entry together or neither, and never `--dangerously-bypass-hook-trust`", pinned by the tests below.

**Tests.**
- test/codex-args.test.ts: `guardArgs` lands between the last harness `-c` and `-m` for both a fresh and a resumed run, and is absent when unset.
- test/codex-run.test.ts, on the fake:
  - a fresh run and a resumed run each carry both `-c` values with the fake's key and hash;
  - with the lookup failing, neither appears;
  - no argv ever contains `--dangerously-bypass-hook-trust`.

**Acceptance criteria.**
- With trust available, every codex run's argv carries the hook and its trust; without it, the argv is exactly today's.
- The codex stream translator is unchanged: a blocked patch adds no stream item (finding 5).
- `npm run test:gate` passes.

### Write guard on Codex, part 7/9: Codex's prompt dialect sends file edits through `apply_patch` (planned 2026-10-23 by user; requires part 6/9 landed; design in plans/codex-write-guard.md "Coverage (part 7)" and finding 6; touches src/prompt/dialect.ts test/prompt-dialect.test.ts)

**Goal.** The guard sees only `apply_patch`. plans/codex-backend.md's probes saw codex models edit through the shell (`printf >>`) unless the prompt asked for `apply_patch`, so ask for it.

**Approach.**
- src/prompt/dialect.ts: `CODEX_DIALECT.backendRules` gains one rule: "Edit and create files with the `apply_patch` tool, not shell redirection (`>`, `>>`, `tee`) or `sed -i`."
- Update the `CODEX_DIALECT` doc comment to say why: the write guard checks only `apply_patch` (plans/codex-write-guard.md).

**Tests.** test/prompt-dialect.test.ts:
- a codex run prompt contains the rule exactly once;
- the pi, claude and OpenCode run prompts do not contain it;
- the codex prompt's other backend rule (the `write_stdin` polling rule) is still present.

**Acceptance criteria.**
- Only codex prompts change, by exactly that rule.
- `npm run test:gate` passes.

### Write guard on Codex, part 8/9: Doctor's codex group reports whether codex runs carry the write guard (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)"; touches src/doctor/doctor-model-checks.ts test/doctor-model-checks.test.ts)

**Goal.** An operator can see from `tumwater doctor` whether codex edits are guarded, and why not when they are not.

**Approach.**
- src/doctor/doctor-model-checks.ts: in the codex check group Codex backend part 9/9 adds (shown when any job routes to codex), add a `write guard` row.
- The row runs `codexHookTrust` for the run env's home and the current build's definition, bounded at 10 s like the group's other Codex calls.
  - pass: `trusted (sha256:<first 12 hex>)`;
  - warn: `off: <reason> — codex runs edit without the worktree check`.
- Doctor stays read-only apart from the cache file, which `codexHookTrust` already writes.

**Tests.** test/doctor-model-checks.test.ts, on the fake:
- a fake that lists the hook gives the pass row with the hash prefix;
- a fake whose list is empty gives the warn row naming the reason;
- a pi-only team shows no codex group, so no row.

**Acceptance criteria.**
- Both rows render as above.
- `npm run test:gate` passes.

### Write guard on Codex, part 9/9: The live `smoke:codex` step for the guard, and the docs (planned 2026-10-23 by user; requires part 6/9 and Codex backend 9/9 landed; design in plans/codex-write-guard.md "Visibility (parts 8–9)" and "Risks"; touches scripts/smoke-codex.mjs docs/how-it-works.md docs/backends.md plans/codex-backend.md)

**Goal.** After a Codex upgrade, one live command proves the guard still blocks. Session-flag trust could stop working while the `hooks/list` lookup still succeeds ("Risks"). The docs should say which backends are guarded and how.

**Approach.**
- scripts/smoke-codex.mjs (added by Codex backend part 9/9) gains a `write guard` step.
  - Build a throwaway team layout: a git repo `<T>/repo`, its worktree `<T>/repo/.tumwater/worktrees/_slot-1`, and the same `notes.md` text in both. Keep the session dir under `<T>/repo/.tumwater/sessions`, never outside a `.tumwater` root.
  - Run the production invocation through `runAgent`, asking the model to use `apply_patch` to change `notes.md` at the primary's absolute path, and to follow any refusal.
  - Assert three things: the primary's `notes.md` is unchanged, the worktree's `notes.md` changed, and the run's rollout holds "blocked by PreToolUse hook".
  - The step is listed by the script's `--help`/dry-run.
- docs/how-it-works.md, "A run" step 2: the guarded tools name codex's `apply_patch`, through a trusted hook. Shell writes stay unchecked on every backend.
- docs/backends.md, Codex section:
  - the guard is a PreToolUse hook passed with `-c`, trusted through the same session-flag layer with the hash Codex reports;
  - `codex-hook-trust.json` caches the hash;
  - `--dangerously-bypass-hook-trust` is never used.
- plans/codex-backend.md: under "never passes `--dangerously-bypass-hook-trust`", add one sentence: tumwater trusts only its own write-guard hook, through the session-flag layer (plans/codex-write-guard.md).

**Tests.** None beyond the script's dry-run listing. The live step runs by hand: `npm run smoke:codex`.

**Acceptance criteria.**
- `npm run smoke:codex -- --help` (or the script's dry-run flag) lists the `write guard` step.
- The docs name codex among the guarded backends and its `apply_patch`-only coverage.
- `npm run test:gate` passes.

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
