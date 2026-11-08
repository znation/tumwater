# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Subtract, part 6a/6: The live docs and example config keep only the mechanisms that survived the series (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6b/6, independent in files of it; design in plans/subtract.md "The six strokes" and "How we will know it worked"; its original prerequisites Subtract parts 1e/6, 5v/6 and 5x/6 have landed, and it requires Subtract part 3g/7 landed, the last unlanded Subtract part; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json)

**Goal.** The live prose and `tumwater.example.json` describe only mechanisms that still exist after the Subtract series: the names whose producer and reader the earlier parts removed are gone from the config tables, command lists, glossary, architecture prose and example config, while every mechanism the user kept is still documented and its keys still appear. This is the documentation half of the old sweep; the doctor rows, tests and before/after counts are part 6b/6.

**Approach.** All edits are documentation and the example config; no `src/` file changes here.
- Treat the old sweep list as a candidate list, not a mandate: for each name, `grep -rn '<name>' src/` first. A name whose live `src/` reader or writer is gone is removed from the swept docs and the example; a name `src/` still reads or writes stays documented with its tests. The pre-merge gate keeps its build check (user, 2026-11-01), so in particular `check_wait` and `maxConcurrentChecks` stay wherever the check permit still serves that gate or the main watch, and `mergeCommand` stays wherever the merge step still reads it. `mergeBatchMax` is dead after the batch path landed; `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `review.afterMerge`, `held-for-operator`, `Needs replan`, `Waiting for the next failure` and the `(held N)` counter are dead. The queue vocabulary (`merge queue`, `interlock`) belongs to the landed part 3g/7; remove any occurrence this file still carries.
- docs/config.md: drop the dead keys and aliases from the tables, and keep the rows for the keys `src/config/config-schema.ts` still reads — `instances`, `slotCount`, `slot_wait`, `slot salvage`, the tier/fallback keys, the image reroute and the subscription usage-window display (the Settings concurrency controls and those mechanisms were kept: director 2026-10-31, user 2026-10-28 and 2026-10-30).
- docs/cli.md and the TUI-keys table: drop commands, flags and keys whose implementation parts 3d/7–3f/7 removed, and keep the concurrency controls and declared-check editing that remain. docs/glossary.md: remove the terms for deleted mechanisms and keep the kept vocabulary.
- docs/how-it-works.md: remove paragraphs that still promise a deleted stage, queue or alert; keep the gate's pre-merge build check and the Hourly full check's hourly main watch as landed.
- tumwater.example.json: remove only the dead keys; preserve the kept capacity, tier, fallback, image-reroute and subscription-window settings.
- docs/invariants.md: drop or re-scope the invariants of deleted subsystems (merge-slot stages, the permit where its mechanism is gone, per-provider caps, subscription-window holds), keep the invariants of the tiers, budget fallback, image reroute and subscription usage-window display, and leave every remaining file/test binding naming an existing file and test.
- README.md and DEVELOPMENT.md: remove stale references to the deleted mechanisms; do not touch the brief block between the `tumwater:prompt` markers.

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json

**Acceptance criteria.**
- For every candidate name, the part's Done entry records the `grep` evidence: either no live `src/` reader remains and the name is absent from the swept docs and example, or a live reader remains and the name is still documented with that reader.
- `grep -rnE 'maxConcurrentPerProvider|mergeBatchMax|claudeWindowReserve|windowReserve|review\.afterMerge|held-for-operator|Needs replan|Waiting for the next failure' docs/ README.md DEVELOPMENT.md tumwater.example.json` prints nothing.
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` prints no claim about a mechanism the landed parts deleted.
- The kept mechanisms are still documented: the Settings concurrency controls, the tier and budget-fallback settings, the image reroute and the subscription usage-window display, plus any check-permit key `src/` still reads.
- docs/invariants.md keeps no binding to a deleted module and no binding whose named test file is gone; docs/config.md, docs/cli.md and the TUI-keys table agree with the live schema and command set.
- `npm run test:gate` passes.

**Tests.** Run test/config-doc.test.ts (docs/config.md against the live schema), test/cli-doc.test.ts and test/docs-commands.test.ts (command help/docs parity), test/tui-keys-doc.test.ts, test/docs-links.test.ts and test/invariants-doc.test.ts (file and test bindings), then the project's gate. If a kept key is dropped from the docs or a dead key stays, fix the table; do not weaken a doc check.

### Subtract, part 6b/6: The doctor rows, tests and counts the series left behind (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6a/6, requires Subtract part 6a/6 landed so the surviving key and row set is fixed; touches src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md)

**Goal.** The doctor advertises only checks whose mechanism still exists, and the tests assert only surviving rows, events, artifacts and keys. This is the code-and-tests half of the old sweep; the live docs and example config are part 6a/6, whose surviving set this part follows. The part also records the series' before/after row and key counts and its measurement table.

**Approach.** All edits are the doctor row list and the tests that pin it; no production behavior changes.
- src/doctor/doctor-check-names.ts: delete the rows whose check function no longer exists after the series; do not re-point them at another mechanism. Keep every row whose check still reads a live path. Do not add a row.
- Re-check the parts 1a–1e/6 rule end to end: every condition that used to have a banner and now has no banner still has a doctor row, and every row names a mechanism that exists. Record any condition with neither a banner nor a row in the part's Done entry rather than inventing a row here.
- test/doctor-checks.test.ts: update its row list to exactly the surviving rows; delete cases whose only subject is a deleted row. test/event-format.test.ts: delete the cases for event types no live producer emits (including `check_wait` only when part 6a/6 found no live reader, and the merge-stage events the landed parts removed); keep the cases for surviving event families. test/retention.test.ts: delete the cases for artifacts no mechanism writes; keep the surviving ones. test/config.test.ts: update the key cases to the surviving key set part 6a/6 documented; do not delete a case for a key `src/config/config-schema.ts` still reads.
- In the part's PLANS-DONE entry, record the doctor row count and the config key count before this part and after it, and carry the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md

**Acceptance criteria.**
- Every row name in `doctor-check-names.ts` resolves to a check function that exists and reads a mechanism that still exists; no row reports a path nothing writes.
- The row list in test/doctor-checks.test.ts equals the surviving row set; no test asserts a deleted row, event type, artifact or config key, and the surviving cases stay.
- No production module outside `src/doctor/doctor-check-names.ts` changes; that edit only adds or removes row-name strings, and the diff names only the files listed above.
- The before/after doctor row and config key counts and the measurement table are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

**Tests.** Run test/doctor-checks.test.ts, test/doctor.test.ts, test/event-format.test.ts, test/retention.test.ts, test/config.test.ts and test/config-aliases.test.ts, then the project's gate. If a surviving row or key loses its case, restore it; do not weaken an assertion to make the gate pass.

### Subtract verify collapse, part 3e/6: The merge-drain tests observe queue outcomes instead of the approved/verifying maps (planned 2026-11-06 by the plan role, splitting the 2026-11-04 part 3c/6 after feature held it too large for one run; requires Subtract verify collapse part 3b/6 landed; sibling part 3c/6 lands the one-step drain; touches test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts)

**Goal.** The two large pipeline test slices are ready for the one-step drain before it lands: every case that survives part 3c/6 synchronizes on durable, stage-agnostic signals (the queue, the merge marker, events, runner state, `drained`/`mergeTasks`) instead of reading `pipeline.approved` or `pipeline.verifying`. Production code is untouched, so this part is green on the current two-stage pipeline and 3c/6 does not have to rework these files.

**Approach.**
- Only the two test files change. For each case that survives 3c/6, remove the `pipeline.approved`/`pipeline.verifying` reads and wait on a signal that holds under both the current verify-then-merge handoff and 3c/6's one task: `queuedMergeFiles`/`queueDepth`, `drained(root, pipeline)`, `mergeTasks`, `loadRunnerState(...).lastResult`, `readMergeMarker` and `readEvents`/`eventsOfType`. Where a test must see a check start or not start, extend its `check.command` to touch a per-role flag file and assert on that file instead of the map.
- Rewrite, keeping their external assertions: "changes approved while the merge slot is busy merge one at a time", "a change settled early in a batch writes back before a slower batch-mate's resolver returns", "approved changes merge one at a time", "one verification runs at a time" (assert one head is gated at a time through the per-role check flags and the queue), "a verification rejection drops its entry at once", "a merge whose role has no live runner verifies and merges through a throwaway author", "approved entries merge while the reviewer's provider is held", "a fresh entry verifies and merges while the reviewer's provider is held", the head-verdict stage test, and "a plumbing throw in the merge keeps every entry queued and unapproved". Keep queue order, one-at-a-time merging, the rejection's drop and state, the reviewer-hold drain, the head's build-check stage and final result, and the throw's recovery assertions; drop only the map-specific ones.
- Rewrite the two abort cases in merge-pipeline-2.test.ts ("abort --role settles an approved change whose pin is already gone" and "an aborted approved change settles despite an unwritable state file") to abort the in-flight merge task rather than a waiting approved record, keeping their missing-pin and unwritable-state assertions.
- Delete the cases whose only subject is the approved wait or a parked verification: "an approved change whose queue entry is gone is forgotten", "the merge's conflict resolver takes a shared permit, ahead of a verification parked for one", and "an approved change waits to merge while a later queue entry is still verifying". Their externally visible effects (entry dropped, resolver order, queue order) stay asserted in the surviving cases listed above.

**Files touched.** test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts

**Acceptance criteria.**
- `grep -nE 'pipeline\.(approved|verifying)|p\.(approved|verifying)' test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts` prints nothing.
- `git diff --stat` names only those two test files: no `src/` or fixture change.
- The rewritten cases still assert their external outcomes: queue order and one-at-a-time merging, the rejected entry's drop and saved result, the reviewer-hold drain, the head's build-check stage and final result, and the plumbing throw's queued-entry recovery.
- The project's declared check passes on the current tree, and the two files pass on their own.

**Tests.** Run test/merge-pipeline.test.ts and test/merge-pipeline-2.test.ts, then the project's gate (they must pass on the still two-stage pipeline; 3c/6 re-runs them under the one-step drain).

### Subtract verify collapse, part 3c/6: The merge queue's head runs its gate and merge in one task; the drain stops starting verifications and stops populating the approved/verifying maps (planned 2026-11-06 by the plan role, splitting the 2026-11-04 part 3c/6 after feature held it too large for one run; requires Subtract verify collapse part 3e/6 landed; sibling to part 3d/6, which deletes the verify modules and map types; touches src/merge/merge-core.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-withdrawn.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merge-fixtures.ts test/fixtures/merger-fixtures.ts)

**Goal.** A queued entry goes from the queue to the gate to the merge in one task: `drainMerge` takes the queue head and starts one task whose `mergeApprovedChange` runs `reviewQueuedChange` in its merge worktree before `mergeToMain`, settles the outcome, queues the post-merge review on a `merged` event as today, and continues to the next head one at a time. `drainMergeQueue` no longer calls `drainVerify`, and neither `p.approved` nor `p.verifying` is populated. The task holds a `VERIFY_TIER` team lease only while the gate runs and releases it before the merge, so the conflict resolver still takes `MERGE_TIER` and the serial task cannot deadlock on the shared semaphore. Torn-head recovery, the already-merged dedupe, `notBefore`, `liveRoles` and `startHeld` checks move from the verify drain into the serial drain; the withdrawn check runs before the gate. A rejected entry settles as today. The `alreadyGated` marker from part 3b/6 is removed: the drain's single task always runs the gate. Build the `ApprovedMerge`-shaped record for the single task from the queue entry so `startMerge` keeps its abort/shutdown, post-review and `settleMergeOutcome` behavior. The verify modules and map types remain in place, unreached by the drain, until part 3d/6 deletes them.

**Approach.**
- merge-core.ts: remove `alreadyGated` (and any now-unused field comment), so `mergeApprovedChange` always runs the withdrawn check and `reviewQueuedChange` before `mergeToMain`; keep `gatePermit` and its release-before-merge rule. `startMerge`'s request drops the flag too (the unused function stays until part 3d/6 deletes it).
- merge-drain.ts: `drainMergeQueue` stops calling `drainVerify` and keeps `drainPostReviews` plus `drainMerge`. `drainMerge` takes the head from the queue after `dropTornHead`, the dedupe against main, `notBefore`, `liveRoles` and `startHeld` checks (moved from `drainVerify`), resolves the author, and starts one single-change task. Its `MergerContext` supplies `gatePermit` by acquiring `VERIFY_TIER` from `ctx.semaphore` and wrapping the gate in `withRunPermit`, releasing before the merge. Build the `ApprovedMerge`-shaped record for the single task from the queue entry (author, `mergeUsage`, `startedAt`, empty-controller task fields) so `startMerge` keeps its abort/shutdown, post-review and `settleMergeOutcome` behavior; the task calls `mergeApprovedChange`, settles each outcome through `settleMergeOutcome`, queues the post-merge review on `merged`, and handles user abort and shutdown as today. Delete the approved/verifying branches and reads/writes; `settleAbortedApproved` may remain as an empty-map no-op until part 3d/6 deletes it.
- merge-pipeline.ts: keep the type fields for now; update the pipeline comments so they describe one serial head task plus the post-review task. `mergeTasks` and `abortableMerges` continue to compile over the empty maps.
- src/orchestrator/orchestrator-poll.ts: keep the `settleAbortedApproved` import and call for now (it iterates an empty map); part 3d/6 removes them.
- Delete test/merge-drain-verify.test.ts with its pooled-slot verification subject.
- test/fixtures/orchestrator-fixtures.ts: `mergeHead` drives the queue head through `drainMergeQueue` (the one task) instead of `startVerify` followed by `drainMerge`.
- test/fixtures/merger-fixtures.ts: `verifyAndMerge` stays one `mergeApprovedChange` call with no marker.
- test/merge-drain.test.ts: replace its `pipeline.verifying.size`/`verifying.has` assertions with queue, marker, runner-state and `drained` evidence; keep the dedupe, torn-head and post-review subjects.
- test/fixtures/merge-fixtures.ts: `allTasks` may keep reading the now-empty `p.verifying`/`approved` maps until part 3d/6 deletes them, but no merge assertion may wait on them.
- In test/merge-withdrawn.test.ts, drop `verifyRequest`: drive `mergeApprovedChange` directly, since it now gates inside, and keep the withdrawn-pin assertions.
- The pipeline slices were prepared by 3e/6; if a rewritten case still names a removed symbol, adapt it here without re-adding a map read.

**Files touched.** src/merge/merge-core.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-withdrawn.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merge-fixtures.ts test/fixtures/merger-fixtures.ts

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start or approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `drainMergeQueue` no longer calls `drainVerify`; the drain no longer writes `p.approved` or `p.verifying`. The withdrawn, dedupe, torn-head, `notBefore`, `liveRoles` and `startHeld` checks still run in the serial drain.
- `grep -rn 'alreadyGated' src/ test/` prints nothing.
- The gate runs under a `VERIFY_TIER` team lease that is released before `mergeToMain`; the conflict resolver still takes `MERGE_TIER` and no task holds both at once.
- test/merge-drain-verify.test.ts is gone with its subject; the surviving merge-drain and pipeline tests drive an entry from queue to merge.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Run test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts and test/merge-withdrawn.test.ts, then the gate.

### Subtract verify collapse, part 3d/6: The verify-stage modules and the now-empty approved/verifying maps are deleted; direct callers use the one-step merge (planned 2026-11-04 by the plan role, splitting the 2026-11-04 too-large part 3b/5 after feature held it too large for one run, then renumbering it when parts 3b/6 and 3c/6 split it further; requires Subtract verify collapse part 3c/6 landed; touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-head.ts src/merge/merge-queue.ts src/orchestrator/orchestrator-poll.ts test/merge-requeue.test.ts test/runner-revision.test.ts test/fixtures/merger-fixtures.ts test/fixtures/merge-fixtures.ts)

**Goal.** The verify stage and its maps are gone: `merge-verify.ts` and `merge-batch.ts` are deleted, `MergePipeline` is `{ merge, postReview }`, `settleAbortedApproved`, `liveRoles` and `ApprovedMerge` are deleted, and the orchestrator's per-poll approved-abort settle call is removed. The requeue tests drive `notBefore` and the failed-drop dedupe through `drainMergeQueue`; `runner-revision.test.ts` calls `mergeApprovedChange` (which now runs the gate) and asserts its `RunResult` and state bookkeeping instead of a `VerifyVerdict`; `merge-withdrawn.test.ts` does the same and keeps its withdrawn-pin assertions. No production module imports a verify-stage symbol.

**Approach.**
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts. Move any surviving type or helper a direct caller still needs into merge-core.ts or merge-drain.ts; do not keep a verify module under a new name.
- merge-pipeline.ts: `MergePipeline` becomes `{ merge, postReview }`; `newMergePipeline` returns those; delete `ApprovedMerge`, `liveRoles`, and the approved/verifying branches in `mergeTasks`/`abortableMerges`.
- merge-drain.ts: delete `settleAbortedApproved`, the approved/verifying branches and the now-dead imports.
- src/orchestrator/orchestrator-poll.ts: remove the `settleAbortedApproved` import and its per-poll call.
- merge-head.ts and merge-queue.ts: update comments that name `drainVerify`/the verify stage to the serial drain; no behavior change.
- test/merge-requeue.test.ts: replace the two `drainVerify` calls with `drainMergeQueue`, keeping the same `notBefore` (entry stays queued) and failed-drop (warning, entry left for the next poll) expectations.
- test/runner-revision.test.ts: replace `verifyRequest(ctx, req, w)` with `mergeApprovedChange(ctx, req)` and adapt the assertions from `VerifyVerdict` to the returned `RunResult` plus the same revision state. Keep the revision-round, backstop and director coverage; do not delete a case whose subject survives.
- test/merge-withdrawn.test.ts: replace `verifyRequest(ctx, req, w)` with `mergeApprovedChange(ctx, req)` and adapt the assertions from `VerifyVerdict` to the returned `RunResult` while keeping the withdrawn-pin coverage.
- test/fixtures/merger-fixtures.ts: remove the `verifyRequest`/`BatchRoleWiring` imports and the `batchWiring` helper once no caller remains.
- test/fixtures/merge-fixtures.ts: `allTasks` reads only `p.merge` and `p.postReview`; the busy-slot stand-in and its WeakSet stay.

**Acceptance criteria.**
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|ApprovedMerge\|p\.verifying\|p\.approved' src/` prints nothing, and `ls src/merge/merge-verify.ts src/merge/merge-batch.ts` fails.
- `MergePipeline` has only `merge` and `postReview`; `newMergePipeline` returns those; `settleAbortedApproved` and `liveRoles` are gone.
- test/merge-requeue.test.ts's two former `drainVerify` cases run through `drainMergeQueue` with the same `notBefore` and failed-drop expectations.
- test/runner-revision.test.ts drives `mergeApprovedChange` and keeps its revision assertions; test/merge-withdrawn.test.ts drives `mergeApprovedChange` and keeps its withdrawn assertions.
- `npm run test:gate` passes.

**Tests.** Run test/merge-requeue.test.ts, test/runner-revision.test.ts, test/merge-withdrawn.test.ts and test/merger.test.ts, then the gate.

### Subtract verify collapse, part 4/6: The `approved` in-flight status and the status, GUI and queue surfaces that wait on it are removed (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run, renumbered 2026-11-04 when parts 3b/6–3d/6 split the old part 3b/5; requires Subtract verify collapse part 3d/6 landed; touches src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts)

**Goal.** No operator surface or marker type advertises a change waiting for a merge slot that no longer exists: `MergeChangeStatus` is `"merging" | "done"`, and status, GUI, help and the merge-queue cell render only live states. `checkWaitStage` and `resolveWaitStage` stay because the gate build check (review-precheck.ts) and the conflict resolver still wait on permits.

**Approach.**
- merge-slot.ts: drop `"approved"` from `MergeChangeStatus`, from `isMergeChange`'s accepted statuses and from the comments; keep `setMergeChangeStatus` for merging/done and keep both wait-stage hooks.
- merge-queue-render.ts: drop the `change.status === "approved"` branch (Subtract part 3d/7 later deletes this module; whichever lands first rebases).
- status-model.ts and gui-client-model.ts: remove the `approved, waiting to merge` phase mapping and rank; update the comments that describe the verify-to-approval wait.
- cli/help.ts: remove the `[approved, waiting to merge]` stage example.
- Update the tests above that pin the removed string or status; add no new status.

**Files touched.** src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts

**Acceptance criteria.**
- `grep -rn 'approved, waiting to merge\|status === "approved"' src/` prints nothing for the merge marker and operator surfaces; the review gate's own `approved` verdict is out of scope and stays.
- A marker record whose status is `approved` is no longer accepted as a live change; the status, GUI and help tests assert only merging and done states.
- `npm run test:gate` passes.

**Tests.** Run test/merge-slot.test.ts, test/status-model.test.ts, test/status-data-inbox.test.ts, test/gui-client.test.ts, test/help.test.ts, test/merge-queue.test.ts and test/status-polls.test.ts, then the gate.

### Subtract verify collapse, part 5/6: docs/how-it-works.md and docs/invariants.md describe one gate-then-merge step and bind only modules that survive (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run, renumbered 2026-11-04 when parts 3b/6–3d/6 split the old part 3b/5; requires part 4/6 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts)

**Goal.** The live prose and invariant bindings describe the landing that exists after parts 1/5–4/6: a queued pin is gated in the merge worktree (the deterministic diff rules plus the declared gate command), then rebased and fast-forwarded under the merge lock; no sentence promises a separate verify stage or an approval wait. The post-landing review and the main watch keep their guarantees.

**Approach.**
- docs/how-it-works.md's merge pipeline section: replace "Queued changes are approved in parallel and one serial merge step merges them" and the Review/Merge paragraphs that describe a separate verify stage with one step per queued head: gate (diff rules plus build check, and the withdrawn check) then merge; keep the post-merge review, the main watch and the permit accounting.
- docs/invariants.md: re-point every binding that names src/merge/merge-verify.ts, src/merge/merge-batch.ts, `verifyRequest`, `dropTornHead`, `ApprovedMerge` or a verify-stage marker to the surviving module and test (merge-head.ts, merge-drain.ts, merge-core.ts, merge-slot.ts); keep the guarantees whose code survives (withdrawn pin drop, torn-head drop, gate build-check abort, post-merge review permit). Do not delete a guarantee just because its binding moves.
- docs/glossary.md's retired-name row for `landing-vetting.ts` names `merge-verify.ts`; point it at the surviving merge-core.ts (Subtract part 3g/7 later re-sweeps the glossary).
- test/invariants-doc.test.ts's expectations follow the re-pointed bindings.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts

**Acceptance criteria.**
- `grep -rniE 'verify stage|approval stage|approved in parallel|approved, waiting to merge' docs/ README.md` prints no claim that a separate verify stage or approval wait exists.
- Every docs/invariants.md binding names an existing src file and test file; no binding names merge-verify.ts or merge-batch.ts.
- The prose still states the gate's build check, the one merge lock, linear history and the main watch's post-landing check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/docs-links.test.ts, then the gate.

### Subtract, part 3d/7: `tumwater queue`, its cancel/top keys and the browser queue controls go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract verify collapse part 4/6 landed; touches src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts)

**Goal.** The operator stops steering a queue that becomes a lock and a fast-forward: delete the `tumwater queue` command, its `--cancel` and `--top` flags, the GUI Merge queue card's Cancel/Move-to-top handlers, the TUI pending pane's queue rows and keys, and the three modules that implement cancel/top/queue rendering. The queue reader itself stays for status, doctor and the CLI surfaces this part does not own until part 3f.

**Approach.**
- Delete src/merge/merge-cancel.ts, src/merge/merge-top.ts and src/merge/merge-queue-render.ts; remove `cmdQueue`, `cmdQueueCancel`, `cmdQueueTop` and the queue view from src/cli/cli-query-commands.ts and their command/help/completion entries.
- Remove `handleQueueCancel`/`handleQueueTop` and their `/api/queue-cancel`/`/api/queue-top` routes from src/gui/gui-operator-commands.ts and gui-server.ts; delete the dashboard Merge queue card's Cancel/Move-to-top controls.
- Remove the merge-queue rows, labels and Ctrl keys from tui-pane-pending.ts, tui-pane-pending-selection.ts and tui-pane-transcript.ts; keep the post-merge-review rows, which are a separate mechanism.
- docs/cli.md drops `queue`, `queue --cancel` and `queue --top`; no other docs change here.

**Files touched.** src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts

**Acceptance criteria.**
- `tumwater queue` and its `--cancel`/`--top` flags are gone from the parser, help, completion and docs; `grep -rn 'moveQueuedMergeToTop\|cancelQueuedMerge\|renderMergeQueue' src/` prints nothing.
- Neither dashboard nor TUI offers a queue cancel/top control, and no TUI key binds one.
- The queue reader (`readMergeQueue`), the post-merge-review views and the doctor/status queue reads still work.
- `npm run test:gate` passes.

**Tests.** Delete test/cli-queue.test.ts, test/cli-queue-follow.test.ts, test/gui-queue-cancel.test.ts, test/gui-queue-top.test.ts, test/merge-cancel.test.ts and test/merge-top.test.ts with their subjects; trim test/tui-pane-pending.test.ts and test/tui-operator-keys.test.ts to the surviving post-review rows and keys. Run the surviving touched files and the gate.

### Subtract, part 3e/7: A run's merge pin is merged directly, without a queue entry (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3d/7 landed; touches src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts)

**Goal.** New work stops writing a durable queue entry: a run pins its commit by `refs/tumwater/landing/<role>` and the orchestrator merges that pin on a poll. The queue reader still drains files an older build left, so the two paths coexist until part 3f deletes the queue.

**Approach.**
- In run-stage.ts, replace the `enqueueMerge` block with the pin only: after `pinAndReset`, log `merge_queued` with the commit and summary and end the run `queued` exactly as today; `heldOnBranch` still checks an existing pin. Remove the queue-entry construction from the fresh path; keep the revision trailer on the commit so a recovered pin still carries its round.
- In runner-leftover.ts, replace the `enqueueMerge` call with the same pin-only return (`{ kind: "pinned", sha, summary }`): adopt an unpinned branch tip into the merge ref as today, but write no queue file. Keep stale/dangling pin cleanup, the conflict hand-back and `MERGE_CONFLICT_LIMIT`.
- Add the pin merge to orchestrator-poll.ts: for each runner with `hasUnmergedPin` and no in-flight merge, read `recoveredMetadata` for the pinned sha and call the merge path (`mergeApprovedChange`) under the existing merge lock; a merged pin is deleted, a conflicting pin is kept for the existing leftover/conflict hand-back path, and a pin main already contains is dropped.
- docs/how-it-works.md's Merge section says a pin is the waiting state; the durable queue is legacy input only.

**Files touched.** src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- A fresh run that commits writes a pin and no `.tumwater/merge-queue/` file; its log path is still `merge_queued → merged` and its change reaches main after its one gate check, with no second check.
- A pin left by a crash or an earlier build is merged on the next poll; a pin whose commit main already contains is deleted without merging.
- A conflicting pin is kept once and hands back to its author at `MERGE_CONFLICT_LIMIT`, not retried forever.
- Old queue files still drain through the pre-3e path until part 3f removes it.
- `npm run test:gate` passes.

**Tests.** New test/orchestrator-merge-pin.test.ts: a pin is merged on a poll, a stale pin is dropped, a conflict keeps the pin and records the streak. test/run-stage.test.ts: a committed run pins and enqueues nothing. test/runner-leftover.test.ts: recovery adopts a tip into the pin and writes no queue file. Run those files and the gate.

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3e/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

**Goal.** With part 3e writing no queue file, the queue, its pipeline, slot and requeue modules are dead state. Delete them and re-point every reader at the pin/in-flight marker: status shows a role's waiting pin, the doctor drops the two merge-queue rows, and `once --once` waits on no in-flight merge instead of an empty queue directory.

**Approach.**
- Delete src/merge/merge-queue.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts and merge-requeue.ts; move the one in-flight marker type/reader the new pin path and post-review drain still need into a small module beside merge-core.ts, and delete `.tumwater/merge-queue/` handling (`mergeQueueDir`, `legacyLandQueueDir`, the startup migration step) from src/paths.ts and startup-migration-steps.ts.
- status-data.ts's `readMergeQueue` block and `queuedRoles` become the pin/in-flight set; status-roles.ts and status-polls.ts read that set. Delete the queue header badge, the queue depth and the per-role queued row that name a now-nonexistent directory.
- doctor-backlog.ts loses `checkStaleQueuedMerges` and `checkMergeQueueFiles`; doctor-check-names.ts drops `stale merge-queue entries` and `merge-queue files`; doctor-holds.ts reads the in-flight/pin set instead of the queue.
- gate-polls.ts and scheduling/once-round.ts read the in-flight/pin state for their `queued` counts instead of `queuedMergeRoles`/`queuedMerges`; once-round's `queuedMerges: number` becomes the pin count.
- events/event-notify.ts drops notifications that name queue files (`unreadable queue files`, `merge-queue file`), keeping `merge_queued`/`merged`.
- docs/how-it-works.md removes the queue directory, stages and queue doctor rows, describing pins and the in-flight marker instead.

**Files touched.** src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts

**Acceptance criteria.**
- `grep -rn 'merge-queue\|mergeQueue\|queuedMerges\|readMergeQueue\|mergeQueueDir' src/` finds no live queue path; `docs/how-it-works.md` names no queue directory or stage.
- `tumwater status` shows each waiting role's pin and in-flight merge; the doctor's `stale merge-queue entries` and `merge-queue files` rows are gone rather than warning about a path nothing writes.
- `once --once` treats a waiting pin as unsettled work and exits only after its merge settles, the same way it treated a non-empty queue.
- No module imports a deleted merge-queue/merge-drain/merge-slot/merge-requeue file; the compiler is clean.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-queue.test.ts, test/merge-requeue.test.ts, test/merge-slot.test.ts and the queue-specific cases in test/merge-pipeline*.test.ts; update test/status-data.test.ts, test/status-roles.test.ts, test/doctor-checks.test.ts and test/once-round.test.ts to pins/in-flight. Run those files and the gate.

### Subtract, part 3g/7: Docs and invariants say one lock, linear history and a post-landing check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3f/7 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts)

**Goal.** The live prose and the invariant bindings describe the landing that exists after parts 3a–3f: a pin, a rebase under the merge lock, a fast-forward, and the main watch's post-landing full check. No sentence promises queue stages or an approval step; the pre-merge gate keeps its build check (user, 2026-11-01), so the docs keep saying so.

**Approach.**
- Sweep the queue vocabulary out of docs/how-it-works.md, docs/invariants.md and docs/glossary.md: merge queue, queue stage, verify/approval stage, batch/bisect (already gone), retry/requeue, queue depth and queue cancel/top.
- In docs/invariants.md, drop or re-scope every binding to a deleted module (`merge-queue`, `merge-verify`, `merge-batch`, `merge-slot` stages, `merge-requeue`) and state the surviving guarantees: one merge writer under one lock, linear history, a deleted pin on merge and the main watch's post-landing checks as docs/how-it-works.md states their cadence at the time (amended 2026-11-01 by the operator: the pre-merge gate keeps its build check, and the Hourly full check series moves main's full check to at most hourly on the latest tip, so this part must not restate "a full check per commit"). Keep the conflict-hand-back and review-gate bindings that still have code.
- README's status line stays as is; remove any queue wording elsewhere in README.
- Re-check docs/invariants.md's file-to-test bindings: every remaining binding names a file and a test that still exist; the invariants-doc test enforces it.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` finds no claim about a mechanism parts 3a–3f deleted (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every docs/invariants.md binding that names a merge module names a file and a test that still exist; deleted-module INVs are gone, not re-pointed.
- The surviving prose says: a change is pinned, gated (the diff rules and the declared gate command), merged by rebase and fast-forward under the merge lock, and covered on main by the main watch's full check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/merge-backlog-conflicts.test.ts whole, then the project's gate, and confirm green.

### `runPhase`'s 159-line config-resolution and run-start body in src/runner/runner-run.ts is split into two named module-private stages — `resolveRunConfig`, which owns the pending image-reroute marker and the attachment preflight, and `beginRun`, which owns the per-run state reset and the `run_start` event — so "how does this run pick its config, and when does an image prompt hop to a vision tier?" and "what is reset before a run authorizes?" are each read from a name instead of one body (planned 2026-11-08 by the plan role; continues the landed split-large-function family — the 2026-10-30 `runWithWorktreePhase` split named the pre-PI phases around this coordinator and the 2026-11-03 `recoverLeftoversForRun` split named its recovery stages, both deliberately leaving `runPhase`'s own setup body whole; a TypeScript function-body measurement of `src/` reports `runPhase` at 159 lines today, with its image-reroute/preflight block and its run-start reset/log block inline and unnamed, while its neighbours `runOnceInLeasePhase`, `restoreSalvagedPhase` and `runWithWorktreePhase` are already named stages; independent in file of every `## Planned` entry — `grep -n 'runner-run\|runPhase' PLANS.md BUGS.md` prints nothing before this entry, so no waiting heading or touches list names the file or the symbol (the eligible Hourly full check part 4/4 takes src/status and src/ui, verify-collapse part 3e/6 takes only the two merge-pipeline tests, the `collectBudget` split takes src/status/status-budget.ts, and the `validateConfig` split takes src/config/config-validation.ts; the blocked Subtract and verify-collapse parts take src/merge, src/runner/runner-leftover.ts, src/orchestrator, src/status, src/doctor, src/gui, src/ui, src/stage, src/events and docs, never src/runner/runner-run.ts); PLANS-DONE.md records the `runWithWorktreePhase` split and the `recoverLeftoversForRun` split in this file, but neither moves this setup body (`grep -cE '^### .*runPhase' PLANS-DONE.md` prints 1, that `runWithWorktreePhase` entry, which names `runPhase` only as the caller it leaves intact); docs/invariants.md binds `runPhase` in the runner lifecycle at line 4782 and the image-reroute arm at line 648, and this private move keeps the export, the reroute decision, the `image_reroute` event fields, the state resets and the `run_start` fields unchanged, so no invariant edit is needed; touches src/runner/runner-run.ts)

**Goal.** `runPhase` is the one exported coordinator for a role run. After the earlier splits it still inlines two unrelated concerns: first, selecting this run's effective config, including consuming a pending blind-read reroute marker or preflighting a queued image attachment (with its `image_reroute` event or its no-target `lastError`); then, resetting the per-run counters/abort/recovery state, incrementing the run number, saving, and logging `run_start`. A reader asking either question scans the whole coordinator, and the two concerns can drift because they share mutable locals (`cfg`, `preflightBlocked`, `runNumber`, `runStartedAt`). Extract each concern into a named module-private stage and leave `runPhase` as the plan-backlog/config resolution plus the calls, the run, and `finalizeRun`. No behavior change: the same config is chosen, the same event and error text are written, and every reset happens in the same order before the pi run.

**Approach.** All edits in src/runner/runner-run.ts; move code, do not rewrite it, and keep every `//` and `/** */` comment with the block it annotates. Add two non-exported functions beside `runPhase`:
- `async function resolveRunConfig(ctx: RunnerRunContext, primaryCfg: TumwaterConfig): Promise<{ cfg: TumwaterConfig; preflightBlocked: boolean }>` holds today's `s.imageRerouteActive = false`, the `if (s.imageReroute)` marker branch (with the comment explaining the marker is not cleared here), the `else` preflight branch (the `peekPrompt`/`peekRolePrompt` read, the `[image attached: …]` test, the provider/listed reads, the `seamImageInput` guard, the `imageReroute` call, the `image_reroute` event and the no-target `s.lastError`), and returns the chosen `cfg` and `preflightBlocked`. It starts from `primaryCfg` and keeps `primaryCfg.model` as the event's `from` value, exactly as today.
- `function beginRun(ctx: RunnerRunContext, cfg: TumwaterConfig): { runNumber: number; runStartedAt: number }` holds today's block from `ctx.setRunPair(...)` through the `run_start` `logEventBestEffort` call: `setHandedBack`, the `s.runs += 1`, the token/peak reset and `ctx.usage.reset()`, `setRecoveryFailure`, `resetRunAbort`, `s.running`/`lastRunStartedAt`, `ctx.save()`, and the `run_start` event with the `imageRerouteActive` reroute stamp and `modelSelectorField(cfg)`. It returns the captured `runNumber` and `runStartedAt`.
- Leave the plan-refresh/`planBacklogOpen`/`primaryCfg` resolution at the head of `runPhase`, then call `const { cfg, preflightBlocked } = await resolveRunConfig(ctx, primaryCfg);`, then `const { runNumber, runStartedAt } = beginRun(ctx, cfg);`, then the existing `try`/`catch` around `ctx.runOnce(cfg)`, the `settleImages` call and `finalizeRun`. The `RunOutcome`, `TumwaterConfig` and `RunnerRunContext` types and every import stay as they are; no new import is needed.

**Files touched.** src/runner/runner-run.ts

**Acceptance criteria.**
- `runPhase`'s body (opening brace to closing brace) is under 90 lines, down from 159, and contains only the plan-refresh/`primaryCfg` setup, the two new calls, the `try`/`catch` run, `settleImages`, and `finalizeRun`; it no longer contains `s.imageReroute`, `peekPrompt`, `peekRolePrompt`, `seamImageInput`, `imageReroute(`, `rerouteSeamConfig`, `s.runs += 1`, `resetRunAbort`, `setRunPair` or a `run_start` `logEventBestEffort` call.
- `resolveRunConfig` and `beginRun` are each declared exactly once at module scope, are not exported, and are called exactly once each, from `runPhase`: `grep -nE '^(async )?function (resolveRunConfig|beginRun)\(' src/runner/runner-run.ts` matches both and no `export` line names them.
- Behaviour is unchanged: the existing image-reroute cases pass unedited — "a run whose agent reads an image on a blind model stops and fails", "a blind read on a text-only role reroutes to the vision target, then back to its own tier" and "a rerouted director prompt runs fresh on the vision target and is delivered once" — and the runner lifecycle cases in that file, including "a pi crash on malformed JSON is retried once by continuing the session (regression)", keep their outcomes; no test file is edited.
- A run's `run_start` event still carries the same `reroute: "image"` stamp and model selector, and a preflighted attachment with no vision target still ends as `{ result: "error" }` with the existing `lastError` wording and no pi spawn.
- The exported surface is unchanged: `grep -nE '^export ' src/runner/runner-run.ts` still matches `runPhase` (and the file's existing exports) only; `docs/invariants.md` is unchanged because the runner-lifecycle and image-reroute bindings keep their named entry symbol and guarantee.
- `npm run test:gate` passes.

**Tests.** No new test module: a behavior-preserving move guarded by the existing runner suites. Run test/runner-2.test.ts (the blind-read, reroute and director-reroute cases), test/runner-pi.test.ts, test/run-finalize.test.ts and test/image-input.test.ts whole, then the project's gate, and confirm green. If a reroute stops stamping `run_start` or a preflight starts spawning pi, a branch moved into the wrong helper; fix the move, do not relax the test.

### `startGui`'s 190-line server-startup body in src/gui/gui-server.ts is split into named module-private stages — `refuseGuiRequest`, which owns the Host-rebinding, token and cross-origin gates; `startGuiListener`, which owns the listen promise and its error-listener swap; and `armGuiReloadWatches`, which owns the self-reload and supervisor watches — so "which requests are refused before routing, and in what order?", "how does the server bind and resolve once listening?" and "which reload watches outlive the listen?" are each read from a name instead of one factory body (planned 2026-11-08 by the plan role; continues the landed split-large-function family — the 2026-10-27 `cmdGui` split named the command's own stages around this server, and the 2026-10-25 dashboard plans added routes to the table without ever splitting `startGui`; a TypeScript function-body measurement of `src/` reports `startGui` at 190 lines today, with the three gate blocks, the listen promise and the reload/supervisor wiring inline and unnamed; independent in file of every `## Planned` entry — `grep -n 'startGui\|gui-server' PLANS.md BUGS.md` prints nothing before this entry, so no waiting heading or touches list splits this function (the in-flight verify-collapse part 3e/6 takes only the two merge-pipeline tests and the `runPhase` split takes src/runner/runner-run.ts; the blocked Subtract part 3d/7 also edits src/gui/gui-server.ts but only to remove the `/api/queue-cancel` and `/api/queue-top` route entries and their imports, which this plan deliberately leaves in `startGui`'s route table, so whichever lands second rebases at a distinct region); PLANS-DONE.md records no split of `startGui` (`grep -cE '^### .*startGui' PLANS-DONE.md` prints 0; the done entries that mention it name call sites or the `cmdGui` seam, never a split of this body); docs/invariants.md binds neither `startGui` nor gui-server.ts, so no invariant edit is needed; touches src/gui/gui-server.ts)

**Goal.** `startGui` is the one exported factory for the dashboard's HTTP server. It still inlines three unrelated concerns in one body: the pre-route refusal sequence (a non-loopback server refuses a rebinding Host, a token-gated server refuses a missing or wrong bearer/query token, a state-changing POST from another origin is refused), the listen promise with its one-shot `error` listener that is replaced by the post-listen recorder, and the reload/supervisor watches with their `close` teardown. A reader asking any of those questions scans the whole factory. Extract each into a named module-private helper and leave `startGui` as the startup stamp, the route table, the createServer dispatch, the three calls and the returned listen promise. No behavior change: the same requests are refused in the same Host-token-origin order with the same bodies and status codes, the same host binds, and the same watches arm and stop on the same events.

**Approach.** All edits in src/gui/gui-server.ts; move code, do not rewrite it, and keep every `//` and `/** */` comment with the block it annotates. Add one module-private `type GuiWatchSeams = ReloadWatchSeams & { reexec?: () => void; supervisor?: SupervisorWatchSeams; exit?: (code: number) => void }` and use it for `startGui`'s current `watch` parameter and the new helper, so no exported signature changes.
- `function refuseGuiRequest(req: http.IncomingMessage, res: http.ServerResponse, target: URL | null, allInterfaces: boolean, token: string): boolean` holds today's three inline gates in their current order: the `!allInterfaces && !loopbackHostAllowed(...)` Host refusal, the `token` bearer/query `tokenMatches` refusal, and the `req.method === "POST" && crossOriginRequest(req)` refusal. It writes each `sendJson(res, 403|401, …)` itself and returns `true` when it refused, `false` when the request may route; move the comments explaining why each gate precedes routing with the gate it explains.
- `function startGuiListener(server: http.Server, port: number, allInterfaces: boolean, root: string): Promise<http.Server>` holds today's `new Promise` body: the `onListenError`/`onListening` pair, the `removeListener` swap to `recordServerError`, and the `guiBindHost`/`server.listen` branch. `startGui` returns its result.
- `function armGuiReloadWatches(root: string, startupBuild: ReturnType<typeof captureStartupBuild>, server: http.Server, watch: GuiWatchSeams): void` holds today's `createReloadWatch` (with the unchanged `onTrigger`), `void reloadWatch.start()`, the `watchReloadSupervisor` callback, and `server.once("close", stopSupervisorWatch)`.
- Leave `startGui` with `captureStartupBuild()`, the unchanged `servePage`/`guiRoutes` table, and the `http.createServer` callback: its `try`/`catch`, `const target = parseRequestTarget(req); const pathname = target?.pathname ?? null; if (refuseGuiRequest(req, res, target, allInterfaces, token)) return;`, the route lookup, the 404 body and the 500 catch. Then the `armGuiReloadWatches(...)` call and `return startGuiListener(server, port, allInterfaces, root);`.

**Files touched.** src/gui/gui-server.ts

**Acceptance criteria.**
- `startGui`'s body no longer contains `loopbackHostAllowed`, `tokenMatches`, `crossOriginRequest`, `createReloadWatch`, `watchReloadSupervisor`, `server.once("close"`, `server.listen(`, `removeListener` or `recordServerError`; it contains the route table, the createServer dispatch, the three new calls and the return.
- `refuseGuiRequest`, `startGuiListener` and `armGuiReloadWatches` are each declared exactly once at module scope, are not exported, and are called only from `startGui`: `grep -nE '^(async )?function (refuseGuiRequest|startGuiListener|armGuiReloadWatches)\(' src/gui/gui-server.ts` matches all three and no `export` line names them.
- The refusal order is unchanged: a rebinding Host is refused with the existing 403 body even when a token is also missing, a token-gated request without the bearer/query token is refused with `token required` before any state-changing route, and a cross-origin POST is refused with the existing 403 body; an accepted request reaches the same route handler as before.
- The listen contract is unchanged: `startGui` resolves with the listening server, a bind error still rejects the returned promise, and a post-listen `error` is recorded through `recordServerError` instead of rejecting the settled promise.
- The exported surface is unchanged: `grep -nE '^export ' src/gui/gui-server.ts` matches today's lines (including `startGui`, `guiBindHost` and `loopbackHostAllowed`), and `GuiWatchSeams` is not exported.
- Behaviour is unchanged: test/gui-token.test.ts, test/gui-server-transport.test.ts, test/gui-server-lifecycle.test.ts and test/gui.test.ts pass unedited; no test file is edited.
- `npm run test:gate` passes.

**Tests.** No new test module: a behavior-preserving move guarded by the existing dashboard suites. Run test/gui-token.test.ts (the bearer/query token gate), test/gui-server-transport.test.ts (the Host and cross-origin gates), test/gui-server-lifecycle.test.ts (listen resolution and the reload/supervisor watches) and test/gui.test.ts (the bound host and a live server), then the project's gate, and confirm green. If a request that should be refused reaches a route, a gate moved out of order or dropped its early return; fix the move, do not relax the test.

## Done
