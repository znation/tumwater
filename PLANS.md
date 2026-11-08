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

### `tumwater bug --retire <n> [--reason <text>]` closes the Nth open bug as retired, moving it to BUGS.md `## Fixed` with the retired stamp and audit line instead of deleting it, so a duplicate or obsolete bug leaves the same record `tumwater plan --retire` leaves for a plan (planned 2026-11-08 by the plan role; `plan` has had `--retire <n> [--reason <text>]` since the "No duplicate plans" series, but `bug` has only `--cancel`, which retracts an entry as if it were never filed, and `--release`, which lifts a hold — `grep -rn 'bug --retire\|retireBug' src docs test PLANS.md PLANS-DONE.md BUGS.md BUGS-FIXED.md` prints nothing before this entry, while `retirePlan` (src/backlog/backlog-write.ts) and `retireAndAnnounce`'s `command: "plan"` parameter (src/cli/backlog-cli.ts) carry the whole retired shape already; `BacklogCommandSpec` (src/cli.ts) documents `retire` as "absent for `bug` (only plans are retired)" and `cmdBugCase` sets no sink, so the feature is a symmetry completion, not a new mechanism; independent in file of every waiting plan — the in-flight `config --diff` and the `salvage --drop` entry share only src/cli/help.ts and docs/cli.md, where this edits the `bug` stanza and the Steer row, never the `config`/`salvage` stanzas or rows, and no waiting entry names src/backlog/backlog-write.ts, src/cli/backlog-cli.ts, src/cli.ts or test/backlog-write-retire.test.ts; docs/invariants.md's INV-N6 binds retiring a *plan* on unchecked evidence, whose code path this keeps byte-identical, and BUGS.md `## Fixed` is already the section every finished-bug reader reads (`fixedBugEntries`), so no invariant changes; touches src/backlog/backlog-write.ts src/cli/backlog-cli.ts src/cli.ts src/cli/help.ts docs/cli.md test/backlog-write-retire.test.ts)

**Goal.** A duplicate or obsolete bug can only be cancelled today, which deletes it from BUGS.md `## Open` and leaves no record that it was ever filed, or released, which is only for lifting a hold. Add the bug twin of `tumwater plan --retire`: `tumwater bug --retire <n> [--reason <text>]` moves the Nth `## Open` entry to the top of BUGS.md `## Fixed` as a retired record, with a `retired YYYY-MM-DD by the user` heading stamp and a first `**Retired YYYY-MM-DD by the user[: <reason>]**` body line. No role is woken; retiring closes an entry without fixing or building it.

**Approach.**
- src/backlog/backlog-write.ts: factor the locked body of `retirePlanLocked` into one module-private `retireEntryLocked(root, file, fromSection, toSection, n, reason)` — keeping the existing `readEntryLines` removal, trailing-parenthetical stamp append (now worded for any stamp, since a bug heading carries `(found by …)`/`(reported …)` rather than `(planned …)`), `_None yet._` placeholder drop, fence-aware destination span, and one atomic write. Export `retirePlan` (PLANS.md `## Planned` → `## Done`) and a new `retireBug` (BUGS.md `## Open` → `## Fixed`) as the two thin wrappers, so the plan move stays byte-identical.
- src/cli/backlog-cli.ts: widen `retireAndAnnounce`'s command type to `"bug" | "plan"`, pass the command into `peelReasonFlag` so its missing/empty/flag-looking value wording names `bug --retire --reason` or `plan --retire --reason`, and derive the confirmation `retired <command> in <file>: <title>` and the commit subject `` `Retire <command>: <title>` `` from it. Keep the no-wake rule and the `--json` payload `{file, title, retiredOn, reason?}` unchanged.
- src/cli.ts: make `BacklogCommandSpec.retire` the sink both kinds carry (drop the "absent for bug" note), dispatch on `s.retire && args.includes("--retire")` instead of `s.command === "plan"`, and in `cmdBugCase` import `retireBug` and set `retire: (n, reason) => retireBug(root, n, reason)`.
- src/cli/help.ts: add a `tumwater bug --retire <n> [--reason <text>] [--json]` stanza after `bug --cancel`, saying it moves the entry to `## Fixed` as closed without being fixed, keeps its body, appends the retired stamp and audit body line, wakes no one, and prints `{file, title, retiredOn, reason?}`; add `--retire` and `--reason` to `FREEFORM_VALUED_FLAGS.bug`. docs/cli.md's Steer-the-project row gets the same clause beside `bug --cancel`.

**Files touched.** src/backlog/backlog-write.ts src/cli/backlog-cli.ts src/cli.ts src/cli/help.ts docs/cli.md test/backlog-write-retire.test.ts

**Acceptance criteria.**
- Given BUGS.md `## Open` entries `Alpha` and `Beta` and an empty `## Fixed`, `tumwater bug --retire 2 --reason "duplicate of Alpha"` exits 0, prints exactly `retired bug in BUGS.md: Beta`, leaves `Alpha` and every other byte of `## Open` in place, and moves `Beta` to the top of `## Fixed` with its body kept, a heading carrying `retired <today> by the user`, and first body line `**Retired <today> by the user: duplicate of Alpha**`.
- Without `--reason`, the first body line is `**Retired <today> by the user**`; `--json` prints one document equal to `{file: "BUGS.md", title: "Beta", retiredOn: "<today>"}` with no `reason` key, and with a reason adds exactly the `reason` key; the commit subject is `tumwater(operator): Retire bug: Beta` and no prompt is queued for bugfix.
- After the retire, `tumwater bug --list` no longer lists `Beta`, and `tumwater bug --list --done` lists it first (its heading carries the retired date); `tumwater plan --retire` keeps its current text, JSON, stamp and commit subject for the same inputs.
- `bug --retire` with no position, a non-positive or out-of-range position, an extra positional, an unknown flag, `--reason` with no value or an empty/flag-looking value, or `--reason` twice each exits nonzero with the bug-named usage/wording and leaves BUGS.md and PLANS.md unchanged; the equivalent `plan --retire` refusals keep their existing plan-named wording.
- `tumwater help bug`, `tumwater help` and docs/cli.md show `tumwater bug --retire <n> [--reason <text>] [--json]` and its closed-without-fixing, audit-line and no-wake contract, and `tumwater help bug --retire 1 --help` still answers the bug topic rather than treating `--retire`'s value as prose.
- `npm run test:gate` passes.

**Tests.** Extend test/backlog-write-retire.test.ts: a `retireBug` in-process move of a middle Open entry (body kept, heading stamp, reason/no-reason first line, other bugs and PLANS.md untouched), a CLI `bug --retire --json` text/JSON payload with no queued bugfix prompt and the `bug --list --done` listing, and the bug-named refusals above with both files byte-unchanged. Run test/backlog-write-retire.test.ts, test/backlog.test.ts, test/help.test.ts, test/completion.test.ts and test/cli-doc.test.ts, then the project's gate.

## Done

