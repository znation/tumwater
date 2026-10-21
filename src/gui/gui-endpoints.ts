/**
 * The dashboard's GET data endpoint handlers (src/gui/gui-server.ts routes to them): transcript,
 * prompt-text, backlog, report, failures, history, run, diff, config — the read-only surface.
 * The POST
 * operator endpoints (prompt, prompt-role, prompt-cancel, prompt-edit, budget, config-set, pause,
 * wake, restart, abort, pause-role) and their body-discipline helpers live in
 * gui/gui-endpoint-commands.ts. Each handler answers its request and touches no socket beyond
 * its own `res`; server lifecycle, routing, the static page, and the token gate stay in
 * gui/gui-server.ts. The domain work itself lives one layer down (transcript.ts, backlog.ts,
 * report-data.ts, src/failure/failure-data.ts, history-data.ts, run-detail-data.ts, config.ts)
 * — this module only adapts HTTP onto it.
 */
import { refusalNote, waitingNote } from "../backlog/backlog-eligibility.js";
import type { BacklogEntry } from "../backlog/backlog-md.js";
import { answeredQuestionEntries, entryMatches, donePlanEntries, fixedBugEntries, openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { runDoctor } from "../doctor/doctor.js";
import type { DoctorReport } from "../doctor/doctor-checks.js";
import { knownRoleIds, loadConfigSafe } from "../config/config.js";
import { runnerEnabled } from "../roles/runner-ids.js";
import { artifactPhrase, previewRetire } from "../operator/retire.js";
import { EDITABLE_CONFIG_KEYS } from "../config/config-editable-keys.js";
import { collectReport, collectReportSince } from "../report/report-data.js";
import { collectFailureReport, collectFailureReportSince } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";
import { renderSinceReportMarkdown } from "../report/report-render.js";
import { REPORT_SINCE_MAX_MS, reportSinceMsg } from "../events/event-window.js";
import { humanSeconds } from "../text/datetime.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, normalizeDiffPath } from "../change/change-data.js";
import { readTranscript } from "../ui/transcript.js";
import { HISTORY_DEFAULT_RUNS, HISTORY_MAX_RUNS, HISTORY_RESULT_FLAG_NAMES, historyClass, parseHistoryResultClass, type HistoryResultClass, readRunRows, readRunRowsSince, summarizeRunRows, summarizeRunRowsByModel, runRowsMatchingGrep, runRowsOnModels, type RunRow } from "../history/history-data.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE, readEventsSince } from "../events/event-window.js";
import { eventRole, readEvents } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { eventFeedItem, eventMatchesGrep } from "../events/event-format.js";
import { readRunDetail, type RunDetail } from "../run/run-detail-data.js";
import {
  renderRunDetail,
  runCommitSha,
  runDetailPatch,
  runDetailStat,
  runMergedSha,
  runNotFoundMessage,
  runTranscriptLines,
} from "../run/run-detail.js";
import { resolveRevertTarget } from "../operator/revert.js";
import { rolePayload } from "../roles/role-view.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { readQueuedPromptBody } from "../inbox/inbox-edit.js";
import { listWideScope, queuedListRows } from "../inbox/inbox.js";
import { clampCount, intQuery, rejectBadQueueFileName, rejectBadRole, sinceMsQuery, untilMsQuery, windowDays } from "./gui-args.js";
import { readBrief } from "../brief/brief.js";
import { badRequest, okGone, sendJson } from "./http-body.js";
import { typoSuffix } from "../text/suggest.js";
import { gotSuffix, splitCommaList, splitCommaListUnique } from "../text/text.js";
import { newestRunNumber, runNotFoundLastMessage } from "../run/run-detail.js";
import type http from "node:http";
/** Handle GET /api/transcript?role=<id>&n=N[&grep=<text>]: rendered transcript lines for a role's
 * pi log (same rendering as `tumwater logs --transcript <id>`). A present `prompt` flag also
 * renders each agent run's prompt, the text `logs --transcript <id> --prompt` prints.
 * Unknown/missing role
 * or a bad n → 400. `grep` keeps only the entries containing the text, case-insensitively, each
 * under its run's separator (the `logs --transcript <id> --grep` rule); `n` bounds the entries
 * scanned.
 * User-defined roles are valid targets too — the GUI marks them with an asterisk, so clicking
 * one must open its transcript: ids validate through rejectBadRole. The 400 message lists
 * exactly the ids accepted. The query arrives pre-parsed — the server parses the target
 * once (gui/gui-server.ts's parseRequestTarget) and threads it down, so the parse idiom lives
 * in one place and cannot disagree with the routing or the token gate about what the URL said. */
export function handleTranscript(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role");
  if (rejectBadRole(root, res, role)) return;
  const n = intQuery(q, res, "n", "positive", 50);
  if (n === null) return;
  const grep = (q.get("grep") ?? "").trim().toLowerCase();
  const includePrompts = q.get("prompt") !== null;
  sendJson(res, 200, {
    lines: readTranscript(root, role as string, n, { includePrompts, grep: grep === "" ? undefined : grep }),
  });
}

/** The /api/backlog `file` values and the open-section reader each addresses — one table so
 * the on-demand dispatch and the "valid values" list in both 400s cannot drift apart. A Map,
 * not an object literal, so no `file` spelling (`constructor`, `toString`, `__proto__`) can
 * reach an inherited member through the lookup. Insertion order is the list order. */
const BACKLOG_FILE_READERS = new Map<string, (root: string) => BacklogEntry[]>([
  ["plans", plannedPlanEntries],
  ["bugs", openBugEntries],
  ["questions", openQuestionEntries],
  ["done", donePlanEntries],
  ["fixed", fixedBugEntries],
  ["answered", (root) => answeredQuestionEntries(root).reverse()],
]);
const BACKLOG_FILE_NAMES = [...BACKLOG_FILE_READERS.keys()];
const BACKLOG_FILE_VALUES = BACKLOG_FILE_NAMES.join(", ");

/** Handle GET /api/backlog?file=<plans|bugs|questions|done|fixed|answered>&index=N: one
 * backlog entry's full text ({title, body}), fetched on demand so multi-KB bodies (long repros,
 * whole plans) never ride the 1-second /api/status poll. index addresses the Nth entry of that
 * file's section in the same order statusPayload lists its titles — plans: PLANS.md ## Planned,
 * bugs: BUGS.md ## Open, questions: QUESTIONS.md ## Open, done: PLANS.md ## Done and fixed:
 * BUGS.md ## Fixed (both newest first, the order of the dashboard's recent rows) and answered:
 * QUESTIONS.md ## Answered, newest first (the file is appended to, so the reverse of file
 * order, unlike done/fixed) — zero-based.
 * Unknown/missing file, missing or bad index, and out-of-range index
 * → 400 JSON error via sendJson.
 * The query arrives pre-parsed (gui/gui-server.ts's parseRequestTarget), like every
 * GET-data handler here. */
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
    badRequest(res, `index ${index} out of range (${file} has ${entries.length} entries)`);
    return;
  }
  sendJson(res, 200, { title: entry.title, body: entry.body, refused: refusalNote(entry.body) !== null, waiting: waitingNote(entry.body) !== null });
}

/** Handle GET /api/backlog-match?grep=<text>: for each /api/backlog `file`, the ascending
 * indexes (the ones /api/backlog?file=…&index=N addresses) whose entry heading or body contains
 * the trimmed text, case-insensitively — the match `tumwater backlog --grep` and the TUI's `/`
 * use — so the dashboard's Search can find text bodies hold without bodies riding the status
 * poll. A `queued` key adds the queued messages whose full text (not only the 80-character
 * preview) contains the text, as `{ role, file }` with the queue-file basename, director first —
 * the match `tumwater prompt --list --grep` uses. Missing or blank grep → 400. */
export function handleBacklogMatch(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const needle = (q.get("grep") ?? "").trim();
  if (!needle) {
    badRequest(res, "grep required");
    return;
  }
  const out: Record<string, number[] | Array<{ role: string; file: string }>> = {};
  for (const [file, reader] of BACKLOG_FILE_READERS) {
    out[file] = reader(root).flatMap((entry, i) => (entryMatches(entry, needle) ? [i] : []));
  }
  const lower = needle.toLowerCase();
  out.queued = queuedListRows(root, null, listWideScope(root))
    .filter((row) => row.text.toLowerCase().includes(lower))
    .map((row) => ({ role: row.role, file: row.file }));
  sendJson(res, 200, out);
}

/** Handle GET /api/diff[?role=<id>]: the unmerged-change view the CLI prints from the same
 * collectors — no `role` → collectTeamChanges (exactly `tumwater diff --json`'s document:
 * `{ mainBranch, roles }`, no per-role patch halves); `?role=<id>` → collectRoleChange (the
 * full per-role view with `diff`/`uncommittedDiff`, `tumwater diff --role <id> --json`). The
 * role is a target, not a filter, so it validates through rejectBadRole exactly like
 * /api/transcript and /api/run (unknown/missing → 400 naming the valid ids) — the same ids
 * `parseRoleFlag` accepts on the CLI, including disabled and user-defined roles. The
 * collectors degrade absent worktrees and missing base branches to their `state` instead of
 * throwing, so a fresh or half-built repo still answers 200. Reads git plumbing directly, so
 * it works whether or not the team is running. `?overlaps=1` serves collectChangeOverlaps
 * (exactly `tumwater diff --overlaps --json`'s `{ mainBranch, state, overlaps }`); with `role` (a
 * comma-separated list, each id validated) it keeps the files a listed role holds, exactly
 * `tumwater diff --overlaps --role <ids> --json`; `&path=<path>` keeps the files at or under that
 * path, exactly `tumwater diff --overlaps --path <path> --json`. `?role=<id>&stat=1` serves both
 * halves as the `git diff --stat` summary, exactly `tumwater diff --role <id> --stat --json`. */
export async function handleDiff(q: URLSearchParams, res: http.ServerResponse, root: string): Promise<void> {
  const rawPath = q.get("path");
  const stat = q.get("stat") !== null;
  if (q.get("overlaps") !== null) {
    if (stat) {
      badRequest(res, "overlaps lists paths, not patches; drop stat");
      return;
    }
    const opath = rawPath === null ? undefined : normalizeDiffPath(rawPath);
    if (opath === null) {
      badRequest(res, "path takes a repo-relative path such as src/cli.ts (as overlaps lists it)");
      return;
    }
    const roles = roleListQuery(q, res, root);
    if (roles === null) return;
    let view = await collectChangeOverlaps(root);
    if (roles !== undefined) view = scopeChangeOverlaps(view, roles);
    if (opath !== undefined) view = scopeChangeOverlapsToPath(view, opath);
    sendJson(res, 200, view);
    return;
  }
  const role = q.get("role");
  if (role === null) {
    if (stat) {
      badRequest(res, "stat needs role (the team roster carries no patch)");
      return;
    }
    if (rawPath !== null) {
      badRequest(res, "path needs role (the team roster carries no patch)");
      return;
    }
    sendJson(res, 200, await collectTeamChanges(root));
    return;
  }
  if (rejectBadRole(root, res, role)) return;
  const path = rawPath === null ? undefined : normalizeDiffPath(rawPath);
  if (path === null) {
    badRequest(res, "path takes a repo-relative path such as src/cli.ts (as overlaps lists it)");
    return;
  }
  sendJson(res, 200, await collectRoleChange(root, role, { ...(path === undefined ? {} : { path }), ...(stat ? { stat: true } : {}) }));
}

/** Parse the `?role=` comma-separated list (each id trimmed, deduplicated, and validated by
 * rejectBadRole; an empty list or unknown id → 400). Returns undefined when `role` is absent and
 * null once a 400 is sent. */
function roleListQuery(q: URLSearchParams, res: http.ServerResponse, root: string): string[] | undefined | null {
  const raw = q.get("role");
  if (raw === null) return undefined;
  const roles = splitCommaListUnique(raw);
  if (roles.length === 0) {
    rejectBadRole(root, res, raw);
    return null;
  }
  for (const r of roles) if (rejectBadRole(root, res, r)) return null;
  return roles;
}

/** Parse and validate the role-scoped, sinceMs-or-days query the report and failures endpoints
 * both take: the `?role=` filter, a comma-separated list (each id trimmed, deduplicated, and
 * validated by rejectBadRole — an unknown id or an empty list → 400 naming it) and, when
 * `?sinceMs=` is present, the trailing-window length (reportSinceMs, which 400s a simultaneous
 * `?days=`). Returns null once a 400 is sent. `sinceMs` is defined exactly when the caller
 * should use the since shape; otherwise it falls through to the days shape with `windowDays(q)`.
 * The one home of that shared scaffolding, so the two endpoints cannot drift on the role rule or
 * the days-vs-sinceMs mutual exclusion (the server twin of reportEndpoint on the GUI client). */
function reportScope(q: URLSearchParams, res: http.ServerResponse, root: string): { roles?: string[]; sinceMs?: number } | null {
  const roles = roleListQuery(q, res, root);
  if (roles === null) return null;
  if (q.get("sinceMs") !== null) {
    const sinceMs = reportSinceMs(q, res);
    if (sinceMs === null) return null;
    return { roles, sinceMs };
  }
  return { roles };
}

/** Handle GET /api/report?days=N[&role=<id>[,<id>...]] or
 * /api/report?sinceMs=<ms>[&untilMs=<ms>][&role=<id>[,<id>...]]: the
 * usage report — the day series (collectReport's ReportData) as JSON the dashboard's report tab
 * charts, or, when sinceMs is set, the trailing-window totals rendered through
 * renderSinceReportMarkdown as { markdown } (the CLI's `report --since` shape). The day window
 * follows windowDays. An absent role is the team-wide report; the listed roles, summed
 * (each id validated by reportScope). Reads files directly, so it works whether or not the team
 * is running. */
export function handleReport(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const scope = reportScope(q, res, root);
  if (scope === null) return;
  const untilMs = untilMsQuery(q, res, scope.sinceMs);
  if (untilMs === null) return;
  if (scope.sinceMs !== undefined) {
    sendJson(res, 200, { markdown: renderSinceReportMarkdown(collectReportSince(root, scope.sinceMs, scope.roles, untilMs)) });
    return;
  }
  sendJson(res, 200, collectReport(root, windowDays(q), scope.roles));
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
  return sinceMsQuery(q, res, REPORT_SINCE_MAX_MS, reportSinceMsg);
}

/** Handle GET /api/failures?days=N[&role=<id>[,<id>...]] or
 * /api/failures?sinceMs=<ms>[&untilMs=<ms>][&role=<id>[,<id>...]]: the
 * same bounded Markdown failure digest the selfcheck role feeds on and `tumwater report
 * --failures` prints, as JSON ({ markdown }) — the dashboard's failures tab renders it; with
 * sinceMs it is the trailing-window digest (collectFailureReportSince) through the same render,
 * the CLI's `report --failures --since` shape. The days window follows windowDays (so it can
 * never drift from /api/report's). role rides the same rule as
 * handleReport: absent → the team digest, present → the validated listed roles, summed. Reads files
 * directly, so it works with no team running. */
export function handleFailures(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const scope = reportScope(q, res, root);
  if (scope === null) return;
  const untilMs = untilMsQuery(q, res, scope.sinceMs);
  if (untilMs === null) return;
  if (scope.sinceMs !== undefined) {
    sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReportSince(root, scope.sinceMs, scope.roles, untilMs)) });
    return;
  }
  sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReport(root, windowDays(q), scope.roles)) });
}

/** Parse `result=<class>[,...]` for /api/run?last and /api/history: the deduplicated classes in
 * first-seen order (`[]` filters nothing), or null after sending the 400 for an unknown class. */
function resultClassesQuery(q: URLSearchParams, res: http.ServerResponse): HistoryResultClass[] | null {
  const classes: HistoryResultClass[] = [];
  const names = Object.values(HISTORY_RESULT_FLAG_NAMES);
  for (const piece of splitCommaList(q.get("result") ?? "")) {
    const cls = parseHistoryResultClass(piece);
    if (cls === null) {
      badRequest(res, `result must be one of ${names.join(", ")}${gotSuffix(piece)}${typoSuffix(piece, names)}`);
      return null;
    }
    if (!classes.includes(cls)) classes.push(cls);
  }
  return classes;
}

/** Handle GET /api/history?role=<id>&n=N[&grep=<text>] — or ?role=<id>&sinceMs=<ms>[&untilMs=<ms>]
 * for a trailing window (untilMs ends it that long ago, via untilMsQuery; without sinceMs → 400):
 * the per-run rows the CLI's `tumwater history` derives from the event log,
 * the dashboard's history tab renders them. The count shape ({ rows }) rides readRunRows (the
 * shared scan, window growth included, so a role-filtered ask on a busy team cannot silently
 * come back short); n is optional: absent → HISTORY_DEFAULT_RUNS; present but not a plain
 * non-negative integer → 400 (the handleBacklog index discipline — an explicit count that does
 * not parse is a client error, unlike the report's degrade-to-default typo rule); then clamped
 * to [1, HISTORY_MAX_RUNS] — the GUI clamps where the CLI fails fast, its established
 * convention. grep is optional: absent or empty filters nothing; present → the rows are
 * filtered through history-data.ts's shared runRowsMatchingGrep rule, the same
 * case-insensitive haystack rule `tumwater history --grep` uses (shared, not
 * re-implemented), after the n/role scan so n bounds the scanned window and not the
 * printed rows — the CLI's rule. The window shape ({ rows, covered, note }) rides
 * readRunRowsSince, the collector behind `history --since`,
 * so the browser and the CLI cannot disagree about the window's rows; a simultaneous n is a
 * rival shape → 400 (the CLI's count-vs-window rule), sinceMs parses and is capped through
 * sinceMsQuery (gui-args.ts, LOGS_SINCE_MAX_MS — the shared `history --since` cap), and note is
 * SPARSE_WINDOW_NOTE when covered is false, else "". role is optional: absent or empty → all
 * roles; present → passed straight through as the role filter with no config validation (a
 * filter is not a target — an id with no runs legitimately yields zero rows), so the endpoint
 * reads nothing but files, like /api/report and /api/failures. Reads files directly, so it
 * present → passed straight through as the role filter with no config validation (a
 * filter is not a target — an id with no runs legitimately yields zero rows), so the endpoint
 * reads nothing but files, like /api/report and /api/failures. summary is optional: absent /
 * empty adds nothing (the response is byte-for-byte today's); present (any value — the flag's
 * mere presence, a bad value ignored like a missing one) adds an additive `summary` folding the
 * exact served rows through the shared summarizeRunRows collector, the same tally
 * `tumwater history --summary` prints, so the dashboard Summary and the table cannot disagree
 * about what a run was. It also adds `modelSummary`, `{ models, total }`, the
 * `history --summary --by model` tally of the same rows. `model=<selector>[,...]` keeps only the
 * runs that started on exactly one of those models (the `history --model` rule), after `grep` and
 * before the summaries fold. `result=<class>[,...]` keeps only the runs in those outcome classes
 * (the `history --result` rule, parsed by resultClassesQuery like /api/run's), after `grep` and
 * before `model`; an unknown class is a 400. Reads files directly, so it works whether
 * or not the team is running. */
export function handleHistory(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role") || null; // "" and absent both read all roles
  const grep = q.get("grep") || null; // "" and absent both filter nothing
  // `model` is a comma list of exact selectors (trimmed, deduplicated); "", absent and a list
  // with no non-empty piece all filter nothing, and an unknown selector keeps no rows.
  const classes = resultClassesQuery(q, res);
  if (classes === null) return;
  const inClasses = (rows: RunRow[]): RunRow[] => (classes.length ? rows.filter((r) => classes.includes(historyClass(r.result))) : rows);
  const modelPieces = splitCommaListUnique(q.get("model") ?? "");
  const onModels = (rows: RunRow[]): RunRow[] => (modelPieces.length ? runRowsOnModels(rows, modelPieces) : rows);
  const summary = q.get("summary") !== null; // the flag's presence, whatever its value
  if (q.get("sinceMs") !== null) {
    if (q.get("n") !== null) {
      badRequest(res, "sinceMs cannot be combined with n (a count and a window are rival shapes)");
      return;
    }
    const sinceMs = sinceMsQuery(q, res, LOGS_SINCE_MAX_MS, (ms) =>
      `sinceMs is capped at ${humanSeconds(LOGS_SINCE_MAX_MS / 1000)} (got ${ms})`);
    if (sinceMs === null) return;
    const untilMs = untilMsQuery(q, res, sinceMs);
    if (untilMs === null) return;
    const { rows, covered } = readRunRowsSince(root, sinceMs, role, untilMs ?? null);
    const matched = onModels(inClasses(grep === null ? rows : runRowsMatchingGrep(rows, grep)));
    sendJson(res, 200, { rows: matched, covered, note: covered ? "" : SPARSE_WINDOW_NOTE, ...(summary ? { summary: summarizeRunRows(matched), modelSummary: summarizeRunRowsByModel(matched) } : {}) });
    return;
  }
  if (untilMsQuery(q, res, undefined) === null) return; // a count has no window end to move
  const parsed = intQuery(q, res, "n", "non-negative", HISTORY_DEFAULT_RUNS);
  if (parsed === null) return;
  const n = clampCount(parsed, HISTORY_MAX_RUNS);
  let rows = readRunRows(root, n, role);
  if (grep !== null) rows = runRowsMatchingGrep(rows, grep);
  rows = onModels(inClasses(rows));
  sendJson(res, 200, summary ? { rows, summary: summarizeRunRows(rows), modelSummary: summarizeRunRowsByModel(rows) } : { rows });
}

/** How many of the log's newest events `GET /api/logs` scans by default, and the most it will
 * scan however large `n` asks: the CLI's `-n` shape (n bounds the scanned tail, not the printed
 * rows), sized so the dashboard's search can reach well past the RECENT_EVENTS window the
 * status poll carries. */
const LOGS_SEARCH_EVENTS = 500;
const LOGS_SEARCH_MAX_EVENTS = 5000;

/** Handle GET /api/logs?n=N|sinceMs=S[&untilMs=U][&grep=<text>][&role=<id>]: a slice of the raw
 * event log scanned from its newest end, filtered with the CLI's own rules and shaped as the
 * activity feed's items. `n` is optional (absent → LOGS_SEARCH_EVENTS) and clamps to [1,
 * LOGS_SEARCH_MAX_EVENTS] after intQuery's non-negative parse (an explicit count that does not
 * parse is a 400, the handleHistory discipline); it bounds the scanned tail, so a matching event
 * older than the last n events is absent — the same scan-then-filter rule `tumwater logs -n N
 * --grep` applies. grep (absent or empty filters nothing) matches through eventMatchesGrep, and
 * role is a filter, not a target: an id with no events legitimately yields an empty list, so it
 * does not validate through rejectBadRole (the handleHistory rule). The matched events answer
 * oldest-first as eventFeedItem objects — the same shape the status payload's eventItems carry.
 * Reads the tail through readEvents' stat-keyed cache (no covered byte end, unlike the CLI's
 * follow), so a dashboard search that repeats on an unchanged log — the debounced filter fires
 * one per filter change — costs one stat instead of re-reading and re-parsing the scanned tail.
 * With `sinceMs` instead of `n` it serves the trailing window's events (readEventsSince, the
 * `logs --since` reader) as { events, covered, note }, the /api/history window shape: sinceMs
 * with n is a 400 (rival shapes), sinceMs parses and is capped through sinceMsQuery at
 * LOGS_SINCE_MAX_MS, the window is not row-capped, and note is SPARSE_WINDOW_NOTE when the log
 * does not reach back that far; untilMs (untilMsQuery) drops the events newer than now −
 * untilMs, and without sinceMs it is a 400.
 * Reads files directly, so it works whether or not the team is running. */
export function handleLogs(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const role = q.get("role") || null; // "" and absent both read all roles
  const grep = q.get("grep") || null; // "" and absent both filter nothing
  const needle = grep === null ? null : grep.toLowerCase();
  const keep = (e: HarnessEvent): boolean =>
    (role === null || eventRole(e) === role) && (needle === null || eventMatchesGrep(e, needle));
  if (q.get("sinceMs") !== null) {
    if (q.get("n") !== null) {
      badRequest(res, "sinceMs cannot be combined with n (a count and a window are rival shapes)");
      return;
    }
    const sinceMs = sinceMsQuery(q, res, LOGS_SINCE_MAX_MS, (ms) =>
      `sinceMs is capped at ${humanSeconds(LOGS_SINCE_MAX_MS / 1000)} (got ${ms})`);
    if (sinceMs === null) return;
    const untilMs = untilMsQuery(q, res, sinceMs);
    if (untilMs === null) return;
    const { cutoff, events: windowEvents, covered } = readEventsSince(root, sinceMs);
    const events = untilMs === undefined ? windowEvents : windowEvents.filter((e) => e.ts < cutoff + sinceMs - untilMs);
    sendJson(res, 200, {
      events: events.filter(keep).map(eventFeedItem),
      covered,
      note: covered ? "" : SPARSE_WINDOW_NOTE,
    });
    return;
  }
  if (untilMsQuery(q, res, undefined) === null) return; // a count has no window end to move
  const parsed = intQuery(q, res, "n", "non-negative", LOGS_SEARCH_EVENTS);
  if (parsed === null) return;
  const n = clampCount(parsed, LOGS_SEARCH_MAX_EVENTS);
  sendJson(res, 200, { events: readEvents(root, n).filter(keep).map(eventFeedItem) });
}

/** handleRun's `transcript` text: the run's transcript lines joined, else the miss note. */
function transcriptText(root: string, role: string, run: number, detail: RunDetail,
  includePrompts: boolean,
  grep: string | undefined,
): string {
  const { found, note } = runTranscriptLines(root, role, run, detail, { includePrompts, grep });
  return found.length > 0 ? found.join("\n") : note;
}
/** Handle GET /api/run?role=<id>&run=N: one run's full event trail — readRunDetail's
 * RunDetail, the collector `tumwater history <role> <n>` prints from, plus `text`: the same
 * payload through renderRunDetail, pre-rendered server-side like /api/transcript's lines so
 * the browser shows the CLI's exact rendering instead of re-implementing the event formatting.
 * Serving the shared collector is the point: the CLI and this endpoint cannot drift on what one
 * run's block contains. The role is a target here, not a filter, so it validates through
 * rejectBadRole (unknown/missing → 400 naming the valid ids); the run is an explicit count
 * through intQuery (missing or not a positive integer → 400); and a run the scanned window
 * does not hold — never ran, or rotation ate it — answers 404 with runNotFoundMessage, the
 * CLI's exact not-found wording,
 * never a crash. `revertSha` is the run's landed commit's full sha when it is on the base branch
 * of a primary checkout that is on it (resolveRevertTarget, the revert cores' own check), else
 * null — the drill-down offers its revert button only when it is set. `hasCommit` says whether
 * the run pinned a commit (runCommitSha), for the "Show patch" button; `patch` — the same text
 * `history --patch` prints — is added only when the `patch` flag is present, whatever its
 * value, so the default expand costs no extra `git show`. `transcript`, likewise flag-gated, is
 * the text `history --transcript` prints (runTranscriptLines: the found lines joined, else its
 * note), so the default expand reads no pi log; a present `prompt` flag also renders each agent
 * run's prompt, the text `history --transcript --prompt` prints. A non-blank `grep` (with
 * `transcript`) keeps only the entries containing the text, case-insensitively, each under its
 * agent run's separator, the text `history --transcript --grep` prints, or its miss note. Reads
 * files directly, so it works whether or not the team is running.
 *
 * A present `last` flag replaces `run` with the role's newest completed run, the one
 * `tumwater history <role> --last` opens (newestRunNumber, shared): `result` (a comma list of
 * outcome classes) and `model` (a comma list of selectors) narrow it to the newest run in those
 * classes or on those models, an absent or empty value filtering nothing. `last` with `run`, and
 * `result`/`model` without `last`, are 400s; a class that is not one is a 400 worded like the
 * CLI's; no match answers 404 with runNotFoundLastMessage. The payload is the numbered form's,
 * the resolved number in `run`. */
export async function handleRun(q: URLSearchParams, res: http.ServerResponse, root: string): Promise<void> {
  const role = q.get("role");
  if (rejectBadRole(root, res, role)) return;
  let run: number | null;
  if (q.get("last") === null) {
    if (q.get("result") !== null) return badRequest(res, "result needs last");
    if (q.get("model") !== null) return badRequest(res, "model needs last");
    run = intQuery(q, res, "run", "positive");
    if (run === null) return;
  } else {
    if (q.get("run") !== null) return badRequest(res, "last cannot be combined with run (a number and the newest run are rival selectors)");
    const classes = resultClassesQuery(q, res);
    if (classes === null) return;
    const models = splitCommaListUnique(q.get("model") ?? "");
    const classFilter = classes.length ? classes : null;
    const modelFilter = models.length ? models : null;
    run = newestRunNumber(root, role as string, classFilter, modelFilter);
    if (run === null) {
      sendJson(res, 404, { error: runNotFoundLastMessage(role, classFilter, modelFilter) });
      return;
    }
  }
  const detail = readRunDetail(root, role as string, run);
  if (detail === null) {
    sendJson(res, 404, { error: runNotFoundMessage(role as string, run) });
    return;
  }
  const grep = (q.get("grep") ?? "").trim();
  const mergedAs = runMergedSha(detail);
  const target = mergedAs === null ? null : await resolveRevertTarget(root, mergedAs);
  sendJson(res, 200, {
    ...detail,
    text: renderRunDetail(detail),
    stat: await runDetailStat(root, detail),
    revertSha: target?.ok ? target.full : null,
    hasCommit: runCommitSha(detail) !== null,
    ...(q.get("patch") !== null ? { patch: await runDetailPatch(root, detail) } : {}),
    ...(q.get("transcript") !== null ? { transcript: transcriptText(root, role as string, run, detail, q.get("prompt") !== null, grep === "" ? undefined : grep) } : {}),
  });
}
/** Handle GET /api/role?role=<id>: one role's inspection payload — rolePayload's object,
 * the same collection behind `tumwater role <id>` — so the drawer's Notes and Next run
 * prompt sections render what the CLI shows without re-implementing the assembly. The role
 * is a target here, so it validates through rejectBadRole exactly like /api/transcript and
 * /api/run (unknown/missing → the shared 400 naming the valid ids and correcting typos);
 * rolePayload is only reached with an id rejectBadRole accepted, so its own unknown-role
 * throw never fires. Reads files directly, so it works whether or not the team is running. */
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
 * vanished file answers 200 { ok: true, status: "gone" } — the role already dequeued
 * it, which is data for the UI, not a server fault. Reads one file directly, so it works
 * whether or not the team is running. */
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
 * nothing (runDoctor's own contract) — and it works whether or not the team is running. `run`
 * exists so tests can skip the host probes; it never probes images ("never") — the explicit
 * re-probe is POST /api/doctor-reprobe; a throw reaches the server's outer 500. */
export async function handleDoctor(
  res: http.ServerResponse,
  root: string,
  run: (root: string) => Promise<DoctorReport> = (r: string) => runDoctor(r, undefined, undefined, "never"),
): Promise<void> {
  sendJson(res, 200, await run(root));
}
/** Handle GET /api/config: the Settings view's resolved values for exactly
 * EDITABLE_CONFIG_KEYS — read through the same load path `tumwater config get` uses
 * (loadConfigSafe, defaults merged in), so the page shows what the team would actually
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
/** Handle GET /api/retire: the Settings view's "Disabled roles" card — every configured,
 * disabled, non-director role, with what `tumwater retire` would remove (previewRetire, so the
 * rails and wording are the CLI's) and the rails' objections. `wouldRemove` is empty when there
 * is nothing to retire (a role disabled with a clean checkout), so the card can also re-enable
 * a role via POST /api/role-enable. Read-only (previewRetire's contract) and works whether or
 * not the team runs; a throw reaches the server's outer 500, an unreadable tumwater.json
 * answers 500 like /api/config. */
export async function handleRetireList(res: http.ServerResponse, root: string): Promise<void> {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) {
    sendJson(res, 500, { error });
    return;
  }
  const roles = [];
  for (const role of knownRoleIds(config).filter((id) => id !== DIRECTOR_ROLE && !runnerEnabled(config, id))) {
    const { wouldRemove, objections } = await previewRetire(root, role);
    roles.push({ role, wouldRemove, phrases: wouldRemove.map((a) => artifactPhrase(a, role)), objections });
  }
  sendJson(res, 200, { roles });
}
/** Handle GET /api/brief: the brief file's name and the current brief text (what
 * `tumwater brief --json` prints), or 404 when no brief carries a prompt block. */
export function handleBrief(res: http.ServerResponse, root: string): void {
  const brief = readBrief(root);
  if (brief === null) return sendJson(res, 404, { error: "no project brief with a prompt block found — run `tumwater init` first" });
  sendJson(res, 200, { file: brief.file, prompt: brief.prompt });
}
