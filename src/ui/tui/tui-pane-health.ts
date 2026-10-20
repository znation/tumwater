import { renderDoctor, renderDoctorProblems } from "../../doctor/doctor-render.js";
import { orphanKillLines } from "../../doctor/doctor-orphans.js";
import type { DoctorReport } from "../../doctor/doctor-checks.js";
import { runManualReclaim } from "../../operator/operator-intent.js";
import { testNotifyHook } from "../../cli/notify-command.js";
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

  // Rerun `tumwater doctor`'s checks and cache the rendered report; the loading note shows
  // until they resolve. Same stale-resolution guard as Pending: only paint while Health is
  // current. Extracted so both the enter half of the Ctrl+T cycle and the Ctrl+R in-place
  // refresh run the same body; a run already in flight is superseded by the new read.
  let runGen = 0;
  const run = (): void => {
    // Generation guard: each run bumps the counter, and a resolution paints only if it is
    // the latest request's — Ctrl+R held twice, or a re-run raced with a re-entry, must not
    // let an out-of-order older resolution overwrite the newer report.
    const gen = ++runGen;
    session.paneCache = null;
    lastDoctorReport = null;
    void session.runDoctor(session.root).then(
      (report) => {
        if (gen !== runGen || session.view !== session.roleIds.length + 7) return;
        lastDoctorReport = report;
        session.paneCache = (healthProblems ? renderDoctorProblems : renderDoctor)(report);
        session.requestRender();
      },
      (err: unknown) => {
        if (gen !== runGen || session.view !== session.roleIds.length + 7) return;
        session.flashError(err);
        session.requestRender();
      },
    );
  };

  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    if (key.ctrl && key.name === "r" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 7) {
      // Ctrl+R on the Health pane re-runs the same doctor checks in place — the terminal
      // twin of the dashboard Health card's Re-run button — repainting through the current
      // problems-only toggle, and re-enters at the head so the changed body starts at the
      // top. Every other view keeps today's Ctrl+R (the backlog release).
      run();
      session.paneScroll = 0;
      session.requestRender();
      return true;
    }
    if (key.ctrl && key.name === "e" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 7) {
      // Ctrl+E on the Health pane runs one manual reclaim pass now — the terminal twin of the
      // dashboard disk row's reclaim button and the core `tumwater reclaim`, both reached
      // through the same runManualReclaim. With a live team the pass is requested through the
      // marker a running orchestrator consumes within one poll; with none running it runs
      // in-process, since nothing is in use. The confirmation flashes verbatim; the doctor
      // re-runs so the free-disk row reflects what the pass freed, and a write failure flashes
      // instead of killing the TUI. Every other view keeps Ctrl+E's trailing-window cycle.
      void runManualReclaim(session.root).then(
        (message) => {
          session.flashMessage(message);
          run();
          session.paneScroll = 0;
          session.requestRender();
        },
        (err: unknown) => {
          session.flashError(err);
          session.requestRender();
        },
      );
      return true;
    }
    if (key.ctrl && key.name === "n" && promptLineFree(ctx.es) && session.view === session.roleIds.length + 7) {
      // Ctrl+N on the Health pane runs the saved notify hook once with the synthetic test event —
      // the terminal twin of `tumwater notify --test` and the dashboard Settings card's Send test,
      // both reached through the same testNotifyHook (src/cli/notify-command.ts) — so a terminal
      // operator can check the push channel before a real page. The hook runs with stdio "ignore"
      // (the dashboard's choice) so a chatty hook's output cannot corrupt the alternate screen; the
      // running notice flashes first, then the outcome (the not-configured wording when no hook is
      // set, the hook's own outcome line otherwise), and a hook or write failure flashes instead of
      // killing the TUI. The action never blocks the render. Every other view keeps Ctrl+N (the
      // transcript notes/change cycle, the History run trail, and the backlog new-entry form).
      session.flashMessage("running the notify hook …");
      session.requestRender();
      void testNotifyHook(session.root, "ignore").then(
        (outcome) => {
          session.flashMessage(
            outcome.status === "not_configured"
              ? "notify is not configured (set `notify` in tumwater.json)"
              : outcome.message,
          );
          session.requestRender();
        },
        (err: unknown) => {
          session.flashError(err);
          session.requestRender();
        },
      );
      return true;
    }
    if (key.ctrl && key.name === "k" && promptLineFree(ctx.es) && (ctx.es.input ?? "") === "" && session.view === session.roleIds.length + 7) {
      // Ctrl+K on the Health pane, pressed twice, kills the orphaned processes the orphans check
      // lists, each with its descendants — the terminal twin of `tumwater doctor --kill-orphans`
      // and the dashboard Health card's Kill orphans, all reached through the same killOrphans.
      // The first press only arms (beginKey disarms on any other key) and flashes what a second
      // press does; the second flashes the same lines the CLI prints, joined with "; ", then
      // re-runs the checks so the orphans row reflects the kill. A failure flashes instead of
      // killing the TUI. Ctrl+K stays the prompt-line editor's kill-line while text is typed
      // or an editor holds the line, and is unbound on every other view.
      if (!session.armedKillOrphans) {
        session.killOrphansArmed = true;
        session.flashMessage(
          "press Ctrl+K again to kill the orphaned processes the orphans check lists — any other key keeps them",
        );
        session.requestRender();
        return true;
      }
      session.flashMessage("killing orphaned processes …");
      session.requestRender();
      void session.killOrphans(session.root).then(
        (report) => {
          session.flashMessage(orphanKillLines(report).join("; "));
          run();
          session.paneScroll = 0;
          session.requestRender();
        },
        (err: unknown) => {
          session.flashError(err);
          session.requestRender();
        },
      );
      return true;
    }
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
      // Health reruns `tumwater doctor`'s checks on each entry and with the Ctrl+R refresh.
      run();
      return true;
    },
    state() {
      return { healthProblems };
    },
  } satisfies TuiPaneModule;
}
