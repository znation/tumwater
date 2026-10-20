/** The AsyncLocalStorage store that lets a tick's lease follow its runs across providers
 * (plans/provider-concurrency.md §5): a lease rides here for the length of a tick, a verify task,
 * or a resolver run, and `LoopPi.runWithTransientRetry` re-keys it to the provider each run
 * actually uses. The one choke point every run a role makes (authoring, gate, merge and resolver)
 * passes through, so a budget handback or a model-failure switch that moves a mid-tick run to
 * another provider moves the lease with it instead of leaving it parked on the key it was admitted
 * on. The check-permit.ts `holdingPermit` store is the pattern: nothing here is a separate permit,
 * only the single lease the run path already holds.
 *
 * The store carries the `piDefault` (the caller's cached readPiDefaultModel result) beside the
 * lease so `ensureProviderLease` can resolve a bare no-model pi seam's key exactly as the
 * admission/review seam did — a run whose key were computed without it would re-key a default
 * team's tick off pi's own provider. It also carries the semaphore and, optionally, wait
 * hooks, so a re-key that has to park on a full target key reports its wait the way a parked
 * resolver does (merge-verify.ts's providerWaitStage). */
import { AsyncLocalStorage } from "node:async_hooks";

import type { ModelSelector } from "../config/model-selector.js";
import { seamConcurrencyKey, type ResolvedModelConfig } from "../config/config-views.js";
import type { Semaphore } from "./semaphore.js";
import type { SemaphoreLease } from "./semaphore.js";

/** The wait hooks a re-key reports to when it parks on a full target key: `waiting` before the
 * lease parks, `granted` once the target key's headroom arrives — the merge-pipeline shape
 * check-permit.ts's PermitWaitHooks uses, so a row reads "waiting for a provider slot" instead of
 * looking like a hung review. */
interface ProviderLeaseWaitHooks {
  waiting(): void;
  granted(): void;
}

interface ProviderLeaseStore {
  lease: SemaphoreLease;
  piDefault?: ModelSelector | null;
  semaphore: Semaphore;
  hooks?: ProviderLeaseWaitHooks;
}

const providerLeaseStore = new AsyncLocalStorage<ProviderLeaseStore>();

/** Run `run` with `lease` in the provider-lease store, so any run it makes re-keys that lease to
 * the provider it actually uses (ensureProviderLease). `opts.piDefault` is the caller's cached pi
 * default model, so a bare no-model seam resolves to the same key the admission or review seam
 * used; `opts.hooks` (the verify: providerWaitStage) hears a re-key wait, if there is one. The same
 * lease object is released by the caller after the store is unwrapped — a re-key mutates it in
 * place, so release() frees whatever key the run path ended on. */
export function withProviderLease<T>(
  lease: SemaphoreLease,
  semaphore: Semaphore,
  run: () => Promise<T>,
  opts: { piDefault?: ModelSelector | null; hooks?: ProviderLeaseWaitHooks } = {},
): Promise<T> {
  return providerLeaseStore.run({ lease, semaphore, piDefault: opts.piDefault, hooks: opts.hooks }, run);
}

/** Re-key the calling lease to the provider `cfg` runs on, if it is not there yet. No-op when
 * the current async context carries no lease (a direct LoopPi unit test, `tumwater tick`) or
 * when the run is already on the lease's key. When it does re-key and `hooks` are present and
 * the target key is at its cap, the hooks hear `waiting` before the lease parks and `granted`
 * once the key frees — a re-key never waits on the team total (it already holds a team
 * permit), only on the target key's headroom. */
export async function ensureProviderLease(cfg: ResolvedModelConfig): Promise<void> {
  const ctx = providerLeaseStore.getStore();
  if (!ctx) return;
  const key = seamConcurrencyKey(cfg, ctx.piDefault);
  if (ctx.lease.key === key) return;
  // The leased currently holds `old` (or nothing); the target key's in-use does not include it,
  // so the key being at its cap is exactly whether rekey() will park.
  const parks = ctx.hooks !== undefined && keyAtCap(ctx, key);
  if (parks) ctx.hooks!.waiting();
  await ctx.lease.rekey(key);
  if (parks) ctx.hooks!.granted();
}

/** Whether `key` is at its configured cap right now (an absent or uncapped key is not) — the
 * same test semaphore.drive uses to withhold a re-key grant, decided from the live snapshot so
 * a re-key wait can be announced before the lease parks (providerWaitStage). */
function keyAtCap(ctx: ProviderLeaseStore, key?: string): boolean {
  if (key === undefined) return false;
  const entry = ctx.semaphore.snapshot().byKey[key];
  return entry?.limit !== undefined && entry.inUse >= entry.limit;
}

/** The pool-slot wait rule (plans/provider-concurrency.md §5 "No deadlock"): a lease never holds a
 * provider key while it waits for a worktree pool slot. Called by leaseSlot just before it parks on
 * a busy pool; it re-keys the calling lease to no key (which never waits), so a tick or verify
 * waiting for a slot does not hold — and cannot deadlock — a provider slot whose in-use a re-key
 * waiter is waiting to drain. No-op without a lease in context. */
export async function dropProviderLeaseKey(): Promise<void> {
  const ctx = providerLeaseStore.getStore();
  if (!ctx) return;
  await ctx.lease.rekey(undefined);
}
