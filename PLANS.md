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

### Flake quarantine: a failed `quarantine.json` write warns instead of throwing out of a check whose re-run just passed (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/review/known-flakes.ts + test/known-flakes-quarantine.test.ts + docs/invariants.md)

**Goal.** `quarantineTests` (src/review/known-flakes.ts) ends with `saveQuarantine(root, entries)`, a bare `writeJsonAtomic(quarantinePath(root), …)` with no try. It has three callers, and each one runs it right after a re-run of the same tree **passed** (checked with `grep -rn 'quarantineTests(' src`):
- src/merge/merge-to-main.ts `verifyMerge`: the in-lock merge check failed, then passed on the immediate retry. A throw here rejects `mergeToMain` before `setMergeStage(…, "merging")`, so a change whose check is green fails its merge attempt.
- src/review/review-precheck.ts `gateBuildPrecheck`: the gate check failed, then passed on the retry. A throw rejects the gate, so the review attempt errors instead of going on with `outcome = retry.outcome`.
- src/baseline/main-watch.ts `watchOnce`: main's confirming re-run turned a red green. A throw skips the rest of `watchOnce` (the baseline transition handling after the re-run). The poll's `.catch` then logs a misleading "main watch could not check main" and marks the head watched.
Each caller ignores the return value. A full disk or a read-only `.tumwater/state` costs only the quarantine record, so it should not undo a passing check. This is the same best-effort contract `writePostReviews` (src/review/post-merge-review.ts) and the bootstrap latch write (src/gates/bootstrap-gates.ts) already follow.

**Approach.**
1. src/review/known-flakes.ts: in `quarantineTests`, replace the trailing `saveQuarantine(root, entries); return added;` with a try around `saveQuarantine`. On a catch, call `warnEventBestEffort(root, TUMWATER_SOURCE, \`could not write quarantine.json: ${errorMessage(err)}\`)` and `return []`, because nothing was recorded. Otherwise return `added` as before. Import `warnEventBestEffort` and `TUMWATER_SOURCE` from ../events/events.js (known-flakes.ts already imports a type from there, and events.ts imports nothing from src/review, so no cycle) and `errorMessage` from ../text/text.js. Add a sentence to the doc comment: "A failed write warns and returns no tests: the callers run this after a re-run passed, so a lost record must not fail that check." Leave `saveQuarantine`, `markQuarantineFiled` and `releaseQuarantine` unchanged. The latter two run only inside main-watch's `settleQuarantine`, whose try/catch already turns a throw into a "quarantine housekeeping failed" warning.
2. test/known-flakes-quarantine.test.ts: append the test "quarantine: a failed quarantine.json write warns and records nothing instead of throwing". Import `failRenameSyncOn` from ./helpers/fs-faults.js and `warningMessages` from ./fixtures/log-fixtures.js. With `root = tmpdir()`, `const undo = failRenameSyncOn(quarantinePath(root), "disk full")`. In a try/finally that calls `undo()`, assert `quarantineTests(root, ["a"], "out")` deep-equals `[]`, which also proves it did not throw. After the finally, assert `quarantinedTests(root)` deep-equals `[]`. Assert `warningMessages(root)` holds exactly one message starting with `could not write quarantine.json` that includes `disk full`. Then call `quarantineTests(root, ["a"], "out")` again (the fault is undone) and assert it returns `["a"]`.
3. docs/invariants.md: in the existing section "## Flake quarantine: a test that failed then passed on one tree is quarantined until its filed bug leaves ## Open, and a possibly truncated list never counts", add `### INV-BI5: a failed quarantine write warns and never throws out of the check that passed` after INV-BI4, in the same Guarantee / Binds / Pinned by layout. No new letter pair is needed. Guarantee: `quarantineTests` never throws on a failed store write. It warns once per failed call, records nothing, and returns `[]`, so the gate's re-run, the in-lock merge check's re-run and main-watch's confirming re-run go on with their passing result. Binds `quarantineTests`. Pinned by the step-2 test, cited by its full name.

**Acceptance criteria.**
- With step 1's try/catch removed, the new test fails (the call throws `disk full`). With `return []` replaced by `return added`, it fails (it returns `["a"]`).
- The existing tests in test/known-flakes.test.ts, test/known-flakes-quarantine.test.ts and test/main-watch.test.ts pass unchanged.
- `npm run test:gate` passes.
- `git diff --stat` shows src/review/known-flakes.ts as the only changed src/ file.
- The test name cited in INV-BI5 exists verbatim (`grep -rF` it in test/).

### Worktree pool: a release whose slots.json write fails warns instead of throwing, and the next claim reclaims the slot (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/git/worktree-pool.ts + test/worktree-pool.test.ts + docs/invariants.md)

**Goal.** A lease handle's `release` (the handle `prepareLeased` builds in src/git/worktree-pool.ts) calls `releaseSlot`. `releaseSlot` is an `updateSlotsState` read-modify-write (src/git/slots-state.ts), and its `writeJsonAtomic` and the slots lock's `withStateLock` timeout run with no try. A failed write (ENOSPC, EACCES, a lock timeout) causes three problems:
- `release` throws. `wakeWaiters` and `removeDroppedSlots` never run.
- The slot stays leased on disk under this live pid. `clearDeadLeases` only clears another pid's lease, so the pool loses that slot until the team restarts.
- The callers release in a `finally` (`runOnceInLeasePhase` in src/runner/runner-run.ts, and `.finally(() => lease.release())` in src/review/review.ts). A throw there replaces the run's own outcome or error.

`prepareLeased`'s prepare-failure path calls `releaseSlot` before `throw err`, so a failed write there also masks the real checkout error. On 2026-10-20 the plan role confirmed this with a scratch test (since deleted). It took `leaseSlot` on a `worktreeSlots: 1` repo, installed `failRenameSyncOn(slotsStatePath(root), "EACCES fake")` and called `release()`. The call threw `Error: EACCES fake`, slots.json still held the lease with `process.pid`, and a following `tryLeaseSlot` returned null. The precedent is "a release whose use-record write fails still frees the slot" (test/worktree-pool.test.ts), which guarded the use-registry half of the same release.

**Approach.**
1. src/git/worktree-pool.ts:
   - Add a module-level `const unsavedReleases = new Map<string, Set<string>>()`, keyed by `rootKey(root)`. It holds the slot dirs whose release write failed in this process.
   - Add `function freeSlot(root, dir, role, count, pin): string[]`. It returns `releaseSlot(...)`. On a catch, it adds `dir` to the root's set, calls `warnEventBestEffort(root, TUMWATER_SOURCE, \`could not free slot ${path.basename(dir)}: ${errorMessage(err)}; the next lease reclaims it\`)` and returns `[]`. All three imports already exist in the file.
   - In `prepareLeased`, replace both `releaseSlot(` calls (the prepare-failure path and the handle's `release`) with `freeSlot(`. `wakeWaiters` and `removeDroppedSlots` then run on every path.
   - In `tryClaim`, inside the `updateSlotsState` callback and before `chooseSlot`, read the root's set. For each `state.slots` entry whose `dir` is in it and whose `lease?.pid === process.pid`, set `lease = null`. After `updateSlotsState` returns, delete the root's key: the write landed, so the reclaim is on disk. If it throws, the set stays and the next claim retries.
   - Note in the doc comment that the pin and `lastRole` the failed release would have recorded are not replayed. A lost pin only means the next resume gets a fresh checkout.
2. test/worktree-pool.test.ts: add the test "a release whose slots.json write fails warns instead of throwing, and the next lease reclaims the slot". Import `failRenameSyncOn` from ./helpers/fs-faults.js and `warningMessages` from ./fixtures/log-fixtures.js. The test does the following:
   - Set up with `makeRepo()`, `writeConfig(root, { worktreeSlots: 1 })` and `const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" })`.
   - Install `const undo = failRenameSyncOn(slotsStatePath(root), "EACCES fake")`, assert `doesNotThrow(() => lease.release())`, then `undo()`.
   - Assert that some `warningMessages(root)` entry includes both `could not free slot` and `EACCES fake`.
   - Call `const next = await tryLeaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" })`. Assert `next?.dir === lease.dir`, and that slots.json's record for that dir now has `lease.role === "bugfix"`. Then `next!.release()`.
3. docs/invariants.md: append the section "## Worktree pool release: a failed slots.json write never throws out of a release" after the last section. Use the Guarantee / Binds / Pinned by layout, with `### INV-CC1: a release whose slots.json write fails warns, and the next claim in this process reclaims the slot`. Binds: `src/git/worktree-pool.ts` (`freeSlot`, `tryClaim`, `prepareLeased`). Pinned by: the new test, plus the existing "a release whose use-record write fails still frees the slot". On 2026-10-20 CA had merged and CB was taken by the live-reload opencode plan, so CC was free. Re-check with `grep -n '^### INV-' docs/invariants.md | tail` and the Planned entries before writing it, and take the next free pair if CC is gone.

**Acceptance criteria.**
- With `freeSlot`'s try/catch removed, the new test fails (`release()` throws `EACCES fake`).
- With the reclaim loop in `tryClaim` removed, the new test fails (`tryLeaseSlot` returns null).
- The existing tests in test/worktree-pool.test.ts pass unchanged.
- `npm run test:gate` passes.
- `git diff --stat` shows src/git/worktree-pool.ts as the only changed src/ file.
- Each test name cited in INV-CC1 exists verbatim (`grep -rF` it in test/).

## Done
