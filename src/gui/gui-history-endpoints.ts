/**
 * The dashboard's GET run/event-log drill-down handlers (src/gui/gui-server.ts routes to them):
 * transcript, history, logs, run, and role. Each answers its request and touches no socket
 * beyond its own `res`; the domain work lives one layer down (ui/transcript.ts,
 * history/history-data.ts, run/run-detail-data.ts, events/event-read.ts), so this module only
 * adapts HTTP onto it. Barrelled into gui/gui-endpoints.ts beside the other per-family GET
 * endpoint modules.
 */
import { humanSeconds } from "../text/datetime.js";
import { readTranscript } from "../ui/transcript.js";
import {
  HISTORY_DEFAULT_RUNS,
  HISTORY_MAX_RUNS,
  HISTORY_RESULT_FLAG_NAMES,
  historyClass,
  parseHistoryResultClass,
  type HistoryResultClass,
  readRunRows,
  readRunRowsSince,
  summarizeRunRows,
  summarizeRunRowsByModel,
  runRowsMatchingGrep,
  runRowsOnModels,
  type RunRow,
} from "../history/history-data.js";
import { LOGS_SINCE_MAX_MS, SPARSE_WINDOW_NOTE, readEventsSince } from "../events/event-window.js";
import { eventRole, readEvents } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { eventFeedItem, eventMatchesGrep } from "../events/event-format.js";
import { readRunDetail, type RunDetail, runCommitSha, runMergedSha } from "../run/run-detail-data.js";
import { renderRunDetail, runDetailPatch, runDetailStat, runTranscriptLines } from "../run/run-detail-render.js";
import { resolveRevertTarget } from "../operator/revert.js";
import { rolePayload } from "../roles/role-view.js";
import { clampCount, intQuery, rejectBadRole, sinceMsQuery, untilMsQuery } from "./gui-args.js";
import { badRequest, sendJson } from "./http-body.js";
import { typoSuffix } from "../text/suggest.js";
import { gotSuffix, splitCommaList, splitCommaListUnique } from "../text/text.js";
import { newestRunRow, runNotFoundLastMessage, runNotFoundMessage } from "../run/run-detail.js";
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

/** Parse the `sinceMs`-window prologue the two history endpoints share. A present `sinceMs`
 * (with no rival `n`) yields `{ kind: "window", sinceMs, untilMs }`; an absent `sinceMs`
 * yields `{ kind: "count" }`. Any 400 — the rival-shapes rejection when both `sinceMs` and
 * `n` are present, or a `sinceMs`/`untilMs` that fails to parse or caps (sinceMsQuery,
 * untilMsQuery) — is already sent and yields null, so the caller returns early. Shared by
 * handleHistory and handleLogs so the rival-shapes message and the parse-and-cap discipline
 * cannot drift. */
function windowOrCount(q: URLSearchParams, res: http.ServerResponse):
  | { kind: "window"; sinceMs: number; untilMs?: number }
  | { kind: "count" }
  | null {
  if (q.get("sinceMs") !== null) {
    if (q.get("n") !== null) {
      badRequest(res, "sinceMs cannot be combined with n (a count and a window are rival shapes)");
      return null;
    }
    const sinceMs = sinceMsQuery(q, res, LOGS_SINCE_MAX_MS, (ms) =>
      `sinceMs is capped at ${humanSeconds(LOGS_SINCE_MAX_MS / 1000)} (got ${ms})`);
    if (sinceMs === null) return null;
    const untilMs = untilMsQuery(q, res, sinceMs);
    if (untilMs === null) return null;
    return { kind: "window", sinceMs, untilMs };
  }
  if (untilMsQuery(q, res, undefined) === null) return null; // a count has no window end to move
  return { kind: "count" };
}

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
  const windowCtl = windowOrCount(q, res);
  if (windowCtl === null) return;
  if (windowCtl.kind === "window") {
    const { sinceMs, untilMs } = windowCtl;
    const { rows, covered } = readRunRowsSince(root, sinceMs, role, untilMs ?? null);
    const matched = onModels(inClasses(grep === null ? rows : runRowsMatchingGrep(rows, grep)));
    sendJson(res, 200, { rows: matched, covered, note: covered ? "" : SPARSE_WINDOW_NOTE, ...(summary ? { summary: summarizeRunRows(matched), modelSummary: summarizeRunRowsByModel(matched) } : {}) });
    return;
  }
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
  const windowCtl = windowOrCount(q, res);
  if (windowCtl === null) return;
  if (windowCtl.kind === "window") {
    const { sinceMs, untilMs } = windowCtl;
    const { cutoff, events: windowEvents, covered } = readEventsSince(root, sinceMs);
    const events = untilMs === undefined ? windowEvents : windowEvents.filter((e) => e.ts < cutoff + sinceMs - untilMs);
    sendJson(res, 200, {
      events: events.filter(keep).map(eventFeedItem),
      covered,
      note: covered ? "" : SPARSE_WINDOW_NOTE,
    });
    return;
  }
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
 * `tumwater history <role> --last` opens (newestRunRow, shared): `result` (a comma list of
 * outcome classes) and `model` (a comma list of selectors) narrow it to the newest run in those
 * classes or on those models, an absent or empty value filtering nothing. `last` with `run`, and
 * `result`/`model` without `last`, are 400s; a class that is not one is a 400 worded like the
 * CLI's; no match answers 404 with runNotFoundLastMessage. The payload is the numbered form's,
 * the resolved number in `run`. With no `role`, `last` opens the newest completed run of any role
 * (newestRunRow with a null role, the run bare `tumwater history --last` opens), and the
 * payload's `role` is that run's; `result`/`model` narrow it the same way, and a miss is a 404
 * worded for any role. */
export async function handleRun(q: URLSearchParams, res: http.ServerResponse, root: string): Promise<void> {
  let role = q.get("role");
  const bareLast = role === null && q.get("last") !== null;
  if (!bareLast && rejectBadRole(root, res, role)) return;
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
    const row = newestRunRow(root, role, classFilter, modelFilter);
    if (row !== null) role = row.role;
    run = row?.run ?? null;
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
