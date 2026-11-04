# tumwater 0.4.7

## Highlights

- **A twice-failed gate check is decided at main's tip right away.** The named failing tests re-run
  alone there, and a failure that names no test (compile, lint, crash) runs the gate command
  there. A green tip rejects the change and a red tip sends it on to review. Nothing waits on the
  main watch any more, and no pin is kept until the watch gets there.
- **Bugfix waits end on their own.** A bug that bugfix could not reproduce is now marked
  `[blocked: waiting for a recurrence]` instead of `needs review`. When the quarantine sees its
  test flake, the occurrence and its output go into the entry and bugfix takes the bug again.
  Seven quiet days close it to BUGS-FIXED.md. The five bugs that had sat 8–18 days behind such
  notes are closed.
- **The claude backend's default tier is now Haiku 5.5.** Strong stays Opus 5.5, and explicit
  `model` settings are unaffected.
- **More live views.** `reviews`, both `questions` list forms and `prompt --list` gain
  `-f/--follow`.

## Fixes

- A merge-queue entry whose file cannot be removed no longer throws out of the poll and ends the
  team's run. drainVerify's dedupe drop is now guarded like its sibling settle paths.
- `init --adopt` in an empty directory no longer claims to adopt a README.md that doesn't exist.
- pi's fallback-clone warning names the unresolved model id, so it says which id needs a
  models.json entry.
- A Needs-review or Refused note wrapped across lines now lifts whole. `bug --release` used to
  leave its continuation lines behind.
- Doctor's `held bugs` counts waits separately and says how they clear. `stale bugs` and
  `stalled entries` no longer say no bug is held while every bug is.
- A GitHub release attaches only its own tarball. 0.4.6 also carried a stray 0.4.5 tarball, and
  `*.tgz` is now ignored.

## CLI

- `reviews -f`, `questions -f` and `prompt --list -f` repaint until Ctrl+C or their parent exits.
- `init --template` refuses a flag-looking value and names the slip.
- An out-of-range `prompt --cancel/--edit/--top <n>` names the role whose inbox it addressed.

## Build and tests

- Full-run baseline verdicts record `checkedAt`, persisted across restarts (groundwork for the
  hourly full check).
- "About now" test assertions use an injected clock instead of fixed tolerances.
- PRINCIPLES.md gains a Budgets section.
- Internals: about 20 long functions split into named helpers (runAgent, prepareOrchestratorRun,
  launchDueRuns, pollBudgetGate, gateBuildPrecheck, buildSchedulingScope and more). Repeated code
  is folded into shared helpers, merge-verify helpers and the bug/plan CLI shells have their own
  modules, and dead exports are removed.

147 files changed, +5,978 / −3,148 over 89 commits since v0.4.6.
