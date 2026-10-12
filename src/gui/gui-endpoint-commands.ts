/**
 * The dashboard's POST operator endpoint handlers (src/gui/gui-server.ts routes to them): prompt,
 * prompt-role, prompt-cancel, prompt-edit, budget, config-set, config-unset, pause, wake, restart, abort,
 * pause-role —
 * everything that writes state or queues work — plus the shared request-body helpers
 * (readPostBody, readRoleBody, checkedPromptImages, checkedPromptFields) each mutating handler
 * guards its inputs with. The GET data endpoints (transcript, backlog, report, failures, history,
 * tick, diff, config) stay in gui/gui-endpoints.ts; each handler answers its request and touches
 * no socket beyond its own `res`,
 * and the domain work lives one layer down (inbox.ts, inbox-submit.ts, config-write.ts,
 * fleet/fleet-state.ts, operator/operator-intent.ts) — this module only adapts HTTP onto it.
 */
import { fileEntryWithBody, normalizeEntryBody, OPERATOR_FILE_KINDS, tryCancelEntry, tryEditEntry, bodyStructureProblem, type CancelEntryOutcome, type EditEntryOutcome } from "../backlog/backlog-write.js";
import { promptPreview } from "../inbox/inbox.js";
import { cancelQueuedFile } from "../inbox/inbox-cancel.js";
import { editQueuedFile, type EditOutcome } from "../inbox/inbox-edit.js";
import { promptLengthProblem, submitPrompt } from "../inbox/inbox-submit.js";
import { promptImagesProblem, type PromptImageInput } from "../inbox/inbox-attachments.js";
import { tryAnswerQuestion, UNCLOSED_FENCE_MESSAGE, type AnswerOutcome } from "../cli/question-commands.js";
import { parseDurationMs } from "../cli/cli-args.js";
import { checkDailyBudgetUsd, setConfigKey, setDailyBudgetUsd, unsetConfigKey } from "../config/config-write.js";
import { normalizePauseReason, pauseFleet, pauseRole, resumeFleet, resumeRole } from "../fleet/fleet-state.js";
import { PAUSE_FOR_MAX_MS, cancelWakes, requestAbort, requestResetCounters, requestRestart, requestWake, runManualReclaim, submitRolePromptAndWake, type RequestResult } from "../operator/operator-intent.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { rejectBadQueueFileName, rejectBadRole, requireConfigKey, requirePausedFlag, requirePromptText, validRoleIds } from "./gui-args.js";
import { readJsonObject, sendJson } from "./http-body.js";
import { collapseWhitespace, errorMessage, gotSuffix } from "../text/text.js";
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
 * seven call sites — handlePromptRole, handleWake, handleWakeCancel and handleResetCounters (allowMissing, the
 * {} → all-roles default), handleAbort, handlePauseRole, and handleRoleNotes; handlePromptCancel deliberately does not ride it, since
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
 * catch as the 500 its gui-server-transport test pins. An optional images array (the composer's
 * dropped/pasted attachments) is validated before anything is queued: a bad image — wrong
 * extension, too many, undecodable, oversized — answers 400 naming the rule, with no queue
 * file and no image written. */
export async function handlePrompt(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"text": "..."}');
  if (!body) return;
  const fields = checkedPromptFields(res, body);
  if (!fields) return;
  submitPrompt(root, fields.text, fields.images, fields.notBeforeMs);
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

/** The defer field of a prompt endpoint's body, validated before anything touches the disk.
 * Three outcomes, deliberately distinct like checkedPromptImages: `undefined` — no defer
 * field, a prompt that runs as soon as its turn comes; a number — the epoch ms the prompt is
 * deliverable from (`Date.now() + ms`); `null` — the field was present but not a duration
 * this grammar accepts, or its duration is over the 90d cap, and the 400 naming the rule is
 * already sent, so stop. The grammar is cli-args.ts's parseDurationMs — the same one
 * `tumwater prompt --at` and `pause --for` accept — so a deferral spelled here computes the
 * same `tumwater:not-before` marker the CLI writes. */
function checkedPromptDefer(res: http.ServerResponse, body: Record<string, unknown>): number | undefined | null {
  if (body.defer === undefined) return undefined;
  const ms = typeof body.defer === "string" ? parseDurationMs(body.defer) : null;
  if (ms === null) {
    sendJson(res, 400, { error: "defer needs a duration like 45s, 90m, 1h30m, or 2d" });
    return null;
  }
  if (ms > PAUSE_FOR_MAX_MS) {
    sendJson(res, 400, { error: "defer is capped at 90d" });
    return null;
  }
  return Date.now() + ms;
}

/** The prompt endpoints' shared body tail: requirePromptText (400 on a null return) then
 * checkedPromptImages then checkedPromptDefer (400 on a null return from either), so
 * /api/prompt and /api/prompt-role read the same three fields in the same order and a body
 * wrong in several still answers the text problem first. Null means a 400 is already sent;
 * callers keep their own `if (!fields) return` bail. */
function checkedPromptFields(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  role: string = DIRECTOR_ROLE,
): { text: string; images: PromptImageInput[] | undefined; notBeforeMs: number | undefined } | null {
  const text = requirePromptText(res, body, role);
  if (text === null) return null;
  const images = checkedPromptImages(res, body);
  if (images === null) return null;
  const notBeforeMs = checkedPromptDefer(res, body);
  if (notBeforeMs === null) return null;
  return { text, images, notBeforeMs };
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
  sendJson(res, 200, { ok: true, message: submitRolePromptAndWake(root, role, fields.text, fields.images, fields.notBeforeMs) });
}

/** Handle POST /api/prompt-cancel: retract one queued prompt addressed by its queue file —
 * the dashboard's per-row cancel affordance, the file-addressed twin of the CLI's
 * position-addressed `prompt --cancel`. The role is optional (absent cancels from the
 * director's queue) and validates exactly like /api/transcript; a file name failing the
 * shared rejectBadQueueFileName guard is a user-input error answered 400 with
 * nothing touched on disk. A vanished file answers 200 { status: "gone" } — the loop already
 * dequeued the prompt, which is data for the flash line, not a server fault. Same body
 * discipline as /api/prompt (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "feature", "file": "<stamp>-<seq>-<pid>.md"}');
  if (!body) return;
  if (body.role !== undefined && rejectBadRole(root, res, body.role)) return;
  const role = body.role === undefined ? DIRECTOR_ROLE : (body.role as string);
  if (rejectBadQueueFileName(res, body.file)) return;
  const outcome = cancelQueuedFile(root, role, body.file as string);
  sendJson(
    res,
    200,
    outcome.status === "cancelled"
      ? { ok: true, status: "cancelled", preview: promptPreview(outcome.text) }
      : { ok: true, status: "gone" },
  );
}

/** Handle POST /api/prompt-edit: rewrite one queued prompt addressed by its queue file — the
 * dashboard's per-row edit affordance, the file-addressed twin of the CLI's position-addressed
 * `prompt --edit`. The role is optional (absent edits the director's queue) and validates
 * exactly like /api/prompt-cancel; a file name failing the shared rejectBadQueueFileName
 * guard is a user-input error answered 400 with nothing touched on disk. Text
 * and images validate through the same checkedPromptFields /api/prompt and /api/prompt-role
 * use; editQueuedFile throws for a bad name or an over-cap text — both user-input errors
 * answered 400 (a filesystem failure reads as 400 like handleConfigSet's failed write). A
 * vanished file answers 200 { ok: true, status: "gone" } — the loop already dequeued the
 * prompt, which is data for the flash line, not a server fault; an edit answers 200 with the
 * old and new operator-facing text the client flashes. Same body discipline as /api/prompt
 * (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptEdit(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "qa", "file": "<stamp>.md", "text": "..."}');
  if (!body) return;
  if (body.role !== undefined && rejectBadRole(root, res, body.role)) return;
  const role = body.role === undefined ? DIRECTOR_ROLE : (body.role as string);
  if (rejectBadQueueFileName(res, body.file)) return;
  const fields = checkedPromptFields(res, body, role);
  if (!fields) return;
  let outcome: EditOutcome;
  try {
    outcome = editQueuedFile(root, role, body.file as string, fields.text, fields.images);
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
  sendJson(
    res,
    200,
    outcome.status === "edited"
      ? { ok: true, status: "edited", oldText: outcome.oldText, newText: outcome.newText }
      : { ok: true, status: "gone" },
  );
}

/** Handle POST /api/question-answer: record the operator's answer to the Nth open question
 * exactly as `tumwater questions answer` does, through the non-exiting tryAnswerQuestion core.
 * The body carries the `title` the operator saw at `position`; a different title there, or no
 * such position, answers 200 { ok: true, status: "gone" } (the outbox moved on — data for the
 * flash line, like /api/prompt-cancel). The decision keeps its lines (`questions answer --file`'s
 * rule): a `## `/`### ` heading line or an unclosed fence in it answers 400 (bodyStructureProblem)
 * with nothing written. An unclosed fence in `## Open` answers 409; a blank
 * decision, a non-positive-integer position, or a missing title answers 400, and so does a
 * filesystem failure (handleConfigSet's precedent). */
export async function handleQuestionAnswer(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"position": 1, "title": "<heading>", "decision": "..."}');
  if (!body) return;
  const { position, title, decision } = body;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
    sendJson(res, 400, { error: "position must be a positive integer" });
    return;
  }
  if (typeof title !== "string" || title === "") {
    sendJson(res, 400, { error: "title must be a non-empty string" });
    return;
  }
  if (typeof decision !== "string" || decision.trim() === "") {
    sendJson(res, 400, { error: 'questions answer needs a decision: questions answer <n> "<decision>"' });
    return;
  }
  const keptDecision = normalizeEntryBody(decision);
  const problem = bodyStructureProblem(keptDecision);
  if (problem !== null) {
    sendJson(res, 400, { error: problem });
    return;
  }
  let outcome: AnswerOutcome;
  try {
    outcome = tryAnswerQuestion(root, position, keptDecision, title, true);
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
  if (outcome.status === "answered") {
    sendJson(res, 200, { ok: true, status: "answered", question: outcome.title, decision: outcome.decision });
  } else if (outcome.status === "fenced") {
    sendJson(res, 409, { ok: false, error: UNCLOSED_FENCE_MESSAGE });
  } else {
    sendJson(res, 200, { ok: true, status: "gone" });
  }
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
  const key = requireConfigKey(res, body);
  if (key === null) return;
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

/** Handle POST /api/config-unset: the Settings view's per-key Clear — one curated key removed,
 * through unsetConfigKey so the browser cannot drift from `tumwater config unset`'s rules
 * (unknown-key refusal, whole-candidate validateConfig, atomic write the running fleet picks
 * up live). The same EDITABLE_CONFIG_KEYS gate as /api/config-set, so the panel's reach stays
 * exactly the curated set; a key outside it is refused 400 with the key named. Same body
 * discipline (readPostBody → 400 malformed/non-object, 413 oversized). The 200 body omits
 * `oldValue` when the file never held the key (JSON.stringify drops an undefined), so the
 * client can tell a retraction from a no-op; a file value of `null` still serializes and is a
 * real retraction. */
export async function handleConfigUnset(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"key": "model"}');
  if (!body) return;
  const key = requireConfigKey(res, body);
  if (key === null) return;
  const result = unsetConfigKey(root, key);
  if (!result.ok) {
    sendJson(res, 400, { error: `${key}: ${result.error}` });
    return;
  }
  sendJson(res, 200, { ok: true, key, oldValue: result.oldValue });
}

/** The shared `forSeconds` rule of /api/pause and /api/pause-role: undefined when absent, the
 * deadline in epoch milliseconds when valid, null after sending the 400 (only with
 * `paused: true`, a positive finite number, within the CLI's 90-day cap). */
function pauseForSecondsMs(res: http.ServerResponse, body: Record<string, unknown>, pausing: boolean): number | undefined | null {
  const forSeconds = body.forSeconds;
  if (forSeconds === undefined) return undefined;
  if (!pausing) {
    sendJson(res, 400, { error: "forSeconds only applies when pausing (paused: true)" });
    return null;
  }
  if (typeof forSeconds !== "number" || !Number.isFinite(forSeconds) || forSeconds <= 0) {
    sendJson(res, 400, { error: `forSeconds must be a positive number of seconds${gotSuffix(forSeconds)}` });
    return null;
  }
  if (forSeconds * 1000 > PAUSE_FOR_MAX_MS) {
    sendJson(res, 400, { error: `forSeconds is capped at ${PAUSE_FOR_MAX_MS / 1000} seconds (90 days)${gotSuffix(forSeconds)} — pause without it for a standing pause` });
    return null;
  }
  return Date.now() + Math.round(forSeconds * 1000);
}

/** The optional `reason` of /api/pause: undefined when absent or blank, the raw string when
 * given with `paused: true` (pauseFleet folds and caps it), null after sending the 400. */
function pauseReasonField(res: http.ServerResponse, body: Record<string, unknown>, pausing: boolean): string | undefined | null {
  const reason = body.reason;
  if (reason === undefined) return undefined;
  if (!pausing) {
    sendJson(res, 400, { error: "reason only applies when pausing (paused: true)" });
    return null;
  }
  if (typeof reason !== "string") {
    sendJson(res, 400, { error: `reason must be a string${gotSuffix(reason)}` });
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
function wakeInSecondsMs(res: http.ServerResponse, body: Record<string, unknown>): number | undefined | null {
  const inSeconds = body.inSeconds;
  if (inSeconds === undefined) return undefined;
  if (typeof inSeconds !== "number" || !Number.isFinite(inSeconds) || inSeconds <= 0) {
    sendJson(res, 400, { error: `inSeconds must be a positive number of seconds${gotSuffix(inSeconds)}` });
    return null;
  }
  if (inSeconds * 1000 > PAUSE_FOR_MAX_MS) {
    sendJson(res, 400, { error: `inSeconds is capped at ${PAUSE_FOR_MAX_MS / 1000} seconds (90 days)${gotSuffix(inSeconds)}` });
    return null;
  }
  return Math.round(inSeconds * 1000);
}

/** Handle POST /api/wake: the dashboard's per-row wake control — the same marker-writing
 * core `tumwater wake` calls (requestWake), so the CLI and the GUI cannot drift on the
 * state-file edits or the marker. `{}`/a missing role targets every configured role (the
 * CLI's all-roles default); a given role validates exactly like /api/transcript. Same body
 * discipline as /api/pause (readJsonObject → 400 malformed/non-object, 413 oversized). An
 * optional `inSeconds` schedules the wake for later, like `tumwater wake --in` (same 90-day cap). */
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

/** Handle POST /api/reset-counters: the dashboard's counter reset — the same marker-writing
 * core `tumwater reset-counters` calls (requestResetCounters). Same body discipline and
 * `{}` → every configured role default as /api/wake. */
export async function handleResetCounters(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature"}', root, true);
  if (!body) return;
  sendJson(res, 200, {
    ok: true,
    message: requestResetCounters(root, body.role === undefined ? validRoleIds(root) : [body.role as string]),
  });
}

/** Handle POST /api/backlog-file: the Plans/Bugs tabs' New control — the same entry and wake
 * `tumwater bug`/`tumwater plan` produce (fileEntryWithBody, then the shared wake text to the
 * bugfix/feature loop). Body `{"kind": "bug"|"plan", "title": "...", "body": "optional markdown"}`. The empty-title and
 * wake-length checks run here, before anything is written: the body is normalized and checked by bodyStructureProblem too, and an over-long wake would throw after the entry landed. */
export async function handleBacklogFile(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "plan", "title": "...", "body": "optional markdown"}');
  if (!body) return;
  const kind = body.kind;
  if (kind !== "bug" && kind !== "plan") {
    sendJson(res, 400, { error: 'kind must be "bug" or "plan"' });
    return;
  }
  const rawTitle = typeof body.title === "string" ? body.title : "";
  if (collapseWhitespace(rawTitle) === "") {
    sendJson(res, 400, { error: "title required" });
    return;
  }
  const { role, wakeText } = OPERATOR_FILE_KINDS[kind];
  const problem = promptLengthProblem(wakeText(collapseWhitespace(rawTitle)), role);
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }
  const rawBody = body.body;
  if (rawBody !== undefined && typeof rawBody !== "string") {
    sendJson(res, 400, { error: "body must be a string" });
    return;
  }
  const entryBody = normalizeEntryBody(rawBody ?? "");
  const bodyProblem = bodyStructureProblem(entryBody);
  if (bodyProblem) {
    sendJson(res, 400, { error: bodyProblem });
    return;
  }
  const filed = fileEntryWithBody(root, kind, rawTitle, entryBody);
  submitRolePromptAndWake(root, role, wakeText(filed.title));
  sendJson(res, 200, { ok: true, file: filed.file, title: filed.title });
}

/** Handle POST /api/backlog-cancel: the entry drawer's cancel — the same lock and splice as
 * `tumwater plan|bug --cancel <n>` through the non-exiting tryCancelEntry. Body `{"kind":
 * "bug"|"plan", "position": <1-based>, "title": "<heading>"}`; a missing position or a
 * different heading there answers 200 { ok: true, status: "gone" } (the list moved since the
 * poll). No wake and no inbox prompt: removing work must not wake a loop. */
export async function handleBacklogCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "bug", "position": 1, "title": "<heading>"}');
  if (!body) return;
  const { kind, position, title } = body;
  if (kind !== "bug" && kind !== "plan") {
    sendJson(res, 400, { error: 'kind must be "bug" or "plan"' });
    return;
  }
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
    sendJson(res, 400, { error: "position must be a positive integer" });
    return;
  }
  if (typeof title !== "string" || title === "") {
    sendJson(res, 400, { error: "title must be a non-empty string" });
    return;
  }
  let outcome: CancelEntryOutcome;
  try {
    outcome = tryCancelEntry(root, kind, position, title);
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
  if (outcome.status === "cancelled") {
    sendJson(res, 200, { ok: true, status: "cancelled", file: outcome.file, title: outcome.title });
  } else {
    sendJson(res, 200, { ok: true, status: "gone" });
  }
}

/** Handle POST /api/backlog-edit: the entry drawer's edit — tryEditEntry's title-checked,
 * in-place rewrite under the state lock. Body `{"kind", "position", "title", "newTitle",
 * "newBody"}`; a missing position or a different heading there answers 200 { ok: true, status:
 * "gone" }. The body keeps its line structure. No wake and no inbox prompt: whichever tick picks
 * the entry up refines it. */
export async function handleBacklogEdit(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "bug", "position": 1, "title": "<heading>", "newTitle": "...", "newBody": "..."}');
  if (!body) return;
  const { kind, position, title, newTitle, newBody } = body;
  if (kind !== "bug" && kind !== "plan") {
    sendJson(res, 400, { error: 'kind must be "bug" or "plan"' });
    return;
  }
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
    sendJson(res, 400, { error: "position must be a positive integer" });
    return;
  }
  if (typeof title !== "string" || title === "") {
    sendJson(res, 400, { error: "title must be a non-empty string" });
    return;
  }
  if (typeof newTitle !== "string" || collapseWhitespace(newTitle) === "") {
    sendJson(res, 400, { error: "newTitle required" });
    return;
  }
  if (typeof newBody !== "string") {
    sendJson(res, 400, { error: "newBody must be a string" });
    return;
  }
  const problem = bodyStructureProblem(newBody.replace(/\r\n?/g, "\n"));
  if (problem !== null) {
    sendJson(res, 400, { error: problem });
    return;
  }
  let outcome: EditEntryOutcome;
  try {
    outcome = tryEditEntry(root, kind, position, title, newTitle, newBody);
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
  if (outcome.status === "edited") {
    sendJson(res, 200, { ok: true, status: "edited", file: outcome.file, title: outcome.title });
  } else {
    sendJson(res, 200, { ok: true, status: "gone" });
  }
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

/** Handle POST /api/reclaim: the dashboard disk row's reclaim button — the same manual pass
 * `tumwater reclaim` runs (runManualReclaim), answering its confirmation verbatim. Same body
 * discipline as /api/restart (the body is ignored); a throw reaches the server's outer 500. */
export async function handleReclaim(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  sendJson(res, 200, { ok: true, message: await runManualReclaim(root) });
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
  const untilMs = pauseForSecondsMs(res, body, value);
  if (untilMs === null) return;
  const changed = value
    ? pauseRole(root, body.role as string, untilMs)
    : resumeRole(root, body.role as string);
  sendJson(res, 200, { ok: true, changed, paused: value, ...(untilMs === undefined ? {} : { until: untilMs }) });
}

/** Handle POST /api/role-notes: the loop drawer's notebook Edit/Clear — the same saveRoleNote
 * `tumwater role <id> --notes-file` / `--clear-notes` call, so the 4 KB cap and its wording
 * cannot drift. `"text": ""` clears. The director has no notebook (400, the CLI's wording); a
 * non-string text is a 400 before anything is written; an over-cap note is a 400 carrying
 * saveRoleNote's byte-count message. */
export async function handleRoleNotes(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature", "text": "…"}', root);
  if (!body) return;
  const role = body.role as string;
  if (role === DIRECTOR_ROLE) return sendJson(res, 400, { error: "the director has no notebook" });
  if (typeof body.text !== "string") return sendJson(res, 400, { error: `"text" must be a string — the full replacement note, or "" to clear it${gotSuffix(body.text)}` });
  try {
    sendJson(res, 200, { ok: true, message: saveRoleNote(roleNotesPath(root, role), body.text) });
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
  }
}
