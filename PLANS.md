# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; split 2026-10-25 by the plan role — the gate-scope narrowing moved to part 3m/3, then split again the same day after feature held it too large (held 6): the migration of the pre-merge reviewer's merge-verify and pipeline/runner/e2e cases moved to parts 3p/3–3w/3, so this part now requires parts 3g/3, 3l/3, 3p/3, 3z/3, 4a/3, 3q/3, 3r/3, 3s/3, 3t/3, 3u/3, 3v/3, 3w/3, 3x/3 and 3y/3 landed — 3g/3's universal post-landing review and 3l/3's review-suite retirement are on main, and 3p/3–3y/3 must retire the remaining reviewer-run cases before the run they assert goes; touches src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts)

**Previously held 6**

**Goal.** `reviewAheadOfMain` (src/review/review.ts) stops running the pre-merge model reviewer: after the deterministic diff rules, the exempt check and the build pre-check it approves, so every merged change is judged once, by the post-landing review (part 3g/3). This part keeps the gate's five deterministic rules as they are and leaves the reviewer's retry/overlap seams in place; part 3m/3 narrows the gate's rule scope, and the reviewer's remaining plumbing goes with review-run.ts/review-followup.ts. After this part lands, no diff starts a pi reviewer run.

**Approach.**
- `reviewAttempt` (src/review/review.ts): once `gateBuildPrecheck` returns a passing pre-check, set `state.lastApprovedHead = head`, clear `state.reviewResume` and return `{ decision: "approved", verifiedHead: retry.pre.verifiedHead }` — today's `review.afterMerge` branch, now the only continuation. The `afterMerge` (`reviewedAfterMerge`) and `patchApproved` (`patchId`/`approvedPatchIds`) approvals, the overlap helpers (`leaseCheckSlot`, `startOverlappedCheck`, and the `SlotLeaseHandle` import), the `keep`/`settleFailedCheck` helpers, the `runReviewer` call and the `restoreReviewedHead`/`withRuns` import go. Keep `CheckOverlap` and `ReviewRetry` exported — review-run.ts still imports both. The build pre-check now always runs in the change's own slot. `review-run.ts` and `review-followup.ts` stay compiling and unreferenced.
- Keep `reviewAheadOfMain`'s one-attempt-per-loop shape and `reviewAttempt`'s `retry` argument: `retryable` is never set, so the loop returns the first result. Leave the `GateResult.run`/`followUpRun`/`nudgeRun`/`retryable` fields and the `ReviewContext.leaseCheckSlot`/`reviewHeld`/`retries`/`retryDelayMs`/`foldUsage` members in place — this part removes only what `noUnusedLocals` rejects, and the remaining reviewer seams go with review-run.ts/review-followup.ts.
- Keep the `reject` path's bookkeeping, the exempt path and `gateBuildPrecheck`'s behavior unchanged.
- docs/how-it-works.md: the **Review.** paragraph says the pre-merge gate is deterministic (the diff rules, the exempt fast path and the build pre-check) and every merge is judged once after landing, by the post-landing review; the `review.afterMerge` bullet's "A role listed in `review.afterMerge` is reviewed after merging … then merges with no reviewer run" becomes true of every role pending part 3d/3's key deletion.

**Files touched.** src/review/review.ts docs/how-it-works.md test/review.test.ts test/review-precheck.test.ts

**Acceptance criteria.**
- `reviewAheadOfMain` starts no pi reviewer run: a healthy code change reaches `{ decision: "approved" }` with `state.lastApprovedHead === head` and the pi-run marker absent.
- A diff with a secret leak, a brief-block edit, a protected edit or a conflict marker still rejects with that reason; an exempt (md-only) diff still returns `exempt`; the build pre-check still rejects as before.
- `npm run test:gate` passes.

**Tests.**
- Part 3l/3 has retired the reviewer cases in both files; re-point only the kept cases the source change touches.
- test/review.test.ts: re-point `gate fails closed on an aborted run without bookkeeping` off its fake reviewer run (`a shutdown during a failing pre-check fails closed` in test/review-precheck.test.ts already covers the abort path) while keeping its assertions that the commit stays and no bookkeeping is written. The deterministic-rule, exempt, already-approved and no-op cases pass unchanged; no case references `runReviewer`, and the `reviewRetryDelayMs` case stays until the reviewer seams go with review-run.ts.
- test/review-precheck.test.ts: add `a green pre-check approves with no reviewer run` — a healthy build returns `{ decision: "approved" }`, `state.lastApprovedHead` is set, and the pi-run marker is absent.
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

### Every commit is verified on main, part 3v/3: the pre-merge reviewer's orchestrator e2e cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3o/3 after feature held it (held 7); one of eight finer parts replacing the held parts 3n/3 and 3o/3, independent in files of the other seven (3p/3–3w/3), which take disjoint test files, and holding no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/orchestrator-3.e2e.test.ts)

**Previously held 7**

**Needs review 2026-10-25 by feature: too large for one run (held 8)**

**Goal.** The orchestrator-e2e twin of part 3s/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/orchestrator-3.e2e.test.ts`'s held/hanging reviewer runs, its reject-driven merge outcomes and its per-seam reviewer-model assertions fail. Move those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/orchestrator-3.e2e.test.ts`, retire or re-point the pre-merge reviewer cases: re-point a case that holds a merge on a hanging reviewer run to a deterministic gate rejection (a conflict-marker diff or a failing declared check) when its real subject is the orchestrator's scheduling handoff, or delete a case that exists only to pin the reviewer's hold; drop the reviewer-model per-seam assertion where the surviving post-landing review does not carry it. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-3.e2e.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the file for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- Every case that remains keeps its original subject (orchestrator scheduling and redeploy handoff) and asserts the same outcome through a deterministic rejection.
- No edit outside test/orchestrator-3.e2e.test.ts.

### Every commit is verified on main, part 3w/3: the pre-merge reviewer's orchestrator-mixed and director cases are re-pointed to the deterministic gate ahead of its removal (planned 2026-10-25 by the plan role, split from the too-large part 3o/3 after feature held it (held 7); one of eight finer parts replacing the held parts 3n/3 and 3o/3, independent in files of the other seven (3p/3–3w/3), which take disjoint test files, and holding no prerequisite, since every case it retires or re-points is green while the pre-merge reviewer still runs; touches test/orchestrator-mixed.e2e.test.ts test/orchestrator-director.test.ts)

**Needs review 2026-10-25 by feature: too large for one run (held 8)**

**Previously held 7**

**Goal.** The orchestrator-mixed and director twin of part 3v/3: part 3h/3 stops `reviewAttempt` from running the model reviewer, which makes `test/orchestrator-mixed.e2e.test.ts`'s `review_start` assertion and `test/orchestrator-director.test.ts`'s reject/idle-reviewer cases and its `review.afterMerge: []` hold case fail. Move those cases first so the source switch lands against a suite that no longer depends on the reviewer.

**Approach.** In `test/orchestrator-mixed.e2e.test.ts`, re-point the `review_start` assertion to the surviving post-landing review, or drop it where the mixed flow no longer starts a pre-merge run. In `test/orchestrator-director.test.ts`, retire or re-point the reject-reviewer case ("an idle reply is a review_error") and the case that sets `review.afterMerge: []` to hold a merge on a pre-merge review: re-point each to a deterministic gate rejection (a conflict-marker diff or a failing declared check) when its real subject is the director's abort/handoff bookkeeping, or delete it when it exists only to pin the reviewer. Leave the reviewer-run helpers in place; part 3e/3 deletes them.

**Files touched.** test/orchestrator-mixed.e2e.test.ts test/orchestrator-director.test.ts

**Acceptance criteria.**
- `npm run test:gate` passes with the pre-merge reviewer still running.
- A grep over the two files for `VERDICT: reject`, `review_error`, `reviewRetries`, `review_failed`, `unreviewFailures`, `folded.length` and `lastReview?.verdict` returns no case that drives the pre-merge reviewer.
- `review_start` assertions name only post-landing (`afterMerge: true`) reviewer runs, or survive as flow assertions that do not count a pre-merge run.
- No edit outside test/orchestrator-mixed.e2e.test.ts and test/orchestrator-director.test.ts.

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

### Subtract, part 6/6: The sweep — the rows, keys and docs the five parts left behind (planned 2026-10-26 by the operator; design in plans/subtract.md "The six strokes" and "How we will know it worked"; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts)

**Refused 2026-10-26 by feature: the sweep deletes rows, keys, and docs for mechanisms that are still live in src/ and tumwater.json (instances, mergeCommand, maxConcurrentChecks, maxConcurrentPerProvider, check-permit, worktree-pool, claims, model-fallback), so implementing the entry as written breaks the build and the gate.**

**Goal.** The deletion reads as one system. Every name parts 1/6–5/6 removed is gone from the live docs, the example config, the doctor's row list, the alerts and the tests that assert them; the archive keeps the record.

**Approach.**
- Sweep the deleted names out of the live prose and the example config: `instances`, `slotCount`, `slot_wait`, `check_wait`, `maxConcurrentChecks`, `mergeBatchMax`, `mergeCommand`, `review.afterMerge`, `maxConcurrentPerProvider`, `fallback`, `fallbackModel`, `model.<tier>`, `over-cap model`, `slot salvage`, `merge queue`, `interlock`, `held-for-operator`, `Needs replan`, `Waiting for the next failure`, `(held N)`.
- Delete the rows and tests rather than re-pointing them: a case whose whole subject is a deleted mechanism goes (the existing wording/implementation tests rule: never re-pin), and test/doctor-checks.test.ts's row list, test/event-format.test.ts's deleted event types (`slot_wait`, `check_wait`, the merge-stage events), test/retention.test.ts's pool artifacts and test/config.test.ts's deleted keys are updated to the surviving row/key set.
- Re-check the parts 1a–1e/6 rule end to end: for every condition that used to have a banner and no longer does, the doctor row exists; for every row this series deleted, the mechanism is gone.
- docs/invariants.md drops or re-scopes the invariants of deleted subsystems (merge-slot, pool, permit, instance claims, model routing) in the same commit, per the standing rule.
- Record in the part's PLANS-DONE entry: the doctor row count and the config key count before and after the series, and the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json src/doctor/doctor-check-names.ts PLANS.md test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentChecks|maxConcurrentPerProvider|mergeBatchMax|mergeCommand|instances|slot_wait|check_wait|fallbackModel|review\.afterMerge|held-for-operator' src/ docs/ README.md DEVELOPMENT.md tumwater.example.json` finds no live reference (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every doctor row name in doctor-check-names.ts resolves to a check that reads a mechanism that still exists; no row reports a path nothing writes.
- The before/after row and key counts, and the deletions' measurement premise, are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

### Subtract, part 1b/6: The staleness, notify and queue banners go — their doctor rows keep the detail (planned 2026-10-26 by the plan role, split from the too-large part 1/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 6; requires Subtract parts 1a/6, 2a/6, 2b/6 and 2c/6 landed; touches src/ui/team-alert-backlog-feed.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Previously held 1**

**Goal.** The seven always-on banners that only restate a doctor row leave the feed: stale bugs, a failed notify page, bugs held waiting for a failure, stale prompts, stale merges, skipped merge-queue files, and a merge refused because the primary checkout would be overwritten. Each condition stays visible in `tumwater doctor` (`stale bugs`, `notify`, `waiting bugs`, `stale prompts`, `stale merge-queue entries`, `merge-queue files`, `uncommitted backlog`).

**Approach.**
- Delete src/ui/team-alert-backlog-feed.ts (`pushStaleBugsAlert`, `pushNotifyAlert`, `pushWaitingBugsAlert`, `pushStalePromptsAlert`, `pushStaleMergesAlert`, `pushSkippedMergesAlert`, `pushPrimaryOverwriteAlert`, `buildBacklogFeedAlerts`), its `buildBacklogFeedAlerts` call and parameters in `teamAlerts` (src/ui/team-alerts.ts), and its type re-exports.
- Delete the feeds and their result types from src/ui/alert-feeds.ts: `staleOpenBugs`, `notifyFailures`, `staleWaitingBugs`, `stalePrompts`, `staleMerges`, `skippedMergeFiles`, `primaryOverwriteBlocks`, and `StaleBug`, `NotifyFailure`, `PrimaryOverwriteBlock`, `StalePrompt`, `StaleMerge`, `StaleWaitingBug` (src/ui/team-alert-shared.ts); drop the imports (`doctor-backlog.ts`, `collections.ts`, `backlog.ts`, `events/notify.ts`) that go with them.
- Drop the removed positional arguments from the three `teamAlerts(...)` calls (src/ui/status-payload.ts, src/ui/status-render.ts, src/ui/tui/tui.tsx) and the matching status-payload.ts imports/type re-exports.
- Remove the team-alerts.test.ts / status-payload.test.ts cases asserting these seven banners; keep every test whose subject is the doctor row.
- Sweep docs/how-it-works.md's sentences naming these banners, pointing at the doctor rows.
- Do not touch src/doctor/doctor-backlog.ts or doctor-notify.ts: their rows are the surviving detail.

**Files touched.** src/ui/team-alert-backlog-feed.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- `teamAlerts` names none of the seven deleted inputs; `grep -rn 'buildBacklogFeedAlerts\|staleOpenBugs\|notifyFailures\|staleWaitingBugs\|skippedMergeFiles\|primaryOverwriteBlocks' src/` finds no live reference outside the doctor rows' own readers.
- The seven conditions still print their `tumwater doctor` rows, unchanged.
- `npm run test:gate` passes.

### Subtract, part 1c/6: The review and check banners go — quarantine, flapped checks, churn, post-merge risk, dropped reviews, main-diff rules and stale QA move to the doctor (planned 2026-10-26 by the plan role, split from the too-large part 1/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 6; requires Subtract part 1b/6 landed; touches src/ui/team-alert-merge.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx src/doctor/doctor-check-names.ts src/doctor/doctor-project-checks.ts docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts test/doctor-checks.test.ts)

**Previously held 1**

**Goal.** The review/check banners leave the feed: a stale flake quarantine, flapping checks, post-merge churn, a post-merge review one run from being dropped, a review dropped after repeated failures, a main tip the watch's diff rules reject, a stalled CI parity, and stale QA coverage. Their doctor rows (`flaky checks`, `post-merge churn`, `post-merge reviews`, `ci parity`, `qa coverage`) keep the detail. `main-diff-rules` is the one condition `DOCTOR_CHECK_NAMES` does not carry, so this part adds its row.

**Approach.**
- Delete src/ui/team-alert-merge.ts (`pushQuarantineAlert`, `pushFlappedChecksAlert`, `pushPostMergeChurnAlert`, `pushPostMergeRiskAlert`, `pushDroppedPostReviewsAlert`, `pushMainDiffRulesAlert`, `pushCiStaleAlert`, `pushQaStaleAlert`, `buildMergeAlerts`), its call/parameters in `teamAlerts` (`quarantined`, `flappedChecks`, `postMergeChurn`, `postReviewRisk`, `droppedPostReviews`, `mainRuleFailure`, `qaCoverage`), and its re-exports.
- Delete `quarantineAlert`, `flappedChecksAlert`, `postMergeChurnAlert`, `postReviewRiskAlert`, `droppedPostReviewsAlert`, `mainRuleFailures`, `qaCoverageAlert` and their result types (`QuarantinedTests`, `FlappedChecks`, `PostMergeChurn`, `PostReviewRisk`, `DroppedPostReviews`, `MainRuleFailure`, `QaCoverageStale`) from src/ui/alert-feeds.ts / team-alert-shared.ts. Keep `snap.ciParity`: it is the snapshot field the doctor's `ci parity` row still reads; only `pushCiStaleAlert` goes.
- Add the missing doctor row: a `main diff rules` check reading the `warning` events whose message contains `fails the diff rules` (src/baseline/main-watch.ts) within the deleted feed's 24 h window, with the marker/window constant moved to the check that now owns it; register the name in src/doctor/doctor-check-names.ts and cover it in test/doctor-checks.test.ts.
- Update the three `teamAlerts(...)` call sites and the team-alerts.test.ts / status-payload.test.ts cases; sweep docs/how-it-works.md's sentences naming these banners.
- Do not touch the surviving doctor checks (`checkFlakyChecks`, `checkPostReviews`, `checkPostMergeChurn`, `checkCiParity`, `checkQaCoverage`): they are the detail.

**Files touched.** src/ui/team-alert-merge.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx src/doctor/doctor-check-names.ts src/doctor/doctor-project-checks.ts docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts test/doctor-checks.test.ts

**Acceptance criteria.**
- `teamAlerts` produces none of the eight deleted keys; `grep -rn 'buildMergeAlerts\|quarantineAlert\|flappedChecksAlert\|postMergeChurnAlert\|postReviewRiskAlert\|droppedPostReviewsAlert\|qaCoverageAlert' src/` finds no live reference outside the doctor checks.
- Each deleted condition prints a `tumwater doctor` row: `flaky checks`, `post-merge churn`, `post-merge reviews`, `ci parity`, `qa coverage`, and the new `main diff rules`; a main tip failing a diff rule names the tip and the rule in that row.
- `npm run test:gate` passes.

### Subtract, part 1d/6: The status and tail banners that are not a stopped team go — chain, role cap, no-check, brief, truncation, build, stale claims, quiet, maintenance, provider holds/caps, pause, contention, pins, pool, regressed fixes and image probes move to the doctor (planned 2026-10-26 by the plan role, split from the too-large part 1/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 6; requires Subtract part 1c/6 and Subtract part 5e/6 landed; touches src/ui/team-alert-status.ts src/ui/team-alert-tail.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Previously held 1**

**Goal.** Only the stopped-team and decision-queue banners remain. Kept in src/ui/team-alert-status.ts: `pushMainRedAlert`, `pushFailingStreakAlert`, `pushStuckRoleAlert`, `pushSpentBudgetAlert` (the red `budget` arm) and `pushDiskAlert`, `pushInstallDriftAlert`; kept in src/ui/team-alert-tail.ts: `pushStoppedAlert` (`tumwater is not running`). Everything else becomes a doctor row: `repeated failures`, `budget` (role cap), `check`/`brief` (no-check, no-brief, brief-truncated), `role notes`, `principles`, `update` (stale build), `parallel instances` (stale claims and the instance pool), `quiet hours`, `maintenance allowance`, `provider waits`, `provider concurrency`, `pause`, `provider contention`/`check contention`/`workspaces` (contention and stale workspace pins), `regressed fixes`, and `image input` (images and image probes). The chain/fallback condition leaves with part 5c/6's fallback removal, which this part waits on.

**Approach.**
- Delete from src/ui/team-alert-status.ts: `pushChainAlert`, `pushRoleCapAlert`, `pushNoCheckAlert`, `pushNoBriefAlert`, `pushBriefTruncatedAlert`, `pushRoleNotesTruncatedAlert`, `pushPrinciplesTruncatedAlert`, `pushBuildAlert`, `pushStaleClaimsAlert` and their calls in `buildStatusAlerts`; keep the six kept builders.
- Delete from src/ui/team-alert-tail.ts: `pushQuietAlert`, `pushMaintenanceAlert`, `pushProviderHoldAlert`, `pushProviderCapsAlert`, `pushPausedAlert`, `pushContentionAlert`, `pushWorkspacePinsAlert`, `pushInstancePoolAlert`, `pushRegressedFixesAlert`, `pushImagesAlert`, `pushImageProbeAlert` and their calls in `buildTailAlerts`; keep `pushStoppedAlert`.
- Delete `capacityContention`, `providerCapProblems`, `instancePoolProblems`, `regressedFixesAlert`, `staleWorkspacePins` and the `CapacityBottleneck`/`RegressedFixAlert` types from src/ui/alert-feeds.ts / team-alert-shared.ts; keep `staleClaimEntries` (src/scheduling/claim-entries.ts), which the doctor's `parallel instances` row still reads.
- Update `teamAlerts`' parameters and the three call sites, and the team-alerts.test.ts / status-payload.test.ts cases; sweep docs/how-it-works.md's sentences naming these banners.
- Do not touch src/doctor/doctor-contention-checks.ts, doctor-project-checks.ts or doctor.ts: their rows are the detail.

**Files touched.** src/ui/team-alert-status.ts src/ui/team-alert-tail.ts src/ui/alert-feeds.ts src/ui/team-alert-shared.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts

**Acceptance criteria.**
- `buildStatusAlerts` emits only main-red, failing-streak, stuck-role, spent-budget, disk and install-drift; `buildTailAlerts` emits only `stopped`. No other builder remains in either module.
- Each deleted condition prints its `tumwater doctor` row (listed above); the chain/fallback condition has no row because part 5c/6 removes fallback.
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

### Subtract, part 5g/6: The peer-tier image reroute's runtime and state go (planned 2026-10-26 by the plan role, split from the too-large part 5a/6 after feature held it twice (held 2); design in plans/subtract.md "The six strokes", stroke 5, and plans/image-input.md; the third of four finer parts replacing part 5a/6, requires Subtract part 5f/6 landed, since both edit `src/agent/image-input.ts` and the config exports `imageRerouteTarget` alone reads; touches src/agent/image-input.ts src/runner/runner-run.ts src/runner/runner.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/run/run-verdict.ts src/run/run-resume.ts src/prompt/prompt-followup.ts src/config/config-fallbacks.ts src/config/config-views.ts src/events/events.ts src/events/event-labels.ts src/events/event-format.ts src/events/event-legacy.ts src/report/report-types.ts src/report/report-data.ts src/report/report-fold.ts src/report/report-render.ts docs/how-it-works.md docs/invariants.md test/image-input.test.ts test/run-verdict.test.ts test/runner-2.test.ts test/report-data.test.ts test/report-fold-cache.test.ts test/event-format.test.ts)

**Previously held 2**

**Goal.** A blind image read ends its run `error` with `lastError`; no run is handed to a peer tier. `imageReroute`/`imageRerouteTarget`, the `image-reroute` resume cause, the `RunnerState.imageReroute` marker, the `image_reroute` event and the `imageReroutesByRole` report field are deleted. `roleImageInfo.imageReroute` stays a literal null until 5h removes the field.

**Approach.**
- `src/agent/image-input.ts`: delete `imageReroute`, `imageRerouteTarget`, `RerouteRegime` and `ImageReroute`; `roleImageInfo` stops computing a reroute and returns `imageReroute: null`; prune the imports only the reroute used (`BORROW_ORDER`, `resolveTierFallbacks`, `ModelTier`, `FallbackModelConfig`, `piPairFree`, `ClaudeAccount`, `withModelOverrides`, `roleSeamTier` as they fall unused - keep any the fallback budget path still reads).
- `src/runner/runner-run.ts` deletes its reroute block and the `reroute: "image"` stamp; `src/runner/runner.ts` deletes the `state.imageReroute` branch; `src/runner/runner-state.ts` drops `imageReroute`/`imageRerouteActive`; `src/runner/runner-state-load.ts` drops their healing.
- `src/run/run-verdict.ts`: drop the `imageReroute` import and the reroute arm, keeping the `pi.imageBlind` error path (`lastError`, requeue). `src/run/run-resume.ts` drops the `image-reroute` resume cause and its flags; `src/prompt/prompt-followup.ts` drops the `imageReroute` handoff note.
- `src/config/config-fallbacks.ts`/`config-views.ts`: drop the exports whose only caller was `imageRerouteTarget` (both files' comments name it).
- Events/report: delete `image_reroute` from `src/events/events.ts`, `event-labels.ts`, `event-format.ts`, `event-legacy.ts`; delete `imageReroutesByRole` from `src/report/report-types.ts`, `report-data.ts`, `report-fold.ts`, `report-render.ts`.
- Docs: `docs/how-it-works.md` and `docs/invariants.md`'s INV-J2 (reroute) go; `docs/cli.md`'s `report` row drops the image-reroute line. Tests: drop the reroute cases from `test/image-input.test.ts`, `test/run-verdict.test.ts`, `test/runner-2.test.ts`, `test/report-data.test.ts`, `test/report-fold-cache.test.ts` and `test/event-format.test.ts`.

**Files touched.** src/agent/image-input.ts src/runner/runner-run.ts src/runner/runner.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/run/run-verdict.ts src/run/run-resume.ts src/prompt/prompt-followup.ts src/config/config-fallbacks.ts src/config/config-views.ts src/events/events.ts src/events/event-labels.ts src/events/event-format.ts src/events/event-legacy.ts src/report/report-types.ts src/report/report-data.ts src/report/report-fold.ts src/report/report-render.ts docs/how-it-works.md docs/invariants.md docs/cli.md test/image-input.test.ts test/run-verdict.test.ts test/runner-2.test.ts test/report-data.test.ts test/report-fold-cache.test.ts test/event-format.test.ts

**Acceptance criteria.**
- `grep -rnE 'imageRerouteTarget|imageReroute\(|RerouteRegime|image_reroute|imageReroutesByRole|image-reroute' src/` is empty.
- A run whose agent reads an image its model cannot see fails with `lastError` and no handoff; the run log carries no `image_reroute` event and the report no Image-reroutes line.
- `roleImageInfo` never names a reroute target.
- `npm run test:gate` passes.

### Subtract, part 5h/6: The image reroute's display surfaces go (planned 2026-10-26 by the plan role, split from the too-large part 5a/6 after feature held it twice (held 2); design in plans/subtract.md "The six strokes", stroke 5, and plans/image-input.md; the fourth of four finer parts replacing part 5a/6, requires Subtract part 5g/6 landed, since it removes the field that part leaves null; touches src/agent/image-input.ts src/status/status-roles.ts src/status/status-data.ts src/roles/role-view.ts src/roles/role-render.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/team-alert-shared.ts src/ui/team-alert-tail.ts src/ui/gui/gui-client-composer.ts src/ui/gui/gui-client-drawer-config.ts docs/invariants.md test/status-payload.test.ts test/role-view.test.ts test/status-render.test.ts test/team-alerts.test.ts test/status-data-models.test.ts)

**Previously held 2**

**Goal.** No status payload, role page, role view, alert or GUI composer notice names an image reroute. A role's image input is reported as the declaration alone.

**Approach.**
- `src/agent/image-input.ts`: drop the `imageReroute` field from `RoleImageInfo` and its doc comment; `roleImageInfo` returns `{ imageInput }`.
- `src/status/status-roles.ts` drops `imageRerouteLabel`; `src/status/status-data.ts` drops the field and its comment; `src/roles/role-view.ts` drops `imageReroute` from the view type; `src/roles/role-render.ts` drops the `no - reruns on ...` arm.
- `src/ui/status-payload.ts`/`status-render.ts` drop the `imageReroute` field; `src/ui/team-alert-shared.ts` drops the `imageReroute` field and the text-only grouping that read it; `src/ui/team-alert-tail.ts` drops the reroute grouping.
- `src/ui/gui/gui-client-composer.ts` and `gui-client-drawer-config.ts` drop the reroute notice and its "reruns on" arm.
- `docs/invariants.md` drops the remaining image-surface sentences. Tests: update `test/status-payload.test.ts`, `test/role-view.test.ts`, `test/status-render.test.ts`, `test/team-alerts.test.ts` and `test/status-data-models.test.ts`.

**Files touched.** src/agent/image-input.ts src/status/status-roles.ts src/status/status-data.ts src/roles/role-view.ts src/roles/role-render.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/team-alert-shared.ts src/ui/team-alert-tail.ts src/ui/gui/gui-client-composer.ts src/ui/gui/gui-client-drawer-config.ts docs/invariants.md test/status-payload.test.ts test/role-view.test.ts test/status-render.test.ts test/team-alerts.test.ts test/status-data-models.test.ts

**Acceptance criteria.**
- `grep -rnE 'imageReroute|image-reroute|image_reroute' src/ docs/` is empty.
- The role page, status payload and dashboard composer show the role's declared image input with no reroute text.
- `npm run test:gate` passes.

### Subtract, part 5b/6: The per-provider concurrency caps go — `maxConcurrent` is the one bound (planned 2026-10-26 by the plan role, split from the too-large part 5/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 5; requires Subtract part 5h/6 landed, since both edit the doctor row list and the alert builders; touches src/config/config-schema.ts src/config/config-validation-roles.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-example.ts src/concurrency/provider-lease.ts src/concurrency/semaphore.ts src/merge/merge-verify.ts src/merge/merge-slot.ts src/orchestrator/orchestrator.ts src/orchestrator/orchestrator-launch.ts src/events/events.ts src/events/event-labels.ts src/events/event-format.ts src/failure/failure-state-change.ts src/report/report-types.ts src/report/report-fold.ts src/report/report-render.ts src/doctor/doctor-contention-checks.ts src/doctor/doctor-check-names.ts src/ui/alert-feeds.ts src/ui/team-alert-tail.ts src/ui/team-alerts.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-provider-caps.ts src/ui/tui/tui-editor-session.ts src/ui/tui/tui-editors.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-editor-config.ts src/ui/tui/tui-frame.ts src/ui/tui/tui-pane-ctx.ts docs/config.md docs/how-it-works.md docs/invariants.md test/provider-lease.test.ts test/tui-provider-caps.test.ts test/doctor-checks.test.ts test/event-format.test.ts test/config.test.ts)

**Previously held 1**

**Goal.** Runs are bounded by the team-wide `maxConcurrent` alone. `maxConcurrentPerProvider`, the provider lease/semaphore, the provider holds and the `provider concurrency`/`provider contention`/`provider waits` rows and alerts are deleted; providers never wait on each other.

**Approach.**
- Config: delete `maxConcurrentPerProvider` (`src/config/config-schema.ts`), its validation (`src/config/config-validation-roles.ts`), `checkProviderConcurrencyCap` and its `DOTTED_MAP_KEYS` entry (`src/config/config-keys.ts`), the editable key (`src/config/config-editable-keys.ts`), the example (`src/config/config-example.ts`) and the GUI settings row (`src/ui/gui/gui-client-settings.ts`); a config carrying the key is refused by name, not ignored.
- Runtime: delete `src/concurrency/provider-lease.ts`, the provider arm of `src/concurrency/semaphore.ts`, and their consumers in `src/merge/merge-verify.ts`, `src/merge/merge-slot.ts`, `src/orchestrator/orchestrator.ts` and `src/orchestrator/orchestrator-launch.ts`; delete the `provider_wait` event (`src/events/events.ts`, `event-labels.ts`, `event-format.ts`, `src/failure/failure-state-change.ts`, `src/report/report-types.ts`/`report-fold.ts`/`report-render.ts`).
- Doctor: delete `checkProviderConcurrency`, `providerConcurrencyProblems`, `providerWaitContention` and the `provider concurrency`, `provider contention` and `provider waits` rows (`src/doctor/doctor-contention-checks.ts`, `src/doctor/doctor-check-names.ts`); delete the `provider slots` alert feed (`src/ui/alert-feeds.ts`) and `pushProviderCapsAlert` (`src/ui/team-alert-tail.ts`, `src/ui/team-alerts.ts`).
- TUI: delete `src/ui/tui/tui-editor-provider-caps.ts` and its mode wiring (`tui-editor-session.ts`, `tui-editors.ts`, `tui-keys.ts`, `tui-editor-config.ts`, `tui-frame.ts`, `tui-pane-ctx.ts`); drop the provider-cap fields from `src/ui/badges.ts`, `src/ui/status-payload.ts`, `src/ui/status-render.ts` and the GUI client.
- Docs: `docs/config.md`, `docs/how-it-works.md`, `docs/invariants.md` (provider-concurrency invariants). Tests: delete `test/provider-lease.test.ts` and `test/tui-provider-caps.test.ts`; update `test/doctor-checks.test.ts`, `test/config*.test.ts`, `test/event-format.test.ts`.

**Acceptance criteria.**
- `grep -rnE 'maxConcurrentPerProvider|providerConcurrency|provider_wait|provider-lease|providerCaps' src/` finds no live reference.
- A run starts under `maxConcurrent` alone; no provider lease is acquired and no `provider_wait` is logged.
- `provider concurrency`, `provider contention` and `provider waits` are gone from `DOCTOR_CHECK_NAMES` and the alert builders; a `tumwater.json` with `maxConcurrentPerProvider` is refused naming the key.
- `npm run test:gate` passes.

### Subtract, part 5c/6: The fallback chains go — a spent cap pauses the role (planned 2026-10-26 by the plan role, split from the too-large part 5/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 5, and plans/fallback-chain.md; requires Subtract part 5b/6 landed, since both edit the config schema, the row list and the alert builders; touches src/config/config-schema.ts src/config/config-validation-model.ts src/config/config-validation.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-write.ts src/config/config-example.ts src/config/config-fallbacks.ts src/runner/model-fallback.ts src/runner/runner-fallback.ts src/runner/runner-run.ts src/runner/runner-state.ts src/budget/budget-fallback-view.ts src/budget/fallback-breaker.ts src/gates/budget-gates.ts src/events/event-labels.ts src/events/event-format.ts src/failure/failure-state-change.ts src/ui/team-alert-status.ts src/ui/badges.ts src/ui/status-render.ts src/ui/status-payload.ts src/doctor/doctor-fallback-checks.ts src/doctor/doctor-check-names.ts src/ui/tui/tui-editor-fallback.ts docs/config.md docs/backends.md docs/how-it-works.md docs/invariants.md test/model-fallback.test.ts test/runner-fallback.test.ts test/fallback-breaker.test.ts test/orchestrator-fallback.test.ts test/tui-fallback.test.ts test/config.test.ts test/doctor-checks.test.ts test/event-format.test.ts)

**Previously held 1**

**Goal.** A run runs its configured model, full stop: no model-failure episode and no budget fallback. Reaching `maxDailyCostUsd` pauses the role until local midnight, as it already does with no free fallback pair today.

**Approach.**
- Config: delete the `fallback` key, `fallbackModel`/`FallbackModelConfig`, `FallbackStep`, `FALLBACK_STEP_KEYS`, `FallbackChain` and the derived `fallbackStepCaps` (`src/config/config-schema.ts`); their validation and dotted-key handling (`src/config/config-validation-model.ts`, `src/config/config-validation.ts`, `src/config/config-keys.ts`, `src/config/config-editable-keys.ts`, `src/config/config-write.ts`); the example (`src/config/config-example.ts`) and `docs/config.md`/`docs/backends.md`.
- Runtime: delete `src/runner/model-fallback.ts`, `src/runner/runner-fallback.ts`, the fallback legs `foldModelFallback`/`FallbackRunContext`/`rerouteRegime` in `src/runner/runner-run.ts` and the `modelFallback` state in `src/runner/runner-state.ts`; delete `src/budget/budget-fallback-view.ts`, `src/budget/fallback-breaker.ts` and the fallback half of `src/config/config-fallbacks.ts` (`fallbackPair`, `tierFallbackLabels`, `resolveTierFallbacks`, `fallbackRoleConfig`, `applyFallbackModel`, `modelFallbackView`, `seamsInUse`), so the budget gate's `fallback` outcome becomes the existing `paused` outcome (`src/gates/budget-gates.ts`).
- Events and surfaces: delete `budget_fallback`, `budget_handback`, `fallback_switched` and the `model_fallback*` events (`src/events/event-labels.ts`, `event-format.ts`, `src/failure/failure-state-change.ts`); the "Running on fallback" and "switched to the over-cap model" alerts (`src/ui/team-alert-status.ts`); the fallback badges (`src/ui/badges.ts`, `status-render.ts`, `status-payload.ts`); and the `fallback chain`/`over-cap model` rows (`src/doctor/doctor-fallback-checks.ts`, `doctor-check-names.ts`).
- TUI/CLI: delete `src/ui/tui/tui-editor-fallback.ts` and its mode wiring; drop the `config set fallbackModel` verb.
- Docs: `docs/config.md`, `docs/backends.md`, `docs/how-it-works.md`, `docs/invariants.md`. Tests: delete `test/model-fallback.test.ts`, `test/runner-fallback.test.ts`, `test/fallback-breaker.test.ts`, `test/orchestrator-fallback.test.ts`, `test/tui-fallback.test.ts`; update `test/config*.test.ts`, `test/doctor-checks.test.ts`, `test/event-format.test.ts`.

**Acceptance criteria.**
- `grep -rniE 'fallbackModel|fallbackPair|modelFallback|budget_fallback|budget_handback|over-cap' src/` finds no live reference; no run substitutes a different model.
- At `maxDailyCostUsd` a role logs `budget_paused` and stays paused until local midnight; the director keeps its model as today.
- `fallback chain` and `over-cap model` are gone from `DOCTOR_CHECK_NAMES`; a `tumwater.json` with `fallback` or `fallbackModel` is refused naming the key.
- `npm run test:gate` passes.

### Subtract, part 5d/6: The subscription-window carve-outs and the per-backend account file go (planned 2026-10-26 by the plan role, split from the too-large part 5/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 5, and plans/codex-backend.md; requires Subtract part 5c/6 landed, since the budget's fallback reads the account's overage state until it goes; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-validation-roles.ts src/config/config-views.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-write.ts src/config/config-example.ts src/agent/subscription-account.ts src/agent/claude/claude-account.ts src/agent/codex/codex-account.ts src/team/team-polls.ts src/gates/gate-polls.ts src/gates/budget-gates.ts src/run/run-finalize.ts src/merge/merge-slot.ts src/doctor/doctor-holds.ts src/doctor/doctor-check-names.ts src/ui/badges.ts src/ui/status-payload.ts src/status/status-budget.ts src/status/status-roles.ts src/roles/role-render.ts src/roles/role-view.ts src/pi/pi-models.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts docs/config.md docs/backends.md docs/how-it-works.md docs/invariants.md test/doctor-holds.test.ts test/config.test.ts test/doctor-checks.test.ts)

**Previously held 1**

**Goal.** The team stops reserving, holding and warning on subscription usage windows. `claudeWindowReserve`/`backends.<id>.windowReserve`, the `windowReserveFor` carve-out, the window hold/reserve/warning loops, the `claude window`/`codex window` rows and the `.tumwater/state/<backend>-account.json` file are deleted. A run's own `PiRunResult` (`transientRateLimit`, `rateWindows`, `billing`) stays the live signal for a window rejection the run resumes from, and `maxDailyCostUsd`'s own spend ledger (src/budget/budget.ts) keeps the cap.

**Approach.**
- Config: delete the top-level `claudeWindowReserve` and `backends.<id>.windowReserve` keys (`src/config/config-schema.ts` `windowReserve`, `CLAUDE_AGENT_KEYS`/`CODEX_BACKEND_KEYS`), their validation (`src/config/config-validation.ts` `checkWindowReserve`, `src/config/config-validation-roles.ts` `validateClaudeWindowReserve`), `windowReserveFor` (`src/config/config-views.ts`), the editable key, the example and the GUI/TUI rows (`src/ui/gui/gui-client-settings.ts`, `src/ui/tui/tui-editor-claude-reserve.ts` and its mode wiring); `config-write.ts`'s nested-reserve collapse goes.
- Delete `src/agent/subscription-account.ts` and the window reads in `src/agent/claude/claude-account.ts`/`codex-account.ts`; delete the window hold/reserve/warning loop and `windowObservation`/`pollClaudeWindowReserve`/`pollClaudeWindowWarning` (`src/team/team-polls.ts`, `src/gates/gate-polls.ts`) and the budget gate's `claudeWindowUsedUp`/`windowReserveFor` use (`src/gates/budget-gates.ts`); drop the `observeAccount` writes (`src/run/run-finalize.ts`, `src/merge/merge-slot.ts`).
- Delete the rows and display: `checkSubscriptionWindow` and the `claude window`/`codex window` rows (`src/doctor/doctor-holds.ts`, `src/doctor/doctor-check-names.ts`); the window badges and status fields (`src/ui/badges.ts`, `src/ui/status-payload.ts`, `src/status/status-budget.ts`, `src/status/status-roles.ts`, `src/roles/role-render.ts`, `src/roles/role-view.ts`, `src/pi/pi-models.ts`'s account reads).
- Docs: `docs/config.md`, `docs/backends.md`, `docs/how-it-works.md`, `docs/invariants.md`. Tests: drop the window cases from `test/doctor-holds.test.ts`; update `test/config*.test.ts`, `test/doctor-checks.test.ts`.

**Acceptance criteria.**
- `grep -rnE 'SubscriptionAccount|subscription-account|windowReserveFor|claudeWindowReserve|windowReserve|claude window|codex window|observeAccount' src/` finds no live reference; no `.tumwater/state/<backend>-account.json` is read or written.
- A run rejected on a subscription usage window still keeps its session and resumes on the live `PiRunResult` flags, and a spent `maxDailyCostUsd` still pauses the role.
- `claude window` and `codex window` are gone from `DOCTOR_CHECK_NAMES`; a config setting either reserve key is refused by name.
- `npm run test:gate` passes.

### Subtract, part 5e/6: The model tier map goes — `model` names one entry per role and seam (planned 2026-10-26 by the plan role, split from the too-large part 5/6 after feature held it (held 1); design in plans/subtract.md "The six strokes", stroke 5, and plans/model-tiers.md; requires Subtract part 5d/6 landed, since the fallback resolution keyed by tier and the account reads go with the parts ahead of it; touches src/config/config-schema.ts src/config/config-validation-model.ts src/config/config-validation.ts src/config/config-views.ts src/config/config-write.ts src/config/config-write-core.ts src/config/config-keys.ts src/config/config-editable-keys.ts src/config/config-example.ts src/roles/role-catalog.ts src/roles/role-render.ts src/roles/role-view.ts src/ui/badges.ts src/ui/status-render.ts src/ui/status-payload.ts src/ui/gui/gui-client-settings.ts src/ui/gui/gui-client-drawer-config.ts src/ui/tui/tui-editor-model.ts docs/config.md docs/how-it-works.md docs/invariants.md tumwater.example.json test/config-views.test.ts test/config-validation-model.test.ts test/doctor-checks.test.ts)

**Previously held 1**

**Goal.** The top-level `model` map is keyed by role or seam id → selector; `small`/`default`/`strong`, `MODEL_TIERS`, `modelTierMap`, `isTierName` and the catalog `tier` field are deleted. The resolution rule is one line: a run runs `roles.<id>.model` (the seam's own override, e.g. `review.model`) else `model.<id>` else pi's default — there is no tier fallback.

**Approach.**
- Schema and validation: delete `MODEL_TIERS`/`ModelTier`, `modelTierMap`, `TIER_MAP_KEYS`, the tier-name arm of the model-shape check and the map-by-tier shape; `model` becomes the role/seam-keyed map (`src/config/config-schema.ts`, `src/config/config-validation-model.ts`, `src/config/config-validation.ts`); a `model` key that is not a role/seam id (including `default`) is refused by name rather than silently never resolving. `config-views.ts` loses `isTierName`, `topTierSelector`, `resolveTopTier`, `topTierBackend`, `tierModel` and the `withModelOverrides` tier argument in favour of the one rule; `config-write`/`config-keys`/`config-editable-keys`/the example follow.
- Catalog: `src/roles/role-catalog.ts` drops `tier: ModelTier` from every role entry (and its type); the role's model is the config map's, else pi's default. `src/roles/role-render.ts`/`role-view.ts` drop the tier label.
- Surfaces: delete the `models for each tier` row and its check, and the tier names in badges/status (`src/ui/badges.ts`, `src/ui/status-render.ts`, `src/ui/status-payload.ts`, `src/ui/gui/gui-client-settings.ts`, `src/ui/gui/gui-client-drawer-config.ts`, `src/ui/tui/tui-editor-model.ts`).
- Docs and example: `docs/config.md`, `docs/how-it-works.md`, `docs/invariants.md`, `tumwater.example.json` describe the role/seam map; `plans/model-tiers.md` gets a superseded head note. Tests: update `test/config-views.test.ts`, `test/config-validation-model.test.ts`, `test/doctor-checks.test.ts`.

**Acceptance criteria.**
- `grep -rnE 'MODEL_TIERS|ModelTier|modelTierMap|isTierName|topTierSelector|tierModel|models for each tier' src/` finds no live reference.
- One place names a run's model: `roles.<id>.model`/the seam override, else `model.<id>`, else pi's default; a run never substitutes a different model.
- A `tumwater.json` whose `model` map has a `small`/`default`/`strong` key (or a role modelled as a tier name) is refused with a message naming the bad key; the example config uses the role/seam spelling.
- `npm run test:gate` passes.

### Subtract, part 2e/6: The release surfaces stop offering the operator hold (planned 2026-10-26 by the plan role, split from the too-large part 2c/6 after feature held it (held 2); design in plans/subtract.md "The six strokes", stroke 2; the third of four finer parts replacing part 2c/6, independent in files of the other three (2c/6, 2d/6, 2f/6) and holding no prerequisite, since the CLI release still lifts a held note until 2f/6; touches src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-pane-session.ts src/ui/gui/gui-client-boot.ts src/ui/gui/gui-client-drawer.ts src/gui/gui-backlog-endpoints.ts src/gui/gui-backlog-commands.ts test/tui-keys.test.ts test/gui-client-drawer.test.ts test/gui.test.ts)

**Needs review 2026-10-26 by feature: rejected after 5 review rounds**

This entry's implementation was rejected on the final revision round (the same objection survived two revisions), so the plan role should rewrite it. Objections from the reviewing run:

1. (prior 1) The changed drawer test still does not exercise the behavior it was changed for. In the final `test/gui-client-drawer.test.ts` the `HeldForOperator` fixture and the index‑3 assertion were removed outright, leaving only fixtures that behave identically under the old `d.refused || d.heldFor…`.
2. The archived PLANS-DONE.md entry contradicts the code it describes: its Tests bullet says `test/gui-client-drawer.test.ts` "inverts the held-for-operator fixture" so the drawer shows Release "on no held-for-operator one", but that fixture no longer exists in the test at all, leaving the record stal….

**Previously held 2**

**Goal.** The release surfaces that offer the operator hold name only the Refused note: the TUI Backlog pane's Ctrl+R guard admits `hold === "refused"`, the dashboard drawer's Release button renders only for `d.refused`, and `GET /api/backlog` drops its `heldForOperator` field. The release core is deliberately untouched until part 2f/6: `liftRefusal` in src/backlog/backlog-release.ts still lifts a held-for-operator note, so `tumwater plan|bug --release` and the `handleBacklogRelease` endpoint keep their behavior and their existing tests.

**Approach.**
- `src/ui/tui/tui-pane-backlog.ts`: the Ctrl+R guard takes only `hold === "refused"`; the "carries no Refused …" flash and the comment drop the held-for-operator half.
- `src/ui/tui/tui-pane-session.ts` and `src/ui/tui/tui-keys.ts`: the `armedRelease` comments drop the held-for-operator release.
- `src/ui/gui/gui-client-boot.ts`: the `entry-release` result copy and the `not_refused` copy name the Refused note (the drawer can no longer produce a held-for-operator release); leave the endpoint's own `lifted` value alone.
- `src/ui/gui/gui-client-drawer.ts`: the Release button condition drops `d.heldForOperator`.
- `src/gui/gui-backlog-endpoints.ts`: the backlog payload drops the `heldForOperator` key and the `operatorHeldEntries` import and lookup.
- `src/gui/gui-backlog-commands.ts`: `handleBacklogRelease`'s doc comment drops the held-for-operator sentence. Its behavior is unchanged — the core still lifts that note until 2f/6 — so both its stop-at-the-comment scope and its test stay.
- Tests: each flipped case must fail against today's source, so the flip is behavior-pinning.
- `test/gui-client-drawer.test.ts`, "the entry drawer offers Release this entry only on a refused or held-for-operator entry": rename it to end "only on a refused entry", KEEP the index-3 `HeldForOperator` fixture (`{ title: "HeldForOperator", body: "**Needs review 2026-10-16 by feature: x (held 3)**", refused: false, heldForOperator: true }`), and change its index-3 assertion to `assert.doesNotMatch(t.paintedFor("entrybody"), /entry-release/)` — it fails while the drawer still tests `d.refused || d.heldForOperator`. Index 0 (refused) keeps its `entry-release` match; index 1 (note-less) and index 2 (below threshold) keep it absent.
- `test/tui-keys.test.ts`: re-point "backlog Ctrl+R twice releases a held-for-operator plan and wakes the plan role" to "backlog Ctrl+R on a held-for-operator plan refuses and writes nothing": one Ctrl+R on the `(held 3)` plan leaves `releaseArmed === null`, flashes `/carries no Refused note/`, leaves both the Needs-review and `Previously held 2` lines, and writes no wake marker. Update the flash assertions in "backlog Ctrl+R on a below-threshold Needs-review plan still says so and writes nothing" and "backlog Ctrl+R on a note-less entry, question, or done row refuses, and budget mode blocks it" to `/carries no Refused note/`.
- `test/gui.test.ts`, "gui /api/backlog marks a held-for-operator plan for the drawer's Release button": rename it "…carries no heldForOperator key for a held-for-operator plan", keep its seeded PLANS.md, and invert its index-1 assertion to `assert.equal(("heldForOperator" in held), false)` (today it asserts `held.heldForOperator === true`); the plain plan's absent-key assertion stays.
- `test/gui-endpoints.test.ts` is NOT edited: "handleBacklogRelease lifts a held-for-operator note from a bug" still passes because the core is unchanged, and it pins that this part leaves the core alone.

**Files touched.** src/ui/tui/tui-pane-backlog.ts src/ui/tui/tui-keys.ts src/ui/tui/tui-pane-session.ts src/ui/gui/gui-client-boot.ts src/ui/gui/gui-client-drawer.ts src/gui/gui-backlog-endpoints.ts src/gui/gui-backlog-commands.ts test/tui-keys.test.ts test/gui-client-drawer.test.ts test/gui.test.ts

**Acceptance criteria.**
- `grep -rn 'heldForOperator' src/` is empty; `grep -rn 'held-for-operator' src/ui src/gui` is empty.
- `GET /api/backlog` for a held-for-operator plan has no `heldForOperator` key and the drawer paints no `entry-release` button for it; the inverted drawer and payload cases fail if the old condition or key is restored.
- The TUI release guard accepts a `refused` hold only: Ctrl+R on the held-for-operator plan writes nothing, wakes no role and flashes the no-Refused-note wording.
- The release core is untouched: `test/gui-endpoints.test.ts`'s held-for-operator lift case passes unmodified, and no src/backlog file is edited.
- `npm run test:gate` passes.

### Subtract, part 2f/6: The held counters, the derived operator hold and the release verb collapse to one Needs review hold (planned 2026-10-26 by the plan role, split from the too-large part 2c/6 after feature held it (held 2); design in plans/subtract.md "The six strokes", stroke 2, and plans/refusal-and-thrash.md; the fourth of four finer parts replacing part 2c/6, requires Subtract parts 2c/6, 2d/6 and 2e/6 landed, since 2c/6 drops the count writers and 2d/6 and 2e/6 drop every reader outside the core; touches src/roles/role-guidance.ts src/backlog/backlog-eligibility.ts src/backlog/backlog-release.ts src/doctor/doctor-backlog-plans.ts src/runner/revision.ts docs/invariants.md docs/cli.md test/backlog-eligibility.test.ts test/backlog-release-holds.test.ts test/backlog-write-cancel.test.ts test/doctor-backlog.test.ts)

**Previously held 2**

**Goal.** The held count and the derived operator hold are gone from the data layer: `heldCount`, `OPERATOR_HOLD_THRESHOLD`, `withoutHeldForOperatorNotes` and `operatorHeldEntries` are deleted, `EntryHold` loses `"held-for-operator"`, and a `**Needs review …**` note parks an entry for the plan role at any count. One `tumwater plan|bug --release` lifts the Refused note first, else the Needs-review note, so the operator never has to release a too-large plan.

**Approach.**
- `src/roles/role-guidance.ts`: delete `HELD_TAG_PREFIX`, `PRIOR_HELD_PREFIX` and their comments (2c/6 removed the writers; this removes the last readers).
- `src/backlog/backlog-eligibility.ts`: delete `heldCount`, `lineHeldCount`, `OPERATOR_HOLD_THRESHOLD`, `withoutHeldForOperatorNotes` and `operatorHeldEntries`; `EntryHold` becomes `"refused" | "needs-review" | { blockedBy } | null`; `entryHoldAgainst` returns `"needs-review"` for any Needs-review line; `holdMark` drops the operator branch; update the module and function comments.
- `src/backlog/backlog-release.ts`: `LiftableHold` becomes `"refused" | "needs-review"`; `liftRefusal` filters the Refused lines, else the Needs-review note line via a `withoutNeedsReviewNotes` helper built on `withoutNoteLines`; `liftedNotePhrase`, the doc comments and the `carries no … note` failure say "the Needs review note".
- `src/doctor/doctor-backlog-plans.ts`: `checkStalledEntries` collects hold `"needs-review"` only; the row's operator-release branch and its `heldCount` interpolation go.
- `src/runner/revision.ts`: the `holdEntryAfterExhaustion` comment stops naming `operatorHeldEntries`.
- `docs/invariants.md`: re-scope INV-AT1 to one liftable Needs-review hold (the guarantee, binds and pinned-by names) and drop the held-for-operator wording from the exhaustion-note paragraph.
- `docs/cli.md`: the `--release` clause and the `Ctrl+R` row name a Refused or Needs review note.
- Tests: `test/backlog-eligibility.test.ts` drops the `heldCount`/threshold/held-for-operator cases; `test/backlog-release-holds.test.ts` re-points its held-note cases to the second (Needs-review) lift; `test/backlog-write-cancel.test.ts` re-points its held release; `test/doctor-backlog.test.ts` folds the held-for-operator cases into the Needs-review row.

**Files touched.** src/roles/role-guidance.ts src/backlog/backlog-eligibility.ts src/backlog/backlog-release.ts src/doctor/doctor-backlog-plans.ts src/runner/revision.ts docs/invariants.md docs/cli.md test/backlog-eligibility.test.ts test/backlog-release-holds.test.ts test/backlog-write-cancel.test.ts test/doctor-backlog.test.ts

**Acceptance criteria.**
- `grep -rnE 'OPERATOR_HOLD_THRESHOLD|withoutHeldForOperatorNotes|operatorHeldEntries|HELD_TAG_PREFIX|PRIOR_HELD|held-for-operator' src/ docs/` is empty; `backlog-eligibility.ts` exports no `heldCount`.
- A Needs-review note at any count parks the entry as `[blocked: needs review]`, and one `tumwater plan --release` lifts it (the Refused note first when both are present).
- `checkStalledEntries` reports the entry without an operator-release branch, and INV-AT1's pinned-by names only surviving tests.
- `npm run test:gate` passes.

### `resolveInitPlan`'s complexity-27 validate-and-resolve body is split into one named helper per validation job — the template resolve, the brief cap, the missing-git check, the team-workspace refusal, the missing-brief refusal, the `--branch`-on-an-existing-repo refusal, the adoption resolve, the changed-brief refusal and the preferred-branch resolve — so each job is found by name (planned 2026-10-26 by the plan role; continues the landed split-large-function family — the 2026-10-25 `initProject` split (PLANS-DONE.md's `initProject`'s ~215-line validate-then-seed body) created `resolveInitPlan` as the validate-and-resolve home and left it at complexity 27, and this plan applies the same per-job extraction the `parsePromptFlags` and `parseStartInvocation` plans apply to their files; independent in files of every pickable `## Planned` entry — `awk '/^## Planned/{p=1} /^## Done/{p=0} p' PLANS.md | grep -c 'init/init'` and `... | grep -c 'init\.test'` both print 0, so no entry (eligible, held, blocked or refused) names src/init/init.ts or test/init.test.ts: the in-flight/eligible plans take src/cli/cli-command-args.ts, src/ui/transcript-tail.ts and the Subtract release, doctor-probe and banner surfaces (src/ui/tui, src/ui/gui, src/gui, src/doctor, src/cli.ts), none of them src/init or test/init.test.ts (the greps above); PLANS-DONE.md records no split of `resolveInitPlan` itself (`grep -cE '^### .*resolveInitPlan' PLANS-DONE.md` prints 0; its `init/init.ts` headings are the init behavior that created this function), and the 2026-10-25 `initProject` split is the sibling extraction, not a duplicate; docs/invariants.md's INV-Q1 binds `resolveInitPlan` (`src/init/init.ts`), and the symbol and its pre-side-effect guarantee both stay, so no invariant text changes; touches src/init/init.ts test/init.test.ts)

**Goal.** `resolveInitPlan` (src/init/init.ts) validates one `tumwater init` request and resolves everything `seedProject` needs before any side effect, but its whole body is one async function of complexity 27, so the template refusal, the brief cap, the missing-git refusal, the team-workspace refusal, the bare-init refusal, the `--branch` refusal, the adoption decision and its unmarked-`TUMWATER.md` refusal, the changed-brief refusal and the new-repo branch validation all read as one block. Split it into named helpers, one per validation job, so each refusal is found by name and the export's own body is only the ordered composition of them. Pure move: no behavior change for any input, no new capability, and INV-Q1 (every refusal before any side effect) still holds by construction because the helpers are the same guards in the same order.

**Approach.** All source edits in src/init/init.ts; move the code verbatim, do not rewrite it, and keep every `//` and `/** */` comment with the block it annotates. Add one doc comment to each new top-level private function naming the single job it owns. Run them in today's order.
- `function resolveInitTemplate(id: string | undefined): NonNullable<ReturnType<typeof getTemplate>>` — today's `const template = opts.template ? getTemplate(opts.template) : null;`, the `if (opts.template && !template) throw new Error(unknownTemplateError(opts.template));` and the `template ?? getTemplate("blank")!` default, with the "Resolve the template before any side effect" comment. Owns the unknown-template refusal and the blank default.
- `function combineInitBrief(tpl: InitTemplate, briefText: string): string` — today's `tpl.briefPreamble ? \`${tpl.briefPreamble}\n\n${briefText.trim()}\` : briefText.trim()` join and the `if (combinedPrompt.length > BRIEF_TEXT_MAX_CHARS)` `tooLongMessage(...)` throw, with its comment. Owns the preamble join and the brief cap.
- `function requireGitOnPath(): void` — today's `if (!findOnPath("git")) throw new Error(GIT_MISSING_MESSAGE);`. Owns the missing-git refusal.
- `function refuseTeamWorkspace(root: string): void` — today's `const owner = owningTeamRoot(root); if (owner !== undefined) throw new Error(teamWorkspaceMessage(owner));`, with the "A team workspace is not a project" comment. Owns the team-workspace refusal.
- `function refuseMissingBrief(root: string, prompt: string, combinedPrompt: string): void` — today's `if (!prompt && combinedPrompt.trim() === "" && readBriefText(root) === "") { ... }` block: the `readmeHint` ternary over `fs.existsSync(path.join(root, "README.md"))` and the `a brief is required: tumwater init ...` throw, with its comment. Owns the bare-init missing-brief refusal.
- `async function resolveInitWasRepo(root: string, branch: string | undefined): Promise<boolean>` — today's `const wasRepo = await isGitRepo(root);` and the `if (branch !== undefined && wasRepo)` throw with the `--branch only seeds a NEW repository` comment; returns `wasRepo`. Owns the existing-repo answer and the `--branch`-on-an-existing-repo refusal.
- `function resolveInitAdoption(root: string, opts: { adopt?: boolean; dryRun?: boolean; template?: string }): { brief: string | null; readmeExists: boolean; adopted: boolean }` — today's `const brief = briefFile(root);`, `const readmeExists = fs.existsSync(path.join(root, "README.md"));`, `const adopted = brief === null && (opts.adopt === true || readmeExists);` and the `if (adopted && fs.existsSync(path.join(root, "TUMWATER.md")))` throw, with both comments. Owns the adoption decision and the unmarked-`TUMWATER.md` refusal.
- `function refuseChangedBrief(root: string, brief: string | null, prompt: string, combinedPrompt: string): void` — today's `if (prompt && brief !== null && combinedPrompt !== readBriefText(root))` throw, with its `plans/portability.md §7a/7` comment. Owns the changed-prompt refusal.
- `async function resolveInitPreferredBranch(root: string, branch: string | undefined, wasRepo: boolean): Promise<string | undefined>` — today's whole `if (!wasRepo) { ... }` block: the branch-precedence comment, `const preferred = branch ?? ((await gitTry(root, "config", "--get", "init.defaultBranch")) || "main");`, the `if ((await gitTry(root, "check-ref-format", "--branch", preferred)) === null)` refusal with its `namedBy` ternary and comment, and `preferredBranch = preferred;`; returns `preferredBranch`. Owns the new-repo branch precedence and validation.
- `resolveInitPlan` keeps its signature, its `Promise<InitPlan>` return and its `InitPlan`-shaped result. Its body becomes: `const dryRun = opts.dryRun === true;`, then `const tpl = resolveInitTemplate(opts.template);`, `const combinedPrompt = combineInitBrief(tpl, briefText);`, `requireGitOnPath();`, `refuseTeamWorkspace(root);`, `const prompt = briefText.trim();`, `refuseMissingBrief(root, prompt, combinedPrompt);`, `const wasRepo = await resolveInitWasRepo(root, branch);`, `const { brief, readmeExists, adopted } = resolveInitAdoption(root, opts);`, `refuseChangedBrief(root, brief, prompt, combinedPrompt);`, `const preferredBranch = await resolveInitPreferredBranch(root, branch, wasRepo);`, then `return { dryRun, tpl, combinedPrompt, brief, readmeExists, adopted, wasRepo, preferredBranch };`. Extend its doc comment to say it composes the named jobs in invocation order and still throws every refusal before any side effect (INV-Q1).

**Files touched.** src/init/init.ts test/init.test.ts

**Acceptance criteria.**
- Each new declaration exists exactly once: `grep -nE '^(async )?function (resolveInitTemplate|combineInitBrief|requireGitOnPath|refuseTeamWorkspace|refuseMissingBrief|resolveInitWasRepo|resolveInitAdoption|refuseChangedBrief|resolveInitPreferredBranch)\b' src/init/init.ts` lists nine declarations, one per name.
- `resolveInitPlan`'s body holds no `getTemplate(`, `findOnPath(`, `owningTeamRoot(`, `isGitRepo(`, `briefFile(`, `check-ref-format`, `tooLongMessage(`, `unknownTemplateError(`, `teamWorkspaceMessage(`, `readBriefText(` or `throw new Error(` occurrence; it awaits or calls `resolveInitTemplate(`, `combineInitBrief(`, `requireGitOnPath(`, `refuseTeamWorkspace(`, `refuseMissingBrief(`, `resolveInitWasRepo(`, `resolveInitAdoption(`, `refuseChangedBrief(` and `resolveInitPreferredBranch(` exactly once each in that order, then returns the `InitPlan` literal.
- The complexity falls: `../../../node_modules/.bin/eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs 'src/init/init.ts'` reports `resolveInitPlan` at 3 or below (it is 27 today, at the `async function resolveInitPlan(` line) and each of the nine helpers at 10 or below.
- Every refusal's message text and its position in the guard order is unchanged: an unknown template before the brief cap and the team-workspace refusal, the team-workspace refusal before the missing-brief and `--branch` refusals, `isGitRepo` before `--branch`, `--branch` before the adoption and changed-brief refusals, and the branch-name validation last when a repo will be seeded.
- Behavior is identical for the same inputs: `initProject`'s `created`/`leftAlone`/`committed`/`repoInitialized`/`branch`/`bootstrap` results and the files it writes or leaves are byte-for-byte what they were, no write, `git init` or commit moves earlier, and a `--dry-run` still writes nothing.
- The exported surface is unchanged: `grep -nE '^export ' src/init/init.ts` matches `initProject` only, and docs/invariants.md is unchanged — its INV-Q1 `Binds.` line still names `resolveInitPlan`, which still owns the pre-side-effect refusals.
- No edit lands outside src/init/init.ts and test/init.test.ts.
- `npm run test:gate` passes.

**Tests.** Keep test/init.test.ts and test/init-templates.test.ts green unchanged, except for the two ordering pins below (they pass today and go red only if the extraction reorders a guard):
- test/init.test.ts, new "an unknown template is refused before the team-workspace refusal": build `teamWorkspace()`, write a marked README into its slot (as "initProject refuses inside a team workspace and writes nothing" does), capture the slot's `git rev-list --count HEAD`, then `await assert.rejects(() => initProject(slot, "Build a thing.", undefined, { template: "no-such-template" }), /unknown template/)` (the `unknownTemplateError` wording) and assert the commit count is unchanged. Fails if the team-workspace guard ran first.
- test/init.test.ts, new "`--branch` on an existing repo is refused before the changed-brief refusal": build `makeRepo()`, write a marked README whose prompt differs from the argument, then `await assert.rejects(() => initProject(repo, "A different prompt.", "trunk"), /--branch only seeds a new repository/)` and assert no `PLANS.md` or `TUMWATER.md` was written. Fails if the adoption/changed-brief guard ran first.

Run test/init.test.ts and test/init-templates.test.ts whole, then the project's gate, and confirm green.

## Done
