# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### `npm run build` fails at main's tip with a duplicate `isJsonObject` import, and `status`, `gui`, `issues`, `doctor` and a started team all die with `Identifier 'isJsonObject' has already been declared` (found by the qa role 2026-11-23)

**Symptom.** A fresh `npm run build` of main tip `1706a712b` fails, and the commands that read the
GitHub-issues ledger — `status`, `gui`, `issues`, `doctor` and a started team — each exit 1 with one
line of output. The README quick start is dead: no team starts, no dashboard is served, no status reads.

```
$ npm run build
> tumwater@0.10.1 build
> rm -rf dist && node scripts/tsc.mjs && node scripts/stamp-build.mjs

src/github/github-issues-state.ts(10,10): error TS2300: Duplicate identifier 'isJsonObject'.
src/github/github-issues-state.ts(12,10): error TS2300: Duplicate identifier 'isJsonObject'.
```

`tsc` exits 2 so `stamp-build.mjs` never runs, but the native compiler still emitted `dist/`, and the
emitted module carries the import twice — so a `dist/` produced by the failed build loads with a
SyntaxError:

```
$ node dist/src/cli.js status
tumwater: Identifier 'isJsonObject' has already been declared
$ echo $?
1
```

**Reproduce** (offline, no model, no network): from a clean worktree at `1706a712b`, `npm run build`
(the `node_modules` borrow makes `npm run build` work in a team worktree); then in a scratch dir made
with `mktemp -d`, `git init -b main`, one empty commit, and `node <wt>/dist/src/cli.js init "hi"`.
`status`, `gui`, `issues` and `doctor` each print that one line and exit 1; `gui` prints it instead of
the documented `tumwater gui at http://127.0.0.1:7180 — Ctrl+C to stop` banner and binds nothing
(`lsof -nP -iTCP:<port> -sTCP:LISTEN` returns no row). `start --once` prints its banner and role list,
then the same line, exit 1 — the crash lands on the lazy import when the round first reads the ledger.

Scoped by running each command against that `dist/` and against a scratch copy of it with the duplicate
import line deleted: exit 1 with that message on `status`, `gui`, `issues`, `doctor` and `start
--once`; exit 0 unchanged on `help`, `init`, `logs`, `report`, `guide`, `history`, `role feature`,
`prompt --list`, `plan --list`, `bug --list`, `questions`, `config get`, `brief --json`, `completion
bash` and `version`. With that one line removed from the copy, every crashing command exits 0 and the
dashboard serves on an ephemeral loopback port.

**Cause.** `1706a712b` ("Fix e3572db9 — … the guard sits at the one shared read") replaced the inline
object check in `isGithubIssueRow` with the shared `isJsonObject` predicate and added its import at
`src/github/github-issues-state.ts:12`, but the file already imported it at line 10 — lines 9–13 are
`ensureParentDir`, `isJsonObject`, `readJsonFile`/`writeJsonAtomic`, `isJsonObject`, `cachedByStat`. A
top-level duplicate binding is `TS2300`, which the native compiler reports and refuses to stamp a build
over, while eslint's import-hygiene rules in `eslint.config.js` (`consistent-type-imports`,
`no-import-type-side-effects`, `consistent-type-exports`) name no duplicate-import rule, so the lint half
of the gate stayed quiet and only the `tsc` half saw it.

**Expected.** `npm run build` exits 0 at main's tip, and the README's start/watch path works: `start`
boots a team, `gui` prints its banner and serves the dashboard, `status`, `issues` and `doctor` report.
**Fix direction (one line, no behavior change):** delete the duplicate `import { isJsonObject } from
"../files/json-object.js";` at `src/github/github-issues-state.ts:12`, keeping line 10; the predicate's
uses at lines 188 and 327 need nothing else. Confirm with `node scripts/tsc.mjs` (red before, green
after) and the issues-ledger/GUI tests.

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
