# tumwater 0.11.0

## Highlights

- The dashboard's Settings view now shows the GitHub-issues mirror. A card lists the issues the
  team saw and what it did about each one, with a search box, a state picker and a per-issue
  View that says why an issue was left alone.
- The salvaged-patches card has a search box, like `tumwater salvage --grep`, and a per-patch
  View, so you can read a kept patch before you apply or drop it.
- Kept salvage patches show their prune deadline. The `salvage` list, its `--json`, the
  dashboard card and the `salvage patches` doctor row all say how long a patch has before
  session retention deletes it.
- Issues that GitHub closed upstream, with no merged fix, are now tracked. The mirror records
  them as `lost`, logs a `github_issue_upstream_closed` event, counts them on the doctor row
  and banner, and no longer lets them hold the blue "push main" banner.
- The dashboard page can no longer be framed by another site. It sends
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so a hostile page can't drive the team
  through the untokened loopback dashboard.

## CLI

- `tumwater issues` gains `--open`, `--closed` and `--lost` state filters and `-f/--follow`,
  which repaints the read as scans and closes land.
- `tumwater report` tallies the GitHub-issues mirror by outcome over the report's window.
- The `tumwater status` header and the dashboard's team panel have a `QA:` badge that turns
  amber when flow coverage is older than the three-day stall window.
- New standing alerts: one when a role's lessons store is over its caps (12 lessons / 2048
  bytes), and one when the issues mirror's scan has gone quiet. Doctor's `github issues` row
  reports a quiet scan too.
- A role's run prompt says how full its lessons store is, so the role can curate it before
  `lesson add` refuses.
- `tumwater reviews` and the dashboard's post-merge reviews card name the finding a withheld
  reviewer fix kept, and describe a held review in plain terms.
- More precise error messages: refused counts, duration values and a malformed tumwater.json
  (JSONC) now name the exact problem, and "1 tests/patches/issues" counts are singular.
- docs/cli.md now names the 7-day cap on `logs --since` and `history --since`.

## Fixes

- `tumwater run --gui` no longer runs out of memory on a large Codex home. Codex rollouts are
  read as a bounded tail, not whole (GitHub issue #1).
- Red main: after a restart into a red main, the gate again excuses main's known failures, and
  it reads main's recorded red verdict when its own check skips. Changes that add no new
  failures are no longer rejected (issue #5).
- A reviewer's fix is pre-checked after it is rebased onto main's tip. Before, it was checked
  before the rebase, and a rebase that duplicated an import left main red for 82 minutes.
- A role that skips runs again and again backs off along its idle ladder instead of
  returning at its minimum interval. Its self-requeued inbox now waits for its minimum
  interval instead of the poll (issue #2).
- The director no longer spins a skipped run every 20 s while its own change waits to merge,
  and the drain merges the oldest pin first. A held relief commit beside a role's own pin is
  folded into that pin, so a red main no longer freezes authoring.
- The bugfix-wait auto-close runs the check before it commits its archive (issue #4).
- A director run that ends on a checkpoint abort gives back its issue prompt instead of dropping
  it, and the mirror's hold is shorter.
- Backlog guards: a plan run can no longer re-add an archived plan, a bug that was already
  fixed and archived (even with a reworded heading) is caught when it is filed again, and
  selfcheck dedupes against the archive.
- The mirror's fix-commit search is anchored to a `### ` heading, so a commit that only quotes
  a heading is no longer cited as the fix. Issue counts and `--show` ranges come from the
  ledger, not from the rows a filtered frame kept. A withheld reviewer fix no longer counts as
  a rejection of the author.
- Offline `reset-counters --role <base>` and `wake --role <base>` reach the whole instance
  family. `run --once` names the hold instead of a bare "paused", and a round held by the disk
  floor or a provider failure exits.
- A red check's numbered objections no longer include node:assert dumps, test-runner frames or
  lint plumbing. The false-fix check accepts every Fix-label shape.
- `tumwater init` refuses a brief that contains a prompt marker. `githubIssues.<field>` works as a
  `config set` key, and `GET /api/issues` accepts `state=lost`.

## Build and tests

- Every event type must have a digest classification, and tsc now enforces it.
- A shared merge-settle waiter fixes the recurring live-orchestrator merge-queue flake, along
  with several e2e and clock-dependent flakes.
- Perf: the mirror walks the backlog and fix commits once per pass, stage checks resolve the
  merge-base once, and `readMergePins` no longer probes each pin with `git cat-file`.
- Small cleanups: shared error coercion, CLI position guards, the thinking→effort map, and
  issues-ledger trimming. New tests cover the role-lessons and salvage APIs, the gh runner
  wiring, and the breaker's per-instance pause key.

380 files changed, +18828 / −2713 over 191 commits since v0.10.0
