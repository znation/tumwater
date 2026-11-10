import type { HarnessEvent } from "./events.js";
import { eventRun } from "./event-read.js";
import { shortSha } from "../text/format.js";
import { textOr, truncate } from "../text/text.js";
import { stringList } from "../files/json-object.js";

export function inboxEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "prompt_enqueued":
    case "prompt_cancelled":
    case "prompt_edited":
    case "prompt_topped":
    case "prompt_taken":
      return promptActionMessage(e);
    case "question_posted":
      return questionPostedMessage(e);
    case "entry_refused":
      return entryRefusedMessage(e);
    case "issue_filed":
      return issueFiledMessage(e);
    case "remote_ci_failed":
      return remoteCiFailedMessage(e);
    default: return textOr(e.type);
  }
}

// The five prompt-queue actions: the operator's inbox lines, each naming the action and the
// message's preview (prompt_taken adds the run that took it).
function promptActionMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "prompt_enqueued":
      return `message added to the inbox: ${textOr(e.preview)}`;
    case "prompt_cancelled":
      // Routine operation (the user removed a queued prompt), not a warning.
      return `message removed from the inbox: ${textOr(e.preview)}`;
    case "prompt_edited":
      // Routine operation (the user corrected a queued prompt), not a warning.
      return `inbox message edited: ${textOr(e.preview)}`;
    case "prompt_topped":
      // Routine operation (the user reordered a queued prompt), not a warning.
      return `inbox message moved to the front: ${textOr(e.preview)}`;
    case "prompt_taken":
      // Routine: a run dequeued the operator's request to run it.
      return `inbox message taken by run #${eventRun(e)}: ${textOr(e.preview)}`;
    default: return textOr(e.type);
  }
}

function questionPostedMessage(e: HarnessEvent): string {
  // Routine operation (a role asked the user something), not a warning.
  // The position is the `<n>` `questions answer` takes, so the notify page is actionable.
  return `question posted: ${textOr(e.question)}${typeof e.position === "number" && Number.isInteger(e.position) && e.position >= 1 ? ` — question ${e.position} in \`tumwater questions\`; answer it with \`tumwater questions answer ${e.position} "<decision>"\`` : ""}`;
}

function entryRefusedMessage(e: HarnessEvent): string {
  // Routine operation (a refusal note merged), not a warning — like question_posted.
  const files = Array.isArray(e.files) ? e.files.join(", ") : "";
  const titles = stringList(e.entries);
  if (titles.length === 0) return `entry refused: ${textOr(e.reason)} (${files})`;
  const more = titles.length > 1 ? ` (and ${titles.length - 1} more)` : "";
  return `entry refused: "${truncate(titles[0]!, 80)}"${more}: ${textOr(e.reason)} (${files})`;
}

function issueFiledMessage(e: HarnessEvent): string {
  // The feedback observer's filing (plans/feedback-role.md 2/2) is a visible, auditable
  // result — routine operation like question_posted, not a warning. The number is the
  // issue the operator can open; a torn event without it reads "?" never "undefined".
  return `filed issue #${typeof e.issue === "number" ? e.issue : "?"} ${textOr(e.title)} on znation/tumwater`;
}

function remoteCiFailedMessage(e: HarnessEvent): string {
  // The hosted runner went red on a pushed main (plans/remote-ci.md "Surfaces"): the
  // commit URL is the operator's pointer to the failure, and the ci role's charter says
  // it reproduces and fixes or files it. The display sha is shortSha like every other
  // feed line; the URL carries the full sha GitHub resolves.
  const sha = typeof e.sha === "string" ? e.sha : "";
  const repo = typeof e.repo === "string" ? e.repo : "";
  return `GitHub CI failed at ${sha ? shortSha(sha) : "?"} on ${repo || "?"}; the ci role reproduces it and fixes or files it${sha && repo ? ` — https://github.com/${repo}/commit/${sha}` : ""}`;
}
