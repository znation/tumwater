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
 * This is what closes the same gap say() closes for the CLI: model-written text (run
 * summaries, lastError, backlog/QUESTION titles, transcript turns) reaches the terminal
 * through teamAlerts, renderStatusSpans, and paneBody, not through say(), so sanitizing the
 * final spans — rather than each producer — covers every current and future line builder. */
export function sanitizeFrameLines(lines: readonly StatusLine[]): StatusLine[] {
  return lines.map((line) => line.map((span) => ({ ...span, text: stripTerminalControls(span.text) })));
}


/** Which pane the TUI shows: the activity feed, one role's transcript, the backlog, the usage
 * report, the failure digest, the completed-run history, the pending-change roster, or the
 * queued prompts — the dashboard's views, in the order Ctrl+T cycles them. */
export type TuiView =
  | { kind: "activity"; role: string | null; grep: string | null; type: string | null; notable?: boolean }
  | { kind: "transcript"; role: string; index: number; count: number; note: boolean; change: boolean; changeStat?: boolean; grep?: string | null }
  | { kind: "backlog" }
  | { kind: "usage"; scope: string | null; window: string | null }
  | { kind: "failures"; scope: string | null; window: string | null }
  | { kind: "history"; since: string | null; result: string | null; model?: string | null; role: string | null; grep: string | null; trail: boolean; trailTranscript?: "off" | "plain" | "prompts"; trailPatch?: boolean; trailGrep?: string | null; summary?: "role" | "model" | null }
  | { kind: "pending" }
  | { kind: "queued"; grep?: string | null }
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

/** The live editor state that shapes the footer's key hints (hintLine) and the prompt line's
 * destination prefix (promptPrefix), drawn from one constructed `mode` object in tui.tsx:
 * `budget` and `rolePromptFor` are always present; one `*Mode` boolean arms each editor and the
 * `*For`/role/pause/entry fields name what the active editor acts on. */
interface TuiMode {
  budget: boolean;
  rolePromptFor: string | null;
  attachMode?: boolean;
  pauseEditMode?: boolean;
  pauseEditRole?: string | null;
  pauseEditWake?: boolean;
  pauseEditStop?: boolean;
  queuedEditFor: { role: string; file: string } | null;
  answerFor: { position: number; title: string } | null;
  entryEditFor?: { kind: "plan" | "bug"; position: number | null; title: string } | null;
  notesEditFor?: string | null;
  briefEditMode?: boolean;
  images?: number;
  retireMode?: boolean;
  releaseMode?: boolean;
  roleEnabledMode?: boolean;
  quietMode?: boolean;
  quietTeam?: boolean;
  intervalMode?: boolean;
  roleModelMode?: boolean;
  fallbackMode?: boolean;
  instructionsEditFor?: string | null;
  concurrencyMode?: boolean;
  slotsMode?: boolean;
  notifyMode?: boolean;
  backendsMode?: boolean;
  modelMode?: boolean;
  instancesMode?: boolean;
  checksMode?: boolean;
  checkMode?: boolean;
}

/** The footer's key hints for what the keys do right now: keys bright, words dim. Which
 * keys each editor offers is one table read (modeKeyHints), and which keys each pane offers is
 * another (viewKeyHints); this function only looks those up, then spreads the chosen keys into
 * the span line and clips it to the width. */
export function hintLine(view: TuiView, mode: TuiMode, width: number): StatusLine {
  const keys = modeKeyHints(mode) ?? viewKeyHints(view);
  // The mode branches above name their own keys and keep the line, so every remaining
  // view hint always shows the send affordance. This comment marks that ordering.
  const spans: StatusSpan[] = [];
  keys.forEach(([key, what], i) => {
    if (i > 0) spans.push({ text: " · ", tone: "dim" });
    spans.push({ text: key, tone: "bold" }, { text: ` ${what}`, tone: "dim" });
  });
  return clipSpans(spans, width);
}

/** The ordered table that owns footer key-hint precedence among editors: each row's first
 * element is one editor/mode arm and the second the keys it shows; the first truthy row wins,
 * so "which keys does this editor offer?" is one read of the table's order. The order is the
 * old `if (mode.…)` chain, from the new-entry editor to the brief editor. Returns undefined
 * when no editor is active, so the caller falls through to the view table. */
function modeKeyHints(mode: TuiMode): Array<[string, string]> | undefined {
  // The object-armed rows below dereference their target (entry/answer/queued), so each
  // captures the value and guards its keys against the null case — the array is built eagerly
  // for every row, but only ever returned when its row's flag is truthy.
  const entry = mode.entryEditFor;
  const answer = mode.answerFor;
  const queued = mode.queuedEditFor;
  const rows: Array<[unknown, Array<[string, string]>]> = [
    [entry?.position === null, entry ? [["Enter", `file ${entry.kind}`], ["Ctrl+N", `switch to ${entry.kind === "plan" ? "bug" : "plan"}`], ["Esc", "cancel"], ["Ctrl+D", "quit"]] : []],
    [entry, entry ? [["Enter", "save title"], ["Ctrl+E", "body file"], ["Esc", "cancel"], ["Ctrl+D", "quit"]] : []],
    [answer, answer ? [["Enter", "record answer"], ["Esc", "cancel"], ["Ctrl+D", "quit"]] : []],
    [queued, queued ? [["Enter", "save the edit"], ["Esc", "cancel"], ["Ctrl+D", "quit"]] : []],
    [mode.pauseEditMode && mode.pauseEditStop, [["Enter", "schedule stop"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.pauseEditMode, [["Enter", mode.pauseEditRole ? `${mode.pauseEditWake ? "wake" : "pause"} ${mode.pauseEditRole}` : "pause"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.attachMode, [["Enter", "attach image path"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.notesEditFor, [["Enter", "replace notes from file"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.retireMode, [["Enter", "retire role"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.releaseMode, [["Enter", "release test"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.roleEnabledMode, [["Enter", "enable/disable role"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.budget, [["Enter", "save the daily cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.concurrencyMode, [["Enter", "save the run cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.checksMode, [["Enter", "save the check cap"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.checkMode, [["Enter", "save the declared check"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.modelMode, [["Enter", "save the model"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.quietMode, [["Enter", mode.quietTeam ? "save team quiet hours" : "save quiet hours"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.intervalMode, [["Enter", "save interval"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.roleModelMode, [["Enter", "save model overrides"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.instancesMode, [["Enter", "save instances"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.notifyMode, [["Enter", "save the notify hook"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.fallbackMode, [["Enter", "save the fallback"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.instructionsEditFor, [["Enter", "save instructions"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.slotsMode, [["Enter", "save worktree slots"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.backendsMode, [["Enter", "save agent backends"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.rolePromptFor, [["Enter", `send to ${mode.rolePromptFor}`], ["↑↓", "history"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
    [mode.briefEditMode, [["Enter", "replace brief from file"], ["Esc", "cancel"], ["Ctrl+D", "quit"]]],
  ];
  for (const [active, keys] of rows) if (active) return keys;
  return undefined;
}

/** The ordered table that owns footer key-hint precedence among panes: each row's first element
 * is one view predicate and the second the keys that pane shows; the first truthy row wins, so
 * "which keys does this pane offer?" is one read of the table's order. The order is the old
 * `else if (view.kind === …)` chain, from transcript to the default activity row. */
function viewKeyHints(view: TuiView): Array<[string, string]> {
  // Each row's second element is guarded by the same predicate as its first so the viewer is
  // narrowed to that pane's variant when the keys are built (the array is eager), mirroring
  // the object-armed rows in modeKeyHints.
  const rows: Array<[boolean, Array<[string, string]>]> = [
    [view.kind === "transcript", view.kind === "transcript" ? transcriptKeyHints(view) : []],
    [view.kind === "backlog", backlogKeyHints()],
    [view.kind === "usage" || view.kind === "failures", (view.kind === "usage" || view.kind === "failures") ? usageKeyHints(view) : []],
    [view.kind === "history", view.kind === "history" ? historyKeyHints(view) : []],
    [view.kind === "pending", pendingKeyHints()],
    [view.kind === "health", view.kind === "health" ? healthKeyHints(view) : []],
    [view.kind === "brief", briefKeyHints()],
    [view.kind === "queued", view.kind === "queued" ? queuedKeyHints(view) : []],
    [true, activityKeyHints(view)],
  ];
  for (const [active, keys] of rows) if (active) return keys;
  return activityKeyHints(view);
}

/** The transcript pane's keys: the send/history affordance, the per-role prompt, and the
 * toggles and editors that act on the open transcript or change. */
function transcriptKeyHints(view: Extract<TuiView, { kind: "transcript" }>): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "history"], ["Ctrl+R", `prompt ${view.role}`], ["Ctrl+N", view.note ? "change" : view.change ? "transcript" : "notes"], ...(view.change ? [["Ctrl+Y", view.changeStat ? "full patch" : "stat only"] as [string, string]] : []), ...(view.note ? [["Ctrl+X", "clear notes"] as [string, string], ["Ctrl+E", "edit notes"] as [string, string]] : [["Ctrl+X", "model overrides"] as [string, string]]), ["Ctrl+P", "pause/resume"], ["Ctrl+W", "wake"], ["Ctrl+A", "stop run"], ["Ctrl+V", "reset counters"], ["Ctrl+B", "daily cap"], ["Ctrl+O", "quiet hours"], ["Ctrl+G", "instances"], ["Ctrl+S", "min run interval"], ["Ctrl+L", "instructions"],
      ...(!view.note && !view.change ? [["/", view.grep ? `search: ${view.grep}` : "search"] as [string, string]] : []),
      ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The backlog pane's keys: entry selection, search, and the per-entry actions. */
function backlogKeyHints(): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "open entries"], ["/", "search entries"], ["Ctrl+O", "ready only"], ["Ctrl+X", "cancel entry"], ["Ctrl+R", "release entry"], ["Ctrl+V", "top entry"], ["Ctrl+E", "edit entry"], ["Ctrl+N", "new plan/bug"], ["Ctrl+A", "answer question"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The usage/failures pane's keys: the history navigation, scope and window, and the failure
 * digest's release affordance. */
function usageKeyHints(view: Extract<TuiView, { kind: "usage" | "failures" }>): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", view.scope ? `scope: ${view.scope}` : "scope: team"], ["Ctrl+E", view.window ? `window: ${view.window}` : "window: default"], ...(view.window ? [["Ctrl+P", "earlier window"] as [string, string]] : []), ...(view.kind === "failures" ? [["Ctrl+X", "release test"] as [string, string]] : []), ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The completed-run history pane's keys: outcome filters, the run trail's navigation, and
 * the search pair delegated to historySearchHint so this table stays under the threshold. */
function historyKeyHints(view: Extract<TuiView, { kind: "history" }>): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "history"], ["Ctrl+L", "newest failure"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", view.role ? `scope: ${view.role}` : "scope: team"], ["Ctrl+S", view.since ? `window: ${view.since}` : "window: default"], ...(!view.trail && view.since ? [["Ctrl+P", "earlier window"] as [string, string]] : []), ["Ctrl+O", view.result ? `result: ${view.result}` : "result: all"], ["Ctrl+X", view.model ? `model: ${view.model}` : "model: all"], ["Ctrl+Y", view.summary === "model" ? "rows" : view.summary === "role" ? "by model" : "summary"], ["Ctrl+N", view.trail ? "history" : "run trail"], ...(view.trail ? [["Ctrl+P", "older run"] as [string, string], ["Ctrl+R", view.trailTranscript === "plain" ? "prompts" : view.trailTranscript === "prompts" ? "hide transcript" : "transcript"] as [string, string], ["Ctrl+W", view.trailPatch ? "hide patch" : "patch"] as [string, string], ["Ctrl+V", "revert run"] as [string, string]] : []), historySearchHint(view), ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The history pane's trailing search pair: `/[search]` naming what the forward slash searches,
 * the transcript search while a run trail is open and its transcript is readable, else the
 * plain entry search. Kept as its own helper so the history table stays under the threshold. */
function historySearchHint(view: Extract<TuiView, { kind: "history" }>): [string, string] {
  return ["/", view.trail && view.trailTranscript !== undefined && view.trailTranscript !== "off" ? (view.trailGrep ? `transcript search: ${view.trailGrep}` : "search transcript") : (view.grep ? `search: ${view.grep}` : "search")];
}

/** The pending-change roster's keys: merge/review selection and the review actions. */
function pendingKeyHints(): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "select merge/review"], ["PgUp/PgDn", "scroll"], ["Ctrl+R", "refresh"], ["Ctrl+N", "overlaps"], ["Ctrl+G", "overlap role"], ["Ctrl+O", "review state"], ["Ctrl+X", "cancel merge"], ["Ctrl+V", "move to top"], ["Ctrl+A", "accept review"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The health pane's keys: the checks, install, and backlog maintenance actions. */
function healthKeyHints(view: Extract<TuiView, { kind: "health" }>): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+O", view.problems ? "problems only" : "all checks"], ["Ctrl+R", "re-run checks"], ["Ctrl+A", "commit backlog"], ["Ctrl+U", "re-sync install"], ["Ctrl+E", "reclaim disk"], ["Ctrl+N", "test notify"], ["Ctrl+K", "kill orphans"], ["Ctrl+S", "drop broken pins"], ["Ctrl+X", "retire role"], ["Ctrl+L", "retire leftovers"], ["Ctrl+B", "archive backlog"], ["Ctrl+V", "enable/disable role"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The brief pane's keys: the send affordance and the brief editor. */
function briefKeyHints(): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+E", "edit brief"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The queued-prompt pane's keys: the queue navigation, the edit/cancel actions, and search. */
function queuedKeyHints(view: Extract<TuiView, { kind: "queued" }>): Array<[string, string]> {
  return [["Enter", "send"], ["↑↓", "history"], ["Ctrl+V", "top"], ["Ctrl+E", "edit"], ["Ctrl+X", "cancel"], ["/", view.grep ? `search: ${view.grep}` : "search"], ["PgUp/PgDn", "scroll"], ["Ctrl+T", "next view"], ["Ctrl+D", "quit"]];
}

/** The default activity pane's keys (the old `else` arm): the run controls, the scope/type
 * filters, search, and the team-wide actions every other pane's hints sit on top of. */
function activityKeyHints(view: TuiView): Array<[string, string]> {
  // notable/type exist only on the activity view, so each access is narrowed by kind before
  // use — the array is built eagerly for the table's last (always-matching) row, but the
  // default activity arm is the only caller that reads these fields.
  const activity = view.kind === "activity";
  return [["Enter", "send"], ["↑↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+B", "daily cap"], ["Ctrl+E", "notify hook"], ["Ctrl+A", "model"], ["Ctrl+N", "run cap"], ["Ctrl+K", "check cap"], ["Ctrl+U", "declared check"], ["Ctrl+S", "quiet hours"], ["Ctrl+W", "worktree slots"], ["Ctrl+O", activity && view.notable ? "notable only" : activity && view.type ? `type: ${eventTypeLabel(view.type)}` : "type: all"], ["Ctrl+G", activity && view.role ? `scope: ${view.role}` : "scope: team"], ["/", activity && view.grep ? `search: ${view.grep}` : "search"], ["Ctrl+X", "agent backends"], ["Ctrl+T", "next view"], ["Ctrl+L", "fallback"], ["Ctrl+F", "pause team"], ["Ctrl+Q", "stop later"], ["Ctrl+C", "interrupt director"], ["Ctrl+V", "attach image"], ["Ctrl+R", "restart"], ["Ctrl+D", "quit"]];
}

/** The brand-tone label pair that names the prompting target on the prompt line, with the
 * ` › ` separator nearly every editor arm uses — the budget arm is the lone exception, its
 * trailing space keeping the input in the cap field's own line. */
function labeledPrefix(label: string): StatusSpan[] {
  return [{ text: label, tone: "brand" }, { text: " › " }];
}

/** The ordered label table that owns prompt-line prefix precedence: each row's first element is
 * one editor/mode arm and the second the prefix it shows; the first truthy row wins, so "which
 * editor owns the prefix, and if two flags are set which one?" is one read of the table's
 * order. The order is the old `if (mode.…)` chain, from the daily-cap editor to the pause
 * editor. */
function editorPromptPrefix(mode: TuiMode): StatusSpan[] | undefined {
  // The three object-armed rows below dereference their target (entry/answer/queued), so each
  // captures the value and guards its label against the null case — the label is built eagerly
  // for every row, but only ever returned when its row's flag is truthy.
  const entry = mode.entryEditFor;
  const answer = mode.answerFor;
  const queued = mode.queuedEditFor;
  const prompts: Array<[unknown, StatusSpan[]]> = [
    [mode.budget, [{ text: "daily cap $", tone: "brand" }, { text: " " }]],
    [mode.concurrencyMode, labeledPrefix("run cap")],
    [mode.checksMode, labeledPrefix("check cap")],
    [mode.checkMode, labeledPrefix("declared check")],
    [mode.modelMode, labeledPrefix("model")],
    [mode.quietMode, labeledPrefix(mode.quietTeam ? "team quiet hours" : "quiet hours")],
    [mode.slotsMode, labeledPrefix("worktree slots")],
    [mode.backendsMode, labeledPrefix("agent backends")],
    [mode.intervalMode, labeledPrefix("min run interval")],
    [mode.roleModelMode, labeledPrefix("model overrides")],
    [mode.instancesMode, labeledPrefix("instances")],
    [mode.notifyMode, labeledPrefix("notify hook")],
    [mode.fallbackMode, labeledPrefix("fallback")],
    [mode.instructionsEditFor, labeledPrefix(`instructions for ${mode.instructionsEditFor}`)],
    [mode.briefEditMode, labeledPrefix("brief")],
    [mode.retireMode, labeledPrefix("retire")],
    [mode.releaseMode, labeledPrefix("release")],
    [mode.roleEnabledMode, labeledPrefix("role state")],
    [mode.notesEditFor, labeledPrefix(`notes for ${mode.notesEditFor}`)],
    [entry, entry ? labeledPrefix(entry.position === null ? `new ${entry.kind}` : `edit ${entry.kind} #${entry.position}`) : []],
    [answer, answer ? labeledPrefix(`answer #${answer.position}`) : []],
    [queued, queued ? labeledPrefix(`edit ${queued.role}`) : []],
    [mode.pauseEditMode && mode.pauseEditStop, labeledPrefix("stop in")],
    [mode.pauseEditMode, labeledPrefix(mode.pauseEditRole ? `${mode.pauseEditWake ? "wake" : "pause"} ${mode.pauseEditRole}` : "pause")],
  ];
  for (const [active, spans] of prompts) if (active) return spans;
  return undefined;
}

/** The prompt line's target, like the dashboard composer's: who Enter sends to, read from the
 * ordered label table in editorPromptPrefix and falling back to the director/role target (with
 * its image count) when no editor owns the prefix. */
export function promptPrefix(mode: TuiMode): StatusSpan[] {
  const prefix = editorPromptPrefix(mode);
  if (prefix) return prefix;
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
