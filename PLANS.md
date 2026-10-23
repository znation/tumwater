# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Codex backend, part 3/9: Window displays name each subscription backend (planned 2026-10-20 by user; requires part 2e/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/status/status-budget.ts src/status/status-data.ts src/ui/badges.ts src/ui/status-payload.ts src/ui/status-render.ts src/ui/gui/gui-client-operator.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts src/roles/role-view.ts src/roles/role-render.ts src/report/report-render.ts src/doctor/doctor-holds.ts src/doctor/doctor.ts docs/backends.md and their tests)

**Needs review 2026-10-22 by feature: too large for one run**

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

## Split validateConfig's section rules out of the single validation gate by theme (planned 2026-10-22 by the organize role, plan-only)

src/config/config-validation.ts is the project's second-largest module (748 lines, ~3.7× the
200-line median) and ~607 of those lines are one function, `validateConfig`, a single sequential
pass that walks every section of tumwater.json. The doc already factors the generic machinery
(schema rules, the NumberRule table, the known-role/unknown-key guards) into
config-field-checks.ts, but every section's own rules still live inside the one gate, so any
edit to one section means reading and re-walking the whole pass and lands as one giant diff. The
gate is a single function, so it cannot be split piecemeal in one run; land this as a plan.

The split preserves `validateConfig` as the one export every caller imports (only four callers:
config.ts, config-write-core.ts, config-request.ts, config-example.ts; they keep importing it
unchanged) and keeps behavior and message byte-identical: the section validators only re-locate
where each today-appended problem is produced, in the same order.

**Target structure** — the two largest, most self-contained blocks move out first, each into a
new module that appends problems exactly as the gate does today. The model blocks are
interleaved with the gate's other sections: the top-level `model`/`provider` block runs before
`agentBin`/`baseBranch`/`backends`, but the `fallback`/`fallbackModel` block runs after the
numeric/`check`/`idleBackoff`/`review` sections (lines 224–277 and 473–508 in today's gate). So
the model module exports TWO functions — `validateModelBlock(r, problems, helpers)` for the
top-level selector/map block and `validateFallbackBlock(r, problems, helpers)` for the
fallback/fallbackModel shape — and the gate calls each at the point where its block runs today;
the agents module stays one function. This keeps problem order byte-identical, which a single
model-module function called once could not (a one-call design would emit fallback problems
before the agents and middle-section problems they follow today).
- New src/config/config-validation-model.ts — the model-declaration surface, as two entry points:
  `validateModelBlock` — top-level `model` selector vs map-by-tier and each tier entry's
  `model`/`provider`/`thinking`, the empty-half selector checks, backend-resolution, the
  retired-is-a-backend spelling and the legacy-provider form; and `validateFallbackBlock` — the
  `fallback` (string vs map) checks and the free-fallback-model (`fallbackModel`) shape.
- New src/config/config-validation-agents.ts — the agent-execution surface: `agentBin`,
  `baseBranch`, the claude/codex `configDir` scan, the codex `-c <key>=…` arity-aware scan, the
  `agents`/`piArgs` passthrough reserved-flag checks, and the legacy piArgs back-compat pair.
- src/config/config-validation.ts keeps `validateConfig` as the gate: bind the generic checkers
  once, call the two model-module functions and the agents-module function in the same order their
  blocks run today, and keep the
  per-role and cross-field sections (roles.<id> task/instructions/customRoles/instances,
  review.afterMerge names, per-role caps, per-role quiet hours, maxConcurrentPerProvider,
  claudeWindowReserve, and the idleBackoff cross-field pair) for a later pass.

**Cost it removes**: a section's rules become findable and testable in isolation instead of being
one undifferentiated stretch of a 600-line pass; a per-theme diff replaces a whole-gate diff.

**Files touched**: src/config/config-validation.ts; new src/config/config-validation-model.ts and
src/config/config-validation-agents.ts; docs/invariants.md only if it pins the gate's shape.

**Acceptance criteria.**
- The two new modules hold exactly the model and agent section rules, nothing else; the gate
  binds checkers once and calls them in the same order their blocks run today.
- Behaviour and messages unchanged: `validateConfig` produces identical problems for the same
  input before and after (the existing config validation tests pass untouched).
- A file only mentioning a model/backend key still validates identically pre- and post-split.
- grep over src, tests and docs finds no stale path or name for the moved blocks.
- `npm run test:gate` and `npm test` pass.

## Done
