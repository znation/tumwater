// vocabulary: plain
/** The per-pane body builder for the TUI's render (extracted from src/ui/tui/tui.tsx): which
 * lines fill the lower pane for the view the frame shows — transcript, backlog, usage,
 * failures, history, pending, queued, health, brief, or activity. Pure with respect to
 * terminal state: it reads the root's files (transcript, events, PLANS.md/BUGS.md/
 * QUESTIONS.md) and the keypress handler's
 * view state, and returns composed StatusLines plus the empty-pane note; src/ui/tui/tui.tsx
 * owns the terminal lifecycle and the frame assembly around it. */

import type { StatusLine } from "../status-render.js";
import { readTranscript } from "../transcript.js";
import { eventRole, readEvents } from "../../events/event-read.js";
import { eventMatchesGrep, formatEvent } from "../../events/event-format.js";
import type { HarnessEvent } from "../../events/events.js";
import { backlogLines, entryBodyWindow, browsableBacklogEntries, isOpenBacklogLabel, planListLines } from "./tui-backlog.js";
import { answeredQuestionSummaries } from "../../backlog/question-answer.js";
import { DASHBOARD_ANSWERED_QUESTIONS, recentFinished } from "../status-payload.js";
import { donePlanEntries, DONE_DATE_RE, entryMatches, FIXED_DATE_RE, fixedBugEntries } from "../../backlog/backlog.js";
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
  /** The Backlog pane's active `/` search pattern (null = no filter). */
  backlogGrep?: string | null;

  /** The Queued pane's row selection (null = list mode) and the rows it indexes (the same
   * renderQueuedList traversal `tumwater prompt --list` prints). A set selection shows the
   * row's full prompt under a cancel header instead of the numbered list. */
  selectedQueued: number | null;
  queuedRows: QueuedListRow[];
  paneCache: string | null;
  /** The notes view's rendered Markdown (roleInspectMarkdown), computed once on Ctrl+N
   * entry like paneCache; null when the live transcript is shown. */
  noteCache: string | null;
  /** The run-trail view's rendered text (renderRunDetail), computed once on Ctrl+N entry
   * from the History pane; null while the rows are shown or the newest run could not be read. */
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

/** The Activity pane's loaded event tail, narrowed by its role, text, and type filters: the one
 * read the pane body and the PgUp/PgDn total share, so their filtered lists cannot drift. All
 * three match rules are the CLI's and dashboard's own: `eventRole` for the exact-role scope
 * (`null` = the team's full tail), `eventMatchesGrep` over the type-prefixed rendered line for
 * the case-insensitive search (`null` = no search), and the exact `e.type === type` match for
 * the event-type filter (`null` = every type) — `tumwater logs --grep`, `logs --type`, and
 * `GET /api/logs` call the same ones, so the surfaces cannot disagree about what a filter
 * matches. */
export function activityEvents(root: string, role: string | null, grep: string | null, type: string | null): HarnessEvent[] {
  const needle = grep === null ? null : grep.toLowerCase();
  return readEvents(root, ACTIVITY_EVENTS).filter(
    (e) =>
      (role === null || eventRole(e) === role) &&
      (needle === null || eventMatchesGrep(e, needle)) &&
      (type === null || e.type === type),
  );
}

/** One role's notes and next run prompt, rendered as the same Markdown the TUI's notes
 * view windows: inspectMarkdownLines over the role's rolePayload. Split out of the keypress
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
    // The notes view (Ctrl+N) windows the cached inspection Markdown exactly like the
    // usage/failures panes, headings bold; the live transcript keeps the tail.
    if (pane.note) {
      const win = entryBodyWindow(state.noteCache ?? "", state.paneScroll, eventBudget, width);
      return {
        body: win.lines.map((l) => toneLine(l, width, l.startsWith("#") ? "bold" : undefined)),
        emptyNote: "(nothing to inspect yet)",
      };
    }
    // The change view (the second Ctrl+N step) windows the collected unmerged-change text the
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
    // planned feature, open bug, and open question (then the newest answered questions, done
    // plans and fixed bugs)
    // from PLANS.md/BUGS.md/QUESTIONS.md with its section label and eligibility mark (the same
    // entryHold verdict `tumwater backlog` renders). List and entry mode share this one pass;
    // entry mode used to read the three sections and derive the holds directly and
    // then again inside the flat list, so every render paid twice for the same reads and verdicts.
    const flat = browsableBacklogEntries(root);
    // A `/` search narrows the browsable list to the matching open entries (the answered/done/
    // fixed rows are read-only and hidden while a search is applied); entry mode still opens
    // `flat[sel]`, the unfiltered index the selection holds.
    const grep = state.backlogGrep ?? null;
    const shown = grep === null
      ? flat
      : flat.filter((e) => isOpenBacklogLabel(e.label) && entryMatches(e, grep));
    // A stale selection (an entry removed since the last render) clamps to the last; no
    // entries at all falls back to list mode.
    const sel = state.selectedEntry === null || flat.length === 0 ? null : Math.min(state.selectedEntry, flat.length - 1);
    if (sel === null) {
      // List mode: section headings stand out, empty sections read dim. Keeps the HEAD of the
      // list when it overflows — file order is newest-first, unlike events which keep the tail.
      const listed = (label: string) => shown.filter((e) => e.label === label).map((e) => e.title + e.mark);
      // Plans list a series' blocked parts as one line (as `plan --list` does); the selection
      // below still walks the flat list, one entry per part.
      const plans = shown.filter((e) => e.label === "plan");
      // A `/` search active: the answered/done/fixed sections are hidden, the sections build
      // only from the matching open entries under a `search: "<grep>"` header, and nothing
      // matching paints a self-explanatory line.
      if (grep !== null) {
        const prefix = [`search: "${grep}"`];
        const rest = shown.length === 0
          ? [`(no entries match "${grep}")`]
          : backlogLines(planListLines(plans), listed("bug"), listed("question"), plans.length);
        return {
          body: [...prefix, ...rest]
            .slice(0, eventBudget)
            .map((l) => toneLine(l, width, /^(?:plans|open bugs|open questions) \(\d+\):$/.test(l) ? "bold" : l.startsWith("(") ? "dim" : undefined)),
          emptyNote: "(no events yet)",
        };
      }
      // The newest answered questions follow the open ones: they are in `flat` (up/down open
      // their bodies), but no edit key acts on them.
      const answered = answeredQuestionSummaries(root, DASHBOARD_ANSWERED_QUESTIONS).map((q) =>
        q.decision ? `${q.title} — ${q.decision}` : q.title,
      );
      // Done plans and fixed bugs follow, browsable and read-only the same way.
      const finishedRows = (rows: ReturnType<typeof recentFinished>, verb: string) =>
        rows.map((r) => (r.completedOn ? `${r.title} — ${verb} ${r.completedOn}` : r.title));
      const finished = {
        done: finishedRows(recentFinished(donePlanEntries(root), DONE_DATE_RE), "done"),
        fixed: finishedRows(recentFinished(fixedBugEntries(root), FIXED_DATE_RE), "fixed"),
      };
      return {
        body: backlogLines(planListLines(plans), listed("bug"), listed("question"), plans.length, answered, finished)
          .slice(0, eventBudget)
          .map((l) => toneLine(l, width, /^(?:plans|open bugs|open questions|answered recently|done recently|fixed recently) \(\d+\):$/.test(l) ? "bold" : l.startsWith("(") ? "dim" : undefined)),
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
    // The run trail (Ctrl+N) windows the cached renderRunDetail text; a null cache (the
    // read found no run) paints the pane's own note rather than entryBodyWindow's placeholder.
    if (pane.trail) {
      if (state.trailCache === null) return { body: [], emptyNote: "(no run trail)" };
      const win = entryBodyWindow(state.trailCache, state.paneScroll, eventBudget, width);
      return {
        body: win.lines.map((l) => toneLine(l, width)),
        emptyNote: "(no run trail)",
      };
    }
    // historyPaneText returns "" when the log holds no completed runs; return no lines
    // (rather than windowing an empty string, which entryBodyWindow replaces with its
    // "no details" placeholder) so the frame prints the pane's own empty note instead.
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(no runs yet)",
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
  if (pane.kind === "health") {
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(running health checks…)",
    };
  }
  if (pane.kind === "brief") {
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(no project brief with a prompt block — run `tumwater init` first)",
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
          toneLine(`${row.role}'s inbox #${row.position} (Ctrl+X to cancel)`, width, "bold"),
          ...win.lines.map((l) => toneLine(l, width)),
        ],
        emptyNote: "(inbox empty)",
      };
    }
    const win = state.paneCache ? entryBodyWindow(state.paneCache, state.paneScroll, eventBudget, width) : { lines: [] };
    return {
      body: win.lines.map((l) => toneLine(l, width)),
      emptyNote: "(inbox empty)",
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
  // The Activity pane loads a fixed tail once per read, narrows it by the active role scope
  // and text search, and windows it: null follows the live tail (the newest eventBudget
  // events), a stored offset pages back through the loaded events. Both clamp to
  // [0, events.length - eventBudget]. An active filter that matched nothing names the filter
  // instead of claiming the log is empty.
  const events = activityEvents(root, pane.role, pane.grep, pane.type);
  const maxStart = Math.max(0, events.length - eventBudget);
  const start = state.activityScroll === null ? maxStart : Math.min(state.activityScroll, maxStart);
  return {
    body: events.slice(start, start + eventBudget).map((e) => toneLine(formatEvent(e), width, eventTone(e))),
    emptyNote:
      pane.role === null && pane.grep === null && pane.type === null
        ? "(no events yet)"
        : "(no events match this filter)",
  };
}
