# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### TUI Transcript change step Ctrl+Y shows the viewed role's diffstat instead of its full patch, and the full patch again on a second press: the terminal twin of `tumwater diff --role <id> --stat` and the dashboard drawer's Stat only toggle (planned 2026-10-20 by the plan role; replanned 2026-10-21 by the plan role; independent of every eligible plan: the TUI Inbox `/` search plan edits the `/` plumbing and the Inbox hint line, and the TUI Pending Ctrl+G plan edits the Ctrl+G route and the Pending hint line, both in src/ui/tui/tui-panes.ts and src/ui/tui/tui-frame.ts. This plan edits only the Ctrl+Y route and the transcript hint line there, so at most a neighbouring-line rebase. The role-less `/api/run?last=1` plan touches src/gui and src/run only. Touches src/ui/tui/tui-pane-transcript.ts, src/ui/tui/tui-panes.ts, src/ui/tui/tui-keys.ts, src/ui/tui/tui-pane-session.ts, src/ui/tui/tui-frame.ts, src/ui/tui/tui.tsx, docs/cli.md, test/tui-keys.test.ts and test/tui-frame.test.ts)

**Goal.** A role's Transcript view cycles transcript → notes → change with Ctrl+N (`createTranscriptPane` in src/ui/tui/tui-pane-transcript.ts). The change step always renders the full patch (`session.collectChange(session.root, target)` then `renderRoleChange`). The CLI has `diff --role <id> --stat`, and the dashboard drawer gained a Stat only toggle (`GET /api/diff?role=<id>&stat=1`, PLANS-DONE.md). The terminal has neither. A large pending change fills many pages in the TUI, but the first question is usually just "which files does it touch". `collectRoleChange` (src/change/change-data.ts) already takes `opts.stat`, and `renderRoleChange` renders that view unchanged, so only the TUI plumbing is missing.

**Key choice.** Ctrl+Y (mnemonic: summar**Y**, as in the History pane's summary toggle). On a Transcript view it does nothing useful today. The Activity-only claude-reserve editor (`tui-editor-claude-reserve.ts`, built by `createTeamConfigKeyEditor`, which returns false off view 0) lets the key fall through. The `tui-panes.ts` router then sends it to `history.handleKey`, which flips the History pane's `historySummary` behind the scenes. The other Transcript keys are taken (see docs/cli.md's TUI keys table).

**Approach.**
1. src/ui/tui/tui-pane-session.ts and src/ui/tui/tui-keys.ts: widen the `collectChange` seam's `opts` type in all three declarations (`TuiPanesDeps` and `TuiPaneSession` in tui-pane-session.ts, and `TuiKeysDeps`' optional one in tui-keys.ts) from `{ path?: string }` to `{ path?: string; stat?: boolean }`. The default `collectRoleChange` already accepts it. No other change there.
2. src/ui/tui/tui-pane-transcript.ts, `createTranscriptPane`:
   - Add `let changeStat = false;` and `let changeGen = 0;` beside `changeMode`/`changeCache`.
   - Pull the merge-queue header and collector call out of the notes → change arm into a local `loadChange(role: string)`. It starts `changeCache = null;` then `const gen = ++changeGen;`, computes `queueText` with the same try/catch, and calls `session.collectChange(session.root, target, changeStat ? { stat: true } : undefined)`. Both `.then` arms start `if (gen !== changeGen) return;`: that single staleness check replaces the old `changeMode`/same-role guards and also drops a load that Ctrl+Y, leaving the step, or `reset()` has superseded. The notes → change arm sets `changeMode = true; changeStat = false;` then calls `loadChange(role)`.
   - `changeGen`'s declaration comment must say exactly when it is bumped — `loadChange` on every change-step load (a Ctrl+Y toggle included), the change → transcript branch, and `reset()` — and why: a collector a newer load or a leave superseded must not paint the pane. Do not claim a bump the code does not perform.
   - The change → transcript branch (Ctrl+N while `changeMode`) sets `changeMode = false; changeGen += 1; changeCache = null;` so a load still in flight cannot paint the pane after the step is left.
   - A new arm: `key.ctrl && key.name === "y" && changeMode && promptLineFree(ctx.es) && session.view >= 1 && session.view <= session.roleIds.length`. It flips `changeStat`, sets `session.paneScroll = 0`, calls `loadChange(role)` (which clears `changeCache`, so the pane paints its loading note), requests a render, and returns true. With any of those conditions false it returns false, so the router falls through.
   - `reset()` adds `changeGen += 1` and `changeStat = false` beside clearing `changeMode`/`changeCache`, so cycling the view drops an in-flight load. Every fresh entry to the change step then starts on the full patch, like the drawer, which refetches without stat on reopen.
   - `state()` adds `changeStat`.
3. src/ui/tui/tui-panes.ts: the Ctrl+Y route becomes `if (transcript.handleKey?.(key, ctx)) return true; return history.handleKey?.(key, ctx) ?? false;`, with a one-line comment saying the transcript change-step arm goes first and falls through off it. Add `changeStat: tra.changeStat` to the aggregated state beside `changeCache`. Add the matching `changeStat: boolean` field, with a doc comment, to `TuiKeysState` in src/ui/tui/tui-keys.ts beside `changeCache`.
4. src/ui/tui/tui-frame.ts: the transcript view kind gains `changeStat?: boolean`. On the transcript hint line, when `view.change` is true, add `["Ctrl+Y", view.changeStat ? "full patch" : "stat only"]` after the Ctrl+N pair. src/ui/tui/tui.tsx passes `changeStat: s.changeStat` where it builds the transcript view.
5. docs/cli.md: in the TUI keys table's `Ctrl+N` | Transcript row, append "; on the change, `Ctrl+Y` shows the diffstat instead of the full patch, and the patch again on a second press (the `diff --role <id> --stat` text and the dashboard drawer's Stat only)".

**Acceptance criteria** (test/tui-keys.test.ts, modelled on "Ctrl+N cycles transcript → notes → change and back, caching the collector's render" and "Ctrl+T leaves change mode, and a resolution after a cycle away does not cache"; the collector stub records each call's `opts` and returns a fresh pending promise per call so a test controls resolution order):
- New test "Ctrl+Y on the Transcript change step toggles the diffstat". Enter the change step (Ctrl+T on a role view, then Ctrl+N twice). The first collector call has no `stat`, and `state().changeStat` is false. Ctrl+Y sets `changeStat` true and makes a second collector call with `{ stat: true }`. Once that resolves, `changeCache` equals `renderRoleChange(statView)`. A second Ctrl+Y makes a call without `stat` and sets `changeStat` back to false.
- New test "a superseded change-step load never paints over the newer one": enter the change step and hold its full-patch promise; Ctrl+Y issues the stat load; resolve the stat load, then resolve the older full-patch promise. `changeCache` is still `renderRoleChange(statView)` and `changeStat` is still true. This is the case the old guard missed and `changeGen` exists for.
- In the toggle test, Ctrl+Y on the stat step, then Ctrl+N (change → transcript), then Ctrl+N twice back to the change step: `changeStat` is false and the newest collector call has no `stat`.
- The existing "Ctrl+T leaves change mode, and a resolution after a cycle away does not cache" test passes unedited, so `reset()`'s staleness still holds with the new `changeStat` state, and the existing Ctrl+N cycle test passes unedited.
- Ctrl+Y on the live transcript step (not the change step) leaves `changeStat` false and makes no collector call. That keeps the History fallthrough intact. Assert the router still reaches History: on the History view, Ctrl+Y still cycles the summary, and the existing History Ctrl+Y tests pass unedited.
- test/tui-frame.test.ts: the transcript hint with `change: true` contains `Ctrl+Y stat only`, and with `changeStat: true` contains `Ctrl+Y full patch`. With `change: false` it contains no `Ctrl+Y`.
- **Commit hygiene.** This plan changes code, tests and docs, not only documentation: the run's commit body must describe the Ctrl+Y diffstat toggle it added and its `VERIFIED` line must report the check it ran. A body that says no edits were made is wrong for this plan.
- `npm run test:gate` is green.

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

### `tumwater status -f/--follow` repaints the team's status table every couple of seconds until Ctrl+C or its parent exits: the snapshot command's live twin of the TUI header and the dashboard Team card (planned 2026-10-20 by the plan role; independent of every eligible plan: the TUI Activity tally plan edits `sayTally` in src/cli/log-commands.ts and docs/cli.md's `logs --count` sentence, the Transcript change step Ctrl+Y plan edits docs/cli.md's TUI keys table, and the dashboard Newest failure plan edits src/ui/gui; none touches src/cli/cli-query-commands.ts, src/cli/help.ts's `status` stanza, the `tumwater status` clause of docs/cli.md's "Check state" row or a new test/status-follow.test.ts. Touches src/cli/cli-query-commands.ts, src/cli/help.ts, docs/cli.md, test/status-follow.test.ts (new))

**Goal.** `tumwater status` prints one snapshot and exits. `logs -f` and `history -f` stream, and the TUI header and the dashboard Team card update live, but a terminal operator watching from a shell has no way to keep the status table current. Add `-f/--follow` to `status`: render the current table, sleep, re-collect and repaint, until Ctrl+C or the process that started it exits — the same parent-death rule `logs -f` uses, so a backgrounded follow does not outlive its parent. The `--json` and `--role` surfaces stay as they are.

**Key choice.** Repaint in place on a TTY with `\x1b[H\x1b[2J` before each frame (the `watch` shape), and print frames separated by a blank line when stdout is not a TTY, so a piped follow stays readable and scriptable. `renderStatus` (src/ui/status-render.ts) is reused unchanged; the interval is a fixed default (no knob).

**Approach.**
1. src/cli/cli-query-commands.ts:
   - Import `startParentDeathWatch` from `../process/supervisor.js`.
   - Add beside the other local specs: `const STATUS_FOLLOW_SPEC = { names: ["-f", "--follow"] };` (unannotated like the neighbouring local specs, so no new import), `const STATUS_FOLLOW_INTERVAL_MS = 2000;`, and `export interface StatusFollowSeams { ppid?: () => number; intervalMs?: number; tty?: boolean; }`.
   - `cmdStatus(root, args, seams: StatusFollowSeams = {})`: add `STATUS_FOLLOW_SPEC` to the `rejectUnknownArgs("status", args, …)` list; compute `const follow = args.includes("-f") || args.includes("--follow");` and, before `requireReadyRepo`, `if (follow && args.includes("--json")) fail("status --json prints one document; -f/--follow repaints a live view — drop one of them");`. After `requireReadyRepo` and `parseRoleListScope`, insert `if (follow) { await followStatus(root, scope, seams); return; }` ahead of the existing json/text branches.
   - `async function followStatus(root: string, scope: string[] | null, seams: StatusFollowSeams): Promise<void>` (the return type `parseRoleListScope` in src/cli/cli-args.ts gives): `const tty = seams.tty ?? process.stdout.isTTY === true;` and `const interval = seams.intervalMs ?? STATUS_FOLLOW_INTERVAL_MS;`. A `frame()` closure re-collects `snapshot(root)`, renders `renderStatus(root, scope ? scopeSnapshotToRoles(snap, scope) : snap, tty ? process.stdout.columns : undefined, scope !== null)` and writes `tty ? "\x1b[H\x1b[2J" + text + "\n" : text + "\n\n"` to stdout. Call `frame()` once, then `await new Promise<void>((resolve) => { const timer = setInterval(frame, interval); startParentDeathWatch(() => { clearInterval(timer); resolve(); }, { ...(seams.ppid ? { ppid: seams.ppid } : {}), ...(seams.intervalMs !== undefined ? { intervalMs: seams.intervalMs } : {}) }); });`.
   - Extend `cmdStatus`'s doc comment with the `-f/--follow` line and its stop rule.
2. src/cli/help.ts, the `status` stanza: change the usage line to `tumwater status [--role <id>[,<id>...]] [-f/--follow] [--json]` and add `; -f/--follow repaints the table until Ctrl+C or the process that started it exits, so a backgrounded follow does not outlive its parent` before the trailing team-wide-header sentence.
3. docs/cli.md, the `tumwater status` clause of the "Check state" row: add `[-f/--follow]` after `[--role <id>[,<id>...]]` and, after "works with `--json`", add: "-f/--follow repaints the table every couple of seconds until Ctrl+C or its parent process exits (a backgrounded follow does not outlive its parent, like `logs -f`); it refuses `--json`".

**Files touched.** src/cli/cli-query-commands.ts, src/cli/help.ts, docs/cli.md, test/status-follow.test.ts (new).

**Acceptance criteria.**
- test/status-follow.test.ts (new), modelled on test/history-follow.test.ts's in-process follow with the `ppid`/`intervalMs` seams and test/cli.test.ts's status setup: `const repo = makeRepo(); await initProject(repo, "status follow");` then the runner-flush delay, then `captureStdout()`.
  - "status -f repaints until its parent exits, then prints nothing": start `cmdStatus(repo, ["-f"], { ppid: () => parent, intervalMs: 5, tty: false })` with a local `let parent = 4242; let done = false;`, wait about 60 ms, and assert the captured output has at least two `tumwater ·` header occurrences (two or more frames) and the tells of the non-TTY shape (no `\x1b[H\x1b[2J`). Then set `parent = 1`, poll (the test/helpers/wait.js `sleep`) until `done`, record `const before = cap.out()`, wait about 30 ms, and assert `cap.out() === before` (nothing printed after the follow ended). `cap.restore()` in `finally`.
  - "status -f --role keeps only the listed role's rows": the same harness with `["--role", "feature", "-f"]`, wait about 60 ms, and assert the captured output contains `feature` and does not contain `clean` (the fresh project has no attention banner naming another role); then stop via the parent flip.
  - "status -f --json is refused": `await expectFailAsync(() => cmdStatus(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }))` and assert the message matches `/-f\/--follow repaints a live view/`; assert the captured stdout holds neither a table header nor a frame.
  - "status -f clears the screen only on a TTY": run once with `tty: true` (wait about 20 ms, stop) and assert the output starts with `"\x1b[H\x1b[2J"`; run once with `tty: false` and assert the output does not contain `"\x1b[H\x1b[2J"`.
  - The existing test/cli.test.ts `status` and `status --json` tests pass unchanged (bare status and `--json` keep their current shapes), and `rejectUnknownArgs` still refuses an unknown status flag.
- `npm run test:gate` is green.

## Done
