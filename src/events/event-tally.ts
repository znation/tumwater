/** The one ordering the prose `tumwater logs --count` tally and the TUI Activity pane's
 * tally line share: count each present event type, most-frequent first with ties in
 * type-name order, one `[type, count]` pair per present type. Hoisting the sort here keeps
 * `sayTally` and the pane from drifting on which types win or how ties break. The dashboard
 * feed's tally chips keep their own copy because they run in a browser where harness modules
 * cannot be imported (the `reportRoleOrder` exception
 * src/ui/gui/gui-client-report-chart.ts documents). */
import { increment, sortByValueDesc } from "../collections.js";
import type { HarnessEvent } from "./events.js";

/** Tally the distinct types present, most-frequent first with ties in type-name order.
 * `[]` in, `[]` out. */
export function eventTypeTally(events: readonly HarnessEvent[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const e of events) increment(counts, e.type);
  return sortByValueDesc([...counts.entries()]);
}
