# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 4i/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/runner-leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

**Previously held 2**

**Needs review 2026-10-29 by feature: too large for one run** — the `main_red` verdict removal alone ripples across ~35 src/ files (beyond the files-touched list: run-outcome.ts, tone.ts, gui-client-model.ts, failure-time-spend/render/data/state-change.ts, event-labels/notify/format/events.ts, cli-start-summary.ts, fallback-breaker.ts, runner-state + runner-state-load.ts, runner-leftover.ts, runner-recovery.ts, orchestrator-poll.ts, review.ts + review-precheck.ts, status-polls.ts, doctor-holds.ts, run-finalize.ts, run-prompt.ts, report-*.ts, pending-prompt.ts, baseline/main-red.ts, main-guardrails.ts, main-baseline.ts, main-watch.ts, redeployer.ts, build-check-*.ts, config.ts, merge-verify.ts, merge-queue.ts) and 39 test files; the entry's files-touched list names only 12 src files. The batch/stack/bisect deletion (merge-to-main.ts + merge-batch.ts + merge-stack.ts + merge-drain.ts + merge-core.ts + tests) is a separable piece; removing the `main_red` verdict from RunResult (with its state/poll/doctor/gui/events/failure/report/runner ripples) is another. The plan role should split 3f/3 along those lines.

**Needs review 2026-10-29 by feature: too large for one run**

**Goal.** With the watch verifying every new tip, the checks that stood in front of a landing are redundant. Delete the merge slot's in-lock build re-check and the batch check with its largest-passing-prefix bisect, so a merge is: rebase onto the tip, take the fast-forward under the merge lock. A broken commit then sits on main between its landing and the watch's fix, which is the `ci` healer's job.

**Approach.**
- Delete the in-lock re-check from `mergeApprovedChange` (src/merge/merge-to-main.ts): the `runScopedBuildCheck`/`mergeCommand` run and its `merge_blocked` cause. The fast-forward, the conflict resolver, the dirty-checkout refusal and the `MERGE_CONFLICT_LIMIT` hand-back stay (a conflicted tree cannot be landed).
- Delete the batch path from `mergeApproved` (src/merge/merge-batch.ts): the shared scope-`batch` check, its `BATCH_RESTACK_ATTEMPTS` re-stack and its per-pick bisect/fallback, and whatever in `merge-stack.ts` only that path used. Every approved change merges one at a time through the now-check-free `mergeApprovedChange`.
- The gate-scope check producers go: `review-precheck.ts`'s build-check reject and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their callers; the merge-side `main_red` keep (`merge-core.ts`), `requeueMainRedPin`'s wait (`merge-requeue.ts`) and leftover's `main_red` wait go with the in-lock verdict that produced them.
- With no producer left, remove the merge verdict `main_red`: `heldByMainRed` and `mainCheckRecovered` (`src/status/status-polls.ts`), the status phase's `main red` label (`src/ui/status-model.ts`) and the doctor's held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`) go; the red-main warning that names an unheld red stays.
- Keep the two rules part 3h/3 left pre-merge (secret leaks and protected edits) and the refusals that are not quality verdicts: the dirty-checkout pre-flight (`merge-to-main.ts`), a rebase conflict and its hand-back, a lost fast-forward race, and the startup/redeploy stage check.
- Docs: docs/how-it-works.md's merge paragraph says a merge is a rebase and a fast-forward; docs/invariants.md's merge-check guarantees are re-pointed to the watch.

**Files touched.** src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/runner-leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts

**Acceptance criteria.**
- A merge runs no build check: the merge slot's per-change work is the rebase, the commit and the fast-forward, and the only pre-merge refusals left are a dirty or conflicted tree, a secret leak and a protected edit.
- `mergeApproved` has no batch/stack/bisect path; every approved change is merged through the one-change `mergeApprovedChange`.
- No run or merge verdict is `main_red`; the status `main red` label and the doctor's held-code-role list are gone, while the red-main warning stays.
- `npm run test:gate` passes.

**Tests.**
- test/merge-to-main.test.ts: `a merge runs no gate command` — with a declared check, no build-check run starts and the fast-forward lands; the dirty-checkout and conflict cases stay.
- test/main-red.test.ts: `heldByMainRed is gone` — no code role is reported held by main's redness, and the unheld red warning still renders.
- test/merge-verify.test.ts: the batch/stack cases are dropped; one-change merges still land.

### Subtract, part 3/6: The merge queue becomes a lock and a fast-forward (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 3; requires Every commit is verified on main part 3f/3 landed; touches src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts)

**Goal.** A change lands as `pin → rebase onto main → fast-forward under the merge lock`. The queue, its stage machine, the coalesced batch check with its prefix bisect, the re-queue, the entry drop limits and the scheduling interlock are gone, because nothing about landing can fail any more: verification moved after the merge (part 3f/3), and a break is an ordinary open bug owned by the author.

**Approach.**
- Delete the queue and its stages: src/merge/merge-queue.ts, merge-queue-render.ts, merge-requeue.ts, merge-cancel.ts, merge-pipeline.ts, merge-slot.ts, merge-drain.ts, merge-batch.ts, merge-stack.ts, and the `.tumwater/merge-queue/` directory with its `uncommitted backlog`-style checks.
- `merge-core.ts` and `merge-to-main.ts` keep the pin read, the rebase, the merge lock and the fast-forward; the conflict-resolution pi run stays as the one non-deterministic step. `MERGE_CONFLICT_LIMIT` and the entry attempt/drop limits go: a conflict whose resolution fails comes back as a `**Needs review …**` note naming the conflict (the two surviving holds' vocabulary).
- Delete the scheduling interlock: `queuedRoles` (orchestrator-scheduling.ts), its legs in scheduling-skip.ts and scheduling-scope.ts, and `mergeStartHeld`'s merge half (orchestrator-poll.ts). A role whose change is merging authors its next run, as plans/interlock-relief.md's per-role tiering intended for the low-blast-radius roles only.
- Delete the check permit with the in-lock and batch checks it served (src/concurrency/check-permit.ts) and the three contention rows and the `capacity bottleneck` alert (part 1d/6 removes the alert; doctor-contention-checks.ts keeps `slot_wait`/`provider_wait` only if part 4/6 has not yet removed the pool).
- docs/how-it-works.md's merge-pipeline section and docs/invariants.md's cross-process invariants (INV-CT1 and the merge-slot guarantees) say what replaces the queue: one lock, linear history, and the post-landing check.

**Files touched.** src/merge src/orchestrator/orchestrator-poll.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-skip.ts src/orchestrator/scheduling-scope.ts src/runner/runner-run.ts src/status/status-data.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/concurrency/check-permit.ts docs/how-it-works.md docs/invariants.md test/merger-restack.test.ts test/merge-backlog-conflicts.test.ts test/worktree-pool.test.ts

**Acceptance criteria.**
- A code change's log path from run end to main is `merge_queued → merged`, with no stage events and no second check run; `build_check` events per merged commit are 1 (the post-landing one).
- Two roles land back to back with no interlock: the second role's run starts while the first's merge is in flight, and neither waits on the other's check.
- A conflicting change comes back to its author as one `**Needs review …**` note; nothing is dropped from a queue, because there is no queue.
- No `.tumwater/merge-queue/` directory is written; the doctor's `stale merge-queue entries` and `merge-queue files` rows are deleted (doctor-check-names.ts) rather than left to warn about a path nothing writes.
- `npm run test:gate` passes.

### Subtract, part 4/6: One runner per role — the instance claims and the worktree pool go (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes", stroke 4, and its measurement gate; requires Subtract part 3/6 landed; touches src/config/config-schema.ts src/config/config.ts src/config/config-validation.ts src/roles/runner-ids.ts src/scheduling/claims.ts src/scheduling/claim-entries.ts src/backlog/backlog-index.ts src/git/worktree-pool.ts src/git/worktree-pool-startup.ts src/git/slots-state.ts src/git/worktree-use.ts src/git/slot-salvage.ts src/doctor/doctor-contention-checks.ts src/ui/status-payload.ts docs/config.md test/worktree-pool.test.ts test/retention.test.ts)

**Goal.** One runner id per role and one persistent checkout per role. `instances`, the instance claims and the slot pool existed to keep a role authoring while its own change merged (fast-merge measured 60% of role time waiting); with landing in minutes that wait is not the constraint, and the pool's own costs — slot waits, pins, stale claims, salvage — go with it.

**Approach.**
- **Measure first, and record it.** Before changing code, read the day report and the log for the week after part 3/6 landed: end-of-run → on main p50/mean/p90 (`merge_done`), `slot_wait` count and total, and red-main minutes (`main_check`/`main_red_hold`). If p90 is at or under ~15 minutes with one runner per role, proceed; if not, hold this part with a `**Needs review …**` note quoting the numbers instead of deleting capacity on a prediction.
- Delete the `instances` key (config-schema.ts, config.ts, docs/config.md) and `INSTANCE_ROLES`; `runnerIds` (src/roles/runner-ids.ts) returns the configured roles, one runner each.
- Delete the claims (src/scheduling/claims.ts, src/scheduling/claim-entries.ts) and their readers (backlog-index.ts's live-claim marks, status-payload.ts's instance pool, the `parallel instances` doctor row); a role claims an entry by working on it in the run that picked it up.
- Delete the pool (src/git/worktree-pool.ts, worktree-pool-startup.ts, slots-state.ts, worktree-use.ts, slot-salvage.ts) and the `slot_wait` event; a role keeps one worktree through src/git/worktree.ts's ensureWorktree, which already self-heals a dead registration.
- Delete the pool rows and their inputs: doctor's `workspaces` (pool half), `parallel instances`, `tumwater pins`' pool wording, and `slotCount`.

**Files touched.** src/config/config-schema.ts src/config/config.ts src/config/config-validation.ts src/roles/runner-ids.ts src/scheduling/claims.ts src/scheduling/claim-entries.ts src/backlog/backlog-index.ts src/git/worktree-pool.ts src/git/worktree-pool-startup.ts src/git/slots-state.ts src/git/worktree-use.ts src/git/slot-salvage.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/ui/status-payload.ts docs/config.md docs/how-it-works.md test/worktree-pool.test.ts test/retention.test.ts

**Acceptance criteria.**
- One runner id per configured role; `tumwater status --json` carries no instance-pool or slot fields, and a run leases no slot.
- `tumwater.json` with `instances` set is refused by validation naming the deleted key (the same treatment the other deleted keys get in parts 5a/6–5h/6), not silently ignored.
- The measured p90 end-of-run → on main from the gate above is quoted in the part's PLANS-DONE entry, so the deletion's premise is on the record.
- `npm run test:gate` passes.

### Subtract, part 6/6: The sweep — the rows, keys and docs the five parts left behind (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes" and "How we will know it worked"; requires Subtract part 1e/6, Subtract part 4/6, Subtract part 5v/6 and Subtract part 5x/6 landed, the ends of every remaining Subtract chain — a clause the operator added 2026-10-28 after feature refused this part for running ahead of them, re-pointed from part 5q/6 to part 5d/6 the same day when the user withdrew the budget-fallback removal and the tier map; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts)

**Goal.** The deletion reads as one system. Every name parts 1/6–5/6 removed is gone from the live docs, the example config, the doctor's row list, the alerts and the tests that assert them; the archive keeps the record.

**Approach.**
- Sweep the deleted names out of the live prose and the example config: `instances`, `slotCount`, `slot_wait`, `check_wait`, `maxConcurrentChecks`, `mergeBatchMax`, `mergeCommand`, `review.afterMerge`, `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `slot salvage`, `merge queue`, `interlock`, `held-for-operator`, `Needs replan`, `Waiting for the next failure`, `(held N)`.
- Delete the rows and tests rather than re-pointing them: a case whose whole subject is a deleted mechanism goes (the existing wording/implementation tests rule: never re-pin), and test/doctor-checks.test.ts's row list, test/event-format.test.ts's deleted event types (`slot_wait`, `check_wait`, the merge-stage events), test/retention.test.ts's pool artifacts and test/config.test.ts's deleted keys are updated to the surviving row/key set.
- Re-check the parts 1a–1e/6 rule end to end: for every condition that used to have a banner and no longer does, the doctor row exists; for every row this series deleted, the mechanism is gone.
- docs/invariants.md drops or re-scopes the invariants of deleted subsystems (merge-slot, pool, permit, instance claims, provider caps, subscription windows) in the same commit, per the standing rule; the tiers, the budget fallback and the image reroute stay (user, 2026-10-28), so their invariants stay too.
- Record in the part's PLANS-DONE entry: the doctor row count and the config key count before and after the series, and the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts PLANS.md test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentChecks|maxConcurrentPerProvider|mergeBatchMax|mergeCommand|instances|slot_wait|check_wait|claudeWindowReserve|review\.afterMerge|held-for-operator' src/ docs/ README.md DEVELOPMENT.md tumwater.example.json` finds no live reference (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every doctor row name in doctor-check-names.ts resolves to a check that reads a mechanism that still exists; no row reports a path nothing writes.
- The before/after row and key counts, and the deletions' measurement premise, are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

### `describeStateChange`'s 36-case transition switch is replaced by a `STATE_CHANGE_FAMILY` lookup table that `STATE_CHANGE_TYPES` is derived from, so the event-to-wording-family mapping is data with compile-checked keys and the replayed-type set can never drift from the dispatch (planned 2026-10-29 by the plan role; continues the landed split-large-function family — the 2026-10-25 `describeStateChange` plan extracted the eight per-family builders (`budgetStateChange` through `lifecycleStateChange`), leaving this switch as the one 36-label block the eslint one-shot reports at complexity 37; independent in file of every `## Planned` entry — `grep -c 'failure-state-change' PLANS.md` and `grep -c 'failure-state-change' BUGS.md` both print 0 (checked on main), so no heading or blocked-part touches list names `src/failure/failure-state-change.ts`: the in-flight 3d/3 edits src/config src/review/post-merge-review.ts src/cli src/roles src/gui src/ui/gui, Option-2 isolation 1/2 edits test/helpers/wait.ts and the four orchestrator e2e files, 4i/3 edits src/runner/runner-state*.ts src/review/review.ts src/run/run-apply.ts src/events/*, and `onArrow` edits src/ui/tui/tui-editors.ts; the blocked `Every commit is verified on main` parts edit src/review src/orchestrator src/runner src/merge src/baseline src/status src/doctor src/config src/cli src/roles src/gui src/ui src/prompt src/request-timeouts.ts, none src/failure; PLANS-DONE.md's one `describeStateChange` heading (`grep -cE '^### .*describeStateChange' PLANS-DONE.md` prints 1) is that 2026-10-25 per-family builder split, not a lookup-table conversion; `grep -c 'describeStateChange' BUGS.md` prints 0; docs/invariants.md names this module only for `STATE_CHANGE_TOP` (`grep -n 'failure-state-change' docs/invariants.md` prints one line, the `STATE_CHANGE_TOP` cap), which stays; touches src/failure/failure-state-change.ts test/failure-state-change.test.ts)

**Goal.** `describeStateChange` (src/failure/failure-state-change.ts) dispatches 36 transition event types to eight per-family builders through one `switch (ev.type)` whose 36 fall-through `case` labels the eslint complexity cross-check reports at complexity 37. The same 36-type list is hand-written a second time as `STATE_CHANGE_TYPES`; the two are kept in sync by hand, and a type present in the set but missing from the switch silently renders its raw event type. Replace the switch with a `STATE_CHANGE_FAMILY` lookup table keyed by `HarnessEvent["type"]`, and derive `STATE_CHANGE_TYPES` from its keys, so the mapping is data, a typo'd key is a compile error, and the filter set cannot drift from the dispatch.

**Approach.**
- In `src/failure/failure-state-change.ts`, add `const STATE_CHANGE_FAMILY: Partial<Record<HarnessEvent["type"], (ev: HarnessEvent) => string>> = { … }` mapping each of the 36 types to its existing family builder (`budgetStateChange`, `pauseStateChange`, `modelStateChange`, `providerHoldStateChange`, `liveConfigStateChange`, `updateStateChange`, `waitStateChange`, `lifecycleStateChange`), in the same family order as today's switch. All eight builders already take `(ev: HarnessEvent): string`, so each is a map value with no wrapper.
- Replace `describeStateChange`'s switch with the family lookup and the unchanged `truncateExample` cap: `return truncateExample(STATE_CHANGE_FAMILY[ev.type]?.(ev) ?? ev.type, STATE_CHANGE_MAX);`.
- Derive the exported filter contract from the table: `export const STATE_CHANGE_TYPES = new Set<string>(Object.keys(STATE_CHANGE_FAMILY));`, and move the existing `STATE_CHANGE_TYPES` doc comment (the why-each-group-is-included reasoning) onto `STATE_CHANGE_FAMILY`. `STATE_CHANGE_EXCLUDED_TYPES`, the eight builders and the `STATE_CHANGE_TOP`/`STATE_CHANGE_MAX` caps are unchanged.
- The map's `Partial<Record<HarnessEvent["type"], …>>` type makes a misspelled key a `tsc` error, and deriving the set makes adding a real event type to the map grow `STATE_CHANGE_TYPES`, which the existing partition test (`STATE_CHANGE_TYPES` + `STATE_CHANGE_EXCLUDED_TYPES` equals `EVENT_TYPE_LABELS`' keys) then checks against the excluded set.

**Files touched.** src/failure/failure-state-change.ts test/failure-state-change.test.ts

**Acceptance criteria.**
- `describeStateChange`'s body is the family lookup plus `truncateExample` and `ev.type` — no `switch` and no `case`; the file's `switch (` count drops from 9 to 8 (the eight per-family builders keep theirs), so `grep -c 'switch (' src/failure/failure-state-change.ts` prints 8.
- `STATE_CHANGE_TYPES` is derived from `STATE_CHANGE_FAMILY`'s keys, so every replayed type has a family and the eslint one-shot no longer reports `describeStateChange` above complexity 20 (was 37); the replacement has one optional call and one nullish fallback, no branch statement.
- Every existing wording is unchanged: `test/failure-state-change.test.ts`'s existing cases pass unedited, including the partition test and each family's byte-exact line.
- `STATE_CHANGE_TOP`, `STATE_CHANGE_EXCLUDED_TYPES` and the eight builders are untouched, and `src/failure/failure-data.ts`'s imports of `STATE_CHANGE_TYPES`/`describeStateChange` are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/failure-state-change.test.ts: add one case pinning the raw-type fallback now that the switch's `default` is gone — `assert.equal(describeStateChange(ev({ type: "run_end" })), "run_end")`. The existing explicit-type list and partition cases stay as they are; they remain the drift guard for `STATE_CHANGE_TYPES`, and each family's wording cases prove the lookup dispatches to the same builder the switch did.

## Done
