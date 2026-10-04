/** The pieces of a TUI frame, pure so they test without a terminal: the
 * attention lines under the header (fleet-alerts.ts's fleetAlerts — the dashboard's alert banners,
 * one line each); the view tab strip; the per-view key hints; the prompt line's target; and
 * the tones of activity and transcript lines. The TUI shares the dashboard's vocabulary — the
 * same view names (Activity, Transcript, Backlog, Usage, Failures), the same alert wording,
 * the same status colors — drawn in the terminal's base colors, so they follow its theme. */
import type { HarnessEvent } from "../events.js";
import { clipSpans, type StatusLine, type StatusSpan } from "./status-render.js";
import { eventResult } from "../event-format.js";
import { eventKind, resultTone, type Tone } from "./tone.js";
import type { FleetAlert } from "./fleet-alerts.js";
import { displayWidth } from "../text-width.js";

/** A plain line clipped to the pane, in one tone. */
export function toneLine(text: string, width: number, tone?: StatusSpan["tone"]): StatusLine {
  return clipSpans([{ text, ...(tone ? { tone } : {}) }], width);
}

const ALERT_MARKS: Record<FleetAlert["tone"], { mark: string; tone: Tone | undefined }> = {
  red: { mark: "!", tone: "red" },
  amber: { mark: "!", tone: "yellow" },
  indigo: { mark: "?", tone: "magenta" },
  blue: { mark: "i", tone: "blue" },
  gray: { mark: "i", tone: "dim" },
};

/** The attention lines under the header: one per alert — its mark and title in its tone, then
 * the detail — at most `max` of them, the rest counted on a last line. */
export function alertLines(alerts: readonly FleetAlert[], width: number, max = 3): StatusLine[] {
  const shown = alerts.length > max ? alerts.slice(0, max - 1) : alerts;
  const lines = shown.map((a) => {
    const { mark, tone } = ALERT_MARKS[a.tone];
    const t = tone ? { tone } : {};
    return clipSpans([{ text: `${mark} `, ...t }, { text: a.title, ...t }, { text: a.detail ? ` — ${a.detail}` : "" }], width);
  });
  if (shown.length < alerts.length) lines.push(toneLine(`  +${alerts.length - shown.length} more — the dashboard lists them all`, width, "dim"));
  return lines;
}

/** Which pane the TUI shows: the activity feed, one loop's transcript, the backlog, the usage
 * report, or the failure digest — the dashboard's views, in the order Ctrl+T cycles them. */
export type TuiView =
  | { kind: "activity" }
  | { kind: "transcript"; role: string; index: number; count: number }
  | { kind: "backlog" }
  | { kind: "usage" }
  | { kind: "failures" };

/** The pane's tab strip: every view by name, the current one bracketed (and bright), so the
 * Ctrl+T cycle can be seen rather than remembered. */
export function tabStrip(view: TuiView, width: number): StatusLine {
  const tabs: Array<[TuiView["kind"], string]> = [
    ["activity", "Activity"],
    ["transcript", view.kind === "transcript" ? `Transcript: ${view.role} (${view.index}/${view.count})` : "Transcript"],
    ["backlog", "Backlog"],
    ["usage", "Usage"],
    ["failures", "Failures"],
  ];
  const spans: StatusSpan[] = [];
  tabs.forEach(([kind, label], i) => {
    if (i > 0) spans.push({ text: "  " });
    spans.push(kind === view.kind ? { text: `[${label}]`, tone: "brand" } : { text: label, tone: "dim" });
  });
  spans.push({ text: "   Ctrl+T next", tone: "dim" });
  return clipSpans(spans, width);
}

/** The footer's key hints for what the keys do right now: keys bright, words dim. */
export function hintLine(view: TuiView, mode: { budget: boolean; rolePromptFor: string | null }, width: number): StatusLine {
  let keys: Array<[string, string]>;
  if (mode.budget) keys = [["Enter", "save the daily cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.rolePromptFor) keys = [["Enter", `send to ${mode.rolePromptFor}`], ["↑↓", "history"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (view.kind === "transcript") {
    keys = [["Enter", "send"], ["↑↓", "history"], ["Ctrl+R", `prompt ${view.role}`], ["Ctrl+P", "pause/resume"], ["Ctrl+W", "wake"], ["Ctrl+A", "abort"],
      ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  } else if (view.kind === "backlog") keys = [["Enter", "send"], ["↑↓", "open entries"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "usage" || view.kind === "failures") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else keys = [["Enter", "send"], ["↑↓", "history"], ["Ctrl+T", "next view"], ["Ctrl+B", "daily cap"], ["Ctrl+C", "interrupt director"], ["Ctrl+D", "quit"]];
  const spans: StatusSpan[] = [];
  keys.forEach(([key, what], i) => {
    if (i > 0) spans.push({ text: " · ", tone: "dim" });
    spans.push({ text: key, tone: "bold" }, { text: ` ${what}`, tone: "dim" });
  });
  return clipSpans(spans, width);
}

/** The prompt line's target, like the dashboard composer's: who Enter sends to. */
export function promptPrefix(mode: { budget: boolean; rolePromptFor: string | null }): StatusSpan[] {
  if (mode.budget) return [{ text: "daily cap $", tone: "brand" }, { text: " " }];
  return [{ text: mode.rolePromptFor ?? "director", tone: "brand" }, { text: " › " }];
}

/** The prefix's width in terminal columns, for sizing the input beside it. */
export function prefixWidth(prefix: readonly StatusSpan[]): number {
  return displayWidth(prefix.map((sp) => sp.text).join(""));
}

/** An activity line's tone, by the event's kind (tone.ts's eventKind — the dashboard's
 * activity card uses the same rule): landings green, problems in their outcome's color,
 * questions magenta, routine bookkeeping dim. */
export function eventTone(e: HarnessEvent): Tone | undefined {
  const result = eventResult(e);
  const kind = eventKind(e.type, result);
  if (kind === "landing") return "green";
  if (kind === "attention") return "magenta";
  if (kind === "problem") return (e.type === "tick_end" ? resultTone(result) : undefined) ?? "red";
  if (kind === "routine") return "dim";
  return undefined;
}

/** A transcript line's tone, by the line kinds transcript.ts renders: run separators, tool
 * calls, thinking, and retry warnings stand apart from the assistant's text. */
export function transcriptTone(line: string): StatusSpan["tone"] {
  if (line.startsWith("── ")) return "bold";
  if (line.startsWith("→ ")) return "cyan";
  if (line.startsWith("· ")) return "dim";
  if (line.startsWith("⚠ ")) return "yellow";
  return undefined;
}
