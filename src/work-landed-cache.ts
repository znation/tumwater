/** The need-based deferral's cached "did qualifying work land on main since <head>?" check,
 * split out of orchestrator.ts (whose runOrchestrator had grown it as an inline closure over
 * the poll-loop state). The verdict policy itself lives in scheduling.ts (workLanded) — this
 * module adds only the caching layer around it plus the one git query that feeds it.
 *
 * Caching rule (PLANS.md "Prioritize loops by need"): verdicts are cached per base head so a
 * quiet fleet pays no git cost in steady state. A TRUE verdict is monotone under
 * fast-forward-only main movement — once work has landed in (sinceHead, main] it stays
 * there — so true heads never re-evaluate. A FALSE verdict is valid exactly while main sits at
 * the head it was checked against: the range cannot grow until main moves, so a cached false
 * skips the `git log` entirely and re-checks once when main's head changes (a false can flip to
 * true only on such movement — caching it unconditionally would defer a role forever after the
 * very commit that should wake it). Both caches are bounded, so a long-running fleet cannot
 * grow them unbounded. */

import { subjectsBetween } from "./git.js";
import { workLanded } from "./scheduling.js";

export class WorkLandedCache {
  private readonly workLandedHeads = new Set<string>();
  /** sinceHead -> main head at which "no work" held */
  private readonly noWorkAtHead = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly mainBranch: string,
  ) {}

  async since(sinceHead: string, mainHeadNow: string): Promise<boolean> {
    if (this.workLandedHeads.has(sinceHead)) return true;
    const checkedAt = this.noWorkAtHead.get(sinceHead);
    // Main has not moved since the last check for this head — the range is unchanged. An empty
    // mainHead means the ref could not be resolved: never trust or store a cache against it.
    if (mainHeadNow !== "" && checkedAt === mainHeadNow) return false;
    const subjects = await subjectsBetween(this.root, sinceHead, this.mainBranch);
    // A range that cannot be evaluated is treated as work landed — conservative: run the tick.
    const verdict = subjects === null ? true : workLanded(subjects);
    if (verdict) {
      this.noWorkAtHead.delete(sinceHead);
      if (this.workLandedHeads.size >= 200) this.workLandedHeads.clear();
      this.workLandedHeads.add(sinceHead);
    } else if (mainHeadNow !== "") {
      if (this.noWorkAtHead.size >= 200) this.noWorkAtHead.clear();
      this.noWorkAtHead.set(sinceHead, mainHeadNow);
    }
    return verdict;
  }
}
