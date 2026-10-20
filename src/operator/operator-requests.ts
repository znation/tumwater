// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import type { RoleRunner } from "../runner/runner.js";
import { logEvent, warnEvent, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { removeQuiet } from "../files/files.js";
import { errorMessage } from "../text/text.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { finiteNumber } from "../files/json-object.js";
import { loadRunnerState, saveRunnerState, zeroCounters } from "../runner/runner-state.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";
import { clearBackoff } from "../scheduling/backoff.js";
import {
  abortRequestPath,
  reclaimRequestPath,
  resetRequestPath,
  restartRequestPath,
  scheduledWakeDir,
  statePath,
  wakeRequestPath,
  STATE_DIR,
} from "../paths.js";

/** The in-flight merge fields `consumeAbortRequests` needs to cancel one. The orchestrator's
 * `InFlightMerge` carries exactly these plus its `promise`, and the verifying stage's waiting
 * `ApprovedMerge` extends it, so both are assignable here without this module knowing about the
 * drain. */
export interface AbortableMerge {
  roles: string[];
  userAborted: boolean;
  controller: AbortController;
}

/** Read the optional `roles` request marker the `reset-counters` and `wake` CLI commands drop
 * (both share the convention): null when no marker exists (nothing to consume this poll), the
 * listed roles' runners when the marker is a well-formed string array, and every runner when
 * the marker is corrupt or its list missing (a superset — both operations are idempotent, so
 * applying the same one to extra roles is safe). */
function roleRequestTargets(markerFile: string, runners: RoleRunner[]): RoleRunner[] | null {
  if (!fs.existsSync(markerFile)) return null;
  const requested = requestedRoles(markerFile);
  return requested
    ? runners.filter((r) => requested.includes(r.role) || requested.includes(r.baseRole))
    : [...runners];
}

/** The optional `roles` list of a request marker, as the CLI wrote it: the listed roles when
 * the marker is a well-formed string array, and null when the marker is missing, torn, or its
 * list malformed. The reset-counters and wake consumers share this shape check, so they cannot
 * disagree on what a corrupt marker means for the roles it names. */
function requestedRoles(markerFile: string): string[] | null {
  const marker = readJsonFile<{ roles?: unknown }>(markerFile);
  return marker && Array.isArray(marker.roles) && marker.roles.every((r) => typeof r === "string")
    ? marker.roles.map((r) => canonicalRoleId(r))
    : null;
}

/** The requested roles that hold NO live runner and already have a persisted state file. A
 * runner carries the operation to the role's in-memory copy and saves it; a role without one
 * (disabled in tumwater.json, or outside a scoped round) is reached only through its state
 * file, and while a team is live this process is that file's single writer — the CLI wrote
 * only the marker. A role with no state file has no counters or schedule to change, and a
 * corrupt marker (no role list) yields none: the runner superset must not conjure new files
 * for roles the marker never named. */
function runnerlessTargets(root: string, markerFile: string, runners: RoleRunner[]): string[] {
  const requested = requestedRoles(markerFile);
  if (!requested) return [];
  return requested.filter(
    (role) =>
      !runners.some((r) => r.role === role || r.baseRole === role) &&
      fs.existsSync(statePath(root, role)),
  );
}

/** Best-effort write of one operator-request event. The request's side effects have already
 * applied by the time this runs, so an unwritable events log must neither un-acknowledge the
 * marker nor escape the orchestrator's poll body (whose loop has no catch) and end the team.
 * One wake consumer logs per role, so a throw that escaped would also starve the roles after
 * the first. A failure is still reported on the same feed when that feed is writable. */
function logRequestEvent(root: string, event: Parameters<typeof logEvent>[1]): void {
  try {
    logEvent(root, event);
  } catch (err) {
    try {
      warnEvent(root, TUMWATER_SOURCE, `could not record ${event.type} request: ${errorMessage(err)}`);
    } catch {
      // The event feed is the failure; there is nothing left to report on.
    }
  }
}

/** Report one role's failed state save for a consumed request, best-effort. These consumers run
 * inside the orchestrator's catch-less poll loop, so an unwritable state file (ENOSPC, EACCES,
 * the path replaced by a directory) must not throw out of the poll and end the team — the very
 * disk pressure the team guards against would otherwise crash it. The caller has already applied
 * the in-memory side effect where it can (a live runner), and a runnerless role's file keeps its
 * previous content, so the warning is what names the un-persisted change. */
function warnStatePersistFailed(root: string, role: string, err: unknown): void {
  warnEventBestEffort(
    root,
    TUMWATER_SOURCE,
    `could not persist ${role}'s state for your request: ${errorMessage(err)}`,
  );
}

/** Consume a pending reset request from `tumwater reset-counters`, if any: the CLI zeroed the
 * state files only when no team was running; this zeroes the affected runners' in-memory
 * copies (which then re-save), or their next tick's save would resurrect the pre-reset values,
 * and writes the zeroed state file directly for requested roles with no runner, which the CLI
 * left to its marker. */
export function consumeResetRequest(root: string, runners: RoleRunner[]): void {
  const markerFile = resetRequestPath(root);
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) {
    try {
      r.resetCounters();
    } catch (err) {
      warnStatePersistFailed(root, r.role, err);
    }
  }
  // A runner's reset already applied in memory (resetCounters mutates then saves), so it counts
  // as applied; a runnerless role is reached only through its file, so it counts only when the
  // save succeeded — a failed one is named by its warning, never claimed by the summary event.
  const runnerless = runnerlessTargets(root, markerFile, runners);
  const runnerlessReset: string[] = [];
  for (const role of runnerless) {
    try {
      saveRunnerState(root, zeroCounters(loadRunnerState(root, role)));
      runnerlessReset.push(role);
    } catch (err) {
      warnStatePersistFailed(root, role, err);
    }
  }
  const applied = [...affected.map((r) => r.role), ...runnerlessReset];
  if (applied.length > 0) {
    const [only] = applied;
    // One role → filed under that role; several → one harness-level event listing them.
    if (applied.length === 1 && only) logRequestEvent(root, { source: only, type: "counters_reset" });
    else logRequestEvent(root, { source: TUMWATER_SOURCE, type: "counters_reset", roles: applied });
  }
  removeQuiet(markerFile);
}

/** Consume a pending wake request from `tumwater wake [--role <id>] [--in <duration>]`, if any.
 * Immediate wakes find the state files already cleared by the CLI when no team was running; this
 * clears the affected runners' in-memory schedules (backoffSeconds, nextRunAt), or their next save
 * would resurrect the pre-wake sleep window and the roles would keep sleeping until the original
 * backoff expired, and writes the cleared schedule directly for requested roles with no runner,
 * which the CLI left to its marker. A scheduled wake (`--in`) carries a `notBeforeMs`: before the
 * deadline the marker is left in place (a later poll retries it — the wake takes effect within one
 * poll cycle after the deadline, the same delivery granularity prompt --at's consumer gives), and
 * the deadline-crossing poll's `wake()` call is what applies the state change, since the submit
 * deliberately skipped it. A non-numeric or non-finite value (a hand edit's `1e999`) reads as
 * immediate (defensive; validation happens at the CLI) — leaving Infinity as a deadline would hold
 * `notBefore > Date.now()` true forever and strand the marker, which nothing else deletes. Each
 * woken role logs the existing `wake` event with the operator reason, so the team's early ticks
 * read in the feed as deliberate. */
export function consumeWakeRequest(root: string, runners: RoleRunner[]): void {
  // A legacy wake.json (the pre-upgrade build wrote scheduled wakes here) keeps its deadline.
  const markerFile = wakeRequestPath(root);
  // A null marker on an existing file is a corrupt marker: `tumwater wake` already cleared the
  // state files and the marker is consumed unconditionally, so wake every runner (the same
  // superset `roleRequestTargets` gives corrupt markers) and remove it — an early return here
  // would leave the wedge in place forever, since nothing else ever deletes the marker.
  if (fs.existsSync(markerFile) && !wakeNotDue(markerFile)) applyWakeMarker(root, markerFile, runners);
  // Scheduled wakes: one file each, applied once due. Writers only create files; a cancel
  // (`cancelScheduledWakes`) also deletes or rewrites files, but only those whose deadline is
  // still ahead, so it never races this consumer's apply of a due file. The window left is a
  // deadline crossing between the cancel's read and its write: the worst case is one extra
  // wake for the remaining roles, the same as a wake that was never cancelled.
  for (const file of scheduledWakeFiles(root)) if (!wakeNotDue(file)) applyWakeMarker(root, file, runners);
}

/** A scheduled-wake marker's deadline in ms, or undefined when it has none: undefined for a
 * missing or corrupt marker and for a `notBeforeMs` that is absent, non-numeric, or non-finite
 * (the "immediate" reading both the due-check and the pending-list apply — a hand edit's
 * `1e999` must not read as a forever-out deadline). */
function wakeDeadlineMs(markerFile: string): number | undefined {
  const marker = readJsonFile<{ notBeforeMs?: unknown }>(markerFile);
  return marker === null ? undefined : finiteNumber(marker.notBeforeMs, undefined);
}

/** Whether a wake marker's deadline still lies ahead: a missing, non-numeric, or non-finite
 * `notBeforeMs` reads as immediate (one helper owns the reading), and a null (corrupt) marker
 * is due. */
function wakeNotDue(markerFile: string): boolean {
  const notBefore = wakeDeadlineMs(markerFile);
  return notBefore !== undefined && notBefore > Date.now();
}

/** The scheduled-wake files in `scheduledWakeDir`, sorted; `.tmp-<pid>` leftovers of an atomic
 * write are skipped. A missing directory is an empty list. */
function scheduledWakeFiles(root: string): string[] {
  const dir = scheduledWakeDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => path.join(dir, n));
}

/** The well-formed pending scheduled wakes (`tumwater wake --in`), earliest deadline first: a
 * pure reader that skips past-deadline and corrupt files and deletes nothing, so display
 * surfaces share one reader of the format. */
export function pendingScheduledWakes(root: string, now: number): { roles: string[]; atMs: number }[] {
  const out: { roles: string[]; atMs: number }[] = [];
  for (const file of scheduledWakeFiles(root)) {
    const roles = requestedRoles(file);
    const atMs = wakeDeadlineMs(file);
    if (roles && roles.length > 0 && atMs !== undefined && atMs > now) out.push({ roles, atMs });
  }
  return out.sort((x, y) => x.atMs - y.atMs);
}

/** Drop the pending scheduled wakes (`tumwater wake --cancel`), returning how many files it
 * removed or rewrote. Only files whose deadline still lies ahead are touched; due and corrupt
 * files stay the consumer's to apply. Without `roles` each pending file is removed. With `roles`,
 * files naming none of them are skipped, a file left with no role is removed, and a file naming
 * others too is rewritten without the listed ones (same `at` and `notBeforeMs`). */
export function cancelScheduledWakes(root: string, roles?: string[]): number {
  let count = 0;
  for (const file of scheduledWakeFiles(root)) {
    if (!wakeNotDue(file)) continue;
    if (roles === undefined) {
      removeQuiet(file);
      count++;
      continue;
    }
    const named = requestedRoles(file);
    if (!named?.some((r) => roles.includes(r))) continue;
    const marker = readJsonFile<{ at?: unknown; notBeforeMs?: unknown }>(file);
    if (!marker) continue;
    const rest = named.filter((r) => !roles.includes(r));
    if (rest.length === 0) removeQuiet(file);
    else writeJsonAtomic(file, { at: marker.at, roles: rest, notBeforeMs: marker.notBeforeMs });
    count++;
  }
  return count;
}

/** Apply one wake marker that is due: wake the runners it names (every runner for a corrupt
 * marker), write the cleared schedule for runnerless roles, then remove the marker. */
function applyWakeMarker(root: string, markerFile: string, runners: RoleRunner[]): void {
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) {
    try {
      r.wake();
    } catch (err) {
      warnStatePersistFailed(root, r.role, err);
      continue; // warn stands in for the wake event; nothing persisted to celebrate
    }
    logRequestEvent(root, { source: r.role, type: "wake", reason: "operator" }); // vocabulary-ok: wake reason code
  }
  for (const role of runnerlessTargets(root, markerFile, runners)) {
    try {
      saveRunnerState(root, clearBackoff(loadRunnerState(root, role), Date.now()));
    } catch (err) {
      warnStatePersistFailed(root, role, err);
      continue;
    }
    logRequestEvent(root, { source: role, type: "wake", reason: "operator" }); // vocabulary-ok: wake reason code
  }
  removeQuiet(markerFile);
}

/** Consume one marker-file request whose marker's presence IS the request: when the marker
 * exists, hand control to `act`, then remove it (a missing marker is a no-op). Shared by the
 * simple restart and reclaim consumers below, so the existence gate and the acknowledge-by-
 * removal cannot drift apart between them. */
function consumeMarkerRequest(markerFile: string, act: () => void): void {
  if (!fs.existsSync(markerFile)) return;
  act();
  removeQuiet(markerFile);
}

/** Consume a pending restart request from the dashboard's build-stale alert (POST /api/restart),
 * if any: tell the redeployer to force its next poll past the restart cooldown, then remove the
 * marker. The redeployer logs the `restart_forced` event itself; with no redeployer (a
 * non-self-hosting team never has a stale build, so nothing could have written the marker) it
 * is still cleaned up. */
export function consumeRestartRequest(root: string, redeployer: { forceRestart(): void } | null | undefined): void {
  consumeMarkerRequest(restartRequestPath(root), () => redeployer?.forceRestart());
}

/** Consume a pending manual reclaim request from `tumwater reclaim` (plans/disk-floor.md, part
 * 3/4), if any: arm one background pass over every candidate on the controller — the same
 * single-flight runner as pressure and idle reclaim — then remove the marker. With no
 * controller (a team that predates the feature) the marker is still cleaned up. */
export function consumeReclaimRequest(root: string, reclaim: { requestManual(): void } | null | undefined): void {
  consumeMarkerRequest(reclaimRequestPath(root), () => reclaim?.requestManual());
}

/** Consume per-role abort requests from `tumwater abort --role <id>`: one marker file per role (no
 * parsing needed), so a request for an idle OR disabled role is still cleaned up. A running tick
 * gets killed and logs exactly one event; anything else is a silent no-op — the marker's presence
 * IS the request, removing it acknowledges. Since merge queue 3/5 a role's in-flight work is often
 * a MERGE rather than a tick, so the merge's controller is passed in: an abort for the role being
 * merged right now kills that too (the drain's task sees `userAborted` and discards the pinned ref
 * when the merge ends). There can be several in-flight units at once (land-queue speed 2c) — one
 * per change being verified, the merge slot's stack, and each verified change waiting for it
 * (flagged, then settled by the drain) — so `merges` lists them all and the request stops
 * whichever holds the role. The merge is a whole STACK (merge queue 5/5), so the request matches
 * ANY of its roles — `roles` is every role it is merging right now, and a stop for one of them
 * kills the whole stack: the merger cannot split it (abandoning mid-stack would leave the pinned
 * refs of the not-yet-processed changes for one-at-a-time recovery, which is already the
 * fallback), and the merge discards every stacked ref when it ends. */
export function consumeAbortRequests(
  root: string,
  runners: RoleRunner[],
  merges: readonly AbortableMerge[],
): void {
  let markers: string[];
  try {
    markers = fs.readdirSync(path.join(root, STATE_DIR));
  } catch {
    return; // .tumwater/ missing — nothing to consume (a fresh repo before the first tick).
  }
  // Best-effort report of one marker's failure: the warning can itself throw when the
  // unwritable event feed is what failed, and there is nothing left to report on then.
  const warnFailure = (role: string, err: unknown): void => {
    try {
      warnEvent(root, TUMWATER_SOURCE, `could not consume abort request for ${role}: ${errorMessage(err)}`);
    } catch {
      // The feed is the failure; the remaining markers still get their turn below.
    }
  };
  for (const name of markers) {
    const m = /^abort-(.+)\.json$/.exec(name);
    if (!m) continue;
    const role = m[1]!;
    const runner = runners.find((r) => r.role === role);
    // One marker's failure must not skip the rest of the batch: an unwritable event log used
    // to throw on every poll at the first marker and starve every abort request that sorted
    // after it forever. Apply the side effects first; a failure there keeps the marker for the
    // next poll (retry), but still moves on so it cannot starve the others.
    try {
      for (const merge of merges) {
        if (!merge.roles.includes(role)) continue;
        merge.userAborted = true;
        merge.controller.abort();
      }
      if (runner?.state.running) runner.abortRun();
    } catch (err) {
      warnFailure(role, err);
      continue;
    }
    // The side effects applied: acknowledge the request. The run_aborted event is
    // observability, so a log failure must not un-acknowledge an abort that already happened.
    removeQuiet(abortRequestPath(root, role));
    if (runner?.state.running) {
      try {
        logEvent(root, { source: role, type: "run_aborted" });
      } catch (err) {
        warnFailure(role, err);
      }
    }
  }
}
