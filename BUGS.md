# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A fresh project's `run --once` reports every bootstrap-held role as skipped `"paused"` — a reason no other command agrees with, and one the operator cannot lift (found by the qa role 2026-11-21)

- **Symptom:** on a project just created by `tumwater init` (which seeds `bootstrap.untilPlansDone: true`, INV-Q6), a one-shot round reports its bootstrap-held roles as skipped with reason `paused` — `"reason": "paused"` ×18 in `--json`, the same bare word repeated in the prose summary — while nothing is paused: `doctor pause` prints `ok pause not paused`, `resume --role <r>` answers `"status": "not_paused"`, `status --json` reports `pausedRoles: []`, and no `paused.json` or `paused-roles.json` exists under `.tumwater/`. The same payload names the real hold separately — a top-level `bootstrapHeld` array (`readme`, `organize`, `coverage`, `clean`, `dedupe`, `perf`, `qa`, `ci`, `security`, `robustness`, `improve`, `steward`, `bugfix`, `bugfix-2`, `bugfix-3`) beside a `bootstrap` progress object — so the `--once` report is the surface that drops the distinction. Following the reported reason sends the operator to `tumwater resume`, which is a no-op on a role that was never paused.
- **Reproduce:** deterministic, offline, no model. Build `dist` (`npm run build`), then in a scratch repo:
  ```sh
  mktemp -d; cd <dir>; git init -b main
  node <wt>/dist/src/cli.js init "Build a tiny markdown-to-html converter CLI in Python."
  # any pi will do; the shim prints an assistant message_end with TUMWATER_NOTHING_TO_DO
  TUMWATER_PI_BIN=<shim> node <wt>/dist/src/cli.js run --once --role readme --json
  ```
  Expected: the `readme` role runs, or is reported held by bootstrap. Actual: `{"runs":0,"skipped":[{"role":"readme","reason":"paused"}],"failures":[]}`, exit 0. The same fresh repo then shows `doctor pause` → `ok pause not paused` and `resume --role readme` → `"status": "not_paused"`; an un-paused role that `resume` reports as not paused still cannot be admitted by that reason. Two commands settle it honestly while the round still says `paused`: `config unset bootstrap` makes the identical `--once --role readme` command report `runs: 1`, and `wake --role readme` (bootstrap still active, header still reads `bootstrap: 0/5 plans done`) also makes it report `runs: 1` — so the hold is bootstrap, not a pause, and `wake` is the lever the report never names.
  The prose form of a round on this repo ends `once: 1 run — 1 no_change, 25 skipped (no free entry, no free entry, …, paused, paused, …, backoff)` — one bare reason word per skip, bootstrap holds indistinguishable from pauses.
- **Suspected cause:** `settleOncePaused` in `src/scheduling/skip.ts` settles four different holds with the one `paused` reason — a role's own cost cap (`capPaused`), the maintenance quota over-line, `bootstrapHeldNow`, and an operator pause (`operatorPauseBlocks`). Only the last is a pause and only the last is liftable by `resume`; the other three read as `paused` and are lifted by something else entirely. The status side already keeps them apart (`status-data.ts` carries `capPaused`, `maintenanceQuota`, `bootstrapHeld` and the pause set as separate fields, and `status-model.ts` renders a held role as `waiting: bootstrap`), as does the event feed's bootstrap hold message — so only the `--once` report flattens them.
- **Expected / fix sketch:** name the hold in the skip record the way the status payload names it — `"reason": "held: bootstrap"`, `"held: maintenance quota 3/2"`, `"budget paused"` — keeping plain `paused` for what `resume` actually answers. A `--json` consumer branching on `reason === "paused"` gets the wrong branch for every held role on a fresh project, so pin the labels in the `--once` skip test alongside the existing `no free entry` / `backoff` reasons (BUGS-FIXED.md's 2026-10-12 "Idle loops say why they are idle" entry asked for the same distinction on the dashboard side and landed it there).

### The false-fix check reads a whole Fixed entry as its Fix paragraph when the label is not exactly `**Fix:**`, so a quoted hex value in the Symptom reads as a missing commit (found by an operator session 2026-11-21)

**Symptom.** At 2026-11-21 14:46:02 the main watch warned: `main's tip 879ff4d3 fails the diff rules: md-only BUGS.md edit moves "The budget-fallback e2e … reds a full e2e step once …" to Fixed, but its Fix paragraph names code that exists nowhere on this tree: ed710f21`. `ed710f21` is not a commit or a symbol. It is a lock-file md5 that the entry's **Symptom** paragraph quotes ("against main tip `fa69a208` (lock md5 `ed710f21`)"). The entry's Fix paragraph names neither value. The warning is a false positive, and the doctor's `main diff rules` row then shows a standing warn on a healthy main for a day.

**Reproduce.** Take the entry from `git show 879ff4d37:BUGS-FIXED.md` (the `### The budget-fallback e2e` heading near the top) and pass its body to `fixSymbols` (src/verdict/fix-claim.ts). It returns 18 names, three of them hex: `fa69a208`, `ed710f21` and `d6d3def9`. `withoutKnownCommits` backs only the hex values that name a real commit, so `ed710f21` stays missing.

**Cause.** `fixSymbols` narrows to the Fix paragraph only when a paragraph contains the exact string `**Fix:**`. Otherwise it scans the whole body. This entry labels its fix `**Fix (bugfix 2026-11-21).**`, and BUGS-FIXED.md holds 27 entries labelled `**Fix.**`. On those entries every backticked span in the Symptom, Reproduce and Validation-gap paragraphs faces the existence check. `COMMIT_REF_RE` (7–40 lowercase hex characters) then treats any hex value as a commit claim: an md5, a hash prefix, or an id from an outside system.

**Fix direction.** Recognize every Fix-label shape the team writes (`**Fix:**`, `**Fix.**`, `**Fix (…).**`, and `**Fixed.**`). An entry with no recognizable Fix paragraph should not fall back to scanning its Symptom and Reproduce text. A hex span that is not a commit should not count as a missing name, or should count only when it sits in the Fix paragraph. Pin the 879ff4d37 entry as a regression case: the watch must not flag it.

### A restart waits its full hand-off window on a post-merge review, then aborts it, and the review starts over in a fresh session (found by an operator session 2026-11-21)

**Symptom.** At 2026-11-21 17:39:20 the `restart` event fired, followed by `restart waiting on the merge in progress for feature-4 (deadline 360s)`. That "merge" was feature-4's post-merge review of `2c4b1ddb`, which had started at 17:01:37 (`review_start`, `afterMerge: true`) and was 38 minutes in. At 17:45:20 the feed read `restart: the merge for feature-4 outlived its 360s deadline — aborted`. The new orchestrator then began the same review from scratch at 17:45:23 and reached its verdict at 18:55:22. Two costs follow:
- Every such restart is delayed by the full 360 s for a review that cannot finish in that time on the local model.
- About 44 minutes of review work were thrown away.

The same 360 s wait-then-abort followed the restarts at 11-18 02:17, 11-19 21:00, 11-20 01:09 and 11-20 05:23. Those warnings named no role, a defect since fixed in BUGS-FIXED.md "A shutdown or restart that waits on a post-merge review names no role". The wait and the lost work are not fixed.

**Reproduce.** `ls .tumwater/sessions/_review/feature-4/post-2c4b1ddb/` shows two session files: `2026-11-22T01-01-37-695Z_…` and `2026-11-22T01-45-23-596Z_…`. The second is a new session, not a continuation. In `.tumwater/log/events.jsonl`, pair each `restart` event with the `restart waiting on the merge in progress` and `outlived its 360s deadline` warnings and the next `review_start` for the same head.

**Cause.** `drainInFlightWork` (src/run/run-timing.ts) puts post-merge review tasks in the same in-flight merge set as gate-then-merge tasks. `awaitMergeForHandoff` gives that set one bounded window, then aborts it. On abort, `settlePostReviewOutcome` (src/merge/merge-post-review-drain.ts, `if (aborted) return;`) keeps the entry but never sets `resume`. Only a run that timed out while making progress sets `resume`. So the next generation's `reviewMergedCommit` opens a new session.

**Fix direction.** An aborted post-merge review should keep its session for the next generation: set `resume` on the abort path as the progressing-timeout path does. A review that cannot finish soon should also not hold the hand-off. Abort a post-merge review at once at a restart, keeping its session, since it lands nothing until its verdict; keep the 360 s window for tasks that are actually merging.

### A reviewer's post-merge fix withheld on a lint failure settles the reviewed commit as rejected for good, and the reviewer's finding is lost (found by an operator session 2026-11-21)

**Symptom.** On 2026-11-21 the post-merge fix was withheld four times, at 11:54 (`0acfd4ee`), 12:36 (`e21b30a3`), 16:46 (`e63b9c49`) and 21:06 (`03f27a3a`). Every one failed only `every comment line in src/ and test/ fits in 100 columns`: the reviewer's fix commit carried an overlong comment line. In each case the `post-review.json` entry for the reviewed commit was settled with `rejected` set to the comment-width assertion's stack trace, and nothing else. The reviewer's actual objection appears nowhere. On `03f27a3a` the verdict found an inline comment saying `review_dropped` is "not yet" written. The entry was settled rejected, and that stale comment is still on main (src/review/post-merge-review-requeue.ts:40).

**Reproduce.** In `.tumwater/log/events.jsonl`, each `the post-merge fix of <sha> failed its pre-check and was withheld` warning follows a `review_verdict` (`afterMerge: true`) for the same head. Then read `.tumwater/state/post-review.json` for `03f27a3a…` or `e63b9c49…`: `rejected` holds only the comment-width lines. The withheld fix commit stays pinned at the review-fix ref.

**Cause.** The fix pre-check's reject callback in `mergeReviewerFix` (src/merge/merge-post-review-drain.ts) calls `settlePostReview(…, { ...entry, rejected: reasons })` with the pre-check's reasons. A `rejected` entry is terminal: the drain's eligibility filter skips any entry with `rejected` or `fixed`. So a fix that a mechanical rewrap would repair is never retried or repaired. The commit it reviewed keeps the defect the reviewer found. `recordReview(state, "reject", reasons, fix)` also hands the author role a rejection that names only the lint failure, on a commit the author can no longer revise.

**Fix direction.** A withheld fix should not end the review. Either hand the failing fix back to the reviewer for a repair turn naming the pre-check failure, or re-queue the entry with the reviewer's finding. In both cases the reviewer's verdict reason must reach whoever acts next. Record a mechanical pre-check failure separately from the review's finding, so `tumwater reviews` and the author's prompt show what the reviewer actually objected to.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
