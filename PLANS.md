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

### Interlock relief, part 4/4: Docs state which roles wait on their merge and which do not (planned 2026-10-23 by user; design in plans/interlock-relief.md "What lands" item 2; requires part 3/4 landed; touches docs/how-it-works.md docs/glossary.md plans/merge-queue.md)

**Previously held 1**

**Goal.** An operator reading the merge-pipeline section can predict which roles author through a queued change and which park, and why the split follows `review.afterMerge`.

**Approach.**
- docs/how-it-works.md, the merge-pipeline/scheduling sections: the interlock paragraph states the two tiers and the stage exclusions (pre-approval, conflict, main-red) as behavior, one paragraph, no new terms.
- docs/glossary.md: the `waiting to merge` status row gains the half-sentence "for pre-merge-review roles, this also holds the role's next run" — the scoped behavior is the row's whole difference.
- plans/merge-queue.md's invariant 3 is updated to the scoped form with a pointer to plans/interlock-relief.md.

**Acceptance criteria.**
- The three docs agree on the tiers and the excluded stages; grep finds no remaining unscoped "a role with a queued change never runs" claim outside plans/ as historical record.
- `npm run test:gate` passes (docs only).

### `tumwater reviews --accept <n>` retires a pending post-merge review the operator deliberately accepts unreviewed: the action the at-risk alert's advice names (planned 2026-10-23 by the plan role; independent of every in-flight plan's files — it edits no src/ui, src/doctor, src/merge, src/orchestrator, src/runner or src/roles file and only reads `readPostReviews`/`settlePostReview` from src/review/post-merge-review.ts, so the in-flight post-merge-churn plan's additions there and the at-risk plan's doctor/status readers do not collide; docs/invariants.md and docs/cli.md are shared with no waiting entry; touches src/review/post-review-accept.ts (new) src/cli/cli-review-commands.ts src/cli/help.ts docs/cli.md docs/invariants.md test/post-review-accept.test.ts (new) test/cli-reviews.test.ts)

**Goal.** A pending post-merge review leaves `.tumwater/state/post-review.json` two ways, both decided by the drain (`drainPostReviews`, src/merge/merge-post-review.ts): a verdict approves it or rejects it (revert), and a run that ends without a verdict counts toward `POST_REVIEW_FAILURE_LIMIT`, after which the entry is dropped with a warning and the commit stays on main unreviewed. There is no third, deliberate path. The `post-merge reviews` doctor row and the `post-merge-risk` amber alert planned in PLANS.md end their shared sentence with "fix the reviewer backend or accept the commit unreviewed deliberately", but `tumwater reviews` is documented read-only (`src/cli/cli-review-commands.ts`, `docs/cli.md`) and nothing writes the store except the drain, so an operator who decides the unreviewed commit is acceptable cannot act on the advice: the queue keeps retrying until the reviewer backend recovers or the automatic drop happens. Add the missing action, as `tumwater queue --cancel <n>`'s sibling (src/merge/merge-cancel.ts): remove the Nth entry `tumwater reviews` lists, on purpose, with one warning recording who/what was retired.

**Approach.**
- src/review/post-review-accept.ts (new): `export type AcceptPostReviewOutcome = { status: "accepted"; role: string; commit: string; summary: string } | { status: "out-of-range"; depth: number } | { status: "rejected"; commit: string };` and `export function acceptPostReview(root: string, position: number): AcceptPostReviewOutcome`. It reads `readPostReviews(root)` (the same FIFO list `renderPostReviews` numbers 1..N), returns `out-of-range` with the readable depth when `position` is outside it, returns `rejected` (writing nothing) when the entry carries `rejected` — that entry is waiting on its revert, and removing it would skip the revert — and otherwise calls `settlePostReview(root, entry.commit, null)` and `warnEventBestEffort(root, entry.role, \`post-merge review of ${shortSha(entry.commit)} accepted unreviewed at the operator's request — the commit stays on main unreviewed\`)` before returning `accepted`. Doc-comment that the write goes through `settlePostReview` (whose failed write already warns and never throws, INV-BT2), so this can never throw out of the command. Import `readPostReviews`/`settlePostReview` from ./post-merge-review.js, `warnEventBestEffort` from ../events/events.js, `shortSha` from ../text/format.js.
- src/cli/cli-review-commands.ts: `cmdReviews` routes an `--accept` presence to a new `cmdReviewsAccept(root, args)` before the read gate, the way `cmdQueue` routes `--cancel` to `cmdQueueCancel` (src/cli/cli-query-commands.ts). `cmdReviewsAccept` parses `--accept <n>` (`parsePositionFlag`), `--json` (at most once via `rejectRepeatFlag`), and tolerates `--help`/`-h`; `rest` goes through `rejectUnknownArgs("reviews", rest, [])`; a missing position fails with `--accept needs a position (usage: tumwater reviews --accept <n>)`; then `await requireReadyRepo(root)` (the destructive-mode gate; the read path keeps its `refuseTeamWorkspace` call). It calls `acceptPostReview`: `out-of-range` fails `no post-merge review at position <n> (post-merge review queue holds <depth>)`; `rejected` fails `post-merge review <n> is rejected and waiting on its revert — let the revert run, then review the revision`; `accepted` prints `accepted post-merge review entry <n> unreviewed: <roleLabel> <shortSha> — <summary>`, or with `--json` `{ accepted: { role, commit, summary } }`. Update the module doc comment: read-only except the one destructive `--accept` mode, and no new ready-repo requirement for the read path.
- src/cli/help.ts: the usage line becomes `tumwater reviews [--accept <n>] [--json]` and the stanza gains a sentence: `--accept <n>` removes the Nth queued entry (the position `tumwater reviews` prints) as deliberately accepted unreviewed, logging a warning; it refuses an entry already rejected and waiting on its revert. Keep one usage line so `helpStanzas`/`helpTopic` still bind `reviews`.
- docs/cli.md: the `tumwater reviews` clause drops "it is read-only" and adds the `--accept <n>` mode with its refusal and warning, keeping the missing/torn-file degradation sentence.
- docs/invariants.md: in the `## Post-merge reviews` section, add `### INV-BT4: an accepted post-merge review is removed without a review run, and a rejected one is refused`, **Guarantee** — `acceptPostReview` removes only the named FIFO entry, refuses an entry carrying `rejected` without writing, and a failed store write warns and never throws; **Binds** — `src/review/post-review-accept.ts` (`acceptPostReview`); **Pinned by** — the new test module.

**Acceptance criteria.**
- `tumwater reviews --accept <n>` removes exactly the Nth entry `tumwater reviews` lists (FIFO by `readPostReviews`), leaving every other entry in order, prints the accepted line, and logs one `warning` under the entry's role naming its short sha; `--json` prints `{ accepted: { role, commit, summary } }`.
- An out-of-range position fails naming the queue's current depth and changes no file; a missing position fails with the usage line; an unknown flag fails naming it; a `rejected` entry is refused (the revert must run) and changes no file.
- `reviews` and `reviews --json` behave exactly as before for the read case (the existing `test/cli-reviews.test.ts` read-only test still passes unedited), and positions are the ones the read render numbers.
- `acceptPostReview` can never throw into the CLI (the write's existing warn-and-continue behavior) and writes nothing on its `out-of-range` and `rejected` arms.
- `npm run test:gate` passes.

**Tests.**
- test/post-review-accept.test.ts (new; `makeRepo`, `writeFileDeep`, `postReviewPath`, `readPostReviews`, and `eventsOfType` from ./fixtures/log-fixtures.js): `acceptPostReview removes only the named position and names what it retired` — seed three entries (`improve`, `clean`, `coverage`), accept position 2, assert the `accepted` outcome names `clean` with its commit and summary, `readPostReviews` deep-equals the two others in order, and exactly one `warning` under `clean` mentions the short sha; `acceptPostReview refuses a rejected entry without writing` — seed one plain and one `rejected`, accept the rejected position, assert the `rejected` outcome and `readPostReviews` deep-equals the seed; `acceptPostReview reports the depth out of range` — seed two, assert positions 0 and 3 give `{ status: "out-of-range", depth: 2 }` with the file unchanged, and a missing file gives `depth: 0`.
- test/cli-reviews.test.ts (the existing CLI harness): `reviews --accept <n> removes the entry and prints the accepted line`; `reviews --accept <n> --json prints the accepted object`; `reviews --accept` with no position, an out-of-range position, a `rejected` entry, and `--accept` combined with `--bogus` each exit nonzero with the pinned wording and leave the file unchanged.

## Done
