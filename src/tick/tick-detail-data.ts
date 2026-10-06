/** Collection half of `tumwater tick <role> <n>`: one completed tick's full event block,
 * distilled from the event log into a TickDetail payload. The collector-in-core convention
 * beside history-data.ts and report-data.ts — a pure read over root, so core modules can serve
 * the same payload without reaching into ui/, and the CLI (`tick-detail.ts`) and the GUI
 * History drill-down (`src/gui/gui-endpoints.ts`) cannot drift on what one tick's block contains.
 * Every datum rides the events the harness already writes, so this is a distillation of the
 * existing record, not a new one. The rendering half — the summary header, formatEvent, the
 * CLI command — lives in tick-detail.ts. */
import { HISTORY_SCAN_MAX_EVENTS } from "../history-data.js";
import { eventUsage, readEvents, tickSpanMs, tickStartMap } from "../event-read.js";
import { usageText } from "../event-format.js";
import type { HarnessEvent } from "../events.js";

/** One tick's full event trail, as `tumwater tick <role> <n>` and the GUI's tick drill-down
 * serve it. `startTs`/`endTs` bound the tick's block: `endTs` is null while the tick is in
 * flight (no `tick_end` yet) or its end was lost to log rotation, `startTs` null when rotation
 * cut the start but the end survived — either way `durationMs` is null (an unpaired tick shows
 * no fabricated duration, the history row's dash rule). `result`, `tokens`, and `costUsd` come
 * from the `tick_end` event (`result` null, both numbers 0 while it is in flight); `usage` is
 * the same numbers through usageText, empty when the tick carries neither (the payload's
 * omit-when-zero convention, matching TickRow). `events` is the tick's block oldest-first: the
 * paired `tick_start`/`tick_end` themselves plus every event filed under this loop whose
 * timestamp falls inside the pair — the tick-less in-tick events (`review_verdict`,
 * `build_check`, `warning`) included, other loops' events excluded. */
export interface TickDetail {
  role: string;
  tick: number;
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  result: string | null;
  tokens: number;
  costUsd: number;
  usage: string;
  events: HarnessEvent[];
}

/** The event block of `role`'s tick `n`, or null when the scanned window holds no such tick.
 * The newest `tick_start` the log retains for `${role}#${n}` wins (a counter reset can make an
 * old tick number recur; the operator asking by number means the most recent one), and the
 * block closes at the first `tick_end` for that tick after the start — or, when that end is
 * missing (in flight, or its tail lost to rotation), at the loop's next `tick_start`, so a
 * rotation-cut block never leaks the following tick's events into this one. When even the
 * start is gone but a matching `tick_end` survives, the end-alone block still answers with
 * `startTs` null and a null duration (the unpaired rule); nothing at all in the scan is the
 * not-found case the caller renders as a not-found line. */
export function readTickDetail(root: string, role: string, tick: number): TickDetail | null {
  // The scan rides history-data.ts's shared one-ask ceiling (HISTORY_SCAN_MAX_EVENTS): one
  // tick's block is small, but it can sit arbitrarily far back in a long-lived fleet's log,
  // and readTailText reads bytes proportional to the limit's line count — so the cap is also
  // the largest byte read one command can cost, and every read-only view scans under the
  // same bound.
  const events = readEvents(root, HISTORY_SCAN_MAX_EVENTS).filter((e) => e.loop === role);
  // Newest tick_start for this loop+tick: the block's lower bound.
  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "tick_start" && e.tick === tick) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    // The start is gone (rotation) or the tick never ran. A surviving tick_end for the same
    // number still answers — unpaired, undated at the front — else there is no such tick here.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "tick_end" && e.tick === tick) return detailFrom(role, tick, events, [e], e, null);
    }
    return null;
  }
  const start = events[startIdx]!;
  // The block's upper bound: the first tick_end for this tick after the start ends it; a
  // later tick_start (this tick's end lost to rotation) closes the block exclusive — the
  // events after it belong to the next tick, not this one. No end and no next start reads as
  // in flight: everything since the start belongs to the open tick.
  let end: HarnessEvent | null = null;
  let nextStart: HarnessEvent | null = null;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "tick_end" && e.tick === tick) {
      end = e;
      break;
    }
    if (e.type === "tick_start") {
      nextStart = e;
      break;
    }
  }
  // The block itself: the start event plus everything this loop logged up to the bound —
  // inclusive at a paired end, exclusive at a next tick's start.
  const block: HarnessEvent[] = [];
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i]!;
    if (end !== null ? e.ts > end.ts : nextStart !== null && e.ts >= nextStart.ts) break;
    block.push(e);
  }
  return detailFrom(role, tick, events, block, end, start.ts);
}

/** Fill the payload around a collected block: usage from the tick_end via eventUsage/usageText,
 * duration via tickSpanMs against the loop's own start map (the shared pairing helper, so this
 * view and the history rows cannot drift on what a span is), events oldest-first. */
function detailFrom(
  role: string,
  tick: number,
  scoped: HarnessEvent[],
  block: HarnessEvent[],
  end: HarnessEvent | null,
  startTs: number | null,
): TickDetail {
  const usageNums = end === null ? { tokens: 0, costUsd: 0 } : eventUsage(end);
  return {
    role,
    tick,
    startTs,
    endTs: end === null ? null : end.ts,
    durationMs: end === null ? null : tickSpanMs(end, tickStartMap(scoped)),
    result: end === null ? null : String(end.result),
    tokens: usageNums.tokens,
    costUsd: usageNums.costUsd,
    usage: end === null ? "" : usageText(end),
    events: block,
  };
}
