import type { HarnessEvent } from "./events.js";
import { firstReason } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { textOr } from "../text/text.js";
import { stringList } from "../files/json-object.js";
import { elapsed } from "./event-format-fragments.js";

/** " after merge" when the review is a post-merge review, else "". */
function afterMergeSuffix(e: HarnessEvent): string {
  return e.afterMerge === true ? " after merge" : "";
}

/** The review-family lines: `review_start`, `review_verdict`, `review_rejected`,
 * `review_dropped`, `review_failed` and `revision` — the types event-format.ts's
 * EVENT_MESSAGE_FAMILY table routes here. The `afterMerge` flag marks a post-merge review, so
 * the verdict and rejected lines ride the " after merge" suffix. A type routed here but not
 * switched on renders as its own name. */
export function reviewEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "review_start": {
      // afterMerge is the tier flag reviewMergedCommit writes for a post-merge review; the
      // lineage pins review_start/review_verdict/review_rejected to the same discriminator.
      const tier = e.afterMerge === true ? " after merge" : " before merge";
      const revision = e.revision !== undefined ? ` (revision ${textOr(e.revision)})` : "";
      const model = e.model !== undefined ? ` on ${textOr(e.model)}` : "";
      return `reviewing ${shortSha(e.head)}${revision}${tier}${model}`;
    }
    case "review_verdict":
      return `review approved ${shortSha(e.head)}${afterMergeSuffix(e)}${e.reason ? ` — ${textOr(e.reason)}` : ""}${elapsed(e.durationMs)}`;
    case "review_rejected": {
      const reasons = stringList(e.reasons);
      // A reviewer fix its own pre-check withheld is not a verdict on the author's commit: the
      // line names the reviewer's finding (what is worth acting on), the withheld sha, and that
      // the review stays open. `reasons` here are the check's lines on reviewer-authored bytes.
      if (typeof e.withheldFix === "string" && e.withheldFix !== "") {
        const finding = stringList(e.finding);
        const named = finding.length > 0 ? firstReason(finding) : firstReason(reasons);
        return `reviewer fix ${shortSha(e.withheldFix)} withheld from main — ${named} (the review of ${shortSha(e.head)} stays open)`;
      }
      // Only the first reason renders; when more exist, say so instead of letting the
      // one-liner read as the complete verdict — the full list rides in state.lastReview
      // into the author's next run prompt, and this line is the operator's pointer to it.
      const more =
        reasons.length > 1
          ? ` (+${reasons.length - 1} more — the author's next run carries every reason)`
          : "";
      return `review rejected ${shortSha(e.head)}${afterMergeSuffix(e)} — ${firstReason(reasons)}${more}${elapsed(e.durationMs)}`;
    }
    case "review_dropped":
      // A post-merge review given up at the failure limit: the commit stays on main unreviewed.
      return `review dropped for ${shortSha(e.commit)} after repeated failures: ${textOr(e.reason)} (commit stays on main unreviewed)`;
    case "review_failed":
      return `review failed for ${shortSha(e.head)}: ${textOr(e.message)} (commit kept for re-review)${elapsed(e.durationMs)}`;
    case "revision":
      // A rejected change's revision round (plans/revise-rejected.md): applied onto current main,
      // conflicted with it, dropped by its author, or exhausted its rounds.
      return `revision ${textOr(e.round)} ${textOr(e.action)} ${shortSha(e.sha)}`;
    default: return textOr(e.type);
  }
}
