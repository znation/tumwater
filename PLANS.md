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

### Subtract pin queue, part 1a/3: The merge test fixtures seed pins, not queue files (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large re-plan of the 2026-10-31 part 3f/7 after feature held it; requires Subtract part 3i/7 and Subtract part 3j/7 landed; sibling to parts 1b/3 and 1c/3, which require this part; touches test/fixtures/merge-fixtures.ts test/fixtures/orchestrator-fixtures.ts test/merge-drain.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/orchestrator-merge-pin.test.ts)

**Goal.** No merge-drain, merge-pipeline or orchestrator test depends on a queue file to start a merge: each fixture seeds the role's merge ref, the drain is driven from that pin, and the assertions read the pin and marker rather than queue depth. This is the preparatory half of the split so the queue-file path can be deleted in part 1b/3 without rewriting test intent; production `src/` does not change here.

**Approach.** Test and fixture edits only.
- test/fixtures/merge-fixtures.ts: `queueChanges` sets each role's `mergeRefName` and no longer calls `enqueueMerge` (keep its name and call sites, or rename to `pinChanges` in the same edit if the compiler is updated); update its doc comment. `drained(root, p)` becomes true when every runner's merge ref no longer resolves and no merge task remains, instead of `queueDepth(root) === 0`. Remove the now-unused `entry` helper unless another test still imports it.
- test/fixtures/orchestrator-fixtures.ts: `mergeHead` resolves the expected role's pin and drives the drain through it; remove the `headMerge` queue-head branch, the queue-file drop loop and the queue-depth check, and assert the pin is gone after a `changed` merge and present after a retriable one.
- test/merge-drain.test.ts: delete the cases whose subject is the queue-file path (torn head, a queued entry already on main, dedupe-cache eviction); keep the pin scan, single-flight, post-landing review and null-file settle cases.
- test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts and test/orchestrator-merge-pin.test.ts: replace `queueDepth`/`queuedMergeFiles`/`headMerge` assertions with `refSha(root, mergeRefName(role))` assertions; delete the torn-head case and the "a queued entry drains before a pin" case, whose subject is queue priority and has no pin-only meaning; a case that says an entry stays queued says the role's pin stays.
- test/merge-queue.test.ts keeps the queue module's own unit coverage; it is not a drain test.

**Files touched.** test/fixtures/merge-fixtures.ts test/fixtures/orchestrator-fixtures.ts test/merge-drain.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- `grep -rn 'enqueueMerge' test/merge-drain.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/orchestrator-merge-pin.test.ts test/fixtures/merge-fixtures.ts test/fixtures/orchestrator-fixtures.ts` prints nothing.
- `drained(root, pipeline)()` is false while any runner's merge ref resolves even with no queue file present, and true after the pin clears and its task settles.
- Every touched case keeps its observable outcome through the pin: a merged change clears its merge ref and the in-flight marker; a rejected or plumbing-throw change keeps its merge ref and records its error.
- `git diff --stat -- src/` shows no production change, and `npm run test:gate` passes.

**Tests.** Run test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/orchestrator-merge-pin.test.ts and test/merge-queue.test.ts, then the project's gate.

### Subtract pin queue, part 1b/3: The merge drain merges pins, not queue files; the torn-head queue write goes (planned 2026-11-09 by the plan role, splitting the 2026-11-09 too-large re-plan of the 2026-10-31 part 3f/7 after feature held it; requires Subtract pin queue part 1a/3 landed, which moves every merge test to pins; sibling to part 1c/3, which requires this part; touches src/merge/merge-drain.ts src/merge/merge-head.ts docs/how-it-works.md test/merge-drain.test.ts test/merge-queue.test.ts)

**Goal.** `drainMerge` starts a merge only for a runner whose merge ref resolves; a queue file in `.tumwater/merge-queue/` starts nothing and the torn-head repair module goes. The serial drain/pipeline/slot engine and the requeue path stay for part 1c/3; `src/merge/merge-queue.ts` stays because status and the doctor still read it until part 2/3.

**Approach.** Behavioural half only.
- src/merge/merge-drain.ts: remove the `dropTornHead` call, the `queuedMergeFiles` loop with its `notBefore`/already-merged dedupe and `dropMerge` warning, and the `queuedMergeRoles` skip; the drain begins at the existing kept-pin scan. Remove the imports those branches were the only users of (`dropTornHead`, `mergedIntoMain`, `branchHead`, `queuedMergeFiles`, `queuedMergeRoles`, `dropMerge`, and `fs`/`path`/`errorMessage` where the remaining code no longer uses them; `errorMessage`/`warnEventBestEffort` stay for startMerge's catch). Update the `drainMergeQueue`/`drainMerge` doc comments. The only `startMerge` call passes null for the queue file.
- Delete src/merge/merge-head.ts: `dropTornHead` loses its only caller and `mergedIntoMain` loses its only caller with the queue dedupe. Do not move either function.
- test/merge-queue.test.ts: delete the torn-head step and its `dropTornHead` import; keep the reader cases for part 2/3. test/merge-drain.test.ts: add the missing pin-only case that a queue file with no live merge ref starts no merge, and delete any remaining queue-head assertion part 1a/3 did not remove.
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

### `parseListArgs`'s complexity-14 flat flag scan in src/cli/backlog-cli-view.ts is split into one ordered boolean-flag table and two named value-flag parsers — the `--grep` text claim and the `-n` count claim — so "which boolean list flags does `plan|bug --list` accept, under which spelling, and what label does a repeat refusal name?" is read from one table while "how does `--grep` take its text, and how does `-n` parse and bound its count?" are read from names, instead of an eleven-branch `arg ===` chain (planned 2026-11-09 by the plan role; finishes the file's flag scan the landed 2026-11-09 `listAndAnnounce` split deliberately left alone — eslint's one-shot (`../../../node_modules/.bin/eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/cli/backlog-cli-view.ts`) reports `parseListArgs` at 14, the file's highest remaining body, while no other body is above 11 and that split's own provenance records "`parseListArgs` stays at 14 because it is out of scope"; the scan has grown by one inline repeat-guarded branch per flag since it was extracted, the 2026-11-08 `--held` stop and the 2026-11-03 `-f/--follow` arm among them, so this splits the stage those flags kept extending rather than re-splitting a small helper; `grep -n 'parseListArgs' PLANS.md BUGS.md` prints nothing before this entry, and PLANS-DONE.md's three `parseListArgs` mentions are the 2026-11-09 `listAndAnnounce` split (which records that a 2026-10-25 split extracted it), the 2026-11-08 `--grep --show` behavior fix and the 2026-11-03 follow feature, never a split of its body (`grep -cE '^### .*parseListArgs' PLANS-DONE.md` prints 3); independent in file of every `## Planned` entry — no waiting heading or touches list names src/cli/backlog-cli-view.ts (the Subtract and pin-queue parts take src/merge, src/runner, src/status, src/doctor, src/config, src/events, src/scheduling, src/cli/help.ts and docs, and the tree splits take src/ui/status-render.ts, src/ui/status-payload.ts, src/ui/tui/tui-pane-ctx.ts, src/ui/tui/tui-editors.ts and src/cli/cli-doctor-command.ts), so this entry's file is free; docs/invariants.md names no symbol or path of this file (`grep -c 'backlog-cli-view\|parseListArgs' docs/invariants.md` prints 0), and the move is behavior-preserving, so no invariant edit is needed; touches src/cli/backlog-cli-view.ts)

**Goal.** `parseListArgs` (src/cli/backlog-cli-view.ts) is the `--list` flag scanner: one loop with a separate inline branch for each accepted spelling, each branch repeating the same shape — a repeat guard, a value parse or a boolean assignment, then `continue`. A reader asking which boolean flags the list accepts, or how `--grep` and `-n` claim and validate their values, must scan every branch and diff them by eye. Make the boolean vocabulary one ordered table and lift the two value claims into named helpers, leaving `parseListArgs` as the same left-to-right scan over the same tokens with no accepted spelling, refusal text, exit code or parsed value changed.

**Approach.** All edits in src/cli/backlog-cli-view.ts; move the existing expressions and comments verbatim, change only indentation, and add no import.
- Add a module-private `LIST_BOOLEAN_FLAGS` ordered table above `parseListArgs`, one entry each for `--done`, `--ready`, `--held`, `--list`, `--json` and `-f`/`--follow`, in that order, each carrying its accepted spellings (`FOLLOW_FLAG.names` for the follow entry), its repeat-refusal label (`--done`, `--ready`, `--held`, `--list`, `--json`, `-f/--follow`) and the `ListArgs` key it sets.
- Add `function parseGrepArg(args: string[], i: number, parsed: ListArgs): number`: the current `--grep` branch, including the repeat guard, the `args[++i]` claim, the empty-or-missing `fail` wording and the assignment, returning the index of the consumed value so the loop continues after it.
- Add `function parseCountArg(args: string[], i: number, parsed: ListArgs): number`: the current `-n` branch, including its repeat guard and its existing `parseCountFlag("-n", …)` call and bound, returning the consumed value's index.
- Rewrite the loop body to: `if (arg === "--grep") { i = parseGrepArg(args, i, parsed); continue; }`, then the same for `-n` and `parseCountArg`, then one table look-up that runs `rejectRepeatFlag` with the entry's label and sets its key, then the unchanged `--help`/`-h` skip, then `parsed.rest.push(arg)`. Keep the flag scan's left-to-right order, so a value token claimed by `--grep` or `-n` is never read as a flag.
- Keep the function's signature and doc comment, and do not change `ListArgs`, `rejectRepeatFlag`, `parseCountFlag`, `FOLLOW_FLAG`, `listAndAnnounce` or any renderer in this file.

**Files touched.** src/cli/backlog-cli-view.ts

**Acceptance criteria.**
- Every `tumwater plan --list` and `tumwater bug --list` form behaves exactly as today: the same flags are accepted with the same spellings, each repeat still exits 1 with today's refusal wording, `--grep` with missing or empty text and `-n` with a bad count still refuse with today's wording, `--help`/`-h` are still tolerated, and `--list --grep -f` still greps the literal `-f` rather than enabling follow — the parsed `ListArgs` fields and `rest` are unchanged for every input.
- The per-boolean `arg ===` chain is gone: `grep -nE 'arg === "(--done|--ready|--held|--list|--json)"' src/cli/backlog-cli-view.ts` prints nothing, and the six boolean flags are declared once in `LIST_BOOLEAN_FLAGS`.
- The complexity one-shot reports `parseListArgs` below 10 (14 today), each new helper at 10 or below, and `listAndAnnounce` and every other body at no higher count than today; each new helper exists once at module scope and is not exported.
- The exported surface is unchanged: `grep -nE '^export ' src/cli/backlog-cli-view.ts` prints the same declarations before and after, and no import is added or removed.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behaviour-preserving. test/backlog-write-list.test.ts drives `plan|bug --list` through `--ready`, `--held`, `--json`, `--done`, `--grep`, `-n`, the empty and no-match lines and the refusals; test/cli-backlog-list-follow.test.ts pins each follow frame, the `-f --json` refusal and the parent-exit stop; test/backlog-age.test.ts pins the active list's dated age suffix and the `--json` `since`/`ageDays` fields. Run those three files, then the project's gate. If a flag is accepted or refused differently, a table entry took the wrong spelling, label or key; restore the original branch's guard and wording, do not edit the test.

### `runTui`'s complexity-13 startup/exit wiring and frame composer in src/ui/tui/tui.tsx are split into three named module-private helpers — the reload/supervisor/abort exit control, the per-frame composition, and the prompt-line mode mapping — so "how does a reload, a dead supervisor, or a hosted run's abort end the TUI, and when does it re-exec?", "how is one frame composed from the snapshot, the keys state and the pane body?" and "which editor flags form the footer hint and prompt prefix?" are each read from a name instead of one 90-code-line function holding the watch setup, a 38-line `render` closure and a 30-field inline mode literal (planned 2026-11-09 by the plan role; continues the landed split-large-function family — the metrics one-shot (`node docs/code-metrics/analyze.cjs . <out> docs/code-metrics/categories-tumwater.cjs`) reports `runTui` at complexity 13 over 90 code lines while its nested `render` arrow is complexity 7 over 38, and the just-landed 2026-11-09 `render` split lifted only `paneForView` and `directorRunInFlight` out of that arrow, deliberately leaving the rest of `render` and all of `runTui`'s watch/teardown wiring in place (`grep -cE '^### .*runTui' PLANS-DONE.md` prints 0 for a split of this body; its `runTui` headings are the `render` split, the extraction of the key handler and the `run --tui` hosting feature, never a split of the function shell), so this splits the shell that split left rather than re-splitting either helper it created; `grep -n 'runTui\|tui\.tsx' PLANS.md BUGS.md` prints nothing before this entry, and the <pending-plans> blocks add no entry naming this file (the pending `parseListArgs` plan takes src/cli/backlog-cli-view.ts and the feature-2 change takes src/ui/tui/tui-pane-ctx.ts, src/ui/tui/tui-editors.ts and test/tui-keys.test.ts); independent in file of every `## Planned` entry — the Subtract parts take src/merge, src/runner, src/status, src/doctor, src/config, src/events, src/scheduling, src/cli/help.ts and docs, the pin-queue parts take test/fixtures and the merge tests, and the `promptLineFree`, `statusHeaderLine` and `roleRows` splits take src/ui/tui/tui-pane-ctx.ts, src/ui/tui/tui-editors.ts, src/ui/status-render.ts and src/ui/status-payload.ts, none of them src/ui/tui/tui.tsx; docs/invariants.md names this file only for the queued-prompt rows and the status surfaces (`grep -n 'tui\.tsx' docs/invariants.md` prints two bindings), neither of which this private move renames or changes; touches src/ui/tui/tui.tsx)

**Goal.** `runTui` (src/ui/tui/tui.tsx) does three separable jobs around its loop: it wires the exit triggers (the self-reload watch, the supervisor-gone watch and a hosted run's abort signal) into one quit promise and decides whether a fired reload re-execs, it composes every frame (snapshot, status spans, alerts, queued previews, budgets, pane body, lines and sanitization) through an anonymous `render` closure, and it assembles a 30-field inline `mode` literal that `hintLine` and `promptPrefix` read. A reader asking how the TUI ends, how one frame is built, or which editor flags the footer sees must scan the whole function. Lift each job into a named module-private helper and leave `runTui` as the terminal guard, the exit-control setup, the key handler, the ink mount, the one-second loop and the teardown, with no frame line, budget, key, teardown or re-exec changed.

**Approach.** All edits in src/ui/tui/tui.tsx; move the existing expressions, comments and flags verbatim, change only indentation, and add no import.
- Add a module-private `interface TuiExitControl` above `runTui` with `quit(): void`, `wait(): Promise<void>`, `stop(): void` and `shouldReexec(): boolean`.
- Add `function startTuiExitControl(root: string, seams: TuiSeams): TuiExitControl` above `runTui`, holding the current `reloadRequested`, `supervisorGone`, `resolveMain`, `reloadDisabled`, `reloadWatch` (including its `start()`), `stopSupervisorWatch` and `abortSignal` listener exactly as today. `quit()` calls `resolveMain?.()`; `wait()` sets `resolveMain` and resolves immediately when `reloadRequested || supervisorGone || seams.abortSignal?.aborted`, keeping the current race comment; `stop()` calls `reloadWatch?.stop()` then `stopSupervisorWatch()`; `shouldReexec()` returns `!reloadDisabled && reloadRequested && !supervisorGone`.
- Add `function promptLineMode(s: FrameState): Parameters<typeof hintLine>[1]` above `runTui`, holding today's `mode` object literal verbatim (`budget`, `concurrencyMode`, `checksMode`, `checkMode`, `fallbackMode`, `modelMode`, `rolePromptFor`, `attachMode`, all pause/edit/answer/entry/notes/brief/retire/release/role-enabled/quiet/interval/role-model/instructions/slots/images/notify/backends/instances fields) in today's order.
- Add `function composeTuiFrame(root: string, width: number, rows: number, snap: ReturnType<typeof snapshot>, status: ReturnType<typeof renderStatusSpans>, keys: TuiKeys): TuiAppView` above `runTui`, holding the `render` closure's body minus its `rows`/`width` read, `snapshot`, `renderStatusSpans` and `inkApp.rerender` call: the `keys.syncSnapshot` call with `directorRunInFlight`, `keys.state()`, the `alertLines(teamAlerts(...))` read, the queued previews, the `eventBudget`/`entryBudget` math and `keys.setLineBudgets`, `paneForView`, `paneBody`, `promptLineMode(s)`, the ordered `lines` assembly, and `return { lines: sanitizeFrameLines(lines) }`.
- Leave the `render` closure in `runTui` as the three frame inputs and the draw: `const rows = stdout.rows || 40;`, `const width = stdout.columns || 120;`, `const snap = snapshot(root);`, `const status = renderStatusSpans(root, snap, width);`, then `inkApp.rerender(<TuiApp view={composeTuiFrame(root, width, rows, snap, status, keys)} noColor={noColor} keys={keys} />);`. Keep its width-default comment with the `width` read.
- In `runTui`, replace the watch/flag block with `const exit = startTuiExitControl(root, seams);` and pass `quit: () => exit.quit()` to `createTuiKeys`; replace the `await new Promise` block with `await exit.wait();`, then keep `clearInterval(timer)`, `inkApp.unmount()`, `stdout.write("\n")`, replace the two watch stops with `exit.stop()`, and replace the final re-exec condition with `if (exit.shouldReexec()) (seams.watch?.reexec ?? reexecSelf)();`.
- Keep `runTui`'s export, signature and doc comment. Each new helper and the interface is module-private and declared once.

**Files touched.** src/ui/tui/tui.tsx

**Acceptance criteria.**
- Every TUI behavior is unchanged: the table, alert lines, queued previews, pane bodies, flash/hint/prompt lines, clipping and sanitization render the same bytes for the same state; Ctrl+D still quits; a reload trigger still tears down and re-execs once; a gone supervisor still tears down without re-execing; a hosted abort still tears down without re-execing; and the self-reload watch stays uncreated when `reloadDisabled` is true.
- `runTui` contains none of `createReloadWatch(`, `watchReloadSupervisor(`, `snapshot(`, `renderStatusSpans(`, `alertLines(`, `paneBody(`, `tabStrip(`, `hintLine(`, `promptPrefix(`, `sanitizeFrameLines(` or the `reloadRequested`/`supervisorGone` locals; those live only in `startTuiExitControl`, `composeTuiFrame` or `promptLineMode`.
- Each new helper exists once at module scope and is not exported: `grep -nE '^export ' src/ui/tui/tui.tsx` prints the same declarations before and after, and `grep -cE '^(function (startTuiExitControl|promptLineMode|composeTuiFrame)|interface TuiExitControl)' src/ui/tui/tui.tsx` prints 4.
- The metrics one-shot reports `runTui` below 10 (13 today) and `composeTuiFrame`, `startTuiExitControl` and `promptLineMode` each at 10 or below, with no other body's count increased.
- `docs/invariants.md` is unchanged: it binds only the queued-prompt rows and status surfaces of this file, and the move renames neither.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving. test/tui.test.ts drives the first frame, the table and the pane loop; test/tui-reload.test.ts pins the reload trigger, the supervisor-gone teardown and the hosted-abort teardown; test/tui-keys.test.ts pins the key dispatch and the footer mode. Run those three files, then the project's gate. If a frame line, budget or exit path changes, a helper took the wrong inputs or the watch return shape dropped a flag; restore the original expression, do not edit the test.

## Done
