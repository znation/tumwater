# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role, test migration split out into parts 4b/5 and 4c/5 2026-10-20 by the plan role; requires parts 3/5–4/5, part 4b/5 and part 4c/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**User decision 2026-10-20 (recorded by the director role): merge this without waiting for the operator to migrate tumwater.json first. The break when the live config reloads is accepted; the operator fixes it after the merge. The migration is: `model` drops the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }`. Each load error must name that exact edit, because the operator works from those messages.**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (its `isBackendId(provider)` branch) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule (its `isBackendId(provider)` branch goes); a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isBackendId(seam.provider)` fallback goes (part 4c/5 moved the seam fixtures that relied on it). `BACKEND_IDS`' doc comment (src/config/config-schema.ts) drops "doubles as the selector provider namespace", and `isBackendId`'s drops "the reserved selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -n 'isBackendId(provider)\|isBackendId(seam.provider)\|startsWith("claude-")' src/config/model-selector.ts src/config/config-fallbacks.ts` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field. Parts 4b/5 and 4c/5 moved the other test fixtures, so the test files this part edits are the ones its heading lists; `npm test` passes.

### Backend/model split, part 4b/5: Move test configs off the top-level `agent` key to `backend` (planned 2026-10-19 by user, split 2026-10-20 by the plan role from part 5/5 after the feature role's trial run; independent of every eligible plan — it changes only test files, none of which the in-flight TUI/dashboard window plans name; part 4c/5 edits some of the same files for a different spelling, a rebase either way; touches test/doctor-checks.test.ts test/doctor-model-checks.test.ts test/role-view.test.ts test/claude-run.test.ts test/run-resume.test.ts test/opencode-run.test.ts test/agent-backend.test.ts and any further test file the probe below names)

**Goal.** Part 5/5 drops the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts), so a top-level `agent` key becomes an unknown-key load error. The feature role's trial run of 5/5 (2026-10-20) found many tests still writing that key: `writeConfig(root, { agent: "claude" })` in test/doctor-checks.test.ts, test/doctor-model-checks.test.ts and test/role-view.test.ts, and `{ ...defaultConfig(), agent: "claude" | "opencode" | "fake-…" }` config literals in test/claude-run.test.ts, test/run-resume.test.ts, test/opencode-run.test.ts and test/agent-backend.test.ts. This part renames those to `backend` first, so 5/5's diff is only the behavior change. Series goal and siblings: part 1/5; part 4c/5 handles the model-id spellings.

**Approach.** Mechanical, one theme, no src change.
- Rename the key in every test config, raw (`writeConfig`, JSON written to tumwater.json) or typed (`Config` literals): top-level `agent: "<id>"` becomes `backend: "<id>"`. Keep the `as const` where a literal has one.
- Leave alone the `agent` fields that are not a config key: resolved seams (`{ agent: "pi", provider, model }`, which `seamAgent` reads), session-ledger records (`recordSession(…, { agent: … })`), `tumwater_run` transcript header lines, run_start event fields, and the runner option `agent:` in test/pi.test.ts.
- Leave the alias pin in test/config-aliases.test.ts (`writeConfig(dir, { agent: "claude", agents: … })`). Mark it `// legacy spelling, retired in part 5/5`, because 5/5 turns it into the error case.
- **Probe** (local only, never committed): delete the `{ from: "agent", to: "backend", scope: "top" }` row from `CONFIG_KEY_RENAMES`, run `npm run test:gate` into a scratch log, and migrate each failing test whose cause is a top-level `agent` key. Then restore the row with `git checkout -- src/config/config-aliases.ts` and re-run the gate.

**Acceptance criteria.**
- `git diff --stat main` names only files under test/.
- `grep -rnE 'writeConfig\([^)]*[{ ]agent: "|defaultConfig\(\), agent:' test` finds only the commented test/config-aliases.test.ts pin.
- With the probe applied, the gate's failures are confined to test/config-aliases.test.ts. The run's VERIFIED line says what the probe showed.
- `npm run test:gate` passes on the committed tree (alias row restored).

### Backend/model split, part 4c/5: Move test configs off namespaced and prefix-routed model ids to an explicit `backend` (planned 2026-10-19 by user, split 2026-10-20 by the plan role from part 5/5 after the feature role's trial run; independent of every eligible plan — it changes only test files; part 4b/5 edits some of the same files for the `agent` key, a rebase either way; touches test/budget-gates.test.ts test/config-write.test.ts test/gui-endpoints.test.ts test/gui-client-boot.test.ts test/team-hold.test.ts test/team-polls.test.ts test/team-alerts.test.ts test/pi-models.test.ts test/role-view.test.ts test/doctor-model-checks.test.ts test/opencode-catalog.test.ts test/config-live.test.ts test/startup-gate.test.ts test/runner-pi-claude.test.ts test/doctor.test.ts and any further test file the probe below names)

**Goal.** Part 5/5 removes the two routing rules where the model id picks the backend. Both live in `routeModel` (src/config/model-selector.ts): a `claude/…` or `opencode/…` provider runs that backend (the `isBackendId(provider)` branch), and a bare `claude-…` id runs on claude (the `startsWith("claude-")` branch). 5/5 also removes the matching `isBackendId(provider)` branch in `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) and `seamAgent`'s `isBackendId(seam.provider)` fallback (model-selector.ts). Part 4/5 moved the `model: "claude/…"` literals. The trial run found these spellings still relied on:
- bare `claude-…` ids with no `backend: "claude"` in scope;
- `claude/<id>` and `opencode/<id>` strings in `fallback` values and chains;
- resolved-seam fixtures that name the backend only through `provider: "claude"` / `"opencode"`.

This part rewrites them first. Series goal and siblings: part 1/5; part 4b/5 handles the `agent` key.

**Approach.** Mechanical, one theme, no src change. Each rewrite resolves to the same backend and model as before, so assertions stay as they are.
- A bare `claude-…` id resolved with no explicit backend (top-level `backend` unset or `pi`): add `backend: "claude"` to its section. A tier-map entry becomes the object form `{ backend: "claude", model }`, and a role or review section gains the key.
- A `"claude/<id>"` or `"opencode/<id>"` fallback string or chain step: becomes `{ backend: "claude" | "opencode", model: "<id>" }`, the part 2/5 step form.
- A resolved seam or pair fixture that names the backend only through `provider: "claude" | "opencode"`: gains `agent: "<id>"`, and its `provider` is dropped, the shape `routeModel` produces for these backends.
- Leave alone the cases part 4/5 already left: rendered display labels (`claude/claude-sonnet-5-5`), OpenCode argv (`--model opencode/<id>`), opencode catalog keys, event/history fixtures, and the legacy-rule pins in test/model-selector.test.ts, test/config-views.test.ts and test/config-validation*.test.ts. Each pin you touch gets the `// legacy spelling, retired in part 5/5` comment.
- **Probe** (local only, never committed):
  1. In `routeModel`, make `backend` = `provider === undefined ? configBackend : "pi"`.
  2. In `seamKeyedFallbackProvider`, make it `provider === undefined ? config.backend : "pi"`.
  3. In `seamAgent`, return `seam.agent ?? "pi"`.
  4. Run `npm run test:gate` into a scratch log and migrate each failing test whose cause is one of the three spellings above.
  5. Restore with `git checkout -- src/config` and re-run the gate.

**Acceptance criteria.**
- `git diff --stat main` names only files under test/.
- With the probe applied, the gate's failures are confined to the legacy-pin files part 5/5 rewrites: test/model-selector.test.ts, test/config-views.test.ts, test/config-validation.test.ts, test/config-validation-model.test.ts and test/badges.test.ts. The run's VERIFIED line names the probe's remaining failing files.
- `npm run test:gate` passes on the committed tree (src restored).

### TUI History model filter: `Ctrl+X` on the History pane cycles all → each model the pane's rows ran on → all, the terminal twin of `history --model` (planned 2026-10-20 by the plan role; independent of every eligible plan — the Backend/model split parts change only test configs and src/config, none of the files below)

**Goal.** `tumwater history --model <id>` (src/history/history.ts) and the dashboard History view (`/api/history?model=`, src/gui/gui-endpoints.ts) narrow run rows to one model through `runRowsOnModels` (src/history/history-data.ts). The TUI History pane (src/ui/tui/tui-pane-history.ts) has scope (Ctrl+G), window (Ctrl+S/Ctrl+P), outcome (Ctrl+O), search (`/`) and summary (Ctrl+Y), but no model filter. So comparing how one model fared after a backend or tier change means leaving the terminal UI. Add a session model filter on `Ctrl+X`. Ctrl+X has no binding on the History view: the backends editor's arm is guarded to view 0, the role-model editor yields outside a Transcript view, the retire editor to the Health view (N+7), and the `tui-panes.ts` Ctrl+X router's transcript/queued/backlog arms each return false off their views.

**Approach.**
- src/ui/tui/tui-pane-history.ts, `createHistoryPane`:
  - Add `let historyModel: string | null = null;` beside `historyResult`, with a comment in the same style (session-only; the next Ctrl+T into History computes with it).
  - `selectPaneRows` gains a `model: string | null` param after `grep`. Apply it last, after the outcome class, which is the CLI's order (result, then `--model`). Return `afterResult` (the count after the class filter) beside `afterGrep`. `filtered` becomes `model === null ? classed : runRowsOnModels(classed, [model])`. Update its doc comment.
  - `historyPaneCache` gains the same `model` param. Header: add `"model: " + model` after the result label and before the search label. Empty body: check `model !== null && afterResult > 0` first and return `header + "\nno runs on model \"" + model + "\""` (the CLI's wording and precedence), then the existing result and grep arms.
  - Pass `historyModel` at every `selectPaneRows`/`historyPaneCache` call (`loadTrail`, `recompute`, `applySearch`). Add `historyModel === null` to `loadTrail`'s `unfiltered` and to the Ctrl+N toggle's `filtered` test.
  - New key arm `if (key.ctrl && key.name === "x" && promptLineFree(ctx.es))`: return false unless `session.view === session.roleIds.length + 4`, so the key falls through on every other view. Compute the cycle from `selectPaneRows(historyWindow, historyResult, historyRole, historyGrep, null, HISTORY_DEFAULT_RUNS, historyStep).filtered`. Take the distinct non-null `model`s in `summarizeRunRowsByModel` order (`summarizeRunRowsByModel(rows).models`, dropping the null entry), so the cycle matches the Ctrl+Y by-model table. Next value: `const i = list.indexOf(historyModel ?? ""); historyModel = i + 1 < list.length ? list[i + 1] : null` — so null (and a model no longer in the list, index -1) goes to the first model, each model to the next, and the last back to null. An empty list with `historyModel === null` flashes `no runs with a model in this view` and leaves the state alone. Then `if (trailMode) refreshTrail(); recompute(); session.requestRender(); return true;`, as the Ctrl+O arm does.
  - `state()` adds `historyModel`.
- src/ui/tui/tui-panes.ts: in the `key.name === "x"` router, after the transcript arm and before the queued arm, add `if (history.handleKey?.(key, ctx)) return true;`. Add `historyModel: hist.historyModel` to the aggregated state beside `historyResult`. Add a sentence to the router comment.
- src/ui/tui/tui-keys.ts: add `historyModel: string | null` to the state type beside `historySummary`.
- src/ui/tui/tui-frame.ts: add `model?: string | null` to the `kind: "history"` view type. In the history key hint, add `["Ctrl+X", view.model ? \`model: ${view.model}\` : "model: all"]` right after the Ctrl+O entry. src/ui/tui/tui.tsx: the history view object passes `model: s.historyModel`.
- docs/cli.md TUI keys table: add a `| \`Ctrl+X\` | History | cycle the model filter …` row beside the other per-view Ctrl+X rows, naming `history --model` as its CLI twin.

**Files touched.** src/ui/tui/tui-pane-history.ts, src/ui/tui/tui-panes.ts, src/ui/tui/tui-keys.ts, src/ui/tui/tui-frame.ts, src/ui/tui/tui.tsx, docs/cli.md, test/tui-keys.test.ts, test/tui-frame.test.ts.

**Acceptance criteria.**
- New test in test/tui-keys.test.ts, modelled on "Ctrl+O cycles the History pane's outcome class, filters rows by historyClass, and resets the scroll". Seed run_start events with `model: "m-a"` / `model: "m-b"` and one run with no model, as the Ctrl+Y by-model test does, with matching run_ends. Ctrl+X on History steps `historyModel` null → "m-a" → "m-b" → null. Under "m-a" the paneCache holds a `model: m-a` header and only m-a's rows. At null it shows every row and no `model:` header.
- A test where Ctrl+X on History with an empty log (or only model-less runs) flashes `no runs with a model in this view` and leaves `historyModel` null.
- A test where Ctrl+X on the Activity view still opens the backends editor and leaves `historyModel` null (the per-view guard).
- A test that a set model which a later Ctrl+O empties blames the model: the pane reads `no runs on model "m-a"` when the class kept rows that the model then removed.
- test/tui-frame.test.ts: the history hint shows `Ctrl+X model: all`, and `Ctrl+X model: m-a` when set. Update the existing full-string history hint assertions.
- `npm run test:gate` passes.

### Shell completion for `history --model`: a `tumwater completion --models` hook prints the model selectors recent runs started on, and the bash/zsh/fish scripts complete them after `history --model` (planned 2026-10-20 by the plan role; independent of every eligible plan — the Backend/model split parts change test configs and src/config, and the TUI History model filter touches only src/ui/tui and docs/cli.md's TUI keys table)

**Goal.** `tumwater history --model <selector>[,...]` keeps only the runs that started on the listed selectors. Those selectors are long, exact strings (`huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra`), and you can only find them by running `history --summary --by model` first. Shell completion offers role ids after `--role` through the dynamic `tumwater completion --roles` hook, and config keys through `--config-keys`. For `history --model` it offers nothing: `fishFlagValue` (src/cli/completion.ts) says "`history --model` takes run selectors read from the log", and the test "the bash script completes summary groups after --by and tier names after role --model" asserts `tumwater history --model ""` completes `[]`. Add a third dynamic hook that reads those selectors from the log.

**Approach.**
1. src/cli/completion.ts: add an exported `completionModels(root: string): string[]` beside `completionRoleIds`. It returns the distinct non-null `model`s of `readRunRows(root, HISTORY_MAX_RUNS, null)` (src/history/history-data.ts), sorted with `compareCodeUnits` (src/collections.ts). That is the same order `summarizeRunRowsByModel` lists them. Wrap the read in `try { … } catch { return []; }`, with a doc comment in the `completionRoleIds` style: an unreadable or absent log must not write errors into the operator's prompt, and outside a repo it prints nothing.
2. src/cli.ts, `case "completion"`: after the `--config-keys` arm, add `if (args.length === 1 && args[0] === "--models") { for (const m of completionModels(root)) say(m); break; }`, and import `completionModels` beside `completionRoleIds`.
3. src/cli/completion.ts `bashScript`: after the `role --model` arm, add a `history --model` arm: `if [ "$prev" = "--model" ] && [ "${COMP_WORDS[1]}" = history ]; then COMPREPLY=( $(compgen -W "$(tumwater completion --models 2>/dev/null)" -- "$cur") ); return 0; fi`. zsh gets it through the bashcompinit wrapper (`completionScript`). `fishFlagValue`: replace the comment and add `if (flag === "--model" && command === "history") return \` -x -a "(tumwater completion --models 2>/dev/null)"\`;`. Keep the `role` tier arm first. The new comment says `role --model` completes the closed tier set and `history --model` completes the log's selectors.
4. Known limit, not a design question: bash's default `COMP_WORDBREAKS` contains `:`, so after a selector has been typed *past* its colon, bash splits the word and `prev` is no longer `--model`. In that case nothing completes. A first TAB on any prefix before the colon still inserts the whole selector, or the shared prefix when several selectors share it. Leave a one-line comment on the bash arm saying so. Do not add colon-rejoining logic. Comma lists are not completed past the first item, which is the same behavior as `--role`.
5. src/cli/help.ts: after the `tumwater completion --config-keys` line, add `  tumwater completion --models     Print the model selectors history --model completes (those the recent runs started on; nothing when the log is unreadable)`. Keep the column alignment of its neighbours.
6. docs/cli.md: in the `tumwater completion bash|zsh|fish` paragraph, change "tier names after `role <id> --model`" to "tier names after `role <id> --model`, the model selectors recent runs started on after `history --model`". Change "`tumwater completion --roles` and `tumwater completion --config-keys` print the role ids and config keys that script completes" so it also lists `tumwater completion --models` and the model selectors.

**Files touched.** src/cli/completion.ts, src/cli.ts, src/cli/help.ts, docs/cli.md, test/completion.test.ts.

**Acceptance criteria.**
- test/completion.test.ts: the `complete` helper's fake `tumwater` gains a `--models` branch printing two selectors, e.g. `hf/m-a:deepinfra` and `hf/m-b`. In "the bash script completes summary groups after --by and tier names after role --model", the `history --model ""` assertion becomes those two selectors, and `history --model "hf/m-a"` gives `["hf/m-a:deepinfra"]`. `role qa --model ""` still gives `MODEL_TIERS`.
- The fish test "the fish script completes values after --role, path flags, --template, and --result, and config keys at word 3": `modelLine("history")` now includes `completion --models`, and `modelLine("role")` still lists the tiers and does not include `completion --models`.
- New test "completion --models prints the selectors recent runs started on, and nothing without a log", modelled on "completion --roles prints the repo's role ids, or the catalog on a broken config". In a temp git repo it writes run_start/run_end pairs to the event log, two on `m-b`, one on `m-a`, and one run_start with no model, the same way the history by-model tests seed them. `cli(dir, "completion", "--models")` exits 0 and prints exactly `m-a` then `m-b`. In a fresh dir with no log it exits 0 with empty stdout and empty stderr. `completionSpec().flags.completion` includes `--models`. `completion --models bash` still exits non-zero naming `bash, zsh, or fish`.
- `npm run test:gate` passes.

## Done
