import { knownRoleIds, loadConfig } from "./config.js";
import { fail, parseRoleFlag } from "./cli-args.js";
import {
  clearBackoff,
  loadLoopState,
  orchestratorAlive,
  pauseFleet,
  resumeFleet,
  saveLoopState,
  zeroCounters,
} from "./state.js";
import { writeJsonFile } from "./json-files.js";
import { abortRequestPath, resetRequestPath, wakeRequestPath } from "./paths.js";
import { DIRECTOR_ROLE } from "./roles.js";

/** The CLI half of the operator-intent protocol (the consumer half is src/operator-requests.ts):
 * `reset-counters`, `wake`, `abort`, `pause`, and `resume` write the on-disk markers the fleet
 * reads, split out of cli.ts so the whole marker protocol — producer and consumer — is legible
 * in one place. Every command here is deliberately usable without a live harness except
 * `abort`, which has nothing to consume its one-shot marker when no fleet is up. */

/** How a marker command reports when its marker takes effect, derived from one liveness
 * check: `when` is the " within ~2s" a live fleet will pick it up in, and `tail` names the
 * fallback ("takes effect on the next `tumwater run`") while no harness is running. `pause`
 * and `resume` share this so neither can promise a timing the other denies — the one place
 * that user-facing contract lives. */
function markerApplyNote(root: string): { when: string; tail: string } {
  const live = orchestratorAlive(root);
  return {
    when: live ? " within ~2s" : "",
    tail: live ? "" : "; no harness is running, so it takes effect on the next `tumwater run`",
  };
}

/** `tumwater reset-counters [--role <id>]`: zero the per-loop counters shown in the
 * dashboards so a fresh observation window can begin. Zeroes each target's state file
 * directly (works while the harness is not running) and drops a marker that a running fleet
 * consumes within one poll cycle — it must also zero the runners' in-memory copies, or their
 * next save resurrects the pre-reset values. Scheduling fields and pi session continuity are
 * untouched: loops keep sleeping/waking exactly as before. */
export async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  const config = loadConfig(root);
  const role = parseRoleFlag(args, knownRoleIds(config));
  const targets = role ? [role] : Object.keys(config.roles); // Default: every role in the config.
  for (const r of targets) saveLoopState(root, zeroCounters(loadLoopState(root, r)));
  writeJsonFile(resetRequestPath(root), { at: Date.now(), roles: targets });
  process.stdout.write(`counters reset for ${targets.join(", ")} — a running fleet picks this up within ~2s\n`);
}

/** `tumwater wake [--role <id>]`: tell the fleet "whatever the loops were failing on is
 * fixed — try again": clear the named roles' (or every role's) backoff and pull nextRunAt
 * to now, so they tick within one poll instead of sleeping until the backoff expires. The
 * counterpart of reset-counters' documented hands-off stance toward scheduling: this one
 * touches ONLY the schedule — counters, wake tracking, and session continuity are
 * untouched. Works like reset-counters on both planes: rewrites each target's state file
 * directly (takes effect on the next `tumwater run` even when no fleet is up) and drops a
 * marker a running fleet consumes within one poll — it must also clear the runners'
 * in-memory schedules, or their next save resurrects the pre-wake sleep window. */
export async function cmdWake(root: string, args: string[]): Promise<void> {
  const config = loadConfig(root);
  const role = parseRoleFlag(args, knownRoleIds(config));
  const targets = role ? [role] : Object.keys(config.roles); // Default: every role in the config.
  const now = Date.now();
  for (const r of targets) saveLoopState(root, clearBackoff(loadLoopState(root, r), now));
  writeJsonFile(wakeRequestPath(root), { at: now, roles: targets });
  process.stdout.write(`wake requested for ${targets.join(", ")} — a running fleet applies it within one poll\n`);
}

/** `tumwater abort --role <id>`: kill one loop's in-flight tick right now. The CLI cannot
 * reach into the orchestrator process, so the request rides on disk like reset-counters':
 * a per-role marker file a running fleet consumes within one poll cycle (the runner's
 * abortTick kills the pi child and resets the worktree to main). Requires a live harness —
 * with no fleet there is nothing to consume the marker. The loop stays enabled: it backs
 * off normally and later ticks proceed as usual. */
export async function cmdAbort(root: string, args: string[]): Promise<void> {
  // As in cmdLogs: the config exists only to validate the id against built-ins plus
  // user-defined loops; a missing --role fails before it is ever needed.
  const role = args.includes("--role") ? parseRoleFlag(args, knownRoleIds(loadConfig(root))) : null;
  if (!role) fail("abort requires --role <id> (e.g. `--role feature`)");
  if (!orchestratorAlive(root)) fail("no harness is running — start it with `tumwater run` first");
  writeJsonFile(abortRequestPath(root, role), { at: Date.now() });
  let confirmation = `abort requested for ${role} — a running fleet applies it within ~2s`;
  if (role === DIRECTOR_ROLE) {
    // The director's in-flight prompt was dequeued from the inbox file at tick start and an
    // abort discards it without re-queueing — say so, since the discard is otherwise silent.
    confirmation +=
      "; its current in-flight prompt will be discarded (re-submit with `tumwater prompt` if you want it retried)";
  }
  process.stdout.write(confirmation + "\n");
}

/** `tumwater pause`: stop every role loop from starting NEW ticks while in-flight ones finish
 * and the director keeps running (its prompts outrank operator gates, like under the budget
 * cap). The marker is persistent state, not a one-shot request: its presence means paused
 * until `resume` removes it — so pausing before startup starts an already-paused fleet.
 * Unlike abort, no live harness is required; when none runs, say where the pause takes effect
 * instead of failing. Idempotent: a second pause reports the existing marker as-is. */
export async function cmdPause(root: string): Promise<void> {
  // pauseFleet in src/state.ts is the single writer of the pause marker — the GUI's
  // /api/pause toggle calls it too, so the CLI and the dashboard cannot drift on format
  // or idempotence; a false return means the marker was already there.
  if (!pauseFleet(root)) {
    process.stdout.write("already paused\n");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  process.stdout.write(
    `fleet paused — role loops stop starting new ticks${when} (in-flight ticks finish; the director keeps running your prompts)${tail}\n`,
  );
}

/** `tumwater resume`: lift a fleet pause by removing its marker. Idempotent like pause: with
 * no marker there is nothing to do. No live harness required — resuming before startup just
 * means the next `tumwater run` starts unpaused. */
export async function cmdResume(root: string): Promise<void> {
  // resumeFleet (src/state.ts) is the single remover, shared with the GUI toggle; a false
  // return means there was no marker to lift.
  if (!resumeFleet(root)) {
    process.stdout.write("not paused\n");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  process.stdout.write(`fleet resumed — role loops tick again${when}${tail}\n`);
}
