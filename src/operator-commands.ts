import { knownRoleIds, loadConfig } from "./config.js";
import { fail, parseRoleFlag } from "./cli-args.js";
import { errorMessage } from "./text.js";
import { allRoleIds, DIRECTOR_ROLE } from "./roles.js";
import { clearBackoff, loadLoopState, saveLoopState, zeroCounters } from "./state.js";
import { orchestratorAlive, pauseFleet, resumeFleet } from "./fleet-state.js";
import { writeJsonFile } from "./json-files.js";
import { abortRequestPath, resetRequestPath, wakeRequestPath } from "./paths.js";

/** The CLI half of the operator-intent protocol (the consumer half is src/operator-requests.ts):
 * `reset-counters`, `wake`, `abort`, `pause`, and `resume` write the on-disk markers the fleet
 * reads, split out of cli.ts so the whole marker protocol — producer and consumer — is legible
 * in one place. Every command here is deliberately usable without a live harness except
 * `abort`, which has nothing to consume its one-shot marker when no fleet is up. */

/** How a marker command reports when its marker takes effect, derived from one liveness
 * check: `live` says whether a fleet will consume it now, `when` is the " within ~2s" such a
 * fleet picks it up in, and `tail` names the fallback ("takes effect on the next `tumwater
 * run`") while no harness is running. Every marker command shares this so none can promise a
 * timing the others deny — the one place that user-facing contract lives. */
function markerApplyNote(root: string): { live: boolean; when: string; tail: string } {
  const live = orchestratorAlive(root);
  return {
    live,
    when: live ? " within ~2s" : "",
    tail: live ? "" : "; no harness is running, so it takes effect on the next `tumwater run`",
  };
}

/** The `--role <id>` value when given, resolved WITHOUT tumwater.json when it names a
 * built-in catalog role: the fleet itself tolerates a broken config (the live reload keeps
 * the last-known-good one), so an operator marker aimed at a built-in loop must not depend
 * on the file parsing — the same resilience `logs --role` already has. A custom-loop id or
 * an unknown id falls through to the config-backed check, which fails with the honest error
 * (the config problem, or "unknown role" naming every valid id). Returns null when no
 * --role is given. */
function namedRole(root: string, args: string[]): string | null {
  const i = args.indexOf("--role");
  if (i < 0) return null;
  const role = args[i + 1];
  if (role && allRoleIds().includes(role)) return role;
  try {
    return parseRoleFlag(args, knownRoleIds(loadConfig(root)));
  } catch (err) {
    fail(errorMessage(err)); // same message main().catch would print, but via the standard fail()
  }
}

/** The role(s) a marker command targets: the `--role <id>` value when given, otherwise every
 * role in the config. reset-counters and wake share the same all-roles default, so it lives
 * here once instead of drifting between their bodies. */
function targetRoles(root: string, args: string[]): string[] {
  const role = namedRole(root, args);
  return role ? [role] : Object.keys(loadConfig(root).roles);
}

/** `tumwater reset-counters [--role <id>]`: zero the per-loop counters shown in the
 * dashboards so a fresh observation window can begin. Zeroes each target's state file
 * directly (works while the harness is not running) and drops a marker that a running fleet
 * consumes within one poll cycle — it must also zero the runners' in-memory copies, or their
 * next save resurrects the pre-reset values. Scheduling fields and pi session continuity are
 * untouched: loops keep sleeping/waking exactly as before. */
export async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  const targets = targetRoles(root, args);
  for (const r of targets) saveLoopState(root, zeroCounters(loadLoopState(root, r)));
  writeJsonFile(resetRequestPath(root), { at: Date.now(), roles: targets });
  // Only a live fleet consumes the marker; without one the state files are already zeroed and
  // the next `tumwater run` is when the in-memory copies catch up. Name which case this is
  // rather than promising a ~2s pickup that no process will make.
  const { live, when } = markerApplyNote(root);
  process.stdout.write(
    `counters reset for ${targets.join(", ")} — ${
      live ? `a running fleet picks this up${when}` : "takes effect on the next `tumwater run` (no harness is running)"
    }\n`,
  );
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
  const targets = targetRoles(root, args);
  const now = Date.now();
  for (const r of targets) saveLoopState(root, clearBackoff(loadLoopState(root, r), now));
  writeJsonFile(wakeRequestPath(root), { at: now, roles: targets });
  // Same liveness contract as reset-counters and pause/resume: only a live fleet consumes the
  // marker, so say so instead of promising a poll that will not happen.
  const { live, when } = markerApplyNote(root);
  process.stdout.write(
    `wake requested for ${targets.join(", ")} — ${
      live ? `a running fleet applies it${when}` : "takes effect on the next `tumwater run` (no harness is running)"
    }\n`,
  );
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
  const role = namedRole(root, args);
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
