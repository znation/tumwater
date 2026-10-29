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
 * (defined in team-alert-shared.ts) so consumers keep importing them from this one path. */

import type { StatusSnapshot } from "../status/status-data.js";
import type { OrphanAlert } from "./status-payload.js";
import type { RefusedEntry } from "../backlog/backlog-eligibility.js";
import type { AlertRole, TeamAlert } from "./team-alert-shared.js";
import { buildStatusAlerts } from "./team-alert-status.js";
import { buildBacklogAlerts } from "./team-alert-backlog.js";
import { buildTailAlerts } from "./team-alert-tail.js";

export type { TeamAlert, AlertRole } from "./team-alert-shared.js";

/** Everything about the team that needs the operator, most urgent first: a spent budget, a red
 * main, roles failing run after run, roles that look stuck, disk and install drift, open
 * questions, refused entries, the team waiting on capacity slots (workspace, provider or
 * check), and a stopped team.
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
    | "mainCheck"
  >,
  questions: readonly string[],
  roles: readonly AlertRole[],
  _now: number,
  refused: readonly RefusedEntry[] = [],
  orphans: OrphanAlert | null = null,
): TeamAlert[] {
  const out: TeamAlert[] = [];
  out.push(...buildStatusAlerts({ snap, roles }));
  out.push(...buildBacklogAlerts({ questions, refused }));
  out.push(...buildTailAlerts({ snap, orphans }));

  return out;
}

/** Does this alert ask something of the operator (red, amber, indigo), rather than inform? */
export function alertNeedsYou(alert: TeamAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
