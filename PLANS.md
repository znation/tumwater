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
- src/baseline/main-revert.ts: delete `MainCulprit.postReview` and every read of it — `heal`'s `toReviewer`/`onFailed` branch, the post-merge-rejection wording in the revert message, and `reason: c.postReview ? "post-review" : "main-red"`, which becomes the constant `reason: "main-red"`. Delete `runMainRevert`'s `onFailed` parameter. Keep the `main_revert.reason` field and its readers (the report, run-detail and failure surfaces): events written before this change still carry `post-review`, and that value must keep reading as a post-merge rejection.
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

**Superseded 2026-10-24 by the feature role under part 3b/6 of "Forward, never back":** the "accept affordances go entirely" premise above is inverted by the landed part — a rejected entry now keeps its `--accept` affordance and is accepted like any pending one, so this entry's no-accept criteria no longer hold; its wording half (no "waiting to revert", no "let the revert run") is what part 3b/6 keeps.

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

**Superseded 2026-10-24 by the feature role under part 3b/6 of "Forward, never back":** the "no accept affordance" premise above is inverted by the landed part — a rejected entry now keeps its Accept affordance and is accepted like any pending one, landed by part 3b/6 on exactly these dashboard and TUI surfaces.

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

### Every commit is verified on main, part 3a/3: the red-main authoring block comes off — a code role authors on a red main and the `ci` healer is handed the failing tests (planned 2026-10-24 by the operator, split from the held part 3/3; rewritten 2026-10-24 by the plan role, which split the stale-reference sweep off as part 3k/3, and revised 2026-10-24 by the plan role to move the heal-key green clear into the main watch and hand the `main_red_hold` event comment to part 3k/3 — this part is the behavior removal and its commit record must say so; the pre-merge blocks themselves come off in parts 3g/3–3j/3 and 3d/3–3f/3; touches src/baseline/main-red.ts src/baseline/main-watch.ts src/doctor/doctor-holds.ts src/roles/roles.ts src/runner/runner-run.ts src/prompt/gate-notes.ts docs/how-it-works.md docs/invariants.md test/main-red.test.ts test/main-red-heal.test.ts test/runner-red-main.test.ts test/roles.test.ts test/runner-ids.test.ts test/runner-prompt-requeue.test.ts test/gate-notes.test.ts)

**Previously held 2**

**Goal.** Main's redness stops blocking authoring. `mainRedGate` (src/baseline/main-red.ts) and `baselineBlocked`/`BASELINE_BLOCKED_ROLES` (src/roles/roles.ts) exist only to keep a code role from spending an authoring run whose diff the pre-merge check would reject; with the pre-merge blocks coming off (parts 3g/3–3j/3 and 3d/3–3f/3) nothing is left to reject it, so the block only stalls every code role while main is red. The surviving information is the `ci` healer's hand-off (`mainRedHealNote`, `mainRedHealPrompt`) naming the failing tests and their owner, and the watch's and `main red` label's report of an unheld red. A code role no longer gets a `<main-known-red>` note: the gate that built it is gone. The gate also cleared the heal-dedup key on a green main; that clear moves to the main watch, which settles a green verdict on every new tip, so a failing set that returns after green still queues a fresh heal prompt (INV-AZ2).

**Approach.**
- Delete `mainRedGate` (src/baseline/main-red.ts) and its call in `runner-run.ts` (the `blocked` branch that reads `mainRedGate(ctx.root, ctx.role, wt, undefined, …)`), so a code role's run on a red main proceeds. Keep `mainRedHealNote`, `mainRedHealPrompt`, `queueCulpritHeal`, `baselineCheckLogger` and `warnMainRedOnce` — the healer hand-off the watch and the `ci` plan read. Reword `mainRedHealNote`'s "mainRedGate exempts ci" clause so the hand-off reads as independent of any gate, reword `mainTipVerdict`'s "the same per-SHA, team-wide cache mainRedGate reads" and "exactly as mainRedGate warns it" references to the surviving readers, and drop `main-red.ts`'s now-unused `baselineBlocked` import. Export `clearHealKeyOnGreen()` (sets `lastHealKey = null`), reword the `lastHealKey` doc comment ("a green main observed by the gate or the ci handoff clears it") to name the ci handoff and the main watch, and delete the gate's own `if (baseline.baseline?.status === "green") lastHealKey = null;` with the gate.
- src/baseline/main-watch.ts: in `watchOnce`, call `clearHealKeyOnGreen()` when the settled verdict is not red (a green, or a red naming only quarantined tests) before the `if (!red) return;` line, so a merge-turned-green main drops the dedup key.
- Delete `buildMainKnownRedNote` (src/prompt/gate-notes.ts) and its `test/gate-notes.test.ts` cases: its only caller is the gate's `onKnownRed` path in `runner-run.ts`, which goes with the branch. Drop `runner-run.ts`'s `knownRed` accumulation and the import. In gate-notes.ts's header change only the "a red main blocks every other code role" clause; its pre-merge "the gate's deterministic pre-check rejects any change that leaves the suite red" clause stays for parts 3g/3–3j/3 and 3d/3–3f/3.
- In `runner-run.ts`, rewrite the `baseRole` comment ("the red-main gate reads it") and the "leaves pristine main for the red-main gate" note. If any comment here names the parts that remove the pre-merge blocks, cite exactly "parts 3g/3–3j/3 and 3d/3–3f/3" — `3c/3` no longer exists (it was split into 3g–3j).
- Delete `baselineBlocked` and `BASELINE_BLOCKED_ROLES` (src/roles/roles.ts) and every reader; reword the `CODE_MAINTENANCE_ROLES` header (no "red-main blocking"), the `DEFERRABLE_ROLES` writer comment and `baselineBlocked`'s doc. `DEFERRABLE_ROLES` and `OBSERVER_ROLES` (which keeps `ci`) stay, so the healer still schedules while main is red.
- docs/how-it-works.md: the red-main paragraph (the "code roles' prompts carry a `<main-known-red>` note … only when the failure names no test … do code-producing roles pause authoring" sentence) now says every role keeps working on a red main and the `ci` healer is handed the failing tests; the merge/`check.mergeCommand` paragraph ("the red-main gate, the ci note read the watch's verdict") keeps the `ci` note only.
- docs/invariants.md, in the same commit: retire the `baselineBlocked` mention in INV-U4, drop `mainRedGate` from INV-AZ1, INV-AZ2 and INV-CP1, name `clearHealKeyOnGreen` and the main watch in INV-AZ2's `Binds` and guarantee, and re-point their `test/main-red.test.ts`/`test/main-red-heal.test.ts` "mainRedGate …" pins to the surviving `mainRedHealNote`/`clearHealKeyOnGreen` cases.
- src/doctor/doctor-holds.ts: `checkMainRed`'s doc comment names the removed gate ("names the code roles the red-main gate (mainRedGate) holds", "the red-main gate's guardrail, G1"); reword it to the surviving readers — the row lists the runs the merge-side `main_red` pin ended (until parts 3d/3–3f/3 land) and warns on an unheld long-red main — with no change to `checkMainRed`'s body, its `heldByMainRed` call, or the `RED_MAIN_WARN_MS` bound. This is the comment edit part 3k/3 no longer does.
- Every file this part edits is on the Files-touched list below; the remaining stale gate references (src/baseline/main-baseline.ts, src/runner/model-fallback.ts, src/runner/runner-fallback.ts, src/config/config.ts, src/cli/cli-start.ts, src/ui/status-model.ts, src/build/build-check-report.ts, src/build/build-check-events.ts, src/run/run-prompt.ts, src/review/review-precheck.ts, src/events/events.ts's `main_red_hold` comment — "every code role skips authoring until main is green" is false once the gate is gone — and the test headers part 3k/3 lists) are part 3k/3's change, not this one.
- The worktree's borrowed `node_modules` symlink does not match `.gitignore`'s `node_modules/` (a symlink is a file, not a directory): the change stages no `node_modules` entry and no other gitignored path, and the commit body enumerates every file beyond the Files-touched list (any `test/fakes/fake-pi.ts` edit included).

**Files touched.** src/baseline/main-red.ts src/baseline/main-watch.ts src/doctor/doctor-holds.ts src/roles/roles.ts src/runner/runner-run.ts src/prompt/gate-notes.ts docs/how-it-works.md docs/invariants.md test/main-red.test.ts test/main-red-heal.test.ts test/runner-red-main.test.ts test/roles.test.ts test/runner-ids.test.ts test/runner-prompt-requeue.test.ts test/gate-notes.test.ts

**Acceptance criteria.**
- A code role's authoring run on a red main proceeds to pi instead of being requeued or ended by the gate, and no `<main-known-red>` note is appended; `mainRedGate`, `baselineBlocked`, `BASELINE_BLOCKED_ROLES` and `buildMainKnownRedNote` no longer exist and nothing imports them.
- The `ci` healer's hand-off is unchanged: `mainRedHealNote`/`mainRedHealPrompt` still name the failing tests for a red main, and `warnMainRedOnce` still logs one `main_red_hold` per red SHA.
- A green main settled by the main watch clears the heal key: after a red queues ci's prompt, a green watch poll, then the same failing set returning, queues a second prompt (INV-AZ2).
- The change stages no `node_modules` path and no other gitignored path, and the commit body enumerates every file beyond the Files-touched list, naming any `test/fakes/fake-pi.ts` edit.
- The commit body and `RISK` describe a behavior removal — the red-main authoring block comes off — and neither says "comment only" or "no behavior change".
- No file in this part's Files-touched list contains `mainRedGate`, `baselineBlocked`, `BASELINE_BLOCKED_ROLES`, `red-main block` or `red-main gate` after the change.
- `src/doctor/doctor-holds.ts`'s `checkMainRed` still filters with `heldByMainRed` and reports the same held runs and unheld-red warning; only its doc comment changed, with no assertion edited.
- `npm run test:gate` passes.

**Tests.**
- test/main-red.test.ts: drop the `mainRedGate` cases (the gate no longer exists); keep the `mainRedHealNote`/`warnMainRedOnce` and `mainTipVerdict` cases, and reword the attribution case's "the red-main gate may carry main's green over it" comment to `mainTipVerdict`.
- test/main-red-heal.test.ts: rewrite "a failing set queues one heal prompt in any order, and queues another after main turns green" to drive red through `mainRedHealNote` instead of `mainRedGate` and to clear the key by settling a green poll of the main watch (`createMainWatch`, mirroring test/main-watch.test.ts's `watchAt`) before the returning red, asserting the second prompt; rewrite "a heal prompt that cannot be queued warns, lets the gate resolve, and is queued at the next red commit" the same way (`mainRedHealNote` resolves and warns once under the patched ci inbox). Keep the `mainRedHealPrompt` clause case untouched.
- test/runner-red-main.test.ts: fold the blocked-role and exempt-role cases into one `a code role authors while main is red` case (pi runs, the run ends on its own outcome); drop the gate-only green-passes, unverifiable-blocks and re-checks-new-SHA cases; keep the `ci` healer's fresh-prompt case; reword the "red-main block" strings to the `<main-red>` note the healer carries.
- test/runner-prompt-requeue.test.ts: drop the red-gate prompt-survival case, keeping the failed-resume and post-dequeue-crash cases, and drop the header's "a red-main gate" example.
- test/roles.test.ts and test/runner-ids.test.ts: drop the `BASELINE_BLOCKED_ROLES`/`baselineBlocked` cases; keep the catalog and `OBSERVER_ROLES` checks.
- test/gate-notes.test.ts: drop the `buildMainKnownRedNote` cases; keep the `buildMainRedNote` cases.

### Every commit is verified on main, part 3h/3: the pre-merge gate runs no model reviewer — only a secret leak, a brief-block edit or a protected edit refuses a diff (planned 2026-10-24 by the plan role, split from the too-large part 3c/3; requires part 3g/3 landed, since a role not on `review.afterMerge` must have its post-landing review queued before its pre-merge model review goes; touches src/review/review.ts src/review/diff-rules.ts docs/how-it-works.md test/review.test.ts)

**Needs review 2026-10-24 by feature: too large for one run (held 4)** — dropping the reviewer also breaks most of test/review-precheck.test.ts (tests that assert the reviewer runs after a green pre-check, plus the approval-reuse, prompt, nudge and second-slot-overlap cases for a feature this part deletes), which the plan does not list; that file needs a rewrite comparable to test/review.test.ts, so the files-touched list and its test plan must be corrected before it can land.

**Previously held 3**

**Goal.** `reviewAheadOfMain` (src/review/review.ts) stops running the pre-merge model reviewer: after the deterministic diff rules, the exempt check and the build pre-check it approves, so every merged change is judged once, by the post-landing review (part 3g/3). The pre-merge rejection set shrinks to the findings a later commit cannot repair: a leaked credential (`secretLeakReason`), a brief-block edit (`briefEditReason`) and a protected edit (`protectedEditReason`). A conflict marker, a false fix claim and a broken backlog structure no longer refuse here — the main watch still reports them on main's tip.

**Approach.**
- `diffRuleReasons` (src/review/diff-rules.ts) gains an explicit gate scope — an `only` set of rule names, or a sibling `gateRejectReasons` — so the gate runs only the brief-edit, protected-edit and secret-leak rules while the watch keeps running all five in the shared order. One call site states the ordering, so the two consumers cannot drift.
- `reviewAttempt` (src/review/review.ts) uses that scope for its `reject` list and, when no rule fires, returns `{ decision: "approved" }` with `state.lastApprovedHead = head` and `retry.pre.verifiedHead` — the branch a `review.afterMerge` role takes today. The `afterMerge`/`patchApproved` split disappears, and the now-dead `runReviewer` call and reviewer-only retry plumbing go with it, adjusting imports so `tsc` passes and leaving review-run.ts/review-followup.ts compiling and unreferenced for part 3e/3. The exempt path and the `gateBuildPrecheck` build pre-check are unchanged.
- The reviewer resume state `reviewAttempt` no longer reads is left for part 3e/3 to delete; this part removes only what `noUnusedLocals` would reject.
- docs/how-it-works.md: the review paragraph (the `review.afterMerge` role's separate path at its "A role listed in `review.afterMerge` is reviewed after merging" sentence) says one review runs after every landing and the pre-merge gate is deterministic.

**Files touched.** src/review/review.ts src/review/diff-rules.ts docs/how-it-works.md test/review.test.ts

**Acceptance criteria.**
- `reviewAheadOfMain` starts no pi reviewer run; a diff with a secret leak, a brief-block edit or a protected edit is still rejected with that reason, and a diff with a conflict marker, a false fix claim or a broken backlog structure approves instead.
- The exempt path and the build pre-check are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/review.test.ts: `only a secret leak and a protected edit refuse a pre-merge diff` — a leaked credential, a brief-block edit and a protected edit end `review_rejected` with their reason; a conflict marker, a false fix claim and a broken backlog structure approve with no reviewer run.
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

### The dashboard Usage view states the report's "of which merge runs" share under its tiles (planned 2026-10-24 by the plan role; independent in behavior of every eligible plan — the in-flight dashboard Usage "Estimated spend by backend" plan edits the same Usage render chain in src/ui/gui/gui-client-report.ts, the same `report-chart` region in src/ui/gui/gui-client-report-chart.ts and the same test file, so whichever lands second rebases at those additive seams — every other shared edit is additive; no other eligible plan touches those files, and none touches src/report/report-render.ts's `mergeShareLine` this plan twins)

**Goal.** `renderReportMarkdown` prints the totals line followed by `of which merge runs: N runs (M failed) · T tokens · $X (reviewer + conflict resolution)` whenever the window has merge runs (`mergeShareLine`, src/report/report-render.ts, called from `pushReportSummary`), and the TUI Usage pane shows it because it renders that same Markdown (`usagePaneCache`, src/ui/tui/tui-pane-report.ts). The dashboard Usage day-series view drops it: its `reportSummary` tiles (src/ui/gui/gui-client-report.ts) fold `t.mergeRuns` into Runs and `t.mergeCostUsd` into Spent, so an operator watching the browser cannot see how much of a window's tokens and cost was the merge slot's reviewer + conflict-resolution work — the figure that says whether the after-merge review tiering is paying off. Add the report's merge-share line under the tiles, in the CLI's wording family.

**Approach.**
- src/ui/gui/gui-client-report-chart.ts, the `report-chart` region: add `function mergeShareText(t)` beside the `seriesHas*` predicates, identical in wording to `mergeShareLine` but built from the client's own formatters: `"of which merge runs: " + plural(t.mergeRuns, "run") + ((t.mergeFailed || 0) > 0 ? " (" + t.mergeFailed + " failed)" : "") + " · " + fmtTokens(t.mergeTokens || 0) + " tokens · " + fmtUsd(t.mergeCostUsd || 0) + " (reviewer + conflict resolution)"`. No backticks or template literals (the region is one `String.raw` template). Name it in the region's doc comment's list of what the region holds.
- src/ui/gui/gui-client-report.ts, the `view-scaffold` region's Usage `render`: after `reportSummary(d) + "</div>"` and before `"<div class='grid-2 even'>"`, insert `(d.totals.mergeRuns > 0 ? "<p class='muted merge-share'>" + esc(mergeShareText(d.totals)) + "</p>" : "") +`. The predicate is the CLI's zero-means-absent rule, and a role-scoped report is zeroed by `scopedTotals`/`zeroMergeCounts` (src/report/report-data.ts), so the line stays absent there — the existing scope note already says merge runs are team-wide.

**Files touched.** src/ui/gui/gui-client-report.ts src/ui/gui/gui-client-report-chart.ts test/gui-client-report.test.ts

**Acceptance criteria.**
- The dashboard Usage day-series view renders `<p class='muted merge-share'>of which merge runs: N runs (M failed) · T tokens · $X (reviewer + conflict resolution)</p>` directly under the stats grid and above the charts whenever `d.totals.mergeRuns > 0`; a merge-free window and a role-scoped window render no such paragraph.
- `mergeShareText` reads only `mergeRuns`, `mergeFailed`, `mergeTokens` and `mergeCostUsd`, and its wording matches `mergeShareLine`'s ("of which merge runs:", the optional " (M failed)", the tokens and cost clauses, and the trailing "(reviewer + conflict resolution)"), so the browser and CLI lines cannot drift on what they say; only the number formatters (`fmtTokens`/`fmtUsd` vs `compactTokens`/`usd`) differ, as the tiles already do.
- `npm run test:gate` passes.

**Tests.**
- test/gui-client-report.test.ts: a unit test destructuring `mergeShareText` through `clientScope<{ mergeShareText(t: ReportTotals): string }>(["format", "report-chart"], ["mergeShareText"])`, asserting the exact string for a totals with `mergeRuns: 3, mergeFailed: 1, mergeTokens: 8000, mergeCostUsd: 1.5` (`of which merge runs: 3 runs (1 failed) · 8000 tokens · $1.50 (reviewer + conflict resolution)`) and one without `mergeFailed` (no " (… failed)" clause); import `ReportTotals` beside the file's existing `ReportData`/`ReportDay` import.
- test/gui-client-report.test.ts: a chain test over `GUI_CLIENT_REPORT_JS` mirroring the existing "the Usage render chain gates …" cases: `indexOf("merge-share")` is greater than `indexOf("reportSummary(d)")` and less than `indexOf("grid-2 even")`, the `<p class='muted merge-share'>` term appears exactly once, and it matches `d.totals.mergeRuns > 0 ? "<p class='muted merge-share'>" + esc(mergeShareText(d.totals)) + "</p>" : ""`.

## Done
