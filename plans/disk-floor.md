# Disk floor — hold new work and reclaim build outputs before the disk fills

Planned 2026-10-06 · requested by user. Shared design for the four `Disk floor N/4` entries in
PLANS.md. Its sibling, [worktree-pool.md](worktree-pool.md), bounds how many checkouts exist;
this document bounds what they may cost. Both work for any language.

## Goal

A running fleet never fills its disk, whatever the project's language or build tool. When free
space runs low, tumwater first deletes regenerable build outputs from worktrees nobody is using.
If that is not enough, it stops starting new work until space returns. Nothing in this design
names `target/`, `node_modules/`, `dist/`, `.venv/` or any other ecosystem's directory. Git's
own ignore rules decide what is regenerable.

## Motivation

- **A Rust fleet fills a small disk.** Every harness worktree builds the project, so every
  worktree grows its own `target/`.
  - A fleet has about two checkouts per role: the role's worktree plus its `_land-<role>`
    lander. Add `_gate-main`, and 14 roles make close to 30 checkouts.
  - Each Cargo `target/` holds several GB, so the fleet reaches hundreds of GB. On the user's
    second machine, which has a smaller disk, the disk fills.
- **A full disk corrupts more than builds.** Git object writes and `index.lock`, the
  `events.jsonl` append, pi session files and every `writeJsonAtomic` state file all fail with
  ENOSPC. They fail mid-write, in whatever loop happens to be writing.
- **Build dirs only grow.** Cargo never garbage-collects stale artifacts. Every dependency bump,
  feature change or toolchain update leaves a new set beside the old one. Measured on
  2026-10-06 in one long-lived checkout on the dev Mac (`~/hf/xetcas/target`):
  - 102 GB in total;
  - 2,357 rlibs for 482 distinct crates, about 5× the live set;
  - 13 copies of `libduckdb-sys`'s build output at 3 GB each.
  
  A fleet's role worktrees churn dependencies much faster than a human checkout does.
- **Nothing watches today.**
  - No code calls `statfs`.
  - `pruneStaleBuildDir` (src/git/worktree.ts) only removes `dist/`, by age. That is this
    repo's own tsconfig `outDir`, and it is the only build-output cleanup the harness has.
  - Every reset runs `git clean -fd` without `-x`, so ignored files survive forever. That is
    deliberate, because it keeps incremental builds warm. But it also means nothing bounds
    their size.

## Design

### Measuring free space

- `fs.statfsSync(worktreesDir(root))` returns `bavail × bsize`, the bytes available to an
  unprivileged user on the volume the builds write to. It falls back to `root` while the
  worktrees dir does not exist yet.
- One syscall costs microseconds, so the orchestrator samples on every poll (`POLL_MS`, 2 s).
- GB means 10^9 bytes everywhere, in config and in display.
- A platform or filesystem where `statfs` throws never holds. The fleet logs one `warning`
  event per process and `doctor` reports the check as unavailable.
- Build caches that live outside the worktrees volume are not watched. That is out of scope.

### The hold (part 1/4)

- New config key `diskHoldGB`, default 10, where 0 disables it.
- When free space drops below the floor, the fleet enters a **disk hold**. It leaves the hold
  once free space reaches `diskHoldGB + 5`, so a fleet hovering at the line does not flap.
- The hold stops anything new that could build. In-flight work runs on, because killing it
  wastes the work and frees nothing that a finished run would not free anyway. The hold blocks:
  - **Role ticks and the director.** The hold joins `tickStartHeld` in
    src/orchestrator/orchestrator.ts, the predicate whose comment already invites "another
    fleet-wide hold on new ticks". That predicate also gates parked tick waiters and parked
    landing vets at permit time.
  - **The landing drain.** `drainLandings` already sits behind
    `if (!holdForRestart && !reviewHeld)`. The disk hold joins that condition, because merges
    run the project's check too.
  - **Scheduling.** `pollRunnerReasons` (src/orchestrator/orchestrator-scheduling.ts) reports
    the hold as the role's reason, so no tick is reserved for it.
- User prompts stay queued in the inbox. The director runs them when the hold lifts, because a
  director tick can build too.
- The hold logs edge-triggered events, one per crossing, following `pollQuietHoursGate`
  (src/scheduling/quiet-hours.ts):
  - `disk_low` carries `freeGB` and `holdGB`;
  - `disk_ok` carries `freeGB`.
  
  `disk_low` joins the notify hook's notable events and the UI's problem events.
- `tumwater doctor` gets `checkDiskSpace`:
  - **ok** at or above the reclaim threshold, or above the hold floor before part 2/4 lands;
  - **warn** between the two thresholds;
  - **fail** below the hold floor.
  
  Its detail names the volume, the free GB and both thresholds.

### Reclaiming build outputs (parts 2/4 and 3/4)

**What is reclaimed.**
- Reclaiming a worktree means running `git -C <wt> clean -fdX`:
  - `-X` removes **only** files git ignores;
  - a single `-f` leaves nested repositories alone;
  - `-d` recurses into untracked directories.
- Verified 2026-10-06, a worktree holding a modified tracked file, a new untracked file, an
  ignored `target/`, an ignored `*.log` and a nested repo kept exactly the first two and the
  nested repo.
- So reclaim never touches an interrupted tick's uncommitted edits. The language-specific
  question "which dirs are build output?" is answered by the project's own `.gitignore`.

**Which worktrees are candidates.**
- Every linked worktree directly under `worktreesDir(root)`, except:
  - `_main` and `_build`, which exist only for a self-hosting fleet and are used by the
    redeployer;
  - any worktree in use right now (below).
- **Guard.** Before cleaning, assert two things:
  - the path resolves inside `worktreesDir(root)`;
  - `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`, which proves it is
    a linked worktree and not the primary checkout.
  
  The primary checkout's `.gitignore` lists `.tumwater/`, so a `clean -X` there would delete
  the fleet's entire state. A test pins this guard.

**In use.**
- A new in-process registry, `src/git/worktree-use.ts`. The orchestrator is the one process
  that runs ticks and landings, so in-process state is enough.
- `useWorktree(root, dir, fn)` holds a use count around `fn`. On release it records
  `lastUsedAt` in `.tumwater/state/worktree-use.json` (via `writeJsonAtomic`), so least-recent
  ordering survives a restart.
- `claimForReclaim(dir)` returns false while the worktree is in use. Otherwise it marks the
  worktree as reclaiming. A `useWorktree` that arrives meanwhile waits for the clean to finish
  before `fn` runs, so a tick never starts in a half-cleaned tree.
- A worktree the registry has never seen counts as used at first sight. Upgrading therefore
  does not wipe every warm build at once.
- Wrapped sites, each from its first touch of the worktree to its last:
  - a role or director tick, in `LoopRunner.runTick` (src/loop/loop.ts), from
    `ensureWorktree` to the tick's end;
  - a vet, `vetRequest` (src/landing/landing-batch.ts);
  - a merge, `landApprovedChange` (src/landing/landing-core.ts);
  - a stack, `landStack` (src/landing/landing-stack.ts);
  - the `_gate-main` baseline in src/baseline/main-red.ts.
  
  [worktree-pool.md](worktree-pool.md) later builds slot leases on this registry rather than
  beside it.

**When reclaim runs.** A pass runs in the background, one at a time and never awaited by the
poll. A clean that deletes 100k files can take a minute, which is the same reason
`launchServicesWatch.poll()` is never awaited.
- **Pressure mode (part 2/4).** When free space is below `diskReclaimGB` (new key, default 40, 0
  disables, must be at least `diskHoldGB`):
  - reclaim idle candidates in least-recently-used order, re-sampling free space after each;
  - stop as soon as free space is back at `diskReclaimGB`;
  - clean a role worktree whose loop state has `resumePending` last. Its interrupted run may
    have been using its ignored files.
- **Idle mode (part 3/4).** Once a worktree has been unused for `worktreeIdleReclaimHours` (new
  key, default 24, 0 disables), reclaim it once, whatever the free space. This catches paused,
  retired and rarely due roles. `worktree-use.json` records `reclaimedAt`, and a worktree is
  not reclaimed again until it has been used since. Idle mode skips worktrees with a pending
  resume.
- **The hold waits for reclaim (part 2/4).** Part 1/4's hold is entered only when free space is
  below the floor after a pressure pass has run since the drop, or immediately when
  `diskReclaimGB` is 0. Ordinarily reclaim keeps the fleet out of the hold altogether.

**Event.** Each pass that cleaned anything logs one `disk_reclaim` event:
- `mode`: `pressure`, `idle` or `manual`;
- `worktrees`: the basenames cleaned;
- `freedGB`: the statfs delta. `du` overcounts clones and hardlinks, so it is not used;
- `freeGB` after the pass;
- `durationMs`.

**Command (part 3/4).** `tumwater reclaim [--dry-run]`.
- In a running fleet it drops a marker file that the orchestrator consumes, like `wake` and
  `restart`, so in-use worktrees are respected.
- With no fleet running, it reclaims directly, since nothing is in use.
- `--dry-run` lists each candidate with its idle age and the number of paths
  `git clean -ndX` would remove.

### Surfaces (part 4/4)

- The status/TUI/GUI header shows a disk badge while the fleet holds, or while free space is
  below `diskReclaimGB`. It reads, for example, "disk 8.2 GB free — holding new work". It
  follows `budgetBadge`/`quietBadge` in src/ui/badges.ts plus a `fleet-alerts.ts` alert.
- A held loop's phase reads "disk hold", like "budget paused" in src/ui/status-model.ts.
- The orchestrator publishes `{ freeGB, held, lastReclaim }` in `OrchestratorInfo`
  (src/fleet/fleet-state.ts), so the separate status, TUI and GUI processes read it without
  calling statfs themselves.

## Phases

1. **Disk floor 1/4: hold new work when free space runs low.** Sampler, `diskHoldGB`, hold
   wiring, `disk_low`/`disk_ok`, notify, doctor.
2. **Disk floor 2/4: reclaim build outputs under pressure.** Use registry, pressure reclaim,
   `diskReclaimGB`, `disk_reclaim`, the hold waiting for reclaim, doctor's warn band.
3. **Disk floor 3/4: idle reclaim and `tumwater reclaim`.** `worktreeIdleReclaimHours`, the
   manual command and its `--dry-run`.
4. **Disk floor 4/4: show disk state on status, TUI and GUI.**

Each part lands and runs on its own. Part 1/4 alone already turns "disk full" into "fleet
paused with a notification".

## Out of scope

- **Watching volumes other than the worktrees volume.** That includes `~/.cargo`, Bazel output
  bases and package-manager caches.
- **Killing in-flight work under pressure.**
- **Per-ecosystem cleanups** such as `cargo sweep` or `cargo clean gc`. A project that wants
  one can run it from its own check command.
- **Removing `pruneStaleBuildDir`.** Idle reclaim subsumes its disk role, but it may also be
  keeping stale `dist/test` files out of this repo's own suite. Retire it in a separate change
  once that is checked.
