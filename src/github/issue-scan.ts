/** The hourly read of a project's open GitHub issues (plans/github-issues.md, parts 2/5). The
 * orchestrator's poll calls pollGithubIssues, which runs one scan per interval and records what it
 * read in the ledger (github-issues-state.ts). The scan only reads GitHub, through the operator's
 * `gh`: it writes nothing to the backlog and nothing to GitHub. */

import type { TumwaterConfig } from "../config/config-schema.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { envPath } from "../files/files.js";
import { fileContentAt } from "../git/git.js";
import { githubTarget } from "../observer/remote-ci.js";
import { ghReadiness, ghRunner, type GhRunner } from "./gh.js";
import { mirrorStates } from "./issue-mirrors.js";
import {
  readGithubIssues,
  writeGithubIssues,
  type GhState,
  type GithubIssueRow,
  type GithubIssuesLedger,
} from "./github-issues-state.js";

/** The first scan runs this long after the team starts (decision 5). */
const FIRST_ISSUE_SCAN_DELAY_MS = 60_000;

/** The listing asks for this many issues a page and reads at most this many pages, so one scan is
 * at most 500 issues (decision 5). */
const ISSUES_PER_PAGE = 100;
const MAX_ISSUE_PAGES = 5;

/** The most characters of a trusted issue's body the ledger keeps (decision 5). */
export const BODY_EXCERPT_MAX_CHARS = 2500;

/** The backlog files a mirror can sit in: the open lists and their finished archives. */
const MIRROR_FILES = ["BUGS.md", "PLANS.md", "BUGS-FIXED.md", "PLANS-DONE.md"];

const MS_PER_MINUTE = 60_000;
const DEFAULT_SCAN_INTERVAL_MINUTES = 60;

/** The scan's clock: the time the next scan is due. */
export interface IssueScanClock {
  nextAt: number;
}

/** A fresh clock: the first scan is due one delay after the team starts. */
export function newIssueScanClock(now: number = Date.now()): IssueScanClock {
  return { nextAt: now + FIRST_ISSUE_SCAN_DELAY_MS };
}

/** Whether a scan is due: the clock's time has come. */
export function dueForIssueScan(nextAt: number, now: number): boolean {
  return now >= nextAt;
}

/** Whether an open issue is one a maintainer stands behind (decision 4): its author association
 * is OWNER, MEMBER or COLLABORATOR, it carries the mirror label, or every issue counts. */
export function isTrustedIssue(
  issue: { authorAssociation?: string; labels: string[] },
  authors: "collaborators" | "anyone",
  mirrorLabel: string,
): boolean {
  if (authors === "anyone") return true;
  if (issue.labels.includes(mirrorLabel)) return true;
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(issue.authorAssociation ?? "");
}

/** The fields of one issue from `gh api repos/<repo>/issues` that the scan reads. */
interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  updated_at: string;
  author_association?: string;
  user?: { login?: string } | null;
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
}

function asIssue(value: unknown): RawIssue | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as RawIssue;
  return typeof raw.number === "number" ? raw : null;
}

type ListResult = { ok: true; issues: RawIssue[] } | { ok: false; reason: string };

/** Every open issue of the repo, one request per page of ISSUES_PER_PAGE, up to MAX_ISSUE_PAGES.
 * One page at a time, since `gh api --paginate` has no page cap and prints each page as its own
 * JSON array. The listing includes pull requests, which the scan drops. A failed or malformed
 * page fails the whole listing, so a partial read is never recorded as the full set. */
async function listOpenIssues(run: GhRunner, repo: string): Promise<ListResult> {
  const issues: RawIssue[] = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const reply = await run([
      "api",
      `repos/${repo}/issues?state=open&per_page=${ISSUES_PER_PAGE}&page=${page}`,
    ]);
    if (reply?.code !== 0) return { ok: false, reason: "gh api could not list the issues" };
    let batch: unknown;
    try {
      batch = JSON.parse(reply.stdout);
    } catch {
      return { ok: false, reason: "gh api replied with unreadable JSON" };
    }
    if (!Array.isArray(batch)) return { ok: false, reason: "gh api did not reply with a list of issues" };
    for (const value of batch) {
      const raw = asIssue(value);
      if (raw && raw.pull_request === undefined) issues.push(raw);
    }
    if (batch.length < ISSUES_PER_PAGE) break;
  }
  return { ok: true, issues };
}

/** One ledger row from one raw issue. */
function toRow(
  raw: RawIssue,
  authors: "collaborators" | "anyone",
  mirrorLabel: string,
  mirrored: ReadonlySet<number>,
): GithubIssueRow {
  const labels = (raw.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .filter((name) => name !== "");
  const trusted = isTrustedIssue({ authorAssociation: raw.author_association, labels }, authors, mirrorLabel);
  const row: GithubIssueRow = {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    author: raw.user?.login ?? "",
    trusted,
    mirrored: mirrored.has(raw.number),
    labels,
    updatedAt: raw.updated_at,
  };
  if (trusted) row.bodyExcerpt = Array.from(raw.body ?? "").slice(0, BODY_EXCERPT_MAX_CHARS).join("");
  return row;
}

/** The issue numbers any backlog file mirrors at the base branch's tip. */
async function mirroredAtTip(root: string, branch: string): Promise<Set<number>> {
  const files: Record<string, string> = {};
  for (const file of MIRROR_FILES) files[file] = await fileContentAt(root, branch, file);
  return new Set(mirrorStates(files).keys());
}

/** One scan: when enabled and the project has a GitHub remote, probe `gh`, list the open issues,
 * and rewrite the ledger. A scan whose `gh` cannot read the issues keeps the previous open list
 * and records why. The record of an outage is one `github_issues_unavailable` event, logged when
 * `gh` turns from ok (or unknown) to not usable. Returns the ledger written, or null when the scan
 * made no call. */
export async function scanGithubIssues(
  root: string,
  config: TumwaterConfig,
  run: GhRunner,
  now: number = Date.now(),
): Promise<GithubIssuesLedger | null> {
  if (config.githubIssues?.enabled === false) return null;
  const target = await githubTarget(root, config);
  if (!target) return null;
  const previous = readGithubIssues(root);
  const readiness = await ghReadiness(run);
  let gh: GhState = readiness;
  let reason: string | undefined;
  let open = previous?.open ?? [];
  if (readiness === "missing") {
    reason = "gh is not installed or cannot run";
  } else if (readiness === "unauthenticated") {
    reason = "gh is not logged in to github.com";
  } else {
    const listed = await listOpenIssues(run, target.repo);
    if (listed.ok) {
      const authors = config.githubIssues?.authors ?? "collaborators";
      const mirrorLabel = config.githubIssues?.mirrorLabel ?? "tumwater";
      const mirrored = await mirroredAtTip(root, target.branch);
      open = listed.issues.map((raw) => toRow(raw, authors, mirrorLabel, mirrored));
    } else {
      gh = "error";
      reason = listed.reason;
    }
  }
  const ledger: GithubIssuesLedger = {
    ...(previous ?? {}),
    repo: target.repo,
    branch: target.branch,
    checkedAt: now,
    gh,
    open,
  };
  if (reason !== undefined) ledger.reason = reason;
  else delete ledger.reason;
  if (gh !== "ok" && (previous === null || previous.gh === "ok")) {
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "github_issues_unavailable",
      repo: target.repo,
      gh,
      reason,
    });
  }
  writeGithubIssues(root, ledger);
  return ledger;
}

/** The orchestrator's trigger, awaited by each poll: when the clock says a scan is due and the
 * feature is on, move the clock to the next interval and run one scan. A failed scan warns and
 * never fails the poll. */
export async function pollGithubIssues(
  root: string,
  config: TumwaterConfig,
  clock: IssueScanClock,
  warn: (message: string) => void,
  run: GhRunner = ghRunner(envPath()),
  now: number = Date.now(),
): Promise<void> {
  if (config.githubIssues?.enabled === false || !dueForIssueScan(clock.nextAt, now)) return;
  const minutes = config.githubIssues?.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES;
  clock.nextAt = now + minutes * MS_PER_MINUTE;
  try {
    await scanGithubIssues(root, config, run, now);
  } catch (err) {
    warn(`could not scan the GitHub issues: ${err instanceof Error ? err.message : String(err)}`);
  }
}
