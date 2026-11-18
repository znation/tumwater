# tumwater 0.8.2

## Highlights

- The README opens with a four-line Getting Started (install, `init`, `start --gui`, open the
  dashboard) before the screenshot.

## Fixes

- A post-merge review that hits a transient provider failure (429, quota wall) now retries
  with an escalating backoff (60 s doubling to 15 min, longer when the provider says so), not
  a fresh agent session every ~2 s poll.
- Review and merge runs no longer load the checkpoint extension, so an accepted checkpoint
  can no longer abort a review and lose its verdict. The no-change diagnosis now names a
  checkpoint abort instead of misreading it as a context-ceiling cut-off.
- A role whose own change is waiting to merge no longer re-pins it on every poll, which spun
  sub-second no-op runs until the merge settled. A held commit next to that pin is kept,
  not reset away.
- Merges no longer fail `merge_blocked` on `.git/index.lock` when a run's stray-write check
  reads the primary checkout's status at the same moment (`git status --no-optional-locks`).
- Team-root discovery ignores a stale `.tumwater` left at the OS temp directory, which made
  tools on a shared host treat the temp root as a project.
- The dashboard's Usage tab explains its two rejection charts in hover tooltips.
- The backlog drawer's actions say what they do: Delete, Clear refusal and retry, and Close
  without fixing/building, each with a hover title. A refused entry's alert reads as an
  indigo Question rather than an amber warning.

## Build and tests

- Small cleanups: one helper for the merge-conflict streak read, `agent-git-config.ts` drops
  its `run-` prefix, the session ledger's record kind is typed, stale `main-watch.ts` doc
  pointers re-point to the split modules, and the last plain-`tsc` type error is fixed.
- New tests pin edge rules in role classification, backlog section spans, merge-queue and
  check-scope shape guards, the session ledger and the lower-median helper.
- The released-pipe-handle test waits for the handles to close instead of a fixed 500 ms
  sleep. Two in-process temp-root tests that tripped the suite's `tmpdir()` guard were
  removed.

82 files changed, +2820 / −344 over 92 commits since v0.8.1
