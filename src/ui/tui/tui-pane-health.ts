// vocabulary: plain
import { renderDoctor, renderDoctorProblems } from "../../doctor/doctor-render.js";
import type { DoctorReport } from "../../doctor/doctor-checks.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import type { TuiPaneSession } from "./tui-pane-session.js";

/** The Health pane (view roleIds.length + 7) of the TUI (src/ui/tui/tui.tsx): the problems-only
 * Ctrl+O toggle and the runDoctor collector it re-reads on every entry. Split out of the
 * pane-navigation monolith; it owns the problems flag and the last resolved report. */
export function createHealthPane(session: TuiPaneSession) {
  // Within the Health pane (Ctrl+O), whether the cached report paints only its warn and fail
  // checks, the same problems-only trim `tumwater doctor --problems` applies. Session-only
  // like the window/scope state: the next Ctrl+T into Health repaints with it.
  let healthProblems = false;
  // The Health pane's last resolved doctor report, kept so Ctrl+O can repaint the pane
  // without rerunning the checks; null until the collector first resolves (the loading note
  // is up).
  let lastDoctorReport: DoctorReport | null = null;

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "o" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 7) {
      // Ctrl+O on the Health pane toggles the problems-only view (mnemonic: **O**nly
      // problems) — the same warn/fail trim `tumwater doctor --problems` applies — so an
      // operator can hide the ok rows without leaving the surface. The pane repaints from the
      // cached report it already holds; before any checks resolve (the loading note is up)
      // the toggle only records the choice for the first paint, and the pane re-enters at its
      // head so the changed body starts at the top. Every other view keeps the History
      // Ctrl+O outcome cycle.
      healthProblems = !healthProblems;
      if (lastDoctorReport !== null)
        session.paneCache = (healthProblems ? renderDoctorProblems : renderDoctor)(lastDoctorReport);
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    return false;
  };

  return {
    handleKey,
    enter() {
      // Health reruns `tumwater doctor`'s checks on each entry; the loading note shows until
      // they resolve. Same stale-resolution guard as Pending: only paint while Health is
      // current.
      session.paneCache = null;
      lastDoctorReport = null;
      void session.runDoctor(session.root).then(
        (report) => {
          if (session.view !== session.roleIds.length + 7) return;
          lastDoctorReport = report;
          session.paneCache = (healthProblems ? renderDoctorProblems : renderDoctor)(report);
          session.requestRender();
        },
        (err: unknown) => {
          if (session.view !== session.roleIds.length + 7) return;
          session.flashError(err);
          session.requestRender();
        },
      );
      return true;
    },
    state() {
      return { healthProblems };
    },
  } satisfies TuiPaneModule;
}
