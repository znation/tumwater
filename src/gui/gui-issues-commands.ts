/**
 * The dashboard's GitHub-issues mirror endpoints (barrelled into
 * src/gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts):
 * GET /api/issues answers the mirror ledger — the browser twin of `tumwater issues` — and
 * GET /api/issues-show?position=<n> answers one issue's whole detail, the twin of
 * `tumwater issues --show <n>`. The
 * dashboard's Settings "GitHub issues" card renders it, so an operator watching the team can see
 * which issues the mirror listed, which it mirrored, and what tumwater did about each without
 * leaving the browser. Like the CLI read it is strictly local: it reads
 * .tumwater/state/github-issues.json through readGithubIssues and never calls `gh`
 * (plans/github-issues.md invariant 2 names the scan and the doctor's check as `gh`'s only
 * callers). The rows, the header counts and the state filter all come from the render module the
 * CLI uses (issueRows, issuesHeader, stateIssueRows, grepIssueRows, issuesJson), so the two
 * front ends cannot number the list differently or divide open from closed differently, and the
 * reply carries the whole mirror's counts beside any filtered `issues` list (INV-DE3).
 */
import {
  grepIssueRows,
  ISSUE_STATES,
  isIssueState,
  issueAtPosition,
  issueRows,
  issuesHeader,
  issuesJson,
  renderIssueDetail,
  stateIssueRows,
} from "../github/github-issues-render.js";
import type { IssueState } from "../github/github-issues-render.js";
import { readGithubIssues } from "../github/github-issues-state.js";
import { oneOfMessage } from "../text/suggest.js";
import { badRequest, sendJson } from "./gui-http-body.js";
import { intQuery } from "./gui-args.js";
import type http from "node:http";

/** The document GET /api/issues answers when the mirror has never been read (or its file is
 * unreadable): a state, not an empty list — `read: false` with `empty: true`, the zero counts the
 * card's header needs, and no `repo`/`branch`, because resolving a remote is the CLI's job
 * (`cmdIssues`' `issuesTarget`) and this endpoint deliberately reports only what the ledger holds.
 * `issuesHeader` takes a ledger, not null, so it is never called on this path. */
function noLedgerBody(state: IssueState | null): Record<string, unknown> {
  return {
    read: false,
    empty: true,
    openCount: 0,
    closedCount: 0,
    upstreamClosedCount: 0,
    issues: [],
    ...(state !== null ? { state } : {}),
  };
}

/** Handle GET /api/issues: the mirror ledger as `tumwater issues --json` serves it — `read`,
 * `repo`, `branch`, `checkedAt`, `gh` (`ok`/`missing`/`unauthenticated`/`error`), an optional
 * `reason`, and the positioned `issues` — plus the whole mirror's `openCount`, `closedCount` and
 * `upstreamClosedCount` (taken from `issuesHeader`, never from the kept rows, the rule INV-DE3
 * pins) and `empty`, true
 * exactly when there is no ledger to read.
 *
 * Two optional query parameters narrow the `issues` list only, each through the same function the
 * CLI's flag uses: `state=open|closed|lost` through `stateIssueRows` (the `--open`/`--closed`/
 * `--lost` twin — the accepted values are `ISSUE_STATES`, so no state can reach the CLI's
 * filter and be refused here; any other value answers 400 `state must be one of open, closed,
 * lost (got "<raw>")` with no list sent), and `q` through `grepIssueRows` (the `--grep` twin, a raw
 * substring of the number or title).
 * Both filters run in the CLI's order, and every kept row still carries its whole-list
 * `position`, so `?state=closed` still numbers a closed issue by its position in the full list.
 * The endpoint never writes: it creates no ledger and touches no state. */
export function handleIssuesList(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const rawState = q.get("state");
  let state: IssueState | null = null;
  if (rawState !== null) {
    if (!isIssueState(rawState)) {
      badRequest(res, `state ${oneOfMessage(ISSUE_STATES)(rawState)}`);
      return;
    }
    state = rawState;
  }
  const ledger = readGithubIssues(root);
  if (ledger === null) {
    sendJson(res, 200, noLedgerBody(state));
    return;
  }
  const header = issuesHeader(ledger);
  let kept = issueRows(ledger);
  const pattern = q.get("q");
  if (pattern !== null) kept = grepIssueRows(kept, pattern);
  if (state !== null) kept = stateIssueRows(kept, state);
  sendJson(res, 200, {
    ...issuesJson(kept, header),
    openCount: header.openCount,
    closedCount: header.closedCount,
    upstreamClosedCount: header.upstreamClosedCount,
    empty: false,
    ...(state !== null ? { state } : {}),
  });
}

/** Handle GET /api/issues-show?position=<n>: the Nth issue of the whole mirror list, the browser
 * twin of `tumwater issues --show <n>` and the read the Settings card's per-row View button calls.
 * The position is `intQuery`'s positive-integer rule, so a missing or malformed one is the shared
 * 400 (`position required`, `position must be a positive integer (got "x")`). The numbering and
 * the miss sentence come from the render module's `issueAtPosition`, the same rule `cmdIssuesShow`
 * states, so position N names the same issue on both surfaces whatever filters the list request
 * happened to carry (INV-DE6). A position the list does not hold answers 200 `{ ok: false,
 * message }` — the shape the salvage show endpoint answers for the same case — so the card shows
 * that sentence in the row rather than an empty panel. A hit answers `{ position, number, title,
 * text }`, where `text` is `renderIssueDetail`'s output verbatim: the state lines and ages are the
 * CLI's own words, not a browser-side paraphrase, and the whole body excerpt reaches the browser
 * inside it. Like the list endpoint this reads only the ledger file — no `gh` call, no write, and
 * no file created when the mirror has never been read. */
export function handleIssuesShow(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const position = intQuery(q, res, "position", "positive");
  if (position === null) return;
  const at = issueAtPosition(readGithubIssues(root), position);
  if ("message" in at) {
    sendJson(res, 200, { ok: false, message: at.message });
    return;
  }
  sendJson(res, 200, {
    position,
    number: at.row.number,
    title: at.row.title,
    text: renderIssueDetail(at.row, position, Date.now()),
  });
}
