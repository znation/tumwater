/** Recording a director's verdict on one mirrored-or-open GitHub issue (plans/github-issues.md
 * part 4b/5). The director's reply carries an `ISSUE:` line; the run records it in the issues
 * ledger only after a successful run, so a failed or interrupted run leaves no record. A decline
 * holds the issue until GitHub's copy changes; a fix holds permanently, but only once the cited
 * commit is an ancestor of the base branch, so an unknown sha never latches. */

import { logEventBestEffort } from "../events/events.js";
import { isMergedInto } from "../git/git.js";
import type { IssueOutcome } from "../verdict/reply-contract.js";
import { readGithubIssues, writeGithubIssues } from "./github-issues-state.js";

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
