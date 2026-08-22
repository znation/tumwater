import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig, LoopState } from "./types.js";
import { statePath } from "./paths.js";

export function freshLoopState(role: string): LoopState {
  return {
    role,
    ticks: 0,
    commits: 0,
    nextRunAt: 0,
    backoffSeconds: 0,
    lastMainHead: "",
    totalTokens: 0,
    totalCostUsd: 0,
  };
}

export function loadLoopState(root: string, role: string): LoopState {
  const file = statePath(root, role);
  if (!fs.existsSync(file)) return freshLoopState(role);
  try {
    return { ...freshLoopState(role), ...(JSON.parse(fs.readFileSync(file, "utf8")) as LoopState) };
  } catch {
    return freshLoopState(role);
  }
}

export function saveLoopState(root: string, state: LoopState): void {
  const file = statePath(root, state.role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Next backoff after a no-change tick: initial on the first, then multiplied, capped. */
export function nextBackoffSeconds(current: number, config: TumwaterConfig): number {
  const { initialSeconds, factor, maxSeconds } = config.idleBackoff;
  if (current <= 0) return Math.min(initialSeconds, maxSeconds);
  return Math.min(current * factor, maxSeconds);
}
