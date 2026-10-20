import test from "node:test";
import assert from "node:assert/strict";
import { groupAlive, runScriptGroup } from "../src/process/process-group.js";
import { NO_LAUNCH_SERVICES_CHECK_IN, withoutLaunchServicesCheckIn } from "../src/process/process.js";

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
