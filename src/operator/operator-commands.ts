// vocabulary: plain
import { knownRoleIds, knownRoleIdsCached, loadConfig } from "../config/config.js";
import { fail, say, sayJson } from "../cli/cli-output.js";
import { failOverDurationCap, flagValue, parseCountFlag, parseDurationFlag, parseRoleFlag } from "../cli/cli-args.js";
import { errorMessage } from "../text/text.js";
import { PAUSE_FOR_OVERFLOW_HINT, REASON_VALUE_ERROR, ROLE_VALUE_ERROR } from "../cli/cli-flag-specs.js";
import { artifactPhrase, hasRetirableLeftovers, previewRetire, retireRole } from "./retire.js";
import { previewRevert, revertFollowUp, revertMergedCommit } from "./revert.js";
import { runMergedSha, runNotFoundMessage } from "../run/run-detail.js";
import { readRunDetail } from "../run/run-detail-data.js";
import { readRunRows } from "../history/history-data.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";
import { agree, plural, teamResumePhrase, pauseReasonSuffix } from "../text/phrases.js";
import { errCode } from "../errno.js";
import { shortSha } from "../text/format.js";
import { INSTANCE_ROLES } from "../roles/runner-ids.js";
import { allRoleIds, unknownRoleMessage } from "../roles/roles.js";
import {
  normalizePauseReason,
  pauseTeam,
  pauseRole,
  pausedRoles,
  resumeTeam,
  resumeRole,
} from "../team/team-state.js";
import { readOrchestratorInfo } from "../team/orchestrator-info.js";
import { pidAlive } from "../process/process.js";
import { inspectReclaimCandidates } from "../team/reclaim.js";
import {
  markerApplyNote,
  NO_HARNESS_ERROR,
  PAUSE_FOR_MAX_MS,
  cancelScheduledStopMessage,
  cancelWakes,
  listWakes,
  renderWakeList,
  requestAbort,
  requestResetCounters,
  requestRestart,
  requestScheduledStop,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  runManualReclaim,
  timedPauseBits,
} from "./operator-intent.js";

/** The CLI layer of the operator commands: the `reset-counters`, `wake`, `reclaim`, `abort`,
 * `pause`, `resume`, `stop`, and `retire` commands, split out of cli.ts so the command bodies
 * live beside their shared `--role` resolution. The marker-writing cores and shared
 * confirmations they print live in src/operator/operator-intent.ts (shared with the
 * dashboard and TUI); the team-side consumer half is src/operator/operator-requests.ts;
 * the `prompt` command, which drives the durable per-role queues rather than the marker
 * protocol, lives beside them in src/inbox/prompt-commands.ts, and the `config` command,
 * which reads and writes tumwater.json directly rather than touching team state, in
 * src/cli/config-commands.ts. Every command here is deliberately usable without a live
 * harness except `abort` and `stop`, which have nothing to reach when no team is up. */

/** The `--role <id>` value when given, resolved WITHOUT tumwater.json when it names a
 * built-in catalog role: the team itself tolerates a broken config (the live reload keeps
 * the last-known-good one), so an operator marker aimed at a built-in role must not depend
 * on the file parsing — the same resilience `logs --transcript` already has. A custom-role id or
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

/** The trimmed, non-empty pieces of a comma-separated `--role` value; null when `--role` is
 * absent, and a failure with ROLE_VALUE_ERROR when no piece remains (bare `--role`, `,`). */
function rolePieces(args: string[]): string[] | null {
  const value = flagValue(args, "--role");
  if (value === null) return null;
  const pieces = (value ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (pieces.length === 0) fail(ROLE_VALUE_ERROR);
  return pieces;
}

/** namedRole over a comma list (`--role clean,dedupe`): every piece resolves through namedRole
 * before the caller writes anything, so a bad id writes no marker. Deduplicated in first-seen
 * order; null when `--role` is absent. */
function namedRoleList(root: string, args: string[]): string[] | null {
  const pieces = rolePieces(args);
  if (pieces === null) return null;
  return [...new Set(pieces.map((piece) => namedRole(root, ["--role", piece])!))];
}

/** namedRole for the commands that write or lift the per-role pause marker, over a comma list
 * (`--role clean,dedupe`, like `history --role`): `feature-1` (`bugfix-1`) is the pause key of
 * instance 1 of a multi-instance role (src/roles/runner-ids.ts's instancePauseKey), kept
 * verbatim; every other piece resolves through namedRole. Every piece resolves before the
 * caller writes anything, so a bad id writes no marker. Deduplicated in first-seen order;
 * null when `--role` is absent. */
function pauseTargetRoles(root: string, args: string[]): string[] | null {
  const pieces = rolePieces(args);
  if (pieces === null) return null;
  const roles = pieces.map((piece) =>
    [...INSTANCE_ROLES].some((base) => piece === `${base}-1`) ? piece : namedRole(root, ["--role", piece])!,
  );
  return [...new Set(roles)];
}

/** The `--role <id>` value a marker command requires: namedRole's resolution plus the
 * command-specific "requires --role" failure. retire needs a target (unlike
 * reset-counters/resume/wake, which default to every role), so the guard lives here once and
 * names the calling command in the error. */
function requiredNamedRole(root: string, args: string[], command: string): string {
  const role = namedRole(root, args);
  if (!role) fail(`${command} requires --role <id> (e.g. \`--role feature\`)`);
  return role;
}

/** The role(s) a marker command targets: the `--role <id>[,<id>...]` value when given,
 * otherwise every role in the config. reset-counters and wake share the same all-roles
 * default, so it lives here once instead of drifting between their bodies. */
function targetRoles(root: string, args: string[]): string[] {
  return namedRoleList(root, args) ?? Object.keys(loadConfig(root).roles);
}

/** `tumwater reset-counters [--role <id>[,<id>...]]`: zero the per-role counters shown in the
 * dashboards so a fresh observation window can begin. Scheduling fields and pi session
 * continuity are untouched: roles keep sleeping/waking exactly as before. */
export async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  say(requestResetCounters(root, targetRoles(root, args)));
}

/** `tumwater wake [--role <id>[,<id>...]] [--in <duration> | --cancel | --list [--json]]`: tell the
 * team "whatever the roles were failing on is fixed — try again", so the named roles run
 * within one poll instead of
 * sleeping until their backoff expires. With `--in`, the wake is scheduled: the marker is
 * written now but consumed no earlier than now + duration, the same shape `pause --for`'s
 * auto-resume takes — the wake applies at the deadline, not at submit. With `--cancel`, the
 * pending scheduled wakes (or the named roles' share) are dropped instead; no wake is
 * written. With `--list`, every pending scheduled wake (or the named roles')
 * is printed, earliest first — `--json` as an array of {roles, atMs}; read-only. */
export async function cmdWake(root: string, args: string[]): Promise<void> {
  // `--in <duration>` (the scheduled wake): the command's own gate (runMarkerCommand's
  // rejectUnknownArgs, not cli.ts — the marker dispatch moved out from under main()'s switch)
  // has already restricted the flag to this command and validated its value — shape and the
  // 90-day cap both, via WAKE_IN_FLAG's validate — so its value is re-parsed here, beside the
  // writer it feeds. The cap is pause --for's: a longer horizon is a queued prompt or a
  // standing schedule's job, not a one-shot wake.
  const inRaw = flagValue(args, "--in");
  if (args.includes("--list")) {
    if (inRaw !== null || args.includes("--cancel")) fail("wake --list cannot be combined with --in or --cancel");
    const now = Date.now();
    const roles = namedRoleList(root, args) ?? undefined;
    const wakes = listWakes(root, roles, now);
    say(args.includes("--json") ? JSON.stringify(wakes) : renderWakeList(wakes, now, roles));
    return;
  }
  if (args.includes("--json")) fail("wake --json requires --list");
  if (args.includes("--cancel")) {
    if (inRaw !== null) fail("wake --cancel and --in cannot be combined");
    say(cancelWakes(root, namedRoleList(root, args) ?? undefined));
    return;
  }
  const inMs = inRaw !== null ? parseDurationFlag("wake --in", inRaw) : undefined;
  if (inMs !== undefined) failOverDurationCap("wake --in", inMs, PAUSE_FOR_MAX_MS);
  // requestWake takes the duration, not a deadline: it reads the clock once for both the
  // marker's deadline and its "wakes in" phrase, so no clock advance between two reads can reword
  // "45m" as "2699999ms".
  say(requestWake(root, targetRoles(root, args), inMs));
}

/** `tumwater reclaim [--dry-run]`: run one manual reclaim pass over every harness worktree
 * (plans/disk-floor.md, part 3/4). `--dry-run` lists each candidate with its idle age and how
 * many ignored paths `git clean -ndX` would remove, and changes nothing — it neither cleans a
 * worktree nor writes the worktree-use registry. With a live team the
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
        plural(c.paths, "ignored path"),
        ...(c.resumePending ? ["resume pending"] : []),
        ...(c.reclaimable ? [] : ["not idle-reclaimable"]),
      ];
      say(`${c.name}: ${notes.join(", ")}`);
    }
    return;
  }
  say(await runManualReclaim(root));
}

/** `tumwater abort --role <id>[,<id>...]`: kill the named roles' in-flight runs right now (a
 * comma list writes one marker per role). The CLI cannot
 * reach into the orchestrator process, so the request rides on disk like reset-counters':
 * a per-role marker file a running team consumes within one poll cycle (the runner's
 * abortRun kills the pi child and resets the worktree to main). Requires a live harness —
 * with no team there is nothing to consume the marker. The role stays enabled: it backs
 * off normally and later runs proceed as usual. */
export async function cmdAbort(root: string, args: string[]): Promise<void> {
  // As in cmdLogs: the config exists only to validate the id against built-ins plus
  // user-defined roles; a missing --role fails before it is ever needed.
  const roles = namedRoleList(root, args) ?? fail("abort requires --role <id> (e.g. `--role feature`)");
  for (const role of roles) {
    const result = requestAbort(root, role);
    if (!result.ok) fail(result.error);
    say(result.message);
  }
}

/** `tumwater restart`: apply a pending self-redeploy now, waiving the restart cooldown —
 * the terminal twin of the dashboard update alert's refresh button (POST /api/restart,
 * handleRestart in src/gui/gui-operator-commands.ts). Both call the same marker-writing
 * core requestRestart, so the confirmation (or refusal) is byte-for-byte the GUI's. Takes
 * no flags. */
export async function cmdRestart(root: string, _args: string[]): Promise<void> {
  const result = requestRestart(root);
  if (!result.ok) fail(result.error);
  say(result.message);
}

/** `tumwater pause [--role <id>[,<id>...]] [--for <duration>]`: with roles (a comma list pauses
 * each), stop THAT role from
 * starting new runs — in-flight ones finish, every other role (the director included)
 * keeps running; without one, stop every role from starting NEW runs while in-flight
 * ones finish and the director keeps running (its prompts outrank operator gates, like
 * under the budget cap). The markers
 * are persistent state, not one-shot requests: presence means paused until `resume` removes
 * it — so pausing before startup starts an already-paused team. Unlike abort, no live
 * harness is required; when none runs, say where the pause takes effect instead of failing.
 * Idempotent: a second pause reports the existing marker as-is. */
export async function cmdPause(root: string, args: string[] = [], now: number = Date.now()): Promise<void> {
  // `--for <duration>` (the timed pause): the ms-epoch deadline pauseTeam/pauseRole write
  // into the marker and every consumer honors — the command's own gate (runMarkerCommand's
  // rejectUnknownArgs) has already restricted the flag to this command and validated its
  // value — shape and the 90-day cap both, via durationFlagSpec("pause --for")'s validate —
  // so its value is re-parsed here, beside the writers it feeds.
  const forRaw = flagValue(args, "--for");
  const forMs = forRaw !== null ? parseDurationFlag("pause --for", forRaw) : undefined;
  // `--reason <text>` (the operator pause's why): the gate in cli.ts has already restricted
  // the flag to this command, and its trailing-no-value slip to the spec's wording, so here
  // a valueless or empty reason fails with that same line beside the writer it feeds. The
  // reason folds to one line (normalizePauseReason, the same home pauseTeam writes through)
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
  const roles = pauseTargetRoles(root, args);
  if (roles) {
    // The plan keeps per-role pauses anonymous (a per-role reason would need a per-role map
    // for no observed need), so a reason aimed at a role pause fails fast here — accepting
    // the flag and silently dropping the note would tell the operator the reason stands
    // when no marker carries it. Before any marker is written, beside the other fail-fasts.
    if (reason !== undefined)
      fail(
        "pause --reason states why the whole team is paused — a per-role pause carries no reason (drop --role, or run bare `tumwater pause --reason <text>`)",
      );
    // Per-role branch: pauseRole in src/team/team-state.ts is the single writer of the role
    // marker (the TUI's Ctrl+P and the dashboard's /api/pause-role toggle call it too), so
    // the CLI, TUI, and GUI cannot drift on format or idempotence; a false return means the
    // role was already in the set, which rolePauseMessage words — unless a `--for` stands,
    // which overwrites the deadline and reports the fresh confirmation.
    for (const role of roles) say(rolePauseMessage(root, role, pauseRole(root, role, untilMs), timed, now));
    return;
  }
  // pauseTeam in src/team/team-state.ts is the single writer of the pause marker — the GUI's
  // /api/pause toggle calls it too, so the CLI and the dashboard cannot drift on format
  // or idempotence; a false return means the marker was already there (a `--for` never
  // no-ops: it overwrites the standing deadline instead).
  // The reason rides the fresh pause write (or a `--for` overwrite): the same last-write-wins
  // rule as the deadline, so an "already paused" no-op keeps the standing note as-is.
  if (!pauseTeam(root, untilMs, reason)) {
    say("already paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed, now);
  const why = pauseReasonSuffix(reason);
  say(
    `team paused${forPhrase}${why} — roles start no new runs${when} (current runs finish; the director keeps running your messages)${note}${tail}`,
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

/** `tumwater stop`: SIGTERM the running orchestrator, which drains its in-flight runs and
 * exits — exactly the shutdown the supervised child's own SIGINT/SIGTERM handler performs, so
 * Ctrl+C and `stop` from another terminal are the same code path (the supervisor needs no
 * signal of its own: a clean child exit already ends its loop). Unlike the marker commands
 * above this reaches a real process, so a live harness is required. The pid-recycling risk
 * that `orchestratorAlive` already accepts everywhere (status, abort, pause) applies here
 * too: the info file is refreshed by the live orchestrator, so the window is small, and the
 * signal is the same one a human `kill <pid>` would send. */
export async function cmdStop(root: string, args: string[] = []): Promise<void> {
  const inRaw = flagValue(args, "--in");
  if (args.includes("--cancel")) {
    if (inRaw !== null) fail("stop --cancel and --in cannot be combined");
    say(cancelScheduledStopMessage(root));
    return;
  }
  if (inRaw !== null) {
    // The gate (STOP_IN_FLAG's validate) checked shape and cap; re-parse beside the writer.
    const ms = parseDurationFlag("stop --in", inRaw);
    failOverDurationCap("stop --in", ms, PAUSE_FOR_MAX_MS);
    const result = requestScheduledStop(root, ms);
    if (!result.ok) fail(result.error);
    say(result.message);
    return;
  }
  // Deliberately the same liveness gate and wording `requestAbort` uses: an unreadable info
  // file (torn write) and a dead recorded pid both mean nothing is running to stop.
  const info = readOrchestratorInfo(root);
  if (!info || !pidAlive(info.pid)) {
    fail(NO_HARNESS_ERROR);
  }
  // A pid that dies between the liveness check and the signal (ESRCH) means the team is
  // already stopped — say so and exit clean rather than surfacing Node's raw kill error;
  // anything else (EPERM on a recycled pid, …) comes back as signalOrchestrator's message.
  if (signalOrchestrator(info.pid) === "signalled")
    say("stop requested — the team finishes current work, then stops (the same path as Ctrl+C)");
  else
    say("the orchestrator exited before the stop signal arrived — nothing is running");
}

/** `tumwater resume [--role <id>[,<id>...]]`: with roles (a comma list lifts
 * each), lift that role's pause (removed from the per-role marker set); without one,
 * lift a team pause by removing its marker. Idempotent like pause: with no marker there
 * is nothing to do. No live harness required — resuming before startup just means the
 * next `tumwater run` starts unpaused. */
export async function cmdResume(root: string, args: string[] = []): Promise<void> {
  const roles = pauseTargetRoles(root, args);
  if (roles) {
    // resumeRole (src/team/team-state.ts) is the single remover of the per-role marker; a false
    // return means the role was never paused — the changed-state contract roleResumeMessage
    // words ("is already paused" vs "was not paused").
    for (const role of roles) say(roleResumeMessage(root, role, resumeRole(root, role)));
    return;
  }
  // resumeTeam (src/team/team-state.ts) is the single remover, shared with the GUI toggle;
  // a false return means there was no marker to lift.
  if (!resumeTeam(root)) {
    say("not paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  // The per-role pause outlives a team resume (the markers are independent), so the resumed
  // team's confirmation must name the roles still individually paused instead of claiming
  // "roles run again" for roles the scheduler keeps gated.
  const still = pausedRoles(root);
  const roleNote = still.length > 0
    ? ` (${still.join(", ")} ${agree(still.length, "is", "are")} still individually paused — \`tumwater resume --role <id>\` lifts each)`
    : "";
  say(`${teamResumePhrase()}${when}${roleNote}${tail}`);
}

/** The role id retire targets: a built-in or configured id as for the other marker commands, or
 * else any well-formed id that still has a branch or merge ref (a role no config names). */
async function retireTargetRole(root: string, args: string[]): Promise<string> {
  const role = flagValue(args, "--role");
  if (role === null) return requiredNamedRole(root, args, "retire");
  if (!role) fail(ROLE_VALUE_ERROR);
  if (allRoleIds().includes(role)) return role;
  let ids: string[];
  try {
    ids = knownRoleIds(loadConfig(root));
  } catch (err) {
    fail(errorMessage(err));
  }
  if (ids.includes(role) || (await hasRetirableLeftovers(root, role))) return role;
  fail(unknownRoleMessage(role, ids));
}

/** `tumwater retire --role <id> [--force] [--json]`: remove a disabled role's leftover worktree,
 * branch, merge ref, and paused-state marker. The collection, safety rails, and removal live in
 * src/operator/retire.ts; this is the render layer — one line per removed artifact, the skip lines
 * that make a second run idempotent, or the `--json` payload. */
export async function cmdRetire(root: string, args: string[]): Promise<void> {
  // The config exists only to validate the id against built-ins plus user-defined roles, with
  // the leftover-branch gate for ids no config names; a missing --role fails before it is needed.
  const role = await retireTargetRole(root, args);
  const force = args.includes("--force");
  if (args.includes("--dry-run")) {
    const preview = await previewRetire(root, role);
    if (args.includes("--json")) {
      sayJson({
        role,
        dryRun: true,
        wouldRemove: preview.wouldRemove,
        skipped: preview.skipped,
        objections: preview.objections,
      });
      return;
    }
    for (const name of preview.wouldRemove) say(`would remove ${artifactPhrase(name, role)}`);
    for (const name of preview.skipped) say(`nothing to remove: ${artifactPhrase(name, role)}`);
    for (const reason of preview.objections)
      say(force ? `--force overrides: ${reason}` : `would refuse: ${reason}`);
    say("dry run — nothing removed");
    return;
  }
  const result = await retireRole(root, role, { force });
  if (args.includes("--json")) {
    sayJson({ role, removed: result.removed, skipped: result.skipped });
    return;
  }
  for (const name of result.removed) say(`removed ${artifactPhrase(name, role)}`);
  for (const name of result.skipped) say(`nothing to remove: ${artifactPhrase(name, role)}`);
  if (result.removed.length === 0 && result.skipped.length === 0)
    say(`nothing to remove for role ${role}`);
}

const REVERT_USAGE = "usage: tumwater revert <sha>|<role> <n>|<role> --last [--dry-run]";

/** The sha the run `<role> <n>` (or the newest completed run of `<role>` under `last`) merged
 * under, resolved the way `tumwater history <role> <n>` and the dashboard's revert resolve it
 * (`runMergedSha`). Fails, exit 1, when the run is unknown or did not merge: revert is an
 * action, so a miss is an error rather than history's exit-0 "not found". */
function revertRunSha(root: string, positionals: string[], last: boolean): { sha: string; line: string } {
  const role = canonicalRoleId(positionals[0]!);
  const ids = knownRoleIdsCached(root);
  if (!ids.includes(role)) fail(`${unknownRoleMessage(role, ids)} (${REVERT_USAGE})`);
  const run = last
    ? (readRunRows(root, 1, role)[0]?.run ?? null)
    : parseCountFlag("revert <n>", positionals[1]);
  if (run === null) fail(`no completed run of ${role} in the event log`);
  const detail = readRunDetail(root, role, run);
  if (detail === null) fail(runNotFoundMessage(role, run));
  if (detail.result !== "merged")
    fail(`${role} run #${run} did not merge (result: ${detail.result ?? "unknown"}); there is nothing to revert`);
  const sha = runMergedSha(detail);
  if (sha === null)
    fail(`${role} run #${run} merged but the event log no longer names its commit; pass the sha from git log instead`);
  return { sha, line: `run ${role} #${run} merged as ${shortSha(sha)}` };
}

/** `tumwater revert <sha>|<role> <n>|<role> --last`: undo one merged change on main,
 * committing the inverse as `tumwater(operator): Revert <short sha>` under the primary-worktree
 * lock. The lock, branch guard, and fail-closed ref/conflict handling live in
 * src/operator/revert.ts; this renderer names the new main head and names the role
 * that made the reverted commit, when one did, as the one that may redo the work. */
export async function cmdRevert(root: string, args: string[]): Promise<void> {
  // `--dry-run` and `--last` are the only flags; the positionals select a sha (one), a run
  // (`<role> <n>`) or the newest run of a role (`<role>` with --last). A flag or any other
  // shape fails before anything is looked up or written.
  const dryRun = args.includes("--dry-run");
  const last = args.includes("--last");
  const rest = args.filter((a) => a !== "--dry-run" && a !== "--last");
  // A flag-shaped token is a dropped flag, not a commit: refuse it before rev-parse turns a
  // lone `--json` into the misleading "no such commit". Mirrors `config set`'s
  // flag-looking-value gate and gui-command.ts's --token gate, and a real sha never starts
  // with `-`.
  const flagged = rest.find((a) => a.startsWith("-"));
  if (flagged !== undefined)
    fail(`revert takes only --dry-run and --last (got ${flagged}); pass the commit or run to undo as the argument`);
  if (last ? rest.length !== 1 : rest.length < 1 || rest.length > 2)
    fail(`revert needs a commit or a run (${REVERT_USAGE})`);
  const run = last || rest.length === 2 ? revertRunSha(root, rest, last) : null;
  const sha = run?.sha ?? rest[0]!;
  const runLine = run?.line ?? null;
  if (dryRun) {
    const p = await previewRevert(root, sha);
    if (!p.ok) fail(p.error);
    if (runLine !== null) say(runLine);
    say(`would revert ${shortSha(p.sha)} ${p.subject}`);
    for (const path of p.paths) say(`  ${path}`);
    const on = `on ${p.primary} (HEAD ${shortSha(p.head)}); nothing was written`;
    if (p.applies && !p.dirty) say(`applies cleanly ${on}`);
    if (!p.applies) say(`would conflict ${on}`);
    if (p.dirty)
      say("the checkout has staged or unstaged changes, so tumwater revert would refuse until they are committed or stashed; nothing was written");
    if (!p.applies || p.dirty) process.exitCode = 1;
    return;
  }
  const result = await revertMergedCommit(root, sha);
  if (!result.ok) fail(result.error);
  if (runLine !== null) say(runLine);
  say(`main is now ${shortSha(result.headSha)}`);
  const followUp = revertFollowUp(result.subject);
  if (followUp !== null) say(followUp);
}
