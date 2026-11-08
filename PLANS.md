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

### Subtract verify collapse split, part 2/4: test/merge-pipeline-2.test.ts observes queue, check-flag and event signals, and its abort cases drive one in-flight change (planned 2026-11-08 by the plan role, splitting the 2026-11-06 part 3c/6 after feature held it too large for one run; requires part 1/4 landed; sibling to parts 3/4–4/4, which collapse the drain and remove `alreadyGated`; touches test/merge-pipeline-2.test.ts)

**Goal.** The second pipeline slice passes under today's flow and will keep passing when the drain becomes one gate-then-merge task per head. Its abort cases no longer require a multi-role task that merges beta then stops short of alpha; they abort the one change in flight.

**Approach.**
- Replace `approvedChanges(root)` waits with queue depth, check-start flags, marker `merging`, and `merged`/`merge_done` events.
- Rewrite the two abort cases to queue one change (or wait for beta's `merged` event before aborting alpha), then abort the in-flight change and assert its `aborted` outcome, dropped entry and discarded pin. Do not wait for two approved changes while the merge slot is busy.
- Rewrite the reviewer-hold case to wait for both entries queued, then both `merged` events, not both approved.
- Rewrite the head-verdict case to wait for beta's check flag or `merged` event instead of `approvedChanges(root).includes("beta")`.
- Rewrite the plumbing-throw case to assert the head's entry stays queued and no `approved` marker remains, not that both entries are unapproved.
- Keep the pin-already-gone, unwritable-state, and abortableMerges cases; only change their waits and the number of changes in flight.

**Acceptance criteria.**
- `grep -n 'approvedChanges' test/merge-pipeline-2.test.ts` prints nothing.
- No abort case waits for two approved changes before freeing the merge slot; each abort case aborts the one change the task is merging and asserts its `aborted` outcome, dropped entry and discarded pin.
- The file passes under the current verify-then-merge flow, and its waits are on queue depth, check flags, marker `merging`, or `merged`/`merge_done` events.
- `npm run test:gate` passes.

**Tests.** Run test/merge-pipeline-2.test.ts, then the gate.

### Subtract verify collapse split, part 3/4: the drain starts one gate-then-merge task per queue head and stops starting verifications (planned 2026-11-08 by the plan role, splitting the 2026-11-06 part 3c/6 after feature held it too large for one run; requires part 2/4 landed; sibling to part 4/4, which removes `alreadyGated`; touches src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merge-fixtures.ts)

**Goal.** A queued entry goes from the queue to the gate to the merge in one task. `drainMergeQueue` no longer calls `drainVerify`; `drainMerge` takes the first eligible queue head and starts one task whose `mergeApprovedChange` runs `reviewQueuedChange` in its merge worktree before `mergeToMain`, settles the outcome, queues the post-merge review on a `merged` event, and clears the merge slot so the next poll starts the next head. The approved/verifying maps are no longer populated; they stay in the type, empty, until part 3d/6 deletes them. `alreadyGated` stays in `MergeRequest` for direct callers until part 4/4.

**Approach.**
- `src/merge/merge-drain.ts`: `drainMergeQueue` drops the `drainVerify` call and awaits `drainMerge`. `drainMerge` becomes async: it calls `dropTornHead`, reads `queuedMergeFiles`, reads main's head once, and for the first entry not held by `liveRoles`, not before `notBefore`, not `startHeld`, and not already merged, drops an already-merged entry (with its marker) and continues; otherwise it starts one task. Move the dedupe, torn-head, `notBefore`, `liveRoles` and `startHeld` checks from `drainVerify` into this loop. The task builds a one-change `ApprovedMerge`-shaped record from the queue entry (author, `mergeUsage`, `startedAt`, empty-controller task fields), supplies `gatePermit` by acquiring `VERIFY_TIER` from `ctx.semaphore` and wrapping the gate in `withRunPermit`, releases it before `mergeToMain`, and calls `mergeApprovedChange` without `alreadyGated`. It settles each outcome through `settleMergeOutcome`, queues the post-merge review on `merged`, handles user abort and shutdown as today, and clears `p.merge` in its finally. `settleAbortedApproved` becomes a no-op over the empty map.
- `src/merge/merge-pipeline.ts`: keep the `verifying`/`approved` fields and `ApprovedMerge` type for part 3d/6; update the pipeline comments to describe one serial head task plus the post-review task. `mergeTasks`, `abortableMerges` and `liveRoles` keep compiling over the empty maps.
- `src/orchestrator/orchestrator-poll.ts`: keep the `settleAbortedApproved` import and call (it iterates an empty map).
- Delete `test/merge-drain-verify.test.ts` with its pooled-slot verification subject.
- `test/fixtures/orchestrator-fixtures.ts`: `mergeHead` drives the queue head through `drainMergeQueue` (the one task) instead of `startVerify` followed by `drainMerge`.
- `test/fixtures/merge-fixtures.ts`: `allTasks` may keep reading the now-empty maps, but no merge assertion may wait on them.
- `test/merge-drain.test.ts`: replace `pipeline.verifying.size` assertions with queue, marker, runner-state and `drained` evidence; keep the dedupe, torn-head and post-review subjects.

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start or approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `drainMergeQueue` no longer calls `drainVerify`; the drain no longer writes `p.approved` or `p.verifying`. The withdrawn, dedupe, torn-head, `notBefore`, `liveRoles` and `startHeld` checks still run in the serial drain.
- The gate runs under a `VERIFY_TIER` team lease that is released before `mergeToMain`; the conflict resolver still takes `MERGE_TIER` and no task holds both at once.
- `test/merge-drain-verify.test.ts` is gone with its subject; the surviving merge-drain and pipeline tests drive an entry from queue to merge.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Run test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts and test/merge-withdrawn.test.ts, then the gate.

### Subtract verify collapse split, part 4/4: `alreadyGated` is removed and the direct merge tests drive the gate inside `mergeApprovedChange` (planned 2026-11-08 by the plan role, splitting the 2026-11-06 part 3c/6 after feature held it too large for one run; requires part 3/4 landed; sibling to parts 1/4–3/4, which prepared the pipeline tests and collapsed the drain; touches src/merge/merge-core.ts test/merger.test.ts test/merger-check.test.ts test/merge-withdrawn.test.ts)

**Goal.** `mergeApprovedChange` always owns the queued change's one gate; no caller can skip it. The direct merge tests drive the gate-inside merge and assert the same merge-phase behavior when the gate approves, and the withdrawn cases drive `mergeApprovedChange` directly instead of `verifyRequest` followed by a marked merge.

**Approach.**
- `src/merge/merge-core.ts`: remove `alreadyGated` from `MergeRequest` and the `if (!req.alreadyGated)` branch, so `mergeApprovedChangeIn` always checks withdrawal and runs `reviewQueuedChange` under `gatePermit` before `mergeToMain`. Update the doc comments that describe the verify-stage marked path.
- `test/merger.test.ts` and `test/merger-check.test.ts`: remove every `alreadyGated: true`; for cases whose only subject was skipping the gate, retarget them to the one-gate rule (the gate runs once and the merge proceeds when it approves) or delete them if the subject is gone. Keep the merge-phase cases that still hold when the gate approves.
- `test/merge-withdrawn.test.ts`: keep the verify-only case; rewrite the two merge cases to call `mergeApprovedChange` once without `alreadyGated` and keep the withdrawn-pin assertions.
- `test/fixtures/merger-fixtures.ts`: `verifyAndMerge` already calls `mergeApprovedChange` without the flag; update its comment to say the call owns the gate.

**Acceptance criteria.**
- `grep -rn 'alreadyGated' src/ test/` prints nothing.
- A direct `mergeApprovedChange` call on a queued diff runs the gate once before `mergeToMain`; a diff that edits the brief block, PRINCIPLES.md or a credential, or whose check fails for a test of its own, is rejected and does not merge.
- The withdrawn cases still assert `withdrawn`, an unmoved main, a deleted pin and the recorded warning, now through one `mergeApprovedChange` call.
- `npm run test:gate` passes.

**Tests.** Run test/merger.test.ts, test/merger-check.test.ts, test/merge-withdrawn.test.ts, test/runner-revision.test.ts and test/merge-pipeline.test.ts, then the gate.

### Subtract verify collapse, part 3d/6: The verify-stage modules and the now-empty approved/verifying maps are deleted; direct callers use the one-step merge (planned 2026-11-04 by the plan role, splitting the 2026-11-04 too-large part 3b/5 after feature held it too large for one run, then renumbering it when parts 3b/6 and 3c/6 split it further; requires Subtract verify collapse split part 4/4 landed; touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-head.ts src/merge/merge-queue.ts src/orchestrator/orchestrator-poll.ts test/merge-requeue.test.ts test/runner-revision.test.ts test/fixtures/merger-fixtures.ts test/fixtures/merge-fixtures.ts)

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

### `tumwater prompt --show <n>` prints one queued prompt in full, so an operator can read a long steering message without opening it in an editor (planned 2026-11-08 by the plan role; the read-only twin of `questions --show` and `plan --show`, and the missing verb beside `prompt --list`'s previews, `--edit`'s editor and `--cancel`/`--top`'s position addressing; independent in file of every `## Planned` entry — `grep -n 'prompt --show\|cli-command-args\|prompt-commands' PLANS.md BUGS.md` prints nothing, the salvage and config-problem plans touch src/status, src/doctor and src/ui, and every Subtract part touches src/merge, src/runner, src/status, src/doctor, src/gui, src/ui, src/stage, src/events or docs, never src/cli/cli-command-args.ts or src/inbox/prompt-commands.ts; PLANS-DONE.md holds no `prompt --show` entry (`grep -c 'prompt --show' PLANS-DONE.md` prints 0) and its `questions --show` entries are the sibling command, not this one; touches src/cli/cli-command-args.ts src/inbox/prompt-commands.ts src/cli/help.ts docs/cli.md test/cli-prompt-show.test.ts test/cli-prompt-strictness.test.ts)

**Goal.** `tumwater prompt --list` prints each queued prompt as a one-line preview, and the only way to read a long steering message in full today is bare `--edit <n>`, which opens an editor and risks an accidental write. Add a read-only `tumwater prompt --show <n>` that prints the Nth queued prompt exactly as the role will receive it (minus the not-before plumbing), with a header naming its role, position and wait or deferral, and `--json` for scripts. It addresses positions the same way `--cancel`/`--top` do, so `--list`'s numbering is the contract.

**Approach.**
- `src/cli/cli-command-args.ts`: add `--show` to `PROMPT_FLAG_SPECS` (value `<n>`), collect `showFlag` in `scanPromptFlags`, carry it on `PromptFlags`, and add a `{ mode: "show"; role: string | null; position: number; json: boolean }` arm to `PromptArgs`. Add `--show` to `PROMPT_MODE_EXCLUSIONS` against `--list`, `--cancel`, `--edit` and `--top` (update the "six" comment to ten). Add `showPromptArgs` beside `positionOnlyPromptArgs`: it parses the position with `parsePositionFlag("--show", …, "--show 2")`, claims the `--role` pair and any `--json` tokens, and refuses every other token with the same "with --show there is no prompt text" stray-argument wording. Extend `assertPromptJsonListOnly` to admit `--show` (rename its comment to list-or-show), add `showFlag` to `parsePromptFollow`'s value-slot set, and add `showFlag` to `assertPromptQueueOnlyFlags`'s read-only mode predicate so `--file`, `--at` and `--attach` are refused there. Dispatch `--show` in `parsePromptArgs` before the `--file` branch.
- `src/inbox/prompt-commands.ts`: add `runPromptShow(root, position, role, json)`. With no `--role`, resolve through the existing `resolveListedQueue(root, listWideScope(root), position)` and `failQueueMiss` (the same ambiguity/miss wordings `--cancel` prints), then read the row from `queuedListRows(root, resolvedRole, listWideScope(root))` at that position; with `--role`, read `queuedListRows(root, role, listWideScope(root))` directly. A row that vanished between resolution and read reports the existing `sayPromptGone` line. Render the prose as a header line `<role> #<position> (queued <age> ago)` or `(delivers in <duration>)` — the same `queuedAgeSuffix` wording `--list` uses, so the two views cannot drift — followed by the row's full `text`; `--json` prints the `QueuedListRow` object (`role`, `position`, `file`, `text`, `queuedAtMs`, `notBeforeMs`), the same shape `--list --json` carries. Add the `show` branch to `cmdPrompt`'s dispatch and treat it as read-only in the `validIds` choice (use `knownRoleIdsCached`, like `--list`, so a broken config does not take the view down).
- `src/cli/help.ts` and `docs/cli.md`: add the `tumwater prompt --show <n> [--role <id>] [--json]` stanza/row beside `--list`, saying it prints the Nth queued prompt in full, read-only, with the same numbering and `--role` disambiguation as `--cancel`, and that `--json` prints the row.

**Files touched.** src/cli/cli-command-args.ts src/inbox/prompt-commands.ts src/cli/help.ts docs/cli.md test/cli-prompt-show.test.ts test/cli-prompt-strictness.test.ts

**Acceptance criteria.**
- With two prompts queued for the director, `tumwater prompt --show 2` prints the second prompt's full text (not `promptPreview`'s ellipsized line) under a header naming the director and position 2, and the header carries the same `(queued <age> ago)` suffix `tumwater prompt --list` prints for that row.
- A prompt queued with `--at 1h` shows `(delivers in <duration>)` in the header instead of the age, and its printed text omits the not-before marker line, exactly as `--list` does.
- `tumwater prompt --show 1 --role <id>` prints that role's first prompt; without `--role`, a position held by two roles is refused naming both roles and the `--role` fix, and a position past every queue is refused with the same `no prompt at position N (longest inbox holds M)` wording `--cancel` uses.
- `tumwater prompt --show 1 --json` prints one object with `role`, `position`, `file`, `text`, `queuedAtMs` and `notBeforeMs`, and the `text` equals the full queued body minus the not-before marker.
- `--show` refuses `--grep`, `-f/--follow`, `--file`, `--at` and `--attach`, and refuses combining with `--list`, `--cancel`, `--edit` or `--top`, each with a message naming the offending flag; it writes no file and wakes no role.
- `tumwater help` and `docs/cli.md` list the new form, and `npm run test:gate` passes.

**Tests.**
- `test/cli-prompt-show.test.ts` (new): a long queued prompt prints in full with its header and age; a deferred prompt prints the countdown and no marker; `--role` scopes; a shared position is ambiguous and a missing one names the longest queue; `--json` carries the row fields; a prompt dequeued between resolution and read reports gone.
- `test/cli-prompt-strictness.test.ts`: `--show` refuses `--grep`, `-f/--follow`, `--file`, `--at`, `--attach` and each sibling mode, and a non-integer or non-positive position fails with the `--show 2` usage wording.

### `tumwater archive --dry-run` previews the finished entries a bulk archive would move or drop, writing nothing, so an operator can check the move before it commits (planned 2026-11-08 by the plan role; the missing dry-run beside `revert --dry-run`, `retire --dry-run` and `reclaim --dry-run`; independent in file of every `## Planned` entry — `grep -n 'archive --dry-run\|previewArchiveOnMain' PLANS.md BUGS.md` prints nothing, the salvage, prompt --show, reviews --show and quarantine --show plans touch src/status, src/doctor, src/ui, src/cli/cli-command-args.ts, src/inbox, src/cli/cli-review-commands.ts, src/review and src/cli/cli-query-commands.ts, never src/backlog/backlog-archive.ts or src/cli/backlog-cli.ts, and every Subtract part touches src/merge, src/runner, src/status, src/doctor, src/gui, src/ui, src/stage, src/events or docs; PLANS-DONE.md's archive entries add `--json`, the team-start sweep and the commit-time sweep, never a preview (`grep -c 'archive --dry-run\|previewArchiveOnMain' PLANS-DONE.md` prints 0); touches src/backlog/backlog-archive.ts src/cli/backlog-cli.ts src/cli.ts src/cli/help.ts docs/cli.md test/backlog-archive.test.ts)

**Goal.** `tumwater archive` moves every finished entry still under PLANS.md `## Done` and BUGS.md `## Fixed` into the archive files and commits the move on the base branch. It is the one bulk backlog move with no preview: `revert`, `retire` and `reclaim` all take `--dry-run`, but an operator who wants to know which entries a bulk archive would move, and which already-archived ones it would drop, has to run the real command and read the commit. Add `tumwater archive --dry-run` that prints the same per-file move lines the real command prints, prefixed `would move`, plus the dropped count, and writes no file and makes no commit. `--json` carries the same `moved` rows the real `--json` prints, with `dryRun: true`, `archived: false` and `commit: null`.

**Approach.**
- `src/backlog/backlog-archive.ts`: export the existing private `ArchivedFile` interface (the `file`, `archive`, `titles`, `dropped` shape `describeArchivedFile` and the real `--json` already use). Add `export type ArchivePreviewOutcome = { status: "would-archive"; moved: ArchivedFile[] } | { status: "nothing" } | { status: "skipped"; reason: string }` and `export async function previewArchiveOnMain(root: string): Promise<ArchivePreviewOutcome>`. It calls the existing private `planOrSkip(root, 0)`; a `skipped` or empty plan returns as-is. Otherwise it runs the same two read-only preconditions the real command runs before writing — `primaryOffBaseBranchReason(root)` and `gitTry(root, "status", "--porcelain", "--", ...FINISHED_ARCHIVES.flatMap((a) => [a.file, a.archive]))` — and returns `skipped` with the same reason wording `archiveFinishedOnMain` uses (`your checkout is on …`, `<files> have uncommitted changes`, `could not read git status`). On success it maps each planned `{ spec, move }` to `{ file: spec.file, archive: spec.archive, titles: move.titles, dropped: move.dropped }` and returns `would-archive`. It takes no lock and calls no writer, so it cannot move an entry or create an archive file.
- `src/cli/backlog-cli.ts`: in `cmdArchive`, read `--dry-run` beside `--json`. With `--dry-run`, call `previewArchiveOnMain` instead of `archiveFinishedOnMain`. `would-archive` prints one `would move ${describeArchivedFile(f)}` line per file, then `dry run — nothing archived`; `nothing` prints the existing `nothing to archive: …` line; `skipped` fails with `nothing would be archived: ${reason}`. With `--dry-run --json`, print `{ dryRun: true, archived: false, commit: null, moved }` (an empty `moved` for `nothing`), and fail on `skipped` as the text form does. The non-dry-run path is unchanged.
- `src/cli.ts`: add `DRY_RUN_FLAG` to `cmdArchiveCase`'s `rejectUnknownArgs("archive", args, [JSON_FLAG, DRY_RUN_FLAG])`, so `--dry-run` is accepted and every other unknown flag is still refused.
- `src/cli/help.ts` and `docs/cli.md`: change the archive usage to `tumwater archive [--dry-run] [--json]` and say `--dry-run` lists the entries it would move and drop, writing nothing, and that `--json` with it prints the same `moved` rows with `dryRun: true` and no commit.

**Files touched.** src/backlog/backlog-archive.ts src/cli/backlog-cli.ts src/cli.ts src/cli/help.ts docs/cli.md test/backlog-archive.test.ts

**Acceptance criteria.**
- With one finished entry under PLANS.md `## Done` and one under BUGS.md `## Fixed`, `tumwater archive --dry-run` exits 0, prints `would move PLANS.md → PLANS-DONE.md: 1 entry` and `would move BUGS.md → BUGS-FIXED.md: 1 entry`, then `dry run — nothing archived`; the live files, both archive files and `git log -1` are byte-for-byte unchanged.
- `tumwater archive --dry-run --json` prints `{ dryRun: true, archived: false, commit: null, moved: [...] }` whose `moved` rows carry the same `file`, `archive`, `titles` and `dropped` fields the real `tumwater archive --json` prints, and writes nothing.
- With no finished entries, `--dry-run` prints the existing `nothing to archive: …` line and `--dry-run --json` prints `moved: []`; neither writes.
- On a checkout off the base branch, or with a dirty PLANS.md, BUGS.md, PLANS-DONE.md or BUGS-FIXED.md, `--dry-run` exits non-zero with `nothing would be archived: <reason>`, where `<reason>` is the same sentence the real command's `nothing archived: <reason>` carries, and writes nothing.
- `tumwater archive` without `--dry-run` still moves and commits exactly as before, and `tumwater archive --stat` (or any other unknown flag) is still refused naming the flag.
- `tumwater help` and `docs/cli.md` list the new form, and `npm run test:gate` passes.

**Tests.**
- `test/backlog-archive.test.ts`: `previewArchiveOnMain` returns `would-archive` with both files' titles and leaves the live and archive files and HEAD unchanged; returns `nothing` for an empty finished section; returns `skipped` with the off-base and dirty-file reasons and writes nothing; a spawned `tumwater archive --dry-run` prints the `would move` lines and `dry run — nothing archived` and leaves the tree and HEAD unchanged; `--dry-run --json` carries `dryRun: true`, `commit: null` and the same `moved` rows as the real `--json`; `--dry-run` on an empty backlog prints `nothing to archive`; `--dry-run` on a dirty file fails with `nothing would be archived:` and the real command's reason; `--stat` is still refused.

### `tumwater salvage [--show <n>] [--json]` lists the workspace patches kept for you under `.tumwater/salvage/` and prints one in full, so an operator can read what a run left behind before applying or deleting it (planned 2026-11-08 by the plan role; the readable half of the landed 2026-11-08 salvage-surfacing plan, which raised the doctor row and standing alert but names only each patch's file, age and size; the read-only detail twin of `quarantine --show` and `reviews --show`, and the missing verb beside the surfaced patches; independent in behavior of every `## Planned` entry — `grep -n 'tumwater salvage\|cli-salvage\|status-salvage' PLANS.md BUGS.md` prints nothing before this entry; the pending `prompt --show` and `archive --dry-run` plans add different stanzas/rows to src/cli/help.ts and docs/cli.md, so whichever lands second rebases there, while no waiting entry touches src/status/status-salvage.ts or adds a `salvage` command (the Subtract parts that touch src/status name src/status/status-data.ts, src/status/status-roles.ts or src/status/status-polls.ts, part 3f/7 all three, never src/status/status-salvage.ts); `grep -c 'tumwater salvage' PLANS-DONE.md BUGS-FIXED.md` prints 0 for both, and PLANS-DONE.md's salvage entries add the doctor row and status alert, the writer/restorer and the retention prune, never a read command; docs/invariants.md's INV-BQ5 binds the retention prune of `salvageDir`, which this read-only command leaves unchanged; touches src/status/status-salvage.ts src/cli/cli-salvage-command.ts (new) src/cli.ts src/cli/help.ts docs/cli.md test/status-salvage.test.ts test/cli-salvage.test.ts (new))

**Goal.** The doctor `salvage patches` row and the standing `salvage-patches` alert tell an operator that patches are kept under `.tumwater/salvage/`, but they name only each file, its age and its size; reading one means leaving the CLI and guessing the directory. Add `tumwater salvage` to list the kept patches as the doctor counts them (oldest first, numbered) and `--show <n>` to print the Nth one's text verbatim, both read-only and needing no ready repo, plus `--json` for scripts.

**Approach.**
- `src/status/status-salvage.ts`: add `readSalvagePatch(root: string, file: string): string | null`, reading `path.join(salvageDir(root), file)` as UTF-8 and returning null on any read error. It reads only a name the collector already returned, never `pending/<role>/`.
- `src/cli/cli-salvage-command.ts` (new): export `cmdSalvage(root, args)`. Route `--show` before the list gate, the way `cmdQuarantine` routes its detail branch. The list branch runs `rejectUnknownArgs("salvage", args, [JSON_FLAG])` and `refuseTeamWorkspace(root)`, then `collectSalvagePatches(root)`; empty prints `no salvaged workspace patches are kept for you`, else a `salvaged workspace patches: <n>` header and one `<i>. <file> — saved <formatAge(now - savedAt)> ago, <formatBytes(bytes)>` line per patch, oldest first. `--json` prints `{ patches: [{ position, file, savedAt, bytes }] }` (empty array when none). The `--show` branch parses with `scanPositionArgs(args, "--show", "--show 2")`, refuses every other token, fails a missing position with `--show needs a position (usage: tumwater salvage --show <n>)`, refuses a position past the list with `no salvaged workspace patch at position <n> (salvage holds <m> patches)`, and fails a patch that cannot be read with `could not read salvaged patch <file>`. It prints a `salvaged workspace patch <n>: <file>` header, a `saved <age> ago, <bytes>` line, then the patch text verbatim; `--json` prints `{ position, file, savedAt, bytes, patch }`.
- `src/cli.ts`: add the `salvage:` row with a lazy import, beside `quarantine` and `archive`.
- `src/cli/help.ts` and `docs/cli.md`: add the `tumwater salvage [--show <n>] [--json]` stanza and table row, saying it lists the kept patches and prints one in full, read-only and needing no ready repo.

**Files touched.** src/status/status-salvage.ts src/cli/cli-salvage-command.ts (new) src/cli.ts src/cli/help.ts docs/cli.md test/status-salvage.test.ts test/cli-salvage.test.ts (new)

**Acceptance criteria.**
- With two direct patches under `.tumwater/salvage/` whose mtimes are three hours and under a minute old, `tumwater salvage` prints a count of 2 and two numbered lines oldest first, each naming the file, `saved 3h ago` / `saved 0m ago`, and the byte count; a pending patch under `pending/<role>/` and a non-`.patch` file are not listed.
- With no salvage directory, the same command prints `no salvaged workspace patches are kept for you` and exits 0; `--json` prints `{ "patches": [] }`; neither creates the directory or writes a file.
- `tumwater salvage --show 2` prints a header naming position 2 and the second patch's file, then that patch's exact bytes; `--show 2 --json` prints the same `position`/`file`/`savedAt`/`bytes` fields as the list's second row plus the exact `patch` text; the patch file's bytes are unchanged after either run.
- `--show` past the list exits non-zero with `no salvaged workspace patch at position N (salvage holds M patches)`, and a missing, zero or non-integer position fails with the `--show 2` usage wording.
- `salvage` refuses an unknown flag (including `-f/--follow`) by name; run inside a role's team workspace it fails with the owning team root, like `quarantine --show`.
- `tumwater help salvage` and `docs/cli.md` describe the list and `--show` forms, and the project's gate passes.

**Tests.**
- `test/status-salvage.test.ts`: `readSalvagePatch` returns a direct patch's exact text and null for a missing file.
- `test/cli-salvage.test.ts` (new): seed a repo's salvage dir with an older and a newer patch (mtimes set through `utimesSync`), plus a `pending/<role>/x.patch` and a `notes.txt`; assert the list order, header, ages and sizes, the two excluded files, the empty-dir line, the `--json` shape, `--show 2` text, `--show --json`, the out-of-range and bad-position failures, the unknown-flag refusal, and that both commands leave every salvage file's bytes unchanged.

## Done
