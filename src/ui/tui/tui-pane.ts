/** The per-pane body builder for the TUI's render (extracted from src/ui/tui/tui.tsx): which
 * lines fill the lower pane for the view the frame shows — transcript, backlog, usage,
 * failures, history, pending, queued, or activity. Pure with respect to terminal state: it reads the
 * root's files (transcript, events, PLANS.md/BUGS.md/QUESTIONS.md) and the keypress handler's
 * view state, and returns composed StatusLines plus the empty-pane note; src/ui/tui/tui.tsx
 * owns the terminal lifecycle and the frame assembly around it. */

import type { StatusLine } from "../status-render.js";
import { readTranscript } from "../transcript.js";
import { eventRole, readEvents } from "../../events/event-read.js";
import { eventMatchesGrep, formatEvent } from "../../events/event-format.js";
import type { HarnessEvent } from "../../events/events.js";
import { backlogLines, entryBodyWindow, labeledBacklogEntries } from "./tui-backlog.js";
import type { QueuedListRow } from "../../inbox/inbox.js";
import { rolePayload } from "../../roles/role-view.js";
import { inspectMarkdownLines } from "../../roles/role-render.js";
import { eventTone, toneLine, transcriptTone, type TuiView } from "./tui-frame.js";

/** The slice of the keypress handler's state (TuiKeys.state(), src/ui/tui/tui-keys.ts) the
 * pane bodies read: the backlog selection and its scroll, and the usage/failures pane's
 * cached Markdown and its scroll. Plain data, so tests can build it without the handler. */
interface TuiPaneState {
  selectedEntry: number | null;
  entryScroll: number;
  /** The Queued pane's row selection (null = list mode) and the rows it indexes (the same
   * renderQueuedList traversal `tumwater prompt --list` prints). A set selection shows the
   * row's full prompt under a cancel header instead of the numbered list. */
  selectedQueued: number | null;
  queuedRows: QueuedListRow[];
  paneCache: string | null;
  /** The notebook view's rendered Markdown (roleInspectMarkdown), computed once on Ctrl+N
   * entry like paneCache; null when the live transcript is shown. */
  noteCache: string | null;
  /** The tick-trail view's rendered text (renderTickDetail), computed once on Ctrl+N entry
   * from the History pane; null while the rows are shown or the newest tick could not be read. */
  trailCache: string | null;
  /** The change view's rendered text (renderRoleChange), null until its async collector
   * resolves; windowed by paneBody in change mode. */
  changeCache: string | null;
  paneScroll: number;
  /** The Activity pane's body-window start into the loaded event tail, or null to follow the
   * live tail (the newest eventBudget events). PgUp pauses follow; PgDn returns to the tail. */
  activityScroll: number | null;
}

/** How many raw events the Activity pane loads per read, and the tail PgUp/PgDn page through.
 * A fixed tail term so readEvents' stat cache hits per (file, limit) in the steady state. */
const ACTIVITY_EVENTS = 200;

/** The Activity pane's loaded event tail, narrowed by its loop and text filters: the one read
 * the pane body and the PgUp/PgDn total share, so their filtered lists cannot drift. Both
 * match rules are the CLI's and dashboard's own: `eventRole` for the exact-loop scope (`null`
 * = the fleet's full tail), and `eventMatchesGrep` over the type-prefixed rendered line for the
 * case-insensitive search (`null` = no search) — `tumwater logs --grep` and `GET /api/logs`
 * call the same two, so the three surfaces cannot disagree about what a filter matches. */
export function activityEvents(root: string, role: string | null, grep: string | null): HarnessEvent[] {
  const needle = grep === null ? null : grep.toLowerCase();
  return readEvents(root, ACTIVITY_EVENTS).filter(
    (e) => (role === null || eventRole(e) === role) && (needle === null || eventMatchesGrep(e, needle)),
  );
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
    // The change view (the second Ctrl+N step) windows the collected unlanded-change text the
    // same way; its async collector leaves the cache null for the first frames, so the pane
    // paints the loading note rather than entryBodyWindow's "no details" placeholder.
    if (pane.change) {
      if (state.changeCache === null) return { body: [], emptyNote: "(loading pending change…)" };
      const win = entryBodyWindow(state.changeCache, state.paneScroll, eventBudget, width);
      return {
        body: win.lines.map((l) => toneLine(l, width, l.startsWith("#") ? "bold" : undefined)),
        emptyNote: "(loading pending change…)",
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
    // The tick trail (Ctrl+N) windows the cached renderTickDetail text; a null cache (the
    // read found no tick) paints the pane's own note rather than entryBodyWindow's placeholder.
    if (pane.trail) {
      if (state.trailCache === null) return { body: [], emptyNote: "(no tick trail)" };
      const win = entryBodyWindow(state.trailCache, state.paneScroll, eventBudget, width);
      return {
        body: win.lines.map((l) => toneLine(l, width)),
        emptyNote: "(no tick trail)",
      };
    }
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
    // A set selection shows the row's full prompt under a cancel header (the numbered list
    // clips long prompts); list mode windows the cached renderQueuedList string, which is
    // computed synchronously on Ctrl+T entry over the same queue `tumwater prompt --list`
    // prints, so paneCache is already set this frame. An empty queue falls to the pane's
    // own note either way.
    const sel = state.selectedQueued === null || state.queuedRows.length === 0
      ? null
      : Math.min(state.selectedQueued, state.queuedRows.length - 1);
    if (sel !== null) {
      const row = state.queuedRows[sel]!;
      const win = entryBodyWindow(row.text, state.paneScroll, entryBudget, width);
      return {
        body: [
          toneLine(`queued for ${row.role} #${row.position} (Ctrl+X to cancel)`, width, "bold"),
          ...win.lines.map((l) => toneLine(l, width)),
        ],
        emptyNote: "(no queued prompts)",
      };
    }
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
  // The Activity pane loads a fixed tail once per read, narrows it by the active loop scope
  // and text search, and windows it: null follows the live tail (the newest eventBudget
  // events), a stored offset pages back through the loaded events. Both clamp to
  // [0, events.length - eventBudget]. An active filter that matched nothing names the filter
  // instead of claiming the log is empty.
  const events = activityEvents(root, pane.role, pane.grep);
  const maxStart = Math.max(0, events.length - eventBudget);
  const start = state.activityScroll === null ? maxStart : Math.min(state.activityScroll, maxStart);
  return {
    body: events.slice(start, start + eventBudget).map((e) => toneLine(formatEvent(e), width, eventTone(e))),
    emptyNote: pane.role === null && pane.grep === null ? "(no events yet)" : "(no events match this filter)",
  };
}
