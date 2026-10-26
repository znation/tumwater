import type { TumwaterConfig } from "../config/config-schema.js";
import { eventsSince } from "../events/event-window.js";
import { isNotifyFailure } from "../events/notify.js";
import { DAY_MS, humanAgo } from "../text/datetime.js";
import { plural } from "../text/phrases.js";
import { errorMessage, squash } from "../text/text.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** How far back the `notify` check looks for failed pages: a day, fixed. An opinionated
 * default with no knob, like STALE_BUG_DAYS: long enough that a transient hook failure shows
 * up, short enough that a page that did not go through is still the operator's business. */
const NOTIFY_CHECK_WINDOW_MS = DAY_MS;

/** The `notify` check: whether a notify command is configured, and a warning when it failed to
 * page within the last day (a nonzero exit, a kill, or a failed start — the warnings
 * spawnNotifyCommand logs). Warns but never fails, like the hold rows: a dead webhook must not
 * fail a scripted pre-flight. Never throws. `now` is the seam for the window's far edge. */
export function checkNotify(root: string, config: TumwaterConfig | undefined, now: number = Date.now()): CheckOutcome {
  if (!config?.notify) return okOutcome("no notify command configured — pages are off");
  try {
    const failures = eventsSince(root, NOTIFY_CHECK_WINDOW_MS, now, isNotifyFailure);
    if (failures.length === 0) return okOutcome("configured — no failed pages in the last 24h");
    const latest = failures[failures.length - 1]!;
    return warnOutcome(`${plural(failures.length, "failed page")} in the last 24h; latest ${humanAgo(latest.ts, now)}: ${squash(String(latest.message), 200)}`);
  } catch (err) {
    return warnOutcome(`could not read the event log for failed pages: ${errorMessage(err)}`);
  }
}
