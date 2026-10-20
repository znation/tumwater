# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-19 by plan: merging this makes the live tumwater.json's `claude/…` model ids a load error, so the operator first migrates it — `model` loses the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }` (valid once parts 1/5-2/5 land) — then removes this note**

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

### Shutdown drain: an unwritable events feed no longer makes drainInFlightWork reject before the merge it announces has settled (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/run/run-timing.ts + test/run-timing-edges.test.ts + docs/invariants.md)

**Goal.** `runOrchestrator` (src/orchestrator/orchestrator.ts) calls `drainInFlightWork` (src/run/run-timing.ts) from its poll loop's `finally`. Every other event write in that function goes through `bestEffortEventLogger`'s `emit`/`warn`. run-timing.ts does not: it imports the throwing `warnEvent`, and calls it once in `drainInFlightWork`'s operator-stop branch (`shutdown waiting on the merge in progress for …`) and three times in `awaitMergeForHandoff` (the restart hand-off's announce, abort and abandon lines). When the events feed cannot be written (ENOSPC, EACCES), the first of those calls throws. That one throw does four things:
- the drain stops before the merge it announces has settled, which `drainInFlightWork`'s own doc comment says must not happen;
- the `finally` stops early, so `orchestrator_stop` is not emitted, `notifier.dispose()` does not run, and orchestrator.json (`infoFile`) is not removed;
- `runOrchestrator` rejects;
- a restart loses its `{ restart: true }` result.

Reproduced on 2026-10-20 with a scratch test. With `patchFsMethod("appendFileSync", …)` throwing `errnoError("ENOSPC")` for paths ending in `events.jsonl`, `drainInFlightWork(root, new Set(), new Set(), [merge(task, ["clean"])], false, 5000, () => {})` rejected with `ENOSPC` within 50 ms, while `task` was still pending.

**Approach.**
1. In src/run/run-timing.ts, import `warnEventBestEffort` instead of `warnEvent` from ../events/events.js. Replace all four `warnEvent(` calls with `warnEventBestEffort(`, keeping the same arguments and message text. `warnEventBestEffort` already writes the warning's text to stderr when the feed cannot be written.
2. Update the doc comments of `drainInFlightWork` and `awaitMergeForHandoff`, one sentence each: their announcements are best-effort, and an events feed that cannot be written does not shorten the wait.
3. Leave the waiting logic, `HANDOFF_MERGE_WINDOW_MS` and src/orchestrator/orchestrator.ts as they are.

**Files touched.** src/run/run-timing.ts, test/run-timing-edges.test.ts, docs/invariants.md.

**Acceptance criteria.**
- `grep -n 'warnEvent(' src/run/run-timing.ts` finds nothing (`warnEventBestEffort(` does not match that pattern).
- New test in test/run-timing-edges.test.ts, "an operator stop with an unwritable events feed still waits out the merge before it returns". Install the fault from the Goal (`patchFsMethod` and `errnoError` from test/helpers/fs-faults.ts) and undo it in a `finally`. Run the operator-stop call from the Goal with a merge task the test resolves by hand. Assert that the drain has not settled after `flushImmediate()` (test/helpers/wait.js). Then resolve the task and assert that the drain resolves rather than rejects. Before the fix the drain rejects with ENOSPC.
- A second test in the same file, "a restart's hand-off with an unwritable events feed still aborts past its window and resolves". Use the same fault and the file's `scriptedTimers`, first giving it the `fire()` member that test/run-timing.test.ts's copy has (it runs the oldest pending window). Run `drainInFlightWork(root, new Set(), new Set(), [merge(task, ["clean"])], true, 50, abort, timers.after)`. Fire the first window, then assert that `abort` ran once. Resolve the task and assert that the drain resolves.
- The existing tests in test/run-timing.test.ts, test/run-timing-edges.test.ts and test/orchestrator-seams.test.ts pass unchanged.
- docs/invariants.md: in the existing "Run timing" section, directly after INV-BL2, add `### INV-BL3: an events feed that cannot be written never shortens the shutdown drain or makes it reject`. Give it Guarantee, Binds (`src/run/run-timing.ts`: `drainInFlightWork`, `awaitMergeForHandoff`) and Pinned by (the two new test names). Before writing, run `grep -n '^### INV-BL' docs/invariants.md` and check that BL3 is still free.
- `npm run test:gate` passes, and both cited test names exist verbatim (`grep -rF` them in test/).

## Done
