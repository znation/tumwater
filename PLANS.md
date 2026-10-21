# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Fast merge guardrails, part 2/3: `tumwater doctor` and the selfcheck digest warn on a revert that looks false and on more than 5 reverts a day (planned 2026-10-21 by user; requires part 1/3 landed; design in plans/fast-merge.md "Guardrails" G2; touches src/baseline/main-guardrails.ts src/baseline/main-revert.ts src/merge/merge-core.ts src/merge/merge-to-main.ts src/merge/merge-stack.ts src/events/events.ts src/doctor/doctor-holds.ts docs/how-it-works.md and their tests)

**Goal.** Make a misfiring revert visible. Today a `main_revert` that blamed a flaky test, or that removed a change which later merged again unchanged with main green, leaves no trace beyond the event, and a burst of reverts reads the same as one.

**Approach.**
- Events: `main_revert` gains `patchId`, the culprit's (`patchId(wt, C^, C)` in `runMainRevert`, src/baseline/main-revert.ts). `merged` gains `patchId`, the merged commit's, on the single path (src/merge/merge-to-main.ts; mergeApprovedChangeIn in src/merge/merge-core.ts already computes `pinPatch` and may pass it down when no conflict was resolved) and on the batch path (src/merge/merge-stack.ts, `patchId(root, sha^, sha)` per stacked entry). A failed patch-id omits the field. src/events/events.ts's comments for both types name it.
- src/baseline/main-guardrails.ts: `revertWarnings(events, quarantine, now)` with G2's two tests per `main_revert` in the last 24 h, and the rate test (more than 5). `guardrailWarnings` includes it, so the digest section from part 1/3 carries it.
- src/doctor/doctor-holds.ts `checkMainRed` adds the revert phrases to its row.
- docs/how-it-works.md: the revert bullet says what doctor warns about.

**Acceptance criteria.**
- test/main-revert.test.ts: a successful revert logs `main_revert` with the culprit's patch-id.
- test/merge-to-main.test.ts and test/merge-stack.test.ts: `merged` carries the merged commit's patch-id on both paths.
- test/main-guardrails.test.ts:
  - a revert naming test T, with T in quarantine with `lastSeen` after the revert, warns that the failure did not reproduce;
  - a later `merged` with the revert's `patchId`, then a passed `main_check` with `durationMs` > 0, warns that the change merged again unchanged and main stayed green;
  - the same with that `main_check` failed, or with a different `patchId`, or with no `patchId`, does not warn;
  - 6 reverts in 24 h warn naming 6; 5 do not.
- test/doctor-holds.test.ts: the "main's check" row carries a revert phrase.
- `npm test` passes.

### Merge on `check.gateCommand` when `check.mergeCommand` is unset, and review clean, dedupe and coverage after merging by default (planned 2026-10-21 by user; design in plans/fast-merge.md "Defaults"; touches src/build/build-check-detect.ts src/config/config.ts src/config/config-validation.ts src/doctor/doctor-checks.ts docs/config.md docs/how-it-works.md DEVELOPMENT.md and their tests)

**Goal.** Fast merge parts 6/14 and 14/14 shipped `check.mergeCommand` and `review.afterMerge` as opt-in keys. tumwater.json is gitignored, so no team commit could set them. On 2026-10-21 the merge lock still ran the full `npm test` on every code merge (142–330 s each, the latest at 02:24), and every role was still reviewed before merging. Make both on by default (decided 2026-10-21 by you): a project that declared `check.gateCommand` merges on it, and clean, dedupe and coverage are reviewed after merging, unless the config opts out. This repo's tumwater.json sets `gateCommand`, so both switches take effect here at the next redeploy.

**Approach.**
- `mergeCommandOf` (src/build/build-check-detect.ts ~148) is the one accessor every merge-path reader uses. Change only it:
  - key absent → `gateCommandOf(config)`;
  - a non-blank string → that string;
  - a blank string (`""`) → undefined: the explicit opt-out, which keeps the full check in the lock even when a gate command is set.

  Update its doc comment, and the comment at src/config/config-validation.ts (~361), to say so.
- `review.afterMerge`: add `afterMerge: ["clean", "dedupe", "coverage"]` to `defaultConfig().review` (src/config/config.ts ~142). `overlayDefaults` already merges `review` key by key, so a config that omits the key inherits it, and `"afterMerge": []` opts out. The readers (src/review/review.ts ~350, src/review/post-merge-review.ts ~36) need no change.
- Never write a default into tumwater.json. A config write through the existing writers (the TUI and dashboard editors, the director's config requests) leaves an absent `mergeCommand` or `afterMerge` absent. Check this against the writer INV-B3 binds (docs/invariants.md), and add a test if none covers it.
- `tumwater doctor`'s `check` row (`checkBuildCheck`, src/doctor/doctor-checks.ts ~1010) says what the merge lock runs and where the full check runs. Examples: `npm test · merge lock runs npm run test:gate, full check after merging`, or `… full check in the merge lock`. When the after-merge list is non-empty, it also names those roles. On 2026-10-21 you could not tell from any surface whether these switches were on.
- Docs:
  - docs/config.md: the `check` row says `mergeCommand` defaults to `gateCommand` and that `""` keeps the full check in the lock. The `review` row's default gains `"afterMerge":["clean","dedupe","coverage"]`, and the row says `[]` opts out.
  - docs/how-it-works.md (~73, ~231) and DEVELOPMENT.md (~40-42): the same defaults.
- Tests that assumed the old defaults change only their fixture config, not their assertions:
  - Merge tests that set `gateCommand` and expect the full check in the lock set `mergeCommand: ""`.
  - Tests that expect clean, dedupe or coverage to be reviewed before merging set `afterMerge: []`.

**Files touched.**
- Source: src/build/build-check-detect.ts, src/config/config.ts, src/config/config-validation.ts (comment only), src/doctor/doctor-checks.ts.
- Docs: docs/config.md, docs/how-it-works.md, DEVELOPMENT.md.
- Tests: test/build-check-detect.test.ts, test/config-validation-check.test.ts, test/config-write.test.ts, test/post-merge-review.test.ts, the doctor tests for `checkBuildCheck`, and the fixture configs of merge and review tests that relied on the old defaults.

**Acceptance criteria.**
- With `check.gateCommand` set and no `mergeCommand`, `mergeCommandOf` returns the gate command. A fake merge runs it in the lock, not the full check, and the main watch runs the full check afterwards.
- With `"mergeCommand": ""` and a gate command, the in-lock check is the full check, as before Fast merge part 6/14.
- With neither key set, the full check runs in the lock, as today.
- With no `review.afterMerge` in the file, a clean change merges with no `review_start` before its `merged` event, and gets an `afterMerge` review. With `"afterMerge": []`, it is reviewed before merging.
- Writing an unrelated key through the config writer leaves both keys absent from the file.
- doctor's `check` row names the in-lock command, where the full check runs, and the roles reviewed after merging.
- `npm test` passes.


### Codex backend, part 2b/9: Window events are `subscription_window_*` with a `backend`, and the reserve is `backends.<id>.windowReserve` (planned 2026-10-21 by the plan role; requires part 1/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/events/events.ts src/events/event-legacy.ts src/events/event-labels.ts src/events/event-format.ts src/events/notify.ts src/team/team-polls.ts src/gates/gate-polls.ts src/gates/budget-gates.ts src/orchestrator/orchestrator.ts src/config/config-schema.ts src/config/config-validation.ts src/config/config-views.ts src/config/config-write.ts docs/config.md docs/backends.md and their tests)

**Goal.** The four window events are named for claude and carry no backend, and the only reserve key is the top-level `claudeWindowReserve`. Rename them to `subscription_window_{warning,reserved,limited,reset}`, each with a `backend: string` field (`"claude"` today), and let `backends.<id>.windowReserve` hold a reserve while `claudeWindowReserve` keeps working as claude's older spelling. Crucially the new key is live at the end of THIS part, not dead until part 2c: every production reader of `claudeWindowReserve` switches to `windowReserveFor(config, "claude")` here (part 2c generalizes the literal). No behavior change for a claude-only team. The TUI and GUI reserve editors and `config-editable-keys` are deliberately untouched — `claudeWindowReserve` stays a valid editable key and those editors keep writing it, so this rename does not span them.

**Approach.**
- Events. src/events/events.ts: rename the four union members (keeping their payload comments) and add `backend: string` to each. src/events/event-labels.ts: rename the four keys; their labels are backend-neutral ("usage window reserved", "waiting: usage window"). src/events/event-format.ts: rename the four cases and name the backend from the event through a small `backendLabel(e.backend)` helper that maps `"claude"` to `"claude"` and any other id to itself, so a claude-only team's lines read exactly as today. src/events/event-legacy.ts's `normalizeLegacyEvent` maps each old `claude_window_*` name to its new one with `backend: "claude"`. src/events/notify.ts renames its two defaulted entries.
- Emitters. src/team/team-polls.ts and src/gates/gate-polls.ts use the new names and write a literal `backend: "claude"` on each event. They do NOT gain a `backend` parameter — part 2c adds one when a second backend exists, so this part leaves no half-used parameter for 2c to redo. `loggedWindowKeys(root, type, now)` (src/team/team-polls.ts) reads each event's own `backend` (falling back to `"claude"` for an event written before this rename) and keys by `${backend}:${windowType}:${resetsAt}`; src/orchestrator/orchestrator.ts passes the two new type names.
- Config. `BackendConfig` (src/config/config-schema.ts) gains `windowReserve?: Record<string, number>`, and `CLAUDE_AGENT_KEYS` gains `"windowReserve"` — claude only now (part 4/9 adds it for codex), so pi and opencode still refuse it as an unknown key. src/config/config-validation.ts validates each `backends.claude.windowReserve` value with the existing `0 < f <= 1` rule and rejects a file that holds both `claudeWindowReserve` and `backends.claude.windowReserve`, naming both. src/config/config-views.ts exports `windowReserveFor(config, backend)`: `backends[backend].windowReserve`, else `claudeWindowReserve` when `backend === "claude"`, else undefined.
- Live wiring. Replace the three direct `claudeWindowReserve` reads — src/gates/gate-polls.ts (`pollTeamHold` and `pollClaudeWindowReserve`) and src/gates/budget-gates.ts (`claudeWindowUsedUp`) — with `windowReserveFor(liveConfig, "claude")`, so the nested key drives the same reserve hold, the same `subscription_window_reserved` event and the same budget window move.
- Write path. src/config/config-write.ts's `setConfigKey`: setting `claudeWindowReserve` deletes `backends.claude.windowReserve`, and setting `backends.claude.windowReserve` deletes `claudeWindowReserve`, mirroring the `agentBin`/`piArgs` single-spelling arms, so a supported `config set` never writes the rejected pair; `validateConfig` (which `writeConfigMutation` already runs before writing) still refuses a hand-edited file that holds both.
- Docs. docs/config.md: the `backends` row names `backends.claude.windowReserve`, and the `claudeWindowReserve` row reads "The older top-level spelling of `backends.claude.windowReserve`; either may be set, but not both." docs/backends.md's "Reserve." paragraph gets the same full sentence, with the nested spelling as the current one.

**Acceptance criteria.**
- test/notify.test.ts, test/event-format-team.test.ts, test/gate-polls.test.ts and test/team-polls.test.ts pass with the new names and the added `backend`; the event-format lines for a `backend: "claude"` event render the same text as today's `claude_window_*` lines.
- `normalizeLegacyEvent({ type: "claude_window_limited", … })` yields `subscription_window_limited` with `backend: "claude"`; `tumwater logs --type claude_window_limited` still finds old lines.
- `loggedWindowKeys` returns one key per `backend:type:resetsAt`: two still-open windows whose types and `resetsAt` match but whose `backend` differ produce two keys, and a `backend: "codex"` warning does not suppress claude's own key.
- The nested key is live: a test with `backends.claude.windowReserve: { "seven_day": 0.8 }` and no `claudeWindowReserve` counts that window used up and logs `subscription_window_reserved { backend: "claude" }`, exactly as `claudeWindowReserve` did before this part.
- `windowReserveFor` reads the nested claude key, falls back to `claudeWindowReserve`, and returns undefined for a backend with neither; both keys set is a load error naming both; `backends.pi.windowReserve` is refused as an unknown key.
- A `config set` of either reserve spelling over a config holding the other leaves only the set spelling on disk, with no error; a hand-written file holding both fails `loadConfig`.
- `npm run test:gate` is green.

### Codex backend, part 2c/9: Budget gates, holds, the reserve and the window moves read each subscription backend's own account (planned 2026-10-21 by the plan role; requires parts 2a/9 and 2b/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 2; touches src/gates/budget-gates.ts src/gates/gate-polls.ts src/team/team-polls.ts src/orchestrator/orchestrator.ts and their tests)

**Goal.** Every window decision — a job moving down its chain, the director's move, the handback, the reserve and the subscription-window hold — works for any backend that reports a subscription. Today each is keyed to claude by `pairIsClaude`/`seamIsClaude` (src/gates/budget-gates.ts), the observation's `provider: "claude"` (src/team/team-polls.ts `claudeWindowObservation`) and one `windowOut` (src/gates/budget-gates.ts). With part 2a/9 (the account lookup) and part 2b/9 (the event `backend` and `windowReserveFor`) landed, no signature or event work is left. This is the state-machine half the feature role split out of part 2/9. No behavior change for a claude-only or pi-only team.

**Approach.**
- src/gates/budget-gates.ts:
  - `pairIsClaude` / `seamIsClaude` become `subscriptionBackendOf(pair | seam, accounts)`: the backend id whose account bills a subscription, else null.
  - `windowOut` and `directorWindowOut` become maps keyed by that backend id, and `windowMove` is "any entry stands and a fallback pair exists". The availability test, the pinned-role and reviewer rescue, `windowTiers`/`movedTiers` and `directorMoved` each read the job's or seam's own backend.
  - `chainInfo`'s `windowOut`/`account` parameters become the maps and the lookup, so its `"window"`/`"reserve"` reasons come from the step's backend. The `extraUsage` position rule and the `"overage"` reason stay claude-only.
- src/gates/gate-polls.ts: `claudeWindowWarned`/`claudeWindowReserved` become per-backend maps (a persisted old state reads `{ claude: … }`); `windowMovedRoles` uses `subscriptionBackendOf`; the poll reads each backend in `backendsInUse(config)` with `readAccount`, calls the reserve and warning polls per backend with `windowReserveFor(liveConfig, backend)`, and the window handback (`budget_handback`, reason `window`) gains `backend`.
- src/team/team-polls.ts: `claudeWindowObservation(account, now, reserve)` becomes `windowObservation(backend, account, now, reserve)` with `role` and `provider` set to `backend`; `pollTeamHold` receives one observation per subscription backend in use and stamps the limited event's `backend`. The `subscription-window` hold kind and `seamHoldKey` already key a non-pi backend by its id.
- src/orchestrator/orchestrator.ts: the `loggedWindowKeys` reads are per backend (part 2b/9 already keyed them).
- Replace the direct `liveConfig.claudeWindowReserve` reads in src/gates/budget-gates.ts, src/gates/gate-polls.ts and src/team/team-polls.ts with `windowReserveFor(liveConfig, backend)`.

**Acceptance criteria.**
- The existing tests pass with only their event-name/`backend` and account-shape expectations updated: test/budget-gates.test.ts, test/budget-chain-info.test.ts, test/gate-polls.test.ts, test/team-polls.test.ts, test/notify.test.ts, test/event-format-team.test.ts and test/orchestrator-budget.e2e.test.ts.
- A test registers a fake subscription backend `sub` whose account reports a rejected `five_hour` window. Then its jobs move to their fallback; a hold keyed `sub` is placed; `subscription_window_limited { backend: "sub" }` is logged once; claude jobs, and claude's account, are untouched.
- A test with claude's account rejected and `sub`'s healthy moves only claude's jobs, and the reverse moves only `sub`'s — one window per backend, not one shared window.
- `grep -n 'seamIsClaude\|pairIsClaude' src` prints nothing, and no `claudeWindowReserve` read remains in src/gates or src/team.
- `npm test` passes.

### Codex backend, part 3/9: Window displays name each subscription backend (planned 2026-10-20 by user; requires part 2c/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/status/status-budget.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-operator.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts src/roles/role-view.ts src/roles/role-render.ts src/report/report-render.ts src/doctor/doctor-holds.ts src/doctor/doctor.ts docs/backends.md and their tests)

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

### Codex backend, part 4/9: `codex` becomes a backend id, with `backends.codex`, tier defaults, the effort mapping, reserved flags and traits (planned 2026-10-20 by user; requires part 2c/9 landed; design in plans/codex-backend.md "Config and routing" and "CODEX_HOME and sessions"; touches src/config/config-schema.ts src/config/model-selector.ts src/config/config-validation.ts src/agent/backend-traits.ts src/agent/codex/codex-args.ts (new) src/doctor/doctor-model-checks.ts docs/config.md and their tests)

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

### `tumwater backlog -f/--follow` repaints the backlog every couple of seconds until Ctrl+C or its parent exits, the snapshot command's live twin of the TUI Backlog pane and the dashboard Backlog card (planned 2026-10-21 by the plan role; shares src/cli/cli-query-commands.ts, src/cli/help.ts and the `tumwater backlog` clause of docs/cli.md with the in-flight `tumwater queue -f/--follow` entry ahead of this one in `## Planned` and reuses the `followView` helper that entry's step 1 introduces, so whichever lands second rebases there; the in-flight TUI Activity tally plan edits `sayTally` in src/cli/log-commands.ts, src/ui/tui/tui-pane.ts, src/events/event-tally.ts, docs/cli.md's `logs --count` sentence and docs/how-it-works.md's Activity paragraph; the in-flight TUI Pending Ctrl+G plan edits src/ui/tui/tui-pane-pending.ts, test/tui-keys.test.ts and docs/how-it-works.md's Pending paragraph; the Codex parts edit src/events, src/config, src/gates, src/team, src/orchestrator and src/agent. None of those touches `cmdBacklog`, the `backlog` stanza of src/cli/help.ts or the new test. Touches src/cli/cli-query-commands.ts src/cli/help.ts docs/cli.md test/cli-backlog-follow.test.ts (new))

**Goal.** `tumwater backlog` prints the planned features, open bugs, and open questions once (`cmdBacklog`, src/cli/cli-query-commands.ts), with `--ready` hiding the held entries and counting them and `--grep` filtering them. The dashboard's Backlog card and the TUI's Backlog pane repaint as the team claims and finishes entries, but the CLI snapshot has no live form. Add `-f/--follow`: repaint the same text every couple of seconds until Ctrl+C or the parent process exits (the rule `status -f`, `queue -f`, `logs -f` and `history -f` use), composing with `--ready` and `--grep` so each frame reflects the current backlog; `--json` is refused with a follow because it prints one document.

**Approach.** src/cli/cli-query-commands.ts unless named otherwise.

1. Share the follow loop: call `followView(frameText, seams)` and take its `FollowViewSeams` argument type (both are introduced by the `tumwater queue -f/--follow` entry ahead of this one in `## Planned`: its step 1 renames the local `StatusFollowSeams` to `FollowViewSeams`, renames `STATUS_FOLLOW_INTERVAL_MS` to `FOLLOW_VIEW_INTERVAL_MS`, and lifts `followStatus`'s body into `followView`). If that entry has not landed yet, do that extraction exactly as it prescribes first, then use the helper here; both live in this file already, so neither is exported for the test.
2. `cmdBacklog` gains the flag and the follow branch:
   - Add `const BACKLOG_FOLLOW_SPEC = { names: ["-f", "--follow"] };` beside `BACKLOG_GREP_VALUE_ERROR`, and pass it to the gate: `rejectUnknownArgs("backlog", args, [JSON_FLAG, READY_FLAG, grepFlagSpec(BACKLOG_GREP_VALUE_ERROR), BACKLOG_FOLLOW_SPEC])`.
   - Change the signature to `export async function cmdBacklog(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void>` (cli.ts's call site passes no seams and needs no change).
   - Add `const follow = args.includes("-f") || args.includes("--follow");` and, beside the flag gate, `if (follow && args.includes("--json")) fail("backlog --json prints one document; -f/--follow repaints a live view — drop one of them");`.
   - Factor today's `sayJsonOrRender` value thunk into `const readBacklog = () => { const view = { ...backlogPayload(root), holds: backlogHolds(root), inProgress: backlogInProgress(root) }; const filtered = pattern === null ? view : grepBacklog(view, pattern); if (!ready) return { view: filtered, hidden: 0 }; const kept = readyBacklog(filtered); return { view: kept, hidden: filtered.plans.length + filtered.bugs.length - kept.plans.length - kept.bugs.length }; };` and `const renderBacklogText = (r) => renderBacklogMarkdown(r.view) + (r.hidden > 0 ? \`\n\n_(${r.hidden} held entries hidden; run \\\`tumwater backlog\\\` to see them)_\` : "");`. The factored `readBacklog` reproduces the thunk's `view` and its `hidden` side effect exactly, so the render text is byte-identical to today's.
   - Before the snapshot, `if (follow) { await followView(() => renderBacklogText(readBacklog()), seams); return; }`. Then `const result = readBacklog(); sayJsonOrRender(rest, result.view, () => renderBacklogText(result));` — the `--json` branch prints `result.view`, the text branch `renderBacklogText(result)`, matching today.
3. src/cli/help.ts, the `tumwater backlog` stanza: synopsis becomes `tumwater backlog [--ready] [--grep <text>] [-f/--follow] [--json]`, and after the `--grep` sentence add `-f/--follow repaints the backlog every couple of seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does not outlive its parent; it refuses --json;`. Wrap to the stanza's column.
4. docs/cli.md, the `tumwater backlog` clause of the "Check state" row: add `[-f/--follow]` to its synopsis and, after the `--grep` sentence, add ``-f/--follow` repaints the backlog every couple of seconds until Ctrl+C or its parent process exits (a backgrounded follow does not outlive its parent, like `status -f` and `queue -f`); it refuses `--json` ``. Leave the surrounding clauses untouched.

**Files touched.** src/cli/cli-query-commands.ts, src/cli/help.ts, docs/cli.md, test/cli-backlog-follow.test.ts (new).

**Acceptance criteria.**
- test/cli-backlog-follow.test.ts (new), driving `cmdBacklog` in-process with the follow seams the way test/status-follow.test.ts drives `cmdStatus` (a `makeRepo()` + `initProject` repo, PLANS.md seeded with `writeBacklogFile` and BUGS.md with `seedOpenBug` from ./fixtures/repo-fixtures.js, `captureStdout` from ./helpers/exit-capture.js, `sleep` from ./helpers/wait.js, and a `withFollow(args, intervalMs, tty, drive)` helper whose `stop()` sets the seam's parent to PID 1 and whose `finally` awaits the follow under a restored stdout):
  - "backlog -f repaints until its parent exits, then prints nothing": seed a `### Alpha (planned 2026-01-01 by operator)` plan entry and the open bug; run `["-f"]` at 5 ms non-TTY; after ~60 ms `cap.out()` matches `/Alpha/` at least twice and contains `/An open bug/`; `stop()` then the follow resolves and stdout stops growing.
  - "backlog -f --ready keeps only ready entries and names the hidden count": seed a held plan (`**Refused 2026-10-07 by feature: no**`) and a ready one; run `["--ready", "-f"]`; the frames match `/### Ready plan/`, never `/Refused plan/`, and end with the `_(\(\d+ held entries hidden; run `tumwater backlog` to see them\)_` note.
  - "backlog -f --grep keeps only matching entries": seed a matching and a non-matching heading; the frames match the match and never the other.
  - "backlog -f --json is refused": `expectFailAsync(() => cmdBacklog(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }))` rejects matching `/backlog --json prints one document/`, and the captured stdout has no backlog heading and no clear-screen.
  - "backlog -f clears the screen only on a TTY": with `tty: true` the output starts with `"\x1b[H\x1b[2J"`; with `tty: false` it never contains that sequence.
- test/backlog-render.test.ts and the rest of the backlog tests pass unchanged: `tumwater backlog`, `--ready`, `--grep` and their `--json` forms print the same bytes as today (the factored `readBacklog` returns the same view and hidden count).
- test/status-follow.test.ts passes unchanged: the reused `followView` emits the same frames and still refuses `status -f --json`.
- `npm run test:gate` is green.

### `tumwater report -f/--follow` repaints the usage report (or, with `--failures`, the failure digest) every couple of seconds until Ctrl+C or its parent exits, the live twin of the dashboard Usage card and the TUI Usage and Failures panes (planned 2026-10-21 by the plan role; sits behind the in-flight `tumwater queue -f/--follow` and `tumwater backlog -f/--follow` entries, whose shared `followView` loop it lifts into a leaf module, so whichever lands first rebases `src/cli/cli-query-commands.ts` there; the in-flight TUI Activity tally plan edits src/cli/log-commands.ts and src/ui/tui; the `tumwater doctor` `merge-queue files` plan edits src/merge and src/doctor; the Codex parts edit src/events, src/config, src/gates, src/team, src/orchestrator and src/agent. None of those touches src/report, src/cli/follow-view.ts or test/report-follow.test.ts. Touches src/cli/follow-view.ts (new) src/cli/cli-query-commands.ts src/report/report.ts src/cli.ts src/cli/help.ts docs/cli.md test/report-follow.test.ts (new))

**Goal.** `tumwater status`, `tumwater queue` and `tumwater backlog` are gaining `-f/--follow`; `tumwater report` is the only read-only snapshot left without a live form. An operator watching spend, run counts, or the failure digest wants the same table to update as runs land, the way the dashboard's Usage card and the TUI's Usage and Failures panes already do. Add `-f/--follow` to the two day forms (`report` and `report --failures`): repaint the same text every couple of seconds until Ctrl+C or the parent process exits (the rule `status -f`, `queue -f`, `logs -f` and `history -f` use), composing with `--days` and `--role`. As with `history -f`, `--since` (and so `--until`) is refused — follow means the window that ends now, not a bounded past one — and `--json` is refused because it prints one document.

**Approach.** The report collectors are synchronous (`collectReport`, `collectFailureReport`), so the existing `followView(frameText: () => string, seams)` shape fits with no async rework.

1. Lift the repaint loop into a leaf module. `src/cli/cli-query-commands.ts` keeps it local today as `followStatus` (the `tumwater queue -f/--follow` entry ahead of this one renames its body to `followView`). Create `src/cli/follow-view.ts` holding:
   - `export const FOLLOW_VIEW_INTERVAL_MS = 2000;`
   - `export interface FollowViewSeams { ppid?: () => number; intervalMs?: number; tty?: boolean; }`
   - `export async function followView(frameText: () => string, seams: FollowViewSeams): Promise<void>` with exactly today's loop: `const tty = seams.tty ?? process.stdout.isTTY;` `const interval = seams.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;` a `frame()` that writes `tty ? "\x1b[H\x1b[2J" + text + "\n" : text + "\n\n"`, one immediate `frame()`, then the `setInterval` plus `startParentDeathWatch(() => { clearInterval(timer); resolve(); }, { …seams })` promise. It imports only `startParentDeathWatch` from `../process/supervisor.js` (no cycle). Its header comment says it is the repaint loop every `-f` view shares.
   - In `src/cli/cli-query-commands.ts`, import `{ followView, type FollowViewSeams }` from `./follow-view.js`, delete the local interval constant and seams interface, and make `followStatus` the call `followView(() => renderStatus(root, scope ? scopeSnapshotToRoles(snapshot(root), scope) : snapshot(root), tty ? process.stdout.columns : undefined, scope !== null), seams)` (reading `tty` for the column count). If the queue entry has not landed yet, lift today's `followStatus` body the same way. `status -f` emits the same frames.
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

### A role's notes are shown beside the live backlog state of every entry and series they name, so a note cannot keep a hold the backlog has lifted (planned 2026-10-21 by user; independent of every eligible plan; the structural fix for BUGS.md "Role notes keep a hold belief after the hold is lifted", and it also gives BUGS.md "A refusal can rest on another entry's refusal …" the current state to check against; touches src/prompt/notes-backlog.ts (new) src/prompt/prompt.ts src/run/run-prompt.ts docs/how-it-works.md test/notes-backlog.test.ts (new) test/prompt.test.ts test/run-prompt.test.ts)

**Goal.** Role notes are free text, carried into every later run of the role and rewritten from the previous note. When a note states something about the backlog (an entry is refused, a series is dead, a part is done), nothing checks that claim again. On 2026-10-21, plan run 414 wrote "Codex 2b/9 carry Refused — never re-add or re-author them; the Codex theme is dead". Four minutes later both Refused notes became Needs-replan notes, which the plan role exists to act on, but its notes kept telling it to skip them, and the series stalled. feature-4's notes needed the same hand correction. Make every run prompt say what is currently true of each entry and series the notes name, next to the notes, so the live state wins without anyone editing a notes file.

**Approach.**
1. New pure module src/prompt/notes-backlog.ts: `notesBacklogBlock(notes, backlog)`.
   - `backlog` is `{ planned: BacklogEntry[], openBugs: BacklogEntry[], donePlanTitles: string[] }`.
   - It returns the block's text, or undefined when the notes name nothing live.
2. **What counts as naming a series.** For each series among the planned entries (`seriesPart` in src/backlog/backlog-parts.ts), its tokens are the full series name and, when no other live series shares it, its first word. Matching is case-insensitive on word boundaries.
   - A line that holds a token and a part ref `i/n` that is one of that series' parts names that part. "Codex 2b/9" names Codex backend, part 2b/9.
   - A token alone names the series. "the Codex theme" names the Codex backend series.
3. **What counts as naming a standalone entry or bug.** A line that contains, in order, the first six words of a planned entry's or Open bug's title (`entryKey` normalization) names that entry.
4. **The state of each named item.**
   - A planned entry or bug gets `entryHold` (src/backlog/backlog-eligibility.ts): `eligible`, `refused (only the operator clears it)`, `needs review`, `needs replan (the plan role rewrites it)`, `waiting for the next failure`, or `waits on <parts>`.
   - A part found in `donePlans` reads `done`. A part found nowhere reads `not in the backlog`.
   - A series gets one summary line: its planned-part count, how many need a replan or review, how many wait on an earlier part, and how many are refused.
5. **The block.** It is at most 12 lines, series first:
   `What the backlog says now about entries your notes name (PLANS.md and BUGS.md as of this run; where your notes disagree, this is current):`
   followed by one `- <name> — <state>` line each.
6. **src/prompt/prompt.ts.**
   - `roleNotesBlock`'s caption changes from "check against the code before relying on them" to "check against the code, and against the backlog state below, before relying on them".
   - `buildRunPrompt` takes an optional `notesBacklog` and pushes it right after the notes block.
7. **src/run/run-prompt.ts.** Where it reads `notes` (`readRoleNote`), it builds the backlog argument from `plannedPlanEntries(root)`, `openBugEntries(root)` and `donePlans(root)`, all of which are already stat-cached, and passes `notesBacklogBlock(notes, …)` through. The director carries no notes, so it gets no block.
8. **docs/how-it-works.md**, the notes paragraph: a run also sees the current backlog state of each entry and series its notes name, and that state wins where they disagree.

**Acceptance criteria.**
- test/notes-backlog.test.ts (new):
  - The 2026-10-21 plan.md lines against a PLANS.md where Codex backend parts 2b/9 and 6/9 carry Needs-replan notes, and parts 2c/9–9/9 require earlier parts, yield `Codex backend — 9 parts planned: 2 need a replan, 7 wait on an earlier part, none refused`, plus `Codex backend, part 2b/9 — needs replan (the plan role rewrites it)` and the same for 6/9.
  - "Codex" alone resolves to the Codex backend series only while no other live series starts with "Codex". With a second such series, the bare word names neither.
  - A part listed in PLANS-DONE.md reads `done`. A refused entry reads `refused (only the operator clears it)`.
  - Notes that name no live entry or series give undefined.
  - Forty named parts render at most 12 lines.
- test/prompt.test.ts: with notes and a `notesBacklog` block, the block follows `</role-notes>` and the caption mentions the backlog state. Without a block, the prompt equals today's apart from the caption.
- test/run-prompt.test.ts: a run whose notes file names a planned part gets the block; the director's prompt has none.
- `npm test` passes.

## Done
