/**
 * The dashboard's POST operator-lifecycle command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts): reset-counters,
 * restart, reclaim, abort, stop-schedule, role-notes, retire, revert, brief-edit, queue-cancel,
 * queue-top, post-review-accept, commit-backlog, and archive-backlog — every POST handler
 * that is not prompt/backlog/config/team. Each handler
 * adapts HTTP onto the domain work
 * one layer down (operator-intent, role-notes-write, brief-edit) and touches no socket beyond
 * its own `res`.
 */
import { resyncRootInstall, rootInstallResyncLines, type RootInstallResync } from "../build/dep-install.js";
import { cancelScheduledStopMessage, requestAbort, requestAbortAll, requestResetCounters, requestRestart, requestScheduledStop, runManualReclaim } from "../operator/operator-intent.js";
import { runDoctor } from "../doctor/doctor.js";
import type { DoctorReport } from "../doctor/doctor-checks.js";
import { killOrphans, orphanKillLines, type OrphanKillReport } from "../doctor/doctor-orphans.js";
import { dropBrokenPins, brokenPinDropLines, type BrokenPinDrop, retireLeftovers, leftoverRetireLines, type LeftoverRetireReport } from "../doctor/doctor-contention-checks.js";
import { commitUncommittedBacklog, backlogCommitMessage, type BacklogCommitReport } from "../doctor/doctor-backlog.js";
import { archiveFinishedOnMain, describeArchivedFile, type ArchiveOnMainOutcome } from "../backlog/backlog-archive.js";
import { loadConfigSafe } from "../config/config.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath, MERGE_LOCK_WAIT_MS } from "../paths.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { artifactPhrase, retireRole } from "../operator/retire.js";
import { previewRevert, revertFollowUp, revertMergedCommit } from "../operator/revert.js";
import { cancelQueuedMergeBySha, type CancelQueuedByShaOutcome } from "../merge/merge-cancel.js";
import { acceptPostReviewBySha, type AcceptPostReviewByShaOutcome } from "../review/post-merge-review-accept.js";
import { moveQueuedMergeToTopBySha, type TopQueuedByShaOutcome } from "../merge/merge-top.js";
import { readMergeQueue } from "../merge/merge-queue.js";
import { mergeChanges } from "../merge/merge-slot.js";
import { queueInFlight } from "../status/status-polls.js";
import { orchestratorAlive } from "../team/orchestrator-info.js";
import { shortSha } from "../text/format.js";
import { editBriefText } from "../brief/brief-edit.js";
import { requireStringField, validRoleIds } from "./gui-args.js";
import { badRequest, sendJson } from "./gui-http-body.js";
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

/** Handle POST /api/kill-orphans: the dashboard Health card's Kill orphans button — the same
 * killOrphans `tumwater doctor --kill-orphans` runs, answering its lines joined with "; ". Same
 * body discipline as /api/reclaim; `ok` is false when the scan failed or a signal was refused. */
export async function handleKillOrphans(req: http.IncomingMessage, res: http.ServerResponse, root: string, kill: (root: string) => Promise<OrphanKillReport> = killOrphans): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const report = await kill(root);
  sendJson(res, 200, { ok: !("error" in report) && report.failed.length === 0, message: orphanKillLines(report).join("; ") });
}

/** Handle POST /api/doctor-drop-broken-pins: the dashboard Health card's Drop broken pins
 * button — the same dropBrokenPins `tumwater doctor --drop-broken-pins` runs, answering its
 * lines joined with "; ". `ok` is false when any pin could not be dropped. Same body discipline
 * as /api/kill-orphans; `drop` is injectable so a test need not touch git. */
export async function handleDropBrokenPins(req: http.IncomingMessage, res: http.ServerResponse, root: string, drop: (root: string) => Promise<BrokenPinDrop> = dropBrokenPins): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const result = await drop(root);
  sendJson(res, 200, { ok: result.failed.length === 0, message: brokenPinDropLines(result).join("; ") });
}

/** Handle POST /api/doctor-retire-leftovers: the dashboard Health card's Retire leftovers
 * button — the same retireLeftovers `tumwater doctor --retire-leftovers` runs (with the loaded
 * config, never `--force`), answering its lines joined with "; ". `ok` is false when any role's
 * retire was refused. Same body discipline as /api/kill-orphans; `retire` is injectable so a
 * test need not touch git. */
export async function handleRetireLeftovers(req: http.IncomingMessage, res: http.ServerResponse, root: string, retire: (root: string) => Promise<LeftoverRetireReport> = (r) => retireLeftovers(r, loadConfigSafe(r).config)): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const report = await retire(root);
  sendJson(res, 200, { ok: report.failed.length === 0, message: leftoverRetireLines(report).join("; ") });
}

/** Handle POST /api/doctor-commit-backlog: the dashboard Health card's Commit backlog button —
 * the same commitUncommittedBacklog `tumwater doctor --commit-backlog` runs, answering its
 * lines joined with "; " through the shared backlogCommitMessage, plus the report's fields so the
 * card can repaint precisely. `ok` is false when any file's commit failed. Same body discipline
 * as /api/kill-orphans; `commit` is injectable so a test need not touch git. commitUncommitted-
 * Backlog never throws, so an off-base or unreadable checkout lands as the skip sentence, not a
 * 500. */
export async function handleCommitBacklog(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  commit: (root: string) => Promise<BacklogCommitReport> = (r) => commitUncommittedBacklog(r, loadConfigSafe(r).config),
): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const report = await commit(root);
  sendJson(res, 200, { ok: report.failed.length === 0, message: backlogCommitMessage(report), committed: report.committed, failed: report.failed, skipped: report.skipped, base: report.base });
}

/** Handle POST /api/doctor-archive-backlog: the dashboard Health card's Archive backlog
 * button — the same archiveFinishedOnMain `tumwater archive` runs (holding the merge lock),
 * answering its message verbatim. `ok` is true when the finished entries were archived or
 * there was nothing to archive; `skipped` (an off-base checkout, uncommitted backlog/archive
 * files, or an unreadable file) answers `ok: false` with the skip reason and writes nothing.
 * The archived body also carries the full commit sha and the moved files so the card can
 * repaint precisely. Same body discipline as /api/kill-orphans; `archive` is injectable so a
 * test need not touch git or hold the merge lock. */
export async function handleArchiveBacklog(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  archive: (root: string) => Promise<ArchiveOnMainOutcome> = (r) => archiveFinishedOnMain(r, { lockTimeoutMs: MERGE_LOCK_WAIT_MS }),
): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const outcome = await archive(root);
  if (outcome.status === "nothing") {
    sendJson(res, 200, { ok: true, message: "nothing to archive: PLANS.md ## Done and BUGS.md ## Fixed hold no finished entries" });
    return;
  }
  if (outcome.status === "skipped") {
    sendJson(res, 200, { ok: false, message: `nothing archived: ${outcome.reason}` });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    message: [...outcome.moved.map(describeArchivedFile), `committed ${shortSha(outcome.commit)}`].join("; "),
    archived: true,
    commit: outcome.commit,
    moved: outcome.moved,
  });
}

/** Handle POST /api/doctor-resync-install: the dashboard Health card's Re-sync install button —
 * the terminal twin of `tumwater doctor --resync-install` and the TUI's Ctrl+U, all reached
 * through the same resyncRootInstall. It answers the same lines the CLI prints
 * (rootInstallResyncLines, joined with "; "), its `ok` matching the report so the card can
 * repaint. Same body discipline as /api/kill-orphans; `resync` is injectable so a test need not
 * hold the merge lock or touch the registry. resyncRootInstall never throws, so a lock/blog
 * failure lands as the failure line, not a 500. */
export async function handleResyncInstall(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  resync: (root: string) => Promise<RootInstallResync> = resyncRootInstall,
): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const r = await resync(root);
  sendJson(res, 200, { ok: r.ok, message: rootInstallResyncLines(r).join("; ") });
}

/** Handle POST /api/doctor-reprobe: the dashboard Health card's Re-probe models button, the
 * twin of `tumwater doctor --reprobe`. A POST because it spends one model call per claimed pi
 * image-input model and rewrites `.tumwater/state/image-probes.json`; GET /api/doctor stays
 * probe-free. Same body discipline as /api/kill-orphans; `run` takes the probe mode so a test
 * can pin that the handler asks for "all" without spawning a probe. */
export async function handleDoctorReprobe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  run: (root: string, probeImages: "all") => Promise<DoctorReport> = (r, p) => runDoctor(r, undefined, undefined, p),
): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  sendJson(res, 200, await run(root, "all"));
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

/** Handle POST /api/abort-all: the dashboard Roles card's Abort all button — the same
 * marker-writing core `tumwater abort --all` calls (requestAbortAll). It reads no body (the
 * request targets every enabled runner), so a stale `role` field from another request changes
 * nothing; requestAbortAll's not-live error comes back 409 like /api/abort's, through
 * sendRequestResult. */
export async function handleAbortAll(_req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  sendRequestResult(res, requestAbortAll(root));
}

/** Handle POST /api/role-notes: the role drawer's notes Edit/Clear — the same saveRoleNote
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
  const followUp = revertFollowUp(result.subject);
  sendJson(res, 200, {
    ok: true,
    headSha: result.headSha,
    beforeSha: result.beforeSha,
    subject: result.subject,
    message: `main is now ${shortSha(result.headSha)}${followUp === null ? "" : ` — ${followUp}`}`,
  });
}
/** Refuse cancellation or reordering of a sha named by the live merge marker. */
function rejectInFlightMerge(res: http.ServerResponse, root: string, sha: string): boolean {
  const view = readMergeQueue(root);
  const normalized = sha.toLowerCase();
  const inFlight = queueInFlight(root, view.entries, orchestratorAlive(root));
  if (!inFlight || !((typeof inFlight.sha === "string" && inFlight.sha.toLowerCase() === normalized) || mergeChanges(inFlight).some((c) => c.sha.toLowerCase() === normalized)))
    return false;
  sendJson(res, 409, { error: `this merge is being merged right now — wait for it to land, then \`tumwater revert ${shortSha(sha)}\`` });
  return true;
}

/** Handle POST /api/queue-cancel: the Merge queue card row's two-click Cancel — the browser
 * twin of `tumwater queue --cancel <n>`, resolving by pinned sha (the same removal
 * `cancelQueuedMergeBySha` the CLI's position variant shares). A `sha` that is not 4-64 hex
 * digits is a 400 and runs nothing. A sha a live merge marker names mid-merge is a 409 with the
 * wait-then-revert wording and changes nothing; a sha no longer queued (a concurrent drain
 * raced the click) is a 200 `{ status: "gone" }` data, not an error. Otherwise it answers the
 * cancelled entry's role/commit/summary and removes the queue file and pin. */
export async function handleQueueCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"sha": "1a2b3c4"}');
  if (!body) return;
  if (typeof body.sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(body.sha))
    return badRequest(res, `"sha" must be a hex commit id of 4-64 digits${gotSuffix(body.sha)}`);
  if (rejectInFlightMerge(res, root, body.sha)) return;
  const outcome: CancelQueuedByShaOutcome = await cancelQueuedMergeBySha(root, body.sha);
  if (outcome.status === "gone") return sendJson(res, 200, { ok: true, status: "gone" });
  if (outcome.status !== "cancelled") return;
  sendJson(res, 200, {
    ok: true,
    status: "cancelled",
    role: outcome.role,
    commit: outcome.sha,
    summary: outcome.summary,
    message: `cancelled the merge of ${shortSha(outcome.sha)} — ${outcome.summary}`,
  });
}
/** Handle POST /api/post-review-accept: the Post-merge reviews card row's two-click Accept —
 * the browser twin of `tumwater reviews --accept <n>`, resolving by commit (the same removal
 * `acceptPostReviewBySha` the CLI's position variant shares). A `sha` that is not 4-64 hex
 * digits is a 400 and runs nothing. A sha no longer in the queue (a concurrent drain already
 * settled it) is a 200 `{ status: "gone" }` data, not an error. A `fixed` (already landed
 * its repair) entry is a 409 and changes nothing. A rejected entry waits on nothing and is
 * accepted like any pending one. Otherwise it answers the
 * accepted entry's role/commit/summary and removes the entry. */
export async function handlePostReviewAccept(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"sha": "1a2b3c4"}');
  if (!body) return;
  if (typeof body.sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(body.sha))
    return badRequest(res, `"sha" must be a hex commit id of 4-64 digits${gotSuffix(body.sha)}`);
  const outcome: AcceptPostReviewByShaOutcome = acceptPostReviewBySha(root, body.sha);
  if (outcome.status === "gone") return sendJson(res, 200, { ok: true, status: "gone" });

  if (outcome.status === "settled")
    return sendJson(res, 409, { error: `post-merge review ${shortSha(outcome.commit)} already merged its fix on main — nothing to accept` });
  if (outcome.status !== "accepted") return;
  sendJson(res, 200, {
    ok: true,
    status: "accepted",
    role: outcome.role,
    commit: outcome.commit,
    summary: outcome.summary,
    message: `accepted the post-merge review of ${shortSha(outcome.commit)} unreviewed — ${outcome.summary}`,
  });
}
/** Handle POST /api/queue-top: the Merge queue card row's Move to top button — the browser
 * twin of `tumwater queue --top <n>`, resolving by pinned sha (the same reorder
 * `moveQueuedMergeToTopBySha` the CLI's position variant shares). A `sha` that is not 4-64
 * hex digits is a 400 and runs nothing. A sha a live merge marker names mid-merge is a 409
 * with the wait-then-revert wording and changes nothing; a sha no longer queued (a
 * concurrent drain raced the click) is a 200 `{ status: "gone" }` data, not an error.
 * Otherwise it answers the topped entry's role/commit/summary and moves its queue file to
 * the front. */
export async function handleQueueTop(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"sha": "1a2b3c4"}');
  if (!body) return;
  if (typeof body.sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(body.sha))
    return badRequest(res, `"sha" must be a hex commit id of 4-64 digits${gotSuffix(body.sha)}`);
  if (rejectInFlightMerge(res, root, body.sha)) return;
  const outcome: TopQueuedByShaOutcome = moveQueuedMergeToTopBySha(root, body.sha);
  if (outcome.status === "gone") return sendJson(res, 200, { ok: true, status: "gone" });
  if (outcome.status === "already-first")
    return sendJson(res, 200, { ok: true, status: "already-first", role: outcome.role, commit: outcome.sha, summary: outcome.summary, message: `${shortSha(body.sha)} is already at the front` });
  if (outcome.status !== "topped") return;
  sendJson(res, 200, {
    ok: true,
    status: "topped",
    role: outcome.role,
    commit: outcome.sha,
    summary: outcome.summary,
    message: `moved the merge of ${shortSha(outcome.sha)} to the front — ${outcome.summary}`,
  });
}
/** Handle POST /api/brief: replace the brief text through editBriefText — the same
 * checks, locked write, and commit as `tumwater brief --file`. A non-string prompt or any
 * refusal is a 400 and writes nothing. */
export async function handleBriefEdit(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"prompt": "…"}');
  if (!body) return;
  const prompt = requireStringField(res, body, "prompt", "the full replacement brief");
  if (prompt === null) return;
  const outcome = await editBriefText(root, prompt);
  if (!outcome.ok) return badRequest(res, outcome.error);
  sendJson(res, 200, { file: outcome.file, changed: outcome.changed, committed: outcome.committed });
}
