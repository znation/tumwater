/** The tumwater.json config schema shape: the types `config-validation.ts` validates a
 * loaded config into and every config read site consumes, plus the key allow-lists and
 * value shapes (`TOP_LEVEL_KEYS` and friends) that say what a valid file may hold at each
 * level — the schema facts, single-homed here so adding a key edits one file: its type,
 * its default (config.ts), and its allow-list entry sit beside each other. Split out of the former
 * types.ts grab-bag — the runtime types a tick produces now live beside their consumers
 * (TickResult and TickOutcome in tick-outcome.ts, LoopState in loop-state.ts, HarnessEvent
 * in events.ts, LandingEntry in landing-queue.ts, the pi-run types in pi.ts) — so the
 * schema the file on disk is validated against and the runtime state the harness runs with
 * are two layers, changed for different reasons by different readers: a tumwater.json knob
 * hunt starts here, a tick-lifecycle trace starts beside the type it traces. Sibling
 * modules: config.ts (defaults + load), config-validation.ts (validation), config-write.ts
 * (writes). */

import { isJsonObject } from "../files/json-object.js";

/** The model tiers a selector map may name (plans/model-tiers.md). A tier left out of the
 * `model` map inherits `default`'s model; `fallback` map values may also be `"pause"`
 * (consulted per tier in part 5/8). */
export const MODEL_TIERS = ["small", "default", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

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
  return isJsonObject(model) ? model : {};
}

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
  /** pi thinking-level override for this role; falls back to the top-level value. */
  thinking?: string;
  /** Minimum seconds between two ticks of THIS role, overriding the top-level value — a
   * slow clock for roles that should act rarely (the steward curates on ~6 h). */
  minTickIntervalSeconds?: number;
  /** How many parallel runners this role may have (plans/parallel-work-instances.md, part
   * 5/7): the bare id is instance 1, and `feature-2`…`feature-N` are the rest. Integer 1–8,
   * valid only under the `INSTANCE_ROLES` (`feature`, `bugfix`); absent means 1. */
  instances?: number;
}

/** A user-defined loop in tumwater.json's `customLoops` array
 * (plans/user-defined-loops.md): each entry becomes a full-citizen loop — persistent worktree +
 * branch, tick lifecycle, review gate, merge to main. Only the director may write this key; every
 * other role's prompt keeps the blanket tumwater.json ban. */
interface CustomLoop {
  /** The loop id: worktree dir, branch suffix (`tumwater/<name>`), and status row.
   * Validated at load against /^[a-z0-9][a-z0-9_-]{0,31}$/ — it becomes a filesystem path
   * and a git ref — with no collision with any catalog id (including the director) and unique
   * within the list. */
  name: string;
  /** The loop's standing instruction — its entire find-something-to-do prompt. Capped at
   * 4096 chars because it rides into every one of that loop's tick prefills. */
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
  /** pi provider override for reviewer runs; falls back to the top-level value. */
  provider?: string;
  /** pi model override for reviewer runs — a selector `provider/id[:thinking]`, or a tier
   * name (`small` / `default` / `strong`) naming that tier of the top-level `model` map
   * (plans/model-tiers.md). Falls back to the `strong` tier when absent — the reviewer is
   * the seam where model quality matters most. */
  model?: string;
  /** pi thinking-level override for reviewer runs; falls back to the top-level value. */
  thinking?: string;
  /** Wall-clock budget for one reviewer run, in seconds (default 900, capped by
   * tickTimeoutSeconds). A review that outruns it is a failed run — commit kept, no strike —
   * so one wedged reviewer cannot hold the land queue for a whole authoring tick. A reviewer
   * (and the landing conflict resolver, which shares the gate's wiring) that is still making
   * progress at the deadline receives one extension of the same length before it is killed. */
  timeoutSeconds?: number;
}

/** The free ("cost n/a") model the fleet falls back to once the daily cost budget is spent
 * (plans/fallback-model.md). Each field falls back to the top-level value, exactly like a
 * role's or the reviewer's overrides — so naming only `model` keeps the current provider.
 * The pair is engaged ONLY when pi's models.json prices it at zero; an unknown, unpriced-by-
 * absence, or paid pair is refused and the fleet pauses as it did before, because a fallback
 * that can spend would defeat the cap it is meant to survive. */
export interface FallbackModelConfig {
  /** pi provider for fallback runs; falls back to the top-level value. */
  provider?: string;
  /** pi model for fallback runs; falls back to the top-level value. */
  model?: string;
  /** pi thinking level for fallback runs; falls back to the top-level value. */
  thinking?: string;
}

/** Idle backoff: how long a loop sleeps after a tick that changed nothing. */
export interface BackoffConfig {
  /** Seconds to sleep after the first no-change tick. */
  initialSeconds: number;
  /** Multiplier applied on each consecutive no-change tick. */
  factor: number;
  /** Ceiling in seconds. */
  maxSeconds: number;
}

/** New-project bootstrap: when `tumwater init` seeds a project from nothing it sets this so
 * the bootstrap gate (plans/work-ratio.md, part 2/2) holds the maintenance loops until
 * `untilPlansDone` plans have moved to PLANS.md's `## Done`. */
interface BootstrapConfig {
  /** How many plans must be Done before the maintenance loops are admitted; an integer ≥ 1. */
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
   * runs the full check. When set, the batch and landing checks and the red-main baseline
   * still run the full check (`command`, else the npm walk-up), so every landing is verified
   * by it once per stack; shares `cwd` and `timeoutSeconds`. */
  gateCommand?: string;
  /** Working directory for the command, resolved relative to the worktree root; defaults to ".". */
  cwd?: string;
  /** Hard cap on one run, in seconds; defaults to the built-in 300 s. */
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
}

/** The tracked tumwater.json config. */
export interface TumwaterConfig {
  /** pi provider name; omitted = pi's own default. */
  provider?: string;
  /** pi model pattern; omitted = pi's own default. A string is one selector
   * `provider/id[:thinking]` (shorthand for `{ default: <string> }`); a map names the model
   * for each tier it has (plans/model-tiers.md) — keys are exactly `small` / `default` /
   * `strong`, and a map-form `model` cannot coexist with the legacy top-level `provider`. */
  model?: string | Partial<Record<ModelTier, string>>;
  /** pi thinking level; omitted = pi's own default. */
  thinking?: string;
  /** The branch the fleet merges into and bases every role worktree on — the resolved
   * "main". Omitted, the fleet targets whatever branch the primary checkout has checked
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
   * (src/pi/pi-bin.ts resolveAgentBin), so a relative path names the same file to the run
   * preflight, doctor, and the spawn itself — which runs with each tick's worktree as
   * cwd; a bare name is left to PATH resolution exactly as before. */
  agentBin?: string;
  /** Extra argv passed straight to pi. Must not repeat a flag the harness sets itself
   * (src/pi/pi.ts's `--print`/`--mode`/`--session-dir`, the provider/model/thinking triple, and
   * the session resume/name flags) — pi's parser is last-wins, so a repeat would silently
   * override the harness; validateConfig rejects the collision. */
  piArgs: string[];
  /** Max pi runs in flight at once across all loops, landings included: every landing vet
   * (rebased onto main, gate-checked, reviewed in a leased pool slot) holds one of these
   * permits for its length, and a merge's conflict resolver one for its run, ahead of any
   * waiting role tick (land-queue speed 2c). Only the director's own ticks run outside it. */
  maxConcurrent: number;
  /** Max vetted changes the orchestrator's merge slot stacks into ONE merge (plans/merge-queue.md
   * 5/5): the changes are stacked into one worktree, run through ONE shared build check, and
   * fast-forwarded to main in one ff. 1 lands every vetted change on its own (no coalescing). */
  landBatchMax: number;
  /** Max runs of the project's declared check (the full suite) in flight at once across the whole
   * harness process — every gate, landing, batch, and main-baseline check takes one permit
   * (src/concurrency/check-permit.ts's withCheckPermit), so a burst of landings cannot stack suites
   * on the host. Read at each check's start, so an edit applies live. */
  maxConcurrentChecks: number;
  /** How many pooled worktree slots exist (plans/worktree-pool.md, "Config"): the fixed set of
   * `.tumwater/worktrees/_slot-<n>` checkouts ticks and vets lease. Omitted, it resolves through
   * slotCount (src/config/config.ts) to `maxConcurrent + 1`. Must be at least 1; a value below
   * `maxConcurrent` is allowed — permit holders then wait for a slot to free. */
  worktreeSlots?: number;
  /** Minimum seconds between two ticks of the same loop, even when woken early. */
  minTickIntervalSeconds: number;
  /** Hard cap on a single pi run, in seconds. */
  tickTimeoutSeconds: number;
  /** Kill a pi run when it emits NO output for this many seconds (0 disables). A healthy
   * run streams events continuously even when slow; prolonged silence means a hung tool
   * (interactive command, zombie socket) that would otherwise burn the whole tick timeout. */
  quietTimeoutSeconds: number;
  /** Warn — without killing — when ONE tool call has been open this many seconds with no
   * content-bearing output update: a `warning` event names the command and the loop's state
   * cell flags it, while the quiet watchdog still counts down. Fires even while sibling calls
   * keep streaming (total silence is not required); 0 disables the warning. */
  toolCallStallSeconds: number;
  /** Rotate events.jsonl and per-role pi logs when they exceed this size. */
  logMaxBytes: number;
  /** Delete pi session files older than this many days at orchestrator start (0 disables). */
  sessionRetentionDays: number;
  /** Daily cost budget in USD for the fleet's autonomous spend: while the sum of every loop's
   * spend for the local day has reached this, role loops stop starting new ticks until the next
   * local midnight or a live edit raises/disables it (0 disables). The director is exempt — an
   * explicit human prompt outranks the autonomous-spend cap. See plans/daily-cost-budget.md. */
  maxDailyCostUsd: number;
  /** Per-role daily cost caps in USD, keyed by role id (the per-role sibling of
   * `maxDailyCostUsd`): a loop whose local-day spend has reached its cap starts no new ticks
   * until local midnight or a live edit raises/removes it. 0 disables that role's cap; an
   * absent key means uncapped. The director is exempt — an explicit human prompt outranks the
   * autonomous-spend cap. Keys must name known roles (built-in or customLoops) — a typo is a
   * validation error, never a silently inert cap. */
  maxDailyCostUsdPerRole?: Record<string, number>;
  /** Work ratio 1a/4 and 1b/4 (plans/work-ratio.md, "Maintenance follows work"): how many
   * code-maintenance landings the rolling 24 h window allows per work (feature/bugfix/director)
   * landing, on top of the fixed 12-landing floor. A number of 0 or more, default 2; there is no
   * off switch because a large value effectively disables the allowance. Once the window reaches
   * the allowance the scheduler holds maintenance loops until it rolls under (part 1b/4), except
   * a fresh `tumwater wake` or queued prompt admits one tick. */
  maintenancePerWorkLanding: number;
  /** Quiet hours: a daily local-time window — "HH:MM-HH:MM", e.g. "23:00-07:00" — during
   * which role loops start no new ticks (in-flight ticks finish; a tick due inside the
   * window starts at window end). A window may wrap midnight (start > end); an empty string
   * or an absent key means off. The director is exempt — a human steering outranks a
   * schedule, exactly as under the budget gate and the operator pause. */
  quietHours?: string;
  /** Per-role quiet hours (PLANS.md): the scheduled sibling of `maxDailyCostUsdPerRole` —
   * keyed by role id, each value the same "HH:MM-HH:MM" window the fleet-wide `quietHours`
   * takes (wrapping included; an empty string or an absent key means off for that role). A
   * loop whose own window covers the local wall clock starts no new ticks — in-flight ticks
   * finish — while the fleet-wide window keeps working unchanged: a role is held when
   * EITHER window covers now. The director is exempt, exactly as under the fleet window. */
  quietHoursPerRole?: Record<string, string>;
  /** Disk floor (plans/disk-floor.md, "Disk floor 1/4"): the free-space floor in GB
   * (10^9 bytes) for the volume holding `.tumwater/worktrees`. When free space drops below
   * it, no new work starts — role ticks, the director, landing vets and merges — until free
   * space climbs back to `diskHoldGB` + 5 GB (the hysteresis that keeps a fleet hovering at
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
   * (budget_paused, role_streak_paused, land_failed, restart_blocked — the states where the
   * fleet or one of its changes is stopped and only a human can act; src/events/notify.ts owns the
   * allowlist and the per-type one-minute throttle). The command runs detached with
   * TUMWATER_EVENT_TYPE, TUMWATER_EVENT_LOOP, and TUMWATER_EVENT_MESSAGE (the line
   * `tumwater logs` renders) in its environment. Absent or an empty string disables. */
  notify?: string;
  /** The budget fallback as one selector string `provider/id[:thinking]` (plans/model-tiers.md),
   * the shorthand form of `fallbackModel` — `"fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"` —
   * or a map by tier whose values are selectors or `"pause"` (the pause entries are consulted
   * per tier in part 5/8; until then a map uses its `default` entry). Setting `fallback` and
   * `fallbackModel` both is a validation error. */
  fallback?: string | Partial<Record<ModelTier, string>>;
  /** The free model role loops switch to when `maxDailyCostUsd` is reached, instead of
   * stopping for the rest of the local day (plans/fallback-model.md). With one configured and
   * verifiable as cost-free in pi's models.json, the budget gate degrades the fleet to free
   * work rather than pausing it: spend cannot advance, so the cap still holds. Absent (the
   * default) — or present but not verifiably free — the gate pauses role loops exactly as
   * before. The director is outside both behaviors: it keeps the budgeted model, because an
   * explicit human prompt outranks the autonomous-spend cap. */
  fallbackModel?: FallbackModelConfig;
  /** Friction threshold in assistant turns: a changed tick is flagged high-friction only when it
   * used MORE than this many turns AND ran longer than thrashMinutes (Friction trailer line on
   * its commit, warning event, and extra review scrutiny) — difficulty is a signal that the work
   * may not fit; requiring both keeps the absolute turn count from flagging a fast model's
   * ordinary work. See plans/refusal-and-thrash.md.
   */
  thrashTurns: number;
  /** Friction threshold in wall-clock minutes, same semantics as thrashTurns. */
  thrashMinutes: number;
  idleBackoff: BackoffConfig;
  /** Self-redeploy for a self-hosting fleet (src/redeploy/redeploy.ts): when main's build inputs
   * move past the running build and main is green, rebuild, drain, and restart onto the new code
   * (default true). Off, the dashboards still flag the build as stale but nothing restarts. */
  autoRestart: boolean;
  /** New-project bootstrap (plans/work-ratio.md, "New-project bootstrap"): set by `tumwater
   * init` when it seeds a project from nothing, and read by the bootstrap gate (part 2/2) to
   * hold the maintenance loops until this many plans have moved to PLANS.md's `## Done`.
   * Absent means no bootstrap, so existing configs are unaffected. Removing it ends bootstrap
   * early. */
  bootstrap?: BootstrapConfig;
  /** Adversarial pre-merge review gate (see src/review/review.ts). */
  review: ReviewConfig;
  /** User-defined loops (plans/user-defined-loops.md): each entry is merged into `roles` at
   * load time as `{ enabled: true }`, appended after the built-ins in array order — that single
   * move makes every existing mechanism (runner creation, live enable/disable, configForRole,
   * status lists, gates) work unchanged. Optional in the file, defaulted to `[]`; required on
   * this type so read sites never see undefined. */
  customLoops: CustomLoop[];
  roles: Record<string, RoleConfig>;
}

/** Every key tumwater.json may hold, by level. Anything else is a typo that would be
 * silently ignored at runtime — the intended setting falls back to its default with no
 * warning — so validation (config-validation.ts's checkKnownKeys, fed from these tables)
 * fails fast instead (e.g. `tickTimeoutSecondss` does nothing). Kept in sync with the
 * interfaces above in this same file: adding a key edits the interface and its level's
 * list side by side. */
export const TOP_LEVEL_KEYS = [
  "provider",
  "model",
  "thinking",
  "baseBranch",
  "agentBin",
  "check",
  "piArgs",
  "maxConcurrent",
  "landBatchMax",
  "maxConcurrentChecks",
  "worktreeSlots",
  "minTickIntervalSeconds",
  "tickTimeoutSeconds",
  "quietTimeoutSeconds",
  "toolCallStallSeconds",
  "logMaxBytes",
  "sessionRetentionDays",
  "maxDailyCostUsd",
  "maxDailyCostUsdPerRole",
  "maintenancePerWorkLanding",
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
  "customLoops",
  "roles",
];

export const BACKOFF_KEYS = ["initialSeconds", "factor", "maxSeconds"];

/** The keys tumwater.json's `bootstrap` section may hold. */
export const BOOTSTRAP_KEYS = ["untilPlansDone"];

export const ROLE_ENTRY_KEYS = [
  "enabled",
  "instructions",
  "provider",
  "model",
  "thinking",
  "minTickIntervalSeconds",
  "instances",
];

export const REVIEW_KEYS = ["enabled", "exemptPaths", "provider", "model", "thinking", "timeoutSeconds"];

/** The `check` section's keys (plans/portability.md §6/7): the project's own verification
 * command, the optional cheaper gate-only command (PLANS.md Land-queue speed 3e), their
 * working directory (relative to the worktree), and their timeout. */
export const CHECK_KEYS = ["command", "gateCommand", "cwd", "timeoutSeconds"];

/** The provider/model/thinking triple every model-override section shares — top level,
 * `review`, `fallbackModel` (plans/fallback-model.md), and each `roles.<id>` entry — so one
 * mental model and one validator cover them all. */
export const MODEL_TRIPLE_KEYS = ["provider", "model", "thinking"];

/** pi's accepted `--thinking` levels (pi's own `--help`). pi WARNS and falls back to its own
 * default on any other value rather than failing, so a misspelled level would silently run the
 * fleet at the wrong reasoning depth — the same silent-ignore class validation exists to
 * catch. Kept in sync with pi's CLI (dist/cli/args.js VALID_THINKING_LEVELS). */
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** pi flags the harness passes itself (src/pi/pi.ts's piArgs: `--print --mode json
 * --session-dir …`, the provider/model/thinking triple, and the session resume/name flags).
 * A piArgs entry equal to one of these is appended AFTER the harness's own copy, and pi's
 * argument parser is last-wins — so it silently overrides the harness: `--mode text` makes
 * every tick's stream unparseable, `--model` spends on a model tumwater.json never named, and
 * `--continue` resumes a session the harness did not choose. Each flag maps to why it is
 * refused; the model triple points at the setting that owns it. */
export const HARNESS_PI_FLAGS = new Map<string, string>([
  ["--print", "the harness already runs pi non-interactively"],
  ["-p", "the harness already runs pi non-interactively"],
  ["--mode", "the harness requires pi's json output mode"],
  ["--session-dir", "the harness owns each role's session directory"],
  ["--continue", "the harness decides when to resume a session"],
  ["-c", "the harness decides when to resume a session"],
  ["-n", "the harness names the session"],
  ["--name", "the harness names the session"],
  ["--provider", "set the top-level or per-role `provider` instead"],
  ["--model", "set the top-level or per-role `model` instead"],
  ["--thinking", "set the top-level or per-role `thinking` instead"],
]);

export const CUSTOM_LOOP_KEYS = ["name", "task"];

/** A custom loop's name becomes a worktree dir and a git ref, so it is validated strictly:
 * lowercase alphanumerics plus dash/underscore, starting with an alphanumeric, ≤ 32 chars. */
export const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A custom loop's task rides into every one of that loop's tick prefills, so it is capped:
 * unbounded text would be a standing per-tick cost. */
export const CUSTOM_TASK_MAX_CHARS = 4096;

/** A role's extra instructions ride into every one of that role's tick prefills, so they are
 * capped like a custom loop's task: unbounded text would be a standing per-tick cost (and
 * could crowd the prompt toward the model's context ceiling). */
export const ROLE_INSTRUCTIONS_MAX_CHARS = 4096;
