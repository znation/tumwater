/** The GitHub issues ledger (plans/github-issues.md, State): the one file the hourly scan writes
 * and the GUI (`tumwater issues` and the dashboard's `GET /api/issues`, through
 * src/gui/gui-issues-commands.ts `handleIssuesList`) and `tumwater status` read. The scan owns
 * repo, branch, checkedAt, gh, reason and
 * open. The `queued`, `declined`, `fixedIn`, `closed`, `waitingPush` and `retiredOnly` records the
 * queue, outcome and close steps write stay in the file, so a rewrite by the scan never drops
 * them. */

import { ensureParentDir } from "../files/files.js";
import { isJsonObject } from "../files/json-object.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject } from "../files/json-object.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { githubIssuesPath } from "../paths.js";
import { DAY_MS, humanAgo } from "../text/datetime.js";

/** What the last scan learned from `gh`: `ok` when it read the issues, `missing` or
 * `unauthenticated` from the readiness probe, `error` when the listing itself failed. */
export type GhState = "ok" | "missing" | "unauthenticated" | "error";

/** One open issue as the scan recorded it. Only a trusted issue keeps a `bodyExcerpt`, capped so a
 * director prompt built from it stays under its size cap; an untrusted issue's text is never
 * queued (decision 4). */
export interface GithubIssueRow {
  number: number;
  title: string;
  url: string;
  author: string;
  /** A maintainer stands behind it: author association OWNER, MEMBER or COLLABORATOR, or the
   * mirror label, or `githubIssues.authors` set to "anyone". */
  trusted: boolean;
  /** The author's GitHub association (OWNER, MEMBER, COLLABORATOR…), shown in a director prompt's
   * preamble so the director knows who reported the issue. Absent for an issue GitHub did not
   * name one for. */
  authorAssociation?: string;
  /** Some backlog entry, open or finished, carries `mirrors GitHub issue #<n>` for it. */
  mirrored: boolean;
  labels: string[];
  updatedAt: string;
  bodyExcerpt?: string;
  /** The instant (epoch ms) the last listing that still saw this issue open observed it — the
   * clock on `tumwater issues`' "last seen open" phrase for a row in the ledger's
   * `upstreamClosed` list. Absent on every other list's rows: only an issue GitHub closed
   * upstream while the ledger held it open has a last-seen-open instant to show. */
  closedAt?: number;
}

export interface GithubIssuesLedger {
  repo: string;
  branch: string;
  /** The epoch milliseconds of the scan that wrote this record. */
  checkedAt: number;
  gh: GhState;
  /** Why `gh` is not `ok`, when it is not. */
  reason?: string;
  open: GithubIssueRow[];
  /** Open issues whose every mirroring entry was retired: listed, never closed (part 5/5). */
  retiredOnly?: number[];
  /** Issues tumwater closed, by issue number: when, and the fix shas the close cited. */
  closed?: Record<string, { at: number; shas: string[] }>;
  /** The rows of the issues tumwater closed, kept beside `closed` so the `tumwater issues` read can
   * still name what it closed — its `closed` marker alone carries no title, url or body. The closer
   * writes it (src/github/issue-close.ts `closeOne`), holding its `updatedAt` at the close instant,
   * and trims it to the newest closes there. Optional: a ledger written before it existed simply
   * has no closed rows to list. */
  closedRows?: GithubIssueRow[];
  /** Rows the ledger held open that a listing came back without: issues GitHub closed upstream,
   * or that dropped out of the listing for any other reason, so a lost issue leaves a trace in
   * the ledger instead of vanishing from it silently. Each record is the last listing's full row
   * — title, url, author, trusted, mirrored, labels and body excerpt — plus the `closedAt`
   * instant of the listing that last saw it open. tumwater never re-opens such an issue and
   * never closes it on GitHub: the record exists only so the mirror read can say the issue is
   * gone. The scan writes it (src/github/issue-scan.ts `recordUpstreamCloses`). */
  upstreamClosed?: GithubIssueRow[];
  /** Issues whose fix is on main but not yet on GitHub's base branch, with the shas waiting. The
   * closer writes and clears it; the scan also drops an entry whose issue GitHub closed upstream
   * (src/github/issue-scan.ts `recordUpstreamCloses`), because the banner built from this map
   * promises a close on the next push and GitHub has already made it. */
  waitingPush?: Record<string, string[]>;
  /** Director-reported fixes (part 4/5), each with the sha that fixed it. */
  fixedIn?: Record<string, { sha: string; at: number }>;
  /** Director-declined issues (part 4b/5), by issue number: when declined, the issue's `updatedAt`
   * at that time (the queue offers the issue again only once GitHub's copy changes), and why. */
  declined?: Record<string, { at: number; updatedAt: string; reason: string }>;
  /** Issues whose director prompt was queued (part 4c/5), by issue number: when it was queued, and
   * the issue's `updatedAt` then. The queue offers the issue again once this record is 24 h old
   * (decision 5), or once its hold is shortened — see `recheckAfterMs`.
   * An optional third field, `recheckAfterMs`, shortens that hold: `releaseQueuedIssueRetry`
   * writes it when the director run the queue started ended without settling the issue (no
   * `ISSUE:` line recorded), so a run that died on a checkpoint abort does not cost the issue a
   * full day. An absent field means the full 24 h; so does any value that is not a finite
   * non-negative number (a hand-edited ledger), which falls back to the timed hold rather than
   * offering the issue every poll. */
  queued?: Record<string, { at: number; updatedAt: string; recheckAfterMs?: number }>;
}

/** The ledger folded to the counts the status snapshot and its alerts read (plans/github-issues.md,
 * part 3/5). Carries no issue text, so the snapshot stays small. */
export interface GithubIssuesSummary {
  repo: string;
  gh: GhState;
  reason?: string;
  checkedAt: number;
  /** Open trusted issues that no backlog entry mirrors yet and the director has not declined at
   * their current `updatedAt` — the ones the director still owes a look at. */
  unmirrored: number;
  /** Open issues from outside the maintainers that no backlog entry mirrors. */
  untrusted: number;
  /** Always 0 in this fold: the push-waiting count the surfaces show comes from the snapshot's
   * `githubClose` field (githubCloseForStatus below), not from the summary. */
  waitingPush: number;
  /** The label that lets an outside issue in, named by the alerts. */
  mirrorLabel: string;
}

/** Fold a ledger to its summary. Pure: the caller supplies the configured mirror label. */
export function githubIssuesSummary(ledger: GithubIssuesLedger, mirrorLabel: string): GithubIssuesSummary {
  // A declined issue is settled, not waiting: the queue will not offer it again until GitHub's
  // copy moves, so the standing banner must not keep asking (isDeclinedHold is the one gate).
  const unmirrored = ledger.open.filter(
    (issue) => issue.trusted && !issue.mirrored && !isDeclinedHold(ledger, issue),
  ).length;
  const untrusted = ledger.open.filter((issue) => !issue.trusted && !issue.mirrored).length;
  return {
    repo: ledger.repo,
    gh: ledger.gh,
    ...(ledger.reason !== undefined ? { reason: ledger.reason } : {}),
    checkedAt: ledger.checkedAt,
    unmirrored,
    untrusted,
    waitingPush: 0,
    mirrorLabel,
  };
}

/** Whether issue `row` (an entry of `ledger.open`) is a genuine reopen: tumwater closed it, and
 * the issue's current `updatedAt` is later than that close — a GitHub edit after the close is
 * the reopen signal (decision 8). The queue (issue-queue.ts: a reopened issue is treated as
 * unmirrored and re-offered) and the closer (issue-close.ts: a reopened issue is not skipped)
 * both read it, so the `>` boundary cannot drift between them. */
export function isReopened(ledger: GithubIssuesLedger, row: GithubIssueRow): boolean {
  const closedAt = ledger.closed?.[String(row.number)]?.at;
  return closedAt !== undefined && Date.parse(row.updatedAt) > closedAt;
}

/** Whether issue `row` (an entry of `ledger.open`) is declined and still held: the director
 * turned it down, and GitHub's copy has not changed since — the issue is offered again only once
 * someone edits it on GitHub. The comparison is exact string equality on `updatedAt`, never a
 * `Date.parse` one: a decline whose recorded string matches nothing GitHub carries then fails
 * open and the issue is offered, which is the safe direction. Both the queue's skip
 * (issue-queue.ts `nextIssuePrompt`) and the summary's `unmirrored` fold read it, so the banner
 * and the prompt cannot drift on what a declined issue owes. */
export function isDeclinedHold(ledger: GithubIssuesLedger, row: GithubIssueRow): boolean {
  const declinedAt = ledger.declined?.[String(row.number)]?.updatedAt;
  return declinedAt !== undefined && declinedAt === row.updatedAt;
}

/** How many rows one of the mirror's growing ledger row lists ever keeps — one cap for both of
 * them, so the ledger file stays bounded however many issues the mirror closes or loses. Trimmed
 * where a list grows, never by a reader. */
export const ISSUE_ROW_LIST_MAX = 50;

/** Merge `additions` into a carried ledger row list and trim the result to `ISSUE_ROW_LIST_MAX`.
 *
 * The rule both those lists follow: an issue number an addition carries replaces the
 * carried row for it, the trim keeps the rows whose `instantOf` (the instant the ledger last
 * touched the row) reads newest with a tie breaking toward the higher issue number, and the result
 * comes back sorted ascending by number — the order the ledger stores both lists in. Any further
 * rule the caller owes the carried list (dropping a reopened issue, for one) stays outside it. */
export function keepNewestIssueRows<T extends GithubIssueRow>(
  carried: readonly T[],
  additions: readonly T[],
  instantOf: (row: T) => number,
): T[] {
  const replaced = new Set(additions.map((row) => row.number));
  return [...carried.filter((row) => !replaced.has(row.number)), ...additions]
    .sort((a, b) => instantOf(b) - instantOf(a) || b.number - a.number)
    .slice(0, ISSUE_ROW_LIST_MAX)
    .sort((a, b) => a.number - b.number);
}

/** Whether `value` carries the declared `GithubIssueRow` fields with the declared types — the
 * optional ones checked only when present. `readJsonFile` only checks "a plain object", so a
 * hand-edited or foreign-generation ledger can hold `null`, a string, or a half-written object in
 * its `open` list, and every reader below indexes the row (`row.trusted`, `row.number`,
 * `row.labels.join`) straight out of that list. */
function isGithubIssueRow(value: unknown): value is GithubIssueRow {
  if (!isJsonObject(value)) return false;
  const row = value;
  return (
    typeof row.number === "number" &&
    Number.isFinite(row.number) &&
    typeof row.title === "string" &&
    typeof row.url === "string" &&
    typeof row.author === "string" &&
    typeof row.trusted === "boolean" &&
    typeof row.mirrored === "boolean" &&
    typeof row.updatedAt === "string" &&
    Array.isArray(row.labels) &&
    row.labels.every((label) => typeof label === "string") &&
    (row.authorAssociation === undefined || typeof row.authorAssociation === "string") &&
    (row.bodyExcerpt === undefined || typeof row.bodyExcerpt === "string") &&
    // A last-seen-open instant only means anything as a finite number; a hand-edited one drops
    // the row, so a broken upstream-close record costs the read a record, not a bogus age.
    (row.closedAt === undefined || (typeof row.closedAt === "number" && Number.isFinite(row.closedAt)))
  );
}

/** The ledger on disk, or null when no scan has written one yet (or the file is unreadable). An
 * `open` list holding a row the declared shape rejects has that row dropped here, at the one read
 * every reader shares, so a hand-edited or foreign-generation entry costs the mirror one issue
 * instead of throwing a `TypeError` out of `tumwater status`, `tumwater issues`, the dashboard's
 * `GET /api/issues` and
 * the queue/close polls. A ledger holding no `open` list at all is returned as read: its reader
 * decides (`isFoldableLedger` reads it as no data, `issueRows` as an empty mirror). */
export function readGithubIssues(root: string): GithubIssuesLedger | null {
  const ledger = readJsonFile<GithubIssuesLedger>(githubIssuesPath(root));
  if (ledger === null) return null;
  let cleaned: GithubIssuesLedger | null = null;
  // Both row lists pass the same guard, so a hand-edited `closedRows` costs the read a closed row
  // exactly as a hand-edited `open` costs it an open one.
  if (Array.isArray(ledger.open)) {
    const open = (ledger.open as unknown[]).filter(isGithubIssueRow);
    if (open.length !== ledger.open.length) (cleaned ??= { ...ledger }).open = open;
  }
  if (Array.isArray(ledger.closedRows)) {
    const closedRows = (ledger.closedRows as unknown[]).filter(isGithubIssueRow);
    if (closedRows.length !== ledger.closedRows.length) (cleaned ??= { ...ledger }).closedRows = closedRows;
  }
  // Upstream-close records are rows too, so a hand-edited one costs the read a record, not a throw.
  if (Array.isArray(ledger.upstreamClosed)) {
    const upstreamClosed = (ledger.upstreamClosed as unknown[]).filter(isGithubIssueRow);
    if (upstreamClosed.length !== ledger.upstreamClosed.length)
      (cleaned ??= { ...ledger }).upstreamClosed = upstreamClosed;
  }
  return cleaned ?? ledger;
}

/** The window past which the issues mirror's scan counts as stalled — three days, the same span
 * `CI_PARITY_STALE_MS` and `remoteCiStalled` read (they spell it `3 * DAY_MS` too), so no two rows
 * of the stall-predicate family mean a different span by "stale". The scan rewrites `checkedAt` on
 * every attempt even when `gh` fails, so an old `checkedAt` means the scan itself stopped running
 * — the fact the doctor's `github issues` row names. */
export const GITHUB_ISSUES_STALE_MS = 3 * DAY_MS;

/** True only for a ledger whose `checkedAt` is a number older than the stall window
 * (`now - checkedAt > GITHUB_ISSUES_STALE_MS`). A null ledger — never scanned, or an unreadable
 * file — and a ledger whose `checkedAt` is not a number (a hand-edited file) are both false, the
 * empty-ledger rule `qaCoverageStalled` and `ciParityStalled` keep: a ledger this predicate cannot
 * read is never a stall, and the call never throws. Two consumers read it: the doctor's
 * `github issues` row (`checkGithubIssues`) and the status poll's `githubScanStall` field, which
 * both dashboards raise the standing banner from. */
export function githubScanStalled(ledger: GithubIssuesLedger | null, now: number): boolean {
  return (
    ledger !== null &&
    typeof ledger.checkedAt === "number" &&
    now - ledger.checkedAt > GITHUB_ISSUES_STALE_MS
  );
}

/** The one clause that names a stalled scan — what the doctor's `GitHub issues` warn line appends
 * after its `gh ready — but ` prefix, and what the dashboards' `github-scan-stalled` alert prints
 * as its whole detail, so the two surfaces cannot drift on how a quiet mirror is phrased. Reads
 * the same `checkedAt` and window as `githubScanStalled`: the scan age is `humanAgo` of that
 * instant, and the `over <n> days ago` clause spells `GITHUB_ISSUES_STALE_MS` in the units the
 * config row prints it in. Call it only for a stalled ledger — a `checkedAt` that is not a number
 * prints `checked NaN ago`. */
export function githubScanStalledSentence(repo: string, checkedAt: number, now: number): string {
  return `the last scan checked ${repo} ${humanAgo(checkedAt, now)}, over ${GITHUB_ISSUES_STALE_MS / DAY_MS} days ago, so tumwater is not mirroring its open issues`;
}

/** The shortest hold one issue's `queued` record may impose: one scan interval. A director run
 * that left its issue unsettled gets this instead of the queue's 24 h, so the next poll retries
 * it (BUGS.md 2026-11-22); it never drops to 0, which would offer the issue on every poll and
 * burn a director run per poll. The queue cannot read the outcome itself: the prompt it composes
 * is deleted from the queue as soon as the run dequeues it, and a run that dies before it replies
 * records no verdict, so the ledger record carries the shortened span instead — see
 * `releaseQueuedIssueRetry` (src/github/issue-outcome.ts). */
export const ISSUE_RETRY_HOLD_MS = 60 * 60 * 1000;

/** How long an issue's `queued` record holds the queue from offering it again: the record's own
 * `recheckAfterMs` when it carries a finite non-negative number (a shortened retry hold),
 * otherwise the queue's default. `issue-queue.ts` supplies that default (24 h, decision 5) as
 * `defaultMs`, and a value that is not a finite non-negative number falls back to it, so a
 * hand-edited ledger cannot turn the hold into a per-poll retry loop. Pure, like the mirror's
 * other ledger predicates. */
export function issueQueueHoldMs(queued: { recheckAfterMs?: number }, defaultMs: number): number {
  const held = queued.recheckAfterMs;
  return typeof held === "number" && Number.isFinite(held) && held >= 0 ? held : defaultMs;
}

/** The GitHub figures the status surfaces show: how many fixes wait for a push to GitHub and how
 * many open issues had only retired entries. Undefined when neither holds, no ledger exists, or
 * the ledger's shape is foreign. Reads through readGithubIssuesForPoll: the snapshot calls this on
 * every poll, so the ledger is stat-cached like every other poll reader. */
export function githubCloseForStatus(
  root: string,
): { repo: string; waitingPush: number; retiredOnly: number } | undefined {
  const ledger = readGithubIssuesForPoll(root);
  if (!ledger) return undefined;
  const waitingPush = Object.keys(ledger.waitingPush ?? {}).length;
  const retiredOnly = ledger.retiredOnly?.length ?? 0;
  if (waitingPush === 0 && retiredOnly === 0) return undefined;
  return { repo: ledger.repo, waitingPush, retiredOnly };
}

// Stat-keyed cache (stat-cache.cachedByStat) for the ledger, keyed by its path: the status
// snapshot's githubIssuesForPoll polls it every second while the hourly scan rewrites it, so an
// unchanged file costs one stat per poll instead of re-reading and re-parsing the whole open-issue
// list — body excerpts and all — to fold it to five counts. The same contract the remote-CI and
// parity ledgers' poll readers keep. writeGithubIssues is atomic (tmp + rename), so any
// write invalidates via dev/ino/mtime/size; bounded inside cachedByStat.
const ledgerCache = new Map<string, StatKeyedValue<GithubIssuesLedger>>();

/** Does this read carry what the fold reads? `readJsonFile` only checks "a plain object", so a
 * hand-edited or foreign-generation ledger can lack `open` (or hold a non-list), and the fold's
 * `open.filter` would throw out of the snapshot into the dashboard's 500 — and so a `null` or
 * scalar entry inside the list throws on its `trusted` read, the same hole
 * status-polls.ts's `liveMergeMarker` closes by filtering its records. A ledger that fails the
 * shape reads as no data — the same policy as `isRemoteCiEntry`/`isParityEntry`. */
function isFoldableLedger(value: GithubIssuesLedger | null): value is GithubIssuesLedger {
  return (
    value !== null &&
    typeof value.repo === "string" &&
    typeof value.checkedAt === "number" &&
    Array.isArray(value.open) &&
    value.open.every((row) => isJsonObject(row))
  );
}

/** The ledger as an observer may read it: stat-cached per poll, and null for a file whose shape the
 * fold cannot consume, so a broken ledger costs the dashboard a field, never the whole payload.
 * `readGithubIssues` itself stays uncached — the scan's own `previous` read must see the record as
 * it stands before its write, in this same process. */
export function readGithubIssuesForPoll(root: string): GithubIssuesLedger | null {
  const file = githubIssuesPath(root);
  return cachedByStat(
    ledgerCache,
    file,
    file,
    () => {
      const ledger = readGithubIssues(root);
      return isFoldableLedger(ledger) ? ledger : null;
    },
    // A copy: callers may treat the result as their own (the fold counts over `open`).
    (ledger) => ({ ...ledger, open: [...ledger.open] }),
  );
}

/** Rewrite the ledger atomically. */
export function writeGithubIssues(root: string, ledger: GithubIssuesLedger): void {
  ensureParentDir(githubIssuesPath(root));
  writeJsonAtomic(githubIssuesPath(root), ledger, true);
}
