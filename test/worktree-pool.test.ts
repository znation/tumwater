/** The worktree pool's lease machinery (src/git/worktree-pool.ts, plans/worktree-pool.md part
 * 2a/5): which slot a lease gets, that concurrent leases take distinct slots, that a lease with
 * none free waits and honors an abort signal, the role affinity order, and the persisted lease
 * record in slots.json. The persisted layout module itself is covered where it is used
 * (test/retire.test.ts, test/change-data.test.ts). */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leaseSlot, removeDroppedSlots, type SlotLeaseHandle } from "../src/git/worktree-pool.js";
import { readSlotsState, slotForDir, writeSlotsState } from "../src/git/slots-state.js";
import { readEvents } from "../src/events/event-read.js";
import { slotCount } from "../src/config/config.js";
import { eventsLogPath, slotWorktreePath } from "../src/paths.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `fn` returns a value, so a waiter test does not assume how many macrotasks its
 * release-to-claim path takes (the claim itself is synchronous, but the git prepare is not). */
async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await sleep(5);
  }
}

test("slotCount defaults to maxConcurrent + 1 and honors an explicit worktreeSlots", () => {
  assert.equal(slotCount({ maxConcurrent: 3 }), 4);
  assert.equal(slotCount({ maxConcurrent: 3, worktreeSlots: 2 }), 2);
});

test("two concurrent leases take different slots and a third waits for a release", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const [a, b] = await Promise.all([
    leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" }),
    leaseSlot(root, { role: "bugfix", purpose: "tick", ref: "main" }),
  ]);
  assert.notEqual(a.dir, b.dir, "two concurrent leases share one slot");
  assert.match(a.dir, /_slot-\d+$/);
  assert.match(b.dir, /_slot-\d+$/);

  // No slot is free: the third lease must stay unresolved until one is released.
  let third: SlotLeaseHandle | undefined;
  void leaseSlot(root, { role: "clean", purpose: "tick", ref: "main" }).then((h) => {
    third = h;
  });
  await sleep(20);
  assert.equal(third, undefined, "a third lease resolved with no free slot");

  a.release();
  const acquired = await waitFor(() => third);
  assert.equal(acquired.dir, a.dir, "the waiter took the slot that was just freed");
  acquired.release();
  b.release();
});

test("a waiting lease honors signal abort", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const held = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  const controller = new AbortController();
  const pending = leaseSlot(root, {
    role: "bugfix",
    purpose: "tick",
    ref: "main",
    signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  held.release();
});

test("a role leases the free slot it released most recently", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  writeSlotsState(root, {
    slots: [
      {
        dir: slotWorktreePath(root, 1),
        lease: null,
        pinnedFor: null,
        lastRole: "feature",
        lastReleasedAt: 100,
      },
      {
        dir: slotWorktreePath(root, 2),
        lease: null,
        pinnedFor: null,
        lastRole: "bugfix",
        lastReleasedAt: 200,
      },
    ],
  });
  const lease = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  assert.equal(lease.dir, slotWorktreePath(root, 1), "affinity did not beat recency");
  lease.release();
});

test("slots.json records the lease while held and clears it on release", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const lease = await leaseSlot(root, { role: "feature", purpose: "vet", ref: "main" });
  const held = readSlotsState(root).slots.find((slot) => slot.dir === lease.dir);
  assert.equal(held?.lease?.role, "feature");
  assert.equal(held?.lease?.purpose, "vet");
  assert.equal(held?.lease?.pid, process.pid);

  lease.release();
  const after = readSlotsState(root).slots.find((slot) => slot.dir === lease.dir);
  assert.equal(after?.lease, null);
  assert.equal(after?.lastRole, "feature");
  assert.equal(typeof after?.lastReleasedAt, "number");
});

test("a lease held by another pid is cleared and its slot reused", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const dir = slotWorktreePath(root, 1);
  writeSlotsState(root, {
    slots: [
      {
        dir,
        lease: { role: "ghost", purpose: "tick", since: 1, pid: process.pid + 1 },
        pinnedFor: null,
        lastRole: "ghost",
        lastReleasedAt: 1,
      },
    ],
  });
  const lease = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  assert.equal(lease.dir, dir, "the dead lease's slot was not reused");
  const rec = readSlotsState(root).slots.find((slot) => slot.dir === dir);
  assert.equal(rec?.lease?.role, "feature");
  assert.equal(rec?.lease?.pid, process.pid);
  lease.release();
});

test("release removes idle unpinned slots when worktreeSlots shrank", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  const a = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  const b = await leaseSlot(root, { role: "bugfix", purpose: "tick", ref: "main" });
  const c = await leaseSlot(root, { role: "clean", purpose: "tick", ref: "main" });

  writeConfig(root, { worktreeSlots: 1 });
  a.release(); // one idle slot, at the budget: kept
  assert.equal(readSlotsState(root).slots.length, 3);
  b.release(); // two idle, over the budget: the oldest (a) goes
  assert.equal(readSlotsState(root).slots.length, 2);
  c.release(); // two idle again: the oldest (b) goes, leaving c
  assert.equal(readSlotsState(root).slots.length, 1);
});

test("an invalid config still frees a held slot on release", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const lease = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  writeConfig(root, { worktreeSlots: 0 }); // now invalid: liveCount falls back permissively
  lease.release();
  assert.equal(readSlotsState(root).slots[0]?.lease, null);
});

test("a lease whose worktree prepare fails frees the slot and can be retried", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  await assert.rejects(
    leaseSlot(root, { role: "feature", purpose: "tick", ref: "refs/heads/no-such-ref" }),
  );
  const freed = readSlotsState(root).slots.find((slot) => slot.lease === null);
  assert.ok(freed, "the failed lease left its slot claimed");
  assert.equal(freed?.lastRole, "feature");

  const lease = await leaseSlot(root, { role: "bugfix", purpose: "tick", ref: "main" });
  assert.equal(lease.dir, freed?.dir, "the freed slot was not reused");
  lease.release();
});

test("a waiting lease with a signal acquires when a slot frees, then ignores a late abort", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const held = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  const controller = new AbortController();
  const pending = leaseSlot(root, {
    role: "bugfix",
    purpose: "tick",
    ref: "main",
    signal: controller.signal,
  });
  await sleep(20);
  held.release();
  const lease = await pending;
  controller.abort();
  assert.match(lease.dir, /_slot-\d+$/);
  lease.release();
});

test("keep preserves a slot pinned for the role; a plain lease resets it", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const first = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  writeFileSync(join(first.dir, "resume.txt"), "kept");
  first.release({ pin: true });
  assert.equal(slotForDir(root, first.dir)?.pinnedFor, "feature");

  const resumed = await leaseSlot(root, {
    role: "feature",
    purpose: "tick",
    ref: "main",
    keep: true,
  });
  assert.equal(resumed.dir, first.dir, "the kept lease did not reuse the pinned slot");
  assert.equal(resumed.preserved, true);
  assert.equal(readFileSync(join(resumed.dir, "resume.txt"), "utf8"), "kept");
  resumed.release();
  assert.equal(slotForDir(root, first.dir)?.pinnedFor, null, "release cleared the pin");

  const plain = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  assert.equal(plain.preserved, false);
  assert.equal(existsSync(join(plain.dir, "resume.txt")), false, "a plain lease resets the slot");
  plain.release();
});

test("keep on an unpinned slot still resets and reports not preserved", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const first = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  writeFileSync(join(first.dir, "resume.txt"), "dropped");
  first.release();

  const kept = await leaseSlot(root, {
    role: "feature",
    purpose: "tick",
    ref: "main",
    keep: true,
  });
  assert.equal(kept.preserved, false);
  assert.equal(existsSync(join(kept.dir, "resume.txt")), false);
  kept.release();
});

test("a lease for the pinned role takes the pinned slot over a free unpinned one", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  writeSlotsState(root, {
    slots: [
      {
        dir: slotWorktreePath(root, 1),
        lease: null,
        pinnedFor: "feature",
        lastRole: null,
        lastReleasedAt: 100,
      },
      {
        dir: slotWorktreePath(root, 2),
        lease: null,
        pinnedFor: null,
        lastRole: "bugfix",
        lastReleasedAt: 200,
      },
    ],
  });
  const lease = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main", keep: true });
  assert.equal(lease.dir, slotWorktreePath(root, 1));
  assert.equal(lease.preserved, true);
  lease.release();
});

test("a slot pinned for one role is never leased by another", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  const pinnedDir = slotWorktreePath(root, 1);
  writeSlotsState(root, {
    slots: [
      { dir: pinnedDir, lease: null, pinnedFor: "feature", lastRole: null, lastReleasedAt: 1 },
    ],
  });
  const lease = await leaseSlot(root, { role: "bugfix", purpose: "tick", ref: "main" });
  assert.notEqual(lease.dir, pinnedDir, "another role leased a pinned slot");
  lease.release();
  assert.equal(slotForDir(root, pinnedDir)?.pinnedFor, "feature");
});

test("a pinned slot does not count toward the slot budget", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const a = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  a.release({ pin: true });
  const b = await leaseSlot(root, { role: "bugfix", purpose: "tick", ref: "main" });
  assert.notEqual(b.dir, a.dir, "the pinned slot consumed the only budgeted slot");
  assert.match(b.dir, /_slot-\d+$/);
  b.release();
});

test("the shrink-away pass keeps a pinned slot and drops older idle unpinned ones", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  const a = await leaseSlot(root, { role: "feature", purpose: "tick", ref: "main" });
  const b = await leaseSlot(root, { role: "bugfix", purpose: "tick", ref: "main" });
  const c = await leaseSlot(root, { role: "clean", purpose: "tick", ref: "main" });
  a.release({ pin: true });

  writeConfig(root, { worktreeSlots: 1 });
  b.release();
  c.release();
  const slots = readSlotsState(root).slots;
  assert.ok(
    slots.some((slot) => slot.dir === a.dir && slot.pinnedFor === "feature"),
    "the pinned slot was shrunk away",
  );
  assert.ok(!slots.some((slot) => slot.dir === b.dir), "the oldest idle unpinned slot survived");
});

test("a failing removal of a dropped slot is logged, not an unhandled rejection", async () => {
  const root = makeRepo();
  const attempted: string[] = [];
  // The release callback is fire-and-forget, so a removal failure must be caught inside
  // removeDroppedSlots: an escaping rejection would be unhandled and kill the orchestrator. The
  // first removal fails; the second must still run and the call must resolve.
  await removeDroppedSlots(root, ["/slots/a", "/slots/b"], async (_root, dir) => {
    attempted.push(dir);
    if (dir === "/slots/a") throw new Error("EBUSY: resource busy or locked");
  });
  assert.deepEqual(attempted, ["/slots/a", "/slots/b"]);
  const warnings = readEvents(root).filter((e) => e.type === "warning" && e.loop === "harness");
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0]?.message ?? ""),
    /could not remove idle worktree slot \/slots\/a: EBUSY/,
  );
});

test("a failing removal with an unwritable events feed still resolves", async () => {
  const root = makeRepo();
  // Put a directory where the append-only events log belongs: every warnEvent throws EISDIR,
  // while every other file under the real root still writes normally.
  const file = eventsLogPath(root);
  rmSync(file, { recursive: true, force: true });
  mkdirSync(file, { recursive: true });
  // The removal failure is logged best-effort: an unwritable feed must not reject this
  // fire-and-forget call, which would surface as an unhandled rejection and kill the
  // orchestrator — the very exit the removal catch exists to prevent.
  await removeDroppedSlots(root, ["/slots/a"], async () => {
    throw new Error("EBUSY: resource busy or locked");
  });
});
