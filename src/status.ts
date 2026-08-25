import type { LoopState } from "./types.js";
import { enabledRoleIds, loadConfig } from "./config.js";
import { loadLoopState } from "./state.js";
import { inboxSize } from "./inbox.js";
import { orchestratorAlive, readOrchestratorInfo } from "./orchestrator.js";

/** Status data collection: one fresh snapshot of the fleet for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  loops: LoopState[];
}

export function snapshot(root: string): StatusSnapshot {
  const config = loadConfig(root);
  const roles = enabledRoleIds(config);
  const info = readOrchestratorInfo(root);
  return {
    running: orchestratorAlive(root),
    pid: info?.pid,
    inbox: inboxSize(root),
    loops: roles.map((r) => loadLoopState(root, r)),
  };
}
