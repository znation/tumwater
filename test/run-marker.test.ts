import { sleep } from "./wait.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { pidAlive } from "../src/process.js";
import {
  makeRunMarker,
  pidsMarkedInPs,
  procEnvironCarriesMarker,
  runMarkerEnv,
  runMarkersInEnviron,
  runMarkersInPs,
  sweepRunMarker,
} from "../src/run-marker.js";
import { tmpdir } from "./repo-fixtures.js";
import { errnoError } from "./fs-faults.js";

// The TUMWATER_RUN markers runPi stamps on its process tree (src/run-marker.ts): the
// parsers over environment-entry lists and ps -E output, and the sweep that reaps this
// run's cross-group leftovers at exit. The probe-level reads (systemProcessProbe.runMarkers)
// stay pinned in process.test.ts; here the marker plumbing itself is under test.
import { armVictimKill, spawnMarkedVictim } from "./victim-fixture.js";

test("runMarkersInEnviron and runMarkersInPs extract a mark's comma-separated values, skipping the reader's own pid", () => {
  assert.deepEqual(runMarkersInEnviron(["PATH=/bin", "TUMWATER_RUN=100-aa,222-bb", ""]), ["100-aa", "222-bb"]);
  assert.deepEqual(runMarkersInEnviron(["TUMWATER_RUN=100-aa"]), ["100-aa"]);
  assert.deepEqual(runMarkersInEnviron(["OTHER=1", ""]), []);
  const marks = runMarkersInPs(
    [
      "  4242 node server.js TUMWATER_RUN=100-aa,222-bb PATH=/bin",
      `  ${process.pid} node dist/src/cli.js run TUMWATER_RUN=777-self`,
      "  500 sshd: /usr/sbin/sshd (sshd-server)",
      "",
    ].join("\n"),
  );
  assert.deepEqual([...marks], [[4242, ["100-aa", "222-bb"]]]);
});

test("runMarkerEnv appends to an inherited mark and makes fresh markers unique", () => {
  const marker = makeRunMarker(4242);
  assert.match(marker, /^4242-[0-9a-f]{12}$/, "the mark names its harness pid plus random hex");
  assert.notEqual(makeRunMarker(4242), marker, "two runs of one harness never share a mark");
  const outer = "111-aaaaaaaaaaaa";
  const env = runMarkerEnv({ PATH: "/bin", TUMWATER_RUN: outer }, marker);
  assert.equal(env.TUMWATER_RUN, `${outer},${marker}`, "a nested run keeps the outer mark");
  assert.equal(env.PATH, "/bin", "the rest of the environment rides along");
  assert.equal(runMarkerEnv({}, marker).TUMWATER_RUN, marker, "no inherited mark means just this one");
});

test("pidsMarkedInPs picks the marked rows only, never the scanner itself", () => {
  const marker = "4242-deadbeefcafe";
  // ps -wwE -A -o pid=,command= shape: pid, then the command column with the launch
  // environment appended. One marked process (multi-run env), one whose mark is a different
  // run's, one mentioning the variable in argv with a foreign value, and the scanner itself.
  const stdout = [
    `  111 sh -c 'server &' TUMWATER_RUN=${marker} NODE_OPTIONS=--import=data:...`,
    `  222 node server.js TUMWATER_RUN=111-aaaaaaaaaaaa,${marker} PATH=/bin:/usr/bin`,
    `  333 node other.js TUMWATER_RUN=111-aaaaaaaaaaaa`,
    `  444 grep TUMWATER_RUN=111-aaaaaaaaaaaa`,
    `  ${process.pid} node -e sweep TUMWATER_RUN=${marker}`,
    "  555 sleep 30",
    "garbage line without a pid",
  ].join("\n");
  assert.deepEqual(pidsMarkedInPs(stdout, marker), [111, 222]);
  assert.deepEqual(pidsMarkedInPs(stdout, "111-aaaaaaaaaaaa"), [222, 333, 444]);
  assert.deepEqual(pidsMarkedInPs("", marker), []);
});

test("procEnvironCarriesMarker reads NUL-separated environ entries", () => {
  const marker = "4242-deadbeefcafe";
  assert.equal(
    procEnvironCarriesMarker(["PATH=/bin", `TUMWATER_RUN=111-aaaaaaaaaaaa,${marker}`], marker),
    true,
  );
  assert.equal(procEnvironCarriesMarker(["PATH=/bin", "TUMWATER_RUN=111-aaaaaaaaaaaa"], marker), false);
  assert.equal(procEnvironCarriesMarker([], marker), false);
  // A value that merely CONTAINS the marker as a substring of another run's id is not a match.
  assert.equal(
    procEnvironCarriesMarker([`TUMWATER_RUN=111-${marker.slice(5)}`], marker),
    false,
    "membership is exact per comma-separated run, not substring",
  );
});

test("sweepRunMarker signals the marked orphan and spares the unmarked neighbour", async () => {
  // Real spawns: the sweep's victim-finding is a live process-table scan, so the unit keeps
  // to the real shape — a detached node orphan carrying the mark in its environment, and an
  // unmarked sibling beside it. Node, not sleep: macOS ps -E hides platform binaries'
  // environments, the one blind spot the sweep accepts (BUGS.md 2026-09-30). The full
  // run-shaped sweep — mark minted inside runPi, sweep at exit — is the regression test in
  // pi.test.ts; here the mark is an argument, so the test mints its own.
  const dir = tmpdir();
  const writePid = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1 << 30)";
  const spawnOrphan = (file: string, env?: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, ["-e", writePid, path.join(dir, file)], {
      detached: true,
      stdio: "ignore",
      ...(env ? { env } : {}),
    });
    child.unref();
    return child;
  };
  const readPid = (file: string) => {
    try {
      return Number(fs.readFileSync(path.join(dir, file), "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  const own = makeRunMarker();
  spawnOrphan("ours.pid", { ...process.env, TUMWATER_RUN: own });
  spawnOrphan("plain.pid");
  const recordDeadline = Date.now() + 10_000;
  while ((!readPid("ours.pid") || !readPid("plain.pid")) && Date.now() < recordDeadline)
    await sleep(25);
  const oursPid = readPid("ours.pid");
  const plainPid = readPid("plain.pid");
  try {
    assert.ok(oursPid > 0 && plainPid > 0, "both orphans recorded their pids");
    const signaled = await sweepRunMarker(own);
    assert.ok(signaled >= 1, "the sweep found the marked victim");
    const goneDeadline = Date.now() + 10_000;
    while (pidAlive(oursPid) && Date.now() < goneDeadline) await sleep(50);
    assert.equal(pidAlive(oursPid), false, "the marked victim is gone");
    assert.equal(pidAlive(plainPid), true, "the unmarked neighbour survives the sweep");
  } finally {
    for (const pid of [oursPid, plainPid]) {
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }
});

test("sweepRunMarker on Linux walks /proc environ and signals only the marked pid", async (t) => {
  // The Linux sweep reads /proc/<pid>/environ over a /proc readdir instead of ps -wwE — the
  // same blind-spot fix that motivates the mac-side sweep (ps -E hides platform binaries),
  // and this dev box never takes the branch. Pin the platform, fake the kernel's directory
  // and environ surface, and let the sweep signal a REAL spawned orphan carrying the mark:
  // non-numeric entries and the scanner's own pid must be skipped unread, a vanished pid's
  // read failure must be absorbed, and the one marked victim must take the SIGTERM.
  const marker = makeRunMarker();
  const dir = tmpdir();
  const pidFile = path.join(dir, "victim.pid");
  spawnMarkedVictim(
    t,
    marker,
    pidFile,
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1 << 30)",
  );
  // Poll for CONTENT, not existence: writeFileSync creates the (still empty) file before it
  // writes, so an existsSync-then-read poll can catch that window under load and read "" —
  // Number("") is 0 and the assertion below fails with "the orphan recorded its pid". Same
  // guard as pi.test.ts's `-s` wait. ENOENT before the file first appears is just a miss.
  const upDeadline = Date.now() + 10_000;
  let victimPid = 0;
  while (victimPid <= 0 && Date.now() < upDeadline) {
    await sleep(25);
    try {
      victimPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    } catch {
      victimPid = 0;
    }
  }
  assert.ok(victimPid > 0, "the orphan recorded its pid");
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const readdir = t.mock.method(fs, "readdirSync", (target: string) => {
    assert.equal(target, "/proc");
    return [String(victimPid), String(process.pid), "self", "999999999"];
  });
  const read = t.mock.method(fs, "readFileSync", (target: string) => {
    if (target === `/proc/${victimPid}/environ`) return `PATH=/bin\0TUMWATER_RUN=${marker}`;
    throw errnoError("ENOENT", "ENOENT: no such file");
  });
  try {
    const signaled = await sweepRunMarker(marker);
    assert.equal(signaled, 1, "exactly the marked victim was signalled");
    assert.deepEqual(readdir.mock.calls.map((c) => c.arguments[0]), ["/proc"]);
    assert.deepEqual(
      read.mock.calls.map((c) => c.arguments[0]).sort(),
      [`/proc/${victimPid}/environ`, "/proc/999999999/environ"],
      "the scanner's own pid is skipped unread; the vanished pid's read failure is absorbed",
    );
    const goneDeadline = Date.now() + 10_000;
    while (pidAlive(victimPid) && Date.now() < goneDeadline) await sleep(50);
    assert.equal(pidAlive(victimPid), false, "the marked victim is gone");
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
    try {
      process.kill(victimPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("sweepRunMarker escalates to SIGKILL when a marked victim survives the SIGTERM leg", async (t) => {
  // The sweep's escalation leg: a victim that ignores SIGTERM (a server trapping it) must
  // still die 10 s later. The 10 s grace is covered with logical time — the timer is mocked,
  // ticked past the grace, and the real SIGKILL lands on a real process that provably
  // survived the first leg.
  const marker = makeRunMarker();
  const dir = tmpdir();
  const readyFile = path.join(dir, "ready");
  const child = spawnMarkedVictim(
    t,
    marker,
    readyFile,
    "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1 << 30)",
  );
  const upDeadline = Date.now() + 10_000;
  while (!fs.existsSync(readyFile) && Date.now() < upDeadline) await sleep(25);
  assert.ok(fs.existsSync(readyFile), "the victim installed its SIGTERM handler before the sweep");
  const pid = child.pid as number;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const signaled = await sweepRunMarker(marker);
    assert.equal(signaled, 1);
    assert.equal(pidAlive(pid), true, "the victim survives the SIGTERM leg");
    t.mock.timers.tick(10_000);
  } finally {
    t.mock.timers.reset();
  }
  const goneDeadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < goneDeadline) await sleep(50);
  assert.equal(pidAlive(pid), false, "the SIGKILL leg removed the survivor");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
});

test("sweepRunMarker escalates to SIGKILL when a victim survives the SIGTERM", async (t) => {
  // The escalation half of the sweep: a victim that traps SIGTERM and ignores it must still
  // be taken down when the 10 s escalation timer fires — the sweep's whole point is that the
  // run's leftover tool processes do not outlive it. The timer is fire-and-forget and unref'd,
  // so a real 10 s wait would race the test process's own exit: mock timers capture the
  // schedule instead and fire the escalation on demand (the victims are spawned and recorded
  // BEFORE the mocks are enabled, so their own startup waits on real time).
  //
  // Two victims share the run-shaped marker: one compliant (dies on the SIGTERM leg) and one
  // stubborn (a SIGTERM handler that ignores the signal). The escalation then exercises both
  // of its arms: the SIGKILL that finishes the survivor, and the already-gone kill that the
  // sweep must absorb without throwing (a compliant victim exits well before the timer).
  const dir = tmpdir();
  const recordPid = "require('node:fs').writeFileSync(process.argv[1], String(process.pid));";
  const marker = makeRunMarker();
  const spawnMarked = (file: string, script: string) => spawnMarkedVictim(t, marker, path.join(dir, file), script);
  const compliant = spawnMarked(
    "compliant.pid",
    `${recordPid}setInterval(() => {}, 1 << 30)`, // no SIGTERM handler: the leg kills it
  );
  spawnMarked(
    "stubborn.pid",
    `${recordPid}process.on('SIGTERM', () => {});setInterval(() => {}, 1 << 30)`,
  );;
  const readPid = (file: string) => {
    try {
      return Number(fs.readFileSync(path.join(dir, file), "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  const recordDeadline = Date.now() + 10_000;
  while ((!readPid("compliant.pid") || !readPid("stubborn.pid")) && Date.now() < recordDeadline)
    await sleep(25);
  const compliantPid = readPid("compliant.pid");
  const stubbornPid = readPid("stubborn.pid");
  assert.ok(compliantPid > 0 && stubbornPid > 0, "both orphans recorded their pids");
  // Safety net: whatever the sweep does, this test must not leave a live orphan behind.
  t.after(() => {
    for (const pid of [compliantPid, stubbornPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone — the expected outcome.
      }
    }
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signaled = await sweepRunMarker(marker);
  assert.equal(signaled, 2, "the sweep signaled both marked victims");
  // The compliant victim dies on the leg; the escalation must then find it already gone.
  await new Promise<void>((resolve) => compliant.once("exit", () => resolve()));
  t.mock.timers.tick(10_000); // fire the escalation: SIGKILL every victim
  t.mock.timers.reset();

  const goneDeadline = Date.now() + 10_000;
  while (pidAlive(stubbornPid) && Date.now() < goneDeadline) await sleep(50);
  assert.equal(pidAlive(stubbornPid), false, "the SIGTERM-proof victim was SIGKILLed by the escalation");
  assert.equal(pidAlive(compliantPid), false, "the compliant victim stayed down");
});

test("the orphan helper arms its kill the moment the victim exists, and the hook reaps it", async (t) => {
  // Regression (BUGS.md 2026-09-30): the walks and escalation tests armed their victims'
  // kill only in a finally (or nowhere) AFTER the readiness assertions, so any failed
  // assertion leaked the victim at PPID 1. Pin both halves of the fix: the hook is
  // registered synchronously, with no await between spawn and arming, so the caller cannot
  // throw first — and the armed hook actually reaps the victim, as the runner's end-of-test
  // call would.
  const hooks: Array<() => void> = [];
  const recording = { after: (hook: () => void) => hooks.push(hook) } as unknown as TestContext;
  const marker = makeRunMarker();
  const pidFile = path.join(tmpdir(), "victim.pid");
  const child = spawnMarkedVictim(
    recording,
    marker,
    pidFile,
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1 << 30)",
  );
  // Safety net of the safety net: if an assertion below fails, the real runner still reaps.
  armVictimKill(t, child);
  assert.equal(hooks.length, 1, "the kill is armed synchronously, before any await can run");
  const reap = hooks.at(0);
  assert.ok(reap, "the armed hook exists");
  reap();
  const goneDeadline = Date.now() + 10_000;
  while (child.pid && pidAlive(child.pid) && Date.now() < goneDeadline)
    await sleep(50);
  assert.ok(!child.pid || !pidAlive(child.pid), "the armed hook killed the victim");
});
