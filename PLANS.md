# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; split 2026-10-25 by the plan role — the gate-scope narrowing moved to part 3m/3, then split again the same day after feature held it too large (held 6): the migration of the pre-merge reviewer's merge-verify and pipeline/runner/e2e cases moved to parts 3p/3–4d/3, all landed; replanned 2026-10-28 by the plan role after a feature run implementing this part found the migration incomplete — ~12 cases across seven further test files still pin the pre-merge reviewer, so those move to parts 4f/3 and 4g/3, and this part requires part 4f/3 landed and part 4g/3 landed. 3g/3's universal post-landing review and 3l/3's review-suite retirement are on main; touches src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts test/post-merge-review.test.ts)

**Previously held 6**

**Goal.** `reviewAheadOfMain` (src/review/review.ts) stops running the pre-merge model reviewer: after the deterministic diff rules, the exempt check and the build pre-check it approves, so every merged change is judged once, by the post-landing review (part 3g/3). This part keeps the gate's five deterministic rules as they are and leaves the reviewer's retry/overlap seams in place; part 3m/3 narrows the gate's rule scope, and the reviewer's remaining plumbing goes with review-run.ts/review-followup.ts. After this part lands, no diff starts a pi reviewer run.

**Approach.**
- `reviewAttempt` (src/review/review.ts): once `gateBuildPrecheck` returns a passing pre-check, set `state.lastApprovedHead = head`, clear `state.reviewResume` and return `{ decision: "approved", verifiedHead: retry.pre.verifiedHead }` — today's `review.afterMerge` branch, now the only continuation. The `afterMerge` (`reviewedAfterMerge`) and `patchApproved` (`patchId`/`approvedPatchIds`) approvals, the overlap helpers (`leaseCheckSlot`, `startOverlappedCheck`, and the `SlotLeaseHandle` import), the `keep`/`settleFailedCheck` helpers, the `runReviewer` call and the `restoreReviewedHead`/`withRuns` import go. Keep `CheckOverlap` and `ReviewRetry` exported — review-run.ts still imports both. The build pre-check now always runs in the change's own slot. `review-run.ts` and `review-followup.ts` stay compiling and unreferenced.
- Keep `reviewAheadOfMain`'s one-attempt-per-loop shape and `reviewAttempt`'s `retry` argument: `retryable` is never set, so the loop returns the first result. Leave the `GateResult.run`/`followUpRun`/`nudgeRun`/`retryable` fields and the `ReviewContext.leaseCheckSlot`/`reviewHeld`/`retries`/`retryDelayMs`/`foldUsage` members in place — this part removes only what `noUnusedLocals` rejects, and the remaining reviewer seams go with review-run.ts/review-followup.ts.
- Keep the `reject` path's bookkeeping, the exempt path and `gateBuildPrecheck`'s behavior unchanged.
- docs/how-it-works.md: the **Review.** paragraph says the pre-merge gate is deterministic (the diff rules, the exempt fast path and the build pre-check) and every merge is judged once after landing, by the post-landing review; the `review.afterMerge` bullet's "A role listed in `review.afterMerge` is reviewed after merging … then merges with no reviewer run" becomes true of every role pending part 3d/3's key deletion.

**Files touched.** src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts test/post-merge-review.test.ts

**Acceptance criteria.**
- `reviewAheadOfMain` starts no pi reviewer run: a healthy code change reaches `{ decision: "approved" }` with `state.lastApprovedHead === head` and the pi-run marker absent.
- A diff with a secret leak, a brief-block edit, a protected edit or a conflict marker still rejects with that reason; an exempt (md-only) diff still returns `exempt`; the build pre-check still rejects as before.
- `npm run test:gate` passes.

**Tests.**
- Part 3l/3 has retired the reviewer cases in both files; re-point only the kept cases the source change touches.
- test/review.test.ts: re-point `gate fails closed on an aborted run without bookkeeping` off its fake reviewer run (`a shutdown during a failing pre-check fails closed` in test/review-precheck.test.ts already covers the abort path) while keeping its assertions that the commit stays and no bookkeeping is written. The deterministic-rule, exempt, already-approved and no-op cases pass unchanged; no case references `runReviewer`, and the `reviewRetryDelayMs` case stays until the reviewer seams go with review-run.ts.
- test/review-precheck.test.ts: add `a green pre-check approves with no reviewer run` — a healthy build returns `{ decision: "approved" }`, `state.lastApprovedHead` is set, and the pi-run marker is absent.
- test/post-merge-review.test.ts: re-point `a listed role's change passes the gate with no reviewer run; an unlisted role's is reviewed` — with the reviewer gone before the merge, both the listed and the unlisted role now pass the gate with the pi-run marker absent and no `review_start`; the second `reviewGate` call's `assert.ok(fs.existsSync(marker))` (the unlisted role was reviewed) is the only reviewer-run assertion and goes, while the listed-role half and the post-review queueing stay.
- The existing `gateBuildPrecheck` and exempt-path cases still pass.
- The seven test files whose reviewer-run cases parts 4f/3 and 4g/3 own are not touched here.

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

### Every commit is verified on main, part 3j/3: the permanent reviewer-config hold `mergeReviewError` is deleted (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3i/3 landed, since with no pre-merge reviewer no selector can fail there and this removal takes its last consumers; touches src/merge/merge-core.ts src/runner/runner-leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/runner-leftover.test.ts test/runner-state.test.ts)

**Previously held 3**

**Goal.** `RunnerState.mergeReviewError` held a merge pin when the pre-merge reviewer failed permanently on a bad model selector. Part 3h/3 removed the pre-merge reviewer, so `gate.configError` can no longer be set and the hold can never be produced; delete it and every reader.

**Approach.**
- src/merge/merge-core.ts: drop the `state.mergeReviewError = {...}` write on a `configError`, its two clears (in `discardPin` and on the approved path) and the `modelSelectorField`/`reviewRunConfig` reads that fed it.
- src/runner/runner-leftover.ts: delete `reviewHold`, the `mergeReviewError` field on `LeftoverContext` and `pinnedRetrySha`'s state pick, and the two `reviewHold` read branches; recovery never reports `held` for a reviewer config.
- src/runner/runner-run.ts: drop the `mergeReviewError` read/clear beside the review selector and its state hand-back.
- src/runner/runner-state.ts: delete the `mergeReviewError?` field; src/run/run-apply.ts drops its `changeGone` clear. Keep the legacy `landingReviewError` read in runner-state-load.ts (old state files still name the key) and note it now loads into nothing.
- Delete the `mergeReviewError` cases and fixtures from the tests.

**Files touched.** src/merge/merge-core.ts src/runner/runner-leftover.ts src/runner/runner-run.ts src/runner/runner-state.ts src/run/run-apply.ts test/runner-leftover.test.ts test/runner-state.test.ts

**Acceptance criteria.**
- `mergeReviewError` is absent from `RunnerState` and from every read/write; a pin is never held for a reviewer selector, and recovery re-queues it as any other pin.
- An old state file carrying `mergeReviewError` still loads (the legacy key is ignored).
- `npm run test:gate` passes.

**Tests.**
- test/runner-leftover.test.ts: `a pin is never held by a reviewer config` — a state carrying the legacy field still re-queues its pin.
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

### Every commit is verified on main, part 3m/3: the pre-merge gate's deterministic rule set narrows to the three findings a later commit cannot repair (planned 2026-10-25 by the plan role, split from the too-large part 3h/3; requires part 3h/3 landed, since with no pre-merge reviewer the narrowed gate scope is what sends the three repairable findings to the main watch alone; touches src/review/diff-rules.ts src/review/review.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/review.test.ts test/review-precheck.test.ts)

**Previously held 5**

**Goal.** With the pre-merge reviewer gone (part 3h/3), the gate's deterministic rules are the only pre-merge rejections. Three of the five mark a defect a later commit can repair — a conflict marker (`conflictMarkerReason`), a false fix claim on an exempt diff (`falseFixReason`) and a broken backlog structure (`backlogStructureReason`) — so they stop refusing a diff pre-merge; the main watch still reports each on main's tip. The gate keeps the three a later commit cannot repair: a brief-block edit (`briefEditReason`), a protected edit (`protectedEditReason`) and a leaked credential (`secretLeakReason`).

**Approach.**
- src/review/diff-rules.ts: `diffRuleReasons` gains a final `scope: "gate" | "watch"` argument and declares in one place which rules each scope runs, and in what order. `"watch"` runs all five in today's order (conflict marker, brief, protected, secret, false fix when `exempt`, backlog structure); `"gate"` runs only brief, protected and secret. The function still short-circuits on the first finding within the chosen scope. Extend its doc comment to name both scopes and that the watch runs the full set.
- src/review/review.ts passes `"gate"` at the `diffRuleReasons` call site; src/baseline/main-watch.ts passes `"watch"`. Those are the only two call sites.
- docs/how-it-works.md, the **Review.** paragraph: the pre-merge gate rejects the brief-block, protected-edit and secret-leak changes; a conflict marker, a false fix claim and a broken backlog structure are reported by the main watch after they land.
- docs/invariants.md, "The merge gate's deterministic rejections": INV-G3 moves its pre-merge guarantee to the stage check and the main watch (the gate no longer rejects conflict markers; the read-error fail-closed behavior stays pinned through `conflictMarkerReason`'s own tests and the stage check); the section intro's "runs the same deterministic diff rules on main's new tip after it lands, in the gate's own order and scope" says the watch runs the full set while the gate runs the three unrepairable rules. INV-G1 (brief/protected) and INV-G2 (secret) are unchanged.

**Files touched.** src/review/diff-rules.ts src/review/review.ts src/baseline/main-watch.ts docs/how-it-works.md docs/invariants.md test/review.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- The gate approves a change whose only finding is a conflict marker, a false fix claim or a broken backlog structure; it still rejects on a brief-block edit, a protected edit or a leaked credential.
- The main watch still reports all five: a main tip carrying a conflict marker, a false fix claim or a broken backlog structure logs the same `main's tip <sha> fails the diff rules: <reason>` warning as today.
- `grep -n 'diffRuleReasons' src` shows the two call sites only, each passing a literal scope (`"gate"` in review.ts, `"watch"` in main-watch.ts).
- `npm run test:gate` passes.

**Tests.**
- test/review-precheck.test.ts: give every `diffRuleReasons` call in `diffRuleReasons returns the gate's rules in order` a scope argument, keeping the full-order assertions on `"watch"`, and add `the gate scope runs only the three unrepairable rules` — under `"gate"` an exempt diff with a conflict marker and a false fix claim returns `[]` while `"watch"` returns the conflict-marker reason; a brief-block edit and a secret leak are found under both scopes.
- test/review.test.ts: re-point `gate rejects a change that still holds conflict markers, with no pi run` and `gate rejects an md-only diff that files a new plan directly under ## Done, with no pi run` to assert the gate now approves or exempts them and the main watch reports them (its conflict-marker cases live in test/main-watch.test.ts). The protected-edit, secret-leak, exempt and already-approved cases pass unchanged.
- The fail-closed read-error guarantee stays covered by test/merge-git.test.ts's `conflictMarkerReason` read-error case and the stage check (`test/stage-check.test.ts`).

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

### Subtract, part 1e/6: The backlog staleness and structure banners go — stale questions, stalled entries, plan dependencies, stranded plans, duplicated headings, live archive, validation gaps and false fixes move to the doctor (planned 2026-10-26 by the plan role, split from the too-large part 1/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 6; requires Subtract part 1d/6 landed; touches src/ui/team-alert-backlog.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Previously held 1**

**Goal.** src/ui/team-alert-backlog.ts keeps its two decision-queue builders — `pushQuestionsAlert` (open questions need your answer) and `pushRefusedAlert` — and loses the rest: stale questions, stalled entries, plan dependencies, stranded plans, duplicated headings, finished history under a live `## Done`/`## Fixed`, validation gaps and false fixes. Each maps to a doctor row: `stale questions`, `stalled entries`, `plan dependencies`, `plans stuck in Planned`, `backlog headings`, `backlog archive`, `validation gaps`, `regressed fixes`. (`pushOperatorHeldAlert` is already gone after Subtract parts 2a–2c/6.)

**Approach.**
- Delete from src/ui/team-alert-backlog.ts: `pushStaleQuestionsAlert`, `pushStalledEntriesAlert`, `pushPlanDependencyAlert`, `pushStrandedPlansAlert`, `pushBacklogHeadingsAlert`, `pushBacklogArchiveAlert`, `pushValidationGapsAlert`, `pushFalseFixesAlert` and their calls in `buildBacklogAlerts`; keep `pushQuestionsAlert` and `pushRefusedAlert`.
- Delete the `staleOpenQuestions` and `planDependencyAlert` feeds and the `StaleQuestion`/`PlanDependencyProblem` types from src/ui/alert-feeds.ts / team-alert-shared.ts, plus `BacklogHeadingDuplicate`/`LiveFinishedEntry` when no kept builder reads them. Keep the shared structural readers (`stalledEntries`, `strandedPlanEntriesFor`, `duplicatedBacklogHeadings`, `liveFinishedEntriesFor`, `validationGapProblems`, `fixClaimProblems`) that the doctor checks call.
- Update `teamAlerts`' parameters and the three call sites, and the team-alerts.test.ts / status-payload.test.ts cases; sweep docs/how-it-works.md's sentences naming these banners.
- Remove any src/ui/team-alert-shared.ts export whose last caller this part deletes, verified by grep.
- Do not touch the doctor checks or their shared readers (src/doctor/doctor-backlog-plans.ts, doctor-backlog.ts): they are the detail.

**Files touched.** src/ui/team-alert-backlog.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- `buildBacklogAlerts` emits only the question and refused alerts; no other builder remains in the module.
- Each deleted condition prints its `tumwater doctor` row (listed above).
- No src/ui/team-alert-shared.ts export is left with zero callers in src/ui.
- `npm run test:gate` passes.

**Needs review 2026-10-28 by feature: could not converge — (prior 3) `test/doctor-backlog.test.ts` still carries stale comments naming the removed always-on alerts (lines 264, 395, 913), so the prior objection's stale-comment defect is not fully resolved.; New: `test/fix-claim.test.ts:293-294` still names the removed false-fixes "standing amber alert", leaving the comment sweep claimed in the summary/WHY incomplete.**

### Subtract, part 5v/6: The window-reserve config keys and their editors go (planned 2026-10-26 by the plan role, split 2026-10-28 by the plan role from the too-large part 5d/6 after feature held it (held 1): the third of four finer parts replacing it, sibling to parts 5d/6, 5u/6, 5w/6 and 5x/6; requires parts 5d/6 and 5u/6 landed, since with the window move and the reserve/warning loops gone no caller reads `windowReserveFor`; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-validation-roles.ts src/config/config-views.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-write.ts src/config/config-example.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts docs/config.md test/config.test.ts test/config-views.test.ts)

**Goal.** The top-level `claudeWindowReserve` and `backends.<id>.windowReserve` keys and every surface that sets them go. `windowReserveFor` and the nested-reserve collapse in `config-write.ts` are deleted; the GUI and TUI offer no reserve row.

**Approach.** Delete the schema keys, their validation (`checkWindowReserve`, `validateClaudeWindowReserve`), `windowReserveFor` (src/config/config-views.ts), the editable key, the example key, the GUI settings row and the TUI `tui-editor-claude-reserve.ts` editor with its mode wiring.

**Acceptance criteria.**
- `grep -rnE 'windowReserveFor|claudeWindowReserve|windowReserve' src/` finds no live reference.
- A config setting either reserve key is refused by name (test/config.test.ts); the GUI settings view and the TUI editor list no reserve row.
- `npm run test:gate` passes.

### Subtract, part 5w/6: The `claude window`/`codex window` doctor rows go (planned 2026-10-26 by the plan role, split 2026-10-28 by the plan role from the too-large part 5d/6 after feature held it (held 1): the fourth of four finer parts replacing it, sibling to parts 5d/6, 5u/6 and 5v/6 and to part 5x/6; requires part 5u/6 landed, since with the hold and event loops gone the doctor row is the last reader of `windowObservation`; independent in file of parts 5d/6, 5v/6 and 5x/6; touches src/doctor/doctor-holds.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts docs/backends.md docs/how-it-works.md test/doctor-holds.test.ts test/doctor-checks.test.ts)

**Goal.** `checkSubscriptionWindow` and the `claude window`/`codex window` rows are deleted from `DOCTOR_CHECK_NAMES`; no doctor check reports a subscription usage window.

**Approach.** Delete `checkSubscriptionWindow` (src/doctor/doctor-holds.ts) and its two registrations (src/doctor/doctor.ts); remove the two names and their row builders (src/doctor/doctor-check-names.ts). Remove the window cases from `test/doctor-holds.test.ts` and `test/doctor-checks.test.ts`.

**Acceptance criteria.**
- `grep -rnE 'checkSubscriptionWindow|claude window|codex window' src/` finds no live reference; the two names are gone from `DOCTOR_CHECK_NAMES`.
- `npm run test:gate` passes.

### Subtract, part 5x/6: The subscription-window displays go and the account store loses only its window-hold helpers — its billing and overage reading stays (planned 2026-10-26 by the plan role, split 2026-10-28 by the plan role from the too-large part 5d/6 after feature held it (held 1): the display half of the held part, sibling to parts 5d/6, 5u/6, 5v/6 and 5w/6; requires part 5w/6 landed, since with the doctor row gone every display is the last reader of the window helpers; independent in file of parts 5d/6 and 5v/6; the per-backend account file and its `billing`/`windows` reading stay because the kept budget fallback's `seamFree`/`piPairFree`/`claudeOverageRefused` read them; touches src/ui/badges.ts src/ui/status-render.ts src/ui/status-payload.ts src/status/status-data.ts src/status/status-budget.ts src/status/status-roles.ts src/roles/role-render.ts src/roles/role-view.ts src/agent/subscription-account.ts src/agent/claude/claude-account.ts docs/backends.md docs/how-it-works.md docs/invariants.md test/badges.test.ts test/role-view.test.ts test/status-payload.test.ts test/subscription-account.test.ts test/doctor-holds.test.ts)

**Goal.** No role view, status row, badge or status render names a subscription usage window. `windowUsedUp`, `claudeWindowUsedUp`, `windowReserved`, `windowObservation`, `windowEntries`, `windowLabel`, `utilizationPct` and the `SubscriptionWindowBlock`/`ClaudeWindowEntry` display types are deleted. The store keeps `SubscriptionAccount.billing`, `plan`, `observedAt` and `windows`, so `subscriptionBackendOf`, `accountUsesOverage`, `claudeOverageRefused` and `subscriptionWindowRejected` keep working and the budget fallback's free-ness is unchanged.

**Approach.** Remove the window fields and reads from the role view, status payload, status render, badges, status-data and status-budget; delete the window display helpers and the used-up/reserve readers from `src/agent/subscription-account.ts` and their re-exports in the claude and codex account modules; keep `readAccount`/`writeAccount`/`observeAccount` and the `windows` map. Update the docs and drop the window-only test cases.

**Acceptance criteria.**
- `grep -rnE 'windowUsedUp|claudeWindowUsedUp|windowReserved|windowObservation|windowEntries|windowLabel|utilizationPct|SubscriptionWindowBlock|ClaudeWindowEntry' src/` finds no live reference.
- The account store still reads and writes `billing` and per-window `overageStatus`; a subscription claude seam reads free while not in overage and is still usable as a free fallback at the cap (test/subscription-account.test.ts, test/orchestrator-fallback.test.ts).
- `npm run test:gate` passes.

### `falseFixReason`'s complexity-17 false-fix body is split into one named helper per concern — the head read, the base bodies, the moved-entry check and the added-record check — so "what does a `## Fixed` head read as when BUGS.md is deleted or a symlink?", "which base bodies does an untouched entry compare against?", "how is a moved or rewritten Fixed entry judged?" and "how is an added one-line record judged?" are each found by name (planned 2026-10-28 by the plan role; continues the landed split-large-function family — the 2026-10-28 `RunUsage.fold`, `checkClaudeVersion` and notes-cli `main` plans and the 2026-10-27 `cmdReport` plan each extract one named helper per concern the same way; independent in file of every `## Planned` entry — `grep -n 'src/verdict\|fix-claim' PLANS.md` prints nothing, so no heading's touches list names the file or a symbol in it; the one prose mention, part 3m/3's Goal, edits src/review/diff-rules.ts, src/review/review.ts and src/baseline/main-watch.ts only, never this file; PLANS-DONE.md records no split of `falseFixReason` (`grep -cE '^### .*falseFixReason' PLANS-DONE.md` prints 0); docs/invariants.md binds `falseFixReason`, `fixSymbols` and `unbackedSymbols`, but a behavior-preserving private move leaves that binding and its pinned `test/fix-claim.test.ts` cases unchanged; touches src/verdict/fix-claim.ts)

**Goal.** `falseFixReason` (src/verdict/fix-claim.ts) is one ~145-line async body: it gates on the diff's files, reads the two `## Fixed` heads under the lstat policy, reads the diff's base at its merge-base, builds a `Map` of base bodies by normalized heading, then runs two independent checks — a changed full entry whose Fix paragraph names unbacked symbols, and an added or edited one-line record that introduces a name absent from the base's Fixed section — each returning its own rejection message and each sharing one lazily built source haystack. Every concern is inline, so "what does the head read do with a symlink?" and "which names does an added record carry forward?" have no name to grep. Extract each concern into a named module-private helper and leave `falseFixReason` the file gate plus the two-check composition. No behavior change: every rejection string is byte-identical and no exported symbol moves.

**Approach.** All edits in src/verdict/fix-claim.ts; move the existing code blocks, do not rewrite them, and move each existing comment with the helper that owns the code it describes. Add four non-exported helpers beside `falseFixReason`:
- `readFixedHeads(wt): string[]` — the `["BUGS.md", BUGS_ARCHIVE].map(...)` read: the `lstatSync(full).isFile()` check and the `readTextOrNull(full) ?? ""` fallback, so a deleted, unreadable or symlinked head reads as empty. It owns the comment explaining that policy. `falseFixReason` keeps the `files.includes("BUGS.md")`/`files.includes(BUGS_ARCHIVE)` gate and the `heads.some((head) => head.includes("## Fixed"))` early return.
- `baseFixedBodies(wt, mainBranch): Promise<{ bases: Array<string | null>; bodies: Map<string, Set<string>> }>` — `changeBaseRev` plus the two `fileContentAt` reads and the loop keying each base `fixedEntries` body by `normalizeFixedHeading(e.title)`. It owns the "diff's own base, not main's tip" and the "two distinct entries share one heading" comments.
- `movedEntryReason(wt, entries, bodies, haystack): string | undefined` — the `for (const { title: heading, body } of entries)` loop: skip a known base body, build the haystack on first need, `unbackedSymbols`/`missingSymbolNames`, and the two rejection strings (the moved-entry and the rewritten-entry arms). It owns the "built lazily" comment and the rejection-shape comment.
- `addedRecordReason(wt, records, bases, haystack): string | undefined` — the `baseLines`/`seen`/`baseText` derivation and the `for (const record of records)` loop with its one-line-record rejection. It owns the "records are compressions" comment.

`falseFixReason` holds `let haystack: string | undefined;` and a `const getHaystack = () => (haystack ??= sourceHaystack(wt));` passed to both check helpers, preserving the one lazy walk; it returns `movedEntryReason(...) ?? addedRecordReason(...)`. The exported `normalizeFixedHeading`, `fixSymbols`, `unbackedSymbols`, `sourceHaystack` and the `RECORD_QUOTE_MAX` constant stay as they are. `falseFixReason` keeps its signature, its position and its export.

**Files touched.** src/verdict/fix-claim.ts

**Acceptance criteria.**
- `falseFixReason`'s complexity drops below 15 and each new helper's does too: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/verdict/fix-claim.ts` reports no `complexity` warning for `falseFixReason` or any helper above the 15 the family targets (the rule's `max: 0` lists every surviving function).
- The four helpers are each declared exactly once and are not exported: `grep -nE 'function (readFixedHeads|baseFixedBodies|movedEntryReason|addedRecordReason)\(' src/verdict/fix-claim.ts` shows one declaration per name, and `grep -nE '^export (async )?function (readFixedHeads|baseFixedBodies|movedEntryReason|addedRecordReason)' src/verdict/fix-claim.ts` finds nothing.
- Every existing `test/fix-claim.test.ts` and `test/fix-claim-archive.test.ts` case passes unchanged, including the moved-entry and rewritten-entry rejections, the added-record rejection, the "carries forward a name the base already holds" pass, the deleted and symlinked BUGS.md passes and the merge-base restoration case; the rejection strings are byte-identical, so no test is added or edited.
- `npm run test:gate` passes.

### Every commit is verified on main, part 4f/3: the pre-merge reviewer's batch, phase and pipeline cases move to the deterministic gate ahead of its removal (planned 2026-10-28 by the plan role, split from part 3h/3 after a 2026-10-28 feature run found the earlier re-pointing parts (3p/3–4d/3) had left these reviewer-run cases standing; sibling to part 4g/3, which takes the vet-slot, high-friction, rejection and merge-lock cases in test/merge-drain-verify.test.ts, test/runner-2.test.ts, test/runner-3.test.ts and test/runner-4.test.ts, so the two are independent in files and hold no prerequisite, since every case it re-points is green while the pre-merge reviewer still runs; touches test/merger.test.ts test/merge-pipeline.test.ts test/merge-slot.test.ts)

**Goal.** The pre-merge reviewer's batch-sequencing, merge-phase and pipeline-permit cases in these three files still read a reviewer verdict or a reviewer run. Part 3h/3 stops `reviewAttempt` running the reviewer, which breaks them, so move them first with part 3p/3's rule: delete a case that exists only to pin the reviewer; re-point one whose real subject is batch/phase/permit bookkeeping to a deterministic gate outcome (a green or red build pre-check, a parked build-check verification, or a deterministic diff rejection).

**Approach.**
- test/merger.test.ts: `a green batch stacks every approved change, fast-forwards main once, and logs per-change events` and `a batch stacks every commit of a multi-commit pin, not its head alone` read the reviewer's approve verdict to make each change gate-approved; re-point their approval to the deterministic green build pre-check. `an abort after the last gate approved stops the batch before its shared check` and `an abort after the gate stops a one-change merge before it merges` expect the reviewer run to observe the abort; re-point the abort to the gate build check, as the 4b/3 and 4c/3 siblings did for orchestrator-3 (a parked build check settles `aborted`).
- test/merge-pipeline.test.ts: `the merge's conflict resolver takes a shared permit, ahead of a verification parked for one` parks a `beta-review` verification; re-point that parked verification to a build-check verification (or drop the review row it names) and keep the resolver-before-parked-verification ordering assertion.
- test/merge-slot.test.ts: `a queued merge's record names each phase while it runs: the gate's check, the review, the merge's in-lock check` expects a `review:reviewing` stage; with no pre-merge reviewer there is no `reviewing` stage, so re-point the record to `check:build-check` before and after the in-lock check and drop the `review:reviewing` expectation.
- Leave `test/fixtures/pi-events.ts` and `test/fixtures/merge-fixtures.ts` reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/merger.test.ts test/merge-pipeline.test.ts test/merge-slot.test.ts

**Acceptance criteria.**
- The three files pass while the pre-merge reviewer still runs; none of their cases reads a pre-merge reviewer verdict to reach its assertion (no `reviewerPi`/`review_start`/`reviewArgs` pre-merge read remains in them).
- `npm run test:gate` passes.

### `promptPrefix`'s complexity-36 flat prefix chain is replaced by one ordered label table — the twenty-five `if (mode.…)` arms become an `Array<[boolean, StatusSpan[]]>` read through one lookup — so "which editor/mode owns the prompt-line prefix, and if two flags are set which wins?" is one table read and `promptPrefix` holds only the lookup plus the director/image fallback (planned 2026-10-28 by the plan role; continues the landed ordered-route conversion family — the 2026-10-28 `Ctrl`-dispatch and pane-router plans replace flat `if`/`else if` chains with one ordered table read through one lookup the same way; independent in file of every `## Planned` entry — `grep -c 'tui-frame\|promptPrefix' PLANS.md` prints 0, so no heading or touches list names the file or the symbol (the blocked `Every commit is verified on main` parts and the blocked `Subtract` parts name no `tui-frame.ts` either); `grep -cE '^### .*promptPrefix' PLANS-DONE.md` prints 0, and its `tui-frame` headings are landed behavior additions to `promptPrefix`'s arms and `hintLine`, never a table conversion of this function; `grep -c 'promptPrefix' docs/invariants.md` prints 0, so a behavior-preserving private move needs no docs edit; touches src/ui/tui/tui-frame.ts)

**Goal.** `promptPrefix` (src/ui/tui/tui-frame.ts) is one 36-complexity chain of 25 `if (mode.…) return [{ text: … }]` arms — an ordered list from the daily-cap editor to the pause editor — followed by the director/role target with its image count. A reader asking "which editor owns the prefix?" or "if two mode flags are set, which wins?" reads the whole chain, and inserting a new editor means finding the right seam by eye. Replace the chain with one ordered `Array<[boolean, StatusSpan[]]>` table read through one lookup, so precedence *is* the table's order and `promptPrefix` holds only the lookup plus the director/image fallback. No behavior change: every branch returns the byte-identical span array and no exported symbol moves.

**Approach.** All edits in src/ui/tui/tui-frame.ts; move the existing arms into the table, do not rewrite their labels.
- Add a module-private `labeledPrefix(label: string): StatusSpan[]` returning `[{ text: label, tone: "brand" }, { text: " › " }]`, and a module-private `editorPromptPrefix(mode: TuiMode): StatusSpan[] | undefined` holding the ordered `const prompts: Array<[boolean, StatusSpan[]]> = [...]` and a `for (const [active, spans] of prompts) if (active) return spans; return undefined;`.
- Port each arm in the current order, exactly: the `budget` entry keeps its own `[{ text: "daily cap $", tone: "brand" }, { text: " " }]` (space, not ` › `); every other entry uses `labeledPrefix` with its current label. Keep the same truthiness the `if` had (the string modes fire only on a truthy value, so an empty string still does not fire), and keep `quietMode`'s `quietTeam` ternary, the `instructionsEditFor`/`notesEditFor` interpolation, `entryEditFor`'s new/edit-`#` ternary and `pauseEditMode`'s stop-in/schedule/wake label inside the entry.
- `promptPrefix` becomes the lookup: `const prefix = editorPromptPrefix(mode); if (prefix) return prefix;` then the existing director-target block (`mode.rolePromptFor ?? "director"`, the `withImages` guard, the `plural` count) unchanged. Keep its export, signature and doc comment, extended to name the table.
- Change nothing else in the file: `hintLine`, the `TuiMode` interface and every other export stay as they are.

**Files touched.** src/ui/tui/tui-frame.ts

**Acceptance criteria.**
- `promptPrefix` and `editorPromptPrefix` each score below 15, and no other function in the file rises: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/ui/tui/tui-frame.ts` reports no `complexity` warning above the 15 the family targets (the rule's `max: 0` lists every surviving function).
- `labeledPrefix` and `editorPromptPrefix` are each declared exactly once and are not exported: `grep -nE 'function (labeledPrefix|editorPromptPrefix)\(' src/ui/tui/tui-frame.ts` shows one declaration per name and `grep -nE '^export (function|const) (labeledPrefix|editorPromptPrefix)' src/ui/tui/tui-frame.ts` finds nothing.
- The table holds 25 entries in the current arm order, the `budget` entry alone ends its spans with `{ text: " " }`, and `promptPrefix`'s body contains no `if (mode.…)` arm of its own — only the `editorPromptPrefix` call and the director block.
- Every existing `test/tui-frame.test.ts` `promptPrefix` case passes unchanged — including `daily cap $ ` (space), `run cap › `, `quiet hours`/`team quiet hours`, `new bug › `/`edit plan #2 › `, `pause qa › `, `wake qa › `, `director (2 images) › ` and `qa › ` with images ignored — so no test is added or edited.
- `npm run test:gate` passes.

### `logBudgetGateEvents`' complexity-30 warning-and-transition body is split into one named helper per concern — the 80% warning edge, the transition-type choice, the fallback-identity fields and the pause-cause ladder — so "when does the warning fire and re-arm?", "which `budget_*` type does a crossing log?", "what names the fallback pair and its per-tier map?" and "what names a paused gate's cause?" are each found by name (planned 2026-10-28 by the plan role; continues the landed split-large-function family — the 2026-10-28 `RunUsage.fold`, `checkClaudeVersion` and notes-cli `main` plans each extract one named helper per concern the same way; independent in file of every `## Planned` entry — `grep -c 'budget-gates\|logBudgetGateEvents' PLANS.md` prints 0, so no heading or touches list names the file or the symbol; the blocked `Every commit is verified on main` parts edit src/review, src/orchestrator, src/runner, src/merge, src/baseline, src/status, src/doctor, src/config, src/cli, src/roles, src/ui, src/gui, src/events, src/failure, src/prompt, src/run and src/request-timeouts.ts, and the blocked and in-flight `Subtract` parts edit its sibling src/gates/gate-polls.ts, never src/gates/budget-gates.ts; PLANS-DONE.md records the 2026-10-25 entry that created `logBudgetGateEvents` by splitting `pollBudgetGate` (`grep -cE '^### .*logBudgetGateEvents' PLANS-DONE.md` prints 1, that creation entry), but no entry splits `logBudgetGateEvents` itself; docs/invariants.md binds no symbol of the file (`grep -c 'src/gates/budget-gates.ts' docs/invariants.md` prints 0 — its only mention pins `test/budget-gates.test.ts` under INV-BN2), so a behavior-preserving private move leaves it unchanged; touches src/gates/budget-gates.ts)

**Goal.** `logBudgetGateEvents` (src/gates/budget-gates.ts) is one ~90-line body with four inline concerns: the 80%-of-cap warning state machine (`state.warned` set, cleared, and logged as one `budget_warning`), the transition event's `budget_resumed`/`budget_fallback`/`budget_paused` type choice, the fallback identity fields (`provider`/`model` plus the per-tier map when the tiers resolve to two or more distinct pairs), and the paused gate's cause ladder (demoted pair with its failure count, refused pair, or the strong tier's demoted pair). A reader asking any of those questions reads the whole body, and the nested spreads make the event's shape hard to scan. Extract each concern into a named module-private helper and leave `logBudgetGateEvents` the destructure, the warning computation, the one `topRoles` read and the event composition. No behavior change: every field and every logged event is byte-identical and no exported symbol moves.

**Approach.** All edits in src/gates/budget-gates.ts; move the existing blocks verbatim, do not rewrite them, and keep each `//`/`/** */` comment with the block it annotates. No import changes: `budgetWarning`, `topDailySpenders`, `logEventBestEffort`, `TUMWATER_SOURCE`, `modelPairName`, `tierFallbackLabels` and `tiersResolveDistinctPairs` are all already imported.
- Add module-private `function budgetTransitionType(gate: BudgetGate): "budget_resumed" | "budget_fallback" | "budget_paused"` returning today's `gate === "open" ? "budget_resumed" : gate === "fallback" ? "budget_fallback" : "budget_paused"`.
- Add module-private `function budgetWarningEdge(input: BudgetGateEventInput, warn: boolean, topRoles: ReturnType<typeof topDailySpenders>): void` holding the `if (warn && !state.warned) { logEventBestEffort(...type: "budget_warning"...); state.warned = true } else if (!warn) { state.warned = false }` block and the comment explaining the edge trigger. It reads `state`, `root`, `spentUsd`, `capUsd` off `input`.
- Add module-private `function fallbackTransitionFields(input: BudgetGateEventInput): Record<string, unknown>` holding the `gate === "fallback" ? { provider: pair?.provider, model: pair?.model, ...(tiersResolveDistinctPairs(servingResolved) ? { tiers: tierFallbackLabels(servingResolved) } : {}) } : {}` record and both its comments (the fallback identity and the per-tier story).
- Add module-private `function pausedTransitionFields(input: BudgetGateEventInput): Record<string, unknown>` holding the `gate === "paused" && ...` ternary ladder and the comment naming the pause's cause, including the `state.breakers[...]?.failures ?? 0` reads.
- In `logBudgetGateEvents` keep the destructure and the `const warn = gate === "open" && budgetWarning({ spentUsd, capUsd });` computation and its comment, and the `const topRoles = (warn && !state.warned) || gate !== state.prevGate ? topDailySpenders(states, now) : [];` line and its "read once" comment. Call `budgetWarningEdge(input, warn, topRoles)`, then inside `if (gate !== state.prevGate)` build the event with `type: budgetTransitionType(gate)`, keep `...(gate !== "open" && topRoles.length > 0 ? { topRoles } : {})`, and spread `...fallbackTransitionFields(input)` and `...pausedTransitionFields(input)` where the two inline spreads were, then `state.prevGate = gate`.
- Keep `newBudgetGateState`, `runOnPair`, `gateRoleConfig`, `pollBudgetGate` and the `chainInfo`/`subscriptionBackendOf` re-export exported and their signatures unchanged.

**Files touched.** src/gates/budget-gates.ts

**Acceptance criteria.**
- `logBudgetGateEvents` and all four new helpers score below 15: `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json src/gates/budget-gates.ts` reports no `complexity` warning above the 15 the family targets (the rule's `max: 0` lists every surviving function).
- The four helpers are each declared exactly once and are not exported: `grep -nE 'function (budgetTransitionType|budgetWarningEdge|fallbackTransitionFields|pausedTransitionFields)\(' src/gates/budget-gates.ts` shows one declaration per name, and `grep -nE '^export (function|const) (budgetTransitionType|budgetWarningEdge|fallbackTransitionFields|pausedTransitionFields)' src/gates/budget-gates.ts` finds nothing.
- Every event field is byte-identical: the existing `test/budget-gates.test.ts` cases pass unchanged — including "crossing the cap engages the fallback once: one event, the derived role view, no re-derives", "a tiered fallback with two distinct pairs carries the per-tier map on the event", "crossing 80% of the cap warns once while the gate is open, and re-arms after dropping below", "the budget warning names the roles spending most, highest first", "a demoted strong-tier pair names itself as the pause cause when only strong declares a fallback" and "an unborrowable strong tier pauses the gate without naming the serving default pair as demoted" — and `test/gate-polls.test.ts` and `test/budget-wiring.test.ts` pass too, so no test is added or edited.
- `state.prevGate` is still written only inside `logBudgetGateEvents`, and `state.warned` only inside `budgetWarningEdge`.
- `npm run test:gate` passes.

## Done
