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

### Dashboard Usage and Failures past windows: "◀ Earlier" and "Later ▶" buttons step a 1h/6h/1d window back one window length at a time through `/api/report` and `/api/failures` `?sinceMs=&untilMs=` (planned 2026-10-20 by the plan role; independent of every eligible plan. It touches src/ui/gui/gui-client-report.ts, test/gui-report.test.ts and the History-step sentence of docs/how-it-works.md. "Dashboard Activity window picker" touches src/ui/gui/gui-client-feed.ts, src/ui/gui/gui-page.ts, test/gui-client-team.test.ts and docs/how-it-works.md's Activity paragraph)

**Goal.** `handleReport` and `handleFailures` (src/gui/gui-endpoints.ts) already serve a bounded past window: `?sinceMs=S&untilMs=U`, validated by `untilMsQuery` (src/gui/gui-args.ts). They render it as Markdown whose window line comes from `boundedWindowLine` (src/report/report-render.ts, src/failure/failure-render.ts). No dashboard control uses that window yet. The Usage and Failures toolbars offer trailing windows only (`REPORT_SINCE_CHOICES` 1h/6h/1d in src/ui/gui/gui-client-report.ts), so "the last day" can never become "yesterday". This plan gives both views the step buttons that "Dashboard History past windows" (PLANS-DONE.md) gave History. A `1d` window stepped back once asks for `?sinceMs=172800000&untilMs=86400000`, the browser twin of `tumwater report --since 2d --until 1d` (and `report --failures --since 2d --until 1d`). The change is client-only. Both views are configurations of the one `windowView` scaffold, so a single change covers both.

**Approach** (all in src/ui/gui/gui-client-report.ts, inside the `// view-scaffold:start` / `:end` region):
1. Pure helpers next to `REPORT_SINCE_CHOICES`:
   - `const REPORT_MAX_MS = 604_800_000;` mirrors the server's `REPORT_SINCE_MAX_MS` (src/events/event-window.ts), the cap `sinceMs` rides on both endpoints. A comment says the two must agree, and a test pins it.
   - `reportCanStepEarlier(sinceMs, step)` is true exactly when `sinceMs` is truthy and `(step + 2) * sinceMs <= REPORT_MAX_MS`, so the next earlier window's `sinceMs` stays under the cap. `1d` steps back at most 6 times, `6h` 27 times and `1h` 167 times.
   - `reportEndpoint(resource, days, role, sinceMs, step)` gains a trailing `step`. When `sinceMs` is set and `step > 0`, the window part is `"/api/" + resource + "?sinceMs=" + (step + 1) * sinceMs + "&untilMs=" + step * sinceMs`. Otherwise the URL is exactly what it is today (step `0` or `undefined`, and the `?days=` shape always ignores the step). `&role=` follows as now.
2. `viewHead`: when `sinceChoices` is non-empty, render a `<span id='<pickerId>step' style='display:none'>` right after the segmented control (before Refresh). It holds `<button type='button' class='btn btn-sm' data-step='earlier'>◀ Earlier</button><button type='button' class='btn btn-sm' data-step='later'>Later ▶</button>`. A view without `sinceChoices` renders nothing new.
3. `windowView`:
   - Add `let step = 0;`, view state that is not persisted (like History's `histStep`), so a reload returns to the trailing window.
   - `fetchView` passes `step` as a fourth argument to `o.endpoint`. Both configs become `endpoint: (days, role, sinceMs, step) => reportEndpoint("report"|"failures", days, role, sinceMs, step)`.
   - After `buildOnce` and the `markActive` calls, `fetchView` does `const stepEl = $(o.pickerId + "step"); if (stepEl) { … }`. Inside it sets `stepEl.style.display = sinceMs ? "" : "none"` and sets each of the span's two buttons' `.disabled` (found with `stepEl.querySelector("[data-step='earlier']")` / `"[data-step='later']"`): Earlier to `!reportCanStepEarlier(sinceMs, step)`, Later to `step === 0`. The `if (stepEl)` guard keeps the existing tests' `$` stubs working, as `renderHistory` does for `#histstep`.
   - In `wireClicks`' click handler, check `clickClosest(ev, "[data-step]")` first. `earlier` does `step += 1` only when `reportCanStepEarlier(sinceMs, step)`. `later` does `step = Math.max(0, step - 1)`. Either then calls `fetchView()` and returns. The `[data-since]` and `[data-days]` branches reset `step = 0` before they fetch. The Role change, Refresh and Usage's throttled event-driven refetch keep the step.
4. Extend the module's top doc comment and the `windowView` comment with one sentence each: on a trailing window, ◀ Earlier / Later ▶ step it back by its own length through `?sinceMs=&untilMs=`, the twin of `report --since --until`.
5. docs/how-it-works.md: directly after the sentence "On a trailing window, the dashboard History toolbar's ◀ Earlier / Later ▶ buttons step that window back…", add the sentence: the dashboard Usage and Failures toolbars carry the same buttons on their 1h/6h/1d windows, through `/api/report` and `/api/failures` `?sinceMs=&untilMs=`, the twin of `report [--failures] --since --until`.

**Tests** (test/gui-report.test.ts):
- Update "the Usage and Failures views fetch their window on activation, never on a timer". Its two `GUI_PAGE` regexes pin `endpoint: (days, role, sinceMs) => reportEndpoint(…)` and must now pin the `(days, role, sinceMs, step)` form.
- New "reportEndpoint steps a since window back by its own length with untilMs". Use `clientScope(["panel-build", "view-scaffold"], ["reportEndpoint", "reportCanStepEarlier", "REPORT_MAX_MS"], inject)` with the same `document`/`$`/`recall`/`store`/`markActive`/`clickClosest`/`icon` stubs as the blurb test, because the region wires both views' clicks at load. Assert:
  - `reportEndpoint("report", 14, "", 86400000, 1)` → `"/api/report?sinceMs=172800000&untilMs=86400000"`.
  - `reportEndpoint("failures", 14, "clean", 3600000, 2)` → `"/api/failures?sinceMs=10800000&untilMs=7200000&role=clean"`.
  - Step `0` and `undefined` with `sinceMs` 86400000 → `"/api/report?sinceMs=86400000"`.
  - `reportEndpoint("report", 7, "", null, 3)` → `"/api/report?days=7"`.
- New "reportCanStepEarlier stops at the server's sinceMs cap". Import `REPORT_SINCE_MAX_MS` from `../src/events/event-window.js` and assert it equals the scoped `REPORT_MAX_MS`. Then assert `(86400000, 5)` → true, `(86400000, 6)` → false, `(21600000, 26)` → true, `(21600000, 27)` → false, and `(null, 0)` → false.
- New "the report step buttons walk a since window back and a since or day click resets it", modelled on "the Usage trailing-window control fetches ?sinceMs…" with the same whole-blob `new Function` seam and `recall` returning `"3600000"` for `usage-since`. Add a `usagewindowstep` element whose `querySelector` returns two stub buttons with a `disabled` field, and let `clickClosest` answer `[data-step]` from a per-phase variable. Assert:
  - The first fetch is `/api/report?sinceMs=3600000`, the span's `style.display` is `""`, Later is disabled and Earlier is not.
  - An `earlier` click fetches `/api/report?sinceMs=7200000&untilMs=3600000` and enables Later.
  - A `later` click fetches `/api/report?sinceMs=3600000` again.
  - After another `earlier`, a `[data-days]` click (`7`) fetches `/api/report?days=7` and leaves the span's `style.display` at `"none"`.
  - The head HTML (`els.report.innerHTML`) contains `id='usagewindowstep'` and `data-step='earlier'`.
- The existing tests in the file pass unchanged apart from the two regexes above.

**Acceptance criteria.**
- With a 1h/6h/1d window active, the Usage and Failures toolbars show ◀ Earlier / Later ▶. Earlier refetches `?sinceMs=(k+1)·len&untilMs=k·len` on that view's endpoint, with the role scope kept. Later steps back toward the trailing window and is disabled at step 0. Earlier is disabled once the next step's `sinceMs` would pass the server's 7-day cap. With a day window active, the buttons are hidden.
- Choosing a since or day button resets the step to 0. Role, Refresh and Usage's throttled refetch keep it. The step is never persisted.
- The stepped body is the server's bounded Markdown, whose window line already names the bounds, so the client adds no note of its own. Step 0 requests and renders exactly as today.
- No server file changes. `npm run test:gate` passes.

## Done
