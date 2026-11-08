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

### Subtract, part 3e/7: A run's merge pin is merged directly, without a queue entry (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; split again 2026-11-08 by the plan role after feature held it too large, with the drain prerequisite as Subtract part 3h/7 and the recovery half as part 3i/7; this part requires Subtract part 3h/7 landed; touches src/run/run-stage.ts src/git/commit-message.ts src/runner/runner-leftover.ts docs/how-it-works.md test/run-stage.test.ts test/commit-message.test.ts test/commit-message-stamps.test.ts test/runner-leftover-recovery.test.ts test/fixtures/orchestrator-fixtures.ts)

**Goal.** A changed fresh run stops writing a durable queue entry: it pins its commit by `refs/tumwater/landing/<role>`, stamps the merge-only metadata on the commit, logs `merge_queued`, and ends `queued`. The poll's drain (part 3h/7) merges the pin. Legacy queue files an older build left still drain until part 3f deletes the queue; leftover recovery still enqueues until part 3i/7 stops it.

**Approach.**
- In `pinAndEnqueueChange` (src/run/run-stage.ts), remove the `enqueueMerge` block after `pinAndReset`: log `merge_queued` with the commit and summary, clear `s.revision` when a revision is in flight, and return `{ heldOnBranch }` as today. `heldOnBranch` keeps checking a legacy queued entry OR an existing pin, so a role's second commit still stays on its branch. Drop the now-unused `entryRevisionFields` import.
- Stamp what only the queue entry used to carry onto the commit, so a pin with no entry still reaches the same review and withdrawal checks. Extend `CommitMetadata` in src/git/commit-message.ts with `claim` (`{ file, key, title }`, the shape `MergeClaim` names in src/merge/merge-withdrawn.ts) and `priorReview` (the `PriorReview` shape in src/merge/merge-queue.ts), both type-only imports. Add one-line JSON trailer lines (`Claim: {...}`, `Prior-review: {...}`) beside the existing Run/Friction/Revision lines, parsed only from a whole line and failing closed to absent like `revisionRoundOf`.
- In `stagedCommitMessage`, pass the `priorReview` already computed by `revisionFields(ctx)` and `ctx.state.claim` (only when `ctx.userPrompt === null`, the same condition the queue entry used) and append those two lines when present. Only a run that worked an entry carries Claim; only a revision carries Prior-review.
- In src/runner/runner-leftover.ts, `recoveredMergeEntry` copies `claim` and `priorReview` from `recoveredMetadata` into the entry, so the drain's pin reader reconstructs the entry the queue used to carry. Update its comment: a recovered pin now carries these fields when its commit stamps them.
- In test/fixtures/orchestrator-fixtures.ts, `mergeHead` drives a pin when `headMerge` returns null: find the expected role's pin (`refSha` on `mergeRefName(role)`), run `drainMergeQueue`, and after the task settles require the queue file gone when there was one; for a `changed` outcome require the pin gone, and for a retriable outcome leave the kept pin. The legacy queue path stays as it is.
- docs/how-it-works.md's Merge section: a changed run's waiting state is its pin plus its commit's trailers; no queue entry is written. The queue is legacy input only.

**Files touched.** src/run/run-stage.ts src/git/commit-message.ts src/runner/runner-leftover.ts docs/how-it-works.md test/run-stage.test.ts test/commit-message.test.ts test/commit-message-stamps.test.ts test/runner-leftover-recovery.test.ts test/fixtures/orchestrator-fixtures.ts

**Acceptance criteria.**
- A changed fresh run with no older waiting change writes no `.tumwater/merge-queue/` file, leaves `refs/tumwater/landing/<role>` at its commit, logs exactly one `merge_queued`, and ends `queued`; a following poll merges that pin onto main through one gate.
- A run that worked a backlog entry stamps that entry's file, key and title on its commit; the merge entry the drain builds from the pin names it, so an entry main no longer lists still drops the change as `withdrawn`.
- A revision run stamps its prior review (head, objections, counts) and revision round; the drain's pin entry carries them into the re-review, so a repeated objection still ends the revision chain at the same round as today.
- A run whose role already holds a legacy queue entry or an unmerged pin still ends `heldOnBranch`, writing no second pin and no queue entry.
- test/fixtures/orchestrator-fixtures.ts's `mergeHead` merges a changed run that left a pin and no queue head, and its legacy queue path is unchanged.
- `npm run test:gate` passes.

**Tests.** test/run-stage.test.ts: the fresh-changed runs that asserted `queueDepth(root) === 1` now assert `0` and the pin at `outcome.commit`; add a claimed-run case asserting the commit's `Claim:` line names the entry and `mergeHead` still merges it. test/commit-message.test.ts and test/commit-message-stamps.test.ts: stamp and parse the two new lines, including absent and malformed cases. test/runner-leftover-recovery.test.ts: the fresh-change cases that read `headMerge(...)?.entry.sha` read the pin's sha instead. Run those files, then the project's gate.

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3i/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

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

### Subtract, part 3h/7: The merge drain merges a pinned change that has no queue file (planned 2026-11-08 by the plan role, splitting the 2026-11-08 too-large Subtract part 3e/7 after feature held it; sibling to Subtract parts 3e/7 and 3i/7, both of which require it; requires Subtract part 3d/7 landed; touches src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/runner/runner-leftover.ts src/merge/merge-head.ts docs/how-it-works.md test/orchestrator-merge-pin.test.ts test/merge-drain.test.ts)

**Goal.** A role's kept merge pin with no queue entry is gated and merged by the serial drain on a poll, instead of waiting for the role's next run's leftover recovery. A pin left by a crash between the commit and the queue write, or by the pin-only writers of parts 3e/7 and 3i/7, therefore lands. Legacy queue files still drain first, exactly as today.

**Approach.**
- In src/runner/runner-leftover.ts, factor the pin-to-entry block `dropTornHead` (src/merge/merge-head.ts) already builds into `pinnedMergeEntry(root, role, sha)`: `recoveredMetadata` plus the run from the commit's `Run:` trailer (`commitRunOf`, 0 when absent) into `recoveredMergeEntry`. `dropTornHead` calls the same helper, so the two paths cannot drift.
- In `drainMerge` (src/merge/merge-drain.ts), after the queue-file loop starts nothing, scan `ctx.runners`: skip a role with a queued entry (`queuedMergeRoles`), then take `pinnedRetrySha(root, role, mainBranch, runner.state)` — which deletes a dangling or stale pin and refuses a pin at `MERGE_CONFLICT_LIMIT` — build its entry with `pinnedMergeEntry`, and, when `ctx.startHeld(role)` is false, `startMerge(ctx, p, entry, null)`. Start one task per poll, as the queue path does.
- Make the task's queue file optional: `startMerge`, `settleMergeOutcome` and `writeMergeOutcome` take `file: string | null`; a null file skips `dropMerge` and skips `requeueKeptChange`, so a retriable pin-only merge keeps its pin with no retry queue entry and the next poll retries it under `MERGE_CONFLICT_LIMIT`. The `merge_done`/`merge_failed` events still fire with the same fields.
- docs/how-it-works.md's Merge section: a pin with no queue entry is merged on the next poll; queue files remain legacy input.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/runner/runner-leftover.ts src/merge/merge-head.ts docs/how-it-works.md test/orchestrator-merge-pin.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- Given a pin and no `.tumwater/merge-queue/` file, one drain poll starts its gate-then-merge task; after it settles main contains the pin's sha, the pin ref is gone, `merge_done` fired, and no queue file exists.
- A pin whose commit main already contains is deleted with no gate and no `merge_done` event.
- A pin at `MERGE_CONFLICT_LIMIT` is neither merged nor deleted by the drain; it stays for its author's hand-back.
- When a legacy queue entry and a pin are both waiting, the queue entry is merged first, and a role with a queue entry is not also merged from its pin.
- A retriable pin-only outcome (`review_error`, `merge_blocked`, `merge_conflict`) keeps the pin, writes no queue entry, and is retried by a later poll.
- `npm run test:gate` passes.

**Tests.** New test/orchestrator-merge-pin.test.ts, built like `mergeHead`: a pin with no entry merges on a poll; a stale pin is deleted without a gate; a cap pin is left untouched; a queued entry and a pin waiting together merge the entry first. Extend test/merge-drain.test.ts with the null-file settle case (outcome written, no file dropped, no retry entry). Run those files, test/merge-slot.test.ts, then the project's gate.

### Subtract, part 3i/7: Leftover recovery pins a recovered commit and writes no queue entry (planned 2026-11-08 by the plan role, splitting the 2026-11-08 too-large Subtract part 3e/7 after feature held it; sibling to Subtract part 3e/7, which it requires; requires Subtract part 3e/7 landed; touches src/runner/runner-leftover.ts src/runner/runner-recovery.ts src/runner/runner-run.ts docs/how-it-works.md docs/invariants.md test/runner-leftover.test.ts test/runner-leftover-recovery.test.ts)

**Goal.** A role's next run that finds unmerged leftover work adopts it into the pin (as today) and ends `queued` with no queue file: the pin is the waiting state and the drain of part 3h/7 merges it. Stale/dangling cleanup, the conflict hand-back and `MERGE_CONFLICT_LIMIT` keep their behavior; a legacy queue entry an older build left still takes the `already_queued`/`relief_wait` arms.

**Approach.**
- In `recoverLeftover` (src/runner/runner-leftover.ts), after the cap and hand-back decisions, return a new `{ kind: "pinned"; sha; summary; highFriction }` arm instead of `recoveredMergeEntry` plus `enqueueMerge`; still log exactly one `merge_queued` with the sha and summary. Remove the `enqueued` arm and the now-unused `enqueueMerge` import; keep `recoveredMergeEntry` and `recoveredMetadata` for the drain and torn-head paths.
- In src/runner/runner-leftover.ts, change `LeftoverRecovery`/`FinishableRecovery`: `pinned` is finishable; `enqueued` is gone. src/runner/runner-recovery.ts's `finishRecoveryRunPhase` handles `pinned` like the old `enqueued` arm: `setRecoveryFailure`, reset the worktree only when the branch is at main or its tip is the pinned sha, and return `queued` with the summary, sha and friction. src/runner/runner-run.ts needs only the arm-name update where it excludes non-finishable arms.
- docs/how-it-works.md's leftover-recovery and Merge prose: recovery re-pins the recovered commit and ends `queued`; no queue entry is written. docs/invariants.md's recovery section (which today says a recovered pin is re-enqueued) now says the pin is kept or adopted and the poll merges it, and its file/test bindings still name existing files.
- test/runner-leftover.test.ts and test/runner-leftover-recovery.test.ts: recovery outcomes that asserted `queueDepth`/`headMerge` now assert the pin's sha (`mergeRefSha`/`mergeRefExists`) and no queue file; keep the cases that seed a legacy queue entry through `enqueueMerge` and assert `already_queued`/`relief_wait` untouched.

**Files touched.** src/runner/runner-leftover.ts src/runner/runner-recovery.ts src/runner/runner-run.ts docs/how-it-works.md docs/invariants.md test/runner-leftover.test.ts test/runner-leftover-recovery.test.ts

**Acceptance criteria.**
- A role whose branch tip is ahead of main and unpinned writes the pin, writes no `.tumwater/merge-queue/` file, logs one `merge_queued`, ends `queued` with the recovered summary and sha, and a following poll merges that pin.
- A role with a pin and no entry recovers it as today: a pin main contains is deleted, a dangling pin is dropped with its warning, and a pin at `MERGE_CONFLICT_LIMIT` still hands back or discards — no arm writes a queue file.
- A legacy queue entry seeded for the role still ends its next run `already_queued` (or `relief_wait` with a second commit on the branch) and leaves that entry untouched.
- docs/invariants.md's recovery guarantee describes pinned leftover work, not a re-enqueue, and every binding it names still exists.
- `npm run test:gate` passes.

**Tests.** Run test/runner-leftover.test.ts and test/runner-leftover-recovery.test.ts whole (the no-pin adoption, cap hand-back, discard and legacy-entry cases included), then the project's gate. Restore any surviving recovery case that loses its assertions; do not weaken a cap or hand-back assertion to make the gate pass.

### `tumwater salvage` gains `-f/--follow`, repainting the kept-workspace-patch list until Ctrl+C or its parent exits, so an operator watching a run settle sees a newly kept patch appear without rerunning the command (planned 2026-11-08 by the plan role; continues the landed follow-view family — `status`, `diff`, `backlog`, `quarantine`, `doctor`, `reviews`, `report`, `questions`, `prompt --list`, `plan|bug --list`, `role`, `history --summary` and the `history <role> <n>` trail all repaint through `followView` in src/cli/follow-view.ts, while `salvage` is the kept-patch list still refusing `-f` by name (before this entry `git show HEAD:PLANS.md | grep -c 'salvage -f\|salvage --follow'` prints 0, and no `## Planned` heading named a salvage command before this entry); independent in file of every `## Planned` entry — the in-flight prompt `--grep` plan takes src/cli/cli-command-args.ts and src/inbox/prompt-commands.ts, the Subtract parts take src/merge, src/runner, src/status, src/doctor, src/gui, src/ui, src/stage, src/events and docs, and only docs/cli.md is shared, in the salvage row rather than the prompt row; PLANS-DONE.md holds no salvage follow (`grep -cE '^### .*salvage.*(--follow|-f/--follow)' PLANS-DONE.md` prints 0), and its salvage headings added the list, `--show`, `--grep` and `--drop`; docs/invariants.md binds no `cmdSalvage` or salvage renderer symbol (`grep -c 'cmdSalvage\|status-salvage' docs/invariants.md` prints 0); touches src/cli/cli-salvage-command.ts src/cli/cli-args.ts src/cli/help.ts docs/cli.md test/cli-salvage-follow.test.ts)

**Goal.** `tumwater salvage -f` and `tumwater salvage --follow` repaint the kept-patch list every couple of seconds until Ctrl+C or the process that started them exits, re-reading `.tumwater/salvage/` each frame so a patch a run keeps while the operator watches appears without a rerun; `--grep` composes with it, each kept row under its whole-list number. The one-shot list and `--grep`/`--show`/`--drop`/`--json` forms keep their current output and behavior, and `-f` with `--json` or with `--show`/`--drop` is refused.

**Approach.**
- In `cmdSalvage` (src/cli/cli-salvage-command.ts), take a `seams: FollowViewSeams = {}` argument like `cmdQuarantine`, import `followView`/`FollowViewSeams` from ./follow-view.js, and add `FOLLOW_FLAG` to the `rejectUnknownArgs` list beside `JSON_FLAG` and `grepFlagSpec`. Import `hasFollowFlag` from ./cli-flag-specs.js and `failFollowJsonRival` from ./cli-args.js.
- Factor the list read and render into two small local functions in `cmdSalvage`: `readSalvageRows()` returns the patches and the filtered rows (calling `collectSalvagePatches` and, when `pattern !== null`, `grepSalvagePatches` each time), and `renderSalvageRows()` returns the existing text branches — the empty-dir line, the no-match line, and the `salvaged workspace patches: N` header plus rows. The `--json`/one-shot path keeps calling `sayJsonOrRender` over `readSalvageRows().rows`.
- After `parseGrepFlag`, set `const follow = hasFollowFlag(rest);` and, when true and `rest` carries `--json`, call `failFollowJsonRival("salvage --json")` before any read or paint. When `follow` is true, `await followView(() => renderSalvageRows(readSalvageRows()), seams)` and return, as the sibling follow views do. Since `parseGrepFlag` removes the pattern token from `rest`, `salvage --grep --follow` stays a one-shot pattern search for the text `--follow`; the existing `modeNamed` guard keeps `salvage --grep --show` and `salvage --grep --drop` pattern searches too.
- `--show`/`--drop` route to their branches before the list gate exactly as today; their own `rejectUnknownArgs(args, [])` keeps refusing `-f` there, so no destructive branch gains a live form.
- src/cli/help.ts: the `tumwater salvage` usage line gains `[-f/--follow]`, and its description says the list repaints until Ctrl+C or the parent exits, composing with `--grep`, and refuses `--json`.
- docs/cli.md's salvage row gains the same sentence for `-f/--follow` and its `--json` refusal.
- src/cli/cli-args.ts: update `failFollowJsonRival`'s doc comment, whose list still includes the deleted `queue` command and stops at eleven views, to name the surviving views including `salvage`.
- New test/cli-salvage-follow.test.ts, modeled on test/cli-quarantine-follow.test.ts: drive `cmdSalvage` in-process with `{ ppid, intervalMs, tty }` seams, seeding `.tumwater/salvage/` files the way test/cli-salvage.test.ts's `seedSalvage` does.

**Files touched.** src/cli/cli-salvage-command.ts src/cli/cli-args.ts src/cli/help.ts docs/cli.md test/cli-salvage-follow.test.ts

**Acceptance criteria.**
- `cmdSalvage(repo, ["-f"], { ppid, intervalMs: 5, tty: false })` paints at least two frames; a patch written to `.tumwater/salvage/` between frames appears in a later frame; flipping the seam's parent to PID 1 resolves the follow, and nothing prints after it ends.
- `-f --grep mid` paints only the matching patch, under its whole-list position, and never prints a non-matching patch.
- `-f --json` exits 1 with `salvage --json prints one document; -f/--follow repaints a live view — drop one of them`, paints no frame, and writes no clear-screen escape.
- The one-shot forms are unchanged: bare `salvage`, `salvage --grep x`, `salvage --show 2`, `salvage --drop 2` and their `--json` shapes print what they print today, and `--drop 1 -f` is still refused naming `-f` and deletes nothing.
- `tumwater help salvage` and docs/cli.md's salvage row both show `[-f/--follow]` and the `--json` refusal.
- `npm run test:gate` passes.

**Tests.** Run the new test/cli-salvage-follow.test.ts (repaint, per-frame re-read, grep composition, `--json` refusal, TTY versus non-TTY clear-screen), test/cli-salvage.test.ts (the one-shot list, `--grep`, `--show`, `--drop` and refusal cases), test/cli-quarantine-follow.test.ts (the shared `followView` behavior it mirrors), test/help.test.ts and test/docs-commands.test.ts, then the project's gate. If a surviving salvage case loses its output or refusal, restore it; do not weaken an assertion to make the gate pass.

## Done
