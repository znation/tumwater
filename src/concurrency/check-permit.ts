import { AsyncLocalStorage } from "node:async_hooks";

import { defaultConfig } from "../config/config.js";
import type { CheckConfigSlice } from "../config/config-schema.js";
import { runOnAbort } from "../process/process.js";
import { Semaphore } from "./semaphore.js";

/** One process-wide bound on concurrent runs of the declared check (config.maxConcurrentChecks):
 * every full suite the harness runs — runScopedBuildCheck's gate/merge/batch scopes and
 * main-baseline.ts's checkMainBaseline, which runs the suite directly — takes a permit here first,
 * so a burst of merges cannot stack suites on the host beside the authors' own test runs (the suite
 * has load-sensitive tests). Split out of build/build-check.ts — which keeps the deterministic
 * execution and classification (detect → spawn → classify) — because permit accounting is
 * scheduling policy, not check semantics: it changes when the concurrency or fairness policy
 * changes, not when the check's execution does. Separate from the orchestrator's maxConcurrent
 * semaphore: a role run holds one of those while it waits here, but a check permit is held only
 * around the check process itself — never across a pi run, the merge lock, or another check — so no
 * permit holder waits on anything a waiter holds. Sized at each acquire from the caller's live
 * config (checkCap), so a tumwater.json edit applies to the next check; Semaphore.setCapacity never
 * preempts a running check on a shrink. */
const checkPermits = new Semaphore(defaultConfig().maxConcurrentChecks);

/** Set while the current async context holds a check permit: a nested withCheckPermit runs
 * inside the permit it already has instead of queueing for a second one — at a cap of 1 that
 * second wait could never be granted (its own holder is the one blocking it). No call path
 * nests today; this keeps a future one from deadlocking the team's checks. */
const holdingPermit = new AsyncLocalStorage<true>();

/** Labels of the checks holding a permit now, keyed by a per-hold token; insertion order is
 * acquisition order. A check_wait event names them (PermitWaitHooks.waited). */
const permitHolders = new Map<symbol, string>();

/** Waiting-queue tiers (Semaphore.acquire): a merge-tier check (the main watch's rerun
 * confirmation) is granted the next free permit ahead of queued gate and baseline checks, so it
 * does not wait behind a full suite. The merge scope itself no longer runs a check (parts 4l/3 and
 * 4m/3). A running check is never preempted. */
export const CHECK_TIER = { merge: 0, other: 1 } as const;

/** The live cap: config.maxConcurrentChecks when it is a positive integer (validateConfig
 * enforces that for tumwater.json), the default otherwise — a caller passing a partial config
 * (the tests' `{ check }`) or none gets the default, never a cap the semaphore could not grant
 * under. */
function checkCap(config: CheckConfigSlice | undefined): number {
  const n = config?.maxConcurrentChecks;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : defaultConfig().maxConcurrentChecks;
}

/** The check pool's live state for observers (the orchestrator's poll publishes it): permits held,
 * the cap, and checks queued for one. `limit` is the cap set by the most recent withCheckPermit
 * call, or the default before any check has run. */
export function checkPermitSnapshot(): { inUse: number; limit: number; waiting: number } {
  return { inUse: checkPermits.snapshot().inUse, limit: checkPermits.limit, waiting: checkPermits.waiting };
}

/** What a check found when it parked: the labels of the permit holders and the cap, both as of
 * the moment it parked. */
export interface ParkedBehind {
  heldBy: string[];
  limit: number;
}

/** Called around a wait for a check permit — only when the permit is not free on arrival: `waiting`
 * before parking, `granted` once the permit arrives. The merge path uses it to show "waiting for a
 * check slot" instead of a check that has not started (merge-slot.ts's checkWaitStage). */
export interface PermitWaitHooks {
  waiting(): void;
  granted(): void;
  /** Called once, after `granted`, with how long the wait took in ms — only when the permit was not
   * free, and with who held the permits and the cap when it parked. Optional: hooks that only
   * show a stage (merge-slot.ts) omit it. */
  waited?(waitedMs: number, parked: ParkedBehind): void;
}

/** A caller's way out of a wait for a permit: once `signal` has fired, a check that has to wait
 * stops waiting and withCheckPermit returns `outcome()` without running it. Only the wait listens —
 * a check granted a free permit runs even under a fired signal, and its own run decides what an
 * abort means there (runScriptGroup stops a tree only on an abort that fires mid-run). */
export interface PermitWaitAbort<T> {
  signal: AbortSignal | undefined;
  outcome: () => T;
}

/** Park for a permit at `tier` until it is granted (true) or `signal` fires first (false). A grant
 * that arrives after the abort is handed straight back — a hop, never a leak — the way
 * merge-pipeline.ts's acquireUnlessAborted gives back the team semaphore's. */
async function acquireUnlessAborted(tier: number, signal: AbortSignal | undefined): Promise<boolean> {
  const granted = checkPermits.acquire(tier);
  if (!signal) {
    await granted;
    return true;
  }
  let detach = () => {};
  const stopped = new Promise<void>((resolve) => (detach = runOnAbort(signal, resolve)));
  await Promise.race([granted, stopped]);
  detach();
  // Decided on the signal, not on which promise won: a grant and an abort landing in the same
  // tick still never spawn the aborted check.
  if (!signal.aborted) return true;
  void granted.then(() => checkPermits.release());
  return false;
}

/** Run `run` under one process-wide check permit (see checkPermits), resizing the cap from the
 * live config first and releasing in a finally — a check that fails, times out, or throws still
 * gives its permit back. Reentrant (holdingPermit): called again from inside `run`, it runs the
 * inner work under the permit already held. `hooks` hear about a wait, if there is one; `label`
 * names this check to the waiters it holds up ("a check" when omitted). `abort` ends a wait its
 * signal fires during (or before) with `abort.outcome()`: a check whose caller was stopped while
 * it queued — a merge aborted behind a full suite — never runs the suite for nothing, holding a
 * permit other checks need. */
export async function withCheckPermit<T>(
  config: CheckConfigSlice | undefined,
  tier: number,
  run: () => Promise<T>,
  hooks?: PermitWaitHooks,
  label?: string,
  abort?: PermitWaitAbort<T>,
): Promise<T> {
  if (holdingPermit.getStore()) return run();
  checkPermits.setCapacity(checkCap(config));
  if (!checkPermits.tryAcquire()) {
    if (abort?.signal?.aborted) return abort.outcome();
    const waitStarted = Date.now();
    // Snapshot at park time; not revised if holders change mid-wait.
    const parked = { heldBy: [...permitHolders.values()], limit: checkPermits.limit };
    hooks?.waiting();
    if (!(await acquireUnlessAborted(tier, abort?.signal))) return abort!.outcome();
    hooks?.granted();
    hooks?.waited?.(Date.now() - waitStarted, parked);
  }
  const token = Symbol();
  permitHolders.set(token, label ?? "a check");
  try {
    return await holdingPermit.run(true, run);
  } finally {
    permitHolders.delete(token);
    checkPermits.release();
  }
}
