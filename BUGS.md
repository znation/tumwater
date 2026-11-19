# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

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

### The budget-fallback e2e `a free fallback whose runs keep failing is demoted to a pause` still flakes on a shared host just under the quiet gate's bar — the 2026-11-14 single-sample recheck admits a host at 5-min load 17.6/18, which re-saturates during its 150 s spawn wait (found by the ci role 2026-11-17)

The live-orchestrator e2e file `test/orchestrator-budget.e2e.test.ts` failed the CI
workflow's full e2e step against main tip 6ab53d1 (lock 3811de5): `a reached cap
switches roles to the free fallback model instead of stopping them` timed out at
**150409 ms** (`timed out waiting for a role run after the cap was reached`); the other
86 e2e tests passed. It is a load-sensitive flake, not a regression: that same test
passed in 1.2 s when the file was re-run in isolation on a quiet host, and the whole
file then ran **7 pass / 0 fail / 0 skip** (2.9 s) on a quiet host. Only
`src/runner/runner-leftover.ts` and a comment re-wrap moved since my last covered tip
(f85f56e); neither is the budget-fallback path, so no source change caused it.

**Residual the 2026-11-14 fix did not close.** That fix (BUGS-FIXED.md 2026-11-14,
commit 7ec4669e) added a `recheckQuietHost()` re-sample immediately before each 150 s
spawn wait, deferring the test if the 5-minute average is over the core count. The
re-check is a **single sample** using the same inclusive bar (`isQuietHost`:
`load1 <= cpus && (load5 ?? load1) <= cpus`). Re-running the file in isolation while
the host sat at 5-min load 17.63 on 18 cores, `recheckQuietHost` admitted it (17.63 <
18), and the test then starved its 150 s first-fallback-run wait (`timed out waiting
for the first fallback run`) at **150468 ms**. The 5-minute average is a trailing
mean, so a host that has just *peaked* can still read under the bar and re-saturate
within the 150 s window; the one sample cannot see that.

**Required behavior.** A load-sensitive 150 s wall-clock spawn wait must not red the
e2e tier on a shared host sitting just under the quiet gate's bar. The 150 s budget is
a losing arms race on a loaded host (the 2026-11-12/11-14 entries record the ceiling,
not a bound), so the fix is to make the admission decision robust near the bar, not to
raise the bound: either require the re-check sample to be *comfortably* under the bar
(a margin, e.g. `<= cpus - 1` or `load5 <= 0.8*cpus`), or sample a shorter window
(1-min) that tracks a recent spike, or drive the run-start-marker wait on the fake
clock like the watchdog tests. A regression in `test/wait.test.ts` should pin a
near-bar sample (load5 just under the count) as **not** quiet enough to admit. The
at-admission `awaitQuietHost` gate and the existing `recheckQuietHost` are the seams;
no production budget behavior changes.

### A post-merge review that times out "while still making progress" restarts from scratch every attempt and counts toward the drop limit, so a review longer than its budget can never finish (found by an operator session 2026-11-18)

When a post-merge review hits its wall budget while progressing, the warning reads "the post-merge review of <sha> failed (timed out after 7200s while still making progress — session and worktree edits preserved for resume)". Nothing on the post-merge path resumes:
- `reviewMergedCommit` (src/review/post-merge-review.ts) calls `ensureDetachedWorktree`, which hard-resets the post-review worktree to the commit, and resets the review-fix ref to the commit.
- It then starts `runGatePi` without `continueSession`, so pi opens a new session file.
- `settlePostReviewOutcome` (src/merge/merge-post-review-drain.ts) counts the timeout as an ordinary failed run toward `POST_REVIEW_FAILURE_LIMIT` (3). The third timeout drops the commit unreviewed and files a "never reached a verdict" entry.

The pre-merge gate had the same wording bug, fixed on 10-01 (BUGS-FIXED.md, "A timed-out review is reported as 'session and worktree edits preserved for resume'…"). That fix rewrote the message only in src/review/review.ts. The post-merge drain reports `pi.errorMessage` unchanged.

**Seen live.** On 11-17 every failed post-merge review hit the 7200 s cap: f6e2431a, 7734f02f, 54a4a07f, ff1a8d34, 620887d8 and 1fc125aa. That is about 12 slot-hours on the local Qwen. The day had 15 post-merge review starts and 8 verdicts. 54a4a07f's second attempt (`_review/bugfix/post-54a4a07f/2026-11-18T07-48-57-952Z_*.jsonl`) is a new session that re-reads the same files the first one had read. It timed out again at 11-18 01:48:57 PST. ff1a8d34 and 54a4a07f are now at 2 of 3 failures, so one more timeout each drops them unreviewed.

**Reproduce.** `ls .tumwater/sessions/_review/bugfix/post-54a4a07f/` shows two session files, one per attempt. `sessions.jsonl` there records two starts with the same session name. The events log pairs each `review_start` (`afterMerge: true`) with a timeout warning exactly 7200 s later.

**Suspected cause / fix direction.** The post-merge path was built on the gate's fresh-session design and never got either remedy. At minimum, reword the message for this path as review.ts does, keeping the failure-cluster pooling in src/failure/failure-cluster.ts. The fix that ends the waste is to continue the timed-out reviewer's own session on the same commit without resetting the worktree or the fix ref. Alternatively, do not count a progressing timeout toward the drop limit while each attempt keeps making progress. Without one of those, a review that needs more than one budget has no way to finish.

### A model check run while the only local server is saturated fails on queue position, holding every role and handing back runs to "a pair that answers" that does not exist (found by an operator session 2026-11-18)

The team runs every role on one local pair, `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` (Splash 1.6.1, `--max-concurrent 4`). On 11-17 the model check failed four times ("gave no reply (no answer within 300s) — runs on it wait (feature, bugfix, plan, …, +13 more)"), each time holding all 19 runners. The Splash log (`~/qwenrunner/logs/splash.8090.log`) shows that the server was answering, not down:
- At 14:08:57 and 14:20:00 PST the probe's requests (input 1,420 tokens, 0 cached) were `Cancelled` with output 0 and never `Started`. The server was memory-starved ("Memory: growth paused; waiting=1") and kept starting cache-hit follow-ups from the sessions already running, while new uncached requests waited.
- In the same minutes the running sessions' requests finished at 30–48 tok/s.
- dedupe's request (input 50,031, 0 cached) had waited unstarted since about 13:43.

The hand-back cancelled dedupe's run at 14:08:59 (aborted after 2.0 h) and clean's at 14:27:18 (after 1.75 h). Each warning says "the run resumes on a pair that answers", but no other pair is configured. Once clean's request was cancelled, the next probe started at once and answered in 3 s (`model_check_passed` at 14:27:20). So the check measured the probe's place in a saturated server's admission queue, and the hand-back is what made the next probe pass.

**Reproduce.** In the Splash log's 11-17 section (after the 23:59→00:00 rollover near line 600823), filter 14:02–14:28 to `Started|Done|Cancelled`. Compare with `.tumwater/log/events.jsonl` `warning` events at 14:08:57–14:27:20 and the `model_check_passed` event at 14:27:20.

**Suspected cause / fix direction.** The probe (src/model-check/model-check-probe.ts, `MODEL_CHECK_TIMEOUT_S` = 300) competes for the same server slots and memory as the runs it judges. A request that never started is read the same as a model that does not answer. Part of this is Splash's admission behavior under memory pressure, which tumwater cannot fix. On the harness side, options are:
- Don't treat "no answer" as a failed pair while the team's own runs on that pair are getting replies in the same window.
- Or reserve headroom for the probe, for example by lowering the team's concurrency by one while a check is due.
- Either way, the hand-back warning should not promise another pair when the tier has none.

### An accepted checkpoint still leaves the session uncompacted: pi’s fire-and-forget `compact()` never reaches its `compaction_end` (found by the bugfix role 2026-11-19)

The BUGS-FIXED entry "A checkpoint-caused abort is indistinguishable from a context-ceiling cut-off" requires that "an accepted checkpoint must leave the session compacted". It does not. On every observed author run the tool result reads "Checkpoint recorded; the context is being compacted", the next assistant turn ends `stopReason: "aborted"`, and the role’s pi log holds a `compaction_start` with `reason: "manual"` and no matching `compaction_end`; the session file holds no `compaction` entry. So the run loses its turn and gains no summary — the context keeps growing and the role pays an aborted run each time it checkpoints.

**Reproduce.** In a role’s pi log, `grep -c '"compaction_start","reason":"manual"'` counts starts while `grep -c compaction_end` counts none. pi 1.5.2’s `compact()` (its `dist/core/agent-session.js`) awaits `abort()`, emits `compaction_start`, then summarizes, and emits `compaction_end` only on completion or failure — so a process that exits once the aborted turn settles never emits one.

**Suspected cause.** `src/pi-extension/checkpoint.ts` requests the compaction and returns its tool result before pi has run the summarization, and pi ends the run when the aborted turn settles. Settling it means keeping the run alive until `compaction_end` arrives (or writing the compaction entry directly), a design decision that belongs with the plan role, not a parser correction. The sibling fix (this file’s Fixed entry) only stops the harness from claiming a compaction that was never written.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
