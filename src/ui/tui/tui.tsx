// vocabulary: plain
import { render as inkRender } from "ink";
import { TuiApp, type TuiAppView } from "./tui-app.js";
import { openQuestions } from "../../backlog/backlog.js";
import { refusedEntryTitles } from "../../backlog/backlog-eligibility.js";
import { snapshot } from "../../status/status-data.js";
import { renderStatusSpans, type StatusLine } from "../status-render.js";
import { teamAlerts } from "../team-alerts.js";
import {
  captureStartupBuild,
  createReloadWatch,
  reexecSelf,
  type ReloadWatchSeams,
  type SupervisorWatchSeams,
  watchReloadSupervisor,
} from "../../redeploy/self-reload.js";
import {
  renderInputView,
  tuiTerminalError,
} from "./tui-input.js";
import { createTuiKeys } from "./tui-keys.js";
import { paneBody } from "./tui-pane.js";
import {
  alertLines,
  hintLine,
  prefixWidth,
  promptPrefix,
  sanitizeFrameLines,
  tabStrip,
  toneLine,
  type TuiView,
} from "./tui-frame.js";

/** The half of a terminal the TUI actually touches: the input stream ink claims (raw mode,
 * keypresses) and the size the renderer clips to. Production reads process.stdin; tests
 * inject fakes so the loop is driven without a TTY. The surface is what ink's stdin
 * handling needs: the TTY flag, raw-mode control, the ref/encoding calls, and the
 * Readable.read read loop it drains after a `readable` event. */
export interface TuiStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode(mode: boolean): void;
  setEncoding(encoding?: string): unknown;
  ref(): unknown;
  unref(): unknown;
  /** One buffered chunk, or null when drained — ink's input loop reads until null. */
  read(): string | Uint8Array | null;
}
/** The output half of the terminal the TUI touches: the size the renderer clips to and where
 * its bytes go. Production reads process.stdout; tests inject fakes so the loop is driven
 * without a TTY. */
export interface TuiStdout {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(s: string): unknown;
  /** The stream surface the ink renderer needs: it subscribes to `resize` on the stdout
   * it renders into (and unsubscribes on teardown). Process.stdout carries both. */
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}
/** Injectable seams for runTui: a terminal stand-in plus the self-reload watch's seams
 * (self-reload.ts's injectables) and the re-exec itself — the same treatment startGui got —
 * and the supervised child's supervisor watch. Production callers omit it and get the real
 * terminal, the real disk-stamp poll, the real reexecSelf and the real parent pid; tests
 * inject fakes so the reload wiring (trigger → wake the loop → teardown → re-exec at most
 * once) and the orphan wiring (supervisor gone → the same teardown, no re-exec) are
 * assertable without a terminal. */
export interface TuiSeams {
  stdin?: TuiStdin;
  stdout?: TuiStdout;
  watch?: ReloadWatchSeams & { reexec?: () => void };
  supervisor?: SupervisorWatchSeams;
  /** When a hosted run (`run --tui`) must end this TUI from outside — the supervising run's
   * window (`--for`) closes or the team stops — the supervisor aborts this signal and the
   * TUI takes the same quit teardown a keypress does (restoring the cursor and raw mode).
   * A standalone `tumwater tui` passes none, so its lifecycle is unchanged. */
  abortSignal?: AbortSignal;
  /** A hosted run (`run --tui`) hosts this TUI inside its supervisor, which — like a plain
   * `run` supervisor — never re-execs onto a new build; it respawns its team children
   * instead. So the host disables the self-reload watch: a standalone `tumwater tui` re-execs
   * so a long-lived observer picks up team code changes, but a hosted TUI must not — its
   * watch would otherwise fire on the team's own first self-redeploy dist swap, resolve this
   * promise and read as a quit (aborting the run's controller), and spawn a re-exec
   * replacement the dying supervisor would then kill. A hosted TUI stays on the build the
   * supervisor runs, exactly as the supervisor itself does, and gets fresh code on the next
   * run. Omit it (or leave false) for a standalone `tumwater tui`, whose reload is unchanged. */
  reloadDisabled?: boolean;
}

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string, seams: TuiSeams = {}): Promise<void> {
  const stdin = seams.stdin ?? (process.stdin);
  const stdout = seams.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(tuiTerminalError(Boolean(stdin.isTTY), Boolean(stdout.isTTY)));
  }
  // The no-color.org convention (no-color.org): a set, non-empty variable drops every color —
  // the ink tree takes the terminal's default for every span.
  const noColor = (process.env.NO_COLOR ?? "") !== "";

  // Auto-reload onto a newer compiled tree as soon as one lands on disk (redeploy's dist swap
  // or a manual build). The watch's trigger takes the same teardown path Ctrl+C does, then
  // re-execs after the terminal is restored. `reloadRequested` closes the
  // trigger-before-await race either way.
  let reloadRequested = false;
  let resolveMain: (() => void) | null = null;
  // A hosted run disables the reload watch (see TuiSeams.reloadDisabled): only the host
  // supervisor may survive a self-redeploy, and it respawns its team children rather than
  // re-execing. When disabled, no watch is created, so a dist swap under a hosted TUI never
  // resolves this promise or spawns a replacement.
  const reloadDisabled = seams.reloadDisabled === true;
  const reloadWatch = reloadDisabled
    ? undefined
    : createReloadWatch({
        root,
        startupInfo: captureStartupBuild(),
        ...seams.watch,
        onTrigger: () => {
          reloadRequested = true;
          resolveMain?.();
        },
      });
  if (reloadWatch) void reloadWatch.start();
  // A reloaded child whose reload supervisor died outright no longer owns the terminal the
  // shell has taken back: it takes the quit teardown (restoring the cursor and raw mode) and
  // ends, with no re-exec. `supervisorGone` closes the same race `reloadRequested` does.
  let supervisorGone = false;
  const stopSupervisorWatch = watchReloadSupervisor(() => {
    supervisorGone = true;
    resolveMain?.();
  }, seams.supervisor);
  // A hosted run can end the TUI from outside (see TuiSeams.abortSignal): the supervisor
  // aborts when its run is over, closing the TUI the same way a quit keypress does. The
  // listener is registered here, before the main await, so an abort that fires mid-run
  // resolves it; one already set before mount is caught by the executor's `aborted` check.
  if (seams.abortSignal) {
    seams.abortSignal.addEventListener("abort", () => resolveMain?.(), { once: true });
  }

  // The framework-free keypress handler (src/ui/tui/tui-keys.ts, extracted from runTui): it owns
  // every mutable local the dispatch used to keep in this closure; render syncs snapshot
  // data and line budgets in and reads the resulting state out each frame.
  const keys = createTuiKeys({ root, quit: () => resolveMain?.(), requestRender: () => render() });

  // Every rendered line is clipped to the terminal width (clipToWidth), so one logical
  // line is always one visual line and the height budget below is exact — nothing wraps,
  // nothing scrolls the table off the top.

  const render = () => {
    // A pty whose window size was never set reports 0×0 (macOS `script`, some CI pty
    // allocators): `||` degrades that to the same sane defaults an unset size gets, while
    // `??` would pass the reported 0 through as a real size and clip every line to empty.
    const rows = stdout.rows || 40;
    const width = stdout.columns || 120;
    const snap = snapshot(root);
    const status = renderStatusSpans(root, snap, width);
    // Whether the director has work in flight is Ctrl+C's interrupt gate (tui-keys.ts): the
    // render already computes the per-loop rows, so it feeds them back rather than re-deriving.
    // The row's `inFlight` flag is the permit-holder set, which deliberately excludes the
    // exempt director's own `director working` tick (BUGS.md 2026-10-06), so accept that phase
    // too — the same live set the GUI's row actions read. A director merge still carries
    // `merge …` (inFlight true) because loopPhase checks the merge marker first.
    const director = status.loops.find((r) => r.role === "director");
    keys.syncSnapshot(snap.budget.capUsd, snap.budget.free, snap.loops.map((l) => l.role),
      director?.inFlight === true || director?.phase.startsWith("director working") === true);
    const s = keys.state(); // the handler's state this frame renders
    const roleIds = s.roleIds;
    const view = s.view;
    // What needs the operator — the dashboard's alert banners (team-alerts.ts's teamAlerts), as
    // attention lines under the header. Each consumes one line of the height budget.
    const attention = alertLines(teamAlerts(snap, openQuestions(root), status.loops, Date.now(), refusedEntryTitles(root)), width);
    const statusLines = [status.lines[0] ?? [], ...attention, ...status.lines.slice(1)];
    // Numbered previews of prompts queued for the director, between the table and the
    // activity pane: what will run next, in execution order. Each line consumes exactly
    // one line of the budget, like the attention lines above.
    const queued = snap.inboxPrompts;
    const eventBudget = Math.max(3, rows - statusLines.length - 6 - queued.length);
    const entryBudget = Math.max(1, eventBudget - 1);
    keys.setLineBudgets(eventBudget, entryBudget);
    // The pane occupies one tab-strip line plus at most eventBudget clipped lines, so the
    // height-budget math is the same in every view.
    const role = view > 0 && view <= roleIds.length ? roleIds[view - 1] : undefined; // defined: view is clamped above
    const pane: TuiView = role
      ? { kind: "transcript", role, index: view, count: roleIds.length, note: s.noteMode, change: s.changeMode }
      : view === roleIds.length + 1 ? { kind: "backlog" }
        : view === roleIds.length + 2 ? { kind: "usage", scope: s.scopeRole, window: s.reportSince }
          : view === roleIds.length + 3 ? { kind: "failures", scope: s.scopeRole, window: s.reportSince }
            : view === roleIds.length + 4 ? { kind: "history", since: s.historySince, result: s.historyResult, role: s.historyRole, grep: s.historyGrep, trail: s.trailMode, summary: s.historySummary }
              : view === roleIds.length + 5 ? { kind: "pending" }
                : view === roleIds.length + 6 ? { kind: "queued" }
                : view === roleIds.length + 7 ? { kind: "health", problems: s.healthProblems }
                : view === roleIds.length + 8 ? { kind: "brief" }
                  : { kind: "activity", role: s.activityRole, grep: s.activityGrep, type: s.activityType };
    // The pane's body lines (tui-pane.ts, extracted from this closure): transcripts, the
    // backlog views, usage/failures, or activity, composed at this frame's budgets.
    const paneResult = paneBody(pane, { root, width, eventBudget, entryBudget, state: s });
    const body = paneResult.body;
    const emptyNote = paneResult.emptyNote;

    // The frame as the ink tree draws it (tui-app.tsx): the same composed lines the
    // hand-painted string frame joined, as clipped StatusLines — one column row per line,
    // one styled Text per span, colors through tui-app.tsx's toneColor.
    const mode = { budget: s.budgetMode, concurrencyMode: s.concurrencyMode, fallbackMode: s.fallbackMode, rolePromptFor: s.rolePromptFor, attachMode: s.attachMode, pauseEditMode: s.pauseEditMode, pauseEditRole: s.pauseEditRole, pauseEditWake: s.pauseEditWake, pauseEditStop: s.pauseEditStop, queuedEditFor: s.queuedEditFor, answerFor: s.answerFor, entryEditFor: s.entryEditFor, notesEditFor: s.notesEditFor, briefEditMode: s.briefEditMode, retireMode: s.retireMode, quietMode: s.quietMode, quietTeam: s.quietTeam, providerCapsMode: s.providerCapsMode, intervalMode: s.intervalMode, instructionsEditFor: s.instructionsEditFor, slotsMode: s.slotsMode, images: s.images, notifyMode: s.notifyMode, backendsMode: s.backendsMode };
    const lines: StatusLine[] = [...statusLines, []]; // a blank row below the header
    for (const [i, preview] of queued.entries()) lines.push(toneLine(`${i + 1}. ${preview}`, width));
    lines.push(tabStrip(pane, width));
    if (body.length) lines.push(...body);
    else lines.push(toneLine(emptyNote, width, "dim"));
    lines.push([]); // a blank row above the flash/hint block
    if (s.flash) lines.push(toneLine(s.flash, width, "bold"));
    lines.push(hintLine(pane, mode, width));
    // The prompt line names its target, like the dashboard's composer; long prompts window
    // around the cursor so its position stays visible.
    const prefix = promptPrefix(mode);
    lines.push([...prefix, { text: renderInputView(s.input, s.cursor, width - prefixWidth(prefix) + 2) }]);
    // The terminal boundary: every composed line, from every builder, loses terminal control
    // characters here (tui-frame.ts's sanitizeFrameLines) so model-written text cannot drive
    // the operator's terminal. Kept out of the builders so the status payload/--json data
    // surfaces, which reuse their inputs, stay byte-exact.
    const frame: TuiAppView = { lines: sanitizeFrameLines(lines) };
    inkApp.rerender(<TuiApp view={frame} noColor={noColor} keys={keys} />);
  };

  // Ink renders the frame (tui-app.tsx) into the same stdout every earlier frame went to,
  // and claims the terminal's stdin: the useTuiKeys hook inside the tree parses keys via
  // ink's `useInput` and dispatches them through the extracted handler (tui-keys.ts).
  // exitOnCtrlC is false because the TUI owns its own keys: Ctrl+D quits and Ctrl+C
  // interrupts the director's in-flight tick (tui-keys.ts); console patching stays
  // off so console.* keeps writing past the TUI exactly as before it; and the render is
  // unthrottled (maxFps 0) because the loop drives rendering itself — once a second and
  // on each keypress — so ink's fps limiter would only defer frames this loop already
  // schedules deliberately. `interactive: true` pins the TUI's frame diffing on in every
  // environment (CI detection would otherwise flip ink into non-interactive mode).
  const inkApp = inkRender(<TuiApp view={{ lines: [] }} noColor={noColor} keys={keys} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    maxFps: 0,
  });

  // The useTuiKeys hook inside the tree set raw mode on mount (and restores it at unmount).
  // Raw mode appears once ink's tree effects have mounted; production terminals type long
  // after that, and the test harness waits a tick before pressing keys.
  const timer = setInterval(render, 1000);
  render();

  await new Promise<void>((resolve) => {
    resolveMain = resolve;
    // The reload trigger, the supervisor watch, or a hosted run's abort may have fired between
    // `start()` and this await; the executor resolves immediately in that case so all orderings
    // reach the same teardown.
    if (reloadRequested || supervisorGone || seams.abortSignal?.aborted) resolve();
  });

  clearInterval(timer);
  inkApp.unmount(); // restore the cursor and raw mode; the newline below closes it
  stdout.write("\n");
  reloadWatch?.stop();
  stopSupervisorWatch();
  // A hosted TUI (reloadDisabled) never set reloadRequested; only a standalone reload does.
  if (!reloadDisabled && reloadRequested && !supervisorGone) (seams.watch?.reexec ?? reexecSelf)();
}
