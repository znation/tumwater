import readline from "node:readline";
import {
  type BacklogEntry,
  openBugEntries,
  openQuestionEntries,
  plannedPlanEntries,
} from "../backlog.js";
import { readEvents } from "../events.js";
import { formatEvent } from "./event-format.js";
import { submitPrompt } from "../inbox.js";
import { snapshot } from "./status.js";
import { clipToWidth, renderStatus } from "./status-render.js";
import { cutSplitsSurrogatePair } from "../text.js";
import { readTranscript } from "./transcript.js";

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** The key fields applyKey cares about (a structural subset of readline.Key, so tests can
 * pass plain objects without a TTY). */
interface KeyLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Apply one keypress to the prompt text (pure, so it is unit-testable without a TTY).
 * Printable characters insert at the cursor — including multi-character strings readline
 * delivers for IME-composed input, which advance the cursor by their full length; backspace
 * deletes before it, delete after it, and left/right move it. Control/meta combinations are
 * ignored. Returns the new state; an out-of-range cursor is clamped instead of corrupting
 * the edit. Backspace/delete remove a whole character: when the unit they would cut is one
 * half of a surrogate pair (an astral character such as emoji), both units go together so no
 * lone surrogate — which terminals render as garbage — is ever left behind (the same
 * surrogate-safe rule truncate in text.ts applies to display clipping). */
export function applyKey(
  text: string,
  cursor: number,
  str: string | undefined,
  key: KeyLike,
): { text: string; cursor: number } {
  const c = Math.max(0, Math.min(cursor, text.length));
  switch (key.name) {
    case "left":
      return { text, cursor: Math.max(0, c - 1) };
    case "right":
      return { text, cursor: Math.min(text.length, c + 1) };
    case "backspace":
      if (c === 0) return { text, cursor: 0 };
      // The character before the cursor is a surrogate pair [c-2, c-1]: delete both units.
      if (cutSplitsSurrogatePair(text, c - 1)) {
        return { text: text.slice(0, c - 2) + text.slice(c), cursor: c - 2 };
      }
      return { text: text.slice(0, c - 1) + text.slice(c), cursor: c - 1 };
    case "delete":
      if (c >= text.length) return { text, cursor: c };
      // The character at the cursor is a surrogate pair [c, c+1]: delete both units.
      if (cutSplitsSurrogatePair(text, c + 1)) {
        return { text: text.slice(0, c) + text.slice(c + 2), cursor: c };
      }
      return { text: text.slice(0, c) + text.slice(c + 1), cursor: c };
  }
  if (str && !key.ctrl && !key.meta && str >= " ") {
    // str can hold a whole composed string (IME input arrives as one keypress); the cursor
    // must land after ALL of it, not one unit in.
    return { text: text.slice(0, c) + str + text.slice(c), cursor: c + str.length };
  }
  return { text, cursor: c };
}

/** The visible slice of the prompt line for a terminal `width` columns: the whole text
 * when it fits, otherwise a window that keeps the cursor at (or near) the right edge so
 * mid-text edits stay visible. With the "> " prefix the rendered line never exceeds
 * `width` columns for width >= 4, preserving the one-logical-line-per-visual-line invariant.
 */
export function renderInputView(text: string, cursor: number, width: number): string {
  const room = Math.max(1, width - 3); // headroom for the "> " prefix and a leading ellipsis
  if (text.length <= room) return text;
  const start = Math.max(0, Math.min(cursor - (room - 1), text.length - room));
  return (start > 0 ? "…" : "") + text.slice(start, start + room);
}

/** The project-status body lines for the TUI: a `plans (N):` subheader with one line per plan,
 * an `open bugs (M):` subheader and one line per bug, then an `open questions (K):` subheader
 * and one line per question. An empty section renders `(none)` under its subheader; when all
 * three are empty the whole view is a single self-explanatory line.
 * Pure, so it is unit-testable without touching disk. */
export function backlogLines(plans: string[], bugs: string[], questions: string[]): string[] {
  if (plans.length === 0 && bugs.length === 0 && questions.length === 0)
    return ["(no planned features, open bugs, or open questions)"];
  const lines = [`plans (${plans.length}):`];
  lines.push(...(plans.length ? plans : ["(none)"]));
  lines.push(`open bugs (${bugs.length}):`);
  lines.push(...(bugs.length ? bugs : ["(none)"]));
  lines.push(`open questions (${questions.length}):`);
  lines.push(...(questions.length ? questions : ["(none)"]));
  return lines;
}

/** Move the project-status entry selection one step in `dir` across the flat entry list
 * (plans, then bugs, then questions), wrapping at both ends. A null cursor means "list mode":
 * the first down opens the first entry and the first up opens the last; with no entries there
 * is nothing to select (a stale selection clears too). Pure, so it is unit-testable without a
 * TTY — runTui feeds it the three sections' lengths. */
export function moveEntrySelection(
  count: number,
  selected: number | null,
  dir: "up" | "down",
): number | null {
  if (count <= 0) return null;
  if (selected === null) return dir === "down" ? 0 : count - 1;
  return dir === "down" ? (selected + 1) % count : (selected - 1 + count) % count;
}

/** The visible window of one backlog entry's body for the TUI pane: lines `offset` through
 * `offset + budget`, each clipped to `width`. At offset 0 this is today's head-keeping view —
 * a plan's goal comes first, like the list view. The offset is clamped at render time so a
 * terminal resize or a queued-prompt budget shrink cannot strand the window past either end.
 * Returns the clipped lines plus the body's total line count (so the caller can decide the
 * scroll affordance without re-splitting). An empty body (a bare heading) renders a single
 * self-explanatory placeholder and reports zero lines. Pure, so it is unit-testable without
 * a TTY. */
export function entryBodyWindow(
  body: string,
  offset: number,
  budget: number,
  width: number,
): { lines: string[]; total: number } {
  if (!body) return { lines: ["(no details for this entry)"], total: 0 };
  const all = body.split("\n");
  const start = Math.max(0, Math.min(offset, Math.max(0, all.length - budget)));
  return {
    lines: all.slice(start, start + Math.max(1, budget)).map((l) => clipToWidth(l, width)),
    total: all.length,
  };
}

/** Step the within-body scroll offset one page in `dir` (PgDn = "down", PgUp = "up"),
 * clamped to `[0, max(0, totalLines − budget)]`. A body that fits its budget has a single
 * window — every step is a no-op at the head. Pure, so it is unit-testable without a TTY. */
export function stepEntryScroll(
  offset: number,
  totalLines: number,
  budget: number,
  dir: "up" | "down",
): number {
  const maxOffset = Math.max(0, totalLines - budget);
  if (maxOffset === 0) return 0;
  const next = dir === "down" ? offset + budget : offset - budget;
  return Math.max(0, Math.min(maxOffset, next));
}

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tumwater tui needs an interactive terminal");
  }

  let input = "";
  let cursor = 0;
  let flash = "";
  let flashUntil = 0;
  // The activity pane cycles: 0 = recent events, then one transcript per loop, then project
  // status (planned features + open bugs + open questions) — Ctrl+T.
  let view = 0;
  // The project-status pane's entry selection (null = list mode): the flat index of the
  // entry shown in full — plans first, then bugs, then questions. Cleared on every Ctrl+T,
  // so cycling back into the view always starts at today's heading list.
  let selectedEntry: number | null = null;
  // The within-body scroll offset (line index of the window head, 0 = head) for the selected
  // entry's body — PgDn/PgUp in project-status entry mode. Reset whenever the selection
  // changes or clears, so every newly opened entry starts at its head.
  let entryScroll = 0;
  // The activity pane's current line budget, refreshed by every render so keypress handlers
  // can page within it without re-deriving the height math.
  let eventBudget = 0;
  let roleIds: string[] = [];

  // The project-status pane's flat entry list (plans, then bugs, then questions), read fresh —
  // shared by render and the keypress handlers so stale-selection clamping cannot drift.
  const flatEntries = (): Array<{ label: string } & BacklogEntry> => [
    ...plannedPlanEntries(root).map((e) => ({ label: "plan", ...e })),
    ...openBugEntries(root).map((e) => ({ label: "bug", ...e })),
    ...openQuestionEntries(root).map((e) => ({ label: "question", ...e })),
  ];

  // Every rendered line is clipped to the terminal width (clipToWidth), so one logical
  // line is always one visual line and the height budget below is exact — nothing wraps,
  // nothing scrolls the table off the top.

  const render = () => {
    const rows = process.stdout.rows ?? 40;
    const width = process.stdout.columns ?? 120;
    const snap = snapshot(root);
    roleIds = snap.loops.map((s) => s.role);
    view = Math.min(view, roleIds.length + 1); // clamp a stale index if roles changed
    const status = renderStatus(root, snap, width);
    const statusLines = status.split("\n").length;
    // A highlighted nudge above the activity pane while questions await a human answer —
    // a cheap signal that something needs a decision. It consumes one line of the budget.
    const hasQuestions = snap.questions > 0;
    // Numbered previews of prompts queued for the director, between the table and the
    // activity pane: what will run next, in execution order. Each line consumes exactly
    // one line of the budget, like the questions nudge above it.
    const queued = snap.inboxPrompts;
    eventBudget = Math.max(3, rows - statusLines - 6 - (hasQuestions ? 1 : 0) - queued.length);
    // The pane occupies the same slot as recent activity: one header line plus at most
    // eventBudget clipped lines, so the height-budget math is unchanged either way.
    let header: string;
    let body: string[];
    let emptyNote = "(no events yet)";
    const role = view > 0 && view <= roleIds.length ? roleIds[view - 1] : undefined; // defined: view is clamped above
    if (role) {
      header = `${BOLD}${clipToWidth(`transcript: ${role} — Ctrl+T to cycle`, width)}${RESET}`;
      body = readTranscript(root, role, eventBudget)
        .map((l) => clipToWidth(l, width))
        .slice(-eventBudget);
      emptyNote = "(no transcript yet)";
    } else if (view === roleIds.length + 1) {
      // Project status: planned features, open bugs, and open questions from
      // PLANS.md/BUGS.md/QUESTIONS.md, read fresh each render like events. Keeps the HEAD of
      // the list when it overflows — file order is newest-first, unlike events which keep the tail.
      const planEntries = plannedPlanEntries(root);
      const bugEntries = openBugEntries(root);
      const questionEntries = openQuestionEntries(root);
      if (selectedEntry === null) {
        header = `${BOLD}${clipToWidth("project status — Ctrl+T to cycle", width)}${RESET}`;
        body = backlogLines(
          planEntries.map((e) => e.title),
          bugEntries.map((e) => e.title),
          questionEntries.map((e) => e.title),
        )
          .map((l) => clipToWidth(l, width))
          .slice(0, eventBudget);
      } else {
        // Entry browsing: the selected entry's full body under a header naming its section
        // and title. A stale selection (an entry removed from the file since the last render)
        // clamps to the last remaining entry; with no entries at all it falls back to list mode.
        const flat = flatEntries();
        const sel = flat.length > 0 ? Math.min(selectedEntry, flat.length - 1) : null;
        if (sel === null) {
          header = `${BOLD}${clipToWidth("project status — Ctrl+T to cycle", width)}${RESET}`;
          body = ["(no planned features, open bugs, or open questions)"]
            .map((l) => clipToWidth(l, width))
            .slice(0, eventBudget);
        } else {
          const e = flat[sel]!;
          const win = entryBodyWindow(e.body, entryScroll, eventBudget, width);
          // The scroll affordance appears only while the body overflows the pane — short
          // entries keep today's exact header.
          const browse = win.total > eventBudget ? "↑↓ browse · PgUp/PgDn scroll" : "↑↓ browse";
          header = `${BOLD}${clipToWidth(`${e.label}: ${e.title} — ${browse} · Ctrl+T cycle`, width)}${RESET}`;
          body = win.lines;
        }
      }
    } else {
      header = `${BOLD}recent activity${RESET}`;
      body = readEvents(root, eventBudget)
        .map((e) => clipToWidth(formatEvent(e), width))
        .slice(-eventBudget);
    }

    const parts = [status, ""];
    if (hasQuestions) {
      parts.push(
        `${BOLD}${clipToWidth(`questions: ${snap.questions} awaiting answers (see QUESTIONS.md)`, width)}${RESET}`,
      );
    }
    for (const [i, preview] of queued.entries()) {
      parts.push(clipToWidth(`${i + 1}. ${preview}`, width));
    }
    parts.push(header);
    parts.push(body.length ? body.map((l) => `${DIM}${l}${RESET}`).join("\n") : `${DIM}${emptyNote}${RESET}`);
    parts.push("");
    if (flash && Date.now() < flashUntil) parts.push(`${BOLD}${clipToWidth(flash, width)}${RESET}`);
    parts.push(
      `${DIM}${clipToWidth("type a prompt for the project, Enter to send · Ctrl+C to quit", width)}${RESET}`,
    );
    // Window long prompts around the cursor so its position stays visible.
    parts.push(`> ${renderInputView(input, cursor, width)}`);
    process.stdout.write(CLEAR + parts.join("\n"));
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const timer = setInterval(render, 1000);
  render();

  await new Promise<void>((resolve) => {
    process.stdin.on("keypress", (str: string | undefined, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        resolve();
        return;
      }
      if (key.ctrl && key.name === "t") {
        view = (view + 1) % (roleIds.length + 2); // events → each loop's transcript → project status → events
        selectedEntry = null; // leaving a view drops any entry selection…
        entryScroll = 0; // …and its within-body scroll, so re-entering starts at the list/head
        render();
        return;
      }
      if (view === roleIds.length + 1 && (key.name === "up" || key.name === "down")) {
        // In the project-status pane, up/down browse entries in full instead of editing the
        // prompt; every other view keeps today's behavior (arrows are ignored by applyKey).
        const count = flatEntries().length;
        selectedEntry = moveEntrySelection(count, selectedEntry, key.name);
        entryScroll = 0; // a newly opened entry starts at its body's head
        render();
        return;
      }
      if (view === roleIds.length + 1 && (key.name === "pageup" || key.name === "pagedown")) {
        // Within-body scroll in project-status ENTRY mode: PgDn/PgUp page the selected entry's
        // body, clamped at both ends. No-op in list mode and for bodies that fit — every other
        // view ignores these keys as today (applyKey drops them).
        if (selectedEntry !== null) {
          const flat = flatEntries();
          const sel = flat.length > 0 ? Math.min(selectedEntry, flat.length - 1) : null;
          const body = sel === null ? "" : flat[sel]!.body;
          entryScroll = stepEntryScroll(
            entryScroll,
            body ? body.split("\n").length : 0,
            eventBudget,
            key.name === "pagedown" ? "down" : "up",
          );
        }
        render();
        return;
      }
      if (key.name === "return") {
        const prompt = input.trim();
        input = "";
        cursor = 0;
        if (prompt) {
          submitPrompt(root, prompt);
          flash = "queued for the director loop";
          flashUntil = Date.now() + 3000;
        }
      } else {
        const next = applyKey(input, cursor, str, key);
        input = next.text;
        cursor = next.cursor;
      }
      render();
    });
  });

  clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
}
