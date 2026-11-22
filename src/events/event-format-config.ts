import type { HarnessEvent } from "./events.js";
import { orchestratorStopPhrase } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { textOr } from "../text/text.js";
import { stringList } from "../files/json-object.js";

/** The config-family lines: `max_concurrent_changed`, `retention_changed`,
 * `github_issues_unavailable`, the four `github_issue_*` actions, `config_changed`,
 * `model_changed`, `backend_binary`, `state_migrated`, `orchestrator_start` and
 * `orchestrator_stop` — the types event-format.ts's EVENT_MESSAGE_FAMILY table routes here.
 * The state changes and the GitHub-issue actions are routine, like counters_reset — only a
 * newly routed backend whose binary is missing writes the warning into its own text. A type
 * routed here but not switched on renders as its own name. */
export function configEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "max_concurrent_changed": {
      // Routine state change, like counters_reset — no warning prefix.
      return `maxConcurrent changed: ${textOr(e.from)} → ${textOr(e.to)}`;
    }
    case "github_issues_unavailable": {
      // The GitHub issues scan could not read the project's issues; nothing new is mirrored until
      // gh works again. It is logged once per outage, not once per scan.
      return `GitHub issues unavailable for ${textOr(e.repo)} (${textOr(e.gh)}): ${textOr(e.reason)}`;
    }
    case "github_issue_closed": {
      // tumwater closed a mirrored issue because its fix is on GitHub's base branch: a routine
      // outcome, so no warning prefix.
      return `closed GitHub issue #${textOr(e.issue)} on ${textOr(e.repo)}, citing ${Array.isArray(e.shas) ? e.shas.map((sha) => String(sha).slice(0, 8)).join(", ") : textOr(e.shas)}`;
    }
    case "github_issue_declined": {
      // A director declined an open issue: a routine outcome of a run that succeeded, so no warning
      // prefix. The reason is the director's own line, shown as written.
      return `declined GitHub issue #${textOr(e.issue)} on ${textOr(e.repo)}: ${textOr(e.reason)}`;
    }
    case "github_issue_queued": {
      // A poll sent an unmirrored issue to the director: a routine outcome, so no warning prefix.
      return `queued GitHub issue #${textOr(e.issue)} on ${textOr(e.repo)} for the director`;
    }
    case "github_issue_upstream_closed": {
      // GitHub stopped listing an issue the ledger held open — someone closed it upstream, so
      // tumwater never caused it and has no fix to cite: a routine outcome, no warning prefix.
      // `updatedAt` is GitHub's own last word about the issue, printed as it was recorded; every
      // field is read through textOr so a torn line still renders.
      return `GitHub closed issue #${textOr(e.issue)} on ${textOr(e.repo)}, last seen open ${textOr(e.updatedAt)}`;
    }
    case "retention_changed": {
      // Routine state change, like its maxConcurrent sibling — no warning prefix.
      return `sessionRetentionDays changed: ${textOr(e.from)} → ${textOr(e.to)}`;
    }
    case "config_changed": {
      // Routine state change, like its maxConcurrent/retention siblings — no warning prefix.
      // A bare/empty keys array (a torn or hand-edited line) still renders.
      const keys = stringList(e.keys).join(", ");
      return `config changed${keys ? `: ${keys}` : ""}`;
    }
    case "model_changed":
      // The live-edit sibling of config_changed: names the new selector, the one fact the key
      // list cannot show. The per-role diffs stay structured on the event.
      return `model changed — now ${textOr(e.to, "pi's default")}`;
    case "backend_binary":
      // The binary check for a newly routed backend: found is the routine verdict; a missing
      // binary is the warning.
      return e.found === false
        ? `warning: newly routed ${textOr(e.agent)} backend — its binary was not found`
        : `newly routed ${textOr(e.agent)} backend checked — binary found`;
    case "state_migrated":
      return `state migrated — ${textOr(e.detail)}`;
    case "orchestrator_start":
      return `tumwater started (pid ${textOr(e.pid)}${e.build ? `, version ${shortSha(e.build)}` : ""})`;
    case "orchestrator_stop":
      return orchestratorStopPhrase(e.cause);
    default: return textOr(e.type);
  }
}
