/** The status/capacity and role-phase team alerts, in emission order: a spent budget
 * (chain/fallback/budget), disk, install, and main-red holds, roles failing run after run or
 * stuck. One of the per-domain builders split out of src/ui/team-alerts.ts; the shared types
 * and wording helpers live in team-alert-shared.ts. */

import type { StatusSnapshot } from "../status/status-data.js";
import {
  openRoleActions, seeFailures, listRoles, listRoleIds, stuckDetail,
  type TeamAlert, type AlertRole,
} from "./team-alert-shared.js";
import { chainFragments } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, moreSuffix, plural } from "../text/phrases.js";
import { formatGB, shortSha, usd, usdCap } from "../text/format.js";
import { joinWithMore, squash } from "../text/text.js";
import { roleLabel } from "../roles/role-labels.js";
import { STALL_RE } from "./run-progress-model.js";

interface StatusAlertsInput {
  snap: Pick<
    StatusSnapshot,
    "budget" | "chain" | "disk" | "rootInstallDrift" | "budgetPausedRoles" | "mainCheck"
  >;
  roles: readonly AlertRole[];
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

function pushMainRedAlert(out: TeamAlert[], snap: StatusAlertsInput["snap"], roles: readonly AlertRole[]): void {
  const red = roles.filter((l) => l.phase === "main's check is failing");
  if (red.length) {
    const redDetail = snap.mainCheck?.red;
    let detail = "Code roles keep authoring on top of a red main; the ci healer owns the failing check.";
    if (redDetail) {
      const more = moreSuffix(redDetail.failingTests.length - 1);
      const blamed = redDetail.culprit?.runner
        ? `; the main watch blames ${roleLabel(redDetail.culprit.runner)}'s merge ${shortSha(redDetail.culprit.commit)}`
        : "";
      detail = `A full check failed on main: ${squash(redDetail.failingTests[0] ?? "", 80)}${more}${blamed}`;
    }
    out.push({
      key: "mainred",
      tone: "red",
      title: `main's check is failing — ${plural(red.length, "role is", "roles are")} blocked`,
      detail,
      actions: seeFailures(),
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

/** The status/capacity and role-phase alerts, in emission order: a spent budget
 * (chain/fallback/budget), disk, install, and main-red holds, roles failing run after run or
 * stuck. Extracted from teamAlerts (part 1/5 of the teamAlerts split) so the shared module
 * stays small; the input names exactly the fields this run reads. The caller pushes the
 * returned alerts at the position this run used to occupy, so the emitted key order is
 * unchanged. */
export function buildStatusAlerts(input: StatusAlertsInput): TeamAlert[] {
  const { snap, roles } = input;
  const out: TeamAlert[] = [];
  pushChainAlert(out, snap);
  pushSpentBudgetAlert(out, snap);
  pushDiskAlert(out, snap);
  pushInstallDriftAlert(out, snap);
  pushMainRedAlert(out, snap, roles);
  pushFailingStreakAlert(out, roles);
  pushStuckRoleAlert(out, roles);
  return out;
}
