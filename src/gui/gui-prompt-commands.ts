/**
 * The dashboard's POST prompt-queueing command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts): prompt,
 * prompt-role, prompt-cancel, prompt-edit, and prompt-top — the `checkedPromptImages` /
 * `checkedPromptDefer` / `checkedPromptFields` validators they share ride with them. Each
 * handler adapts HTTP onto the domain work one layer down (inbox-submit, inbox-cancel,
 * inbox-edit, inbox-top, operator-intent) and touches no socket beyond its own `res`.
 */
import { submitPrompt } from "../inbox/inbox-submit.js";
import { imagePromptGuidance } from "../inbox/inbox-submit.js";
import { promptImagesProblem, type PromptImageInput } from "../inbox/inbox-attachments.js";
import { promptPreview } from "../inbox/inbox.js";
import { cancelQueuedFile } from "../inbox/inbox-cancel.js";
import { editQueuedFile, type EditOutcome } from "../inbox/inbox-edit.js";
import { topQueuedFile, type FileTopOutcome } from "../inbox/inbox-top.js";
import { parseDurationMs } from "../cli/cli-args.js";
import { PAUSE_FOR_MAX_MS, submitRolePromptAndWake } from "../operator/operator-intent.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { rejectBadQueueFileName, rejectBadRole, requirePromptText } from "./gui-args.js";
import { badRequest, OK_GONE, sendJson } from "./gui-http-body.js";
import { errorMessage, gotSuffix, joinParts } from "../text/text.js";
import { readPostBody, readRoleBody } from "./gui-endpoint-common.js";
import type http from "node:http";

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
    badRequest(res, problem);
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
    badRequest(res, `defer needs a duration like 45s, 90m, 1h30m, or 2d${gotSuffix(body.defer)}`);
    return null;
  }
  if (ms > PAUSE_FOR_MAX_MS) {
    badRequest(res, `defer is capped at 90d${gotSuffix(body.defer)}`);
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

/** Handle POST /api/prompt-role: queue a prompt for one role — the dashboard's per-row
 * prompt affordance submits here, calling the same path `tumwater prompt --role <id>` uses
 * (submitRolePrompt enqueues into that role's own queue and logs under it, then a single-role
 * wake brings the live role in within one poll; the wake message rides back for the flash).
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
  // Image-input submit gate (plans/image-input.md "Attachments", part 5/5): an attachment the
  // target role cannot read (and that no tier reroutes) answers 400 naming the fix before
  // anything is queued — the same gate submitRolePrompt enforces, surfaced as a user-input
  // error rather than the server's 500. A role that reroutes a blind read is not refused; its
  // notice rides in the confirmation the composer flashes.
  let notice = "";
  if (fields.images && fields.images.length > 0) {
    const guidance = imagePromptGuidance(root, role);
    if (guidance.refusal) {
      badRequest(res, guidance.refusal);
      return;
    }
    notice = guidance.notice ?? "";
  }
  const message = joinParts(
    [
      submitRolePromptAndWake(root, role, fields.text, fields.images, fields.notBeforeMs),
      notice,
    ],
    "\n",
  );
  sendJson(res, 200, { ok: true, message });
}

/** The file-addressed prompt handlers' shared role prologue: validate the optional role
 * (400 sent on a present-but-invalid one and null returned, so the caller stops) and default
 * an absent role to the director's queue. The same optional-role rule handlePromptCancel,
 * handlePromptEdit and handlePromptTop state once instead of a guard-plus-default pair. */
function promptFileRole(body: Record<string, unknown>, res: http.ServerResponse, root: string): string | null {
  if (body.role !== undefined && rejectBadRole(root, res, body.role)) return null;
  return body.role === undefined ? DIRECTOR_ROLE : (body.role as string);
}

/** Handle POST /api/prompt-cancel: retract one queued prompt addressed by its queue file —
 * the dashboard's per-row cancel affordance, the file-addressed twin of the CLI's
 * position-addressed `prompt --cancel`. The role is optional (absent cancels from the
 * director's queue) and validates exactly like /api/transcript; a file name failing the
 * shared rejectBadQueueFileName guard is a user-input error answered 400 with
 * nothing touched on disk. A vanished file answers 200 { status: "gone" } — the role already
 * dequeued the prompt, which is data for the flash line, not a server fault. Same body
 * discipline as /api/prompt (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "feature", "file": "<stamp>-<seq>-<pid>.md"}');
  if (!body) return;
  const role = promptFileRole(body, res, root);
  if (role === null) return;
  if (rejectBadQueueFileName(res, body.file)) return;
  const outcome = cancelQueuedFile(root, role, body.file as string);
  sendJson(
    res,
    200,
    outcome.status === "cancelled"
      ? { ok: true, status: "cancelled", preview: promptPreview(outcome.text) }
      : OK_GONE,
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
 * vanished file answers 200 { ok: true, status: "gone" } — the role already dequeued the
 * prompt, which is data for the flash line, not a server error; an edit answers 200 with the
 * old and new operator-facing text the client flashes. Same body discipline as /api/prompt
 * (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptEdit(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "qa", "file": "<stamp>.md", "text": "..."}');
  if (!body) return;
  const role = promptFileRole(body, res, root);
  if (role === null) return;
  if (rejectBadQueueFileName(res, body.file)) return;
  const fields = checkedPromptFields(res, body, role);
  if (!fields) return;
  // Image-input gate (plans/image-input.md "Attachments", part 5/5), the edit twin of
  // handlePromptRole's: an image edited into the queued prompt answers 400 naming the fix
  // when the target role cannot read it (and no tier reroutes it) — the same gate
  // submitRolePrompt enforces — before anything is written.
  if (fields.images && fields.images.length > 0) {
    const guidance = imagePromptGuidance(root, role);
    if (guidance.refusal) {
      badRequest(res, guidance.refusal);
      return;
    }
  }
  let outcome: EditOutcome;
  try {
    outcome = editQueuedFile(root, role, body.file as string, fields.text, fields.images);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  sendJson(
    res,
    200,
    outcome.status === "edited"
      ? { ok: true, status: "edited", oldText: outcome.oldText, newText: outcome.newText }
      : OK_GONE,
  );
}

/** Handle POST /api/prompt-top: move one queued prompt to the head of its role's queue,
 * addressed by its queue file — the dashboard's per-row Move to top affordance, the
 * file-addressed twin of the CLI's position-addressed `prompt --top`. The role is optional
 * (absent moves in the director's queue) and validates exactly like /api/prompt-cancel; a
 * file name failing the shared rejectBadQueueFileName guard is a user-input error answered
 * 400 with nothing touched on disk. A vanished file answers 200 { status: "gone" } and the
 * queue head answers 200 { status: "already_first" } — both data for the flash line, not
 * server faults, so a stale poll can never reorder the wrong prompt. Same body discipline
 * as /api/prompt (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptTop(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "qa", "file": "<stamp>.md"}');
  if (!body) return;
  const role = promptFileRole(body, res, root);
  if (role === null) return;
  if (rejectBadQueueFileName(res, body.file)) return;
  let outcome: FileTopOutcome;
  try {
    outcome = topQueuedFile(root, role, body.file as string);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  sendJson(
    res,
    200,
    outcome.status === "topped"
      ? { ok: true, status: "topped", preview: outcome.preview }
      : outcome.status === "already_first"
        ? { ok: true, status: "already_first" }
        : OK_GONE,
  );
}
