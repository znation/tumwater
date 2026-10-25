/** Shared pieces of the team ALERT model (src/ui/team-alerts.ts): the alert data types,
 * the `TeamAlert`/`AlertRole` shapes every builder returns or reads, and the small
 * composition helpers the per-domain builder modules (team-alert-{status,backlog,
 * backlog-feed,merge,tail}.ts) share, so the wording they reuse cannot drift between
 * modules. Split from team-alerts.ts when its five builders moved to their own files. */

import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { STALL_RE, duration } from "./run-progress-model.js";
import { formatTimestamp } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";

export interface StaleBug {
  index: number;
  position: number;
  title: string;
  days: number;
}

/** A stale open question the doctor's 7-day rule warns about (src/doctor/doctor-backlog-bugs.ts
 * checkStaleQuestions, STALE_QUESTION_DAYS): an open QUESTIONS.md entry whose `(asked by …)` stamp
 * is at least 7 days old. Computed in src/ui/alert-feeds.ts's staleOpenQuestions from the same
 * threshold and the same questionFilingDate parser the doctor's check uses, so the alert and the
 * doctor cannot drift on the rule. Its 1-based position is the `questions --list`/`tumwater
 * questions answer <n>` number; its 0-based index is the `## Open` position kept only as the
 * file-order tiebreak; its title is stamp-stripped for prose; days is its whole-day age. */
export interface StaleQuestion {
  index: number;
  position: number;
  title: string;
  days: number;
}

/** A failed notify page the doctor's 1-day rule warns about (src/doctor/doctor-notify.ts,
 * NOTIFY_CHECK_WINDOW_MS): a warning event within the last day from a notify hook that failed
 * to page — a nonzero exit, a kill, or a failed start. Computed in src/ui/alert-feeds.ts's
 * notifyFailures over the same window and the same isNotifyFailure filter the doctor's check
 * uses, so the alert and the doctor cannot drift on the rule. count is the failed pages in the
 * window, latestTs the most recent one's event stamp, message its squashed wording. */
export interface NotifyFailure {
  count: number;
  latestTs: number;
  message: string;
}

/** A merge refused because the primary checkout holds uncommitted files the merge would
 * overwrite (src/merge/merge-git.ts `primaryCheckoutBlockers`, `overwriteBlockedReason`), read
 * off the `warning` event the merge path already writes. Computed in src/ui/alert-feeds.ts's
 * primaryOverwriteBlocks over the last PRIMARY_OVERWRITE_WINDOW_MS, matching the message marker
 * the merge path logs, so the alert needs no new git read and cannot drift from the refusal
 * count. count is the refusals in the window, latestTs the most recent one's event stamp,
 * message the latest refusal's squashed wording. */
export interface PrimaryOverwriteBlock {
  count: number;
  latestTs: number;
  message: string;
}

/** A queued inbox prompt the doctor's stale-prompt rule warns about (src/doctor/doctor-backlog.ts
 * checkStalePrompts, STALE_PROMPT_MS): a prompt due-but-undelivered for more than a day because
 * its role is paused, disabled, or failing. Computed in src/ui/alert-feeds.ts's stalePrompts
 * from the same threshold and the same `queuedListRows`/`listWideScope`/`deliverableAt` traversal
 * the doctor's check uses, so the alert, the doctor, and the Inbox views cannot drift on the rule.
 * `position` is the 1-based `prompt --cancel`/`--edit` number; `waitedMs` is the age the alert
 * names. Sorted oldest-first by the caller, so the first element is the most-stale prompt. */
export interface StalePrompt {
  role: string;
  position: number;
  waitedMs: number;
}

/** A queued merge the doctor's stale-merge rule warns about (src/doctor/doctor-backlog.ts
 * MERGE_QUEUE_STALE_MS): a change that has sat in the merge queue more than 6 h without
 * starting. Computed in src/ui/alert-feeds.ts's staleMerges from the same threshold and the
 * same `queuedMerges`/`readMergeMarker`/`mergeChanges` traversal the doctor's check uses, so the
 * alert and the doctor cannot drift on the rule. `waitedMs` is the age the alert names. Sorted
 * oldest-first by the caller, so the first element is the longest-waiting merge. */
export interface StaleMerge {
  role: string;
  summary: string;
  waitedMs: number;
}

/** A broken plan-dependency clause the doctor's `plan dependencies` rule (src/doctor/
 * doctor-backlog-plans.ts, planDependencyProblem) warns about: a cycle that blocks a whole
 * series forever, a dangling `requires … landed` ref naming no heading (its hold is void), an
 * unparsed clause that holds nothing, or a misworded dependency the claim allocator ignores.
 * Computed in src/ui/alert-feeds.ts's planDependencyAlert through the same function the
 * doctor's check uses, so the alert and the doctor cannot drift on the problem set, the
 * severity order, or the wording. Gives the alert's title its kind and the detail.
 */
export interface PlanDependencyProblem {
  kind: "cycle" | "dangling" | "unparsed" | "misworded";
  message: string;
}

/** An open bug a Waiting-for-the-next-failure note has held for STALE_WAIT_DAYS or more — the
 * always-on twin of the doctor's `waiting bugs` rule (src/doctor/doctor-backlog-bugs.ts
 * checkWaitingBugs, STALE_WAIT_DAYS). Computed in src/ui/alert-feeds.ts's staleWaitingBugs
 * from the same threshold, selection and anchor as the doctor's check, so the alert and the
 * doctor cannot drift on the rule; the alert omits the doctor's recurrence scan by design (the
 * reader's doc comment says why). Its 0-based index addresses the drawer (`bugs:<index>`); its
 * 1-based position is the `bug --release`/`bug --list` number; its title is stamp-stripped for
 * prose; days is its whole-day hold age. */
export interface StaleWaitingBug {
  index: number;
  position: number;
  title: string;
  days: number;
}

/** A stale or oversized flake quarantine the doctor's G3 rule warns about
 * (src/baseline/main-guardrails.ts `quarantineWarning`, QUARANTINE_WARN_COUNT, QUARANTINE_AGE_MS):
 * more than 10 quarantined tests, or any test first seen more than 3 days ago — an old entry is
 * a failure the team has stopped seeing, and an unfiled one never leaves quarantine. Computed in
 * src/ui/alert-feeds.ts's quarantineAlert from the same function the doctor's `flaky checks`
 * row calls, so the alert and the doctor cannot drift on the trigger or the thresholds. `warning`
 * is the doctor's exact phrase; `oldestFirstSeen` is the age the alert names. */
export interface QuarantinedTests {
  count: number;
  oldestTest: string;
  oldestFirstSeen: number;
  warning: string;
}
/** Checks that flapped more than once in the last day — the always-on twin of the doctor's
 * `flaky checks` row (src/doctor/doctor-project-checks.ts checkFlakyChecks): `count` is the
 * number of distinct flapping checks and `detail` is the doctor's own flapped phrase. Computed
 * in src/ui/alert-feeds.ts's flappedChecksAlert from the same repeatedFlakeCounts and
 * flappedChecksPhrase the doctor calls, so the alert and the doctor cannot drift on the count
 * or the wording. */
export interface FlappedChecks {
  count: number;
  detail: string;
}
/** A post-merge review one failed run from being dropped, the always-on twin of the doctor's
 * `post-merge reviews` row (src/doctor/doctor-backlog.ts checkPostReviews): fed from
 * alert-feeds.ts's postReviewRiskAlert, which reads the same atRiskPostReviews traversal and
 * atRiskPostReviewsPhrase the doctor shows, so the alert and the doctor cannot drift on the
 * selection or the wording. count is the at-risk reviews, detail the doctor's sentence. */
export interface PostReviewRisk {
  count: number;
  detail: string;
}
/** One `## ` section heading that appears more than once in a backlog file — the always-on twin
 * of the doctor's `backlog headings` rule (src/doctor/doctor-backlog-plans.ts, computed by the
 * shared duplicatedBacklogHeadings, which itself shares scanBacklogHeadings with the doctor's
 * checkBacklogHeadings). Structural twin: no mapping in status-payload, which just passes
 * duplicatedBacklogHeadings(root) through as the teamAlerts `duplicatedHeadings` argument. */
export interface BacklogHeadingDuplicate {
  file: string;
  heading: string;
}

/** One live backlog file's finished-history row as liveFinishedHistory reports it — the always-on
 * twin of the doctor's `backlog archive` rule (src/doctor/doctor-backlog-plans.ts, computed by the
 * shared liveFinishedEntriesFor, which itself shares liveFinishedHistory with checkLiveFinished).
 * Structural twin: no mapping in status-payload, which just passes
 * liveFinishedEntriesFor(root) through as the teamAlerts `liveFinished` argument. */
export interface LiveFinishedEntry {
  file: string;
  section: string;
  archive: string;
  entries: number;
  bytes: number;
}

/** The alert detail head for a bounded entry list (open questions, refused entries): the
 * first title stripped of its stamp, plus ` — and N more` when others await, so the two
 * alert kinds cannot drift on the separator or the count. The caller appends its own
 * action suffix (the refused alert's " · no role takes it…" clause). */
export function entryListDetail(titles: readonly string[]): string {
  const first = titles[0] === undefined ? "" : stripEntryStamp(titles[0]);
  return titles.length > 1 ? `${first} — and ${titles.length - 1} more` : first;
}

/** Append the folded names of the entries past an alert's first one, after a ` · ` separator,
 * when there are any, and the empty string otherwise — the shared idiom every amber
 * "name the oldest, fold the rest" alert (stale-bugs, waiting-bugs, stale-prompts,
 * stale-merges, stranded-plans, skipped-merges, backlog-headings) uses to compose its
 * `detail`, so the separator, the empty case, and the default fold (entryListDetail;
 * joinWithMore for the merge-queue and heading alerts) cannot drift. Callers pre-map each
 * rest element to the label the first clause already named. */
export function moreDetail(
  restLabels: readonly string[],
  fold: (items: readonly string[]) => string = entryListDetail,
): string {
  return restLabels.length > 0 ? ` · ${fold(restLabels)}` : "";
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
 * whose remedy is inspecting the failing runs/checks (main-red, quarantine, flapped checks,
 * post-merge churn and risk, regressed fixes, image-probe), so the button's label
 * and action cannot drift between them. */
export function seeFailures(): Array<{ label: string; act: string; arg: string }> {
  return [{ label: "See failures", act: "view", arg: "failures" }];
}

/** The dashboard's "Open backlog" button for an alert naming one backlog entry: opens the
 * entry's backlog-card tab and that row (the dashboard's backlog arm reads `file:index`).
 * Shared by the refused, operator-held, stalled-entries, stale-bugs, and waiting-bugs alerts,
 * so the button shape and the `file:index` contract cannot drift between them. */
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
 * "no agent output for <d>" phrase already carries its duration, so only a tool-call stall gets
 * a " for <duration>" suffix, and only when the caller holds a live tail (stuckMs present). */
export function stuckDetail(l: AlertRole): string {
  const cause = (STALL_RE.exec(l.phase)?.[0] ?? "").trim();
  if (cause && !cause.startsWith("no agent output for") && l.stuckMs !== undefined) {
    return `${roleLabel(l.role)}: ${cause} for ${duration(l.stuckMs)}`;
  }
  return `${roleLabel(l.role)}: ${cause}`;
}

/** ISO instants in server text (a restart cooldown's deadline) in local time. */
export function localizeInstants(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => formatTimestamp(Date.parse(iso)));
}
