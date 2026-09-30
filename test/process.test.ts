import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_LAUNCH_SERVICES_CHECK_IN,
  pidAlive,
  signalTree,
  terminateChild,
  withoutLaunchServicesCheckIn,
} from "../src/process.js";
import {
  makeRunMarker,
  parseLsofCwds,
  parsePsOutput,
  parseTopPorts,
  pidsMarkedInPs,
  procEnvironCarriesMarker,
  runMarkerEnv,
  runMarkersInEnviron,
  runMarkersInPs,
  sweepRunMarker,
  systemProcessProbe,
} from "../src/process-table.js";
import { runningAsRoot, tmpdir } from "./repo-fixtures.js";
import { pathReplace } from "./fake-commands.js";
import { errnoError } from "./fs-faults.js";

// The liveness probe underpins two recovery paths: lock.ts's stale-holder check (a dead
// holder's merge lock must be breakable) and fleet-state.ts's orchestrator-alive status. Its
// contract is "any error reads as not alive" — the EPERM case matters most, because a live
// foreign pid mistaken for one of ours would make tryBreakStale never break that lock, and
// every merge would time out forever (the orphaned-lock bug class in BUGS.md).

test("pidAlive reports the calling process as alive", () => {
  assert.equal(pidAlive(process.pid), true);
});

test("pidAlive follows a real child across its whole lifetime", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid;
  try {
    // The pid is assigned at spawn, but give the kernel a moment before asserting.
    assert.ok(pid !== undefined, "spawn assigned a pid");
    const deadline = Date.now() + 2_000;
    while (!pidAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(pidAlive(pid), true, "a running child reads as alive");

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL"); // Attach the listener first, then kill.
    });
    // Probe immediately after the reap: the pid is gone (ESRCH) unless recycled in the
    // microseconds between exit and this call.
    assert.equal(pidAlive(pid), false, "an exited child reads as not alive");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
});

test("pidAlive reads a live foreign process as NOT alive (EPERM)", (t) => {
  if (runningAsRoot()) {
    t.skip("running as root: signal-0 to pid 1 is permitted, so the EPERM branch is unreachable");
    return;
  }
  // PID 1 (launchd/init) is always running but owned by another user: a non-root probe gets
  // EPERM. The contract says that reads as "not alive" — a live foreign holder must not be
  // mistaken for one of ours, or the merge lock it holds could never be broken.
  assert.equal(pidAlive(1), false);
});

test("pidAlive reads an impossible pid as NOT alive without throwing", () => {
  // Far beyond any platform's pid space (Linux PID_MAX_LIMIT is 2^22; macOS wraps at ~10^5):
  // the signal-0 fails with EINVAL/ESRCH, and "any error" must read as not alive.
  assert.equal(pidAlive(2_000_000_000), false);
});

test("pidAlive reads a non-positive or fractional pid as NOT alive", () => {
  // signal 0 treats pid 0 as the caller's own process group and a negative pid as another
  // group — both probes succeed, so without the positive-integer guard a corrupt state or
  // lock file (pid 0, -1) would report a phantom holder alive. Fractional ids are likewise
  // never real pids.
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(1.5), false);
});

// The process-table reader behind doctor's orphan check (checkOrphans in src/doctor.ts, where
// the matching is pinned against a fake table). Here: the two parsers over fixed BSD/procps
// and lsof output, and one smoke of the real probe against this test process itself — no
// orphan is ever spawned.

test("parsePsOutput reads BSD and procps rows, keeps argv spaces, and skips junk", () => {
  const rows = parsePsOutput(
    [
      "    1     0     0 35-22:43:52 425:10.18 /sbin/launchd", // macOS: dd-hh:mm:ss, mm:ss.hh
      "88052     1   501 2-21:44:01   0:03.12 node dist/test/test-runner.js",
      " 4242     1  1000    01:02:03 00:00:05 node /r/.tumwater/worktrees/qa/dist/src/cli.js gui --port 41602", // procps
      "  777   776   501     00:04 0:00.00", // a zombie: no argv at all
      "not a ps row",
      "",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, uid: 0, etime: "35-22:43:52", time: "425:10.18", command: "/sbin/launchd" },
    { pid: 88052, ppid: 1, uid: 501, etime: "2-21:44:01", time: "0:03.12", command: "node dist/test/test-runner.js" },
    {
      pid: 4242,
      ppid: 1,
      uid: 1000,
      etime: "01:02:03",
      time: "00:00:05",
      command: "node /r/.tumwater/worktrees/qa/dist/src/cli.js gui --port 41602",
    },
    { pid: 777, ppid: 776, uid: 501, etime: "00:04", time: "0:00.00", command: "" },
  ]);
});

test("parseLsofCwds maps each pid to its cwd and leaves out a process lsof could not read", () => {
  const cwds = parseLsofCwds(
    ["p101", "fcwd", "n/Users/z/repo/.tumwater/worktrees/bugfix", "p102", "fcwd", "p103", "fcwd", "n/tmp/with space", ""].join("\n"),
  );
  assert.deepEqual([...cwds], [
    [101, "/Users/z/repo/.tumwater/worktrees/bugfix"],
    [103, "/tmp/with space"],
  ]);
});

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

test("systemProcessProbe.runMarkers reads a live child's mark and skips vanished pids", async () => {
  assert.deepEqual(await systemProcessProbe.runMarkers([]), new Map());
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, TUMWATER_RUN: "999999123-cafe" },
    stdio: "ignore",
  });
  try {
    let marks = new Map<number, string[]>();
    for (let i = 0; i < 50 && marks.size === 0; i++) {
      marks = await systemProcessProbe.runMarkers([child.pid as number, 2_000_000_000]);
      if (marks.size === 0) await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual([...marks], [[child.pid as number, ["999999123-cafe"]]]);
  } finally {
    child.kill("SIGKILL");
  }
});

test("systemProcessProbe lists this process with its parent and reads its cwd past a vanished pid", async () => {
  const rows = await systemProcessProbe.list();
  const self = rows.find((r) => r.pid === process.pid);
  assert.ok(self, "the table includes the calling process");
  assert.equal(self.ppid, process.ppid);
  assert.match(self.command, /node/);
  // A pid beyond any pid space rides along: lsof exits 1 whenever any named pid is absent, and
  // that exit must still yield the cwds it did print (on Linux the /proc read just skips it).
  const cwds = await systemProcessProbe.cwds([process.pid, 2_000_000_000]);
  assert.equal(cwds.get(process.pid), fs.realpathSync(process.cwd()));
  assert.equal(cwds.has(2_000_000_000), false);
  assert.deepEqual(await systemProcessProbe.cwds([]), new Map());
});

test("systemProcessProbe.cwds on Linux reads /proc, strips ' (deleted)', and skips vanished pids", async (t) => {
  // The Linux branch reads /proc/<pid>/cwd instead of shelling out to lsof, and this dev box
  // never takes it — so pin the platform and fake the kernel's readlink surface. The contract
  // under test: each readable symlink becomes that pid's cwd, the kernel's " (deleted)"
  // suffix on a removed directory is stripped, and a pid whose read fails (exited meanwhile,
  // or another user's process) is simply absent rather than failing the whole scan.
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const readlink = t.mock.method(fs, "readlinkSync", (target: string) => {
    if (target === "/proc/11/cwd") throw errnoError("ENOENT", "ENOENT: no such file");
    if (target === "/proc/12/cwd") return "/gone/build-dir (deleted)";
    return "/Users/z/repo/.tumwater/worktrees/coverage";
  });
  try {
    const cwds = await systemProcessProbe.cwds([10, 11, 12]);
    assert.deepEqual([...cwds], [
      [10, "/Users/z/repo/.tumwater/worktrees/coverage"],
      [12, "/gone/build-dir"],
    ]);
    assert.deepEqual(
      readlink.mock.calls.map((c) => c.arguments[0]),
      ["/proc/10/cwd", "/proc/11/cwd", "/proc/12/cwd"],
    );
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
});

test("systemProcessProbe.cwds takes the lsof success path when every named pid is readable", async (t) => {
  // The vanished-pid test above only reaches lsof's exit-1 partial-result path; this is the
  // other half of the same branch — every pid readable, lsof exits 0, and the map comes
  // straight from its output.
  if (process.platform === "linux") t.skip("the lsof path is not taken on Linux");
  const cwds = await systemProcessProbe.cwds([process.pid]);
  assert.deepEqual([...cwds], [[process.pid, fs.realpathSync(process.cwd())]]);
});

test("systemProcessProbe.cwds rejects when no lookup could run at all — no lsof on PATH", async (t) => {
  // A missing lsof (or a timeout, or a signal) is a real failure, not an empty answer: the
  // error carries no numeric exit status with stdout, so the probe must reject rather than
  // hand back a silent empty map that would read as "no orphans" in doctor's check.
  if (process.platform === "linux") t.skip("the lsof path is not taken on Linux");
  const emptyBin = tmpdir("no-lsof-");
  const restorePath = pathReplace(emptyBin);
  try {
    await assert.rejects(systemProcessProbe.cwds([process.pid]));
  } finally {
    restorePath();
  }
});

test("systemProcessProbe reads launchservicesd's port count on macOS, and none elsewhere", async () => {
  const ports = await systemProcessProbe.launchServicesPorts();
  if (process.platform === "darwin") assert.ok(Number.isInteger(ports) && (ports ?? 0) > 0, `a live count: ${ports}`);
  else assert.equal(ports, null);
});

test("parseTopPorts reads the named process's #PORTS from a top sample, the largest of several", () => {
  const sample = [
    "Processes: 812 total, 3 running, 809 sleeping, 4521 threads",
    "2026/09/28 01:09:39",
    "Load Avg: 2.37, 2.29, 2.64",
    "",
    "PID    COMMAND          #PORTS",
    "65942  node             31",
    "574    launchservicesd  698",
    "575    launchservicesd  104211+",
    "1      launchd          4410",
    "",
  ].join("\n");
  assert.equal(parseTopPorts(sample, "launchservicesd"), 104211, "a trend mark after the count is ignored");
  assert.equal(parseTopPorts(sample, "launchd"), 4410, "the name must match exactly, not as a prefix");
  assert.equal(parseTopPorts(sample, "WindowServer"), null);
  assert.equal(parseTopPorts("", "launchservicesd"), null);
});

// The LaunchServices leak (BUGS.md 2026-09-28): on macOS every Node process that sets
// process.title registers with LaunchServices, and launchservicesd keeps a Mach port per process
// forever. The preload must take effect on every platform it is handed to (the checks below
// force it on), change nothing a program can observe from inside, and ride NODE_OPTIONS intact.

test("withoutLaunchServicesCheckIn appends the preload to NODE_OPTIONS once on macOS and leaves other platforms alone", () => {
  assert.doesNotMatch(NO_LAUNCH_SERVICES_CHECK_IN, /[\s"]/, "NODE_OPTIONS splits on whitespace and strips double quotes");
  const base = { PATH: "/bin", NODE_OPTIONS: "--max-old-space-size=4096" };
  const mac = withoutLaunchServicesCheckIn(base, "darwin");
  assert.equal(mac.NODE_OPTIONS, `--max-old-space-size=4096 ${NO_LAUNCH_SERVICES_CHECK_IN}`);
  assert.equal(mac.PATH, "/bin");
  assert.equal(base.NODE_OPTIONS, "--max-old-space-size=4096", "the caller's env is not mutated");
  // Already carried — a build check started from inside a pi run: nothing doubles up.
  assert.equal(withoutLaunchServicesCheckIn(mac, "darwin"), mac);
  assert.equal(withoutLaunchServicesCheckIn({}, "darwin").NODE_OPTIONS, NO_LAUNCH_SERVICES_CHECK_IN);
  assert.equal(withoutLaunchServicesCheckIn({ NODE_OPTIONS: "  " }, "darwin").NODE_OPTIONS, NO_LAUNCH_SERVICES_CHECK_IN);
  // Anywhere else a title registers nothing, so the env passes through untouched.
  assert.equal(withoutLaunchServicesCheckIn(base, "linux"), base);
});

/** A `node -e` child that sets its title, prints process.title as read back from inside, and then
 * idles until killed; resolves with the child and that line once the assignment has run. */
async function titledChild(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; line: string }> {
  const code = 'process.title="tumwater-title-probe";console.log(process.title);setInterval(()=>{},1000)';
  const child = spawn(process.execPath, ["-e", code], { env, stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.split("\n")[0] ?? "");
    });
    child.once("exit", (code) => reject(new Error(`the probe exited (${code}) before printing: ${out}`)));
  });
  return { child, line };
}

function psCommand(pid: number | undefined): string {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

test("the preload keeps a title assignment out of the process table, while process.title still reads it back", async () => {
  // The regression this pins: a `value` descriptor instead of an accessor goes through Node's
  // native setter, so the title still reaches the OS (and LaunchServices) — ps would show it.
  const { child, line } = await titledChild(withoutLaunchServicesCheckIn(process.env, "darwin"));
  try {
    assert.equal(line, "tumwater-title-probe", "the program sees the title it set");
    const shown = psCommand(child.pid);
    assert.match(shown, /process\.title=/, `ps shows the real argv, not the title: ${shown}`);
  } finally {
    child.kill("SIGKILL");
  }
});

test("without the preload a title assignment reaches the process table, so the check above is not vacuous", async (t) => {
  if (process.platform === "darwin") {
    t.skip("here the bare assignment would check the suite in with LaunchServices and leak a launchservicesd port");
    return;
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const { child } = await titledChild(env);
  try {
    assert.equal(psCommand(child.pid), "tumwater-title-probe");
  } finally {
    child.kill("SIGKILL");
  }
});

// signalTree/terminateChild are the teardown guarantee behind pi runs and build checks: a
// detached child leads its own process group, and the kill must reach every tool-call
// grandchild, not just the direct child. runScriptGroup's timeout/grace logic is pinned with
// logical time in build-check.test.ts through a faked runner, and pi runs only happen in real
// orchestrators — so the tree-kill itself is pinned here, against real groups.

test("signalTree kills the child's whole process group, grandchild included, via the negative-pid kill", async () => {
  // A detached sh leads a fresh group; its backgrounded sleep is the grandchild the kill must
  // also reach. The child's own kill() is stubbed to throw, so a true return proves the
  // negative-pid group kill ran and the per-child fallback was never needed.
  const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grand = await new Promise<number>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      const pid = Number(chunk.toString().split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
    });
    child.once("exit", () => reject(new Error("the leader exited before naming its grandchild")));
  });
  child.kill = () => {
    throw new Error("the child.kill fallback must not run when the group is alive");
  };
  try {
    assert.equal(signalTree(child, "SIGTERM"), true, "the group kill reached a live process");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // The grandchild must not outlive its group: a single-PID kill would orphan it.
    const deadline = Date.now() + 2_000;
    while (pidAlive(grand) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(pidAlive(grand), false, "the grandchild died with its group");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
});

test("signalTree falls back to child.kill when the group kill fails, and reports the result", (t) => {
  // A pid beyond any pid space makes the negative-pid kill fail (ESRCH/EINVAL) without touching
  // any real process; the fallback then signals the child object itself.
  const kill = t.mock.fn((_signal: NodeJS.Signals) => true);
  const child = { pid: 2_000_000_000, kill } as unknown as ChildProcess;
  assert.equal(signalTree(child, "SIGTERM"), true);
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments[0]), ["SIGTERM"]);
});

test("signalTree returns false, never throwing, when nothing can be signalled", () => {
  // No pid (a spawn that never started): nothing to signal, and no fallback either.
  assert.equal(signalTree({ pid: undefined, kill: () => true } as unknown as ChildProcess, "SIGTERM"), false);
  // A group kill that fails AND a child.kill that throws: already gone — still no throw.
  const child = {
    pid: 2_000_000_000,
    kill: () => {
      throw new Error("already gone");
    },
  } as unknown as ChildProcess;
  assert.equal(signalTree(child, "SIGKILL"), false);
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
    await new Promise((r) => setTimeout(r, 25));
  const oursPid = readPid("ours.pid");
  const plainPid = readPid("plain.pid");
  try {
    assert.ok(oursPid > 0 && plainPid > 0, "both orphans recorded their pids");
    const signaled = await sweepRunMarker(own);
    assert.ok(signaled >= 1, "the sweep found the marked victim");
    const goneDeadline = Date.now() + 10_000;
    while (pidAlive(oursPid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 50));
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

test("systemProcessProbe.runMarkers on Linux reads /proc environ, skipping the scanner and vanished pids", async (t) => {
  // The Linux branch reads /proc/<pid>/environ instead of shelling out to ps -wwE, and this
  // dev box never takes it — so pin the platform and fake the kernel's environ surface. The
  // contract under test: a marked environ becomes that pid's marker list, a pid whose read
  // fails (exited meanwhile, or another user's process) is simply absent, and the scanner's
  // own pid is skipped before any read — it holds its mark in memory, not in its environment.
  const marker = makeRunMarker();
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const read = t.mock.method(fs, "readFileSync", (target: string) => {
    if (target === "/proc/10/environ") return `PATH=/bin\0TUMWATER_RUN=${marker}`;
    if (target === "/proc/11/environ") throw errnoError("ENOENT", "ENOENT: no such file");
    return "PATH=/bin";
  });
  try {
    const marks = await systemProcessProbe.runMarkers([10, 11, 12, process.pid]);
    assert.deepEqual([...marks], [[10, [marker]]]);
    assert.deepEqual(
      read.mock.calls.map((c) => c.arguments[0]),
      ["/proc/10/environ", "/proc/11/environ", "/proc/12/environ"],
    );
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
});

test("systemProcessProbe.runMarkers degrades to an empty map when the ps table cannot be read", async (t) => {
  // A missing ps (or a wedged table) is a miss, never a failed doctor — the argv/cwd half of
  // the probe still ran, so the sweep must hand back an empty answer rather than throw.
  if (process.platform === "linux") t.skip("the ps fallback is not taken on Linux");
  const emptyBin = tmpdir("no-ps-");
  const restorePath = pathReplace(emptyBin);
  try {
    assert.deepEqual(await systemProcessProbe.runMarkers([process.pid]), new Map());
  } finally {
    restorePath();
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
  const child = spawn(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1 << 30)", pidFile],
    { detached: true, stdio: "ignore", env: { ...process.env, TUMWATER_RUN: marker } },
  );
  child.unref();
  // Poll for CONTENT, not existence: writeFileSync creates the (still empty) file before it
  // writes, so an existsSync-then-read poll can catch that window under load and read "" —
  // Number("") is 0 and the assertion below fails with "the orphan recorded its pid". Same
  // guard as pi.test.ts's `-s` wait. ENOENT before the file first appears is just a miss.
  const upDeadline = Date.now() + 10_000;
  let victimPid = 0;
  while (victimPid <= 0 && Date.now() < upDeadline) {
    await new Promise((r) => setTimeout(r, 25));
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
    while (pidAlive(victimPid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 50));
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
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1 << 30)", readyFile],
    { detached: true, stdio: "ignore", env: { ...process.env, TUMWATER_RUN: marker } },
  );
  child.unref();
  const upDeadline = Date.now() + 10_000;
  while (!fs.existsSync(readyFile) && Date.now() < upDeadline) await new Promise((r) => setTimeout(r, 25));
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
  while (pidAlive(pid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(pidAlive(pid), false, "the SIGKILL leg removed the survivor");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
});

test("terminateChild escalates to SIGKILL when the group survives the SIGTERM leg", async (t) => {
  // terminateChild's own escalation, the half sweepRunMarker's test cannot cover: a detached
  // pi-like child that traps SIGTERM (a server ignoring the polite leg) must still die when
  // the armed timer fires, 10 s later, by SIGKILL to its whole group. The grace is covered
  // with logical time — the timer is mocked and ticked past it, and the real SIGKILL lands on
  // a real process that provably survived the first leg.
  const readyFile = path.join(tmpdir(), "ready");
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1 << 30)", readyFile],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const upDeadline = Date.now() + 10_000;
  while (!fs.existsSync(readyFile) && Date.now() < upDeadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(readyFile), "the victim installed its SIGTERM handler before the terminate");
  const pid = child.pid as number;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    terminateChild(child);
    assert.equal(pidAlive(pid), true, "the victim survives the SIGTERM leg");
    t.mock.timers.tick(10_000);
  } finally {
    t.mock.timers.reset();
  }
  const goneDeadline = Date.now() + 10_000;
  while (pidAlive(pid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(pidAlive(pid), false, "the SIGKILL leg removed the SIGTERM-trapping survivor");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
});

test("terminateChild takes a live process group down promptly with the SIGTERM leg", async () => {
  // The SIGTERM leg alone: a compliant detached child exits by signal, fast, without the
  // test waiting out any grace — and the escalation timer above covers the stubborn case.
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  terminateChild(child);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const outcome = await Promise.race([
    exit,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
  ]);
  if (outcome === "timeout") assert.fail("the child was left running after terminateChild");
  assert.equal(outcome.signal, "SIGTERM", "the SIGTERM leg did the killing");
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
  const spawnMarked = (file: string, script: string) => {
    const child = spawn(process.execPath, ["-e", script, path.join(dir, file)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TUMWATER_RUN: marker },
    });
    child.unref();
    return child;
  };
  const compliant = spawnMarked(
    "compliant.pid",
    `${recordPid}setInterval(() => {}, 1 << 30)`, // no SIGTERM handler: the leg kills it
  );
  spawnMarked(
    "stubborn.pid",
    `${recordPid}process.on('SIGTERM', () => {});setInterval(() => {}, 1 << 30)`,
  );
  const readPid = (file: string) => {
    try {
      return Number(fs.readFileSync(path.join(dir, file), "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  const recordDeadline = Date.now() + 10_000;
  while ((!readPid("compliant.pid") || !readPid("stubborn.pid")) && Date.now() < recordDeadline)
    await new Promise((r) => setTimeout(r, 25));
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
  while (pidAlive(stubbornPid) && Date.now() < goneDeadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(pidAlive(stubbornPid), false, "the SIGTERM-proof victim was SIGKILLed by the escalation");
  assert.equal(pidAlive(compliantPid), false, "the compliant victim stayed down");
});
