# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

### Prioritize loops by need — defer unneeded maintenance ticks and order work roles first (planned 2026-09-08, requested by user)

**Goal.** Today every enabled loop ticks on its own clock regardless of whether there is anything for it to react to: after a quiet stretch in which no feature or bugfix landed, the maintenance roles (readme, organize, coverage, clean, dry, perf, qa, improve, steward) keep burning model runs re-deriving "nothing to do", and when `maxConcurrent` slots are contended they can claim them ahead of loops that actually ship work. Make scheduling need-aware with two mechanisms: (1) a maintenance role's due tick is **deferred** while no feature/bugfix/human commit has landed on main since its last tick AND its own last tick did nothing; (2) slot allocation in `fairOrder` orders the work roles (**feature, bugfix, plan**) ahead of every maintenance role. The user's words: "if no feature or bugfix work has landed since the last tick, and the last tick had nothing to do, the readme, organize, coverage, clean, dry, perf, qa, improve, and steward roles probably don't need to run at all; we could instead prioritize the feature, bugfix, and plan roles."

**Design (decided, with rationale).**
- **Two tiers plus exemptions.** Work tier: `feature`, `bugfix`, `plan` — never deferred, always scheduled ahead of maintenance in slot allocation. Maintenance tier (deferrable): exactly the nine built-ins named above. The director is exempt from both mechanisms (unchanged). Unknown/custom roles (the planned user-defined loops) are **never deferred** — the harness cannot judge what an arbitrary custom role needs — but they sort into the maintenance tier for `fairOrder` (they never outrank work).
- **"Work landed" definition.** A commit on main whose subject starts with `tumwater(feature):` or `tumwater(bugfix):`, **plus any commit whose subject does not start with `tumwater(` at all** (a human commit — the world changed in a way the fleet cannot generate itself). Commits from every other tumwater role do NOT count: plan/readme/steward land markdown, and organize/clean/dry/coverage/perf/qa/improve land hygiene — none of those give a maintenance role new work to react to. Waking them on their own kind of landing is exactly the cascade this feature removes (a readme commit today wakes every sleeping loop via "main moved"). The subject prefix `tumwater(<role>):` is stamped by the harness itself (`buildCommitMessage` in src/commit-message.ts), so attribution needs no new metadata.
- **Deferral rule.** A maintenance role's due tick — eligibility reason `"scheduled"` or `"main moved"` — is skipped when ALL of: its `lastResult === "no_change"`; its `lastMainHead` is non-empty (it has seen main before); and no work landed in `(lastMainHead, main]`. Only `no_change` defers: every other outcome carries pending business (retry an error, address recorded review-rejection reasons, recover a merge failure) that must not stall until unrelated work lands. A never-ticked role (`ticks === 0`, empty `lastMainHead`) always runs its first tick — the fleet still gets one baseline pass per role at startup. `resume` wakes (interrupted-tick recovery) are never deferred; they precede this check in `isEligible`. When the git range cannot be evaluated (unknown head, error), treat it as work landed — conservative: run the tick.
- **Deferral mechanics.** A deferred role's `nextRunAt` is left untouched: it stays due and re-checks every poll (~2 s) until a qualifying commit lands, then starts within one poll. The per-head git check is cached in an in-memory `Map<sinceHead, boolean>` owned by the orchestrator (a head's verdict never changes — main only moves forward via fast-forward merges), cleared when it exceeds 200 entries so a long-running fleet cannot grow it unbounded. No new tumwater.json knob: one opinionated policy, per the principles.
- **Observability.** One `tick_deferred` event (loop = role) per deferral episode — logged on the transition into deferred-due state, tracked with a per-role boolean like the existing `prevBudgetPaused`/`prevUserPaused` bookkeeping; no event when the episode ends (the tick's own events cover it). New union member in `HarnessEvent["type"]` plus one formatting case in src/ui/event-format.ts (`<time> <loop> deferred — no work landed since last tick`), so logs/TUI/GUI show why a loop is quiet.
- **fairOrder.** Director first (unchanged); then tier 0 before tier 1; within a tier, least-recently-ticked first (the existing LRU tie-break). So with `maxConcurrent: 2`, a just-finished feature and an overdue steward compete for one slot — feature takes it.

**Approach.**
- src/roles.ts — pure data module, no imports (fits its contract): add `export const WORK_ROLES: ReadonlySet<string>` (`feature`, `bugfix`, `plan`), `export function roleTier(role: string): number` (0 for work roles, 1 for everything else; director excluded by callers), and `export const DEFERRABLE_ROLES: ReadonlySet<string>` (the nine maintenance ids). Comment each with the rationale above.
- src/git.ts — add `export async function subjectsBetween(root: string, sinceHead: string, mainBranch: string): Promise<string[] | null>`: one `gitTry(root, "log", "--format=%s", `${sinceHead}..${mainBranch}`)`, split on newlines, drop empties; `null` when gitTry fails (unknown head / not a repo) so callers fall back conservatively.
- src/orchestrator.ts — three additions: (a) `export function workLanded(subjects: string[]): boolean` — true iff some subject matches `/^tumwater\((feature|bugfix)\):/` or does NOT match `/^tumwater\(/`; (b) `export function deferTick(s: LoopState, role: string, workLandedSinceLast: boolean): boolean` — the four-condition rule above as a pure predicate; (c) in `runOrchestrator`, inside the per-poll runner loop, after `isEligible` returns run with reason `"scheduled"` or `"main moved"`: if `deferTick(runner.state, runner.role, await workLandedSince(runner.state.lastMainHead))` (local async closure over the bounded cache; skip the git call entirely when `lastMainHead` is empty) → log the one-shot `tick_deferred` event on transition and do not add the runner to `reasons`. Also change `fairOrder`'s comparator per the design. `isEligible` itself keeps its exact signature — all existing tests stay valid.
- src/types.ts — add `"tick_deferred"` to the `HarnessEvent["type"]` union with a comment; src/ui/event-format.ts — one formatting case (routine state change, no warning prefix).
- test/orchestrator.test.ts — unit: `workLanded` matrix (feature/bugfix subject → true; only plan/readme/steward/organize subjects → false; human subject without the prefix → true; mixed → true; empty → false); `deferTick` matrix (deferrable + no_change + seen main + no work → true, each condition flipped → false, feature and an unknown custom role never defer even with no_change/no-work); `fairOrder` (director first regardless of recency; a stale-ticked feature ahead of a fresh-ticked organize; within-tier LRU preserved for two maintenance roles). Integration: reuse the existing `startLiveOrchestrator` + `fastConfig(["organize"])` + `recordingFakePi` seams — let the one tick land (argsFile gains 1 line), commit a subject `tumwater(readme): x` directly to main, wait several poll cycles and assert still 1 line; then commit `tumwater(feature): y` to main and `waitFor` a second run; also assert exactly one `tick_deferred` event for organize in the repo's events.
- test/git.test.ts — `subjectsBetween` on a fixture repo with three commits (feature/readme/human subjects) returns them newest-first; an unknown sinceHead yields null.
- README.md — two sentences in "How it works" near the wake paragraph: maintenance roles defer due ticks while no feature/bugfix/human commit has landed since their last tick and their own last tick did nothing (one `tick_deferred` event per episode), and slot allocation orders feature/bugfix/plan ahead of maintenance. Do not touch the `tumwater:prompt` or `tumwater:status` markers.

**Files touched.** src/roles.ts, src/git.ts, src/orchestrator.ts, src/types.ts, src/ui/event-format.ts, test/orchestrator.test.ts, test/git.test.ts, README.md. No changes to loop.ts, state.ts, config.ts, or the tick lifecycle — deferral sits entirely in the scheduler's eligibility pass.

**Acceptance criteria.**
- `npm run build` clean; full suite green (existing isEligible/fairOrder tests unmodified and passing).
- A maintenance role whose last tick was no_change does not start a new tick after only non-work commits (`tumwater(plan):`, `tumwater(readme):`, other maintenance roles) land on main, even when its interval has come due; it starts within one poll (~2 s) of a `tumwater(feature):` or `tumwater(bugfix):` commit — or any human (non-`tumwater(`) commit — landing.
- Work-tier roles and the director are never deferred under any state; a maintenance role with lastResult other than no_change (changed, rejected, error, refused, merge failure) keeps its normal scheduling even when nothing has landed; a never-ticked role always runs its first tick; resume wakes are never deferred.
- With several eligible loops and `maxConcurrent` below their count, feature/bugfix/plan acquire slots before any maintenance role; within each tier the least-recently-ticked loop still goes first; the director still leads unconditionally.
- Exactly one `tick_deferred` event per deferral episode (none on exit, none while merely not-due); it renders in `tumwater logs`, the TUI activity pane, and the GUI feed via the new event-format case.
- No new keys in tumwater.json; no change to tick prompts, backoff math, or the review gate.

**Relationship to other plans.** Independent of all currently-planned entries (budget editing, transcript labels, user-defined loops) — it touches only scheduler internals plus one event type. It is a deliberate refinement of the "main moved" wake described in README's How-it-works: work landings still wake everyone; non-work landings no longer wake maintenance roles that had nothing to do last time. The planned user-defined-loops entry should treat custom roles as never-deferred (pinned above) when it lands.

### Make the daily cost budget editable from the TUI/GUI (planned 2026-09-07)

**Goal.** The fleet's daily spend cap (`maxDailyCostUsd`, default $50, 0 = disabled) can today only be changed by hand-editing tumwater.json while the harness runs. Both dashboards already show the budget badge (TUI header via renderStatus; GUI header from /api/status), but neither offers a way to change it — an operator who hits the cap mid-day must leave the dashboard, find the file, edit JSON, and come back. Make the cap editable in place on both surfaces: the TUI through a key-driven edit mode on its existing input line, the GUI through an inline editor on the budget badge. Both write through one shared setter that persists to tumwater.json — so the change is durable (survives restarts), applies live within ~2 s via the orchestrator's existing config poll, and needs no new reload machinery or event types: raising/disabling the cap while paused already flips the gate on the next poll and emits the existing `budget_resumed` transition.

**Design (decided, with rationale).**
- **One shared setter; both surfaces call it.** New `setDailyBudgetUsd(root, value)` in src/config.ts beside `saveConfig`: fresh `loadConfig` (no stat cache — a writer must see the latest file), validate, mutate only that key, write atomically (tmp file + rename over tumwater.json). Atomicity matters because this is the first in-harness *writer* of the config while readers poll it every ~2 s (the orchestrator) and two dashboards could save concurrently; today's `saveConfig` is a plain `writeFileSync` and stays as-is for init. Validation: finite number ≥ 0, fractional dollars allowed (the display rule already renders cents — $12.34). Invalid input returns an actionable error string instead of throwing, so both UIs can flash it without try/catch plumbing. Read-modify-write preserves every other key.
- **The budget badge becomes always present.** Today `snapshot().budget` is null when the cap is 0 (disabled) and neither dashboard shows a badge — which would leave no affordance to *set* a cap from a disabled fleet. Change: the snapshot/payload carries `{ spentUsd, capUsd }` unconditionally; one display rule in both dashboards: `capUsd > 0` → today's exact text `· budget: $X/$Y today`; `capUsd === 0` → `· budget: $X today · no cap`. The editable affordance sits on the badge either way. This is a deliberate small display change (the disabled case gains a line; the enabled case stays byte-identical) and it changes `status --json`'s `budget` from null to an object when disabled — pinned in acceptance so JSON consumers are aware.
- **TUI: Ctrl+B budget-edit mode on the existing input line.** The TUI has exactly one interactive surface (the prompt line), and its keys follow a pinned pattern (Ctrl+T cycles views; arrows/PgUp-PgDn act only in project-status entry mode). Ctrl+B is free — verified no ctrl+b handler today — and mnemonic for *b*udget. Pressing it switches the input line into budget-edit mode pre-filled with the current cap (`""` when disabled — empty means "no cap" on save) and flashes a hint; from then on printable keys/backspace/edit as usual (applyKey unchanged), Enter parses + saves (flash `budget set to $25` / `budget disabled`, or the validation error — an invalid Enter stays in edit mode so the operator can fix it), Esc cancels back to prompt mode with the previous text restored. Budget mode is orthogonal to view cycling: Ctrl+T still cycles and exits budget mode; every other key/view behaves exactly as today.
- **GUI: click-to-edit on the badge.** The header's budget fragment becomes a link-styled span; clicking swaps just that fragment for `<input type="number" min="0" step="0.01">` (pre-filled with the current cap, empty when disabled) plus `set`/`cancel` buttons. Enter or `set` POSTs `/api/budget`; success flashes and the badge re-renders from the next 1 s poll — no optimistic local state, the badge stays payload-driven like everything else on the page; a failed response flashes the server's error. No new polling or websocket: the existing 1 s refresh shows the new cap within one orchestrator poll of the save.
- **New endpoint `POST /api/budget`** in src/ui/gui.ts beside `/api/prompt`: JSON body `{ maxDailyCostUsd }`; validates with the same rule (missing/non-finite/negative → 400 + message); calls the shared setter; 200 `{ ok: true, maxDailyCostUsd }` or 400 `{ error }`. Reuse `/api/prompt`'s existing `readBody` cap mechanism (the body is tiny). The GUI process writes tumwater.json and the running orchestrator picks it up on its next ~2 s poll — exactly today's contract for hand edits, now driven by a button.
- **No new events.** Gate transitions already emit `budget_paused`/`budget_resumed` carrying `capUsd`; raising/disabling the cap while paused emits one existing `budget_resumed` with the new cap on the next poll. The event feed and both activity panes show it for free.

**Approach.**
- src/config.ts — `setDailyBudgetUsd(root, value): { ok: true } | { ok: false; error: string }`: fresh loadConfig (bypassing loadConfigCached), finite ≥ 0 check with an actionable message, set `maxDailyCostUsd`, atomic write (`<config>.tmp-<pid>` then rename). Export the parse/validate rule so gui.ts and tui.ts share one definition of "a valid cap".
- src/status.ts — snapshot's `budget` becomes unconditional `{ spentUsd: fleetDailyCost(loops), capUsd: cfg.maxDailyCostUsd }`; update the field comment (cap 0 = disabled; display decides).
- src/ui/status-render.ts — badge rule per the design: enabled → today's exact string via usdCap; disabled → `· budget: $X today · no cap` (see Refined note 2 for the shared-formatter pinning).
- src/ui/gui-page.ts — header: render the budget fragment as an editable control (badge span ↔ inline input + set/cancel), fetch to /api/budget in the style of the prompt form, flash on success/error; disabled-cap text per the shared rule.
- src/ui/tui.ts — Ctrl+B enters/exits budget-edit mode (Esc cancels); Enter saves via setDailyBudgetUsd with a flash result; pure `parseBudgetInput(text)` helper (empty → 0/disabled; else finite ≥ 0) beside applyKey's existing testable pattern; the footer hint line gains `· Ctrl+B edit budget` (clipped like everything else).
- src/ui/gui.ts — `/api/budget` POST handler as designed.
- test/config.test.ts — setter: valid whole/fractional/zero persists and preserves every other key (diff the file minus that one key); NaN/negative/non-number reject without touching the file; no tmp file left behind.
- test/status-render.test.ts + wherever snapshot is pinned — disabled cap renders `· no cap` text, enabled byte-identical to today; status --json carries the object when disabled.
- test/gui.test.ts — POST /api/budget: valid whole/fractional/zero → 200 + file updated; missing/non-finite/negative → 400 with message and file untouched.
- test/tui.test.ts — parseBudgetInput unit cases (empty→0, "25"→25, "12.34"→12.34, "abc"/"-1"/"Infinity" errors); e2e via the fake-TTY harness: Ctrl+B pre-fills the current cap (empty when disabled), Enter saves (flash + file on disk), Esc restores the previous prompt text, invalid input flashes the error and stays in edit mode, Ctrl+T exits budget mode.
- README.md — one sentence in the spend paragraph: the cap is editable from both dashboards (TUI Ctrl+B; GUI header) and writes tumwater.json like any other edit, applying live within ~2 s. Do not touch the `tumwater:status` markers.

**Files touched.** src/config.ts, src/status.ts, src/ui/status-render.ts, src/ui/gui-page.ts, src/ui/tui.ts, src/ui/gui.ts, test/config.test.ts, test/status-render.test.ts (or wherever snapshot is pinned), test/gui.test.ts, test/tui.test.ts, README.md. No changes to orchestrator.ts, loop.ts, state.ts, or the event types — live reload and gate transitions already do the rest.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- TUI: Ctrl+B opens budget edit pre-filled with the current cap (empty when disabled); Enter on a valid value persists it to tumwater.json, flashes confirmation, and returns to prompt mode; Esc cancels restoring the previous prompt text; invalid input flashes the error and stays in edit mode; every other key/view behaves exactly as today.
- GUI: clicking the budget badge opens the inline editor pre-filled with the current cap (empty when disabled); saving a valid value POSTs /api/budget, persists it, and the badge shows the new cap within ~2 s of the orchestrator's poll; cancel or failed save leaves the badge unchanged; invalid bodies get 400 + message.
- Both dashboards render `· budget: $X/$Y today` exactly as today when enabled, and `· budget: $X today · no cap` when disabled (previously absent).
- A running fleet picks up a dashboard-set cap within ~2 s with no restart; raising/disabling the cap while budget-paused emits one existing `budget_resumed` event carrying the new cap; lowering it below current spend pauses on the next poll with `budget_paused`. No new event types.
- tumwater.json after a save differs from before only in `maxDailyCostUsd`; no tmp file left behind.

**Relationship to other plans.** Sibling of the done daily-cost-budget plan (plans/daily-cost-budget.md) and its operator-pause sibling: it adds an edit surface for config that already exists, reusing the live-reload contract and transition events — no gate-logic change. Independent of both currently-planned entries (transcript labels; user-defined loops). Single entry: the TUI and GUI halves share one setter, one payload/display rule, and one endpoint pattern — either half alone leaves the other surface unable to set a cap from the disabled state.

**Refined 2026-09-08 (plan loop) — audited against this tree (`3f2b206`; main has since advanced two commits: an unrelated lock.ts refactor and a new open bug that interacts with this entry, correction 3). Build clean, suite 786/786. Every code anchor verified accurate; path corrections and one design pinning below.**

Verified as written on this tree (point for point): src/config.ts — `saveConfig` is a plain writeFileSync beside fresh-read `loadConfig` and stat-cached `loadConfigCached`, so the planned atomic setter slots in without touching either. src/status.ts — snapshot's `budget` is exactly `{ spentUsd: fleetDailyCost(loops), capUsd } | null`, null only while the cap is 0, with `cfg` already in scope at that line. The two dashboards' badge strings are byte-identical today but rendered by two duplicated helpers — `usdCap` (src/ui/status-render.ts) and `fmtUsdCap` (src/ui/gui-page.ts), both `$X.XX` spend with trailing `.00` stripped on the cap; the TUI's footer hint line (`type a prompt … · Ctrl+C to quit`, clipped via clipToWidth) and its flash mechanism exist as described, and Ctrl+B is free (the only ctrl handlers are c and t). src/ui/gui.ts — `/api/prompt`'s `readBody` cap mechanism is the template for `/api/budget`. The orchestrator's budget gate transitions already emit `budget_paused`/`budget_resumed` carrying `capUsd`, so no event-type change.

Corrections:
1. **Paths moved.** Commit `3c8c29b` relocated every observer/presentation module into src/ui/: this entry's `src/status-render.ts`, `src/gui-page.ts`, `src/tui.ts`, and `src/gui.ts` are now `src/ui/…`. The Approach bullets, the Design bullet naming `/api/budget`'s home, and Files touched have been updated in place. Test files were not moved (still test/*.test.ts).
2. **One shared badge formatter, pinned.** "One display rule in both dashboards" must mean one function with a single home — today's two byte-identical helpers (`usdCap` / `fmtUsdCap`) are the drift this feature would otherwise fork into three copies (the new no-cap text plus each surface). Pinned: the badge string is produced by one exported pure helper taking the snapshot's budget object, called from both src/ui/status-render.ts and src/ui/gui-page.ts; the two existing helpers collapse into it. The `status --json` payload stays the single source of truth (the GUI formats client-side), and every future badge case gets exactly one place to land.
3. **Interaction with the new open bug "Budget badge shows `$0.00/$50` on free/local LLM fleets instead of n/a" (BUGS.md, 2026-09-08).** That fix adds a third badge case — every model the fleet could use is free → n/a — to this same code, and its scope note calls out coordinating with this entry. Pinned: the shared helper from correction 2 is written as a function of the full budget object (spentUsd, capUsd, plus the free flag once that bug lands), so whichever entry implements first leaves the other a one-case extension rather than a rewrite — if the bugfix lands first, this plan extends its n/a rendering and keeps its enabled/disabled text byte-identical for priced fleets; if this plan lands first, the bugfix adds the free check inside the same helper. This entry's acceptance criterion "both dashboards render `· budget: $X/$Y today` exactly as today when enabled" applies to fleets whose models carry a price (the bug's repro fleet is out of scope for it). No ordering requirement beyond that; the shared-helper pinning is what makes either order safe.

### User-defined loops — user-directed add/remove/rearrange of extra role loops via the director (planned 2026-09-07)

**Goal.** Today the fleet's loop set is fixed: the twelve catalog roles plus the director, all hardcoded in src/roles.ts and switchable only by hand-editing tumwater.json outside the harness. Let the user steer that set from the director prompt box (TUI or `tumwater prompt`): ask for a new loop **by name with a given role/task** and it is added to the fleet, acting exactly like the other loops — persistent worktree + branch, tick lifecycle, review gate, merge to main, backoff, budget/pause gates — while being **identified as user-defined** in its own prompt and on every dashboard. The same channel removes a user-defined loop or rearranges their order. Built-in roles stay untouched: the user manages only their own loops.

**Design (decided, with rationale).**
- **Storage: a `customLoops` array in tumwater.json.** Durable config belongs in the tracked config file (project state stays in-repo), and the orchestrator already live-reloads that file every ~2 s — so an added loop starts and a removed one stops within one poll cycle, no restart, no new reload machinery. Shape: `[{ "name": string, "task": string }]` — name is the loop id (worktree dir, branch suffix, status row), task is the free-form standing instruction that becomes the loop's entire find-something-to-do prompt. No per-loop knobs (provider/model/clock): opinionated defaults over configuration; a user who wants one asks for it later.
- **Names are validated strictly** because they become filesystem paths and git refs: `/^[a-z0-9][a-z0-9_-]{0,31}$/`, no collision with any catalog id (including `director`), unique within the list. A colliding name would silently shadow a built-in's prompt (`roleById` wins in tickPrompt) — validation makes that impossible instead of subtle.
- **Task is capped at 4096 chars**: it rides into every one of that loop's tick prefills, so unbounded text is a standing per-tick cost. The validation error says to shorten it.
- **Customs merge into `config.roles` at load time** as `{ enabled: true }`, appended after the built-ins in array order. That single move makes ALL existing machinery work unchanged: orchestrator runner creation and mid-run enable/disable (the live-reload loop already starts a runner for any newly-enabled id and stops ticking ids that vanish), `isEligible`'s enabled check, `configForRole` defaults, status/TUI/GUI loop lists, budget/pause gates, worktree/branch/session/log paths. Array order is the display and startup-tie-break order — so **rearranging = reordering the array**, and customs always sit after built-ins (the user rearranges their own set; built-in order is the harness's).
- **Only the director may write `customLoops`.** Every role tick prompt keeps the blanket "never touch tumwater.json" rule; the director gets a scoped exception for exactly this key, plus a routing bullet telling it how to add/remove/rearrange. The edit lands like any other director change: commit → review gate → merge to main → orchestrator picks it up within ~2 s.
- **`tumwater.json` joins the default `review.exemptPaths`.** Only the director can ever produce a diff touching that file (every other loop is prompt-forbidden from it), so exempting it means "user-directed config changes skip model review" — consistent with the md-only exemption's philosophy. Without this, an explicit user command could be silently discarded: a rejected director tick does not re-queue its prompt, and three failed reviews discard the leftover. `validateConfig` is the safety net instead — invalid entries fail fast at load with a named error while the fleet keeps its last-known-good config (the existing live-reload contract), so a bad edit degrades to "no new config changes until fixed", never a broken fleet.
- **Custom loops are blocked on red main**, like `feature`/`improve`: their charter may produce code, and on red main such diffs are rejected deterministically by the gate's pre-check — spending an authoring run is pure waste. The state cell reads `main red`, so it is observable; a per-loop exemption is a future knob, not this feature.

**Approach.**
- src/types.ts — new `CustomLoop { name: string; task: string }`; add required `customLoops: CustomLoop[]` to TumwaterConfig (required, like every other section — no undefined checks at read sites).
- src/config.ts — the heart of it:
  - `defaultConfig()`: `customLoops: []`, and `"tumwater.json"` appended to the default `review.exemptPaths` (comment: only the director can edit that file, so exemption = user-directed config changes skip model review; validateConfig is the safety net).
  - `validateConfig`: add `"customLoops"` to TOP_LEVEL_KEYS and a CUSTOM_LOOP_KEYS list (`name`, `task`). When present it must be an array of plain objects with exactly those keys: `name` a string matching `/^[a-z0-9][a-z0-9_-]{0,31}$/`, not in `allRoleIds()`, unique across entries; `task` a non-empty string ≤ 4096 chars. Each violation gets its own actionable line (the file's existing style — one edit fixes them all). Cross-check the `roles` section: an id under `roles` is valid when it is in `allRoleIds()` **or** listed as a `customLoops` name — keeps `saveConfig` consistent with load-time merging.
  - `loadConfig`: after the existing roles-overlay loop, append each custom to `merged.roles` as `{ enabled: true }` (insertion order = built-ins then customs in array order). `cloneConfig` clones the array so cached-config mutation cannot poison later polls.
  - New single-source-of-truth helpers: `customLoopNames(config): string[]`, `isCustomRole(config, id): boolean`, and `knownRoleIds(config): string[]` (`[...allRoleIds(), ...custom names]`) — every "which ids exist / which are user-defined" consumer goes through these so the answer cannot drift.
- src/roles.ts — one pure helper (the module stays import-free): `customRole(name, task): Role` returning `{ id: name, title: "user-defined loop", find: task }`. The title is what identifies the loop inside its own prompt and commit context.
- src/loop.ts — `tickPrompt()`: replace the hard `throw new Error(unknown role)` with catalog-first lookup falling back to customs: `roleById(this.role) ?? (this.config.customLoops.find(c => c.name === this.role) → customRole(...))`, throwing only when neither knows the id. Nothing else in the tick lifecycle changes — worktree, branch, session dir, raw log, review gate, merge, backoff all key off the role string and already handle any enabled id.
- src/main-red.ts — `mainRedGate`: block custom loops alongside `BASELINE_BLOCKED_ROLES` (read the live config via `loadConfigCached(root)` — stat-cached, one syscall per poll class — and check `isCustomRole`). Rationale comment: unknown charter may produce code; red main rejects such diffs deterministically at the pre-check.
- src/prompt.ts — `buildDirectorPrompt` only (role tick prompts keep the blanket ban):
  - New routing bullet: a loop-management request (add / remove / rearrange user-defined loops) is executed by editing tumwater.json's `customLoops` array — add appends `{ "name", "task" }` with a name in `[a-z0-9_-]` that no built-in role uses and a task written as the loop's standing per-tick instruction (one clear paragraph); remove deletes the entry; rearrange reorders entries (array order is display/scheduling order). Verify the file still parses as JSON after editing.
  - An explicit exception paragraph appended after COMMON_RULES: the director may edit tumwater.json **only** to manage `customLoops`, and nothing else in that file — scoped so the model cannot drift into retuning timeouts or disabling roles on a vague user request.
- src/cli-args.ts + src/cli.ts — `parseRoleFlag` gains the valid-id list as a parameter (its three call sites all have `root` in scope; reset-counters already loads config, logs and abort add `loadConfig(root)`): custom names are accepted by `logs --role`, `abort --role`, `reset-counters --role`, and unknown ids fail listing the known ones including customs.
- src/gui.ts — `/api/transcript?role=` validates against `knownRoleIds(loadConfigCached(root))` instead of `allRoleIds()` (a custom loop's transcript is as observable as any other's); each entry in `statusPayload`'s loops array carries `custom: boolean` from `isCustomRole`.
- src/status-render.ts — `renderStatus`: append `*` to a custom loop's name cell, and when any custom exists add one footnote line under the table (`* user-defined loop`). The TUI needs no change of its own — it renders through renderStatus. (Widths/clipping handle the longer cells by construction.)
- src/gui-page.ts — render the same `*` next to the loop link text from `l.custom`, so both dashboards identify customs identically.
- test/config.test.ts — validation: a valid entry loads and merges into roles after built-ins in array order; bad name charset, collision with `feature`/`director`, duplicate names, empty task, over-long task each fail with their named error; the roles cross-check accepts a custom id under `roles` only when listed in customLoops; cloneConfig independence (mutating one result's array leaves later polls clean); invalid file → loadConfigSafe returns the error and the fleet-visible contract holds.
- test/prompt.test.ts — director prompt carries the routing bullet and the scoped exception; a custom loop's tick prompt reads `You are the "<name>" loop (user-defined loop)` with the task as its run task and still carries COMMON_RULES (including the tumwater.json ban); built-in prompts byte-identical.
- test/orchestrator.test.ts — e2e with the fake shim: mid-run, add a custom entry to tumwater.json → within ~2 s a runner starts (tick_start under its name), ticks in its own worktree/branch, and appears in the snapshot; remove it → one `role … disabled` warning event and no further ticks without restart; reorder two entries → snapshot order follows. Re-adding a removed name revives its persisted state (counters survive, like re-enabling a built-in).
- test/main-red.test.ts (or wherever mainRedGate is pinned) — a custom loop's fresh tick on red main returns the `main_red` outcome exactly like feature's.
- test/cli.test.ts + test/gui.test.ts — `logs --role <custom>` serves its transcript and an unknown id still fails listing customs; `/api/transcript?role=<custom>` 200s while a bogus role 400s naming the known ids; statusPayload carries `custom: true` for customs, false for built-ins.
- README.md — one paragraph in the Roles section: user-defined loops are added/removed/rearranged by prompting the director ("add a loop named X that does Y"), live in tumwater.json's `customLoops`, act like any other loop, and show marked on both dashboards. Do not touch the `tumwater:status` markers — that section is the readme loop's to keep current.

**Files touched.** src/types.ts, src/config.ts, src/roles.ts, src/loop.ts, src/main-red.ts, src/prompt.ts, src/cli-args.ts, src/cli.ts, src/gui.ts, src/status-render.ts, src/gui-page.ts, test/config.test.ts, test/prompt.test.ts, test/orchestrator.test.ts, the main-red test file, test/cli.test.ts, test/gui.test.ts, README.md.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- In a running fleet (fake shim), `tumwater prompt "add a loop named docs-sync that keeps the README examples current"`: after the director's change merges to main, within ~2 s a new loop appears in status/TUI/GUI marked user-defined (`*` + footnote / payload flag), owns `.tumwater/worktrees/docs-sync` and branch `tumwater/docs-sync`, ticks under its own name (tick_start/tick_end events), and honors minTickInterval, backoff, the budget gate, and fleet pause exactly like a built-in role.
- Its tick prompt identifies it (`user-defined loop`) and carries the user's task as the run's task plus COMMON_RULES; its commits read `tumwater(docs-sync): …`.
- "remove docs-sync" → entry gone from main's tumwater.json, one warning event, no further ticks within ~2 s, dashboards drop it. Re-adding the name revives its persisted counters/state.
- Rearranging two custom entries reorders them in the status table (and startup tie-breaks) without touching built-in order.
- Invalid entries (bad charset, collision with a built-in id, duplicate, empty/over-long task) are rejected by validateConfig with an actionable message; while such a file sits on main the fleet keeps its last-known-good config and logs one warning per distinct error text — pinned by test.
- A director tick whose only change is tumwater.json skips model review (exempt diff) yet still commits, merges, and lands; every non-director loop's prompt still forbids touching tumwater.json. `tumwater doctor` reports the new role count including customs via the existing enabledRoleIds line.
- Custom loops are blocked on red main with a `main_red` state cell, like feature/improve.
- No changes to the tick lifecycle in loop.ts beyond the prompt lookup, no new config knobs beyond `customLoops`, and built-in role behavior (prompts, scheduling, gates) is byte-identical when customLoops is empty or absent.

**Relationship to other plans.** Single entry: the config plumbing, the director control surface, and the dashboard identification are one feature — none has user-visible value until all three land, so they do not decompose. Independent of the backlog-reading residual (disjoint files except README prose) and of everything in Done; either can land first.

### Show per-loop token generation rate (5-minute moving average) in the TUI/GUI (planned 2026-09-08, requested by user)

**Goal.** Both dashboards show each loop's cumulative `gen` tokens but not how fast the model is generating for that loop right now — an operator watching a long tick cannot tell whether the fleet is at full speed or crawling (slow local server under load, KV thrashing, a wedged engine). Add one column per loop to both dashboards: output tokens generated over the trailing 5 minutes divided by the window's elapsed time — a moving average that smooths turn granularity and tool-call gaps. Shown for loops with an in-flight tick; `-` otherwise.

**Design (decided, with rationale).**
- **Source: assistant `message_end` events in each loop's raw pi log.** Usage arrives only at turn granularity — streaming deltas (`message_update`) carry no usage and progress.ts already ignores them. The existing live-progress tail (src/ui/progress.ts) incrementally parses exactly these lines for `outputTokens`, so the rate rides that mechanism: no new state file, no loop/orchestrator change, display-only.
- **Sample ring inside LiveProgress.** Each assistant message_end with `usage.output > 0` appends `{ t, tokens }`, where `t` is the line's own `message.timestamp` (epoch ms — transcript.ts already relies on that field for run separators) falling back to parse time when absent. Samples older than the window are pruned at each append. The ring survives `session` resets: `freshProgress` omits the field, so the session case's `Object.assign` leaves it untouched — a 5-minute window legitimately spans tick boundaries (back-to-back ticks, review runs), and tail seeding rebuilds the ring from per-line timestamps.
- **Rate = tokens in [now−300 s, now] ÷ min(300 s, now − oldest sample's t).** Dividing by the full 5 minutes would under-report a young window (a tick that started one minute ago at 100 t/s would read ~20); dividing by elapsed time since the first in-window sample converges to the true rate immediately and becomes exactly the 5-minute moving average once samples span the whole window. No samples in the window → null → `-`.
- **Shown only for running loops** (`s.running`, set at tick start, cleared at end): matches "each running loop", keeps idle loops' tail-read pattern unchanged (progress.ts deliberately does not combine an idle loop's log tail with persisted counters), and no stale rate lingers on a sleeping loop. Review-gate runs count toward their loop's rate — they are that loop's generation.
- **One window constant, no knob.** `TOKEN_RATE_WINDOW_MS = 5 * 60_000` in progress.ts (opinionated default; "let's say 5 minutes" was a suggestion, not a requirement).

**Approach.**
- src/ui/progress.ts — LiveProgress gains an internal `samples: Array<{ t: number; tokens: number }>` (documented as tail state, not display data); feedLine appends + prunes on assistant message_end with `usage.output > 0` (`t = typeof message.timestamp === "number" ? message.timestamp : Date.now()`); freshProgress omits samples so session resets preserve the ring and seeding starts empty; export pure `tokenRate(samples, now): number | null` implementing the formula above beside `TOKEN_RATE_WINDOW_MS`.
- src/ui/status-render.ts — displayTokenMetrics returns `{ generated, peakCtx, tokenRate }`: rate = `s.running ? tokenRate(p?.samples ?? [], Date.now()) : null` (same running-gating as the existing counter combination); renderStatus adds a `t/s` column between `gen` and `peak ctx`, cell via one small formatter — one decimal under 10 (`8.3`), integer at/above 10 (`42`), `-` for null; renumber FLEXIBLE_COLUMNS indices (the file documents "renumber when columns change"); totals row leaves the new cell blank, like ticks/commits.
- src/ui/gui.ts — /api/status loop rows gain `tokenRate: m.tokenRate ?? null` (number|null; JSON-safe) beside generated/peakCtx. `status --json` inherits it for free (same statusPayload).
- src/ui/gui-page.ts — thead gains `<th>t/s</th>` after gen; the row cell formats client-side with the same rule as status-render's formatter (the page already duplicates fmtTokens/fmtUsdCap from the payload — established pattern).
- test/progress.test.ts — feedLine appends a sample stamped with the line's own timestamp; `usage.output` 0 or missing usage adds nothing; samples older than the window are pruned at append; a session event preserves the ring (cross-tick window); tokenRate: empty → null, one young sample divides by elapsed time, full-window samples divide by 300 s, mixed ages.
- test/status-render.test.ts — table carries the t/s column in position; a running loop with a seeded log shows the formatted rate; an idle loop shows `-`; narrow-width clipping still holds after renumbering FLEXIBLE_COLUMNS.
- test/gui.test.ts — /api/status rows carry tokenRate as a number for a running loop with recent samples and null otherwise.
- README.md — one sentence where the dashboards are described (How it works): both show each in-flight tick's token generation rate, smoothed over 5 minutes. Leave the `tumwater:status` section to the readme role.

**Files touched.** src/ui/progress.ts, src/ui/status-render.ts, src/ui/gui.ts, src/ui/gui-page.ts, test/progress.test.ts, test/status-render.test.ts, test/gui.test.ts, README.md. No changes to loop.ts, orchestrator.ts, state.ts, types.ts (LoopState unchanged), or event types — display-only, derived from the raw logs that already exist.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- TUI and `tumwater status` show a new `t/s` column between gen and peak ctx: a loop with an in-flight tick and assistant output inside the trailing 5 minutes shows its moving-average rate (one decimal under 10, integer at/above); every other loop shows `-`.
- The GUI loop table shows the same value; /api/status carries per-loop `tokenRate` (number|null) and `status --json` inherits it.
- Rate math: sum of `usage.output` over assistant message_end lines whose timestamp falls in [now−300 s, now], divided by min(300 s, elapsed since the oldest such sample); null when no samples; a loop that just finished its tick immediately shows `-` (no stale rate on idle loops).
- The window spans tick boundaries: back-to-back ticks within 5 minutes contribute to one combined rate; samples older than 5 minutes are pruned and never displayed.
- No new state files, config keys, or event types; a loop's persisted LoopState is byte-identical before/after (display-only).

**Relationship to other plans.** Independent of everything currently planned (budget editing, transcript labels, user-defined loops): it reads the same raw-log tail those entries do not touch and adds one column plus one payload field. Single entry: the TUI and GUI halves share one sample ring, one rate helper, and one payload field — either half alone leaves the other surface blind.

### Merge queue 1/5 — landing takes a worktree and a ref (planned 2026-09-08, requested by user)

**Goal.** Give merge.ts's landing flow the seam the rest of the merge queue needs: it must be able to land *any* ref from *any* worktree, not only `tumwater/<role>` from that role's worktree. Pure refactor — no behavior change, no new files. Architecture and invariants: plans/merge-queue.md. Follow-on: `Merge queue 2/5`.

**Design (decided, with rationale).** `mergeToMain`/`tryMerge` already take the worktree as a parameter and work on a detached HEAD (rebase and `reset --hard` do not care), so the only place that hard-codes role identity is `ffMergeToMain`, which derives `branchName(ctx.role)` itself. Make the ref an explicit input instead of a derivation: `ffMainTo(root, ref, mainBranch)` where `ref` is anything `git rev-parse` accepts (branch name today, a sha from 2/5 onward). Both of its arms already accept a sha — `git merge --ff-only <sha>` when the primary checkout is on main, and `git push . <sha>:<main>` when it is not. `MergeContext` gains a `ref` field carrying what to land so the landing code never re-derives identity; loop.ts passes `branchName(this.role)`, which is exactly what runs today.

**Approach.**
- src/merge.ts — rename `ffMergeToMain` → `ffMainTo(root, ref, mainBranch)`, dropping the `branchName` import and the `role` parameter; `MergeContext` gains `ref: string`; `tryMerge` passes `ctx.ref`. Update the module doc comment: landing is worktree- and ref-parameterized, and `role` on the context is now identity for events/sessions only.
- src/loop.ts — the one `mergeToMain` call site supplies `ref: branchName(this.role)`.
- test/merge.test.ts — retarget the `ffMergeToMain` tests to `ffMainTo`; add two cases pinning the new capability: landing a bare sha from a detached worktree succeeds with both a main-checked-out and a not-on-main primary checkout.

**Files touched.** src/merge.ts, src/loop.ts, test/merge.test.ts.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- No observable change: the same events (`merged`, `question_posted`), the same `TickResult` values, the same commit shapes as before this plan.
- `ffMainTo` lands a bare sha from a detached worktree in both primary-checkout cases, pinned by tests.
- `grep -rn "ffMergeToMain" src test` returns nothing.

### Merge queue 2/5 — land in a per-role detached worktree (planned 2026-09-08, requested by user)

**Goal.** Stop reviewing and rebasing inside the role's own worktree. A tick commits, pins the commit, resets its worktree to main, and then hands the sha to a new harness-owned lander that does the review-and-land in `.tumwater/worktrees/_land-<role>`. Still synchronous inside the tick — the throughput win comes in 3/5 — but after this the role's branch and worktree are free the moment its commit exists, which is the precondition for everything after. Depends on `Merge queue 1/5`; architecture and invariants: plans/merge-queue.md. Follow-on: `Merge queue 3/5`.

**Design (decided, with rationale).**
- **One lander worktree per role, not one shared.** Two roles can be mid-tick at once (`maxConcurrent`), and today their review runs deliberately overlap (the gate runs outside the merge lock). A single shared `_land` worktree would force them to serialize — a concurrency regression while landing is still synchronous — so the path is per-role and needs no new lock. Reuses the existing `ensureDetachedWorktree` (redeploy.ts's `_main` mirror helper) verbatim; the leading underscore is the existing reserved-name convention, so `_land-<role>` can never collide with a role worktree. The build pre-check finds node_modules by its existing walk-up to the root.
- **The commit is pinned by a ref before the role's branch moves.** `refs/tumwater/landing/<role>` is written at the new commit's sha immediately after `commitAll`, so the subsequent `reset --hard main` on the role branch cannot orphan it (invariant 4). The ref is deleted on every terminal outcome — landed, rejected, or discarded past the strike cap — and deliberately *kept* on `review_error` and `merge_conflict`, which is what the next tick recovers.
- **Leftover recovery keys off the ref, not the branch's ahead-count.** leftover.ts today asks "does this role's branch have commits ahead of main?"; with the branch reset every tick the answer is always no, so the question becomes "does `refs/tumwater/landing/<role>` exist and is it not yet contained in main?" — and recovery re-lands that sha through the lander, keeping the same review gate, the same `-recovery` session suffix, and the same strike cap. This preserves invariant 1 on the crash path: a shutdown between commit and landing loses nothing and smuggles nothing in unreviewed.
- **The lander returns the same `TickResult` values the tick returns today**, so state.ts, the dashboards, and the event feed need no change in this plan.

**Approach.**
- src/paths.ts — `landWorktreePath(root, role)` → `.tumwater/worktrees/_land-<role>`; `landingRefName(role)` → `refs/tumwater/landing/<role>`.
- src/git.ts — `setRef(root, ref, sha)`, `deleteRef(root, ref)`, `refSha(root, ref)` (null when absent), `isMergedInto(root, sha, branch)` (`git merge-base --is-ancestor`).
- src/lander.ts (new) — `LandRequest { role, sha, tick, summary, body?, highFriction?, sessionSuffix? }` and `landChange(ctx, req): Promise<TickResult>`: ensure the detached worktree at `req.sha`, run `reviewAheadOfMain` there, map its `GateResult` exactly as loop.ts does today (`aborted` → caller's abort handling, `rejected`, `failed` → `review_error`), then `mergeToMain` with `ref: req.sha`. Module doc: this is harness code, never a role — the only model run it starts is the reviewer and merge.ts's conflict resolver.
- src/loop.ts — after `commitAll`: `setRef` the landing ref, `resetWorktreeToMain(wt, main)`, call `landChange`, then `deleteRef` on the terminal outcomes. The inline `reviewGate` + `merge` pair in `runTick` collapses into that one call; `reviewGate`'s wiring moves into the lander context.
- src/leftover.ts — recover from the landing ref via `landChange` with `sessionSuffix: "-recovery"`; drop the ahead-of-main entry condition and the branch-keeping return value (the branch is always clean main now — the caller no longer has a "left for retry" case to honor).
- test/lander.test.ts (new) — approve → landed and ref deleted; reject → nothing on main, role branch clean at main, ref deleted, reasons in `state.lastReview`; verdict-less failure → ref kept for recovery; conflict → one resolution run, then landed.
- test/loop.test.ts, test/leftover.test.ts, test/git.test.ts, test/paths.test.ts — update for the new flow; pin that a rejected tick leaves the role's worktree clean at main and that a landing ref surviving a simulated crash is re-landed through the gate on the next tick.

**Files touched.** src/paths.ts, src/git.ts, src/lander.ts (new), src/loop.ts, src/leftover.ts, test/lander.test.ts (new), test/loop.test.ts, test/leftover.test.ts, test/git.test.ts, test/paths.test.ts.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- Every `TickResult`, event, and commit shape is unchanged from before this plan; a full live tick of every enabled role still lands the same way.
- Immediately after a tick's `commitAll` the role's worktree is clean at main, whatever the landing outcome — pinned by tests, and true for rejections in particular.
- No review or rebase happens in a role worktree any more: `_land-<role>` is the only place the gate and the rebase run.
- A landing ref left behind by an interrupted landing is re-reviewed and re-landed on the next tick, and is discarded with a warning past `REVIEW_FAILURE_LIMIT`.

### Merge queue 3/5 — asynchronous landing via a durable land queue (planned 2026-09-08, requested by user)

**Goal.** Free the author slot at commit time. A tick ends the moment its commit is pinned and enqueued; the orchestrator drains the queue with the lander on its own budget, outside the author semaphore. This is the plan that pays: with `maxConcurrent: 2`, a role under review no longer blocks a second role from authoring at all. Depends on `Merge queue 2/5`; architecture and invariants: plans/merge-queue.md. Follow-ons: `Merge queue 4/5` (surfacing), `Merge queue 5/5` (coalescing).

**Design (decided, with rationale).**
- **Durable file queue, inbox.ts idiom.** `.tumwater/land-queue/<ts>-<seq>-<pid>.json`, one entry per file: `{ role, sha, tick, summary, body?, highFriction?, enqueuedAt, attempts }`. Filenames order the queue across processes; a crash loses nothing and `tumwater status` can read it without the scheduler. Same reasons the director's inbox is a directory of files.
- **New `TickResult` value `"queued"`**, scheduled in `applyTickOutcome` exactly like `"changed"` (backoff reset, next run at `minTickInterval`) *minus* the commit count — `commits` increments when the change actually lands, so the counter keeps meaning "landed on main".
- **One in-flight landing per role, enforced in `isEligible`** (invariant 3): a role with a queued or landing entry returns `{ run: false }`. This is what keeps `state.lastReview`'s rejection reasons ahead of the author's next prompt and stops a role stacking two commits. The director obeys the same rule — its prompt is not finished until it lands — so there is one rule, not two.
- **The lander runs outside the author semaphore, one landing at a time.** A single in-process landing slot (not a new semaphore capacity knob): the orchestrator starts the head entry when no landing is in flight and does not await it in the poll loop. Author slots and the landing slot are independent, which is the entire point.
- **Write-back into the authoring role's `LoopState`.** The lander already mutates `lastReview`/`lastApprovedHead`/`unreviewFailures` through the gate; on completion the orchestrator folds the landing's usage into that role's counters (invariant 5), increments `commits` on success, refreshes `lastResult`/`lastSummary` with the landing outcome, saves, and logs. The runner objects are in-process, so this is a method on `LoopRunner` (`applyLandingOutcome`) mutating the existing state object in place — the same in-place discipline `resetCounters` documents, for the same reason.
- **Three new events, `land_queued` / `landed` / `land_failed`**, carrying role, sha, result, and the landing's `durationMs` and usage. `merged` still fires from merge.ts, so nothing that reads the feed for landings today breaks.
- **Recovery on start.** Entries left by a killed process are drained on the next start like any other entry (invariant 7); leftover.ts's ref-based recovery from 2/5 remains the belt-and-braces path for a crash between commit and enqueue.

**Approach.**
- src/land-queue.ts (new) — `enqueueLanding`, `queuedLandings`, `headLanding`, `dropLanding`, `bumpAttempts`, `landingFor(role)`, `queueDepth`; the per-poll stat cache idiom from inbox.ts so a 1 s dashboard poll does not re-read every file.
- src/types.ts — `"queued"` in `TickResult`; `land_queued`/`landed`/`land_failed` in `HarnessEvent["type"]`; a `LandingEntry` interface.
- src/loop.ts — after `commitAll` + `setRef` + reset: `enqueueLanding`, log `land_queued`, return `{ result: "queued", summary, commit }`. `landChange` is no longer called from the tick.
- src/orchestrator.ts — per poll: if no landing is in flight and the queue is non-empty, start `landChange` on the head entry with the authoring runner's state and pi wiring; on completion apply the outcome, log `landed`/`land_failed`, drop the entry (or keep it under the strike cap). `isEligible` gains the in-flight interlock.
- src/state.ts — `"queued"` handling in `applyTickOutcome` as designed; `LoopRunner.applyLandingOutcome` beside `resetCounters` in loop.ts.
- src/events.ts — `formatEvent` cases for the three new types.
- test/land-queue.test.ts (new), test/orchestrator.test.ts, test/loop.test.ts, test/state.test.ts, test/event-format.test.ts — queue round-trip and ordering; a queued role is ineligible until its landing completes; a landing that approves increments `commits` and folds usage into the authoring role; one that rejects records reasons that appear in that role's next tick prompt; a queue entry surviving a restart is drained; landing runs while another role authors.

**Files touched.** src/land-queue.ts (new), src/types.ts, src/loop.ts, src/orchestrator.ts, src/state.ts, src/events.ts, test/land-queue.test.ts (new), test/orchestrator.test.ts, test/loop.test.ts, test/state.test.ts, test/event-format.test.ts.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- A tick that changed files ends in `"queued"` within seconds of its commit, holding no author slot through review or the build check; the change appears on main after the landing completes.
- While one role's change is landing, another role authors — pinned by a test that asserts an author slot is available during a landing.
- A role with a queued or in-flight landing never starts a tick.
- A rejection's reasons reach the authoring role's next tick prompt, exactly as today.
- `commits` counts landed changes only; the fleet's daily cost still attributes reviewer and conflict-resolution spend to the authoring role.
- Killing the harness mid-landing and restarting lands (or re-reviews) the same change with no unreviewed commit on main.

### Merge queue 4/5 — surface the land queue on status and both dashboards (planned 2026-09-08, requested by user)

**Goal.** Make queued and in-flight landings visible: after 3/5 a productive tick reports `"queued"` and its change lands seconds-to-minutes later, so an operator needs to see the depth of the queue and which change is landing right now. Depends on `Merge queue 3/5`; architecture: plans/merge-queue.md.

**Design (decided, with rationale).** One payload field, three renderers — the pattern the budget badge and the inbox count already follow. `snapshot()` gains `landQueue: { depth, inFlight?: { role, sha, summary, startedAt } }`, unconditionally (depth 0 when empty), so `status --json` consumers see one stable shape. The per-loop cell reuses the existing `phase` mechanism rather than inventing a second status channel: the role whose change is landing shows `landing <elapsed>` the way a reviewing role shows `reviewing <elapsed>` today, and a role that is merely queued shows its `queued` `lastResult` for free.

**Approach.**
- src/status.ts — the `landQueue` field, read from land-queue.ts plus the orchestrator's in-flight record.
- src/ui/status-render.ts — header badge `· landing: N queued` (omitted at depth 0 with no in-flight landing); `landing` label for the in-flight role's cell.
- src/ui/gui-page.ts — the same badge and label in the header and loop table.
- src/state.ts / src/loop.ts — set `phase = "landing"` around a landing and clear it after, beside the existing `"review"` phase.
- test/status.test.ts, test/status-render.test.ts, test/gui.test.ts, test/tui.test.ts — the badge at depth 0 / depth N, the `landing` label, and `status --json`'s new field.

**Files touched.** src/status.ts, src/ui/status-render.ts, src/ui/gui-page.ts, src/state.ts, src/loop.ts, test/status.test.ts, test/status-render.test.ts, test/gui.test.ts, test/tui.test.ts.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- `tumwater status --json` carries `landQueue` with `depth` always present; both dashboards show the queue depth badge when anything is queued or landing, and nothing when the queue is idle.
- The role whose change is landing reads `landing <elapsed>` in both dashboards; a queued role reads its `queued` result.

### Merge queue 5/5 — coalesce the build check across queued landings (planned 2026-09-08, requested by user)

**Goal.** Stop paying one full `npm test` per landing when several are queued. Rebase the queued changes into one stack, run the declared check once over the stack, and land them all when it is green — falling back to one-at-a-time when it is red, so a failure is still attributed to exactly one change. Depends on `Merge queue 3/5`; architecture and invariants: plans/merge-queue.md.

**Design (decided, with rationale).**
- **Coalescing is only ever cross-role** (invariant 3 caps a role at one in-flight change), so a stack is N changes from N distinct roles — exactly the case the queue was built for.
- **The model reviewer is never coalesced, only the deterministic check.** Each change still gets its own reviewer run over its own `main...<sha>` diff: an adversarial review of a stack would blur which change a criticism applies to, and the reviewer's per-change verdict is what `state.lastReview` feeds back to one author. What is shared is the expensive, deterministic half.
- **Red means bisect-by-fallback, not blame-the-batch.** A red stack re-runs the check per change in queue order and lands the green prefix; the first red change takes the normal rejection path and the rest return to the queue. Bounded and exact: at most N+1 check runs in the worst case, one in the common case.
- **Cap the stack** (`landBatchMax`, default 3 — the fleet's realistic concurrent-role count) so the worst case stays bounded and a busy queue cannot build an arbitrarily long stack.

**Approach.**
- src/lander.ts — `landBatch(ctx, requests)`: reviewer runs per change first (any rejection drops that change from the stack), then rebase the approved changes in order into one lander worktree, one `runBuildCheck` over the stack, ff-merge on green; on red, per-change fallback as designed.
- src/build-check.ts — expose the per-run entry point the batch path needs without the per-sha cache assuming a single commit.
- src/orchestrator.ts — take up to `landBatchMax` head entries when more than one is queued.
- src/config.ts, src/types.ts — `landBatchMax` with its default and validation.
- test/lander.test.ts, test/build-check.test.ts, test/config.test.ts — a green stack lands every change with one check run; a red stack lands the green prefix, rejects the first red change, and requeues the rest; the cap is honored; `build_check` events price each run.

**Files touched.** src/lander.ts, src/build-check.ts, src/orchestrator.ts, src/config.ts, src/types.ts, test/lander.test.ts, test/build-check.test.ts, test/config.test.ts.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- Three queued changes land with one `build_check` event when the stack is green, and each still has its own reviewer run and verdict.
- A stack whose second change breaks the suite lands the first, rejects the second with its reasons recorded, and requeues the third — main is never left red by the batch path.
- `landBatchMax` bounds the stack; setting it to 1 reproduces 3/5's behavior exactly.

## Done

### Label review-gate runs in loop transcripts (planned 2026-09-07, refined 2026-09-07, done 2026-09-08)

**Goal.** Each role's raw pi log (`logs/<role>.jsonl`) interleaves author ticks and review-gate runs into one append-only file — the reviewer deliberately shares the role's log (src/review.ts passes `rawLogFile: piLogPath(root, role)`) so its transcript sits next to the work it judges. But every run renders as an identical separator in all three transcript surfaces (`tumwater logs --role`, the TUI transcript pane, the GUI detail panel): `── run @ <timestamp> ──` (src/transcript.ts). When a tick is rejected or fails review, an operator reading the transcript cannot tell which runs were the reviewer without correlating timestamps against the event feed. Label review-gate runs in every transcript surface: author runs keep today's bare separator byte-for-byte; review runs render as `── review @ <timestamp> ──`.

**Approach.**
- src/pi.ts — add an optional `label?: string` to PiRunOptions. In runPi, after the raw log stream is opened (post-rotation) and before spawning pi, write one marker line when a label is given: compact JSON `{"type":"tumwater_run","label":"<label>"}` + newline. The marker precedes that run's first pi event in file order, so every consumer sees it before the run's `agent_start`. No label → no write; author-run logs stay byte-identical to today.
- src/review.ts — pass `label: "review"` at its single runPi call site (covers both tick-path and leftover-recovery reviews, which share that call). Author runs in loop.ts pass nothing.
- src/transcript.ts — add `"tumwater_run"` to RENDERABLE_TYPES; the renderer gains one piece of cross-line state per the file's documented contract: a pending label set by a marker line (no entry emitted) and captured into run state at `agent_start`, so the separator renders as `── review @ <ts> ──` when labeled — including the bare in-flight form `── review ──` that `pendingSeparator()` already reports for turn-less runs — and exactly as today otherwise. The pending label is consumed (cleared) at every agent_start unconditionally, so a failed reviewer spawn can mislabel at most the immediately following author separator and never leaks state beyond one run. Update the file-header comment documenting this boundary contract with readTranscriptTail.
- src/transcript-tail.ts — extend readTranscriptTail's stopping boundary: a `tumwater_run` marker line with ≥ limit entry-candidates after it is now also a valid window start (the renderer's pending label lives between the marker and its agent_start, so a window starting at an agent_start would drop that run's label). Update the file-header comment that documents this contract.
- test/pi.test.ts — runPi with a label writes exactly one marker line as the raw log's first line (before any pi output); without a label the raw log is byte-identical to today's shape.
- test/transcript.test.ts — a marker before agent_start labels that run's separator; no marker → bare separator unchanged; a labeled turn-less run reports its labeled bare separator via pendingSeparator and flushes it at the next boundary; alternating author/review runs label only the review ones; a stale pending label (marker with no following agent_start, then an unlabeled run) is consumed without leaking past one run.
- test/transcript-tail.test.ts — a window whose boundary is a marker line includes the label on its first run and renders identically to a full re-read; logs with no markers render exactly as today (existing tests pass unmodified).
- README.md — one sentence where transcripts are described: review-gate runs are labeled in loop transcripts. Do not touch the `tumwater:status` markers.

**Files touched.** src/pi.ts, src/review.ts, src/transcript.ts, src/transcript-tail.ts, test/pi.test.ts, test/transcript.test.ts, test/transcript-tail.test.ts, README.md. No changes to loop.ts, leftover.ts, tui.ts, gui.ts, or gui-page.ts — the label flows through the shared renderer into all three surfaces with no per-surface work; progress.ts needs none either (its PROGRESS_TYPES pre-filter skips the marker without parsing) and PiStreamParser never sees it (it only folds pi's stdout).

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- After a review-gate run, that role's raw log contains exactly one `{"type":"tumwater_run","label":"review"}` line immediately before the reviewer's first pi event; author ticks add no marker lines (byte-identical logs for runs without labels).
- All three surfaces render review runs as `── review @ <timestamp> ──` and author runs exactly as today; an in-flight review run shows its labeled bare separator while it has no turns yet. readTranscriptTail's one-shot output stays byte-identical to formatTranscript(whole file).slice(-limit) for logs with and without markers.
- No behavior change anywhere else: no new config keys, no event-log entries, no changes to gate logic or loop outcomes — this is display-only.

**Relationship to other plans.** Independent of everything currently planned; deepens the observability line of the done "Show open bugs and planned features in the TUI/GUI" (transcripts are that plan's sibling surface). Single entry: marker injection and rendering are one feature — either half alone is invisible.

**Refined 2026-09-07 (plan loop) — audited against main `9c675cb` on this tree (build clean, suite 718/718). Every code anchor verified accurate; one correction below. The transcript-tail boundary rule as written cannot achieve its stated goal: the backward scan walks newest-to-oldest and stops at a run's agent_start before it ever evaluates the older marker line preceding it.**

Verified as written on this tree (point for point): src/pi.ts — `PiRunOptions` carries required `rawLogFile`, and `runPi` opens the raw log stream after `rotateIfLarge` and before `spawn("pi", …)` with no I/O in between, so a synchronous marker write there precedes every stdout line by construction (stdout data events cannot fire before spawn; on a failed spawn `finish()` still ends the stream, flushing the marker — the stale-marker case below). src/review.ts — exactly one runPi call site (`reviewAheadOfMain`) with `rawLogFile: piLogPath(root, role)`; both the tick path (loop.ts's reviewGate) and leftover recovery route through it. src/transcript.ts — RENDERABLE_TYPES is `{agent_start, message_end, auto_retry_start}`, separators render as `── run @ <ts> ──` / bare `── run ──`, `pendingSeparator()` exists, and the file-header contract comment ("the pending run separator is this renderer's ONLY cross-line state … extend its stop boundary too") is exactly what the plan updates. src/transcript-tail.ts — the stopping rule is a substring `"agent_start"` check with `candidates >= limit` in a newest-to-oldest walk; `isEntryCandidate` counts only assistant message_end / auto_retry_start lines, so marker lines are never candidates. progress.ts's PROGRESS_TYPES pre-filter (via parsePiEventLine's piEventType fast path) skips the compact-shape marker without parsing it; PiStreamParser never sees it (the marker is written to rawLog directly, not through parser.feed); readTranscript — transcript.ts's incremental reader — needs no change: it feeds every line of the file, markers included, into one long-lived renderer.

Correction:
1. **The tail-scan boundary as written is unreachable.** For a labeled run the marker M precedes its agent_start A in file order (with pi's `session` event line(s) between them — see test/transcript.test.ts's fixture), so when candidates ≥ limit the walk stops at A and never evaluates M. Window [A..EOF] then renders that run's separator bare while a full re-read renders it labeled — violating this entry's own acceptance criterion (tail byte-identical to formatTranscript(whole file).slice(-limit) with markers present). Replace the transcript-tail bullet with this pinned mechanic:
   - The walk gains one state flag alongside `candidates`/`stoppedAtBoundary`: when a qualifying agent_start A is found (candidates ≥ limit), do not stop — record A's index in `lines` and keep walking older lines ("armed").
   - While armed, each older line: a marker (substring check for `"tumwater_run"`, same style as the existing agent_start check) → push it and stop there; window [M..EOF] renders identically to a full re-read because every marker inside the window is followed by its own agent_start inside it, and the renderer's cross-line state at any such window start (agent_start or marker line) matches a fresh one — a turn-less previous run leaves at most a pending separator whose timestamp/label the first in-window agent_start overwrites exactly as today. Any other line (session events, older turns) → keep walking. An older `agent_start` before any marker is found → this run was unlabeled: truncate `lines` back to A's recorded index + 1 and stop at A — byte-identical to today for unlabeled logs.
   - The armed state persists across chunk boundaries like every other walk variable (the scan already carries `held`/`candidates` across chunks); reaching EOF while still armed truncates at A as well. The stale-marker case falls out of the same rule: M with no agent_start of its own is found while arming on the NEXT run's agent_start, so the window includes it and the tail reproduces a full re-read's (mis)labeling — the invariant is tail ≡ full re-read, not "labels are always correct".
   - `isEntryCandidate` stays unchanged: a marker renders no entry of its own and must not inflate the candidate count; the "≥ limit candidates after it" condition holds automatically at M (no candidate lines sit between M and A), so arming needs no separate check when it lands on M.
   - The existing fallback re-read (`entries.length < limit && stoppedAtBoundary`) applies unchanged, as do the file-header contract-comment updates in both transcript.ts and transcript-tail.ts.

Test bullet update (replacing the transcript-tail item): a labeled run whose boundary would otherwise be its agent_start renders with the label — the window includes M even though A is what armed the stop; an unlabeled log stops at its agent_start exactly as today (existing tests pass unmodified); a stale marker (M, no agent_start, then an unlabeled run) yields a tail identical to a full re-read of that file, mislabeled separator included; and a labeled run older than the window boundary contributes nothing (its M sits outside [boundary..EOF]).

### Read backlog entries in full from the TUI/GUI dashboards (planned 2026-09-05, refined 2026-09-06, re-audited 2026-09-06, done 2026-09-07)

**Goal.** Both dashboards show project status as heading lines only: the TUI's project-status pane and the GUI's backlog pane render `plannedPlans`/`openBugs`/`openQuestions`, which return just the `### ` headings of PLANS.md / BUGS.md / QUESTIONS.md. An operator watching the fleet can see that a plan or bug exists but not what it says — reading an entry means leaving the terminal/browser and opening the markdown file. The initial prompt's observability promise ("background loops are observable by gui/tui/log") covers loop state well (phase, live detail, transcripts), but the backlog — what the fleet intends to do next — is visible only as titles. Make every entry readable in place: arrow-key browsing in the TUI's project-status pane, click-through into the GUI's existing detail panel.

**Approach.**
- src/backlog.ts — extend the parse to carry bodies alongside headings. `parseEntries` currently returns heading strings; change it to return `{ title, body }[]`, where body is the trimmed lines between that `### ` heading and the next `### `/`## ` line (empty string for a bare heading). The stat-keyed cache (`sectionCache`) stores the richer shape — one parse per file change subsumes the titles-only read. Keep the three exported readers' signatures: `plannedPlans`/`openBugs`/`openQuestions` map entries to `.title`, so every existing call site (status.ts badge counts, gui.ts payload, tui.ts list) compiles unchanged; add one richer reader per file (`plannedPlanEntries(root)` and siblings) for the new surfaces.
- src/tui.ts — entry browsing in the project-status view (`view === roleIds.length + 1`). New state: a selected-entry index (null = list mode, today's rendering). In that view, down/up selects the next/previous entry across all three sections (wrapping at both ends) and switches the pane to that entry's full body under a header naming file + title ("plan: <title> — ↑↓ browse · Ctrl+T cycle"); while reading, up/down moves between entries; Ctrl+T cycles views as today and clears the selection. The no-selection rendering stays byte-identical to current. Keep the key logic pure (an `applyKey`-style exported helper taking the flat entry list + cursor + direction) so it is unit-testable without a TTY, following test/tui.test.ts's existing pattern; body lines go through the same per-line `clipToWidth` as every other pane line.
- src/gui.ts — new on-demand endpoint mirroring `/api/transcript`: `GET /api/backlog?file=<plans|bugs|questions>&index=N` → `{ title, body }`, where index addresses the Nth entry of that file's open section in the same order the payload lists titles (PLANS.md ## Planned / BUGS.md ## Open / QUESTIONS.md ## Open). Unknown file or out-of-range/missing index → 400 JSON error via `sendJson`. On-demand rather than payload: full bodies (long repros, multi-KB plans) are fetched only on click, keeping the 1-second `/api/status` poll lean and leaving `status --json`'s document byte-identical.
- src/gui-page.ts — render each backlog entry line as a link (`<a class='backloglink' data-file=… data-index=…>`) inside the existing pre-wrap `#backlog` pane; on click, close any open transcript (mutual exclusion with loop links, same toggle rule) and fetch `/api/backlog`, rendering title header + body into the existing `#transcript` detail panel — its `white-space:pre-wrap` already preserves newlines, so no CSS change. Re-clicking the same line closes it; clicking a loop link switches as today.
- test/backlog.test.ts — body extraction: multi-line bodies with interior blank lines, an entry at section end, truncation at the next `## `, `_None yet._` placeholders still yield zero entries, and the titles-only readers return exactly what they do today (existing tests keep passing unmodified).
- test/tui.test.ts — the pure browse helper: null cursor + down → first entry; up from first wraps to last; movement across section boundaries; body lines clipped to width.
- test/gui.test.ts — the `/api/backlog` handler: valid file+index returns `{title, body}` matching the fixture's Nth heading and its body text; unknown file → 400; out-of-range index → 400; empty section → 400. Plus a structural GUI_PAGE pin for the backloglink markup (the file's existing pattern).
- README.md — one sentence where the dashboards are described: backlog entries open in place from either dashboard to read their full text. Do not touch the `tumwater:status` markers — that section is the readme loop's to keep current.

**Files touched.** src/backlog.ts, src/tui.ts, src/gui.ts, src/gui-page.ts, test/backlog.test.ts, test/tui.test.ts, test/gui.test.ts, README.md.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- TUI: cycling to the project-status pane renders today's list byte-identically until a key is pressed; down opens the first entry's full body (clipped per line) under a header naming file + title; up/down moves between entries across all three sections, wrapping at both ends; Ctrl+T leaves the view and resets the selection.
- GUI: every backlog line in the project-status pane is clickable; clicking opens the detail panel with that entry's full text (newlines preserved via the panel's existing pre-wrap) under a title header; re-clicking the same line or clicking a loop link closes/switches it; `GET /api/backlog?file=plans&index=N` returns `{title, body}` matching PLANS.md's Nth Planned entry for this repo (the fleet-pause plan at index 0 while both current entries remain).
- `tumwater status --json` output is unchanged — the payload still carries title strings and its existing deep-equal test passes unmodified; no new config keys, no changes to loop/orchestrator/review behavior.
- Cache: with an unchanged PLANS.md, repeated `/api/backlog` fetches re-parse nothing (stat-keyed cache hit), same freshness semantics as today's list reads.

**Relationship to other plans.** Deepens the done "Show open bugs and planned features in the TUI/GUI" (2026-08-24): that plan added the heading lists; this makes each entry readable without leaving the dashboard. Independent of the fleet-pause plan — pause touches loopPhase/state cells, not the backlog pane; either can land first. Single entry: both surfaces share the one parse extension in backlog.ts and the feature's value is "readable from the dashboards" plural — a TUI-only or GUI-only half-landing would leave one dashboard unable to read what the other shows.

**Refined 2026-09-06 (plan loop) — audited against main `21786c1`; every code anchor verified still accurate, scope unchanged. Three corrections below: the TUI interaction model as written has no way back to list mode and cannot show long bodies, the GUI index semantics need pinning, and one existing test's shape assumption needs a note.**

Verified as written on this tree (build clean; backlog/tui suites green): src/backlog.ts matches point for point — `parseEntries` returns heading strings, `sectionCache` is stat-keyed and stores them, `plannedPlans`/`openBugs`/`openQuestions` are the only readers; src/tui.ts's project-status view sits at `view === roleIds.length + 1` with Ctrl+T cycling, per-line `clipToWidth`, and the pure-exported-helper pattern (`applyKey`/`renderInputView`/`backlogLines`) this plan extends — up/down arrows are no-ops in the TUI today (readline passes them to `applyKey`, which ignores them), so claiming them needs no conflict resolution; src/gui.ts's `/api/transcript` handler is the exact template for `/api/backlog` (`sendJson` 400s, query parsing via `parsePositiveInt`), and `statusPayload` carries `plans`/`bugs`/`questions` title arrays fresh per poll; src/gui-page.ts's `transcriptRole` toggle plus the `#transcript` panel re-fetched on the same 1-second poll is the pattern the detail-panel work mirrors.

Corrections:
1. **TUI interaction model — as written it has no way back to list mode and cannot show long bodies.** The pane holds a fixed `eventBudget` lines, so "down opens the first entry's full body" cannot hold for entries longer than the pane (the two currently-planned entries run 46 and 25 lines against a ~17-line budget on a 40-row terminal), and once an entry is open only Ctrl+T leaves it — cycling through every loop view to get back to the heading list. Replace with this pinned model:
   - List mode (no selection): rendering byte-identical to today; ↓ opens the first entry, ↑ opens the last (symmetric wrap); all other keys behave as today. With zero entries across all three sections, ↓/↑ do nothing.
   - Entry mode: header `<label>: <title> — i of n · ↑↓ scroll · ←→ entries · Esc list` (label = plan/bug/question; title clipped per line like every other pane line). The pane shows body lines `offset..offset+eventBudget`; ↑↓ scrolls that window clamped at both ends, and the offset resets to 0 on entry change; ← → moves prev/next across all three sections wrapping at both ends; Esc returns to list mode clearing selection and scroll. Printable keys still edit the prompt line in both modes — so `q` is deliberately not a back key (it would insert into the prompt); Esc is readline's lone-escape keypress, distinct from every arrow CSI sequence.
   - The pure-helper requirement stands: an exported function taking flat entry list + cursor index + scroll offset + key → new state, unit-tested without a TTY per test/tui.test.ts's pattern (add cases for clamped scroll at both ends and wrap across section boundaries).
2. **GUI index semantics** — pin 0-based `index` (matches the `data-index` attribute and payload array order); `/api/backlog` resolves it against a fresh parse at request time, same freshness as list reads: if PLANS.md changes between poll and click, the panel shows whatever entry now occupies that slot, and because the panel header always renders the resolved title, any drift is visible to the operator. The panel follows the transcript pattern exactly — re-fetched on the same 1-second poll while open, so an entry a loop is editing updates live.
3. **parseEntries test note** — `parseEntries`'s own four direct assertions in test/backlog.test.ts (lines ~47–70) pin its `string[]` shape via deepEqual and must be updated to read `.title`; the three reader-level tests (`plannedPlans`/`openBugs`/`openQuestions`) pass unmodified — that is what "existing tests keep passing" refers to.

Acceptance criteria updates: replace the TUI bullet with — cycling to project status renders today's list byte-identically until a key is pressed; ↓ opens the first entry (↑ the last) showing its head under the pinned header; ↑↓ scrolls within the body clamped at both ends; ←→ moves between entries across all three sections wrapping at both ends and resetting scroll; Esc returns to the byte-identical list; printable keys edit the prompt line in both modes. Add a GUI bullet — `GET /api/backlog?file=plans&index=0` is 0-based and resolves against a fresh parse (a click after PLANS.md changed reads whatever entry now occupies slot 0, named by the panel's title header).

**Re-audited 2026-09-06 (plan loop) — audited against main `f6ad136` on this tree (`6e7ab6c`; build clean, suite 700/700); the implementation landed at feature tick 105 (`2c85ea4`). Scope is now a single residual: within-body scroll in the TUI. Everything else on this entry's acceptance list has landed and is pinned.**

Verified as landed (point for point against this entry's Approach): src/backlog.ts matches — `parseEntryDetails` returns `{title, body}[]`, the stat-keyed `sectionCache` stores the richer shape, the three titles-only readers are unchanged thin wrappers over it, plus the three planned entry readers (`plannedPlanEntries`/`openBugEntries`/`openQuestionEntries`); test/backlog.test.ts pins bodies with interior blank lines, EOF and next-`## ` boundaries, placeholders, cache hits on an unchanged file, and that `parseEntries` still returns titles only (better than correction 3 anticipated: the wrapper kept its shape, so no existing assertion needed updating). src/gui.ts's `/api/backlog?file=&index=` is zero-based, resolves against a fresh parse at request time, and 400s on unknown/missing file, missing/bad index, and out-of-range (test/gui.test.ts pins all of it); `statusPayload` still carries the title arrays (`plans`/`bugs`/`questions`), so `status --json` is unchanged. src/gui-page.ts renders every plans/bugs/questions line as a `backloglink` with `data-file`/`data-index`, toggles closed on re-click, switches away from loop links (mutual exclusion via `backlogKey` vs `transcriptRole`), and the detail panel re-fetches on the same 1-second poll while open — its pre-wrap preserves newlines. src/tui.ts: list mode renders byte-identically; ↓ opens the first entry, ↑ the last, wrapping across all three sections (pure `moveEntrySelection`, unit-tested); the entry header is `<label>: <title> — ↑↓ browse · Ctrl+T cycle` with per-line clipped body and a placeholder for bare headings; a stale selection clamps to the last remaining entry or clears; Ctrl+T leaves the view and resets the selection. test/tui.test.ts pins all of it end-to-end through its fake-TTY `startTui` harness, including the header string.

Deliberate deviations from this entry's 2026-09-06 refinement — accepted as shipped (documented in README status): ↑↓ navigates entries instead of scrolling; Ctrl+T returns to list mode instead of Esc; there is no ←→ at all. Simpler than the pinned model and consistent with the TUI's existing key vocabulary, so the refined interaction bullets are superseded by what landed — except one functional gap:

**The residual — long bodies cannot be read in full in the TUI.** `entryBodyLines` keeps only the HEAD of a body, capped at `eventBudget` lines; no scroll key exists. The refinement anticipated exactly this ("cannot show long bodies") and pinned a scroll model, but the implementation dropped it: today's two planned entries run 47 and 39 lines against a ~17-line budget on a 40-row terminal, so the fleet's own backlog is truncated in place — "make every entry readable in place" holds for the GUI (detail panel) but not the TUI.

Residual scope (one focused change; it does not decompose):
- src/tui.ts — within-body scroll via PageDown/PageUp: Node's readline keypress parser maps CSI `6~`/`5~` to `key.name === "pagedown"`/`"pageup"` (verified on the node in use), and neither name is used anywhere today. New state `entryScroll` (line offset, 0 = head): reset whenever `selectedEntry` changes (↑↓) or clears (Ctrl+T); PgDn steps +eventBudget, PgUp −eventBudget; the pane renders body lines `offset..offset+budget` with the effective offset clamped to `[0, max(0, totalLines − budget)]` at render time so a terminal resize or queued-prompt budget shrink cannot strand the window. Active only in project-status view entry mode — no-op in list mode and every other view; printable keys still edit the prompt line (unchanged). The header gains ` · PgUp/PgDn scroll` appended after `↑↓ browse`, only while the body overflows (`totalLines > budget`) — short entries keep today's exact header, which test/tui.test.ts already pins.
- Pure helpers per the file's existing pattern: replace `entryBodyLines(body, budget, width)` with an offset-aware window helper taking `(body, offset, budget, width)` and returning both the clipped lines and the body's total line count (so render decides the header affordance without re-splitting; empty body → the existing placeholder line), plus a pure step/clamp helper for the PgUp/PgDn arithmetic. Update `entryBodyLines`'s two unit tests to the new shape.
- test/tui.test.ts — unit: window at head/middle/tail, offset clamped past the end, per-line clipping, empty-body placeholder; stepping from 0 lands on the tail window and back, no-op when the body fits. E2e via `startTui` (rows=40): seed a plan entry whose body is ~40 numbered lines so it overflows any budget — ↓ opens its head (line 1 present, last absent) with the scroll hint in the header; PgDn jumps to the tail window (last line present, first absent); a second PgDn stays put (clamp); PgUp returns to the head; ↑ moves to the next entry and resets scroll to that body's head even if it too is long; Ctrl+T out and back restores the byte-identical list. Pin the no-op: PgUp/PgDn in list mode and in another view change nothing.

Files touched (residual): src/tui.ts, test/tui.test.ts. No changes to backlog.ts, gui.ts, gui-page.ts, or README.md — the dashboards' one-sentence description already landed via the status section, and scroll is an implementation detail of the same feature.

Acceptance criteria (residual; every other bullet on this entry is audit-verified above):
- `npm run build` clean; full suite green.
- TUI: in project-status entry mode with a body longer than the pane, PgDn/PgUp page through it clamped at both ends and the offset resets on every entry change and on leaving the view; the header shows the scroll hint only while overflow exists; list mode, other views, prompt editing, and short-entry rendering are byte-identical to today.

Completion: full suite green with build clean, then move this entry to Done with a note citing the landing commit. No changes outside src/tui.ts + test/tui.test.ts are expected — if any residual turns out to require one, re-audit first; that would mean this note missed something.

**Done 2026-09-07 (plan loop) — audited against main `fea0522` on this tree (build clean, suite 717/717) and moved from Planned; every acceptance bullet landed. The last residual — TUI within-body scroll for long entries — landed at feature tick 107 (`1a5fff9`) exactly as the re-audit scoped it: src/tui.ts + test/tui.test.ts only.**

Verified point for point against this entry's residual scope: `entryBodyWindow(body, offset, budget, width)` returns both the per-line-clipped window and the body's total line count (empty body → the existing placeholder); `stepEntryScroll` steps ±eventBudget clamped to `[0, max(0, totalLines − budget)]`; PgDn/PgUp are active only in project-status entry mode — no-op in list mode and every other view; `entryScroll` resets on every ↑↓ entry change and on Ctrl+T leaving the view; the header gains ` · PgUp/PgDn scroll` after `↑↓ browse` only while the body overflows (`total > budget`) — short entries keep the exact header test/tui.test.ts already pins. The window/step arithmetic is unit-pinned (head/middle/tail, clamp at both ends and past either end, no-op when the body fits) and entry-mode rendering/reset is e2e-pinned through the fake-TTY harness; one seam is not pinned — the PgUp/PgDn keypress dispatch itself has no e2e case (a coverage candidate).

### Fleet pause — `tumwater pause` / `tumwater resume` (planned 2026-09-05, refined 2026-09-06, done 2026-09-06)

**Goal.** There is no way to stop a running fleet from starting new role ticks without killing the process: `abort --role <id>` kills one in-flight tick, Ctrl+C stops everything including the director and requires restarting `tumwater run`, and the daily cost cap cannot be repurposed (it keys off spend and resets at local midnight). An operator who wants "stop spending for now, but keep the harness alive — dashboards up, director still answering my prompts" has no command. Add a persistent, operator-intent pause: `tumwater pause` blocks every role loop from starting NEW ticks while in-flight ticks finish and the director keeps running; `tumwater resume` lifts it. It is the budget gate's sibling with a different trigger — human intent instead of spend — reusing its exact shape (one gate line, one-shot transition events, a state cell on both dashboards), so the fleet gains a third steady state: *running*, *budget paused*, and *paused*.

**Approach.**
- src/paths.ts — `pausedPath(root)`: `.tumwater/paused.json`. Unlike the abort/reset markers (one-shot requests, consumed on pickup), this marker is PERSISTENT STATE: its presence means "paused" until `resume` removes it. Content is `{ at }` (the pause timestamp, same convention as the abort markers) — read for display only, never required.
- src/state.ts — `isFleetPaused(root): boolean`: `fs.existsSync(pausedPath(root))`, never throws (a missing `.tumwater/` reads false). Lives here next to `budgetPaused` because both the scheduler and every observer must evaluate it from disk without importing each other's modules — the same "single definition" rule that put `budgetPaused` in state.ts.
- src/types.ts — add `"fleet_paused"` and `"fleet_resumed"` to the HarnessEvent type union (comment: operator pause via `tumwater pause`; role loops stop starting new ticks, director exempt). Named with the `fleet_` prefix to pair with `budget_paused`/`budget_resumed` in logs where both can appear.
- src/event-format.ts — two cases, routine state changes like `counters_reset` (no warning prefix): `fleet paused — role loops stop starting new ticks (director keeps running)` / `fleet resumed — role loops tick again`.
- src/orchestrator.ts — in the poll loop, next to the budget gate: read `isFleetPaused(root)` each cycle (one existsSync, same cost class as the inbox and main-head reads); track a `prevUserPaused` alongside `prevBudgetPaused` and log exactly one transition event per change. In the eligibility pass, extend the existing budget-gate line so BOTH gates share it: rename the current local (`pausedNow`) to `budgetPausedNow` and gate on `(budgetPausedNow || userPaused) && runner.role !== DIRECTOR_ROLE`. The director exemption is deliberate and matches the budget gate's rationale (the README's "it always has priority"): a human typing prompts outranks an operator pause, and queued prompts simply wait in the inbox if the operator wants full silence. Because the gate sits before `isEligible`, it blocks every new-tick reason — scheduled, startup, main-moved wake, AND resume-pending recovery; in-flight ticks finish (only NEW ticks are blocked), exactly like the budget gate.
- src/status.ts — add `paused: boolean` to StatusSnapshot and set it from `isFleetPaused(root)` in `snapshot()` (fresh per poll like `questions`; no cache — a 2-second-stale pause flag would mislead an operator mid-resume).
- src/gui.ts — `statusPayload`: carry `paused: snap.paused` at the top level, and pass it into the existing `loopPhase(...)` call so the GUI's precomputed phase matches the table.
- src/status-render.ts — `loopPhase` gains a `userPaused = false` parameter (default keeps every existing call site compiling); for an idle role loop it is checked AFTER the director exemption and BEFORE the budget check, returning `paused`. Precedence rationale: user intent is more specific than spend state — while both hold, "paused" tells the operator what to do (`resume`), which "budget paused" would not. `renderStatus` reads `snap.paused` once (next to its existing `budgetPausedNow`) and threads it through `stateCell`. The TUI needs no change of its own: it renders via `renderStatus(root, snapshot(root), width)`, so the new cell flows through automatically; the GUI renders `l.phase` generically. No header-badge change — every idle role loop's state cell already says why nothing is moving (same as budget-paused today).
- src/cli.ts — two commands, both `rejectUnknownArgs(<cmd>, args, [])`, both behind `requireReadyRepo`, both idempotent and exit 0:
  - `pause`: marker present → print "already paused"; absent → write it (ensureParentDir first — a fresh repo has no `.tumwater/` yet) and confirm. The confirmation names the semantics: role loops stop starting new ticks within ~2s, in-flight ticks finish, the director keeps running your prompts. Unlike `abort`, it does NOT require a live harness — pausing before startup is meaningful (the fleet then starts already paused), so when no orchestrator is alive say "takes effect on the next `tumwater run`" instead of failing.
  - `resume`: marker absent → print "not paused"; present → removeQuiet it and confirm (same live-vs-stopped wording split).
  - Two HELP lines alongside `reset-counters`/`abort`.
- test/orchestrator.test.ts — with a fake pi shim and short pollMs: write the marker before starting → no role tick starts for any reason (scheduled, startup, main-moved wake via moving the fixture's main ref, and resume-pending) while the director still runs a queued prompt; an in-flight role tick started before the pause completes; exactly one `fleet_paused` event per process until resume, then exactly one `fleet_resumed`; removing the marker mid-run lets blocked roles tick again on their next eligibility (no restart).
- test/cli.test.ts — pause/resume idempotency and messaging with no harness running (marker created/absent as expected; second `pause` says already paused; second `resume` says not paused); both reject unknown args.
- test/status-render.test.ts + test/gui.test.ts (or wherever statusPayload is pinned) — idle role loop shows `paused` while the marker exists, checked before budget-paused and main_red (fixture with all three true reads `paused`); director still reads `waiting for prompts`; `status --json` carries `"paused": true/false`.
- README.md — two Usage lines (`tumwater pause   # stop role loops starting new ticks (in-flight finish; the director keeps running)` / `tumwater resume  # lift a pause`) and one sentence in the budget paragraph noting the operator-pause sibling. Do not touch the `tumwater:status` markers — that section is the readme loop's to keep current.

**Files touched.** src/paths.ts, src/state.ts, src/types.ts, src/event-format.ts, src/orchestrator.ts, src/status.ts, src/gui.ts, src/status-render.ts, src/cli.ts, test/orchestrator.test.ts, test/cli.test.ts, test/status-render.test.ts (and the statusPayload test file), README.md.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- In a ready repo with no harness running: `tumwater pause` creates `.tumwater/paused.json`, prints its confirmation, exits 0; a second `pause` reports already paused without rewriting; `resume` removes the file and confirms; a second `resume` reports not paused. Neither command fails for lack of a live orchestrator.
- With a running fleet (fake shim): while the marker exists, zero new role ticks start under any wake reason — scheduled, startup, main-moved, resume-pending — while a queued director prompt still runs and an in-flight role tick finishes; after `resume`, blocked roles tick again on their next eligibility without a restart.
- Exactly one `fleet_paused` event per pause transition and one `fleet_resumed` per resume (not once per ~2s poll), each formatted by formatEvent and visible in `logs -f`, the TUI activity pane, and the GUI feed.
- Dashboards: while paused, every idle role loop's state cell reads `paused` (table, TUI, GUI) ahead of `budget paused`/`main red`; the director reads `waiting for prompts`; with no harness running the table still reads `stopped` per loop while `status --json` carries `"paused": true`.
- Persistence: pause while stopped, then start — role ticks stay blocked until resume; the marker is the only state involved (no loop-state or config changes).
- No new config keys, no changes to loop.ts's tick lifecycle, the review gate, or the merge flow. Out of scope by design: per-role pause (one fleet-wide switch before a knob), and pausing the director (human prompts outrank operator gates — same rule as the budget cap).

**Relationship to other plans.** Sibling of the done daily-cost-budget plan (plans/daily-cost-budget.md): identical gate shape, transition-event pattern, dashboard cell, and director exemption — different trigger (operator intent vs spend) and persistence (marker file vs stateless re-evaluation). Complements `abort` (kills one in-flight tick; pause blocks new fleet-wide starts) and Ctrl+C (stops the whole process; pause keeps it alive). Independent of `tumwater doctor` (done 2026-09-06); doctor would report a paused marker as an informational line only if ever extended. Single entry: pause and resume are two sides of one switch sharing the marker, events, and display.

**Refined 2026-09-06 (plan loop) — audited against main `b349f6d`; the implementation landed at feature tick 103 (`9481eeb`) and the orchestrator e2e test at coverage tick (`7c56ca1`), but three of this entry's own test items never landed. Scope is now that test-only tail — do NOT re-implement anything in src/ or README.md.**

Verified as landed, matching this entry's Approach point for point: src/paths.ts carries `pausedPath` (`.tumwater/paused.json`); src/state.ts exports `isFleetPaused` (existsSync, never throws) next to `budgetPaused`; src/types.ts adds both event types with the planned comment; src/event-format.ts formats them verbatim as planned (routine state changes, no warning prefix); src/orchestrator.ts reads the marker fresh each cycle, tracks `prevUserPaused`, logs exactly one transition event per change, and gates eligibility on `(budgetPausedNow || userPaused) && runner.role !== DIRECTOR_ROLE` BEFORE `isEligible` — so every wake reason (scheduled, startup, main-moved, resume-pending) is blocked by construction while in-flight ticks finish; src/status.ts carries `paused` fresh per poll; src/gui.ts puts it at the payload top level and threads it into `loopPhase`; src/status-render.ts checks `userPaused` after the director exemption and before budget (→ `paused`, ahead of `budget paused`/`main red`) with `renderStatus` reading `snap.paused` once — TUI flows through `renderStatus`, GUI renders `l.phase` generically; src/cli.ts has both commands idempotent (`already paused` / `not paused`), no live harness required (live-vs-stopped wording split, `ensureParentDir` for fresh repos) plus the two HELP lines; README.md carries both Usage lines and the budget-paragraph sentence. test/orchestrator.test.ts's e2e (landed at `7c56ca1`) pins: mid-run pause blocks a main-moved wake (no tick, no wake event), marker persistence, the director running a queued prompt while paused, resume unblocking without restart, and exactly one transition event per direction. Verified on this tree: build clean, full suite 678/678.

The residual — four test-only items across three files (plus two sub-cases in the fourth), nothing in src/ missing or wrong:
1. **test/cli.test.ts** — zero pause/resume coverage today. Follow the abort block's pattern (child-process CLI against a temp repo, `cli(repo, ...)`): fresh ready repo with no orchestrator info file → `pause` exits 0, stdout matches `/fleet paused/` and names the next-`tumwater run` effect, `.tumwater/paused.json` exists; second `pause` exits 0 printing exactly `already paused` with the marker content unchanged; `resume` exits 0 matching `/fleet resumed/` and removes the marker; second `resume` exits 0 printing exactly `not paused`. Unknown args: `pause --x` and `resume extra` exit 1 matching `/unknown argument/`. Optionally pin the live wording split too (cheap): with an orchestrator info file naming `process.pid` (the gui.test.ts pattern), `pause` prints the ~2s effect without the stopped-harness tail.
2. **test/status-render.test.ts** — the `snapshotWith` fixture already threads a `paused = false` parameter, but no test exercises it: idle role loop with `userPaused=true` → `loopPhase` returns `paused`; precedence with all three true (`s.lastResult = "main_red"`, budget reached, user-paused) still reads `paused` (and so does user-paused + main-red without budget); the director stays `waiting for prompts` while user-paused; an in-flight tick keeps its live detail instead of reading `paused` (mirror the existing budget-paused in-flight assertion). At render level: `snapshotWith(..., true)` → idle role loops' state cells read `paused` ahead of `budget paused`/`main red`, director row unchanged.
3. **test/gui.test.ts** — mirror the "budget paused in the phase payload" test (line ~486) but write `.tumwater/paused.json` instead of spend-at-cap: `statusPayload(repo).paused === true`, the idle role loop's phase reads `paused`, the director stays `waiting for prompts`; remove the marker → `paused` false and the phase reverts. This pins `/api/status` — and therefore `status --json`, same payload — carrying the flag.
4. **test/orchestrator.test.ts** — two sub-cases of this entry's acceptance list that the landed e2e does not pin: (a) start-already-paused — write the marker BEFORE `startLiveOrchestrator`; across several fast polls zero role ticks while a queued director prompt still runs; remove the marker and roles tick without restart (this is the "pause while stopped, then start" persistence bullet); (b) in-flight completion — a slow fake pi already in flight when the marker drops finishes its tick and lands its outcome even though no new one starts. Small additions to the existing file; either extend the landed e2e or add sibling tests.

Completion criteria for this entry: full suite green with build clean, every acceptance bullet above pinned by a test (or already audit-verified as structural), then move this entry to Done with a note citing the landing commit(s). No src/ changes are expected — if any residual turns out to require one, re-audit first; that would mean this note missed something.

**Done 2026-09-06 (plan loop) — audited against main `eca5c69` and moved from Planned; landed as planned at feature tick 103 (`9481eeb`) with its orchestrator e2e test added by coverage tick (`7c56ca1`) and this entry's own test-only tail completed at feature tick 106 (`b76fab1`); nothing remains.**

Audited on this tree (build clean, full suite 709/709): all four residual items from the 2026-09-06 refinement are pinned. test/cli.test.ts — idempotency and messaging with no harness running (`already paused` / `not paused` verbatim; the marker carries its timestamp and a repeat pause leaves it byte-for-byte untouched), unknown-argument rejection for both commands without touching the marker, and the optional live-wording split (a live orchestrator info file yields the ~2s effect without the stopped-harness tail). test/status-render.test.ts — `loopPhase` reads `paused` for idle and sleeping role loops while user-paused with in-flight ticks keeping their live detail; precedence over budget paused and main red (all three true still reads `paused`, as does user-paused + main-red without budget); render-level state cells ahead of both. test/gui.test.ts — the payload carries `paused` at the top level while the marker exists, the idle loop's phase reads `paused` ahead of budget paused with spend still at cap, and removing the marker falls back to `budget paused`. test/orchestrator.test.ts — both residual sub-cases on top of the landed mid-run e2e: start-already-paused (marker before startup → zero role ticks across several polls while a queued director prompt runs; resume unblocks without restart) and in-flight completion (a tick already running when the marker drops finishes, lands its change to main as `changed`, and no second tick starts). The src/ implementation was verified point for point by this entry's 2026-09-06 refinement against `b349f6d` and is unchanged since.

### Pre-flight environment check — `tumwater doctor` (planned 2026-09-05)

**Goal.** The harness's preconditions are scattered across fail-fast checks that each command re-runs on its own: `requireReadyRepo` in src/cli.ts walks git-binary → repo → tumwater.json → commits and stops at the first failure; `cmdRun` adds pi-on-PATH and orchestrator-alive; `loadConfig` throws with a problem list. A user facing a partially initialized or drifted environment gets one error at a time, and runtime-state problems (a stale merge lock) surface only mid-merge — so there is no single answer to "why can't I run this / why are my ticks failing". The README's *Notes on local model servers* section is a manual debugging guide; `tumwater doctor` codifies its deterministic half as one command: it runs every check, reports each result individually instead of stopping at the first failure, and exits 0/1 so it can be scripted (cron jobs, alerting) — the pre-flight sibling of `status --json`, which is a query of live fleet state while doctor is a verdict on the environment.

**Approach.**
- src/doctor.ts (new) — one module holding the checklist. Each check is an exported function taking `root` (and, for the binary checks, `pathEnv = process.env.PATH ?? ""`) and returning `{ level: "ok" | "warn" | "fail", detail }`, so tests exercise branches directly without spawning the CLI. A `runDoctor(root)` composes them in order; a renderer prints one line per check plus a header and a verdict line. Checks, all read-only against `.tumwater/` (works with or without a running harness):
  1. **git binary** — `findOnPath("git", pathEnv)`: ok with resolved path / fail with the existing `GIT_MISSING_MESSAGE`.
  2. **Repo ready** — reuse the already-exported git.ts predicates in `requireReadyRepo`'s order, reporting the first failure's existing message: not a git repo (`isGitRepo`) → no commits yet (`hasCommits`) → detached HEAD (`currentBranch` null); ok shows the branch name.
  3. **Initialized + config valid** — tumwater.json present and `loadConfig(root)` does not throw: ok with `<N> roles enabled` (`enabledRoleIds(config).length`) / fail carrying the thrown message verbatim (it already holds validateConfig's full problem list).
  4. **pi binary** — `findOnPath("pi", pathEnv)`: ok with resolved path / fail with cmdRun's existing install hint.
  5. **.tumwater writable** — absent: ok "absent — created on first run"; present: write and delete a temp file inside it, ok / fail.
  6. **Merge lock** (`.tumwater/merge.lock` via `mergeLockDir`) — absent: ok; pid file names a live process (`pidAlive`): ok "held by running loop (pid N)"; dead pid, or no readable pid past the grace window: warn "stale — will be broken on next merge". Read-only: extract lock.ts's three-case classification into a pure helper (e.g. `classifyLock(dir)` returning absent/live/stale) that both `tryBreakStale` and doctor use, so the cases cannot drift; doctor never removes anything.
  7. **Declared build check** — `detectBuildCheck(root)`: ok "npm <script> in <dir>" / ok-with-note "none declared — the review gate's deterministic pre-check will be skipped" (informational, not a warning: non-JS target projects are expected to have no npm scripts).
  - Header line carries orchestrator state via `orchestratorAlive` + the info file ("harness running (pid N)" / "not running"). Verdict line: `ready to run` when there is no fail, else `<n> problem(s)`; warnings never affect the exit code. The CLI sets `process.exitCode = 1` on any fail.
- src/cli.ts — new `doctor` case in the switch: no arguments (`rejectUnknownArgs("doctor", args, [])`), print the report to stdout. One HELP line alongside the others.
- src/lock.ts — extract the pure stale-classification helper shared with `tryBreakStale` (behavior unchanged; its tests keep passing).
- test/doctor.test.ts (new) — per-check ok/fail branches using `makeRepo()`/`tmpdir()` from test/util.ts. The binary checks take an explicit `pathEnv`, so "missing" is tested by passing `""` — no PATH mutation, no spawning.
- README.md — one line in the Usage block (`tumwater doctor   # pre-flight check: git, repo, config, pi, locks (exit 0/1)`). Do not touch the `tumwater:status` markers — that section is the readme loop's to keep current.

**Files touched.** src/doctor.ts (new), src/cli.ts, src/lock.ts, test/doctor.test.ts (new), README.md.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- In a ready repo with no harness running (this one qualifies): `tumwater doctor` exits 0, every check line is ok — including the build-check line naming `npm test` for this repo — and the final line reads `ready to run`.
- Each failure mode flips exactly its own line to fail and makes the exit code 1: empty `pathEnv` → git and pi lines fail with their existing messages; a temp dir without `.git` → repo line fails ("not a git repository"); a repo without tumwater.json → init line fails; an invalid tumwater.json → init line fails carrying validateConfig's problem list verbatim; a detached-HEAD fixture (`git checkout --detach`) → repo line fails.
- Lock branches: absent → ok; pid file naming the test process's own (live) pid → ok "held"; a dead pid → warn, exit code stays 0. Doctor leaves the lock directory byte-for-byte untouched (assert content and mtime unchanged after the run).
- Read-only guarantee: a full doctor run in a ready repo changes nothing under `.tumwater/` (snapshot the directory listing before and after); it works identically with or without a running harness.
- `doctor --x` is rejected as an unknown argument; running doctor outside a git repo prints fail lines rather than throwing.
- No new config keys, no new event types, no changes to loop/orchestrator/review behavior. Out of scope by design: no pi version probe, no model-server checks (network-dependent), and never running the project's build/test — that can take minutes and belongs in the review gate / red-main check, not a pre-flight.

**Relationship to other plans.** Complements `tumwater status --json` (done 2026-09-05): same scriptability motivation, different question — doctor verdicts on the environment, `status --json` queries live fleet state. Pairs with the red-main baseline check (done 2026-09-05) by reporting *which* verify script will run without running it. Single entry: all checks share one command's output and exit-code semantics, so they do not decompose into independently shippable plans.

**Done 2026-09-06 (plan loop) — audited against main `b98e7f8` and moved from Planned; landed as planned at feature tick 101 (`784d487`) with its test suite completed by coverage tick (`be36b71`); nothing remains.**

Audited this run: src/doctor.ts holds the checklist exactly as planned (each check an exported function returning `{ level, detail }`, composed in order by `runDoctor`), lock.ts's three-case classification is the shared pure helper `classifyLock` used by both `tryBreakStale` and doctor so the cases cannot drift, cli.ts carries the no-argument `doctor` case plus its HELP line, test/doctor.test.ts covers every check branch (landed separately at coverage tick `be36b71`), and README.md's Usage block has the one planned line. Live run in this repo with no harness running: exit 0, all seven check lines ok — the build-check line names `npm test` — final line `ready to run`; `doctor --x` is rejected as an unknown argument. Full suite green at `b98e7f8`: 677/677, build clean.

### Machine-readable fleet state — `tumwater status --json` (planned 2026-09-05, done 2026-09-05)

**Goal.** Every observation surface is human-facing: the `status` table, the TUI, and the GUI. The only JSON surface is the GUI's `/api/status`, which requires starting a server bound to a port — so an unattended fleet has no scriptable one-shot health check that works while the harness is NOT running (cron jobs, alerting on "budget paused" or repeated error results, CI-style verification of open plans/bugs). Add `--json` to `tumwater status`: the same document `/api/status` serves, printed to stdout with no server — a fleet query that reads from disk exactly like the table does.

**Approach.**
- src/gui.ts — unchanged: `statusPayload(root)` is already exported and is the single definition of fleet state as JSON (running/pid/inbox/inboxPrompts/budget/loops with phase + per-tick metrics/events/plans/bugs/questions). Reuse it verbatim so the CLI flag and the GUI endpoint cannot drift; no new serializer.
- src/cli.ts — in the `status` case: extend `rejectUnknownArgs("status", args, [])` to accept `{ names: ["--json"] }`; when present, print `JSON.stringify(statusPayload(root), null, 2)` plus a trailing newline instead of calling renderStatus (add statusPayload to the existing gui.js import). Keep `requireReadyRepo` ahead of both paths. Exit code stays 0 on any successful read — this is a query, not a health verdict: scripts interpret fields themselves, and a stopped fleet reads as `"running": false`, which is exactly what a monitor must distinguish from a CLI failure (exit ≠ 0).
- test/cli.test.ts — the strict-args test currently pins `["status", "--json"]` to fail with "takes no arguments" (~line 463); drop that case from the rejection list. Add: in a ready repo, `status --json` exits 0, stdout parses as JSON, carries the top-level fields above plus per-loop role/phase/ticks/commits/generated/peakCtx/costUsd/todayUsd/lastResult/lastSummary/lastTickEndedAt, and deep-equals `statusPayload(root)` for the same root; bare `status` still renders the table unchanged; a misspelled flag (`--jsonn`) still fails with "unknown argument".
- README.md — one line in the Usage block: `tumwater status --json   # machine-readable fleet state (same payload as the GUI's /api/status)`.

**Files touched.** src/cli.ts, test/cli.test.ts, README.md.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- In a ready repo, `tumwater status --json` exits 0 and prints valid JSON (parseable by JSON.parse) whose top level carries running/pid/inbox/inboxPrompts/budget/loops/events/plans/bugs/questions — the same document GET /api/status serves for that root (deep-equal after parsing; only indentation differs).
- Works with or without a running harness: with none, `"running": false` and no pid, while per-loop rows still render from state files (same as the table path).
- `tumwater status` without the flag renders the existing table byte-for-byte unchanged; unknown flags are still rejected (`status --jsonn` → "unknown argument").
- No new config keys, no new event types, no changes to gui.ts or status.ts.

**Relationship to other plans.** Complements the done Web GUI plan (2026-08-20): same payload, no server required. Independent of the red-main baseline check — when that lands, its `main_red` result and phase label appear in this output automatically through statusPayload's loops array; no interaction needed.

**Done 2026-09-05 (feature tick) — implemented as planned against main `943d4f6`; nothing remains.**
Audited first: at `943d4f6` no part had landed — src/cli.ts's status case ran `rejectUnknownArgs("status", args, [])` and always rendered the table, and test/cli.test.ts pinned `["status", "--json"]` to fail with "takes no arguments" in its strict-args test. This tick implemented the plan as written: the status case now accepts `{ names: ["--json"] }`, keeps requireReadyRepo ahead of both paths, and when the flag is present prints `JSON.stringify(statusPayload(root), null, 2)` plus a trailing newline — statusPayload added to the existing gui.js import, no new serializer, so the CLI flag and the GUI endpoint cannot drift; exit code stays 0 on any successful read (a query, not a health verdict). The HELP text's status line documents the flag like every other command's. test/cli.test.ts dropped `["status", "--json"]` from the strict-args rejection list and gained one contract test: in a ready repo with seeded counters, `status --json` exits 0, stdout parses as JSON carrying all top-level fields (running/inbox/inboxPrompts/budget/loops/events/plans/bugs/questions — pid absent while no harness runs), every loop row carries role/phase/ticks/commits/generated/peakCtx/costUsd/todayUsd/lastResult/lastSummary/lastTickEndedAt, the seeded counters surface verbatim (ticks 7 / commits 3 / generated 424242 / costUsd 1.5), and the parsed document deep-equals a JSON round-trip of `statusPayload(root)` for the same root; bare `status` still renders the table unchanged, and `--jsonn` fails with "unknown argument". README.md gained the one Usage line per plan. Verified on this tree: build clean, full suite 654/654 — main at `943d4f6` runs 653/653 (measured in a detached worktree), so this tick adds exactly one test. Files: src/cli.ts, test/cli.test.ts, README.md, PLANS.md.

### Red-main baseline check — skip authoring runs while main is red (planned 2026-09-04, refined 2026-09-05, done 2026-09-05)

**Goal.** BUGS.md's Fixed history carries nine "build/tests red on main" entries between 2026-08-27 and 2026-09-03; the deterministic pre-merge gate now stops most of them at merge time, but a red main can still arise (human commits, edge cases), and today's behavior when it does is pure waste with no signal: every gated role tick burns a full pi authoring run on top of red main, then gets rejected deterministically by the gate's pre-check (worktree = red main + changes → `npm test` fails). Seven code-producing roles repeat this cycle on their own intervals while markdown-only roles keep landing — so the fleet looks partially alive in status/TUI/GUI while all code work silently fails, and only a careful reader of tick_end events notices. Verify main once per new SHA before spending an authoring run on top of it: while red, skip authoring for code-producing roles (normal backoff), log one warning event per red SHA, and surface the blockage in both dashboards — so the fleet stops burning guaranteed-to-fail runs and a human sees at a glance why nothing is landing.

**Approach.**
- src/types.ts — add `"main_red"` to TickResult (comment: baseline check found main's build/test suite red; authoring run skipped, code merges blocked until main is green). No other type changes: applyTickOutcome has no exhaustive switch over the variant set, so it falls through to its default else branch → normal idle backoff. No state.ts change.
- src/build-check.ts — fleet-shared baseline cache plus one-shot check:
  - Module-level `Map<sha, "green" | "red">` with last-red details (script name, clipped tail) and an in-flight dedup map (`Map<sha, Promise>`) so concurrent ticks on the same new SHA run the check once. In-memory only: after a restart the cache is cold and one re-check per red SHA happens — cheap and deterministic, mirroring the budget gate's stateless resume.
  - Exported helper `checkMainBaseline(wt)`: key by worktree HEAD (= main head right after reset); on cache hit return immediately; on miss run detectBuildCheck + runBuildCheck in wt (pristine main) and cache. Returns null when no build check is detected (nothing to verify → nothing to block on, consistent with the gate skipping its pre-check) or when the run comes back `skipped` (timeout/no-npm — warn and proceed, same semantics as the gate's pre-check skip; never cache red). Reuse clipBuildTail for the stored tail.
- src/roles.ts — named constant listing the roles blocked while main is red: feature, organize, coverage, clean, dry, perf, improve — every role whose diff can carry non-exempt (code) changes. Comment the exemptions: director (human prompts outrank autonomous gates, like the budget gate), bugfix (the designated healer — its tick runs the suite per "leave the project working" and can fix a red main, landing the fix through the existing pre-merge gate; blocking it would leave only humans able to unblock the fleet), plan/readme/steward (markdown-only charter; their diffs are exempt from the build pre-check via review.exemptPaths, so a red main does not block them).
- src/loop.ts — hook in `runTick()`: on the fresh-tick path where the worktree was just reset to pristine main (the else branch after recoverLeftover), before starting pi: if this role is in the blocked set → call checkMainBaseline; on "red" → log one harness-level `main_red` warning event per newly-discovered red SHA per process (module-level lastRedSha guard alongside the cache; message carries short sha, script name, and the clipped tail's first line) and return a main_red outcome with summary "code merges blocked until main is green" — no pi run starts. On "green"/null → proceed as today. The resume path (interrupted tick) skips the check entirely: its worktree holds half-finished edits, not pristine main, so a baseline measured there would be wrong; one extra run in that edge case is acceptable. Leftover-recovery ticks (leftForRetry) also skip — they route through the gate anyway, which fails closed against red main.
- src/status-render.ts — `loopPhase`: next to the budgetPaused check (after the director exemption), an idle loop with `s.lastResult === "main_red"` shows `main red` instead of sleep/queue. Per-loop derivation from persisted state; self-correcting, because each blocked tick re-records main_red while red and a green wake overwrites it. Both dashboards get this for free — the GUI's /api/status payload carries the precomputed phase, and gui-page.ts renders `l.phase` and `l.lastResult` generically (no GUI change). The last-result column already renders any result string → "main red — code merges blocked until main is green" appears in TUI, GUI, and `logs -f` with no further wiring.
- src/event-format.ts — only if the new harness `main_red` event or the tick_end line needs a dedicated case (harness warning events format generically today; verify at implementation and keep generic if it reads fine).

**Files touched.** src/types.ts, src/build-check.ts, src/roles.ts, src/loop.ts, src/status-render.ts, src/event-format.ts (only if needed), test/build-check.test.ts, test/loop.test.ts, test/status-render.test.ts.

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- No pi run starts for a blocked role while the current main SHA is cached red (fake-shim invocation count stays 0); exactly one harness-level `main_red` warning event per newly-red SHA per process, carrying script name and clipped first line of failure output; repeated skips on the same SHA read the cache without re-running npm test.
- Exempt roles (director, bugfix, plan, readme, steward) tick normally even when main is known red — including bugfix, which can fix the suite and land the fix through the existing pre-merge gate.
- Recovery: after a green landing moves main, the "main moved" wake re-checks the new SHA immediately (no waiting out backoff) and blocked roles resume; while main stays red, skips continue with normal idle backoff.
- No declared build check → behavior unchanged (nothing to block on); a `skipped` check outcome (timeout/no-npm) warns and proceeds with authoring, never caching red.
- Observable in dashboards: blocked idle loops show a "main red" state cell plus the last-result line; the event feed shows the warning — visible in TUI, GUI, and `logs -f`.

**Relationship to other plans.** Complements the done plan "Run the project's own test suite in the deterministic pre-merge gate": that one gates merges (worktree = main + changes); this one gates authoring spend on top of a broken main, reusing its detectBuildCheck/runBuildCheck/clipBuildTail machinery. The budget-paused state cell is the surfacing precedent (plans/daily-cost-budget.md). Independent of the other Planned entry (steward curation of BUGS.md's Fixed history); either can land first.

**Refined 2026-09-05 (plan loop) — audited against main `bc9a642`; the feature landed at tick 98 (`377cf0f`) but left one pre-existing test broken, so this entry stays Planned until that test is fixed.**

Verified as landed at `377cf0f`, matching this entry's Approach point for point: src/types.ts carries "main_red" in TickResult; src/build-check.ts exports checkMainBaseline with the per-SHA Map cache and in-flight dedup (null when no build check is detected, never caching a skipped run); src/roles.ts defines BASELINE_BLOCKED_ROLES = feature, organize, coverage, clean, dry, perf, improve with the director/bugfix/markdown-role exemptions commented; src/loop.ts hooks it on the fresh-tick path after the worktree reset (resume and leftover-recovery paths skip) and returns `{ result: "main_red", summary: "code merges blocked until main is green" }` before any pi run, logging one harness warning per newly-red SHA; src/status-render.ts shows a "main red" phase for idle loops whose lastResult is main_red. Tests landed in test/build-check.test.ts, test/loop.test.ts (the makeMainRed/approvingPi block), and test/status-render.test.ts.

The residual: the pre-existing test "a change whose build fails is rejected by the pre-check and its compiler tail rides on the next prompt" (test/loop.test.ts:1408) predates this feature and was not updated for it. Its fake repo declares an unconditionally failing build script (`buildcheck-tool --fail`, always exit 1), so pristine main fails the declared check too — checkMainBaseline therefore returns red before pi starts, and the tick ends "main_red" instead of reaching the gate's pre-check rejection path this test exists to verify. Deterministic: full suite is 648/649 on main (verified at `bc9a642`; build clean). The baseline gate itself behaves exactly as designed — the fake repo genuinely has a red main and "improve" is blocked; nothing in src/ is wrong.

Fix (test-only, one line plus a comment): in that test, construct the runner with a baseline-exempt role — `new LoopRunner(repo, "bugfix", defaultConfig(), "main")` instead of "improve". bugfix is exempt from BASELINE_BLOCKED_ROLES (the designated healer), so no baseline check runs; pi creates broken.ts as before; the gate's pre-check fails deterministically and rejects with the compiler tail; tick 2 reads no_change. Every existing assertion holds unchanged — none references the role name, and the rejection-note injection is role-agnostic. Add a comment at the change site: this test isolates the gate's pre-check from the red-main baseline gate (the main_red interaction is covered by the makeMainRed tests below it). Do NOT instead make buildcheck-tool fail conditionally on broken.ts existing: npm runs scripts with cwd = package.json's directory (the repo root), not the invocation/worktree directory, so a cwd-relative file check cannot see the worktree change without hardcoding `.tumwater/worktrees/<role>/` into the fixture — fragile and it obscures what is under test.

Completion criteria for this entry: full suite green (649/649) with build clean; the updated test still pins rejected + tail-on-next-prompt + exactly two author runs; then move this entry to Done with a note citing the fix commit.

**Done 2026-09-05 (readme tick) — recorded after the fact; implemented by feature tick 98 (`377cf0f`) against main `7fd76cd`; nothing remains.**
The residual from the Refined note was fixed by perf tick 90 (`e7ef65c`), which is what made main green again: that test's fake buildcheck-tool now fails only while broken.ts exists, and package.json is committed in the fixture repo so git worktrees check it out and npm re-roots `npm run` at the worktree — resolving exactly the cwd concern the Refined note raised against a conditional tool (the script's cwd becomes the worktree rather than the repo root), keeping pristine main green while the pre-check still sees the failure. Audited at main `e7ef65c`: src/build-check.ts exports checkMainBaseline with a per-SHA green/red cache, in-flight dedup, and skip reasons for no-npm/timeout (never caching red); src/roles.ts names BASELINE_BLOCKED_ROLES — feature, organize, coverage, clean, dry, perf, improve — with the director/bugfix/plan/readme/steward/qa exemptions commented; src/loop.ts fresh-tick path calls it on pristine main before starting pi and returns a main_red outcome plus one harness-level warning per newly-red SHA (resume and leftover-recovery ticks skip by construction); src/status-render.ts shows an idle loop whose lastResult is main_red as "main red" in both dashboards. Tests: test/build-check.test.ts, test/loop.test.ts, test/status-render.test.ts. Verified on this tree: build clean, full suite 652/652.

### Steward curation of BUGS.md's Fixed history — compress old fixed bugs to one-line records (planned 2026-09-04, refined 2026-09-04, done 2026-09-05)

**Goal.** BUGS.md is ~59KB and `## Fixed` (~31 entries, newest first) is most of it: every bugfix tick appends a full Symptom/Repro/Cause/Fix entry and nothing prunes them — the same unbounded growth as PLANS.md's Done section (sibling plan above), with the same fix pattern proven by the README status contract. Recent fixes stay verbatim because they carry regression-test names and root-cause detail that bugfix loops consult when related bugs surface; older ones compress to one-line records preserving headline, the heading's own dates, and the landing commit where one exists.

**Approach.**
- src/roles.ts — extend the steward's find text with a Fixed-section clause (same policy shape as its Done-section sibling: ten-entry verbatim window, one curation move per tick, lossy on purpose with git history as the archive):
  - Keep the ten most recent `## Fixed` entries verbatim (newest first).
  - Compress older entries to one line each: `- <symptom headline> (<the heading's own date clause>; commit <sha>)`. The date clause is copied from the entry's heading as-is — BUGS.md headings vary across found/reported/re-recorded × fixed/closed/resolved (only 14 of today's 31 match a single `found …, fixed …` form), so do not normalize or fabricate; when a heading carries no dates at all, omit that part of the line.
  - The commit hash is the entry's LANDING commit — the one that merged the fix to main — found in this order: (1) an explicit landing citation in the entry body (the "tick N (`sha`)" form naming the fix commit itself); (2) git log on main, whose self-explaining subjects name the role and describe the change. Never use a verification reference as the record's hash — "Verified … on main `<sha>`" or "at HEAD `<sha>`" is main's state at check time, not the fix; bodies that cite several shas (break commit, fix commit, verification HEAD) need the one cited as having landed the fix. When no landing commit exists — entries closed without code change say so in their `**Resolution:**` note — omit the `commit` field rather than guess.
  - Never compress an entry carrying a standing `**Refused …**` note (a refused "bug" is a durable objection — same rule as PLANS.md); such entries stay full.
- test/prompt.test.ts — extend the steward contract block with the Fixed-section clauses: window size; one-line form preserving headline and the heading's date clause verbatim, commit field only when resolvable (with the verification-reference exclusion); Refused guard.

**Files touched.** src/roles.ts, test/prompt.test.ts. (BUGS.md itself shrinks on subsequent steward ticks — not this plan's implementer.)

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- Contract tests assert each clause with whitespace-collapsed matching: window size, one-line form fields (headline preserved, date clause verbatim, commit only when resolvable), Refused guard.
- Safe for harness readers by construction: parseEntries only reads `## Open`, so compressing Fixed entries cannot change dashboard counts.
- Observable within a few steward ticks after landing — not this plan's implementer: `## Fixed` holds at most ten full entries, older ones are one-liners carrying headline and the heading's own dates plus a landing hash where one exists, and BUGS.md drops from ~59KB toward the Open-plus-window size (tens of KB).

**Relationship to other plans.** Sibling: "Steward curation of PLANS.md's Done history" — same policy shape; independently implementable in either order. Note for that sibling's implementer: its hash clause ("hashes from its Done note") carries the same verification-reference subtlety corrected here — a Done note's "against main `<sha>`" is a base reference, not the landing commit(s); apply the same priority (explicit landing citation → git log; never a main-state reference). Complements the planned section-aware tick reads rule as its sibling does (whole-file steward reads stay cheap once on-disk size is bounded).

**Refined 2026-09-04 (plan loop) — audited both sourcing clauses against BUGS.md's actual Fixed entries; the rigid template and the hash fallback did not match the file.**
At `73c9e87` all thirty-one `## Fixed` headings were checked: date-clause labels span found/reported/re-recorded × fixed/closed/resolved (only 14 of 31 match the original `(found YYYY-MM-DD, fixed YYYY-MM-DD)` form), and one heading appends a note inside its parentheses — so the template could not be produced verbatim for most entries; the date clause is now copied as-is. For hashes: 24 of 31 entry bodies carry no backticked sha at all (git log is the primary source in practice, not the fallback), and of the seven that do, several cite multiple commits in mixed roles — break commit, fix commit, verification HEAD ("Verified … on main `<sha>`") — so a priority order with an explicit exclusion replaces "hash from its Fix note (git log when absent)"; four entries closed without code change have no landing commit and now omit the field. The shared policy shape is inlined so this entry stands alone for a fresh-session implementer; the sibling's hash clause is flagged, not edited, as carrying the same subtlety.

**Done 2026-09-05 (feature tick) — implemented as planned against main `6164a6d`; nothing remains.**
Audited first: at `6164a6d` no part had landed — src/roles.ts's steward find text carried only the Done-section clause (landed at `81c50a2`) and no Fixed-section clause, test/prompt.test.ts's steward contract block had no Fixed assertions, and BUGS.md was 58,906 bytes with exactly thirty-one `## Fixed` entries and an empty `## Open`, matching this entry's audit. This tick extended the steward find text in src/roles.ts with the Fixed-section curation policy: keep the ten most recent `## Fixed` entries verbatim (newest first); compress older ones to one line each — `- <symptom headline> (<the heading's own date clause>; commit <sha>)` — headline from the entry's heading, date clause copied from that heading as-is (headings vary across found/reported/re-recorded × fixed/closed/resolved and may carry notes inside their parentheses; do not normalize or fabricate dates; when a heading carries no dates at all, omit that part of the line); the commit is the entry's LANDING commit — an explicit landing citation in the entry body (the "tick N (`<sha>`)" form naming the fix commit itself), else git log on main — never a verification reference ("Verified … on main `<sha>`", "at HEAD `<sha>`"), and omit the `commit` field when no landing commit exists (an entry closed without code change says so in its **Resolution:** note); never compress an entry carrying a standing **Refused …** note; compression is lossy on purpose with git history as the archive, one curation move per tick still holds. test/prompt.test.ts gained five contract tests in the steward block (oneLine-based like their Done-section neighbors): the ten-entry verbatim window for `## Fixed`; the exact one-line form preserving headline and date clause as-is plus the no-dates omission; hash-sourcing priority with the verification-reference exclusion and omit-when-unresolvable; the Refused-note guard; and the shared-rules carry-over. Verified on this tree: build clean, full suite 632/632 in ~49 s — main at `6164a6d` contributes the other 627 (this tick adds exactly five tests; the README's 626 stamp predates coverage tick `6164a6d`'s one added test). The entry's residual acceptance criterion — `## Fixed` holding at most ten full entries with older ones as one-line records within a few steward ticks (~6 h clock), and BUGS.md dropping from ~59KB toward the Open-plus-window size — is not this plan's implementer. Files: src/roles.ts, test/prompt.test.ts, PLANS.md.

### Steward curation of PLANS.md's Done history — compress old done plans to one-line epitaphs (planned 2026-09-04, done 2026-09-04)

**Goal.** PLANS.md is ~183KB and `## Done` (~31 entries, newest first) is most of it: every feature tick appends a "Done …" note to its entry, plans accumulate days of refinement notes, and nothing prunes them. The planned section-aware tick reads rule bounds per-tick prefill so role loops stop paying for this history — but on-disk size still grows without bound: the steward must read the file whole (its carve-out in that rule), every worktree reset copies it, and a human cannot find anything in 2100 lines of done plans. The README status plan already proved the pattern ("git history *is* the archive"); this entry extends it to `## Done`: give the steward an explicit compression policy so the section stays small by construction — recent entries verbatim, older ones compressed to one-line epitaphs that keep everything cross-references need (title, dates, landing commit hashes).

**Approach.**
- src/roles.ts — extend the steward's find text with a Done-section clause. The existing "delete or merge stale/duplicative/superseded PLANS.md entries" move covers Planned-section hygiene and stays as-is; this adds tail compression:
  - Keep the ten most recent `## Done` entries verbatim (newest first, by position in file).
  - Compress older entries to one line each: `- <title> (planned YYYY-MM-DD, done YYYY-MM-DD; commit(s) <sha>[, <sha>])` — title and dates from the entry's heading, hashes from its Done note (git log when absent). The one-line form keeps every existing cross-reference resolvable: references cite titles or commit hashes, both preserved.
  - Never compress an entry carrying a standing `**Refused …**` note — the objection stands until a human or director edits it, and compression would bury it; such entries stay full (they are rare).
  - Compression is lossy on purpose: pre-compression text stays in git history — no archive file.
  - "One curation move per tick" still holds: one steward tick compresses one section's overflow (or makes any other planned move) — with ~31 Done entries the first few ticks each shrink the file by tens of KB until the window is reached, then it stays bounded.
- test/prompt.test.ts — extend the existing steward contract block (`const steward = roleById("steward")`, `oneLine(steward.find)` matching): the ten-entry verbatim window; the one-line epitaph form naming title, dates, and commit hashes; the Refused-note guard; git history as the archive.

**Files touched.** src/roles.ts, test/prompt.test.ts. (PLANS.md itself shrinks on subsequent steward ticks under the new policy — not this plan's implementer.)

**Acceptance criteria.**
- `npm run build` clean; full suite green.
- Contract tests assert each clause of the new find text with whitespace-collapsed matching: window size, epitaph form fields, Refused guard.
- Safe for harness readers by construction: src/backlog.ts's parseEntries only reads `## Planned`/`## Open`, so compressing Done entries cannot change dashboard counts (a test already pins that Done/Fixed never leak in).
- Observable within a few steward ticks (~6 h clock) after landing — not this plan's implementer: `## Done` holds at most ten full entries, older ones are one-line epitaphs carrying title/dates/hashes, and PLANS.md drops from ~183KB toward the Planned-plus-window size (tens of KB); no Refused-note entry is ever compressed.

**Relationship to other plans.** Sibling: "Steward curation of BUGS.md's Fixed history" — same policy shape, different file and retention fields; independently implementable in either order. Complements the planned section-aware tick reads rule: that rule bounds per-tick prefill (loops read only actionable top sections) and carves the steward out to read files whole; this policy keeps those whole-file reads cheap by bounding on-disk size. The two land independently — curation is valuable before the read rule, and the read rule is valuable without curation.

**Done 2026-09-04 (feature tick) — implemented as planned against main `ac574d4`; nothing remains.**
Audited first: at `ac574d4` no part had landed — src/roles.ts's steward find text still carried only the original move list with no Done-section clause, and test/prompt.test.ts's steward contract block had no window/epitaph/guard assertions. This tick extended the steward find text with the Done-section curation policy: keep the ten most recent `## Done` entries verbatim (newest first, by position in file); compress older ones to one line each — `- <title> (planned YYYY-MM-DD, done YYYY-MM-DD; commit(s) <sha>[, <sha>])` — title and dates from the entry's heading; never compress an entry carrying a standing `**Refused …**` note (such entries stay full); compression is lossy on purpose with git history as the archive; one curation move per tick still holds. One deliberate deviation from the Approach, applying the correction its sibling plan flagged for this entry: the hash clause no longer says "hashes from its Done note" — audited at `ac574d4`, recent Done notes cite a base reference ("against main `<sha>`"), an explicit landing citation (the "tick N (`<sha>`)" form), or no sha at all, so the original wording would have recorded base references as landing hashes. The find text now sources hashes in priority order: an explicit landing citation in the entry body, else git log on main; never a verification or base reference ("Verified … against main `<sha>`", "at HEAD `<sha>`"); and when no landing commit exists, omit the commit(s) field rather than guess. test/prompt.test.ts gained five contract tests in the steward block (oneLine-based like its neighbors): the ten-entry verbatim window; the one-line epitaph form with title/dates/commit(s); hash sourcing priority with the verification-reference exclusion and omission-when-unresolvable; the Refused-note guard; lossy-on-purpose with git history as the archive. Verified on this tree: build clean, full suite 626/626 (main at `ac574d4` runs 621/621; +5 new tests). The entry's residual acceptance criterion — `## Done` holding at most ten full entries with older ones as one-line epitaphs within a few steward ticks (~6 h clock) — is not this tick's to verify. Files: src/roles.ts, test/prompt.test.ts, PLANS.md.

### Section-aware tick reads — stop paying for history every tick (planned 2026-09-04, done
2026-09-04)

Every loop's prompt says "First read README.md, PLANS.md, BUGS.md, and QUESTIONS.md (those that exist) to understand the project" (the two-line rule at the top of `COMMON_RULES` in src/prompt.ts), so each tick re-reads the backlog files whole. They grow without bound: PLANS.md is now 177KB with only ~17KB actionable — `## Planned` ends at line 116 and everything below is Done history — and BUGS.md is 59KB whose `## Open` section is currently empty, the rest being Fixed history. Recent pi logs show the feature loop offset-reading ALL of PLANS.md in every recent session (offsets up to ~line 1830 of 2126) while only its top matters for picking a plan; bugfix does the same for BUGS.md, and the plan loop reads it all too. That is roughly 45k tokens/tick for feature and plan and ~15k for bugfix spent on history no role needs to act on — concentrated in exactly the loops that run most often when there is work to do (hygiene roles mostly `head` the files, which is already cheap).

Fix it at the prompt level, where the reading behavior lives: rewrite that one COMMON_RULES line into a section-aware rule. README.md read in full; PLANS.md and BUGS.md never read wholesale — their actionable sections come first by template convention (init.ts puts `## Planned` before `## Done`, `## Open` before `## Fixed`), so read the top of each file (Planned plus recent Done; Open plus recent Fixed) and consult older history via git log or a targeted read only when a specific entry is needed; QUESTIONS.md as today. Add an explicit carve-out for the steward role, whose job is curating those files and which must see them whole. No roles.ts changes are needed: every role's find text already names what it opens ("Open PLANS.md and pick…", "Open BUGS.md and pick…") — the diet governs how much of each file gets read, not which files.

Relationship to other plans: this complements rather than duplicates the deferred curation siblings noted under the README status plan (steward compression of Done/Fixed). Curation bounds on-disk size; this rule bounds per-tick prefill, keeping it flat as history grows even before any curation lands. It also pairs with the pending "Bound README's status section" entry — same theme (prompt/prefill cost), different file: that one rewrites roles.ts's readme find text, this one rewrites prompt.ts's COMMON_RULES; no overlap.

Files touched: src/prompt.ts (the two-line "First read…" rule in `COMMON_RULES`); test/prompt.test.ts (update the existing contract assertion at ~line 368 that pins the old wording — `/First read README\.md, PLANS\.md, BUGS\.md, and QUESTIONS\.md/` — to pin the new clauses instead, oneLine-based like its neighbors).

Acceptance criteria:
- `npm run build` clean; full suite green.
- Contract tests assert each clause of the new rule in a tick prompt: README read in full; PLANS.md/BUGS.md not read wholesale with their actionable sections first; older history via git log or targeted reads; steward carve-out present.
- Observable within a few ticks after landing: feature, bugfix, and plan loops' peak ctx drops substantially (feature from ~90k toward README+Planned size) in the status table's "peak ctx" column and per-role pi logs, with hygiene roles unchanged or lower — steady-state prefill no longer scales with Done/Fixed history.

**Done 2026-09-04 (feature tick) — implemented as planned against main `ad72f37`; nothing remains.**
Audited first: at `ad72f37` no part had landed — src/prompt.ts's COMMON_RULES still carried the old two-line "First read README.md, PLANS.md, BUGS.md, and QUESTIONS.md (those that exist)" rule, test/prompt.test.ts still pinned that wording in its single read-first assertion (~line 369), and init.ts confirmed the template convention the rule relies on (`## Planned` before `## Done`, `## Open` before `## Fixed`). This tick rewrote that one COMMON_RULES line into the section-aware rule: README.md read in full (plus QUESTIONS.md when present); PLANS.md and BUGS.md never read wholesale — their actionable sections come first by template convention, so only the top of each file is read (Planned plus recent Done entries, Open plus recent Fixed ones); older history via git log or a targeted read only when a specific entry is needed; and an explicit carve-out for the steward role, which curates those files and must see them whole. No roles.ts changes: every role's find text already names what it opens — the diet governs how much of each file gets read, not which files. test/prompt.test.ts's old single-assertion test was replaced by a clause-by-clause contract block (oneLine-based like its neighbors) pinning all four clauses in a tick prompt: README-in-full with QUESTIONS.md kept in the read set; never-wholesale with the template-convention ordering and top-of-file scope; older history via git log or targeted reads only when a specific entry is needed; and the steward carve-out. Verified on this tree: build clean, full suite 616/616 — measured on both sides (main at `ad72f37` also runs 616/616; this tick replaces one test with one). The entry's residual acceptance criterion — feature, bugfix, and plan loops' peak ctx dropping within a few ticks of landing — is not this tick's to verify; it will be observed in the status table's "peak ctx" column and per-role pi logs as those loops run. Files: src/prompt.ts, test/prompt.test.ts, PLANS.md.

### Bound README's status section — state, not log (planned 2026-09-03, done 2026-09-04)

**Goal.** The initial prompt says "First puts the initial prompt and project status into
README.md" — but the status section has drifted from *state* to *log*. It is now a single ~38.7KB
paragraph in a 52KB README (the file grew 13× in two weeks, 4KB → 52KB), accumulating per-tick
landing narrative ("Since then: X landed…") on every readme sync. Every loop's prompt says "First
read README.md", so each tick of all thirteen loops pays that cost in prefill — ~10k+ tokens of
non-actionable history, growing without bound, so per-tick cost grows forever for a fleet meant
to run for weeks. The narrative is redundant: PLANS.md's Done entries and BUGS.md's Fixed entries
carry the same landings with more detail (commit hashes, audits), and git log preserves every
version of README — no archive file is needed; git history *is* the archive. Fix: make the status
section a snapshot of current state that each sync rewrites wholesale instead of appending to, so
it stays small by construction.

**Approach.**
- src/roles.ts — rewrite the readme role's find text (today: "Update the status section … to
  reflect reality: what works, what is in progress, how to build/run/test") into an explicit
  contract:
  - The status section (between the tumwater:status markers) describes CURRENT STATE ONLY and is
    rewritten wholesale on each sync, never appended to: (a) a one-line version/capability summary
    (which commands exist, which roles are enabled), (b) open items — planned features not yet
    done, open bugs, open questions, one line each or "none", (c) the existing freshness-stamp
    convention (`Current main (\`<sha>\`): build clean, suite N/N`).
  - No per-tick landing narrative in the section: landings are recorded by their owning loops in
    PLANS.md/BUGS.md and git log — stale narrative found in the section is deleted as part of
    updating it (that is an update, not a loss).
  - Drift guard: if the section exceeds ~8KB it has drifted back into narrative — prune it to the
    state-only form above.
  - Keep the existing constraints: PRINCIPLES.md belongs to director/steward; never edit the
    tumwater:prompt block; "if the README is already accurate (including its freshness stamp),
    there is nothing to do" — a moved main makes the stamp stale, so syncs still run after landings.
- test/prompt.test.ts — a sibling contract block following the steward pattern (`const readme =
  roleById("readme")`, matching `oneLine(readme.find)` so assertions are reflow-robust): the
  rewrite-wholesale-not-append rule; the state-only content spec (capability summary, open items,
  freshness stamp); the no-narrative rule naming PLANS.md/BUGS.md and git log as where landings
  belong; the ~8KB drift guard. Also convert the existing readme assertion ("the readme role leaves
  PRINCIPLES.md to the director and steward", which matches a literal `\n` inside the find text)
  to match against `oneLine(...)` so the rewrite cannot break it on reflow.
- Transition (NOT this plan's implementer): the first readme sync after landing rewrites the
  current ~38KB paragraph into state-only form — a large md-only diff, review-exempt; the
  pre-collapse text stays in git history.

**Files touched.** src/roles.ts, test/prompt.test.ts. (README.md itself changes on a subsequent
readme tick under the new contract.)

**Acceptance criteria.**
- Contract tests (test/prompt.test.ts): the readme find text carries all four clauses —
  rewrite-wholesale-not-append; state-only content spec naming capability summary, open items,
  and freshness stamp; no-narrative rule with landings belonging in PLANS.md/BUGS.md and git log;
  ~8KB drift guard — each matched with whitespace collapsed; the existing readme assertion passes
  against the rewritten text.
- Build clean, full suite green.
- Transition verified by observation on a subsequent readme tick (not this plan's implementer):
  within a few readme ticks of landing, the status section is under 8KB and carries no per-tick
  landing narrative — only capability summary, open items, and freshness stamp; git log preserves
  the pre-collapse paragraph.

**Sibling concern, deliberately not planned here.** PLANS.md (~160KB) and BUGS.md (~57KB) carry
the same unbounded-history growth in their Done/Fixed sections, which every tick also reads. They
decompose into separate entries with different owners (steward curation for PLANS.md;
bugfix/steward for BUGS.md) and different policies (e.g. compressing a Done entry must wait until
nothing remains), and this README case is the sharpest instance to prove the pattern first —
revisit once it has landed.

**Refined 2026-09-03 (plan loop) — audited against current main (`548168d`); the transition
already landed ahead of this plan, so the goal is reframed from collapse to durability.**
Verified at `548168d`: every structural claim in the Approach still holds — src/roles.ts's readme
find text is byte-identical to what the entry quotes ("Update the status section … to reflect
reality: what works, what is in progress, how to build/run/test"); test/prompt.test.ts has no
readme contract block yet; its `oneLine` helper sits at line 326 and the steward pattern it tells
the implementer to follow (`const steward = roleById("steward")`, assertions on
`oneLine(steward!.find)`) is exactly as described (lines ~509–548); and the existing readme
assertion ("the readme role leaves PRINCIPLES.md to the director and steward", lines 182–185)
still matches a literal `\n` inside the find text, so the oneLine conversion is still required.
What changed: the Goal's size claims are stale. The transition this entry anticipated — rewriting
the ~38KB narrative paragraph into state-only form — already landed at `1f70a95`
("Rewrite status section as state-only snapshot at main f995ecb", 22 insertions / 112 deletions),
ahead of any contract in roles.ts: the README is now ~15.5KB and the status section ~1.9KB, well
under the 8KB guard, carrying exactly the spec'd shape (capability summary line, open items,
`Current main (\`<sha>\`)` freshness stamp). The collapse happened once because every tick prompt
tells its loop to read PLANS.md first (src/prompt.ts), where this entry spelled out the target
form; nothing enforces it going forward. The find text still
says "Update the status section … to reflect reality", which is what produced the original
"Since then: X landed…" appends — so absent this contract, subsequent syncs regrow the log and
every one of the thirteen loops pays it in prefill again. Corrected spec:

1. **Goal reframed.** The remaining problem is durability, not collapse: codify the state-only
   snapshot as an explicit contract in the readme role's find text so every future sync rewrites
   the section wholesale and cannot drift back into per-tick narrative — small by construction,
   with the ~8KB guard as the tripwire. The Goal's "~38.7KB paragraph in a 52KB README" framing is
   superseded; cite `1f70a95` as the one-off that proved the target form.
2. **Transition item retired.** The Approach's "Transition (NOT this plan's implementer)" bullet
   and the AC's "Transition verified by observation" criterion are already satisfied at `1f70a95`
   — remove them from the remaining work. Replace with a durability observation (still not this
   plan's implementer): on subsequent readme syncs after landing, the section stays under 8KB and
   gains no per-tick narrative; git log preserves both the pre-collapse paragraph and `1f70a95`.
3. **Use the landed form as the reference example.** The contract's content spec (capability
   summary / open items / freshness stamp) must match what `1f70a95` actually produced, so the
   prompt codifies practice rather than inventing a new shape; the implementer should read that
   commit's diff when writing the find text.
4. **Sibling numbers refreshed.** PLANS.md is now ~160KB and BUGS.md ~57KB (was ~150/~56) — same
growth, still deliberately not planned here.

Everything else in this entry stands unchanged: the four contract clauses, the roles.ts rewrite,
the test/prompt.test.ts work (new readme contract block + oneLine conversion of the existing
assertion), and the files-touched list. The plan remains independently pickable by the feature
loop as-is once these corrections are read with it.

**Done 2026-09-04 (feature tick) — implemented as planned against main `3b5ecbf`; nothing remains.**
Audited first: at `3b5ecbf` no part had landed — src/roles.ts's readme find text still read "Update the
status section … to reflect reality", and test/prompt.test.ts carried no readme contract block; the one-off
collapse this entry's Refined section cites (`1f70a95`) had already landed ahead of any contract, which is
exactly the durability gap this plan closes. This tick rewrote src/roles.ts's readme find text into the
explicit state-only snapshot contract: the status section (between the tumwater:status markers) describes
CURRENT STATE ONLY and is rewritten wholesale on each sync — never appended to — carrying exactly three
things, matching the shape `1f70a95` actually produced: (a) a one-line version/capability summary (which
commands exist, which roles are enabled), (b) open items — planned features not yet done, open bugs, open
questions — one line each or "none", and (c) the freshness stamp (`Current main (`<sha>`): build clean,
suite N/N`). No per-tick landing narrative in the section: landings are recorded by their owning loops in
PLANS.md/BUGS.md and git log, and stale narrative found in the section is deleted as part of updating it (an
update, not a loss); if the section exceeds ~8KB it has drifted back into narrative — prune it to the
state-only form. The existing constraints are kept: PRINCIPLES.md belongs to director/steward, never edit
the tumwater:prompt block, and "if the README is already accurate (including its freshness stamp), there is
nothing to do" — a moved main makes the stamp stale, so syncs still run after landings. test/prompt.test.ts
gained the sibling contract block after the steward block (`const readme = roleById("readme")`, five tests
matching `oneLine(readme.find)`): rewrite-wholesale-not-append; the state-only content spec naming
capability summary, open items, and the freshness stamp verbatim; the no-narrative rule with landings
belonging in PLANS.md/BUGS.md and git log (including stale-narrative deletion); the ~8KB drift guard; and
buildTickPrompt embedding the full find text. The existing "leaves PRINCIPLES.md to the director and
steward" assertion was converted from a literal `\n` match to `oneLine(...)` so reflow cannot break it, per
the Approach. Verified on this tree: build clean, full suite 609/609 in ~52 s (main's 604 plus this tick's
five new tests). The entry's one residual — the durability observation that subsequent readme syncs keep the
section under 8KB with no per-tick narrative — is not this plan's implementer and will be verified by
observation as readme ticks run. Files: src/roles.ts, test/prompt.test.ts, PLANS.md.

### Run the project's own test suite in the deterministic pre-merge gate (planned 2026-09-04,
done 2026-09-04)

**Goal.** The pre-check that gates every code merge recognizes only `typecheck` and `build` npm
scripts — it never runs tests. tumwater itself declares no `typecheck`, so its own gate is a bare
`tsc`: type errors are caught, but test failures land on main. That is the recurring failure mode
in BUGS.md's Fixed section: "Tests red on main" / "Build broken on main" entries from 2026-08-27
to 2026-09-03 (feature ticks 44/49/52, organize tick 78, clean tick 91, feature tick 83), each
discovered only after landing by the readme loop and costing a bugfix tick plus a status sync.
Fix: make detection prefer `test` when declared, so the gate runs the project's canonical
verification — for tumwater, build + full node:test suite (~53 s measured in a worktree on
2026-09-04) — and a red suite is rejected before merge with the clipped output tail as
machine-generated reasons.

**Approach.**
- src/build-check.ts — `buildCheckFrom`: prefer `scripts.test`, then `typecheck`, then `build`
  (still exactly one script per gate run). Update the module header and function doc comments:
  the check is "the project's declared deterministic verification", following npm convention that
  `npm test` is the canonical verify command; note that for tumwater `test` subsumes `build`. All
  execution/classification behavior stays as-is: 300 s timeout → skipped (environmental, warn and
  proceed), nonzero exit → failed with clipped tail, no npm on PATH → skipped.
- test/build-check.test.ts — update "detectBuildCheck prefers typecheck over build when both
  scripts are declared" to pin the three-way preference (`test` > `typecheck` > `build`; keep a
  two-script case for typecheck-over-build); extend the malformed/scriptless fixture and comment
  ("neither a usable typecheck nor build") to include `test`.
- test/review.test.ts — the duplicated preference test (~line 355) gets the same update. Every
  other gate fixture declares only `build`, so their `build check failed (build)` rejection-text
  assertions stay valid unchanged; optionally extend one fixture to declare a failing `test`
  script and pin that it is selected and rejected with reasons starting
  `build check failed (test):`.
- Deliberately no config knob (opinionated defaults over configuration): a project whose `test`
  script hangs hits the existing timeout→skipped path, and a flaky suite produces loud
  deterministic rejections — that is the gate surfacing suite health, not a defect to work around;
the 3-strike discard cap bounds any damage. Do not weaken the gate to accommodate flakiness.

**Files touched.** src/build-check.ts, test/build-check.test.ts, test/review.test.ts. (The
README's "deterministic build pre-check" sentence stays accurate; the readme loop syncs wording if
it judges it stale.)

**Acceptance criteria.**
- detectBuildCheck returns `test` when all three scripts are declared, `typecheck` when only
  typecheck+build exist, and `build` alone as before — pinned by unit tests in both test files.
- A worktree whose package.json declares a failing `test` script is rejected by the gate with zero
  reviewer runs, reasons starting `build check failed (test):`, branch reset to main (existing
  rejection-path semantics: no pi run consumed, unreviewFailures reset).
- Build clean; full suite green — including running `npm test` with cwd = a tumwater worktree
  (feasibility verified by the plan loop on 2026-09-04: 599/599 in ~53 s, no local node_modules
  needed — npm's run-script walks up to the installed ancestor).

**Done 2026-09-04 (feature tick) — implemented as planned against main `48131e9`; nothing remains.**
Audited first: at `48131e9` no part had landed — `buildCheckFrom` still preferred only
`typecheck`/`build`, and both test files still pinned the two-script preference. This tick landed
all three Approach items in one change: src/build-check.ts's `buildCheckFrom` now prefers
`scripts.test`, then `typecheck`, then `build` (module header and doc comments updated per spec —
npm convention makes `test` the canonical verify command; for tumwater `test` subsumes `build`),
with execution/classification behavior untouched. test/build-check.test.ts's preference test now
pins the three-way order (all three declared → `test`; typecheck+build only → `typecheck`) and its
malformed/scriptless fixture includes a non-usable `test`. test/review.test.ts got the same
preference-test update, plus `gateBuildFixture` gained a script-name parameter and a new e2e —
"gate pre-check selects the declared test script — a failing suite rejects with zero reviewer
runs": a worktree declaring a failing `test` script is rejected deterministically (no pi run,
branch reset to main, unreviewFailures reset) with reasons starting `build check failed (test):`.
The Approach's optional fixture extension was taken; every other gate fixture still declares only
`build`, so its `(build)` rejection-text assertions are unchanged. Consequence: from this landing
onward tumwater's own pre-merge gate runs its full suite (`npm test` = build + node:test) instead
of bare `tsc`. Verified on this tree: build clean, full suite 600/600 in ~51 s (main's 599 plus
this tick's one new test). Files: src/build-check.ts, test/build-check.test.ts,
test/review.test.ts, PLANS.md.

### Abort a single loop's in-flight tick — `tumwater abort --role <id>` (planned 2026-09-03,
refined 2026-09-03, re-audited 2026-09-03, re-audited 2026-09-04, done 2026-09-04)

**Goal.** Give operators a way to stop ONE loop's in-flight tick right now — without stopping the
whole fleet or waiting for the hang guards. Today, when a loop is visibly thrashing on a bad task
(the transcript pane shows it) or burning money on a doomed run, the only levers are Ctrl+C (kills
every loop), editing tumwater.json to disable the role (blocks NEW ticks only — `isEligible` gates
starts; an in-flight tick still runs to completion), or waiting for the quiet watchdog / tick
timeout to fire. `tumwater abort --role <id>` closes that gap: kill this loop's current pi run,
discard its half-done work (worktree reset to main), and let it go back to normal scheduling — the
loop stays enabled, later ticks proceed as usual. One cohesive feature: the marker-file contract
couples the CLI, the orchestrator, and the loop, so no part is independently shippable.

**Approach.**
- src/paths.ts: `abortRequestPath(root, role)` → `.tumwater/abort-<role>.json` — a per-role marker
  file following the `reset-counters.json` pattern (presence = pending request; content `{ at }`).
  Per-role files keep consumption race-free and need no parsing.
- src/types.ts: add `"user_aborted"` to TickResult ("a user-initiated abort killed the run
  mid-tick; work discarded, loop backed off") — deliberately distinct from `"aborted"` (harness
  shutdown), which carries resume-promptly semantics a deliberate stop must not have. Add
  `"tick_aborted"` to HarnessEvent's type union (routine state change, like counters_reset).
- src/loop.ts: LoopRunner gains a private per-tick `AbortController`, created at tick start
  alongside the counter resets; runRolePi and reviewGate pass the COMBINED signal —
  `this.signal ? AbortSignal.any([this.signal, this.tickAbort.signal]) : this.tickAbort.signal`
  (engines require Node ≥ 20). New method `abortTick()`: no-op when no tick is in flight
  (`state.running` false); otherwise sets a private `userAborted` flag and calls
  `tickAbort.abort()`. The flag is cleared at the next tick start. In runTick's two abort branches
  (the author-run `pi.aborted` check and the review-gate `gate.aborted` check): when `userAborted`,
  diverge from shutdown semantics — reset the worktree to main (`resetWorktreeToMain`, discarding
  half-done edits AND any unmerged commit on the branch, so the next tick's leftover recovery finds
  nothing), do NOT requeue a director prompt (an explicit abort is a decision about that request;
  timeouts and cut-offs still requeue), and return `{ result: "user_aborted" }` instead of
  `{ result: "aborted" }`. Known limitation, document in the code comment: if the marker is consumed
  while the tick sits in its short git-only commit/merge window (no pi run in flight), the flag
  takes effect at the next model-run boundary within the tick — or, for a tick that reaches no
  further pi run, completes normally and the abort had no effect; re-issuing is the remedy.
- src/state.ts: applyTickOutcome gains a `"user_aborted"` branch — schedule like an unproductive
  tick (the final else's `nextBackoffSeconds` backoff), no `resumePending`; phase is already cleared
  by the existing `result !== "aborted"` check.
- src/orchestrator.ts: in the poll cycle beside the reset-counters marker consumption — for each
  role with a pending abort marker file, find its runner; if `runner.state.running`, call
  `runner.abortTick()` and log one `{ loop: role, type: "tick_aborted" }` event; remove the marker
  either way (a request for an idle loop is a no-op, not an error).
- src/event-format.ts: render `tick_aborted` as a plain line like counters_reset —
  `<time> <role> tick aborted by user`; tick_end renders its result string verbatim, so
  `"user_aborted"` flows through with no change.
- src/cli.ts: new `abort` subcommand following reset-counters' pattern —
  `rejectUnknownArgs("abort", args, [{ names: ["--role"], value: true, valueName: "<id>" }])`,
  `requireReadyRepo`; `--role <id>` required and must be a known role id (actionable error listing
  the valid ids otherwise); require the orchestrator to be running (`readOrchestratorInfo` +
  pidAlive — actionable "no harness is running" error, since with no fleet nothing consumes the
  marker); write the marker; confirm `abort requested for <role> — a running fleet applies it
  within ~2s`. README.md: one Usage line (do not touch the status block — that text belongs to the
  readme loop).

**Files touched.** src/paths.ts, src/types.ts, src/loop.ts, src/state.ts, src/orchestrator.ts,
src/event-format.ts, src/cli.ts, test/loop.test.ts, test/state.test.ts, test/orchestrator.test.ts,
test/event-format.test.ts, test/cli.test.ts, README.md.

**Acceptance criteria.**
- Loop e2e (test/loop.test.ts): a fake-pi shim that hangs mid-run — `runner.abortTick()` kills the
  child; the tick ends with result "user_aborted"; the worktree is reset to main (a planted dirty
  file is gone); persisted state carries no resumePending and nextRunAt > now (backed off, not
  immediate); the tick_end event carries user_aborted. Director variant: an aborted director tick
  leaves the inbox EMPTY — its prompt was not requeued (contrast with timeout/cut-off, which do).
- Orchestrator e2e (test/orchestrator.test.ts): a slow fake-pi tick under a real orchestrator;
  writing `abortRequestPath(root, role)` kills the run within one poll cycle, removes the marker,
  and logs exactly one tick_aborted event; a marker for an idle loop is removed with no event.
- Scheduling units (test/state.test.ts): applyTickOutcome("user_aborted") advances backoff like an
  unproductive tick, sets no resumePending, clears phase.
- Events (test/event-format.test.ts): tick_aborted renders as a plain line under the role's loop;
  tick_end with result user_aborted renders that string.
- CLI (test/cli.test.ts): `abort --role feature` against a running harness writes the marker and
  confirms; without a running harness it fails actionably naming `tumwater run`; an unknown role
  fails listing valid ids; missing/unknown flags fail like reset-counters' siblings.
- Build clean, full suite green.

**Refined 2026-09-03 (plan loop) — audited against current main (`67fb3d9`); three spec gaps
closed.** Every structural claim verified on current main first: `resetRequestPath(root)` in
src/paths.ts is the marker template; TickResult and HarnessEvent's unions sit where described;
LoopRunner's constructor takes a `signal?: AbortSignal`, runRolePi and reviewGate both pass it
through, and pi.ts already handles a pre-aborted signal (`opts.signal?.aborted` → immediate
onAbort), so the documented "next model-run boundary" limitation is accurate; the tick-start
counter-reset block (generatedTokens/peakContextTokens/tickTurns/tickCostUsd zeroed in tick()) is
the anchor for creating the per-tick AbortController; runTick's two abort branches are exactly as
described — the author-run `pi.aborted` check and the review-gate `gate.aborted` check, each
requeueing then returning `{ result: "aborted" }`; applyTickOutcome's final else is the backoff
branch and its `result !== "aborted"` phase-clear covers `"user_aborted"` as claimed; the
orchestrator poll cycle consumes the reset-counters marker beside where this entry sits (runners
are an array — look one up by role); event-format renders tick_end's result verbatim and
counters_reset as a plain line; every CLI helper named exists (`rejectUnknownArgs`/
`parseRoleFlag` in src/cli-args.ts, `requireReadyRepo` in cli.ts, `readOrchestratorInfo` in
state.ts, `pidAlive` in process.ts); and `resetWorktreeToMain` (src/git.ts) does abortSync +
`git reset --hard <main>` + `git clean -fd`, which moves the branch pointer back to main — so it
discards unmerged commits as well as dirty files, exactly as this entry claims. Three gaps in
the original spec, corrected:

1. **`pendingUserPrompt` must be cleared on a user-abort of the author run.** The existing
   `pi.aborted` branch returns before tick()'s `this.pendingUserPrompt = null`, so today an
   aborted director tick leaves its dequeued prompt held on the live runner (harmless under
   shutdown — the process dies and the prompt was requeued — but a user-abort in a running
   orchestrator neither requeues nor clears it). No functional bug today: every non-skipped
   director tick calls tickPrompt() first, which overwrites the field before its sole read site —
   but that makes the discard accidental rather than explicit. Pin: in the author-run branch's
   `userAborted` divergence, clear `this.pendingUserPrompt = null` alongside skipping the requeue.
   The review-gate branch needs no such clearing — by then tick() has already cleared it.
2. **The no-runner case is unspecified.** Runners are built from enabled roles only, so a
   valid-but-disabled role id has no runner at all — `tumwater abort --role <disabled>` reaches
   the poll cycle with a marker but nothing to find. Pin: treat it like an idle loop — remove the
   marker, log no event; the CLI's confirmation is unchanged (the request was accepted and
   consumed). The orchestrator AC's "marker for an idle loop" case covers this shape — assert it
   with a disabled role too.
3. **The director prompt discard is invisible to the user.** The inbox is a file queue and
   dequeuePrompt removes the prompt file at tick start, so a discarded prompt is gone from disk —
   but the planned confirmation ("abort requested for <role> …") says nothing about it. Pin: when
   `--role` is the director, append one clause to the CLI confirmation that its current in-flight
   prompt will be discarded (re-submit with `tumwater prompt` if you want it retried).

**Re-audited 2026-09-03 (plan loop) — feature tick 87 (`b37e600`) landed the entire src half;
two of the three refined pins were missed and no AC tests exist. Remainder re-specified.**
Verified at `1f70a95` (build clean, suite 587/587): every Approach file is present as specified —
`abortRequestPath` (`abort-<role>.json`) in src/paths.ts; both union members in src/types.ts;
src/loop.ts's per-tick `AbortController` created at tick start beside the counter resets,
`runSignal()` combining it with the harness signal via `AbortSignal.any`, `abortTick()` (no-op
when idle, else flag + abort), and the `userAborted` divergence in BOTH runTick abort branches
(`resetWorktreeToMain`, no requeue, `{ result: "user_aborted" }`); src/state.ts's
applyTickOutcome branch (backoff like an unproductive tick, no resumePending, phase cleared by
the existing `result !== "aborted"` check); the orchestrator's marker consumption beside the
reset-counters one — running → `abortTick()` + exactly one `tick_aborted` event, idle/disabled/
no-runner → marker removed silently (gap #2 implemented as pinned); src/event-format.ts's plain
line `<time> <role> tick aborted by user`; and src/cli.ts's cmdAbort (`parseRoleFlag` with the
valid-ids error, `requireReadyRepo` in main()'s dispatch, `orchestratorAlive` gate naming
tumwater run, marker write, confirmation) plus the README Usage line. Two pins from the
2026-09-03 refinement were NOT implemented:

1. **`pendingUserPrompt` is not cleared on a user-abort of the author run** (gap #1). The
   `userAborted` branch in src/loop.ts returns `{ result: "user_aborted" }` before the shared
   `this.pendingUserPrompt = null`, so an aborted director tick leaves its dequeued prompt held
   on the live runner. Non-functional per this entry's own analysis — every non-skipped FRESH
   director tick calls tickPrompt() first, which overwrites the field before its sole read site,
   and a user-abort never sets resumePending so no resumed tick can follow one — but the discard
   is accidental rather than explicit, as pinned.
2. **The CLI confirmation carries no director clause** (gap #3). cmdAbort writes an unconditional
   `abort requested for <role> — a running fleet applies it within ~2s`; with `--role director`
   its in-flight prompt is discarded from disk with no warning — exactly the invisibility gap #3
   was written to close.

What remains — seven items: (a)–(b) are small src fixes for the missed pins, (c)–(g) are the AC
test groups. (c)–(f) are pure test work against landed behavior and independently pickable TODAY;
(g)'s clause assertion needs (b), and (c)'s field-clearing assertion needs (a):

(a) **Clear `pendingUserPrompt` on a user-abort of the author run** (src/loop.ts): in the
   `userAborted` branch inside `if (pi.aborted)`, set `this.pendingUserPrompt = null` alongside
   skipping the requeue — one line, with a comment that an explicit abort discards the request.
   The review-gate branch needs no change (tick() has already cleared it by then).
(b) **Director clause in the CLI confirmation** (src/cli.ts): when the role is director
   (`DIRECTOR_ROLE` from roles.js), append one sentence to cmdAbort's confirmation that its
   current in-flight prompt will be discarded — re-submit with `tumwater prompt` if you want it
   retried. Non-director output stays byte-identical.
(c) **Loop e2e** (test/loop.test.ts): per the AC above — a fake-pi shim that hangs mid-run;
   `runner.abortTick()` kills the child; result "user_aborted"; a planted dirty file is gone
   (worktree reset); persisted state carries no resumePending and nextRunAt > now (backed off,
   not immediate); the tick_end event carries user_aborted. Director variant: an aborted director
   tick leaves the inbox EMPTY, and — after item (a) — the runner's `pendingUserPrompt` field is
   null (reachable via the `(runner as unknown as { … })` pattern this file already uses).
(d) **Orchestrator e2e** (test/orchestrator.test.ts): per the AC above — a slow fake-pi tick
   under a real orchestrator; writing `abortRequestPath(root, role)` kills the run within one poll
   cycle, removes the marker, and logs exactly one tick_aborted event; a marker for an idle loop
   is removed with no event — assert that case with a DISABLED role too (the no-runner shape).
(e) **Scheduling units** (test/state.test.ts): applyTickOutcome("user_aborted") advances backoff
   like an unproductive tick, sets no resumePending, clears phase.
(f) **Events** (test/event-format.test.ts): tick_aborted renders as a plain line under the role's
   loop; tick_end with result user_aborted renders that string verbatim.
(g) **CLI** (test/cli.test.ts): per the AC above — `abort --role feature` against a running
   harness writes the marker and confirms; without a running harness it fails actionably naming
   tumwater run; an unknown role fails listing valid ids; missing/unknown flags fail like
   reset-counters' siblings. Plus, after item (b): `--role director`'s confirmation carries the
   discard clause while a non-director's does not.
Once all seven land, move this plan to Done. Files for the remainder: src/loop.ts, src/cli.ts,
test/loop.test.ts, test/orchestrator.test.ts, test/state.test.ts, test/event-format.test.ts,
test/cli.test.ts.

**Re-audited 2026-09-04 (plan loop) — items (c) and (g) have LANDED; the "seven items" list
above is stale. Remainder re-specified as five items plus two small assertions.** Verified at
`70ebbc3` (current main; build clean, suite 594/594 run on this tick's tree — the two commits
since the README's `bd7df5e` stamp are a readme sync and an annotation-only clean tick):

- **(c) landed** in coverage tick `6b52731` — three tests in test/loop.test.ts: "a user-aborted
  tick discards work, backs off, and does not resume" (fake pi writes a half-done edit then hangs;
  `abortTick()` kills it; result "user_aborted"; the planted dirty file is gone from the worktree
  and nothing lands on main; no resumePending; backoffSeconds at the initial idle value with
  nextRunAt > now; tick_end carries user_aborted), "a user-aborted director tick drops the prompt
  instead of re-queueing it" (inbox empty after the abort — but does NOT yet assert the runner's
  `pendingUserPrompt` field is null, since item (a) has not landed), and a third test beyond the
  AC spec, "a user-abort mid-review discards the committed work too" (abort during the review
  gate: branch reset to main, no requeue, backed off).
- **(g) landed** in coverage tick `0d4c41b` — three tests in test/cli.test.ts: "abort validates
  its arguments before touching anything" (missing/bare --role, unknown role listing valid ids,
  unknown flag, stray positional; no marker on any failure), "abort refuses when no harness is
  running — missing or stale info file alike", and "abort drops a per-role marker for a live
  harness and reports it" (marker content `{ at }`, other roles' markers untouched, the CLI itself
  logs no event). The director-clause assertion is still absent — it waits on item (b), exactly as
  planned.
- **(a), (b), (d), (e), (f) verified NOT landed**: src/loop.ts's `userAborted` branch in the
  author-run abort check still returns `{ result: "user_aborted" }` before the shared
  `this.pendingUserPrompt = null`; cmdAbort's confirmation is unconditional (no director clause);
  test/orchestrator.test.ts carries no abort-marker tests; test/state.test.ts and
  test/event-format.test.ts have zero references to user_aborted/tick_aborted.

What remains — five items, pickable independently: (a), (b), (d), (e), and (f) exactly as
specified above (their specs stand unchanged). Plus two small assertions that complete the landed
test groups once their src fixes exist:

- **The tail of item (c)** — after item (a) lands, extend test/loop.test.ts's "a user-aborted
  director tick drops the prompt instead of re-queueing it" to also assert the runner's
  `pendingUserPrompt` field is null, via the `(runner as unknown as { … })` pattern this file
  already uses. One assertion; makes the discard explicit rather than accidental, per item (a)'s
  rationale.
- **The tail of item (g)** — after item (b) lands, add to test/cli.test.ts: `--role director`'s
  confirmation carries the discard clause while a non-director role's does not (the clause half of
  item (g)'s spec that could not land before (b)).

One note for whoever lands (d): test/loop.test.ts's comment block above its user-abort tests says
"The marker-file plumbing that reaches here is covered by the orchestrator tests" — aspirational
until (d) exists; landing (d) makes it true.

Once all five items plus both assertions land, move this plan to Done. Files for the remainder:
src/loop.ts, src/cli.ts, test/orchestrator.test.ts, test/state.test.ts, test/event-format.test.ts,
test/loop.test.ts (the item-(c) tail only), test/cli.test.ts (the item-(g) tail only).

**Done 2026-09-04 (feature tick) — all remainder items have landed; nothing remains.** The last five
items plus both assertion tails closed in one feature tick against main `7a9fa8d`: (a) the author-run
`userAborted` branch in src/loop.ts now clears `pendingUserPrompt` explicitly alongside skipping the
requeue, making the discard explicit rather than accidental; (b) cmdAbort appends a discard clause to
its confirmation for `--role director` only — non-director output stays byte-identical. The item-(c)
tail extends test/loop.test.ts's aborted-director test to assert the runner's `pendingUserPrompt` is
null via the file's existing cast pattern; (d) test/orchestrator.test.ts gains the marker-plumbing e2e —
a slow fake-pi tick under a real orchestrator, where writing `abortRequestPath(root, role)` kills the run
within one poll cycle with exactly one `tick_aborted` event, and markers for an idle loop AND disabled
(no-runner) roles are removed silently; (e) test/state.test.ts pins applyTickOutcome("user_aborted") —
initial-then-grown idle backoff, no resumePending, phase cleared; the item-(g) tail adds the
director-clause confirmation test to test/cli.test.ts. Item (f) landed in coverage tick `7a9fa8d`
(formatEvent tests for both lines, plus a partial-spend variant). Verified on this tree: build clean,
full suite 599/599.

- Per-loop today spend — which loop is eating the day's budget (planned 2026-09-02, done 2026-09-03; commits c17893d, 02a8661)
- Steward role — whole-system judgment on a slow clock (planned 2026-08-24, done 2026-09-02; commits 6e3f487, be6dc56, bf42c98)
- Per-tick usage in the event feed — tokens and cost on every tick_end (planned 2026-09-02, done 2026-09-02; commit 3e4086a)
- Director inbox management — list and cancel queued prompts (planned 2026-09-01, done 2026-09-02; commits 53c0477, 349482e, 9c20312, da86dbd)
- Live sessionRetentionDays — re-prune old pi sessions without a restart (planned 2026-08-31, done 2026-09-02; commits eaa9848, 349482e, 157215f)
- Show queued director prompts in TUI/GUI (planned 2026-09-01, done 2026-09-01; commit 55af189)
- Live maxConcurrent — resize the concurrency cap without a restart (planned 2026-08-31, done 2026-09-01; commit af61b7e)
- Self-explaining commit bodies (planned 2026-08-24, done 2026-08-31; commits b41185d, 0f73491, d930959, 4021c1d)
- Daily cost budget — cap the fleet's autonomous spend (planned 2026-08-30, done 2026-08-31; commits 041fd55, 01c28ce, 07d5bf6, 2fbfb49, 92a4ffe, b589e09)
- The right to refuse, and friction as a signal (planned 2026-08-24, done 2026-08-30; commits c2f541a, 0326a2a, 82c7631, bc479b6, c477ce9, 7212a7e, 8e6eeae)
- Questions outbox — loops that know when to ask (planned 2026-08-24, done 2026-08-29; commits 2547b4d, 0294f45, 1a48edc, 931ca26)
- Adversarial review gate before merge (planned 2026-08-24, done 2026-08-29; commits 74224e9, 8ea49b8, 93d14f5, 038519a, 36b0adc, 50ef9eb)
- QA role — exercising the product like a user (planned 2026-08-24, done 2026-08-28; commit 6859e43)
- Show timestamp of last result in the GUI/TUI live table (planned 2026-08-21, done 2026-08-26; commit 9ef07d9)
- PRINCIPLES.md — positive design principles injected into every prompt (planned 2026-08-24, done 2026-08-26; commit abd2963)
- Show open bugs and planned features in the TUI/GUI (planned 2026-08-24, done 2026-08-26; commit 7023381)
- Show current work item per active loop in the GUI/TUI tables (planned 2026-08-25, done 2026-08-25; commit 39bfe9d)
- CLI subcommand to reset loop counters — ticks, commits, tokens, cost (planned 2026-08-25, done 2026-08-25; commit 5374aa5)
- Live-reload tumwater.json while the harness is running (planned 2026-08-23, done 2026-08-25; commit 82c7910)
- Linear history on main: rebase instead of merge commits (planned 2026-08-24, done 2026-08-25; commit 52fcfa2)
- Surface per-role pi transcripts in the TUI/GUI (planned 2026-08-23, done 2026-08-24; commit d36cb17)
- Per-role pi transcript via `tumwater logs --role` (planned 2026-08-21, done 2026-08-23; commit 48f45a1)
- Totals row for tokens and cost in the status table (planned 2026-08-21, done 2026-08-21; commit 9ddd731)
- Decompose requests into sub-plans/sub-bugs when routing (planned 2026-08-21, done 2026-08-21; commit 3e002c9)
- Web GUI (done 2026-08-20; commit 2182085)
- pi-driven merge conflict resolution (done 2026-08-20; commit 2182085)
- Per-role model/effort overrides (done 2026-08-20; commit 2182085)
- Log rotation and session pruning (done 2026-08-20; commit 2182085)
