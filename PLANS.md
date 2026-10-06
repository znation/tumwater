# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.


## Planned

### Model tiers, part 1/8: `provider/id[:thinking]` selector strings for `model`, and `fallback` as the new name of `fallbackModel` (planned 2026-10-05 by operator)

Design: plans/model-tiers.md ("Config", "Selectors", "Backward compatibility"). Config only — no
seam changes model, and every existing config produces the same pi argv.

**Goal.** A single-model setup is one key:
`"model": "huggingface/zai-org/GLM-5.3-Flash:together:low"` carries provider, id, and thinking,
and `"fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"` names the budget fallback the same way. `roles.<id>.model` and `review.model` accept the same strings.

**Approach.**
1. **src/model-selector.ts (new):** `parseModelSelector(s, legacyProvider?)` returns
   `{ provider?, model, thinking? }`; `formatModelSelector(triple)` is its inverse. Rules: a
   trailing `:x` is thinking only when `x` is in `THINKING_LEVELS` (src/config/config-schema.ts), so
   `…:together` survives; with `legacyProvider` the rest is a bare id under that provider;
   otherwise the text before the first `/` is the provider and the rest is the id; a string
   with no `/` is a bare pattern with no provider.
2. **src/config/config-schema.ts:** `fallback?: string` on `TumwaterConfig`, `"fallback"` in
   `TOP_LEVEL_KEYS`. (The map forms arrive in part 3/8.)
3. **src/config/config-views.ts:** `withModelOverrides`, `configForRole`, `reviewConfig`, and
   `fallbackPair` parse selectors into the provider/model/thinking triple `piArgs`
   (src/pi/pi-args.ts) already consumes. A legacy `provider` in scope (the section's own, else
   the top level's) is passed as `legacyProvider`; an explicit `thinking` key wins over a
   suffix; `fallback` and the legacy `fallbackModel` object both feed `fallbackPair`.
4. **Validation** (src/config/config-validation.ts, src/config/config-field-checks.ts): `fallback` is a
   non-empty string, and `fallback` together with `fallbackModel` is an error naming both keys.

**Files touched.** src/model-selector.ts (new), src/config/config-schema.ts, src/config/config-views.ts,
src/config/config-validation.ts, src/config/config-field-checks.ts, and tests (a new
test/model-selector.test.ts plus the config-views and pi-args suites).

**Acceptance criteria.**
- `parseModelSelector("huggingface/zai-org/GLM-5.3-Flash:together:low")` → provider
  `huggingface`, model `zai-org/GLM-5.3-Flash:together`, thinking `low`; without `:low` the
  `:together` suffix stays on the id; `"GLM-5.3-Flash"` → model only.
- With a legacy `"provider": "huggingface"`, `"model": "zai-org/GLM-5.3-Flash:together"` still
  resolves to provider `huggingface`, not `zai-org`.
- `{ "model": "<provider>/<id>" }` alone yields pi argv `--provider <provider> --model <id>`
  (fake pi shim).
- A `fallback` string engages exactly like the equivalent `fallbackModel` object: the existing
  fallback tests pass against both forms.
- Every existing config fixture produces identical pi argv; `npm run test` passes.

### Model tiers, part 2/8: record the model each pi run used on `tick_start` and `review_start` (planned 2026-10-05 by operator; requires part 1/8 landed)

Design: plans/model-tiers.md ("Observability").

**Goal.** No model choice can be evaluated from `.tumwater/log/events.jsonl` today:
`tick_start` carries only `tick` and `review_start` only `head`. Record the selector each run
starts on, so outcomes, review verdicts, and spend can be compared per model.

**Approach.**
1. **src/loop.ts:** the `tick_start` event gains `model: formatModelSelector(...)` of the `cfg`
   that `tick()` already resolves with `configForRole` (the same config `tickPair` captures, so
   on the budget fallback it names the fallback).
2. **src/review.ts:** `review_start` gains `model` from `reviewRunConfig`.
3. **src/events.ts / src/event-format.ts:** optional `model?: string` on both event types,
   rendered after the existing text. Omitted when no model is configured (pi's own default),
   and old logs without the field still read and render.

**Files touched.** src/loop.ts, src/review.ts, src/events.ts, src/event-format.ts, and their tests.

**Acceptance criteria.**
- A tick on a configured model logs `tick_start` whose `model` is `formatModelSelector` of its
  resolved triple; under the budget fallback it names the fallback.
- `review_start` carries the reviewer's model.
- With no model configured, neither event gains the field; old event logs render unchanged.

### Model tiers, part 3/8: `small` / `default` / `strong` tier maps and the built-in tier of each role and the reviewer (planned 2026-10-05 by operator; requires part 1/8 landed)

Design: plans/model-tiers.md ("Config", "Which tier each seam uses").

**Goal.** `model` may be a map by tier, catalog roles and the reviewer carry a built-in tier,
and `roles.<id>.model` / `review.model` may name a tier. With only `default` declared, every
seam resolves exactly as today. (`fallback` maps are parsed here but consulted per tier only
in part 5/8; until then a map `fallback` uses its `default` entry.)

**Approach.**
1. **src/config/config-schema.ts:** `ModelTier = "small" | "default" | "strong"`; `model` and
   `fallback` become `string | Partial<Record<ModelTier, string>>`, where a string means
   `{ default: <string> }`. `fallback` map values may also be `"pause"` (consulted in part 5/8).
2. **src/role-catalog.ts:** `Role` gains `tier: ModelTier` — `plan` → `strong`, `readme` →
   `small`, every other catalog role (director included) → `default`; user-defined loops
   (src/roles.ts) → `default`.
3. **src/config/config-views.ts:** `tierModel(config, tier)` returns the tier's selector, else
   `default`'s, else none (pi's own default). `configForRole` resolves `roles.<id>.model` (a
   tier name → that tier, a selector → itself), else the role's catalog tier. `reviewConfig`
   resolves `review.model` the same way, else `strong`.
4. **Validation:** map keys are exactly the three tiers; a map-form `model` with a legacy
   top-level `provider` is an error; tier names are valid only as `roles.<id>.model` /
   `review.model` values.
5. **src/pi/pi-models.ts `fleetModelsFree`:** its loop over `configForRole` / `reviewConfig` now
   sees tier models; also include `tierModel(config, "strong")` whenever any role is enabled
   (the conflict resolver's, part 4/8), so the budget never reads n/a while a priced strong
   model can spend.

**Files touched.** src/config/config-schema.ts, src/role-catalog.ts, src/roles.ts, src/config/config-views.ts,
src/config/config-validation.ts, src/config/config-field-checks.ts, src/pi/pi-models.ts, and their tests.

**Acceptance criteria.**
- With `{ "model": { "default": A, "strong": B } }`, plan and reviewer runs carry B, feature
  and readme carry A; adding `"small": C` moves readme to C.
- `roles.feature.model: "strong"` → B; `review.model: "default"` → A;
  `roles.feature.model: "<provider>/<id>"` → that selector.
- A string `model` and the equivalent `{ "default": … }` map produce identical argv for every
  seam, and with only `default` declared the existing tests pass unchanged.
- `fleetModelsFree` is false when any tier a seam resolves to is priced.

### Model tiers, part 4/8: the conflict resolver runs on the strong tier (planned 2026-10-05 by operator; requires part 3/8 landed and running)

Design: plans/model-tiers.md ("Which tier each seam uses"). It changes how landings behave, so it
is its own sub-plan and lands only once part 3/8 is the running build.

**Goal.** `resolveConflict` (src/landing/landing-merge.ts) runs pi through the authoring loop's
own config, so a conflict is resolved by whichever model wrote the change. Run it on the strong
tier instead: resolution is rare, tolerant of latency, and edits code inside landing (BUGS.md,
"A conflict resolution that changes the approved change's scope lands unreviewed").

**Approach.**
1. **src/config/config-views.ts:** `resolverConfig(config)` installs `tierModel(config, "strong")` over
   `config`. Because it reads whatever config the landing is handed, it follows the budget
   fallback's config once part 5/8 lands.
2. **`RunsPi.runPi`** (src/loop-pi.ts) takes an optional fourth `config` argument. The loop's
   wiring (src/loop.ts, `runPi: (w, prompt, sessionName) => this.pi.runRolePi(...)`) passes it
   to `LoopPi.runRolePi`, where it replaces `configForRole(...)` in `loopPiOpts` for that run.
   `resolveConflict` passes `resolverConfig(...)`; the session dir, raw log, transient retry,
   and usage folding (charged to the authoring role) are unchanged.

**Files touched.** src/config/config-views.ts, src/loop-pi.ts, src/loop.ts,
src/landing/landing-merge.ts, and the landing-merge and loop-pi tests.

**Acceptance criteria.**
- With `strong` declared, a conflict-resolution run carries the strong model's argv while the
  authoring run carries `default`'s.
- With only `default` declared, the resolver's argv is unchanged from today.
- The resolver's spend still folds into the authoring role's usage.

### Model tiers, part 5/8: the budget fallback switches each tier to its own free model (planned 2026-10-05 by operator; requires part 3/8 landed)

Design: plans/model-tiers.md ("Budget fallback by tier").

**Goal.** At the daily cap each seam runs on its own tier's free model, borrowing another
tier's when its own is missing, instead of every seam collapsing onto one pair. A single
`fallback` (or legacy `fallbackModel`) behaves exactly as today.

**Approach.**
1. **src/config/config-views.ts:** `resolveTierFallbacks(config, usable)` returns, per tier, the pair
   it runs on plus the tier it was borrowed `from`, or `"pause"`. A tier uses its own fallback
   when `usable(pair)`; otherwise it borrows another tier's own fallback (never a borrowed one)
   in the order small → default → strong, default → strong → small, and
   strong → default → pause, never small. An explicit `"pause"` value opts a tier out.
   `applyFallbackModel(config, resolved)` rewrites the `model` map to those pairs, so each seam
   keeps its tier; drops raw per-seam selector overrides while keeping tier-name ones; and keeps
   the `FALLBACK_REVIEW_TIMEOUT_S` floor.
2. **src/fallback-breaker.ts / src/budget-gates.ts:** `BudgetGateState.breaker` becomes a map
   keyed by pair name, `rekeyFallbackBreaker` runs per pair, and `usable(pair)` =
   `pairFree(...)` and `fallbackServing(...)`.
3. **src/budget.ts `budgetGate`:** `paused` when `default` resolves to pause, or when review is
   on and `strong` does (nothing could land); `fallback` otherwise. A role whose own tier
   resolved to pause (strong-tier roles with review off) is blocked beside the poll's
   per-role `capPaused` set (src/gate-polls.ts, filled by src/role-cap-gates.ts), and its row
   reads `budget paused`.
4. **Budget handback** (src/gate-polls.ts): the running tick's `tickPair` (src/loop.ts) is
   matched against every resolved fallback pair, not only one.

**Files touched.** src/config/config-views.ts, src/fallback-breaker.ts, src/budget-gates.ts,
src/budget.ts, src/gate-polls.ts, src/loop.ts, and their tests.

**Acceptance criteria.**
- `{ "fallback": F }` with any `model` map puts every seam on F at the cap, matching today's
  argv and events.
- With `fallback: { default: D, strong: S }`, reviewer, plan, and resolver runs carry S and
  authors carry D; without `S`, strong-tier seams carry D; without `D` but with `small: M`,
  authors carry M and strong-tier seams pause.
- With review on and strong unresolvable, the gate is `budget_paused`; with review off, only
  the plan role is held.
- A breaker-demoted pair re-resolves only the tiers using it.
- The director still keeps its paid model.

### Model tiers, part 6/8: the fleet-wide backend hold keys storms by provider (planned 2026-10-05 by operator; requires part 3/8 landed)

Design: plans/model-tiers.md ("Fleet hold per provider").

**Goal.** `fleetHold` (src/fleet-hold.ts) trips one fleet-wide hold when `HOLD_STORM_ROLES`
roles fail the same way within `HOLD_STORM_WINDOW_MS`; it assumes a single backend. Once seams
run on different providers, a 429 storm at the reviewer's provider would stop authors on a
healthy one. Hold only what the failing provider serves.

**Approach.**
1. `HoldObservation` gains `provider` (from the run's resolved config); observations count
   toward one storm only when both provider and kind match.
2. `FleetHold` holds per provider. `pollFleetHold` (src/fleet-polls.ts) keeps one hold per
   provider in `states.fleetHold` (src/gate-polls.ts), and the start pass
   (src/orchestrator-scheduling.ts) blocks a role only when its tick model's provider is held.
   A hold on the strong tier's provider while review is on still blocks every role, because
   nothing could land.
3. The `rate_limit_hold` / `rate_limit_resumed` events carry the provider.

**Files touched.** src/fleet-hold.ts, src/fleet-polls.ts, src/gate-polls.ts,
src/orchestrator-scheduling.ts, src/events.ts, src/event-format.ts, and their tests.

**Acceptance criteria.**
- Two roles failing with 429 on provider P within the window hold roles on P only; roles on Q
  keep ticking.
- With every seam on one provider, behavior is identical to today (existing fleet-hold tests
  pass unchanged).
- A storm on the reviewer's provider with review on holds the fleet.

### Model tiers, part 7/8: operator visibility — role rows, the fallback badge, and doctor checks (planned 2026-10-05 by operator; requires parts 3/8 and 5/8 landed)

Design: plans/model-tiers.md ("Observability", "Doctor").

**Goal.** An operator can see each role's tier and model, which free model each tier fell back
to, and whether every declared model can run, before the fleet finds out the hard way.

**Approach.**
1. **Role rows:** `rolePayload` (src/role-view.ts) and src/status-data.ts expose `tier` beside
   the resolved model, and both dashboards show it.
2. **`budget_fallback`** gains `tiers: { <tier>: "<selector>[ (from <tier>)]" }` beside its
   existing `provider` / `model` (the default tier's). The header badge keeps today's
   single-name text when every tier shares one pair, and lists the tiers otherwise.
3. **Doctor** (src/doctor-checks.ts): `checkFallbackModel` covers each tier's fallback. A new
   check verifies that every declared tier model resolves in pi's catalog and that its provider
   reports `ready` from `pi auth check --provider <p> --json`. When `PI_SMOL_MODEL`,
   `PI_SLOW_MODEL`, or `PI_PLAN_MODEL` is set, it notes that tumwater does not read them —
   they are oh-my-pi's, pi ignores them, and with omp as `agentBin` they reach omp through the
   inherited environment — and points at `model.small` / `model.strong`.

**Files touched.** src/role-view.ts, src/status-data.ts, src/ui/* (role rows, badge),
src/budget-gates.ts (event payload), src/event-format.ts, src/doctor-checks.ts, and their tests.

**Acceptance criteria.**
- Role rows show `strong` and its model for plan with a strong tier declared.
- A `budget_fallback` with two distinct tier pairs lists both, with `(from default)` on a
  borrowed one; with a single fallback the badge text is byte-identical to today's.
- `tumwater doctor` fails a tier model pi cannot resolve, warns on a provider that is not
  `ready`, and prints the `PI_*_MODEL` note only when one is set.

### Model tiers, part 8/8: writers emit the new form, and the docs describe tiers (planned 2026-10-05 by operator; requires parts 1/8–7/8 landed)

Design: plans/model-tiers.md ("Backward compatibility", "Notes for local fallbacks").

**Goal.** Everything tumwater writes uses the new keys, and the docs teach the one-line
single-model form first, then tiers.

**Approach.**
1. **`setConfigKey` / `parseConfigKey`** (src/config/config-write.ts) — the one writer behind both
   `tumwater config set` (src/config-commands.ts) and the GUI's config edits
   (src/gui-endpoint-commands.ts) — and `EDITABLE_CONFIG_KEYS` (src/config/config-editable-keys.ts):
   `model` takes a selector, a dotted `model.strong` merges one map entry (the way
   `roles.qa.model` already merges a role entry), and `fallback` is editable. `provider` stays
   accepted for legacy configs and is never written into a config that lacks it.
2. **Docs:** README.md (the "Backends" line), docs/backends.md (config examples, the
   local-fallback memory and `compat.thinkingTokenBudgetField` notes), docs/how-it-works.md
   (seams and tiers), docs/feature-model-fallback.md and docs/implementation-model-fallback.md
   (per-tier fallback and the borrow order).

**Files touched.** src/config/config-write.ts, src/config/config-editable-keys.ts, README.md, the four docs/
files above, and the config-write tests.

**Acceptance criteria.**
- `tumwater config set model huggingface/zai-org/GLM-5.3-Flash:together:low` writes one key;
  `tumwater config set model.strong <selector>` turns a string `model` into
  `{ default: <old>, strong: <selector> }`.
- No writer adds `provider` or `fallbackModel` to a config that does not already have them.
- The docs show the single-model form before any tier example.

## Done

### `tumwater prompt --attach <path>` — attach an image to a queued prompt from the CLI (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** The GUI composer accepts image attachments (drop/paste — `src/inbox-attachments.ts` saves them beside the queue file and appends `[image attached: <absolute path>]` lines the loop's pi agent reads), but the terminal's `tumwater prompt` cannot attach anything, so a CLI operator who wants the feature or bugfix loop to see a screenshot must run the dashboard. Close the gap: one `--attach <path>` flag, repeatable up to the existing per-prompt image cap, on the enqueue form of `tumwater prompt` only.

**Approach.**
- `src/cli-command-args.ts`, `parsePromptArgs`: scan for `--attach` occurrences (repeatable, each claiming itself and its value token like `--role`'s claim — a helper `attachClaims: number[]` beside `roleClaim`/`atClaim`); exclude claimed pairs from prompt text exactly as `roleClaim` and `atClaim` already are. Add `attachPaths: string[]` to the `enqueue` mode of the `PromptArgs` union. Mode guards mirror the existing `--at` guard verbatim: `--attach` only queues a prompt, so with `--list`, `--cancel`, or `--edit` it fails ("--attach only queues a prompt"); a missing value names the flag like `--cancel`'s does; a stray argument with `--list`/`--cancel` uses `failStrayArg` as those modes do.
- `src/prompt-commands.ts`, `cmdPrompt` enqueue path: for each path, `fs.readFileSync` it (a missing or unreadable path fails with `errorMessage`, naming the path, before anything is queued), then build one `PromptImageInput { name: path.basename(p), dataBase64: bytes.toString("base64") }` per file and pass the array through the existing `submitRolePromptAndWake` images parameter (already plumbed to `submitRolePrompt` → `submitPromptWithImages` → `savePromptImages` — no inbox changes needed). Re-run validation client-side for a clean CLI error by calling `promptImagesProblem` first and `fail`-ing its message (covers the extension list, the 5 MiB per-image cap, and the 4-image cap with the same wording the GUI answers 400 with). The queue confirmation says what landed: the existing "queued for the … loop" line plus " with N image(s)" when attachments rode along.
- `src/cli.ts` valued-flag list for prompt (`prompt: ["--role", "--file", "--at", "--cancel", "--edit"]`): add `"--attach"` so a value token is never eaten as prompt text.
- `src/help.ts` prompt stanza and the README usage-table row for steering: name the flag (`--attach <path>` may repeat, up to 4 images).
- Tests in `test/` beside the existing prompt-args and prompt-command suites: `parsePromptArgs` keeps `--attach` pairs out of the text (positional before, between, and after flags), refuses it in list/cancel/edit modes, and names a missing value; `cmdPrompt` enqueue writes the image beside the queue file with the queue file's stem, the queued text ends with the `[image attached: <absolute path>]` line, and the confirmation names the count; error cases — a nonexistent path, a non-image extension, a fifth image — all exit nonzero with `promptImagesProblem`'s or the read-error message and queue nothing.

**Files touched.** `src/cli-command-args.ts`, `src/prompt-commands.ts`, `src/cli.ts`, `src/help.ts`, `README.md`, and the prompt tests under `test/`. No changes to `src/inbox*.ts`, `src/ui/*`, or `src/operator-intent.ts`.

**Acceptance criteria.**
- `tumwater prompt "fix the layout" --role feature --attach shot.png` queues the prompt whose text ends with the image-reference line, saves `shot.png` beside the queue file, and prints the confirmation with the attachment count; the receiving role's next tick prompt carries the reference.
- `--attach` repeats up to 4; a fifth, an unsupported extension, an oversized file, and a nonexistent path each fail nonzero with the specific message and leave the queue untouched.
- `--list`, `--cancel`, and `--edit` refuse `--attach`; `--attach` pairs never leak into prompt text in any mode.
- `npm run test` passes, including the new regression tests.


### `tumwater prompt --edit <n> <text...>` — correct a queued steering prompt in place, keeping its position and deferral (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** An operator who spots a typo or a stale instruction in a prompt they queued today has
one blunt tool: `prompt --cancel <n>` and re-queue — which loses the entry's position behind
older prompts, loses the `--at` deferral (the new text carries no not-before marker), and
touches the wake marker twice. Give the edit a first-class path: rewrite one queued prompt's
text in place, keeping its queue position, its enqueue stamp (the filename is untouched), and
its not-before deferral exactly as it was.

**Approach.**
- New module `src/inbox-edit.ts`, mirroring `src/inbox-cancel.ts`: `editRolePrompt(root, role,
  position, newText)` resolves the address through `queuedRolePromptRecords` (the same listing
  `--list` prints), then writes the new content to the same queue-file path with the same
  atomic write `enqueueRolePrompt` uses (temp file + rename), so a concurrent dequeue or
  another edit can never expose a half-written file. The race policy pairs with the outcome:
  `{ status: "edited", oldText, newText }`, or `{ status: "gone" }` when the file vanished
  between listing and write — a normal race, never an error, exactly like
  `takeCancelledPrompt`.
- Deferral preservation: when the record's `notBeforeMs` is non-null, the new file content is
  `notBeforeMarker(notBeforeMs)` (from `src/prompt-not-before.ts`) followed by the new text —
  the marker is plumbing, the edit replaces only content. A non-deferred prompt stays
  marker-free even if the new text's first line resembles a marker.
- One `prompt_edited` event under the target loop, preview via `promptPreview` of the new
  text, logged only after the successful write — the same event/preview pairing
  `takeCancelledPrompt` pins, so the list surfaces and the history feed cannot disagree.
- List-wide addressing: `editListedPrompt(root, scope, position, newText)` reuses
  `cancelListedPrompt`'s candidate resolution (long-enough queues only; one candidate
  resolves, several are an `ambiguous` error with the `--role` escape hatch, none is a
  `missing` miss) — factored so the two cannot drift, e.g. a small shared
  `resolveListedQueue(root, scope, position)` helper both call.
- CLI: `src/prompt-commands.ts` gains the `--edit <n> <text...>` mode (with the optional
  `--role`), `src/cli-command-args.ts`'s PROMPT_FLAG_SPECS admits the flag (prompt's flag
  vocabulary lives there with its hand-rolled parser, not in cli-flag-specs.ts — corrected
  2026-10-04 by feature when the anchor proved wrong), and `src/help.ts` documents it next to
  the `--cancel` line: "Replace the Nth queued prompt's text in place (position, enqueue age,
  and a pending `--at` deferral are kept; as shown by --list)". Same broken-config policy as
  cancel: a load failure reports and exits non-zero without touching the queue.

**Files touched.** New `src/inbox-edit.ts`; `src/prompt-commands.ts`, `src/cli-flag-specs.ts`,
`src/help.ts`; new tests beside `test/inbox.test.ts` (a `test/inbox-edit.test.ts` or its
cases inside the existing file, following the file's local conventions).

**Acceptance criteria.**
- `tumwater prompt --role bugfix --edit 1 "new text"` rewrites the first queued bugfix prompt's
  content in place: the next `--list` shows the new text at position 1 with the original
  `queued <age> ago` stamp (the filename is unchanged), and the queue still holds exactly one
  entry.
- A deferred prompt (`prompt --at 45m`) edited in place keeps its countdown in `--list` and
  stays undeliverable until its time; the marker is not doubled or dropped.
- No-`--role` `--edit <n>` resolves by the `--list` numbering with the same ambiguity and
  missing handling as `--cancel <n>` (identical error wording modulo the verb).
- A prompt that is dequeued between listing and write reports `gone` and exits clean.
- One `prompt_edited` event appears in the event feed per successful edit, none on failures.
- `tumwater help prompt` documents `--edit`; `npm run test` passes with the new cases green.


### `tumwater retire --role <id>` — remove a disabled loop's worktree and branch (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** When a role is disabled or removed from `tumwater.json`, its persistent git worktree
(`.tumwater/worktrees/<role>/`) and its branch (`tumwater/<role>`) stay behind forever — disk
the project never reclaims, and stale branches that `git branch` listings and `tumwater diff`
scans keep tripping over. `tumwater doctor` reports orphan processes but nothing offers a way
to clean up a retired loop's workspace. Give the operator one command that does it safely.

**Approach.**
- New module `src/retire.ts` with `collectRetire(root, role)` returning what exists today
  (worktree present? branch present? `aheadOfMain` count, dirty flag, enabled-in-config flag)
  and `retireRole(root, role, { force })` performing the removal. Reuse the existing pieces:
  `worktreePath`/`branchName` from `src/paths.ts`, `aheadOfMain`/`isDirty`/`deleteRef` from
  `src/git.ts`, and a new `removeWorktree(root, role)` in `src/worktree.ts` that unlocks the
  worktree's `locked` file (see `ensureWorktree`'s comment on the `locked` race) before
  `git worktree remove --force`, falling back to `git worktree prune` for a dead registration —
  the same recovery `isUsableWorktree` already classifies.
- Safety rails, each refusing with a one-line reason the operator can override with `--force`:
  the role must not be enabled in config (disable it first); the branch must have no unlanded
  commits (`aheadOfMain` against main) and no uncommitted worktree edits; the loop must not be
  mid-tick. On success also delete the per-role landing ref `refs/tumwater/landing/<role>`
  (`landingRefName`) when present, and drop the role's paused-state marker if any.
- CLI: `tumwater retire --role <id> [--force]` in `src/cli.ts`/`src/cli-args.ts` (follow the
  `abort --role` vocabulary), a `--json` payload `{role, removed: [worktree, branch, landingRef...],
  skipped: []}`, a help entry in `src/help.ts`, and a `tumwater help retire` shape test in the
  style of `test/command-shape.test.ts`. Doctor stays read-only — out of scope.

**Files touched.** `src/retire.ts` (new), `src/worktree.ts`, `src/cli.ts`, `src/cli-args.ts`,
`src/help.ts`, `test/retire.test.ts` (new), `test/cli-operators.test.ts` (command-shape rows).

**Acceptance criteria.**
- On a fixture repo with a role worktree and branch: `retire --role <id>` removes the directory
  (no registration left, verified by `git worktree list`), the branch, and the landing ref, and
  prints one line per removed artifact; `--json` mirrors them.
- Retiring an enabled role, a role with unlanded commits, or a dirty worktree refuses without
  removing anything; `--force` goes through; a second `retire` on the same role reports that
  nothing remained (idempotent, not an error).
- The whole suite passes (`npm run test`).

Implementation notes: `collectRetire` counts a landing ref pinning a sha not merged into main as
unlanded work too (the branch can sit at main while the pin holds the crash survivor), the
branch deletion always runs after a `removeWorktree` that prunes even an absent directory (a
stale registration keeps the branch checked out, so `git branch -D` would otherwise fail), and
the paused-state marker is only reported removed when the role was actually listed in it.

### A shared test-fake catalog — the infrastructure that retires the recurring `no-fake` validation gap (planned 2026-10-04 by steward, promoted from the gap tally, done 2026-10-04 by feature)

**Goal.** 33 retained Fixed entries in BUGS.md carry the validation gap `no-fake` — the fix could not
be confirmed until a fake or shim that did not exist was written, one entry at a time. Each such fix
hand-rolls a private fake into its own test file, so the next entry needing the same fake pays the
cost again. A small shared catalog of fakes under `test/fakes/` (the fake-pi-on-PATH shim's home)
makes the common shapes reusable, retiring the most recurring gap class in the file.

Representative entries carrying the tag (of the 33, found by reading each Fixed entry's
`**Validation gap:**` line as of 2026-10-04):
"A SUMMARY follow-up turn bypasses the loop's shared transient retry" — needed a transient-failure
fake for a follow-up pi run; "A provider `Request timed out.` fails a tick that has already spent
hours of authoring with no retry" — same shape, backend-level; "A build check that spans a host
sleep but finishes inside its deadline reads as a real red" — needed a clock/sleep fake;
"The harness tells every loop to pipe its verification through `tail`, and the tool-call stall
watchdog then files a false stall" — needed a slow-output fake; "A real supervisor that dies
without forwarding its signal" and "The doctor CLI tests in test/doctor.test.ts assert exit 0
against the host's REAL process table" — needed a process-table fake; "HTTP 429 is not a transient
failure class" — needed a rate-limit-responding fake endpoint.

**Approach.**
- New directory `test/fakes/` with one module per fake family, each exporting a factory the
  existing tests can adopt incrementally (no big-bang rewrite of passing tests):
  - `time.ts` — injectable clock and sleep for deadline/window logic (host-sleep, watchdog,
    min-gap cases), mirroring how `todayStamp` is already injectable in prompt building.
  - `transient.ts` — a `runPi`/HTTP stub that fails N times with a chosen class (429, timeout,
    5xx) then succeeds, so retry-policy tests stop hand-rolling failure sequences.
  - `process.ts` — a fake process table for supervisor/orphan/sweep tests, replacing assertions
    that read the host's real process list.
  - `log.ts` — an event-log fixture builder that writes well-formed `tick_end`/`review_verdict`/
    `build_check` events to a scratch repo's `.tumwater/log/events.jsonl`, the shape several
    digest and history fixes had to improvise.
- Keep the existing fake-pi-on-PATH shim as the top-level mechanism; these fakes compose with it
  (the shim stays the pi boundary, the catalog fakes the world around it).
- Zero runtime dependencies: the fakes use node built-ins only, like the rest of the suite.

**Files touched.** `test/fakes/` (new: `time.ts`, `transient.ts`, `process.ts`, `log.ts`), plus
adopting them in the test files of one or two of the cited entries as the pattern demonstration;
suite-wide adoption is not part of this plan.

**Acceptance criteria.**
- Each fake module is used by at least one test that previously hand-rolled the equivalent
  (cite the migrated test in the PR/commit body).
- A fixed-but-recurring shape (transient retry) is covered by one test written against the fake
  alone, with no real process, network, or clock involvement.
- `npm run test` stays green, and the fake modules are plain node built-ins with no new
  dependencies in package.json.

**Done note (2026-10-04, feature).** All four modules shipped, plus `test/fakes-catalog.test.ts`,
which pins each fake's contract with no real process, network, model, or clock. Migrations: the
`transient.ts` and `time.ts` fakes replaced the hand-rolled failure sequences and sleep collector
in test/loop-transient-retry.test.ts's two regression tests; the `log.ts` builders replaced
cli-history.test.ts's local `endEvent`/`startEvent` fixtures; the `process.ts` fake is doctor-
fixtures.ts's `fakeProbe`/`noProcesses`, moved to the catalog and re-exported (test/doctor-
orphans.test.ts, test/doctor.test.ts unchanged importers).


### `tumwater bug "<symptom>"` and `tumwater plan "<title>" [body...]` — operator-authored backlog entries from the CLI (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** Today an operator who spots a bug or wants a feature planned must edit BUGS.md or PLANS.md
by hand — `prompt` queues text and `questions` reads/answers its outbox, but neither writes the
backlog the loops actually work from. Give the operator a first-class way to file a bug and request a
plan, stamped and formatted the way loops write those entries, and wake the loop that should act.

**Approach.**
- New module `src/backlog-write.ts` (write half, mirroring the read half in `src/backlog.ts` and the
  scan/stamp/move pattern of `src/question-commands.ts`):
  - `fileBug(root, text)` — append one `### <symptom>` entry under BUGS.md's `## Open` (creating the
    file with the `# Bugs` header + `## Open` scaffolding when absent, as `tumwater init` seeds it),
    stamped `(reported by the operator YYYY-MM-DD)` using `datetime.ts`'s local-date helpers; entries
    are appended after the last existing Open entry, before `## Fixed`, using `backlog-md.ts`'s
    `fenceTracker()` so fenced blocks are never mistaken for the section boundary.
  - `filePlan(root, title, body)` — same for PLANS.md's `## Planned`, entry `### <title>` with the
    body as the entry text and the same operator stamp. No goal/approach/acceptance-criteria
    scaffolding is invented: the feature loop's plan-refinement pass (its standing prompt already
    anchors plans on files and symbols) fleshes the stub out on pickup.
  - `sayFiled(command, fileName, title, json)` renders confirmation lines; both commands take
    `--json` and print the `{file, title, stamp}` payload as data, matching the other CLI commands'
    `sayJsonOrRender` shape (src/cli-output.ts).
- Wire both into `src/cli.ts`'s switch as plain `case` arms with positional-only args
  (`bug` takes exactly one rest-joined sentence; `plan` takes a title plus optional body words),
  gated by the existing `requireReadyRepo` path the other backlog commands use, and after a
  successful write wake the matching loop via the prompt-queue's role enqueue + wake used by
  `prompt --role` (`src/prompt-commands.ts`'s `enqueueRolePrompt`/wake pair): a filed bug wakes
  `bugfix`, a filed plan wakes `feature`. If a matching paused state exists the wake simply waits,
  like `prompt --role` already does — no new pause logic.
- Add one `tumwater bug ...` and one `tumwater plan ...` stanza to `src/help.ts`'s `HELP` literal
  (topics derive automatically via `helpStanzas`), and document both in README.md's steering row of
  the command table.

**Files touched.** `src/backlog-write.ts` (new), `src/cli.ts`, `src/help.ts`, `README.md`,
new `test/backlog-write.test.ts`, plus the help-topics pin and CLI smoke tests where the existing
command tests live (`test/cli.test.ts` — extend, don't duplicate).

**Acceptance criteria.**
- `tumwater bug "the config parser rejects empty values"` on a repo with BUGS.md open-appends a
  fenced-safe `### ...` entry stamped with today's operator-reported date, wakes the bugfix loop,
  and prints a confirmation (the JSON variant prints `{file, title, stamp}`); BUGS.md's Open section
  shows the entry and `tumwater backlog` lists it.
- `tumwater plan "Add an export command" keep it JSON first` open-appends the equivalent entry to
  PLANS.md and wakes the feature loop.
- On a repo missing BUGS.md/PLANS.md the command seeds the file rather than failing; a malformed or
  empty text argument fails with a usage line and writes nothing.
- The help topics pin (`tumwater help bug`, `tumwater help plan`) resolve to the new stanzas, and
  `npm run test` stays green.

**As landed (2026-10-04 by feature).** All of the above, with two wording details: the stamp is
`reported by the operator <date>` (the heading parenthesizes it, matching the loops' `(planned …)`
shape), and in `--json` mode stdout is the `{file, title, stamp}` payload alone while the wake
still fires (the `prompt --json` precedent — no prose line rides the payload document). Tests live
in `test/backlog-write.test.ts` (in-process placement/seed/fence tests plus spawned CLI smoke
tests); `test/cli.test.ts` was left untouched.


### `tumwater tick <role> --last` — the newest tick's trail without knowing its number (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** `tumwater tick <role> <n>` answers "what did tick #7 do?" — but the operator's actual question after an incident is "what did the latest tick do?", and getting there today means running `history --role <id>` first to learn the number, then `tick <role> <n>`. Add a `--last` form: `tumwater tick <role> --last` resolves the role's newest completed tick in the scanned window and prints its trail exactly as `tick <role> <n>` would, sharing every rendering path. `--last` and a numeric `<n>` are rivals: `tick <role> --last 3` and `tick <role> 3 --last` fail with the usage.

**Approach.** Small wiring on top of existing machinery; no collector changes.

- `src/cli-flag-specs.ts` — add `export const LAST_FLAG: FlagSpec = { names: ["--last"] }` beside `JSON_FLAG`.
- `src/cli.ts` dispatcher `case "tick"` — admit `LAST_FLAG` in the `rejectUnknownArgs("tick", rest, [...])` call, and relax the pre-gate arity check from `positionals.length !== 2` to `positionals.length < 1 || positionals.length > 2` so the one-positional `--last` form reaches `cmdTick` (which already owns arity and keeps its own guard — the dispatcher comment says as much).
- `src/tick-detail.ts` `cmdTick` — take the extra flag (extend the signature to `(root, positionals, json, last)`, passing `rest.includes("--last")` from cli.ts). Arity rules: `last` accepts exactly one positional (`<role>`); the numeric path keeps exactly two. With `last`, resolve the newest tick via `readTickRows(root, 1, role)` from `src/history-data.ts` — rows come newest-first, so the first row's `tick` is the number; an empty array takes the existing not-found path (`sayJson(null)` / `tickNotFoundMessage(role, 0)` is wrong under `--last`, so make the not-found wording for this form say `no completed tick for <role> in the scanned window…` — extend `tickNotFoundMessage` or add a sibling `tickNotFoundLastMessage` and keep both used by the GUI's 404 wording where applicable; pick one shape and use it consistently). The resolved number then flows through the unchanged `readTickDetail` → `renderTickDetail` / `sayJson(detail)` tail — no rendering changes at all.
- `TICK_USAGE` becomes `"tumwater tick <role> [<n>] [--last] [--json]"` — it is the single string the dispatcher gate and `cmdTick`'s guards both fail with, so all three sites move together.
- `src/help.ts` — update the `tick` stanza's usage line and add one sentence: `--last` shows the newest completed tick's trail instead of numbering it.
- `README.md` — extend the per-tick-history row's `tumwater tick <role> <n>` mention with the `--last` spelling, phrased like the surrounding flags.

**Files touched:** `src/cli-flag-specs.ts`, `src/cli.ts`, `src/tick-detail.ts`, `src/help.ts`, `README.md`, plus tests in `test/tick-detail.test.ts` (`--last` resolves the newest tick's trail identical to naming that number; `--last` on an empty log exits 0 with the parseable `null` under `--json` and the last-form not-found line otherwise; `tick <role> --last 3` fails with the usage; `--last` with an unknown role keeps the unknown-role wording) and `test/cli-arg-strictness.test.ts` (the dispatcher admits `--last` for `tick` and still rejects it elsewhere).

**Acceptance criteria:**
- After a tick has run, `tumwater tick <role> --last` prints the same trail `tumwater tick <role> <n>` prints for the newest tick number (the tests assert this equality on a fixture log).
- On a log with no ticks for the role, both renderings exit 0 and `--json` prints `null` (the command's documented JSON-in-every-exit-0 contract).
- `--last` combined with a numeric `<n>`, a missing role, or an unknown role fails with the usage or the unknown-role wording before any read.
- Plain `tick <role> <n>` behavior is byte-unchanged, and `npm run test` passes.


### `tumwater run --for <duration>` — a bounded fleet run that drains and exits at the deadline (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** `tumwater run --once` gives a single round of ticks and exits — the cron-style invocation. An operator who wants the fleet to run for a bounded *window* (an overnight trial, a demo, a CI step, "run for two hours then stop") has to background the process and kill it by hand, which loses the graceful drain. Add `tumwater run --for <duration>` (e.g. `run --for 2h`): boot the fleet, run it until the deadline, then run the same graceful stop a Ctrl+C would run — in-flight ticks finish, the loop drains, a summary line prints — and exit.

**Approach.** Everything hangs off machinery that already exists; no orchestrator changes.

- `src/cli-flag-specs.ts` — add `{ names: ["--for"], value: true, valueName: "<duration>", validate: (v) => parseDurationFlag("--for", v) }` to `RUN_FLAG_SPECS`, so the dispatcher's `rejectUnknownArgs` gate accepts the spelling and rejects a malformed value with the parser's own wording before the ready-repo gate.
- `src/cli-run.ts` `cmdRun` — parse `--for` with `parseDurationFlag` (the same helper the gate ran). Two body-level rules, both fail fast before boot: `--for` and `--once` are rivals (a one-round run and a windowed run cannot both apply — fail with a message naming both flags), and the cap is `pause --for`'s (`PAUSE_FOR_MAX_MS`, via the `failOverDurationCap` helper in operator-commands.ts — import it or move the shared helper; pick one site and keep the wording identical). Where `--once` sets `once = true`, a `--for` run stays a daemon-shaped run: keep `createRedeployer` and `LaunchServicesWatch` exactly as they are — a mid-run self-redeploy hands off to the supervisor, which forwards the same args (including `--for`), so the deadline restarts in the new generation; state that in the command's doc comment rather than coding around it.
- After the boot banner, when a deadline was given: `setTimeout(forMs, stop)` armed beside the existing `SIGINT`/`SIGTERM` handlers (the same `stop` closure, so the drain-and-exit path is literally identical), plus `clearTimeout` in the existing `finally` so an early Ctrl+C or a redeploy hand-off does not leave a stray timer. The boot banner says the window: `tumwater running on branch <name> · for 2h · build <sha>… — Ctrl+C to stop`. When the timer fires first, say a one-line `deadline reached — stopping` before the existing stop message so the log shows why.
- Summary: a `--for` run prints the `onceSummary` line on exit (reuse the existing function; it already supports being called without settle reasons, deriving from `ticksBefore` deltas), so a scheduled invocation's log shows what the window accomplished. `--once` keeps its own settle-reason summary; the two stay separate call sites.
- `src/help.ts` — extend the `run` usage line to `[--branch <name>] [--once] [--for <duration>] [--role <id>]` with a one-line explanation (windowed run, drains like Ctrl+C at the deadline; `--role` stays once-only).
- `README.md` — one row/note in the usage table for `run --for <duration>`, phrased like the `--once` sibling.

**Files touched:** `src/cli-flag-specs.ts`, `src/cli-run.ts`, `src/help.ts`, `README.md`, plus tests in `test/cli-run.test.ts` (flag parsing: `--for` accepted, `--for abc` rejected with the duration wording, `--for` + `--once` rival rule, over-cap rejection, `--for` without a value named by the gate) and `test/cli-run-live.test.ts` (one harness run with a short `--for` boots, stops itself at the deadline, drains, and prints the summary line — no real model; the fake pi shim stays on PATH).

**Acceptance criteria:**
- `tumwater run --for 45m` boots the fleet, and without any operator input stops, drains in-flight ticks, prints the deadline line and the summary, and exits 0.
- `run --once --for 5m` fails before boot naming both flags; `run --for 200d` fails with the cap wording; `run --for abc` and a trailing bare `--for` fail with the parser's wording before any repo gate.
- Ctrl+C during a `--for` run still works and cancels the pending timer; the graceful-stop path is the same code either way.
- `npm run test` passes with the new tests added and no existing behavior changed for plain `run` and `run --once`.

### Dotted per-role config keys: `config get/set maxDailyCostUsdPerRole.<role>` and `roles.<id>.<field>` (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** `tumwater config set` writes whole top-level keys only (src/config/config-write.ts
`setConfigKey`): the per-role maps (`maxDailyCostUsdPerRole`, `quietHoursPerRole`) and the
`roles` section must be replaced wholesale, so `config set maxDailyCostUsdPerRole
'{"feature":1.5}'` silently drops every other role's entry and `roles.<id>` edits require
re-typing the whole entry. The per-role knobs landed 2026-10-04 are exactly the ones an
operator steers one role at a time — raising `feature`'s cap should not require knowing
qa's. Add dotted keys: `<map>.<role>` for the two per-role maps and `roles.<id>.<field>`
for role entries, each MERGING one entry into the existing map/section; bare keys keep
today's whole-key behavior.

**Approach.**
- `src/config/config-write.ts`: a `DOTTED_MAP_KEYS` table `{ maxDailyCostUsdPerRole: number,
  quietHoursPerRole: string }` and a dotted-key parser `parseConfigKey(key)` →
  `{ kind: "map", map, role } | { kind: "role", id, field } | { kind: "top", key } | { error }`.
  - Map write: fresh load → spread the existing map (or `{}`) with the new entry →
    validateConfig (its `checkKnownRoleId` and `checkNumberField`/quiet-hours checks over the
    merged map stay the single source of type and role-id truth) → atomic write. The dollar
    cap pre-check reuses `checkDailyBudgetUsd`; the quiet-hours value reuses
    `PER_KEY_VALIDATORS`' `checkQuietHours`.
  - `roles.<id>.<field>`: spread the existing entry, set `field` (must be in
    `ROLE_ENTRY_KEYS` — a `setConfigKey`-style did-you-mean via `suggestClosest` otherwise),
    then the same validate → write idiom. `<id>` naming an unknown role fails with
    validateConfig's known-roles message when validation runs; the parser only checks shape.
  - `unknownConfigKeyError` keeps top-level membership for bare keys unchanged.
- `src/config-commands.ts` `cmdConfig`: `config get maxDailyCostUsdPerRole.feature` reads
  the resolved config and prints `config.maxDailyCostUsdPerRole?.["feature"] ?? null` — the
  same absent-key→null rule the whole-key get applies. The get path needs no new module:
  split the dotted key in place and index.
- `src/help.ts` CONFIG area and README.md's audit/`config` mention: one clause — "dotted
  keys (`maxDailyCostUsdPerRole.feature 1.5`, `roles.qa.model x`) merge one entry; bare
  keys replace the whole value".

**Files touched:** src/config/config-write.ts, src/config-commands.ts, src/help.ts, README.md,
plus tests.

**Acceptance criteria.**
- `config set maxDailyCostUsdPerRole.feature 1.5` leaves qa's existing entry byte-identical
  in the file and sets feature's to 1.5; `config get maxDailyCostUsdPerRole.feature` prints
  `1.5`, and an unset role prints `null`.
- `config set quietHoursPerRole.qa "23:00-07:00"` merges into the existing per-role map;
  an invalid window fails with `checkQuietHours`'s message and the file is untouched.
- `config set roles.qa.model x` merges into qa's existing entry (other fields preserved);
  `config set roles.qa.colour x` fails naming `ROLE_ENTRY_KEYS`' nearest match; a typo'd
  role id fails with validateConfig's known-roles message.
- Bare-key behavior (whole-value replace, unknown-key error, absent-key `null` get) is
  unchanged — covered by the tests already in test/config-write.test.ts and
  test/config-commands.test.ts, which must keep passing.
- New tests beside them cover: merge-not-replace for both maps and a role entry, dotted get
  hit/miss/null, and the three failure shapes (bad value, bad field, bad role id).
  `npm run test` passes.

### `tumwater wake --in <duration>` — schedule a wake that arrives later, the scheduled sibling of `pause --for` (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** `tumwater wake` clears backoff the moment it runs, but an operator often knows the
world changes LATER — a cron finishes at 02:00, a CI run ends in 40 minutes, a dependency
update lands after midnight. Today the only scheduled lever is a queued prompt (`prompt --at`,
which deliberately wakes the target loop when it delivers), but that burns a model run whose
text must be invented; the operator wants the plain "try again at T" demand. Add
`--in <duration>` to `wake`: the marker is written now but consumed no earlier than
`now + duration`, exactly mirroring `pause --for`'s auto-resume and `prompt --at`'s
deferred-delivery marker. Without `--in`, behavior is identical to today. No new marker file,
no new consumer loop — the existing wake request path grows one optional field and one gate.

**Approach.**
- `src/cli-flag-specs.ts`: add `WAKE_IN_FLAG` (`names: ["--in"]`, `value: true`,
  `valueName: "<duration>"`, validate: `parseDurationFlag("--in", value)`) beside
  `DURATION_FLAG`, so the gate names a typo'd value before the ready-repo gate — same shape
  as the `--for` spec.
- `src/cli.ts` `runMarkerCommand`: the accepted-flag list becomes
  `command === "pause" ? [ROLE_FLAG, DURATION_FLAG, REASON_FLAG] : command === "wake" ?
  [ROLE_FLAG, WAKE_IN_FLAG] : [ROLE_FLAG]`, so a stray `--in` on pause/reset-counters still
  fails fast. Update the comment naming the per-command vocabularies.
- `src/operator-commands.ts` `cmdWake`: when `flagValue(args, "--in")` is non-null, parse it
  with `parseDurationFlag("--in", ...)` (the failOverDurationCap idiom in cli-args.ts applies —
  the same ceiling `pause --for` honors), compute `dueMs = Date.now() + ms` at submit (the
  deferral starts when the operator typed it — the decision `prompt --at`'s comment records),
  and pass it through.
- `src/operator-intent.ts` `requestWake`: add an optional trailing `notBeforeMs?: number`
  parameter — the absolute ms-epoch deadline. When it is still ahead the wake is SCHEDULED:
  ONLY the marker is written (`{ at, roles, notBeforeMs }`; `{ at, roles }` stays the absent
  case, so older markers keep parsing) and the backoff-clearing state change is SKIPPED — it
  belongs to the deadline, not the submit, so a fleet stopped at submit (or restarted before
  the deadline) does not wake early; `consumeWakeRequest` applies it when it consumes the
  marker at or after the deadline. At-or-past deadlines read as immediate. The confirmation
  gains `wake scheduled for <roles> — wakes in ${durationLabel(ms)} — …` on the deferred path,
  reusing the phrasing `prompt --at`'s confirmation uses.
- `src/operator-requests.ts` `consumeWakeRequest`: before the `roleRequestTargets` read, if
  the marker carries a numeric `notBeforeMs` greater than `Date.now()`, return WITHOUT removing
  the marker — a later poll retries it; the wake lands within one poll cycle after the
  deadline, the same delivery granularity `prompt --at`'s consumer gives. At or past the
  deadline the existing consume path runs, and its `wake()` call is what clears the schedules
  the submit skipped. A non-numeric value reads as immediate (defensive; validation happens at
  the CLI).
- `src/help.ts` and README.md's control-table `wake` row: append `--in <duration>` to the wake
  usage with a one-clause scheduled-wake phrase, beside `pause --for`.

**Files touched:** src/cli-flag-specs.ts, src/cli.ts, src/operator-commands.ts,
src/operator-intent.ts, src/operator-requests.ts, src/help.ts, README.md, plus tests.

**Acceptance criteria.**
- `tumwater wake --in 45m` writes a wake marker whose `notBeforeMs` is ~45 minutes out; a poll
  run before the deadline leaves the marker in place and wakes nothing; a poll after it wakes
  exactly the marker's roles and removes it.
- `tumwater wake --role qa --in 2h` targets only qa; without `--in` every existing wake
  behavior (all-roles default, immediate consume, marker shape) is unchanged.
- `--in` on any other marker command, a malformed duration (`--in xyz`), and a missing value
  each fail fast at the CLI gate with a message naming the flag.
- Tests cover the consume-gate (before/at/after the deadline: marker preserved, then
  consumed), `requestWake`'s marker field, `cmdWake`'s flag parsing, and the strict-args gate
  for the new flag — in test/operator-requests.test.ts, test/operator-intent.test.ts, and
  test/cli-operators.test.ts beside the wake cases already there. `npm run test` passes.

### Per-role quiet hours: `quietHoursPerRole`, the scheduled sibling of `maxDailyCostUsdPerRole` (planned 2026-10-04 by plan loop, done 2026-10-04 by feature)

**Goal.** The fleet-wide `quietHours` window silences every role at once, but the operator's
real schedule is per-role: run the cheap roles around the clock and hold the expensive ones
during working hours (or let one noisy role sleep while the rest of the fleet works overnight).
Add a top-level `quietHoursPerRole?: Record<string, string>` config key, keyed by role id,
mirroring `maxDailyCostUsdPerRole`: a loop whose own window is active starts no new ticks until
its window ends or a live edit removes it; in-flight ticks finish; the director is exempt, as
under every autonomous gate; an absent key or an empty-string window means off for that role.
The fleet-wide `quietHours` keeps working unchanged — a role is held when EITHER window covers
`now`.

**Approach.**
- `src/quiet-hours.ts`: reuse the existing parser — `parseQuietHours` already validates one
  `"HH:MM-HH:MM"` value (wrapping windows included) and `inQuietHours(window, date)` decides
  membership. Add one small helper, `roleQuietHold(perRole: Record<string, string> | undefined,
  role: string, now: Date): boolean`, that parses the role's value and returns membership
  (an absent key, a non-string, or an unparseable value reads as off here; validation is
  config-validation.ts's job, not this helper's).
- `src/gate-polls.ts`: `pollAllGates` computes a stateless per-role hold set — for each runner
  but the director, `roleQuietHold(liveConfig.quietHoursPerRole, role, new Date(now))` — and
  returns it as `roleQuietHold: ReadonlySet<string>` beside `capPaused`. No new event type and
  no state: unlike the fleet-wide gate (which logs exactly one
  `quiet_hours_started`/`quiet_hours_ended` per crossing), a per-role hold is an anonymous,
  stateless verdict recomputed per poll, exactly like `capPaused`'s set (the pause marker is
  anonymous and must never masquerade as an operator's).
- `src/orchestrator.ts`: where the scheduling pass folds `quietNow` into the no-new-tick hold
  (the `(userPaused || quietNow || ...)` condition), add the role's membership in
  `roleQuietHold` as a fourth disjunct, director-excluded by the same existing role check.
- `src/config/config-schema.ts`: add `quietHoursPerRole?: Record<string, string>` to the config
  interface (next to `maxDailyCostUsdPerRole`, with the same doc-comment shape) and to
  `TOP_LEVEL_KEYS`.
- `src/config/config-validation.ts`: beside the `maxDailyCostUsdPerRole` block, validate the map —
  object of strings; every key passes the same `checkKnownRoleId` gate (a typo'd role id would
  silently no-op the window); every value passes `checkQuietHours`'s parse (empty string
  allowed = off).
- `src/config/config-example.ts` / `src/help.ts` / README.md settings paragraph: name the new key one
  line after its fleet-wide sibling, so `tumwater config` users can find it.
- Status surface: follow status-data.ts's `roleCapPaused` pattern minimally — a loop held by
  its own window shows the same quiet-hours hold wording the fleet-wide gate already uses; if
  status-data.ts cannot distinguish the cause without new plumbing, note that in the plan's
  Done entry rather than growing the change.

**Files touched:** src/quiet-hours.ts, src/gate-polls.ts, src/orchestrator.ts,
src/config/config-schema.ts, src/config/config-validation.ts, src/config/config-example.ts, src/help.ts,
README.md, plus tests (quiet-hours and config-validation suites).

**Acceptance criteria.**
- A config with `quietHoursPerRole: { qa: "23:00-07:00" }` holds qa's new ticks inside the
  window (wrapping included) while other roles tick normally; the director is never held by it.
- A role held by its own window AND the fleet window is held once, not double-counted.
- A live `config set quietHoursPerRole` edit applies on the next poll cycle, like the
  fleet-wide window and the per-role caps.
- Validation rejects: a non-object, an unknown role id, and a malformed window string, each
  with a message naming the key and the offending id/value.
- Tests cover the helper (in/out/absent-key/wrapping), the validation cases, and a gate-polls
  test asserting the hold set. `npm run test` passes.

_Note on the status surface: the plan's "same quiet-hours hold wording" is delivered — status-data.ts computes `roleQuietPaused` (role → window, director exempt) with the new roleQuietHold helper, and status-model.ts's loopPhase renders the fleet badge's own `quiet until <end>` wording scoped to the loop's window, carried to the GUI payload through status-payload.ts. `src/config/config-example.ts` holds no key catalog (it seeds from the tracked tumwater.example.json, which sets no quietHours), so it needed no change; help.ts and the README settings paragraph name the new key beside its fleet-wide sibling._

- `tumwater prompt --at <duration>` — queue a steering prompt that stays hidden until its time arrives (planned 2026-10-04, done 2026-10-04; commit 654f15b3)
- `tumwater questions` — read and answer the open-question outbox from the CLI (planned 2026-10-04, done 2026-10-04; commit 7cf0c37a)
- `tumwater init --template` — seeded project templates so a fresh fleet starts with signal (planned 2026-10-04, done 2026-10-04; commit a412d97d)
- The TUI's Ctrl+D quits like shell EOF and Ctrl+C interrupts the director's in-flight tick (planned 2026-10-04, done 2026-10-04; commit 4da5e4df)
- `tumwater prompt --file <path>` — queue a steering prompt from a file or stdin (planned 2026-10-03, done 2026-10-03; commit e6b8850d)
- The dashboard's Settings view: view and edit the curated top-level config keys live (planned 2026-10-02, done 2026-10-02; commit b03d653b)
- The TUI moves to ink, part 3/3: retire the hand-rolled renderer remnants and correct the docs (planned 2026-10-01, done 2026-10-02; commit 75c42c9a)
- The TUI moves to ink, part 2b/3: key handling moves to ink's `useInput` (planned 2026-10-01, done 2026-10-02; commit 4576a0c3)
- The TUI moves to ink, part 2a/3: extract the key handler from `runTui` into a framework-free module (planned 2026-10-01, done 2026-10-02; commit 5511dafd)
