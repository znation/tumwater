/**
 * The request-body helpers shared by the dashboard's per-domain POST command modules
 * (gui-prompt-commands, gui-backlog-commands, gui-config-commands, gui-team-commands,
 * gui-operator-commands, and gui-quarantine-commands, all barrelled into
 * gui/gui-endpoint-commands.ts): readPostBody /
 * readRoleBody — the body-discipline-and-role-check pair each mutating handler guards its
 * inputs with — and sendRequestResult, the shared boolean-claiming marker reply. The
 * per-domain `checked*` validators live with their domain's module, not here.
 */
import { rejectBadRole } from "./gui-args.js";
import { readJsonObject, sendJson } from "./http-body.js";
import type { RequestResult } from "../operator/operator-intent.js";
import type http from "node:http";

/** Every POST handler's shared opening: readJsonObject reads the body and — when it is
 * oversized, malformed, or not a JSON object — has already written the 413/400 itself. Its
 * null return therefore means the response is sent and the handler must stop without touching
 * it again; each handler used to restate that contract in its own inline comment, and this is
 * the one home for it. Handlers keep their own `if (!body) return` bail so the stop stays
 * visible in their flow. */
export async function readPostBody(
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
 * eight call sites — handlePromptRole, handleWake, handleWakeCancel and handleResetCounters
 * (allowMissing, the {} → all-roles default), handleAbort, handlePauseRole,
 * handleRoleNotes, and handleRetire; handlePromptCancel deliberately does not ride it, since
 * its role is optional and validates only when present. */
export async function readRoleBody(
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

/** Reply for a boolean-claiming marker request (RequestResult): success maps to 200 with its
 * message, refusal to 409 — the request is valid but nothing can act on it, the same conflict
 * reading requestAbort's not-live error uses. /api/restart and /api/abort share it. */
export function sendRequestResult(res: http.ServerResponse, result: RequestResult): void {
  if (!result.ok) {
    sendJson(res, 409, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, message: result.message });
}
