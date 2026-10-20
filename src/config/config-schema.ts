// vocabulary: plain
/** The tumwater.json config schema shape: the types `config-validation.ts` validates a
 * loaded config into and every config read site consumes, plus the key allow-lists and
 * value shapes (`TOP_LEVEL_KEYS` and friends) that say what a valid file may hold at each
 * level — the schema facts, single-homed here so adding a key edits one file: its type,
 * its default (config.ts), and its allow-list entry sit beside each other. Split out of the former
 * types.ts grab-bag — the runtime types a run produces now live beside their consumers
 * (RunResult and RunOutcome in run-outcome.ts, RunnerState in runner-state.ts, HarnessEvent
 * in events.ts, MergeEntry in merge-queue.ts, and the pi-run types in run-agent.ts and
 * pi-run-result.ts) — so the schema the file on disk is validated against and the runtime
 * state the harness runs with
 * are two layers, changed for different reasons by different readers: a tumwater.json knob
 * hunt starts here, a run-lifecycle trace starts beside the type it traces. Sibling
 * modules: config.ts (defaults + load), config-validation.ts (validation), config-write.ts
 * (writes). */

import { objectOrEmpty } from "../files/json-object.js";

/** The model tiers a selector map may name (plans/model-tiers.md). A tier left out of the
 * `model` map inherits `default`'s model; `fallback` map values may also be `"pause"`
 * (each tier's own entry is consulted when that tier runs at the cap; part 5a/8). */
export const MODEL_TIERS = ["small", "default", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** One fallback step: a selector string, or `{ backend?, model, maxDailyCostUsd? }` — an
 * explicit `backend` runs the model id on that agent as written; the object form also
 * caps the real spend on that step's model per local day, summed over roles (plans/
 * fallback-chain.md "Spend per step"). A string is the same as `{ model }`. */
export type FallbackStep =
  | string
  | { backend?: string; model: string; maxDailyCostUsd?: number };

/** The keys an object fallback step may carry (validation's checkKnownKeys list). */
export const FALLBACK_STEP_KEYS: readonly string[] = ["backend", "model", "maxDailyCostUsd"];

/** One tier's fallback: a step, or an ordered list of them tried first to last (the first
 * usable step runs; plans/fallback-chain.md "Terms"). */
type FallbackChain = FallbackStep | FallbackStep[];

/** The agent backends an `agent` value may name (plans/agent-backends.md "Config"). The
 * registry (src/agent/agent-backend.ts) is the runtime source, but the schema reserves these
 * ids so validation rejects a typo'd backend at load time instead of falling back to pi. The
 * agent id doubles as the selector provider namespace: `claude/<id>` always routes to claude. */
export const BACKEND_IDS = ["pi", "claude", "opencode"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

/** The tier-map key list validation feeds checkKnownKeys: a `model` or `fallback` map whose
 * keys are not exactly these tiers is a typo that would silently never resolve. */
export const TIER_MAP_KEYS: readonly string[] = MODEL_TIERS;

/** The top-level `model` read as a tier map: a bare selector string means
 * `{ default: <string> }`, a plain object passes through as-is (isJsonObject owns that
 * definition), and a missing, non-object, or array model reads as an empty map. Shared by
 * `config set model.<tier>`'s merge and
 * `config get model.<tier>`'s lookup, so those two verbs cannot disagree about what a string
 * model means. Values are not type-checked here — validateConfig owns the shape of the merged
 * candidate. (config-views.ts keeps its own parse-aware reading: a string model there is
 * parsed under the legacy top-level provider.) */
export function modelTierMap(model: unknown): Record<string, unknown> {
  if (typeof model === "string") return { default: model };
  return objectOrEmpty(model);
}

/** The object form of a tier entry in the top-level `model` map: the model written beside the
 * `backend` that runs it (an explicit backend passes the id to that backend as written). */
export interface ModelSelectorEntry {
  backend?: string;
  model?: string;
  thinking?: string;
}

/** The keys an object tier entry may hold (validation feeds checkKnownKeys). */
export const SELECTOR_ENTRY_KEYS: readonly string[] = ["backend", "model", "thinking"];

/** Per-role configuration in tumwater.json. */
export interface RoleConfig {
  enabled: boolean;
  /** Extra instructions appended to this role's prompt. */
  instructions?: string;
  /** pi provider override for this role; falls back to the top-level value. */
  provider?: string;
  /** pi model override for this role: a selector `provider/id[:thinking]`, or a tier name
   * (`small` / `default` / `strong`) naming that tier of the top-level `model` map (plans/
   * model-tiers.md). Falls back to the role's catalog tier when absent. */
  model?: string;
  /** The backend that runs this role's `model` (`pi`, `claude`, `opencode`); the model passes
   * to it as written. Alone, it inherits the tier's model only when the tier routes to it. */
  backend?: string;
  /** pi thinking-level override for this role; falls back to the top-level value. */
  thinking?: string;
  /** Minimum seconds between two runs of THIS role, overriding the top-level value — a
   * slow clock for roles that should act rarely (the steward curates on ~6 h). */
  minRunIntervalSeconds?: number;
  /** How many parallel runners this role may have (plans/parallel-work-instances.md, part
   * 5/7): the bare id is instance 1, and `feature-2`…`feature-N` are the rest. Integer 1–8,
   * valid only under the `INSTANCE_ROLES` (`feature`, `bugfix`); absent means 1. */
  instances?: number;
}

/** A user-defined role in tumwater.json's `customRoles` array
 * (plans/user-defined-loops.md): each entry becomes a full-citizen role — persistent worktree +
 * branch, run lifecycle, review gate, merge to main. Only the director may write this key; every
 * other role's prompt keeps the blanket tumwater.json ban. */
interface CustomRole {
  /** The role id: worktree dir, branch suffix (`tumwater/<name>`), and status row.
   * Validated at load against /^[a-z0-9][a-z0-9_-]{0,31}$/ — it becomes a filesystem path
   * and a git ref — with no collision with any catalog id (including the director) and unique
   * within the list. */
  name: string;
  /** The role's standing instruction — its entire find-something-to-do prompt. Capped at
   * 4096 chars because it rides into every one of that role's run prefills. */
  task: string;
}

/** Top-level review-gate config in tumwater.json (see src/review/review.ts). */
interface ReviewConfig {
  /** Enable the adversarial pre-merge review gate (default true). */
  enabled: boolean;
  /** Repo-relative path patterns whose diffs are exempt from review when EVERY changed
   * file matches some pattern (doc-only changes stay cheap). A pattern without "/" matches
   * the basename at any depth; one with "/" matches the full path (* within a segment,
   * ** across segments). */
  exemptPaths: string[];
  /** Base role ids whose changes merge once the gate passes, with no review first; a review of
   * the merged commit follows, and a rejection reverts it and hands it back to its author
   * (plans/fast-merge.md, Lever 7). Never `director`. Absent means every role is reviewed
   * before merging. */
  afterMerge?: string[];
  /** pi provider override for reviewer runs; falls back to the top-level value. */
  provider?: string;
  /** pi model override for reviewer runs — a selector `provider/id[:thinking]`, or a tier
   * name (`small` / `default` / `strong`) naming that tier of the top-level `model` map
   * (plans/model-tiers.md). Falls back to the `strong` tier when absent — the reviewer is
   * the seam where model quality matters most. */
  model?: string;
  /** The backend that runs `model` (see RoleConfig.backend). */
  backend?: string;
  /** pi thinking-level override for reviewer runs; falls back to the top-level value. */
  thinking?: string;
  /** Wall-clock budget for one reviewer run, in seconds (default 900, capped by
   * runTimeoutSeconds). A review that outruns it is a failed run — commit kept, no strike —
   * so one wedged reviewer cannot hold the merge queue for a whole authoring run. A reviewer
   * (and the merge conflict resolver, which shares the gate's wiring) that is still making
   * progress at the deadline receives one extension of the same length before it is killed. */
  timeoutSeconds?: number;
}

/** The free ("cost n/a") model the team falls back to once the daily cost budget is spent
 * (plans/fallback-model.md). Each field falls back to the top-level value, exactly like a
 * role's or the reviewer's overrides — so naming only `model` keeps the current provider.
 * The pair is engaged ONLY when pi's models.json prices it at zero; an unknown, unpriced-by-
 * absence, or paid pair is refused and the team pauses as it did before, because a fallback
 * that can spend would defeat the cap it is meant to survive. */
export interface FallbackModelConfig {
  /** pi provider for fallback runs; falls back to the top-level value. */
  provider?: string;
  /** pi model for fallback runs; falls back to the top-level value. */
  model?: string;
  /** pi thinking level for fallback runs; falls back to the top-level value. */
  thinking?: string;
  /** The step's own daily spend cap in USD (a chain step written as an object); set only on a
   * pair resolved from a chain step, never read from `fallbackModel`. */
  maxDailyCostUsd?: number;
  /** Set on a Claude step that follows an earlier Claude model in its chain (the tier's primary
   * counts): it may spend extra usage, within its cap. Derived from position, never configured. */
  extraUsage?: boolean;
}

/** Idle backoff: how long a role sleeps after a run that changed nothing. */
export interface BackoffConfig {
  /** Seconds to sleep after the first no-change run. */
  initialSeconds: number;
  /** Multiplier applied on each consecutive no-change run. */
  factor: number;
  /** Ceiling in seconds. */
  maxSeconds: number;
}

/** New-project bootstrap: when `tumwater init` seeds a project from nothing it sets this so
 * the bootstrap gate (plans/work-ratio.md, part 2/2) holds the maintenance roles until
 * `untilPlansDone` plans have moved to PLANS.md's `## Done`. */
interface BootstrapConfig {
  /** How many plans must be Done before the maintenance roles are admitted; an integer ≥ 1. */
  untilPlansDone?: number;
}

/** The project's declared verification command (plans/portability.md §6/7) — a property of
 * the target repo, not of the machine running tumwater, which is why it is a project key in
 * the shareable config rather than a host setting. */
export interface CheckConfig {
  /** Shell command that verifies the tree — often compound ("cargo fmt --check && cargo test").
   * Runs in the worktree so it verifies the branch state, not a checkout of main. */
  command: string;
  /** Optional cheaper command for the review gate's per-change pre-check only (PLANS.md
   * Land-queue speed 3e) — e.g. just the tests a diff touches. Unset or blank = off: the gate
   * runs the full check. When set, the batch and merge checks and the red-main baseline
   * still run the full check (`command`, else the npm walk-up), so every merge is verified
   * by it once per stack; shares `cwd` and `timeoutSeconds`. */
  gateCommand?: string;
  /** Optional cheaper command for the check inside the merge lock (PLANS.md "Fast merge" part
   * 6/14) — e.g. lint, compile and the change's affected tests. Unset or blank = off: every
   * merge runs the full check. When set, the batch and merge scopes run it instead, a merge
   * whose rebased head the gate verified runs nothing in the lock, and its green never seeds
   * the baseline: the main watch's full check on the tip is main's verdict. Shares `cwd` and
   * `timeoutSeconds`. */
  mergeCommand?: string;
  /** Working directory for the command, resolved relative to the worktree root; defaults to ".". */
  cwd?: string;
  /** Hard cap on one run, in seconds; defaults to the built-in 300 s. It bounds whichever check
   * runs: `command`, `gateCommand`, or the npm script detected when no command is set. */
  timeoutSeconds?: number;
}

/** The config slice the build-check family reads (src/build/build-check-detect.ts's
 * detectBuildCheck, src/build/build-check-scoped.ts's runScopedBuildCheck,
 * src/baseline/main-baseline.ts's checkMainBaseline and mainIsGreen, src/doctor/doctor-checks.ts's
 * checkBuildCheck, and src/concurrency/check-permit.ts's withCheckPermit): the declared check plus
 * the cap that sizes the process-wide check permit. Every field is optional because every caller
 * differs — most hand a full TumwaterConfig, doctor hands a possibly-torn one, and the tests
 * hand a bare `{ check }` — and each field is guarded again at its point of use. One declaration,
 * so a new check setting is added here once and read by every consumer instead of being appended
 * to some of the seven hand-copied literals the inline form invited. */
export interface CheckConfigSlice {
  /** The declared check (see CheckConfig). */
  check?: CheckConfig;
  /** Max concurrent check runs (see TumwaterConfig.maxConcurrentChecks); the default cap
   * applies when absent. */
  maxConcurrentChecks?: number;
  /** The review-exempt paths (see ReviewConfig.exemptPaths). checkMainBaseline carries a green
   * verdict across main commits that touch only these paths. Absent means no carry-over: every
   * new SHA runs its own check. */
  review?: { exemptPaths?: string[] };
}

/** The tracked tumwater.json config. */
export interface TumwaterConfig {
  /** pi provider name; omitted = pi's own default. */
  provider?: string;
  /** pi model pattern; omitted = pi's own default. A string is one selector
   * `provider/id[:thinking]` (shorthand for `{ default: <string> }`); a map names the model
   * for each tier it has (plans/model-tiers.md) — keys are exactly `small` / `default` /
   * `strong`, and a map-form `model` cannot coexist with the legacy top-level `provider`. */
  model?: string | Partial<Record<ModelTier, string | ModelSelectorEntry>>;
  /** pi thinking level; omitted = pi's own default. */
  thinking?: string;
  /** The agent backend for bare selectors and the no-model default (plans/agent-backends.md
   * "Config"): `"pi"` (the default) or `"claude"`. A `provider/id` selector whose provider
   * names a backend always runs that backend; any other provider runs on pi. Typed as a string
   * so a test or later backend can register an id outside the schema's reserved BACKEND_IDS;
   * validation still rejects an unknown id in a loaded file. */
  backend?: string;
  /** The branch the team merges into and bases every role worktree on — the resolved
   * "main". Omitted, the team targets whatever branch the primary checkout has checked
   * out (the default that makes it branch-agnostic); an explicit value must exist. */
  baseBranch?: string;
  /** The project's own verification command (plans/portability.md §6/7) — what the review
   * gate's deterministic pre-check, the red-main baseline, and redeploy's green check run.
   * When absent, npm auto-detection (scripts.test → typecheck → build at the nearest
   * installed root) runs unchanged, so no existing project changes behavior. */
  check?: CheckConfig;
  /** The agent binary to spawn (plans/portability.md §5/7): TUMWATER_PI_BIN overrides it
   * for one invocation, "pi" is the default. A value containing a path separator is
   * normalized to an absolute path against the harness process's cwd at resolution time
   * (src/pi/pi-bin.ts resolveBackendBin), so a relative path names the same file to the run
   * preflight, doctor, and the spawn itself — which runs with each run's worktree as
   * cwd; a bare name is left to PATH resolution exactly as before. */
  agentBin?: string;
  /** Extra argv passed straight to pi. Must not repeat a flag the harness sets itself
   * (src/pi/pi-args.ts's `--print`/`--mode`/`--session-dir`, the provider/model/thinking
   * triple, and the session resume/name flags) — pi's parser is last-wins, so a repeat would
   * silently override the harness; validateConfig rejects the collision. */
  piArgs: string[];
  /** Per-agent-backend overrides (plans/agent-backends.md "Config"): the binary and extra
   * argv each backend runs, keyed by the reserved agent id (`pi`, `claude`). Both backends
   * resolve their binary through resolveBackendBin (pi-bin.ts), which reads this entry's `bin`
   * via config-views.ts; the claude adapter reads `.args` through that same view. The pi entry
   * resolves the legacy `agentBin`/`piArgs` as its `bin`/`args` when the new form leaves a
   * field absent, and a file may not set both spellings of one field. `defaultConfig()` seeds
   * an empty map. */
  backends?: Record<string, BackendConfig>;
  /** Max pi runs in flight at once across all roles, merges included: every merge verify run
   * (rebased onto main, gate-checked, reviewed in a leased pool slot) holds one of these
   * permits for its length, and a merge's conflict resolver one for its run, ahead of any
   * waiting role run (land-queue speed 2c). Only the director's own runs sit outside it. */
  maxConcurrent: number;
  /** Per-provider concurrency caps (plans/provider-concurrency.md §1): how many runs each
   * model provider serves at once, beside the team-wide `maxConcurrent`. A map from provider
   * key (§2: a backend's own id for claude, else the pi provider) to a positive integer. A
   * role run, a merge verify run or a conflict resolver starts when BOTH its provider and the
   * team have headroom; providers never wait on each other. An absent key is uncapped —
   * bounded by `maxConcurrent` alone — and a config without the key behaves exactly as
   * before. Unknown provider names are accepted (doctor warns in part 5/5); an entry at or
   * above `maxConcurrent` is legal but inert. Optional and absent by default. */
  maxConcurrentPerProvider?: Record<string, number>;
  /** The share of each subscription usage window the team leaves for you (plans/fallback-chain.md
   * "Reserve"): a map from window type (`five_hour`, `seven_day`) to a fraction 0 < f ≤ 1. At or
   * past that utilization the subscription counts as used up for every role but the director
   * until the window resets. Optional and absent by default. */
  claudeWindowReserve?: Record<string, number>;
  /** Max approved changes the orchestrator's merge slot stacks into ONE merge (plans/merge-queue.md
   * 5/5): the changes are stacked into one worktree, run through ONE shared build check, and
   * fast-forwarded to main in one ff. 1 merges every approved change on its own (no coalescing). */
  mergeBatchMax: number;
  /** Max runs of the project's declared check (the full suite) in flight at once across the whole
   * harness process — every gate, merge, batch, and main-baseline check takes one permit
   * (src/concurrency/check-permit.ts's withCheckPermit), so a burst of merges cannot stack suites
   * on the host. Read at each check's start, so an edit applies live. */
  maxConcurrentChecks: number;
  /** How many pooled worktree slots exist (plans/worktree-pool.md, "Config"): the fixed set of
   * `.tumwater/worktrees/_slot-<n>` checkouts runs and verify runs lease. Omitted, it
   * resolves through slotCount (src/config/config.ts) to `maxConcurrent + 1`. Must be at
   * least 1; a value below `maxConcurrent` is allowed — permit holders then wait for a
   * slot to free. */
  worktreeSlots?: number;
  /** Minimum seconds between two runs of the same role, even when woken early. */
  minRunIntervalSeconds: number;
  /** Hard cap on a single pi run, in seconds. */
  runTimeoutSeconds: number;
  /** Kill a pi run when it makes NO progress for this many seconds (0 disables). A healthy
   * run keeps producing progress even when slow — boundaries, and content-bearing streaming
   * deltas; prolonged silence means a hung tool (interactive command, zombie socket) that
   * would otherwise burn the whole run timeout. */
  quietTimeoutSeconds: number;
  /** Warn — without killing — when ONE tool call has been open this many seconds with no
   * content-bearing output update: a `warning` event names the command and the role's state
   * cell flags it, while the quiet watchdog still counts down. Fires even while sibling calls
   * keep streaming (total silence is not required); 0 disables the warning. */
  toolCallStallSeconds: number;
  /** Rotate events.jsonl and per-role pi logs when they exceed this size. */
  logMaxBytes: number;
  /** Delete pi session files older than this many days at orchestrator start (0 disables). */
  sessionRetentionDays: number;
  /** Daily cost budget in USD for the team's autonomous spend: while the sum of every role's
   * spend for the local day has reached this, roles stop starting new runs until the next
   * local midnight or a live edit raises/disables it (0 disables). The director is exempt — an
   * explicit human prompt outranks the autonomous-spend cap. See plans/daily-cost-budget.md. */
  maxDailyCostUsd: number;
  /** Per-role daily cost caps in USD, keyed by role id (the per-role sibling of
   * `maxDailyCostUsd`): a role whose local-day spend has reached its cap starts no new runs
   * until local midnight or a live edit raises/removes it. 0 disables that role's cap; an
   * absent key means uncapped. The director is exempt — an explicit human prompt outranks the
   * autonomous-spend cap. Keys must name known roles (built-in or customRoles) — a typo is a
   * validation error, never a silently inert cap. */
  maxDailyCostUsdPerRole?: Record<string, number>;
  /** Work ratio 1a/4 and 1b/4 (plans/work-ratio.md, "Maintenance follows work"): how many
   * code-maintenance merges the rolling 24 h window allows per work (feature/bugfix/director)
   * merge, on top of the fixed 12-merge floor. A number of 0 or more, default 2; there is no
   * off switch because a large value effectively disables the allowance. Once the window reaches
   * the allowance the scheduler holds maintenance roles until it rolls under (part 1b/4), except
   * a fresh `tumwater wake` or queued prompt admits one run. */
  maintenancePerWorkMerge: number;
  /** Quiet hours: a daily local-time window — "HH:MM-HH:MM", e.g. "23:00-07:00" — during
   * which roles start no new runs (in-flight runs finish; a run due inside the
   * window starts at window end). A window may wrap midnight (start > end); an empty string
   * or an absent key means off. The director is exempt — a human steering outranks a
   * schedule, exactly as under the budget gate and the operator pause. */
  quietHours?: string;
  /** Per-role quiet hours (PLANS.md): the scheduled sibling of `maxDailyCostUsdPerRole` —
   * keyed by role id, each value the same "HH:MM-HH:MM" window the team-wide `quietHours`
   * takes (wrapping included; an empty string or an absent key means off for that role). A
   * role whose own window covers the local wall clock starts no new runs — in-flight runs
   * finish — while the team-wide window keeps working unchanged: a role is held when
   * EITHER window covers now. The director is exempt, exactly as under the team window. */
  quietHoursPerRole?: Record<string, string>;
  /** Disk floor (plans/disk-floor.md, "Disk floor 1/4"): the free-space floor in GB
   * (10^9 bytes) for the volume holding `.tumwater/worktrees`. When free space drops below
   * it, no new work starts — role runs, the director, merge verify runs and merges — until free
   * space climbs back to `diskHoldGB` + 5 GB (the hysteresis that keeps a team hovering at
   * the line from flapping). In-flight work runs on. 0 disables the hold, lifting an active
   * one on the next poll. Default 10. */
  diskHoldGB: number;
  /** Disk floor reclaim (plans/disk-floor.md, "Disk floor 2/4"): the free-space threshold in
   * GB (10^9 bytes) below which a background pressure pass deletes gitignored build outputs
   * (`target/`, `node_modules/`, `dist/`, `.venv/`) from idle harness worktrees, least
   * recently used first, so part 1/4's hold rarely engages. Must be at least `diskHoldGB`
   * unless it is 0, which disables pressure reclaim (the hold then engages immediately).
   * Default 40. */
  diskReclaimGB: number;
  /** Idle reclaim (plans/disk-floor.md, "Disk floor 3/4"): how many hours a worktree may sit
   * unused before the hourly idle pass deletes its gitignored build outputs, whatever the free
   * space — catching paused, retired and rarely due roles. A worktree already reclaimed since
   * its last use is skipped, and one with a pending resume is never idle-reclaimed. 0 disables
   * idle mode. Default 24. */
  worktreeIdleReclaimHours: number;
  /** Operator notify hook: a shell command the orchestrator runs when a notable event fires
   * (the states where the team or one of its changes is stopped and only a human can act, plus
   * warnings ahead of them and a posted question; `NOTIFY_EVENT_TYPES` in src/events/notify.ts
   * owns the allowlist and the per-type one-minute throttle, and docs/config.md's Notify events
   * table lists it). The command
   * runs detached with
   * TUMWATER_EVENT_TYPE, TUMWATER_EVENT_SOURCE, and TUMWATER_EVENT_MESSAGE (the line
   * `tumwater logs` renders) in its environment; a nonzero exit logs a warning. Absent or an
   * empty string disables. */
  notify?: string;
  /** The budget fallback as one selector string `provider/id[:thinking]` (plans/model-tiers.md),
   * the shorthand form of `fallbackModel` — `"fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"` —
   * or an ordered list of selectors, or a map by tier whose values are selectors, lists, or
   * `"pause"` (each tier's own entry is consulted when that tier runs at the cap;
   * part 5a/8). Setting `fallback` and `fallbackModel` both is a validation error. */
  fallback?: string | FallbackStep[] | Partial<Record<ModelTier, FallbackChain>>;
  /** The free model roles switch to when `maxDailyCostUsd` is reached, instead of
   * stopping for the rest of the local day (plans/fallback-model.md). With one configured and
   * verifiable as cost-free in pi's models.json, the budget gate degrades the team to free
   * work rather than pausing it: spend cannot advance, so the cap still holds. Absent (the
   * default) — or present but not verifiably free — the gate pauses roles exactly as
   * before. The director is outside both behaviors: it keeps the budgeted model, because an
   * explicit human prompt outranks the autonomous-spend cap. */
  fallbackModel?: FallbackModelConfig;
  /** Each moved tier's chain-step cap by pair name (`modelPairName`), recorded by
   * applyFallbackModel on the derived view only so a run's per-run budget cap can read its
   * step's limit; never read from tumwater.json. */
  fallbackStepCaps?: Record<string, number>;
  /** Friction threshold in assistant turns: a changed run is flagged high-friction only when it
   * used MORE than this many turns AND ran longer than thrashMinutes (Friction trailer line on
   * its commit, warning event, and extra review scrutiny) — difficulty is a signal that the work
   * may not fit; requiring both keeps the absolute turn count from flagging a fast model's
   * ordinary work. See plans/refusal-and-thrash.md.
   */
  thrashTurns: number;
  /** Friction threshold in wall-clock minutes, same semantics as thrashTurns. */
  thrashMinutes: number;
  idleBackoff: BackoffConfig;
  /** Self-redeploy for a self-hosting team (src/redeploy/redeploy.ts): when main's build inputs
   * move past the running build and main is green, rebuild, drain, and restart onto the new code
   * (default true). Off, the dashboards still flag the build as stale but nothing restarts. */
  autoRestart: boolean;
  /** New-project bootstrap (plans/work-ratio.md, "New-project bootstrap"): set by `tumwater
   * init` when it seeds a project from nothing, and read by the bootstrap gate (part 2/2) to
   * hold the maintenance roles until this many plans have moved to PLANS.md's `## Done`.
   * Absent means no bootstrap, so existing configs are unaffected. Removing it ends bootstrap
   * early. */
  bootstrap?: BootstrapConfig;
  /** Adversarial pre-merge review gate (see src/review/review.ts). */
  review: ReviewConfig;
  /** User-defined roles (plans/user-defined-loops.md): each entry is merged into `roles` at
   * load time as `{ enabled: true }`, appended after the built-ins in array order — that single
   * move makes every existing mechanism (runner creation, live enable/disable, configForRole,
   * status lists, gates) work unchanged. Optional in the file, defaulted to `[]`; required on
   * this type so read sites never see undefined. */
  customRoles: CustomRole[];
  roles: Record<string, RoleConfig>;
}

/** Every key tumwater.json may hold, by level. Anything else is a typo that would be
 * silently ignored at runtime — the intended setting falls back to its default with no
 * warning — so validation (config-validation.ts's checkKnownKeys, fed from these tables)
 * fails fast instead (e.g. `runTimeoutSecondss` does nothing). Kept in sync with the
 * interfaces above in this same file: adding a key edits the interface and its level's
 * list side by side. */
export const TOP_LEVEL_KEYS = [
  "provider",
  "model",
  "thinking",
  "backend",
  "baseBranch",
  "agentBin",
  "backends",
  "check",
  "piArgs",
  "maxConcurrent",
  "maxConcurrentPerProvider",
  "claudeWindowReserve",
  "mergeBatchMax",
  "maxConcurrentChecks",
  "worktreeSlots",
  "minRunIntervalSeconds",
  "runTimeoutSeconds",
  "quietTimeoutSeconds",
  "toolCallStallSeconds",
  "logMaxBytes",
  "sessionRetentionDays",
  "maxDailyCostUsd",
  "maxDailyCostUsdPerRole",
  "maintenancePerWorkMerge",
  "quietHours",
  "quietHoursPerRole",
  "diskHoldGB",
  "diskReclaimGB",
  "worktreeIdleReclaimHours",
  "notify",
  "fallback",
  "fallbackModel",
  "thrashTurns",
  "thrashMinutes",
  "idleBackoff",
  "autoRestart",
  "bootstrap",
  "review",
  "customRoles",
  "roles",
];

export const BACKOFF_KEYS = ["initialSeconds", "factor", "maxSeconds"];

/** One agent backend's tumwater.json entry (plans/agent-backends.md "Config"): the binary
 * to spawn, the extra argv appended after the harness's own flags, and (claude only) the config
 * directory to force. Every field is optional, so an entry may override only one of them.
 * `configDir` becomes `CLAUDE_CONFIG_DIR` for every claude process tumwater spawns; only the
 * claude adapter reads it (plans/notes-command.md "Keeping funes out of team runs"). */
export interface BackendConfig {
  /** The backend binary; absent leaves the backend's own default. */
  bin?: string;
  /** Extra argv appended last, like piArgs; absent means none. */
  args?: string[];
  /** (claude only) The config dir set as `CLAUDE_CONFIG_DIR`, so team transcripts and claude's
   * own auth land in a directory of the team's own (a leading `~` expands; must be absolute after
   * expansion — validateConfig checks). Unset uses claude's default lookup. */
  configDir?: string;
}

/** The keys an `backends.<id>` entry may hold; validation feeds checkKnownKeys so a typo'd
 * field (`backends.claude.binary`) is a load error rather than a silently inert entry.
 * `configDir` is claude-only (CLAUDE_AGENT_KEYS), so it is not silently inert on pi/opencode. */
export const BACKEND_KEYS = ["bin", "args"];

/** The keys a claude `backends.claude` entry may hold — the shared agent keys plus `configDir`,
 * the one per-backend field only the claude adapter reads. */
export const CLAUDE_AGENT_KEYS = [...BACKEND_KEYS, "configDir"];

/** The keys tumwater.json's `bootstrap` section may hold. */
export const BOOTSTRAP_KEYS = ["untilPlansDone"];

export const ROLE_ENTRY_KEYS = [
  "enabled",
  "instructions",
  "provider",
  "model",
  "backend",
  "thinking",
  "minRunIntervalSeconds",
  "instances",
];

export const REVIEW_KEYS = ["enabled", "exemptPaths", "afterMerge", "provider", "model", "backend", "thinking", "timeoutSeconds"];

/** The `check` section's keys (plans/portability.md §6/7): the project's own verification
 * command, the optional cheaper gate-only command, their
 * working directory (relative to the worktree), and their timeout. */
export const CHECK_KEYS = ["command", "gateCommand", "mergeCommand", "cwd", "timeoutSeconds"];

/** The provider/model/thinking triple every model-override section shares — top level,
 * `review`, `fallbackModel` (plans/fallback-model.md), and each `roles.<id>` entry — so one
 * mental model and one validator cover them all. */
export const MODEL_TRIPLE_KEYS = ["provider", "model", "thinking"];

/** pi's accepted `--thinking` levels (pi's own `--help`). pi WARNS and falls back to its own
 * default on any other value rather than failing, so a misspelled level would silently run the
 * team at the wrong reasoning depth — the same silent-ignore class validation exists to
 * catch. Kept in sync with pi's CLI (dist/cli/args.js VALID_THINKING_LEVELS). */
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** pi flags the harness passes itself (src/pi/pi-args.ts's piArgs: `--print --mode json
 * --session-dir …`, the provider/model/thinking triple, and the session resume/name flags).
 * A piArgs entry equal to one of these is appended AFTER the harness's own copy, and pi's
 * argument parser is last-wins — so it silently overrides the harness: `--mode text` makes
 * every run's stream unparseable, `--model` spends on a model tumwater.json never named, and
 * `--continue` resumes a session the harness did not choose. Each flag maps to why it is
 * refused; the model triple points at the setting that owns it. */
export const HARNESS_PI_FLAGS = new Map<string, string>([
  ["--print", "tumwater already runs pi non-interactively"],
  ["-p", "tumwater already runs pi non-interactively"],
  ["--mode", "tumwater requires pi's json output mode"],
  ["--session-dir", "tumwater owns each role's session directory"],
  ["--continue", "tumwater decides when to resume a session"],
  ["-c", "tumwater decides when to resume a session"],
  ["-n", "tumwater names the session"],
  ["--name", "tumwater names the session"],
  ["--provider", "set the top-level or per-role `provider` instead"],
  ["--model", "set the top-level or per-role `model` instead"],
  ["--thinking", "set the top-level or per-role `thinking` instead"],
  // The harness passes --no-extensions itself (pi-args.ts's piArgs) so pi cannot load discovered
  // extensions; a piArgs entry that re-enabled them would put operator MCP servers back in.
  ["--no-extensions", "tumwater skips pi's discovered extensions itself"],
]);

export const CUSTOM_ROLE_KEYS = ["name", "task"];

/** A custom role's name becomes a worktree dir and a git ref, so it is validated strictly:
 * lowercase alphanumerics plus dash/underscore, starting with an alphanumeric, ≤ 32 chars. */
export const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A custom role's task rides into every one of that role's run prefills, so it is capped:
 * unbounded text would be a standing per-run cost. */
export const CUSTOM_TASK_MAX_CHARS = 4096;

/** A role's extra instructions ride into every one of that role's run prefills, so they are
 * capped like a custom role's task: unbounded text would be a standing per-run cost (and
 * could crowd the prompt toward the model's context ceiling). */
export const ROLE_INSTRUCTIONS_MAX_CHARS = 4096;

/** @deprecated Use BACKEND_IDS. */
export const AGENT_IDS = BACKEND_IDS;

/** @deprecated Use BACKEND_KEYS. */
export const AGENT_KEYS = BACKEND_KEYS;
