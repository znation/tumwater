import type { HarnessEvent } from "./events.js";
import { textOr } from "../text/text.js";

/** The warning-family line: `warning`, the one type event-format.ts's EVENT_MESSAGE_FAMILY
 * table routes here — the harness's catch-all problem event, whose text the writer supplies on
 * the event's `message` field; a torn event without one prints "?" after the prefix. A type
 * routed here but not switched on renders as its own name. */
export function warningEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "warning":
      return `warning: ${textOr(e.message)}`;
    default: return textOr(e.type);
  }
}
