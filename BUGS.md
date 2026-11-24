# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A re-filed `## Open` bug reworded under a *different* heading slips past `refiledFixedBugFinding`, because that guard keys on whole-heading text (found by the bugfix role 2026-11-23)

**Symptom.** `refiledFixedBugFinding` (merged 2026-11-23 01:47, INV-N7) gives a re-filed
`## Open` bug a staging finding when a closed record already holds it — but only while the
copy keeps the archived heading. It is silent when the copy names the same defect in other
words: two entries landed 31 minutes apart — `f09f20a66` (qa) filed "…`npm run build` fails at
main's tip with a duplicate `isJsonObject` import…", and `707b85ff` (readme) fixed and archived
the same defect as "main's tip does not typecheck: `isJsonObject` is imported twice in
`src/github/github-issues-state.ts`". The qa copy stayed under `## Open`, the backlog index kept
handing it out, and a bugfix run spent itself on work already merged.

**Reproduce.** Offline, no model, no gate. Replay both guards over the two real commits, with
BUGS-FIXED.md read at `707b85ff` (the fix). With base `5dc4f317` — BUGS.md as of the last
commit before the filing that touched it, so the entry IS new over base and the guard's base-skip
is not the reason —
`refiledFixedBugFinding` returns `undefined` and `finishedDuplicateFindings` returns `[]`,
though the live `## Open` entry and the archived `## Fixed` twin name one defect. Control 1
(rules out the merge-base rule): the same call with base `f09f20a66`, the filing commit itself,
is also silent — both bases miss it. Control 2 (rules out a broken guard): paste the archived
heading verbatim, its `— fixed …` stamp removed, under `## Open`, and the same guard FIRES and
names the closed entry. So only the rewording defeats it, and the keys show why:
`finishedKey(open, FIXED_DATE_RE)` is 201 characters against its archived twin's 102, and
`entryKey` is unequal too, because `finishedKey` is `collapseWhitespace(finishedTitle(title))`
— the whole heading with only the stamp stripped — so any rewording changes the identity.

**Why the 2026-11-23 guards do not cover it.** The plan-side twin's own **Notes for the fixer**
(BUGS-FIXED.md) warned "Do not key on exact title text … Key on `entryKey` … or `finishedKey`
with the stamp stripped" — but neither key strips the *wording*, only the date. Every existing
duplicate guard keys on heading text (`duplicatePlannedEntries`, `duplicateHeadings`,
`finishedDuplicateFindings`' exact-copy skip), so the class that survives all of them is a
reworded twin — which is exactly what both archived entries say happened.

**The filing side never asked either.** The qa charter's filing step (src/roles/role-catalog.ts,
step 4 of the qa entry) says only "record ONE reproducible bug in BUGS.md" — it carries no
dedupe step, unlike selfcheck's step 4 (which greps BUGS.md's `## Open` and its own role's
commits) and the feedback role's step 4 (which greps the "Previously filed from this install"
block and `gh issue list`, i.e. upstream issues only). Neither of those two reaches this case
either: the earlier copy was already archived out of `## Open`, and the fix was a
`tumwater(readme):` commit that a role-scoped `git log --grep="tumwater(<role>)"` excludes by
construction (`roleCommitGrep` in src/roles/legacy-role-ids.ts names only the role's own id and
its retired ids).

**Expected.** A copy of an already-fixed bug never reaches `## Open`, and if it does, a run is
told so before it spends itself.

**Fix direction (not one site).** A bug-side duplicate needs an identity that survives
rewording. The cheapest defensible seam is a filing/staging *warning*, not a refusal: when an
`## Open` entry's body cites a file-and-symbol set that an archived `## Fixed` entry also cites
(here both name `src/github/github-issues-state.ts` and `isJsonObject`), report a suspected
duplicate naming both headings, and let the run carry on — a false positive must not block a
real fix, so this cannot be the merge-gate refusal `refiledFixedBugFinding` deliberately is
not. Keep it staging-only, mirroring INV-N7, and reuse the citation spans `fixSymbols`
(src/verdict/fix-claim.ts) already extracts. Fixture archives under a scratch dir, never this
repo's real BUGS-FIXED.md.

**Validation gap:** none — the miss was reproduced by calling the two guards over the two
commits that produced it (`undefined` and `[]` above), not inferred.

### A reviewer's fix is pre-checked on the fix tree as PINNED, never on the tree `mergeToMain` rebases onto main's tip, so an auto-merged rebase that duplicates a line both sides added lands unchecked and turns main red (found by the bugfix role 2026-11-23)

- **Symptom:** main's tip `1706a712` ("tumwater(reviewer): Fix e3572db9 — …") fails `node scripts/tsc.mjs` with `error TS2300: Duplicate identifier 'isJsonObject'` at `src/github/github-issues-state.ts:10` and `:12`; its parent `1706a712^` (`e279ac3d`) compiles clean (rc=0). The main watch logged `main_check status=failed` for it and named `improve` as `main_culprit` — the wrong role: the breaking commit is reviewer-authored, and the author's own change had passed its gate. The team's own build check is the only thing that caught it; no merge-stage check did.
- **Reproduce:** offline at the seam — the shape is a fix commit whose added line is byte-identical to a line main gained independently in a nearby hunk, so git auto-merges the rebase and keeps BOTH. `test/merge-drain.test.ts` / `test/post-merge-review.test.ts` are the fixtures: make main move between the reviewed commit and the fix merge so that both sides add the same import line at a nearby position, let the reviewer's fix pass its pre-check, and assert main's post-merge tree compiles. Pre-fix, main is fast-forwarded onto the doubled line. (`git diff e279ac3d 1706a712` is the recorded case.)
- **Cause:** `precheckReviewerFix` (src/merge/merge-post-review-drain.ts:330) runs `gateBuildPrecheck` over the fix tree **as pinned** — checked out detached at `fix`, i.e. based on the reviewed commit, which is main's history as of the review, not as of the merge. Then `mergeReviewerFixCommit` → `mergeToMain` rebases that fix onto main's CURRENT tip (merge-to-main.ts:136) and fast-forwards with no check of the REBASED tree: since part 4l/3 removed the in-lock `verifyMerge`, `tryMerge`'s only re-check arm is `ctx.recheckResolved`, which fires only for a conflict whose resolution diverges (merge-to-main.ts:111). A rebase git resolves WITHOUT a conflict — an auto-merge that keeps both sides' added lines — so nothing ever looks at the bytes that actually land. The 2026-11-04 fix (BUGS-FIXED.md:2538-2544) closed the no-check-at-all hole by adding the pre-check, and its own text records the limitation: "It runs OUTSIDE the merge lock, over the fix tree as pinned." The pinned-tree check cannot see a rebase-introduced failure. Contrast the merge slot's rule (BUGS-FIXED.md:5038, verifiedHead / no-op-rebase): there the landing checks the post-rebase head.
- **Fix direction.** The reviewer-fix landing must verify what lands, not what was authored. The cheapest sound shape: run `gateBuildPrecheck` (or the landing-scope equivalent) over the POST-REBASE tree inside the merge lock, after `rebaseOntoMain` and before `ffMainToOrWhy`, exactly where the merge slot's `verifyLanding` already does it — and keep the pinned pre-check as the cheap early withhold so a broken fix still never costs a lock turn. A cheaper alternative (rebase into the review worktree BEFORE the pre-check, then land that head) needs care: the rebase moves the fix sha, so `mergedTag`/`fixed` bookkeeping and the withheld-fix ref must follow the new head. Either way the invariant to record in docs/invariants.md is: *a reviewer's fix is checked on the tree that will be fast-forwarded onto main, not only on the tree the reviewer wrote.* Add the regression with a fixture where the rebase introduces the failure and the pinned tree is green — that is the case no existing test can express.
- **Notes for the fixer.** Do not treat this as the 2026-11-04 entry re-opened: that hole (no check at all) is closed and stayed closed — a check ran and passed, on the wrong tree. Related but distinct: BUGS-FIXED.md:5038 (the merge slot's no-op-rebase arm skipping the landing check), which is the same principle one path over.

### A post-merge reviewer's fix is pre-checked on its PRE-rebase tree, so the bytes the merge's rebase composes onto main never reach any check — main went red for 82 min on a duplicate import no parent commit carried (found by the selfcheck role 2026-11-23)

**Digest cluster** (`## Fast merge guardrails`, verbatim): "main has had no passing full check for
82 min: red since 1706a712 at 15:20; the main watch blames improve's merge 1706a712". Correlated
merged commit: `1706a712b` ("tumwater(reviewer): Fix e3572db9 — …"), landed 15:16, main green again
only at `707b85fff` 16:42. The digested restart line "11-23 16:31 tumwater — restarting onto update
e279ac3d" shows the team re-deploying to the commit *before* the red one (INV-K1 targets a green tip),
so it ran a stale build across the whole window. The visible damage — `npm run build` failing at main's
tip and `status`/`gui`/`issues`/`doctor`/`start` dying at load — was repaired at `707b85fff`
(BUGS-FIXED.md, "main's tip does not typecheck: `isJsonObject` is imported twice", and the still-Open
qa entry above, whose symptom `707b85fff`'s one-line deletion already clears). That fix removes the
offender, not this mechanism, so the same shape can recur. The wrong response: the harness ran a full
deterministic check over the fix and passed it, while the tree that actually fast-forwarded onto main
was never checked — and no signal in this window says so: the digest's Top review failure clusters
section reads "no review failures in the window", and the only line that surfaces it is the
guardrails line itself.

**Mechanism** (read in source). `mergeReviewerFix` (src/merge/merge-post-review-drain.ts:307) guards
main with `precheckReviewerFix` (:330) → `gateBuildPrecheck` (src/review/review-precheck.ts:320),
which runs `runScopedBuildCheck` over the worktree as it stands — the fix commit as pinned, with no
rebase anywhere in src/review/ (`grep -rn rebase src/review/` names one comment, review-precheck.ts:283). The merge
that follows, `mergeReviewerFixCommit` (:414) → `mergeToMain` (src/merge/merge-to-main.ts:93),
rebases that commit onto main's tip **inside the lock** (:136) and fast-forwards the resulting
head (:149). A clean rebase reaches no check: `recheckResolved` fires only when the rebase
conflicts AND the resolved diff diverges from the reviewed diff (merge-to-main.ts:103-115), and part 4l/3 removed the
in-lock `verifyMerge`, so `tryMerge` is rebase-plus-fast-forward (BUGS-FIXED.md:2562 names that).
`precheckReviewerFix` returns only a boolean (:393-394), so the pass verdict's sha (`pre.verifiedHead`,
which `gateBuildPrecheck` returns at review-precheck.ts:384 for exactly the tree it judged) is
dropped: nothing downstream can tell that the landed sha is not the checked one.

**Proof that the rebase composed the failure** (git only, offline, no model):

```
$ for c in ad3db64fa e279ac3dc 1706a712b; do printf "%s " $c; git show $c:src/github/github-issues-state.ts | grep -c '^import { isJsonObject }'; done
ad3db64fa 1   # the fix as authored (base e3572db9e) — compiles, and its pre-check passed
e279ac3dc 1   # main's tip at merge time — compiles
1706a712b 2   # the tree that landed — TS2300 Duplicate identifier (BUGS.md entry above)
```

`ad3db64fa` is the fix commit `mergeReviewerFix`'s pre-check judged; `1706a712b` is its rebase, which
is what `mergeToMain` fast-forwarded. The fix's own diff adds the import after `readJsonFile` (line
12) while main's tip already carried it at line 10 — added by `a9bfd9f09`, an ancestor of `1706a712b`
but not of `e3572db9e` (`git merge-base --is-ancestor a9bfd9f09 e3572db9e` fails, `… 1706a712b`
succeeds). Two clean hunks in different lines of one file: no conflict, so no resolver, so no
re-check. The timeline is in the shared reflog (`git reflog "worktrees/_post-review/HEAD"`):
`ad3db64fa … commit` 15:16:46 → `e279ac3dc … rebase (start): checkout main` → `1706a712b … rebase
(pick)` 15:16:54 → main green at `707b85fff` 16:42. In code order the pre-check sits between the two
(`mergeReviewerFix` calls it at :309 before `mergeReviewerFixCommit` at :310).

**Same root, second face** (not the one that fired today): the queued-change path gates the *synced*
tree (`reviewQueuedChange` calls `syncPinToMain` before `reviewPinnedChange`, merge-core.ts:347), so
its verdict is post-rebase — but only for the main tip of that moment. If main moves between the
gate's sync and the lock's rebase, `tryMerge`'s rebase is not a no-op and that newer tree is merged
unchecked by the same absence of a clean-rebase check — the code says so at merge-core.ts:426 ("a clean
rebase is accepted as-is: mergeToMain's in-lock rebase moves it onto main's tip and fast-forwards").

**Expected.** The deterministic check guards the bytes that land. Either run the fix's pre-check after
rebasing the fix onto main's tip (reuse `syncPinToMain`, merge-core.ts:136, in the same dedicated
`postReviewWorktreePath` worktree it already uses) and carry the checked sha so the lock's rebase is a
no-op, or re-check `tryMerge`'s post-rebase head when it differs from the head a check passed on —
`verifiedHead` already names that head and is already plumbed into `MergeRequest` (merge-core.ts:63).
**Not this fix:** widening `recheckResolved` — its subject is a conflict resolution's bytes, which no
reviewer authored, and that guard fired on nothing here because this rebase was clean. `test:gate`'s `node scripts/tsc.mjs` half
catches this failure class exactly; lint does not — `eslint.config.js`'s import-hygiene rules are
`@typescript-eslint/consistent-type-imports`, `no-import-type-side-effects` and
`consistent-type-exports` (:81-83), none of which flags a repeated import.

**Candidates to pin it.** `test/post-merge-review.test.ts` "a reviewer's fix that fails its pre-check
is withheld from main (BUGS.md 2026-11-04)" needs its sibling — a fix that passes its pre-check as
authored and fails only after the rebase, expecting the fix withheld (or the merge retried), main
unmoved; `test/merge-to-main-recheck.test.ts` holds the clean-rebase-skip cases for the second face.
Update the pre-check guarantee in docs/invariants.md (INV-BT8, :5155) in the same change if the check
moves to the rebased tree.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
