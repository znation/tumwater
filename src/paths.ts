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

/** Per-role marker file `tumwater abort --role <id>` drops for a running fleet to consume:
 * kill that loop's in-flight tick. One file per role (presence = pending request; content is
 * just `{ at }`) keeps consumption race-free and needs no parsing — unlike the single shared
 * reset-counters marker, which must name its targets because it affects many loops. */
export function abortRequestPath(root: string, role: string): string {
  return path.join(tumwaterDir(root), `abort-${role}.json`);
}

/** Persistent operator-intent marker for `tumwater pause`: its presence means "the fleet is
 * paused" until `resume` removes it — unlike the abort/reset markers above, which are one-shot
 * requests consumed on pickup. Content is `{ at }` (the pause timestamp), read for display
 * only, never required. */
export function pausedPath(root: string): string {
  return path.join(tumwaterDir(root), "paused.json");
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

/** Session dir for a role's review-gate runs. Kept OUTSIDE the role's own session dir on
 * purpose: hasResumableSession (the resume-after-shutdown guard) must only ever see the
 * AUTHOR's sessions — a leftover reviewer session would make an interrupted tick "resume"
 * into a review context it never had. Old files are cleaned by the same age-based prune.
 */
export function reviewSessionDir(root: string, role: string): string {
  return path.join(sessionsRootDir(root), "_review", role);
}

export function inboxDir(root: string): string {
  return path.join(tumwaterDir(root), "inbox");
}

export function mergeLockDir(root: string): string {
  return path.join(tumwaterDir(root), "merge.lock");
}

/** Detached worktree pinned at main's head for the self-redeploy path (redeploy.ts): the green
 * check and the compile both read exactly the tree main names, never the primary checkout. Named
 * with a leading underscore like the reviewer session dir so it can never collide with a role. */
export function mirrorWorktreePath(root: string): string {
  return path.join(tumwaterDir(root), "worktrees", "_main");
}

/** Where redeploy stages compiled builds before swapping one into dist/ — under .tumwater/ so a
 * build in progress never dirties the primary checkout (dist/ is gitignored, a sibling would not be). */
export function stagingRootDir(root: string): string {
  return path.join(tumwaterDir(root), "build");
}

/** One head's staged build (see stagingRootDir). */
export function stagingDir(root: string, sha: string): string {
  return path.join(stagingRootDir(root), sha);
}
