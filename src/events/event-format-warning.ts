import type { HarnessEvent } from "./events.js";
import { textOr } from "../text/text.js";

export function warningEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "warning":
      return `warning: ${textOr(e.message)}`;
    default: return textOr(e.type);
  }
}
