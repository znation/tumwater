/** The GitHub issues ledger (plans/github-issues.md, State): the one file the hourly scan writes
 * and the GUI and `tumwater status` read. The scan owns repo, branch, checkedAt, gh, reason and
 * open. The queue, decline, fix and close records that later parts add stay in the file, so a
 * rewrite by the scan never drops them. */

import { ensureParentDir } from "../files/files.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { githubIssuesPath } from "../paths.js";
import { DAY_MS } from "../text/datetime.js";

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
  /** Issues whose fix is on main but not yet on GitHub's base branch, with the shas waiting. */
  waitingPush?: Record<string, string[]>;
  /** Director-reported fixes (part 4/5), each with the sha that fixed it. */
  fixedIn?: Record<string, { sha: string; at: number }>;
  /** Director-declined issues (part 4b/5), by issue number: when declined, the issue's `updatedAt`
   * at that time (the queue offers the issue again only once GitHub's copy changes), and why. */
  declined?: Record<string, { at: number; updatedAt: string; reason: string }>;
  /** Issues whose director prompt was queued (part 4c/5), by issue number: when it was queued, and
   * the issue's `updatedAt` then. The queue offers the issue again once this record is 24 h old
   * (decision 5). */
  queued?: Record<string, { at: number; updatedAt: string }>;
}

/** The ledger folded to the counts the status snapshot and its alerts read (plans/github-issues.md,
 * part 3/5). Carries no issue text, so the snapshot stays small. */
export interface GithubIssuesSummary {
  repo: string;
  gh: GhState;
  reason?: string;
  checkedAt: number;
  /** Open trusted issues that no backlog entry mirrors yet — the director has not taken them. */
  unmirrored: number;
  /** Open issues from outside the maintainers that no backlog entry mirrors. */
  untrusted: number;
  /** Trusted issues queued for a mirror push. Stays 0 until part 5 writes it. */
  waitingPush: number;
  /** The label that lets an outside issue in, named by the alerts. */
  mirrorLabel: string;
}

/** Fold a ledger to its summary. Pure: the caller supplies the configured mirror label. */
export function githubIssuesSummary(ledger: GithubIssuesLedger, mirrorLabel: string): GithubIssuesSummary {
  const unmirrored = ledger.open.filter((issue) => issue.trusted && !issue.mirrored).length;
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

/** Whether `value` carries the declared `GithubIssueRow` fields with the declared types — the
 * optional ones checked only when present. `readJsonFile` only checks "a plain object", so a
 * hand-edited or foreign-generation ledger can hold `null`, a string, or a half-written object in
 * its `open` list, and every reader below indexes the row (`row.trusted`, `row.number`,
 * `row.labels.join`) straight out of that list. */
function isGithubIssueRow(value: unknown): value is GithubIssueRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
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
    (row.bodyExcerpt === undefined || typeof row.bodyExcerpt === "string")
  );
}

/** The ledger on disk, or null when no scan has written one yet (or the file is unreadable). An
 * `open` list holding a row the declared shape rejects has that row dropped here, at the one read
 * every reader shares, so a hand-edited or foreign-generation entry costs the mirror one issue
 * instead of throwing a `TypeError` out of `tumwater status`, `tumwater issues`, the dashboard and
 * the queue/close polls. A ledger holding no `open` list at all is returned as read: its reader
 * decides (`isFoldableLedger` reads it as no data, `issueRows` as an empty mirror). */
export function readGithubIssues(root: string): GithubIssuesLedger | null {
  const ledger = readJsonFile<GithubIssuesLedger>(githubIssuesPath(root));
  if (ledger === null || !Array.isArray(ledger.open)) return ledger;
  const open = (ledger.open as unknown[]).filter(isGithubIssueRow);
  if (open.length === ledger.open.length) return ledger;
  return { ...ledger, open };
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
 * read is never a stall, and the call never throws. The doctor's `github issues` row
 * (`checkGithubIssues`) is the decision's only consumer. */
export function githubScanStalled(ledger: GithubIssuesLedger | null, now: number): boolean {
  return (
    ledger !== null &&
    typeof ledger.checkedAt === "number" &&
    now - ledger.checkedAt > GITHUB_ISSUES_STALE_MS
  );
}

/** The GitHub figures the status surfaces show: how many fixes wait for a push to GitHub and how
 * many open issues had only retired entries. Undefined when neither holds, no ledger exists, or
 * the ledger's shape is foreign. Reads through readGithubIssuesForPoll: the snapshot calls this on
 * every poll, so the ledger is stat-cached like every other poll reader (INV-T5). */
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
// parity ledgers' poll readers keep (INV-T5). writeGithubIssues is atomic (tmp + rename), so any
// write invalidates via dev/ino/mtime/size; bounded inside cachedByStat.
const ledgerCache = new Map<string, StatKeyedValue<GithubIssuesLedger>>();

/** Does this read carry what the fold reads? `readJsonFile` only checks "a plain object", so a
 * hand-edited or foreign-generation ledger can lack `open` (or hold a non-list), and the fold's
 * `open.filter` would throw out of the snapshot into the dashboard's 500. A ledger that fails the
 * shape reads as no data — the same policy as `isRemoteCiEntry`/`isParityEntry`. */
function isFoldableLedger(value: GithubIssuesLedger | null): value is GithubIssuesLedger {
  return (
    value !== null &&
    typeof value.repo === "string" &&
    typeof value.checkedAt === "number" &&
    Array.isArray(value.open)
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
