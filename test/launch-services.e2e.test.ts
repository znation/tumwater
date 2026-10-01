/** The orchestrator's launchservicesd watch wiring (src/launch-services.ts, BUGS.md 2026-09-28): a
 * daemon fleet steps the watch from its poll — sampling at once, then at most once per interval
 * however many polls run — and warns through the event feed; a once round never samples. A fake
 * probe stands in for the Mac's daemon. Like the rest of the orchestrator e2e tier this runs via
 * `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import { LaunchServicesWatch, launchServicesWarning } from "../src/launch-services.js";
import { systemProcessProbe, type ProcessProbe } from "../src/process-table.js";
import { FAST_POLL_MS, makeFastRepo, runRepoOrchestrator } from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";
import { eventsOfType, harnessWarnings } from "./log-fixtures.js";
import { waitFor } from "./wait.js";

/** A probe reporting `ports` for launchservicesd, counting how often it is asked. */
function countingProbe(ports: number): ProcessProbe & { reads: number } {
  const probe = {
    reads: 0,
    list: async () => [],
    cwds: async () => new Map<number, string>(),
    runMarkers: async () => new Map<number, string[]>(),
    launchServicesPorts: async () => {
      probe.reads++;
      return ports;
    },
  };
  return probe;
}

test("a daemon fleet samples launchservicesd on its first poll and warns once through the event feed", async () => {
  const repo = await makeFastRepo("launchservices watch", ["clean"]);
  const restore = fakePiIdle();
  const probe = countingProbe(150_000);
  const controller = new AbortController();
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    launchServicesWatch: new LaunchServicesWatch(repo, probe),
  });
  try {
    const warned = () => harnessWarnings(repo).filter((e) => e.message === launchServicesWarning(150_000));
    await waitFor(() => warned().length > 0, "the port warning");
    // The first poll sampled before any tick started; by the time the role's tick has ended the
    // fleet has polled again and again, and none of those samples inside the interval.
    await waitFor(() => eventsOfType(repo, "tick_end").length > 0, "the clean role's first tick to end");
    assert.equal(probe.reads, 1);
    assert.equal(warned().length, 1);
  } finally {
    controller.abort();
    await done.catch(() => {});
    restore();
  }
});

test("the real probe reads launchservicesd's port count off the live system without rejecting", async () => {
  // The host-dependent check the gating tier carried until 2026-09-30 (BUGS.md): a saturated
  // host could not finish `top -l 1` inside its timeout and marked main red. It lives here,
  // in the e2e tier, so the wiring to the real `top` stays exercised without gating on it.
  const ports = await systemProcessProbe.launchServicesPorts();
  if (process.platform === "darwin") {
    assert.ok(ports === null || (Number.isInteger(ports) && ports > 0), `a live count or an honest null: ${ports}`);
  } else {
    assert.equal(ports, null);
  }
});

test("a once round runs without the watch even when one is passed", async () => {
  const repo = await makeFastRepo("launchservices watch once", ["clean"]);
  const restore = fakePiIdle();
  const probe = countingProbe(150_000);
  try {
    await runRepoOrchestrator(repo, {
      pollMs: FAST_POLL_MS,
      once: true,
      launchServicesWatch: new LaunchServicesWatch(repo, probe),
    });
    assert.equal(probe.reads, 0);
    assert.equal(harnessWarnings(repo).filter((e) => String(e.message).startsWith("launchservicesd")).length, 0);
  } finally {
    restore();
  }
});
