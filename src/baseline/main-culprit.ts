// vocabulary: plain
import { cachedBaselineVerdict, checkMainBaseline } from "./main-baseline.js";
import { baselineCheckLogger } from "./main-red.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { gitTry } from "../git/git-run.js";
import { treeDiffFiles } from "../git/git-diff.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { gateMainWorktreePath } from "../paths.js";
import { isExemptDiff } from "../review/exemptions.js";
import { onlyQuarantined } from "../review/known-flakes.js";
import { readEvents } from "../events/event-read.js";
import { TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";

/** How many first-parent commits below the red tip the search for a last green looks at. */
const CULPRIT_SEARCH_MAX = 50;

/** How many recent events the owner lookup reads; an older `merged` event counts as none. */
const OWNER_EVENT_TAIL = 2000;

type RedCulprit =
  | { kind: "culprit"; commit: string; runner?: string; failingTests: string[]; green: string }
  | { kind: "environment"; green: string }
  | { kind: "unattributed"; reason: string };

/** Name the first-parent commit that turned main red at `red.sha` (plans/fast-merge.md, Lever 2,
 * part 4a). Runs inside the main watch's `_gate-main` checkout `wt`, re-pointing it per candidate
 * and back at the tip before returning. Finds the newest first-parent commit with a cached green
 * verdict, re-checks it fresh (a green that is red now means the environment broke, not a
 * change), then bisects the commits since it — skipping doc-only ones — for the first red. A
 * search that cannot name a commit says why instead of guessing. */
export async function findRedCulprit(
  root: string,
  wt: string,
  config: TumwaterConfig,
  red: { sha: string; failingTests?: string[] },
): Promise<RedCulprit> {
  const tip = red.sha;
  const onRun = baselineCheckLogger(root, TUMWATER_SOURCE);
  const mirror = gateMainWorktreePath(root);
  const at = async (sha: string): Promise<void> => {
    await ensureDetachedWorktree(root, mirror, sha);
  };
  const check = async (sha: string, reverifyRed: boolean, forceFresh: boolean, observedOnly: boolean) => {
    await at(sha);
    return (await checkMainBaseline(wt, config, onRun, reverifyRed, forceFresh, undefined, observedOnly, CHECK_TIER.merge))
      .baseline;
  };
  try {
    const walk = ((await gitTry(wt, "rev-list", "--first-parent", `--max-count=${CULPRIT_SEARCH_MAX + 1}`, tip)) ?? "")
      .split("\n")
      .filter((s) => s !== "")
      .slice(1);
    const green = walk.find((sha) => cachedBaselineVerdict(sha) === "green");
    if (!green) {
      return { kind: "unattributed", reason: `no green commit within ${CULPRIT_SEARCH_MAX} first-parent commits` };
    }
    const recheck = await check(green, false, true, false);
    if (!recheck) return { kind: "unattributed", reason: `the check made no verdict at ${green.slice(0, 7)}` };
    if (recheck.status === "red") return { kind: "environment", green };

    const exempt = config.review.exemptPaths;
    const since = ((await gitTry(wt, "rev-list", "--first-parent", "--reverse", `${green}..${tip}`)) ?? "")
      .split("\n")
      .filter((s) => s !== "");
    const candidates: string[] = [];
    for (const sha of since) {
      const files = await treeDiffFiles(wt, `${sha}^`, sha);
      if (files === null || !isExemptDiff(files, exempt)) candidates.push(sha);
    }
    if (candidates.length === 0) return { kind: "unattributed", reason: "no non-doc commit since the last green" };

    // The last candidate is taken as red unrun: it is the tip, or only doc commits follow it.
    let lo = 0;
    let hi = candidates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const verdict = await check(candidates[mid] as string, false, false, true);
      if (!verdict) return { kind: "unattributed", reason: `the check made no verdict at ${(candidates[mid] as string).slice(0, 7)}` };
      if (verdict.status === "red" && !onlyQuarantined(root, verdict.failingTests)) hi = mid;
      else lo = mid + 1;
    }
    const commit = candidates[lo] as string;
    const confirmed = await check(commit, true, false, true);
    if (confirmed?.status !== "red" || onlyQuarantined(root, confirmed.failingTests)) {
      return { kind: "unattributed", reason: `red did not reproduce at ${commit.slice(0, 7)}` };
    }
    const failingTests = red.failingTests ?? []; // G was just verified green, so it carries none to subtract
    const merged = readEvents(root, OWNER_EVENT_TAIL)
      .reverse()
      .find((ev) => ev.type === "merged" && ev.commit === commit);
    return {
      kind: "culprit",
      commit,
      ...(merged ? { runner: merged.source } : {}),
      failingTests,
      green,
    };
  } finally {
    await at(tip);
  }
}
