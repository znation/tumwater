/** The status/capacity and role-phase team alerts, in emission order: a spent budget
 * (chain/fallback/budget), per-role cap, disk, install, and main-red holds, roles failing run
 * after run or stuck, and a stale running build. One of the per-domain builders split out of
 * src/ui/team-alerts.ts; the shared types and wording helpers live in team-alert-shared.ts. */

import type { StatusSnapshot } from "../status/status-data.js";
import type { ClaimState } from "../scheduling/claim-entries.js";
import { staleClaimDetail } from "../scheduling/claim-entries.js";
import {
  openRoleActions, seeFailures, listRoles, listRoleIds, stuckDetail, localizeInstants,
  type TeamAlert, type AlertRole,
} from "./team-alert-shared.js";
import { chainFragments } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, plural } from "../text/phrases.js";
import { BRIEF_TEXT_MAX_CHARS } from "../brief/brief.js";
import { formatGB, shortSha, usd, usdCap } from "../text/format.js";
import { joinWithMore, squash } from "../text/text.js";
import { roleLabel } from "../roles/role-labels.js";
import { STALL_RE } from "./run-progress-model.js";
import { ROLE_NOTES_MAX_BYTES } from "../agent/role-notes-write.js";

interface StatusAlertsInput {
  snap: Pick<
    StatusSnapshot,
    "budget" | "chain" | "disk" | "rootInstallDrift" | "capPaused" | "budgetPausedRoles" | "build"
    | "noDeclaredCheck"
    | "noBrief"
    | "briefTruncated"
    | "roleNotesOverCap"
    | "mainCheck"
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
export function buildStatusAlerts(input: StatusAlertsInput): TeamAlert[] {
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
      detail: "The review gate's build pre-check, the red-main baseline and redeploy's green check have nothing to run. The plan role will plan this project's check and the feature role declare it — a test/typecheck/build npm script, or check.command. To skip the wait, declare it yourself; a project with nothing to verify yet stays as it is.",
      actions: [],
    });
  }
  // A brief candidate exists but none resolves to a usable prompt block (briefBlockMissing):
  // every run reaches its model with no project prompt, so the team burns tokens producing
  // work unrelated to the project. The same marker-less/unreadable/empty-block state the doctor
  // `brief` row warns on, raised as a standing alert on the always-on surfaces (the bare
  // pre-init repo stays silent). Independent of team state, like the no-check alert beside it.
  if (snap.noBrief) {
    out.push({
      key: "no-brief",
      tone: "amber",
      title: "The project brief's prompt block is missing or empty — every role runs without its project prompt",
      detail: "A brief file exists but carries no usable tumwater:prompt block (no markers, or no text between them), so each run's prompt reaches the model with no project brief. Restore the block in the file the doctor `brief` row names, or re-run `tumwater init`.",
      actions: [],
    });
  }
  // A brief block past the read cap (briefBlockOverCap): every run's prompt silently carries
  // only the head plus a truncation marker, so each role plans and codes against a cut brief.
  // The same over-cap state the doctor `brief` row warns on, raised as a standing alert on the
  // always-on surfaces; mutually exclusive with `no-brief` (an over-cap block is non-empty).
  if (snap.briefTruncated) {
    out.push({
      key: "brief-truncated",
      tone: "amber",
      title: "The project brief is over its prompt cap — every role runs on a truncated brief",
      detail: "The brief block exceeds the read cap, so each run's prompt carries only its head plus a truncation marker. Shorten the block to at most " + BRIEF_TEXT_MAX_CHARS + " characters in the file the doctor `brief` row names (a hand edit, or the dashboard's Brief card), then save it.",
      actions: [],
    });
  }
  // A role note past the read bound (collectRoleNotesOverCap's predicate, the doctor `role
  // notes` row's own): `readRoleNote` truncates that role's note on read, so the role's next
  // prompt carries only the note's head plus a truncation marker while the operator sees the
  // file whole — a silently degraded next run on a green-looking status. The standing twin of
  // the doctor `role notes` row's warn, raised as an amber alert on the always-on surfaces.
  // Independent of team state, like the no-brief alert beside it.
  const notesOver = snap.roleNotesOverCap ?? [];
  if (notesOver.length > 0) {
    out.push({
      key: "role-notes-truncated",
      tone: "amber",
      title: `${plural(notesOver.length, "role note is", "role notes are")} over the read bound — those roles run on truncated notes`,
      detail: `${joinWithMore(notesOver.map((o) => `${o.role} (${o.chars})`), 3)} exceed the ${ROLE_NOTES_MAX_BYTES}-character read bound, so each of those roles' prompt carries only the note's head plus a truncation marker. Rewrite them under the cap (the run's \`tumwater-notes write\` shim, \`tumwater role <id> --notes-file <path>\`, the dashboard drawer, or the TUI notes editor).`,
      actions: [],
    });
  }
  const red = roles.filter((l) => l.phase === "main's check is failing");
  if (red.length) {
    const redDetail = snap.mainCheck?.red;
    const detail = redDetail
      ? `A full check failed on main: ${squash(redDetail.failingTests[0] ?? "", 80)}${redDetail.failingTests.length > 1 ? ` (+${redDetail.failingTests.length - 1} more)` : ""}${redDetail.culprit?.runner ? `; the main watch blames ${roleLabel(redDetail.culprit.runner)}'s merge ${shortSha(redDetail.culprit.commit)}` : ""}`
      : "Code roles keep authoring on top of a red main; the ci healer owns the failing check.";
    out.push({
      key: "mainred",
      tone: "red",
      title: `main's check is failing — ${plural(red.length, "role is", "roles are")} blocked`,
      detail,
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
    out.push({
      key: "stale-claims",
      tone: "amber",
      title: `${plural(staleClaims.length, "work-instance claim is", "work-instance claims are")} stale`,
      detail: staleClaims.map(staleClaimDetail).join("; "),
      actions: openRoleActions(staleClaims.map((c) => ({ role: c.id }))),
    });
  }
  return out;
}

