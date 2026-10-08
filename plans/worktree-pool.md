# Worktree pool — a fixed set of slot checkouts that ticks and vets lease

Planned 2026-10-06 · requested by user. Shared design for the five `Worktree pool N/5` entries
in PLANS.md. Its sibling, [disk-floor.md](disk-floor.md), bounds what each checkout may cost;
this document bounds how many checkouts there are. Both work for any language.

## Goal

The number of harness checkouts is set by config (`worktreeSlots`), not by the number of
roles. Every cost a checkout carries then scales with the pool size instead of the role count:
- build outputs inside the tree, such as `target/`, `node_modules/`, `.venv/` or `build/`;
- caches outside the tree that a tool keys by checkout path, such as Bazel's output base under
  `~/.cache/bazel`, which is named after a hash of the workspace path.

## Motivation

- **Today one checkout exists per role and per lander.** Each role (the director included)
  owns `.tumwater/worktrees/<role>`, each landing role owns `_land-<role>`, and there is one
  `_gate-main`. A self-hosting fleet adds `_main` and `_build`. With the live fleet's 14 roles
  that is close to 30 checkouts.
- **Only a few of them work at any moment.** The `maxConcurrent` permit (default 6) covers
  every role tick and every landing vet. The director runs outside it, and the drain merges
  one change at a time. So at most `maxConcurrent + 3` checkouts are ever in use, and the rest
  sit idle holding warm build outputs.
- **For a Rust project those idle outputs fill the disk.** See disk-floor.md for the
  measurements.

## Rejected: sharing or moving build state between checkouts

The obvious fixes all move build outputs between paths, and that is unsafe for any language.
Verified with Cargo 1.96 on 2026-10-06:

- **A shared build dir gives false greens.** Two worktrees used one `CARGO_TARGET_DIR`.
  Worktree B's code was changed so its test should fail; its file was written before A built.
  B's `cargo test` then passed: Cargo compiled nothing and reused A's artifacts. Cargo decides
  freshness from file mtimes, and B's changed file was older than A's build.
- **Outputs embed absolute checkout paths.** In the same setup, B's test binary reported
  `env!("CARGO_MANIFEST_DIR")` as A's directory. A test that loads fixtures through it would
  read another loop's checkout. Other tools have the same problem:
  - CMake refuses a `CMakeCache.txt` created in another directory;
  - Python venvs hardcode their own path in `pyvenv.cfg` and in script shebangs.
- **What fixes it is Rust-specific.** Touching every tracked file whenever a build dir changes
  checkout fixed both problems. Nightly's `-Zchecksum-freshness` fixes only the first. Both
  remedies, and the `CARGO_TARGET_DIR` setting itself, are Rust knowledge; another ecosystem
  needs its own.
- **Copy-on-write clones inherit both problems.** Seeding a new checkout by cloning a warm one
  (APFS `cp -c`, btrfs/XFS `--reflink`) puts the same outputs at a new path.
- **Cargo's own fixes are not usable yet.** Shared, concurrency-safe build caches are a 2026
  Cargo project goal; only nightly has fine-grained locking.

**The rule this design follows: build state never changes path.** A slot is an ordinary
checkout at a fixed path. A lease switches it between commits in place with `git checkout` and
`git reset`, the same thing a developer does when switching branches. Every build tool's
incremental logic is built for that: git rewrites only the files that differ, which gives them
fresh mtimes, so the tool rebuilds exactly what changed.

## Warmth

- A role tick starts with `reset --hard main`, and a vet checks out a pinned commit one change
  off main. So a recently used slot is about as warm as a role's own worktree is today:
  whichever slot a role gets, the build catches up only on what changed since that slot's last
  use.
- Preferring a familiar slot is a bonus. A vet prefers the slot its role's tick just released,
  which holds that exact change already built.

## Design

### Layout

- Slots are `.tumwater/worktrees/_slot-<n>`. They are created lazily through
  `ensureDetachedWorktree`, whose `serializeSetup` already orders concurrent `worktree add`s,
  and they stay detached while idle.
- Slots sit at the same depth as role worktrees, so code that finds the root by depth or by
  walking up keeps working unchanged:
  - `ROOT_FROM_WORKTREE` (src/prompt/prompt.ts);
  - `detectBuildCheck`'s walk-up (src/build/build-check-detect.ts);
  - dep-install;
  - the pi extension's `.tumwater` lookup (src/pi-extension/full-output.ts).
- Four checkouts stay dedicated and are not pooled:
  - **`director`.** It runs outside the permit alongside the role ticks, consumes the
    config-request file at its worktree root, and never resumes.
  - **`_merge` (new).** It hosts the landing drain's merge-side work: a single change
    (`landApprovedChange`), a stack and its bisect (`landStack`), the conflict resolver and the
    post-resolve re-review.
    - The drain takes no `maxConcurrent` permit, but its resolver acquires one at `MERGE_TIER`
      while it holds the worktree.
    - Holding a pool slot there could deadlock against permit holders waiting for a slot when
      the pool is small. A dedicated checkout keeps the lock order acyclic.
    - The drain is serial, so one checkout is enough.
  - **`_gate-main`**, unchanged.
  - **`_main` and `_build`**, which only a self-hosting fleet has, unchanged.
- The total is K + 3 checkouts, plus 2 when self-hosting, plus any pinned slots (below).
  - With the default K = `maxConcurrent + 1` = 7, that is 10, against close to 30 today.
  - A small machine running `maxConcurrent: 3` and `worktreeSlots: 3` has 6.

### Config

- `worktreeSlots` is an integer of at least 1. When absent, it defaults to `maxConcurrent + 1`.
- It is read live at each lease. Shrinking it removes surplus slots, idle and unpinned, with
  `git worktree remove` as they are released.
- A value below `maxConcurrent` is allowed. Permit holders then wait for a slot: the pool is
  the disk knob, and `maxConcurrent` stays the model-concurrency knob.

### Leases

- **API.** `src/git/worktree-pool.ts` exports
  `leaseSlot(root, { role, purpose: "tick" | "vet", signal })`, which returns
  `{ dir, release(opts) }`.
- **Which slot a lease gets,** in this order:
  1. the slot pinned for this role;
  2. the free slot this role released most recently;
  3. the free slot released most recently by anyone. This keeps the hot set small, and the
     cold slots fall to disk-floor's idle reclaim;
  4. a new `_slot-<n>`, while fewer than K unpinned slots exist;
  5. otherwise, wait first-in first-out, and abort on `signal`.
- **Leases build on the disk-floor registry.** A lease holds `useWorktree`
  (src/git/worktree-use.ts, Disk floor 2/4). So reclaim never cleans a leased slot, and a lease
  waits for a reclaim already in progress.
- **Lock order.** Take the `maxConcurrent` permit, then the slot, then anything else: a check
  permit or the `_gate-main` queue. A slot holder never waits on the merge lock or on a
  `maxConcurrent` permit.
- **Persisted state.** Every change is written to `.tumwater/state/slots.json` through
  `writeJsonAtomic`. Each slot records:

  ```
  { dir, lease: { role, purpose, since, pid } | null,
    pinnedFor: string | null, lastRole, lastReleasedAt }
  ```

  - The separate processes read it: `tumwater diff`, the GUI's `/api/diff`, `status` and
    `retire`.
  - `retire` also writes it, from the CLI process while the fleet may be running. So every
    read-modify-write goes through `withSyncLock` (src/concurrency/lock.ts) on a `slots.lock`
    beside the file, the way the paused-roles marker is guarded.
  - On orchestrator start, leases held by a pid other than this process are cleared, because
    their runs are dead. Pins are kept.

### Vets and merges (part 2/5)

- **Vets lease a slot.** `vetRequest` (src/landing/landing-batch.ts) leases with purpose
  `vet`, preferring the slot `req.role` used last. It then gives the slot the semantics of
  `ensureDetachedWorktree` at `req.sha`, and releases it when the vet ends, whatever the
  outcome.
  - A vet passes its result on through the landing ref and `VettedLanding`, never through the
    worktree. Every later step re-ensures at a commit (`landing-core.ts`, `landing-stack.ts`),
    so no step depends on the slot after release.
- **Merge-side steps move to `_merge`.** That covers `landApprovedChange`, `landStack` with its
  bisect prefixes, and `attributeRedCheck`'s worktree.
  - Each step already calls `ensureDetachedWorktree` at a commit, so the move is a path change.
  - A new `mergeWorktreePath(root)` in src/paths.ts names the checkout.
- **`removeLandWorktree` call sites are deleted.** A slot is reused, not removed. The call
  sites are in landing-core.ts, landing-check-failures.ts, landing-pipeline.ts and
  landing-batch.ts.
- **Startup removes legacy `_land-*` checkouts.** They hold no state, and queued landings
  re-vet from their pinned refs.

### Readers find a role's checkout (part 3/5)

- `roleWorktreeDir(root, role)` returns, in order:
  1. the slot in `slots.json` leased by the role with purpose `tick`, or pinned for the role;
  2. else the legacy `worktreePath(root, role)` when `isUsableWorktree`;
  3. else `null`.
- These readers switch to it:
  - **`collectRoleChange`** (src/change/change-data.ts), which serves `tumwater diff` and
    `/api/diff`. A `null` result reads as "absent", the shape that function already has for an
    unusable worktree.
  - **`retire`** (src/operator/retire.ts). For a slot it unpins and resets the slot
    (`reset --hard`, `clean -fd`, detach); it never deletes a slot directory. It then deletes
    the branch as today.
  - **`doctor`.**
- This part changes no behavior: until part 4/5 lands, it always resolves to the legacy path.
  It lands first so that part 4/5 cannot break the GUI's diff view in between.

### Role ticks lease slots (part 4/5)

**Lease.**
- `LoopRunner.runTick` (src/loop/loop.ts) replaces `ensureWorktree(root, role, main)` with
  `leaseSlot({ role, purpose: "tick" })` for every role except the director.
- On a slot that is not pinned for this role, it runs `git checkout -f tumwater/<role>`, then
  `git clean -fd`. When the branch does not exist it runs `git checkout -f -b tumwater/<role>
  <main>` instead. It never uses `-B`, which would reset an existing branch and lose an
  unpinned commit.
- Everything after the checkout stays as it is today:
  - `recoverLeftover` reads `main..HEAD`, which is the role's branch;
  - `resetWorktreeToMain` moves the branch;
  - `commitAll` commits on it.
- The branch therefore remains the durable holder of a commit that has no pin yet: a crash
  between commit and pin, a failed pin, or a failed merge of a refusal note. The next lease
  checks the branch out, and leftover recovery finds the commit as it does today.

**Release,** in runTick's `finally`:
- **When the role's state has `resumePending`,** the slot stays **pinned** for the role, with
  the branch checked out and the edits uncommitted.
  - This is required, not an optimisation. pi 1.0.0's `--continue` only considers sessions
    whose recorded cwd equals the current directory exactly (session-manager.js
    `continueRecent`).
  - A resume in any other directory silently starts a fresh session, while tumwater's
    `hasResumableSession` would still report a resumable session.
- **Otherwise,** run `git checkout --detach`. That frees the branch for the role's next slot,
  leaves HEAD where it is, and leaves any commit on the branch.

**Pins.**
- A pinned slot is leased only by its role.
- Pins do not count toward K, so disk use is K + pins. Pins are bounded by the number of roles
  and normally last only until the role's next tick.
- That next tick clears the pin when it releases, whether or not it actually resumed. For
  example, a capped resume or a role in the review phase starts fresh in the pinned slot, and
  `resetWorktreeToMain` discards the edits exactly as today.
- Disk-floor's reclaim skips pinned slots in idle mode and cleans them last in pressure mode.
  `clean -X` never touches the edits.

**Legacy role worktrees,** handled once at startup:
- A `.tumwater/worktrees/<role>` whose role has `resumePending` becomes a pinned legacy slot at
  its existing path, because the resume must keep its cwd. It is removed after that role's
  next release.
- Every other legacy role worktree is removed with `removeWorktree`. Its branch keeps any
  commit.

**Unchanged.** The director keeps `ensureWorktree(root, DIRECTOR_ROLE, main)`.

### Progress demux (part 1/5)

- `feedDemuxed` (src/ui/progress-data.ts) decides whether a pi run belongs to the "gate" (the
  reviewing cell) or to the "author". The authoritative test today is
  `session.cwd === landWorktreePath(root, role)`.
- Once vets and authors share slot paths, the test must not depend on paths. So `runPi`
  (src/pi/pi.ts) writes one more marker line before every run:
  `{ "type": "tumwater_run", "kind": "author" | "gate" }`.
  - **Gate:** the reviewer, the review follow-up, the conflict resolver and the post-resolve
    re-review. That is, every run started from src/review/* or src/landing/*.
  - **Author:** the tick's runs, including the summary and stage-fix follow-ups.
- `feedDemuxed` switches on `kind` when the marker has one, and falls back to the cwd test
  only for lines without it, such as older logs.
- The transcript (src/ui/transcript.ts) must render nothing for a marker that has a `kind` but
  no `label`. Today's `label` marker for reviews is unchanged.

### Observability (part 5/5)

- **`slot_wait` event.** Logged when a lease waited 30 s or more. It carries `role`,
  `purpose`, `waitedMs`, `slots` and `pinned`, and it is the signal to raise `worktreeSlots`.
- **Status and GUI.** `tumwater status` and the GUI's role rows show which slot each running
  tick or vet holds, and any pins.
- **Doctor.** `tumwater doctor` gets `checkWorktreePool`, which reports slots, pins and
  leftover legacy checkouts. It warns on a legacy `<role>` or `_land-*` directory that is
  still present, and on a pin older than 24 h, which usually means a paused role holding a
  checkout.
- **Docs.** docs/how-it-works.md describes slots, `worktreeSlots` and how to size a disk: about
  (K + 3) warm checkouts of the project.

## Phases

1. **Worktree pool 1/5: label every pi run's kind and demultiplex progress by label.**
2. **Worktree pool 2/5: vets lease pool slots and merges use one `_merge` checkout.** Requires
   Disk floor 2/4 (the use registry).
3. **Worktree pool 3/5: readers find a role's checkout through `roleWorktreeDir`.** Requires 2/5.
4. **Worktree pool 4/5: role ticks lease pool slots.** Requires 1/5–3/5.
5. **Worktree pool 5/5: `slot_wait`, status and GUI slot display, doctor, docs.**
   Requires 4/5.

## Out of scope

- **Pooling the director, `_gate-main`, `_merge`, `_main` or `_build`.**
- **Moving, sharing or copy-on-write cloning build outputs between paths** (see "Rejected"
  above).
- **Per-ecosystem settings** such as `CARGO_TARGET_DIR` or sccache. A project may still set
  them in its own environment; tumwater does not depend on them.
- **Parking an interrupted tick's edits so its pin can be released early.** pi's cwd-bound
  `--continue` would lose the session. Revisit only if pins are seen piling up (the doctor's
  24 h warning).
