import type { HarnessEvent } from "./events.js";
import { textOr } from "../text/text.js";

export function warningEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "warning":
      return `warning: ${textOr(e.message)}`;
    default: return textOr(e.type);
  }
}

/** One family's line builder: an event's message from the event, the way <family>EventMessage
 * builds it. The family table's values are all of these; the table is the dispatch. */
