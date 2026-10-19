// vocabulary: plain
import {
  cancelScheduledStopMessage,
  requestAbort,
  requestResetCounters,
  requestScheduledStop,
  requestRestart,
  requestWake,
  cancelWakes,
  rolePauseMessage,
  roleResumeMessage,
} from "../../operator/operator-intent.js";
import {
  isTeamPaused,
  pausedRoles,
  pauseTeam,
  pauseRole,
  resumeTeam,
  resumeRole,
  scheduledStopAt,
} from "../../team/team-state.js";
import { durationLabel } from "../../cli/cli-args.js";
import { teamPausePhrase, teamResumePhrase } from "../../text/phrases.js";
import {
  parsePauseInput,
  parseRolePauseInput,
  parseRoleWakeInput,
  parseStopInInput,
} from "./tui-input.js";
import type { TuiEditorCtx, TuiEditorModule } from "./tui-editor-ctx.js";
import type { TuiEditorSession } from "./tui-editor-session.js";

/** The pause/stop/wake editor on the shared prompt line: the whole-team Ctrl+F pause and Ctrl+Q
 * stop editors, the per-loop Ctrl+P pause / Ctrl+A abort / Ctrl+W wake controls, and the
 * parse/dispatch leaves those write. It owns its mode flags (pauseEditMode/`pauseEditRole`/
 * `pauseEditWake`/`pauseEditStop`), its saved-draft pair, its exit helper, and the handleKey
 * arms for its keys. Mutually exclusive with the other editors via the session's held registry. */
export function createPauseEditor(session: TuiEditorSession): TuiEditorModule {
  let pauseEditMode = false;
  let pauseEditRole: string | null = null;
  let pauseEditWake = false;
  let pauseEditStop = false;
  let pauseSavedInput = "";
  let pauseSavedCursor = 0;

  // Leave pause-edit mode (Esc, Ctrl+F again, a written pause, or Ctrl+T): restore the draft.
  const exitPauseEditMode = (): void => {
    if (!pauseEditMode) return;
    pauseEditMode = false;
    pauseEditRole = null;
    pauseEditWake = false;
    pauseEditStop = false;
    session.held.pause = false;
    session.held.pauseEditRole = null;
    session.held.pauseEditWake = false;
    session.held.pauseEditStop = false;
    session.restorePromptFrom(pauseSavedInput, pauseSavedCursor);
  };

  const openPauseEditor = (role: string | null, wake: boolean, stop: boolean, hint: string): void => {
    session.settleDraft((t) => (pauseSavedInput = t), (n) => (pauseSavedCursor = n));
    pauseEditMode = true;
    pauseEditRole = role;
    pauseEditWake = wake;
    pauseEditStop = stop;
    session.held.pause = true;
    session.held.pauseEditRole = role;
    session.held.pauseEditWake = wake;
    session.held.pauseEditStop = stop;
    session.input = "";
    session.cursor = 0;
    session.flashMessage(hint);
  };

  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    if (
      key.ctrl && key.name === "f" &&
      !session.held.budget && !session.held.rolePromptFor && !session.held.search &&
      !session.held.queued && !session.held.answer && !session.held.entry &&
      !session.held.attach && !session.held.notes && !session.held.retire && !session.held.quiet && !session.held.interval && !session.held.instructions
    ) {
      // Ctrl+F toggles the whole-team pause (mnemonic: **F**leet) through the same
      // pauseTeam/resumeTeam marker writers `tumwater pause`/`resume` and the dashboard's
      // /api/pause call use, so the surfaces cannot drift on marker format or idempotence.
      // The shared teamPausePhrase/teamResumePhrase base lines keep the flash wording the
      // event feed and failure digest already read; a no-op flashes the same
      // already-paused/was-not-paused contract the CLI prints. Guarded out of the budget and
      // role-prompt editors, whose prompt line the team toggle must not disturb — the same
      // inertness the per-loop keys honor below. The write can fail (a lock timeout, a torn
      // fs), so flash the reason instead of letting the throw kill the TUI.
      if (pauseEditMode) {
        exitPauseEditMode();
        return true;
      }
      try {
        if (isTeamPaused(session.root)) {
          session.flashMessage(resumeTeam(session.root) ? teamResumePhrase() : "team was not paused");
        } else {
          // An unpaused team opens the one-line editor: "[duration] [reason]", empty pauses
          // until resumed. A paused team resumes at once.
          openPauseEditor(null, false, false, 'pause the team: [duration] [reason], e.g. "2h deploy freeze" (empty pauses until resumed) — Enter to pause, Esc to cancel');
        }
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    if (
      key.ctrl && key.name === "q" &&
      !session.held.budget && !session.held.rolePromptFor && !session.held.search &&
      !session.held.queued && !session.held.answer && !session.held.entry &&
      !session.held.attach && !session.held.notes && !session.held.retire && !session.held.quiet && !session.held.interval && !session.held.instructions
    ) {
      // Ctrl+Q (mnemonic: **q**uit later) schedules or cancels a graceful team stop through
      // the same requestScheduledStop/cancelScheduledStopMessage cores `tumwater stop --in` /
      // `--cancel` and the dashboard use. A pending stop cancels at once; otherwise it opens
      // the duration editor. A second press closes any open pause/wake/stop editor unwritten.
      if (pauseEditMode) {
        exitPauseEditMode();
        return true;
      }
      try {
        if (scheduledStopAt(session.root) !== undefined) {
          session.flashMessage(cancelScheduledStopMessage(session.root));
        } else {
          // The same one-line entry state as the Ctrl+F and per-role editors, scoped to the
          // stop intent (no role pinned, stop mode on): nothing is written until Enter.
          openPauseEditor(null, false, true, 'stop the team later: a duration, e.g. "2h" — current runs finish, then the team stops — Enter to schedule, Esc to cancel');
        }
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    if (
      key.ctrl && key.name === "r" && ctx.view === 0 && !pauseEditMode &&
      !session.held.budget && !session.held.rolePromptFor && !session.held.search &&
      !session.held.queued && !session.held.answer && !session.held.entry &&
      !session.held.attach && !session.held.retire && !session.held.instructions
    ) {
      // Ctrl+R on the Activity view applies the pending self-redeploy now — the terminal twin
      // of `tumwater restart` and the dashboard update alert's restart button, all three
      // through the same requestRestart marker writer. A refusal carries the CLI's wording
      // (a red main, failed compile, swap error, or boot refusal still blocks; a fresh build
      // refuses as "current with main"), so the flash matches what a terminal press would
      // print. Inert on every other view (the transcript's Ctrl+R still opens the per-role
      // prompt editor, Backlog's still releases an entry, Pending/Health's still refresh) and
      // out of pause-edit mode, whose prompt line the restart must not disturb. The write can
      // fail like any marker write, so flash the reason instead of letting the throw escape.
      try {
        const result = requestRestart(session.root);
        session.flashMessage(result.ok ? result.message : result.error);
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    // Per-loop controls on the transcript pane: Ctrl+P toggles the viewed loop's pause,
    // Ctrl+A aborts its in-flight tick, Ctrl+V zeroes its counters, Ctrl+W opens the wake
    // editor (Ctrl+R opens the role-prompt editor for it — the prompt editor's arms handle
    // that key). They call the
    // same marker-writing/submit cores the CLI's --role flags do, so the surfaces cannot
    // drift on marker format, idempotence, or wording. Guarded to the transcript views and
    // out of budget-edit mode; everywhere else the keys fall through to applyKey. Every
    // branch is a disk write that can fail (a lock timeout, a torn fs), and an unguarded
    // throw would escape this keypress handler and kill the TUI — flash the reason instead.
    if (key.ctrl && (key.name === "p" || key.name === "w") && pauseEditRole !== null) {
      // A second Ctrl+P or Ctrl+W closes the per-loop pause/wake editor, mirroring Ctrl+F's
      // second press.
      exitPauseEditMode();
      return true;
    }
    if (
      !session.held.budget &&
      !session.held.pause &&
      !session.held.queued && !session.held.answer && !session.held.entry &&
      !session.held.notes && !session.held.retire && !session.held.quiet && !session.held.interval &&
      !session.held.instructions &&
      ctx.roleIds.length > 0 &&
      ctx.view >= 1 && ctx.view <= ctx.roleIds.length &&
      key.ctrl && (key.name === "p" || key.name === "a" || key.name === "w" || key.name === "v")
    ) {
      const role = ctx.roleIds[ctx.view - 1]!; // defined: view is clamped inside the transcript range
      try {
        if (key.name === "p") {
          // Toggle by the marker's current state, read fresh: pauseRole/resumeRole's false
          // return means another window raced us to the same state, and the wording
          // helpers render that honestly — the changed-state contract the CLI prints.
          if (pausedRoles(session.root).includes(role)) {
            session.flashMessage(roleResumeMessage(session.root, role, resumeRole(session.root, role)));
          } else if (session.held.rolePromptFor || session.held.search) {
            session.flashMessage(
              session.held.rolePromptFor ? session.busyFlash("role prompt") : session.busyFlash("search"),
            );
          } else {
            // An unpaused loop opens the one-line duration editor; nothing is written until
            // Enter. Empty pauses until resumed.
            openPauseEditor(role, false, false, `pause ${role}: [duration], e.g. "2h" (empty pauses until resumed) — Enter to pause, Esc to cancel`);
          }
        } else if (key.name === "a") {
          const result = requestAbort(session.root, role);
          session.flashMessage(result.ok ? result.message : `error: ${result.error}`);
        } else if (key.name === "v") {
          session.flashMessage(requestResetCounters(session.root, [role]));
        } else if (session.held.rolePromptFor || session.held.search) {
          session.flashMessage(
            session.held.rolePromptFor ? session.busyFlash("role prompt") : session.busyFlash("search"),
          );
        } else {
          // Ctrl+W opens the one-line wake editor; nothing is written until Enter. Empty wakes now.
          openPauseEditor(role, true, false, `wake ${role}: [duration], e.g. "2h", or "cancel" (empty wakes now) — Enter to apply, Esc to cancel`);
        }
      } catch (err) {
        session.flashError(err);
      }
      return true;
    }
    if (key.name === "escape" && pauseEditMode) {
      // Esc cancels the pause editor without writing, restoring the previous prompt text.
      exitPauseEditMode();
      return true;
    }
    if (key.name === "return" && pauseEditMode) {
      // Enter in pause-edit mode parses "[duration] [reason]" and writes the same marker
      // `tumwater pause --for/--reason` does. An invalid entry flashes and STAYS in the editor.
      const target = pauseEditRole;
      const stopParsed = pauseEditStop ? parseStopInInput(session.input) : null;
      const wakeParsed = pauseEditWake && target !== null ? parseRoleWakeInput(session.input) : null;
      const parsed = target !== null ? parseRolePauseInput(session.input) : parsePauseInput(session.input);
      if (stopParsed) {
        if (!stopParsed.ok) {
          session.flashMessage(stopParsed.error);
        } else {
          try {
            const result = requestScheduledStop(session.root, stopParsed.inMs);
            exitPauseEditMode();
            session.flashMessage(result.ok ? result.message : `error: ${result.error}`);
          } catch (err) {
            session.flashError(err);
          }
        }
      } else if (wakeParsed) {
        if (!wakeParsed.ok) {
          session.flashMessage(wakeParsed.error);
        } else {
          try {
            const message = wakeParsed.cancel ? cancelWakes(session.root, target!) : requestWake(session.root, [target!], wakeParsed.inMs);
            exitPauseEditMode();
            session.flashMessage(message);
          } catch (err) {
            session.flashError(err);
          }
        }
      } else if (!parsed.ok) {
        session.flashMessage(parsed.error);
      } else if (target !== null) {
        try {
          const at = session.now();
          const until = parsed.forMs === undefined ? undefined : at + parsed.forMs;
          const changed = pauseRole(session.root, target, until);
          exitPauseEditMode();
          session.flashMessage(
            rolePauseMessage(
              session.root,
              target,
              changed,
              until === undefined ? undefined : { ms: parsed.forMs!, untilMs: until },
              at,
            ),
          );
        } catch (err) {
          session.flashError(err);
        }
      } else {
        const team = parsed as Extract<ReturnType<typeof parsePauseInput>, { ok: true }>;
        try {
          const until = team.forMs === undefined ? undefined : session.now() + team.forMs;
          const changed = pauseTeam(session.root, until, team.reason);
          exitPauseEditMode();
          const forSuffix = team.forMs === undefined ? "" : ` for ${durationLabel(team.forMs)}`;
          session.flashMessage(
            changed || until !== undefined
              ? `${teamPausePhrase()}${forSuffix}${changed && team.reason ? `: ${team.reason}` : ""}`
              : "team is already paused",
          );
        } catch (err) {
          session.flashError(err);
        }
      }
      return true;
    }
    return false;
  };

  return { handleKey, exit: exitPauseEditMode };
}
