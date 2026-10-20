# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code runner, part 13/14: Convert gates and budget and the event history failure and report modules (planned 2026-10-16 by user; requires part 12/14 landed; design in plans/terminology.md "Code names"; touches src/gates/ + src/budget/ + src/events/ + src/history/ + src/failure/ + src/report/ + src/files/ + src/text/ + their tests)

**Goal.** The gate, budget, event, history, failure, report, file and text helpers use runner and role names, including the per-runner event maps in history and failure.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/history/history-data.ts: the maps keyed by the event `source` (a runner id): `outcomeByLoop` → `outcomeByRunner`, `mergeQueuedByLoop` → `mergeQueuedByRunner`, and `byLoop` → `byRole` (keyed by the row's role). The first two are members of the object `bucketMergeEvents` returns, so also rename their uses in src/failure/time-spend.ts, src/tick/tick-detail-data.ts and src/cli.ts (no alias). The `blank(loop)` parameter → `role`. src/history/history-render.ts: `loopWidth` → `roleWidth`; the `line(loop, …)` parameter → `role`.
- src/failure/time-spend.ts: `eventsByLoop`, `rejectedByLoop`, `reviewFailedByLoop` and `deadlineKilledByLoop` → `…ByRunner`.
- src/events/ (events.ts has about 27 comment lines, plus event-format.ts, notify.ts, event-read.ts, event-window.ts): comments. event-format.ts's `const loop = padToWidth(eventRole(e), 9)` → `const source = …` (check the scope). If `NOTIFY_TEST_LOOP` still exists in the notify tests, → `NOTIFY_TEST_SOURCE`.
- src/gates/ (gate-polls.ts, budget-gates.ts, role-cap-gates.ts, maintenance-quota.ts, streak-gate.ts, bootstrap-gates.ts, pause-gates.ts, startup-gate.ts), src/budget/ (budget.ts, fallback-breaker.ts), src/report/, src/files/ and src/text/: migrate uses and convert comments.
- Tests: test/budget*.test.ts, test/gate*.test.ts, test/role-cap-gates.test.ts, test/streak-gate.test.ts, test/pause-gates.test.ts, test/bootstrap-gates.test.ts, test/disk-gate.test.ts, test/event*.test.ts, test/notify*.test.ts, test/history*.test.ts, test/cli-history*.test.ts, test/cli-logs*.test.ts, test/failure*.test.ts, test/report*.test.ts, test/files.test.ts, test/json-files.test.ts, test/fixtures/history-fixtures.ts and test/fixtures/log-fixtures.ts. `spentLoopState` (about 46 uses here) → `spentRunnerState`.

**Files touched.** src/gates/*.ts, src/budget/*.ts, src/events/*.ts, src/history/*.ts, src/failure/*.ts, src/report/*.ts, src/files/*.ts, src/text/*.ts, the `…ByLoop` uses in src/tick/ and src/cli.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE '[A-Za-z]ByLoop\b|\bbyLoop\b|loopWidth'` over src/ and test/ prints nothing.
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_'` over this part's files prints nothing.
- No behavior change: history, report and failure output in the tests is unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 14/14: Sweep the remaining loop names and retire the old runner names (planned 2026-10-16 by user; requires part 13/14 landed; design in plans/terminology.md "Code names" and "Guards"; touches every remaining src/ and test/ file with a loop name + test/retired-names.test.ts)

**Goal.** No identifier, file name, comment or test title in src/ or test/ uses "loop" for a role or its worker. Every deprecated alias from this series is gone, and test/retired-names.test.ts fails if an old runner name comes back.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
- Sweep the files earlier parts did not own: src/doctor/ (doctor-holds.ts's `const loops = loopIds(config)` → `runners`), src/backlog/, src/change/, src/concurrency/, src/git/, src/agent/, src/pi/, src/pi-extension/, src/process/ (supervisor.ts comments; `crashLoop` stays), src/redeploy/, src/team/, src/brief/, the root modules (src/paths.ts has about 12 comment lines, plus src/collections.ts and src/request-timeouts.ts), and their tests: test/doctor*.test.ts, test/backlog*.test.ts, test/pi.test.ts, test/supervisor.test.ts, test/worktree*.test.ts, test/cli.test.ts, test/completion.test.ts, test/test-runner.ts, test/fakes/*.ts, test/helpers/*.ts and test/fixtures/{repo,gate,victim}-fixtures.ts. Also include any file that gained a loop name from a feature that landed during this series: run `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_' src test` and `grep -rnwiE 'loops?' src test` and convert every role-or-worker sense.
- Delete every remaining `@deprecated` alias this series added (`grep -rn '@deprecated Use' src test`: `LoopRunner`, `LoopState`, `freshLoopState`, `loadLoopState`, `saveLoopState`, `loopIds`, `loopEnabled`, `LoopPi`, `makeLoopRunner`, `spentLoopState`, `loopPhase`, `loopRank`, `LOOP_RANK_RULES`, `sortLoopsByState`, `loopRowCells`, `loopWakeMarker`, whichever remain), after migrating their last users.
- Append a `runner` family to the guard in test/retired-names.test.ts. Plain terms code team 6/6 gave each family the shape `{ family, words, fileWords, allow }`, and the guard splits identifiers into words, including those in dashboard browser code. Use `words: ["loop", "loops"]` and `fileWords: ["loop", "loops"]`. Put in `allow`, each with its reason comment, the kept identifiers `pollLoop`, `crashLoop` and `onCrashLoop`, the live legacy config key `customLoops`, and, until Plain terms code cleanup renames them, `CustomLoop`, `customLoopNames` and `CUSTOM_LOOP_KEYS`. Rename a leftover JavaScript-loop variable called `loop` to say what it holds instead of allowing it. Legacy readers use the guard's existing exemptions: `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines, and `retired-name-ok:start`/`end` regions. Add no new mechanism.
- Run the retired-names guard and fix what it reports, for example a temp-dir prefix such as `tmpdir("loop-ids-cap-")` → `tmpdir("runner-ids-cap-")`. A hit inside a legacy reader that must keep an old name, such as an old-format event fixture with a `loop` field, gets one of the guard's exemptions, not a rename.

**Files touched.** The remaining files listed above; the alias declarations in src/runner/, src/roles/runner-ids.ts, src/ui/status-model.ts, src/ui/badges.ts and test/fixtures/runner-fixtures.ts; test/retired-names.test.ts.

**Acceptance criteria.**
- `grep -rn '@deprecated Use' src test` lists none of this series' old names.
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_' src test` lists only `loopback*`, `pollLoop`, `crashLoop`/`onCrashLoop`, `customLoop*`/`CUSTOM_LOOP_*`, and sites the retired-names guard exempts (the legacy readers).
- test/retired-names.test.ts holds the `runner` family and passes; adding `const loopState = 1;` to any src/ module makes it fail (check locally, do not commit).
- `npm run test` passes.

### Plain terms code run, part 1/20: Move src/tick to src/run and the run command module to cli-start (planned 2026-10-16 by user; requires Plain terms code runner 14/14 landed; design in plans/terminology.md "Code names"; touches src/tick/ + src/ui/tick-progress-model.ts + src/cli/cli-run.ts + test/tick-*.test.ts + test/cli-run*.test.ts + test/helpers/run-live-harness.ts + every importer + docs/invariants.md + DEVELOPMENT.md + test/invariants-doc.test.ts)

**Goal.** Mechanical. The run pipeline's modules, the run-progress model, the `tumwater start` command module and their tests move to their final names, with every import path and path citation updated and no identifier changed.

**Approach.**
- `git mv` only, then fix paths. Do not change any identifier, comment wording or test title beyond the paths themselves.
- Leave record prose alone: do not edit BUGS.md, PLANS.md, QUESTIONS.md, PLANS-DONE.md, BUGS-FIXED.md or any `plans/*.md`. Their old paths are correct as written: finished entries record files as they were, and open plans name both sides of the moves they describe. This bullet was added 2026-10-19 by user, after a sweep through them got Plain terms code runner part 1/14 rejected five times. The pre-queue self-check no longer lists these files; a review objection asking for them to be swept is outside this part's scope, so say so in RISK.
- Source moves: `src/tick/` → `src/run/`, and inside it `tick-<x>.ts` → `run-<x>.ts` for apply, detail, detail-data, finalize, outcome, prompt, resume, stage, timing, usage and verdict. `qa-coverage.ts`, `stage-check.ts` and `telemetry-digest.ts` move unchanged (Plain terms code cleanup renames the last one). `src/ui/tick-progress-model.ts` → `src/ui/run-progress-model.ts`. `src/cli/cli-run.ts` → `src/cli/cli-start.ts`. `src/runner/runner-run.ts` already has its final name.
- Test moves: `test/tick-<x>.test.ts` → `test/run-<x>.test.ts` (same suffixes); `test/cli-run.test.ts` and `test/cli-run-<x>.test.ts` → `test/cli-start.test.ts` and `test/cli-start-<x>.test.ts` (force-exit, guards, once, shutdown, sigint, window); `test/helpers/run-live-harness.ts` → `test/helpers/start-live-harness.ts`. No existing `test/run-*.test.ts` name collides (`test/run-marker.test.ts` covers src/process/run-marker.ts, which keeps its name).
- Update every import specifier (static, `import type`, dynamic `import()`, including src/cli.ts's per-command dynamic import of cli-run.js), every `new URL(…)` path (test/build-stage.test.ts reads `../../src/cli/cli-run.ts`), and every path citation in comments and strings in `src/`, `test/` and `scripts/`.
- Paths pinned outside the moved files must change in this part, or the suite fails: docs/invariants.md cites `src/tick/tick-verdict.ts`, `src/tick/stage-check.ts`, `src/tick/tick-stage.ts`, `src/tick/tick-resume.ts`, `src/cli/cli-run.ts`, `test/tick-stage.test.ts`, `test/tick-verdict.test.ts` and `test/cli-run-shutdown.test.ts`, and test/invariants-doc.test.ts fails on a cited path that does not exist. test/invariants-doc.test.ts's own `HERMETIC_ALLOWLIST` is keyed `"test/cli-run-window.test.ts"`; rename that key to `test/cli-start-window.test.ts`, or the gating-tier listener check fails. Also update DEVELOPMENT.md's Layout path mentions (`src/tick/…`, `tick-*.ts`, `cli-run.ts`) and any other docs/*.md that cites a moved file as current.
- Only paths change: src/cli.ts's `case "run":` dispatch and the supervisor's `["run", …]` spawn argv stay exactly as they are (`run` remains a hidden alias of `tumwater start`, so an older build can still respawn its child).
- Finish with `grep -rnE 'src/tick/|tick-(apply|detail|detail-data|finalize|outcome|prompt|resume|stage|timing|usage|verdict|progress-model)[."]|cli-run[.-]|run-live-harness' src test scripts docs/invariants.md DEVELOPMENT.md`, which must print nothing. docs/code-metrics.md is a dated snapshot; leave it.

**Files touched.** The moved files above, every importer (about 115 import lines), test/build-stage.test.ts, test/invariants-doc.test.ts, docs/invariants.md, DEVELOPMENT.md. Reads (does not edit): scripts/stamp-build.mjs (prunes stale dist/ outputs of the old names).

**Acceptance criteria.**
- `src/tick/` does not exist; `src/run/` holds the eleven `run-*.ts` modules plus `qa-coverage.ts`, `stage-check.ts` and `telemetry-digest.ts`; `src/ui/run-progress-model.ts` and `src/cli/cli-start.ts` exist; `git log --follow` traces each to its old name.
- The grep in the last Approach bullet prints nothing, and test/invariants-doc.test.ts passes.
- No identifier changed: the diff is renames plus path lines only, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 2/20: Rename RoleRunner's run methods and run-context members (planned 2026-10-16 by user; requires part 1/20 landed; design in plans/terminology.md "Code names"; touches src/runner/runner.ts + src/runner/runner-run.ts + src/runner/runner-pi.ts + every caller and stub of those members)

**Goal.** Mechanical. `RoleRunner.tick()` becomes `run()`, and every other tick-named member of `RoleRunner`, `RunnerRunContext` and `RunnerPiHost` takes its run name, with all callers, stubs and test overrides moved in the same part. Members cannot carry aliases.

**Approach.**
- Renames (members, so no aliases; rename every use in src/ and test/ here):
  - `RoleRunner`: `tick()` → `run()`, `abortTick()` → `abortRun()`, `handBackTick()` → `handBackRun()`, `tickModel()` → `runModelPair()` (not `runModel`, which is `RunVerdictContext`'s field for the agent run's model), private `runTick` → `runOnce`, `tickContext()` → `runContext()`, `tickPrompt()` → `runPrompt()`, fields `tickAbort` → `runAbort` and `tickPair` → `runPair`, `finishAbortedTick` → `finishAbortedRun`, `finishRecoveryTick` → `finishRecoveryRun`.
  - `RunnerRunContext` (src/runner/runner-run.ts): `tickPrompt` → `runPrompt`, `setTickPair` → `setRunPair`, `resetTickAbort` → `resetRunAbort`, `runTick` → `runOnce`, `finishAbortedTick` → `finishAbortedRun`, `finishRecoveryTick` → `finishRecoveryRun`.
  - `RunnerPiHost` (src/runner/runner-pi.ts): `tickNumber` → `runNumber`.
- Callers: src/orchestrator/orchestrator-launch.ts, src/gates/gate-polls.ts, src/gates/budget-gates.ts (`tickModel` parameter → `runModelPair`), src/operator/operator-requests.ts, and src/run/run-stage.ts, run-verdict.ts, run-resume.ts and run-timing.ts where they call these members.
- Test overrides and fakes are not type-checked, because they use casts (`as unknown as RoleRunner`) or monkeypatching, so find them by grep, not tsc. Search test/ for `runTick`, `.tick(`, `tick:`, `tickModel`, `handBackTick`, `abortTick` and `stubRunTick`. Known sites: test/runner.test.ts (`(runner as unknown as { runTick … }).runTick = …`), test/orchestrator-launch.test.ts's `fakeRunner(role, tick)` (property `tick` → `run`), test/gate-polls.test.ts and test/gate-event-best-effort.test.ts (`tickModel:`, `handBackTick:`), test/operator-requests.test.ts (`bad.abortTick = …`), test/orchestrator-seams.test.ts, test/orchestrator-permits.e2e.test.ts, test/agent-commit-fold.test.ts, test/pi.test.ts, and every test/runner*.test.ts and test/revision.test.ts call of `.tick()`. Also `stubRunTick` → `stubRunOnce`. A missed override fails at runtime, never at compile time.
- Leave node:test mock clocks alone: `t.mock.timers.tick(ms)` and test/inbox.test.ts's `clock.tick(…)` are not runner methods.
- Update comment mentions of exactly these member names in the touched files. Wider comment wording waits for each file's own part.

**Files touched.** src/runner/runner.ts, src/runner/runner-run.ts, src/runner/runner-pi.ts, src/orchestrator/orchestrator-launch.ts, src/gates/gate-polls.ts, src/gates/budget-gates.ts, src/operator/operator-requests.ts, src/run/run-stage.ts, src/run/run-verdict.ts, src/run/run-resume.ts, src/run/run-timing.ts, the test files named above, test/fixtures/runner-fixtures.ts, test/fixtures/runner-pi-fixtures.ts and test/fixtures/orchestrator-fixtures.ts.

**Acceptance criteria.**
- `grep -rnE '\.(tick|abortTick|handBackTick|tickModel|runTick)\(|\b(stubRunTick|setTickPair|resetTickAbort|tickAbort|tickPair|tickContext)\b|\btick(Model|Prompt)?:\s*(async|\()' src test` prints nothing, apart from `mock.timers.tick` and test/inbox.test.ts's clock helper.
- `RoleRunner` declares `run()`, `abortRun()`, `handBackRun()` and `runModelPair()`, and no tick-named member.
- No behavior change: the suite's test count is unchanged, including `npm run test:e2e`.
- `npm run test` passes.

### Plain terms code run, part 3/20: Rename the run outcome and outcome application and usage types (planned 2026-10-16 by user; requires part 2/20 landed; design in plans/terminology.md "Code names"; touches src/run/run-outcome.ts + src/run/run-apply.ts + src/run/run-usage.ts + test/run-outcome.test.ts + test/run-apply.test.ts + test/run-usage.test.ts)

**Goal.** The pipeline's core types take run names: `RunResult`, `RunOutcome`, `applyRunOutcome` and `RunUsage`, behind deprecated aliases for the directories that migrate later.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Collisions are settled: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`. Each part names any others it owns.
  - A bare `tick` binding or in-process field that holds a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is already bound in scope. `run` is a common local (`const run = await runPi(…)`): never shadow it or any other existing binding.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and the helpers that wrap them, and serialized names (event types and fields, state fields, `--json`/`/api` keys, config keys). Earlier series renamed those with legacy readers; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run", "ticks" → "runs", "ticked" → "ran", "mid-tick"/"per-tick" → "mid-run"/"per-run", `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. In the same files, a bare noun "run" meaning one agent (pi or claude) invocation becomes "agent run", so "a run's agent runs" stays unambiguous; "pi run", "review run" and "check run" are already qualified. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone (test/plan-citations.test.ts); rewrap comment lines past 100 columns (test/comment-width.test.ts); update docs/invariants.md quotes of test titles you change.
  - An export used outside this part's files keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. If it has only a handful of outside uses (about five lines or fewer), migrate them instead. Members (methods, properties, interface fields) get no alias: rename every use in this part. Migrate this part's uses of names earlier parts renamed (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names any more (test/exports.test.ts fails an export nothing else mentions).
- src/run/run-outcome.ts: `TickResult` → `RunResult`, `TickOutcome` → `RunOutcome`, both aliased (used across about 15 directories). Check that no `RunResult` is imported alongside `PiRunResult` under a clashing local name.
- src/run/run-apply.ts: `applyTickOutcome` → `applyRunOutcome`, aliased (about 150 uses, mostly tests). Convert comments.
- src/run/run-usage.ts: `TickUsage` → `RunUsage`, aliased. Its comments use "run" for an agent invocation often; apply the "agent run" rule carefully (for example "a merge or review run's usage" stays, "the tick's pre-edit counter" → "the run's pre-edit counter").
- Tests test/run-outcome.test.ts, test/run-apply.test.ts (about 150 lines) and test/run-usage.test.ts: new names, comments and titles.

**Files touched.** src/run/run-outcome.ts, src/run/run-apply.ts, src/run/run-usage.ts, test/run-outcome.test.ts, test/run-apply.test.ts, test/run-usage.test.ts.

**Acceptance criteria.**
- `RunResult`, `RunOutcome`, `applyRunOutcome` and `RunUsage` are declared; the old names exist only as deprecated aliases.
- `grep -nE '[Tt]ick|TICK'` over this part's six files lists only the aliases and kept senses.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 4/20: Rename the run prompt and resume and finalize and timing modules (planned 2026-10-16 by user; requires part 3/20 landed; design in plans/terminology.md "Code names"; touches src/run/run-prompt.ts + src/run/run-resume.ts + src/run/run-finalize.ts + src/run/run-timing.ts + their tests)

**Goal.** The pipeline's start, prompt, finalize and timing helpers take run names, including `runTimedRoleRun` and `p75RunDurationMs`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/run/run-prompt.ts: `assembleTickPrompt` → `assembleRunPrompt` (aliased) and `TickPromptInput` → `RunPromptInput`. The `initialPrompt` local and `readInitialPrompt` mentions belong to Plain terms code cleanup.
- src/run/run-resume.ts: `planTickStart` → `planRunStart` and `TickStartPlan` → `RunStartPlan`; member `tickPrompt` → `runPrompt`.
- src/run/run-finalize.ts: `finalizeTick` → `finalizeRun` and `FinalizeTickDeps` → `FinalizeRunDeps`; members `tick` → `runNumber` and `tickStartedAt` → `runStartedAt`.
- src/run/run-timing.ts: `runTimedRoleTick` → `runTimedRoleRun` (aliased; src/orchestrator and src/redeploy use it), `p75TickDurationMs` → `p75RunDurationMs`, and locals such as `releaseTick` → `releaseRun` and `tickDurationMs` → `runDurationMs`. `drainInFlightWork` keeps its name (drain is a kept code word).
- Tests: test/run-prompt.test.ts, test/run-resume.test.ts, test/run-finalize.test.ts and test/run-timing.test.ts.

**Files touched.** The four modules and four tests above, plus migrated outside uses of names with five or fewer outside lines.

**Acceptance criteria.**
- `assembleRunPrompt`, `RunPromptInput`, `planRunStart`, `RunStartPlan`, `finalizeRun`, `FinalizeRunDeps`, `runTimedRoleRun` and `p75RunDurationMs` are declared; old names survive only as aliases still used elsewhere.
- `grep -nE '[Tt]ick|TICK'` over this part's eight files lists only aliases and kept senses.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 5/20: Rename the run verdict and staging modules and convert the git and process plumbing (planned 2026-10-16 by user; requires part 4/20 landed; design in plans/terminology.md "Code names"; touches src/run/run-verdict.ts + src/run/run-stage.ts + src/run/stage-check.ts + src/run/qa-coverage.ts + src/run/telemetry-digest.ts + src/git/ + src/concurrency/ + src/process/ + src/build/ + their tests)

**Goal.** The verdict and staging half of the pipeline takes run names: `resolveRunVerdict` and `stageRunMerge`. The git, concurrency, process and build modules lose their tick wording, which is almost all in comments.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/run/run-verdict.ts: `resolveTickVerdict` → `resolveRunVerdict` (aliased) and `TickVerdictContext` → `RunVerdictContext`. Its `runModel` field already means the agent run's model and stays.
- src/run/run-stage.ts: `stageTickMerge` → `stageRunMerge` (aliased), `TickStageContext` → `RunStageContext`, `TickFlow` → `RunFlow`, member `tickTurns` → `runTurns`, and the local `movedPlansTick` → `movedPlansRun`.
- src/run/stage-check.ts, qa-coverage.ts and telemetry-digest.ts: comments only. The `telemetry` identifiers and file name belong to Plain terms code cleanup.
- src/git/ (commit-message.ts, worktree.ts, worktree-pool.ts, git.ts, git-diff.ts, slots-state.ts, worktree-use.ts, git-run.ts), src/concurrency/ (provider-lease.ts, lock.ts, semaphore.ts, check-permit.ts), src/process/ (supervisor.ts, process.ts, run-marker.ts) and src/build/ (build-check-report.ts, build-stage.ts, build-info.ts, build-check*.ts): comments, plus any tick identifier they declare. src/process/run-marker.ts and `TUMWATER_RUN` already mean one agent run and keep their names. Its comments' "pi run" stays; a bare "run" there becomes "agent run". The `tumwater run`-command names in supervisor.ts (`superviseRun`, `spawnRunChild`) are part 19/20's.
- Tests: test/run-verdict.test.ts, test/run-stage.test.ts, test/stage-check.test.ts, test/qa-coverage.test.ts, test/telemetry-digest.test.ts, test/commit-message.test.ts, test/worktree*.test.ts, test/git*.test.ts, test/lock.test.ts, test/semaphore.test.ts, test/provider-lease.test.ts, test/process.test.ts, test/supervisor.test.ts, test/run-marker.test.ts, test/build*.test.ts and test/launch-services.e2e.test.ts. Leave their `t.mock.timers.tick` calls.

**Files touched.** The src/run/ modules above, src/git/*.ts, src/concurrency/*.ts, src/process/*.ts, src/build/*.ts, and the tests listed above.

**Acceptance criteria.**
- `resolveRunVerdict`, `RunVerdictContext`, `stageRunMerge`, `RunStageContext` and `RunFlow` are declared; old names survive only as aliases still used elsewhere.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b'` over this part's files lists only mock-clock calls, aliases and serialized names.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 6/20: Rename the run detail reader and the history rows (planned 2026-10-16 by user; requires part 5/20 landed; design in plans/terminology.md "Code names"; touches src/run/run-detail.ts + src/run/run-detail-data.ts + src/history/history-data.ts + test/run-detail.test.ts + test/run-detail-data.test.ts + test/history-data.test.ts)

**Goal.** The `tumwater history <role> <n>` reader and the history row model take run names: `cmdRunDetail`, `RunDetail`, `readRunDetail`, `RunRow`, `readRunRows` and `summarizeRunRows`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/run/run-detail.ts: `cmdTick` → `cmdRunDetail` (src/cli.ts and src/history/ call it; aliased or migrated), `TICK_USAGE` → `RUN_DETAIL_USAGE`, `tickNotFoundMessage` → `runNotFoundMessage`, `tickNotFoundPhrase` → `runNotFoundPhrase`, `tickNotFoundLastMessage` → `runNotFoundLastMessage`, `renderTickDetail` → `renderRunDetail`, `tickDetailStat` → `runDetailStat`, and the locals `tickCommitSha` and `tickCommitStat` → `runCommitSha` and `runCommitStat`. Plain terms commands may already have pointed `TICK_USAGE`'s text at `history <role> <n>`; only the name changes here.
- src/run/run-detail-data.ts: `TickDetail` → `RunDetail` and `readTickDetail` → `readRunDetail`, both aliased (the GUI and TUI use them).
- src/history/history-data.ts: `TickRow` → `RunRow`, `readTickRows` → `readRunRows`, `readTickRowsSince` → `readRunRowsSince`, `summarizeTickRows` → `summarizeRunRows`, `tickRowsMatchingGrep` → `runRowsMatchingGrep`, `tickRowGrepHaystack` → `runRowGrepHaystack` (all aliased where used outside), `HISTORY_MAX_TICKS` → `HISTORY_MAX_RUNS`, `HISTORY_DEFAULT_TICKS` → `HISTORY_DEFAULT_RUNS`, `TickRowJoin` → `RunRowJoin`, and `TICK_ROW_JOIN_BACKSLACK_MS`, `TICK_ROW_JOIN_BACK` and `TICK_ROW_WINDOW_MEMO_MAX` → `RUN_ROW_…`. Locals: `tickRows`, `tickRowWindowMemo` and `inTickEvent` → run forms. `RunRow`'s serialized `run` field was renamed by Plain terms scripting; do not touch it.
- Tests: test/run-detail.test.ts (its `cli(repo, "tick", …)` calls exercise the hidden alias on purpose; leave those argv strings), test/run-detail-data.test.ts and test/history-data.test.ts.

**Files touched.** src/run/run-detail.ts, src/run/run-detail-data.ts, src/history/history-data.ts, their three tests, and migrated outside uses with five or fewer lines each (for example src/cli.ts for `cmdRunDetail`).

**Acceptance criteria.**
- The new names are declared; old names survive only as aliases still used elsewhere.
- `grep -nE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_'` over this part's six files lists only aliases, and every bare "tick" left is a hidden-alias argv string.
- No behavior change: `tumwater history <role> <n>` output in the tests is unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 7/20: Convert the dashboard and the rest of history (planned 2026-10-16 by user; requires part 6/20 landed; design in plans/terminology.md "Code names"; touches src/ui/gui/ + src/gui/ + src/history/history.ts + src/history/history-render.ts + test/gui*.test.ts + test/cli-gui.test.ts + test/history*.test.ts + test/cli-history*.test.ts + test/fixtures/history-fixtures.ts)

**Goal.** The dashboard's browser code, the GUI server's run endpoint and the history command and renderer use run names, including the drawer's run list and the run-detail DOM attribute.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/gui/gui-endpoints.ts: `handleTick` → `handleRun` and `serveTick` → `serveRun`. The `/api/run` route and its legacy `/api/tick` handling are Plain terms scripting's; keep both routes working.
- Browser code in src/ui/gui/ (inside String.raw templates, which tsc does not check; grep all of src/ui/gui/ before each rename so names stay unique across the concatenated modules): `drawerTicks` → `drawerRuns`, `drawerTicksAt` → `drawerRunsAt`, `fmtLastTick` → `fmtLastRun`, `chartTicksByRole` → `chartRunsByRole`, `tickWord` → `runWord`, `todayTick` → `todayRun`, the DOM attribute `data-tickdetail` → `data-rundetail` (with its `dataset.tickdetail` reads and the `[data-tickdetail]` selector in gui-client-boot.ts), and uses of `lastTickCell` and `TickResult` → the new names. test/helpers/gui-client-scope.ts reaches browser functions by name; update it.
- src/history/history.ts and history-render.ts: `TickRowCells` → `RunRowCells`, `tickRowCells` → `runRowCells` and `tickRowLine` → `runRowLine` (aliased if src/ui/tui still uses them), and migrate `RunRow`, `readRunRows`, `summarizeRunRows` and the other names part 6/20 introduced.
- Tests: test/gui*.test.ts, test/cli-gui.test.ts, test/history*.test.ts except history-data (part 6/20's), test/cli-history*.test.ts, and test/fixtures/history-fixtures.ts (`repoWithTicks` → `repoWithRuns`).

**Files touched.** src/ui/gui/*.ts, src/gui/*.ts, src/history/history.ts, src/history/history-render.ts, test/helpers/gui-client-scope.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|tickdetail'` over this part's files lists only aliases and serialized names.
- The dashboard tests that open a run's detail from the drawer pass, and `GET /api/run` and the legacy `GET /api/tick` both still answer.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 8/20: Rename the runner's run pipeline phases (planned 2026-10-16 by user; requires part 7/20 landed; design in plans/terminology.md "Code names"; touches src/runner/runner.ts + src/runner/runner-run.ts + test/runner.test.ts + test/runner-2.test.ts through test/runner-5.test.ts)

**Goal.** The runner's run pipeline (`runPhase`, `runOncePhase`, `runOnceInLeasePhase`, `runWithWorktreePhase`) and the runner's comments and core tests use run wording throughout.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/runner/runner-run.ts: `tickPhase` → `runPhase`, `runTickPhase` → `runOncePhase` (it pairs with `RoleRunner.runOnce`), `runTickInLeasePhase` → `runOnceInLeasePhase`, `tickWithWorktreePhase` → `runWithWorktreePhase`, and the locals `quietKilledTick`, `tickBase`, `nTick` and `tickOutcome` → run forms. This file has about 150 tick lines; most are comments describing the pipeline, and most of its "run" nouns mean the agent run, so apply the "agent run" rule here with care.
- src/runner/runner.ts: comments ("one full tick of this role" → "one full run of this role"), and uses of `RunOutcome`, `RunUsage`, `runPhase` and `runOncePhase`.
- Tests test/runner.test.ts and test/runner-2.test.ts through test/runner-5.test.ts: migrate names, comments and titles. docs/invariants.md quotes test/runner-2.test.ts titles ("a tick whose agent reads an image on a blind model stops and fails", "a blind read on a text-only …"); update the quotes to the renamed titles.

**Files touched.** src/runner/runner.ts, src/runner/runner-run.ts, test/runner.test.ts, test/runner-2.test.ts, test/runner-3.test.ts, test/runner-4.test.ts, test/runner-5.test.ts, docs/invariants.md (quotes only).

**Acceptance criteria.**
- `runPhase`, `runOncePhase`, `runOnceInLeasePhase` and `runWithWorktreePhase` are declared, and no tick-named function remains in src/runner/runner-run.ts.
- `grep -nE '[Tt]ick|TICK'` over this part's seven code files prints nothing except kept senses.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 9/20: Convert the rest of the runner modules and tests (planned 2026-10-16 by user; requires part 8/20 landed; design in plans/terminology.md "Code names"; touches src/runner/ except runner.ts and runner-run.ts + src/roles/runner-ids.ts + the other test/runner-*.test.ts + test/revision.test.ts + test/leftover.test.ts + test/model-fallback.test.ts + test/fixtures/runner-*.ts)

**Goal.** Runner state, the agent wrapper, recovery, leftover handling and model fallback use run wording, and `finishAbortedRunPhase` and `finishRecoveryRunPhase` replace their tick names.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message. `RunnerState`'s persisted fields were renamed by Plain terms state.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/runner/runner-recovery.ts: `finishAbortedTickPhase` → `finishAbortedRunPhase` and `finishRecoveryTickPhase` → `finishRecoveryRunPhase`.
- src/runner/runner-state.ts (about 73 tick lines, mostly comments), runner-pi.ts (the agent wrapper, where "run" is mostly the agent run: apply the "agent run" rule), leftover.ts, model-fallback.ts, runner-fallback.ts, revision.ts and src/roles/runner-ids.ts: comments and identifiers.
- Tests: test/runner-{counters,fallback,ids,interrupted,leftover-recovery,merge-conflicts,pi,pi-claude,pi-followups,pi-retry,prompt-requeue,quiet-watchdog,recovery,red-main,refusal,state,transient-retry}.test.ts, test/revision.test.ts, test/leftover.test.ts and test/model-fallback.test.ts. Fixture locals in test/fixtures/runner-fixtures.ts and runner-pi-fixtures.ts: `abortHungImproveTick` → `abortHungImproveRun`, `afterFallbackTick` → `afterFallbackRun`, `tickEvents` → `runEvents`, `tickEnds` → `runEnds`, `tick2End` → `run2End`.

**Files touched.** src/runner/runner-state.ts, runner-pi.ts, runner-recovery.ts, runner-fallback.ts, leftover.ts, model-fallback.ts, revision.ts, src/roles/runner-ids.ts, test/fixtures/runner-fixtures.ts, test/fixtures/runner-pi-fixtures.ts, and the tests listed above.

**Acceptance criteria.**
- `finishAbortedRunPhase` and `finishRecoveryRunPhase` are declared; `grep -rnE '[Tt]ick|TICK' src/runner src/roles/runner-ids.ts` prints only kept senses.
- `grep -nE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b'` over this part's tests and fixtures lists only mock-clock calls and serialized names.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 10/20: Rename the orchestrator's run launch and timing names (planned 2026-10-16 by user; requires part 9/20 landed; design in plans/terminology.md "Code names"; touches src/orchestrator/ + the non-e2e test/orchestrator-*.test.ts + test/fixtures/orchestrator-fixtures.ts)

**Goal.** The orchestrator launches and times runs by run names: `launchDueRuns`, `ROLE_RUN_DURATION_SAMPLES`, `roleRunDurationsMs` and `runsDone`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message. The `restart` event's `abortedRuns` field is Plain terms event log's.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/orchestrator/orchestrator-poll.ts (the poll steps split out of `runOrchestrator`) reads `tickStartHeld` and `roleTickDurationsMs`: rename those uses with the members below.
- src/orchestrator/orchestrator-launch.ts: `launchDueTicks` → `launchDueRuns`, `ROLE_TICK_DURATION_SAMPLES` → `ROLE_RUN_DURATION_SAMPLES`, member `roleTickDurationsMs` → `roleRunDurationsMs`, `tickStartHeld` → `runStartHeld` and `roleTickP75Ms` → `roleRunP75Ms` (a member read by src/redeploy/; rename those uses here). Locals `tickIdx`, `tickCalls` and `roleTicksInFlight` → run forms.
- src/orchestrator/orchestrator.ts: the exit-info member `ticksRun` → `runsDone`, renamed with its uses in src/cli/cli-start.ts (`onceSummary`/`onceFailures` parameters) and src/scheduling/once-round.ts (the `ticksRun(runner)` method → `runsDone(runner)`); `recordFallbackTickAt` and `deferTick` uses as they stand. orchestrator-scheduling.ts and retention.ts: comments.
- test/fixtures/orchestrator-fixtures.ts: `awaitSettledTick` → `awaitSettledRun` (aliased: the e2e tests in part 11/20 use it about 38 times), `timedTickHarness` → `timedRunHarness`, `awaitFirstTick` → `awaitFirstRun`.
- Tests test/orchestrator-{launch,seams,scheduling,probe,defer,director,redeploy,once,fallback,divergence,start-event-best-effort}.test.ts. In test/orchestrator-probe.test.ts, `ticksAt` → `runsAt` and `ticksAtTrip` → `runsByRoleAtTrip`, because a `runsAtTrip` local already exists there. `tickedFeature` → `ranFeature`.

**Files touched.** src/orchestrator/*.ts, the `ticksRun`/`roleTickP75Ms` uses in src/cli/cli-start.ts, src/scheduling/once-round.ts and src/redeploy/, test/fixtures/orchestrator-fixtures.ts, and the non-e2e orchestrator tests listed above.

**Acceptance criteria.**
- `launchDueRuns`, `ROLE_RUN_DURATION_SAMPLES` and `awaitSettledRun` are declared, and `runsDone` replaces `ticksRun` everywhere in src/ and test/.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/orchestrator` prints only serialized names.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 11/20: Convert the orchestrator end-to-end tests (planned 2026-10-16 by user; requires part 10/20 landed; design in plans/terminology.md "Code names"; touches test/orchestrator*.e2e.test.ts)

**Goal.** Mechanical, test-only. The orchestrator e2e suites use run names in their helpers, locals, comments and test titles.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep node:test mock-clock calls and serialized names (event types and fields in assertions, state fields), which were renamed earlier.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Migrate every use of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names any more (test/exports.test.ts).
- Files: test/orchestrator.e2e.test.ts, orchestrator-2, orchestrator-3, orchestrator-budget, orchestrator-permits, orchestrator-pause, orchestrator-redeploy, orchestrator-once, orchestrator-resize, orchestrator-quiet-hours and orchestrator-mixed (all `.e2e.test.ts`).
- Helpers and locals: `awaitSettledTick` → `awaitSettledRun`, then delete its alias in test/fixtures/orchestrator-fixtures.ts if nothing else uses it. `removedTicks`, `tickQueued`, `cleanTicks` and `minTickInterval` → run forms. `dryTicks` → `dedupeRuns`, its final name, so Plain terms code cleanup does not touch it again. Migrate `runTimedRoleRun` uses; `deferTick` and `restoreMidTickWake` keep their names until part 12/20 renames them.

**Files touched.** The eleven `test/orchestrator*.e2e.test.ts` files; test/fixtures/orchestrator-fixtures.ts (alias removal only).

**Acceptance criteria.**
- `grep -nE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' test/orchestrator*.e2e.test.ts` lists only serialized names and names a later part of this series owns (`deferTick`, `restoreMidTickWake`).
- No test added or removed: the e2e test count is unchanged and `npm run test:e2e` passes.
- `npm run test` passes.

### Plain terms code run, part 12/20: Rename the scheduler's deferral and wake names and convert the gates (planned 2026-10-16 by user; requires part 11/20 landed; design in plans/terminology.md "Code names"; touches src/scheduling/ + src/gates/ + their tests + test/fixtures/gate-fixtures.ts)

**Goal.** The scheduler and the gates use run names: `deferRun`, `deferRunReason`, `restoreMidRunWake` and `runOnPair`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/scheduling/: `deferTick` → `deferRun` and `deferTickReason` → `deferRunReason`, both aliased (orchestrator, roles and tests use them); `restoreMidTickWake` → `restoreMidRunWake`; the `exitReady` argument members `roleTicks` → `roleRuns` and `directorTicks` → `directorRuns` (rename the call in src/orchestrator/orchestrator.ts too); the local `tickSnapshots` → `runSnapshots`. Comments in scheduling.ts, backoff.ts, once-round.ts, claims.ts, quiet-hours.ts and the work-merged cache module ("the min-tick-interval clock" → "the min-run-interval clock").
- src/gates/: `tickOnPair` → `runOnPair` (aliased if src/budget still uses it); comments in gate-polls.ts, budget-gates.ts, streak-gate.ts, pause-gates.ts, maintenance-quota.ts, startup-gate.ts, role-cap-gates.ts, disk-gate.ts and bootstrap-gates.ts.
- Tests: test/scheduling.test.ts (about 90 lines), test/once-round.test.ts, test/backoff.test.ts, test/claims.test.ts, test/quiet-hours.test.ts, test/gate-polls.test.ts, test/gate-event-best-effort.test.ts, test/streak-gate.test.ts, test/maintenance-quota.test.ts, test/disk-gate.test.ts, test/role-cap-gates.test.ts, test/pause-gates.test.ts, test/bootstrap-gates.test.ts, test/startup-gate.test.ts and test/fixtures/gate-fixtures.ts.

**Files touched.** src/scheduling/*.ts, src/gates/*.ts, the `exitReady` call in src/orchestrator/orchestrator.ts, and the tests listed above.

**Acceptance criteria.**
- `deferRun`, `deferRunReason`, `restoreMidRunWake` and `runOnPair` are declared; old names survive only as aliases still used elsewhere.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/scheduling src/gates` prints only aliases and serialized names.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 13/20: Convert the budget and failure modules (planned 2026-10-16 by user; requires part 12/20 landed; design in plans/terminology.md "Code names"; touches src/budget/ + src/failure/ + their tests)

**Goal.** The budget breaker and the failure digest use run names: `recordFallbackRun`, `RUN_TIMEOUT_KEY` and `prevRuns`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/budget/fallback-breaker.ts and budget.ts: `recordFallbackTick` → `recordFallbackRun` and `recordFallbackTickAt` → `recordFallbackRunAt` (aliased if the orchestrator still names them, otherwise migrate its two uses). Comments.
- src/failure/ (failure-data.ts, time-spend.ts, failure-render.ts, failure-cluster.ts, failure-state-change.ts): `TICK_TIMEOUT_KEY` → `RUN_TIMEOUT_KEY`, `TICK_TIMEOUT_PROGRESSING_KEY`, `TICK_TIMEOUT_PROGRESSING_REVIEW_KEY` and `TICK_TIMEOUT_PROGRESSING_REVIEW_RESUME_KEY` → `RUN_TIMEOUT_…` (migrate their uses in src/team/). These are names of in-process cluster keys; if a key's string value is persisted or printed, leave the value, which Plain terms text or event log owns. The `RoleStats` member `prevTicks` → `prevRuns`; locals `tickEvents` → `runEvents` and `tickEnd` → `runEnd`. The failure digest's comments speak of "the telemetry role"; that role id is Plain terms code cleanup's.
- Tests: test/budget*.test.ts, test/fallback-breaker.test.ts, test/failure*.test.ts and test/time-spend.test.ts.

**Files touched.** src/budget/*.ts, src/failure/*.ts, the `TICK_TIMEOUT_*` uses in src/team/, and the tests listed above.

**Acceptance criteria.**
- `recordFallbackRun`, `recordFallbackRunAt` and `RUN_TIMEOUT_KEY` are declared; old names survive only as aliases still used elsewhere.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/budget src/failure` prints only aliases and serialized names.
- No behavior change: failure digest and budget output in the tests is unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 14/20: Convert the event and report and file and text helpers (planned 2026-10-16 by user; requires part 13/20 landed; design in plans/terminology.md "Code names"; touches src/events/ + src/report/ + src/files/ + src/text/ + their tests + test/fakes/log.ts + test/fixtures/log-fixtures.ts)

**Goal.** The event readers, report fold, file helpers and text helpers use run names: `eventRun`, `runSpanMs`, `runStartMap`, `runStart` and `runEnd`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message. `normalizeLegacyEvent`'s map from `tick_*` types to `run_*` types is a legacy reader: its old names stay.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/events/ and src/files/: `eventTick` → `eventRun`, `tickSpanMs` → `runSpanMs`, `tickStartMap` → `runStartMap`, the helpers `tickStart`/`tickEnd` → `runStart`/`runEnd`, and `tickDurationMs` → `runDurationMs`, each aliased where src/history/, src/roles/ or src/ui/ still use it. Check each new name with `grep -rnw` first, because `runStart` must not collide with a local in the same module. Comments in events.ts, event-format.ts, event-read.ts, event-window.ts and notify.ts.
- src/report/ (report-data.ts, report-render.ts): locals such as `totalTicks` → `totalRuns`, and comments. The report JSON keys are Plain terms scripting's.
- src/text/ (phrases.ts, datetime.ts, text.ts, format.ts): comments.
- Tests: test/event*.test.ts, test/events.test.ts, test/notify*.test.ts, test/report*.test.ts, test/cli-logs*.test.ts, test/log-commands*.test.ts, test/datetime.test.ts, test/fakes/log.ts (`seedTickEvents` → `seedRunEvents`) and test/fixtures/log-fixtures.ts.

**Files touched.** src/events/*.ts, src/report/*.ts, src/files/*.ts, src/text/*.ts, and the tests listed above.

**Acceptance criteria.**
- `eventRun`, `runSpanMs`, `runStartMap`, `runStart` and `runEnd` are declared; old names survive only as aliases still used elsewhere.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/events src/report src/files src/text` lists only the legacy event-type map, aliases and serialized names.
- No behavior change: `logs` and `report` output in the tests is unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 15/20: Convert the status display and the TUI (planned 2026-10-16 by user; requires part 14/20 landed; design in plans/terminology.md "Code names"; touches src/ui/*.ts + src/ui/tui/ + their tests)

**Goal.** The status model and renderer, the run-progress model and the TUI use run names: `lastRunCell`, `runProgress`, `progressOfRun` and `runStat`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/ui/status-render.ts: `lastTickCell` → `lastRunCell` (aliased if src/text/ or src/budget/ still use it). src/ui/run-progress-model.ts: `tickProgress` → `runProgress` and comments ("a tick with no recorded start time" → "a run with …"); its `ProgressRunKind` already says run. src/ui/progress-data.ts: `progressOfTick` → `progressOfRun`, and its many "run" nouns that mean the agent run get the "agent run" rule. Comments in status-model.ts (about 50 lines), status-payload.ts, team-alerts.ts, tone.ts, badges.ts and transcript.ts.
- src/ui/tui/ (tui-keys.ts has about 54 lines, plus tui-history.ts, tui-pane.ts, tui.tsx, tui-editors.ts and tui-frame.ts): the local `tickStat` → `runStat`; migrate `renderRunDetail`, `readRunRows`, `readRunDetail`, `RunRow`, `RunDetail`, `runRowCells`, `HISTORY_DEFAULT_RUNS`, `runRowsMatchingGrep`, `runDetailStat` and `runRowGrepHaystack`; then delete each of those aliases that no other file still names. Comments.
- Tests: test/status-model.test.ts, test/status-render*.test.ts, test/status-payload.test.ts, test/team-alerts.test.ts, test/progress.test.ts, test/tui*.test.ts and test/fixtures/tui-fixtures.ts.

**Files touched.** src/ui/*.ts, src/ui/tui/*.ts(x), alias deletions in src/run/ and src/history/, and the tests listed above.

**Acceptance criteria.**
- `lastRunCell`, `runProgress` and `progressOfRun` are declared, and `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/ui --include=*.ts --include=*.tsx` (excluding src/ui/gui/) prints only serialized names.
- The run-detail and history aliases this part's files were the last users of are gone (`grep -rn '@deprecated Use' src test`).
- No behavior change: TUI frames and status output in the tests are unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 16/20: Convert the prompt builders and the inbox and operator modules (planned 2026-10-16 by user; requires part 15/20 landed; design in plans/terminology.md "Code names"; touches src/prompt/ + src/inbox/ + src/operator/ + their tests)

**Goal.** The prompt builders take run names, `buildRunPrompt` and `RUN_PROMPT`, and the inbox and operator modules lose their tick wording.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message. Prompt text and `Run:`/`Tick:` trailer patterns inside string literals were handled by Plain terms text and state; do not touch strings.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/prompt/prompt.ts: `buildTickPrompt` → `buildRunPrompt`, aliased because test/prompt-roles.test.ts (part 17/20) calls it about 21 times. `TICK_PROMPT` → `RUN_PROMPT`; check whether it is only a test-local name. src/prompt/prompt-followup.ts: the parameter `tickPrompt` → `runPrompt`. Comments in prompt.ts, gate-prompts.ts and principles.ts.
- src/inbox/ (pending-prompt.ts, inbox.ts, inbox-submit.ts, inbox-edit.ts, inbox-attachments.ts, prompt-commands.ts, prompt-not-before.ts, inbox-cancel.ts) and src/operator/ (operator-commands.ts, operator-requests.ts, operator-intent.ts, retire.ts): comments, plus uses of `abortRun` and `finishAbortedRun`.
- Tests: test/prompt.test.ts (about 77 lines), test/prompt-steward.test.ts, test/prompt-resume.test.ts, test/prompt-dialect.test.ts, test/prompt-followup.test.ts, test/prompt-commands.test.ts, test/pending-prompt.test.ts, test/gate-prompts.test.ts, test/inbox*.test.ts (keep test/inbox.test.ts's `clock.tick`), test/operator*.test.ts and test/retire.test.ts.

**Files touched.** src/prompt/*.ts, src/inbox/*.ts, src/operator/*.ts, and the tests listed above.

**Acceptance criteria.**
- `buildRunPrompt` is declared and `buildTickPrompt` survives only as an alias.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/prompt src/inbox src/operator` prints only serialized names and string literals.
- No behavior change: the assembled prompts in the tests are byte-identical, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 17/20: Convert config and roles and init (planned 2026-10-16 by user; requires part 16/20 landed; design in plans/terminology.md "Code names"; touches src/config/ + src/roles/ + src/init/ + their tests)

**Goal.** The config, role and init modules and their tests use run wording and the new prompt-builder name.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names. The legacy config keys `minTickIntervalSeconds` and `tickTimeoutSeconds` stay in the alias tables, and test/config-validation.test.ts's near-miss `tickTimeoutSecondss`-style fixtures belong to Plain terms commands. Name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/roles/: `LONGEST_LEGITIMATE_TICK_S` → `LONGEST_LEGITIMATE_RUN_S` and the local `tickInterval` → `runInterval`; migrate `deferRun`, `eventRun`, `runStartMap` and `assembleRunPrompt` uses; convert comments in role-view.ts, roles.ts, role-render.ts, role-catalog.ts and role-guidance.ts. Comments only; strings are not this series'.
- src/config/ (config-schema.ts has about 29 comment lines, plus config.ts, config-views.ts, config-validation.ts, config-fallbacks.ts, config-write.ts, config-live.ts and config-field-checks.ts) and src/init/ (init.ts, init-templates.ts): comments and uses.
- Tests: test/prompt-roles.test.ts (migrate `buildRunPrompt`, then delete the `buildTickPrompt` alias if nothing else names it), test/role*.test.ts, test/config*.test.ts and test/init*.test.ts.

**Files touched.** src/config/*.ts, src/roles/*.ts, src/init/*.ts, the `buildTickPrompt` alias in src/prompt/prompt.ts, and the tests listed above.

**Acceptance criteria.**
- `LONGEST_LEGITIMATE_RUN_S` is declared, and `buildTickPrompt` appears nowhere unless another file still names it.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/config src/roles src/init` prints only the legacy config-key aliases and serialized names.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 18/20: Convert the merge and review and verdict and baseline modules (planned 2026-10-16 by user; requires part 17/20 landed; design in plans/terminology.md "Code names"; touches src/merge/ + src/review/ + src/verdict/ + src/baseline/ + their tests)

**Goal.** The merge pipeline, the reviewer, the verdict parsers and the main-baseline modules use run wording and `RunResult`/`RunOutcome`.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names. Merge-queue entry fields and the `Run:`/`Tick:` trailer parsers are Plain terms state's: both trailer spellings must still parse. Name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run": the reviewer's runs are "review runs"; a bare "the run" there that means the reviewer's agent invocation → "the agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- src/merge/ (merge-core.ts, merge-to-main.ts, merge-queue.ts, merge-check-failures.ts, merge-batch.ts, merge-slot.ts, merge-pipeline.ts, merge-drain.ts, merge-git.ts, merge-verify.ts, merge-queue-render.ts; names as Plain terms code merge left them): migrate `TickResult` → `RunResult` (about 29 lines) and `runTimedRoleRun`, `runOnce` and `finalizeRun` uses, and convert comments.
- src/review/ (review.ts, review-precheck.ts, review-verdict.ts), src/verdict/ (refusal.ts, no-change.ts, reply-contract.ts, fix-claim.ts) and src/baseline/ (main-red.ts, main-baseline.ts; its "run" nouns are mostly check runs, which stay): uses and comments.
- Tests: the merge tests and fixtures (test/merge*.test.ts, test/merger*.test.ts, test/fixtures/merge*-fixtures.ts and test/fixtures/merger-fixtures.ts), test/review*.test.ts, test/reply-contract.test.ts, test/refusal.test.ts, test/main-*.test.ts, test/fix-claim.test.ts and test/exemptions.test.ts.

**Files touched.** src/merge/*.ts, src/review/*.ts, src/verdict/*.ts, src/baseline/*.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b' src/merge src/review src/verdict src/baseline` prints only the legacy `Tick:` trailer pattern and serialized names.
- Both `Run:` and `Tick:` trailers still parse (their existing tests pass unchanged apart from titles).
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code run, part 19/20: Rename the start command code and convert CLI and team and doctor and status modules (planned 2026-10-16 by user; requires part 18/20 landed; design in plans/terminology.md "Code names" and "Commands and config"; touches src/cli/ + src/cli.ts + src/process/supervisor.ts + src/build/build-stage.ts + src/team/ + src/doctor/ + src/status/ + src/backlog/ + src/brief/ + src/change/ + src/redeploy/ + root modules + their tests)

**Goal.** The `tumwater start` command's code is named for it (`cmdStart`, `START_FLAG_SPECS`, `superviseStart`, `spawnStartChild`). The CLI, team, doctor, status, backlog, brief, change and redeploy modules lose their tick wording.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, and serialized names; name any leftover serialized name in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run"; in src/cli/cli-start.ts, "this run" meaning the whole `tumwater start` process → "this session". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - An export used outside this part keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, unless it has about five or fewer outside use lines, which you migrate instead. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members get no alias. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias nothing else names (test/exports.test.ts).
- Start-command names: in src/cli/cli-start.ts, `cmdRun` → `cmdStart` and `superviseRunCommand` → `superviseStartCommand`; in src/cli/cli-flag-specs.ts, `RUN_FLAG_SPECS` → `START_FLAG_SPECS`; in src/process/supervisor.ts, `superviseRun` → `superviseStart` and `spawnRunChild` → `spawnStartChild`, with their uses in src/cli.ts, src/cli/cli-start.ts and src/build/build-stage.ts and their tests. Plain terms commands may already have renamed some of these; rename whichever remain.
- Do not change any argv. The supervisor spawns its child as `["run", …extraArgs]` (in `spawnStartChild`), and that literal `run` must stay. `run` stays a hidden alias of `tumwater start`, so a rollback to an older build, whose CLI only knows `run`, can still respawn the child. Add a one-line comment at the spawn site saying so. Likewise keep src/cli.ts's `case "run":` dispatch (the hidden alias), and keep every `cli(…, "run", …)` and `spawnCli(…, ["run"])` call in tests that deliberately exercises the alias.
- Other src/cli/ renames: `ticksBefore` → `runsBefore` and `ticksThisRound` → `runsThisRound` (parameters and locals in cli-start.ts), and the local `tickRow` → `runRow`. Migrate `cmdRunDetail`, `RUN_DETAIL_USAGE`, `summarizeRunRows` and `readRunRowsSince` uses, and delete those aliases if this was their last user. Convert comments in cli-start.ts (about 37 lines), cli-flag-specs.ts, cli-command-args.ts, help.ts, config-commands.ts and cli-query-commands.ts; help text strings are not this series'.
- Root modules: src/request-timeouts.ts `tickCapS` → `runCapS`; comments in src/cli.ts, src/paths.ts and src/collections.ts.
- src/team/, src/doctor/, src/status/, src/backlog/, src/brief/, src/change/ and src/redeploy/ (redeploy-policy.ts and redeployer.ts have about 32 lines): comments and uses (`roleRunP75Ms`, `RUN_TIMEOUT_KEY`, `lastRunCell`).
- Tests: test/cli-start*.test.ts, test/cli.test.ts, test/cli-operators*.test.ts, test/cli-queue.test.ts, test/cli-command-args.test.ts, test/cli-arg-strictness.test.ts (its `cli(repo, "tick", …)` call exercises the hidden alias; keep it), test/cli-preflight.test.ts, test/cli-output.test.ts, test/cli-harness.test.ts, test/completion.test.ts, test/team*.test.ts, test/doctor*.test.ts, test/status-data*.test.ts, test/redeploy*.test.ts, test/error-storm.test.ts, test/backlog-*.test.ts, test/brief.test.ts, test/change-data.test.ts, test/paths.test.ts, test/request-timeouts.test.ts, test/build-stage.test.ts, test/supervisor.test.ts, test/helpers/start-live-harness.ts, test/helpers/wait.ts, test/helpers/oracles.ts and test/fixtures/status-fixtures.ts.

**Files touched.** src/cli/*.ts, src/cli.ts, src/process/supervisor.ts, src/build/build-stage.ts, src/request-timeouts.ts, src/paths.ts, src/collections.ts, src/team/*.ts, src/doctor/*.ts, src/status/*.ts, src/backlog/*.ts, src/brief/*.ts, src/change/*.ts, src/redeploy/*.ts, and the tests listed above.

**Acceptance criteria.**
- `cmdStart`, `START_FLAG_SPECS`, `superviseStart`, `superviseStartCommand` and `spawnStartChild` are declared; `cmdRun`, `RUN_FLAG_SPECS`, `superviseRun` and `spawnRunChild` appear nowhere in src/ or test/.
- The supervisor's spawn argv is still `["run", …]` and src/cli.ts still dispatches `run`: test/supervisor.test.ts and the test/cli-start*.test.ts suites pass with their argv assertions unchanged.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_|\bticks?\b'` over this part's src directories prints only hidden-alias strings and serialized names.
- `npm run test` passes.

### Plain terms code run, part 20/20: Convert the agent backends and sweep and retire the old run names (planned 2026-10-16 by user; requires part 19/20 landed; design in plans/terminology.md "Code names" and "Guards"; touches src/pi/ + src/agent/ + src/pi-extension/ + every remaining file with a tick name + test/retired-names.test.ts)

**Goal.** No identifier, file name, comment or test title in src/ or test/ says "tick" for a run, the agent backends say "agent run" where a bare "run" was ambiguous, every deprecated alias from this series is gone, and test/retired-names.test.ts fails if an old run name comes back.

**Approach.**
- Series rules (every code-run part):
  - Identifier words follow plans/terminology.md "Code names", row "tick": `tick`/`Tick`/`TICK` → `run`/`Run`/`RUN`, `ticks` → `runs`, `ticked` → `ran`. Settled collisions: `runTick` → `runOnce`, `runTimedRoleTick` → `runTimedRoleRun`, `tickModel` → `runModelPair`, `ticksRun` → `runsDone`, `cmdTick` → `cmdRunDetail`.
  - A bare `tick` binding or in-process field holding a run number → `runNumber`; `ticks` holding a count → `runs`, or `runCount` if `runs` is bound in scope. Never shadow an existing binding such as `run`.
  - Keep `backtick*`, `process.nextTick`, `processTicksAndRejections`, `sticky`, node:test mock-clock `tick(ms)` calls and their helpers, hidden-alias argv strings (`"tick"`, `"run"`), legacy readers' old names, and serialized names.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - Comments and test titles: "tick" → "run" (and "ticks", "ticked", "mid-tick", "per-tick" alike), `tumwater tick <role> <n>` → `tumwater history <role> <n>`, `tumwater run` → `tumwater start`. A bare noun "run" meaning one agent invocation → "agent run". Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
- src/pi/ (pi-watchdogs.ts, pi-run-result.ts, pi-stream.ts, pi-args.ts, pi-event-line.ts, pi-bin.ts, pi-backend.ts, command-shape.ts), src/agent/ (run-agent.ts, session-ledger.ts, claude/claude-args.ts, claude/claude-account.ts) and src/pi-extension/ (full-output.ts, context-shake.ts, context-budget.ts, bounded-output.ts): the `PiWatchdogs`/run-agent member `tickTimeoutMs` → `runTimeoutMs`; "the tick deadline" → "the run deadline"; and the "agent run" rule, which matters most here because "run" in these modules almost always means one pi or claude process. "pi run" stays.
- Sweep everything left: run `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_' src test` and `grep -rnwiE 'ticks?|ticked|ticking' src test`, and convert every run sense, including files a feature added during this series. Known stragglers: test/pi*.test.ts, test/fixtures/repo-fixtures.ts, test/test-runner.ts, test/agent-commit-fold.test.ts (`tickAndMerge` → `runAndMerge`), test/fakes-catalog.test.ts, test/fakes/fake-pi.ts, test/helpers/wait.ts and test/fixtures/pi-events.ts.
- Delete every remaining `@deprecated` alias this series added (`grep -rn '@deprecated Use' src test`), after migrating their last users.
- Append a `run` family to the guard in test/retired-names.test.ts, in the `{ family, words, fileWords, allow }` shape. Use `words: ["tick", "ticks", "ticked", "ticking"]`, `fileWords: ["tick", "ticks"]` and `allow: ["nextTick", "processTicksAndRejections"]` (Node's names, with that reason comment). The `tumwater run` command's old code names cannot be words, because "run" is the new word. List them exactly in an optional `identifiers` field: `cmdRun`, `RUN_FLAG_SPECS`, `superviseRun`, `superviseRunCommand`, `spawnRunChild`. Plain terms code team's design anticipates that field; if the guard has no `identifiers` yet, add it, with a guard test that an exact name fails. The node:test mock-clock calls (`t.mock.timers.tick(…)` and test/inbox.test.ts's clock helper) get `// retired-name-ok: node:test mock clock` lines. Legacy readers use the guard's existing exemptions: `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines, and `retired-name-ok:start`/`end` regions. Add no new mechanism.
- Run the retired-names guard and fix what it reports. A hit inside a legacy reader that must keep an old name (the `tick_*` event-type table, the `ticks`/`lastTickEndedAt` state-key map, the legacy `Tick:` trailer parser) gets the guard's own exemption (its allowlist or per-line marker), not a rename.

**Files touched.** src/pi/*.ts, src/agent/**/*.ts, src/pi-extension/*.ts, the remaining stragglers, the alias declarations across src/run/, src/history/, src/events/, src/files/, src/scheduling/, src/budget/, src/prompt/ and test/fixtures/orchestrator-fixtures.ts, and test/retired-names.test.ts.

**Acceptance criteria.**
- `grep -rn '@deprecated Use' src test` lists none of this series' old names.
- `grep -rnE '[Tt]ick[A-Z]|[a-z0-9]Tick|TICK_' src test` lists only `backtick*`, `nextTick`, `processTicksAndRejections`, sites the retired-names guard exempts (the legacy readers), and the retired-names list itself.
- test/retired-names.test.ts holds the `run` family, including the `identifiers` list, and passes; adding `type TickResult = 1;` or `const cmdRun = 1;` to any src/ module makes it fail (check locally, do not commit).
- `npm run test` passes.

### Plain terms code cleanup, part 1/7: Rename notebook to notes and the initial prompt to the brief text in code (planned 2026-10-16 by user; requires Plain terms code run 20/20 landed; design in plans/terminology.md "Code names"; touches src/brief/ + src/init/ + src/prompt/ + src/run/run-prompt.ts + src/inbox/inbox-submit.ts + src/cli/brief-command.ts + src/ui/tui/ + comments naming the notebook + their tests)

**Goal.** Code says "notes" for a role's scratch file and names the project description after the brief: `readBriefText`, `editBriefText`, `replaceBriefText`, `BRIEF_TEXT_MAX_CHARS` and `briefText`. No identifier, comment or test title says "notebook" or "initial prompt".

**Approach.**
- Rules for this part:
  - Leave record prose alone: do not edit BUGS.md, PLANS.md, QUESTIONS.md, PLANS-DONE.md, BUGS-FIXED.md or any `plans/*.md`, even for the paths this part moves. Their old names are correct as written: finished entries record files as they were, and open plans name both sides of the moves they describe. This rule was added 2026-10-19 by user, after a sweep through them got Plain terms code runner part 1/14 rejected five times. The pre-queue self-check no longer lists these files; a review objection asking for them to be swept is outside this part's scope, so say so in RISK.
  - Glossary: "notes" replaces "notebook" and "brief" replaces "initial prompt" (plans/terminology.md "Glossary" and "Code names").
  - In code, `brief` already names the brief file's name (`const brief = briefState?.file` in src/run/run-prompt.ts, the `brief` parameter of `buildDirectorPrompt`), and `readBrief()` returns `{ file, prompt }`. So the initial prompt's text becomes `briefText`, never a bare `brief`, which would shadow or collide.
  - Serialized names and markers stay: the `<!-- tumwater:prompt:start -->`/`end` markers and the `PROMPT_START`/`PROMPT_END` constants, the `--clear-notes` flag, `state/notes/` paths, and `role --json`'s `notes` key. User-visible strings were Plain terms text's; leave string literals alone.
  - Legacy readers keep old names on purpose; rename nothing inside them (`normalizeLegacyEvent`'s tables, the state loaders' legacy-key maps, the `legacyLand*` helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES`, src/roles/legacy-role-ids.ts, and fixtures that write old names on purpose).
  - Comments and test titles follow the glossary. Leave quoted PLANS.md/BUGS.md titles (for example PLANS.md "Role notebook"), `plans/*.md` names and commit subjects (`tumwater(operator): Edit initial prompt`) alone (test/plan-citations.test.ts). Rewrap comment lines past 100 columns (test/comment-width.test.ts).
  - Exports used outside this part's files keep a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen, only while another file still names the old name. This part migrates every user, so it should end with none (test/exports.test.ts).
- src/brief/brief.ts: `readInitialPrompt` → `readBriefText`, `replaceInitialPrompt` → `replaceBriefText`, `INITIAL_PROMPT_MAX_CHARS` → `BRIEF_TEXT_MAX_CHARS`, and the `initialPrompt` parameters of `managedSections`, `readmeTemplate` and `briefTemplate` → `briefText`. src/brief/brief-edit.ts: `editInitialPrompt` → `editBriefText`. Migrate uses in src/init/init.ts, src/inbox/inbox-submit.ts (`DIRECTOR_PROMPT_MAX_CHARS = BRIEF_TEXT_MAX_CHARS`), src/cli/brief-command.ts and src/run/run-prompt.ts.
- src/prompt/prompt.ts: the `initialPrompt` member of the prompt-input interface, `sharedPreamble(initialPrompt, …)` and `buildDirectorPrompt`'s `initialPrompt` parameter → `briefText`, with every use, including src/run/run-prompt.ts's local `initialPrompt` → `briefText`.
- notebook: test/role-view.test.ts's local `notebookAt` → `notesAt`. `git mv test/tui-notebook.test.ts test/tui-notes.test.ts`, then check `docs/invariants.md` and DEVELOPMENT.md for a citation of the old name. Convert "notebook" in comments and test titles across src/ and test/ ("the role's notebook" → "the role's notes"; "the notebook view" → "the notes view"): src/ui/tui/tui-keys.ts, tui-pane.ts, src/paths.ts, src/roles/role-view.ts, src/agent/role-notes-write.ts, src/agent/run-agent.ts, src/agent/agent-backend.ts, src/cli/cli-query-commands.ts and the rest that `grep -rniw 'notebook' src test` lists.
- Finish with `grep -rniE 'notebook|initial[- ]?prompt|INITIAL_PROMPT' src test`, which may list only string literals Plain terms text deliberately kept, quoted titles and commit subjects, and legacy readers.

**Files touched.** src/brief/brief.ts, src/brief/brief-edit.ts, src/init/init.ts, src/inbox/inbox-submit.ts, src/cli/brief-command.ts, src/prompt/prompt.ts, src/run/run-prompt.ts, comment-only files the notebook grep lists (src/ui/tui/, src/agent/, src/paths.ts, src/roles/role-view.ts, src/cli/cli-query-commands.ts, …), test/tui-notes.test.ts (renamed), test/role-view.test.ts, test/brief*.test.ts, test/init*.test.ts, test/prompt*.test.ts.

**Acceptance criteria.**
- `readBriefText`, `editBriefText`, `replaceBriefText` and `BRIEF_TEXT_MAX_CHARS` are declared, and none of `readInitialPrompt`, `editInitialPrompt`, `replaceInitialPrompt`, `INITIAL_PROMPT_MAX_CHARS` or an `initialPrompt` identifier remains in src/ or test/.
- test/tui-notes.test.ts exists and test/tui-notebook.test.ts does not.
- The grep in the last Approach bullet lists only the exceptions named there.
- `npm run test` passes.

### Plain terms code cleanup, part 2/7: Rename custom-loop and role-id names in code (planned 2026-10-16 by user; requires part 1/7 landed; design in plans/terminology.md "Code names" and "Role names"; touches src/config/ + src/run/telemetry-digest.ts + src/run/run-prompt.ts + comments naming the dry or telemetry roles + their tests + test/retired-names.test.ts)

**Goal.** Code names custom roles as custom roles (`CustomRole`, `customRoleNames`, `CUSTOM_ROLE_KEYS`) and names the renamed roles by their new ids: `selfcheck-digest.ts`, `selfcheckDigest`, `SELFCHECK_DIGEST_DAYS` and dedupe-named test locals.

**Approach.**
- Rules for this part:
  - Leave record prose alone: do not edit BUGS.md, PLANS.md, QUESTIONS.md, PLANS-DONE.md, BUGS-FIXED.md or any `plans/*.md`, even for the paths this part moves. Their old names are correct as written: finished entries record files as they were, and open plans name both sides of the moves they describe. This rule was added 2026-10-19 by user, after a sweep through them got Plain terms code runner part 1/14 rejected five times. The pre-queue self-check no longer lists these files; a review objection asking for them to be swept is outside this part's scope, so say so in RISK.
  - Glossary: plans/terminology.md "Code names" rows "customLoop(s)" and "dry, telemetry"; "Role names" for the ids.
  - The legacy config key `customLoops` and the legacy role ids `dry` and `telemetry` stay where they are aliases: `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `normalizeLegacyEvent`'s tables, and fixtures that deliberately write old ids. Rename nothing inside them; the retired-names guard exempts them through `LEGACY_FILES`, `legacy`-prefixed identifiers and `retired-name-ok` lines or regions.
  - Keep "telemetry" in its generic sense ("prompt-token telemetry", claude's `DISABLE_TELEMETRY` env var, the `plans/telemetry-role.md` file name), "dry run"/`--dry-run`/`dryRun`/`DRY_RUN_FLAG`, and quoted PLANS.md/BUGS.md titles and commit subjects (`tumwater(telemetry)` in git history greps is a legacy reader).
  - Rewrap comment lines past 100 columns (test/comment-width.test.ts). Exports used elsewhere need no alias: migrate every user in this part.
- customLoop: in src/config/config-schema.ts, `interface CustomLoop` → `CustomRole`; `customLoopNames` → `customRoleNames` and `CUSTOM_LOOP_KEYS` → `CUSTOM_ROLE_KEYS` wherever declared; any remaining `customLoops` binding that is not the legacy key's alias handling → `customRoles`. Plain terms commands renamed the config field itself. The test role names `my-custom-loop`, `custom-loop` and `myloop` in config tests → `my-custom-role`, `custom-role` and `myrole`, unless a test is pinning the legacy key.
- Role ids: `git mv src/run/telemetry-digest.ts src/run/selfcheck-digest.ts` and `test/telemetry-digest.test.ts` → `test/selfcheck-digest.test.ts`; `telemetryDigest` → `selfcheckDigest` and `TELEMETRY_DIGEST_DAYS` → `SELFCHECK_DIGEST_DAYS`, with the import in src/run/run-prompt.ts. Update any docs/invariants.md or DEVELOPMENT.md citation of the old path in this part (test/invariants-doc.test.ts fails on a missing cited path). Test locals: `dryRow` (test/status-render.test.ts) → `dedupeRow`, `dryFailedAt` (an orchestrator e2e test) → `dedupeFailedAt`, any `dryRuns`/`dryTicks` → `dedupeRuns`, and marker files such as `dry-reviewing` → `dedupe-reviewing` when the test's role is now `dedupe`.
- Comments naming the roles (about 45 "telemetry" and 28 "dry" comment lines today): "the telemetry role" → "the selfcheck role"; role lists such as "(organize, clean, dry, perf, …)" → "dedupe"; `tumwater(telemetry)` in comments → `tumwater(selfcheck)`, except where the comment describes the legacy match.
- In test/retired-names.test.ts, remove `CustomLoop`, `customLoopNames` and `CUSTOM_LOOP_KEYS` from the `runner` family's `allow` list (Plain terms code runner put them there until this part), keeping `customLoops`, the live legacy key. The guard then fails if they come back.
- Finish with `grep -rnE '[Cc]ustomLoop|CUSTOM_LOOP|[Tt]elemetry[A-Z_]|TELEMETRY_' src test` and `grep -rnwE 'dry|telemetry' src test`, and check each hit against the keep list above.

**Files touched.** src/config/config-schema.ts and the src/config/ files declaring or using `customLoopNames`/`CUSTOM_LOOP_KEYS`, src/run/selfcheck-digest.ts (renamed), src/run/run-prompt.ts, comment-only files the role-id grep lists, test/selfcheck-digest.test.ts (renamed), test/config*.test.ts, test/status-render.test.ts, test/orchestrator*.e2e.test.ts, test/retired-names.test.ts (`allow` entries only).

**Acceptance criteria.**
- `CustomRole`, `customRoleNames`, `CUSTOM_ROLE_KEYS`, `selfcheckDigest` and `SELFCHECK_DIGEST_DAYS` are declared; src/run/selfcheck-digest.ts and test/selfcheck-digest.test.ts exist and the telemetry-digest files do not.
- The two greps in the last Approach bullet list only the exempt legacy readers and the generic senses named there.
- Config files using the legacy `customLoops` key still load (their existing alias tests pass unchanged).
- `npm run test` passes.

### Plain terms code cleanup, part 3/7: Rename the backend selector types and helpers in config and agent and pi (planned 2026-10-16 by user; requires part 2/7 landed; design in plans/terminology.md "Code names" and "Commands and config"; touches src/config/ + src/agent/ + src/pi/ + their tests)

**Goal.** The code that names which backend runs a role, pi or claude, says "backend" instead of "agent": `BackendId`, `BACKEND_IDS`, `DEFAULT_BACKEND`, `resolveBackendBin` and so on. Deprecated aliases stay for the callers part 4/7 migrates.

**Approach.**
- Rules for this part:
  - plans/terminology.md "Code names" row "agent": rename only "agent" meaning the backend selector (pi/claude). "Agent" meaning the model or process doing the work stays: `runAgent`, `AgentRunSpec`, `AgentInvocation`, `AgentExitInfo`, `AgentExitClassification`, `AgentBackend` and `registerAgentBackend` (an agent's backend), `foldAgentCommitsSince`, pi's protocol events `agent_start`/`agent_end` and `agentStart`, `PI_CODING_AGENT_DIR`, `piAgentDir`/`agentDir`/`getAgentDir`, `CLAUDE_AGENT_SDK_*`, `AGENT_WRAPPER_RAN`, `onAgentWarning`, and everything about the `AGENTS.md` file (`shouldAppendAgents`). "Agent run" (one invocation) stays.
  - Legacy config keys stay where they are aliases: `agent`, `agents`, `agentBin` and `piArgs` in `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) and the code that drops or maps them (`dropAgentBin`, a `raw.agents` read). Rename nothing inside legacy readers; the retired-names guard exempts them through `LEGACY_FILES`, `legacy`-prefixed identifiers and `retired-name-ok` lines or regions.
  - Serialized names were renamed by Plain terms commands and scripting (`backend`, `backends`, `budget.backend`); do not touch string literals.
  - A bare `agent`/`agents` binding that holds a backend id → `backend`/`backends`, never shadowing an existing binding.
  - Comments: "the role's agent (pi or claude)" → "the role's backend"; leave "agent" meaning the model at work. Rewrap comment lines past 100 columns (test/comment-width.test.ts).
  - An export used outside this part's files keeps a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Members (interface fields, methods, parameters) get no alias: rename all their uses in this part, even outside these directories. Delete any alias no other file names (test/exports.test.ts).
- Renames, with aliases where callers outside src/config, src/agent and src/pi remain:
  - src/config/config-schema.ts: `AGENT_IDS` → `BACKEND_IDS`, `AgentId` → `BackendId`, `AgentConfig` → `BackendConfig` (if Plain terms commands did not already rename them).
  - src/config/model-selector.ts: `isAgentId` → `isBackendId`, and `routeModel`'s `configAgent` parameter → `configBackend`.
  - src/config/config-keys.ts: `AGENT_KEYS` → `BACKEND_KEYS`.
  - src/config/config-views.ts: `resolvedAgentConfig` → `resolvedBackendConfig`, `agentQualifiedSelector` → `backendQualifiedSelector`, `agentDefault` → `backendDefault`.
  - src/config/config-live.ts: `resolveAgentBin` → `resolveBackendBin`, `findAgentBinary` → `findBackendBinary`, `agentMissingMessage` → `backendMissingMessage`, and the local `prevAgents` → `prevBackends`.
  - src/config/config.ts and config-write.ts: `collapseAgentAliases` → `collapseBackendAliases`.
  - src/agent/agent-backend.ts: `DEFAULT_AGENT` → `DEFAULT_BACKEND`, `AgentBinConfig` → `BackendBinConfig`, `agentBackend(id)` → `backendById(id)`, `agentSessionResumable` → `backendSessionResumable`, `ResolvedAgentBin` → `ResolvedBackendBin`.
  - src/agent/claude/claude-backend.ts and src/config/model-selector.ts: `AGENT_DEFAULT_MODELS` → `BACKEND_DEFAULT_MODELS`. src/agent/claude/claude-backend.ts and src/pi/pi-backend.ts: `agentBaseEnv` → `backendBaseEnv`.
  - src/pi/pi-bin.ts: `agentBinSourceLabel`/`agentBinSourceLabelFor` → `backendBinSourceLabel`/`backendBinSourceLabelFor`, `AgentBinSource` → `BackendBinSource`, `agentBinConfigKey` → `backendBinConfigKey`, `agentBinEnv` → `backendBinEnv`, `agentsInUse` → `backendsInUse`.
  - Also rename bare backend-id bindings and comments in these three directories (src/config has about 20 such declarations, src/agent 13, src/pi 11).
- Tests: test/config*.test.ts, test/pi-bin.test.ts (about 30 lines), test/session-ledger.test.ts, test/claude-*.test.ts, test/agent-backend.test.ts and test/model-selector*.test.ts.

**Files touched.** src/config/*.ts except config-aliases.ts's legacy table, src/agent/**/*.ts, src/pi/*.ts, and the tests listed above.

**Acceptance criteria.**
- The new names above are declared; each old name exists only as a deprecated alias that some file outside src/config, src/agent and src/pi still uses.
- `grep -rnE '\b(AgentId|AGENT_IDS|isAgentId|DEFAULT_AGENT|AgentConfig|AgentBinConfig|AGENT_KEYS|resolveAgentBin|findAgentBinary|agentsInUse|collapseAgentAliases)\b' src/config src/agent src/pi` lists only the alias lines.
- A config using the legacy `agent`/`agents`/`agentBin` keys still loads (the alias tests pass unchanged).
- `npm run test` passes.

### Plain terms code cleanup, part 4/7: Migrate the backend selector callers and retire the cleanup names (planned 2026-10-16 by user; requires part 3/7 landed; design in plans/terminology.md "Code names" and "Guards"; touches src/doctor/ + src/gates/ + src/roles/ + src/prompt/ + src/ui/ + src/run/ + src/runner/ + src/status/ + src/cli/ + src/review/ + src/paths.ts + their tests + test/retired-names.test.ts)

**Goal.** Every caller uses the backend names from part 3/7, the deprecated aliases are gone, and test/retired-names.test.ts lists the old names of all the cleanup families, so the code rename is complete.

**Approach.**
- Rules for this part:
  - Rename only "agent" meaning the backend selector (pi/claude), as in part 3/7. Keep `runAgent`, `AgentRunSpec`, `AgentInvocation`, `AgentExit*`, `AgentBackend`, `registerAgentBackend`, `foldAgentCommitsSince`, pi protocol names, `PI_CODING_AGENT_DIR`, `AGENTS.md` handling, and "agent run".
  - Legacy readers keep old names on purpose (`CONFIG_KEY_RENAMES`, src/roles/legacy-role-ids.ts, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `normalizeLegacyEvent`'s tables, the state loaders' legacy-key maps, the `legacyLand*` helpers, and fixtures that write old names). The retired-names guard exempts them through `LEGACY_FILES`, `legacy`-prefixed identifiers and `retired-name-ok` lines or regions; never add a second mechanism.
  - Members (fields, methods, parameters) are renamed with all their uses. Never shadow an existing binding. Rewrap comment lines past 100 columns (test/comment-width.test.ts).
- Callers to migrate:
  - src/doctor/ (doctor.ts, doctor-checks.ts, doctor-model-checks.ts): `checkAgentBinary` → `checkBackendBinary`, `agentBinaryCheck` → `backendBinaryCheck`, plus uses of `agentsInUse`, `isAgentId`, `agentQualifiedSelector` and `agentBaseEnv`.
  - src/gates/ (readiness.ts, startup-gate.ts), src/roles/ (role-render.ts's `agentDefault` function → `backendDefault`), src/ui/badges.ts's local `agentDefault` → `backendDefault`, src/status/, src/cli/, src/review/ (`agentSessionResumable`) and src/prompt/: migrate.
  - Members holding a backend id: `RunPromptInput.agent` (src/run/run-prompt.ts) → `backend`; `RoleRunner.runPrompt(agent?)` and `RunnerRunContext.runPrompt(agent?)` parameters → `backend`; `buildDirectorPrompt`'s backend parameter; `nativeLogPath(root, role, agent)` in src/paths.ts → `backend`. Rename each with all its uses.
- Tests: test/doctor-checks.test.ts (about 23 lines), test/doctor-model-checks.test.ts, test/run-resume.test.ts, test/gui-operator.test.ts, test/gui-client-settings.test.ts, test/status-data-budget.test.ts, test/runner-pi*.test.ts, test/review-followup.test.ts, test/provider-lease.test.ts, test/pi.test.ts and test/fakes/fake-pi.ts.
- Delete every alias part 3/7 added (`grep -rn '@deprecated Use' src test` must list none from this series).
- Extend the guard in test/retired-names.test.ts (shape `{ family, words, fileWords, allow }`, plus the optional exact-name `identifiers` field Plain terms code run 20/20 added):
  - a `notes` family: `words: ["notebook", "notebooks"]`, `fileWords: ["notebook"]`;
  - a `brief` family: `identifiers: ["initialPrompt", "readInitialPrompt", "editInitialPrompt", "replaceInitialPrompt", "INITIAL_PROMPT_MAX_CHARS"]`;
  - a `role-ids` family: `identifiers: ["telemetryDigest", "TELEMETRY_DIGEST_DAYS", "dryRow", "dryFailedAt"]`. Not the words `dry` or `telemetry`, which still mean a dry run, generic telemetry and `DISABLE_TELEMETRY`;
  - a `backend` family: `identifiers: ["AgentId", "AGENT_IDS", "isAgentId", "DEFAULT_AGENT", "AgentConfig", "AgentBinConfig", "AGENT_KEYS", "resolveAgentBin", "findAgentBinary", "checkAgentBinary", "agentMissingMessage", "agentsInUse", "collapseAgentAliases", "resolvedAgentConfig", "agentQualifiedSelector", "AGENT_DEFAULT_MODELS", "agentBaseEnv", "agentBinSourceLabel", "agentSessionResumable"]`.
  Never list `customLoops`, `agent`, `agents`, `agentBin`, `dry` or `telemetry`: they are live legacy keys and ids. Legacy readers use the guard's existing exemptions: `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines, and `retired-name-ok:start`/`end` regions. Add no new mechanism.
- Confirm the guard now covers all five code families (team, merge, runner, run, cleanup). If an earlier family's last part missed an entry its own entry named, add it here.

**Files touched.** The caller files above, the alias declarations in src/config/, src/agent/ and src/pi/, the tests listed above, and test/retired-names.test.ts.

**Acceptance criteria.**
- `grep -rn '@deprecated Use' src test` prints nothing.
- `grep -rnE '\b(AgentId|AGENT_IDS|isAgentId|DEFAULT_AGENT|AgentConfig|AgentBinConfig|AGENT_KEYS|resolveAgentBin|findAgentBinary|checkAgentBinary|agentsInUse)\b' src test` lists only the retired-names list and exempt legacy readers.
- test/retired-names.test.ts passes with the new families; adding `const readInitialPrompt = 1;` or `const notebookPath = 1;` to a src/ module makes it fail (check locally, do not commit).
- `npm run test` passes.

### Plain terms code cleanup, part 5/7: Scan every module with the vocabulary guard and fix the first half of src (planned 2026-10-16 by user; requires part 4/7 landed; design in plans/terminology.md "Guards" and "Wording rules"; touches test/vocabulary.test.ts + test/helpers/legacy-files.ts + test/retired-names.test.ts + string literals in src/agent/ through src/init/ + src/*.ts)

**Goal.** test/vocabulary.test.ts scans every src/ module, not only those with the `// vocabulary: plain` header, except the directories listed in a new pending set. This part cleans the first half of src/ (agent through init, plus the root modules) and removes them from that set.

**Approach.**
- Guard change in test/vocabulary.test.ts:
  - Add `PENDING_VOCABULARY_DIRS`, a set of src/ directory paths whose header-less modules the guard still skips. Change the guard's single opt-in test, `optedIn(text)` (Plain terms groundwork put it in one function for this flip), to take the module path as well, and return true when the module has the header or lies outside the pending set. Modules that carry the header keep being scanned wherever they live.
  - Every other module under src/ is scanned with the existing rules (string literals and template-literal text, word-bounded, case-insensitive, a line ending `// vocabulary-ok: <reason>` exempt).
  - The set starts as the second half of src/: `src/merge`, `src/operator`, `src/orchestrator`, `src/pi`, `src/pi-extension`, `src/process`, `src/prompt`, `src/redeploy`, `src/report`, `src/review`, `src/roles`, `src/run`, `src/runner`, `src/scheduling`, `src/status`, `src/team`, `src/text`, `src/ui`, `src/verdict`. Part 6/7 empties it.
  - Add a test that fails when a set entry names a directory that does not exist, so the set cannot rot.
- Legacy readers must name old words on purpose, and they need the same exemption in both guards:
  - Move test/retired-names.test.ts's `LEGACY_FILES` list into a small shared helper, test/helpers/legacy-files.ts, so a test file never imports another test file (that would register its tests twice). Import the helper from both guards.
  - Make the vocabulary guard skip the `LEGACY_FILES` modules and honor the retired-names guard's `retired-name-ok:start`/`end` regions and `// retired-name-ok:` lines as well as its own `// vocabulary-ok:`. One marker then serves both guards: `normalizeLegacyEvent`'s tables, the state loaders' legacy-key maps, the `legacyLand*` helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, and src/roles/legacy-role-ids.ts.
  - Pin both behaviors with a guard test.
- Then fix every hit the guard reports in src/agent, src/backlog, src/baseline, src/brief, src/budget, src/build, src/change, src/cli, src/concurrency, src/config, src/doctor, src/events, src/failure, src/files, src/gates, src/git, src/gui, src/history, src/inbox, src/init and the root modules (src/cli.ts, src/paths.ts, src/version.ts, …):
  - User-visible text a reader can see (CLI output, errors, warnings, agent prompts): reword per plans/terminology.md "Glossary" and "Wording rules".
  - Machine names that must stay: the `tumwater(operator):` prefix, hidden-alias argv (`"tick"`, `"run"`), git ref and directory names of legacy layouts, and env vars of other tools. These get `// vocabulary-ok: <reason>` at the end of the line.
  - Internal strings no user sees (cache keys, log tags, test seams): rename to plain words when nothing persisted depends on them; otherwise mark them `vocabulary-ok`.
- To list the hits, run the guard (`npm run test` filtered to vocabulary, as DEVELOPMENT.md describes the runner's file filter) and work directory by directory. If this half reports far more than about 300 lines, stop at a directory boundary, add the untouched directories back to `PENDING_VOCABULARY_DIRS`, and say so in the commit message; part 6/7 starts from whatever the set holds.

**Files touched.** test/vocabulary.test.ts; test/helpers/legacy-files.ts (new) and test/retired-names.test.ts (imports it); string literals in src/agent/ … src/init/ and the root src/*.ts modules. Tests asserting reworded output in the same directories (for example test/cli*.test.ts and test/doctor*.test.ts).

**Acceptance criteria.**
- test/vocabulary.test.ts scans every module outside `PENDING_VOCABULARY_DIRS` and passes; the set holds only second-half directories (plus any first-half ones this part's commit message names).
- Each surviving retired word in a scanned module sits on a `// vocabulary-ok: <reason>` line or in an exempt legacy reader.
- Adding `say("the fleet is idle")` to an unmarked module in src/cli/ makes the guard fail (check locally, do not commit).
- `npm run test` passes.

### Plain terms code cleanup, part 6/7: Fix the second half of src for the vocabulary guard (planned 2026-10-16 by user; requires part 5/7 landed; design in plans/terminology.md "Guards" and "Wording rules"; touches test/vocabulary.test.ts + string literals in the directories still in PENDING_VOCABULARY_DIRS)

**Goal.** `PENDING_VOCABULARY_DIRS` is empty: every src/ module passes the vocabulary guard, with or without a header.

**Approach.**
- Fix every hit the guard reports in the directories `PENDING_VOCABULARY_DIRS` still holds: the second half of src/ (merge … verdict, including src/ui/ and its gui/ and tui/ subdirectories), plus any first-half directory part 5/7 handed over. Apply the same treatment as part 5/7:
  - Reword user-visible text per plans/terminology.md "Glossary" and "Wording rules".
  - Mark machine names that must stay with `// vocabulary-ok: <reason>` (the `tumwater(operator):` prefix, hidden-alias argv, legacy layout names, other tools' env vars).
  - Rename or mark internal strings.
  - Legacy readers stay exempt through the shared retired-names exemption.
- The dashboard's gui-client modules are browser code inside String.raw templates, which the guard reads as template text. A code name inside the browser code that still trips it (a DOM id, a CSS class, a local) is renamed to a plain word, checking uniqueness across the concatenated client modules. An end-of-line `// vocabulary-ok:` there is a browser-side JS comment and is allowed.
- Remove each directory from `PENDING_VOCABULARY_DIRS` as it passes, then delete the set and its existence test once it is empty, leaving the guard's header rule for part 7/7.
- Update tests that assert reworded output in the same directories.

**Files touched.** test/vocabulary.test.ts; string literals in src/merge/, src/operator/, src/orchestrator/, src/pi/, src/pi-extension/, src/process/, src/prompt/, src/redeploy/, src/report/, src/review/, src/roles/, src/run/, src/runner/, src/scheduling/, src/status/, src/team/, src/text/, src/ui/ and src/verdict/ (only those with hits); their tests.

**Acceptance criteria.**
- `PENDING_VOCABULARY_DIRS` no longer exists, and the guard scans every src/ module and passes.
- Each surviving retired word in src/ string literals sits on a `// vocabulary-ok: <reason>` line or in an exempt legacy reader.
- No user-visible behavior changes beyond wording: every test passes, and any changed assertion changed only reworded text.
- `npm run test` passes.

### Plain terms code cleanup, part 7/7: Make the vocabulary guard cover all of src and drop the opt-in headers (planned 2026-10-16 by user; requires part 6/7 landed; design in plans/terminology.md "Guards"; touches test/vocabulary.test.ts + every src/ module carrying a vocabulary header)

**Goal.** Mostly mechanical. The vocabulary guard has no opt-in: it always scans every src/ module. The `// vocabulary: plain` header lines are deleted, since they no longer mean anything.

**Approach.**
- test/vocabulary.test.ts: remove the header requirement and any remaining scope logic (`optedIn` goes away), so the target is every `.ts`/`.tsx` module under src/. Replace the groundwork test "with no `// vocabulary: plain` header anywhere in src/, the guard passes" with one that a header-less module is scanned. Keep the word list, the word-bounded case-insensitive match, the string-literal and template-text walk (never `${…}` expressions), the `// vocabulary-ok: <reason>` line exemption, and the shared legacy-reader exemption from part 5/7. Update the file's header comment to say the guard covers all of src/ and that `vocabulary-ok` is the only escape.
- Delete every `// vocabulary: plain` line in src/: `grep -rln '^// vocabulary: plain' src` lists them, one line per module, up to about 300. Change nothing else in those files.
- Features keep landing while this series runs, so run the guard and fix any hit introduced since part 6/7 the same way: reword, or mark `vocabulary-ok` with a reason.
- docs/glossary.md and DEVELOPMENT.md may describe the opt-in header. Update their sentence on how the guard is scoped, and nothing else in them.

**Files touched.** test/vocabulary.test.ts; every src/ module with a `// vocabulary: plain` header (one deleted line each); any module with a newly introduced hit; the guard sentence in docs/glossary.md and DEVELOPMENT.md if they describe the header.

**Acceptance criteria.**
- `grep -rn 'vocabulary: plain' src test` prints nothing, apart from a negative-case fixture inside test/vocabulary.test.ts if it keeps one.
- Adding `say("the fleet is idle")` to any src/ module without a `vocabulary-ok` marker makes the guard fail (check locally, do not commit).
- The guard's own tests pin the new scope: a module without any header is scanned.
- `npm run test` passes.

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-19 by plan: merging this makes the live tumwater.json's `claude/…` model ids a load error, so the operator first migrates it — `model` loses the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }` (valid once parts 1/5-2/5 land) — then removes this note**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (`isAgentId(provider)`) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule; a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isAgentId(seam.provider)` branch goes once no resolved seam carries a namespace provider. `AGENT_IDS`' doc comment drops "doubles as the selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -rn 'isAgentId(provider)\|startsWith("claude-")' src` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field; `npm test` passes.

### The dashboard's By model summary drills into the runs: clicking a model shows the History table of that model's runs, through a new `GET /api/history?model=<selector>`, the dashboard twin of `tumwater history --model` (planned 2026-10-19 by the plan role; no dependency on any Planned entry. The in-flight revert-button entry also edits src/gui/gui-endpoints.ts and src/ui/gui/gui-client-history.ts, but different functions (`handleTick`, the drill-down card); this entry edits `handleHistory`, the toolbar, `historyQuery`, `histModelSummaryHtml` and `renderHistory`, so whichever merges second only rebases. The logs -f entry edits src/cli/log-commands.ts only. The blocked plain-terms parts rename `TickRow` and the `tickRows…` family later, which is also a rebase. Touches src/history/history-data.ts src/history/history.ts src/gui/gui-endpoints.ts src/ui/gui/gui-client-history.ts docs/cli.md test/history-data.test.ts test/gui-endpoints.test.ts test/gui-client-history.test.ts)

**Goal.** `tumwater history --model <selector>[,...]` lists the runs behind one line of `history --summary --by model`. The dashboard's History view has the same "By model" mode (`histModelSummaryHtml` in src/ui/gui/gui-client-history.ts), but you can't go from a model's line to its runs: `handleHistory` (src/gui/gui-endpoints.ts) reads `role`, `grep`, `n`/`sinceMs` and `summary`, and has no `model` query. The table has no model filter either, and the search box (`grep`) matches model names as substrings, not exact selectors. This plan makes each model label in the By model table a link. Clicking it switches to the Table view, filtered to runs whose `run_start` named exactly that selector.

**Decided scope (no open question).**
- One shared filter rule. Add `tickRowsOnModels(rows: TickRow[], models: string[]): TickRow[]` to src/history/history-data.ts, next to `tickRowsMatchingGrep`. It keeps rows with `r.model !== null && models.includes(r.model)` (exact, case-sensitive; a null-model row never matches). Give it a doc comment naming its two call sites. `cmdHistory` (src/history/history.ts) replaces its inline `rows.filter((r) => r.model !== null && pieces.includes(r.model))` with this call. Its flag parsing, errors and empty-state messages stay as they are.
- `handleHistory` reads `model` like `role`: `""` and absent filter nothing. The value is a comma list, split, trimmed and deduplicated as `cmdHistory` does. A list with no non-empty pieces (e.g. `","`) filters nothing (no 400, matching the "" rule). An unknown selector is not an error and keeps no rows, matching the CLI. The filter applies after `grep` in both the count and `sinceMs` shapes, before `summary`/`modelSummary` are folded, so both summaries fold exactly the rows served. `n` still bounds the rows read before filtering, the same as `history -n N --model`.
- The client sends a single selector, the one clicked. The `(unknown)` bucket and the total row are not clickable, because the CLI can't select a null model either.
- The model filter is view state, not a persisted preference: a new `let histModel = ""` is not passed to `store`/`recall`, so a reload starts unfiltered. When it is set, the toolbar shows a chip button `id='histmodel'` reading "Model: <selector> ×". Clicking the chip clears `histModel` and refetches. When it is empty, the chip is hidden (`style.display = "none"`).

**Approach.**
- **src/history/history-data.ts**: add `tickRowsOnModels` as above.
- **src/history/history.ts**: call it from `cmdHistory`'s `--model` branch.
- **src/gui/gui-endpoints.ts** `handleHistory`: parse `model` as above and apply `tickRowsOnModels` after the grep filter in both arms. Extend the doc comment's query list.
- **src/ui/gui/gui-client-history.ts**:
  - `historyQuery(count, role, sinceKey, grep, model)`: append `&model=<encodeURIComponent(model)>` when `model` is non-empty, placed after grep and before `&summary=1`. Existing calls without a fifth argument keep their URLs, because an `undefined` model appends nothing.
  - `fetchHistory` passes `histModel`.
  - `histModelSummaryHtml`: when a model row's model is non-null, its label cell holds `<button type='button' class='linkish mono' data-histmodel='<esc(model)>'>` around the label. `.linkish` already exists in src/ui/gui/gui-styles.ts and is used by gui-client-team.ts; no new CSS. To keep the shared renderer unchanged for the role table, give `summaryTableHtml` an optional per-entry `labelHtml` that it uses instead of `esc(e.label)` when present.
  - `buildHistoryView`: add the chip button to the toolbar after the role picker. Its click handler clears `histModel` and calls `fetchHistory()`. The existing `#histbody` click listener gains a branch: `ev.target.closest("button[data-histmodel]")` sets `histModel = b.dataset.histmodel`, sets `histMode = "table"`, calls `store("hist-mode", "table")` and then `fetchHistory()`.
  - `renderHistory` shows or hides the chip and sets its text from `histModel`. In `historyTableHtml`'s empty state, an active model filter with zero rows shows "No runs on this model". Add a `model` parameter, appended last.
- **docs/cli.md**: in the Watch run history row, extend the clause about the dashboard's By model mode to say that clicking a model lists its runs (the `history --model` twin).

**Acceptance criteria.**
- test/history-data.test.ts: `tickRowsOnModels` keeps exact matches for one and for two selectors, drops a null-model row, and treats a case-different selector as no match.
- test/gui-endpoints.test.ts, beside "handleHistory ?summary also folds the served rows per model" and using the same fixture: `?n=50&model=m-a` serves only clean's row. `?n=50&model=m-a,m-b&summary=1` serves two rows, with `modelSummary` deep-equal to `summarizeTickRowsByModel` of the served rows. `?sinceMs=3600000&model=m-a` filters the window arm. `?n=50&model=` and `?n=50&model=,` serve all three rows. `?n=50&model=nope` serves `rows: []` with status 200.
- test/gui-client-history.test.ts: `historyQuery(50, "", "", "", "m-a")` returns `/api/history?n=50&model=m-a&summary=1`. A selector with `/` and `:` is URL-encoded. The existing four-argument assertions still pass. `histModelSummaryHtml` renders a `data-histmodel` button for a named model and none for the `(unknown)` bucket or the total row. Through the existing fetchHistory/clientScope harness, clicking a `data-histmodel` button fetches a URL containing `&model=` and switches the mode to table. Clicking `#histmodel` refetches without `model=`.
- The existing `history --model` tests in test/cli-history-filtering.test.ts pass unchanged.
- `npm run test:gate` passes.

### `tumwater history -f/--follow` prints the last runs, then one row per run as it finishes, a quiet live feed beside `logs -f` (planned 2026-10-19 by the plan role; no dependency on any Planned entry — it touches cmdHistory's flag handling, which the in-flight By-model drill-down plan also edits, so whichever merges second rebases onto the other)

**Goal.** An operator who wants to watch outcomes, not every event, has no live view on the CLI:
`tumwater logs -f` streams every event (run_start, merge_queued, inbox lines, model changes …)
and `tumwater history` is a one-shot listing. `tumwater history -f` prints the usual last-N rows,
then keeps following the event log and prints one history row each time a run ends, through the
same row filters (`--role`, `--grep`, `--result`, `--model`) — `tail -f` for run outcomes. It
ends on Ctrl+C or once its parent process is gone, exactly as `logs -f` does.

**Approach.**
- src/cli/log-commands.ts: export `followUntilParentGone` and its `FollowSeams` interface
  unchanged, so history's follow shares the one follow-plus-parent-death-watch helper.
- src/history/history.ts `cmdHistory(root, args, seams: FollowSeams = {})`:
  - `-f`/`--follow` (same spellings as logs). Rival shapes fail through `failRivalShapes` with
    logs' wording style: `--since` ("follow means \"from now on\"; --since shows a bounded past
    window", the logs wording), `--summary` ("a summary tallies a bounded set; -f follows from now
    on"), and `--json` ("--json prints one document; -f streams rows"). `-n`, `--role`, `--grep`,
    `--result` and `--model` compose with it.
  - Build one row predicate from the parsed `--grep`/`--result`/`--model` values (the same
    `tickRowsMatchingGrep`, `historyClass`, and model-membership rules the current inline filters
    apply — if the By-model plan's `tickRowsOnModels` has landed, reuse it) and use it for the
    followed rows; the non-follow path keeps its current filters and empty-state wording
    unchanged.
  - With `-f`: before the normal `readTickRows` read, take `readEventsTailWithEnd(root,
    HISTORY_FOLLOW_BUFFER_EVENTS)` (new exported constant, 2000) as the seed buffer and offset.
    Print the initial filtered rows **oldest first** (so newer rows append below, as in any
    follow), padded by `widestWidths`; print no empty-state prose (`logs -f` prints none either).
  - Follow `eventsLogPath(root)` from `tail.coveredEnd` with `followUntilParentGone`. Each parsed
    event (`parseEventLine`) is appended to the buffer (drop the oldest beyond
    `HISTORY_FOLLOW_BUFFER_EVENTS`); on a `run_end`, `tickRows(buffer, 1, roleScope)[0]` is that
    run's row (the buffer supplies its run_start for duration and model; a start that fell out of
    the buffer renders the dash, history's existing unpaired rule). Skip the row when its
    `role#run` key was among the initial rows (an end appended between the tail read and the
    `readTickRows` read is delivered twice), or when the predicate rejects it; otherwise print
    `renderRow(row, widths)` where `widths` is a running maximum: add `widenWidths(a, b)` (the
    column-wise max) to src/history/history-render.ts beside `widestWidths`.
  - A run whose change is waiting to merge prints `queued`, its result at run_end; the follow
    does not print a second line when the merge resolves (`tumwater history` shows the
    resolved result afterwards).
- src/cli.ts `case "history"`: add `{ names: ["-f", "--follow"] }` to its `rejectUnknownArgs`
  list (the logs spec spelling).
- src/cli/help.ts: add `[-f/--follow]` to the `tumwater history` usage line and one sentence to
  its stanza ("-f prints the last N rows oldest first, then one row per run as it ends, until
  Ctrl+C or its parent exits; not with --since, --summary or --json"). Completion derives from
  HELP (completionSpec), so no completion.ts edit. docs/cli.md: the "Watch run history" row's
  synopsis and text gain the same.

**Files touched.** src/history/history.ts, src/history/history-render.ts,
src/cli/log-commands.ts, src/cli.ts, src/cli/help.ts, docs/cli.md, a new
test/history-follow.test.ts.

**Acceptance criteria.**
- test/history-follow.test.ts, in-process with the `{ ppid, intervalMs: 10 }` seams and
  `captureStdout`, appending events with `fs.appendFileSync(eventsLogPath(repo), …)` the way
  test/log-commands.test.ts's `assertFollowEndsWithParent` does:
  - two runs already in the log print oldest first; then a `run_start`+`run_end` pair appended
    while following prints one row naming that run, its result, and its model from the
    run_start;
  - `--role clean -f` does not print an appended `feature` run, and `--result merged -f` does not
    print an appended `no_change` run, while each prints a matching one;
  - no run prints twice: across the whole captured output each `#<run>` of a role appears on
    one line only;
  - the follow resolves once the fake ppid turns 1, and an event appended after that prints
    nothing.
- `history -f --since 1h`, `history -f --summary` and `history -f --json` each fail with a
  message naming both flags (assert through the existing exit-capture helper).
- The existing tests in test/cli-history.test.ts, test/cli-history-filtering.test.ts,
  test/cli-history-views.test.ts and test/log-commands.test.ts pass unchanged.
- `npm run test:gate` passes.

### `tumwater history <role> <n> --patch` appends the run's full commit patch to its trail, the patch twin of `--stat` (planned 2026-10-19 by the plan role; no dependency on any Planned entry: the in-flight `history -f` plan edits src/history/history.ts and src/cli/log-commands.ts, the dashboard Revert plan adds one exported `tickLandedSha` to src/tick/tick-detail.ts, and a blocked runner-rename part renames identifiers there, so these meet only as rebases)

**Goal.** `tumwater history <role> <n> --stat` (`cmdTick` in src/tick/tick-detail.ts) appends the per-file `git show --stat` summary of the commit a run pinned. To see what the run actually changed, though, you still have to copy the `commit <sha>` out of the header and run `git show` yourself. `tumwater diff --role <id>` already prints the patch of a role's *pending* change. This plan gives a *finished* run the same view: `--patch` appends that commit's full patch. Like `--stat`, it shows the commit the run pinned (`tickCommitSha`), not the `merged as` sha: a rebased merge carries the same changes under a new sha, and the stat and the patch should describe the same commit.

**Decided scope (no open question).**
- `--patch` is accepted with `--stat`. Then the stat block comes first and the patch block follows, each separated by a blank line, in the same order as `git show --stat --patch`. With `--last`, it applies to the newest finished run, just as `--stat` does.
- The patch is printed whole, with no byte cap, the same as `diff --role`'s patch. The reviewer-facing truncation in `aheadOfMainDiff` (src/git/git-diff.ts) is for a model's context window, not for a terminal that can page.
- A run with no commit, or with a commit that is not in the repository, prints the same `(no commit: this run sent nothing to merge)` / `(commit <short> is not in this repository)` texts `--stat` prints. A missing commit is not a failure, and the exit code is 0.
- `--json` adds a `patch` string field beside `stat`, and only when the flag is given. No dashboard or TUI change: the dashboard's `GET /api/run` (`handleTick`) and the TUI's History trail (`tickStat` in src/ui/tui/tui-keys.ts) keep the stat footer only.

**Approach.**
- **src/tick/tick-detail.ts**:
  - Generalize `tickCommitStat(root, sha)` into `tickCommitShow(root, sha, what: "--stat" | "--patch")`, which runs `gitTry(root, "show", what, "--format=", sha)`. It keeps both placeholder texts and the `trimEnd()`. Keep `tickDetailStat` exactly as it is now, on top of the new helper.
  - Export `tickDetailPatch(root, d)` beside it, with a doc comment that names the pinned-commit rule.
  - `cmdTick` gains a trailing `patch = false` parameter. It collects the stat and patch blocks (each only when its flag is given) into one footer list. Plain text joins the trail and the footer with `\n\n`. `--json` spreads `{ stat?, patch? }` into the detail. Update the doc comment and `TICK_USAGE` to `tumwater history <role> [<n>] [--last] [--stat] [--patch] [--json]`.
- **src/cli/cli-flag-specs.ts**: add `PATCH_FLAG: FlagSpec = { names: ["--patch"] }` beside `STAT_FLAG`, value-less.
- **src/cli.ts** `runTrailCommand`: add `PATCH_FLAG` to its `rejectUnknownArgs` list, and pass `rest.includes("--patch")` to `cmdTick`. Update its doc comment's admitted-flag list.
- **src/cli/help.ts**: the `history <role>` usage line gains `[--patch]`, plus the phrase "--patch appends the commit's full git show patch (after --stat's summary when both are given)". Completion derives from HELP.
- **docs/cli.md** "Watch run history" row: after the `--stat` clause, add "`--patch` appends that commit's full patch (after the `--stat` summary when both are given)".

**Files touched.** src/tick/tick-detail.ts, src/cli/cli-flag-specs.ts, src/cli.ts, src/cli/help.ts, docs/cli.md, test/tick-detail.test.ts.

**Acceptance criteria.**
- New test in test/tick-detail.test.ts, "tick --patch appends the pinned commit's patch, text and JSON", built like "tick --stat appends the pinned commit's per-file summary, text and JSON":
  - Its text output starts with the plain trail and contains `diff --git a/README.md b/README.md` plus a `+` line from the commit.
  - With `--stat` and `--patch` together, the `README.md | ` stat line comes before the `diff --git` line.
  - `--json --patch` carries a `patch` field that matches `diff --git`, and it has no `stat` key unless `--stat` is given too.
  - `cli(repo, "tick", "bugfix", "3", "--patch")` exits 0.
- A case beside "tick --stat names a missing or foreign commit instead of failing" checks that `--patch` prints `(no commit: this run sent nothing to merge)` for a run with no commit and `(commit 00000000 is not in this repository)` for a foreign sha.
- The two existing usage assertions in test/tick-detail.test.ts that match `\[--stat\] \[--json\]` are updated to match the new `TICK_USAGE`. The existing `--stat` tests pass with no change.
- `npm run test:gate` passes.

### `tumwater revert <role> <n>` and `tumwater revert <role> --last` revert the change a run merged, without copying a sha out of its trail (planned 2026-10-19 by the plan role; no dependency on any Planned entry: the in-flight `history --patch` entry edits `TICK_USAGE`/`cmdTick` in src/tick/tick-detail.ts and src/cli.ts's `history` case, and this entry edits only `cmdRevert` and the `revert` case, so the two meet only as rebases. The blocked plain-terms parts rename `readTickDetail`/`TickDetail` later, which is also only a rebase)

**Goal.** `tumwater revert <sha> [--dry-run]` (`cmdRevert` in src/operator/operator-commands.ts) takes only a sha. The dashboard's History drill-down now reverts a run directly: `handleTick` in src/gui/gui-endpoints.ts resolves `tickMergedSha(detail)` through `resolveRevertTarget`. From a terminal, the operator still runs `tumwater history <role> <n>` and copies the `merged as <sha>` or pinned sha into `revert`. This plan lets `revert` take the same run address `history` takes: `tumwater revert <role> <n> [--dry-run]` and `tumwater revert <role> --last [--dry-run]`. It goes through the same cores (`previewRevert`, `revertMergedCommit` in src/operator/revert.ts) and the same sha rule (`tickMergedSha`), so the CLI and the dashboard pick the same commit for the same run.

**Approach.**
- The forms are told apart by arity, so nothing is ambiguous. One positional and no `--last` is a sha, as today. Two positionals are `<role> <n>`. `--last` plus one positional is `<role>`. A sha form with `--last`, or any other count, fails with the usage `revert needs a commit or a run (usage: tumwater revert <sha>|<role> <n>|<role> --last [--dry-run])`. The existing flag-shaped-token gate (`revert takes only --dry-run (got …)`) becomes `revert takes only --dry-run and --last (got …)` and still runs before any lookup.
- Add a module-local `revertRunSha(root, positionals, last): string` in src/operator/operator-commands.ts, next to `cmdRevert`. It resolves the run the way `cmdTick` does:
  - role: `canonicalRoleId`, then checked against `knownRoleIdsCached(root)`. An unknown role fails with `unknownRoleMessage(role, ids)` plus the revert usage.
  - number: `parseCountFlag("revert <n>", positionals[1])` for the numbered form. For `--last` it is `readTickRows(root, 1, role)[0]?.run`, which is the run `tumwater history <role> --last` shows, so an operator can inspect it and then revert that same run. `--last` does not skip ahead to the newest *merged* run; a non-merged newest run gets the refusal below.
  - `readTickDetail(root, role, n)`. A missing run fails with `tickNotFoundMessage(role, n)`, or for `--last` with no runs, `no completed run of <role> in the event log`. Unlike `history`, revert exits 1 here because it is an action that did not happen.
  - `detail.result !== "merged"` fails with `<role> run #<n> did not merge (result: <result ?? "unknown">); there is nothing to revert`. This covers rejected, refused, no-commit and still-queued runs before git is asked anything.
  - Otherwise return `tickMergedSha(detail)`. If it is null (a merged run whose log lost every sha event), fail with `<role> run #<n> merged but the event log no longer names its commit; pass the sha from git log instead`.
  - The returned sha then goes into the unchanged `previewRevert` / `revertMergedCommit` path, so the base-branch, not-on-main, dirty-tree and conflict refusals keep their current wording.
- Under the run forms, the dry-run output adds one first line, `run <role> #<n> merged as <short sha>`, before the `would revert …` lines. A real revert prints the same line before `main is now …`. The sha form's output does not change.
- Every helper is already exported, so src/tick/ does not change: `tickNotFoundMessage` and `tickMergedSha` (src/tick/tick-detail.ts), `readTickDetail` (src/tick/tick-detail-data.ts), `readTickRows` (src/history/history-data.ts), `canonicalRoleId` (src/roles/legacy-role-ids.ts), `knownRoleIdsCached` (src/config/config.ts), `unknownRoleMessage` (src/roles/roles.ts) and `parseCountFlag` (src/cli/cli-args.ts).
- src/cli.ts's `revert` case keeps calling `cmdRevert(root, args)`. Update its comment to say the positionals select a sha or a run.

**Files touched.** src/operator/operator-commands.ts (`cmdRevert`, new `revertRunSha`, doc comment), src/cli.ts (comment only), src/cli/help.ts (the `tumwater revert` entry: `tumwater revert <sha>|<role> <n>|<role> --last [--dry-run]`, plus one line saying the run forms revert the commit the run merged as, the sha `history <role> <n>` names; completion derives from HELP), docs/cli.md ("Steer the project" row: the run forms, and that `--last` is the run `history <role> --last` shows), test/cli-operators.test.ts.

**Acceptance criteria.**
- In test/cli-operators.test.ts, beside the existing revert tests, a repo from `initProject` + `seedCommit` with `writeEvents` (test/fixtures/log-fixtures.ts) seeding `clean` run 1 (`merge_done` with `commit: <seeded sha>`, `run_end` `result: "merged"`), run 2 (`run_end` `result: "rejected"`, pinned commit on a side branch) and run 3 (`merged`, `commit: "0".repeat(40)`). The same shape as "gui /api/run carries revertSha only for a run whose commit is on main" in test/gui-server-api.test.ts. Cases:
  - "revert <role> <n> reverts the commit that run merged as": `cli(repo, "revert", "clean", "1")` exits 0. stdout starts `run clean #1 merged as <short>`, HEAD's subject is `tumwater(operator): Revert <short>`, and the tree is clean.
  - "revert <role> <n> --dry-run previews the run's commit and writes nothing": exit 0, the `run clean #1 merged as` line and then `would revert <short>`, and HEAD is unchanged.
  - "revert <role> --last takes the newest completed run": with run 3 the newest, `revert clean --last --dry-run` exits 1 with the core's `no such commit` refusal for the zero sha. A repo whose newest clean run is run 1 previews run 1's sha.
  - "revert refuses a run that did not merge, an unknown run and an unknown role, writing nothing": `revert clean 2` → exit 1, stderr matches `did not merge \(result: rejected\)`. `revert clean 9` → exit 1 with `tickNotFoundMessage("clean", 9)`'s text. `revert nosuchrole 1` → exit 1 naming the unknown role. HEAD is unchanged after each.
- The existing "revert with zero or multiple positionals fails with usage and writes no commit" test is updated. Zero positionals and three positionals fail with the new usage text. `revert <sha> extra` now fails as an unknown role (`extra`), and HEAD is unchanged. The existing "revert rejects a flag-shaped token…" test matches the new `--dry-run and --last` wording. The success and `--dry-run` sha-form tests pass unchanged.
- test/help.test.ts's revert assertions (if any match the old signature) are updated to the new HELP line.
- `npm run test:gate` passes.

### `tumwater history <role> <n> --transcript` appends that one run's agent transcript to its trail, so you can read what the agent did in a past run without scrolling the role's whole log (planned 2026-10-19 by the plan role; no dependency on any Planned entry. The in-flight `history <role> <n> --patch` plan edits the same `cmdTick`/`runTrailCommand`/HELP line/docs row, so whichever lands second rebases and keeps both flags. The blocked runner-rename parts rename identifiers in src/tick and src/ui only as rebases. Touches src/agent/run-agent.ts src/ui/transcript-run.ts (new) src/tick/tick-detail.ts src/cli.ts src/cli/cli-flag-specs.ts src/cli/help.ts docs/cli.md test/transcript-run.test.ts (new) test/tick-detail.test.ts test/pi.test.ts)

**Goal.** `tumwater history <role> <n>` prints a run's harness events: start, verdict, merge, usage. It does not show what the agent itself said or ran. The only CLI view of that is `tumwater logs --role <id>` (`cmdLogsTranscript`, src/cli/log-commands.ts). It prints the last N entries of `.tumwater/log/<role>.pi.jsonl` (`piLogPath`), so reading run 412 when the role is on run 430 means guessing `-n` and scrolling through 18 other runs. The dashboard drawer shows only the live tail too (`/api/transcript`). `--transcript` appends exactly the agent runs that started inside the run's `[startTs, endTs]` window, rendered the way `logs --role` renders them.

**Decided scope (no open question).**
- **Run start times.** Each agent run in the raw log begins with the harness's `tumwater_run` marker (`runAgent` in src/agent/run-agent.ts), which carries `kind`, `agent` and an optional `label` but no time. Add `ts: Date.now()` to that marker. For a marker written before this change (no numeric `ts`), the segment's start is the `timestamp` of its first `message_end` whose `message.role` is `"user"` (the same field `createTranscriptRenderer` already stamps its separator from). A segment with neither is skipped.
- **Which runs are included.** A segment is included when `detail.startTs <= start <= (detail.endTs ?? Infinity)`. That covers the authoring run, its retries and fallbacks, and any review or gate run the role logged inside the window (they render with their `── review @ … ──` separator). A merge review that runs after the run's `run_end` is outside the window and is not shown. `detail.startTs === null` (the start was rotated out of the event log) prints a note instead of a guess.
- **Files read.** `piLogPath(root, role)` + `".1"` (the one generation `rotateIfLarge` keeps), then `piLogPath(root, role)` itself, oldest first, each only if it exists. Each file is read whole. This is a one-shot command, and each file is bounded by `logMaxBytes`. Lines before a file's first marker are skipped.
- **Prompts.** No `--prompt` companion: the transcript renders with `includePrompts: false`, like plain `logs --role`. The run's prompt is already on `tumwater role <id>`.
- **Composition.** `--transcript` is accepted with `--last` and with `--stat` (and with `--patch` if that has landed). The stat block, then any patch block, then the transcript block, each separated by a blank line. With `--json`, a `transcript` field (an array of strings, one per rendered line) is added beside `stat`, and only when the flag is given.
- **Nothing found.** When no segment matches, the block is the single line `(no transcript for <role> run <n>: rotated out of .tumwater/log/<role>.pi.jsonl, or the run started no agent)`. The exit code is 0, as for `--stat`'s missing-commit texts. With `--json`, the field is `[]`.
- No dashboard or TUI change.

**Approach.**
- **src/agent/run-agent.ts**: add `ts: number` to the marker object type and literal (keep the `label` only-when-set rule). Update its comment.
- **src/ui/transcript-run.ts (new)**: `export function readRunTranscript(file: string, fromTs: number, toTs: number | null): string[]`. It reads `file + ".1"` and `file` if they exist and splits their lines into segments, a segment starting at each line that parses (`parsePiEventLine` with a `tumwater_run`-only set, as `MARKER_ONLY` in src/ui/transcript-tail.ts does) as a `tumwater_run` marker. Each segment's start is marker `ts`, else the first user `message_end`'s `message.timestamp`. It keeps the segments whose start is in the window, concatenates their lines (markers included, so labels render), and returns `formatTranscript(lines).flat()` (src/ui/transcript.ts). Keep this small and synchronous. Add a header comment naming the marker-ts / user-timestamp fallback.
- **src/tick/tick-detail.ts**: `cmdTick` gains a `transcript` boolean. Because the boolean list is growing, convert its trailing flags to one options object `{ last, stat, transcript }` (plus `patch` if that has landed) and update the one caller. When the flag is set and `detail.startTs !== null`, call `readRunTranscript(piLogPath(root, role), detail.startTs, detail.endTs)`. For a null `startTs`, use the note `(no transcript: run <n>'s start rotated out of the event log)`, or `[]` under `--json`. Then append the block, or the empty-result line, as described above. Update `TICK_USAGE` to `... [--stat] [--transcript] [--json]`.
- **src/cli/cli-flag-specs.ts**: `export const TRANSCRIPT_FLAG: FlagSpec = { names: ["--transcript"] };`, documented like `STAT_FLAG`.
- **src/cli.ts**: `runTrailCommand` admits `TRANSCRIPT_FLAG` in its `rejectUnknownArgs` list and passes `rest.includes("--transcript")`.
- **src/cli/help.ts**: the `tumwater history <role> [<n>] ...` line gains `[--transcript]`. Completion derives from HELP.
- **docs/cli.md**: in the "Watch run history" row, after the `--stat` clause, add: "`--transcript` appends the agent transcript of the runs that started inside that run's window (the role's `logs --role` rendering, rotated-out runs noted; `--json` adds a `transcript` array)".

**Acceptance criteria.**
- test/transcript-run.test.ts (new), against temp files:
  - Three markers with `ts` 1000, 2000 and 3000, each followed by an `agent_start` and an assistant `message_end` with distinct text. Window `[1500, 2500]` returns only the second run's text.
  - Window `[1500, null]` returns the second and third.
  - A `.1` file holding the first run and a live file holding the next two: window `[0, null]` returns all three, oldest first.
  - A legacy marker without `ts` whose run has a user `message_end` with `timestamp: 2000` is included by `[1500, 2500]`.
  - A missing file returns `[]`.
  - A labeled marker (`label: "review"`) renders a `── review` separator.
- test/tick-detail.test.ts: seed run_start/run_end events for `clean` runs 1 and 2 (`writeEvents`, test/fixtures/log-fixtures.ts) and a `clean.pi.jsonl` with one marker-stamped segment inside each run's window.
  - `history clean 2 --transcript` prints the trail and then only run 2's assistant text, not run 1's.
  - `--json` carries a `transcript` array with that text, and omits the key without the flag.
  - A run with no matching segment prints the `(no transcript for clean run 2: …)` line and exits 0.
  - `--last --transcript` shows the newest run's text.
  - `--transcript --stat` prints the stat block before the transcript block.
- test/pi.test.ts: the assertions on the marker's exact bytes are updated to parse the line and check `kind`/`agent`/`label` plus a numeric `ts` between the before and after `Date.now()` of the call. Grep test/ for other exact `{"type":"tumwater_run",` byte assertions on *written* logs and update them the same way. Fixtures that only *feed* markers to renderers stay as they are.
- `npm run test:gate` passes.

## Done
