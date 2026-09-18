# Observer roles — a passing check is a result, not an idle tick

Planned 2026-09-17, requested by the user, after
https://blog.detail.dev/posts/towards-self-driving-codebases/ (the blind spots an agent cannot
see are where the bugs live, so the roles that look into them are the ones that most deserve
budget). Shared architecture for the two `Observer roles N/2` entries in PLANS.md; each is
independently landable and cross-references this document.

## The problem

`qa` is the only role that exercises the built product the way a person would, and in the
project's entire history it has filed **one** bug (BUGS.md attribution audit, 2026-09-17: 55
attributions, of which `bugfix` 19, humans 21, `readme` 7, `qa` 1). It is not that the role is
bad. It is that the role barely runs, and the scheduler is the reason.

Ticks per role from `.tumwater/log/events.jsonl`, split at 2026-09-13:

| role | ticks 08-20…09-12 | ticks 09-13…09-17 | deferrals since 09-13 | per day |
| --- | ---: | ---: | ---: | --- |
| `qa` | 20 | **0** | 10 | 0.8 → 0.0 |
| `perf` | 123 | **0** | 10 | 5.1 → 0.0 |
| `clean` | 149 | **0** | 10 | 6.2 → 0.0 |
| `organize` | 146 | 5 | 6 | 6.1 → 1.0 |
| `improve` | 139 | 16 | 5 | 5.8 → 3.2 |
| `feature` | 139 | 45 | 0 | 5.8 → 9.0 |
| `bugfix` | 149 | 48 | 0 | 6.2 → 9.6 |

Three roles have not ticked at all in five days. This is a latch, and it is a bug in its own
right (tracked separately in BUGS.md — see "Relationship to the deferral latch" below). Read
`deferTick` in `src/scheduling.ts`:

```
DEFERRABLE_ROLES.has(role) && s.lastResult === "no_change" && s.lastMainHead !== ""
  && (workBacklogOpen || !workLandedSinceLast)
```

A deferred tick does not run, so `lastResult` stays `"no_change"`. `workBacklogOpen` alone is
sufficient to defer, and it is true whenever PLANS.md `## Planned` or BUGS.md `## Open` is
non-empty — which, in a healthy project with a `plan` role whose entire job is keeping `Planned`
stocked, is always. So the moment a deferrable role reports `no_change` once, it never ticks
again until the whole backlog empties. The roles that land changes most often (`feature`,
`bugfix`, `coverage`, `dry`, `readme`) never trip the precondition and are unaffected; the roles
whose honest answer is frequently "nothing to do" were switched off permanently. Backlog-aware
deferral landed 2026-09-12; `qa`, `perf` and `clean` each last ticked on or before that date.

But fixing the latch is not enough, and that is what this plan is about.

**For `qa`, `no_change` is a success, not idleness.** The role's charter is: build the product
fresh, run a documented flow end to end, and file a bug if reality disagrees with the docs. When
the flow works, the correct outcome is "nothing to do" — the role did its job and the product was
fine. The harness treats that identically to a `clean` tick that surveyed the tree and found no
mess: it climbs the idle-backoff ladder (`applyTickOutcome`'s final `else` in `src/state.ts`,
`idleBackoff` = 120 s × 2, capped at 36000 s) and, since 2026-09-12, defers. After roughly eight
consecutive passing checks `qa` is asleep for ten hours. **The role is punished, monotonically,
for the product being healthy.** That is precisely backwards: a fleet landing 60 commits a day
into a product nobody exercises is when an end-to-end check is worth the most.

The same reasoning applies to the `telemetry` role in plans/telemetry-role.md, whose input is the
event log rather than the tree: it grows continuously whether or not main moves, so "nothing
landed" says nothing about whether there is anything to read.

**And `qa` cannot rotate its flows.** plans/qa-role.md anticipated this and accepted a weak
answer: "every tick is a fresh session with no memory of what was tested last time", solved by
telling the model to prefer "a flow not recently exercised as far as your BUGS.md filings and
Verified notes show". But a cheap flow that *passes* leaves no record at all — deliberately, so
it does not move main and wake every sleeping loop. So the only flows a fresh `qa` session can
see evidence of are the ones that failed, or the one expensive real-mode run that writes a
`## Verified` line. For the eight cheap flows in the rotation the model is choosing blind every
time, and a fresh session with an ordered list and no memory converges on the top of the list.

## The decision

Name the category the scheduler is missing: an **observer role**, whose product is an observation
rather than a commit, and for which `no_change` means "checked, all well" rather than "found
nothing to do".

- `OBSERVER_ROLES` in `src/roles.ts`: `qa` today, plus `telemetry` when it lands.
- **Observers do not climb the idle ladder.** A `no_change` tick schedules at the role's plain
  `minTickIntervalSeconds`. The *error* ladder still applies in full — a broken toolchain must
  still park an observer, exactly as it parks everything else, and that is what `ERROR_BACKOFF`
  is for. The idle ladder's stated purpose is "a loop that keeps finding nothing stops burning
  model time"; for an observer, finding nothing IS the deliverable, so the premise does not hold.
- **Observers do not defer.** Remove them from `DEFERRABLE_ROLES`. The justification for
  deferral is that a maintenance role's input is the tree, so an unmoved tree means nothing new
  to do. An observer's input is the running product (`qa`) or the event log (`telemetry`) —
  neither of which is a function of whether main moved.
- **The cadence knob is the interval, and only the interval.** With the ladder and the deferral
  both off, `minTickIntervalSeconds` becomes the honest and sole expression of how often an
  observer should look. `qa` stays at 7200 s (~2 h): about twelve end-to-end checks a day against
  a fleet landing around sixty commits a day, at one bounded flow each. That is the number to
  tune if it proves wrong, and now it is the only number.

**Why not simply make `no_change` from an observer report a different result?** Considered and
rejected. A new `TickOutcome` result (`"checked"`, say) would ripple into the dashboards, the
report's tick counting, `deferTick`, the status cells, and every test that enumerates results —
a large diff to express a property of the *role*, not of the tick. The role-set approach puts
one predicate next to the two existing ones (`DEFERRABLE_ROLES`, `BASELINE_BLOCKED_ROLES`) that
already carve roles by charter, and reads the same way.

### Relationship to the deferral latch

The latch is a live defect with its own BUGS.md entry and its own fix (the minimal one: a
deferral must not be able to preserve the very `lastResult` that causes it — e.g. a bounded
deferral count per role, after which the role ticks regardless, or making `workBacklogOpen`
insufficient on its own). **This plan is not that fix and must not be merged as a substitute for
it.** Removing three roles from `DEFERRABLE_ROLES` would rescue `qa` while leaving `perf` and
`clean` dead, and would leave the trap armed for every role still in the set. The ordering is:
fix the latch first, then land this. Both are needed — the latch is why observers are at zero
today, and this plan is why they would still be under-scheduled once it is fixed.

## Invariants

1. **The error ladder is untouched.** Only the idle branch changes, and only for observers. A
   role that cannot run its check must still back off; the 2026-09-15 outage (one broken `git`
   parking the fleet) is exactly what `ERROR_BACKOFF` protects against and nothing here weakens
   it.
2. **An observer's cost stays bounded by its interval.** With no ladder, the interval is the only
   thing standing between an observer and continuous ticking, so it must be respected exactly —
   including for `main moved` wakes, which `isEligible` already gates on `minTickIntervalSeconds`
   before anything else.
3. **The coverage ledger is runtime state, never tracked.** It lives under `.tumwater/state/`
   (gitignored) and no ledger write ever moves main. The whole reason `qa` leaves no record on a
   passing cheap flow is that a commit per check would wake every sleeping loop; a tracked ledger
   would reintroduce exactly that.
4. **The harness writes the ledger, not pi.** The role declares what it exercised through the
   reply contract; the harness records it. Consistent with the standing principle that durable
   state changes belong to the harness.
5. **A missing or corrupt ledger degrades to today's behavior.** No ledger means no injected
   coverage block and the prompt's existing "vary across ticks" guidance stands alone. An
   observer must never fail a tick because a bookkeeping file was unreadable.

## Shape

- `src/roles.ts` — `OBSERVER_ROLES`; `qa` removed from `DEFERRABLE_ROLES`; the `qa` find text
  gains the `FLOW:` contract line (2/2).
- `src/state.ts` — `applyTickOutcome` takes the observer predicate into account in its final
  `else`: observers schedule at `minTickIntervalSeconds` and leave `backoffSeconds` at 0.
- `src/scheduling.ts` — no change needed beyond `DEFERRABLE_ROLES` shrinking, which `deferTick`
  already reads. Worth an explicit test that `deferTick` returns false for every observer.
- `src/reply-contract.ts` — `extractFlow(text)`, built on the existing `labeledLine` helper that
  already serves `SUMMARY`/`WHY`/`RISK`/`VERIFIED` and `TUMWATER_REFUSED` (2/2).
- `src/qa-coverage.ts` (new) — read/write `.tumwater/state/qa-coverage.json`:
  `{ flows: { <name>: { lastRunAt, lastResult, mode } } }` (2/2).
- `src/prompt.ts` — inject the rendered coverage block into the `qa` prompt, beside the existing
  principles injection (2/2).
- `src/loop.ts` — record the declared flow at tick end (2/2).

### The coverage block

Rendered from the ledger into the `qa` prompt, oldest-first so the stalest flow leads:

```
Flow coverage (from this fleet's own record; oldest first):
  run (real)      — 6d ago, passed
  gui             — 4d ago, passed
  prompt          — 2d ago, bug filed (BUGS.md: "…")
  status          — 4h ago, passed
  tui, logs, reset-counters, init — never exercised
```

The instruction that goes with it is one line: exercise the flow at the top unless you have a
concrete reason not to. That replaces a judgment call made blind with a lookup, which is what a
mid-sized local model is reliably good at. It also makes the `run (real)` daily-cadence rule —
today enforced through a `## Verified` line the model has to find and date-compare in BUGS.md —
fall out of the same table, so the expensive mode is governed by the same mechanism as
everything else rather than by a special case in the prompt.

## Sequencing

1. **1/2 — observer scheduling.** `OBSERVER_ROLES`, the `applyTickOutcome` branch, the
   `DEFERRABLE_ROLES` removal, tests. Small and self-contained; lands after the latch fix.
2. **2/2 — the flow-coverage ledger.** The `FLOW:` reply contract, the ledger module, the prompt
   injection, tests. Depends on 1/2 only in that an observer that never ticks cannot fill a
   ledger.

## How we will know it worked

`qa` ticks per day returns to its 2 h clock (~12/day, from 0.0 today), the ledger shows every
flow in the rotation exercised within a few days rather than the same one repeatedly, and `qa`'s
share of BUGS.md attributions rises above 1 of 55. If `qa` runs at full cadence for a month and
still files nothing, the conclusion is that the flow list is checking things that do not break,
and the next move is to widen what it exercises — but that conclusion is unavailable today,
because the role has not been given the chance to be wrong.

## Deliberately out of scope

- **Fixing the deferral latch.** Separate BUGS.md entry, separate fix, lands first.
- **Making `perf`, `clean`, `organize` or `improve` observers.** They are genuinely
  tree-driven — an unmoved tree really does mean nothing new to organize — and deferral is right
  for them once the latch is gone. Widening `OBSERVER_ROLES` beyond roles whose product is an
  observation would just be a way to opt out of backoff.
- **A ledger for anything but `qa`.** `telemetry` gets its evidence from the injected digest and
  needs no coverage memory of its own.
- **Changing the qa flow list itself.** What `qa` exercises is a separate question from how often
  it gets to.
