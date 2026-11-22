/** The read-only render of the GitHub-issues mirror for the `tumwater issues` command. The
 * mirror ledger (.tumwater/state/github-issues.json, written by the post-merge scan in
 * src/github/issue-scan.ts and the closer in src/github/issue-close.ts) records what the last
 * scan saw on GitHub and what tumwater did about each issue; this module turns it into terminal
 * text — a header naming the repo, branch, scan age and open count, then every open issue with
 * its trust, mirror state and age — so an operator can answer "which issues did the team see, and
 * why was this one left alone?" without opening the JSON or calling `gh`
 * (plans/github-issues.md invariant 2: `gh` is called only by the scan and the doctor's check).
 *
 * Pure over its inputs (no I/O, no clock: `now` is passed in), so every branch is unit-tested
 * against a hand-built ledger. */

import { plural } from "../text/phrases.js";
import { squash } from "../text/text.js";
import { humanAgo } from "../text/datetime.js";
import type { GithubIssueRow, GithubIssuesLedger } from "./github-issues-state.js";

/** The list view's title width: titles are untrusted one-liners from GitHub, so the list
 * squashes them the way the quarantine view squashes test paths; --show prints the whole value. */
const ISSUE_TITLE_WIDTH = 80;

/** One open issue as the command reads it: the ledger's own row plus tumwater's state for that
 * number, folded in from the ledger's optional maps, and positioned 1..N in the order the list
 * prints (issue number ascending). */
export interface IssueRow extends GithubIssueRow {
  position: number;
  /** The scan queued a task for this issue at this time. */
  queuedAt?: number;
  /** The scan declined this issue at this time, for `reason`. */
  declinedAt?: number;
  /** Why the scan declined it, present with `declinedAt`. */
  reason?: string;
  /** A tumwater change closed this issue in this commit. */
  fixedIn?: string;
  /** GitHub closed this issue at this time, from these shas (a reopened issue keeps it). */
  closed?: { at: number; shas: string[] };
  /** The shas whose fixes for this issue have landed but not been pushed. */
  waitingPush?: string[];
  /** Every BUGS.md/PLANS.md entry mirroring this issue is retired. */
  retiredOnly?: boolean;
}

/** The header's facts, taken straight from the ledger. */
export interface IssuesHeader {
  repo: string;
  branch: string;
  checkedAt: number;
  gh: GithubIssuesLedger["gh"];
  reason?: string;
}

/** The ledger's open issues as positioned rows: the ledger's `open` list sorted by issue number
 * ascending, numbered 1..N, each with the state the ledger's optional maps hold for its number —
 * `queued`, `declined` (with its reason), `fixedIn` (with its sha), `closed` (with its time and
 * shas), `waitingPush` (with its shas) and membership in `retiredOnly`. Position addressing and
 * the detail view both read this one function, so they can never disagree on which issue
 * position N denotes. */
export function issueRows(ledger: GithubIssuesLedger): IssueRow[] {
  // A hand-edited or foreign-generation ledger can hold no `open` list at all; the command then
  // reads an empty mirror rather than throwing out of the CLI, the way loadQuarantine reads a
  // malformed quarantine file as the empty list.
  return [...(Array.isArray(ledger.open) ? ledger.open : [])]
    .sort((a, b) => a.number - b.number)
    .map((row, i) => foldIssueState(row, i + 1, ledger));
}

function foldIssueState(row: GithubIssueRow, position: number, ledger: GithubIssuesLedger): IssueRow {
  const key = String(row.number);
  const declined = ledger.declined?.[key];
  const fixedIn = ledger.fixedIn?.[key];
  const closed = ledger.closed?.[key];
  const waitingPush = ledger.waitingPush?.[key];
  const queued = ledger.queued?.[key];
  return {
    ...row,
    position,
    ...(queued ? { queuedAt: queued.at } : {}),
    ...(declined ? { declinedAt: declined.at, reason: declined.reason } : {}),
    ...(fixedIn ? { fixedIn: fixedIn.sha } : {}),
    ...(closed ? { closed } : {}),
    ...(waitingPush && waitingPush.length > 0 ? { waitingPush } : {}),
    ...((ledger.retiredOnly ?? []).includes(row.number) ? { retiredOnly: true } : {}),
  };
}

/** The rows with only the issues whose number or title contains `pattern` (case-insensitively; a
 * numeric pattern also matches the number exactly), each kept row keeping its whole-list
 * `position` — the same rule `grepQuarantineRows` keeps for `quarantine --show`, so `--grep`
 * narrows what an operator reads without shifting the numbers `--show` addresses. */
export function grepIssueRows(rows: readonly IssueRow[], pattern: string): IssueRow[] {
  const needle = pattern.toLowerCase();
  return rows.filter((r) => String(r.number).includes(pattern) || r.title.toLowerCase().includes(needle));
}

/** Resolve what position N names in the ledger, by the same issue-number order `issueRows` uses.
 * Returns null below 1 and past the end of the list. */
export function issueRowAt(ledger: GithubIssuesLedger, position: number): IssueRow | null {
  if (position < 1) return null;
  return issueRows(ledger)[position - 1] ?? null;
}

/** The header a command prints for a ledger: its repo, branch, scan time and `gh` gate state,
 * with the probe's reason only when the probe was not ok (a ledger that carries a reason while
 * `gh` is ok names nothing extra). */
export function issuesHeader(ledger: GithubIssuesLedger): IssuesHeader {
  return {
    repo: ledger.repo,
    branch: ledger.branch,
    checkedAt: ledger.checkedAt,
    gh: ledger.gh,
    ...(ledger.gh !== "ok" && ledger.reason ? { reason: ledger.reason } : {}),
  };
}

/** The ledger as the `tumwater issues` list: a header naming the repo, branch, open count and how
 * long ago the scan ran, then one line per open issue naming its number, squashed title,
 * trusted/untrusted, mirrored/not mirrored and its age. A ledger whose `gh` probe was not ok adds
 * one line naming that state (and its reason when present), since that is why a scan found nothing
 * when GitHub was unreachable — the read itself never depends on a working `gh`. */
export function renderIssues(rows: readonly IssueRow[], header: IssuesHeader, now: number): string {
  const lines = [
    `github issues — ${header.repo} (${header.branch}): ` +
      // plural's `many` form stays "open": the count qualifies the adjective, so the plural
      // marker would land on the noun the header leaves implicit ("3 open issues").
      `${plural(rows.length, "open", "open")}, checked ${humanAgo(header.checkedAt, now)}`,
  ];
  if (header.gh !== "ok") lines.push(`gh ${header.gh}${header.reason ? `: ${squash(header.reason, ISSUE_TITLE_WIDTH)}` : ""}`);
  if (rows.length === 0) return lines.join("\n");
  for (const r of rows) {
    lines.push(
      `${r.position}. #${r.number} — ${squash(r.title, ISSUE_TITLE_WIDTH)} — ` +
        `${r.trusted ? "trusted" : "untrusted"}, ${r.mirrored ? "mirrored" : "not mirrored"}, ${issueAge(r, now)}`,
    );
  }
  return lines.join("\n");
}

/** The issue's own age, from the `updatedAt` GitHub reported. A ledger row whose timestamp GitHub
 * did not supply (or a hand-edited one that is not a date) has no age to name, so the row says so
 * rather than printing `NaN`. */
function issueAge(row: GithubIssueRow, now: number): string {
  const at = Date.parse(row.updatedAt);
  return Number.isNaN(at) ? "updated unknown" : `updated ${humanAgo(at, now)}`;
}

/** One issue as the `tumwater issues --show <n>` detail, the read-only twin of
 * `renderQuarantineDetail`: the whole title unsquashed, the url, the author and its
 * `authorAssociation`, its labels, `updated <ISO time>`, then tumwater's own state for that
 * issue — `queued <ago>`, `declined <ago>: <reason>`, `fixed by <sha>`, `closed <ago>`,
 * `waiting for a push of <shas>`, or `every mirroring entry is retired` — and the body excerpt
 * when the ledger holds one. Every state line prints only when the ledger holds that state, so a
 * plain open issue names none of them. */
export function renderIssueDetail(row: IssueRow, position: number, now: number): string {
  const lines = [
    `issue ${position}: #${row.number} — ${row.title}`,
    `  url: ${row.url}`,
    `  author: ${row.author}${row.authorAssociation ? ` (${row.authorAssociation})` : ""}`,
    `  labels: ${row.labels.length > 0 ? row.labels.join(", ") : "none"}`,
    `  updated: ${row.updatedAt}`,
  ];
  for (const state of issueStateLines(row, now)) lines.push(`  ${state}`);
  if (row.bodyExcerpt) lines.push("  body excerpt:", ...row.bodyExcerpt.split("\n").map((l) => `    ${l}`));
  return lines.join("\n");
}

// tumwater's state for one issue, one line per state the ledger holds. `closed` comes before the
// live states because a reopened issue is the case where both hold: the ledger records the close
// and the scan lists the issue again.
function issueStateLines(row: IssueRow, now: number): string[] {
  const lines: string[] = [];
  if (row.closed) lines.push(`closed ${humanAgo(row.closed.at, now)}${row.closed.shas.length > 0 ? `: ${row.closed.shas.join(", ")}` : ""}`);
  if (row.fixedIn) lines.push(`fixed by ${row.fixedIn}`);
  if (row.waitingPush) lines.push(`waiting for a push of ${row.waitingPush.join(", ")}`);
  if (row.queuedAt !== undefined) lines.push(`queued ${humanAgo(row.queuedAt, now)}`);
  if (row.declinedAt !== undefined) lines.push(`declined ${humanAgo(row.declinedAt, now)}${row.reason ? `: ${row.reason}` : ""}`);
  if (row.retiredOnly) lines.push("every mirroring entry is retired");
  return lines;
}

/** The structured JSON document `tumwater issues --json` serves: the ledger's facts a script reads
 * instead of parsing text — the repo, branch, scan time and `gh` gate state (with its reason when
 * the probe was not ok), and the positioned rows with their folded state. */
export function issuesJson(rows: readonly IssueRow[], header: IssuesHeader): Record<string, unknown> {
  return {
    read: true,
    repo: header.repo,
    branch: header.branch,
    checkedAt: header.checkedAt,
    gh: header.gh,
    ...(header.reason ? { reason: header.reason } : {}),
    issues: rows,
  };
}
