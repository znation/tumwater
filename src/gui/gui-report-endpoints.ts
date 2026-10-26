/**
 * The dashboard's GET report and failures handlers (src/gui/gui-server.ts routes to them):
 * report and failures. Each answers its request and touches no socket beyond its own `res`;
 * the domain work lives one layer down (report/report-data.ts, failure/failure-data.ts), so
 * this module only adapts HTTP onto it. Barrelled into gui/gui-endpoints.ts beside the other
 * per-family GET endpoint modules.
 */
import { collectReport, collectReportSince } from "../report/report-data.js";
import { collectFailureReport, collectFailureReportSince } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";
import { renderSinceReportMarkdown } from "../report/report-render.js";
import { loadQuarantine } from "../review/known-flakes.js";
import { quarantineRows, quarantineViewRows, type QuarantineViewRow } from "../review/quarantine-render.js";
import { quarantineWarning } from "../baseline/main-guardrails.js";
import { REPORT_SINCE_MAX_MS, reportSinceMsg } from "../events/event-window.js";
import { roleListQuery, sinceMsQuery, untilMsQuery, windowDays } from "./gui-args.js";
import { badRequest, sendJson } from "./gui-http-body.js";
import type http from "node:http";
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
/** Handle GET /api/failures?days=N[&role=<id>[,<id>...]] or
 * /api/failures?sinceMs=<ms>[&untilMs=<ms>][&role=<id>[,<id>...]]: the
 * same bounded Markdown failure digest the selfcheck role feeds on and `tumwater report
 * --failures` prints, as JSON ({ markdown }) — the dashboard's failures tab renders it; with
 * sinceMs it is the trailing-window digest (collectFailureReportSince) through the same render,
 * the CLI's `report --failures --since` shape. The response also carries `quarantine` —
 * `{ warning, rows }` (quarantineViewRows over the current loadQuarantine list, an empty
 * rows list when it is empty) the Failures view's card paints below the digest — the interactive
 * twin of `tumwater quarantine --release <n>` (each row's Release button posts to
 * POST /api/quarantine-release), current rather than window- or role-scoped. The digest's
 * `markdown` is unchanged. The days window follows windowDays (so it can
 * never drift from /api/report's). role rides the same rule as
 * handleReport: absent → the team digest, present → the validated listed roles, summed. Reads files
 * directly, so it works with no team running. */
export function handleFailures(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const scope = reportScope(q, res, root);
  if (scope === null) return;
  const untilMs = untilMsQuery(q, res, scope.sinceMs);
  if (untilMs === null) return;
  const rows = quarantineRows(loadQuarantine(root));
  const quarantine: { warning: string | null; rows: QuarantineViewRow[] } = { warning: quarantineWarning(rows, Date.now()), rows: quarantineViewRows(rows, Date.now()) };
  if (scope.sinceMs !== undefined) {
    sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReportSince(root, scope.sinceMs, scope.roles, untilMs)), quarantine });
    return;
  }
  sendJson(res, 200, { markdown: renderFailureMarkdown(collectFailureReport(root, windowDays(q), scope.roles)), quarantine });
}
