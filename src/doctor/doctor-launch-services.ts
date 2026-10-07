/** Doctor's `mach ports` line: a warning at or past launchservicesd's port threshold, a warning
 * when the count cannot be read on macOS, ok otherwise. Never a failure — the fleet runs fine on
 * a leaking Mac; it is the Mac that does not. Split from process/launch-services.ts (2026-10-07,
 * organize) so the doctor's environment checks live together (doctor-orphans.ts reads the process
 * table the same way) and the process layer no longer imports the doctor's report contract. The
 * launchservicesd facts this reads — the thresholds and the warning text — stay in
 * src/process/launch-services.ts, shared with the running fleet's watch. `platform` is a
 * parameter so the macOS branches are testable on any host. */

import type { CheckOutcome } from "./doctor-checks.js";
import { type ProcessProbe, systemProcessProbe } from "../process/process-table.js";
import {
  LAUNCH_SERVICES_KILL_PORTS,
  LAUNCH_SERVICES_WARN_PORTS,
  launchServicesWarning,
} from "../process/launch-services.js";
import { compactTokens } from "../text/format.js";

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
