# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Hourly full check, part 3a/4: A red's opener is the first commit at which its confirmed failing tests fail, found by bisecting the first-parent code commits since the last green and re-running only those tests (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md "Decision" 4; splitting the 2026-11-01 part 3/4 after feature held it too large for one run; requires Hourly full check part 2c/4 landed; sibling to Hourly full check part 3b/4, which requires this part landed; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts src/events/events.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts)

**Goal.** With the full check hourly, one red verdict covers up to an hour of commits. A confirmed red at tip T must name the single commit that opened it, not T (user, 2026-11-01: "when fixing failures, re-run only the failed tests"). This part changes only which commit is named; the per-head re-check cadence is part 3b/4.

**Approach.**
- Add a module-private bisection in src/baseline/main-watch.ts beside `reportCulprit`, and the walk it needs in src/baseline/main-baseline.ts beside `firstParentWalk`.
  - After a fresh red is confirmed at T, walk T's first-parent commits down to the newest cached full verdict that is green and carries `checkedAt` (the anchor rule `fullCheckPlan` already uses). No such green, a one-commit range, or an unreadable walk leaves the culprit T, as today.
  - The opener C is the first commit in that range at which any of the confirmed failing tests fails. Confirm once that they fail at C and once that they pass at C's parent, re-running only those tests with `rerunTests` (src/build/build-check-rerun.ts) on a checkout of each candidate; the `_gate-main` mirror is re-pointed at the candidate in its own queue (through `withMainTipWorktree` in src/baseline/main-red.ts) and left at main's tip afterwards.
  - A failing test that passes at C gets its own bisect over C..T, bounded by `FAILING_TESTS_MAX` tests.
  - A confirmation that does not reproduce names T.
- `reportCulprit` and the first-red `main_check` name C: `main_culprit.commit`, its merging runner, `redSpellOpeners` and the `onCulprit` hand-off (`commit` C, `tip` T). The `MainCulprit` doc comment in main-watch.ts and the `main_culprit` comment in src/events/events.ts say the culprit is bisected, not merely the first red tip.
- docs/how-it-works.md describes the bisection. docs/invariants.md's INV-AZ4 is reworded so the opener is found by re-running only the failing tests, and its **Binds** names the bisection helper; a new INV-DA3 follows it: a red's culprit is the first commit at which its failing tests fail, found by re-running only them, and its **Pinned by** names the new tests below.

**Files touched.** src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts src/events/events.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts

**Acceptance criteria:**
- A red whose history has a code commit that breaks the failing tests and later commits on top names the breaking commit, not the newest tip; the `main_culprit` event, its runner and the first-red `main_check` sha all name it.
- A red whose candidate confirmation does not reproduce names T, as today.
- A red with no green full verdict below T, or a one-commit range, names T, as today.
- The heal prompt names C rather than T and still carries the failing tests' re-run command.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts:
  - the bisection against a fake check whose failure starts at one commit;
  - the non-reproducing bisection;
  - "a red whose breaking commit is intermediate" now names that commit, not the tip;
  - a range with no full green still names the tip.
- test/main-watch-spells.test.ts: the bisected opener is the spell's culprit.
- test/main-red-heal.test.ts: the heal prompt names the bisected opener.
- Run those files and the gate.

### Hourly full check, part 3b/4: While a red is open, each new head re-runs only its open failures; when none fail the red clears and one full run starts at once to confirm it (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md "Decision" 4; splitting the 2026-11-01 part 3/4 after feature held it too large for one run; requires "Hourly full check, part 3a/4 landed"; touches src/baseline/main-watch.ts src/events/events.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts)

**Goal.** While main is red, a new head must not cost another full check. Each new head re-runs only the spell's open failing tests; a test that passes leaves the set, and when the set is empty the red closes as cleared, with one full run started at once so a healed main becomes deployable without waiting out the hour (user, 2026-11-01: "when fixing failures, re-run only the failed tests").

**Approach.**
- Carry the open failing set with the spell: extend `redSpellOpeners`'s value (or add a sibling map in src/baseline/main-watch.ts) from the opener SHA to the opener plus its remaining failing tests. The set starts from the confirmed red's tests and is keyed by root like the opener.
- In `fullPass`, while a spell is open and a new head arrives, run one `rerun`-scope check of the open set with `rerunTests` on the `_main-full` mirror's new tip instead of `runBaselineCheck`. Tests that pass drop out; the rest settle a failed `main_check` at the spell's opener (no re-attribution). The run uses `CHECK_TIER.merge` like the confirmation rerun.
- An empty set: log `main_check` `{ status: "passed", cleared: true }` through `mainCheckEvent`, which must write no full verdict to the baseline cache (so `redeployTarget`'s watched branch does not target the cleared head, and the hour's anchor stays the last real full verdict); clear the heal-dedup key with `clearHealKeyOnGreen`; delete the spell; then run the full check on that head immediately in the same pass (once per cleared red, bypassing the interval), so a green confirmation records the full verdict and a red one opens a new spell.
- `knownMainFailures` and `onlyKnownMainFailures` read the open set while a spell is open, so a role's `<main-known-red>` note stops naming a test a later head showed passing.
- Extend the `main_check` event's comment and payload in src/events/events.ts with `cleared: true`.
- docs/how-it-works.md describes per-head narrowing and clearing. docs/invariants.md gains INV-DA4 directly after INV-DA3: an open red is narrowed and cleared by re-running only its failing tests, and a clearing starts one confirming full run; its **Binds** names the spell map and its **Pinned by** names the new tests.

**Files touched.** src/baseline/main-watch.ts src/events/events.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts

**Acceptance criteria:**
- While red, a new head runs one `rerun` of the open failures and no full run.
- A test that passes on the new head leaves `knownMainFailures` (and the `<main-known-red>` note) on that head.
- When every open test passes, `main_check` is `{ status: "passed", cleared: true }`, no full green is written, and a full run starts though the hour has not passed.
- `redeployTarget` does not target the cleared head until that confirming full run is green.
- A confirming full run that turns red opens a red spell on that head rather than leaving the cleared one open.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch-failures.test.ts: a new head re-runs only the open failures, and `knownMainFailures` drops a test that passes there; an empty set logs `cleared: true`.
- test/main-watch-spells.test.ts: clearing closes the spell and starts the confirming full run though the hour has not passed; the confirming run's green makes the head deployable and its red opens a new spell.
- test/main-watch.test.ts: the cleared head is not deployable before the confirming run.
- Run those files and the gate.

### Hourly full check, part 4/4: Status, doctor and the dashboard say how old main's full verdict is and when the next is due (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires "Hourly full check, part 3b/4 landed"; touches src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts)

**Goal.** Main's badge stops implying the newest commit was fully checked. With the full check hourly, `mainCheckForPoll`'s status reads up to an hour behind main. Every surface that shows it says which SHA it covers, how long ago it ran, and when the next run is due (or "due now" after a cleared red).

**Approach.**
- `MainCheckStatus` (src/status/status-polls.ts) gains the full verdict's `checkedAt` and `nextDueAt`. `nextDueAt` comes from part 2/4's interval and part 3b/4's cleared-red start.
- `mainCheckBadge` (src/ui/badges.ts) renders "full check green at abc1234, 23 min ago · next in 37 min". A cleared red reads "cleared at def5678 · full check running".
- The TUI line (status-render.ts) and the dashboard card (gui-client-team.ts) use the same payload fields (status-payload.ts). No new alert or doctor row: the existing main-check row carries the text.
- docs/how-it-works.md names what the badge shows.

**Files touched.** src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts

**Acceptance criteria.**
- With a full green 23 min old and a 60 min interval, `tumwater status`, the TUI and the dashboard show the covered SHA, "23 min ago" and "next in 37 min".
- After a cleared red, they show the clearing head until its full run settles.
- No new alert builder or doctor row exists.
- `npm run test:gate` passes.

**Tests.** test/status-polls.test.ts: `nextDueAt` from the interval and from a cleared red. test/status-render.test.ts and test/gui-client.test.ts: the badge text for green, red and cleared. Run those files and the gate.

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

### Subtract verify collapse, part 3b/5: The merge queue's head runs its gate and merge in one task; the drain stops starting verifications and stops populating the approved/verifying maps (planned 2026-11-04 by the plan role, splitting the 2026-11-03 Subtract verify collapse part 3/5 after feature held it too large for one run; requires Subtract verify collapse part 3a/5 landed; touches src/merge/merge-drain.ts src/merge/merge-core.ts src/merge/merge-pipeline.ts src/orchestrator/orchestrator-poll.ts test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts)

**Goal.** A queued entry goes from the queue to the gate to the merge in one task: `drainMerge` takes the queue head and starts one task whose `mergeApprovedChange` runs `reviewQueuedChange` in the merge worktree before `mergeToMain`, settles the outcome, queues the post-merge review on a `merged` event as today, and continues to the next head one at a time. The drain no longer calls `drainVerify`, and neither `p.approved` nor `p.verifying` is populated. Torn-head recovery, the already-merged dedupe, `notBefore`, `liveRoles` and `startHeld` checks move from the verify drain into the serial drain; the withdrawn check runs before the gate. A rejected entry settles as today. The verify modules and map types remain in place until part 3c/5 deletes them.

**Approach.**
- merge-core.ts: in `mergeApprovedChangeIn`, check the withdrawn entry (`withdrawnPinReason` plus `dropWithdrawnPin`, as `mergeToMain` does) and run `reviewQueuedChange(ctx, req, wt, ctx.state, ctx.foldUsage)` before `mergeToMain`; return its result when it is not an approval, otherwise merge the approved head. Update `mergeApprovedChange`'s "already passed its own gate" comment to say it runs the queued change's one gate.
- merge-drain.ts: `drainMergeQueue` stops calling `drainVerify` and keeps `drainPostReviews` plus `drainMerge`. `drainMerge` takes the head from the queue after `dropTornHead`, the dedupe against main, `notBefore` and `liveRoles` checks (moved from `drainVerify`), resolves the author, and starts one single-change task. The task calls `mergeApprovedChange`, settles each outcome through `settleMergeOutcome`, queues the post-merge review on `merged`, and handles user abort and shutdown as today. Delete the `approved`/`verifying` branches; `settleAbortedApproved` may remain as an empty-map no-op until part 3c/5 deletes it.
- merge-pipeline.ts: keep the type fields for now; update the comments so the pipeline is described as one serial head task plus the post-review task. `mergeTasks`/`abortableMerges` continue to compile over the empty maps.
- src/orchestrator/orchestrator-poll.ts: keep the `settleAbortedApproved` import and call for now (it iterates an empty map) or remove the call and leave the function for part 3c/5; do not remove the export yet.
- Delete test/merge-drain-verify.test.ts with its pooled-slot verification subject.
- test/fixtures/orchestrator-fixtures.ts's `mergeHead` drives the queue head through `drainMergeQueue` (or the one merge task) instead of `startVerify` plus `drainMerge`; test/fixtures/merger-fixtures.ts's `verifyAndMerge` becomes one `mergeApprovedChange` call (the gate runs inside it).
- Update test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts and test/merger.test.ts to the one-step path: no approved/verifying map assertions; the approved-abort cases become abort-the-one-merge-task cases that keep the rest queued; merge-ahead-of-a-held-head and rejection-while-another-verifies cases are removed with their serial impossibility.

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start or approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `drainMergeQueue` no longer calls `drainVerify`; the drain no longer writes `p.approved` or `p.verifying`. The withdrawn/dedupe/torn-head/notBefore/liveRoles/startHeld checks still run in the serial drain.
- test/merge-drain-verify.test.ts is gone with its subject; the surviving merge-drain and pipeline tests drive an entry from queue to merge.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Update test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts and test/merger.test.ts to drive an entry from queue to merge without the verify/approved map, and update both fixtures' merge drivers to the same path. Run those files and the gate.

### Subtract verify collapse, part 3c/5: The verify-stage modules and the now-empty approved/verifying maps are deleted; direct callers use the one-step merge (planned 2026-11-04 by the plan role, splitting the 2026-11-03 Subtract verify collapse part 3/5 after feature held it too large for one run; requires Subtract verify collapse part 3b/5 landed; touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-head.ts src/merge/merge-queue.ts src/orchestrator/orchestrator-poll.ts test/merge-requeue.test.ts test/runner-revision.test.ts test/merge-withdrawn.test.ts test/fixtures/merger-fixtures.ts test/fixtures/merge-fixtures.ts)

**Goal.** The verify stage and its maps are gone: `merge-verify.ts` and `merge-batch.ts` are deleted, `MergePipeline` is `{ merge, postReview }`, `settleAbortedApproved`, `liveRoles` and `ApprovedMerge` are deleted, and the orchestrator's per-poll approved-abort settle call is removed. The requeue tests drive `notBefore` and the failed-drop dedupe through `drainMergeQueue`; `runner-revision.test.ts` and `merge-withdrawn.test.ts` call `mergeApprovedChange` (which now runs the gate) and assert its `RunResult` and state bookkeeping instead of a `VerifyVerdict`. No production module imports a verify-stage symbol.

**Approach.**
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts. Move any surviving type or helper a direct caller still needs into merge-core.ts or merge-drain.ts; do not keep a verify module under a new name.
- merge-pipeline.ts: `MergePipeline` becomes `{ merge, postReview }`; `newMergePipeline` returns those; delete `ApprovedMerge`, `liveRoles`, and the approved/verifying branches in `mergeTasks`/`abortableMerges`.
- merge-drain.ts: delete `settleAbortedApproved`, the approved/verifying branches and the now-dead imports.
- src/orchestrator/orchestrator-poll.ts: remove the `settleAbortedApproved` import and its per-poll call.
- merge-head.ts and merge-queue.ts: update comments that name `drainVerify`/the verify stage to the serial drain; no behavior change.
- test/merge-requeue.test.ts: replace the two `drainVerify` calls with `drainMergeQueue`, keeping the same `notBefore` (entry stays queued) and failed-drop (warning, entry left for the next poll) expectations.
- test/runner-revision.test.ts and test/merge-withdrawn.test.ts: replace `verifyRequest(ctx, req, w)` with `mergeApprovedChange(ctx, req)` and adapt the assertions from `VerifyVerdict` to the returned `RunResult` plus the same revision/withdrawn state. Keep the revision-round, backstop, director and withdrawn-pin coverage; do not delete a case whose subject survives.
- test/fixtures/merger-fixtures.ts: remove the `verifyRequest`/`BatchRoleWiring` imports and the `batchWiring` helper once no caller remains.
- test/fixtures/merge-fixtures.ts: `allTasks` reads only `p.merge` and `p.postReview`; the busy-slot stand-in and its WeakSet stay.

**Acceptance criteria.**
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|ApprovedMerge\|p\.verifying\|p\.approved' src/` prints nothing, and `ls src/merge/merge-verify.ts src/merge/merge-batch.ts` fails.
- `MergePipeline` has only `merge` and `postReview`; `newMergePipeline` returns those; `settleAbortedApproved` and `liveRoles` are gone.
- test/merge-requeue.test.ts's two former `drainVerify` cases run through `drainMergeQueue` with the same `notBefore` and failed-drop expectations.
- test/runner-revision.test.ts and test/merge-withdrawn.test.ts drive `mergeApprovedChange` and keep their revision and withdrawn assertions.
- `npm run test:gate` passes.

**Tests.** Run test/merge-requeue.test.ts, test/runner-revision.test.ts, test/merge-withdrawn.test.ts and test/merger.test.ts, then the gate.

### Subtract verify collapse, part 4/5: The `approved` in-flight status and the status, GUI and queue surfaces that wait on it are removed (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires Subtract verify collapse part 3c/5 landed; touches src/merge/merge-slot.ts src/merge/merge-queue-render.ts src/ui/status-model.ts src/ui/gui/gui-client-model.ts src/cli/help.ts test/merge-slot.test.ts test/status-model.test.ts test/status-data-inbox.test.ts test/gui-client.test.ts test/help.test.ts test/team-alerts.test.ts test/merge-queue.test.ts test/status-polls.test.ts)

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

### Subtract verify collapse, part 5/5: docs/how-it-works.md and docs/invariants.md describe one gate-then-merge step and bind only modules that survive (planned 2026-11-03 by the plan role, splitting the 2026-10-31 too-large Subtract part 3c/7 after feature held it too large for one run; requires part 4/5 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md test/invariants-doc.test.ts)

**Goal.** The live prose and invariant bindings describe the landing that exists after parts 1/5–4/5: a queued pin is gated in the merge worktree (the deterministic diff rules plus the declared gate command), then rebased and fast-forwarded under the merge lock; no sentence promises a separate verify stage or an approval wait. The post-landing review and the main watch keep their guarantees.

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

### Subtract, part 3d/7: `tumwater queue`, its cancel/top keys and the browser queue controls go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract verify collapse part 4/5 landed; touches src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts)

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

### `tumwater history <role> <n>` gains `-f/--follow`, repainting one run's event trail until Ctrl+C or its parent exits, so an operator watching a run sees its events arrive and its merge verdict land without rerunning the command (planned 2026-11-04 by the plan role; continues the landed follow-view family — `status`, `report`, `logs`, `history` (the listing), `queue`, `reviews`, `quarantine`, `backlog`, `diff`, `prompt --list` and `questions` all follow through `followView` in src/cli/follow-view.ts, and the in-flight `role <id>` follow takes the remaining per-entity view; `history <role> <n>` is the remaining per-run inspection view with no live form; independent in file of every `## Planned` entry — the in-flight `role <id>` follow takes src/cli/cli-role-command.ts, the blocked `Subtract` parts take src/merge, src/runner, src/status, src/doctor, src/config, src/baseline, src/review, src/run and src/ui, and the in-flight `Hourly full check` parts 3a/4 and 3b/4 take src/baseline, src/merge and src/status; none takes src/cli.ts's `runTrailCommand` or src/history/run-detail.ts; the in-flight `role <id>` follow and this plan both touch src/cli/help.ts and docs/cli.md in different stanzas and rows, so whichever lands second rebases there; PLANS-DONE.md holds no `history <role> <n>` follow plan (`grep -cE '^### .*history <role> <n>.*follow|^### .*follow.*history <role> <n>' PLANS-DONE.md` prints 0) and its `run-detail` headings are behavior additions or splits, never a follow; docs/invariants.md names neither `cmdRunDetail` nor src/history/run-detail.ts (`grep -c 'cmdRunDetail\|run-detail.ts' docs/invariants.md` prints 0), so its bindings stay unchanged; touches src/cli.ts src/history/run-detail.ts src/cli/help.ts docs/cli.md test/run-detail-follow.test.ts)

**Goal.** `tumwater history <role> <n>` prints one run's full event trail and exits. An operator watching a live team has no live form: a run's events arriving as it works, a run's merge verdict changing from `queued` to `merged`, or its landed sha appearing stays invisible until the command is rerun. Add `-f/--follow` so the same document repaints every couple of seconds until Ctrl+C or the parent process exits. The live form is read-only: `--json` keeps its one-shot form and is refused with a follow. A follow pins the run it resolves on its first frame (including `--last`'s newest completed run); later runs are not followed.

**Approach.**
- src/cli.ts: in `runTrailCommand`, add `FOLLOW_FLAG` to the `rejectUnknownArgs("history", rest, [...])` vocabulary (it already admits `JSON_FLAG` and the trail flags), import `hasFollowFlag` from src/cli/cli-flag-specs.ts and `failFollowJsonRival` from src/cli/cli-args.ts, compute `follow = hasFollowFlag(rest)`, and pass it to `cmdRunDetail`'s options. Refuse `--json` with a follow using `failFollowJsonRival("history --json")` before dispatch. The hidden `tick` alias shares `runTrailCommand`, so it gains the same follow.
- src/history/run-detail.ts: `cmdRunDetail` takes the new `follow` option. After `resolveRunDetailTarget` resolves a run, call `followView` from src/cli/follow-view.ts with a frame callback that re-runs `readRunDetail(root, role, runNumber)` and `emitRunDetail`'s rendering (including `--stat`, `--patch`, `--transcript`, `--prompt`, `--grep`), so each frame shows the run's current trail. The follow path returns after the loop; the one-shot path is unchanged. A not-found run stays the one-shot not-found line and exits without entering the loop.
- src/cli/help.ts: the `tumwater history <role> [<n>] ...` usage spelling gains `[-f/--follow]`, and the description gains one clause — repaints the run's trail every couple of seconds until Ctrl+C or the parent exits, and refuses `--json` because the live form is read-only. docs/cli.md's "Watch run history" row gains the same clause.

**Files touched.** src/cli.ts src/history/run-detail.ts src/cli/help.ts docs/cli.md test/run-detail-follow.test.ts

**Acceptance criteria.**
- `tumwater history bugfix 3 -f` and `tumwater history bugfix 3 --follow` print the run's trail once, then repaint it every couple of seconds until Ctrl+C or the process that started them exits; a run still in flight gains new events between frames, and a run whose merge finishes shows its merge verdict and outcome line in the next frame. On a TTY each frame clears the screen; a piped follow separates frames with a blank line.
- `tumwater history bugfix 3 -f --json` exits 1 with the shared follow-vs-JSON refusal wording and prints no frame or JSON document.
- A follow that ends by parent death exits 0; the one-shot forms keep their existing exit codes and output.
- Without a follow flag, `tumwater history <role> <n>` and its `--last`, `--stat`, `--patch`, `--transcript`, `--prompt`, `--grep`, `--result`, `--model`, and `--json` forms print exactly the text or JSON and exit code they print today.
- `grep -n 'tumwater history <role> \[<n>\].*\[-f/--follow\]' src/cli/help.ts docs/cli.md` finds the usage spelling in both files.
- `npm run test:gate` passes.

**Tests.** New test/run-detail-follow.test.ts, modelled on test/cli-role-follow.test.ts and test/status-follow.test.ts: drive `cmdRunDetail` in-process with `FollowViewSeams` and node:test's mocked `setInterval`, proving the first frame, repeated repaints, an in-flight run gaining events between ticks visible in the next frame, the TTY clear-screen versus piped blank-line shape, the parent-death exit with `process.exitCode` left at 0, and the `--json` refusal. Run that file and the gate.

### `tumwater history --summary` gains `-f/--follow`, repainting the per-role (or `--by model`) tallies as runs finish instead of refusing a live form, so an operator watching a team sees run counts, outcome buckets, tokens and cost move without rerunning the command (planned 2026-11-04 by the plan role; continues the landed follow-view family — the row listing already follows as a stream while `status`, `report`, `logs`, `queue`, `reviews`, `quarantine`, `backlog`, `diff`, `prompt --list` and `questions` repaint through `followView` in src/cli/follow-view.ts, and the in-flight `role <id>` and `history <role> <n>` follows take the remaining per-entity and per-run views; independent in file of every eligible `## Planned` entry — before this entry no waiting heading named `src/history/history.ts` (`grep -c 'src/history/history\.ts' PLANS.md` printed 0), the in-flight `history <role> <n>` follow takes src/history/run-detail.ts and src/cli.ts, the in-flight `role <id>` follow takes src/cli/cli-role-command.ts, and the blocked and in-flight `Subtract`/`Hourly full check`/duplicate-plan parts take src/merge, src/runner, src/status, src/doctor, src/config, src/baseline, src/review, src/run, src/ui and src/stage; this plan and the in-flight `history <role> <n>` follow both extend docs/cli.md's one `Watch run history` row and src/cli/help.ts's history stanza, so whichever lands second rebases there; PLANS-DONE.md holds no live-summary plan — `grep -cE '^### .*history.*--summary.*follow|^### .*follow.*--summary.*history' PLANS-DONE.md` prints 0 (its other `history --summary` headings add the `peak ctx` column, `--model`, `--until` and the TUI/dashboard summaries, never a follow) and its `history -f` entry is the row stream; docs/invariants.md names neither `cmdHistory` nor src/history/history.ts (`grep -c 'cmdHistory\|history\.ts' docs/invariants.md` prints 0), so its bindings stay unchanged; touches src/history/history.ts src/cli/help.ts docs/cli.md test/history-follow.test.ts)

**Goal.** `tumwater history --summary` prints one line per role (or per model with `--by model`) counting runs, outcome classes, tokens, cost, run time, peak context and newest change, then exits. It is the comparison view an operator uses to see where the team's runs and spend go, and it is the one remaining bounded history view with no live form: `history -f` streams rows, but `history --summary -f` is explicitly refused as a rival shape, so watching a tally move means rerunning the command. Add the live summary: with `-f/--follow`, the same table repaints every couple of seconds until Ctrl+C or the parent process exits, re-reading the same bounded row set (the last `-n` runs, default 20) so a finished run joins the tally and the oldest row rolls off exactly as a rerun would show. The live form is read-only: a repainting document has no parseable stream, so `--json` is refused with it. `--since` stays a rival as it is for the row follow.

**Approach.**
- src/history/history.ts: remove the `--summary` clause from `parseHistoryQuery`'s follow rival check (keep the `--since` one), so `-f --summary` proceeds. Extract the collect-and-filter body `cmdHistory` already runs — `collectHistoryRows` plus `--grep`, `--result` and `--model` — into one helper returning `{ rows, covered, filtering }`, so the one-shot path and each follow frame apply exactly the same filters. Extract the one-shot non-JSON rendering from `sayHistory` into a pure `historyText(rows, q, covered, filtered)` built from the existing `sayHistoryRows`/`sayHistoryEmpty` bodies (returning text instead of calling `say`), leaving `sayHistory` as the `--json` payload branch plus `say(historyText(...))` so the one-shot text and JSON are byte-identical.
- New `followHistorySummary(root, q, seams, byModel)` beside `followHistory`: validate `historySummaryGroup(q)` once before entering the loop (so a bad `--by` fails with its one-shot wording instead of being swallowed by the follow's per-frame catch), refuse `--json` with `failFollowJsonRival("history --summary --json")`, then `await followView(() => historyText(collectFilteredHistoryRows(root, q)...), seams)`. Each frame re-reads the last `-n` rows through `readRunRows`, so a run that ends between ticks appears in the next tally and a row pushed past the count rolls off. Add an optional `tty` to `cmdHistory`'s seam parameter (the `followView` seam) so tests can drive the TTY and piped frame shapes; `followHistory` keeps its existing streaming path.
- src/cli/help.ts and docs/cli.md: the history stanza/row no longer says `-f` is unavailable with `--summary`; it says `-f` with `--summary` repaints the tally every couple of seconds until Ctrl+C or the parent exits, and refuses `--json` because the live form is read-only, while `-f` without `--summary` keeps streaming rows. `--since` stays refused with any follow.

**Files touched.** src/history/history.ts src/cli/help.ts docs/cli.md test/history-follow.test.ts

**Acceptance criteria.**
- `tumwater history --summary -f` and `tumwater history --summary --follow` print the summary table once, then repaint it every couple of seconds until Ctrl+C or the process that started them exits. A run that ends between frames changes the next frame's runs/changes/none/refused/problems counts, tokens and cost; once `-n` rows are present, a newly finished run enters the tally while the oldest scanned row drops out, so the totals are the same a fresh `tumwater history --summary -n <n>` would print at that moment. On a TTY each frame clears the screen; a piped follow separates frames with a blank line.
- `tumwater history --summary --by model -f` repaints the per-model table (`(unknown)` for null buckets), and its next frame moves when a run on a listed model finishes.
- `tumwater history --summary -f --json` exits 1 with the shared follow-vs-JSON wording (`prints one document; -f/--follow repaints a live view — drop one of them`) and prints no frame, clear-screen escape or JSON document. `tumwater history --summary --since 1h -f` still exits 1 naming both rival flags.
- `tumwater history --summary --by bogus -f` exits 1 with the same `--by` error one-shot `tumwater history --summary --by bogus` prints, before any frame.
- `--role`, `--grep`, `--result`, `--model` and `-n` keep filtering each repainted summary exactly as they filter the one-shot summary: a run appended between frames changes the tally only when it passes those flags.
- An empty log's follow prints the one-shot empty-state prose (`no runs yet` for the plain summary) as its first frame and replaces it with the table once a run lands; a follow that ends by parent death exits 0.
- Without `-f`, every `history --summary` form (plain, `--by model`, filtered, empty, and `--json`) prints exactly the text or JSON and exit code it prints today, and `history -f` without `--summary` still streams one row per finished run exactly as today.
- Reading `tumwater help history` and docs/cli.md's Watch run history row, both describe `-f` with `--summary` as repainting the tally and refusing `--json`; neither says a follow is unavailable with `--summary` (the docs row no longer carries its `(not with --since or --summary)` parenthetical, and the help stanza no longer says a follow is not for `--summary`).
- `npm run test:gate` passes.

**Tests.** Update test/history-follow.test.ts (it already drives `cmdHistory` in-process with the follow's parent-death and interval seams): replace the `--summary` rival case with a live-summary case that seeds runs, waits for the first frame, appends a run that ends, and proves the next frame's counts update; add a `--by model` frame change, a filter case (`--role` and `--result` keep a non-matching appended run out), the `--json` refusal, the bad-`--by` refusal before any frame, the empty-log first frame becoming a table, and the piped blank-line frame shape. Run that file and the gate.

## Done
