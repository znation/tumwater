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

### The dashboard's entry drawer and the TUI's Backlog pane retire an open bug with the same audit record `tumwater bug --retire` leaves, so a duplicate or obsolete bug is closed as not fixed instead of being cancelled with no record (planned 2026-11-08 by the plan role; `tumwater bug --retire` landed as the bug twin of `plan --retire` and `retireBug` already exists in src/backlog/backlog-write.ts, but the dashboard drawer's Retire action is shown only for `file === "plans"` and `/api/backlog-retire` refuses `kind: "bug"` with `only plans are retirable from the dashboard`, while the TUI's Ctrl+Y retire arm flashes `only a plan can be retired here` for a selected bug; `grep -rn 'tryRetireBug\|Retire this bug\|retire bug' src test docs PLANS.md PLANS-DONE.md` prints nothing, so no plan or code carries the twin; independent of the waiting `--held` listing plan (which edits backlog-render, backlog-cli-view, cli-query-commands, help and their tests) and of the blocked Subtract parts (which never name src/ui/gui, src/ui/tui/tui-pane-backlog.ts or the retire helpers); touches src/backlog/backlog-write.ts src/gui/gui-backlog-commands.ts src/ui/gui/gui-client-drawer.ts src/ui/gui/gui-client-boot.ts src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-frame.ts docs/cli.md test/backlog-write-retire.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts test/gui-client-boot.test.ts test/tui-keys.test.ts test/tui-frame.test.ts)

**Goal.** An operator can retire an open bug wherever they retire a plan. In the dashboard's Bugs drawer the two-click `Retire this bug` action moves the bug from `## Open` to `## Fixed` as a retired record — its body kept, a `retired YYYY-MM-DD by the user` heading stamp and a first `**Retired …**` audit line — commits `BUGS.md` on main as `tumwater(operator): Retire bug: <title>`, and wakes no role. In the TUI's Backlog pane, `Ctrl+Y` twice on a selected bug does the same through the locked `retireBug` core, flashes the retired position and title, and wakes no role. A stale or out-of-range selection writes nothing in either surface, and the existing plan-retire behavior is unchanged.

**Approach.**
- src/backlog/backlog-write.ts: add `tryRetireBug(root, n, expectedTitle): RetireEntryOutcome`, the bug twin of `tryRetirePlan`, locating the entry in `BUGS.md` `Open` and calling `retireEntryAt(file, "BUGS.md", "Fixed", …)` under the lock. Extract the shared private lookup-and-move into one helper both `tryRetire*` functions call, so the title comparison cannot drift between plan and bug.
- src/gui/gui-backlog-commands.ts, `handleBacklogRetire`: accept `body.kind === "bug"` and call `tryRetireBug`; keep the unknown-kind 400, the `gone` answer for a missing or moved entry, and the response shape. Commit the moved file as `Retire plan: …` for plans and `Retire bug: …` for bugs, and update the function's doc comment to name both.
- src/ui/gui/gui-client-drawer.ts, `refreshEntry`: render `entry-retire` for `file === "bugs"` as well as `"plans"`, with the button reading `Retire this plan`/`Retire this bug` and `Click again to retire` while armed. Keep done/fixed/answered and question rows free of the action.
- src/ui/gui/gui-client-boot.ts, the `entry-retire` arm: post `kind: kindOf(file)` rather than the hardcoded `"plan"`, and toast that the entry was closed without being built (plan) or fixed (bug).
- src/ui/tui/tui-pane-backlog.ts: import `retireBug` and `openBugEntries`; generalize the armed target and `retirePlanArmed` to carry `kind: "plan" | "bug"`, re-read the matching live list (`plannedPlanEntries`/`openBugEntries`), call `retirePlan`/`retireBug`, commit `Retire <kind>: <title>`, and flash `press Ctrl+Y again to retire <kind> #<n> …` and `retired <kind> #<n>: <title> (not built)` / `(not fixed)`. A selected bug no longer flashes the plan-only refusal; questions and read-only rows keep `selectedEditableEntry`'s refusals.
- src/ui/tui/tui-frame.ts and docs/cli.md: the Backlog hint reads `Ctrl+Y retire plan/bug`; the Steer-the-project row's dashboard sentence and the TUI-keys Backlog row describe retiring an open plan or bug, naming the `## Done`/`## Fixed` destination and the same audit line as `plan --retire`/`bug --retire`.

**Files touched.** src/backlog/backlog-write.ts src/gui/gui-backlog-commands.ts src/ui/gui/gui-client-drawer.ts src/ui/gui/gui-client-boot.ts src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-frame.ts docs/cli.md test/backlog-write-retire.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts test/gui-client-boot.test.ts test/tui-keys.test.ts test/tui-frame.test.ts

**Acceptance criteria.**
- Given BUGS.md with two open bugs, opening the second in the dashboard's Bugs drawer shows `Retire this bug`; the first click arms and a second click moves exactly that bug to `## Fixed` under a `### <title> (found …, retired <today> by the user)` heading with a first `**Retired <today> by the user**` line, leaves the other bug byte-identical, commits `BUGS.md` on main as `tumwater(operator): Retire bug: <title>`, and sends no wake to bugfix, feature or director. The same entry opened in the Plans drawer still retires as a plan.
- A dashboard retire post whose title differs from the bug at that position, or whose position is out of range, answers `{ ok: true, status: "gone" }` and leaves BUGS.md byte-identical; an unknown `kind` still answers 400.
- In the TUI, selecting an open bug and pressing `Ctrl+Y` twice moves it to `## Fixed` with the same retired heading and audit line, flashes `retired bug #<n>: <title> (not fixed)`, commits `Retire bug: <title>`, and wakes no role; a stale selection flashes the moved refusal and leaves BUGS.md byte-identical. The plan path still produces the plan heading, audit line and `Retire plan: <title>` commit, and a question or a done/fixed/answered row is refused exactly as today.
- The Backlog hint and docs/cli.md name retiring a plan or bug, and `plan --retire` / `bug --retire` CLI text and behavior are unchanged.
- `npm run test:gate` passes.

**Tests.** Extend test/backlog-write-retire.test.ts with `tryRetireBug` success and gone/moved cases. In test/gui-endpoints.test.ts replace the bug-refusal expectation with a bug retirement that checks the `## Fixed` record, the `Retire bug:` commit subject and no queued wake, and keep the stale-title, out-of-range and unknown-kind cases. In test/gui-client-drawer.test.ts change the plan-only case to assert the action and `Retire this bug` on the Bugs tab and still no action on done/fixed/answered. In test/gui-client-boot.test.ts assert the bug post carries `kind: "bug"` and the bug toast. In test/tui-keys.test.ts add the bug arm-then-retire, the stale-bug refusal and the untouched plan path. Update the hint assertion in test/tui-frame.test.ts. Run test/backlog-write-retire.test.ts, test/gui-endpoints.test.ts, test/gui-client-drawer.test.ts, test/gui-client-boot.test.ts, test/tui-keys.test.ts, test/tui-frame.test.ts, test/tui-keys-doc.test.ts and test/backlog-structure.test.ts, then the project's gate.

### The TUI's Backlog pane cycles its Ctrl+O filter through all, Ready-only and the new Held-only stop, so an operator can see just the entries a hold keeps from being picked (planned 2026-11-08 by the plan role; `tumwater backlog --held`, `plan --list --held` and `bug --list --held` landed 2026-11-08 as the inverse of `--ready`, but the TUI's Backlog Ctrl+O is still a binary Ready-only toggle (`backlogReadyOnly` in src/ui/tui/tui-pane-backlog.ts), and the dashboard already groups held rows under its Blocked (N) divider; `grep -rn 'backlogHeldOnly\|Held only\|held only\|held-only' src test docs PLANS.md PLANS-DONE.md BUGS.md BUGS-FIXED.md` found no such stop in the TUI or a plan for one before this entry (only the landed CLI `--held` entry and unrelated prose); independent of the blocked Subtract parts, which never name src/ui/tui/tui-backlog.ts, tui-pane-backlog.ts or tui-pane.ts, and its edits to src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-frame.ts docs/cli.md sit in the same files as the waiting bug-retire plan but at different arms — that plan is earlier in the queue, so this one rebases onto its Ctrl+Y retire arm and hint; touches src/ui/tui/tui-backlog.ts src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-pane.ts src/ui/tui/tui-panes.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts docs/cli.md test/tui-backlog.test.ts test/tui-keys.test.ts)

**Goal.** On the TUI's Backlog view, `Ctrl+O` steps the list filter through three states instead of toggling one: all entries (today's default), Ready-only (the open plans and bugs no hold keeps from being picked, today's second state), and Held-only (the open plans and bugs a Refused, Needs-review, awaiting-recurrence or unmerged-prerequisite hold keeps from being picked). The hint line and docs name the current key and its three stops. An empty Held-only list says so rather than showing a blank pane. Search (`/`) still composes with the active stop, and the pane's selection clears when the stop changes, as the Ready-only toggle clears it today.

**Approach.**
- src/ui/tui/tui-backlog.ts: give `visibleBacklogIndexes` a `filter: "all" | "ready" | "held"` parameter in place of its boolean `readyOnly` (default `"all"`). `"ready"` keeps today's rule (`hold === null || hold === undefined`); `"held"` keeps only entries whose `hold` is non-null; either filter still returns open entries only, never an answered/done/fixed index. Export the `BacklogFilter` type beside the function.
- src/ui/tui/tui-keys.ts and src/ui/tui/tui-pane.ts: beside `backlogReadyOnly`, add `backlogHeldOnly: boolean` to `TuiPane`'s optional state and to `TuiPaneState`, documented as the Held-only stop.
- src/ui/tui/tui-pane-backlog.ts: keep one module-private `backlogFilter: BacklogFilter = "all"` and have `state()` return `backlogReadyOnly: backlogFilter === "ready"`, `backlogHeldOnly: backlogFilter === "held"`. Rename `backlogToggleReady` to `backlogCycleFilter` and make it advance `all → ready → held → all`, clearing the selection and body scroll exactly as the toggle does now. In `backlogSelect`, use `visibleBacklogIndexes(entries, backlogGrep, backlogFilter)` for the filtered arms; in entry mode's existing no-search special case, keep rendering every entry for `"all"`, and for `"ready"`/`"held"` use the filtered index list so up/down step within what is rendered.
- src/ui/tui/tui-pane.ts: the list render drops a held open row under `backlogReadyOnly` as today, and under `backlogHeldOnly` drops every entry whose `hold` is null or undefined (so ready rows, questions and the answered/done/fixed rows are not shown). The two stops are mutually exclusive by construction.
- src/ui/tui/tui-panes.ts: carry the pane's new `backlogHeldOnly` into the merged `state()`.
- src/ui/tui/tui-frame.ts: the Backlog hint's Ctrl+O entry names the cycle (`filter: ready/held`) beside the existing search and action hints.
- docs/cli.md: in the TUI keys table's Backlog row, replace the Ctrl+O description with the three stops — all, Ready-only (the open plans and bugs no hold keeps from being picked) and Held-only (only the entries a hold keeps from being picked) — and say `/` search composes with whichever stop is active.

**Files touched.** src/ui/tui/tui-backlog.ts src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-pane.ts src/ui/tui/tui-panes.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts docs/cli.md test/tui-backlog.test.ts test/tui-keys.test.ts

**Acceptance criteria.**
- Given a flat Backlog list with an eligible plan, a plan held by an unmerged prerequisite, a bug held by a Refused note and an open question, pressing Ctrl+O on the Backlog view moves the state through `all` (every row), `ready` (the eligible plan and the question; the held plan and bug are gone), `held` (the held plan and bug; the eligible plan and the question are gone) and back to `all`. Every other view's Ctrl+O keeps its current meaning.
- A `/` search applied in any of the three states keeps only the rows that both match the text and pass the state, numbered by their unfiltered positions; moving up/down in a filtered state steps only through the rendered rows, and changing the state clears an open entry selection so the pane returns to list mode.
- With no held entries, the Held-only state paints an explicit `no held entries` line rather than an empty pane; with no matching held entry under a search it keeps the existing no-match wording.
- The Backlog hint names the three stops, and docs/cli.md's TUI-keys Backlog row says Ctrl+O cycles all, Ready-only and Held-only and that `/` composes with the active stop.
- The `plan --list --held`, `bug --list --held` and `backlog --held` CLI behavior and the dashboard's Ready only toggle are unchanged; `npm run test:gate` passes.

**Tests.** Extend test/tui-backlog.test.ts: `visibleBacklogIndexes` keeps only non-null holds under `"held"`, keeps today's indexes under `"ready"`, returns every open index under `"all"`, excludes finished rows in both filtered states, and composes a pattern with each. Add a `paneBody` case showing the held row and not the eligible row or question under `backlogHeldOnly`, and the explicit empty line when no entry is held. In test/tui-keys.test.ts update the existing Ctrl+O case to the three-state cycle and add a bug held by a Refused note, a Needs-review plan and an awaiting-recurrence bug each surviving Held-only. Run test/tui-backlog.test.ts, test/tui-keys.test.ts, test/tui-frame.test.ts, test/tui-keys-doc.test.ts and test/backlog-structure.test.ts, then the project's gate.

## Done
