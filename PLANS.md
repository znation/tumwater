# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code runner, part 15/16: Reword role-sense "loop" in src/ comments, leaving every iteration-sense "loop" alone (planned 2026-10-19 by the plan role, split from the rejected 14/14; requires part 14/16 landed; design in plans/terminology.md "Code names"; touches comments in src/ only)

**Goal.** No comment in src/ says "loop" when it means a role or its worker. Every comment where "loop" means iteration (a `for`/`while` loop, "loop over", "loops through", the poll loop, the event loop, a retry, crash or feedback loop) reads exactly as before.

**Approach.**
- This part exists because the 14/14 review rejected blanket substitution. Judge each hit on its own and change nothing in code, string literals or serialized names.
- Work list: `grep -rnwiE 'loops?' src | grep -E ':[0-9]+:\s*(//|\*|/\*)'` (about 250 lines today, most in src/ui, src/backlog, src/doctor, src/events, src/process, src/paths.ts, src/git, src/agent, src/change and src/pi). Also check trailing `// …` comments on code lines (`grep -rnwiE '//.*\bloops?\b' src`).
- Before editing a hit, classify it by reading the whole sentence:
  - Role sense: the sentence is about a configured role, its runner, its state file, its claim, or "each loop" meaning each role. Reword "loop" to "role", or to "runner" when the sentence is about the `RoleRunner` object or one instance's state. Fix the grammar ("a loop's" → "a role's", "loops" → "roles").
  - Iteration sense: the sentence is about control flow, polling, retrying or feedback. Leave it byte-for-byte unchanged. Test: if "role" substituted in would make the sentence describe something other than iteration, it is iteration sense.
  - Ambiguous: leave it unchanged, and list it in the commit message.
- Leave alone: legacy readers (the files and regions listed in part 14/16's series rules), quoted PLANS.md/BUGS.md titles, `plans/*.md` names, commit subjects, and `customLoop*` names. Rewrap any edited comment past 100 columns.
- Commit message: state the rule you applied. Name only repairs you made, without counts or "all".

**Files touched.** Comments in src/ files from the work list; nothing in test/ (part 16/16).

**Acceptance criteria.**
- `git diff main -- src` changes only comment text: no code, string literal or identifier line changes. Check that every changed line is inside a comment.
- In every changed comment, the old "loop" referred to a role or its runner. No removed line has "loop" in an iteration sense (for/while, "loop over/through", poll loop, event loop, retry/crash/feedback loop).
- `grep -rnwiE 'loops?' src | grep -E ':[0-9]+:\s*(//|\*|/\*)'` lists only iteration-sense comments, legacy-reader comments, and the ambiguous ones the commit message names.
- `npm run test` passes.

### Plain terms code runner, part 16/16: Reword role-sense "loop" in test/ comments and test titles (planned 2026-10-19 by the plan role, split from the rejected 14/14; requires part 15/16 landed; design in plans/terminology.md "Code names"; touches comments and test titles in test/ + docs/invariants.md quotes of renamed titles)

**Goal.** No comment or `it`/`test`/`describe` title in test/ says "loop" when it means a role or its worker. Iteration-sense wording is unchanged, and serialized fixture data is untouched.

**Approach.**
- Apply part 15/16's classification rule (role sense → "role"/"runner"; iteration sense and ambiguous → unchanged, ambiguous ones named in the commit message) to:
  - comments: `grep -rnwiE 'loops?' test | grep -E ':[0-9]+:\s*(//|\*|/\*)'`, plus trailing `// …` comments;
  - titles: `grep -rnwiE 'loops?' test | grep -E '\b(it|test|describe)\('`.
- Most `loop` hits in test/ are the serialized `loop:` event field in fixtures (test/report*.test.ts, test/failure*.test.ts and others). Those are out of scope: do not touch them.
- When you rename a test title that docs/invariants.md quotes (`grep -n '<old title>' docs/invariants.md`), update the quote in the same commit so test/invariants-doc.test.ts stays green.
- Leave legacy-reader tests and fixtures that deliberately write old names alone.

**Files touched.** Comments and titles in test/ files from the work list; docs/invariants.md quotes of renamed titles.

**Acceptance criteria.**
- `git diff main -- test` changes only comment text and test-title strings, never fixture data, `loop:` fields or code.
- In every changed comment or title, the old "loop" referred to a role or its runner.
- Every test title docs/invariants.md quotes still exists verbatim, and test/invariants-doc.test.ts passes.
- `npm run test` passes.

### Plain terms code run, part 1/20: Move src/tick to src/run and the run command module to cli-start (planned 2026-10-16 by user; requires Plain terms code runner 16/16 landed; design in plans/terminology.md "Code names"; touches src/tick/ + src/ui/tick-progress-model.ts + src/cli/cli-run.ts + test/tick-*.test.ts + test/cli-run*.test.ts + test/helpers/run-live-harness.ts + every importer + docs/invariants.md + DEVELOPMENT.md + test/invariants-doc.test.ts)

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

### A `roles.<id>.model` or `review.model` value that misspells a tier name (`strnog`, `Strong`, `defualt`) is a config error naming the tier, so `tumwater role <id> --model strnog` refuses instead of writing a model id pi cannot resolve (planned 2026-10-19 by the plan role; no dependency on any Planned entry. The in-flight entries touch src/ui/status-render.ts and src/doctor; this one touches src/config/config-field-checks.ts, test/config-validation-model.test.ts, test/cli-operators.test.ts, docs/config.md)

**Goal.** `roles.<id>.model` and `review.model` accept a bare tier name (`small`, `default`, `strong`) as a reference into the top-level `model` map. `checkModelTripleField` (src/config/config-field-checks.ts) matches tier names exactly and case-sensitively, so any other bare string passes as a model id. A typo then goes to pi as a model pattern, and the role runs a model nobody chose. Verified 2026-10-19 in a scratch `tumwater init` project with main's build: `tumwater role feature --model strnog`, `--model Strong`, `--model defualt` and `--model smal` each printed `feature: model set to …` and exited 0. Afterwards `tumwater doctor` only warned `smal names no provider — pi resolves it with its own default, tumwater cannot verify it`. `role --model` writes through `setConfigKey` (src/config/config-write.ts), which validates the candidate config with `validateConfig`, so a new validation problem makes the CLI write, the TUI and dashboard model editors, and a hand edit of tumwater.json all refuse the typo the same way. After this change, a near-miss tier name is a validation problem that names the tier.

**Approach** (src/config/config-field-checks.ts, `checkModelTripleField`):
- In the `modelShape === "tier-name"` path, after the exact `MODEL_TIERS` match returns, add this check. The value is not a tier name, contains no `/`, and the section has no `provider` key (`obj.provider === undefined`; with a legacy provider a bare string is an id under that provider). If `suggestClosest(m, MODEL_TIERS)` (src/text/suggest.ts) returns a tier, push `${prefix}model ${show(m)} is not a tier name or a model id pi can resolve${didYouMean(tier)}`. Import `suggestClosest` and `didYouMean` beside the existing `typoSuffix` import. `suggestClosest` lowercases both sides, so `Strong` suggests `strong`. Its two-edit cap and same-first-letter rule keep real ids (`gpt-5`, `sonnet`, `opus`, `deepseek-v4.1-flash-free`) from matching. The new problem does not depend on `backend`, because no backend has a model id within two edits of a tier name.
- Leave the "selector" and "tier-map" shapes alone: a tier name is already invalid there, and those paths do not change.
- Extend the doc comment of `checkModelTripleField` with one sentence: a bare value within two edits of a tier name (ignoring case) is rejected as a misspelled tier reference.

**Acceptance criteria.**
- test/config-validation-model.test.ts, in "validateConfig guards the tier-map and tier-name forms of model", add these assertions. `validationError({ roles: { plan: { enabled: true, model: "strnog" } } })` matches `` /roles\.plan\.model "strnog" is not a tier name or a model id pi can resolve — did you mean `strong`\?/ ``. `review: { enabled: true, model: "Default" }` matches the same form with `review.model` and `` `default` ``. `roles.plan.model: "smal"` suggests `` `small` ``. The following stay valid (`assert.doesNotThrow`): `roles.plan.model` set to `"prov/strnog"` (has a `/`), to `"gpt-5"`, and to `"sonnet"`, and `{ provider: "prov", model: "smal" }` in a role section (legacy provider).
- test/cli-operators.test.ts, in "role --provider/--model/--thinking (and --clear-*) write the role's model triple", next to the bogus-thinking check: `cli(repo, "role", "feature", "--model", "strnog")` exits 1, its stderr matches `` /roles\.feature\.model "strnog" is not a tier name .* did you mean `strong`/ ``, and tumwater.json is byte-identical to its content before the call.
- docs/config.md: the `roles.<id>` table's `model` row adds that a value one or two letters off a tier name (in any case) is rejected as a misspelled tier.
- `npm run test:gate` passes.

### Pi built-in image capability, part 2/2: `seamImageInput` answers from the saved `pi --list-models` images column for a pi pair missing from models.json, so a built-in vision model keeps its image prompts (planned 2026-10-19 by the plan role; "requires part 1/2 landed". Touches src/agent/image-input.ts, src/runner/runner-run.ts, src/tick/tick-verdict.ts, src/inbox/inbox-submit.ts, src/roles/role-view.ts, src/status/status-roles.ts, src/doctor/doctor-model-checks.ts, plans/image-input.md, test/image-input.test.ts, test/tick-verdict.test.ts)

**Goal.** Part 1/2 saves pi's own images column per `provider/model`. This part has the one resolver read it. A pi pair missing from models.json gets the listing's answer instead of `null`. With that, the preflight keeps an image prompt on a role whose built-in model reads images, and a reroute can target a built-in vision tier. The status, role and submit surfaces say what pi says, and the doctor's `image input` check probes the built-in claim like any other.

**Approach.**
- **src/agent/image-input.ts.**
  - `seamImageInput(seam, providers, probes?, listed?: PiListedModels | null)`. In the pi branch, `base` becomes `piModelImageInput(providers, …)`. When that is null, use `piListedImageInput(listed, seam.provider, seam.model)` instead. models.json wins when it defines the pair. The failed-probe override that follows is unchanged, so it covers a listed claim too: it uses the same `imageProbeKey("pi", …)`.
  - Update the doc comment: "absent from models.json → what `pi --list-models` last said (src/pi/pi-listed-models.ts), else null".
  - Thread a trailing `listed: PiListedModels | null = null` through `imageReroute` (into its `capable` closure), `imageRerouteTarget` and `roleImageInfo`. `roleImageInfo` passes it to both its `seamImageInput` and its `imageReroute` call.
- **Callers.** Each one reads `readPiListedModels(root)` once and passes it on. Every one of these already has `root` (or `ctx.root`):
  - src/runner/runner-run.ts preflight: both the `seamImageInput` call and the `imageReroute` call.
  - src/tick/tick-verdict.ts: the blind-read `imageReroute` call.
  - src/inbox/inbox-submit.ts, src/roles/role-view.ts, src/status/status-roles.ts: their `roleImageInfo` calls.
  - src/doctor/doctor-model-checks.ts `checkImageInput`: the two `claimed` loops' `seamImageInput(pair, providers)`, the per-role `seamImageInput(rc, providers, probes)` and its `imageReroute`. With this, a listed built-in vision pair is probed and cached like a models.json claim.
- Leave src/agent/run-agent.ts' parser `imageInput` alone. It only acts on `false`, and for a model pi has built in, pi itself reports the non-vision note. Say so in one line of this plan's commit, not in code.
- **plans/image-input.md** "Capability", pi bullet. Replace "Not in models.json at all (pi's built-in catalog) → `null` … already fails such pairs" with: built-in pairs read the images column the doctor last saved from `pi --list-models`, and an unlisted pair reads `null`.
- docs/invariants.md INV-J1 (blind reads) is unaffected: it pins the stop on a blind read, not the capability source.

**Acceptance criteria.**
- test/image-input.test.ts, new "seamImageInput reads pi's listed images column for a pair models.json does not define". Use the file's `writeModels()` catalog:
  - A pi seam `builtin/vision-x` with `listed = { checkedAt: 0, images: { "builtin/vision-x": true, "builtin/text-x": false } }` reads true.
  - `builtin/text-x` reads false, and an unlisted `builtin/other` reads null.
  - With no `listed`, all three read null, as before.
  - A models.json pair stays on its catalog answer even when `listed` says the opposite.
  - A fresh failed probe for `builtin/vision-x` (`imageProbeKey("pi", "builtin", "vision-x")`) turns it false.
- Same file, new "imageReroute picks a tier whose built-in model pi lists as reading images". The default tier is text-only and the strong tier is `builtin/vision-x`. With the listing, `imageReroute(config, "feature", "primary", models, null, undefined, null, listed)?.tier === "strong"`. Without it, the result is null.
- test/tick-verdict.test.ts, new twin of "a blind read on a text-only tier with a vision reroute target aborts as image-reroute". The strong tier is a pair models.json does not define, listed as reading images with `writePiListedModels(root, { "<pair>": true })` before the verdict. The tick aborts as image-reroute onto strong. Without the listing, the same setup takes the no-target path that "a blind image read fails the tick with an error naming the file and the model" pins. (No test drives the runner-run.ts preflight end to end today, and this part does not add one. The preflight reads the same `seamImageInput`/`imageReroute` the unit tests above cover.)
- The existing image-input, runner, tick-verdict, status, role-view and doctor tests pass unchanged. They write no listing, so every caller reads null and behaves as today.
- `npm run test:gate` passes.

### Inside a team workspace, the ungated commands (`report`, `backlog`, `questions`, `role`, `bug`/`plan --list`/`--show`) refuse with the owning team root, so `tumwater role <id> --model` can no longer seed a phantom `tumwater.json` in a slot (planned 2026-10-19 by the plan role; independent of every eligible Planned entry. Touches src/cli/cli-repo-gate.ts, src/cli.ts (the `report` case), src/cli/cli-query-commands.ts, src/backlog/backlog-cli.ts, plus a new test/cli-team-workspace.test.ts)

**Goal.** The done plan "Inside a team workspace (`<root>/.tumwater/worktrees/<slot>`), `tumwater init` refuses and every gated command names the owning team root…" covered `init` and the commands that call `requireReadyRepo`. Several commands skip that gate on purpose, because each one degrades to empty output in a directory that was never initialized. Inside a workspace, that degraded output is wrong. Measured 2026-10-19 with main's built CLI in a temp `R/.tumwater/worktrees/_slot-1` git repo:
- `tumwater role feature --model strong` printed `feature: model set to strong`. It created `tumwater.json` in the slot.
- `role feature --notes-file <f>` created `.tumwater/state/notes/feature.md` in the slot.
- `git status` then showed both as untracked files, so a run's commit could pick them up.
- The phantom `.tumwater` also makes `nearestTumwaterRoot(slot)` return the slot itself. After that, `owningTeamRoot` stops recognising the slot as a workspace, and the gated commands' workspace message stops firing there too.
- Run from this plan role's own slot, `tumwater report --failures --since 2d` printed "0 runs, no events" for a team that is busy.

After this change, every command that reads or writes team state answers inside a workspace with the same `teamWorkspaceMessage` the gated commands give.

**Approach.**
- `src/cli/cli-repo-gate.ts`: add `refuseTeamWorkspace(root: string): void`. It does `const owner = owningTeamRoot(root); if (owner !== undefined) fail(teamWorkspaceMessage(owner));`, importing `owningTeamRoot` from `../paths.js` and `teamWorkspaceMessage` from `../gates/readiness.js`. Doc comment: this is the workspace half of `requireReadyRepo` for the commands that deliberately skip the ready-repo gate. Outside a workspace it is a no-op, so those commands keep degrading to empty output in a plain directory.
- Call it in each ungated state-reading command, after that command's argument gate (`rejectUnknownArgs` or its own parse) and before its first file read or write. This keeps the existing order: a malformed call fails with its usage first.
  - `src/cli.ts` `report` case: after the `rejectUnknownArgs("report", …)` call, before `cmdReport`. This covers `--failures` and `--since` too.
  - `src/cli/cli-query-commands.ts`:
    - `cmdBacklog`: after its `rejectUnknownArgs`.
    - `cmdQuestions`: after its argument scan, before the list, show or answer branches read QUESTIONS.md.
    - `cmdRole`: after its `rejectUnknownArgs`, before the id resolution and every write branch.
  - `src/backlog/backlog-cli.ts`: at the head of `listAndAnnounce` and `showAndAnnounce`, before they read the backlog file. These are the ungated `bug`/`plan --list` and `--show` forms; every other `bug`/`plan` form already calls `requireReadyRepo`.
- Leave alone: `doctor` (its `checkInit` already prints the workspace message), `completion`, `help` and `version`, which hold no state. Update each touched "No requireReadyRepo gate" comment with a clause saying the workspace refusal still applies.

**Acceptance criteria.**
- New `test/cli-team-workspace.test.ts`. It uses `teamWorkspace()` from test/fixtures/repo-fixtures.ts and `cli` from test/helpers/cli-harness.ts.
  - Test "an ungated command run in a team workspace names the owning team root". Each of these exits 1 with stderr containing `teamWorkspaceMessage(root)`: `report`, `report --failures`, `backlog`, `questions`, `role feature`, `bug --list`, `plan --show 1`.
  - Test "`role <id> --model` in a team workspace refuses and writes nothing". `role feature --model strong` exits 1 with the workspace message. Afterwards the slot holds no `tumwater.json` and no `.tumwater`, and `git status --porcelain` in the slot is empty.
  - Test "the argument gate still runs first in a workspace". `report --days abc` fails naming `--days`, not the workspace.
  - Test "`completion bash` still works in a workspace". It exits 0.
- Existing tests that run `report`, `backlog`, `questions` and `role` in plain temp repos pass unchanged, because none of those repos sits under a `.tumwater/worktrees`.
- `npm run test:gate` passes.

### Shell completion completes `tumwater doctor` check names, quoting the multi-word ones (`image\ input`, `main\'s\ check`), so `tumwater doctor im<Tab>` finishes a name the operator would otherwise copy from the report (planned 2026-10-19 by the plan role; no dependency on any Planned entry. It follows the done plan "`tumwater doctor <check>...` runs only the named checks", which left check-name completion out of scope. None of the Planned entries touches these files. This one touches src/cli/completion.ts, test/completion.test.ts, docs/cli.md)

**Goal.** `tumwater doctor <check>...` takes check names as positionals, matched ignoring case against `DOCTOR_CHECK_NAMES` (src/doctor/doctor-check-names.ts). `tumwater completion bash|zsh|fish` offers only doctor's flags there, so the operator has to type a name exactly or copy it from a full report. Many names have spaces (`git binary`, `image input`, `models for each tier`), and `main's check` has an apostrophe, so the names must reach the command line quoted. After this change, every positional word after `doctor` that does not start with `-` completes to the check names. Names come back escaped (`image\ input`, `main\'s\ check`), or raw when the operator opened a quote (`"image in<Tab>`).

**Approach.** All edits are in src/cli/completion.ts. Import `DOCTOR_CHECK_NAMES` from `../doctor/doctor-check-names.js`, a leaf module with no imports.
- **bash/zsh** (`bashScript`). Before the `if [ "$COMP_CWORD" -eq 1 ]` block, add a branch that fires when `"${COMP_WORDS[1]}" = doctor`, `COMP_CWORD -ge 2` and `"$cur" != -*`. Do **not** use `compgen -W`: it re-parses its word list with shell quoting, which drops the apostrophe in `main's check`. This was checked on bash 3.2 (macOS /bin/bash). The branch body was checked in the same run under bash 3.2 and under zsh with bashcompinit's `emulate sh`, and both printed the outcomes listed here:
  ```
  local word="$cur" quote="" name
  case "$word" in \"*|\'*) quote="${word:0:1}"; word="${word:1}";; esac
  word="${word//\\/}"
  for name in <each DOCTOR_CHECK_NAMES entry, double-quoted>; do
    if [[ "$name" == "$word"* ]]; then
      if [ -n "$quote" ]; then COMPREPLY+=("$name"); else COMPREPLY+=("$(printf '%q' "$name")"); fi
    fi
  done
  return 0
  ```
  (In the TS template literal, escape `$`/`\` as the surrounding lines do.) Declare `quote`, `word` and `name` with `local`, as shown. Do not use `${!arr[@]}`, because zsh's bashcompinit fails on it with "bad substitution". Do not use `"${arr[@]// /\\ }"`, because bash 3.2 joins the elements under a non-default IFS. zsh needs no separate code: bashcompinit's `_bash_complete` un-quotes COMPREPLY with `(Q)` and adds the names through `compadd`. Build the list with a small module constant: `DOCTOR_CHECK_WORDS = DOCTOR_CHECK_NAMES.map((n) => `"${n}"`).join(" ")`. Give it a doc comment saying the names hold no `"`, `$`, backtick or `\`, so plain double quotes are exact, and that a test pins this.
- **fish** (`fishScript`). Push a function line `function __tumwater_doctor_checks; printf '%s\n' <the same double-quoted names>; end` next to `__tumwater_argc`. Fish double quotes keep `'` literal. Then push `complete -c tumwater -n "__fish_seen_subcommand_from doctor" -a "(__tumwater_doctor_checks)"`. Command-substitution output splits on newlines only, so each multi-word name stays one candidate, and fish escapes the inserted candidate itself.
- **docs/cli.md**. In the `tumwater completion bash|zsh|fish` clause, after `tier names after `role <id> --model``, add `, and check names after `doctor``. Grep for the clause; do not read the file whole.

**Acceptance criteria** (test/completion.test.ts, through the existing `complete(script, words, cword)` helper; the words are single-quoted there, so pass `"image\\ in"` as a JS string):
- New test "the bash script completes doctor check names, escaping spaces and apostrophes":
  - `["tumwater","doctor","im"]`, cword 2, gives `["image\\ input"]`.
  - `["tumwater","doctor","mai"]` gives `["maintenance\\ allowance","main\\'s\\ check"]`, in list order. Do not type an apostrophe into a test word: the helper wraps each word in single quotes.
  - `["tumwater","doctor","image\\ in"]` gives `["image\\ input"]`.
  - `["tumwater","doctor",""]` gives `DOCTOR_CHECK_NAMES.length` entries.
  - `["tumwater","doctor","repo","or"]`, cword 3, gives `["orphans"]` (later positionals complete too).
  - `["tumwater","doctor","--pr"]` still gives `["--problems"]`.
  - `["tumwater","status",""]`, cword 2, offers no check name. Assert it does not include `"image\\ input"`.
- The same test asserts every `DOCTOR_CHECK_NAMES` entry matches `/^[a-z0-9' -]+$/i`, which pins the double-quoting assumption.
- A fish assertion (in the existing fish line tests, via `fishScriptLines()`): one line defines `__tumwater_doctor_checks` and contains `"main's check"` and `"image input"`, and one line has `__fish_seen_subcommand_from doctor` together with `-a "(__tumwater_doctor_checks)"`. The existing "the fish script parses under fish when fish is installed" test passes.
- The existing completion tests pass unchanged, including `bash -n` on the script.
- `npm run test:gate` passes.


## Done
