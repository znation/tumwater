# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role, test migration split out into parts 4b/5 and 4c/5 2026-10-20 by the plan role; requires parts 3/5–4/5, part 4b/5 and part 4c/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**User decision 2026-10-20 (recorded by the director role): merge this without waiting for the operator to migrate tumwater.json first. The break when the live config reloads is accepted; the operator fixes it after the merge. The migration is: `model` drops the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }`. Each load error must name that exact edit, because the operator works from those messages.**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (its `isBackendId(provider)` branch) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule (its `isBackendId(provider)` branch goes); a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isBackendId(seam.provider)` fallback goes (part 4c/5 moved the seam fixtures that relied on it). The fallback pair (`fallbackPair`, src/config/config-views.ts) carries only `provider: "claude"` for a non-pi backend today and no explicit `agent`, so retiring the `isBackendId(provider)` branch needs that pair to carry its backend first (found by part 4c/5's probe: the fallback-pair tests failed once the namespace spelling was gone). `BACKEND_IDS`' doc comment (src/config/config-schema.ts) drops "doubles as the selector provider namespace", and `isBackendId`'s drops "the reserved selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -n 'isBackendId(provider)\|isBackendId(seam.provider)\|startsWith("claude-")' src/config/model-selector.ts src/config/config-fallbacks.ts` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field. Parts 4b/5 and 4c/5 moved the other test fixtures, so the test files this part edits are the ones its heading lists; `npm test` passes.

### `GET /api/history?result=<class>[,...]` keeps only the runs in those outcome classes: the dashboard API twin of `tumwater history --result` (planned 2026-10-20 by the plan role; independent of every eligible plan: the `diff --overlaps --path` plan edits `handleDiff` in the same file, a different function; the Overlapping files Role picker plan changes src/ui/gui/gui-client-pending.ts; part 5/5 of the Backend/model split changes src/config and test configs; touches src/gui/gui-endpoints.ts docs/how-it-works.md test/gui-endpoints.test.ts)

**Goal.** `tumwater history --result <class>[,...]` narrows the run listing to outcome classes (merged/none/refused/problems), and `GET /api/run?last=1&result=` already accepts the same list (PLANS-DONE.md "`GET /api/run?role=<id>&last=1…`"). `GET /api/history` (`handleHistory`, src/gui/gui-endpoints.ts) takes `role`, `n`/`sinceMs`/`untilMs`, `grep`, `model` and `summary`, but no `result`. A script asking "feature's failed runs in the last day" has to fetch every row and reclassify them itself, copying `historyClass`. This plan adds `result` to `/api/history`, parsed by the same code `/api/run` uses, so the two endpoints accept and reject the same values.

**Approach.**
1. src/gui/gui-endpoints.ts: extract the class-list loop in `handleRun`'s `last` branch (the `splitCommaList(q.get("result") ?? "")` loop over `parseHistoryResultClass`, with its `result must be one of …${gotSuffix(piece)}${typoSuffix(piece, names)}` 400) into a module-level `function resultClassesQuery(q: URLSearchParams, res: http.ServerResponse): HistoryResultClass[] | null`. It returns the deduplicated classes in first-seen order (`[]` when `result` is absent, empty, or only commas, meaning "filter nothing"), or `null` once it has sent the 400. Give it a one-line doc comment naming both callers. `handleRun` calls it and returns on `null`. Its `classFilter = classes.length ? classes : null` line and its 404 wording stay as they are.
2. `handleHistory`: call `resultClassesQuery` first, before the `sinceMs` branch, and return on `null`. A bad class is then a 400 in both shapes, and it comes before any other 400 that `handleHistory` sends. Add `historyClass` to the existing `../history/history-data.js` import. Define `const inClasses = (rows: RunRow[]): RunRow[] => (classes.length ? rows.filter((r) => classes.includes(historyClass(r.result))) : rows);` beside `onModels`. Apply it after grep and before `onModels` in both the window branch and the count branch, which is the CLI's order (`cmdHistory`: grep, then `--result`, then `--model`). `summary`/`modelSummary` then fold the narrowed rows. With `result` absent the response is the same as today's. Add one sentence to the doc comment: "`result=<class>[,...]` keeps only the runs in those outcome classes (the `history --result` rule, parsed by resultClassesQuery like /api/run's), after `grep` and before `model`; an unknown class is a 400."
3. docs/how-it-works.md: after the "`GET /api/run?role=<id>&last=1` serves the role's newest completed run … (`newestRunNumber`, shared)." sentence, add: "`GET /api/history?result=<class>[,...]` keeps only the runs in those outcome classes, after `grep` and before `model`, the rows `tumwater history --result` lists." When this was planned, `grep -n 'api/history' docs/invariants.md` printed nothing, so the plan claims no invariant ID.

The dashboard History view keeps filtering its outcome buckets client-side (`historyClass` in src/ui/gui/gui-client-history.ts). This plan does not change the client.

**Files touched.** src/gui/gui-endpoints.ts, docs/how-it-works.md, test/gui-endpoints.test.ts.

**Acceptance criteria.**
- New test "handleHistory ?result keeps outcome classes in both shapes, before model and the summaries fold" in test/gui-endpoints.test.ts. It reuses the fixture shape of "handleHistory ?model keeps exact selectors in both shapes, before the summaries fold" (feature `changed` on m-b, clean `no_change` on m-a, qa `error`) and asserts:
  - `?n=50&result=problems` serves only qa.
  - `?n=50&result=merged,none` serves feature and clean.
  - `?sinceMs=3600000&result=none` serves only clean.
  - `?n=50&result=merged&model=m-a` serves no rows with status 200, which shows the filters compose.
  - `?n=50&result=none&summary=1` has `summary` equal to `summarizeRunRows` of the served rows.
  - `?n=50&result=` and `?n=50&result=,` serve all 3 rows.
  - `?n=50&result=bogus` and `?sinceMs=3600000&result=bogus` are 400s whose error matches `/result must be one of/`.
- The existing "handleRun ?last serves the newest run, narrowed by result and model" test passes unchanged. That shows the extraction kept `/api/run`'s parsing and wording.
- `npm run test:gate` passes.

## Done
