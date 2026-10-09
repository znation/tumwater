import test from "node:test";
import assert from "node:assert/strict";
import { runScriptGroup } from "../src/process/process-group.js";
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
