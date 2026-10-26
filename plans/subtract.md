# Subtract: one check, one hold, one runner, one model — the system the warnings describe as missing

Planned 2026-10-26 · requested by the user, from the alert feed they were reading:

> "I think the overall conclusion is that we need to reduce the amount of friction in getting
> changes merged, and make the system more self-healing. … I feel like this is over-indexing on
> optimizing a changing system (especially against the current running model(s) which is not
> necessarily the long-term target) and I would rather aim for simplicity over being heavily
> optimized."

This document is the *deletion* half of the work the 2026-10-24 operator decision
([post-merge-fix-forward.md](post-merge-fix-forward.md) "Decision", item 4: "The deterministic
gates move to every commit that hits main … and no model verdict blocks a landing") and the live
**"Every commit is verified on main"** series (PLANS.md) already began. Those two move the
verification; this one deletes what verification-moved leaves behind — the queue stages between
the author's commit and main, the five ways an entry can be parked, the pools and instance
claims, and the model-policy machinery.

## The problem: every warning is the shadow of a mechanism

The live instance's feed carries seven standing banners, six amber and one indigo, and the code
classifies every one of them as asking something of the operator (`alertNeedsYou`,
src/ui/team-alerts.ts). The doctor carries 79 rows behind them. But no warning in that feed is
about the project being built — they are all about tumwater's own machinery:

| Warning (`src/ui/team-alert-*.ts`) | The mechanism that produces it |
|---|---|
| 1 capacity bottleneck in the last day (`team-alert-tail.ts:147`) | the check permit (`src/concurrency/check-permit.ts`) and five places that run the full suite per change |
| 25 post-merge review rejections in the last day (`team-alert-merge.ts:84`) | the post-landing review, the revision cycle, and the queue stage that carries each one |
| 1 post-merge review is one failed run from being dropped (`:101`) | `POST_REVIEW_FAILURE_LIMIT` — a review that gives up, on a commit that stays on main with no owner |
| 2 refused entries wait on your decision (`team-alert-backlog.ts:74`) | the refusal note (`**Refused …**`) |
| 3 backlog entries are held for you to release (`:92`) | the held-for-operator hold, derived from the `(held N)` counter at a threshold |
| 2 waiting bugs held 7+ days (`team-alert-backlog-feed.ts:75`) | the Waiting-for-the-next-failure hold |
| A plan requires a part no heading carries (`:138`) | the `requires … landed` grammar in the heading parenthetical |

Three of those seven are the *same* story at three ends: checks contend, a check overruns its
deadline, the merge is rejected, the review of the rejected commit risks being dropped. The
other four are bookkeeping over how an entry is parked. **None of them is a warning about the
product.**

## The rule this plan applies

The codebase's self-healing is already three good patterns: heal at touch (a stale merge lock, a
stale `index.lock`, a dead worktree registration — src/git/worktree.ts, doctor-contention-checks
`checkMergeLock`), cross-check instead of a cleanup pass (a stale in-flight marker never
displays, src/status/status-data.ts), and bounded retry then a terminal state.

The general form, and what this plan holds to:

> **A detector must ship with an effector, or it must not exist.** Either the check resolves what
> it found, or the condition cannot persist — in which case no check is needed.

Applied to the feed: a warning is legitimate only when the action it asks for is a *decision*
the human alone can make. When the action is a *repair* — dedupe a heading, release a stale
pin, re-point a claim, pick a model, raise a cap — the system is asking a person to do its job,
and the fix is to delete the mechanism, not to word the warning better. Deleting a mechanism
removes the warning, its detector, its doctor row, its config key, its tests and its docs in one
stroke; that is where the simplification compounds.

## The six strokes

### 1. One verification point, after landing — already owned, not re-planned here

The live series ("Every commit is verified on main", PLANS.md parts 3d/3–3x/3) and
[post-merge-fix-forward.md](post-merge-fix-forward.md) own this. It deletes the pre-merge
reviewer, the `review.afterMerge` tier, the in-lock check and the batch check (part 3f/3). Parts
3/6 and 4/6 below are sequels to it, not rivals.

### 2. One hold vocabulary: `Refused` and `Needs review`

An entry can be parked five ways today, each with its own detector, its own release verb, its
own mark and its own alert: `**Refused …**`, `**Needs review …**` (+ `(held N)`),
`**Needs replan …**`, `**Waiting for the next failure …**`, and the derived *held-for-operator*
(a Needs-review note whose count crossed a threshold). Each of the three note kinds answers the
same question — *is this still workable, and by whom?* — and the operator's answer is always the
same verb.

Keep two: `**Refused …**` (the system declined and wants a decision) and `**Needs review …**`
(the work is not done, with the reason in the note). Delete `Needs replan` (a rejected plan is a
Needs review with the reviewer's objections in it), the `(held N)`/`**Previously held N**`
counters, the convergence hold as a distinct kind, and the derived held-for-operator threshold
with its `--release` branch and its alert. A plan the feature role reports too large for one run
then stays a Needs review entry the plan role always refines and splits; deleting the threshold
is what keeps it off the operator's desk (user request 2026-10-26).

### 3. The merge queue becomes a lock and a fast-forward

`.tumwater/merge-queue/`, the pipeline's stage machine, the coalesced batch check with its
prefix bisect, the re-queue path, the entry attempt/drop limits and the scheduling interlock all
exist to make an *exclusive, failure-prone* landing safe: a change is verified before it lands,
so landing may fail, so it must be queued, ordered, retried and interlocked.

Once verification is after landing (stroke 1), landing is `rebase → ff` under a short lock — the
thing the merge lock already does — and a change that breaks main is an ordinary open bug owned
by the author. Delete the queue's stages, the batch/bisect path, the requeue, the drop limits and
the interlock; keep the lock, the rebase and the linear-history invariant
(`plans/merge-queue.md` invariants 2 and 5 survive; invariants 1, 3 and 6 lose their mechanism).

### 4. One runner per role

`instances`, the instance claims and the worktree pool exist because a role spent most of its
time waiting for its own change to merge (fast-merge's measurement: 60% of role time waiting).
With landing in minutes, the wait stops being the constraint, and the pool's costs — slot waits,
pins, stale claims, salvage, the `parallel instances` and `workspace pins` rows and alerts —
buy nothing.

Delete the claims, the pool and the `instances` key; one runner per role, one checkout per role.
**Gate on measurement** (see "Before deleting concurrency and model policy").

### 5. One model per role

Model tiers, per-tier fallbacks, chain steps, per-provider caps, subscription windows and the
image probe all exist to route around a heterogeneous, quota-limited, uneven model fleet. The
user's own framing — "the current running model(s) … not necessarily the long-term target" — is
the argument against carrying that machinery: it is optimization for a fleet that is expected to
change.

Keep one thing: a model per role (and per seam) in `tumwater.json`. Delete the tier map, the
fallback maps and chain steps, the per-provider caps, the subscription-window carve-outs and the
image-capability probe with their rows, alerts, keys and tests. A role whose model is unusable
says so once, in doctor and in the report.
**Gate on measurement.**

### 6. Only a stopped team asks for a person

The banner feed keeps the conditions under which the team cannot make progress on its own, and
the operator's own decision queue:

| Kept | Why |
|---|---|
| main's check is failing — roles blocked / main red | the team is stopped |
| today's budget is spent, so the roles are paused | the team is stopped |
| N roles are failing run after run / looks stuck | the team is stopped for that role |
| tumwater is not running | nothing is happening |
| low disk / the root install is behind the lockfile | the team is about to be stopped |
| open questions need your answer | a decision only a person can make |
| refused entries wait on your decision | a decision only a person can make |

Every other amber alert — churn, at-risk reviews, flapped checks, quarantine, contention,
stale pins, stale claims, regressed fixes, unreadable queue files, provider caps, image probe,
role-note caps, brief caps, PRINCIPLES caps, qa coverage, ci parity — becomes a doctor row (it
already is one) or is deleted with its mechanism. The dashboard shows a count and a link to the
doctor; the doctor keeps the detail. **Target: the feed can be red or it can be empty.**

## Before deleting concurrency and model policy

Strokes 4 and 5 remove capacity. They are safe only if capacity stopped being the constraint, so
each is gated on the same evidence, read from the report and the log after strokes 1–3 land:

- per-change latency: end of run → on main, mean and p90, from `merge_done` in the day report;
- check pressure: `check_wait` count and total in a 24 h window (the doctor's own
  `checkCheckContention`), and workspace `slot_wait`;
- red-main minutes: from `main_check`/`main_red_hold` (the G1 guardrail's rule,
  src/baseline/main-guardrails.ts).

If p90 stays under ~15 minutes with one runner per role, stroke 4 is safe. If the checks run
within the permit without waits, stroke 3's deletions already removed the demand and stroke 5
changes nothing load-wise. If they do not, the answer is *not* to keep the pool — it is to make
the check cheaper or land less often, both of which this plan's strokes push toward anyway.

## What stays

- **One check, declared by the project, run by the harness.** Lint and compile are deterministic
  and a model cannot do them; they move to main's tip (stroke 1), they are not removed.
- **Linear history, one commit per change, all git in the harness.**
- **The backlog is the only durable record** — PLANS.md, BUGS.md, `## Open` and `## Fixed`. Every
  transient state this plan deletes was a second store that could disagree with it.
- **The refusal and the question.** The two places a human's judgment enters. They stay, and
  stroke 2 keeps exactly one hold each for them.
- **`tumwater doctor` as the one place a detail lives**, with the feed as its urgent subset.

## Series

"Subtract", parts 1/6–6/6 in PLANS.md:

| Part | What it deletes | Requires |
| --- | --- | --- |
| 1a–1e/6 Only a stopped team asks for a person | the amber/blue/gray alert builders, split into five sub-plans: 1a the dashboard's doctor link, 1b the staleness/notify/queue banners, 1c the review/check banners, 1d the status/tail banners, 1e the backlog staleness/structure banners | 1b: Subtract parts 1a/6 and 2a/6–2c/6; 1d: Subtract part 1c and 5e/6; the rest chain part-by-part |
| 2a–2c/6 One hold vocabulary | 2a: Needs replan; 2b: Waiting for the next failure; 2c: the held counters and the operator-held threshold | 2b requires 2a; 2c requires 2b |
| 3/6 The queue becomes a lock and a fast-forward | the queue stages, the batch check and bisect, the requeue, the drop limits, the interlock | Every commit is verified on main part 3f/3 |
| 4/6 One runner per role | instance claims, the worktree pool, `instances` | Subtract part 3/6 |
| 5a–5e/6 One model per role | 5a the image-capability probe, 5b the per-provider caps, 5c the fallback chains, 5d the subscription-window carve-outs, 5e the tier map | 5b requires 5a; 5c requires 5b; 5d requires 5c; 5e requires 5d |
| 6/6 The sweep | the rows, keys, aliases and docs the five parts left behind | — |

## Supersedes / retires

Recorded here, with a one-line pointer at the head of each doc whose premise this plan retires.
The docs keep their history: each solved a real problem at the time, and this plan says what
replaces the mechanism, not that it was wrong.

- [check-permit-priority.md](check-permit-priority.md) — part 2/2 (raise the cap after a week of
  data) is **cancelled**: stroke 3 removes the checked landing that created the demand, so the
  cap question has no subject. Its part 1/2 (merge-scope checks jump the permit queue) landed and
  is harmless; it goes with the permit.
- [merge-queue.md](merge-queue.md) — stroke 3 retires the queue's stages, batch, bisect, requeue
  and drop limits; invariants 2 (linear history) and 5 (landing costs belong to the author)
  survive, 1 and 3 lose their mechanism, 6 is deleted with the limits.
- [interlock-relief.md](interlock-relief.md) — stroke 3 deletes the interlock outright, so its
  per-role tiering has no subject.
- [parallel-work-instances.md](parallel-work-instances.md), [worktree-pool.md](worktree-pool.md) —
  stroke 4 retires both.
- [model-tiers.md](model-tiers.md), [fallback-chain.md](fallback-chain.md),
  [fallback-model.md](fallback-model.md), [provider-concurrency.md](provider-concurrency.md),
  [image-input.md](image-input.md), [daily-cost-budget.md](daily-cost-budget.md) — stroke 5
  retires the routing machinery; the daily cap stays as the one spend limit, per role.
- [refusal-and-thrash.md](refusal-and-thrash.md) — its hold vocabulary reduces to the one note in
  stroke 2; the refusal itself stays.
- [fast-merge.md](fast-merge.md), [review-gate.md](review-gate.md),
  [reviewer-as-role.md](reviewer-as-role.md), [revise-rejected.md](revise-rejected.md),
  [post-merge-fix-forward.md](post-merge-fix-forward.md) — already superseded by the live
  "Every commit is verified on main" series; unchanged here.

## Risks

- **Main is red more often.** Stroke 3 is only safe after stroke 1 and the live series land the
  "red main stops nobody" note and the fix-forward owner; otherwise this trades queue waits for a
  stopped team. Parts 3/6 and 4/6 therefore carry that requirement in their headings and bodies.
- **A deletion that outruns its measurement.** Strokes 4 and 5 remove capacity on a prediction.
  The measurement table above is the guard, and part 6/6's sweep is where a wrong deletion shows
  up as a missing row.
- **Losing a real signal with the noise.** A warning deleted because it was noise is gone for
  good. Each part's acceptance criteria name the condition that must still be visible *somewhere*
  (doctor or report) after the banner goes.
- **Revisionism.** The landed docs stay as the record of what was built; this plan's pointers say
  what retires them, not that they were wrong (each solved a real problem at the time).

## How we will know it worked

- The feed on a healthy team is empty; on a stopped team it names the stop and nothing else.
- `tumwater doctor`'s row count falls: 79 rows today, and the rows stroke 2, 3, 4 and 5 delete
  with their mechanisms (`stalled entries`, `backlog headings`, `plan dependencies`, the three
  contention rows, `worktree pool`, `parallel instances`, `provider concurrency`, `image input`,
  the model-tier and fallback rows) leave with them.
- One check runs per change, once, after landing: `build_check` events per merged commit fall to
  1 (they are ≥2 today, and up to a dozen in a reject cycle).
- The config schema loses its model-routing and capacity keys; the alert tests shrink with the
  builders.
