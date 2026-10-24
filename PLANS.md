# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Check-permit priority, part 2/2: Measure after the reviewer plan lands, then decide whether the cap rises (planned 2026-10-23 by user; design in plans/check-permit-priority.md "What lands" item 2; requires reviewer-as-role parts 1/4 and 3/4 landed (post-merge review removes the demoted roles' pre-merge gate checks; the convergence rule removes the 3–6-round tail that multiplies one item into a dozen checks); touches tumwater.json docs/config.md)

**Refused 2026-10-23 by feature: executing the decision now needs one week of post-reviewer-plan `check_wait` data, but reviewer-as-role parts 1/4 and 3/4 are still under `## Planned` (not landed), so no evidence exists and raising the cap 3→4 now would be the theory-knob this plan's "not a knob raised on theory" decision rejects**

**Goal.** The 24-min waits were burst-driven and demand-driven; both causes land as fixes elsewhere. This part is the decision procedure that says whether any capacity change is still needed — not a knob raised on theory.

**Approach.**
- After reviewer-as-role parts 1/4 and 3/4 have run for one week, read the week's `check_wait` events and the day report's `checkWaitMedianMs`: if no `check_wait` carries waitedMs ≥ CHECK_WAIT_EVENT_MS (30 s), the cap stays 3 and this plan's outcome is "no change needed" — recorded in PLANS-DONE when the part closes.
- Otherwise raise `maxConcurrentChecks` 3 → 4 in tumwater.json and the default stays 2 (src/config/config.ts) — a dogfood decision, not a default change — and watch the load-storm signal: `merge_blocked` events naming "host load average" (as 10-21's feature-7 and bugfix-4 did at load 20 on 18 cores). The doctor's `checkCheckContention` already warns and names the knob; the feedback loop exists.

**Acceptance criteria.**
- The decision (either branch) is recorded with its evidence in PLANS-DONE.md when closed; a raised cap is accompanied by one week of load-watch in the dogfood instance.
- `npm run test:gate` passes (config change only; no code).

### A post-merge review that keeps failing names its last failure reason in `tumwater reviews` and the dashboards, so the operator can act on the at-risk advice (planned 2026-10-23 by the plan role; independent in files — the at-risk plan reads `readPostReviews`/`POST_REVIEW_FAILURE_LIMIT` from src/review/post-merge-review.ts and the accept plan reads `readPostReviews`/`settlePostReview` there, neither editing the module, and the post-merge-review-keeping-authoring plan edits src/merge/merge-pipeline.ts, merge-verify.ts and merge-drain.ts, not src/merge/merge-post-review.ts; docs/cli.md's `tumwater reviews` clause is shared with the accept plan, so whichever lands second rebases that one clause; touches src/review/post-merge-review.ts src/merge/merge-post-review.ts src/review/post-review-render.ts src/ui/gui/gui-client-pending.ts docs/cli.md test/post-merge-review.test.ts test/post-review-render.test.ts test/gui-client-pending.test.ts)

**Goal.** `drainPostReviews` (src/merge/merge-post-review.ts) retries a post-merge review that ends without a verdict and logs the reason each time as a free-text warning: `the post-merge review of <sha> failed (<detail>)`. The entry itself keeps only the count (`failures`), so `tumwater reviews` and the dashboard/TUI Pending views print `[N failed review runs]` and the at-risk doctor row/alert planned in PLANS.md advises "fix the reviewer backend or accept the commit unreviewed deliberately" without naming what is failing. The operator has to grep `.tumwater/log/events.jsonl` for the sha to learn why. Store the latest run's `outcome.detail` on the entry and render it beside the count, so the place that raises the alarm also carries the reason to fix.

**Approach.**
- src/review/post-merge-review.ts: add `lastFailure?: string` to `PostReview` (doc-comment: the most recent verdict-less run's detail, replaced on each failed run and cleared when the entry is settled or removed). In `readPostReviews`, after the `failures` parse, `if (typeof lastFailure === "string") entry.lastFailure = lastFailure;` — a torn-file field of any other type is dropped like the others. Update the "torn or hand-edited entry" doc comment to name it.
- src/merge/merge-post-review.ts, `drainPostReviews`'s verdict-less arm: the below-limit `settlePostReview(root, entry.commit, { ...entry, failures })` becomes `{ ...entry, failures, lastFailure: outcome.detail }`. The drop-at-limit branch and its two warnings are unchanged (the entry is removed, so nothing renders its reason). The rejected arm's `{ ...entry, rejected: outcome.reasons }` spread keeps carrying any older `lastFailure`, which the rejected label already outranks.
- src/review/post-review-render.ts, `postReviewStatusLabel`: when `lastFailure` is a non-empty string, the failures branch returns `` `[${plural(entry.failures, "failed review run")} — last: ${squash(entry.lastFailure, 80)}]` `` instead of the bare count. `squash` is already imported; the rejected branch is unchanged. This one helper is what `renderPostReviews` (the CLI and the TUI Pending pane, src/ui/tui/tui-pane-pending.ts) already calls, so both get the reason with no further plumbing. Update the helper's doc comment to name the reason.
- src/ui/gui/gui-client-pending.ts, the hand-kept browser twin `postReviewStatusLabel`: mirror the same suffix using the file's `squashText(e.lastFailure, 80)`, so the dashboard's Post-merge reviews card matches the CLI. The card already paints `status.postReviews`, which statusPayload fills from `readPostReviews` (src/ui/status-payload.ts), so the new field reaches it with no server change.
- docs/cli.md, the `tumwater reviews` clause: after the `[N failed review runs]` description, state that the suffix names the last failure's reason (squashed) and that `--json` carries it as `lastFailure`. Do not touch docs/invariants.md: the field changes no guarantee in the `## Post-merge reviews` section, and the accept plan edits that section in the same window.

**Acceptance criteria.**
- After a verdict-less run below `POST_REVIEW_FAILURE_LIMIT`, `tumwater reviews` prints the entry with `[N failed review runs — last: <detail>]`, the same text appears in the dashboard's Post-merge reviews card and the TUI Pending pane's review block, and `reviews --json` carries the entry's `lastFailure` string; the detail is squashed to at most 80 characters with the same `squash`/`squashText` used elsewhere.
- A later failed run replaces `lastFailure` with that run's detail; an approve removes the entry and a reject keeps rendering the `[rejected — waiting to revert: …]` label without the reason.
- `readPostReviews` preserves a string `lastFailure` and drops a non-string one, so a hand-edited or older file still reads; `tumwater reviews` on an entry with only `failures` (no `lastFailure`) prints the unchanged `[N failed review runs]`, and the drop-at-limit behavior and its warnings are unchanged.
- `npm run test:gate` passes.

**Tests.**
- test/post-merge-review.test.ts: update `a merged commit whose diff git cannot produce fails its review, never approving an empty diff` so its `readPostReviews` deep-equal carries the git failure detail in `lastFailure` (the reason the run ended without a verdict), keeping its `assert.equal(reviews.count, 0)`. Add `a later failed run replaces the recorded last failure reason` beside it: seed an entry with `failures: 1, lastFailure: "old detail"`, drive one more verdict-less run, and assert `readPostReviews` shows `failures: 2` with the new detail; also assert `a post-merge review git could not start keeps its entry without counting a failed run` still records no `lastFailure` (the git-could-not-start path takes no `settlePostReview` write).
- test/post-review-render.test.ts: add `a failing entry names its last failure reason beside the count` — `postReviewStatusLabel({ commit, role, summary, failures: 2, lastFailure: "no parseable VERDICT line in the reviewer's reply" })` equals the `[2 failed review runs — last: …]` string, an entry with `failures: 2` and no `lastFailure` keeps `[2 failed review runs]`, a 200-character detail is squashed to the 80-bound with a trailing `…`, and the `rejected` cases still pass unedited.
- test/gui-client-pending.test.ts: extend the existing Post-merge reviews card test so a `failures: 2, lastFailure: "boom"` entry matches `/2 failed review runs — last: boom/` in its `<span class='mono'>` suffix, and the existing `failures: 2` and `rejected` assertions still hold when `lastFailure` is absent.

## Done
