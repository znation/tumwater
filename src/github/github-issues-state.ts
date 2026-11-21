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

/** The ledger on disk, or null when no scan has written one yet (or the file is unreadable). */
export function readGithubIssues(root: string): GithubIssuesLedger | null {
  return readJsonFile<GithubIssuesLedger>(githubIssuesPath(root));
}

/** The GitHub figures the status surfaces show: how many fixes wait for a push to GitHub and how
 * many open issues had only retired entries. Undefined when neither holds, or no ledger exists. */
export function githubCloseForStatus(
  root: string,
): { repo: string; waitingPush: number; retiredOnly: number } | undefined {
  const ledger = readGithubIssues(root);
  if (!ledger) return undefined;
  const waitingPush = Object.keys(ledger.waitingPush ?? {}).length;
  const retiredOnly = ledger.retiredOnly?.length ?? 0;
  if (waitingPush === 0 && retiredOnly === 0) return undefined;
  return { repo: ledger.repo, waitingPush, retiredOnly };
}

/** Rewrite the ledger atomically. */
export function writeGithubIssues(root: string, ledger: GithubIssuesLedger): void {
  ensureParentDir(githubIssuesPath(root));
  writeJsonAtomic(githubIssuesPath(root), ledger, true);
}
