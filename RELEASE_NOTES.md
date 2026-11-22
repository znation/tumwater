# tumwater 0.10.0

## Highlights

- GitHub issues come into the backlog. On a project with a GitHub remote and a logged-in `gh`,
  tumwater scans open issues hourly. It hands each trusted issue that no backlog entry mirrors
  yet to the director, one at a time. Once every entry that mirrors an issue is finished and
  the fix is on GitHub's base branch, it closes the issue and cites the fix commit.
  **Upgrade note:** the mirror is on by default. It trusts only issues opened by the repo's
  owners, members and collaborators, plus any issue a maintainer labels `tumwater`. Set
  `githubIssues.enabled: false` in tumwater.json to turn it off, or `githubIssues.close: false`
  to keep tumwater from closing issues. `authors`, `mirrorLabel` and `scanIntervalMinutes` are
  in docs/config.md.
- A project with no declared check gets one without your help: the orchestrator asks the
  director to declare one. While that happens, the dashboard shows a blue info message, not an
  amber warning, and the doctor row reads ok.
- tumwater has no runtime dependencies again: ink and react went with the terminal dashboard.
- The Codex strong tier now defaults to `gpt-6.2-sol`, and the minimum Codex CLI is 0.170.0.
  An older CLI fails doctor's `codex version` row rather than being sent a model it can't list.
- Codex runs with no `backends.codex.configDir` keep their sessions in a per-team
  `.tumwater/codex-home`. Before this they filled your own `~/.codex`.

## CLI

- New `tumwater issues [--show <n>] [--grep <text>] [--json]` lists what the GitHub-issues
  mirror last saw and what tumwater did about each issue. It reads the ledger only, so it works
  without `gh`.
- New `tumwater reviews --requeue-dropped` puts post-merge reviews that were dropped back in the
  queue, for commits already on main.
- `tumwater report` adds `Compactions by role` and `Checkpoint compactions by role`, so you can
  see how often each role's context was rewritten and how many of those rewrites your own
  checkpoints drove.
- The dashboard has new warnings: an amber alert when the orchestrator stops polling, a banner
  with progress and an ETA during session cleanup, and a warning when `gh` can't read the
  project's issues.
- The dashboard's 401 response now tells a wrong token (for example, a reopened URL whose token
  has rotated) apart from a missing one.
- A few more config errors suggest the value you probably meant (`githubIssues.authors`,
  tier-map thinking levels, backlog kinds in the GUI).

## Fixes

- Session cleanup no longer blocks every role. Deletes run in the background, four at a time.
  Placeholder and already-gone Codex sessions are skipped, a restarted pass resumes where it
  stopped, and shutdown stops a pass that is still running.
- Host sleep is no longer read as a hang: a run's deadline is extended by the time the host
  slept, and a model-check probe that spans a sleep gets one retry before the pair is failed.
- The model check's verdicts survive an orchestrator restart, so a failed pair keeps the
  back-off it earned and its roles are not held for a fresh probe.
- A post-merge review that timed out while still making progress resumes its session on retry.
  A restart stops in-flight post-merge reviews before handing off. A dropped review now logs
  a `review_dropped` event.
- A reviewer fix that is withheld keeps the review open and keeps its finding.
- A claimed extra instance is admitted ahead of a free sibling, so a higher backlog entry no
  longer waits behind a lower one.
- A full run on main that reaches no verdict leaves the head due for another check after a
  short backoff. Before, main's head went unchecked until main moved again.
- Offline `reset-counters` also zeroes the counters of parallel instances.
- A subscription team whose usage windows haven't arrived yet reads "usage not reported yet",
  not "Free models".
- Stage checks ignore `.scratch/`, and a `.js` path counts as present when its `.ts` source is
  staged.
- A queued prompt move rolls back if the old queue file can't be removed.

## Build and tests

- A staging self-check flags a comment block that a change copied verbatim next to its
  original.
- Small cleanups: shared file-read helpers replace hand-rolled absent-file and readdir reads,
  some modules moved (config reload, run commit messages, build-check poll), GitHub mirror reads
  are cached per branch tip, and terminal-dashboard wording is gone from comments, tests and
  docs.
- New tests pin `tumwater land`'s command body and dry runs, session-prune slot release,
  compaction counting, and per-command flag rejection.

405 files changed, +13280 / −2987 over 194 commits since v0.9.0
