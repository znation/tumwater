/** The pieces of a TUI frame, pure so they test without a terminal: the attention lines under the
 * header (fleet-alerts.ts's fleetAlerts — the dashboard's alert banners, one line each); the view
 * tab strip; the per-view key hints; the prompt line's target; and the tones of activity and
 * transcript lines. The TUI shares the dashboard's vocabulary — the same view names (Activity,
 * Transcript, Backlog, Usage, Failures, History, Pending), the same alert wording, the same
 * status colors — drawn in the terminal's base colors, so they follow its theme. */
import type { HarnessEvent } from "../../events/events.js";
import { clipSpans, type StatusLine, type StatusSpan } from "../status-render.js";
import { eventResult } from "../../events/event-format.js";
import { eventKind, resultTone, type Tone } from "../tone.js";
import type { FleetAlert } from "../fleet-alerts.js";
import { displayWidth } from "../../text/text-width.js";
import { stripTerminalControls } from "../../text/text.js";

/** A plain line clipped to the pane, in one tone. */
export function toneLine(text: string, width: number, tone?: StatusSpan["tone"]): StatusLine {
  return clipSpans([{ text, ...(tone ? { tone } : {}) }], width);
}

/** Strip terminal control characters from every span of a composed frame — the TUI's single
 * terminal boundary, applied in tui.tsx to the whole line list (status table, attention
 * lines, queued-prompt previews, the pane body, flash/hint/input) just before ink draws it.
 * This is what closes the same gap say() closes for the CLI: model-written text (tick
 * summaries, lastError, backlog/QUESTION titles, transcript turns) reaches the terminal
 * through fleetAlerts, renderStatusSpans, and paneBody, not through say(), so sanitizing the
 * final spans — rather than each producer — covers every current and future line builder. */
export function sanitizeFrameLines(lines: readonly StatusLine[]): StatusLine[] {
  return lines.map((line) => line.map((span) => ({ ...span, text: stripTerminalControls(span.text) })));
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
 * report, the failure digest, the completed-tick history, the pending-change roster, or the
 * queued prompts — the dashboard's views, in the order Ctrl+T cycles them. */
export type TuiView =
  | { kind: "activity"; role: string | null; grep: string | null }
  | { kind: "transcript"; role: string; index: number; count: number; note: boolean; change: boolean }
  | { kind: "backlog" }
  | { kind: "usage"; scope: string | null; window: string | null }
  | { kind: "failures"; scope: string | null; window: string | null }
  | { kind: "history"; since: string | null; result: string | null; role: string | null; grep: string | null; trail: boolean }
  | { kind: "pending" }
  | { kind: "queued" };

/** The pane's tab strip: every view by name, the current one bracketed (and bright), so the
 * Ctrl+T cycle can be seen rather than remembered. */
export function tabStrip(view: TuiView, width: number): StatusLine {
  const tabs: Array<[TuiView["kind"], string]> = [
    ["activity", view.kind === "activity" && view.role ? `Activity: ${view.role}` : "Activity"],
    ["transcript", view.kind === "transcript" ? `${view.note ? "Notebook" : view.change ? "Change" : "Transcript"}: ${view.role} (${view.index}/${view.count})` : "Transcript"],
    ["backlog", "Backlog"],
    ["usage", view.kind === "usage" && view.scope ? `Usage: ${view.scope}` : "Usage"],
    ["failures", view.kind === "failures" && view.scope ? `Failures: ${view.scope}` : "Failures"],
    ["history", view.kind === "history" ? `${view.trail ? "Tick" : "History"}${view.role ? ": " + view.role : ""}` : "History"],
    ["pending", "Pending"],
    ["queued", "Queued"],
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
export function hintLine(view: TuiView, mode: { budget: boolean; rolePromptFor: string | null; deferMode: boolean; defer: string | null; queuedEditFor: { role: string; file: string } | null }, width: number): StatusLine {
  let keys: Array<[string, string]>;
  if (mode.queuedEditFor) keys = [["Enter", "save the edit"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.deferMode) keys = [["Enter", "save the delay"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.budget) keys = [["Enter", "save the daily cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.rolePromptFor) keys = [["Enter", `send to ${mode.rolePromptFor}`], ["↑↓", "history"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (view.kind === "transcript") {
    keys = [["Enter", "send"], ["↑↓", "history"], ["Ctrl+R", `prompt ${view.role}`], ["Ctrl+N", view.note ? "change" : view.change ? "transcript" : "notebook"], ["Ctrl+P", "pause/resume"], ["Ctrl+W", "wake"], ["Ctrl+A", "abort"],
      ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  } else if (view.kind === "backlog") keys = [["Enter", "send"], ["↑↓", "open entries"], ["Ctrl+X", "cancel entry"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "usage" || view.kind === "failures") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", view.scope ? `scope: ${view.scope}` : "scope: fleet"], ["Ctrl+E", view.window ? `window: ${view.window}` : "window: default"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "history") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: fleet"], ["Ctrl+S", view.since ? `window: ${view.since}` : "window: default"], ["Ctrl+O", view.result ? `result: ${view.result}` : "result: all"], ["Ctrl+N", view.trail ? "history" : "tick trail"], ["/", view.grep ? `search: ${view.grep}` : "search"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "pending") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "queued") keys = [["Enter", "send"], ["↑↓", "history"], ["Ctrl+E", "edit"], ["Ctrl+X", "cancel"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+B", "daily cap"], ["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: fleet"], ["/", view.grep ? `search: ${view.grep}` : "search"], ["Ctrl+T", "next view"], ["Ctrl+F", "pause fleet"], ["Ctrl+C", "interrupt director"], ["Ctrl+D", "quit"]];
  // The defer editor is the prompt line's fourth meta-editor (after budget, role, and
  // search), so every view whose hint is about sending names its state: the pending delay
  // when one is set, otherwise the way to open it. The mode branches above already name
  // their own keys and keep the line, so this only rides the view hints.
  if (!mode.deferMode && !mode.budget && !mode.rolePromptFor && !mode.queuedEditFor)
    keys.push(["Ctrl+L", mode.defer ? `defer: ${mode.defer}` : "defer"]);
  const spans: StatusSpan[] = [];
  keys.forEach(([key, what], i) => {
    if (i > 0) spans.push({ text: " · ", tone: "dim" });
    spans.push({ text: key, tone: "bold" }, { text: ` ${what}`, tone: "dim" });
  });
  return clipSpans(spans, width);
}

/** The prompt line's target, like the dashboard composer's: who Enter sends to. */
export function promptPrefix(mode: { budget: boolean; rolePromptFor: string | null; deferMode: boolean; defer: string | null; queuedEditFor: { role: string; file: string } | null }): StatusSpan[] {
  if (mode.budget) return [{ text: "daily cap $", tone: "brand" }, { text: " " }];
  if (mode.queuedEditFor) return [{ text: `edit ${mode.queuedEditFor.role}`, tone: "brand" }, { text: " › " }];
  if (mode.deferMode) return [{ text: "defer", tone: "brand" }, { text: " › " }];
  // A pending delay is named beside the target (e.g. `director (defer 45m) › `), so the
  // operator sees what the next Enter will schedule before pressing it.
  const target = mode.defer ? `${mode.rolePromptFor ?? "director"} (defer ${mode.defer})` : (mode.rolePromptFor ?? "director");
  return [{ text: target, tone: "brand" }, { text: " › " }];
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
