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

### `tumwater quarantine --grep <text>` keeps only the quarantined tests whose path or filed bug contains the text, so an operator can find the flake they mean without opening `quarantine.json` or running `--show` down the list (planned 2026-11-08 by the plan role; the missing filter beside `quarantine --show`'s detail view and the `--grep` every other positioned list already has — `plan`/`bug --list`, `backlog`, `questions`, `prompt --list`, `history`, `logs` and the pending `reviews --grep`; the list squashes the test path and filed-bug heading to 80 characters, and in a long quarantine the one matching entry is otherwise found by reading each `--show`; independent in file of every `## Planned` entry — `grep -c 'quarantine --grep\|grepQuarantine' PLANS.md PLANS-DONE.md BUGS.md BUGS-FIXED.md` prints 0 for all four, the pending `reviews --grep` plan adds its matcher to src/review/post-merge-review-render.ts and its filter to src/cli/cli-review-commands.ts, never src/review/quarantine-render.ts or `cmdQuarantine`, and the blocked Subtract part 3d/7 lists src/cli/cli-query-commands.ts and docs/cli.md but deletes `cmdQueue`, `merge-queue-render.ts` and the queue row, never `cmdQuarantine` or the quarantine row, so whichever lands second rebases there; `src/review/quarantine-render.ts` names no `--grep` and no `grepQuarantine` today; docs/invariants.md's flake-quarantine section binds `quarantineTests`, `onlyQuarantined`, `loadQuarantine` and `releaseQuarantine`, whose behavior this read-only filter leaves unchanged, so no invariant edit is needed; touches src/cli/cli-query-commands.ts src/review/quarantine-render.ts src/cli/help.ts docs/cli.md test/cli-quarantine.test.ts test/cli-quarantine-follow.test.ts test/quarantine-render.test.ts)

**Goal.** `tumwater quarantine` can be narrowed to the entries an operator is looking for: `--grep <text>` keeps only the entries whose test path or filed-bug heading contains the text (case-insensitively), under their unfiltered positions, and composes with the list, `--json` and `-f/--follow`. `--show <n>` and `--release <n>` keep addressing the whole list, so a filter never shifts the position they act on.

**Approach.**
- `src/review/quarantine-render.ts`: add `grepQuarantineRows(rows, pattern)` — the pure twin of `grepBacklog` — returning only the rows whose `test` or `bug` contains `pattern` case-insensitively, with each kept row's `position` unchanged. `renderQuarantine` stays as it is, so the header counts the kept rows and each line keeps the number `--show`/`--release` use.
- `src/cli/cli-query-commands.ts`: in `cmdQuarantine`'s list branch, accept `--grep` through `grepFlagSpec` and parse it with `parseGrepFlag(args, "quarantine --grep needs text (usage: tumwater quarantine --grep <text>)")`; scan `-f`/`--json` over the returned `rest` so a pattern spelled like a flag (`--grep --json`) is text, not the rival flag. Filter the rows from `quarantineRows(loadQuarantine(root))` before render and before the `{ tests }` JSON document. The no-match prose is `no quarantined tests match "<pattern>"` when the whole list is non-empty but nothing matches; a genuinely empty quarantine keeps `flake quarantine is empty`, and `--json` prints `{ "tests": [] }` in both cases. The follow frame applies the same filter each repaint. `--show` and `--release` keep their own flag gates, which already refuse `--grep` by the unknown-flag message.
- `src/cli/help.ts` and `docs/cli.md`: add `--grep <text>` to the quarantine form and say it keeps the entries whose test path or filed-bug heading contains the text, case-insensitively, under their unfiltered numbers, and that it composes with `-f/--follow` and `--json`.

**Files touched.** src/cli/cli-query-commands.ts src/review/quarantine-render.ts src/cli/help.ts docs/cli.md test/cli-quarantine.test.ts test/cli-quarantine-follow.test.ts test/quarantine-render.test.ts

**Acceptance criteria.**
- With three entries whose tests are `test/old.test.ts` (position 1), `test/mid.test.ts` (position 2) and `test/new.test.ts` (position 3), `tumwater quarantine --grep mid` prints a `flake quarantine: 1 test` header and one line numbered `2.`; `--grep OLD` matches the path case-insensitively and prints position 1; a pattern found only in a filed-bug heading keeps that entry at its whole-list position; no non-matching entry prints.
- The same filter reaches `--json`: the document holds only the matching rows, each with its whole-list `position`, and `--json` prints `{ "tests": [] }` when nothing matches; neither form writes `quarantine.json`.
- When the list is non-empty and nothing matches, the text form prints `no quarantined tests match "<pattern>"` and exits 0; with no quarantine file it still prints `flake quarantine is empty`, not the no-match line.
- `tumwater quarantine -f --grep mid` repaints only the matching rows on each frame and refuses `--json` with the existing follow-worded error; a missing `--grep` value fails with the usage wording above; `quarantine --show 1 --grep x` and `quarantine --release 1 --grep x` fail naming `--grep`, and `quarantine --show 1` still prints the whole-list first entry.
- `tumwater help quarantine` and `docs/cli.md` describe `--grep` and its unfiltered numbering, and `npm run test:gate` passes.

**Tests.**
- `test/quarantine-render.test.ts`: `grepQuarantineRows` keeps a test-path match and a filed-bug match case-insensitively, preserves each kept row's original position (including a gap), returns `[]` for no match, and leaves `renderQuarantine`'s numbering and header unchanged for the filtered result.
- `test/cli-quarantine.test.ts`: seed entries at three positions and assert the filtered text at position 2, the case-insensitive path and filed-bug matches, the no-match prose, the empty-quarantine line, the filtered `--json` positions and empty array, and that the file's bytes are unchanged after each run.
- `test/cli-quarantine-follow.test.ts`: drive `-f --grep` with the existing seams and assert every repaint carries only the matching row, then that `-f --json --grep` is refused before a frame.


### `tumwater wake --cancel <n>` cancels one pending scheduled wake by the number `wake --list` prints, so an operator can drop a single wake when a role has several scheduled (planned 2026-11-08 by the plan role; the positional twin of the existing role-wide `wake --cancel`, and the missing verb beside `wake --list`'s numbering — scheduled wakes are one marker file each and later wakes deliberately do not cancel earlier ones, so a role can hold several, but today the only cancel drops every pending wake for the role; independent in file of every `## Planned` entry — `grep -n 'wake --cancel <n>\|cancelWakeAt\|cancelScheduledWakeAt\|optionalValue' PLANS.md BUGS.md` prints nothing before this entry, and no waiting heading or touches list names src/operator/operator-commands.ts, src/operator/operator-requests.ts, src/operator/operator-intent.ts, src/cli/cli-flag-specs.ts or src/cli/cli-marker-commands.ts; PLANS-DONE.md's eight `wake --cancel` mentions are the role-list widening, the scheduled-wake consumer tests and the TUI/dashboard twins, never a positional cancel; docs/invariants.md binds scheduled wakes only through INV-AQ3's due/cancel rule, whose pending-only removal this change preserves; touches src/cli/cli-flag-specs.ts src/cli/cli-args.ts src/cli/cli-marker-commands.ts src/operator/operator-commands.ts src/operator/operator-intent.ts src/operator/operator-requests.ts src/cli/help.ts docs/cli.md test/cli-arg-strictness.test.ts test/cli-operators.test.ts test/operator-commands.test.ts test/operator-intent.test.ts test/operator-requests.test.ts)

**Goal.** `tumwater wake --list` numbers every pending scheduled wake (`1. in 45m — qa`, `2. in 2h — feature, qa`), but `tumwater wake --cancel` takes only `--role` and drops every pending wake naming that role. A role can legitimately hold several scheduled wakes because each `wake --in` writes its own marker and later wakes do not cancel earlier ones, so an operator who wants to drop just one has to cancel all of them and reschedule. Make `--cancel <n>` remove the Nth wake exactly as `--list` numbers it, whole marker file and all, while bare `--cancel` keeps cancelling the role's (or team's) share as today.

**Approach.**
- `src/cli/cli-flag-specs.ts`: add `optionalValue?: boolean` to `FlagSpec` — a valued flag whose value token may be omitted. `validFlagsList` renders such a flag as `${name} [${valueName}]`; `consumeFlagOccurrence` claims the following token only when it is present and does not start with `-`, validates it through the spec's `validate` when claimed, and otherwise claims just the flag so bare `--cancel --role qa` still parses. `rejectEqualsForm` treats an optional-value flag like a valued one (`--cancel=2` refuses with the separate-token wording). `WAKE_CANCEL_FLAG` becomes `{ names: ["--cancel"], optionalValue: true, valueName: "<n>", validate: (v) => parsePositionFlag("--cancel", v, "wake --cancel 2") }`; every other spec is unchanged.
- `src/cli/cli-args.ts`: add `optionalFlagValue(args, flag)` beside `flagValue`: null when the flag is absent or the next token is absent/starts with `-`, otherwise the following token. This is the read `cmdWake` uses, so the gate and the body cannot disagree about whether a token was claimed.
- `src/operator/operator-requests.ts`: extract the pending-file walk behind `pendingScheduledWakes` into a module-private `pendingWakeMarkers(root, now): { file, roles, atMs }[]` (same skip of due/corrupt/malformed files, same earliest-deadline sort), and make `pendingScheduledWakes` map it to `{ roles, atMs }`. Add `cancelScheduledWakeAt(root, position, now, roles?)`: filter that list by `roles` when given, take the 1-based `position`, remove its marker file with `removeQuiet`, and return `{ wake?: { roles, atMs }, pending: number }` where `pending` is the filtered count left. It removes the whole file even when the wake names several roles; a miss removes nothing.
- `src/operator/operator-intent.ts`: add `cancelWakeAt(root, position, roles?, now = Date.now())` beside `cancelWakes`. On success it returns `cancelled scheduled wake ${position} (in ${humanUntil(atMs, now)} — ${roles.join(", ")})`, the list row's own wording under the position. On a miss it returns `no scheduled wake at position ${position}${roles ? ` for ${roles.join(", ")}` : ""} (${plural(pending, "scheduled wake")} pending)`. `cancelWakes` is unchanged for the bare form.
- `src/operator/operator-commands.ts`: in `cmdWake`'s `--cancel` branch, read `optionalFlagValue(args, "--cancel")`; when it is non-null parse it with `parsePositionFlag("--cancel", value, "wake --cancel 2")` and print `cancelWakeAt` with the same `namedRoleList(root, args)` scope `--list` uses; otherwise call `cancelWakes` as today. Keep the existing `--cancel`/`--in` and `--list`/`--cancel` refusal order.
- `src/cli/help.ts` and `docs/cli.md`: show `wake --cancel [<n>] [--role <id>[,<id>...]]` and say the position is the one `wake --list` prints under that `--role` scope, that it removes that whole scheduled wake, and that bare `--cancel` keeps dropping every pending wake (or the named roles' share).

**Files touched.** src/cli/cli-flag-specs.ts src/cli/cli-args.ts src/cli/cli-marker-commands.ts src/operator/operator-commands.ts src/operator/operator-intent.ts src/operator/operator-requests.ts src/cli/help.ts docs/cli.md test/cli-arg-strictness.test.ts test/cli-operators.test.ts test/operator-commands.test.ts test/operator-intent.test.ts test/operator-requests.test.ts

**Acceptance criteria.**
- With wakes scheduled at three increasing deadlines (`qa`, then `feature,qa`, then `clean`), `tumwater wake --list` numbers them 1–3; `tumwater wake --cancel 2` prints `cancelled scheduled wake 2 (in <duration> — feature, qa)` and leaves the first and third wakes pending, with no immediate-wake marker written.
- `tumwater wake --cancel 2 --role qa` takes the second wake in `wake --list --role qa`'s numbering; a wake naming both `qa` and another role is still removed whole, and the other wake naming neither stays.
- A position past the pending list prints `no scheduled wake at position 3 (1 scheduled wake pending)` (with the ` for <roles>` clause when `--role` scoped it) and removes nothing; `--cancel 0`, `--cancel x` and `--cancel --json` fail with the position parser's positive-integer wording, while bare `--cancel` still prints the existing `cancelled N scheduled wake(s)` / `no scheduled wake pending` wording.
- `wake --cancel --in 5m` still fails with `wake --cancel and --in cannot be combined`, `wake --list --cancel` still fails with the list/cancel rivalry, and `wake --json` without `--list` is still refused.
- `tumwater help wake`, `tumwater help` and `docs/cli.md` show `--cancel [<n>]` and name the `wake --list` position contract, and the project's gate passes.

**Tests.**
- `test/operator-requests.test.ts`: `cancelScheduledWakeAt` removes the earliest/second marker by the same order `pendingScheduledWakes` reports, leaves due and corrupt files untouched, honours a role filter, and reports the remaining filtered count on a miss.
- `test/operator-intent.test.ts`: `cancelWakeAt` returns the exact success wording for a whole wake (including one naming two roles), the team-wide and role-scoped miss wordings, and leaves `cancelWakes`'s existing cases unchanged.
- `test/operator-commands.test.ts` or `test/cli-operators.test.ts`: drive the CLI: seed three wakes, cancel the middle by number, assert the survivors; repeat role-scoped; assert the out-of-range, malformed-value and `--in` conflicts; exercise bare `--cancel` and `--cancel --role` unchanged; assert `readScheduledWakes` holds exactly the expected entries after each run.
- `test/cli-arg-strictness.test.ts`: pin the gate's optional value — bare `--cancel`, `--cancel 2`, `--cancel --role qa`, and `--cancel=2` — so a later flag change cannot silently drop the position or treat `--role` as its value.

## Done
