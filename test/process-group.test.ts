import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { groupAlive, runScriptGroup } from "../src/process/process-group.js";
import { NO_LAUNCH_SERVICES_CHECK_IN, withoutLaunchServicesCheckIn } from "../src/process/process.js";
import { waitForFile } from "./helpers/wait.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// runScriptGroup is the detached process-group runner behind runBuildCheck
// (src/process/process-group.ts,
// split out of process.ts): its env carries the LaunchServices preload, so the check's own npm —
// and every npm a suite's build-check tests start under it — leaks no launchservicesd port on
// macOS. The timeout/grace/group-poll behavior itself is pinned with logical time in
// build-check.test.ts, which exercises it through runBuildCheck, the only runtime consumer.

test("runScriptGroup starts its tree with the LaunchServices preload on macOS, and the env unchanged elsewhere", async () => {
  const r = await runScriptGroup("sh", ["-c", 'printf %s "$NODE_OPTIONS"'], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
    killGraceMs: 1_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, withoutLaunchServicesCheckIn(process.env).NODE_OPTIONS ?? "");
  if (process.platform === "darwin") assert.ok(r.stdout.includes(NO_LAUNCH_SERVICES_CHECK_IN), r.stdout);
});

const RUN_OPTS = { cwd: process.cwd(), timeoutMs: 30_000, killGraceMs: 1_000, maxBuffer: 1 };

test("runScriptGroup caps each stream at maxBuffer, dropping later chunks", async () => {
  const r = await runScriptGroup("sh", ["-c", "printf a; printf x >&2; sleep 0.3; printf b; printf y >&2"], RUN_OPTS);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "a");
  assert.equal(r.stderr, "x");
});

test("runScriptGroup reports a command missing from PATH as spawnError, never a code, and resolves", async () => {
  const r = await runScriptGroup("tumwater-no-such-command-xyz", [], RUN_OPTS);
  assert.equal(r.spawnError?.code, "ENOENT");
  assert.equal(r.code, undefined);
  assert.equal(r.timedOut, false);
});

test("groupAlive: no pid is no group, EPERM is a live member, any other error is gone", (t) => {
  let thrown: string | undefined;
  const kill = t.mock.method(process, "kill", (() => {
    if (thrown) throw Object.assign(new Error(thrown), { code: thrown });
    return true;
  }) as typeof process.kill);
  assert.equal(groupAlive(undefined), false);
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(groupAlive(4242), true);
  assert.deepEqual(kill.mock.calls[0]?.arguments, [-4242, 0]);
  thrown = "EPERM";
  assert.equal(groupAlive(4242), true);
  thrown = "ESRCH";
  assert.equal(groupAlive(4242), false);
});

// An abort signal stops the whole tree the way a timeout does — SIGTERM, then SIGKILL after the
// grace — but the result says the harness aborted it, distinct from a timeout and from an
// external killed signal: the gate settles an aborted check `aborted` instead of waiting a parked
// check out (PLANS.md part 4e/3). The grandchild is taken down with the group before the run
// settles, so the caller never sees a live tree behind an aborted outcome.
test("an abort signal stops the whole group like a timeout, and the result says the harness aborted it", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pg-abort-"));
  const leader = path.join(dir, "leader");
  const grandchild = path.join(dir, "grandchild");
  try {
    const controller = new AbortController();
    const pending = runScriptGroup(
      "sh",
      [
        "-c",
        `printf %s "$$" > "${leader}"; (sleep 30; exit 0) & printf %s "$!" > "${grandchild}"; wait`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        killGraceMs: 1_000,
        maxBuffer: 1024 * 1024,
        signal: controller.signal,
      },
    );
    // Let the tree spawn and write both marker PIDs, then abort mid-run — a 30 s sleep that
    // must not run out.
    await waitForFile(leader);
    await waitForFile(grandchild);
    controller.abort();
    const started = Date.now();
    const r = await pending;
    assert.equal(r.aborted, true, "the result says the harness aborted it");
    assert.equal(r.timedOut, false, "an abort is not a timeout");
    assert.ok(Date.now() - started < 5_000, "settled well under the 30 s sleep");
    // The whole process group — the grandchild included — is gone once the run settles.
    await waitForGone(parseInt(fs.readFileSync(leader, "utf8"), 10));
    await waitForGone(parseInt(fs.readFileSync(grandchild, "utf8"), 10));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The handle release is uniform across every settle path, not just the timeout: a descendant
// that escapes the group and keeps a pipe — the setsid'd daemon the module's own contract
// names ("a descendant that escaped the group cannot keep the harness's handles open") — must
// not keep the harness's event loop alive through the inherited pipe. The timeout branch already
// released the handles; the abort and the ordinary close must settle the same way, or an escaped
// pipe-holder is what keeps the orchestrator alive after a shutdown that aborts a running check.
//
// The daemon sits in its OWN process group (detached, like a setsid'd daemon), so neither the
// deadline's nor the abort's group-wide SIGTERM/SIGKILL can reach it — only an explicit release
// of the harness's read-ends can let them close. The run is settled on an ABORT (a user stop),
// the non-timeout path the timeout branch never covered. The daemon self-terminates a few seconds
// later, so the test bounds itself and leaves no orphan whether or not the release landed.
test("an aborted run releases its pipe handles, so an escaped separate-group daemon adds no harness handle", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pg-escaped-daemon-"));
  // A spawner that starts a daemon in its own process group, still holding the run's inherited
  // stdout/stderr pipes: `detached: true` makes it a new group leader (the setsid shape), so the
  // run's group signals cannot take it down. It self-exits after 3 s, bounding the test.
  fs.writeFileSync(
    path.join(dir, "spawner.js"),
    [
      "const cp=require('node:child_process');const fs=require('node:fs');",
      "const d=cp.spawn('node',['-e','setInterval(()=>{},100);setTimeout(()=>process.exit(0),3000)'],{detached:true,stdio:[0,1,2]});",
      "d.unref();fs.writeFileSync(process.argv[2],String(d.pid));",
    ].join("\n"),
  );
  const daemon = path.join(dir, "daemon");
  const handles = () =>
    process.getActiveResourcesInfo().filter((r) => r === "PipeWrap" || r === "ProcessWrap").length;
  const baseline = handles();
  const controller = new AbortController();
  try {
    const pending = runScriptGroup(
      "sh",
      // The leader starts the daemon, then sleeps well past any deadline, so the run does not
      // settle on its own — the abort below is what settles it, while the daemon (in its
      // separate group) is still alive and holding the pipes.
      ["-c", `node "${path.join(dir, "spawner.js")}" "${daemon}"; sleep 30; exit 0`],
      { cwd: dir, timeoutMs: 30_000, killGraceMs: 1_000, maxBuffer: 1024, signal: controller.signal },
    );
    // The daemon is up (its pid recorded) before the abort settles the run on the group being
    // gone — so at settle the daemon still holds the pipe write-ends.
    await waitForFile(daemon);
    controller.abort();
    const r = await pending;
    assert.equal(r.aborted, true, "the run settled on the harness's abort");
    assert.equal(r.timedOut, false, "the abort settled it, not a deadline");
    // The daemon still holds the pipe write-ends, but the settle released the harness's read-ends,
    // which close asynchronously once destroyed. Allow that close to land, then the active-
    // resource count must be back to the baseline: the escaped daemon is not what keeps the event
    // loop alive. A settle that does not release the handles leaves them open, so the count stays
    // above the baseline and this fails.
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(
      handles(),
      baseline,
      "the settle released its pipe handles; the escaped daemon adds no harness handle",
    );
    // The daemon is in a separate group the run's signals cannot reach, so take it down by pid.
    // It self-terminates at 3 s regardless; the explicit kill only makes the red state bound
    // itself rather than hold the suite open until then.
    try {
      process.kill(parseInt(fs.readFileSync(daemon, "utf8"), 10), "SIGKILL");
    } catch {
      // Already gone: nothing to clean up.
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Poll until a pid no longer exists (or EPERM no longer reports it): a process in the same
 * group the abort SIGTERMed is killed and reaped, so a signal-0 probe eventually throws ESRCH. */
async function waitForGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`pid ${pid} still alive after the abort`);
}
