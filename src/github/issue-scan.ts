/** The hourly read of a project's open GitHub issues (plans/github-issues.md, parts 2/5). The
 * orchestrator's poll calls pollGithubIssues, which runs one scan per interval and records what it
 * read in the ledger (github-issues-state.ts). The scan only reads GitHub, through the operator's
 * `gh`: it writes nothing to the backlog and nothing to GitHub. */

import type { TumwaterConfig } from "../config/config-schema.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { envPath } from "../files/files.js";
import { queuedPrompts } from "../inbox/inbox.js";
import { submitRolePrompt } from "../inbox/inbox-submit.js";
import { githubTarget } from "../observer/remote-ci.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { errorMessage } from "../text/text.js";
import { closeFixedIssues } from "./issue-close.js";
import { ghReadiness, ghRunner, type GhRunner } from "./gh.js";
import { mirrorsAtTip } from "./issue-mirrors.js";
import { nextIssuePrompt, type QueuedIssue } from "./issue-queue.js";
import {
  keepNewestIssueRows,
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

/** How long a resolved GitHub target is reused by the queue step. The target is the base
 * branch's remote URL (`owner/name`) and branch — it changes only when the operator rewires the
 * checkout's remote, so the orchestrator's 2 s poll does not need a fresh read: `githubTarget`
 * spawns two `git config --get` subprocesses (measured ~10 ms per call on this repo), which at
 * one poll per 2 s is ~60 spawns a minute for an answer that is effectively static. Throttled by
 * time rather than keyed on a file, as in status/status-install.ts: the answer comes from git
 * config, not a file whose stat we can watch. */
const TARGET_POLL_THROTTLE_MS = 60_000;

/** Safety cap, as in files/stat-cache.ts: many short-lived roots (tests) cannot grow the map
 * unbounded. */
const MAX_TARGET_ROOTS = 64;

const targetCache = new Map<string, { at: number; target: { repo: string; branch: string } | null }>();

/** `githubTarget` for the per-poll queue step: the answer is recomputed at most once per
 * TARGET_POLL_THROTTLE_MS per root. A null answer (no GitHub remote) is cached too, so a repo
 * with no mirror target costs no spawns per poll either; it re-reads after the window. The
 * caller owns the returned object. The hourly scan and close paths keep the fresh
 * `githubTarget` read. */
export async function githubTargetForPoll(
  root: string,
  config: TumwaterConfig,
  now: number = Date.now(),
): Promise<{ repo: string; branch: string } | null> {
  const hit = targetCache.get(root);
  if (hit && now - hit.at < TARGET_POLL_THROTTLE_MS) return hit.target ? { ...hit.target } : null;
  const target = await githubTarget(root, config);
  if (targetCache.size >= MAX_TARGET_ROOTS) targetCache.clear();
  targetCache.set(root, { at: now, target });
  return target ? { ...target } : null;
}

/** Forget every cached target (tests). */
export function resetGithubTargetCache(): void {
  targetCache.clear();
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

type ListResult = { ok: true; issues: RawIssue[]; capped: boolean } | { ok: false; reason: string };

/** Every open issue of the repo, one request per page of ISSUES_PER_PAGE, up to MAX_ISSUE_PAGES.
 * One page at a time, since `gh api --paginate` has no page cap and prints each page as its own
 * JSON array. The listing includes pull requests, which the scan drops. A failed or malformed
 * page fails the whole listing, so a partial read is never recorded as the full set.
 * `capped` says the walk ran out of pages with a full page still in hand — the listing was cut
 * short, so open issues exist that this scan never saw. That flag is what keeps an upstream-close
 * record honest: the scan records an open issue it no longer sees as closed upstream only when the
 * listing that failed to see it is known to be complete (INV-DG1). */
async function listOpenIssues(run: GhRunner, repo: string): Promise<ListResult> {
  const issues: RawIssue[] = [];
  let capped = true;
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
    if (batch.length < ISSUES_PER_PAGE) {
      capped = false;
      break;
    }
  }
  return { ok: true, issues, capped };
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
  if (raw.author_association !== undefined) row.authorAssociation = raw.author_association;
  if (trusted) row.bodyExcerpt = Array.from(raw.body ?? "").slice(0, BODY_EXCERPT_MAX_CHARS).join("");
  return row;
}

/** Record the issues GitHub stopped listing, and keep the records the previous scan carried.
 * One record per row of `previous.open` whose number appears in neither the fresh listing nor the
 * ledger's `closedRows` — so an issue tumwater closed, an issue that merely reopened, and the first
 * scan of a repo (no `previous`) record nothing. A record is that issue's last full row with
 * `closedAt` set to this scan's instant and GitHub's own `updatedAt` kept, so the read can age it
 * both ways. Carried records whose number the listing reports open again are dropped, the same
 * rule the reopen filter above applies to `closedRows`. The trim keeps the `ISSUE_ROW_LIST_MAX`
 * newest `closedAt` (a tie breaking toward the higher number) and stores
 * the list back in ascending number order, the order the read prints. Only a listing known to be
 * complete may call this: a walk cut short at `MAX_ISSUE_PAGES` never saw the issue, so it cannot
 * have missed it. Mutates the ledger; the only other record a loss settles is `waitingPush`, which
 * is dropped for a lost issue because the push banner promises a close GitHub has already made —
 * `closed`, `queued` and `declined` records stay owed even though GitHub no longer lists the issue,
 * since they are the read's history and `isReopened`'s clock, not a promise of a future close.
 * Each newly recorded loss also logs one `github_issue_upstream_closed` event naming the repo, the
 * issue and GitHub's last word on it, so the operator's log says what the ledger-only record
 * cannot: a row already sitting in `upstreamClosed` logs nothing, so a loss is logged once, not
 * once per scan. */
function recordUpstreamCloses(
  root: string,
  ledger: GithubIssuesLedger,
  previous: GithubIssuesLedger | null,
  now: number,
): void {
  const openNumbers = new Set(ledger.open.map((row) => row.number));
  // Both carried lists pass the same `Array.isArray` guard every other reader uses: a hand-edited
  // or foreign-generation ledger holding a non-list under one of these keys costs the mirror that
  // list and nothing more, instead of throwing and stopping the scan from writing the ledger.
  const closedRows = Array.isArray(ledger.closedRows) ? ledger.closedRows : [];
  const closedNumbers = new Set(closedRows.map((row) => row.number));
  const lost = (previous?.open ?? [])
    .filter((row) => !openNumbers.has(row.number) && !closedNumbers.has(row.number))
    .map((row) => ({ ...row, closedAt: now }));
  for (const row of lost) {
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "github_issue_upstream_closed",
      repo: ledger.repo,
      issue: row.number,
      updatedAt: row.updatedAt,
    });
  }
  const previousUpstreamClosed = Array.isArray(previous?.upstreamClosed) ? previous.upstreamClosed : [];
  const carried = previousUpstreamClosed.filter((row) => !openNumbers.has(row.number));
  // Nothing to say: the list is dropped rather than left as whatever the spread carried over, so a
  // lost issue that came back leaves no record behind.
  if (carried.length === 0 && lost.length === 0) {
    delete ledger.upstreamClosed;
    return;
  }
  ledger.upstreamClosed = keepNewestIssueRows(carried, lost, (row) => row.closedAt ?? 0);
  dropLostWaitingPush(ledger, ledger.upstreamClosed);
}

/** Drop the `waitingPush` records of issues the stored upstream-close list holds. The banner built
 * from that map promises a close that happens when main is pushed, and GitHub has already made it
 * for a lost issue, so the promise can never be kept — the same never-clearing-banner class INV-DE4
 * settled for declined issues. Every number in the list is consulted, not just this scan's new
 * losses, so a ledger written by a build that dropped nothing self-heals on its next complete
 * listing. A key the list does not hold keeps its record, and an emptied map is deleted rather
 * than left as `{}`. The copy-then-`delete` idiom is the one `closeOne` uses in
 * src/github/issue-close.ts; candidacy for a close never consults this map — `closeCandidates`
 * re-derives the fix commits — so a reopened issue gets a fresh record from the next close pass. */
function dropLostWaitingPush(ledger: GithubIssuesLedger, lost: readonly GithubIssueRow[]): void {
  if (ledger.waitingPush === undefined) return;
  const lostNumbers = new Set(lost.map((row) => row.number));
  const waiting = { ...ledger.waitingPush };
  let dropped = false;
  for (const key of Object.keys(waiting)) {
    if (!lostNumbers.has(Number(key))) continue;
    delete waiting[key];
    dropped = true;
  }
  if (!dropped) return;
  if (Object.keys(waiting).length === 0) delete ledger.waitingPush;
  else ledger.waitingPush = waiting;
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
  // Whether this scan's listing is known to be complete. null when it made no listing at all (gh
  // unusable, or the listing failed): then nothing upstream is recorded and the spread below keeps
  // whatever the previous scan wrote.
  let capped: boolean | null = null;
  if (readiness === "missing") {
    reason = "gh is not installed or cannot run";
  } else if (readiness === "unauthenticated") {
    reason = "gh is not logged in to github.com";
  } else {
    const listed = await listOpenIssues(run, target.repo);
    if (listed.ok) {
      const authors = config.githubIssues?.authors ?? "collaborators";
      const mirrorLabel = config.githubIssues?.mirrorLabel ?? "tumwater";
      const mirrored = new Set((await mirrorsAtTip(root, target.branch)).keys());
      open = listed.issues.map((raw) => toRow(raw, authors, mirrorLabel, mirrored));
      capped = listed.capped;
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
  // A closed row whose number the fresh listing reports open again is no longer a closed row: the
  // issue is open, listed in `open`, and `closed[<n>]` survives so `isReopened` still marks it a
  // reopen and the queue offers it again. A scan that saw no change leaves the list as it was.
  const previousClosedRows = previous?.closedRows;
  if (Array.isArray(previousClosedRows) && previousClosedRows.length > 0) {
    const openNumbers = new Set(open.map((row) => row.number));
    ledger.closedRows = previousClosedRows.filter((row) => !openNumbers.has(row.number));
  }
  // An issue the ledger held open that a complete listing came back without is closed upstream (or
  // deleted, or turned into a PR — the listing cannot tell); record it so the loss leaves a trace.
  if (capped === false) recordUpstreamCloses(root, ledger, previous, now);
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

/** One queue attempt: pick the next issue and enqueue it. Make no `gh` call — the scan already
 * wrote the ledger — and enqueue through the same seam a user's prompt uses (which validates the
 * length cap and logs the `prompt_enqueued` event). Records the issue in the ledger so it is not
 * re-offered for 24 h (decision 5) and logs one `github_issue_queued` event. Null when no issue is
 * due (nothing mirrored, queued within 24 h, declined at its current updatedAt, or fixed). */
export async function queueOneIssue(
  root: string,
  config: TumwaterConfig,
  now: number = Date.now(),
): Promise<QueuedIssue | null> {
  const ledger = readGithubIssues(root);
  const target = await githubTargetForPoll(root, config, now);
  if (ledger?.gh !== "ok" || !target) return null;
  const mirrors = await mirrorsAtTip(root, target.branch);
  const picked = nextIssuePrompt(
    ledger,
    new Set(mirrors.keys()),
    queuedPrompts(root),
    now,
  );
  if (!picked) return null;
  submitRolePrompt(root, DIRECTOR_ROLE, picked.text);
  ledger.queued = {
    ...ledger.queued,
    [String(picked.issue)]: { at: now, updatedAt: currentUpdatedAt(ledger, picked.issue) },
  };
  writeGithubIssues(root, ledger);
  logEventBestEffort(root, {
    source: TUMWATER_SOURCE,
    type: "github_issue_queued",
    repo: ledger.repo,
    issue: picked.issue,
  });
  return picked;
}

/** The current `updatedAt` of an open issue, used to record what the queue saw. */
function currentUpdatedAt(ledger: GithubIssuesLedger, number: number): string {
  return ledger.open.find((row) => row.number === number)?.updatedAt ?? "";
}

/** The orchestrator's trigger, awaited by each poll: when the clock says a scan is due and the
 * feature is on, move the clock to the next interval and run one scan, and on every poll (due or
 * not) offer the next unmirrored issue to the director. A failed scan or queue warns and never
 * fails the poll. */
export async function pollGithubIssues(
  root: string,
  config: TumwaterConfig,
  clock: IssueScanClock,
  warn: (message: string) => void,
  run: GhRunner = ghRunner(envPath()),
  now: number = Date.now(),
): Promise<void> {
  if (config.githubIssues?.enabled === false) return;
  try {
    await queueOneIssue(root, config, now);
    if (!dueForIssueScan(clock.nextAt, now)) return;
    const minutes = config.githubIssues?.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES;
    clock.nextAt = now + minutes * MS_PER_MINUTE;
    const ledger = await scanGithubIssues(root, config, run, now);
    if (ledger?.gh === "ok" && config.githubIssues?.close !== false) {
      await closeFixedIssues(root, config, run, warn, now);
    }
  } catch (err) {
    warn(`could not scan the GitHub issues: ${errorMessage(err)}`);
  }
}
