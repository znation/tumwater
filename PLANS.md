# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Plain terms code runner, part 5/14: Convert the status renderer and payload and the team alerts (planned 2026-10-16 by user; requires part 4/14 landed; design in plans/terminology.md "Code names"; touches src/ui/status-render.ts + src/ui/status-payload.ts + src/ui/team-alerts.ts + their tests)

**Goal.** The status table renderer, the status payload builder and the team alerts use role and runner names, and `AlertLoop` becomes `AlertRole`.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/ui/team-alerts.ts: `AlertLoop` → `AlertRole` (its test is the only other user, so no alias). The `loops` parameter of the alert builders → `roles`.
- src/ui/status-render.ts and src/ui/status-payload.ts: migrate to `rolePhase`, `roleRank`, `sortRolesByState`, `roleRowCells`, `roleWakeMarker`, `RunnerState` and `freshRunnerState`; rename the local `loops` arrays of display rows → `roles` (check each scope for an existing `roles` binding first); convert comments.
- `StatusLoopRow` is declared in src/status/ (part 9/14); leave its uses here for that part.
- Tests: test/status-render.test.ts, test/status-render-cells.test.ts, test/status-payload.test.ts, test/team-alerts.test.ts: migrate names, comments and titles. test/status-render.test.ts's local `dryRow` is Plain terms code cleanup's.

**Files touched.** src/ui/status-render.ts, src/ui/status-payload.ts, src/ui/team-alerts.ts, test/status-render.test.ts, test/status-render-cells.test.ts, test/status-payload.test.ts, test/team-alerts.test.ts.

**Acceptance criteria.**
- `AlertRole` is declared and `AlertLoop` appears nowhere in src/ or test/.
- `grep -nE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_|\bloops?\b'` over this part's files lists only `StatusLoopRow` uses and kept senses.
- No behavior change: status table output in the tests is byte-identical and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 6/14: Convert the TUI and the merge and review modules (planned 2026-10-16 by user; requires part 5/14 landed; design in plans/terminology.md "Code names"; touches src/ui/tui/ + the other src/ui/*.ts + src/merge/ + src/review/ + src/verdict/ + their tests)

**Goal.** The TUI, the remaining src/ui/ modules, and the merge, review and verdict modules use role and runner names in identifiers, comments and test titles.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- This part declares nothing new. It migrates uses of `RoleRunner`, `RunnerState`, `freshRunnerState`, `loadRunnerState`, `saveRunnerState`, `RunnerPi`, `makeRoleRunner` and `rolePhase`, and converts comments. Most hits are comments: src/ui/tui/tui-keys.ts (about 45 lines), tui-editors.ts, tui.tsx, tui-pane.ts and tui-input.ts.
- src/ui/tick-progress-model.ts, progress-data.ts, transcript.ts and transcript-tail.ts: comments and `LoopState` uses. The tick words in tick-progress-model.ts are Plain terms code run's; leave them.
- src/merge/, src/review/ and src/verdict/: `LoopState`/`saveLoopState`/`LoopRunner`/`LoopPi`/`loopPhase` uses and comments ("the authoring loop" → "the authoring role").
- Tests: test/tui*.test.ts, test/progress.test.ts, test/fixtures/tui-fixtures.ts, the merge tests and fixtures (test/merge-*.test.ts, test/merge-to-main*.test.ts, test/merge-drain-verify.test.ts, test/merger*.test.ts, test/work-merged-cache.test.ts, test/fixtures/merge-fixtures.ts, merger-fixtures.ts and merge-to-main-fixtures.ts), test/review*.test.ts, test/refusal.test.ts, test/reply-contract.test.ts, test/no-change.test.ts and test/attribute-red-check.test.ts. Leave test/tui-notebook.test.ts's file name to Plain terms code cleanup; convert only its loop words.

**Files touched.** src/ui/tui/*.ts(x), src/ui/tick-progress-model.ts, src/ui/progress-data.ts, src/ui/transcript.ts, src/ui/transcript-tail.ts, src/merge/*.ts, src/review/*.ts, src/verdict/*.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_'` over this part's files lists only `customLoop*` identifiers.
- `grep -rnwiE 'loops?'` over the same files lists only kept senses and serialized names.
- No behavior change: TUI frames and merge outcomes in the tests are unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 7/14: Rename the dashboard's role card and drawer code (planned 2026-10-16 by user; requires part 6/14 landed; design in plans/terminology.md "Code names"; touches src/ui/gui/ + src/gui/ + test/gui*.test.ts + test/cli-gui.test.ts + test/helpers/gui-client-scope.ts)

**Goal.** The dashboard's browser code and server glue name the Roles card, drawer and rank by role, including `GUI_CLIENT_ROLES_JS` and the DOM ids and CSS classes the card uses.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message. Dashboard hashes were renamed by Plain terms scripting, and the legacy `#loop/<id>` route must keep working.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- The gui-client modules are browser code inside `String.raw` templates, which tsc does not check, so rename by hand and verify by test. The client modules are concatenated into one script (`GUI_CLIENT_JS` in src/ui/gui/gui-client.ts), so a new name must not collide across them; `grep` all of src/ui/gui/ before each rename.
- Server-side exports: `GUI_CLIENT_LOOPS_JS` → `GUI_CLIENT_ROLES_JS` (src/ui/gui/gui-client-roles.ts and its use in gui-client.ts).
- Browser functions and constants: `openLoop` → `openRole`, `openLoopRole` → `openRoleId`, `toggleLoop` → `toggleRole`, `renderLoopDrawer` → `renderRoleDrawer`, `renderLoops` → `renderRoles`, `patchLoops` → `patchRoles`, `sortLoops` → `sortRoles`, `loopRank` → `roleRank` (the browser twin in gui-client-model.ts, which interpolates `ROLE_RANK_RULES`), `loopPhase` → `rolePhase`, `loopCells` → `roleCells`, `loopKeys` → `roleKeys`, `LOOP_TDS` → `ROLE_TDS`, `LOOP_GROUPS` → `ROLE_GROUPS`, `wasLoop` → `wasRole`, and `loadLoopTicks` → `loadRoleRuns` (its final name, so Plain terms code run does not touch it again).
- DOM and CSS names in gui-page.ts, gui-styles.ts and the client modules: id `loops` → `roles`, `loopstable` → `rolestable`, `loops-title` → `roles-title`; classes `loops` → `roles` and `c-loop` → `c-role`; the drawer kind `"loop"` → `"role"`. First confirm `.roles` and `.c-role` are not already used as selectors in gui-styles.ts.
- test/helpers/gui-client-scope.ts and the gui tests reach browser functions by name: update them. In test/gui-client-boot.test.ts the local `let openRole` would collide with the renamed `openRole` hook, so rename the local `openedRole`.
- src/gui/ (gui-endpoints.ts, gui-prompt-commands.ts, gui-args.ts, gui-backlog-commands.ts, http-body.ts, gui-operator-commands.ts, gui-team-commands.ts): comments and any `LoopState`/`loadLoopState` uses.
- If a String.raw line carries `// vocabulary-ok: …` only because of a word renamed here, drop the marker.

**Files touched.** src/ui/gui/*.ts, src/gui/*.ts, test/gui*.test.ts, test/cli-gui.test.ts, test/fixtures/gui-fixtures.ts, test/helpers/gui-client-scope.ts.

**Acceptance criteria.**
- `GUI_CLIENT_ROLES_JS` is declared and `GUI_CLIENT_LOOPS_JS` appears nowhere.
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_|c-loop|loopstable|"loops?"|#loops\b|\.loops\b' src/ui/gui src/gui` lists only payload keys that are not this series' and kept senses.
- The dashboard tests that open a role drawer by `#role/<id>` and by the legacy `#loop/<id>` hash both pass, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 8/14: Convert the orchestrator and its tests (planned 2026-10-16 by user; requires part 7/14 landed; design in plans/terminology.md "Code names"; touches src/orchestrator/ + test/orchestrator*.test.ts + test/fixtures/orchestrator-fixtures.ts)

**Goal.** The orchestrator and its unit and e2e tests use `RoleRunner`, `RunnerState` and runner/role wording.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/orchestrator/orchestrator.ts, orchestrator-scheduling.ts, orchestrator-launch.ts and retention.ts: migrate `LoopRunner` → `RoleRunner`, `loopEnabled` → `runnerEnabled`, `loopIds` → `runnerIds`, `saveLoopState` → `saveRunnerState` and `LoopState` → `RunnerState`, and convert comments ("the LoopRunners above" → "the RoleRunners above"). The poll loop stays the poll loop.
- Tests: every test/orchestrator*.test.ts and test/orchestrator*.e2e.test.ts (`loadLoopState` alone is about 170 lines here), plus test/fixtures/orchestrator-fixtures.ts. Rename test locals per the series rules; test/orchestrator-2.e2e.test.ts's `loopOrder` → `roleOrder`.
- Locals such as `dryTicks` and `dryFailedAt` carry role-id and tick words, which belong to later series; leave them.

**Files touched.** src/orchestrator/*.ts, test/orchestrator*.test.ts, test/orchestrator*.e2e.test.ts, test/fixtures/orchestrator-fixtures.ts.

**Acceptance criteria.**
- `grep -rnE 'LoopRunner|LoopState|[a-z]LoopState|loopIds|loopEnabled'` over this part's files prints nothing.
- `grep -rnwiE 'loops?'` over the same files lists only the poll loop and other kept senses.
- No behavior change: the suite's test count is unchanged, including the e2e tier (`npm run test:e2e` passes).
- `npm run test` passes.

### Plain terms code runner, part 9/14: Convert status data and scheduling (planned 2026-10-16 by user; requires part 8/14 landed; design in plans/terminology.md "Code names"; touches src/status/ + src/scheduling/ + their tests + test/fixtures/status-fixtures.ts)

**Goal.** The status collectors and the scheduler use runner and role names: `StatusLoopRow` becomes `StatusRoleRow`, and `loopStateForPoll` becomes `runnerStateForPoll`.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/status/: `StatusLoopRow` → `StatusRoleRow`. It is also used by src/ui/status-payload.ts, so migrate that use here rather than leaving an alias. Also `loopStateForPoll` → `runnerStateForPoll` and `loopStateCache` → `runnerStateCache`. The `for (const loop of loops)` in status-polls.ts → `for (const runner of runners)` (check the scope first). Migrate `LoopState`, `freshLoopState`, `loadLoopState` and `loopIds`, and convert comments (status-data.ts has about 35 comment lines).
- src/scheduling/ (scheduling.ts, backoff.ts, claims.ts, once-round.ts, quiet-hours.ts and the work-merged cache module): migrate `LoopState`/`LoopRunner`/`loopEnabled`, and convert comments.
- Tests: test/status-data*.test.ts, test/status-roles.test.ts, test/status-budget.test.ts, test/status-header.test.ts, test/status-inbox.test.ts, test/fixtures/status-fixtures.ts, test/scheduling.test.ts, test/backoff.test.ts, test/claims.test.ts, test/once-round.test.ts, test/quiet-hours.test.ts and the work-merged-cache test. Migrate `makeRoleRunner`, `freshRunnerState` and `spentRunnerState`, and convert comments and titles.

**Files touched.** src/status/*.ts, src/scheduling/*.ts, src/ui/status-payload.ts (the `StatusRoleRow` use only), and the tests listed above.

**Acceptance criteria.**
- `StatusRoleRow` and `runnerStateForPoll` are declared; `StatusLoopRow` and `loopStateForPoll` appear nowhere.
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_'` over this part's files prints nothing.
- No behavior change: status payloads in the tests are unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 10/14: Convert config and roles and init (planned 2026-10-16 by user; requires part 9/14 landed; design in plans/terminology.md "Code names"; touches src/config/ + src/roles/ + src/init/ + their tests)

**Goal.** The config, role-catalog and init modules use runner and role wording; this part is mostly comments.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/config/ (config-schema.ts has about 25 comment lines, plus config.ts, config-write.ts, config-validation.ts, config-live.ts, config-fallbacks.ts, config-views.ts and config-field-checks.ts): migrate `LoopRunner`, `LoopState`, `loopIds` and `loopEnabled`, and convert comments. In comments, "custom loop" and "user-defined loop" → "custom role"; the `customLoop*` identifiers and the legacy `customLoops` config key stay for Plain terms code cleanup or for good.
- src/roles/ (role-view.ts, role-render.ts, roles.ts, role-guidance.ts and role-catalog.ts; runner-ids.ts was part 2/14's): comments and any uses. Prompt text inside role-catalog.ts and role-guidance.ts string literals was converted by Plain terms text; do not touch strings.
- src/init/init.ts: comments.
- Tests: test/config*.test.ts, test/role-view.test.ts, test/roles.test.ts, test/role-guidance.test.ts, test/prompt-roles.test.ts and test/init*.test.ts.

**Files touched.** src/config/*.ts, src/roles/*.ts except runner-ids.ts, src/init/*.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_'` over this part's files lists only `customLoop*`/`CUSTOM_LOOP_*` identifiers and the legacy `customLoops` key handling.
- `grep -rnwiE 'loops?'` over this part's comments lists only kept senses.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 11/14: Convert the inbox and operator and prompt and CLI modules (planned 2026-10-16 by user; requires part 10/14 landed; design in plans/terminology.md "Code names"; touches src/inbox/ + src/operator/ + src/prompt/ + src/cli/ + their tests)

**Goal.** The inbox, operator, prompt and CLI command modules and their tests use runner and role names.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/inbox/ (prompt-commands.ts, inbox.ts, inbox-cancel.ts, inbox-edit.ts, inbox-submit.ts, pending-prompt.ts, inbox-attachments.ts, prompt-not-before.ts): comments and `LoopState`/`LoopRunner` uses. In prompt-commands.ts, the two locals `const loop = …` holding a role id → `const targetRole` (check the scope).
- src/operator/ (operator-commands.ts, operator-requests.ts, operator-intent.ts, retire.ts): migrate `loadLoopState`/`saveLoopState`/`LoopRunner`/`loopEnabled` and convert comments.
- src/prompt/ (prompt.ts, gate-prompts.ts, prompt-followup.ts): comments only. Prompt string literals were converted by Plain terms text.
- src/cli/ (cli-run.ts, cli-flag-specs.ts, cli-query-commands.ts, cli-command-args.ts, cli-args.ts, log-commands.ts, config-commands.ts, completion.ts, notify-command.ts): uses and comments. The `run`→`start` names in cli-run.ts are Plain terms code run's.
- Tests: test/inbox*.test.ts, test/prompt*.test.ts (not prompt-roles, part 10/14's), test/pending-prompt.test.ts, test/gate-prompts.test.ts, test/operator*.test.ts, test/retire.test.ts, and test/cli-*.test.ts except cli-history*, cli-logs* and cli-gui (parts 13/14 and 7/14). test/prompt.test.ts's `loopPrompts` → `rolePrompts`.

**Files touched.** src/inbox/*.ts, src/operator/*.ts, src/prompt/*.ts, src/cli/*.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE '[Ll]oop[A-Z]|[a-z0-9]Loop|LOOP_'` over this part's files lists only `customLoop*` identifiers.
- `grep -rnwiE 'loops?'` over this part's comments and test titles lists only kept senses.
- No behavior change: CLI output asserted by the tests is unchanged, and the suite's test count is unchanged.
- `npm run test` passes.

### Plain terms code runner, part 12/14: Convert the run pipeline modules and the baseline and build modules (planned 2026-10-16 by user; requires part 11/14 landed; design in plans/terminology.md "Code names"; touches src/tick/ + src/baseline/ + src/build/ + test/tick-*.test.ts + their other tests)

**Goal.** The run pipeline modules under src/tick/, which Plain terms code run renames next, and the baseline and build modules use `RunnerState`, `RoleRunner` and role wording, so the run series only handles tick words.

**Approach.**
- Series rules (every code-runner part):
  - Identifier words follow plans/terminology.md "Code names", row "loop": `runner` for the worker object, its state and an instance id; `role` for what the status table, dashboard and TUI show.
  - Keep `loopback*`, `pollLoop`, `crashLoop`, `onCrashLoop`, every `customLoop*`/`CUSTOM_LOOP_*` identifier, and "loop" meaning a JavaScript loop, the poll loop, the event loop, or a retry, crash or feedback loop.
  - Serialized names (state-file fields, event fields, `--json`/`/api` keys, config keys, env vars) are out of scope; name any leftover in the commit message.
  - Legacy readers keep the old names on purpose; rename nothing inside them: the legacy-name tables in `normalizeLegacyEvent`, the state loaders' legacy-key maps, the `legacyLand*` path helpers, src/orchestrator/startup-migrations.ts and startup-migration-steps.ts, `CONFIG_KEY_RENAMES` in src/config/config-aliases.ts, src/roles/legacy-role-ids.ts, and test fixtures that deliberately write old event names or state keys to disk. test/retired-names.test.ts exempts them through `LEGACY_FILES`, identifiers whose first word is `legacy`, `// retired-name-ok: <reason>` lines and `retired-name-ok:start`/`end` regions; mark any new such site with one of those, never a new mechanism.
  - A bare `loop`/`loops` binding becomes `runner`/`runners` (or `role`/`roles` for ids or display rows), never shadowing a name already bound in an enclosing scope.
  - Comments and test titles: "loop" → "role", or "runner" when the sentence is about the `RoleRunner` object or one instance's state. Leave quoted PLANS.md/BUGS.md titles, `plans/*.md` names and commit subjects alone; rewrap comments past 100 columns; update docs/invariants.md quotes of test titles you change.
  - Exports used outside this part get a two-line alias, `/** @deprecated Use NewName. */` on its own line above `export const OldName = NewName;` (`export type` for a type). Never write it on one line: test/exports.test.ts skips lines starting `/**`, so a dead one-line alias would linger unseen; members get none. A new name needs a user outside its own file in the same part (its test counts), or test/exports.test.ts fails. Migrate this part's uses of earlier renames (`grep -rn '@deprecated Use' src test`), and delete any alias no other file names (test/exports.test.ts).
- src/tick/ (tick-apply.ts, tick-verdict.ts, tick-prompt.ts, tick-stage.ts, tick-resume.ts, tick-usage.ts, tick-finalize.ts, tick-detail-data.ts, tick-outcome.ts, tick-timing.ts, tick-detail.ts, stage-check.ts, qa-coverage.ts): migrate `LoopState` → `RunnerState` (about 24 lines), `LoopRunner`, `saveLoopState`, `loadLoopState` and `loopPhase`, and convert "loop" in comments. Leave every tick word: Plain terms code run renames the directory and its names.
- `mergeQueuedByLoop` and `outcomeByLoop`, the members of `bucketMergeEvents`' result that join merge-queue and outcome events by runner, are declared in src/history/ (part 13/14); leave them.
- src/baseline/ (main-red.ts, main-baseline.ts) and src/build/ (build-check-events.ts, build-check.ts, dep-install.ts): comments and uses.
- Tests: test/tick-*.test.ts (tick-apply.test.ts alone has about 66 lines, mostly `freshLoopState`), test/main-*.test.ts, test/build*.test.ts, test/stage-check.test.ts, test/qa-coverage.test.ts, test/dep-install.test.ts and test/check-permit.test.ts.

**Files touched.** src/tick/*.ts, src/baseline/*.ts, src/build/*.ts, and the tests listed above.

**Acceptance criteria.**
- `grep -rnE 'LoopState|LoopRunner|[a-z]LoopState|loopPhase'` over this part's files prints nothing.
- `grep -rnwiE 'loops?'` over this part's comments and test titles lists only kept senses.
- No behavior change: the suite's test count is unchanged.
- `npm run test` passes.

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

### Check-wait observability, part 2/2: `tumwater doctor` names check-slot contention and the dashboard Settings edits `maxConcurrentChecks` (planned 2026-10-19 by the plan role; requires part 1/2 landed; independent of every other eligible Planned entry — the TUI-editor entries touch src/ui/tui and its seams, which this part does not, and the blocked plain-terms series reaches src/doctor and src/config only in far-behind parts; touches src/doctor/doctor-checks.ts src/doctor/doctor.ts src/config/config-editable-keys.ts src/ui/gui/gui-client-settings.ts docs/cli.md docs/config.md docs/how-it-works.md test/doctor-checks.test.ts test/gui-client-settings.test.ts)

**Goal.** Part 1/2 records `check_wait` events, but nothing reads them: an operator sees a check wait only by grepping the feed. The two sibling waits already have a consumer: `checkWorktreePool`'s workspace row sums `slot_wait` and names `worktreeSlots`, and `checkProviderContention` sums `provider_wait` and names `maxConcurrentPerProvider`; both knobs are dashboard-editable because `tumwater doctor` names them (the rationale on `EDITABLE_CONFIG_KEYS`). `maxConcurrentChecks` is the third such cap, documented in docs/config.md and `TOP_LEVEL_KEYS`, validated by `validateConfig`'s `checkNumber(r, "", "maxConcurrentChecks", POSITIVE_INTEGER)`, but editable only by hand in `tumwater.json` — it is in neither `EDITABLE_CONFIG_KEYS` nor the dashboard's `SETTINGS_KEYS`. This part adds the missing consumer and surface: a `check contention` doctor row that warns over a 24 h window and names the cap, and a dashboard Settings row for it.

**Approach.**
- **src/doctor/doctor-checks.ts** — add `const CHECK_WAIT_CHECK_WINDOW_MS = 24 * 3600_000;` and `const CHECK_WAIT_WARN_TOTAL_MS = 10 * 60_000;` beside `SLOT_WAIT_*`/`PROVIDER_WAIT_*`, and `export function checkCheckContention(root: string, config: TumwaterConfig | undefined, now = Date.now()): CheckOutcome`, mirroring `checkProviderContention` minus the per-key grouping: read `eventsSince(root, CHECK_WAIT_CHECK_WINDOW_MS, now, (ev) => ev.type === "check_wait")` inside a try/catch that returns `okOutcome("could not read the event log for check waits: " + errorMessage(err))` on a read error; accumulate `count`, `total` and `longestMs` from `finiteNumber(ev.waitedMs, 0)`; return `okOutcome("no check waits")` when `count === 0`; build `detail = `${plural(count, "wait")} for a check slot in the last 24h, ${shortSpanPhrase(total)} total, longest ${shortSpanPhrase(longestMs)}``; when `total >= CHECK_WAIT_WARN_TOTAL_MS`, append ` — raise maxConcurrentChecks above ${config?.maxConcurrentChecks ?? defaultConfig().maxConcurrentChecks}` and return `warnOutcome(detail)`, else `okOutcome(detail)`. Import `defaultConfig` from `../config/config.js` (not yet imported in this file) and `TumwaterConfig` is already in scope.
- **src/doctor/doctor.ts** — register `{ name: "check contention", ...checkCheckContention(root, config) },` directly after the `{ name: "provider contention", ... }` row, and add `checkCheckContention` to the existing `./doctor-checks.js` import list.
- **src/config/config-editable-keys.ts** — add `"maxConcurrentChecks"` to `EDITABLE_CONFIG_KEYS` in the run-concurrency group with `maxConcurrent`/`maxConcurrentPerProvider`/`worktreeSlots`, and extend the block comment so the trio becomes a quartet and it names `checkCheckContention` beside `checkWorktreePool`/`checkProviderContention` as the check that advises this key.
- **src/ui/gui/gui-client-settings.ts** — add `["maxConcurrentChecks", "Max concurrent checks"],` to `SETTINGS_KEYS` directly after the `maxConcurrentPerProvider` row; the existing `test/gui-client-settings.test.ts` pin (`SETTINGS_KEYS.map(([key]) => key)` equals `EDITABLE_CONFIG_KEYS`) then covers it.
- **docs/config.md** — extend the `maxConcurrentChecks` table row (currently "The most runs of the project's check in flight at once across the whole team.") to name the dashboard Settings field, like the `worktreeSlots`/`provider` rows.
- **docs/cli.md** — in the `Configure` row's list of dashboard-edited keys, add `maxConcurrentChecks` beside the run-concurrency caps; in the `Audit` row's `tumwater doctor` sentence, add the new `check contention` row: sums the last 24 h of `check_wait` events and warns at 10 minutes, naming `maxConcurrentChecks` to raise.
- **docs/how-it-works.md** — extend the `maxConcurrentChecks` bullet (part 1/2 already added the `check_wait` sentence) to say `tumwater doctor`'s `check contention` row sums the last 24 h and warns at 10 minutes, the way the `provider contention` sentence reads.

**Tests.**
- **test/doctor-checks.test.ts** — mirror the existing `checkProviderContention` tests: with `check_wait` events logged via `logEvent` in a temp root, `checkCheckContention(root, config, now)` reports no warns for a total below 10 minutes, and a warn whose detail names the total, the longest wait, and `raise maxConcurrentChecks above 2` when `config` omits the key; with `config = { maxConcurrentChecks: 5 }` the advice says `above 5`; an empty event log yields "no check waits"; an unreadable log yields a non-warn "could not read the event log" outcome.
- **test/gui-client-settings.test.ts** — the existing `SETTINGS_KEYS`-equals-`EDITABLE_CONFIG_KEYS` assertion covers the new row; extend the label assertion so `maxConcurrentChecks` maps to `Max concurrent checks`.

**Acceptance criteria.**
- `tumwater doctor` includes a `check contention` row after `provider contention`: it reports `no check waits` with an empty log; a 24 h total below 10 minutes is ok and names the count, total and longest; a total at or above 10 minutes is a warn naming the count, total, longest and `maxConcurrentChecks` to raise. `--problems` keeps only that warn row when it is the only warn.
- The advice names the live cap when `tumwater.json` sets `maxConcurrentChecks` and the default (2) otherwise, and the row reads nothing but `check_wait` events (doctor stays read-only).
- `maxConcurrentChecks` is in `EDITABLE_CONFIG_KEYS` and the dashboard Settings view renders a `Max concurrent checks` row backed by it, editable through the same `/api/config-set`/`/api/config-unset` routes; the `SETTINGS_KEYS`-equals-`EDITABLE_CONFIG_KEYS` test passes.
- `tumwater config set maxConcurrentChecks 4` remains the live-apply path (unchanged); docs/config.md, docs/cli.md and docs/how-it-works.md name the dashboard field and the doctor row.
- `npm test` passes.

### `tumwater logs --type` takes a comma-separated list of event types, so one feed or tally shows every event of the kinds an operator is chasing (planned 2026-10-19 by the plan role; independent of every eligible Planned entry — touches only `src/cli/log-commands.ts`, `src/cli/help.ts`, docs/cli.md and `test/cli-logs-filtering.test.ts`)

**Goal.** `logs --type` filters the event feed by ONE exact type today (`cmdLogs`, `src/cli/log-commands.ts`), so a question that spans kinds — "every `merge_failed` and `review_rejected` in the last day", "count the `run_deferred` and `run_end` events" — takes one command per type or a loose `--grep` that also matches lines quoting those words. Accept `--type a,b,c`: an event passes when its type equals any listed type (after `canonicalEventType`), in every view `--type` already composes with (`-n`, `--since`, `-f`, `--grep`, `--count`, `--json`). A single type behaves exactly as now.

**Approach.**
- **src/cli/log-commands.ts** — after `parseTypeFlag` (unchanged: it still returns the raw value), split `type` on `,`, trim each piece and drop empty pieces; when that leaves none (e.g. `--type ,`), `fail(TYPE_VALUE_ERROR)`. Build `wantedTypes = new Set(pieces.map(canonicalEventType))` and make `typeFilter` test `wantedTypes.has(e.type)`. Replace the `--since` branch's inline `events.filter((e) => e.type === wantedType)` with `events.filter(typeFilter)` so the window, the `-n` view, the tally and the follow share the one predicate (`feedFilter` already threads `typeFilter`). Rework `typeEmpty(type)` to take the raw value and its pieces: the prose stays `no events matching "<raw value as typed>"`, and the did-you-mean hint is `typoSuffix` of the FIRST piece whose canonical form is not an `EVENT_TYPE_LABELS` key (no hint when every piece is valid). The single-type output is then unchanged character for character. Update the `--type` comment block above `parseTypeFlag`'s call to say a comma list matches any of its types.
- **src/cli/help.ts** — the `logs` usage reads `[--type <event type>[,<event type>...]]` and the prose says `--type shows only events of the listed exact event types (comma-separated)`; keep the `--type <event type>` substring so `test("tumwater help logs documents --type")` still matches.
- **docs/cli.md** — the `Check state` row's `tumwater logs --type <event type>` clause names the comma list (`--type merge_failed,review_rejected` shows events of either type).
- Completion is untouched: `src/cli/completion.ts` keeps offering single codes, which still complete the first piece of a list.

**Tests** (in `test/cli-logs-filtering.test.ts`, beside `test("logs --type prints only events of exactly that type, where --grep substrings")`, reusing its event-seeding helpers):
- `logs --type merge_failed,review_rejected -n 50` prints both types' rows in log order and omits other types; ` merge_failed , review_rejected ` (spaces around the pieces) behaves the same.
- `--since 1h --type a,b` filters the window to both types, and `--count --type a,b` tallies only those two types.
- `--type merge_faild,review_rejected` matching nothing prints `no events matching "merge_faild,review_rejected"` plus the did-you-mean hint naming `merge_failed`; `--type merge_failed,review_rejected` with neither present prints the prose with no hint.
- `--type ,` fails with `TYPE_VALUE_ERROR`'s wording and a non-zero exit.
- The existing single-type `--type` tests pass unchanged.

**Acceptance criteria.**
- `tumwater logs --type a,b` shows exactly the events whose canonical type is `a` or `b`, in the `-n`, `--since`, `-f`, `--count` and `--json` views, and composes with `--grep` (type-list AND text) as the single type does; an older event name in the list matches its current one.
- A single `--type <t>` produces output identical to today's, including the empty-match prose and its hint (the existing single-type tests pass untouched).
- An empty-match list names the value as typed and hints only for the first invalid piece; a list with no non-empty piece fails with `TYPE_VALUE_ERROR`.
- `tumwater help logs` and docs/cli.md document the comma list; `npm test` passes.

### Split the backend from the model in tumwater.json: `backend` is a sibling of `model` in every selector (planned 2026-10-19 by user; independent of every other eligible Planned entry — the blocked plain-terms series reaches src/config, src/status and src/roles in parts 10/14, 17/20 and cleanup 3/7-4/7 (the latter renames the same backend-selector helpers), so whichever lands second rebases; the in-flight TUI editor entries touch src/ui/tui and docs/cli.md, which this does not; touches src/config/config-schema.ts src/config/config.ts src/config/config-keys.ts src/config/config-validation.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-write.ts src/config/config-aliases.ts src/config/model-selector.ts src/status/status-budget.ts src/roles/role-view.ts src/ui/badges.ts tumwater.json README.md docs/backends.md docs/config.md docs/glossary.md plans/agent-backends.md plans/model-tiers.md plans/opencode-backend.md plans/provider-concurrency.md plans/fallback-chain.md plans/terminology.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-live.test.ts test/config-write.test.ts test/config-unset-key.test.ts test/config-aliases.test.ts test/badges.test.ts test/role-view.test.ts test/status-data-models.test.ts)

**Needs review 2026-10-19 by feature: too large for one run**

**Goal.** One config value carries two independent choices today: which agent CLI runs a seam (`pi`, `claude`, `opencode`) and which model it runs. `backend` only decides the first for the seams whose model id does not already imply it, so the same string encodes the backend in one of six overlapping spellings — `claude/<id>` (the provider segment used as a namespace), `opencode/<id>`, a bare `claude-…` id (rule 3a, whatever `backend` says), `anthropic/<id>` (a pi provider, documented as the way to keep a Claude model off the claude CLI), any other `provider/<id>` (pi), and a bare id with no namespace (the top-level `backend`). `AGENT_IDS` doubles as a provider namespace (src/config/config-schema.ts:37-41) and rule 1 reads it back out (src/config/model-selector.ts:97-113). The operator's complaint is the proof: pointing the opencode CLI at an Anthropic model needs `opencode/anthropic/claude-sonnet-5-5`, because `anthropic/claude-sonnet-5-5` already means "pi, provider anthropic" — a third segment invented only to disambiguate an axis the config never separated. This entry separates the axes: `backend` becomes a sibling of `model` (and `thinking`) everywhere a model is chosen — the top level, a `model` map's tier entry, a `roles`/`customRoles`/`review` entry, a `fallback` step — so each choice is made on its own and a model id is only ever a model id, in the vocabulary of the backend that runs it. The key keeps its shipped name (`backend` is what the schema, CLI, GUI, glossary and tests call this axis); in this repo "harness" already means tumwater itself (`HARNESS_*_FLAGS`, "the harness's commit identity" in docs/code-metrics.md), and the axis's *meaning* is unchanged — only the structure moves.

**Approach.**
- **The selector shape.** `backend` becomes a sibling of `model` and `thinking` wherever a model is chosen, instead of a fleet-wide key the model id has to be read against: the top-level `backend` (a string, `"pi"` by default — the ambient default, its type unchanged), a `model` map's tier entry, a `roles.<id>`/`customRoles[]`/`review` entry, and a `fallback` step. A string stays a plain model selector; the object form `{ backend?, model?, thinking? }` names either axis alone (fallback steps also take `maxDailyCostUsd`). src/config/config-schema.ts's `FallbackStep` (:28) and the `model` map's value type widen to that one selector shape, `FALLBACK_STEP_KEYS` (:31) becoming its key list, so validation and the dotted-key readers own one shape instead of two.
- **Resolution stays per field.** `withModelOverrides` (src/config/config-views.ts:99-121) resolves the seam's backend as the section's `backend` ?? its tier entry's `backend` ?? the top-level `backend` ?? `"pi"`, beside the model fields exactly as `provider` resolves today. So a role can move the backend and inherit the model, or move the model and inherit its tier's backend, and one tier can cross backends with no parallel map to keep in step.
- **A fallback step inherits the backend of the model it falls back from** (its tier's primary), so a chain stays inside one backend unless a step says otherwise; crossing backends is that step's own `backend`. The team's own pi fallback under a claude fleet is therefore `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }`.
- **Routing takes the backend as an input.** `routeModel(backend, model, tier)` (src/config/model-selector.ts): pi splits `provider/id[:thinking]` (the legacy top-level `provider` key still in scope; a provider-less pi id is refused), claude takes the id verbatim — claude's `--model` is its own vocabulary, so a claude-routed id bearing a `/` is a load error — and opencode takes the id verbatim as OpenCode's own `--model` string: a bare id gets the gateway's `opencode/` provider and an id with a `/` is provider-qualified and passes as-is (src/agent/opencode/opencode-args.ts:69-79). So the opencode CLI with an Anthropic model is `{ "backend": "opencode", "model": "anthropic/claude-sonnet-5-5" }`, and no nested `opencode/…` id exists anywhere. Delete rule 1's `isAgentId(provider)` routing, rule 3a's bare-`claude-` prefix, and the `opencode/` namespace; `AGENT_IDS` keeps only its config-id job.
- **The per-backend tier defaults stay**, now reached only through the axis: `AGENT_DEFAULT_MODELS` (src/config/model-selector.ts:73-83) resolves against the seam's backend, so `backend: "claude"` with no `model` still fills claude's tier defaults (and `CLAUDE_GATED_MODELS`, src/agent/claude/claude-backend.ts:88-96, keeps deriving from the same table), while pi and opencode leave their own CLI's default in charge. No seam is forced to name a model it does not have.
- **Every retired spelling is a load error naming its fix** (the operator chose no shims, and a silent switch between backends is the one outcome worse than a failed load). In `validateConfig`'s raw pass, which is where a file's own shape is judged: the top-level `agent` key (drop the `agent → backend` row from `CONFIG_KEY_RENAMES`, src/config/config-aliases.ts:48, so nothing silently renames into the next error); a model id whose first segment names a backend (`claude/claude-opus-5-5` → "write `backend: \"claude\"` beside `model: \"claude-opus-5-5\"`"); a bare `claude-…` id under `backend: "pi"` ("add `backend: \"claude\"`, or write `anthropic/claude-…` to keep it on pi"); a `/`-bearing id under `backend: "claude"`; and `opencode/…` in a pi position ("write `backend: \"opencode\"`" — pi's built-in `opencode` provider stays unreachable from tumwater, docs/backends.md). Each message names the offending value and the exact edit.
- **Surfaces reason in pairs, not a scalar.** `BudgetSlice.backend` (src/status/status-budget.ts:35, :153) is the one place a single backend is asserted for a whole fleet: delete it and have src/ui/badges.ts:228's `<x> default` fallback label pass the constant `pi default` (the engaged pair already carries its own backend-qualified id through `fallbackDisplayPair`). The per-seam `backend` fields stay and are what the orthogonal model wants: src/roles/role-view.ts:397, doctor's routing row (src/doctor/doctor-checks.ts:87). `teamModelLabel` (src/config/config-views.ts:345-357) keeps agent-qualifying every tier's label from the resolved backend, so a tier that flips backend still logs `model_changed`.
- **Docs.** README.md (`Backends` and `Mixing providers`, whose `anthropic/`-prefix hack and `backend: "pi"` clause become the two-axis story); docs/backends.md (the intro; "How the config points at it"; the `Claude Code (backend: "claude")` sample and its "provider names a backend id always routes there regardless of the top-level `backend`" paragraph at :149-153, which rule 1's deletion retires; the image-input bullet at :99; the opencode section's model-ids paragraph, where `opencode/anthropic/…` disappears); docs/config.md (the `backend` row at :59 becomes the per-selector default; the `model` row and the bare-`claude-` note at :113); docs/glossary.md (a row for the two axes, and the rename tables at :154/:244, which no longer carry `agent → backend`); [plans/agent-backends.md](plans/agent-backends.md) §3's config section (rules 1-4 rewritten, rule 1 retired), [plans/model-tiers.md](plans/model-tiers.md) (tier entries may be selector objects), [plans/opencode-backend.md](plans/opencode-backend.md) §2, [plans/provider-concurrency.md](plans/provider-concurrency.md) §9 (rule 3a retired), plans/fallback-chain.md (a step may cross backends), plans/terminology.md's config-key rows.
- **The team's own config** migrates in the same change: `"backend": "claude"` stays, `model` loses the namespace (`"claude-sonnet-5-5"`, `"claude-opus-5-5"`), and the pi fallback names its backend — `"fallback": { "default": { "backend": "pi", "model": "qwenrunner/qwen3.8-27b" } }`.
- **Deliberately out of scope.** The code's adapter-seam identifiers (`AgentBackend`, `registerAgentBackend`, backend-traits.ts, agent-backend.ts) keep their names for the plain-terms cleanup series (parts 3/7-4/7) — this entry changes the config surface's structure, not that vocabulary — and the legacy `provider` key and `fallbackModel` object keep parsing exactly as they do.

**Tests.**
- **test/model-selector.test.ts** — the routing table is driven by the backend input now: pi splits `provider/model` and refuses a provider-less id; claude keeps a bare id (the `claude/<id>` case moves to config-validation as an error); opencode passes a bare id through as `opencode/<id>` and a provider-qualified id as-is, so the existing nested-id case becomes `backend: "opencode"` + `model: "anthropic/claude-sonnet-5-5"`.
- **test/config-validation.test.ts** and **test/config-validation-model.test.ts** — one case per retired spelling (the `backend` block at :340-350 becomes them): the `agent` key, `claude/<id>`, a bare `claude-…` under pi, a `/` id under claude, `opencode/…` under pi — each asserting the message names the offending value and the fix — plus the pair checks (a claude-routed id with a slash, a pi-routed id with no provider).
- **test/config-views.test.ts** — per-field resolution: a tier entry's `backend` moves that tier only; a role's `backend` moves that role only; a role naming only a `model` inherits its tier's backend; `seamsInUse` on this repo's migrated config yields the same 18 claude seams and one pi fallback the file resolves to today.
- **test/config-live.test.ts** — a tier's `backend` edit logs `model_changed` with the backend in the label (the file's bare-id flip case becomes this), and a fallback step's `backend` is part of the pair identity.
- **test/config-write.test.ts** / **test/config-unset-key.test.ts** — an object-valued `model.<tier>` and a `{ backend, model, maxDailyCostUsd }` fallback step round-trip through the dotted-key merge and a whole-config write.
- **test/config-aliases.test.ts** — `agent` is a load error naming `backend` (the rename row is gone); `agents` still renames to `backends`.
- **test/badges.test.ts** — the over-cap fallback label is byte-identical: the `pi default` constant path plus a `claude/<model>` pair.
- **test/role-view.test.ts** / **test/status-data-models.test.ts** — the per-seam `backend` field renders the resolved backend, a tier-entry or role override included.

**Acceptance criteria.**
- A `model` map's tier entry, a `roles`/`customRoles`/`review` entry and a fallback step each accept `backend` beside `model`; no model id anywhere in tumwater.json names a backend, and `"model": { "strong": { "backend": "claude", "model": "claude-opus-5-5" } }` under a pi default moves only the strong tier (the director, review and resolver follow it, and every surface label carries the backend).
- This repo's migrated config resolves to exactly today's routing — 18 claude primary seams, `qwenrunner/qwen3.8-27b` on pi — proven by dumping `seamsInUse` before and after.
- Every retired spelling is a load error naming the offending value and the exact edit; `grep -rn 'isAgentId(provider)\|startsWith(\"claude-\")' src` finds neither rule, and a bare `claude-…` id under a pi backend no longer routes anywhere.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults, and `CLAUDE_GATED_MODELS` still gates exactly those three; `backend: "pi"` and `"opencode"` with no model leave each CLI's own default in charge.
- The opencode CLI with a non-gateway model is `{ "backend": "opencode", "model": "anthropic/claude-sonnet-5-5" }` — OpenCode's own spelling, priced and billed by OpenCode — and no `opencode/<provider>/<model>` id survives in src, test or docs.
- `BudgetSlice` has no scalar backend field, and the badge and the dashboard drawer render today's strings for a claude-primary/pi-fallback team.
- README.md, docs/backends.md, docs/config.md and docs/glossary.md describe the two axes and name no namespace-form ids; plans/agent-backends.md §3, plans/model-tiers.md, plans/opencode-backend.md §2, plans/provider-concurrency.md §9, plans/fallback-chain.md and plans/terminology.md record the split.
- `npm test` passes.

### Give the director an own-clock retry for its unmerged change, not only a prompt-driven one (planned 2026-10-19 by user; independent of every eligible Planned entry — the TUI-editor entries and the check-wait pair (src/build, src/events, src/doctor, src/config) and the backend/model split (src/config, src/status, src/roles) touch none of this part's files; the blocked plain-terms series reaches src/scheduling (runner 9/14, run 12/20), src/orchestrator (runner 8/14, run 10/20-11/20), src/runner (run 8/20-9/20) and src/tick (run 1/20-5/20) only in far-behind parts, so whichever lands second rebases; touches src/scheduling/scheduling.ts + src/orchestrator/orchestrator-scheduling.ts + src/runner/leftover.ts + src/runner/runner-run.ts + src/tick/tick-resume.ts + docs/how-it-works.md + test/scheduling.test.ts + test/leftover.test.ts + test/orchestrator-scheduling.test.ts + test/orchestrator-director.test.ts + test/runner-leftover-recovery.test.ts + test/orchestrator.e2e.test.ts)

**Goal.** A change whose merge fails non-terminally keeps its merge ref and is retried by "next-tick leftover recovery, never the queue" (`src/events/events.ts:41`): `docs/how-it-works.md:281-283` promises "a commit left unmerged (a merge error that kept it, or a crash before it was queued) goes back in the merge queue at the role's next run, which ends there instead of authoring". Thirteen roles get that next run from their own min-run clock; the director is the only role with no clock — `isEligible` returns a run for it only when `inboxCount > 0` (`src/scheduling/scheduling.ts:60-63`), so after a `merge_blocked` (`src/tick/tick-apply.ts:290-296` sets `lastResult`, so the dashboard reads "Merge blocked") a director with an empty inbox sits on the kept pin **forever** and nothing retries it. The exemption that creates this is a *cost* argument — an explicit human prompt outranks any autonomous gate, `src/orchestrator/orchestrator-scheduling.ts:217-235` — but a leftover-recovery run spends nothing: it authoring-runs no pi and ends in about a second (`finishRecoveryTickPhase`, `src/runner/runner-recovery.ts:94-136`). **Goal:** a director holding a kept merge pin is due on the same min-run clock a `queued` outcome already schedules (`scheduleAtMinInterval`, `src/tick/tick-apply.ts:157-169`; default 20 s), and that promptless run re-enqueues the pin exactly as a prompt-driven leftover-recovery run does today.

**Approach.**
- **The due reason.** `src/scheduling/scheduling.ts`: add `leftoverPending?: boolean` to `EligibilityOptions` (documented as "the role holds a kept merge pin a previous merge failed to land") and the director branch becomes `if (inboxCount > 0) return { run: true, reason: "inbox" }; if (opts.leftoverPending) return now >= s.nextRunAt ? { run: true, reason: "leftover" } : { run: false }; return { run: false };`. The inbox arm stays first, so a queued prompt never waits the clock. The `nextRunAt` gate is what keeps the retry from spinning: a persistently blocked fast-forward (a dirty primary checkout, or main moving under the ff) is never counted (`src/merge/merge-check-failures.ts:113-115`), so without the clock every poll would re-queue the same pin and pay a full gate+merge check per cycle; `nextRunAt` is the interval the `queued` outcome already wrote, the same cadence every other role retries its kept pin at. The director is never yield-scaled (`docs/how-it-works.md:184-190`), so the plain clock — not `yieldMultiplierFor` — is the right one.
- **The predicate.** `src/runner/leftover.ts`: add `export async function hasUnmergedPin(root: string, role: string): Promise<boolean>` — true when `refSha(root, mergeRefName(role))` (`src/paths.ts:467-469`) resolves. Placed beside `recoverLeftover`, the one reader of that same ref, so the poll and the recovery path cannot disagree on what "unfinished" means. A pin main already holds is left to `recoverLeftover` (it deletes the stale ref and returns null), so the cheap ref-presence answer is enough and no `isMergedInto` probe is added to the poll.
- **The poll.** `src/orchestrator/orchestrator-scheduling.ts`: beside the one-list-per-poll `queuedRoles` snapshot (`:141-146`), compute `const pinnedDirector = !queuedRoles.has(DIRECTOR_ROLE) && (await hasUnmergedPin(root, DIRECTOR_ROLE))`. The `!queuedRoles` clause keeps the merge-queue interlock authoritative (`:330-338`): while the pin is queued or in flight the interlock already holds the role, and the leftover reason must not read as operator demand. Pass `leftoverPending: pinnedDirector` into the `isEligible` call. The gates above it (subscription-window hold, per-role pause, disk hold, restart hold) already cover the new reason, so no gate decision changes; `commitTier(DIRECTOR_ROLE)` is "work" (`src/roles/roles.ts:116-121`), so the maintenance allowance never holds it. The reason rides into the `wake` event (`src/orchestrator/orchestrator-launch.ts:139-141`) and renders as `woke (leftover)` (`src/events/event-format.ts:213`).
- **Reachability — the real seam.** Recovery sits inside the prompt-bearing path: `planTickStart` returns null for a null prompt (`src/tick/tick-resume.ts:187`) and `runTickPhase` returns `{ result: "skipped" }` before any worktree work (`src/runner/runner-run.ts:348`). Add one input to `planTickStart` — `recoveryOnly?: boolean`, set by the runner when `ctx.pending.get() === null` and the shared `hasUnmergedPin` predicate holds — and, when set, return a plan with `prompt: null`, `resuming: false`, `handoff: false`, `userPrompt: null` instead of the null-plan early return. `TickStartPlan.prompt` widens to `string | null` and its doc comment (`src/tick/tick-resume.ts:15-34`) changes from "Never null" to "null only for a promptless recovery run".
- **The promptless tick.** `src/runner/runner-run.ts`: `tickWithWorktreePhase`'s leftover-recovery block already runs first and returns via `ctx.finishRecoveryTick` when it salvaged the pin. Add the other arm: when recovery found nothing (or deleted a stale pin) **and** `prompt === null`, end there — `await resetWorktreeToMain(wt, ctx.mainBranch); return { result: "skipped" };` — immediately after the recovery block and before the red-main gate, so a run that authors nothing never reaches `ctx.pi.runAuthoringPi(wt, prompt, …)` with a null prompt.
- **Do not consume the pending reroute.** `runTickPhase`'s director branch clears `s.imageReroute` once the tick is confirmed to run (`:349-363`), so the image-reroute one-shot is delivered with exactly one prompt. Gate that clear on `plan.prompt !== null`: a promptless recovery run must leave a pending reroute for the prompt that follows it. The director's dedicated worktree hold (`useWorktree`, same branch) is unchanged and still wraps the recovery run.
- **What it deliberately does not change.** Scope is the director only. Every other role already gets a next tick from its own clock, and after a `queued` result that clock is the role's own min interval, so their pins already retry "at the role's next run". Widening the rule to every role would let a steward retry a blocked merge on a ~20 s clock instead of its 6 h one — a team-wide pacing change this entry does not make. The director still authors nothing without a prompt: a recovery-only tick's outcomes are `queued` (pin salvaged), `skipped` (nothing to salvage), or `error` (the pin is held on a permanent reviewer-config error, `recoverLeftover`'s `held` arm, which stays on the error ladder). With a prompt queued the flow is today's exactly: recovery salvages the pin, `finishRecoveryTick` hands the prompt back (`ctx.pending.requeueUnfulfilled`, `src/runner/runner-recovery.ts:101-103`) and the tick ends `queued`; the next poll's tick runs the prompt.
- **Docs.** `docs/how-it-works.md`: the Interruptions bullet at `:281-283` gains the director clause (its next run is otherwise only ever an operator prompt, so it is also due on its own min-run clock while a pin is kept); the Scheduling director bullet at `:174` gains the same sentence, naming the `woke (leftover)` wake event.

**Tests.**
- **test/scheduling.test.ts** — the director arm, beside the existing inbox case: `isEligible(director, now, head, 0, { leftoverPending: true })` is `{ run: false }` before `nextRunAt` and `{ run: true, reason: "leftover" }` at/after it; `{ leftoverPending: false }` with an empty inbox stays `{ run: false }`; a non-empty inbox stays `{ run: true, reason: "inbox" }` whatever `leftoverPending` is (the inbox arm never waits the clock).
- **test/leftover.test.ts** — `hasUnmergedPin` is false with no ref and true with one; a stale pin (the sha contained in main) reads true until `recoverLeftover` deletes it, then false — pinned beside the existing stale-pin recovery case.
- **test/orchestrator-scheduling.test.ts** — a director whose state holds a kept merge ref and an empty inbox appears in the poll's reasons map with `"leftover"`; while a merge-queue entry for the director exists, it does not (`queuedRoles` wins and no demand is counted).
- **test/runner-leftover-recovery.test.ts** — the promptless run: with a kept pin, an empty inbox and `recoveryOnly`, the tick logs `merge_queued` for the same sha, ends `queued` with `recoveredLeftover`, runs no pi (the fake-pi records zero authoring calls), logs no `prompt_taken`, and leaves a pending `imageReroute` marker in place; with no pin and no prompt it ends `skipped` and touches nothing.
- **test/orchestrator.e2e.test.ts** — mirror the file's "a queued prompt wakes the idle director (reason: inbox)" case at `:272-313`: pin `refs/tumwater/merge/director` to a commit off main with an empty inbox, run the fast team, and require a director `wake` event with `reason: "leftover"`, a tick that re-enqueues the same sha and runs no authoring pi, and — the control — no director tick at all when the ref is absent and the inbox is empty.
- **test/orchestrator-director.test.ts** — the once-round twin: `run --once` recovers the director's kept pin and still drains the merge queue before exit; an idle director with neither prompt nor pin still settles as idle (the existing `test/orchestrator-once.test.ts:124` case stays green unchanged).

**Acceptance criteria.**
- A director holding `refs/tumwater/merge/director` and an empty inbox ticks on its own min-run clock (`reason: "leftover"`), logs `merge_queued` re-enqueueing the pin, runs no pi, and ends `queued` — the end state a prompt-driven leftover-recovery run reaches today — with no `prompt_taken` event.
- A promptless director with no kept pin still skips: no tick, no wake, `nextRunAt` untouched (byte-identical to today's idle behavior, `test/orchestrator-once.test.ts:124` included).
- The retry never beats `nextRunAt`: after a `merge_blocked` the director waits the min interval the `queued` outcome scheduled, so a persistently blocked fast-forward cannot spin the merge queue, and a held pin (permanent reviewer-config error) stays on the error ladder rather than the min-interval one.
- With a prompt queued and a pin kept the behavior is today's exactly: one recovery tick that hands the prompt back, then the authoring tick (the existing double-`prompt_taken` pin in `test/pending-prompt.test.ts` stays green).
- A recovery-only tick consumes no pending image reroute; the next prompted director tick still starts on the reroute's target.
- Every other role's eligibility and retry cadence are unchanged: `leftoverPending` reaches only the director arm, and no non-director schedule changes.
- `docs/how-it-works.md`'s Interruptions and Scheduling director bullets name the director's own-clock recovery and the `woke (leftover)` wake.
- `npm test` passes.

## Done
