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

## Done
