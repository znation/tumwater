# tumwater 0.4.5

## Highlights

- **Merging is rebase + fast-forward.** The batch/stack/bisect merge path, the merge
  attribution module and the merge slot's in-lock gate check are deleted; a check whose
  merge was aborted while it waited for a permit is never run, and a settle-path throw no
  longer leaves the merge slot held.
- **A red main stops holding changes back.** `check.rerunCommand` re-runs only the failing
  tests named to it, so the main watch confirms a red and the gate tells main's failures
  from the change's without a second full check. A twice-failed gate is attributed from the
  watch's verdicts, and an ongoing red stays pinned to the tip that opened it.
- **Every model pair is checked before it runs.** A short known-answer probe tests a pair
  before a run starts; a tier whose primary fails its model check moves to the first free
  step that passed, and an unanswered model request re-checks the pair and hands the waiting
  run back.
- **Feature and bugfix can run several instances at once.** `roles.<role>.instances` (1–8,
  feature and bugfix only) has dashboard Settings rows, and the scheduler no longer
  interlocks a role on its own queued merge.
- **The post-merge reviewer's budget scales with the reviewed diff's size** as well as the
  host's load, so a large diff is not killed at the wall for either reason.
- **The six standing amber alerts render on status, the dashboard and the TUI**, and the
  codex/claude subscription usage windows (5h/7d) are displayed again.
- **Cheaper polling.** The per-second status read stat-caches what it used to re-read:
  slots, the in-flight merge marker, the queue listing, runner-state instances, the
  ci-parity ledger, account bodies, role notes, PRINCIPLES.md and build-check detection.

## Fixes

- The orphan scan spares a live run's own backgrounded command tree instead of reaping it
  mid-run.
- `init` no longer claims it is "adopting an existing repo" when it seeds the repo itself.
- A bugfix run that cannot reproduce a bug queues a director prompt before parking.
- An over-cap `director-request` body is fitted to the prompt cap instead of dropped.
- `--branch`/`baseBranch` names are refused with git's own rule at startup, and a
  shape-invalid `baseBranch` is reported as a bad name, not a missing branch.
- A broken symlink can no longer walk the write guard out of the worktree, and opencode's
  `write` action is guarded like `edit`.

## CLI

- Flag-looking values (a bare `--`, or a `-x` token) are refused for count, position,
  duration, port, `--role`, `--file`, `--path`, `--by`, `--reason` and `--attach`, naming
  the offending value.
- The prompt's `--grep` is listed in the help, and completion's path flags are derived from
  the help text.
- The TUI role-model editor suggests a "did you mean" for an unknown key.

## Build and tests

- The build compiles with TypeScript 7's native compiler.
- `npm run test:gate` runs the nearest tests that fit a 20 s budget, counts each suite once,
  and lints only the changed files alongside the run.
- The test-durations ledger lives in the git dir, shared by every worktree.

353 files changed, +17,927 / −9,396 over 295 commits since v0.4.4.
