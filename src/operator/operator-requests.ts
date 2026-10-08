import fs from "node:fs";
import path from "node:path";
import type { LoopRunner } from "../loop/loop.js";
import { logEvent } from "../events/events.js";
import { removeQuiet } from "../files/files.js";
import { readJsonFile } from "../files/json-files.js";
import { loadLoopState, saveLoopState, zeroCounters } from "../loop/loop-state.js";
import { clearBackoff } from "../scheduling/backoff.js";
import {
  abortRequestPath,
  reclaimRequestPath,
  resetRequestPath,
  restartRequestPath,
  statePath,
  wakeRequestPath,
  STATE_DIR,
} from "../paths.js";

/** The in-flight landing fields `consumeAbortRequests` needs to cancel one. The
 * orchestrator's `InFlightLanding` carries exactly these plus its `promise`, and the vetting
 * stage's waiting `VettedLanding` extends it, so both are assignable here without this module
 * knowing about the drain. */
export interface AbortableLanding {
  roles: string[];
  userAborted: boolean;
  controller: AbortController;
}

/** Read the optional `roles` request marker the `reset-counters` and `wake` CLI commands drop
 * (both share the convention): null when no marker exists (nothing to consume this poll), the
 * listed roles' runners when the marker is a well-formed string array, and every runner when
 * the marker is corrupt or its list missing (a superset — both operations are idempotent, so
 * applying the same one to extra roles is safe). */
function roleRequestTargets(markerFile: string, runners: LoopRunner[]): LoopRunner[] | null {
  if (!fs.existsSync(markerFile)) return null;
  const marker = readJsonFile<{ roles?: unknown }>(markerFile);
  const requested =
    marker && Array.isArray(marker.roles) && marker.roles.every((r) => typeof r === "string")
      ? (marker.roles as string[])
      : null;
  return requested
    ? runners.filter((r) => requested.includes(r.role) || requested.includes(r.baseRole))
    : [...runners];
}

/** The requested roles that hold NO live runner and already have a persisted state file. A
 * runner carries the operation to the role's in-memory copy and saves it; a role without one
 * (disabled in tumwater.json, or outside a scoped round) is reached only through its state
 * file, and while a fleet is live this process is that file's single writer — the CLI wrote
 * only the marker. A role with no state file has no counters or schedule to change, and a
 * corrupt marker (no role list) yields none: the runner superset must not conjure new files
 * for roles the marker never named. */
function runnerlessTargets(root: string, markerFile: string, runners: LoopRunner[]): string[] {
  const marker = readJsonFile<{ roles?: unknown }>(markerFile);
  const requested =
    marker && Array.isArray(marker.roles) && marker.roles.every((r) => typeof r === "string")
      ? (marker.roles as string[])
      : null;
  if (!requested) return [];
  return requested.filter(
    (role) =>
      !runners.some((r) => r.role === role || r.baseRole === role) &&
      fs.existsSync(statePath(root, role)),
  );
}

/** Consume a pending reset request from `tumwater reset-counters`, if any: the CLI zeroed the
 * state files only when no fleet was running; this zeroes the affected runners' in-memory
 * copies (which then re-save), or their next tick's save would resurrect the pre-reset values,
 * and writes the zeroed state file directly for requested roles with no runner, which the CLI
 * left to its marker. */
export function consumeResetRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = resetRequestPath(root);
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) r.resetCounters();
  const runnerless = runnerlessTargets(root, markerFile, runners);
  for (const role of runnerless) saveLoopState(root, zeroCounters(loadLoopState(root, role)));
  const applied = [...affected.map((r) => r.role), ...runnerless];
  if (applied.length > 0) {
    const [only] = applied;
    // One role → filed under that loop; several → one harness-level event listing them.
    if (applied.length === 1 && only) logEvent(root, { loop: only, type: "counters_reset" });
    else logEvent(root, { loop: "harness", type: "counters_reset", roles: applied });
  }
  removeQuiet(markerFile);
}

/** Consume a pending wake request from `tumwater wake [--role <id>] [--in <duration>]`, if
 * any. Immediate wakes find the state files already cleared by the CLI when no fleet was
 * running; this clears the affected runners' in-memory schedules (backoffSeconds, nextRunAt),
 * or their next save would resurrect the pre-wake sleep window and the loops would keep
 * sleeping until the original backoff expired, and writes the cleared schedule directly for
 * requested roles with no runner, which the CLI left to its marker. A scheduled wake
 * (`--in`) carries a `notBeforeMs`: before the deadline the
 * marker is left in place (a later poll retries it — the wake lands within one poll cycle
 * after the deadline, the same delivery granularity prompt --at's consumer gives), and the
 * deadline-crossing poll's `wake()` call is what applies the state change, since the submit
 * deliberately skipped it. A non-numeric value reads as immediate (defensive; validation
 * happens at the CLI). Each woken role logs the existing `wake` event with the operator
 * reason, so the fleet's early ticks read in the feed as deliberate. */
export function consumeWakeRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = wakeRequestPath(root);
  if (!fs.existsSync(markerFile)) return;
  const marker = readJsonFile<{ notBeforeMs?: unknown }>(markerFile);
  // A null marker on an existing file is a corrupt marker: `tumwater wake` already cleared the
  // state files and the marker is consumed unconditionally, so wake every runner (the same
  // superset `roleRequestTargets` gives corrupt markers) and remove it — an early return here
  // would leave the wedge in place forever, since nothing else ever deletes the marker.
  const notBefore =
    marker === null ? undefined : typeof marker.notBeforeMs === "number" ? marker.notBeforeMs : undefined;
  if (notBefore !== undefined && notBefore > Date.now()) return;
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) {
    r.wake();
    logEvent(root, { loop: r.role, type: "wake", reason: "operator" });
  }
  for (const role of runnerlessTargets(root, markerFile, runners)) {
    saveLoopState(root, clearBackoff(loadLoopState(root, role), Date.now()));
    logEvent(root, { loop: role, type: "wake", reason: "operator" });
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
 * non-self-hosting fleet never has a stale build, so nothing could have written the marker) it
 * is still cleaned up. */
export function consumeRestartRequest(root: string, redeployer: { forceRestart(): void } | null | undefined): void {
  consumeMarkerRequest(restartRequestPath(root), () => redeployer?.forceRestart());
}

/** Consume a pending manual reclaim request from `tumwater reclaim` (plans/disk-floor.md, part
 * 3/4), if any: arm one background pass over every candidate on the controller — the same
 * single-flight runner as pressure and idle reclaim — then remove the marker. With no
 * controller (a fleet that predates the feature) the marker is still cleaned up. */
export function consumeReclaimRequest(root: string, reclaim: { requestManual(): void } | null | undefined): void {
  consumeMarkerRequest(reclaimRequestPath(root), () => reclaim?.requestManual());
}

/** Consume per-role abort requests from `tumwater abort --role <id>`: one marker file per
 * role (no parsing needed), so a request for an idle OR disabled loop is still cleaned up. A
 * running tick gets killed and logs exactly one event; anything else is a silent no-op — the
 * marker's presence IS the request, removing it acknowledges. Since merge queue 3/5 a role's
 * in-flight work is often a LANDING rather than a tick, so the landing's controller is passed
 * in: an abort for the role landing right now kills that too (the drain's task sees
 * `userAborted` and discards the pinned ref when the landing ends). There can be several
 * in-flight units at once (land-queue speed 2c) — one per change being vetted, the merge
 * slot's stack, and each vetted change waiting for it (flagged, then settled by the drain) — so
 * `landings` lists them all and the request stops whichever holds the role. The merge is a
 * whole STACK (merge queue 5/5), so the request matches ANY of its roles — `roles` is every role
 * it is landing right now, and a stop for one of them kills the whole stack: the lander cannot
 * split it (abandoning mid-stack would leave the pinned refs of the not-yet-processed changes
 * for one-at-a-time recovery, which is already the fallback), and the merge discards every
 * stacked ref when it ends. */
export function consumeAbortRequests(
  root: string,
  runners: LoopRunner[],
  landings: readonly AbortableLanding[],
): void {
  try {
    const markers = fs.readdirSync(path.join(root, STATE_DIR));
    for (const name of markers) {
      const m = /^abort-(.+)\.json$/.exec(name);
      if (!m) continue;
      const role = m[1]!;
      const runner = runners.find((r) => r.role === role);
      for (const landing of landings) {
        if (!landing.roles.includes(role)) continue;
        landing.userAborted = true;
        landing.controller.abort();
      }
      if (runner?.state.running) {
        runner.abortTick();
        logEvent(root, { loop: role, type: "tick_aborted" });
      }
      removeQuiet(abortRequestPath(root, role));
    }
  } catch {
    // .tumwater/ missing — nothing to consume (a fresh repo before the first tick).
  }
}
