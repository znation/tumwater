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

### TUI History past windows: `Ctrl+P` with the run trail off steps the History pane's trailing window back one window length at a time, wrapping to the trailing window after the 7-day cap, the terminal twin of the dashboard History ◀ Earlier buttons and `tumwater history --since --until` (planned 2026-10-20 by the plan role; independent of every eligible plan: it touches only TUI files, their tests and the TUI key docs, while "Dashboard Activity window picker" and "Dashboard Usage and Failures past windows" touch src/ui/gui/ files)

**Goal.** `readRunRowsSince(root, sinceMs, role, untilMs)` (src/history/history-data.ts) already serves a bounded past window. `tumwater history --since 2d --until 1d` and the dashboard History view's ◀ Earlier / Later ▶ buttons (PLANS-DONE.md "Dashboard History past windows") use it. The TUI History pane's Ctrl+S window cycle (`HISTORY_WINDOWS`, src/ui/tui/tui-pane-session.ts) only offers trailing windows, so the terminal can never show "yesterday". This plan adds a step that moves the pane's window back by its own length, one press at a time.

**Key choice.** `Ctrl+P` on the History view with the trail off currently falls through to nothing. In `createHistoryPane`'s Ctrl+P arm (src/ui/tui/tui-pane-history.ts), the `!trailMode` case returns false. The Activity caps editor's Ctrl+P is guarded to view 0 (`createProviderCapsEditor`, src/ui/tui/tui-editor-provider-caps.ts), and the Transcript pause editor only acts on a role's view. Off the trail, "previous" means an earlier window; on a trail it keeps its existing meaning, an older run. Like every other TUI cycle it wraps, so no "later" key is needed. Every other free Ctrl letter is already bound on some view (docs/cli.md TUI table). Ctrl+B and Ctrl+F both fire from History today.

**Approach.**
1. src/ui/tui/tui-pane-history.ts, `createHistoryPane`:
   - Add `let historyStep = 0;` next to `historyWindow`. Its comment: how many window lengths back the window ends. It is session-only like the window, and 0 means the trailing window.
   - Add a module-level pure helper `historyWindowBounds(windowMs: number | null, step: number): { sinceMs: number | null; untilMs: number | null }`. It returns `{ sinceMs: windowMs, untilMs: null }` when `windowMs` is null or `step` is 0. Otherwise it returns `{ sinceMs: (step + 1) * windowMs, untilMs: step * windowMs }`. Export it for the tests.
   - `selectPaneRows` gains a trailing `step: number` parameter. The windowed branch calls `readRunRowsSince(session.root, bounds.sinceMs, role, bounds.untilMs)`. `historyPaneCache` gains a `step` parameter and passes it on. Both `historyPaneCache(...)` call sites and the trail's `selectPaneRows(...)` call pass `historyStep`, so Ctrl+N opens, and Ctrl+P on a trail walks, the stepped window's runs.
   - Header: when `sinceMs !== null && step > 0`, the window line reads `"window: between " + durationLabel((step + 1) * sinceMs) + " and " + durationLabel(step * sinceMs) + " ago"`. That is the wording `tumwater logs --since --until` prints (src/cli/log-commands.ts). Import `durationLabel` from src/cli/cli-args.ts, which TUI files already import from (tui-input.ts, tui-editor-pause.ts). It prints whole units, so 30 hours is `30h`; do not use `humanSeconds`, which rounds that to `1d`. When `step` is 0 the line stays `window: last <label>`. The sparse-window note keeps its current condition.
   - Ctrl+P arm: keep the trail branch exactly as it is. When the view is History, the trail is off and `promptLineFree(ctx.es)` holds:
     - If `historyWindow` is null, flash `"pick a window with Ctrl+S to step back through earlier windows"`.
     - If `(historyStep + 2) * historyWindow <= LOGS_SINCE_MAX_MS` (src/events/event-window.ts, the cap `history --since` rides), do `historyStep += 1`.
     - Otherwise set `historyStep = 0` and flash `"oldest window reached; back to the last " + cycleLabel(HISTORY_WINDOWS, historyWindow)`.
     - In the last two cases call `recompute()`, which resets the scroll as Ctrl+S does.
     - The arm then returns true with a render. Off the History view it still returns false.
   - The Ctrl+S arm sets `historyStep = 0` before cycling. Ctrl+G, Ctrl+O, Ctrl+Y, `/` and `reset()` keep the step, the way they keep the window.
   - `state()` gains `historyStep`.
2. src/ui/tui/tui-keys.ts: add `historyStep: number` to the state type, with a doc comment, beside `historySince`. src/ui/tui/tui-panes.ts: map `historyStep: hist.historyStep` beside `historySince`.
3. src/ui/tui/tui-frame.ts: in the History hint list, when `!view.trail && view.since`, add `["Ctrl+P", "earlier window"]` right after the Ctrl+S pair. The view type does not change.
4. Docs:
   - docs/cli.md TUI key table: change the `Ctrl+P` History row's Where cell to `History`. Its text becomes: "on a run trail, the next older run's trail among the pane's filtered runs, wrapping to the newest after the oldest; with the trail off and a window chosen (Ctrl+S), step the window back one window length (the `history --since --until` window), wrapping to the trailing window after the 7-day cap". Read the row with `grep -n` and `cut -c1-200` first.
   - docs/how-it-works.md: after the sentence "On History, `Ctrl+S` cycles the pane's trailing window …", add one sentence. It says that with the trail off, `Ctrl+P` steps that window back by its own length through the same `readRunRowsSince` bound `tumwater history --since --until` uses, that the header names it as `window: between X and Y ago`, and that Ctrl+S returns to the trailing window.
   - Extend `createHistoryPane`'s top doc comment the same way.

**Tests.**
- test/tui-keys.test.ts, next to "Ctrl+S cycles the History pane's trailing window…", using `makeKeys(root, () => now)` and `writeEvents` as that test does:
  - "Ctrl+P off the trail steps the History window back one window length, and Ctrl+S resets it". Seed `run_end` rows for `feature` run 1 at `now - 30m`, run 2 at `now - 90m` and run 3 at `now - 2.5d`. Open History and press Ctrl+S to get 1h. Ctrl+P gives `historyStep` 1, and `paneCache` matches `/window: between 2h and 1h ago/`, contains `feature #2` and not `feature #1`. Ctrl+P again gives step 2. Ctrl+S three times gives `1d` with step 0 and `/window: last 1d/`. Ctrl+P twice gives step 2, `/window: between 3d and 2d ago/` and `feature #3`.
  - "Ctrl+P wraps the stepped History window after the 7-day cap". On `1d`, after six Ctrl+P presses `historyStep` is 6 and the header says `between 7d and 6d ago`. A seventh press sets step 0 and the flash matches `/oldest window reached; back to the last 1d/`. On `7d`, one Ctrl+P leaves step 0 and flashes the same wording with `7d`.
  - "Ctrl+P on the default History window only flashes the Ctrl+S hint": `historyStep` stays 0, `paneCache` is unchanged and the flash matches `/Ctrl\+S/`.
  - "Ctrl+N on a stepped History window opens that window's newest run": on 1h with step 1, Ctrl+N gives a `trailCache` naming run 2.
  - The existing "Ctrl+P with the trail off does nothing…" test (default window) must pass unchanged.
- test/tui-frame.test.ts, beside the history hint assertion: `hint({ kind: "history", since: "1h", result: null, role: null, grep: null, trail: false })` matches `/Ctrl\+P earlier window/`. With `since: null`, and with `trail: true`, it does not.
- A unit test of `historyWindowBounds`: `(3_600_000, 0)` → `{ sinceMs: 3_600_000, untilMs: null }`, `(86_400_000, 2)` → `{ sinceMs: 259_200_000, untilMs: 172_800_000 }`, `(null, 3)` → `{ sinceMs: null, untilMs: null }`.

**Acceptance criteria.**
- On the History view with the trail off and a trailing window chosen, each Ctrl+P moves the rows to the window `(k+1)·len` to `k·len` ago, read through `readRunRowsSince(…, untilMs)`. The pane header names it `window: between X and Y ago`, and the hint shows `Ctrl+P earlier window`.
- The step wraps to 0, with a flash, once the next window's start would pass `LOGS_SINCE_MAX_MS`. So 1d steps up to 6 times, 1h up to 167, and 7d never.
- Ctrl+S resets the step. The trail (Ctrl+N, Ctrl+P on a trail) follows the stepped window's rows. Ctrl+P on a trail behaves as before.
- With no window chosen, Ctrl+P on History only flashes the Ctrl+S hint. Step 0 renders exactly as today.
- docs/cli.md and docs/how-it-works.md describe the key. `npm run test:gate` passes.

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

## Done
