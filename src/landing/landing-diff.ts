import { gitTry } from "../git/git-run.js";

/** The landing-scope DIFF COMPARISON (see landing-merge.ts for the merge flow that consults
 * it): whether a conflict-resolved tree's diff ahead of main stays inside the diff the review
 * gate approved. Pure multiset comparison over unified diffs, plus the git reads that produce
 * them — kept apart from the merge flow so the hunk-aware parsing (BUGS.md 2026-10-02) is
 * testable on its own. */

/** Whether the resolved tree's diff ahead of main adds or removes any line the reviewed diff
 * did not — three-dot against the branch tip as the gate judged it: the merge-base with
 * current main is the base the reviewer's diff was cut against (syncPinToMain rebased before
 * the gate when it could, and a conflicted pre-gate rebase leaves the pin on its original
 * base). */
export async function resolvedDiffDiverges(
  ctx: { mainBranch: string },
  wt: string,
  preMergeHead: string,
): Promise<boolean> {
  const approved = (await gitTry(wt, "diff", `${ctx.mainBranch}...${preMergeHead}`)) ?? "";
  const resolved = (await gitTry(wt, "diff", `${ctx.mainBranch}...HEAD`)) ?? "";
  const a = diffLineMultiset(approved);
  const r = diffLineMultiset(resolved);
  return !(subsetOf(r.add, a.add) && subsetOf(r.del, a.del));
}

/** The added and removed content lines of a unified diff, as multisets (one entry per
 * occurrence). Header lines (+++/---) and everything that is not a content marker is skipped;
 * binary files contribute nothing, like for like on both sides of the comparison. Header
 * recognition is hunk-aware: +++/--- prefixes only count as headers between the `diff --git`
 * and `@@` lines, because a content line can carry the same prefix (a deleted markdown
 * horizontal rule is exactly `---`), and dropping it silently shrinks the multiset (BUGS.md
 * 2026-10-02 latent-bug hunt). */
export function diffLineMultiset(diff: string): { add: string[]; del: string[] } {
  const add: string[] = [];
  const del: string[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    if (!inHunk) continue;
    if (line.startsWith("+")) add.push(line.slice(1));
    else if (line.startsWith("-")) del.push(line.slice(1));
  }
  return { add, del };
}

/** Whether every element of `small` (counting duplicates) appears in `big`. */
function subsetOf(small: string[], big: string[]): boolean {
  const counts = new Map<string, number>();
  for (const line of big) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of small) {
    const left = counts.get(line) ?? 0;
    if (left === 0) return false;
    counts.set(line, left - 1);
  }
  return true;
}
