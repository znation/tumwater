import path from "node:path";
import { listQueueFiles, queueFileName, removeQueueFile } from "./file-queue.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { landQueueDir } from "./paths.js";
import type { LandingEntry } from "./types.js";

/** The durable land queue (plans/merge-queue.md 3/5): a changed tick commits, pins its sha by
 * `refs/tumwater/landing/<role>`, and enqueues one entry here — then the tick ENDS, holding no
 * author slot through review or the build check. The orchestrator drains the queue through its
 * landing pipeline (landing-drain.ts): it vets every queued entry, merges the vetted ones in
 * queue order on one merge slot, and drops each entry after EVERY outcome (a non-terminal one keeps the landing
 * ref, so the retry rides next-tick leftover recovery at normal cadence — the queue never
 * retries). Timestamped filenames order the queue across processes; a crash between enqueue
 * and drop loses nothing — the next start drains the survivors, deduping shas main already
 * holds. Same reasons the director's inbox is a directory of files (inbox.ts). */

let seq = 0;

/** Append one landing to the queue as a single timestamped file (creating the queue dir if
 * needed). The filename orders entries across processes by wall-clock time; the per-process
 * counter and pid break ties within one process. */
export function enqueueLanding(root: string, entry: LandingEntry): void {
  const dir = landQueueDir(root);
  const name = queueFileName(entry.enqueuedAt, seq++, ".json");
  writeJsonFile(path.join(dir, name), entry);
}

/** Every queue file in execution order (oldest first) — the same filename sort queuedLandings,
 * headLanding, and the orchestrator's per-poll queued-roles set read. A missing queue dir
 * reads as an empty queue. */
function queueFiles(root: string): string[] {
  return listQueueFiles(landQueueDir(root), ".json");
}

/** Number of landings currently queued — a directory listing only; no file content is read.
 * A missing queue dir reads as 0, like every other reader here. */
export function queueDepth(root: string): number {
  return queueFiles(root).length;
}

// Per-poll entry-content cache (stat-cache.cachedByStat): dashboard polls must not re-parse
// every queued entry — each file is written once by enqueueLanding and only deleted on drop,
// the same write-once discipline the inbox caches for prompts.
const entryCache = new Map<string, StatKeyedValue<LandingEntry>>();

/** True when `v` carries every field a LandingEntry requires, with the right type. The land
 * queue is one JSON object per file, so a file that parses to anything else — a scalar, an
 * array, an object missing a required field — is foreign or torn and reads as no entry.
 * Checking only `role` and `sha` left the `as LandingEntry` cast unsound: a foreign file that
 * happened to carry those two fields was handed downstream with `tick` and `summary`
 * undefined, which surface as bogus session names (`tumwater-<role>-undefined-review`) and
 * `undefined` in the reviewer's prompt. Optional fields are checked only when present. */
function isLandingEntry(v: unknown): v is LandingEntry {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.role === "string" &&
    typeof e.sha === "string" &&
    typeof e.tick === "number" &&
    typeof e.summary === "string" &&
    typeof e.enqueuedAt === "number" &&
    (e.body === undefined || typeof e.body === "string") &&
    (e.highFriction === undefined || typeof e.highFriction === "boolean")
  );
}

/** Read one queue file through the stat-keyed cache: null when it vanishes mid-listing (a
 * concurrent drop — the inbox.ts race policy), is unreadable, or fails to parse or to carry
 * every required LandingEntry field (a foreign or torn file is skipped, never thrown on). A
 * shallow copy out: the entry's fields are all scalars and callers treat the result as
 * read-only. */
function readEntry(file: string): LandingEntry | null {
  return cachedByStat(entryCache, file, file, () => {
    // readJsonFile is the shared "missing or torn reads as no data" policy; a foreign shape
    // is still rejected by isLandingEntry.
    const parsed = readJsonFile<LandingEntry>(file);
    return isLandingEntry(parsed) ? parsed : null;
  }, (e) => ({ ...e }));
}

/** Every queued landing in execution order (oldest first) paired with the file to drop on
 * completion. The batch drain (merge queue 5/5) reads this slice because `dropLanding` needs
 * the file, which the bare-entry readers never return. A missing queue directory reads as an
 * empty queue. */
export function queuedLandingFiles(root: string): { entry: LandingEntry; file: string }[] {
  const out: { entry: LandingEntry; file: string }[] = [];
  for (const file of queueFiles(root)) {
    const entry = readEntry(file);
    if (entry) out.push({ entry, file });
  }
  return out;
}

/** All queued landings in execution order (oldest first). A missing queue directory reads as
 * an empty queue. */
export function queuedLandings(root: string): LandingEntry[] {
  return queuedLandingFiles(root).map((q) => q.entry);
}

/** The head of the queue — its oldest entry — plus the file to drop on completion, or null when the queue is empty or its oldest file is
 * a vanished/torn entry. */
export function headLanding(root: string): { entry: LandingEntry; file: string } | null {
  const file = queueFiles(root)[0];
  if (!file) return null;
  const entry = readEntry(file);
  return entry ? { entry, file } : null;
}

/** The oldest queue file when the queue is non-empty but its head is unreadable — torn (a
 * hard crash mid enqueueLanding write) or foreign — i.e. when headLanding reads null while
 * the queue holds files; null when the queue is empty or its head is healthy. The drain
 * drops this file with a warning so the queue can drain: headLanding reads null for it
 * forever and nothing else will remove it, stranding every live entry behind it (each
 * author's interlock, the per-poll queued-roles set, pins its ticks along with them). The
 * crashed entry's commit, if any, still lives in its landing ref — next-tick leftover recovery re-lands
 * it — so the drop loses nothing recoverable from the file (BUGS.md 2026-09-16). */
export function staleHeadFile(root: string): string | null {
  const file = queueFiles(root)[0];
  if (!file) return null;
  return readEntry(file) === null ? file : null;
}

/** Remove one queued landing's file after its landing outcome — terminal or not (a
 * non-terminal outcome keeps the landing ref; the retry is the role's next fresh tick, not a
 * queue re-drain). ENOENT is a no-op: a concurrent drop between listing and removal is a
 * normal race (the inbox.ts policy), not an error. */
export function dropLanding(file: string): void {
  removeQueueFile(file);
}
