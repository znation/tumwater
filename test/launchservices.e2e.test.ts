/** The orchestrator's launchservicesd watch wiring (src/launchservices.ts, BUGS.md 2026-09-28): a
 * daemon fleet steps the watch from its poll — sampling at once, then at most once per interval
 * however many polls run — and warns through the event feed; a once round never samples. A fake
 * probe stands in for the Mac's daemon. Like the rest of the orchestrator e2e tier this runs via
 * `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import { runOrchestrator } from "../src/orchestrator.js";
import { loadConfig } from "../src/config.js";
import { LaunchServicesWatch, launchServicesWarning } from "../src/launchservices.js";
import type { ProcessProbe } from "../src/process.js";
import { FAST_POLL_MS, makeFastRepo } from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";
import { eventsOfType, harnessWarnings } from "./util.js";
import { waitFor } from "./wait.js";

/** A probe reporting `ports` for launchservicesd, counting how often it is asked. */
function countingProbe(ports: number): ProcessProbe & { reads: number } {
  const probe = {
    reads: 0,
    list: async () => [],
    cwds: async () => new Map<number, string>(),
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
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
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

test("a once round runs without the watch even when one is passed", async () => {
  const repo = await makeFastRepo("launchservices watch once", ["clean"]);
  const restore = fakePiIdle();
  const probe = countingProbe(150_000);
  try {
    await runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: new AbortController().signal,
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
