// vocabulary: plain
/**
 * The dashboard's POST backlog/QUESTIONS command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts):
 * question-answer, backlog-file, backlog-cancel, backlog-release, backlog-top, and
 * backlog-edit — the `checkedBacklogKind` / `checkedEntryPositionAndTitle` validators they share
 * ride with them. Each handler adapts
 * HTTP onto the domain work one layer down (backlog-write, question-answer, backlog-commit)
 * and touches no socket beyond its own `res`.
 */
import { commitOperatorBacklogEdit } from "../backlog/backlog-commit.js";
import { stampedSubject } from "../git/commit-message.js";
import { fileEntryWithBody, normalizeEntryBody, OPERATOR_FILE_KINDS, tryCancelEntry, tryEditEntry, tryMoveEntryToTop, tryReleaseEntry, bodyStructureProblem, type CancelEntryOutcome, type EditEntryOutcome, type MoveEntryOutcome, type ReleaseEntryOutcome } from "../backlog/backlog-write.js";
import { tryAnswerQuestion, UNCLOSED_FENCE_MESSAGE, type AnswerOutcome } from "../backlog/question-answer.js";
import { promptLengthProblem } from "../inbox/inbox-submit.js";
import { requestWake, submitRolePromptAndWake, wakeQuestionAsker } from "../operator/operator-intent.js";
import { badRequest, okGone, sendJson } from "./http-body.js";
import { collapseWhitespace, errorMessage, gotSuffix } from "../text/text.js";
import { readPostBody } from "./gui-endpoint-common.js";
import type http from "node:http";

/** Shared 400-validation for an entry-target body's `kind` — "bug" or "plan" — the one field
 * the backlog file/cancel/edit endpoints all ask for in the same words. Sends the 400 and
 * returns null when invalid, else the validated kind. */
function checkedBacklogKind(res: http.ServerResponse, body: Record<string, unknown>): "bug" | "plan" | null {
  const kind = body.kind;
  if (kind !== "bug" && kind !== "plan") {
    badRequest(res, `kind must be "bug" or "plan"${kind === undefined ? "" : gotSuffix(kind)}`);
    return null;
  }
  return kind;
}

/** Shared 400-validation for an entry-target body's `position` (a positive integer) and
 * `title` (a non-empty string) — the two fields every backlog/QUESTIONS entry drawer asks
 * for, so the question-answer, backlog-cancel, backlog-release, backlog-top, and
 * backlog-edit endpoints report the same two errors and cannot drift on the messages. Sends the
 * 400 and returns null on the first bad field; the validated pair otherwise. */
function checkedEntryPositionAndTitle(
  res: http.ServerResponse,
  body: Record<string, unknown>,
): { position: number; title: string } | null {
  const { position, title } = body;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
    badRequest(res, `position must be a positive integer${position === undefined ? "" : gotSuffix(position)}`);
    return null;
  }
  if (typeof title !== "string" || title === "") {
    badRequest(res, `title must be a non-empty string${title === undefined ? "" : gotSuffix(title)}`);
    return null;
  }
  return { position, title };
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
  const { decision } = body;
  const pair = checkedEntryPositionAndTitle(res, body);
  if (!pair) return;
  const { position, title } = pair;
  if (typeof decision !== "string" || decision.trim() === "") {
    badRequest(res, 'questions answer needs a decision: questions answer <n> "<decision>"');
    return;
  }
  const keptDecision = normalizeEntryBody(decision);
  const problem = bodyStructureProblem(keptDecision);
  if (problem !== null) {
    badRequest(res, problem);
    return;
  }
  let outcome: AnswerOutcome;
  try {
    outcome = tryAnswerQuestion(root, position, keptDecision, title, true);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  if (outcome.status === "answered") {
    const committed = await commitOperatorBacklogEdit(root, "QUESTIONS.md", stampedSubject("operator", `Answer question: ${outcome.title}`)); // vocabulary-ok: the commit prefix stays tumwater(operator):
    const wake = wakeQuestionAsker(root, outcome.title);
    sendJson(res, 200, { ok: true, status: "answered", question: outcome.title, decision: outcome.decision, committed, ...(wake === null ? {} : { wake }) });
  } else if (outcome.status === "fenced") {
    sendJson(res, 409, { ok: false, error: UNCLOSED_FENCE_MESSAGE });
  } else {
    okGone(res);
  }
}

/** Handle POST /api/backlog-file: the Plans/Bugs tabs' New control — the same entry and wake
 * `tumwater bug`/`tumwater plan` produce (fileEntryWithBody, then the shared wake text to the
 * bugfix/feature loop). Body `{"kind": "bug"|"plan", "title": "...", "body": "optional
 * markdown"}`. The empty-title and wake-length checks run here, before anything is written:
 * the body is normalized and checked by bodyStructureProblem too, and an over-long wake
 * would throw after the entry landed. */
export async function handleBacklogFile(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "plan", "title": "...", "body": "optional markdown"}');
  if (!body) return;
  const kind = checkedBacklogKind(res, body);
  if (!kind) return;
  const rawTitle = typeof body.title === "string" ? body.title : "";
  if (collapseWhitespace(rawTitle) === "") {
    badRequest(res, "title required");
    return;
  }
  const { role, wakeText } = OPERATOR_FILE_KINDS[kind];
  const problem = promptLengthProblem(wakeText(collapseWhitespace(rawTitle)), role);
  if (problem) {
    badRequest(res, problem);
    return;
  }
  const rawBody = body.body;
  if (rawBody !== undefined && typeof rawBody !== "string") {
    badRequest(res, "body must be a string");
    return;
  }
  const entryBody = normalizeEntryBody(rawBody ?? "");
  const bodyProblem = bodyStructureProblem(entryBody);
  if (bodyProblem) {
    badRequest(res, bodyProblem);
    return;
  }
  const filed = fileEntryWithBody(root, kind, rawTitle, entryBody);
  const committed = await commitOperatorBacklogEdit(root, filed.file, stampedSubject("operator", `File ${kind}: ${filed.title}`)); // vocabulary-ok: the commit prefix stays tumwater(operator):
  submitRolePromptAndWake(root, role, wakeText(filed.title));
  sendJson(res, 200, { ok: true, file: filed.file, title: filed.title, committed });
}

/** Handle POST /api/backlog-cancel: the entry drawer's cancel — the same lock and splice as
 * `tumwater plan|bug --cancel <n>` through the non-exiting tryCancelEntry. Body `{"kind":
 * "bug"|"plan", "position": <1-based>, "title": "<heading>"}`; a missing position or a
 * different heading there answers 200 { ok: true, status: "gone" } (the list moved since the
 * poll). No wake and no inbox prompt: removing work must not wake a loop. */
export async function handleBacklogCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "bug", "position": 1, "title": "<heading>"}');
  if (!body) return;
  const kind = checkedBacklogKind(res, body);
  if (!kind) return;
  const pair = checkedEntryPositionAndTitle(res, body);
  if (!pair) return;
  const { position, title } = pair;
  let outcome: CancelEntryOutcome;
  try {
    outcome = tryCancelEntry(root, kind, position, title);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  if (outcome.status === "cancelled") {
    const committed = await commitOperatorBacklogEdit(root, outcome.file, stampedSubject("operator", `Cancel ${kind}: ${outcome.title}`)); // vocabulary-ok: the commit prefix stays tumwater(operator):
    sendJson(res, 200, { ok: true, status: "cancelled", file: outcome.file, title: outcome.title, committed });
  } else {
    okGone(res);
  }
}

/** Handle POST /api/backlog-release: the entry drawer's release — the same lock and splice as
 * `tumwater plan|bug --release <n>` through the non-exiting tryReleaseEntry. Body as
 * backlog-cancel's. A released entry is newly eligible, so the kind's role is woken; `gone`
 * and `moved` answer okGone, and an entry with neither a Refused nor a Waiting-for-the-next-
 * failure note answers status "not_refused" with no write and no wake. */
export async function handleBacklogRelease(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "bug", "position": 1, "title": "<heading>"}');
  if (!body) return;
  const kind = checkedBacklogKind(res, body);
  if (!kind) return;
  const pair = checkedEntryPositionAndTitle(res, body);
  if (!pair) return;
  const { position, title } = pair;
  let outcome: ReleaseEntryOutcome;
  try {
    outcome = tryReleaseEntry(root, kind, position, title);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  if (outcome.status === "released") {
    const committed = await commitOperatorBacklogEdit(root, outcome.file, stampedSubject("operator", `Release ${kind}: ${outcome.title}`)); // vocabulary-ok: the commit prefix stays tumwater(operator):
    requestWake(root, [OPERATOR_FILE_KINDS[kind].role]);
    sendJson(res, 200, { ok: true, status: "released", file: outcome.file, title: outcome.title, committed });
  } else if (outcome.status === "not_refused") {
    sendJson(res, 200, { ok: true, status: "not_refused", title: outcome.title });
  } else {
    okGone(res);
  }
}

/** Handle POST /api/backlog-top: the entry drawer's Move to top — the same splice as
 * `tumwater plan|bug --top <n>` through the non-exiting tryMoveEntryToTop. Body as
 * backlog-cancel's. Reordering makes no entry newly eligible, so no role is woken; position 1
 * answers status "already_first" with no write, and `gone` and `moved` answer okGone. */
export async function handleBacklogTop(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"kind": "bug", "position": 2, "title": "<heading>"}');
  if (!body) return;
  const kind = checkedBacklogKind(res, body);
  if (!kind) return;
  const pair = checkedEntryPositionAndTitle(res, body);
  if (!pair) return;
  const { position, title } = pair;
  let outcome: MoveEntryOutcome;
  try {
    outcome = tryMoveEntryToTop(root, kind, position, title);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  if (outcome.status === "moved_to_top") {
    const committed = await commitOperatorBacklogEdit(root, outcome.file, stampedSubject("operator", `Prioritize ${kind}: ${outcome.title}`)); // vocabulary-ok: the commit prefix stays tumwater(operator):
    sendJson(res, 200, { ok: true, status: "moved_to_top", file: outcome.file, title: outcome.title, committed });
  } else if (outcome.status === "already_first") {
    sendJson(res, 200, { ok: true, status: "already_first", title: outcome.title });
  } else {
    okGone(res);
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
  const kind = checkedBacklogKind(res, body);
  if (!kind) return;
  const pair = checkedEntryPositionAndTitle(res, body);
  if (!pair) return;
  const { position, title } = pair;
  const { newTitle, newBody } = body;
  if (typeof newTitle !== "string" || collapseWhitespace(newTitle) === "") {
    badRequest(res, "newTitle required");
    return;
  }
  if (typeof newBody !== "string") {
    badRequest(res, "newBody must be a string");
    return;
  }
  const problem = bodyStructureProblem(newBody.replace(/\r\n?/g, "\n"));
  if (problem !== null) {
    badRequest(res, problem);
    return;
  }
  let outcome: EditEntryOutcome;
  try {
    outcome = tryEditEntry(root, kind, position, title, newTitle, newBody);
  } catch (err) {
    badRequest(res, errorMessage(err));
    return;
  }
  if (outcome.status === "edited") {
    const committed = await commitOperatorBacklogEdit(root, outcome.file, stampedSubject("operator", `Edit ${kind}: ${outcome.title}`)); // vocabulary-ok: the commit prefix stays tumwater(operator):
    sendJson(res, 200, { ok: true, status: "edited", file: outcome.file, title: outcome.title, committed });
  } else {
    okGone(res);
  }
}
