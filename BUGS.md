# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A post-merge review that ends on a transient provider failure is retried every poll, with no backoff and no limit (reported by the user 2026-11-16)

Since 4120526fe (2026-11-11) a post-merge review that ends on a transient provider failure (a 429,
a quota wall, a backend failure) settles as `infrastructure`: `settlePostReviewOutcome`
(src/merge/merge-post-review-drain.ts) keeps the entry queued, not counted toward
`POST_REVIEW_FAILURE_LIMIT` and not filed. That stopped the fake "never reached a verdict"
BUGS.md entries, but it also removed the only brake on the loop. `drainPostReviews` picks
`pending.find(unreviewed)`, the infrastructure arm leaves that entry unchanged, so the next drain
(the next poll, about 2 s later) reviews the same commit again. No backoff, retry-after or attempt
counter applies. The team failure hold cannot trip either: review runs never stamp the author's
`lastRateLimit`/`lastBackendFailure` (see the post-merge usage-fold bug below), and even once they
do, every retry is the same commit and so the same author role, while the hold needs two distinct
roles within 2 minutes (`HOLD_STORM_ROLES = 2`, src/team/team-hold.ts). Every retry also opens a
new agent session, which is what fills the session ledgers that the retention prune later spends
an hour deleting (PLANS.md "Visible session cleanup").

**Reproduce.** Found by reading the code at 952092e; the pre-4120526fe form was observed in
kde-macos8.6-theme's `log/events.jsonl`: on 2026-11-08 2,004 `review_start` against 190
`review_verdict` (1,212 starts in the 23:00 hour), on 2026-11-11 2,238 against 351. In a test,
stub the review seam to end every run on `transientRateLimit` and drive several drains: the same
commit is reviewed on each drain with no delay.

**Suspected cause.** The infrastructure arm keeps the entry exactly as it was. Fix: on that arm
record `lastTransientAt` and a growing `notBefore` on the entry (the run's retry-after when
present, otherwise exponential backoff capped at about 30 min), and have the drain's
`unreviewed`/`find` skip entries still inside `notBefore`, so other commits are still reviewed.
Separately, consider letting a quota wall on the review seam hold reviews (`reviewHeldNow`)
without needing two roles: a quota wall is account-wide, unlike a 429 burst.

### A post-merge review's final run is never folded into the author's usage or failure stamps (reported by the user 2026-11-16)

`startPostReview` (src/merge/merge-post-review-drain.ts) passes `(opts) => author.runGatePi(opts)`
to `reviewMergedCommit`. `runGatePi` (src/runner/runner-pi.ts) folds only a retried first attempt
and leaves the final run to the caller; the pre-merge gate does that fold through
`mergeUsage(author, root).foldUsage` (src/merge/merge-slot.ts), which calls
`author.foldMergeUsage(run, reviewProvider, reviewPair)`. Nothing in src/review/post-merge-review.ts
or merge-post-review-drain.ts folds it. So for every post-merge review: its cost and tokens never
reach the authoring role's counters, so `maxDailyCostUsd` and the report undercount review spend;
and its `lastRateLimit`/`lastBackendFailure` stamps are never written, so a quota wall or 429 on
the reviewer never feeds the team failure hold (`holdObservations`, src/team/team-polls.ts), and
nothing holds reviews off a provider that keeps refusing them.

**Reproduce.** Found by reading the code at 952092e, not reproduced. A test: run one post-merge
review whose stubbed final run ends on `transientRateLimit` with a known cost; the author's
`lastRateLimit` is unset and its daily cost unchanged.

**Suspected cause.** The post-review path never got the fold the pre-merge gate has. Fix: build
`mergeUsage(author, root)` in the post-review path (or call `author.foldMergeUsage` directly) on
the final run, with the review seam's provider and pair, exactly once. Pin it with the test above
asserting `lastRateLimit` carries the review seam's provider, and that the cost is counted once.

### Codex runs default to the operator's own `~/.codex`, filling it with team sessions (reported by the user 2026-11-16)

`codexHome` (src/agent/codex/codex-catalog.ts) falls back to `~/.codex` when the Codex backend has
no `configDir`. kde-macos8.6-theme's `tumwater.json` has `"backends": {}`, so every tumwater Codex
session (7,466 distinct ids from 2026-11-08 to 11-12) went into the operator's personal Codex
home: `~/.codex` is 2.9 GB, `~/.codex/sessions` 701 MB, `state_5.sqlite` 557 MB, and the
operator's own history is buried under thousands of `tumwater-review-*` threads. Each real
`codex delete --force` took about 1 s during the 2026-11-16 prune (about 53 a minute; a delete of
an unknown UUID returns in 0.19 s); the shared, bloated state DB is the likely reason, not a
measured one. The Codex half of `RetentionPruner.prune` (src/orchestrator/retention.ts) also says
CODEX_HOME is set "so the inherited CODEX_HOME never reaches the purge (its rollout fallback would
otherwise unlink the operator's own home)" — with the default config the resolved team home *is*
the operator's home. The fallback unlinks only rollouts the ledger recorded, so it is safe in
practice, but the comment's guarantee is not real.

**Reproduce.** Observed. Any team with Codex enabled and no `backends.codex.configDir`: run one
Codex role and its rollout appears under `~/.codex/sessions/`.

**Suspected cause.** The default was chosen so a known home always exists. Fix: default the Codex
home to a per-team directory (e.g. `.tumwater/codex-home/`, seeded with `auth.json`/`config.toml`
the way the codex-account seed and the isolated OpenCode DB work), and use `~/.codex` only when
the config asks for it. Add a `tumwater doctor` row that warns about an unisolated Codex home, and
fix the retention comment either way.

### 1,451 commits dropped from post-merge review on 2026-11-09 and 11-11 stay unreviewed, and nothing can re-queue them (reported by the user 2026-11-16)

Before 4120526fe the review provider's quota wall made each commit's post-merge review fail three
times and get dropped ("dropping the post-merge review of … after 3 failed runs; it stays on main
unreviewed"): 821 drops on 2026-11-09 and 630 on 2026-11-11 in kde-macos8.6-theme. Those commits
are on main and were never reviewed. `state/post-review.json` holds 395 entries, none unreviewed,
so they are not queued anywhere, and no command or role re-queues a review dropped because of a
provider failure.

**Reproduce.** Observed: count the `dropping the post-merge review` warnings in that project's
`log/events.jsonl` for those days and compare against `state/post-review.json`. BUGS-FIXED.md
mentions "never reached a verdict" 240 times; check whether the per-commit entries 4120526fe's
message describes (821 in 20 min) were cleaned up or only moved to BUGS-FIXED.md.

**Suspected cause.** A drop is terminal, and its only record is a warning. Fix: emit an explicit
`review_dropped` event (commit, role, reason) on every drop, and add a way to re-queue them, e.g.
`tumwater review --requeue-dropped [--since <date>]`, reading the events (and the old warnings for
history). Run it once for 2026-11-09 to 11-11 when the review provider has quota. Decide whether
the matching BUGS-FIXED.md entries should be deleted rather than kept as "fixed".

### Five root-walk tests fail on a shared host once a stale `.tumwater` dir sits at the system temp root (found by the bugfix role 2026-11-16)

Found while verifying a fix: a full `npm test` reded on exactly five tests, all in the `.tumwater`-root-walk family — `findTeamRoot` / `nearestTumwaterRoot` / `writeFullOutput` (test/check-slots.test.ts, test/paths.test.ts, test/full-output.test.ts) — and they pass in isolation on a clean host. The five are `findTeamRoot finds the ancestor holding .tumwater/state`, `writeFullOutput returns null when no ancestor has .tumwater/`, `findTumwaterRoot walks up to the harness root`, and the two `nearestTumwaterRoot` cases.

**Reproduce.** `npm test` on a host whose `os.tmpdir()` is a directory that already holds a `.tumwater` dir with a `state` subdirectory. On this shared host the system temp root is `/tmp` and a leaked `/tmp/.tumwater/state` (from an earlier run) sat there, so the tests walked up from their per-test temp dir into `/tmp/.tumwater/state` and returned `/tmp` (or the wrong root) instead of `null`, failing the assertion "a dir with no `.tumwater`/`state` ancestor has no team root." The same tests pass in isolation on a host whose `os.tmpdir()` is a clean per-user dir, and the suite's `--affected` gate is green.

**Suspected cause.** The root-walk tests create per-test dirs under `os.tmpdir()` (the `tmpdir()` fixture, test/fixtures/repo-fixtures.ts) and assert "no ancestor has `.tumwater`/`state`", but they have no quiet-host skip and no guard against a `.tumwater` dir at the temp root. On a shared host that already holds a stale `.tumwater` (leaked by an earlier run — the same `$TMPDIR/.tumwater` poisoning recorded in BUGS-FIXED, the `runAgent` notes-shim fallback), those assertions fail. A full suite that runs with the system temp root as `os.tmpdir()` can also write its own `.tumwater` there (it creates `<tmp>/.tumwater/{bin,log}`), so the poison is self-perpetuating run-to-run on such a host.

### `tumwater plan --file` silently drops a series part's `requires … landed` clause, so the part is handed out before its prerequisite lands (reported by the user 2026-11-16)

A series part filed through `tumwater plan --file` (or `tumwater plan "<title>"`, or the dashboard's file endpoint) loses its dependency. `appendOperatorEntry` (src/backlog/backlog-write.ts) writes the heading as `### <title> (<stamp>)`, so the operator stamp `(reported by the user <date>)` becomes the heading's last parenthetical. `requiresClause` (src/backlog/backlog-parts.ts) reads the `requires … landed` clause only from the trailing parenthetical (or an open one), so a title like `S, part 2/2: B (requires S part 1/2 landed)` parses to no prerequisites once stamped. The claim allocator then treats part 2/2 as ready and a feature run can claim it while part 1/2 is still planned or in flight. Nothing warns: `planDependencyProblems`'s `unparsed` list only catches a clause that is found but parses to nothing, and its `misworded` scan looks for other dependency verbs, not a `requires` clause in an earlier parenthetical.

This matters more now that the intended use is an operator's own agent filing plans (PLANS.md "Operator steering" series): an agent filing a series the documented way gets it silently unordered. The 2026-11-16 Operator steering series had to be written into PLANS.md by hand and landed under the merge lock for this reason.

**Reproduce.** On the built tree: `requiredParts("S, part 2/2: B (requires S part 1/2 landed)")` returns `[{series: "S", part: "1", of: 2}]`, and `requiredParts("S, part 2/2: B (requires S part 1/2 landed) (reported by the user 2026-11-16)")` returns `[]`. End to end: in a fixture repo, `tumwater plan --file` a part 1/2 and then a part 2/2 whose title ends in `(requires S part 1/2 landed)`; `tumwater plan --list` shows part 2/2 as ready instead of `[blocked: …]`.

**Suspected cause.** The filing path and the dependency parser disagree on where heading metadata lives. Either fix is plausible; pick the one that keeps every other heading reader (`stripEntryStamp`, `entryDates`, `entryKey`, the retired-stamp readers) consistent: (a) when the filed title already ends in a parenthetical, fold the operator stamp into it as `(…; reported by the user <date>)` instead of appending a second group; or (b) have `requiresClause` look at every top-level parenthetical in the heading, not only the last. Also consider having `planDependencyProblems` report a `requires … landed` clause that sits outside the parenthetical it reads, so a hand-written heading with the same shape is caught.

### `a corrupted cache entry is ignored and re-looked-up` failed, then passed on the same tree (quarantined by tumwater 2026-11-17)

The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves `## Open`. Find why it is unstable and fix it.

~~~~
a corrupted cache entry is ignored and re-looked-up
~~~~

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
