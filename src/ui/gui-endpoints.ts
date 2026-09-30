/**
 * The dashboard's /api endpoint handlers (src/ui/gui.ts routes to them): the GET data
 * endpoints — transcript, backlog, report, failures, history — and the POST operator endpoints —
 * prompt, prompt-cancel, budget, pause, wake, restart, abort, pause-role — plus, below them, the
 * shared request-argument validators each handler guards its inputs with (gui-args.ts) and
 * the response/body plumbing (http-body.ts: sendJson, the body cap, readJsonObject).
 * Each handler answers its request and touches no socket beyond its own `res`; server lifecycle, routing, the static page, and the token gate stay
 * in gui.ts. The domain work itself lives one layer down (transcript.ts, backlog.ts,
 * report.ts, failure-data.ts, inbox.ts, config-write.ts, fleet-state.ts,
 * operator-intent.ts) — this module only adapts HTTP onto it.
 */
import type { BacklogEntry } from "../backlog.js";
import { openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog.js";
import { cancelQueuedFile, promptPreview, queueFileNameProblem, submitPrompt } from "../inbox.js";
import { promptImagesProblem, type PromptImageInput } from "../inbox-attachments.js";
import { checkDailyBudgetUsd, setDailyBudgetUsd } from "../config-write.js";
import { pauseFleet, pauseRole, resumeFleet, resumeRole } from "../fleet-state.js";
import { PAUSE_FOR_MAX_MS, requestAbort, requestRestart, requestWake, submitRolePromptAndWake } from "../operator-intent.js";
import { DIRECTOR_ROLE } from "../roles.js";
import { collectReport } from "../report-data.js";
import { collectFailureReport } from "../failure-data.js";
import { renderFailureMarkdown } from "../failure-report.js";
import { readTranscript } from "./transcript.js";
import { HISTORY_DEFAULT_TICKS, HISTORY_MAX_TICKS, readTickRows } from "../history-data.js";
import { intQuery, rejectBadRole, requirePausedFlag, requirePromptText, validRoleIds, windowDays } from "./gui-args.js";
import { readJsonObject, sendJson } from "./http-body.js";
import type http from "node:http";

/** Handle GET /api/transcript?role=<id>&n=N: rendered transcript lines for one loop's pi
 * log (same rendering as `tumwater logs --role <id>`). Unknown/missing role or a bad n → 400.
 * User-defined loops are valid targets too — the GUI marks them with an asterisk, so clicking
 * one must open its transcript: ids validate through rejectBadRole. The 400 message lists
 * exactly the ids accepted. The query arrives pre-parsed — the server parses the target
 * once (gui.ts's parseRequestTarget) and threads it down, so the parse idiom lives in one
 * place and cannot disagree with the routing or the token gate about what the URL said. */
export function handleTranscript(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role");
  if (rejectBadRole(root, res, role)) return;
  const n = intQuery(q, res, "n", "positive", 50);
  if (n === null) return;
  sendJson(res, 200, { lines: readTranscript(root, role as string, n) });
}

/** Handle GET /api/backlog?file=<plans|bugs|questions>&index=N: one backlog entry's full
 * text ({title, body}), fetched on demand so multi-KB bodies (long repros, whole plans) never
 * ride the 1-second /api/status poll. index addresses the Nth entry of that file's open
 * section in the same order statusPayload lists its titles — PLANS.md ## Planned,
 * BUGS.md ## Open, QUESTIONS.md ## Open — zero-based. Unknown/missing file, missing or bad
 * index, and out-of-range index → 400 JSON error via sendJson. The query arrives pre-parsed
 * (gui.ts's parseRequestTarget), like every GET-data handler here. */
export function handleBacklog(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const file = q.get("file");
  if (file === null) {
    sendJson(res, 400, { error: `file required (valid values: plans, bugs, questions)` });
    return;
  }
  let entries: BacklogEntry[] | null = null;
  if (file === "plans") entries = plannedPlanEntries(root);
  else if (file === "bugs") entries = openBugEntries(root);
  else if (file === "questions") entries = openQuestionEntries(root);
  if (!entries) {
    sendJson(res, 400, { error: `unknown file ${JSON.stringify(file)} (valid values: plans, bugs, questions)` });
    return;
  }
  const index = intQuery(q, res, "index", "non-negative");
  if (index === null) return;
  const entry = entries[index];
  if (!entry) {
    sendJson(res, 400, { error: `index ${index} out of range (${file} has ${entries.length} open entries)` });
    return;
  }
  sendJson(res, 200, { title: entry.title, body: entry.body });
}

/** Handle GET /api/report?days=N: the usage report data (collectReport's ReportData) as
 * JSON — the dashboard's report tab renders it. The days window follows windowDays. Reads
 * files directly, so it works whether or not the fleet is running. */
export function handleReport(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  sendJson(res, 200, collectReport(root, windowDays(q)));
}

/** Handle GET /api/failures?days=N: the same bounded Markdown failure digest the telemetry
 * loop feeds on and `tumwater report --failures` prints, as JSON ({ markdown }) — the
 * dashboard's failures tab renders it. The days window follows windowDays (so it can never
 * drift from /api/report's). Reads files directly, so it works with no fleet running. */
export function handleFailures(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReport(root, windowDays(q))) });
}

/** Handle GET /api/history?role=<id>&n=N: the per-tick rows readTickRows derives from the
 * event log ({ rows }) — the same rows `tumwater history` prints (the shared scan, window
 * growth included, so a role-filtered ask on a busy fleet cannot silently come back short),
 * the dashboard's history tab renders them. n is optional: absent → HISTORY_DEFAULT_TICKS;
 * present but not a plain non-negative integer → 400 (the handleBacklog index discipline — an
 * explicit count that does not parse is a client error, unlike the report's degrade-to-default
 * typo rule); then clamped to [1, HISTORY_MAX_TICKS] — the GUI clamps where the CLI fails
 * fast, its established convention. role is optional: absent or empty → all loops; present →
 * passed straight through as the role filter with no config validation (a filter is not a
 * target — an id with no ticks legitimately yields zero rows), so the endpoint reads nothing
 * but files, like /api/report and /api/failures. Reads files directly, so it works whether
 * or not the fleet is running. */
export function handleHistory(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const parsed = intQuery(q, res, "n", "non-negative", HISTORY_DEFAULT_TICKS);
  if (parsed === null) return;
  const n = Math.min(HISTORY_MAX_TICKS, Math.max(1, parsed));
  const role = q.get("role") || null; // "" and absent both read all loops
  sendJson(res, 200, { rows: readTickRows(root, n, role) });
}

/** Handle POST /api/prompt: queue a director prompt. An over-long prompt
 * (DIRECTOR_PROMPT_MAX_CHARS) is a user-input error, not a server fault: the shared length
 * rule answers 400 — an unexpected submit failure (EACCES) still reaches the server's outer
 * catch as the 500 its gui-server test pins. An optional images array (the composer's
 * dropped/pasted attachments) is validated before anything is queued: a bad image — wrong
 * extension, too many, undecodable, oversized — answers 400 naming the rule, with no queue
 * file and no image written. */
export async function handlePrompt(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"text": "..."}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  const text = requirePromptText(res, body);
  if (text === null) return;
  const images = checkedPromptImages(res, body);
  if (images === null) return;
  submitPrompt(root, text, images);
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

/** Handle POST /api/prompt-role: queue a prompt for one loop — the dashboard's per-row
 * prompt affordance submits here, calling the same path `tumwater prompt --role <id>` uses
 * (submitRolePrompt enqueues into that loop's own queue and logs under it, then a single-role
 * wake brings the live loop in within one poll; the wake message rides back for the flash).
 * The role validates exactly like /api/transcript (the shared rejectBadRole wording), and the
 * body discipline is /api/prompt's: readJsonObject → 400 malformed/non-object, 413 oversized,
 * text a non-empty string within the shared length rule → 400 otherwise — plus the same
 * optional images array and its validate-before-anything-is-written discipline. */
export async function handlePromptRole(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"role": "feature", "text": "..."}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  if (rejectBadRole(root, res, body.role)) return;
  const role = body.role as string;
  const text = requirePromptText(res, body, role);
  if (text === null) return;
  const images = checkedPromptImages(res, body);
  if (images === null) return;
  sendJson(res, 200, { ok: true, message: submitRolePromptAndWake(root, role, text, images) });
}

/** Handle POST /api/prompt-cancel: retract one queued prompt addressed by its queue file —
 * the dashboard's per-row cancel affordance, the file-addressed twin of the CLI's
 * position-addressed `prompt --cancel`. The role is optional (absent cancels from the
 * director's queue) and validates exactly like /api/transcript; a file name failing the
 * basename guard (inbox.ts's queueFileNameProblem) is a user-input error answered 400 with
 * nothing touched on disk. A vanished file answers 200 { status: "gone" } — the loop already
 * dequeued the prompt, which is data for the flash line, not a server fault. Same body
 * discipline as /api/prompt (readJsonObject → 400 malformed/non-object, 413 oversized). */
export async function handlePromptCancel(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"role": "feature", "file": "<stamp>-<seq>-<pid>.md"}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
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
  const body = await readJsonObject(req, res, '{"maxDailyCostUsd": 25}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
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

/** Handle POST /api/pause: the dashboard's pause control — the same operator gate
 * `tumwater pause [--for <duration>]` and `resume` write, via fleet-state.ts's shared writers
 * (pauseFleet/resumeFleet) so the CLI and the GUI cannot drift on the marker's format or
 * idempotence. Same body discipline as /api/prompt and /api/budget (readJsonObject → 400
 * malformed/non-object, 413 oversized); the target state is explicit (`paused: true|false`)
 * rather than a toggle, so a retried request is idempotent. An optional `forSeconds` makes it
 * a timed pause (the marker's `until`, capped like the CLI's `--for`); it only accompanies
 * `paused: true`. */
export async function handlePause(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"paused": true, "forSeconds": 3600}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  const value = requirePausedFlag(res, body);
  if (value === null) return;
  const forSeconds = body.forSeconds;
  if (forSeconds !== undefined) {
    if (!value) {
      sendJson(res, 400, { error: "forSeconds only applies when pausing (paused: true)" });
      return;
    }
    if (typeof forSeconds !== "number" || !Number.isFinite(forSeconds) || forSeconds <= 0) {
      sendJson(res, 400, { error: `forSeconds must be a positive number of seconds (got ${JSON.stringify(forSeconds)})` });
      return;
    }
    if (forSeconds * 1000 > PAUSE_FOR_MAX_MS) {
      sendJson(res, 400, { error: `forSeconds is capped at ${PAUSE_FOR_MAX_MS / 1000} (90 days) — pause without it for a standing pause` });
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
  const body = await readJsonObject(req, res, '{"role": "feature"}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  if (rejectBadRole(root, res, body.role, true)) return;
  sendJson(res, 200, {
    ok: true,
    message: requestWake(root, body.role === undefined ? validRoleIds(root) : [body.role as string]),
  });
}

/** Handle POST /api/restart: the dashboard's build-stale alert's refresh button — the same
 * marker-writing core a CLI surface would call (requestRestart), so the wording and the
 * not-pending refusal cannot drift. The not-pending error comes back 409 like /api/abort's
 * not-live one: the request is valid but nothing can act on it. Same body discipline as
 * /api/wake (readJsonObject → 400 malformed/non-object, 413 oversized; the body itself is
 * ignored — there are no options to force a restart). */
export async function handleRestart(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, "{}");
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  const result = requestRestart(root);
  if (!result.ok) {
    sendJson(res, 409, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, message: result.message });
}

/** Handle POST /api/abort: the dashboard's per-row abort control — the same marker-writing
 * core `tumwater abort` calls (requestAbort). The role is required and validated like
 * /api/transcript; requestAbort's not-live error comes back 409 — the marker is valid but
 * nothing can consume it, a conflict rather than a client 400. The director variant's
 * message (the discarded-prompt note) rides through verbatim. */
export async function handleAbort(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"role": "feature"}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  if (rejectBadRole(root, res, body.role)) return;
  const result = requestAbort(root, body.role as string);
  if (!result.ok) {
    sendJson(res, 409, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, message: result.message });
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
  const body = await readJsonObject(req, res, '{"role": "feature", "paused": true}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  if (rejectBadRole(root, res, body.role)) return;
  const value = requirePausedFlag(res, body);
  if (value === null) return;
  const changed = value
    ? pauseRole(root, body.role as string)
    : resumeRole(root, body.role as string);
  sendJson(res, 200, { ok: true, changed, paused: value });
}
