# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code cleanup, part 4/7: Migrate the backend selector callers and retire the cleanup names (planned 2026-10-16 by user; requires part 3/7 landed; design in plans/terminology.md "Code names" and "Guards"; touches src/doctor/ + src/gates/ + src/roles/ + src/prompt/ + src/ui/ + src/run/ + src/runner/ + src/status/ + src/cli/ + src/review/ + src/paths.ts + their tests + test/retired-names.test.ts)

**Goal.** Every caller uses the backend names from part 3/7, the deprecated aliases are gone, and test/retired-names.test.ts lists the old names of all the cleanup families, so the code rename is complete.

**Approach.**
- Rules for this part:
  - Rename only "agent" meaning the backend selector (pi/claude), as in part 3/7. Keep `runAgent`, `AgentRunSpec`, `AgentInvocation`, `AgentExit*`, `AgentBackend`, `registerAgentBackend`, `foldAgentCommitsSince`, pi protocol names, `PI_CODING_AGENT_DIR`, `AGENTS.md` handling, and "agent run".
  - Legacy readers keep old names on purpose (`CONFIG_KEY_RENAMES`, src/roles/legacy-role-ids.ts, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `normalizeLegacyEvent`'s tables, the state loaders' legacy-key maps, the `legacyLand*` helpers, and fixtures that write old names). The retired-names guard exempts them through `LEGACY_FILES`, `legacy`-prefixed identifiers and `retired-name-ok` lines or regions; never add a second mechanism.
  - Members (fields, methods, parameters) are renamed with all their uses. Never shadow an existing binding. Rewrap comment lines past 100 columns (test/comment-width.test.ts).
- Callers to migrate:
  - src/doctor/ (doctor.ts, doctor-checks.ts, doctor-model-checks.ts): `checkAgentBinary` → `checkBackendBinary`, `agentBinaryCheck` → `backendBinaryCheck`, plus uses of `agentsInUse`, `isAgentId`, `agentQualifiedSelector` and `agentBaseEnv`.
  - src/gates/ (readiness.ts, startup-gate.ts), src/roles/ (role-render.ts's `agentDefault` function → `backendDefault`), src/ui/badges.ts's local `agentDefault` → `backendDefault`, src/status/, src/cli/, src/review/ (`agentSessionResumable`) and src/prompt/: migrate.
  - Members holding a backend id: `RunPromptInput.agent` (src/run/run-prompt.ts) → `backend`; `RoleRunner.runPrompt(agent?)` and `RunnerRunContext.runPrompt(agent?)` parameters → `backend`; `buildDirectorPrompt`'s backend parameter; `nativeLogPath(root, role, agent)` in src/paths.ts → `backend`. Rename each with all its uses.
- Tests: test/doctor-checks.test.ts (about 23 lines), test/doctor-model-checks.test.ts, test/run-resume.test.ts, test/gui-operator.test.ts, test/gui-client-settings.test.ts, test/status-data-budget.test.ts, test/runner-pi*.test.ts, test/review-followup.test.ts, test/provider-lease.test.ts, test/pi.test.ts and test/fakes/fake-pi.ts.
- Delete every alias part 3/7 added (`grep -rn '@deprecated Use' src test` must list none from this series).
- Extend the guard in test/retired-names.test.ts (shape `{ family, words, fileWords, allow }`, plus the optional exact-name `identifiers` field Plain terms code run 20/20 added):
  - a `notes` family: `words: ["notebook", "notebooks"]`, `fileWords: ["notebook"]`;
  - a `brief` family: `identifiers: ["initialPrompt", "readInitialPrompt", "editInitialPrompt", "replaceInitialPrompt", "INITIAL_PROMPT_MAX_CHARS"]`;
  - a `role-ids` family: `identifiers: ["telemetryDigest", "TELEMETRY_DIGEST_DAYS", "dryRow", "dryFailedAt"]`. Not the words `dry` or `telemetry`, which still mean a dry run, generic telemetry and `DISABLE_TELEMETRY`;
  - a `backend` family: `identifiers: ["AgentId", "AGENT_IDS", "isAgentId", "DEFAULT_AGENT", "AgentConfig", "AgentBinConfig", "AGENT_KEYS", "resolveAgentBin", "findAgentBinary", "checkAgentBinary", "agentMissingMessage", "agentsInUse", "collapseAgentAliases", "resolvedAgentConfig", "agentQualifiedSelector", "AGENT_DEFAULT_MODELS", "agentBaseEnv", "agentBinSourceLabel", "agentSessionResumable"]`.
  Never list `customLoops`, `agent`, `agents`, `agentBin`, `dry` or `telemetry`: they are live legacy keys and ids. Legacy readers use the guard's existing exemptions: `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines, and `retired-name-ok:start`/`end` regions. Add no new mechanism.
- Confirm the guard now covers all five code families (team, merge, runner, run, cleanup). If an earlier family's last part missed an entry its own entry named, add it here.

**Files touched.** The caller files above, the alias declarations in src/config/, src/agent/ and src/pi/, the tests listed above, and test/retired-names.test.ts.

**Acceptance criteria.**
- `grep -rn '@deprecated Use' src test` prints nothing.
- `grep -rnE '\b(AgentId|AGENT_IDS|isAgentId|DEFAULT_AGENT|AgentConfig|AgentBinConfig|AGENT_KEYS|resolveAgentBin|findAgentBinary|checkAgentBinary|agentsInUse)\b' src test` lists only the retired-names list and exempt legacy readers.
- test/retired-names.test.ts passes with the new families; adding `const readInitialPrompt = 1;` or `const notebookPath = 1;` to a src/ module makes it fail (check locally, do not commit).
- `npm run test` passes.

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

### docs/invariants.md gains a batch-merge section, and one new test file pins that a stack seeds main's baseline only when a full check passed on exactly the merged tip (planned 2026-10-20 by the plan role; independent of every eligible plan; touches docs/invariants.md + a new test/merge-stack-seed.test.ts)

**Goal.** `mergeStack` (src/merge/merge-stack.ts) merges a batch of approved changes. It cherry-picks them onto main's tip, runs ONE scope-`batch` check over the combined tree, and fast-forwards main through the captured shas (`ffStackToMain`). When main moves mid-check, it re-stacks, up to `BATCH_RESTACK_ATTEMPTS` times. Before this entry, docs/invariants.md named neither file nor function (`grep -c 'merge-stack\|mergeStack' docs/invariants.md` gave 0). After a merge, `mergeStack` calls `noteGreenBaseline(seed)` (src/baseline/main-baseline.ts). That records the tip as green in the cache the main watch and the redeployer read. `seed` is set only when the batch check status is `"passed"` and `mergeCommandOf(ctx.config) === undefined`. A doc-only stack, a stack whose failures are all main's known failures (`onlyKnownMainFailures`), and a `check.mergeCommand` green seed nothing. Before this entry, no test read `cachedBaselineVerdict` after a batch merge: `grep -n cachedBaselineVerdict test/merger-*.test.ts test/merge-stack.test.ts` gave nothing. A regression that seeded a known-red or unchecked tip as green would skip the main watch's check on that tip and go unnoticed.

**Approach.**
1. New test/merge-stack-seed.test.ts (node:test + `node:assert/strict`). Do not edit test/merger-bisect.test.ts, test/merger-restack.test.ts or test/merge-stack.test.ts: the waiting "Plain terms code cleanup" parts may touch test files. Imports: `cachedBaselineVerdict` from ../src/baseline/main-baseline.js, `createMainWatch` from ../src/baseline/main-watch.js, `defaultConfig` from ../src/config/config.js, `mainSha` from ./fixtures/repo-fixtures.js, `withApprovePi` from ./fakes/fake-pi.js, and `batchFixture`, `runBatch`, `batchChecks`, `declareCheck`, `checkAfterGates`, `verifyThenMerge`, `makeBatchCtx`, `request` from ./fixtures/merger-fixtures.js. Copy the setup shapes from the merger-bisect.test.ts tests named below. Each test uses roles `["alpha", "beta"]` and first asserts that both results are `"changed"`.
2. Test "a stack whose batch check passed seeds the merged tip green". `checkAfterGates(root, 2, "true")`, then `runBatch`. Assert `batchChecks(root)` statuses deep-equal `["passed"]` and `cachedBaselineVerdict(mainSha(root))` is `"green"`. Mutation: in `mergeStackIn`, change `noteGreenBaseline(seed)` to `noteGreenBaseline(base)`.
3. Test "a stack that fails only main's known failures merges but seeds nothing". Use the setup from "a stack check that fails only main's known failures merges the whole stack in one check": `declareCheck` printing `✖ X (1ms)` and exiting 1, then `createMainWatch(root, "main")`, `poll(mainSha(root), false, defaultConfig())` and `await watch.idle()`. Assert one batch check, and `cachedBaselineVerdict(mainSha(root))` is `undefined` after the merge. Mutation: in the `seed = tip` condition, change `check.outcome.status === "passed"` to `check.outcome.status !== "skipped"`.
4. Test "a doc-only stack runs no check and seeds nothing". Use the `edit` option from "a stack whose every change is doc-only merges with no batch check", which appends to `${role}.md`, with a declared check that exits 1. Assert `batchChecks(root).length` is 0 and `cachedBaselineVerdict(mainSha(root))` is `undefined`. Mutation: in the exempt arm, add `seed = tip;` right after the `if (await exemptSkipBlockReason(…)) return { kind: "conflict" };` statement.
5. Test "a stack merged on check.mergeCommand runs it as a non-full batch check and seeds nothing". Call `checkAfterGates(root, 2, "exit 1")`: the full check passes the two gate pre-checks and fails anything after them. Then call `verifyThenMerge(makeBatchCtx(root, { ...defaultConfig(), check: { command: "", mergeCommand: "echo cheap" } }), roles.map((role) => request(shas[role]!, { role })), wiringFor)`. This mirrors test/merge-to-main-recheck.test.ts's "check.mergeCommand merges a tree the full check would fail, runs it as a non-full check, and seeds nothing". Assert one batch check with `script` `"echo cheap"` and `full` `false`, and `cachedBaselineVerdict(mainSha(root))` is `undefined`. Mutation: change `mergeCommandOf(ctx.config) === undefined` to `mergeCommandOf(undefined) === undefined`. Do not delete the clause instead: that leaves the import unused, and `noUnusedLocals` fails the compile.
   Run the new file once. Before you write VERIFIED, check by hand that each named mutation fails its new test and that the test passes again once the mutation is reverted. Tests compile through tsc first, so a mutation must type-check. Also run test/merger-bisect.test.ts and test/merger-restack.test.ts under each mutation. If one fails there too, drop any claim that only the new tests catch it. If a step's setup does not reach the `seed` line as described, adjust the setup, not src/. For example, gate pre-checks may need a different count.
6. docs/invariants.md: append "## Batch merge: a stack merges as one fast-forward on its own check, and only a full check that passed on exactly the merged tip seeds main's baseline" at the end, after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BG (team hold) had merged and BH (review verdict) and BI (flake quarantine) were planned, so BJ was free. Take the letter pair after the highest one that is taken or planned. Follow the existing Guarantee / Binds / Pinned by layout:
   - 1: one scope-`batch` check covers the whole stack. A green stack fast-forwards main once through the captured shas, logging one `merged` event per change, and deletes each change's merge ref. Binds `mergeStack`, `ffStackToMain`. Pinned by "a stack whose every change passes still takes exactly one batch check" (merger-bisect.test.ts) and "ffStackToMain fast-forwards main through the whole stack in one ff with per-change events" (merge-stack.test.ts).
   - 2: a fast-forward lost to a moved main re-stacks on the new tip, up to `BATCH_RESTACK_ATTEMPTS` times. A re-stack whose tree adds only review-exempt changes to the checked tree skips its re-check. A race lost on every attempt, a primary checkout dirty in the stack's files, and a stop before an attempt all keep every ref and merge nothing. Binds `mergeStack`, `BATCH_RESTACK_ATTEMPTS`. Pinned by "a fast-forward lost to a doc-only commit re-stacks without a second batch check", "a batch that loses the fast-forward race on every attempt keeps every ref as merge_blocked", "an abort between re-stack attempts stops the batch: aborted, refs kept, nothing merges", "a batch whose files are dirty in the primary checkout is blocked before its check" (merger-restack.test.ts) and "ffStackToMain returns merge_blocked when main diverged under the stack, with no events" (merge-stack.test.ts).
   - 3: a stack whose whole delta is review-exempt runs no check, but runs the same cross-checks as verifyMerge's exempt arm. If either fails, the stack goes to the one-at-a-time fallback. Pinned by "a stack whose every change is doc-only merges with no batch check" and "a doc-only stack that breaks backlog structure is blocked, not waved through" (merger-bisect.test.ts).
   - 4: the step-2 to step-5 rule. Binds `mergeStack`, `noteGreenBaseline`. Pinned by the four new tests.

**Files touched.** test/merge-stack-seed.test.ts (new); docs/invariants.md. No src/ change.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new tests pass.
- Each mutation named in steps 2–5 fails its new test when applied by hand, and the test passes again once the mutation is reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -F` each one in test/).
- `git diff -- src/` is empty.

### docs/invariants.md gains a staging self-check section, and one new test file pins that each git-level finding stops at its cap and says how many it left out (planned 2026-10-20 by the plan role; independent of every eligible plan; touches docs/invariants.md + a new test/stage-path-caps.test.ts)

**Goal.** `gitLevelFindings` (src/run/stage-path-checks.ts) is the git-level half of the pre-commit self-check: `stageCheckFindings` (src/run/stage-check.ts) calls it, and the findings go back to the author's still-open session. Each finding is meant to stay bounded however large the change is. The caps are `MAX_STALE_PATHS` (stale-reference findings per change), `MAX_STALE_HITS` (`file:line` hits per stale reference), `MAX_MISSING_PATHS` and `MAX_NEWLINE_FILES` (all 10). `cappedList` appends `moreSuffix` (src/text/phrases.ts, ` (+N more)`) for what a missing-path or lost-newline finding leaves out. Before this entry, no test in test/stage-check.test.ts makes a change that exceeds any of these caps, and docs/invariants.md named neither stage-path-checks.ts nor `gitLevelFindings`. A regression that dropped a cap would send a 40-file rename's whole reference list into the session's prompt, and none of the tests would notice.

**Approach.**
1. New test/stage-path-caps.test.ts (node:test + `node:assert/strict`). Do not edit test/stage-check.test.ts: the waiting "Plain terms code cleanup" parts may touch test files. Copy that file's small `repoWith(files)` helper (`makeRepo`, `sh` from ./fixtures/repo-fixtures.js, `ensureWorktree(root, "improve", "main")` from ../src/git/worktree.js). Call `gitLevelFindings(wt, "main")` directly. Use two-digit, zero-padded names (`00`…`11`) so git's path order matches the numeric order and no name is a prefix of another.
2. Test "a missing-path finding names the first ten paths and counts the rest". Base: `src/keep.ts` and `README.md` (`Start.\n`). In the worktree, append twelve lines `See src/x/f00.ts.` … `See src/x/f11.ts.` to README.md. Assert exactly one finding. It contains `src/x/f09.ts`, does not contain `src/x/f10.ts`, and ends with ` (+2 more)`. Mutation: `MAX_MISSING_PATHS = 11`.
3. Test "a lost-final-newline finding names the first ten files and counts the rest". Base: `src/n00.ts` … `src/n10.ts`, each `export const n = 1;\n`. In the worktree, rewrite each without its trailing newline. Assert one finding matching `/removes the final newline from: /`. It contains `src/n09.ts`, does not contain `src/n10.ts`, and ends with ` (+1 more)`. Mutation: `MAX_NEWLINE_FILES = 11`.
4. Test "a change deleting more referenced paths than the cap reports only the cap's worth". Base: `src/d00.ts` … `src/d10.ts` (`export const d = 1;\n`), plus README.md with one line `See src/dNN.ts.` per file. Delete all eleven in the worktree. Assert that the findings matching `/ was deleted but is still named at: /` number exactly 10. Mutation: `MAX_STALE_PATHS = 11`.
5. Test "one stale reference lists at most ten of its hits". Base: `src/d.ts` plus a `docs/guide.md` naming `src/d.ts` on twelve separate lines. Delete `src/d.ts`. Assert one finding, and `/docs\/guide\.md:\d+/g` matches it exactly 10 times. Mutation: `MAX_STALE_HITS = 11`.
   Run the new file once. Before you write VERIFIED, apply each named mutation by hand (each is a one-constant edit that type-checks). Check that it fails its own new test, and that the test passes again once you revert it. Also run test/stage-check.test.ts under each mutation. If a test fails there too, drop any claim that only the new tests catch it.
6. docs/invariants.md: append "## Staging self-check: each git-level finding stops at its cap, and a check that cannot run adds nothing" at the end, after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BH, BI and BJ were planned and BK was free. Entries:
   - 1: the step-2 to step-5 rule. A finding names at most 10 paths, files or hits, and a missing-path or lost-newline finding counts the rest as ` (+N more)`. A change emits at most 10 stale-reference findings. Binds `gitLevelFindings`, `cappedList`, the `MAX_*` constants. Pinned by the four new tests.
   - 2: the git-level checks are best-effort, and the index is restored. A failed git command adds no finding and does not throw. `gitLevelFindings` resets the index to HEAD in `finally`, so the run's change detection still sees the worktree. Binds `gitLevelFindings`, `stageCheckFindings` (its `.catch(() => [])`). Pinned by "a git failure yields no findings instead of throwing", "the git-level check leaves the index clean, so change detection still sees the worktree" and "a clean change yields no findings" (test/stage-check.test.ts).

**Files touched.** test/stage-path-caps.test.ts (new); docs/invariants.md. No src/ change.

**Acceptance criteria.**
- `npm run test:gate` passes, and the new tests pass.
- Each mutation named in steps 2–5 fails its new test when applied by hand, and the test passes again once the mutation is reverted. Report this in VERIFIED.
- Every test name cited in the new section exists verbatim (`grep -F` each one in test/).
- `git diff -- src/` is empty.

## Done
