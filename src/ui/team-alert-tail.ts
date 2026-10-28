/** The tail team alerts: a stopped tumwater. One of the per-domain builders split out of
 * src/ui/team-alerts.ts; the shared types and wording helpers live in team-alert-shared.ts. */

import type { TeamAlert } from "./team-alert-shared.js";
import type { StatusSnapshot } from "../status/status-data.js";
import type { OrphanAlert } from "./status-payload.js";
import { plural } from "../text/phrases.js";

interface TailAlertsInput {
  snap: Pick<StatusSnapshot, "running">;
  orphans: OrphanAlert | null;
}

function pushStoppedAlert(out: TeamAlert[], snap: TailAlertsInput["snap"]): void {
  if (!snap.running) {
    out.push({
      key: "stopped",
      tone: "gray",
      title: "tumwater is not running — start it with `tumwater start`",
      detail: "Start it with tumwater start in the project directory; the dashboards pick it up on their own.",
      actions: [{ label: "Copy the command", act: "copy", arg: "tumwater start" }],
    });
  }
}

function pushOrphansAlert(out: TeamAlert[], orphans: OrphanAlert | null): void {
  // Orphaned worktree processes — the always-on twin of the doctor's `orphans` row
  // (doctor-orphans.ts checkOrphans): a detected orphan holds no lock, writes no event and
  // touches no state file, so nothing else on the always-on surfaces names it until an operator
  // runs `tumwater doctor`, and it then burns CPU for days unnoticed. alert-feeds.ts's
  // getOrphanAlert feeds it the doctor's own orphanFailDetail sentence and count, so the alert
  // and the row cannot drift on the trigger, the cpu, or the remediation.
  if (orphans) {
    out.push({
      key: "orphans",
      tone: "amber",
      title: `${plural(orphans.count, "orphaned process", "orphaned processes")} are burning CPU (PPID 1)`,
      detail: orphans.detail,
      actions: [],
    });
  }
}

/** The stopped-tumwater alert, in emission order: a stopped team. Extracted from teamAlerts
 * (part 5/5 of the teamAlerts split) so the shared module stays small; the input names exactly
 * the fields this run reads. The caller pushes the returned alerts at the position this run
 * used to occupy, so the emitted key order is unchanged. */
export function buildTailAlerts(input: TailAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const { snap, orphans } = input;
  pushOrphansAlert(out, orphans);
  pushStoppedAlert(out, snap);
  return out;
}
