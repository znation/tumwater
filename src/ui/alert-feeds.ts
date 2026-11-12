import { findOrphans, ORPHAN_REAP_INTERVAL_MS, orphanFailDetail, type OrphanScan } from "../doctor/doctor-orphans.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/team-orchestrator-info.js";
import { type ProcessProbe, systemProcessProbe } from "../process/process-table.js";

/** This module is the alert-feed half of src/ui/status-payload.ts: each always-on team alert's
 * data-sourcing function lives here, a
 * sibling of the src/ui/team-alert-*.ts builders that turn them into banners. status-payload.ts
 * stays the one status-document builder, importing these feeds and folding each feed's result
 * into the `alerts` field; status-render.ts reads the feeds directly for the TUI. The stale
 * questions, plan dependencies, stalled entries, stranded plans, duplicated headings, live
 * finished history, validation gaps and false fixes feeds moved to `tumwater doctor` rows
 * (Subtract part 1e/6), so the only feed left is the orphan alert. */

/** The standing orphan alert: how many orphaned processes the scan found, and the doctor row's
 * own sentence (orphanFailDetail) so the alert and the `orphans` row cannot drift on the count,
 * the per-orphan cpu, or the remediation. null when the scan found no orphans or could not read
 * the table. */
export interface OrphanAlert {
  count: number;
  pids: number[];
  firstSeenAt: number;
  detail: string;
}

/** The orphan scan's alert shape, given a scan it is handed — the pure feed, so a test stages a
 * fake probe's scan and gets exactly the row's message without a real host (the shared
 * findOrphans/orphanFailDetail the doctor row reads, so the two cannot drift). `root` trims this
 * repo's path from the commands, like the doctor row; `at` stamps the continuously-listed set's
 * firstSeenAt from the scan's own clock. */
export function orphanAlertFromScan(scan: OrphanScan, root = "", at = Date.now()): OrphanAlert | null {
  if ("error" in scan || scan.orphans.length === 0) return null;
  const detail = orphanFailDetail(root, scan);
  return detail === null
    ? null
    : { count: scan.orphans.length, pids: scan.orphans.map((r) => r.pid).sort((a, b) => a - b), firstSeenAt: at, detail };
}

/** Run the doctor's orphan scan and shape it into the standing alert. Async (it does the real
 * process-table read); the always-on surfaces read it through getOrphanAlert's cache below, so
 * a status frame never blocks on the host scan. */
export async function refreshOrphanAlert(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<OrphanAlert | null> {
  return orphanAlertFromScan(await findOrphans(root, probe), root, Date.now());
}

/** How stale a cached orphan scan may be before the next status read starts a fresh one:
 * orphan leaks grow over days, so a sixty-second refresh is plenty and keeps the host scan
 * (one `ps`, plus cwd reads only for the parentless candidates argv did not settle) off the
 * hot render path. */
const ORPHAN_ALERT_REFRESH_MS = 60_000;

let orphanCache: { value: OrphanAlert | null; at: number } | null = null;
let orphanLoading = false;

/** The synchronous orphan feed the always-on surfaces (status-payload, status-render, the TUI)
 * read each frame: the last scan's value while it is fresher than ORPHAN_ALERT_REFRESH_MS, else a
 * background refresh is kicked (one at a time) and the previous value — null on the first ever
 * read — is returned until that scan lands. The refresh runs off the render path, so a slow host
 * scan never stalls a status frame. Per-process: each long-lived surface (the GUI server, the
 * TUI) and the CLI each run their own throttled scan against the same doctor rule. */
export function getOrphanAlert(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
  now = Date.now(),
): OrphanAlert | null {
  if (orphanCache === null || now - orphanCache.at >= ORPHAN_ALERT_REFRESH_MS) {
    if (!orphanLoading) {
      orphanLoading = true;
      void (async () => {
        let value: OrphanAlert | null;
        try {
          value = await refreshOrphanAlert(root, probe);
        } catch {
          value = null;
        }
        // The continuation rule: a leak keeps its age while it keeps being listed. A fresh
        // scan that still lists at least one pid the previous scan listed is the same leak
        // (the sweep has not cleared it) and inherits the previous scan's firstSeenAt; a
        // scan of wholly new pids, or a scan with no orphans (null), starts at its own time.
        const prev = orphanCache === null ? null : orphanCache.value;
        if (value !== null && prev !== null && value.pids.some((pid) => prev.pids.includes(pid))) {
          value = { ...value, firstSeenAt: prev.firstSeenAt };
        }
        orphanCache = { value, at: Date.now() };
        orphanLoading = false;
      })();
    }
  }
  return orphanCache === null ? null : orphanCache.value;
}

/** How long a running team's sweep may keep a listed orphan before the standing alert shows:
 * two full reap intervals. A reap is due at most ORPHAN_REAP_INTERVAL_MS after its last stamp
 * and kills only orphans at least ORPHAN_REAP_MIN_AGE_MS old, so an orphan a running team's
 * sweep keeps listed for more than two intervals means the reaper is stuck, not merely
 * mid-cycle — two intervals is the worst case for a just-leaked process (leak → miss one
 * reap at under the age gate → the next reap kills). */
export const ORPHAN_ALERT_MAX_AGE_MS = 2 * ORPHAN_REAP_INTERVAL_MS;

/** Whether the standing orphans alert shows right now (PLANS.md 2026-11-11): the team's own
 * sweep reaps each listed orphan while the team runs, so the alert asks the user for nothing
 * then. It shows only where no sweep reaches — the team is stopped (the info file's pid is
 * gone, or no info file was ever written), or a running team has kept the same orphans listed
 * for two full sweeps (ORPHAN_ALERT_MAX_AGE_MS) without clearing them, so the reaper itself
 * is stuck and the operator's own kill is the answer. A dead-pid info file reads as a stopped
 * team, and a missing info file (no team ever ran here) shows the alert too: nothing polls
 * on either host. */
export function orphanAlertVisible(root: string, alert: OrphanAlert | null, now = Date.now()): OrphanAlert | null {
  if (alert === null) return null;
  if (!orchestratorAlive(root, readOrchestratorInfo(root))) return alert;
  return now - alert.firstSeenAt >= ORPHAN_ALERT_MAX_AGE_MS ? alert : null;
}

/** Test seam: reset the module-level orphan cache to a given value (or null). Each test runs
 * in its own process so there is no cross-process bleed, but tests that stage getOrphanAlert's
 * cache directly call this between stages so an earlier test's value never bleeds into the
 * next one's (PLANS.md 2026-11-11). */
export function resetOrphanAlertForTest(value: OrphanAlert | null = null, at = 0): void {
  orphanCache = { value, at };
  orphanLoading = false;
}
