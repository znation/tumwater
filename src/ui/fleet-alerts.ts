/** The fleet ALERT model: everything about the fleet that needs the operator — or that they
 * should know — phrased once for both observer surfaces: the dashboard's alert banners
 * (shipped in the status payload as `alerts`) and the TUI's attention lines
 * (tui-frame.ts alertLines). Split from status-model.ts, whose per-loop derivation this reads
 * as input but does not share helpers with beyond badges.ts's humanSeconds; `tone` ranks an
 * alert (red and amber ask for action, indigo asks a question, blue and gray inform), and
 * `actions` are the dashboard's buttons (`act` names a page action — open a loop, a view,
 * the cap editor…). */

import type { StatusSnapshot } from "../status-data.js";
import { quietWindowEnd } from "../quiet-hours.js";
import { humanSeconds } from "./badges.js";
import { plural, usd, usdCap } from "../text.js";
import { formatTimestamp } from "../datetime.js";

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

/** The loop facts fleetAlerts reads: each loop's rendered phase (loopPhase), whether it is in
 * flight, and its last recorded error. */
export interface AlertLoop {
  role: string;
  phase: string;
  inFlight: boolean;
  lastError?: string | null;
}

/** A stalled tool call or a long silence, as inFlightDetail names them in a phase label. */
const STALL = /tool call stalled[^·]*|no pi output for [^·]*/;

function listRoles(loops: readonly AlertLoop[]): string {
  const names = loops.map((l) => l.role);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** A backlog title without its trailing `(planned 2026-09-29)`-style note. */
function entryTitle(title: string): string {
  return title.replace(/\s*\((?:planned|reported|found|refined|asked|posted|filed|opened|done)\b[^)]*\)\s*$/i, "");
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
    "running" | "budget" | "build" | "paused" | "pausedUntil" | "quietHours" | "inQuietHours"
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
            detail: `${b.fallback.model ?? b.fallback.provider ?? "The fallback"} carries them at no cost until midnight.`,
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
  const failing = loops.filter((l) => l.phase === "failing");
  if (failing.length) {
    out.push({
      key: "failing",
      tone: "red",
      title: `${listRoles(failing)} ${failing.length === 1 ? "is" : "are"} failing tick after tick`,
      detail: failing.some((l) => l.lastError)
        ? failing.map((l) => `${l.role}: ${l.lastError || "see its transcript"}`).join(" · ")
        : "The same error keeps coming back. The transcript shows where it stops.",
      actions: failing.slice(0, 3).map((l) => ({ label: `Open ${l.role}`, act: "loop", arg: l.role })),
    });
  }
  const stuck = loops.filter((l) => l.inFlight && STALL.test(l.phase));
  if (stuck.length) {
    out.push({
      key: "stuck",
      tone: "amber",
      title: `${listRoles(stuck)} ${stuck.length === 1 ? "looks" : "look"} stuck`,
      detail: stuck.map((l) => `${l.role}: ${(STALL.exec(l.phase)?.[0] ?? "").trim()}`).join(" · "),
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
            detail: snap.build.restartPending ? "The fleet restarts onto it once in-flight work drains." : "Restart tumwater run to pick it up.",
            actions: [],
          },
    );
  }
  if (questions.length) {
    out.push({
      key: "questions",
      tone: "indigo",
      title: `${plural(questions.length, "question needs", "questions need")} your answer`,
      detail: `${entryTitle(questions[0]!)}${questions.length > 1 ? ` — and ${questions.length - 1} more` : ""}`,
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
    const left = snap.pausedUntil !== undefined && snap.pausedUntil > now ? humanSeconds(Math.round((snap.pausedUntil - now) / 1000)) : null;
    out.push({
      key: "paused",
      tone: "amber",
      title: left ? `The fleet is paused and resumes in ${left}` : "The fleet is paused",
      detail: "Loops start no new ticks. In-flight ticks finish, and the director still runs your prompts.",
      actions: [{ label: "Resume now", act: "resume" }],
    });
  }
  if (!snap.running) {
    out.push({
      key: "stopped",
      tone: "gray",
      title: "The fleet is not running",
      detail: "Start it with tumwater run in the project directory; the dashboards pick it up on their own.",
      actions: [{ label: "Copy the command", act: "copy", arg: "tumwater run" }],
    });
  }
  return out;
}

/** Does this alert ask something of the operator (red, amber, indigo), rather than inform? */
export function alertNeedsYou(alert: FleetAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
