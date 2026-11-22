# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

_None yet._

### A withheld reviewer fix is logged as a post-merge rejection of the author, so the digest counts a re-reviewing entry as a commit kept rejected and the doctor blames the author for the reviewer's lint line (found by the selfcheck role 2026-11-22)

- **Symptom:** the selfcheck digest's `## Top rejection clusters` keys every withheld-fix rejection
  under the *author's* runner (`bugfix-2 · check failed (npm run test:gate): ✖ every comment line in
  src/ and test/ fits in 100 columns …` — 2× on 11-21) and its footer reads `_8 post-merge
  rejections — the commit already reached main, so it stays there with the reviewer's recorded
  reasons (never re-reviewed — Forward, never back)_`. Both are false for those events: the head in
  the event is the reviewer's own fix commit, and since `d67bc92b` (2026-11-21) the entry behind them
  is **not** kept — it stays open and is re-reviewed. The digest thus reports a failing-but-open
  review as a settled one, hides the reviewer's actual finding from its own rejection line, and
  spends the doctor's `post-merge churn` warn ("author changes that pass the pre-merge check keep
  getting rejected after merge — raise the authoring bar") on lint errors in reviewer-authored
  bytes, pointing at an author who can do nothing about them.
- **Reproduce.** Offline, one fixture. In `test/post-merge-review.test.ts`, take "a reviewer's fix
  that fails its pre-check is withheld from main (BUGS.md 2026-11-04)" and assert the events it
  writes: the `review_rejected` record carries `source: <author role>`, `head: <fix sha>`,
  `afterMerge: true`, and `reasons` holding ONLY the pre-check lines — the reviewer's `finding` is
  absent from the event, while the state entry (`settleWithheldReviewerFix`) keeps `finding` and
  `failures` and no `rejected`. Feed that event shape to `renderFailureMarkdown`
  (src/failure/failure-render.ts), which `test/failure-render.test.ts` already drives from a
  hand-built `FailureReportData` fixture — `postMergeRejections` and the rejection clusters are what
  `collectFailureReport` (src/failure/failure-data.ts) derives from the event log. The rendered
  footer says `1 post-merge rejection … (never re-reviewed — Forward, never back)` and the cluster
  line names the author's role id. Live shape: `log/events.jsonl` on 2026-11-21, each
  `the post-merge fix of <sha> failed its pre-check and was withheld` warning preceded by a
  `review_rejected` for the fix sha (the four cases BUGS-FIXED.md 2026-11-21 names: `0acfd4ee`,
  `e21b30a3`, `e63b9c49`, `03f27a3a`, all comment-width lint) — all four sit inside a digest window
  that then prints the never-re-reviewed footer.
- **Cause.** `precheckReviewerFix`'s reject callback (src/merge/merge-post-review-drain.ts:348-369)
  splits the information three ways and the observers read only one of them: the event
  (`review_rejected`, `head: fix`, `reasons` = the pre-check reasons, `afterMerge: true`,
  `source: entry.role` = the author), the state entry (open, `finding` + `failures`, INV-BT8), and
  the author's rejection record (`recordReview(state, "reject", [...finding, ...reasons], fix)`,
  which DOES carry the finding). Every consumer keys off the event:
  `rejectionSection` (src/failure/failure-data.ts:645-667) counts `afterMerge === true` into
  `postMergeRejections` and clusters each event's `reasons` under `eventRole(ev)` — the event's
  `source`, the author role; `failure-render.ts:382`
  prints the fixed footer asserting the commit is never re-reviewed; the dashboard's per-role
  rejection chart (`postMergeRejectionsByRole`, whose tooltip at `src/ui/gui/gui-client-report.ts:167`
  reads "A reviewer fix held back because it failed the check counts here too") and the doctor
  `post-merge churn` row (`checkPostMergeChurn`, src/doctor/doctor-project-checks.ts:330-343, over
  `POST_MERGE_REJECT_WARN` = 2 in src/review/post-merge-review.ts:107) attribute the same event to
  the author. `d67bc92b` changed the entry's settle but not this event, so the event's meaning
  and the observers' wording went stale under it.
- **Fix direction.** Log the withholding as what it is, not as a rejection verdict on the author's
  commit: a distinct event type (or an `afterMerge` event with a `withheldFix: <sha>`/`reviewEntry`
  discriminator) carrying the reviewed commit as head, the reviewer's `finding` in its reasons, and
  the pre-check failure as a separate field. Then teach the three observers the new shape: the
  digest footer must not claim a withheld-fix review is never re-reviewed (INV-BT8 re-reviews it up
  to `POST_REVIEW_FAILURE_LIMIT`), the cluster line should name the reviewer and the lint line as
  the reviewer's own failure, and the doctor `post-merge churn` count plus
  `postMergeRejectionsByRole` should count landed-fix rejections of an author's commit, not
  reviewer-lint withholdings. Acceptance: a withheld-fix fixture produces a digest that names the
  reviewer's finding and does not print the never-re-reviewed claim for that event; the churn row's
  warn does not fire on withholdings alone.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
