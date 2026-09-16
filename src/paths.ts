import path from "node:path";

/** All harness runtime state lives under <repo>/.tumwater (gitignored). */
export const STATE_DIR = ".tumwater";

function tumwaterDir(root: string): string {
  return path.join(root, STATE_DIR);
}

/** The repo's tumwater.json — the fleet config (config.ts). */
export function configPath(root: string): string {
  return path.join(root, "tumwater.json");
}

/** A loop's persistent git worktree under .tumwater/worktrees/. */
export function worktreePath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "worktrees", role);
}

/** A loop's persistent branch name. */
export function branchName(role: string): string {
  return `tumwater/${role}`;
}

/** A role's per-loop state file (.tumwater/state/<role>.json; state.ts). */
export function statePath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "state", `${role}.json`);
}

/** The orchestrator's own info file (its pid, for liveness checks — state.ts). */
export function orchestratorStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "orchestrator.json");
}

/** The in-flight landing marker (state.ts, merge queue 4/5): the orchestrator's drain task
 * writes it when a landing starts and removes it after every outcome — the observers
 * (`status`, TUI, GUI) are separate processes that cannot see the drain's in-memory promise,
 * but they can read this file (plans/merge-queue.md). */
export function landingStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "landing.json");
}

/** The last completed auto-restart's timestamp (epoch ms) — unlike orchestrator.json it must
 * survive the process exit that IS the restart, so it lives in its own file and is never removed
 * on exit (redeploy.ts; BUGS.md 2026-09-11). */
export function autoRestartStampPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "auto-restart.json");
}

/** Marker file `tumwater reset-counters` drops for a running fleet to consume (it must also
 * zero the runners' in-memory counters, or their next save resurrects the old values). */
export function resetRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "reset-counters.json");
}

/** Marker file `tumwater wake [--role <id>]` drops for a running fleet to consume: like the
 * reset-counters marker it must name its targets because it can affect many loops, and like it
 * it must reach the runners' IN-MEMORY schedule — the poll loop reads eligibility from the
 * in-memory state, so clearing only the on-disk file would not wake anything. */
export function wakeRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "wake.json");
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

/** The append-only harness event log (events.ts); the CLI, TUI, and status payload read it. */
export function eventsLogPath(root: string): string {
  return path.join(tumwaterDir(root), "log", "events.jsonl");
}

/** A role's raw pi transcript log (.tumwater/log/<role>.pi.jsonl); tailed by the GUI/TUI. */
export function piLogPath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "log", `${role}.pi.jsonl`);
}

/** Root of all pi session dirs under .tumwater/sessions/. */
export function sessionsRootDir(root: string): string {
  return path.join(tumwaterDir(root), "sessions");
}

/** A role's own pi session dir; hasResumableSession looks here for an interrupted tick to resume. */
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

/** Queued human prompts awaiting pickup by a loop (inbox.ts). */
export function inboxDir(root: string): string {
  return path.join(tumwaterDir(root), "inbox");
}

/** The durable land queue (src/land-queue.ts): a changed tick's pinned commit waits here as
 * one JSON file for the orchestrator's single landing slot, which drains it outside the author
 * semaphore (plans/merge-queue.md 3/5). Like the inbox it is a directory of timestamped files —
 * a crash between enqueue and drop loses nothing, and `tumwater status` can read it without the
 * scheduler. */
export function landQueueDir(root: string): string {
  return path.join(tumwaterDir(root), "land-queue");
}

/** The lock dir serializing merges to main (merge.ts; doctor checks it). */
export function mergeLockDir(root: string): string {
  return path.join(tumwaterDir(root), "merge.lock");
}

/** Detached worktree pinned at main's head for the self-redeploy path (redeploy.ts): the green
 * check and the compile both read exactly the tree main names, never the primary checkout. Named
 * with a leading underscore like the reviewer session dir so it can never collide with a role. */
export function mirrorWorktreePath(root: string): string {
  return path.join(tumwaterDir(root), "worktrees", "_main");
}

/** A role's lander worktree (src/lander.ts): the detached checkout where its pinned commit is
 * reviewed and rebased onto main, outside the role's own worktree. One per role so two roles'
 * landings never wait on each other; the leading underscore follows the _main convention above,
 * so it can never collide with a role worktree (plans/merge-queue.md). */
export function landWorktreePath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "worktrees", `_land-${role}`);
}

/** The ref pinning a role's committed-but-unlanded sha (plans/merge-queue.md invariant 4):
 * written right after the tick's commit, before its branch resets to main, so the reset cannot
 * orphan the work. Deleted on every terminal landing outcome; kept until re-landed otherwise. */
export function landingRefName(role: string): string {
  return `refs/tumwater/landing/${role}`;
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
