import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "../src/lock.js";
import { tmpdir } from "./util.js";

test("withLock serializes critical sections", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  const order: number[] = [];
  await Promise.all([
    withLock(lock, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 100));
      order.push(2);
    }),
    (async () => {
      await new Promise((r) => setTimeout(r, 10));
      await withLock(lock, async () => {
        order.push(3);
      });
    })(),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.ok(!fs.existsSync(lock), "lock is released");
});

test("withLock releases on exceptions", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  await assert.rejects(
    withLock(lock, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(!fs.existsSync(lock));
});

test("withLock steals a lock held by a dead pid", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), "999999999");
  let ran = false;
  await withLock(
    lock,
    async () => {
      ran = true;
    },
    5000,
  );
  assert.ok(ran);
});

test("withLock steals an old lock even when its pid is still alive", async () => {
  // A SIGKILLed harness leaves the lock dir behind; if that pid was later reused by
  // another live process, only the age check can break the deadlock.
  const lock = path.join(tmpdir(), "x.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); // alive on purpose
  const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, elevenMinutesAgo, elevenMinutesAgo);
  let ran = false;
  await withLock(
    lock,
    async () => {
      ran = true;
    },
    5000,
  );
  assert.ok(ran, "stale-by-age lock is stolen despite a live pid");
});

test("withLock breaks an orphaned lock whose holder died before writing its pid", async () => {
  // A crash between mkdir and the pid write leaves a dir with no pid file. Before the fix
  // such a lock could never be broken (the pid read threw before the age check ran), so
  // every merge timed out after 120s forever; now it is stolen once past the grace.
  const lock = path.join(tmpdir(), "orphan.lock");
  fs.mkdirSync(lock);
  const sixSecondsAgo = new Date(Date.now() - 6 * 1000);
  fs.utimesSync(lock, sixSecondsAgo, sixSecondsAgo);
  let ran = false;
  await withLock(
    lock,
    async () => {
      ran = true;
    },
    5000,
  );
  assert.ok(ran, "orphaned lock past the grace is stolen");
});

test("withLock does not break a fresh lock that has no pid file yet", async () => {
  // The creator may still be between mkdir and the pid write: within the grace we must
  // wait rather than steal, so two live processes never hold the lock at once.
  const lock = path.join(tmpdir(), "fresh-orphan.lock");
  fs.mkdirSync(lock);
  let ran = false;
  await assert.rejects(
    withLock(
      lock,
      async () => {
        ran = true;
      },
      700,
    ),
    /timed out after 0\.7s waiting for lock/,
  );
  assert.ok(!ran, "must not enter the critical section of a fresh no-pid lock");
  assert.ok(fs.existsSync(lock), "the foreign lock is left untouched");
});

test("withLock times out instead of breaking a fresh lock held by a live pid", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); // alive + fresh mtime
  let ran = false;
  await assert.rejects(
    withLock(
      lock,
      async () => {
        ran = true;
      },
      700,
    ),
    // The message reports the wait budget (0.7s here) — it surfaces as a tick's lastError,
    // where "gave up after N s" is what distinguishes a slow holder from a wedged one.
    /timed out after 0\.7s waiting for lock/,
  );
  assert.ok(!ran, "must not enter the critical section of a live holder");
  assert.ok(fs.existsSync(lock), "the foreign lock is left untouched");
});
