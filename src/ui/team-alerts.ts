// vocabulary: plain
/** The team ALERT model: everything about the team that needs the operator — or that they
 * should know — phrased once for both observer surfaces: the dashboard's alert banners
 * (shipped in the status payload as `alerts`) and the TUI's attention lines
 * (tui-frame.ts alertLines). Split from status-model.ts, whose per-loop derivation this reads
 * as input; `tone` ranks an
 * alert (red and amber ask for action, indigo asks a question, blue and gray inform), and
 * `actions` are the dashboard's buttons (`act` names a page action — open a loop, a view,
 * the cap editor…). */

import type { StatusSnapshot } from "../status/status-data.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { chainFragments, pauseCountdown } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, pauseReasonSuffix, plural } from "../text/phrases.js";
import { STALL_RE, duration } from "./tick-progress-model.js";
import { formatGB, usd, usdCap } from "../text/format.js";
import { formatTimestamp, humanUntil } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";

/** Something that needs the operator — or that they should know — about the team as a whole,
 * phrased once for both observer surfaces: the dashboard's alert banners (shipped in the status
 * payload as `alerts`) and the TUI's attention lines. `tone` ranks it (red and amber ask for
 * action, indigo asks a question, blue and gray inform); `actions` are the dashboard's buttons
 * (`act` names a page action — open a loop, a view, the cap editor…). */
export interface TeamAlert {
  key: string;
  tone: "red" | "amber" | "indigo" | "blue" | "gray";
  title: string;
  detail: string;
  actions: Array<{ label: string; act: string; arg?: string }>;
}

/** The loop facts teamAlerts reads: whether the loop's OWN failure streak is at or past the
 * alert threshold (onErrorStreak, src/ui/status-model.ts) — the tell the red "failing tick
 * after tick" banner keys on, independent of the rendered phase, so the alert stays up while
 * the loop's next tick runs (its phase reads "working") and clears only once the streak
 * resets; plus its rendered phase (for the main-red and stuck banners), whether it is in
 * flight, and its last recorded error. */
export interface AlertLoop {
  role: string;
  phase: string;
  errorStreak: boolean;
  inFlight: boolean;
  lastError?: string | null;
  /** Whether the loop's own model reads images (plans/image-input.md "Surfaces", part 5/5):
   * `false` marks a text-only loop the `images` alert considers; null (unknown) is not
   * counted as text-only. Always present on the real status rows. */
  imageInput?: boolean | null;
  /** The loop's image reroute target as `<tier> (<model>)`, when a peer tier reads images.
   * Absent (or null) when no other tier reads images — the amber no-target alert. */
  imageReroute?: string | null;
  /** ms the in-flight run has been silent (its stall span), from the live tail's quietMs and
   * capped to the tick by progressOfTick; absent when the caller holds no live tail. */
  stuckMs?: number;
}

/** The dashboard's "Open <role>" buttons for an alert about a set of loops: one button per
 * loop (capped to the first three so the banner does not overflow), each opening that loop's
 * pane. Shared by the failing, stuck, and no-image-target alerts, so the button shape and its
 * cap cannot drift between them. */
function openRoleActions(loops: readonly AlertLoop[]): Array<{ label: string; act: string; arg: string }> {
  return loops.slice(0, 3).map((l) => ({ label: `Open ${roleLabel(l.role)}`, act: "role", arg: l.role }));
}

/** Natural English list of the given names: “a and b” for one or two, “a, b, and c”
 * beyond that. Shared by the loop-row and held-id banners so the wording cannot drift. */
function andJoin(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function listRoles(loops: readonly AlertLoop[]): string {
  return andJoin(loops.map((l) => roleLabel(l.role)));
}

/** The `listRoles` rendering for a set of held role ids (status-data.ts's `capPaused` and
 * `maintenanceQuota.held`, the scheduler's enabled-but-held sets rather than rendered loop
 * rows): names every held id through roleLabel even when a stale id matches no live loop, so
 * the role-cap and maintenance banners never drop a held role from their copy. */
function listRoleIds(ids: readonly string[]): string {
  return andJoin(ids.map(roleLabel));
}

/** The stuck alert's per-loop detail: the stall phrase the phase rendered, plus — when that
 * phrase does not already carry one — the honest silence span from the live tail (stuckMs,
 * ms since the loop's last pi log write, capped to the tick by progressOfTick). A
 * "no agent output for <d>" phrase already carries its duration, so only a tool-call stall gets
 * a " for <duration>" suffix, and only when the caller holds a live tail (stuckMs present). */
function stuckDetail(l: AlertLoop): string {
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
 * main, loops failing tick after tick, loops that look stuck, a stale running build, open
 * questions, refused entries, a pause, a stopped team. `now` is passed so a timed pause's
 * countdown agrees with the rest of the frame. */
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
  loops: readonly AlertLoop[],
  now: number,
  refused: readonly string[] = [],
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
  const capPausedLoops = loops.filter((l) => snap.capPaused.includes(l.role));
  if (snap.capPaused.length > 0) {
    out.push({
      key: "role-cap",
      tone: "amber",
      title: `${listRoleIds(snap.capPaused)} ${agree(snap.capPaused.length, "is over its daily cap", "are over their daily caps")}`,
      detail: `The daily cap (maxDailyCostUsdPerRole) holds ${listRoleIds(snap.capPaused)}: no new runs until local midnight. Raise the cap to resume ${agree(snap.capPaused.length, "it", "them")}.`,
      actions: openRoleActions(capPausedLoops),
    });
  }
  // The disk floor holding new work (plans/disk-floor.md, part 4/4): the header badge and the
  // loop rows say what is happening, but the banner names the threshold and the way out, so an
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
    const shown = drift.slice(0, 5).join(", ");
    const names = drift.length > 5 ? `${shown}, +${drift.length - 5} more` : shown;
    out.push({
      key: "install",
      tone: "amber",
      title: "The root install is behind package-lock.json",
      detail: `${plural(drift.length, "direct dependency", "direct dependencies")} not installed as pinned (${names}). Run npm install in the project's root checkout; until then each check installs into its own tree, and \`tumwater doctor\` names the last re-sync failure.`,
      actions: [],
    });
  }
  const red = loops.filter((l) => l.phase === "main's check is failing");
  if (red.length) {
    out.push({
      key: "mainred",
      tone: "red",
      title: `main's check is failing — ${plural(red.length, "role is", "roles are")} blocked`,
      detail: "Code roles stop authoring until main's check passes, and pick up on their own once it does.",
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
    });
  }
  // A loop whose own failure streak is at or past the alarm threshold (onErrorStreak — an
  // error streak at ERROR_STREAK_WARN, or a quiet-kill streak): the red "failing tick after
  // tick" banner. Keyed on the streak, not on the rendered phase, so it stays up while the
  // loop's next tick runs — where loopPhase reads "working"/"merge"/"reviewing" rather
  // than "failing" — and clears only when the streak resets (BUGS.md 2026-10-14). The
  // wording names what happened (a streak of failed or rejected ticks), not a single repeated
  // error, because a rejection streak is three different rejected changes.
  const failing = loops.filter((l) => l.errorStreak);
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
  const stuck = loops.filter((l) => (l.inFlight || l.phase.startsWith("director working")) && STALL_RE.test(l.phase));
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
    out.push(
      snap.build.restartBlocked
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
      detail: `${stripEntryStamp(questions[0]!)}${questions.length > 1 ? ` — and ${questions.length - 1} more` : ""}`,
      actions: [{ label: "Answer", act: "questions" }],
    });
  }
  // Refused entries hold until a human decides; amber because the operator has to act.
  if (refused.length) {
    out.push({
      key: "refused",
      tone: "amber",
      title: `${plural(refused.length, "refused entry waits", "refused entries wait")} on your decision`,
      detail: `${stripEntryStamp(refused[0]!)}${refused.length > 1 ? ` — and ${refused.length - 1} more` : ""} · no role takes it until you release it (tumwater plan|bug --release <n>, or the entry's drawer) or cancel it`,
      actions: [{ label: "Open backlog", act: "backlog" }],
    });
  }
  // Quiet hours (plans: "Quiet hours … part 2/2, observability") informs rather than asks:
  // the team holding to a schedule is not a problem, but an operator watching idle loops
  // inside the window needs the same explanation the pause alert gives a paused team —
  // why nothing ticks, and when it starts again. The window end comes from quiet-hours.ts's
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
  // the scheduler holds maintenance loops at the rolling 24 h allowance until merges free room,
  // then they tick again on their own — so it informs (gray, no actions), the quiet alert's
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
  // watching idle loops with no log open sees why nothing new starts there. Self-clearing by
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
  // Image input (plans/image-input.md "Surfaces", part 5/5): a loop whose model cannot read
  // images. Blue when every text-only loop has a reroute target (a tick that reads an image
  // stops and reruns — nothing fails); amber when some text-only loop has none (a blind read
  // fails and image submissions are refused); a separate amber when a claimed model failed
  // doctor's live probe (the claim is contradicted, whatever any loop resolved to). No alert
  // when every enabled loop reads images (imageInput true or unknown — an unknown seam is not
  // counted as text-only, mirroring the submit gate and the doctor's `tier models` stance).
  const textOnly = loops.filter((l) => l.imageInput === false);
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
