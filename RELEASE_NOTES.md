# tumwater 0.9.0

## Highlights

- Feature and bugfix now default to 3 parallel instances, and the plan role keeps 4 eligible
  plans ahead instead of 2. An idle extra instance costs nothing: it is skipped while no
  unclaimed entry is eligible. **Upgrade note:** a team with no `instances` in tumwater.json
  goes from one to three feature and bugfix runners on its first redeploy. Set
  `roles.feature.instances` / `roles.bugfix.instances` to 1 (`tumwater role feature
  --instances 1`, the Settings card or the role drawer) to keep the old behavior. A local-model
  team should check `maxConcurrent` against its server's parallel slots.

- A release install names its npm version everywhere it names the build: the `tumwater status`
  header, the `tumwater start` banner, `doctor`, and the dashboard's Version row (the commit
  stays beside it, and in the tooltip, for bug reports).
- The terminal dashboard is gone, so the browser dashboard is the one place to watch and steer
  the team (see CLI).
- The README, `tumwater init`, `help` and the glossary now say up front that you steer tumwater
  through its backlog, mainly from your own interactive agent (see `tumwater guide`).
- While a maintenance role (clean, coverage, dedupe, improve, …) waits for a permit, work runs
  leave it the next free one (up to a third of the team: 2 permits at the default cap of 6), so
  a busy feature or bugfix tier no longer starves maintenance.

## CLI

- New `tumwater land [<ref>] [--dry-run] [--json]` puts your own hand-made commit(s) on main
  under the team's merge lock: a fast-forward, or a replay onto a main that moved meanwhile.
  `--dry-run` shows the commits, their files and whether they apply, and writes nothing.
- New `tumwater guide` prints the working rules for an interactive agent steering the backlog,
  plus facts about this project (branch, check, team), so the rules need not be copied into
  CLAUDE.md or AGENTS.md.
- The terminal dashboard is removed: `tumwater tui` and `tumwater start --tui` no longer exist.
  Watch and steer the team through the browser dashboard — `tumwater gui`, or
  `tumwater start --gui` to boot the team and serve it together — and through `tumwater status`
  and `tumwater logs -f`.
- The daily session cleanup, which can take over an hour on a host with thousands of expired
  Codex sessions, now logs `cleanup started` / `cleanup finished` events and writes its progress
  to `.tumwater/state/maintenance.json`, so a team busy cleaning up no longer looks hung.

## Fixes

- A pi run that stopped at a checkpoint is no longer misread as cut off at the context ceiling
  (pi announces a compaction before it starts one), which set up a resume into a summary that
  was never written.
- A Codex build whose `--version` probe timed out no longer reuses another build's hook-trust
  verdict from the cache.
- A `requires … landed` clause is read from every parenthetical group of a backlog heading, and
  a stray `)` no longer silently drops it, so a prerequisite hold can't vanish.
- A role recovering after a crash no longer stacks its next commit on its own unmerged change.
- The budgeted gate always runs the temp-dir policy scan, so a change that adds a raw
  `mkdtempSync` under the OS temp dir no longer merges and turns main red.
- Project-root discovery is pinned against a stray `.tumwater` in the OS temp directory.
- The e2e tier defers on a host near its load bar instead of starting and starving.
- The `sessionRetentionDays` setting describes everything the cleanup now removes.
- The dashboard's wake-all and reset-counters actions target the configured roles, as the CLI
  does, rather than listing every instance id.

## Build and tests

- Small cleanups: one home for the team-hold backoff ladder, the run-start→model pairing rule,
  and the default instance count.
- New tests pin the session ledger's kind guard, the merge-claim shape guard, the post-merge
  review backoff, the session-cleanup progress and event wording, and the release-version
  stamp.

267 files changed, +5402 / −26613 over 69 commits since v0.8.2
