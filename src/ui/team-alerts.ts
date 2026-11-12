/** The team ALERT model: everything about the team that needs the operator — or that they
 * should know — phrased once for both observer surfaces: the dashboard's alert banners
 * (shipped in the status payload as `alerts`) and the TUI's attention lines
 * (tui-frame.ts alertLines). Split from status-model.ts, whose per-role derivation this reads
 * as input; `tone` ranks an
 * alert (red and amber ask for action, indigo asks a question, blue and gray inform), and
 * `actions` are the dashboard's buttons (`act` names a page action — open a role, a view,
 * the cap editor…).
 *
 * This module is the composition root: it imports the three per-domain builder modules
 * (team-alert-status, team-alert-backlog,
 * team-alert-tail) and runs them in emission order, and it re-exports the shared alert types
 * (defined in team-alert-shared.ts) so consumers keep importing them from this one path. The
 * orphans alert the tail builder shows is the GATED value (alert-feeds.ts's
 * orphanAlertVisible): it appears only for leaks the team's own sweep has not cleared — a
 * stopped team, or a listed set the sweep has kept past two full sweeps — never for a leak a
 * running team is on the case for, whose own poll sweep reaps it. */

import type { StatusSnapshot } from "../status/status-data.js";
import type { OrphanAlert } from "./status-payload.js";
import type { RefusedEntry } from "../backlog/backlog-eligibility.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { AlertRole, TeamAlert } from "./team-alert-shared.js";
import { buildStatusAlerts } from "./team-alert-status.js";
import { buildBacklogAlerts } from "./team-alert-backlog.js";
import { buildStandingAlerts } from "./team-alert-standings.js";
import { buildTailAlerts } from "./team-alert-tail.js";

export type { TeamAlert, AlertRole } from "./team-alert-shared.js";

/** The standing doctor-twin alerts' inputs (team-alert-standings.ts): the observer's
 * last-known-good config and the project root the doctor-twin rows read. Optional so a caller that
 * holds neither (a test that exercises only the other arms) raises no standing alerts —
 * the pre-fix rendering, never a false one.
 */
interface StandingAlertInputs {
  snap: Pick<
    StatusSnapshot,
    "noDeclaredCheck" | "noBrief" | "briefTruncated" | "roleNotesOverCap" | "salvagePatches" |
      "configProblem"
  >;
  config: TumwaterConfig;
  root: string;
}

/** Everything about the team that needs the operator, most urgent first: a spent budget,
 * roles failing run after run, roles that look stuck, disk and install drift, the seven
 * standing doctor twins (no-check, no-brief, brief-truncated, role-notes-truncated,
 * salvage-patches, instance-pool, config-problem), open questions,
 * refused entries, orphaned processes, and a stopped team.
 */
export function teamAlerts(
  snap: Pick<
    StatusSnapshot,
    | "running"
    | "budget"
    | "chain"
    | "disk"
    | "rootInstallDrift"
    | "budgetPausedRoles"
    | "modelChecks"
  >,
  questions: readonly string[],
  roles: readonly AlertRole[],
  _now: number,
  refused: readonly RefusedEntry[] = [],
  orphans: OrphanAlert | null = null,
  standings: StandingAlertInputs | null = null,
): TeamAlert[] {
  const out: TeamAlert[] = [];
  out.push(...buildStatusAlerts({ snap, roles }));
  if (standings) out.push(...buildStandingAlerts(standings));
  out.push(...buildBacklogAlerts({ questions, refused }));
  out.push(...buildTailAlerts({ snap, orphans }));

  return out;
}

/** Does this alert ask something of the operator (red, amber, indigo), rather than inform? */
export function alertNeedsYou(alert: TeamAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
