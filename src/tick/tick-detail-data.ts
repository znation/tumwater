// vocabulary: plain
/** Collection half of `tumwater tick <role> <n>`: one completed tick's full event block,
 * distilled from the event log into a TickDetail payload. The collector-in-core convention
 * beside history-data.ts and src/report/report-data.ts — a pure read over root, so core
 * modules can serve the same payload without reaching into ui/, and the CLI
 * (`tick-detail.ts`) and the GUI History drill-down (`src/gui/gui-endpoints.ts`) cannot
 * drift on what one tick's block contains.
 * Every datum rides the events the harness already writes, so this is a distillation of the
 * existing record, not a new one. The rendering half — the summary header, formatEvent, the
 * CLI command — lives in tick-detail.ts. */
import { HISTORY_SCAN_MAX_EVENTS, bucketMergeEvents, resolveQueuedResult } from "../history/history-data.js";
import { eventUsage, readEvents, tickSpanMs, tickStartMap } from "../events/event-read.js";
import { outcomeText, usageText } from "../events/event-format.js";
import type { HarnessEvent } from "../events/events.js";

/** One tick's full event trail, as `tumwater tick <role> <n>` and the GUI's tick drill-down
 * serve it. `startTs`/`endTs` bound the tick's block: `endTs` is null while the tick is in
 * flight (no `run_end` yet) or its end was lost to log rotation, `startTs` null when rotation
 * cut the start but the end survived — either way `durationMs` is null (an unpaired tick shows
 * no fabricated duration, the history row's dash rule). `result`, `tokens`, and `costUsd` come
 * from the `run_end` event (`result` null, both numbers 0 while it is in flight); `usage` is
 * the same numbers through usageText, empty when the tick carries neither (the payload's
 * omit-when-zero convention, matching TickRow). `events` is the tick's block oldest-first: the
 * paired `run_start`/`run_end` themselves plus every event filed under this role whose
 * timestamp falls inside the pair — the tick-less in-tick events (`review_verdict`,
 * `build_check`, `warning`) included, other roles' events excluded. A tick that ended `queued`
 * has its merge's verdict resolved the way history rows do: `result` becomes the merge's
 * result and `merge` the `merge_done`/`merge_failed` event that carries it (not in `events`:
 * logged after the block, or — for a leftover-recovery run, whose verdict is the failed
 * attempt it re-queued — before it); `merge` is null for every other tick, and for a queued
 * tick whose merge is still pending or whose outcome rotated out (`result` stays `queued`). */
export interface TickDetail {
  role: string;
  run: number;
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  result: string | null;
  tokens: number;
  costUsd: number;
  usage: string;
  events: HarnessEvent[];
  merge: HarnessEvent | null;
  /** The sha the run's change holds on main, from the role's `merged` event: the newest one in
   * the block for a run that merged directly, or the newest inside the merge's own window
   * (`merge_done` ts minus its `durationMs`, up to its ts) for a queued run. It differs from the
   * pinned commit when the merge rebased. Null for every other run, and when the event rotated
   * out or the merge was a no-op fast-forward (which logs none). */
  mergedSha: string | null;
}

/** The event block of `role`'s tick `n`, or null when the scanned window holds no such tick.
 * The newest `run_start` the log retains for `${role}#${n}` wins (a counter reset can make an
 * old tick number recur; the operator asking by number means the most recent one), and the
 * block closes at the first `run_end` for that tick after the start — or, when that end is
 * missing (in flight, or its tail lost to rotation), at the role's next `run_start`, so a
 * rotation-cut block never leaks the following tick's events into this one. When even the
 * start is gone but a matching `run_end` survives, the end-alone block still answers with
 * `startTs` null and a null duration (the unpaired rule); nothing at all in the scan is the
 * not-found case the caller renders as a not-found line. */
export function readTickDetail(root: string, role: string, tick: number): TickDetail | null {
  // The scan rides history-data.ts's shared one-ask ceiling (HISTORY_SCAN_MAX_EVENTS): one
  // tick's block is small, but it can sit arbitrarily far back in a long-lived team's log,
  // and readTailText reads bytes proportional to the limit's line count — so the cap is also
  // the largest byte read one command can cost, and every read-only view scans under the
  // same bound.
  const events = readEvents(root, HISTORY_SCAN_MAX_EVENTS).filter((e) => e.source === role);
  // Newest run_start for this role+tick: the block's lower bound.
  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "run_start" && e.run === tick) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    // The start is gone (rotation) or the tick never ran. A surviving run_end for the same
    // number still answers — unpaired, undated at the front — else there is no such tick here.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "run_end" && e.run === tick) return detailFrom(role, tick, events, [e], e, null);
    }
    return null;
  }
  const start = events[startIdx]!;
  // The block's upper bound: the first run_end for this tick after the start ends it; a
  // later run_start (this tick's end lost to rotation) closes the block exclusive — the
  // events after it belong to the next tick, not this one. No end and no next start reads as
  // in flight: everything since the start belongs to the open tick.
  let end: HarnessEvent | null = null;
  let nextStart: HarnessEvent | null = null;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "run_end" && e.run === tick) {
      end = e;
      break;
    }
    if (e.type === "run_start") {
      nextStart = e;
      break;
    }
  }
  // The block itself: the start event plus everything this role logged up to the bound —
  // inclusive at a paired end, exclusive at a next tick's start.
  const block: HarnessEvent[] = [];
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i]!;
    if (end !== null ? e.ts > end.ts : nextStart !== null && e.ts >= nextStart.ts) break;
    block.push(e);
  }
  return detailFrom(role, tick, events, block, end, start.ts);
}

/** Fill the payload around a collected block: usage from the run_end via eventUsage/usageText,
 * duration via tickSpanMs against the role's own start map (the shared pairing helper, so this
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
  let result = end === null ? null : outcomeText(end);
  let merge: HarnessEvent | null = null;
  if (end !== null && result === "queued") {
    // A fresh claim cursor suits one tick: the walk starts at the newest pin at or before this
    // tick's end, which is its own pin, since later ticks' pins sit after it.
    const { mergeQueuedByLoop, outcomeByLoop } = bucketMergeEvents(scoped);
    const resolved = resolveQueuedResult(end, mergeQueuedByLoop, outcomeByLoop, new Map(), tickStartMap(scoped), null);
    if (resolved !== null) {
      result = resolved.result;
      merge = resolved.outcome;
    }
  }
  return {
    role,
    run: tick,
    startTs,
    endTs: end === null ? null : end.ts,
    durationMs: end === null ? null : tickSpanMs(end, tickStartMap(scoped)),
    result,
    tokens: usageNums.tokens,
    costUsd: usageNums.costUsd,
    usage: end === null ? "" : usageText(end),
    events: block,
    merge,
    mergedSha: mergedShaOf(result, merge, scoped, block),
  };
}

/** The commit of the newest `merged` event in `pool` (oldest-first) inside [from, to]. */
function newestMergedCommit(pool: HarnessEvent[], from: number, to: number): string | null {
  for (let i = pool.length - 1; i >= 0; i--) {
    const e = pool[i]!;
    if (e.type === "merged" && e.ts >= from && e.ts <= to && typeof e.commit === "string" && e.commit !== "") {
      return e.commit;
    }
  }
  return null;
}

/** The landed sha for a detail: see TickDetail.mergedSha. */
function mergedShaOf(
  result: string | null,
  merge: HarnessEvent | null,
  scoped: HarnessEvent[],
  block: HarnessEvent[],
): string | null {
  if (merge === null) {
    return result === "changed" ? newestMergedCommit(block, -Infinity, Infinity) : null;
  }
  if (merge.type !== "merge_done" || typeof merge.durationMs !== "number" || !Number.isFinite(merge.durationMs)) {
    return null;
  }
  return newestMergedCommit(scoped, merge.ts - merge.durationMs, merge.ts);
}
