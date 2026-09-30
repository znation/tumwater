/** The collector and renderer behind `tumwater diff --role <id>`: what change a loop holds
 * between its commit and its merge. The committed half is the loop branch's unlanded work
 * (commits ahead of the fleet's main branch, with the patch); the uncommitted half is the
 * loop worktree's dirty state. Everything is read-only git plumbing already used elsewhere —
 * this module only wires the pieces into one operator view, degrading like `report` does
 * when the fleet (or just this role's worktree) does not exist yet. */

import fs from "node:fs";
import { loadConfigSafe } from "../config.js";
import { aheadOfMain, branchExists, currentBranch, gitTry } from "../git.js";
import { aheadOfMainDiff, changedFiles } from "../git-diff.js";
import { branchName, worktreePath } from "../paths.js";

/** One unlanded commit: its abbreviated sha and subject, from `git log --oneline`. */
interface RoleChangeCommit {
  sha: string;
  subject: string;
}

/** The change one role holds, as `tumwater diff --role <id> --json` prints it. */
interface RoleChangeView {
  role: string;
  branch: string;
  /** The branch the diff was computed against — what the fleet targets, resolved the way
   * doctor and the dashboards resolve it (doctor's checkRepo): a configured `baseBranch`
   * wins, then the primary checkout's current branch, then "main". (`run --branch` is
   * per-invocation and invisible to a later CLI query, so baseBranch is the durable way an
   * operator aims the fleet off the default.) */
  mainBranch: string;
  /** absent: no usable worktree yet (fresh fleet, never-run loop). no-base: the resolved
   * main branch does not exist, so no ahead-of-main comparison is possible. ready: both
   * halves were collected. */
  state: "absent" | "no-base" | "ready";
  /** Commits on the loop branch not on mainBranch (0 unless state is "ready"). */
  ahead: number;
  commits: RoleChangeCommit[];
  /** The ahead-of-main patch ("" unless state is "ready"). */
  diff: string;
  /** Worktree-relative paths of every uncommitted change (staged, modified, untracked,
   * deleted — changedFiles' porcelain list; empty unless state is "ready"). */
  dirtyFiles: string[];
  /** The uncommitted patch: `git diff HEAD`, so staged and unstaged tracked edits both
   * appear ("" unless state is "ready"). Untracked paths have no diff content — they show
   * in dirtyFiles only. */
  uncommittedDiff: string;
}

/** The uncommitted patch's cap, matching aheadOfMainDiff's — one shared bound so neither
 * half of the view can print unbounded text. */
const DIFF_MAX_BYTES = 200_000;

/** The branch the fleet targets, for read-only views: configured `baseBranch`, else the
 * primary checkout's current branch, else "main" — doctor's checkRepo resolution with
 * status.ts's detached-HEAD fallback, so every dashboard answers "what is main?" alike. */
async function resolveMainBranch(root: string): Promise<string> {
  const { config } = loadConfigSafe(root);
  return config?.baseBranch ?? (await currentBranch(root)) ?? "main";
}

/** Collect the change the role's loop holds: both halves of the view, or a degraded state
 * when the worktree or the base branch is missing. Never throws on a degraded fleet — a
 * query about a loop that has not run yet must answer, not fail (report's rationale). */
export async function collectRoleChange(root: string, role: string): Promise<RoleChangeView> {
  const branch = branchName(role);
  const mainBranch = await resolveMainBranch(root);
  const empty: Omit<RoleChangeView, "state"> = {
    role,
    branch,
    mainBranch,
    ahead: 0,
    commits: [],
    diff: "",
    dirtyFiles: [],
    uncommittedDiff: "",
  };
  if (!(await branchExists(root, mainBranch))) return { ...empty, state: "no-base" };
  const wt = worktreePath(root, role);
  // A missing directory or a dead worktree registration (pruned, half-deleted) is the same
  // operator situation: this loop holds nothing inspectable yet.
  if (!fs.existsSync(wt) || (await gitTry(wt, "rev-parse", "--git-dir")) === null) {
    return { ...empty, state: "absent" };
  }
  const ahead = await aheadOfMain(wt, mainBranch);
  const commits = parseOnelineLog(await gitTry(wt, "log", "--oneline", `${mainBranch}..HEAD`));
  const diff = ahead === 0 ? "" : await aheadOfMainDiff(wt, mainBranch);
  const dirtyFiles = await changedFiles(wt);
  const uncommittedDiff = dirtyFiles.length === 0 ? "" : await cappedWorkingDiff(wt);
  return { ...empty, state: "ready", ahead, commits, diff, dirtyFiles, uncommittedDiff };
}

/** Parse `git log --oneline` output into {sha, subject} pairs — sha up to the first space,
 * the rest of the line the subject. Blank trailing lines (runGit's trimEnd makes them
 * unlikely) are skipped. */
function parseOnelineLog(out: string | null): RoleChangeCommit[] {
  if (!out) return [];
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const cut = line.indexOf(" ");
      return cut < 0 ? { sha: line, subject: "" } : { sha: line.slice(0, cut), subject: line.slice(cut + 1) };
    });
}

/** The worktree's uncommitted tracked-change patch, capped at DIFF_MAX_BYTES like
 * aheadOfMainDiff: over the cap, a truncation note plus the --stat summary — bounded
 * output that still names every changed file. `git diff HEAD` covers staged and unstaged
 * tracked edits in one patch (plain `git diff` would show unstaged only, dropping a staged
 * edit the dirtyFiles list already counts); untracked paths have no diff content anywhere,
 * so they appear in the file list alone. */
async function cappedWorkingDiff(wt: string): Promise<string> {
  const full = (await gitTry(wt, "diff", "HEAD")) ?? "";
  if (full.length <= DIFF_MAX_BYTES) return full;
  const stat = (await gitTry(wt, "diff", "--stat", "HEAD")) ?? "";
  return (
    `[uncommitted diff truncated: the full diff is ${full.length} bytes; showing --stat]\n\n` + stat
  );
}

/** Render the view as the operator-facing text `tumwater diff --role <id>` prints. */
export function renderRoleChange(view: RoleChangeView): string {
  if (view.state === "absent") return `no worktree for ${view.role}`;
  if (view.state === "no-base") return `main branch ${view.mainBranch} does not exist`;
  if (view.ahead === 0 && view.dirtyFiles.length === 0) return `no pending change for ${view.role}`;
  const lines = [
    `${view.role}: ${view.branch}, ${view.ahead} commit${view.ahead === 1 ? "" : "s"} ahead of ${view.mainBranch}` +
      (view.dirtyFiles.length > 0 ? `, ${view.dirtyFiles.length} uncommitted file${view.dirtyFiles.length === 1 ? "" : "s"}` : ""),
  ];
  for (const c of view.commits) lines.push(`${c.sha} ${c.subject}`);
  if (view.diff) lines.push("", view.diff.trimEnd());
  if (view.dirtyFiles.length > 0) {
    lines.push("", `uncommitted (${view.dirtyFiles.length} file${view.dirtyFiles.length === 1 ? "" : "s"}): ${view.dirtyFiles.join(", ")}`);
    if (view.uncommittedDiff) lines.push("", view.uncommittedDiff.trimEnd());
  }
  return lines.join("\n");
}
