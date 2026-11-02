# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Hourly gate restore, part 1/2: The gate runs its pre-merge build check again, rejects a change that fails it twice, and keeps the pin on an abort or host sleep (planned 2026-11-02 by the plan role, splitting the too-large Hourly full check part 1a/4 entry after feature held it; design in plans/main-check-cadence.md; user direction 2026-11-01: the gate keeps its build check; the check was removed by 8ed0d3eec, so this part restores its run, flake re-run and outcome plumbing from that commit's parent; sibling of Hourly gate restore part 2/2, which adds the main-tip attribution; touches src/review/review-precheck.ts src/review/review.ts src/merge/merge-core.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-flake.test.ts)

**Goal.** `reviewAheadOfMain` runs the project's declared check in the `gate` scope again before it approves a code change (user, 2026-11-01: "it should gate each commit"). This part restores the module Subtract part 3b/7 deleted (`8ed0d3eec^:src/review/review-precheck.ts`) only as far as the check itself and its non-attribution outcomes: a clean tree approves, one immediate re-run excuses a flake and quarantines its tests, a failure that reproduces is rejected through the shared reject path, and a check the harness stopped or the host slept through never judges the tree. The twice-failed attribution against main's tip is part 2/2; until it lands, a reproduced failure is the change's.

**Approach.**
- src/review/review.ts: add optional `buildCheckTimeoutMs` and `sampleSleep` to `ReviewContext` (the parent commit's test seams). Extend `GateResult`'s decision with `"failed"` and add `unverified?: boolean`; keep the existing `aborted` and `detail` fields. Do not add `mainRed`, `awaitingWatch`, `discarded` or `verifiedHead`.
- Add `src/review/review-precheck.ts` from `git show 8ed0d3eec^:src/review/review-precheck.ts`, keeping `gateBuildPrecheck`, the one `runGateCheck` closure around `runScopedBuildCheck(root, role, "gate", wt, config, timeout, sampleSleep, ..., ctx.signal)`, the one flake re-run with `quarantineTests`/`FLAKY_WARNING_PREFIX`, `isKnownFlake`, `onlyKnownMainFailures`, `unverifiedTreeOutcome` and `sleptPhrase`. Drop `staleBaseFailures`, `attributeOnRedMain`, the `mainTipFailures`/`rerunAtMainTip`/`watchedMainVerdict`/`watchVerifiesMain` imports and the main-tip block; part 2/2 restores them.
- In the restored module: a `skipReason === "aborted"` pre-check returns `{ resolved: { decision: "failed", aborted: true } }`; after the flake re-run, a second `ctx.signal?.aborted` check returns the same; a failed outcome with `unverifiedTreeOutcome(outcome)` warns `sleptPhrase("gate check", ..., UNVERIFIED_TREE)` and returns `{ resolved: { decision: "failed", detail, unverified: true } }`; a failure naming only main's known failures warns and returns `{}` (the change approves); every other reproduced failure returns `{ resolved: await reject(checkFailureReasons(check, outcome)) }`. Also short-circuit a known-flaky headline with a warning and `{}`.
- src/review/review.ts: after the diff rules and before `state.lastApprovedHead = head`, call `gateBuildPrecheck(ctx, state, head, reject)` and return `pre.resolved` when set; otherwise continue to the current approve path.
- src/merge/merge-core.ts: before the rejected handling, return `{ kind: "result", result: "aborted" }` when `gate.aborted`; when `gate.decision === "failed"`, set `state.lastError = \`gate check failed: ${gate.detail}\`` and return `{ kind: "result", result: "review_error" }` so the pin stays for the next attempt. In `mergeApprovedChange`'s `recheckResolved`, treat `gate.aborted || gate.decision === "failed"` as `{ verdict: "retry" }`, never as a rejection.
- docs/how-it-works.md's Review section says the pre-merge gate runs the diff rules and then the declared gate check, with one retry for a transient flake. docs/invariants.md records INV-DA1: an aborted gate check or one whose every attempt spanned a host sleep keeps the pin and judges nothing; a reproduced failure is the change's until part 2/2 adds attribution.

**Files touched.** src/review/review-precheck.ts src/review/review.ts src/merge/merge-core.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-flake.test.ts

**Acceptance criteria.**
- A clean code change runs the gate command once and approves; a repo with no declared check still approves as today; an md-only diff still short-circuits before the check.
- A twice-failed change is rejected through `reject` after the pre-check and its one immediate re-run, and starts no run of main, with the check's failure reasons in its next prompt.
- A first failure that passes on the immediate re-run approves, warns as flaky, and quarantines the named tests; a failure naming only main's known failures approves with no second run.
- A pre-check whose `outcome.skipReason` is `"aborted"`, and an abort observed after the re-run, returns `{ decision: "failed", aborted: true }`; the worktree is not reset and the merge path settles `aborted` with the pin kept.
- A failed outcome with `unverifiedTreeOutcome` returns `{ decision: "failed", unverified: true }` and the merge path settles `review_error` with the pin kept; no rejection is recorded.
- `grep -rn 'mainRed\|awaitingWatch\|watchedMainVerdict\|watchVerdictCovering' src/review/review-precheck.ts src/review/review.ts src/merge/merge-core.ts` prints nothing.
- `npm run test:gate` passes.

**Tests.**
- Add test/review-precheck.test.ts driving `reviewAheadOfMain` over a repo whose config declares a gate command, with the fake check writing marker files: clean pass after one run; twice-failed named test rejected; no declared check approves; an aborted check settles `failed`/`aborted` without resetting the worktree.
- Add test/review-precheck-flake.test.ts: a first failure that passes on the immediate re-run approves, warns as flaky and quarantines the named test; a failure naming only main's known failures approves without a re-run.
- Run those files and the gate.

### Hourly gate restore, part 2/2: The gate attributes a twice-failed check by asking main's tip about exactly what failed, never by waiting on the watch (planned 2026-11-02 by the plan role, splitting the too-large Hourly full check part 1a/4 entry after feature held it; requires Hourly gate restore part 1/2 landed, so the check and its failed/aborted outcomes already run; design in plans/main-check-cadence.md; user direction 2026-11-01: a twice-failed check is decided on the spot, never by waiting on the main watch; touches src/review/review-precheck.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-main-tip.test.ts test/review-precheck-flake.test.ts)

**Goal.** Replace part 1/2's plain rejection with attribution at main's tip, with no watch and no keep-the-pin-until-the-watch outcome. When a gate check fails twice:

- Named failing tests are asked about alone on main's tip (`mainTipFailures`, via `rerunAtMainTip`). A test that fails there too is main's; a test that passes there is the change's, and the change is rejected with its reasons.
- A failure that names no test (compile, lint, crash) runs the gate command at main's tip through a new `mainTipGateVerdict`: a pass there rejects the change, a fail there too approves it, and an unavailable verdict rejects with the reason attribution could not be made.
- When every named failure is main's, the change approves without a second full check of main. A failure whose tests are also red on the change's base but not at main's tip passes through as the base's (the `staleBaseFailures` rule), and no `awaitingWatch`, `mainRed` or `status === "awaiting"` path is added.

**Approach.**
- src/baseline/main-red.ts: add `export async function mainTipGateVerdict(root, role, mainBranch, config): Promise<MainTipVerdict>` beside `mainTipFailures`, built on `withMainTipWorktree` so it is queued behind `_gate-main` work. Inside the mirror it calls `runScopedBuildCheck(root, role, "gate", mirror, config)`, reads `headOf(mirror, "HEAD")`, and maps `passed` to green, `failed` to red with `failingTests` (default `[]`), and `null`/`skipped` to unavailable with its `skipReason`; a throw reads as unavailable with `errorMessage`. It is exported and read only by `review-precheck.ts`.
- src/review/review-precheck.ts: restore `staleBaseFailures` and `attributeOnRedMain` from `8ed0d3eec^:src/review/review-precheck.ts`, dropping `attributeOnRedMain`'s `unknown` arm: named failures are compared with `knownMainFailures`/`namedFailures(main)`, and a nameless gate failure is decided by `mainTipGateVerdict` alone.
- Replace the reproduced-failure branch's unconditional `reject` with: if named failures exist, `main = await mainTipFailures(root, role, wt, mainBranch, config, failed)`; if `main.status === "red"` and `namedFailures(main).length === 0`, retry with `rerunAtMainTip`; if `main.status === "red"` and every failure is main's, warn and return `{}` (approve); if `main.status === "green"` or a red that names fewer failures, run `staleBaseFailures` and either return `{}` or reject with `checkFailureReasons` plus `mainRedNotTheseFailures(main.sha, own)`. If no named failures exist, `main = await mainTipGateVerdict(...)`; green rejects with the check reasons, red warns and returns `{}`, unavailable rejects with `main's baseline was unavailable (<why>), so the failure is attributed to this change`.
- Keep the two abort checks from part 1/2 around the attribution: an abort before or after a main-tip run returns `failed`/`aborted`, never a rejection.
- docs/how-it-works.md's Review section says a twice-failed gate check is decided at once by main's tip about exactly its failures (named tests re-run alone, else the gate command), never by waiting on the watch. docs/invariants.md replaces INV-DA1's "until part 2/2" wording with the final guarantee.

**Files touched.** src/review/review-precheck.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/review-precheck.test.ts test/review-precheck-main-tip.test.ts test/review-precheck-flake.test.ts

**Acceptance criteria.**
- A code change that fails twice on named test X, where X passes on main's tip, is rejected after the change's two gate attempts plus one `rerun`-scope run of X on main's tip; it starts no `baseline`-scope run of main and waits on no watch verdict.
- If X also fails on main's tip, the change approves without a second full check of main.
- A failure that names no test is rejected when main's tip passes the gate command and approves when main's tip fails it too; an unavailable main-tip verdict rejects with a reason naming why.
- A change whose named failures are all red on its own base but not at main's tip approves through `staleBaseFailures`.
- `grep -rn 'awaitingWatch\|watchedMainVerdict\|watchVerdictCovering\|status === "awaiting"' src/review/review-precheck.ts src/baseline/main-red.ts` prints nothing new for the gate path; `grep -n 'mainTipGateVerdict' src/review/review-precheck.ts src/baseline/main-red.ts` matches the definition and the one gate call.
- `npm run test:gate` passes.

**Tests.**
- Extend test/review-precheck.test.ts with the named-failure attribution: X rejected against a green tip; X that also fails on the tip approved; a nameless failure decided by the gate command on the tip both ways; an unavailable tip rejects with its reason.
- Add test/review-precheck-main-tip.test.ts for `mainTipGateVerdict` itself: green when the gate command passes at main's tip, red with the failing tests when it fails, unavailable when the check is skipped.
- Keep test/review-precheck-flake.test.ts's flake and known-main-failure cases green; run these files and the gate.

### Hourly full check, part 1b/4: The dead watch-wait and `awaitingWatch` plumbing is removed from the merge queue, runner state and phrases (planned 2026-11-02 by the plan role, splitting the too-large part 1 entry; requires Hourly gate restore part 2/2 landed, so no gate sets `awaitingWatch` and no merge produces `main_red`; touches src/baseline/main-red.ts src/baseline/main-baseline.ts src/review/review.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts src/merge/merge-pipeline.ts src/merge/merge-queue.ts src/merge/merge-requeue.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/text/phrases.ts docs/how-it-works.md docs/invariants.md test/merge-requeue-watch.test.ts test/merger-check.test.ts)

**Goal.** With the gate deciding every twice-failed check at once (Hourly gate restore part 2/2) and `GateResult` already carrying neither `mainRed` nor `awaitingWatch`, the watch-wait hand-off is dead vocabulary: `awaitingWatch` is set nowhere, `WatchWait` is never produced, and `requeueAwaitingWatch` can never find a kept pin. Remove it so the merge path has one re-queue rule (Every commit is verified on main part 4j/3 and 4k/3 can then delete the rest of `main_red`).

**Approach.**
- src/baseline/main-red.ts: delete `WatchWait`, `watchVerdictCovering` and `watchedMainVerdict`. Keep `MAIN_RED_VERDICT_WAIT_MS` and `mainTipFailures`/`rerunAtMainTip`/`namedFailures`: `requeueMainRedPin` still uses the timeout for a pin kept as `main_red` before this part lands, until part 4k/3 removes the `mainRedRetry` record.
- src/baseline/main-baseline.ts: delete `newestObservedBaseline` if this removal leaves it with no reader; grep first and keep it only if another module still reads it.
- src/review/review.ts: drop `ReviewContext.watchWait` and the `WatchWait` import.
- src/merge/merge-core.ts: drop `MergeRequest.watchWait`, its spread into the review context, and `GateOutcome`'s `awaitingWatch`.
- src/merge/merge-batch.ts and src/merge/merge-verify.ts: drop `verifyRequestIn`'s `watchWait` spread, `VerifyVerdict.awaitingWatch`, and the `awaitingWatch` computation passed to `settleMergeOutcome`.
- src/merge/merge-pipeline.ts: drop `settleMergeOutcome`'s `awaitingWatch` parameter and its pass to `requeueKeptChange`.
- src/merge/merge-queue.ts: drop `MergeEntry.watchWait` and the queue-file validation of it.
- src/merge/merge-requeue.ts: drop `requeueAwaitingWatch`, `requeueMainRedPin`'s `awaitingWatch` branch, `requeueKeptPin`'s `watchWait` parameter and the `watchWait` spread in `enqueueRetry`, and the destructured `watchWait` in the plain re-queue.
- src/runner/runner-state.ts and src/runner/runner-state-load.ts: drop `mainRedRetry.awaitingWatch` and its load validation; keep `head`, `entry` and `waitingSince`.
- src/text/phrases.ts: delete `mainUncheckedNotJudged`.
- docs/invariants.md: delete the INV-CY watch-wait entries that have no mechanism left (INV-CY2's re-queue timing stays only as the plain `MAIN_RED_VERDICT_WAIT_MS` rule for the pre-existing pin until 4k/3); docs/how-it-works.md drops any sentence saying a gate keeps a change for the watch's verdict.

**Files touched.** src/baseline/main-red.ts src/baseline/main-baseline.ts src/review/review.ts src/merge/merge-core.ts src/merge/merge-batch.ts src/merge/merge-verify.ts src/merge/merge-pipeline.ts src/merge/merge-queue.ts src/merge/merge-requeue.ts src/runner/runner-state.ts src/runner/runner-state-load.ts src/text/phrases.ts docs/how-it-works.md docs/invariants.md test/merge-requeue-watch.test.ts test/merger-check.test.ts

**Acceptance criteria.**
- `grep -rn 'awaitingWatch\|watchWait\|WatchWait\|watchedMainVerdict\|watchVerdictCovering' src/` prints nothing.
- `grep -rn 'mainUncheckedNotJudged' src/` prints nothing.
- `requeueMainRedPin` still re-queues a `main_red` pin after `MAIN_RED_VERDICT_WAIT_MS` and `requeueKeptChange` still re-queues an under-cap review failure; their existing non-watch tests pass unchanged.
- The tree compiles and `npm run test:gate` passes.

**Tests.**
- Delete test/merge-requeue-watch.test.ts, whose whole subject is the removed watch wait.
- test/merger-check.test.ts: drop any seeded `watchWait`/watch-verdict setup; keep its gate-attribution cases, which Hourly gate restore part 2/2 re-pointed at main's tip.
- Run those files and the gate.

### Hourly full check, part 2/4: The main watch runs the full check on main's latest tip at most once an hour, in a mirror of its own (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 1b/4 landed, since until then a twice-failed gate waits for a watch verdict covering its base, which an hourly cadence leaves missing for up to an hour; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/paths.ts src/config/config-schema.ts src/config/config-validation.ts docs/how-it-works.md docs/config.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-rules.test.ts test/main-baseline-persist.test.ts test/config-validation-check.test.ts)

**Goal.** The full check (`check.command`) stops running on every new main head (user, 2026-11-01: "relax the once per main commit (for non-gate tests) and make it more like once per hour on latest main"). Each change is still checked once, by the pre-merge gate's build check. The full check runs on main's latest tip at most once per `check.fullIntervalMinutes` (default 60), and only when main has a code commit its newest full verdict does not cover. It runs in a mirror of its own, so it never holds `_gate-main`, where the watch's per-head diff rules and the gate's re-runs on main's tip run. The diff rules still judge every new head.

**Approach.**
- Split `createMainWatch` (src/baseline/main-watch.ts) into a per-head pass and a due full check, each with its own in-flight promise. `poll` starts each independently, and `idle()` waits for both.
  - The per-head pass keeps `watchRules` in `_gate-main` on every new head, exactly as today.
  - The full check runs `checkMainBaseline` in a new mirror worktree, `_main-full` (a `fullMainWorktreePath` beside `gateMainWorktreePath` in src/paths.ts), at the check-permit tier the watch uses today. It confirms a red, records the verdict and reports the culprit as today.
- The full check is due when the newest observed full verdict's `checkedAt` plus the interval is in the past and main has a first-parent code commit above that verdict's SHA. A doc-only range still inherits green with no run.
  - `checkedAt` is a new field on `MainBaseline`, persisted in baseline-verdicts.json; an entry without it reads as due now.
  - So a restart within the hour starts no extra run.
- Add `check.fullIntervalMinutes` (an integer ≥ 0, default 60) to `CheckConfig`, `CHECK_KEYS`, config-validation, docs/config.md and tumwater.example.json. `0` restores a full run per new head.
- The redeployer is unchanged: `redeployTarget`'s watched branch already targets only commits with a cached green full verdict, so the team's build follows the hourly greens.
- docs/how-it-works.md's main watch bullet describes the cadence. In docs/invariants.md, INV-CZ2's "at most once per main commit" becomes "at most once per `fullIntervalMinutes`", and a new INV-DA2 says: the full check runs at most once per interval, on the latest tip, in its own mirror, and never while no code commit is uncovered.

**Files touched.** src/baseline/main-watch.ts src/baseline/main-baseline.ts src/paths.ts src/config/config-schema.ts src/config/config-validation.ts docs/how-it-works.md docs/config.md docs/invariants.md tumwater.example.json test/main-watch.test.ts test/main-watch-rules.test.ts test/main-baseline-persist.test.ts test/config-validation-check.test.ts

**Acceptance criteria.**
- Code commits landing within an hour of the newest full verdict start no full run. The first poll past the hour with an uncovered code commit starts one, on the latest tip only.
- Every new head still gets the diff rules, and a gate's re-run on main's tip never waits for a `_main-full` run in flight.
- A full verdict persisted 20 minutes before a restart starts no full run in the first 40 minutes after it.
- `check.fullIntervalMinutes: 0` restores one full run per head.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts:
  - the within-the-hour and past-the-hour cases with a fake clock;
  - a restart with a persisted `checkedAt`;
  - `fullIntervalMinutes: 0`.
- test/main-watch-rules.test.ts:
  - diff rules on every head, including heads the full check skips;
  - a `_gate-main` step that does not wait behind a slow full check.
- test/main-baseline-persist.test.ts: `checkedAt` survives a restart through baseline-verdicts.json, and an entry saved without it reads as due now.
- test/config-validation-check.test.ts: the new key's type and bounds.
- Run those files and the gate.

### Hourly full check, part 3/4: Main's failures are narrowed and cleared by re-running only the failing tests — the watch bisects a red's opener, re-runs only the open failures on each new head, and confirms a cleared red with one full run at once (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 2/4 landed; touches src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts)

**Goal.** With the full check hourly, one red verdict covers up to an hour of commits. Narrowing it and closing it must not cost more full runs (user, 2026-11-01: "when fixing failures, re-run only the failed tests"):
- A confirmed red's opener is found by bisection that re-runs only the failing tests, so `main_culprit` and ci's heal prompt name one commit.
- While the red is open, each new head re-runs only the open failures.
- When none fail any more, the red closes as cleared, and one full run starts on that head at once to confirm it, so a healed main becomes deployable without waiting out the hour.

**Approach.**
- After a red is confirmed at tip T, bisect in `_gate-main` with `rerunTests`. The code lives in main-watch.ts, beside `reportCulprit`.
  - The range is the first-parent code commits above the newest observed full green G, found by walking down from T.
  - The opener C is the first commit at which any of the confirmed failing tests fails. Before naming C, confirm once that they fail at C and pass at C's parent.
  - A failing test not accounted for at C (it passes there) gets its own bisect over C..T, up to `FAILING_TESTS_MAX` tests.
  - With no G on the walk, a one-commit range, or a confirmation that does not reproduce, name T as today.
- `reportCulprit` names C everywhere: `main_culprit.commit`, its merging runner, `redSpellOpeners` and the `onCulprit` hand-off (`commit` C, `tip` T).
- While a red spell is open, the per-head pass also re-runs the spell's open failing tests on each new head (one `rerun`-scope check). Tests that pass leave the open set. An empty set:
  - logs `main_check` `{ status: "passed", cleared: true }`, which writes no full green;
  - calls `clearHealKeyOnGreen` and closes the spell;
  - starts a full run on that head at once, once per cleared red.
- `knownMainFailures` and the `<main-known-red>` note read the open set, so a role's prompt stops naming a test ci already fixed.
- docs/how-it-works.md describes bisection and clearing. docs/invariants.md gains:
  - INV-DA3: a red's culprit is the first commit at which its failing tests fail, found by re-running only them.
  - INV-DA4: an open red is narrowed and cleared by re-running only its failing tests, and a clearing starts one confirming full run.

**Files touched.** src/baseline/main-watch.ts src/baseline/main-baseline.ts src/baseline/main-red.ts docs/how-it-works.md docs/invariants.md test/main-watch.test.ts test/main-watch-failures.test.ts test/main-watch-spells.test.ts test/main-red-heal.test.ts

**Acceptance criteria.**
- An hourly red at T covering eight code commits, whose failing test breaks at the third, logs one `main_culprit` naming the third. That takes at most five `rerun`-scope checks and no second `baseline`-scope run.
- A red whose bisect confirmation does not reproduce names T, as today.
- While red, a new head runs one `rerun` of the open failures and no full run. When they all pass, `main_check` is `cleared` and a full run starts though the hour has not passed. `redeployTarget` does not target the cleared head until that full run is green.
- The heal prompt and the `<main-red>` note name C and the re-run command for its failing tests.
- `npm run test:gate` passes.

**Tests.**
- test/main-watch.test.ts:
  - the eight-commit bisect against a fake check whose failure starts at one commit;
  - the non-reproducing bisect;
  - "a red whose breaking commit is intermediate" now names that commit, not the tip;
  - a cleared head that is not deployable.
- test/main-watch-failures.test.ts: per-head narrowing — a new head re-runs only the open failures, and `knownMainFailures` drops a test that passes there.
- test/main-watch-spells.test.ts: the bisected opener is the spell's culprit; clearing closes the spell with `cleared: true` and starts the confirming full run though the hour has not passed.
- test/main-red-heal.test.ts: the heal prompt names the bisected opener.
- Run those files and the gate.

### Hourly full check, part 4/4: Status, doctor and the dashboard say how old main's full verdict is and when the next is due (planned 2026-11-01 by the operator at the user's direction; design in plans/main-check-cadence.md; requires Hourly full check part 3/4 landed; touches src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts)

**Goal.** Main's badge stops implying the newest commit was fully checked. With the full check hourly, `mainCheckForPoll`'s status reads up to an hour behind main. Every surface that shows it says which SHA it covers, how long ago it ran, and when the next run is due (or "due now" after a cleared red).

**Approach.**
- `MainCheckStatus` (src/status/status-polls.ts) gains the full verdict's `checkedAt` and `nextDueAt`. `nextDueAt` comes from part 2/4's interval and part 3/4's cleared-red start.
- `mainCheckBadge` (src/ui/badges.ts) renders "full check green at abc1234, 23 min ago · next in 37 min". A cleared red reads "cleared at def5678 · full check running".
- The TUI line (status-render.ts) and the dashboard card (gui-client-team.ts) use the same payload fields (status-payload.ts). No new alert or doctor row: the existing main-check row carries the text.
- docs/how-it-works.md names what the badge shows.

**Files touched.** src/status/status-polls.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-team.ts docs/how-it-works.md test/status-polls.test.ts test/status-render.test.ts test/gui-client.test.ts

**Acceptance criteria.**
- With a full green 23 min old and a 60 min interval, `tumwater status`, the TUI and the dashboard show the covered SHA, "23 min ago" and "next in 37 min".
- After a cleared red, they show the clearing head until its full run settles.
- No new alert builder or doctor row exists.
- `npm run test:gate` passes.

**Tests.** test/status-polls.test.ts: `nextDueAt` from the interval and from a cleared red. test/status-render.test.ts and test/gui-client.test.ts: the badge text for green, red and cleared. Run those files and the gate.

### Subtract, part 6a/6: The live docs and example config keep only the mechanisms that survived the series (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6b/6, independent in files of it; design in plans/subtract.md "The six strokes" and "How we will know it worked"; its original prerequisites Subtract parts 1e/6, 5v/6 and 5x/6 have landed, and it requires Subtract part 3g/7 landed, the last unlanded Subtract part; touches docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json)

**Goal.** The live prose and `tumwater.example.json` describe only mechanisms that still exist after the Subtract series: the names whose producer and reader the earlier parts removed are gone from the config tables, command lists, glossary, architecture prose and example config, while every mechanism the user kept is still documented and its keys still appear. This is the documentation half of the old sweep; the doctor rows, tests and before/after counts are part 6b/6.

**Approach.** All edits are documentation and the example config; no `src/` file changes here.
- Treat the old sweep list as a candidate list, not a mandate: for each name, `grep -rn '<name>' src/` first. A name whose live `src/` reader or writer is gone is removed from the swept docs and the example; a name `src/` still reads or writes stays documented with its tests. The pre-merge gate keeps its build check (user, 2026-11-01), so in particular `check_wait` and `maxConcurrentChecks` stay wherever the check permit still serves that gate or the main watch, and `mergeCommand` stays wherever the merge step still reads it. `mergeBatchMax` is dead after the batch path landed; `maxConcurrentPerProvider`, `claudeWindowReserve`, `windowReserve`, `review.afterMerge`, `held-for-operator`, `Needs replan`, `Waiting for the next failure` and the `(held N)` counter are dead. The queue vocabulary (`merge queue`, `interlock`) belongs to the landed part 3g/7; remove any occurrence this file still carries.
- docs/config.md: drop the dead keys and aliases from the tables, and keep the rows for the keys `src/config/config-schema.ts` still reads — `instances`, `slotCount`, `slot_wait`, `slot salvage`, the tier/fallback keys, the image reroute and the subscription usage-window display (the Settings concurrency controls and those mechanisms were kept: director 2026-10-31, user 2026-10-28 and 2026-10-30).
- docs/cli.md and the TUI-keys table: drop commands, flags and keys whose implementation parts 3d/7–3f/7 removed, and keep the concurrency controls and declared-check editing that remain. docs/glossary.md: remove the terms for deleted mechanisms and keep the kept vocabulary.
- docs/how-it-works.md: remove paragraphs that still promise a deleted stage, queue or alert; keep the gate's pre-merge build check and the Hourly full check's hourly main watch as landed.
- tumwater.example.json: remove only the dead keys; preserve the kept capacity, tier, fallback, image-reroute and subscription-window settings.
- docs/invariants.md: drop or re-scope the invariants of deleted subsystems (merge-slot stages, the permit where its mechanism is gone, per-provider caps, subscription-window holds), keep the invariants of the tiers, budget fallback, image reroute and subscription usage-window display, and leave every remaining file/test binding naming an existing file and test.
- README.md and DEVELOPMENT.md: remove stale references to the deleted mechanisms; do not touch the brief block between the `tumwater:prompt` markers.

**Files touched.** docs/config.md docs/cli.md docs/glossary.md docs/how-it-works.md docs/invariants.md README.md DEVELOPMENT.md tumwater.example.json

**Acceptance criteria.**
- For every candidate name, the part's Done entry records the `grep` evidence: either no live `src/` reader remains and the name is absent from the swept docs and example, or a live reader remains and the name is still documented with that reader.
- `grep -rnE 'maxConcurrentPerProvider|mergeBatchMax|claudeWindowReserve|windowReserve|review\.afterMerge|held-for-operator|Needs replan|Waiting for the next failure' docs/ README.md DEVELOPMENT.md tumwater.example.json` prints nothing.
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` prints no claim about a mechanism the landed parts deleted.
- The kept mechanisms are still documented: the Settings concurrency controls, the tier and budget-fallback settings, the image reroute and the subscription usage-window display, plus any check-permit key `src/` still reads.
- docs/invariants.md keeps no binding to a deleted module and no binding whose named test file is gone; docs/config.md, docs/cli.md and the TUI-keys table agree with the live schema and command set.
- `npm run test:gate` passes.

**Tests.** Run test/config-doc.test.ts (docs/config.md against the live schema), test/cli-doc.test.ts and test/docs-commands.test.ts (command help/docs parity), test/tui-keys-doc.test.ts, test/docs-links.test.ts and test/invariants-doc.test.ts (file and test bindings), then the project's gate. If a kept key is dropped from the docs or a dead key stays, fix the table; do not weaken a doc check.

### Subtract, part 6b/6: The doctor rows, tests and counts the series left behind (planned 2026-11-02 by the plan role, splitting the 2026-10-26 too-large sweep part 6/6 after feature held it; sibling to Subtract part 6a/6, requires Subtract part 6a/6 landed so the surviving key and row set is fixed; touches src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md)

**Goal.** The doctor advertises only checks whose mechanism still exists, and the tests assert only surviving rows, events, artifacts and keys. This is the code-and-tests half of the old sweep; the live docs and example config are part 6a/6, whose surviving set this part follows. The part also records the series' before/after row and key counts and its measurement table.

**Approach.** All edits are the doctor row list and the tests that pin it; no production behavior changes.
- src/doctor/doctor-check-names.ts: delete the rows whose check function no longer exists after the series; do not re-point them at another mechanism. Keep every row whose check still reads a live path. Do not add a row.
- Re-check the parts 1a–1e/6 rule end to end: every condition that used to have a banner and now has no banner still has a doctor row, and every row names a mechanism that exists. Record any condition with neither a banner nor a row in the part's Done entry rather than inventing a row here.
- test/doctor-checks.test.ts: update its row list to exactly the surviving rows; delete cases whose only subject is a deleted row. test/event-format.test.ts: delete the cases for event types no live producer emits (including `check_wait` only when part 6a/6 found no live reader, and the merge-stage events the landed parts removed); keep the cases for surviving event families. test/retention.test.ts: delete the cases for artifacts no mechanism writes; keep the surviving ones. test/config.test.ts: update the key cases to the surviving key set part 6a/6 documented; do not delete a case for a key `src/config/config-schema.ts` still reads.
- In the part's PLANS-DONE entry, record the doctor row count and the config key count before this part and after it, and carry the measurement table from plans/subtract.md "Before deleting concurrency and model policy".

**Files touched.** src/doctor/doctor-check-names.ts test/doctor-checks.test.ts test/event-format.test.ts test/retention.test.ts test/config.test.ts PLANS.md

**Acceptance criteria.**
- Every row name in `doctor-check-names.ts` resolves to a check function that exists and reads a mechanism that still exists; no row reports a path nothing writes.
- The row list in test/doctor-checks.test.ts equals the surviving row set; no test asserts a deleted row, event type, artifact or config key, and the surviving cases stay.
- No production module outside `src/doctor/doctor-check-names.ts` changes; that edit only adds or removes row-name strings, and the diff names only the files listed above.
- The before/after doctor row and config key counts and the measurement table are in the part's PLANS-DONE entry.
- `npm run test:gate` passes.

**Tests.** Run test/doctor-checks.test.ts, test/doctor.test.ts, test/event-format.test.ts, test/retention.test.ts, test/config.test.ts and test/config-aliases.test.ts, then the project's gate. If a surviving row or key loses its case, restore it; do not weaken an assertion to make the gate pass.

### Every commit is verified on main, part 4j/3: the `main_red` run-result verdict is removed from the status, doctor, UI and report surfaces (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires Hourly full check part 1b/4 landed, so no merge produces the verdict (re-pointed 2026-11-01 by the operator from the withdrawn Subtract part 3b/7: the gate keeps its build check, and that part makes it decide every twice-failed check at once); touches src/merge/merge-core.ts src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/review/review.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts)

**Goal.** With Hourly full check part 1b/4 deciding every twice-failed gate check at once (and deleting `awaitingWatch`), the merge gate has no path that sets `mainRed`, so no merge produces a `main_red` run result. Remove the dead merge branch and the fields it read, then delete the surfaces that read or render the verdict. Leave the `RunResult` member and the recovered-pin plumbing for part 4k/3 to remove last, so this part can merge on its own without a compile-forced sweep of the run/runner plumbing.

**Approach.**
- Delete the now-unreachable producer: the `mainRed` and `awaitingWatch` fields and their comments in src/review/review.ts's `GateResult` (only `gateBuildPrecheck` set them), and src/merge/merge-core.ts's `if (gate.decision === "failed" && gate.mainRed)` branch that returns `result: "main_red"` (with its comment and the `awaitingWatch` spread). The plain `gate.decision === "failed"` branch stays.
- Remove the verdict from the display tables: `resultTone`'s `case "main_red"` and `"main_red"` in `PROBLEM_RESULTS` (src/ui/tone.ts), `main_red: "main's check is failing"` from `RUN_RESULT_LABELS` (src/events/event-labels.ts), `main_red: "red"` from the dashboard's `RESULT_TONES` (src/ui/gui/gui-client-model.ts), `main_red: 9` from `RESULT_ORDER` (src/failure/failure-render.ts), `"main_red"` from `CLUSTERED_RESULTS` (src/failure/failure-time-spend.ts), the `ev.result === "main_red"` clause (src/failure/failure-data.ts) and `"main_red"` from the start-summary list (src/cli/cli-start-summary.ts).
- Delete the status/doctor readers: `heldByMainRed` and `mainCheckRecovered` (src/status/status-polls.ts), the `main red` label branch and its import (`src/ui/status-model.ts`), and the held-code-role list inside `checkMainRed` (`src/doctor/doctor-holds.ts`). The unheld red-main warning (`redMainWarning`) and the `main_red_hold` event machinery stay.
- The `RunResult` member `main_red` (`src/run/run-outcome.ts`) stays, as do `runner-recovery.ts`'s recovered-pin producer, `merge-requeue.ts`'s `result === "main_red"` branch and the run/runner/review plumbing — part 4k/3 removes them.
- Refresh comments that name the verdict as a live status: `src/ui/status-model.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/runner/runner-state.ts`, `src/budget/fallback-breaker.ts`, `src/events/event-notify.ts`, `src/baseline/main-red.ts`.

**Files touched.** src/review/review.ts src/merge/merge-core.ts src/ui/tone.ts src/events/event-labels.ts src/ui/gui/gui-client-model.ts src/failure/failure-data.ts src/failure/failure-time-spend.ts src/failure/failure-render.ts src/cli/cli-start-summary.ts src/status/status-polls.ts src/ui/status-model.ts src/doctor/doctor-holds.ts src/inbox/pending-prompt.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/runner/runner-state.ts src/budget/fallback-breaker.ts src/events/event-notify.ts src/baseline/main-red.ts test/attribute-red-check.test.ts test/budget.test.ts test/doctor-holds.test.ts test/failure-render.test.ts test/failure-time-spend.test.ts test/gui-client.test.ts test/status-model.test.ts test/status-render-cells.test.ts test/status-render.test.ts test/team-alerts.test.ts test/merger.test.ts

**Acceptance criteria.**
- No status, doctor, UI, failure or CLI surface reads or renders the `main_red` verdict: `heldByMainRed` and `mainCheckRecovered` are gone, and `grep -rnE '\bmain_red\b' src/ui src/status src/doctor src/failure src/cli src/events src/inbox src/budget` finds no verdict reference (`main_red_hold` still matches nothing under `\bmain_red\b` and stays).
- The merge gate no longer returns `main_red`: `grep -rn 'result: "main_red"' src/merge` prints nothing, and `GateResult` declares neither `mainRed` nor `awaitingWatch`.
- The `RunResult` member `main_red` still exists (part 4k/3 removes it), so the tree compiles without the run/runner sweep.
- `npm run test:gate` passes.

**Tests.**
- test/doctor-holds.test.ts / test/status-model.test.ts / test/status-render.test.ts / test/status-render-cells.test.ts / test/team-alerts.test.ts: the held-by-main-red cases go; the unheld red-main warning cases stay.
- test/attribute-red-check.test.ts / test/budget.test.ts / test/failure-render.test.ts / test/failure-time-spend.test.ts / test/gui-client.test.ts: the `main_red` rows/labels/tone cases go; the surviving result cases stay.
- test/merger.test.ts: the `verifyAndMerge` `main_red` case goes; the surviving merge cases stay.

### Every commit is verified on main, part 4k/3: the `main_red` union member and the run/runner plumbing that names it are removed (planned 2026-10-29 by the plan role, split from the too-large part 3f/3; requires part 4j/3 landed, so no merge produces the verdict and no surface reads it; touches src/run/run-outcome.ts src/runner/runner-recovery.ts src/merge/merge-requeue.ts src/runner/runner-leftover.ts src/runner/runner-state-load.ts src/runner/runner-run.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/runner-leftover.test.ts test/merge-requeue.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts)

**Goal.** The `main_red` run result no longer has a producer (Hourly full check part 1b/4 removed the gate's `mainRed` path, whose dead branch part 4j/3 deletes; the recovered-pin return removed here is the last one) or a reader (part 4j/3), so the union member itself is dead vocabulary. Remove it and let the compiler name any site still constructing or narrowing it.

**Approach.**
- Remove `| "main_red"` and its doc comment from `RunResult` (src/run/run-outcome.ts). Deleting the member makes every remaining construction or `result === "main_red"` narrowing a compile error, which is the work list.
- Remove the last producer: `runner-recovery.ts`'s recovered-`main_red` return, with the `main_red_wait` result in src/runner/runner-leftover.ts and the `mainRedRetry` record in src/merge/merge-requeue.ts, src/runner/runner-state.ts and src/runner/runner-state-load.ts that feed it. With merge-requeue.ts's `result === "main_red"` branch gone, nothing sets the record any more, so the pin's wait/recovery path, its state key, the orchestrator poll's `requeueMainRedPin` call and the leftover's `mainRedWait` return go with it; keep the stale/dangling pin cleanup and conflict hand-back. Fix any surviving switch/type-narrowing the compiler flags (run-apply, run-finalize and the run prompt), keeping each site's non-`main_red` behavior.
- Refresh the comments that still name the verdict as a live outcome in `src/runner/runner-state.ts`, `src/runner/runner-recovery.ts`, `src/run/run-finalize.ts`, `src/run/run-prompt.ts`, `src/orchestrator/orchestrator-poll.ts`, `src/events/event-notify.ts`, `src/inbox/pending-prompt.ts`, `src/review/review.ts`, `src/merge/merge-verify.ts`, `src/merge/merge-queue.ts`, `src/budget/fallback-breaker.ts` and `src/baseline/main-red.ts`.

**Files touched.** src/run/run-outcome.ts src/runner/runner-recovery.ts src/merge/merge-requeue.ts src/runner/runner-leftover.ts src/runner/runner-state-load.ts src/runner/runner-run.ts src/run/run-apply.ts src/run/run-finalize.ts src/run/run-prompt.ts src/orchestrator/orchestrator-poll.ts src/runner/runner-state.ts src/events/event-notify.ts src/inbox/pending-prompt.ts src/review/review.ts src/merge/merge-verify.ts src/merge/merge-queue.ts src/budget/fallback-breaker.ts src/baseline/main-red.ts test/run-outcome.test.ts test/run-apply.test.ts test/run-finalize.test.ts test/runner-recovery.test.ts test/runner-red-main.test.ts test/runner-leftover.test.ts test/merge-requeue.test.ts test/merge-pipeline-2.test.ts test/merger.test.ts

**Acceptance criteria.**
- `RunResult` has no `main_red` member, and `grep -rnE '\bmain_red\b' src/` prints nothing (the `main_red_hold` event and its machinery stay; `\bmain_red\b` does not match `main_red_hold`).
- No code path returns or narrows on a `main_red` run result; the compiler is clean.
- `npm run test:gate` passes.

**Tests.**
- test/run-outcome.test.ts: the `main_red` membership case goes; the surviving `RunResult` cases stay.
- test/runner-recovery.test.ts / test/runner-red-main.test.ts: the recovered-`main_red` cases go; the surviving recovery cases stay.
- test/run-apply.test.ts / test/run-finalize.test.ts / test/merge-pipeline-2.test.ts / test/merger.test.ts: drop the `main_red` assertions; the surviving cases stay.

_None yet._

### Subtract, part 3c/7: The queue's verify stage collapses into the merge step (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Hourly full check part 1b/4 landed (re-pointed 2026-11-01 by the operator: Subtract part 3b/7 is withdrawn, since the user keeps the gate's build check, so the merge step carries that check); touches src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts)

**Goal.** A queued entry goes straight from the queue to the merge step: no separate verify task, no `approved`/`verifying` map, no stage events. `drainMerge` takes the head entry, runs the gate in the merge worktree — the deterministic diff rules and the gate's build check (`gateBuildPrecheck`, the declared gate command; user, 2026-11-01: "it should gate each commit") — and calls `mergeApprovedChange`; a rejected entry is settled as today. The durable queue still orders entries and the pin still carries the commit.

**Approach.**
- Delete src/merge/merge-verify.ts and src/merge/merge-batch.ts; move the tier constants still needed by merge-drain/merge-post-review-drain (`MERGE_TIER`, `resolveAuthor`) beside the drain.
- In merge-core.ts, keep `reviewPinnedChange`'s gate (the diff rules and `gateBuildPrecheck`) as a small `reviewQueuedChange(ctx, req, wt, state)` without the approval/stage bookkeeping; call it from `mergeApprovedChangeIn` before `mergeToMain`, outside the merge lock. A rejected result deletes the pin and returns `rejected`; an approval proceeds to the merge.
- In merge-drain.ts, delete `drainMergeQueue`'s `drainVerify` leg and the `p.approved`/`p.verifying` handling; `drainMerge` starts the next queued entry directly. In merge-pipeline.ts, remove `verifying`/`approved` and their types; keep `InFlightMerge`, abort, guard and outcome plumbing. In merge-slot.ts, remove the verify stage records and `checkWaitStage`/`resolveWaitStage` hooks, keeping the merge in-flight marker the operator surfaces read.
- Keep `drainPostReviews` and the post-merge review path untouched.
- docs/how-it-works.md's Parallel approval and Merge sections describe the one-step drain; docs/invariants.md re-points the verify-stage bindings to the merge step.

**Files touched.** src/merge/merge-drain.ts src/merge/merge-verify.ts src/merge/merge-batch.ts src/merge/merge-pipeline.ts src/merge/merge-core.ts src/merge/merge-slot.ts docs/how-it-works.md docs/invariants.md test/merge-drain.test.ts test/merge-drain-verify.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/merge-pipeline-seams.test.ts test/merger.test.ts test/fixtures/orchestrator-fixtures.ts test/fixtures/merger-fixtures.ts

**Acceptance criteria.**
- One queued entry produces `merge_queued → merged` with no verify-start/approved stage event; a merge is a rebase and a fast-forward through `mergeApprovedChange`.
- A queued diff that edits the brief block, PRINCIPLES.md or a credential, or whose gate check fails for a test of its own, is rejected before it merges; every other queued diff merges without a second review.
- `grep -rn 'drainVerify\|startVerify\|verifyRequest\|MERGE_TIER\|VERIFY_TIER' src/merge` prints only the moved constants if any, never a verify stage.
- test/merge-drain-verify.test.ts is deleted with its subject; the surviving merge-drain/pipeline tests assert the one-step drain.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-drain-verify.test.ts. Update test/merge-drain.test.ts, test/merge-pipeline.test.ts, test/merge-pipeline-2.test.ts, test/merge-pipeline-seams.test.ts and test/merger.test.ts to drive an entry from queue to merge without the verify/approved map; update the fixtures' `mergeHead` to the same path. Run those files and the gate.

### Subtract, part 3d/7: `tumwater queue`, its cancel/top keys and the browser queue controls go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3c/7 landed; touches src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts)

**Goal.** The operator stops steering a queue that becomes a lock and a fast-forward: delete the `tumwater queue` command, its `--cancel` and `--top` flags, the GUI Merge queue card's Cancel/Move-to-top handlers, the TUI pending pane's queue rows and keys, and the three modules that implement cancel/top/queue rendering. The queue reader itself stays for status, doctor and the CLI surfaces this part does not own until part 3f.

**Approach.**
- Delete src/merge/merge-cancel.ts, src/merge/merge-top.ts and src/merge/merge-queue-render.ts; remove `cmdQueue`, `cmdQueueCancel`, `cmdQueueTop` and the queue view from src/cli/cli-query-commands.ts and their command/help/completion entries.
- Remove `handleQueueCancel`/`handleQueueTop` and their `/api/queue-cancel`/`/api/queue-top` routes from src/gui/gui-operator-commands.ts and gui-server.ts; delete the dashboard Merge queue card's Cancel/Move-to-top controls.
- Remove the merge-queue rows, labels and Ctrl keys from tui-pane-pending.ts, tui-pane-pending-selection.ts and tui-pane-transcript.ts; keep the post-merge-review rows, which are a separate mechanism.
- docs/cli.md drops `queue`, `queue --cancel` and `queue --top`; no other docs change here.

**Files touched.** src/cli/cli-query-commands.ts src/gui/gui-operator-commands.ts src/gui/gui-server.ts src/ui/tui/tui-pane-pending.ts src/ui/tui/tui-pane-pending-selection.ts src/ui/tui/tui-pane-transcript.ts src/merge/merge-cancel.ts src/merge/merge-top.ts src/merge/merge-queue-render.ts docs/cli.md test/cli-queue.test.ts test/cli-queue-follow.test.ts test/gui-queue-cancel.test.ts test/gui-queue-top.test.ts test/merge-cancel.test.ts test/merge-top.test.ts test/tui-pane-pending.test.ts test/tui-operator-keys.test.ts

**Acceptance criteria.**
- `tumwater queue` and its `--cancel`/`--top` flags are gone from the parser, help, completion and docs; `grep -rn 'moveQueuedMergeToTop\|cancelQueuedMerge\|renderMergeQueue' src/` prints nothing.
- Neither dashboard nor TUI offers a queue cancel/top control, and no TUI key binds one.
- The queue reader (`readMergeQueue`), the post-merge-review views and the doctor/status queue reads still work.
- `npm run test:gate` passes.

**Tests.** Delete test/cli-queue.test.ts, test/cli-queue-follow.test.ts, test/gui-queue-cancel.test.ts, test/gui-queue-top.test.ts, test/merge-cancel.test.ts and test/merge-top.test.ts with their subjects; trim test/tui-pane-pending.test.ts and test/tui-operator-keys.test.ts to the surviving post-review rows and keys. Run the surviving touched files and the gate.

### Subtract, part 3e/7: A run's merge pin is merged directly, without a queue entry (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3d/7 landed; touches src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts)

**Goal.** New work stops writing a durable queue entry: a run pins its commit by `refs/tumwater/landing/<role>` and the orchestrator merges that pin on a poll. The queue reader still drains files an older build left, so the two paths coexist until part 3f deletes the queue.

**Approach.**
- In run-stage.ts, replace the `enqueueMerge` block with the pin only: after `pinAndReset`, log `merge_queued` with the commit and summary and end the run `queued` exactly as today; `heldOnBranch` still checks an existing pin. Remove the queue-entry construction from the fresh path; keep the revision trailer on the commit so a recovered pin still carries its round.
- In runner-leftover.ts, replace the `enqueueMerge` call with the same pin-only return (`{ kind: "pinned", sha, summary }`): adopt an unpinned branch tip into the merge ref as today, but write no queue file. Keep stale/dangling pin cleanup, the conflict hand-back and `MERGE_CONFLICT_LIMIT`.
- Add the pin merge to orchestrator-poll.ts: for each runner with `hasUnmergedPin` and no in-flight merge, read `recoveredMetadata` for the pinned sha and call the merge path (`mergeApprovedChange`) under the existing merge lock; a merged pin is deleted, a conflicting pin is kept for the existing leftover/conflict hand-back path, and a pin main already contains is dropped.
- docs/how-it-works.md's Merge section says a pin is the waiting state; the durable queue is legacy input only.

**Files touched.** src/run/run-stage.ts src/runner/runner-leftover.ts src/orchestrator/orchestrator-poll.ts src/merge/merge-core.ts docs/how-it-works.md test/run-stage.test.ts test/runner-leftover.test.ts test/orchestrator-merge-pin.test.ts

**Acceptance criteria.**
- A fresh run that commits writes a pin and no `.tumwater/merge-queue/` file; its log path is still `merge_queued → merged` and its change reaches main after its one gate check, with no second check.
- A pin left by a crash or an earlier build is merged on the next poll; a pin whose commit main already contains is deleted without merging.
- A conflicting pin is kept once and hands back to its author at `MERGE_CONFLICT_LIMIT`, not retried forever.
- Old queue files still drain through the pre-3e path until part 3f removes it.
- `npm run test:gate` passes.

**Tests.** New test/orchestrator-merge-pin.test.ts: a pin is merged on a poll, a stale pin is dropped, a conflict keeps the pin and records the streak. test/run-stage.test.ts: a committed run pins and enqueues nothing. test/runner-leftover.test.ts: recovery adopts a tip into the pin and writes no queue file. Run those files and the gate.

### Subtract, part 3f/7: The durable merge queue and its status/doctor readers go (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3e/7 landed; touches src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts)

**Goal.** With part 3e writing no queue file, the queue, its pipeline, slot and requeue modules are dead state. Delete them and re-point every reader at the pin/in-flight marker: status shows a role's waiting pin, the doctor drops the two merge-queue rows, and `once --once` waits on no in-flight merge instead of an empty queue directory.

**Approach.**
- Delete src/merge/merge-queue.ts, merge-drain.ts, merge-pipeline.ts, merge-slot.ts and merge-requeue.ts; move the one in-flight marker type/reader the new pin path and post-review drain still need into a small module beside merge-core.ts, and delete `.tumwater/merge-queue/` handling (`mergeQueueDir`, `legacyLandQueueDir`, the startup migration step) from src/paths.ts and startup-migration-steps.ts.
- status-data.ts's `readMergeQueue` block and `queuedRoles` become the pin/in-flight set; status-roles.ts and status-polls.ts read that set. Delete the queue header badge, the queue depth and the per-role queued row that name a now-nonexistent directory.
- doctor-backlog.ts loses `checkStaleQueuedMerges` and `checkMergeQueueFiles`; doctor-check-names.ts drops `stale merge-queue entries` and `merge-queue files`; doctor-holds.ts reads the in-flight/pin set instead of the queue.
- gate-polls.ts and scheduling/once-round.ts read the in-flight/pin state for their `queued` counts instead of `queuedMergeRoles`/`queuedMerges`; once-round's `queuedMerges: number` becomes the pin count.
- events/event-notify.ts drops notifications that name queue files (`unreadable queue files`, `merge-queue file`), keeping `merge_queued`/`merged`.
- docs/how-it-works.md removes the queue directory, stages and queue doctor rows, describing pins and the in-flight marker instead.

**Files touched.** src/merge/merge-queue.ts src/merge/merge-drain.ts src/merge/merge-pipeline.ts src/merge/merge-slot.ts src/merge/merge-requeue.ts src/status/status-data.ts src/status/status-roles.ts src/status/status-polls.ts src/doctor/doctor-backlog.ts src/doctor/doctor-check-names.ts src/doctor/doctor-holds.ts src/gates/gate-polls.ts src/scheduling/once-round.ts src/events/event-notify.ts src/paths.ts src/orchestrator/startup-migration-steps.ts docs/how-it-works.md test/merge-queue.test.ts test/merge-requeue.test.ts test/merge-slot.test.ts test/merge-pipeline.test.ts test/merge-pipeline-2.test.ts test/doctor-checks.test.ts test/status-data.test.ts test/status-roles.test.ts test/once-round.test.ts

**Acceptance criteria.**
- `grep -rn 'merge-queue\|mergeQueue\|queuedMerges\|readMergeQueue\|mergeQueueDir' src/` finds no live queue path; `docs/how-it-works.md` names no queue directory or stage.
- `tumwater status` shows each waiting role's pin and in-flight merge; the doctor's `stale merge-queue entries` and `merge-queue files` rows are gone rather than warning about a path nothing writes.
- `once --once` treats a waiting pin as unsettled work and exits only after its merge settles, the same way it treated a non-empty queue.
- No module imports a deleted merge-queue/merge-drain/merge-slot/merge-requeue file; the compiler is clean.
- `npm run test:gate` passes.

**Tests.** Delete test/merge-queue.test.ts, test/merge-requeue.test.ts, test/merge-slot.test.ts and the queue-specific cases in test/merge-pipeline*.test.ts; update test/status-data.test.ts, test/status-roles.test.ts, test/doctor-checks.test.ts and test/once-round.test.ts to pins/in-flight. Run those files and the gate.

### Subtract, part 3g/7: Docs and invariants say one lock, linear history and a post-landing check (planned 2026-10-31 by the plan role, splitting the 2026-10-30 too-large part 3/6; requires Subtract part 3f/7 landed; touches docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts)

**Goal.** The live prose and the invariant bindings describe the landing that exists after parts 3a–3f: a pin, a rebase under the merge lock, a fast-forward, and the main watch's post-landing full check. No sentence promises queue stages or an approval step; the pre-merge gate keeps its build check (user, 2026-11-01), so the docs keep saying so.

**Approach.**
- Sweep the queue vocabulary out of docs/how-it-works.md, docs/invariants.md and docs/glossary.md: merge queue, queue stage, verify/approval stage, batch/bisect (already gone), retry/requeue, queue depth and queue cancel/top.
- In docs/invariants.md, drop or re-scope every binding to a deleted module (`merge-queue`, `merge-verify`, `merge-batch`, `merge-slot` stages, `merge-requeue`) and state the surviving guarantees: one merge writer under one lock, linear history, a deleted pin on merge and the main watch's post-landing checks as docs/how-it-works.md states their cadence at the time (amended 2026-11-01 by the operator: the pre-merge gate keeps its build check, and the Hourly full check series moves main's full check to at most hourly on the latest tip, so this part must not restate "a full check per commit"). Keep the conflict-hand-back and review-gate bindings that still have code.
- README's status line stays as is; remove any queue wording elsewhere in README.
- Re-check docs/invariants.md's file-to-test bindings: every remaining binding names a file and a test that still exist; the invariants-doc test enforces it.

**Files touched.** docs/how-it-works.md docs/invariants.md docs/glossary.md README.md test/invariants-doc.test.ts test/merge-backlog-conflicts.test.ts

**Acceptance criteria.**
- `grep -rniE 'merge queue|queue stage|verify stage|approval stage|requeue|queue depth' docs/ README.md` finds no claim about a mechanism parts 3a–3f deleted (the archive files PLANS-DONE.md and BUGS-FIXED.md are excluded by construction).
- Every docs/invariants.md binding that names a merge module names a file and a test that still exist; deleted-module INVs are gone, not re-pointed.
- The surviving prose says: a change is pinned, gated (the diff rules and the declared gate command), merged by rebase and fast-forward under the merge lock, and covered on main by the main watch's full check.
- `npm run test:gate` passes.

**Tests.** Run test/invariants-doc.test.ts and test/merge-backlog-conflicts.test.ts whole, then the project's gate, and confirm green.

### `tumwater reviews` gains `-f/--follow`, repainting the post-merge review queue every couple of seconds until Ctrl+C or its parent exits — the `tumwater queue -f` twin (planned 2026-11-02 by the plan role; independent in files of every `## Planned` entry — before this entry `grep -c 'cli-review-commands\|cli-flag-specs\|cli-reviews' PLANS.md` prints 0, and no waiting heading or touches list names src/cli/help.ts or docs/cli.md's `tumwater reviews` clause; PLANS-DONE.md records behavior additions to `cmdReviews` (`--role`, `--status`, `--accept`, the waiting age and the forwarded follow-up wording) but no live view (`grep -n 'reviews -f\|reviews --follow' PLANS-DONE.md` prints nothing); docs/invariants.md names no symbol of the command (`grep -c 'cmdReviews' docs/invariants.md` prints 0), so it stays unchanged; touches src/cli/cli-review-commands.ts src/cli/help.ts src/cli/cli-flag-specs.ts docs/cli.md test/cli-reviews.test.ts test/cli-reviews-follow.test.ts)

**Goal.** `tumwater reviews` is the post-merge review queue's read-only command and the twin of `tumwater queue`, whose `-f/--follow` repaints until Ctrl+C or the process that started it exits. `reviews` has no live form: an operator watching the queue drain, or a failing entry's age grow toward `POST_REVIEW_FAILURE_LIMIT`, must rerun it by hand, while `status`, `logs`, `queue`, `backlog`, `report`, `diff` and `history` all follow. Add the same follow to `reviews`, reusing the existing follow machinery, without changing the one-shot output, `--json`, `--role`/`--status` scoping or `--accept`.

**Approach.** No new dependency and no new renderer: `followView` already owns the fixed repaint cadence, the TTY clear-screen vs non-TTY blank-line shape, terminal-control stripping and the parent-death watch.
- src/cli/cli-review-commands.ts: give `cmdReviews` the optional `seams: FollowViewSeams = {}` parameter `cmdQueue` has, importing `followView`/`FollowViewSeams` from ./follow-view.js and `FOLLOW_FLAG`/`hasFollowFlag` from ./cli-flag-specs.js. Add `FOLLOW_FLAG` to its `rejectUnknownArgs("reviews", …)` list. Keep the `--accept` early routing first, so `cmdReviewsAccept`'s own flag gate is unchanged.
- After the `--role`/`--status` parsing, compute `const follow = hasFollowFlag(args);` and refuse the conflict with `reviews --json prints one document; -f/--follow repaints a live view — drop one of them`, the `cmdQueue` wording. Factor the current `readPostReviews` + scope + `renderPostReviews(..., Date.now())` path into one local `renderFrame(): string` used by both branches, so every repaint re-reads the queue file and reads the clock once for the ages; when `follow`, `await followView(renderFrame, seams)` and return, otherwise keep the existing `sayJsonOrRender(args, { pending: entries }, renderFrame)` result byte-identical.
- src/cli/help.ts: the `tumwater reviews` usage line gains `[-f/--follow]`, and its description gains the sentence that `-f/--follow` repaints the queue every couple of seconds until Ctrl+C or the process that started it exits (a backgrounded follow does not outlive its parent), and that it refuses `--json`.
- src/cli/cli-flag-specs.ts: add `reviews` to `FOLLOW_FLAG`'s and `hasFollowFlag`'s comment lists of follow-capable commands, so the shared spelling's documentation is current.
- docs/cli.md: the `tumwater reviews` row gains `[-f/--follow]` beside its other flags and a follow clause naming the parent-death rule and the `--json` refusal, matching the neighbouring `tumwater queue` row.

**Files touched.** src/cli/cli-review-commands.ts src/cli/help.ts src/cli/cli-flag-specs.ts docs/cli.md test/cli-reviews.test.ts test/cli-reviews-follow.test.ts

**Acceptance criteria.**
- `tumwater reviews -f` paints the same entries, positions, ages and scope text as the one-shot command, then repaints on the shared cadence until its parent exits; a non-TTY frame has no clear-screen and frames are blank-line separated, while a TTY frame begins `\x1b[H\x1b[2J` (both supplied by `followView`).
- `-f` composes with `--role` and `--status` exactly as the read does: `reviews -f --role clean` and `reviews -f --status rejected` keep the same entries and whole-queue positions the one-shot forms print.
- `reviews -f --json` fails with the drop-one message, and `reviews --accept <n>` keeps its current flag gate (`-f` is still refused there as an unknown flag).
- The one-shot `reviews`, `reviews --json`, `reviews --role` and `reviews --status` output is unchanged; the read introduces no ready-repo gate and no new dependency.
- `tumwater help` shows the flag on the reviews usage line, and the help-derived completion offers `-f` and `--follow` for `reviews`.
- `npm run test:gate` passes.

**Tests.**
- Add test/cli-reviews-follow.test.ts modeled on test/cli-queue-follow.test.ts: seed `postReviewPath` with two entries and run `cmdReviews` in-process with mocked `setInterval`, asserting the first frame, two repaints, resolution when the parent flips away, and no output after it ends. Cover `--role clean` and `--status rejected` scoping, the TTY clear-screen shape, and the `["-f", "--json"]` rejection through the seams.
- Add one case to test/cli-reviews.test.ts that `reviews --accept 1 -f` still exits non-zero naming the unknown flag, pinning that the destructive branch is untouched.
- Update test/completion.test.ts to assert the `reviews` command's offered flags include both follow spellings, and run test/help.test.ts.
- Run the new follow file, test/cli-reviews.test.ts, test/completion.test.ts and test/help.test.ts, then the project's gate, and confirm green.

### `tumwater quarantine` gains `-f/--follow`, repainting the flake quarantine every couple of seconds until Ctrl+C or its parent exits (planned 2026-11-02 by the plan role; independent in behavior of every `## Planned` entry — no entry's heading or Files-touched list names `cmdQuarantine` or src/review/quarantine-render.ts; the blocked Subtract part 3d/7 shares src/cli/cli-query-commands.ts and docs/cli.md but deletes `cmdQueue` and the queue row in a different command body and table row, so whichever lands second rebases there, and the planned `tumwater reviews` follow shares only the help usage list, cli-flag-specs.ts's command comments and docs/cli.md's reviews row, each a distinct line; PLANS-DONE.md records the quarantine list, its `--release` twin and the dashboard release button, but `grep -n 'quarantine -f\|quarantine --follow' PLANS-DONE.md` prints nothing — no live view; docs/invariants.md names no symbol of the command (`grep -c 'cmdQuarantine' docs/invariants.md` prints 0), so it stays unchanged; touches src/cli/cli-query-commands.ts src/cli/help.ts src/cli/cli-flag-specs.ts docs/cli.md test/cli-quarantine.test.ts test/cli-quarantine-follow.test.ts)

**Goal.** `tumwater quarantine` is the read-only view of the review gate's flake quarantine: the tests that failed then passed on the same tree, each with its first-seen/last-seen ages, flake count and filed bug, plus the shared `quarantineWarning` phrase when the list is old or large. It has no live form, so an operator watching entries appear, age toward the ceiling or leave when their bug closes must rerun the command by hand, while `status`, `logs`, `queue`, `backlog`, `report`, `diff` and `history` all follow. Add the same `-f/--follow` to `quarantine`, reusing `followView`, without changing the one-shot list, `--json`, or the destructive `--release <n>` branch.

**Approach.** No new dependency and no new renderer: `followView` already owns the fixed cadence, the TTY clear-screen vs non-TTY blank-line shape, terminal-control stripping and the parent-death watch, and src/cli/cli-query-commands.ts already imports `followView`, `FollowViewSeams`, `FOLLOW_FLAG` and `hasFollowFlag` for its other commands.
- src/cli/cli-query-commands.ts, `cmdQuarantine`: give it the optional `seams: FollowViewSeams = {}` parameter `cmdQueue` and `cmdStatus` have. Keep the `--release` early routing first, so `cmdQuarantineRelease` and its own flag gate stay untouched (a `-f` beside `--release` is still refused there as an unknown flag). Widen the read gate to `rejectUnknownArgs("quarantine", args, [JSON_FLAG, FOLLOW_FLAG])`.
- Compute `const follow = hasFollowFlag(args);` and refuse the conflict with `quarantine --json prints one document; -f/--follow repaints a live view — drop one of them`. When `follow`, `await followView(() => renderQuarantine(quarantineRows(loadQuarantine(root)), Date.now()), seams)` and return: every frame re-reads quarantine.json and reads the clock once for the ages and the warning. Otherwise keep the existing `const rows = quarantineRows(loadQuarantine(root)); sayJsonOrRender(args, { tests: rows }, () => renderQuarantine(rows, Date.now()));` path byte-identical.
- src/cli/help.ts: the `tumwater quarantine` usage line gains `[-f/--follow]`, and its description gains the sentence that `-f/--follow` repaints the list every couple of seconds until Ctrl+C or the process that started it exits (a backgrounded follow does not outlive its parent), and that it refuses `--json`.
- src/cli/cli-flag-specs.ts: add `quarantine` to `FOLLOW_FLAG`'s and `hasFollowFlag`'s comment lists of follow-capable commands, so the shared spelling's documentation is current.
- docs/cli.md: the `tumwater quarantine` row gains `[-f/--follow]` beside its other flags and a follow clause naming the parent-death rule and the `--json` refusal, matching the neighbouring `tumwater reviews`/`tumwater backlog` rows.

**Files touched.** src/cli/cli-query-commands.ts src/cli/help.ts src/cli/cli-flag-specs.ts docs/cli.md test/cli-quarantine.test.ts test/cli-quarantine-follow.test.ts

**Acceptance criteria.**
- `tumwater quarantine -f` paints the same header, warning and positioned rows as the one-shot command, then repaints on the shared cadence until its parent exits; a quarantine file changed between frames shows the new rows and ages in the next frame, and no output follows the follow's resolution. A non-TTY frame has no clear-screen and frames are blank-line separated, while a TTY frame begins `\x1b[H\x1b[2J` (both supplied by `followView`).
- `quarantine -f --json` fails with the drop-one message before any frame; `quarantine --release <n>` keeps its current flag gate (`-f` is still refused there as an unknown flag).
- The one-shot `quarantine`, `quarantine --json` and `quarantine --release <n>` output and file behavior are unchanged; the read still has no ready-repo gate and writes no file.
- `tumwater help` shows the flag on the quarantine usage line, and the help-derived completion offers both `-f` and `--follow` for `quarantine`.
- `npm run test:gate` passes.

**Tests.**
- Add test/cli-quarantine-follow.test.ts driving `cmdQuarantine` in-process with the parent-death and interval seams, like test/cli-queue-follow.test.ts, but mock only `setInterval` with `t.mock.timers.enable({ apis: ["setInterval"] })` and `t.mock.timers.tick(...)` for the repaints (the deterministic pattern test/cli-log-commands.test.ts uses for `logs -f`), so no wall-clock budget can flake. Seed `quarantinePath` with two entries; assert the first frame's header and rows, at least two repainted frames, a rewrite of quarantine.json between ticks appearing in the next frame, resolution when the parent seam flips to PID 1, and no output after it ends. Cover the TTY clear-screen shape and the `["-f", "--json"]` refusal through the same seams.
- Add one case to test/cli-quarantine.test.ts that `quarantine --release 1 -f` still exits non-zero naming `-f` as the unknown flag, pinning that the destructive branch is untouched.
- Update test/completion.test.ts to assert the `quarantine` command's offered flags include both follow spellings; run test/help.test.ts and test/quarantine-render.test.ts.
- Run the new follow file, test/cli-quarantine.test.ts, test/quarantine-render.test.ts, test/completion.test.ts and test/help.test.ts, then the project's gate, and confirm green.

### `runEventMessage`'s complexity-21 run-family line builder in src/events/event-format.ts is split into one named module-private builder per line concern — run start, run end, resume, counters reset and claim — so "what does a run's feed line carry, and why is a resume's cause spelled out?" is read from named builders instead of one switch body (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-11-02 `mergeEventMessage` split left this sibling family builder as the file's largest remaining body at complexity 21, and the 2026-10-30 `eventMessage` family-table plan made every family one builder; independent in file of every `## Planned` entry — before this entry `grep -c 'src/events/event-format.ts' PLANS.md` and `grep -c 'runEventMessage' PLANS.md` both print 0, the only event-format mention being Subtract part 6b/6's test/event-format.test.ts case deletions, which never edit the source module, and no heading or touches list names `runEventMessage` or `resumeEventMessage`; PLANS-DONE.md's 2026-11-02 event-format entry splits `mergeEventMessage`, and `grep -cE '^### .*runEventMessage' PLANS-DONE.md` prints 0; docs/invariants.md binds this module only through `eventFeedItem`/`eventMatchesGrep` (INV-A3), the `issue_filed` line and the `image_reroute` lines, never this dispatcher body, so no invariant edit is needed; touches src/events/event-format.ts)

**Goal.** `eventMessage` routes each event type through `EVENT_MESSAGE_FAMILY` to a family builder. `runEventMessage` is the run-family builder: one switch over nine run/role-control event types whose readability is buried under the nested `run_end` payload ternary and the six-cause `resume` ternary. eslint's complexity one-shot reports it at 21. Extract one named module-private builder per line concern, leaving a flat dispatch, with no wording or field-read change.

**Approach.** All edits in src/events/event-format.ts; no export changes and no new import.
- `function runStartMessage(e: HarnessEvent): string` holds the current `run_start` return verbatim: `run #<n> started` plus ` on <model>` only when `e.model !== undefined`.
- `function runEndMessage(e: HarnessEvent): string` holds the current `run_end` block verbatim: the `summary`/`error` extra clause and its comment, then `run #<n> <outcome><extra><usagePhrase(e)>`.
- `function resumeEventMessage(e: HarnessEvent): string` holds the current `resume` block verbatim: the `restored` suffix and the six-cause nested ternary (`cut-off`, `handoff`, `image-reroute`, `salvaged`, `model-check`, else shutdown), with its comment.
- `function countersResetMessage(e: HarnessEvent): string` holds the current `counters_reset` block verbatim: `rolesPhrase`, the `scope` ternary, and the `counters reset<scope> (runs, merges, tokens, cost)` line.
- `function claimEventMessage(e: HarnessEvent): string` holds the current `claim` block verbatim: the `released "<title>" (<reason>)` branch, the `assigned "<title>"` branch, and its comment.
- `runEventMessage` keeps its signature and switch; `run_deferred`, `run_aborted`, `wake`, `permit_reserve` and `default` stay inline verbatim, and each of the five moved cases returns its builder. Every arm stays in today's order.

**Files touched.** src/events/event-format.ts

**Acceptance criteria.**
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/events/event-format.ts` reports `runEventMessage` at 10 or below (it reports 21 today; 10 is this switch's floor — base 1 plus the nine case clauses — with all nine arms kept), and no moved helper above 8.
- `grep -nE '^(export )?function (runStartMessage|runEndMessage|resumeEventMessage|countersResetMessage|claimEventMessage)' src/events/event-format.ts` matches all five, and none carries `export` (all module-private).
- Rendering is byte-identical: test/event-format.test.ts passes unedited, including "formatEvent renders run_start's model after the run number, and omits it when absent", the `run_end` per-run usage and summary/error cases, "formatEvent renders the resume event" and "formatEvent renders the image-reroute resume cause as a fresh-session handoff", "formatEvent renders counters_reset plainly, naming all roles when several are affected", and "formatEvent renders claim assignment and release lines".
- No edit lands outside src/events/event-format.ts; docs/invariants.md is unchanged because its event-format bindings (`eventFeedItem`, `eventMatchesGrep`, the `issue_filed` line and the image-reroute lines) are neither moved nor reworded.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving and test/event-format.test.ts drives every moved arm through `formatEvent`. Run test/event-format.test.ts whole, then the project's gate, and confirm green. If a line changes, a field read or a moved string is wrong; fix the move, do not change a test to make it pass.

### `publishBudgetWiring`'s complexity-19 publish-and-switch body in src/budget/budget-wiring.ts is split into two named module-private collectors — `budgetDemotions` for the breaker map and engaged demotion, and `budgetChainChanges` for the per-tier switch event — so "which pairs are demoted?" and "which tiers changed pair or step?" are read from names instead of from one body (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-10-25 `applyBudgetGateWiring` split extracted `publishBudgetWiring` as one phase helper and deliberately left its own body whole (PLANS-DONE.md's `publishBudgetWiring` bullet describes it as "builds `demotions` … then builds `switched`"), so this entry splits that leftover body; independent in file of every `## Planned` entry — before this entry `grep -cE 'publishBudgetWiring|budget-wiring' PLANS.md` prints 0, so no waiting heading or touches list names src/budget/budget-wiring.ts, and the blocked `Hourly full check`, `Subtract` and `Every commit is verified on main` parts touch src/budget/fallback-breaker.ts or other modules but never this file; PLANS-DONE.md records the 2026-10-25 `applyBudgetGateWiring` split that created `publishBudgetWiring`, and `grep -cE '^### .*publishBudgetWiring' PLANS-DONE.md` prints 0, so no finished plan splits this body; `grep -c 'budget-wiring' docs/invariants.md` prints 0, so no invariant edit is needed; touches src/budget/budget-wiring.ts)

**Goal.** `publishBudgetWiring` (src/budget/budget-wiring.ts) publishes the budget gate's derived state once per poll: it folds every breaker into the `fallbackDemotions` map, picks the engaged pair's `fallbackDemoted`, publishes the spend/cap pair and the chain, then compares this poll's chain with `budget.prevChain` per tier to log one `fallback_switched` event and store the new chain. eslint's complexity one-shot reports the body at 19, and the two loop-and-branch blocks bury the publish itself. Extract one named module-private collector per block so `publishBudgetWiring` reads as collect, publish, log, store, with no wording or field-read change.

**Approach.** All edits in src/budget/budget-wiring.ts; move the code, do not rewrite it, and move the `// One fallback_switched per poll …` comment with the switch collector. No import is added or removed (`fallbackDemotion` and `MODEL_TIERS` are already imported and stay used).
- `function budgetDemotions(breakers: BudgetGateState["breakers"]): Record<string, FallbackDemotion>` holds the current `const demotions: Record<string, FallbackDemotion> = {};` loop verbatim: `for (const [name, b] of Object.entries(breakers))`, `const d = fallbackDemotion(b)`, and `if (d) demotions[name] = d`, then returns `demotions`.
- `function budgetChainChanges(prevChain: BudgetGateState["prevChain"], chain: BudgetGateWiringView["chain"]): Record<string, { from: string | null; to: string | null; reason: string }>` holds the current `const switched … = {}` / `const prevChain = budget.prevChain` / `for (const tier of MODEL_TIERS)` / `if (was?.pair === cur?.pair && was?.step === cur?.step) continue` / `switched[tier] = { from: was?.pair ?? null, to: cur?.pair ?? null, reason: cur?.reason ?? "available" }` block verbatim, with its comment, then returns `switched`.
- `publishBudgetWiring` keeps its signature and calls `budgetDemotions(budget.breakers)` and `budgetChainChanges(budget.prevChain, view.chain)`; its own body keeps the `engagedDemotion` lookup, the `spend` pair, the `publishInfoFields` call with the same four field pairs in the same order, the `if (Object.keys(switched).length > 0)` `logEventBestEffort` call with the same `fallback_switched` event, and the final `budget.prevChain = view.chain`.
- Both helpers are module-private, declared once, and never exported; the two module-private interfaces, the exported functions and every doc comment stay unchanged.

**Files touched.** src/budget/budget-wiring.ts

**Acceptance criteria.**
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/budget/budget-wiring.ts` reports `publishBudgetWiring` at 6 or below (it reports 19 today) and neither new helper above 6.
- `grep -nE '^function (budgetDemotions|budgetChainChanges)' src/budget/budget-wiring.ts` matches both exactly once, and `grep -nE '^export (async )?function (budgetDemotions|budgetChainChanges)' src/budget/budget-wiring.ts` prints nothing.
- The published values and event are byte-identical: the same `fallbackDemotions` map (empty `{}` when no breaker yields a demotion), the same `fallbackDemoted`, `budget` and `chain` fields in the same order, and the same one `fallback_switched` event with the same per-tier `{from,to,reason}` map; `test/budget-wiring.test.ts` passes unedited, including "applyBudgetGateWiring: publishes spend/chain info and logs fallback_switched for a cap move" and "applyBudgetGateWiring: a cap reopen hands in-flight fallback runs back to the primary".
- The behavior is still exercised through the poll: `test/gate-polls.test.ts` passes unedited, including the fallback-switch and per-tier pause-set cases.
- No edit lands outside src/budget/budget-wiring.ts; docs/invariants.md is unchanged because it names no symbol of this file.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving and the existing budget suites drive both collectors. Run test/budget-wiring.test.ts and test/gate-polls.test.ts whole, then the project's gate, and confirm green. If a collected field differs, a loop or a default moved with the wrong condition; fix the move, do not change a test to make it pass.

### `reviewMergedCommit`'s complexity-19 async worktree callback in src/review/post-merge-review.ts is split into named module-private helpers — `reviewerReplyOf`, `logReviewVerdict` and `applyReviewFix` — so the reviewer run's reply, its recorded verdict, and the self-fix chain are read from names instead of one 95-line closure (planned 2026-11-02 by the plan role; continues the landed split-large-function family — the 2026-11-02 `readPostReviews` plan split the sibling cache parser in this same file and left this callback as its largest remaining body, reported at complexity 19, while the exported `reviewMergedCommit` wrapper itself reports only 3; independent in file of every `## Planned` entry — before this entry `grep -n 'post-merge-review\.ts\|reviewMergedCommit' PLANS.md` prints nothing, the only `post-merge-review` mentions being Subtract part 3d/7's prose ("keep the post-merge-review rows"), whose touches list names no src/review file, and no other waiting heading or touches list names src/review/post-merge-review.ts; PLANS-DONE.md records the 2026-11-02 `readPostReviews` parser split and the review-budget and self-fix work that shaped `reviewMergedCommit`, but `grep -cE '^### .*reviewMergedCommit' PLANS-DONE.md` prints 0 and no entry splits this callback; docs/invariants.md binds `reviewMergedCommit` for INV-BT3, whose guarantee this behavior-preserving move keeps, so it stays unchanged; touches src/review/post-merge-review.ts)

**Goal.** `reviewMergedCommit` is a thin exported wrapper around one `useWorktree` callback. That callback is the whole review: it checks the worktree out at the reviewed commit, runs the reviewer, parses the reply, records the verdict, decides whether the reviewer's edit is a fix to commit, runs the revision-backstop check, commits the fix and advances the review ref, then returns the outcome. eslint's complexity one-shot reports the callback at 19, and "what is the reviewer's reply, what did we record, and when is an edit a fix?" is answerable only by reading the whole closure. Lift each concern into a named module-private helper, leaving the callback as the ordered sequence of those calls, with no wording, field-read or outcome change.

**Approach.** All edits in src/review/post-merge-review.ts; no export changes. Keep `reviewMergedCommit`'s signature and its outer try/catch (`gitCouldNotStart` rethrow and the `failed` fallback) as they are.
- `function reviewerReplyOf(pi: Awaited<ReturnType<GateRunsPi["runGatePi"]>>): { verdict: NonNullable<ReturnType<typeof parseVerdict>> | null; paths: string[] | null }` holds today's `pi.ok && !pi.aborted` gate once — `const usable = pi.ok && !pi.aborted;` then `{ verdict: usable ? parseVerdict(pi.verdictText ?? "") : null, paths: usable ? fixLine(pi.verdictText ?? "") : null }` — replacing the callback's two separate copies of that gate with one read. It is module-private.
- `function logReviewVerdict(root: string, role: string, commit: string, verdict: NonNullable<ReturnType<typeof parseVerdict>>, durationMs: number): void` holds the current `review_rejected`/`review_verdict` branch verbatim, including the same `reasons` and `durationMs` payloads and `afterMerge` marker.
- `function applyReviewFix(root: string, entry: PostReview, verdict: NonNullable<ReturnType<typeof parseVerdict>>, paths: string[] | null, diffWorktree: string, fixRef: string): Promise<PostReviewOutcome | null>` holds the whole repair decision verbatim: the `paths && verdict.verdict === "reject" && (await gitTry(diffWorktree, "status", "--porcelain"))?.trim().length` gate; the reviewed-message read and `nextRound`; the `REVISION_BACKSTOP` branch that deletes the ref, logs `revision`/`exhausted` under `entry.role` and returns `exhausted`; and the `commitReviewerFix` + `setRef` + `fixed` return. It returns `null` when the reply names no fix, the verdict is not a rejection, or the worktree is clean, and it never deletes the ref on those paths — the callback's unchanged `await deleteRef(root, fixRef)` does that after `null`.
- The callback keeps the `fixRef`, `ensureDetachedWorktree`, `setRef`, diff, `reviewRunConfig`, `review_start` log and `runGatePi` call verbatim; after `const reply = reviewerReplyOf(pi)`, it keeps the `!verdict` failed branch (deleting the ref) and then calls `logReviewVerdict(...)`. It replaces the fix block with `const fixed = await applyReviewFix(...); if (fixed !== null) return fixed;`, then the existing `deleteRef` and reject/approve returns. `const paths` and the second `pi.ok && !pi.aborted` test disappear from the callback.
- Place the three helpers beside `commitReviewerFix`, after it and before `reviewMergedCommit`; add no import beyond types already available (`GateRunsPi`, `parseVerdict` and `fixLine` are already imported).

**Files touched.** src/review/post-merge-review.ts

**Acceptance criteria.**
- `npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs src/review/post-merge-review.ts` reports the async `useWorktree` callback at 10 or below (it reports 19 today) and `reviewMergedCommit` still at 3; `reviewerReplyOf`, `logReviewVerdict` and `applyReviewFix` each report at 10 or below.
- `grep -nE '^(export )?function (reviewerReplyOf|logReviewVerdict|applyReviewFix)' src/review/post-merge-review.ts` matches all three, and none carries `export` (all module-private); `reviewMergedCommit` is still exported with the same five parameters and `Promise<PostReviewOutcome>`.
- Behavior is unchanged: test/post-merge-review.test.ts passes unedited, including "an approving post-merge review ends the entry and logs afterMerge events", "a rejecting post-merge review never fills the revert slot and keeps the commit on main", "a merged commit whose diff git cannot produce fails its review, never approving an empty diff", "a post-merge review git could not start keeps its entry without counting a failed run", "a reviewer's fix commit carries the next revision round", "a self-fix chain stops at the backstop and clears the entry", and "a fix whose landing keeps failing is dropped at POST_REVIEW_FAILURE_LIMIT".
- No edit lands outside src/review/post-merge-review.ts; docs/invariants.md is unchanged because INV-BT3's `reviewMergedCommit` binding and its two pinned cases keep the same diff-failure and git-could-not-start behavior, and test/post-merge-review.ts is not edited.
- `npm run test:gate` passes.

**Tests.** No new test module: the move is behavior-preserving and test/post-merge-review.test.ts already drives the approving, rejecting, failed, fix, backstop and landing-failure outcomes through `reviewMergedCommit`. Run test/post-merge-review.test.ts whole, then the project's gate, and confirm green. If a case fails, a condition moved with the wrong branch or a payload field was dropped; fix the move, do not relax a test.

## Done
