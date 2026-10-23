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
import { aheadOfMainDiff, aheadOfMainFiles, changedFiles } from "../git/git-diff.js";
import { isAbsolute } from "node:path";
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
  /** The repo-relative path the view is limited to; present only under `--path`, so the
   * unscoped JSON (`diff --json`, the dashboard's /api/diff) is unchanged. */
  path?: string;
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

/** The repo-wide half of a change collection, resolved once and shared by every role instead
 * of re-computed per role: the main-branch name (a configured baseBranch wins, else the
 * primary checkout's current branch, else "main") and whether that branch exists are team-wide
 * facts — they do not depend on which role's worktree is being asked, and every role in a
 * roster used to recompute the same two values through the same two git reads. A 6-role roster
 * therefore ran 2×N repo-level git reads a single pass covers; the per-role work (that role's
 * own worktree diffs) is unchanged and still runs in the loop. */
interface ChangeScope {
  mainBranch: string;
  mainPresent: boolean;
}

/** Resolve the team-wide scope both collection entry points share: read the config once for a
 * configured baseBranch, ask the primary checkout for its current branch once, and check the
 * resolved main branch exists once. */
async function resolveChangeScope(root: string): Promise<ChangeScope> {
  const { config } = loadConfigSafe(root);
  const mainBranch = targetBranch(config?.baseBranch, await currentBranch(root));
  return { mainBranch, mainPresent: await branchExists(root, mainBranch) };
}

/** Collect the pending change of every known role (built-in plus custom role ids, config
 * order — disabled roles included, since a role stopped mid-flight still holds its branch).
 * Each entry goes through collectRoleChangeAt with the team-wide scope resolved once up
 * front, which keeps the absent/no-base degradation logic single-homed and only computes
 * the patch git-diffs for roles actually holding work (both are "" when a role holds
 * nothing); the team view then drops the patch fields. */
export async function collectTeamChanges(root: string): Promise<TeamChangeView> {
  const scope = await resolveChangeScope(root);
  const roles = await Promise.all(
    knownRoleIdsCached(root).map(async (role) => {
      const view = await collectRoleChangeAt(root, role, scope);
      const { diff: _diff, uncommittedDiff: _uncommittedDiff, ...team } = view;
      return team;
    }),
  );
  return { mainBranch: scope.mainBranch, roles };
}

/** The per-role views of several roles: the list form of `tumwater diff --role`. */
export interface RoleChangesView {
  mainBranch: string;
  roles: RoleChangeView[];
}

/** Collect each listed role's full change view, entries in the caller's order. */
export async function collectRoleChanges(root: string, roles: string[], opts: { stat?: boolean; path?: string } = {}): Promise<RoleChangesView> {
  const scope = await resolveChangeScope(root);
  const views = await Promise.all(roles.map((role) => collectRoleChangeAt(root, role, scope, opts)));
  return { mainBranch: scope.mainBranch, roles: views };
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
  opts: { stat?: boolean; path?: string } = {},
): Promise<RoleChangeView> {
  return collectRoleChangeAt(root, role, await resolveChangeScope(root), opts);
}

/** One role's change against a pre-resolved team scope: the per-role body of every entry point.
 * Shared so the team-wide mainBranch/branch-exists reads are spent once per collection instead
 * of once per role (the roster and list forms pass a scope resolved before the Promise.all). */
async function collectRoleChangeAt(
  root: string,
  role: string,
  scope: ChangeScope,
  opts: { stat?: boolean; path?: string } = {},
): Promise<RoleChangeView> {
  const branch = branchName(role);
  const mainBranch = scope.mainBranch;
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
  if (!scope.mainPresent) return { ...empty, state: "no-base" };
  // The role's checkout comes from the pool resolver (slots-state.ts): a slot leased for its
  // run or pinned for it, else the legacy worktree. A null or unusable directory is the same
  // operator situation — this role holds nothing inspectable yet — so worktree.ts's shared
  // usability probe still answers the final question.
  const wt = await roleWorktreeDir(root, role);
  if (wt === null || !(await isUsableWorktree(wt))) return { ...empty, state: "absent" };
  const ahead = await aheadOfMain(wt, mainBranch);
  const behind = await countCommitsInRange(wt, `HEAD..${mainBranch}`);
  // Under opts.path every git call below is limited to that path through a literal pathspec.
  const spec = opts.path === undefined ? [] : ["--", `:(literal)${opts.path}`];
  const commits = parseOnelineLog(await gitTry(wt, "log", "--oneline", `${mainBranch}..HEAD`, ...spec));
  // Under opts.stat both halves hold the uncapped `git diff --stat` summary (one line per file).
  // A view: a diff git fails to produce shows empty, as it always did.
  const diff =
    commits.length === 0
      ? ""
      : opts.stat
        ? ((await gitTry(wt, "diff", "--stat", `${mainBranch}...HEAD`, ...spec)) ?? "")
        : await aheadOfMainDiff(wt, mainBranch, DIFF_MAX_BYTES, spec).catch(() => "");
  // A view: a git that fails to answer shows no uncommitted edits, as it always did.
  const dirtyFiles = (await changedFiles(wt).catch(() => [])).filter((f) => inPath(f, opts.path));
  const uncommittedDiff =
    dirtyFiles.length === 0
      ? ""
      : opts.stat
        ? ((await gitTry(wt, "diff", "--stat", "HEAD", ...spec)) ?? "")
        : await cappedWorkingDiff(wt, spec);
  return {
    ...empty,
    state: "ready",
    ahead,
    behind,
    commits,
    diff,
    dirtyFiles,
    uncommittedDiff,
    ...(opts.path === undefined ? {} : { path: opts.path }),
  };
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

/** The normalised repo-relative `path` scope of a role's change view (shared by `diff --role
 * --path` and the dashboard's `GET /api/diff?role&path`): leading `./` pieces and trailing `/`
 * characters stripped; null for an empty, `.`, absolute or `..`-bearing result. */
export function normalizeDiffPath(raw: string): string | null {
  const norm = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  const bad = norm === "" || norm === "." || isAbsolute(norm) || norm.split("/").includes("..");
  return bad ? null : norm;
}

/** Whether a porcelain path lies under the `--path` scope (always true without one): the path
 * itself, a file below it, or an untracked-directory entry (trailing `/`) that contains it. */
function inPath(f: string, path: string | undefined): boolean {
  if (path === undefined) return true;
  return f === path || f.startsWith(path + "/") || (f.endsWith("/") && path.startsWith(f));
}

/** The worktree's uncommitted tracked-change patch, capped at DIFF_MAX_BYTES like
 * aheadOfMainDiff: over the cap, a truncation note plus the --stat summary — bounded
 * output that still names every changed file. `git diff HEAD` covers staged and unstaged
 * tracked edits in one patch (plain `git diff` would show unstaged only, dropping a staged
 * edit the dirtyFiles list already counts); untracked paths have no diff content anywhere,
 * so they appear in the file list alone. */
async function cappedWorkingDiff(wt: string, spec: string[] = []): Promise<string> {
  const full = (await gitTry(wt, "diff", "HEAD", ...spec)) ?? "";
  if (full.length <= DIFF_MAX_BYTES) return full;
  const stat = (await gitTry(wt, "diff", "--stat", "HEAD", ...spec)) ?? "";
  return (
    `[uncommitted diff truncated: the full diff is ${full.length} bytes; showing --stat]\n\n` + stat
  );
}

/** One file two or more roles' pending changes touch, with the roles that hold it. */
interface ChangeOverlap {
  path: string;
  roles: string[];
}

/** The `tumwater diff --overlaps` document. */
export interface ChangeOverlapsView {
  mainBranch: string;
  state: "no-base" | "ready";
  overlaps: ChangeOverlap[];
}

/** The paths two or more distinct roles hold: a role's duplicate path counts once, roles stay
 * in holdings order, paths sort by plain `<` comparison. */
export function fileOverlaps(holdings: { role: string; files: string[] }[]): ChangeOverlap[] {
  const byPath = new Map<string, string[]>();
  for (const { role, files } of holdings) {
    for (const path of new Set(files)) {
      const roles = byPath.get(path);
      if (roles === undefined) byPath.set(path, [role]);
      else roles.push(role);
    }
  }
  return [...byPath.entries()]
    .filter(([, roles]) => roles.length >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, roles]) => ({ path, roles }));
}

/** Keep only the overlaps naming a listed role; each kept entry still names every holder. */
export function scopeChangeOverlaps(view: ChangeOverlapsView, roles: string[]): ChangeOverlapsView {
  return { ...view, overlaps: view.overlaps.filter((o) => o.roles.some((r) => roles.includes(r))) };
}

/** Keep only the overlaps at or under `path` (normalized), by the `inPath` rule
 * `diff --role --path` uses. */
export function scopeChangeOverlapsToPath(view: ChangeOverlapsView, path: string): ChangeOverlapsView {
  return { ...view, overlaps: view.overlaps.filter((o) => inPath(o.path, path)) };
}

/** Collect the files two or more roles hold, committed ahead of main or uncommitted. Computes
 * file names only — no patch — and skips a role with no usable checkout. */
export async function collectChangeOverlaps(root: string): Promise<ChangeOverlapsView> {
  const { mainBranch, mainPresent } = await resolveChangeScope(root);
  if (!mainPresent) return { mainBranch, state: "no-base", overlaps: [] };
  const held = await Promise.all(
    knownRoleIdsCached(root).map(async (role) => {
      const wt = await roleWorktreeDir(root, role);
      if (wt === null || !(await isUsableWorktree(wt))) return null;
      const committed =
        (await aheadOfMain(wt, mainBranch)) > 0 ? await aheadOfMainFiles(wt, mainBranch).catch(() => []) : [];
      return { role, files: [...committed, ...(await changedFiles(wt).catch(() => []))] };
    }),
  );
  const holdings = held.filter((h): h is { role: string; files: string[] } => h !== null);
  return { mainBranch, state: "ready", overlaps: fileOverlaps(holdings) };
}
