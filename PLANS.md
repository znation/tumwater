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

### Subtract pin queue, part 1e/5: The merge pipeline test seeds pins (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large part 1a/3 after feature held it; requires Subtract pin queue part 1d/5 landed; sibling to parts 1f/5 and 1g/5, which require part 1d/5; touches test/merge-pipeline.test.ts)

**Goal.** test/merge-pipeline.test.ts drives every merge from a role's pin and never from a queue file.

**Approach.** Test edits only.
- Replace `queueChanges` with `pinChanges` and `drained(root, pipeline)` with `pinDrained(root, pipeline, roles)` (pass the roles the case drives).
- Remove the `enqueueMerge`, `queueDepth`, `queuedMergeFiles`, `entry`, `mergeQueueDir` and `dropMerge` imports and uses that existed only to seed or inspect queue files; assert a pin that survives through `refSha(root, mergeRefName(role))` and one that merged is `null`.
- Delete "a torn head is dropped with a warning and the healthy entry behind it merges"; its subject is the queue reader part 1b/3 removes. Keep the cases about pin gating, batching, batch write-back, head ordering, rejection and the throwaway author, rewritten to observe the pin.

**Files touched.** test/merge-pipeline.test.ts

**Acceptance criteria.**
- `grep -nE 'enqueueMerge|queueDepth|queuedMergeFiles|queueChanges|mergeQueueDir' test/merge-pipeline.test.ts` prints nothing.
- The torn-head case is gone; every remaining test still observes its old outcome through main, the merge ref, the in-flight marker or events.
- `npm run test:gate` passes.

**Tests.** Run test/merge-pipeline.test.ts, then the project's gate.

### Subtract pin queue, part 1f/5: The second merge pipeline test seeds pins (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large part 1a/3 after feature held it; requires Subtract pin queue part 1d/5 landed; sibling to parts 1e/5 and 1g/5, which require part 1d/5; touches test/merge-pipeline-2.test.ts)

**Goal.** test/merge-pipeline-2.test.ts starts every merge from a pin and keeps each case's abort, held-gate, conflict and settle outcome.

**Approach.** Test edits only.
- Replace every `queueChanges` with `pinChanges` and `drained` with `pinDrained(root, pipeline, roles)`.
- Replace `queueDepth(root) === N` and `queuedMergeFiles(root)` reads with the role pins: a waiting change's pin still resolves at `mergeRefName(role)`; a consumed pin is gone; the in-flight marker carries a started merge. Where a case writes an abort request or reads state paths, keep that mechanism unchanged.
- Delete only the queue-file manipulation that has no pin meaning (the queue-file loop that drops a role's files after a settle). Keep the abort, held-gate, retriable-outcome, plumbing-throw, state-write and slot-freeing cases.

**Files touched.** test/merge-pipeline-2.test.ts

**Acceptance criteria.**
- `grep -nE 'enqueueMerge|queueDepth|queuedMergeFiles|queueChanges' test/merge-pipeline-2.test.ts` prints nothing.
- Every case keeps its old observable outcome through main, the merge ref, the in-flight marker, the abort request or events; a change reported as staying queued instead reports its pin resolving.
- `npm run test:gate` passes.

**Tests.** Run test/merge-pipeline-2.test.ts, then the project's gate.

### Subtract pin queue, part 1g/5: The orchestrator merge driver resolves pins only (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large part 1a/3 after feature held it; requires Subtract pin queue part 1d/5 landed; sibling to parts 1e/5 and 1f/5, which require part 1d/5; touches test/fixtures/orchestrator-fixtures.ts test/orchestrator-merge-pin.test.ts)

**Goal.** The orchestrator fixture's `mergeHead` driver and its pin test reach a merge through the role's merge ref only; no queue head participates.

**Approach.** Test and fixture edits only.
- test/fixtures/orchestrator-fixtures.ts: in `mergeHead`, remove the `headMerge` branch, the `queuedMergeFiles` retry-drop loop and the queue-file leftover check; resolve the expected role's pin with `refSha(repo, mergeRefName(role))` and throw when absent; after the merge, require the pin is either gone (merged) or still present (retriable), as the outcome says. Remove the now-unused `dropMerge`, `headMerge`, `queueDepth`, `queuedMergeFiles` and `fs` imports; update the doc comment.
- test/orchestrator-merge-pin.test.ts: use `pinDrained`; delete the "a queued entry drains before a pin that has no queue file" case and its `enqueueMerge`/`entry` seeding; keep `queueDepth(root) === 0` only where it asserts no queue file was written. Remove imports the deleted case leaves unused.

**Files touched.** test/fixtures/orchestrator-fixtures.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- `grep -nE 'enqueueMerge|headMerge|queuedMergeFiles|dropMerge' test/orchestrator-merge-pin.test.ts test/fixtures/orchestrator-fixtures.ts` prints nothing.
- The queue-priority case is gone; a pin is still gated and merged, a stale pin deleted, a conflict-capped pin left, and a withdrawn claim's pin left.
- `npm run test:gate` passes.

**Tests.** Run test/orchestrator-merge-pin.test.ts, test/agent-commit-fold.test.ts, test/merge-slot.test.ts, test/runner-2.test.ts, test/runner-3.test.ts and test/runner-4.test.ts, then the project's gate.

### Subtract pin queue, part 1h/5: The queue-seeding fixture helper goes (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large part 1a/3 after feature held it; requires Subtract pin queue parts 1e/5, 1f/5 and 1g/5 landed; touches test/fixtures/merge-fixtures.ts test/fixtures/orchestrator-fixtures.ts)

**Goal.** No merge test in the drain, pipeline or orchestrator suites seeds a queue file; the fixture helper that did is gone.

**Approach.** Test and fixture edits only.
- test/fixtures/merge-fixtures.ts: delete `queueChanges` and the now-unused `enqueueMerge` import. Keep `entry` and `drained` — test/post-merge-review.test.ts still imports both to seed and await its own queue-entry cases — and update their doc comments to name that remaining caller.
- test/fixtures/orchestrator-fixtures.ts: remove any queue import or helper the part 1g/5 migration left unused.

**Files touched.** test/fixtures/merge-fixtures.ts test/fixtures/orchestrator-fixtures.ts

**Acceptance criteria.**
- `grep -rnE 'queueChanges|enqueueMerge' test/merge-drain.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/orchestrator-merge-pin.test.ts test/fixtures/merge-fixtures.ts test/fixtures/orchestrator-fixtures.ts` prints nothing.
- `grep -rn 'queueChanges' test` prints nothing.
- test/post-merge-review.test.ts still passes unchanged, and `npm run test:gate` passes.

**Tests.** Run test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/orchestrator-merge-pin.test.ts and test/post-merge-review.test.ts, then the project's gate.

### Subtract pin queue, part 1b/3: The merge drain merges pins, not queue files; the torn-head queue write goes (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large re-plan of the 2026-10-31 part 3f/7 after feature held it; requires Subtract pin queue part 1h/5 landed, the last fixture part that moves every merge test to pins; sibling to part 1c/3, which requires this part; touches src/merge/merge-drain.ts src/merge/merge-head.ts docs/how-it-works.md test/merge-drain.test.ts test/merge-queue.test.ts)

**Goal.** `drainMerge` starts a merge only for a runner whose merge ref resolves; a queue file in `.tumwater/merge-queue/` starts nothing and the torn-head repair module goes. The serial drain/pipeline/slot engine and the requeue path stay for part 1c/3; `src/merge/merge-queue.ts` stays because status and the doctor still read it until part 2/3.

**Approach.** Behavioural half only.
- src/merge/merge-drain.ts: remove the `dropTornHead` call, the `queuedMergeFiles` loop with its `notBefore`/already-merged dedupe and `dropMerge` warning, and the `queuedMergeRoles` skip; the drain begins at the existing kept-pin scan. Remove the imports those branches were the only users of (`dropTornHead`, `mergedIntoMain`, `branchHead`, `queuedMergeFiles`, `queuedMergeRoles`, `dropMerge`, and `fs`/`path`/`errorMessage` where the remaining code no longer uses them; `errorMessage`/`warnEventBestEffort` stay for startMerge's catch). Update the `drainMergeQueue`/`drainMerge` doc comments. The only `startMerge` call passes null for the queue file.
- Delete src/merge/merge-head.ts: `dropTornHead` loses its only caller and `mergedIntoMain` loses its only caller with the queue dedupe. Do not move either function.
- test/merge-queue.test.ts: delete the torn-head step and its `dropTornHead` import; keep the reader cases for part 2/3. test/merge-drain.test.ts: add the missing pin-only case that a queue file with no live merge ref starts no merge, and delete any remaining queue-head assertion parts 1d/5 through 1h/5 did not remove.
- docs/how-it-works.md: remove the sentences that promise a legacy queue file still merges (the "legacy input the same drain merges" note and the queue-head eligibility sentence); say the drain merges the oldest eligible pin and a queue file an older build left starts no merge.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-head.ts docs/how-it-works.md test/merge-drain.test.ts test/merge-queue.test.ts

**Acceptance criteria.**
- A role's merge ref with a queue file present merges through the pin path; a queue file with no resolvable merge ref starts no merge and logs no merge outcome.
- `grep -rn 'dropTornHead\|mergedIntoMain' src/ test/` prints nothing and `src/merge/merge-head.ts` is gone.
- `grep -rn 'queuedMergeFiles\|queuedMergeRoles' src/merge/` prints nothing outside src/merge/merge-queue.ts itself; status, scheduling and the doctor keep their readers for part 2/3.
- Every `startMerge` call from the drain passes null for the queue-file argument (or the parameter is removed and the compiler is clean).
- `grep -niE 'queue file.*(merge|drain)|legacy.*queue' docs/how-it-works.md` prints no claim that the drain reads a queue file; `npm run test:gate` passes.

**Tests.** Run test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/orchestrator-merge-pin.test.ts and test/merge-queue.test.ts, then the project's gate.

### Subtract pin queue, part 1c/3: A kept change is not re-queued; the requeue module and `entryRevisionFields` go (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large re-plan of the 2026-10-31 part 3f/7 after feature held it; requires Subtract pin queue part 1b/3 landed, so no drain caller passes a queue file; touches src/merge/merge-pipeline.ts src/merge/merge-drain.ts src/merge/merge-requeue.ts src/merge/merge-queue.ts test/merge-drain.test.ts test/merge-pipeline-2.test.ts test/merge-requeue.test.ts test/runner-revision.test.ts)

**Goal.** A change that fails its gate is an ordinary rejection owned by its author: the pipeline writes the outcome, drops the marker and leaves the pin for the role's next run, and no retry `merge_queued` event is logged. The requeue module and the pipeline's requeue branch go; `writeMergeOutcome`'s `file` parameter stays for part 3/3.

**Approach.**
- src/merge/merge-pipeline.ts: remove the `requeueKeptChange` import and the `file !== null && mainBranch !== undefined` requeue block; drop `mainBranch` from `settleMergeOutcome`'s signature and its doc comment. Keep the `file` parameter and every caller's null pass-through.
- src/merge/merge-drain.ts: drop the `mainBranch` argument from its `settleMergeOutcome` call; replace `...entryRevisionFields(entry)` in the merge request with the two explicit conditional spreads for `revisionRound` and `priorReview`, so the request keeps both fields.
- Delete src/merge/merge-requeue.ts; delete `entryRevisionFields` from src/merge/merge-queue.ts (its only production caller was the drain). Leave the rest of `merge-queue.ts` for part 2/3.
- Delete test/merge-requeue.test.ts. In test/merge-pipeline-2.test.ts retarget the retry/re-queue cases to the pin: a rejected or aborted kept change leaves its pin and logs no retry `merge_queued` event. Update the direct `settleMergeOutcome` callers in test/merge-drain.test.ts and test/runner-revision.test.ts to the shorter signature.

**Files touched.** src/merge/merge-pipeline.ts src/merge/merge-drain.ts src/merge/merge-requeue.ts src/merge/merge-queue.ts test/merge-drain.test.ts test/merge-pipeline-2.test.ts test/merge-requeue.test.ts test/runner-revision.test.ts

**Acceptance criteria.**
- `grep -rn 'requeueKeptChange\|merge-requeue\|entryRevisionFields' src/ test/` prints nothing and `src/merge/merge-requeue.ts` is gone.
- A gate rejection of a kept change leaves the role's pin in place, records the rejection in the author's state, and logs no retry `merge_queued` event; the author's next run is the retry.
- `settleMergeOutcome` has no `mainBranch` parameter and every caller compiles; a revision request still carries `revisionRound` and `priorReview` (test/runner-revision.test.ts passes).
- `npm run test:gate` passes.

**Tests.** Run test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/runner-revision.test.ts and test/merge-queue.test.ts, then the project's gate.

### Subtract pin queue, part 2/3: `status`, the doctor, `scope` and `once` read the live pin and in-flight marker instead of the queue directory (planned 2026-11-09 by the plan role, re-planning the 2026-10-31 part 3f/7 after feature showed the queue modules are live engine code, not dead state; requires Subtract pin queue part 1c/3 landed; sibling to part 3/3, which it enables and which deletes the then-unread queue module; touches src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor.ts src/orchestrator/orchestrator-poll.ts src/scheduling/scope.ts src/scheduling/once-round.ts src/run/run-stage.ts src/runner/runner-leftover.ts docs/how-it-works.md test/status-data.test.ts test/status-roles.test.ts test/doctor-checks.test.ts test/doctor-backlog.test.ts test/once-round.test.ts test/claims.test.ts test/run-stage.test.ts test/runner-leftover.test.ts)

**Goal.** Every queue-file read becomes a pin read. `tumwater status` lists each role whose merge ref resolves as a waiting change, built from the pin's commit trailers, while the in-flight marker still decides "merging"; the doctor's stale row ages pinned waits and its queue-file row goes; `once --once`, the scheduling scope and the run-stage checks read pins. The merge engine and the status payload's `mergeQueue` shape stay unchanged.

**Approach.**
- Add one shared pin-view reader beside the merge code, e.g. `src/merge/merge-pins.ts`: given `root` and role ids it returns `{ entries, unreadable }` in the old `readMergeQueue` shape by resolving each role's `mergeRefName(role)` with `refSha` and building `pinnedMergeEntry(root, role, sha)` (the same builder the drain uses); a role with no ref contributes nothing. Use the existing ref-file fast path (`refAbsentFromFiles`) where available so an absent pin costs no git spawn. This is the one home of "the waiting changes as a view" after this part.
- src/status/status-data.ts: replace `readMergeQueue(root)` with the pin view over `runnerIds(cfg)`; `queuedRoles` becomes the pin roles from that read and is passed to `collectRoleRows`; keep the `mergeQueue` payload fields (`depth`, `entries`, `inFlight`) so the TUI/dashboard render unchanged. src/status/status-roles.ts: drop the `queuedMergeRoles` default parameter (the caller now passes the pin set).
- src/orchestrator/orchestrator-poll.ts: `queuedMerges` in the `exitReady` call becomes the pin-view entry count, so `once --once` waits on a live pin instead of an empty queue directory.
- src/doctor/doctor-backlog.ts: `checkStaleQueuedMerges`/`staleQueuedMergeRows` read the pin view instead of `queuedMerges`; delete `checkMergeQueueFiles`/`skippedMergeQueueFiles`, and drop the `merge-queue files` row from src/doctor/doctor.ts and src/doctor/doctor-check-names.ts.
- src/scheduling/scope.ts: the `queuedMerges`/`queuedMergeRoles` calls become the pin view; reuse the pin scan already in `claimKeysByBase` so a role with a legacy queue file is not double-counted. src/run/run-stage.ts and src/runner/runner-leftover.ts: their `queuedMerges` checks become `hasUnmergedPin`/the pin view.
- docs/how-it-works.md: status and the doctor name pins, not queue files.

**Files touched.** src/merge/merge-pins.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor.ts src/orchestrator/orchestrator-poll.ts src/scheduling/scope.ts src/scheduling/once-round.ts src/run/run-stage.ts src/runner/runner-leftover.ts docs/how-it-works.md test/status-data.test.ts test/status-roles.test.ts test/doctor-checks.test.ts test/doctor-backlog.test.ts test/once-round.test.ts test/claims.test.ts test/run-stage.test.ts test/runner-leftover.test.ts

**Acceptance criteria.**
- With a role's merge ref present and no queue file, `tumwater status` and `status --json` list that role as a waiting change with its summary and run, and the doctor's stale row ages it; with no merge ref neither lists it.
- `grep -rn 'readMergeQueue\|queuedMergeFiles\|unreadableMergeQueueFiles' src/` finds no reader; `grep -n 'merge-queue files' src/doctor/doctor.ts src/doctor/doctor-check-names.ts` prints nothing.
- `once --once` treats any live merge pin as unsettled and exits only after that pin is merged or cleared.
- The status payload's `mergeQueue.depth`, `.entries` and `.inFlight` keep their meaning and the dashboard/TUI tests pass unchanged.
- `npm run test:gate` passes.

**Tests.** Update test/status-data.test.ts, test/status-roles.test.ts, test/doctor-checks.test.ts, test/doctor-backlog.test.ts, test/once-round.test.ts, test/claims.test.ts, test/run-stage.test.ts and test/runner-leftover.test.ts to seed pins instead of queue files; delete the queue-file-skip cases with the doctor row. Run those files and the gate.

### Subtract pin queue, part 3/3: The queue module, its paths and startup migration go; the entry types move to `merge-entry.ts` (planned 2026-11-09 by the plan role, re-planning the 2026-10-31 part 3f/7 after feature showed deleting the live engine would break the build; this part deletes only what part 2/3 made unread and re-points every live importer the original entry omitted; requires Subtract pin queue part 2/3 landed; touches src/merge/merge-queue.ts src/merge/merge-entry.ts src/merge/merge-core.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-withdrawn.ts src/runner/runner-leftover.ts src/run/run-apply.ts src/run/run-stage.ts src/review/review.ts src/git/commit-message.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/startup-migrations.test.ts test/commit-message.test.ts test/merge-slot.test.ts test/merge-drain.test.ts)

**Goal.** After part 2/3 nothing reads or writes a queue file, so delete `src/merge/merge-queue.ts` and keep only the entry and claim types and validators in a new `src/merge/merge-entry.ts`. The serial merge engine (`merge-drain.ts`, `merge-pipeline.ts`, `merge-slot.ts`) stays and imports the moved types.

**Approach.**
- Create src/merge/merge-entry.ts with `MergeEntry`, `PriorReview`, `isPriorReview` and `isMergeClaim` moved verbatim (their doc comments included). `MergeClaim` stays where it is defined, src/merge/merge-withdrawn.ts; the new module imports the type for `isMergeClaim`.
- Re-point every live importer of the moved names: src/merge/merge-core.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts, src/runner/runner-leftover.ts, src/run/run-apply.ts, src/run/run-stage.ts, src/review/review.ts and src/git/commit-message.ts (plus any test fixture). `src/config/config-schema.ts`'s doc comment that names merge-queue.ts is updated to name merge-entry.ts.
- Delete `mergeQueueDir` and `legacyLandQueueDir` from src/paths.ts; delete the `mergeQueueDir` startup-migration registration from src/orchestrator/startup-migration-steps.ts; delete the queue-file reader/writer and the migration from src/merge/merge-queue.ts with the module.
- Delete test/merge-queue.test.ts; move any coverage of the surviving validators to test/commit-message.test.ts if it is not already there. Update test/startup-migrations.test.ts to expect no mergeQueueDir step.
- docs/how-it-works.md: remove the `.tumwater/merge-queue/` directory and its migration; the pin and marker are the whole waiting state.

**Files touched.** src/merge/merge-entry.ts src/merge/merge-queue.ts src/merge/merge-core.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-withdrawn.ts src/runner/runner-leftover.ts src/run/run-apply.ts src/run/run-stage.ts src/review/review.ts src/git/commit-message.ts src/config/config-schema.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/startup-migrations.test.ts test/commit-message.test.ts test/merge-slot.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- `grep -rn 'merge-queue\|mergeQueue\|queuedMerge\|readMergeQueue\|enqueueMerge\|dropMerge\|mergeQueueDir\|legacyLandQueueDir' src/ docs/how-it-works.md` prints nothing (the archive files are excluded).
- Every moved type/validator import resolves from `src/merge/merge-entry.ts`; the compiler and the exports check are clean.
- The startup migration list carries no mergeQueueDir step, and `test/startup-migrations.test.ts` passes.
- The drain, pipeline and slot still merge a pin and write the in-flight marker exactly as after part 2/3.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-queue.test.ts; update test/startup-migrations.test.ts, test/commit-message.test.ts, test/merge-slot.test.ts and test/merge-drain.test.ts only where they import or seed the deleted module. Run those files and the gate.

### Subtract, part 3g/7: Docs and invariants say one lock, linear history and a post-landing check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract pin queue part 3/3 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts)

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

### `tumwater reviews --json`'s `pending` rows carry the whole-queue `position` the list prints and `reviews --show <n>`/`--accept <n>` address, so a script can read an entry and act on it without counting the array itself (planned 2026-11-09 by the plan role; `cmdReviews` in src/cli/cli-review-commands.ts hands `sayJsonOrRender` the raw `{ pending: entries }` while `renderPostReviews` numbers the same entries with `scope ? scope.positions[i] : i + 1`, and `cmdReviewsShow` prints the raw entry object, so a filtered `--json` read keeps only the kept entries but gives a script no way to learn each one's whole-queue number; before this entry `grep -n 'reviews --json' PLANS.md` prints nothing and `grep -nE 'position.*review|review.*position' PLANS.md` prints nothing, while PLANS-DONE.md's `--grep` and `--show` entries add positions only to the rendered text and leave the JSON `{ pending: [...] }` raw, and test/cli-reviews.test.ts's show-json test pins `reviews --show <n> --json` deep-equal to a `pending` row; independent in files of every `## Planned` entry — the pin-queue parts touch test fixtures, merge/status pin reads and the orchestrator, and the in-flight salvage plans touch src/status, src/git, src/cli/cli-salvage-command.ts and the salvage stanza of src/cli/help.ts and docs/cli.md, never src/cli/cli-review-commands.ts or the reviews stanza; touches src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/cli-reviews.test.ts)

**Goal.** `tumwater reviews --json` is the scriptable twin of the list, but its `pending` rows omit the number every operator-facing view prints: the text list numbers each entry by its whole-queue position, and `reviews --show <n>`/`--accept <n>` act on that number. Give each `--json` row the same `position`, including rows kept by `--role`, `--status` or `--grep`, and give `reviews --show <n> --json` the same field so the two JSON objects stay the same shape.

**Approach.**
- src/cli/cli-review-commands.ts: in `cmdReviews`, after `readScoped`, build the JSON payload from the kept entries as `{ position, ...entry }`, where `position` is `scope ? scope.positions[i] : i + 1`; pass that payload to `sayJsonOrRender` and keep the raw `entries` and `scope` for `renderPostReviews`, so the text output is unchanged. In `cmdReviewsShow`, `sayJson({ position, ...entry })` when `--json`, using the validated requested position. Leave the `--accept --json` `accepted` object as it is.
- src/cli/help.ts and docs/cli.md: in the `tumwater reviews` `--json` clause, say each `pending` row carries `position`, the same 1-based whole-queue number the list prints and `--show <n>`/`--accept <n>` address, kept even when a filter narrows the list; in the `reviews --show` `--json` clause, name the field too.

**Files touched.** src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/cli-reviews.test.ts

**Acceptance criteria.**
- With two seeded entries, `tumwater reviews --json` prints `{ pending: [...] }` whose rows carry `position` 1 and 2 in FIFO order alongside the role, commit, summary and every other field they carry today.
- `tumwater reviews --json --role clean` (the second entry), `--json --status rejected` (the second entry) and `--json --grep <text present only in the second entry>` each print exactly that one row with `position` 2, never a renumbered 1; the unscoped first row is 1.
- `tumwater reviews --show 2 --json` prints an object deep-equal to the second row of the unscoped `tumwater reviews --json`, including `position: 2`; the text output of `reviews`, `reviews --role`, `reviews --status`, `reviews --grep`, `reviews --show` and `reviews --accept` and the `--accept --json` object are unchanged.
- The `post-review.json` bytes are unchanged after every read above.
- `tumwater help reviews` and docs/cli.md name `position` in the `--json` row shape.
- `npm run test:gate` passes.

**Tests.** test/cli-reviews.test.ts: extend `reviews --json prints the normalized pending list` to assert positions 1 and 2; extend the `--role clean`, `--status rejected` and `--grep` JSON assertions to assert the kept row keeps position 2; extend `reviews --show <n> --json prints the same normalized entry the list's pending array carries` to keep the deep-equal assertion with `position: 2`. Work every expected position from the seeded FIFO order and the filter, not from the command's output; if the filtered row comes back as 1, the payload renumbered the kept array instead of reading `scope.positions`. Run test/cli-reviews.test.ts, test/post-merge-review-render.test.ts and test/cli-doc.test.ts, then the project's gate.

### `tumwater backlog --json` rows carry the `position` each entry's own `plan|bug|questions` command prints and addresses, so a script can act on a filtered row without recounting the unfiltered arrays (planned 2026-11-09 by the plan role; `backlogPayload` in src/backlog/backlog.ts returns the three sections as `{title, body}` entries and `cmdBacklog` in src/cli/cli-query-commands.ts prints that payload with `holds`/`inProgress` for `--json`, while the entry lists themselves already carry the number their verbs take — `plan --list --json`/`bug --list --json` rows carry `position`, `questions --json` rows carry `position`, and `plan|bug --show/--cancel <n>` and `questions answer <n>` address those numbers; the combined view's `--ready`, `--held` and `--grep` rebuild the entry arrays through `readyBacklog`/`heldBacklog`/`grepBacklog`, so a kept row's index becomes its only positional clue and the filters' promise of "each under its unfiltered numbers" is unrecoverable from the JSON; `grep -nE 'backlog --json|backlog.*position|position.*backlog' PLANS.md BUGS.md` prints nothing, and PLANS-DONE.md has no heading adding positions to the combined backlog payload — its position headings are the per-list `plan|bug --list`, `salvage`, `reviews`, `quarantine`, `questions` and `prompt` entries; the <pending-plans> entries add none, the pin-queue parts touch test fixtures and merge/status pin reads, the in-flight reviews and wake plans touch src/cli/cli-review-commands.ts, src/operator/operator-intent.ts and their own help/docs stanzas, and this touches only the backlog payload renderer, the backlog command and the backlog stanza; touches src/backlog/backlog-render.ts src/cli/cli-query-commands.ts src/cli/help.ts docs/cli.md test/backlog-render.test.ts)

**Goal.** `tumwater backlog --json` is the dashboard's machine-readable backlog, but its rows carry no number. The entry's own command numbers it — `plan --list`, `bug --list` and `questions` all print a 1-based position, and `plan|bug --show <n>`/`--cancel <n>` and `questions answer <n>` take that number. Give every combined `--json` row the same `position` (in file order within its section), and keep each row's unfiltered position through `--ready`, `--held` and `--grep`, so a script can read a filtered row and act on it without re-reading or recounting the unfiltered arrays.

**Approach.**
- src/backlog/backlog-render.ts: make `BacklogView` generic over its entry type and export it, so `readyBacklog`, `heldBacklog` and `grepBacklog` return the same entry type they receive (their `pickByIndex` already keeps the objects, so positions added before filtering survive at runtime). Add `positionBacklog(view)`, which maps each of `plans`, `bugs` and `questions` to `{ position: i + 1, ...entry }` and leaves `holds`/`inProgress` parallel to the arrays. Leave `backlogPayload` in src/backlog/backlog.ts returning `{title, body}` entries, so the GUI's `/api/backlog` payload and the shared payload shape do not change.
- src/cli/cli-query-commands.ts: in `cmdBacklog`'s `readBacklog`, build the view as `positionBacklog({ ...backlogPayload(root), holds: backlogHolds(root), inProgress: backlogInProgress(root) })` before applying `--grep` and then `--ready`/`--held`, so the numbered rows are the unfiltered ones and each filter keeps its survivors' numbers. The `--json` branch prints that view unchanged; `renderBacklogMarkdown` ignores the extra field, so the text output is byte-identical.
- src/cli/help.ts and docs/cli.md: in the `tumwater backlog` stanza, say `--json` prints the three entry arrays with each row's `position`, `title` and `body`, that `position` is the same 1-based number the entry's own list prints and `plan|bug --show/--cancel <n>` or `questions answer <n>` takes, and that `--ready`, `--held` and `--grep` keep each kept row's unfiltered position (replacing the current "each under its unfiltered numbers" wording that no text row shows).

**Files touched.** src/backlog/backlog-render.ts src/cli/cli-query-commands.ts src/cli/help.ts docs/cli.md test/backlog-render.test.ts

**Acceptance criteria.**
- With two open plans, two open bugs and two open questions, `tumwater backlog --json` prints `plans`, `bugs` and `questions` rows whose `position` is 1 and 2 in each section's file order, beside the existing `title` and `body`; each number equals the one `tumwater plan --list`, `tumwater bug --list` and `tumwater questions` print for that entry, and `plan --show 2`/`bug --show 2`/`questions --show 2` print the same entry.
- `tumwater backlog --json --grep <text only the second plan matches>` prints that plan as position 2, never renumbered 1; `--ready` with the first plan held prints the second plan as position 2 and its `holds.plans` as a one-element array parallel to it; `--held` prints the held first plan as position 1 and preserves the filtered `holds`; questions keep their unfiltered positions through `--grep`.
- The text output of `tumwater backlog`, `--ready`, `--held`, `--grep` and `-f` is unchanged, including the holds/in-progress marks and the hidden-count line, and the GUI's `/api/backlog` payload still carries `{title, body}` entries.
- `tumwater help backlog` and docs/cli.md name `position` in the `--json` row shape and state that filters keep the unfiltered number.
- `npm run test:gate` passes.

**Tests.** test/backlog-render.test.ts: extend `tumwater backlog --json prints the three entry arrays the Markdown view renders` to expect `position: 1`/`2` on the plans and bugs it deep-equals (the empty bare-root object gains no rows); extend `tumwater backlog --ready hides held entries and counts them` to assert the kept ready plan's `position` is 2 and the held plan is absent; extend `tumwater backlog --grep keeps only matching entries and composes with --ready and --json` to assert the matching second plan keeps position 2 and the matching second bug keeps position 2. Add a pure case seeding three plans with a hold on the first and asserting `positionBacklog` numbers 1–3 before filtering and `grepBacklog`/`readyBacklog`/`heldBacklog` keep the kept objects' positions. Work each expected position from the fixture order and the filter, not from the command's output; a payload that renumbers the filtered array gives the kept second plan 1, so that assertion is the off-by-one guard. Run test/backlog-render.test.ts, test/backlog-write-list.test.ts and test/cli-doc.test.ts, then the project's gate.

## Done
