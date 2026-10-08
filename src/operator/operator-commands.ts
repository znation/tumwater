import { knownRoleIds, loadConfig } from "../config/config.js";
import { fail, say, sayJson } from "../cli/cli-output.js";
import { failOverDurationCap, flagValue, parseDurationFlag, parseRoleFlag } from "../cli/cli-args.js";
import { errorMessage } from "../text/text.js";
import { PAUSE_FOR_OVERFLOW_HINT, REASON_VALUE_ERROR } from "../cli/cli-flag-specs.js";
import { artifactPhrase, retireRole } from "./retire.js";
import { agree, fleetResumePhrase, pauseReasonSuffix } from "../text/phrases.js";
import { errCode } from "../errno.js";
import { allRoleIds } from "../roles/roles.js";
import {
  normalizePauseReason,
  pauseFleet,
  pauseRole,
  pausedRoles,
  resumeFleet,
  resumeRole,
} from "../fleet/fleet-state.js";
import { readOrchestratorInfo } from "../fleet/orchestrator-info.js";
import { pidAlive } from "../process/process.js";
import { inspectReclaimCandidates, reclaimPass } from "../fleet/reclaim.js";
import {
  markerApplyNote,
  NO_HARNESS_ERROR,
  PAUSE_FOR_MAX_MS,
  requestAbort,
  requestReclaim,
  requestResetCounters,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  timedPauseBits,
} from "./operator-intent.js";

/** The CLI layer of the operator commands: the `reset-counters`, `wake`, `reclaim`, `abort`,
 * `pause`, `resume`, `stop`, and `retire` commands, split out of cli.ts so the command bodies
 * live beside their shared `--role` resolution. The marker-writing cores and
 * shared confirmations they print live in src/operator/operator-intent.ts (shared with the dashboard
 * and TUI); the fleet-side consumer half is src/operator/operator-requests.ts; the `prompt` command,
 * which drives the durable per-loop queues rather than the marker protocol, lives beside
 * them in src/prompt/prompt-commands.ts, and the `config` command, which reads and writes
 * tumwater.json directly rather than touching fleet state, in src/cli/config-commands.ts. Every
 * command here is deliberately usable without a live harness except `abort` and `stop`,
 * which have nothing to reach when no fleet is up. */

/** The `--role <id>` value when given, resolved WITHOUT tumwater.json when it names a
 * built-in catalog role: the fleet itself tolerates a broken config (the live reload keeps
 * the last-known-good one), so an operator marker aimed at a built-in loop must not depend
 * on the file parsing — the same resilience `logs --role` already has. A custom-loop id or
 * an unknown id falls through to the config-backed check, which fails with the honest error
 * (the config problem, or "unknown role" naming every valid id). Returns null when no
 * --role is given. */
function namedRole(root: string, args: string[]): string | null {
  const role = flagValue(args, "--role");
  if (role === null) return null;
  if (role && allRoleIds().includes(role)) return role;
  try {
    return parseRoleFlag(args, knownRoleIds(loadConfig(root)));
  } catch (err) {
    fail(errorMessage(err)); // same message main().catch would print, but via the standard fail()
  }
}

/** The `--role <id>` value a marker command requires: namedRole's resolution plus the
 * command-specific "requires --role" failure. abort and retire both need a target (unlike
 * reset-counters/resume/wake, which default to every role), so the guard lives here once and
 * names the calling command in the error. */
function requiredNamedRole(root: string, args: string[], command: string): string {
  const role = namedRole(root, args);
  if (!role) fail(`${command} requires --role <id> (e.g. \`--role feature\`)`);
  return role;
}

/** The role(s) a marker command targets: the `--role <id>` value when given, otherwise every
 * role in the config. reset-counters and wake share the same all-roles default, so it lives
 * here once instead of drifting between their bodies. */
function targetRoles(root: string, args: string[]): string[] {
  const role = namedRole(root, args);
  return role ? [role] : Object.keys(loadConfig(root).roles);
}

/** `tumwater reset-counters [--role <id>]`: zero the per-loop counters shown in the
 * dashboards so a fresh observation window can begin. Scheduling fields and pi session
 * continuity are untouched: loops keep sleeping/waking exactly as before. */
export async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  say(requestResetCounters(root, targetRoles(root, args)));
}

/** `tumwater wake [--role <id>] [--in <duration>]`: tell the fleet "whatever the loops were
 * failing on is fixed — try again", so the named roles tick within one poll instead of
 * sleeping until their backoff expires. With `--in`, the wake is scheduled: the marker is
 * written now but consumed no earlier than now + duration, the same shape `pause --for`'s
 * auto-resume takes — the wake applies at the deadline, not at submit. */
export async function cmdWake(root: string, args: string[]): Promise<void> {
  // `--in <duration>` (the scheduled wake): the command's own gate (runMarkerCommand's
  // rejectUnknownArgs, not cli.ts — the marker dispatch moved out from under main()'s switch)
  // has already restricted the flag to this command and validated its value — shape and the
  // 90-day cap both, via WAKE_IN_FLAG's validate — so its value is re-parsed here, beside the
  // writer it feeds. The cap is pause --for's: a longer horizon is a queued prompt or a
  // standing schedule's job, not a one-shot wake.
  const inRaw = flagValue(args, "--in");
  const inMs = inRaw !== null ? parseDurationFlag("wake --in", inRaw) : undefined;
  if (inMs !== undefined) failOverDurationCap("wake --in", inMs, PAUSE_FOR_MAX_MS);
  // requestWake takes the duration, not a deadline: it reads the clock once for both the
  // marker's deadline and its "wakes in" phrase, so no tick between two reads can reword
  // "45m" as "2699999ms".
  say(requestWake(root, targetRoles(root, args), inMs));
}

/** `tumwater reclaim [--dry-run]`: run one manual reclaim pass over every harness worktree
 * (plans/disk-floor.md, part 3/4). `--dry-run` lists each candidate with its idle age and how
 * many ignored paths `git clean -ndX` would remove, and cleans nothing. With a live fleet the
 * pass is requested through the marker the orchestrator consumes, so in-use worktrees are
 * respected; with none running it runs in-process, since nothing is in use. */
export async function cmdReclaim(root: string, args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const idleHours = loadConfig(root).worktreeIdleReclaimHours;
  if (dryRun) {
    const candidates = await inspectReclaimCandidates(root, idleHours);
    if (candidates.length === 0) {
      say("nothing to reclaim — no reclaimable worktrees");
      return;
    }
    for (const c of candidates) {
      const notes = [
        `idle ${c.idleHours.toFixed(1)}h`,
        `${c.paths} ignored path${c.paths === 1 ? "" : "s"}`,
        ...(c.resumePending ? ["resume pending"] : []),
        ...(c.reclaimable ? [] : ["not idle-reclaimable"]),
      ];
      say(`${c.name}: ${notes.join(", ")}`);
    }
    return;
  }
  const { live } = markerApplyNote(root);
  if (live) {
    say(requestReclaim(root));
    return;
  }
  const result = await reclaimPass(root, "manual", { reclaimGB: 0 });
  if (!result) {
    say("nothing to reclaim");
    return;
  }
  say(`reclaimed ${result.worktrees.join(", ")} — freed ${result.freedGB.toFixed(1)} GB`);
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
  const role = requiredNamedRole(root, args, "abort");
  const result = requestAbort(root, role);
  if (!result.ok) fail(result.error);
  say(result.message);
}

/** `tumwater pause [--role <id>] [--for <duration>]`: with a role, stop THAT loop from starting new ticks —
 * in-flight ones finish, every other role (the director included) keeps running; without one,
 * stop every role loop from starting NEW ticks while in-flight ones finish and the director
 * keeps running (its prompts outrank operator gates, like under the budget cap). The markers
 * are persistent state, not one-shot requests: presence means paused until `resume` removes
 * it — so pausing before startup starts an already-paused fleet. Unlike abort, no live
 * harness is required; when none runs, say where the pause takes effect instead of failing.
 * Idempotent: a second pause reports the existing marker as-is. */
export async function cmdPause(root: string, args: string[] = [], now: number = Date.now()): Promise<void> {
  // `--for <duration>` (the timed pause): the ms-epoch deadline pauseFleet/pauseRole write
  // into the marker and every consumer honors — the command's own gate (runMarkerCommand's
  // rejectUnknownArgs) has already restricted the flag to this command and validated its
  // value — shape and the 90-day cap both, via durationFlagSpec("pause --for")'s validate — so its value is
  // re-parsed here, beside the writers it feeds.
  const forRaw = flagValue(args, "--for");
  const forMs = forRaw !== null ? parseDurationFlag("pause --for", forRaw) : undefined;
  // `--reason <text>` (the operator pause's why): the gate in cli.ts has already restricted
  // the flag to this command, and its trailing-no-value slip to the spec's wording, so here
  // a valueless or empty reason fails with that same line beside the writer it feeds. The
  // reason folds to one line (normalizePauseReason, the same home pauseFleet writes through)
  // so the confirmation line, the marker, and every single-line surface carry the same text
  // — a raw newline in the flag's value would otherwise break the header's one-line badge.
  const reasonRaw = flagValue(args, "--reason");
  if (reasonRaw !== null && (reasonRaw === undefined || reasonRaw.trim() === ""))
    fail(REASON_VALUE_ERROR);
  const reason = normalizePauseReason(reasonRaw ?? undefined);
  // Fail fast beside the parse, before any marker is written: an over-cap deadline is a
  // standing pause in disguise, and the message names the command that is one (the same
  // capped-flag idiom the --since windows in cli.ts use).
  if (forMs !== undefined)
    failOverDurationCap("pause --for", forMs, PAUSE_FOR_MAX_MS, PAUSE_FOR_OVERFLOW_HINT);
  // `now` is the one instant the deadline and the confirmation both read, injected by tests
  // so the wording they pin cannot drift with the wall clock — the same single-clock
  // discipline timedPauseBits's own `now` parameter follows.
  const timed = forMs === undefined ? undefined : { ms: forMs, untilMs: now + forMs };
  const untilMs = timed?.untilMs;
  const role = namedRole(root, args);
  if (role) {
    // The plan keeps per-role pauses anonymous (a per-role reason would need a per-role map
    // for no observed need), so a reason aimed at a role pause fails fast here — accepting
    // the flag and silently dropping the note would tell the operator the reason stands
    // when no marker carries it. Before any marker is written, beside the other fail-fasts.
    if (reason !== undefined)
      fail(
        "pause --reason states why the whole fleet is paused — a per-role pause carries no reason (drop --role, or run bare `tumwater pause --reason <text>`)",
      );
    // Per-role branch: pauseRole in src/fleet/fleet-state.ts is the single writer of the role
    // marker (the TUI's Ctrl+P and the dashboard's /api/pause-role toggle call it too), so
    // the CLI, TUI, and GUI cannot drift on format or idempotence; a false return means the
    // role was already in the set, which rolePauseMessage words — unless a `--for` stands,
    // which overwrites the deadline and reports the fresh confirmation.
    say(rolePauseMessage(root, role, pauseRole(root, role, untilMs), timed, now));
    return;
  }
  // pauseFleet in src/fleet/fleet-state.ts is the single writer of the pause marker — the GUI's
  // /api/pause toggle calls it too, so the CLI and the dashboard cannot drift on format
  // or idempotence; a false return means the marker was already there (a `--for` never
  // no-ops: it overwrites the standing deadline instead).
  // The reason rides the fresh pause write (or a `--for` overwrite): the same last-write-wins
  // rule as the deadline, so an "already paused" no-op keeps the standing note as-is.
  if (!pauseFleet(root, untilMs, reason)) {
    say("already paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed, now);
  const why = pauseReasonSuffix(reason);
  say(
    `fleet paused${forPhrase}${why} — role loops stop starting new ticks${when} (in-flight ticks finish; the director keeps running your prompts)${note}${tail}`,
  );
}

/** Deliver the stop signal to the recorded orchestrator pid: "signalled" when SIGTERM was
 * delivered, "gone" when the process died between the caller's liveness check and the
 * signal (ESRCH) — stop's goal is already met in that case, so the caller reports it as
 * done instead of failing with a raw `kill ESRCH`. Any other delivery error is rethrown
 * with the pid named: an operator seeing Node's bare "kill EPERM" cannot tell it means a
 * process they cannot signal (recycled pid owned by another user), not a broken harness. */
export function signalOrchestrator(pid: number): "signalled" | "gone" {
  try {
    process.kill(pid, "SIGTERM");
    return "signalled";
  } catch (err) {
    const code = errCode(err);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM")
      throw new Error(
        `stop could not signal pid ${pid} (EPERM) — it is owned by another user or the pid was recycled; kill it directly with \`kill ${pid}\``,
      );
    throw err;
  }
}

/** `tumwater stop`: SIGTERM the running orchestrator, which drains its in-flight ticks and
 * exits — exactly the shutdown the supervised child's own SIGINT/SIGTERM handler performs, so
 * Ctrl+C and `stop` from another terminal are the same code path (the supervisor needs no
 * signal of its own: a clean child exit already ends its loop). Unlike the marker commands
 * above this reaches a real process, so a live harness is required. The pid-recycling risk
 * that `orchestratorAlive` already accepts everywhere (status, abort, pause) applies here
 * too: the info file is refreshed by the live orchestrator, so the window is small, and the
 * signal is the same one a human `kill <pid>` would send. */
export async function cmdStop(root: string): Promise<void> {
  // Deliberately the same liveness gate and wording `requestAbort` uses: an unreadable info
  // file (torn write) and a dead recorded pid both mean nothing is running to stop.
  const info = readOrchestratorInfo(root);
  if (!info || !pidAlive(info.pid)) {
    fail(NO_HARNESS_ERROR);
  }
  // A pid that dies between the liveness check and the signal (ESRCH) means the fleet is
  // already stopped — say so and exit clean rather than surfacing Node's raw kill error;
  // anything else (EPERM on a recycled pid, …) comes back as signalOrchestrator's message.
  if (signalOrchestrator(info.pid) === "signalled")
    say("stop requested — the fleet drains its in-flight ticks and exits (the same path as Ctrl+C)");
  else
    say("the orchestrator exited before the stop signal landed — nothing is running");
}

/** `tumwater resume [--role <id>]`: with a role, lift that one role's pause (removed from the
 * per-role marker set); without one, lift a fleet pause by removing its marker. Idempotent
 * like pause: with no marker there is nothing to do. No live harness required — resuming
 * before startup just means the next `tumwater run` starts unpaused. */
export async function cmdResume(root: string, args: string[] = []): Promise<void> {
  const role = namedRole(root, args);
  if (role) {
    // resumeRole (src/fleet/fleet-state.ts) is the single remover of the per-role marker; a false
    // return means the role was never paused — the changed-state contract roleResumeMessage
    // words ("is already paused" vs "was not paused").
    say(roleResumeMessage(root, role, resumeRole(root, role)));
    return;
  }
  // resumeFleet (src/fleet/fleet-state.ts) is the single remover, shared with the GUI toggle; a false
  // return means there was no marker to lift.
  if (!resumeFleet(root)) {
    say("not paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  // The per-role pause outlives a fleet resume (the markers are independent), so the resumed
  // fleet's confirmation must name the roles still individually paused instead of claiming
  // "role loops tick again" for loops the scheduler keeps gated.
  const still = pausedRoles(root);
  const roleNote = still.length > 0
    ? ` (${still.join(", ")} ${agree(still.length, "is", "are")} still individually paused — \`tumwater resume --role <id>\` lifts each)`
    : "";
  say(`${fleetResumePhrase()}${when}${roleNote}${tail}`);
}

/** `tumwater retire --role <id> [--force] [--json]`: remove a disabled loop's leftover worktree,
 * branch, landing ref, and paused-state marker. The collection, safety rails, and removal live
 * in src/operator/retire.ts; this is the render layer — one line per removed artifact, the skip lines
 * that make a second run idempotent, or the `--json` payload. */
export async function cmdRetire(root: string, args: string[]): Promise<void> {
  // As in cmdAbort: the config exists only to validate the id against built-ins plus
  // user-defined loops; a missing --role fails before it is ever needed.
  const role = requiredNamedRole(root, args, "retire");
  const result = await retireRole(root, role, { force: args.includes("--force") });
  if (args.includes("--json")) {
    sayJson({ role, removed: result.removed, skipped: result.skipped });
    return;
  }
  for (const name of result.removed) say(`removed ${artifactPhrase(name, role)}`);
  for (const name of result.skipped) say(`nothing to remove: ${artifactPhrase(name, role)}`);
  if (result.removed.length === 0 && result.skipped.length === 0)
    say(`nothing to remove for role ${role}`);
}
