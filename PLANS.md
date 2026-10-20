# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

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

### docs/invariants.md gains a display-format section, so a fixer touching token counts, money, sizes, short hashes or the prompt-note separator reads what src/text/format.ts promises instead of rebuilding it from tests (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Appends after whatever invariants section is last. Touches docs/invariants.md, test/format.test.ts and a doc-comment move in src/text/format.ts)

**Replanned 2026-10-20 by the plan role:** the refusal's blocker is gone. test/invariants-doc.test.ts's `ID_RE` is now `/^INV-[A-Z]{1,2}\d+$/`, and `grep -n 'INV-AA' docs/invariants.md` found nothing on 2026-10-20, so `INV-AA` is a valid, free prefix.

**Goal.** src/text/format.ts is the single home of the display formats every surface renders through: `compactTokens` (status table columns, commit trailer ctx), `shortSha`, `usd`/`usdCap`, `formatGB`/`formatBytes`, and `appendPromptNote`, the one `\n\n` separator the run prompt assemblers stack sections with. `grep -n 'format.ts' docs/invariants.md` finds nothing today. test/format.test.ts pins most of the rules. `appendPromptNote` has no direct test (`grep -rn appendPromptNote test` finds nothing), so this plan adds one rather than citing a test that does not check it. The module also has a misplaced comment: `compactTokens`'s doc comment sits directly above `appendPromptNote`'s, so editors and hovers attach it to the wrong function. This plan moves it.

**Approach.**
- In src/text/format.ts, move the doc block that starts "Compact token count for tight table cells" so it sits directly above `export function compactTokens`. Leave `appendPromptNote`'s own doc block above it. Change no code and no other comment.
- Add one test to test/format.test.ts and add `appendPromptNote` to its existing import line. Title it exactly `appendPromptNote joins a note to the prompt with one blank line, even an empty note`. Assert the following:
  - `appendPromptNote("a", "b")` is `"a\n\nb"`.
  - `appendPromptNote("a", "")` is `"a\n\n"` (appended unconditionally).
  - `appendPromptNote("", "b")` is `"\n\nb"`.
  - `appendPromptNote(appendPromptNote("a", "b"), "c")` is `"a\n\nb\n\nc"`.
  Run the test before writing the doc section. If an assertion fails, the code is the contract: fix the assertion and the prose, and do not change the function.
- Append a new section at the very end of docs/invariants.md, after whatever section is last at that point. Title it `## Display formats: each number, money, size and hash format has one home and one rule`. Give it a two- or three-sentence intro in the register's style. Say that format.ts is presentation only and imports nothing but text.ts. Say that the GUI's browser script keeps its own twins of some of these formats (fmtTokens, the money and cap cells, the file-size label), which this section does not bind. Use the id prefix `INV-AA`. `grep -n 'INV-AA' docs/invariants.md` must find nothing first; if it finds something, use the next two-letter prefix that grep finds free (INV-AB and INV-AC are already taken, and the text-shaping plan uses INV-AD).
- Add five entries, each with **Guarantee.**, **Binds.** and **Pinned by.** like the existing ones. Before writing each guarantee, read the cited test and the matching code, and state only what the code does. Where a detail below is wrong, correct the sentence to match the code, not the plan.
  - `### INV-AA1: a token count is bare below 10,000, then one-decimal k, then one-decimal M`. Guarantee: `compactTokens` renders an integer as-is below 10,000, `(n/1000).toFixed(1)` + `k` from 10,000, and `(n/1e6).toFixed(1)` + `M` from 1,000,000. 999,999 reads `1000.0k`, the same as the report's table. Binds: src/text/format.ts (`compactTokens`). Pinned by: test/format.test.ts "compactTokens renders bare integers below 10,000", "compactTokens renders one-decimal k at and above 10,000" and "compactTokens renders one-decimal M at and above 1,000,000".
  - `### INV-AA2: a short hash is its first 8 characters, and a missing hash reads "?"`. Guarantee: `shortSha` slices `textOr` of its argument to 8 characters. A string or finite number abbreviates; `undefined`, `null`, an object, NaN or Infinity reads `?`, never `undefined`. Binds: src/text/format.ts (`shortSha`), src/text/text.ts (`textOr`). Pinned by: test/format.test.ts "shortSha abbreviates a hash to its first 8 characters".
  - `### INV-AA3: money always shows cents, and a cap drops only a whole-dollar .00`. Guarantee: `usd` renders `$` and exactly two decimals. `usdCap` renders the same, then strips a trailing `.00` only, so `$50` and `$12.34`, never `$12.3`. Binds: src/text/format.ts (`usd`, `usdCap`). Pinned by: test/format.test.ts "usd always keeps two decimals; usdCap drops a whole-dollar .00".
  - `### INV-AA4: a disk size is always GB, and a byte count takes the largest 1024-based tier`. Guarantee: `formatGB` renders one decimal and ` GB` at any magnitude. `formatBytes` picks GB, MB or KB at 1024-based thresholds with one decimal, and renders a count under 1024 as a bare integer with ` B`. Binds: src/text/format.ts (`formatGB`, `formatBytes`). Pinned by: test/format.test.ts "formatGB renders one decimal and the unit" and "formatBytes picks the largest of the B/KB/MB/GB tiers, one decimal each".
  - `### INV-AA5: a prompt note is joined by exactly one blank line, unconditionally`. Guarantee: `appendPromptNote` returns the prompt, `\n\n`, then the note, with no trimming and no skip for an empty note, so the separator lives in one place. Binds: src/text/format.ts (`appendPromptNote`). Pinned by: test/format.test.ts and the new test's exact title.
- Do not copy the consumer lists from the module's doc comments into the section: they go stale, and the register records what holds. Keep the words "tick", "loop" and "notebook" out of the new prose and the new test.
- Before citing it, check every quoted title with `grep -nF '<title>' test/format.test.ts`. The guard in test/invariants-doc.test.ts fails on a title that is not in the cited file.

**Files touched.** docs/invariants.md, test/format.test.ts, src/text/format.ts (comment move only).

**Acceptance criteria.**
- `grep -n '^### INV-AA' docs/invariants.md` lists INV-AA1 through INV-AA5 (or the fallback prefix), all under the new section, each with the three field labels.
- test/format.test.ts holds the new test and it passes.
- In src/text/format.ts, the "Compact token count" doc block directly precedes `export function compactTokens`, and `git diff src/text/format.ts` shows only moved comment lines.
- Every quoted title in the new section is found by `grep -F` in test/format.test.ts.
- Every backticked function the section binds is declared in the file it names (`grep -n 'function <name>'`).
- test/invariants-doc.test.ts passes unedited.
- `npm run test:gate` passes.


### docs/invariants.md gains a text-shaping section, so a fixer touching label truncation, prompt caps, count parsing or terminal-control stripping reads what src/text/text.ts promises instead of rebuilding it from tests (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Appends after whatever invariants section is last, so it only rebases over the display-format section if that merges first. Touches docs/invariants.md and test/text.test.ts only, not src/text/text.ts)

**Replanned 2026-10-20 by the plan role:** the refusal's blocker is gone. test/invariants-doc.test.ts's `ID_RE` is now `/^INV-[A-Z]{1,2}\d+$/`, and `grep -n 'INV-AD' docs/invariants.md` found nothing on 2026-10-20 (INV-AB and INV-AC are taken), so `INV-AD` is a valid, free prefix.

**Goal.** src/text/text.ts holds the one-line text rules that every display surface, prompt cap and input parser uses: `truncate` and `squash` bound a label, `truncateWithNote` caps text injected into a prompt with a visible marker, `parsePositiveInt`/`parseNonNegativeInt` define a valid count across CLI flags and GUI query params, and `stripTerminalControls` keeps untrusted text from driving the operator's terminal. `grep -n 'squash\|truncateWithNote\|parsePositiveInt\|stripTerminalControls' docs/invariants.md` finds nothing today. The terminal-text section only mentions `truncate` in passing. test/text.test.ts pins most rules directly, but `squash` has no direct test. Its doc comment says it collapses whitespace before it truncates, and that the order matters. Nothing fails today if the order is reversed. This plan adds that test and the section.

**Approach.**
- Add one test to test/text.test.ts, next to the truncate tests, and add `squash` to the existing import from `../src/text/text.js`. Title it "squash collapses whitespace before it bounds the line". Assert `squash("a\n\n\n\nbcd", 5) === "a bcd"`. Reversed (`collapseWhitespace(truncate(s, 5))`) that input gives `"a…"`, so the test catches a swapped order. Also assert `squash("  x  ", 10) === "x"`, and that `squash` of a long multi-line string with max 20 has no `\n` and is at most 20 characters long. Do not edit any existing test.
- Append a new section at the very end of docs/invariants.md, after whatever section is last at that point. Title it `## Text shaping: a bounded line never overflows or splits a character, and a count is plain decimal`. Give it a two-sentence intro in the register's style: text.ts is the single home of these rules so consumers cannot drift, and it is presentation and parsing only (node built-ins, importable from any layer). Use the id prefix `INV-AD`. Run `grep -n 'INV-AD' docs/invariants.md` first, and if it finds something, use the next free two-letter prefix.
- Add five entries, each with **Guarantee.**, **Binds.** and **Pinned by.** like the existing ones. Before writing each guarantee, read the cited test and the matching code, and state only what the code does. Where a detail below is wrong, correct the sentence to match the code, not the plan.
  - `### INV-AD1: a truncated line is at most max characters and never ends on a lone surrogate`. Guarantee: `truncate` returns `s` unchanged when it fits. Otherwise it cuts to `max - 1` code units, backing off one more when the cut would split a surrogate pair (`cutSplitsSurrogatePair`), drops trailing whitespace the cut leaves behind, and appends `…`. A non-positive `max` gives `""`. Binds: src/text/text.ts (`truncate`, `cutSplitsSurrogatePair`). Pinned by: test/text.test.ts "truncate leaves a string unchanged when it fits, including the exact boundary", "truncate cuts to at most max characters, ellipsis included", "truncate drops a trailing space the cut leaves behind before appending the ellipsis", "truncate never splits a surrogate pair (no lone surrogates in clipped labels)", "truncate never returns a string longer than max (the display-width invariant)" and "truncate with a non-positive max fits nothing and returns the empty string".
  - `### INV-AD2: a squashed detail is one line, collapsed before it is bounded`. Guarantee: `squash` is `truncate(collapseWhitespace(s), max)`. Every whitespace run becomes one space and both ends are trimmed before the cut, so the budget is spent on words, not on newlines. Binds: src/text/text.ts (`squash`, `collapseWhitespace`). Pinned by: test/text.test.ts "collapseWhitespace folds runs of spaces, tabs, and newlines to single spaces" and the new "squash collapses whitespace before it bounds the line".
  - `### INV-AD3: a capped prompt text keeps a plain prefix and always says it was cut`. Guarantee: `truncateWithNote` returns text of at most `max` characters unchanged. Past that it keeps exactly the first `max` code units (`max - 1` when that cut would split a surrogate pair), with no ellipsis or trim, and then appends `\n…[<label> truncated at <max> chars]`, which names `max`, not the number of units kept. Binds: src/text/text.ts (`truncateWithNote`, `cutSplitsSurrogatePair`). Pinned by: test/text.test.ts "truncateWithNote passes short text through and appends its marker past the cap" and "truncateWithNote never splits a surrogate pair at the cut boundary".
  - `### INV-AD4: a count parses only as a plain decimal digit run that is a safe integer`. Guarantee: both parsers accept only `^\d+$` with no leading zero (a lone `"0"` is allowed) that `Number()` gives as a safe integer. Hex, exponent, sign, whitespace padding, a decimal point, zero-padding and an overflowing run all give null. `parsePositiveInt` also rejects 0, and `parseNonNegativeInt` accepts it. Binds: src/text/text.ts (`parsePositiveInt`, `parseNonNegativeInt`). Pinned by: test/text.test.ts "parsePositiveInt accepts plain decimal only — hex, scientific, signed, and padded forms are null" and "parseNonNegativeInt accepts plain decimal only and allows zero".
  - `### INV-AD5: untrusted text reaches the terminal without control characters except newline and tab`. Guarantee: `stripTerminalControls` removes every C0 control except `\n` and `\t`, plus DEL and the C1 block U+0080–U+009F. ESC goes with the rest, so no OSC or CSI sequence survives. Name the two display boundaries the doc comment gives (the CLI's `say` and the composed TUI frame) only after confirming them with `grep -rn 'stripTerminalControls' src`, and state that event JSON is not stripped only if that grep supports it. Binds: src/text/text.ts (`stripTerminalControls`). Pinned by: test/text.test.ts "stripTerminalControls removes ESC/C0/C1/DEL and keeps only newline and tab".
- Do not cover `textOr` (the display-format section's INV-AA2 binds it), `gotSuffix`, `errorMessage`, the blank-line trimmers or `tooLongMessage`. Keep the words "tick", "loop" and "notebook" out of the new prose and the new test title.
- Before citing it, check every quoted title with `grep -nF '<title>' test/text.test.ts`. The guard in test/invariants-doc.test.ts fails on a title that is not in the cited file.

**Files touched.** docs/invariants.md, test/text.test.ts (one new test and the `squash` import).

**Acceptance criteria.**
- `grep -n '^### INV-AD' docs/invariants.md` lists INV-AD1 through INV-AD5 (or the fallback prefix), all under the new section, each with the three field labels.
- The new test fails when `squash`'s body is changed to `collapseWhitespace(truncate(s, max))` (check this locally, then restore the line), and passes as the code stands.
- `git diff --stat` touches only docs/invariants.md and test/text.test.ts.
- Every quoted title in the new section is found by `grep -F` in test/text.test.ts.
- Every backticked symbol the section binds is declared in the file it names (`grep -n 'function <name>'`).
- test/invariants-doc.test.ts and test/text.test.ts pass.
- `npm run test:gate` passes.

### docs/invariants.md pins the shared Markdown table and numbered-list builders, and `wake --list` numbers through `numberedList` (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Touches src/text/markdown.ts doc comments, src/operator/operator-intent.ts `renderWakeList`, docs/invariants.md's cross-surface section)

**Goal.** src/text/markdown.ts says it is "the one place" a Markdown table is joined and "the one place an ordered list is numbered". No invariant states that, so a fixer touching the failure digest, the usage report or the review prompts cannot read it. The second claim is also false today: `renderWakeList` in src/operator/operator-intent.ts (`tumwater wake --list`) builds its own `.map((w, i) => \`${i + 1}. …\`).join("\n")`. Move that site onto `numberedList`, then add two entries to the "Cross-surface agreement: one fact, one computation" section. They use the section's own prefix (`INV-A5`, `INV-A6`), so they pass the guard's current one-letter `ID_RE` and do not wait on the two-letter-prefix plan.

**Approach.**
- src/operator/operator-intent.ts: import `numberedList` from `../text/markdown.js`. Make the body of `renderWakeList` `return numberedList(wakes.map((w) => \`in ${humanUntil(w.atMs, now)} — ${w.roles.join(", ")}\`), noWakePending(roles));`, dropping the early return. `noWakePending` is a pure string builder, so computing it eagerly changes nothing. The output stays byte-for-byte the same, and test/operator-intent.test.ts "renderWakeList numbers wakes and words the empty case" must pass unedited.
- src/text/markdown.ts: in `numberedList`'s doc comment, add `tumwater wake --list`'s wake lines (operator/operator-intent.ts `renderWakeList`) to the list of sharers. Change no code there.
- Leave alone src/merge/merge-queue-render.ts's indented `  ${i + 1}. …` lines, which are pushed one per entry into a larger block with a two-space indent, and test/review-verdict.test.ts's fixture. Those are not the `numberedList` shape.
- docs/invariants.md, append after `INV-A4` in "Cross-surface agreement" and match its entry format (**Guarantee.** / **Binds.** / **Pinned by.**):
  - `### INV-A5: a Markdown table's separator always matches its header`. Guarantee: `markdownTable` derives the separator row from the header, one `---` cell per header cell (`---:` where `align` says `right`, left past the end of `align`), and renders cells verbatim. So the failure digest's tables and the usage report's day table can never emit a separator that collapses the table into plain text. Binds: `src/text/markdown.ts` (`markdownTable`), `src/failure/failure-render.ts`, `src/report/report-render.ts`. Pinned by: `test/markdown.test.ts`, "markdownTable's separator always carries as many cells as the header" and "markdownTable defaults every column to left alignment".
  - `### INV-A6: every numbered list numbers through one helper`. Guarantee: `numberedList` numbers items from 1 as `N. item`, one per line, and returns its `empty` argument verbatim for no items. The review prompt's prior objections and findings, the rejected/revision notes, `tumwater questions`' list and `wake --list` all build through it. Binds: `src/text/markdown.ts` (`numberedList`), `src/prompt/gate-prompts.ts`, `src/prompt/gate-notes.ts`, `src/backlog/question-answer.ts`, `src/operator/operator-intent.ts` (`renderWakeList`). Pinned by: `test/markdown.test.ts`, "numberedList numbers items from 1, one per line" and "numberedList returns the empty fallback verbatim for no items", plus `test/operator-intent.test.ts`, "renderWakeList numbers wakes and words the empty case".
  - Before writing, run `grep -n '^### INV-A' docs/invariants.md` to confirm `INV-A5`/`INV-A6` are still free, and take the next free numbers if not. Re-check each Binds file with `grep -n 'markdownTable\|numberedList'`, and drop any that no longer calls the helper.

**Files touched.** src/operator/operator-intent.ts, src/text/markdown.ts (doc comment only), docs/invariants.md.

**Acceptance criteria.**
- `grep -rn 'i + 1}\. ' src` lists only src/text/markdown.ts (the helper and its doc comment) and src/merge/merge-queue-render.ts.
- `renderWakeList` calls `numberedList`. "renderWakeList numbers wakes and words the empty case" passes with no edit to its assertions.
- docs/invariants.md has the two new entries under "Cross-surface agreement", and "this repo's docs/invariants.md is honest" (test/invariants-doc.test.ts) passes. Each quoted test title must match a test in the cited file.
- `npm run test:gate` passes.

### docs/invariants.md gains a shared-phrases section, so a fixer touching count wording, hold spans, the budget phrase, tool-call labels or the fallback wordings reads what src/text/phrases.ts promises instead of rebuilding it from tests (planned 2026-10-20 by the plan role; no dependency on any Planned entry. Appends after whatever invariants section is last, so it only rebases over the display-format, text-shaping and Markdown-builder sections if they merge first. Touches docs/invariants.md and test/phrases.test.ts only, not src/text/phrases.ts)

**Goal.** src/text/phrases.ts is the single home of the team's shared wording: `plural`/`agree` pick a count's number form, `shortSpanPhrase`/`holdPhrase` word a hold's span, `budgetPhrase` words a spend against its cap, `describeToolCall` builds the one-line tool-call label, and `firstReason`/`backendKindPhrase` fall back to fixed wording on an unreadable field. `grep -n 'phrases' docs/invariants.md` found nothing on 2026-10-20. test/phrases.test.ts pins the label, the budget phrase, the span rounding and the two fallbacks, but it does not import `plural`, `agree` or `holdPhrase`, and `grep -n "text/phrases" test/*.ts` shows no other test file importing them (only test/doctor-backlog.test.ts, for `shortSpanPhrase`). So nothing pins the plural rule (`n === 1` is singular, 0 and every other count are plural), or `holdPhrase`'s clamp of a negative or unreadable hold to `0s` and its relapse tail. This plan adds those two tests and the section.

**Approach.**
- Add two tests at the end of test/phrases.test.ts, and add `agree`, `holdPhrase` and `plural` to the existing import from `../src/text/phrases.js`. Do not edit any existing test.
  - "plural and agree treat exactly one as singular and every other count as plural": `plural(1, "run") === "1 run"`, `plural(0, "run") === "0 runs"`, `plural(2, "run") === "2 runs"`, `plural(2, "role is", "roles are") === "2 roles are"`, `agree(1, "is", "are") === "is"`, `agree(0, "is", "are") === "are"`.
  - "holdPhrase clamps an unreadable or negative hold to 0s and adds the relapse only past zero": `holdPhrase(60_000, 0) === "for 60s"`, `holdPhrase(180_000, 2) === "for 3m (relapse 2)"`, `holdPhrase(-5000, undefined) === "for 0s"`, `holdPhrase("x", "y") === "for 0s"`, `holdPhrase(undefined, undefined) === "for 0s"`. Before writing each assertion, run it against the code (for example with a scratch `node --experimental-strip-types -e` import, or by running the test file through `npm run test:gate`) and state the value the code gives. Where a value above is wrong, correct the assertion to match the code, not the plan.
- Append a new section at the very end of docs/invariants.md, after whatever section is last at that point. Title it `## Shared phrases: a count agrees with its noun, a hold or budget never reads NaN, and an unreadable field falls back to fixed wording`. Give it a two-sentence intro in the register's style: phrases.ts is the single home of these wordings so the event feed, failure digest, status surfaces and CLI cannot drift, and it is pure presentation over format.ts's tokens. Run `grep -n '^### INV-' docs/invariants.md | tail` first and use the next free two-letter prefix after every one in use (`INV-AE` when AA–AD are the newest; the display-format and text-shaping plans take INV-AA and INV-AD).
- Add five entries, each with **Guarantee.**, **Binds.** and **Pinned by.** like the existing ones. Read the cited test and the matching code before writing each guarantee, and state only what the code does.
  - `INV-AE1: a count's word is singular for exactly one and plural for every other count`. Binds `plural`, `agree`. Pinned by the new plural test. Mention that the GUI keeps its own JS copy in gui-client.ts, which this entry does not bind.
  - `INV-AE2: a span under two minutes reads in seconds, and a hold never reads negative`. Binds `shortSpanPhrase`, `holdPhrase`. Pinned by "shortSpanPhrase rounds a near-two-minute span into the minute arm, never 120s" and the new holdPhrase test.
  - `INV-AE3: a budget phrase reads a non-numeric field as $0.00, never $NaN`. Binds `budgetPhrase`. Pinned by "budgetPhrase reads a non-numeric or non-finite event field as $0.00, never $NaN".
  - `INV-AE4: a tool-call label is one bounded line naming the path's basename or the command after any leading cd`. Binds `describeToolCall`, `withoutLeadingCd`. Pinned by "describeToolCall summarizes common arg shapes tersely", "describeToolCall with an omitted toolName yields the bare detail, no leading space", "describeToolCall basenames path-like keys and shows the others verbatim", "describeToolCall prefers the first present key in path, file_path, command, cmd, pattern, url order", "describeToolCall falls back to the bare tool name for non-object or non-string args" and "describeToolCall drops a leading cd so the label names the command". State the 32-character bound only after confirming the `squash(detail, 32)` call.
  - `INV-AE5: an unreadable reason or failure kind falls back to fixed wording`. Binds `firstReason`, `backendKindPhrase`. Pinned by "firstReason returns the first string reason and falls back when there is none" and "backendKindPhrase names each backend-failure kind and falls back on an unreadable kind".
- Do not cover the pause, resume, main-red, stop or consecutive-failure phrases: their wording is pinned by the consumers' tests, and the rename series may still reword them. Keep the words "tick", "loop" and "notebook" out of the new prose and the new test titles.
- Check every quoted title with `grep -nF '<title>' test/phrases.test.ts` before citing it. The guard in test/invariants-doc.test.ts fails on a title that is not in the cited file.

**Files touched.** docs/invariants.md, test/phrases.test.ts (two new tests and the widened import).

**Acceptance criteria.**
- `grep -n '^### INV-AE' docs/invariants.md` (or the fallback prefix) lists five entries under the new section, each with the three field labels.
- The new plural test fails when `plural`'s condition is changed to `n <= 1`, and the new holdPhrase test fails when `holdPhrase`'s `Math.max(0, …)` clamp is removed (check both locally, then restore the lines). Both pass as the code stands.
- `git diff --stat` touches only docs/invariants.md and test/phrases.test.ts.
- Every quoted title in the new section is found by `grep -F` in test/phrases.test.ts.
- Every backticked symbol the section binds is declared in src/text/phrases.ts (`grep -n 'function <name>'`).
- test/invariants-doc.test.ts and test/phrases.test.ts pass.
- `npm run test:gate` passes.

## Done
