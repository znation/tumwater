/**
 * The dashboard's /api endpoint handlers (src/ui/gui.ts routes to them): the GET data
 * endpoints — transcript, backlog, report, failures — and the POST operator endpoints —
 * prompt, budget, pause, wake, abort, pause-role — plus the role validation they share. The
 * response/body plumbing lives below them (http-body.ts: sendJson, the body cap, readJsonObject).
 * Each handler answers its request and touches no socket beyond its own `res`; server lifecycle, routing, the static page, and the token gate stay
 * in gui.ts. The domain work itself lives one layer down (transcript.ts, backlog.ts,
 * report.ts, failure-data.ts, inbox.ts, config-write.ts, fleet-state.ts,
 * operator-commands.ts) — this module only adapts HTTP onto it.
 */
import type { BacklogEntry } from "../backlog.js";
import { openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog.js";
import { promptLengthProblem, submitPrompt, submitRolePrompt } from "../inbox.js";
import { knownRoleIds, loadConfigCached } from "../config.js";
import { checkDailyBudgetUsd, setDailyBudgetUsd } from "../config-write.js";
import { pauseFleet, pauseRole, resumeFleet, resumeRole } from "../fleet-state.js";
import { requestAbort, requestWake } from "../operator-commands.js";
import { allRoleIds, DIRECTOR_ROLE } from "../roles.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "./report.js";
import { collectReport } from "../report-data.js";
import { collectFailureReport } from "../failure-data.js";
import { renderFailureMarkdown } from "../failure-report.js";
import { readTranscript } from "./transcript.js";
import { parseNonNegativeInt, parsePositiveInt } from "../text.js";
import { readJsonObject, sendJson } from "./http-body.js";
import type http from "node:http";

/** The role ids a loop-targeting endpoint accepts: when tumwater.json parses, catalog +
 * customLoops (knownRoleIds); a transiently broken file falls back to the built-in catalog
 * rather than refusing every id. Shared by /api/transcript and the two operator endpoints so
 * their validation and 400 wording cannot drift. */
function validRoleIds(root: string): string[] {
  const { config } = loadConfigCached(root);
  return config ? knownRoleIds(config) : allRoleIds();
}

/** Validate one request's loop-targeting role against validRoleIds, sending the shared 400 on
 * a miss and reporting whether the request should stop: an absent id reads "role required
 * (valid ids: …)" — unless `allowMissing`, the wake endpoint's `{}` → all-roles default, which
 * only a truly absent `undefined` may ride; an explicit null is always rejected — and a
 * present-but-unknown one reads "unknown role X (valid ids: …)". /api/transcript and the
 * wake/abort operator endpoints share it so their validation and 400 wording cannot drift. */
function rejectBadRole(root: string, res: http.ServerResponse, role: unknown, allowMissing = false): boolean {
  // The all-roles default rides only a truly absent id — check it first, so the wake path
  // (allowMissing with `{}`) never computes the id list it will not validate against.
  if (role === undefined && allowMissing) return false;
  const validIds = validRoleIds(root);
  if (role === undefined || role === null) {
    sendJson(res, 400, { error: `role required (valid ids: ${validIds.join(", ")})` });
    return true;
  }
  if (typeof role !== "string" || !validIds.includes(role)) {
    sendJson(res, 400, { error: `unknown role ${JSON.stringify(role)} (valid ids: ${validIds.join(", ")})` });
    return true;
  }
  return false;
}

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
  let n = 50;
  const nRaw = q.get("n");
  if (nRaw !== null) {
    const parsed = parsePositiveInt(nRaw);
    if (parsed === null) {
      sendJson(res, 400, { error: `n must be a positive integer (got ${JSON.stringify(nRaw)})` });
      return;
    }
    n = parsed;
  }
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
  const indexRaw = q.get("index");
  if (indexRaw === null) {
    sendJson(res, 400, { error: "index required" });
    return;
  }
  const index = parseNonNegativeInt(indexRaw);
  if (index === null) {
    sendJson(res, 400, { error: `index must be a non-negative integer (got ${JSON.stringify(indexRaw)})` });
    return;
  }
  const entry = entries[index];
  if (!entry) {
    sendJson(res, 400, { error: `index ${index} out of range (${file} has ${entries.length} open entries)` });
    return;
  }
  sendJson(res, 200, { title: entry.title, body: entry.body });
}

/** The window both report endpoints serve, from ?days=N on the request. One exact rule,
 * shared so /api/report and /api/failures cannot drift: missing or non-decimal →
 * REPORT_DEFAULT_DAYS, out-of-range clamped to 1..REPORT_MAX_DAYS (the same bounds the CLI's
 * --days enforces, shared in report.ts) — never an error (a URL typo must degrade to the
 * default window, deliberately unlike handleTranscript's parsePositiveInt→400 idiom).
 * "Non-decimal" is the shared plain-digit rule (text.parseNonNegativeInt):
 * hex/scientific/signed/padded spellings are not counts and get the default instead of a
 * coerced value — raw Number.parseInt would read "1e3" as 1, "0x10" as 0, and "-5" as -5. */
function windowDays(q: URLSearchParams): number {
  const n = parseNonNegativeInt(q.get("days") ?? "");
  return n === null ? REPORT_DEFAULT_DAYS : Math.min(REPORT_MAX_DAYS, Math.max(1, n));
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

/** Pull the prompt text out of a prompt endpoint's body — the shared validator for
 * /api/prompt and /api/prompt-role, which must reject a non-string, blank, or over-long text
 * with the same 400 wording: both dashboards' prompt bars sit behind the same length rule
 * (inbox.ts's promptLengthProblem) and a retried request must get identical answers from
 * either surface. Returns the validated text, or null once the 400 is sent. */
function requirePromptText(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  role: string = DIRECTOR_ROLE,
): string | null {
  const text = body.text;
  if (typeof text !== "string") {
    sendJson(
      res,
      400,
      { error: `text must be a string${text === undefined ? "" : ` (got ${JSON.stringify(text)})`}` },
    );
    return null;
  }
  if (!text.trim()) {
    sendJson(res, 400, { error: "text required" });
    return null;
  }
  const tooLong = promptLengthProblem(text, role);
  if (tooLong) {
    sendJson(res, 400, { error: tooLong });
    return null;
  }
  return text;
}

/** Handle POST /api/prompt: queue a director prompt. An over-long prompt
 * (DIRECTOR_PROMPT_MAX_CHARS) is a user-input error, not a server fault: the shared length
 * rule answers 400 — an unexpected submit failure (EACCES) still reaches the server's outer
 * catch as the 500 its gui-server test pins. */
export async function handlePrompt(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"text": "..."}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  const text = requirePromptText(res, body);
  if (text === null) return;
  submitPrompt(root, text);
  sendJson(res, 200, { ok: true });
}

/** Handle POST /api/prompt-role: queue a prompt for one loop — the dashboard's per-row
 * prompt affordance submits here, calling the same path `tumwater prompt --role <id>` uses
 * (submitRolePrompt enqueues into that loop's own queue and logs under it, then a single-role
 * wake brings the live loop in within one poll; the wake message rides back for the flash).
 * The role validates exactly like /api/transcript (the shared rejectBadRole wording), and the
 * body discipline is /api/prompt's: readJsonObject → 400 malformed/non-object, 413 oversized,
 * text a non-empty string within the shared length rule → 400 otherwise. */
export async function handlePromptRole(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"role": "feature", "text": "..."}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  if (rejectBadRole(root, res, body.role)) return;
  const role = body.role as string;
  const text = requirePromptText(res, body, role);
  if (text === null) return;
  submitRolePrompt(root, role, text);
  sendJson(res, 200, { ok: true, message: requestWake(root, [role]) });
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

/** Pull the required `paused` boolean out of a pause endpoint's body — the shared validator
 * for /api/pause and /api/pause-role, which must reject a missing or non-boolean target state
 * with the same 400 wording: the target state is explicit (`paused: true|false`), so a retried
 * request is idempotent only if both surfaces agree on what counts as an explicit state.
 * Returns null once the 400 is sent. */
function requirePausedFlag(res: http.ServerResponse, body: Record<string, unknown>): boolean | null {
  const value = body.paused;
  if (typeof value !== "boolean") {
    sendJson(
      res,
      400,
      { error: `paused must be a boolean${value === undefined ? "" : ` (got ${JSON.stringify(value)})`}` },
    );
    return null;
  }
  return value;
}

/** Handle POST /api/pause: the dashboard header's pause/resume toggle — the same operator
 * gate `tumwater pause` and `resume` write, via fleet-state.ts's shared writers
 * (pauseFleet/resumeFleet) so the CLI and the GUI cannot drift on the marker's format or
 * idempotence. Same body discipline as /api/prompt and /api/budget (readJsonObject → 400
 * malformed/non-object, 413 oversized); the target state is explicit (`paused: true|false`)
 * rather than a toggle, so a retried request is idempotent. */
export async function handlePause(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readJsonObject(req, res, '{"paused": true}');
  if (!body) return; // 4xx already sent — oversized or not a JSON object
  const value = requirePausedFlag(res, body);
  if (value === null) return;
  if (value) pauseFleet(root);
  else resumeFleet(root);
  sendJson(res, 200, { ok: true, paused: value });
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
