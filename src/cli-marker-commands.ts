import {
  DURATION_FLAG,
  REASON_FLAG,
  WAKE_IN_FLAG,
  rejectUnknownArgs,
  ROLE_FLAG,
} from "./cli-flag-specs.js";
import type { FlagSpec } from "./cli-flag-specs.js";
import { requireReadyRepo } from "./cli-query-commands.js";
import { cmdAbort, cmdPause, cmdResetCounters, cmdResume, cmdWake } from "./operator-commands.js";

/** The marker commands that share runMarkerCommand's guard+dispatch shape below. */
export type MarkerCommand = "reset-counters" | "wake" | "abort" | "pause" | "resume";

/** The CLI command layer of each marker command, keyed by its CLI name (the command bodies
 * live in operator-commands.ts, the shared marker-writing cores in operator-intent.ts). One
 * map so a new marker command registers its core beside its case label instead of growing
 * another copy of the guard sequence. */
const markerCommandCores: Record<MarkerCommand, (root: string, args: string[]) => Promise<void>> = {
  "reset-counters": cmdResetCounters,
  wake: cmdWake,
  abort: cmdAbort,
  pause: cmdPause,
  resume: cmdResume,
};

/** The shared shape of the five marker commands (reset-counters, wake, abort, pause, resume):
 * reject unknown args (each takes only the optional --role flag), gate on a ready repo, then
 * dispatch to its operator-commands core. One copy of the guard sequence so the five cannot
 * drift on validation order or gating. Lives beside operator-commands.ts's importers as the
 * marker commands' CLI layer, with cli.ts's main() dispatch casting to MarkerCommand here. */
export async function runMarkerCommand(root: string, command: MarkerCommand, args: string[]): Promise<void> {
  // `pause` alone accepts `--for <duration>` (the timed pause) and `--reason <text>` (the
  // operator pause's why); `wake` alone accepts `--in <duration>` (the scheduled wake); the
  // other marker commands keep the plain --role vocabulary, so a stray --for, --reason, or
  // --in fails fast instead of being silently ignored.
  const perCommandFlags: Record<MarkerCommand, FlagSpec[]> = {
    "reset-counters": [ROLE_FLAG],
    wake: [ROLE_FLAG, WAKE_IN_FLAG],
    abort: [ROLE_FLAG],
    pause: [ROLE_FLAG, DURATION_FLAG, REASON_FLAG],
    resume: [ROLE_FLAG],
  };
  rejectUnknownArgs(command, args, perCommandFlags[command] ?? [ROLE_FLAG]);
  await requireReadyRepo(root);
  await markerCommandCores[command](root, args);
}