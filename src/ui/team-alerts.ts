/** The team ALERT model: everything about the team that needs the operator — or that they
 * should know — phrased once for both observer surfaces: the dashboard's alert banners
 * (shipped in the status payload as `alerts`) and the TUI's attention lines
 * (tui-frame.ts alertLines). Split from status-model.ts, whose per-role derivation this reads
 * as input; `tone` ranks an
 * alert (red and amber ask for action, indigo asks a question, blue and gray inform), and
 * `actions` are the dashboard's buttons (`act` names a page action — open a role, a view,
 * the cap editor…). */

import type { StatusSnapshot } from "../status/status-data.js";
import type { RevertGuardrail } from "../baseline/main-guardrails.js";
import { stripEntryStamp, type StrandedPlanEntry } from "../backlog/backlog-structure.js";
import type { FixClaimProblem, ValidationGapProblem } from "../doctor/doctor-backlog-plans.js";
import type { CapacityBottleneck, DroppedPostReviews, MainRuleFailure, PostMergeChurn, RegressedFixAlert } from "./status-payload.js";
import type { RefusedEntry, StalledEntry } from "../backlog/backlog-eligibility.js";
import type { ClaimState } from "../scheduling/claim-entries.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { chainFragments, pauseCountdown } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, pauseReasonSuffix, plural } from "../text/phrases.js";
import { missingSymbolNames } from "../verdict/fix-claim.js";
import { STALL_RE, duration } from "./run-progress-model.js";
import { formatGB, usd, usdCap } from "../text/format.js";
import { formatTimestamp, humanAgo, humanUntil } from "../text/datetime.js";
import { joinWithMore, squash } from "../text/text.js";
import { roleLabel } from "../roles/role-labels.js";

/** A stale open bug the doctor's 3-day rule warns about (src/doctor/doctor-backlog-bugs.ts
 * checkStaleBugs, STALE_BUG_DAYS): an unrefused, non-waiting open bug whose filing stamp is at
 * least 3 days old. Computed in src/ui/status-payload.ts's staleOpenBugs from the same
 * threshold the doctor's check uses, so the alert and the doctor cannot drift on the rule. Its
 * 0-based position addresses the drawer (`bugs:<index>`); its 1-based position is the
 * `bug --list`/`bug --cancel` number; its title is stamp-stripped for prose; days is its whole-
 * day age. */
export interface StaleBug {
  index: number;
  position: number;
  title: string;
  days: number;
}

/** A stale open question the doctor's 7-day rule warns about (src/doctor/doctor-backlog-bugs.ts
 * checkStaleQuestions, STALE_QUESTION_DAYS): an open QUESTIONS.md entry whose `(asked by …)` stamp
 * is at least 7 days old. Computed in src/ui/status-payload.ts's staleOpenQuestions from the same
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
 * to page — a nonzero exit, a kill, or a failed start. Computed in src/ui/status-payload.ts's
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
 * off the `warning` event the merge path already writes. Computed in src/ui/status-payload.ts's
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
 * its role is paused, disabled, or failing. Computed in src/ui/status-payload.ts's stalePrompts
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
 * starting. Computed in src/ui/status-payload.ts's staleMerges from the same threshold and the
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
 * Computed in src/ui/status-payload.ts's planDependencyAlert through the same function the
 * doctor's check uses, so the alert and the doctor cannot drift on the problem set, the
 * severity order, or the wording. Gives the alert's title its kind and the detail.
 */
export interface PlanDependencyProblem {
  kind: "cycle" | "dangling" | "unparsed" | "misworded";
  message: string;
}

/** An open bug a Waiting-for-the-next-failure note has held for STALE_WAIT_DAYS or more — the
 * always-on twin of the doctor's `waiting bugs` rule (src/doctor/doctor-backlog-bugs.ts
 * checkWaitingBugs, STALE_WAIT_DAYS). Computed in src/ui/status-payload.ts's staleWaitingBugs
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
 * src/ui/status-payload.ts's quarantineAlert from the same function the doctor's `flaky checks`
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
 * in src/ui/status-payload.ts's flappedChecksAlert from the same repeatedFlakeCounts and
 * flappedChecksPhrase the doctor calls, so the alert and the doctor cannot drift on the count
 * or the wording. */
export interface FlappedChecks {
  count: number;
  detail: string;
}
/** A post-merge review one failed run from being dropped, the always-on twin of the doctor's
 * `post-merge reviews` row (src/doctor/doctor-backlog.ts checkPostReviews): fed from
 * status-payload.ts's postReviewRiskAlert, which reads the same atRiskPostReviews traversal and
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

/** A revert off main in the trailing day that G2 (src/baseline/main-guardrails.ts `revertsFor`)
 * warns about: the `main_revert` count and the doctor's own `revertWarnings` phrases — a revert
 * that looks false (its blamed test quarantined since, or its change merged again unchanged and
 * main stayed green), or a burst over REVERT_RATE_LIMIT reverts. Computed in
 * src/ui/status-payload.ts's revertAlert from the same rule the doctor's `main's check` row
 * calls, so the alert and the doctor cannot drift on the trigger or the thresholds. null when
 * the day holds no reverts, or only ordinary reverts under the limit. */
export interface RevertWarning extends RevertGuardrail {}
/** The alert detail head for a bounded entry list (open questions, refused entries): the
 * first title stripped of its stamp, plus ` — and N more` when others await, so the two
 * alert kinds cannot drift on the separator or the count. The caller appends its own
 * action suffix (the refused alert's " · no role takes it…" clause). */
function entryListDetail(titles: readonly string[]): string {
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
function moreDetail(
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
function openRoleActions(roles: ReadonlyArray<{ role: string }>): Array<{ label: string; act: string; arg: string }> {
  return roles.slice(0, 3).map((l) => ({ label: `Open ${roleLabel(l.role)}`, act: "role", arg: l.role }));
}

/** The dashboard's "See failures" button: opens the failures view. Shared by every alert
 * whose remedy is inspecting the failing runs/checks (main-red, quarantine, flapped checks,
 * reverts, post-merge churn and risk, regressed fixes, image-probe), so the button's label
 * and action cannot drift between them. */
function seeFailures(): Array<{ label: string; act: string; arg: string }> {
  return [{ label: "See failures", act: "view", arg: "failures" }];
}

/** Natural English list of the given names: “a and b” for one or two, “a, b, and c”
 * beyond that. Shared by the role-row and held-id banners so the wording cannot drift. */
function andJoin(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function listRoles(roles: readonly AlertRole[]): string {
  return andJoin(roles.map((l) => roleLabel(l.role)));
}

/** The `listRoles` rendering for a set of held role ids (status-data.ts's `capPaused` and
 * `maintenanceQuota.held`, the scheduler's enabled-but-held sets rather than rendered role
 * rows): names every held id through roleLabel even when a stale id matches no live role, so
 * the role-cap and maintenance banners never drop a held role from their copy. */
function listRoleIds(ids: readonly string[]): string {
  return andJoin(ids.map(roleLabel));
}

/** The stuck alert's per-role detail: the stall phrase the phase rendered, plus — when that
 * phrase does not already carry one — the honest silence span from the live tail (stuckMs,
 * ms since the role's last pi log write, capped to the run by progressOfRun). A
 * "no agent output for <d>" phrase already carries its duration, so only a tool-call stall gets
 * a " for <duration>" suffix, and only when the caller holds a live tail (stuckMs present). */
function stuckDetail(l: AlertRole): string {
  const cause = (STALL_RE.exec(l.phase)?.[0] ?? "").trim();
  if (cause && !cause.startsWith("no agent output for") && l.stuckMs !== undefined) {
    return `${roleLabel(l.role)}: ${cause} for ${duration(l.stuckMs)}`;
  }
  return `${roleLabel(l.role)}: ${cause}`;
}

/** ISO instants in server text (a restart cooldown's deadline) in local time. */
function localizeInstants(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => formatTimestamp(Date.parse(iso)));
}
interface StatusAlertsInput {
  snap: Pick<
    StatusSnapshot,
    "budget" | "chain" | "disk" | "rootInstallDrift" | "capPaused" | "budgetPausedRoles" | "build"
    | "noDeclaredCheck"
  >;
  roles: readonly AlertRole[];
  staleClaims: readonly ClaimState[];
}

/** The status/capacity and role-phase alerts, in emission order: a spent budget
 * (chain/fallback/budget), per-role cap, disk, install, and main-red holds, roles
 * failing run after run or stuck, and a stale running build. Extracted from
 * teamAlerts (part 1/5 of the teamAlerts split) so the shared module stays small;
 * the input names exactly the fields this run reads. The caller pushes the returned
 * alerts at the position this run used to occupy, so the emitted key order is
 * unchanged. */
function buildStatusAlerts(input: StatusAlertsInput): TeamAlert[] {
  const { snap, roles, staleClaims } = input;
  const out: TeamAlert[] = [];
  const b = snap.budget;
  const onFallback = chainFragments(snap.chain);
  if (onFallback) {
    out.push({
      key: "chain",
      tone: "blue",
      title: "Running on fallback",
      detail: `running on fallback: ${onFallback}`,
      actions: [],
    });
  }
  if (!b.free && b.capUsd > 0 && b.spentUsd >= b.capUsd) {
    // Tiered fallbacks (part 7b/8): the snapshot's tier map stands exactly when the
    // tiers resolve to two or more distinct pairs, so list them and let the borrowed
    // ones' `(from …)` suffixes mark the borrow; a tier-free snapshot keeps the
    // single-pair sentence.
    const fallbackDetail = b.tiers
      ? `${fallbackTierEntries(b.tiers).join(", ")} carry them at no cost until midnight.`
      : `${fallbackDisplayPair(b.fallback, "The fallback")} carries them at no cost until midnight.`;
    out.push(
      b.fallback
        ? {
            key: "fallback",
            tone: "blue",
            title: "Today's budget is spent — roles switched to the over-cap model",
            // The roles whose tier has no usable free pair (gate-polls.ts's budgetPausedRoles)
            // don't move: they sit on `budget paused` rows while the banner says everyone
            // switched. One sentence names both halves of the split so the spent-cap banner
            // doesn't read as if every role kept working.
            detail:
              snap.budgetPausedRoles.length > 0
                ? `${fallbackDetail} ${listRoleIds(snap.budgetPausedRoles)} ${agree(snap.budgetPausedRoles.length, "has", "have")} no free pair and ${agree(snap.budgetPausedRoles.length, "stays", "stay")} paused until local midnight.`
                : fallbackDetail,
            actions: [{ label: "Raise the cap", act: "budget" }],
          }
        : {
            key: "budget",
            tone: "red",
            title: "Today's budget is spent, so the roles are paused",
            detail: `Spent ${usd(b.spentUsd)} of the ${usdCap(b.capUsd)} cap. They resume at midnight, or as soon as you raise the cap.`,
            actions: [{ label: "Raise the cap", act: "budget" }],
          },
    );
  }
  // A role over its maxDailyCostUsdPerRole cap (status-model.ts "waiting: daily cap spent") is
  // a per-role hold — one role sits idle while the rest of the team keeps working — so the team
  // banner names it the way the budget, disk, and quiet banners name theirs, instead of leaving
  // an operator to read every row. An amber ask (it needs a raise to resume); clears on its own
  // at local midnight when the spend window rolls over.
  const capPausedRoles = roles.filter((l) => snap.capPaused.includes(l.role));
  if (snap.capPaused.length > 0) {
    out.push({
      key: "role-cap",
      tone: "amber",
      title: `${listRoleIds(snap.capPaused)} ${agree(snap.capPaused.length, "is over its daily cap", "are over their daily caps")}`,
      detail: `The daily cap (maxDailyCostUsdPerRole) holds ${listRoleIds(snap.capPaused)}: no new runs until local midnight. Raise the cap to resume ${agree(snap.capPaused.length, "it", "them")}.`,
      actions: openRoleActions(capPausedRoles),
    });
  }
  // The disk floor holding new work (plans/disk-floor.md, part 4/4): the header badge and the
  // role rows say what is happening, but the banner names the threshold and the way out, so an
  // operator hitting a full volume does not have to read events. An amber ask — the team is
  // stopped and needs room, not merely informed. Only while the hold is on; below the reclaim
  // threshold but not yet held is the badge's quieter business.
  if (snap.disk?.held) {
    out.push({
      key: "disk",
      tone: "amber",
      title: `Waiting: low disk — the team is holding new work at ${formatGB(snap.disk.freeGB)} free`,
      detail: `Free space is below the ${snap.disk.holdGB} GB floor. Build outputs are reclaimed first; new work starts again once space recovers.`,
      actions: [],
    });
  }
  // The root checkout's node_modules is behind package-lock.json (a failed post-merge re-sync):
  // checks install into their own trees until it is fixed. Clears on drift, so a hand fix
  // clears it too.
  const drift = snap.rootInstallDrift ?? [];
  if (drift.length) {
    const names = joinWithMore(drift, 5);
    out.push({
      key: "install",
      tone: "amber",
      title: "The root install is behind package-lock.json",
      detail: `${plural(drift.length, "direct dependency", "direct dependencies")} not installed as pinned (${names}). Run npm install in the project's root checkout; until then each check installs into its own tree, and \`tumwater doctor\` names the last re-sync failure.`,
      actions: [],
    });
  }
  // No deterministic build check is declared (detectBuildCheck returned null): the review
  // gate's build pre-check, the red-main baseline and redeploy's green check have nothing to
  // run, and the header badge renders nothing (mainCheckBadge needs a build_check event).
  // The same state the doctor `check` row warns on, raised as a standing alert on the always-on
  // surfaces. Independent of team state (running or stopped), like the install alert beside it.
  if (snap.noDeclaredCheck) {
    out.push({
      key: "no-check",
      tone: "amber",
      title: "No project check is declared — the safety gates are off",
      detail: "The review gate's build pre-check, the red-main baseline and redeploy's green check have nothing to run. Set \`check.command\` in tumwater.json (or add a test/typecheck/build npm script) so merges are verified.",
      actions: [],
    });
  }
  const red = roles.filter((l) => l.phase === "main's check is failing");
  if (red.length) {
    out.push({
      key: "mainred",
      tone: "red",
      title: `main's check is failing — ${plural(red.length, "role is", "roles are")} blocked`,
      detail: "Code roles stop authoring until main's check passes, and pick up on their own once it does.",
      actions: seeFailures(),
    });
  }
  // A role whose own failure streak is at or past the alarm threshold (onErrorStreak — an
  // error streak at ERROR_STREAK_WARN, or a quiet-kill streak): the red "failing run after
  // run" banner. Keyed on the streak, not on the rendered phase, so it stays up while the
  // role's next run is in progress — where rolePhase reads "working"/"merge"/"reviewing" rather
  // than "failing" — and clears only when the streak resets (BUGS.md 2026-10-14). The
  // wording names what happened (a streak of failed or rejected runs), not a single repeated
  // error, because a rejection streak is three different rejected changes.
  const failing = roles.filter((l) => l.errorStreak);
  if (failing.length) {
    out.push({
      key: "failing",
      tone: "red",
      title: `${listRoles(failing)} ${agree(failing.length, "is", "are")} failing run after run`,
      detail: failing.some((l) => l.lastError)
        ? failing.map((l) => `${roleLabel(l.role)}: ${l.lastError || "see its transcript"}`).join(" · ")
        : "The streak clears only on the next healthy run; the transcript names each failure.",
      actions: openRoleActions(failing),
    });
  }
  // A stall marker rides only a running label. The director is excluded from `inFlight` (it
  // holds no maxConcurrent permit), so its own running phase is accepted too — otherwise a
  // stalled director would go unalerted (BUGS.md 2026-10-06).
  const stuck = roles.filter((l) => (l.inFlight || l.phase.startsWith("director working")) && STALL_RE.test(l.phase));
  if (stuck.length) {
    out.push({
      key: "stuck",
      tone: "amber",
      title: `${listRoles(stuck)} ${agree(stuck.length, "looks", "look")} stuck`,
      detail: stuck.map(stuckDetail).join(" · "),
      actions: openRoleActions(stuck),
    });
  }
  if (snap.build?.stale) {
    const behind = plural(snap.build.aheadCommits ?? 0, "commit");
    // The cooldown scopes the deferral to the redeploy, not the team (PLANS.md 2026-10-23): a
    // restart held by the cooldown leaves the roles running on the stale build, so its alert
    // reads blue "work continues" with the deadline, while a genuinely blocked restart (red main,
    // a failed build, a boot refusal) stays the amber "restart blocked", and the momentary drain
    // of an in-flight restart — the one stale state that actually holds new runs and merges —
    // keeps the plain wording.
    const deferred = snap.build.restartBlocked?.startsWith("cooldown until ");
    out.push(
      deferred
        ? {
            key: "build",
            tone: "blue",
            title: `Update available (${behind} behind) — restarts after cooldown; work continues`,
            detail: `Work continues on the running build; the restart lands when the cooldown lapses or you force it (${localizeInstants(snap.build.restartBlocked ?? "")}).`,
            actions: [],
          }
        : snap.build.restartBlocked
          ? {
              key: "build",
              tone: "amber",
              title: `Update available (${behind} behind) — restart blocked`,
              detail: localizeInstants(snap.build.restartBlocked),
              actions: [],
            }
          : {
              key: "build",
              tone: "blue",
              title: `Update available (${behind} behind)${snap.build.restartPending ? " — restarts when idle" : ""}`,
              detail: snap.build.restartPending ? "The team restarts onto it once running work finishes." : "Restart tumwater start to pick it up.",
              actions: [],
            },
    );
  }
  // A work-instance claim the operator should act on without running `tumwater doctor`
  // (src/scheduling/claim-entries.ts, the doctor's `parallel instances` row): a stopped
  // instance holding an entry that left its role's section, or idle past the scheduler's
  // release window, is an amber ask. One detail line per claim, worded like the doctor row so
  // the two cannot drift; actions open the first three claimed roles. Nothing when empty.
  if (staleClaims.length > 0) {
    const noun = (c: ClaimState) => (c.file === "BUGS.md" ? "bug" : "plan");
    out.push({
      key: "stale-claims",
      tone: "amber",
      title: `${plural(staleClaims.length, "work-instance claim is", "work-instance claims are")} stale`,
      detail: staleClaims
        .map((c) =>
          c.kind === "gone"
            ? `claimed ${noun(c)} "${c.title}" (${c.id}) names an entry no longer listed`
            : `claimed ${noun(c)} "${c.title}" (${c.id}) has been idle ${c.hours}h`,
        )
        .join("; "),
      actions: openRoleActions(staleClaims.map((c) => ({ role: c.id }))),
    });
  }
  return out;
}

interface BacklogAlertsInput {
  questions: readonly string[];
  staleQuestions: readonly StaleQuestion[];
  refused: readonly RefusedEntry[];
  operatorHeld: readonly RefusedEntry[];
  stalledEntries: readonly StalledEntry[];
  planDependency: PlanDependencyProblem | null;
  strandedPlans: readonly StrandedPlanEntry[];
  duplicatedHeadings: readonly BacklogHeadingDuplicate[];
  validationGaps: readonly ValidationGapProblem[];
  fixClaims: readonly FixClaimProblem[];
}

/** The backlog alerts, in emission order: open questions, refused entries, operator-held
 * entries, stalled entries, a broken plan-dependency clause, stranded plans, duplicated
 * backlog headings, and Fixed records with a bad Validation gap trace. Extracted from
 * teamAlerts (part 2/5 of the teamAlerts split) so the shared module stays small; the input
 * names exactly the fields this run reads. The caller pushes the returned alerts at the
 * position this run used to occupy, so the emitted key order is unchanged. */
function buildBacklogAlerts(input: BacklogAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const {
    questions,
    staleQuestions,
    refused,
    operatorHeld,
    stalledEntries,
    planDependency,
    strandedPlans,
    duplicatedHeadings,
    validationGaps,
    fixClaims,
  } = input;
  if (questions.length) {
    out.push({
      key: "questions",
      tone: "indigo",
      title: `${plural(questions.length, "question needs", "questions need")} your answer`,
      detail: entryListDetail(questions),
      actions: [{ label: "Answer", act: "questions" }],
    });
  }
  // A stale question (doctor's STALE_QUESTION_DAYS rule, src/doctor/doctor-backlog-bugs.ts
  // checkStaleQuestions) has waited a week without an answer — a role is stuck behind a decision,
  // the exact class every other backlog row raises as an amber alert — so it asks (amber) the way
  // the stale-bug alert does, naming the oldest question, its age, and the `tumwater questions
  // answer` fix. Its callers pass it oldest-first (status-payload.ts staleOpenQuestions sorts
  // most-days-waited first), so the first element is the most-stale question and is named with its
  // position and days; the rest are folded through entryListDetail like the questions and refused
  // alerts, so the wording and counts cannot drift. The `questions` action opens the Questions tab,
  // so the alert carries no row address.
  if (staleQuestions.length) {
    const first = staleQuestions[0]!;
    const rest = staleQuestions.slice(1);
    out.push({
      key: "stale-questions", // vocabulary-ok: the stale-questions amber alert's key
      tone: "amber",
      title: `${plural(staleQuestions.length, "open question waited", "open questions waited")} 7+ days for an answer`,
      detail:
        `#${first.position} "${first.title}" has waited ${first.days}d for an answer` +
        moreDetail(rest.map((q) => q.title)) +
        ` · answer it with \`tumwater questions answer ${first.position} "<decision>"\`, or close it in QUESTIONS.md`,
      actions: [{ label: "Answer", act: "questions" }],
    });
  }
  // Refused entries hold until a human decides; amber because the operator has to act.
  if (refused.length) {
    const first = refused[0]!;
    out.push({
      key: "refused",
      tone: "amber",
      title: `${plural(refused.length, "refused entry waits", "refused entries wait")} on your decision`,
      detail: `Refused ${first.file === "bugs" ? "bug" : "plan"}: ${entryListDetail(refused.map((r) => r.title))} · no role takes it until you release it (tumwater plan|bug --release <n>, or the entry's drawer) or cancel it`,
      // The action lands the operator on the named entry: open the backlog card on the
      // file's tab and open that row (the dashboard's backlog arm reads `file:index`).
      actions: [{ label: "Open backlog", act: "backlog", arg: `${first.file}:${first.index}` }],
    });
  }
  // A Needs-review/Needs-replan entry whose held count reached the operator threshold parks
  // until a human releases it (tumwater plan|bug --release, part 2/3); amber because only the
  // operator can clear it, right after the refused alert, naming the entry like the refused
  // alert does. Unlike refused, a held-for-operator entry is still in the normal review
  // cycle below the threshold — only the at-past-threshold list reaches here (operatorHeldEntries).
  if (operatorHeld.length) {
    const first = operatorHeld[0]!;
    out.push({
      key: "operator-held", // vocabulary-ok: the operator-held amber alert's key
      tone: "amber",
      title: `${plural(operatorHeld.length, "backlog entry is held", "backlog entries are held")} for you to release`,
      detail: operatorHeld.some((r) => r.file === "bugs") && operatorHeld.some((r) => r.file === "plans")
        ? operatorHeld.map((r) => `${r.file === "bugs" ? "Bug" : "Plan"} ${stripEntryStamp(r.title)} (tumwater ${r.file === "bugs" ? "bug" : "plan"} --release)`).join("; ")
        : `${first.file === "bugs" ? "Bug" : "Plan"} ${entryListDetail(operatorHeld.map((r) => r.title))} — release it with tumwater ${first.file === "bugs" ? "bug" : "plan"} --release`,
      // The action lands the operator on the named entry: open the backlog card on the
      // file's tab and open that row (the dashboard's backlog arm reads `file:index`).
      actions: [{ label: "Open backlog", act: "backlog", arg: `${first.file}:${first.index}` }],
    });
  }
  // An entry parked by a Needs-review/Needs-replan note (the doctor's `stalled entries` row,
  // behind the held threshold) sits until the plan role splits or replans it — amber because
  // the plan role is the only one that can clear it, right after the operator-held alert,
  // naming the first such entry in file order, its file, its note kind, and the fix. Same
  // `entryHold` classification as `operatorHeldEntries` and `checkStalledEntries`, so the
  // always-on alert and the doctor cannot disagree on which holds are role-resolvable. A
  // held-for-operator entry is excluded here.
  if (stalledEntries.length) {
    const first = stalledEntries[0]!;
    out.push({
      key: "stalled-entries",
      tone: "amber",
      title: `${plural(stalledEntries.length, "backlog entry is stalled", "backlog entries are stalled")} in review`,
      detail: `${first.file === "bugs" ? "Bug" : "Plan"} ${entryListDetail(stalledEntries.map((p) => p.title))} — ${first.hold === "needs-replan" ? "a Needs replan note parks it" : "a Needs review note parks it"}; the plan role splits or replans the entry, so one that keeps sitting here means the plan role is not running or keeps deferring`,
      // The action lands the operator on the named entry: open the backlog card on the
      // file's tab and open that row (the dashboard's backlog arm reads `file:index`).
      actions: [{ label: "Open backlog", act: "backlog", arg: `${first.file}:${first.index}` }],
    });
  }
  // A broken plan-dependency clause (the doctor's `plan dependencies` rule,
  // src/doctor/doctor-backlog-plans.ts planDependencyProblem, via status-payload.ts's
  // planDependencyAlert) is invisible in the backlog listings — the claim allocator keeps
  // acting on the misread clause — so it asks (amber) like the stale-bug alert, named by type
  // and carrying the doctor's exact message. One alert at most (the problem set is the single
  // most serious rule), and the fix is editing PLANS.md's heading, so there are no actions.
  if (planDependency !== null) {
    const titles: Record<PlanDependencyProblem["kind"], string> = {
      cycle: "Plan dependency cycle blocks a whole series",
      dangling: "A plan requires a part no heading carries",
      unparsed: "A plan's requires clause names no readable part",
      misworded: "A plan's dependency wording holds nothing",
    };
    out.push({
      key: "plan-dependencies",
      tone: "amber",
      title: titles[planDependency.kind],
      detail: planDependency.message,
      // The fix is editing PLANS.md, and the message names the heading and ref.
      actions: [],
    });
  }
  // A plan heading filed under the wrong ## section (the doctor's `plans stuck in Planned`
  // rule, checkStrandedPlans, src/doctor/doctor-backlog-plans.ts, via the shared
  // strandedPlanEntriesFor) sits invisible to every reader that scans the right section: a
  // `(planned …)` heading under ## Done never enters a Planned reader, and a done-dated heading
  // still under ## Planned invites a second implementation. The clean role repairs it only when
  // it happens to run and the doctor warns only on request, so it asks (amber) the way the
  // plan-dependency alert does, naming the first stranded heading, its file, its section, and
  // the section it belongs under; the rest are folded through joinWithMore.
  if (strandedPlans.length) {
    const first = strandedPlans[0]!;
    const rest = strandedPlans.slice(1);
    const more = moreDetail(
      rest.map((e) => `"${e.title}" in ${e.file ?? "PLANS.md"} ## ${e.section}`),
      (labels) => joinWithMore(labels, 3),
    );
    out.push({
      key: "stranded-plans",
      tone: "amber",
      title: `${strandedPlans.length === 1 ? "A plan sits" : "Plans sit"} under the wrong backlog section`,
      detail:
        `${first.file ?? "PLANS.md"} has a plan stranded under ## ${first.section}: "${first.title}"${more} — move it under ## ${first.section === "Done" ? "Planned" : "Done"}${first.file === undefined || first.file === "PLANS.md" ? "" : " in PLANS.md"} (the clean role repairs these)`,
      // The fix is editing a backlog file, and a PLANS-DONE.md entry has no PLANS.md drawer index.
      actions: [],
    });
  }
  // A duplicated `## ` section heading already on main (the doctor's `backlog headings` row,
  // checkBacklogHeadings, src/doctor/doctor-backlog-plans.ts, via the shared
  // duplicatedBacklogHeadings) sits until a deliberate removal edit — the merge gate blocks
  // only a merge that ADDS another copy, so a duplicate already on main persists and hides
  // every later entry under its name from the `## ` section readers. It asks (amber) the way
  // the stranded-plan alert does, naming the first file-heading pair and folding the rest
  // through joinWithMore; the fix is editing a backlog file, so there are no actions.
  if (duplicatedHeadings.length) {
    const first = duplicatedHeadings[0]!;
    const rest = duplicatedHeadings.slice(1);
    const more = moreDetail(
      rest.map((d) => `"## ${d.heading}" in ${d.file}`),
      (labels) => joinWithMore(labels, 3),
    );
    out.push({
      key: "backlog-headings",
      tone: "amber",
      title: plural(duplicatedHeadings.length, "duplicated backlog heading", "duplicated backlog headings"),
      detail:
        `${first.file} "## ${first.heading}" appears more than once${more} — readers take the first section of a name, so later entries are invisible; remove the duplicate in a deliberate edit`,
      actions: [],
    });
  }
  // A Fixed record with a bad Validation gap trace (the doctor's `validation gaps` check,
  // src/doctor/doctor-backlog-plans.ts checkValidationGaps) is the always-on twin of that
  // doctor row: a newest Fixed record that omits its **Validation gap:** line, names a tag
  // outside the closed vocabulary, or declares `unclear-invariant` without pinning a
  // docs/invariants.md section is invisible or misleading to every closed-vocabulary consumer,
  // so it asks (amber) the way the stranded-plan alert does, naming the first offending record
  // and the fix. It is fed from the same scan (validationGapProblems over validationGapRecords)
  // the doctor's check uses, so the alert and the doctor cannot drift on the problem set, and
  // that scan runs no sourceHaystack walk, so it adds only the same two backlog-file reads the
  // doctor's check already makes to the poll path. The fix is editing BUGS.md, so it has no
  // buttons.
  if (validationGaps.length) {
    const first = validationGaps[0]!;
    const rest = validationGaps.slice(1);
    const reason =
      first.kind === "missing"
        ? "has no **Validation gap:** line"
        : first.kind === "unrecognized"
          ? `names unrecognized Validation gap tag "${first.tag}"`
          : "is an unclear-invariant fix but names no docs/invariants.md section";
    const more = rest.length ? ` · ${joinWithMore(rest.map((v) => `"${v.title}"`), 3)}` : "";
    out.push({
      key: "validation-gaps",
      tone: "amber",
      title: plural(validationGaps.length, "Fixed record has a validation-gap problem", "Fixed records have validation-gap problems"),
      detail:
        `BUGS.md "${first.title}" ${reason}${more} — every Fixed entry writes exactly one known **Validation gap:** tag (write \`none\` rather than omitting it), and an unclear-invariant fix pins its reconstructed guarantee in docs/invariants.md`,
      // The fix is editing BUGS.md.
      actions: [],
    });
  }
  // A newest Fixed record whose Fix paragraph names only code absent from the tree (the
  // doctor's `claimed bugs` check, src/doctor/doctor-backlog-plans.ts checkFixClaims) is the
  // always-on twin of that doctor row: a fix claim that names no live symbol is invisible to
  // every consumer that reads BUGS.md (BUGS-FIXED.md's long fight over an already-fixed entry),
  // so it asks (amber) the way the validation-gaps alert does, naming the first record and the
  // missing symbols. It is fed from the same scan (fixClaimProblems over fixClaimRecords) the
  // doctor's check uses, so the alert and the doctor cannot drift on the problem set, and that
  // scan reads the tree only when a file changed (cachedSourceHaystack), so it adds no re-read
  // to the 1 Hz poll path. The fix is editing BUGS.md, so it has no buttons.
  if (fixClaims.length) {
    const first = fixClaims[0]!;
    const rest = fixClaims.slice(1);
    const more = rest.length ? ` · ${joinWithMore(rest.map((p) => `"${p.heading}"`), 3)}` : "";
    out.push({
      key: "false-fixes",
      tone: "amber",
      title: plural(fixClaims.length, "Fixed record names code that is not on this tree", "Fixed records name code that is not on this tree"),
      detail:
        `BUGS.md records "${first.heading}" as Fixed, but none of the symbols its Fix paragraph names exist on this tree: ${missingSymbolNames(first.missing)}${more} — land the fix or keep the bug Open / refresh a stale record`,
      // The fix is editing BUGS.md.
      actions: [],
    });
  }
  return out;
}

interface BacklogFeedAlertsInput {
  staleBugs: readonly StaleBug[];
  notifyFailure: NotifyFailure | null;
  staleWaitingBugs: readonly StaleWaitingBug[];
  stalePrompts: readonly StalePrompt[];
  staleMerges: readonly StaleMerge[];
  skippedMergeFiles: readonly string[];
  primaryOverwrite: PrimaryOverwriteBlock | null;
  now: number;
}

/** The backlog-feed alerts, in emission order: stale open bugs, a failed notify page, waiting
 * bugs, stranded inbox prompts, a stalled merge queue, skipped merge-queue files, and merges
 * refused by an uncommitted primary checkout. Extracted from teamAlerts (part 3/5 of the
 * teamAlerts split) so the shared module stays small; the input names exactly the fields this
 * run reads. The caller pushes the returned alerts at the position this run used to occupy,
 * so the emitted key order is unchanged. */
function buildBacklogFeedAlerts(input: BacklogFeedAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const {
    staleBugs,
    notifyFailure,
    staleWaitingBugs,
    stalePrompts,
    staleMerges,
    skippedMergeFiles,
    primaryOverwrite,
    now,
  } = input;
  // A stale bug (doctor's STALE_BUG_DAYS rule, src/doctor/doctor-backlog-bugs.ts) sits when no
  // role fixes it — the bugfix role is disabled or failing — so it asks (amber) the way the
  // refused alert does, naming the oldest, its age, and the doctor's retract advice. Its
  // callers pass it oldest-first (status-payload.ts staleOpenBugs sorts most-days-waited first),
  // so the first element is the most-stale bug and is named with its position and age; the rest
  // are folded through entryListDetail like the questions and refused alerts, so the wording and
  // counts cannot drift.
  if (staleBugs.length) {
    const first = staleBugs[0]!;
    const rest = staleBugs.slice(1);
    out.push({
      key: "stale-bugs",
      tone: "amber",
      title: `${plural(staleBugs.length, "open bug waited", "open bugs waited")} 3+ days for a fix`,
      detail:
        `#${first.position} "${first.title}" has waited ${first.days}d for a fix` +
        moreDetail(rest.map((r) => r.title)) +
        ` · check that the bugfix role is enabled and not failing, or retract it with \`tumwater bug --cancel ${first.position}\``,
      // The action lands the operator on the first stale bug: the dashboard's backlog arm reads
      // `bugs:index` with a 0-based row, matching the drawer address.
      actions: [{ label: "Open backlog", act: "backlog", arg: `bugs:${first.index}` }],
    });
  }
  // A failed notify page (doctor's NOTIFY_CHECK_WINDOW_MS rule, src/doctor/doctor-notify.ts
  // checkNotify) leaves the fleet unsupervised — a dead webhook must not page the operator when
  // something else goes wrong — so a page that failed within the last day asks (amber) the way
  // the stale-bug alert does, naming the count, the age of the latest, its squashed message,
  // and the `tumwater notify --test` fix. Its callers feed it the latest failure's message via
  // status-payload.ts's notifyFailures (the same isNotifyFailure filter and window), so the
  // alert and the doctor cannot drift.
  if (notifyFailure) {
    out.push({
      key: "notify",
      tone: "amber",
      title: `${plural(notifyFailure.count, "failed notify page", "failed notify pages")} in the last day`,
      detail:
        `the notify hook could not reach you ${humanAgo(notifyFailure.latestTs, now)}: ${squash(notifyFailure.message, 160)} — check it with \`tumwater notify --test\``,
      actions: [],
    });
  }
  // A waiting bug (doctor's STALE_WAIT_DAYS rule, src/doctor/doctor-backlog-bugs.ts
  // checkWaitingBugs) whose flake has not come back parks indefinitely, so a hold that has
  // outlived a week asks (amber) the way the stale-bug alert does, naming the oldest hold, its
  // age, and the release-or-keep advice. Its callers pass it most-days-first (status-payload.ts
  // staleWaitingBugs sorts by days descending, ties in file order), so the first element is the
  // longest-held bug and is named with its position and days; the rest are folded through
  // entryListDetail like the questions and refused alerts, so the wording and counts cannot
  // drift.
  if (staleWaitingBugs.length) {
    const first = staleWaitingBugs[0]!;
    const rest = staleWaitingBugs.slice(1);
    out.push({
      key: "waiting-bugs", // vocabulary-ok: the waiting-bugs amber alert's key
      tone: "amber",
      title: `${plural(staleWaitingBugs.length, "waiting bug held", "waiting bugs held")} 7+ days`,
      detail:
        `#${first.position} "${first.title}" has waited ${first.days}d for its next failure` +
        moreDetail(rest.map((r) => `#${r.position} "${r.title}"`)) +
        ` · the hold has outlived a week and this surface omits the doctor's recurrence scan — \`tumwater doctor\` reports whether the flake came back; release it with \`tumwater bug --release ${first.position}\`, or keep the hold if the failure is still expected`,
      // The action lands the operator on the first stale waiting bug: the dashboard's backlog arm
      // reads `bugs:index` with a 0-based row, matching the drawer address.
      actions: [{ label: "Open backlog", act: "backlog", arg: `bugs:${first.index}` }],
    });
  }
  // A stranded inbox prompt (doctor's STALE_PROMPT_MS rule, src/doctor/doctor-backlog.ts) sits
  // when a role is paused, disabled, or failing and never reaches the run that would dequeue the
  // prompt, so it asks (amber) the way the stale-bug alert does, naming the oldest prompt, its
  // wait, and the deliver-or-drop advice. Its callers feed it oldest-first (status-payload.ts
  // stalePrompts sorts by queuedAtMs ascending), so the first element is the most-stale prompt
  // and is named with its role, position and wait; the rest are folded through entryListDetail
  // like the questions and refused alerts, so the wording and counts cannot drift.
  if (stalePrompts.length) {
    const first = stalePrompts[0]!;
    const rest = stalePrompts.slice(1);
    out.push({
      key: "stale-prompts",
      tone: "amber",
      title: `${plural(stalePrompts.length, "queued prompt waited", "queued prompts waited")} 1+ day for its role`,
      detail:
        `inbox prompt for ${roleLabel(first.role)} #${first.position} has waited ${duration(first.waitedMs)} — the role is not dequeuing it (paused, disabled, or failing); resume or enable it, or drop the prompt with \`tumwater prompt --cancel ${first.position} --role ${first.role}\`` +
        moreDetail(rest.map((p) => `${roleLabel(p.role)} #${p.position}`)),
      // The action lands the operator on the Inbox tab (the dashboard's backlog arm reads `act:
      // "queued"` as the Inbox view), where the stranded prompt is cancellable.
      actions: [{ label: "Open inbox", act: "queued" }],
    });
  }
  // A stalled merge queue (the doctor's MERGE_QUEUE_STALE_MS rule,
  // src/doctor/doctor-backlog.ts, set by the stale-merges alert) sits when a queued change
  // never starts — neither verified nor flagged — so a drain that has stopped reads healthy
  // except for this row. Its callers feed it oldest-first (status-payload.ts staleMerges reads
  // queuedMerges in queue-file order), so the first element is the longest-waiting merge and is
  // named with its role, summary and wait; the rest are folded through joinWithMore like the
  // actions and no-image alerts, so the wording and counts cannot drift.
  if (staleMerges.length) {
    const first = staleMerges[0]!;
    const rest = staleMerges.slice(1);
    out.push({
      key: "stale-merges",
      tone: "amber",
      title: `${plural(staleMerges.length, "queued merge waited", "queued merges waited")} 6+ hours to start`,
      detail:
        `${roleLabel(first.role)} — "${first.summary}" — has waited ${duration(first.waitedMs)} to start` +
        moreDetail(rest.map((m) => roleLabel(m.role)), (labels) => joinWithMore(labels, 3)) +
        ` — the merge queue has stopped moving; run \`tumwater queue\` to see it, or drop the entry with \`tumwater queue --cancel <n>\``,
      // The header's `merge queue: N` badge and the Pending view already carry the drill-in.
      actions: [],
    });
  }
  // A merge-queue file `readMergeQueue` skips (torn, foreign, or vanished mid-listing) is the
  // always-on twin of the doctor's `merge-queue files` row (doctor-backlog.ts
  // skippedMergeQueueFiles, feeding this from status-payload.ts's skippedMergeFiles): it sits
  // in .tumwater/merge-queue/ forever because the drain drops only an unreadable head, so a
  // skipped file after a healthy entry strands its merge until someone removes it. The stale-
  // merges alert above reads only readable entries, so it can never cover one. The doctor's row
  // and this alert share the one relative-path list, so they name the same files; the count and
  // the first skipped file are shown, the rest folded through joinWithMore.
  if (skippedMergeFiles.length) {
    const [first, ...rest] = skippedMergeFiles;
    out.push({
      key: "skipped-merges",
      tone: "amber",
      title: `${plural(skippedMergeFiles.length, "merge-queue file is", "merge-queue files are")} unreadable`,
      detail:
        `the queue reader skips ${first} — a torn or foreign file never clears itself, so its merge is stranded; remove it (a crashed enqueue's merge ref still recovers on the next run)` +
        moreDetail(rest, (labels) => joinWithMore(labels, 3)),
      actions: [],
    });
  }
  // A merge the primary checkout blocked (merge-git.ts primaryCheckoutBlockers, the
  // overwriteBlockedReason `warning` the merge path writes) — the always-on twin of the doctor's
  // `uncommitted backlog` row, but read off events so it reaches the status poll (the doctor's
  // git read is async and never gets there). A fleet stuck retrying one dirty file is a single
  // amber banner until the file is committed and the refusals age out; status-payload.ts's
  // primaryOverwriteBlocks feeds it the last day's refusals, counting them and naming the
  // latest's age, squashed message, and the commit fix.
  if (primaryOverwrite) {
    out.push({
      key: "primary-overwrite",
      tone: "amber",
      title: `${plural(primaryOverwrite.count, "merge was", "merges were")} refused by files uncommitted in your primary checkout`,
      detail:
        `most recently ${humanAgo(primaryOverwrite.latestTs, now)}: ${squash(primaryOverwrite.message, 160)} — roles cannot commit your checkout; commit the file(s) on main with \`tumwater doctor --commit-backlog\` (or by hand) so merges can proceed`,
      actions: [],
    });
  }
  return out;
}

interface MergeAlertsInput {
  quarantined: QuarantinedTests | null;
  flappedChecks: FlappedChecks | null;
  reverts: RevertWarning | null;
  postMergeChurn: PostMergeChurn | null;
  postReviewRisk: PostReviewRisk | null;
  droppedPostReviews: DroppedPostReviews | null;
  mainRuleFailure: MainRuleFailure | null;
  now: number;
}

/** The quarantine, flapped-check, revert and post-merge review alerts, in emission order: a
 * stale or oversized flake quarantine, checks flapping more than once, reverts off main, a
 * burst of post-merge review rejections, a post-merge review one failed run from being
 * dropped, a post-merge review the drain dropped leaves its commit on main unreviewed, and a
 * main tip the watch's diff rules rejected.
 * Extracted from teamAlerts (part 4/5 of the teamAlerts split) so the shared module stays
 * small; the input names exactly the fields this run reads (including `now`, which the
 * quarantine and dropped-post-reviews age lines need). The caller pushes the returned alerts
 * at the position this run used to occupy, so the emitted key order is unchanged. */
function buildMergeAlerts(input: MergeAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const { quarantined, flappedChecks, reverts, postMergeChurn, postReviewRisk, droppedPostReviews, mainRuleFailure, now } = input;
  // A stale or oversized flake quarantine — the always-on twin of the doctor's `flaky checks`
  // row (main-guardrails.ts checkFlakyChecks, quarantineWarning): a quarantined test counts as
  // a known failure until its filed bug leaves BUGS.md `## Open`, so an old entry means the
  // fleet is merging on a suite whose red is being excused. status-payload.ts's quarantineAlert
  // feeds it from the same quarantineWarning the doctor calls, so the alert and the doctor
  // cannot drift on when the list is a problem; the warning phrase and the oldest test's age
  // are shown, folded through squash like other long names.
  if (quarantined) {
    out.push({
      key: "quarantine",
      tone: "amber",
      title: `${plural(quarantined.count, "test")} in the flake quarantine — the gate is excusing their failures`,
      detail:
        `${quarantined.warning} · oldest: ${squash(quarantined.oldestTest, 80)} (${humanAgo(quarantined.oldestFirstSeen, now)}) — a quarantined test counts as a known failure until its filed bug leaves BUGS.md \`## Open\`, so fix the test or file the missing bug`,
      actions: seeFailures(),
    });
  }
  // Checks that flapped more than once in the last day — the always-on twin of the doctor's
  // `flaky checks` row (doctor-project-checks.ts checkFlakyChecks): the gate's single re-run
  // absorbs a one-off flake, but a check flapping twice silently pays that re-run on every
  // merge it touches, so the tally belongs on every observer surface while it happens.
  // status-payload.ts's flappedChecksAlert feeds it from the same repeatedFlakeCounts and
  // flappedChecksPhrase the doctor calls, so the alert and the doctor cannot drift on the
  // count or the wording.
  if (flappedChecks) {
    out.push({
      key: "flapped-checks",
      tone: "amber",
      title: `${plural(flappedChecks.count, "check has", "checks have")} flapped more than once in the last day`,
      detail: `${flappedChecks.detail} — a flapping check pays the gate's one re-run on every merge it touches; fix it or file it with \`tumwater bug\``,
      actions: seeFailures(),
    });
  }
  // A revert off main — the always-on twin of the doctor's `main's check` revert rule
  // (main-guardrails.ts revertGuardrail, REVERT_RATE_LIMIT): a false revert is working code
  // lost and a burst is a flaky-revert habit, both worth the operator's eye while they happen.
  // The count and ceiling cover only red-main reverts (`reason: "main-red"` on the
  // main_revert event); a post-merge-review rejection (`reason: "post-review"`) is an intended
  // revision cycle carried by `tumwater report`'s post-merge-rejection table, never here, so
  // the detail's "fix the failing test" advice always has a referent.
  // status-payload.ts's revertAlert feeds it from the same revertGuardrail the doctor calls,
  // so the alert and the doctor cannot drift on the trigger or the phrases.
  if (reverts) {
    out.push({
      key: "reverts",
      tone: "amber",
      title: `${plural(reverts.count, "revert off main", "reverts off main")} in the last day`,
      detail: `${reverts.phrases.join("; ")} — the main watch takes a change off main when main's full check flags it; fix the failing test or the revert repeats`,
      actions: seeFailures(),
    });
  }
  // Last day's post-merge review rejections — the signal for the `review.afterMerge` tiering
  // (src/review/post-merge-review.ts `reviewMergedCommit`). A post-merge rejection is the costly
  // kind: the commit already reached main, so a rejection keeps it on main with the reviewer's
  // reasons, and the always-on signal for a day crossing POST_MERGE_REJECT_WARN is this alert.
  // status-payload.ts's postMergeChurnAlert feeds it from the
  // same `afterMerge: true` `review_rejected` events the report's postMergeRejectionsByRole
  // folds, so the alert and the report cannot disagree on which rejections are post-merge.
  if (postMergeChurn) {
    out.push({
      key: "post-merge-churn",
      tone: "amber",
      title: `${plural(postMergeChurn.count, "post-merge review rejection", "post-merge review rejections")} in the last day`,
      detail: `${postMergeChurn.roles.map((r) => `${roleLabel(r.role)} ×${r.count}`).join(", ")} — each commit already reached main, so a post-merge rejection costs a revert and a re-author; narrow \`review.afterMerge\` for the noisy role or raise the authoring bar`,
      actions: seeFailures(),
    });
  }
  // A post-merge review one failed run from being dropped — the always-on twin of the doctor's
  // `post-merge reviews` row (src/doctor/doctor-backlog.ts checkPostReviews) — the last moment
  // an operator can fix the reviewer backend or deliberately accept the commit unreviewed.
  // postReviewRiskAlert feeds it from the same atRiskPostReviews traversal and phrase the doctor
  // calls, so the alert and the doctor cannot drift on the trigger or the wording.
  if (postReviewRisk) {
    out.push({
      key: "post-merge-risk",
      tone: "amber",
      title: `${plural(postReviewRisk.count, "post-merge review is", "post-merge reviews are")} one failed run from being dropped`,
      detail: postReviewRisk.detail,
      actions: seeFailures(),
    });
  }
  // A post-merge review the drain actually dropped — the commit it leaves on main unreviewed
  // (src/merge/merge-post-review.ts `startPostReview` at POST_REVIEW_FAILURE_LIMIT). Reads only
  // the `warning` event the drop branch writes, after the at-risk alert is moot: the entry is
  // gone, so no surface names the commit without this. droppedPostReviewsAlert feeds it from
  // the same DROPPED_POST_REVIEW_MARKER the drain's message carries, so the alert and the drain
  // cannot drift on what a drop is (the per-run failed-review warning never matches).
  if (droppedPostReviews) {
    out.push({
      key: "dropped-post-reviews",
      tone: "amber",
      title: `${plural(droppedPostReviews.count, "post-merge review was dropped", "post-merge reviews were dropped")} in the last day — ${plural(droppedPostReviews.count, "the commit sits", "the commits sit")} on main unreviewed`,
      detail: `most recently ${humanAgo(droppedPostReviews.latestTs, now)}: ${squash(droppedPostReviews.latestMessage, 160)} — the reviewer kept failing past \`POST_REVIEW_FAILURE_LIMIT\`, so the commit is beyond the review gate; fix the reviewer backend so later commits are reviewed`,
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
    });
  }
  // A main tip the watch's five diff rules rejected in the trailing day — the always-on
  // surface for the `warning` main-watch.ts's `watchRules` logs (`main's tip <short sha> fails
  // the diff rules: <reason>`). The gate judges one change; the watch judges each first-parent
  // commit's own diff, so a conflict marker, a protected edit, a leaked secret, a phantom fix
  // claim or a broken backlog structure that reached main through a gate blind spot sits on
  // main with only that event log to say so. status-payload.ts's mainRuleFailures feeds it
  // from the same marker, so the alert and the watch cannot drift on what a rule failure is (a
  // `main_check` or `review_rejected` carrying the same text never matches).
  if (mainRuleFailure) {
    out.push({
      key: "main-diff-rules",
      tone: "amber",
      title: `${plural(mainRuleFailure.count, "diff-rule failure on main", "diff-rule failures on main")} in the last day`,
      detail: `most recently ${humanAgo(mainRuleFailure.latestTs, now)}: ${squash(mainRuleFailure.latestMessage, 160)} — the gate approved a diff the watch's five rules reject, so main carries what the gate would refuse; repair the tip or revert it with \`tumwater revert <sha>\``,
      actions: seeFailures(),
    });
  }
  return out;
}

interface TailAlertsInput {
  snap: Pick<
    StatusSnapshot,
    | "inQuietHours"
    | "quietHours"
    | "maintenanceQuota"
    | "providerHolds"
    | "paused"
    | "pausedUntil"
    | "pauseReason"
    | "running"
    | "imageProbeFailures"
  >;
  now: number;
  contention: readonly CapacityBottleneck[];
  regressedFixes: RegressedFixAlert | null;
  roles: readonly AlertRole[];
}

/** The quiet-hours, maintenance, provider-hold, pause, capacity-contention, regressed-fix,
 * stopped and image-input alerts, in emission order: a run of quiet hours holding the team, a
 * maintenance allowance held at its rolling cap, a standing provider failure hold, an operator
 * pause with its countdown, the last day's capacity contention, a fixed test that regressed, a
 * stopped tumwater, and roles that cannot or may not read images. Extracted from teamAlerts
 * (part 5/5 of the teamAlerts split) so the shared module stays small; the input names exactly
 * the fields this run reads, including `now`, which the pause countdown and provider-hold
 * re-open time need. The caller pushes the returned alerts at the position this run used to
 * occupy, so the emitted key order is unchanged. */
function buildTailAlerts(input: TailAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const { snap, now, contention, regressedFixes, roles } = input;

  // Quiet hours (plans: "Quiet hours … part 2/2, observability") informs rather than asks:
  // the team holding to a schedule is not a problem, but an operator watching idle roles
  // inside the window needs the same explanation the pause alert gives a paused team —
  // why nothing runs, and when it starts again. The window end comes from quiet-hours.ts's
  // quietWindowEnd, the same helper quietBadge uses for the header.
  if (snap.inQuietHours && snap.quietHours) {
    const end = quietWindowEnd(snap.quietHours);
    out.push({
      key: "quiet",
      tone: "blue",
      title: `Quiet hours — roles start no new runs until ${end}`,
      detail: `The schedule (${snap.quietHours} local time, quietHours in tumwater.json) holds them. Runs in progress finish, and the director still runs your prompts.`,
      actions: [],
    });
  }
  // The maintenance allowance (plans/work-ratio.md, part 1b/4): by design and self-clearing —
  // the scheduler holds maintenance roles at the rolling 24 h allowance until merges free room,
  // then they run again on their own — so it informs (gray, no actions), the quiet alert's
  // tone, rather than amber like the failed/refused asks. An operator watching idle maintenance
  // roles gets the same explanation the hold's own row carries, team-wide.
  if (snap.maintenanceQuota.held.length > 0) {
    const mq = snap.maintenanceQuota;
    out.push({
      key: "maintenance",
      tone: "gray",
      title: "Maintenance is held at its rolling allowance",
      detail: `${mq.used} of ${mq.allowance} maintenance allowance used over the last 24 h; ${listRoleIds(mq.held)} ${agree(mq.held.length, "resumes", "resume")} as work merges.`,
      actions: [],
    });
  }
  // A standing provider failure hold (src/team/team-hold.ts `standingHolds`, published through
  // the orchestrator info file): a provider storm holds roles on that provider, so an operator
  // watching idle roles with no log open sees why nothing new starts there. Self-clearing by
  // design — the hold re-opens at its own deadline — so it informs (blue, no actions), the
  // quiet and maintenance alerts' tone, rather than asking. The snapshot carries the holds only
  // while a live orchestrator publishes one.
  if (snap.providerHolds && snap.providerHolds.length > 0) {
    const phrased = snap.providerHolds
      .map(
        (h) =>
          `${h.provider ?? "pi's default backend"} (${h.kind}) until it re-opens in ${humanUntil(h.until, now)}`,
      )
      .join("; ");
    out.push({
      key: "provider-hold",
      tone: "blue",
      title: agree(snap.providerHolds.length, "Provider limit is holding new runs", "Provider limits are holding new runs"),
      detail: `${phrased}. Runs in progress finish; roles on a held provider start no new runs until it re-opens.`,
      actions: [],
    });
  }
  if (snap.paused) {
    const left = pauseCountdown(snap.pausedUntil, now);
    out.push({
      key: "paused",
      tone: "amber",
      // The operator's pause reason (`pause --reason <text>`) states verbatim, so an
      // operator returning to a paused team knows why without digging through history.
      title: left
        ? `The team is paused and resumes in ${left}${pauseReasonSuffix(snap.pauseReason)}`
        : `The team is paused${pauseReasonSuffix(snap.pauseReason)}`,
      detail: "Roles start no new runs. Runs in progress finish, and the director still runs your prompts.",
      actions: [{ label: "Resume now", act: "resume" }],
    });
  }
  // Last day's capacity contention — the always-on twin of the doctor's `workspaces`,
  // `provider contention` and `check contention` rows (doctor-contention-checks.ts). The
  // instantaneous badges show only current waits, and the 24 h total is the tuning signal that
  // says a cap is too small; status-payload.ts's capacityContention feeds it from the same
  // `*_wait` events and ten-minute thresholds the doctor sums, so the alert and the doctor
  // cannot drift on the trigger or the knob-raising advice.
  if (contention.length > 0) {
    out.push({
      key: "contention",
      tone: "amber",
      title: plural(contention.length, "capacity bottleneck in the last day", "capacity bottlenecks in the last day"),
      detail: contention.map((c) => `${c.name}: ${squash(c.detail, 200)}`).join(" · "),
      actions: [],
    });
  }
  // A Fixed record whose quoted test failed again in the trailing day — the always-on twin of
  // the doctor's `regressed fixes` row (doctor-backlog-bugs.ts checkRegressedFixes).
  // status-payload.ts's regressedFixesAlert feeds it the same candidate selection, failureMentions
  // match and verbatim sentence, so the alert and the doctor cannot drift on the trigger or the
  // wording; the Failures view shows the naming events.
  if (regressedFixes) {
    out.push({
      key: "regressed-fixes",
      tone: "amber",
      title: plural(regressedFixes.count, "Fixed test has regressed", "Fixed tests have regressed"),
      detail: regressedFixes.detail,
      actions: seeFailures(),
    });
  }
  if (!snap.running) {
    out.push({
      key: "stopped",
      tone: "gray",
      title: "tumwater is not running — start it with `tumwater start`",
      detail: "Start it with tumwater start in the project directory; the dashboards pick it up on their own.",
      actions: [{ label: "Copy the command", act: "copy", arg: "tumwater start" }],
    });
  }
  // Image input (plans/image-input.md "Surfaces", part 5/5): a role whose model cannot read
  // images. Blue when every text-only role has a reroute target (a run that reads an image
  // stops and reruns — nothing fails); amber when some text-only role has none (a blind read
  // fails and image submissions are refused); a separate amber when a claimed model failed
  // doctor's live probe (the claim is contradicted, whatever any role resolved to). No alert
  // when every enabled role reads images (imageInput true or unknown — an unknown seam is not
  // counted as text-only, mirroring the submit gate and the doctor's `tier models` stance).
  const textOnly = roles.filter((l) => l.imageInput === false);
  const noTarget = textOnly.filter((l) => l.imageReroute == null || l.imageReroute === "");
  if (noTarget.length > 0) {
    out.push({
      key: "images",
      tone: "amber",
      title: `No configured model can read images for ${listRoles(noTarget)}`,
      detail: "A run that reads an image fails, and image attachments to these roles are refused. Declare image input on a vision model in pi's models.json, or point a tier at one.",
      actions: openRoleActions(noTarget),
    });
  } else if (textOnly.length > 0) {
    const targets = [...new Set(textOnly.map((l) => l.imageReroute ?? ""))].filter(Boolean);
    out.push({
      key: "images",
      tone: "blue",
      title: `${listRoles(textOnly)} ${agree(textOnly.length, "runs", "run")} on models that can't read images`,
      detail: `A run that reads an image stops and reruns on ${targets.join(", ")}.`,
      actions: [],
    });
  }
  if (snap.imageProbeFailures.length > 0) {
    out.push({
      key: "images-probe",
      tone: "amber",
      title: `A claimed image-capable model failed doctor's probe`,
      detail: `${snap.imageProbeFailures.join(", ")} declare image input but failed the live probe — run \`tumwater doctor --reprobe\` to re-check.`,
      actions: seeFailures(),
    });
  }
  return out;
}

/** Everything about the team that needs the operator, most urgent first: a spent budget, a red
 * main, roles failing run after run, roles that look stuck, a stale running build, open
 * questions, refused entries, stale bugs, a failed notify page, a dirty primary
 * checkout refusing merges, a stranded inbox
 * prompt, a stalled merge queue, a
 * waiting bug held a week, a merge-queue file the reader skips, a plan stalled by a Needs
 * review or Needs replan note, checks that flapped more than once in the last day, a stale or
 * oversized flake quarantine, a revert off main that
 * looks false or a revert burst, a burst of post-merge review rejections, each a commit that
 * already reached main, a post-merge review one failed run from being dropped, a post-merge
 * review dropped after repeated failures, leaving its commit on main unreviewed, a main tip the
 * watch's five diff rules rejected, the fleet
 * waiting on capacity slots (workspace, provider or
 * check), a plan filed under the wrong backlog section, a duplicated
 * backlog section heading, a Fixed record with a bad Validation gap trace, a pause, a
 * stopped team.
 * `now` is passed so a timed
 * pause's countdown agrees with the rest of the frame. */
export function teamAlerts(
  snap: Pick<
    StatusSnapshot,
    | "running"
    | "budget"
    | "build"
    | "paused"
    | "pausedUntil"
    | "pauseReason"
    | "quietHours"
    | "inQuietHours"
    | "disk"
    | "rootInstallDrift"
    | "noDeclaredCheck"
    | "imageProbeFailures"
    | "chain"
    | "capPaused"
    | "budgetPausedRoles"
    | "maintenanceQuota"
    | "providerHolds"
  >,
  questions: readonly string[],
  roles: readonly AlertRole[],
  now: number,
  refused: readonly RefusedEntry[] = [],
  operatorHeld: readonly RefusedEntry[] = [],
  staleBugs: readonly StaleBug[] = [],
  stalePrompts: readonly StalePrompt[] = [],
  staleMerges: readonly StaleMerge[] = [],
  planDependency: PlanDependencyProblem | null = null,
  staleWaitingBugs: readonly StaleWaitingBug[] = [],
  skippedMergeFiles: readonly string[] = [],
  stalledEntries: readonly StalledEntry[] = [],
  quarantined: QuarantinedTests | null = null,
  strandedPlans: readonly StrandedPlanEntry[] = [],
  duplicatedHeadings: readonly BacklogHeadingDuplicate[] = [],
  validationGaps: readonly ValidationGapProblem[] = [],
  reverts: RevertWarning | null = null,
  notifyFailure: NotifyFailure | null = null,
  primaryOverwrite: PrimaryOverwriteBlock | null = null,
  contention: readonly CapacityBottleneck[] = [],
  flappedChecks: FlappedChecks | null = null,
  regressedFixes: RegressedFixAlert | null = null,
  postMergeChurn: PostMergeChurn | null = null,
  postReviewRisk: PostReviewRisk | null = null,
  droppedPostReviews: DroppedPostReviews | null = null,
  mainRuleFailure: MainRuleFailure | null = null,
  staleClaims: readonly ClaimState[] = [],
  staleQuestions: readonly StaleQuestion[] = [],
  fixClaims: readonly FixClaimProblem[] = [],
): TeamAlert[] {
  const out: TeamAlert[] = [];
  out.push(...buildStatusAlerts({ snap, roles, staleClaims }));
  out.push(...buildBacklogAlerts({ questions, staleQuestions, refused, operatorHeld, stalledEntries, planDependency, strandedPlans, duplicatedHeadings, validationGaps, fixClaims }));
  out.push(...buildBacklogFeedAlerts({ staleBugs, notifyFailure, staleWaitingBugs, stalePrompts, staleMerges, skippedMergeFiles, primaryOverwrite, now }));
  out.push(...buildMergeAlerts({ quarantined, flappedChecks, reverts, postMergeChurn, postReviewRisk, droppedPostReviews, mainRuleFailure, now }));
  out.push(...buildTailAlerts({ snap, now, contention, regressedFixes, roles }));

  return out;
}

/** Does this alert ask something of the operator (red, amber, indigo), rather than inform? */
export function alertNeedsYou(alert: TeamAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
