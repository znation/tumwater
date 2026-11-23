import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitTry } from "../git/git-run.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { finiteNumber } from "../files/json-object.js";
import { commitExists, refSha } from "../git/git.js";
import { shortSha } from "../text/format.js";
import { packageVersion } from "../version.js";

/** Build provenance for the compiled harness: which commit `dist/` was compiled from, written by
 * `npm run build` (scripts/stamp-build.mjs) as dist/build-info.json and read back by the running
 * process. tumwater is self-hosting — the team edits the harness that runs the team — and a
 * `tumwater run` process never reloads its code, so without a stamp nothing can tell whether the
 * running team is executing the harness main describes. The stale-build finding of 2026-09-07 (ten
 * days on an Aug 27 build while 350 commits merged, including the review gate's build pre-check) is
 * exactly the blind spot this closes: the orchestrator records the stamp in orchestrator.json and
 * its start event, the dashboards and `doctor` compare it against main, and redeploy.ts restarts
 * onto a fresh build when the inputs changed. */

/** What dist/build-info.json records. */
export interface BuildInfo {
  /** HEAD of the checkout the build was compiled from. */
  sha: string;
  /** Epoch ms when the stamp was written (build completion). */
  builtAt: number;
  /** Absolute path of the project root the build was compiled from (the tsconfig.json dir). */
  root: string;
  /** The npm release version this build was compiled from — set only when the stamped commit is
   * the one the release tag `v<version>` points at. Deliberately NOT read from package.json at
   * run time: main always carries the NEXT version (scripts/release.mjs), so a checkout build
   * that printed its package.json version would claim an unreleased release. Only a build
   * compiled from the tagged commit is that release; every other build leaves this out and its
   * observers show the commit. */
  release?: string;
}

/** The paths whose change makes a build stale — everything tsc compiles into dist/ plus the
 * files that steer the compile. Tests are compiled too but never loaded by the running
 * harness, so a test-only commit does not stale the build; docs and markdown never do. */
export const BUILD_INPUTS = ["src", "package.json", "tsconfig.json"] as const;

/** The comma-joined BUILD_INPUTS list, for operator-facing text (doctor's stale-build detail and
 * the dashboards' stale warning) so every message names the inputs from one definition. */
export const STALE_INPUTS_LABEL = BUILD_INPUTS.join(", ");

/** The dist directory this module was loaded from (…/dist), derived from import.meta.url so it
 * is correct wherever the compiled harness lives (a global install, a worktree's own dist). */
export function distDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Where a dist directory keeps its stamp. */
export function buildInfoPath(dist: string): string {
  return path.join(dist, "build-info.json");
}

/** Read a dist directory's build stamp (the running harness's by default); null when the dist
 * was compiled without one (a bare `tsc`) or the file is unreadable — a missing stamp is "unknown
 * provenance", never an error. */
export function readBuildInfo(dist = distDir()): BuildInfo | null {
  const info = readJsonFile<Partial<BuildInfo>>(buildInfoPath(dist));
  if (!info || typeof info.sha !== "string" || !info.sha || typeof info.root !== "string") return null;
  // A foreign or empty release drops like the other optional fields: a stamp whose release half
  // cannot be trusted shows its commit, which is always true.
  const release = typeof info.release === "string" && info.release !== "" ? info.release : undefined;
  return { sha: info.sha, builtAt: finiteNumber(info.builtAt, 0), root: info.root, ...(release ? { release } : {}) };
}

/** The npm version `root`'s package.json declares, when its HEAD commit `sha` is exactly the one
 * the release tag `v<version>` points at — the only build that IS that release. `^{commit}` peels
 * an annotated tag to its commit, so a tag object matches too. No package.json, no version field,
 * no such tag, a tag on another commit, or any failed git read (gitTry's null) yields undefined:
 * stamping never fails over a version it cannot name. */
async function releaseOfTaggedCommit(root: string, sha: string): Promise<string | undefined> {
  const { version } = packageVersion(path.join(root, "package.json"));
  if (version === undefined) return undefined;
  const tagged = await gitTry(root, "rev-parse", "--verify", `refs/tags/v${version}^{commit}`);
  return tagged === sha ? version : undefined;
}

/** Stamp a freshly compiled `dist` with the commit it was built from — `sha` when the caller
 * already knows it (redeploy compiles a specific head), else `root`'s HEAD. Returns the stamp,
 * or null when `root` has no resolvable HEAD (not a git repo) — then no stamp is written and the
 * build reads as unknown provenance. */
export async function stampBuild(root: string, dist: string, sha?: string): Promise<BuildInfo | null> {
  const head = sha ?? (await refSha(root, "HEAD"));
  if (!head) return null;
  const release = await releaseOfTaggedCommit(root, head);
  const info: BuildInfo = { sha: head, builtAt: Date.now(), root: path.resolve(root), ...(release ? { release } : {}) };
  // Atomic: a process killed mid-write (a redeploy swap, a timeout-killed `npm test`) would
  // otherwise leave a torn stamp, and readBuildInfo reads that as no provenance at all —
  // createRedeployer then returns null and the team never self-redeploys onto newer main,
  // the exact blind spot the stamp exists to close.
  writeJsonAtomic(buildInfoPath(dist), info);
  return info;
}

/** True when the harness running in `root` was built from `root` itself and that build's commit
 * is part of this repo's history — i.e. this project IS the harness (dogfood). Only then does
 * "main moved" say anything about the running code; a tumwater installed elsewhere and pointed
 * at some other project is never stale with respect to that project's main. */
export async function isSelfHosted(root: string, info: BuildInfo): Promise<boolean> {
  if (path.resolve(root) !== info.root) return false;
  return commitExists(root, info.sha);
}

/** What orchestrator.json publishes about the running build (OrchestratorInfo.build), for the
 * dashboards and `doctor`: the stamp plus, once main has been observed, whether the build inputs
 * have moved past it (redeploy.ts computes it; orchestrator.ts publishes it via
 * team/team-orchestrator-info-types.ts's OrchestratorInfo). */
export interface BuildStatus {
  sha: string;
  builtAt: number;
  /** True when main's build inputs differ from the build's commit (buildStaleness). Absent until
   * main has been observed once. */
  stale?: boolean;
  /** Commits on main since the build's commit (buildStaleness). */
  aheadCommits?: number;
  /** The main head the staleness verdict was computed for. */
  checkedHead?: string;
  /** True while a self-redeploy onto `checkedHead` is under way — verifying main, compiling, or
   * draining in-flight runs (src/redeploy/redeployer.ts). The stale build is about to be
   * replaced. */
  restartPending?: boolean;
  /** Which step of the self-redeploy is HOLDING new runs while `restartPending` stands, and since
   * when. Absent when no hold stands (and from an orchestrator that predates the field). Without
   * it a team held behind a 5–15 minute check of main showed every role idle and only "restarts
   * when idle" in the header, which read as a stuck team (2026-10-30). */
  restartHold?: RestartHold;
  /** Why the self-redeploy onto `checkedHead` was REFUSED — a red main, a failed compile, a
   * failed swap. Set instead of `restartPending`, and the important half: the team then keeps
   * running the stale build with no retry until main moves, which a bare `stale: true` cannot
   * distinguish from a restart that is seconds away. Two non-latched reasons share the field: a
   * post-restart cooldown (it lapses on its own) and a new build that could not start here (the
   * startup gate is re-asked every poll, so repairing the environment clears it). */
  restartBlocked?: string;
  /** The npm release version the build was compiled from (BuildInfo.release) — present exactly
   * when the build is a published release, absent for a checkout build, which shows its commit.
   * Staleness and self-redeploy still key on `sha` alone. */
  release?: string;
  /** Main's tip, when its build inputs differ from the running build's but no commit that
   * carries them has passed main's check yet: while the main watch verifies main, redeploy moves
   * only to a passing commit (redeployTarget), so `checkedHead` stays behind and `stale` reads
   * false. `aheadCommits` counts main's commits since the build's. Absent while redeploy's target
   * is main's tip. Without it a team whose main checks kept timing out ran an old build for
   * hours with nothing on any surface saying an update was waiting (BUGS.md 2026-10-29). */
  waitingForCheck?: { head: string; aheadCommits: number };
}

/** How an operator names the running harness: the npm release version when the build IS a
 * published release (`release`), and the 8-character commit otherwise — the same abbreviation
 * every surface already uses. One home so the GUI's Version row and `doctor`'s running line
 * cannot drift on which half of the stamp they show; a surface that also wants the commit (the
 * GUI tooltip) prints the label and appends `shortSha(sha)` itself. Null (no harness, or an
 * unstamped dist) reads "" — nothing to name. */
export function buildLabel(build: Pick<BuildStatus, "sha" | "release"> | null): string {
  if (!build) return "";
  return build.release ? build.release : shortSha(build.sha);
}

/** The same stamp as one phrase, without a leading separator: `version 0.8.1 (build a1b2c3d4)`
 * for a build compiled from a published release, `build a1b2c3d4` for any other build. The lead
 * every surface puts in front of the build badge's suffixes — the `tumwater status` header
 * (badges.ts's buildBadge) and `tumwater start`'s banner — so a release install reads the version
 * it installed on both, and a checkout keeps naming its commit. It keeps `buildLabel` as the
 * answer to which half leads (INV-A8) and appends the commit only when the label is a version,
 * because a bug report against an installed release still needs the commit it was tagged from.
 * Empty for no stamp. */
export function buildStampPhrase(build: Pick<BuildStatus, "sha" | "release"> | null): string {
  if (!build) return "";
  return build.release
    ? `version ${buildLabel(build)} (build ${shortSha(build.sha)})`
    : `build ${buildLabel(build)}`;
}

/** The steps a self-redeploy holds new runs through, in order: main's check of the target head
 * has not answered yet, the staged build of it is compiling, then the built update waits while
 * the runs already in flight finish. */
export const RESTART_HOLD_STAGES = ["checking", "compiling", "finishing"] as const;
export type RestartHoldStage = (typeof RESTART_HOLD_STAGES)[number];

/** BuildStatus.restartHold: the step a self-redeploy's hold is in. */
export interface RestartHold {
  stage: RestartHoldStage;
  /** When the hold entered this stage (epoch ms). */
  since: number;
  /** The in-flight runs the drain waits for, role and director runs together — `finishing` only. */
  runs?: number;
}

/** How far the running build is behind `mainHead`. */
export interface BuildStaleness {
  /** True when the build inputs (BUILD_INPUTS) differ between the build's commit and main. */
  stale: boolean;
  /** Commits on main since the build's commit (0 when main is at or behind it). */
  aheadCommits: number;
}

/** Compare a build's commit against main's head over the build inputs only: commits touching
 * just tests or markdown leave the running code unchanged and never count as stale. Null when
 * `buildSha` is not a commit of this repo (the build came from somewhere else — see
 * isSelfHosted). One `git diff --quiet` plus one `rev-list --count`; callers run it only when
 * main's head changes. */
export async function buildStaleness(root: string, buildSha: string, mainHead: string): Promise<BuildStaleness | null> {
  if (buildSha === mainHead) return { stale: false, aheadCommits: 0 };
  const count = await gitTry(root, "rev-list", "--count", `${buildSha}..${mainHead}`);
  if (count === null) return null; // Unknown commit — not this repo's build.
  // `diff --quiet` exits 0 (stdout "") when the inputs are identical and 1 (null via gitTry)
  // when they differ; both revisions are known to exist by now, so null means "differs".
  const same = await gitTry(root, "diff", "--quiet", buildSha, mainHead, "--", ...BUILD_INPUTS);
  return { stale: same === null, aheadCommits: Number.parseInt(count, 10) || 0 };
}
