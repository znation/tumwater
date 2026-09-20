import readline from "node:readline";
import {
  type BacklogEntry,
  openBugEntries,
  openQuestionEntries,
  plannedPlanEntries,
} from "../backlog.js";
import { readEvents } from "../events.js";
import { collectReport, renderReportMarkdown } from "./report.js";
import { formatEvent } from "./event-format.js";
import { submitPrompt } from "../inbox.js";
import { setDailyBudgetUsd } from "../config.js";
import { snapshot } from "./status.js";
import { renderStatus } from "./status-render.js";
import { clipToWidth, errorMessage, usdCap } from "../text.js";
import { readTranscript } from "./transcript.js";
import { captureStartupBuild, createReloadWatch, reexecSelf } from "./self-reload.js";
import {
  applyKey,
  parseBudgetInput,
  renderInputView,
  tuiTerminalError,
} from "./tui-input.js";
import {
  backlogLines,
  entryBodyWindow,
  moveEntrySelection,
  stepEntryScroll,
} from "./tui-backlog.js";

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(tuiTerminalError(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY)));
  }

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
  // The last snapshot's cap, captured by render so the Ctrl+B handler can pre-fill without
  // re-reading config itself (render already polls snapshot every second).
  let currentCapUsd = 0;
  // The last snapshot's free flag: true when every model the fleet could use is unpriced,
  // so a cap could never bind — the Ctrl+B handler flashes a notice instead of opening
  // the editor (BUGS.md 2026-09-14), leaving the prompt line untouched.
  let currentBudgetFree = false;
  let flash = "";
  let flashUntil = 0;
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
  // The usage-report pane's Markdown, computed once per activation: the Ctrl+T handler sets
  // it when cycling into the report view and nulls it on leaving. collectReport tail-scans
  // events.jsonl, so it must not run on every second's re-render — those only re-window this.
  let reportCache: string | null = null;
  // The within-body scroll offset (line index of the window head) for the usage-report pane —
  // PgDn/PgUp there. Reset to the head whenever the view is entered, like entryScroll.
  let reportScroll = 0;
  // The activity pane's current line budget, refreshed by every render so keypress handlers
  // can page within it without re-deriving the height math.
  let eventBudget = 0;
  let roleIds: string[] = [];

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
    const rows = process.stdout.rows ?? 40;
    const width = process.stdout.columns ?? 120;
    const snap = snapshot(root);
    currentCapUsd = snap.budget.capUsd;
    currentBudgetFree = snap.budget.free;
    roleIds = snap.loops.map((s) => s.role);
    view = Math.min(view, roleIds.length + 2); // clamp a stale index if roles changed
    const status = renderStatus(root, snap, width);
    const statusLines = status.split("\n").length;
    // A highlighted nudge above the activity pane while questions await a human answer —
    // a cheap signal that something needs a decision. It consumes one line of the budget.
    const hasQuestions = snap.questions > 0;
    // Numbered previews of prompts queued for the director, between the table and the
    // activity pane: what will run next, in execution order. Each line consumes exactly
    // one line of the budget, like the questions nudge above it.
    const queued = snap.inboxPrompts;
    eventBudget = Math.max(3, rows - statusLines - 6 - (hasQuestions ? 1 : 0) - queued.length);
    // The pane occupies the same slot as recent activity: one header line plus at most
    // eventBudget clipped lines, so the height-budget math is unchanged either way.
    let header: string;
    let body: string[];
    let emptyNote = "(no events yet)";
    const role = view > 0 && view <= roleIds.length ? roleIds[view - 1] : undefined; // defined: view is clamped above
    if (role) {
      header = `${BOLD}${clipToWidth(`transcript: ${role} — Ctrl+T to cycle`, width)}${RESET}`;
      body = readTranscript(root, role, eventBudget)
        .map((l) => clipToWidth(l, width))
        .slice(-eventBudget);
      emptyNote = "(no transcript yet)";
    } else if (view === roleIds.length + 1) {
      // Project status: planned features, open bugs, and open questions from
      // PLANS.md/BUGS.md/QUESTIONS.md, read fresh each render like events. Keeps the HEAD of
      // the list when it overflows — file order is newest-first, unlike events which keep the tail.
      const planEntries = plannedPlanEntries(root);
      const bugEntries = openBugEntries(root);
      const questionEntries = openQuestionEntries(root);
      if (selectedEntry === null) {
        header = `${BOLD}${clipToWidth("project status — Ctrl+T to cycle", width)}${RESET}`;
        body = backlogLines(
          planEntries.map((e) => e.title),
          bugEntries.map((e) => e.title),
          questionEntries.map((e) => e.title),
        )
          .map((l) => clipToWidth(l, width))
          .slice(0, eventBudget);
      } else {
        // Entry browsing: the selected entry's full body under a header naming its section
        // and title. A stale selection (an entry removed from the file since the last render)
        // clamps to the last remaining entry; with no entries at all it falls back to list mode.
        const flat = flatEntries();
        const sel = flat.length > 0 ? Math.min(selectedEntry, flat.length - 1) : null;
        if (sel === null) {
          header = `${BOLD}${clipToWidth("project status — Ctrl+T to cycle", width)}${RESET}`;
          body = ["(no planned features, open bugs, or open questions)"]
            .map((l) => clipToWidth(l, width))
            .slice(0, eventBudget);
        } else {
          const e = flat[sel]!;
          const win = entryBodyWindow(e.body, entryScroll, eventBudget, width);
          // The scroll affordance appears only while the body overflows the pane — short
          // entries keep today's exact header.
          const browse = win.total > eventBudget ? "↑↓ browse · PgUp/PgDn scroll" : "↑↓ browse";
          header = `${BOLD}${clipToWidth(`${e.label}: ${e.title} — ${browse} · Ctrl+T cycle`, width)}${RESET}`;
          body = win.lines;
        }
      }
    } else if (view === roleIds.length + 2) {
      // Usage report: the same Markdown `tumwater report` prints, windowed exactly like
      // project-status entry mode. The cache is set on view entry by the Ctrl+T handler,
      // so this branch only re-windows a string — no per-frame collectReport.
      const win = entryBodyWindow(reportCache ?? "", reportScroll, eventBudget, width);
      // The scroll affordance appears only while the body overflows the pane — a fitting
      // report keeps the plain header (the browse-hint pattern entry mode already uses).
      const scroll = win.total > eventBudget ? "PgUp/PgDn scroll · " : "";
      header = `${BOLD}${clipToWidth(`usage report — ${scroll}Ctrl+T to cycle`, width)}${RESET}`;
      body = win.lines;
    } else {
      header = `${BOLD}recent activity${RESET}`;
      body = readEvents(root, eventBudget)
        .map((e) => clipToWidth(formatEvent(e), width))
        .slice(-eventBudget);
    }

    const parts = [status, ""];
    if (hasQuestions) {
      parts.push(
        `${BOLD}${clipToWidth(`questions: ${snap.questions} awaiting answers (see QUESTIONS.md)`, width)}${RESET}`,
      );
    }
    for (const [i, preview] of queued.entries()) {
      parts.push(clipToWidth(`${i + 1}. ${preview}`, width));
    }
    parts.push(header);
    parts.push(body.length ? body.map((l) => `${DIM}${l}${RESET}`).join("\n") : `${DIM}${emptyNote}${RESET}`);
    parts.push("");
    if (flash && Date.now() < flashUntil) parts.push(`${BOLD}${clipToWidth(flash, width)}${RESET}`);
    parts.push(
      `${DIM}${clipToWidth("type a prompt for the project, Enter to send · Ctrl+B edit budget · Ctrl+C to quit", width)}${RESET}`,
    );
    // Window long prompts around the cursor so its position stays visible.
    parts.push(`> ${renderInputView(input, cursor, width)}`);
    process.stdout.write(CLEAR + parts.join("\n"));
  };

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    input = savedInput;
    cursor = savedCursor;
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const timer = setInterval(render, 1000);
  render();

  await new Promise<void>((resolve) => {
    resolveMain = resolve;
    // The reload trigger may have fired between `start()` and this await; the executor
    // resolves immediately in that case so both orderings reach the same teardown.
    if (reloadRequested) resolve();
    process.stdin.on("keypress", (str: string | undefined, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        resolve();
        return;
      }
      if (key.ctrl && key.name === "b") {
        // Ctrl+B toggles budget-edit mode on the prompt line (mnemonic for *b*udget): entering
        // pre-fills the current cap (empty when disabled — empty means "no cap" on save) and
        // saves the prompt text; leaving restores it. Esc cancels the same way.
        if (budgetMode) {
          exitBudgetMode();
        } else if (currentBudgetFree) {
          // An all-free fleet has no spend a cap could bind: the editor would pre-fill a
          // value that can never take effect, so Ctrl+B flashes a one-line notice and
          // leaves the prompt line untouched (toggle/Esc logic unchanged).
          flash = "budget n/a — all models free";
          flashUntil = Date.now() + 3000;
        } else {
          savedInput = input;
          savedCursor = cursor;
          budgetMode = true;
          input = currentCapUsd > 0 ? String(currentCapUsd) : "";
          cursor = input.length;
          flash = "edit daily cost budget (USD): Enter to save, Esc to cancel";
          flashUntil = Date.now() + 3000;
        }
        render();
        return;
      }
      if (key.ctrl && key.name === "t") {
        // Ctrl+T exits budget-edit mode too — view cycling is orthogonal to it, so a cycle
        // never strands the editor with its pre-filled cap in the prompt line.
        exitBudgetMode();
        view = (view + 1) % (roleIds.length + 3); // events → each loop's transcript → project status → usage report → events
        selectedEntry = null; // leaving a view drops any entry selection…
        entryScroll = 0; // …and its within-body scroll, so re-entering starts at the list/head
        reportScroll = 0; // the report pane always re-enters at its head
        // Compute the report once per activation (this handler renders immediately), and drop
        // it on leaving — a visit's first frame is fresh, later frames only re-window.
        reportCache = view === roleIds.length + 2 ? renderReportMarkdown(collectReport(root, 14)) : null;
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
      if (view === roleIds.length + 2 && (key.name === "pageup" || key.name === "pagedown")) {
        // Within-body scroll in the usage-report pane: PgDn/PgUp page the cached report,
        // clamped at both ends. The total is derived from the cache, mirroring how entry
        // mode derives it from e.body; every other view ignores these keys as today.
        const total = (reportCache ?? "").split("\n").length;
        reportScroll = stepEntryScroll(
          reportScroll,
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
            eventBudget,
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
      if (key.name === "return") {
        if (budgetMode) {
          // Enter in budget mode parses + saves the cap through the shared setter (which
          // writes tumwater.json atomically; the running orchestrator picks it up on its next
          // ~2 s poll). An invalid value flashes and STAYS in edit mode so the operator can
          // fix it; success restores the saved prompt text.
          const parsed = parseBudgetInput(input);
          if (!parsed.ok) {
            flash = parsed.error;
          } else {
            const result = setDailyBudgetUsd(root, parsed.value);
            if (result.ok) {
              exitBudgetMode();
              currentCapUsd = parsed.value; // the next render's snapshot agrees within ~2 s
              flash =
                parsed.value === 0
                  ? "budget disabled"
                  : `budget set to ${usdCap(parsed.value)}`;
            } else {
              flash = result.error; // broken config or write failure — stay in edit mode
            }
          }
          flashUntil = Date.now() + 3000;
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
              flash = "queued for the director loop";
            } catch (err) {
              // The queue write failed (disk full, permissions): keep the operator's text so
              // it can be resubmitted, and flash the reason — the same contract the GUI's
              // prompt form honors. Clearing the line first would silently lose the prompt,
              // and an unguarded throw would escape the keypress handler and kill the TUI.
              flash = `error: ${errorMessage(err)}`;
            }
            flashUntil = Date.now() + 3000;
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
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
  reloadWatch.stop();
  if (reloadRequested) reexecSelf();
}
