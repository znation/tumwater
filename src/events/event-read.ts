import { dayKey } from "../text/datetime.js";
import { finiteNumber, parseJsonObject } from "../files/json-object.js";
import { eventsLogPath } from "../paths.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { readTailTextWithEnd } from "../files/tail.js";
import { normalizeLegacyEvent } from "./event-legacy.js";
import type { HarnessEvent } from "./events.js";

/** The READ side of the event feed: everything that consumes events.jsonl after the fact —
 * parseEventLine's skip-without-failing rule, the per-event query conventions (eventDayKey,
 * eventRole, eventUsage, runStartMap/runSpanMs) the reports and history share, and the
 * stat-cached backwards tail scan readEvents is built on. The WRITE side — logEvent/warnEvent,
 * the append path with its torn-tail repair, rotation, and the subscriber list — and the
 * HarnessEvent shape itself live beside it in events.ts; the split keeps the append path's
 * fs machinery (and its stat-memo cache) apart from the read path's parse-and-scan machinery
 * (and its own stat-keyed cache), so each cache and each failure mode has one home. Human-
 * facing formatting lives in event-format.ts; the windowed reader in event-window.ts. */

/** Parse one line of the event log into a HarnessEvent, or null when it is torn or corrupt
 * (a crash mid-append leaves a partial final line without its newline). The single home of
 * the skip-without-failing policy every consumer of events.jsonl applies — readEvents here,
 * report.ts's window scan, and `tumwater logs -f`'s follow branch all parse through it instead
 * of repeating the try/catch per reader. A valid-JSON scalar, `null`, or array is not an event
 * object either: the log is one JSON object per line, so anything else is corrupt (or foreign)
 * and reads as no data — the same object check readJsonFile applies to the harness's state
 * files. Without it, `readEvents` pushes the truthy non-object into the feed and `formatEvent`
 * renders it as an `Invalid Date undefined` line. An old line comes back under today's names
 * (normalizeLegacyEvent, event-legacy.ts). */
export function parseEventLine(line: string): HarnessEvent | null {
  const parsed = parseJsonObject(line);
  return parsed ? normalizeLegacyEvent(parsed as HarnessEvent) : null;
}

/** The local calendar-day key ("YYYY-MM-DD") of an event's `ts`, or null when it carries no
 * numeric timestamp. The one day-bucketing rule the windowed reader (event-window.ts) and the
 * usage/failure reports all apply, so they agree on what counts as one day. A `ts` that is
 * present but not finite is as unusable as an absent one and reads null too (the same
 * finiteness check eventRun/eventUsage/runStartMap/runSpanMs apply): bare
 * `typeof Infinity === "number"` let a JSON `1e999` through to dayKey, whose
 * `new Date(Infinity)` rendered the bucket key "NaN-NaN-NaN" and filed the event under a day
 * no window can name. */
export function eventDayKey(ev: HarnessEvent): string | null {
  const ts = finiteNumber(ev.ts, null);
  return ts === null ? null : dayKey(ts);
}

/** The role id an event is filed under, or "?" when absent or empty — the guard the usage
 * report and the failure digest both apply when grouping by role. */
export function eventRole(ev: HarnessEvent): string {
  return typeof ev.source === "string" && ev.source !== "" ? ev.source : "?";
}

/** The run number an event names, or 0 when it is absent or non-finite. The one guard every
 * display surface applies to the loosened `run` field: an event log is read without a shape
 * filter, so a torn or hand-edited line can carry no run (String(undefined) printed "#undefined"
 * in the feed) or a non-numeric one (String(Number(…)) printed "#NaN" in history). Runs are
 * 1-based — the role increments state.runs before logging its first run — so 0 is visibly not
 * a real run, the same corrupt-value-reads-as-0 rule gigabytes and the failure digest's
 * aheadCommits apply, kept finite so a JSON consumer never sees NaN's null stand-in. */
export function eventRun(ev: HarnessEvent): number {
  return finiteNumber(ev.run, 0);
}

/** The usage numbers an event records (`run_end`'s own run, `merge_done`'s merge slot):
 * `tokens` and `costUsd` arrive `unknown` through the event's index signature, so they are
 * coerced to numbers here, with an absent, non-numeric, or non-finite value reading as 0 —
 * the one convention every usage consumer applies (the event feed's usage fragment,
 * `tumwater history`'s rows and --json, the usage report's fold), so the field rule —
 * including what a corrupt value contributes — lives beside the consumers, not re-spelled
 * per consumer. `notionalCostUsd` (subscription spend, plans/agent-backends.md part 6a) is
 * coerced the same way. */
export function eventUsage(ev: HarnessEvent): { tokens: number; costUsd: number; notionalCostUsd: number } {
  const tokens = finiteNumber(ev.tokens, 0);
  const costUsd = finiteNumber(ev.costUsd, 0);
  const notionalCostUsd = finiteNumber(ev.notionalCostUsd, 0);
  return { tokens, costUsd, notionalCostUsd };
}

/** Pair the run_start events of `events` by run, keyed `${role}#${run}` → the start event
 * itself — the one home of that pairing and its key format, shared by the timestamps
 * (runStartMap), the models (runStartModelMap), and the run drill-down's duration
 * (run-detail-data.ts uses runSpanMs' key). A run_start whose `ts` is not a finite number is
 * as unusable as an absent one and adds no entry either (the same "a torn or hand-edited line
 * carries no usable timestamp" policy eventRun/eventUsage apply to their fields), so every
 * entry is a real start the projections below can trust. Private: external consumers read one
 * of the projections, not this raw pairing. */
function runStartEvents(events: HarnessEvent[]): Map<string, HarnessEvent> {
  const starts = new Map<string, HarnessEvent>();
  for (const e of events) {
    const ts = finiteNumber(e.ts, null);
    if (e.type === "run_start" && ts !== null) starts.set(`${e.source}#${e.run}`, e);
  }
  return starts;
}

/** The run_start pairing's start epoch ms: `${role}#${run}` → start epoch ms, the projection
 * of runStartEvents onto each event's `ts` — shared by `tumwater history`'s row spans
 * (history-data.ts), the failure digest's time-and-spend fold (time-spend.ts), and the run
 * drill-down's duration (run-detail-data.ts), so those consumers cannot drift into different
 * notions of a run's span. A run_end whose start is not in `events` (log rotation cut it, or
 * the run was skipped before any start logged) has no entry; callers decide what an unpaired
 * end costs. Lives in the read module, not in a ui module, so core collectors can share it
 * without a core→ui import. */
export function runStartMap(events: HarnessEvent[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const [key, e] of runStartEvents(events)) starts.set(key, finiteNumber(e.ts, 0));
  return starts;
}

/** The run_start pairing's model selectors: `${role}#${run}` → the run's model when its
 * run_start carries a non-empty string `model` (the agent-qualified selector string — a
 * per-role override, a fallback, or the primary — that the status rows carry; see
 * config-views.ts's backendQualifiedSelector). A run_start with no `model`, or an empty or
 * non-string one, adds no entry, so `tumwater history`'s model cell renders empty for a start
 * that named none — exactly the empty-usage convention applied to cells. The finite-`ts`
 * guard rides runStartEvents, the one home of the pairing. */
export function runStartModelMap(events: HarnessEvent[]): Map<string, string> {
  const models = new Map<string, string>();
  for (const [key, e] of runStartEvents(events)) {
    if (typeof e.model === "string" && e.model !== "") models.set(key, e.model);
  }
  return models;
}

/** The model of the run_end event `ev` against `models` (runStartModelMap's pairing): the
 * `${role}#${run}` lookup, in one place beside the map it indexes, so the key format and the
 * "no model is null" rule are spelled once — the model twin of runSpanMs. null when the
 * start is missing (rotation cut it) or carried no model; callers decide what an empty model
 * costs — history renders it as an empty cell. */
export function runStartModel(ev: HarnessEvent, models: Map<string, string>): string | null {
  return models.get(`${ev.source}#${ev.run}`) ?? null;
}

/** The start→end span of the `run_end` event `ev` against `starts` (runStartMap's pairing):
 * the `${role}#${run}` lookup and the clamp to non-negative, in one place beside the map
 * they index, so the key format and the span rule are spelled once. null when the start is
 * missing (rotation cut it) or when `ev.ts` is not a finite number (a torn or hand-edited end
 * line can carry no usable timestamp); callers decide what an unpaired end costs — the failure
 * digest prices it as 0, history renders it as "—", run detail omits the duration. The end's
 * guard is the same finiteness check eventRun/eventUsage apply to their fields: without it,
 * `Math.max(0, undefined - start)` was NaN, and the failure digest's `runDurationMs`
 * (`runSpanMs(ev, starts) ?? 0`) folded that NaN straight into its agent-hour totals —
 * `NaN ?? 0` is still NaN. */
export function runSpanMs(ev: HarnessEvent, starts: Map<string, number>): number | null {
  const startTs = starts.get(`${ev.source}#${ev.run}`);
  const endTs = finiteNumber(ev.ts, null);
  return startTs === undefined || endTs === null ? null : Math.max(0, endTs - startTs);
}

/** How many recent events the merged-event owner lookup reads; an older `merged` event counts
 * as none. */
const MERGED_EVENT_TAIL = 2000;

/** The role whose `merged` event named `commit` — the owner of a main head, read by the main
 * watch's red-tip naming and its per-commit diff-rule attribution (main-watch.ts). undefined when
 * no recent merged event names the head. Lives here on the event READ side so main-watch.ts and
 * the merge paths that consult it share one definition without importing the events module.
 * (docs/code-metrics.md records "no runtime import cycles"). */
export function mergingRoleOf(root: string, commit: string): string | undefined {
  return readEvents(root, MERGED_EVENT_TAIL)
    .reverse()
    .find((ev) => ev.type === "merged" && ev.commit === commit)?.source;
}

/** Normalize a raw `main_revert` reason to the events.ts contract: `post-review` for a
 * post-merge review rejection, `main-red` otherwise, including absent or unknown reasons.
 * The absent-reason default is a display fallback for events that predate the reason split;
 * it is not a red-main fact — the removed revert guardrail (part 5/6) classified a reason-less
 * event from the log instead of through this. */
export function revertReasonOf(ev: HarnessEvent): "post-review" | "main-red" {
  return ev.reason === "post-review" ? "post-review" : "main-red";
}

/** The event-tail size readEvents falls back to when a caller omits `limit` — a working
 * handful of a busy team's recent activity, small enough that the per-poll tail read stays
 * cheap. Exported so a caller that starts a scan at the default (status-polls.ts's
 * mainCheckForPoll ladder) grows from the same value instead of re-spelling the literal. */
export const DEFAULT_EVENT_TAIL = 200;

/** Read the last `limit` events (best-effort; skips malformed lines).
 * A limit that is not a positive number reads as an empty window — `[]` — matching
 * readTranscriptTail's zero-boundary semantics (the raw `lines.slice(-limit)` below would not:
 * `slice(-0)` is `slice(0)`, which returns the whole scanned window, and a negative limit
 * makes `slice` positive-started, returning the window minus its first `-limit` lines).
 * Observers poll this every second and only ever need the tail, so for logs past the small-file
 * threshold we read just enough bytes from the end of the file to cover `limit` lines instead of
 * rescanning the whole log: per-poll I/O is bounded by what `limit` lines occupy, not by how far
 * the log has grown (the backwards chunk scan lives in tail.readTailText). The parsed tail is
 * also stat-keyed cached (stat-cache.cachedByStat, like the other per-poll readers): the log is
 * append-only, so an unchanged stat means unchanged tail bytes, and a steady-state poll costs
 * one stat instead of open + read + `limit` JSON.parse calls. Rotation swaps the inode and every
 * append changes size, so both invalidate through the same freshness check. */
export function readEvents(root: string, limit = DEFAULT_EVENT_TAIL): HarnessEvent[] {
  // A non-positive guard (`limit <= 0`) passes NaN — every comparison with NaN is false —
  // and slice(-NaN) is slice(0), the whole scanned window; the sibling readTranscriptTail
  // and readTranscript guards are `limit > 0` positives-checks for exactly this reason.
  if (!(limit > 0)) return []; // NaN, 0, negatives: none — and the guard must precede the scan and the slice.
  const file = eventsLogPath(root);
  return (
    cachedByStat(
      tailCache,
      `${file}\u0000${limit}`, // Per (file, limit): observers ask for different tail sizes.
      file,
      () => scanEventTail(file, limit), // A missing/unreadable log scans to [] — cached like an empty one.
      (events) => events.map((e) => ({ ...e })), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** Parsed tails keyed by file + limit (a future reader of a second window size from the same
 * log must not collide with the first). Bounded inside cachedByStat so many short-lived roots
 * in tests cannot grow it unbounded. */
const tailCache = new Map<string, StatKeyedValue<HarnessEvent[]>>();

/** The backwards tail scan readEvents caches: read just enough bytes from the end to cover
 * `limit` lines, parse them, keep the newest `limit` complete ones. Also reports the byte end
 * the scan covered through (tail.readTailTextWithEnd — the last complete line's boundary) for
 * callers that seed a follow from the same read. */
function scanEventTailWithEnd(file: string, limit: number): { events: HarnessEvent[]; coveredEnd: number } {
  let newlines = 0;
  const { text, coveredEnd } = readTailTextWithEnd(file, (chunk) => {
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
    // limit+1 newlines guarantees `limit` complete lines after the first one
    // (the partial leading line, if any, is unparseable and skipped below).
    return newlines >= limit + 1;
  });

  const lines = text.split("\n").filter(Boolean);
  // A torn trailing line (no final \n — a write in flight, or between a crash and the next
  // event) would occupy one of the `limit` slots below and fail to parse: hold it back until
  // its newline lands, the same policy as readCompleteLines.
  if (lines.length > 0 && !text.endsWith("\n")) lines.pop();
  const tail = lines.slice(-limit);
  const events: HarnessEvent[] = [];
  for (const line of tail) {
    const ev = parseEventLine(line);
    if (ev) events.push(ev);
  }
  return { events, coveredEnd };
}

/** The cached scan's uncached twin, for one-shot callers that also need the covered byte end:
 * `tumwater logs -f` seeds its follow from the read that produced the printed window, so an
 * event appended between that read and the follow's start is delivered by the follow's first
 * poll instead of falling into the both-neither gap a fresh stat seed leaves. It skips the
 * stat-keyed cache because the cache carries only the parsed events — the covered end is not
 * part of the cached value — and this runs once per command invocation, not per poll. */
export function readEventsTailWithEnd(root: string, limit: number): { events: HarnessEvent[]; coveredEnd: number } {
  if (!(limit > 0)) return { events: [], coveredEnd: 0 }; // Same non-positive guard as readEvents.
  return scanEventTailWithEnd(eventsLogPath(root), limit);
}

/** The cached tail scan readEvents builds on: identical result, end dropped. */
function scanEventTail(file: string, limit: number): HarnessEvent[] {
  return scanEventTailWithEnd(file, limit).events;
}
