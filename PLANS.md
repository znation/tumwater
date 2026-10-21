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

### `tumwater history --last` with no role opens the newest completed run of any role, and `--result`/`--model` narrow it the same way (planned 2026-10-20 by the plan role; independent of every eligible plan: none of them touch src/run/run-detail.ts, src/cli/cli-command-args.ts or the `runTrailCommand` in src/cli.ts — the `GET /api/history?result=` plan edits src/gui/gui-endpoints.ts, and this plan leaves that file's `newestRunNumber` call working unchanged)

**Goal.** `tumwater history <role> --last [--result <class>[,...]] [--model <selector>[,...]]` opens one role's newest run. The question an operator asks first after time away is "what just happened anywhere?", and today that takes `tumwater history -n 1` and then a second command with the role and number it printed. `tumwater history --last --result problems` should open the team's newest failure directly. It takes the same `--stat`, `--patch`, `--transcript` and `--json` flags as the role form.

**Approach.**
1. src/cli/cli-command-args.ts `historyTrailForm`: also return true when `args` contains `--last`. The listing form does not admit `--last` (its `rejectUnknownArgs` spec list in src/cli.ts's `history` case has no `LAST_FLAG`), so this only reroutes an invocation that fails today. Update the doc comment to name the bare `history --last` form.
2. src/cli.ts `runTrailCommand`: replace the `positionals.length < 1` arity check so that zero positionals pass only when `rest.includes("--last")`; with neither, it still fails with `usage: ${RUN_DETAIL_USAGE}`. `tumwater tick` with no args must still fail with that usage (the existing test that runs it outside a repo covers this).
3. src/run/run-detail.ts:
   - Add `export function newestRunRow(root: string, role: string | null, classes: HistoryResultClass[] | null, models: string[] | null): RunRow | null`. Move `newestRunNumber`'s body into it, return the row, and pass `role` straight to `readRunRows` (its `RoleScope` takes `null` for every role). `newestRunNumber` becomes `newestRunRow(root, role, classes, models)?.run ?? null` and keeps its signature, so `handleRun` in src/gui/gui-endpoints.ts does not change.
   - `runNotFoundLastMessage(role: string | null, …)`: when the role is `null`, pass `"any role"` to `runNotFoundPhrase`. The message then reads `no completed run with result "refused" for any role in the scanned window (the retained log may have rotated past it)`.
   - `cmdRunDetail`: when `last` is set and there are no positionals, resolve with `newestRunRow(root, null, classes, models)`, take `role` from `row.role` and the run number from `row.run`, then render exactly as the role form does. A miss prints `runNotFoundLastMessage(null, classes, models)` (or `null` under `--json`) at exit 0. Keep the role check and the arity error for one or two positionals as they are. Update the doc comment.
   - `RUN_DETAIL_USAGE` stays as it is, because test/run-detail.test.ts matches its text. The bare form is documented in the help prose instead.
4. src/cli/help.ts `history <role>` stanza: after "--last shows the role's newest finished run instead of numbering one;" add "with no <role>, --last shows the newest finished run of any role;". docs/cli.md "Watch run history" row: after "`tumwater history <role> --last` shows the newest completed run's trail instead of numbering one;" add "`tumwater history --last` with no role shows the newest completed run of any role (`history --last --result problems` opens the team's latest failure);".

**Files touched.** src/cli/cli-command-args.ts, src/cli.ts, src/run/run-detail.ts, src/cli/help.ts, docs/cli.md, test/run-detail.test.ts, test/cli-command-args.test.ts.

**Acceptance criteria.**
- test/cli-command-args.test.ts "historyTrailForm tells the one-run trail from the listing…": add the cases `[["--last"], true]`, `[["--last", "--result", "problems"], true]` and `[["--json", "--last"], true]`. Every existing case keeps its expected value.
- New test "cmdRunDetail --last with no role opens the newest run of any role, narrowed by result and model" in test/run-detail.test.ts. Its events: bugfix run 2 `changed` at ts 2000, feature run 4 `error` at ts 4000, bugfix run 5 `no_change` at ts 6000 (each `start` sets `loop` for its role, as the fixtures' `start`/`end` helpers take an override). Assert that:
  - `cmdRunDetail(repo, [], false, { last: true })` prints exactly what `cmdRunDetail(repo, ["bugfix", "5"], false)` prints.
  - `{ last: true, result: "problems" }` prints feature run 4's trail, and `{ last: true, result: "merged" }` prints bugfix run 2's.
  - The `--json` payload of `{ last: true }` deep-equals the payload of `["bugfix", "5"]`.
  - `{ last: true, result: "refused" }` prints a line matching `/^no completed run with result "refused" for any role in the scanned window/` at exit 0, and `null` under `--json`.
- New CLI test "history --last with no role through the CLI opens the newest run of any role": `cli(repo, "history", "--last", "--result", "problems")` exits 0 and its stdout matches `/^feature run #4 /`.
- `cmdRunDetail(repo, [], false)` without `last` still fails with the usage. The existing `--last`, `--result` and usage tests in test/run-detail.test.ts pass unchanged.
- `npm run test:gate` passes.

## Done
