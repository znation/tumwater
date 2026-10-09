/** Work ratio 1a/4 (plans/work-ratio.md, "Maintenance follows work"): the arithmetic and the
 * setting behind the maintenance allowance — code-maintenance landings in a rolling 24 h window
 * are capped at `maintenancePerWorkLanding × work landings + MAINTENANCE_DAILY_FLOOR`. This part
 * computes the verdict; Work ratio 1b/4 puts it in front of the scheduler, so nothing here holds
 * a loop yet.
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
 * share one definition; the gate that consumes the returned set lands in 1b/4. */

import { statOrNull } from "../files/files.js";
import { readCompleteLines } from "../files/tail.js";
import { eventsLogPath } from "../paths.js";
import { readWindowEvents } from "../events/event-window.js";
import { eventRole, parseEventLine } from "../events/event-read.js";
import { finiteNumber } from "../files/json-object.js";
import { dayKey } from "../text/datetime.js";
import { commitTier } from "../roles/roles.js";
import type { HarnessEvent } from "../events/events.js";

/** The fixed test-independent part of the allowance: a project whose backlog is empty still gets
 * this many maintenance landings in a rolling day, so hygiene never stops entirely. */
export const MAINTENANCE_DAILY_FLOOR = 12;

/** The rolling window length: 24 h in ms. */
const MAINTENANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The allowance verdict for one poll. `allowance` is what the window permits, `used` is the
 * landed maintenance count plus the maintenance loops in flight, and `held` is true while used
 * has reached the allowance. Additive over the counts, so six concurrent permits cannot push
 * `used` past the line without the caller counting the in-flight loops (Work ratio 1b/4). */
interface MaintenanceQuotaVerdict {
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
 * a prior append could not be trusted (rotation, truncation, replacement). */
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

/** Count `merged` landings by tier over the rolling 24 h ending `now`, folding only the live
 * log's appended bytes since the previous call through `counter`. Returns `{ work, maint }`;
 * records that have aged out of the window are dropped from the memo so it stays bounded. */
export function countMaintenanceWindow(
  root: string,
  counter: MaintenanceWindowCounter,
  now: number,
): { work: number; maint: number } {
  const cutoff = now - MAINTENANCE_WINDOW_MS;
  const stat = statOrNull(eventsLogPath(root));
  const size = stat?.size ?? 0;
  const mtimeMs = stat?.mtimeMs ?? 0;
  const dev = stat?.dev ?? 0;
  const ino = stat?.ino ?? 0;
  const unchanged =
    size === counter.offset && mtimeMs === counter.mtimeMs && dev === counter.dev && ino === counter.ino;
  if (!counter.seeded || (!unchanged && !(size > counter.offset && dev === counter.dev && ino === counter.ino))) {
    seed(counter, root, cutoff, stat);
  } else if (!unchanged) {
    const { lines, end } = readCompleteLines(eventsLogPath(root), counter.offset, size);
    if (end > counter.offset) {
      for (const line of lines) foldLine(counter.records, line);
      counter.offset = end;
    }
    counter.mtimeMs = mtimeMs;
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
