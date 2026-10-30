/** Shared pieces of the team ALERT model (src/ui/team-alerts.ts): the alert data types,
 * the `TeamAlert`/`AlertRole` shapes every builder returns or reads, and the small
 * composition helpers the per-domain builder modules (team-alert-{status,backlog,
 * tail}.ts) share, so the wording they reuse cannot drift between
 * modules. Split from team-alerts.ts when its three builders moved to their own files. */

import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { STALL_RE, duration } from "./run-progress-model.js";
import { formatTimestamp } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";

/** The alert detail head for a bounded entry list (open questions, refused entries): the
 * first title stripped of its stamp, plus ` — and N more` when others await, so the two
 * alert kinds cannot drift on the separator or the count. The caller appends its own
 * action suffix (the refused alert's " · no role takes it…" clause). */
export function entryListDetail(titles: readonly string[]): string {
  const first = titles[0] === undefined ? "" : stripEntryStamp(titles[0]);
  return titles.length > 1 ? `${first} — and ${titles.length - 1} more` : first;
}

/** Something that needs the operator — or that they should know — about the team as a whole,
 * phrased once for both observer surfaces: the dashboard's alert banners (shipped in the status
 * payload as `alerts`) and the TUI's attention lines. `tone` ranks it (red and amber ask for
 * action, indigo asks a question, blue and gray inform); `actions` are the dashboard's buttons
 * (`act` names a page action — open a role, a view, the cap editor…). */
export interface TeamAlert {
  key: string;
  tone: "red" | "amber" | "indigo" | "blue" | "gray";
  title: string;
  detail: string;
  actions: Array<{ label: string; act: string; arg?: string }>;
}

/** The role facts teamAlerts reads: whether the role's OWN failure streak is at or past the
 * alert threshold (onErrorStreak, src/ui/status-model.ts) — the tell the red "failing run
 * after run" banner keys on, independent of the rendered phase, so the alert stays up while
 * the role's next run is in progress (its phase reads "working") and clears only once the streak
 * resets; plus its rendered phase (for the main-red and stuck banners), whether it is in
 * flight, and its last recorded error. */
export interface AlertRole {
  role: string;
  phase: string;
  errorStreak: boolean;
  inFlight: boolean;
  lastError?: string | null;
  /** Whether the role's own model reads images (plans/image-input.md "Surfaces", part 5/5):
   * `false` marks a text-only role the `images` alert considers; null (unknown) is not
   * counted as text-only. Always present on the real status rows. */
  imageInput?: boolean | null;
  /** The role's image reroute target as `<tier> (<model>)`, when a peer tier reads images.
   * Absent (or null) when no other tier reads images — the amber no-target alert. */
  imageReroute?: string | null;
  /** ms the in-flight run has been silent (its stall span), from the live tail's quietMs and
   * capped to the run by progressOfRun; absent when the caller holds no live tail. */
  stuckMs?: number;
}

/** The dashboard's "Open <role>" buttons for an alert about a set of roles: one button per
 * role (capped to the first three so the banner does not overflow), each opening that role's
 * pane. Shared by the failing, stuck, and no-image-target alerts, so the button shape and its
 * cap cannot drift between them. */
export function openRoleActions(roles: ReadonlyArray<{ role: string }>): Array<{ label: string; act: string; arg: string }> {
  return roles.slice(0, 3).map((l) => ({ label: `Open ${roleLabel(l.role)}`, act: "role", arg: l.role }));
}

/** The dashboard's "See failures" button: opens the failures view. Shared by every alert
 * whose remedy is inspecting the failing runs/checks (main-red, regressed fixes), so the
 * button's label and action cannot drift between them. */
export function seeFailures(): Array<{ label: string; act: string; arg: string }> {
  return [{ label: "See failures", act: "view", arg: "failures" }];
}

/** The dashboard's "Open backlog" button for an alert naming one backlog entry: opens the
 * entry's backlog-card tab and that row (the dashboard's backlog arm reads `file:index`).
 * Used by the refused alert,
 * so the button shape and the `file:index` contract cannot drift. */
export function openBacklogAction(entry: { file: "plans" | "bugs"; index: number }): Array<{ label: string; act: string; arg: string }> {
  return [{ label: "Open backlog", act: "backlog", arg: `${entry.file}:${entry.index}` }];
}
/** Natural English list of the given names: “a and b” for one or two, “a, b, and c”
 * beyond that. Shared by the role-row and held-id banners so the wording cannot drift. */
function andJoin(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function listRoles(roles: readonly AlertRole[]): string {
  return andJoin(roles.map((l) => roleLabel(l.role)));
}

/** The `listRoles` rendering for a set of held role ids (status-data.ts's `capPaused` and
 * `maintenanceQuota.held`, the scheduler's enabled-but-held sets rather than rendered role
 * rows): names every held id through roleLabel even when a stale id matches no live role, so
 * the role-cap and maintenance banners never drop a held role from their copy. */
export function listRoleIds(ids: readonly string[]): string {
  return andJoin(ids.map(roleLabel));
}

/** The stuck alert's per-role detail: the stall phrase the phase rendered, plus — when that
 * phrase does not already carry one — the honest silence span from the live tail (stuckMs,
 * ms since the role's last pi log write, capped to the run by progressOfRun). A
 * "no agent output for <d>" or "no model reply for <d>" phrase already carries its duration, so
 * only a tool-call stall gets a " for <duration>" suffix, and only when the caller holds a live
 * tail (stuckMs present). */
export function stuckDetail(l: AlertRole): string {
  const cause = (STALL_RE.exec(l.phase)?.[0] ?? "").trim();
  if (cause.startsWith("tool call stalled") && l.stuckMs !== undefined) {
    return `${roleLabel(l.role)}: ${cause} for ${duration(l.stuckMs)}`;
  }
  return `${roleLabel(l.role)}: ${cause}`;
}

/** ISO instants in server text (a restart cooldown's deadline) in local time. */
export function localizeInstants(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => formatTimestamp(Date.parse(iso)));
}
