# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Organize the test suite's support modules into `test/fakes/`, `test/fixtures/`, and `test/helpers/` (planned 2026-10-07 by organize)

**Goal.** Give `test/` the same kind-directory layout `src/` already has: move the 30 flat
non-test support modules out of the `test/` root into `test/fakes/` and `test/fixtures/` (both
already exist) and a new `test/helpers/`, leaving the runner infrastructure and every
`*.test.ts` at the root.

**Context / cost today.** `test/` holds 344 files — 309 `*.test.ts` plus 33 flat non-test
`.ts` modules — and 30 of those support modules sit flat beside the tests. A reader (human or
agent) listing `test/` cannot tell a helper from a test without reading each name. The suite's
own convention is already kind-directories: `test/fakes/` is documented as "the shared test-fake
catalog" (its modules' docs cite "test/fakes/, PLANS.md 2026-10-04") and `test/fixtures/` exists
for fixture assets — yet `fake-pi.ts`, `fake-commands.ts`, `fake-res.ts`, and all 14
`*-fixtures.ts` live outside them. This is the last flat pile in the repo: `src/` was organized
into domain directories (including organize commit a2719e20, moving the remaining
domain-owned root modules into their directories), while `test/` never was. It is the same
treatment applied to the test tree, not a new direction.

**Target structure (designed up front).**
- `test/` root keeps runner infrastructure only: `test-runner.ts`, `test-durations-reporter.ts`
  (loaded by `node --test` as a reporter through a path relative to the runner,
  test/test-runner.ts:405), and `coverage-table.ts` (the runner's coverage-table merger).
  Every `*.test.ts` stays flat at the root — no test file moves, so filter names do not change.
- `test/fakes/` (existing) gains `fake-pi.ts`, `fake-commands.ts`, `fake-res.ts`, joining
  `log.ts`, `process.ts`, `time.ts`, `transient.ts`.
- `test/fixtures/` (existing; currently holds only the `script-shim/` asset) gains all 14
  `*-fixtures.ts` (`config-`, `doctor-`, `gate-`, `gui-`, `lander-`, `landing-`, `log-`,
  `loop-`, `models-`, `orchestrator-`, `redeploy-`, `repo-`, `status-`, `tui-`) plus
  `pi-events.ts` (fake pi JSONL line builders) and `victim-fixture.ts`.
- `test/helpers/` (new) gains `backdate.ts`, `cli-harness.ts`, `exit-capture.ts`,
  `exit-with-owner.ts`, `fs-faults.ts`, `json-read.ts`, `oracles.ts`, `pi-run-harness.ts`,
  `sleep-clock.ts`, `wait.ts`, `gui-client-scope.ts`.

**Why the runner tolerates subdirectories.** `selectTestFiles` (test/test-runner.ts) does
`fs.readdirSync(distDir)` — non-recursive — and keeps only `*.test.js`, so support modules
compiled to `dist/test/<dir>/` are ignored and the selected set is exactly the same flat
`*.test.ts` files as today.

**Files touched / the traps to get right.** The 30 modules above; every test file importing
them (≈750 relative specifiers rewrite from `./x.js` to `./<dir>/x.js`); and the moved modules'
own relative imports and `import.meta.url` constants, which are depth-sensitive:
- The moved `fake-commands.ts`: `SCRIPT_SHIM` becomes `../../../test/fixtures/script-shim`
  (BUGS.md 2026-09-30 pinned this constant; a wrong depth silently disables every fake command).
  `test/fake-commands.test.ts`'s relocated-tree refusal copies the compiled module two levels
  deep (`dist/test`) and must simulate three levels instead.
- The moved `cli-harness.ts`: `CLI` becomes `../../src/cli.js`.
- The moved `victim-fixture.ts`: `OWNER_PRELOAD` continues to name its sibling
  `./exit-with-owner.js`, which moves to the same directory.
- `test/fake-pi.test.ts` and `test/build-check-process.test.ts` embed `./fake-pi.js` /
  `./exit-with-owner.js` in generated paths and must point at the new directories.
- Doc/comment references to moved paths: `DEVELOPMENT.md` ("Install a fake command with
  `writeScript` (test/fake-commands.ts)"), `BUGS.md`, `PLANS.md`, `docs/`, and `src/` comments
  (e.g. `src/collections.ts` on the durations reporter).

**Acceptance criteria.**
- All 30 support modules live under `test/fakes/`, `test/fixtures/`, or `test/helpers/`; the
  `test/` root holds only `*.test.ts` and the three runner-infrastructure modules.
- A grep over `src/`, `test/`, `scripts/`, `docs/`, `DEVELOPMENT.md`, `PLANS.md`, and `BUGS.md`
  for each moved basename at its old flat path (`test/fake-pi.ts`, `test/cli-harness.ts`, …)
  finds no stale reference.
- `npm run test` (eslint + tsc + the suite) is green and runs the same set of `*.test.ts`
  files; `test/fake-commands.test.ts`'s relocated-tree import still fails loudly when
  `SCRIPT_SHIM` is absent.

### Worktree pool, part 2d/5: remove the `_land-*` machinery and legacy checkouts (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 2b/5 and 2c/5 landed)

Design: plans/worktree-pool.md ("Vets and merges").

**Context.** Once vets (2b/5) and merges (2c/5) no longer touch `_land-<role>`, the path
helper, the removal helper and the startup leftovers can go. This is the dependent cleanup
step: it lands only once those behavior changes are the running build.

**Approach.**
1. At orchestrator startup (src/orchestrator/orchestrator.ts) remove any legacy `_land-*`
   worktree with a force `worktree remove` followed by a prune. They hold no state, and queued
   landings re-vet from their pinned refs.
2. Delete `landWorktreePath` (src/paths.ts) and `removeLandWorktree` (src/git/git.ts); update
   their remaining importers.
3. progress-data.ts's cwd fallback from part 1/5 builds the legacy `_land-<role>` path as a
   local expression, so old logs still demultiplex.
4. Update the remaining tests that import `landWorktreePath` or hard-code `_land-<role>`:
   test/status-fixtures.ts, test/progress.test.ts, test/paths.test.ts and
   test/doctor-orphans.test.ts.

**Files touched.** src/orchestrator/orchestrator.ts, src/paths.ts, src/git/git.ts,
src/ui/progress-data.ts. Tests: test/status-fixtures.ts, test/progress.test.ts,
test/paths.test.ts, test/doctor-orphans.test.ts.

**Acceptance criteria.**
- `grep -rn "landWorktreePath\|removeLandWorktree" src` returns nothing.
- Startup removes a pre-existing `_land-feature` directory.
- The old-log progress demux still classifies a session whose cwd is `_land-<role>`.
- `npm run test` green.

### Worktree pool, part 4a/5: a leased slot can be kept for its role's resume and pinned on release (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 1/5, 2a/5 and 3/5 landed)

Design: plans/worktree-pool.md ("Leases", "Role ticks lease slots").

**Context.** The pool already understands pins: `chooseSlot` (src/git/worktree-pool.ts) prefers
`pinnedFor === role`, excludes a slot pinned for another role, and counts only unpinned slots
toward `slotCount`. But nothing ever sets `pinnedFor` except `retire` clearing it, because
`leaseSlot`'s returned `release()` takes no options; and `leaseSlot` always hard-resets the
chosen slot with `ensureDetachedWorktree`, which would wipe the uncommitted edits a resume must
keep. Role ticks need both: skip the reset on a slot pinned for the resuming role, and pin a
slot on release when the tick aborted with `resumePending` (pi `--continue` only matches a
session whose cwd is exactly the current directory).

**Approach.**
1. `SlotLeaseHandle` becomes `{ dir, release(options?: { pin?: boolean }), preserved: boolean }`.
2. Add a `leaseSlot` option `{ keep?: boolean }`. After `acquire` returns `dir`, read
   `slotForDir(root, dir)?.pinnedFor`. When `keep === true` and that equals `role`, skip
   `ensureDetachedWorktree` and return `preserved: true`; otherwise prepare at `ref` as today and
   return `preserved: false`.
3. Thread a `pin` argument into `releaseSlot(root, dir, role, count, pin)`: after clearing
   `lease`, set `slot.pinnedFor = pin ? role : (slot.pinnedFor === role ? null : slot.pinnedFor)`.
   A release with no options clears the releasing role's own pin (the design's "next release
   clears the pin whether or not it resumed").
4. Keep both existing invariants: `released` still guards a second call (only the first call's
   options apply), and the shrink-away pass still removes only idle *unpinned* slots.
5. Leave `chooseSlot` and `liveCount` untouched — they already treat pins correctly.

**Files touched.** src/git/worktree-pool.ts. Tests: test/worktree-pool.test.ts.

**Acceptance criteria.**
- `leaseSlot(..., { keep: true })` on a slot pinned for the role returns `preserved: true` and
  leaves an uncommitted file written into the slot intact; with `keep` absent, or on an
  unpinned slot, it resets to `ref` and returns `preserved: false`.
- Releasing with `{ pin: true }` records `pinnedFor = <role>` in slots.json; a later `leaseSlot`
  for that role returns the same directory even while another free unpinned slot exists.
- A slot pinned for role A is never leased by role B.
- Releasing the pinned slot for its role without `{ pin: true }` clears `pinnedFor`.
- With `worktreeSlots: 1`, a slot pinned for A does not count toward the budget: B's next lease
  creates a second `_slot-<n>` instead of waiting.
- The shrink-away pass does not remove a pinned slot.
- `npm run test` green.

### Worktree pool, part 4b/5: role ticks lease a pooled slot (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 1/5, 2a/5, 3/5 and part 4a/5 landed)

Design: plans/worktree-pool.md ("Role ticks lease slots").

**Context.** Each role keeps a persistent `.tumwater/worktrees/<role>` with its own build
outputs, yet at most `maxConcurrent` role ticks run at once. Lease the pooled `_slot-<n>`
checkouts instead; `leaseSlot` already holds `beginWorktreeUse` and prepares the slot at a ref.
This part leans on 4a/5 for the keep/resume and pin-on-release API.

**Approach.**
1. In `LoopRunner.runTick` (src/loop/loop.ts), for every role except `DIRECTOR_ROLE`, replace the
   `useWorktree(root, worktreePath(...), ...)` wrapper over `tickWithWorktree` with
   `leaseSlot(this.root, { role: this.role, purpose: "tick", ref: this.mainBranch, keep: plan.resuming })`,
   and pass the leased `dir` into `tickWithWorktree` as `wt` (which stops calling
   `ensureWorktree`). `plan.resuming` is the tick's decision (src/tick/tick-resume.ts);
   `state.resumePending` was already cleared when `planTickStart` consumed it, so it is not the
   keep signal.
2. When the lease is not `preserved`, check out the role branch before authoring:
   `git checkout -f tumwater/<role>` then `git clean -fd`; when the branch is absent,
   `git checkout -f -b tumwater/<role> <this.mainBranch>`. Never `-B` (it would reset an existing
   branch and lose an unpinned commit).
3. Everything after the checkout is unchanged: `recoverLeftover`, `resetWorktreeToMain`, the
   red-main gate, `commitAll` and `stageTickLanding` act through HEAD.
4. Release in `runTick`'s `finally`: when `this.state.resumePending` is true (set again by an
   abort or a cut-off during this tick, src/tick/tick-apply.ts and src/loop/loop.ts's
   `abortTick`), `release({ pin: true })` (branch checked out and edits kept, so `--continue`
   finds the same cwd); otherwise run `git checkout --detach` first, then `release()`, freeing
   the branch for the role's next slot.
5. `DIRECTOR_ROLE` keeps `ensureWorktree(root, DIRECTOR_ROLE, mainBranch)`; note in
   `ensureWorktree`'s doc (src/git/worktree.ts) that it now serves the director only.
6. Update the fixtures and cases that reach a non-director role worktree by path —
   test/loop-fixtures.ts, test/loop-2.test.ts, test/loop-merge-conflicts.test.ts and any other
   loop test naming `.tumwater/worktrees/<role>` — to resolve the slot through `roleWorktreeDir`
   or `slotForDir` instead.

**Files touched.** src/loop/loop.ts, src/git/worktree.ts (doc). Tests: test/loop-fixtures.ts and
the loop tests naming a non-director role worktree path.

**Acceptance criteria.**
- With `maxConcurrent: 2` and `worktreeSlots: 2`, three roles tick over time using at most two
  `_slot-*` directories; no `.tumwater/worktrees/<role>` is newly created for a non-director
  role.
- A commit left on `tumwater/<role>` with no pin (the crash window) is recovered by the role's
  next tick in whichever slot it leases.
- An aborted tick pins its slot; the role's next tick leases that same directory and runs in the
  preserved cwd (the fake pi sees it), then unpins on release.
- The director still ticks in `.tumwater/worktrees/director`.
- `npm run test` green.

### Worktree pool, part 4c/5: retire legacy role worktrees at orchestrator start (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 2a/5, 3/5, 4a/5 and 4b/5 landed)

Design: plans/worktree-pool.md ("Role ticks lease slots", "Legacy role worktrees").

**Context.** Once role ticks lease slots (4b/5), the old `.tumwater/worktrees/<role>`
directories are dead weight and the Part 5/5 doctor check warns on them. A one-time startup
migration must retire them without losing a pending resume. It lands after 4b/5 so it can never
remove a checkout a tick still uses.

**Approach.**
1. Add a startup step where the orchestrator does its other startup work
   (src/orchestrator/orchestrator.ts, near the `RetentionPruner` construction). It walks
   subdirectories of `.tumwater/worktrees/` and skips `director`, `_slot-*`, `_merge` and
   `_gate-main`.
2. Read each candidate role's persisted flags with `loadLoopState(root, role)`
   (src/loop/loop-state.ts, whose state already carries `resumePending`).
   - **resumePending:** register the existing directory in slots.json as that role's pinned slot
     (`updateSlotsState` with `{ dir, lease: null, pinnedFor: role, lastRole: null, lastReleasedAt: null }`),
     so the next tick leases it (4a's `keep`) and resumes in place.
   - **otherwise:** `removeWorktree(root, role)` (src/git/worktree.ts); the branch keeps any
     commit.
3. Teach the pool to retire a migrated legacy slot: in `releaseSlot`
   (src/git/worktree-pool.ts), when a slot's `dir` is not a canonical
   `slotWorktreePath(root, n)` and it is being unpinned, drop its record and return its dir in
   the shrink-away removal list, so `leaseSlot` removes the directory once the role is done.
4. This runs before any loop can lease, so a legacy directory never coexists with a slot
   holding the same branch.

**Files touched.** src/orchestrator/orchestrator.ts, src/git/worktree-pool.ts. Tests:
startup-migration cases in test/worktree-pool.test.ts and an orchestrator test.

**Acceptance criteria.**
- A clean legacy `.tumwater/worktrees/feature` is gone after startup; its branch and commit
  survive.
- A legacy worktree whose role has `resumePending` is registered as a pinned slot, serves
  exactly one resume in the same directory, and is removed on the first release that unpins it
  (no slot record for that legacy path remains).
- The migration leaves `director`, `_slot-*`, `_merge` and `_gate-main` untouched.
- `npm run test` green.

### Worktree pool, part 5/5: slot waits, slot display, doctor check and docs (planned 2026-10-06 by operator; requires parts 4a/5, 4b/5 and 4c/5 landed)

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

### Parallel work instances, part 5/7: `roles.<id>.instances` runs several feature or bugfix loops, each active only while unclaimed work exists; the plan target scales (planned 2026-10-07 by operator; requires parts 3/7 and 4/7, Robust conflict landing 2/2 and Worktree pool 4b/5 landed)

Design: plans/parallel-work-instances.md ("Spawning instances and keeping the plan loop
ahead").

Context: once Worktree pool 4b/5 makes role ticks lease `_slot-<n>` checkouts, an extra loop
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
   instances. `loopEnabled` already reads the configured count through a cast (landed with
   part 4/7); this part replaces the cast with the schema field and its defaults. `knownRoleIds`
   (src/config/config.ts) includes the ids, so the CLI and GUI accept `--role feature-2`.
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

### Worktree pool, part 2c/5: merge-side landing work uses one `_merge` checkout (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires part 2a/5 landed; done 2026-10-07 by feature)

Design: plans/worktree-pool.md ("Vets and merges").

**What landed (2026-10-07).** `landApprovedChange`/`landApprovedChangeIn`
(src/landing/landing-core.ts) and the stack assembly's `wtPath` (src/landing/landing-batch.ts)
resolve `mergeWorktreePath(ctx.root)` (`.tumwater/worktrees/_merge`) instead of a per-role
`_land-<role>`. The merge-side `removeLandWorktree` calls are gone — the terminal merge, the
conflict-resolution rejection and strike-cap discard (landing-core.ts), and red attribution's
`rejectChange` (landing-check-failures.ts) — so `_merge` persists across merges like `_gate-main`
and the next merge reuses it. `rejectChange` and `attributeRedCheck` no longer take a worktree.
Anchors the entry missed: test/landing-pipeline.test.ts and test/loop-leftover-recovery.test.ts
had no merge-side `_land-<role>` shim left to update (part 2b/5 had already moved them), and
test/lander-fixtures.ts's reviewer keys on the slot lease; test/orchestrator-3.e2e.test.ts's
containment test now seeds the shared `_merge` checkout rather than a per-role one and drops the
legacy `_land-clean` deletion.

**Files touched.** src/landing/landing-core.ts, src/landing/landing-stack.ts,
src/landing/landing-batch.ts, src/landing/landing-check-failures.ts. Tests: test/lander.test.ts,
test/landing-merge.test.ts, test/orchestrator-3.e2e.test.ts,
test/loop-leftover-recovery.test.ts, test/landing-pipeline.test.ts, test/pi-events.ts.

**Acceptance criteria.**
- A single merge, a stack with its bisect, and red attribution all run in `_merge`; no
  `_land-<role>` is created for a merge.
- `_merge` survives a merge (it is not removed) and is reused by the next one.
- Existing landing outcomes (changed, red, merge_blocked, conflict, rejected) are unchanged.
- `npm run test` green.

### Worktree pool, part 2b/5: vets lease a pooled slot (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires part 2a/5 landed; done 2026-10-07 by feature)

Design: plans/worktree-pool.md ("Vets and merges").

**What landed (2026-10-07).** `vetRequest` leases a pooled slot
(`leaseSlot(ctx.root, { role, purpose: "vet", ref: req.sha, signal: ctx.signal() })`) and releases
it in a `finally`, whatever the outcome. `vetRequestIn` takes the leased `dir` and no longer
calls `useWorktree`/`ensureDetachedWorktree`; an abort while waiting for a free slot settles as
the terminal `aborted` verdict, and a lease failure (the lost-pin checkout, say) keeps the
terminal `error` outcome. One anchor the entry missed: `reviewPinnedChange`'s discard on a
rejection or strike-cap discard removed the worktree it ran in — correct for the old
per-role lander, but it would delete a pooled slot, so that cleanup now drops only the pin ref
(src/landing/landing-core.ts), and the lease's own release frees the slot.

**Files touched.** src/landing/landing-batch.ts, src/landing/landing-core.ts. Tests:
test/pi-events.ts and test/landing-fixtures.ts (a `leasedRoleShell` helper reads the reviewing
role from the slot lease, since the cwd no longer names it), test/lander-fixtures.ts,
test/landing-drain-vetting.test.ts, test/landing-pipeline.test.ts, test/lander.test.ts,
test/loop-4.test.ts, test/loop-5.test.ts, test/loop-leftover-recovery.test.ts,
test/orchestrator-3.e2e.test.ts, test/orchestrator-permits.e2e.test.ts.

**Acceptance criteria.**
- A vet runs in a `_slot-<n>` directory; no `_land-<role>` is created for it.
- slots.json shows purpose `vet` during the run and no lease after it, for every outcome.
- A vet prefers the slot its role released most recently (the pool's own order, pinned by
test/worktree-pool.test.ts).
- Vet outcomes and the drain's write-back are unchanged.
- `npm run test` green.


### Worktree pool, part 2a/5: the slot pool and its `worktreeSlots` config (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires Disk floor 2/4 and Worktree pool 1/5 landed; done 2026-10-07 by feature)

**What landed (2026-10-07).** New src/git/worktree-pool.ts exports `leaseSlot`, which claims a
free slot in the design's order (a slot pinned for the role; the free slot the role released most
recently; the free slot anyone released most recently; a new `_slot-<n>` while fewer than
`slotCount` unpinned slots exist; else a first-in first-out in-process wait that honors an abort
signal), holds it through `useWorktree` for the lease's length, and prepares it with
`ensureDetachedWorktree`. `slots.json` records the lease while held and clears it on release,
leases owned by another pid are cleared on each claim, and a release removes idle unpinned slots
when `worktreeSlots` shrank. `slotCount` (src/config/config.ts) resolves an omitted `worktreeSlots`
to `maxConcurrent + 1`; validation rejects a value below 1; `mergeWorktreePath` (src/paths.ts)
adds the `_merge` checkout path. Tests: new test/worktree-pool.test.ts, plus assertions in
test/paths.test.ts and test/config-validation.test.ts. Nothing leases a slot yet — part 4/5 wires
the loops to it.

Design: plans/worktree-pool.md ("Layout", "Config", "Leases").

**Goal.** Add the pool machinery every later landing step leases from, changing no landing
behavior yet. Part 3/5 already landed `slots-state.ts` and the `slotWorktreePath` /
`slotsStatePath` / `slotsLockPath` helpers, so this step adds only the lease surface and its
config.

**Approach.**
1. **Config.** Add `worktreeSlots?: number` to `TumwaterConfig` (src/config/config-schema.ts,
   beside `maxConcurrentChecks`, including its hand-maintained key list). Leave it unset in the
   default config and resolve it through a new `slotCount(config)` helper that returns
   `config.worktreeSlots ?? config.maxConcurrent + 1`, so the default tracks `maxConcurrent`.
   Validate it as `POSITIVE_INTEGER` in src/config/config-validation.ts.
2. **Path.** Add `mergeWorktreePath(root)` → `_merge` in src/paths.ts, beside the slot helpers.
3. **Pool.** New file `worktree-pool.ts` under src/git/:
   - `leaseSlot(root, { role, purpose, ref, signal })` returns `{ dir, release() }`.
   - **Choice order:** (1) a slot pinned for the role (pins are unused until part 4/5);
     (2) the free slot this role released most recently; (3) the free slot released most
     recently by anyone; (4) a new `_slot-<n>` while fewer than `slotCount` unpinned slots
     exist; (5) otherwise wait first-in first-out, aborting on `signal`.
   - **Use.** The lease holds `useWorktree` (src/git/worktree-use.ts) for its duration and
     prepares the slot with `ensureDetachedWorktree(root, dir, ref)` (src/git/worktree.ts).
   - **State.** Persist every change through `updateSlotsState` (src/git/slots-state.ts),
     reusing its `SlotRecord`/`SlotLease` shape. Clear leases whose `pid` is not the running
     process on first use.
   - **Release.** Record `lastRole`/`lastReleasedAt`, and remove idle unpinned slots left over
     when `worktreeSlots` shrank.

**Files touched.** `worktree-pool.ts` under src/git/ (new), src/paths.ts,
src/config/config-schema.ts, src/config/config.ts, src/config/config-validation.ts. Tests:
`worktree-pool.test.ts` under test/ (new), test/paths.test.ts, test/config-validation.test.ts.

**Acceptance criteria.**
- **Config.** An omitted `worktreeSlots` resolves through `slotCount` to `maxConcurrent + 1`; a
  value below 1 is rejected.
- **Concurrency.** With `worktreeSlots: 2`, two concurrent leases hold two different `_slot-*`
  dirs; a third waits and proceeds when one is released; a waiting lease honors `signal` abort.
- **Affinity.** A role's lease prefers the free slot it released most recently.
- **State.** slots.json shows the lease while held and none after release; a lease whose `pid`
  is another process is cleared.
- `npm run test` green.


### Worktree pool, part 3/5: readers find a role's checkout through `roleWorktreeDir` (planned 2026-10-06 by operator; done 2026-10-07 by feature; landed before part 2/5, which is flagged too large — slots-state.ts owns the shared format)

**What landed (2026-10-07).** New src/git/slots-state.ts owns the pool's persisted layout and its
cross-process lock: `readSlotsState`/`writeSlotsState`/`updateSlotsState`, `slotForDir`, and
`roleWorktreeDir` (a slot leased for a tick, then a slot pinned for the role, then the usable
legacy worktree, then null). `collectRoleChange` reads through it, so `tumwater diff` and the
GUI's `/api/diff` follow a role's slot. `retire` resolves the checkout through it and, for a
slot, clears `pinnedFor` under the slots lock and resets the slot clean and detached instead of
removing it; legacy worktrees are removed as before, and an unusable legacy directory still trips
the safety rail. `doctor` has no role-worktree probe (doctor-orphans.ts walks worktree directories
generically), so there was nothing to retarget. `paths.ts` gains `slotWorktreePath`,
`slotsStatePath` and `slotsLockPath`. Until role ticks lease slots (part 4/5) no behavior changes:
with no slots.json every reader falls back exactly as before. The state writer lives in
slots-state.ts, ready for the later pool module to import.

Tests: a slot-leased diff case in test/change-data.test.ts and a pinned-slot retire case in
test/retire.test.ts.

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

**Files touched.** src/git/slots-state.ts (new), src/change/change-data.ts,
src/operator/retire.ts, src/doctor/* (no role-worktree probe to retarget). Tests: cases in
test/change-data.test.ts, test/retire.test.ts and a fabricated slots.json fixture.

**Acceptance criteria.**
- **Slot lease.** With a slots.json that lists `_slot-1` leased by `feature` for a tick,
  `tumwater diff --role feature` reports the changes in `_slot-1`.
- **Fallback.** With no slots.json, every reader behaves exactly as before.
- **Retire a pinned slot.** It leaves `_slot-1` on disk, clean, detached and unpinned, and
  deletes the branch.
- `npm run test` green.

### Robust conflict landing, part 2/2: a conflict the resolver cannot settle goes back to its author with the markers in place, instead of being discarded (planned 2026-10-07 by operator; requires part 1/2 landed; done 2026-10-07 by feature)

**What landed (2026-10-07).** `LoopState.conflictHandback` (src/loop/loop-state.ts) records a
change handed back to its author: its sha, reason (`landing` | `revision`), revision round, and
whether the re-apply happened. `MERGE_CONFLICT_LIMIT` is 2; at the cap
`recoverLeftover` returns `handback` and keeps the pin instead of discarding it, and a lineage
already handed back once is discarded with a warning naming both attempts (leftover.ts).
`applyWithConflicts` (revision.ts) cherry-picks the diff onto current main and, on conflict,
reads the unmerged paths, runs a mixed `git reset` to drop the index state, and leaves the
markers as ordinary uncommitted edits. loop.ts applies a landing hand-back during tick setup,
before the authoring run, and deletes the landing ref; the revision branch falls back to
`applyWithConflicts` and still rides as a revision round. `buildConflictHandbackNote`
(gate-prompts.ts) names the conflicted files, says whether the change was approved or under
revision, and shows the same "What main changed" intent block part 1/2 gives the resolver.
`conflictMarkerFindings` (stage-check.ts) flags a changed file still holding a marker, reusing
`hasConflictMarkers`. `conflict_handback` events (events.ts, event-format.ts) log
`queued`/`applied`/`failed`, and `applyLandingOutcome` clears the record when the resolved
change lands or is rejected. The record's `applied` flag and its persistence are the one
addition beyond the entry's sketch: keeping the record (rather than clearing it at apply) while
the resolved change is queued or pinned is what makes "one hand-back per change" hold once the
author commits a new sha, and `applyTickOutcome` clears it when a tick abandons the marker edits
without committing them, so a stale record never discards a later change's own hand-back.

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

### Parallel work instances, part 4/7: the harness assigns each multi-instance loop one backlog entry and holds the claim through landing (planned 2026-10-07 by operator; requires parts 1/7 and 2/7 landed; done 2026-10-07 by feature)

Design: plans/parallel-work-instances.md ("Claims").

**What landed (2026-10-07).** src/scheduling/claims.ts holds the pure policies (heldKeys,
assignNext, claimReleaseReason, listedKeys, movedOutEntries/stagedMovedEntries); the poll's
per-multi-runner-group setup releases claims and assigns free entries, and an extra instance
with none free is skipped without touching its backoff. The assignment note is
buildAssignmentNote (gate-prompts.ts), appended by assembleTickPrompt, whose entry-range
lookup resolves an instance id through its base role (eligibleEntries) so a bugfix instance
reads BUGS.md's range. tick-stage records a staged claim only for a multi-instance base
(`configuredInstances > 1`, src/roles/loop-ids.ts) — a single-runner role stages none, so its
next prompt and scheduling are unchanged — and raises the assigned-moved finding through
assignedMovedFinding (stage-check.ts); tick-finalize releases on a terminal result. Two
pieces landed outside the entry's original file list: `loopEnabled`/`configuredInstances`
(src/roles/loop-ids.ts) read `roles.<id>.instances` through a cast so an extra instance can
be eligible before part 5/7 adds the schema field and its validation (part 5/7 replaces the
cast), and loop.ts passes `mainBranch` into TickStageContext (optional, so existing callers
keep compiling). The
prompt's sibling held-titles exclusion list is not landed: assembleTickPrompt sees only its
own state, and reading sibling loop states for a prompt was not worth the extra I/O; no
acceptance criterion requires it.

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

**Files touched (landed).** src/loop/loop-state.ts, src/scheduling/claims.ts (new),
src/roles/loop-ids.ts, src/loop/loop.ts, src/orchestrator/orchestrator-scheduling.ts,
src/tick/tick-prompt.ts, src/gates/gate-prompts.ts, src/tick/tick-stage.ts,
src/tick/stage-check.ts, src/tick/tick-finalize.ts, src/events/events.ts. Tests:
test/claims.test.ts (new), plus cases in the orchestrator-scheduling, tick-stage and
tick-finalize tests.

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


### Parallel work instances, part 1/7: one role, several loop ids — normalize every catalog-role lookup through `baseRoleOf` (planned 2026-10-07 by operator; done 2026-10-07 by feature)

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
Tests: test/loop-ids.test.ts (new; covers the cap grouping, validation and stamp), plus a case
in the scheduling and tick-prompt tests.

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

### Parallel work instances, part 2/7: mark backlog entries blocked by an unlanded prerequisite, refused, or needing review (planned 2026-10-07 by operator; done 2026-10-07 by feature)

Design: plans/parallel-work-instances.md ("Eligibility").

Context: plan series serialize through heading clauses such as `requires part 1/4 landed`,
`requires parts 1/5–3/5 landed` and `requires Disk floor 2/4 and Worktree pool 1/5 landed`.
Nothing parsed them, so every feature tick read entries it could not do yet.
src/backlog/backlog-eligibility.ts now parses the clause and the note holds, and the
`<backlog-index>` block marks each held entry.

**What landed.**
1. **Module.** src/backlog/backlog-eligibility.ts, pure over markdown text:
   - `entryKey(title)`: `ENTRY_STAMP_META_RE` stripped, whitespace collapsed, lowercased.
   - `seriesPart(title)`: `{ series, part, of }` from `<Series>, part i/n:`, or null; the part
     token keeps the historical lettered forms (`2a/3`).
   - `requiredParts(title)`: parses only the heading's trailing parenthetical through
     `requires <ref>((, | and )<ref>)* landed`, refs of `[<Series>] [part|parts] i/n[–j/n]`;
     ranges expand and a bare ref means the entry's own series. Unparseable → `[]`.
   - `entryHold(entry, planned)`: `"refused"` for a `**Refused ` body line, `"needs-review"`
     for the `**Needs review ` prefix, `"needs-replan"` for the `**Needs replan ` prefix,
     `{ blockedBy }` when a required `(series, part)` is still among `planned`, else `null`.
     Bodies mentioning "requires" are never consulted.
   - `eligibleEntries(root, role)`: `plannedPlanEntries` for feature or `openBugEntries` for
     bugfix, each with key, title and `actionableEntryRanges` range, in file order, minus held
     entries.
2. **Index.** `renderBacklogIndexBlock` appends ` [blocked: requires <Series i/n>, …]`,
   ` [refused]`, ` [needs review]` or ` [needs replan]` to held entries.
3. **Charter.** The feature charter's step 2 now says to skip entries the index marks blocked,
   refused or needing review.

**Files touched.** src/backlog/backlog-eligibility.ts (new),
src/backlog/backlog-structure.ts, src/roles/role-catalog.ts, src/roles/role-guidance.ts
(`NEEDS_REVIEW_PREFIX`, mirroring `NEEDS_REPLAN_PREFIX`). Tests:
test/backlog-eligibility.test.ts (new), covering every `requires` form in PLANS.md's history
(own-series, range, explicit series, `and`/`,` separators, historical lettered parts) and the
note holds, plus cases in test/backlog-structure.test.ts's backlog-index tests.

**Acceptance criteria.**
- **Prerequisites.** A heading naming a still-planned `(series, part)` is held with those
  labels (`{ blockedBy: ["Disk floor 2/4"] }`); the same clause naming a landed or absent part
  is not. A bare ref resolves to the entry's own series; an unparseable clause blocks nothing.
- **Body text** containing "requires" never blocks — only the heading's trailing parenthetical.
- **Refused / Needs review / Needs replan.** Each note holds the entry and indexes
  `[refused]` / `[needs review]` / `[needs replan]`; `eligibleEntries` drops them.
- **Ranges.** `eligibleEntries` returns file order with the index's 1-based `start`/`end`.
- `npm run test` green.

### Disk floor, part 3/4: reclaim long-idle worktrees, and a `tumwater reclaim` command (planned 2026-10-06 by operator; requires part 2/4 landed; done 2026-10-07 by feature)

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

### Parallel work instances, part 3/7: insert-only conflicts in PLANS.md, BUGS.md and QUESTIONS.md resolve without a model run (planned 2026-10-07 by operator; done 2026-10-07 by feature)

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

### `tumwater run --gui`: boot the engine and the browser dashboard from one command (planned 2026-10-07 by operator; done 2026-10-07 by feature)

Context: `tumwater run` boots the fleet and streams events; the browser dashboard is a separate
`tumwater gui` process the operator starts in another terminal. The request is one command for
both. The dashboard already owns a standalone lifecycle — `cmdGui` (src/gui/gui-command.ts) parses
`--port`/`--all-interfaces`/`--token`, calls `startGui` (src/gui/gui-server.ts), prints its banner,
and self-reloads onto a newer build (startGui's reload watch, src/redeploy/self-reload.ts) — so the
new mode reuses it rather than standing up a second server.

**Approach.**
1. **Flag.** Add `{ names: ["--gui"] }` to `RUN_FLAG_SPECS` (src/cli/cli-flag-specs.ts), noted as
the one-command form of the dashboard: it uses the defaults (loopback, port 7180), and the
dashboard's own flags stay on `tumwater gui`. The dispatcher's `rejectUnknownArgs("run", …)` gate
already shares `RUN_FLAG_SPECS`, so no cli.ts change.
2. **Rival shape.** In `cmdRun` (src/cli/cli-run.ts), beside the existing `--role`/`--once` check,
fail `--gui` with `--once` through `failRivalShapes("--gui", "--once", "a one-round run cannot
serve a dashboard it is about to kill")`. `--for` + `--gui` stays allowed: the dashboard serves
for the window.
3. **Spawn from the supervisor.** The dashboard must outlive the orchestrator generations (the
supervised child exits RESTART_EXIT_CODE on each redeploy), so the supervisor half
(`superviseRunCommand`) starts it, not the generation. Add `spawnGuiChild(signal, env)` to
src/process/supervisor.ts beside `spawnRunChild`, sharing a `spawnSupervised` helper that
attaches the abort/SIGTERM wiring and the spawn-failure `error` handler (a bare spawn would
throw an unhandled `'error'` on EMFILE/ENOMEM): it spawns `[script, "gui"]`, stdio shared,
deliberately NOT `SUPERVISED_ENV`. The caller sets `DASHBOARD_CHILD_ENV` to the supervisor's pid,
so the dashboard's own reload watch knows its supervisor: on a redeploy the child exits
RESTART_EXIT_CODE for `superviseDashboard` to respawn a fresh sibling, and a supervisor killed
outright (SIGKILL, a crash) leaves the child to exit and free its port. The child shares the
terminal's foreground process group, so a terminal Ctrl+C reaches it directly.
4. **Wiring and teardown.** In `superviseRunCommand`, compute the plan once with a new exported
helper `guiChildPlan(runArgs)` returning `{ spawnGui: boolean; orchestratorArgs: string[] }`,
where `orchestratorArgs` strips `--gui` so the supervised generation's `cmdRun` never sees it.
When `spawnGui`, start a concurrent `superviseDashboard(signal)` task before `superviseRun` (it
respawns the dashboard on each RESTART_EXIT_CODE) and pass `orchestratorArgs` (not `runArgs`) to
`spawnRunChild` inside the `spawnChild` closure. A `guiController` abort in the SIGTERM handler
and again after `superviseRun` returns SIGTERMs the dashboard (via `spawnGuiChild`'s abort wiring)
before `process.exit(code)`. SIGINT needs no forwarding: the terminal already delivered it to the
dashboard.
5. **Help and README.** Update the `tumwater run` stanza in src/cli/help.ts to list `[--gui]` and
name the dashboard and its default address, and update README's Usage block and its "Watch the
fleet" row to show the one-command form.

**Non-goals (settled).** Port/token selection stays on `tumwater gui`; `run --gui` always serves
the default 7180 on loopback. A dashboard that cannot bind prints its own busy-port message and
the engine keeps running — the supervisor does not block boot on dashboard readiness.

**Files touched.** src/cli/cli-flag-specs.ts, src/cli/cli-run.ts, src/process/supervisor.ts,
src/cli/help.ts, README.md. Tests: test/cli-run.test.ts (the `guiChildPlan` cases: `--gui` sets
`spawnGui` and is stripped, absence leaves the args untouched), test/cli-args.test.ts (the run
valid-flags list gains `--gui`), test/cli-run-live.test.ts (a live `run --gui` that sees both
banners and, after SIGTERM, exits 0 with the dashboard port bindable again; `t.skip()` when 7180
is already taken, so the skip is honest rather than an early return; plus the `--gui --once`
rejection).

**Acceptance criteria.**
- `tumwater run --gui` prints both the run banner and `tumwater gui at http://127.0.0.1:7180`, and
the dashboard answers `GET /` with the tumwater page while the fleet runs.
- A SIGTERM to the `run --gui` supervisor exits 0, and the dashboard port is free again after it.
- `tumwater run --gui --once` fails before boot with the rival-shapes message.
- The `guiChildPlan` unit cases pin the arg split; the live `run --gui` test pins the spawn,
serve, and teardown wiring (it skips when 7180 is already taken by another dashboard).
- `npm run test` green.

### Replan a plan whose change used up its review rounds, instead of re-authoring the same plan from scratch (planned 2026-10-07 by operator; done 2026-10-07 by feature)

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
   - land that markdown-only change and nothing else. Its landing is review-exempt, so no
     verdict is recorded; the landing fold's `clearSupersededRejection`
     (src/tick/tick-apply.ts, landed 2026-10-07) clears the standing rejection, and a
     tick-prompt test pins that the instruction does not re-inject once the note lands.

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
- **Retires.** Once the markdown-only replan note lands, the next feature tick no longer
  carries the replan instruction.
- `npm run test` green.

### Disk floor, part 4/4: show free space, the disk hold and the last reclaim on status, TUI and GUI (planned 2026-10-06 by operator; done 2026-10-07 by feature)

Design: plans/disk-floor.md ("Surfaces").

**Goal.** An operator sees why the fleet stopped, without reading events. The status, TUI and
GUI processes cannot call statfs on the orchestrator's behalf in a consistent way, so the
orchestrator publishes what it measured.

**Approach.**
1. **Publish.** Add `disk?: { freeGB, holdGB, reclaimGB, held, lastReclaim?: { at, mode,
   freedGB } }` to `OrchestratorInfo` (src/fleet/orchestrator-info.ts); `ReclaimController`
   (src/fleet/reclaim.ts) records the most recent pass that cleaned anything. `pollFleetGates`
   (src/gates/gate-polls.ts) writes it only when it changes, like `budget`, rounding `freeGB`
   to one decimal.
2. **Header badge.** Add `diskBadge` to src/ui/badges.ts, after `budgetBadge`/`quietBadge`. It
   shows the free space and the hold ("disk 8.2 GB free — holding new work") while the fleet
   holds, or the bare reading while free space is below `reclaimGB`; a recorded reclaim appends
   its freed size and age, so the last reclaim stands on the header and the GUI sidebar even
   after space recovers.
3. **Alert.** Add a `disk` alert in src/ui/fleet-alerts.ts while the fleet holds.
4. **Loop phase.** A held loop's phase reads "disk hold" in src/ui/status-model.ts, ranked
   like "budget paused".
5. **Status.** `tumwater status` (src/status/status-data.ts) shows the same facts in the
   header, the payload ships the raw block and the preformatted badge (src/ui/status-payload.ts,
   src/ui/status-render.ts), and the GUI sidebar renders that badge (src/ui/gui/gui-client-fleet.ts,
   src/ui/gui/gui-client-model.ts).

**Files touched.** src/fleet/orchestrator-info.ts, src/fleet/reclaim.ts, src/gates/gate-polls.ts,
src/ui/badges.ts, src/ui/fleet-alerts.ts, src/ui/status-model.ts, src/status/status-data.ts,
src/ui/status-render.ts, src/ui/status-payload.ts, src/ui/gui/gui-client-fleet.ts,
src/ui/gui/gui-client-model.ts. Tests: cases in the existing badge, fleet-alert, status-model,
status-header, status-render, status-payload, gui-client-sidebar, gate-polls and status-data
tests.

**Acceptance criteria.**
- **Held.** A published `disk.held: true` shows the badge, the alert and the "disk hold" phase
  on held loops.
- **Low but not held.** Free space below `reclaimGB` while not held shows the badge only.
- **Last reclaim.** A published `disk.lastReclaim` names its freed size and age on the header
  and the GUI sidebar, held or after space recovers.
- **Missing.** No `disk` field, as with an older orchestrator, renders exactly as today.
- `npm run test` green.

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
