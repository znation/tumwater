# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code cleanup, part 7/7: Make the vocabulary guard cover all of src and drop the opt-in headers (planned 2026-10-16 by user; requires part 6/7 landed; design in plans/terminology.md "Guards"; touches test/vocabulary.test.ts + every src/ module carrying a vocabulary header)

**Goal.** Mostly mechanical. The vocabulary guard has no opt-in: it always scans every src/ module. The `// vocabulary: plain` header lines are deleted, since they no longer mean anything.

**Approach.**
- test/vocabulary.test.ts: remove the header requirement and any remaining scope logic (`optedIn` goes away), so the target is every `.ts`/`.tsx` module under src/. Replace the groundwork test "with no `// vocabulary: plain` header anywhere in src/, the guard passes" with one that a header-less module is scanned. Keep the word list, the word-bounded case-insensitive match, the string-literal and template-text walk (never `${…}` expressions), the `// vocabulary-ok: <reason>` line exemption, and the shared legacy-reader exemption from part 5/7. Update the file's header comment to say the guard covers all of src/ and that `vocabulary-ok` is the only escape.
- Delete every `// vocabulary: plain` line in src/: `grep -rln '^// vocabulary: plain' src` lists them, one line per module, up to about 300. Change nothing else in those files.
- Features keep landing while this series runs, so run the guard and fix any hit introduced since part 6/7 the same way: reword, or mark `vocabulary-ok` with a reason.
- docs/glossary.md and DEVELOPMENT.md may describe the opt-in header. Update their sentence on how the guard is scoped, and nothing else in them.

**Files touched.** test/vocabulary.test.ts; every src/ module with a `// vocabulary: plain` header (one deleted line each); any module with a newly introduced hit; the guard sentence in docs/glossary.md and DEVELOPMENT.md if they describe the header.

**Acceptance criteria.**
- `grep -rn 'vocabulary: plain' src test` prints nothing, apart from a negative-case fixture inside test/vocabulary.test.ts if it keeps one.
- Adding `say("the fleet is idle")` to any src/ module without a `vocabulary-ok` marker makes the guard fail (check locally, do not commit).
- The guard's own tests pin the new scope: a module without any header is scanned.
- `npm run test` passes.

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

## Done
