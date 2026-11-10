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

**Goal.** test/merge-pipeline.test.ts drives every merge from a role's pin and never from a queue file, and keeps `resolveAuthor`'s throwaway-author fallback covered directly rather than through a queue seed.

**Approach.** Test edits only.
- Replace `queueChanges` with `pinChanges` and `drained(root, pipeline)` with `pinDrained(root, pipeline, roles)` (pass the roles the case drives).
- Remove the `enqueueMerge`, `queueDepth`, `queuedMergeFiles`, `entry`, `mergeQueueDir` and `dropMerge` imports and uses that existed only to seed or inspect queue files; assert a pin that survives through `refSha(root, mergeRefName(role))` and one that merged is `null`.
- Delete "a torn head is dropped with a warning and the healthy entry behind it merges"; its subject is the queue reader part 1b/3 removes.
- Delete the queue-seeded "a merge whose role has no live runner verifies and merges through a throwaway author" case. It cannot become pin-only: `drainMerge`'s kept-pin scan walks `ctx.runners`, so a pin for a runner-less role is never discovered, and only the queue file reached `resolveAuthor`'s fallback. Do not keep it by seeding a queue file.
- Keep the fallback covered directly in this file instead: import `resolveAuthor` from src/merge/merge-author.ts and add a case over `makePipeline(root, [])` asserting `resolveAuthor(ctx, "alpha")` returns a `RoleRunner` for `alpha`, and over `makePipeline(root, runnersFor(root, ["alpha"]))` asserting it returns that live runner instance. No merge runs and no queue file is written.
- Keep the cases about pin gating, batching, batch write-back, head ordering and rejection, rewritten to observe the pin.

**Files touched.** test/merge-pipeline.test.ts

**Acceptance criteria.**
- `grep -nE 'enqueueMerge|queueDepth|queuedMergeFiles|queueChanges|mergeQueueDir' test/merge-pipeline.test.ts` prints nothing.
- The torn-head case and the queue-seeded runner-less merge case are gone; no case in the file seeds a queue file, and every remaining merge case observes its old outcome through main, the merge ref, the in-flight marker or events.
- With an empty `ctx.runners`, `resolveAuthor(ctx, role)` returns a runner for that role; with that role's live runner present it returns the same instance.
- `npm run test:gate` passes.

**Tests.** Run test/merge-pipeline.test.ts, then the project's gate.

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

### `tumwater wake --json` acknowledges an immediate or scheduled wake and a bare or positional `--cancel` as data, so a script can schedule and drop wakes without parsing prose (planned 2026-11-09 by the plan role; `cmdWake` in src/operator/operator-commands.ts accepts `--json` only with `--list` and refuses every mutating form, while the marker cores it calls — `requestWake`, `cancelWakes` and `cancelWakeAt` in src/operator/operator-intent.ts — return only prose; PLANS-DONE.md's wake headings add `--list --json` with `position`, the positional `--cancel <n>`, the comma `--role` list and the disabled-role note, but `grep -nE '^### .*wake.*(--json|JSON)' PLANS-DONE.md` matches no mutating acknowledgement, and `grep -n 'wake --json' PLANS.md BUGS.md` prints nothing before this entry; the in-flight control-commands plan edits `cmdPause`/`cmdResume`/`cmdAbort`/`cmdStop`/`cmdRestart` in the same file plus their help/docs stanzas and the `valid flags` assertions, never `cmdWake`, the wake cores or `test/operator-intent.test.ts`; the pending part 1e/5 edit touches only the pin-queue plan; this shares src/cli/help.ts and docs/cli.md with that in-flight plan in the wake stanza/row, a rebase; touches src/operator/operator-intent.ts src/operator/operator-commands.ts src/cli/help.ts docs/cli.md test/cli-operators.test.ts test/operator-commands.test.ts test/operator-intent.test.ts)

**Goal.** `tumwater wake`'s three mutating forms — immediate, `--in <duration>`, and `--cancel [<n>]` — each take `--json` and print one acknowledgement object instead of their prose line: what was requested or scheduled, or what was dropped. `wake --list --json`, every text reply, and every refusal keep their current output; a refused command exits 1 with its existing stderr wording and prints no JSON.

**Approach.**
- src/operator/operator-intent.ts: keep the existing string-returning `requestWake`, `cancelWakes` and `cancelWakeAt` as wrappers (the GUI, TUI and backlog callers keep printing their wording) and add `requestWakeOutcome`, `cancelWakesOutcome` and `cancelWakeAtOutcome`, each returning `{ message, payload }` from the same reads. `requestWakeOutcome` uses its existing single `now`, `markerApplyNote` and `disabledOf` read; its immediate payload is `{command:"wake",status:"requested",roles,live,disabled}` and its scheduled one adds `inMs` and `atMs: now + inMs`. `cancelWakesOutcome` carries `{command:"wake",status:"cancelled"|"no_scheduled_wake",count}` plus `roles` when the call was role-scoped. `cancelWakeAtOutcome` carries `{command:"wake",status:"cancelled",position,wakeRoles,atMs,pending}` on a hit and `{command:"wake",status:"not_found",position,pending}` on a miss, plus `roles` when scoped; `wakeRoles` is the removed wake's own role list, kept distinct from the `roles` target scope.
- src/operator/operator-commands.ts: in `cmdWake`, delete the `wake --json requires --list` refusal, keep the existing `--list` branch, and route each mutating branch through its outcome function — `sayJson(payload)` with `--json`, `say(message)` without it. The `--list`/`--in`/`--cancel` rival refusals and the `--cancel`-with-`--in` refusal stay before any write; a malformed `--in` or position still fails before its marker work.
- src/cli/help.ts: change the wake usage line to `[--in <dur> [--json] | --cancel [<n>] [--json] | --list [--json]]` and describe the acknowledgement fields and statuses in its stanza. docs/cli.md's Control-the-roles wake clause gains the same `--json` forms and payload shapes beside the existing `--list --json` sentence.

**Files touched.** src/operator/operator-intent.ts src/operator/operator-commands.ts src/cli/help.ts docs/cli.md test/cli-operators.test.ts test/operator-commands.test.ts test/operator-intent.test.ts

**Acceptance criteria.**
- `tumwater wake --role qa --json` in a repo with no live team exits 0 and prints exactly one JSON object with `command:"wake"`, `status:"requested"`, `roles:["qa"]`, `live:false` and `disabled:[]`; it writes the immediate `wake.json` marker with roles `["qa"]` and no `notBeforeMs`.
- `tumwater wake --role feature,qa --in 45m --json` exits 0 and prints one object with `status:"scheduled"`, `roles:["feature","qa"]`, `inMs:2700000`, `live:false` and `disabled:[]`; its `atMs` equals the one scheduled marker's `notBeforeMs` and lies at least 44 minutes ahead.
- After wakes for `qa` and `feature`, `tumwater wake --cancel --json` prints `{command:"wake",status:"cancelled",count:2}` and removes both markers without writing an immediate one; a repeat prints `status:"no_scheduled_wake"` with `count:0`; `--cancel --role qa --json` adds `roles:["qa"]` and drops only that share.
- With wakes `qa` (in 45m), `feature,qa` (in 2h) and `clean` (in 3h), `tumwater wake --cancel 2 --json` prints `status:"cancelled"`, `position:2`, `wakeRoles:["feature","qa"]`, `atMs` equal to that marker's `notBeforeMs`, and `pending:1`, removing only that file; `--cancel 1 --role qa --json` addresses the scoped list; `--cancel 5 --json` prints `status:"not_found"`, `position:5`, `pending:1` and no `wakeRoles`/`atMs`, removing nothing.
- `wake --list --json` still prints its `{position, roles, atMs}` rows, and every text form prints exactly what it prints today.
- `wake --list --in 5m`, `wake --list --cancel`, `wake --cancel --in 5m`, a malformed `--in`, `--cancel 0` and `--cancel x`, and an unknown role each exit 1 with the existing wording and print no JSON.
- `tumwater help wake` and docs/cli.md show `[--json]` on the immediate, `--in` and `--cancel` forms with the fields and statuses above.
- `npm run test:gate` passes.

**Tests.** test/operator-intent.test.ts: add outcome cases deriving `roles`, `inMs`, `atMs`, `count`, `position`, `wakeRoles` and `pending` from the seeded markers (assert the scheduled payload's `atMs` equals the marker's `notBeforeMs` and a miss leaves the files untouched), and keep the existing string-wrapper cases. test/cli-operators.test.ts: replace the two `wake --json requires --list` assertions with the new immediate, scheduled, bare/positional cancel and miss cases; a `status`/field assertion that read the prose would fail if a JSON branch replaced the text `say`, so assert the parsed object, the marker files and the unchanged text separately. test/operator-commands.test.ts: add in-process `cmdWake --json` cases for immediate, scheduled, cancel-all and positional cancel, parsing stdout and checking the marker writes. Run test/operator-intent.test.ts, test/operator-commands.test.ts, test/cli-operators.test.ts, test/help.test.ts and test/cli-doc.test.ts, then the project's gate.

## Done
