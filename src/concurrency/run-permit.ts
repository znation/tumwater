/** The AsyncLocalStorage store that carries a run's lease across its work: a lease rides here
 * for the length of a run, so an idle stretch inside it (a failed review's in-place retry
 * pause, called via idleWithoutPermit) can hand the team permit back and re-take it, letting a
 * parked run use the slot meanwhile. The check-permit.ts `holdingPermit` store is the pattern:
 * nothing here is a separate permit, only the single lease the run path already holds. */
import { AsyncLocalStorage } from "node:async_hooks";

import type { SemaphoreLease } from "./semaphore.js";

interface RunPermitStore {
  lease: SemaphoreLease;
}

const runPermitStore = new AsyncLocalStorage<RunPermitStore>();

/** Run `run` with `lease` in the run-permit store, so an idle wait inside it can pause and
 * resume the same team permit. The same lease object is released by the caller after the store
 * is unwrapped. */
export function withRunPermit<T>(lease: SemaphoreLease, run: () => Promise<T>): Promise<T> {
  return runPermitStore.run({ lease }, run);
}

/** Run `wait`, an idle stretch inside the calling lease's work, with the lease's team permit
 * handed back (SemaphoreLease.pause), so a parked run can use it meanwhile, then take it back
 * (resume) before returning. A failed review's in-place retry pause is the caller: with one
 * team permit, a reviewer that kept failing held it through two 30 s pauses and starved every
 * other role. Once `signal` has fired, nothing is taken back and the caller's release() settles
 * a still-paused lease. No-op without a lease in context. */
export async function idleWithoutPermit(wait: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const ctx = runPermitStore.getStore();
  if (!ctx) return wait();
  ctx.lease.pause();
  try {
    await wait();
  } finally {
    if (!signal?.aborted) await untilAborted(ctx.lease.resume(), signal);
  }
}

/** `p`, or an earlier return once `signal` fires: a resume parked on a full team must not keep an
 * aborted verification waiting for a permit it no longer needs. */
async function untilAborted(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
