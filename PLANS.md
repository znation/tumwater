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

### Claude account seed: a failed `claude-account.json` write no longer throws out of `tumwater start` or a live config reload (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/agent/claude/claude-account.ts + test/claude-account.test.ts + test/startup-gate.test.ts + docs/invariants.md)

**Goal.** `runStartupCheck` (src/gates/startup-gate.ts) promises "never a throw, so a poll can ask it safely", and its comment on the claude seed says "If the seed fails, the first claude run's observation fills the file in". But `seedClaudeAccount` (src/agent/claude/claude-account.ts) calls `writeClaudeAccount(root, account)` with no guard, and `writeClaudeAccount` is a bare `writeJsonAtomic`. An unwritable `.tumwater/state/claude-account.json` therefore throws out of `runStartupCheck`. `tumwater start` then dies on a stack trace, and the supervisor/redeploy poll's `runStartupProblem` throws too. The other caller, the live-reload path in src/config/config-live.ts that seeds a newly routed claude backend, says "never a crash" and has the same unguarded call. On 2026-10-20 the plan role confirmed the throw with a scratch test (since deleted): with `ANTHROPIC_API_KEY` set and a directory at `claudeAccountPath(root)`, `seedClaudeAccount(root, defaultConfig(), 123)` threw `EISDIR: illegal operation on a directory, rename …claude-account.json.tmp-… -> …claude-account.json`. This is the claude twin of the planned "OpenCode catalog seed" entry. That entry touches only src/agent/opencode/opencode-catalog.ts, so the two plans share no file except docs/invariants.md, where each appends its own section.

**Approach.**
1. src/agent/claude/claude-account.ts, `seedClaudeAccount`: wrap the `writeClaudeAccount(root, account)` call in `try`/`catch`. The `catch` returns `null`, the same value as "billing cannot be decided", so neither caller changes. Neither caller reads the return value (`grep -rn 'seedClaudeAccount(' src`). Leave `writeClaudeAccount` strict: its test "writeClaudeAccount: a write that fails mid-way leaves the previous reading whole" asserts that it throws, and `observeClaudeAccount`'s callers depend on that. Add a sentence to `seedClaudeAccount`'s doc comment (or create one if it has none): a failed write returns null and never throws, so the first claude run's `observeClaudeAccount` fills the file in. Add no warning, because neither caller has a warn sink at this point and wiring one up is a separate change.
2. test/claude-account.test.ts: append "seedClaudeAccount: a failed account write returns null instead of throwing". Model it on "seedClaudeAccount: ANTHROPIC_API_KEY means API billing", including its save/restore of `process.env.ANTHROPIC_API_KEY`. Before the call, run `fs.mkdirSync(claudeAccountPath(root), { recursive: true })`. Assert that `seedClaudeAccount(root, defaultConfig() as TumwaterConfig, 123)` returns `null` and that `readClaudeAccount(root, 123)` is `null`.
3. test/startup-gate.test.ts: append "an unwritable claude account file does not fail the startup gate". Copy the setup of "a claude seam that exists only as a fallback is checked and its account seeded" (fake `claude` script, `cfg.backends.claude.bin`, `cfg.fallback`). Before `runStartupCheck`, `fs.mkdirSync(claudeAccountPath(repo), { recursive: true })`, importing `claudeAccountPath` from src/paths.js if the file does not already import it. Assert that `runStartupCheck(repo, null)` resolves without `"problem"` and that `readClaudeAccount(repo)` is `null`. The fresh `makeRepo()` root keeps the module's `claudeSeedAttempted` set from skipping the seed.
4. docs/invariants.md: append "## Claude account seed: a failed write never throws out of startup" after the last section, using the Guarantee / Binds / Pinned by layout. For the prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BX had merged and BY (Run end) and BZ (OpenCode catalog seed) were planned, so CA was free. Write one guarantee: `seedClaudeAccount` returns null instead of throwing when the account write fails, so `runStartupCheck` keeps its never-throws contract on a claude team. Binds `seedClaudeAccount` and `runStartupCheck`. Pinned by the two new tests, each cited by its full name.

**Acceptance criteria.**
- With step 1 reverted, both new tests fail with the EISDIR rename error.
- "writeClaudeAccount: a write that fails mid-way leaves the previous reading whole" and the existing `seedClaudeAccount` tests pass unchanged.
- `npm run test:gate` passes.
- `git diff --stat` shows src/agent/claude/claude-account.ts as the only changed src/ file.
- Each test name cited in the new section exists verbatim (`grep -rF` each one in test/).

## Done
