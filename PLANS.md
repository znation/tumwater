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

### Red-main healer: a heal prompt that cannot be queued warns and is retried at the next red verification, instead of throwing out of mainRedGate and losing the heal for the rest of the process (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/baseline/main-red.ts + test/main-red-heal.test.ts + docs/invariants.md)

**Goal.** `warnMainRedOnce` (src/baseline/main-red.ts) is reached from `mainRedGate` and `bugfixMainRedNote` (both documented "Never throws") and from `verdictAtMainTipIn` (behind `mainTipVerdict`). It sets `lastHealKey = healKey` and only then calls `enqueueRolePrompt(root, BUGFIX_ROLE, mainRedHealPrompt(red.sha))` with no `try`. `enqueueRolePrompt` (src/inbox/inbox.ts) writes through `writeTextAtomic` and can throw (ENOSPC, EACCES). A plan-role scratch test on 2026-10-20 reproduced this. It used the "a failing set queues one heal prompt …" setup from test/main-red-heal.test.ts (`baselineFixture("coverage", …)`, `fakeNpm`, one failing test `heal-alpha`) and faulted `writeFileSync` with `errnoError("ENOSPC")` for paths starting with `roleInboxDir(root, "bugfix")`:
- `mainRedGate(root, "coverage", wt, undefined, () => {})` rejected with `Error: ENOSPC`, and no prompt was queued.
- With the fault removed, a new red commit with the same failing set returned null and still queued no prompt, and `warningMessages(root)` was empty. `lastHealKey` already held the set, so the heal was lost for the rest of the process, silently.

The `mainTipVerdict` path has a worse outcome. `verdictAtMainTipIn`'s `catch` turns the throw into `{ status: "unavailable", why: "ENOSPC" }`. `attributeRedCheck` (src/merge/merge-check-failures.ts) then pushes "main's own baseline was unavailable …, so the failed … is attributed to this change", which blames the change for a main that is known to be red. This is the same kind of fix as "Main revert: a heal prompt or reviewer hand-off that cannot be queued warns instead of throwing" (above, in flight), but at a different site: that plan changes only src/baseline/main-revert.ts and leaves `warnMainRedOnce` alone.

**Approach.** Change only `warnMainRedOnce` in src/baseline/main-red.ts:
1. Wrap the `enqueueRolePrompt` call in `try`/`catch`. In the `catch`:
   - reset `lastHealKey = null`, so the next verification of a red main queues the heal again (with `lastMainRedSha` still set, a later call for the same SHA returns early, so the retry comes with the next red SHA or a fresh process — say exactly that in the comment);
   - call `warnEventBestEffort` with `root`, `foundBy` and the message `could not queue the heal prompt for bugfix: ${errorMessage(err)}`. Both helpers are already imported by this file.
2. Keep the order: `main_red_hold` is still logged first, and the enqueue is still skipped when `baseRoleOf(foundBy) === BUGFIX_ROLE`.
3. Add one sentence to `warnMainRedOnce`'s doc comment: a heal prompt that cannot be queued is warned under `foundBy` and clears the heal key, never thrown.
4. Do not touch `queueCulpritHeal`, which the main-revert plan's `heal` guard covers, or any other file in src/.

**Files touched.** src/baseline/main-red.ts, test/main-red-heal.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/main-red-heal.test.ts, "a heal prompt that cannot be queued warns, lets the gate resolve, and is queued at the next red commit". Put it in this file because the file runs in its own process and the module state starts fresh. Use a fresh `baselineFixture("coverage", script)` + `fakeNpm(script)`, where the script prints `✖ heal-gamma (1ms)` and exits 1, plus the same `newCommit` helper as the first test.
  - Make the first red commit. Install `patchFsMethod("writeFileSync", …)` (test/helpers/fs-faults.ts), which throws `errnoError("ENOSPC")` when `file` is a string starting with `roleInboxDir(root, "bugfix")` (src/paths.ts) and calls the original otherwise. Remove it in a `finally`.
  - Assert that `await mainRedGate(root, "coverage", wt, undefined, () => {})` resolves to null, that `queuedRolePrompts(root, "bugfix")` is empty, and that `warningMessages(root)` (test/fixtures/log-fixtures.ts) has exactly one entry matching `/could not queue the heal prompt for bugfix: .*ENOSPC/`.
  - Without the fault, make a new red commit with the same failing set. Assert that `mainRedGate` returns null and that `queuedRolePrompts(root, "bugfix").length === 1`.
  - Use a failing-test name no other test in the file uses, so the existing test's `lastHealKey` state cannot mask or satisfy this one. Before the fix, the first assertion fails (rejects ENOSPC). With only the `try` and no `lastHealKey = null` reset, the last assertion fails (0 prompts).
- The existing tests in test/main-red-heal.test.ts and test/main-red.test.ts pass unchanged.
- docs/invariants.md: at the END of the file, after every section present when the change is made, add `## Red-main healer: a heal prompt that cannot be queued never fails the gate`. Under it put `### INV-CP1: a red main whose heal prompt cannot be queued resolves the gate, warns once that the prompt was not queued, and queues it at the next red verification`, in the Guarantee / Binds / Pinned by layout:
  - Binds: `src/baseline/main-red.ts` (`warnMainRedOnce`, `mainRedGate`).
  - Pinned by: the new test's name.
  - The `mainTipVerdict` attribution path is covered by the same guard but not by this test, and the invariant must not claim otherwise.
  - Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. CM and CO are claimed by Planned entries, and CP was free on 2026-10-20.
- `npm run test:gate` passes. The cited test name exists verbatim (`grep -rF` it in test/).

## Done
