import type { HarnessEvent } from "./events.js";
import { orchestratorStopPhrase } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { textOr } from "../text/text.js";
import { stringList } from "../files/json-object.js";

export function configEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "max_concurrent_changed": {
      // Routine state change, like counters_reset — no warning prefix.
      return `maxConcurrent changed: ${textOr(e.from)} → ${textOr(e.to)}`;
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
