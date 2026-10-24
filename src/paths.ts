import path from "node:path";
import { DIRECTOR_ROLE } from "./roles/roles.js";
import { isDirectory } from "./files/files.js";
import { shortSha } from "./text/format.js";

/** All harness runtime state lives under <repo>/.tumwater (gitignored). */
export const STATE_DIR = ".tumwater";

/** The config file's basename — the name .gitignore's entry and the init output share. */
export const CONFIG_BASENAME = "tumwater.json";

/** The tracked settings template's basename: the shareable baseline an untracked
 * tumwater.json is seeded from (plans/portability.md §4a/7). */
export const EXAMPLE_CONFIG_BASENAME = "tumwater.example.json";

/** The files the project brief (the managed brief text + status sections) may live in,
 * candidates in resolution order: TUMWATER.md first, so an adopted repo's own README.md stays
 * untouched (plans/portability.md §7a/7); README.md is the compatibility path every repo
 * tumwater has created so far. */
export function briefCandidates(root: string): string[] {
  return [path.join(root, "TUMWATER.md"), path.join(root, "README.md")];
}

function tumwaterDir(root: string): string {
  return path.join(root, STATE_DIR);
}

/** The repo's tumwater.json — the team config (config.ts). */
export function configPath(root: string): string {
  return path.join(root, CONFIG_BASENAME);
}

/** The cross-process lock serializing read-modify-write updates of tumwater.json
 * (writeConfigMutation in config/config-write-core.ts and applyConfigRequest in
 * config/config-request.ts): the CLI's
 * `tumwater config set`, a standalone `tumwater gui` server, and the running team are separate
 * processes that can rewrite one config in the same instant, and without serialization each
 * one's whole-file write silently drops the others' change. A lock directory owned by the
 * shared mkdir-and-pid mutex (withSyncLock, src/concurrency/lock.ts), which creates and removes
 * it; lives under .tumwater/state so it never enters the tracked tree. */
export function configLockPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "config.lock");
}

/** The cross-process lock serializing writes to the primary checkout's tracked backlog files:
 * `tumwater bug`/`plan` (backlog-write.ts's appendEntry) and `tumwater questions answer`
 * (backlog/question-answer.ts's tryAnswerQuestion) each read a whole backlog file and rewrite
 * it, while a merge's working-tree fast-forward (merge-git.ts's ffMainTo) updates those
 * same files in
 * the same checkout by `git merge --ff-only`. Without a shared lock the CLI's stale read can
 * overwrite the merged change, and vice versa. Same mkdir-and-pid mutex as configLockPath, under
 * .tumwater/state so it never enters the tracked tree; its critical sections are one file read
 * plus one atomic rename, short enough to exclude a merge without stalling the build re-check. */
export function primaryWorktreeLockPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "primary-worktree.lock");
}

/** The repo's tracked settings template, beside the config it seeds (plans/portability.md
 * §4a/7): shipped by the project, read by init's seeding and doctor's drift check. */
export function exampleConfigPath(root: string): string {
  return path.join(root, EXAMPLE_CONFIG_BASENAME);
}

/** The director's config-write request file, at its worktree root (plans/portability.md §3/7):
 * the director writes it, the harness consumes and deletes it before any commit path — so it
 * never enters a diff, a review prompt, or the project's history, and custom-role management
 * works whether or not tumwater.json is tracked. */
export function configRequestPath(wt: string): string {
  return path.join(wt, ".tumwater-config-request.json");
}

/** The directory every harness worktree lives under — role, merger and mirror alike. The
 * single home of the tumwaterDir + worktrees pair: every worktree path helper below joins
 * its leaf through this, so the layout moves in one place. */
export function worktreesDir(root: string): string {
  return path.join(tumwaterDir(root), "worktrees");
}

/** Where a pooled slot's uncommitted leftovers are saved as patches before the slot is reset for
 * another lease (slot-salvage.ts). A patch directly here is kept for the operator until session
 * retention prunes it; one waiting for its role's next run lives under salvagePendingDir. */
export function salvageDir(root: string): string {
  return path.join(tumwaterDir(root), "salvage");
}

/** The patches of `role`'s unfinished work waiting for its next run to restore them
 * (slot-salvage.ts, restoreSalvagedWork). */
export function salvagePendingDir(root: string, role: string): string {
  return path.join(salvageDir(root), "pending", role);
}

/** A role's persistent git worktree under .tumwater/worktrees/. */
export function worktreePath(root: string, role: string): string {
  return path.join(worktreesDir(root), role);
}

/** A role's persistent branch name. */
export function branchName(role: string): string {
  return `tumwater/${role}`;
}

/** A role's state file (.tumwater/state/<role>.json; runner-state.ts). */
export function statePath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "state", `${role}.json`);
}

/** A backend's subscription account state (.tumwater/state/<backend>-account.json;
 * subscription-account.ts): the billing answer and newest subscription window readings,
 * written by the orchestrator only. */
export function accountPath(root: string, backend: string): string {
  return path.join(tumwaterDir(root), "state", `${backend}-account.json`);
}

/** The claude account state (.tumwater/state/claude-account.json; claude-account.ts): the
 * claude backend's subscription account — accountPath for the "claude" backend. */
export function claudeAccountPath(root: string): string {
  return accountPath(root, "claude");
}

/** The codex write guard's trust cache (.tumwater/state/codex-hook-trust.json;
 * codex-hook-trust.ts): the `{key, hash}` codex itself reports through `hooks/list`, keyed by
 * codex version and hook definition so the lookup runs once per build and Codex version, not
 * once per run. Runtime state under .tumwater/state/, never committed. */
export function codexHookTrustPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "codex-hook-trust.json");
}

/** The worktree-use registry (plans/disk-floor.md, part 2/4; git/worktree-use.ts): which
 * worktrees are in use and when each was last used, so pressure reclaim can order candidates
 * least-recently-used first across restarts. Runtime state under .tumwater/state/. */
export function worktreeUsePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "worktree-use.json");
}

/** The cross-process lock serializing read-modify-write updates of worktree-use.json: the
 * orchestrator records a use release while a separate `tumwater reclaim` CLI process seeds or
 * stamps the same registry, and an unguarded whole-file write would drop one side's change.
 * Same mkdir-and-pid mutex as configLockPath. */
export function worktreeUseLockPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "worktree-use.lock");
}

/** The orchestrator's own info file (its pid, for liveness checks —
 * team/orchestrator-info.ts). */
export function orchestratorStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "orchestrator.json");
}

/** The doctor's image-probe verdict cache (src/doctor/image-probe.ts): how each claimed
 * image-input model actually answered a live probe, keyed agent/provider/model. Runtime state
 * under .tumwater/state/, never committed. */
export function imageProbesPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "image-probes.json");
}

/** The images column `tumwater doctor` last read from `pi --list-models`, keyed provider/model.
 * Runtime state under .tumwater/state/, never committed. */
export function piListedModelsPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "pi-listed-models.json");
}

/** The `qa` flow-coverage ledger (run/qa-coverage.ts): which flow each observer run exercised
 * and how it went. Runtime state under .tumwater/state/, never committed — a passing check
 * must leave the repo untouched, or every cheap pass would move main and wake the team. */
export function qaCoveragePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "qa-coverage.json");
}

/** The `ci` observer's CI-parity ledger (run/ci-parity.ts): which main tip and lock hash each
 * run covered and how it went. Runtime state under .tumwater/state/, never committed — a
 * passing check must leave the repo untouched, or every cheap pass would move main and wake
 * the team.*/
export function ciParityPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "ci-parity.json");
}

/** The `feedback` observer's per-install filing ledger (run/feedback-filings.ts): which GitHub
 * issues this install already filed on znation/tumwater, so the next fresh session's prompt can
 * render a "previously filed" block without re-deriving its dedupe from the network alone.
 * Runtime state under .tumwater/state/, never committed — a filing must leave the repo untouched
 * (the role's only write is `gh`), and the worktree resets to main each run. */
export function feedbackFilingsPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "feedback-filings.json");
}

/** A role's notes (.tumwater/state/notes/<role>.md): the bounded note the role's own earlier
 * runs wrote, carried into the next fresh session. Runtime state under .tumwater/state/, never
 * committed — the worktree resets to main each run, so a committed note would move main. The
 * director has none: its work is the operator's prompt, not a recurring search. */
export function roleNotesPath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "state", "notes", `${role}.md`);
}

/** The in-flight merge marker (merge queue 4/5): the orchestrator's drain task
 * writes it (merge-slot.ts, merge queue 4/5) and removes it after every outcome — the observers
 * (`status`, TUI, GUI) are separate processes that cannot see the drain's in-memory promise,
 * but they can read this file (plans/merge-queue.md). */
export function mergeStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "merging.json");
}

/** The reverted changes still waiting for a free runner (.tumwater/state/reverted.json;
 * src/merge/merge-drain.ts): `{ reverted: [{ commit, role, reasons }] }`, each entry dropped once
 * assigned. */
export function revertedPendingPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "reverted.json");
}

/** Post-merge rejections handed forward (a revert was skipped or failed, so the commit is still
 * on main) still waiting for a free runner (.tumwater/state/forwarded.json; src/merge/
 * merge-drain.ts): `{ forwarded: [{ commit, role, reasons }] }`, each entry dropped once assigned.
 * Kept apart from reverted.json so the two hand-back paths cannot read each other's entries. */
export function forwardedPendingPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "forwarded.json");
}

/** Merged commits awaiting their review after merging (src/review/post-merge-review.ts), for roles
 * listed in `review.afterMerge`: `{ pending: PostReview[] }`. Runtime state, never committed. */
export function postReviewPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "post-review.json");
}

/** The detached checkout a post-merge review reads the merged commit in; the leading underscore
 * keeps it from colliding with a role worktree. */
export function postReviewWorktreePath(root: string): string {
  return path.join(worktreesDir(root), "_post-review");
}

/** The merge marker's old file, deleted by the startup migration (the marker is display-only,
 * so a previous generation's is stale and is not read). */
export function legacyLandingStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "landing.json"); // vocabulary-ok: legacy path read from old layouts
}

/** The last completed auto-restart's timestamp (epoch ms) — unlike orchestrator.json it must
 * survive the process exit that IS the restart, so it lives in its own file and is never removed
 * on exit (redeploy.ts; BUGS.md 2026-09-11). */
export function autoRestartStampPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "auto-restart.json");
}

/** The green main-baseline verdicts the team keeps across restarts (baseline/main-baseline.ts's
 * persistBaselineVerdicts): SHAs whose suite passed, so a new generation does not re-verify
 * them. */
export function baselineVerdictsPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "baseline-verdicts.json");
}

/** The quarantined flaky tests (review/known-flakes.ts): tests that failed and then passed on the
 * same tree, newest 100, each with the BUGS.md entry filed for it. */
export function quarantinePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "quarantine.json");
}

/** Marker file `tumwater reset-counters` drops for a running team to consume (it must also
 * zero the runners' in-memory counters, or their next save resurrects the old values). */
export function resetRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "reset-counters.json");
}

/** Marker file `tumwater wake [--role <id>]` drops for a running team to consume: like the
 * reset-counters marker it must name its targets because it can affect many roles, and like it
 * it must reach the runners' IN-MEMORY schedule — the poll loop reads eligibility from the
 * in-memory state, so clearing only the on-disk file would not wake anything. */
export function wakeRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "wake.json");
}

/** Directory of scheduled wakes (`tumwater wake --in`): each file in it is one wake
 * (`{ at, roles, notBeforeMs }`). A file per request is what keeps a later wake request from
 * overwriting a pending one, as the single `wake.json` marker did. */
export function scheduledWakeDir(root: string): string {
  return path.join(tumwaterDir(root), "wakes");
}

/** Marker file the dashboard's restart button (the build-stale alert's refresh icon) drops for
 * a running team to consume: force the pending self-redeploy past its cooldown now. Presence
 * is the request; the content is just `{ at }` — like the abort markers, one untyped flag. */
export function restartRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "restart.json");
}

/** Marker file `tumwater reclaim` drops for a running team to consume: presence means "run
 * one manual reclaim pass over every candidate." Like the restart marker, presence is the
 * request and the content is just `{ at }` — one untyped flag. A team that is not running
 * cannot consume it, so `cmdReclaim` runs the pass in-process instead. */
export function reclaimRequestPath(root: string): string {
  return path.join(tumwaterDir(root), "reclaim.json");
}

/** Per-role marker file `tumwater abort --role <id>` drops for a running team to consume:
 * kill that role's in-flight run. One file per role (presence = pending request; content is
 * just `{ at }`) keeps consumption race-free and needs no parsing — unlike the single shared
 * reset-counters marker, which must name its targets because it affects many roles. */
export function abortRequestPath(root: string, role: string): string {
  return path.join(tumwaterDir(root), `abort-${role}.json`);
}

/** Persistent operator-intent marker for `tumwater pause`: its presence means "the team is
 * paused" until `resume` removes it — unlike the abort/reset markers above, which are one-shot
 * requests consumed on pickup. Content is `{ at }` (the pause timestamp), read for display
 * only, never required. */
export function pausedPath(root: string): string {
  return path.join(tumwaterDir(root), "paused.json");
}

/** Operator-intent marker for `tumwater stop --in <duration>`: `{ at, until }` in epoch ms. The
 * running team's watch consumes it when `until` passes; a fresh `tumwater start` clears a
 * stale one. */
export function scheduledStopPath(root: string): string {
  return path.join(tumwaterDir(root), "stop-at.json");
}

/** Persistent operator-intent marker for `tumwater pause --role <id>` / `resume --role <id>`:
 * the set of individually paused roles, `{ roles: string[], at: number }` — the same
 * presence-means-paused persistence as the team marker above, so pausing a role before
 * startup starts it paused. Under state/ beside the orchestrator info file: unlike the
 * team marker it is structured state several writers rewrite (the orchestrator never does,
 * but the shape is atomic-json state, not a presence flag). */
export function pausedRolesPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "paused-roles.json");
}

/** The cross-process lock serializing read-modify-write updates of the paused-roles marker
 * (pauseRole/resumeRole in team/team-state.ts): the CLI and the GUI server are separate processes
 * that can toggle different roles in the same instant, and without serialization the last
 * writer's whole-set overwrite silently drops the other's pause. A lock directory owned by the
 * shared mkdir-and-pid mutex (withSyncLock, src/concurrency/lock.ts), which creates and removes it;
 * lives beside the marker path it guards, same single-definition rule. */
export function pausedRolesLockPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "paused-roles.lock");
}

/** The event log's basename — the filename paths.ts builds the log's path from and the
 * report headers name as their source, so a renamed log cannot leave either half behind. */
export const EVENTS_LOG_BASENAME = "events.jsonl";

/** The append-only harness event log (events.ts); the CLI, TUI, and status payload read it. */
export function eventsLogPath(root: string): string {
  return path.join(tumwaterDir(root), "log", EVENTS_LOG_BASENAME);
}

/** An archived generation of the event log (src/files/files.ts rotateIfLarge renames the grown
 * log to events.jsonl.1 and shifts older generations down, up to EVENTS_KEEP of them); the
 * windowed readers continue into them when the live log ends inside the window (event-window.ts).
 * `generation` defaults to 1, the newest archive. The path lives beside eventsLogPath so the
 * pair cannot drift apart. */
export function eventsArchivePath(root: string, generation = 1): string {
  return eventsLogPath(root) + "." + generation;
}

/** A role's raw pi transcript log (.tumwater/log/<role>.pi.jsonl); tailed by the GUI/TUI. */
export function piLogPath(root: string, role: string): string {
  return path.join(tumwaterDir(root), "log", `${role}.pi.jsonl`);
}

/** A role's backend-native stdout log (.tumwater/log/<role>.<backend>.native.jsonl), written
 * beside the canonical raw log and kept for debugging only: no reader folds it, and the backend
 * is in the name because one role's runs may switch backends and the two dialects must not
 * mix. Written and rotated like the raw log (src/agent/run-agent.ts). */
export function nativeLogPath(root: string, role: string, backend: string): string {
  return path.join(tumwaterDir(root), "log", `${role}.${backend}.native.jsonl`);
}

/** Root of the full-output files the bundled pi extension writes for oversized tool
 * results (.tumwater/log/tool-output/<toolCallId>.log). Pruned by the same sessionRetentionDays
 * window as sessions (orchestrator.ts's two retention passes): a pointer to a tool result is
 * only useful while its run is recent, and the files otherwise accumulate without bound. */
export function toolOutputDir(root: string): string {
  return path.join(tumwaterDir(root), "log", "tool-output");
}

/** Root of all pi session dirs under .tumwater/sessions/. */
export function sessionsRootDir(root: string): string {
  return path.join(tumwaterDir(root), "sessions");
}

/** A role's own pi session dir; hasResumableSession looks here for an interrupted run to
 * resume. */
export function sessionDir(root: string, role: string): string {
  return path.join(sessionsRootDir(root), role);
}

/** `sessionDir`'s real team root — the nearest ancestor holding a `.tumwater` directory — or
 * undefined when none does. run-agent installs the notes shim from THIS (never from teamRootOf,
 * whose no-ancestor fallback can be a shared directory): writing `.tumwater` at the fallback
 * would mint a phantom harness root every other suite on the host then found — BUGS.md
 * 2026-10-18's `$TMPDIR/.tumwater/bin/tumwater-notes`. */
export function nearestTumwaterRoot(sessionDir: string): string | undefined {
  let dir = sessionDir;
  for (let i = 0; i < 64; i += 1) {
    if (isDirectory(path.join(dir, ".tumwater"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The team root of the workspace `dir` sits in — `dir` lies under `worktreesDir(root)` for the
 * nearest `.tumwater` root — or undefined for a team root itself, a directory elsewhere under
 * it, or a directory with no root above. A read-only lookup for messages, never used to decide
 * where to write (same caution as teamRootOf). */
export function owningTeamRoot(dir: string): string | undefined {
  const root = nearestTumwaterRoot(dir);
  if (root === undefined) return undefined;
  const rel = path.relative(worktreesDir(root), dir);
  return rel !== "" && !path.isAbsolute(rel) && !rel.startsWith("..") ? root : undefined;
}

/** The team root that owns `sessionDir`: the `.tumwater` directory that contains it. A run's
 * session dir is always `<root>/.tumwater/sessions/…`, so the first ancestor holding a
 * `.tumwater` directory is the root; opencodeDbPath reads back to that same `.tumwater` for
 * the run's shared database. The no-ancestor fallback — a directory two levels up — is
 * unreachable in a harness run and used only by OpenCode's harness-only read-back lookups
 * (opencodeDbPath, loadConfigSafe), which always see a real root. Never use this to decide
 * where to WRITE a `.tumwater`: the fallback can be a shared directory, and creating `.tumwater`
 * there mints a phantom root (BUGS.md 2026-10-18); run-agent's shim install uses
 * nearestTumwaterRoot instead. Moved here from the opencode adapter (plans/notes-command.md) so
 * run-agent's shim install — which every backend's run needs — shares the one lookup instead of
 * the opencode adapter keeping it private. */
export function teamRootOf(sessionDir: string): string {
  return nearestTumwaterRoot(sessionDir) ?? path.dirname(path.dirname(sessionDir));
}

/** The directory the notes shim lands in, under a team root: `<root>/.tumwater/bin`.
 * run-agent installs the `tumwater-notes` command there (src/agent/notes-shim.ts) and
 * run-marker's backendBaseEnv prepends it to every run's PATH, so a run on any backend finds
 * the command (plans/notes-command.md "Reaching it from a run"). */
export function notesShimDir(root: string): string {
  return path.join(tumwaterDir(root), "bin");
}

/** The shared OpenCode session database for a team root (plans/opencode-backend.md §4): one
 * file per root, under the same `.tumwater` the run's session dir lives in, so the 6.5 MB
 * models catalog is downloaded once and six concurrent runs on one file work. The opencode
 * adapter derives `root` from a run's session dir (the `.tumwater` that contains it) and
 * points `OPENCODE_DB` here. */
export function opencodeDbPath(root: string): string {
  return path.join(tumwaterDir(root), "opencode", "opencode.db");
}

/** tumwater's cached models.dev catalog for OpenCode (plans/opencode-backend.md §7; part
 * 6a/7 opencode-catalog.ts): the providers the config routes through OpenCode, priced from
 * models.dev's `api.json` at most once a day. Runtime state under .tumwater/state/, never
 * committed. */
export function opencodeModelsPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "opencode-models.json");
}

/** Session dir for a role's review-gate runs. Kept OUTSIDE the role's own session dir on
 * purpose: hasResumableSession (the resume-after-shutdown guard) must only ever see the
 * AUTHOR's sessions — a leftover reviewer session would make an interrupted run "resume"
 * into a review context it never had. Old files are cleaned by the same age-based prune.
 */
export function reviewSessionDir(root: string, role: string): string {
  return path.join(sessionsRootDir(root), "_review", role);
}

/** The per-run child of a role's review session dir: one directory per review of one change,
 * keyed by the review run's number and pinned sha, so a follow-up turn — or a later attempt that
 * resumes this review — continues exactly that run's session rather than whichever review
 * wrote last into the shared parent. */
export function reviewRunSessionDir(root: string, role: string, runKey: string): string {
  return path.join(reviewSessionDir(root, role), runKey);
}

/** Queued human prompts awaiting pickup by a role (inbox.ts). */
export function inboxDir(root: string): string {
  return path.join(tumwaterDir(root), "inbox");
}

/** The queue directory one role's prompts wait in (inbox.ts): the director keeps its historical
 * queue at the inbox root so existing inboxes stay readable, and every other role gets a
 * per-role subdirectory — `tumwater prompt --role <id>` writes where only that role reads. */
export function roleInboxDir(root: string, role: string): string {
  return role === DIRECTOR_ROLE ? inboxDir(root) : path.join(inboxDir(root), role);
}

/** The durable merge queue (src/merge/merge-queue.ts): a changed run's pinned commit waits here
 * as one JSON file for the orchestrator's merge pipeline (plans/merge-queue.md 3/5, land-queue
 * speed 2c). Like the inbox it is a directory of timestamped files —
 * a crash between enqueue and drop loses nothing, and `tumwater status` can read it without the
 * scheduler. */
export function mergeQueueDir(root: string): string {
  return path.join(tumwaterDir(root), "merge-queue");
}

/** The merge queue's old directory, still read by observers until the startup migration
 * (src/orchestrator/startup-migration-steps.ts) moves its files into `mergeQueueDir`. */
export function legacyLandQueueDir(root: string): string {
  return path.join(tumwaterDir(root), "land-queue"); // vocabulary-ok: legacy path read from old layouts
}

/** How long a merge-lock taker outside the merge queue waits for the lock: a merge holds it through
 * its in-lock check, which can run several minutes. A dead holder is still broken early by
 * `tryBreakStale`. */
export const MERGE_LOCK_WAIT_MS = 15 * 60_000;

/** The lock dir serializing merges to main (merge-to-main.ts; doctor checks it). */
export function mergeLockDir(root: string): string {
  return path.join(tumwaterDir(root), "merge.lock");
}

/** Detached worktree pinned at main's head for the self-redeploy path (redeploy.ts): the green
 * check and the compile both read exactly the tree main names, never the primary checkout. Named
 * with a leading underscore like the reviewer session dir so it can never collide with a role. */
export function mirrorWorktreePath(root: string): string {
  return path.join(worktreesDir(root), "_main");
}

/** Detached worktree pinned at main's head for the review gate's attribution check
 * (main-red.ts's mainTipVerdict): asked whether main itself is green when a change's check
 * failed twice. Its own checkout, not the redeploy mirror above: the redeployer compiles in
 * the mirror at the head it verified, and a gate re-pointing that checkout at a newer main
 * mid-compile would stamp the wrong tree. */
export function gateMainWorktreePath(root: string): string {
  return path.join(worktreesDir(root), "_gate-main");
}

/** Detached worktree pinned at the RUNNING build's own SHA for the redeployer's urgency
 * carve-out (redeploy.ts's buildRed): the baseline check that decides whether the build the
 * team is executing is red runs here — its own checkout, not the redeploy mirror above, so a
 * witness check at an old SHA can never repoint the mirror a green check or compile is using.
 * The leading underscore follows the _main convention, so it can never collide with a role. */
export function witnessWorktreePath(root: string): string {
  return path.join(worktreesDir(root), "_build");
}

/** One slot of the worktree pool (plans/worktree-pool.md): a fixed `.tumwater/worktrees/_slot-<n>`
 * checkout that runs and verifies lease and switch commits in place, instead of one `_land-<role>`
 * per role. The leading underscore keeps it from colliding with a role worktree. */
export function slotWorktreePath(root: string, n: number): string {
  return path.join(worktreesDir(root), `_slot-${n}`);
}

/** The worktree pool's dedicated checkout for the merge drain's merge-side work
 * (plans/worktree-pool.md, "Layout"): a single change, a stack and its bisect, the conflict
 * resolver and the post-resolve re-review. Kept out of the pool so a permit-waiting lease can
 * never deadlock behind the merge lock, and the leading underscore keeps it from colliding with
 * a role worktree. */
export function mergeWorktreePath(root: string): string {
  return path.join(worktreesDir(root), "_merge");
}

/** The worktree pool's persisted layout (git/slots-state.ts): which slots exist, who leases each
 * one, and which role each is pinned for. Runtime state under .tumwater/state/, never committed —
 * the orchestrator, `tumwater diff`, `retire` and the dashboards all read it. */
export function slotsStatePath(root: string): string {
  return path.join(tumwaterDir(root), "state", "slots.json");
}

/** The cross-process lock serializing read-modify-write updates of slots.json: the orchestrator
 * leases slots while `retire` (a separate CLI process) clears a pin, and an unguarded last-writer
 * overwrite would drop one side's change. Same mkdir-and-pid mutex as pausedRolesLockPath. */
export function slotsLockPath(root: string): string {
  return path.join(tumwaterDir(root), "state", "slots.lock");
}

/** The ref pinning a role's committed-but-not yet merged sha (plans/merge-queue.md invariant 4):
 * written right after the run's commit, before its branch resets to main, so the reset cannot
 * orphan the work. Deleted on every terminal merge outcome; kept until re-merged otherwise. */
export function mergeRefName(role: string): string {
  return `refs/tumwater/merge/${role}`;
}

/** The pre-rename pin name (`refs/tumwater/landing/<role>`): the startup step moves these to
 * mergeRefName, and retire still reads and deletes it for a team stopped before its first
 * start on this build. */
export function legacyLandingRefName(role: string): string {
  return `refs/tumwater/landing/${role}`; // vocabulary-ok: legacy name read from old refs or commits
}

/** The ref naming a role's rejected change while a revision is due (plans/revise-rejected.md):
 * written at the gate's rejection, read by the author's next run to re-apply the rejected diff,
 * and deleted once the revision merges, is dropped, conflicts, or exhausts its rounds. Keeping
 * the head reachable here stops git gc from collecting the one commit the revision re-applies. */
export function rejectedRefName(role: string): string {
  return `refs/tumwater/rejected/${role}`;
}

/** The ref holding a post-merge reviewer's repair while it lands (Forward never back 1a/6):
 * set to the reviewed commit C at review start, advanced to the ONE `tumwater(reviewer): Fix …`
 * commit the reviewer's worktree edit makes, and merged through the ordinary change path before
 * the entry settles `fixed`. Living under refs/tumwater/ means the startup pin housekeeping
 * (dropDanglingTumwaterPins) sees it; it is deleted once the merge settles. */
export function reviewFixRef(sha: string): string {
  return `refs/tumwater/review-fix/${shortSha(sha)}`;
}

/** Where redeploy stages compiled builds before swapping one into dist/ — under .tumwater/ so a
 * build in progress never dirties the primary checkout (dist/ is gitignored, a sibling would
 * not be). */
export function stagingRootDir(root: string): string {
  return path.join(tumwaterDir(root), "build");
}

/** One head's staged build (see stagingRootDir). */
export function stagingDir(root: string, sha: string): string {
  return path.join(stagingRootDir(root), sha);
}

/** The bootstrap gate's completion latch (plans/work-ratio.md, part 2/2): once
 * `bootstrap.untilPlansDone` plans have reached PLANS.md's `## Done`, the gate writes this
 * file so a later steward compression of that section cannot re-enter bootstrap. Its presence
 * ends bootstrap for good, whatever the Done count becomes. */
export function bootstrapLatchPath(root: string): string {
  return path.join(tumwaterDir(root), "bootstrap-complete.json");
}
