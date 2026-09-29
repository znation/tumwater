import fs from "node:fs";
import { eventsLogPath } from "./paths.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { dayKey } from "./datetime.js";
import { isJsonObject } from "./json-object.js";
import {
  ensureParentDir,
  openForRead,
  readTailText,
  rotateIfLarge,
  statOrNull,
} from "./files.js";

type EventListener = (event: HarnessEvent) => void;
const listeners = new Set<EventListener>();

/** Get notified of every event logged in this process (e.g. to narrate `tumwater run`).
 * Returns an unsubscribe function. */
export function subscribeEvents(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** events.jsonl rotation threshold. Role pi logs use the configurable logMaxBytes; the
 * harness event log is small per event, so a fixed cap keeps logEvent config-free. Exported
 * because the report headers name the threshold — a fact only this module owns. */
export const EVENTS_MAX_BYTES = 16 * 1024 * 1024;

/** The rotation phrase the report headers render — `eventsRotationLabel()` rather than a
 * hardcoded "rotated at 16 MB" copy, so changing EVENTS_MAX_BYTES updates the header with it
 * instead of leaving every report claiming a size the log no longer rotates at. */
export function eventsRotationLabel(): string {
  return `rotated at ${EVENTS_MAX_BYTES / (1024 * 1024)} MB`;
}

/** One line in .tumwater/log/events.jsonl: what logEvent appends (a HarnessEventInput plus
 * its `ts` stamp) and every consumer (event-window, history, the report and failure
 * collectors) reads back. */
export interface HarnessEvent {
  ts: number;
  loop: string;
  type:
    | "tick_start"
    | "tick_end"
    | "land_queued" // a changed tick pinned its commit and enqueued it for the orchestrator's landing slot (merge queue 3/5); carries sha + summary
    | "landed" // the landing slot finished with the change on main; carries commit, the lander's outcome, durationMs, and the landing's own usage
    | "land_failed" // the landing slot finished without landing (review rejection, under-cap review failure, conflict, blocked ff, shutdown abort); carries the same payload — retry rides next-tick leftover recovery, never the queue
    | "merged"
    | "question_posted" // a merged diff added an entry to QUESTIONS.md's ## Open
    | "wake"
    | "tick_deferred" // need-based prioritization: a due maintenance tick was deferred (no feature/bugfix/director/human commit landed since its last no_change tick); one per deferral episode
    | "orchestrator_start"
    | "orchestrator_stop"
    | "prompt_enqueued"
    | "prompt_cancelled" // a queued prompt was removed before the director ran it (tumwater prompt --cancel)
    | "counters_reset"
    | "tick_aborted" // a user-initiated abort killed one loop's in-flight tick (tumwater abort)
    | "resume"
    | "review_start"
    | "review_verdict" // approved; carries durationMs of the reviewer run
    | "review_rejected" // build pre-check or reviewer said no; durationMs when a reviewer ran
    | "review_failed"
    | "build_check" // the project's declared check ran: scope gate|baseline|landing|batch (landing is the merge lock's post-rebase re-check; batch is the batch lander's one check over the stacked tree), status, script, durationMs; spawnedAt/settledAt when a process ran, plus timeoutMs/deadlineLateMs when its deadline fired (build-check-events.ts buildCheckRunFields)
    | "budget_paused" // fleet daily spend reached maxDailyCostUsd with no usable free fallback; role loops stop starting ticks
    | "budget_fallback" // fleet daily spend reached maxDailyCostUsd and a cost-free fallback model is configured; role loops keep ticking on it
    | "budget_resumed" // the cap was raised/disabled or a new local day started; role loops tick again
    | "fleet_paused" // operator pause via `tumwater pause`; role loops stop starting new ticks, director exempt
    | "fleet_resumed" // the pause was lifted (`tumwater resume`); role loops tick again
    | "role_paused" // operator pause via `tumwater pause --role <id>`; that one role stops starting new ticks (carries role)
    | "role_resumed" // the per-role pause was lifted (`tumwater resume --role <id>`); that role ticks again (carries role)
    | "rate_limit_hold" // several roles' runs ended on a provider 429 within a short window (src/rate-limit-hold.ts); role loops and the landing slot start nothing new until it re-opens; carries roles, holdMs, escalation
    | "rate_limit_resumed" // the 429 hold reached its deadline; role loops tick again
    | "max_concurrent_changed" // a live tumwater.json edit resized the concurrency cap (from → to)
    | "retention_changed" // a live tumwater.json edit changed sessionRetentionDays (from → to)
    | "config_changed" // a live tumwater.json edit changed other settings (keys)
    | "build_stale" // main's build inputs moved past the running build (self-hosting fleets; src/redeploy.ts)
    | "restart_pending" // main is green and compiling; no new ticks start until the restart lands
    | "restart" // dist/ now holds the new build; the orchestrator exits for the supervisor to respawn it
    | "restart_refused" // a new generation would fail `tumwater run`'s startup gate here (reason); the running build stays and the gate is re-asked every poll
    | "restart_blocked" // the restart for main was blocked and latched (reason: red main, a failed compile, a swap error); the running build stays until main moves
    | "supervisor_exit" // the supervisor gave up without the operator asking: a generation exited with a failure (code/signal, reason when the startup gate names one) or the crash-loop guard tripped — the fleet is down
    | "warning";
  [key: string]: unknown;
}
/** An event to log. `logEvent` stamps `ts`; event-specific extra fields (tick, summary, …)
 * are allowed via the index signature. Exported for modules that hand events to an injected
 * logger instead of calling logEvent directly (redeploy.ts). */
export interface HarnessEventInput {
  loop: string;
  type: HarnessEvent["type"];
  [key: string]: unknown;
}

/** Append one event to the project's events.jsonl and notify in-process subscribers.
 * A torn trailing line (a crash or power loss mid-append leaves the last line without its
 * newline) is terminated first: appended raw, the new event would glue onto the fragment and
 * both lines would fail JSON.parse forever — one complete event lost from every consumer
 * (report totals, feeds) until rotation. */
export function logEvent(root: string, event: HarnessEventInput): HarnessEvent {
  const full = { ts: Date.now(), ...event };
  const file = eventsLogPath(root);
  ensureParentDir(file);
  rotateIfLarge(file, EVENTS_MAX_BYTES);
  terminateTornTail(file);
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
  for (const listener of listeners) listener(full);
  return full;
}

/** Log a warning event: the harness's "something is off but the loop continues" signal. The
 * single home of the `{ loop, type: "warning", message }` shape every warn site constructs —
 * without it, each caller restates the event object and a field can drift between them. */
export function warnEvent(root: string, loop: string, message: string): HarnessEvent {
  return logEvent(root, { loop, type: "warning", message });
}

/** Append a newline when `file`'s last byte is not one — terminating a torn trailing line so
 * the next append starts on its own line instead of gluing onto the fragment. No-op for a
 * missing, empty, or already-terminated file; never throws (a vanished file just means there
 * is nothing to terminate). Runs after rotateIfLarge: rotation moves any torn tail into the
 * unread `.1` archive and starts an empty file that needs no termination. */
function terminateTornTail(file: string): void {
  const st = statOrNull(file);
  if (!st || st.size === 0) return; // No log yet.
  const fd = openForRead(file);
  if (fd === null) return; // Vanished between stat and open — nothing to terminate.
  try {
    const size = fs.fstatSync(fd).size; // fstat on the opened inode: correct even if rotation renamed the file mid-check.
    if (size === 0) return;
    const buf = Buffer.alloc(1);
    const got = fs.readSync(fd, buf, 0, 1, size - 1);
    if (got !== 1 || (buf[0] ?? 0) === 10) return; // Already newline-terminated (or vanished).
    fs.appendFileSync(file, "\n");
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse one line of the event log into a HarnessEvent, or null when it is torn or corrupt
 * (a crash mid-append leaves a partial final line without its newline). The single home of
 * the skip-without-failing policy every consumer of events.jsonl applies — readEvents here,
 * report.ts's window scan, and `tumwater logs -f`'s follow branch all parse through it instead
 * of repeating the try/catch per reader. A valid-JSON scalar, `null`, or array is not an event
 * object either: the log is one JSON object per line, so anything else is corrupt (or foreign)
 * and reads as no data — the same object check readJsonFile applies to the harness's state
 * files. Without it, `readEvents` pushes the truthy non-object into the feed and `formatEvent`
 * renders it as an `Invalid Date undefined` line. */
export function parseEventLine(line: string): HarnessEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed)) return null; // Not an event object.
    return parsed as HarnessEvent;
  } catch {
    return null; // Skip partial/corrupt lines (e.g. torn writes).
  }
}

/** The local calendar-day key ("YYYY-MM-DD") of an event's `ts`, or null when it carries no
 * numeric timestamp. The one day-bucketing rule the windowed reader (event-window.ts) and the
 * usage/failure reports all apply, so they agree on what counts as one day. */
export function eventDayKey(ev: HarnessEvent): string | null {
  return typeof ev.ts === "number" ? dayKey(ev.ts) : null;
}

/** The loop id an event is filed under, or "?" when absent or empty — the guard the usage
 * report and the failure digest both apply when grouping by role. */
export function eventRole(ev: HarnessEvent): string {
  return typeof ev.loop === "string" && ev.loop !== "" ? ev.loop : "?";
}

/** The usage numbers an event records (`tick_end`'s own run, `landed`'s landing slot):
 * `tokens` and `costUsd` arrive `unknown` through the event's index signature, so they are
 * coerced to numbers here, with an absent, non-numeric, or non-finite value reading as 0 —
 * the one convention every usage consumer applies (the event feed's usage fragment,
 * `tumwater history`'s rows and --json, the usage report's fold), so the field rule —
 * including what a corrupt value contributes — lives beside the event shape, not re-spelled
 * per consumer. */
export function eventUsage(ev: HarnessEvent): { tokens: number; costUsd: number } {
  const tokens = typeof ev.tokens === "number" && Number.isFinite(ev.tokens) ? ev.tokens : 0;
  const costUsd =
    typeof ev.costUsd === "number" && Number.isFinite(ev.costUsd) ? ev.costUsd : 0;
  return { tokens, costUsd };
}

/** Pair the tick_start events of `events` by tick, keyed `${loop}#${tick}` → start epoch ms —
 * the one home of that pairing and its key format, shared by `tumwater history`'s rows
 * (ui/history.ts) and the failure digest's time-and-spend fold (failure-data.ts), so the two
 * consumers cannot drift into different notions of a tick's span. A tick_end whose start is
 * not in `events` (log rotation cut it, or the tick was skipped before any start logged) has
 * no entry; callers decide what an unpaired end costs. Lives beside the event shape, not in
 * a ui module, so core collectors can share it without a core→ui import. */
export function tickStartMap(events: HarnessEvent[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tick_start") starts.set(`${e.loop}#${e.tick}`, e.ts);
  }
  return starts;
}

/** Read the last `limit` events (best-effort; skips malformed lines).
 * A limit that is not a positive number reads as an empty window — `[]` — matching
 * readTranscriptTail's zero-boundary semantics (the raw `lines.slice(-limit)` below would not: `slice(-0)` is
 * `slice(0)`, which returns the whole scanned window, and a negative limit makes `slice`
 * positive-started, returning the window minus its first `-limit` lines).
 * Observers poll this every second and only ever need the tail, so for logs past the small-file
 * threshold we read just enough bytes from the end of the file to cover `limit` lines instead of
 * rescanning the whole log: per-poll I/O is bounded by what `limit` lines occupy, not by how far
 * the log has grown (the backwards chunk scan lives in files.readTailText). The parsed tail is
 * also stat-keyed cached (stat-cache.cachedByStat, like the other per-poll readers): the log is
 * append-only, so an unchanged stat means unchanged tail bytes, and a steady-state poll costs
 * one stat instead of open + read + `limit` JSON.parse calls. Rotation swaps the inode and every
 * append changes size, so both invalidate through the same freshness check. */
export function readEvents(root: string, limit = 200): HarnessEvent[] {
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
 * `limit` lines, parse them, keep the newest `limit` complete ones. */
function scanEventTail(file: string, limit: number): HarnessEvent[] {
  let newlines = 0;
  const text = readTailText(file, (chunk) => {
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
    // limit+1 newlines guarantees `limit` complete lines after the first one
    // (the partial leading line, if any, is unparseable and skipped below).
    return newlines >= limit + 1;
  });

  let lines = text.split("\n").filter(Boolean);
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
  return events;
}

// Human-facing formatting of events lives in event-format.ts, beside this module because
// both display surfaces (src/ui/) and core consumers (the `run` banner's live stream,
// src/cli-run.ts) render it, and src/ui/ is imported only by each other and cli.ts
// (DEVELOPMENT.md Layout). This module owns only the log file and its subscribers.
