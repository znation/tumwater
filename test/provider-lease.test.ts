/** Unit tests for the provider-lease store (src/concurrency/provider-lease.ts), the
 * AsyncLocalStorage that lets a run's lease follow its runs across providers
 * (plans/provider-concurrency.md §5). These pin the properties a unit test is meant to hold:
 * a run with no lease in context is a no-op, a run on the lease's own key never re-keys, a run
 * on another key releases the old key before (and instead of waiting in line for) the new one,
 * a re-key to a full provider parks and reports the wait through the hooks, and the pool-slot
 * drop returns the key without giving up the team permit. */
import test from "node:test";
import assert from "node:assert/strict";

import type { ResolvedModelConfig } from "../src/config/config-views.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import {
  dropProviderLeaseKey,
  ensureProviderLease,
  withProviderLease,
} from "../src/concurrency/provider-lease.js";
import { sleep } from "./helpers/wait.js";

function cfg(provider: string, model = "m"): ResolvedModelConfig {
  return { agent: "pi", provider, model, thinking: undefined } as ResolvedModelConfig;
}

function settle(ms = 20): Promise<void> {
  return sleep(ms);
}

test("ensureProviderLease is a no-op without a lease in context", async () => {
  // A bare RunnerPi unit test or `tumwater history` carries no lease: the run must not wait or
  // re-key anything, and must take no permit.
  const semaphore = new Semaphore(2);
  semaphore.setKeyCaps({ omlx: 1 });
  await ensureProviderLease(cfg("omlx"));
  assert.equal(semaphore.snapshot().inUse, 0, "no lease was taken by a storeless run");
});

test("a run on the lease's own key never re-keys", async () => {
  const semaphore = new Semaphore(2);
  semaphore.setKeyCaps({ omlx: 1, hf: 1 });
  const lease = await semaphore.acquireLease(0, "omlx"); // admitted on omlx
  await withProviderLease(lease, semaphore, async () => {
    await ensureProviderLease(cfg("omlx")); // the run stays on the same provider
  });
  const snap = semaphore.snapshot();
  assert.equal(snap.byKey.omlx!.inUse, 1, "the lease stayed on omlx");
  assert.equal(snap.inUse, 1, "the team permit stayed held");
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});

test("a run on a different key re-keys: it releases the old key and takes the new one", async () => {
  const semaphore = new Semaphore(4);
  semaphore.setKeyCaps({ omlx: 1, hf: 1 });
  const lease = await semaphore.acquireLease(0, "hf"); // admitted on huggingface
  await withProviderLease(lease, semaphore, async () => {
    await ensureProviderLease(cfg("omlx")); // the run lands on omlx
    const snap = semaphore.snapshot();
    assert.equal(snap.byKey.hf!.inUse, 0, "huggingface gave its slot back when the lease moved");
    assert.equal(snap.byKey.omlx!.inUse, 1, "the lease now counts against omlx");
  });
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});

test("a re-key to a full provider parks (holding no key) and is granted when it drains", async () => {
  // §5 "No deadlock": a re-key waiter holds a team permit but no provider permit, so the key
  // it waits for always drains and another run on a free provider is never blocked behind it.
  const semaphore = new Semaphore(4);
  semaphore.setKeyCaps({ omlx: 1, hf: 1 });
  const holder = await semaphore.acquireLease(0, "omlx"); // the omlx slot another run holds
  const lease = await semaphore.acquireLease(0, "hf"); // admitted on huggingface, now re-keying
  let ran = false;
  const task = withProviderLease(lease, semaphore, async () => {
    await ensureProviderLease(cfg("omlx"));
    ran = true;
  });
  await settle();
  assert.equal(ran, false, "the re-key parks on the full omlx key");
  const snapWhileParked = semaphore.snapshot();
  assert.equal(snapWhileParked.byKey.hf!.inUse, 0, "huggingface was released before the re-key waited");
  assert.equal(snapWhileParked.byKey.omlx!.inUse, 1, "only the holder sits on omlx while the re-key waits");
  holder.release(); // the holder's run finishes: omlx drains
  await task;
  assert.equal(ran, true, "the re-key took the freed omlx slot");
  assert.equal(semaphore.snapshot().byKey.omlx!.inUse, 1);
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});

test("a re-key wait reports through the hooks, once, and a same-key run fires none", async () => {
  const semaphore = new Semaphore(4);
  semaphore.setKeyCaps({ omlx: 1, hf: 1 });
  const holder = await semaphore.acquireLease(0, "omlx");
  const lease = await semaphore.acquireLease(0, "hf");
  const seen: string[] = [];
  const task = withProviderLease(
    lease,
    semaphore,
    async () => {
      await ensureProviderLease(cfg("omlx")); // parks on the full omlx key → hooks fire
    },
    { hooks: { waiting: () => seen.push("waiting"), granted: () => seen.push("granted") } },
  );
  await settle();
  assert.deepEqual(seen, ["waiting"], "the hook announced the park before the re-key waited");
  holder.release();
  await task;
  assert.deepEqual(seen, ["waiting", "granted"], "the hook announced the grant once the key freed");
  lease.release(); // the re-keyed lease now holds omlx — free it before the next acquire

  const free = await semaphore.acquireLease(0, "omlx");
  const sameSeen: string[] = [];
  await withProviderLease(
    free,
    semaphore,
    async () => {
      await ensureProviderLease(cfg("omlx")); // already on omlx → no re-key, no flicker
    },
    { hooks: { waiting: () => sameSeen.push("waiting"), granted: () => sameSeen.push("granted") } },
  );
  assert.deepEqual(sameSeen, [], "a same-key run fires no wait hooks");
  free.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});

test("dropProviderLeaseKey returns the held key without giving up the team permit", async () => {
  // §5 pool-slot wait rule: a lease never holds a provider key while it waits for a pool slot.
  const semaphore = new Semaphore(2);
  semaphore.setKeyCaps({ omlx: 1 });
  const lease = await semaphore.acquireLease(0, "omlx");
  await withProviderLease(lease, semaphore, async () => {
    await dropProviderLeaseKey();
    const snap = semaphore.snapshot();
    assert.equal(snap.byKey.omlx!.inUse, 0, "the omlx count dropped while it parks on a slot");
    assert.equal(snap.inUse, 1, "the team permit is still held while it waits");
  });
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});
