/** The status and role-phase team alerts, in emission order: a spent budget
 * (chain/fallback/budget), a failed model check, disk, and install, roles failing run after
 * run or stuck. One of the per-domain builders split out of
 * src/ui/team-alerts.ts; the shared types and wording helpers live in team-alert-shared.ts. */

import { POLL_STALL_MS } from "../status/status-data.js";
import type { StatusSnapshot } from "../status/status-types.js";
import type { GithubIssuesSummary } from "../github/github-issues-state.js";
import { ghUnreadableSentence } from "../github/gh.js";
import { githubScanStalledSentence, githubUpstreamClosedSentence } from "../github/github-issues-state.js";
import {
  openRoleActions, listRoles, listRoleIds, stuckDetail,
  type TeamAlert, type AlertRole,
} from "./team-alert-shared.js";
import { chainFragments } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, plural } from "../text/phrases.js";
import { formatGB, usd, usdCap } from "../text/format.js";
import { joinWithMore } from "../text/text.js";
import { roleLabel } from "../roles/role-labels.js";
import { STALL_RE } from "./run-progress-model.js";
import { modelCheckFault } from "../model-check/model-check.js";
import { formatClock, humanAgo } from "../text/datetime.js";

interface StatusAlertsInput {
  snap: Pick<
    StatusSnapshot,
    | "budget"
    | "chain"
    | "disk"
    | "rootInstallDrift"
    | "budgetPausedRoles"
    | "modelChecks"
    | "maintenance"
    | "pollStalled"
    | "githubIssues"
    | "githubClose"
  >;
  roles: readonly AlertRole[];
}

// The GitHub issues tumwater fixed but has not closed (src/github/issue-close.ts): a fix on local
// main closes its issue once main is pushed to GitHub, and an issue whose every entry was retired
// waits for the operator. Blue: it informs; GitHub does the closing, so no action is offered.
function pushGithubCloseAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  const g = snap.githubClose;
  if (!g) return;
  const parts: string[] = [];
  if (g.waitingPush > 0) {
    const one = g.waitingPush === 1;
    parts.push(
      `${g.waitingPush} GitHub ${one ? "issue is" : "issues are"} fixed on main and ${one ? "closes" : "close"} when you push main to ${g.repo}`,
    );
  }
  if (g.retiredOnly > 0) {
    const one = g.retiredOnly === 1;
    parts.push(
      `${g.retiredOnly} mirrored ${one ? "issue's entries were" : "issues' entries were"} all retired — close or re-file ${one ? "it" : "them"} on GitHub`,
    );
  }
  if (parts.length === 0) return;
  out.push({ key: "github-close", tone: "blue", title: parts.join(" · "), detail: "", actions: [] });
}

// The session-prune pass running in the background (retention.ts's marker, read by status-data.ts):
// roles keep running while it deletes, so this banner leads the status alerts and says how far it
// has got, when it will finish and what a restart would throw away. Blue: it informs, there is
// nothing to do, so it carries no action.
function pushMaintenanceAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  const m = snap.maintenance;
  if (m) {
    const noun = m.backend === "files" ? "session files" : `${m.backend} sessions`;
    const eta = m.etaMs === undefined ? "" : ` · about ${Math.max(1, Math.round(m.etaMs / 60_000))} min left`;
    out.push({
      key: "maintenance",
      tone: "blue",
      title: "Cleaning up expired sessions in the background",
      detail: `deleting expired ${noun}: ${m.done.toLocaleString("en-US")} / ${m.total.toLocaleString("en-US")}${eta} · started ${formatClock(m.startedAt)}.`,
      actions: [],
    });
  }
}

// The poll loop has stopped stamping its heartbeat with no maintenance pass to explain it
// (status-data.ts pollStallForPoll): a step nothing has named is blocking the loop, so no role is
// scheduled until it returns. Amber: something may need a look, but no action is offered.
function pushPollStallAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  const stalled = snap.pollStalled;
  if (stalled) {
    out.push({
      key: "pollStalled",
      tone: "amber",
      title: `Orchestrator hasn't polled for ${Math.round(POLL_STALL_MS / 60_000)}m — it may be blocked`,
      detail: `last poll stamped at ${formatClock(stalled.lastPollAt)}; no role is scheduled until it resumes.`,
      actions: [],
    });
  }
}

function pushChainAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
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
}

function pushSpentBudgetAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  const b = snap.budget;
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
}

// A provider/model pair that failed its model check (src/model-check/model-check-gate.ts): the
// roles on it wait, so the banner names the pair, what it replied (or that it gave no reply)
// and when it is checked again — the operator's evidence that the serving side is broken, not
// the roles. Red: nothing on that pair runs until it answers. The re-check lifts it by itself.
function pushModelCheckAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  const failed = (snap.modelChecks ?? []).filter((c) => c.status === "failed");
  if (failed.length) {
    out.push({
      key: "modelcheck",
      tone: "red",
      title:
        failed.length === 1
          ? `${failed[0]!.pair} failed its model check — runs on it wait`
          : `${failed.length} models failed their model check — runs on them wait`,
      detail: failed
        .map((c) => {
          const next = c.probeAt !== undefined ? `; checking again at ${formatClock(c.probeAt)}` : "";
          const on = c.seams.length > 0 ? ` (${joinWithMore(c.seams, 4)})` : "";
          return `${c.pair}${on} ${modelCheckFault(c)}${next}`;
        })
        .join(" · "),
      // One action no matter how many pairs failed — the request re-checks every failed pair.
      actions: [{ label: "Re-check now", act: "model-check" }],
    });
  }
}

// The disk floor holding new work (plans/disk-floor.md, part 4/4): the header badge and the
// role rows say what is happening, but the banner names the threshold and the way out, so an
// operator hitting a full volume does not have to read events. An amber ask — the team is
// stopped and needs room, not merely informed. Only while the hold is on; below the reclaim
// threshold but not yet held is the badge's quieter business.
function pushDiskAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  if (snap.disk?.held) {
    out.push({
      key: "disk",
      tone: "amber",
      title: `Waiting: low disk — the team is holding new work at ${formatGB(snap.disk.freeGB)} free`,
      detail: `Free space is below the ${snap.disk.holdGB} GB floor. Build outputs are reclaimed first; new work starts again once space recovers.`,
      actions: [],
    });
  }
}

// The root checkout's node_modules is behind package-lock.json (a failed post-merge re-sync):
// checks install into their own trees until it is fixed. Clears on drift, so a hand fix
// clears it too.
function pushInstallDriftAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
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
}

// A role whose own failure streak is at or past the alarm threshold (onErrorStreak — an
// error streak at ERROR_STREAK_WARN, or a quiet-kill streak): the red "failing run after
// run" banner. Keyed on the streak, not on the rendered phase, so it stays up while the
// role's next run is in progress — where rolePhase reads "working"/"merge"/"reviewing" rather
// than "failing" — and clears only when the streak resets (BUGS.md 2026-10-14). The
// wording names what happened (a streak of failed or rejected runs), not a single repeated
// error, because a rejection streak is three different rejected changes.
function pushFailingStreakAlert(out: TeamAlert[], roles: readonly AlertRole[]): void {
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
}

// A stall marker rides only a running label. The director is excluded from `inFlight` (it
// holds no maxConcurrent permit), so its own running phase is accepted too — otherwise a
// stalled director would go unalerted (BUGS.md 2026-10-06).
function pushStuckRoleAlert(out: TeamAlert[], roles: readonly AlertRole[]): void {
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
}

// gh cannot read the project's GitHub issues (plans/github-issues.md, part 3/5): the mirror is
// off until the operator installs or logs in to gh, so the banner carries the same sentence the
// doctor's `github issues` row prints. Amber: an operator fix is needed.
function pushGithubGhAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"]): void {
  const gh = snap.githubIssues;
  if (gh && (gh.gh === "missing" || gh.gh === "unauthenticated")) {
    out.push({
      key: "github-gh",
      tone: "amber",
      title: `Can't read GitHub issues for ${gh.repo}`,
      detail: ghUnreadableSentence(gh.gh, gh.repo),
      actions: [],
    });
  }
}

/** The status and role-phase alerts, in emission order: the background session-prune pass, a
 * spent budget (chain/fallback/budget), a failed model check, disk, and install, gh unable to
 * read GitHub issues, roles failing run after run or stuck. Extracted from teamAlerts (part 1/5
 * of the teamAlerts split) so the shared module stays small; the input names exactly the fields
 * this run reads. The caller pushes the returned alerts at the position this run used to occupy,
 * so the emitted key order is unchanged. */
export function buildStatusAlerts(input: StatusAlertsInput): TeamAlert[] {
  const { snap, roles } = input;
  const out: TeamAlert[] = [];
  pushMaintenanceAlert(out, snap);
  pushPollStallAlert(out, snap);
  pushGithubCloseAlert(out, snap);
  pushChainAlert(out, snap);
  pushSpentBudgetAlert(out, snap);
  pushModelCheckAlert(out, snap);
  pushDiskAlert(out, snap);
  pushInstallDriftAlert(out, snap);
  pushGithubGhAlert(out, snap);
  pushFailingStreakAlert(out, roles);
  pushStuckRoleAlert(out, roles);
  return out;
}

// A scan that failed for a reason other than gh's readiness (plans/github-issues.md, part 3/5):
// gray, since the mirror retries on its next scan and nothing is asked of the operator. The
// reason and the scan's age say what failed and how stale the ledger is.
function pushGithubErrorAlert(out: TeamAlert[], gh: GithubIssuesSummary, now: number): void {
  if (gh.gh === "error") {
    out.push({
      key: "github-error",
      tone: "gray",
      title: "Last GitHub issue scan failed",
      detail: `${gh.reason ?? "gh could not list the issues"} · checked ${humanAgo(gh.checkedAt, now)}`,
      actions: [],
    });
  }
}

// Issues waiting on the director (plans/github-issues.md, part 3/5): trusted open issues no entry
// mirrors yet, and outside issues the maintainers have not labelled. Blue: it informs, since the
// director takes them on its own clock. Each clause drops out when its count is zero.
function pushGithubMirrorAlert(out: TeamAlert[], gh: GithubIssuesSummary): void {
  const clauses: string[] = [];
  if (gh.unmirrored > 0)
    clauses.push(
      `${plural(gh.unmirrored, "open issue", "open issues")} on ${gh.repo} ${agree(gh.unmirrored, "is", "are")} waiting for the director to mirror ${gh.unmirrored === 1 ? "it" : "them"}`,
    );
  if (gh.untrusted > 0)
    clauses.push(
      `${gh.untrusted} from outside collaborators ${agree(gh.untrusted, "is", "are")} not mirrored — add the label \`${gh.mirrorLabel}\` to let one in`,
    );
  if (clauses.length > 0) {
    out.push({
      key: "github-mirror",
      tone: "blue",
      title: "GitHub issues are waiting to be mirrored",
      detail: clauses.join(" · "),
      actions: [],
    });
  }
}

/** The GitHub issue alerts that follow the backlog alerts: the gray scan-failure banner, the amber
 * scan-stall banner, the blue mirror-waiting banner, and the blue upstream-close count banner (the
 * amber `github-gh` banner rides buildStatusAlerts). Empty when the snapshot carries no ledger
 * summary. */
export function buildGithubScanAlerts(input: {
  snap: Pick<StatusSnapshot, "githubIssues" | "githubScanStall">;
  now: number;
}): TeamAlert[] {
  const gh = input.snap.githubIssues;
  if (!gh) return [];
  const out: TeamAlert[] = [];
  pushGithubErrorAlert(out, gh, input.now);
  pushGithubScanStallAlert(out, input.snap, input.now);
  pushGithubMirrorAlert(out, gh);
  pushGithubUpstreamClosesAlert(out, gh);
  return out;
}

// Issues GitHub closed upstream while the ledger held them open (INV-DG1, INV-DG2): the mirror
// recorded the loss and nothing else speaks it — a lost issue drops its `waitingPush` promise, so
// no `github-close` banner fires for it and the queue never offers it. Blue: it asks nothing of the
// operator, the same rule the gray `github-error` and blue `github-mirror` arms follow — the
// director has no issue to take and the team has no retry to run. The detail is the doctor row's
// one sentence over the summary's own count, so the two surfaces cannot disagree on a written
// ledger.
function pushGithubUpstreamClosesAlert(out: TeamAlert[], gh: GithubIssuesSummary): void {
  if (gh.upstreamClosed <= 0) return;
  out.push({
    key: "github-upstream-closes",
    tone: "blue",
    title: "GitHub issues closed upstream",
    detail: githubUpstreamClosedSentence(gh.repo, gh.upstreamClosed),
    actions: [],
  });
}

// The mirror's scan gone quiet (plans/github-issues.md, the standing-banner plan): the ledger's
// `checkedAt` sits past the stall window, so the team has stopped mirroring the operator's issue
// tracker even though `gh` may read fine. Amber: it asks for the operator's look — the fix is the
// scan's own health (a paused director, a closed-over config), not something tumwater retries.
// Gated behind `gh`'s readiness, the alert twin of `checkGithubIssues`'s precedence: a project
// whose `gh` cannot read the repo raises only the `github-gh` banner, which names the cause. The
// wording is the doctor's, from the one shared sentence.
function pushGithubScanStallAlert(
  out: TeamAlert[],
  snap: Pick<StatusSnapshot, "githubIssues" | "githubScanStall">,
  now: number,
): void {
  const stall = snap.githubScanStall;
  const gh = snap.githubIssues;
  if (!stall || !gh) return;
  if (gh.gh === "missing" || gh.gh === "unauthenticated") return;
  out.push({
    key: "github-scan-stalled",
    tone: "amber",
    title: "GitHub mirror",
    detail: githubScanStalledSentence(stall.repo, stall.checkedAt, now),
    actions: [],
  });
}
