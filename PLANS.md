# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Codex backend, part 3a/9: The subscription-window block is per backend, and `status --json` gains `subscriptionWindows` (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 2e/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/agent/subscription-account.ts src/agent/backend-traits.ts src/status/status-budget.ts src/status/status-data.ts src/ui/status-payload.ts test/status-budget.test.ts test/status-data-models.test.ts)

**Goal.** One status-poll read yields one subscription-window block per subscription backend in use, not only claude's, and hands the ordered list to every display surface. This is the shared model parts 3b/9–3e/9 consume; a claude-only snapshot is unchanged apart from the added list.

**Approach.**
- src/agent/backend-traits.ts: add `backendDisplayName(id)` = `id.charAt(0).toUpperCase() + id.slice(1)` ("claude" → "Claude", "codex" → "Codex"), the one home of a backend's display name.
- src/agent/subscription-account.ts: extract the comparator inside `windowEntries` into an exported `compareWindowEntries(a, b)` and call it from `windowEntries` (output byte-identical), so a list of blocks can be ordered by its primary entry the same way.
- src/status/status-budget.ts: `claudeWindowBlock` becomes `windowBlocks(cfg, providers, accounts, catalog)` returning `{ blocks, only }`. `blocks: SubscriptionWindowBlock[]` (`{ backend, label: backendDisplayName(backend), windows: windowEntries(account), primary: windows[0]!, heldUntil }`) carries one entry for every distinct non-`pi` backend the enabled seams (roles, review, resolver) route to whose `accounts(backend)` reads `billing === "subscription"` with at least one window. Blocks sort by `compareWindowEntries(a.primary, b.primary)` then `backend`. `only` is team-global: `!seams.some((s) => !seamFree(providers, s, accounts, catalog))`.
  - `BudgetSlice` replaces `claudeWindow` with `subscriptionWindows: SubscriptionWindowBlock[]` and `subscriptionOnly: boolean`. `collectBudget` builds `accounts` as a per-poll memoized `readAccount(root, backend, now)` Map (one read per backend per poll, today's one-claude-read cost) and returns both new fields.
- src/status/status-data.ts: `StatusSnapshot` gains `subscriptionWindows?: SubscriptionWindowBlock[]` (present only when non-empty) and `subscriptionOnly: boolean`; it derives the existing `claudeWindow?: {windows, primary, only, heldUntil}` from the claude block (`only: subscriptionOnly`), with a doc comment saying it is kept for one release. Its presence rule is unchanged.
- src/ui/status-payload.ts: the payload spreads `subscriptionWindows` and `subscriptionOnly` beside `claudeWindow` (the preformatted `budgetBadge` stays on `claudeWindow` until part 3b/9).

**Acceptance criteria.**
- With two subscription accounts (`claude` and a fake `sub`): `status --json` lists both `subscriptionWindows` entries, ordered most-constrained-first; each carries `backend`, `label`, `windows`, `primary`, `heldUntil`.
- A claude-only team: `snap.claudeWindow` is unchanged (same `windows`, `primary`, `heldUntil`; `only` as before), and the only `status --json` delta is the added keys.
- `snap.claudeWindow` is absent exactly when no claude subscription seam has a window (today's rule).
- `windowEntries` output is byte-identical to before.
- `npm test` passes.

### Codex backend, part 3b/9: The status header and the GUI budget tile name each backend's window (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/ui/badges.ts src/ui/status-render.ts src/ui/status-payload.ts src/ui/gui/gui-client-operator.ts test/badges.test.ts test/status-header.test.ts test/gui-client.test.ts)

**Goal.** The header badge and the GUI budget tile render each subscription backend's window under that backend's name; a claude-only team's text is byte-identical.

**Approach.**
- src/ui/badges.ts: `claudeWindowBadge(claudeWindow, now, moved)` becomes `subscriptionWindowBadge(blocks, now, moved)`, rendering `${block.label} ${windowLabel(block.primary.type)}` + utilization percent or status word + the "<label> model jobs wait until HH:MM" hold clause (the label replaces the hardcoded "claude"). The badge shows `blocks[0]` (the list is already most-constrained-first). `budgetBadge(budget, claudeWindow, now, chain)` becomes `budgetBadge(budget, windows, only, now, chain)`: the `if (only) return window` replacement and the "beside the spend" join are unchanged over the new arguments. `claudeWindowTone(claudeWindow)` becomes `subscriptionWindowTone(blocks)` reading `blocks[0]`.
- src/ui/status-render.ts and src/ui/status-payload.ts: pass `snap.subscriptionWindows` and `snap.subscriptionOnly` to `budgetBadge` and the tone; the payload's preformatted `budgetBadge` string is that same function's output.
- src/ui/gui/gui-client-operator.ts: `budgetCardHtml(b, cw, chain)` and `windowLinesHtml` take the block list and `only`; they emit one window line per block (same per-line markup) and name the held block's label in the "held until" line.

**Acceptance criteria.**
- Existing badge and status-header tests for a claude-only snapshot pass with byte-identical strings.
- With a `sub` block ordered first, the header badge reads `Sub 7d · 40%` and the tile lists both `Claude 5h …` and `Sub 7d …`; with claude first, the header keeps `Claude 5h …`.
- `npm test` passes.

### Codex backend, part 3c/9: The role view and its billing line name the job's own subscription backend (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/roles/role-view.ts src/roles/role-render.ts test/role-view.test.ts)

**Goal.** A role running a subscription backend shows that backend's window label and "window used up" phrase instead of always saying Claude.

**Approach.**
- src/roles/role-view.ts: `claudeInPlay` becomes "a subscription backend is in play": the role's own seam backend when it is not `pi`, else the reviewer's backend when the review gate is on (today's precedence, generalized off the literal "claude"). Read its account with `readAccount(root, backend)`, keep `billingWindow` as the account's primary window type, and carry the backend id as a new view field beside it.
- src/roles/role-render.ts: the "window used up" phrase and the billing line use `backendDisplayName(billingBackend)` with `windowLabel(windowType)` ("Codex 7d window"), falling back to today's "Claude" wording when no backend is known.

**Acceptance criteria.**
- A role on a codex subscription account renders "Codex 7d window" and "Codex window used up"; a claude role's render is byte-identical to today; a pi role with a claude reviewer still shows claude.
- `npm test` passes.

### Codex backend, part 3d/9: The report's API-equivalent line names each subscription backend (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/events/events.ts src/run/run-finalize.ts src/report/report-fold.ts src/report/report-types.ts src/report/report-data.ts src/report/report-render.ts test/report.test.ts test/report-data.test.ts)

**Goal.** The report prints one "<label> subscription, API-equivalent: $X estimated" line per subscription backend with notional spend, instead of one hardcoded "claude subscription" line.

**Approach.**
- src/run/run-finalize.ts: the `run_end` event carries `agent: usage.agent` when the run reported billing or rate windows (the same condition that writes the account file), so the fold can attribute notional spend to a backend; document the new field in src/events/events.ts's `run_end` comment.
- src/report/report-fold.ts: a `notionalByBackend` map beside `notionalByProvider`, accumulated from each `run_end`'s `agent` — falling back to `"claude"` when `agent` is absent and `billing === "subscription"`, the same legacy default old window events get.
- src/report/report-types.ts and src/report/report-data.ts: carry `notionalByBackend` through the fold → day → totals exactly as `notionalByProvider` is carried; absent when empty.
- src/report/report-render.ts: `notionalLine` becomes one line per backend with notional spend, `${backendDisplayName(backend)} subscription, API-equivalent: $X estimated`; keep a single generic line for the total when only old-log totals are known.

**Acceptance criteria.**
- A report over runs of two subscription backends prints two labeled notional lines; a claude-only report's line is byte-identical to today; the totals' `notionalCostUsd` still equals the sum.
- Old `run_end` events without `agent` still count their notional under claude (the legacy default).
- `npm test` passes.

### Codex backend, part 3e/9: Doctor's window row names each subscription backend, the reserve labels name the key, and docs say the display is per backend (planned 2026-10-20 by user, split 2026-10-23 by the plan role from part 3/9 after a feature Needs-review; requires part 3a/9 landed; design in plans/codex-backend.md "Groundwork: the subscription account is per backend" item 3; touches src/doctor/doctor-holds.ts src/doctor/doctor.ts src/doctor/doctor-check-names.ts src/ui/gui/gui-client-settings.ts src/ui/tui/tui-editor-claude-reserve.ts docs/backends.md test/doctor-holds.test.ts test/doctor.test.ts test/gui-client-settings.test.ts)

**Goal.** `tumwater doctor` reports one window row per subscription backend in use (a codex team gets a `codex window` row), the reserve editors name the `backends.<id>.windowReserve` key, and docs/backends.md states the display is per backend.

**Approach.**
- src/doctor/doctor-holds.ts: `checkClaudeWindow` becomes `checkSubscriptionWindow(backend, root, now, chain, config)` — the same body over `readAccount(root, backend)` and `windowObservation(backend, …)`, with every "claude" phrase replaced by `backendDisplayName(backend)`.
- src/doctor/doctor.ts: the one "claude window" step becomes two conditional steps, `claude window` and `codex window`, each returning null when that backend has no subscription account (the same omit-a-row pattern as "pi extensions").
- src/doctor/doctor-check-names.ts: add `"codex window"` after `"claude window"`, so the closed name union still covers every step and `tumwater doctor codex window` parses.
- src/ui/gui/gui-client-settings.ts and src/ui/tui/tui-editor-claude-reserve.ts: the label and editor hint read "Claude window reserve (backends.claude.windowReserve)".
- docs/backends.md: the window-display paragraph says the windows are shown per backend.

**Acceptance criteria.**
- A codex subscription account makes doctor print a `codex window` row and a claude one makes `claude window`; a pi-only team prints neither; each row's text names its own label.
- The settings label test asserts the new text; the TUI editor hint names the key.
- `npm test` passes.


### Codex backend, part 8/9: Codex billing, free-ness and windows: the account fed from runs, the API-key refusal, the context window, effort levels and image input from the catalog (planned 2026-10-20 by user; requires parts 3a/9, 3b/9 and 7/9 landed; design in plans/codex-backend.md "Spend, free-ness, window, images"; touches src/pi/pi-models.ts src/agent/codex/codex-backend.ts src/agent/codex/codex-catalog.ts (new) src/agent/codex/codex-account.ts (new) src/gates/startup-gate.ts src/config/config-live.ts and their tests)

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
