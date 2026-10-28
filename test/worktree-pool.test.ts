/** The worktree pool's lease machinery (src/git/worktree-pool.ts, plans/worktree-pool.md part
 * 2a/5): which slot a lease gets, that concurrent leases take distinct slots, that a lease with
 * none free waits and honors an abort signal, the role affinity order, and the persisted lease
 * record in slots.json. The persisted layout module itself is covered where it is used
 * (test/operator-retire.test.ts, test/change-data.test.ts). */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leaseSlot, slotPoolSnapshot, tryLeaseSlot, removeDroppedSlots, type SlotLeaseHandle } from "../src/git/worktree-pool.js";
import { pinCrashedRuns, retireLegacyRoleWorktrees } from "../src/git/worktree-pool-startup.js";
import { readSlotsState, slotForDir, writeSlotsState } from "../src/git/slots-state.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { slotCount } from "../src/config/config.js";
import { eventsLogPath, salvageDir, salvagePendingDir, slotWorktreePath, slotsStatePath, worktreeUsePath } from "../src/paths.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { sleep } from "./helpers/wait.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { commitIn, headSha, makeRepo, sh, worktreeAt, writeConfig } from "./fixtures/repo-fixtures.js";

/** Poll until `fn` returns a value, so a waiter test does not assume how many macrotasks its
 * release-to-claim path takes (the claim itself is synchronous, but the git prepare is not).
 * The default mirrors the shared suite waitFor (test/helpers/wait.ts, 60 s) — tighter than a
 * real full-suite run's per-step budget. Every call here waits on real git work (prepare,
 * reset, removal), and a saturated suite can legitimately stretch that past a few seconds,
 * expiring a tight deadline even though the work completes; this polls the actual condition, so
 * a healthy release-to-claim returns immediately and only a genuine hang exhausts the bound. */
async function waitFor<T>(fn: () => T | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await sleep(5);
  }
}

/** Start a `clean` lease that must wait for a busy pool to free a slot, capturing its eventual
 * handle. `claimed` stays `undefined` until a release lets the wait resolve, so the waiter tests
 * can assert it is still waiting and then `waitFor(claimed)` once a slot frees. */
function waitingLease(root: string): { claimed: () => SlotLeaseHandle | undefined } {
  let handle: SlotLeaseHandle | undefined;
  void leaseSlot(root, { role: "clean", purpose: "run", ref: "main" }).then((h) => {
    handle = h;
  });
  return { claimed: () => handle };
}

test("slotCount defaults to maxConcurrent + 1 and honors an explicit worktreeSlots", () => {
  assert.equal(slotCount({ maxConcurrent: 3 }), 4);
  assert.equal(slotCount({ maxConcurrent: 3, worktreeSlots: 2 }), 2);
});

test("two concurrent leases take different slots and a third waits for a release", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const [a, b] = await Promise.all([
    leaseSlot(root, { role: "feature", purpose: "run", ref: "main" }),
    leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" }),
  ]);
  assert.notEqual(a.dir, b.dir, "two concurrent leases share one slot");
  assert.match(a.dir, /_slot-\d+$/);
  assert.match(b.dir, /_slot-\d+$/);

  // No slot is free: the third lease must stay unresolved until one is released.
  const third = waitingLease(root);
  await sleep(20);
  assert.equal(third.claimed(), undefined, "a third lease resolved with no free slot");

  a.release();
  const acquired = await waitFor(third.claimed);
  assert.equal(acquired.dir, a.dir, "the waiter took the slot that was just freed");
  acquired.release();
  b.release();
});

test("a waiting lease honors signal abort", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const held = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  const controller = new AbortController();
  const pending = leaseSlot(root, {
    role: "bugfix",
    purpose: "run",
    ref: "main",
    signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  held.release();
});

test("slotPoolSnapshot reports leased slots out of worktreeSlots and the leases waiting for one", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const first = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  const second = leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  await sleep(20);
  assert.deepEqual(slotPoolSnapshot(root), { leased: 1, limit: 1, waiting: 1 });
  first.release();
  const acquired = await second;
  assert.deepEqual(slotPoolSnapshot(root), { leased: 1, limit: 1, waiting: 0 });
  acquired.release();
  assert.deepEqual(slotPoolSnapshot(root), { leased: 0, limit: 1, waiting: 0 });
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
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  assert.equal(lease.dir, slotWorktreePath(root, 1), "affinity did not beat recency");
  lease.release();
});

test("slots.json records the lease while held and clears it on release", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const lease = await leaseSlot(root, { role: "feature", purpose: "verify", ref: "main" });
  const held = readSlotsState(root).slots.find((slot) => slot.dir === lease.dir);
  assert.equal(held?.lease?.role, "feature");
  assert.equal(held?.lease?.purpose, "verify");
  assert.equal(held?.lease?.pid, process.pid);

  lease.release();
  const after = readSlotsState(root).slots.find((slot) => slot.dir === lease.dir);
  assert.equal(after?.lease, null);
  assert.equal(after?.lastRole, "feature");
  assert.equal(typeof after?.lastReleasedAt, "number");
});

test("a release whose use-record write fails still frees the slot", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  // The worktree-use registry write is LRU bookkeeping; a directory standing at its path makes
  // updateWorktreeUse's atomic rename fail (EISDIR), the same way ENOSPC or a lock timeout
  // would on a real host. Before the fix, this throw escaped release() before releaseSlot ran,
  // so the slot stayed leased by this live pid (the dead-lease reaper only clears another
  // process's) and the pool shrank by one permanently.
  mkdirSync(worktreeUsePath(root), { recursive: true });
  lease.release();
  const after = readSlotsState(root).slots.find((slot) => slot.dir === lease.dir);
  assert.equal(after?.lease, null, "the slot stayed leased after a release whose use-record write failed");
});

test("a release whose slots.json write fails warns instead of throwing, and the next lease reclaims the slot", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  const undo = failRenameSyncOn(slotsStatePath(root), "EACCES fake");
  try {
    assert.doesNotThrow(() => lease.release());
  } finally {
    undo();
  }
  assert.ok(
    warningMessages(root).some((m) => m.includes("could not free slot") && m.includes("EACCES fake")),
  );
  const next = await tryLeaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  assert.equal(next?.dir, lease.dir);
  assert.equal(slotForDir(root, lease.dir)?.lease?.role, "bugfix");
  next!.release();
});

test("a lease whose prepare and use-record write both fail still frees the slot", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  // Same injected write failure as above, but now on leaseSlot's ensureDetachedWorktree error
  // path. Before the fix that unguarded useRelease() threw (EISDIR) before releaseSlot ran, so
  // the rejected lease left its slot leased by this live pid and the slot was lost. The unknown
  // ref makes ensureDetachedWorktree fail regardless.
  mkdirSync(worktreeUsePath(root), { recursive: true });
  await assert.rejects(
    leaseSlot(root, { role: "feature", purpose: "run", ref: "refs/heads/no-such-ref" }),
  );
  const after = readSlotsState(root).slots.find((slot) => slot.dir !== undefined);
  assert.equal(after?.lease, null, "the failed lease left its slot claimed after a use-record write failure");
});

test("a lease held by another pid is cleared and its slot reused", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const dir = slotWorktreePath(root, 1);
  writeSlotsState(root, {
    slots: [
      {
        dir,
        lease: { role: "ghost", purpose: "run", since: 1, pid: process.pid + 1 },
        pinnedFor: null,
        lastRole: "ghost",
        lastReleasedAt: 1,
      },
    ],
  });
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  assert.equal(lease.dir, dir, "the dead lease's slot was not reused");
  const rec = readSlotsState(root).slots.find((slot) => slot.dir === dir);
  assert.equal(rec?.lease?.role, "feature");
  assert.equal(rec?.lease?.pid, process.pid);
  lease.release();
});

test("a slot record missing its known fields is usable instead of crashing the claim", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const dir = slotWorktreePath(root, 1);
  // A hand edit or an older writer: only `dir` is present. readSlotsState kept it verbatim, so
  // clearDeadLeases read `.pid` off the undefined lease and threw straight into the claim;
  // defaulting the known fields lets the pool lease the slot instead.
  mkdirSync(join(root, ".tumwater", "state"), { recursive: true });
  writeFileSync(slotsStatePath(root), JSON.stringify({ slots: [{ dir }] }));
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  assert.equal(lease.dir, dir, "the under-specified slot was not leased");
  lease.release();
});

test("a slot record's non-finite timestamps read as absent, not as a stuck pin", () => {
  const root = makeRepo();
  const dir = slotWorktreePath(root, 1);
  mkdirSync(join(root, ".tumwater", "state"), { recursive: true });
  // A hand edit's `1e999` parses to Infinity (JSON.stringify cannot write one) and `-1e999`
  // to -Infinity. A non-finite `pinnedAt` is a pin no clock can date — doctor's filter
  // would report an `Infinityh`-old pin for -Infinity and never report a +Infinity one — and
  // a non-finite `lastReleasedAt` makes the slot the most-recently-released forever, so the
  // prune never retires it. Both must read as the absent form. Written raw because
  // JSON.stringify turns Infinity into null.
  writeFileSync(
    slotsStatePath(root),
    `{"slots":[{"dir":${JSON.stringify(dir)},"lease":null,"pinnedFor":"feature",` +
      `"pinnedAt":-1e999,"lastRole":null,"lastReleasedAt":1e999}]}`,
  );
  const record = readSlotsState(root).slots[0];
  assert.equal(record?.pinnedAt, null);
  assert.equal(record?.lastReleasedAt, null);
});

test("a slot record's non-finite lease numbers read as no lease", () => {
  const root = makeRepo();
  const badSince = slotWorktreePath(root, 1);
  const badPid = slotWorktreePath(root, 2);
  const good = slotWorktreePath(root, 3);
  mkdirSync(join(root, ".tumwater", "state"), { recursive: true });
  // A hand edit's `1e999` parses to Infinity and a bare `typeof === "number"` let it through:
  // a non-finite owner pid would read as a live lease to `tumwater diff`/the dashboard, which
  // resolve a role's checkout from slots.json without running the pool's clearDeadLeases. Each
  // unusable number makes the whole claim incomplete, so the slot frees; a healthy lease beside
  // them still surfaces. Written raw because JSON.stringify turns Infinity into null.
  writeFileSync(
    slotsStatePath(root),
    `{"slots":[` +
      `{"dir":${JSON.stringify(badSince)},"lease":{"role":"feature","purpose":"tick",` +
      `"since":1e999,"pid":1234},"pinnedFor":null,"lastRole":null,"lastReleasedAt":null},` +
      `{"dir":${JSON.stringify(badPid)},"lease":{"role":"clean","purpose":"tick",` +
      `"since":1,"pid":1e999},"pinnedFor":null,"lastRole":null,"lastReleasedAt":null},` +
      `{"dir":${JSON.stringify(good)},"lease":{"role":"bugfix","purpose":"tick",` +
      `"since":1,"pid":4321},"pinnedFor":null,"lastRole":null,"lastReleasedAt":null}]}`,
  );
  const slots = readSlotsState(root).slots;
  assert.equal(slots[0]?.lease, null, "a non-finite since reads as no lease");
  assert.equal(slots[1]?.lease, null, "a non-finite pid reads as no lease");
  assert.equal(slots[2]?.lease?.role, "bugfix", "a healthy lease beside them still surfaces");
});

test("release removes idle unpinned slots when worktreeSlots shrank", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  const a = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  const b = await leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  const c = await leaseSlot(root, { role: "clean", purpose: "run", ref: "main" });

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
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  writeConfig(root, { worktreeSlots: 0 }); // now invalid: liveCount falls back permissively
  lease.release();
  assert.equal(readSlotsState(root).slots[0]?.lease, null);
});

test("a lease whose worktree prepare fails frees the slot and can be retried", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  await assert.rejects(
    leaseSlot(root, { role: "feature", purpose: "run", ref: "refs/heads/no-such-ref" }),
  );
  const freed = readSlotsState(root).slots.find((slot) => slot.lease === null);
  assert.ok(freed, "the failed lease left its slot claimed");
  assert.equal(freed?.lastRole, "feature");

  const lease = await leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  assert.equal(lease.dir, freed?.dir, "the freed slot was not reused");
  lease.release();
});

test("a waiting lease with a signal acquires when a slot frees, then ignores a late abort", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const held = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  const controller = new AbortController();
  const pending = leaseSlot(root, {
    role: "bugfix",
    purpose: "run",
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
  const first = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  writeFileSync(join(first.dir, "resume.txt"), "kept");
  first.release({ pin: true });
  assert.equal(slotForDir(root, first.dir)?.pinnedFor, "feature");

  const resumed = await leaseSlot(root, {
    role: "feature",
    purpose: "run",
    ref: "main",
    keep: true,
  });
  assert.equal(resumed.dir, first.dir, "the kept lease did not reuse the pinned slot");
  assert.equal(resumed.preserved, true);
  assert.equal(readFileSync(join(resumed.dir, "resume.txt"), "utf8"), "kept");
  resumed.release();
  assert.equal(slotForDir(root, first.dir)?.pinnedFor, null, "release cleared the pin");

  const plain = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  assert.equal(plain.preserved, false);
  assert.equal(existsSync(join(plain.dir, "resume.txt")), false, "a plain lease resets the slot");
  plain.release();
});

test("keep on an unpinned slot still resets and reports not preserved", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const first = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  writeFileSync(join(first.dir, "resume.txt"), "dropped");
  first.release();

  const kept = await leaseSlot(root, {
    role: "feature",
    purpose: "run",
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
  const lease = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main", keep: true });
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
  const lease = await leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  assert.notEqual(lease.dir, pinnedDir, "another role leased a pinned slot");
  lease.release();
  assert.equal(slotForDir(root, pinnedDir)?.pinnedFor, "feature");
});

test("a pinned slot does not count toward the slot budget", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const a = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  a.release({ pin: true });
  const b = await leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  assert.notEqual(b.dir, a.dir, "the pinned slot consumed the only budgeted slot");
  assert.match(b.dir, /_slot-\d+$/);
  b.release();
});

test("the shrink-away pass keeps a pinned slot and drops older idle unpinned ones", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  const a = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  const b = await leaseSlot(root, { role: "bugfix", purpose: "run", ref: "main" });
  const c = await leaseSlot(root, { role: "clean", purpose: "run", ref: "main" });
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
  const warnings = readEvents(root).filter((e) => e.type === "warning" && e.source === "tumwater");
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0]?.message ?? ""),
    /could not remove idle workspace \/slots\/a: EBUSY/,
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

// Startup migration (plans/worktree-pool.md "Legacy role worktrees", part 4c/5): the pre-pool
// `.tumwater/worktrees/<role>` checkouts are retired once runs lease slots.

test("startup retires a non-resumable legacy role worktree but keeps its branch", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const wt = worktreeAt(root, "feature");
  writeFileSync(join(wt, "feature.txt"), "work\n");
  commitIn(wt, "feature work");
  const sha = headSha(wt);

  await retireLegacyRoleWorktrees(root, ["feature", "bugfix"]);
  assert.equal(existsSync(wt), false, "the non-resumable legacy checkout survived");
  assert.equal(sh(root, "git", "rev-parse", "tumwater/feature"), sha, "the branch lost its commit");
  assert.equal(
    readSlotsState(root).slots.some((slot) => slot.dir === wt),
    false,
    "the removed legacy dir left a slot record",
  );
});

test("a resumable enabled role's legacy dir becomes a pinned slot and serves one resume", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const wt = worktreeAt(root, "feature");
  writeFileSync(join(wt, "resume.txt"), "kept");
  saveRunnerState(root, { ...freshRunnerState("feature"), resumePending: true });

  await retireLegacyRoleWorktrees(root, ["feature"]);
  assert.equal(existsSync(wt), true, "the resumable legacy checkout was removed");
  const rec = slotForDir(root, wt);
  assert.equal(rec?.pinnedFor, "feature");
  assert.equal(rec?.lease, null);

  const lease = await leaseSlot(root, {
    role: "feature",
    purpose: "run",
    ref: "main",
    keep: true,
  });
  assert.equal(lease.dir, wt, "the resume did not keep its cwd");
  assert.equal(lease.preserved, true);
  assert.equal(readFileSync(join(lease.dir, "resume.txt"), "utf8"), "kept");
  lease.release();
  await waitFor(() => (existsSync(wt) ? undefined : true));
  assert.equal(slotForDir(root, wt), undefined, "the retired slot record survived");
});

test("a resumable role that already owns a run slot keeps the slot and retires the legacy dir", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 3 });
  const wt = worktreeAt(root, "feature");
  saveRunnerState(root, { ...freshRunnerState("feature"), running: true });
  const held = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });

  await retireLegacyRoleWorktrees(root, ["feature"]);
  assert.equal(existsSync(wt), false, "the legacy checkout survived beside the owned slot");
  assert.equal(slotForDir(root, held.dir)?.pinnedFor, "feature");
  held.release();
});

test("a resumable enabled role's already-migrated legacy dir stays pinned and inert across a restart", async () => {
  // retireLegacyRoleWorktrees's ownRecord branch (a restart before the resume ran): the
  // legacy dir is already recorded as a slot from an earlier migration, but the role has not
  // claimed a run slot yet. It must keep the dir pinned and inert — lease cleared, and any
  // earlier lastRole/lastReleasedAt left behind — not re-push a duplicate slot or remove the
  // checkout.
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const wt = worktreeAt(root, "feature");
  writeFileSync(join(wt, "resume.txt"), "kept");
  writeSlotsState(root, {
    slots: [
      { dir: wt, lease: null, pinnedFor: null, lastRole: "bugfix", lastReleasedAt: 5 },
    ],
  });
  saveRunnerState(root, { ...freshRunnerState("feature"), resumePending: true });

  await retireLegacyRoleWorktrees(root, ["feature"]);
  const rec = slotForDir(root, wt);
  assert.equal(rec?.pinnedFor, "feature", "the legacy dir is pinned for its role");
  assert.equal(rec?.lease, null, "the inert slot holds no lease");
  assert.equal(rec?.lastRole, null, "the earlier lastRole was cleared");
  assert.equal(rec?.lastReleasedAt, null, "the earlier lastReleasedAt was cleared");
  assert.equal(readSlotsState(root).slots.length, 1, "no duplicate slot was pushed");
  assert.equal(existsSync(wt), true, "the already-migrated checkout was removed");
});

test("a resumable but disabled role is removed and its pins never leak", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const wt = worktreeAt(root, "feature");
  saveRunnerState(root, { ...freshRunnerState("feature"), resumePending: true });
  const canonical = slotWorktreePath(root, 1);
  writeSlotsState(root, {
    slots: [{ dir: canonical, lease: null, pinnedFor: "clean", lastRole: null, lastReleasedAt: 1 }],
  });

  await retireLegacyRoleWorktrees(root, ["bugfix"]);
  assert.equal(existsSync(wt), false, "a disabled role's legacy checkout survived");
  assert.equal(
    readSlotsState(root).slots.some((slot) => slot.pinnedFor === "feature"),
    false,
    "a disabled role's legacy dir stayed pinned",
  );
  assert.equal(slotForDir(root, canonical)?.pinnedFor, null, "a removed role's pin leaked");
});

test("a pin left by a removed role on a non-canonical slot is retired with its checkout", async () => {
  // A leftover slot whose dir is NOT a canonical `_slot-<n>` checkout (a migrated legacy path)
  // and whose pin belongs to a role no longer in the config must be dropped outright — clearing
  // only the pin (as a canonical slot is) would orphan the legacy checkout on disk with no slot
  // record to ever remove it. The dir sits outside the worktrees dir so the legacy-name pass
  // does not already handle it; only the pin-retirement pass sees it.
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const stray = join(root, "elsewhere");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "stale.txt"), "kept pin\n");
  writeSlotsState(root, {
    slots: [{ dir: stray, lease: null, pinnedFor: "clean", lastRole: null, lastReleasedAt: 1 }],
  });

  await retireLegacyRoleWorktrees(root, ["feature"]);
  assert.equal(
    readSlotsState(root).slots.some((slot) => slot.dir === stray),
    false,
    "the non-canonical slot survived without its role",
  );
  assert.equal(existsSync(stray), false, "the orphaned legacy checkout was left on disk");
  assert.equal(
    readSlotsState(root).slots.some((slot) => slot.pinnedFor === "clean"),
    false,
    "a removed role's pin leaked",
  );
});

test("the migration leaves the director and underscore directories untouched", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const worktrees = join(root, ".tumwater", "worktrees");
  mkdirSync(join(worktrees, "director"), { recursive: true });
  mkdirSync(join(worktrees, "_merge"), { recursive: true });
  mkdirSync(join(worktrees, "_land-feature"), { recursive: true });

  await retireLegacyRoleWorktrees(root, []);
  assert.ok(existsSync(join(worktrees, "director")), "the director checkout was touched");
  assert.ok(existsSync(join(worktrees, "_merge")), "a `_`-prefixed checkout was touched");
  assert.ok(existsSync(join(worktrees, "_land-feature")), "a legacy lander checkout was touched");
});

test("a failed slot reset still removes a migrated legacy dir instead of orphaning it", async () => {
  // leaseSlot's error path must hand releaseSlot's toRemove to removeDroppedSlots: a
  // non-canonical (migrated legacy) slot is dropped on the unpinned release, so discarding
  // that list left the directory on disk with no slot record.
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const wt = worktreeAt(root, "feature");
  writeSlotsState(root, {
    slots: [{ dir: wt, lease: null, pinnedFor: "feature", lastRole: null, lastReleasedAt: null }],
  });

  await assert.rejects(
    leaseSlot(root, { role: "feature", purpose: "run", ref: "no-such-ref" }),
    "a slot reset to an unknown ref must reject",
  );
  await waitFor(() => (existsSync(wt) ? undefined : true));
  assert.equal(existsSync(wt), false, "the failed lease orphaned the legacy dir");
  assert.equal(slotForDir(root, wt), undefined, "the retired slot record survived");
});

test("a lease that waited 30 s or more logs one slot_wait naming the pool", async (t) => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const held = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const waited = waitingLease(root);
  await sleep(20);
  assert.equal(waited.claimed(), undefined, "the second lease claimed a slot with none free");
  t.mock.timers.tick(31_000); // retired-name-ok: node:test mock clock
  held.release();
  const got = await waitFor(waited.claimed);
  t.mock.timers.reset();

  const events = readEvents(root).filter((e) => e.type === "slot_wait");
  assert.equal(events.length, 1, "the 31 s wait did not log exactly one slot_wait");
  assert.equal(events[0]?.role, "clean");
  assert.equal(events[0]?.purpose, "run");
  assert.equal(events[0]?.waitedMs, 31_000);
  assert.equal(events[0]?.slots, 1);
  assert.equal(events[0]?.pinned, 0);
  got.release();
});

test("a lease that waited under 30 s logs no slot_wait", async (t) => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const held = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const waited = waitingLease(root);
  await sleep(20);
  t.mock.timers.tick(1_000); // retired-name-ok: node:test mock clock
  held.release();
  const got = await waitFor(waited.claimed);
  t.mock.timers.reset();

  assert.equal(
    readEvents(root).filter((e) => e.type === "slot_wait").length,
    0,
    "a 1 s wait logged a slot_wait",
  );
  got.release();
});

test("a lease an old build wrote with the legacy purpose vet reads as verify and the next write stores it", () => {
  const root = makeRepo();
  writeFileDeep(
    slotsStatePath(root),
    JSON.stringify({ slots: [{ dir: "/x", lease: { role: "feature", purpose: "vet", since: 1, pid: process.pid } }] }), // vocabulary-ok: legacy value
  );
  assert.equal(readSlotsState(root).slots[0]!.lease?.purpose, "verify");
  writeSlotsState(root, readSlotsState(root));
  assert.match(readFileSync(slotsStatePath(root), "utf8"), /"purpose": ?"verify"/);
});

test("tryLeaseSlot resolves null instead of waiting, and a check lease never takes a pinned slot", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const run = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  run.release({ pin: true });
  const check = await tryLeaseSlot(root, { role: "feature", purpose: "verify-check", ref: "main" });
  assert.ok(check, "a free slot exists beside the pinned one");
  assert.notEqual(check.dir, run.dir, "the role's own pinned slot is not a check slot");
  assert.equal(slotForDir(root, check.dir)?.lease?.purpose, "verify-check");
  const second = await tryLeaseSlot(root, { role: "feature", purpose: "verify-check", ref: "main" });
  assert.ok(second, "the pool's second unpinned slot");
  assert.equal(await tryLeaseSlot(root, { role: "feature", purpose: "verify-check", ref: "main" }), null);
  check.release();
  second.release();
});

test("a slot a killed run left with uncommitted edits is saved as a patch and reset for the next role", async () => {
  // 2026-10-21: two slots held uncommitted work from runs the process-table wedge killed, and the
  // next lease's checkout failed on them ("Your local changes … would be overwritten") for every
  // role the pool handed them to.
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  writeFileSync(join(root, "notes.md"), "v1\n");
  commitIn(root, "notes");
  const killed = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  writeFileSync(join(killed.dir, "notes.md"), "edited by the killed run\n");
  writeFileSync(join(killed.dir, "new-file.md"), "untracked work\n");
  killed.release(); // as a run the harness could not clean up after releases it

  const next = await leaseSlot(root, { role: "security", purpose: "run", ref: "main" });
  assert.equal(next.dir, killed.dir);
  assert.equal(sh(next.dir, "git", "status", "--porcelain"), "", "the slot is clean for its new holder");
  const saved = readdirSync(salvageDir(root));
  assert.equal(saved.length, 1);
  assert.match(saved[0]!, /^\d{4}-\d\d-\d\d-\d{6}-_slot-1-feature\.patch$/);
  const patch = join(salvageDir(root), saved[0]!);
  assert.match(
    warningMessages(root).join("\n"),
    /workspace _slot-1 still held 2 uncommitted files feature left behind; saved them to \.tumwater\/salvage\/\S+ and reset it for security/,
  );
  // The patch gives the work back: applied on the base, both edits return.
  sh(next.dir, "git", "apply", "--index", patch);
  assert.equal(readFileSync(join(next.dir, "notes.md"), "utf8"), "edited by the killed run\n");
  assert.equal(readFileSync(join(next.dir, "new-file.md"), "utf8"), "untracked work\n");
  sh(next.dir, "git", "reset", "-q", "--hard");
  next.release();
});

test("a clean slot is reset with nothing saved and no warning", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  (await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" })).release();
  const next = await leaseSlot(root, { role: "security", purpose: "run", ref: "main" });
  assert.equal(existsSync(salvageDir(root)), false);
  assert.equal(warningMessages(root).some((m) => m.includes("uncommitted")), false);
  next.release();
});

test("an unsettled run's leftovers wait for that role's next run; a settled run's are kept", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const unsettled = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  writeFileSync(join(unsettled.dir, "draft.md"), "unfinished\n");
  unsettled.release({ unsettled: true }); // an exception escaped the run
  assert.equal(slotForDir(root, unsettled.dir)?.unsettledRun, "feature");

  const next = await leaseSlot(root, { role: "security", purpose: "run", ref: "main" });
  const waiting = readdirSync(salvagePendingDir(root, "feature"));
  assert.equal(waiting.length, 1, "the patch waits for feature's next run");
  assert.match(waiting[0]!, /-_slot-1-feature\.patch$/);
  assert.match(
    warningMessages(root).join("\n"),
    /workspace _slot-1 still held 1 uncommitted file from feature's unfinished run; saved them to \.tumwater\/salvage\/pending\/feature\/\S+ for its next run and reset it for security/,
  );
  // A settled release (the run's verdict chose what to keep) leaves its edits only to the operator.
  writeFileSync(join(next.dir, "scratch.md"), "discarded on purpose\n");
  next.release();
  assert.equal(slotForDir(root, next.dir)?.unsettledRun, null);
  (await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" })).release();
  assert.equal(readdirSync(salvagePendingDir(root, "feature")).length, 1, "nothing new waits for feature");
  assert.equal(existsSync(salvagePendingDir(root, "security")), false, "nothing waits for security");
  assert.deepEqual(
    readdirSync(salvageDir(root)).filter((f) => f.endsWith(".patch")).map((f) => f.replace(/^\S+?-_slot/, "_slot")),
    ["_slot-1-security.patch"],
    "the settled run's edits are kept for the operator",
  );
});

test("a verification released unsettled leaves nothing waiting: its edits are not a role's work", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  const check = await leaseSlot(root, { role: "feature", purpose: "verify", ref: "main" });
  writeFileSync(join(check.dir, "debris.txt"), "check output\n");
  check.release({ unsettled: true });
  assert.equal(slotForDir(root, check.dir)?.unsettledRun, null);
  (await leaseSlot(root, { role: "security", purpose: "run", ref: "main" })).release();
  assert.equal(existsSync(join(salvageDir(root), "pending")), false);
  assert.equal(readdirSync(salvageDir(root)).filter((f) => f.endsWith(".patch")).length, 1);
});

test("a run lease its process died holding is attributed to its role and saved as unfinished work", async () => {
  // A crash, kill -9 or power loss never releases: the lease stays with the dead pid and the
  // slot record still names the slot's previous holder.
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 1 });
  (await leaseSlot(root, { role: "docs", purpose: "run", ref: "main" })).release();
  const crashed = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main" });
  writeFileSync(join(crashed.dir, "half-done.md"), "work in flight\n");
  const state = readSlotsState(root);
  state.slots[0]!.lease = { role: "feature", purpose: "run", since: 1, pid: process.pid + 1 };
  writeSlotsState(root, state);

  const next = await leaseSlot(root, { role: "security", purpose: "run", ref: "main" });
  assert.equal(next.dir, crashed.dir);
  assert.equal(readdirSync(salvagePendingDir(root, "feature")).length, 1, "the dead run's work waits for feature");
  assert.match(readdirSync(salvagePendingDir(root, "feature"))[0]!, /-feature\.patch$/, "not named for docs");
  next.release();
});

/** A slot whose run lease `role` held when its process died, with the run's edit still in it. */
async function crashedRun(root: string, role: string, purpose: "run" | "verify" = "run"): Promise<string> {
  const held = await leaseSlot(root, { role, purpose, ref: "main" });
  writeFileSync(join(held.dir, "in-flight.md"), "work in flight\n");
  const state = readSlotsState(root);
  state.slots.find((slot) => slot.dir === held.dir)!.lease = { role, purpose, since: 1, pid: process.pid + 1 };
  writeSlotsState(root, state);
  return held.dir;
}

test("startup pins a run the previous process died in, so its resume keeps the slot and its edits", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 2 });
  const dir = await crashedRun(root, "feature");
  saveRunnerState(root, { ...freshRunnerState("feature"), running: true });

  pinCrashedRuns(root, ["feature", "docs"]);
  assert.equal(slotForDir(root, dir)?.pinnedFor, "feature");
  // Another role's lease neither takes nor resets the pinned slot.
  const other = await leaseSlot(root, { role: "docs", purpose: "run", ref: "main" });
  assert.notEqual(other.dir, dir);
  const resume = await leaseSlot(root, { role: "feature", purpose: "run", ref: "main", keep: true });
  assert.equal(resume.dir, dir);
  assert.equal(resume.preserved, true);
  assert.equal(readFileSync(join(dir, "in-flight.md"), "utf8"), "work in flight\n");
  assert.equal(existsSync(salvageDir(root)), false, "nothing needed saving");
  resume.release();
  other.release();
});

test("the crash pin skips a role that is not configured, not resuming, already pinned, or verifying", async () => {
  const root = makeRepo();
  writeConfig(root, { worktreeSlots: 4 });
  const removed = await crashedRun(root, "gone");
  saveRunnerState(root, { ...freshRunnerState("gone"), running: true });
  const idle = await crashedRun(root, "docs");
  saveRunnerState(root, freshRunnerState("docs"));
  const verify = await crashedRun(root, "security", "verify");
  saveRunnerState(root, { ...freshRunnerState("security"), running: true });
  const second = await crashedRun(root, "feature");
  saveRunnerState(root, { ...freshRunnerState("feature"), resumePending: true });
  const state = readSlotsState(root);
  state.slots.push({ dir: join(root, "elsewhere"), lease: null, pinnedFor: "feature", lastRole: null, lastReleasedAt: null });
  writeSlotsState(root, state);

  pinCrashedRuns(root, ["docs", "security", "feature"]);
  for (const dir of [removed, idle, verify, second]) assert.equal(slotForDir(root, dir)?.pinnedFor, null, dir);
});
