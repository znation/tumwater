/** The GitHub issues ledger (plans/github-issues.md, State): the one file the hourly scan writes
 * and the GUI and `tumwater status` read. The scan owns repo, branch, checkedAt, gh, reason and
 * open. The queue, decline, fix and close records that later parts add stay in the file, so a
 * rewrite by the scan never drops them. */

import { ensureParentDir } from "../files/files.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { githubIssuesPath } from "../paths.js";

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

/** The ledger on disk, or null when no scan has written one yet (or the file is unreadable). */
export function readGithubIssues(root: string): GithubIssuesLedger | null {
  return readJsonFile<GithubIssuesLedger>(githubIssuesPath(root));
}

/** Rewrite the ledger atomically. */
export function writeGithubIssues(root: string, ledger: GithubIssuesLedger): void {
  ensureParentDir(githubIssuesPath(root));
  writeJsonAtomic(githubIssuesPath(root), ledger, true);
}
