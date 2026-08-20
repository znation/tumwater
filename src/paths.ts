import path from "node:path";

/** All harness runtime state lives under <repo>/.automaton (gitignored). */
export const STATE_DIR = ".automaton";

export function automatonDir(root: string): string {
  return path.join(root, STATE_DIR);
}

export function configPath(root: string): string {
  return path.join(root, "automaton.json");
}

export function worktreePath(root: string, role: string): string {
  return path.join(automatonDir(root), "worktrees", role);
}

export function branchName(role: string): string {
  return `automaton/${role}`;
}

export function statePath(root: string, role: string): string {
  return path.join(automatonDir(root), "state", `${role}.json`);
}

export function orchestratorStatePath(root: string): string {
  return path.join(automatonDir(root), "state", "orchestrator.json");
}

export function eventsLogPath(root: string): string {
  return path.join(automatonDir(root), "log", "events.jsonl");
}

export function piLogPath(root: string, role: string): string {
  return path.join(automatonDir(root), "log", `${role}.pi.jsonl`);
}

export function sessionDir(root: string, role: string): string {
  return path.join(automatonDir(root), "sessions", role);
}

export function inboxDir(root: string): string {
  return path.join(automatonDir(root), "inbox");
}

export function mergeLockDir(root: string): string {
  return path.join(automatonDir(root), "merge.lock");
}
