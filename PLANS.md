# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

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
- src/prompt/prompt.ts: `buildTickPrompt` → `buildRunPrompt`, aliased because test/prompt-roles.test.ts (part 17/20) calls it about 21 times. `TICK_PROMPT` → `RUN_PROMPT`; check whether it is only a test-local name. src/prompt/prompt-followup.ts: the parameter `tickPrompt` → `runPrompt`. Comments in prompt.ts, gate-prompts.ts, gate-notes.ts and principles.ts.
- src/inbox/ (pending-prompt.ts, inbox.ts, inbox-submit.ts, inbox-edit.ts, inbox-attachments.ts, prompt-commands.ts, prompt-not-before.ts, inbox-cancel.ts) and src/operator/ (operator-commands.ts, operator-requests.ts, operator-intent.ts, retire.ts): comments, plus uses of `abortRun` and `finishAbortedRun`.
- Tests: test/prompt.test.ts (about 77 lines), test/prompt-steward.test.ts, test/prompt-resume.test.ts, test/prompt-dialect.test.ts, test/prompt-followup.test.ts, test/prompt-commands.test.ts, test/pending-prompt.test.ts, test/gate-prompts.test.ts, test/gate-notes.test.ts, test/inbox*.test.ts (keep test/inbox.test.ts's `clock.tick`), test/operator*.test.ts and test/retire.test.ts.

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

### A `main_red`-kept change stays parked while main's new head is still red, instead of re-queuing on any move of main (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Touches src/merge/merge-slot.ts src/runner/runner-state.ts test/merge-requeue.test.ts test/runner-state.test.ts)

**Goal.** A merge ends `main_red` when the change's check failed on tests main does not already know about and main's tip was red (`attributeRedCheck`, src/merge/merge-check-failures.ts, and merge-core.ts's `gate.mainRed` branch). Both comments say the kept pin is re-merged "once main is green". But `requeueMainRedPin` (src/merge/merge-slot.ts) puts the pin back on the queue on the first poll where main's head differs from `RunnerState.mainRedRetry.head`. Any merge onto a red main counts as a move, even a docs-only plan merge or a fix that does not fix, so the retry pays a full gate check (224–754 s per `main_red` attempt in the 10-18..10-20 log) and gets `main_red` again. The log shows repeat attempts on one commit: ccf1224e three times on 10-20 07:07–07:28, 313597d9 three times on 10-18 07:04–07:16, and 08eb565e, 6ac7a001 and 1fb03be5 twice each. Today those repeats come mostly from leftover recovery, which the in-flight plan "A change kept by a `main_red` merge waits for main to move…" fixes; once it lands, `requeueMainRedPin` is the only re-queue path, and its "any move" rule is what remains. The main watch (src/baseline/main-watch.ts) runs the full check on every new main head and records the verdict in the baseline cache, so the poll can ask that cache instead of guessing. This change only touches `requeueMainRedPin` and the state record, not leftover.ts, so the two plans can merge in either order.

**Approach.**
- src/merge/merge-slot.ts:
  - Import `cachedBaselineVerdict` from `../baseline/main-baseline.js`.
  - Add `export const MAIN_RED_VERDICT_WAIT_MS = 15 * 60_000;` with a doc comment: the longest a kept `main_red` pin waits for the main watch's verdict on a moved head before it is re-queued anyway. This bounds the wait when no verdict ever arrives, for example after a watch check that timed out or a restart's cold cache.
  - `requeueMainRedPin` gains a trailing parameter `now = Date.now()`. Keep the early return when there is no record, `mainHead === ""`, or `mainHead === kept.head`. After it, read `const verdict = cachedBaselineVerdict(mainHead)`:
    - `"red"`: return. The record stays unchanged (original `head`, no save), so every later poll asks again, and a re-verified green for the same SHA, or a further move, releases the pin.
    - `undefined`: if `kept.waitingSince === undefined`, set `state.mainRedRetry = { ...kept, waitingSince: now }`, call `saveRunnerState(root, state)` and return. Otherwise return while `now - kept.waitingSince < MAIN_RED_VERDICT_WAIT_MS`. Past that, fall through.
    - `"green"`, or the wait bound passed: re-queue exactly as today (clear the record, save, `pinnedRetrySha`, skip when the role already has a queued entry, `enqueueRetry(... "main_red")`).
  - Rewrite the doc comment to describe the three outcomes. In `requeueKeptChange`'s doc, change "for requeueMainRedPin to re-queue once main moves" to "once main moves to a head whose verdict is not red".
- src/runner/runner-state.ts: `mainRedRetry` becomes `{ head: string; entry: Omit<MergeEntry, "sha">; waitingSince?: number }`. Document `waitingSince` as the ms epoch of the first poll that saw main moved with no cached verdict for its head. Update the field's doc comment: it is re-queued on the first poll whose main head differs and is not cached red, or once `MAIN_RED_VERDICT_WAIT_MS` has passed with no verdict. In the torn-record check, also require `s.mainRedRetry.waitingSince === undefined || typeof s.mainRedRetry.waitingSince === "number"`.
- Make the two comments that promise "once main is green" match the code: `attributeRedCheck`'s doc in src/merge/merge-check-failures.ts and the `gate.mainRed` comment in src/merge/merge-core.ts. Each should say the orchestrator poll's `requeueMainRedPin` re-queues the pin once main's head moves and the watch has not found the new head red. If the in-flight leftover plan has already rewritten `attributeRedCheck`'s sentence, extend its wording rather than replacing it.
- Out of scope: comparing the change's own failing tests with main's new failures. The record does not carry them, and a still-red main produces `main_red` again either way.

**Files touched.** src/merge/merge-slot.ts, src/runner/runner-state.ts, src/merge/merge-check-failures.ts (comment), src/merge/merge-core.ts (comment), test/merge-requeue.test.ts, test/runner-state.test.ts.

**Acceptance criteria.**
- test/merge-requeue.test.ts "a main_red pin is re-queued once main's head moves, and not before": before the `"f".repeat(40)` call, seed a green with `noteGreenBaseline("f".repeat(40))` (src/baseline/main-baseline.ts). The rest of its assertions stay as they are.
- New test "a main_red pin stays parked while main's new head is cached red": settle `main_red` as the existing test does. Seed a red for `"e".repeat(40)` by writing `baselineVerdictsPath(root)` (src/paths.ts) with `{ reds: [{ sha: "e".repeat(40), script: "test", failingTests: ["t"] }] }` and calling `persistBaselineVerdicts(root)`, as test/main-baseline-persist.test.ts "a restart reloads a saved red…" does. `requeueMainRedPin(root, "main", state, "e".repeat(40), Date.now() + 2 * MAIN_RED_VERDICT_WAIT_MS)` queues nothing, and `state.mainRedRetry` keeps its original `head` with no `waitingSince`.
- New test "a main_red pin waits for a moved head's verdict, then re-queues past MAIN_RED_VERDICT_WAIT_MS": with a head no verdict is cached for (`"d".repeat(40)`), a call at `now = 1_000` queues nothing and sets `waitingSince` to 1_000. `loadRunnerState(root, "improve").mainRedRetry?.waitingSince` is 1_000, so the value was saved. A call at `1_000 + MAIN_RED_VERDICT_WAIT_MS - 1` queues nothing. A call at `1_000 + MAIN_RED_VERDICT_WAIT_MS` queues one entry with `retry: "main_red"` and clears `state.mainRedRetry`.
- test/runner-state.test.ts, new test "loadRunnerState drops a mainRedRetry with a foreign-typed waitingSince", written like "loadRunnerState heals and validates the reviewResume marker" (no test covers the torn `mainRedRetry` record yet): a record whose `waitingSince` is a string reads as `undefined`, and one with a numeric `waitingSince` survives the load.
- `npm run test:gate` passes.

### The pre-queue self-check flags the garbled wording a word-swap rename leaves in added lines (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Touches src/run/stage-check.ts test/stage-check.test.ts)

**Goal.** The plain-terms rename series swaps "tick" words for "run" words by rote, which leaves two kinds of garbled English that reviewers reject change after change. One is a broken past participle: an auxiliary followed by "ran" ("would have" + " ran", "has actually" + " ran"), or "ran" hyphenated onto another word ("never" + "-ran", "least-recently" + "-ran", "stale" + "-ran"). The other is "run" stacked on "run": "the run is" + " running", "a run already" + " running", "run the" + " run", "running a" + " run", "runs no" + " run". In the events log, 11 `review_rejected` events quote one of these phrases in their reasons, and ten of them are from 2026-10-20 alone (feature, feature-2, feature-4, on parts 13–15). Twelve parts of the series are still to come (16/20–20/20 and cleanup 1/7–7/7). Each such rejection costs a review round and a re-queue. The pre-queue self-check (`stageCheckFindings`, src/run/stage-check.ts) already gives the author one bounded fix-up turn for heuristic findings like path drift and stale names, and any finding left open still goes to the gate (run-stage.ts "…still open, queued for the gate"). So a mechanical check for these phrases can turn most of those rejections into a fix-up turn, and a false positive costs only that turn.

**Approach.**
- src/run/stage-check.ts:
  - Add `function garbledWordingFindings(diff: string): string[]`, and call it in `gitLevelFindings` right after `newlineFindings(diff)`. It reads the `-U0` diff that function already has.
  - Walk the diff by line. On `diff --git a/… b/<path>`, set the current file to `<path>`. On `@@ … +<c>[,<d>] @@`, set the next new-side line number to `c`. On a `+` line that is not a `+++ ` header, test the text after the `+`, then add 1 to the line number. Skip files where `isRecordProse(file)` holds: history in the backlog quotes old wording.
  - Use one case-insensitive pattern list, `GARBLED_WORDING`, with a doc comment saying what each pattern catches and why (rote "tick → run" swaps):
    - `/\b(?:has|have|had|having)\s+(?:\w+ly\s+|never\s+|not\s+|already\s+|just\s+)?ran\b/i`
    - `/[A-Za-z]-ran\b/i`. Keep the character class: if it were written as `\w-ran\b`, this source line would match itself.
    - `/\bruns?\s+(?:is|are|was|were|already|still)\s+(?:still\s+|already\s+)?running\b/i`
    - `/\b(?:run|runs|running)\s+(?:a|the|no)\s+run\b/i`
  - Record a hit as `<file>:<line> "<matched text>"`. Keep at most one hit per line (the first pattern that matches). The check returns at most one finding: ``added lines carry garbled rename wording (reword them; a rote "tick" → "run" swap reads wrong here): `` followed by `cappedList(hits, MAX_STALE_HITS)`.
  - In the module's top doc comment, add a sentence after the `staleNameFindings` paragraph: a fifth check, `garbledWordingFindings`, reports added lines (outside record prose) that carry the broken participles and doubled "run" wording a word-swap rename leaves. Like the path checks, the gate does not run it. Describe the phrases with ellipses (for example "has/have/had … ran"), never as a literal phrase, so the comment does not match its own check.
- No docs/invariants.md change: like the path-drift and lost-newline findings, this is a staging heuristic and not a gate guarantee (the "merge gate's deterministic rejections" section binds stage-check.ts only for the protected-edit and secret checks).

**Files touched.** src/run/stage-check.ts, test/stage-check.test.ts.

**Acceptance criteria.**
- In test/stage-check.test.ts, write each fixture the way "removing a file's final newline yields the finding" does: `repoWith({...})`, write the file, then `stageCheckFindings(wt, "main", EXEMPT, "feature")`. Build every garbled phrase by string concatenation (for example `"would have " + "ran"`), so the test file's own lines do not match the check:
  - "added lines with a broken participle yield the garbled-wording finding": base `src/a.ts` holds `export const a = 1;\n`. Append a comment line `// the role would have ` + `ran twice` and a second line `// a never` + `-ran role`. There is exactly one finding matching `/garbled rename wording/`, and it names `src/a.ts:2` and `src/a.ts:3`.
  - "added lines that stack run on run yield the garbled-wording finding": an added `test/b.test.ts` line `assert.ok(x, "no run was ` + `running");` gives a finding that names `test/b.test.ts:1`.
  - "garbled wording in record prose, and a correct participle, yield no finding": the same broken-participle phrase added to `PLANS.md`, and a `src/a.ts` comment `// the role has run twice; it ran once today`, give no finding matching `/garbled rename wording/`.
  - "garbled wording already on the base is not reported": a base file that already holds the phrase, plus an unrelated added line elsewhere in that file, gives no garbled-wording finding.
- `grep -nE "(has|have|had|having) ran|[A-Za-z]-ran\b" src/run/stage-check.ts test/stage-check.test.ts` prints nothing. Neither file trips the new check.
- `npm run test:gate` passes.

### The pre-queue self-check flags a doc comment that the change detached from its declaration (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Touches src/run/stage-check.ts and test/stage-check.test.ts, like the garbled-wording self-check plan above; whichever lands second rebases onto the other's `gitLevelFindings` line and header paragraph)

**Goal.** Ten `review_rejected` events between 2026-10-16 and 2026-10-20 name the same mechanical defect: a JSDoc block that no longer sits on the declaration it documents. Two edits cause it. (1) New code is inserted between an existing `/** … */` block and its declaration. The doc then describes the inserted code, and the old declaration is left with none. Examples: `postReviewDue` between `drainMergeQueue`'s doc and its declaration (feature-5, 10-20), `quietHoursLine` inside `scheduleLine`'s doc (10-16), `entryRevisionFields` under `enqueueMerge`'s doc (dedupe, 10-18), `outcomeOrBadRequest` in src/gui/gui-backlog-commands.ts (dedupe, 10-18). (2) A declaration is deleted but its doc is kept, so the doc lands on the next declaration. Example: the `/** @deprecated Use …. */` line left above `export async function mergeHead` in test/fixtures/orchestrator-fixtures.ts (feature, 10-20 13:12), which marked a live fixture deprecated. Both shapes can be read straight from the `-U0` diff the self-check already builds in `gitLevelFindings`, so the author's fix-up turn can repair them before a review is spent.

**Approach.** All in src/run/stage-check.ts:
- Add `detachedDocFindings(wt: string, diff: string): string[]`. Call it in `gitLevelFindings` after `newlineFindings(diff)`. Put a `/** (e) … */` doc on it in the style of `newlineFindings`'s `(c)` doc, and add a sentence about it to the module header's paragraph on the fourth check.
- Walk the diff like `newlineFindings`: `diff --git` starts a file, and `+++ ` gives the path through `diffPlusPath`. Consider only paths matching the existing `JS_FILE` and not `/dev/null`. For each such file, read the head text once with `readTextOrNull(path.join(wt, file))`, split it on `"\n"`, and collect every hunk as `{ c, d, removed: string[], added: string[] }`. The header is `@@ -a[,b] +c[,d] @@`, and an omitted count means 1. `-` lines go into `removed` and `+` lines into `added`, without the marker. Lines are 1-based into the head file.
- Two module-level helpers:
  - `DOC_TARGET`: a regex for a line that can carry a doc comment. It is either a keyword declaration, `^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|const\b|let\b|var\b|class\b|interface\b|type\b|enum\b)`, or a class member or field, `^\s*(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*#?[A-Za-z_$][\w$]*\??\s*[(<:=]`. Combine them with `|` into one regex.
  - `closesDocComment(lines: string[], i: number): boolean` (0-based `i`). It is true when `lines[i].trim()` ends with `*/` and the nearest line at or above `i` that contains `/*` has a trimmed form starting with `/**`. This covers one-line blocks like `/** @deprecated Use b. */`.
- Rule (1), insertion. The hunk has `removed.length === 0` and `d > 0`. Head line `c - 1` must exist, closes a doc comment, and is not an added line of any hunk in this file. At least one `added` line matches `DOC_TARGET`. Head line `c + d` exists and matches `DOC_TARGET`. Report the site as `` `${file}:${c - 1}` ``.
- Rule (2), deletion. The hunk has `d === 0` and at least one `removed` line matching `DOC_TARGET`. Head line `c` (git's convention: the line before the deleted range) closes a doc comment and is not an added line. Report `` `${file}:${c}` ``.
- Emit at most one finding per rule, each listing its sites with `cappedList(sites, MAX_DETACHED_DOCS)`. Add the constant `MAX_DETACHED_DOCS = 10` beside `MAX_NEWLINE_FILES`, with a one-line doc. Wording:
  - (1) `code was inserted between a doc comment and the declaration it documents, so the doc now describes the inserted code: ${list} — move the inserted code above the doc comment or below that declaration`
  - (2) `a declaration was deleted but its doc comment was kept, so the doc now documents the next declaration: ${list} — delete the doc comment with it`
- Out of scope: a doc that disagrees with its own declaration's text, `//` line comments, and non-JS files.

**Files touched.** src/run/stage-check.ts and test/stage-check.test.ts. No invariants section names these findings (the self-check findings are advisory), so docs/invariants.md is unchanged.

**Acceptance criteria.** New tests in test/stage-check.test.ts. Each builds with `repoWith`, edits the worktree with `fs.writeFileSync`, and calls `stageCheckFindings(wt, "main", EXEMPT, "feature")`:
- "code inserted between a doc comment and its declaration yields the detached-doc finding": base `src/a.ts` is `/** Doc A. */\nexport function a() {}\n`. Head is `/** Doc A. */\n\nfunction ins() {}\n\nexport function a() {}\n`. There is exactly one finding matching `/inserted between a doc comment/`, and it names `src/a.ts:1`.
- "a documented helper inserted under another doc also yields it": the same base, with head `/** Doc A. */\n\n/** Doc ins. */\nfunction ins() {}\n\nexport function a() {}\n`. The finding names `src/a.ts:1`.
- "a deleted declaration whose doc comment stays yields the finding": base `test/f.ts` is `/** @deprecated Use b. */\nexport const old = b;\n\nexport function c() {}\n`. Head deletes only line 2. One finding matches `/its doc comment was kept/` and names `test/f.ts:1`.
- "deleting a declaration with its doc, adding a function after a declaration, or editing a declaration line yields no detached-doc finding": three edits on the Doc A base, each giving no finding that matches either regex. (a) Delete both lines of the deprecated alias in the `test/f.ts` base. (b) Append `\n/** Doc z. */\nexport function z() {}\n` after `a`. (c) Change `export function a() {}` to `export function a(x = 1) {}`.
- "a line comment inserted between a doc and its declaration yields no finding": the head inserts `// eslint-disable-next-line no-console` between `/** Doc A. */` and `export function a() {}`. No finding matches `/inserted between a doc comment/`.
- "a detached doc in a non-JS file is not reported": the rule (1) shape in `docs/a.md` gives no detached-doc finding.
- `npm run test:gate` passes.

## Done
