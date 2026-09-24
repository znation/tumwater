import fs from "node:fs";
import path from "node:path";
import type { LoopRunner } from "./loop.js";
import { logEvent } from "./events.js";
import { removeQuiet } from "./files.js";
import { readJsonFile } from "./json-files.js";
import { abortRequestPath, resetRequestPath, wakeRequestPath, STATE_DIR } from "./paths.js";

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
  return requested ? runners.filter((r) => requested.includes(r.role)) : [...runners];
}

/** Consume a pending reset request from `tumwater reset-counters`, if any: the CLI already
 * zeroed the state files; this also zeroes the affected runners' in-memory copies (which then
 * re-save), or their next tick's save would resurrect the pre-reset values. */
export function consumeResetRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = resetRequestPath(root);
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) r.resetCounters();
  if (affected.length > 0) {
    const [only] = affected;
    // One role → filed under that loop; several → one harness-level event listing them.
    if (affected.length === 1 && only) logEvent(root, { loop: only.role, type: "counters_reset" });
    else
      logEvent(root, {
        loop: "harness",
        type: "counters_reset",
        roles: affected.map((r) => r.role),
      });
  }
  removeQuiet(markerFile);
}

/** Consume a pending wake request from `tumwater wake [--role <id>]`, if any: the CLI
 * already cleared the state files; this also clears the affected runners' in-memory
 * schedules (backoffSeconds, nextRunAt), or their next save would resurrect the pre-wake
 * sleep window and the loops would keep sleeping until the original backoff expired. Each
 * woken role logs the existing `wake` event with the operator reason, so the fleet's
 * early ticks read in the feed as deliberate. */
export function consumeWakeRequest(root: string, runners: LoopRunner[]): void {
  const markerFile = wakeRequestPath(root);
  const affected = roleRequestTargets(markerFile, runners);
  if (affected === null) return;
  for (const r of affected) {
    r.wake();
    logEvent(root, { loop: r.role, type: "wake", reason: "operator" });
  }
  removeQuiet(markerFile);
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
