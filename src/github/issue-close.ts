/** Closing a mirrored GitHub issue once its fix is on GitHub's copy of the base branch
 * (plans/github-issues.md, decisions 6–8; part 5/5). `closeCandidates` is the pure verdict over
 * the ledger and the backlog's mirror entries. `closeFixedIssues` runs after each scan:
 * it cites the fix commits, checks each is on GitHub, and closes the issue as the operator's
 * `gh` login. */

import type { TumwaterConfig } from "../config/config-schema.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { branchHead, gitLines, subjectOfCommit } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { githubTarget } from "../observer/remote-ci.js";
import type { GhRunner } from "./gh.js";
import { isReopened, keepNewestIssueRows, readGithubIssues, writeGithubIssues, type GithubIssueRow, type GithubIssuesLedger } from "./github-issues-state.js";
import { isFinishedMirror, mirrorsAtTip, type MirrorEntry } from "./issue-mirrors.js";

/** The finished archives whose commits record a fix: the commit that moved a mirror into one is the
 * fix commit (decision 7). */
const FIX_ARCHIVES = ["BUGS-FIXED.md", "PLANS-DONE.md"];

/** The verdict over the ledger: the open issues to close now, and the open issues whose every
 * mirroring entry was retired (listed, never closed). */
interface CloseVerdict {
  close: number[];
  retiredOnly: number[];
}

/** One fix commit on the base branch: its full sha, subject, and when it was made (epoch ms). */
interface FixCommit {
  sha: string;
  subject: string;
  at: number;
}

/** The open issues that may close now (decisions 6 and 8). An issue closes when every entry that
 * mirrors it is finished and at least one is a real fix, or when a director reported its fix
 * (`fixedIn`). An issue tumwater closed at or after its current `updatedAt` is skipped, so a
 * reopen (a later `updatedAt`) becomes eligible again. */
export function closeCandidates(
  ledger: GithubIssuesLedger,
  mirrors: ReadonlyMap<number, MirrorEntry[]>,
): CloseVerdict {
  const verdict: CloseVerdict = { close: [], retiredOnly: [] };
  for (const row of ledger.open) {
    const key = String(row.number);
    if (ledger.closed?.[key] !== undefined && !isReopened(ledger, row)) continue;
    if (ledger.fixedIn?.[key]) {
      verdict.close.push(row.number);
      continue;
    }
    const entries = mirrors.get(row.number) ?? [];
    if (entries.length === 0 || !entries.every(isFinishedMirror)) continue;
    if (entries.every((entry) => entry.retired)) verdict.retiredOnly.push(row.number);
    else verdict.close.push(row.number);
  }
  return verdict;
}

/** The commits on `branch` that wrote an entry for issue `n` into a finished archive, newest first,
 * made after `since` (epoch ms) when given. One `git log -S` over the archives, so a commit that
 * only files a live entry never counts as a fix. The pickaxe pattern is anchored to a `### `
 * heading, because that is where the mirror phrase lives (issue-mirrors.ts: only headings count) —
 * an unanchored phrase also matched a commit that merely QUOTES such a heading in prose, citing a
 * docs commit as the fix and, since `closeOne` insists every cited sha is on GitHub, holding the
 * issue in `waitingPush` forever. The walk is served from a cache while the branch tip is
 * unchanged (the same tip-SHA keying as `mirrorsAtTip`): it runs `--pickaxe-regex`, which diffs
 * every commit's change to the archives — 2m03s measured on this repo's 11.3 MB of finished
 * archives as of 2026-11-15, against 0.03s for the same walk without the pickaxe. The close pass
 * runs it for every candidate after every scan, and an issue whose fix is still unpushed
 * (`waitingPush`) retries the identical walk on the next poll at an unchanged tip. A hit hands
 * back a fresh array, so a caller's filter or prepend never touches the cached list. */
async function fixCommits(root: string, branch: string, n: number, since?: number): Promise<FixCommit[]> {
  const head = await branchHead(root, branch);
  if (head === null) return newerThan(await pickaxeFixCommits(root, branch, n), since);
  const key = `${root}\u0000${branch}`;
  let entry = fixCache.get(key);
  if (entry?.head !== head) {
    if (fixCache.size >= FIX_CACHE_MAX) fixCache.clear();
    entry = { head, commits: new Map() };
    fixCache.set(key, entry);
  }
  let found = entry.commits.get(n);
  if (found === undefined) {
    found = await pickaxeFixCommits(root, branch, n);
    entry.commits.set(n, found);
  }
  return newerThan(found, since);
}

/** How many (root, branch) fix walks the cache holds: the orchestrator closes on one or two
 * projects, so any list this long is stale entries from other roots, and clearing it wholesale
 * keeps the cache from growing for the life of the process. */
const FIX_CACHE_MAX = 32;

/** One branch tip's fix walks: the tip SHA they ran at, and the unfiltered commits per issue. */
interface FixCacheEntry {
  head: string;
  commits: Map<number, FixCommit[]>;
}

const fixCache = new Map<string, FixCacheEntry>();

/** The cached list as a new array holding only commits made after `since` (epoch ms). */
function newerThan(commits: FixCommit[], since?: number): FixCommit[] {
  return since === undefined ? [...commits] : commits.filter((commit) => commit.at > since);
}

/** The uncached walk: the commits on `branch` touching an entry for issue `n` in a finished
 * archive, unfiltered by date. */
async function pickaxeFixCommits(root: string, branch: string, n: number): Promise<FixCommit[]> {
  const phrase = `^### [^[:cntrl:]]*mirrors GitHub issues? [^[:cntrl:]]*#${n}([^0-9]|$)`;
  const out = await gitTry(root, "log", "--format=%H%x00%ct%x00%s", "--pickaxe-regex", `-S${phrase}`, branch, "--", ...FIX_ARCHIVES);
  return gitLines(out).map((line) => {
    const [sha = "", seconds = "", subject = ""] = line.split("\0");
    return { sha, subject, at: Number(seconds) * 1000 };
  });
}

/** The comment that cites the fix commits and the backlog entry that mirrored the issue. */
function closeComment(branch: string, commits: FixCommit[], entry: MirrorEntry): string {
  const fixed = commits.map((commit) => `${commit.sha.slice(0, 8)} ("${commit.subject}")`).join(" and ");
  const title = entry.heading.split(" (")[0]?.trim() ?? entry.heading;
  const file = entry.file.startsWith("BUGS") ? "BUGS.md" : "PLANS.md";
  return `Fixed on ${branch} in ${fixed}. Closed by tumwater, which mirrored this issue as ${file} entry "${title}".`;
}

/** The fix commits for one candidate: the director's reported sha first when there is one, then the
 * archive commits newer than the previous close. */
async function commitsToCite(root: string, branch: string, ledger: GithubIssuesLedger, n: number): Promise<FixCommit[]> {
  const key = String(n);
  const reported = ledger.fixedIn?.[key];
  const commits = await fixCommits(root, branch, n, ledger.closed?.[key]?.at);
  if (!reported || commits.some((commit) => commit.sha === reported.sha)) return commits;
  return [{ sha: reported.sha, subject: await subjectOfCommit(root, reported.sha), at: reported.at }, ...commits];
}

/** Whether GitHub's copy of `branch` contains `sha`: the compare answers `ahead` (sha is an
 * ancestor of the branch) or `identical`. Any other answer, including a sha GitHub does not have
 * yet, means the commit is not pushed. */
async function onGithub(run: GhRunner, repo: string, branch: string, sha: string): Promise<boolean> {
  const reply = await run(["api", `repos/${repo}/compare/${sha}...${branch}`, "--jq", ".status"]);
  const status = reply?.code === 0 ? reply.stdout.trim() : "";
  return status === "ahead" || status === "identical";
}

/** Keep the row of the issue just closed, so `tumwater issues` can still name what it closed. The
 * row leaves `open` and joins `closedRows` with its `updatedAt` set to the close instant — that is
 * what makes the list read `closed <ago>` for it — keeping its title, url, author and body excerpt.
 * The list is trimmed to the `ISSUE_ROW_LIST_MAX` newest close instants. Mutates the ledger. */
function retainClosedRow(ledger: GithubIssuesLedger, n: number, key: string, now: number): void {
  const at = ledger.closed?.[key]?.at ?? now;
  const row = ledger.open.find((r) => r.number === n);
  ledger.open = ledger.open.filter((r) => r.number !== n);
  if (!row) return;
  const kept: GithubIssueRow = { ...row, updatedAt: new Date(at).toISOString() };
  // Newest close first for the trim, then back to ascending number so the file holds the list in
  // the reader's order (the render sorts anyway). A tie in close instant breaks toward the higher
  // issue number, the order a pass closes in, so a pass closing more than the cap keeps its last
  // closes rather than an arbitrary half of them.
  ledger.closedRows = keepNewestIssueRows(ledger.closedRows ?? [], [kept], (r) => Date.parse(r.updatedAt));
}

/** Close one candidate issue, or record that its fix waits for a push. Mutates the ledger; the
 * caller writes it. */
async function closeOne(
  root: string,
  ledger: GithubIssuesLedger,
  target: { repo: string; branch: string },
  n: number,
  mirrors: ReadonlyMap<number, MirrorEntry[]>,
  run: GhRunner,
  warn: (message: string) => void,
  now: number,
): Promise<void> {
  const key = String(n);
  const commits = await commitsToCite(root, target.branch, ledger, n);
  if (commits.length === 0) return;
  for (const commit of commits) {
    if (!(await onGithub(run, target.repo, target.branch, commit.sha))) {
      ledger.waitingPush = { ...(ledger.waitingPush ?? {}), [key]: commits.map((c) => c.sha) };
      return;
    }
  }
  const entry = (mirrors.get(n) ?? [])[0];
  if (!entry) return;
  const reply = await run([
    "issue", "close", key, "--repo", target.repo, "--reason", "completed",
    "--comment", closeComment(target.branch, commits, entry),
  ]);
  if (reply?.code !== 0) {
    warn(`could not close GitHub issue #${n}; the next scan retries`);
    return;
  }
  const shas = commits.map((commit) => commit.sha);
  ledger.closed = { ...(ledger.closed ?? {}), [key]: { at: now, shas } };
  retainClosedRow(ledger, n, key, now);
  const waiting = { ...(ledger.waitingPush ?? {}) };
  delete waiting[key];
  ledger.waitingPush = waiting;
  logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "github_issue_closed", repo: target.repo, issue: n, shas });
}

/** One close pass after a scan: when `gh` read the issues, close every candidate whose fixes are on
 * GitHub, record the rest as waiting for a push, and list the retired-only issues. Rewrites the
 * ledger. A candidate whose fix commits cannot be found is skipped, so no close cites nothing. */
export async function closeFixedIssues(
  root: string,
  config: TumwaterConfig,
  run: GhRunner,
  warn: (message: string) => void,
  now: number = Date.now(),
): Promise<void> {
  const ledger = readGithubIssues(root);
  const target = await githubTarget(root, config);
  if (ledger?.gh !== "ok" || !target) return;
  const mirrors = await mirrorsAtTip(root, target.branch);
  const verdict = closeCandidates(ledger, mirrors);
  if (verdict.retiredOnly.length) ledger.retiredOnly = verdict.retiredOnly;
  else delete ledger.retiredOnly;
  for (const n of verdict.close) {
    await closeOne(root, ledger, { repo: target.repo, branch: target.branch }, n, mirrors, run, warn, now);
  }
  writeGithubIssues(root, ledger);
}
