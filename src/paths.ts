import fs from "node:fs";
import path from "node:path";

/** All harness runtime state lives under <repo>/.tumwater (gitignored). */
export const STATE_DIR = ".tumwater";

/** Pre-rename names (the project used to be called "automaton"). Only the migration
 * below may reference them. */
const LEGACY_STATE_DIR = ".automaton";
const LEGACY_CONFIG_FILE = "automaton.json";

/** Adopt runtime state from a repo initialized under the project's old name: renames
 * `.automaton/` to `.tumwater/` and `automaton.json` to `tumwater.json` when the new
 * names don't exist yet. Worktrees under the old dir are dropped (their git metadata
 * points at the old path); loops recreate them on the next tick. Idempotent. */
export function migrateLegacyState(root: string): void {
  const legacyDir = path.join(root, LEGACY_STATE_DIR);
  const newDir = tumwaterDir(root);
  if (fs.existsSync(legacyDir) && !fs.existsSync(newDir)) {
    fs.renameSync(legacyDir, newDir);
    fs.rmSync(path.join(newDir, "worktrees"), { recursive: true, force: true });
  }
  const legacyConfig = path.join(root, LEGACY_CONFIG_FILE);
  if (fs.existsSync(legacyConfig) && !fs.existsSync(configPath(root))) {
    fs.renameSync(legacyConfig, configPath(root));
  }
}

export function tumwaterDir(root: string): string {
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
