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
import { guardError } from "./tui-guard.js";
import { viewedRole, type TuiEditorCtx, type TuiEditorModule } from "./tui-editor-ctx.js";
import { savedPromptDraft, type TuiEditorSession } from "./tui-editor-session.js";

/** The pause/stop/wake editor on the shared prompt line: the whole-team Ctrl+F pause and Ctrl+Q
 * stop editors, the per-role Ctrl+P pause / Ctrl+A abort / Ctrl+W wake controls, and the
 * parse/dispatch leaves those write. It owns its mode flags (pauseEditMode/`pauseEditRole`/
 * `pauseEditWake`/`pauseEditStop`), its saved-draft pair, its exit helper, and the handleKey
 * arms for its keys. Mutually exclusive with the other editors via the session's held registry. */
export function createPauseEditor(session: TuiEditorSession): TuiEditorModule {
  let pauseEditMode = false;
  let pauseEditRole: string | null = null;
  let pauseEditWake = false;
  let pauseEditStop = false;
  const draft = savedPromptDraft(session);


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
    draft.restore();
  };

  const openPauseEditor = (role: string | null, wake: boolean, stop: boolean, hint: string): void => {
    draft.save();
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

  // Ctrl+F toggles the whole-team pause (mnemonic: **F**leet) through the same
  // pauseTeam/resumeTeam marker writers `tumwater pause`/`resume` and the dashboard's
  // /api/pause call use, so the surfaces cannot drift on marker format or idempotence.
  // The shared teamPausePhrase/teamResumePhrase base lines keep the flash wording the
  // event feed and failure digest already read; a no-op flashes the same
  // already-paused/was-not-paused contract the CLI prints. Guarded out of the budget and
  // role-prompt editors, whose prompt line the team toggle must not disturb — the same
  // inertness the per-role keys honor below. The write can fail (a lock timeout, a torn
  // fs), so flash the reason instead of letting the throw kill the TUI.
  const teamPauseToggle = (_ctx: TuiEditorCtx): boolean => {
    if (pauseEditMode) {
      exitPauseEditMode();
      return true;
    }
    guardError(session, () => {
      if (isTeamPaused(session.root)) {
        session.flashMessage(resumeTeam(session.root) ? teamResumePhrase() : "team was not paused");
      } else {
        // An unpaused team opens the one-line editor: "[duration] [reason]", empty pauses
        // until resumed. A paused team resumes at once.
        openPauseEditor(null, false, false, 'pause the team: [duration] [reason], e.g. "2h deploy freeze" (empty pauses until resumed) — Enter to pause, Esc to cancel');
      }
    });
    return true;
  };

  // Ctrl+Q (mnemonic: **q**uit later) schedules or cancels a graceful team stop through
  // the same requestScheduledStop/cancelScheduledStopMessage cores `tumwater stop --in` /
  // `--cancel` and the dashboard use. A pending stop cancels at once; otherwise it opens
  // the duration editor. A second press closes any open pause/wake/stop editor unwritten.
  const stopLaterToggle = (_ctx: TuiEditorCtx): boolean => {
    if (pauseEditMode) {
      exitPauseEditMode();
      return true;
    }
    guardError(session, () => {
      if (scheduledStopAt(session.root) !== undefined) {
        session.flashMessage(cancelScheduledStopMessage(session.root));
      } else {
        // The same one-line entry state as the Ctrl+F and per-role editors, scoped to the
        // stop intent (no role pinned, stop mode on): nothing is written until Enter.
        openPauseEditor(null, false, true, 'stop the team later: a duration, e.g. "2h" — current runs finish, then the team stops — Enter to schedule, Esc to cancel');
      }
    });
    return true;
  };

  // Ctrl+R on the Activity view applies the pending self-redeploy now — the terminal twin
  // of `tumwater restart` and the dashboard update alert's restart button, all three
  // through the same requestRestart marker writer. A refusal carries the CLI's wording
  // (a red main, failed compile, swap error, or boot refusal still blocks; a fresh build
  // refuses as "current with main"), so the flash matches what a terminal press would
  // print. Inert on every other view (the transcript's Ctrl+R still opens the per-role
  // prompt editor, Backlog's still releases an entry, Pending/Health's still refresh) and
  // out of pause-edit mode, whose prompt line the restart must not disturb. The write can
  // fail like any marker write, so flash the reason instead of letting the throw escape.
  const restartNow = (_ctx: TuiEditorCtx): boolean => {
    guardError(session, () => {
      const result = requestRestart(session.root);
      session.flashMessage(result.ok ? result.message : result.error);
    });
    return true;
  };

  // A second Ctrl+P or Ctrl+W closes the per-role pause/wake editor, mirroring Ctrl+F's
  // second press.
  const closeRolePauseEdit = (): boolean => {
    exitPauseEditMode();
    return true;
  };

  // Per-role controls on the transcript pane: Ctrl+P toggles the viewed role's pause,
  // Ctrl+A aborts its in-flight run, Ctrl+V zeroes its counters, Ctrl+W opens the wake
  // editor (Ctrl+R opens the role-prompt editor for it — the prompt editor's arms handle
  // that key). They call the
  // same marker-writing/submit cores the CLI's --role flags do, so the surfaces cannot
  // drift on marker format, idempotence, or wording. Guarded to the transcript views and
  // out of budget-edit mode; everywhere else the keys fall through to applyKey. Every
  // branch is a disk write that can fail (a lock timeout, a torn fs), and an unguarded
  // throw would escape this keypress handler and kill the TUI — flash the reason instead.
  const roleControlArm = (name: "p" | "a" | "w" | "v", ctx: TuiEditorCtx): boolean => {
    const role = viewedRole(ctx); // defined: view is clamped inside the transcript range
    guardError(session, () => {
      if (name === "p") {
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
          // An unpaused role opens the one-line duration editor; nothing is written until
          // Enter. Empty pauses until resumed.
          openPauseEditor(role, false, false, `pause ${role}: [duration], e.g. "2h" (empty pauses until resumed) — Enter to pause, Esc to cancel`);
        }
      } else if (name === "a") {
        const result = requestAbort(session.root, role);
        session.flashMessage(result.ok ? result.message : `error: ${result.error}`);
      } else if (name === "v") {
        session.flashMessage(requestResetCounters(session.root, [role]));
      } else if (session.held.rolePromptFor || session.held.search) {
        session.flashMessage(
          session.held.rolePromptFor ? session.busyFlash("role prompt") : session.busyFlash("search"),
        );
      } else {
        // Ctrl+W opens the one-line wake editor; nothing is written until Enter. Empty wakes now.
        openPauseEditor(role, true, false, `wake ${role}: [duration], e.g. "2h", or "cancel" (empty wakes now) — Enter to apply, Esc to cancel`);
      }
    });
    return true;
  };

  // Esc cancels the pause editor without writing, restoring the previous prompt text.
  const cancelPauseEdit = (): boolean => {
    exitPauseEditMode();
    return true;
  };

  // Enter in pause-edit mode parses "[duration] [reason]" and writes the same marker
  // `tumwater pause --for/--reason` does. An invalid entry flashes and STAYS in the editor.
  // It reads the current mode/draft and dispatches to the single named writer for the
  // intent it resolves: a scheduled stop, a per-role wake, a per-role pause, or the team
  // pause.
  const commitPauseEntry = (): boolean => {
    const target = pauseEditRole;
    const stopParsed = pauseEditStop ? parseStopInInput(session.input) : null;
    const wakeParsed = pauseEditWake && target !== null ? parseRoleWakeInput(session.input) : null;
    const parsed = target !== null ? parseRolePauseInput(session.input) : parsePauseInput(session.input);
    if (stopParsed) {
      applyStopEntry(stopParsed);
      return true;
    }
    if (wakeParsed) {
      applyWakeEntry(wakeParsed, target!);
      return true;
    }
    if (!parsed.ok) {
      session.flashMessage(parsed.error);
      return true;
    }
    if (target !== null) {
      applyRolePauseEntry(parsed, target);
      return true;
    }
    applyTeamPauseEntry(parsed);
    return true;
  };

  const applyStopEntry = (stopParsed: ReturnType<typeof parseStopInInput>): void => {
    if (!stopParsed.ok) {
      session.flashMessage(stopParsed.error);
      return;
    }
    guardError(session, () => {
      const result = requestScheduledStop(session.root, stopParsed.inMs);
      exitPauseEditMode();
      session.flashMessage(result.ok ? result.message : `error: ${result.error}`);
    });
  };

  const applyWakeEntry = (wakeParsed: ReturnType<typeof parseRoleWakeInput>, target: string): void => {
    if (!wakeParsed.ok) {
      session.flashMessage(wakeParsed.error);
      return;
    }
    guardError(session, () => {
      const message = wakeParsed.cancel ? cancelWakes(session.root, [target]) : requestWake(session.root, [target], wakeParsed.inMs);
      exitPauseEditMode();
      session.flashMessage(message);
    });
  };

  const applyRolePauseEntry = (
    parsed: Extract<ReturnType<typeof parseRolePauseInput>, { ok: true }>,
    target: string,
  ): void => {
    guardError(session, () => {
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
    });
  };

  const applyTeamPauseEntry = (parsed: Extract<ReturnType<typeof parsePauseInput>, { ok: true }>): void => {
    guardError(session, () => {
      const until = parsed.forMs === undefined ? undefined : session.now() + parsed.forMs;
      const changed = pauseTeam(session.root, until, parsed.reason);
      exitPauseEditMode();
      const forSuffix = parsed.forMs === undefined ? "" : ` for ${durationLabel(parsed.forMs)}`;
      session.flashMessage(
        changed || until !== undefined
          ? `${teamPausePhrase()}${forSuffix}${changed && parsed.reason ? `: ${parsed.reason}` : ""}`
          : "team is already paused",
      );
    });
  };

  const pauseLineFree = (): boolean => !session.anyEditorHeld("pause");
  const restartAllowed = (ctx: TuiEditorCtx): boolean => ctx.view === 0 && !pauseEditMode && pauseLineFree();
  const roleViewEditable = (ctx: TuiEditorCtx): boolean =>
    !session.anyEditorHeld("rolePromptFor", "search") &&
    ctx.roleIds.length > 0 &&
    ctx.view >= 1 && ctx.view <= ctx.roleIds.length;
  const ctrlRoutes: ReadonlyArray<{
    name: string;
    should: (ctx: TuiEditorCtx) => boolean;
    run: (ctx: TuiEditorCtx) => boolean;
  }> = [
    { name: "f", should: pauseLineFree, run: teamPauseToggle },
    { name: "q", should: pauseLineFree, run: stopLaterToggle },
    { name: "r", should: restartAllowed, run: restartNow },
    { name: "p", should: () => pauseEditRole !== null, run: closeRolePauseEdit },
    { name: "w", should: () => pauseEditRole !== null, run: closeRolePauseEdit },
    { name: "p", should: roleViewEditable, run: (ctx) => roleControlArm("p", ctx) },
    { name: "a", should: roleViewEditable, run: (ctx) => roleControlArm("a", ctx) },
    { name: "w", should: roleViewEditable, run: (ctx) => roleControlArm("w", ctx) },
    { name: "v", should: roleViewEditable, run: (ctx) => roleControlArm("v", ctx) },
  ];
  const routeCtrl = (key: { ctrl?: boolean; name?: string }, ctx: TuiEditorCtx): boolean | null => {
    for (const route of ctrlRoutes) {
      if (route.name === key.name && route.should(ctx)) return route.run(ctx);
    }
    return null;
  };
  const editEntryArm = (key: { ctrl?: boolean; name?: string }): boolean => {
    if (key.name === "escape" && pauseEditMode) return cancelPauseEdit();
    if (key.name === "return" && pauseEditMode) return commitPauseEntry();
    return false;
  };
  const handleKey = (
    _str: string | undefined,
    key: { ctrl?: boolean; name?: string },
    ctx: TuiEditorCtx,
  ): boolean => {
    // Ordered dispatch: a guard miss falls through to the next route, then to editEntryArm.
    const ctrl = key.ctrl ? routeCtrl(key, ctx) : null;
    if (ctrl !== null) return ctrl;
    return editEntryArm(key);
  };

  return { handleKey, exit: exitPauseEditMode };
}
