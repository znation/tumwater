/** The per-pane body builder for the TUI's render (extracted from src/ui/tui/tui.tsx): which
 * lines fill the lower pane for the view the frame shows — transcript, backlog, usage,
 * failures, or activity. Pure with respect to terminal state: it reads the root's files
 * (transcript, events, PLANS.md/BUGS.md/QUESTIONS.md) and the keypress handler's view
 * state, and returns composed StatusLines plus the empty-pane note; src/ui/tui/tui.tsx owns
 * the terminal lifecycle and the frame assembly around it. */

import type { StatusLine } from "../status-render.js";
import { readTranscript } from "../transcript.js";
import { readEvents } from "../../events/event-read.js";
import { formatEvent } from "../../events/event-format.js";
import { openBugEntries, openQuestionEntries, plannedPlanEntries } from "../../backlog/backlog.js";
import { backlogLines, entryBodyWindow, labeledBacklogEntries } from "./tui-backlog.js";
import { eventTone, toneLine, transcriptTone, type TuiView } from "./tui-frame.js";

/** The slice of the keypress handler's state (TuiKeys.state(), src/ui/tui/tui-keys.ts) the
 * pane bodies read: the backlog selection and its scroll, and the usage/failures pane's
 * cached Markdown and its scroll. Plain data, so tests can build it without the handler. */
interface TuiPaneState {
  selectedEntry: number | null;
  entryScroll: number;
  paneCache: string | null;
  paneScroll: number;
}

/** The pane's body lines and the note a short body is replaced with (tui.tsx's frame
 * assembly prints the note dim when the body is empty). */
interface TuiPaneBody {
  body: StatusLine[];
  emptyNote: string;
}

/** Compose the body lines for one pane at this frame's width and budgets. Same rules
 * tui.tsx's inline builder followed: transcripts keep the tail, the backlog list keeps
 * the head with the selected entry's full body in entry mode, usage/failures re-window
 * the cached Markdown set on view entry, and the activity pane keeps the event tail. */
export function paneBody(
  pane: TuiView,
  opts: {
    root: string;
    width: number;
    eventBudget: number;
    entryBudget: number;
    state: TuiPaneState;
  },
): TuiPaneBody {
  const { root, width, eventBudget, entryBudget, state } = opts;
  if (pane.kind === "transcript") {
    return {
      body: readTranscript(root, pane.role, eventBudget).slice(-eventBudget).map((l) => toneLine(l, width, transcriptTone(l))),
      emptyNote: "(no transcript yet)",
    };
  }
  if (pane.kind === "backlog") {
    // Planned features, open bugs, and open questions from PLANS.md/BUGS.md/QUESTIONS.md,
    // read fresh each render like events. Keeps the HEAD of the list when it overflows —
    // file order is newest-first, unlike events which keep the tail.
    const planEntries = plannedPlanEntries(root);
    const bugEntries = openBugEntries(root);
    const questionEntries = openQuestionEntries(root);
    const flat = state.selectedEntry === null ? [] : labeledBacklogEntries(root);
    const sel = state.selectedEntry === null || flat.length === 0 ? null : Math.min(state.selectedEntry, flat.length - 1);
    if (sel === null) {
      // List mode (and a stale selection with no entries left falls back to it): section
      // headings stand out, empty sections read dim.
      return {
        body: backlogLines(planEntries.map((e) => e.title), bugEntries.map((e) => e.title), questionEntries.map((e) => e.title))
          .slice(0, eventBudget)
          .map((l) => toneLine(l, width, /^(?:plans|open bugs|open questions) \(\d+\):$/.test(l) ? "bold" : l.startsWith("(") ? "dim" : undefined)),
        emptyNote: "(no events yet)",
      };
    }
    // Entry browsing: the selected entry's full body under a line naming its section and
    // title. A stale selection (an entry removed since the last render) clamps to the last.
    const e = flat[sel]!;
    const win = entryBodyWindow(e.body, state.entryScroll, entryBudget, width);
    return {
      body: [toneLine(`${e.label}: ${e.title}`, width, "bold"), ...win.lines.map((l) => toneLine(l, width))],
      emptyNote: "(no events yet)",
    };
  }
  if (pane.kind === "usage" || pane.kind === "failures") {
    // The Markdown `tumwater report` prints, windowed like backlog entry mode. The cache is
    // set on view entry by the Ctrl+T handler, so this only re-windows a string.
    const win = entryBodyWindow(state.paneCache ?? "", state.paneScroll, eventBudget, width);
    return {
      body: win.lines.map((l) => toneLine(l, width, l.startsWith("#") ? "bold" : undefined)),
      emptyNote: "(no events yet)",
    };
  }
  return {
    body: readEvents(root, eventBudget).map((e) => toneLine(formatEvent(e), width, eventTone(e))).slice(-eventBudget),
    emptyNote: "(no events yet)",
  };
}