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

### Session retention: an OpenCode DB directory that cannot be created skips only the OpenCode session deletes instead of throwing out of the poll loop, and docs/invariants.md gains a session-retention section (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/orchestrator/retention.ts + test/retention.test.ts + docs/invariants.md)

**Goal.** `RetentionPruner.prune` (src/orchestrator/retention.ts) calls `ensureParentDir(dbPath)` for `opencodeDbPath(root)` first, before any pruning, with no catch. It runs from the `RetentionPruner` constructor at startup (`new RetentionPruner(root, config.sessionRetentionDays)` in src/orchestrator/orchestrator.ts) and from `RetentionPruner.poll` in the poll loop (src/orchestrator/orchestrator-poll.ts). The `pruneOldFiles` doc comment in src/files/files.ts says a throw escaping this pass "would end the whole team". On 2026-10-20 the plan role confirmed with a scratch test (since deleted): when `.tumwater/opencode` is a regular file, `new RetentionPruner(root, 7)` throws EEXIST, and so does `poll(root, 7)` on a pruner built with 0. A 30-day-old file in `toolOutputDir(root)` survives, because the throw comes before the file pass. A read-only `.tumwater` (EACCES) or a full disk (ENOSPC on the mkdir) leaves through the same call. A team that has never run OpenCode still pays this cost, because the directory is created unconditionally. If that directory cannot be created, the OpenCode DB cannot exist either, so no `opencode session delete` could succeed. Skipping the deletes loses nothing. docs/invariants.md has no section on retention.ts: `grep -n -i retention docs/invariants.md` finds nothing.

**Approach.**
1. src/orchestrator/retention.ts, `RetentionPruner.prune`: make `bin` a `let`. Wrap `ensureParentDir(dbPath)` in `try { … } catch { bin = undefined; }`. With no `bin`, `pruneOpencodeSessions` skips the session deletes but still prunes the spill dir. The file pass and the ledger line pass then run as before. Add a short comment: the directory cannot be created, so no OpenCode DB is there to delete from, and this pass runs in the poll loop, where a throw ends the team. Use plain vocabulary (no "tick", no "loop" for role). Change nothing else in src/.
2. test/retention.test.ts: append one test, "RetentionPruner: an OpenCode DB dir that cannot be created skips the session deletes and still prunes the rest". Write a regular file at `path.dirname(opencodeDbPath(root))` (import `opencodeDbPath` from ../src/paths.js; create its parent first). Add a 30-day-old file in `toolOutputDir(root)` with the existing `staleFile` helper. Record a 30-day-old `opencode` session with `recordSession`, as the idle-role test does, and point `TUMWATER_OPENCODE_BIN` at a `writeScript` capture bin, deleting the variable in a `finally`. Then:
   - `assert.doesNotThrow(() => new RetentionPruner(root, 7))`. The tool-output file is gone, and the capture log does not exist (no delete was attempted).
   - Make a new stale tool-output file. `const p = new RetentionPruner(root, 0)`, then `assert.doesNotThrow(() => p.poll(root, 7))`. The file is gone.
   Do not assert on the spill dir: `opencodeSpillDir` points under `os.homedir()` and is `""` for a root without commits.
   Mutations, each applied by hand and reverted: (i) remove the try/catch. The constructor throws EEXIST. (ii) Keep the catch but leave its body empty, so `bin` is not cleared. The capture log then holds `session delete`, and the test fails. Check whether any other test in test/retention.test.ts catches either mutation, and claim in VERIFIED only what you saw.
3. docs/invariants.md: append "## Session retention: the once-per-day gate, a re-prune on a window change, and a prune pass that never throws" after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BO had merged, BP was planned (Session ledger) and BQ was free. Use the existing Guarantee / Binds / Pinned by layout:
   - 1: a prune is due when the window is positive and a full day has passed since the last prune or none has run; a window of 0 disables pruning; startup prunes at once. Binds `dueForPrune` and the `RetentionPruner` constructor. Pinned by "dueForPrune: the once-per-day gate with fake timestamps", "RetentionPruner: construction runs the startup prune at a positive window" and "RetentionPruner: retention 0 disables the startup prune".
   - 2: a change in the live window logs one `retention_changed` per distinct value and re-prunes at once, even inside the daily window. Binds `RetentionPruner.poll`. Pinned by "RetentionPruner: poll re-prunes immediately on a window change and logs one event".
   - 3: the OpenCode purge reads a ledger before the file pass can age it out. Binds `RetentionPruner.prune`'s order. Pinned by "RetentionPruner: an idle role's expired opencode session is purged before its ledger ages out".
   - 4: a prune pass never throws. An unwritable event feed costs only its warnings, and an OpenCode DB directory that cannot be created costs only the OpenCode session deletes. Binds `RetentionPruner.prune` and `warnEventBestEffort`. Pinned by "RetentionPruner: a window change and a prune survive an unwritable events feed" and the new test. If the Session ledger plan's section (planned as INV-BP) has merged by then, add one sentence pointing to its ledger-rewrite guarantee. Otherwise, say nothing about the ledger rewrite.
   Cite each test by its full name.

**Files touched.** src/orchestrator/retention.ts (`RetentionPruner.prune` only); test/retention.test.ts (one appended test, plus an import); docs/invariants.md.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new test passes.
- The new test fails on the code before step 1 (EEXIST from the constructor) and passes after it.
- Both mutations in step 2 fail the new test when applied by hand, and it passes again once each is reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -rF` each one in test/).
- `git diff -- src/` touches only `RetentionPruner.prune` in src/orchestrator/retention.ts.

## Done
