/** The collector behind `tumwater diff --role <id>`: what change a role holds between its commit
 * and its merge. The committed half is the role branch's unmerged work (commits ahead of the
 * team's main branch, with the patch); the uncommitted half is the role worktree's dirty state.
 * Everything is read-only git plumbing already used elsewhere — this module only wires the pieces
 * into one operator view, degrading like `report` does when the team (or just this role's
 * worktree) does not exist yet. Lives beside the other collectors (src/report/report-data.ts,
 * history-data.ts, status/status-data.ts); the terminal rendering of these views is
 * change-render.ts's half. */

import { knownRoleIdsCached, loadConfigSafe } from "../config/config.js";
import { aheadOfMain, branchExists, countCommitsInRange, currentBranch, targetBranch } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { aheadOfMainDiff, changedFiles } from "../git/git-diff.js";
import { branchName } from "../paths.js";
import { isUsableWorktree } from "../git/worktree.js";
import { roleWorktreeDir } from "../git/slots-state.js";

/** One unmerged commit: its abbreviated sha and subject, from `git log --oneline`. */
interface RoleChangeCommit {
  sha: string;
  subject: string;
}

/** The change one role holds, as `tumwater diff --role <id> --json` prints it. */
export interface RoleChangeView {
  role: string;
  branch: string;
  /** The branch the diff was computed against — what the team targets, resolved the way
   * doctor and the dashboards resolve it (doctor's checkRepo): a configured `baseBranch`
   * wins, then the primary checkout's current branch, then "main". (`run --branch` is
   * per-invocation and invisible to a later CLI query, so baseBranch is the durable way an
   * operator aims the team off the default.) */
  mainBranch: string;
  /** absent: no usable worktree yet (fresh team, never-run role). no-base: the resolved
   * main branch does not exist, so no ahead-of-main comparison is possible. ready: both
   * halves were collected. */
  state: "absent" | "no-base" | "ready";
  /** Commits on the role branch not on mainBranch (0 unless state is "ready"). */
  ahead: number;
  /** Commits on mainBranch the role branch has not picked up (0 unless state is "ready"). */
  behind: number;
  commits: RoleChangeCommit[];
  /** The ahead-of-main patch ("" unless state is "ready"); under `--stat` the `git diff --stat`
   * summary instead. */
  diff: string;
  /** Worktree-relative paths of every uncommitted change (staged, modified, untracked,
   * deleted — changedFiles' porcelain list; empty unless state is "ready"). */
  dirtyFiles: string[];
  /** The uncommitted patch: `git diff HEAD`, so staged and unstaged tracked edits both
   * appear ("" unless state is "ready"). Untracked paths have no diff content — they show
   * in dirtyFiles only. Under `--stat` this holds the stat summary. */
  uncommittedDiff: string;
}

/** The change one role holds as the team-wide view carries it: the RoleChangeView fields
 * minus the two patch strings. The patches stay in the per-role view — a team-wide patch
 * dump would be 13 roles × DIFF_MAX_BYTES — while the counts and commit subjects an operator
 * scans a roster for survive the trip. */
interface TeamRoleChange {
  role: string;
  branch: string;
  /** The per-role view's state, verbatim: "absent" | "no-base" | "ready". */
  state: "absent" | "no-base" | "ready";
  ahead: number;
  behind: number;
  commits: RoleChangeCommit[];
  dirtyFiles: string[];
}

/** The team-wide roster `tumwater diff` (no --role) prints: the baseline every role was
 * compared against, plus one entry per known role in config order. */
export interface TeamChangeView {
  mainBranch: string;
  roles: TeamRoleChange[];
}

/** Collect the pending change of every known role (built-in plus custom role ids, config
 * order — disabled roles included, since a role stopped mid-flight still holds its branch).
 * Each entry goes through collectRoleChange, which keeps the absent/no-base degradation
 * logic single-homed and only computes the patch git-diffs for roles actually holding work
 * (both are "" when a role holds nothing); the team view then drops the patch fields. */
export async function collectTeamChanges(root: string): Promise<TeamChangeView> {
  const roles = await Promise.all(
    knownRoleIdsCached(root).map(async (role) => {
      const view = await collectRoleChange(root, role);
      const { diff: _diff, uncommittedDiff: _uncommittedDiff, ...team } = view;
      return team;
    }),
  );
  // mainBranch is team-wide: collectRoleChange resolves it once per role through the same
  // targetBranch call, so the first entry's value is every entry's value.
  return { mainBranch: roles[0]?.mainBranch ?? "main", roles };
}

/** The per-role views of several roles: the list form of `tumwater diff --role`. */
export interface RoleChangesView {
  mainBranch: string;
  roles: RoleChangeView[];
}

/** Collect each listed role's full change view, entries in the caller's order. */
export async function collectRoleChanges(root: string, roles: string[], opts: { stat?: boolean } = {}): Promise<RoleChangesView> {
  const views = await Promise.all(roles.map((role) => collectRoleChange(root, role, opts)));
  return { mainBranch: views[0]?.mainBranch ?? "main", roles: views };
}

/** The uncommitted patch's cap, matching aheadOfMainDiff's — one shared bound so neither
 * half of the view can print unbounded text. */
const DIFF_MAX_BYTES = 200_000;

/** Collect the change the role holds: both halves of the view, or a degraded state
 * when the worktree or the base branch is missing. Never throws on a degraded team — a
 * query about a role that has not run yet must answer, not fail (report's rationale). */
export async function collectRoleChange(
  root: string,
  role: string,
  opts: { stat?: boolean } = {},
): Promise<RoleChangeView> {
  const branch = branchName(role);
  const { config } = loadConfigSafe(root);
  const mainBranch = targetBranch(config?.baseBranch, await currentBranch(root));
  const empty: Omit<RoleChangeView, "state"> = {
    role,
    branch,
    mainBranch,
    ahead: 0,
    behind: 0,
    commits: [],
    diff: "",
    dirtyFiles: [],
    uncommittedDiff: "",
  };
  if (!(await branchExists(root, mainBranch))) return { ...empty, state: "no-base" };
  // The role's checkout comes from the pool resolver (slots-state.ts): a slot leased for its
  // run or pinned for it, else the legacy worktree. A null or unusable directory is the same
  // operator situation — this role holds nothing inspectable yet — so worktree.ts's shared
  // usability probe still answers the final question.
  const wt = await roleWorktreeDir(root, role);
  if (wt === null || !(await isUsableWorktree(wt))) return { ...empty, state: "absent" };
  const ahead = await aheadOfMain(wt, mainBranch);
  const behind = await countCommitsInRange(wt, `HEAD..${mainBranch}`);
  const commits = parseOnelineLog(await gitTry(wt, "log", "--oneline", `${mainBranch}..HEAD`));
  // Under opts.stat both halves hold the uncapped `git diff --stat` summary (one line per file).
  const diff =
    ahead === 0
      ? ""
      : opts.stat
        ? ((await gitTry(wt, "diff", "--stat", `${mainBranch}...HEAD`)) ?? "")
        : await aheadOfMainDiff(wt, mainBranch);
  const dirtyFiles = await changedFiles(wt);
  const uncommittedDiff =
    dirtyFiles.length === 0
      ? ""
      : opts.stat
        ? ((await gitTry(wt, "diff", "--stat", "HEAD")) ?? "")
        : await cappedWorkingDiff(wt);
  return { ...empty, state: "ready", ahead, behind, commits, diff, dirtyFiles, uncommittedDiff };
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
