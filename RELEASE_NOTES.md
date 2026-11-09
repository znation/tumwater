# tumwater 0.6.0

## Highlights

- **Bug retirement, everywhere plans retire.** `tumwater bug --retire <n> [--reason]` closes a
  bug that will never be built, retiring it into `## Fixed` in BUGS.md. The same works from the
  TUI Backlog pane and the dashboard drawer, with the same two-press confirm plan retirement
  uses (`Ctrl+Y` for plans; `/api/backlog-retire` on the dashboard).
- **Salvage is now a first-class command.** `tumwater salvage` lists the kept patches a failed
  run left behind (`--show`/`--json` for detail), `salvage -f/--follow` repaints the kept-patch
  list live, and `salvage --drop <n>` deletes a listed kept patch. Kept patches stay whole —
  the saved diff is no longer trimmed by trailing-whitespace handling.
- **Red spells heal by bisecting.** When main goes red, the bisect walks merged batches, re-runs
  only the still-failing tests for each candidate, and names the commit that broke the suite —
  not just main's tip. Status surfaces show the main-check verdict's age, next due time and
  cleared-red state.
- **Filtering everywhere.** `--grep` filters on `reviews`, `quarantine`, and `plan|bug --list`,
  and `--show <n>` opens a read-only full entry for reviews, quarantine and prompts. Flag-shaped
  patterns (`--grep --show`) are treated as literal text instead of being misrouted as flags.
- **Held backlog views.** `--held` is the inverse of `--ready` on `tumwater backlog`, `plan
  --list` and `bug --list`; the TUI's Ctrl+O cycle gains a held-only stop, and the dashboard
  Backlog card gets a Held-only toggle.

## Fixes

- The merge gate fails closed when an abort fires, even over a green pre-check. A green
  pre-check that raced an abort no longer lets an unverified merge land.
- A merge that lands while the user is aborting settles as changed, so it is not re-leased
  to the next run.
- A post-merge reviewer fix that conflicts with main re-reviews the resolved tree instead of
  landing blind.
- Free primary with no fallback no longer pauses the budget gate at the cap.
- A semaphore age bound promotes a starved tier-1 waiter instead of parking it indefinitely.
- Policy scans name each offender as its own failing test, and the check, baseline and watch
  capture the offender list; a stale-base aggregate no longer hides a fresh violation.
- The doctor's provider-contention row surfaces live semaphore slot waits.
- The remote CI doctor row is omitted when the ci role is disabled.
- CLI pipes: a run whose stdout/stderr pipe reader closes exits quietly instead of
  retrying with EPIPE noise.

## CLI

- `bug --retire <n> [--reason]` retires a bug into `## Fixed`.
- `salvage`, `salvage --show <n>`, `--json`, `--drop <n>`, `-f/--follow`.
- `reviews --grep <text>` and `reviews --show <n>`; `quarantine --grep <text>` and
  `quarantine --show <n>`.
- `plan --list --grep` / `bug --list --grep` filter literally; `--grep --show` filters for the
  literal `--show` text.
- `prompt --list --grep` treats a flag-shaped pattern as literal text.
- `backlog`, `plan --list` and `bug --list` gain `--held` (the inverse of `--ready`).
- `wake --cancel <n>` drops one scheduled wake, numbered as in `wake --list`.
- `config --diff` prints only the non-default resolved settings.

## Build and tests

- Internals: more than 20 large functions split into named module-private stage helpers,
  duplicated GUI role-field readers and the rev-list tokenizer folded into shared helpers,
  pipeline tests rewritten to observe durable queue/check/event signals, direct unit tests
  added for merge-questions, history-queued, agent-stream and inbox edge branches, and the
  removed `approved in-flight` status is gone from status, GUI and queue surfaces.
- Each agent run gets its own global git config, so runs cannot leak config into each other.

311 files changed, +16,132 / −6,548 over 280 commits since v0.5.0.
