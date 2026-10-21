import { activityEvents } from "./tui-pane.js";
import { stepEntryScroll } from "./tui-backlog.js";
import { pageDir } from "./tui-keymap.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The Activity pane (view 0) of the TUI (src/ui/tui/tui.tsx): the session live-tail scope
 * (Ctrl+G), the free-text search (`/`), and the PgUp/PgDn tail-paging arm. Split out of the
 * pane-navigation monolith; it owns the pane's own scroll/scope/search state and the arms
 * that touch them. */
export function createActivityPane(
  session: TuiPaneSession,
) {
  // The Activity pane's body-window start into the loaded event tail, or null to follow the
  // live tail (the newest eventBudget events). PgUp pauses follow and pages back; PgDn returns
  // toward the tail and re-enables follow at the bottom. Reset on every Ctrl+T view cycle, so
  // re-entering Activity always starts at the live tail.
  let activityScroll: number | null = null;
  // The Activity pane's session exact-role scope (Ctrl+G), a raw roster id or null for the
  // team's full tail. Session-only like the view/scroll state; syncSnapshot clears it when the
  // roster drops the id. The raw ids, not scopeCycle's base roles: the feed filters by exact
  // role (eventRole), so `feature-2` is its own slot.
  let activityRole: string | null = null;
  // The Activity pane's session free-text search (the `/` prompt-line editor), a
  // case-insensitive substring over eventMatchesGrep's type-prefixed rendered line — the same
  // rule `tumwater logs --grep` and the dashboard search use. null is no search; session-only
  // like the scope, so the next read computes with it.
  let activityGrep: string | null = null;
  // The Activity pane's session exact event type (Ctrl+O), a canonical event type or null for
  // every type. Filtered exactly (`e.type === type`, the same match `tumwater logs --type`
  // applies), built as a cycle from the types present in the pre-type scope; session-only and
  // reset to the live tail with a change like the scope and search.
  let activityType: string | null = null;

  const applySearch = (pattern: string | null): void => {
    // Apply a finished Activity search on the pane: set the grep and reset the scroll to the
    // live tail (the offset indexed the old filtered list) — the leaf the search editor's Enter
    // calls through its applyActivitySearch dep.
    activityGrep = pattern;
    activityScroll = null;
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "g" && promptLineFree(ctx.es)) {
      // The Activity feed scopes over the same raw roster ids, so `feature-2` is its own
      // slot; the filter reads exact role ids through eventRole. The scroll resets because
      // its offset indexed the old (unfiltered or differently filtered) list.
      const slots: Array<string | null> = [null, ...session.roleIds];
      const slot = slots.indexOf(activityRole);
      activityRole = slots[(slot + 1) % slots.length] ?? null;
      activityScroll = null;
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "o" && promptLineFree(ctx.es)) {
      // The Activity type cycle: advance all → first present type → … → last present type → all.
      // `present` is built from the pre-type read (type `null`), so every type stays reachable
      // once one is selected — the same reason the dashboard builds its chip set before its
      // type filter. The scroll resets because its offset indexed the old filtered list.
      const present = [...new Set(activityEvents(session.root, activityRole, activityGrep, null).map((e) => e.type))].sort();
      const slots: Array<string | null> = [null, ...present];
      activityType = slots[(slots.indexOf(activityType) + 1) % slots.length] ?? null;
      activityScroll = null;
      session.requestRender();
      return true;
    }
    const page = pageDir(key.name);
    if (page !== null && session.view === 0) {
      // The Activity pane keeps the live tail by default; PgUp pauses follow and pages back
      // through the loaded event tail, PgDn returns toward it and re-enables follow once the
      // window reaches the tail. Both directions clamp to [0, total - rows], and a log with
      // rows or fewer events stays on the tail. `rows` is the feed's window height — one body
      // line short of eventBudget while the tally line is drawn (its paneBody twin, the
      // `rows = Math.max(1, eventBudget - tallyLine.length)` in tui-pane.ts) — so each page
      // advances exactly as far as the feed displays and no event is skipped or unreachable
      // while paging. The read is the pane's own fixed tail term (and active role/text
      // filter), so it hits readEvents' stat cache rather than rescanning the log.
      const total = activityEvents(session.root, activityRole, activityGrep, activityType).length;
      const rows = total === 0 ? session.eventBudget : Math.max(1, session.eventBudget - 1);
      const maxStart = Math.max(0, total - rows);
      const current = activityScroll ?? maxStart;
      const next = stepEntryScroll(current, total, rows, page);
      activityScroll = next >= maxStart ? null : next;
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    reset() {
      activityScroll = null;
    },
    dropScopes(roles) {
      // The same drop for the Activity feed's exact-role scope: a retired or renamed role must
      // not leave the pane filtering on an id the roster no longer names. The scroll resets
      // with it — the offset indexed the old filtered list.
      if (activityRole !== null && !roles.includes(activityRole)) {
        activityRole = null;
        activityScroll = null;
      }
    },
    applySearch,
    state() {
      return { activityScroll, activityRole, activityGrep, activityType };
    },
  } satisfies TuiPaneModule & { applySearch(pattern: string | null): void };
}
