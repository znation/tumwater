# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Work ratio, part 1a/4: the maintenance allowance — window counts, the verdict and the `maintenancePerWorkLanding` setting (planned 2026-10-08 by operator; split 2026-10-08 by operator from part 1/4, which feature passed over as too big)

Design: plans/work-ratio.md ("Maintenance follows work").

Context. On 10-07 the fleet landed 335 commits for 22 plans and 28 bugs. 271 of those commits
came from the code-maintenance roles; clean alone landed 118, averaging 8 lines each.

`deferTickReason` (src/scheduling/scheduling.ts) only holds a maintenance role after a
`no_change` tick, so a role that always finds something never yields. Part 1a builds the
arithmetic and the setting with no scheduling effect. Part 1b puts it in front of the scheduler.

**Approach.**
1. **Tier.** Count by `commitTier` (src/roles/roles.ts, added by Work ratio 4/4):
   - `"work"` (feature, bugfix, director) is the work count;
   - `"maintenance"` (code-maintenance roles plus readme) is the maintenance count.
   - Update `commitTier`'s doc comment: it is now the one home of the split that both the report
     and the quota use, and it no longer predates 1/4.
   - steward, observers, plan and custom roles are never counted or held.
2. **Window.**
   - A new src/gates/maintenance-quota.ts counts `merged` events by tier over the rolling 24 h
     ending `now`: `{ work, maint }`.
   - Read them through the existing windowed event reader (src/events/event-window.ts) with an
     incremental cache, so a poll folds only newly appended lines and does not re-parse the
     whole log. Reuse report-data's fold cache if it fits; do not write a third log parser.
3. **Verdict.** Add a pure `maintenanceQuota({ work, maint, inFlight, perWorkLanding })` that
   returns `{ allowance, used, held }`, where:
   - `allowance = perWorkLanding × work + MAINTENANCE_DAILY_FLOOR` (an exported constant, 12);
   - `used = maint + inFlight`;
   - `held = used >= allowance`.
4. **Config.**
   - Add top-level `maintenancePerWorkLanding`: a number ≥ 0, default 2.
   - Wire it through src/config/config-schema.ts, config.ts, config-field-checks.ts and
     config-editable-keys.ts, so `tumwater config set` can edit it live.
   - There is no switch to turn it off. A large value effectively disables it, per PRINCIPLES.md's
     "opinionated defaults".
   - Document it in README.md's config reference. Say that part 1b makes it hold loops; until
     then it is computed but not enforced.

**Files touched.**
- src/gates/maintenance-quota.ts (new)
- src/roles/roles.ts (doc comment only)
- src/config/config-schema.ts, config.ts, config-field-checks.ts, config-editable-keys.ts
- README.md

Tests:
- test/maintenance-quota.test.ts (new)
- config validation cases

**Acceptance criteria.**
- **Allowance.** `maintenanceQuota({work: 10, maint: 32, inFlight: 0, perWorkLanding: 2})` is
  `{allowance: 32, used: 32, held: true}`. With `maint: 31` it is not held.
- **Floor.** With `work: 0`, the allowance is 12.
- **Window.** In a fixture log with 3 feature, 1 director, 5 clean, 2 readme, 1 steward and
  2 plan merges inside the last 24 h, plus 4 clean merges older than 24 h, the count is
  `{work: 4, maint: 7}`.
- **Incremental.** After appending one clean merge, a second count is `{work: 4, maint: 8}`,
  and it reads only the appended bytes (assert through the cache, not timing).
- **Config.** `maintenancePerWorkLanding: -1` and `"2"` fail validation with a field error, and
  `tumwater config set maintenancePerWorkLanding 3` is accepted.
- `npm run test` green.

### Work ratio, part 1b/4: the scheduler holds maintenance loops past their allowance (planned 2026-10-08 by operator; split 2026-10-08 by operator from part 1/4; requires part 1a/4 landed)

Design: plans/work-ratio.md ("Maintenance follows work").

**Approach.**
1. **Gate.**
   - Add `newMaintenanceQuotaGateState()` and `pollMaintenanceQuotaGate(...)` to
     src/gates/maintenance-quota.ts, modeled on src/gates/role-cap-gates.ts. The poll returns the
     set of held loop ids: every enabled loop whose `commitTier` is `"maintenance"` while 1a's
     verdict says held, and none otherwise.
   - `inFlight` is the number of maintenance-tier loops currently running a tick or holding a
     queued landing. Six concurrent permits cannot overshoot the allowance.
   - Register the gate in `FleetGateStates` / `pollFleetGates` (src/gates/gate-polls.ts).
   - Check it in `pollRunnerReasons` (src/orchestrator/orchestrator-scheduling.ts) right after
     `capPaused`.
2. **Override.** A fresh operator wake (`wokenAt` newer than the last tick end) or a queued
   prompt for that loop admits one tick anyway. This is the same demand override
   `deferTickReason` honors.
3. **Events.**
   - Log `maintenance_quota_hold` {work, maint, allowance} when the gate goes from open to held.
   - Log `maintenance_quota_resumed` when it re-opens. Both are fleet-level, logged once per
     transition and not per loop.
   - Add both to src/events/events.ts and src/events/event-format.ts.
4. **Status.**
   - Held loops show `held: maintenance quota <used>/<allowance>` wherever `capPaused` shows
     today: src/status/status-data.ts and its TUI/GUI renderers.
   - Add a `maintenanceQuota` field to the status payload, the same shape as `capPaused`.
   - Update README.md's config reference: the setting now holds loops.

**Files touched.**
- src/gates/maintenance-quota.ts
- src/gates/gate-polls.ts
- src/orchestrator/orchestrator-scheduling.ts, orchestrator.ts
- src/events/events.ts, event-format.ts
- src/status/status-data.ts and its renderers
- README.md

Tests:
- cases in test/maintenance-quota.test.ts
- cases in test/orchestrator-scheduling.test.ts

**Acceptance criteria.**
- **Held.** With 10 work merges and 32 maintenance merges in the last 24 h, clean, dry and
  readme are held. feature, bugfix, plan, steward, qa and telemetry tick normally.
- **Window.** When a maintenance merge ages past 24 h, the gate re-opens with one
  `maintenance_quota_resumed` event.
- **In-flight.** With an allowance of 1 more than `maint`, two due maintenance loops start at
  most one tick between them.
- **Override.** `tumwater wake clean` while held runs exactly one clean tick.
- **Live.** `tumwater config set maintenancePerWorkLanding 100` lifts the hold on the next poll.
- `npm run test` green.

### Work ratio, part 2/4: a clean tick sweeps one kind of drift across the tree instead of one site (planned 2026-10-08 by operator; trimmed 2026-10-08 by operator — the PRINCIPLES.md amendment it needed landed separately, since feature may not edit that file)

Design: plans/work-ratio.md ("Batch hygiene").

Context. On 10-07 clean's 118 commits averaged 1.1 files and about 15 changed lines. Five
separate ticks fixed the same stale `_land-<role>` comments left by Worktree pool 2d/5
(814074e2, 808f4b85, 888f9d73, 5913a6a1, 6ce40875). Each one cost a tick, a review, a build
check and a landing.

dry's charter already updates every call site of one repetition. clean's says "find ONE piece
… clean that one thing", so this entry changes clean.

The principle is already in place: PRINCIPLES.md's "one focused change per tick" bullet, and
its starter-template copy in src/init/init-templates.ts, now say a focused change is one theme
applied everywhere it holds, not one site. This entry changes no PRINCIPLES.md text.

**Approach.**
1. **Charter.**
   - Rewrite clean's `find` text in src/roles/role-catalog.ts (the "Otherwise, find ONE piece of
     unclean code" paragraph). The new rule: pick ONE *kind* of uncleanliness, grep for every
     instance of it across the source, tests and markdown, and fix them all in this tick.
   - Examples of a kind:
     - comments that still name a removed mechanism;
     - over-100-column doc lines in one directory;
     - doc comments citing a renamed helper.
   - Keep the diff under about 300 changed lines. When a kind has more instances than that,
     clean one directory or subsystem completely and say in the WHY what remains.
   - Keep the `<backlog-structure>` repair paragraph as is.
2. **Review.**
   - The review prompt must not reject a clean sweep for touching many files, as long as every
     hunk is the same kind of fix.
   - Check src/review's prompt text for a size or scope objection that would fire, and adjust
     it only if one exists.

**Files touched.**
- src/roles/role-catalog.ts
- review prompt text, only if needed
- tests that pin charter text

**Acceptance criteria.**
- clean's charter names a kind-wide sweep with the ~300-line ceiling. The phrase "clean that
  one thing" is gone.
- `npm run test` green.
- Follow-up check, a day after landing: clean's average changed lines per commit rises and its
  commits per day fall (`git log --grep '^tumwater(clean)' --shortstat`). Record the numbers
  in plans/work-ratio.md.

### Split the LoopRunner tick pipeline out of src/loop/loop.ts (planned 2026-10-08 by organize)

Design principle: a file with too many responsibilities should be divided along the seams it already
has. This is a code move plus the context each phase needs — no behavior change.

Context. `src/loop/loop.ts` is 949 lines, the largest module in the tree (next: redeployer.ts at
600). It is one class whose methods already fall into four concerns:

- runner lifecycle and public surface: the constructor and fields, `save`, `warn`,
  `resetCounters`, `wake`, `abortTick`, `handBackTick`, `tickModel`, `runConfig`, `runProvider`,
  `runSignal`, `tickPrompt`, and the landing faces `runLandingPi`, `runGatePi`, `foldUsage`,
  `foldLandingUsage`;
- the tick pipeline: `tick` (:445), `runTick` (:608), `runTickInLease` (:644),
  `checkoutRoleBranch` (:685), `tickWithWorktree` (:695, ~193 lines — the largest method, doing
  worktree setup, leftover recovery, red-main gating, conflict hand-back, revision apply, the
  authoring run, and result dispatch in one body), and `handlePiResult` (:889);
- recovery/landing bookkeeping: `finishAbortedTick` (:290), `pinAndReset` (:337),
  `finishRecoveryTick` (:361), and the `recoveryFailure` field (:132) that exists only to carry a
  value from `finishRecoveryTick` to `tick`;
- model-fallback integration: `foldModelFallback` (:542) and `emitFallbackEnded` (:592).

The other loop concerns are already split out — `loop-pi.ts` (428), `loop-state.ts` (388),
`model-fallback.ts` (131), `leftover.ts` (182), `revision.ts` (77). What remains is orchestration
glue; it is cohesive but too large to hold in view, and its phases are discoverable only by
scrolling. This continues the same incremental shrink of loop.ts that produced loop-pi.ts and
loop-state.ts, judged on the end state rather than one move.

Goal. Keep `LoopRunner` as the orchestrator's handle, but move the tick pipeline, the recovery
helpers, and the fallback integration into their own modules, each taking an explicit context —
the shape `src/tick/tick-stage.ts`, `tick-verdict.ts`, and `tick-finalize.ts` already use.

**Target structure.**
- `src/loop/loop.ts` (~300 lines): the class. Constructor and fields; the lifecycle methods above;
  and `tick` as the thin entry that assembles the phase context, calls the pipeline, and calls
  `finalizeTick`.
- the new `loop-tick.ts` beside it: the bodies of `runTick`, `runTickInLease`,
  `checkoutRoleBranch`, `tickWithWorktree`, and `handlePiResult`, as context-taking functions
  (`runTickPhase`, `handlePiResultPhase`, and their private helpers). The context carries root,
  role, mainBranch, baseRole, the live config, the shared `state`/`usage`/`pending` objects, the
  `pi` plumbing, and the `save`/`warn` callbacks.
- the new `loop-recovery.ts`: `finishAbortedTickPhase`, `pinAndResetPhase`, and
  `finishRecoveryTickPhase`. `finishRecoveryTickPhase` takes a `setRecoveryFailure` callback
  instead of reaching into a runner field; `LoopRunner` keeps the field so `tick` still passes it
  to `finalizeTick`, unchanged.
- the new `loop-fallback.ts`: `foldModelFallbackPhase({root, role, state, save}, ctx, pi)`
  and the private `emitFallbackEnded` it shares with the config-dropped-pair path. The pure state
  machine stays in `model-fallback.ts`. While moving, the `wasIn && !willBeIn` branch of
  `foldModelFallback` should call the shared `emitFallbackEnded` helper instead of re-inlining the
  same `model_fallback_ended` event (the helper exists for both ending paths, but only the
  config-dropped path calls it today) — a no-op refactor, not an event-shape change.

**Test seams to preserve.** Tests monkeypatch or read these; each keeps its name and place on the
class as a thin delegate to the phase function:
- `runner.runTick` — overridden in `test/loop.test.ts` (:400, :446) to bypass the pipeline;
- `runner.pending` — read in `test/loop-5.test.ts` (:202);
- `runner.state`, `runner.tick`, `runner.abortTick`, `runner.handBackTick`, `runner.tickModel`,
  `runner.runConfig`, `runner.runProvider`, `runner.resetCounters`, `runner.wake`, `runner.config`,
  `runner.root`, `runner.role`, `runner.lastRateLimit`, `runner.lastBackendFailure` — the public
  surface the orchestrator and tests use.

**Files touched.**
- `src/loop/loop.ts`, plus the new `loop-tick.ts`, `loop-recovery.ts`, and
  `loop-fallback.ts` beside it.
- `DEVELOPMENT.md`: the `src/loop/loop.ts` Layout bullet gains the new companions.
- New focused tests only where a moved pure helper needs one; the existing loop suite is the
  regression net and must pass unchanged.

**Acceptance criteria.**
- `src/loop/loop.ts` is under ~350 lines and contains no `tickWithWorktree` or `handlePiResult`
  body.
- No behavior change: `npm run test` green with no test edits beyond type-only import updates;
  the seams above are intact.
- `grep -rn` over `src`, `test`, and the markdown finds no stale reference to a moved method name
  or a pre-move path.
- `npm run test` green.

### Parallel work instances, part 7/7: keep permit headroom for work loops that have work to take (planned 2026-10-07 by operator; requires part 5b/7 landed)

Design: plans/parallel-work-instances.md ("Priority headroom").

Context: the semaphore (src/concurrency/semaphore.ts) orders *waiters* by tier, but it never
preempts. With several work instances, maintenance ticks can take every free permit in the gap
before a work instance becomes due. The work tick then waits a full maintenance tick. Holding a
small reserve only while work is actually waiting keeps that latency off the work tier without
idling permits when every work loop is busy. Before implementing, check `parkedSince` on work
rows since 5/7 landed: if work loops never park, refuse this entry as unneeded.

**Approach.**
1. **Reserve.** `Semaphore.setReserve(n)`. A tier ≥ 1 acquirer or waiter is granted only while
   `inUse < capacity − n`, in both `acquire`'s fast path and `grantNextWaiter`. Tiers ≤ 0
   (work, `LANDING_TIER`, `MERGE_TIER`) are unaffected.
2. **Sizing.** Each poll, the orchestrator (src/orchestrator/orchestrator.ts) sets
   `n = min(floor(maxConcurrent / 3), count of work-tier loops that are loopEnabled, not
   running, have no queued landing, and either hold a claim or have an unclaimed eligible
   entry)`. The counting helper sits in src/scheduling/claims.ts. When `n` changes, call
   `setReserve`, which re-runs `grantNextWaiter` so a lowered reserve admits waiters.
3. **Event.** Log a `permit_reserve` event when `n` changes from 0 or to 0.

**Files touched.** src/concurrency/semaphore.ts, src/orchestrator/orchestrator.ts,
src/scheduling/claims.ts, src/events/events.ts, src/events/event-format.ts. Tests: cases in
test/semaphore.test.ts and an orchestrator scheduling test.

**Acceptance criteria.**
- **Reserve held.** With `maxConcurrent: 6`, reserve 2 and four maintenance ticks running, a
  fifth maintenance acquirer parks, and a work acquirer is granted at once.
- **Reserve zero.** When every work loop is running or landing, maintenance can fill all six
  permits.
- **Vets.** A vet at `LANDING_TIER` is never held by the reserve.
- `npm run test` green.


## Done

### Parallel work instances, part 6/7: show instances and claims on status, TUI, GUI, logs and doctor (planned 2026-10-07 by operator; split 2026-10-08 by plan; requires part 5b/7 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("Observability").

**Goal.** An operator can see which instance holds which entry, and why an extra instance is
idle.

**Approach.**
1. **Status.** `loopStateForPoll` rows (src/status/status-data.ts) carry `claim` (the title)
   and `instanceOf` (the base role). `tumwater status --json` and `/api/status` serve them.
2. **TUI and GUI.**
   - src/ui/status-model.ts and src/ui/status-render.ts show the claim as the row's work text
     while the row is idle or landing.
   - An idle extra instance with no claim reads `idle — no unclaimed <plans|bugs>`.
   - src/ui/gui/gui-client-loops.ts uses the claim when `currentWork` is empty.
3. **Logs.** src/events/event-format.ts renders `claim` events: `assigned "<title>"` and
   `released "<title>" (<reason>)`.
4. **Doctor.** `checkWorkInstances` (src/doctor/doctor-checks.ts) warns on:
   - a claim whose key is no longer listed;
   - a claim older than 24 h;
   - `instances > 1` with `worktreeSlots` below `maxConcurrent`.
5. **Docs.** docs/how-it-works.md covers instances, claims, the scaling rule and the plan
   target.

**Files touched.** src/status/status-data.ts, src/ui/status-model.ts,
src/ui/status-render.ts, src/ui/gui/gui-client-loops.ts, src/events/event-format.ts,
src/doctor/doctor-checks.ts, src/doctor/doctor.ts, docs/how-it-works.md. Tests: cases in the
status, status-render, event-format and doctor tests.

**Acceptance criteria.**
- **Rows.** A fabricated `feature-2` state with a claim shows the claimed title in
  `status --json`, the TUI row and the GUI row.
- **Logs.** `tumwater logs` renders one line per `claim` event.
- **Doctor.** It warns on a 25 h-old claim and on a claim whose entry is gone.
- `npm run test` green.

### Worktree pool, part 5/5: slot waits, slot display, doctor check and docs (planned 2026-10-06 by operator; requires parts 4a/5, 4b/5 and 4c/5 landed; done 2026-10-08 by feature)

Design: plans/worktree-pool.md ("Observability").

**Goal.** Give the operator what they need to size `worktreeSlots` and spot stuck pins.

**Approach.**
1. **`slot_wait` event.** Logged when a lease waited 30 s or more. It carries role, purpose,
   waitedMs, slots and pinned. Add it to src/events/events.ts and src/events/event-format.ts.
2. **Status and GUI.** `tumwater status` and the GUI role rows show which slot a running tick
   or vet holds, and any pin, read from slots.json.
3. **Doctor.** Add `checkWorktreePool` to src/doctor/doctor-checks.ts. It lists slots, leases
   and pins, and warns on:
   - a legacy non-director `<role>` directory or a `_land-*` directory still present;
   - a pin older than 24 h, which usually means a paused role holding a checkout.
4. **Docs.** docs/how-it-works.md describes slots, `worktreeSlots`, the dedicated `director`,
   `_merge` and `_gate-main` checkouts, and how to size a disk: about (`worktreeSlots` + 3)
   warm checkouts.

**Files touched.** src/git/worktree-pool.ts, src/events/events.ts, src/events/event-format.ts,
src/status/status-data.ts, src/ui/status-model.ts, src/ui/status-render.ts,
src/ui/status-payload.ts, src/ui/gui/gui-client-loops.ts,
src/doctor/doctor-checks.ts, src/doctor/doctor.ts, docs/how-it-works.md. Tests: cases in the
pool, event-format, status and doctor tests.

As landed, the doctor's pin-age warning needed a timestamp the slot record did not carry, so
`SlotRecord.pinnedAt` (optional) was added in src/git/slots-state.ts and set where the pool pins
(worktree-pool.ts, retire.ts); a record written before the field warns no age. The display rides
the shared `slotSuffix` (status-model.ts) in the terminal state cell, plus `slot`/`slotPinned`
on the status payload for the GUI tag.

**Acceptance criteria.**
- **Wait event.** A lease that waited 31 s logs one `slot_wait`. A lease that waited 1 s logs
  none.
- **Display.** Status and GUI show the slot of a running tick.
- **Doctor.** It warns on a 25 h-old pin and on a leftover `_land-feature` directory.
- `npm run test` green.

### Worktree pool, part 4c/5: retire legacy role worktrees at orchestrator start (planned 2026-10-06 by operator; split 2026-10-07 by plan; replanned 2026-10-08 by plan after two review rejections; requires parts 2a/5, 3/5, 4a/5 and 4b/5 landed; done 2026-10-08 by feature)

Design: plans/worktree-pool.md ("Role ticks lease slots", "Legacy role worktrees").

**Context.** Once role ticks lease slots (4b/5), the old `.tumwater/worktrees/<role>`
directories are dead weight and the Part 5/5 doctor check warns on them. A one-time startup
migration must retire them without losing a pending resume or leaving a checkout pinned for a
role that no longer runs. It lands after 4b/5 so it can never remove a slot a tick still uses.

**Timing (corrected).** `runOrchestrator` constructs every `LoopRunner`
(`src/orchestrator/orchestrator.ts`, `const runners = enabled.map(...)`) before this migration
runs, and only then starts ticks. The loop constructor (`src/loop/loop.ts`) infers `resumePending`
from a persisted `running` flag but writes that inference only in memory — it does not save it —
so at migration time `loadLoopState` still reports the on-disk `running: true`. The migration must
therefore read both flags, and its comment and the design doc must say it runs after that
construction but before any tick can call `leaseSlot` — not "before any loop is constructed."

**Approach.**
1. Add `retireLegacyRoleWorktrees(root, configured)` to `src/git/worktree-pool.ts` and call it
   from `runOrchestrator` right after `removeLegacyLandWorktrees`, before the `RetentionPruner`
   construction and before ticks start. Pass every configured loop id (`loopIds(config)`), never
   the run's filtered `enabled`/`--once --role` set, so a scoped run cannot lose another role's
   pending resume. Return early when `.tumwater/worktrees/` does not exist.
2. Enumerate subdirectories of `.tumwater/worktrees/` (`worktreesDir`); a candidate legacy role
   dir is one whose basename is not `DIRECTOR_ROLE` and does not start with `_` (`_slot-<n>`,
   `_merge`, `_gate-main` and `_main` are skipped).
3. For each candidate, read `loadLoopState(root, role)` and set
   `resumable = state.resumePending === true || state.running === true`.
   - **Resumable and `configured.includes(role)`:**
     - If the role already owns a slot (`slot.pinnedFor === role`, or
       `slot.lease?.role === role && slot.lease.purpose === "tick"`), the resume happens there:
       drop any record for the legacy path, pin that owned slot for the role when it had only a
       tick lease, and `removeWorktree(root, role)` the legacy dir.
     - Otherwise register the legacy dir in slots.json as
       `{ dir, lease: null, pinnedFor: role, lastRole: null, lastReleasedAt: null }`, so the next
       tick leases it (4a's `keep`) and resumes in place.
   - **Not resumable, or the role is not configured:** drop any record for the legacy path and
     `removeWorktree(root, role)` (src/git/worktree.ts); the branch keeps any commit.
4. In the same `updateSlotsState` pass, retire pins for roles that no longer run: for every slot
   whose `pinnedFor` names a role outside the configured set, clear the pin; when that slot's `dir` is not a
   canonical `slotWorktreePath(root, n)`, drop the record and add the dir to the removal list
   (`removeDroppedSlots`). A paused or removed resumable role therefore cannot leak a permanently
   pinned legacy checkout.
5. Teach the pool to retire a migrated legacy slot: in `releaseSlot`
   (src/git/worktree-pool.ts), when a slot's `dir` is not a canonical
   `slotWorktreePath(root, n)` and it is being unpinned, drop its record and return its dir in
   the to-remove list, so `leaseSlot` removes the directory once the role is done
   (`removeDroppedSlots`).

**Files touched.** src/git/worktree-pool.ts, src/orchestrator/orchestrator.ts,
plans/worktree-pool.md. Tests: startup-migration cases in test/worktree-pool.test.ts and an
orchestrator test.

**Acceptance criteria.**
- A clean legacy `.tumwater/worktrees/feature` (role enabled, not resumable) is gone after
  startup; its branch and commit survive.
- An enabled role whose persisted state has `resumePending` **or** `running: true` and that owns
  no slot gets its legacy dir registered as a pinned slot, serves exactly one resume in the same
  directory, and both the slot record and the directory are gone after the first release that
  unpins it.
- An enabled resumable role that already owns a tick-lease slot keeps no legacy record, has its
  legacy dir removed, and the owned slot is pinned for the role.
- A resumable-but-disabled role's legacy dir is removed and never pinned; after startup no slot's
  `pinnedFor` names a role outside the configured set.
- The migration leaves `director` and every `_`-prefixed directory untouched.
- `npm run test` green.

### New-project bootstrap, part 2/2: while bootstrapping, only plan, feature, director and bugfix-with-open-bugs tick (planned 2026-10-08 by operator; requires part 1/2 landed; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("New-project bootstrap").

**Approach.**
1. **Gate.**
   - Add a new src/gates/bootstrap-gates.ts, polled from `pollFleetGates` like the role-cap gate.
   - Bootstrap is active while `config.bootstrap` is set and the latch file
     `.tumwater/bootstrap-complete.json` is absent. Put the path helper in src/paths.ts.
   - While active, every loop is held with reason `bootstrap`, except:
     - plan, feature and director;
     - bugfix, only while BUGS.md `## Open` is non-empty (`openBugs`). Its latent-bug search is
       maintenance.
   - Check the gate in `pollRunnerReasons` next to `capPaused`. A fresh operator wake or a
     queued prompt still admits a held loop's tick.
2. **Progress and latch.**
   - Each poll, count the `### ` headings under PLANS.md `## Done` using src/backlog/backlog-md.ts
     helpers. Do not re-read the file when its mtime is unchanged.
   - When the count reaches `untilPlansDone`:
     - write the latch with {plansDone, ts};
     - log `bootstrap_complete` once;
     - lift the hold.
   - The latch makes the end permanent. A later steward compression of `## Done` must not
     re-enter bootstrap.
   - Removing `bootstrap` from config (live reload) also ends it, without writing a latch.
3. **Plan cadence.** While bootstrap is active, plan's min tick gap is the global
   `minTickIntervalSeconds` instead of its per-role default (3600 s), so a fresh project gets a
   steady stream of plans for feature. One rule in `scheduleConfigForRole`
   (src/config/config-views.ts): `isEligible` (src/scheduling/scheduling.ts, the
   `bootstrapActive` option) enforces the gap when it admits plan, and loop.ts resolves the same
   config so `applyTickOutcome` schedules `nextRunAt` from it rather than the role default.
4. **Status.**
   - status, TUI and GUI show "bootstrap: 2/5 plans done".
   - Held loops show `held: bootstrap`.
   - doctor reports an active bootstrap as info, not a warning.
   - Add `bootstrap_complete` to events.ts and event-format.ts.

**Files touched.**
- src/gates/bootstrap-gates.ts (new)
- src/gates/gate-polls.ts
- src/orchestrator/orchestrator-scheduling.ts
- src/scheduling/scheduling.ts or src/config/config-views.ts
- src/paths.ts
- src/status/status-data.ts and its renderers
- src/events/events.ts, event-format.ts
- src/doctor/doctor-checks.ts

Tests:
- test/bootstrap-gates.test.ts (new)
- an orchestrator scheduling case

**Acceptance criteria.**
- **Held set.** With `bootstrap.untilPlansDone: 2` and an empty `## Done`, clean, dry, coverage,
  qa and steward are held; plan and feature tick. bugfix ticks only after a bug is filed under
  `## Open`.
- **Completion.** Moving a second plan to `## Done` logs `bootstrap_complete`, writes the latch,
  and the next poll admits clean.
- **Latch.** Deleting both Done entries afterwards does not re-hold anything.
- **Plan gap.** During bootstrap, plan's gap is the global 20 s rather than 3600 s.
- **Unset.** Removing `bootstrap` from tumwater.json lifts every hold on the next poll.
- `npm run test` green.

### New-project bootstrap, part 1/2: `tumwater init` recognizes an empty project and opts it into bootstrap (planned 2026-10-08 by operator; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("New-project bootstrap").

Context. `initProject` (src/init/init.ts) seeds tumwater.json from `seedConfig` with every role
enabled. A project created from nothing therefore starts clean, dry, coverage and the rest
tidying code that does not exist yet, alongside the first feature. The user wants such a project
to run plan and feature first, until it is established.

**Approach.**
1. **Detect.**
   - In `initProject`, after the `git init` step but before writing anything, decide `fresh`.
     The project is fresh when either holds:
     - there is no git repo, or `hasCommits` is false;
     - `git ls-files` plus untracked, non-ignored files lists nothing outside the paths init
       itself owns or that carry no code: README.md, TUMWATER.md, PLANS.md, BUGS.md,
       QUESTIONS.md, PRINCIPLES.md, LICENSE*, .gitignore, tumwater.json.
   - Detection is language-agnostic: it only asks "is there anything here besides scaffolding".
2. **Config.**
   - When fresh, the seeded config gets `"bootstrap": {"untilPlansDone": 5}`.
   - Add the field to src/config/config-schema.ts and validate it in
     src/config/config-validation.ts: `untilPlansDone` must be an integer ≥ 1. (The plan named
     config-field-checks.ts; the section rules live in config-validation.ts.)
   - Absent means no bootstrap. Existing configs are unaffected.
3. **Output.** `tumwater init` (src/cli/cli-run.ts) prints one line saying maintenance loops
   wait until 5 plans are done, and that removing `bootstrap` from tumwater.json ends it early.

**Files touched.**
- src/init/init.ts
- src/cli/cli-run.ts
- src/config/config-schema.ts, config-validation.ts
- README.md (init section)
- test/init.test.ts

**Acceptance criteria.**
- **Empty dir.** `tumwater init` in an empty directory writes `bootstrap.untilPlansDone: 5`.
- **No commits.** The same holds in a repo with no commits.
- **Existing code.** In a repo with a tracked source file (any non-scaffolding file), init
  writes no `bootstrap`.
- **Validation.** `bootstrap: {"untilPlansDone": 0}` fails config validation with a field
  error.
- `npm run test` green.

### Work ratio, part 3/4: the plan loop's "enough waiting" target counts only entries feature could take now (planned 2026-10-08 by operator; done 2026-10-08 by feature)

**As landed:** Parallel work instances 5c/7 had already reshaped the stop target to count only
eligible entries and to prefer an independent series when `feature.instances` > 1. This tick
made the independence guidance unconditional and added the rendered-block acceptance test.

Design: plans/work-ratio.md ("Keep feature fed").

Context. The plan charter (src/roles/role-catalog.ts, plan step 1) ends with nothing-to-do when
`## Planned` "holds two or more plans without a Needs-review or Needs-replan note". Entries
tagged `[blocked: requires …]` in the `<backlog-index>`, and Refused entries, count toward
that.

On 10-07, 9 entries were planned and 3 were eligible. plan returned `no_change` on 19 of 21
ticks. A long sequential series therefore leaves feature with only its current part while plan
idles.

**Approach.**
1. **Charter.**
   - Reword the sentence to count only entries the backlog index shows with no hold mark: not
     `[blocked: …]`, not Refused, and no Needs-review or Needs-replan note.
   - Example: "when two or more `## Planned` entries are takeable now (no hold mark in the
     backlog index and no Needs-review/Needs-replan note), end with NOTHING_TO_DO".
   - When fewer are takeable, plan ONE new feature that does not depend on any planned entry, so
     feature can run it alongside the blocked series.
   - Parallel work instances 5c/7 later scales "two" with `feature.instances`. Whichever lands
     second rebases onto the other's wording; the two do not conflict in intent.
2. **Index.** `holdMark` (src/backlog/backlog-structure.ts) already tags every hold the
   charter names (`[refused]`, `[needs review]`, `[needs replan]`, `[blocked: requires …]`), so
   the charter can say "no bracketed hold mark" without restating each hold.

**Files touched.**
- src/roles/role-catalog.ts
- tests pinning the plan charter and `renderBacklogIndexBlock`

**Acceptance criteria.**
- The plan charter's target counts only unheld entries, and says a new plan should be
  independent of the blocked series.
- With one eligible entry and four `[blocked: …]` entries, the rendered plan prompt contains the
  new rule, and the backlog index marks all four as blocked (a test over the rendered blocks).
- `npm run test` green.

### Work ratio, part 4/4: report commits by role and show work vs maintenance commits on the "Landed today" tile and `tumwater report` (planned 2026-10-08 by operator; done 2026-10-08 by feature)

Design: plans/work-ratio.md ("Make the ratio visible").

Context. `foldUsageEvent` (src/report/report-data.ts) counts every `merged` event into
`commits` with no role. The tile (src/ui/gui/gui-client-fleet.ts, the "Landed today" card) shows
"64 commits" over "4 features done · 2 bugs fixed", and the operator cannot see which loops made
the 64. Parts 1/4–3/4 are judged by this split.

**Approach.**
1. **Fold.**
   - Count `merged` events into `commitsByRole` (via `eventRole`, keyed by base role) beside
     `ticksByRole`, in `UsageFold`, `DayFold` and the fold cache.
   - Also count tier totals `workCommits` and `maintenanceCommits`:
     - work = feature, bugfix, director;
     - maintenance = Work ratio 1/4's `QUOTA_ROLES`, or `CODE_MAINTENANCE_ROLES` plus readme
       until 1/4 lands;
     - everything else counts toward `commits` only.
2. **Tile.** The sub-line becomes "4 features done · 2 bugs fixed · 12 work / 52 maintenance".
   The headline stays "64 commits".
3. **Report.**
   - `tumwater report` (src/report/report-render.ts) prints a "commits by role" line, sorted
     descending, and the work/maintenance split.
   - Add "commits per backlog item" (commits ÷ (featuresDone + bugsFixed), one decimal) to the
     day report. Omit it when the denominator is 0.
   - Add the same split to the GUI report view's tiles (src/ui/gui/gui-client-report.ts).

**Approach (as landed).**
- The tier mapping lives in a new `commitTier(role)` in src/roles/roles.ts (not in the planned
  file list): `CODE_MAINTENANCE_ROLES` is private and 1/4's exported `QUOTA_ROLES` has not
  landed, so the one home for "work = feature/bugfix/director, maintenance = the code-maintenance
  list + readme" is the roles registry rather than a second list in report-data.ts.
- `commitsByRole`/`workCommits`/`maintenanceCommits` are added to `UsageFold`, `DayFold`, and
  `ReportDay`/`ReportData.totals` (optional on the public day shape, always set by
  `collectReport`). The `--since` collector folds the same `UsageFold` fields but its surfaced
  totals keep the previous shape, as the entry only asked for the day report.

**Files touched.**
- src/report/report-data.ts, report-render.ts
- src/ui/gui/gui-client-fleet.ts, gui-client-report.ts
- src/roles/roles.ts (the `commitTier` helper, as noted above)
- the GUI report endpoint payload, if typed separately

Tests:
- test/report-data.test.ts
- test/report-fold-cache.test.ts
- test/report.test.ts (the day render)
- test/gui-client-fleet.test.ts (the tile)
- test/gui-client-report.test.ts

**Acceptance criteria.**
- **Fold.** Five `merged` events (2 feature, 3 clean) fold to `commitsByRole {feature: 2,
  clean: 3}`, `workCommits 2`, `maintenanceCommits 3`, `commits 5`.
- **Cache.** A cached day re-folded after an appended merge counts it once.
- **Tile.** The tile sub-line shows the split, and the day report prints commits per item.
- `npm run test` green.

### Parallel work instances, part 5c/7: the plan charter's target scales with `feature.instances` (planned 2026-10-08 by plan; split from part 5/7; requires parts 5a/7 and 2/7 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("…keeping the plan loop ahead").

Context: the plan loop's charter (the `plan` role's `find` string in src/roles/role-catalog.ts,
step 1) stops it once PLANS.md holds "two or more plans without a Needs-review or Needs-replan
note", so one feature runner can drain the queue. With `feature.instances: N` the fleet can
work N plans at once, so the queue must hold N+1 eligible ones before the plan loop stops.

**Approach (as landed).**
1. **Target function.** `planBacklogTarget(config) = configuredInstances(config, "feature") + 1`
   lives beside the claim helpers (src/scheduling/claims.ts), which already imports from
   loop-ids.
2. **Charter text.** The `plan` role's `find` (src/roles/role-catalog.ts) says to stop when
   `## Planned` "already holds one more eligible plan than there are feature instances (one
   waiting per instance, plus one for the next planner tick)", counting only entries that are
   not blocked, refused, needs-review or needs-replan,
   and preferring a plan independent of the waiting series when more than one instance runs.
   The catalog stays config-free — no placeholder.
3. **Stop-target note.** `assembleTickPrompt` (src/tick/tick-prompt.ts) builds a
   `planTargetNote` from `planBacklogTarget(config)` for the plan base role only, and
   `buildTickPrompt` (src/prompt/prompt.ts) renders it right after the charter text; a role
   payload's `nextPrompt` therefore shows the resolved number.

**Files touched.** src/roles/role-catalog.ts, src/prompt/prompt.ts, src/tick/tick-prompt.ts,
src/scheduling/claims.ts. Tests: test/tick-prompt.test.ts, test/prompt-roles.test.ts,
test/role-view.test.ts.

**Acceptance criteria.**
- The assembled plan-role prompt from `feature.instances: 3` contains "4 or more eligible
  plans"; at the default it contains "2 or more". The prompt carries no unresolved
  placeholder.
- The prompt text says to count only eligible entries (no blocked/refused/needs-review) and to
  prefer an independent series when instances > 1.
- `npm run test` green.

### Parallel work instances, part 5b/7: instance runners spawn at startup and on live reload, gated by claims (planned 2026-10-08 by plan; split from part 5/7; requires parts 5a/7, 3/7, 4/7, Robust conflict landing 2/2 and Worktree pool 4b/5 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("Spawning instances and keeping the plan loop
ahead").

Context: the poll already assigns each runner in a `baseRoleOf` group a distinct claim and
skips an idle extra instance when nothing is free (src/orchestrator/orchestrator-scheduling.ts),
and `loopEnabled` (src/scheduling/scheduling.ts) already skips a runner whose configured count
no longer covers it. The missing piece was the runners: `runOrchestrator` built
`enabled.map(...)` from `enabledRoleIds` (src/orchestrator/orchestrator.ts) and
`newLiveConfigReload` diffed base-role ids (src/config/config-live.ts), so `instances` never
created a second loop.

**Approach.**
1. **Startup.** `runOrchestrator` builds its runner list from `loopIds(config)` (part 5a/7)
   instead of `enabledRoleIds`; a `--once --role feature-2` filter therefore targets exactly
   that loop id. Keep the empty-list refusal as-is.
2. **Live reload.** `newLiveConfigReload` diffs `loopIds(live)` between polls: create a
   `LoopRunner` for each newly present id (subject to the existing `roleFilter` guard), and
   keep a lowered id's runner in the list — `loopEnabled` skips it, exactly as a disabled role
   already is. Log one `warnEvent` per id enabled/disabled (the wording may keep naming the
   role).
3. **Known ids and snapshot.** `knownRoleIds` (src/config/config.ts) includes `loopIds(config)`
   so the CLI and the GUI (which resolve through `knownRoleIdsCached`) accept `--role
   feature-2`; `snapshot` (src/status/status-data.ts) lists loop ids so the dashboard has a row
   per instance.
4. **Landing invariant.** plans/merge-queue.md invariant 3 reads "one in-flight landing per
   loop" — a `feature-2` may land while `feature` is landing; the poll already enforces it per
   runner.

**Files touched.** src/orchestrator/orchestrator.ts, src/config/config-live.ts,
src/config/config.ts, src/status/status-data.ts, src/cli/cli-run.ts (the `--once --role`
validator now accepts loop ids via `loopIds(config)` so `--role feature-2` is a valid target,
and the banner/once-summary roster is `loopIds(config)` too, so the CLI's loop list matches the
runners the orchestrator starts), src/operator/retire.ts (the still-enabled rail resolves
through `loopEnabled`, so an enabled `feature-2` refuses exactly as its base role does; a bare
`enabledRoleIds` check would read the live instance as disabled and bypass the rail), and
plans/merge-queue.md. Tests: orchestrator e2e, config-live, retire and CLI-run cases.

**Acceptance criteria.**
- With `roles.feature.instances: 3` and two eligible plans, an orchestrator e2e run starts
  `feature` and `feature-2` (each holding its own claim from part 4/7), never starts
  `feature-3`, and creates no `feature-2` role worktree (ticks lease pooled slots).
- Raising `instances` 1→2 mid-run adds a `feature-2` runner within one poll; lowering 2→1
  stops `feature-2`'s future ticks and lets its in-flight landing finish.
- `knownRoleIds` contains `feature-2` at instances 2 and not at 1; `tumwater status` shows one
  row per loop id.
- `tumwater run`'s `loops:` banner and once-summary roster list loop ids (`feature`,
  `feature-2`), matching the runners; `retire --role feature-2` refuses while `feature` is
  enabled with `instances: 2`.
- plans/merge-queue.md invariant 3 names loops, not roles.
- `npm run test` green.

### Parallel work instances, part 5a/7: the validated `roles.<id>.instances` config field and `loopIds` enumeration (planned 2026-10-08 by plan; split from part 5/7; requires part 4/7 landed; done 2026-10-08 by feature)

Design: plans/parallel-work-instances.md ("Spawning instances and keeping the plan loop
ahead").

Context: part 4/7's claim machinery already assigns one entry per runner in a multi-runner
group and skips an idle extra instance, but a second runner cannot exist: `configuredInstances`
(src/roles/loop-ids.ts) reads `roles.<base>.instances` through an unchecked cast and no
config field carries it. This part makes the field real and stays behavior-neutral — it changes
no runner construction, so the fleet runs exactly as today until 5b/7.

**What landed (2026-10-08).** `RoleConfig.instances` — integer 1–8, only under `feature` and
`bugfix` — is in the schema and `ROLE_ENTRY_KEYS`, so `config set`/`config get` resolve it;
`validateConfig` rejects a bad count and a count under any other role; `configuredInstances`
reads the field without a cast, and `loopIds` enumerates each enabled role's bare id then its
extra instance ids in `config.roles` order. No runner construction changed, so the fleet
behaves as before until 5b/7.

**Approach.**
1. **Schema.** `RoleConfig.instances?: number` in src/config/config-schema.ts, documented as an
   integer 1–8, valid only under `roles.feature` and `roles.bugfix`, default 1. Add
   `"instances"` to `ROLE_ENTRY_KEYS` in the same file, which is what makes `config set
   roles.feature.instances 3`, `config get` and the unknown-field suffix in
   src/config/config-write.ts resolve it (`config-editable-keys.ts` is the GUI Settings
   allowlist and is not the place for this — correcting the oversized entry's earlier anchor).
2. **Validation.** In src/config/config-validation.ts, beside the per-role `enabled` /
   `minTickIntervalSeconds` checks, reject a non-integer, `< 1` or `> 8` (a new `NumberRule`
   like `POSITIVE_INTEGER`) and reject any `instances` under a role outside `INSTANCE_ROLES`
   (src/roles/loop-ids.ts) — a custom loop's or `roles.plan.instances` fails with a message
   naming the two allowed roles.
3. **loop-ids.** `configuredInstances` drops the cast and reads the field; add
   `loopIds(config): string[]` returning, for every enabled role in `config.roles` order, its
   bare id then `<id>-2`…`<id>-N` for `INSTANCE_ROLES` (other roles and custom loops stay
   bare). This is the one answer to "which runners should exist", so 5b/7's orchestrator and
   live reload reuse it.
4. **Docs.** No separate config-reference doc exists for per-role keys; the README Settings
   paragraph is it and the readme loop keeps it current — no docs edit is required here.

**Files touched.** src/config/config-schema.ts, src/config/config-validation.ts,
src/roles/loop-ids.ts. Tests: cases in the config-validation and loop-ids tests.

**Acceptance criteria.**
- `validateConfig` accepts `roles.feature.instances: 3` and `roles.bugfix.instances: 2`;
  rejects `instances: 0`, `instances: 9`, `instances: 1.5`, and `roles.plan.instances`.
- `config set roles.feature.instances 3` writes the field and `config get` reads it back;
  a typo'd `roles.feature.colour` still errors.
- `loopIds` on `feature.instances: 3` returns `feature, feature-2, feature-3` with the other
  enabled roles in `config.roles` order; at the default it returns exactly the bare ids
  `enabledRoleIds` returns today.
- `loopEnabled(config, "feature-3")` is true at instances 3 and false at 2.
- `npm run test` green.

### Organize the test suite, part 6/6: remaining fixtures move to `test/fixtures/`, leaving the root clean (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–5/6 landed; done 2026-10-08 by feature)

**Goal.** Move the remaining fixture modules — `config-fixtures.ts`, `doctor-fixtures.ts`,
`gate-fixtures.ts`, `gui-fixtures.ts`, `lander-fixtures.ts`, `landing-fixtures.ts`,
`models-fixtures.ts`, `redeploy-fixtures.ts`, `tui-fixtures.ts` — into `test/fixtures/`, leaving
`test/` root with only `*.test.ts` and the three runner-infrastructure modules.

**What landed (2026-10-08).** The nine modules were `git mv`'d into `test/fixtures/`. Every
`test/*.test.ts` importer's `./<name>.js` specifier became `./fixtures/<name>.js`. The moved
modules' own imports were rebased: their `../src/...` imports became `../../src/...` (config,
gate, gui, lander, landing, redeploy, tui); `./fakes/...` became `../fakes/...` (doctor,
lander); `./helpers/...` became `../helpers/...` (landing, redeploy, tui); and their
`./fixtures/<sibling>.js` references became the plain `./<sibling>.js` sibling form (doctor,
gate, lander, landing, tui). `models-fixtures.ts` has no relative imports.

Two anchors in the entry had drifted from the code parts 1/6–5/6 left behind, and were corrected
rather than followed literally: the modules did not start from flat imports —
`doctor-fixtures.ts` already imported `./fakes/fake-commands.js` and
`./fixtures/repo-fixtures.js`, and the rest already reached `src/` through `../src/` — so the
rebasing above targets the specifiers that actually existed; and `DEVELOPMENT.md`'s
`writeScript` reference already named `test/fakes/fake-commands.ts` (part 1/6), so it needed no
change.

Comment and doc references to the moved paths were updated in the root test files' headers and
in BUGS.md's `test/fixtures/doctor-fixtures.ts` / `test/fixtures/gui-fixtures.ts` citations. No
`src/`, `scripts/`, or `docs/` file named a moved path (grep).

**Files touched.** The nine modules; every `test/*.test.ts` importing them; comment/doc
references in the root test files, BUGS.md, and PLANS.md.

**Acceptance criteria.**
- All 35 support modules live under `test/fakes/`, `test/fixtures/`, or `test/helpers/`; the
  `test/` root holds only `*.test.ts` plus `test-runner.ts`, `test-durations-reporter.ts`, and
  `coverage-table.ts`.
- A grep over `src/`, `test/`, `scripts/`, `docs/`, `DEVELOPMENT.md`, `PLANS.md`, and `BUGS.md`
  for each moved basename at the `test/` root finds no stale reference.
- `npm run test` (eslint + tsc + the suite) is green and selects the same `*.test.ts` files.

### Organize the test suite, part 5/6: log, loop, orchestrator and status fixtures plus `pi-events` and `victim-fixture` move to `test/fixtures/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–4/6 landed; done 2026-10-08 by feature)

**Goal.** Move the `test/`-root modules `log-fixtures.ts`, `loop-fixtures.ts`,
`orchestrator-fixtures.ts`, `status-fixtures.ts`, `pi-events.ts`, and `victim-fixture.ts` into
`test/fixtures/`.

**Approach.**
- `git mv` the six modules into `test/fixtures/`.
- Rewrite every importer's `./<name>.js` specifier to `./fixtures/<name>.js`, and each moved
  module's sibling imports as below.
- Re-base the moved modules' own imports (its own directory is `test/fixtures/`, part 4's
  `repo-fixtures.ts` is already a sibling):
  - The six modules' `../src/...` imports gain a level (`../../src/...`); `pi-events.ts` has
    no relative imports.
  - `log-fixtures.ts`: `./repo-fixtures.js` and `./pi-events.js` stay siblings.
  - `loop-fixtures.ts`: `./repo-fixtures.js` stays a sibling; `./fake-commands.js` becomes
    `../fakes/fake-commands.js`.
  - `orchestrator-fixtures.ts`: `./repo-fixtures.js` stays a sibling; `./fake-pi.js` becomes
    `../fakes/fake-pi.js`; `./wait.js` becomes `../helpers/wait.js`.
  - `status-fixtures.ts`: `./log-fixtures.js` stays a sibling; `./oracles.js` becomes
    `../helpers/oracles.js`.
  - `victim-fixture.ts`: `./helpers/exit-with-owner.js` becomes `../helpers/exit-with-owner.js`,
    and `OWNER_PRELOAD`'s `new URL("./helpers/exit-with-owner.js", import.meta.url)` becomes
    `new URL("../helpers/exit-with-owner.js", import.meta.url)`.
- `test/helpers/cli-harness.ts` (already moved there) imports `../victim-fixture.js` from part 3;
  update it to `../fixtures/victim-fixture.js`.
- Update comment/doc references to the moved paths: BUGS.md's `test/fixtures/victim-fixture.ts` citations
  and `src/landing/landing-vetting.ts`'s `test/fixtures/orchestrator-fixtures.ts` comment (the latter moves
  part 6/6's item forward, since this tick already moved the file).

**Files touched.** The six modules; every `test/*.ts` importing them; `test/helpers/cli-harness.ts`;
BUGS.md references; `src/landing/landing-vetting.ts` (comment only).

**Acceptance criteria.**
- The six modules live in `test/fixtures/`; no `test/*.ts` specifier names any at the root.
- `victim-fixture.ts`'s `OWNER_PRELOAD` resolves `../helpers/exit-with-owner.js`; `cli-harness.ts`
  resolves `../fixtures/victim-fixture.js`.
- `npm run test` green and selects the same `*.test.ts` files.

### Organize the test suite, part 4/6: `repo-fixtures.ts` moves to `test/fixtures/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–3/6 landed; done 2026-10-08 by feature)

**Goal.** Move the highest-fanout support module, the `test/` root's `repo-fixtures.ts`, into
`test/fixtures/`.

**Approach.**
- `git mv` the root `repo-fixtures.ts` into `test/fixtures/`.
- Rewrite every importer's `./repo-fixtures.js` specifier to `./fixtures/repo-fixtures.js`
  (all 226 importers) — a module already moved in parts 1–3 and thus in a subdirectory
  becomes `../fixtures/repo-fixtures.js` (`fake-pi.ts`, `pi-run-harness.ts`), which the same
  substring sed handled alongside the root spellings.
- Re-base `repo-fixtures.ts`'s own imports: its `./fakes/fake-commands.js` becomes
  `../fakes/fake-commands.js`, and its three `../src/...` imports gain a level (`../../src/...`).
- `test/repo-fixtures.test.ts` (still at the root) follows: its import becomes
  `./fixtures/repo-fixtures.js`, its child-process `fixturesPath` gains the `fixtures/` segment,
  and its source-dir marker becomes `repo-fixtures.test.ts` rather than the moved module.
- Update comment/doc references to the old flat path: the `doctor-checks`/
  `doctor-model-checks` test comments and BUGS.md's two citations.

**Files touched.** the root `repo-fixtures.ts`; every `test/*.ts` importing it;
`test/repo-fixtures.test.ts`; BUGS.md references.

**Acceptance criteria.**
- `repo-fixtures.ts` lives under `test/fixtures/`; no `test/*.ts` specifier names `./repo-fixtures.js`.
- Its `writeScript`/`pathPrepend` imports resolve from `test/fakes/`.
- `npm run test` green and selects the same `*.test.ts` files.

- Organize the test suite, part 3/6: harness and oracle modules move to `test/helpers/` (planned 2026-10-07, done 2026-10-08; commit 06a448fe)
- Organize the test suite, part 2/6: utility modules move to `test/helpers/` (planned 2026-10-07, done 2026-10-08; commit c5e9adc2)
- Organize the test suite, part 1/6: support fakes move to `test/fakes/` (planned 2026-10-07, done 2026-10-08; commit b3c98628)
- Worktree pool, part 4b/5: role ticks lease a pooled slot (planned 2026-10-06, done 2026-10-07; commit 69116eb7)
- Worktree pool, part 4a/5: a leased slot can be kept for its role's resume and pinned on release (planned 2026-10-06, done 2026-10-07; commit 0b4254bd)
- Worktree pool, part 2d/5: remove the `_land-*` machinery and legacy checkouts (planned 2026-10-06, done 2026-10-07; commit 67481cca)
- Worktree pool, part 2c/5: merge-side landing work uses one `_merge` checkout (planned 2026-10-06, done 2026-10-07; commit a953a20f)
- Worktree pool, part 2b/5: vets lease a pooled slot (planned 2026-10-06, done 2026-10-07; commit 0bc3e253)
- Worktree pool, part 2a/5: the slot pool and its `worktreeSlots` config (planned 2026-10-06, done 2026-10-07; commit 93961c83)
- Worktree pool, part 3/5: readers find a role's checkout through `roleWorktreeDir` (planned 2026-10-06, done 2026-10-07; commit 6a5300f8)
- Robust conflict landing, part 2/2: a conflict the resolver cannot settle goes back to its author with the markers in place, instead of being discarded (planned 2026-10-07, done 2026-10-07; commit abbd00b9)
- Parallel work instances, part 4/7: the harness assigns each multi-instance loop one backlog entry and holds the claim through landing (planned 2026-10-07, done 2026-10-07; commit ac06d62d)
- Parallel work instances, part 1/7: one role, several loop ids — normalize every catalog-role lookup through `baseRoleOf` (planned 2026-10-07, done 2026-10-07; commit ef2a1d1e)
- Parallel work instances, part 2/7: mark backlog entries blocked by an unlanded prerequisite, refused, or needing review (planned 2026-10-07, done 2026-10-07; commit 92323d23)
- Disk floor, part 3/4: reclaim long-idle worktrees, and a `tumwater reclaim` command (planned 2026-10-06, done 2026-10-07; commit 374c7cbd)
- Parallel work instances, part 3/7: insert-only conflicts in PLANS.md, BUGS.md and QUESTIONS.md resolve without a model run (planned 2026-10-07, done 2026-10-07; commit 1a9de531)
- `tumwater run --gui`: boot the engine and the browser dashboard from one command (planned 2026-10-07, done 2026-10-07; commit e9d1d35f)
- Replan a plan whose change used up its review rounds, instead of re-authoring the same plan from scratch (planned 2026-10-07, done 2026-10-07; commit 919d28ec)
- Disk floor, part 4/4: show free space, the disk hold and the last reclaim on status, TUI and GUI (planned 2026-10-06, done 2026-10-07; commit 9d7d050b)
- Robust conflict landing, part 1/2: the conflict resolver sees what both sides meant, not only the markers (planned 2026-10-07, done 2026-10-07; commit 0f7aca27)
- Disk floor, part 2/4: reclaim gitignored build outputs from idle worktrees when free space runs low (planned 2026-10-06, done 2026-10-07; commit c8dde7f0)
- Revise rejected changes, part 2/2: the re-review sees the prior objections and what the revision changed (planned 2026-10-06, done 2026-10-07; commit b85652c5)
- Revise rejected changes, part 1/2: a rejected change goes back to its author as uncommitted edits instead of being discarded (planned 2026-10-06, done 2026-10-07; commit 5d152f91)
- Disk floor, part 1/4: hold new work when the worktrees volume runs low on free space (planned 2026-10-06, done 2026-10-07; commit 6794835b)
- Worktree pool, part 1/5: label every pi run's kind and demultiplex progress by the label, not the lander path (planned 2026-10-06, done 2026-10-07; commit 243c0873)
- Pre-queue self-check, part 2/2: flag stale path references, nonexistent paths, and lost final newlines (planned 2026-10-06, done 2026-10-06; commit 72a87b77)
- Pre-queue self-check, part 1/2: run the gate's deterministic backlog checks before a tick queues, with one fix-up turn on the author's session (planned 2026-10-06, done 2026-10-06; commit 1bb38fd2)
- Fallback-window shake: reclaim old tool output instead of only warning when a small-window model fills (planned 2026-10-06, done 2026-10-06; commit 03f7f29d)
- Role notebook: carry a bounded, model-written note per role across fresh ticks (planned 2026-10-06, done 2026-10-06; commit 5b336bed)
- Model failure fallback, part 2/2: show the episode on every surface (planned 2026-10-06, done 2026-10-06; commit e5a1c8a4)

- Model failure fallback, part 1/2: run a failing role's ticks on its tier fallback (planned 2026-10-06, done 2026-10-06; commit 1859a3d5)
- Log one `model_changed` event when a live config edit changes the fleet's model wiring (planned 2026-10-06, done 2026-10-06; commit 41755952)
- Show each loop's active model on `tumwater status`, the TUI, and the GUI (planned 2026-10-06, done 2026-10-06; commit 2f9a1ad9)
- Per-tick prompt-token telemetry: record prompt, cache-read, and pre-first-edit tokens on tick_end (planned 2026-10-06, done 2026-10-06; commit 1c404bf4)
- GUI Pending view: show each loop's unlanded change in the dashboard (planned 2026-10-06, done 2026-10-06; commit 5ecdaaa6)
- Model tiers, part 8/8: writers emit the new form, and the docs describe tiers (planned 2026-10-05, done 2026-10-06; commit a061ef22)
- Model tiers, part 7c/8: the doctor checks every declared tier model (planned 2026-10-05, done 2026-10-06; commit a6dbdfc7)
- Model tiers, part 7b/8: the `budget_fallback` badge lists the tiers (planned 2026-10-05, done 2026-10-06; commit 780566bb)
- Model tiers, part 7a/8: role rows show each loop's seam tier and resolved selector (planned 2026-10-05, done 2026-10-06; commit 68d9f02f)
- Model tiers, part 5c/8: budgetGate semantics, the per-role pause set, and handback by resolved pair (planned 2026-10-06, done 2026-10-06; commit c9490bc1)
- Model tiers, part 5b/8: the fallback breaker becomes a map keyed by pair (planned 2026-10-06, done 2026-10-06; commit 251fb9a3)
- Model tiers, part 5a/8: the per-tier budget-fallback resolution engine (planned 2026-10-05, done 2026-10-06; commit d920b64a)
- Model tiers, part 6/8: the fleet-wide backend hold keys storms by provider (planned 2026-10-05, done 2026-10-06; commit 286a5195)
- Model tiers, part 4/8: the conflict resolver runs on the strong tier (planned 2026-10-05, done 2026-10-06; commit 60bcc363)
- Model tiers, part 3/8: `small` / `default` / `strong` tier maps and the built-in tier of each role and the reviewer (planned 2026-10-05, done 2026-10-05; commit 7d2a9496)
- Model tiers, part 2/8: record the model each pi run used on `tick_start` and `review_start` (planned 2026-10-05, done 2026-10-05; commit 0b11f812)
- Model tiers, part 1/8: `provider/id[:thinking]` selector strings for `model`, and `fallback` as the new name of `fallbackModel` (planned 2026-10-05, done 2026-10-05; commit 3766e7f7)
- `tumwater prompt --attach <path>` — attach an image to a queued prompt from the CLI (planned 2026-10-04, done 2026-10-04; commit 9271b75d)
- `tumwater prompt --edit <n> <text...>` — correct a queued steering prompt in place, keeping its position and deferral (planned 2026-10-04, done 2026-10-04; commit e8720e45)
- `tumwater retire --role <id>` — remove a disabled loop's worktree and branch (planned 2026-10-04, done 2026-10-04; commit 5f007251)
- A shared test-fake catalog — the infrastructure that retires the recurring `no-fake` validation gap (planned 2026-10-04, done 2026-10-04; commit 8bce70cb)
- `tumwater bug "<symptom>"` and `tumwater plan "<title>" [body...]` — operator-authored backlog entries from the CLI (planned 2026-10-04, done 2026-10-04; commit fb5d9542)
- `tumwater tick <role> --last` — the newest tick's trail without knowing its number (planned 2026-10-04, done 2026-10-04; commit cce9ecf1)
- `tumwater run --for <duration>` — a bounded fleet run that drains and exits at the deadline (planned 2026-10-04, done 2026-10-04; commit 427c7d9c)
- Dotted per-role config keys: `config get/set maxDailyCostUsdPerRole.<role>` and `roles.<id>.<field>` (planned 2026-10-04, done 2026-10-04; commit 6e11f35c)
- `tumwater wake --in <duration>` — schedule a wake that arrives later, the scheduled sibling of `pause --for` (planned 2026-10-04, done 2026-10-04; commit ba0782cc)
- Per-role quiet hours: `quietHoursPerRole`, the scheduled sibling of `maxDailyCostUsdPerRole` (planned 2026-10-04, done 2026-10-04; commit 862b8145)

- `tumwater prompt --at <duration>` — queue a steering prompt that stays hidden until its time arrives (planned 2026-10-04, done 2026-10-04; commit 654f15b3)
- `tumwater questions` — read and answer the open-question outbox from the CLI (planned 2026-10-04, done 2026-10-04; commit 7cf0c37a)
- `tumwater init --template` — seeded project templates so a fresh fleet starts with signal (planned 2026-10-04, done 2026-10-04; commit a412d97d)
- The TUI's Ctrl+D quits like shell EOF and Ctrl+C interrupts the director's in-flight tick (planned 2026-10-04, done 2026-10-04; commit 4da5e4df)
- `tumwater prompt --file <path>` — queue a steering prompt from a file or stdin (planned 2026-10-03, done 2026-10-03; commit e6b8850d)
- The dashboard's Settings view: view and edit the curated top-level config keys live (planned 2026-10-02, done 2026-10-02; commit b03d653b)
- The TUI moves to ink, part 3/3: retire the hand-rolled renderer remnants and correct the docs (planned 2026-10-01, done 2026-10-02; commit 75c42c9a)
- The TUI moves to ink, part 2b/3: key handling moves to ink's `useInput` (planned 2026-10-01, done 2026-10-02; commit 4576a0c3)
- The TUI moves to ink, part 2a/3: extract the key handler from `runTui` into a framework-free module (planned 2026-10-01, done 2026-10-02; commit 5511dafd)
