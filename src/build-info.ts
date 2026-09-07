import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitTry } from "./git.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";

/** Build provenance for the compiled harness: which commit `dist/` was compiled from, written
 * by `npm run build` (scripts/stamp-build.mjs) as dist/build-info.json and read back by the
 * running process. tumwater is self-hosting — the fleet edits the harness that runs the fleet —
 * and a `tumwater run` process never reloads its code, so without a stamp nothing can tell
 * whether the running fleet is executing the harness main describes. The stale-build finding of
 * 2026-09-07 (ten days on an Aug 27 build while 350 commits landed, including the review gate's
 * build pre-check) is exactly the blind spot this closes: the orchestrator records the stamp in
 * orchestrator.json and its start event, the dashboards and `doctor` compare it against main, and
 * redeploy.ts restarts onto a fresh build when the inputs changed. */

/** What dist/build-info.json records. */
export interface BuildInfo {
  /** HEAD of the checkout the build was compiled from. */
  sha: string;
  /** Epoch ms when the stamp was written (build completion). */
  builtAt: number;
  /** Absolute path of the project root the build was compiled from (the tsconfig.json dir). */
  root: string;
}

/** The paths whose change makes a build stale — everything tsc compiles into dist/ plus the
 * files that steer the compile. Tests are compiled too but never loaded by the running
 * harness, so a test-only commit does not stale the build; docs and markdown never do. */
export const BUILD_INPUTS = ["src", "package.json", "tsconfig.json"] as const;

/** The dist directory this module was loaded from (…/dist), derived from import.meta.url so it
 * is correct wherever the compiled harness lives (a global install, a worktree's own dist). */
export function distDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  return { sha: info.sha, builtAt: typeof info.builtAt === "number" ? info.builtAt : 0, root: info.root };
}

/** Stamp a freshly compiled `dist` with the commit it was built from — `sha` when the caller
 * already knows it (redeploy compiles a specific head), else `root`'s HEAD. Returns the stamp,
 * or null when `root` has no resolvable HEAD (not a git repo) — then no stamp is written and the
 * build reads as unknown provenance. */
export async function stampBuild(root: string, dist: string, sha?: string): Promise<BuildInfo | null> {
  const head = sha ?? (await gitTry(root, "rev-parse", "HEAD"));
  if (!head) return null;
  const info: BuildInfo = { sha: head, builtAt: Date.now(), root: path.resolve(root) };
  writeJsonFile(buildInfoPath(dist), info);
  return info;
}

/** True when the harness running in `root` was built from `root` itself and that build's commit
 * is part of this repo's history — i.e. this project IS the harness (dogfood). Only then does
 * "main moved" say anything about the running code; a tumwater installed elsewhere and pointed
 * at some other project is never stale with respect to that project's main. */
export async function isSelfHosted(root: string, info: BuildInfo): Promise<boolean> {
  if (path.resolve(root) !== info.root) return false;
  return (await gitTry(root, "cat-file", "-e", `${info.sha}^{commit}`)) !== null;
}

/** What orchestrator.json publishes about the running build (OrchestratorInfo.build), for the
 * dashboards and `doctor`: the stamp plus, once main has been observed, whether the build inputs
 * have moved past it (redeploy.ts computes it; state.ts carries it). */
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
