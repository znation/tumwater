/**
 * The dashboard's POST fleet-pause/wake command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts): pause,
 * pause-role, wake, and wake-cancel — with the `pauseForSecondsMs` / `pauseReasonField` /
 * `wakeInSecondsMs` body rules they share. Each handler adapts HTTP onto the domain work one
 * layer down (fleet/fleet-state, operator-intent) and touches no socket beyond its own `res`.
 */
import { normalizePauseReason, pauseFleet, pauseRole, resumeFleet, resumeRole } from "../fleet/fleet-state.js";
import { cancelWakes, PAUSE_FOR_MAX_MS, requestWake } from "../operator/operator-intent.js";
import { requirePausedFlag, validRoleIds } from "./gui-args.js";
import { badRequest, sendJson } from "./http-body.js";
import { gotSuffix } from "../text/text.js";
import { readPostBody, readRoleBody } from "./gui-endpoint-common.js";
import type http from "node:http";

/** The shared optional-seconds rule behind the timed pause's `forSeconds` and the scheduled
 * wake/stop's `inSeconds`: the field is absent (undefined) or a positive finite number of
 * seconds within the CLI's 90-day cap — the two parallel validators used to restate this
 * smell, one per field name. Its null return means the 400 is already sent and the caller must
 * stop; its number return is the delay in milliseconds, which the timed-pause callers add
 * their own clock to (the marker's `until` deadline) and the wake/stop-schedule callers use
 * directly. `capHint` rides after the cap message for a field whose capped form earns an extra
 * pointer (pause's standing-pause note); the messages name the field so pause (`forSeconds`)
 * and wake/stop-schedule (`inSeconds`) each read correctly. */
function boundedSecondsMs(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  field: string,
  capHint = "",
): number | undefined | null {
  const seconds = body[field];
  if (seconds === undefined) return undefined;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    badRequest(res, `${field} must be a positive number of seconds${gotSuffix(seconds)}`);
    return null;
  }
  if (seconds * 1000 > PAUSE_FOR_MAX_MS) {
    badRequest(res, `${field} is capped at ${PAUSE_FOR_MAX_MS / 1000} seconds (90 days)${gotSuffix(seconds)}${capHint}`);
    return null;
  }
  return Math.round(seconds * 1000);
}

/** The shared `forSeconds` rule of /api/pause and /api/pause-role: undefined when absent, the
 * deadline in epoch milliseconds when valid, null after sending the 400 (only with
 * `paused: true`, a positive finite number, within the CLI's 90-day cap — the numeric body
 * rides boundedSecondsMs). */
function pauseForSecondsMs(res: http.ServerResponse, body: Record<string, unknown>, pausing: boolean): number | undefined | null {
  const forSeconds = body.forSeconds;
  if (forSeconds === undefined) return undefined;
  if (!pausing) {
    badRequest(res, "forSeconds only applies when pausing (paused: true)");
    return null;
  }
  const ms = boundedSecondsMs(res, body, "forSeconds", " — pause without it for a standing pause");
  return ms === null || ms === undefined ? ms : Date.now() + ms;
}

/** The optional `reason` of /api/pause: undefined when absent or blank, the raw string when
 * given with `paused: true` (pauseFleet folds and caps it), null after sending the 400. */
function pauseReasonField(res: http.ServerResponse, body: Record<string, unknown>, pausing: boolean): string | undefined | null {
  const reason = body.reason;
  if (reason === undefined) return undefined;
  if (!pausing) {
    badRequest(res, "reason only applies when pausing (paused: true)");
    return null;
  }
  if (typeof reason !== "string") {
    badRequest(res, `reason must be a string${gotSuffix(reason)}`);
    return null;
  }
  return reason.trim() === "" ? undefined : reason;
}

/** Handle POST /api/pause: the dashboard's pause control — the same operator gate
 * `tumwater pause [--for <duration>]` and `resume` write, via fleet/fleet-state.ts's shared writers
 * (pauseFleet/resumeFleet) so the CLI and the GUI cannot drift on the marker's format or
 * idempotence. Same body discipline as /api/prompt and /api/budget (readJsonObject → 400
 * malformed/non-object, 413 oversized); the target state is explicit (`paused: true|false`)
 * rather than a toggle, so a retried request is idempotent. An optional `forSeconds` makes it
 * a timed pause (the marker's `until`, capped like the CLI's `--for`); it only accompanies
 * `paused: true`, as does an optional `reason` (the CLI's `pause --reason`, stored folded and
 * capped by pauseFleet; the 200 body echoes what was stored). */
export async function handlePause(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"paused": true, "forSeconds": 3600}');
  if (!body) return;
  const value = requirePausedFlag(res, body);
  if (value === null) return;
  const untilMs = pauseForSecondsMs(res, body, value);
  if (untilMs === null) return;
  const reason = pauseReasonField(res, body, value);
  if (reason === null) return;
  if (value) pauseFleet(root, untilMs, reason);
  else resumeFleet(root);
  const stored = normalizePauseReason(reason);
  sendJson(res, 200, { ok: true, paused: value, ...(untilMs === undefined ? {} : { until: untilMs }), ...(stored ? { reason: stored } : {}) });
}

/** The `inSeconds` rule of /api/wake: undefined when absent, the delay in milliseconds when
 * valid, null after sending the 400 (a positive finite number within the CLI's 90-day cap).
 * A duration, not a deadline: requestWake takes `inMs` and reads its own clock. */
export function wakeInSecondsMs(res: http.ServerResponse, body: Record<string, unknown>): number | undefined | null {
  return boundedSecondsMs(res, body, "inSeconds");
}

/** Handle POST /api/wake: the dashboard's per-row wake control — the same marker-writing
 * core `tumwater wake` calls (requestWake), so the CLI and the GUI cannot drift on the
 * state-file edits or the marker. `{}`/a missing role targets every configured role (the
 * CLI's all-roles default); a given role validates exactly like /api/transcript. Same body
 * discipline as /api/pause (readJsonObject → 400 malformed/non-object, 413 oversized). An
 * optional `inSeconds` schedules the wake for later, like `tumwater wake --in` (same
 * 90-day cap). */
export async function handleWake(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature"}', root, true);
  if (!body) return;
  const inMs = wakeInSecondsMs(res, body);
  if (inMs === null) return;
  sendJson(res, 200, {
    ok: true,
    message: requestWake(root, body.role === undefined ? validRoleIds(root) : [body.role as string], inMs),
  });
}

/** Handle POST /api/wake-cancel: the dashboard's cancel of pending scheduled wakes — the same
 * core `tumwater wake --cancel` calls (cancelWakes). A missing role cancels every pending wake;
 * a given role validates like /api/wake and drops only its share. */
export async function handleWakeCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature"}', root, true);
  if (!body) return;
  sendJson(res, 200, { ok: true, message: cancelWakes(root, body.role as string | undefined) });
}

/** Handle POST /api/pause-role: the dashboard's per-row pause/resume control — the same
 * marker-writing core `tumwater pause --role` / `resume --role` call (pauseRole/resumeRole),
 * so the CLI and the GUI cannot drift on the marker's format or idempotence. The target state
 * is explicit (`paused: true|false`) like /api/pause, so a retried request is idempotent; the
 * fleet-wide pause composes freely — its gate is checked first at scheduling, and the role
 * marker still records the operator's per-row intent. Same body discipline as /api/wake
 * (readJsonObject → 400 malformed/non-object, 413 oversized; the role validates through the
 * shared rejectBadRole wording). */
export async function handlePauseRole(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature", "paused": true}', root);
  if (!body) return;
  const value = requirePausedFlag(res, body);
  if (value === null) return;
  const untilMs = pauseForSecondsMs(res, body, value);
  if (untilMs === null) return;
  const changed = value
    ? pauseRole(root, body.role as string, untilMs)
    : resumeRole(root, body.role as string);
  sendJson(res, 200, { ok: true, changed, paused: value, ...(untilMs === undefined ? {} : { until: untilMs }) });
}
