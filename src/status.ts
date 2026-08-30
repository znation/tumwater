import type { LoopState, TumwaterConfig } from "./types.js";
import { openQuestions } from "./backlog.js";
import { defaultConfig, enabledRoleIds, loadConfigSafe } from "./config.js";
import { cachedByStat, type StatKeyedValue } from "./files.js";
import { inboxSize } from "./inbox.js";
import { statePath } from "./paths.js";
import { freshLoopState, loadLoopState, orchestratorAlive, readOrchestratorInfo } from "./state.js";

/** Status data collection: one fresh snapshot of the fleet for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  loops: LoopState[];
}

// The last config each root loaded successfully. snapshot is polled every second by the
// TUI and GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the fleet with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display loop state against: fresh when valid, otherwise the last
 * known-good one (or defaults if this process never saw a valid file). Never throws. */
function configForStatus(root: string): TumwaterConfig {
  const { config } = loadConfigSafe(root);
  if (config) {
    lastGoodConfig.set(root, config);
    return config;
  }
  return lastGoodConfig.get(root) ?? defaultConfig();
}

// Per-poll loop-state cache (files.cachedByStat): the TUI and GUI poll snapshot every second,
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
  const roles = enabledRoleIds(configForStatus(root));
  const info = readOrchestratorInfo(root);
  return {
    running: orchestratorAlive(root),
    pid: info?.pid,
    inbox: inboxSize(root),
    questions: openQuestions(root).length,
    loops: roles.map((r) => loopStateForPoll(root, r)),
  };
}
