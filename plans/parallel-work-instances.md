# Parallel work instances — several feature and bugfix loops, each on its own claimed entry

Planned 2026-10-07 · requested by user ("prioritize the feature loop much higher if there are
any plans, and the bugfix loop much higher if there are any bugs"; chosen approach: run several
feature / bugfix instances at once, each claiming a different plan or bug). Shared design for
the seven `Parallel work instances N/7` entries in PLANS.md. Builds on
[worktree-pool.md](worktree-pool.md) (instances lease slots, so they add no checkouts),
[merge-queue.md](merge-queue.md) (amends invariant 3 from "per role" to "per loop") and
[revise-rejected.md](revise-rejected.md) (a rejected change returns to the instance that wrote
it). Works for any language: nothing here reads project code, only the harness's own backlog
markdown.

## Goal

- `roles.feature.instances: N` and `roles.bugfix.instances: N` run up to N loops of that role
  at once.
- Each extra instance ticks only while the backlog holds an eligible entry that no other
  instance has claimed. An empty backlog costs nothing extra, and bugfix's latent-bug search
  (empty `## Open`) stays single.
- The harness assigns each instance one entry and holds that claim until the entry lands, the
  instance gives it up, or the claim goes stale. Two instances never work on the same plan or
  bug.
- An entry whose `requires … landed` prerequisite is still planned is never assigned.

## Motivation

- **The work tier is single-flight per role.**
  - One `LoopRunner` per role (src/loop/loop.ts) runs one tick at a time.
  - The merge-queue interlock (src/orchestrator/orchestrator-scheduling.ts,
    `queuedLandingRoles.has(runner.role)`) blocks the role's next tick until its landing
    finishes.
  - Measured over the 24 h before 2026-10-07 04:49 PDT, a feature cycle was about 10 min of
    authoring plus about 9 min of gate check and review (median), roughly 32 ticks a day.
  - In the same window feature and bugfix used about 20% of fleet tick time, while clean, dry
    and organize used about 40%.
- **Priority is already right, but it cannot add throughput.** `fairOrder` puts the work tier
  first, the semaphore orders waiters by tier, and feature never waits for a permit at
  `maxConcurrent: 6`. Raising priority further buys nothing. Only concurrency inside the work
  tier does.
- **Throughput is bounded by eligible work, not by instances.** Plan series serialize through
  `requires part i/n landed`. On 2026-10-07 only 1 of 7 planned entries was unblocked. So
  instances only pay off when (a) the harness knows which entries are blocked and (b) the plan
  loop keeps enough independent work waiting. Its charter currently stops at "two or more
  plans" waiting (src/roles/role-catalog.ts, plan step 1).
- **Concurrent landings of backlog moves conflict.** The move guidance (src/roles/role-guidance.ts
  `backlogMoveGuidance`) inserts every finished entry as the first one under `## Done` or
  `## Fixed`. Two landings off the same base both insert at that line, so the second rebase
  conflicts and pays a strong-tier resolver run (src/landing/landing-merge.ts `resolveConflict`).

## Rejected alternatives

- **Agent picks and declares (a reply line or a claim tool).** Instances admitted in the same
  poll would start at the same moment, read the same index, and pick the same "most valuable"
  entry. A claim tool (a pi-extension, like `role_notes`) narrows that race but does not close
  it, and it leaves the claim's lifetime to the model. Assignment in the serial scheduling pass
  has no race and is unit-testable.
- **One runner running several ticks concurrently.** Every per-role resource (state, branch,
  landing ref, rejected ref, review session, inbox) assumes one tick at a time, so a
  multi-tick runner would have to re-key all of them by hand. Separate runners with separate
  loop ids reuse every existing key.
- **`merge=union` for the backlog files** (via `.git/info/attributes`). It also "resolves" two
  edits of the same entry by keeping both versions, which silently corrupts the entry. Only
  insert-only hunks are safe to union (part 3/7).
- **Shipping instances before the pool.** Each instance would add a
  `.tumwater/worktrees/feature-2` and a `_land-feature-2`, each with warm build outputs. A
  project with a large `target/` cannot afford that. Part 5/7 requires Worktree pool 4/5, after
  which an instance is just another lessee of the same slots.

## Design

### Identity: loop id vs. base role (part 1/7)

- **Loop ids.** A role with `instances: N` has loop ids `<role>`, `<role>-2`, …, `<role>-N`.
  - Instance 1 keeps the bare role id. Existing state, branches, refs, sessions and inbox are
    therefore instance 1's, with no migration, and `instances: 1` (the default) is exactly
    today's fleet.
  - Only `feature` and `bugfix` accept `instances`.
- **Base role.** `src/roles/loop-ids.ts` holds the mapping:
  - `baseRoleOf(id)` maps `^(feature|bugfix)-([2-9]|[1-9][0-9]+)$` to its role, and any other
    id to itself.
  - `instanceIndex(id)` gives 1 for the bare id and N for `-N`.
  - `loopIdsFor(config, role)` and `loopIds(config)` give the enabled ids, expanded by
    instances, in config order.
  - `loopEnabled(config, id)` is true when the base role is enabled and the index is at most
    its instances.
  - Custom-loop validation rejects names that match the instance pattern.
- **`LoopRunner.role` stays the loop id;** a new `readonly baseRole` holds the catalog role. The
  field keeps its name because almost every consumer wants the loop id. Renaming it would touch
  roughly 100 sites for no behavior change.

**Keyed by loop id (unchanged code, one copy per instance):**

| Resource | Where |
|---|---|
| state file `.tumwater/state/<id>.json`, `LoopState.role` | paths.ts `statePath`, loop-state.ts |
| pi log `.tumwater/log/<id>.pi.jsonl` | `piLogPath` |
| sessions `sessions/<id>`, review `sessions/_review/<id>` | `sessionDir`, `reviewSessionDir` |
| branch `tumwater/<id>`, pool lease/pin role | `branchName`; the pool's `leaseSlot({ role })` |
| `refs/tumwater/landing/<id>`, `refs/tumwater/rejected/<id>` | `landingRefName`, `rejectedRefName` |
| `LandingEntry.role`, interlock, landing-slot changes, `liveRoles` | landing-queue.ts, orchestrator-scheduling.ts, landing-slot.ts, landing-vetting.ts |
| per-loop inbox (a prompt to `feature` reaches instance 1), abort marker | `roleInboxDir`, `abortRequestPath` |
| events `loop`, once-round, `deferredDue`, model-fallback episode, streaks, backoff and yield ring | events.ts, once-round.ts, loop state |
| notebook `state/notes/<id>` (an extra instance starts with an empty note) | `roleNotesPath` |
| trailer `Tick: feature-2 #N` | commit-message.ts `commitTrailer` |

**Normalized to the base role (`baseRoleOf`) at these choke points:**

| Concern | Site |
|---|---|
| catalog lookup and title; `qa`/`telemetry`/`clean` special cases; `config.roles[…].instructions` | tick-prompt.ts `assembleTickPrompt` (`roleById`, the custom-loop lookup) |
| model, thinking, interval, tier and fallback | config-views.ts `configForRole`, `roleSeamTier`, `fallbackRoleConfig` normalize their `role` argument |
| enabled check | scheduling.ts `isEligible` uses `loopEnabled` in place of `config.roles[runner.role]?.enabled` |
| tier and deferral sets | roles.ts `roleTier`, `yieldScaledRole`; main-red.ts's `BASELINE_BLOCKED_ROLES.has`; tick-apply.ts's `OBSERVER_ROLES.has`; scheduling.ts `deferTick` (`DEFERRABLE_ROLES`, `BUGFIX_ROLE`) |
| bugfix's red-main handoff | loop.ts `runTick` (`this.role === "bugfix"`); qa `extractFlow` likewise |
| commit subject `tumwater(<base>):` | tick-stage.ts `stampedSubject(ctx.role, …)`, verdict/refusal.ts. This keeps `workLanded`, the role-guidance `git log --grep`, and history attribution working |
| per-role caps and schedules | role-cap-gates.ts `pollRoleCapGate` sums the instances' `dailyCost` against the base cap and pauses all of them; gate-polls.ts per-role quiet hours and the budget tier (`roleSeamTier`) |
| operator fan-out | `pause`/`resume`/`wake`/`reset-counters`/`retire` with a base id reach every instance (operator-requests.ts `roleRequestTargets`; the scheduler checks `pausedRoles` for both ids); `abort`/`prompt`/`diff` address exactly the named loop id |

### Eligibility: which entries an instance may be given (part 2/7)

- **Inputs.** `src/backlog/backlog-eligibility.ts` reads `plannedPlanEntries` and
  `openBugEntries` (src/backlog/backlog.ts, stat-cached) from the primary checkout, the same
  source `renderBacklogIndexBlock` uses.
- **Not eligible:**
  - an entry whose body carries a `**Refused …**` note or the `NEEDS_REVIEW_NOTE` prefix
    (`**Needs review `);
  - an entry whose heading metadata names an unlanded prerequisite.
- **Parsing prerequisites.** Only the heading's trailing parenthetical is parsed, never the
  body.
  - The clause is `requires <ref>[, | and <ref>]… landed`.
  - A ref is `[<Series>] [part|parts] i/n[–j/n]`, and a range expands.
  - A ref with no series name means the entry's own series: the heading text before
    `, part i/n:`.
  - An entry is blocked while any referenced `(series, part)` is itself still listed under
    `## Planned`. Series names compare case-insensitively.
  - A clause that does not parse blocks nothing. The agent judges it, as it does today.
- **Entry key.** `entryKey(title)` is the heading with `ENTRY_STAMP_META_RE` removed,
  whitespace collapsed and lowercased. Adding a `done …` stamp or a `Refused` note therefore
  leaves the key unchanged.
- **Index marks.** The `<backlog-index>` block labels each ineligible entry, e.g.
  `- 78-117: Disk floor, part 3/4: … [blocked: requires Disk floor 2/4]` or `[refused]`. Every
  single-instance tick benefits now: feature stops reading blocked entries.

### Insert-only backlog conflicts (part 3/7)

- **Diff3 markers.** `rebaseOntoMainLeaveConflicts` (src/landing/landing-git.ts) runs with
  `-c merge.conflictStyle=diff3`, so each hunk carries its base section.
- **Deterministic first pass.** In `resolveConflict` (landing-merge.ts), before any pi run,
  `resolveBacklogInsertConflicts(wt, files)` (new src/landing/backlog-conflicts.ts) handles every
  conflicted `PLANS.md`, `BUGS.md` or `QUESTIONS.md` at the repo root. Each hunk is either:
  - **insert-only:** the base section is empty and both sides are non-empty. It is replaced by
    the change's lines, then a blank line if needed, then main's lines, so the newer landing
    stays first under `## Done`, as the move guidance asks;
  - **anything else:** the file is left untouched.
- **Fully resolved files** are staged.
- **When nothing is left conflicted,** `continueRebase` runs with no pi run. Otherwise pi
  resolves only the remaining files, and its prompt lists only those.
- **Why it is safe.**
  - The resolved diff ahead of main contains only the reviewed change's own lines, so
    `resolvedDiffDiverges` is false and no re-review runs. That is correct: no new bytes were
    authored.
  - `verifyLanding`'s in-lock checks (`backlogStructureReason`, `duplicateHeadings`) still run.

### Claims (part 4/7)

- **The claim.** `LoopState.claim?: { file: "PLANS.md" | "BUGS.md"; key: string; title:
  string; at: number; source: "assigned" | "staged" }`.
  - It is persisted with the instance's state, so a crash, a resume, a leftover recovery or a
    revision keeps it with no extra store.
- **Who assigns.** Only roles that currently have more than one runner (instances > 1) take
  part. The assignment happens in `pollRunnerReasons` (orchestrator-scheduling.ts), after every
  gate has admitted the runner and just before `reasons.set`:
  - The poll computes, once per multi-instance role: `eligible`, `held` (keys of claims on that
    role's runners still listed under the section), and `free = eligible − held`.
  - **A runner already holding a claim** keeps it. This covers its revision, resume, error
    retry, and a fresh retry after an exhausted revision. No new assignment is made.
  - **Otherwise, when the reason is not `inbox` or `resume`** and `free` is non-empty, the
    runner gets the first entry of `free` and removes it. The order is file order, preferring an
    entry whose **Files touched** paths do not overlap the paths of any held entry. A `claim`
    `assigned` event is logged.
  - **Extra instances (index ≥ 2) with no claim and an empty `free`** are skipped this poll.
    This is the scaling rule: active extras = min(N − 1, unclaimed eligible entries). An idle
    extra runs no tick and climbs no backoff ladder.
  - **The primary instance with no claim and an empty `free`** runs exactly as today. That
    includes bugfix's latent-bug search and feature's nothing-to-do. Its prompt adds an
    exclusion list of held titles.
- **Prompt.** `assembleTickPrompt` appends `buildAssignmentNote` (src/gates/gate-prompts.ts)
  when `state.claim` is set and the tick dequeued no user request:
  - the entry's title and current line range (looked up by key);
  - an instruction to implement or fix only that entry, which replaces the charter's "pick one"
    step;
  - if the entry is too large: add `NEEDS_REVIEW_NOTE` to it and end with that note only;
  - if it should not be done: refuse it, recording the objection;
  - the titles other instances hold, with "do not edit these entries".

  A revision tick keeps the revision note and also names the claim.
- **Claims made at staging.** `stageTickLanding` (src/tick/tick-stage.ts) handles both cases:
  - **An unassigned primary's** staged diff moves an entry out of `## Planned` or `## Open`. The
    harness detects which one with `actionableEntryRanges` on the worktree versus the
    merge-base and records `claim { source: "staged" }`, so no extra instance is assigned it
    while it lands.
  - **An assigned tick** whose diff moves a *different* entry gets a stage-check finding (one
    fix-up turn, src/tick/stage-check.ts): "assigned X, moved Y".
- **Release.**
  - **When the claimed key leaves the section** (it landed into Done or Fixed, or was removed
    or renamed): checked every poll.
  - **When the entry turns ineligible** (a Refused or Needs-review note landed): checked every
    poll.
  - **After a tick ending `no_change`, `refused`, `user_aborted` or `skipped`,** with no
    `revision` and no `resumePending` (src/tick/tick-finalize.ts).
  - **When the runner is no longer `loopEnabled`** and is idle: not running, no queued landing,
    no revision.
  - **Stale:** older than `CLAIM_IDLE_MAX_MS` (24 h), with the instance idle (not running, no
    queued landing, no pinned landing ref, no revision, no resume). A warning names it.
  - Each release logs `claim` `released` with a reason.
- **Held through** `queued`, `error`, `aborted`, `quiet_killed`, `main_red`, `merge_conflict`,
  `review_error` and `rejected`. A rejection leaves `LoopState.revision` on the same instance
  (rejected ref `refs/tumwater/rejected/<id>`), so the revision returns to its author. After an
  exhausted revision, the instance keeps the claim and its next fresh tick re-attempts the same
  entry with the plain rejection note. That matches today's single feature loop re-picking a
  rejected plan, and keeps the reasons with the entry.

### Spawning instances and keeping the plan loop ahead (part 5/7)

- **Config.** `roles.<id>.instances` is an integer from 1 to 8, only for `feature` and
  `bugfix`, and defaults to 1. It touches the schema, validation, editable keys, the example
  config and docs.
- **Runners.**
  - The orchestrator builds its runners from `loopIds(config)` (orchestrator.ts, the
    `enabled.map(...)` that creates the runners).
  - Live reload adds runners for new ids (config-live.ts). Lowering `instances` leaves the
    surplus runners, which `loopEnabled` then skips, the same way a disabled role is handled.
  - `knownRoleIds`, `snapshot` (status-data.ts) and the GUI's role validation list the loop ids.
- **Plan threshold.** The plan charter's "two or more plans" becomes a target the prompt
  substitutes: `planBacklogTarget(config) = instances(feature) + 1` *eligible* plans. The
  charter also asks for independent series when feature runs several instances.
- **Merge-queue invariant 3** now reads "one in-flight landing per loop".
  plans/merge-queue.md gets that edit.

### Observability (part 6/7)

- **Status, TUI and GUI.** `tumwater status`, the TUI and the GUI show one row per loop id.
  Rows carry `claim` (the claimed title); the GUI shows it as the row's current work while idle
  or landing.
- **status --json** carries `claim` and `instanceOf`.
- **Events.** `claim` events (`assigned` / `released`, with key, title and reason) render in
  `tumwater logs`.
- **Doctor.** `checkWorkInstances` warns when:
  - a claim names a key no longer listed;
  - a claim is older than 24 h;
  - `instances > 1` is set while `worktreeSlots` is below `maxConcurrent`.
- **Docs.** docs/how-it-works.md describes instances, claims and the plan target.

### Priority headroom (part 7/7)

- **The semaphore.** It already orders waiters by tier (src/concurrency/semaphore.ts) and
  never preempts. The remaining risk with more work runners: maintenance ticks can take every
  free permit in the gap before a work instance becomes due, and then the work instance waits a
  whole maintenance tick.
- **The fix.** `Semaphore.setReserve(n)`: while `inUse ≥ capacity − n`, tier ≥ 1 acquirers and
  waiters are not granted; tiers ≤ 0 (work, vets, merges) are unaffected.
- **Sizing.** The orchestrator sets `n` every poll to
  `min(floor(maxConcurrent / 3), idle work loops that could take work now)`. An idle work loop
  here is one that is not running, has no queued landing, and either holds a claim or its role
  has an unclaimed eligible entry.
  - When every work instance is busy or landing, `n` is 0. Maintenance keeps the full capacity
    and no permit sits idle for nothing.
- **Measure first.** Feature waited for no permit in the 2026-10-07 measurement. Land 5/7,
  watch `parkedSince` on work rows, and drop this part if work loops never park.

## Limits

- Assignment uses file order, with only the file-overlap preference on top. When N > 1, the
  feature loop's "most valuable" judgment applies only on the primary's unassigned ticks.
- Two plans can still conflict in code. The overlap preference is a heuristic from **Files
  touched**, and a real conflict still goes to the resolver.
- The director never has instances. Maintenance roles never have instances.
- A heading renamed by its author changes its key, which releases the claim. The stage-time
  claim covers the common case, a rename made while landing the entry. A rename by another
  loop (clean fixing a heading) could briefly let a second instance be assigned the same entry.

## Phases

1. **Parallel work instances 1/7: loop ids and base-role normalization.** Behavior-neutral.
2. **2/7: backlog eligibility, with blocked and refused entries marked in the backlog index.**
3. **3/7: insert-only backlog conflicts resolve without a model run.**
4. **4/7: claims: the harness assigns each multi-instance loop one entry and holds it through
   landing.** Requires 1/7 and 2/7.
5. **5/7: `roles.<id>.instances` spawns instances that run only while unclaimed work exists,
   and the plan target scales.** Requires 3/7, 4/7 and Worktree pool 4/5.
6. **6/7: claims and instances on status, TUI, GUI, doctor and docs.** Requires 5/7.
7. **7/7: the work tier keeps permit headroom while it has work to take.** Requires 5/7.

Parts 1/7–4/7 can land before the pool. They are inert or useful on their own: 2/7 stops the
single feature loop reading blocked entries, and 3/7 removes today's resolver runs between
bugfix and the director on BUGS.md.

## Out of scope

- Instances of plan, the director or any maintenance or custom role.
- A shared notebook across instances (each loop id keeps its own).
- Model-chosen claims (rejected above).
- Splitting one plan across instances.
