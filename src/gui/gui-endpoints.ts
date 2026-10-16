/**
 * The dashboard's GET data endpoint handlers (src/gui/gui-server.ts routes to them): transcript,
 * prompt-text, backlog, report, failures, history, tick, diff, config — the read-only surface.
 * The POST
 * operator endpoints (prompt, prompt-role, prompt-cancel, prompt-edit, budget, config-set, pause,
 * wake, restart, abort, pause-role) and their body-discipline helpers live in
 * gui/gui-endpoint-commands.ts. Each handler answers its request and touches no socket beyond
 * its own `res`; server lifecycle, routing, the static page, and the token gate stay in
 * gui/gui-server.ts. The domain work itself lives one layer down (transcript.ts, backlog.ts,
 * report-data.ts, src/failure/failure-data.ts, history-data.ts, tick-detail-data.ts, config.ts)
 * — this module only adapts HTTP onto it.
 */
import type { BacklogEntry } from "../backlog/backlog-md.js";
import { openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { runDoctor } from "../doctor/doctor.js";
import type { DoctorReport } from "../doctor/doctor-checks.js";
import { loadConfigSafe } from "../config/config.js";
import { EDITABLE_CONFIG_KEYS } from "../config/config-editable-keys.js";
import { collectReport, collectReportSince } from "../report/report-data.js";
import { collectFailureReport, collectFailureReportSince } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";
import { renderSinceReportMarkdown } from "../report/report-render.js";
import { REPORT_SINCE_MAX_MS } from "../events/event-window.js";
import { humanSeconds } from "../text/datetime.js";
import { collectFleetChanges, collectRoleChange } from "../change/change-data.js";
import { readTranscript } from "../ui/transcript.js";
import { HISTORY_DEFAULT_TICKS, HISTORY_MAX_TICKS, readTickRows, readTickRowsSince, tickRowsMatchingGrep } from "../history/history-data.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE } from "../events/event-window.js";
import { eventRole, readEvents } from "../events/event-read.js";
import { eventFeedItem, eventMatchesGrep } from "../events/event-format.js";
import { readTickDetail } from "../tick/tick-detail-data.js";
import { renderTickDetail, tickDetailStat, tickNotFoundMessage } from "../tick/tick-detail.js";
import { rolePayload } from "../roles/role-view.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { readQueuedPromptBody } from "../inbox/inbox-edit.js";
import { intQuery, rejectBadQueueFileName, rejectBadRole, sinceMsQuery, windowDays } from "./gui-args.js";
import { readBrief } from "../brief/brief.js";
import { badRequest, okGone, sendJson } from "./http-body.js";
import { typoSuffix } from "../text/suggest.js";
import type http from "node:http";
/** Handle GET /api/transcript?role=<id>&n=N: rendered transcript lines for one loop's pi
 * log (same rendering as `tumwater logs --role <id>`). Unknown/missing role or a bad n → 400.
 * User-defined loops are valid targets too — the GUI marks them with an asterisk, so clicking
 * one must open its transcript: ids validate through rejectBadRole. The 400 message lists
 * exactly the ids accepted. The query arrives pre-parsed — the server parses the target
 * once (gui/gui-server.ts's parseRequestTarget) and threads it down, so the parse idiom lives
 * in one place and cannot disagree with the routing or the token gate about what the URL said. */
export function handleTranscript(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role");
  if (rejectBadRole(root, res, role)) return;
  const n = intQuery(q, res, "n", "positive", 50);
  if (n === null) return;
  sendJson(res, 200, { lines: readTranscript(root, role as string, n) });
}

/** The /api/backlog `file` values and the open-section reader each addresses — one table so
 * the on-demand dispatch and the "valid values" list in both 400s cannot drift apart. A Map,
 * not an object literal, so no `file` spelling (`constructor`, `toString`, `__proto__`) can
 * reach an inherited member through the lookup. Insertion order is the list order. */
const BACKLOG_FILE_READERS = new Map<string, (root: string) => BacklogEntry[]>([
  ["plans", plannedPlanEntries],
  ["bugs", openBugEntries],
  ["questions", openQuestionEntries],
]);
const BACKLOG_FILE_NAMES = [...BACKLOG_FILE_READERS.keys()];
const BACKLOG_FILE_VALUES = BACKLOG_FILE_NAMES.join(", ");

/** Handle GET /api/backlog?file=<plans|bugs|questions>&index=N: one backlog entry's full
 * text ({title, body}), fetched on demand so multi-KB bodies (long repros, whole plans) never
 * ride the 1-second /api/status poll. index addresses the Nth entry of that file's open
 * section in the same order statusPayload lists its titles — PLANS.md ## Planned,
 * BUGS.md ## Open, QUESTIONS.md ## Open — zero-based. Unknown/missing file, missing or bad
 * index, and out-of-range index → 400 JSON error via sendJson. The query arrives pre-parsed
 * (gui/gui-server.ts's parseRequestTarget), like every GET-data handler here. */
export function handleBacklog(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const file = q.get("file");
  if (file === null) {
    badRequest(res, `file required (valid values: ${BACKLOG_FILE_VALUES})`);
    return;
  }
  const reader = BACKLOG_FILE_READERS.get(file);
  if (!reader) {
    badRequest(res, `unknown file ${JSON.stringify(file)} (valid values: ${BACKLOG_FILE_VALUES})${typoSuffix(file, BACKLOG_FILE_NAMES)}`);
    return;
  }
  const entries = reader(root);
  const index = intQuery(q, res, "index", "non-negative");
  if (index === null) return;
  const entry = entries[index];
  if (!entry) {
    badRequest(res, `index ${index} out of range (${file} has ${entries.length} open entries)`);
    return;
  }
  sendJson(res, 200, { title: entry.title, body: entry.body });
}

/** Handle GET /api/diff[?role=<id>]: the unlanded-change view the CLI prints from the same
 * collectors — no `role` → collectFleetChanges (exactly `tumwater diff --json`'s document:
 * `{ mainBranch, roles }`, no per-role patch halves); `?role=<id>` → collectRoleChange (the
 * full per-role view with `diff`/`uncommittedDiff`, `tumwater diff --role <id> --json`). The
 * role is a target, not a filter, so it validates through rejectBadRole exactly like
 * /api/transcript and /api/tick (unknown/missing → 400 naming the valid ids) — the same ids
 * `parseRoleFlag` accepts on the CLI, including disabled and user-defined loops. The
 * collectors degrade absent worktrees and missing base branches to their `state` instead of
 * throwing, so a fresh or half-built repo still answers 200. Reads git plumbing directly, so
 * it works whether or not the fleet is running. */
export async function handleDiff(q: URLSearchParams, res: http.ServerResponse, root: string): Promise<void> {
  const role = q.get("role");
  if (role === null) {
    sendJson(res, 200, await collectFleetChanges(root));
    return;
  }
  if (rejectBadRole(root, res, role)) return;
  sendJson(res, 200, await collectRoleChange(root, role));
}

/** Handle GET /api/report?days=N[&role=<id>] or /api/report?sinceMs=<ms>[&role=<id>]: the
 * usage report — the day series (collectReport's ReportData) as JSON the dashboard's report tab
 * charts, or, when sinceMs is set, the trailing-window totals rendered through
 * renderSinceReportMarkdown as { markdown } (the CLI's `report --since` shape), bounded by the
 * reportSinceMs helper. The day window follows windowDays. An absent role is the fleet-wide
 * report exactly as before; a present one is a filter, validated through rejectBadRole (unknown,
 * including the empty string → 400 naming the valid ids) and handed to the collector's role
 * scope. Reads files directly, so it works whether or not the fleet is running. */
export function handleReport(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role");
  if (role !== null && rejectBadRole(root, res, role)) return;
  if (q.get("sinceMs") !== null) {
    const sinceMs = reportSinceMs(q, res);
    if (sinceMs === null) return;
    sendJson(res, 200, { markdown: renderSinceReportMarkdown(collectReportSince(root, sinceMs, role ?? undefined)) });
    return;
  }
  sendJson(res, 200, collectReport(root, windowDays(q), role ?? undefined));
}

/** Parse and bound the report endpoints' `?sinceMs=` trailing-window length: a simultaneous
 * `?days=` is the CLI's rival shape (whole local days vs a trailing window) → 400 naming both;
 * otherwise the length rides sinceMsQuery (gui-args.ts) — positive-integer parse, then a 400
 * naming the cap rather than a silent clamp (an explicit window typo must not shrink to some
 * other window) — with the "must be between 1 and …" wording. Returns the parsed length, or
 * null once the 400 is sent. */
function reportSinceMs(q: URLSearchParams, res: http.ServerResponse): number | null {
  if (q.get("days") !== null) {
    badRequest(res, "days and sinceMs are mutually exclusive; days counts whole local days, sinceMs totals a trailing window");
    return null;
  }
  return sinceMsQuery(q, res, REPORT_SINCE_MAX_MS, (sinceMs) =>
    `sinceMs must be between 1 and ${humanSeconds(REPORT_SINCE_MAX_MS / 1000)} (got ${sinceMs})`);
}

/** Handle GET /api/failures?days=N[&role=<id>] or /api/failures?sinceMs=<ms>[&role=<id>]: the
 * same bounded Markdown failure digest the telemetry loop feeds on and `tumwater report
 * --failures` prints, as JSON ({ markdown }) — the dashboard's failures tab renders it; with
 * sinceMs it is the trailing-window digest (collectFailureReportSince) through the same render,
 * the CLI's `report --failures --since` shape. The days window follows windowDays (so it can
 * never drift from /api/report's). role rides the same absent-fleet / present-filter rule as
 * handleReport: absent → the fleet digest, present → validated and scoped. Reads files
 * directly, so it works with no fleet running. */
export function handleFailures(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role");
  if (role !== null && rejectBadRole(root, res, role)) return;
  if (q.get("sinceMs") !== null) {
    const sinceMs = reportSinceMs(q, res);
    if (sinceMs === null) return;
    sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReportSince(root, sinceMs, role ?? undefined)) });
    return;
  }
  sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReport(root, windowDays(q), role ?? undefined)) });
}

/** Handle GET /api/history?role=<id>&n=N[&grep=<text>] — or ?role=<id>&sinceMs=<ms> for a
 * trailing window: the per-tick rows the CLI's `tumwater history` derives from the event log,
 * the dashboard's history tab renders them. The count shape ({ rows }) rides readTickRows (the
 * shared scan, window growth included, so a role-filtered ask on a busy fleet cannot silently
 * come back short); n is optional: absent → HISTORY_DEFAULT_TICKS; present but not a plain
 * non-negative integer → 400 (the handleBacklog index discipline — an explicit count that does
 * not parse is a client error, unlike the report's degrade-to-default typo rule); then clamped
 * to [1, HISTORY_MAX_TICKS] — the GUI clamps where the CLI fails fast, its established
 * convention. grep is optional: absent or empty filters nothing; present → the rows are
 * filtered through history-data.ts's shared tickRowsMatchingGrep rule, the same
 * case-insensitive haystack rule `tumwater history --grep` uses (shared, not
 * re-implemented), after the n/role scan so n bounds the scanned window and not the
 * printed rows — the CLI's rule. The window shape ({ rows, covered, note }) rides
 * readTickRowsSince, the collector behind `history --since`,
 * so the browser and the CLI cannot disagree about the window's rows; a simultaneous n is a
 * rival shape → 400 (the CLI's count-vs-window rule), sinceMs parses and is capped through
 * sinceMsQuery (gui-args.ts, LOGS_SINCE_MAX_MS — the shared `history --since` cap), and note is
 * SPARSE_WINDOW_NOTE when covered is false, else "". role is optional: absent or empty → all
 * loops; present → passed straight through as the role filter with no config validation (a
 * filter is not a target — an id with no ticks legitimately yields zero rows), so the endpoint
 * reads nothing but files, like /api/report and /api/failures. Reads files directly, so it
 * works whether or not the fleet is running. */
export function handleHistory(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role") || null; // "" and absent both read all loops
  const grep = q.get("grep") || null; // "" and absent both filter nothing
  if (q.get("sinceMs") !== null) {
    if (q.get("n") !== null) {
      badRequest(res, "sinceMs cannot be combined with n (a count and a window are rival shapes)");
      return;
    }
    const sinceMs = sinceMsQuery(q, res, LOGS_SINCE_MAX_MS, (ms) =>
      `sinceMs is capped at ${humanSeconds(LOGS_SINCE_MAX_MS / 1000)} (got ${ms})`);
    if (sinceMs === null) return;
    const { rows, covered } = readTickRowsSince(root, sinceMs, role);
    const matched = grep === null ? rows : tickRowsMatchingGrep(rows, grep);
    sendJson(res, 200, { rows: matched, covered, note: covered ? "" : SPARSE_WINDOW_NOTE });
    return;
  }
  const parsed = intQuery(q, res, "n", "non-negative", HISTORY_DEFAULT_TICKS);
  if (parsed === null) return;
  const n = Math.min(HISTORY_MAX_TICKS, Math.max(1, parsed));
  let rows = readTickRows(root, n, role);
  if (grep !== null) rows = tickRowsMatchingGrep(rows, grep);
  sendJson(res, 200, { rows });
}

/** How many of the log's newest events `GET /api/logs` scans by default, and the most it will
 * scan however large `n` asks: the CLI's `-n` shape (n bounds the scanned tail, not the printed
 * rows), sized so the dashboard's search can reach well past the RECENT_EVENTS window the
 * status poll carries. */
const LOGS_SEARCH_EVENTS = 500;
const LOGS_SEARCH_MAX_EVENTS = 5000;

/** Handle GET /api/logs?n=N[&grep=<text>][&role=<id>]: a slice of the raw event log scanned
 * from its newest end, filtered with the CLI's own rules and shaped as the activity feed's
 * items. `n` is optional (absent → LOGS_SEARCH_EVENTS) and clamps to [1, LOGS_SEARCH_MAX_EVENTS]
 * after intQuery's non-negative parse (an explicit count that does not parse is a 400, the
 * handleHistory discipline); it bounds the scanned tail, so a matching event older than the
 * last n events is absent — the same scan-then-filter rule `tumwater logs -n N --grep` applies.
 * grep (absent or empty filters nothing) matches through eventMatchesGrep, and role is a
 * filter, not a target: an id with no events legitimately yields an empty list, so it does not
 * validate through rejectBadRole (the handleHistory rule). The matched events answer
 * oldest-first as eventFeedItem objects — the same shape the status payload's eventItems carry.
 * Reads the tail through readEvents' stat-keyed cache (no covered byte end, unlike the CLI's
 * follow), so a dashboard search that repeats on an unchanged log — the debounced filter fires
 * one per filter change — costs one stat instead of re-reading and re-parsing the scanned tail.
 * Reads files directly, so it works whether or not the fleet is running. */
export function handleLogs(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const parsed = intQuery(q, res, "n", "non-negative", LOGS_SEARCH_EVENTS);
  if (parsed === null) return;
  const n = Math.min(LOGS_SEARCH_MAX_EVENTS, Math.max(1, parsed));
  const role = q.get("role") || null; // "" and absent both read all loops
  const grep = q.get("grep") || null; // "" and absent both filter nothing
  const needle = grep === null ? null : grep.toLowerCase();
  const events = readEvents(root, n);
  const matched = events.filter(
    (e) => (role === null || eventRole(e) === role) && (needle === null || eventMatchesGrep(e, needle)),
  );
  sendJson(res, 200, { events: matched.map(eventFeedItem) });
}

/** Handle GET /api/tick?role=<id>&tick=N: one tick's full event trail — readTickDetail's
 * TickDetail, the collector `tumwater tick <role> <n>` prints from, plus `text`: the same
 * payload through renderTickDetail, pre-rendered server-side like /api/transcript's lines so
 * the browser shows the CLI's exact rendering instead of re-implementing the event formatting.
 * Serving the shared collector is the point: the CLI and this endpoint cannot drift on what one
 * tick's block contains. The role is a target here, not a filter, so it validates through
 * rejectBadRole (unknown/missing → 400 naming the valid ids); the tick is an explicit count
 * through intQuery (missing or not a positive integer → 400); and a tick the scanned window
 * does not hold — never ran, or rotation ate it — answers 404 with tickNotFoundMessage, the
 * CLI's exact not-found wording,
 * never a crash. Reads files directly, so it works whether or not the fleet is running. */
export async function handleTick(q: URLSearchParams, res: http.ServerResponse, root: string): Promise<void> {
  const role = q.get("role");
  if (rejectBadRole(root, res, role)) return;
  const tick = intQuery(q, res, "tick", "positive");
  if (tick === null) return;
  const detail = readTickDetail(root, role as string, tick);
  if (detail === null) {
    sendJson(res, 404, { error: tickNotFoundMessage(role as string, tick) });
    return;
  }
  sendJson(res, 200, { ...detail, text: renderTickDetail(detail), stat: await tickDetailStat(root, detail) });
}
/** Handle GET /api/role?role=<id>: one loop's inspection payload — rolePayload's object,
 * the same collection behind `tumwater role <id>` — so the drawer's Notebook and Next tick
 * prompt sections render what the CLI shows without re-implementing the assembly. The role
 * is a target here, so it validates through rejectBadRole exactly like /api/transcript and
 * /api/tick (unknown/missing → the shared 400 naming the valid ids and correcting typos);
 * rolePayload is only reached with an id rejectBadRole accepted, so its own unknown-role
 * throw never fires. Reads files directly, so it works whether or not the fleet is running. */
export function handleRole(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role");
  if (rejectBadRole(root, res, role)) return;
  sendJson(res, 200, rolePayload(root, role as string));
}

/** Handle GET /api/prompt-text?file=<name>[&role=<id>]: one queued prompt's editable body —
 * the text an edit replaces, for the dashboard's per-row edit affordance (PLANS.md
 * 2026-10-11). The prompt is addressed by its queue-file basename (the /api/prompt-cancel
 * address), so a stale poll's snapshot can never read the wrong entry; the not-before deferral
 * marker and the `[image attached: …]` reference block are stripped, both plumbing the edit
 * carries over unchanged. The role is optional (absent reads the director's queue) and
 * validates exactly like /api/transcript; a file name failing the shared
 * rejectBadQueueFileName guard is a user-input error answered 400 with nothing read. A
 * vanished file answers 200 { ok: true, status: "gone" } — the loop already dequeued
 * it, which is data for the UI, not a server fault. Reads one file directly, so it works
 * whether or not the fleet is running. */
export function handlePromptText(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const roleParam = q.get("role");
  if (roleParam !== null && rejectBadRole(root, res, roleParam)) return;
  const role = roleParam ?? DIRECTOR_ROLE;
  const file = q.get("file");
  if (rejectBadQueueFileName(res, file)) return;
  const text = readQueuedPromptBody(root, role, file as string);
  if (text === null) {
    okGone(res);
    return;
  }
  sendJson(res, 200, { ok: true, text });
}
/** Handle GET /api/doctor: the same DoctorReport `tumwater doctor --json` prints, so the
 * Settings view's Health check card and the CLI cannot disagree. Read-only — the checks write
 * nothing (runDoctor's own contract) — and it works whether or not the fleet is running. `run`
 * exists so tests can skip the host probes; a throw reaches the server's outer 500. */
export async function handleDoctor(
  res: http.ServerResponse,
  root: string,
  run: (root: string) => Promise<DoctorReport> = (r: string) => runDoctor(r, undefined, undefined, "never"),
): Promise<void> {
  sendJson(res, 200, await run(root));
}
/** Handle GET /api/config: the Settings view's resolved values for exactly
 * EDITABLE_CONFIG_KEYS — read through the same load path `tumwater config get` uses
 * (loadConfigSafe, defaults merged in), so the page shows what the fleet would actually
 * load. A broken or invalid tumwater.json answers 500 with validateConfig's message instead
 * of serving a half-empty panel. */
export function handleConfig(res: http.ServerResponse, root: string): void {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) {
    sendJson(res, 500, { error });
    return;
  }
  const record = config as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_CONFIG_KEYS) out[key] = record[key] ?? null;
  sendJson(res, 200, out);
}
/** Handle GET /api/brief: the brief file's name and the current initial prompt (what
 * `tumwater brief --json` prints), or 404 when no brief carries a prompt block. */
export function handleBrief(res: http.ServerResponse, root: string): void {
  const brief = readBrief(root);
  if (brief === null) return sendJson(res, 404, { error: "no project brief with a prompt block found — run `tumwater init` first" });
  sendJson(res, 200, { file: brief.file, prompt: brief.prompt });
}
