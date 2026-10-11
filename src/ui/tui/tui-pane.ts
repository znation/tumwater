/** The per-pane body builder for the TUI's render (extracted from src/ui/tui/tui.tsx): which
 * lines fill the lower pane for the view the frame shows — transcript, backlog, usage,
 * failures, history, pending, queued, or activity. Pure with respect to terminal state: it reads the
 * root's files (transcript, events, PLANS.md/BUGS.md/QUESTIONS.md) and the keypress handler's
 * view state, and returns composed StatusLines plus the empty-pane note; src/ui/tui/tui.tsx
 * owns the terminal lifecycle and the frame assembly around it. */

import type { StatusLine } from "../status-render.js";
import { readTranscript } from "../transcript.js";
import { readEvents } from "../../events/event-read.js";
import { formatEvent } from "../../events/event-format.js";
import { backlogLines, entryBodyWindow, labeledBacklogEntries } from "./tui-backlog.js";
import { rolePayload } from "../../roles/role-view.js";
import { inspectMarkdownLines } from "../../roles/role-render.js";
import { eventTone, toneLine, transcriptTone, type TuiView } from "./tui-frame.js";

/** The slice of the keypress handler's state (TuiKeys.state(), src/ui/tui/tui-keys.ts) the
 * pane bodies read: the backlog selection and its scroll, and the usage/failures pane's
 * cached Markdown and its scroll. Plain data, so tests can build it without the handler. */
interface TuiPaneState {
  selectedEntry: number | null;
  entryScroll: number;
  paneCache: string | null;
  /** The notebook view's rendered Markdown (roleInspectMarkdown), computed once on
   * Ctrl+N entry like paneCache; null when the live transcript is shown. */
  noteCache: string | null;
  paneScroll: number;
}

/** One loop's notebook and next tick prompt, rendered as the same Markdown the TUI's notebook
 * view windows: inspectMarkdownLines over the loop's rolePayload. Split out of the keypress
 * handler so the Ctrl+N branch can catch a collector throw and flash it. */
export function roleInspectMarkdown(root: string, role: string): string {
  return inspectMarkdownLines(rolePayload(root, role)).join("\n");
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
    // The notebook view (Ctrl+N) windows the cached inspection Markdown exactly like the
    // usage/failures panes, headings bold; the live transcript keeps the tail.
    if (pane.note) {
      const win = entryBodyWindow(state.noteCache ?? "", state.paneScroll, eventBudget, width);
      return {
        body: win.lines.map((l) => toneLine(l, width, l.startsWith("#") ? "bold" : undefined)),
        emptyNote: "(nothing to inspect yet)",
      };
    }
    return {
      body: readTranscript(root, pane.role, eventBudget).slice(-eventBudget).map((l) => toneLine(l, width, transcriptTone(l))),
      emptyNote: "(no transcript yet)",
    };
  }
  if (pane.kind === "backlog") {
    // The flat, labeled entry list is the one backlog read this frame needs: it carries every
    // planned feature, open bug, and open question from PLANS.md/BUGS.md/QUESTIONS.md with its
    // section label and eligibility mark (the same entryHold verdict `tumwater backlog`
    // renders). List and entry mode share this one pass; entry mode used to read the three
    // sections and derive the holds directly and then again inside labeledBacklogEntries, so
    // every render paid twice for the same reads and verdicts.
    const flat = labeledBacklogEntries(root);
    // A stale selection (an entry removed since the last render) clamps to the last; no
    // entries at all falls back to list mode.
    const sel = state.selectedEntry === null || flat.length === 0 ? null : Math.min(state.selectedEntry, flat.length - 1);
    if (sel === null) {
      // List mode: section headings stand out, empty sections read dim. Keeps the HEAD of the
      // list when it overflows — file order is newest-first, unlike events which keep the tail.
      const listed = (label: string) => flat.filter((e) => e.label === label).map((e) => e.title + e.mark);
      return {
        body: backlogLines(listed("plan"), listed("bug"), listed("question"))
          .slice(0, eventBudget)
          .map((l) => toneLine(l, width, /^(?:plans|open bugs|open questions) \(\d+\):$/.test(l) ? "bold" : l.startsWith("(") ? "dim" : undefined)),
        emptyNote: "(no events yet)",
      };
    }
    // Entry browsing: the selected entry's full body under a line naming its section and
    // title.
    const e = flat[sel]!;
    const win = entryBodyWindow(e.body, state.entryScroll, entryBudget, width);
    return {
      body: [toneLine(`${e.label}: ${e.title}${e.mark}`, width, "bold"), ...win.lines.map((l) => toneLine(l, width))],
      emptyNote: "(no events yet)",
    };
  }
  if (pane.kind === "history") {
    // historyPaneText returns "" when the log holds no completed ticks; return no lines
    // (rather than windowing an empty string, which entryBodyWindow replaces with its
    // "no details" placeholder) so the frame prints the pane's own empty note instead.
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(no ticks yet)",
    };
  }
  if (pane.kind === "pending") {
    // paneCache stays null until the async collector resolves (the Ctrl+T handler kicks it
    // off fire-and-forget); like history, return no lines while null so the frame prints the
    // loading note rather than windowing an empty string into the "no details" placeholder.
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(loading pending changes…)",
    };
  }
  if (pane.kind === "queued") {
    // The queued-prompt list is computed synchronously on Ctrl+T entry (renderQueuedList over
    // the same queue list `tumwater prompt --list` prints), so paneCache is already set this
    // frame; an empty queue caches the empty string and falls to the pane's own note.
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(no queued prompts)",
    };
  }
  if (pane.kind === "usage" || pane.kind === "failures") {
    // The Markdown `tumwater report`/`report --failures` prints, windowed like backlog entry
    // mode. The cache is set on view entry by the Ctrl+T handler, so this only re-windows a string.
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
