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

### Dashboard Activity past windows: "◀ Earlier" and "Later ▶" buttons on the Activity card step a Last hour / 6 hours / day window back one window length at a time through `GET /api/logs?sinceMs=&untilMs=` (planned 2026-10-20 by the plan role; independent of every eligible plan. It touches src/ui/gui/gui-client-feed.ts, src/ui/gui/gui-page.ts, test/gui-client-team.test.ts and docs/how-it-works.md's Activity sentence. "TUI History past windows" touches only TUI files, their tests, docs/cli.md and docs/how-it-works.md's History sentence)

**Goal.** `handleLogs` (src/gui/gui-endpoints.ts) already serves a bounded past window, `?sinceMs=S&untilMs=U` validated by `untilMsQuery` (src/gui/gui-args.ts). The Activity card's `#feedwindow` select (PLANS-DONE.md "Dashboard Activity window picker") only asks for trailing windows. So "the last hour" can never become "the hour before that", although the History, Usage and Failures views all step this way. This plan gives the Activity card the same ◀ Earlier / Later ▶ buttons, the twin of `tumwater logs --since --until`.

**Behavior, decided** (all logic in src/ui/gui/gui-client-feed.ts, inside the `// activity:start` / `// activity:end` region):
- State: `let feedStep = 0;` beside `feedWindow`. It is view state and is not persisted, like History's `histStep`, so a reload returns to the trailing window. Its comment says: how many window lengths back the window ends.
- Helpers beside `FEED_WINDOWS`:
  - `const FEED_MAX_MS = 604_800_000;` mirrors the server's `LOGS_SINCE_MAX_MS` (src/events/event-window.ts). A comment says the two must agree, and a test pins it.
  - `feedCanStepEarlier(windowMs, step)` returns true exactly when `windowMs` is non-zero and `(step + 2) * windowMs <= FEED_MAX_MS`. So Last day steps back at most 6 times, 6 hours 27 times and Last hour 167 times. It takes the number (`Number(feedWindow)`).
  - `feedSpan(ms)`: "1 hour"/"N hours", or "1 day"/"N days" for a whole number of days. It uses the same rule as `histSpan` (src/ui/gui/gui-client-history.ts). That helper lives in another region, which `feedScope` does not load, so the feed keeps its own copy.
  - `feedWindowPhrase()`: at step 0 it returns the window's FEED_WINDOWS phrase ("the last hour"). Otherwise it returns `"between " + feedSpan((feedStep + 1) * w) + " and " + feedSpan(feedStep * w) + " ago"`, where `w = Number(feedWindow)`. This is the History view's wording.
- `feedLogsQuery()`: when `feedWindow` is set and `feedStep > 0`, the first params are `"sinceMs=" + (feedStep + 1) * w` and `"untilMs=" + feedStep * w`, followed by grep and role in their current order. In every other case the URL is exactly what it is today.
- renderFeed:
  - The re-arm key becomes `feedRole + "\u0000" + feedText + "\u0000" + feedWindow + "\u0000" + feedStep`, so a step change re-arms `searchFeed()` the way a window change does.
  - The live-window refetch branch also requires `feedStep === 0`. A stepped window ends in the past, so a new event can never fall inside it, and polls never refetch it.
  - The two windowed empty states use `feedWindowPhrase()` in place of `windowPhrase`. So a stepped empty window reads "No events between 2 hours and 1 hour ago", and with a filter set it reads "No events match this filter between 2 hours and 1 hour ago". Build each head as `"No events " + (feedStep ? "" : "in ") + phrase` and `"No events match this filter " + (feedStep ? "" : "in ") + phrase`, so step 0 keeps today's exact wording.
  - When `feedStep > 0` and `feedResults !== null`, paint `"<li class='empty muted feed-note'>Showing events " + feedWindowPhrase() + ".</li>"` first in the panel, ahead of the sparse note.
  - At the end of renderFeed, set the controls: `$("feedstep").style.display = feedWindow ? "" : "none"`, `$("feedearlier").disabled = !feedCanStepEarlier(Number(feedWindow), feedStep)`, and `$("feedlater").disabled = feedStep === 0`.
- Listeners, registered at load next to the `#feedwindow` one:
  - A `click` listener on `$("feedearlier")` does `feedStep += 1` only when `feedCanStepEarlier(Number(feedWindow), feedStep)`.
  - A `click` listener on `$("feedlater")` does `feedStep = Math.max(0, feedStep - 1)`.
  - Each then calls `renderFeed(lastStatus)` when `lastStatus` is set.
  - The `#feedwindow` change listener and `clearFeedFilter()` set `feedStep = 0`. The Role picker, Search box, Notable/All choice and type chips keep the step.
- Update the region's head comment and the module doc comment with one clause each: on a window, ◀ Earlier / Later ▶ step it back by its own length through `?sinceMs=&untilMs=`, the twin of `tumwater logs --since --until`.

**Page.** In src/ui/gui/gui-page.ts, directly after the `#feedwindow` `<label>`, add `<span id="feedstep" style="display:none"><button type="button" class="btn btn-sm" id="feedearlier">◀ Earlier</button><button type="button" class="btn btn-sm" id="feedlater">Later ▶</button></span>`.

**Docs.** In docs/how-it-works.md, after the sentence ending "…the twin of `tumwater logs --since`, refreshing when a new event arrives.", add this sentence: its ◀ Earlier / Later ▶ buttons step that window back by its own length through `/api/logs?sinceMs=&untilMs=`, the twin of `logs --since --until`, and a stepped window does not refresh.

**Tests** (test/gui-client-team.test.ts):
- `feedScope`'s default stub element gains `style: { display: "" }` and `disabled: false`, so renderFeed can set the controls. Tests fire the buttons through its existing `fire(id, type, ev)` helper (`fire("feedearlier", "click", {})`).
- "the Activity step buttons walk a window back with untilMs and Later returns": recalled `feed-window` 3600000, with `getJson` recording paths and `lastStatus` a payload.
  - After `renderFeed` + `feedSettle()`, the calls are `["/api/logs?sinceMs=3600000"]`, `els.feedstep.style.display === ""`, `els.feedlater.disabled === true` and `els.feedearlier.disabled === false`.
  - Fire `feedearlier:click` and settle. The last call is `/api/logs?sinceMs=7200000&untilMs=3600000`, `els.feedlater.disabled === false`, and the panel matches /Showing events between 2 hours and 1 hour ago/.
  - Fire `feedlater:click` and settle. The last call is `/api/logs?sinceMs=3600000` again.
- "a stepped window composes with Role and Search": recalled window 86400000, role qa, grep boom. One Earlier click gives the last call `/api/logs?sinceMs=172800000&untilMs=86400000&grep=boom&role=qa`.
- "a stepped window never refetches on a new event": window 1h, step 1 (after an Earlier click, settled). Render a payload whose last eventItems ts is newer, then `sleep(10)`. The call count is unchanged.
- "a window change and Clear filter reset the step": after one Earlier click, firing `feedwindow:change` with `target.value` "21600000" gives the last call `/api/logs?sinceMs=21600000`. After another Earlier click, `scope.clearFeedFilter()` leaves `els.feedstep.style.display === "none"`, and a later Earlier click is ignored because `feedCanStepEarlier(0, …)` is false (no new call after settling).
- "Earlier stops at the server's logs cap": import `LOGS_SINCE_MAX_MS` from `../src/events/event-window.js`. With window 86400000, fire Earlier 6 times, settling after each. The last call is `/api/logs?sinceMs=604800000&untilMs=518400000` and `els.feedearlier.disabled === true`. A seventh click issues no new call. Add `"FEED_MAX_MS"` to `feedScope`'s exported names and assert it equals `LOGS_SINCE_MAX_MS`.
- "a stepped empty window names its bounds": window 1h, step 1, getJson answering `{ events: [], covered: true, note: "" }`. The panel matches /No events between 2 hours and 1 hour ago/.
- Extend "the Activity filter persists its choices and the page ships the controls in the card head": the card head matches `/id="feedearlier"/` and `/id="feedlater"/`, and `GUI_CLIENT_FEED_JS` does not match `/store\("feed-step"/`.
- Every existing Activity feed test passes unchanged. That includes "a windowed feed refetches only when a new event arrives" and every no-window query URL.

**Acceptance criteria.**
- With a window chosen, the Activity card head shows ◀ Earlier / Later ▶. Earlier fetches `/api/logs?sinceMs=(k+1)·len&untilMs=k·len[&grep=][&role=]` and paints that slice under a "Showing events between X and Y ago." note. Later steps back toward the trailing window and is disabled at step 0. Earlier is disabled once the next window's `sinceMs` would pass the server's 7-day cap. With Recent, the buttons are hidden.
- A window change or Clear filter resets the step. Role, Search, Notable/All and type chips keep it. The step is never persisted. A stepped window never refetches on a status poll.
- At step 0, every request URL and render matches today's.
- No server file changes. `npm run test:gate` passes.

### TUI Usage and Failures past windows: `Ctrl+P` on the Usage or Failures pane steps the Ctrl+E trailing window back one window length at a time, wrapping to the trailing window after the 7-day cap. This is the terminal twin of the dashboard Usage/Failures ◀ Earlier buttons and `tumwater report --since --until` (planned 2026-10-20 by the plan role; independent of every eligible plan in behavior. It shares src/ui/tui/tui-panes.ts, tui-keys.ts, tui-frame.ts and the docs/cli.md `Ctrl+P` rows with the in-flight "TUI History past windows", so rebase onto it if that one lands first)

**Goal.** `collectReportSince(root, sinceMs, role, untilMs)` (src/report/report-data.ts) and `collectFailureReportSince(root, sinceMs, role, untilMs)` (src/failure/failure-data.ts) already collect a bounded past window. `renderSinceReportMarkdown` and `renderFailureMarkdown` already label that window with `boundedWindowLine` (src/text/datetime.ts): `window: 2h to 1h ago (since …, until …)`. `tumwater report --since 2d --until 1d` and the dashboard's Usage/Failures step buttons (PLANS-DONE.md "Dashboard Usage and Failures past windows") use them. The TUI's Usage and Failures panes only have the Ctrl+E cycle of trailing windows (`REPORT_WINDOWS`, src/ui/tui/tui-pane-session.ts), so the terminal cannot show "yesterday's spend". This plan adds a step that moves the window back by its own length.

**Key choice.** `Ctrl+P` has no meaning on Usage (view N+2) or Failures (N+3) today. `createTuiPanes`'s `handleKey` (src/ui/tui/tui-panes.ts) sends every Ctrl+P to `history.handleKey`, whose arm returns false off the History view. The provider-caps editor's Ctrl+P (`createProviderCapsEditor`, src/ui/tui/tui-editor-provider-caps.ts) only acts on view 0. The transcript pause arm (src/ui/tui/tui-editor-pause.ts) only acts on views 1..N. "Previous" means an earlier window here, as it will on History. The step wraps like every other TUI cycle, so no "later" key is needed.

**Approach.**
1. src/ui/tui/tui-pane-session.ts: beside `REPORT_WINDOWS`, export a pure helper `steppedWindowBounds(windowMs: number | null, step: number): { sinceMs: number | null; untilMs: number | undefined }`.
   - It returns `{ sinceMs: windowMs, untilMs: undefined }` when `windowMs` is null or `step` is 0.
   - Otherwise it returns `{ sinceMs: (step + 1) * windowMs, untilMs: step * windowMs }`.
   - If "TUI History past windows" has landed, its `historyWindowBounds` (src/ui/tui/tui-pane-history.ts) computes the same thing. Make it call this helper or replace it, so the two panes cannot drift.
2. src/ui/tui/tui-pane-report.ts, `createReportPane`:
   - Add `let reportStep = 0;` next to `reportWindow`. Its comment says how many window lengths back the window ends; it is session-only, and 0 means the trailing window.
   - `usagePaneCache` and `failuresPaneCache` gain a trailing `step: number` parameter. When `sinceMs !== null`, they take `const b = steppedWindowBounds(sinceMs, step)` and pass `b.sinceMs!` and `b.untilMs` to `collectReportSince` / `collectFailureReportSince` as the 4th argument. With step 0, `untilMs` is `undefined`, so the call matches today's call. `recompute` passes `reportStep`.
   - The Ctrl+E arm sets `reportStep = 0` before `nextInCycle`.
   - Add a Ctrl+P arm. It applies when `key.ctrl && key.name === "p"`, the view is `session.roleIds.length + 2` or `+ 3`, and `promptLineFree(ctx.es)` holds. Restate the same editor guards as the Ctrl+E arm.
     - If `reportWindow === null`, call `session.flashMessage("pick a window with Ctrl+E to step back through earlier windows")`.
     - Else if `(reportStep + 2) * reportWindow <= REPORT_SINCE_MAX_MS` (src/events/event-window.ts), do `reportStep += 1`.
     - Otherwise set `reportStep = 0` and flash `"oldest window reached; back to the last " + cycleLabel(REPORT_WINDOWS, reportWindow)`.
     - In the last two cases call `recompute()`, which resets the scroll as Ctrl+E does. Return true with `session.requestRender()`. Off those two views, return false.
   - Ctrl+G and `dropScopes` keep the step, as they keep the window. Update the module's top doc comment to name Ctrl+P.
   - `state()` gains `reportStep`.
3. src/ui/tui/tui-panes.ts:
   - Change the Ctrl+P routing line so that on views `roleIds.length + 2` and `+ 3` it returns `report.handleKey?.(key, ctx) ?? false`. Every other view still goes to `history.handleKey`. Add a one-line comment.
   - Map `reportStep: rep.reportStep` beside `reportSince`.
   - src/ui/tui/tui-keys.ts: add `reportStep: number` to the state type beside `reportSince`, with a doc comment.
4. src/ui/tui/tui-frame.ts: in the usage/failures hint list, right after the Ctrl+E pair, add `["Ctrl+P", "earlier window"]` when `view.window` is non-null. The view type does not change; the pane body's window line names the stepped span.
5. Docs:
   - docs/cli.md TUI key table: add a row `| `Ctrl+P` | Usage, Failures | with a window chosen (Ctrl+E), step it back one window length (the `report --since --until` window), wrapping to the trailing window after the 7-day cap |`. Put it after the `Ctrl+P` History row. Read the rows with `grep -n` and `cut -c1-200` first.
   - docs/how-it-works.md: after the sentence "`Ctrl+E` cycles a session-only trailing window for the Usage and Failures panes …", add one sentence. It says that `Ctrl+P` steps that window back by its own length through the same `--until` bound `tumwater report --since --until` uses, that the body's window line names the span, and that Ctrl+E returns to the trailing window.

**Tests.**
- test/tui-keys.test.ts, beside "Ctrl+E cycles the Usage and Failures panes' trailing report window and resets the scroll", using its `makeKeys(root, () => now)` / `writeEvents` setup:
  - "Ctrl+P on Usage steps the report window back one window length, and Ctrl+E resets it". Seed `feature` `run_end` events with `result: "error"`: run 1 at `now - 30m` with `tokens: 100`, run 2 at `now - 90m` with `tokens: 200`, and run 3 at `now - 2.5d` with `tokens: 300`. Keep the existing test's `// retired-name-ok` comments on the `loop:` fields.
    - Open Usage and press Ctrl+E for 1h. Ctrl+P gives `reportStep` 1, and `paneCache` matches `/window: 2h to 1h ago/` and `/200 output tokens/`, and does not match `/100 output tokens/`.
    - Ctrl+E three times (6h, 1d, 7d) then once more wraps to default with step 0. Ctrl+E twice more reaches 6h, then once more 1d. Two Ctrl+P presses give step 2, `/window: 3d to 2d ago/` and `/300 output tokens/`.
    - Ctrl+T to Failures keeps step 2, and the digest matches `/window: 3d to 2d ago/` and `/· 1 runs/`.
  - "Ctrl+P wraps the stepped report window after the 7-day cap". On 1d, after six Ctrl+P presses `reportStep` is 6 and `paneCache` matches `/window: 7d to 6d ago/`. A seventh press sets step 0, and the flash matches `/oldest window reached; back to the last 1d/`. On 7d, one Ctrl+P leaves step 0 and flashes the same wording with `7d`. Read the flash the way neighbouring flash tests in that file do.
  - "Ctrl+P on the default report window only flashes the Ctrl+E hint": `reportStep` stays 0, `paneCache` is unchanged, and the flash matches `/Ctrl\+E/`.
  - The existing Ctrl+E test and every History Ctrl+P test must pass unchanged.
- test/tui-frame.test.ts, beside the usage hint assertion: `hint({ kind: "usage", scope: null, window: "1h" })` and the failures twin match `/Ctrl\+P earlier window/`. With `window: null` they do not.
- A unit test of `steppedWindowBounds`, in the test file that already tests tui-pane-session.ts exports (find it with grep), or in test/tui-keys.test.ts: `(3_600_000, 0)` → `{ sinceMs: 3_600_000, untilMs: undefined }`, `(86_400_000, 2)` → `{ sinceMs: 259_200_000, untilMs: 172_800_000 }`, `(null, 3)` → `{ sinceMs: null, untilMs: undefined }`.

**Acceptance criteria.**
- On Usage or Failures with a trailing window chosen, each Ctrl+P moves the body to the window `(k+1)·len` to `k·len` ago. It is collected through `collectReportSince` / `collectFailureReportSince` with `untilMs`, and the body's window line reads `window: X to Y ago`. The hint shows `Ctrl+P earlier window`.
- The step wraps to 0, with a flash, once the next window's start would pass `REPORT_SINCE_MAX_MS`. So 1h steps up to 167 times, 6h up to 27, 1d up to 6, and 7d never.
- Ctrl+E resets the step. Ctrl+G and a view change keep it. With the default window, Ctrl+P only flashes the Ctrl+E hint. Step 0 calls the collectors exactly as today.
- Ctrl+P on every other view behaves as before: Activity caps, Transcript pause, History trail.
- docs/cli.md and docs/how-it-works.md describe the key. `npm run test:gate` passes.

## Done
