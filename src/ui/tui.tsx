import { render as inkRender } from "ink";
import { TuiApp, type TuiAppView } from "./tui-app.js";
import { openQuestions } from "../backlog/backlog.js";
import { snapshot } from "../status/status-data.js";
import { renderStatusSpans, type StatusLine } from "./status-render.js";
import { fleetAlerts } from "./fleet-alerts.js";
import {
  captureStartupBuild,
  createReloadWatch,
  reexecSelf,
  type ReloadWatchSeams,
  type SupervisorWatchSeams,
  watchReloadSupervisor,
} from "../redeploy/self-reload.js";
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
}

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string, seams: TuiSeams = {}): Promise<void> {
  const stdin = seams.stdin ?? (process.stdin as TuiStdin);
  const stdout = seams.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(tuiTerminalError(Boolean(stdin.isTTY), Boolean(stdout.isTTY)));
  }
  // The no-color.org convention (no-color.org): a set, non-empty variable drops every color — the ink tree takes the terminal's default for every span.
  const noColor = (process.env.NO_COLOR ?? "") !== "";

  // Auto-reload onto a newer compiled tree as soon as one lands on disk (redeploy's dist swap
  // or a manual build). The watch's trigger takes the same teardown path Ctrl+C does, then
  // re-execs after the terminal is restored. `reloadRequested` closes the
  // trigger-before-await race either way.
  let reloadRequested = false;
  let resolveMain: (() => void) | null = null;
  const reloadWatch = createReloadWatch({
    root,
    startupInfo: captureStartupBuild(),
    ...seams.watch,
    onTrigger: () => {
      reloadRequested = true;
      resolveMain?.();
    },
  });
  void reloadWatch.start();
  // A reloaded child whose reload supervisor died outright no longer owns the terminal the
  // shell has taken back: it takes the quit teardown (restoring the cursor and raw mode) and
  // ends, with no re-exec. `supervisorGone` closes the same race `reloadRequested` does.
  let supervisorGone = false;
  const stopSupervisorWatch = watchReloadSupervisor(() => {
    supervisorGone = true;
    resolveMain?.();
  }, seams.supervisor);

  // The framework-free keypress handler (src/ui/tui-keys.ts, extracted from runTui): it owns
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
    // The director row's in-flight flag is Ctrl+C's interrupt gate (tui-keys.ts): the render
    // already computes the per-loop rows, so it feeds the flag back rather than re-deriving it.
    keys.syncSnapshot(snap.budget.capUsd, snap.budget.free, snap.loops.map((l) => l.role),
      status.loops.find((r) => r.role === "director")?.inFlight === true);
    const s = keys.state(); // the handler's state this frame renders
    const roleIds = s.roleIds;
    const view = s.view;
    // What needs the operator — the dashboard's alert banners (fleet-alerts.ts's fleetAlerts), as
    // attention lines under the header. Each consumes one line of the height budget.
    const attention = alertLines(fleetAlerts(snap, openQuestions(root), status.loops, Date.now()), width);
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
      ? { kind: "transcript", role, index: view, count: roleIds.length }
      : view === roleIds.length + 1 ? { kind: "backlog" }
        : view === roleIds.length + 2 ? { kind: "usage" }
          : view === roleIds.length + 3 ? { kind: "failures" }
            : { kind: "activity" };
    // The pane's body lines (tui-pane.ts, extracted from this closure): transcripts, the
    // backlog views, usage/failures, or activity, composed at this frame's budgets.
    const paneResult = paneBody(pane, { root, width, eventBudget, entryBudget, state: s });
    const body = paneResult.body;
    const emptyNote = paneResult.emptyNote;

    // The frame as the ink tree draws it (tui-app.tsx): the same composed lines the
    // hand-painted string frame joined, as clipped StatusLines — one column row per line,
    // one styled Text per span, colors through tui-app.tsx's toneColor.
    const mode = { budget: s.budgetMode, rolePromptFor: s.rolePromptFor };
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
    const frame: TuiAppView = { lines };
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
    // The reload trigger (or the supervisor watch) may have fired between `start()` and this
    // await; the executor resolves immediately in that case so both orderings reach the same
    // teardown.
    if (reloadRequested || supervisorGone) resolve();
  });

  clearInterval(timer);
  inkApp.unmount(); // restore the cursor and raw mode; the newline below closes it
  stdout.write("\n");
  reloadWatch.stop();
  stopSupervisorWatch();
  if (reloadRequested && !supervisorGone) (seams.watch?.reexec ?? reexecSelf)();
}
