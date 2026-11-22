/** Recording a director's verdict on one mirrored-or-open GitHub issue (plans/github-issues.md
 * part 4b/5). The director's reply carries an `ISSUE:` line; the run records it in the issues
 * ledger only after a successful run, so a failed or interrupted run leaves no record. A decline
 * holds the issue until GitHub's copy changes; a fix holds permanently, but only once the cited
 * commit is an ancestor of the base branch, so an unknown sha never latches. */

import { logEventBestEffort } from "../events/events.js";
import { isMergedInto } from "../git/git.js";
import type { IssueOutcome } from "../verdict/reply-contract.js";
import { queuedIssueNumber } from "./issue-queue.js";
import {
  ISSUE_RETRY_HOLD_MS,
  readGithubIssues,
  writeGithubIssues,
} from "./github-issues-state.js";

/** Record one director verdict in the ledger. Nothing is written when there is no ledger or the
 * issue is not in its `open` list. A decline logs one `github_issue_declined` event; a fix is
 * recorded only when `git merge-base --is-ancestor <sha> <mainBranch>` holds. */
export async function recordIssueOutcome(
  root: string,
  outcome: IssueOutcome,
  mainBranch: string,
  source: string,
  now: number = Date.now(),
): Promise<void> {
  const ledger = readGithubIssues(root);
  const row = ledger?.open.find((issue) => issue.number === outcome.issue);
  if (!ledger || !row) return;
  const key = String(outcome.issue);
  if ("declined" in outcome) {
    ledger.declined = {
      ...ledger.declined,
      [key]: { at: now, updatedAt: row.updatedAt, reason: outcome.declined },
    };
    writeGithubIssues(root, ledger);
    logEventBestEffort(root, {
      source,
      type: "github_issue_declined",
      repo: ledger.repo,
      issue: outcome.issue,
      reason: outcome.declined,
    });
    return;
  }
  if (!(await isMergedInto(root, outcome.fixedIn, mainBranch))) return;
  ledger.fixedIn = { ...ledger.fixedIn, [key]: { sha: outcome.fixedIn, at: now } };
  writeGithubIssues(root, ledger);
}

/** Give an issue back to the mirror's queue early when the director run the queue started never
 * settled it (BUGS.md 2026-11-22). The queue's `queued` record holds an issue out of the offer
 * for 24 h, a rule written for a prompt that is still sitting in the director's inbox; a run that
 * dequeued the prompt and died without recording a verdict (a checkpoint abort, an error, an
 * abort) leaves the issue neither mirrored nor declined and waits the full day for its next
 * offer, one issue at a time. This shortens that record's hold to `ISSUE_RETRY_HOLD_MS` so the
 * next scan interval can re-offer it. `userPrompt` is the prompt the run ran (null for a role
 * runner); only a prompt the mirror composed — one opening `GitHub issue #<n>` — names an issue,
 * so a director run on any other request changes nothing. The caller calls this only for a run
 * that recorded no verdict — a recorded decline or fix already holds the issue by its own record.
 * Nothing is written when there is no ledger, or when the issue has no `queued` record — a record
 * `queueOneIssue` rewrites fresh on the next queue, so a shortened hold never outlives the
 * re-queue. Returns whether a record was shortened. */
export function releaseIssueRetryHold(root: string, userPrompt: string | null): boolean {
  const issue = queuedIssueNumber(userPrompt ?? "");
  if (issue === null) return false;
  const ledger = readGithubIssues(root);
  const key = String(issue);
  const queued = ledger?.queued?.[key];
  if (!ledger || queued === undefined) return false;
  ledger.queued = { ...ledger.queued, [key]: { ...queued, recheckAfterMs: ISSUE_RETRY_HOLD_MS } };
  writeGithubIssues(root, ledger);
  return true;
}
