# Observer roles — a passing check is a result, not an idle tick

Planned 2026-09-17, requested by the user, after
https://blog.detail.dev/posts/towards-self-driving-codebases/ (the blind spots an agent cannot
see are where the bugs live, so the roles that look into them are the ones that most deserve
budget). Shared architecture for the two `Observer roles N/2` entries in PLANS.md; each is
independently landable and cross-references this document. Refined 2026-09-18 (plan loop): the
deferral latch this series was ordered behind is fixed (`704139c`), so 1/2 is landable now — see
the refined note at the end.

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

### Relationship to the deferral latch — resolved, this plan is landable now

The latch was a live defect with its own BUGS.md entry; it is **fixed** (bugfix tick `704139c`,
2026-09-18: `DEFER_MAX_MS = 3 h` and `deferralExpired(s, now)` in `src/scheduling.ts` force a due
tick to run once it has been deferred past the cap, so a deferred role ticks at least once per
window and `lastResult` can no longer freeze its own precondition). The ordering this section
used to impose — fix the latch first — is therefore satisfied; the two were never substitutes and
both were needed. `perf`, `clean` and the rest of `DEFERRABLE_ROLES` are alive again under the
cap, which is what makes removing `qa` from the set a safe, independent change rather than a
rescue of one role at the others' cost.

The cap is a liveness floor, not the cadence this plan wants. With it, a deferrable role still
climbs the idle ladder toward the 10 h cap on `no_change` and is merely forced to run every 3 h:
`qa` would tick roughly 8×/day, not the ~12×/day its 2 h interval expresses, and its sleep after
a passing check would still grow monotonically until the cap intervened. This plan is what makes
`minTickIntervalSeconds` the honest cadence for a role whose `no_change` is a success.

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

- `src/roles.ts` — `OBSERVER_ROLES` (exported); `qa` removed from `DEFERRABLE_ROLES` and the
  set's doc comment updated (it currently says "exactly the nine deferrable built-ins"); the `qa`
  find text gains the `FLOW:` contract line (2/2).
- `src/state.ts` — `applyTickOutcome` takes the observer predicate into account in its final
  `else`: observers schedule at `minTickIntervalSeconds` and leave `backoffSeconds` at 0. The
  `user_aborted` arm (a deliberate operator stop, not a passing check) keeps its idle backoff for
  every role — the predicate is scoped to the final `else` only.
- `src/scheduling.ts` — no change needed beyond `DEFERRABLE_ROLES` shrinking, which `deferTick`
  already reads. Note `deferTick` now takes a fifth argument, `now: number` (`704139c`), so the
  new "returns false for every observer" tests must pass it.
- `src/reply-contract.ts` — `extractFlow(text): { flow: string; result: "passed" | "bug" } | null`,
  built on the existing `labeledLine` helper that already serves
  `SUMMARY`/`WHY`/`RISK`/`VERIFIED` and `TUMWATER_REFUSED`. The line is
  `FLOW: <name> — <passed|bug>`; a bare `FLOW: <name>` is tolerated as `passed`. The result token
  is load-bearing: `run (real)` commits its `## Verified` note, so deriving "bug" from "the tick
  changed files" would mislabel a passing real run (2/2).
- `src/qa-coverage.ts` (new) — the ledger and its rendering: `readQaCoverage(root)`,
  `recordFlow(root, flow, result, summary?, now?)`, `renderCoverageBlock(coverage, now)`, the
  `QA_FLOWS` universe constant, and a few local age-formatting lines. Schema
  `{ flows: { <name>: { lastRunAt: number; result: "passed" | "bug"; summary?: string } } }` at
  `.tumwater/state/qa-coverage.json` — no `mode` field: the flow name itself distinguishes
  `run (real)` from `run`. Reads via `readJsonFile`, writes via `writeJsonAtomic`, both in
  `src/json-files.ts` (2/2).
- `src/paths.ts` — `qaCoveragePath(root)` beside `statePath` (line 26):
  `path.join(tumwaterDir(root), "state", "qa-coverage.json")` (2/2).
- `src/prompt.ts` — `TickPromptInput` gains `coverage?: string`; `buildTickPrompt` pushes it
  immediately after the principles block (line 169), beside that existing injection (2/2).
- `src/loop.ts` — `tickPrompt()` (line 143) renders the block for `qa` only
  (`this.role === "qa" ? renderCoverageBlock(readQaCoverage(this.root), Date.now()) : undefined`)
  and passes it to `buildTickPrompt` (line 160). After the pi run (line 590), `runTick` extracts
  the flow once; the `no_change` return (line 655) and the `queued` return (line 747) call
  `recordFlow` before returning. Error/aborted/quiet_killed/refused paths record nothing (2/2).

### The coverage block

Rendered from the ledger into the `qa` prompt, never-exercised flows first (age = ∞), then
exercised flows oldest-first, so the stalest work leads:

```
Flow coverage (from this fleet's own record; least recently exercised first):
  tui, logs, reset-counters, init — never exercised
  run (real)      — 6d ago, passed
  gui             — 4d ago, passed
  prompt          — 2d ago, bug filed (BUGS.md: "…")
  status          — 4h ago, passed
```

The ordering is load-bearing, not cosmetic: the instruction that goes with the block is one line
— exercise the flow at the top unless you have a concrete reason not to — so a never-exercised
flow must sort first for the eight cheap flows to enter the rotation at all. (The original
draft's example listed them last, which would have made its own instruction unexercisable;
corrected here.) The age formatter is a few local lines in `qa-coverage.ts` (`6d`/`4h`/`12m`),
not `src/ui/status-render.ts`'s `ago()` — core modules do not import the UI layer. That replaces
a judgment call made blind with a lookup, which is what a mid-sized local model is reliably good
at. It also makes the `run (real)` daily-cadence rule —
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

## Refined 2026-09-18 (plan loop)

Audited against main `bb8dc26` (the README's stamp is one merge behind at `c53dba4`; the two
landings since are `704139c` — the deferral-latch fix this series was ordered behind — and
`bb8dc26`, the red-main-latch fix, neither of which touches 2/2's anchors). No audit had run since
`9d679ad` wrote this document on 2026-09-17, and the latch fix landed in between. The capability is
confirmed absent: `grep -rn OBSERVER src/ test/` is empty, and `qa` is still in
`DEFERRABLE_ROLES`.

Verified on this tree:

- `src/roles.ts` — `DEFERRABLE_ROLES` at line 272 (`qa` at 279), the doc comment above it reading
  "exactly the nine deferrable built-ins"; `WORK_ROLES` at 268; `BASELINE_BLOCKED_ROLES` at 300
  (does not contain `qa`); the `qa` role at 185, whose find text already tells the model to
  "prefer a flow not recently exercised, as far as BUGS.md filings and Verified notes show" —
  exactly the blind lookup 2/2 replaces.
- `src/state.ts` — `applyTickOutcome` at 185; its final `else` (the idle branch) at 268–270 is
  `nextBackoffSeconds(s.backoffSeconds, cfg.idleBackoff)` then `nextRunAt = now + backoff`, which
  is what observers must bypass. `state.ts` already imports from `roles.js` (`DIRECTOR_ROLE`, line
  4), so `OBSERVER_ROLES` joins that import with no new edge and no cycle.
- `src/scheduling.ts` — `deferTick` at 121 now takes a fifth argument, `now: number` (`704139c`),
  and ANDs `!deferralExpired(s, now)`; `DEFER_MAX_MS` (98) and `deferralExpired` (105) are the
  latch fix. The single production caller is `src/orchestrator.ts:684`. No change is needed here
  beyond `DEFERRABLE_ROLES` shrinking, as the Shape bullet says — but every new `deferTick` test
  must pass `now`.
- `src/config.ts` — `roles.qa = { enabled: true, minTickIntervalSeconds: 7200 }` at line 21, so
  the plan's ~12-checks/day premise holds.
- Tests — `deferTick`'s unit tests live in `test/orchestrator.test.ts` (222, 246, and the new
  `DEFER_MAX_MS` regression at 269), **not** in a `test/scheduling.test.ts` — that file does not
  exist. `applyTickOutcome`'s tests are in `test/state.test.ts` (332 onward); the baseline-exempt
  assertion is `test/roles.test.ts` 46–48. Files touched is corrected in PLANS.md accordingly.

Corrections:
1. **The ordering gate is satisfied; the section above now records the latch as fixed.** The old
   text told the implementer to land the latch first, which reads as a blocker on a fix that
   already landed. Rewritten to record `704139c` and to state what this plan still adds on top of
   it: the cap forces a run every 3 h but leaves the idle ladder and the deferral episode intact,
   so `minTickIntervalSeconds` is still not the honest cadence for an observer.
2. **The test file was wrong.** `test/scheduling.test.ts` does not exist; the `deferTick` cases
   belong in `test/orchestrator.test.ts` beside the existing ones. The acceptance criterion's
   "returns false for every observer under every input" becomes one more case in the existing
   loops there (which already assert non-deferral for `feature`/`bugfix`/`plan`/`director`/custom)
   plus `qa`, passing `now`.
3. **`deferTick`'s signature gained `now` (`704139c`).** Pinned so the new tests pass it; the
   plan's scheduling shape is otherwise unchanged.
4. **The `DEFERRABLE_ROLES` doc comment must move with the set.** It says "exactly the nine
   deferrable built-ins" and lists the roles; removing `qa` makes it eight. One-line edit in
   `src/roles.ts`.
5. **The observer predicate is scoped to the final `else` only.** The `user_aborted` arm also
   schedules on the idle ladder, but it is a deliberate operator stop rather than a passing
   check; it is left unchanged for every role. This closes the only place a literal reading of
   "observers do not climb the idle ladder" could over-reach.

Sizing unchanged: `src/roles.ts` ~6 lines (the set, its comment, the export); `src/state.ts` ~4
(the observer branch in the final `else`); tests ~25 across `test/state.test.ts` and
`test/orchestrator.test.ts`. One run. No design question remains open.

## Refined 2026-09-18 (plan loop) — 2/2 audit

The 1/2 note above audited the scheduler half only; 2/2's anchors were never verified. Audited
against main `a3b5138` (the README's stamp is four merges behind at `c53dba4`; the landings since
— `8a3e6a1` merge-queue 5/5, `a3b5138` the quiet-kill bugfix, and the markdown commits — touch
no 2/2 anchor). The capability is confirmed absent: `grep -rn 'qa-coverage\|renderCoverage\|recordFlow\|QA_FLOWS\|extractFlow' src/ test/` is empty, and `FLOW:` appears nowhere in the
role texts.

Verified on this tree:

- `src/reply-contract.ts` (75 lines) — `labeledLine(text, label)` at line 28 is exactly the helper
  the plan assumes: `^\s*<label>:\s*(.+)\s*$` with the `m` flag, returning the trimmed remainder
  or null. `extractRefusal` (line 37) is the precedent for a thin wrapper. The `FLOW` label is
  literal text, so there is no regex-escaping concern.
- `src/prompt.ts` — `interface TickPromptInput` at 142 (fields
  `role`/`initialPrompt`/`principles?`/`extraInstructions?`); `buildTickPrompt` at 163; the
  principles push at 169 (`if (principles) parts.push(principlesBlock(principles));`). The
  coverage push goes on the next line, before `parts.push(...role.find...)` at 170.
- `src/loop.ts` — `tickPrompt()` at 143, its `buildTickPrompt({...})` call at 160 (where
  `coverage` joins `extraInstructions`); `runTick` at 515, the pi run at 590
  (`const pi = await this.runRolePi(...)`), the `no_change` return at 655, the `queued` return at
  747. `this.root` and `this.role` are in scope at both returns, so `recordFlow` needs no new
  plumbing and `TickOutcome` need not widen.
- `src/paths.ts` — `tumwaterDir(root)` at 6; `statePath(root, role)` at 26 is the exact idiom
  `qaCoveragePath` copies; the state dir already holds `orchestrator.json`/landing markers, and
  `writeJsonAtomic` creates the parent, so no directory setup is needed.
- `src/json-files.ts` — `readJsonFile<T>` at 15 returns null on missing/torn; `writeJsonAtomic`
  at 43 is the per-pid tmp+rename writer. Both are what invariant 5 needs.
- `src/roles.ts` — the `qa` role at 185; its find text currently says "prefer a flow not recently
  exercised, as far as BUGS.md filings and Verified notes show" — the blind lookup this replaces.
- plans/qa-role.md — line 53 fixes the ordered flow universe
  `init → status → logs → prompt → reset-counters → gui → tui → run`, which `QA_FLOWS` mirrors;
  `run (real)` (line 63) is the expensive variant.
- Tests — `test/reply-contract.test.ts` (`labeledLine`/`extractRefusal` cases at 23–37),
  `test/prompt.test.ts` (the qa prompt contract at 578), `test/paths.test.ts`, `test/loop.test.ts`
  (the fake-pi shim loop harness), and `test/json-files.test.ts` all exist;
  `test/qa-coverage.test.ts` is new.

Pinned (open questions closed):

1. **The result token.** `FLOW: <name>` alone could not distinguish a passing real run (which
   commits its `## Verified` note) from a filed bug (which commits a BUGS.md entry) — both change
   files. The line becomes `FLOW: <name> — <passed|bug>`; `extractFlow` splits on the final
   em-dash/`- ` token and tolerates a bare name as `passed`. The role, not the harness, states
   the outcome; the harness stays dumb.
2. **The flow universe.** "Never-exercised flows listed last" needs a known list; pinned to
   `QA_FLOWS` in `src/qa-coverage.ts`, mirroring plans/qa-role.md's ordered list plus
   `run (real)`. The block's rows are `QA_FLOWS ∪ Object.keys(coverage)`.
3. **Ordering corrected.** The draft's example listed never-exercised flows last while its
   instruction said "exercise the flow at the top" — self-defeating. Pinned: never-exercised
   first, then exercised oldest-first. The acceptance criterion is updated in PLANS.md.
4. **The age formatter stays in core.** `src/ui/status-render.ts`'s `ago()`/`humanSeconds` are
   the only existing age helpers, but importing UI into `src/` inverts the layering; a few local
   lines in `qa-coverage.ts` (`6d`/`4h`/`12m`) are pinned instead.
5. **Recording seam.** `runTick` extracts the flow once after the pi run and records it at the
   two success returns (`no_change`, `queued`) only; `error`/`aborted`/`quiet_killed`/`refused`
   record nothing, so an interrupted check never advances the ledger.

Sizing: `src/qa-coverage.ts` ~110 lines (schema, read/record/render, age, `QA_FLOWS`);
`src/reply-contract.ts` ~10 (`extractFlow`); `src/paths.ts` ~4; `src/prompt.ts` ~3;
`src/loop.ts` ~8; `src/roles.ts` ~4; tests ~120 across `test/qa-coverage.test.ts` (new),
`test/reply-contract.test.ts`, `test/prompt.test.ts`, `test/paths.test.ts`, `test/loop.test.ts`.
One run. No design question remains open.
