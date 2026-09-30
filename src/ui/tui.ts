import readline from "node:readline";
import {
  type BacklogEntry,
  openBugEntries,
  openQuestionEntries,
  openQuestions,
  plannedPlanEntries,
} from "../backlog.js";
import { readEvents } from "../events.js";
import { collectReport } from "../report-data.js";
import { renderReportMarkdown } from "./report.js";
import { REPORT_DEFAULT_DAYS } from "../event-window.js";
import { collectFailureReport } from "../failure-data.js";
import { renderFailureMarkdown } from "../failure-report.js";
import { formatEvent } from "../event-format.js";
import { submitPrompt } from "../inbox.js";
import { setDailyBudgetUsd } from "../config-write.js";
import { pausedRoles, pauseRole, resumeRole } from "../fleet-state.js";
import {
  requestAbort,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  submitRolePromptAndWake,
} from "../operator-commands.js";
import { snapshot } from "./status.js";
import { renderStatusSpans, type StatusLine } from "./status-render.js";
import { fleetAlerts } from "./fleet-alerts.js";
import { errorMessage, usdCap } from "../text.js";
import { readTranscript } from "./transcript.js";
import {
  captureStartupBuild,
  createReloadWatch,
  reexecSelf,
  type ReloadWatchSeams,
} from "./self-reload.js";
import {
  applyKey,
  parseBudgetInput,
  parseRolePromptInput,
  renderInputView,
  tuiTerminalError,
} from "./tui-input.js";
import {
  backlogLines,
  entryBodyWindow,
  moveEntrySelection,
  stepEntryScroll,
} from "./tui-backlog.js";
import {
  alertLines,
  eventTone,
  hintLine,
  paintLine,
  prefixWidth,
  promptPrefix,
  resolveStyles,
  tabStrip,
  toneLine,
  transcriptTone,
  type TuiView,
} from "./tui-frame.js";

/** How long a TUI flash notice stays visible (ms). */
const FLASH_MS = 3000;

const CLEAR = "\x1b[2J\x1b[H";

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
  const styles = resolveStyles(process.env.NO_COLOR);

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

  let input = "";
  let cursor = 0;
  // Ctrl+B budget-edit mode on the prompt line: while set, the line edits the daily cost cap
  // (pre-filled with the current cap — empty when disabled) instead of a director prompt.
  // The previous prompt text is saved so leaving the mode restores it byte-for-byte.
  let budgetMode = false;
  let savedInput = "";
  let savedCursor = 0;
  // Ctrl+R role-prompt mode on the prompt line: while set (to the viewed loop's role id), the
  // line edits a prompt for that one loop instead of a director prompt. It keeps its OWN saved
  // pair, separate from budget mode's: the two modes are mutually exclusive (each refuses to
  // open while the other holds the line), and with separate pairs neither can clobber the
  // other's saved draft even if a guard is ever loosened.
  let rolePromptFor: string | null = null;
  let roleSavedInput = "";
  let roleSavedCursor = 0;
  // The last snapshot's cap, captured by render so the Ctrl+B handler can pre-fill without
  // re-reading config itself (render already polls snapshot every second).
  let currentCapUsd = 0;
  // The last snapshot's free flag: true when every model the fleet could use is unpriced,
  // so a cap could never bind — the Ctrl+B handler flashes a notice instead of opening
  // the editor (BUGS.md 2026-09-14), leaving the prompt line untouched.
  let currentBudgetFree = false;
  let flash = "";
  let flashUntil = 0;
  // Flash a one-line notice on the prompt line: the single owner of the message+expiry
  // pair, so every notice expires on the same clock and no keypress branch grows its
  // own copy of the two assignments.
  const flashMessage = (message: string): void => {
    flash = message;
    flashUntil = Date.now() + FLASH_MS;
  };
  // The activity pane cycles: 0 = recent events, then one transcript per loop, then project
  // status (planned features + open bugs + open questions), then the usage report — Ctrl+T.
  let view = 0;
  // The project-status pane's entry selection (null = list mode): the flat index of the
  // entry shown in full — plans first, then bugs, then questions. Cleared on every Ctrl+T,
  // so cycling back into the view always starts at today's heading list.
  let selectedEntry: number | null = null;
  // The within-body scroll offset (line index of the window head, 0 = head) for the selected
  // entry's body — PgDn/PgUp in project-status entry mode. Reset whenever the selection
  // changes or clears, so every newly opened entry starts at its head.
  let entryScroll = 0;
  // The Markdown panes' (usage report, failures) rendered bodies, computed once per activation:
  // the Ctrl+T handler sets it when cycling into either pane and nulls it on leaving.
  // collectReport/collectFailureReport tail-scan events.jsonl, so they must not run on every
  // second's re-render — those only re-window this string.
  let paneCache: string | null = null;
  // The within-body scroll offset (line index of the window head) shared by the two Markdown
  // panes — PgDn/PgUp there. Reset to the head whenever the view is entered, like entryScroll.
  let paneScroll = 0;
  // The activity pane's current line budget, refreshed by every render so keypress handlers
  // can page within it without re-deriving the height math. An open backlog entry spends the
  // pane's first line on its title, so its body pages by one line less (entryBudget).
  let eventBudget = 0;
  let entryBudget = 0;
  let roleIds: string[] = [];
  // The last frame written to the terminal: the per-second re-render only rewrites the
  // screen when the composed frame actually differs. An idle fleet's frame changes only
  // once a minute (the "· 3m ago" age cells' granularity), so without this the TUI
  // repaints an identical screen ~59 times a minute for nothing — the same redundant
  // per-second repaint the GUI's detail panel skip removed (the dashboard's innerHTML
  // guard). In-flight ticks keep repainting every second: their working cells carry
  // second-granularity elapsed times, so the frame genuinely differs.
  let lastFrame: string | null = null;

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
    currentCapUsd = snap.budget.capUsd;
    currentBudgetFree = snap.budget.free;
    roleIds = snap.loops.map((s) => s.role);
    view = Math.min(view, roleIds.length + 3); // clamp a stale index if roles changed
    const status = renderStatusSpans(root, snap, width);
    // What needs the operator — the dashboard's alert banners (fleet-alerts.ts's fleetAlerts), as
    // attention lines under the header. Each consumes one line of the height budget.
    const attention = alertLines(fleetAlerts(snap, openQuestions(root), status.loops, Date.now()), width);
    const statusLines = [status.lines[0] ?? [], ...attention, ...status.lines.slice(1)];
    // Numbered previews of prompts queued for the director, between the table and the
    // activity pane: what will run next, in execution order. Each line consumes exactly
    // one line of the budget, like the attention lines above.
    const queued = snap.inboxPrompts;
    eventBudget = Math.max(3, rows - statusLines.length - 6 - queued.length);
    entryBudget = Math.max(1, eventBudget - 1);
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
      const flat = selectedEntry === null ? [] : flatEntries();
      const sel = selectedEntry === null || flat.length === 0 ? null : Math.min(selectedEntry, flat.length - 1);
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
        const win = entryBodyWindow(e.body, entryScroll, entryBudget, width);
        body = [toneLine(`${e.label}: ${e.title}`, width, "bold"), ...win.lines.map((l) => toneLine(l, width))];
      }
    } else if (pane.kind === "usage" || pane.kind === "failures") {
      // The Markdown `tumwater report` prints, windowed like backlog entry mode. The cache is
      // set on view entry by the Ctrl+T handler, so this only re-windows a string.
      const win = entryBodyWindow(paneCache ?? "", paneScroll, eventBudget, width);
      body = win.lines.map((l) => toneLine(l, width, l.startsWith("#") ? "bold" : undefined));
    } else {
      body = readEvents(root, eventBudget).map((e) => toneLine(formatEvent(e), width, eventTone(e))).slice(-eventBudget);
    }

    const mode = { budget: budgetMode, rolePromptFor };
    const parts = [...statusLines.map((l) => paintLine(styles, l)), ""];
    for (const [i, preview] of queued.entries()) parts.push(paintLine(styles, toneLine(`${i + 1}. ${preview}`, width)));
    parts.push(paintLine(styles, tabStrip(pane, width)));
    parts.push(body.length ? body.map((l) => paintLine(styles, l)).join("\n") : paintLine(styles, toneLine(emptyNote, width, "dim")));
    parts.push("");
    if (flash && Date.now() < flashUntil) parts.push(paintLine(styles, toneLine(flash, width, "bold")));
    parts.push(paintLine(styles, hintLine(pane, mode, width)));
    // The prompt line names its target, like the dashboard's composer; long prompts window
    // around the cursor so its position stays visible.
    const prefix = promptPrefix(mode);
    parts.push(paintLine(styles, prefix) + renderInputView(input, cursor, width - prefixWidth(prefix) + 2));
    const frame = CLEAR + parts.join("\n");
    if (frame === lastFrame) return; // Unchanged screen: rewriting it only costs terminal I/O.
    lastFrame = frame;
    stdout.write(frame);
  };

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    input = savedInput;
    cursor = savedCursor;
  };

  // Leave role-prompt mode (Esc, Ctrl+R again, or Ctrl+T): restore the saved prompt text.
  const exitRolePromptMode = (): void => {
    if (!rolePromptFor) return;
    rolePromptFor = null;
    input = roleSavedInput;
    cursor = roleSavedCursor;
  };

  // readline's emitter setup only accepts a ReadStream; the fake terminal carries the same
  // surface (an EventEmitter the test drives keypresses through), so the seam is widened here.
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
    stdin.on("keypress", (str: string | undefined, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        resolve();
        return;
      }
      if (key.ctrl && key.name === "b") {
        // Ctrl+B toggles budget-edit mode on the prompt line (mnemonic for *b*udget): entering
        // pre-fills the current cap (empty when disabled — empty means "no cap" on save) and
        // saves the prompt text; leaving restores it. Esc cancels the same way.
        if (rolePromptFor) {
          // Mutually exclusive with role-prompt mode: the two editors share one prompt line,
          // so a mode may not enter while the other holds it. Flash the way out instead of
          // silently dropping either mode's saved draft.
          flashMessage(`finish or cancel the prompt for ${rolePromptFor} first (Esc cancels)`);
          render();
          return;
        }
        if (budgetMode) {
          exitBudgetMode();
        } else if (currentBudgetFree) {
          // An all-free fleet has no spend a cap could bind: the editor would pre-fill a
          // value that can never take effect, so Ctrl+B flashes a one-line notice and
          // leaves the prompt line untouched (toggle/Esc logic unchanged).
          flashMessage("budget n/a — all models free");
        } else {
          savedInput = input;
          savedCursor = cursor;
          budgetMode = true;
          input = currentCapUsd > 0 ? String(currentCapUsd) : "";
          cursor = input.length;
          flashMessage("edit daily cost budget (USD): Enter to save, Esc to cancel");
        }
        render();
        return;
      }
      // Per-loop controls on the transcript pane (PLANS.md "TUI per-loop controls"): Ctrl+P
      // toggles the viewed loop's pause, Ctrl+A aborts its in-flight tick, Ctrl+W wakes it,
      // and Ctrl+R opens the role-prompt editor for it (PLANS.md "Per-role prompts 2/2").
      // They call the same marker-writing/submit cores the CLI's --role flags do, so the
      // surfaces cannot drift on marker format, idempotence, or wording. Guarded to the
      // transcript views and out of budget-edit mode; everywhere else the keys fall through
      // (applyKey drops ctrl-key presses, so they stay inert and never edit the prompt line).
      // Every branch is a disk write that can fail (a lock timeout, a torn fs), and an
      // unguarded throw would escape this keypress handler and kill the TUI — flash the
      // reason instead, the same contract the prompt-submit path below honors.
      if (
        !budgetMode &&
        roleIds.length > 0 &&
        view >= 1 && view <= roleIds.length &&
        key.ctrl && (key.name === "p" || key.name === "a" || key.name === "w" || key.name === "r")
      ) {
        const role = roleIds[view - 1]!; // defined: view is clamped inside the transcript range
        try {
          if (key.name === "r") {
            // Ctrl+R toggles role-prompt mode for the viewed loop (mnemonic: p**R**ompt —
            // Ctrl+P is taken by pause): entering saves the director draft in this mode's own
            // pair and blanks the line; entering again (or Esc) restores it. Mutually
            // exclusive with budget mode by the outer guard and the mirrored refusal in the
            // Ctrl+B branch.
            if (rolePromptFor) {
              exitRolePromptMode();
              flashMessage("role prompt cancelled");
            } else {
              roleSavedInput = input;
              roleSavedCursor = cursor;
              rolePromptFor = role;
              input = "";
              cursor = 0;
              flashMessage(`prompt for ${role}: Enter to send, Esc to cancel`);
            }
          } else if (key.name === "p") {
            // Toggle by the marker's current state, read fresh: pauseRole/resumeRole's false
            // return means another window raced us to the same state, and the wording
            // helpers render that honestly — the changed-state contract the CLI prints.
            const paused = pausedRoles(root).includes(role);
            const changed = paused ? resumeRole(root, role) : pauseRole(root, role);
            flashMessage(
              paused
                ? roleResumeMessage(root, role, changed)
                : rolePauseMessage(root, role, changed),
            );
          } else if (key.name === "a") {
            const result = requestAbort(root, role);
            flashMessage(result.ok ? result.message : `error: ${result.error}`);
          } else {
            flashMessage(requestWake(root, [role]));
          }
        } catch (err) {
          flashMessage(`error: ${errorMessage(err)}`);
        }
        render();
        return;
      }
      if (key.ctrl && key.name === "t") {
        // Ctrl+T exits budget-edit mode too — view cycling is orthogonal to it, so a cycle
        // never strands the editor with its pre-filled cap in the prompt line. Role-prompt
        // mode composes the same way: cycling away restores the saved director draft.
        exitBudgetMode();
        exitRolePromptMode();
        view = (view + 1) % (roleIds.length + 4); // events → each loop's transcript → project status → usage report → failures → events
        selectedEntry = null; // leaving a view drops any entry selection…
        entryScroll = 0; // …and its within-body scroll, so re-entering starts at the list/head
        paneScroll = 0; // the Markdown panes always re-enter at their head
        // Compute the pane's Markdown once per activation (this handler renders immediately), and
        // drop it on leaving — a visit's first frame is fresh, later frames only re-window.
        paneCache =
          view === roleIds.length + 2
            ? renderReportMarkdown(collectReport(root, REPORT_DEFAULT_DAYS))
            : view === roleIds.length + 3
              ? renderFailureMarkdown(collectFailureReport(root, REPORT_DEFAULT_DAYS))
              : null;
        render();
        return;
      }
      if (view === roleIds.length + 1 && (key.name === "up" || key.name === "down")) {
        // In the project-status pane, up/down browse entries in full instead of editing the
        // prompt; every other view keeps today's behavior (arrows are ignored by applyKey).
        const count = flatEntries().length;
        selectedEntry = moveEntrySelection(count, selectedEntry, key.name);
        entryScroll = 0; // a newly opened entry starts at its body's head
        render();
        return;
      }
      if (view >= roleIds.length + 2 && (key.name === "pageup" || key.name === "pagedown")) {
        // Within-body scroll in the Markdown panes (usage report, failures): PgDn/PgUp page the
        // cached string, clamped at both ends. The total is derived from the cache, mirroring how
        // entry mode derives it from e.body; every other view ignores these keys as today.
        const total = (paneCache ?? "").split("\n").length;
        paneScroll = stepEntryScroll(
          paneScroll,
          total,
          eventBudget,
          key.name === "pagedown" ? "down" : "up",
        );
        render();
        return;
      }
      if (view === roleIds.length + 1 && (key.name === "pageup" || key.name === "pagedown")) {
        // Within-body scroll in project-status ENTRY mode: PgDn/PgUp page the selected entry's
        // body, clamped at both ends. No-op in list mode and for bodies that fit — every other
        // view ignores these keys as today (applyKey drops them).
        if (selectedEntry !== null) {
          const flat = flatEntries();
          const sel = flat.length > 0 ? Math.min(selectedEntry, flat.length - 1) : null;
          const body = sel === null ? "" : flat[sel]!.body;
          entryScroll = stepEntryScroll(
            entryScroll,
            body ? body.split("\n").length : 0,
            entryBudget,
            key.name === "pagedown" ? "down" : "up",
          );
        }
        render();
        return;
      }
      if (key.name === "escape" && budgetMode) {
        // Esc cancels budget-edit mode, restoring the previous prompt text.
        exitBudgetMode();
        render();
        return;
      }
      if (key.name === "escape" && rolePromptFor) {
        // Esc cancels role-prompt mode the same way, restoring the previous prompt text.
        exitRolePromptMode();
        render();
        return;
      }
      if (key.name === "return") {
        if (budgetMode) {
          // Enter in budget mode parses + saves the cap through the shared setter (which
          // writes tumwater.json atomically; the running orchestrator picks it up on its next
          // ~2 s poll). An invalid value flashes and STAYS in edit mode so the operator can
          // fix it; success restores the saved prompt text.
          const parsed = parseBudgetInput(input);
          if (!parsed.ok) {
            flashMessage(parsed.error);
          } else {
            const result = setDailyBudgetUsd(root, parsed.value);
            if (result.ok) {
              exitBudgetMode();
              currentCapUsd = parsed.value; // the next render's snapshot agrees within ~2 s
              flashMessage(
                parsed.value === 0
                  ? "budget disabled"
                  : `budget set to ${usdCap(parsed.value)}`,
              );
            } else {
              flashMessage(result.error); // broken config or write failure — stay in edit mode
            }
          }
        } else if (rolePromptFor) {
          // Enter in role-prompt mode submits for the viewed loop through the same path
          // `tumwater prompt --role` uses: the shared submitRolePromptAndWake enqueues into
          // that loop's own queue (length-capped by the shared rule), logs under the loop,
          // and wakes it so a live fleet's loop comes in within one poll. An invalid
          // (whitespace-only) line flashes and STAYS in edit mode; a failed queue write
          // flashes the reason and keeps the text, the same contract the director path
          // below honors; success restores the saved draft.
          const parsed = parseRolePromptInput(input);
          if (!parsed.ok) {
            flashMessage(parsed.error);
          } else {
            const role = rolePromptFor;
            try {
              submitRolePromptAndWake(root, role, parsed.value);
              exitRolePromptMode();
              flashMessage(`queued for the ${role} loop`);
            } catch (err) {
              flashMessage(`error: ${errorMessage(err)}`);
            }
          }
        } else {
          const prompt = input.trim();
          if (!prompt) {
            // Whitespace-only input queues nothing; drop it like an empty line.
            input = "";
            cursor = 0;
          } else {
            try {
              submitPrompt(root, prompt);
              input = "";
              cursor = 0;
              flashMessage("queued for the director loop");
            } catch (err) {
              // The queue write failed (disk full, permissions): keep the operator's text so
              // it can be resubmitted, and flash the reason — the same contract the GUI's
              // prompt form honors. Clearing the line first would silently lose the prompt,
              // and an unguarded throw would escape the keypress handler and kill the TUI.
              flashMessage(`error: ${errorMessage(err)}`);
            }
          }
        }
      } else {
        const next = applyKey(input, cursor, str, key);
        input = next.text;
        cursor = next.cursor;
      }
      render();
    });
  });

  clearInterval(timer);
  stdin.setRawMode(false);
  stdin.pause?.();
  stdout.write("\n");
  reloadWatch.stop();
  if (reloadRequested) (seams.watch?.reexec ?? reexecSelf)();
}
