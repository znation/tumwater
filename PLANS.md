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

### Every post-merge rejection reaches one accounted terminal state: the revert chain holds its plan at exhaustion like a rejection's does, and the forwarded hand-back carries the same round and backstop counters (reported by the user 2026-10-24)

**Goal.** Every post-merge rejection ends somewhere operator-visible when it never converges, and every hand-back path counts rounds the same way. Two gaps make that false today. (1) The plan hold: `recordRevertedChange` (src/merge/merge-core.ts:401-424) counts rounds and clears the chain at `REVISION_BACKSTOP` but never calls `holdEntryAfterExhaustion`, so an exhausted post-merge chain leaves its plan eligible for a fresh pick that restarts the same cycle — the asymmetry against `recordRejectedChange` (src/merge/merge-core.ts:354-390, which holds at its exhaustion via the call at :387). (2) The forwarded path: `sendReviewToRole` (src/merge/merge-drain.ts:129-140) enqueues an inbox prompt and records nothing — no `state.lastReview`, no round — so a rejection that keeps being handed back has no backstop and no terminal state. Design: plans/post-merge-fix-forward.md, "What could land" item 2.

**Approach.**
- src/merge/merge-core.ts: `recordRevertedChange` calls `holdEntryAfterExhaustion(root, role, state.claim, reasons)` in its exhaustion branch, beside the existing `revision exhausted` log, exactly as `recordRejectedChange` does at :387 — so a post-merge chain that stops converging holds its PLANS.md plan for the plan role instead of re-picking. The existing "a BUGS.md claim is never held" rule inside `holdEntryAfterExhaustion` (no role resolves a Needs-review hold on a bug) stays the one home of that exemption.
- src/merge/merge-core.ts: add the one home of the forwarded record — `recordForwardedChange(root, role, state, commit, reasons)` — set beside `recordRevertedChange` and sharing its round arithmetic (the commit's `Revision` trailer read from `git log -1 --format=%B`, + 1) and its `REVISION_BACKSTOP` handling, so the two hand-back paths cannot drift on the counter. Its `state.lastReview` verdict must say what happened — the commit is still on main, not reverted — so no surface reads a revert that never ran (the BUGS-FIXED.md:24-31 class of defect).
- src/merge/merge-drain.ts `sendReviewToRole`: route through `recordForwardedChange` the way `handBackReverted` (:106) routes a revert — the commit's own runner when it is free, else the first free runner of the same base role — keeping the inbox prompt only for the no-free-runner case, where the round is counted at assignment (`assignPendingReverts`, :142) rather than at the first hand-back.
- Terminal state: an exhausted forwarded chain must be visible where rejections already are (`tumwater report`'s per-role maps, src/report/report-fold.ts) — a `revision exhausted` event is already logged for the reverted chain; the forwarded one logs the same event with its own action, so both read the same way on the report's revision line.
- No change to `POST_MERGE_REJECT_WARN`/`postMergeRejectionCounts` here: BUGS.md's filed churn entry (filed 2026-10-24, `tumwater bug`) owns the alert's row folding.

**Files touched.** src/merge/merge-core.ts src/merge/merge-drain.ts test/revision.test.ts test/main-revert.test.ts docs/how-it-works.md docs/invariants.md

**Acceptance criteria.**
- A chain of post-merge rejections that never converges ends with the revision cleared, `refs/tumwater/rejected/<role>` deleted, a `revision exhausted` event logged, and its PLANS.md plan held as a **Needs review** note naming the surviving objections verbatim — the same end state a pre-merge rejection's exhaustion produces.
- A rejection handed forward records `state.lastReview` naming the commit and the reasons with a round one past the commit's `Revision` trailer, and the round reaches `REVISION_BACKSTOP` the same way a reverted chain's does; the counter lives in one place, so a test that walks a chain crossing the backstop cannot see the two paths disagree.
- The parked-forward case (no free runner) counts its round when it is assigned, not when it is first enqueued: a plan cannot hold before a runner has ever received the reasons.
- `npm run test:gate` passes.

**Tests.**
- test/main-revert.test.ts: `a post-merge rejection chain that never converges holds its plan at the backstop` — seed a reverted change whose commit carries `Revision: n` trailers up to the backstop, run the hand-back, and assert the plan's **Needs review** hold plus the cleared revision and deleted ref (the existing exhaustion test's shape, extended to post-merge).
- test/revision.test.ts: `a forwarded post-merge rejection records the same round as a reverted one` — drive `recordForwardedChange` and `recordRevertedChange` over commits with identical `Revision` trailers and assert identical `state.revision.round` and identical backstop behavior; a second case pins that the parked case's round is counted at assignment.

### A post-merge rejection stops reverting, part 1/3: the merge drain hands the reviewer's reasons to the authoring role instead of filling the revert slot (planned 2026-10-24 by the plan role, split from the held single fix-forward entry; gated on the `## Planned` accounting plan "Every post-merge rejection reaches one accounted terminal state…" landing first — it adds `recordForwardedChange` and the runner routing this part calls; touches src/merge/merge-post-review.ts src/merge/merge-drain.ts src/baseline/main-revert.ts docs/invariants.md test/post-merge-review.test.ts test/merge-drain.test.ts test/main-revert.test.ts)

**Previously held 1**

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

### A re-queued merge carries how many times it has bounced, shown wherever its retry reason is, so a change stuck retrying is not mistaken for a fresh one (planned 2026-10-24 by the plan role; independent of every eligible plan — the high-friction plan edits src/merge/merge-queue-render.ts, src/status/status-data.ts, src/ui/gui/gui-client-pending.ts, docs/how-it-works.md and its queue tests, and this plan shares those first three files and test/merge-queue.test.ts / test/gui-client-pending.test.ts as neighbouring additions (that plan inserts a `high friction` tag before the retry tag in `renderMergeQueue`; this appends a count inside `retryNote`), the `reviews --role` plan edits src/review/post-merge-review-render.ts, src/cli/cli-review-commands.ts, src/cli/help.ts and their tests, the `post-merge churn` doctor plan edits src/review/post-merge-review.ts, src/ui/status-payload.ts and src/doctor/*, the event-feed plan edits src/events/event-format.ts, and the two post-merge-rejection plans edit src/merge/merge-core.ts, src/merge/merge-drain.ts, src/merge/merge-post-review.ts, src/baseline/*, src/ui/team-alerts.ts and their surfaces; neither this plan nor any waiting plan touches src/merge/merge-queue.ts or src/merge/merge-requeue.ts, whose `MergeEntry`/`retryEntry` edits are the one home of the count; touches src/merge/merge-queue.ts src/merge/merge-requeue.ts src/merge/merge-queue-render.ts src/status/status-data.ts src/ui/gui/gui-client-pending.ts docs/cli.md test/merge-requeue.test.ts test/merge-queue.test.ts test/status-data-inbox.test.ts test/gui-client-pending.test.ts)

**Goal.** A `MergeEntry` the pipeline re-queues after a retriable result names its result in `retry` (`merge_blocked`, `review_error`, `merge_conflict` or `main_red`, `retryEntry` in src/merge/merge-requeue.ts) but not how many times the change has bounced, and every re-queue resets `enqueuedAt` to now (`retryEntry`) so it also loses its queue age. A change re-queued once and one re-queued forty times read identically on `tumwater queue`, the dashboard Pending card and the TUI Pending pane. On the day one dirty primary `PLANS.md` produced ~300 `merge_blocked` refusals across five roles (BUGS.md's 2026-10-23 entry), the surfaces showed a succession of apparently fresh single retries, not a change stuck in a loop; the landed `primary-overwrite` alert names that one cause after the fact, but nothing names a repeated bounce itself. Carry a count on the entry and show it wherever the retry reason is already shown, so "this change keeps coming back" is visible at a glance.

**Approach.**
- src/merge/merge-queue.ts: add `retryCount?: number` to `MergeEntry` beside `retry`, doc-commented as how many times the pipeline has re-queued this change (absent for a fresh entry and a recovery's entry; informational, not an ordering key — the filename still orders the queue by the current attempt's `enqueuedAt`). Add `(e.retryCount === undefined || nonNegativeNumber(e.retryCount, null) !== null)` to `isMergeEntry` beside the `retry` guard, so a hand-edited non-number is skipped like any malformed field.
- src/merge/merge-requeue.ts `retryEntry`: add `retryCount: (from.retryCount ?? 0) + 1` to the returned object. `from` is the settled entry, so the count survives every retry; a `main_red` pin re-queues through `state.mainRedRetry.entry` (the stored `rest` carries the count) with the same arithmetic. A first re-queue gets 1.
- src/merge/merge-queue-render.ts `retryNote`: widen the `Pick` to `"retry" | "notBefore" | "retryCount"`, and when `(entry.retryCount ?? 0) > 1` append `` ` · ×${entry.retryCount}` `` after `re-queued after ${entry.retry}` and before the `eligible in` clause. A fresh entry (no `retry`) and a first re-queue (count 1) render byte-identically to today, so no existing queue line moves.
- src/status/status-data.ts: add `retryCount?: number` to the `mergeQueue.entries` element type and `...(typeof e.retryCount === "number" ? { retryCount: e.retryCount } : {})` to the `merges.map`, so the key stays absent for a fresh entry and the dashboards receive it.
- src/ui/gui/gui-client-pending.ts `queueEntryLineHtml`: inside the existing `retry` clause, append `(Number.isFinite(e.retryCount) && e.retryCount > 1 ? " · ×" + e.retryCount : "")` after the result and before the `eligible in` clause, matching `retryNote`'s wording.
- docs/cli.md, the `tumwater queue` clause (the sentence that already says a re-queued entry names why it is back): add that a change re-queued more than once also names how many times it has bounced (`re-queued after merge_blocked · ×3`).
- No change to `settleMergeOutcome`, `requeueKeptChange`'s re-queue decision, the event log, or `enqueuedAt`'s meaning; an implementation that finds itself editing those has gone off-plan.

**Files touched.** src/merge/merge-queue.ts src/merge/merge-requeue.ts src/merge/merge-queue-render.ts src/status/status-data.ts src/ui/gui/gui-client-pending.ts docs/cli.md test/merge-requeue.test.ts test/merge-queue.test.ts test/status-data-inbox.test.ts test/gui-client-pending.test.ts

**Acceptance criteria.**
- A `merge_blocked` entry with no `retryCount` re-queues with `retryCount === 1`; re-queueing that entry again yields `retryCount === 2`; the `role`, `sha`, `run`, `summary`, `retry` and revision fields are unchanged by the count.
- `retryNote({ retry: "merge_blocked" }, now)` still renders `re-queued after merge_blocked` and `retryNote({ retry: "merge_blocked", retryCount: 1 }, now)` renders the same; `retryNote({ retry: "merge_blocked", retryCount: 3 }, now)` renders `re-queued after merge_blocked · ×3`; with `notBefore` in the future the count clause sits before `eligible in`.
- `renderMergeQueue`'s line for a `retryCount: 3` entry carries ` · ×3`, and a fresh entry's and a first-retry entry's lines are byte-identical to today.
- The dashboard payload carries `retryCount` only when the entry has it, and `queueEntryLineHtml` renders ` · ×3` for `retryCount: 3` and no `×` for `retryCount: 1` or absent.
- `npm run test:gate` passes.

**Tests.**
- test/merge-requeue.test.ts: extend `a merge_blocked change is re-queued at once with its original summary and a retry field` (or add beside it) to assert the first re-queue's `retryCount === 1` and that re-queueing that entry again yields `retryCount === 2` with `retry` still `merge_blocked`; keep the existing `notBefore === undefined` assertion.
- test/merge-queue.test.ts: extend the `retryNote` unit block — `retryNote({ retry: "merge_blocked" }, now) === "re-queued after merge_blocked"`, `retryNote({ retry: "merge_blocked", retryCount: 1 }, now)` the same, and `retryNote({ retry: "merge_blocked", retryCount: 3 }, now) === "re-queued after merge_blocked · ×3"` — and add a `renderMergeQueue` case with a `retryCount: 3` entry asserting ` · ×3` lands between the retry text and the revision note while the existing fresh-entry line is unchanged.
- test/status-data-inbox.test.ts: extend the queue snapshot test's retry-bearing entry with `retryCount: 3` and assert `snap.mergeQueue.entries` carries it; the fresh-entry `deepEqual` still proves the key stays absent otherwise.
- test/gui-client-pending.test.ts: extend the existing re-queued-row case to assert `retryCount: 3` renders ` · ×3` and a `retryCount: 1` row renders no `×` (and no `undefined`/`NaN`).

### The dashboard's Pending view Post-merge reviews card gains a Role picker that keeps only the chosen role's entries, the `tumwater reviews --role` twin (planned 2026-10-24 by the plan role; independent of the eligible post-merge-rejection plans — part 1/3 edits src/merge/merge-post-review.ts, src/merge/merge-drain.ts, src/baseline/main-revert.ts and docs/invariants.md, the accounting plan edits src/merge/merge-core.ts, src/merge/merge-drain.ts and src/report/report-fold.ts, and the re-queued merge plan edits src/merge/merge-queue.ts, src/merge/merge-requeue.ts, src/merge/merge-queue-render.ts, src/status/status-data.ts and a neighbouring `queueEntryLineHtml` region of src/ui/gui/gui-client-pending.ts; this plan edits only `postReviewsHtml`, `renderPendingReviews` and the `pendingreviews` listener in src/ui/gui/gui-client-pending.ts, plus docs/how-it-works.md. The blocked part 3/3 edits the browser twin `postReviewStatusLabel` in that same file, a neighbouring function, so whichever lands second rebases there. Touches src/ui/gui/gui-client-pending.ts docs/how-it-works.md test/gui-client-pending.test.ts)

**Goal.** Every durable-queue read now has a role scope: `tumwater queue --role` (`scopeMergeQueue`, src/merge/merge-queue-render.ts), `backlog --role`, `history --role`, and since 2026-10-24 `tumwater reviews --role` (`scopePostReviews`, src/review/post-review-render.ts). On the dashboard's Pending view the Merge queue card and the Overlapping files card each carry a Role picker, but the Post-merge reviews card (`postReviewsHtml`/`renderPendingReviews`, src/ui/gui/gui-client-pending.ts) always lists every role's entry. An operator chasing one noisy role's post-merge rejections (the class the `post-merge-churn` alert names) must read the whole card. Give the card the same picker the Merge queue card has, so the browser matches `tumwater reviews --role`.

**Approach.**
- src/ui/gui/gui-client-pending.ts: add `let pendingReviewRole = "";` beside `pendingQueueRole`.
- `postReviewsHtml(entries, armed = "", role = "")`: when `entries` is a non-empty array, compute `roles = [...new Set(entries.map((e) => e && e.role).filter((r) => typeof r === "string"))].sort()` and `active = role && roles.includes(role) ? role : ""`; render the card head with the same markup `pendingQueueHtml` uses — `<label><span class='sr-only'>Role</span><select class='field' id='pendingreviewrole'><option value=''>All roles</option>` plus one `<option value='<id>' [selected]>` per role via `roleLabel(id)` — only when `roles.length`; otherwise the plain `<h2>Post-merge reviews</h2>` head. Render only the rows where `!active || (e && e.role === active)`. The empty/malformed-list branch keeps today's empty line and no picker. Because this card addresses Accept by commit sha (`data-accept`) rather than by position, filtering renumbers nothing: each kept row keeps its commit, and a rejected row still renders no button.
- `renderPendingReviews(status)`: before painting, prune a role that is no longer present — `const roles = new Set(entries.map((e) => e && e.role).filter((r) => typeof r === "string")); if (!roles.has(pendingReviewRole)) pendingReviewRole = "";` — then pass `pendingReviewRole` as `postReviewsHtml`'s third argument, mirroring `renderPendingQueue`'s `pendingQueueRole` guard.
- The `buildPendingView` `$("pendingreviews")` listener group gains a `change` handler for `e.target.id === "pendingreviewrole"`: set `pendingReviewRole = e.target.value` and repaint via `renderPendingReviews(lastStatus)`, mirroring the `pendingqueuerole` handler on `$("pendingqueue")`.
- Update the module doc comment, which names the Post-merge reviews card, to say it carries a Role picker keeping only the chosen role's entries (the `tumwater reviews --role` twin).
- docs/how-it-works.md, the Pending-view paragraph: after "It also paints the post-merge review queue as a Post-merge reviews card mirroring `tumwater reviews`", add "with a Role picker that keeps only the chosen role's entries, the `tumwater reviews --role` twin".
- No change to the TUI Pending pane's review block (it stays whole-list: its Ctrl+A accept addresses a whole-queue position, so a scope would renumber it), `statusPayload`, `postReviewStatusLabel` or the server. An implementation that finds itself editing those has gone off-plan.

**Files touched.** src/ui/gui/gui-client-pending.ts docs/how-it-works.md test/gui-client-pending.test.ts

**Acceptance criteria.**
- `postReviewsHtml(entries, "", "clean")` over a list naming three roles prints only the clean row, and its head carries `id='pendingreviewrole'` with `All roles` first, each present role once in sorted order, and `clean` selected; a role with no entry (and an absent role) prints every row, as `pendingQueueHtml` does.
- `postReviewsHtml(entries)` and `postReviewsHtml(entries, "", "")` are byte-identical to each other and, for the same list, to today's all-roles output: the picker's `All roles` option carries no `selected`.
- An empty or malformed `entries` still renders the existing empty line with no picker, no `undefined` and no `NaN`.
- Every filtered row keeps its `data-accept` commit and its Accept/Confirm accept arm; a rejected row still renders no Accept button.
- docs/how-it-works.md's Pending-view paragraph names the Post-merge reviews card's Role picker as the `tumwater reviews --role` twin.
- `npm run test:gate` passes.

**Tests.**
- test/gui-client-pending.test.ts: add `postReviewsHtml's Role picker keeps only the chosen role's entries and defaults to All roles` beside the existing `postReviewsHtml` block, built with the same `clientScope` scopes. Over a list holding `feature`, `bugfix` and `clean`, assert `postReviewsHtml(entries, "", "clean")` contains the clean row and not the feature or bugfix rows, and that the `id='pendingreviewrole'>…</select>` group holds `All roles` first, the three role options sorted, and `clean` selected; assert `postReviewsHtml(entries)` equals `postReviewsHtml(entries, "", "")` and shows all rows with no `selected`; assert a role naming no entry shows all rows; assert an empty and a malformed list render no picker and no `undefined`/`NaN`, and that each remaining row's `data-accept` commit is unchanged by the scope.

### The TUI Pending pane's Ctrl+G role scope reaches the post-merge review block, each kept review under its whole-queue position — the `tumwater reviews --role` terminal twin (planned 2026-10-24 by the plan role; independent in behavior of every eligible plan — the accounting plan edits src/merge/merge-core.ts, src/merge/merge-drain.ts and src/report/report-fold.ts, part 1/3 edits src/merge/merge-post-review.ts, src/merge/merge-drain.ts, src/baseline/main-revert.ts and docs/invariants.md, the re-queued merge plan edits src/merge/merge-queue.ts, src/merge/merge-requeue.ts, src/merge/merge-queue-render.ts, src/status/status-data.ts and a neighbouring `queueEntryLineHtml` region of src/ui/gui/gui-client-pending.ts, and the dashboard Role-picker plan edits src/ui/gui/gui-client-pending.ts; this edits none of those and changes no merge, review or CLI behavior. The blocked part 3/3 edits the neighbouring rejected-entry wording and `postReviewStatusLabel` in src/ui/tui/tui-pane-pending.ts, so whichever lands second rebases there. Touches src/ui/tui/tui-pane-pending.ts docs/cli.md docs/how-it-works.md test/tui-keys.test.ts)

**Goal.** Every durable-queue read now has a role scope: `tumwater queue --role`, `backlog --role`, `history --role`, `reviews --role` (`scopePostReviews`, src/review/post-merge-review-render.ts), and the dashboard Pending view is gaining Role pickers for the Merge queue, the Overlapping files and the Post-merge reviews cards. On the TUI Pending pane the Ctrl+G scope already narrows the merge queue (through `scopeMergeQueue`) and the overlapping files (through `scopeChangeOverlaps`) to one role, each kept merge under its whole-queue position — but `reviewsHead()` deliberately leaves the post-merge review block whole-list (`// The review block is never role-scoped`), so an operator chasing one noisy role's post-merge rejections must read every role's entries there. Give the review block the same scope, each kept review under its whole-queue position, so the TUI matches `tumwater reviews --role` and the dashboard picker.

**Approach.**
- src/ui/tui/tui-pane-pending.ts: add `export function postReviewRoles(entries: readonly PostReview[]): string[]` beside `mergeQueueRoles`, the distinct roles across the list in first-seen (FIFO) order, `[]` for an empty list. It is the review block's contribution to the Ctrl+G cycle.
- Factor the one scoped traversal `reviewsHead` and `rebuildQueueRows` both need: a `scopedReviews()` helper returning `{ entries: PostReview[]; scope?: { roles; positions; total } }` — `{ entries: lastReviews }` with no `scope` when `roleScope === null`, else `scopePostReviews(lastReviews, [roleScope], (r) => r === roleScope)`. `reviewsHead()` returns `""` only when `lastReviews.length === 0` (an empty whole queue has no block), and otherwise `renderPostReviews(scoped.entries, scoped.scope)`; under a scope that keeps nothing of a non-empty queue this is `renderPostReviews`'s existing `no post-merge reviews for <id> (post-merge review queue holds <total>)` line. `rebuildQueueRows()` pushes the review rows from the same traversal, each `{ kind: "review", entry, position }` carrying its whole-queue position — `i + 1` unscoped, `scoped.scope.positions[i]` scoped — exactly as the merge branch above it does, so the painted block and the selected row's accept position cannot drift.
- The Ctrl+G handler: build the cycle as `[...queueRoles, ...reviewRoles.filter((r) => !queueRoles.includes(r)), ...holders.filter((h) => !queueRoles.includes(h) && !reviewRoles.includes(h))]` where `reviewRoles = postReviewRoles(lastReviews)`, so the queue's roles lead, review-only roles follow, and overlap-only holders stay last. Widen the empty-cycle flash to `no queued merges, post-merge reviews or overlapping files to scope`.
- Update the comments that assert the review block is unscoped: the pane's top doc comment (`Ctrl+G cycles roleScope through each role the queue and the overlaps name`), the `reviewsHead` comment, and the `rebuildQueueRows` comment (`The review block is never role-scoped`), so all say the cycle covers the queue, the post-merge reviews and the overlaps, each review under its whole-queue position.
- Keep Ctrl+A's mechanism unchanged: it still acts on `row.position`, which a scoped review row now draws from `scopePostReviews` (the `tumwater reviews --accept <n>` number), and the existing `armedReview.commit` guard still refuses a row the queue moved.
- docs/cli.md, the `Ctrl+G` key-table row: the Pending scope keeps the queued merges, the overlapping files and the post-merge reviews one role owns, each merge and each review under its whole-queue position; the `tumwater reviews` clause's closing `the TUI Pending pane renders it` names the scope as the `reviews --role` twin.
- docs/how-it-works.md, the Pending paragraph: the Ctrl+G sentence adds the post-merge review block to the scope (`the same scope also narrows the post-merge review block to that role's entries, each under its whole-queue position (the tumwater reviews --role <id> view, through the same scopePostReviews)`), and the review-block sentence notes the block follows that scope.
- No change to `scopePostReviews`/`renderPostReviews`, `postReviewStatusLabel`, `readPostReviews`, the Ctrl+A accept core, the merge-queue scope, the overlap scope, or any server/status payload. An implementation that finds itself editing those has gone off-plan.

**Files touched.** src/ui/tui/tui-pane-pending.ts docs/cli.md docs/how-it-works.md test/tui-keys.test.ts

**Acceptance criteria.**
- With a post-merge review queue naming more than one role and no queued merges or overlaps, Ctrl+G's first press keeps only the first review role's entries, each under its whole-queue position, and the block header is `renderPostReviews`'s scoped `post-merge review queue (<kept> of <total>, --role <id>):`; the next press advances to the next review role and the final press returns to the whole block byte-identical to today.
- A role that appears only in the post-merge review queue is reachable by Ctrl+G; its press shows its scoped review block and the merge queue's `no queued merges for <id> (merge queue holds <total>)` block rather than the empty-cycle flash.
- An empty queue, empty review list and no overlaps still flashes and repaints nothing, with the widened message naming reviews.
- Ctrl+A on a scoped review row accepts that entry by its whole-queue position (the number `tumwater reviews --accept <n>` takes), and a review row whose whole-queue position no longer matches its armed commit is refused, not acted on.
- `npm run test:gate` passes.

**Tests.**
- test/tui-keys.test.ts: add `Ctrl+G on the Pending pane scopes the post-merge review block to each review role under its whole-queue position` — seed `writeJsonFile(postReviewPath(root), { pending: [...] })` with entries for `feature`, `clean` and `feature`, drive to the Pending view, and assert the first Ctrl+G press's `paneCache` contains only the first role's review line(s) under its whole-queue number(s) and `renderPostReviews`'s scoped header, the next press advances to the next role, and a press after the last returns to `renderPostReviews(readPostReviews(root))` byte-for-byte. Assert a review-only role (no queued merge, no overlap) is reached and does not flash.
- test/tui-keys.test.ts: pin `postReviewRoles` beside `mergeQueueRoles`'s block — `postReviewRoles([...])` lists each role once in first-seen order and `postReviewRoles([])` is `[]`.
- test/tui-keys.test.ts: extend the existing empty-queue-no-overlaps flash test to the widened `no queued merges, post-merge reviews or overlapping files to scope`.

## Done
