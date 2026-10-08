import { sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyLock, readLockPid, withLock, withSyncLock } from "../src/concurrency/lock.js";
import { runningAsRoot, tmpdir } from "./repo-fixtures.js";
import { errnoError } from "./helpers/fs-faults.js";
import { backdate } from "./helpers/backdate.js";
import { spawnReadyChild } from "./helpers/child-process.js";

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

test("classifyLock places each lock shape in absent/live/stale directly", () => {
  // The verdict withLock acts on and doctor reports is asserted here on its own, so the
  // four-way branch matrix cannot drift without this test failing — the withLock tests
  // below only see its consequences through steal-or-wait outcomes.

  // No dir at all — nothing held, nothing stale.
  assert.equal(classifyLock(path.join(tmpdir(), "classify-absent.lock")), "absent");

  // Fresh dir, live pid (ours): a holder we must not steal from.
  const live = path.join(tmpdir(), "classify-live.lock");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "pid"), String(process.pid));
  assert.equal(classifyLock(live), "live");

  // Fresh dir, dead pid: safe to break.
  const dead = path.join(tmpdir(), "classify-dead.lock");
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, "pid"), "999999999");
  assert.equal(classifyLock(dead), "stale");

  // Old dir with a still-live pid: age alone must win, so a reused pid cannot latch
  // a dead holder as live.
  const old = path.join(tmpdir(), "classify-old.lock");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "pid"), String(process.pid));
  backdate(old, 11 * 60 * 1000);
  assert.equal(classifyLock(old), "stale");

  // No readable pid: live within the NO_PID_GRACE_MS grace (the creator may still be
  // between mkdir and the pid write), stale once past it.
  const freshOrphan = path.join(tmpdir(), "classify-fresh-orphan.lock");
  fs.mkdirSync(freshOrphan);
  assert.equal(classifyLock(freshOrphan), "live");
  const orphan = path.join(tmpdir(), "classify-orphan.lock");
  fs.mkdirSync(orphan);
  backdate(orphan, 6 * 1000);
  assert.equal(classifyLock(orphan), "stale");

  // A torn pid file reads as no pid at all, so it falls into the same grace path:
  // fresh means live, past the grace means stale.
  const torn = path.join(tmpdir(), "classify-torn.lock");
  fs.mkdirSync(torn);
  fs.writeFileSync(path.join(torn, "pid"), "12 34");
  assert.equal(classifyLock(torn), "live");
  backdate(torn, 6 * 1000);
  assert.equal(classifyLock(torn), "stale");
});

test("withLock serializes critical sections", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  const order: number[] = [];
  await Promise.all([
    withLock(lock, async () => {
      order.push(1);
      await sleep(100);
      order.push(2);
    }),
    (async () => {
      await sleep(10);
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
  backdate(lock, 11 * 60 * 1000);
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
  backdate(lock, 6 * 1000);
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
  if (runningAsRoot()) return;

  // A stale lock whose dir cannot be removed (the parent is read-only, so removeTree's rmdir
  // fails with EACCES): rmLockDir must ignore that error and fall back to the ordinary wait,
  // not abort the acquire path with the cleanup error. A crash here would wedge every merge on
  // a lock nobody can delete.
  const root = tmpdir();
  const lock = path.join(root, "unremovable.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), "999999999"); // dead holder: stale by pid
  backdate(lock, 11 * 60 * 1000);
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
  if (runningAsRoot()) return;

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

test("withLock retries an acquire that loses the publish race", async () => {
  // A lock published between our existsSync(dir) and our rename makes the rename fail with
  // EEXIST/ENOTEMPTY. Waiting is the fix — the holder may finish and release — so the acquire
  // must retry instead of surfacing the rename error to the caller.
  const lock = path.join(tmpdir(), "race-publish.lock");
  const origRename = fs.renameSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).renameSync = (a: unknown, b: unknown) => {
    if (!hit && String(b) === lock) {
      hit = true;
      throw errnoError("EEXIST", "simulated publish race");
    }
    return (origRename as (x: unknown, y: unknown) => void)(a, b);
  };
  let ran = false;
  try {
    await withLock(
      lock,
      async () => {
        ran = true;
      },
      5000,
    );
  } finally {
    (fs as Record<string, unknown>).renameSync = origRename;
  }
  assert.ok(hit, "the simulated publish race fired");
  assert.ok(ran, "the acquire retried after losing the publish race and entered the section");
  assert.ok(!fs.existsSync(lock), "the lock is released after the retried acquire");
});

test("withLock sweeps stale acquiring temps but keeps fresh or unrelated ones", async () => {
  // Atomic publication can leave a `.acquiring-*` temp behind when a creator crashes before
  // its rename. The sweep reclaims only temps past STALE_MS, far beyond any scheduling stall,
  // so a live creator's in-flight temp is never removed.
  const root = tmpdir();
  const lock = path.join(root, "sweep.lock");
  const stale = `${lock}.acquiring-999999991`;
  const fresh = `${lock}.acquiring-999999992`;
  const unrelated = `${lock}.not-a-temp`;
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  fs.mkdirSync(unrelated);
  backdate(stale, 11 * 60 * 1000);

  let ran = false;
  await withLock(lock, async () => {
    ran = true;
  });

  assert.ok(ran, "the acquire proceeds after the sweep");
  assert.ok(!fs.existsSync(stale), "a stale acquiring temp is removed");
  assert.ok(fs.existsSync(fresh), "a fresh acquiring temp (a live creator) is kept");
  assert.ok(fs.existsSync(unrelated), "an unrelated sibling is never touched");
});

test("withLock reports a missing lock parent and survives a temp that vanishes mid-sweep", async () => {
  // No parent directory: sweepStaleTemps's readdir fails, and the acquire's own mkdir then
  // reports the real cause (ENOENT) instead of spinning to the deadline blaming a phantom
  // holder.
  const missing = path.join(tmpdir(), "no-such-parent", "x.lock");
  await assert.rejects(withLock(missing, async () => {}, 700), /cannot acquire lock .*ENOENT/);

  // A `.acquiring-*` temp that vanishes (or turns unreadable) between readdir and stat: the
  // sweep must swallow the stat error and let the acquire proceed rather than crash.
  const root = tmpdir();
  const lock = path.join(root, "race.lock");
  const vanished = `${lock}.acquiring-999999993`;
  fs.mkdirSync(vanished);
  const origStat = fs.statSync.bind(fs);
  (fs as Record<string, unknown>).statSync = (p: unknown, ...rest: unknown[]) => {
    if (p === vanished) throw errnoError("ENOENT", "simulated sweep race");
    return (origStat as (x: unknown, ...r: unknown[]) => unknown)(p, ...rest);
  };
  try {
    assert.equal(withSyncLock(lock, () => "acquired"), "acquired");
  } finally {
    (fs as Record<string, unknown>).statSync = origStat;
  }
});

test("withLock removes its own temp dir when the pid write fails", async () => {
  const lock = path.join(tmpdir(), "pid-fail.lock");

  // A wedged fs (ENOSPC, EACCES, …) can fail the pid write after the temp dir exists. The
  // acquire must rethrow AND take its own temp dir with it — a remnant the dead holder owns
  // would be swept only after the 10-minute stale timeout, and if it had been published, an
  // orphan lock dir would wedge every future acquirer until that same timeout.
  const orig = fs.writeFileSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).writeFileSync = (p: unknown, ...rest: unknown[]) => {
    if (!hit && String(p).startsWith(lock) && String(p).endsWith("/pid")) {
      hit = true;
      throw errnoError("EACCES", "simulated pid write failure");
    }
    return (orig as (p: unknown, ...r: unknown[]) => void)(p, ...rest);
  };
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
      /simulated pid write failure/,
    );
  } finally {
    (fs as Record<string, unknown>).writeFileSync = orig;
  }
  assert.ok(hit, "the pid write was attempted once");
  assert.ok(!ran, "never entered the critical section");
  assert.ok(!fs.existsSync(lock), "the failed acquire left no published lock dir behind");
  const prefix = `${path.basename(lock)}.acquiring-`;
  assert.ok(
    !fs.readdirSync(path.dirname(lock)).some((n) => n.startsWith(prefix)),
    "the failed acquire left no temp dir behind",
  );
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

test("withSyncLock excludes a second writer and releases on the way out", () => {
  const lock = path.join(tmpdir(), "x.lock");
  assert.equal(
    withSyncLock(lock, () => {
      assert.ok(fs.existsSync(lock), "the lock dir exists while held");
      // A second acquire while held must time out, not enter: the exclusion is the point.
      assert.throws(() => withSyncLock(lock, () => {}, 200), /timed out after 0\.2s waiting for lock/);
      return "inside";
    }),
    "inside",
  );
  assert.ok(!fs.existsSync(lock), "the lock is released after the section");
  assert.equal(withSyncLock(lock, () => "again"), "again", "a released lock is acquirable again");
});

test("withSyncLock waits out a live holder in another process and then proceeds", async () => {
  const lock = path.join(tmpdir(), "held.lock");
  const module = fileURLToPath(new URL("../src/concurrency/lock.js", import.meta.url));
  const holder = spawnReadyChild(
    `import(${JSON.stringify(module)}).then(({ withSyncLock }) =>
      withSyncLock(${JSON.stringify(lock)}, () =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)));`,
    () => readLockPid(lock) !== null,
    "the holder child never took the lock",
    200,
  );
  try {
    // The child needs a moment to take the lock; once its pid file reads back, the parent
    // must wait out the remaining hold (300ms, far inside the 5s budget) rather than steal.
    await holder.ready;
    assert.equal(readLockPid(lock), holder.child.pid!, "the child process holds the lock");
    assert.equal(withSyncLock(lock, () => "after", 5000), "after", "a live holder is waited for");
  } finally {
    await holder.exited;
  }
});

test("a creator starved before publishing its pid is waited for, not stolen", async () => {
  // Regression (BUGS.md 2026-10-07): the acquire used to mkdir the lock path and write its
  // pid in a second call. A loaded host can starve the creator between the two past
  // NO_PID_GRACE_MS; a waiter then read the pid-less dir as a crashed writer's remnant, broke
  // it, and both writers ran the guarded section at once — one read-modify-write lost. The
  // hook below freezes exactly that pid write, so the old protocol lets the waiter steal and
  // overlap with certainty; the rename-published dir is never visible without its pid, so the
  // waiter waits it out instead.
  const root = tmpdir();
  const lock = path.join(root, "slow-publish.lock");
  const inside = path.join(root, "inside");
  const overlap = path.join(root, "overlap");
  const module = fileURLToPath(new URL("../src/concurrency/lock.js", import.meta.url));
  const section = `() => {
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(inside)})) fs.writeFileSync(${JSON.stringify(overlap)}, String(process.pid));
      fs.writeFileSync(${JSON.stringify(inside)}, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2400);
      fs.rmSync(${JSON.stringify(inside)}, { force: true });
    }`;
  const slow = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
      const lock = ${JSON.stringify(lock)};
      const realWrite = fs.writeFileSync;
      let delayed = false;
      fs.writeFileSync = function (p, ...rest) {
        if (!delayed && String(p).startsWith(lock) && String(p).endsWith("/pid")) {
          delayed = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
        }
        return realWrite.call(fs, p, ...rest);
      };
      import(${JSON.stringify(module)}).then(({ withSyncLock }) =>
        withSyncLock(lock, ${section}, 20000));`,
    ],
  );
  slow.stderr?.resume();
  const slowExit = new Promise((resolve) => slow.on("exit", resolve));
  // Wait until the creator has made its lock dir or its atomic-publish temp, i.e. it is
  // inside the frozen pid window; only then race the waiter.
  const tempPrefix = `${path.basename(lock)}.acquiring-`;
  for (let i = 0; !fs.existsSync(lock) && !fs.readdirSync(root).some((n) => n.startsWith(tempPrefix)); i++) {
    if (i > 500) throw new Error("the slow creator never reached its pid write");
    await sleep(10);
  }
  const waiter = spawn(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(module)}).then(({ withSyncLock }) =>
        withSyncLock(${JSON.stringify(lock)}, ${section}, 20000));`,
    ],
  );
  waiter.stderr?.resume();
  const waiterExit = new Promise((resolve) => waiter.on("exit", resolve));
  await Promise.all([slowExit, waiterExit]);
  assert.ok(!fs.existsSync(overlap), "the waiter never entered while the creator was inside");
  assert.ok(!fs.existsSync(inside), "both sections cleaned up after themselves");
  assert.ok(!fs.existsSync(lock), "the lock is released after both writers");
});

test("withSyncLock steals a crashed writer's lock: a dead pid, or an empty pid past the grace", () => {
  const root = tmpdir();
  // Crash after mkdir but before the pid write: unreadable pid falls back to the no-pid
  // grace, and a dir backdated past it is stolen at once — the exact case the replaced
  // wx-lockfile protocol left unstealable (an empty body parsed as live forever).
  const empty = path.join(root, "empty.lock");
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, "pid"), "");
  backdate(empty, 6 * 1000);
  assert.equal(withSyncLock(empty, () => "empty", 5000), "empty", "an empty-pid orphan is stolen");

  // Crash after the pid write: the recorded pid is dead, so the lock is stale immediately.
  const dead = path.join(root, "dead.lock");
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, "pid"), "999999999");
  assert.equal(withSyncLock(dead, () => "dead", 5000), "dead", "a dead-pid lock is stolen at once");
});

/** A pid that is alive but not ours — a real spawned sleeper, because pidAlive treats a
 * permission error as dead and no fixed pid (init's included) is reliably "alive" here. */
function sleeperPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
  child.unref();
  return new Promise((resolve) => child.on("spawn", () => resolve(child.pid!)));
}

test("a holder robbed mid-section does not delete its successor's lock on release", async () => {
  // The age rule can break a live-but-stalled holder's lock; the successor then takes a lock
  // of its own. The robbed holder's release must leave that lock alone — deleting it would
  // let a third writer in while the successor is mid-section, the lost-update the lock
  // exists to prevent. Simulated here by a section that swaps the pid file for another live
  // process's, exactly what a thief-and-successor pair leaves behind.
  const pid = await sleeperPid();
  const syncLock = path.join(tmpdir(), "robbed-sync.lock");
  withSyncLock(syncLock, () => {
    fs.writeFileSync(path.join(syncLock, "pid"), String(pid)); // the successor now "holds" it
  });
  assert.ok(fs.existsSync(syncLock), "the robbed sync holder left the successor's lock in place");
  assert.equal(readLockPid(syncLock), pid, "the successor's pid file is untouched");

  const asyncLock = path.join(tmpdir(), "robbed-async.lock");
  await withLock(asyncLock, async () => {
    fs.writeFileSync(path.join(asyncLock, "pid"), String(pid)); // still alive: 500ms sleeper
  });
  assert.ok(fs.existsSync(asyncLock), "the robbed async holder left the successor's lock in place");
  assert.equal(readLockPid(asyncLock), pid, "the successor's pid file is untouched");
});
