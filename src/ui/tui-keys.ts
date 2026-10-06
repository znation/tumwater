import { collectReport } from "../report/report-data.js";
import { renderReportMarkdown } from "../report/report-render.js";
import { REPORT_DEFAULT_DAYS } from "../events/event-window.js";
import { collectFailureReport } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";
import { submitPrompt } from "../inbox/inbox-submit.js";
import { setDailyBudgetUsd } from "../config/config-write.js";
import { pausedRoles, pauseRole, resumeRole } from "../fleet/fleet-state.js";
import {
  requestAbort,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  submitRolePromptAndWake,
} from "../operator-intent.js";
import { errorMessage } from "../text.js";
import { usdCap } from "../format.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import {
  applyKey,
  parseBudgetInput,
  parseRolePromptInput,
} from "./tui-input.js";
import {
  newPromptHistory,
  type PromptHistory,
  pushPromptHistory,
  recallPromptHistory,
  resetPromptRecall,
  settlePromptRecall,
} from "./prompt-history.js";
import { labeledBacklogEntries, moveEntrySelection, stepEntryScroll } from "./tui-backlog.js";
import { arrowDir, pageDir } from "./tui-keymap.js";

/** How long a TUI flash notice stays visible (ms). */
const FLASH_MS = 3000;

/** The framework-free owner of the TUI's keypress handling (extracted from runTui, and fed
 * by ink's `useInput` through tui-keymap.ts's inkKeyToReadline adapter): the factory owns every mutable local the
 * keypress dispatch used to keep in runTui's closure — the prompt line, budget-edit and
 * role-prompt modes, the session history, the flash notice, the view/selection/scroll state,
 * and the line budgets render feeds back. It takes only the seams it cannot own itself: the
 * repo root the disk actions run against, the quit callback (Ctrl+D), a render request callback
 * (every branch that painted a frame), and an injectable clock so the flash expiry is
 * testable without waiting the real 3 s. Rendering (src/ui/tui.tsx) stays the caller: it
 * syncs snapshot data and line budgets in, and reads the resulting state out to compose the
 * frame — the same data flow, one module boundary added. */
interface TuiKeysDeps {
  root: string;
  /** Ctrl+D: the caller resolves its main loop (and tears down the terminal) here. */
  quit(): void;
  /** Every branch that used to call render() after a state change calls this instead. */
  requestRender(): void;
  /** Injectable clock for the flash expiry; production uses Date.now. */
  now?(): number;
}

/** The state render reads back each frame: the prompt line, the modes it names in the hint
 * line, the view/selection/scroll state, the line budgets, and the flash notice — null when
 * expired, so the per-second repaint drops the notice on the same clock it was armed. */
interface TuiKeysState {
  input: string;
  cursor: number;
  budgetMode: boolean;
  rolePromptFor: string | null;
  view: number;
  selectedEntry: number | null;
  entryScroll: number;
  paneCache: string | null;
  paneScroll: number;
  eventBudget: number;
  entryBudget: number;
  roleIds: string[];
  /** Whether the director loop currently has a tick in flight (render's feed, Ctrl+C's gate). */
  directorInFlight: boolean;
  /** The live flash notice, or null when none is armed or the clock passed its expiry. */
  flash: string | null;
}

export interface TuiKeys {
  /** The full keypress dispatch — ink's `useInput` (through the tui-keymap.ts adapter)
   * calls into this with the same (str, key) shape the readline "keypress" event delivered. */
  handleKey(str: string | undefined, key: { ctrl?: boolean; name?: string }): void;
  /** Render feeds the snapshot's cap/free flag/roles in each frame (the locals the handler
   * reads without re-reading config itself), plus the director loop's in-flight flag —
   * Ctrl+C's interrupt gate; the view clamps against a changed role count. */
  syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorInFlight?: boolean): void;
  /** Render feeds the activity pane's line budgets in each frame. */
  setLineBudgets(eventBudget: number, entryBudget: number): void;
  /** The state render composes the frame from. */
  state(): TuiKeysState;
}

export function createTuiKeys(deps: TuiKeysDeps): TuiKeys {
  const now = deps.now ?? Date.now;
  const { root } = deps;
  // The project-status pane's flat entry list (plans, then bugs, then questions), read fresh —
  // tui-backlog.ts's one definition, shared with the render so stale-selection clamping cannot
  // drift.
  const flat = () => labeledBacklogEntries(root);

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
  // The prompt line's session history (prompt-history.ts's rules): every successfully submitted
  // prompt — director and per-role alike — joins it, and Up/Down walk it the way readline
  // does. Not persisted: a TUI session starts blank, like a fresh shell.
  let promptHistory: PromptHistory = newPromptHistory();
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
    flashUntil = now() + FLASH_MS;
  };
  // Flash a caught failure: the one home for the `error: <message>` prefix the TUI's catch
  // arms show, so their wording and formatting stay identical instead of drifting.
  const flashError = (err: unknown): void => {
    flashMessage(`error: ${errorMessage(err)}`);
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
  // Whether the director's status row is in flight, fed by render each frame: the gate for
  // Ctrl+C's interrupt — with no director tick running, Ctrl+C flashes a notice instead of
  // writing an abort marker nothing would consume.
  let directorInFlight = false;

  // Leave budget-edit mode (Esc, Ctrl+B again, or Ctrl+T): restore the saved prompt text.
  // The recall state resets with it: the restored text is the live draft now, so the next
  // Up starts a fresh browse instead of resuming whatever the cap editor's line left behind.
  const exitBudgetMode = (): void => {
    if (!budgetMode) return;
    budgetMode = false;
    input = savedInput;
    cursor = savedCursor;
    promptHistory = resetPromptRecall(promptHistory);
  };

  // Leave role-prompt mode (Esc, Ctrl+R again, or Ctrl+T): restore the saved prompt text,
  // and reset the recall state with it — the saved draft was saved settled (see the Ctrl+R
  // handler), so resuming a browse entered in role mode would restore role-mode text onto
  // the director line and lose the director draft the arrows had saved.
  const exitRolePromptMode = (): void => {
    if (!rolePromptFor) return;
    rolePromptFor = null;
    input = roleSavedInput;
    cursor = roleSavedCursor;
    promptHistory = resetPromptRecall(promptHistory);
  };

  const handleKey = (str: string | undefined, key: { ctrl?: boolean; name?: string }): void => {
    if (key.ctrl && key.name === "d") {
      deps.quit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      // Ctrl+C interrupts the director's in-flight tick (shell-EOF behavior moved to
      // Ctrl+D): when the director row is in flight, write the same abort marker the
      // CLI's `abort --role director` does, through the shared requestAbort core so the
      // marker format and wording cannot drift; when none is, flash a notice and leave
      // the fleet untouched. A failed marker write flashes the reason instead of
      // escaping the handler — the same contract the per-loop controls above honor.
      if (!directorInFlight) {
        flashMessage("no director task in flight");
        deps.requestRender();
        return;
      }
      try {
        const result = requestAbort(root, DIRECTOR_ROLE);
        flashMessage(result.ok ? result.message : `error: ${result.error}`);
      } catch (err) {
        flashError(err);
      }
      deps.requestRender();
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
        deps.requestRender();
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
        // Mid-recall, hand the arrows' saved draft back before the cap editor takes the
        // line — the same settle the role editor does — so leaving budget mode restores
        // the draft, not a history entry, with no stale recall state riding along.
        const settled = settlePromptRecall(promptHistory, input, cursor);
        promptHistory = settled.history;
        savedInput = settled.text;
        savedCursor = settled.cursor;
        budgetMode = true;
        input = currentCapUsd > 0 ? String(currentCapUsd) : "";
        cursor = input.length;
        flashMessage("edit daily cost budget (USD): Enter to save, Esc to cancel");
      }
      deps.requestRender();
      return;
    }
    // Per-loop controls on the transcript pane (PLANS.md "TUI per-loop controls"): Ctrl+P
    // toggles the viewed loop's pause, Ctrl+A aborts its in-flight tick, Ctrl+W wakes it,
    // and Ctrl+R opens the role-prompt editor for it (PLANS.md "Per-role prompts 2/2").
    // They call the same marker-writing/submit cores the CLI's --role flags do, so the
    // surfaces cannot drift on marker format, idempotence, or wording. Guarded to the
    // transcript views and out of budget-edit mode; everywhere else the keys fall through
    // to applyKey, where only Ctrl+U (kill to line start) and Ctrl+K (kill to line end)
    // edit the prompt line and the rest of these ctrl-key presses stay inert.
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
            // Mid-recall, the line holds a history entry while the real draft sits in the
            // recall state: settle first, so the role editor saves (and later restores) the
            // draft the operator was writing, and no stale index/draft crosses modes —
            // otherwise Esc here would surface role-mode recalls on the director line.
            const settled = settlePromptRecall(promptHistory, input, cursor);
            promptHistory = settled.history;
            roleSavedInput = settled.text;
            roleSavedCursor = settled.cursor;
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
        flashError(err);
      }
      deps.requestRender();
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
      deps.requestRender();
      return;
    }
    const arrow = arrowDir(key.name);
    const page = pageDir(key.name);
    if (view === roleIds.length + 1 && arrow !== null) {
      // In the project-status pane, up/down browse entries in full instead of editing the
      // prompt; every other view keeps today's behavior (arrows are ignored by applyKey).
      const count = flat().length;
      selectedEntry = moveEntrySelection(count, selectedEntry, arrow);
      entryScroll = 0; // a newly opened entry starts at its body's head
      deps.requestRender();
      return;
    }
    if (view >= roleIds.length + 2 && page !== null) {
      // Within-body scroll in the Markdown panes (usage report, failures): PgDn/PgUp page the
      // cached string, clamped at both ends. The total is derived from the cache, mirroring how
      // entry mode derives it from e.body; every other view ignores these keys as today.
      const total = (paneCache ?? "").split("\n").length;
      paneScroll = stepEntryScroll(paneScroll, total, eventBudget, page);
      deps.requestRender();
      return;
    }
    if (view === roleIds.length + 1 && page !== null) {
      // Within-body scroll in project-status ENTRY mode: PgDn/PgUp page the selected entry's
      // body, clamped at both ends. No-op in list mode and for bodies that fit — every other
      // view ignores these keys as today (applyKey drops them).
      if (selectedEntry !== null) {
        const entries = flat();
        const sel = entries.length > 0 ? Math.min(selectedEntry, entries.length - 1) : null;
        const body = sel === null ? "" : entries[sel]!.body;
        entryScroll = stepEntryScroll(
          entryScroll,
          body ? body.split("\n").length : 0,
          entryBudget,
          page,
        );
      }
      deps.requestRender();
      return;
    }
    if (!budgetMode && arrow !== null) {
      // Up/Down walk the submitted-prompt history the way readline does (prompt-history.ts's
      // recall rules). The backlog pane keeps the arrows for entry browsing (its branch
      // above already returned), and budget mode keeps them out — recalling a prompt into
      // the cap field would be a paste, not a recall. No history in this direction: fall
      // through to applyKey, which ignores arrows as before.
      const recalled = recallPromptHistory(
        promptHistory,
        input,
        cursor,
        key.name === "up" ? "older" : "newer",
      );
      if (recalled) {
        promptHistory = recalled.history;
        input = recalled.text;
        cursor = recalled.cursor;
      }
    }
    if (key.name === "escape" && budgetMode) {
      // Esc cancels budget-edit mode, restoring the previous prompt text.
      exitBudgetMode();
      deps.requestRender();
      return;
    }
    if (key.name === "escape" && rolePromptFor) {
      // Esc cancels role-prompt mode the same way, restoring the previous prompt text.
      exitRolePromptMode();
      deps.requestRender();
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
            promptHistory = pushPromptHistory(promptHistory, parsed.value);
            exitRolePromptMode();
            flashMessage(`queued for the ${role} loop`);
          } catch (err) {
            flashError(err);
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
            promptHistory = pushPromptHistory(promptHistory, prompt);
            input = "";
            cursor = 0;
            flashMessage("queued for the director loop");
          } catch (err) {
            // The queue write failed (disk full, permissions): keep the operator's text so
            // it can be resubmitted, and flash the reason — the same contract the GUI's
            // prompt form honors. Clearing the line first would silently lose the prompt,
            // and an unguarded throw would escape the keypress handler and kill the TUI.
            flashError(err);
          }
        }
      }
    } else {
      const next = applyKey(input, cursor, str, key);
      input = next.text;
      cursor = next.cursor;
    }
    deps.requestRender();
  };

  return {
    handleKey,
    syncSnapshot(capUsd: number, budgetFree: boolean, roles: string[], directorRunning = false): void {
      currentCapUsd = capUsd;
      currentBudgetFree = budgetFree;
      roleIds = roles;
      directorInFlight = directorRunning;
      view = Math.min(view, roleIds.length + 3); // clamp a stale index if roles changed
    },
    setLineBudgets(evBudget: number, enBudget: number): void {
      eventBudget = evBudget;
      entryBudget = enBudget;
    },
    state(): TuiKeysState {
      return {
        input,
        cursor,
        budgetMode,
        rolePromptFor,
        view,
        selectedEntry,
        entryScroll,
        paneCache,
        paneScroll,
        eventBudget,
        entryBudget,
        roleIds,
        directorInFlight,
        flash: flash && now() < flashUntil ? flash : null,
      };
    },
  };
}