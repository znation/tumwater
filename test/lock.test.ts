import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readLockPid, withLock } from "../src/lock.js";
import { tmpdir } from "./util.js";

test("readLockPid accepts plain-decimal pids and rejects torn or foreign content", () => {
  const dir = path.join(tmpdir(), "pid-read.lock");
  fs.mkdirSync(dir);
  const write = (content: string) => fs.writeFileSync(path.join(dir, "pid"), content);

  write("12345");
  assert.equal(readLockPid(dir), 12345);
  write(" 12345\n"); // Surrounding whitespace is tolerated (a foreign writer may add a newline).
  assert.equal(readLockPid(dir), 12345);

  // parseInt would read each of these as a number (123, 1, -5, 16, 0); only the last two are
  // also non-positive, so the first three are the latch pidAlive's guards cannot catch.
  for (const bad of ["123abc", "1.9", "-5", "0x10", "0", "", "  ", "12 34"]) {
    write(bad);
    assert.equal(readLockPid(dir), null, `expected ${JSON.stringify(bad)} to be unreadable`);
  }

  fs.rmSync(path.join(dir, "pid"));
  assert.equal(readLockPid(dir), null, "a missing pid file is unreadable");
});

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

test("withLock swallows a failed cleanup of a stale lock and waits instead of crashing", async () => {
  // Skip under root, where chmod cannot stop the removal and removeTree would succeed.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;

  // A stale lock whose dir cannot be removed (the parent is read-only, so removeTree's rmdir
  // fails with EACCES): rmLockDir must ignore that error and fall back to the ordinary wait,
  // not abort the acquire path with the cleanup error. A crash here would wedge every merge on
  // a lock nobody can delete.
  const root = tmpdir();
  const lock = path.join(root, "unremovable.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), "999999999"); // dead holder: stale by pid
  const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, elevenMinutesAgo, elevenMinutesAgo);
  fs.chmodSync(root, 0o555); // no write on the parent: the stale dir cannot be removed
  let ran = false;
  try {
    await assert.rejects(
      withLock(
        lock,
        async () => {
          ran = true;
        },
        700,
      ),
      /timed out after 0\.7s waiting for lock/,
      "the cleanup failure surfaces as the ordinary wait timeout, not the rmdir error",
    );
  } finally {
    fs.chmodSync(root, 0o755);
  }
  assert.ok(!ran, "never entered the critical section");
  assert.ok(fs.existsSync(lock), "the unremovable lock is left in place");
});

test("withLock fails fast on a filesystem error that waiting cannot fix", async () => {
  // Skip under root, where chmod cannot make the parent unwritable.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;

  // A lock path whose PARENT is read-only and whose dir does NOT exist: mkdir fails EACCES,
  // not the contention EEXIST. Waiting cannot help, so the acquire must report the real error
  // immediately instead of spinning to the deadline and blaming a phantom holder.
  const root = tmpdir();
  const lock = path.join(root, "blocked.lock");
  fs.chmodSync(root, 0o555);
  try {
    await assert.rejects(
      withLock(lock, async () => {}, 700),
      /cannot acquire lock .*blocked\.lock: EACCES/,
    );
  } finally {
    fs.chmodSync(root, 0o755);
  }
  assert.ok(!fs.existsSync(lock), "no lock dir is left behind");
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

test("the lock timeout names the holder: its pid, or that no pid was readable", async () => {
  // The timeout is a tick's lastError. Naming the pid is what lets an operator go look at the
  // holder (or see that an orphan dir has no pid to look for) instead of hunting by hand.
  const root = tmpdir();

  const live = path.join(root, "live.lock");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "pid"), String(process.pid));
  await assert.rejects(
    withLock(live, async () => {}, 700),
    new RegExp(`waiting for lock .*live\\.lock \\(held by pid ${process.pid}\\)$`),
  );

  const orphan = path.join(root, "orphan.lock");
  fs.mkdirSync(orphan); // fresh, no pid file: inside the no-pid grace, so it is not broken
  await assert.rejects(
    withLock(orphan, async () => {}, 700),
    /waiting for lock .*orphan\.lock \(no readable pid file\)$/,
  );
});
