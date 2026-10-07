import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkLaunchServicesPorts,
  LAUNCH_SERVICES_REWARN_PORTS,
  LAUNCH_SERVICES_SAMPLE_MS,
  LAUNCH_SERVICES_WARN_PORTS,
  LaunchServicesWatch,
  launchServicesWarning,
  nextLaunchServicesWarning,
} from "../src/process/launch-services.js";
import type { ProcessProbe } from "../src/process/process-table.js";
import { eventsLogPath } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";
import { harnessWarnings } from "./log-fixtures.js";

// launchservicesd's Mach-port watch (src/process/launch-services.ts, BUGS.md 2026-09-28): doctor's line and
// a running fleet's warning, both driven by a fake probe — no test reads the real Mac's daemon
// (process.test.ts pins the real probe).

/** A probe answering only the port count, with the given counts in turn (the last repeats). */
function portsProbe(...counts: Array<number | null>): ProcessProbe & { reads: number } {
  const probe = {
    reads: 0,
    list: async () => [],
    cwds: async () => new Map<number, string>(),
    runMarkers: async () => new Map<number, string[]>(),
    launchServicesPorts: async () => counts[Math.min(probe.reads++, counts.length - 1)] ?? null,
  };
  return probe;
}

test("the warning names the count, the kill ceiling, the consequence and the only remedy", () => {
  const w = launchServicesWarning(104_211);
  assert.match(w, /launchservicesd holds 104\.2k Mach ports/);
  assert.match(w, /kills it near 268\.0k/);
  assert.match(w, /wedges the GUI session/);
  assert.match(w, /restart the Mac/);
});

test("a fleet warns at the threshold, again every step past its last warning, and re-arms once the daemon restarts", () => {
  let state: number | null = null;
  const step = (ports: number): boolean => {
    const next = nextLaunchServicesWarning(state, ports);
    state = next.lastWarned;
    return next.warn;
  };
  assert.equal(step(LAUNCH_SERVICES_WARN_PORTS - 1), false, "below the threshold is quiet");
  assert.equal(step(LAUNCH_SERVICES_WARN_PORTS), true, "the threshold itself warns");
  assert.equal(step(LAUNCH_SERVICES_WARN_PORTS + 1_000), false, "one warning per episode step");
  assert.equal(step(LAUNCH_SERVICES_WARN_PORTS + LAUNCH_SERVICES_REWARN_PORTS - 1), false);
  assert.equal(step(LAUNCH_SERVICES_WARN_PORTS + LAUNCH_SERVICES_REWARN_PORTS), true, "a full step past the last warning warns again");
  assert.equal(step(700), false, "a restarted daemon ends the episode");
  assert.equal(state, null);
  assert.equal(step(LAUNCH_SERVICES_WARN_PORTS + 5), true, "the next climb warns afresh");
});

test("doctor's port check: ok with the count, a warning past the threshold or when unreadable, and nothing to do off macOS", async () => {
  const ok = await checkLaunchServicesPorts(portsProbe(3_144), "darwin");
  assert.deepEqual(ok, { level: "ok", detail: "launchservicesd holds 3144 (warns at 100.0k; macOS kills it near 268.0k)" });
  const high = await checkLaunchServicesPorts(portsProbe(190_000), "darwin");
  assert.deepEqual(high, { level: "warn", detail: launchServicesWarning(190_000) });
  const unreadable = await checkLaunchServicesPorts(portsProbe(null), "darwin");
  assert.equal(unreadable.level, "warn");
  assert.match(unreadable.detail, /^cannot check/);
  const probe = portsProbe(190_000);
  assert.deepEqual(await checkLaunchServicesPorts(probe, "linux"), {
    level: "ok",
    detail: "not macOS — no launchservicesd to watch",
  });
  assert.equal(probe.reads, 0, "off macOS the probe is never asked");
});

test("the fleet's watch samples on its first poll, then at most once per interval, warning through the event feed", async () => {
  const root = tmpdir();
  const probe = portsProbe(120_000, 125_000, 175_000);
  const watch = new LaunchServicesWatch(root, probe);
  const t0 = 1_000_000;
  await watch.poll(t0);
  assert.equal(probe.reads, 1, "the first poll samples at once");
  assert.equal(harnessWarnings(root).length, 1);
  assert.equal(harnessWarnings(root)[0]?.message, launchServicesWarning(120_000));

  await watch.poll(t0 + LAUNCH_SERVICES_SAMPLE_MS - 1);
  assert.equal(probe.reads, 1, "no second sample inside the interval");
  await watch.poll(t0 + LAUNCH_SERVICES_SAMPLE_MS);
  assert.equal(probe.reads, 2);
  assert.equal(harnessWarnings(root).length, 1, "125k is within a step of the 120k warning");
  await watch.poll(t0 + 2 * LAUNCH_SERVICES_SAMPLE_MS);
  assert.equal(probe.reads, 3);
  assert.deepEqual(
    harnessWarnings(root).map((e) => e.message),
    [launchServicesWarning(120_000), launchServicesWarning(175_000)],
  );
});

test("the watch never overlaps samples and stays quiet on an unreadable count", async () => {
  const root = tmpdir();
  let release: (ports: number | null) => void = () => {};
  let reads = 0;
  const probe: ProcessProbe = {
    list: async () => [],
    cwds: async () => new Map(),
    runMarkers: async () => new Map(),
    launchServicesPorts: () => {
      reads++;
      return new Promise((resolve) => (release = resolve));
    },
  };
  const watch = new LaunchServicesWatch(root, probe);
  const first = watch.poll(0);
  await watch.poll(LAUNCH_SERVICES_SAMPLE_MS * 10);
  assert.equal(reads, 1, "a due poll while a sample is in flight starts no second one");
  release(null);
  await first;
  assert.equal(harnessWarnings(root).length, 0, "an unreadable count warns nothing");
});

// The poll's never-rejects contract (the orchestrator fires poll() without awaiting it, so a
// rejection would surface as an unhandled one): a probe that rejects and a warning that
// cannot be written both settle inside poll() — nothing escapes to the caller, and the
// in-flight flag resets so the next due poll still samples.
test("a poll that cannot warn — a rejecting probe, an unwritable events log — still resolves", async () => {
  const t0 = 1_000_000;
  // A probe that rejects: the catch swallows it, and the watch stays usable.
  const exploding = portsProbe(120_000);
  exploding.launchServicesPorts = async () => {
    exploding.reads++;
    throw new Error("ps exploded");
  };
  const broken = new LaunchServicesWatch(tmpdir(), exploding);
  await broken.poll(t0);
  assert.equal(exploding.reads, 1, "the rejecting probe was consulted");
  await broken.poll(t0 + LAUNCH_SERVICES_SAMPLE_MS);
  assert.equal(exploding.reads, 2, "a failed sample resets the in-flight flag, so the next due poll samples");

  // A warning that cannot be written: the events log path occupied by a directory — the
  // class of filesystem damage a crash or a stray tool leaves behind (the same fixture
  // failure-render.test.ts uses). The warnEvent append throws; poll() must absorb it.
  const root = tmpdir();
  fs.mkdirSync(eventsLogPath(root), { recursive: true }); // the log path is a directory now
  const probe = portsProbe(120_000, 120_000);
  const watch = new LaunchServicesWatch(root, probe);
  await watch.poll(t0);
  assert.equal(probe.reads, 1, "the sample ran; only its warning write failed");
  await watch.poll(t0 + LAUNCH_SERVICES_SAMPLE_MS);
  assert.equal(probe.reads, 2, "the failed warning also left the watch sampling on schedule");
  assert.equal(harnessWarnings(root).length, 0, "nothing was logged where the log cannot be written");
});
