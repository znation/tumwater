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

### `tumwater doctor --list-checks` prints every check name the audit can run, in report order, without running any check, so an operator can pick a name for `tumwater doctor <check>...` without a slow, side-probing full audit (planned 2026-11-08 by the plan role; the doctor's names are held in `DOCTOR_CHECK_NAMES` (src/doctor/doctor-check-names.ts) and `parseDoctorChecks` already matches them case-insensitively, but the only ways to discover them today are running every check and reading the table, reading the completion script, or copying a name a stale doc mentions — `tumwater help doctor` lists only ten categories, not the 81 names; independent in file of every `## Planned` entry — `grep -rq 'list-checks\|listChecks\|LIST_CHECKS' PLANS.md PLANS-DONE.md BUGS.md BUGS-FIXED.md docs src test` prints nothing before this entry, the in-flight `help --grep` and the blocked gather/verify parts touch src/cli/help.ts but no other file here, and no waiting entry names src/cli/cli-doctor-command.ts or src/cli/cli-flag-specs.ts; PLANS-DONE.md records doctor follow, `--reprobe`, completion of check names and many check additions, never a names-only listing, and docs/invariants.md has 31 doctor mentions but none binds a names-listing surface or the order of `DOCTOR_CHECK_NAMES`; touches src/cli/cli-doctor-command.ts src/cli/cli-flag-specs.ts src/cli/help.ts docs/cli.md test/doctor.test.ts)

**Goal.** An operator who wants to run one doctor check (`tumwater doctor main diff rules`) must first learn its exact spelling. Running bare `tumwater doctor` runs every check, including model probes, remote-CI and git reads, and takes real time; the help stanza names only broad categories; the completion script lists the names but only to a shell that sources it. Add a names-only listing that reads the canonical array and runs nothing.

**Approach.** Route `--list-checks` as its own mode at the top of `cmdDoctor`, after `rejectUnknownArgs` accepts the new flag and before `parseDoctorChecks`, so it never imports `../doctor/doctor.js` or touches the repo. Add `LIST_CHECKS_FLAG` (names `["--list-checks"]`, value-less) to src/cli/cli-flag-specs.ts beside `PROBLEMS_FLAG` and include it in `cmdDoctor`'s allowed-flag list. In the mode:
- Refuse any positional check name (`doctor --list-checks takes no check names`) and any of `--problems`, `-f/--follow` or the five repair flags, naming the conflicting flag; accept `--json`.
- Text form: `say` each entry of `DOCTOR_CHECK_NAMES` on its own line, in array order, with no header, no verdict and no blank line.
- `--json` form: `sayJson({ checks: [...DOCTOR_CHECK_NAMES] })`, the same order.
- Leave the normal `doctor` path byte-identical, including the unknown-check hint `tumwater doctor lists every check by name` (no wording change there).
- src/cli/help.ts: add `[--list-checks [--json]]` to the `tumwater doctor` usage line and one description clause saying it prints every check name in report order without running a check, for choosing a `tumwater doctor <check>...` target; docs/cli.md: add the same clause to the doctor row after the check-name sentence.

**Files touched.** src/cli/cli-doctor-command.ts, src/cli/cli-flag-specs.ts, src/cli/help.ts, docs/cli.md, test/doctor.test.ts

**Acceptance criteria.**
- In a fresh empty directory (no git repo, no tumwater.json), `tumwater doctor --list-checks` exits 0 and prints exactly `DOCTOR_CHECK_NAMES` once each, in array order, one per line, with no `tumwater doctor —` header and no `ready to run` / failing verdict line; the existing no-ready-repo stance is irrelevant because no check runs.
- `tumwater doctor --list-checks --json` exits 0 and its entire stdout parses as one JSON document whose `checks` array equals `DOCTOR_CHECK_NAMES` in order.
- `tumwater doctor --list-checks` names a check, `--problems`, `-f/--follow`, `--kill-orphans`, `--commit-backlog`, `--resync-install`, `--drop-broken-pins` or `--retire-leftovers` each exits nonzero, writes no check-name line, and the stderr names `--list-checks` and the conflicting token; a repeated `--list-checks` is refused the same way.
- Bare `tumwater doctor` and `tumwater doctor --json` behave as before: the existing report composition, `--problems`, follow and repair tests pass unchanged, and no test is loosened to accommodate the new mode.
- `tumwater help doctor` shows the new flag and clause; the full `tumwater help` text still parses into one stanza per command.

**Tests.** Add cases to test/doctor.test.ts using the existing `cli(repo, ...)` harness: one asserts the text listing against `DOCTOR_CHECK_NAMES` on a directory with no repo (exit 0, exact lines), one parses the `--json` document, and one table-drives the refusals (positional, `--problems`, `-f`, each repair flag, repeated flag) asserting nonzero exit and the stderr wording. Run test/doctor.test.ts together with test/cli-doctor-follow.test.ts, test/help.test.ts and test/completion.test.ts, then the project's gate.

### `tumwater config --diff` prints only the resolved settings that differ from the built-in defaults — every changed top-level setting and each changed role as `roles.<id>` — so an operator can see what this repo changed without diffing the whole effective dump by hand (planned 2026-11-08 by the plan role; `tumwater config` already prints the whole merged config and `config get <key>` reads one key, but no surface names the non-default subset; `changedConfigKeys` (src/config/config.ts) is close but deliberately skips `maxConcurrent` and `sessionRetentionDays` for the live-reload event and returns names only, so it cannot be reused as the output; `grep -rn -- '--diff\|nonDefaultConfig\|configDiff' PLANS.md PLANS-DONE.md BUGS.md BUGS-FIXED.md docs src test` finds no config-diff surface (only git `--diff-filter` uses), and no waiting entry names src/config/config.ts, src/cli/cli-config-commands.ts or test/cli-config-commands.test.ts; the only files shared with waiting work are src/cli/help.ts and docs/cli.md (the in-flight `help --grep` edits the `help` stanza and docs intro, blocked Subtract part 6a edits other docs/cli.md rows, and this plan edits the `tumwater config` stanza and Configure row) and src/cli.ts (help --grep's `cmdHelpCase`; this plan's `cmdConfigCase`), so it can run alongside them without touching their lines; PLANS-DONE.md records config get/set/unset, live-reload changed-key events, validation and the GUI/TUI editors, never a non-default config listing; docs/invariants.md binds no `config --diff` surface (its config guarantees cover load, validation and live reload, which this read-only view leaves unchanged); touches src/config/config.ts src/cli/cli-config-commands.ts src/cli.ts src/cli/help.ts docs/cli.md test/cli-config-commands.test.ts test/cli-operators-team.test.ts)

**Goal.** The effective config merges defaults, role-catalog entries and `tumwater.json`, so an operator reading `tumwater config` cannot tell which values this repo actually set. Add a read-only `tumwater config --diff` that prints the non-default subset as JSON: settings whose resolved value differs from `defaultConfig()`, with a changed role printed under `roles.<id>`. It reads and writes nothing and needs no new config key.

**Approach.**
- In src/config/config.ts, beside `changedConfigKeys` and sharing its record casts and `stableJson`, add `export function nonDefaultConfigEntries(config: TumwaterConfig): Array<[string, unknown]>`: compare the config against `defaultConfig()`; emit every top-level key except `roles` in sorted key order when its stable JSON differs; then emit each `roles.<id>` in sorted id order when that effective entry differs, with the whole effective entry as the value. Do not call `changedConfigKeys` (its skip set and names-only shape are the live-reload event's contract).
- In src/cli/cli-config-commands.ts, add a `configDiff(root)` helper: `loadConfigSafe(root)`, `fail(error)` when it has no config (the same malformed-file surface the dump has), otherwise `sayJson(Object.fromEntries(nonDefaultConfigEntries(config)))`. Dispatch `--diff` in `cmdConfig` before the verbs, and fail CONFIG_USAGE when `--diff` carries any extra argument. Extend CONFIG_USAGE to `[get <key> | set <key> <value> | unset <key> | --diff]` and say `--diff` prints only the non-default settings.
- In src/cli.ts's `cmdConfigCase`, accept `--diff` only as the sole argument before the ready-repo gate, and keep the existing typo hint for other words; `--diff` with an extra token fails CONFIG_USAGE there as the defensive tail repeats it.
- src/cli/help.ts: add `| --diff` to the `tumwater config` usage line and one clause saying it prints only the resolved settings that differ from the built-in defaults, naming a changed role as `roles.<id>`. docs/cli.md's Configure row gets the same sentence.

**Files touched.** src/config/config.ts, src/cli/cli-config-commands.ts, src/cli.ts, src/cli/help.ts, docs/cli.md, test/cli-config-commands.test.ts, test/cli-operators-team.test.ts

**Acceptance criteria.**
- In an initialized repo whose `tumwater.json` holds `{}`, `tumwater config --diff` exits 0 and its entire stdout is the pretty-printed empty object `{}` — no default-valued key appears.
- With `{"maxConcurrent": 3, "sessionRetentionDays": 4, "roles": {"feature": {"enabled": false}}}`, `tumwater config --diff` parses to exactly `{"maxConcurrent": 3, "sessionRetentionDays": 4, "roles.feature": {"enabled": false}}`; `model`, `backend`, `maxDailyCostUsd` and unlisted roles are absent. `maxConcurrent` and `sessionRetentionDays` appear even though `changedConfigKeys` skips them, proving the new comparison does not borrow that skip set.
- A config that adds a custom role names `customRoles` and `roles.<custom>`, and a role removed from the file (which the overlay keeps) names nothing extra.
- `tumwater config --diff extra` exits nonzero, writes no JSON, and its stderr carries CONFIG_USAGE; `tumwater config --diff` outside an initialized repo still fails with the not-initialized ready-repo message.
- Bare `tumwater config` and `config get/set/unset` behave as before for the same config; only the two usage-line assertions in test/cli-operators-team.test.ts that quote CONFIG_USAGE are updated for the new spelling, and no other test is loosened.
- `tumwater help` still parses into one stanza per command with the new `--diff` clause; test/help.test.ts, test/cli-doc.test.ts and test/completion.test.ts pass, and `npm run test:gate` passes.

**Tests.** Add cases to test/cli-config-commands.test.ts driving `cmdConfig(root, ["--diff"])` in-process: the empty diff for defaults, the exact object above (covering the skip-set keys and a per-role entry named `roles.<id>`), a custom role naming both `customRoles` and `roles.<custom>`, a malformed `tumwater.json` failing with no JSON, and `cmdConfig(root, ["--diff", "extra"])` failing with CONFIG_USAGE. Add the end-to-end gate cases to test/cli-operators-team.test.ts: the updated help synopsis and `config --diff extra` failing with CONFIG_USAGE. Run test/cli-config-commands.test.ts, test/cli-operators-team.test.ts, test/help.test.ts, test/cli-doc.test.ts and test/completion.test.ts, then the project's gate.

### `tumwater salvage --drop <n>` removes the Nth kept workspace patch the list numbers, so an operator can clear a reviewed or unwanted patch without `rm` under `.tumwater/salvage/` (planned 2026-11-08 by the plan role; the salvage family's list, `--show <n>` and `--grep` are landed, and the doctor `salvage patches` row tells the operator to "apply or delete them under .tumwater/salvage/ before session retention prunes them", but no command deletes one — `grep -rn 'dropSalvage\|removeSalvage\|deleteSalvage\|salvage.*--drop\|salvage --delete' src docs test PLANS.md PLANS-DONE.md BUGS.md BUGS-FIXED.md` prints nothing before this entry; independent in file of every `## Planned` entry — no waiting entry names src/status/status-salvage.ts, src/cli/cli-salvage-command.ts, test/cli-salvage.test.ts or test/status-salvage.test.ts; only src/cli/help.ts and docs/cli.md are shared with the in-flight `config --diff` and `doctor --list-checks` plans, which edit different stanzas and rows, so whichever lands second rebases there; docs/invariants.md's INV-BQ5 binds the session-retention prune, not a command, so no invariant changes; touches src/status/status-salvage.ts src/cli/cli-salvage-command.ts src/cli/help.ts docs/cli.md test/cli-salvage.test.ts test/status-salvage.test.ts)

**Goal.** A kept patch under `.tumwater/salvage/` stays until session retention prunes it or the operator deletes the file by hand in a hidden directory. Add the missing destructive twin of `--show`: `tumwater salvage --drop <n>` deletes the Nth patch exactly as the list numbers it, leaving every other kept patch and everything under `pending/<role>/` untouched.

**Approach.**
- In src/status/status-salvage.ts, beside `readSalvagePatch`, add `export function dropSalvagePatch(root: string, file: string): boolean`: unlink `path.join(salvageDir(root), file)` and return true, or return false on a missing/unreadable/unremovable file rather than throwing. Like `readSalvagePatch`, it accepts only a file name `collectSalvagePatches` returned, so it never reaches `pending/<role>/` or another path.
- In src/cli/cli-salvage-command.ts, add a `cmdSalvageDrop` branch beside `cmdSalvageShow` and route it from `cmdSalvage` through the same `modeNamed("--drop")` guard (after the `--show` guard, so `--show` and `--drop` refuse each other through `rejectUnknownArgs`). Parse with `scanPositionArgs(args, "--drop", "--drop 2")`; a missing position fails with `--drop needs a position (usage: tumwater salvage --drop <n>)`; reject every remaining token; `refuseTeamWorkspace(root)`; collect the patches; an out-of-range position fails with the `--show` wording `no salvaged workspace patch at position <n> (salvage holds <n> patches)`; then drop the file and fail `could not drop salvaged patch <file>` if that returns false. Text output is `dropped salvaged workspace patch <n>: <file>`; `--json` is `{ "dropped": { "position": <n>, "file": "<file>" } }`.
- src/cli/help.ts: add `[--drop <n>]` to the `tumwater salvage` usage line and one clause saying it deletes the Nth patch the list numbers, leaving the rest and `pending/<role>/` alone. docs/cli.md's `Read a kept patch` row gets the same clause and synopsis.

**Files touched.** src/status/status-salvage.ts, src/cli/cli-salvage-command.ts, src/cli/help.ts, docs/cli.md, test/cli-salvage.test.ts, test/status-salvage.test.ts

**Acceptance criteria.**
- Given the two direct patches `a.patch` (older) and `b.patch` (newer) plus `pending/feature/x.patch`, `tumwater salvage --drop 2` exits 0, writes exactly `dropped salvaged workspace patch 2: b.patch`, deletes only `b.patch`, and leaves `a.patch`, `pending/feature/x.patch` and non-patch files in place; a following `tumwater salvage` lists only `a.patch` as position 1.
- `tumwater salvage --drop 2 --json` deletes the same patch and prints one JSON document that parses to exactly `{"dropped":{"position":2,"file":"b.patch"}}`.
- `tumwater salvage --drop 3` in that repo exits nonzero, names the position and the depth, and deletes nothing; `--drop` with no value, `0` or `abc` fails with the `--drop needs a position` / positive-integer wording and deletes nothing; with no salvage dir it fails `salvage holds 0 patches` and creates no directory.
- `tumwater salvage --drop 1 --grep x`, `--drop 1 --show 2`, `--drop 1 -f` and `--drop 1 --bogus` each exit nonzero, name the conflicting flag, and leave both patches in place; a `--grep --drop` pattern still filters the list as the text `--drop` rather than entering the drop mode.
- Existing `salvage`, `--json`, `--show` and `--grep` behaviour is unchanged, `tumwater help` still parses into one stanza per command with the new clause, and the new help text and docs row agree with the command's actual synopsis.

**Tests.** Add cases to test/cli-salvage.test.ts using the existing `seedSalvage` fixture: the text drop and remaining list, the `--json` drop object, the out-of-range/no-value/zero/non-integer refusals with bytes unchanged, the conflicting-flag refusals, and the empty-dir refusal that creates nothing. Add a `dropSalvagePatch` case to test/status-salvage.test.ts (direct patch removed, missing file returns false, pending patch untouched). Run test/cli-salvage.test.ts, test/status-salvage.test.ts, test/help.test.ts and test/cli-doc.test.ts, then the project's gate.

## Done
