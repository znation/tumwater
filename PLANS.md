# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Prerequisite landed 2026-10-23 by the steward: reviewer-as-role parts 1/4 and 3/4 both landed today (their PLANS-DONE.md entries stamp done 2026-10-23), so the refusal's stated cause — "parts 1/4 and 3/4 are still under `## Planned` (not landed)" — no longer holds. The plan's remaining gate is the week of post-reviewer-plan `check_wait` data the approach requires, which cannot exist before ~2026-10-30; the refusal is not lifted here — releasing a Refused note is an operator/director call — but the record is corrected so the real gate (the data week, not the parts) is what blocks.**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### Every commit is verified on main, part 3l/3: the pre-merge model reviewer's dedicated test cases are retired ahead of its removal (planned 2026-10-24 by the plan role, split 2026-10-24 by the plan role from the too-large part 3h/3 — the feature role held part 3h/3 as too large because most of test/review-precheck.test.ts asserts the reviewer run it deletes; this part takes that test retirement first, and the reviewer still runs, so every deleted case is green; part 3h/3 requires this part; touches test/review.test.ts test/review-precheck.test.ts)

**Previously held 4**

**Goal.** Part 3h/3 stops `reviewAheadOfMain` (src/review/review.ts) running the pre-merge model reviewer. The bulk of that change is not the source removal but the cases that assert a reviewer run: `test/review.test.ts` and `test/review-precheck.test.ts` each drive the gate through a fake reviewer and would fail the moment the run goes. This part retires those cases first, while the reviewer still runs, so part 3h/3 lands as the source change plus the surviving cases' re-pointing.

**Approach.**
- `test/review.test.ts`: delete each case whose subject is the pre-merge reviewer's run, verdict, prompt, retry, resume, nudge or stray-edit handling — the reviewer-run wiring and session-name cases, the stray-edit/dropped-commit cases, the verdict parser and recovery/strike cases, the kill/retry/timeout/resume/stall cases, the suite-rerun tripwire cases, and the revision/interdiff and fresh-merge `review_start` cases. Keep the deterministic-rule cases (`diffRuleReasons`, conflict markers, the unreadable and non-ASCII paths, the false-fix, backlog-structure, brief-block, PRINCIPLES and secret-leak cases), the exempt and `review.enabled=false` cases, the already-approved-HEAD case, the aborted case, the retry-delay case, and the fixtures.
- `test/review-precheck.test.ts`: delete each case whose assertions require a reviewer run — the `reaches the reviewer` framing, the flake cases' reviewer arm, `gate pre-check timeout warns and still proceeds to the model review`, `a green pre-check hands its verified head to the merge path`, the reviewer-prompt and suite-rerun-tripwire cases, the approval-reuse-across-a-rebase cases, the second-slot reviewer overlap, and `with no free pool slot the check runs before the reviewer`. Keep the deterministic pre-check cases (compile failure, red script, named assertion, red-main no-strike, no-verdict baseline, non-npm check, shutdown, quarantined test, known failures) and the `diffRuleReasons` case.
- Both files: prune the imports and helpers only the deleted cases used (`reviewerStub`/`withReviewerStub`, `TOUCH_SESSION`, `readRunBlocks`, `piRanMarker`, `logFlagsTo`, the verdict and session helpers), because `noUnusedLocals` fails the build otherwise. No kept case's assertions change.

**Files touched.** test/review.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- Both files compile, and no remaining case asserts that the pre-merge gate ran a model reviewer, named a reviewer session, parsed a reviewer verdict, retried/resumed/nudged a reviewer, or overlapped the pre-check with a reviewer run.
- `grep -n "reviewerStub\|withReviewerStub" test/review.test.ts test/review-precheck.test.ts` is empty.
- No case whose subject is the deterministic diff rules or the build pre-check was deleted: their kept cases and their shared fixtures are untouched.
- `npm run test:gate` passes.

**Tests.**
- The kept deterministic-rule and pre-check cases pass unchanged; this part adds no case (part 3h/3 adds the surviving-behavior cases its source change needs).

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer — only a secret leak, a brief-block edit or a protected edit refuses a diff (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires parts 3g/3 and 3l/3 landed, since a role not on `review.afterMerge` must have its post-landing review queued before its pre-merge model review goes and the reviewer's dedicated cases must be retired before the run they assert goes; touches src/review/review.ts src/review/diff-rules.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts)

**Previously held 4**

**Goal.** `reviewAheadOfMain` (src/review/review.ts) stops running the pre-merge model reviewer: after the deterministic diff rules, the exempt check and the build pre-check it approves, so every merged change is judged once, by the post-landing review (part 3g/3). The pre-merge rejection set shrinks to the findings a later commit cannot repair: a leaked credential (`secretLeakReason`), a brief-block edit (`briefEditReason`) and a protected edit (`protectedEditReason`). A conflict marker, a false fix claim and a broken backlog structure no longer refuse here — the main watch still reports them on main's tip.

**Approach.**
- `diffRuleReasons` (src/review/diff-rules.ts) gains an explicit gate scope — an `only` set of rule names, or a sibling `gateRejectReasons` — so the gate runs only the brief-edit, protected-edit and secret-leak rules while the watch keeps running all five in the shared order. One call site states the ordering, so the two consumers cannot drift.
- `reviewAttempt` (src/review/review.ts) uses that scope for its `reject` list and, when no rule fires, returns `{ decision: "approved" }` with `state.lastApprovedHead = head` and `retry.pre.verifiedHead` — the branch a `review.afterMerge` role takes today. The `afterMerge`/`patchApproved` split disappears, and the now-dead `runReviewer` call and reviewer-only retry plumbing go with it, adjusting imports so `tsc` passes and leaving review-run.ts/review-followup.ts compiling and unreferenced for part 3e/3. The exempt path and the `gateBuildPrecheck` build pre-check are unchanged.
- The reviewer resume state `reviewAttempt` no longer reads is left for part 3e/3 to delete; this part removes only what `noUnusedLocals` would reject.
- docs/how-it-works.md: the review paragraph (the `review.afterMerge` role's separate path at its "A role listed in `review.afterMerge` is reviewed after merging" sentence) says one review runs after every landing and the pre-merge gate is deterministic.

**Files touched.** src/review/review.ts src/review/diff-rules.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- `reviewAheadOfMain` starts no pi reviewer run; a diff with a secret leak, a brief-block edit or a protected edit is still rejected with that reason, and a diff with a conflict marker, a false fix claim or a broken backlog structure approves instead.
- The exempt path and the build pre-check are unchanged.
- `npm run test:gate` passes.

**Tests.**
- Part 3l/3 has retired the reviewer cases in both files; this part re-points only the kept cases its source change touches.
- test/review.test.ts: `only a secret leak and a protected edit refuse a pre-merge diff` — a leaked credential, a brief-block edit and a protected edit end `review_rejected` with their reason; a conflict marker, a false fix claim and a broken backlog structure approve with no reviewer run. No case here references `runReviewer`.
- test/review-precheck.test.ts: re-point the kept `diffRuleReasons` case at the gate scope (its new `only`/`gateRejectReasons` argument), and add `a green pre-check approves with no reviewer run` — a healthy build returns `{ decision: "approved" }`, `state.lastApprovedHead` is set, and the pi-run marker is absent.
- The existing `gateBuildPrecheck` and exempt-path cases still pass.

### Every commit is verified on main, part 3i/3: the reviewer-provider holds defer only the post-landing review — no role start, verify or landing waits on the reviewer, and the `review.afterMerge` scheduling exemptions go (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3h/3 landed, since no pre-merge reviewer remains to be held; touches src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-scope.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-run.ts docs/how-it-works.md test/orchestrator-scheduling.test.ts test/runner-recovery.test.ts test/runner-leftover-recovery.test.ts)

**Previously held 3**

**Goal.** With every change reviewed after landing (parts 3g/3–3h/3), a held reviewer provider or unresolvable strong tier parks the review queue, not the team: no role start, merge-queue verify or landing waits on the reviewer. The `review.afterMerge` exemptions that existed only to let such a role keep merging go, and the queued-change interlock relief applies to every role.

**Approach.**
- src/orchestrator/scheduling-skip.ts: drop the `reviewHeld && !afterMergeRoles.has(...)` leg and the `afterMergeRoles`/`isAfterMergeRole` inputs; the queued-role interlock relief drops its `isAfterMergeRole` test, so a queued role falls through to author unless it is in a held stage (`interlockedHold`).
- src/orchestrator/scheduling-scope.ts: remove the `afterMergeRoles` field from `SchedulingScope` and its destructuring; `budgetHolds` drops the `reviewStrongPaused` disjunct; `buildSchedulingScope`'s `interlockedHold` walk drops its `isAfterMergeRole` continue.
- src/orchestrator/orchestrator-scheduling.ts: remove `reviewStrongPaused` from `DeferralInputs` and its computation when no reader remains, with its comment.
- src/orchestrator/orchestrator-poll.ts: `mergeStartHeld(held, reviewHeld, role?)` drops `afterMergeRoles` and keeps `reviewHeld` only for the role-less call, so `drainPostReviews` (which calls `startHeld()` with no role) stays parked while `merge-verify.ts`'s `startHeld(entry.role)` and every landing proceed. Remove the two `afterMergeRoles` Sets and simplify the role-start `startHeld` to the restart/disk case plus the role's own provider hold.
- src/runner/runner-run.ts: the `already_queued` recovery arm falls through to authoring for every role (drop the `reviewedAfterMerge(ctx.config, ctx.role)` test and its import), as the interlock relief now applies team-wide.
- docs/how-it-works.md's reviewer-hold paragraph (the "roles a pre-merge review gates are held … a role on `review.afterMerge` is not" sentence) says the hold parks only the post-merge review queue. Comments naming `review.afterMerge` as the exempt set in these files are reworded.

**Files touched.** src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-scope.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-run.ts docs/how-it-works.md test/orchestrator-scheduling.test.ts test/runner-recovery.test.ts test/runner-leftover-recovery.test.ts

**Acceptance criteria.**
- While the reviewer's provider is held or the strong tier is unresolvable, every role starts and every queued change verifies and merges; only `drainPostReviews` is parked, and it resumes when the hold lifts.
- A role with an `already_queued` recovery authors on current main instead of ending, with no `review.afterMerge` membership test.
- `npm run test:gate` passes.

**Tests.**
- test/orchestrator-scheduling.test.ts: `a held reviewer parks only the post-review drain` — a role's run is admitted and its merge starts while `reviewHeld` stands, and the post-review drain does not start.
- test/runner-recovery.test.ts / test/runner-leftover-recovery.test.ts: an `already_queued` recovery from a role not in `review.afterMerge` authors.

### Every commit is verified on main, part 3j/3: the permanent reviewer-config hold `mergeReviewError` is deleted (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3i/3 landed, since with no pre-merge reviewer no selector can fail there and this removal takes its last consumers; touches src/merge/merge-core.ts src/runner/leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/leftover.test.ts test/runner-state.test.ts)

**Previously held 3**

**Goal.** `RunnerState.mergeReviewError` held a merge pin when the pre-merge reviewer failed permanently on a bad model selector. Part 3h/3 removed the pre-merge reviewer, so `gate.configError` can no longer be set and the hold can never be produced; delete it and every reader.

**Approach.**
- src/merge/merge-core.ts: drop the `state.mergeReviewError = {...}` write on a `configError`, its two clears (in `discardPin` and on the approved path) and the `modelSelectorField`/`reviewRunConfig` reads that fed it.
- src/runner/leftover.ts: delete `reviewHold`, the `mergeReviewError` field on `LeftoverContext` and `pinnedRetrySha`'s state pick, and the two `reviewHold` read branches; recovery never reports `held` for a reviewer config.
- src/runner/runner-run.ts: drop the `mergeReviewError` read/clear beside the review selector and its state hand-back.
- src/runner/runner-state.ts: delete the `mergeReviewError?` field; src/run/run-apply.ts drops its `changeGone` clear. Keep the legacy `landingReviewError` read in runner-state-load.ts (old state files still name the key) and note it now loads into nothing.
- Delete the `mergeReviewError` cases and fixtures from the tests.

**Files touched.** src/merge/merge-core.ts src/runner/leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/leftover.test.ts test/runner-state.test.ts

**Acceptance criteria.**
- `mergeReviewError` is absent from `RunnerState` and from every read/write; a pin is never held for a reviewer selector, and recovery re-queues it as any other pin.
- An old state file carrying `mergeReviewError` still loads (the legacy key is ignored).
- `npm run test:gate` passes.

**Tests.**
- test/leftover.test.ts: `a pin is never held by a reviewer config` — a state carrying the legacy field still re-queues its pin.
- test/runner-state.test.ts: `mergeReviewError is gone` — the field no longer exists and a legacy state file loads.

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

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3e/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

**Previously held 2**

**Goal.** With the watch verifying every new tip, the checks that stood in front of a landing are redundant. Delete the merge slot's in-lock build re-check and the batch check with its largest-passing-prefix bisect, so a merge is: rebase onto the tip, take the fast-forward under the merge lock. A broken commit then sits on main between its landing and the watch's fix, which is the `ci` healer's job.

**Approach.**
- Delete the in-lock re-check from `mergeApprovedChange` (src/merge/merge-to-main.ts): the `runScopedBuildCheck`/`mergeCommand` run and its `merge_blocked` cause. The fast-forward, the conflict resolver, the dirty-checkout refusal and the `MERGE_CONFLICT_LIMIT` hand-back stay (a conflicted tree cannot be landed).
- Delete the batch path from `mergeApproved` (src/merge/merge-batch.ts): the shared scope-`batch` check, its `BATCH_RESTACK_ATTEMPTS` re-stack and its per-pick bisect/fallback, and whatever in `merge-stack.ts` only that path used. Every approved change merges one at a time through the now-check-free `mergeApprovedChange`.
- The gate-scope check producers go: `review-precheck.ts`'s build-check reject and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their callers; the merge-side `main_red` keep (`merge-core.ts`), `requeueMainRedPin`'s wait (`merge-requeue.ts`) and leftover's `main_red` wait go with the in-lock verdict that produced them.
- With no producer left, remove the merge verdict `main_red`: `heldByMainRed` and `mainCheckRecovered` (`src/status/status-polls.ts`), the status phase's `main red` label (`src/ui/status-model.ts`) and the doctor's held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`) go; the red-main warning that names an unheld red stays.
- Keep the two rules part 3h/3 left pre-merge (secret leaks and protected edits) and the refusals that are not quality verdicts: the dirty-checkout pre-flight (`merge-to-main.ts`), a rebase conflict and its hand-back, a lost fast-forward race, and the startup/redeploy stage check.
- Docs: docs/how-it-works.md's merge paragraph says a merge is a rebase and a fast-forward; docs/invariants.md's merge-check guarantees are re-pointed to the watch.

**Files touched.** src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts

**Acceptance criteria.**
- A merge runs no build check: the merge slot's per-change work is the rebase, the commit and the fast-forward, and the only pre-merge refusals left are a dirty or conflicted tree, a secret leak and a protected edit.
- `mergeApproved` has no batch/stack/bisect path; every approved change is merged through the one-change `mergeApprovedChange`.
- No run or merge verdict is `main_red`; the status `main red` label and the doctor's held-code-role list are gone, while the red-main warning stays.
- `npm run test:gate` passes.

**Tests.**
- test/merge-to-main.test.ts: `a merge runs no gate command` — with a declared check, no build-check run starts and the fast-forward lands; the dirty-checkout and conflict cases stay.
- test/main-red.test.ts: `heldByMainRed is gone` — no code role is reported held by main's redness, and the unheld red warning still renders.
- test/merge-verify.test.ts: the batch/stack cases are dropped; one-change merges still land.

### Every commit is verified on main, part 3k/3: every stale reference to the removed red-main gate is refreshed (planned 2026-10-24 by the plan role, split from the held part 3a/3; requires part 3a/3 landed, since until the block is gone these lines describe live behavior; touches src/baseline/main-baseline.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/config/config.ts src/cli/cli-start.ts src/ui/status-model.ts src/build/build-check-report.ts src/build/build-check-events.ts src/run/run-prompt.ts src/review/review-precheck.ts src/events/events.ts test/runner-2.test.ts test/main-baseline.test.ts test/status-render-cells.test.ts test/merge-to-main-recheck.test.ts test/build-check.test.ts test/review-precheck.test.ts)

**Previously held 2**

**Goal.** After part 3a/3 removes `mainRedGate`, the comments and test headers that still present a red-main authoring block as live are corrected in one sweep, so no remaining line names the removed block.

**Approach.**
- src/baseline/main-baseline.ts: the module header's "before an authoring run is spent on top of it" and its "while a SHA is known red the harness skips authoring for the code-producing roles" sentence are false once the gate is gone (the header itself says two lines later that a code role still authors on top of it). Rewrite the header so it says the module still checks MAIN ITSELF once per SHA, team-wide, but its verdict now feeds the `ci` healer hand-off (`mainRedHealNote`), the merge path's `mainTipVerdict` and redeploy's re-verify, not an authoring block; the section header "(red-main gate)" becomes "(main baseline)" and its "main-red.ts's gate consumes it" sentence names those surviving readers. Keep the `mainTipVerdict` references.
- src/runner/model-fallback.ts and src/runner/runner-fallback.ts: the "(…, a red-main block)" parentheticals in the "returns before this is reached" doc sentences name the merge-side `main_red` pin instead.
- src/review/review-precheck.ts ("main-red.ts's gate and the bugfix handoff own the repair"), src/build/build-check-events.ts ("main-red.ts's gate logger"), src/config/config.ts's `liveConfig` reader list, src/cli/cli-start.ts's `persistBaselineVerdicts` comment ("the redeployer and the roles' red-main gate"), src/ui/status-model.ts's stale-`main red` comment ("the red-main gate, so main was green then"), src/build/build-check-report.ts's consumer list ("the red-main gate") and src/run/run-prompt.ts's requeue comment ("a red-main gate block, which returns before any run") each drop the gate and name the surviving reader — the `ci` healer hand-off, `mainTipVerdict`, or the merge-side `main_red` pin.
- src/events/events.ts: the `main_red_hold` comment's "when the red names no failing test, every code role skips authoring until main is green" clause is false once the gate is gone; reword it so the event still logs once per red SHA and the `ci` healer is handed the failing tests, with no authoring block.
- Test headers/comments: test/runner-2.test.ts ("The red-main baseline block now lives in runner-red-main.test.ts"), test/main-baseline.test.ts ("the red-main gate's one-shot"), test/status-render-cells.test.ts ("got past the red-main gate"), test/merge-to-main-recheck.test.ts ("the red-main gate trusts it"), test/build-check.test.ts ("main-red gate, … at the redeploy") and test/review-precheck.test.ts ("main-red.ts's gate and the bugfix handoff") are reworded to the surviving `mainRedHealNote`/`mainTipVerdict`/merge-pin language.

**Files touched.** src/baseline/main-baseline.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/config/config.ts src/cli/cli-start.ts src/ui/status-model.ts src/build/build-check-report.ts src/build/build-check-events.ts src/run/run-prompt.ts src/review/review-precheck.ts src/events/events.ts test/runner-2.test.ts test/main-baseline.test.ts test/status-render-cells.test.ts test/merge-to-main-recheck.test.ts test/build-check.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- `grep -rn "mainRedGate\|baselineBlocked\|BASELINE_BLOCKED_ROLES\|red-main block\|red-main gate\|main-red gate\|main-red.ts's gate" src test docs` returns nothing.
- src/events/events.ts's `main_red_hold` comment names no authoring block and matches `warnMainRedOnce`'s surviving behavior (one log per red SHA, the `ci` healer handed the failing tests).
- No live source, doc or test line presents the removed authoring block as a path; each rewritten sentence names the surviving reader (`mainRedHealNote`, `mainTipVerdict`, or the merge-side `main_red` pin).
- Any comment naming the parts that remove the pre-merge blocks cites exactly "parts 3g/3–3j/3 and 3d/3–3f/3", never "3c/3–3f/3".
- `npm run test:gate` passes.

**Tests.**
- Comment-only change: no assertion is edited. The existing cases in the six listed test files still pass unchanged, and the acceptance grep is empty.

### The TUI Transcript view edits the viewed role's provider and thinking overrides with `Ctrl+U` and `Ctrl+K`, completing the terminal twins of the dashboard role drawer's Model overrides triple and `tumwater role <id> --provider`/`--thinking` (planned 2026-10-24 by the plan role; independent in behavior of every eligible plan — the in-flight TUI Health `Ctrl+S` plan (broken-pin drop) and TUI Health `Ctrl+V` plan (role enable/disable) both add fields to src/ui/tui/tui-editor-session.ts, tui-editors.ts, tui-keys.ts, tui-frame.ts, tui.tsx and docs/cli.md at neighbouring symbols, table rows and interface members this plan also touches, so whichever lands second rebases there, and neither touches tui-editor-role-key.ts nor this plan's two new editor modules; the blocked `Forward, never back` part 3b/6 and `A post-merge rejection stops reverting` part 3/3 edit src/ui/tui/tui-pane-pending.ts and test/tui-keys.test.ts at blocks this plan does not touch; touches src/ui/tui/tui-editor-role-thinking.ts (new) src/ui/tui/tui-editor-role-provider.ts (new) src/ui/tui/tui-editor-role-key.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui.tsx src/ui/tui/tui-pane-ctx.ts src/ui/tui/tui-pane-transcript.ts docs/cli.md test/tui-role-thinking.test.ts (new) test/tui-role-provider.test.ts (new))

**Refused 2026-10-24 by feature: the assigned Ctrl+U/Ctrl+K are the TUI's global readline line-editing keys (tui-input.ts applyKey: Ctrl+U kills from line start to cursor, Ctrl+K kills to line end), used by the budget/notes/search editors and the plain prompt line to edit a held line on a Transcript, so claiming them on every Transcript as this plan's model editor pattern does (editorEntryDenied steals the key and flashes the holder's subject even while another editor holds the line) breaks the budget, notes, and search editor tests' Ctrl+U line-clear; keeping those requires a special-cased fall-through deviation from the plan's stated mutual-exclusion contract that makes the new editors inconsistent with their createRoleModelEditor twin. The plan's files-touched/test list does not account for the three affected editors.**

**Goal.** `tumwater role <id>` writes the whole model triple (`--provider`/`--model`/`--thinking`, with `--clear-*`; src/cli/cli-role-command.ts), and the dashboard role drawer edits all three in its one `Model overrides` row (all three reach the shared `setRoleModelFields`, src/config/config-write.ts, through `/api/role-model`). The TUI's Transcript view edits only the middle field: `Ctrl+X` writes `roles.<base>.model` through the same `setRoleModelFields`, but `grep -rn 'rawRoleField(.*"provider"\|rawRoleField(.*"thinking"' src/ui/tui` matches nothing, so the terminal operator cannot set the two fields the drawer's triple and the CLI both expose. Add both editors on a role's Transcript view — `Ctrl+U` for the provider override and `Ctrl+K` for the thinking level — modelled on the existing role-pinned editors and writing through the same shared `setRoleModelFields` the CLI and drawer use.

**Approach.**
- `src/ui/tui/tui-editor-role-thinking.ts` (new) — `createRoleThinkingEditor(session): TuiEditorModule`, a `createRoleKeyEditor` spec: `mode: "roleThinking"`, `openCtrl: "k"`, `prefill: (s, base) => { const v = rawRoleField(s.root, base, "thinking"); return typeof v === "string" ? v : ""; }`, `commit: (s, base, text) => setRoleModelFields(s.root, base, { thinking: text })`, an open flash naming the seven levels and empty-clears, and `${role}: thinking override set to ${text}` / `${role}: thinking override cleared` saves — mirroring `createRoleModelEditor` (tui-editor-role-model.ts) line for line. `checkModelTripleField` (modelShape `"tier-name"`) owns the level's truth, so a typo flashes its message and the editor stays open.
- `src/ui/tui/tui-editor-role-provider.ts` (new) — `createRoleProviderEditor(session)` with `mode: "roleProvider"`, `openCtrl: "u"`, prefill `rawRoleField(..., "provider")`, commit `setRoleModelFields(s.root, base, { provider: text })`, and the provider set/cleared flashes. Same shape; `rawRoleField` and `setRoleModelFields` are the imports the model editor already uses.
- `src/ui/tui/tui-editor-role-key.ts` — widen `RoleKeySpec["mode"]` from `"roleModel" | "instances"` to add `"roleThinking" | "roleProvider"`.
- `src/ui/tui/tui-editor-session.ts` — add `roleThinking: boolean` and `roleProvider: boolean` to `TuiHeld` (beside `roleModel`), add `"roleThinking" | "roleProvider"` to the `EditorEnterKey` union, add `["roleThinking", "role thinking edit"]` and `["roleProvider", "role provider edit"]` to `HOLDER_SUBJECTS`, and initialize both `false` in `createTuiEditorSession`'s `held` literal. `heldEditorFlash`/`anyEditorHeld`/`editorEntryDenied` iterate that registry, so the mutual-exclusion contract needs no other change.
- `src/ui/tui/tui-editors.ts` — import `createRoleThinkingEditor` and `createRoleProviderEditor`, append both to the `editors` array (beside `createRoleModelEditor`), add `roleThinkingMode: boolean` and `roleProviderMode: boolean` to the `TuiEditorState` interface (beside `roleModelMode`), and return `roleThinkingMode: session.held.roleThinking, roleProviderMode: session.held.roleProvider` from `state()`.
- `src/ui/tui/tui-keys.ts` — add `roleThinkingMode: boolean` and `roleProviderMode: boolean` to `TuiKeysState` (beside `roleModelMode`); its `state()` already spreads `editors.state()`.
- `src/ui/tui/tui-frame.ts` — add `roleThinkingMode?: boolean` and `roleProviderMode?: boolean` to `TuiMode`; add the two `else if (mode.roleThinkingMode)` / `else if (mode.roleProviderMode)` hint branches beside the `roleModelMode` branch (`[Enter, "save role thinking"]` and `[Enter, "save role provider"]`); add `if (mode.roleThinkingMode) return [{ text: "role thinking", tone: "brand" }, { text: " › " }];` and the `role provider` twin to `promptPrefix` beside the `role model` line; and add `["Ctrl+U", "role provider"]` and `["Ctrl+K", "role thinking"]` to the `view.kind === "transcript"` line in `hintLine`.
- `src/ui/tui/tui.tsx` — add `roleThinkingMode: s.roleThinkingMode, roleProviderMode: s.roleProviderMode` to the `mode` object built from `keys.state()` (the frame's hint/prefix input).
- `src/ui/tui/tui-pane-ctx.ts` — add `roleThinkingMode: boolean` and `roleProviderMode: boolean` to `TuiPaneEditorState` (beside `roleModelMode`) and add `!es.roleThinkingMode && !es.roleProviderMode` to `promptLineFree`'s conjunction, so every pane arm's guard and the shared `/`-search guard restate the two new holders; `editors.state()` already returns both flags, so this interface is what lets the pane modules read them under `tsc`.
- `src/ui/tui/tui-pane-transcript.ts` — extend the `Ctrl+N` arm's explicit editor-flag guard (the `ctx.es.budgetMode || ctx.es.rolePromptFor || … || ctx.es.instructionsEditFor` list) with `ctx.es.roleThinkingMode || ctx.es.roleProviderMode` beside `ctx.es.roleModelMode`, so the notes/change cycle keeps its mutual-exclusion contract while either editor is open; the `Ctrl+Y` and `Ctrl+X` arms call `promptLineFree(ctx.es)`, so they pick the two flags up with no edit of their own.
- docs/cli.md — in the TUI keys table add a `| Ctrl+U | Transcript | edit the viewed role's provider override (`roles.<base>.provider`, a pi provider name; empty clears it) — the terminal twin of `tumwater role <id> --provider` and the dashboard role drawer's Model overrides provider field (an instance id writes its base role's key) |` row and a `| Ctrl+K | Transcript | edit the viewed role's thinking level (`roles.<base>.thinking`, one of off, minimal, low, medium, high, xhigh, max; empty clears it) — the terminal twin of `tumwater role <id> --thinking` and the dashboard role drawer's Model overrides thinking field (an instance id writes its base role's key) |` row, and extend the Check-state row's model-triple clause (which already names the drawer and `--provider`/`--thinking`) to name the TUI Transcript's `Ctrl+U`/`Ctrl+K` beside them. Insert the two clauses directly after the existing `(Ctrl+X) edits or clears the role's model override, writing `roles.<base>.model` for the base id (a model id or tier name like `strong`; empty clears it)` clause and before its `—and the TUI's notes view (Ctrl+N) clears them` tail: append rather than reflow, leave the Ctrl+X clause's text untouched, keep the parenthetical balanced, and keep the row's closing `|`.
- No change to `setRoleModelFields`, the CLI flags, the dashboard drawer or its `/api/role-model` route, and no new pane arm or routing in src/ui/tui/tui-panes.ts: the editors claim `Ctrl+U`/`Ctrl+K` before the panes and only on a role's Transcript (view 1..roleIds.length), so off it `Ctrl+U` keeps its Activity declared-check and Health re-sync-install meanings and `Ctrl+K` its Activity check-cap and Health orphan-kill meanings.

**Files touched.** src/ui/tui/tui-editor-role-thinking.ts (new) src/ui/tui/tui-editor-role-provider.ts (new) src/ui/tui/tui-editor-role-key.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-frame.ts src/ui/tui/tui.tsx src/ui/tui/tui-pane-ctx.ts src/ui/tui/tui-pane-transcript.ts docs/cli.md test/tui-role-thinking.test.ts (new) test/tui-role-provider.test.ts (new)

**Acceptance criteria.**
- On a role's Transcript view, `Ctrl+U` opens the provider editor pre-filled with the FILE's raw `roles.<base>.provider` (empty when unset); typing a provider name and Enter writes `roles.<base>.provider` through `setRoleModelFields` and flashes `<role>: provider override set to <text>`; an empty or whitespace-only line clears it and flashes `<role>: provider override cleared`.
- On a role's Transcript view, `Ctrl+K` opens the thinking editor pre-filled with the FILE's raw `roles.<base>.thinking`; a valid level writes `roles.<base>.thinking` and flashes `<role>: thinking override set to <level>`; an invalid level flashes `checkModelTripleField`'s message naming `roles.<base>.thinking` and the editor stays open; an empty line clears it.
- An instance id (`feature-2`) writes its base role's key (`roles.feature.provider`/`roles.feature.thinking`), since the factory passes `baseRoleOf(role)` to the commit.
- Opening either while another prompt-line editor holds the line flashes that holder's subject and opens nothing; Esc, the same Ctrl again and `Ctrl+T` exit by restoring the prompt draft, and the prompt line shows the `role provider ›`/`role thinking ›` label while open.
- `Ctrl+U` off the Transcript keeps its Activity declared-check and Health re-sync-install meanings; `Ctrl+K` off the Transcript keeps its Activity check-cap and Health orphan-kill meanings; the Transcript's `Ctrl+X` model, `Ctrl+G` instances, `Ctrl+O` quiet and `Ctrl+S` interval arms are unchanged.
- docs/cli.md's TUI keys table names the Transcript `Ctrl+U` and `Ctrl+K` bindings; the Check-state row's existing `(Ctrl+X) edits or clears the role's model override, writing `roles.<base>.model` for the base id (a model id or tier name like `strong`; empty clears it)` clause still reads as it did, the two new clauses sit between it and the `—and the TUI's notes view (Ctrl+N) clears them` tail, and the row's parenthetical and closing `|` are balanced.
- The change stays within this plan's Files-touched list: it carries no edit from the `Every commit is verified on main` series (in particular none to `src/doctor/doctor-holds.ts`) and does not edit PLANS-DONE.md.
- `npm run test:gate` passes.

**Tests.**
- test/tui-role-thinking.test.ts (new), driven like test/tui-role-model.test.ts through `makeTuiRepo`/`withTui`: seed `roles.clean.thinking: "low"`, enter the clean role's Transcript, press `Ctrl+K`, assert the line pre-fills `low` and the footer reads `save role thinking`, type `high`, press Enter, and assert the frame flashes `clean: thinking override set to high` and `readJson(tumwater.json).roles.clean.thinking === "high"`; a second case types `hgih` and asserts the frame carries `thinking must be one of off, minimal, low, medium, high, xhigh, max` with the file byte-identical; a third clears with an empty line and asserts `clean: thinking override cleared` and the key removed; a fourth asserts Esc and `Ctrl+T` restore a draft prompt.
- test/tui-role-provider.test.ts (new): seed `roles.clean.provider: "anthropic"`, enter the clean role's Transcript, press `Ctrl+U`, assert the pre-fill and `save role provider`, type `openai`, press Enter, and assert `clean: provider override set to openai` with `roles.clean.provider === "openai"`; an empty line clears it; a unit case asserts `feature-2` writes `roles.feature.provider`; a mutual-exclusion case asserts `Ctrl+U` on the Activity view keeps the declared-check editor (it does not open the provider editor).

### `tumwater history <role> <n>` names a completed run's peak context against the role's declared window — `peak ctx 110.0k (84%)` in the trail header across CLI, TUI and dashboard (planned 2026-10-25 by the plan role; independent in files of every eligible plan except three distant shared sites: the in-flight status-table plan adds the identical `contextShareLabel` helper to `src/text/format.ts` (whichever lands second reuses the survivor), part 3k/3 edits `src/events/events.ts`'s `run_end`/`main_red` comment lines while this plan appends one clause to the `run_end` bullet, and the in-flight `feedback` observer-read plan edits `docs/cli.md`'s `tumwater role <id>` row while this plan extends the `Watch run history` row, so whichever lands second rebases at that distant row; no eligible plan touches `src/run/run-finalize.ts`, `src/run/run-detail-data.ts`, `src/run/run-detail-render.ts`, `test/run-finalize.test.ts`, `test/run-detail.test.ts` or `test/run-detail-data.test.ts`; the status-table plan touches `src/status/status-roles.ts`, `src/ui/status-render.ts`, `src/ui/status-payload.ts` and `docs/how-it-works.md`, and part 3l/3 the review tests; touches src/run/run-finalize.ts src/run/run-detail-data.ts src/run/run-detail-render.ts src/text/format.ts src/events/events.ts docs/cli.md test/run-finalize.test.ts test/run-detail.test.ts test/run-detail-data.test.ts test/format.test.ts)

**Goal.** The status table's live `peak ctx` (and the in-flight status-table plan's `110.0k (84%)` share of the declared window) disappears the moment a run ends: `tumwater history <role> <n>`, the TUI History run trail (`tui-pane-history.ts`) and the dashboard's run drill-down (`gui-history-endpoints.ts`) all render the run's usage as bare `1.2M tok · $0.03` and never its largest single-request context. So an operator reviewing an hour-long run after the fact cannot see whether it ran hot against the model's declared window — past the point where pi compacts with a lossy summary and a run that keeps reading may land nothing. The live peak already exists per run on `RunnerState.peakContextTokens` (reset at run start, `runner-state.ts`) and the window is already resolvable through `seamContextWindow(configForRole(cfg, role), root)` (the `tumwater role <id>` `- Context window:` line), but nothing writes the peak into the run's history. Record it on the run's `run_end` event and render it in the one `renderRunDetail` header every surface shares.

**Approach.**
- src/run/run-finalize.ts: in the `logEventBestEffort(root, { type: "run_end", … })` payload, add `...(s.peakContextTokens > 0 ? { peakContextTokens: s.peakContextTokens } : {})` beside the existing `usageFragment(...)` and `promptTokens` spreads — the same omit-when-zero convention, so every older `run_end` and every run that reports no context renders byte-identically. The field rides `HarnessEvent`'s index signature like the other per-run payloads.
- src/events/events.ts: extend the `run_end` bullet in the `type` union comment by one clause naming `peakContextTokens` (a comment-only change, no type).
- src/run/run-detail-data.ts: `RunDetail` gains `peakContextTokens?: number` and `contextWindow?: number | null` (optional so existing payload literals keep compiling; the collector always sets both). `detailFrom` takes `root` and reads `const peakContextTokens = end === null ? 0 : nonNegativeNumber(end.peakContextTokens, 0)` — `nonNegativeNumber` is the shared corrupt-field guard `promptStatsFor` in `failure-data.ts` uses — and `contextWindow: seamContextWindow(configForRole(loadConfigSafe(root), role), root)`, the same call `role-view.ts` makes; `configForRole` resolves an instance id through `baseRoleOf`, and `loadConfigSafe` never throws, so a broken `tumwater.json` yields a null window rather than failing a read-only view. Both `detailFrom` call sites in `readRunDetail` pass `root`. Imports: `loadConfigSafe` from `../config/config.js`, `configForRole` from `../config/config-views.js`, `seamContextWindow` from `../pi/pi-models.js`, `nonNegativeNumber` from `../files/json-object.js`.
- src/text/format.ts: `contextShareLabel(peakTokens: number, windowTokens?: number | null): string` beside `compactTokens` — returns `compactTokens(peakTokens)` when the window is null/undefined/0 or the peak is 0, else `` `${compactTokens(peakTokens)} (${Math.round((100 * peakTokens) / windowTokens)}%)` ``. One home of the share format. The in-flight status-table plan adds the identical function; whichever lands second reuses it, not a second copy.
- src/run/run-detail-render.ts: in `renderRunDetail`'s header, after the `usage` summary element, push `peak ctx ${contextShareLabel(d.peakContextTokens ?? 0, d.contextWindow)}` only when `(d.peakContextTokens ?? 0) > 0`, so a run that reports no context keeps today's header byte-identical. The TUI trail, the dashboard drill-down and `tumwater history`/`tick` all render this one function, so the three cannot drift.
- docs/cli.md: in the `Watch run history` row's `tumwater history <role> <n>` clause, add the peak-context element to the list of summary-header fields.

**Files touched.** src/run/run-finalize.ts src/run/run-detail-data.ts src/run/run-detail-render.ts src/text/format.ts src/events/events.ts docs/cli.md test/run-finalize.test.ts test/run-detail.test.ts test/run-detail-data.test.ts test/format.test.ts

**Acceptance criteria.**
- A completed run whose `run_end` carries `peakContextTokens > 0` renders `peak ctx <compactTokens(peak)> (NN%)` in the `renderRunDetail` header when the role's seam resolves a declared window, and `peak ctx <compactTokens(peak)>` (no parenthetical) when it does not; a run whose `run_end` carries none renders the header byte-identically to today.
- The window is the one `seamContextWindow(configForRole(loadConfigSafe(root), role), root)` resolves — the same seam `tumwater role <id>`'s `- Context window:` line prints — and it resolves for a base role and an instance id alike.
- The CLI (`tumwater history <role> <n>`), the TUI History trail and the dashboard run drill-down show the same header text, since all three call `renderRunDetail`.
- `run_end` events written by older builds and runs whose peak is 0 are unchanged, and no event-feed line changes (`usageText` does not read the new field).
- `npm run test:gate` passes.

**Tests.**
- test/format.test.ts: `contextShareLabel reads a peak against a declared window` — `contextShareLabel(110_000, 131_072)` matches `/^110\.0k \(84%\)$/`; `(110_000, undefined)`, `(110_000, null)`, `(110_000, 0)` and `(0, 131_072)` each equal `compactTokens` of the peak; `(131_072, 131_072)` is `131.1k (100%)`.
- test/run-finalize.test.ts: `finalizeRun rides a nonzero peak context on run_end` — set `s.peakContextTokens = 96_000`, finalize, and assert `eventsOfType(root, "run_end")[0]!.peakContextTokens === 96_000`; a finalize with `peakContextTokens = 0` omits the field, matching the existing `generatedTokens`/`promptTokens` tests.
- test/run-detail-data.test.ts: `readRunDetail resolves the run's peak and its role's declared window` — stage a `run_end` carrying `peakContextTokens` and a pi models file declaring a `contextWindow` for the role's resolved model; the returned `RunDetail` has `peakContextTokens` equal to it and `contextWindow` equal to the declared window; with `NO_MODELS` the `contextWindow` is `null`, and a run whose `run_end` lacks the field has `peakContextTokens === 0`.
- test/run-detail.test.ts: `renderRunDetail names the peak against the declared window` — a `RunDetail` with `peakContextTokens: 110_000, contextWindow: 131_072` renders a header matching `/peak ctx 110\.0k \(84%\)/`; the same detail with `contextWindow: null` renders `/peak ctx 110\.0k(?! \()/`; the existing header cases with no peak keep their exact regexes.

### The failure digest's Team state changes section replays every harness gate hold and lift — disk, quiet hours, the maintenance allowance, the subscription windows and the live model/concurrency edits (planned 2026-10-25 by the plan role; independent in files of every eligible plan — no eligible plan and no blocked part touches `src/failure/failure-state-change.ts`, `src/events/event-format.ts`, `test/failure-state-change.test.ts` or `test/failure-render.test.ts`; part 3k/3 edits `src/events/events.ts`'s `run_end`/`main_red` comment lines, which this plan reads but does not touch, and the in-flight status-table and history plans touch status/ui/text and run/detail files, none of them `src/failure`; touches src/events/event-format.ts src/failure/failure-state-change.ts test/failure-state-change.test.ts test/failure-render.test.ts)

**Goal.** `renderFailureMarkdown`'s Team state changes section is the evidence the selfcheck role judges its "was the harness's response wrong" rule against (plans/telemetry-role.md §"Fleet state changes"), but it replays only a subset of the harness's own decisions. `STATE_CHANGE_TYPES` lists the budget gates, the team/role pause and resume, the rate-limit/backend hold, the model fallback, `max_concurrent_changed`/`retention_changed`/`config_changed` and the restart lifecycle — yet the holds that stop and restart work for the other configured gates never appear: `disk_low`/`disk_ok`, `quiet_hours_started`/`quiet_hours_ended`, `maintenance_quota_hold`/`maintenance_quota_resumed`, `subscription_window_reserved`/`subscription_window_limited`/`subscription_window_reset`, the live-edit siblings `provider_concurrency_changed` and `model_changed`, and the one-time `bootstrap_complete` admission. `grep -n 'disk_low\|quiet_hours\|subscription_window\|maintenance_quota' src/failure/` prints nothing, so a window in which a disk floor or a subscription-window reserve stopped the team reads in the digest as if the team merely chose to idle: the `run_deferred`/`run_end` counts show the stop with no harness decision to explain it. Add the missing transitions with compact bounded lines, keeping the section's constant byte bound.

**Approach.** Two files carry the change; the wording helpers stay in their one home rather than being re-derived.
- src/events/event-format.ts: add `export` to the four private helpers the feed's own lines already use — `gigabytes(v)`, `windowSuffix(e)`, `windowResetPhrase(e)` and `backendLabel(e)`. Visibility only; no line or byte changes. The failure digest then reuses them, so a disk, quiet-hours or subscription line cannot drift between the feed and the digest.
- src/failure/failure-state-change.ts: add the twelve types to `STATE_CHANGE_TYPES` and one `case` per type in `describeStateChange`, each a compact (≤ `STATE_CHANGE_MAX`) version of the event feed's line, every free field through `field()` so no unbounded payload reaches the page:
  - `disk_low`: `waiting: low disk — ${gigabytes(ev.freeGB)} free (floor ${gigabytes(ev.holdGB)})`; `disk_ok`: `disk recovered — ${gigabytes(ev.freeGB)} free`.
  - `quiet_hours_started`: `waiting: quiet hours${windowSuffix(ev)}`; `quiet_hours_ended`: `quiet hours ended${windowSuffix(ev)}`.
  - `maintenance_quota_hold`: `waiting: maintenance allowance used — ${field(ev.maint)}/${field(ev.allowance)} in 24h (${field(ev.work)} work)`; `maintenance_quota_resumed`: `maintenance allowance reopened — ${field(ev.maint)}/${field(ev.allowance)} in 24h`.
  - `subscription_window_reserved`: `waiting: ${backendLabel(ev)} window ${field(ev.windowType)} at ${pct(ev.utilization)}% past its ${pct(ev.reserve)}% reserve`; `subscription_window_limited`: `waiting: ${backendLabel(ev)} window ${field(ev.windowType)} rejected${windowResetPhrase(ev)}`; `subscription_window_reset`: `${backendLabel(ev)} window reset — model jobs run again`.
  - `provider_concurrency_changed`: `${field(ev.provider)} concurrency ${field(ev.from)} → ${field(ev.to)}`; `model_changed`: `model changed — now ${field(ev.to)}`; `bootstrap_complete`: `bootstrap complete — ${field(ev.plansDone)}/${field(ev.untilPlansDone)} plans done`.
- `pct(v)` is `claudeUtilizationPct(finiteNumber(v, 0))` (import `claudeUtilizationPct` from `../agent/claude/claude-account.js`), the same percent format the feed's subscription lines use; the existing imports of `finiteNumber`, `formatGB` (from `../text/format.js`), `isNonBlankString` and the event-format helpers cover the rest.
- Extend `STATE_CHANGE_TYPES`'s doc comment to name the gate holds beside the existing list. Deliberately left out, and said so in the comment: `subscription_window_warning` (observational, gates nothing), `disk_reclaim` (an action, not a state transition), `image_blind` (a run outcome), and `permit_reserve`/`slot_wait`/`check_wait`/`provider_wait`/`claim` (per-run advisories or assignments).

**Files touched.** src/events/event-format.ts src/failure/failure-state-change.ts test/failure-state-change.test.ts test/failure-render.test.ts

**Acceptance criteria.**
- `STATE_CHANGE_TYPES` holds each of the twelve types; `describeStateChange` returns the compact line above for each, and every free field is byte-sliced so a hand-edited payload cannot exceed `STATE_CHANGE_MAX` or emit `NaN`/`undefined` (a `disk_low` with no `freeGB` reads `0.0 GB` through `finiteNumber`).
- The existing set's lines and the section's newest-`STATE_CHANGE_TOP` cap/remainder behavior are unchanged, and `renderFailureMarkdown` prints a new type's line in the Team state changes section (the collector's `STATE_CHANGE_TYPES` filter is what admits it), so no render change is needed.
- The event feed's own lines are byte-identical: exporting `gigabytes`/`windowSuffix`/`windowResetPhrase`/`backendLabel` changes no call site.
- `npm run test:gate` passes.

**Tests.**
- test/failure-state-change.test.ts: add the twelve types to the first test's list (its `!STATE_CHANGE_TYPES.has("run_end")` and `STATE_CHANGE_TOP` assertions stay). Add `the digest names every gate hold and lift` asserting representative exact strings — `disk_low` `{freeGB: 3.2, holdGB: 2}` → `waiting: low disk — 3.2 GB free (floor 2.0 GB)`, `disk_ok` `{freeGB: 12}` → `disk recovered — 12.0 GB free`, `quiet_hours_started` `{window: "23:00-07:00"}` → `waiting: quiet hours (23:00-07:00)`, `maintenance_quota_hold` `{maint: 3, allowance: 4, work: 20}` → `waiting: maintenance allowance used — 3/4 in 24h (20 work)`, `subscription_window_reserved` `{backend: "claude", windowType: "five_hour", utilization: 0.85, reserve: 0.8}` → `waiting: claude window five_hour at 85% past its 80% reserve`, `subscription_window_limited` `{windowType: "five_hour"}` starts `waiting: claude window five_hour rejected`, `provider_concurrency_changed` `{provider: "claude", from: 2, to: 3}` → `claude concurrency 2 → 3`, `model_changed` `{to: "acme/m1"}` → `model changed — now acme/m1`, `bootstrap_complete` `{plansDone: 5, untilPlansDone: 5}` → `bootstrap complete — 5/5 plans done` — plus a torn `disk_low` with no fields reading `waiting: low disk — 0.0 GB free (floor 0.0 GB)` and never `NaN`/`undefined`.
- test/failure-render.test.ts: add `a disk hold reaches the digest's state changes` — write a `disk_low` and a `run_end` in the window, render, and assert the state changes section carries the `waiting: low disk` line; the existing scoped-digest and cap/remainder cases stay green.

## Done
