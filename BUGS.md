# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### `a suspended head another check records red is settled without waiting for the interval` fails when a sibling `culpritFixture` test ran in the same second: identical fixture commits share a SHA, so the process-wide verdict cache hands it the sibling's red (found by an operator session 2026-11-23)

- **Symptom:** GitHub CI on main `608cb8e5` (the 0.11.0 release commit, run 45339869241 attempt 1) failed only this test; the rerun of the same sha passed, and so did CI on its parent `d13725c4`, whose src/ and test/ trees are identical.

  ```
  ✖ a suspended head another check records red is settled without waiting for the interval (243.239847ms)
    AssertionError [ERR_ASSERTION]: the watch itself made no verdict yet
    actual: 2, expected: 1
        at TestContext.<anonymous> (file:///…/dist/test/main-watch.test.js:350:12)
  ```

- **Reproduce:** run it right after its sibling `a red whose bisection re-runs reach no verdict still names the tip` (test/main-watch.test.ts:326): `npm run build`, then repeat `node --test --test-name-pattern='a red whose bisection re-runs reach no verdict|a suspended head another check records red' dist/test/main-watch.test.js` — 8 of 20 runs failed on this host. Run alone, it passed 15 of 15.
- **Cause:** every `culpritFixture()` repo (test/fixtures/main-watch-fixtures.ts:55 → `baselineFixture`, test/fixtures/runner-fixtures.ts:168) commits the same tree, with the same `test <test@example.com>` identity from `gitInit` and the same messages (`seed`, then `edit bad.txt`). So two fixtures built within the same wall-clock second get byte-identical commits and the same SHAs. `baselineCache` (src/baseline/main-baseline.ts) is process-wide and keyed by SHA alone. The sibling test leaves a red verdict with `checkedAt` cached for the shared `bad.txt` SHA. When this test polls that head, `fullCheckPlan` (src/baseline/main-watch-full.ts:76-85) picks that red as its anchor, returns `skip: false` and runs the full check, which is the second `main_check` the assert sees. The file's header comment ("every fixture repo has its own, so these tests share no state", test/main-watch.test.ts:30-32) is true only while the fixture SHAs differ. The other `culpritFixture` tests in main-watch.test.ts (lines 123–383) and the `change(root, "bad.txt", "b")` tests in main-watch-mirror/main-red-heal/main-watch-spells are exposed in the same way whenever two of them in one process land in the same second.
- **Fix direction:** make each fixture's commits unique, so the SHA-keyed cache really is per repo. For example, `baselineFixture` could write a per-fixture nonce (its tmpdir path) into the seed commit's message or a tracked file. Clearing `baselineCache` between tests would also work, but it hides the shared-key assumption instead of making it true. The regression test: build two `culpritFixture`s back to back in one test, assert their `bad.txt` commits differ, and keep the pair repro above green.

### A reviewer's fix is pre-checked on the fix tree as PINNED, never on the tree `mergeToMain` rebases onto main's tip, so an auto-merged rebase that duplicates a line both sides added lands unchecked and turns main red (found by the bugfix role 2026-11-23)

- **Symptom:** main's tip `1706a712` ("tumwater(reviewer): Fix e3572db9 — …") fails `node scripts/tsc.mjs` with `error TS2300: Duplicate identifier 'isJsonObject'` at `src/github/github-issues-state.ts:10` and `:12`; its parent `1706a712^` (`e279ac3d`) compiles clean (rc=0). The main watch logged `main_check status=failed` for it and named `improve` as `main_culprit` — the wrong role: the breaking commit is reviewer-authored, and the author's own change had passed its gate. The team's own build check is the only thing that caught it; no merge-stage check did.
- **Reproduce:** offline at the seam — the shape is a fix commit whose added line is byte-identical to a line main gained independently in a nearby hunk, so git auto-merges the rebase and keeps BOTH. `test/merge-drain.test.ts` / `test/post-merge-review.test.ts` are the fixtures: make main move between the reviewed commit and the fix merge so that both sides add the same import line at a nearby position, let the reviewer's fix pass its pre-check, and assert main's post-merge tree compiles. Pre-fix, main is fast-forwarded onto the doubled line. (`git diff e279ac3d 1706a712` is the recorded case.)
- **Cause:** `precheckReviewerFix` (src/merge/merge-post-review-drain.ts:330) runs `gateBuildPrecheck` over the fix tree **as pinned** — checked out detached at `fix`, i.e. based on the reviewed commit, which is main's history as of the review, not as of the merge. Then `mergeReviewerFixCommit` → `mergeToMain` rebases that fix onto main's CURRENT tip (merge-to-main.ts:136) and fast-forwards with no check of the REBASED tree: since part 4l/3 removed the in-lock `verifyMerge`, `tryMerge`'s only re-check arm is `ctx.recheckResolved`, which fires only for a conflict whose resolution diverges (merge-to-main.ts:111). A rebase git resolves WITHOUT a conflict — an auto-merge that keeps both sides' added lines — so nothing ever looks at the bytes that actually land. The 2026-11-04 fix (BUGS-FIXED.md:2538-2544) closed the no-check-at-all hole by adding the pre-check, and its own text records the limitation: "It runs OUTSIDE the merge lock, over the fix tree as pinned." The pinned-tree check cannot see a rebase-introduced failure. Contrast the merge slot's rule (BUGS-FIXED.md:5038, verifiedHead / no-op-rebase): there the landing checks the post-rebase head.
- **Fix direction.** The reviewer-fix landing must verify what lands, not what was authored. The cheapest sound shape: run `gateBuildPrecheck` (or the landing-scope equivalent) over the POST-REBASE tree inside the merge lock, after `rebaseOntoMain` and before `ffMainToOrWhy`, exactly where the merge slot's `verifyLanding` already does it — and keep the pinned pre-check as the cheap early withhold so a broken fix still never costs a lock turn. A cheaper alternative (rebase into the review worktree BEFORE the pre-check, then land that head) needs care: the rebase moves the fix sha, so `mergedTag`/`fixed` bookkeeping and the withheld-fix ref must follow the new head. Either way the invariant to record in docs/invariants.md is: *a reviewer's fix is checked on the tree that will be fast-forwarded onto main, not only on the tree the reviewer wrote.* Add the regression with a fixture where the rebase introduces the failure and the pinned tree is green — that is the case no existing test can express.
- **Notes for the fixer.** Do not treat this as the 2026-11-04 entry re-opened: that hole (no check at all) is closed and stayed closed — a check ran and passed, on the wrong tree. Related but distinct: BUGS-FIXED.md:5038 (the merge slot's no-op-rebase arm skipping the landing check), which is the same principle one path over.

### `applyRunOutcome: consecutive skipped runs climb the idle ladder, capped, and a real run resets it` failed, then passed on the same tree (quarantined by tumwater 2026-11-23)

The check failed on this test and then passed on a re-run of the same tree, so tumwater quarantined it: it counts as a known failure until this entry leaves `## Open`. Find why it is unstable and fix it.

~~~~
✖ applyRunOutcome: consecutive skipped runs climb the idle ladder, capped, and a real run resets it (0.829542ms)
AssertionError [ERR_ASSERTION]: skip 2 wakes after its own ladder step
at TestContext.<anonymous> (file:///Users/zach/tumwater/.tumwater/worktrees/_merge/dist/test/run-apply.test.js:210:16)
at Test.runInAsyncScope (node:async_hooks:226:14)
generatedMessage: false,
code: 'ERR_ASSERTION',
actual: 1795492341992,
expected: 1795492341991,
operator: 'strictEqual',
diff: 'simple'
}
lint: clean
~~~~

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
