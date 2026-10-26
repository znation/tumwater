# Check-permit priority and demand — merge-scope checks go first, and the gate's check count drops with review

**Superseded 2026-10-26** by [subtract.md](subtract.md): part 1/2 landed and goes with the check
permit itself (Subtract part 3/6); part 2/2 — the decision whether the cap rises — is **cancelled**
(PLANS.md, 2026-10-26), because the in-lock landing it measured is deleted, so the cap has no
subject.

Planned 2026-10-23 · requested by user (from the 2026-10-21→23 flow audit: "why are there
24-minute waits?"). Companion to [reviewer-as-role.md](reviewer-as-role.md) — that plan removes
check *demand*; this one removes the *waits* the remaining demand still causes.

## The problem

`maxConcurrentChecks: 3` (src/concurrency/check-permit.ts, `checkPermits`) is a process-wide
semaphore every full-suite run must take: gate checks, merge checks, batch checks, and
main-baseline checks. Over 58 h the fleet ran **639 suite executions** through 3 permits
(p50 ~2.2 min, p90 ~6.5 min, max 35.6 min) at only ~20% average occupancy — but the waits are
real: 85 `check_wait` events ≥30 s, **6.3 h of total implementer idle**, p50 3 min, p90 8 min,
max **24 min** (feature-6, 10-21T13:38Z, parked behind "feature gate, dedupe gate, bugfix-4
merge" — a rotating queue of 1–2-minute gate checks from roles finishing runs in lockstep, not
one giant check).

Root cause is **synchronized arrivals**, not steady-state throughput: roles share
`minRunIntervalSeconds: 20`, a rejection schedules the next run at the minimum interval
(plans/review-gate.md item 2), and every committing run ends with a gate check — so rejected
roles re-run and re-check in lockstep, stacking bursts of simultaneous finishers that queue the
4th+ behind two full rotations.

The second, larger cause is **demand**: 639 checks served ~236 landings. Every change pays at
least two suite runs (gate + merge verify), and a 6-round reject cycle re-runs the suite up to a
dozen times for one item.

## The decision

**Priority, not just capacity.** Raising the cap trades idle-minutes for load storms — the same
log shows `merge_blocked` on "host load average 20 on 18 cores" (10-21, feature-7 and bugfix-4)
during the timeout storm, and the cap was already raised from the default 2 to 3. The high-value
change is ordering: **a merge-scope check waiting for a permit jumps the queue**, because a
merge in the lock blocks all other merges behind it (the merge lock is held through the in-lock
check, src/merge/merge-to-main.ts; INV-CT1) — a gate check parking the merge-slot holder is the
most expensive wait in the system.

FIFO stays within a scope. A merge-scope check arriving while three gate checks hold the
permits waits only for the *next* finisher, not the queue.

**Demand falls out of the reviewer plan.** Post-merge review for the demoted roles removes their
pre-merge gate checks entirely (one suite run per change, post-merge, shared with the merge
batch), and the convergence rule (reviewer-as-role.md part 3/4) removes the 3–6-round tail that
multiplies a single item into a dozen checks. Measure after those land: if `check_wait` events
above 30 s are gone from the log, the cap never needs to rise.

**If capacity is still needed after both:** raise `maxConcurrentChecks` one step (3 → 4) and
watch the load-storm `merge_blocked` rate; the doctor's existing
`checkCheckContention` (src/doctor/doctor-contention-checks.ts) already warns when total wait
crosses `CHECK_WAIT_WARN_TOTAL_MS` and names the knob — the feedback loop is built.

## What lands

1. **Priority (part 1/2):** `withCheckPermit` gains a scope; merge-scope requests park in a
   priority lane. The semaphore's shrink-preemption (src/concurrency/check-permit.ts) is
   untouched. `check_wait`'s `heldBy` event field (src/events/events.ts) gains nothing — a
   priority jump is not a wait worth an event.
2. **Instrument + decide (part 2/2):** the day report's existing `checkWaitMedianMs` field
   (src/report/report-types.ts) carries the measurement; after reviewer-as-role lands, read one
   week of it. Decision rule: no `check_wait` ≥ CHECK_WAIT_EVENT_MS in the window → the cap stays
   3; otherwise raise one step with the doctor watching the load warnings.

## Risks

- **Starvation of gate checks under sustained merge pressure:** bounded by mergeBatchMax (6) —
  a batch shares one check, so at most one priority merge check per batch of up to six changes.
- **Priority inversion via nested permits:** the existing re-entrancy guard
  (src/concurrency/check-permit.ts, a nested `withCheckPermit` runs inside the held permit)
  already prevents double-grabbing; the priority lane must route through the same entry point.
