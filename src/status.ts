import type { LoopState, TumwaterConfig } from "./types.js";
import { openQuestions } from "./backlog.js";
import { defaultConfig, enabledRoleIds, loadConfigSafe } from "./config.js";
import { loadLoopState, orchestratorAlive, readOrchestratorInfo } from "./state.js";
import { inboxSize } from "./inbox.js";

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

export function snapshot(root: string): StatusSnapshot {
  const roles = enabledRoleIds(configForStatus(root));
  const info = readOrchestratorInfo(root);
  return {
    running: orchestratorAlive(root),
    pid: info?.pid,
    inbox: inboxSize(root),
    questions: openQuestions(root).length,
    loops: roles.map((r) => loadLoopState(root, r)),
  };
}
