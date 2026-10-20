import {
  DRY_RUN_FLAG,
  JSON_FLAG,
  durationFlagSpec,
  PAUSE_FOR_OVERFLOW_HINT,
  REASON_FLAG,
  WAKE_CANCEL_FLAG,
  WAKE_LIST_FLAG,
  WAKE_IN_FLAG,
  rejectUnknownArgs,
  ROLE_FLAG,
  type FlagSpec,
} from "./cli-flag-specs.js";
import { requireReadyRepo } from "./cli-repo-gate.js";
import { cmdAbort, cmdPause, cmdReclaim, cmdResetCounters, cmdRestart, cmdResume, cmdWake } from "../operator/operator-commands.js";

/** The marker commands that share runMarkerCommand's guard+dispatch shape below. */
export type MarkerCommand = "reset-counters" | "wake" | "abort" | "pause" | "resume" | "reclaim" | "restart";

/** The CLI command layer of each marker command, keyed by its CLI name (the command bodies
 * live in operator/operator-commands.ts, the shared marker-writing cores in
 * operator/operator-intent.ts). One map so a new marker command registers its core beside its
 * case label instead of growing another copy of the guard sequence. */
const markerCommandCores: Record<MarkerCommand, (root: string, args: string[]) => Promise<void>> = {
  "reset-counters": cmdResetCounters,
  wake: cmdWake,
  abort: cmdAbort,
  pause: cmdPause,
  resume: cmdResume,
  reclaim: cmdReclaim,
  restart: cmdRestart,
};

/** The shared shape of the seven marker commands (reset-counters, wake, abort, pause,
 * resume, reclaim, restart): reject unknown args against each command's flag set, gate on a
 * ready repo, then dispatch to its operator-commands core. One copy of the guard sequence so
 * the seven cannot drift on validation order or gating. Lives beside
 * operator/operator-commands.ts's importers
 * as the marker commands' CLI layer, with cli.ts's main() dispatch casting to MarkerCommand
 * here. */
export async function runMarkerCommand(root: string, command: MarkerCommand, args: string[]): Promise<void> {
  // `pause` alone accepts `--for <duration>` (the timed pause) and `--reason <text>` (the
  // operator pause's why); `wake` alone accepts `--in <duration>` (the scheduled wake) and
  // `--cancel` (drop the pending scheduled wakes), `--list` (show them), and `--json`
  // (with --list); `reclaim` alone accepts `--dry-run` (and `--json` with it); the other
  // marker commands keep the plain --role vocabulary, so a stray --for, --reason, --in,
  // --cancel, or --dry-run fails fast instead of being silently ignored.
  const perCommandFlags: Record<MarkerCommand, FlagSpec[]> = {
    "reset-counters": [ROLE_FLAG],
    wake: [ROLE_FLAG, WAKE_IN_FLAG, WAKE_CANCEL_FLAG, WAKE_LIST_FLAG, JSON_FLAG],
    abort: [ROLE_FLAG],
    pause: [
      ROLE_FLAG,
      durationFlagSpec("pause --for", PAUSE_FOR_OVERFLOW_HINT),
      REASON_FLAG,
    ],
    resume: [ROLE_FLAG],
    reclaim: [DRY_RUN_FLAG, JSON_FLAG],
    restart: [],
  };
  rejectUnknownArgs(command, args, perCommandFlags[command] ?? [ROLE_FLAG]);
  await requireReadyRepo(root);
  await markerCommandCores[command](root, args);
}
