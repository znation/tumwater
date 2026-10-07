# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Robust conflict landing, part 2/2: a conflict the resolver cannot settle goes back to its author with the markers in place, instead of being discarded (planned 2026-10-07 by operator; requires part 1/2 landed)

Context: today two paths throw an approved change away over a merge conflict:
- **Repeated landing conflicts.** A pinned change whose landing conflicts and whose single
  resolver run fails ends `merge_conflict` and is re-queued. After `MERGE_CONFLICT_LIMIT` (3)
  such landings, `recoverLeftover` (src/loop/leftover.ts) deletes the pin ("discarding leftover
  … unresolved merge conflicts with main"), and the author starts over with nothing.
- **Revision re-apply.** `applyRevision` (src/loop/revision.ts) aborts a revision's re-apply on
  any conflict, then falls back to the plain rejection note.

In both cases the loop best placed to resolve the conflict, the author, never sees it. The
author knows what its change was for and can read main's side, and its result goes through the
full review gate again.

**Approach.**
1. **Hand-back state.** `LoopState.conflictHandback?: { sha; at; reason: "landing" |
   "revision"; round?: number }` (src/loop/loop-state.ts).
2. **Landing path.** In `recoverLeftover`, at `MERGE_CONFLICT_LIMIT`, set `conflictHandback`
   from the pin instead of discarding it, and keep the landing ref until the author's tick has
   applied it. Then lower the limit from 3 to 2: the resolver gets a second try in case main
   moves again, then the author takes over. Log `conflict_handback` `queued`.
3. **Apply with markers.** New `applyWithConflicts(wt, mainBranch, sha)` in
   src/loop/revision.ts. It runs `git cherry-pick --no-commit <merge-base>..<sha>`. On a
   conflict it does NOT abort:
   - it records the conflicted paths;
   - it runs `git reset` to drop the index state, so the markers stay as ordinary uncommitted
     edits and the author's tick can commit normally;
   - it returns `{ applied: true, conflicted: string[] }`.

   A missing object or other non-conflict failure still resets to main and returns
   `{ applied: false }`. `applyRevision` keeps its current contract for callers outside the
   hand-back.
4. **Revision path.** In loop.ts's revision branch (around `applyRevision`), when the clean
   re-apply fails, try `applyWithConflicts`. If it applies with conflicts, the tick gets the
   revision note plus the conflict note below. Only an `applied: false` falls back to the plain
   rejection note.
5. **Author's tick.** At tick start (loop.ts, beside the revision branch), a `conflictHandback`
   applies its sha with `applyWithConflicts`. The prompt gets `buildConflictHandbackNote`
   (src/gates/gate-prompts.ts), which:
   - lists the conflicted files;
   - includes the same "What main changed in these files" block as part 1/2;
   - says the change was approved (landing) or was being revised (revision) and that main
     moved under it;
   - asks the author to resolve every marker, keeping the intent of both sides and respecting
     main's deliberate removals, and to re-run the check.

   Clear `conflictHandback` and delete the landing ref once the edits are applied. The tick then
   commits and queues as usual: it is new bytes, so the gate reviews it in full. A hand-back
   uses no revision round.
6. **Bound.** A change handed back once and conflicting again at the cap is discarded as today,
   with a warning naming both attempts. `conflictHandback` carries a `count`, and the limit is
   one hand-back per change.
7. **Stage check.** The pre-queue stage check (src/tick/stage-check.ts) flags any conflict
   marker (`<<<<<<<`, `>>>>>>>`, a `=======` line between them) left in a staged file. The
   author gets one fix-up turn.

**Files touched.** src/loop/loop-state.ts, src/loop/leftover.ts, src/loop/revision.ts,
src/loop/loop.ts, src/gates/gate-prompts.ts, src/tick/stage-check.ts, src/events/events.ts,
src/events/event-format.ts. Tests: cases in the leftover, revision, loop and stage-check tests,
plus one with real branches: a pinned change and a main commit that edit the same lines.

**Acceptance criteria.**
- **Landing hand-back.** A pin whose landings end `merge_conflict` twice is not discarded. The
  author's next tick starts with its diff applied over current main, markers in the conflicted
  files, and a prompt naming those files and main's commits for them.
- **Revision hand-back.** A rejected change whose re-apply conflicts reaches its author as a
  revision with markers in place, not as a plain rejection note.
- **Normal landing.** The author's resolved commit queues and is reviewed like any fresh
  change.
- **Leftover markers.** A staged file still holding a conflict marker is flagged before queuing.
- **Bound.** A change that conflicts again after one hand-back is discarded with the warning.
- `npm run test` green.

### Replan a plan whose change used up its review rounds, instead of re-authoring the same plan from scratch (planned 2026-10-07 by operator)

Context: when a change is rejected after its last revision round (`REVISION_LIMIT` = 2,
src/loop/revision.ts), `recordRejectedChange` (src/landing/landing-core.ts) logs `revision`
`exhausted`. `buildRejectedReviewNote` (src/gates/gate-prompts.ts) then tells the author to
"re-author it from current main". The plan text never changes, so the next attempt starts from
the same plan the reviewer kept objecting to. Over the 14 days before 2026-10-07 this produced
long rejection runs before a landing:
- feature: 8 rejections in a row over 66 h (the timed-pause plan, from 09-25);
- feature: 6 in a row over 4.4 h (ink TUI part 1/3, 10-01);
- feature: 4 and 3 in a row on four other plans.

Those runs predate revise-rejected. Revisions shorten them, but on exhaustion nothing feeds the
reviewer's objections back into the plan. The only plan-changing path today is the author's
**Needs review … too large for one run** note, which the plan loop splits.

**Approach.**
1. **Note.** In src/roles/role-guidance.ts, add `NEEDS_REPLAN_NOTE =
   "**Needs replan <YYYY-MM-DD> by feature: rejected after <N> review rounds**"`. Add it to the
   date-stamp list in src/prompt/prompt.ts beside `NEEDS_REVIEW_NOTE`.
2. **Author on exhaustion.** `buildRejectedReviewNote` gains an optional `role`. When
   `exhausted` is true and the role is `feature`, the finality sentence becomes:
   - if the rejected change implemented a PLANS.md entry, do not re-author it;
   - append the `NEEDS_REPLAN_NOTE` under that entry's heading, followed by the reviewer's
     numbered objections, quoted;
   - land that markdown-only change and nothing else.

   Pass the role from both call sites, src/tick/tick-prompt.ts and src/loop/loop.ts. Other roles
   keep today's sentence.
3. **Feature skips it.** Step 2 of the feature charter (src/roles/role-catalog.ts) skips entries
   carrying a Needs-replan note, as it skips Needs-review ones.
4. **Plan loop owns it.** In step 1 of the plan charter, a Needs-replan entry outranks adding a
   plan, alongside Needs-review. The task:
   - read the quoted objections and the code they name;
   - rewrite the plan so an implementation following it would answer them. That can mean
     correcting the approach or the anchors, tightening the acceptance criteria, splitting the
     plan per PLAN_SIZING, or refusing the plan with the objection recorded when it should not
     be done;
   - then remove the note and the quoted objections.

   The plan loop runs on the strong tier, which is the right seat for this judgment.
5. **Index.** `renderBacklogIndexBlock` (src/backlog/backlog-structure.ts) marks such an entry
   ` [needs replan]`, so both loops see it without reading the body.

**Files touched.** src/roles/role-guidance.ts, src/roles/role-catalog.ts,
src/gates/gate-prompts.ts, src/tick/tick-prompt.ts, src/loop/loop.ts, src/prompt/prompt.ts,
src/backlog/backlog-structure.ts. Tests: cases in the gate-prompts, tick-prompt,
role-catalog and backlog-index tests.

**Acceptance criteria.**
- **Feature, exhausted.** A feature tick whose `lastReview.exhausted` is true gets the
  replan instruction naming `NEEDS_REPLAN_NOTE`, not "re-author it from current main".
- **Other roles.** A bugfix or clean tick in the same state gets today's sentence unchanged.
- **Charters.** The feature charter tells feature to skip Needs-replan entries, and the plan
  charter ranks them with Needs-review entries above writing a new plan.
- **Index.** The backlog index marks a Needs-replan entry `[needs replan]`.
- `npm run test` green.

### Disk floor, part 3/4: reclaim long-idle worktrees, and a `tumwater reclaim` command (planned 2026-10-06 by operator; requires part 2/4 landed)

Design: plans/disk-floor.md ("Reclaiming build outputs": idle mode and the command).

**Goal.** Reclaim worktrees that have been unused for a day even when the disk is not low.
Those are worktrees of paused, retired, disabled or rarely due roles, and lander worktrees of
roles that seldom land. Also give the operator a manual reclaim.

**Approach.**
1. **Idle mode.** `reclaimPass(root, "idle", …)` in src/fleet/reclaim.ts cleans each
   candidate unused for `worktreeIdleReclaimHours` or longer, unless its `reclaimedAt` is
   already later than its `lastUsedAt`. It never cleans a resume-pending role's worktree.
2. **Scheduling.** The orchestrator runs an idle pass at most hourly, on the same single-flight
   background runner as pressure passes.
3. **Config.** Add `worktreeIdleReclaimHours`, default 24, where 0 disables idle mode. It
   touches the same spots as part 1/4.
4. **Command.** Add `tumwater reclaim [--dry-run]`:
   - **Fleet running:** drop `.tumwater/reclaim.json`, through a new `reclaimRequestPath(root)`
     in src/paths.ts. The orchestrator consumes it like the wake marker and runs one
     `"manual"` pass over every candidate.
   - **No fleet:** run the manual pass in-process.
   - **`--dry-run`:** print each candidate with its idle age and the number of paths
     `git clean -ndX` lists, and clean nothing.
   - Wiring goes in src/cli/cli-marker-commands.ts, and help text in src/cli/help.ts.

**Files touched.** src/fleet/reclaim.ts, src/orchestrator/orchestrator.ts, src/paths.ts,
src/config/config-schema.ts, src/config/config.ts, src/config/config-validation.ts,
src/cli/cli-marker-commands.ts, src/cli/help.ts, docs/how-it-works.md. Tests: cases in
test/reclaim.test.ts, plus config and CLI cases.

**Acceptance criteria.**
- **Idle mode.** A worktree idle 25 h is cleaned once, and skipped on the next pass. It is
  cleaned again only after a new use followed by 24 h idle. A resume-pending worktree is never
  cleaned in idle mode.
- **Off.** `worktreeIdleReclaimHours: 0` never runs idle passes.
- **Command.** `tumwater reclaim --dry-run` cleans nothing and lists the candidates.
  `tumwater reclaim` with a running fleet results in one `disk_reclaim` with mode `manual`.
  With no fleet running, it cleans directly.
- `npm run test` green.

### Disk floor, part 4/4: show free space, the disk hold and the last reclaim on status, TUI and GUI (planned 2026-10-06 by operator; requires parts 1/4 and 2/4 landed)

Design: plans/disk-floor.md ("Surfaces").

**Goal.** An operator sees why the fleet stopped, without reading events. The status, TUI and
GUI processes cannot call statfs on the orchestrator's behalf in a consistent way, so the
orchestrator publishes what it measured.

**Approach.**
1. **Publish.** Add `disk?: { freeGB, holdGB, reclaimGB, held, lastReclaim?: { at, mode,
   freedGB } }` to `OrchestratorInfo` (src/fleet/fleet-state.ts). `pollFleetGates`
   (src/gates/gate-polls.ts) writes it only when it changes, like `budget`, rounding `freeGB`
   to one decimal.
2. **Header badge.** Add `diskBadge` to src/ui/badges.ts, after `budgetBadge`/`quietBadge`. It
   is shown while the fleet holds, or while free space is below `reclaimGB`, e.g.
   "disk 8.2 GB free — holding new work".
3. **Alert.** Add a `disk` alert in src/ui/fleet-alerts.ts while the fleet holds.
4. **Loop phase.** A held loop's phase reads "disk hold" in src/ui/status-model.ts, ranked
   like "budget paused".
5. **Status.** `tumwater status` (src/status/status-data.ts) shows the same facts.

**Files touched.** src/fleet/fleet-state.ts, src/gates/gate-polls.ts, src/ui/badges.ts,
src/ui/fleet-alerts.ts, src/ui/status-model.ts, src/status/status-data.ts. Tests: cases in the
existing badge, fleet-alert, status-model and status tests.

**Acceptance criteria.**
- **Held.** A published `disk.held: true` shows the badge, the alert and the "disk hold" phase
  on held loops.
- **Low but not held.** Free space below `reclaimGB` while not held shows the badge only.
- **Missing.** No `disk` field, as with an older orchestrator, renders exactly as today.
- `npm run test` green.

### Worktree pool, part 2/5: landing vets lease pooled slot worktrees; merges use one `_merge` checkout (planned 2026-10-06 by operator; requires Disk floor 2/4 and Worktree pool 1/5 landed)

Design: plans/worktree-pool.md ("Rejected", "Layout", "Config", "Leases", "Vets and merges").

Context: every landing role keeps its own `_land-<role>` checkout with its own build outputs,
about one per role. Vets are concurrent up to `max(1, maxConcurrent - 1)`
(src/landing/landing-vetting.ts). A vet already passes its result on through refs and
`VettedLanding`, never through the worktree. Every merge-side step already re-ensures its
worktree at a commit. So vets can share a small pool of checkouts, and merges, which the drain
runs one at a time, need only one. It works for any language, because a slot keeps a fixed
path and switches commits in place. Build outputs never move between paths; the design doc
records why moving them is unsafe.

**Approach.**
1. **Config.** Add `worktreeSlots`, an integer ≥ 1. When absent it defaults to
   `maxConcurrent + 1`, computed by a `slotCount(config)` helper. It touches the schema,
   default, validation and docs, like `maxConcurrentChecks`.
2. **Paths** in src/paths.ts:
   - `slotWorktreePath(root, n)` → `_slot-<n>`;
   - `mergeWorktreePath(root)` → `_merge`;
   - `slotsStatePath(root)` → `.tumwater/state/slots.json`, with `slotsLockPath(root)` beside
     it.
3. **Pool.** New file src/git/worktree-pool.ts. `leaseSlot(root, { role, purpose, ref,
   signal })` returns `{ dir, release() }`.
   - **Choice order:**
     1. a slot pinned for the role. Pins are unused until part 4/5;
     2. the free slot this role released most recently;
     3. the free slot released most recently by anyone;
     4. a new `_slot-<n>`, while fewer than `slotCount` unpinned slots exist;
     5. otherwise wait first-in first-out, aborting on `signal`.
   - **Use.** The lease holds `useWorktree` (Disk floor 2/4) for its duration, and prepares the
     slot with `ensureDetachedWorktree(root, dir, ref)`.
   - **State.** Every change is persisted to slots.json under `withSyncLock`
     (src/concurrency/lock.ts). Each slot records `{ dir, lease: { role, purpose, since, pid }
     | null, pinnedFor, lastRole, lastReleasedAt }`.
   - **Startup.** The pool clears leases whose `pid` is not this process.
4. **Vets.** In `vetRequest` (src/landing/landing-batch.ts), replace
   `ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha)` with a
   lease: purpose `vet`, role `req.role`, ref `req.sha`. Release it in a `finally`.
5. **Merges** use `mergeWorktreePath(root)`. That covers `landApprovedChange`
   (src/landing/landing-core.ts), the stack's `wtPath` (landing-batch.ts) and
   `attributeRedCheck`.
6. **Removals.**
   - Delete every `removeLandWorktree` call: in landing-core.ts, landing-check-failures.ts,
     landing-pipeline.ts and landing-batch.ts. Then delete the helper (src/git/git.ts) and
     `landWorktreePath`.
   - progress-data.ts's cwd fallback from part 1/5 keeps the legacy `_land-<role>` path as a
     local expression, for old logs.
7. **Startup cleanup.** When the orchestrator starts, it removes legacy `_land-*` worktrees
   with a force `worktree remove` followed by a prune. They hold no state, and queued landings
   re-vet from their pinned refs.
8. **Fixtures.** Update the tests that hard-code `_land-<role>`: test/status-fixtures.ts,
   test/progress.test.ts, test/landing-pipeline.test.ts, test/orchestrator-3.e2e.test.ts and
   test/doctor-orphans.test.ts.

**Files touched.** src/git/worktree-pool.ts (new), src/paths.ts, src/config/config-schema.ts,
src/config/config.ts, src/config/config-validation.ts, src/landing/landing-batch.ts,
src/landing/landing-core.ts, src/landing/landing-check-failures.ts,
src/landing/landing-pipeline.ts, src/git/git.ts, src/ui/progress-data.ts,
src/orchestrator/orchestrator.ts, docs/how-it-works.md. Tests: test/worktree-pool.test.ts
(new), plus the fixtures above.

**Acceptance criteria.**
- **Concurrency.** Two concurrent vets lease two different slots. A third vet, with
  `worktreeSlots: 2`, waits and proceeds when one is released. A waiting lease honors abort.
- **Affinity.** A vet prefers the free slot its role used last.
- **No `_land-*` directories** exist after startup or after any landing outcome.
- **Merges.** Single merges, stacks and bisects run in `_merge`, and the existing orchestrator
  e2e landing tests pass unchanged in outcome.
- **State file.** slots.json shows the lease during a vet and none after it. A lease left by a
  dead pid is cleared at startup.
- `npm run test` green.

### Worktree pool, part 3/5: readers find a role's checkout through `roleWorktreeDir` (planned 2026-10-06 by operator; requires part 2/5 landed)

Design: plans/worktree-pool.md ("Readers find a role's checkout").

Context: `tumwater diff`, the GUI's `/api/diff` (both through `collectRoleChange`), `retire`
and `doctor` find a role's checkout as `worktreePath(root, role)`, and they run in processes
other than the orchestrator. Part 4/5 moves role ticks into pool slots. This part moves the
readers first, so the GUI's diff view never breaks in between. Until part 4/5 lands it changes
no behavior.

**Approach.**
1. **Resolver.** Add `readSlotsState(root)` and `roleWorktreeDir(root, role)` in a module that
   separate processes can import without the pool's in-memory state, e.g.
   src/git/slots-state.ts. `roleWorktreeDir` resolves, in order:
   - a slot that slots.json lists as leased by the role with purpose `tick`, or pinned for the
     role, gives its dir;
   - else the legacy `worktreePath(root, role)` when `isUsableWorktree`;
   - else `null`.
2. **Diff.** `collectRoleChange` (src/change/change-data.ts) uses `roleWorktreeDir`. `null`
   gives the existing "absent" shape.
3. **Retire.** In src/operator/retire.ts:
   - `worktreePresent`, `worktreeUsable` and `dirty` come from `roleWorktreeDir`.
   - **Removal, when the dir is a slot:** under the slots lock, clear `pinnedFor`, then run
     `git reset --hard`, `git clean -fd` and `git checkout --detach` in the slot. Never remove
     a slot directory.
   - **Removal, when the dir is legacy:** `removeWorktree` as today.
   - Branch deletion is unchanged. Update the literal `.tumwater/worktrees/${role}/` message.
4. **Doctor.** Any doctor code that probes a role's worktree uses `roleWorktreeDir`.

**Files touched.** src/git/slots-state.ts (new), src/git/worktree-pool.ts (moves its state
read/write here if convenient), src/change/change-data.ts, src/operator/retire.ts,
src/doctor/*. Tests: cases in test/change-data.test.ts, test/retire.test.ts and a fabricated
slots.json fixture.

**Acceptance criteria.**
- **Slot lease.** With a slots.json that lists `_slot-1` leased by `feature` for a tick,
  `tumwater diff --role feature` reports the changes in `_slot-1`.
- **Fallback.** With no slots.json, every reader behaves exactly as before.
- **Retire a pinned slot.** It leaves `_slot-1` on disk, clean, detached and unpinned, and
  deletes the branch.
- `npm run test` green.

### Worktree pool, part 4/5: role ticks lease pooled slot worktrees (planned 2026-10-06 by operator; requires parts 1/5–3/5 landed)

Design: plans/worktree-pool.md ("Role ticks lease slots").

Context: each role keeps a persistent `.tumwater/worktrees/<role>` with its own build outputs,
yet at most `maxConcurrent` role ticks run at once. Every fresh tick already starts with
`reset --hard main`, so any recently used slot is about as warm as the role's own worktree.

**Approach.**
1. **Lease.** In `LoopRunner.runTick` (src/loop/loop.ts), every role except the director
   replaces `ensureWorktree(root, role, main)` with `leaseSlot({ role, purpose: "tick" })`.
   - On a slot that is not pinned for this role, run `git checkout -f tumwater/<role>` then
     `git clean -fd`.
   - When the branch is absent, run `git checkout -f -b tumwater/<role> <main>` instead. Never
     use `-B`: it would reset an existing branch and lose a commit that has no pin yet.
   - Everything after this stays as it is: `recoverLeftover`, `resetWorktreeToMain`, the
     red-main gate and `commitAll` all act on the branch through HEAD.
2. **Release,** in runTick's `finally`:
   - **When the role's state has `resumePending`:** pin the slot for the role. The branch stays
     checked out and the edits stay uncommitted.
     - pi 1.0.0's `--continue` only resumes a session whose recorded cwd equals the current
       directory exactly (session-manager.js `continueRecent`).
     - A resume anywhere else silently starts a fresh session, while `hasResumableSession`
       would still report one.
   - **Otherwise:** run `git checkout --detach`, so the branch is free for the role's next
     slot and keeps any commit.
   - Either way, a slot that was pinned for this role and is not re-pinned is unpinned.
3. **Pins.** A pinned slot is leased only by its role. Pins do not count toward `slotCount`, so
   a lease creates a new slot when every unpinned slot is busy and fewer than `slotCount`
   unpinned slots exist. Disk-floor reclaim treats pinned slots as resume-pending.
4. **Legacy migration,** once at orchestrator start, for each `.tumwater/worktrees/<role>`
   other than the director's:
   - **Role has `resumePending`:** register the directory in slots.json as that role's pinned
     slot at its existing path. Remove it with `removeWorktree` after the role's next release,
     instead of returning it to the pool.
   - **Otherwise:** `removeWorktree` it. The branch keeps any commit.
   
   Git refuses to check a branch out in two worktrees, so this must happen before any slot
   checks out a role branch.
5. **Director.** It keeps `ensureWorktree(root, DIRECTOR_ROLE, main)`.

**Files touched.** src/loop/loop.ts, src/git/worktree-pool.ts, src/git/slots-state.ts,
src/orchestrator/orchestrator.ts (migration), src/git/worktree.ts (if `ensureWorktree` becomes
director-only, say so in its doc). Tests: cases in test/worktree-pool.test.ts and the loop and
orchestrator tests that assert `.tumwater/worktrees/<role>` paths.

**Acceptance criteria.**
- **Pool size.** With `maxConcurrent: 2` and `worktreeSlots: 2`, three roles tick over time
  using at most two `_slot-*` directories. No `.tumwater/worktrees/<role>` is created for a
  non-director role.
- **Leftover commit.** A commit left on `tumwater/<role>` with no pin (simulate the crash
  window) is recovered by the role's next tick in whichever slot it leases.
- **Resume.** An aborted tick pins its slot. The role's next tick leases that same directory,
  resumes with `--continue` (the fake pi sees the same cwd), and unpins on release.
- **Pins and capacity.** While one slot is pinned and `worktreeSlots: 1`, another role's tick
  gets a new slot instead of waiting forever.
- **Migration.** A legacy clean role worktree is removed at startup. A legacy worktree with a
  pending resume serves exactly one resume and is then removed.
- **Director.** It still ticks in `.tumwater/worktrees/director`.
- `npm run test` green.

### Worktree pool, part 5/5: slot waits, slot display, doctor check and docs (planned 2026-10-06 by operator; requires part 4/5 landed)

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
src/status/status-data.ts, src/ui/status-model.ts, the GUI role-row renderer,
src/doctor/doctor-checks.ts, src/doctor/doctor.ts, docs/how-it-works.md. Tests: cases in the
pool, event-format, status and doctor tests.

**Acceptance criteria.**
- **Wait event.** A lease that waited 31 s logs one `slot_wait`. A lease that waited 1 s logs
  none.
- **Display.** Status and GUI show the slot of a running tick.
- **Doctor.** It warns on a 25 h-old pin and on a leftover `_land-feature` directory.
- `npm run test` green.

---

### Parallel work instances, part 1/7: one role, several loop ids — normalize every catalog-role lookup through `baseRoleOf` (planned 2026-10-07 by operator)

Design: plans/parallel-work-instances.md ("Identity: loop id vs. base role").

Context: a role's runner id keys its state, branch, refs, sessions, inbox, land-queue entry and
events, so a second instance only needs a distinct id such as `feature-2`. But a handful of
sites look the id up in the catalog or the config, or compare it to `"bugfix"`. With
`feature-2` those sites would silently pick defaults: no catalog entry, no model override, tier
1, and a `tumwater(feature-2):` subject that `workLanded` does not count. This part makes every
such site take the base role. With no instances configured it changes nothing.

**Approach.**
1. **Module.** New src/roles/loop-ids.ts:
   - `INSTANCE_ROLES = new Set(["feature", "bugfix"])`.
   - `baseRoleOf(id)`: `^(feature|bugfix)-([2-9]|[1-9][0-9]+)$` → its role; any other id →
     itself.
   - `instanceIndex(id)`: 1 for the bare id, N for `-N`.
   - `loopEnabled(config, id)`: true when `config.roles[baseRoleOf(id)]?.enabled` and
     `instanceIndex(id)` is at most that role's instance count, which is 1 until part 5/7.
2. **Runner.** `LoopRunner` (src/loop/loop.ts) gains `readonly baseRole = baseRoleOf(role)`.
   - `runTick`'s `this.role === "bugfix"` and the qa `extractFlow` check use `baseRole`.
   - The doc comment says `role` is the loop id.
3. **Role helpers.** In src/roles/roles.ts, `roleById`, `roleTier` and `yieldScaledRole`
   normalize their argument. Export `baselineBlocked(role)` and use it in place of
   `BASELINE_BLOCKED_ROLES.has` in src/baseline/main-red.ts.
4. **Config views.** In src/config/config-views.ts, `configForRole`, `roleSeamTier` and
   `fallbackRoleConfig` read `config.roles[baseRoleOf(role)]`.
5. **Scheduling.**
   - `isEligible` (src/scheduling/scheduling.ts) uses `loopEnabled`.
   - `deferTick` tests `DEFERRABLE_ROLES` and `BUGFIX_ROLE` on `baseRoleOf(role)`, as does
     orchestrator-scheduling.ts's `searchBugfix`.
   - The paused-roles check skips a runner when either its id or its base role is paused.
6. **Prompt.** `assembleTickPrompt` (src/tick/tick-prompt.ts) resolves the catalog role, the
   custom loop, the `qa`/`telemetry`/`clean` blocks and `config.roles[…].instructions` by base
   role. It keeps the loop id for the inbox and the notebook.
7. **Commit subject.** `stampedSubject(baseRoleOf(ctx.role), …)` in src/tick/tick-stage.ts and
   src/verdict/refusal.ts. The trailer keeps the loop id (`Tick: feature-2 #N`).
8. **Gates.**
   - `pollRoleCapGate` (src/gates/role-cap-gates.ts) groups runners by base role, sums their
     `dailyCost` against `maxDailyCostUsdPerRole[base]`, and pauses every runner in the group.
   - gate-polls.ts's quiet-hours and budget-tier lookups use the base role.
   - In src/tick/tick-apply.ts, `OBSERVER_ROLES.has` takes the base role.
9. **Operator fan-out.** `roleRequestTargets` (src/operator/operator-requests.ts) matches a
   requested id against both `r.role` and `r.baseRole`.
10. **Validation.** A `customLoops[].name` matching the instance pattern is a validation error
    (src/config/config-validation.ts).

**Files touched.** src/roles/loop-ids.ts (new), src/roles/roles.ts, src/loop/loop.ts,
src/config/config-views.ts, src/config/config-validation.ts, src/scheduling/scheduling.ts,
src/orchestrator/orchestrator-scheduling.ts, src/tick/tick-prompt.ts, src/tick/tick-stage.ts,
src/tick/tick-apply.ts, src/verdict/refusal.ts, src/baseline/main-red.ts,
src/gates/role-cap-gates.ts, src/gates/gate-polls.ts, src/operator/operator-requests.ts.
Tests: test/loop-ids.test.ts (new), plus cases in the scheduling, tick-prompt, tick-stage,
role-cap-gate and config-validation tests.

**Acceptance criteria.**
- **Ids.** `baseRoleOf("feature-2")` is `feature`, `baseRoleOf("bugfix-10")` is `bugfix`, and
  `baseRoleOf("feature-1")`, `baseRoleOf("clean-2")` and `baseRoleOf("my-loop")` are unchanged.
- **Runner.** A `LoopRunner` built directly as `feature-2`:
  - gets the feature charter and `roles.feature.instructions` in its prompt;
  - resolves `roles.feature.model`;
  - sorts in tier 0;
  - stamps `tumwater(feature):` with trailer `Tick: feature-2 #1`;
  - writes `.tumwater/state/feature-2.json`.
- **bugfix-2** gets the red-main handoff note, not the block.
- **Caps.** `maxDailyCostUsdPerRole.feature: 1` with instances `feature` and `feature-2` at
  $0.60 each pauses both.
- **Validation.** A custom loop named `feature-2` fails validation.
- **No regression.** With no instances configured, every existing test passes unchanged.
- `npm run test` green.

### Parallel work instances, part 2/7: mark backlog entries blocked by an unlanded prerequisite, refused, or needing review (planned 2026-10-07 by operator)

Design: plans/parallel-work-instances.md ("Eligibility").

Context: plan series serialize through heading clauses such as `requires part 1/4 landed`,
`requires parts 1/5–3/5 landed` and `requires Disk floor 2/4 and Worktree pool 1/5 landed`.
Nothing parses them today. Every feature tick reads entries it cannot do yet, and the harness
cannot count how much work is actually available. On 2026-10-07 only 1 of the 7 planned
entries was unblocked.

**Approach.**
1. **Module.** New src/backlog/backlog-eligibility.ts, pure over markdown text:
   - `entryKey(title)`: `ENTRY_STAMP_META_RE` (src/backlog/backlog-structure.ts) stripped,
     whitespace collapsed, lowercased.
   - `seriesPart(title)`: `{ series, part, of }` from `<Series>, part i/n:`, or null.
   - `requiredParts(title)`: parse only the heading's trailing parenthetical.
     - The clause is `requires <ref>((, | and )<ref>)* landed`, with a ref of
       `[<Series>] [part|parts] i/n[(–|-)j/n]`. Ranges expand.
     - A bare ref means the entry's own series.
     - An unparseable clause gives `[]`.
   - `entryHold(entry, planned)`: `"refused"` when the body has a `**Refused ` line;
     `"needs-review"` for the `NEEDS_REVIEW_NOTE` prefix; `"needs-replan"` for the
     `NEEDS_REPLAN_NOTE` prefix (once the replan entry has landed); `{ blockedBy: string[] }` when a
     required `(series, part)` is still among `planned`; else `null`.
   - `eligibleEntries(root, role)`: from `plannedPlanEntries` for feature or `openBugEntries`
     for bugfix (src/backlog/backlog.ts), each with its key, title and line range (via
     `actionableEntryRanges`), in file order. It keeps only entries whose `entryHold` is null.
2. **Index.** `renderBacklogIndexBlock` appends ` [blocked: requires <Series i/n>, …]`,
   ` [refused]` or ` [needs review]` to held entries.
3. **Charter.** The feature charter's step 2 (src/roles/role-catalog.ts) says to skip entries
   marked blocked in the index.

**Files touched.** src/backlog/backlog-eligibility.ts (new),
src/backlog/backlog-structure.ts, src/roles/role-catalog.ts. Tests:
test/backlog-eligibility.test.ts (new), using every `requires` form in PLANS.md's history,
plus cases in the backlog-index test.

**Acceptance criteria.**
- **Live headings.** Against the 2026-10-07 `## Planned`:
  - Disk floor 2/4 is eligible;
  - Disk floor 3/4 and 4/4 are blocked by Disk floor 2/4;
  - Worktree pool 2/5 is blocked by Disk floor 2/4. Worktree pool 1/5 is not planned, so it
    does not block;
  - Worktree pool 4/5 is blocked by 2/5 and 3/5.
- **Body text** containing "requires" never blocks.
- **Refused.** An entry with a Refused note is ineligible and indexed `[refused]`.
- **Unparsed clauses.** A clause like "land that plan first" blocks nothing.
- `npm run test` green.

### Parallel work instances, part 3/7: insert-only conflicts in PLANS.md, BUGS.md and QUESTIONS.md resolve without a model run (planned 2026-10-07 by operator)

Design: plans/parallel-work-instances.md ("Insert-only backlog conflicts").

Context: the move guidance (`backlogMoveGuidance`, src/roles/role-guidance.ts) pastes every
finished entry as the first one under `## Done` or `## Fixed`. Two landings off the same base
therefore conflict at that line, and the second one pays a strong-tier resolver run
(`resolveConflict`, src/landing/landing-merge.ts). This already happens between bugfix and the
director on BUGS.md. With several feature instances it would happen on nearly every landing.
Keeping both inserted sides adds no authored bytes, so no model is needed.

**Approach.**
1. **Diff3.** `rebaseOntoMainLeaveConflicts` (src/landing/landing-git.ts) runs the rebase
   with `-c merge.conflictStyle=diff3`.
2. **Resolver.** New src/landing/backlog-conflicts.ts: `resolveBacklogInsertConflicts(wt,
   files)`. For each conflicted `PLANS.md`, `BUGS.md` or `QUESTIONS.md` at the repo root, it
   parses the `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` hunks.
   - **A hunk with an empty base section and two non-empty sides** is replaced by the change's
     lines, then one blank line if neither side supplies a separator, then main's lines.
   - **Any other hunk** leaves that file untouched.
   - Files resolved entirely are written and `git add`ed. It returns the files still
     conflicted.
3. **Wiring.** In `resolveConflict`, call it first.
   - With none left, `continueRebase` runs without a pi run.
   - Otherwise `buildConflictPrompt` lists only the remaining files.
   - The existing `resolvedDiffDiverges` and `verifyLanding` checks run unchanged.

**Files touched.** src/landing/backlog-conflicts.ts (new), src/landing/landing-git.ts,
src/landing/landing-merge.ts. Tests: test/backlog-conflicts.test.ts (new), plus a
landing-merge case using two real branches that each move a different plan to `## Done`.

**Acceptance criteria.**
- **Insert-only.** Two changes that each move a different `## Planned` entry to the top of
  `## Done` land back to back with no conflict-resolution pi run. The later one's entry sits
  first, both entries are present once, and no re-review runs.
- **Same entry.** Two changes editing the same entry's body still go to the pi resolver.
- **Mixed.** With a code conflict next to an insert-only PLANS.md conflict, the resolver
  prompt names only the code file.
- **Structure.** The resolved PLANS.md passes `backlogStructureReason` and
  `duplicateHeadings`.
- `npm run test` green.

### Parallel work instances, part 4/7: the harness assigns each multi-instance loop one backlog entry and holds the claim through landing (planned 2026-10-07 by operator; requires parts 1/7 and 2/7 landed)

Design: plans/parallel-work-instances.md ("Claims").

Context: if instances picked work themselves, those started in the same poll would read the
same index and pick the same entry. `pollRunnerReasons` (src/orchestrator/orchestrator-scheduling.ts)
is serial, so assigning there cannot race. Storing the claim in `LoopState` makes resumes,
leftover recovery, revisions (plans/revise-rejected.md) and restarts carry it with no new store.
This part only acts for a role with more than one runner, so tests build two runners directly,
and the fleet is unchanged until part 5/7.

**Approach.**
1. **State.** `LoopState.claim?: { file: "PLANS.md" | "BUGS.md"; key; title; at; source:
   "assigned" | "staged" }` (src/loop/loop-state.ts).
2. **Module.** New src/scheduling/claims.ts:
   - `heldKeys(runners, eligibleKeys, listedKeys)`;
   - `assignNext(free)`: the first free entry in file order. Overlap between claimed entries'
     files is allowed: conflicts are settled at landing (Robust conflict landing 1/2–2/2);
   - `claimReleaseReason(runner, ctx)`: one of `left` (key no longer listed), `ineligible`,
     `disabled` (not `loopEnabled`, idle, no queued landing, no `revision`), `stale` (older
     than `CLAIM_IDLE_MAX_MS` = 24 h, and the runner is idle with no queued landing, no
     `revision` and no `resumePending`), or null.
3. **Scheduling.** In `pollRunnerReasons`, once per multi-instance base role, compute
   `eligibleEntries` (part 2/7) and release the claims that `claimReleaseReason` names. For
   each runner that passes every gate, just before `reasons.set`:
   - **It holds a claim:** proceed.
   - **Reason is not `inbox`/`resume` and `free` is non-empty:** assign `assignNext(free)` and
     log `claim` `assigned`.
   - **Index ≥ 2, no claim, empty `free`:** `continue`. No tick runs and no backoff is touched.
   - **Primary, no claim, empty `free`:** proceed unassigned, as today.
4. **Prompt.** `buildAssignmentNote(claim, range, othersHeld)` (src/gates/gate-prompts.ts) is
   appended by `assembleTickPrompt` when `state.claim` is set and no user request was dequeued.
   It says:
   - implement or fix only that entry, which replaces the charter's choosing step;
   - if it is too large, add the Needs-review note and end with that note only;
   - if it should not be done, refuse it;
   - do not edit the other held entries.

   With no claim but held entries, a one-line exclusion list is appended.
5. **Claim at staging** (src/tick/tick-stage.ts), comparing the worktree's PLANS.md or BUGS.md
   to the merge-base with `actionableEntryRanges`:
   - **An unassigned tick** whose diff removes an entry from `## Planned`/`## Open` records
     `claim { source: "staged" }`.
   - **An assigned tick** that removes a different entry yields a stage-check finding, "assigned
     <X>, moved <Y>", which gets one fix-up turn (src/tick/stage-check.ts).
6. **Release after a tick.** In `finalizeTick` (src/tick/tick-finalize.ts), results
   `no_change`, `refused`, `user_aborted` and `skipped`, with no `revision` and no
   `resumePending`, clear the claim and log `claim` `released`. Every other result keeps it.
7. **Event.** `claim` with `action` (`assigned` / `released`), `key`, `title` and `reason`
   (src/events/events.ts).

**Files touched.** src/loop/loop-state.ts, src/scheduling/claims.ts (new),
src/orchestrator/orchestrator-scheduling.ts, src/tick/tick-prompt.ts,
src/gates/gate-prompts.ts, src/tick/tick-stage.ts, src/tick/stage-check.ts,
src/tick/tick-finalize.ts, src/events/events.ts. Tests: test/claims.test.ts (new), plus cases in
the orchestrator-scheduling, tick-prompt, tick-stage and tick-finalize tests.

**Acceptance criteria.**
- **Distinct entries.** Runners `feature` and `feature-2`, with two eligible plans and both due
  in one poll, get different claims, and each prompt names its own entry.
- **Idle extra.** With one eligible plan, `feature-2` is not admitted and its state's
  `nextRunAt` and `backoffSeconds` are untouched.
- **Blocked entries** are never assigned.
- **Held through.** The claim survives `queued`, a rejection with a revision (the revision tick
  re-applies on the same instance and keeps the claim), a conflict hand-back, and a crash and
  resume. An exhausted revision ends in a Needs-replan note, which makes the entry ineligible
  and releases the claim.
- **Released by** the entry landing into `## Done` (next poll), a `no_change` tick, a Refused
  note, and the 24 h idle stale rule (with a warning).
- **Staging.** An unassigned primary that moves plan X gets `claim` X with source `staged`. An
  assigned tick that moves Y gets the stage-check finding.
- **Single runner.** With one runner per role, prompts and scheduling are unchanged.
- `npm run test` green.

### Parallel work instances, part 5/7: `roles.<id>.instances` runs several feature or bugfix loops, each active only while unclaimed work exists; the plan target scales (planned 2026-10-07 by operator; requires parts 3/7 and 4/7, Robust conflict landing 2/2 and Worktree pool 4/5 landed)

Design: plans/parallel-work-instances.md ("Spawning instances and keeping the plan loop
ahead").

Context: once Worktree pool 4/5 makes role ticks lease `_slot-<n>` checkouts, an extra loop
adds no checkout. Its tick and vet use the same slots, so a project with a large `target/`
pays nothing extra on disk. Before the pool, each instance would carry its own role and lander
worktree; hence the prerequisite. The plan charter currently stops at two waiting plans
(src/roles/role-catalog.ts, plan step 1), which cannot keep several feature instances busy.

**Approach.**
1. **Config.** `RoleConfig.instances?: number` (src/config/config-schema.ts): an integer from
   1 to 8, valid only under `roles.feature` and `roles.bugfix`, defaulting to 1. It touches
   validation, src/config/config-editable-keys.ts (so `config set roles.feature.instances 3`
   works), tumwater.example.json, src/config/config-example.ts and the docs config table.
2. **Ids.** `loopIdsFor` and `loopIds(config)` in src/roles/loop-ids.ts expand enabled roles by
   instances. `loopEnabled` reads the configured count. `knownRoleIds` (src/config/config.ts)
   includes the ids, so the CLI and GUI accept `--role feature-2`.
3. **Runners.**
   - `runOrchestrator` (src/orchestrator/orchestrator.ts) builds runners from `loopIds`.
   - `newLiveConfigReload` (src/config/config-live.ts) adds runners for new ids and logs one
     warning per instance started or stopped. Surplus runners stay in place and are skipped
     by `loopEnabled`.
   - `snapshot` (src/status/status-data.ts) lists loop ids.
4. **Plan target.** In the plan charter, "two or more plans" becomes `{{planTarget}}
   eligible plans`. `assembleTickPrompt` substitutes `planBacklogTarget(config) =
   instances(feature) + 1` and counts eligibility per part 2/7. With instances > 1 the charter
   asks the plan loop to prefer a plan independent of the waiting series.
5. **Docs.** plans/merge-queue.md invariant 3 becomes "one in-flight landing per loop".

**Files touched.** src/config/config-schema.ts, src/config/config-validation.ts,
src/config/config-editable-keys.ts, src/config/config-example.ts, src/config/config.ts,
src/config/config-live.ts, src/roles/loop-ids.ts, src/orchestrator/orchestrator.ts,
src/status/status-data.ts, src/roles/role-catalog.ts, src/tick/tick-prompt.ts,
tumwater.example.json, plans/merge-queue.md, docs (config reference). Tests: cases in the
config-validation, config-live, orchestrator e2e and tick-prompt tests.

**Acceptance criteria.**
- **Startup.** With `roles.feature.instances: 3` and two eligible plans, an e2e run starts
  `feature` and `feature-2` on different plans, never starts `feature-3`, and leases slots only
  (no `.tumwater/worktrees/feature-2`).
- **Live edit.** Raising `instances` from 1 to 2 starts `feature-2` within one poll. Lowering
  it back stops new ticks and leaves an in-flight landing to finish.
- **Landing.** Both instances' landings land with no resolver run (part 3/7). Each instance's
  next tick is blocked only by its own landing.
- **Bugfix.** `roles.bugfix.instances: 2` with an empty `## Open` runs only `bugfix`, in
  search mode.
- **Validation.** `roles.plan.instances: 2` fails, and so does `instances: 0`.
- **Plan prompt.** It names the target 4 when `feature.instances` is 3.
- `npm run test` green.

### Parallel work instances, part 6/7: show instances and claims on status, TUI, GUI, logs and doctor (planned 2026-10-07 by operator; requires part 5/7 landed)

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

### Parallel work instances, part 7/7: keep permit headroom for work loops that have work to take (planned 2026-10-07 by operator; requires part 5/7 landed)

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

### Robust conflict landing, part 1/2: the conflict resolver sees what both sides meant, not only the markers (planned 2026-10-07 by operator; done 2026-10-07 by feature)

Context: when a rebase onto main conflicts, `resolveConflict` (src/landing/landing-merge.ts)
gives a strong-tier pi run `buildConflictPrompt(roleId, files, check)`
(src/gates/gate-prompts.ts). That prompt lists the conflicted files and says to "combine the
intent of BOTH sides", but it states neither side's intent:
- the change's own commit message (subject, WHY body, and the backlog entry it implements);
- the main commits that touched the conflicted files since the change's merge-base.

Conflicts are rare today: 2 `merge_conflict` landings against 916 merges in the 7 days before
2026-10-07. Parallel work instances (plans/parallel-work-instances.md) will make overlapping
landings routine, so the resolver needs that context before they ship.

**Approach.**
1. **Gather.** In `resolveConflict`, before the pi run:
   - **The change's side:** its full commit message, `git log --format=%B -1 <preMergeHead>`.
     The harness stamps that message, so it carries the subject, the WHY body and the trailer.
   - **Main's side:** for each conflicted file, the commits on main since the merge-base that
     touched it, from a `git log` over `<merge-base>..<main>` with the files as pathspec. Cap
     each body at 20 lines and the whole list at 15 commits, newest first, and say so when it
     is cut.

   `mainCommitsTouching` (added to src/landing/landing-git.ts) returns the capped list plus
   the omitted count; the change's message comes from the existing `commitMessage` in
   src/git/git.ts.
2. **Prompt.** `buildConflictPrompt` gains an optional `intent: { change: string; main:
   Array<{ sha; subject; body }>; mainOmitted?: number }`. The prompt renders it as two short
   blocks, "This branch's change" and "What main changed in these files". Both are labelled as
   data, and the existing rules stay as they are. The rule that "a deliberate removal on main
   wins" now cites the main block; `mainOmitted` prints the "(N more not shown)" line.
3. **Divergence.** No change to `resolvedDiffDiverges` or the re-review: a resolution that
   leaves the reviewed lines still gets re-gated.

**Files touched.** src/landing/landing-merge.ts, src/landing/landing-git.ts,
src/gates/gate-prompts.ts. Tests: cases in the gate-prompts test and a landing-merge test using
two real branches.

**Acceptance criteria.**
- **Both sides shown.** A conflicted landing's resolver prompt contains the change's commit
  subject and WHY body, plus the subject of each main commit since the merge-base that touched
  a conflicted file.
- **Only relevant commits.** Main commits that touched no conflicted file are not listed.
- **Caps.** The caps hold, with a "(N more not shown)" line when the list is cut.
- **No intent supplied.** The prompt keeps its pre-part-1/2 text — no intent blocks, no citation.
- `npm run test` green.

### Disk floor, part 2/4: reclaim gitignored build outputs from idle worktrees when free space runs low (planned 2026-10-06 by operator; requires part 1/4 landed; done 2026-10-07 by feature)

Design: plans/disk-floor.md ("Reclaiming build outputs").

**Goal.** Before the hold from part 1/4 engages, delete the files git ignores (`git clean -fdX`)
in harness worktrees that nothing is using, least recently used first. Build outputs of every
ecosystem go this way (`target/`, `node_modules/`, `dist/`, `.venv/`) without the code naming
any of them. An interrupted tick's uncommitted edits survive: `-X` removes only ignored files.

**Approach.**
1. **Use registry.** New file src/git/worktree-use.ts:
   - `useWorktree(root, dir, fn)` holds a use count around `fn`. On release it records
     `lastUsedAt` for the dir's basename in `.tumwater/state/worktree-use.json`, through
     `writeJsonAtomic` and a new `worktreeUsePath(root)` in src/paths.ts.
   - `claimForReclaim(dir)` returns false while the worktree is in use. Otherwise it marks the
     worktree as reclaiming until `releaseReclaim(dir, at)`, which records `reclaimedAt`. A
     `useWorktree` that arrives meanwhile awaits the release before `fn` runs.
   - A worktree the registry has never seen counts as used at first sight: `reclaimCandidates`
     seeds it with `lastUsedAt = now` and leaves it out of that pass, so an upgrade under
     pressure does not sweep every warm build at once.
2. **Wrap the users.** Each holds its worktree from before the create/reset to its last touch:
   - `LoopRunner.runTick` (src/loop/loop.ts), from before `ensureWorktree` to the tick's end;
   - `vetRequest` (src/landing/landing-batch.ts);
   - `landApprovedChange` (src/landing/landing-core.ts);
   - `landStack` (src/landing/landing-stack.ts);
   - the `_gate-main` run in src/baseline/main-red.ts.
3. **Reclaim.** New file src/fleet/reclaim.ts:
   - `reclaimCandidates(root)` lists the linked worktrees directly under `worktreesDir(root)`,
     minus `_main`, `_build` and those in use. They are ordered least recently used first, with
     roles whose loop state has `resumePending` last.
   - `reclaimWorktree(root, dir)` checks a guard first. The resolved path must lie inside
     `worktreesDir(root)`, and `git rev-parse --git-dir` must differ from `--git-common-dir`,
     which proves it is a linked worktree and never the primary checkout. The primary checkout
     ignores `.tumwater/` itself. It then runs `git -C dir clean -fdX`: a single `-f`, never
     `-x`, never `-ff`. It reports true only when git actually removed a path, so a clean with
     nothing to do counts as no reclaim and is neither logged nor named.
   - `reclaimPass(root, "pressure", …)` cleans candidates until the re-sampled free space
     reaches `diskReclaimGB`. It logs one `disk_reclaim` { mode, worktrees, freedGB, freeGB,
     durationMs } when it cleaned anything. `freedGB` is the statfs delta, not `du`, clamped at
     0 so a concurrent writer cannot render it negative.
4. **Orchestrator.** While free space is below `diskReclaimGB`, start a pressure pass in the
   background: one at a time, and never awaited, like `launchServicesWatch.poll()`.
   `ReclaimController.poll` starts one pass per drop and returns whether the disk hold must
   wait for that pass; once it settles the hold may engage unless free space recovered.
   `pollDiskGate` enters the hold only then. With `diskReclaimGB: 0` it holds immediately, as in
   part 1/4.
5. **Config.** Add `diskReclaimGB`, default 40. 0 disables pressure reclaim. Validation
   requires it to be at least `diskHoldGB` unless it is 0. It touches the same config and doc
   spots as part 1/4.
6. **Doctor.** `checkDiskSpace` warns between `diskHoldGB` and `diskReclaimGB`.

**Files touched.** src/git/worktree-use.ts (new), src/fleet/reclaim.ts (new), src/paths.ts,
src/loop/loop.ts, src/landing/landing-batch.ts, src/landing/landing-core.ts,
src/landing/landing-stack.ts, src/baseline/main-red.ts, src/tick/tick-resume.ts,
src/orchestrator/orchestrator.ts, src/gates/gate-polls.ts, src/gates/disk-gate.ts,
src/config/config-schema.ts, src/config/config.ts, src/config/config-validation.ts,
src/events/events.ts, src/events/event-format.ts, src/doctor/doctor-checks.ts,
src/doctor/doctor.ts, docs/how-it-works.md. Tests: test/worktree-use.test.ts and
test/reclaim.test.ts (new), plus disk-gate, config and doctor cases.

**Acceptance criteria.**
- **Only ignored files go.** In a temp repo, take a linked worktree holding a modified tracked
  file, an untracked file, an ignored `build/` dir and a nested repo. After `reclaimWorktree`,
  everything except `build/` remains.
- **Guard.** `reclaimWorktree` throws and deletes nothing when pointed at the primary checkout
  or at a path outside `worktreesDir`.
- **In use.** An in-use worktree is never cleaned. A `useWorktree` that starts during a clean
  runs `fn` only after the clean finishes.
- **Order.** Pressure mode cleans least recently used first and stops once the sampler reports
  `diskReclaimGB`. A resume-pending role's worktree is cleaned only after every other
  candidate. `_main` and `_build` are never candidates.
- **Hold.** With free space below the floor, the hold engages only after a pressure pass
  completes, and does not engage when that pass restored the floor.
- **Event.** A pass logs exactly one `disk_reclaim` naming the cleaned worktrees.
- `npm run test` green.

### Revise rejected changes, part 2/2: the re-review sees the prior objections and what the revision changed (planned 2026-10-06 by operator; requires part 1/2 landed and running; done 2026-10-07 by feature)

Context: the same audit found reviews of one idea flip between rounds, because each reviewer
starts with no memory of the previous review.
- On 09-28, bugfix's 2464b72f was rejected only for a wrong test count. Its re-land, 612848d4,
  was then rejected for real bugs the first review had missed, such as `commandBuffersOutput`
  misreading `2>>`.
- On the core→ui digest move, one rejection implied the change could re-land once its records
  were fixed. The next rejected it as a rule violation.
- Feature's timed pause got a different set of objections in each of its eight rounds.

Once part 1/2 keeps the rejected diff, the reviewer can be shown which objections a revision
had to resolve and what it changed to resolve them.

**Goal.** When a landing is a revision (`revisionRound` ≥ 1), the reviewer gets two things:
- the prior review's numbered objections, with the instruction to check each one first (one
  left unresolved is a rejection on its own);
- the interdiff between the rejected version and the revision.

It still reviews the whole diff as usual.

**Approach.**
1. **`src/landing/landing-queue.ts`, `src/landing/landing-core.ts`.**
   - `LandingEntry` and `LandRequest` gain `priorReview?: { sha: string; reasons: string[] }`.
   - `stageTickLanding` (src/tick/tick-stage.ts) fills it from `state.lastReview` when the tick
     was a revision.
   - A recovery landing reads it back as absent, so an orphaned revision is reviewed like a
     fresh change.
2. **`src/git/git-diff.ts`.** Add `revisionInterdiff(wt, mainBranch, priorSha, head)`:
   - it runs `git range-diff <changeBaseRev(prior)>..<prior> <changeBaseRev(head)>..<head>`;
   - it applies `aheadOfMainDiff`'s cap and truncation note;
   - it never throws, and returns empty on any git failure, including a prior object that is
     gone. Part 1/2's rejected ref keeps the object alive until the revision lands.
3. **`src/review/review.ts`.** `reviewAheadOfMain` takes the optional prior review and passes it,
   with the interdiff, to `buildReviewPrompt`.
4. **`src/gates/gate-prompts.ts`.** `buildReviewPrompt` gains an optional `priorReview`
   parameter. Its block goes right after the author's commit body:
   - this change is revision N of one rejected in review;
   - the objections, numbered, and the interdiff;
   - every objection must be resolved, and an unresolved one is a finding by itself;
   - new findings must be concrete and verifiable, as always.

   The prompt keeps the literal "VERDICT:" exactly twice, because test/gate-prompts.test.ts
   derives the accepted forms from it.
5. **`src/events/event-format.ts`.** A revision's `review_start` carries `revision: N`, rendered
   as `review (revision N)`.

**Files touched.** src/landing/landing-queue.ts, src/landing/landing-core.ts,
src/tick/tick-stage.ts, src/git/git-diff.ts, src/git/git.ts (changeBaseRev gains a `rev`
argument), src/review/review.ts, src/gates/gate-prompts.ts, src/events/event-format.ts,
src/events/events.ts (comment), src/landing/landing-vetting.ts and src/landing/landing-drain.ts
(carry PriorReview from the queue entry onto the LandRequest). Tests: test/gate-prompts.test.ts,
test/review.test.ts, test/event-format.test.ts, test/tick-stage.test.ts, and a new
test/revision-interdiff.test.ts.

**Acceptance criteria.**
- **Prompt.** With a prior review, `buildReviewPrompt` contains each objection, the interdiff
  and the resolve-first instruction. Without one it is byte-identical to today's prompt, and
  "VERDICT:" still appears exactly twice.
- **Interdiff.** On a scratch repo where a commit is rebased onto a moved main and then
  amended, `revisionInterdiff` shows only the amendment, not main's movement. A missing prior
  sha yields an empty string, not a throw.
- **Events.** A revision landing's `review_start` carries `revision`; a fresh landing's does
  not.
- **Recovery.** A recovery landing of a revision is reviewed without the prior block.
- `npm run test` green.

**Implementation note (2026-10-07):** `revisionInterdiff` passes `--creation-factor=100` to
`git range-diff`. At the default 60% a two-line change can fail to pair with its revision and
render as two unrelated commits, which is exactly the small-revision case; the acceptance
criterion's scratch-repo scenario fails without it.

### Revise rejected changes, part 1/2: a rejected change goes back to its author as uncommitted edits instead of being discarded (planned 2026-10-06 by operator; done 2026-10-07 by feature)

Context: a 2026-10-06 audit of the review gate covered events.jsonl since 2026-09-22.
- **Volume.** Of about 2,070 landing attempts, 1,658 landed and 292 were rejected (14%).
  Rejected changes consumed about 21% of recorded authoring spend. The feature loop's
  rejection rate was 37%, about 44% of its authoring hours.
- **Fixability.** Each of the window's 301 rejections was labelled by hand. Of the 260 that
  were not build-check failures, 77% were fixable by a message fix, a BUGS/PLANS fix or a
  few-line code change. Only 32 said the change should not exist.
- **What happens instead.** The reject path discards the work. `reviewAheadOfMain`'s `reject`
  closure (src/review/review.ts) resets the branch to main, and `reviewPinnedChange`
  (src/landing/landing-core.ts) deletes the pin. The author's next tick gets only the reasons
  (`buildRejectedReviewNote`) and re-derives the whole change from scratch. Each rewrite tends
  to add new defects, and a fresh reviewer finds different ones:
  - feature's timed pause was rejected eight times between 09-25 13:35 and 09-28 04:11, a
    different bug each round, before it landed at 07:35;
  - plan 4a/7 was rejected five times on 09-22, and per-role prompts four times on 09-25;
  - 65 rejections were followed directly by another rejection.
- **The earlier fix.** BUGS.md "A review rejection is invisible to every loop-level alarm"
  (fixed 2026-10-01) bounded how often a role re-authors after rejections, but not what each
  attempt costs. Its own analysis noted each attempt "pays the full authoring price instead of
  a cheap correction".

Why the author revises and not the reviewer:
- The reviewer's only output channel is its verdict, so every byte that lands was judged by a
  run that did not write it.
- An in-slot build-fix run was tried and removed in 4e9bf7f1 ("Attribute a repeat gate-check
  failure through main's baseline instead of an in-slot fix run"). It held the landing slot for
  hours and never led to a landing.

A revision instead runs on the author's own slot at its normal cadence, and goes through the
full gate again. Check-failure rejections become revisions too. That covers the compile breaks a
clean rebase cannot see, such as organize's 10-05 23:26 TS2307: a file another loop had just
added still imported a module organize moved.

**Goal.** A rejected change goes back to its author for at most two revision rounds. The
author's next tick starts with the rejected diff re-applied onto current main as uncommitted
edits. It fixes the named objections or drops the change. Whatever it produces lands through
the normal gate.

**Approach.**
1. **Keep the commit.**
   - `src/paths.ts` gets `rejectedRefName(role)` → `refs/tumwater/rejected/<role>`.
   - In `reviewPinnedChange`'s `rejected` branch (src/landing/landing-core.ts), point that ref at
     the rejected head (`state.lastReview.head`) before the landing ref is deleted, so the
     object survives gc.
2. **Count rounds.**
   - `LandingEntry` (src/landing/landing-queue.ts) and `LandRequest` (landing-core.ts) gain
     `revisionRound?: number`, absent for a fresh change. On a rejection,
     `next = (req.revisionRound ?? 0) + 1`.
   - When `next <= REVISION_LIMIT` (2, a constant in a new `src/loop/revision.ts`), set
     `LoopState.revision = { sha, round: next, at }` (src/loop/loop-state.ts).
   - Past the limit, clear `revision`, delete the rejected ref, and log `exhausted` (step 7).
     The plain rejected note then says the change was rejected after its last revision.
3. **Re-apply at tick start.** In `LoopRunner.runTick` (src/loop/loop.ts), after
   `resetWorktreeToMain` and the red-main gate, and before `runRolePi`, call
   `applyRevision(wt, mainBranch, sha)` (src/loop/revision.ts) when all of these hold: `s.revision`
   is set, the role is not the director, and this tick dequeued no user request.
   - It runs `git cherry-pick --no-commit <merge-base>..<sha>`, leaving the edits uncommitted.
   - On a conflict it runs `git cherry-pick --abort`, resets to main, and returns false.
4. **Prompt.** When `s.revision` is set, src/tick/tick-prompt.ts skips `buildRejectedReviewNote`
   and runTick appends one note after the apply.
   - **The diff applied.** Append `buildRevisionNote(lastReview, round, REVISION_LIMIT)`
     (src/gates/gate-prompts.ts). It says:
     - this tick's one task is revising the change already in the worktree;
     - fix each numbered objection with the smallest edit that resolves it, and keep everything
       else;
     - rewrite the closing SUMMARY/WHY/RISK/VERIFIED block so it describes the whole change as
       it now stands;
     - for a build-check failure in a test the change does not touch that you cannot reproduce,
       say so in RISK and keep the change as is;
     - when an objection shows the change should not exist (its premise disproven, it
       duplicates main, it has no reachable benefit), end with the nothing-to-do sentinel
       instead.
   - **The diff did not apply.** Clear `revision`, delete the ref, and append today's
     `buildRejectedReviewNote` plus one sentence saying the rejected diff no longer applies to
     current main.
5. **Drop.** In `resolveTickVerdict` (src/tick/tick-verdict.ts), a revision tick
   (`revisionRound` carried in its context) whose reply declares nothing-to-do while the
   worktree is dirty:
   - resets the worktree to main, clears `revision` and deletes the rejected ref;
   - ends `no_change` and does not stage. Today a dirty worktree always stages.
6. **Stage.**
   - `stageTickLanding` (src/tick/tick-stage.ts) copies the tick's `revisionRound` onto the
     `LandingEntry`.
   - The tick clears `s.revision`, since the revision is now in flight.
   - When that landing lands, delete the rejected ref.
7. **Events.** One `revision` event: `action` (`"applied" | "conflict" | "dropped" |
   "exhausted"`), `round` and `sha`. src/events/event-format.ts renders it, `tumwater logs` shows
   it, and the digest can measure revision yield.

**Files touched.** src/paths.ts, src/loop/revision.ts (new), src/loop/loop-state.ts,
src/loop/loop.ts, src/landing/landing-core.ts, src/landing/landing-queue.ts,
src/tick/tick-prompt.ts, src/tick/tick-verdict.ts, src/tick/tick-stage.ts,
src/gates/gate-prompts.ts, src/events/event-format.ts, src/git/commit-message.ts. Tests:
test/revision.test.ts (new), plus cases in test/lander.test.ts, test/tick-verdict.test.ts,
test/tick-stage.test.ts, test/tick-prompt.test.ts and test/gate-prompts.test.ts.

**Acceptance criteria.**
- **Rejection.** A gate rejection of a fresh change sets `refs/tumwater/rejected/<role>` to
  the rejected head and `LoopState.revision.round` to 1. A rejection of a round-2 revision
  clears `revision`, deletes the ref and logs `revision` `exhausted`.
- **Apply.** The role's next tick starts with the rejected diff applied as uncommitted edits
  on a main that moved in an unrelated file, and its prompt carries the revision note instead
  of the plain rejected note.
- **Conflict.** When the diff conflicts with current main, the worktree is clean main,
  `revision` is cleared, the prompt carries the plain note plus the no-longer-applies sentence,
  and `revision` `conflict` is logged.
- **Drop.** A revision tick that replies nothing-to-do ends `no_change` with a clean worktree,
  no landing queued, and `revision` `dropped` logged.
- **Stage.** A revision tick that stages queues a `LandingEntry` carrying its `revisionRound`.
  That landing's rejection yields round 2, and its landing deletes the rejected ref.
- **Exclusions.** The director never revises. A tick that dequeued a per-role user request
  leaves `revision` untouched.
- `npm run test` green.

**Landed 2026-10-07 — two adjustments from the first attempt's review.** (1) The revision round
also rides the commit's harness-stamped `Revision: N` trailer (src/git/commit-message.ts), and
leftover recovery reads it back, so a retriable revision whose queue marker is lost keeps its
round instead of resetting to 1, and its eventual landing still deletes the rejected ref. (2) A
conflict-resolution re-review rejection (landApprovedChange) records the rejected change for
revision through the same shared `recordRejectedChange` helper as a pinned change's rejection,
rather than silently discarding it.

### Disk floor, part 1/4: hold new work when the worktrees volume runs low on free space (planned 2026-10-06 by operator; done 2026-10-07 by feature)

Design: plans/disk-floor.md ("Measuring free space", "The hold").

Context: a fleet running on a Rust repo filled the disk of the user's smaller machine.
- Every harness worktree builds the project, so every worktree grows its own `target/` of
  several GB. A fleet has about two worktrees per role: the role's own plus its `_land-<role>`.
- Nothing watches free space. No code calls `statfs`.
- A full disk fails git object writes, `events.jsonl` appends and atomic state writes in the
  middle of writing them.

This part turns "disk full" into "fleet held, with a notification". Part 2/4 reclaims space so
the hold rarely engages. It works for any language, because it only measures bytes.

**Goal.** When the volume holding `.tumwater/worktrees` has less than `diskHoldGB` free, no new
work starts until free space is back at `diskHoldGB + 5`. That covers role ticks, director
ticks, landing vets and merges. In-flight work runs on.

**Approach.**
1. **Config.** Add `diskHoldGB`: a number ≥ 0, default 10, where 0 disables the hold. GB means
   10^9 bytes. It touches:
   - `TumwaterConfig` and `TOP_LEVEL_KEYS` in src/config/config-schema.ts;
   - `defaultConfig()` in src/config/config.ts;
   - a `checkNumber` in src/config/config-validation.ts;
   - the key list in docs/how-it-works.md.
   
   Do not add it to tumwater.example.json, because `exampleDrift` would flag every install.
2. **Gate.** New file src/gates/disk-gate.ts:
   - `sampleFreeBytes(root, statfs = fs.statfsSync)` returns `bavail * bsize` for
     `worktreesDir(root)`, falling back to `root` while that dir does not exist. It returns
     `null` when statfs throws.
   - `pollDiskGate(root, freeBytes, holdGB, state)` is edge-triggered like
     `pollQuietHoursGate` (src/scheduling/quiet-hours.ts). It enters the hold when free space
     is below `holdGB`, and leaves it at `holdGB + DISK_HOLD_HYSTERESIS_GB` (5) or more.
   - It logs `disk_low` { freeGB, holdGB } or `disk_ok` { freeGB }, with loop `harness`, once
     per crossing.
   - A `null` sample never holds, and logs one `warning` per process.
3. **Wiring.**
   - Add `disk` to `FleetGateStates` and poll it from `pollFleetGates` (src/gates/gate-polls.ts).
     `FleetGatePoll` returns `diskHeld`.
   - In src/orchestrator/orchestrator.ts, keep `diskHeld` in a hoisted `let`, like
     `holdForRestart`.
   - Add it to `tickStartHeld`, which already gates role ticks, the director, and parked vets
     at permit time.
   - Add it to the drain condition `if (!holdForRestart && !reviewHeld)`.
   - Add it to `pollRunnerReasons` (src/orchestrator/orchestrator-scheduling.ts), so a held
     role reports the hold and reserves no tick.
4. **Events.** Add `disk_low` and `disk_ok` to src/events/events.ts, each with a comment, and
   render them in src/events/event-format.ts. `disk_low` joins `PROBLEM_EVENTS`
   (src/ui/tone.ts) and the notify hook's notable events (src/events/notify.ts).
5. **Doctor.** Add `checkDiskSpace` to src/doctor/doctor-checks.ts and compose it in
   src/doctor/doctor.ts:
   - **fail** below `diskHoldGB`;
   - **ok** otherwise. Part 2/4 adds a warn band;
   - **warn** "cannot measure" when statfs throws.
   
   Its detail names the measured path, the free GB to one decimal, and the floor.

**Files touched.** src/gates/disk-gate.ts (new), src/gates/gate-polls.ts,
src/orchestrator/orchestrator.ts, src/orchestrator/orchestrator-scheduling.ts,
src/config/config-schema.ts, src/config/config.ts, src/config/config-validation.ts,
src/events/events.ts, src/events/event-format.ts, src/events/notify.ts, src/ui/tone.ts,
src/doctor/doctor-checks.ts, src/doctor/doctor.ts, docs/how-it-works.md. Tests:
test/disk-gate.test.ts (new), plus cases in test/config.test.ts, test/config-validation.test.ts
and test/doctor-checks.test.ts.

**Acceptance criteria.**
- **Hold.** With an injected sampler reporting 9 GB and `diskHoldGB: 10`, no role tick,
  director tick, vet or merge starts. A tick already running finishes. Exactly one `disk_low`
  is logged.
- **Hysteresis.** At 14 GB the hold stays. At 15 GB it lifts with one `disk_ok`, and loops
  start ticks again on the next poll.
- **Off and unmeasurable.** `diskHoldGB: 0` never holds. A sampler that throws never holds and
  logs one warning.
- **Live config.** A live edit of `diskHoldGB` applies on the next poll.
- **Doctor.** `tumwater doctor` reports fail below the floor, ok above it, and warn when free
  space cannot be measured.
- `npm run test` green.

### Worktree pool, part 1/5: label every pi run's kind and demultiplex progress by the label, not the lander path (planned 2026-10-06 by operator; done 2026-10-07 by feature)

Design: plans/worktree-pool.md ("Progress demux"). This is preparation: every run's demux
attribution is unchanged; only the marker that carries it is new.

Context: `feedDemuxed` (src/ui/progress-data.ts) decides whether a pi run in a role's raw log
belongs to the review gate (the reviewing cell) or to the author. It decides by
`session.cwd === landWorktreePath(root, role)`. Parts 2/5 and 4/5 move vets and role ticks
into shared pool slots, and after that a path cannot tell the two apart.

**Approach.**
1. **Kind on every run.** `PiRunOptions` (src/pi/pi.ts) gains a required
   `kind: "author" | "gate"`, required so that no caller is missed. `runPi` writes one marker
   line before spawning: `{ "type": "tumwater_run", "kind": <kind> }`, plus today's `label`
   when one is set, so a run still gets exactly one marker line. Update the option's doc
   comment, which today says author runs write nothing.
2. **Callers.**
   - **Gate:** the reviewer runs and the review follow-up (src/review/*), and the shared
     lander's conflict resolver and post-resolve re-review (src/landing/*, reached through
     runLandingPi in the merge worktree).
   - **Author:** the tick's runs in src/loop/loop-pi.ts: authoring, the transient retry, the
     summary request and the stage-fix request — and runRolePi, the refusal-note landing
     (loop.ts's merge, in the role's own worktree), whose marker keeps the old cwd verdict.
3. **Demux.** In `feedDemuxed`, a `tumwater_run` line carrying `kind` sets `tail.cur` to that
   kind and starts that accumulator fresh, generalising today's reset on `review`. The run's
   following `session` event keeps that kind. The cwd test remains only for a `session` that
   no kind-bearing marker preceded, as in logs written before this change.
4. **Transcript.** In src/ui/transcript.ts, a `tumwater_run` line without `label` renders
   nothing and sets no pending label. The backward scan in src/ui/transcript-tail.ts stops only
   at a LABEL-bearing marker: a kind-only marker is skipped, so the run's own marker never hides
   a stale label that a full re-read would still apply, keeping the tail ≡ full-re-read
   invariant.

**Files touched.** src/pi/pi.ts, src/pi/pi-event-line.ts (the shared PiRunKind),
src/loop/loop-pi.ts, src/review/review.ts, src/review/review-followup.ts,
src/ui/progress-data.ts, src/ui/transcript.ts, src/ui/transcript-tail.ts. Tests:
test/progress.test.ts, test/transcript.test.ts, test/transcript-tail.test.ts, test/pi.test.ts,
test/loop-pi.test.ts, test/review-followup.test.ts, test/pi-events.ts, test/pi-run-harness.ts.

**Acceptance criteria.**
- **Type-checked.** Every runPi call site passes a `kind`.
- **Same cwd.** A raw log whose author and gate runs share one cwd demultiplexes correctly by
  marker.
- **Old logs.** A log with no kind markers demultiplexes exactly as before.
- **Transcript.** A reviewer run still renders its labeled separator. An author run's
  kind-only marker renders nothing.
- `npm run test` green.


### Pre-queue self-check, part 2/2: flag stale path references, nonexistent paths, and lost final newlines (planned 2026-10-06 by operator; requires part 1/2 landed; done 2026-10-06 by feature)

Context: path drift is the organize loop's main rejection cause. In organize's 11 rejections from
2026-10-04 to 10-06:
- Seven left a renamed or deleted path still named in docs, comments, BUGS.md or plans/:
  40fc155e, 1ea3c96d, dd971b48, e1b4e113, 04f4be3e, 3780b9a7, 177f2481.
- One added paths that never existed: 025f5425 applied a path rewrite twice, producing
  `src/backlog/src/backlog/…`.
- One pointed at test paths that were never moved (16516b42).
- Two of the eleven also removed files' final newlines.

Each is a git-level fact the harness can compute without knowing the project's language. Today a
model reviewer finds them by grepping and rejects the refactor, which discards it even when the
reasons say the rest was verified correct.

Doc-comment debris, such as an unterminated `/**` swallowed by the next comment or an import
glued to a comment, is language-specific. It stays with the project's own lint and is out of
scope here.

**Goal.** Part 1/2's stage self-check also reports three kinds of finding. The author fixes them,
or says why not, in the follow-up turn:
- (a) every remaining reference to a path the change renamed or deleted;
- (b) repo paths named on added lines that do not exist in the resulting tree;
- (c) files whose final newline the change removed.

**Approach.** Everything goes in `src/tick/stage-check.ts`, appended to `stageCheckFindings`.
It is project-neutral and uses git only.
1. Stage with `git add -A`, read `git diff --cached -M --name-status <changeBaseRev>`, and
   restore the index to HEAD before returning — the staging is a read aid for these checks,
   so the tick's own change detection (`changedFiles` and the nothing-left-to-land guard)
   still reads the worktree. (An earlier draft left the index staged, which made a fix-up
   that reverted the whole change look like a live change.)
2. **(a) Stale references.** For each `D` path and each `R` old path, run
   `git grep -n -F -I --cached -- <old path>`. Report up to 10 `file:line` hits per path in one
   finding: "<old> was renamed to <new> (or deleted) but is still named at: …".
3. **(b) Nonexistent paths.** In `git diff --cached -U0 <base>`, collect tokens on `+` lines
   shaped `<top>/<segments>.<ext>`, where `<top>` is a tracked top-level directory (from
   `git ls-files`) and the path ends in a file extension. Report those missing from the staged
   tree, except step 2's old paths, which "moved from X" prose names legitimately. Cap the
   list.
4. **(c) Final newline.** Report, in one finding, every text file in the staged diff whose new
   side ends with `\ No newline at end of file` while its base side did not. A new text file
   with no final newline counts too.
5. `buildStageFixPrompt` from part 1/2 already covers these. Each finding's text names its fix
   concretely.

**Files touched.** src/tick/stage-check.ts, test/stage-check.test.ts, test/tick-stage.test.ts (the
fix-up/`no_change` regression case).

**Acceptance criteria.**
- **Stale references.** On a scratch repo, renaming `src/a.ts` to `src/x/a.ts` while README.md
  still names `src/a.ts` yields one stale-reference finding citing `README.md:<line>`.
  Updating the README clears it.
- **Nonexistent paths.** An added line naming `src/x/src/x/a.ts` yields a nonexistent-path
  finding. An added line naming the renamed-away `src/a.ts` ("moved from src/a.ts") does not.
- **Final newline.** A change that removes a file's final newline yields the newline finding.
  A file whose base already lacked one does not.
- **No noise.** Binary and untouched files produce no findings. Findings are capped, so a
  40-file rename produces a bounded finding text.
- `npm run test` green.

### Pre-queue self-check, part 1/2: run the gate's deterministic backlog checks before a tick queues, with one fix-up turn on the author's session (planned 2026-10-06 by operator; done 2026-10-06 by feature)

Context: the gate's two deterministic backlog checks only run at landing time:
`falseFixReason` (src/verdict/fix-claim.ts) and `backlogStructureReason`
(src/backlog/backlog-structure.ts). By then the author's session is over, and a finding costs a
queue slot, a vet, and a rejection that discards the work.
- On 2026-09-23, bugfix got the same rejection seven times between 05:52 and 15:52, each a full
  author, queue and vet cycle. The reason each time was `md-only BUGS.md edit moves "Any reply
  that merely mentions TUMWATER_REFUSED…" to Fixed, but none of the symbols…`.
- From 09-23 to 10-02 the gate caught 13 of these phantom-fix moves.

Both checks read the worktree and the change's merge-base, so they can run at staging time. At
that point the authoring session can still be continued; `requestSummary` already uses that
moment to recover a missing SUMMARY.

**Goal.** Before a changed tick commits, the harness runs the gate's deterministic checks. If
any finding comes back, the author gets one bounded follow-up turn on its own session to fix it.
The change then commits and queues as it does today, and the gate still has the final say.

**Approach.**
1. **`src/tick/stage-check.ts` (new).** Add
   `stageCheckFindings(wt, mainBranch, exemptPaths): Promise<string[]>`.
   - `files = changedFiles(wt)`: the uncommitted changes, untracked files included.
   - It returns `backlogStructureReason(wt, mainBranch, files)` when that is set.
   - It returns `falseFixReason(wt, mainBranch, files)` when `isExemptDiff(files, exemptPaths)`
     holds, the same scope the gate applies it in.
   - It never throws; a check that fails yields no finding.
2. **`src/gates/gate-prompts.ts`.** Add `buildStageFixPrompt(findings)`:
   - it lists the findings as what the landing gate will reject;
   - it asks the author to fix them in the worktree and reply with the closing
     SUMMARY/WHY/RISK/VERIFIED block again, or to say in RISK why a finding is wrong;
   - it carries the tick prompt's no-git rule.
3. **`src/loop/loop-pi.ts`.** Add `requestStageFix(wt, findings)`, a sibling of
   `requestSummary`.
   - It runs `--continue` on the authoring session.
   - It has its own caps, e.g. a 600 s timeout with `SUMMARY_REQUEST_QUIET_S` quiet, and the
     shared transient retry.
   - It returns null when no resumable session exists.
4. **`src/tick/tick-stage.ts`.** In `stageTickLanding`, after the SUMMARY recovery and before
   `commitAll`, run `stageCheckFindings`. When it returns findings:
   - run one `requestStageFix`; an aborted run goes to `finishAbortedTick`;
   - re-extract the SUMMARY and body from the follow-up's reply when it has them, and re-run the
     check;
   - warn once with the counts before and after, e.g. `stage self-check: 1 finding — fixed by
     the follow-up turn` or `…; 1 still open, queued for the gate`;
   - commit and queue either way.

   `TickStageContext` gains `stageCheck` and `requestStageFix` callbacks, wired in
   src/loop/loop.ts the same way as `requestSummary`.

**Files touched.** src/tick/stage-check.ts (new), src/tick/tick-stage.ts, src/loop/loop-pi.ts,
src/loop/loop.ts, src/gates/gate-prompts.ts, src/git/commit-message.ts. Tests:
test/stage-check.test.ts (new), test/tick-stage.test.ts, test/gate-prompts.test.ts,
test/commit-message.test.ts.

**Acceptance criteria.**
- **False fix.** An uncommitted md-only BUGS.md edit that moves an entry to Fixed and names a
  symbol absent from the tree yields one finding. The same edit with the symbol present yields
  none.
- **Structure.** A PLANS.md edit that duplicates `## Done` yields the structure finding.
- **Follow-up (tick-stage tests with fake pi).**
  - A finding triggers exactly one follow-up run. When that run fixes it, the change queues
    with only the "fixed" warning.
  - A finding the run leaves unfixed still queues, with the "still open" warning.
  - No findings means no follow-up run.
- **Body merge.** A fix-up reply that restates only some of WHY/RISK/VERIFIED overrides those
  fields and keeps the authoring run's other fields (a partial reply never drops them).
- **Dropped change.** A fix-up that reverts the whole change leaves a clean worktree, so the
  tick ends `no_change` with no commit, no pin, and nothing queued.
- **Abort.** An aborted follow-up finishes through `finishAbortedTick`, as the summary
  follow-up does.
- `npm run test` green.

### Fallback-window shake: reclaim old tool output instead of only warning when a small-window model fills (planned 2026-10-06 by operator; matters once roles run on a fallback model with a ~127k–258k window; done 2026-10-06 by feature)

Context: when a run fills its window, two things happen today.
- The context-budget extension (src/pi-extension/context-budget.ts) tells the model its fill
  level at 50/70/85% and asks it to wrap up.
- Past the window minus 16,384, pi compacts with an LLM summary that loses the run's reads.

On the 1M-window primaries neither fires: the largest fleet tick from Oct 2–6 reached 140k.
The oMLX fallback models have 127k and 258k windows, though, and the model-fallback plans
above will route roles there on provider failures. omp's `shake` compaction method reclaims
context without a model call: it replaces old tool results with recoverable references and
keeps the recent window intact. pi 1.0.0 has the primitive to do the same from an extension:
a `turn_end` handler can append persisted `context_edit` entries (pi docs: extensions.md,
session-format.md).

**Goal.** When a run crosses 70% of its window, its old bulky tool results are replaced with
short pointers the model can follow. The run can then finish its task instead of stopping
early or being summarized.

**Approach.**
1. **`src/pi-extension/context-shake.ts`** (new bundled extension, loaded after
   bounded-output and before context-budget) with a pure planner `shakePlan(messages, usage)`.
   - At or above 70% usage, it selects `read` and `bash` tool results that are older than
     the newest 20,000 estimated tokens and longer than 2,000 chars.
   - A bash result is replaced by `[elided by tumwater: N chars; full output in <path>]`. It
     reuses `details.fullOutputPath`, or else writes the full text with bounded-output's
     `writeFullOutput`.
   - A read result is replaced by `[elided by tumwater: N chars of <path>:<start>-<end>;
     re-read the range if you still need it]`.
   - It never selects edit or write results, error results, or the user prompt.
   - It returns an empty plan when it would reclaim fewer than 10,000 estimated tokens.
2. **Apply** — through a `turn_end` handler that returns `context_edit` replacement entries.
   These are persisted, so a `--continue` resume rebuilds the same context. First check the
   exact return shape against pi's exported `extensions/types.ts`. If `turn_end` cannot
   propose edits, apply the same deterministic plan in the request-local `context` event
   instead.
3. **Once per crossing** — shake at 70%, and again at 85% only if the first pass did not bring
   the run back under 70%. Already-elided results are never re-elided. Append one line to the
   next tool result, as context-budget does: "[tumwater: elided N old tool results (~K
   tokens); each pointer says where the full text is]".
4. **`src/pi-extension/context-budget.ts`** — refresh its header, which still describes pi
   0.87. Keep its 85% stop-reading note as the backstop.

**Files touched.** src/pi-extension/context-shake.ts (new), src/pi/pi-args.ts
(`bundledExtensionPaths`), src/pi-extension/context-budget.ts, test/context-shake.test.ts (new),
test/pi-args.test.ts.

**Acceptance criteria.**
- Planner tests:
  - Below 70%, the plan is empty.
  - At 70%, only results outside the newest 20k tokens and over 2,000 chars are selected.
  - Edit, write and error results are never selected.
  - A plan that reclaims under 10k tokens is empty.
  - An already-elided result is not selected again.
- A bash replacement names a full-output path, and a bash result without
  `details.fullOutputPath` gets one written. A read replacement names the range.
- With `contextWindow` 1,048,575 and fleet-sized contexts (≤140k), the extension plans
  nothing.
- `bundledExtensionPaths()` lists the extensions in the order bounded-output, context-shake,
  context-budget, followed by the role-notes extension once that plan lands.
- `npm run test` green.

### Role notebook: carry a bounded, model-written note per role across fresh ticks (planned 2026-10-06 by operator; evaluate with the tick_end prompt-token fields above, so land that plan first; done 2026-10-06 by feature)

Context: the 2026-10-06 analysis recorded a decision to keep a fresh pi session per tick, for
three reasons.
- Replaying the fleet with each tick carrying its predecessor's context costs 2.0× the prompt
  tokens raw, or 1.7× compacted to ~23k (pi's `keepRecentTokens` 20k plus a summary).
- Carried file views go stale: the worktree resets to main each tick, and other loops land
  in between.
- Fresh ticks are what retired session poisoning (1046112).

The continuity worth keeping is small: 25% of what a role reads is a file it also read in its
previous tick, and each tick re-derives the same codebase facts. omp's experimental
notes-backed context (`compaction.experimentalContextManagement`: a 16 KB `context_notes`
notebook plus `new_context` rollover, no summarizer) is the same design. This plan gives each
tumwater role that notebook, with the tick boundary serving as the rollover.

**Goal.** At tick start, each role loop sees a short note written by its own earlier ticks:
codebase facts, dead ends, and where its search stands. The loop can replace the note before
ending. No transcript is carried.

**Approach.**
1. **`src/paths.ts`** — `roleNotesPath(root, role)` → `.tumwater/state/notes/<role>.md`.
   This is runtime state that is never committed, like `qaCoveragePath`.
2. **`src/pi-extension/role-notes.ts`** (new bundled extension) — registers a `role_notes`
   tool (`text: string`) through `pi.registerTool()`, but only when `TUMWATER_NOTES_PATH` is set
   in the environment.
   - The tool replaces the file at that path with `text`, writing to a temp file and renaming.
   - Text over 4,096 UTF-8 bytes is rejected with an error that names the limit, and nothing
     is written.
   - Empty text clears the note.
   - The validation is a pure exported function, so it is unit-testable without pi, the same
     pattern as bounded-output and context-budget.
3. **Wiring.**
   - `src/pi/pi-args.ts` adds `role-notes.js` to `bundledExtensionPaths()`.
   - The authoring runs in `src/loop/loop-pi.ts` (`runAuthoringPi`, including resumes) set
     `TUMWATER_NOTES_PATH=roleNotesPath(root, role)` in the child env, beside the existing
     run marker (`src/pi/pi.ts`). A dedicated entry point, not the shared `runRolePi`:
     `runRolePi` is also the merge conflict resolver's runner, and a conflict resolution is
     not the role's recurring search.
   - Review, landing and conflict-resolver runs leave it unset, so the tool never registers
     there (they use `runRolePi`, `runLandingPi`, and `runGatePi`).
   - The director gets no notebook: its work is the operator's prompt, not a recurring search.
     `runAuthoringPi` omits the path for `DIRECTOR_ROLE`.
   - The write instruction is a standing part of every role tick prompt; only the
     `<role-notes>` content block is conditional on an existing note, so a role's first tick
     (no note yet) still learns the tool exists and can seed the notebook.
4. **`src/tick/tick-prompt.ts` + `src/prompt/prompt.ts`** — `buildTickPrompt` takes an
   optional `notes` input, read from `roleNotesPath`; a missing, empty or unreadable file
   means no block. The block reads:
   "Notes your role wrote in earlier ticks (yours, unverified — check against the code before
   relying on them): <role-notes>…</role-notes>. Before you end, if you learned something the
   next tick of your role should know (where things live, what you ruled out and why, what you
   would look at next), call role_notes with the full replacement note (at most 4 KB). Do not
   copy backlog entries into it — PLANS.md and BUGS.md hold the work itself."
5. **`src/roles/role-view.ts` / `src/roles/role-render.ts`** — `tumwater role <id>` shows the
   current note, so the operator can read what each role believes.
6. **docs/how-it-works.md** — one paragraph: what the notebook is, where it lives, its size
   cap, and that it is the only state carried between a role's ticks besides the repo itself.

**Evaluation (operator, after 7 days on).** Use the tick_end fields from the plan above to
compare, for the 7 days before and after: each role's median `preEditPromptTokens`, its share
of ticks that never edit, and its prompt tokens per landed change.
- Keep the notebook if those numbers fall.
- Otherwise remove it (the extension, the prompt block and the path). The note costs up to
  ~1k tokens on every turn, so it must pay for itself.

**Files touched.** src/paths.ts, src/pi-extension/role-notes.ts (new), src/pi/pi-args.ts,
src/pi/pi.ts, src/loop/loop-pi.ts, src/tick/tick-prompt.ts, src/prompt/prompt.ts,
src/roles/role-view.ts, src/roles/role-render.ts, docs/how-it-works.md, and tests
(test/role-notes.test.ts (new), test/pi-args.test.ts, test/prompt.test.ts, test/role-view.test.ts).

**Acceptance criteria.**
- Validation accepts 4,096 bytes and rejects 4,097 bytes with the limit in the error,
  writing nothing. Empty text clears the file.
- With fake pi, an authoring run's child env carries `TUMWATER_NOTES_PATH`, and review,
  landing and conflict-resolver runs' envs do not.
- A role's tick prompt carries the `<role-notes>` block when the file has content and omits
  it otherwise. The director's prompt never carries it.
- `tumwater role <id>` shows the note, or says there is none.
- `npm run test` green.



### Model failure fallback, part 2/2: show the episode on every surface (planned 2026-10-06 by plan loop; requires part 1/2 landed; done 2026-10-06 by feature)

**Goal.** An operator can see which loops are running off-model, and why, on `tumwater status`,
the TUI, and the dashboard without reading the event log.

**Approach.**
1. **`src/status/status-data.ts`** — add the active fallback (resolved pair, `since`, reason) to
   each loop row from `LoopState.modelFallback`; absent leaves the row shape byte-identical.
2. **`src/ui/status-payload.ts`, `src/ui/status-render.ts`, `src/ui/gui/gui-client-loops.ts`** — a
   `fallback` tag on the loop row (status/TUI cell and GUI row) while an episode is active.
3. **`src/roles/role-view.ts` + `src/roles/role-render.ts`** — `tumwater role <id>` names the
   effective fallback pair and "on fallback since <time> (primary failing: <reason>)".
4. **Docs** — README's Backends/Status note and docs/how-it-works.md describe the shipped
   trigger and return policy; docs/feature-model-fallback.md and
   docs/implementation-model-fallback.md are corrected to match (the probe is a real tick on the
   primary, not a separate canary request); plans/fallback-model.md's "Out of scope" line no
   longer calls failure fallback out of scope.

**Files touched.** src/status/status-data.ts, src/ui/status-payload.ts, src/ui/status-render.ts,
src/ui/gui/gui-client-loops.ts, src/roles/role-view.ts, src/roles/role-render.ts, README.md,
docs/how-it-works.md, docs/feature-model-fallback.md, docs/implementation-model-fallback.md,
plans/fallback-model.md, and their tests.

**Acceptance criteria.**
- `tumwater status --json` carries the fallback field for a role mid-episode and omits it
  otherwise; existing row snapshots are unchanged when no episode is active.
- The status/TUI loop cell and the GUI loop row show the fallback tag while active, and nothing
  otherwise.
- `tumwater role <id>` names the fallback pair and the episode's start and reason.
- The docs state the shipped trigger (3 consecutive provider-class failures), the tier-resolved
  pair, the probe tick, and the return policy; no doc still calls failure fallback out of scope.

### Model failure fallback, part 1/2: run a failing role's ticks on its tier fallback (planned 2026-10-06 by plan loop; done 2026-10-06 by feature)

Design: plans/fallback-model.md, docs/feature-model-fallback.md, docs/implementation-model-fallback.md.
The docs describe a per-role fallback on repeated backend failures; this lands the behavior
(the canary-probe wording in the docs is superseded — see part 2/2, which corrects the docs).
Part 2/2 adds the surfaces and depends on this landing.

**Goal.** When a role's primary model keeps failing with provider-class errors, keep the role's
ticks productive on its tier's resolved `fallback` pair instead of burning the error ladder
until the streak breaker pauses it, and return it to the primary once a probe succeeds.

**Approach.**
1. **`src/loop/model-fallback.ts` (new, pure).** `ModelFallbackState = { failures: number;
   since: number; probeAt: number; cooldownMs: number; reason: string }`;
   `MODEL_FALLBACK_FAILURES = 3`, `MODEL_FALLBACK_COOLDOWN_MS = 5 * 60_000`,
   `MODEL_FALLBACK_MAX_COOLDOWN_MS = 30 * 60_000`. Functions with the clock injected (no
   `Date.now()` inside): `recordModelFallback(state, { providerFailure, now, reason })` returns
   the next state — the third consecutive provider failure trips `fallback`, any other outcome
   leaves a non-tripped state and clears `failures`; `modelFallbackProbe(state, now)` is true
   only while in fallback with `probeAt` elapsed; `modelFallbackActive(state, now)` is true only
   while in fallback with `probeAt` in the future; a failed probe doubles `cooldownMs` to the cap.
2. **`src/config/config-views.ts`** — export `fallbackRoleConfig(config, role):
   ResolvedModelConfig | null`: the role's `roleSeamTier` pair from
   `resolveTierFallbacks(config, () => true)` (tier own pair, else the existing borrow order),
   shaped like `configForRole` (provider/model/thinking + the role's `minTickIntervalSeconds`).
   Null when the tier resolves to pause (no `fallback` configured), so the feature is off.
3. **`src/loop/loop-state.ts`** — `LoopState.modelFallback?: ModelFallbackState` (persisted;
   absent means primary, so existing state files read unchanged).
4. **`src/loop/loop.ts`** (`LoopRunner.tick()` and `runTick()`) — at tick start read
   `this.state.modelFallback`: with `fallbackRoleConfig` non-null and `modelFallbackActive`,
   resolve `cfg` from that fallback config, pass it as the explicit config to the authoring
   `this.pi.runRolePi(wt, prompt, name, resuming, cfg)` call, and set `tickPair` to it; with
   `modelFallbackProbe`, run the tick on the primary as the probe. At tick end, fold ONLY the
   authoring run's `PiRunResult` (`modelFallbackVerdict`, reason from `transientRateLimit` /
   `backendKind`) — not the tick's `lastRateLimit`/`lastBackendFailure` stamps, which a
   transient retry's earlier failed attempt can set without the authoring run having failed —
   call `recordModelFallback`, persist it, and emit `model_fallback_started` /
   `model_fallback_ended`. A run the harness killed (aborted, quiet-killed, timed out) is
   inconclusive, and a tick that never invoked pi leaves the episode untouched.
5. **`src/events/events.ts` + `src/events/event-format.ts`** — the two event types carry role,
   provider, model, and the tripping reason (and episode duration on end), rendered in the feed.
6. **The effective-provider wiring** (added after the 2026-10-06 review objected that a
   fallback-provider storm was never detected and a fallback tick fed the primary's breaker):
   `LoopRunner.runConfig(now)` / `runProvider(now)` resolve the pair the NEXT tick will run
   from the live config plus the episode. `src/gates/gate-polls.ts`'s `holdInputs` keys each
   role's hold observation on `runProvider(now)` instead of `configForRole`, so a storm on the
   fallback pair forms its own hold while the abandoned primary stays clear;
   `src/orchestrator/orchestrator.ts`'s `roleProviders` reads the same method; and
   `src/orchestrator/orchestrator-launch.ts` derives `ranPair` from `runConfig(now)` so a
   fallback-episode tick's outcome folds into the breaker of the pair it actually ran.

**Files touched.** src/loop/model-fallback.ts (new), src/loop/loop.ts, src/loop/loop-state.ts,
src/config/config-views.ts, src/events/events.ts, src/events/event-format.ts,
src/gates/gate-polls.ts, src/orchestrator/orchestrator.ts,
src/orchestrator/orchestrator-launch.ts, test/model-fallback.test.ts (new),
test/loop-fallback.test.ts (new), test/config-views.test.ts, test/event-format.test.ts,
test/gate-polls.test.ts, test/orchestrator-launch.test.ts.

**Acceptance criteria.**
- Two roles failing with provider-class errors on a shared fallback provider form a hold on
  that provider through `pollFleetGates`, while the abandoned primary stays clear
  (test/gate-polls.test.ts).
- State-machine unit tests: two provider failures leave the role on primary; the third trips
  fallback; a content failure (rejected/no_change/error without a provider flag) never trips and
  clears the running count; a probe is offered only after the cooldown; a successful probe clears
  the state; a failed probe doubles the cooldown to the 30-minute cap; a role whose tier resolves
  to no fallback pair never trips.
- Fake-pi integration: a role whose authoring runs fail provider-class three times runs its next
  tick with the fallback pair in the `--provider`/`--model` argv; a successful probe tick after
  the cooldown runs on the primary and emits `model_fallback_ended`; `model_fallback_started`
  precedes it in the feed.
- A role with no `fallback` configured emits no new event and its `--model` argv is unchanged.
- `npm run test` green.

### Log one `model_changed` event when a live config edit changes the fleet's model wiring (planned 2026-10-06 by director; independent of the display plan above; done 2026-10-06 by feature)

**Goal.** A live `tumwater.json` edit that changes which model a seam runs on leaves one
human-readable events.jsonl line naming the new selector, instead of only the key list the
existing `config_changed` event carries. It fires only on an actual model-wiring change — never
per tick; the per-tick `tick_start.model` field stays for the history/report trail. Budget
fallback transitions already log their model on `budget_fallback`/`budget_handback`, so this
event covers the config-edit path only.

**Approach.**
1. **`src/config/config-views.ts`** — export `fleetModelLabel(config: TumwaterConfig): string |
   null`: for each tier in `MODEL_TIERS`, format that tier's effective selector via
   `tierModel(config, tier)` and `formatModelSelector`; return null when every tier is unset
   (pi's own default), the single selector when all set tiers agree, and the
   `small=…, default=…, strong=…` list when they differ. Using all tiers makes an edit to any
   tier's entry change the label.
2. **`src/events/events.ts`** — add `"model_changed"` to the `HarnessEvent["type"]` union with
   a doc comment: "a live tumwater.json edit changed the fleet's model wiring; carries
   `from`/`to` (`fleetModelLabel` of the previous/next config) and `roles` (the per-role
   selector diffs) when a `roles.<id>` model override changed".
3. **`src/config/config-live.ts`** (`poll`, beside the existing `config_changed` block) — after
   logging `config_changed`, compute the model change: `topChanged = fleetModelLabel(prevLive)
   !== fleetModelLabel(reloaded.config)`; and from `changedKeys`' `roles.<id>` entries, keep a
   `{ role, from, to }` for each id whose `modelSelectorField(configForRole(...)).model` differs
   between `prevLive` and `reloaded.config` (imports `configForRole`, `fleetModelLabel`,
   `modelSelectorField` from config-views). When `topChanged || roleDiffs.length > 0`,
   `logEvent(root, { loop: "harness", type: "model_changed", from: fleetModelLabel(prevLive),
   to: fleetModelLabel(reloaded.config), ...(roleDiffs.length ? { roles: roleDiffs } : {}) })`.
   An edit touching no model key (e.g. `roles.<id>.instructions` or `minTickIntervalSeconds`)
   emits nothing.
4. **`src/events/event-format.ts`** — a `case "model_changed"` rendering `model changed — now
   ${e.to ?? "pi's default"}` (one feed line; the per-role diffs stay structured on the event).

**Files touched.** src/config/config-views.ts, src/config/config-live.ts, src/events/events.ts,
src/events/event-format.ts, test/config-live.test.ts, test/config-views.test.ts,
test/event-format.test.ts.

**Acceptance criteria.**
- `fleetModelLabel` returns null for an unset model, `prov-a/model-a` for the string
  `model: "prov-a/model-a"`, and a differing-tier list for `{ default: "prov-a/model-a",
  strong: "prov-s/model-s:high" }`.
- A reload whose only change is the top-level `model` logs exactly one `config_changed`
  (unchanged) followed by one `model_changed` whose `to` is the new label; an unchanged poll
  after it logs nothing more (edge-triggered like `config_changed`).
- A `roles.qa.model` edit logs a `model_changed` whose `roles` holds `{ role: "qa", from, to }`;
  a `roles.qa.instructions` edit logs `config_changed` and no `model_changed`; a
  `minTickIntervalSeconds`-only edit logs no model event.
- `event-format` renders `model changed — now prov-a/model-a`.
- `npm run test` green.

### Show each loop's active model on `tumwater status`, the TUI, and the GUI (planned 2026-10-06 by director; done 2026-10-06 by feature)

**Goal.** An operator can see, on both observer surfaces, which model every loop runs on — not
only when a tier map is declared. The per-row model selector was attached only when the
top-level `model` is a tier-map object (`src/status/status-data.ts`'s `snapshot`, the
`isJsonObject(cfg.model)` gate), so the common single-string model (`model: "provider/id"`)
was invisible: the GUI sub line and the TUI name suffix stayed bare. (`src/ui/gui/gui-client-loops.ts`'s
`loopCells` already renders `l.model` when present, and `src/ui/status-payload.ts` already
forwards `s.model`; its stale comment was corrected to match.)

**Approach.**
1. **`src/status/status-data.ts`** (`snapshot`, the `loops` map): always compute
   `configForRole(cfg, r)` and spread `...modelSelectorField(eff)` into every row. Keep
   `modelTier: roleSeamTier(cfg, r)` gated on `isJsonObject(cfg.model)` exactly as today (the
   tier tag stays a tier-map-only affordance). Updated the `StatusSnapshot.loops` field comment:
   `model` is now present whenever a model resolves, `modelTier` only under a tier map.
2. **`src/ui/status-render.ts`** (the row's `name` cell): replaced the
   `s.modelTier ? \` (${s.modelTier}${s.model ? ` · ${s.model}` : ""})\` : ""` suffix with one
   that also renders a lone model: with `s.modelTier` it keeps today's ` (tier · selector)` text
   byte-for-byte; otherwise with `s.model` it appends ` (${s.model})`; with neither it appends
   nothing.
3. **`src/ui/gui/gui-client-loops.ts` needed no change** — verified it already renders `l.model`.
   **`src/ui/status-payload.ts`** already forwarded `s.model`; only its comment was corrected.

**Files touched.** src/status/status-data.ts, src/ui/status-render.ts, src/ui/status-payload.ts,
test/status-data.test.ts, test/status-render.test.ts.

**Acceptance criteria.**
- With `model: "prov-a/model-a"` and no map, every `snapshot(repo).loops` row carries
  `model: "prov-a/model-a"` and no `modelTier`; `statusPayload(repo).loops` forwards the same
  `model`; `renderStatus` shows an isolated row supplied `{ role: "clean", model:
  "prov-a/model-a" }` as `clean (prov-a/model-a)`.
- With the tier map `{ default: "prov-a/model-a", strong: "prov-s/model-s:high" }`, every row
  carries `modelTier` and `model` exactly as today and `renderStatus` keeps the byte-identical
  ` (strong · prov-s/model-s:high)` suffix (the existing status-render tier test stays green).
- The old test "snapshot loop rows carry their seam tier and selector only when a tier map is
  declared" was renamed to "snapshot loop rows carry the resolved selector always and the seam
  tier only under a tier map": the no-map branch asserts `model` is present and `modelTier`
  stays undefined; a new status-render case pins the lone-model suffix.
- `npm run test` green.

### Per-tick prompt-token telemetry: record prompt, cache-read, and pre-first-edit tokens on tick_end (planned 2026-10-06 by operator; done 2026-10-06 by feature)

Context: a 2026-10-06 analysis of 684 ticks (Oct 2–6) had to rebuild these numbers from pi
session files, because tick_end carries only output tokens (`tokens`) and `costUsd`.
- 92% of prompt tokens are cache re-sends.
- About half of all prompt tokens are spent before a tick's first edit. Ticks that never edit
  account for 18%, and ticks that do edit spend 42% of theirs before the first edit.

Without these numbers on the event feed, nobody can tell whether a prompt or context change
made ticks leaner. That includes the BUGS.md backlog-index fix filed the same day and the role
notebook planned below.

**Goal.** Every tick_end reports three numbers: the prompt tokens the tick sent, how many of
them were cache reads, and how many were sent before the tick's first edit. A prompt or
context change can then be measured from events.jsonl alone.

**Approach.**
1. **`src/pi/pi-stream.ts`** — in the `message_end` assistant branch, accumulate
   `promptTokens += input + cacheRead + cacheWrite` (via `usageNumber`) and
   `cacheReadTokens += cacheRead`. Until the first assistant message whose content holds a
   `toolCall` named `edit` or `write`, also accumulate `preEditPromptTokens`, including that
   message's own prompt. Record `firstEditTurn` (1-based; undefined when the run never edits).
2. **`src/pi/pi-run-result.ts`** — carry the four fields on `PiRunResult` (built in
   `src/pi/pi.ts`).
3. **`src/tick/tick-usage.ts`**
   - `TickUsage` gains per-tick `promptTokens`, `cacheReadTokens`, `preEditPromptTokens` and
     an `editSeen` flag, all cleared in `reset()`.
   - `fold()` adds `promptTokens` and `cacheReadTokens` for every run, like `costUsd`.
   - `fold()` adds a run's `preEditPromptTokens` only for authoring runs and only while
     `editSeen` is false, then sets `editSeen` once a run reports `firstEditTurn`. Landing,
     review and conflict-resolution runs fold with `authoring=false`: `src/loop/loop.ts`'s
     `foldLandingUsage` and the `LoopPi` host's `foldLandingUsage` face (src/loop/loop-pi.ts)
     route every landing/review/conflict run there — including a retried gate attempt and the
     conflict resolver — so none of them touch the pre-edit counter.
4. **`src/tick/tick-finalize.ts`** — tick_end carries `promptTokens`, `cacheReadTokens` and
   `preEditPromptTokens`, omitted when zero, the same way `usageFragment` treats its fields.
5. **Telemetry digest** (`src/failure/failure-data.ts` / `src/failure/failure-render.ts`) —
   the collector folds each tick_end's `promptTokens`/`preEditPromptTokens` into a per-role
   `promptStats` row (median `promptTokens` per tick, and the pre-edit share: sum of
   `preEditPromptTokens` over sum of `promptTokens`), and the render adds a
   `## Prompt tokens by role` section. A log whose tick_ends predate the fields yields no rows,
   so old digests render byte-identically. `src/tick/telemetry-digest.ts` needed no change: it
   is a thin wrapper over `renderFailureMarkdown`, so the section flows through it automatically.

**Files touched.** src/pi/pi-stream.ts, src/pi/pi-run-result.ts, src/pi/pi.ts,
src/tick/tick-usage.ts, src/tick/tick-finalize.ts, src/loop/loop.ts, src/loop/loop-pi.ts,
src/failure/failure-data.ts, src/failure/failure-render.ts, test/pi-parser.test.ts,
test/tick-usage.test.ts, test/tick-finalize.test.ts, test/failure-render.test.ts,
test/loop-pi.test.ts, test/fake-pi.ts. (The plan named `test/pi-stream.test.ts`; the parser's
single unit-test home is test/pi-parser.test.ts, where its existing usage tests live.)

**Acceptance criteria.**
- A stream of three assistant messages with set `usage.input`/`usage.cacheRead`, where the
  second holds an `edit` toolCall, yields `promptTokens` and `cacheReadTokens` equal to the
  sums, `preEditPromptTokens` equal to the first two messages' prompts, and `firstEditTurn` 2.
- A run with no edit or write has `preEditPromptTokens == promptTokens`.
- A tick whose resumed second run follows an edit in its first run adds nothing to the
  pre-edit counter. A landing run's usage reaches `promptTokens` but not
  `preEditPromptTokens` — `runLandingPi` and `runGatePi` fold through `foldLandingUsage`
  (pinned in test/loop-pi.test.ts), and `TickUsage.fold(..., false)` never advances the prefix
  (test/tick-usage.test.ts).
- tick_end lines in events.jsonl carry the three fields, and a tick with no usage omits them.
  Existing report and digest output is unchanged apart from the new digest line.
- `npm run test` green.

### GUI Pending view: show each loop's unlanded change in the dashboard (planned 2026-10-06 by plan loop; done 2026-10-06 by feature)

The CLI answers "what is each loop about to land" with `tumwater diff` (`--json`, `--role <id>`), but the browser dashboard — the operator's primary observer surface — has no way to see a loop's pending unlanded work: Fleet/History/Usage/Failures/Settings all render state and history, and the loop drawer shows status and transcript only. The data already exists and is shared: `collectFleetChanges` / `collectRoleChange` (src/change/change-data.ts) produce the exact `FleetChangeView` / `RoleChangeView` documents `tumwater diff --json` prints, so the GUI reuses them unchanged.

**Goal.** Add a Pending view to the dashboard that lists each role's unlanded work (branch, state, ahead count with commit subjects, dirty-file count) and opens a role's full diff, powered by the existing change collectors.

**Approach.** The landed change follows the plan; where the anchors named the wrong module it was corrected in place rather than refused.
1. **`src/gui/gui-endpoints.ts`** — the `async handleDiff(q, res, root)` handler: no `role` param → `sendJson(res, 200, await collectFleetChanges(root))` (the same payload `tumwater diff --json` prints); `?role=<id>` → `rejectBadRole` first (the same target validation and 400 wording as `/api/transcript` and `/api/tick`, so a traversal-shaped id never reaches the collector) and then `collectRoleChange(root, <id>)` (the full patch view, as `tumwater diff --role <id> --json` prints). Every /api handler lives in this module by its own contract, so the plan's `gui-server.ts` handler note was corrected; **`src/gui/gui-server.ts`** routes `GET /api/diff` to it.
2. **`src/ui/gui/gui-page.ts`** — a `Pending` tab in `viewnav` (after Failures) and a `<section id="pending" class="view" aria-label="Pending" hidden>` container, mirroring the Failures section.
3. **`src/ui/gui/gui-client-boot.ts`** — `pending` registered in `VIEWS` and `fetchPending()` called from `switchView`, alongside `fetchHistory`/`fetchReport`/`fetchFailures`.
4. **`src/ui/gui/gui-client-pending.ts`** (new section, spliced into gui-client.ts like its siblings) — `fetchPending` loads `/api/diff`; `renderPending` paints a pure roster (loop, branch, state, ahead count with commit subjects, dirty-file count; `ready` with no work shows idle; `absent`/`no-base` show their degraded line), and each row opens the loop drawer. **`src/ui/gui/gui-client-drawer.ts`** adds the drawer's "Pending change" section — it fetches `/api/diff?role=<id>` once on open and renders the full patch (commits, ahead-of-main diff, uncommitted files and diff), and it renders even for a role absent from `statusPayload.loops` (a disabled loop), so those roster rows can show their patch too. **`src/ui/gui/gui-styles.ts`** styles the scrollable diff. The roster renderer stays pure so it is unit-testable without a server.

**Files touched.** src/gui/gui-endpoints.ts, src/gui/gui-server.ts, src/ui/gui/gui-page.ts, src/ui/gui/gui-client.ts, src/ui/gui/gui-client-boot.ts, src/ui/gui/gui-client-pending.ts (new), src/ui/gui/gui-client-drawer.ts, src/ui/gui/gui-styles.ts, test/gui-endpoints.test.ts, test/gui-client-pending.test.ts (new), test/gui-client-boot.test.ts, test/gui-client-drawer.test.ts, docs/how-it-works.md.

**Acceptance criteria.**
- `GET /api/diff` returns a document matching `tumwater diff --json` for the same tree (same `mainBranch` and `roles` arrays, no per-role patch fields); `GET /api/diff?role=<id>` matches `tumwater diff --role <id> --json` for a role holding work and for an absent/no-base role.
- The viewnav shows Pending; the Pending view lists every role's branch, state, ahead count with commit subjects, and dirty-file count; a role holding no unlanded work renders its idle state; opening a role row shows its full diff in the drawer.
- The existing five views render unchanged; the new endpoint degrades on a fresh or incomplete repo the way the change collectors do, without throwing.

### Model tiers, part 8/8: writers emit the new form, and the docs describe tiers (planned 2026-10-05 by operator; requires parts 1/8–7/8 landed; done 2026-10-06 by feature)

Design: plans/model-tiers.md ("Backward compatibility", "Notes for local fallbacks").

**Goal.** Everything tumwater writes uses the new keys, and the docs teach the one-line
single-model form first, then tiers.

**Approach.**
1. **`setConfigKey` / `parseConfigKey`** (src/config/config-write.ts) — the one writer behind both
   `tumwater config set` (src/cli/config-commands.ts) and the GUI's config edits
   (src/gui/gui-endpoint-commands.ts) — and `EDITABLE_CONFIG_KEYS` (src/config/config-editable-keys.ts):
   `model` takes a selector, a dotted `model.strong` merges one map entry (the way
   `roles.qa.model` already merges a role entry), and `fallback` is editable. `provider` stays
   accepted for legacy configs and is never written into a config that lacks it.
2. **Docs:** README.md (the "Backends" line), docs/backends.md (config examples, the
   local-fallback memory and `compat.thinkingTokenBudgetField` notes), docs/how-it-works.md
   (seams and tiers), docs/feature-model-fallback.md and docs/implementation-model-fallback.md
   (per-tier fallback and the borrow order).

**Files touched.** src/config/config-write.ts, src/config/config-editable-keys.ts, README.md, the four docs/
files above, and the config-write tests.

**Acceptance criteria.**
- `tumwater config set model huggingface/zai-org/GLM-5.3-Flash:together:low` writes one key;
  `tumwater config set model.strong <selector>` turns a string `model` into
  `{ default: <old>, strong: <selector> }`.
- No writer adds `provider` or `fallbackModel` to a config that does not already have them.
- The docs show the single-model form before any tier example.

**Landed 2026-10-06.** `model.<tier>` merges one map entry, promoting a string `model` to
`{ default: <old>, <tier>: <selector> }` while keeping the other tiers; `config set` refuses to
add legacy `provider`/`fallbackModel` to a config that lacks them but still updates one that has
them; `fallback` joins the GUI's `EDITABLE_CONFIG_KEYS`; the docs lead with the single-selector
form. The two failure-fallback plan docs (feature-/implementation-model-fallback.md) name the
current `fallback` key (legacy alias noted); their failure-triggered state machine remains a
separate, unlanded plan.

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
