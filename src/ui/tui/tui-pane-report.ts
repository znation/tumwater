// vocabulary: plain
import { collectReport, collectReportSince } from "../../report/report-data.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "../../report/report-render.js";
import { REPORT_DEFAULT_DAYS } from "../../events/event-window.js";
import { collectFailureReport, collectFailureReportSince } from "../../failure/failure-data.js";
import { renderFailureMarkdown } from "../../failure/failure-render.js";
import { pageDir } from "./tui-keymap.js";
import { stepEntryScroll } from "./tui-backlog.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { nextInCycle, cycleLabel, REPORT_WINDOWS, scopeCycle, type TuiPaneSession } from "./tui-pane-session.js";

/** The Usage (view N+2) and Failures (view N+3) panes of the TUI (src/ui/tui/tui.tsx): the
 * session report window (Ctrl+E), the team/base-role scope (Ctrl+G, shared with the other
 * scope panes), and the Markdown-pane PgUp/PgDn body window. Split out of the pane-navigation
 * monolith; it owns the report window and team scope state and the arms that touch them. */
export function createReportPane(session: TuiPaneSession) {
  // The Usage and Failures panes' session trailing window (Ctrl+E), a REPORT_WINDOWS length or
  // null for the default day report. Session-only like the view/scroll state; the next Ctrl+T
  // into either pane computes the cache with it.
  let reportWindow: number | null = null;
  // The session-scoped role the Usage and Failures panes collect for, cycled by Ctrl+G, null
  // for the team. Session-only, like the view/selection/scroll state: a fresh TUI starts
  // team-wide, and syncSnapshot clears it when the roster drops the role.
  let scopeRole: string | null = null;

  /** The Usage pane's body for one window and role scope: the paneCache the Ctrl+T/Ctrl+G/Ctrl+E
   * handlers store. The default (null) read is byte-for-byte the day report the pane showed
   * before the window cycle — collectReport at REPORT_DEFAULT_DAYS; a trailing window reads
   * through the same collectReportSince collector `tumwater report --since` uses, so the TUI,
   * CLI, and dashboard cannot disagree. Both honor the Ctrl+G role scope, so the two session
   * cycles compose. */
  const usagePaneCache = (sinceMs: number | null, scope?: string): string => {
    if (sinceMs === null) return renderReportMarkdown(collectReport(session.root, REPORT_DEFAULT_DAYS, scope));
    return renderSinceReportMarkdown(collectReportSince(session.root, sinceMs, scope));
  };

  /** The Failures pane's body for one window and role scope, the digest sibling of
   * usagePaneCache; renderFailureMarkdown renders both the day and --since shapes. */
  const failuresPaneCache = (sinceMs: number | null, scope?: string): string => {
    if (sinceMs === null) return renderFailureMarkdown(collectFailureReport(session.root, REPORT_DEFAULT_DAYS, scope));
    return renderFailureMarkdown(collectFailureReportSince(session.root, sinceMs, scope));
  };

  /** Recompute the Usage/Failures panes' cached body if either is the current view, re-entering
   * at its head; true when one painted (the "report" arm of the shared refresh the panes and
   * the roster sync share). */
  const recompute = (): boolean => {
    const isUsage = session.view === session.roleIds.length + 2;
    const isFailures = session.view === session.roleIds.length + 3;
    if (!isUsage && !isFailures) return false;
    session.paneCache = isUsage
      ? usagePaneCache(reportWindow, scopeRole ?? undefined)
      : failuresPaneCache(reportWindow, scopeRole ?? undefined);
    session.paneScroll = 0;
    return true;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (
      key.ctrl && key.name === "e" &&
      !ctx.es.budgetMode && !ctx.es.rolePromptFor && !ctx.es.deferMode && !ctx.es.pauseEditMode &&
      !ctx.es.queuedEditFor && !ctx.es.answerFor && !ctx.es.entryEditFor &&
      !ctx.es.retireMode && promptLineFree(ctx.es)
    ) {
      // Ctrl+E advances the Usage and Failures panes' trailing report window (mnemonic:
      // **E**lapsed). Guarded out of the budget and role-prompt editors like the other
      // mode-sensitive keys. (The Queued-edit and backlog title-edit Ctrl+E arms live in
      // tui-editors, which handled them above and returned before this branch when they
      // matched.) The window is session state: advancing it off either report pane
      // only changes the label, and the next Ctrl+T into one computes the cache with it; on a
      // report pane this handler recomputes the cached Markdown from the newly windowed
      // collector and re-enters the body at its head.
      reportWindow = nextInCycle(REPORT_WINDOWS, reportWindow);
      recompute();
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "g" && promptLineFree(ctx.es)) {
      // Ctrl+G's team/base-role scope arm, reached for every view other than Activity (0) and
      // History (N+4), which the aggregator routes ahead of this module. A pane showing the
      // scope recomputes its cached Markdown and re-enters the body at its head; every other
      // view keeps the scope for the Ctrl+T entry that later computes with it.
      const slots = scopeCycle(session.roleIds);
      const slot = slots.indexOf(scopeRole);
      scopeRole = slots[(slot + 1) % slots.length] ?? null;
      recompute();
      session.requestRender();
      return true;
    }
    const page = pageDir(key.name);
    if (page !== null && session.view >= session.roleIds.length + 2) {
      // Within-body scroll in the Markdown panes (usage report, failures — and, via the same
      // view-index bound, the other text panes from History on): PgDn/PgUp page the cached
      // string, clamped at both ends. The total is derived from the cache, mirroring how entry
      // mode derives it from e.body; every other view ignores these keys as today.
      const total = (session.paneCache ?? "").split("\n").length;
      session.paneScroll = stepEntryScroll(session.paneScroll, total, session.eventBudget, page);
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    enter: recompute,
    reset() {
      // The report window and team scope are session state and survive a view cycle.
    },
    dropScopes(roles) {
      // A retired or renamed loop must not leave the report panes silently scoped to an
      // absent role — drop the scope with the stale view index. The tab strip and hint then
      // read "team", so a report pane still on screen must recompute its cached Markdown
      // from the team-wide collector (and re-enter at the body's head) to match; the other
      // views compute with the scope on their next Ctrl+T.
      if (scopeRole !== null && !roles.includes(scopeRole)) {
        scopeRole = null;
        recompute();
      }
    },
    state() {
      return {
        scopeRole,
        reportSince: reportWindow === null ? null : cycleLabel(REPORT_WINDOWS, reportWindow),
      };
    },
  } satisfies TuiPaneModule;
}
