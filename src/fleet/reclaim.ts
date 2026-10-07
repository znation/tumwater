/** Pressure reclaim of build outputs (plans/disk-floor.md, "Reclaiming build outputs", part
 * 2/4): when the worktrees volume drops below `diskReclaimGB`, delete the files git ignores
 * (`git clean -fdX`) in idle harness worktrees, least recently used first, before part 1/4's
 * hold engages. Build outputs of every ecosystem go this way (`target/`, `node_modules/`,
 * `dist/`, `.venv/`) without this file naming any of them; `-X` removes only ignored files, so
 * an interrupted tick's uncommitted edits survive.
 *
 * The candidate list and the guard that keeps a clean off the primary checkout live here; the
 * in-use half lives in src/git/worktree-use.ts and the hold half in src/gates/disk-gate.ts. */

import fs from "node:fs";
import path from "node:path";
import { worktreesDir, worktreeUsePath } from "../paths.js";
import { git, gitTry } from "../git/git-run.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { logEvent } from "../events/events.js";
import { loadLoopState } from "../loop/loop-state.js";
import { BYTES_PER_GB, sampleFreeBytes } from "../gates/disk-gate.js";
import {
  claimForReclaim,
  isReclaimInProgress,
  isWorktreeInUse,
  readWorktreeUse,
  releaseReclaim,
} from "../git/worktree-use.js";

/** Worktree basenames that pressure reclaim never touches: the self-hosting mirrors the
 * redeployer and review gate use (`_main`, `_build`). `_gate-main` and `_land-<role>` are
 * ordinary candidates — their wrapped runs mark them in use exactly like a role tick. */
const RESERVED_WORKTREES = new Set(["_main", "_build"]);

/** A worktree the registry has never seen counts as used at first sight: seeding it with
 * `lastUsedAt = now` and excluding it from this pass means an upgrade under pressure does not
 * sweep every warm build at once. The next pass sees it in the registry and may reclaim it
 * once least-recently-used ordering reaches it. */

interface ReclaimCandidate {
  dir: string;
  /** The worktree's basename, as the durable registry and the event name it. */
  name: string;
  lastUsedAt: number;
  /** A role whose loop state has a pending resume; cleaned last. */
  resumePending: boolean;
}

/** The linked worktrees eligible for reclaim, least recently used first, with resume-pending
 * roles last. Worktrees in use, mid-reclaim, and the reserved mirrors are excluded; a worktree
 * the registry has never seen is seeded as used-now and left out of this pass. */
export function reclaimCandidates(root: string, now = Date.now()): ReclaimCandidate[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(worktreesDir(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !RESERVED_WORKTREES.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return []; // no worktrees dir yet (a fleet that has not started)
  }
  const dir = worktreesDir(root);
  const registry = readWorktreeUse(root);
  const candidates: ReclaimCandidate[] = [];
  let seeded = false;
  for (const name of names) {
    const wt = path.join(dir, name);
    if (isWorktreeInUse(wt) || isReclaimInProgress(wt)) continue;
    const record = registry[name];
    if (record === undefined || typeof record.lastUsedAt !== "number") {
      registry[name] = { ...record, lastUsedAt: now };
      seeded = true;
      continue; // used at first sight
    }
    candidates.push({
      dir: wt,
      name,
      lastUsedAt: record.lastUsedAt,
      resumePending: loadLoopState(root, name).resumePending === true,
    });
  }
  if (seeded) {
    // `readWorktreeUse` returned the parsed object; write the first-sight seedings back so a
    // later pass (or a restart) sees them. Atomic, so a crash cannot tear the registry.
    writeJsonAtomic(worktreeUsePath(root), registry);
  }
  candidates.sort((a, b) => {
    if (a.resumePending !== b.resumePending) return a.resumePending ? 1 : -1;
    return a.lastUsedAt - b.lastUsedAt;
  });
  return candidates;
}

/** True when `dir` is a linked worktree and not the primary checkout: `git rev-parse --git-dir`
 * and `--git-common-dir` differ for a linked worktree and are equal for the primary checkout.
 * Reading the primary checkout's `.gitignore` with `clean -X` would delete `.tumwater/`, the
 * fleet's entire state, so both this and the path check below are load-bearing. */
export async function isLinkedWorktree(dir: string): Promise<boolean> {
  const gitDir = await gitTry(dir, "rev-parse", "--git-dir");
  const commonDir = await gitTry(dir, "rev-parse", "--git-common-dir");
  return gitDir !== null && commonDir !== null && gitDir !== commonDir;
}

/** Reclaim one worktree's ignored files. Throws — deleting nothing — unless the resolved path
 * lies inside `worktreesDir(root)` and is a linked worktree. Returns false when the worktree is
 * in use, or when nothing it ignores was there to remove; true when at least one path was
 * deleted. Always releases its claim, so a throw from `git clean` cannot wedge the worktree as
 * reclaiming. */
export async function reclaimWorktree(root: string, dir: string): Promise<boolean> {
  const base = path.resolve(worktreesDir(root));
  const resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`refusing to reclaim ${resolved}: it is outside ${base}`);
  }
  if (!(await isLinkedWorktree(resolved))) {
    throw new Error(`refusing to reclaim ${resolved}: it is not a linked worktree`);
  }
  if (!claimForReclaim(resolved)) return false;
  try {
    return await cleanIgnored(resolved);
  } finally {
    releaseReclaim(root, resolved, Date.now());
  }
}

/** `git -C dir clean -fdX`: ignored files only (`-X`), one `-f` so nested repositories stay,
 * `-d` so ignored directories recurse. Never `-x`, never `-ff`. Returns whether git reported
 * removing anything — its own `Removing <path>` lines, so a clean with nothing to do (which
 * still succeeds) counts as no reclaim and is neither logged nor counted. */
async function cleanIgnored(dir: string): Promise<boolean> {
  const out = await git(dir, "clean", "-fdX");
  return out.split("\n").some((line) => line.startsWith("Removing "));
}

interface ReclaimPassResult {
  worktrees: string[];
  freedGB: number;
  freeGB: number;
  durationMs: number;
}

/** Clean pressure candidates until free space reaches `reclaimGB`, re-sampling after each, and
 * log exactly one `disk_reclaim` when anything was cleaned. `idle` mode ignores the threshold
 * and walks every candidate once (part 3/4). Returns null when nothing was reclaimed. */
export async function reclaimPass(
  root: string,
  mode: "pressure" | "idle" | "manual",
  opts: { reclaimGB: number; sample?: (root: string) => number | null; candidates?: readonly ReclaimCandidate[] },
): Promise<ReclaimPassResult | null> {
  const sample = opts.sample ?? sampleFreeBytes;
  const candidates = opts.candidates ?? reclaimCandidates(root);
  const before = sample(root);
  const startedAt = Date.now();
  const cleaned: string[] = [];
  for (const candidate of candidates) {
    if (mode !== "idle") {
      const free = sample(root);
      if (free !== null && opts.reclaimGB > 0 && free >= opts.reclaimGB * BYTES_PER_GB) break;
    }
    try {
      if (await reclaimWorktree(root, candidate.dir)) cleaned.push(candidate.name);
    } catch {
      // A guard failure (a directory that stopped being a linked worktree) is not a reason to
      // abort the pass; the remaining candidates are still safe to clean.
    }
  }
  if (cleaned.length === 0) return null;
  const after = sample(root);
  const freeBytes = after ?? before ?? 0;
  const result: ReclaimPassResult = {
    worktrees: cleaned,
    // Clamped: another writer can consume space during the pass, and a negative "freed"
    // would render as nonsense in the event and the digest.
    freedGB: before !== null && after !== null ? Math.max(0, (after - before) / BYTES_PER_GB) : 0,
    freeGB: freeBytes / BYTES_PER_GB,
    durationMs: Date.now() - startedAt,
  };
  logEvent(root, {
    loop: "harness",
    type: "disk_reclaim",
    mode,
    worktrees: cleaned,
    freedGB: result.freedGB,
    freeGB: result.freeGB,
    durationMs: result.durationMs,
  });
  return result;
}

/** Starts pressure passes and tells the disk hold whether to wait for one. One pass at a time,
 * never awaited by the poll — a clean that deletes 100k files can take a minute, the same
 * reason `launchServicesWatch.poll()` is never awaited.
 *
 * One pass per drop: while free space stays below `reclaimGB`, only the first poll starts a
 * pass. Once that pass settles, later polls start no second one — the pass already walked every
 * candidate — so the disk hold engages instead of being forever deferred. A fresh drop (free
 * space back at or above `reclaimGB`, then below again) arms one new pass. */
export class ReclaimController {
  private active: Promise<void> | null = null;
  /** True while free space has been below `reclaimGB` since the last pass was armed. */
  private wasLow = false;
  /** True once the armed pass has settled while still below `reclaimGB`. */
  private settled = false;
  /** The most recent pressure pass that cleaned at least one worktree, for the published
   * disk status (plans/disk-floor.md, part 4/4). null until one runs. */
  lastReclaim: { at: number; mode: "pressure" | "idle" | "manual"; freedGB: number } | null = null;

  constructor(
    private readonly root: string,
    private readonly sample: (root: string) => number | null = sampleFreeBytes,
  ) {}

  /** A fresh free-bytes sample: start one pressure pass when free space sits below `reclaimGB`
   * and none has run for this drop. Returns whether the disk hold must wait for a pass to
   * settle — true only while one is in flight. `reclaimGB` 0 (disabled) and an unmeasurable
   * sample never wait, so the hold engages immediately, exactly as in part 1/4. */
  poll(freeBytes: number | null, reclaimGB: number): boolean {
    if (reclaimGB <= 0 || freeBytes === null) {
      this.wasLow = false;
      this.settled = false;
      return false;
    }
    if (freeBytes >= reclaimGB * BYTES_PER_GB) {
      this.wasLow = false;
      this.settled = false;
      return false;
    }
    if (!this.wasLow) {
      this.wasLow = true;
      this.settled = false;
    }
    if (this.active) return true;
    if (this.settled) return false;
    this.active = this.run(reclaimGB);
    return true;
  }

  private async run(reclaimGB: number): Promise<void> {
    try {
      const result = await reclaimPass(this.root, "pressure", { reclaimGB, sample: this.sample });
      if (result) this.lastReclaim = { at: Date.now(), mode: "pressure", freedGB: result.freedGB };
    } catch {
      // Reclaim is opportunistic; it must never crash the orchestrator's poll loop.
    } finally {
      this.active = null;
      this.settled = true;
    }
  }
}
