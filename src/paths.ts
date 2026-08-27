import path from "node:path";

/** All harness runtime state lives under <repo>/.tumwater (gitignored). */
export const STATE_DIR = ".tumwater";

function tumwaterDir(root: string): string {
  return path.join(root, STATE_DIR);
}

export function configPath(root: string): string {
  return path.join(root, "tumwater.json");
}

export function worktreePath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "worktrees", role);
}

export function branchName(role: string): string {
  return `tumwater/${role}`;
}

export function statePath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "state", `${role}.json`);
}

export function orchestratorStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "orchestrator.json");
}

/** Marker file `tumwater reset-counters` drops for a running fleet to consume (it must also
 * zero the runners' in-memory counters, or their next save resurrects the old values). */
export function resetRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "reset-counters.json");
}

export function eventsLogPath(root: string): string {
  return path.join(tumwaterDir(root), "log", "events.jsonl");
}

export function piLogPath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "log", `${role}.pi.jsonl`);
}

export function sessionsRootDir(root: string): string {
  return path.join(tumwaterDir(root), "sessions");
}

export function sessionDir(root: string, role: string): string {
  return path.join(sessionsRootDir(root), role);
}

export function inboxDir(root: string): string {
  return path.join(tumwaterDir(root), "inbox");
}

export function mergeLockDir(root: string): string {
  return path.join(tumwaterDir(root), "merge.lock");
}
