/** The tumwater.json config schema shape: the types `config-validation.ts` validates a
 * loaded config into and every config read site consumes. Split out of types.ts — which
 * keeps the runtime types a tick produces (TickResult, TickOutcome, LoopState, events,
 * landings, pi runs) — so the schema the file on disk is validated against and the
 * runtime state the harness runs with are two layers, changed for different reasons by
 * different readers: a tumwater.json knob hunt starts here, a tick-lifecycle trace starts
 * there. Sibling modules: config.ts (defaults + load), config-validation.ts (validation),
 * config-write.ts (writes). */

/** Per-role configuration in tumwater.json. */
export interface RoleConfig {
  enabled: boolean;
  /** Extra instructions appended to this role's prompt. */
  instructions?: string;
  /** pi provider override for this role; falls back to the top-level value. */
  provider?: string;
  /** pi model override for this role; falls back to the top-level value. */
  model?: string;
  /** pi thinking-level override for this role; falls back to the top-level value. */
  thinking?: string;
  /** Minimum seconds between two ticks of THIS role, overriding the top-level value — a
   * slow clock for roles that should act rarely (the steward curates on ~6 h). */
  minTickIntervalSeconds?: number;
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

/** Top-level review-gate config in tumwater.json (see src/review.ts). */
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
  /** pi model override for reviewer runs — e.g. the strong model reviews what the cheap
   * model wrote. Falls back to the top-level value. */
  model?: string;
  /** pi thinking-level override for reviewer runs; falls back to the top-level value. */
  thinking?: string;
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

/** The project's declared verification command (plans/portability.md §6/7) — a property of
 * the target repo, not of the machine running tumwater, which is why it is a project key in
 * the shareable config rather than a host setting. */
export interface CheckConfig {
  /** Shell command that verifies the tree — often compound ("cargo fmt --check && cargo test").
   * Runs in the worktree so it verifies the branch state, not a checkout of main. */
  command: string;
  /** Working directory for the command, resolved relative to the worktree root; defaults to ".". */
  cwd?: string;
  /** Hard cap on one run, in seconds; defaults to the built-in 300 s. */
  timeoutSeconds?: number;
}

/** The tracked tumwater.json config. */
export interface TumwaterConfig {
  /** pi provider name; omitted = pi's own default. */
  provider?: string;
  /** pi model pattern; omitted = pi's own default. */
  model?: string;
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
   * (src/pi.ts resolveAgentBin), so a relative path names the same file to the run
   * preflight, doctor, and the spawn itself — which runs with each tick's worktree as
   * cwd; a bare name is left to PATH resolution exactly as before. */
  agentBin?: string;
  /** Extra argv passed straight to pi. Must not repeat a flag the harness sets itself
   * (src/pi.ts's `--print`/`--mode`/`--session-dir`, the provider/model/thinking triple, and
   * the session resume/name flags) — pi's parser is last-wins, so a repeat would silently
   * override the harness; validateConfig rejects the collision. */
  piArgs: string[];
  /** Max pi runs in flight at once across all loops. */
  maxConcurrent: number;
  /** Max queued landings the orchestrator's landing slot stacks into ONE batch per drain
   * (plans/merge-queue.md 5/5): the changes are stacked into one worktree, run through ONE
   * shared build check, and fast-forwarded to main in one ff. 1 reproduces the single-
   * landing path exactly (no coalescing). */
  landBatchMax: number;
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
  /** Self-redeploy for a self-hosting fleet (src/redeploy.ts): when main's build inputs move past
   * the running build and main is green, rebuild, drain, and restart onto the new code (default
   * true). Off, the dashboards still flag the build as stale but nothing restarts. */
  autoRestart: boolean;
  /** Adversarial pre-merge review gate (see src/review.ts). */
  review: ReviewConfig;
  /** User-defined loops (plans/user-defined-loops.md): each entry is merged into `roles` at
   * load time as `{ enabled: true }`, appended after the built-ins in array order — that single
   * move makes every existing mechanism (runner creation, live enable/disable, configForRole,
   * status lists, gates) work unchanged. Optional in the file, defaulted to `[]`; required on
   * this type so read sites never see undefined. */
  customLoops: CustomLoop[];
  roles: Record<string, RoleConfig>;
}
