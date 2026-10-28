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
