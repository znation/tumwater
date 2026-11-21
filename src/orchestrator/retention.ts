/** Session retention (the `sessionRetentionDays` setting): the once-per-day gate and the prune
 * itself, split out of orchestrator.ts — the poll-loop runtime carried both a startup prune and
 * a near-identical in-poll prune plus the last-applied-window bookkeeping, and scheduling.ts
 * held the due-gate despite being about run policy, not file retention. Dependency direction:
 * orchestrator → retention; this module owns the whole "which files age out, and when" concern
 * and the orchestrator only hands it the (possibly live-reloaded) window. */

import { logEventBestEffort, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { DAY_MS } from "../text/datetime.js";
import { plural } from "../text/phrases.js";
import { ensureParentDir, pruneOldFiles, removeQuiet } from "../files/files.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { clearPruneResume, pruneSessionLedgers, pruneOpencodeSessions, pruneCodexSessions } from "../agent/session-ledger.js";
import { loadConfigSafe } from "../config/config.js";
import { resolvedBackendConfig } from "../config/config-views.js";
import { opencodeBackend, opencodeSpillDir } from "../agent/opencode/opencode-backend.js";
import { codexBackend } from "../agent/codex/codex-backend.js";
import { codexHome } from "../agent/codex/codex-catalog.js";
import { maintenancePath, opencodeDbPath, salvageDir, sessionPruneResumePath, sessionsRootDir, toolOutputDir } from "../paths.js";

/** Is a once-per-day session prune due? Due when retention is enabled (> 0) and a full day
 * has passed since the last prune (or no prune has run yet). */
export function dueForPrune(lastPruneAt: number | null, now: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false; // 0 disables pruning — never due.
  if (lastPruneAt === null) return true; // Never pruned yet — due immediately.
  return now - lastPruneAt >= DAY_MS;
}

/** The one `task` value the progress marker carries today. Naming it here leaves room for the
 * other blocking housekeeping passes PLANS.md "Visible session cleanup" part 1/3 anticipates
 * without renaming the field. */
const MAINTENANCE_TASK = "session-prune";

/** How many handled ids may pass between two marker rewrites, and the wall-clock gap between
 * them — whichever comes first rewrites it, plus one rewrite for the final id. The bound is the
 * point: each rewrite is a synchronous atomic write inside the poll loop the pass is already
 * blocking, and the pass that motivated this (3,944 expired Codex sessions) would otherwise add
 * thousands of writes to its own 75 minutes. */
const MARKER_PROGRESS_IDS = 25;
const MARKER_PROGRESS_MS = 1000;

/** What `.tumwater/state/maintenance.json` (src/paths.ts's `maintenancePath`) says while one
 * blocking housekeeping pass runs: which process is blocking its poll loop, on which task and
 * backend, and how far it has got. `total` is known up front because the expired-id set is built
 * before the delete loop; `startedAt` is the whole pass, `updatedAt` this half's last rewrite.
 * Written by `SessionPruneMarker` below, and absent whenever no such pass is running. Exported
 * for the status snapshot's reader (status-data.ts), which reads it fresh each poll. */
export interface MaintenanceMarker {
  /** The orchestrator process that wrote the marker. */
  pid: number;
  task: "session-prune";
  backend: "codex" | "opencode" | "files";
  done: number;
  total: number;
  startedAt: number;
  updatedAt: number;
}

type MaintenanceBackend = MaintenanceMarker["backend"];

/** The marker's whole write policy for one prune pass: it opens the marker when the pass starts,
 * rewrites it under the throttle above as each backend's deletes come in, logs one
 * `maintenance_start`/`maintenance_done` pair per half that had work, and removes it when the
 * pass ends. Every write is best-effort: this runs inside the poll loop, where a throw ends the
 * team, so a full disk or an unwritable state dir costs the marker, never the prune. */
class SessionPruneMarker {
  private readonly file: string;
  private readonly startedAt = Date.now();
  private backend: MaintenanceBackend = "opencode";
  private done = 0;
  private total = 0;
  /** Whether this half has logged its `maintenance_start` (a half with no work logs nothing). */
  private started = false;
  private halfStartedAt = 0;
  private lastWriteAt = 0;
  private lastWriteDone = -1;

  constructor(private readonly root: string) {
    this.file = maintenancePath(root);
    this.write();
  }

  /** Begin one backend's half: reset the counters and write the marker so a reader sees which
   * half the blocked loop is in even before its first id is handled. */
  beginHalf(backend: MaintenanceBackend): void {
    this.backend = backend;
    this.done = 0;
    this.total = 0;
    this.started = false;
    this.halfStartedAt = Date.now();
    this.lastWriteAt = 0;
    this.lastWriteDone = -1;
    this.write();
  }

  /** The progress callback the session purges call — once with `done = 0` when they have work
   * and then after each id they handle (PLANS.md part 1/3: the purge functions stay free of
   * path knowledge and just report). */
  readonly onProgress = (done: number, total: number): void => {
    this.done = done;
    this.total = total;
    if (!this.started && total > 0) {
      this.started = true;
      logEventBestEffort(this.root, {
        source: TUMWATER_SOURCE,
        type: "maintenance_start",
        task: MAINTENANCE_TASK,
        backend: this.backend,
        total,
      });
    }
    if (
      done === total ||
      done - this.lastWriteDone >= MARKER_PROGRESS_IDS ||
      Date.now() - this.lastWriteAt >= MARKER_PROGRESS_MS
    ) {
      this.lastWriteAt = Date.now();
      this.lastWriteDone = done;
      this.write();
    }
  };

  /** End one half: its `maintenance_done`, when the half had work at all. */
  endHalf(): void {
    if (!this.started) return;
    logEventBestEffort(this.root, {
      source: TUMWATER_SOURCE,
      type: "maintenance_done",
      task: MAINTENANCE_TASK,
      backend: this.backend,
      done: this.done,
      durationMs: Date.now() - this.halfStartedAt,
    });
  }

  /** End the pass: the marker is removed whatever happened above, including a failed write or a
   * throw part-way through, so no reader is left believing a pass is still running. */
  finish(): void {
    removeQuiet(this.file);
  }

  private write(): void {
    try {
      writeJsonAtomic(this.file, {
        pid: process.pid,
        task: MAINTENANCE_TASK,
        backend: this.backend,
        done: this.done,
        total: this.total,
        startedAt: this.startedAt,
        updatedAt: Date.now(),
      } satisfies MaintenanceMarker);
    } catch {
      // Best effort: a marker this process cannot write must not fail the prune.
    }
  }
}

/** The retention state machine across one orchestrator's lifetime: which window was last
 * applied and when we last pruned. Constructed once at startup — construction runs the startup
 * prune — then stepped once per poll with the live config's window. In memory only: a restart
 * re-prunes at startup regardless. */
export class RetentionPruner {
  private lastRetention: number;
  private lastPruneAt: number | null;

  constructor(root: string, retentionDays: number) {
    this.lastRetention = retentionDays;
    this.lastPruneAt = retentionDays > 0 ? Date.now() : null;
    // 0 disables pruning — the same convention as quietTimeoutSeconds. (With a positive N,
    // pruneOldFiles deletes everything older than N days; JSON has no "keep forever" value, so
    // 0 is the off switch rather than "delete all sessions now".)
    if (retentionDays > 0) this.prune(root, retentionDays);
  }

  /** Apply a (possibly live-reloaded) retention window: a mid-run edit re-prunes immediately;
   * independently of edits, an unchanged team prunes at most once per day so a never-restarted
   * team still honors its window. Both paths log the startup warning shape only when files
   * were actually deleted — quiet polls stay silent. */
  poll(root: string, retentionDays: number): void {
    if (retentionDays !== this.lastRetention || dueForPrune(this.lastPruneAt, Date.now(), retentionDays)) {
      // A change to a positive window prunes immediately even inside the daily window — an
      // operator tightening the window wants it applied now, not at tomorrow's pass. Every
      // distinct value change logs one event (like its maxConcurrent sibling) so live edits
      // are visible in logs/GUI even when nothing was pruned; pruning itself still runs
      // only for a positive window.
      if (retentionDays !== this.lastRetention) {
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "retention_changed",
          from: this.lastRetention,
          to: retentionDays,
        });
      }
      if (retentionDays > 0) {
        this.lastPruneAt = Date.now();
        this.prune(root, retentionDays);
      }
      this.lastRetention = retentionDays;
    }
  }

  /** One prune pass, in its fixed pass order (INV-BQ3): both backend session purges read the
   * ledgers before the file pass can age them out, then the file, ledger-line and salvage
   * passes. The whole pass is wrapped in the progress marker (PLANS.md "Visible session
   * cleanup" part 1/3), which is removed in the `finally` even when a half throws. */
  private prune(root: string, days: number): void {
    const marker = new SessionPruneMarker(root);
    try {
      pruneOpencodeHalf(root, days, marker);
      pruneCodexHalf(root, days, marker);
      pruneFileHalves(root, days, marker);
    } finally {
      marker.finish();
    }
  }
}

/** OpenCode's sessions live outside .tumwater (design §4, finding 17): resolve its binary and
 * OPENCODE_DB exactly as a run's invocation would, and purge its expired sessions and spill
 * files from the ledger BEFORE the file pass ages it out — an idle role's whole ledger file is
 * deleted once its mtime passes the window, so only reading it first hands every expired
 * OpenCode session id to `opencode session delete`. Each half warns its own unit. */
function pruneOpencodeHalf(root: string, days: number, marker: SessionPruneMarker): void {
  marker.beginHalf("opencode");
  const { config } = loadConfigSafe(root);
  let bin = config !== undefined ? opencodeBackend.resolveBin(config).bin : undefined;
  const dbPath = opencodeDbPath(root);
  try {
    ensureParentDir(dbPath);
  } catch {
    // The directory cannot be created, so no OpenCode DB is there to delete from; this pass
    // runs in the poll loop, where a throw ends the team. Skip only the session deletes.
    bin = undefined;
  }
  const deleted = pruneOpencodeSessions(sessionsRootDir(root), days, {
    bin,
    env: { ...process.env, OPENCODE_DB: dbPath },
    spillDir: opencodeSpillDir(root),
    resumePath: sessionPruneResumePath(root, "opencode"),
    onProgress: marker.onProgress,
  });
  marker.endHalf();
  if (deleted > 0)
    warnEventBestEffort(root, TUMWATER_SOURCE, `deleted ${plural(deleted, "expired opencode session")}`);
}

/** Codex's sessions also live outside .tumwater — under the team's CODEX_HOME (part 8/9).
 * Resolve its binary and home exactly as a run's invocation would and purge its expired
 * sessions from the ledger BEFORE the file pass below ages it out. Like the OpenCode twin, an
 * unavailable config skips the deletes rather than guessing at a binary and home: a bare
 * `codex` under the operator's inherited CODEX_HOME could act on the wrong home (review
 * objection 2). CODEX_HOME is always set explicitly — to the resolved team home, or to
 * undefined when the config is absent — so the inherited CODEX_HOME never reaches the purge
 * (its rollout fallback would otherwise unlink the operator's own home). */
function pruneCodexHalf(root: string, days: number, marker: SessionPruneMarker): void {
  marker.beginHalf("codex");
  const { config } = loadConfigSafe(root);
  const codexBin = config !== undefined ? codexBackend.resolveBin(config).bin : undefined;
  const codexHomeDir = config !== undefined ? codexHome(resolvedBackendConfig(config, "codex")) : undefined;
  const deletedCodex = pruneCodexSessions(sessionsRootDir(root), days, {
    bin: codexBin,
    env: { ...process.env, CODEX_HOME: codexHomeDir },
    resumePath: sessionPruneResumePath(root, "codex"),
    onProgress: marker.onProgress,
  });
  marker.endHalf();
  if (deletedCodex > 0)
    warnEventBestEffort(root, TUMWATER_SOURCE, `deleted ${plural(deletedCodex, "expired codex session")}`);
}

/** The passes with no per-id CLI delete to report progress between: they age out session and
 * tool-output files, trim ledger lines, and age out salvaged slot leftovers — the marker names
 * this half `files`. Salvaged leftovers (src/git/slot-salvage.ts) age out on the same window as
 * the sessions that made them: a patch still waiting by then belongs to a role that has not run
 * since, and the operator had the window's length to take a kept one. */
function pruneFileHalves(root: string, days: number, marker: SessionPruneMarker): void {
  marker.beginHalf("files");
  const sessions = sessionsRootDir(root);
  // Age out session/tool-output files now: an entirely stale dir is gone before the line
  // pass reads it. A running role's ledger mtime stays young, so pruneOldFiles never ages
  // that file out; each warning must name the unit it pruned.
  const pruned = pruneOldFiles(sessions, days) + pruneOldFiles(toolOutputDir(root), days);
  if (pruned > 0)
    warnEventBestEffort(root, TUMWATER_SOURCE, `pruned ${plural(pruned, "old agent session/tool-output file")}`);
  const prunedLines = pruneSessionLedgers(sessions, days);
  if (prunedLines > 0)
    warnEventBestEffort(root, TUMWATER_SOURCE, `pruned ${plural(prunedLines, "stale session ledger line")}`);
  // The ledger lines the resume records cover are trimmed now, so the records have done their job.
  clearPruneResume(sessionPruneResumePath(root, "codex"));
  clearPruneResume(sessionPruneResumePath(root, "opencode"));
  const prunedPatches = pruneOldFiles(salvageDir(root), days);
  if (prunedPatches > 0)
    warnEventBestEffort(root, TUMWATER_SOURCE, `pruned ${plural(prunedPatches, "old salvaged workspace patch", "old salvaged workspace patches")}`);
  marker.endHalf();
}
