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

### A post-merge rejection stops reverting, part 1/3: the merge drain hands the reviewer's reasons to the authoring role instead of filling the revert slot (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; gated on the `## Planned` accounting plan "Every post-merge rejection reaches one accounted terminal state…" landing first — it adds `recordForwardedChange` and the runner routing this part calls; touches src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts)

**Refused 2026-10-24 by feature: superseded — the user's 2026-10-24 "Forward, never back" plan deletes this part's machinery (`sendReviewToRole`, the `recordForwardedChange` routing and the whole revert subsystem), replacing it with the reviewer fixing the finding itself, and the prerequisite accounting plan that would add `recordForwardedChange` has not landed; implementing it would land the direction the user decided against**

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** feature runners claim this entry every minute (48 claims so far) and have landed nothing, and its direction — forward the reviewer's reasons to the commit's authoring role — is replaced by "Forward, never back" below, where the reviewer that found the issue fixes it itself. Leave whatever is in flight as it is: the seam this part builds (`sendReviewToRole`, the reasons payload, the runner routing) is what the newer plan reuses to land the reviewer's own fix, so a landed part is not wasted and nothing landed should be undone. Reconcile the hand-back target when that plan lands.

**Goal.** A rejected post-merge review should cost one follow-up fix, not a revert cycle. Today `drainPostReviews` (src/merge/merge-post-review.ts) builds a revert-slot culprit (`postReview: { reasons }`), so a rejection pays a revert commit, a gate run on that revert inside the single merge slot, an authoring run that re-applies the whole patch from `refs/tumwater/rejected/<role>`, and then the follow-up's own gate, merge and second review. The reviewer's reasons never reach the author as a fix on top of main, where the commit already is. This part makes forwarding the only path `drainPostReviews` takes and leaves `runMainRevert` its red-main job.

**Approach.**
- src/merge/merge-post-review.ts `drainPostReviews`: for a rejected entry, forward the reviewer's numbered reasons to the commit's authoring role through `sendReviewToRole` (the prerequisite plan routes it through `recordForwardedChange`), then `settlePostReview(ctx.root, rejected.commit, null)`. Delete the `skipChecks` WeakSet, the `revertSkipReason` import and call, the `postReview` culprit construction and the `p.revert = culprit` assignment: the entry exists to carry the reasons to a fix, not to wait for a revert. A rejection with no free runner is parked by the prerequisite routing and stays in post-review.json until assigned. The unreviewed-entry arm and the one-review-at-a-time behaviour are unchanged.
- src/merge/merge-drain.ts: `sendReviewToRole` becomes the primary forward, not the failed-revert fallback — keep its "A review after merging rejected your commit <sha> on <branch>. It is still on main. Fix what the reviewer found in a new change:" text, drop its `reason` parameter and the "it could not be reverted" clause, and drop the `c.postReview === undefined` guard. `revertReasons`' `if (c.postReview)` branch, `handBackReverted`'s post-review handling, `startRevert`'s `(c, reason) => sendReviewToRole(...)` argument and its `if (culprit.postReview) settlePostReview(...)` line go with their only producers.
- src/baseline/main-revert.ts: delete `MainCulprit.postReview` and every read of it — `heal`'s `toReviewer`/`onFailed` branch, the post-merge-rejection wording in the revert message, and `reason: c.postReview ? "post-review" : "main-red"`, which becomes the constant `reason: "main-red"`. Delete `runMainRevert`'s `onFailed` parameter. Keep the `main_revert.reason` field and its readers (`revertGuardrail` and the report, run-detail and failure surfaces): events written before this change still carry `post-review`, and that value must keep reading as a post-merge rejection.
- docs/invariants.md: delete INV-BT2's pin "a rejecting post-merge review reverts the commit and hands it back as a revision" with the path it pins; state the new guarantee (a rejected entry is forwarded to its authoring role and leaves post-review.json with no revert). Correct the INV-C3 paragraph so `reason: "post-review"` reads as a legacy event value no new revert carries, not a live one.
- No change to `recordForwardedChange` (prerequisite-owned), `POST_MERGE_REJECT_WARN`, the churn alert, the red-main watch, or the revert-skip check's other callers.

**Files touched.** src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts

**Acceptance criteria.**
- A rejecting post-merge review hands its numbered reasons to the commit's authoring role, naming that commit and the branch, settles the entry out of post-review.json, and starts no revert: no `main_revert` event and the merge slot is free for the next queued change on the same poll.
- A rejection whose reasons cannot be delivered leaves the commit on main and logs one warning; no revert is attempted and no entry is silently dropped.
- A red-main culprit revert is unchanged end to end except that its `main_revert.reason` is always `main-red`; a pre-existing `reason: "post-review"` event still reads as a post-merge rejection on every reader.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: replace "a rejecting post-merge review reverts the commit and hands it back as a revision" with `a rejecting post-merge review forwards the reasons and starts no revert` — seed a merged afterMerge change, reject it, and assert the authoring role's inbox/pending record carries the reasons and the commit sha, the entry left post-review.json, and no revert was started. Keep the torn-entry, failed-write and git-could-not-start cases.
- test/merge-drain.test.ts: `a post-merge rejection never fills the revert slot` — run two polls with a rejected entry and an idle merge slot and assert the slot stays free for a queued change while the entry leaves post-review.json once forwarded.
- test/main-revert.test.ts: move the failed-delivery assertion to the primary path — a rejection whose reasons cannot be delivered warns and leaves the commit on main with no revert attempted; the red-main culprit revert's existing cases are unchanged.

### A post-merge rejection stops reverting, part 2/3: `tumwater reviews` and the shared renderer name the forwarded follow-up, not a revert (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; requires part 1/3 landed, since the entry it renders no longer waits on a revert; touches src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/post-merge-review-render.test.ts test/cli-reviews.test.ts)

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** this entry's surfaces change again under "Forward, never back" below — a rejected entry reads `fixed — <finding> (fix <sha>)`, and the accept affordances go entirely rather than being re-worded — so land it only as far as it goes; its wording half (no "waiting to revert", no "let the revert run") is what the newer plan keeps, and whatever is in flight now stays as it is.

**Goal.** The shared renderer `postReviewStatusLabel` still prints `[rejected — waiting to revert: …]`, and `cmdReviewsAccept` still refuses a rejected entry with "waiting on its revert". After part 1/3 there is no revert to wait for: a rejected entry is forwarded to its author, or parked until a runner can take it. Name the forwarding state instead.

**Approach.**
- src/review/post-merge-review-render.ts `postReviewStatusLabel`: the `rejected` branch reads `[rejected — awaiting the author's follow-up: <reasons>]` (keep the 60-character squash). Update the function's doc comment, which says the reasons are "still waiting on the revert". The label is shared by `tumwater reviews` and the TUI Pending pane; no other renderer change.
- src/review/post-merge-review-accept.ts: its doc comments call a `rejected` entry "waiting on its revert"; say it awaits its author's follow-up. The `rejected` outcome and the never-accept rule are unchanged.
- src/cli/cli-review-commands.ts `cmdReviewsAccept`: the `outcome.status === "rejected"` failure says the entry is rejected and awaiting its author's follow-up and cannot be accepted until the fix lands; update the function's doc comment.
- src/cli/help.ts, the `tumwater reviews` stanza: the `[rejected — waiting to revert: …]` line and "it refuses an entry already rejected and waiting on its revert" take the follow-up wording.
- docs/cli.md: the `tumwater reviews` clause and the Pending-pane `Ctrl+A` key-table row (both say "waiting on its revert") take the follow-up wording.
- No change to `renderPostReviews`'s line shape, `acceptPostReview`'s outcome kinds, or the `PostReview` type.

**Files touched.** src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md test/post-merge-review-render.test.ts test/cli-reviews.test.ts

**Acceptance criteria.**
- A rejected entry renders `[rejected — awaiting the author's follow-up: <reasons>]` from `postReviewStatusLabel` and on `tumwater reviews`'s line; no read surface says "waiting to revert".
- `tumwater reviews --accept <n>` on a rejected entry fails naming the author's follow-up, and changes nothing.
- The failed-run, unreviewed and empty cases are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review-render.test.ts: update the pinned rejected-label assertions (the end-to-end render and `postReviewStatusLabel`) to the new wording.
- test/cli-reviews.test.ts: update the review-list and `reviews --accept` refusal assertions to the new wording.

### A post-merge rejection stops reverting, part 3/3: the dashboard and TUI Pending panes name the forwarded follow-up, not a revert (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; requires parts 1/3 and 2/3 landed, since the TUI renders part 2/3's shared label and the browser mirrors it; touches src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts)

**Previously held 1**

**Follow-up 2026-10-24 by the operator:** same as part 2/3 — the dashboard and TUI wording this part fixes is replaced by "Forward, never back" below (a rejected entry reads `fixed — <finding> (fix <sha>)`, with no accept affordance to explain), so land it only as far as it goes and leave anything in flight as it is.

**Goal.** The TUI Pending pane's two operator messages, the browser's hand-kept label and the GUI's accept-refusal error still tell the operator a rejected entry waits on a revert. After part 1/3 it awaits the author's follow-up instead; the three dashboard surfaces must say so and match `tumwater reviews`.

**Approach.**
- src/ui/tui/tui-pane-pending.ts: the row hint "cannot be accepted until its revert runs — let the revert go, then review the revision" and the accept-flash "is rejected and waiting on its revert — let the revert run, then review the revision" say the entry awaits its author's follow-up and cannot be accepted until the fix lands. Update any row-rendering comment that names a revert.
- src/ui/gui/gui-client-pending.ts: the browser twin `postReviewStatusLabel` (a hand-kept copy) prints `[rejected — awaiting the author's follow-up: …]`; the card and accept-button comments ("not waiting on its revert") follow. A rejected entry still renders no Accept button.
- src/gui/gui-operator-commands.ts: the GUI accept endpoint's 409 error ("rejected and waiting on its revert — let the revert run, then review the revision") takes the follow-up wording.
- docs/how-it-works.md: the post-merge review paragraph (the rejection "goes to the revert slot", the reasons "back to its role as a revision", the `reverted after merge` note) describes the forwarded fix on main instead; the red-main revert paragraph is unchanged.
- No change to the GUI's `data-accept` guard, the TUI Ctrl+A handler, or the status payload shape.

**Files touched.** src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts

**Acceptance criteria.**
- Every dashboard/TUI string about a rejected post-merge review says it awaits the author's follow-up; none says "waiting on its revert" or "let the revert run".
- The TUI and browser render the same rejected label as `tumwater reviews` for the same entry.
- The accept affordances for a rejected entry are unchanged: the TUI refuses it, the GUI renders no Accept button.
- `npm run test:gate` passes.

**Tests.**
- test/tui-keys.test.ts: update the rejected accept-flash assertion to the new wording.
- test/gui-client-pending.test.ts: update the rejected-label assertion.
- test/gui-post-review-accept.test.ts: update the GUI 409 error assertion.

### Forward, never back, part 1/6: the reviewer's fix-forward prompt replaces the revert slot, so a post-merge rejection never reverts (planned 2026-10-24 by the plan role; requires part 1a/6 landed, since the harness that commits and lands the reviewer's fix is part 1a/6, and the switch that asks for an edit merges only once that landing path is the running build; its scope split again 2026-10-24 by the plan role — part 1b/6 below deletes the failed-forward hand-back plumbing this part leaves with no caller; split from the held parts 1/2–2/2; supersedes the accounting plan and parts 1/3–3/3 of "A post-merge rejection stops reverting" above; design half: plans/post-merge-fix-forward.md "Decision"; part 2/6 below accounts and bounds the self-fix chain, part 3/6 files a review that never reaches a verdict and updates every surface, and parts 4/6–6/6 delete the revert machinery this part stops using; lands before "Every commit is verified on main" part 3/3 below, which removes the last pre-merge block; touches src/merge/merge-post-review.ts src/prompt/gate-prompts.ts test/merge-drain.test.ts test/gate-prompts.test.ts)

**Previously held 3**

**Goal.** Nothing is ever taken off main for a post-merge finding. A rejection today pays a revert commit, a gate run on the revert inside the single merge slot, a hand-back to the author and a second review — 11 such cycles in the trailing day of 2026-10-23/24, every one a doc/claim slip (plans/post-merge-fix-forward.md "Measurement"), and 8 of 11 are the class a forward fix repairs on top of main in one run. With part 1a/6's landing path in place, this part makes the reviewer's own fix the only answer a rejection gets: `drainPostReviews` stops building the revert-slot culprit, and the post-merge review prompt tells the reviewer that a finding it can repair is the work — make the minimal fix in the worktree, leave the edit, and end with the verdict line plus `FIX: <files changed>`. Self-review is deliberate: at this project's 53% reject rate (plans/reviewer-as-role.md) the author and the reviewer were already rewriting the same text by turns, so the second reader was mostly nominal. The red-main revert is untouched here; parts 4/6–6/6 delete it.

**Approach.**
- A post-merge rejection stops filling the revert slot. src/merge/merge-post-review.ts `drainPostReviews` no longer builds a revert-slot culprit (`postReview: { reasons }` and the `skipChecks` WeakSet go): a rejected entry is answered by the reviewer's own fix (part 1a/6), never by a revert. The failed-forward fallback `sendReviewToRole` and the parked-forward plumbing it alone used are now unreachable and are deleted by part 1b/6 below, not here.
- What deliberately stays until part 4/6: `MainCulprit.postReview` (never set once `drainPostReviews` stops building the slot item, but still read by `runMainRevert` and `startRevert`), `startRevert`, `handBackReverted`, `revertReasons` and src/baseline/main-revert.ts itself, because the red-main revert still runs through them, and `revertCommitIn` (src/operator/revert.ts) with the `operator_revert` event, which is the operator's own act and stays for good.
- src/prompt/gate-prompts.ts `buildReviewPrompt` (its post-merge arm): the reviewer is told that a finding it can repair is the work — make the minimal fix in the worktree, leave the edit, and end with the verdict line plus `FIX: <files changed>`; a finding it cannot repair is recorded as the reasons are today. The clause renders only when the post-merge mode is set, so a pre-merge caller's prompt is byte-identical.
- The self-fix chain's accounting and bound, the failure cap and the surfaces are part 2/6 and part 3/6, not this part: this part only makes a repairable finding become a landed fix.

**Files touched.** src/merge/merge-post-review.ts src/prompt/gate-prompts.ts test/post-merge-review.test.ts test/merge-drain.test.ts test/gate-prompts.test.ts

**Acceptance criteria.**
- No rejection starts a revert and none hands anything back to the authoring role: `drainPostReviews` builds no revert-slot culprit and sets no `postReview`, so the reviewer's own fix (part 1a/6) is the only answer. (Part 1b/6 below deletes the now-dead `sendReviewToRole`, parked-forward record and `state.forwarded`.)
- The fix-forward instruction and its `FIX:` line reach only the post-merge review: a pre-merge caller's `buildReviewPrompt` output is unchanged, pinned by a test.
- The red-main revert still runs through `runMainRevert` (part 4/6 deletes it), and `tumwater revert <sha>` is unchanged.
- Nothing that verifies code changes here: the pre-merge deterministic checks, the main watch's own check and the gate's rule set are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: replace the revert-slot cases (`a rejecting post-merge review reverts the commit and hands it back as a revision`, `a rejected entry stays queued until its revert ran`, and the `drainUntilRevert` helper) with the forward assertions — a rejected entry never fills `p.revert`; it leaves post-review.json once the reviewer's fix lands (part 1a/6) while its reviewed commit stays on main. Keep the torn-entry, failed-write and queueing cases.
- test/merge-drain.test.ts: `a post-merge finding never takes the revert slot` — run two polls with a rejected entry and an idle merge slot and assert the slot stays free for a queued change while the entry leaves post-review.json once the fix lands; keep the no-rejected and one-review-at-a-time cases.
- test/gate-prompts.test.ts: the fix-forward clause and its `FIX:` line appear only when the post-merge mode is set; the prompt a pre-merge caller gets is unchanged.

### Forward, never back, part 1b/6: the failed-forward hand-back machinery is deleted — a rejected commit is answered only by the reviewer's own fix (planned 2026-10-24 by the plan role, split from the held part 1/6; requires part 1/6 landed, since the plumbing this part deletes is dead only once a rejection stops filling the revert slot; touches src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/run/run-verdict.ts src/run/run-stage.ts src/prompt/gate-notes.ts src/paths.ts docs/how-it-works.md docs/invariants.md test/main-revert.test.ts test/revision.test.ts test/merge-drain.test.ts)

**Previously held 2**

**Goal.** Once part 1/6 answers a post-merge rejection with the reviewer's own landed fix, the fallback that handed the reviewer's reasons to the authoring role has no reachable caller: `sendReviewToRole` (src/merge/merge-drain.ts) is passed only as `runMainRevert`'s `onFailed`, which runs only for a culprit carrying `postReview`, and part 1/6 removes the only place that sets `postReview` (`drainPostReviews` in src/merge/merge-post-review.ts). This part deletes that whole path — the parked `forwarded.json` queue, `recordForwardedChange`, the runner's `state.forwarded` follow-up and its note — so no code, state file or doc names a hand-back that can no longer happen.

**Approach.**
- src/merge/merge-drain.ts: delete `sendReviewToRole`, `handBackForward`, `pendingForwards` and `assignPendingReverts`' forward loop, and stop passing `sendReviewToRole` as `runMainRevert`'s `onFailed` in `startRevert` (a red-main culprit carries no `postReview`, so the callback is never needed).
- src/merge/merge-core.ts: delete `recordForwardedChange` and `handBackChange`'s `"forwarded"` arm and its `verdict` parameter, so `recordRevertedChange` is `handBackChange`'s only caller.
- src/runner/runner-state.ts: delete the `forwarded` field and drop it from `hasOutstandingWork`'s parameter and predicate; src/runner/runner-state-load.ts drops its heal; src/runner/runner-run.ts drops the forwarded follow-up branch; src/run/run-verdict.ts and src/run/run-stage.ts drop their `state.forwarded` consumption arms.
- src/prompt/gate-notes.ts: delete `buildForwardNote`; src/paths.ts deletes `forwardedPendingPath`.
- Docs: docs/how-it-works.md's forwarded-record paragraphs and docs/invariants.md's forwarded-hand-back guarantee and its bindings describe the deleted path and go with it; the revert hand-back they sit beside stays until parts 4/6–6/6.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/run/run-verdict.ts src/run/run-stage.ts src/prompt/gate-notes.ts src/paths.ts docs/how-it-works.md docs/invariants.md test/main-revert.test.ts test/revision.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- No forwarded hand-back remains: `grep -rn "sendReviewToRole\|recordForwardedChange\|forwardedPendingPath\|buildForwardNote\|\.forwarded" src/` finds none, `RunnerState` has no `forwarded` field, and `hasOutstandingWork` reads only `revision` and `resumePending`.
- No doc describes a forwarded hand-back and `forwarded.json` is named nowhere in src/ or docs/.
- The revert hand-back (`recordRevertedChange`, `state.revision`) is untouched and its tests still pass.
- `npm run test:gate` passes.

**Tests.**
- test/main-revert.test.ts: drop the `sendReviewToRole`/parked-forward cases and the `forwardedPendingPath` import; keep the operator-revert and red-main cases.
- test/revision.test.ts: drop "a forwarded post-merge rejection records the same round as a reverted one" and "a runner consuming a forwarded hand-back carries the round and re-applies nothing"; keep the reverted-chain cases.
- docs/invariants.md: remove the forwarded-hand-back guarantee and its bindings.

### Forward, never back, part 2/6: the self-fix chain is counted and its dead end holds the answered plan (planned 2026-10-24 by the plan role, split from the held parts 1/2–2/2; requires part 1/6 landed, since the chain this counter bounds is the fix chain part 1/6 lands; touches src/runner/revision.ts src/review/post-merge-review.ts src/merge/merge-post-review.ts test/revision.test.ts test/post-merge-review.test.ts)

**Previously held 1**

**Goal.** A self-fix chain cannot loop forever, and its dead end is operator-visible. A landed fix enters the queue as a normal post-review entry (`addPostReview`, `summary` = the finding it answers), so the next iteration reviews it like any unreviewed commit; the entry must carry the reviewed commit's round + 1 and stop at `REVISION_BACKSTOP` (src/runner/revision.ts), holding the answered plan as **Needs review** naming the surviving findings (`holdEntryAfterExhaustion`) rather than fixing again. Without this part the forward path as written is counted by neither `state.lastReview` nor the backstop, so a fix that never converges is an unbounded loop with an invisible dead end (plans/post-merge-fix-forward.md "The machinery a forward arm can reuse").

**Approach.**
- Carry the round on the fix: when the harness commits the reviewer's fix (part 1/6), its body carries the `Revision: <n>` trailer of the reviewed commit's round + 1 (`revisionRoundOf`, src/merge/merge-core.ts calls it today for the reverted hand-back), so the next review of that fix reads its own round from the same place a rejection's hand-back reads it.
- Stop at the backstop: in `reviewMergedCommit`/`startPostReview` (src/review/post-merge-review.ts, src/merge/merge-post-review.ts), when the reviewed commit's round is at `REVISION_BACKSTOP`, the reviewer records its surviving reasons instead of committing a fix, and the harness holds the answered PLANS.md plan through `holdEntryAfterExhaustion(root, role, claim, reasons)` — the same terminal state a rejection's exhaustion reaches (`recordRejectedChange`, src/merge/merge-core.ts).
- One counter: reuse `revisionRoundOf` and `holdEntryAfterExhaustion` rather than a second counter, so the self-fix chain and the rejection chain share `REVISION_BACKSTOP` and `REVISION_FINAL_ON_REPEAT` and cannot drift.
- A landed fix is a post-review entry, not a `state.revision`/`state.forwarded` hand-back: the round lives on the fix commit's body and the hold is the only runner state this part writes. (Part 1b/6 below deletes `state.forwarded`; this part does not write it.)

**Files touched.** src/runner/revision.ts src/review/post-merge-review.ts src/merge/merge-post-review.ts test/revision.test.ts test/post-merge-review.test.ts

**Acceptance criteria.**
- The landed fix appears as a new post-review entry and is reviewed on a later iteration; its commit body carries `Revision: <n>` one past the reviewed commit's round.
- A chain of self-fixes stops at `REVISION_BACKSTOP`: the reviewer stops fixing, and the answered plan is held with **Needs review** naming the surviving findings exactly as a rejection's exhaustion holds it.
- There is one backstop constant: the self-fix chain and the rejection chain both read `REVISION_BACKSTOP`, and no second counter is introduced.
- `npm run test:gate` passes.

**Tests.**
- test/revision.test.ts: `a self-fix chain stops at the backstop and holds the answered plan` — walk the fix commits' `Revision` rounds to `REVISION_BACKSTOP` and assert the hold note names the surviving findings and the entry is cleared.
- test/post-merge-review.test.ts: `a reviewer's fix commit carries the next revision round` — assert the landed `tumwater(reviewer): Fix` commit's body names one past the reviewed commit's round, and that a review at the backstop records reasons instead of committing a fix.

### Forward, never back, part 3/6: a review that never reaches a verdict files the commit as backlog work, and every surface reads the reviewer's fix rather than a revert (planned 2026-10-24 by the plan role, split from the held parts 1/2–2/2; requires part 1/6 landed, since the states it renders and files are part 1/6's; touches src/merge/merge-post-review.ts src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md docs/cli.md test/post-merge-review.test.ts test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts)

**Previously held 1**

**Goal.** Two loose ends of the forward path become visible and honest. A review that never reaches a verdict disappears today: after `POST_REVIEW_FAILURE_LIMIT` runs (src/merge/merge-post-review.ts) the entry is dropped with "stays on main unreviewed" and nothing else reads it — under this part the commit stays on main *and* a BUGS.md entry names it (sha, the commit summary, the last failure), so another role can improve it in the ordinary backlog flow. And every surface that named a revert reads the reviewer's fix instead.

**Approach.**
- File the unreviewed commit: at the failure cap, instead of `settlePostReview(root, entry.commit, null)` alone, append one BUGS.md entry naming the commit's short sha, its summary and the last failure, through the same backlog-write path `tumwater bug` uses; the `dropped-post-reviews` alert keeps counting the event.
- Surfaces: `postReviewStatusLabel` (src/review/post-merge-review-render.ts) and its GUI twin (src/ui/gui/gui-client-pending.ts) read `fixed — <finding> (fix <sha>)` for a landed fix, `approved` for a clean review, and `rejected — <finding>` for a recorded finding with no fix; `rejected — waiting to revert` and `awaiting the author's follow-up` go. The rejected entry's accept affordances go with the state that had them (`cmdReviewsAccept`'s rejected refusal, the dashboard's Accept button, the TUI's Ctrl+A arm), so no surface offers to accept a rejection.
- Docs: docs/how-it-works.md's post-merge-review paragraph describes the reviewer's fix (`fixed — <finding> (fix <sha>)`) instead of a revert and a revision, and docs/cli.md's `tumwater reviews` entry loses its rejected-entry accept wording; its `tumwater revert` entry stays and says the CLI revert is the operator's alone.
- The `post-merge-churn` alert keeps counting findings with the reviewer-fixes remedy (`narrow review.afterMerge` remains the alternative); the `post-merge-risk` and `dropped-post-reviews` alerts are unchanged.

**Files touched.** src/merge/merge-post-review.ts src/review/post-merge-review-render.ts src/review/post-merge-review-accept.ts src/cli/cli-review-commands.ts src/cli/help.ts src/ui/tui/tui-pane-pending.ts src/ui/gui/gui-client-pending.ts src/gui/gui-operator-commands.ts docs/how-it-works.md docs/cli.md test/post-merge-review.test.ts test/cli-reviews.test.ts test/tui-keys.test.ts test/gui-client-pending.test.ts test/gui-post-review-accept.test.ts

**Acceptance criteria.**
- A post-merge review that exhausts its failure cap leaves its commit on main and files one BUGS.md entry naming it (sha, summary, last failure), so an unreviewed commit is backlog work rather than a line in a log.
- The rejected-entry accept affordances are gone: `tumwater reviews` (and its dashboard and TUI twins) accept a pending entry only, and no surface offers to accept a rejection.
- `postReviewStatusLabel` and its GUI twin read `fixed — <finding> (fix <sha>)`, `approved`, or `rejected — <finding>`, and never "waiting to revert".
- docs/how-it-works.md and docs/cli.md carry the new wording, and no doc says a post-merge rejection reverts.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: `a review that never reaches a verdict files the commit` — drive `POST_REVIEW_FAILURE_LIMIT` failed runs and assert the commit is still on main, the entry is gone, and exactly one BUGS.md entry names its sha; keep the failed-write case.
- The surface tests keep their subjects with the new wording: test/cli-reviews.test.ts (`fixed — … (fix <sha>)` renders; an accept on a fixed entry fails like an accept on any non-pending one), test/tui-keys.test.ts, test/gui-client-pending.test.ts, test/gui-post-review-accept.test.ts.

### Forward, never back, part 4/6: the revert subsystem is deleted — no `main_revert` is emitted and a red main is healed forward (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 3/6 landed, since a rejection must have a complete forward path before the backward one goes; parts 5/6–6/6 then delete every reader of the historical events this part stops writing; touches src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts)

**Previously held 1**

**Goal.** With a rejection answered forward, the machinery that takes a commit off main has no caller but the red-main culprit, and this part removes that too: nothing is ever removed from main, including a red main's culprit, which the watch's already-queued heal prompt repairs forward. No new `main_revert` event is logged and no revision is handed back for a red main. The event type and its readers stay, reading history (parts 5/6–6/6 delete them).

**Approach.**
- Delete the revert subsystem: src/baseline/main-revert.ts (`runMainRevert`, `revertSkipReason`, `routeMainCulprit`), src/merge/merge-drain.ts's revert slot (`startRevert`, `handBackReverted`, `handBackRevert`, `revertReasons`, `PendingRevert`, `revertedPendingPath`/`pendingReverts`, and `assignPendingReverts`' revert loop), src/merge/merge-pipeline.ts's `p.revert`, src/merge/merge-core.ts's `recordRevertedChange` and `handBackChange`'s `"reverted"` arm, src/orchestrator/orchestrator.ts's `routeMainCulprit` wiring, and src/runner/revision.ts's re-apply chain (`applyRevision`/`applyWithConflicts` and the `revision`/`rejectedRefName` helpers the reverted path reads). `MainCulprit` moves to src/baseline/main-watch.ts, whose `onCulprit` is its only remaining producer, and keeps only the fields a red-main heal needs. `revertCommitIn` (src/operator/revert.ts) stays: `tumwater revert` is the operator's own act, and the `operator_revert` event with it.
- A red main heals forward: src/baseline/main-red.ts's heal path becomes the only one — the heal prompt the watch already queues, with the existing wording — and `main-watch.ts`'s `onCulprit` names the tip as the culprit without routing a revert.
- Docs: docs/invariants.md loses INV-L1, INV-C3, INV-BS1/2/3 and INV-CO1's revert guarantees (the `reason: "post-review"` paragraph is parts 5/6–6/6's, with the readers); docs/how-it-works.md's revert paragraphs describe the red-main heal prompt instead.
- No change to the pre-merge deterministic checks, the main watch's own check, or the `main_revert` event type and its readers: this part removes the emission, not the verification, and parts 5/6–6/6 remove the readers.

**Files touched.** src/baseline/main-revert.ts (deleted) src/baseline/main-red.ts src/baseline/main-watch.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/orchestrator/orchestrator.ts src/runner/revision.ts docs/invariants.md docs/how-it-works.md test/main-revert.test.ts (deleted) test/operator-revert.test.ts

**Acceptance criteria.**
- No `runMainRevert`, `routeMainCulprit` or `startRevert` remains, no `main_revert` event is logged for a red main, and no revision is handed back for one; `tumwater revert <sha>` still reverts and still logs `operator_revert` with the merge slot free afterwards.
- A red main queues the watch's heal prompt (its existing wording) and reverts nothing.
- The `main_revert` event type, its formatter and its readers still compile and read events already in the log; the only production code that mentions a revert is `tumwater revert`'s operator path, the `operator_revert` event, and wording saying a commit is never taken off main.
- `npm run test:gate` passes.

**Tests.**
- test/main-revert.test.ts: deleted with the module; the cases that still hold (a director-merged or runnerless culprit, `tumwater revert`) move to test/operator-revert.test.ts.
- test/operator-revert.test.ts: `tumwater revert still reverts and logs operator_revert` — a deliberate operator revert lands, logs `operator_revert`, and leaves the merge slot free.

### Forward, never back, part 5/6: the revert guardrails, doctor row, alerts and digest lose a revert that can no longer happen (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 4/6 landed, since no emission remains for the readers this part removes; part 6/6 below then deletes the report and GUI surfaces and the event type itself; touches src/baseline/main-guardrails.ts src/doctor/doctor-holds.ts src/doctor/doctor-project-checks.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/run/selfcheck-digest.ts docs/invariants.md test/main-guardrails.test.ts test/selfcheck-digest.test.ts)

**Previously held 1**

**Goal.** With no revert emitted, the doctor's revert rule, the `reverts` status alert and the digest's revert line count events that can never come. This part deletes them and the ceiling constant, so the 5-revert ceiling disappears and BUGS.md's churn entry loses its counting half (a reason-less event can no longer be misread as a red-main revert). The report and GUI "Reverts by role" charts and the `main_revert` event type are part 6/6's.

**Approach.**
- Delete the guardrail: src/baseline/main-guardrails.ts's `revertGuardrail`/`revertWarnings`/`revertLooksFalse`/`REVERT_RATE_LIMIT`/`revertsFor` and their `main_revert`-vs-`merged` patch-id matching.
- Delete every reader of it: src/doctor/doctor-holds.ts's `revertWarnings` phrases and src/doctor/doctor-project-checks.ts's revert row, src/ui/team-alerts.ts's `reverts` banner, src/ui/status-payload.ts's `revertAlert` (and its call site in the `teamAlerts` list), src/ui/status-render.ts's import and argument, and src/run/selfcheck-digest.ts's `guardrailWarnings` revert section.
- Docs: docs/invariants.md loses the revert-ceiling guarantee and any binding that names the deleted guardrail functions; no summary surface reads a revert that can no longer happen.
- The `main_revert` event type, formatter and label stay so the log still parses and the report/GUI can be removed in part 6/6.

**Files touched.** src/baseline/main-guardrails.ts src/doctor/doctor-holds.ts src/doctor/doctor-project-checks.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/run/selfcheck-digest.ts docs/invariants.md test/main-guardrails.test.ts test/selfcheck-digest.test.ts

**Acceptance criteria.**
- `grep -rn "revertGuardrail\|revertWarnings\|revertLooksFalse\|REVERT_RATE_LIMIT\|revertsFor\|revertAlert" src/ --include=*.ts` is empty, and no doctor row, status alert or digest line mentions a revert.
- The 5-revert ceiling is gone: no constant counts revert events and no warning fires on one.
- `operator_revert` and `tumwater revert` still work and their surfaces are untouched.
- `npm run test:gate` passes.

**Tests.**
- test/main-guardrails.test.ts: drop the revert-ceiling and revert-phrase cases, and keep one case pinning that an `operator_revert` still reads as a deliberate revert while no automatic revert rule warns.
- test/selfcheck-digest.test.ts: drop the digest's revert line case; keep the digest's other sections green.

### Forward, never back, part 6/6: the report and GUI "Reverts by role" surfaces and the `main_revert` event type are deleted (planned 2026-10-24 by the operator, split from the held part 2/2; requires part 5/6 landed, so the event type loses its last readers in the same deletion; touches src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/events/event-read.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts src/run/run-detail-data.ts src/failure/time-spend.ts docs/invariants.md test/time-spend.test.ts test/report-data.test.ts)

**Previously held 1**

**Goal.** With no producer and no summary reader left, the report's and GUI's "Reverts by role" charts and the `main_revert` event type are dead weight. This part deletes them, so `grep -rn "main_revert" src/` is empty and the `reason: "post-review"` split `1917e9c80` added goes with the event (with no revert there is no cause to tag). `operator_revert` and its report/run-detail rendering stay.

**Approach.**
- Delete the type and its formatting: src/events/events.ts's `main_revert` union member (keep `merged`'s and `operator_revert`'s), src/events/event-format.ts's case, src/events/event-labels.ts's `main_revert: "main red reverted"` label, and src/events/event-read.ts's `main_revert` reason normalization.
- Delete every remaining reader: src/report/report-fold.ts's `revertsByRole` fold and `main_revert` arm (+ src/report/report-types.ts's fields), src/report/report-data.ts's `revertsByRole` plumbing, src/report/report-render.ts's "Reverts by role" lines, src/ui/gui/gui-client-report-chart.ts's `chartRevertsByRole` and src/ui/gui/gui-client-report.ts's "Reverts by role" block, src/run/run-detail-data.ts's revert cause and `main_revert` branch, and src/failure/time-spend.ts's `reverted` loss cause and `main_revert` scan.
- Docs: docs/invariants.md loses the `reason: "post-review"` paragraph and any remaining `main_revert` binding; `operator_revert`'s guarantee stays.
- No production code may mention `main_revert` after this part; the log may still contain old events, which simply no longer parse into a known type.

**Files touched.** src/events/events.ts src/events/event-format.ts src/events/event-labels.ts src/events/event-read.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts src/ui/gui/gui-client-report-chart.ts src/ui/gui/gui-client-report.ts src/run/run-detail-data.ts src/failure/time-spend.ts docs/invariants.md test/time-spend.test.ts test/report-data.test.ts

**Acceptance criteria.**
- `grep -rn "main_revert" src/ --include=*.ts` is empty, and `grep -rn "revertsByRole" src/ --include=*.ts` is empty.
- The report and the browser dashboard print no "Reverts by role" chart, and the digest, doctor and status surfaces print no revert line.
- `operator_revert` still renders where it did (`tumwater revert`'s run detail and the report counts), and no surface reads a revert that no longer happens.
- `npm run test:gate` passes.

**Tests.**
- test/time-spend.test.ts / test/report-data.test.ts: drop the `reverted` loss-cause and `revertsByRole` cases, and keep one case pinning that an `operator_revert` still folds into the report's operator-revert count while no automatic revert does.

### Every commit is verified on main, part 3a/3: the red-main authoring block comes off — a code role authors on a red main and the `ci` healer is handed the failing tests (planned 2026-10-24 by the operator, split from the held part 3/3; the pre-merge blocks themselves come off in parts 3c/3–3f/3 below; touches src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts docs/how-it-works.md test/main-red.test.ts test/main-red-heal.test.ts test/roles.test.ts test/runner-ids.test.ts)

**Previously held 2**

**Goal.** Main's redness stops blocking authoring. `mainRedGate` (src/baseline/main-red.ts) and `baselineBlocked`/`BASELINE_BLOCKED_ROLES` (src/roles/roles.ts) exist only to keep a code role from spending an authoring run whose diff the pre-merge check would reject; with the pre-merge blocks coming off (parts 3c/3–3f/3) nothing is left to reject it, so the block only stalls every code role while main is red. The information survives where it is useful: the prompt's known-red note (`mainRedHealNote`) naming the failing tests and their owner, and the `ci` healer hand-off.

**Approach.**
- Delete `mainRedGate` (src/baseline/main-red.ts) and its call in `runner-run.ts` (the `blocked` branch that reads `mainRedGate(ctx.root, ctx.role, wt, undefined, …)`), so a code role's run on a red main proceeds. Keep `mainRedHealNote`, `mainRedHealPrompt`, `queueCulpritHeal` and `baselineCheckLogger` — the known-red note and the healer hand-off the watch and the `ci` plan read.
- Delete `baselineBlocked` and `BASELINE_BLOCKED_ROLES` (src/roles/roles.ts) and every reader; `DEFERRABLE_ROLES` and `OBSERVER_ROLES` (which keeps `ci`) stay, so the healer still schedules while main is red.
- Leave `heldByMainRed` (src/status/status-polls.ts), the status phase's `main red` label and the doctor's `main red` row in place: a merge verification still sets a role's `main_red` until part 3f/3 removes it, so the row still has a producer.
- docs/how-it-works.md's red-main paragraph now says every code role authors on a red main with the known-red note and the `ci` role repairs it; drop the "authoring is blocked" wording.

**Files touched.** src/baseline/main-red.ts src/roles/roles.ts src/runner/runner-run.ts docs/how-it-works.md test/main-red.test.ts test/main-red-heal.test.ts test/roles.test.ts test/runner-ids.test.ts

**Acceptance criteria.**
- A code role's run on a red main proceeds, carries the known-red note naming the failing tests and their owner, and no authoring run ends `main_red`; `mainRedGate`, `baselineBlocked` and `BASELINE_BLOCKED_ROLES` no longer exist.
- `mainRedHealNote`/`mainRedHealPrompt` and the `ci` healer hand-off are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/main-red.test.ts and test/main-red-heal.test.ts: drop the `mainRedGate` cases (the gate no longer exists) and assert `mainRedHealNote` still names the failing tests for a code role on a red main.
- test/roles.test.ts and test/runner-ids.test.ts: drop the `BASELINE_BLOCKED_ROLES`/`baselineBlocked` cases; keep the catalog and `OBSERVER_ROLES` checks.

**Needs review 2026-10-24 by feature: could not converge — (prior 2) `src/runner/model-fallback.ts:14` and `src/runner/runner-fallback.ts:22` still present "a red-main block" as a live pre-pi run-ending path that no longer exists; `test/runner-2.test.ts:5` and `test/main-baseline.test.ts:251` carry the same stale removed-gate wording. The cleanup of prior…; The PLANS-DONE entry's Files-touched list omits five files this diff edits (`docs/config.md`, `src/events/notify.ts`, `test/main-baseline.test.ts`, `test/merge-to-main-recheck.test.ts`, `test/status-render-cells.test.ts`), leaving the archived record inconsistent with the change.**

### Every commit is verified on main, part 3c/3: review moves after landing — no role is reviewed before its commit merges, and only a secret leak or a protected edit refuses a diff (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 2/3 landed; independent of parts 3a/3 and 3b/3; part 3d/3 below deletes the `review.afterMerge` surfaces this part leaves inert, and part 3e/3 deletes the pre-merge reviewer plumbing this part leaves unreferenced; touches src/review/review.ts src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/leftover.ts src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-scope.ts src/orchestrator/orchestrator-poll.ts docs/how-it-works.md test/review.test.ts test/post-merge-review.test.ts test/merge-drain.test.ts)

**Needs review 2026-10-24 by feature: too large for one run (held 3)**

**Previously held 2**

**Goal.** Every role's change lands first and is reviewed after it lands, as `review.afterMerge` roles already are. The pre-merge model verdict (`runReviewer`, src/review/review-run.ts) and its retry/revise rounds go, so the gate becomes deterministic: a diff is refused on the way in only for a **secret leak** or a **protected edit** — the two findings a later commit cannot repair (a leaked credential is in history and must be rotated; the protected-edit rule is the operator's policy boundary). A conflict marker, a false fix claim and backlog structure no longer refuse here; the watch already runs all five rules on main's tip (parts 1/3–2/3).

**Approach.**
- `reviewAheadOfMain` (src/review/review.ts) stops calling `runReviewer`: after the deterministic rules and the build pre-check it returns `{ decision: "approved" }` for every role with `lastApprovedHead = head` and the pre-check's `verifiedHead`, the path `review.afterMerge` roles take today. Its reject set shrinks to `secretLeakReason` and `protectedEditReason`; `diffRuleReasons`'s conflict-marker, false-fix and backlog-structure findings are dropped from the reject list (the watch still reports them).
- Every merged commit is queued for the post-landing review: `merge-drain.ts`'s `postReviewDue` drops its `isAfterMergeRole` test (keeping `config.review.enabled` and the exempt-diff test), so `settleOne` calls `addPostReview` for every `"changed"` result and `reviewMergedCommit` reviews every role.
- A role's `already_queued` recovery arm falls through to authoring for every role, not only `review.afterMerge` ones: `runner-run.ts`'s recovery condition drops its `reviewedAfterMerge` test (the interlock relief now applies team-wide).
- The reviewer provider holds defer only the post-landing review, never a role or a landing: `scheduling-skip.ts`, `orchestrator-scheduling.ts`, `scheduling-scope.ts` and `orchestrator-poll.ts` lose `afterMergeRoles` and each `!afterMergeRoles.has(...)` exemption — with no pre-merge verdict to gate, a held reviewer parks the review queue, not the team.
- Remove the permanent `mergeReviewError` config-error hold (`merge-core.ts` and `leftover.ts`'s `reviewHold` read): with no pre-merge reviewer there is no request a bad reviewer selector can make fail, so it must not hold a landing.
- `review.afterMerge` stays in the schema and its CLI/GUI surfaces for part 3d/3 to remove; here it is inert (only the display surfaces still read it). `review-run.ts`/`review-followup.ts` stay compiling and unreferenced for part 3e/3.

**Files touched.** src/review/review.ts src/merge/merge-drain.ts src/merge/merge-core.ts src/runner/runner-run.ts src/runner/leftover.ts src/orchestrator/scheduling-skip.ts src/orchestrator/orchestrator-scheduling.ts src/orchestrator/scheduling-scope.ts src/orchestrator/orchestrator-poll.ts docs/how-it-works.md test/review.test.ts test/post-merge-review.test.ts test/merge-drain.test.ts

**Acceptance criteria.**
- No role is reviewed before its commit merges: `reviewAheadOfMain` runs no pi reviewer, and every `"changed"` merge queues a post-landing review.
- The pre-merge gate refuses a diff only for a secret leak or a protected edit; a conflict marker, a false fix claim and a broken backlog structure approve and are reported by the watch on main's tip.
- A reviewer provider hold defers no role and no landing, only the post-landing review; no `mergeReviewError` hold exists, and a role with an `already_queued` recovery authors instead of ending.
- `npm run test:gate` passes.

**Tests.**
- test/review.test.ts: `only a secret leak and a protected edit refuse a pre-merge diff` — a leaked credential and a protected edit end `review_rejected` with their reason, while a conflict marker, a false fix claim and a broken backlog structure approve with no reviewer run.
- test/merge-drain.test.ts / test/post-merge-review.test.ts: `every merged role queues a post-landing review` — a `"changed"` merge from a role absent from `review.afterMerge` lands a `PostReview` entry; an exempt-only diff queues none.

### Every commit is verified on main, part 3d/3: `review.afterMerge` and every surface that sets or shows it are deleted (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3c/3 landed, since the key no longer changes behavior; touches src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config.ts src/review/post-merge-review.ts src/cli/cli-role-command.ts src/cli/help.ts src/roles/role-view.ts src/roles/role-render.ts src/gui/gui-config-commands.ts src/gui/gui-server.ts src/ui/gui/gui-client-drawer-config.ts src/ui/gui/gui-client-boot.ts docs/config.md docs/cli.md test/config.test.ts test/role-view.test.ts test/gui-endpoints.test.ts test/gui-client-drawer.test.ts)

**Previously held 2**

**Goal.** With every role reviewed after landing (part 3c/3), `review.afterMerge` no longer chooses anything: it is a knob that would move a role between two paths that are now the same. Delete it and the three ways it is set and shown, so the record has one review policy.

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

### Every commit is verified on main, part 3e/3: the pre-merge reviewer plumbing is deleted — `review-run.ts`, `review-followup.ts` and the review resume state (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3c/3 landed, since nothing calls the reviewer once every role is reviewed after landing; touches src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/request-timeouts.ts docs/how-it-works.md test/review.test.ts)

**Previously held 2**

**Goal.** Part 3c/3 leaves the pre-merge reviewer unreferenced; delete it so the gate is one thing and no reviewer prompt, resume session or retry budget lingers.

**Approach.**
- Delete `src/review/review-followup.ts` and `src/review/review-run.ts`. `review.ts` keeps the deterministic rules and build pre-check and builds its `GateResult` without `runReviewer`, `withRuns` and `restoreReviewedHead`; the small helpers it still needs (`reject`/`keep`, the pi-run fields) move into `review.ts` when a reader remains.
- Delete the reviewer resume machinery from `RunnerState` (`reviewResume`, and `REVIEW_RESUME_LIMIT`/`APPROVED_PATCH_IDS_MAX`/`approvedPatchIds` when the deterministic dedupe no longer reads the patch ids) and its healing in `runner-state-load.ts`; keep `lastApprovedHead` while the deterministic same-head dedupe uses it.
- Delete `buildReviewResumePrompt` and the reviewer-only parts of `buildReviewPrompt` from `src/prompt/gate-prompts.ts`; `buildReviewPrompt` stays because `post-merge-review.ts` reads it.
- Drop the `review-followup.ts` mention from `src/request-timeouts.ts`'s comment and update docs/how-it-works.md's review paragraph to name the one post-landing review.

**Files touched.** src/review/review-run.ts (deleted) src/review/review-followup.ts (deleted) src/review/review.ts src/prompt/gate-prompts.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/request-timeouts.ts docs/how-it-works.md test/review.test.ts

**Acceptance criteria.**
- `review-run.ts` and `review-followup.ts` no longer exist; no code imports them, and no reviewer prompt, resume session or no-rerun nudge remains.
- The gate still runs its deterministic rules and build pre-check and returns the same verdicts part 3c/3 established.
- `npm run test:gate` passes.

**Tests.**
- test/review.test.ts: the part 3c/3 deterministic cases still pass with the reviewer files gone; no case imports a review-run/review-followup symbol.

### Every commit is verified on main, part 3f/3: the merge slot runs no in-lock gate check and no batch check — a merge is a rebase and a fast-forward (planned 2026-10-24 by the operator, split from the held part 3/3; requires part 3e/3 landed, since the gate-scope checks lose their producers once the pre-merge reviewer is gone; touches src/merge/merge-to-main.ts src/merge/merge-batch.ts src/merge/merge-stack.ts src/merge/merge-core.ts src/merge/merge-check-failures.ts src/merge/merge-requeue.ts src/review/review-precheck.ts src/runner/leftover.ts src/doctor/doctor-holds.ts src/status/status-polls.ts src/ui/status-model.ts docs/how-it-works.md docs/invariants.md test/merge-to-main.test.ts test/merge-verify.test.ts test/main-red.test.ts)

**Previously held 2**

**Goal.** With the watch verifying every new tip, the checks that stood in front of a landing are redundant. Delete the merge slot's in-lock build re-check and the batch check with its largest-passing-prefix bisect, so a merge is: rebase onto the tip, take the fast-forward under the merge lock. A broken commit then sits on main between its landing and the watch's fix, which is the `ci` healer's job.

**Approach.**
- Delete the in-lock re-check from `mergeApprovedChange` (src/merge/merge-to-main.ts): the `runScopedBuildCheck`/`mergeCommand` run and its `merge_blocked` cause. The fast-forward, the conflict resolver, the dirty-checkout refusal and the `MERGE_CONFLICT_LIMIT` hand-back stay (a conflicted tree cannot be landed).
- Delete the batch path from `mergeApproved` (src/merge/merge-batch.ts): the shared scope-`batch` check, its `BATCH_RESTACK_ATTEMPTS` re-stack and its per-pick bisect/fallback, and whatever in `merge-stack.ts` only that path used. Every approved change merges one at a time through the now-check-free `mergeApprovedChange`.
- The gate-scope check producers go: `review-precheck.ts`'s build-check reject and `merge-check-failures.ts`'s `merge_blocked`/`review_rejected` attribution lose their callers; the merge-side `main_red` keep (`merge-core.ts`), `requeueMainRedPin`'s wait (`merge-requeue.ts`) and leftover's `main_red` wait go with the in-lock verdict that produced them.
- With no producer left, remove the merge verdict `main_red`: `heldByMainRed` and `mainCheckRecovered` (`src/status/status-polls.ts`), the status phase's `main red` label (`src/ui/status-model.ts`) and the doctor's held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`) go; the red-main warning that names an unheld red stays.
- Keep the two rules part 3c/3 left pre-merge (secret leaks and protected edits) and the refusals that are not quality verdicts: the dirty-checkout pre-flight (`merge-to-main.ts`), a rebase conflict and its hand-back, a lost fast-forward race, and the startup/redeploy stage check.
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

### The doctor's `stale questions` finding becomes a standing amber alert on `tumwater status`, the dashboard and the TUI — the always-on twin of its one backlog row with no twin yet (planned 2026-10-24 by the plan role; independent in behavior of every eligible plan — no eligible plan changes this rule or adds a backlog alert. It shares `src/ui/team-alerts.ts`, `src/ui/status-payload.ts`, `src/ui/status-render.ts`, `src/ui/tui/tui.tsx`, `test/team-alerts.test.ts` and `test/status-payload.test.ts` with the in-flight parallel-instances plan, which adds its own `stale-claims` alert through the same four modules and its own cases to the same two tests: both are additive alert modules and additive test cases, so whichever lands second rebases there. It shares `docs/how-it-works.md` with several waiting plans as a neighbouring sentence. It touches no other planning surface; touches src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/team-alerts.test.ts test/status-payload.test.ts)

**Goal.** The doctor's `stale questions` row (`checkStaleQuestions`, src/doctor/doctor-backlog-bugs.ts) warns when an open QUESTIONS.md entry's `(asked by … YYYY-MM-DD)` stamp is at least `STALE_QUESTION_DAYS` (7) old, but unlike its sibling `stale bugs` row it has no always-on twin: `teamAlerts`' `questions` alert (src/ui/team-alerts.ts `buildBacklogAlerts`) is indigo and lists every open question with no age, and only an operator who runs `tumwater doctor` learns that one has waited a week. A question that waits too long is a role stuck behind a decision — the exact class every other backlog row already raises as an amber alert (`stale-bugs`, `waiting-bugs`, `stale-prompts`, `stale-merges`). Give it the same twin, computed from the one threshold and stamp parser the doctor uses so the alert and the row cannot disagree on which questions are stale.

**Approach.**
- `src/ui/team-alerts.ts`: add `export interface StaleQuestion { index: number; position: number; title: string; days: number; }` beside `StaleBug`, with `position` the 1-based `questions --list` / `tumwater questions answer <n>` number, `title` stamp-stripped for prose, `days` the whole-day age, and `index` the 0-based `## Open` position kept only as the file-order tiebreak for `byDaysThenIndex` (the `questions` action opens the Questions tab, so the alert carries no row address). Add `staleQuestions: readonly StaleQuestion[] = []` as the final parameter of `teamAlerts`, thread it into `buildBacklogAlerts`'s input object, and there emit one amber `stale-questions` alert directly after the `questions` alert (so existing key orders are unchanged when the list is empty, and a repo with both reads `questions, stale-questions, refused, …`). Title `${plural(staleQuestions.length, "open question waited", "open questions waited")} 7+ days for an answer`; detail `#${first.position} "${first.title}" has waited ${first.days}d for an answer` + the `moreDetail(rest.map((q) => q.title))` fold, then ` · answer it with \`tumwater questions answer ${first.position} "<decision>"\`, or close it in QUESTIONS.md`; action `[{ label: "Answer", act: "questions" }]` (the `questions` alert's own action). The comment names `checkStaleQuestions` as the shared row, like the `stale-bugs` comment names `checkStaleBugs`.
- `src/ui/status-payload.ts`: add `export function staleOpenQuestions(root: string, now = Date.now()): StaleQuestion[]` beside `staleOpenBugs`, built exactly like it from `openQuestionEntries(root)`, `questionFilingDate(entry.title)` (src/backlog/question-answer.js), `ageInDays`, `STALE_QUESTION_DAYS` (import beside the existing `STALE_BUG_DAYS` from ../doctor/doctor-backlog.js) and `stripEntryStamp`, keeping only dated headings at or past the threshold and sorting through `byDaysThenIndex` (oldest-first, ties in file order) — no refused/waiting filter, because questions carry no such notes. Pass it as the final `teamAlerts(...)` argument in the payload builder's call.
- `src/ui/status-render.ts` and `src/ui/tui/tui.tsx`: import `staleOpenQuestions` from `../status-payload.js` and pass `staleOpenQuestions(root, now)` as the final `teamAlerts(...)` argument, so `tumwater status`, the dashboard banner list and the TUI attention lines all carry it.
- `docs/how-it-works.md`, the dashboard-alerts paragraph in "More controls": after the existing "open questions" item, add "a question that has waited a week for an answer".
- No change to `checkStaleQuestions`, `openQuestionEntries`, `questionFilingDate`, `STALE_QUESTION_DAYS`, the `questions` alert or any backlog writer.

**Acceptance criteria.**
- A repo whose QUESTIONS.md `## Open` holds a question stamped 7+ days ago makes `tumwater status`, the dashboard payload's `alerts` and the TUI attention lines carry one amber `stale-questions` alert naming that question's number, title and day count, with the `Answer` action; the same repo with only fresh or undated questions carries none.
- The alert is emitted right after `questions` and folds every question past the first through `moreDetail`, so two stale questions render `2 open questions waited 7+ days for an answer` and name the rest.
- The alert and `checkStaleQuestions` agree on the set because both read `STALE_QUESTION_DAYS` and `questionFilingDate`: a question exactly 7 days old is stale on both, and a 6-day-old or undated one is stale on neither.
- `npm run test:gate` passes.

**Tests.**
- test/team-alerts.test.ts: `the stale-questions alert names the oldest and folds the rest` — call `teamAlerts(base, ["Q?"], [], now, …, staleQuestions)` (filling the intervening defaulted arguments) with two `StaleQuestion` rows; assert one amber `stale-questions` alert whose title counts both, whose detail starts `#<first.position> "<first.title>" has waited <first.days>d`, carries `tumwater questions answer <first.position>`, folds the second, and whose action is `[{ label: "Answer", act: "questions" }]`; an empty list (the existing short-argument calls) yields no `stale-questions` alert.
- test/status-payload.test.ts: `staleOpenQuestions picks the 7+ day set and the payload carries it` — seed a QUESTIONS.md `## Open` with a fresh dated question, an undated one, and one stamped 8 days before `now`; assert `staleOpenQuestions(dir, now)` returns only the old one with its `position` and `days`, and that the status payload for that repo includes a `stale-questions` alert while a repo whose only question is fresh omits it.

### The doctor's `claimed bugs` finding becomes a standing amber alert on `tumwater status`, the dashboard and the TUI — the always-on twin of the false-fix scan, made poll-cheap by a stat-keyed source haystack (planned 2026-10-24 by the plan role; independent of every eligible plan in behavior — the `Forward, never back` parts edit src/review, src/merge, src/verdict/fix-claim.ts's `falseFixReason` callers and docs/invariants.md, but none of them edits `sourceHaystack`/`cachedSourceHaystack` or the doctor's fix-claim scan; the `Every commit is verified on main` parts edit src/baseline, src/merge, src/config, src/orchestrator and src/runner; the post-merge-rejection parts edit src/merge, src/review and src/cli; the Ready-only Backlog plan edits src/ui/tui/tui-backlog.ts and its neighbours and no src/ui/team-alerts.ts. It shares src/ui/team-alerts.ts, src/ui/status-payload.ts, src/ui/status-render.ts, src/ui/tui/tui.tsx and docs/how-it-works.md with the in-flight `stale questions` plan, which appends its own trailing `teamAlerts` parameter and its own amber block in the same `buildBacklogAlerts` — both additions are additive and whichever lands second rebases there; touches src/verdict/fix-claim.ts src/doctor/doctor-backlog-plans.ts src/ui/team-alerts.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/tui/tui.tsx docs/how-it-works.md test/fix-claim.test.ts test/doctor-backlog.test.ts test/team-alerts.test.ts test/status-payload.test.ts)

**Goal.** `checkFixClaims` (src/doctor/doctor-backlog-plans.ts) warns when a newest Fixed record is a false fix — its Fix paragraph names symbols, and **none** of them exist anywhere on the tree. This is the class the review chain has burned on (BUGS-FIXED.md's 105-run, 41-h fight over an already-fixed entry), and unlike its sibling `checkValidationGaps` — which got an always-on alert precisely because its scan runs no source-tree walk — it is visible only when an operator runs `tumwater doctor`. Its scan builds `sourceHaystack` (src/verdict/fix-claim.ts), which reads every non-markdown file under `src/`, `test/` and `scripts/` (~15 MB here), so it cannot run on the 1 Hz observer poll as it stands; `src/ui/team-alerts.ts`'s validation-gaps comment says as much. Give the rule the validation-gaps treatment: one shared scan, one amber alert, and a stat-keyed haystack cache so the poll reads the tree only when a file changed.

**Approach.**
- `src/verdict/fix-claim.ts`: add `export function cachedSourceHaystack(root: string): string` beside `sourceHaystack`, backed by a module-level `Map<string, { signature: string; text: string }>` (cleared past a small cap, like the other stat caches). It walks the same files `sourceHaystack` walks (the private `walkSourceFiles`, `node_modules`/`dist` skipped) plus `package.json`/`tsconfig.json`, builds a signature of each file's path + `mtimeMs` + `size` (`statSync`, which `sourceHaystack` already calls per file) sorted so the walk order cannot matter, and on a match returns the cached text with no file reads; on a miss it reads and stores. The cache is transparent — its return equals `sourceHaystack(root)` for the same tree — so the gate's `falseFixReason`, which keeps calling `sourceHaystack`, is untouched.
- `src/doctor/doctor-backlog-plans.ts`: add `export interface FixClaimProblem { heading: string; missing: string[] }` and a private `classifyFixClaims(records: readonly BacklogEntry[]): FixClaimProblem[]` holding the loop currently inside `checkFixClaims` (skip records whose `fixSymbols(body)` is empty; build the haystack once via `cachedSourceHaystack(root)`, not `sourceHaystack`; keep a record when every symbol is `unbackedSymbols`). Add `export function fixClaimProblems(root: string): FixClaimProblem[]` over the same `fixedBugEntries(root).slice(0, FIX_CLAIMS_CHECKED)` scan `validationGapRecords` uses, and rewrite `checkFixClaims` to keep its `readBacklogChecked(root, "BUGS.md")` guard and then format its existing message from `fixClaimProblems(root)` (first row's `heading`/`missing`, `andMore` over the rest), so the row and the alert share the one scan exactly as `checkValidationGaps`/`validationGapProblems` do.
- `src/ui/team-alerts.ts`: import `type FixClaimProblem` from `../doctor/doctor-backlog-plans.js` beside `ValidationGapProblem`; add `fixClaims: readonly FixClaimProblem[]` to `BacklogAlertsInput` and `fixClaims: readonly FixClaimProblem[] = []` as the final `teamAlerts` parameter, threading it into `buildBacklogAlerts`. There, in a block beside `validation-gaps`, when non-empty emit an amber `false-fixes` alert: title `plural(fixClaims.length, "Fixed record names code that is not on this tree", "Fixed records name code that is not on this tree")`; detail `BUGS.md records "${first.heading}" as Fixed, but none of the symbols its Fix paragraph names exist on this tree: ${missingSymbolNames(first.missing)}` plus `joinWithMore(rest.map((p) => "\"" + p.heading + "\""), 3)`, then ` — land the fix or keep the bug Open / refresh a stale record` (the doctor's own wording, so the two say the same thing); `actions: []` (the fix is editing BUGS.md, like `validation-gaps`).
- `src/ui/status-payload.ts`, `src/ui/status-render.ts`, `src/ui/tui/tui.tsx`: import `fixClaimProblems` from `../doctor/doctor-backlog-plans.js` and pass `fixClaimProblems(root)` as the final `teamAlerts(...)` argument (status-payload's `alerts:` call; the `renderStatus` and TUI attention calls).
- `docs/how-it-works.md`, the dashboard-alerts paragraph in "More controls": after the `validation gaps` item add "a Fixed record whose Fix paragraph names code that is not on the tree".
- No change to `checkFixClaims`'s rule, `fixSymbols`, `unbackedSymbols`, `sourceHaystack`, `falseFixReason`, `FIX_CLAIMS_CHECKED`, or any backlog writer.

**Acceptance criteria.**
- A repo whose newest Fixed record names only symbols absent from `src/`/`test/`/`scripts/`/`package.json`/`tsconfig.json` makes `tumwater status`, the dashboard payload's `alerts` and the TUI attention lines carry one amber `false-fixes` alert naming that record and its missing symbols; a repo whose newest Fixed records all name at least one live symbol carries none.
- The alert and `checkFixClaims` agree on the set because both read `fixClaimProblems(root)` (one `fixedBugEntries(root).slice(0, FIX_CLAIMS_CHECKED)` scan and one `cachedSourceHaystack(root)`): the doctor's message and the alert name the same first record.
- `cachedSourceHaystack(root)` returns the same string as `sourceHaystack(root)` on the same tree, and a steady-state poll of an unchanged tree performs no file reads (the signature walk is stat-only); after a source file's content changes, the next call reflects it.
- An empty `fixClaims` list (the existing short-argument `teamAlerts` calls) emits no `false-fixes` alert.
- `npm run test:gate` passes.

**Tests.**
- test/fix-claim.test.ts: `cachedSourceHaystack caches on the stat signature and re-reads on a change` — in a temp tree write a non-md source file; assert `cachedSourceHaystack(root)` equals `sourceHaystack(root)` and contains the file's text, a second call returns the same text, and after rewriting the file (a different mtime/size) the next call contains the new text and not the old. Plus `fixClaimProblems names a record whose symbols are all absent` — seed BUGS.md `## Fixed` with a record whose Fix paragraph names a symbol that exists nowhere; assert one row with that heading and the missing name, and that adding the symbol's text to a `src/` file (with the cache reset by the stat change) empties the row.
- test/doctor-backlog.test.ts: `checkFixClaims and fixClaimProblems agree on the false record` — the same seeded repo, assert the check's `warnOutcome` message contains the heading `fixClaimProblems(root)[0].heading` names.
- test/team-alerts.test.ts: `the false-fixes alert names the first record and folds the rest` — call `teamAlerts(base, [], [], now, …, fixClaims)` (filling the intervening defaulted arguments) with two `FixClaimProblem` rows; assert one amber `false-fixes` alert whose title counts both, whose detail names the first heading and its missing symbols and folds the second, and whose `actions` is `[]`; an empty list yields no `false-fixes` alert.
- test/status-payload.test.ts: `the status payload carries the false-fixes alert` — a repo with a false newest Fixed record includes a `false-fixes` alert in `statusPayload(root).alerts`, and a repo without one omits it.

## Done
