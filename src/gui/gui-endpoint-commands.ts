/**
 * The dashboard's POST operator endpoint handlers (src/gui/gui-server.ts routes to them): prompt,
 * prompt-role, prompt-cancel, budget, config-set, pause, wake, restart, abort, pause-role —
 * everything that writes state or queues work — plus the shared request-body helpers
 * (readPostBody, readRoleBody, checkedPromptImages, checkedPromptFields) each mutating handler
 * guards its inputs with. The GET data endpoints (transcript, backlog, report, failures, history,
 * tick, diff, config) stay in gui/gui-endpoints.ts; each handler answers its request and touches
 * no socket beyond its own `res`,
 * and the domain work lives one layer down (inbox.ts, inbox-submit.ts, config-write.ts,
 * fleet/fleet-state.ts, operator/operator-intent.ts) — this module only adapts HTTP onto it.
 */
import { promptPreview } from "../inbox/inbox.js";
import { cancelQueuedFile, queueFileNameProblem } from "../inbox/inbox-cancel.js";
import { submitPrompt } from "../inbox/inbox-submit.js";
import { promptImagesProblem, type PromptImageInput } from "../inbox/inbox-attachments.js";
import { checkDailyBudgetUsd, setConfigKey, setDailyBudgetUsd } from "../config/config-write.js";
import { pauseFleet, pauseRole, resumeFleet, resumeRole } from "../fleet/fleet-state.js";
import { PAUSE_FOR_MAX_MS, requestAbort, requestRestart, requestWake, submitRolePromptAndWake, type RequestResult } from "../operator/operator-intent.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { rejectBadRole, requirePausedFlag, requirePromptText, validRoleIds } from "./gui-args.js";
import { readJsonObject, sendJson } from "./http-body.js";
import { EDITABLE_CONFIG_KEYS } from "../config/config-editable-keys.js";
import { gotSuffix } from "../text/text.js";
import type http from "node:http";

/** Every POST handler's shared opening: readJsonObject reads the body and — when it is
 * oversized, malformed, or not a JSON object — has already written the 413/400 itself. Its
 * null return therefore means the response is sent and the handler must stop without touching
 * it again; each handler used to restate that contract in its own inline comment, and this is
 * the one home for it. Handlers keep their own `if (!body) return` bail so the stop stays
 * visible in their flow. */
async function readPostBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  example: string,
): Promise<Record<string, unknown> | null> {
  const body = await readJsonObject(req, res, example);
  if (body === null) return null; // 4xx already sent — oversized or not a JSON object
  return body;
}

/** The role-targeting POST handlers' shared prologue: readPostBody (400/413 sent on a null
 * return) plus rejectBadRole's shared role validation (400 sent on a null return), so the
 * wake/abort/prompt-role/pause-role family states the body-discipline-and-role-check pairing
 * once instead of two guard lines per handler. Its null return means the response is already
 * written and the handler must stop; callers keep their own `if (!body) return` bail. Exactly
 * four call sites — handlePromptRole, handleWake (allowMissing, the {} → all-roles default),
 * handleAbort, and handlePauseRole; handlePromptCancel deliberately does not ride it, since
 * its role is optional and validates only when present. */
async function readRoleBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  example: string,
  root: string,
  allowMissing = false,
): Promise<Record<string, unknown> | null> {
  const body = await readPostBody(req, res, example);
  if (body === null) return null; // 4xx already sent — oversized, malformed, or not an object
  if (rejectBadRole(root, res, body.role, allowMissing)) return null; // 400 already sent
  return body;
}
/** Handle POST /api/prompt: queue a director prompt. An over-long prompt
 * (DIRECTOR_PROMPT_MAX_CHARS) is a user-input error, not a server fault: the shared length
 * rule answers 400 — an unexpected submit failure (EACCES) still reaches the server's outer
 * catch as the 500 its gui-server test pins. An optional images array (the composer's
 * dropped/pasted attachments) is validated before anything is queued: a bad image — wrong
 * extension, too many, undecodable, oversized — answers 400 naming the rule, with no queue
 * file and no image written. */
export async function handlePrompt(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"text": "..."}');
  if (!body) return;
  const fields = checkedPromptFields(res, body);
  if (!fields) return;
  submitPrompt(root, fields.text, fields.images);
  sendJson(res, 200, { ok: true });
}

/** The images field of a prompt endpoint's body, validated before anything touches the disk.
 * Three outcomes, deliberately distinct: `undefined` — no images field, a text-only submit,
 * continue without attachments; an array — the field was present and valid, attach it (a
 * present-but-empty array is fine and saves nothing); `null` — the field was present and
 * invalid, the 400 naming the rule is already sent, stop. The absent and invalid cases must
 * not share a value: a text-only POST is the common path and must proceed. */
function checkedPromptImages(res: http.ServerResponse, body: Record<string, unknown>): PromptImageInput[] | undefined | null {
  if (body.images === undefined) return undefined;
  const problem = promptImagesProblem(body.images);
  if (problem) {
    sendJson(res, 400, { error: problem });
    return null;
  }
  return body.images as PromptImageInput[];
}

/** The prompt endpoints' shared body tail: requirePromptText (400 on a null return) then
 * checkedPromptImages (400 on a null return), so /api/prompt and /api/prompt-role read the
 * same two fields in the same order and a body wrong in both still answers the text problem
 * first. Null means a 400 is already sent; callers keep their own `if (!fields) return` bail. */
function checkedPromptFields(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  role: string = DIRECTOR_ROLE,
): { text: string; images: PromptImageInput[] | undefined } | null {
  const text = requirePromptText(res, body, role);
  if (text === null) return null;
  const images = checkedPromptImages(res, body);
  if (images === null) return null;
  return { text, images };
}

/** Handle POST /api/prompt-role: queue a prompt for one loop — the dashboard's per-row
 * prompt affordance submits here, calling the same path `tumwater prompt --role <id>` uses
 * (submitRolePrompt enqueues into that loop's own queue and logs under it, then a single-role
 * wake brings the live loop in within one poll; the wake message rides back for the flash).
 * The role validates exactly like /api/transcript (the shared rejectBadRole wording), and the
 * body discipline is /api/prompt's: readJsonObject → 400 malformed/non-object, 413 oversized,
 * text a non-empty string within the shared length rule → 400 otherwise — plus the same
 * optional images array and its validate-before-anything-is-written discipline. */
export async function handlePromptRole(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature", "text": "..."}', root);
  if (!body) return;
  const role = body.role as string;
  const fields = checkedPromptFields(res, body, role);
  if (!fields) return;
  sendJson(res, 200, { ok: true, message: submitRolePromptAndWake(root, role, fields.text, fields.images) });
}

/** Handle POST /api/prompt-cancel: retract one queued prompt addressed by its queue file —
 * the dashboard's per-row cancel affordance, the file-addressed twin of the CLI's
 * position-addressed `prompt --cancel`. The role is optional (absent cancels from the
 * director's queue) and validates exactly like /api/transcript; a file name failing the
 * basename guard (inbox-cancel.ts's queueFileNameProblem) is a user-input error answered 400 with
 * nothing touched on disk. A vanished file answers 200 { status: "gone" } — the loop already
 * dequeued the prompt, which is data for the flash line, not a server fault. Same body
 * discipline as /api/prompt (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "feature", "file": "<stamp>-<seq>-<pid>.md"}');
  if (!body) return;
  if (body.role !== undefined && rejectBadRole(root, res, body.role)) return;
  const role = body.role === undefined ? DIRECTOR_ROLE : (body.role as string);
  const fileProblem = queueFileNameProblem(body.file);
  if (fileProblem) {
    sendJson(res, 400, { error: fileProblem });
    return;
  }
  const outcome = cancelQueuedFile(root, role, body.file as string);
  sendJson(
    res,
    200,
    outcome.status === "cancelled"
      ? { ok: true, status: "cancelled", preview: promptPreview(outcome.text) }
      : { ok: true, status: "gone" },
  );
}

/** Handle POST /api/budget: the dashboard's budget-badge editor saves the daily cost cap —
 * same body discipline as /api/prompt (readJsonObject), and the same shared validation rule +
 * atomic setter the TUI's Ctrl+B uses, so both surfaces write tumwater.json identically and
 * the running orchestrator picks the change up on its next ~2 s poll. */
export async function handleBudget(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"maxDailyCostUsd": 25}');
  if (!body) return;
  const value = body.maxDailyCostUsd;
  if (value === undefined) {
    sendJson(res, 400, { error: "maxDailyCostUsd required" });
    return;
  }
  // The shared rule (finite ≥ 0; 0 disables): missing/non-finite/negative → 400 with
  // the offending value named.
  const problem = checkDailyBudgetUsd(value);
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }
  const result = setDailyBudgetUsd(root, value as number);
  if (!result.ok) {
    // The value was valid — this is a server-side failure (broken tumwater.json or
    // disk), not the client's fault.
    sendJson(res, 500, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, maxDailyCostUsd: value as number });
}
/** Handle POST /api/config-set: the Settings view's per-key Save — one curated key set to
 * one JSON value, through setConfigKey so the browser cannot drift from the CLI's rules
 * (unknown-key refusal, the per-key validators' messages, whole-candidate validateConfig,
 * atomic write the running fleet picks up live). A key outside EDITABLE_CONFIG_KEYS is
 * refused 400 with the key named — a known-but-not-curated key (customLoops) included, so
 * the panel's reach stays exactly EDITABLE_CONFIG_KEYS. The body's value is re-encoded with
 * JSON.stringify before setConfigKey parses it back, so `set model gpt-5`'s
 * JSON-or-literal rule is bypassed harmlessly: the browser already sent parsed JSON.
 * Same body discipline as /api/budget (readPostBody → 400 malformed/non-object, 413
 * oversized). */
export async function handleConfigSet(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"key": "model", "value": "gpt-5"}');
  if (!body) return;
  const key = body.key;
  if (typeof key !== "string" || !(EDITABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
    sendJson(res, 400, { error: `key must be one of ${EDITABLE_CONFIG_KEYS.join(", ")}${gotSuffix(key ?? null)}` });
    return;
  }
  if (body.value === undefined) {
    sendJson(res, 400, { error: `value required for ${key}` });
    return;
  }
  // setConfigKey takes the raw CLI text; a JSON round-trip of an already-parsed value is
  // exact (JSON.parse(JSON.stringify(v)) === v), so the shared write path applies unchanged.
  const result = setConfigKey(root, key, JSON.stringify(body.value));
  if (!result.ok) {
    sendJson(res, 400, { error: `${key}: ${result.error}` });
    return;
  }
  sendJson(res, 200, { ok: true, key, value: result.value, oldValue: result.oldValue });
}

/** Handle POST /api/pause: the dashboard's pause control — the same operator gate
 * `tumwater pause [--for <duration>]` and `resume` write, via fleet/fleet-state.ts's shared writers
 * (pauseFleet/resumeFleet) so the CLI and the GUI cannot drift on the marker's format or
 * idempotence. Same body discipline as /api/prompt and /api/budget (readJsonObject → 400
 * malformed/non-object, 413 oversized); the target state is explicit (`paused: true|false`)
 * rather than a toggle, so a retried request is idempotent. An optional `forSeconds` makes it
 * a timed pause (the marker's `until`, capped like the CLI's `--for`); it only accompanies
 * `paused: true`. */
export async function handlePause(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"paused": true, "forSeconds": 3600}');
  if (!body) return;
  const value = requirePausedFlag(res, body);
  if (value === null) return;
  const forSeconds = body.forSeconds;
  if (forSeconds !== undefined) {
    if (!value) {
      sendJson(res, 400, { error: "forSeconds only applies when pausing (paused: true)" });
      return;
    }
    if (typeof forSeconds !== "number" || !Number.isFinite(forSeconds) || forSeconds <= 0) {
      sendJson(res, 400, { error: `forSeconds must be a positive number of seconds${gotSuffix(forSeconds)}` });
      return;
    }
    if (forSeconds * 1000 > PAUSE_FOR_MAX_MS) {
      sendJson(res, 400, { error: `forSeconds is capped at ${PAUSE_FOR_MAX_MS / 1000} seconds (90 days)${gotSuffix(forSeconds)} — pause without it for a standing pause` });
      return;
    }
  }
  const untilMs = typeof forSeconds === "number" ? Date.now() + Math.round(forSeconds * 1000) : undefined;
  if (value) pauseFleet(root, untilMs);
  else resumeFleet(root);
  sendJson(res, 200, { ok: true, paused: value, ...(untilMs === undefined ? {} : { until: untilMs }) });
}

/** Handle POST /api/wake: the dashboard's per-row wake control — the same marker-writing
 * core `tumwater wake` calls (requestWake), so the CLI and the GUI cannot drift on the
 * state-file edits or the marker. `{}`/a missing role targets every configured role (the
 * CLI's all-roles default); a given role validates exactly like /api/transcript. Same body
 * discipline as /api/pause (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handleWake(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature"}', root, true);
  if (!body) return;
  sendJson(res, 200, {
    ok: true,
    message: requestWake(root, body.role === undefined ? validRoleIds(root) : [body.role as string]),
  });
}

/** Reply for a boolean-claiming marker request (RequestResult): success maps to 200 with its
 * message, refusal to 409 — the request is valid but nothing can act on it, the same conflict
 * reading requestAbort's not-live error uses. /api/restart and /api/abort share it. */
function sendRequestResult(res: http.ServerResponse, result: RequestResult): void {
  if (!result.ok) {
    sendJson(res, 409, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, message: result.message });
}

/** Handle POST /api/restart: the dashboard's build-stale alert's refresh button — the same
 * marker-writing core a CLI surface would call (requestRestart), so the wording and the
 * not-pending refusal cannot drift. The not-pending error comes back 409 like /api/abort's
 * not-live one: the request is valid but nothing can act on it. Same body discipline as
 * /api/wake (readJsonObject → 400 malformed/non-object, 413 oversized; the body itself is
 * ignored — there are no options to force a restart). */
export async function handleRestart(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  sendRequestResult(res, requestRestart(root));
}

/** Handle POST /api/abort: the dashboard's per-row abort control — the same marker-writing
 * core `tumwater abort` calls (requestAbort). The role is required and validated like
 * /api/transcript; requestAbort's not-live error comes back 409 — the marker is valid but
 * nothing can consume it, a conflict rather than a client 400. The director variant's
 * message (the discarded-prompt note) rides through verbatim. */
export async function handleAbort(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature"}', root);
  if (!body) return;
  sendRequestResult(res, requestAbort(root, body.role as string));
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
  const changed = value
    ? pauseRole(root, body.role as string)
    : resumeRole(root, body.role as string);
  sendJson(res, 200, { ok: true, changed, paused: value });
}
