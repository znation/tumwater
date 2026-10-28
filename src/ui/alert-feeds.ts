import { openQuestionEntries, ageInDays } from "../backlog/backlog.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { questionFilingDate } from "../backlog/backlog-question-answer.js";
import { byDaysThenIndex } from "../collections.js";
import { STALE_QUESTION_DAYS } from "../doctor/doctor-backlog.js";
import { planDependencyProblem } from "../doctor/doctor-backlog-plans.js";
import { findOrphans, orphanFailDetail, type OrphanScan } from "../doctor/doctor-orphans.js";
import { type ProcessProbe, systemProcessProbe } from "../process/process-table.js";
import type { PlanDependencyProblem, StaleQuestion } from "./team-alerts.js";

/** This module is the alert-feed half of src/ui/status-payload.ts: each always-on team alert's
 * data-sourcing function lives here, a
 * sibling of the src/ui/team-alert-*.ts builders that turn them into banners. status-payload.ts
 * stays the one status-document builder, importing these feeds and folding each feed's result
 * into the `alerts` field; status-render.ts reads the feeds directly for the TUI. */
/** The open questions the doctor's 7-day rule (src/doctor/doctor-backlog-bugs.ts
 * checkStaleQuestions, STALE_QUESTION_DAYS) calls stale: an open QUESTIONS.md entry whose
 * `(asked by …)` stamp is at least 7 days old. This is the always-on feed for the stale-questions
 * team alert — the shared rule's twin on every observer surface, computed from the same threshold
 * and the same questionFilingDate parser the doctor's check uses, so the two cannot drift on which
 * questions are stale. An undated heading is skipped (like the doctor's check); questions carry no
 * refused note to filter. The returned objects carry the 1-based position (for
 * `tumwater questions answer <n>`), the 0-based index (kept only as the file-order tiebreak), the
 * stamp-stripped title, and the whole-day age. Returned oldest-first — most days waited, ties in
 * file order — so a caller naming the first element names the most-stale question. */
export function staleOpenQuestions(root: string, now = Date.now()): StaleQuestion[] {
  return openQuestionEntries(root)
    .flatMap((entry, index) => {
      const stamp = questionFilingDate(entry.title);
      if (stamp === null) return [];
      const days = ageInDays(stamp, now);
      return days >= STALE_QUESTION_DAYS ? [{ index, position: index + 1, title: stripEntryStamp(entry.title), days }] : [];
    })
    .sort(byDaysThenIndex);
}

/** A broken plan-dependency clause, the always-on twin of the doctor's `plan dependencies` row
 * (src/doctor/doctor-backlog-plans.ts checkPlanDependencies): the same rule's problem set,
 * severity order, and exact message, so the alert and the doctor cannot drift. The reader owns
 * the rule — planDependencyAlert passes the doctor's planDependencyProblem through unchanged,
 * like staleOpenQuestions and the other stale feeds do their doctor's rules. null when PLANS.md's
 * planned entries have no cycle, dangling ref, unparsed clause, or misworded dependency. */
export function planDependencyAlert(root: string): PlanDependencyProblem | null {
  return planDependencyProblem(root);
}

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
