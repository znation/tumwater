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

### Option-2 isolation, part 2/2: the post-merge reviewer's budget stretches on a starved host (planned 2026-10-29 by the plan role, split from the Steward queue-gap note 2026-10-29 and the review-900s class note; independent of part 1/2 — different files, no `requires`; touches src/config/config-views.ts src/build/build-check-events.ts docs/config.md docs/how-it-works.md test/config-views.test.ts)

**Goal.** The post-merge review is now the only review path, and a strong-tier reviewer run killed at its 900 s ceiling (`review.timeoutSeconds`) on the loaded host leaves the commit verdict-less (four such Open members). A merge-scope check in exactly this situation already gets a longer deadline: `starvedDeadlineMs` (`src/build/build-check-events.ts`) stretches it by the host's load-to-cores ratio, capped at `STARVED_DEADLINE_MAX_FACTOR`. Give the reviewer run the same starvation-aware budget, so a progressing review on a starved host is not killed at the wall by load it does not control.

**Approach.**
- In `src/config/config-views.ts`'s `reviewRunConfig`, stretch the reviewer's budget by `starvedDeadlineMs(baseMs, load)` using `sampleHostLoad` from `src/build/host-sleep.js`, keeping the existing precedence: `runTimeoutSeconds = Math.min(cfg.runTimeoutSeconds, starvedDeadlineMs(config.review.timeoutSeconds ?? REVIEW_TIMEOUT_S, load) / 1000)`. `build-check-events.ts` imports only types from `build-check.js` and `events.js`, so importing `starvedDeadlineMs` into `config-views.ts` adds no runtime cycle. Add an optional `load` parameter defaulting to `sampleHostLoad` so the offline tests inject it, matching `doctor-contention-checks.ts`'s sampler seam.
- Keep `FALLBACK_REVIEW_TIMEOUT_S`'s floor and the pi-watchdog's one progressing extension unchanged; the stretch composes with them (a starved fallback review can reach the floor stretched then extended).
- Reword the `REVIEW_TIMEOUT_S` and `reviewRunConfig` doc comments in the same file to say the budget stretches under a starved host and why (the merge-scope precedent), and name the behavior in docs/config.md's `review.timeoutSeconds` row and docs/how-it-works.md's review paragraph.

**Files touched.** src/config/config-views.ts src/build/build-check-events.ts docs/config.md docs/how-it-works.md test/config-views.test.ts

**Acceptance criteria.**
- With an injected `load` whose `load1 <= cpus`, `reviewRunConfig(config).runTimeoutSeconds` is exactly today's value (900 default, a configured `review.timeoutSeconds`, or a smaller `runTimeoutSeconds`).
- With `load1` at twice `cpus`, it is at most `STARVED_DEADLINE_MAX_FACTOR`× the base and never above `config.runTimeoutSeconds`; the existing `reviewRunConfig` cases in test/config-views.test.ts still pass.
- `npm run test:gate` passes.

**Tests.**
- test/config-views.test.ts: extend `reviewRunConfig gives the reviewer its own time budget over the reviewer wiring` (or add a sibling) with a quiet-load case (unchanged) and a starved-load case (doubled-to-cap, never above the run budget).

### Every commit is verified on main, part 4h/3: the dead pre-merge reviewer run and follow-up modules are deleted (planned 2026-10-29 by the plan role, split from the too-large part 3e/3; requires part 3j/3 landed, since with no pre-merge reviewer `review-run.ts` and `review-followup.ts` have no caller; touches src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/request-timeouts.ts src/agent/agent-run.ts src/config/config-views.ts src/verdict/reply-contract.ts docs/how-it-works.md test/review-followup.test.ts (deleted) test/gate-prompts.test.ts)

**Goal.** Part 3h/3's deterministic gate leaves the pre-merge reviewer unreferenced: `runReviewer` is only re-exported by `review.ts` and never called, `requestVerdict`/`requestNoRerun` are called only by `review-run.ts`, and the three reviewer follow-up prompt builders are called only by those two modules. Delete the two modules and their exclusive prompts so no pre-merge reviewer prompt, verdict follow-up or no-rerun nudge remains.

**Approach.**
- Delete `src/review/review-run.ts` and `src/review/review-followup.ts`.
- `src/review/review.ts`: remove the re-export line `export { REVIEW_FAILURE_LIMIT, restoreReviewedHead, runReviewer, withRuns } from "./review-run.js";` and reword the `reviewAttempt` header comment that names the two deleted files. Leave `reviewAheadOfMain`'s retry scaffold in place — it is wired through `ReviewContext` from `merge-core.ts`, `merge-batch.ts` and `orchestrator-poll.ts`, so collapsing it is a separate cross-cutting sweep.
- `src/prompt/gate-prompts.ts`: delete `buildReviewResumePrompt`, `buildVerdictRequestPrompt` and `buildNoRerunPrompt`; `buildReviewPrompt` stays because `post-merge-review.ts` reads it.
- Reword the comments that name the deleted files or builders: `src/request-timeouts.ts`, `src/agent/agent-run.ts`, `src/config/config-views.ts` (point its `review_start` note at `post-merge-review.ts`) and `src/verdict/reply-contract.ts`.
- `docs/how-it-works.md`'s **Review.** paragraph: drop the sentences describing the pre-merge reviewer's run and timeout extension, keeping the post-landing review description.
- Delete `test/review-followup.test.ts`; drop the `buildReviewResumePrompt` import and case from `test/gate-prompts.test.ts`.
- Leave the fake-pi fixtures (`reviewerPi`/`APPROVE_PI` in test/fixtures/pi-events.ts, `perRoleReviewerPi` in test/fixtures/merger-fixtures.ts, `APPROVE` in test/fixtures/merge-fixtures.ts) untouched: the surviving runner, merge and post-review tests still call them, so they are generic fake-pi builders rather than dead reviewer helpers (the old part 3e/3's promise to delete them is stale).

**Files touched.** src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/request-timeouts.ts src/agent/agent-run.ts src/config/config-views.ts src/verdict/reply-contract.ts docs/how-it-works.md test/review-followup.test.ts (deleted) test/gate-prompts.test.ts

**Acceptance criteria.**
- `src/review/review-run.ts` and `src/review/review-followup.ts` no longer exist, and `grep -rnE "review-run\.js|review-followup" src/ test/` prints nothing.
- `grep -rnE "runReviewer|restoreReviewedHead|withRuns|REVIEW_FAILURE_LIMIT|buildReviewResumePrompt|buildVerdictRequestPrompt|buildNoRerunPrompt" src/ test/` prints nothing.
- The gate still runs its deterministic diff rules and build pre-check and returns the verdicts part 3h/3 established.
- `npm run test:gate` passes.

**Tests.**
- test/gate-prompts.test.ts: the `buildReviewResumePrompt` case goes; the `buildReviewPrompt` cases stay green.
- test/review.test.ts: the deterministic gate cases still pass with the two modules gone.

### Every commit is verified on main, part 4i/3: the pre-merge reviewer's resume state and its event vocabulary are deleted (planned 2026-10-29 by the plan role, split from the too-large part 3e/3; requires part 4h/3 landed, since part 4h/3 deletes the modules that read and produce the resume marker; touches src/runner/runner-state.ts src/runner/runner-state-load.ts src/review/review.ts src/run/run-apply.ts src/failure/failure-cluster.ts src/events/events.ts src/events/event-format.ts test/runner-state.test.ts test/run-apply.test.ts test/failure-cluster.test.ts test/event-format.test.ts)

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

## Done
