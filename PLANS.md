# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3d/3: `review.afterMerge` and every surface that sets or shows it are deleted (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3j/3 landed, since the key no longer changes behavior; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts docs/config.md docs/cli.md test/config.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts)

**Previously held 2**

**Goal.** With every role reviewed after landing (parts 3g/3–3j/3), `review.afterMerge` no longer chooses anything: it is a knob that would move a role between two paths that are now the same. Delete it and the three ways it is set and shown, so the record has one review policy.

**Approach.**
- Remove the key: `REVIEW_KEYS` and the `afterMerge` field in `config-schema.ts`, the naming check in `config-validation.ts`, `reviewedAfterMerge` in `config-views.ts`, `isAfterMergeRole` in `post-merge-review.ts`, the default in `config.ts`, and docs/config.md. An old config carrying it still loads (the path every removed key takes).
- Delete the write surfaces: `tumwater role <id> --review-after-merge`/`--clear-review-after-merge` (`cli-role-command.ts`, `src/cli/help.ts`), the `/api/role-review-after-merge` route and `handleRoleReviewAfterMerge` (`gui-config-commands.ts`, `gui-server.ts`) and the dashboard role drawer toggle with its `runAct` chain (`gui-client-drawer-config.ts`, `gui-client-boot.ts`).
- Delete the read/display surfaces: `role-view.ts`'s `reviewedAfterMerge` field and `role-render.ts`'s row.
- Update docs/cli.md and docs/config.md so no surface names the flag, key or toggle.

**Files touched.** src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts docs/config.md docs/cli.md test/config.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts

**Acceptance criteria.**
- `review.afterMerge` is absent from the schema, a rendered default config, `tumwater config`'s listing and docs; an old config carrying it still loads.
- `tumwater role <id> --review-after-merge`/`--clear-review-after-merge`, the `/api/role-review-after-merge` route and the dashboard drawer toggle no longer exist; `tumwater role <id>` prints no review-after-merge row.
- `npm run test:gate` passes.

**Tests.**
- test/config.test.ts: `review.afterMerge is gone` — absent from the schema, the default and the listing, while an old config still loads.
- test/role-view.test.ts / test/gui-endpoints.test.ts / test/gui-client-drawer.test.ts: drop the review-after-merge cases; assert the flags and route are unknown and the drawer renders no toggle.

### Every commit is verified on main, part 3e/3: the pre-merge reviewer plumbing is deleted — `review-run.ts`, `review-followup.ts` and the review resume state (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3j/3 landed, since nothing calls the reviewer once every role is reviewed after landing; touches src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/request-timeouts.ts docs/how-it-works.md test/review.test.ts)

**Previously held 2**

**Goal.** Parts 3g/3–3j/3 leave the pre-merge reviewer unreferenced; delete it so the gate is one thing and no reviewer prompt, resume session or retry budget lingers.

**Approach.**
- Delete `src/review/review-followup.ts` and `src/review/review-run.ts`. `review.ts` keeps the deterministic rules and build pre-check and builds its `GateResult` without `runReviewer`, `withRuns` and `restoreReviewedHead`; the small helpers it still needs (`reject`/`keep`, the pi-run fields) move into `review.ts` when a reader remains.
- Delete the reviewer resume machinery from `RunnerState` (`reviewResume`, and `REVIEW_RESUME_LIMIT`/`APPROVED_PATCH_IDS_MAX`/`approvedPatchIds` when the deterministic dedupe no longer reads the patch ids) and its healing in `runner-state-load.ts`; keep `lastApprovedHead` while the deterministic same-head dedupe uses it.
- Delete `buildReviewResumePrompt` and the reviewer-only parts of `buildReviewPrompt` from `src/prompt/gate-prompts.ts`; `buildReviewPrompt` stays because `post-merge-review.ts` reads it.
- Drop the `review-followup.ts` mention from `src/request-timeouts.ts`'s comment and update docs/how-it-works.md's review paragraph to name the one post-landing review.

**Files touched.** src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/request-timeouts.ts docs/how-it-works.md test/review.test.ts

**Acceptance criteria.**
- `review-run.ts` and `review-followup.ts` no longer exist; no code imports them, and no reviewer prompt, resume session or no-rerun nudge remains.
- The gate still runs its deterministic rules and build pre-check and returns the same verdicts part 3h/3 established.
- `npm run test:gate` passes.

**Tests.**
- test/review.test.ts: the part 3h/3 deterministic cases still pass with the reviewer files gone; no case imports a review-run/review-followup symbol.

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3e/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/runner-leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

**Previously held 2**

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

### `pollTeamHold`'s complexity-21 provider loop is split so each provider's hold-transition events are read from one named helper — the subscription-window-limited emission, then the opened/lifted `rate_limit_hold`, `subscription_window_reset` and `rate_limit_resumed` — while the loop keeps only the stepping (planned 2026-10-29 by the plan role; continues the landed split-large-function family — the `teamHold`, `seamContextWindow`, `checkModelTripleField` and `readPiDefaultModelUncached` plans, and the in-flight `applyFallbackModel`, `parseConfigKey` and `normalizeInfoFields` plans, each extract one named helper per concern the same way; independent in file of every `## Planned` entry — `grep -c 'team-polls' PLANS.md` and `grep -c 'pollTeamHold' PLANS.md` both print 0, so no entry's touches list names `src/team/team-polls.ts` (the only `src/team` file any `## Planned` entry names is `src/team/team-orchestrator-info.ts`); `grep -o 'team-polls[a-z-]*\.ts' PLANS.md` prints nothing; PLANS-DONE.md records a split of the sibling reducer `teamHold` in `src/team/team-hold.ts` ("`teamHold`'s complexity-17 hold step is split…") but no split of this function (`grep -nE '^### .*pollTeamHold' PLANS-DONE.md` prints nothing); docs/invariants.md's only `pollTeamHold` occurrence is a test-name citation in INV-BG1, so a behavior-preserving private move leaves its bindings on `src/team/team-hold.ts` unchanged; touches src/team/team-polls.ts)

**Goal.** `pollTeamHold` (src/team/team-polls.ts) steps each known provider's `TeamHold` from that provider's own observations and emits that provider's hold-transition events. Its complexity-21 body carries the whole transition event chain inline — a reserve hold hardening into a rejected window, a hold opening (a `rate_limit_hold`, or a once-per-window `subscription_window_limited`), and a hold lifting (a `subscription_window_reset`, or a `rate_limit_resumed` naming the ended hold's kind) — so a reader asking "which event does a provider's transition emit?" reads the stepping loop. Extract the emission into one module-private helper named for the transition, and leave `pollTeamHold` the stepping. No behavior change: every provider sees the identical `teamHold` step and the same events, in the same order.

**Approach.** All edits in src/team/team-polls.ts; move the existing code, do not rewrite it, and move each existing comment with the helper that owns the code it describes. Add two non-exported helpers beside `pollTeamHold`:
- `logSubscriptionWindowLimited(root, provider, pNext, subObs)` — the current `limitedEvent` closure body: the `logEventBestEffort(root, { type: "subscription_window_limited", backend: provider!, …providerFields, windowType: subObs?.windowType, resetsAt: pNext.until })` call, unchanged.
- `logHoldTransition(root, provider, pPrev, pNext, subObs, now)` — the whole `if (pPrev.until !== null && pPrev.kind === "subscription-window" && pPrev.reserve === true && pNext.until !== null && pNext.kind === "subscription-window" && pNext.reserve !== true) … else if (pPrev.until === null && pNext.until !== null) … else if (pPrev.until !== null && pNext.until === null) …` chain, calling `logSubscriptionWindowLimited` where `limitedEvent()` is called today and emitting `rate_limit_hold`, `subscription_window_reset` and `rate_limit_resumed` unchanged. `providerFields` (`provider === undefined ? {} : { provider }`) is computed inside the helper, where its only readers are.

`pollTeamHold` keeps its name, signature, doc comment and return map; its loop body becomes: derive `pPrev`, step `teamHold` into `pNext`, `next.set(provider, pNext)`, derive `subObs`, then call `logHoldTransition(root, provider, pPrev, pNext, subObs, now)`.

**Files touched.** src/team/team-polls.ts

**Acceptance criteria.**
- `pollTeamHold`'s measured complexity is below 15, and `logHoldTransition`'s is too: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/team/team-polls.ts` reports both below 15 (before the change `pollTeamHold` carries complexity 21).
- The two helpers are each declared exactly once and are not exported: `grep -cE '^(export )?function (logSubscriptionWindowLimited|logHoldTransition)\(' src/team/team-polls.ts` prints 2, and `grep -cE '^export (async )?function (logSubscriptionWindowLimited|logHoldTransition)' src/team/team-polls.ts` prints 0.
- `pollTeamHold` keeps its name, signature and doc comment, and every case in `test/team-polls.test.ts` passes unchanged — in particular the event-shape cases "pollTeamHold logs exactly one rate_limit_hold on the crossing, naming kind, roles, holdMs, escalation", "pollTeamHold logs one rate_limit_resumed at the deadline, carrying the ended hold's kind", "pollTeamHold holds provider claude until resetsAt and logs subscription_window_limited once, reset once", "a sub backend holds its own provider and logs subscription_window_limited/reset with backend sub, leaving claude untouched", and the no-event case "pollTeamHold stays event-free while the team is open".
- docs/invariants.md's Team hold section (INV-BG1–INV-BG4) binds `src/team/team-hold.ts` and the test names above, not `pollTeamHold`'s internals, so a behavior-preserving private move leaves the file unchanged: `git diff --stat docs/invariants.md` is empty.
- `npm run test:gate` passes.

**Tests.** No new test: the behavior-preserving split is already pinned by `test/team-polls.test.ts`'s event cases. Run that file, then the project's gate, and confirm green.

## Done
