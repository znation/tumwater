// vocabulary: plain
/** The pieces of a TUI frame, pure so they test without a terminal: the attention lines under the
 * header (team-alerts.ts's teamAlerts — the dashboard's alert banners, one line each); the view
 * tab strip; the per-view key hints; the prompt line's target; and the tones of activity and
 * transcript lines. The TUI shares the dashboard's vocabulary — the same view names (Activity,
 * Transcript, Backlog, Usage, Failures, History, Pending), the same alert wording, the same
 * status colors — drawn in the terminal's base colors, so they follow its theme. */
import type { HarnessEvent } from "../../events/events.js";
import { alertLines, clipSpans, toneLine, type StatusLine, type StatusSpan } from "../status-render.js";
// Re-export the attention-banner helpers so the TUI's consumers (tui.tsx, tui-pane.ts, and
// the tui-frame tests) keep importing them from this module; their definitions now live with
// the other shared status renderers and the `tumwater status` banner block.
export { alertLines, toneLine };
import { eventResult } from "../../events/event-format.js";
import { eventTypeLabel } from "../../events/event-labels.js";
import { eventKind, resultTone, type Tone } from "../tone.js";
import { roleLabel } from "../../roles/role-labels.js";
import { displayWidth } from "../../text/text-width.js";
import { plural } from "../../text/phrases.js";
import { stripTerminalControls } from "../../text/text.js";

/** Strip terminal control characters from every span of a composed frame — the TUI's single
 * terminal boundary, applied in tui.tsx to the whole line list (status table, attention
 * lines, queued-prompt previews, the pane body, flash/hint/input) just before ink draws it.
 * This is what closes the same gap say() closes for the CLI: model-written text (tick
 * summaries, lastError, backlog/QUESTION titles, transcript turns) reaches the terminal
 * through teamAlerts, renderStatusSpans, and paneBody, not through say(), so sanitizing the
 * final spans — rather than each producer — covers every current and future line builder. */
export function sanitizeFrameLines(lines: readonly StatusLine[]): StatusLine[] {
  return lines.map((line) => line.map((span) => ({ ...span, text: stripTerminalControls(span.text) })));
}


/** Which pane the TUI shows: the activity feed, one loop's transcript, the backlog, the usage
 * report, the failure digest, the completed-tick history, the pending-change roster, or the
 * queued prompts — the dashboard's views, in the order Ctrl+T cycles them. */
export type TuiView =
  | { kind: "activity"; role: string | null; grep: string | null; type: string | null }
  | { kind: "transcript"; role: string; index: number; count: number; note: boolean; change: boolean }
  | { kind: "backlog" }
  | { kind: "usage"; scope: string | null; window: string | null }
  | { kind: "failures"; scope: string | null; window: string | null }
  | { kind: "history"; since: string | null; result: string | null; role: string | null; grep: string | null; trail: boolean; summary?: boolean }
  | { kind: "pending" }
  | { kind: "queued" }
  | { kind: "health"; problems?: boolean }
  | { kind: "brief" };

/** The pane's tab strip: every view by name, the current one bracketed (and bright), so the
 * Ctrl+T cycle can be seen rather than remembered. */
export function tabStrip(view: TuiView, width: number): StatusLine {
  const tabs: Array<[TuiView["kind"], string]> = [
    ["activity", view.kind === "activity" && view.role ? `Activity: ${roleLabel(view.role)}` : "Activity"],
    ["transcript", view.kind === "transcript" ? `${view.note ? "Notes" : view.change ? "Change" : "Transcript"}: ${roleLabel(view.role)} (${view.index}/${view.count})` : "Transcript"],
    ["backlog", "Backlog"],
    ["usage", view.kind === "usage" && view.scope ? `Usage: ${view.scope}` : "Usage"],
    ["failures", view.kind === "failures" && view.scope ? `Failures: ${view.scope}` : "Failures"],
    ["history", view.kind === "history" ? `${view.trail ? "Run" : "History"}${view.role ? ": " + roleLabel(view.role) : ""}` : "History"],
    ["pending", "Pending"],
    ["queued", "Inbox"],
    ["health", "Health"],
    ["brief", "Brief"],
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
export function hintLine(view: TuiView, mode: { budget: boolean; rolePromptFor: string | null; attachMode?: boolean; pauseEditMode?: boolean; pauseEditRole?: string | null; pauseEditWake?: boolean; pauseEditStop?: boolean; queuedEditFor: { role: string; file: string } | null; answerFor: { position: number; title: string } | null; entryEditFor?: { kind: "plan" | "bug"; position: number | null; title: string } | null; notesEditFor?: string | null; briefEditMode?: boolean; images?: number; retireMode?: boolean; quietMode?: boolean; intervalMode?: boolean; instructionsEditFor?: string | null }, width: number): StatusLine {
  let keys: Array<[string, string]>;
  if (mode.entryEditFor?.position === null) keys = [["Enter", `file ${mode.entryEditFor.kind}`], ["Ctrl+N", `switch to ${mode.entryEditFor.kind === "plan" ? "bug" : "plan"}`], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.entryEditFor) keys = [["Enter", "save title"], ["Ctrl+E", "body file"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.answerFor) keys = [["Enter", "record answer"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.queuedEditFor) keys = [["Enter", "save the edit"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.pauseEditMode && mode.pauseEditStop) keys = [["Enter", "schedule stop"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.pauseEditMode) keys = [["Enter", mode.pauseEditRole ? `${mode.pauseEditWake ? "wake" : "pause"} ${mode.pauseEditRole}` : "pause"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.attachMode) keys = [["Enter", "attach image path"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.notesEditFor) keys = [["Enter", "replace notes from file"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.retireMode) keys = [["Enter", "retire role"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.budget) keys = [["Enter", "save the daily cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.quietMode) keys = [["Enter", "save quiet hours"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.intervalMode) keys = [["Enter", "save interval"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.instructionsEditFor) keys = [["Enter", "save instructions"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.rolePromptFor) keys = [["Enter", `send to ${mode.rolePromptFor}`], ["↑↓", "history"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (mode.briefEditMode) keys = [["Enter", "replace brief from file"], ["Esc", "cancel"], ["Ctrl+D", "quit"]];
  else if (view.kind === "transcript") {
    keys = [["Enter", "send"], ["↑↓", "history"], ["Ctrl+R", `prompt ${view.role}`], ["Ctrl+N", view.note ? "change" : view.change ? "transcript" : "notes"], ...(view.note ? [["Ctrl+X", "clear notes"] as [string, string], ["Ctrl+E", "edit notes"] as [string, string]] : []), ["Ctrl+P", "pause/resume"], ["Ctrl+W", "wake"], ["Ctrl+A", "stop run"], ["Ctrl+V", "reset counters"], ["Ctrl+B", "daily cap"], ["Ctrl+O", "quiet hours"],
      ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  } else if (view.kind === "backlog") keys = [["Enter", "send"], ["↑↓", "open entries"], ["Ctrl+X", "cancel entry"], ["Ctrl+R", "release entry"], ["Ctrl+V", "top entry"], ["Ctrl+E", "edit entry"], ["Ctrl+N", "new plan/bug"], ["Ctrl+A", "answer question"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "usage" || view.kind === "failures") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", view.scope ? `scope: ${view.scope}` : "scope: team"], ["Ctrl+E", view.window ? `window: ${view.window}` : "window: default"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "history") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: team"], ["Ctrl+S", view.since ? `window: ${view.since}` : "window: default"], ["Ctrl+O", view.result ? `result: ${view.result}` : "result: all"], ["Ctrl+Y", view.summary ? "rows" : "summary"], ["Ctrl+N", view.trail ? "history" : "run trail"], ["/", view.grep ? `search: ${view.grep}` : "search"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "pending") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+R", "refresh"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "health") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+O", view.problems ? "problems only" : "all checks"], ["Ctrl+R", "re-run checks"], ["Ctrl+E", "reclaim disk"], ["Ctrl+N", "test notify"], ["Ctrl+X", "retire role"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "brief") keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+E", "edit brief"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else if (view.kind === "queued") keys = [["Enter", "send"], ["↑↓", "history"], ["Ctrl+V", "top"], ["Ctrl+E", "edit"], ["Ctrl+X", "cancel"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
  else keys = [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+B", "daily cap"], ["Ctrl+O", view.type ? `type: ${eventTypeLabel(view.type)}` : "type: all"], ["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: team"], ["/", view.grep ? `search: ${view.grep}` : "search"], ["Ctrl+T", "next view"], ["Ctrl+F", "pause team"], ["Ctrl+Q", "stop later"], ["Ctrl+C", "interrupt director"], ["Ctrl+V", "attach image"], ["Ctrl+R", "restart"], ["Ctrl+D", "quit"]];
  // The mode branches above name their own keys and keep the line, so every remaining
  // view hint always shows the send affordance. This comment marks that ordering.
  const spans: StatusSpan[] = [];
  keys.forEach(([key, what], i) => {
    if (i > 0) spans.push({ text: " · ", tone: "dim" });
    spans.push({ text: key, tone: "bold" }, { text: ` ${what}`, tone: "dim" });
  });
  return clipSpans(spans, width);
}

/** The prompt line's target, like the dashboard composer's: who Enter sends to. */
export function promptPrefix(mode: { budget: boolean; rolePromptFor: string | null; attachMode?: boolean; pauseEditMode?: boolean; pauseEditRole?: string | null; pauseEditWake?: boolean; pauseEditStop?: boolean; queuedEditFor: { role: string; file: string } | null; answerFor: { position: number; title: string } | null; entryEditFor?: { kind: "plan" | "bug"; position: number | null; title: string } | null; notesEditFor?: string | null; briefEditMode?: boolean; images?: number; retireMode?: boolean; quietMode?: boolean; intervalMode?: boolean; instructionsEditFor?: string | null }): StatusSpan[] {
  if (mode.budget) return [{ text: "daily cap $", tone: "brand" }, { text: " " }];
  if (mode.quietMode) return [{ text: "quiet hours", tone: "brand" }, { text: " › " }];
  if (mode.intervalMode) return [{ text: "min run interval", tone: "brand" }, { text: " › " }];
  if (mode.instructionsEditFor) return [{ text: `instructions for ${mode.instructionsEditFor}`, tone: "brand" }, { text: " › " }];
  if (mode.briefEditMode) return [{ text: "brief", tone: "brand" }, { text: " › " }];
  if (mode.retireMode) return [{ text: "retire", tone: "brand" }, { text: " › " }];
  if (mode.notesEditFor) return [{ text: `notes for ${mode.notesEditFor}`, tone: "brand" }, { text: " › " }];
  if (mode.entryEditFor) return [{ text: mode.entryEditFor.position === null ? `new ${mode.entryEditFor.kind}` : `edit ${mode.entryEditFor.kind} #${mode.entryEditFor.position}`, tone: "brand" }, { text: " › " }];
  if (mode.answerFor) return [{ text: `answer #${mode.answerFor.position}`, tone: "brand" }, { text: " › " }];
  if (mode.queuedEditFor) return [{ text: `edit ${mode.queuedEditFor.role}`, tone: "brand" }, { text: " › " }];
  if (mode.pauseEditMode && mode.pauseEditStop) return [{ text: "stop in", tone: "brand" }, { text: " › " }];
  if (mode.pauseEditMode) return [{ text: mode.pauseEditRole ? `${mode.pauseEditWake ? "wake" : "pause"} ${mode.pauseEditRole}` : "pause", tone: "brand" }, { text: " › " }];
  // The pending image count (e.g. `director (2 images) › `) is named beside the target, so
  // the user sees what the next Enter will send before pressing it. The image count names the
  // director prompt only: session.images ride into the next director submit (submitPrompt),
  // while a role prompt (submitRolePromptAndWake) passes images undefined, so the count must
  // not claim an attachment a role-targeted Enter won't send.
  const target = mode.rolePromptFor ?? "director";
  const withImages = mode.rolePromptFor === null && (mode.images ?? 0) > 0;
  const named = withImages ? `${target} (${plural(mode.images ?? 0, "image")})` : target;
  return [{ text: named, tone: "brand" }, { text: " › " }];
}

/** The prefix's width in terminal columns, for sizing the input beside it. */
export function prefixWidth(prefix: readonly StatusSpan[]): number {
  return displayWidth(prefix.map((sp) => sp.text).join(""));
}

/** An activity line's tone, by the event's kind (tone.ts's eventKind — the dashboard's
 * activity card uses the same rule): merges green, problems in their outcome's color,
 * questions magenta, routine bookkeeping dim. */
export function eventTone(e: HarnessEvent): Tone | undefined {
  const result = eventResult(e);
  const kind = eventKind(e.type, result);
  if (kind === "landing") return "green"; // vocabulary-ok: event kind code
  if (kind === "attention") return "magenta";
  if (kind === "problem") return (e.type === "run_end" ? resultTone(result) : undefined) ?? "red";
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
