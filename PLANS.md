# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Merge on `check.gateCommand` when `check.mergeCommand` is unset, and review clean, dedupe and coverage after merging by default (planned 2026-10-21 by user; design in plans/fast-merge.md "Defaults"; touches src/build/build-check-detect.ts src/config/config.ts src/config/config-validation.ts src/doctor/doctor-checks.ts docs/config.md docs/how-it-works.md DEVELOPMENT.md and their tests)

**Goal.** Fast merge parts 6/14 and 14/14 shipped `check.mergeCommand` and `review.afterMerge` as opt-in keys. tumwater.json is gitignored, so no team commit could set them. On 2026-10-21 the merge lock still ran the full `npm test` on every code merge (142–330 s each, the latest at 02:24), and every role was still reviewed before merging. Make both on by default (decided 2026-10-21 by you): a project that declared `check.gateCommand` merges on it, and clean, dedupe and coverage are reviewed after merging, unless the config opts out. This repo's tumwater.json sets `gateCommand`, so both switches take effect here at the next redeploy.

**Approach.**
- `mergeCommandOf` (src/build/build-check-detect.ts) is the one accessor every merge-path reader uses; `gateCommandOf` beside it is unchanged. Change `mergeCommandOf` alone, distinguishing an absent key from a blank one:
  - `check.mergeCommand` absent → `gateCommandOf(config)` — the new default, so a project with only `check.gateCommand` set merges on it;
  - a non-blank string → that string;
  - a blank string (`""`) → undefined: the explicit opt-out, which keeps the full check in the merge lock even when a gate command is set.

  The merge-path readers that call `gateCommandOf` directly keep their behavior through their own `mergeCommandOf` checks: in `verifyMerge` (src/merge/merge-to-main.ts) a verified no-op rebase now takes the `mergeCommandOf !== undefined` skip and seeds nothing, and `onlyExemptDriftFromVerified` returns before seeding. Update both doc comments — `mergeCommandOf`'s and the `check.mergeCommand` comment in src/config/config-validation.ts — to say the absent key falls back to `gateCommandOf`.
- `review.afterMerge`: add `afterMerge: ["clean", "dedupe", "coverage"]` to `defaultConfig().review` (src/config/config.ts). `overlayDefaults` already merges `review` key by key, so a config that omits the key inherits it, and `"afterMerge": []` opts out. The readers (src/review/review.ts ~350, src/review/post-merge-review.ts ~36) need no change.
- Never write a default into tumwater.json. A config write through the existing writers (the TUI and dashboard editors, the director's config requests) leaves an absent `mergeCommand` or `afterMerge` absent. Check this against the writer INV-B3 binds (docs/invariants.md), and add a test if none covers it.
- `tumwater doctor`'s `check` row (`checkBuildCheck`, src/doctor/doctor-checks.ts) gains the facts a reader cannot get today: the in-lock command from `mergeCommandOf(config)`, so the row reads `npm test · merge lock runs npm run test:gate, full check after merging`, or `… full check in the merge lock` when it is undefined. `CheckConfigSlice` already carries `check`, so no new plumbing is needed; do not name the after-merge roles here — they live under `review`, which that slice does not hold, and the `review` row in docs/config.md already documents them.
- Docs:
  - docs/how-it-works.md: rewrite the `**Check.**` bullet's sentence "The full check then still runs once per merge, over the batch or the single change, and a failing result there blocks the merge" — the pre-change rule the objection named. It should say that with a gate command set the in-lock command is that gate command, unless `check.mergeCommand` names another or `""` opts back into the full check in the lock, and that main's full check runs on the tip after the merge via the main watch. Keep the paragraph's later `check.mergeCommand` sentences, adjusting only what the new default makes stale; the `review.afterMerge` bullet lower in the file already describes the after-merge review and needs no change.
  - docs/config.md's `check` row: `mergeCommand` defaults to `gateCommand`, and `""` keeps the full check in the lock. The `review` row's default gains `"afterMerge":["clean","dedupe","coverage"]`, and the row says `[]` opts out.
  - DEVELOPMENT.md's "The gate runs the affected tests" paragraph: "The full `npm test` still runs once per merge, on the rebased tree, and on main's baseline, unless `check.mergeCommand` is set" becomes "…unless a gate or merge command is set (`check.mergeCommand` defaults to `check.gateCommand`)".
- Tests that assumed the old defaults change only their fixture config, not their assertions:
  - Merge tests that set `gateCommand` and expect the full check in the lock set `mergeCommand: ""`.
  - Tests that expect clean, dedupe or coverage to be reviewed before merging set `afterMerge: []`.

**Files touched.**
- Source: src/build/build-check-detect.ts, src/config/config.ts, src/config/config-validation.ts (comment only), src/doctor/doctor-checks.ts.
- Docs: docs/config.md, docs/how-it-works.md, DEVELOPMENT.md.
- Tests: test/build-check-detect.test.ts (the `mergeCommandOf: on for a real string, off for blank or missing` case gains an absent key plus `gateCommand` set → the gate command, and `""` plus `gateCommand` set → undefined), test/config-validation-check.test.ts, test/config-write.test.ts, test/post-merge-review.test.ts, the doctor tests for `checkBuildCheck`, and the fixture configs of merge and review tests that relied on the old defaults.

**Acceptance criteria.**
- With `check.gateCommand` set and no `mergeCommand`, `mergeCommandOf` returns the gate command. A fake merge runs it in the lock, not the full check, and the main watch runs the full check afterwards.
- With `"mergeCommand": ""` and a gate command, the in-lock check is the full check, as before Fast merge part 6/14.
- With neither key set, the full check runs in the lock, as today.
- With no `review.afterMerge` in the file, a clean change merges with no `review_start` before its `merged` event, and gets an `afterMerge` review. With `"afterMerge": []`, it is reviewed before merging.
- Writing an unrelated key through the config writer leaves both keys absent from the file.
- doctor's `check` row names the in-lock command and where the full check runs.
- docs/how-it-works.md's `**Check.**` bullet and DEVELOPMENT.md's "The gate runs the affected tests" paragraph no longer say the full check runs once per merge when a gate command is set.
- `npm test` passes.

### Codex backend, part 2c/9: The budget gate's window move, chain reasons and director move read each subscription backend's own used-up window (planned 2026-10-21 by the plan role; requires parts 2a/9 and 2b/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/gates/budget-gates.ts test/budget-gates.test.ts test/budget-chain-info.test.ts)

**Goal.** Part 2c was too large for one run, so it is split into 2c (this part, the gate), 2d/9 (the hold observation and the once-per-window polls) and 2e/9 (the poll loop). This part makes the budget gate read each subscription backend's own used-up window instead of one claude `windowOut`, so a job moving down its chain, the director's move and each tier's chain reason name the backend that actually reported the window. No behavior change for a claude-only or pi-only team.

**Approach.**
- `pairIsClaude` goes; `seamIsClaude` becomes a thin exported `seamAgent(seam) === "claude"` shim (part 2e removes it). Add `export function subscriptionBackendOf(x: FallbackModelConfig | { agent?: string }, accounts: (backend: string) => SubscriptionAccount | null): string | null`: the id (`"backend" in x ? x.backend : seamAgent(x)`) whose account reads `billing === "subscription"`, else null.
- Replace the single `readClaudeAccount`/`windowOut`/`directorWindowOut` with `windowOutFor(backend)` / `directorWindowOutFor(backend)` over the existing `accounts = (backend) => readAccount(root, backend)` lookup, each calling `claudeWindowUsedUp(accounts(backend), now, …, windowReserveFor(liveConfig, backend))` (no reserve for the director reading). `BudgetGatePoll.windowOut` becomes a `Partial<Record<string, { type: string; resetsAt: number; reserve?: true }>>` keyed by backend; `windowResumed` stays the boolean "any backend's move ended this poll" and a new `windowResumedBackends: readonly string[]` names them; `BudgetGateState.prevWindowMoved` becomes a `ReadonlySet<string>`.
- `pairFreeAt` keys its subscription branch on the pair's own backend; the `extraUsage` and overage rules stay claude-only. `available`, `windowTiers`, `movedTiers`, `directorMoved` and `windowMove` (any subscription seam's own window stands, with a fallback pair to move to) use the lookup.
- `chainInfo`'s `windowOut`/`account` params become the `windowOutFor`/`accounts` lookups, so its `"window"`/`"reserve"` reason reads the prior step's own backend; the `"overage"` reason stays claude-only.
- src/gates/gate-polls.ts needs no edit: it reads only `windowTiers`/`windowResumed`, whose meaning is unchanged.

**Acceptance criteria.**
- The budget-gates and budget-chain-info tests pass with only their account/windowOut shape expectations updated; a claude-only team's decision is unchanged.
- A test seeds a `sub` subscription account (a rejected `five_hour` window) and a config whose strong tier names that backend; `pollBudgetGate` moves only that tier's seams to fallback, `windowOut` names `sub`, and claude's account and window are untouched. With claude rejected and `sub` healthy, only claude's seams move.
- `grep -n 'pairIsClaude' src` prints nothing; `windowOut` is a backend-keyed record and `windowResumedBackends` names the resumed backend.
- `npm test` passes.

### Codex backend, part 2d/9: The hold observation and the reserve and warning polls name each subscription backend (planned 2026-10-21 by the plan role; requires part 2b/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/team/team-polls.ts src/gates/gate-polls.ts src/doctor/doctor-holds.ts test/team-polls.test.ts test/notify.test.ts test/event-format-team.test.ts)

**Goal.** The three window emitters that still hardcode claude take the backend id and stamp it: the hold observation, the reserve and warning polls, and the `subscription_window_limited`/`reset` events `pollTeamHold` writes. No behavior change for a claude-only team. This is independent of part 2c/9 (it touches different functions); both edit src/gates/gate-polls.ts in disjoint hunks, so whichever lands second rebases there.

**Approach.**
- `claudeWindowObservation(account, now, reserve)` becomes `windowObservation(backend, account, now, reserve)`, with `role` and `provider` both `backend`. Update the call in `pollTeamHold` (claude only here) and the read in src/doctor/doctor-holds.ts (`windowObservation("claude", account, now)`; part 3/9 later generalizes the doctor row).
- `logWindowEventOnce` gains a `backend` parameter and stamps it on the event; its `backend:type:resetsAt` key already read `ev.backend`, so nothing else changes. `pollClaudeWindowReserve(…, backend)` and `pollClaudeWindowWarning(…, backend)` pass it through and stop hardcoding `backend: "claude"`.
- `pollTeamHold`'s `account`/`reserve` params become `observations: readonly HoldObservation[] = []` (part 2e passes one per subscription backend); it steps the reducer with `[...holdObservations(runners), ...observations]` and stamps `backend: provider` on the `subscription_window_limited`/`reset` events from the observation that opened the hold. `windowTiers` is unchanged.
- src/gates/gate-polls.ts's one call site builds `[windowObservation("claude", claudeAccount, now, reserve)]` and passes `"claude"` to the reserve/warning polls — the claude-only path part 2e generalizes.
- src/orchestrator/orchestrator.ts already seeds `loggedWindowKeys` with backend-qualified keys (part 2b/9); no change.

**Acceptance criteria.**
- The team-polls, notify and event-format tests pass with the new signatures and a `backend` on each window event; a claude-only event renders the same text.
- A test holds a `sub` account (rejected window): `windowObservation("sub", account, now)` returns `role`/`provider` `"sub"`, and `pollTeamHold(…, [observation])` holds provider `sub` and logs `subscription_window_limited { backend: "sub" }` (and `…_reset` when it lifts), leaving claude's hold untouched.
- `pollClaudeWindowReserve`/`pollClaudeWindowWarning` with `"sub"` log `subscription_window_reserved`/`subscription_window_warning { backend: "sub" }` and keep `sub:type:resetsAt` keys that do not collide with claude's.
- `npm test` passes.

### Codex backend, part 2e/9: The poll loop reads each subscription backend in use for its window move, hold, reserve and warning (planned 2026-10-21 by the plan role; requires parts 2c/9 and 2d/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/gates/gate-polls.ts src/gates/budget-gates.ts test/gate-polls.test.ts test/orchestrator-budget.e2e.test.ts)

**Goal.** `pollTeamGates` reads every backend in `backendsInUse(liveConfig)` instead of claude alone, so a second subscription backend gets its own hold, reserve crossings, warning and window-move roles, and the window handback names the backend whose window resumed. No behavior change for a claude-only team. Closes the 2c series.

**Approach.**
- src/gates/gate-polls.ts: import `backendsInUse` from `./startup-gate.js` and `readAccount` from `../agent/subscription-account.js`; drop `readClaudeAccount` and the `seamIsClaude` import. Keep `TeamGateStates.claudeWindowWarned`/`claudeWindowReserved` as one `ReadonlySet<string>` of `backend:type:resetsAt` keys (the shape `logWindowEventOnce` builds and orchestrator's `loggedWindowKeys` seeds) — no per-backend map is needed, because every key already carries its backend.
- Replace the single `readClaudeAccount` block with a loop over `backendsInUse(liveConfig)`: for each `backend`, `const account = readAccount(root, backend, now)`, collect `windowObservation(backend, account, now, windowReserveFor(liveConfig, backend))`, and advance `states.claudeWindowReserved = pollClaudeWindowReserve(root, states.claudeWindowReserved, account, now, reserve, backend)` and the warning poll with `backend`. Pass the collected observations to one `pollTeamHold`.
- `windowMovedRoles`: replace `seamIsClaude(configForRole(liveConfig, r.role))` with `subscriptionBackendOf(configForRole(liveConfig, r.role), accounts) !== null`, where `accounts = (b) => readAccount(root, b, now)`.
- Handback: `const handBack = gateResumed || (windowResumedBackends.length > 0 && !budgetActive);` and, when the resumption is a window, add `backend: subscriptionBackendOf(leftPair, accounts) ?? undefined` to the `budget_handback` event beside `reason: "window"`.
- src/gates/budget-gates.ts: delete the `seamIsClaude` shim part 2c kept for this call site.

**Acceptance criteria.**
- The gate-polls and orchestrator-budget e2e tests pass with only their event `backend` expectations updated; a claude-only team's holds, events and handbacks are unchanged.
- A test registers a fake subscription backend `sub` whose account reports a rejected `five_hour` window: its roles enter `windowMovedRoles`, a hold keyed `sub` is placed, `subscription_window_limited { backend: "sub" }` is logged once, and claude's roles, hold and account are untouched. With claude rejected and `sub` healthy, only claude's roles move.
- A test with a `sub` reserve logs `subscription_window_reserved { backend: "sub" }` once per window, and claude's own reserve memory is unaffected.
- `grep -n 'seamIsClaude\|pairIsClaude' src` and `grep -n 'readClaudeAccount' src/gates/gate-polls.ts` print nothing.
- `npm test` passes.

### Codex backend, part 3/9: Window displays name each subscription backend (planned 2026-10-20 by user; requires part 2e/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/status/status-budget.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-operator.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts src/roles/role-view.ts src/roles/role-render.ts src/report/report-render.ts src/doctor/doctor-holds.ts src/doctor/doctor.ts docs/backends.md and their tests)

**Goal.** Show each subscription backend's windows under that backend's name, so a team with Claude and Codex both on subscriptions shows both. Today every surface prints one `claudeWindow` block labelled "Claude 5h": `claudeWindowBlock` (src/status/status-budget.ts), `claudeWindowBadge` (src/ui/badges.ts), the GUI tile (src/ui/gui/gui-client-operator.ts), the role view's billing line and "Claude window used up" (src/roles/role-render.ts), the report's "claude subscription, API-equivalent" line (src/report/report-render.ts), and doctor's "claude window" row (src/doctor/doctor-holds.ts `checkClaudeWindow`). A claude-only team's output is unchanged, apart from the JSON key added below.

**Approach.**
- src/status/status-budget.ts: `claudeWindowBlock` becomes `windowBlocks(slice, accounts)`, with one block per subscription backend in use, each `{backend, label, …today's fields}`. The `s.agent === "claude"` tests become "the job's backend is this block's".
- `status --json` (src/ui/status-payload.ts, src/status/status-data.ts): a new `subscriptionWindows` list. `claudeWindow` stays as the claude entry for one release, with a doc comment saying so.
- src/ui/badges.ts: the badge text comes from the block's label ("Claude 5h · 64%", "Codex 7d · 31%"). The hold text reads "<label> model jobs wait". With two blocks, the badge shows the one nearest its limit (today's rule, now across backends) and the tile lists all of them. src/ui/status-render.ts and src/ui/gui/gui-client-operator.ts follow.
- Role view (src/roles/role-view.ts, role-render.ts): `claudeInPlay` becomes "the job's backend has an account". The billing line and "window used up" name the backend.
- Report (src/report/report-render.ts): "<label> subscription, API-equivalent: $X", one line per backend with notional spend.
- Doctor: `checkClaudeWindow` becomes `checkSubscriptionWindows`. It produces one row per subscription backend in use, named "<id> window". The "claude window" row name is kept for claude.
- The TUI reserve editor (src/ui/tui/tui-editor-claude-reserve.ts) and the GUI settings label (src/ui/gui/gui-client-settings.ts) say "Claude window reserve (backends.claude.windowReserve)".
- docs/backends.md: the window display paragraph says it is per backend.

**Acceptance criteria.**
- Every existing badge, status, role-view, report and doctor-holds test passes. Their claude-only text is unchanged; a JSON assertion may add `subscriptionWindows`.
- With a fake second subscription backend `sub` labelled "Sub" whose account has `seven_day` at 40%:
  - `status --json` lists two `subscriptionWindows` entries;
  - the TUI badge shows the claude window when it is the nearer one, and "Sub 7d · 40%" when it is;
  - doctor prints a "sub window" row.
- `npm test` passes.

### Codex backend, part 4/9: `codex` becomes a backend id, with `backends.codex`, tier defaults, the effort mapping, reserved flags and traits (planned 2026-10-20 by user; requires part 2e/9 landed; design in plans/codex-backend.md "Config and routing" and "CODEX_HOME and sessions"; touches src/config/config-schema.ts src/config/model-selector.ts src/config/config-validation.ts src/agent/backend-traits.ts src/agent/codex/codex-args.ts (new) src/doctor/doctor-model-checks.ts docs/config.md and their tests)

**Goal.** Make `codex` a valid backend wherever config is read: `backend: "codex"` beside a `model`, a top-level `backend: "codex"`, and `backends.codex` with `bin`, `args`, `configDir` and `windowReserve`. There is no adapter yet (part 7/9). The startup gate's existing rule ("backend X is configured but this build has no adapter for it") refuses a team that routes a job to codex until then.

**Approach.**
- src/config/config-schema.ts:
  - `BACKEND_IDS` gains `"codex"`.
  - `CODEX_BACKEND_KEYS` is `[...BACKEND_KEYS, "configDir", "windowReserve"]`, and validation picks the key list per backend. `configDir` has claude's rule: a leading `~` expands, and the value must be absolute after expansion.
  - The `BackendConfig.configDir` doc comment says it becomes `CODEX_HOME` on codex.
- src/config/model-selector.ts: `BACKEND_DEFAULT_MODELS.codex` is `{ small: "gpt-6-luna", default: "gpt-6.1-sol", strong: "gpt-6-astra" }` (design decision 4). A comment names the catalog descriptions they come from (design finding 14).
- src/agent/codex/codex-args.ts (new) holds only two things in this part:
  - `HARNESS_CODEX_FLAGS`: the flags listed in design §2 "Reserved passthrough flags".
  - `HARNESS_CODEX_CONFIG_KEYS`: `model`, `model_reasoning_effort`, `sandbox_mode`, `project_doc_fallback_filenames`, `web_search`, `agents.enabled`, `check_for_update_on_startup`, `analytics.enabled`, `feedback.enabled`, `history.persistence`. A `-c <key>=…` or `--config <key>=…` passthrough whose key is one of these is refused.
  - Part 5/9 adds the builder beside them.
- `EFFORT_BY_THINKING` lives in codex-args.ts: `off` and `minimal` → `low`; `low`, `medium`, `high`, `xhigh` and `max` pass. `ultra` is not a value it can produce.
- src/agent/backend-traits.ts: a `codex` entry.
  - `streamsToolOutput` false.
  - `usesPiModels` false.
  - `reservedPassthroughFlag` uses `HARNESS_CODEX_FLAGS`, plus the config-key check, with the reason "it is managed by tumwater".
  - `modelLabel` gives the bare model, or "codex default".
- src/config/config-validation.ts: the `-c` key check above, with the message naming the arg and the key.
- src/doctor/doctor-model-checks.ts: codex jobs skip the models.json lookup, as claude and opencode do.
- docs/config.md:
  - `backend` accepts `"codex"`, and `backends` is keyed by `pi`, `claude`, `opencode` or `codex`.
  - `backends.codex.configDir` is the Codex home, which needs one `CODEX_HOME=<dir> codex login`.
  - `backends.codex.windowReserve` is the reserve.

**Acceptance criteria.**
- `routeModel`:
  - `{ backend: "codex", model: "gpt-6.1-sol" }` routes to `{agent: "codex", model: "gpt-6.1-sol"}`.
  - A top-level `backend: "codex"` with no `model` resolves `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna` for the strong, default and small tiers.
  - `{ backend: "codex", model: "gpt-6-luna", thinking: "high" }` keeps thinking `high`.
- Validation:
  - `backends.codex: { configDir: "~/.codex-tumwater", windowReserve: { "seven_day": 0.7 } }` loads.
  - `configDir: "relative/dir"` is refused.
  - `backends.codex.args: ["--sandbox", "read-only"]` is refused, naming `--sandbox`.
  - `backends.codex.args: ["-c", "model=x"]` and `["--config=model_reasoning_effort=high"]` are refused, naming the key.
  - `backends.codex.args: ["-c", "model_verbosity=low"]` loads.
  - `backends.opencode.configDir` is still refused.
- test/backend-traits.test.ts: codex streams no tool output, uses no pi models, and labels `gpt-6.1-sol` as `gpt-6.1-sol` and an undefined model as `codex default`.
- Startup gate: with `backend: "codex"` and no codex adapter registered, the problem names codex. A pi-only config is unaffected.
- `npm test` passes.

### Codex backend, part 5/9: The Codex invocation and environment: argv for fresh and resumed runs, isolation flags, and the scrubbed env (planned 2026-10-20 by user; requires part 4/9 landed; design in plans/codex-backend.md "The invocation" and "Findings, verified live" 6–10, 13 and 20; touches src/agent/codex/codex-args.ts src/agent/codex/codex-env.ts (new) and their tests)

**Goal.** Build, as pure functions, the argv, stdin and environment of one Codex run, fresh or resumed. A Codex run then gets only the flags design §3 lists, the prompt on stdin, and an environment with no host Codex or Claude Code session state and no OpenAI API key.

**Approach.**
- src/agent/codex/codex-args.ts gains `codexArgs({model, effort?, resumeId?, args?, prompt})`. It returns `{args, stdin}`.
  - A fresh run: `exec --json --dangerously-bypass-approvals-and-sandbox --ignore-user-config --ignore-rules`, then the `--disable` list (`plugins`, `apps`, `goals`, `image_generation`, `browser_use`, `computer_use`, `tool_suggest`, `skill_search`), then `-c agents.enabled=false`, `-c web_search="disabled"`, `-c check_for_update_on_startup=false`, `-c analytics.enabled=false`, `-c feedback.enabled=false`, `-c history.persistence="none"`, `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`, `-m <model>`, `-c model_reasoning_effort=<effort>` when one is given, the passthrough args (through `appendPassthroughArgs`, src/agent/agent-args.ts), and `-`.
  - A resume: `exec resume <resumeId>` with the same flags, `-m` included (design finding 6). It has no `--sandbox` and no positional prompt besides `-`.
  - It throws on an unknown effort, as `claudeArgs` does.
  - It also exports `codexEffort(thinking, levels)`, which maps through `EFFORT_BY_THINKING` and returns undefined when the model's catalog `levels` (passed in) lack the result. Part 8/9 supplies the levels; until then the caller passes undefined, which means no clamp.
- src/agent/codex/codex-env.ts (new): `codexEnv(base, {home?})`.
  - It deletes every `CODEX_*`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDECODE` and every `CLAUDE_CODE_*`.
  - It sets `CODEX_HOME` to `home` when one is given.
  - It keeps everything else, including `TUMWATER_RUN`, `TUMWATER_NOTES_PATH` and the PATH that carries the notes shim.
- Doc comments cite the design findings behind each flag. Every `-c` key in the argv was checked with `--strict-config` on Codex 0.163.0 (design finding 20).

**Acceptance criteria.**
- test/codex-args.test.ts (new):
  - The fresh argv for `{model: "gpt-6.1-sol", effort: "high"}` equals the full expected list, and stdin is the prompt.
  - The resume argv starts `exec resume <id>` and still carries `-m gpt-6.1-sol`.
  - A passthrough `--sandbox` throws, naming it.
  - `codexEffort("minimal", ["low","medium"])` is `low`. `codexEffort("max", ["low","medium","high"])` is undefined. `codexEffort("high", undefined)` is `high`.
- test/codex-env.test.ts (new):
  - From a base holding `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `TUMWATER_RUN` and `HF_TOKEN`, the result keeps only `TUMWATER_RUN` and `HF_TOKEN` of those.
  - `CODEX_HOME` is set when `home` is given and absent otherwise.
- `npm test` passes.

### Codex backend, part 7/9: The codex adapter runs model jobs, with stream-minted sessions, the rollout read after each run, a PATH fake and its prompt dialect (planned 2026-10-20 by user; requires parts 5/9 and 6/9 landed; design in plans/codex-backend.md "CODEX_HOME and sessions", "The stream translator and the rollout read that completes it" and "The prompt dialect"; touches src/agent/codex/codex-backend.ts (new) src/agent/run-agent.ts src/agent/session-ledger.ts src/prompt/dialect.ts src/paths.ts test/fakes/fake-codex.ts (new) test/test-runner.ts and their tests)

**Goal.** Codex model jobs run end to end. Fresh runs record their stream-minted session id; continues resume it; the rollout supplies this run's usage and windows; the reviewer's suite-rerun detection sees Codex's commands; and the prompt carries Codex's dialect.

**Approach.**
- src/agent/codex/codex-backend.ts (new): `codexBackend`, with `id: "codex"`, `label: "Codex"`, `defaultBin: "codex"` and `binEnv: "TUMWATER_CODEX_BIN"`. Its hooks:
  - `resolveBin` goes through `resolveBinForBackend`.
  - `invocation`:
    - For a continue, it takes the newest ledger record of this kind that is `agent: "codex"`, has this cwd and a UUID id, and whose rollout `findRollout` finds under the run's home. Otherwise the run is fresh.
    - It builds the args with `codexArgs` and the env with `codexEnv(withNotesPath(backendBaseEnv(…)), {home})`. The home is `backends.codex.configDir` expanded, else none.
    - It returns `sessionId` only for a resume.
  - `translator` returns `codexTranslator()`.
  - `resumable` makes the same check as the continue.
  - `afterRun` reads `findRollout` plus `rolloutLines` for the run's thread id: the resumed id, or else `translator.sessionId()`. On [] it flags `codex_usage_partial`, and a fresh run then emits `run_usage` from `turnCompletedUsage()`. A reported model switch warns `codex_model_switched {requested, ran}` once.
  - `classifyExit` handles the stderr half of a CLI that died before `turn.failed`. A killed run returns {} (design finding 12).
  - `imageInput` returns true for now. Part 8/9 reads the catalog.
- src/agent/run-agent.ts:
  - It registers `codexBackend`.
  - After each translated batch, when `translator.sessionId?.()` first returns an id the pre-spawn ledger record lacked, it appends one more `recordSession` line with that id (same kind, name, cwd, model, `at` now).
- src/agent/session-ledger.ts: `resumableSession` already takes the newest record of a kind. Add a test that the stream-minted record wins over its own pre-spawn record.
- src/prompt/dialect.ts: `CODEX_DIALECT` per design §6 (readRange, the `…N tokens truncated…` oversized-output wording, and the rule to keep polling `write_stdin` until a command reports its exit code), and an entry in `DIALECTS`.
- test/fakes/fake-codex.ts (new), the twin of fake-opencode.ts:
  - a PATH shim named `codex` that replays a canned `--json` stream;
  - it writes a matching rollout under `$CODEX_HOME/sessions/…`;
  - it records argv and stdin per run;
  - on `exec resume <id>` it appends to that rollout.
- test/test-runner.ts strips `TUMWATER_CODEX_BIN` and `CODEX_*` from the suite environment.

**Acceptance criteria.**
- test/codex-run.test.ts (new), on fake-codex:
  - A fresh author run exits success with the fake's final text and usage.
  - The run's ledger holds a pre-spawn record and a second record whose id is the fake's thread id.
  - A follow-up with `continueSession` runs `exec resume <that id>` with `-m`.
  - With the rollout deleted, the follow-up runs fresh, and the resume path logs its usual handoff.
  - A fake rollout reporting `seven_day` at 72% puts a `seven_day` reading with utilization 0.72 on the result, and `billing: "subscription"`.
  - A reviewer run whose fake stream runs `npm test` is seen as a suite rerun.
  - The harness's SIGTERM mid-command ends with no marked process left. The fake leaves a marked orphan, as the real CLI does, and the marker sweep reaps it.
- Prompt: a codex run's prompt carries `CODEX_DIALECT`'s rules (test/prompt-rules.test.ts, beside the OpenCode rule cases).
- `npm test` passes.

### Codex backend, part 8/9: Codex billing, free-ness and windows: the account fed from runs, the API-key refusal, the context window, effort levels and image input from the catalog (planned 2026-10-20 by user; requires parts 3/9 and 7/9 landed; design in plans/codex-backend.md "Spend, free-ness, window, images"; touches src/pi/pi-models.ts src/agent/codex/codex-backend.ts src/agent/codex/codex-catalog.ts (new) src/agent/codex/codex-account.ts (new) src/gates/startup-gate.ts src/config/config-live.ts and their tests)

**Goal.** A Codex job on a ChatGPT subscription counts as free to the budget gate while its windows serve, moves down its chain when a window is used up or past its reserve, and shows its windows on the badge. That works through parts 1/9–3/9's per-backend machinery with no Codex special case outside src/agent/codex/. An API-key Codex login is refused, because Codex reports no cost.

**Approach.**
- src/agent/codex/codex-catalog.ts (new): `readCodexCatalog(home)` parses `models_cache.json` under the run's `CODEX_HOME` (or `~/.codex`). For each model it returns `{levels, defaultLevel, contextWindow: context_window × effective_context_window_percent / 100, images: input_modalities includes "image"}`. A missing or malformed file reads as an empty catalog.
- The adapter uses the catalog:
  - `codexEffort(thinking, catalog[model]?.levels)` drops a level the model does not list;
  - `imageInput` reads `images`, and a model missing from the catalog answers false.
- src/pi/pi-models.ts:
  - `seamFree`'s `codex` arm is `accounts("codex")?.billing === "subscription"`.
  - `seamContextWindow`'s `codex` arm reads the catalog's `contextWindow`.
- src/agent/codex/codex-account.ts (new): `seedCodexAccount(root, config)`, the counterpart of `seedClaudeAccount`.
  - It runs `codex login status` with the run env, bounded at 10 s.
  - "Logged in using ChatGPT" writes `{billing: "subscription"}`. Plan and windows arrive with the first run's rollout.
  - "an API key" writes `{billing: "api"}`.
  - Anything else writes nothing.
- src/gates/startup-gate.ts and src/config/config-live.ts seed it when codex is in use, as they seed claude. A codex job on `billing: "api"` is a startup problem: "Codex is logged in with an API key; tumwater runs Codex on a ChatGPT subscription only — run `CODEX_HOME=<home> codex login --device-auth`".
- A run's rollout reading reaches the codex account through part 1/9's `observeAccount`. Holds, moves, the reserve and the display then follow from parts 2/9 and 3/9.

**Acceptance criteria.**
- With a seeded subscription codex account:
  - a Codex fallback step is accepted as a budget fallback for a priced primary;
  - at the cap, a Codex job keeps running;
  - an all-Codex team's badge shows the Codex windows instead of the spend.
- A rejected `five_hour` reading in the codex account moves Codex default-tier jobs to their next step, places a `codex` hold only for jobs with no step, and logs `subscription_window_limited {backend: "codex"}` once. Claude jobs are untouched.
- `backends.codex.windowReserve: { "seven_day": 0.7 }` with a `seven_day` reading at 0.71 moves Codex jobs and logs `subscription_window_reserved`.
- `seamContextWindow` for `gpt-6.1-sol` with the fixture catalog is 475000. `imageInput("gpt-6-luna")` is true. An unknown model is null and false.
- A fake `codex login status` printing "Logged in using an API key" makes the startup gate refuse a codex job with the message above.
- `npm test` passes.

### Codex backend, part 9/9: Doctor checks the Codex install, login, home and models; session retention; docs; and an opt-in `smoke:codex` live check (planned 2026-10-20 by user; requires part 8/9 landed; design in plans/codex-backend.md "CODEX_HOME and sessions", "Spend, free-ness, window, images", "Risks" and "Hand steps"; touches src/doctor/doctor-model-checks.ts src/doctor/doctor-checks.ts src/doctor/doctor-check-names.ts src/doctor/doctor.ts src/agent/codex/codex-backend.ts src/agent/session-ledger.ts src/orchestrator/retention.ts docs/backends.md docs/config.md README.md scripts/smoke-codex.mjs (new) package.json and their tests)

**Goal.** An operator can set Codex up from doctor's output alone, the team's Codex sessions are pruned like every other session, and one live command proves the production invocation still works after a Codex upgrade.

**Approach.**
- Doctor gets a `codex` check group, shown when any job routes to codex:
  - the binary resolves, and `codex --version` is at least `CODEX_MIN_VERSION` (0.163.0, the probed version);
  - `codex login status` under the run's home: ChatGPT passes; an API key fails with the startup-gate message; not logged in fails, naming `CODEX_HOME=<home> codex login --device-auth`;
  - the home: `backends.codex.configDir` unset warns that team runs share the operator's `~/.codex` (trust entries, sessions in the resume picker, skills, a global AGENTS.md);
  - each Codex model is in the catalog, with its window and any thinking level it lacks;
  - the account: `credits.has_credits` true warns that a run crossing a limit may spend credits tumwater cannot count (design §7);
  - leaks: the home's `AGENTS.md`, `skills/` beyond `.system`, `hooks`, and the target repo's `.codex/config.toml` MCP servers, each named;
  - the size of the home's `sessions/`.
- Retention: the existing pruning (src/orchestrator/retention.ts, src/agent/session-ledger.ts) deletes the ledger's expired Codex sessions with `codex delete --force <id>` under the run's env (bounded at 10 s). Without `--force` Codex refuses to delete without a terminal (design finding 21). When the delete fails, pruning removes the rollout file.
- docs/backends.md gets a "Codex (`backend: "codex"`)" section: what it runs, the home and its one login, subscription-only billing, the windows and reserve, what is disabled and why, sessions, and the sandbox choice. docs/config.md covers the `backends.codex` keys. README.md lists Codex among the backends.
- scripts/smoke-codex.mjs (new; `npm run smoke:codex`, not in `npm test`) runs the exact production invocation in a throwaway git repo:
  - a fresh run that edits a file and runs a command;
  - a resume that recalls it;
  - a SIGTERM mid-command, after which no marked process is left;
  - an end-of-run note through `tumwater-notes`;
  - an assertion that the first request is under 10,000 input tokens (8,059 on 0.163.0), which catches an isolation regression;
  - a 90-second command that the model must poll to completion, with no `codex_command_abandoned`;
  - an assertion that the rollout gave a `five_hour` and a `seven_day` reading.

**Acceptance criteria.**
- Doctor tests on fake-codex:
  - each row's pass, warn and fail cases above;
  - a version below 0.163.0 fails;
  - a pi-only team shows no codex group.
- Retention test: an expired codex ledger record gets one `codex delete --force <id>` on the fake, and its rollout is gone. A fresh one is kept.
- `npm run smoke:codex --help` (or a dry-run flag) prints its steps without spawning codex.
- docs/backends.md's Codex section names `backends.codex.configDir`, `codex login --device-auth` and `windowReserve`.
- `npm test` passes.

### `tumwater report -f/--follow` repaints the usage report (or, with `--failures`, the failure digest) every couple of seconds until Ctrl+C or its parent exits, the live twin of the dashboard Usage card and the TUI Usage and Failures panes (planned 2026-10-21 by the plan role; `tumwater queue -f/--follow` and `tumwater backlog -f/--follow` have landed and `followView` is still local to src/cli/cli-query-commands.ts, so this lifts that loop into a new leaf module; the in-flight `tumwater diff -f/--follow` entry shares src/cli/follow-view.ts and src/cli/cli-query-commands.ts, so whichever lands first, the other rebases the module and cli-query-commands.ts; the in-flight merge-on-gate and Codex parts edit src/build, src/config, src/doctor, src/events, src/gates, src/team, src/orchestrator and src/agent, and Codex part 3/9 edits src/report/report-render.ts — none of them touches src/report/report.ts, src/cli/cli-query-commands.ts, src/cli.ts, src/cli/help.ts, docs/cli.md or test/report-follow.test.ts. Touches src/cli/follow-view.ts (new) src/cli/cli-query-commands.ts src/report/report.ts src/cli.ts src/cli/help.ts docs/cli.md test/report-follow.test.ts (new))

**Goal.** `tumwater status`, `tumwater queue`, `tumwater backlog`, `tumwater logs` and `tumwater history` have `-f/--follow`; `tumwater report` is the read-only snapshot without a live form (`tumwater diff -f/--follow` is planned separately). An operator watching spend, run counts, or the failure digest wants the same table to update as runs land, the way the dashboard's Usage card and the TUI's Usage and Failures panes already do. Add `-f/--follow` to the two day forms (`report` and `report --failures`): repaint the same text every couple of seconds until Ctrl+C or the parent process exits (the rule `status -f`, `queue -f`, `logs -f` and `history -f` use), composing with `--days` and `--role`. As with `history -f`, `--since` (and so `--until`) is refused — follow means the window that ends now, not a bounded past one — and `--json` is refused because it prints one document.

**Approach.** The report collectors are synchronous (`collectReport`, `collectFailureReport`), so the existing `followView(frameText: () => string, seams)` shape fits with no async rework.

1. Lift the repaint loop into a leaf module. `src/cli/cli-query-commands.ts` already holds it as the local `followView` (`followStatus` is only the thin `status -f` wrapper around it; the `queue -f`/`backlog -f` entries landed). Create `src/cli/follow-view.ts` and move that function there unchanged — header comment, `stripTerminalControls(frameText())` and all — exporting:
   - `export const FOLLOW_VIEW_INTERVAL_MS = 2000;`
   - `export interface FollowViewSeams { ppid?: () => number; intervalMs?: number; tty?: boolean; }`
   - `export async function followView(frameText: () => string, seams: FollowViewSeams): Promise<void>`, exactly the body at cli-query-commands.ts's `followView` today: `const tty = seams.tty ?? process.stdout.isTTY;`, `const interval = seams.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;`, the `frame()` that writes `stripTerminalControls(frameText())` as `tty ? "\x1b[H\x1b[2J" + text + "\n" : text + "\n\n"`, one immediate `frame()`, then the `setInterval` plus `startParentDeathWatch(() => { clearInterval(timer); resolve(); }, { …seams })` promise. It imports `startParentDeathWatch` from `../process/supervisor.js` and `stripTerminalControls` from `../text/text.js` (both leaf modules; no cycle). Its header comment says it is the repaint loop every `-f` view shares. If the in-flight `tumwater diff -f/--follow` entry landed first it has already widened `frameText` to `() => string | Promise<string>` and made `frame` async; move that widened version instead, so the diff entry need not rebase.
   - In `src/cli/cli-query-commands.ts`, import `{ followView, type FollowViewSeams }` from `./follow-view.js`, drop the local interval constant, seams interface and `followView`, and drop the now-unused `startParentDeathWatch`/`stripTerminalControls` imports (each is used only inside `followView` today) while keeping `errorMessage` in the `../text/text.js` import. Keep `followStatus` as the call `followView(() => renderStatus(root, scope ? scopeSnapshotToRoles(snapshot(root), scope) : snapshot(root), tty ? process.stdout.columns : undefined, scope !== null), seams)`. `status -f`, `queue -f` and `backlog -f` emit the same frames.
2. src/report/report.ts: `cmdReport` gains the flag.
   - Signature becomes `export async function cmdReport(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void>`; import `{ followView, type FollowViewSeams }` from `../cli/follow-view.js`.
   - After the role parse: `const follow = args.includes("-f") || args.includes("--follow");` and `if (follow && args.includes("--json")) fail("report --json prints one document; -f/--follow repaints a live view — drop one of them");`.
   - In the `ms !== null` branch, before its `--days` rival check: `if (follow) failRivalShapes("report --since", "-f/--follow", 'follow means "from now on"; --since shows a bounded past window');` — the exact `history -f` rule; `--until` can only ride `--since`, so it is covered.
   - After `days` is parsed and before the `--json` branches: `if (follow) { await followView(() => args.includes("--failures") ? renderFailureMarkdown(collectFailureReport(root, days, role ?? undefined)) : renderReportMarkdown(collectReport(root, days, role ?? undefined)), seams); return; }`. The frame string is exactly what the snapshot branch would `say`, so the snapshot forms keep today's bytes.
3. src/cli.ts, the `report` case's `rejectUnknownArgs` list: add `{ names: ["-f", "--follow"] }` (value-less; the case still does no ready-repo gate).
4. src/cli/help.ts: add `[-f/--follow]` to the first stanza's synopsis (`tumwater report [--days N] [--role <id>[,<id>...]] [-f/--follow] [--json]`) and, after that stanza's description, add `-f/--follow repaints the report, or with --failures the failure digest, every couple of seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does not outlive its parent; it refuses --json and --since;`, wrapped to the stanza's column. Leave the three `--since`-shaped synopses alone.
5. docs/cli.md, the Audit row: in the `tumwater report` clause, immediately before the `tumwater report --json` clause, insert ``-f/--follow` on the day forms (`tumwater report`, `tumwater report --failures`) repaints that report every couple of seconds until Ctrl+C or its parent process exits (a backgrounded follow does not outlive its parent, like `status -f`), and refuses `--json` and `--since`;`. Leave the other report clauses alone.

**Files touched.** src/cli/follow-view.ts (new), src/cli/cli-query-commands.ts, src/report/report.ts, src/cli.ts, src/cli/help.ts, docs/cli.md, test/report-follow.test.ts (new).

**Acceptance criteria.**
- test/report-follow.test.ts (new), driving `cmdReport` in-process with the follow seams the way test/status-follow.test.ts drives `cmdStatus` and test/history-follow.test.ts drives `cmdHistory` (a `makeRepo()` repo — report has no ready-repo gate and its collectors degrade to zeros — `captureStdout`/`expectFailAsync` from ./helpers/exit-capture.js and `sleep` from ./helpers/wait.js):
  - "report -f repaints until its parent exits, then prints nothing": run `["-f"]` with `{ ppid: () => parent.value, intervalMs: 5, tty: false }`; poll the capture until it holds at least two `# tumwater usage report` headings; flip the parent to 1; the follow resolves and a fresh capture stays empty over a settle.
  - "report -f --failures repaints the failure digest": run `["--failures", "-f"]`; the frames match `/# tumwater failure digest/` at least twice.
  - "report -f --json is refused": `expectFailAsync(() => cmdReport(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }))` rejects matching `/report --json prints one document/`, and the capture holds no report heading and no clear-screen.
  - "report -f --since is refused": the same with `["-f", "--since", "1d"]`, rejecting matching `/report --since/`.
  - "report -f clears the screen only on a TTY": with `tty: true` the output starts with `"\x1b[H\x1b[2J"`; with `tty: false` it never contains that sequence.
- test/report.test.ts and the CLI report tests pass unchanged: the `--days`, `--failures`, `--since`/`--until`, `--role` and `--json` snapshot paths are untouched.
- test/status-follow.test.ts, test/cli-queue-follow.test.ts and test/cli-backlog-follow.test.ts pass unchanged: the moved `followView` emits the same frames and `status -f` still refuses `--json`.
- `npm run test:gate` is green.

### `tumwater diff [-f/--follow]` repaints the pending-change view (the team roster, a role's change, or the `--overlaps` list) every couple of seconds until Ctrl+C or its parent exits, the last snapshot command's live twin (planned 2026-10-21 by the plan role; shares `src/cli/cli-query-commands.ts`, `src/cli/help.ts` and `docs/cli.md` with the in-flight `tumwater report -f/--follow` entry — when that entry has landed this widens `followView` in `src/cli/follow-view.ts`, otherwise it widens the local helper and report rebases; the in-flight fast-merge, gateCommand and Codex entries edit src/merge, src/baseline, src/build, src/config, src/doctor, src/events, src/gates, src/team, src/orchestrator and src/agent, none of them these files. Touches src/cli/cli-query-commands.ts src/cli/help.ts docs/cli.md test/cli-diff-follow.test.ts (new) and src/cli/follow-view.ts only when it exists)

**Goal.** `status`, `queue`, `backlog`, `report`, `logs` and `history` all have `-f/--follow`; `tumwater diff` is the last read-only query without a live form. An operator watching what roles hold pending — above all which files two roles both touch (`--overlaps`) — wants the same view to update as runs commit and land. Add `-f/--follow` to every `diff` shape: the team roster (no `--role`), one or more roles' change views (`--role`, composing with `--stat` and `--path`), and the `--overlaps` list (composing with `--role` and `--path`). Each frame repaints exactly the text the snapshot prints, every couple of seconds, until Ctrl+C or the parent process exits (the `status -f` rule). `--json` is refused — it prints one document — with the wording the sibling follow commands use.

**Approach.**

1. `followView` learns async frames. Widen its `frameText` seam from `() => string` to `() => string | Promise<string>`, make `frame` asynchronous (`const frame = async (): Promise<void> => { const text = await frameText(); process.stdout.write(tty ? "\x1b[H\x1b[2J" + text + "\n" : text + "\n\n"); }`), `await frame()` for the first paint, and drive the interval with `setInterval(() => { void frame(); }, interval)`. Guard against a slow read stacking frames with `let painting = false; if (painting) return; painting = true; try { … } finally { painting = false; }`. The sync callers (`cmdStatus`, `cmdQueue`, `cmdBacklog`, `cmdReport`) and their emitted bytes are unchanged, and the `startParentDeathWatch` end is untouched. Edit the helper where it lives: `src/cli/cli-query-commands.ts` today, or `src/cli/follow-view.ts` if the in-flight `tumwater report -f/--follow` entry has landed.
2. `cmdDiff` gains the flag and the seams. Signature becomes `export async function cmdDiff(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void>` (cli.ts's call site passes no seams). Add `FOLLOW_FLAG` to its `rejectUnknownArgs` list, then after `requireReadyRepo`: `const follow = args.includes("-f") || args.includes("--follow");` and `if (follow && args.includes("--json")) fail("diff --json prints one document; -f/--follow repaints a live view — drop one of them");`.
3. Factor each shape's read into a thunk returning the view and its zero-arg `render`, used by both the follow frame and the snapshot, so a frame's text is exactly the snapshot's:
   - `--overlaps` (after the existing `--overlaps --stat` refusal, with `scope`/`path` already parsed): `const readOverlaps = async () => { let view = await collectChangeOverlaps(root); if (scope === null && path === undefined) return { view, render: () => renderChangeOverlaps(view) }; if (scope !== null) view = scopeChangeOverlaps(view, scope); if (path !== undefined) view = scopeChangeOverlapsToPath(view, path); return { view, render: () => renderChangeOverlaps(view, scope ?? undefined, path) }; };` then `if (follow) { await followView(async () => (await readOverlaps()).render(), seams); return; }` and the snapshot as `const { view, render } = await readOverlaps(); sayJsonOrRender(args, view, () => render());`.
   - The non-overlaps path, after `roles`/`path` are resolved: `readChange` returns the roster read (`collectTeamChanges` + `renderTeamChange`) with the existing `--stat needs --role` and `--path needs --role` refusals kept ahead of the read, the single-role read (`collectRoleChange` + `renderRoleChange`), or the multi-role read (`collectRoleChanges` + `renderRoleChanges`). The same `if (follow) { await followView(async () => (await readChange()).render(), seams); return; } ; const { view, render } = await readChange(); sayJsonOrRender(args, view, () => render());` shape.
   The `--json` payloads and every snapshot's output stay byte-identical.
4. `src/cli/help.ts` — add `[-f/--follow]` to the three `tumwater diff` stanza synopses (the roster stanza, the `--role` stanza, and the `--overlaps` stanza) and, after the roster stanza's description, one wrapped line: `-f/--follow repaints the same view every couple of seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does not outlive its parent; it refuses --json;`.
5. `docs/cli.md` — in the `See a role's pending change` row, add the same `-f/--follow` sentence (the `status -f` wording), naming that it composes with `--role`, `--stat`, `--path` and `--overlaps` and refuses `--json`.

**Files touched.** src/cli/cli-query-commands.ts (cmdDiff, and `followView` while it is still local), src/cli/follow-view.ts (only when the report entry has landed), src/cli/help.ts, docs/cli.md, test/cli-diff-follow.test.ts (new).

**Acceptance criteria.**
- test/cli-diff-follow.test.ts (new), driving `cmdDiff` in-process with the follow seams exactly as test/cli-queue-follow.test.ts drives `cmdQueue` (`makeRepo`, `initProject`, `ensureWorktree` + `commitIn` from ./fixtures/repo-fixtures.js to seed a pending change; `captureStdout`/`expectFailAsync` from ./helpers/exit-capture.js; `sleep` from ./helpers/wait.js; a `withDiffFollow` wrapper that always flips the parent to 1 and restores stdout in `finally`):
  - "diff -f repaints the roster until its parent exits, then prints nothing": a seeded feature worktree holding one commit; run `["-f"]` with `{ ppid: () => parent, intervalMs: 5, tty: false }`; poll the capture (bounded loop, generous) until it holds at least two `feature: ` roster lines; flip the parent; the follow resolves and a fresh capture stays empty over a settle.
  - "diff -f --role repaints that role's change view": `["--role", "feature", "-f"]`; the capture holds `/1 commit ahead of main/` at least twice; it then stops.
  - "diff -f --overlaps repaints the shared-file list": two roles whose worktrees both touch `widget.md`; `["--overlaps", "-f"]`; the capture holds `/widget\.md: feature, feature-2/` at least twice.
  - "diff -f --json is refused": `expectFailAsync(() => cmdDiff(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }))` rejects matching `/diff --json prints one document/`, and the capture holds no frame and no clear-screen.
  - "diff -f clears the screen only on a TTY": with `tty: true` a frame starts with `"\x1b[H\x1b[2J"`; with `tty: false` the capture never contains it.
- test/cli-diff.test.ts passes unchanged: the roster, `--role`, `--stat`, `--path`, `--overlaps` and `--json` snapshot paths are untouched.
- test/status-follow.test.ts, test/cli-queue-follow.test.ts and test/cli-backlog-follow.test.ts pass unchanged: the widened `followView` still emits the same frames for a sync frame text.
- `npm run test:gate` is green.

## Done
