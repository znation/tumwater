import type { LoopState, TumwaterConfig } from "./types.js";
import { openQuestions } from "./backlog.js";
import { defaultConfig, enabledRoleIds, loadConfigCached } from "./config.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { promptPreview, queuedPrompts } from "./inbox.js";
import { statePath } from "./paths.js";
import {
  fleetDailyCost,
  freshLoopState,
  loadLoopState,
  orchestratorAlive,
  readOrchestratorInfo,
} from "./state.js";

/** Status data collection: one fresh snapshot of the fleet for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Previews of those queued prompts in execution order, each via promptPreview (the shared
   * one-line preview width also used by the event previews) — full text would bloat the GUI
   * payload, and dashboards clip display width themselves. Fresh per poll like `questions`. */
  inboxPrompts: string[];
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  loops: LoopState[];
  /** The daily cost budget while enabled (`maxDailyCostUsd` > 0): today's fleet spend vs the
   * cap, for the `· budget: $X/$Y today` header badge on both dashboards. Null when disabled.
   * Spend lags in-flight ticks by up to one tick boundary — exactly like the cost column. */
  budget: { spentUsd: number; capUsd: number } | null;
}

// The last config each root loaded successfully. snapshot is polled every second by the
// TUI and GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the fleet with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display loop state against: fresh when valid, otherwise the last
 * known-good one (or defaults if this process never saw a valid file). Never throws.
 * Freshness is stat-keyed (config.loadConfigCached): an unedited tumwater.json costs one
 * stat per poll instead of a read + parse + validate. */
function configForStatus(root: string): TumwaterConfig {
  const { config } = loadConfigCached(root);
  if (config) {
    lastGoodConfig.set(root, config);
    return config;
  }
  return lastGoodConfig.get(root) ?? defaultConfig();
}

// Per-poll loop-state cache (stat-cache.cachedByStat): the TUI and GUI poll snapshot every second,
// but a role's state file changes only at its tick boundaries (start/end) — between ticks it
// sits unchanged for minutes. Serve an unchanged file from the stat-keyed cache: one stat
// syscall per file per poll instead of re-reading and re-parsing JSON that hasn't moved.
// Keyed by state-file path so distinct roots never collide; capped inside cachedByStat so many
// short-lived roots in tests cannot grow it unbounded.
const loopStateCache = new Map<string, StatKeyedValue<LoopState>>();

/** This poll's view of one role's state: fresh when the file changed since this process last
 * read it, cached otherwise (see above). Returns a copy so each snapshot owns its data —
 * mutating one poll's LoopState must not poison later polls. A missing state file yields a
 * fresh state, as loadLoopState does for an unreadable one. */
function loopStateForPoll(root: string, role: string): LoopState {
  const file = statePath(root, role);
  return (
    cachedByStat(
      loopStateCache,
      file,
      file,
      () => loadLoopState(root, role),
      (state) => ({ ...state }), // A copy: callers may treat the result as their own.
    ) ?? freshLoopState(role)
  );
}

export function snapshot(root: string): StatusSnapshot {
  const cfg = configForStatus(root);
  const roles = enabledRoleIds(cfg);
  // One read of the orchestrator info file per poll: it serves both the displayed pid and the
  // liveness check (passing it to orchestratorAlive skips its own re-read).
  const info = readOrchestratorInfo(root);
  const loops = roles.map((r) => loopStateForPoll(root, r));
  // One inbox pass per poll serves both fields (queuedPrompts lists the directory and reads
  // each file once): the count is the prompts' length, so a prompt enqueued or dequeued
  // mid-snapshot can never make the header badge disagree with its numbered previews.
  const inboxPrompts = queuedPrompts(root).map(promptPreview);
  return {
    running: orchestratorAlive(root, info),
    pid: info?.pid,
    inbox: inboxPrompts.length,
    inboxPrompts,
    questions: openQuestions(root).length,
    loops,
    budget:
      cfg.maxDailyCostUsd > 0 ? { spentUsd: fleetDailyCost(loops), capUsd: cfg.maxDailyCostUsd } : null,
  };
}
