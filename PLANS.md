# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Dashboard History gains a Newest failure button that opens the team's newest failing run, the `history --last --result problems` twin (planned 2026-10-20 by the plan role; independent of every eligible plan: the TUI Inbox `/` search plan and the TUI Transcript change step Ctrl+Y plan change only src/ui/tui, src/inbox and docs/cli.md's TUI keys table. This plan changes only src/ui/gui/gui-client-history.ts, test/gui-client-history.test.ts, docs/how-it-works.md and docs/cli.md's History row. Touches src/ui/gui/gui-client-history.ts test/gui-client-history.test.ts docs/how-it-works.md docs/cli.md)

**Refused 2026-10-21 by feature: the finished plan kept being rejected for landing in the archive (PLANS-DONE.md) instead of PLANS.md's ## Done, the review chain hit its cap, and tumwater's rejection directs not to re-author this theme**

**Goal.** `tumwater history --last --result problems` opens the team's newest failing run in one command (PLANS-DONE.md "`history <role> --last --result <class>[,…]`"), and `GET /api/run?last=1&result=problems` with no role serves exactly that run (PLANS-DONE.md "`GET /api/run?last=1` with no role…", whose own text says "A dashboard button that uses it is a separate, later plan"). The dashboard's History view has Summary / By model modes, an outcome filter, and a per-row drill-down, but no way to jump to the newest failure: the operator must guess the role and scroll. Add a **Newest failure** button that opens that run's detail card above the table, regardless of the current role, window or count. It is the dashboard twin of the CLI command and the last missing consumer of the role-less `last` endpoint.

**Approach.** Everything below is in src/ui/gui/gui-client-history.ts unless named otherwise.
1. Toolbar: in `buildHistoryView`, add `<button type='button' class='btn btn-sm' id='histnewest'>Newest failure</button>` immediately before the `#histrefresh` button, and wire `$("histnewest").addEventListener("click", () => openHistNewest());` beside the refresh listener.
2. State and fetch, all inside the `// history-detail:start` … `// history-detail:end` region (so `clientScope` over `HISTORY_REGIONS` reaches them):
   - Add `let histNewest = null;` beside `const histDetails = new Map();`.
   - `async function openHistNewest()`: set `histNewest = { state: "loading" }`, call `renderHistory()`; `const d = await getJson("/api/run?last=1&result=problems")`; reject a body without a string `text` or string `role` with the same "answered … without a text field" sentence the drill-down fetch uses, naming the endpoint and the run; then `const key = histDetailKey(d.role, d.run)`, `histDetails.set(key, { state: "ok", text: d.text, stat: typeof d.stat === "string" ? d.stat : "", revertSha: typeof d.revertSha === "string" ? d.revertSha : null, hasCommit: d.hasCommit === true })`, and `histNewest = { state: "ok", key }`. Catch → `histNewest = { state: "error", message: err && err.message ? err.message : "Newest failure unavailable" }`. Always end with `renderHistory()`. (The entry's real `role#run` key is what makes the card's own patch/transcript/revert buttons work: `toggleHistPatch`, `toggleHistTranscript`, `searchHistTranscript` and `histRevertStep` all look the entry up with `histDetails.get(key)` and parse the role and run back out of that key, exactly as they do for a row card.)
   - `function closeHistNewest()`: `histNewest = null; renderHistory();`
   - `function histNewestHtml()`: return `""` when `histNewest` is null; for `state: "loading"` return `<div class='empty'>Loading newest failure…</div>`; for `state: "error"` return `<div class='empty'><strong>Newest failure unavailable</strong>` + `esc(histNewest.message)` + `</div>`; for `state: "ok"` return `<div class='hist-newest'><div class='hist-detail-head mono'>Newest failure of any role <button type='button' class='btn btn-sm' data-hist-newest-close='1' title='Close'>×</button></div>` + `histDetailCardHtml(histDetails.get(histNewest.key), histNewest.key)` + `</div>`. Reuse the existing `hist-detail` / `hist-detail-head` classes so no CSS change is needed.
3. Render: change `renderHistory`'s innerHTML line to `body.innerHTML = historyNoteHtml(histNote) + historyStepHtml(histSinceKey, histStep) + histNewestHtml() + bodyHtml;`, so the pinned card sits above the window note's table.
4. Close and reset: add one more `$("histbody")` delegated click listener for `button[data-hist-newest-close]` that calls `closeHistNewest()`. In `fetchHistory`, set `histNewest = null;` beside `histDetails.clear();` so a refresh or a role/window/count change drops the pinned card together with the drill-down cache, like the row cards.
5. Docs: docs/how-it-works.md, in the dashboard History drill-down paragraph (the one that ends with the `GET /api/history?result=` sentence), add: "A Newest failure button opens the newest failing run of any role through `GET /api/run?last=1&result=problems`, the run `tumwater history --last --result problems` opens, as a card above the table." docs/cli.md, end of the "Watch run history" row: after "clicking a model in By model lists its runs, the `--model` twin" add "; its Newest failure button opens the newest failing run of any role, the `history --last --result problems` twin".

**Acceptance criteria.**
- test/gui-client-history.test.ts, new test "the Newest failure button loads the newest failing run as a pinned card": a `clientScope` over `HISTORY_REGIONS` exposing `openHistNewest`, `histNewest`, `histDetails`, `histNewestHtml`, `closeHistNewest`, with a recording `getJson` answering `{ role: "clean", run: 9, text: "clean run #9 — problems · 46s\nevent one", stat: " a.ts | 2 +-", revertSha: null, hasCommit: true }` and a `renderHistory` stub. Before the call `histNewestHtml()` is `""`. `openHistNewest()` synchronously makes `histNewest.state === "loading"` and the html match `/Loading newest failure/`. After `await sleep(0)`, the sole call is `/api/run?last=1&result=problems`, `histNewest.state === "ok"`, `histDetails.get("clean#9").state === "ok"`, and the html matches `/Newest failure of any role/`, `/event one/`, `/hist-detail-stat/` + `/a\.ts \| 2 \+-/`, `/data-hist-patch='clean#9'/` and `/data-hist-newest-close='1'/`. `closeHistNewest()` sets `histNewest` null and the html back to `""`.
- Same file, new test "a Newest failure miss renders the server's message instead of a stuck loading state": `getJson` rejects with `Error('no completed run with result "problems" in the scanned window (the retained log may have rotated past it)')`; after `await sleep(0)` `histNewest.state === "error"` and `histNewestHtml()` matches `/Newest failure unavailable/` and the message and not `/Loading newest failure/`.
- Same file, the toolbar test: `GUI_CLIENT_HISTORY_JS` contains `id='histnewest'` with the label `Newest failure`, and wires its click to `openHistNewest` (`/id='histnewest'[\s\S]*?openHistNewest/`).
- Same file, extend the whole-blob `historyFetchScope` harness (or a sibling) to also return `histNewest`, and assert `fetchHistory(false)` resets a previously set `histNewest` to null. (The harness runs the served blob with injected `getJson`/`renderHistory`; set `histNewest = { state: "error", message: "x" }` through returned state, then `await scope.fetchHistory(false)`.)
- The existing History tests pass unchanged: the drill-down toggle/caching tests, `histDetailCardHtml`, `fetchHistory`, and the toolbar/search persistence tests. `npm run test:gate` is green.

### Codex backend, part 2b/9: Window events are `subscription_window_*` with a `backend`, and the reserve is `backends.<id>.windowReserve` (planned 2026-10-21 by the plan role; requires part 1/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/events/events.ts src/events/event-legacy.ts src/events/event-labels.ts src/events/event-format.ts src/events/notify.ts src/team/team-polls.ts src/gates/gate-polls.ts src/orchestrator/orchestrator.ts src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts docs/config.md and their tests)

**Goal.** The four window events are named for claude and carry no backend, and the only reserve key is the top-level `claudeWindowReserve`. Rename them to `subscription_window_{warning,reserved,limited,reset}`, each with a `backend: string` field ("claude" today), and let `backends.<id>.windowReserve` hold a reserve while `claudeWindowReserve` keeps working as claude's older spelling. `windowReserveFor(config, backend)` reads both. No behavior change for a claude-only team. The TUI and GUI reserve editors and `config-editable-keys` are deliberately untouched — `claudeWindowReserve` stays a valid editable key and those editors keep writing it, so this rename does not span them.

**Approach.**
- src/events/events.ts: rename the union members (keeping their payload comments) and add `backend: string` to each. src/events/event-labels.ts and src/events/event-format.ts label from that backend ("Claude" now). src/events/event-legacy.ts's `normalizeLegacyEvent` maps each old `claude_window_*` name to its new one with `backend: "claude"`. src/events/notify.ts pages on the new names.
- Emitters add `backend: "claude"` and use the new names: src/team/team-polls.ts (`claude_window_limited`/`_reset`, `pollClaudeWindowReserve`'s `claude_window_reserved`, `pollClaudeWindowWarning`'s `claude_window_warning`) and src/gates/gate-polls.ts. `loggedWindowKeys` (src/team/team-polls.ts) takes the `backend` beside the type and keys by `backend:type:resetsAt`; src/orchestrator/orchestrator.ts reads both per backend.
- Config: `BackendConfig` (src/config/config-schema.ts) gains `windowReserve?: Record<string, number>` and `CLAUDE_AGENT_KEYS` gains `"windowReserve"` — claude only now (part 4/9 adds it for codex), so pi and opencode still refuse it as an unknown key. src/config/config-validation.ts validates it with the same `0 < f <= 1` rule as `claudeWindowReserve`; setting both `claudeWindowReserve` and `backends.claude.windowReserve` is a load error naming both. src/config/config-views.ts exports `windowReserveFor(config, backend)`: `backends[backend].windowReserve`, else `claudeWindowReserve` when `backend === "claude"`, else undefined.
- docs/config.md: `backends.<id>.windowReserve`, with `claudeWindowReserve` as its claude-only older spelling.

**Acceptance criteria.**
- test/notify.test.ts, test/event-format-team.test.ts, test/gate-polls.test.ts and test/team-polls.test.ts pass with the new names and the added `backend`.
- `normalizeLegacyEvent({ type: "claude_window_limited", … })` yields `subscription_window_limited` with `backend: "claude"`; `tumwater logs --type claude_window_limited` still finds old lines.
- `backends.claude.windowReserve: { "seven_day": 0.8 }` behaves exactly as `claudeWindowReserve` did; both set is a load error; `backends.pi.windowReserve` is refused as an unknown key.
- `windowReserveFor` reads the nested claude key, falls back to `claudeWindowReserve`, and returns undefined for a backend with neither.
- `npm test` passes.

### Codex backend, part 2c/9: Budget gates, holds, the reserve and the window moves read each subscription backend's own account (planned 2026-10-21 by the plan role; requires parts 2a/9 and 2b/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/gates/budget-gates.ts src/gates/gate-polls.ts src/team/team-polls.ts src/orchestrator/orchestrator.ts and their tests)

**Goal.** Every window decision — a job moving down its chain, the director's move, the handback, the reserve and the subscription-window hold — works for any backend that reports a subscription. Today each is keyed to claude by `pairIsClaude`/`seamIsClaude` (src/gates/budget-gates.ts), the observation's `provider: "claude"` (src/team/team-polls.ts `claudeWindowObservation`) and one `windowOut` (src/gates/budget-gates.ts). With part 2a/9 (the account lookup) and part 2b/9 (the event `backend` and `windowReserveFor`) landed, no signature or event work is left. This is the state-machine half the feature role split out of part 2/9. No behavior change for a claude-only or pi-only team.

**Approach.**
- src/gates/budget-gates.ts:
  - `pairIsClaude` / `seamIsClaude` become `subscriptionBackendOf(pair | seam, accounts)`: the backend id whose account bills a subscription, else null.
  - `windowOut` and `directorWindowOut` become maps keyed by that backend id, and `windowMove` is "any entry stands and a fallback pair exists". The availability test, the pinned-role and reviewer rescue, `windowTiers`/`movedTiers` and `directorMoved` each read the job's or seam's own backend.
  - `chainInfo`'s `windowOut`/`account` parameters become the maps and the lookup, so its `"window"`/`"reserve"` reasons come from the step's backend. The `extraUsage` position rule and the `"overage"` reason stay claude-only.
- src/gates/gate-polls.ts: `claudeWindowWarned`/`claudeWindowReserved` become per-backend maps (a persisted old state reads `{ claude: … }`); `windowMovedRoles` uses `subscriptionBackendOf`; the poll reads each backend in `backendsInUse(config)` with `readAccount`, calls the reserve and warning polls per backend with `windowReserveFor(liveConfig, backend)`, and the window handback (`budget_handback`, reason `window`) gains `backend`.
- src/team/team-polls.ts: `claudeWindowObservation(account, now, reserve)` becomes `windowObservation(backend, account, now, reserve)` with `role` and `provider` set to `backend`; `pollTeamHold` receives one observation per subscription backend in use and stamps the limited event's `backend`. The `subscription-window` hold kind and `seamHoldKey` already key a non-pi backend by its id.
- src/orchestrator/orchestrator.ts: the `loggedWindowKeys` reads are per backend (part 2b/9 already keyed them).
- Replace the direct `liveConfig.claudeWindowReserve` reads in src/gates/budget-gates.ts, src/gates/gate-polls.ts and src/team/team-polls.ts with `windowReserveFor(liveConfig, backend)`.

**Acceptance criteria.**
- The existing tests pass with only their event-name/`backend` and account-shape expectations updated: test/budget-gates.test.ts, test/budget-chain-info.test.ts, test/gate-polls.test.ts, test/team-polls.test.ts, test/notify.test.ts, test/event-format-team.test.ts and test/orchestrator-budget.e2e.test.ts.
- A test registers a fake subscription backend `sub` whose account reports a rejected `five_hour` window. Then its jobs move to their fallback; a hold keyed `sub` is placed; `subscription_window_limited { backend: "sub" }` is logged once; claude jobs, and claude's account, are untouched.
- A test with claude's account rejected and `sub`'s healthy moves only claude's jobs, and the reverse moves only `sub`'s — one window per backend, not one shared window.
- `grep -n 'seamIsClaude\|pairIsClaude' src` prints nothing, and no `claudeWindowReserve` read remains in src/gates or src/team.
- `npm test` passes.

### Codex backend, part 3/9: Window displays name each subscription backend (planned 2026-10-20 by user; requires part 2c/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/status/status-budget.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-operator.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts src/roles/role-view.ts src/roles/role-render.ts src/report/report-render.ts src/doctor/doctor-holds.ts src/doctor/doctor.ts docs/backends.md and their tests)

**Goal.** Show each subscription backend's windows under that backend's name, so a team with Claude and Codex both on subscriptions shows both. Today every surface prints one `claudeWindow` block labelled "Claude 5h": `claudeWindowBlock` (src/status/status-budget.ts), `claudeWindowBadge` (src/ui/badges.ts), the GUI tile (src/ui/gui/gui-client-operator.ts), the role view's billing line and "Claude window used up" (src/roles/role-render.ts), the report's "claude subscription, API-equivalent" line (src/report/report-render.ts), and doctor's "claude window" row (src/doctor/doctor-holds.ts `checkClaudeWindow`). A claude-only team's output is unchanged, apart from the JSON key added below.

**Approach.**
- src/status/status-budget.ts: `claudeWindowBlock` becomes `windowBlocks(slice, accounts)`, with one block per subscription backend in use, each `{backend, label, …today's fields}`. The `s.agent === "claude"` tests become "the job's backend is this block's".
- `status --json` (src/ui/status-payload.ts, src/status/status-data.ts): a new `subscriptionWindows` list. `claudeWindow` stays as the claude entry for one release, with a doc comment saying so.
- src/ui/badges.ts: the badge text comes from the block's label ("Claude 5h · 64%", "Codex 7d · 31%"). The hold text reads "<label> model jobs wait". With two blocks, the badge shows the one nearest its limit (today's rule, now across backends) and the tile lists all of them. src/ui/status-render.ts and src/ui/gui/gui-client-operator.ts follow.
- Role view (src/roles/role-view.ts, role-render.ts): `claudeInPlay` becomes "the job's backend has an account". The billing line and "window used up" name the backend.
- Report (src/report/report-render.ts): "<label> subscription, API-equivalent: $X", one line per backend with notional spend.
- Doctor: `checkClaudeWindow` becomes `checkSubscriptionWindows`. It produces one row per subscription backend in use, named "<id> window". The "claude window" row name is kept for claude.
- The TUI reserve editor (src/ui/tui/tui-editor-claude-reserve.ts) and the GUI settings label (src/ui/gui/gui-client-settings.ts) say "Claude window reserve (backends.claude.windowReserve)".
- docs/backends.md: the window display paragraph says it is per backend.

**Acceptance criteria.**
- Every existing badge, status, role-view, report and doctor-holds test passes. Their claude-only text is unchanged; a JSON assertion may add `subscriptionWindows`.
- With a fake second subscription backend `sub` labelled "Sub" whose account has `seven_day` at 40%:
  - `status --json` lists two `subscriptionWindows` entries;
  - the TUI badge shows the claude window when it is the nearer one, and "Sub 7d · 40%" when it is;
  - doctor prints a "sub window" row.
- `npm test` passes.

### Codex backend, part 4/9: `codex` becomes a backend id, with `backends.codex`, tier defaults, the effort mapping, reserved flags and traits (planned 2026-10-20 by user; requires part 2c/9 landed; design in plans/codex-backend.md "Config and routing" and "CODEX_HOME and sessions"; touches src/config/config-schema.ts src/config/model-selector.ts src/config/config-validation.ts src/agent/backend-traits.ts src/agent/codex/codex-args.ts (new) src/doctor/doctor-model-checks.ts docs/config.md and their tests)

**Goal.** Make `codex` a valid backend wherever config is read: `backend: "codex"` beside a `model`, a top-level `backend: "codex"`, and `backends.codex` with `bin`, `args`, `configDir` and `windowReserve`. There is no adapter yet (part 7/9). The startup gate's existing rule ("backend X is configured but this build has no adapter for it") refuses a team that routes a job to codex until then.

**Approach.**
- src/config/config-schema.ts:
  - `BACKEND_IDS` gains `"codex"`.
  - `CODEX_BACKEND_KEYS` is `[...BACKEND_KEYS, "configDir", "windowReserve"]`, and validation picks the key list per backend. `configDir` has claude's rule: a leading `~` expands, and the value must be absolute after expansion.
  - The `BackendConfig.configDir` doc comment says it becomes `CODEX_HOME` on codex.
- src/config/model-selector.ts: `BACKEND_DEFAULT_MODELS.codex` is `{ small: "gpt-6-luna", default: "gpt-6.1-sol", strong: "gpt-6-astra" }` (design decision 4). A comment names the catalog descriptions they come from (design finding 14).
- src/agent/codex/codex-args.ts (new) holds only two things in this part:
  - `HARNESS_CODEX_FLAGS`: the flags listed in design §2 "Reserved passthrough flags".
  - `HARNESS_CODEX_CONFIG_KEYS`: `model`, `model_reasoning_effort`, `sandbox_mode`, `project_doc_fallback_filenames`, `web_search`, `agents.enabled`, `check_for_update_on_startup`, `analytics.enabled`, `feedback.enabled`, `history.persistence`. A `-c <key>=…` or `--config <key>=…` passthrough whose key is one of these is refused.
  - Part 5/9 adds the builder beside them.
- `EFFORT_BY_THINKING` lives in codex-args.ts: `off` and `minimal` → `low`; `low`, `medium`, `high`, `xhigh` and `max` pass. `ultra` is not a value it can produce.
- src/agent/backend-traits.ts: a `codex` entry.
  - `streamsToolOutput` false.
  - `usesPiModels` false.
  - `reservedPassthroughFlag` uses `HARNESS_CODEX_FLAGS`, plus the config-key check, with the reason "it is managed by tumwater".
  - `modelLabel` gives the bare model, or "codex default".
- src/config/config-validation.ts: the `-c` key check above, with the message naming the arg and the key.
- src/doctor/doctor-model-checks.ts: codex jobs skip the models.json lookup, as claude and opencode do.
- docs/config.md:
  - `backend` accepts `"codex"`, and `backends` is keyed by `pi`, `claude`, `opencode` or `codex`.
  - `backends.codex.configDir` is the Codex home, which needs one `CODEX_HOME=<dir> codex login`.
  - `backends.codex.windowReserve` is the reserve.

**Acceptance criteria.**
- `routeModel`:
  - `{ backend: "codex", model: "gpt-6.1-sol" }` routes to `{agent: "codex", model: "gpt-6.1-sol"}`.
  - A top-level `backend: "codex"` with no `model` resolves `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna` for the strong, default and small tiers.
  - `{ backend: "codex", model: "gpt-6-luna", thinking: "high" }` keeps thinking `high`.
- Validation:
  - `backends.codex: { configDir: "~/.codex-tumwater", windowReserve: { "seven_day": 0.7 } }` loads.
  - `configDir: "relative/dir"` is refused.
  - `backends.codex.args: ["--sandbox", "read-only"]` is refused, naming `--sandbox`.
  - `backends.codex.args: ["-c", "model=x"]` and `["--config=model_reasoning_effort=high"]` are refused, naming the key.
  - `backends.codex.args: ["-c", "model_verbosity=low"]` loads.
  - `backends.opencode.configDir` is still refused.
- test/backend-traits.test.ts: codex streams no tool output, uses no pi models, and labels `gpt-6.1-sol` as `gpt-6.1-sol` and an undefined model as `codex default`.
- Startup gate: with `backend: "codex"` and no codex adapter registered, the problem names codex. A pi-only config is unaffected.
- `npm test` passes.

### Codex backend, part 5/9: The Codex invocation and environment: argv for fresh and resumed runs, isolation flags, and the scrubbed env (planned 2026-10-20 by user; requires part 4/9 landed; design in plans/codex-backend.md "The invocation" and "Findings, verified live" 6–10, 13 and 20; touches src/agent/codex/codex-args.ts src/agent/codex/codex-env.ts (new) and their tests)

**Goal.** Build, as pure functions, the argv, stdin and environment of one Codex run, fresh or resumed. A Codex run then gets only the flags design §3 lists, the prompt on stdin, and an environment with no host Codex or Claude Code session state and no OpenAI API key.

**Approach.**
- src/agent/codex/codex-args.ts gains `codexArgs({model, effort?, resumeId?, args?, prompt})`. It returns `{args, stdin}`.
  - A fresh run: `exec --json --dangerously-bypass-approvals-and-sandbox --ignore-user-config --ignore-rules`, then the `--disable` list (`plugins`, `apps`, `goals`, `image_generation`, `browser_use`, `computer_use`, `tool_suggest`, `skill_search`), then `-c agents.enabled=false`, `-c web_search="disabled"`, `-c check_for_update_on_startup=false`, `-c analytics.enabled=false`, `-c feedback.enabled=false`, `-c history.persistence="none"`, `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`, `-m <model>`, `-c model_reasoning_effort=<effort>` when one is given, the passthrough args (through `appendPassthroughArgs`, src/agent/agent-args.ts), and `-`.
  - A resume: `exec resume <resumeId>` with the same flags, `-m` included (design finding 6). It has no `--sandbox` and no positional prompt besides `-`.
  - It throws on an unknown effort, as `claudeArgs` does.
  - It also exports `codexEffort(thinking, levels)`, which maps through `EFFORT_BY_THINKING` and returns undefined when the model's catalog `levels` (passed in) lack the result. Part 8/9 supplies the levels; until then the caller passes undefined, which means no clamp.
- src/agent/codex/codex-env.ts (new): `codexEnv(base, {home?})`.
  - It deletes every `CODEX_*`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDECODE` and every `CLAUDE_CODE_*`.
  - It sets `CODEX_HOME` to `home` when one is given.
  - It keeps everything else, including `TUMWATER_RUN`, `TUMWATER_NOTES_PATH` and the PATH that carries the notes shim.
- Doc comments cite the design findings behind each flag. Every `-c` key in the argv was checked with `--strict-config` on Codex 0.163.0 (design finding 20).

**Acceptance criteria.**
- test/codex-args.test.ts (new):
  - The fresh argv for `{model: "gpt-6.1-sol", effort: "high"}` equals the full expected list, and stdin is the prompt.
  - The resume argv starts `exec resume <id>` and still carries `-m gpt-6.1-sol`.
  - A passthrough `--sandbox` throws, naming it.
  - `codexEffort("minimal", ["low","medium"])` is `low`. `codexEffort("max", ["low","medium","high"])` is undefined. `codexEffort("high", undefined)` is `high`.
- test/codex-env.test.ts (new):
  - From a base holding `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `TUMWATER_RUN` and `HF_TOKEN`, the result keeps only `TUMWATER_RUN` and `HF_TOKEN` of those.
  - `CODEX_HOME` is set when `home` is given and absent otherwise.
- `npm test` passes.

### Codex backend, part 6/9: The Codex stream translator and the rollout reader, with fixtures from the H1 captures (planned 2026-10-20 by user; independent of parts 1/9–5/9; design in plans/codex-backend.md "The stream translator and the rollout read that completes it" and "Findings, verified live" 3–5, 11, 15, 18, 19, 23 and 24; touches src/agent/codex/codex-stream.ts (new) src/agent/codex/codex-rollout.ts (new) src/agent/agent-backend.ts test/fixtures/codex-events.ts (new) and their tests; reads test/fixtures/codex-captures/)

**Goal.** Translate `codex exec --json` into tumwater's canonical stream, and read the rollout file for what the stream lacks: this run's own token usage, the billing and the two usage windows. Both are pure over text, so the adapter (part 7/9) only wires them in.

**Approach.**
- src/agent/agent-backend.ts: `StreamTranslator` gains an optional `sessionId?(): string | undefined`, the backend session id once the stream has named it. This part only declares it; part 7/9's run-agent reads it.
- src/agent/codex/codex-stream.ts (new): `codexTranslator()`, which follows design §5's table row by row.
  - `bash` tool calls carry the inner command with the `/bin/zsh -lc` (or `bash -lc`) wrapper and its quoting removed.
  - A `command_execution`'s `aggregated_output` reaches `tool_execution_end` capped at `outputLimits(window).bash` (src/pi-extension/bounded-output.ts; 16,000 characters at 128k and above): head and tail around a marker naming the cut. The stream can carry a megabyte (design finding 18).
  - A `file_change` becomes one `edit` toolCall per changed path, `{path, kind}`, with `isError` when its `status` is not `completed`.
  - A `command_execution` still open at `turn.completed` is closed with `tool_execution_end {isError: true}` and the result "abandoned: the run ended while this command was still running", and `codex_command_abandoned` is warned once (design finding 19).
  - Repeated `error` items warn once per distinct message.
  - "Reconnecting... n/m" becomes `auto_retry_start`.
  - `turn.failed` is parsed through its JSON-string message to `status` and `error.type` / `code`, and classified per §5's table.
  - `finalize()` reports "codex exited without finishing its turn" when the stream saw neither `turn.completed` nor `turn.failed`.
  - `warnings()` lists unmapped event and item types once each, plus `codex_usage_partial` when the adapter flags it.
  - `turnCompletedUsage()` returns the stream's own figure, for the fallback.
- src/agent/codex/codex-rollout.ts (new):
  - `findRollout(home, id)` returns the path of `sessions/**/rollout-*-<id>.jsonl`, or null. It walks only the date dirs from the run's start date onward.
  - `rolloutLines(text, {sinceTurnStart, requestedModel})` reads only the records after this run's `task_started`. It returns the canonical `run_usage`, `billing` and `rate_limit` lines of design §5, or [] when the turn's records are missing or malformed. A turn with no `token_count` (a killed run, design finding 23) yields `run_usage` without any `rate_limit`.
  - When the turn's `turn_context.model` differs from `requestedModel`, it also reports `{switchedTo: <model>}` so the adapter can warn `codex_model_switched` (design finding 24).
  - It never returns or logs `session_meta` fields.
- test/fixtures/codex-events.ts (new): loaders for the scrubbed captures in test/fixtures/codex-captures/ (its README.md maps each file to a finding), plus small builders for what no capture has:
  - a used-up window, built from the binary's message ("You've hit your usage limit. … Try again at …") and a `usage_limit_reached` code;
  - a `turn_context` whose model differs from the requested one.

**Acceptance criteria.**
- test/codex-stream.test.ts (new):
  - edit-run.jsonl yields `session`, `agent_start`, a `message_end` with text, an `edit` toolCall for `/work/repo/a.txt` with its start and end, then a `bash` toolCall whose `command` is `cat a.txt && git status --short` (not the `/bin/zsh -lc` form), with its start and end.
  - oversized-output.jsonl: the `tool_execution_end` result is at most 16,000 characters plus the marker, and keeps the first and last lines.
  - abandoned-command.jsonl: the open `sleep 90; echo ok` call is closed as an error before the final message, and `warnings()` holds `codex_command_abandoned` once.
  - long-command.jsonl: one call open for the whole run, closed with exit code 0.
  - Fed through `PiStreamParser`, the final text is the last agent message.
  - `sessionId()` is undefined before `thread.started` and the thread id after.
  - Classification: unknown-model.jsonl is `configError`; not-logged-in.jsonl is `configError` and its ten reconnect lines are ten `auto_retry_start`; the built used-up window is `transientRateLimit` with a `rejected` `five_hour` reading and `retryAfterSeconds`.
  - sigterm-mid-command.jsonl, which ends after `item.started` with no turn event, finalizes to an error message.
  - An unknown item type is listed once in `warnings()`.
- test/codex-rollout.test.ts (new), on edit-run-and-resume-rollout.jsonl:
  - The first turn's `run_usage.input` is its last `turn_token_usage.input_tokens − cached_input_tokens`. The second turn's (the resume) is its own turn figure, not the thread total.
  - A `requestedModel` other than `gpt-6-luna` reports the switch.
  - The 300- and 10080-minute windows map to `five_hour` and `seven_day`, with `utilization` 0 and `resetsAt` the capture's `resets_at`.
  - `billing` is `subscription`.
  - A truncated file yields [].
  - The output contains no `creator_user_id` or `creator_account_id` value.
- `npm test` passes.

### Codex backend, part 7/9: The codex adapter runs model jobs, with stream-minted sessions, the rollout read after each run, a PATH fake and its prompt dialect (planned 2026-10-20 by user; requires parts 5/9 and 6/9 landed; design in plans/codex-backend.md "CODEX_HOME and sessions", "The stream translator and the rollout read that completes it" and "The prompt dialect"; touches src/agent/codex/codex-backend.ts (new) src/agent/run-agent.ts src/agent/session-ledger.ts src/prompt/dialect.ts src/paths.ts test/fakes/fake-codex.ts (new) test/test-runner.ts and their tests)

**Goal.** Codex model jobs run end to end. Fresh runs record their stream-minted session id; continues resume it; the rollout supplies this run's usage and windows; the reviewer's suite-rerun detection sees Codex's commands; and the prompt carries Codex's dialect.

**Approach.**
- src/agent/codex/codex-backend.ts (new): `codexBackend`, with `id: "codex"`, `label: "Codex"`, `defaultBin: "codex"` and `binEnv: "TUMWATER_CODEX_BIN"`. Its hooks:
  - `resolveBin` goes through `resolveBinForBackend`.
  - `invocation`:
    - For a continue, it takes the newest ledger record of this kind that is `agent: "codex"`, has this cwd and a UUID id, and whose rollout `findRollout` finds under the run's home. Otherwise the run is fresh.
    - It builds the args with `codexArgs` and the env with `codexEnv(withNotesPath(backendBaseEnv(…)), {home})`. The home is `backends.codex.configDir` expanded, else none.
    - It returns `sessionId` only for a resume.
  - `translator` returns `codexTranslator()`.
  - `resumable` makes the same check as the continue.
  - `afterRun` reads `findRollout` plus `rolloutLines` for the run's thread id: the resumed id, or else `translator.sessionId()`. On [] it flags `codex_usage_partial`, and a fresh run then emits `run_usage` from `turnCompletedUsage()`. A reported model switch warns `codex_model_switched {requested, ran}` once.
  - `classifyExit` handles the stderr half of a CLI that died before `turn.failed`. A killed run returns {} (design finding 12).
  - `imageInput` returns true for now. Part 8/9 reads the catalog.
- src/agent/run-agent.ts:
  - It registers `codexBackend`.
  - After each translated batch, when `translator.sessionId?.()` first returns an id the pre-spawn ledger record lacked, it appends one more `recordSession` line with that id (same kind, name, cwd, model, `at` now).
- src/agent/session-ledger.ts: `resumableSession` already takes the newest record of a kind. Add a test that the stream-minted record wins over its own pre-spawn record.
- src/prompt/dialect.ts: `CODEX_DIALECT` per design §6 (readRange, the `…N tokens truncated…` oversized-output wording, and the rule to keep polling `write_stdin` until a command reports its exit code), and an entry in `DIALECTS`.
- test/fakes/fake-codex.ts (new), the twin of fake-opencode.ts:
  - a PATH shim named `codex` that replays a canned `--json` stream;
  - it writes a matching rollout under `$CODEX_HOME/sessions/…`;
  - it records argv and stdin per run;
  - on `exec resume <id>` it appends to that rollout.
- test/test-runner.ts strips `TUMWATER_CODEX_BIN` and `CODEX_*` from the suite environment.

**Acceptance criteria.**
- test/codex-run.test.ts (new), on fake-codex:
  - A fresh author run exits success with the fake's final text and usage.
  - The run's ledger holds a pre-spawn record and a second record whose id is the fake's thread id.
  - A follow-up with `continueSession` runs `exec resume <that id>` with `-m`.
  - With the rollout deleted, the follow-up runs fresh, and the resume path logs its usual handoff.
  - A fake rollout reporting `seven_day` at 72% puts a `seven_day` reading with utilization 0.72 on the result, and `billing: "subscription"`.
  - A reviewer run whose fake stream runs `npm test` is seen as a suite rerun.
  - The harness's SIGTERM mid-command ends with no marked process left. The fake leaves a marked orphan, as the real CLI does, and the marker sweep reaps it.
- Prompt: a codex run's prompt carries `CODEX_DIALECT`'s rules (test/prompt-rules.test.ts, beside the OpenCode rule cases).
- `npm test` passes.

### Codex backend, part 8/9: Codex billing, free-ness and windows: the account fed from runs, the API-key refusal, the context window, effort levels and image input from the catalog (planned 2026-10-20 by user; requires parts 3/9 and 7/9 landed; design in plans/codex-backend.md "Spend, free-ness, window, images"; touches src/pi/pi-models.ts src/agent/codex/codex-backend.ts src/agent/codex/codex-catalog.ts (new) src/agent/codex/codex-account.ts (new) src/gates/startup-gate.ts src/config/config-live.ts and their tests)

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

### TUI Activity pane shows a per-event-type tally line above the feed, the terminal twin of `tumwater logs --count` and the dashboard feed's tally chips (planned 2026-10-20 by the plan role; independent of every eligible plan: the Transcript change step Ctrl+Y plan edits src/ui/tui/tui-pane-transcript.ts, tui-panes.ts, tui-keys.ts, tui-frame.ts and tui.tsx; the dashboard Newest failure plan edits src/ui/gui and docs; the `logs --transcript` completion plan edits src/cli/completion.ts and docs. None touches src/ui/tui/tui-pane.ts, src/events/event-tally.ts or `sayTally` in src/cli/log-commands.ts, so the only shared edits are neighbouring docs lines. Touches src/events/event-tally.ts (new), src/ui/tui/tui-pane.ts, src/cli/log-commands.ts, docs/cli.md, docs/how-it-works.md, test/tui-activity.test.ts (new))

**Goal.** The TUI Activity pane (`paneBody`, src/ui/tui/tui-pane.ts) lists the event tail and cycles an exact event type with Ctrl+O, but shows no per-type counts. `tumwater logs --count` prints them (`sayTally`, src/cli/log-commands.ts: one `N × <label> (<type>)` per present type, most-frequent first with ties in type-name order), and the dashboard feed shows them as tally chips (`tallyChips`, src/ui/gui/gui-client-feed.ts: `N × <label>`, the id as the chip title). The pane's Ctrl+O cycle already builds its options from the pre-type read, so an operator scrolling Activity cannot see which types are present or how many. Add one dim tally line above the feed, built from the role- and grep-filtered but type-unfiltered rows, so every type stays visible (and one Ctrl+O step away) while a type is selected.

**Approach.**
1. New src/events/event-tally.ts: `export function eventTypeTally(events: readonly HarnessEvent[]): Array<[string, number]>`. It `increment`s a `Map` over `e.type`, then returns `sortByValueDesc([...counts.entries()])` (src/collections.ts), so the count-descending/type-ascending order has one home. Its doc comment says it is the ordering `sayTally` and the TUI tally share, and that the dashboard's browser tally chips keep their own copy because they run where harness modules cannot be imported (the `reportRoleOrder` exception src/ui/gui/gui-client-report-chart.ts documents).
2. src/cli/log-commands.ts, `sayTally`: replace its local `increment`/`sortByValueDesc` text branch with `eventTypeTally(events)`; the JSON branch keeps its own alphabetical key sort. The rendered lines are byte-identical because the helper reproduces exactly the `increment` + `sortByValueDesc` step it replaces.
3. src/ui/tui/tui-pane.ts, the activity branch of `paneBody`:
   - Add imports `eventTypeLabel` from `../../events/event-labels.js` and `eventTypeTally` from `../../events/event-tally.js`.
   - Read the type-unfiltered rows once: `const preType = activityEvents(root, pane.role, pane.grep, null);` then `const events = pane.type === null ? preType : activityEvents(root, pane.role, pane.grep, pane.type);`.
   - Build the line only when the feed is non-empty: `const tallyLine = events.length === 0 ? [] : [toneLine(eventTypeTally(preType).map(([type, n]) => `${n} × ${eventTypeLabel(type)} (${type})`).join(" · "), width, "dim")];`.
   - Give the tally one line of the body budget: `const rows = Math.max(1, eventBudget - tallyLine.length);` and use `rows` where the branch's `maxStart`/`start` math currently uses `eventBudget`, so `body` is `[...tallyLine, ...events.slice(start, start + rows).map(...)]` and stays at `eventBudget` lines at most.
   - Keep the existing `emptyNote` expression unchanged. No tally is added when `events.length === 0`, so the renderer still paints `emptyNote` (a role/grep scope with no events keeps `(no events match this filter)`, an empty log keeps `(no events yet)`). The Ctrl+O cycle can only select a type present in `preType`, so a selected type never empties `events` in the steady state; a rotation race is covered by the `events.length === 0` guard rather than a special case.
   - Extend the branch's comment to name the tally and to say it is built from `preType` so every type the Ctrl+O cycle offers stays counted.
4. Docs. docs/cli.md, the `logs --count` sentence in the "Check state" row: after "with `--json`, one object mapping type to count" add ", the same tally the TUI's Activity pane prints as one line above its event feed (the dashboard feed's tally chips carry the counts too)". docs/how-it-works.md, the Activity pane paragraph: add one sentence naming the tally line, its count-descending/type-name order, and that Ctrl+O selects one of the types it counts.

**Files touched.** src/events/event-tally.ts (new), src/ui/tui/tui-pane.ts, src/cli/log-commands.ts, docs/cli.md, docs/how-it-works.md, test/tui-activity.test.ts (new).

**Acceptance criteria.**
- test/tui-activity.test.ts (new; a repo from `makeTuiRepo()` in test/fixtures/tui-fixtures.js, events seeded with `logEvent` from ../src/events/events.js as test/tui.test.ts does, and a `TuiPaneState` literal like test/tui-backlog.test.ts's). Seed two `run_start` events and one `merge_failed` event.
  - `paneBody({ kind: "activity", role: null, grep: null, type: null }, { root, width: 200, eventBudget: 10, entryBudget: 5, state }).body` has length 4; its first line's text is exactly `2 × run started (run_start) · 1 × merge failed (merge_failed)`, and the next three lines are the formatted event lines oldest first.
  - The same call with `type: "merge_failed"` keeps that same first tally line and then only the merge_failed line: the tally is built from the type-unfiltered rows, so the filtered-out `run_start` count stays visible.
  - With `role` scoped to the role that only logged `merge_failed`, the tally line is `1 × merge failed (merge_failed)`.
  - With `grep: "nomatch"`, `body` is `[]` and `emptyNote` is `(no events match this filter)`.
  - With no events seeded, `body` is `[]` and `emptyNote` is `(no events yet)`.
  - Budget: the three-event seed with `eventBudget: 3` gives a three-line body, the tally line plus the newest two event lines, so the tally consumes one line of the tail budget.
- test/tui-activity.test.ts also pins `eventTypeTally` directly: inputs `a, a, b, c` return `[["a", 2], ["b", 1], ["c", 1]]` (count-descending, equal counts in type-name order), and `[]` returns `[]`.
- The existing `logs --count` tests pass unchanged (the tie-break and `--json` key-order cases), and the rendered `logs --count` text is byte-identical before and after the `sayTally` change.
- The existing TUI tests pass unchanged: the activity frame tests use `assert.match`, and "queued prompts render numbered above the activity pane and shrink its budget" computes its `full` from the same new frame shape before it asserts the two-line shrink.
- `npm run test:gate` is green.

### TUI Pending pane's Ctrl+G role scope also narrows the durable merge queue, each kept merge under its whole-queue position: the terminal twin of `tumwater queue --role <id>` (planned 2026-10-21 by the plan role; independent of every eligible plan: the in-flight TUI Activity tally plan edits src/ui/tui/tui-pane.ts, src/events/event-tally.ts, src/cli/log-commands.ts and test/tui-activity.test.ts (new); the in-flight dashboard Pending Merge queue Role picker edits src/ui/gui/gui-client-pending.ts, test/gui-client-pending.test.ts and docs/how-it-works.md; the Codex parts edit src/events, src/config, src/gates, src/team, src/orchestrator and src/agent. None touches src/ui/tui/tui-pane-pending.ts or test/tui-keys.test.ts; docs/cli.md and docs/how-it-works.md are shared with those entries only at neighbouring sentences, so whichever lands second rebases there. Touches src/ui/tui/tui-pane-pending.ts test/tui-keys.test.ts docs/cli.md docs/how-it-works.md)

**Goal.** The Pending pane (`createPendingPane`, src/ui/tui/tui-pane-pending.ts) paints the durable merge queue above the roster, and its Ctrl+G already narrows the overlapping-files block to one holding role (the `diff --overlaps --role <id>` twin). The CLI narrows the queue too (`tumwater queue --role <id>[,<id>...]`, through `scopeMergeQueue` in src/merge/merge-queue-render.ts — the same helper src/ui/tui/tui-pane-transcript.ts already calls for one role's change view), and the dashboard's Merge queue card is getting a Role picker, but the TUI queue itself always lists every role. Extend the pane's one Ctrl+G role scope so it narrows the merge queue as well as the overlapping files, cycling through the roles the queue names, then the overlap holders not already in that list, then back to all. Each kept merge keeps its whole-queue position and each kept overlap still names every holder. No new key and no `tui-panes.ts` routing change: Ctrl+G already reaches the Pending pane, and one role scope per pane beats two scopes fighting over keys.

**Approach.** All in src/ui/tui/tui-pane-pending.ts unless named otherwise.

1. Exports and imports:
   - Add `export function mergeQueueRoles(view: MergeQueueView): string[]` beside `overlapHolders`: the distinct `entry.role` values in first-seen (queue) order, `[]` for an empty queue. Import the `MergeQueueView` type from `../../merge/merge-queue.js` and `scopeMergeQueue` beside `renderMergeQueue` from `../../merge/merge-queue-render.js`.
2. State: rename `let overlapScope: string | null = null;` to `let roleScope` and update its comment to say the one scope covers the queue and the overlaps. Add `let lastQueue: MergeQueueView | null = null;` and `let rosterText = "";` beside `head`.
3. Render:
   - Add `function queueHead(): string`: return `""` when `lastQueue` is null; else `const inFlight = queueInFlight(session.root, lastQueue.entries, orchestratorAlive(session.root));` and, when `roleScope === null`, return `renderMergeQueue(lastQueue, session.now(), inFlight)`; otherwise `const { view, scope } = scopeMergeQueue(lastQueue, [roleScope], (r) => r === roleScope);` and return `renderMergeQueue(view, session.now(), inFlight, scope)`.
   - In `refresh()`, replace the inline `readMergeQueue`/`renderMergeQueue` pair with `lastQueue = readMergeQueue(session.root); rosterText = ""; const queueText = queueHead();`, keeping the existing `head`/`base`/`paneCache` writes. On resolve, set `rosterText = "\n\n" + renderTeamChange(team); head = queueHead() + rosterText; compose();` where it once set `head = queueText + "\n\n" + renderTeamChange(team)`. `compose()` is unchanged, so the queue text with no scope stays byte-identical to today.
4. Ctrl+G arm: replace the holder-only cycle with `const queueRoles = lastQueue ? mergeQueueRoles(lastQueue) : []; const holders = lastOverlaps?.state === "ready" ? overlapHolders(lastOverlaps) : []; const roles = [...queueRoles, ...holders.filter((h) => !queueRoles.includes(h))];`. When `roles.length === 0`, set `roleScope = null`, recompute `head = queueHead() + rosterText`, `compose()`, `session.paneCache = base`, flash `no queued merges or overlapping files to scope`, and keep the pane. Otherwise cycle `roleScope` through `[null, ...roles]` exactly as the holder cycle does today, then recompute `head = queueHead() + rosterText`, `compose()`, `session.paneCache = base`. Keep the existing `overlapIndex = -1; ++drillGen;` reset (an open drill-down closes) and the `session.paneScroll = 0`.
5. Extend the file's top doc comment to say the Ctrl+G scope covers the merge queue too.
6. docs/cli.md, the `Ctrl+G` row: extend its Pending clause to "on Pending, keep only the queued merges and the overlapping files one role touches (each merge under its whole-queue position, each file still naming every holder), cycling through the roles the queue names and the overlap holders and back to all (the twin of `queue --role <id>` and `diff --overlaps --role <id>`)".
7. docs/how-it-works.md, the Pending pane paragraph: after the existing Ctrl+G sentence, add that the same scope also narrows the merge queue to that role's waiting merges, each under its whole-queue position (the `tumwater queue --role` view), and that the cycle includes the queued roles before the overlap holders.

**Files touched.** src/ui/tui/tui-pane-pending.ts, test/tui-keys.test.ts, docs/cli.md, docs/how-it-works.md.

**Acceptance criteria.** (test/tui-keys.test.ts, driving `createTuiKeys` over a `makeRoot()` temp root and seeding the queue through `enqueueMerge` from ../src/merge/merge-queue.js, both already imported there; Ctrl+T five times enters Pending as in the existing tests)
- New test "Ctrl+G on the Pending pane narrows the merge queue to each queued role under its whole-queue position": seed `feature` (run 1), `feature-2` (run 2) and `clean` (run 3) with distinct `enqueuedAt`s, `collectPending` resolving `{ mainBranch: "main", roles: [] }` and `collectOverlaps` a `no-base` view. Before Ctrl+G `paneCache` starts with `merge queue (3):`. The first press makes it start `merge queue (1 of 3, --role feature):` and contain ` 1. feature run #1 ` but neither ` 2. ` nor ` 3. `; the second `merge queue (1 of 3, --role feature-2):` with ` 2. feature #2 run #2 `; the third `merge queue (1 of 3, --role clean):` with ` 3. clean run #3 `; the fourth returns to the unscoped `merge queue (3):`. The match is exact, so `--role feature` does not pull `feature-2`'s entry (matching the transcript pane's queue scope, not the CLI's base-plus-instances rule).
- New test "the Pending pane's Ctrl+G scope filters the queue and the overlapping files from one cycle set": seed one `clean` queue entry and `collectOverlaps` a `ready` view with `{ path: "src/a.ts", roles: ["feature", "clean"] }`. The first Ctrl+G scopes to `clean` (the queue role first): the queue block starts `merge queue (1 of 1, --role clean):` and the overlap block reads `overlapping files held by clean (1):`. The second scopes to `feature` (the holder appended after the queued roles): the queue block's head reads `no queued merges for feature (merge queue holds 1)` and the overlap block reads `overlapping files held by feature (1):`. The third returns to the whole queue and all overlaps.
- Unit test "mergeQueueRoles lists each queued role once in queue order": a `MergeQueueView` whose entries name `feature`, `clean`, `feature` yields `["feature", "clean"]`, and one with no entries yields `[]`.
- Update "Ctrl+G on the Pending pane with no overlaps flashes" (empty queue, no overlaps) to expect the flash `no queued merges or overlapping files to scope` and the unchanged pane.
- The rest of the existing Pending tests pass unchanged: with an empty queue the Ctrl+G cycle set is still `overlapHolders`, so "Ctrl+G on the Pending pane cycles the overlap scope through each holder and back", "Ctrl+N under a Pending overlap scope steps through only the scoped files" and "Ctrl+G on the Pending pane closes an open drill-down and survives Ctrl+R" keep their assertions.
- `npm run test:gate` is green.

### `tumwater queue -f/--follow` repaints the durable merge queue every couple of seconds until Ctrl+C or its parent exits, the snapshot command's live twin of the TUI Pending pane and the dashboard Merge queue card (planned 2026-10-21 by the plan role; independent of every eligible plan: the in-flight TUI Activity tally plan edits `sayTally` in src/cli/log-commands.ts, src/ui/tui/tui-pane.ts, src/events/event-tally.ts, docs/cli.md's `logs --count` sentence and docs/how-it-works.md's Activity paragraph; the in-flight TUI Pending Ctrl+G plan edits src/ui/tui/tui-pane-pending.ts, test/tui-keys.test.ts, docs/cli.md's `Ctrl+G` row and docs/how-it-works.md's Pending paragraph; the Codex parts edit src/events, src/config, src/gates, src/team, src/orchestrator and src/agent. None touches src/cli/cli-query-commands.ts, src/cli/help.ts's `queue` stanza or test/cli-queue-follow.test.ts; docs/cli.md is shared with the other two only at neighbouring clauses, so whichever lands second rebases there. Touches src/cli/cli-query-commands.ts src/cli/help.ts docs/cli.md test/cli-queue-follow.test.ts (new))

**Goal.** `tumwater queue` prints the durable merge queue once (src/cli/cli-query-commands.ts `cmdQueue`), and `status` just gained `-f/--follow`; the queue itself has no live form. An operator watching the team merge wants the queue to update as entries land, the way the TUI Pending pane and the dashboard Merge queue card already do. Add `-f/--follow`: repaint the queue every couple of seconds until Ctrl+C or the parent process exits, so a backgrounded follow does not outlive its parent (the same rule `status -f`, `logs -f` and `history -f` use). `--role` composes with it, each frame keeping only the listed roles' merges under their whole-queue positions; `--json` is refused with a follow because it prints one document.

**Approach.** The first three bullets are in src/cli/cli-query-commands.ts unless named otherwise.

1. Share the status follow's loop instead of copying it:
   - Rename the local `interface StatusFollowSeams` to `interface FollowViewSeams` and `const STATUS_FOLLOW_INTERVAL_MS = 2000` to `const FOLLOW_VIEW_INTERVAL_MS = 2000`, updating `cmdStatus` and `followStatus`.
   - Extract `async function followView(frameText: () => string, seams: FollowViewSeams): Promise<void>` holding exactly today's `followStatus` loop: `const tty = seams.tty ?? process.stdout.isTTY;`, `const interval = seams.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;`, a `frame()` that writes `tty ? "\x1b[H\x1b[2J" + text + "\n" : text + "\n\n"`, the immediate first `frame()`, then the `setInterval` plus `startParentDeathWatch(() => { clearInterval(timer); resolve(); }, { ppid, intervalMs })` promise. `followStatus` becomes a call to `followView(() => renderStatus(root, scope ? scopeSnapshotToRoles(snapshot(root), scope) : snapshot(root), tty ? process.stdout.columns : undefined, scope !== null), seams)`, reading `tty` the same way for the column count; its emitted bytes are unchanged.
2. `cmdQueue` gains the flag and the follow branch. Its doc comment becomes `queue [-f/--follow]`, noting the repaint and the parent-death end.
   - Add local `const QUEUE_FOLLOW_SPEC = { names: ["-f", "--follow"] };` beside the other local specs; `rejectUnknownArgs("queue", args, [ROLE_FLAG, JSON_FLAG, QUEUE_FOLLOW_SPEC])`.
   - Change the signature to `export async function cmdQueue(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void>` (cli.ts's call site passes no seams and needs no change).
   - `const follow = args.includes("-f") || args.includes("--follow");`, and beside the `status` refusal: `if (follow && args.includes("--json")) fail("queue --json prints one document; -f/--follow repaints a live view — drop one of them");`.
   - After `requireReadyRepo` and `parseRoleListScope`, factor the scoped read into `const readQueue = () => { const whole = readMergeQueue(root); const scoped = roles ? scopeMergeQueue(whole, roles, (r) => roles.includes(r) || roles.includes(baseRoleOf(r))) : undefined; const view = scoped ? scoped.view : whole; return { view, inFlight: queueInFlight(root, view.entries, orchestratorAlive(root)), scope: scoped?.scope }; };` — the exact body of today's snapshot read, one clock read for the render's age. Then `if (follow) { await followView(() => { const { view, inFlight, scope } = readQueue(); return renderMergeQueue(view, Date.now(), inFlight, scope); }, seams); return; }` beside the snapshot branch. The snapshot branch calls `readQueue()` once and keeps its `sayJsonOrRender(args, inFlight ? { ...view, inFlight } : view, () => renderMergeQueue(view, Date.now(), inFlight, scope))` exactly as today, so `tumwater queue` output is byte-identical.
3. src/cli/help.ts, the `tumwater queue` stanza: synopsis becomes `tumwater queue [--role <id>[,<id>...]] [-f/--follow] [--json]`, and after the existing `--json then lists only those entries` sentence add `-f/--follow repaints the queue every couple of seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does not outlive its parent; it refuses --json;`. Wrap to the stanza's column.
4. docs/cli.md, the `tumwater queue` clause of the "Check state" row: change its synopsis to `tumwater queue [--role <id>[,<id>...]] [-f/--follow] [--json]` and, after the `--role` sentence, add: ``-f/--follow` repaints the queue every couple of seconds until Ctrl+C or its parent process exits (a backgrounded follow does not outlive its parent, like `status -f`); it refuses `--json``. Leave the surrounding clauses untouched.

**Files touched.** src/cli/cli-query-commands.ts, src/cli/help.ts, docs/cli.md, test/cli-queue-follow.test.ts (new).

**Acceptance criteria.**
- test/cli-queue-follow.test.ts (new), driving `cmdQueue` in-process with the follow seams the way test/status-follow.test.ts drives `cmdStatus` (a `makeRepo()`/`initProject` repo, entries seeded with `enqueueMerge`, `captureStdout` from ./helpers/exit-capture.js, `sleep` from ./helpers/wait.js, and a `withQueueFollow(args, intervalMs, tty, drive)` helper whose `stop()` sets the seam's parent to PID 1 and whose `finally` awaits the follow promise under a restored stdout):
  - Test "queue -f repaints until its parent exits, then prints nothing": seed `improve` run #3; run `["-f"]` at 5 ms non-TTY; after ~60 ms `cap.out()` matches `/merge queue \(1\):/` at least twice and contains `/1\. improve run #3/`; `stop()` then the follow resolves and stdout stops growing.
  - Test "queue -f --role keeps only the listed role's entries in every frame": seed `improve` and `clean`; run `["--role", "clean", "-f"]`; the captured frames match `/1\. clean run/` and never `/improve/`.
  - Test "queue -f --json is refused": `expectFailAsync(() => cmdQueue(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }))` rejects matching `/queue --json prints one document/`, and the captured stdout has no `merge queue` line and no clear-screen.
  - Test "queue -f clears the screen only on a TTY": with `tty: true` the output starts with `"\x1b[H\x1b[2J"`; with `tty: false` it never contains that sequence.
- test/cli-queue.test.ts passes unchanged: the snapshot, `--json` and `--role` tests see the same bytes as today.
- test/status-follow.test.ts passes unchanged: the extracted `followView` emits the same frames and still refuses `status -f --json`.
- `npm run test:gate` is green.

## Done
