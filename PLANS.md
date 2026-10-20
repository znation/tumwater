# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code cleanup, part 5/7: Scan every module with the vocabulary guard and fix the first half of src (planned 2026-10-16 by user; requires part 4/7 landed; design in plans/terminology.md "Guards" and "Wording rules"; touches test/vocabulary.test.ts + test/helpers/legacy-files.ts + test/retired-names.test.ts + string literals in src/agent/ through src/init/ + src/*.ts)

**Goal.** test/vocabulary.test.ts scans every src/ module, not only those with the `// vocabulary: plain` header, except the directories listed in a new pending set. This part cleans the first half of src/ (agent through init, plus the root modules) and removes them from that set.

**Approach.**
- Guard change in test/vocabulary.test.ts:
  - Add `PENDING_VOCABULARY_DIRS`, a set of src/ directory paths whose header-less modules the guard still skips. Change the guard's single opt-in test, `optedIn(text)` (Plain terms groundwork put it in one function for this flip), to take the module path as well, and return true when the module has the header or lies outside the pending set. Modules that carry the header keep being scanned wherever they live.
  - Every other module under src/ is scanned with the existing rules (string literals and template-literal text, word-bounded, case-insensitive, a line ending `// vocabulary-ok: <reason>` exempt).
  - The set starts as the second half of src/: `src/merge`, `src/operator`, `src/orchestrator`, `src/pi`, `src/pi-extension`, `src/process`, `src/prompt`, `src/redeploy`, `src/report`, `src/review`, `src/roles`, `src/run`, `src/runner`, `src/scheduling`, `src/status`, `src/team`, `src/text`, `src/ui`, `src/verdict`. Part 6/7 empties it.
  - Add a test that fails when a set entry names a directory that does not exist, so the set cannot rot.
- Legacy readers must name old words on purpose, and they need the same exemption in both guards:
  - Move test/retired-names.test.ts's `LEGACY_FILES` list into a small shared helper, test/helpers/legacy-files.ts, so a test file never imports another test file (that would register its tests twice). Import the helper from both guards.
  - Make the vocabulary guard skip the `LEGACY_FILES` modules and honor the retired-names guard's `retired-name-ok:start`/`end` regions and `// retired-name-ok:` lines as well as its own `// vocabulary-ok:`. One marker then serves both guards: `normalizeLegacyEvent`'s tables, the state loaders' legacy-key maps, the `legacyLand*` helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, and src/roles/legacy-role-ids.ts.
  - Pin both behaviors with a guard test.
- Then fix every hit the guard reports in src/agent, src/backlog, src/baseline, src/brief, src/budget, src/build, src/change, src/cli, src/concurrency, src/config, src/doctor, src/events, src/failure, src/files, src/gates, src/git, src/gui, src/history, src/inbox, src/init and the root modules (src/cli.ts, src/paths.ts, src/version.ts, …):
  - User-visible text a reader can see (CLI output, errors, warnings, agent prompts): reword per plans/terminology.md "Glossary" and "Wording rules".
  - Machine names that must stay: the `tumwater(operator):` prefix, hidden-alias argv (`"tick"`, `"run"`), git ref and directory names of legacy layouts, and env vars of other tools. These get `// vocabulary-ok: <reason>` at the end of the line.
  - Internal strings no user sees (cache keys, log tags, test seams): rename to plain words when nothing persisted depends on them; otherwise mark them `vocabulary-ok`.
- To list the hits, run the guard (`npm run test` filtered to vocabulary, as DEVELOPMENT.md describes the runner's file filter) and work directory by directory. If this half reports far more than about 300 lines, stop at a directory boundary, add the untouched directories back to `PENDING_VOCABULARY_DIRS`, and say so in the commit message; part 6/7 starts from whatever the set holds.

**Files touched.** test/vocabulary.test.ts; test/helpers/legacy-files.ts (new) and test/retired-names.test.ts (imports it); string literals in src/agent/ … src/init/ and the root src/*.ts modules. Tests asserting reworded output in the same directories (for example test/cli*.test.ts and test/doctor*.test.ts).

**Acceptance criteria.**
- test/vocabulary.test.ts scans every module outside `PENDING_VOCABULARY_DIRS` and passes; the set holds only second-half directories (plus any first-half ones this part's commit message names).
- Each surviving retired word in a scanned module sits on a `// vocabulary-ok: <reason>` line or in an exempt legacy reader.
- Adding `say("the fleet is idle")` to an unmarked module in src/cli/ makes the guard fail (check locally, do not commit).
- `npm run test` passes.

### Plain terms code cleanup, part 6/7: Fix the second half of src for the vocabulary guard (planned 2026-10-16 by user; requires part 5/7 landed; design in plans/terminology.md "Guards" and "Wording rules"; touches test/vocabulary.test.ts + string literals in the directories still in PENDING_VOCABULARY_DIRS)

**Goal.** `PENDING_VOCABULARY_DIRS` is empty: every src/ module passes the vocabulary guard, with or without a header.

**Approach.**
- Fix every hit the guard reports in the directories `PENDING_VOCABULARY_DIRS` still holds: the second half of src/ (merge … verdict, including src/ui/ and its gui/ and tui/ subdirectories), plus any first-half directory part 5/7 handed over. Apply the same treatment as part 5/7:
  - Reword user-visible text per plans/terminology.md "Glossary" and "Wording rules".
  - Mark machine names that must stay with `// vocabulary-ok: <reason>` (the `tumwater(operator):` prefix, hidden-alias argv, legacy layout names, other tools' env vars).
  - Rename or mark internal strings.
  - Legacy readers stay exempt through the shared retired-names exemption.
- The dashboard's gui-client modules are browser code inside String.raw templates, which the guard reads as template text. A code name inside the browser code that still trips it (a DOM id, a CSS class, a local) is renamed to a plain word, checking uniqueness across the concatenated client modules. An end-of-line `// vocabulary-ok:` there is a browser-side JS comment and is allowed.
- Remove each directory from `PENDING_VOCABULARY_DIRS` as it passes, then delete the set and its existence test once it is empty, leaving the guard's header rule for part 7/7.
- Update tests that assert reworded output in the same directories.

**Files touched.** test/vocabulary.test.ts; string literals in src/merge/, src/operator/, src/orchestrator/, src/pi/, src/pi-extension/, src/process/, src/prompt/, src/redeploy/, src/report/, src/review/, src/roles/, src/run/, src/runner/, src/scheduling/, src/status/, src/team/, src/text/, src/ui/ and src/verdict/ (only those with hits); their tests.

**Acceptance criteria.**
- `PENDING_VOCABULARY_DIRS` no longer exists, and the guard scans every src/ module and passes.
- Each surviving retired word in src/ string literals sits on a `// vocabulary-ok: <reason>` line or in an exempt legacy reader.
- No user-visible behavior changes beyond wording: every test passes, and any changed assertion changed only reworded text.
- `npm run test` passes.

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

### docs/invariants.md gains a git-diff-paths section, and one new test file pins that a tree diff tells an unreadable answer from an empty one, lists both ends of a move, and decodes non-ASCII names (planned 2026-10-20 by the plan role; independent of every eligible plan; touches docs/invariants.md + a new test/git-diff-paths.test.ts)

**Goal.** src/git/git-diff.ts turns git's diff output into paths and capped diffs. Before this entry, docs/invariants.md did not name git-diff.ts or any of its functions. test/git-diff.test.ts covers `changedFiles`, `unquotePorcelainPath`, `aheadOfMainDiff` and the range of `aheadOfMainFiles`, but before this entry no test called `treeDiffFiles` directly. The merge path depends on it: `exemptTreeDelta` (src/merge/merge-stack.ts) decides whether a stack is review-exempt, and the overwrite-blocker check in src/merge/merge-git.ts reads it. Three documented guarantees have no test that would catch them breaking:
- `treeDiffFiles` returns null when git fails (an unknown commit), and `[]` for identical trees. `exemptTreeDelta` relies on this, because "an unreadable diff is not exempt" only holds while null is kept separate from `[]`.
- `treeDiffFiles` passes `--no-renames`, so a file moved from `src/` to `docs/` lists both its old and its new path. With git's default rename detection, `git diff --name-only` lists only `docs/x.md`. The plan role checked this in a scratch repo on 2026-10-20. A code-to-docs move would then read as a docs-only, review-exempt delta.
- `treeDiffFiles` and `aheadOfMainFiles` decode git's C-quoted names. Under the default `core.quotePath`, `héllo.md` comes out as `"h\303\251llo.md"` (checked the same way), which is not a real path and does not match a `*.md` exemption.

**Approach.**
1. New test/git-diff-paths.test.ts (node:test + `node:assert/strict`). Do not edit test/git-diff.test.ts. Import `treeDiffFiles` and `aheadOfMainFiles` from ../src/git/git-diff.js, `commitAll` from ../src/git/git.js and `ensureWorktree` from ../src/git/worktree.js. Import `makeRepo`, `seedCommit` and `sh` from ./fixtures/repo-fixtures.js. Use real git throughout, as test/git-diff.test.ts does.
2. Test "treeDiffFiles is null for an unknown commit and empty for identical trees". Use `makeRepo()`. Assert that `await treeDiffFiles(repo, "deadbeef", "HEAD")` is `null`, and that `await treeDiffFiles(repo, "HEAD", "HEAD")` deep-equals `[]`. Mutation: replace `out === null ? null : gitLines(out).map(unquotePorcelainPath)` with `gitLines(out).map(unquotePorcelainPath)`. This type-checks and returns `[]` for the unknown commit.
3. Test "treeDiffFiles lists a moved file under both its old and its new path". Use `makeRepo()` and `seedCommit(repo, "src/x.ts", ...)`, after first creating `src/` with `fs.mkdirSync`, because seedCommit writes the file directly. Then `fs.mkdirSync(docs)` and run `sh(repo, "git", "mv", "src/x.ts", "docs/x.md")` and `sh(repo, "git", "commit", "-m", "move")`. Assert that `(await treeDiffFiles(repo, "HEAD~1", "HEAD"))!.sort()` deep-equals `["docs/x.md", "src/x.ts"]`. Mutation: delete the `"--no-renames"` argument. Git then reports only `docs/x.md`.
4. Test "treeDiffFiles and aheadOfMainFiles decode a non-ASCII name to its real path". Use `makeRepo()` and `const wt = await ensureWorktree(repo, "improve", "main")`. Write `héllo.md` in `wt` and run `commitAll(wt, "add")`. Assert that `await aheadOfMainFiles(wt, "main")` deep-equals `["héllo.md"]`, and that `await treeDiffFiles(wt, "main", "HEAD")` deep-equals `["héllo.md"]`. Mutations: (a) drop `.map(unquotePorcelainPath)` from `aheadOfMainFiles`; (b) drop it from `treeDiffFiles`. Both type-check (`gitLines` returns `string[]`, and `unquotePorcelainPath` stays used elsewhere in the file).
   Run the new file once. Before you write VERIFIED, apply each mutation by hand. Check that it fails its new test and that the test passes again once you revert it. Also run test/git-diff.test.ts and the test/merge-stack*.test.ts files under each mutation. If any of them fails as well, drop any claim that only the new tests catch the mutation.
5. docs/invariants.md: append "## Git diff paths: a tree diff tells an unreadable answer from an empty one, lists both ends of a move, and decodes every name" at the end, after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BJ had merged, BK and BL were planned, and BM was free. Follow the existing Guarantee / Binds / Pinned by layout:
   - 1: `treeDiffFiles` returns null when git fails and `[]` for identical trees, and with rename detection off a move lists both paths. `exemptTreeDelta` treats null as not exempt. Binds `treeDiffFiles` (src/git/git-diff.ts) and `exemptTreeDelta` (src/merge/merge-stack.ts). Pinned by the step-2 and step-3 tests.
   - 2: `aheadOfMainFiles` and `treeDiffFiles` hand back decoded real paths. `aheadOfMainFiles` diffs from the branch's fork point (three-dot), so files only main gained are left out. Binds `aheadOfMainFiles`, `treeDiffFiles`, `unquotePorcelainPath`. Pinned by the step-4 test, plus "aheadOfMainFiles omits files only main gained after the branch forked (three-dot range)" and "unquotePorcelainPath keeps malformed and unrecognized escapes as-is" (test/git-diff.test.ts).
   - 3: an `aheadOfMainDiff` over `maxBytes` is a truncation note, then `--stat`, then the largest files' whole sections while they fit, and it never exceeds `maxBytes`. It takes two git calls, not one per file. Binds `aheadOfMainDiff`. Pinned by "aheadOfMainDiff over the cap keeps --stat plus the largest files within budget" and "aheadOfMainDiff over the cap spawns only two git calls, not one per file" (test/git-diff.test.ts).
   Cite each test by its full name.

**Files touched.** test/git-diff-paths.test.ts (new); docs/invariants.md. No src/ change.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new tests pass.
- Each mutation named in steps 2–4 fails its new test when applied by hand, and the test passes again once it is reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -rF` each one in test/).
- `git diff -- src/` is empty.

### docs/invariants.md gains a fallback-chain-reason section, and one new test file pins the four chain reasons no test reaches: demoted, step-cap, reserve and overage (planned 2026-10-20 by the plan role; independent of every eligible plan; touches docs/invariants.md + a new test/budget-chain-info.test.ts)

**Goal.** `chainInfo` (src/gates/budget-gates.ts) builds the `chain` block the orchestrator publishes for each tier the budget gate moved off its primary. The block holds the step the tier runs on and the reason the position before it cannot run. The TUI, GUI, status and doctor show that reason. `ChainReason` (src/team/orchestrator-info.ts) has six values. Before this entry, tests reached only two of them through `pollBudgetGate`: "window" and "cap" (the two "chain: …" tests in test/budget-gates.test.ts). Every other test that mentions a chain reason builds the block by hand. No test imported `chainInfo`, and docs/invariants.md did not name it. "demoted", "step-cap", "reserve" and "overage" are therefore unpinned, and so is their order. The plan role ran a scratch probe that called `chainInfo` directly on 2026-10-20 and confirmed every behavior below. The probe was then deleted.

**Approach.**
1. Create test/budget-chain-info.test.ts (node:test + `node:assert/strict`). Do not edit test/budget-gates.test.ts. Import `chainInfo` from ../src/gates/budget-gates.js, `defaultConfig` from ../src/config/config.js, `IDLE_FALLBACK_BREAKER` from ../src/budget/fallback-breaker.js, `todayStamp` from ../src/budget/budget.js, and the `TierFallbackMap` type from ../src/config/config-fallbacks.js. Use a fixed `const now = new Date(2026, 9, 20, 12).getTime()` so that the local day cannot roll over during the test. Set `const midnight = new Date(2026, 9, 21).getTime()`. Write a local helper that calls `chainInfo` with these defaults: `resolved` = `{ default: <the case's resolution>, small: { pair: null, from: null }, strong: { pair: null, from: null } }`, `moved: new Set(["default"])`, `breakers: {}`, `states: []`, `windowOut: null`, `account: null` and `isPriced: () => true`. Each case overrides what it needs. States are `{ dayStamp: todayStamp(now), dayCostByPair: { … } }`. No temp directory is needed: `chainInfo` is pure.
   - Config "pi two-step": `defaultConfig()` with `provider = "paid"`, `model = "gpt-x"` and `fallback = [{ model: "free/qwen-free", maxDailyCostUsd: 1 }, "free/llama-free"]`. The resolution is `{ pair: { provider: "free", model: "llama-free" }, from: null, step: 1 }`.
   - Config "claude primary": `provider = undefined`, `backend = "claude"`, `model = "claude-sonnet-5-5"` and `fallback = [{ backend: "claude", model: "claude-opus-5-5" }, { model: "free/qwen-free", maxDailyCostUsd: 3 }]`. The resolution is `{ pair: { provider: "free", model: "qwen-free", maxDailyCostUsd: 3 }, from: null, step: 1 }`. The prior step is a Claude model after a Claude primary, so `tierOwnChain` gives it `extraUsage: true`.
2. Test "chainInfo names a demoted prior step, ahead of its spent step cap". Use pi two-step. Set `breakers` to `{ "free/qwen-free": { ...IDLE_FALLBACK_BREAKER, pair: "free/qwen-free", probeAt: now + 1000 } }` and spend `"free/qwen-free": 2`. Expect `chain.default` to deep-equal `{ pair: "free/llama-free", step: 2, of: 2, reason: "demoted" }`, with no `returnsAt`. Mutation: swap the demoted branch with the step-cap branch. The result then reads "step-cap".
3. Test "chainInfo names a prior step whose own cap is spent as step-cap, back at local midnight; under it the reason is cap". Use pi two-step with spend exactly `1` on `"free/qwen-free"`. Expect `reason: "step-cap"` and `returnsAt: midnight`. With spend `0.5`, expect `reason: "cap"` and `returnsAt: midnight`. Mutation: change `>=` to `>` in the step-cap comparison, so spend exactly at the cap reads "cap".
4. Test "chainInfo tells a reserve hold from a used-up window, both back at the window's reset". Use claude primary. With `windowOut: { resetsAt: now + 5000, reserve: true }` and spend `"free/qwen-free": 1.25`, expect `chain.default` to deep-equal `{ pair: "free/qwen-free", step: 2, of: 2, reason: "reserve", returnsAt: now + 5000, spentUsd: 1.25, capUsd: 3 }`. Without `reserve`, expect `reason: "window"` with the same `returnsAt`. Mutation: replace `a.windowOut.reserve ? "reserve" : "window"` with `"window"`.
5. Test "chainInfo names overage only for an extra-usage Claude step on an account that refuses it". Use claude primary with `account = { billing: "subscription", observedAt: now, windows: { five_hour: { status: "allowed_warning", overageStatus: "rejected", observedAt: now } } }`. Expect `reason: "overage"` and no `returnsAt`. With `overageStatus: "allowed"`, expect `reason: "cap"`. Use the same rejected account with a pi primary (`provider = "paid"`, `model = "gpt-x"`, same fallback list). There the Claude step is the first Claude model, so it has no `extraUsage`, and the expected reason is "cap". The plan role did not probe this pi-primary case: confirm it first, and drop it from the test if it does not hold. Mutation: change the `"rejected"` literal in `claudeOverageRefused`'s `overageStatus` comparison to `"refused"`.
6. Test "chainInfo lists only moved tiers, and prices a step only when it is priced". Use claude primary. With `isPriced: () => false`, expect no `spentUsd` or `capUsd` keys. With `moved: new Set()`, expect `{}`. Mutations: drop `&& a.isPriced(r.pair)`, and drop `!a.moved.has(tier) ||`.
   Run the new file once. Before writing VERIFIED, apply each mutation by hand, check that it fails its new test, then revert it. Every mutation must type-check, because tsc compiles the tests first and `noUnusedLocals` is on.
7. docs/invariants.md: append "## Fallback chain reasons: a moved tier names why the step before it cannot run, in a fixed order" at the end, after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BK had merged, BL and BM were planned, and BN was free. Follow the existing Guarantee / Binds / Pinned by layout:
   - 1: Only a tier the poll moved, with a non-null pair, gets an entry. The reason comes from the position just before the active step (the previous step, or the primary at step 0), checked in this order: demoted, step-cap, window/reserve, overage, cap. Binds `chainInfo`, `fallbackServingPair`, `pairDailyCost`. Pinned by the step 2, 3, 5 and 6 tests.
   - 2: `returnsAt` is the window's reset for "window" and "reserve", and the next local midnight for "step-cap" and "cap". "demoted" and "overage" carry none. `spentUsd`/`capUsd` appear only when the active step has its own cap and is priced. Pinned by the step 3, 4 and 6 tests, plus "chain: a rejected window puts the claude tier on its fallback step; under the cap with no window it is empty" and "chain: at the cap a priced tier lists its fallback step, a free primary stays unlisted" (budget-gates.test.ts), and "pollTeamGates: fallback_switched is logged once per chain change and orchestrator info carries chain" (gate-polls.test.ts).
   Cite each test by its full name.

**Files touched.** test/budget-chain-info.test.ts (new); docs/invariants.md. No src/ change. The in-flight Plain terms part 5/7 edits comments in src/gates; this plan does not touch src.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new tests pass.
- Each mutation named in steps 2–6 fails its new test when applied by hand, and the test passes again once reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -rF` each one in test/).
- `git diff -- src/` is empty.

## Done
