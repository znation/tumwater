import { findOrphans, orphanFailDetail, type OrphanScan } from "../doctor/doctor-orphans.js";
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
  detail: string;
}

/** The orphan scan's alert shape, given a scan it is handed — the pure feed, so a test stages a
 * fake probe's scan and gets exactly the row's message without a real host (the shared
 * findOrphans/orphanFailDetail the doctor row reads, so the two cannot drift). `root` trims this
 * repo's path from the commands, like the doctor row. */
export function orphanAlertFromScan(scan: OrphanScan, root = ""): OrphanAlert | null {
  if ("error" in scan || scan.orphans.length === 0) return null;
  const detail = orphanFailDetail(root, scan);
  return detail === null ? null : { count: scan.orphans.length, detail };
}

/** Run the doctor's orphan scan and shape it into the standing alert. Async (it does the real
 * process-table read); the always-on surfaces read it through getOrphanAlert's cache below, so
 * a status frame never blocks on the host scan. */
export async function refreshOrphanAlert(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<OrphanAlert | null> {
  return orphanAlertFromScan(await findOrphans(root, probe), root);
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
        try {
          orphanCache = { value: await refreshOrphanAlert(root, probe), at: Date.now() };
        } catch {
          orphanCache = { value: null, at: Date.now() };
        } finally {
          orphanLoading = false;
        }
      })();
    }
  }
  return orphanCache === null ? null : orphanCache.value;
}
