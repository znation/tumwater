import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_LAUNCH_SERVICES_CHECK_IN,
  parseLsofCwds,
  parsePsOutput,
  parseTopPorts,
  pidAlive,
  signalTree,
  systemProcessProbe,
  terminateChild,
  withoutLaunchServicesCheckIn,
} from "../src/process.js";
import { tmpdir } from "./repo-fixtures.js";
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
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === 0) {
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
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    await assert.rejects(systemProcessProbe.cwds([process.pid]));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
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

test("terminateChild takes a live process group down promptly with the SIGTERM leg", async () => {
  // The full SIGTERM → SIGKILL escalation (10 s grace) is covered by build-check.test.ts with
  // logical time; here the real entry point must at least deliver the SIGTERM leg: a detached
  // child exits by signal, fast, without the test waiting out any grace.
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
