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
    /timed out acquiring lock/,
  );
  assert.ok(!ran, "must not enter the critical section of a live holder");
  assert.ok(fs.existsSync(lock), "the foreign lock is left untouched");
});
