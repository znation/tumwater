import { AsyncLocalStorage } from "node:async_hooks";

import { defaultConfig } from "../config/config.js";
import type { CheckConfigSlice } from "../config/config-schema.js";
import { Semaphore } from "./semaphore.js";

/** One process-wide bound on concurrent runs of the declared check (config.maxConcurrentChecks,
 * PLANS.md "Land-queue speed 2b"): every full suite the harness runs — runScopedBuildCheck's
 * gate/landing/batch scopes and main-baseline.ts's checkMainBaseline, which runs the suite
 * directly — takes a permit here first, so a burst of landings cannot stack suites on the host
 * beside the authors' own test runs (the suite has load-sensitive tests). Split out of
 * build/build-check.ts — which keeps the deterministic execution and classification (detect → spawn
 * → classify) — because permit accounting is scheduling policy, not check semantics: it
 * changes when the concurrency or fairness policy changes, not when the check's execution
 * does. Separate from the orchestrator's maxConcurrent semaphore: a role tick holds one of
 * those while it waits here, but a check permit is held only around the check process itself
 * — never across a pi run, the merge lock, or another check — so no permit holder waits on
 * anything a waiter holds. Sized at each acquire from the caller's live config (checkCap), so
 * a tumwater.json edit applies to the next check; Semaphore.setCapacity never preempts a
 * running check on a shrink. */
const checkPermits = new Semaphore(defaultConfig().maxConcurrentChecks);

/** Set while the current async context holds a check permit: a nested withCheckPermit runs
 * inside the permit it already has instead of queueing for a second one — at a cap of 1 that
 * second wait could never be granted (its own holder is the one blocking it). No call path
 * nests today; this keeps a future one from deadlocking the fleet's checks. */
const holdingPermit = new AsyncLocalStorage<true>();

/** Waiting-queue tiers (Semaphore.acquire): a merge-scope check runs inside the merge lock, so
 * it is granted the next free permit ahead of queued gate and baseline checks — every check it
 * waited behind would be lock-hold time for every other landing. A running check is never
 * preempted. */
export const CHECK_TIER = { merge: 0, other: 1 } as const;

/** The live cap: config.maxConcurrentChecks when it is a positive integer (validateConfig
 * enforces that for tumwater.json), the default otherwise — a caller passing a partial config
 * (the tests' `{ check }`) or none gets the default, never a cap the semaphore could not grant
 * under. */
function checkCap(config: CheckConfigSlice | undefined): number {
  const n = config?.maxConcurrentChecks;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : defaultConfig().maxConcurrentChecks;
}

/** Called around a wait for a check permit — only when the permit is not free on arrival:
 * `waiting` before parking, `granted` once the permit arrives. The landing path uses it to show
 * "waiting for a check slot" instead of a check that has not started (landing-slot.ts's
 * checkWaitStage). */
export interface PermitWaitHooks {
  waiting(): void;
  granted(): void;
}

/** Run `run` under one process-wide check permit (see checkPermits), resizing the cap from the
 * live config first and releasing in a finally — a check that fails, times out, or throws still
 * gives its permit back. Reentrant (holdingPermit): called again from inside `run`, it runs the
 * inner work under the permit already held. `hooks` hear about a wait, if there is one. */
export async function withCheckPermit<T>(
  config: CheckConfigSlice | undefined,
  tier: number,
  run: () => Promise<T>,
  hooks?: PermitWaitHooks,
): Promise<T> {
  if (holdingPermit.getStore()) return run();
  checkPermits.setCapacity(checkCap(config));
  if (!checkPermits.tryAcquire()) {
    hooks?.waiting();
    await checkPermits.acquire(tier);
    hooks?.granted();
  }
  try {
    return await holdingPermit.run(true, run);
  } finally {
    checkPermits.release();
  }
}
