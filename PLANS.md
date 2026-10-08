# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Organize the test suite, part 3/6: harness and oracle modules move to `test/helpers/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6 and 2/6 landed)

**Goal.** Move `test/oracles.ts`, `test/cli-harness.ts`, `test/exit-capture.ts`,
`test/gui-client-scope.ts`, `test/pi-run-harness.ts`, `test/exit-with-owner.ts` into
`test/helpers/`.

**Approach.**
- `git mv` the six modules into `test/helpers/`.
- Rewrite every importer's `./<name>.js` specifier to `./helpers/<name>.js`.
- Re-base the moved modules' own imports:
  - `cli-harness.ts`: `../src/cli.js` → `../../src/cli.js`; its `./victim-fixture.js` import
    becomes `../victim-fixture.js` (victim stays at the root until part 6).
  - `gui-client-scope.ts`: `../src/ui/gui/gui-client.js` → `../../src/ui/gui/gui-client.js`.
  - `pi-run-harness.ts`: `./wait.js` stays a sibling `./wait.js` (part 2); `./repo-fixtures.js`
    becomes `../repo-fixtures.js` (moves in part 4); `./fake-pi.js` becomes `../fakes/fake-pi.js`
    (part 1).
  - `oracles.ts`, `exit-capture.ts`, and `exit-with-owner.ts` have no relative imports.
- `test/victim-fixture.ts` (still at the root) imports `./exit-with-owner.js`; point it at
  `./helpers/exit-with-owner.js` now. Its own `OWNER_PRELOAD` `new URL("./exit-with-owner.js", ...)`
  stays sibling-relative until victim itself moves in part 6.
- `test/build-check-process.test.ts` embeds `./exit-with-owner.js` in a generated path; point it at
  `./helpers/exit-with-owner.js`. Update `test/victim-fixture.ts`'s comment paths and BUGS.md
  references.

**Files touched.** The six modules; every `test/*.ts` importing them (≈87 specifiers); plus
`test/victim-fixture.ts` and `test/build-check-process.test.ts`.

**Acceptance criteria.**
- The six modules live in `test/helpers/`; no `test/*.ts` specifier names any at the root.
- `cli-harness.ts` resolves `CLI` at `../../src/cli.js` and its victim fixture at
  `../victim-fixture.js`; `gui-client-scope.ts` resolves `gui-client.js` one level up.
- `npm run test` green and selects the same `*.test.ts` files.

### Organize the test suite, part 4/6: `repo-fixtures.ts` moves to `test/fixtures/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–3/6 landed)

**Goal.** Move the highest-fanout support module, `test/repo-fixtures.ts`, into `test/fixtures/`.

**Approach.**
- `git mv` `test/repo-fixtures.ts` into `test/fixtures/`.
- Rewrite every importer's `./repo-fixtures.js` specifier to `./fixtures/repo-fixtures.js`
  (≈225 specifiers) — including modules already moved in parts 1–3, where it becomes
  `../fixtures/repo-fixtures.js` (`fake-pi.ts`, `pi-run-harness.ts`) and root fixture modules.
- Re-base `repo-fixtures.ts`'s own imports: its `./fake-commands.js` becomes
  `../fakes/fake-commands.js`.

**Files touched.** `test/repo-fixtures.ts`; every `test/*.ts` importing it.

**Acceptance criteria.**
- `repo-fixtures.ts` lives under `test/fixtures/`; no `test/*.ts` specifier names `./repo-fixtures.js`.
- Its `writeScript`/`pathPrepend` imports resolve from `test/fakes/`.
- `npm run test` green and selects the same `*.test.ts` files.

### Organize the test suite, part 5/6: log, loop, orchestrator and status fixtures plus `pi-events` and `victim-fixture` move to `test/fixtures/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–4/6 landed)

**Goal.** Move `test/log-fixtures.ts`, `test/loop-fixtures.ts`, `test/orchestrator-fixtures.ts`,
`test/status-fixtures.ts`, `test/pi-events.ts`, and `test/victim-fixture.ts` into `test/fixtures/`.

**Approach.**
- `git mv` the six modules into `test/fixtures/`.
- Rewrite every importer's `./<name>.js` specifier to `./fixtures/<name>.js` (≈223 specifiers).
- Re-base the moved modules' own imports (its own directory is `test/fixtures/`, part 4's
  `repo-fixtures.ts` is already a sibling):
  - `log-fixtures.ts`: `./repo-fixtures.js` and `./pi-events.js` stay siblings.
  - `loop-fixtures.ts`: `./repo-fixtures.js` stays a sibling; `./fake-commands.js` becomes
    `../fakes/fake-commands.js`.
  - `orchestrator-fixtures.ts`: `./repo-fixtures.js` stays a sibling; `./fake-pi.js` becomes
    `../fakes/fake-pi.js`; `./wait.js` becomes `../helpers/wait.js`.
  - `status-fixtures.ts`: `./log-fixtures.js` stays a sibling; `./oracles.js` becomes
    `../helpers/oracles.js`.
  - `victim-fixture.ts`: `./helpers/exit-with-owner.js` becomes `../helpers/exit-with-owner.js`,
    and `OWNER_PRELOAD`'s `new URL("./exit-with-owner.js", import.meta.url)` becomes
    `new URL("../helpers/exit-with-owner.js", import.meta.url)`.
  - `pi-events.ts` has no relative imports.
- `test/cli-harness.ts` (already in `test/helpers/`) imports `../victim-fixture.js` from part 3;
  update it to `../fixtures/victim-fixture.js`.
- Update BUGS.md references to `test/pi-events.ts`, `test/victim-fixture.ts`, and the moved
  fixtures.

**Files touched.** The six modules; every `test/*.ts` importing them; `test/cli-harness.ts`;
BUGS.md references.

**Acceptance criteria.**
- The six modules live in `test/fixtures/`; no `test/*.ts` specifier names any at the root.
- `victim-fixture.ts`'s `OWNER_PRELOAD` resolves `../helpers/exit-with-owner.js`; `cli-harness.ts`
  resolves `../fixtures/victim-fixture.js`.
- `npm run test` green and selects the same `*.test.ts` files.

### Organize the test suite, part 6/6: remaining fixtures move to `test/fixtures/`, leaving the root clean (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires parts 1/6–5/6 landed)

**Goal.** Move the remaining fixture modules — `config-fixtures.ts`, `doctor-fixtures.ts`,
`gate-fixtures.ts`, `gui-fixtures.ts`, `lander-fixtures.ts`, `landing-fixtures.ts`,
`models-fixtures.ts`, `redeploy-fixtures.ts`, `tui-fixtures.ts` — into `test/fixtures/`, leaving
`test/` root with only `*.test.ts` and the three runner-infrastructure modules.

**Approach.**
- `git mv` the nine modules into `test/fixtures/`.
- Rewrite every importer's `./<name>.js` specifier to `./fixtures/<name>.js`.
- Re-base the moved modules' own imports (targets already in subdirectories use
  `../<dir>/<name>.js`):
  - `doctor-fixtures.ts`: `./fake-commands.js` → `../fakes/fake-commands.js`; its existing
    `./fakes/process.js` import is unchanged; `./repo-fixtures.js` stays a sibling.
  - `lander-fixtures.ts`: `./fake-commands.js` and `./fake-pi.js` → `../fakes/...`;
    `./pi-events.js` and `./repo-fixtures.js` stay siblings.
  - `landing-fixtures.ts`: `./wait.js` → `../helpers/wait.js`; `./log-fixtures.js`,
    `./loop-fixtures.js`, `./repo-fixtures.js`, and `./pi-events.js` stay siblings.
  - `tui-fixtures.ts`: `./wait.js` → `../helpers/wait.js`; `./repo-fixtures.js` stays a sibling.
  - `gate-fixtures.ts`: `./repo-fixtures.js` stays a sibling.
  - `redeploy-fixtures.ts`: `./wait.js` → `../helpers/wait.js`.
  - `gui-fixtures.ts`: `../src/gui/gui-server.js` → `../../src/gui/gui-server.js`.
  - `config-fixtures.ts`: `../src/config/config-validation.js` and `../src/text/text.js` become
    `../../src/...`.
  - `models-fixtures.ts` has no relative imports.
- Update the remaining doc/comment references to moved paths: `DEVELOPMENT.md`'s
  `writeScript (test/fakes/fake-commands.ts)`, BUGS.md's `test/repo-fixtures.ts` /
  `test/doctor-fixtures.ts` / `test/gui-fixtures.ts` citations,
  `src/landing/landing-vetting.ts`'s `test/orchestrator-fixtures.ts` comment, and any `docs/` or
  `src/` comment naming an old flat path.

**Files touched.** The nine modules; every `test/*.ts` importing them; the doc/comment references.

**Acceptance criteria.**
- All 30 support modules live under `test/fakes/`, `test/fixtures/`, or `test/helpers/`; the
  `test/` root holds only `*.test.ts` plus `test-runner.ts`, `test-durations-reporter.ts`, and
  `coverage-table.ts`.
- A grep over `src/`, `test/`, `scripts/`, `docs/`, `DEVELOPMENT.md`, `PLANS.md`, and `BUGS.md`
  for each moved basename at its old flat path (`test/repo-fixtures.ts`, `test/lander-fixtures.ts`,
  …) finds no stale reference.
- `npm run test` (eslint + tsc + the suite) is green and selects the same `*.test.ts` files.

### Worktree pool, part 4c/5: retire legacy role worktrees at orchestrator start (planned 2026-10-06 by operator; split 2026-10-07 by plan; replanned 2026-10-08 by plan after two review rejections; requires parts 2a/5, 3/5, 4a/5 and 4b/5 landed)

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
1. Add `retireLegacyRoleWorktrees(root, enabled)` to `src/git/worktree-pool.ts` and call it from
   `runOrchestrator` right after `removeLegacyLandWorktrees`, before the `RetentionPruner`
   construction and before ticks start. Pass the orchestrator's `enabled` role list. Return early
   when `.tumwater/worktrees/` does not exist.
2. Enumerate subdirectories of `.tumwater/worktrees/` (`worktreesDir`); a candidate legacy role
   dir is one whose basename is not `DIRECTOR_ROLE` and does not start with `_` (`_slot-<n>`,
   `_merge`, `_gate-main` and `_main` are skipped).
3. For each candidate, read `loadLoopState(root, role)` and set
   `resumable = state.resumePending === true || state.running === true`.
   - **Resumable and `enabled.includes(role)`:**
     - If the role already owns a slot (`slot.pinnedFor === role`, or
       `slot.lease?.role === role && slot.lease.purpose === "tick"`), the resume happens there:
       drop any record for the legacy path, pin that owned slot for the role when it had only a
       tick lease, and `removeWorktree(root, role)` the legacy dir.
     - Otherwise register the legacy dir in slots.json as
       `{ dir, lease: null, pinnedFor: role, lastRole: null, lastReleasedAt: null }`, so the next
       tick leases it (4a's `keep`) and resumes in place.
   - **Not resumable, or the role is not in `enabled`:** drop any record for the legacy path and
     `removeWorktree(root, role)` (src/git/worktree.ts); the branch keeps any commit.
4. In the same `updateSlotsState` pass, retire pins for roles that no longer run: for every slot
   whose `pinnedFor` names a role outside `enabled`, clear the pin; when that slot's `dir` is not a
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
  `pinnedFor` names a role outside `enabled`.
- The migration leaves `director` and every `_`-prefixed directory untouched.
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
**Needs review 2026-10-08 by feature: too large for one run**


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

### Organize the test suite, part 2/6: utility modules move to `test/helpers/` (planned 2026-10-07 by plan; split from the 2026-10-07 entry; requires part 1/6 landed; done 2026-10-08 by feature)

**Goal.** Create `test/helpers/` and move `wait.ts`, `sleep-clock.ts`, `backdate.ts`,
`json-read.ts`, `fs-faults.ts` from the `test/` root into it.

**Approach.**
- `git mv` the five modules into the new `test/helpers/`.
- Rewrite every importer's `./<name>.js` specifier to `./helpers/<name>.js`. This includes the
  runner-infrastructure module `test/coverage-table.ts` (which stays at the root) importing
  `./json-read.js` → `./helpers/json-read.js`.
- Re-base the moved modules' `../src/` imports for one more level: `sleep-clock.ts`'s
  `../src/build/host-sleep.js` and `json-read.ts`'s `../src/text/text.js` become `../../src/...`.
  `wait.ts`, `backdate.ts`, and `fs-faults.ts` have no relative imports.
- Update comment/doc references to the old flat paths in the same landing (e.g. `src/errno.ts`
  cites `fs-faults.ts`; BUGS.md cites `wait.ts`).

**Files touched.** The five modules; every `test/*.ts` importing them (≈115 specifiers);
`test/coverage-table.ts`; the doc/comment references.

**Acceptance criteria.**
- The five modules live in `test/helpers/`; no `test/*.ts` specifier names any at the root.
- `test/coverage-table.ts` still resolves `readJson` from its new location.
- `npm run test` green and selects the same `*.test.ts` files.

### Organize the test suite, part 1/6: support fakes move to `test/fakes/` (planned 2026-10-07 by plan; split from the 2026-10-07 "Organize the test suite's support modules" entry; parts 1–6 land in order; done 2026-10-08 by feature)

**Umbrella goal (parts 1–6).** Move the 30 flat non-test support modules out of the `test/` root
into `test/fakes/`, `test/fixtures/`, and a new `test/helpers/`, leaving runner infrastructure
(`test-runner.ts`, `test-durations-reporter.ts`, `coverage-table.ts`) and every `*.test.ts` at the
root. `selectTestFiles` (test/test-runner.ts, `fs.readdirSync(distDir)` at the `dist/test` root)
reads non-recursively and keeps only `*.test.js`, so support modules compiled into
subdirectories are ignored and the selected test set is unchanged. Each part moves one group and
updates **every** reference to the modules it moves: a root test file uses `./<dir>/<name>.js`, a
module already in a subdirectory uses `../<dir>/<name>.js`, and each moved module's own relative
imports and `import.meta.url` constants are re-based for its new depth. No `*.test.ts` file moves,
so filter names do not change. Parts land in order 1→6, each green on its own.

**Goal.** Move the three fake support modules — `fake-pi`, `fake-commands`, `fake-res` — from the
`test/` root into the existing `test/fakes/` (joining `log.ts`, `process.ts`, `time.ts`,
`transient.ts`).

**Approach.**
- `git mv` the three modules into `test/fakes/`.
- Rewrite every importer's `./fake-pi.js`, `./fake-commands.js`, `./fake-res.js` specifier to
  `./fakes/<name>.js` (≈86 specifiers across `test/`, including fixture modules that move later).
- Re-base the moved modules' own imports for `test/fakes/`: `fake-pi.ts`'s `./pi-events.js` and
  `./repo-fixtures.js` become `../pi-events.js` and `../repo-fixtures.js` (those move in parts 5
  and 4); its `./fake-commands.js` stays a sibling; `fake-res.ts` has no relative imports.
- `fake-commands.ts`'s `SCRIPT_SHIM` literal `../../test/fixtures/script-shim` becomes
  `../../../test/fixtures/script-shim`, because compiled it now runs from `dist/test/fakes/`
  (BUGS.md 2026-09-30 pinned this constant; a wrong depth silently disables every fake command).
  `test/fake-commands.test.ts`'s relocated-tree refusal copies the compiled module two levels deep
  (`dist/test`) and must copy three levels deep instead.
- `test/fake-pi.test.ts`'s embedded generated path `./fake-pi.js` becomes `./fakes/fake-pi.js`.

**Files touched.** The three modules; every `test/*.ts` importing them; the two test files with
embedded paths.

**Acceptance criteria.**
- The three modules live in `test/fakes/`; no `test/*.ts` specifier names any of them at the root.
- `test/fakes/fake-commands.ts` resolves `SCRIPT_SHIM` at the new depth and `test/fake-commands.test.ts`'s
  relocated-tree case still fails loudly when the shim is absent.
- `npm run test` (eslint + tsc + the suite) is green and selects the same `*.test.ts` files.

### Worktree pool, part 4b/5: role ticks lease a pooled slot (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 1/5, 2a/5, 3/5 and part 4a/5 landed; done 2026-10-07 by feature)

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

**Implementation note (2026-10-07 by feature).** Two details diverged from the approach above so
the code matches the world:
- `checkoutRoleBranch` adds `--ignore-other-worktrees` to `git checkout -f`. Part 4c, which
  retires the legacy role worktrees, lands after this part; while a legacy
  `.tumwater/worktrees/<role>` still holds `tumwater/<role>`, plain `checkout -f` refuses with
  “already used by worktree”. The stale checkout is never used again and 4c removes it.
- The release pin reads the tick's outcome (`aborted`, `quiet_killed`, `cutOff`) plus
  `state.resumePending` for the error-dirty arm, not `state.resumePending` alone:
  `applyTickOutcome` sets `resumePending` for abort/quiet-kill/cut-off only after `runTick`
  returns, so it is still false in `runTick`'s `finally`. `runTickInLease` captures the outcome
  and pins on those results (a later tick clears the pin on release).

Tests also gained `roleWt` and `pinWorktreeAsSlot` in test/loop-fixtures.ts, and a loop-5 test
covering the slot budget, the absence of legacy role worktrees, and the director's dedicated
checkout. Non-director role worktree paths in the orchestrator e2e tier — orchestrator-2,
orchestrator-3 and orchestrator-redeploy — resolve through `roleWt` too; the director's stay
`worktreePath`.

### Worktree pool, part 4a/5: a leased slot can be kept for its role's resume and pinned on release (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 1/5, 2a/5 and 3/5 landed; done 2026-10-07 by feature)

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

### Worktree pool, part 2d/5: remove the `_land-*` machinery and legacy checkouts (planned 2026-10-06 by operator; split 2026-10-07 by plan; requires parts 2b/5 and 2c/5 landed; done 2026-10-07 by feature)

Design: plans/worktree-pool.md ("Vets and merges").

**What landed (2026-10-07).** `removeLegacyLandWorktrees` (src/git/worktree.ts) scans
`.tumwater/worktrees` for `_land-*` directories, removes each through `removeWorktreeDir`
(force `worktree remove`, with the shared dead-registration fallback), then prunes, and
tolerates a missing worktrees dir; `runOrchestrator` (src/orchestrator/orchestrator.ts) calls it
once at startup, after writing the info file and the start event, and before any tick. `landWorktreePath`
(src/paths.ts) and `removeLandWorktree` (src/git/git.ts) are deleted. `discardPinnedRefs`
(src/landing/landing-pipeline.ts) now only deletes the pinned ref — its `_land-<role>` worktree
removal was stale, and a pooled slot's lease owns that release. `readLiveProgress`
(src/ui/progress-data.ts) builds the legacy `_land-<role>` gate cwd locally from
`worktreesDir(root)` + `node:path`, so old logs still demultiplex by cwd. Anchors the entry
missed: it named src/landing/landing-pipeline.ts's stale reference only indirectly (2c/5 left
it for this part), so that file is touched too, and the doctor-orphans fixture's arbitrary
`_land-dry` path is renamed `_slot-1`. New coverage: test/worktree.test.ts for the helper
(removes only `_land-*`, keeps a `_slot-<n>` and a role worktree; no-op with no worktrees dir)
and test/orchestrator-once.test.ts for the startup call site.

**Files touched.** src/orchestrator/orchestrator.ts, src/paths.ts, src/git/git.ts,
src/git/worktree.ts, src/ui/progress-data.ts, src/landing/landing-pipeline.ts. Tests:
test/status-fixtures.ts, test/progress.test.ts, test/paths.test.ts,
test/doctor-orphans.test.ts, test/landing-drain-vetting.test.ts, test/worktree.test.ts,
test/orchestrator-once.test.ts.

**Acceptance criteria.**
- `grep -rn "landWorktreePath\|removeLandWorktree" src` returns nothing.
- Startup removes a pre-existing `_land-feature` directory.
- The old-log progress demux still classifies a session whose cwd is `_land-<role>`.
- `npm run test` green.

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
