# Reviewer as a regular role, not a gatekeeper — tiered post-merge review for low-blast-radius roles

Planned 2026-10-23 · requested by user (design discussion transcript: "encourage flow"; the
reviewer is a major cause of inefficiency, and the process — not the reviews — is the problem).
Shared design for the `Reviewer as a regular role N/4` entries in PLANS.md; each of those is
independently landable and cross-references this document for the decisions below. Supersedes
nothing — it extends [review-gate.md](review-gate.md) (the pre-merge gate) and
[post-merge-review.md's](../src/review/post-merge-review.ts) existing machinery, and composes with
[fast-merge.md](fast-merge.md) (2026-10-19, "a diff is reviewed once, not once per requeue or
rebase" — still true here).

## The problem

58 h of events (`.tumwater/log/events.jsonl`, 2026-10-21 → 10-23) show the reviewer as the
system's dominant friction source, and the shape is process, not verdict quality:

- **213 rejections vs 185 approvals (~53% of verdicts)**; 21 items exhausted the revision cap
  without landing.
- Serial reject streaks on single small entries: bugfix-2, **27 consecutive rejections over 6 h**
  on an md-only BUGS.md edit, exhausting the round-6 cap twice; bugfix-6, 18 over 4 h; bugfix-3/4/5
  in the same window (10-22T19:39Z → 10-23T03:05Z).
- Reviewer-side time per thrashed item routinely exceeds implementation time: bugfix-2 burned
  ~2.5 h of reviewer runs plus ~1.5 h of gate-build capacity on an edit that takes minutes to
  write.
- The rejection substance is mostly low-stakes: doc-comment misattributions, duplicate
  BUGS-FIXED.md entries, commit-body-vs-diff claims — the class a post-merge review converts
  from "hours of serial rework" into "one follow-up fix".

The reviewer is also a single point of failure: `reviewHeld` (a provider hold on the reviewer's
provider blocks every role — "nothing could merge", src/orchestrator/orchestrator-scheduling.ts)
and `reviewStrongPaused` (an unresolvable strong tier holds the whole team) each stopped all 30
roles during reviewer-infra storms (connection-error storm 10-21T02:30–03:40Z, ~25 `review_failed`
events; timeout storm 10-21T13:38–17:05Z, ~50 events total across the window).

## The decision

**Demote the model-verdict pass to post-merge review for the high-volume, low-blast-radius roles;
keep it pre-merge for feature and director.** The machinery already exists: `review.afterMerge`
(src/review/post-merge-review.ts — `PostReview`, `reviewMergedCommit`, `settlePostReview`) merges
a listed role's change with no reviewer run and reviews the merged commit when a permit is free,
routing a rejection through the revert slot back to the author as a revision. This is config plus
a small amount of hardening, not a new subsystem.

**Everything deterministic stays pre-merge.** The cheap, fast checks that caught the historical
disasters plans/review-gate.md was written for — the build pre-check (broken GUI page
force-merged), conflict markers, protected edits (INV-G1), secret leaks, backlog structure —
remain fail-closed before merge. Only the model-verdict pass demotes.

**Tiering, not wholesale.** `review.afterMerge` per role:

- **Post-merge (add):** bugfix, readme, organize, plus the existing clean, dedupe, coverage.
- **Pre-merge (unchanged):** feature, director, perf, improve, custom roles by default.

The default for a role not listed stays pre-merge (fail-closed for new/custom roles); the
operator opts a role in via tumwater.json.

**The tradeoff, accepted:** at a 53% reject rate, post-merge review means roughly half of the
demoted roles' changes land-then-revert before a fix lands. On a shared main with the main
baseline watcher and fast-merge's "a red main stops nobody; each role's prompt lists the tests
already failing and who owns them", that churn is survivable; the observed alternative — 6 h
serial rework on md-only edits — is not flow. If the land-then-revert rate on main proves too
noisy, the operator narrows `afterMerge` rather than reverting the design.

**The interlock question (out of scope here, see PLANS.md's interlock entry):** with review
non-blocking for a role, its queued-change interlock ("a role with a queued or in-flight merge
never starts a run", plans/merge-queue.md invariant 3) no longer needs to wait on the reviewer —
but the interlock exists to preserve the `state.lastReview` feedback contract
(plans/merge-queue.md), so relaxing it is a separate decision with its own entry.

## What lands, in order

1. **Config + dogfood (part 1/4):** widen the `review.afterMerge` default in
   src/config/config.ts and the tracked dogfood example (tumwater.example.json), so a fresh
   project inherits the tiering; the gitignored live tumwater.json is left to the operator
   (config changes no longer ride the commit path, plans/portability.md). The machinery needs no
   change. Update docs/config.md's `review.afterMerge` section with the tiering rationale.
2. **Post-merge review hardening (part 2/4):** the revert slot and `POST_REVIEW_FAILURE_LIMIT`
   were built for three slow maintenance roles. At fleet scale (bugfix's volume), the
   one-at-a-time review when a permit is free and the revert-after-merge path need capacity and
   failure-mode review before the volume moves.
3. **The convergence rule (part 3/4):** an objection that survives `REVISION_FINAL_ON_REPEAT`
   rounds converts to a blocked entry for the operator instead of rounds 3–6 — cutting the tail
   the log shows is the majority of the thrash (plans/revise-rejected.md's own motivation section
   found rejected work consumed ~21% of authoring spend; the 2026-10-21→23 window is far worse).
4. **Reviewer-feedback delivery (part 4/4):** the same reason text recurring across 27
   consecutive rejections means the injected `lastReview` note is not changing the author's next
   run. The highest-leverage small fix in the whole plan: make the rejection note impossible to
   miss (verdict-first prompt placement, per-reason acknowledgment in the author's next commit
   body) and measure whether first-rejection → second-rejection on the same reason drops.

## Risks

- **Revert churn on main** for demoted roles — accepted above, measured by the existing
  `rejectionsByRole`/`revisionsByRole` report fields (src/report/report-fold.ts) and the
  post-review.json state.
- **Reviewer capacity** becomes the merge poll's problem at fleet scale — part 2/4 exists for
  this.
- **The `refused`-entry contract:** a post-merge rejection of a change whose entry was already
  archived must not strand the entry. `settlePostReview`'s revert-to-author routing is the
  existing path; part 2/4 verifies it under volume.
