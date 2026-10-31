import { baselineCache } from "../baseline/main-baseline.js";
import { gitLines } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { mirrorWorktreePath } from "../paths.js";

/** The commit self-redeploy should run, split out of src/baseline/main-baseline.ts — whose
 * concern is main's verdict cache and the one-run-per-SHA check machinery — because choosing
 * WHICH commit the redeployer runs is redeploy policy, not the baseline's: the two
 * `redeployTarget` branches decide redeploy's behavior (target the tip, fall back to the newest
 * older green, or hold on the build) and their only consumer is the redeploy layer
 * (orchestrator-poll.ts's `pollRedeploy`). The verdict cache stays in main-baseline.ts; this
 * module imports it read-only, so a target-selection change cannot touch the cache's write
 * policy and vice versa. `watchVerifiesMain` — the main-watch mode predicate that picks
 * `redeployTarget`'s `watched` branch — stays beside the watch in src/baseline/main-baseline.ts:
 * the review pre-check reads it too, and the review layer does not import redeploy. */

/** How many first-parent commits below main's tip redeployTarget looks at. */
const REDEPLOY_WALK_MAX = 64;

/** The first-parent walk `newestGreenAboveBuild` runs, keyed by (worktree, tip). The walk is a
 * `git rev-list` spawn (~10 ms measured, 64-commit bound) and it runs on every orchestrator poll
 * while self-redeploy is on — but its list is fixed per tip (main is only ever fast-forwarded,
 * so a tip's ancestor list never changes) and its ANSWER is re-derived from `baselineCache` on
 * every call, not cached here. Caching only the list, and re-deriving the answer each poll, makes
 * a poll whose tip has not moved cost zero git spawns, while a moved tip or a new verdict still
 * changes the answer the very next poll. Bounded like `baselineCache`: tips are never reused,
 * so an entry is dead once a newer tip supersedes it. */
const redeployWalkCache = new Map<string, string[]>();
const REDEPLOY_WALK_CACHE_MAX = 32;

/** The newest first-parent commit below `tip`, down to and through `buildSha`, with a green
 * cached verdict — the walk+scan redeployTarget's watched and un-watched branches share. Only
 * their fallback differs: `notOnHistory` when `buildSha` is not on the first-parent walk at all
 * (the caller keeps today's answer, `tip`), `onHistoryNone` when it is but nothing above it is
 * green (watched keeps the build; un-watched keeps `tip`). Never throws: a git failure leaves
 * the walk empty, so the fallback answers. */
async function newestGreenAboveBuild(wt: string, tip: string, buildSha: string, notOnHistory: string, onHistoryNone: string): Promise<string> {
  const key = `${wt}\u0000${tip}`;
  let walk = redeployWalkCache.get(key);
  if (walk === undefined) {
    walk = await firstParentWalk(wt, tip, REDEPLOY_WALK_MAX);
    if (redeployWalkCache.size >= REDEPLOY_WALK_CACHE_MAX) {
      const oldest = redeployWalkCache.keys().next().value;
      if (oldest !== undefined) redeployWalkCache.delete(oldest);
    }
    redeployWalkCache.set(key, walk);
  }
  const buildAt = walk.indexOf(buildSha);
  if (buildAt === -1) return notOnHistory;
  for (const sha of walk.slice(0, buildAt)) {
    if (baselineCache.get(sha)?.status === "green") return sha;
  }
  return onHistoryNone;
}

/** The `git rev-list --first-parent --max-count=<max> <ref>` read `newestGreenAboveBuild`
 * runs — the same walk shape main-baseline.ts's own three first-parent scans share, spelled
 * here too so a change to the walk shape (the bound, the `--first-parent` flag) lands in one
 * place per module. Never throws: a git failure is an empty list, which the caller treats as
 * its no-history fallback answer. */
async function firstParentWalk(wt: string, ref: string, max: number): Promise<string[]> {
  return gitLines(await gitTry(wt, "rev-list", "--first-parent", `--max-count=${max}`, ref));
}

/** The commit self-redeploy should run: main's newest first-parent commit with a green full-check
 * verdict in the cache (observed or inherited) that is newer than the running build `buildSha`,
 * looking at most REDEPLOY_WALK_MAX commits down from `tip`.
 *
 * With `watched` false (the default, a project whose main the watch does not verify), a tip the
 * cache has no verdict for is the target as is — the redeployer checks it. A tip whose cached red
 * was observed in the redeployer's mirror worktree (mirrorWorktreePath of `wt`) falls back to the
 * newest older green above the build. Any other red may be another worktree's environmental one,
 * which the redeployer re-verifies; a build that is not a first-parent ancestor of `tip`, or no
 * green, also leaves the tip the target, and the redeployer blocks that commit alone.
 *
 * With `watched` true (watchVerifiesMain), the watch supplies the verdicts and the redeployer only
 * reads them: walk `tip`'s first-parent history down to `buildSha` and return the first commit
 * whose cached verdict is green — a cached red is walked past, never targeted. With no green
 * above the build, target `buildSha` itself, so buildStaleness reads it as not stale and no
 * episode, hold or pre-warm starts until the watch calls a newer commit green. A build that is
 * not a first-parent ancestor of `tip` keeps today's answer (`tip`, which the redeployer
 * checks), as does `watched` false. Every target `watched` picks has a cached green, so
 * mainIsGreen on it is a cache hit and the redeployer starts no suite.
 * The cache holds only full-check verdicts, so a cheaper command's green never makes a commit
 * deployable.
 * Never throws: a git failure leaves the tip as the target. */
export async function redeployTarget(wt: string, tip: string, buildSha: string, watched = false): Promise<string> {
  if (watched) {
    if (tip === "") return tip;
    return newestGreenAboveBuild(wt, tip, buildSha, tip, buildSha);
  }
  const red = baselineCache.get(tip);
  if (tip === "" || red?.status !== "red" || !(red.redFrom ?? []).includes(mirrorWorktreePath(wt))) return tip;
  return newestGreenAboveBuild(wt, tip, buildSha, tip, tip);
}
