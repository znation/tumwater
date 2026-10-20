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

### Review gate: a failed role-state save mid-review warns instead of throwing out of the verify, so the reviewer's spend still folds and its verdict still settles (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/merge/merge-core.ts + src/review/review-run.ts + test/merger.test.ts + docs/invariants.md)

**Goal.** A merge's verify (`verifyRequest`, src/merge/merge-batch.ts) runs `reviewPinnedChange` (src/merge/merge-core.ts), which runs the reviewer through `reviewAheadOfMain` → `runReviewer` (src/review/review-run.ts). Along the way it calls `saveRunnerState` six times with no `try`. Each one is an early crash-safety save: the merge slot's write-back (`writeMergeOutcome`, src/merge/merge-slot.ts) and the run's end (`finalizeRun`) save the same in-memory state later, best-effort. The six:
- `runReviewer`: the resume-count save (`priorResume.attempts += 1`), the `state.phase = "review"` save before the run, and the `state.reviewResume = { … }` save after a failed run;
- `reviewPinnedChange`: the verdict save right after `recordRejectedChange`, before the `foldUsage` calls;
- `mergeApprovedChangeIn`'s `recheckResolved` callback: the save after the re-review's `setMergeStage`, and the save after its `recordRejectedChange`, before `deleteRef`.

When the state file cannot be written (full disk, EACCES), any of these throws out of the verify. A thrown verify skips the reviewer's `foldUsage`, so its spend never reaches the role's totals or the daily cap. A rejected re-review keeps its pin and never logs `review_rejected`. A plan-role scratch test on 2026-10-20 checked this. It copied "a resolution the re-review rejects deletes the pin and merges nothing" (test/merger.test.ts) and faulted `writeFileSync` on `.tmp-` paths under `.tumwater/state/improve.json`. `verifyAndMerge` then rejected with `Error: ENOSPC` from `runReviewer`'s phase save. Nothing was folded, the merge ref was still set, and no `review_rejected` was logged. With all six calls swapped to `saveRunnerStateBestEffort`, the same scenario returned `"rejected"`, folded 2 runs, deleted the ref and logged one `review_rejected`. The same fault also makes `reviewPinnedChange` throw on a review-exempt change (`pinnedFixture`'s default), at the verdict save. This follows the Run end and Merge write-back plans (PLANS-DONE.md): `saveRunnerState` stays strict, and callers that cannot afford a throw use the best-effort wrapper.

**Approach.**
1. src/review/review-run.ts: replace each of the three `saveRunnerState(root, state)` calls with `saveRunnerStateBestEffort(root, state)`. In the import from ../runner/runner-state.js, swap `saveRunnerState` for `saveRunnerStateBestEffort`, and drop `saveRunnerState` once `grep -n 'saveRunnerState(' src/review/review-run.ts` finds no call.
2. src/merge/merge-core.ts: make the same swap at the three calls listed above. That leaves no `saveRunnerState(` call in the file, so the import becomes `saveRunnerStateBestEffort, type RunnerState` (lint fails on an unused `saveRunnerState`).
3. Extend the comment above `reviewPinnedChange`'s verdict save with one sentence: the save is best-effort (it warns "could not save the role's state"), because a throw here would skip the reviewer's usage fold, and the merge write-back saves the same state later.
4. Do not touch the `saveRunnerState` calls in src/merge/merge-check-failures.ts or `requeueKeptChange`'s in src/merge/merge-slot.ts. They run on other paths (red merge checks, retries), and this plan does not verify them.

**Files touched.** src/review/review-run.ts, src/merge/merge-core.ts, test/merger.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/merger.test.ts, "an unwritable state file mid-review still folds the reviewer runs and settles a rejected re-review". Copy "a resolution the re-review rejects deletes the pin and merges nothing": same pi script, `advanceMain`, and resolve callback, and destructure `folded` from `makeCtx`. Before `verifyAndMerge`, install `patchFsMethod("writeFileSync", …)` from ./helpers/fs-faults.js. It throws `errnoError("ENOSPC")` when `file` is a string starting with `` `${statePath(root, ROLE)}.tmp-` `` and calls the original otherwise. Undo it in a `finally`. Assert:
  - `await verifyAndMerge(ctx, request(sha))` resolves to `"rejected"`;
  - `folded.length === 2` (the first review and the re-review);
  - `await refSha(root, REF)` is null, and `eventsOfType(root, "review_rejected").length === 1`;
  - `warningMessages(root)` has at least one entry starting with `could not save the role's state`.
  Mutations it must catch: putting back `saveRunnerState` at `runReviewer`'s phase save, at `reviewPinnedChange`'s verdict save, or at either `recheckResolved` save makes `verifyAndMerge` reject with ENOSPC. The resume-count and `reviewResume` saves are not on this path. Only the swap covers them, not this test, and the invariant must not claim otherwise.
- The existing test/merger.test.ts and test/revision.test.ts tests pass unchanged.
- docs/invariants.md: at the END of the file, after every section present when the change is made (CJ's and CK's included, if they have merged), add `## Review gate: a failed state save never fails the verify`. Under it put `### INV-CL1: a verify whose role-state saves fail still folds its reviewer runs, deletes a rejected pin and logs review_rejected, warning once per failed save`, in the Guarantee / Binds / Pinned by layout. Binds: `src/review/review-run.ts` (`runReviewer`), `src/merge/merge-core.ts` (`reviewPinnedChange`, `mergeApprovedChangeIn`'s `recheckResolved`), `src/runner/runner-state.ts` (`saveRunnerStateBestEffort`). Pinned by: the new test's name. Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. INV-CJ1 and INV-CK1 are reserved by the prompt move-to-top and refusal plans, and CL was free on 2026-10-20.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

## Done
