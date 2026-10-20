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

### Post-merge reviews: a torn `post-review.json` entry or a failed `post-review.json` write warns and moves on instead of throwing out of the poll loop or wedging the merge slot, and docs/invariants.md gains a section for it (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/review/post-merge-review.ts + test/post-merge-review.test.ts + docs/invariants.md)

**Goal.** `drainMergeQueue` (src/merge/merge-drain.ts) calls `drainPostReviews` (src/merge/merge-post-review.ts) on every poll that is not held. The poll loop is a `try`/`finally` with no `catch`, so a throw there ends the team. The post-review file (src/review/post-merge-review.ts) can break the pipeline in three places:
- `readPostReviews` returns `saved.pending` without checking its entries. With `{"pending":[null]}`, `drainPostReviews` throws `Cannot read properties of null (reading 'rejected')` from `pending.find`, and it throws again on every later poll.
- `startRevert` (src/merge/merge-drain.ts) calls `settlePostReview` in the revert task's `.finally`, before `p.merge = null`. When that write throws, `guardMergeTask` swallows the rejection, but `p.merge` stays set, so `drainMerge` never starts another merge or revert.
- In `drainPostReviews`, the revert skip check's `.then` calls `settlePostReview` before its warning. When that write throws, the chain rejects with no handler (`void`), and the "not reverting" warning is never logged.
On 2026-10-20 the plan role confirmed the first two with scratch tests (since deleted). The first wrote `{"pending":[null]}` and called `drainPostReviews`, which threw. The second used this file's `setup("VERDICT: reject\n1. bad")`, polled until `p.revert` was set, installed `failRenameSyncOn(postReviewPath(root), "pr write refused")`, then ran `drainMerge` and awaited `p.merge!.promise`. `p.merge` was still non-null afterwards.
All three writes go through `writePostReviews`. So does `addPostReview`, which `startMerge`'s `settleOne` calls before `settleMergeOutcome`: a throw there would skip writing back the merged change's outcome. This plan fixes the reader and that one writer, and does not edit src/merge/merge-drain.ts (the in-flight "Pending reverts" plan edits that file).

**Approach.** All code changes are in src/review/post-merge-review.ts.
1. `readPostReviews`: keep only entries that are JSON objects (`isJsonObject` from ../files/json-object.js) with a string `commit`, a string `role` and a string `summary`. Drop an entry whose `rejected` is present and not an array. Rebuild each kept entry: `body` only when it is a string, `failures` only when it is a finite number, and `rejected` (when it is an array) from its string elements only. Add a doc comment: a torn or hand-edited entry is dropped, and the next write leaves it out.
2. `writePostReviews`: wrap `writeJsonAtomic` in `try`/`catch`. The `catch` calls `warnEventBestEffort(root, TUMWATER_SOURCE, \`could not write post-review.json: ${errorMessage(err)}\`)`; import both names from ../events/events.js, which this file already imports `logEventBestEffort` from. Give `addPostReview` and `settlePostReview` one doc sentence each: they never throw, and a failed write warns and leaves the file as it was. What that costs: a missed add leaves the commit unreviewed, with the warning naming the failure. A missed settle after an approval or a failed run means the commit is reviewed again. A missed settle after a revert keeps the rejected entry, and the next poll's `revertSkipReason` finds that its revert already merged and settles it.
3. Leave src/merge/merge-post-review.ts and src/merge/merge-drain.ts unchanged. Step 2 is what fixes their call sites.
4. test/post-merge-review.test.ts: import `failRenameSyncOn` from ./helpers/fs-faults.js and `postReviewPath` from ../src/paths.js (the file already imports `rejectedRefName` and `mergeRefName` from there). Reuse `setup` and `drainUntilRevert`, and undo every fault in a `finally`. Append:
   - "a torn post-review.json entry is dropped and the well-formed one is still reviewed": `setup("VERDICT: approve\n1. fine")`, then overwrite `postReviewPath(root)` with `{ pending: [null, { commit: 7 }, { commit, role: "improve", summary: "s", rejected: "x" }, { commit, role: "improve", summary: "add x", failures: "2", rejected: ["r", 3] }] }`. `readPostReviews(root)` deep-equals `[{ commit, role: "improve", summary: "add x", rejected: ["r"] }]`. Then rewrite the file with that torn list minus its last entry, plus `{ commit, role: "improve", summary: "add x" }`. `drainPostReviews(ctx, p)` does not throw, `p.postReview` is non-null, and once its promise is awaited `readPostReviews(root)` is empty.
   - "a failed post-review.json write after a revert warns and still frees the merge slot": the scratch-test scenario above. After awaiting `p.merge!.promise`, `p.merge` is null, `readPostReviews(root)` still has one entry, and one `warning` event (`eventsOfType`, already imported) has source `tumwater` and a message containing `pr write refused`.
   - "a failed post-review.json write in the revert skip check still logs why it does not revert": `setup("VERDICT: approve\n1. fine")`, then overwrite the file with `{ pending: [{ commit, role: "director", summary: "s", rejected: ["r"] }] }`. `revertSkipReason` returns "the director merged it" before any git call. Install the fault, call `drainPostReviews(ctx, p)`, then poll (sleep 10 ms, up to 200 times) until a `warning` event's message contains `not reverting`. Assert that it appears, and that another warning contains `pr write refused`.
   Mutations, each applied by hand and reverted: (i) drop step 1's filter — the torn-entry test throws; (ii) remove step 2's `try` — the revert test finds `p.merge` non-null, and the skip-check test never sees `not reverting`. Put in VERIFIED only what you saw.
5. docs/invariants.md: append "## Post-merge reviews: post-review.json never throws out of the merge drain" after the last section. For the INV prefix, run `grep -n '^### INV-' docs/invariants.md | tail` and read the "was free" notes in PLANS.md's Planned entries. On 2026-10-20, BQ had merged, BR (Poll-loop runner state) and BS (Pending reverts) were planned, and BT was free. Use the Guarantee / Binds / Pinned by layout:
   - 1: an entry that is not an object with a string commit, role and summary is dropped, as is one whose `rejected` is not an array. Binds `readPostReviews`. Pinned by the torn-entry test.
   - 2: a failed post-review.json write warns under `tumwater` and never throws, so a revert's settle still frees the merge slot and a skip check still logs its reason. Binds `writePostReviews`, `addPostReview`, `settlePostReview`. Pinned by the revert and skip-check tests, plus "a rejecting post-merge review reverts the commit and hands it back as a revision" (on the healthy path the entry is still dropped).
   Cite each test by its full name.

**Files touched.** src/review/post-merge-review.ts (`readPostReviews`, `writePostReviews`, doc comments, imports); test/post-merge-review.test.ts (three appended tests plus imports); docs/invariants.md (one new section).

**Acceptance criteria.**
- `npm run test:gate` passes, and the three new tests pass.
- The torn-entry and revert tests fail on the code before steps 1–2, and pass after them.
- Each mutation in step 4 fails its tests when applied by hand, and the suite passes again once each is reverted. Report this in VERIFIED.
- `git diff --stat` shows no change under src/merge/.
- Every test name cited in the new section exists verbatim (`grep -rF` each one in test/).

## Done
