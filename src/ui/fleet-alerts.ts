/** The fleet ALERT model: everything about the fleet that needs the operator — or that they
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
import { pauseCountdown } from "./badges.js";
import { fallbackTierEntries } from "../budget/budget.js";
import { fallbackDisplayPair } from "../config/config-views.js";
import { agree, pauseReasonSuffix, plural } from "../text/phrases.js";
import { STALL_RE, duration } from "./tick-progress-model.js";
import { formatGB, usd, usdCap } from "../text/format.js";
import { formatTimestamp } from "../text/datetime.js";

/** Something that needs the operator — or that they should know — about the fleet as a whole,
 * phrased once for both observer surfaces: the dashboard's alert banners (shipped in the status
 * payload as `alerts`) and the TUI's attention lines. `tone` ranks it (red and amber ask for
 * action, indigo asks a question, blue and gray inform); `actions` are the dashboard's buttons
 * (`act` names a page action — open a loop, a view, the cap editor…). */
export interface FleetAlert {
  key: string;
  tone: "red" | "amber" | "indigo" | "blue" | "gray";
  title: string;
  detail: string;
  actions: Array<{ label: string; act: string; arg?: string }>;
}

/** The loop facts fleetAlerts reads: whether the loop's OWN failure streak is at or past the
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

function listRoles(loops: readonly AlertLoop[]): string {
  const names = loops.map((l) => l.role);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The stuck alert's per-loop detail: the stall phrase the phase rendered, plus — when that
 * phrase does not already carry one — the honest silence span from the live tail (stuckMs,
 * ms since the loop's last pi log write, capped to the tick by progressOfTick). A
 * "no pi output for <d>" phrase already carries its duration, so only a tool-call stall gets
 * a " for <duration>" suffix, and only when the caller holds a live tail (stuckMs present). */
function stuckDetail(l: AlertLoop): string {
  const cause = (STALL_RE.exec(l.phase)?.[0] ?? "").trim();
  if (cause && !cause.startsWith("no pi output for") && l.stuckMs !== undefined) {
    return `${l.role}: ${cause} for ${duration(l.stuckMs)}`;
  }
  return `${l.role}: ${cause}`;
}

/** ISO instants in server text (a restart cooldown's deadline) in local time. */
function localizeInstants(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => formatTimestamp(Date.parse(iso)));
}

/** Everything about the fleet that needs the operator, most urgent first: a spent budget, a red
 * main, loops failing tick after tick, loops that look stuck, a stale running build, open
 * questions, a pause, a stopped fleet. `now` is passed so a timed pause's countdown agrees with
 * the rest of the frame. */
export function fleetAlerts(
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
    | "imageProbeFailures"
  >,
  questions: readonly string[],
  loops: readonly AlertLoop[],
  now: number,
): FleetAlert[] {
  const out: FleetAlert[] = [];
  const b = snap.budget;
  if (!b.free && b.capUsd > 0 && b.spentUsd >= b.capUsd) {
    out.push(
      b.fallback
        ? {
            key: "fallback",
            tone: "blue",
            title: "Today's budget is spent — the loops switched to the free fallback model",
            // Tiered fallbacks (part 7b/8): the snapshot's tier map stands exactly when the
            // tiers resolve to two or more distinct pairs, so list them and let the borrowed
            // ones' `(from …)` suffixes mark the borrow; a tier-free snapshot keeps the
            // single-pair sentence.
            detail: b.tiers
              ? `${fallbackTierEntries(b.tiers).join(", ")} carry them at no cost until midnight.`
              : `${fallbackDisplayPair(b.fallback, "The fallback")} carries them at no cost until midnight.`,
            actions: [{ label: "Raise the cap", act: "budget" }],
          }
        : {
            key: "budget",
            tone: "red",
            title: "Today's budget is spent, so the role loops are paused",
            detail: `Spent ${usd(b.spentUsd)} of the ${usdCap(b.capUsd)} cap. They resume at midnight, or as soon as you raise the cap.`,
            actions: [{ label: "Raise the cap", act: "budget" }],
          },
    );
  }
  // The disk floor holding new work (plans/disk-floor.md, part 4/4): the header badge and the
  // loop rows say what is happening, but the banner names the threshold and the way out, so an
  // operator hitting a full volume does not have to read events. An amber ask — the fleet is
  // stopped and needs room, not merely informed. Only while the hold is on; below the reclaim
  // threshold but not yet held is the badge's quieter business.
  if (snap.disk?.held) {
    out.push({
      key: "disk",
      tone: "amber",
      title: `Disk space is low — the fleet is holding new work at ${formatGB(snap.disk.freeGB)} free`,
      detail: `Free space is below the ${snap.disk.holdGB} GB floor. Build outputs are reclaimed first; new work starts again once space recovers.`,
      actions: [],
    });
  }
  const red = loops.filter((l) => l.phase === "main red");
  if (red.length) {
    out.push({
      key: "mainred",
      tone: "red",
      title: `main is red — ${plural(red.length, "loop is", "loops are")} blocked`,
      detail: "Code loops stop authoring until main's suite passes again, and pick up on their own once it does.",
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
    });
  }
  // A loop whose own failure streak is at or past the alarm threshold (onErrorStreak — an
  // error streak at ERROR_STREAK_WARN, or a quiet-kill streak): the red "failing tick after
  // tick" banner. Keyed on the streak, not on the rendered phase, so it stays up while the
  // loop's next tick runs — where loopPhase reads "working"/"landing"/"reviewing" rather
  // than "failing" — and clears only when the streak resets (BUGS.md 2026-10-14). The
  // wording names what happened (a streak of failed or rejected ticks), not a single repeated
  // error, because a rejection streak is three different rejected changes.
  const failing = loops.filter((l) => l.errorStreak);
  if (failing.length) {
    out.push({
      key: "failing",
      tone: "red",
      title: `${listRoles(failing)} ${agree(failing.length, "is", "are")} failing tick after tick`,
      detail: failing.some((l) => l.lastError)
        ? failing.map((l) => `${l.role}: ${l.lastError || "see its transcript"}`).join(" · ")
        : "The streak clears only on the next healthy tick; the transcript names each failure.",
      actions: failing.slice(0, 3).map((l) => ({ label: `Open ${l.role}`, act: "loop", arg: l.role })),
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
      actions: stuck.slice(0, 3).map((l) => ({ label: `Open ${l.role}`, act: "loop", arg: l.role })),
    });
  }
  if (snap.build?.stale) {
    const behind = plural(snap.build.aheadCommits ?? 0, "commit");
    out.push(
      snap.build.restartBlocked
        ? {
            key: "build",
            tone: "amber",
            title: `The fleet runs an old build: main is ${behind} ahead and the restart is blocked`,
            detail: localizeInstants(snap.build.restartBlocked),
            actions: [],
          }
        : {
            key: "build",
            tone: "blue",
            title: `main is ${behind} ahead of the running build`,
            detail: snap.build.restartPending ? "The fleet restarts onto it once in-flight work drains." : "Restart tumwater start to pick it up.",
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
  // Quiet hours (plans: "Quiet hours … part 2/2, observability") informs rather than asks:
  // the fleet holding to a schedule is not a problem, but an operator watching idle loops
  // inside the window needs the same explanation the pause alert gives a paused fleet —
  // why nothing ticks, and when it starts again. The window end comes from quiet-hours.ts's
  // quietWindowEnd, the same helper quietBadge uses for the header.
  if (snap.inQuietHours && snap.quietHours) {
    const end = quietWindowEnd(snap.quietHours);
    out.push({
      key: "quiet",
      tone: "blue",
      title: `Quiet hours — role loops start no new ticks until ${end}`,
      detail: `The schedule (${snap.quietHours} local time, quietHours in tumwater.json) holds them. In-flight ticks finish, and the director still runs your prompts.`,
      actions: [],
    });
  }
  if (snap.paused) {
    const left = pauseCountdown(snap.pausedUntil, now);
    out.push({
      key: "paused",
      tone: "amber",
      // The operator's pause reason (`pause --reason <text>`) states verbatim, so an
      // operator returning to a paused fleet knows why without digging through history.
      title: left
        ? `The fleet is paused and resumes in ${left}${pauseReasonSuffix(snap.pauseReason)}`
        : `The fleet is paused${pauseReasonSuffix(snap.pauseReason)}`,
      detail: "Loops start no new ticks. In-flight ticks finish, and the director still runs your prompts.",
      actions: [{ label: "Resume now", act: "resume" }],
    });
  }
  if (!snap.running) {
    out.push({
      key: "stopped",
      tone: "gray",
      title: "The fleet is not running",
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
      detail: "A tick that reads an image fails, and image attachments to these loops are refused. Declare image input on a vision model in pi's models.json, or point a tier at one.",
      actions: noTarget.slice(0, 3).map((l) => ({ label: `Open ${l.role}`, act: "loop", arg: l.role })),
    });
  } else if (textOnly.length > 0) {
    const targets = [...new Set(textOnly.map((l) => l.imageReroute ?? ""))].filter(Boolean);
    out.push({
      key: "images",
      tone: "blue",
      title: `${listRoles(textOnly)} ${agree(textOnly.length, "runs", "run")} on models that can't read images`,
      detail: `A tick that reads an image stops and reruns on ${targets.join(", ")}.`,
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
export function alertNeedsYou(alert: FleetAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
