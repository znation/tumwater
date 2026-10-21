/** Session retention (the `sessionRetentionDays` setting): the once-per-day gate and the prune
 * itself, split out of orchestrator.ts — the poll-loop runtime carried both a startup prune and
 * a near-identical in-poll prune plus the last-applied-window bookkeeping, and scheduling.ts
 * held the due-gate despite being about run policy, not file retention. Dependency direction:
 * orchestrator → retention; this module owns the whole "which files age out, and when" concern
 * and the orchestrator only hands it the (possibly live-reloaded) window. */

import { logEventBestEffort, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { DAY_MS } from "../text/datetime.js";
import { ensureParentDir, pruneOldFiles } from "../files/files.js";
import { pruneSessionLedgers, pruneOpencodeSessions } from "../agent/session-ledger.js";
import { loadConfigSafe } from "../config/config.js";
import { opencodeBackend, opencodeSpillDir } from "../agent/opencode/opencode-backend.js";
import { opencodeDbPath, sessionsRootDir, toolOutputDir } from "../paths.js";

/** Is a once-per-day session prune due? Due when retention is enabled (> 0) and a full day
 * has passed since the last prune (or no prune has run yet). */
export function dueForPrune(lastPruneAt: number | null, now: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false; // 0 disables pruning — never due.
  if (lastPruneAt === null) return true; // Never pruned yet — due immediately.
  return now - lastPruneAt >= DAY_MS;
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
      // are visible in logs/TUI/GUI even when nothing was pruned; pruning itself still runs
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

  private prune(root: string, days: number): void {
    const sessions = sessionsRootDir(root);
    // OpenCode's sessions live outside .tumwater (design §4, finding 17): resolve its binary
    // and OPENCODE_DB exactly as a run's invocation would, and purge its expired sessions and
    // spill files from the ledger BEFORE the file pass below ages it out — an idle role's
    // whole ledger file is deleted once its mtime passes the window, so only reading it first
    // hands every expired OpenCode session id to `opencode session delete`. Each half warns its
    // own unit.
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
    const deleted = pruneOpencodeSessions(sessions, days, {
      bin,
      env: { ...process.env, OPENCODE_DB: dbPath },
      spillDir: opencodeSpillDir(root),
    });
    if (deleted > 0)
      warnEventBestEffort(root, TUMWATER_SOURCE, `deleted ${deleted} expired opencode session(s)`);
    // Age out session/tool-output files now: an entirely stale dir is gone before the line
    // pass reads it. A running role's ledger mtime stays young, so pruneOldFiles never ages
    // that file out; each warning must name the unit it pruned.
    const pruned = pruneOldFiles(sessions, days) + pruneOldFiles(toolOutputDir(root), days);
    if (pruned > 0)
      warnEventBestEffort(root, TUMWATER_SOURCE, `pruned ${pruned} old agent session/tool-output file(s)`);
    const prunedLines = pruneSessionLedgers(sessions, days);
    if (prunedLines > 0)
      warnEventBestEffort(root, TUMWATER_SOURCE, `pruned ${prunedLines} stale session ledger line(s)`);
  }
}
