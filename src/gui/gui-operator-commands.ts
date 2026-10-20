// vocabulary: plain
/**
 * The dashboard's POST operator-lifecycle command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts): reset-counters,
 * restart, reclaim, abort, stop-schedule, role-notes, retire, revert, and brief-edit — every POST
 * handler that is not prompt/backlog/config/team. Each handler adapts HTTP onto the domain work
 * one layer down (operator-intent, role-notes-write, brief-edit) and touches no socket beyond
 * its own `res`.
 */
import { cancelScheduledStopMessage, requestAbort, requestResetCounters, requestRestart, requestScheduledStop, runManualReclaim } from "../operator/operator-intent.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { artifactPhrase, retireRole } from "../operator/retire.js";
import { previewRevert, revertMergedCommit } from "../operator/revert.js";
import { shortSha } from "../text/format.js";
import { editInitialPrompt } from "../brief/brief-edit.js";
import { requireStringField, validRoleIds } from "./gui-args.js";
import { badRequest, sendJson } from "./http-body.js";
import { errorMessage, gotSuffix } from "../text/text.js";
import { readPostBody, readRoleBody, sendRequestResult } from "./gui-endpoint-common.js";
import { wakeInSecondsMs } from "./gui-team-commands.js";
import type http from "node:http";

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

/** Handle POST /api/stop-schedule: the dashboard's "Stop the team later" control — the same
 * cores `tumwater stop --in`/`--cancel` call (requestScheduledStop, cancelScheduledStopMessage).
 * `{"cancel": true}` drops the marker (no live team needed, like the CLI); otherwise
 * `inSeconds` is required and takes /api/wake's positive-finite-and-capped rule. A stopped
 * team answers 409 with the not-running error. */
export async function handleStopSchedule(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"inSeconds": 7200}');
  if (!body) return;
  if (body.cancel === true) {
    if (body.inSeconds !== undefined) {
      badRequest(res, "cancel and inSeconds cannot be combined");
      return;
    }
    sendJson(res, 200, { ok: true, message: cancelScheduledStopMessage(root) });
    return;
  }
  const inMs = wakeInSecondsMs(res, body);
  if (inMs === null) return;
  if (inMs === undefined) {
    badRequest(res, "inSeconds or cancel is required");
    return;
  }
  sendRequestResult(res, requestScheduledStop(root, inMs));
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

/** Handle POST /api/role-notes: the role drawer's notebook Edit/Clear — the same saveRoleNote
 * `tumwater role <id> --notes-file` / `--clear-notes` call, so the 4 KB cap and its wording
 * cannot drift. `"text": ""` clears. The director has no notes (400, the CLI's wording); a
 * non-string text is a 400 before anything is written; an over-cap note is a 400 carrying
 * saveRoleNote's byte-count message. */
export async function handleRoleNotes(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "feature", "text": "…"}', root);
  if (!body) return;
  const role = body.role as string;
  if (role === DIRECTOR_ROLE) return badRequest(res, "the director has no notes");
  const text = requireStringField(res, body, "text", `the full replacement note, or "" to clear it`);
  if (text === null) return;
  try {
    sendJson(res, 200, { ok: true, message: saveRoleNote(roleNotesPath(root, role), text) });
  } catch (err) {
    badRequest(res, errorMessage(err));
  }
}
/** Handle POST /api/retire: the Settings view's Retire button — the same retireRole core
 * `tumwater retire --role <id>` calls, never forced (a `force` key is a 400 naming the CLI
 * override). A rail's refusal or an unreadable tumwater.json is a 409 carrying the core's
 * message and removes nothing; success answers what was removed in the CLI's wording. */
export async function handleRetire(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readRoleBody(req, res, '{"role": "improve"}', root);
  if (!body) return;
  const role = body.role as string;
  if (body.force !== undefined) return badRequest(res, "the dashboard never forces a retire — run `tumwater retire --role <id> --force` from the CLI");
  try {
    const { removed, skipped } = await retireRole(root, role, {});
    const message = removed.length === 0 ? `nothing to remove for role ${role}` : removed.map((a) => `removed ${artifactPhrase(a, role)}`).join("; ");
    sendJson(res, 200, { ok: true, removed, skipped, message });
  } catch (err) {
    sendJson(res, 409, { error: errorMessage(err) });
  }
}
/** Handle POST /api/revert: the History drill-down's "Revert this change" button — the same
 * cores `tumwater revert <sha> [--dry-run]` calls. A `sha` that is not 4-64 hex digits (so never
 * a flag or a ref name) or a non-boolean `dryRun` is a 400 and runs nothing. `dryRun: true`
 * answers `{ ok, preview }` (previewRevert, writing nothing); otherwise the revert commits and
 * answers `{ ok, headSha, beforeSha, message }`. A core's refusal is a 409 with its wording. */
export async function handleRevert(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"sha": "1a2b3c4"}');
  if (!body) return;
  if (typeof body.sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(body.sha))
    return badRequest(res, `"sha" must be a hex commit id of 4-64 digits${gotSuffix(body.sha)}`);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    return badRequest(res, `"dryRun" must be true or false${gotSuffix(body.dryRun)}`);
  if (body.dryRun === true) {
    const preview = await previewRevert(root, body.sha);
    if (!preview.ok) return sendJson(res, 409, { error: preview.error });
    return sendJson(res, 200, { ok: true, preview });
  }
  const result = await revertMergedCommit(root, body.sha);
  if (!result.ok) return sendJson(res, 409, { error: result.error });
  sendJson(res, 200, {
    ok: true,
    headSha: result.headSha,
    beforeSha: result.beforeSha,
    message: `main is now ${shortSha(result.headSha)} — the reverted role may redo the work, so cancel or edit its PLANS.md/BUGS.md entry if it should not`,
  });
}
/** Handle POST /api/brief: replace the initial prompt through editInitialPrompt — the same
 * checks, locked write, and commit as `tumwater brief --file`. A non-string prompt or any
 * refusal is a 400 and writes nothing. */
export async function handleBriefEdit(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"prompt": "…"}');
  if (!body) return;
  const prompt = requireStringField(res, body, "prompt", "the full replacement brief");
  if (prompt === null) return;
  const outcome = await editInitialPrompt(root, prompt);
  if (!outcome.ok) return badRequest(res, outcome.error);
  sendJson(res, 200, { file: outcome.file, changed: outcome.changed, committed: outcome.committed });
}
