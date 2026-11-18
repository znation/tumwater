# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

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

### `a corrupted cache entry is ignored and re-looked-up` failed, then passed on the same tree (quarantined by tumwater 2026-11-17)

The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves `## Open`. Find why it is unstable and fix it.

~~~~
a corrupted cache entry is ignored and re-looked-up
~~~~

### The self-scan guard for the tmpdir rule is not in `POLICY_SCANS`, so the budgeted gate passes over it and a change that adds offenders lands main red (found by the selfcheck role 2026-11-17)

`1fc125aa` (bugfix, the `isOsTempRoot` root-walk guard) added two tests — `test/check-slots.test.ts` and `test/full-output.test.ts` — that create their temp dirs with a raw `fs.mkdtempSync(path.join(os.tmpdir(), …))` instead of the `tmpdir()` fixture. The pre-existing self-scan guard in `test/repo-fixtures.test.ts` — the test titled `every test file creates temp dirs through tmpdir(), never a raw mkdtempSync under os.tmpdir()` — reads every `*.test.ts` and fails on any offender, so main has been red on exactly that guard's assertion since the merge; the digest's *Fast merge guardrails* section carried it 462 min after the merge.

**Why the merge gate did not catch it.** The gate runs the affected tests under a 20 s budget (`test:gate` = `…test-runner.js --affected --budget=20`). `fitBudget` (test/affected-tests.ts) *must* always run the repo-wide policy scans — `POLICY_SCANS`, currently `test/comment-width.test.ts`, `test/exports.test.ts`, `test/retired-names.test.ts`, `test/vocabulary.test.ts` — because each reads every file and fails on any offender anywhere, so a change that adds a new offender must fail its own gate. The tmpdir self-scan is a fifth repo-wide policy scan of exactly that shape (it `readdirSync`s every `*.test.ts`), but it is **not** in `POLICY_SCANS`. Unregistered, `selectAffected` ranks it only as an ordinary tree scanner at `SCANNER_DISTANCE` (2) — behind the change's direct importers — and `fitBudget` passes it over under the budget. `1fc125aa` changed only `src/concurrency/check-slots.ts`, `src/paths.ts`, `src/pi-extension/full-output.ts` and the three test files; `test/repo-fixtures.test.ts` is unchanged, so it is in no affected set, the guard never runs in the gate, the gate is green, and main stays red until the ci role's full check heals it forward.

**Reproduce.** On the tree, run `grep -rn 'mkdtempSync(path.join(os.tmpdir()' test/*.test.ts` (returns the four lines above in `check-slots` and `full-output`), then `grep -c 'never a raw mkdtempSync' test/repo-fixtures.test.ts` (1, the guard). The guard fails on a full suite and is absent from `POLICY_SCANS`, so it does not run in `npm run test:gate`; the full check (`npm test`) is the only gate that catches it.

**Suspected cause.** `POLICY_SCANS` was written for the four pre-existing scans and the tmpdir self-scan (added later to `repo-fixtures.test.ts`) was never registered. `fitBudget`'s guarantee is keyed to that explicit set, so an unregistered scan of the same shape is silently skipped. **Fix.** Register `test/repo-fixtures.test.ts` in `POLICY_SCANS` (the set is the one home of "a repo-wide policy scan the budgeted gate must always run"), so a change that adds a raw-`os.tmpdir()` offender fails its own gate; keep the guard test itself and pin the registration in `test/affected-tests.test.ts`. (The two offender lines that 1fc125aa left are a separate, ci-owned known-red — this entry is the gate-selection defect that let them land.)

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
