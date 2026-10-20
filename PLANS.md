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

### Merge check attribution: a failed role-state save warns instead of throwing out of a red check's verdict, so a rejected change still loses its pin and a main-red pin still settles as main_red (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/merge/merge-check-failures.ts + src/merge/merge-slot.ts + test/merger.test.ts + docs/invariants.md)

**Goal.** When a merge's in-lock check goes red, the change is judged by `mergeCheckRed` / `mergeBlocked` / `attributeRedCheck` (src/merge/merge-check-failures.ts). Their sinks call `saveRunnerState` five times with no `try`: `rejectChange`, `keepForKnownFailures`, and three branches of `attributeRedCheck` (unverified red, known-flake excuse, main red). Each one is an early save. The merge slot's write-back (`writeMergeOutcome`, src/merge/merge-slot.ts) saves the same in-memory state later, best-effort. When the state file cannot be written (full disk, EACCES), the save throws out of `mergeApprovedChange`, and the single-change caller in src/merge/merge-batch.ts degrades the throw to `"error"`. A plan-role scratch test on 2026-10-20 checked this. It copied "a single merge's red in-lock check retries once, then rejects on a green main" (and the main-red twin) from test/merger.test.ts and faulted `writeFileSync` on `.tmp-` paths under `.tumwater/state/improve.json` around the second `mergeApprovedChange`. Results:
- On a green main, the call threw ENOSPC after `recordReview` had already put a reject on the state. The merge ref stayed set and no `review_rejected` was logged, so the rejected change survives for leftover recovery to re-merge.
- On a red main, it threw instead of returning `"main_red"`, so `requeueKeptChange` never recorded `mainRedRetry`.

With the five calls swapped to `saveRunnerStateBestEffort`, the same scenarios returned `"rejected"` (ref null, one `review_rejected`) and `"main_red"` (ref kept). Each logged one "could not save the role's state: ENOSPC" warning. The same kind of call sits in `requeueKeptChange`'s `mainRedRetry` save (src/merge/merge-slot.ts). `settleMergeOutcome` (src/merge/merge-pipeline.ts) catches that throw, but logs "could not re-queue the kept change" even though the record was already set in memory, so it gets the same swap. This is a sibling of "Review gate: a failed role-state save mid-review warns instead of throwing out of the verify" (above, in flight). That plan deliberately left these sites alone. `saveRunnerState` stays strict; callers that cannot afford a throw use the best-effort wrapper.

**Approach.**
1. src/merge/merge-check-failures.ts: replace each `saveRunnerState(ctx.root, state)` with `saveRunnerStateBestEffort(ctx.root, state)`, in `rejectChange`, `keepForKnownFailures` and `attributeRedCheck`'s three branches. In the ../runner/runner-state.js import, swap `saveRunnerState` for `saveRunnerStateBestEffort`. `grep -n 'saveRunnerState(' src/merge/merge-check-failures.ts` must then find nothing.
2. In `rejectChange`'s doc comment, change "persist state" to "persist state best-effort (a failed save warns; the merge write-back saves the same state later), so the ref is deleted and review_rejected logged even on a full disk". In `attributeRedCheck`'s doc comment, change "The verdict is persisted before it returns" to "The verdict is persisted best-effort before it returns".
3. src/merge/merge-slot.ts `requeueKeptChange`: in the `isMainRed` branch, replace `saveRunnerState(root, state)` with `saveRunnerStateBestEffort(root, state)`. Drop `saveRunnerState` from that file's import only if `grep -n 'saveRunnerState(' src/merge/merge-slot.ts` finds no other call (lint fails on an unused import).
4. Do not touch merge-core.ts or review-run.ts. The in-flight sibling plan owns them.

**Files touched.** src/merge/merge-check-failures.ts, src/merge/merge-slot.ts, test/merger.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/merger.test.ts, "an unwritable state file during a red merge check's attribution still settles its verdict", with a `for (const main of ["green", "red"] as const)` loop like its model. Copy the setup of "a single merge's red in-lock check retries once, then …": `pinnedFixture`, `advanceMain`, `noteGreenBaseline(tip)` for green, and the planted red `check.command`. Run the first `mergeApprovedChange` unfaulted; it returns `"merge_blocked"`. Then install `patchFsMethod("writeFileSync", …)` from ./helpers/fs-faults.js, which throws `errnoError("ENOSPC")` when `file` is a string starting with `` `${statePath(root, ROLE)}.tmp-` `` and calls the original otherwise. Run the second `mergeApprovedChange` and undo the patch in a `finally`. Assert:
  - green: the result is `"rejected"`, `await refSha(root, REF)` is null, and `eventsOfType(root, "review_rejected").length === 1`;
  - red: the result is `"main_red"`, the ref still equals `sha`, and there are no `review_rejected` events;
  - both: `warningMessages(root)` has an entry starting with `could not save the role's state`.
  Mutations it must catch: restoring `saveRunnerState` in `rejectChange` makes the green case reject with ENOSPC, and restoring it in `attributeRedCheck`'s main-red branch does the same for the red case. The unverified, known-flake and known-failures saves, and `requeueKeptChange`'s save, are covered by the swap only, not by this test, and the invariant must not claim otherwise.
- The existing test/merger.test.ts, test/merger-bisect.test.ts and test/merge-slot*.test.ts tests pass unchanged.
- docs/invariants.md: at the END of the file, after every section present when the change is made (CL's included, if it has merged), add `## Merge check attribution: a failed state save never fails the verdict`. Under it put `### INV-CM1: a red merge check attributed while role-state saves fail still deletes a rejected pin and logs review_rejected, or returns main_red with the pin kept, warning once per failed save`, in the Guarantee / Binds / Pinned by layout. Binds: `src/merge/merge-check-failures.ts` (`rejectChange`, `attributeRedCheck`), `src/runner/runner-state.ts` (`saveRunnerStateBestEffort`). Pinned by: the new test's names, both loop variants. Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. CL is reserved by the review-gate plan, and CM was free on 2026-10-20.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

### Main revert: a heal prompt or reviewer hand-off that cannot be queued warns instead of throwing, so runMainRevert keeps its never-throws contract and its warning no longer claims a prompt it did not queue (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/baseline/main-revert.ts + test/main-revert.test.ts + docs/invariants.md)

**Goal.** `runMainRevert` (src/baseline/main-revert.ts) is documented "Never throws", but its local `heal` closure is not guarded. `heal` calls `queueCulpritHeal` (src/baseline/main-red.ts), which reaches `enqueueRolePrompt`'s `writeTextAtomic` (src/inbox/inbox.ts), or the caller's `onFailed` (`sendReviewToRole` in src/merge/merge-drain.ts, also `enqueueRolePrompt`). Either can throw (ENOSPC, EACCES). Reproduced 2026-10-20 with a scratch copy of "a revert that conflicts leaves main alone and queues the heal prompt naming the culprit", with `writeFileSync` faulted (ENOSPC) for paths under `roleInboxDir(root, "bugfix")`. `runMainRevert` rejected with `Error: ENOSPC` and logged two warnings, `could not revert <sha>: reverting <sha> conflicted; … — queued the heal prompt for bugfix` and `revert of <sha> failed: ENOSPC — queued the heal prompt for bugfix`. Both claim a prompt that was never queued. The second comes from the outer `catch` running `heal` a second time, and that second throw is what escapes. Only `guardMergeTask` (src/merge/merge-pipeline.ts) catches it, adding a third warning, `merge task for main revert could not settle`.

**Approach.** Change `src/baseline/main-revert.ts` only:
- Make `heal` never throw. It returns the warning's suffix, keyed on the branch it actually took (`c.postReview && onFailed` decides between `onFailed` and `queueCulpritHeal`, as today):
  - On success it returns today's text: `sent the reviewer's reasons to its role` or `queued the heal prompt for bugfix`.
  - When the call throws it returns `could not send the reviewer's reasons to its role: <errorMessage(err)>` or `could not queue the heal prompt for bugfix: <errorMessage(err)>`.
- Both failure sites (the `failure !== null` branch and the outer `catch`) call `heal` first and then log their existing warning with `— ${suffix}` in place of today's fixed ternary. Each failed revert therefore logs exactly one warning, and that warning says truthfully whether the hand-off was queued.
- The outer `catch` still covers throws from the revert itself. Because `heal` no longer throws, a heal failure cannot re-enter that `catch`, and `runMainRevert` resolves.
- Leave the doc comment's "Never throws" in place, and add one clause saying that a hand-off which cannot be queued is warned, not thrown.
- No other file in src/ changes. `startRevert`'s `.finally` (`settlePostReview`) and `guardMergeTask` stay as they are.

**Files.** src/baseline/main-revert.ts, test/main-revert.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/main-revert.test.ts, "a conflicting revert whose heal prompt cannot be queued resolves and warns once that it was not queued":
  - Set up with `redMain("improve", true)`. Fault `writeFileSync` with `patchFsMethod` + `errnoError("ENOSPC")` (test/helpers/fs-faults.ts) only for paths that start with `roleInboxDir(root, "bugfix")`, and restore the fault in `finally`.
  - Assert that `runMainRevert(root, "main", defaultConfig(), found[0]!)` resolves, that `headSha(root)` is unchanged, that `queuedFiles(root, "bugfix")` is empty, and that `eventsOfType(root, "main_revert")` is empty.
  - Assert that `warningMessages(root)` (test/fixtures/log-fixtures.ts) holds exactly one message that matches `/could not revert .*could not queue the heal prompt for bugfix: .*ENOSPC/`, and none that matches `/queued the heal prompt/` without the "could not" prefix.
  - Before the fix this test fails, because `runMainRevert` rejects with ENOSPC.
- New test, "a post-review revert whose reviewer hand-off throws resolves and warns that the reasons were not sent":
  - Use the same red-main setup. Pass the culprit as `{ ...found[0]!, postReview: { reasons: ["r"] } }` and an `onFailed` that throws `new Error("EACCES")`.
  - Assert that it resolves, and that exactly one warning matches `/could not send the reviewer's reasons to its role: EACCES/`.
- The existing tests in test/main-revert.test.ts pass unchanged. In particular, "a revert that conflicts leaves main alone and queues the heal prompt naming the culprit" still queues exactly one bugfix prompt.
- docs/invariants.md: at the END of the file, after every section present when the change is made, add `## Main revert: a hand-off that cannot be queued never fails the revert task`. Under it put `### INV-CO1: a failed automatic revert whose heal prompt or reviewer hand-off cannot be queued resolves, logs one warning saying the hand-off was not queued, and leaves main unchanged`, in the Guarantee / Binds / Pinned by layout:
  - Binds: `src/baseline/main-revert.ts` (`runMainRevert`).
  - Pinned by: both new tests' names.
  - Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. CL, CM and CN are already claimed, and CO was free on 2026-10-20.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

## Done
