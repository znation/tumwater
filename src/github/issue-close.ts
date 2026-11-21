/** Closing a mirrored GitHub issue once its fix is on GitHub's copy of the base branch
 * (plans/github-issues.md, decisions 6–8; part 5/5). `closeCandidates` is the pure verdict over
 * the ledger and the backlog's mirror entries. `closeFixedIssues` runs after each scan:
 * it cites the fix commits, checks each is on GitHub, and closes the issue as the operator's
 * `gh` login. */

import type { TumwaterConfig } from "../config/config-schema.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { gitLines, subjectOfCommit } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { githubTarget } from "../observer/remote-ci.js";
import type { GhRunner } from "./gh.js";
import { isReopened, readGithubIssues, writeGithubIssues, type GithubIssuesLedger } from "./github-issues-state.js";
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
 * only files a live entry never counts as a fix. */
async function fixCommits(root: string, branch: string, n: number, since?: number): Promise<FixCommit[]> {
  const phrase = `mirrors GitHub issues? [^[:cntrl:]]*#${n}([^0-9]|$)`;
  const out = await gitTry(root, "log", "--format=%H%x00%ct%x00%s", "--pickaxe-regex", `-S${phrase}`, branch, "--", ...FIX_ARCHIVES);
  const commits = gitLines(out).map((line) => {
    const [sha = "", seconds = "", subject = ""] = line.split("\0");
    return { sha, subject, at: Number(seconds) * 1000 };
  });
  return commits.filter((commit) => since === undefined || commit.at > since);
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
