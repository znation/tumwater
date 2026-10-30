# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3d/3: `review.afterMerge` and every surface that sets or shows it are deleted (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3j/3 landed, since the key no longer changes behavior; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts docs/config.md docs/cli.md test/config.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts)

**Previously held 2**

**Goal.** With every role reviewed after landing (parts 3g/3–3j/3), `review.afterMerge` no longer chooses anything: it is a knob that would move a role between two paths that are now the same. Delete it and the three ways it is set and shown, so the record has one review policy.

**Approach.**
- Remove the key: the `afterMerge` field and its `REVIEW_KEYS` entry in `config-schema.ts`, the `checkStringArray(o, "review.", "afterMerge")` call in `config-validation.ts`'s review block, `validateReviewAfterMerge` and its call in `config-validation-roles.ts`, `reviewedAfterMerge` in `config-views.ts`, and the default in `config.ts`; drop the key from `tumwater.example.json`. Removing it from `REVIEW_KEYS` also drops it from `config-keys.ts`'s `DOTTED_SECTION_FIELDS.review`, so `config set/get review.afterMerge` stops resolving. A config carrying `review.afterMerge` is refused on load, naming the key (`unknown key "afterMerge" in review`), exactly as the removed `maxConcurrentPerProvider` top-level key is (`test/config-validation.test.ts`'s `maxConcurrentPerProvider is refused by name`) and the retired `agent` key is: the key is gone, not tolerated, so the schema, the listing and the docs hold no trace of it. The event field `afterMerge: true` on `review_start`/`review_verdict`/`review_rejected` is unrelated (it labels a post-merge review) and stays.
- Delete the write surfaces: `tumwater role <id> --review-after-merge`/`--clear-review-after-merge` (`cli-role-command.ts`, `src/cli/help.ts`), the `/api/role-review-after-merge` route and `handleRoleReviewAfterMerge` (`gui-config-commands.ts`, `gui-server.ts`) and the dashboard role drawer toggle with its `runAct` chain (`gui-client-drawer-config.ts`, `gui-client-boot.ts`).
- Delete the read/display surfaces: `role-view.ts`'s `reviewedAfterMerge` field and the coupled `reviewEnabled` field it is read beside (both exist only for the drawer/CLI review control), `role-render.ts`'s `- Review: after merge` row, and the drawer's `reviewEnabled`/`reviewedAfterMerge` read. The post-merge drain (`post-merge-review.ts` via `merge-drain.ts`'s `postReviewDue`) already reviews every merged commit whenever `review.enabled` (part 3g/3), so nothing else reads the membership test.
- Refresh the stale citations so no source or doc names the deleted key: the `doctor-project-checks.ts` churn remedy drops "narrow `review.afterMerge` for the noisy role" (no key remains to narrow), and the comments in `merge-pipeline.ts`, `merge-post-review-drain.ts`, `gate-prompts.ts`, `paths.ts`, `events/events.ts`, `events/event-format.ts` and `post-merge-review.ts` stop naming it.
- Update docs/cli.md, docs/config.md and docs/how-it-works.md so no surface names the key, flag or toggle, and the post-merge review reads as the one policy for every role.

**Files touched.** src/config/config-schema.ts src/config/config-validation.ts src/config/config-validation-roles.ts src/config/config-keys.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/merge/merge-pipeline.ts src/merge/merge-post-review-drain.ts src/prompt/gate-prompts.ts src/paths.ts src/events/events.ts src/events/event-format.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts src/doctor/doctor-project-checks.ts docs/config.md docs/cli.md docs/how-it-works.md tumwater.example.json test/config-validation.test.ts test/config-write.test.ts test/config.test.ts test/post-merge-review.test.ts test/cli-operators.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts test/gui-client-boot.test.ts

**Acceptance criteria.**
- `review.afterMerge` is absent from the schema, `defaultConfig()`, a rendered default config, `tumwater.example.json`, `tumwater config`'s listing and the docs; a config carrying it is refused on load, naming the key (`unknown key "afterMerge" in review`), matching the `maxConcurrentPerProvider` precedent. `grep -rn 'review\.afterMerge' src/ docs/ tumwater.example.json` prints nothing (the event field `afterMerge: true` on review events is untouched).
- `tumwater role <id> --review-after-merge`/`--clear-review-after-merge`, the `/api/role-review-after-merge` route and the dashboard drawer toggle no longer exist; `tumwater role <id>` prints no review-after-merge row and the drawer renders no Review row.
- `npm run test:gate` passes.

**Tests.**
- test/config-validation.test.ts: a new `review.afterMerge is refused by name (removed; every merged commit is reviewed)` case asserts the named-key error for a config carrying it, and the existing `modle in review (valid keys: …)` case drops `afterMerge` from the listed keys.
- test/config.test.ts: `review.afterMerge is gone` — absent from the schema, `defaultConfig()` and the listing.
- test/config-write.test.ts / test/cli-operators.test.ts: drop the `config set review.afterMerge` and `role --review-after-merge`/`--clear-review-after-merge` cases; assert the flag and dotted key are unknown.
- test/gui-endpoints.test.ts / test/gui-client-boot.test.ts / test/gui-client-drawer.test.ts: drop the route, boot toggle and drawer cases; assert the route is unknown and the drawer renders no toggle.
- test/role-view.test.ts / test/post-merge-review.test.ts: drop the `reviewedAfterMerge`/`reviewEnabled` and `review.afterMerge` validation cases; assert the fields are absent and the drain queues every merged commit.

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 4i/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/runner-leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

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

### Option-2 isolation, part 1/2: the load-sensitive e2e files wait for a quiet host instead of flaking on a starved one (planned 2026-10-29 by the plan role, split from the Steward queue-gap note 2026-10-29 and the user's option-2 isolate decision; independent of part 2/2 — different files, no `requires`; touches test/helpers/wait.ts test/orchestrator-budget.e2e.test.ts test/orchestrator-resize.e2e.test.ts test/orchestrator-permits.e2e.test.ts test/orchestrator-once.e2e.test.ts DEVELOPMENT.md)

**Goal.** Under host load the load-sensitive e2e files (`orchestrator-budget`, `orchestrator-resize`, `orchestrator-permits`, `orchestrator-once`) can no longer schedule the post-switch child runs their 60 s/150 s waits bound, so the tier goes red on a merely busy machine and the ci role files a bug per member. The record shows more wall-clock bound is a dead end (two 60 s→150 s lengthenings each failed) and that running the tier apart from the full suite is already true and still red. Take the user's option 2 directly — gate these files on a quieter host: a load-sensitive e2e file starts once the host's load-to-cores ratio is at or below the bar the class verified at, and records a deferred (skipped) outcome naming the load when the host stays saturated through a bounded wait, instead of failing a verdict it never had a fair chance to reach.

**Approach.**
- Add `awaitQuietHost(t, waitMs)` to `test/helpers/wait.ts`: it samples `sampleHostLoad` from `src/build/host-sleep.js` (already the one host-load sampler `doctor-contention-checks.ts` and `build-check-scoped.ts` read), returns `true` at once when `load1 <= cpus`, and otherwise polls every few seconds up to `waitMs` (a named constant, default ~5 min) before returning `false`. It takes an injectable sampler defaulting to `sampleHostLoad`, like the doctor's `load` seam, so a test can pin it offline.
- The plan makes deferral explicit, not silent: at the top of each load-sensitive e2e file, `if (!(await awaitQuietHost(t, QUIET_HOST_WAIT_MS))) { t.skip(`host load ${load.load1} on ${load.cpus} cores: e2e deferred, not a verdict`); return; }`. This is dynamic and load-conditioned — the file still runs whenever the host allows — not the static known-flaky exemption list option 3 named.
- The files keep their existing 150 s/60 s wall-clock waits: on a host at or below the bar those holds were verified sufficient, so no bound changes.
- `DEVELOPMENT.md`'s test tier note records the quiet-host precondition beside the e2e serialization note (`docs/how-it-works.md` is left to part 2/2's review paragraph, so the two parts do not edit one file).

**Files touched.** test/helpers/wait.ts test/orchestrator-budget.e2e.test.ts test/orchestrator-resize.e2e.test.ts test/orchestrator-permits.e2e.test.ts test/orchestrator-once.e2e.test.ts DEVELOPMENT.md

**Acceptance criteria.**
- With an injected sampler reporting `load1 > cpus` for the whole wait, each load-sensitive e2e file skips with a reason naming the load and the tier reports a skip (not a failure); with `load1 <= cpus` the helper returns at once and the file runs exactly as today.
- No load-sensitive e2e file gains a longer wall-clock bound; the only change to their waits is the precondition.
- `npm run test:gate` passes.

**Tests.**
- test/helpers' own case (in the file that covers `wait.ts`, or `test/wait.test.ts`): `awaitQuietHost` returns true immediately under a quiet injected sampler, false after the bounded wait under a saturated one, and never throws.
- A run of `test/orchestrator-budget.e2e.test.ts` under a saturated injected sampler shows the skip wording; under the live quiet host it runs.

### Every commit is verified on main, part 4i/3: the pre-merge reviewer's resume state and its event vocabulary are deleted (planned 2026-10-29 by the plan role, split from the too-large part 3e/3; part 4h/3, which deleted the modules that read and produce the resume marker, has landed; touches src/runner/runner-state.ts src/runner/runner-state-load.ts src/review/review.ts src/run/run-apply.ts src/failure/failure-cluster.ts src/events/events.ts src/events/event-format.ts test/runner-state.test.ts test/run-apply.test.ts test/failure-cluster.test.ts test/event-format.test.ts)

**Goal.** After part 4h/3 nothing reads `RunnerState.reviewResume` or `approvedPatchIds`, nothing produces the `review_start` `resumed` flag, and no run reports the "continues this review" timeout wording. Delete the resume state and the vocabulary built on it.

**Approach.**
- `src/runner/runner-state.ts`: remove `reviewResume`, `REVIEW_RESUME_LIMIT`, `approvedPatchIds` and `APPROVED_PATCH_IDS_MAX` with their doc comments; keep `lastApprovedHead`, which `review.ts`'s deterministic same-head dedupe still reads.
- `src/runner/runner-state-load.ts`: remove the `approvedPatchIds`/legacy `lastApprovedPatchId` healing block and the `reviewResume` healing block, dropping the imports they leave unused.
- `src/review/review.ts`: remove the now-dead `state.reviewResume = undefined;` writes.
- `src/run/run-apply.ts`: remove the `approvedPatchIds = undefined` writes and their comments.
- `src/failure/failure-cluster.ts`: remove `RUN_TIMEOUT_PROGRESSING_REVIEW_RESUME_KEY`, its `TIMEOUT_POOL` entry and the comment block; `review-run.ts` was its only producer.
- `src/events/event-format.ts`: `reviewEventMessage`'s `review_start` arm always renders "reviewing" (the `e.resumed` ternary goes); `src/events/events.ts`: drop the `resumed true when …` clause from the `review_start` comment.
- Drop the resume-state, patch-id and resumed-flag cases from `test/runner-state.test.ts`, `test/run-apply.test.ts`, `test/failure-cluster.test.ts` and `test/event-format.test.ts`.

**Acceptance criteria.**
- `grep -rnE "reviewResume|REVIEW_RESUME_LIMIT|APPROVED_PATCH_IDS_MAX|RUN_TIMEOUT_PROGRESSING_REVIEW_RESUME_KEY|approvedPatchIds" src/ test/` prints nothing.
- A `review_start` event has no `resumed` flag and its message always reads `reviewing <sha>`.
- `lastApprovedHead` and the deterministic same-head dedupe are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/runner-state.test.ts: the `approvedPatchIds` load case and the `reviewResume` heal/validate case go; the surviving heal cases stay green.
- test/event-format.test.ts: the `review_start` `resumed` cases go; the `afterMerge` and `revision` cases stay.

### `onArrow`'s 22-term held-editor guard is replaced by the shared `anyEditorHeld()` predicate, so the prompt-history recall guard can never omit an editor the way its flat flag list already omits `rolePromptFor`, `queued`, `answer` and `entry` (planned 2026-10-29 by the plan role; continues the landed one-registry conversion family — `session.anyEditorHeld(...)` and `HOLDER_SUBJECTS` in `src/ui/tui/tui-editor-session.ts` are the single held-editor registry every other prompt-line guard already reads, and the flat list here is a hand-copied second copy; independent in file of every `## Planned` entry — before this entry `grep -c 'tui-editors' PLANS.md`, `grep -c 'anyEditorHeld' PLANS.md` and `grep -c 'tui-editor-session' PLANS.md` all print 0, so no heading or touches list in `PLANS.md` names `src/ui/tui/tui-editors.ts` or the symbol (the blocked `Every commit is verified on main` parts edit src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status, src/doctor, src/config, src/cli, src/roles, src/ui/status-model.ts, src/gui, src/events, src/failure, src/run, src/prompt and src/request-timeouts.ts; the blocked `Subtract` parts edit src/merge, src/orchestrator, src/config, src/roles, src/doctor, src/budget, src/gates, src/events, src/failure, src/team and docs, never `src/ui/tui/tui-editors.ts`; the in-flight `Every commit is verified on main` parts 4h/3 and 4i/3 take `src/review/review-run.ts`, `src/runner/runner-state.ts` and their siblings, and Option-2 isolation part 1/2 takes `test/helpers/wait.ts`); no finished plan replaces this guard — the three `PLANS-DONE.md` headings naming `onArrow` are the model, fallback and provider-caps editor plans, each extending the flat flag list with its own flag, the drift this plan ends; `docs/invariants.md` names no symbol or path of either file (`grep -cE 'tui-editors|anyEditorHeld' docs/invariants.md` prints 0), so it stays unchanged; touches src/ui/tui/tui-editors.ts test/tui-keys.test.ts)

**Goal.** `onArrow` (an arrow in `src/ui/tui/tui-editors.ts`, which the eslint one-shot reports at complexity 25) decides whether Up/Down recall a submitted prompt from history or fall through to `applyKey` by hand-writing a 22-term `!session.held.a && !session.held.b && …` conjunction. That conjunction is exactly `HOLDER_SUBJECTS` (20 flags) plus `pause` and `search`, so it silently omits `rolePromptFor`, `queued`, `answer` and `entry`: a new held flag must be added to the list by hand, and the four already-omitted ones leave a held editor unprotected wherever no pane consumes the arrow first (e.g. the role-prompt editor on a transcript view: `routeArrow` consults only the backlog, Pending and queued panes, so Up recalls a prompt over the role field). The fix is to read the one registry: recall only when no editor is held.

**Approach.**
- `src/ui/tui/tui-editors.ts`: replace the 22-term `if (!session.held.… && …)` condition in `onArrow` with `if (!session.anyEditorHeld())`, keeping the body (the `recallPromptHistory` call and the `if (recalled)` block) unchanged; rewrite the comment above it to say arrows recall only when no editor holds the line, naming `anyEditorHeld` as the registry instead of re-listing flags.
- Do not touch `src/ui/tui/tui-editor-session.ts`: `anyEditorHeld`'s signature, the `except` list and `HOLDER_SUBJECTS`' order stay as they are, so no hold/flash wording changes.

**Acceptance criteria.**
- `onArrow`'s guard reads `!session.anyEditorHeld()`; the 22-term conjunction is gone (`grep -n 'session.held' src/ui/tui/tui-editors.ts` prints no flag list), and the eslint one-shot no longer reports an arrow in `src/ui/tui/tui-editors.ts` at complexity > 15.
- Up/Down recall a submitted prompt with no editor open (`test/tui-keys.test.ts`'s "history recall: a submitted prompt comes back on Up" stays green), and leave the line unchanged with the notes editor open (`"notes edit mode keeps Up/Down from recalling history into the typed path field"` stays green).
- Up/Down leave the line unchanged in the `rolePromptFor`, `queued`, `answer` and `entry` modes too, and the open editor survives the keypress.
- `HOLDER_SUBJECTS` and `anyEditorHeld`'s behavior are unchanged: the busy-flash wording and hold ordering of every other guard that calls it stay as they are.
- `npm run test:gate` passes.

**Tests.**
- test/tui-keys.test.ts: add the held-editor Up/Down cases next to the notes one, opening each editor the way the file's existing cases already do — role-prompt mode (`keys.state().rolePromptFor`), the Queued pane's in-place editor (`queuedEditFor`), the backlog answer editor (`answerFor`) and the entry editor (`entryEditFor`). For each: seed history with a submitted prompt, open the editor, type a distinctive value, press Up then Down, and assert the line still holds that value and the editor is still open. On the Backlog view the answer/entry cases assert the selection did not move (the pane consumes the arrow); the role-prompt and queued cases assert the line is unchanged with the editor open.

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
