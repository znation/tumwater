# tumwater 0.4.6

## Highlights

- **Withdrawn work stays withdrawn.** When the operator deletes a claimed backlog entry, its
  run's pending resume or revision is dropped, a queued change whose entry left main settles
  `withdrawn` instead of merging, and leftover commits or pins are set aside under
  `refs/tumwater/withdrawn/<role>/<sha>` rather than recovered into a merge.
- **A post-merge reviewer's repair lands when it approves**, not only when it rejects — about
  one approval in seven carried a FIX line whose edit used to be wiped by the next review.
- **Prompts ask where a test's expected value comes from.** Review check 3 asks whether the
  tests would fail if the change were wrong, the coverage role takes expected values from what
  the code promises, and plans state acceptance criteria as observable outcomes.
- **ci's inbox holds at most one heal prompt.** A long red main no longer queues a prompt per
  red commit, and a green main drops every waiting heal prompt it has already passed.
- **Cheaper polling.** The quarantine release reads BUGS.md through a stat cache and takes its
  lock only when it releases, and live claims are cached on the state directory's stat.

## Fixes

- Concurrent `tumwater quarantine --release` and the main watch no longer drop each other's
  quarantine.json updates; writes are locked across processes.
- An abort cleanup that hits an fs error no longer throws out of the poll and kills the
  orchestrator.
- `config set` and the dashboard's daily spend cap row refuse exponent spellings (`1e2`) for
  dollar and duration keys instead of silently writing 100.
- A reviewer's `FIX:` line is no longer read as its reason, so fix commits and review events
  name the actual finding; reviewer replies' code fences follow CommonMark's rules.
- A sha-less operator_revert, main_check or main_culprit event renders `?`, not a blank.

## CLI

- `tumwater quarantine -f/--follow` repaints live, like `queue -f`.
- `--branch` refuses a flag-looking `--` value, naming the token.
- `prompt --top 1`'s "already first" refusal names the queue's role.

## Build and tests

- DEVELOPMENT.md has a Writing tests section.
- Internals: long functions split into named helpers (runOrchestrator, resolveRoleConfig,
  mergeEventMessage, Redeployer.status and more), repeated code folded into shared helpers,
  and run-detail, observer and self-check modules moved to their own directories.

170 files changed, +3,608 / −758 over 79 commits since v0.4.5.
