import { errCode } from "../errno.js";
import fs from "node:fs";
import path from "node:path";
import { listQueueFiles, queueFileName, removeQueueFile } from "../files/file-queue.js";
import { isJsonObject, nonNegativeNumber } from "../files/json-object.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import type { MigrationNotes } from "../orchestrator/startup-migrations.js";
import { mergeQueueDir, legacyLandQueueDir } from "../paths.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** The durable merge queue (plans/merge-queue.md 3/5): a changed run commits, pins its sha by
 * `refs/tumwater/landing/<role>`, and enqueues one entry here — then the run ENDS, holding no
 * author slot through review or the build check. The orchestrator drains the queue through its
 * merge pipeline (merge-drain.ts): it verifies every queued entry, merges the approved ones in
 * queue order on one merge slot, and drops each entry after EVERY outcome (a non-terminal one
 * keeps the merge ref, so the retry rides next-run leftover recovery at normal cadence — the
 * queue never retries). Timestamped filenames order the queue across processes; a crash between
 * enqueue and drop loses nothing — the next start drains the survivors, deduping shas main
 * already holds. Same reasons the director's inbox is a directory of files (inbox.ts). The
 * entry's shape (MergeEntry) lives here beside the queue's reader/writer — moved out of the
 * types.ts grab-bag. */

/** The review that rejected the change a revision is revising (plans/revise-rejected.md part
 * 2/2): the rejected head and the numbered objections the reviewer named. It rides the queued
 * entry so the re-review can be shown what the revision had to resolve, plus the interdiff
 * between the two versions. `counts` carries each objection's persistence count (aligned with
 * `reasons`; BUGS.md 2026-10-14) so the next rejection can resolve a `(prior N)` restatement
 * in the re-review's reasons to a count and end a chain whose objection has stopped converging.
 * Absent on a fresh change and read back as absent on a recovery merge, which is reviewed
 * like a fresh change — a `(prior N)` tag then counts as a new objection. */
export interface PriorReview {
  sha: string;
  reasons: string[];
  counts?: number[];
}

/** One entry in the durable merge queue (.tumwater/land-queue/; this module): a commit
 * the run pinned by `refs/tumwater/landing/<role>` and enqueued at run end. One file per
 * entry, filename-ordered (`<ts>-<seq>-<pid>.json`); the entry is dropped after EVERY merge
 * outcome, so the queue holds only unattempted merges. No attempt counter lives in the file —
 * retry bookkeeping is the persisted `RunnerState.unreviewFailures`, which governs the strike cap.
 */
export interface MergeEntry {
  /** The owning runner — events, session naming, and the verify's leased slot all key off it. */
  role: string;
  /** The pinned commit to merge — checked out detached in the verify's leased pool slot. */
  sha: string;
  /** The authoring run number, for the unique per-run session names (review + conflict
   * resolution). */
  run: number;
  /** The change's one-line summary (the commit subject minus its prefix). */
  summary: string;
  /** The author's claimed WHY/RISK/VERIFIED — the reviewer checks it against the diff. */
  body?: string;
  /** The authoring run burned past the friction thresholds: the reviewer applies extra scrutiny. */
  highFriction?: boolean;
  /** Enqueue time (epoch ms) — the filename orders the queue by it across processes. */
  enqueuedAt: number;
  /** The revision round this change is, absent for a fresh change (plans/revise-rejected.md):
   * 1 for the first revision of a rejected change, 2 for the second. Carried onto the
   * MergeRequest so a rejection of round N sets round N+1; a rejection stops revising on a
   * repeated objection or the backstop (BUGS.md 2026-10-14). */
  revisionRound?: number;
  /** The prior rejection this merge is revising, absent for a fresh change
   * (plans/revise-rejected.md part 2/2). Filled by run-stage.ts from RunnerState.lastReview only
   * on a run that held the rejected diff; a recovery merge never carries one. */
  priorReview?: PriorReview;
  /** Earliest time (epoch ms) the verification may start, absent for an entry that is ready at
   * once. Set on the pipeline's own re-queue of a `review_error` change, so a flaky reviewer is
   * not hit again within 60 s; drainVerify skips the entry until then. */
  notBefore?: number;
  /** The retriable result (`merge_blocked`, `review_error`, `merge_conflict`, `main_red`) whose
   * attempt this entry re-queues, absent for an author's or a recovery's entry. Logged on the
   * re-queue's `merge_queued` event only. */
  retry?: string;
  /** How many times the pipeline has re-queued this change, absent for a fresh entry and a
   * recovery's entry; informational, not an ordering key — the filename still orders the queue
   * by the current attempt's `enqueuedAt`. */
  retryCount?: number;
}

let seq = 0;

/** Append one merge to the queue as a single timestamped file (creating the queue dir if
 * needed). The filename orders entries across processes by wall-clock time; the per-process
 * counter and pid break ties within one process. Written atomically (tmp + rename): the
 * enqueue runs while the process can be hard-killed mid-write (the run deadline's
 * process-group kill, a shutdown), and a torn entry the crash left behind is not always
 * recoverable — the drain repairs only an unreadable HEAD (staleHeadFile), so a torn file
 * that sorts after a healthy entry would sit in the queue dir unread forever. */
export function enqueueMerge(root: string, entry: MergeEntry): void {
  const dir = mergeQueueDir(root);
  const name = queueFileName(entry.enqueuedAt, seq++, ".json");
  writeJsonAtomic(path.join(dir, name), entry);
}

/** The revision fields of a queue entry, serialized only when present — the shape merge
 * surfaces (drain, verify) and the run-stage enqueue re-emit when they build their own
 * entry/request objects, so the `revisionRound`/`priorReview` names live in one place and
 * cannot drift. */
export function entryRevisionFields(e: { revisionRound?: number; priorReview?: PriorReview }): { revisionRound?: number; priorReview?: PriorReview } {
  return {
    ...(e.revisionRound !== undefined ? { revisionRound: e.revisionRound } : {}),
    ...(e.priorReview !== undefined ? { priorReview: e.priorReview } : {}),
  };
}

/** Every queue file in execution order (oldest first) — the same filename sort queuedMerges,
 * headMerge, and the orchestrator's per-poll queued-roles set read. A missing queue dir
 * reads as an empty queue. */
function queueFiles(root: string): string[] {
  // Files an old build enqueued into the legacy directory still count until the startup
  // migration moves them; the sort is by basename because the queue order lives in the name.
  const all = [...listQueueFiles(mergeQueueDir(root), ".json"), ...listQueueFiles(legacyLandQueueDir(root), ".json")];
  return all.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** The startup migration step: move every `*.json` from the legacy queue directory into the
 * current one, keeping the basename (the order lives in it) and the contents. A basename already
 * present in the new directory stays put and is noted; the old directory is removed once empty.
 * A file that vanished mid-move (a concurrent run) is skipped. */
export function legacyMigrateLandQueueDir(root: string): MigrationNotes {
  const from = legacyLandQueueDir(root);
  const to = mergeQueueDir(root);
  const notes: MigrationNotes = { moved: [], kept: [], failed: [] };
  const files = listQueueFiles(from, ".json");
  if (files.length > 0) fs.mkdirSync(to, { recursive: true });
  for (const file of files) {
    const name = path.basename(file);
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) {
      notes.kept.push(`${name} already in merge-queue, left in place`);
      continue;
    }
    try {
      fs.renameSync(file, dest);
      notes.moved.push(`moved ${name}`);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
  }
  try {
    fs.rmdirSync(from);
  } catch {
    // Missing, or still holding a file left in place or placed since: nothing to remove.
  }
  return notes;
}

/** Number of merges currently queued — a directory listing only; no file content is read.
 * A missing queue dir reads as 0, like every other reader here. */
export function queueDepth(root: string): number {
  return queueFiles(root).length;
}

// Per-poll entry-content cache (stat-cache.cachedByStat): dashboard polls must not re-parse
// every queued entry — each file is written once by enqueueMerge and only deleted on drop,
// the same write-once discipline the inbox caches for prompts.
const entryCache = new Map<string, StatKeyedValue<MergeEntry>>();

/** True when `v` carries every field a MergeEntry requires, with the right type. The merge
 * queue is one JSON object per file, so a file that parses to anything else — a scalar, an
 * array, an object missing a required field — is foreign or torn and reads as no entry.
 * Checking only `role` and `sha` left the `as MergeEntry` cast unsound: a foreign file that
 * happened to carry those two fields was handed downstream with `run` and `summary`
 * undefined, which surface as bogus session names (`tumwater-<role>-undefined-review`) and
 * `undefined` in the reviewer's prompt. Optional fields are checked only when present.
 *
 * The three numeric fields go through nonNegativeNumber, not a bare `typeof === "number"`:
 * JSON's `1e999` parses to Infinity, so a hand-edited file could carry a non-finite run or
 * enqueuedAt past a typeof check, and both feed plumbing downstream (session names, queue
 * ordering, the status payload). */
function isPriorReview(v: unknown): v is PriorReview {
  if (!isJsonObject(v)) return false;
  return (
    typeof v.sha === "string" &&
    Array.isArray(v.reasons) &&
    v.reasons.every((r) => typeof r === "string") &&
    (v.counts === undefined || (Array.isArray(v.counts) && v.counts.every((c) => nonNegativeNumber(c, null) !== null)))
  );
}

function isMergeEntry(v: unknown): v is MergeEntry {
  if (!isJsonObject(v)) return false;
  const e = v;
  return (
    typeof e.role === "string" &&
    typeof e.sha === "string" &&
    nonNegativeNumber(e.run, null) !== null &&
    typeof e.summary === "string" &&
    nonNegativeNumber(e.enqueuedAt, null) !== null &&
    (e.body === undefined || typeof e.body === "string") &&
    (e.highFriction === undefined || typeof e.highFriction === "boolean") &&
    (e.revisionRound === undefined || nonNegativeNumber(e.revisionRound, null) !== null) &&
    (e.priorReview === undefined || isPriorReview(e.priorReview)) &&
    (e.notBefore === undefined || nonNegativeNumber(e.notBefore, null) !== null) &&
    (e.retry === undefined || typeof e.retry === "string") &&
    (e.retryCount === undefined || nonNegativeNumber(e.retryCount, null) !== null)
  );
}

/** Read one queue file through the stat-keyed cache: null when it vanishes mid-listing (a
 * concurrent drop — the inbox.ts race policy), is unreadable, or fails to parse or to carry
 * every required MergeEntry field (a foreign or torn file is skipped, never thrown on). A
 * shallow copy out: the entry's fields are all scalars and callers treat the result as
 * read-only. */
function readEntry(file: string): MergeEntry | null {
  return cachedByStat(entryCache, file, file, () => {
    // readJsonFile is the shared "missing or torn reads as no data" policy; a foreign shape
    // is still rejected by isMergeEntry.
    let parsed: unknown = readJsonFile<object>(file);
    // An entry an old build wrote carries `tick` where the current shape has `run`.
    if (isJsonObject(parsed) && parsed.run === undefined && parsed.tick !== undefined) { // retired-name-ok: legacy name
      const { tick, ...rest } = parsed; // retired-name-ok: legacy name
      parsed = { ...rest, run: tick }; // retired-name-ok: legacy name
    }
    if (!isMergeEntry(parsed)) return null;
    const role = canonicalRoleId(parsed.role);
    return role === parsed.role ? parsed : { ...parsed, role };
  }, (e) => ({ ...e }));
}

/** Every queued merge in execution order (oldest first) paired with the file to drop on
 * completion. The batch drain (merge queue 5/5) reads this slice because `dropMerge` needs
 * the file, which the bare-entry readers never return. A missing queue directory reads as an
 * empty queue. */
export function queuedMergeFiles(root: string): { entry: MergeEntry; file: string }[] {
  const out: { entry: MergeEntry; file: string }[] = [];
  for (const file of queueFiles(root)) {
    const entry = readEntry(file);
    if (entry) out.push({ entry, file });
  }
  return out;
}

/** All queued merges in execution order (oldest first). A missing queue directory reads as
 * an empty queue. */
export function queuedMerges(root: string): MergeEntry[] {
  return queuedMergeFiles(root).map((q) => q.entry);
}

/** The roles currently holding a queued merge — the maintenance quota's and the permit
 * reserve's "already in flight" input, and the scheduler's per-poll merge-queue interlock.
 * A missing queue directory reads as an empty set, like every reader here. */
export function queuedMergeRoles(root: string): Set<string> {
  return new Set(queuedMergeFiles(root).map((q) => q.entry.role));
}

/** The queue read as one view: every readable entry in execution order (oldest first) plus the
 * number of queue files the reader skipped — torn, foreign, or vanished mid-listing. The one
 * home of "the queue as a view": `tumwater queue` renders it and `status`'s `mergeQueue`
 * projects it, so those callers cannot drift. The queue's depth is
 * `entries.length + unreadable`: every listed file is either a readable entry or skipped, so
 * the caller needs no second directory listing. A missing queue dir reads as
 * `{entries: [], unreadable: 0}`. */
export interface MergeQueueView {
  entries: MergeEntry[];
  unreadable: number;
}

/** Read every queue file once through the stat-keyed cache, collecting the readable entries
 * (filename order) and counting the rest — the torn/foreign file policy readEntry already
 * applies, surfacing the skip count instead of hiding it. */
export function readMergeQueue(root: string): MergeQueueView {
  const entries: MergeEntry[] = [];
  let unreadable = 0;
  for (const file of queueFiles(root)) {
    const entry = readEntry(file);
    if (entry) entries.push(entry);
    else unreadable++;
  }
  return { entries, unreadable };
}

/** The full path of every queue file `readMergeQueue` skips — torn, foreign, or vanished
 * mid-listing — in filename order. This names what `readMergeQueue.unreadable` counts, through
 * the same skip policy, so the count and the list cannot drift: nothing else ages a skipped
 * file (the drain repairs only an unreadable head), so each here is a stranded entry the
 * queue reader silently passes over. A missing queue directory reads as an empty list. */
export function unreadableMergeQueueFiles(root: string): string[] {
  const out: string[] = [];
  for (const file of queueFiles(root)) {
    if (readEntry(file) === null) out.push(file);
  }
  return out;
}

/** The head of the queue — its oldest entry — plus the file to drop on completion, or null when
 * the queue is empty or its oldest file is a vanished/torn entry. */
export function headMerge(root: string): { entry: MergeEntry; file: string } | null {
  const file = queueFiles(root)[0];
  if (!file) return null;
  const entry = readEntry(file);
  return entry ? { entry, file } : null;
}

/** The oldest queue file when the queue is non-empty but its head is unreadable — torn or
 * foreign (a partial write an older build left, a hand-placed file) — i.e. when headMerge
 * reads null while the queue holds files; null when the queue is empty or its head is healthy.
 * The drain drops this file with a warning so the queue can drain: headMerge reads null for
 * it forever and nothing else will remove it, stranding every live entry behind it (each
 * author's interlock, the per-poll queued-roles set, pins its runs along with them). The
 * crashed entry's commit, if any, still lives in its merge ref — next-run leftover recovery
 * re-merges it — so the drop loses nothing recoverable from the file (BUGS.md 2026-09-16). */
export function staleHeadFile(root: string): string | null {
  const file = queueFiles(root)[0];
  if (!file) return null;
  return readEntry(file) === null ? file : null;
}

/** Remove one queued merge's file after its merge outcome — terminal or not (a
 * non-terminal outcome keeps the merge ref; the retry is the role's next fresh run, not a
 * queue re-drain). ENOENT is a no-op: a concurrent drop between listing and removal is a
 * normal race (the inbox.ts policy), not an error. */
export function dropMerge(file: string): void {
  removeQueueFile(file);
}
