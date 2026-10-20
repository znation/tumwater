/** The renderer behind `tumwater diff` — the operator-facing text for the change views the
 * collector (change-data.ts, beside src/report/report-data.ts and history-data.ts) gathers: one
 * role's pending work (`--role <id>`) and the team-wide roster (no --role). Pure function of the
 * collected view — no I/O, no clock reads. */

import { plural } from "../text/phrases.js";
import type { TeamChangeView, RoleChangeView, RoleChangesView } from "./change-data.js";

/** The work-summary phrase both change views open their work lines with — `N commits ahead
 * of <main>` plus `, K commits behind` when the branch lags main, plus `, M uncommitted
 * file(s)` when the worktree is dirty (each count through plural, so the singular/plural
 * wording the tests pin cannot drift between the team roster and the per-role header).
 * Exactly two call sites: renderTeamChange's per-role line and renderRoleChange's header line. */
function workSummary(
  ahead: number,
  behind: number,
  mainBranch: string,
  dirtyFiles: string[],
): string {
  return (
    `${plural(ahead, "commit")} ahead of ${mainBranch}` +
    (behind > 0 ? `, ${plural(behind, "commit")} behind` : "") +
    (dirtyFiles.length > 0 ? `, ${plural(dirtyFiles.length, "uncommitted file")}` : "")
  );
}

/** Render the roster as the operator-facing text `tumwater diff` (no --role) prints: one
 * line per role that holds pending work, in roster order; roles with no worktree and roles
 * holding nothing are skipped. Every entry no-base means the baseline itself is gone — the
 * per-role view's line says so, team-wide, exit 0 like every other degraded case. */
export function renderTeamChange(view: TeamChangeView): string {
  if (view.roles.length > 0 && view.roles.every((r) => r.state === "no-base")) {
    return `main branch ${view.mainBranch} does not exist`;
  }
  const lines = view.roles
    .filter((r) => r.state !== "no-base" && (r.ahead > 0 || r.dirtyFiles.length > 0))
    .map((r) => `${r.role}: ${workSummary(r.ahead, r.behind, view.mainBranch, r.dirtyFiles)}`);
  return lines.length > 0 ? lines.join("\n") : "no pending changes";
}

/** Render the view as the operator-facing text `tumwater diff --role <id>` prints. */
export function renderRoleChange(view: RoleChangeView): string {
  if (view.state === "absent") return `no worktree for ${view.role}`;
  if (view.state === "no-base") return `main branch ${view.mainBranch} does not exist`;
  if (view.ahead === 0 && view.dirtyFiles.length === 0) return `no pending change for ${view.role}`;
  const lines = [
    `${view.role}: ${view.branch}, ${workSummary(view.ahead, view.behind, view.mainBranch, view.dirtyFiles)}`,
  ];
  for (const c of view.commits) lines.push(`${c.sha} ${c.subject}`);
  if (view.diff) lines.push("", view.diff.trimEnd());
  if (view.dirtyFiles.length > 0) {
    lines.push("", `uncommitted (${plural(view.dirtyFiles.length, "file")}): ${view.dirtyFiles.join(", ")}`);
    if (view.uncommittedDiff) lines.push("", view.uncommittedDiff.trimEnd());
  }
  return lines.join("\n");
}

/** Render several roles' views in the listed order, a blank line apart; every block opens with
 * its role's name, so the blank line separates them. */
export function renderRoleChanges(view: RoleChangesView): string {
  if (view.roles.length > 0 && view.roles.every((r) => r.state === "no-base")) {
    return `main branch ${view.mainBranch} does not exist`;
  }
  return view.roles.map(renderRoleChange).join("\n\n");
}
