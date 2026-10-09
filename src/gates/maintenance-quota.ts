/** Work ratio 1a/4 and 1b/4 (plans/work-ratio.md, "Maintenance follows work"): the arithmetic,
 * the setting, and the gate behind the maintenance allowance — code-maintenance landings in a
 * rolling 24 h window are capped at `maintenancePerWorkLanding × work landings +
 * MAINTENANCE_DAILY_FLOOR`, and `pollMaintenanceQuotaGate` puts that verdict in front of the
 * scheduler so the enabled maintenance loops stop starting new ticks past it.
 *
 * The window counts `merged` events by `commitTier` (src/roles/roles.ts): feature/bugfix/director
 * are the work count, the code-maintenance roles plus readme the maintenance count, and every other
 * role (plan, steward, observers, custom) is neither. The count is an instant-shaped trailing
 * window — `ts >= now − 24 h` — not a local-day bucket, so it cannot reuse the report's
 * day-keyed fold cache (src/report/report-data.ts): instead the counter folds only the bytes the
 * append-only live log gained since the previous poll (`readCompleteLines`) and keeps the parsed
 * merged records in memory, re-reading the window whole only on the first call or after rotation.
 * Both readers share `parseEventLine`, so there is no second line parser.
 *
 * The verdict is pure and lives here beside the count so the scheduler and every status reader
 * share one definition; `pollMaintenanceQuotaGate` is the one writer (the edge-triggered events)
 * and the one reader the scheduler holds from. */

import { statOrNull } from "../files/files.js";
import { readCompleteLines } from "../files/tail.js";
import { eventsLogPath } from "../paths.js";
import { readWindowEvents } from "../events/event-window.js";
import { eventRole, parseEventLine } from "../events/event-read.js";
import { finiteNumber } from "../files/json-object.js";
import { dayKey } from "../text/datetime.js";
import { commitTier } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { logEventBestEffort } from "../events/events.js";
import type { HarnessEvent } from "../events/events.js";

/** The fixed test-independent part of the allowance: a project whose backlog is empty still gets
 * this many maintenance landings in a rolling day, so hygiene never stops entirely. */
export const MAINTENANCE_DAILY_FLOOR = 12;

/** The rolling window length: 24 h in ms. */
const MAINTENANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The allowance verdict for one poll. `allowance` is what the window permits, `used` is the
 * landed maintenance count plus the maintenance loops in flight, and `held` is true while used
 * has reached the allowance. Additive over the counts, so six concurrent permits cannot push
 * `used` past the line without the caller counting the in-flight loops
 * (pollMaintenanceQuotaGate). */
export interface MaintenanceQuotaVerdict {
  allowance: number;
  used: number;
  held: boolean;
}

/** The pure allowance verdict: `allowance = perWorkLanding × work + MAINTENANCE_DAILY_FLOOR`;
 * `used = maint + inFlight`; held while `used >= allowance`. No I/O — the counts and the
 * in-flight figure come from the caller, so the same verdict serves the scheduler and the
 * dashboards. */
export function maintenanceQuota(input: {
  work: number;
  maint: number;
  inFlight: number;
  perWorkLanding: number;
}): MaintenanceQuotaVerdict {
  const allowance = input.perWorkLanding * input.work + MAINTENANCE_DAILY_FLOOR;
  const used = input.maint + input.inFlight;
  return { allowance, used, held: used >= allowance };
}

/** One merged landing the window keeps: its timestamp and which side of the split it counts on. */
interface MergedRecord {
  ts: number;
  tier: "work" | "maintenance";
}

/** The cross-poll memo behind `countMaintenanceWindow`: the live-log byte offset already folded,
 * the file identity that offset covers (size/mtime alone cannot tell a rotation from a grown
 * file), and the merged records seen so far, oldest first. Callers own one per root and pass it
 * back on each poll; it is in memory only, so a restart seeds from scratch. */
interface MaintenanceWindowCounter {
  seeded: boolean;
  offset: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  records: MergedRecord[];
}

/** A fresh counter: nothing folded yet, so the first count seeds from a full windowed read. */
export function newMaintenanceWindowCounter(): MaintenanceWindowCounter {
  return { seeded: false, offset: 0, mtimeMs: 0, dev: 0, ino: 0, records: [] };
}

/** Which tier a merged event counts on, or null when it is not a merged event or its role is
 * outside both tiers. The one bridge from the event log to `commitTier`. */
function tierOfEvent(ev: HarnessEvent): "work" | "maintenance" | null {
  if (ev.type !== "merged") return null;
  return commitTier(eventRole(ev)) ?? null;
}

/** Parse one appended log line and keep it when it is a tier-counted merge; a torn, non-event,
 * non-merged, tierless, or timestamp-less line contributes nothing. */
function foldLine(records: MergedRecord[], line: string): void {
  const ev = parseEventLine(line);
  if (!ev) return;
  const tier = tierOfEvent(ev);
  if (tier === null) return;
  const ts = finiteNumber(ev.ts, null);
  if (ts === null) return;
  records.push({ ts, tier });
}

/** Replace the counter with a full read of the window ending at `cutoff`, keyed on the cutoff's
 * local day (the windowed reader's own day-keyed scan — over-read of earlier hours that day is
 * filtered by the ts check). Used on the first count and whenever the live file's identity says
 * a prior append could not be trusted (rotation, truncation, replacement). The resume offset is
 * `window.liveEnd`, which sits past any trailing fragment the windowed read already parsed and
 * counted, so the next append's fold cannot re-read it. */
function seed(
  counter: MaintenanceWindowCounter,
  root: string,
  cutoff: number,
  stat: { mtimeMs: number; dev: number; ino: number } | null,
): void {
  const window = readWindowEvents(root, dayKey(cutoff));
  const records: MergedRecord[] = [];
  for (const ev of window.events) {
    const tier = tierOfEvent(ev);
    if (tier === null) continue;
    const ts = finiteNumber(ev.ts, null);
    if (ts === null || ts < cutoff) continue;
    records.push({ ts, tier });
  }
  counter.records = records;
  counter.offset = window.liveEnd;
  counter.seeded = true;
  counter.mtimeMs = stat?.mtimeMs ?? 0;
  counter.dev = stat?.dev ?? 0;
  counter.ino = stat?.ino ?? 0;
}

/** One enabled loop as the quota gate reads it: whether a maintenance-tier tick is in flight
 * (running a tick or holding a queued landing). Only the two in-flight facts matter; the tier
 * is derived from the role here, so the caller passes every runner unchanged. */
interface MaintenanceQuotaObservation {
  role: string;
  enabled: boolean;
  running: boolean;
  hasQueuedLanding: boolean;
}

/** The gate's cross-poll memory: the same instant-shaped window memo as `countMaintenanceWindow`
 * uses (in memory only, so a restart seeds from scratch), plus the hold verdict of the previous
 * poll — the whole memory needed for the one-event-per-transition contract. */
export interface MaintenanceQuotaGateState {
  counter: MaintenanceWindowCounter;
  prevHeld: boolean;
}

/** A fresh gate state: nothing folded yet, and the gate starts open (the window is counted on
 * the first poll, which logs a `maintenance_quota_hold` only if it is already over the line). */
export function newMaintenanceQuotaGateState(): MaintenanceQuotaGateState {
  return { counter: newMaintenanceWindowCounter(), prevHeld: false };
}

/** Step the gate by one orchestrator poll: count the rolling window, add the maintenance loops
 * in flight, and put 1a's verdict in front of the scheduler. Returns the verdict — `allowance`,
 * `used` (landed maintenance plus the loops already in flight), and `held` (`used >= allowance`)
 * — for the scheduling pass's per-poll admission: it spends the remaining `allowance - used`
 * headroom one due maintenance loop at a time, so two due loops cannot start in the same poll.
 * Logs exactly one fleet-level `maintenance_quota_hold` when the gate goes from open to held and
 * one `maintenance_quota_resumed` when it re-opens — never one per loop. The director is never
 * maintenance-tier, so no exemption is needed. */
export function pollMaintenanceQuotaGate(
  root: string,
  state: MaintenanceQuotaGateState,
  observers: readonly MaintenanceQuotaObservation[],
  perWorkLanding: number,
  now: number,
): MaintenanceQuotaVerdict {
  const { work, maint } = countMaintenanceWindow(root, state.counter, now);
  let inFlight = 0;
  for (const o of observers) {
    if (!o.enabled) continue;
    if (commitTier(baseRoleOf(o.role)) !== "maintenance") continue;
    if (o.running || o.hasQueuedLanding) inFlight++;
  }
  const verdict = maintenanceQuota({ work, maint, inFlight, perWorkLanding });
  if (verdict.held !== state.prevHeld) {
    if (verdict.held) {
      logEventBestEffort(root, {
        loop: "harness",
        type: "maintenance_quota_hold",
        work,
        maint,
        allowance: verdict.allowance,
      });
    } else {
      logEventBestEffort(root, {
        loop: "harness",
        type: "maintenance_quota_resumed",
        work,
        maint,
        allowance: verdict.allowance,
      });
    }
    state.prevHeld = verdict.held;
  }
  return verdict;
}

/** Count `merged` landings by tier over the rolling 24 h ending `now`, folding only the live
 * log's appended bytes since the previous call through `counter`. Returns `{ work, maint }`;
 * records that have aged out of the window are dropped from the memo so it stays bounded. */
export function countMaintenanceWindow(
  root: string,
  counter: MaintenanceWindowCounter,
  now: number,
): { work: number; maint: number } {
  const cutoff = now - MAINTENANCE_WINDOW_MS;
  // The log is read through a regular-file guard so a path that is missing or not a regular file
  // (a directory left in its place, a vanished symlink) folds nothing this poll rather than
  // throwing. Both the orchestrator's poll loop and the every-second status observers call this,
  // and a best-effort gateway read must never end either. A readable file can still fail
  // mid-poll (replaced between the stat and the read), so the folding itself is guarded too.
  const stat = statOrNull(eventsLogPath(root));
  const readable = stat?.isFile() ? stat : null;
  const size = readable?.size ?? 0;
  const mtimeMs = readable?.mtimeMs ?? 0;
  const dev = readable?.dev ?? 0;
  const ino = readable?.ino ?? 0;
  const unchanged =
    size === counter.offset && mtimeMs === counter.mtimeMs && dev === counter.dev && ino === counter.ino;
  if (readable) {
    try {
      if (!counter.seeded || (!unchanged && !(size > counter.offset && dev === counter.dev && ino === counter.ino))) {
        seed(counter, root, cutoff, readable);
      } else if (!unchanged) {
        const { lines, end } = readCompleteLines(eventsLogPath(root), counter.offset, size);
        if (end > counter.offset) {
          for (const line of lines) foldLine(counter.records, line);
          counter.offset = end;
        }
        counter.mtimeMs = mtimeMs;
      }
    } catch {
      // Unreadable this poll: the memo's existing records still count; retry next poll.
    }
  } else if (stat === null && !counter.seeded) {
    // The log does not exist yet: seed an empty memo — the same state a first read of an empty
    // window yields — so the first count is remembered and a log that appears later seeds
    // normally. A path that exists but is not a regular file (a directory, a dangling symlink)
    // is left unfolded by the guard above rather than risk a throw.
    seed(counter, root, cutoff, null);
  }
  let work = 0;
  let maint = 0;
  const kept: MergedRecord[] = [];
  for (const rec of counter.records) {
    if (rec.ts < cutoff) continue;
    kept.push(rec);
    if (rec.tier === "work") work++;
    else maint++;
  }
  counter.records = kept;
  return { work, maint };
}
