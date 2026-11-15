# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

_None yet._

### `secretLeakReason`'s two untested changed-file guards — the most-files-named bound and the per-file size cap — are pinned in test/secret-leaks.test.ts, so a regression in the secret-leak gate's own finding limits is caught by the suite (planned 2026-11-14 by the plan role; the secret-leak gate src/review/secret-leaks.ts is live — called by the review gate and the stage check, src/review/diff-rules.ts, src/review/review.ts and src/stage/stage-check.ts — and its happy path, merge-base exclusion, symlink non-following, credential sources and unreadable-file findings are all already pinned in test/secret-leaks.test.ts, but its two changed-file *limits* are not: the most-files-named bound and the per-file size cap; independent in file of the one waiting `## Planned` entry, which tests src/review/post-merge-review.ts and src/config/config-views.ts, so feature can take either)

**Goal.** `secretLeakReason` (src/review/secret-leaks.ts, the exported async gate) has two changed-file guards that its own test file never exercises. The *most-files-named* bound: after it gathers one finding per leaked/unreadable file, it names only the first `MAX_NAMED` (10) of them, `slice(0, MAX_NAMED)`, and appends `moreSuffix(leaks.length - MAX_NAMED)` — a ` (+N more)` for the overflow — so a change that dumps the same secret into a dozen files reports "ten named, and N more" rather than an unbounded reason string. The *per-file size cap*: `readFileForScan` skips any regular file whose `lstat` size exceeds `MAX_SCAN_BYTES` (8 MiB) instead of reading it, so a hostile or accidental huge file can never be slurped into the scan. Both guards are pure and cheap to drive from a repo fixture, and neither is covered: a reviewer who changes `MAX_NAMED`, `moreSuffix`'s wording, or the `size > MAX_SCAN_BYTES` test has no test that fails. Pin both so the gate's own output limits and its read-safety rule are part of the suite's contract.

**Approach.** One file, test-only, no src change and no invariant edit (the gate's finding *rules* — names the variable never the value, merge-base exclusion, unreadable-file reporting — are already pinned; this adds only the two *limit* cases): add two `test(...)` cases to test/secret-leaks.test.ts beside the existing ones, reusing the file's existing `worktree(base, edit)` helper (a `makeRepo` + `ensureWorktree(root, "improve", "main")` worktree) and its `VALUE`/`ENV` constants (one secret, `$HF_TOKEN`, so every leaking file names the same variable). For the most-files-named case, write a base with a few non-secret files and an edit that puts `VALUE` into eleven distinct files, then assert the reason names exactly `MAX_NAMED` of them and ends with the ` (+${overflow} more)` suffix. For the size-cap case, write one file whose size exceeds the 8 MiB cap containing `VALUE` and one small file containing it, and assert the oversized one is not reported while the small one is. Both read through the real git fixtures, so they also keep the real `changeBaseRev`/`fileContentAt` merge-base path exercised at scale.

**Files touched.** test/secret-leaks.test.ts.

**Acceptance criteria.**
- With a change that puts the same known secret value into eleven changed files, `secretLeakReason(wt, "main", <all eleven files>, ENV)` returns a string that contains a finding for exactly ten of those files (the first `MAX_NAMED` in the `files` order) and ends with ` (+1 more)` immediately before the ` — delete the file or remove the value;` closer, and does not name the eleventh file (the bound and the `moreSuffix` wording are the contract).
- With a changed file whose size exceeds `MAX_SCAN_BYTES` (8 MiB) containing the value alongside one small changed file containing it, the returned string names the small file and does not contain a finding for the oversized one — the oversized file is skipped before it is read, not read and then filtered.
- Every pre-existing test in test/secret-leaks.test.ts passes unmodified; no source file and no test other than this one change; the project's declared check is green.

## Done
