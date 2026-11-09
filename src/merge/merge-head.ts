import path from "node:path";
import { isMergedInto, refSha } from "../git/git.js";
import { pinnedMergeEntry } from "../runner/runner-leftover.js";
import { dropMerge, enqueueMerge, staleHeadFile, tornHeadRole } from "./merge-queue.js";
import { mergeRefName } from "../paths.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";

/** Drop a torn queue head. A torn head (torn or foreign — a partial write an older build left,
 * a hand-placed file) makes headMerge read null forever — nothing else drops it, stranding
 * every live entry behind it and pinning their authors' runs via the interlock. Drop it with
 * one warning naming the file (and, when the head's raw bytes still carry a role, that role);
 * the healthy entries behind it are verified in the same poll. When a role is recovered, that
 * role's merge pin is read and, if it resolves, the change is re-queued fresh — in the same
 * shape leftover recovery builds (recoveredMergeEntry: the commit message's real summary,
 * body, high-friction flag, and revision round, plus the authoring run from its Run trailer) —
 * before the drop, so the same poll's queuedMergeFiles sees it and no landing waits forever on
 * the one unreadable file (BUGS.md 2026-09-17). The re-queue is best-effort: a write failure
 * (ENOSPC/EMFILE) or an unreadable commit must not wedge the queue, so the torn head is still
 * dropped (the pin survives and leftover recovery rebuilds the full shape on the role's next
 * run), and the drain's poll never aborts. A torn head with no recoverable role or no pin drops
 * with the warning alone; the crashed entry's commit, if any, still rides its merge ref into
 * next-run leftover recovery. The drop itself can throw (a queue file that is a directory fails
 * fs.rmSync's non-recursive delete — the shape an ENOSPC or immutable queue file takes), and this
 * runs in the poll body with nothing to guard it: report it and leave the head in place rather
 * than end the team, exactly as the drain's dedupe drop guards its own. Exported for
 * test/merge-queue.test.ts's torn-head step. */
export async function dropTornHead(root: string): Promise<void> {
  const stale = staleHeadFile(root);
  if (!stale) return;
  const role = tornHeadRole(stale);
  let requeued = false;
  let requeueFailed = false;
  if (role) {
    const sha = await refSha(root, mergeRefName(role)).catch(() => null);
    if (sha) {
      try {
        // The one pin-to-entry builder (runner-leftover.ts): the recovered commit metadata
        // plus the run from its Run trailer, the same shape leftover recovery builds.
        enqueueMerge(root, await pinnedMergeEntry(root, role, sha));
        requeued = true;
      } catch {
        // A re-queue that cannot be built or written (ENOSPC/EMFILE on the queue write, an
        // unreadable commit) must not abort the poll or strand the head: drop it anyway and let
        // the still-held pin feed next-run leftover recovery, which rebuilds the full shape.
        requeueFailed = true;
      }
    }
  }
  try {
    dropMerge(stale);
  } catch (err) {
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `merge queue head ${path.basename(stale)} could not be dropped: ${errorMessage(err)}`,
    );
    return;
  }
  const roleNote = !role
    ? ""
    : requeued
      ? `; ${role}'s pinned change was re-queued`
      : requeueFailed
        ? `; ${role}'s pinned change could not be re-queued — left for leftover recovery`
        : `; ${role}'s pin is unreadable — left for leftover recovery`;
  warnEventBestEffort(
    root,
    TUMWATER_SOURCE,
    `merge queue head ${path.basename(stale)} is unreadable (torn or foreign) — dropped so the queue keeps moving${roleNote}`,
  );
}

/** Already-merged verdicts cached per (root, sha) against the main head they were computed
 * against. drainMerge (the serial drain) re-runs its dedupe against main every poll, but a
 * queued entry's sha is fixed and merge-base --is-ancestor against the same head always returns
 * the same answer — the verdict can only change when main itself moves (a merge's fast-forward).
 * Serving the verdict
 * from this cache makes a poll whose queue is waiting on busy authors or the merge slot cost one
 * branchHead ref-file read instead of one git spawn per entry, and a moved main recomputes each
 * entry's verdict once (the new head misses the cache). Bounded: verdicts computed against an
 * older head are stale falses no future poll can reuse, so they are the first pruned. */
const mergedIntoMainCache = new Map<string, { head: string; merged: boolean }>();
const MERGED_INTO_MAIN_CACHE_MAX = 128;

/** The cached dedupe verdict for `sha` against main at `head`, computing it through
 * isMergedInto on a cache miss. `head` is the caller's already-resolved main head ("" when main
 * does not exist yet — isMergedInto then fails and reads false, a verdict worth caching like any
 * other since the key matches). */
export async function mergedIntoMain(root: string, sha: string, mainBranch: string, head: string): Promise<boolean> {
  const key = `${root}\u0000${sha}`;
  const hit = mergedIntoMainCache.get(key);
  if (hit?.head === head) return hit.merged;
  const merged = await isMergedInto(root, sha, mainBranch);
  if (mergedIntoMainCache.size >= MERGED_INTO_MAIN_CACHE_MAX && !mergedIntoMainCache.has(key)) {
    for (const [k, v] of mergedIntoMainCache) if (v.head !== head) mergedIntoMainCache.delete(k);
    if (mergedIntoMainCache.size >= MERGED_INTO_MAIN_CACHE_MAX) mergedIntoMainCache.clear();
  }
  mergedIntoMainCache.set(key, { head, merged });
  return merged;
}
