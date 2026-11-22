# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### A red check's reasons number node:assert's own dump, the test runner's frames, and lint's
status line, so one rejection asks the author to answer ten lines of plumbing
(found by the selfcheck role 2026-11-22)

**Symptom.** When `npm run test:gate` goes red, the author's next run is told to answer each
numbered objection (src/prompt/gate-notes.ts:73 numbers them, :82 demands "Add one Objection N:
<done|dropped|unchanged-by-design because …>" for each) and the reviewer is told to "Check each of
the prior review's numbered objections FIRST — an unresolved one is a rejection on its own"
(src/prompt/gate-prompts.ts:202). Most of those objections name nothing the author can act on: they
are node:assert's own dump, the test runner's frames, and the lint runner's status line. On
`c4b6505b` (merged 2026-11-22, the digest's top loss cluster) the queued change's `Prior-review:`
trailer carried 11 reasons with `counts: [0,0,0,0,0,0,0,0,0,0,0]`, and the merged commit body spends
ten `Objection N:` lines answering them — six of them (2, 3, 4, 8, 9, 10) say things like
`done — same failure's stack frame; resolved by the fix above`, `unchanged-by-design because
`deepEqual` is the check's own pre-existing operator, which I did not touch`, and
`unchanged-by-design because lint was already clean`. Those turns bought nothing: the change was one
doc-command fix plus an invariant renumber.

**Reproduce.** Read `git log -1 --format='%b' c4b6505b`'s `Prior-review:` trailer: reasons 2-3 are
`at TestContext.<anonymous> (file:///…/dist/test/…)` and
`at Test.runInAsyncScope (node:async_hooks:226:14)`; 4-10 are
`generatedMessage: true,`, `code: 'ERR_ASSERTION',`, `actual: …`, `expected: []`,
`operator: 'deepStrictEqual',`, `diff: 'simple'`, `}`; 11 is `lint: clean`. The same shape is
quoted verbatim in PLANS-DONE.md:2445 "Remove the TUI, part 1/5" under
`**Needs review 2026-11-20 by feature: rejected after 6 review rounds**` (its "Objections that
survived the final round" list, same numbers 2-11) and in BUGS-FIXED.md:282's `invariants-doc`
quarantine block: each carries the same plumbing lines — the runner's
`at Test.runInAsyncScope (node:async_hooks:226:14)` frame, `generatedMessage:`,
`code: 'ERR_ASSERTION',`, `operator: …`, `diff: 'simple'`, `}` and `lint: clean` — whatever the
failing test was (the 10-line window keeps only one of the two frames).

Offline reproduction, no model: build the tree and feed node:test's own output for one failed
`deepStrictEqual` through `clipBuildTail` and `checkFailureReasons`. On main's tip this run, that
printed 11 reasons for the single failing test: the headline, then
`at Test.runInAsyncScope (node:async_hooks:226:14)`, `{`, `generatedMessage: true,`,
`code: 'ERR_ASSERTION',`, `actual: [ 'docs/invariants.md:5598 run' ]`, `expected: []`,
`operator: 'deepStrictEqual',`, `diff: 'simple'`, `}`, `lint: clean` — 8 of 11 lines say nothing
about the diff.

**Suspected cause.** `checkFailureReasons` (src/build/build-check-report.ts:246) returns the
headline plus every surviving `clipBuildTail` line, one reason per line. The 2026-10-20 fix
(PLANS-DONE.md "A red check's reasons drop Node's own `node:internal` stack frames…") dropped only
what `NODE_INTERNAL_FRAME` matches, and its doc comment says so explicitly: a frame in
`node:async_hooks` or a `dist/test/` file is kept. So these still become numbered objections:
the runner's non-`node:internal` frames, node:assert's mechanics keys (`generatedMessage`, `code`,
`operator`, `diff`, the closing `}`), and `lint: clean` — `test:gate` runs
`scripts/lint-changed.mjs --alongside`, which prints that line last
(scripts/lint-changed.mjs:71, pinned by test/lint-changed.test.ts), landing it inside the
tail window (`clipBuildTail`, src/build/build-check-report.ts:164-168).

This also mis-prices finality: `recordRejectedChange` counts each reason's persistence
(src/merge/merge-core.ts:395-399) and ends the reject→revise chain when one objection survives two
revisions (`REVISION_FINAL_ON_REPEAT = 2`, src/runner/runner-revision.ts:34) or the chain hits
`REVISION_BACKSTOP` (6); `holdEntryAfterExhaustion` then parks the entry on those reasons verbatim
(src/merge/merge-core.ts:413). A plumbing line cannot be fixed, so a revision that re-runs the same
red check restates it: the TUI removal part reached the backstop and its Needs-review note lists all
eleven surviving objections, of which only reason 1 and the `actual:` line name a finding.

**Fix direction.** In `checkFailureReasons`' verified branch, drop the lines that describe the
checking machinery rather than the finding — the runner frames `at Test.runInAsyncScope (…)` and
`at TestContext.<anonymous> (…/dist/test/…)`, node:assert's mechanics keys (`generatedMessage:`,
`code: 'ERR_ASSERTION'`, `operator:`, `diff:`, a bare `{`/`}`), and `lint-changed`'s own status
lines — while keeping `actual:` and `expected:`, which are the assertion's diff and are why the
2026-10-20 fix widened the window. `c4b6505b`'s 11 reasons become 3. Keep the `unverified` branch
unchanged.

**Cost that makes it fileable.** The digest's top loss cause: 2.3 h · $0.46 across 4 runs on
"review-rejected authoring on bugfix — check failed (`npm run test:gate`): ✖ every command the
docs quote is a command `tumwater help` lists", plus 1.5 h · $0.00 across 3 robustness runs on the
comment-column scan — the same one-line finding, ten lines of objections each time.

### The mirror's own remedy sentence names a `config set` form the config key parser refuses (found by the qa role 2026-11-22)

**Symptom.** When `gh` cannot read the repo, `tumwater status` raises the amber banner whose sentence ends `… or set githubIssues.enabled to false`, and the `github issues` doctor warn row says the same. Typing exactly that sentence's command fails: `tumwater config set githubIssues.enabled false` exits 1 with `unknown config key "githubIssues.enabled" — dotted keys name one entry of a per-role map or one field of a role entry (e.g. `maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`, `review.model x`); a bare key names a whole top-level value`. The alert tells the operator to do a thing the CLI refuses to do, and its own hint does not name the working form. `githubIssues.close` and `githubIssues.scanIntervalMinutes` are refused the same way, and `tumwater config unset githubIssues.enabled` too — while docs/config.md's `githubIssues` row documents `enabled`, `close` and `scanIntervalMinutes` as sub-keys of one section and says `enabled` "turns it and its `github issues` doctor row off", and `tumwater completion --config-keys` lists only the bare `githubIssues`.

**Reproduce.** Deterministic and offline, no real `gh` call needed. In a scratch repo (`mktemp -d`, `git init`, `node <dist>/src/cli.js init "x"`, `git remote add origin https://github.com/o/r.git`), hand-write `.tumwater/state/github-issues.json` with `{"repo":"o/r","branch":"main","checkedAt":<now ms>,"gh":"missing","reason":"gh not installed","open":[],"closed":{},"closedRows":[]}`. `tumwater status` then prints:

```
! Can't read GitHub issues for o/r — gh is missing — install GitHub CLI (https://cli.github.com) so tumwater can read o/r's issues, or set githubIssues.enabled to false
```

and `tumwater config set githubIssues.enabled false` exits 1 with the `unknown config key` error above (observed 2026-11-22 on main's tip, dist built from 30fde732). The documented whole-value form does work — `tumwater config set githubIssues '{"enabled":false}'` prints `set githubIssues to {"enabled":false}`, `tumwater config get githubIssues` then shows the parts merged (`{"enabled":false,"close":true,…}`), and the banner is gone from `tumwater status` — but it names the whole section, not the sub-key the sentence names, and a first-time operator reading "set githubIssues.enabled to false" types the refused form.

**Cause.** `src/config/config-keys.ts` admits dotted sub-key access only for the heads in `DOTTED_SECTION_FIELDS` (`review`, `check`, `idleBackoff`, `bootstrap`) plus `DOTTED_MAP_KEYS` (`maxDailyCostUsdPerRole`, `quietHoursPerRole`) and the `roles.`/`model.`/`backends` heads; `githubIssues` is in none of them, so `parseConfigKey` falls through to the generic dotted-shape error and `DOTTED_KEY_HEADS` cannot even offer a did-you-mean. Meanwhile the sentence comes from one predicate, `ghUnreadableSentence` (src/github/gh.ts:38-39), reused by the doctor `github issues` row and the status/dashboard banners — so the un-actionable remedy lands wherever `gh` cannot read the repo. Fix direction: add `githubIssues` to `DOTTED_SECTION_FIELDS` with its field list (the natural companion of the existing four), or reword the sentence to the `config set githubIssues '{"enabled":false}'` form that works; the former keeps the sentence the docs and tests already promise.

**Notes for the fixer.** `githubIssues.enabled: false` is already understood on the read side everywhere else (docs/invariants.md:5642, test/doctor-checks.test.ts:421, test/status-data.test.ts:502), so only the write path is missing it. The same sentence is reused in three places from one predicate — `src/github/gh.ts:38-39` (`ghUnreadableSentence`), called by the doctor row (src/doctor/doctor-project-checks.ts:560) and the status/dashboard banner (src/ui/team-alert-status.ts:260) — and the offline repro with `PATH` stripped of `gh` makes the doctor row itself print it: `warn  github issues gh is missing — install GitHub CLI (https://cli.github.com) so tumwater can read o/r's issues, or set githubIssues.enabled to false`.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
