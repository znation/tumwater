# tumwater 0.5.0

## Highlights

- **Remote CI: the team now sees GitHub Actions' verdict on what you pushed.** The ci role reads
  the hosted CI result on main's newest pushed commit with your own `gh` (read-only), so a failure
  that only happens on the hosted runner no longer goes unseen. A newly failed push pages you once
  per commit. `tumwater doctor` gains a `remote CI` row, and the status line, TUI header and
  dashboard show a `github: passed|failed|running` badge beside the ci parity badge. It runs only
  when main's remote is on GitHub and the repo has a workflow; `roles.ci.remote: false` turns it off.
- **No more duplicate plans.** The plan role's prompt now shows the plans that unmerged changes
  already carry, and its stop count reads `## Planned` with those changes applied, so it stops
  planning work that is waiting to merge. A new `retired` stamp closes a plan that is never built,
  and the plan role retires extra copies of the same work. When feature finds nothing to build in
  a plan, it hands the plan back to the plan role to fix instead of refusing it.
- **Main's full check runs at most once per `check.fullIntervalMinutes`** (default 60), and only
  while a code commit is newer than the last full verdict. It runs in its own `_main-full` mirror,
  so a long suite no longer blocks the gate's main-tip verdicts. Set 0 to check every head again.
- **Per-model reports.** Day and `--since` reports gain `Tokens by model`, `Cost by model` and
  `Estimated by model` lines, ranked by spend. The failure digest adds a ranked
  `Failed runs by model` line, so a team that mixes providers can see which model is failing or
  costing the most.
- **More live views.** `doctor`, `role <id>`, `plan --list`, `bug --list` (and `--done`),
  `history --summary` and `history <role> <n>` gain `-f/--follow`.

## Fixes

- Post-merge reviews no longer stall until a restart. They now wait for a run permit instead of
  checking once for a free one. On a busy team that check failed and left the review slot stuck,
  so on 2026-11-03 only 2 of 81 merges were reviewed.
- A reviewer's post-merge fix goes through the gate's build check before it lands. On 2026-11-04 a
  broken repair landed unchecked and kept main red for about 20 hours.
- A role whose change is waiting in the merge queue is no longer given the same backlog entry
  again. Before this fix, it built the same work twice.
- A post-merge review no longer rotates a role log that a running run is still writing, which made
  a healthy run look stuck on the dashboard.
- The director no longer starts a run every poll (each one skipped) while a second commit waits
  behind its queued change.
- Merge verification runs one change at a time. The removed `main_red` run result no longer
  appears in status, doctor or the dashboard.
- Main is green again. It had been red since 2026-11-04 on four repo-wide lint scans and 11
  runner tests. The runner tests broke because every role waited on a plan-only git refresh
  before it leased its slot.

## CLI

- `-f/--follow` on `doctor`, `role <id>`, `plan|bug --list`, `history --summary` and
  `history <role> <n>` refreshes the view until Ctrl+C or until its parent process exits.
- `doctor` gains a `remote CI` row. The `check.fullIntervalMinutes` setting is new.

## Build and tests

- Each release now chooses major, minor or patch when it is cut: `scripts/release.mjs <level>`,
  `bump <level>`, and `--status` prints the level (DEVELOPMENT.md "Choosing the version").
- A flaky merge-pipeline test now holds its second change's check, so the check can't finish
  between polls.
- New end-to-end tests cover the gate's re-run attribution when main is red and the failure
  names no test.
- Internals: `buildReviewPrompt` is split into four builders, duplicate merge-queue modules are
  removed, eleven copies of the `--json`/`--follow` refusal now share one helper, dead exports
  are deleted, and the PRINCIPLES.md budgets are refreshed.

210 files changed, +9,743 / −2,324 over 133 commits since v0.4.7.
