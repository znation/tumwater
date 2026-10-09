/** The worktree-use registry (plans/disk-floor.md, "Reclaiming build outputs", part 2/4):
 * which harness worktrees are in use right now, and when each was last used. The orchestrator
 * is the one process that runs ticks and landings, so a plain in-process map is enough for the
 * "in use" half; the "last used" half is persisted to `.tumwater/state/worktree-use.json` so
 * least-recently-used reclaim ordering survives a restart.
 *
 * A reclaim claims a worktree before it cleans it, so a `useWorktree` that arrives mid-clean
 * waits for the clean to finish instead of starting work in a half-emptied tree. Every wrapped
 * site holds its worktree from its FIRST touch (before `ensureWorktree` / `ensureDetachedWorktree`
 * creates or resets it) to its last, so creation and reset are protected too. */

import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { finiteNumber, isJsonObject } from "../files/json-object.js";
import { withStateLock } from "../concurrency/lock.js";
import { worktreeUseLockPath, worktreeUsePath } from "../paths.js";

/** One worktree's durable record, keyed by its directory basename inside `worktreesDir`. */
interface WorktreeUseRecord {
  /** Epoch ms of the last use release (or the first sighting of a worktree the registry has
   * never seen). Drives least-recently-used ordering. */
  lastUsedAt: number;
  /** Epoch ms of the last successful reclaim; absent until one ran. Part 3/4's idle mode reads
   * it to reclaim a worktree once per idle spell. */
  reclaimedAt?: number;
}

type WorktreeUseRegistry = Record<string, WorktreeUseRecord>;

interface LiveEntry {
  /** How many `useWorktree` bodies hold this worktree right now. */
  uses: number;
  /** Resolves when an in-progress reclaim releases; null when none is running. */
  reclaiming: Promise<void> | null;
  /** The resolver behind `reclaiming`, so `releaseReclaim` can settle it. */
  settleReclaim?: () => void;
}

/** In-process state, keyed by the resolved directory so two roots' same-named worktrees never
 * collide. */
const live = new Map<string, LiveEntry>();

function key(dir: string): string {
  return path.resolve(dir);
}

function liveEntry(dir: string): LiveEntry {
  const k = key(dir);
  let e = live.get(k);
  if (!e) {
    e = { uses: 0, reclaiming: null };
    live.set(k, e);
  }
  return e;
}

/** Coerce one persisted registry entry, or null for a foreign one: `lastUsedAt` is the
 * required finite epoch-ms, and `reclaimedAt` is kept only when finite. The registry crosses
 * the same hand-editable boundary as the harness's other state files, and a hand editor's
 * `1e999` parses to Infinity (`JSON.stringify` cannot write Infinity, so only a hand edit
 * produces one). An Infinity `lastUsedAt` would sort a worktree as used forever —
 * `now - Infinity` is below any idle window — so the worktree could never be idle-reclaimed;
 * an Infinity `reclaimedAt` would read as reclaimed after every use, blocking the same
 * reclaim. Either reads as absent, the same finiteNumber rule fleet-state.ts's and
 * operator-requests.ts's persisted deadlines read by. */
function readWorktreeRecord(value: unknown): WorktreeUseRecord | null {
  if (!isJsonObject(value)) return null;
  const lastUsedAt = finiteNumber(value.lastUsedAt, undefined);
  if (lastUsedAt === undefined) return null;
  const reclaimedAt = finiteNumber(value.reclaimedAt, undefined);
  return reclaimedAt === undefined ? { lastUsedAt } : { lastUsedAt, reclaimedAt };
}

/** The durable registry, or an empty one when the file is missing or unreadable. Each entry is
 * read through readWorktreeRecord, so a foreign record or a non-finite timestamp is dropped
 * here rather than reaching the reclaim ordering — a worktree the read dropped reads as
 * never-seen, the same as one the registry never had. */
export function readWorktreeUse(root: string): WorktreeUseRegistry {
  const raw = readJsonFile<WorktreeUseRegistry>(worktreeUsePath(root));
  if (raw === null) return {};
  const registry: WorktreeUseRegistry = {};
  for (const [name, value] of Object.entries(raw)) {
    const record = readWorktreeRecord(value);
    if (record) registry[name] = record;
  }
  return registry;
}

/** Run `fn` holding the cross-process worktree-use lock. withStateLock creates the
 * `.tumwater/state/` parent first, since a CLI `tumwater reclaim` may write the registry
 * before any state write has made it. */
function withWorktreeUseLock<T>(root: string, fn: () => T): T {
  return withStateLock(worktreeUseLockPath(root), fn);
}

/** Read-modify-write the durable registry under the worktree-use lock: the one way a writer
 * changes a field without racing another process's edit (the orchestrator records a use
 * release while a CLI `tumwater reclaim` seeds or stamps a worktree). `change` returns whether
 * it changed anything; the file is rewritten only then, atomically. Returns the registry as
 * read under the lock. */
export function updateWorktreeUse(
  root: string,
  change: (registry: WorktreeUseRegistry) => boolean,
): WorktreeUseRegistry {
  return withWorktreeUseLock(root, () => {
    const registry = readWorktreeUse(root);
    if (change(registry)) writeJsonAtomic(worktreeUsePath(root), registry);
    return registry;
  });
}

/** True while a `useWorktree` body holds this worktree. */
export function isWorktreeInUse(dir: string): boolean {
  return (live.get(key(dir))?.uses ?? 0) > 0;
}

/** True while a reclaim owns this worktree (between `claimForReclaim` and `releaseReclaim`). */
export function isReclaimInProgress(dir: string): boolean {
  return live.get(key(dir))?.reclaiming != null;
}

/** Mark `dir` in use, waiting for any in-progress reclaim to release first. Returns a release
 * function that must run exactly once; the second and later calls are no-ops. The release
 * records `lastUsedAt` so the durable ordering reflects every completed use. */
export async function beginWorktreeUse(root: string, dir: string): Promise<() => void> {
  const e = liveEntry(dir);
  if (e.reclaiming) await e.reclaiming;
  e.uses += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    e.uses -= 1;
    recordUse(root, dir, Date.now());
  };
}

/** Run `fn` with `dir` held in use, releasing when it settles (even on a throw). The one way
 * wrapped sites should hold a worktree. */
export async function useWorktree<T>(
  root: string,
  dir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const release = await beginWorktreeUse(root, dir);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Try to claim `dir` for reclamation. Returns false while a use holds it or another reclaim
 * already owns it. On true the caller must call `releaseReclaim` when the clean settles. */
export function claimForReclaim(dir: string): boolean {
  const e = liveEntry(dir);
  if (e.uses > 0 || e.reclaiming) return false;
  let settle!: () => void;
  e.reclaiming = new Promise<void>((resolve) => {
    settle = resolve;
  });
  e.settleReclaim = settle;
  return true;
}

/** Release a reclaim claimed by `claimForReclaim`, settling any `useWorktree` waiting on it and
 * recording `reclaimedAt`. Safe to call even when the clean threw: the `finally` that calls it
 * is what matters. */
export function releaseReclaim(root: string, dir: string, at: number): void {
  const e = live.get(key(dir));
  if (e?.reclaiming) {
    const settle = e.settleReclaim;
    e.reclaiming = null;
    e.settleReclaim = undefined;
    settle?.();
  }
  const name = path.basename(path.resolve(dir));
  updateWorktreeUse(root, (registry) => {
    registry[name] = { lastUsedAt: registry[name]?.lastUsedAt ?? at, reclaimedAt: at };
    return true;
  });
}

function recordUse(root: string, dir: string, at: number): void {
  const name = path.basename(path.resolve(dir));
  updateWorktreeUse(root, (registry) => {
    registry[name] = { ...registry[name], lastUsedAt: at };
    return true;
  });
}
