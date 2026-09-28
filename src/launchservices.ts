/** launchservicesd's Mach-port budget on macOS: doctor's `mach ports` line and a running fleet's
 * warning. The daemon keeps a port for every process that ever checked in with LaunchServices
 * and never releases it, and the kernel kills it near LAUNCH_SERVICES_KILL_PORTS — after which
 * the GUI session wedges (apps cannot quit, Finder disappears) until a forced power-off. On
 * 2026-09-25 that took down the Mac running the fleet after twelve days of growth that only the
 * unified log mentioned (BUGS.md 2026-09-28). The harness's own process trees no longer check in
 * (process.ts's NO_LAUNCH_SERVICES_CHECK_IN), but anything else on the Mac can: an npm run by
 * hand, an older build, another tool. This module says so where an operator looks, days ahead.
 * Dependency direction: doctor and orchestrator → launchservices → process (the probe). */

import type { CheckOutcome } from "./doctor-report.js";
import { warnEvent } from "./events.js";
import { type ProcessProbe, systemProcessProbe } from "./process.js";
import { compactTokens } from "./text.js";

/** Where the kernel killed launchservicesd on 2026-09-25 (termination reason OS_REASON_PORT_SPACE
 * at 267,967 ports) — what the warning counts toward. */
const LAUNCH_SERVICES_KILL_PORTS = 268_000;

/** Warn from here. macOS logs its own "Excessive number of mach_ports" fault from ~28K, too early
 * to act on; 100K still leaves days at the fastest growth seen (~7.5K ports an hour). */
export const LAUNCH_SERVICES_WARN_PORTS = 100_000;

/** A running fleet warns again each time the count climbs this far past its last warning: one
 * line at 100K is easy to scroll past on a fleet that runs for weeks. */
export const LAUNCH_SERVICES_REWARN_PORTS = 50_000;

/** How often a running fleet samples the count: `top` costs ~0.3 s of CPU, and 15 minutes at the
 * fastest growth seen moves the count by ~2K — noise against the margin. */
export const LAUNCH_SERVICES_SAMPLE_MS = 15 * 60_000;

/** The warning both surfaces print: the count, the ceiling, the consequence and the remedy. Only a
 * restart helps — launchservicesd is a system daemon, so logging out does not reset it. */
export function launchServicesWarning(ports: number): string {
  return `launchservicesd holds ${compactTokens(ports)} Mach ports and macOS kills it near ${compactTokens(LAUNCH_SERVICES_KILL_PORTS)}, which wedges the GUI session — restart the Mac before then (processes that register with LaunchServices, such as Node programs that set process.title, leak one port each)`;
}

/** Doctor's `mach ports` line: a warning at or past LAUNCH_SERVICES_WARN_PORTS, a warning when the
 * count cannot be read on macOS, ok otherwise. Never a failure — the fleet runs fine on a leaking
 * Mac; it is the Mac that does not. `platform` is a parameter so the macOS branches are testable
 * on any host. */
export async function checkLaunchServicesPorts(
  probe: ProcessProbe = systemProcessProbe,
  platform: NodeJS.Platform = process.platform,
): Promise<CheckOutcome> {
  if (platform !== "darwin") return { level: "ok", detail: "not macOS — no launchservicesd to watch" };
  const ports = await probe.launchServicesPorts();
  if (ports === null) return { level: "warn", detail: "cannot check — top reported no launchservicesd port count" };
  if (ports >= LAUNCH_SERVICES_WARN_PORTS) return { level: "warn", detail: launchServicesWarning(ports) };
  return {
    level: "ok",
    detail: `launchservicesd holds ${compactTokens(ports)} (warns at ${compactTokens(LAUNCH_SERVICES_WARN_PORTS)}; macOS kills it near ${compactTokens(LAUNCH_SERVICES_KILL_PORTS)})`,
  };
}

/** Whether a sample warns, and the episode's new last-warned count: the first sample at or past
 * LAUNCH_SERVICES_WARN_PORTS warns, then each one LAUNCH_SERVICES_REWARN_PORTS past the last
 * warning. A count back under the threshold means launchservicesd restarted, which ends the
 * episode (null). Pure, so the rules are pinned without a real Mac. */
export function nextLaunchServicesWarning(
  lastWarned: number | null,
  ports: number,
): { warn: boolean; lastWarned: number | null } {
  if (ports < LAUNCH_SERVICES_WARN_PORTS) return { warn: false, lastWarned: null };
  if (lastWarned !== null && ports < lastWarned + LAUNCH_SERVICES_REWARN_PORTS) return { warn: false, lastWarned };
  return { warn: true, lastWarned: ports };
}

/** A running fleet's watch, stepped from the orchestrator's poll: it samples at most every
 * LAUNCH_SERVICES_SAMPLE_MS — the first poll samples at once, so a fleet started on a Mac that
 * is already leaking says so right away — and logs a harness warning per
 * nextLaunchServicesWarning. The sample runs in the background: a poll never waits on `top`.
 * In memory only: a restarted fleet warns again on its first sample if the count is still high,
 * the right default for a condition only a reboot clears. cli-run.ts builds one for a daemon
 * `tumwater run` only — a `--once` round and in-process tests run without it. */
export class LaunchServicesWatch {
  private nextSampleAt = 0;
  private sampling = false;
  private lastWarned: number | null = null;

  constructor(
    private readonly root: string,
    private readonly probe: ProcessProbe = systemProcessProbe,
  ) {}

  /** Start a sample when one is due and none is running. Resolves when that sample has been
   * handled (at once when none started) and never rejects: the orchestrator does not await it,
   * tests do. */
  async poll(now: number = Date.now()): Promise<void> {
    if (this.sampling || now < this.nextSampleAt) return;
    this.nextSampleAt = now + LAUNCH_SERVICES_SAMPLE_MS;
    this.sampling = true;
    try {
      const ports = await this.probe.launchServicesPorts();
      if (ports === null) return;
      const next = nextLaunchServicesWarning(this.lastWarned, ports);
      this.lastWarned = next.lastWarned;
      if (next.warn) warnEvent(this.root, "harness", launchServicesWarning(ports));
    } catch {
      // The probe never rejects; an events log that cannot be written leaves nothing to do.
    } finally {
      this.sampling = false;
    }
  }
}
