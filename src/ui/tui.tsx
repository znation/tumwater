import readline from "node:readline";
import { render as inkRender } from "ink";
import { TuiApp, type TuiAppView } from "./tui-app.js";
import {
  type BacklogEntry,
  openBugEntries,
  openQuestionEntries,
  openQuestions,
  plannedPlanEntries,
} from "../backlog.js";
import { readEvents } from "../event-read.js";
import { formatEvent } from "../event-format.js";
import { snapshot } from "../status-data.js";
import { renderStatusSpans, type StatusLine } from "./status-render.js";
import { fleetAlerts } from "./fleet-alerts.js";
import { readTranscript } from "./transcript.js";
import {
  captureStartupBuild,
  createReloadWatch,
  reexecSelf,
  type ReloadWatchSeams,
} from "../self-reload.js";
import {
  renderInputView,
  tuiTerminalError,
} from "./tui-input.js";
import { createTuiKeys } from "./tui-keys.js";
import {
  backlogLines,
  entryBodyWindow,
} from "./tui-backlog.js";
import {
  alertLines,
  eventTone,
  hintLine,
  prefixWidth,
  promptPrefix,
  tabStrip,
  toneLine,
  transcriptTone,
  type TuiView,
} from "./tui-frame.js";

/** The half of a terminal the TUI actually touches: raw mode, keypresses, and the size the
 * renderer clips to. Production reads process.stdin/stdout; tests inject fakes so the loop
 * is driven without a TTY. */
export interface TuiStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode(mode: boolean): void;
  resume?(): void;
  pause?(): void;
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
 * (self-reload.ts's injectables) and the re-exec itself — the same treatment startGui got.
 * Production callers omit it and get the real terminal, the real disk-stamp poll, and the
 * real reexecSelf; tests inject fakes so the reload wiring (trigger → wake the loop →
 * teardown → re-exec at most once) is assertable without a terminal. */
export interface TuiSeams {
  stdin?: TuiStdin;
  stdout?: TuiStdout;
  watch?: ReloadWatchSeams & { reexec?: () => void };
}

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string, seams: TuiSeams = {}): Promise<void> {
  const stdin = seams.stdin ?? (process.stdin as TuiStdin);
  const stdout = seams.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(tuiTerminalError(Boolean(stdin.isTTY), Boolean(stdout.isTTY)));
  }
  // The no-color.org convention, as resolveStyles states it: a set, non-empty variable
  // drops every color — the ink tree takes the terminal's default for every span.
  const noColor = (process.env.NO_COLOR ?? "") !== "";

  // Auto-reload onto a newer compiled tree as soon as one lands on disk (redeploy's dist swap
  // or a manual build). The watch's trigger takes the same teardown path Ctrl+C does, then
  // re-execs after the terminal is restored. Arming it only after the TTY guard matters: a
  // non-TTY start throws, and a process about to throw must not re-exec into the same error.
  // It is armed in the background (not awaited) so the keypress handler still registers
  // synchronously; `reloadRequested` closes the trigger-before-await race either way.
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

  // The framework-free keypress handler (src/ui/tui-keys.ts, extracted verbatim): it owns
  // every mutable local the dispatch used to keep in this closure; render syncs snapshot
  // data and line budgets in and reads the resulting state out each frame.
  const keys = createTuiKeys({ root, quit: () => resolveMain?.(), requestRender: () => render() });

  // The last frame written to the terminal: the per-second re-render only rewrites the
  // Ink's log-update skips the write when a re-render composes an identical frame, so
  // an idle fleet's per-second repaint (its "· 3m ago" age cells change only once a
  // minute) costs no terminal I/O at all — the same redundant-repaint guard the GUI's
  // detail panel skip removed (the dashboard's innerHTML guard). Changed frames rewrite
  // only the changed lines: ink diff-renders, so the full-screen `\x1b[2J` clear — the
  // flicker BUGS.md recorded — is gone entirely.

  // The project-status pane's flat entry list (plans, then bugs, then questions), read fresh —
  // shared by render and the keypress handlers so stale-selection clamping cannot drift.
  const flatEntries = (): Array<{ label: string } & BacklogEntry> => [
    ...plannedPlanEntries(root).map((e) => ({ label: "plan", ...e })),
    ...openBugEntries(root).map((e) => ({ label: "bug", ...e })),
    ...openQuestionEntries(root).map((e) => ({ label: "question", ...e })),
  ];

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
    keys.syncSnapshot(snap.budget.capUsd, snap.budget.free, snap.loops.map((l) => l.role));
    const s = keys.state(); // the handler's state this frame renders
    const roleIds = s.roleIds;
    const view = s.view;
    const status = renderStatusSpans(root, snap, width);
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
    let body: StatusLine[];
    let emptyNote = "(no events yet)";
    if (pane.kind === "transcript") {
      body = readTranscript(root, pane.role, eventBudget).slice(-eventBudget).map((l) => toneLine(l, width, transcriptTone(l)));
      emptyNote = "(no transcript yet)";
    } else if (pane.kind === "backlog") {
      // Planned features, open bugs, and open questions from PLANS.md/BUGS.md/QUESTIONS.md,
      // read fresh each render like events. Keeps the HEAD of the list when it overflows —
      // file order is newest-first, unlike events which keep the tail.
      const planEntries = plannedPlanEntries(root);
      const bugEntries = openBugEntries(root);
      const questionEntries = openQuestionEntries(root);
      const flat = s.selectedEntry === null ? [] : flatEntries();
      const sel = s.selectedEntry === null || flat.length === 0 ? null : Math.min(s.selectedEntry, flat.length - 1);
      if (sel === null) {
        // List mode (and a stale selection with no entries left falls back to it): section
        // headings stand out, empty sections read dim.
        body = backlogLines(planEntries.map((e) => e.title), bugEntries.map((e) => e.title), questionEntries.map((e) => e.title))
          .slice(0, eventBudget)
          .map((l) => toneLine(l, width, /^(?:plans|open bugs|open questions) \(\d+\):$/.test(l) ? "bold" : l.startsWith("(") ? "dim" : undefined));
      } else {
        // Entry browsing: the selected entry's full body under a line naming its section and
        // title. A stale selection (an entry removed since the last render) clamps to the last.
        const e = flat[sel]!;
        const win = entryBodyWindow(e.body, s.entryScroll, entryBudget, width);
        body = [toneLine(`${e.label}: ${e.title}`, width, "bold"), ...win.lines.map((l) => toneLine(l, width))];
      }
    } else if (pane.kind === "usage" || pane.kind === "failures") {
      // The Markdown `tumwater report` prints, windowed like backlog entry mode. The cache is
      // set on view entry by the Ctrl+T handler, so this only re-windows a string.
      const win = entryBodyWindow(s.paneCache ?? "", s.paneScroll, eventBudget, width);
      body = win.lines.map((l) => toneLine(l, width, l.startsWith("#") ? "bold" : undefined));
    } else {
      body = readEvents(root, eventBudget).map((e) => toneLine(formatEvent(e), width, eventTone(e))).slice(-eventBudget);
    }

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
    inkApp.rerender(<TuiApp view={frame} noColor={noColor} />);
  };

  // readline's emitter setup only accepts a ReadStream; the fake terminal carries the same
  // surface (an EventEmitter the test drives keypresses through), so the seam is widened here.
  // Ink renders the frame (tui-app.tsx) into the same stdout every earlier frame went to.
  // Key handling is untouched: with no useInput hook mounted, ink claims no stdin, so the
  // readline keypress setup below keeps sole ownership of the terminal's input.
  // exitOnCtrlC is false because Ctrl+C is the TUI's own quit key; console patching stays
  // off so console.* keeps writing past the TUI exactly as before it; and the render is
  // unthrottled (maxFps 0) because the loop drives rendering itself — once a second and
  // on each keypress — so ink's fps limiter would only defer frames this loop already
  // schedules deliberately. `interactive: true` pins the TUI's frame diffing on in every
  // environment (CI detection would otherwise flip ink into non-interactive mode).
  const inkApp = inkRender(<TuiApp view={{ lines: [] }} noColor={noColor} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    maxFps: 0,
  });

  readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadStream);
  stdin.setRawMode(true);
  stdin.resume?.();

  const timer = setInterval(render, 1000);
  render();

  await new Promise<void>((resolve) => {
    resolveMain = resolve;
    // The reload trigger may have fired between `start()` and this await; the executor
    // resolves immediately in that case so both orderings reach the same teardown.
    if (reloadRequested) resolve();
    stdin.on("keypress", (str: string | undefined, key: readline.Key) =>
      keys.handleKey(str, key),
    );
  });

  clearInterval(timer);
  stdin.setRawMode(false);
  stdin.pause?.();
  inkApp.unmount(); // restore the cursor and drop the frame; the newline below closes it
  stdout.write("\n");
  reloadWatch.stop();
  if (reloadRequested) (seams.watch?.reexec ?? reexecSelf)();
}
