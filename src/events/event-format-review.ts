import type { HarnessEvent } from "./events.js";
import { firstReason } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { textOr } from "../text/text.js";
import { stringList } from "../files/json-object.js";
import { elapsed } from "./event-format-fragments.js";

function afterMergeSuffix(e: HarnessEvent): string {
  return e.afterMerge === true ? " after merge" : "";
}

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
      // Only the first reason renders; when more exist, say so instead of letting the
      // one-liner read as the complete verdict — the full list rides in state.lastReview
      // into the author's next run prompt, and this line is the operator's pointer to it.
      const more =
        reasons.length > 1
          ? ` (+${reasons.length - 1} more — the author's next run carries every reason)`
          : "";
      return `review rejected ${shortSha(e.head)}${afterMergeSuffix(e)} — ${firstReason(reasons)}${more}${elapsed(e.durationMs)}`;
    }
    case "review_failed":
      return `review failed for ${shortSha(e.head)}: ${textOr(e.message)} (commit kept for re-review)${elapsed(e.durationMs)}`;
    case "revision":
      // A rejected change's revision round (plans/revise-rejected.md): applied onto current main,
      // conflicted with it, dropped by its author, or exhausted its rounds.
      return `revision ${textOr(e.round)} ${textOr(e.action)} ${shortSha(e.sha)}`;
    default: return textOr(e.type);
  }
}
