import { renderDoctor, renderDoctorProblems } from "../../doctor/doctor-render.js";
import { orphanKillLines } from "../../doctor/doctor-orphans.js";
import { backlogCommitMessage } from "../../doctor/doctor-backlog.js";
import type { DoctorReport } from "../../doctor/doctor-checks.js";
import { runManualReclaim } from "../../operator/operator-intent.js";
import { testNotifyHook } from "../../cli/cli-notify-command.js";
import { resyncRootInstall, rootInstallResyncLines } from "../../build/dep-install.js";
import { brokenPinDropLines, leftoverRetireLines } from "../../doctor/doctor-contention-checks.js";
import { describeArchivedFile } from "../../backlog/backlog-archive.js";
import { shortSha } from "../../text/format.js";
import { promptLineFree, type TuiPaneCtx, type TuiPaneModule } from "./tui-pane-ctx.js";
import { paneAtHead, type TuiPaneSession } from "./tui-pane-session.js";

/** The Health pane (view roleIds.length + 7) of the TUI (src/ui/tui/tui.tsx): the doctor
 * re-run (Ctrl+R), reclaim (Ctrl+E), notify test (Ctrl+N), commit-backlog (Ctrl+A),
 * kill-orphans (Ctrl+K), broken-pin drop (Ctrl+S), resync-install (Ctrl+U),
 * retire-leftovers (Ctrl+L), backlog archive (Ctrl+B) and problems-only toggle (Ctrl+O),
 * beside the runDoctor collector they re-read on every entry. Split out of the
 * pane-navigation monolith; it owns the problems flag and the last resolved report.
 * Each key arm lives in its own named inner const below so its guard, flash wording and
 * repaint are found by name; handleKey is only the ordered dispatch of those arms. */
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
  const run = (): Promise<void> => {
    // Generation guard: each run bumps the counter, and a resolution paints only if it is
    // the latest request's — Ctrl+R held twice, or a re-run raced with a re-entry, must not
    // let an out-of-order older resolution overwrite the newer report.
    const gen = ++runGen;
    session.paneCache = null;
    lastDoctorReport = null;
    return session.runDoctor(session.root).then(
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

  // The Health key-arm guard every arm shares: the prompt line is free (an editor or typed
  // text would keep the key for its own view's meaning) and the Health view is current; the
  // armed arms (the five two-press/edit actions) additionally require a truly empty prompt
  // line so a typed draft cannot arm on Ctrl+K/S/U/L/B. True means the arm may run.
  const onHealthView = (ctx: TuiPaneCtx, armed: boolean): boolean =>
    promptLineFree(ctx.es) &&
    (!armed || (ctx.es.input ?? "") === "") &&
    session.view === session.roleIds.length + 7;

  // Run one Health-pane action: when the promise resolves its value is flashed through
  // `done`, then — unless `rerun` is cleared (the notify test, whose outcome needs no doctor
  // refresh) — the checks re-run in place and the pane re-enters at its head, the tail every
  // action arm repeated; when it rejects, the failure flashes instead of killing the TUI. The
  // starting notice and any pre-action render stay with each arm (some, like reclaim, show
  // none), so the helper owns only the shared then/error plumbing. An arm whose guard fails
  // returns false so the key falls through to the rest of the dispatch exactly as today.
  const healthAction = <T>(promise: Promise<T>, done: (value: T) => void, rerun = true): void => {
    void promise.then(
      (value) => {
        done(value);
        if (rerun) {
          void run();
          session.paneScroll = 0;
        }
        session.requestRender();
      },
      (err: unknown) => {
        session.flashError(err);
        session.requestRender();
      },
    );
  };
  const healthRefresh = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, false)) return false;
    // Ctrl+R on the Health pane re-runs the same doctor checks in place — the terminal
    // twin of the dashboard Health card's Re-run button — repainting through the current
    // problems-only toggle, and re-enters at the head so the changed body starts at the
    // top. Every other view keeps today's Ctrl+R (the backlog release).
    void run();
    paneAtHead(session);
    return true;
  };
  const healthReclaim = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, false)) return false;
    // Ctrl+E on the Health pane runs one manual reclaim pass now — the terminal twin of the
    // dashboard disk row's reclaim button and the core `tumwater reclaim`, both reached
    // through the same runManualReclaim. With a live team the pass is requested through the
    // marker a running orchestrator consumes within one poll; with none running it runs
    // in-process, since nothing is in use. The confirmation flashes verbatim; the doctor
    // re-runs so the free-disk row reflects what the pass freed, and a write failure flashes
    // instead of killing the TUI. Every other view keeps Ctrl+E's trailing-window cycle.
    healthAction(runManualReclaim(session.root), (message) => {
      session.flashMessage(message);
    });
    return true;
  };
  const healthNotifyTest = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, false)) return false;
    // Ctrl+N on the Health pane runs the saved notify hook once with the synthetic test event —
    // the terminal twin of `tumwater notify --test` and the dashboard Settings card's Send test,
    // both reached through the same testNotifyHook (src/cli/cli-notify-command.ts) — so a terminal
    // operator can check the push channel before a real page. The hook runs with stdio "ignore"
    // (the dashboard's choice) so a chatty hook's output cannot corrupt the alternate screen; the
    // running notice flashes first, then the outcome (the not-configured wording when no hook is
    // set, the hook's own outcome line otherwise), and a hook or write failure flashes instead of
    // killing the TUI. The action never blocks the render. Every other view keeps Ctrl+N (the
    // transcript notes/change cycle, the History run trail, and the backlog new-entry form).
    session.flashMessage("running the notify hook …");
    session.requestRender();
    healthAction(
      testNotifyHook(session.root, "ignore"),
      (outcome) => {
        session.flashMessage(
          outcome.status === "not_configured"
            ? "notify is not configured (set `notify` in tumwater.json)"
            : outcome.message,
        );
      },
      false,
    );
    return true;
  };
  const healthCommitBacklog = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, false)) return false;
    // Ctrl+A on the Health pane commits each uncommitted tracked backlog or brief file in the
    // primary checkout — the terminal twin of `tumwater doctor --commit-backlog` and the
    // dashboard Health card's Commit backlog button, all reached through the same
    // commitUncommittedBacklog core. It flashes the same message the CLI prints (the shared
    // backlogCommitMessage: the backlogCommitLines, or the nothing-to-commit line when the
    // checkout is clean), then re-runs the checks so the `uncommitted backlog` row repaints. A
    // failure flashes instead of killing the TUI. Every other view keeps Ctrl+A's backlog
    // answer editor (routed ahead of this pane) — the key dispatcher consults the editors
    // before the pane router, so this arm never shadows it.
    session.flashMessage("committing the uncommitted backlog/brief files …");
    session.requestRender();
    healthAction(session.commitBacklog(session.root), (report) => {
      session.flashMessage(backlogCommitMessage(report));
    });
    return true;
  };
  const healthKillOrphans = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, true)) return false;
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
    healthAction(session.killOrphans(session.root), (report) => {
      session.flashMessage(orphanKillLines(report).join("; "));
    });
    return true;
  };
  const healthDropBrokenPins = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, true)) return false;
    // Ctrl+S on the Health pane, pressed twice, drops each broken refs/tumwater/ pin (one
    // whose commit is gone) — the terminal twin of `tumwater doctor --drop-broken-pins` and
    // the dashboard Health card's Drop broken pins, all reached through the same
    // dropBrokenPins. The first press only arms (beginKey disarms on any other key) and
    // flashes what a second press does; the second flashes the same lines the CLI prints,
    // joined with "; ", then re-runs the checks so the tumwater pins row reflects the drop.
    // A failure flashes instead of killing the TUI. Ctrl+S stays the prompt-line editor's
    // save-to-wherever while text is typed or an editor holds the line, and keeps its
    // quiet-hours (Activity), trailing-window (History) and min-run-interval (Transcript)
    // meanings off the Health view.
    if (!session.armedDropBrokenPins) {
      session.dropBrokenPinsArmed = true;
      session.flashMessage(
        "press Ctrl+S again to drop each broken refs/tumwater/ pin whose commit is gone — any other key keeps them",
      );
      session.requestRender();
      return true;
    }
    session.flashMessage("dropping broken pins …");
    session.requestRender();
    healthAction(session.dropBrokenPins(session.root), (report) => {
      const lines = brokenPinDropLines(report);
      session.flashMessage(lines.length > 0 ? lines.join("; ") : "no broken pins to drop");
    });
    return true;
  };
  const healthResyncInstall = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, true)) return false;
    // Ctrl+U on the Health pane re-syncs the root checkout's install now — the terminal twin
    // of `tumwater doctor --resync-install` and the dashboard Health card's Re-sync install,
    // all reached through the same resyncRootInstall, so the `install` row/alert's advice is
    // one action and clears once the install lands. It flashes the same line the CLI prints
    // (rootInstallResyncLines, joined with "; "), then re-runs the checks so the `root
    // install` row refreshes. A failure flashes instead of killing the TUI. Ctrl+U stays the
    // prompt-line editor's kill-to-start while text is typed or an editor holds the line, and
    // is unbound on every other view.
    session.flashMessage("re-syncing the root install …");
    session.requestRender();
    healthAction(resyncRootInstall(session.root), (r) => {
      session.flashMessage(rootInstallResyncLines(r).join("; "));
    });
    return true;
  };
  const healthRetireLeftovers = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, true)) return false;
    // Ctrl+L on the Health pane, pressed twice, retires every disabled role's leftover
    // worktree, branch and merge ref in one pass — the terminal twin of `tumwater doctor
    // --retire-leftovers` and the dashboard Health card's Retire leftovers, all reached
    // through the same retireLeftovers (with the loaded config, never `--force`). The first
    // press only arms (beginKey disarms on any other key) and flashes what a second press
    // does; the second flashes the same lines the CLI prints, joined with "; " (or
    // `no leftover roles to retire` when nothing is retirable), then re-runs the checks so
    // the leftover-role-branches row reflects the reap. A failure flashes instead of killing
    // the TUI. Off the Health view Ctrl+L keeps the Activity fallback editor (view 0) and the
    // instructions editor on a role's Transcript.
    if (!session.armedRetireLeftovers) {
      session.retireLeftoversArmed = true;
      session.flashMessage(
        "press Ctrl+L again to retire every disabled role's leftover worktree, branch and merge ref — any other key keeps them",
      );
      session.requestRender();
      return true;
    }
    session.flashMessage("retiring every disabled role's leftovers …");
    session.requestRender();
    healthAction(session.retireLeftovers(session.root), (report) => {
      const lines = leftoverRetireLines(report);
      session.flashMessage(lines.length > 0 ? lines.join("; ") : "no leftover roles to retire");
    });
    return true;
  };
  const healthArchiveBacklog = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, true)) return false;
    // Ctrl+B on the Health pane, pressed twice, archives the finished entries still under
    // PLANS.md's ## Done and BUGS.md's ## Fixed into PLANS-DONE.md and BUGS-FIXED.md and
    // commits them on the base branch — the terminal twin of `tumwater archive` and the
    // dashboard Health card's Archive backlog, all reached through the same archiveFinished-.
    // OnMain. The first press only arms (beginKey disarms on any other key) and flashes what
    // a second press does; the second flashes the same lines the CLI prints, joined with
    // "; " (the nothing line verbatim when there is nothing to archive), then re-runs the
    // checks so the `backlog archive` row reflects the move. A failure flashes instead of
    // killing the TUI. Ctrl+B stays the prompt-line editor's line-kill (budget editor) while
    // text is typed or an editor holds the line, and is unbound on every other view.
    if (!session.armedArchiveBacklog) {
      session.archiveBacklogArmed = true;
      session.flashMessage(
        "press Ctrl+B again to archive the finished entries under PLANS.md ## Done and BUGS.md ## Fixed — any other key keeps them",
      );
      session.requestRender();
      return true;
    }
    session.flashMessage("archiving finished backlog entries …");
    session.requestRender();
    healthAction(session.archiveBacklog(session.root), (outcome) => {
      if (outcome.status === "nothing") {
        session.flashMessage("nothing to archive: PLANS.md ## Done and BUGS.md ## Fixed hold no finished entries");
      } else if (outcome.status === "skipped") {
        session.flashMessage(`nothing archived: ${outcome.reason}`);
      } else {
        session.flashMessage([...outcome.moved.map(describeArchivedFile), `committed ${shortSha(outcome.commit)}`].join("; "));
      }
    });
    return true;
  };
  const healthToggleProblems = (ctx: TuiPaneCtx): boolean => {
    if (!onHealthView(ctx, false)) return false;
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
    paneAtHead(session);
    return true;
  };

  const ctrlRoutes: Record<string, (ctx: TuiPaneCtx) => boolean> = {
    r: healthRefresh,
    e: healthReclaim,
    n: healthNotifyTest,
    a: healthCommitBacklog,
    k: healthKillOrphans,
    s: healthDropBrokenPins,
    u: healthResyncInstall,
    l: healthRetireLeftovers,
    b: healthArchiveBacklog,
    o: healthToggleProblems,
  };
  const ctrlRoute = (key: { ctrl?: boolean; name?: string }, ctx: TuiPaneCtx): boolean | null => {
    if (!key.ctrl || key.name === undefined) return null;
    const route = ctrlRoutes[key.name];
    return route === undefined ? null : route(ctx);
  };
  const handleKey = (
    key: { ctrl?: boolean; name?: string },
    ctx: TuiPaneCtx,
  ): boolean => {
    return ctrlRoute(key, ctx) ?? false;
  };

  return {
    handleKey,
    enter() {
      // Health reruns `tumwater doctor`'s checks on each entry and with the Ctrl+R refresh.
      void run();
      return true;
    },
    state() {
      return { healthProblems };
    },
  } satisfies TuiPaneModule;
}
