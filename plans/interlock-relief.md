# Merge-queue interlock relief — a queued author may run again

Planned 2026-10-23 · requested by user (from the 2026-10-21→23 flow audit). Extends
[fast-merge.md](fast-merge.md) (2026-10-19, "a role queues its change and starts its next run at
once" — that landed) and composes with [reviewer-as-role.md](reviewer-as-role.md).

## The problem

The merge-queue interlock: a role with a queued or in-flight merge never starts a run
(src/orchestrator/orchestrator-scheduling.ts, `queuedRoles` check;
plans/merge-queue.md invariant 3, "one in-flight landing per loop"). Its purpose is preserving
the `state.lastReview` feedback contract — a rejection must reach the *same* runner that wrote
the change before that runner authors again.

But the pipeline latency it exposes to authors is now the dominant wait in the system: queue
waits before landing (`merge_done.queuedMs`, n=236 over 58 h) ran median 5 min, **57 over 10 min,
14 over 1 h, 4 ≈ 3 h, max 3 h 17 m** (bugfix-3's fix-up amend, 10-21, after 2 merge conflicts on
9 files and 5 review timeout retries). A role parked for that entire window authors nothing —
and with [reviewer-as-role.md](reviewer-as-role.md) moving the low-blast-radius roles' reviews
post-merge, the thing the interlock waits *on* (the pre-merge verdict) is gone for them.

## The decision

**Scope the interlock to what the feedback contract actually needs, per role.**

The contract — "a rejection reaches the author's next run" — is unchanged. What changes is *when
the author must stop*:

- **Pre-merge-review roles (feature, director, perf, improve, custom):** the interlock stays as
  it is. A rejection arrives before the merge, and the runner must see it before writing again —
  that is the contract's original case.
- **Post-merge-review roles (bugfix, clean, dedupe, coverage, readme, organize):** the
  pre-merge pipeline for them is deterministic checks + the merge itself. A role whose queued
  change is *approved and waiting for the merge slot* (the common case, minutes) or whose merge
  is *in flight* may start its next run. The exclusion stays only while its change is
  *under a deterministic rejection path* — conflict resolution (`resolve-wait`/`resolving`
  stages) or a held `main_red` pin — where the author's branch state is mid-surgery and a fresh
  run would race it.

**Why this is safe:** the author's next run starts from `reset --hard main`
(plans/merge-queue.md: "role branches keep being reset to main every tick — it is how a role
learns what every other role landed"), so a queued-but-approved change does not block its
author's tree. The race surface is exactly the non-approved stages, which stay excluded.
A post-merge rejection arrives later, through `settlePostReview`'s revert-to-author routing,
which already targets the author regardless of what run is active — that path was built without
the interlock's guarantee and does not need it.

**What this does NOT change:** invariant 3's per-runner cap ("no change accumulates more than
one commit ahead of main") — a role with a queued change still cannot queue a *second* change.
The interlock's *run* gate relaxes; the *queue* gate does not. An author whose new run finishes
while its previous change is still queued holds its new commit on the branch until the queue
entry drains — one commit ahead of main, as before, just not idle while waiting.

## What lands

1. **Stage-scoped eligibility (parts 1/4–3/4):** the stage is read from the shared
   `MergePipeline` (src/merge/merge-pipeline.ts) and the live marker (src/merge/merge-slot.ts),
   not added to `MergeEntry`; the scheduling skip applies to a role whose entry is pre-approval
   or in a conflict/main-red hold, not one approved-and-waiting or in the merge's fast-forward.
   The `waiting to merge` status word (docs/glossary.md) keeps its meaning — it names the queue,
   not the run gate.
2. **Docs (part 4/4):** plans/merge-queue.md's invariant 3 text is updated to the scoped form
   with a pointer here; docs/how-it-works.md's merge-pipeline section says which roles wait and
   which don't and why.

## Risks

- **Two commits in flight per role (branch + queue):** bounded to exactly two by the queue cap;
  the conflict surface for the second is the same rebase-onto-main every change already does.
  The rejected-diff re-apply path (plans/revise-rejected.md) applies onto current main, so a
  racing branch change is no different from any other main movement.
- **Reviewer-as-role dependency:** without post-merge review for a role, relaxing its interlock
  means the reviewer verdict races its next authoring run. Ship this per-role tiering only with
  reviewer-as-role.md part 1/4; the config that opts a role into `afterMerge` opts it into this
  too — one switch, not two.
