/** The team ALERT model: everything about the team that needs the operator — or that they
 * should know — phrased once for both observer surfaces: the dashboard's alert banners
 * (shipped in the status payload as `alerts`) and the TUI's attention lines
 * (tui-frame.ts alertLines). Split from status-model.ts, whose per-role derivation this reads
 * as input; `tone` ranks an
 * alert (red and amber ask for action, indigo asks a question, blue and gray inform), and
 * `actions` are the dashboard's buttons (`act` names a page action — open a role, a view,
 * the cap editor…). */

import type { StatusSnapshot } from "../status/status-data.js";
import { stripEntryStamp, type StrandedPlanEntry } from "../backlog/backlog-structure.js";
import type { RefusedEntry, StalledPlan } from "../backlog/backlog-eligibility.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { chainFragments, pauseCountdown } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, pauseReasonSuffix, plural } from "../text/phrases.js";
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
 * stale-merges, stranded-plans, skipped-merges) uses to compose its `detail`, so the
 * separator, the empty case, and the default fold (entryListDetail; joinWithMore for the
 * merge-queue alerts) cannot drift. Callers pre-map each rest element to the label the
 * first clause already named. */
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
function openRoleActions(roles: readonly AlertRole[]): Array<{ label: string; act: string; arg: string }> {
  return roles.slice(0, 3).map((l) => ({ label: `Open ${roleLabel(l.role)}`, act: "role", arg: l.role }));
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

/** Everything about the team that needs the operator, most urgent first: a spent budget, a red
 * main, roles failing run after run, roles that look stuck, a stale running build, open
 * questions, refused entries, stale bugs, a stranded inbox prompt, a stalled merge queue, a
 * waiting bug held a week, a merge-queue file the reader skips, a plan stalled by a Needs
 * review or Needs replan note, a stale or oversized flake quarantine, a plan filed under the
 * wrong backlog section, a pause, a stopped team.
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
  stalledPlans: readonly StalledPlan[] = [],
  quarantined: QuarantinedTests | null = null,
  strandedPlans: readonly StrandedPlanEntry[] = [],
): TeamAlert[] {
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
  const red = roles.filter((l) => l.phase === "main's check is failing");
  if (red.length) {
    out.push({
      key: "mainred",
      tone: "red",
      title: `main's check is failing — ${plural(red.length, "role is", "roles are")} blocked`,
      detail: "Code roles stop authoring until main's check passes, and pick up on their own once it does.",
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
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
  if (questions.length) {
    out.push({
      key: "questions",
      tone: "indigo",
      title: `${plural(questions.length, "question needs", "questions need")} your answer`,
      detail: entryListDetail(questions),
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
  // A Needs-review/Needs-replan plan whose held count reached the operator threshold parks
  // until a human releases it (tumwater plan --release, part 2/3); amber because only the
  // operator can clear it, right after the refused alert, naming the entry like the refused
  // alert does. Unlike refused, a held-for-operator entry is still in the normal review
  // cycle below the threshold — only the at-past-threshold list reaches here (operatorHeldEntries).
  if (operatorHeld.length) {
    const first = operatorHeld[0]!;
    out.push({
      key: "operator-held", // vocabulary-ok: the operator-held amber alert's key
      tone: "amber",
      title: `${plural(operatorHeld.length, "plan is held", "plans are held")} for you to release`,
      detail: `Plan ${entryListDetail(operatorHeld.map((r) => r.title))} — release it with tumwater plan --release`,
      // The action lands the operator on the named entry: open the backlog card on the
      // file's tab and open that row (the dashboard's backlog arm reads `file:index`).
      actions: [{ label: "Open backlog", act: "backlog", arg: `${first.file}:${first.index}` }],
    });
  }
  // A plan parked by a Needs-review/Needs-replan note (the doctor's `stalled plans` row, behind
  // the held threshold) sits until the plan role splits or replans it — amber because the plan
  // role is the only one that can clear it, right after the operator-held alert, naming the first
  // such plan in file order, its note kind, and the fix. Same `entryHold` classification as
  // `operatorHeldEntries` and `checkStalledPlans`, so the always-on alert and the doctor cannot
  // disagree on which holds are role-resolvable. A held-for-operator plan is excluded here.
  if (stalledPlans.length) {
    const first = stalledPlans[0]!;
    out.push({
      key: "stalled-plans",
      tone: "amber",
      title: `${plural(stalledPlans.length, "plan is stalled", "plans are stalled")} in review`,
      detail: `Plan ${entryListDetail(stalledPlans.map((p) => p.title))} — ${first.hold === "needs-replan" ? "a Needs replan note parks it" : "a Needs review note parks it"}; the plan role splits or replans it, so a plan that keeps sitting here means the plan role is not running or keeps deferring`,
      // The action lands the operator on the named entry: open the backlog card on the
      // plans tab and open that row (the dashboard's backlog arm reads `file:index`).
      actions: [{ label: "Open backlog", act: "backlog", arg: `plans:${first.index}` }],
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
        ` · its flake has not come back — release it with \`tumwater bug --release ${first.position}\`, or keep the hold if the failure is still expected`,
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
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
    });
  }
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
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
    });
  }
  return out;
}

/** Does this alert ask something of the operator (red, amber, indigo), rather than inform? */
export function alertNeedsYou(alert: TeamAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
