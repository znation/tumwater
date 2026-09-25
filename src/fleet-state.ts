import fs from "node:fs";
import type { BuildStatus } from "./build-info.js";
import type { FallbackDemotion } from "./budget.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { removeQuiet } from "./files.js";
import { pidAlive } from "./process.js";
import { orchestratorStatePath, pausedPath, pausedRolesPath } from "./paths.js";

/** True while the operator has paused the fleet (`tumwater pause` wrote its marker). The
 * marker is persistent state, not a one-shot request: presence means paused until `resume`
 * removes it — pausing before startup starts an already-paused fleet. Never throws (a missing
 * .tumwater/ reads false). Lives here because both the scheduler and every observer must
 * evaluate it from disk without importing each other's modules — the same "single
 * definition" rule that put the daily-cost budget in src/budget.ts. */
export function isFleetPaused(root: string): boolean {
  return fs.existsSync(pausedPath(root));
}

/** Pause the fleet by writing its marker, the writer half of isFleetPaused's contract; the
 * marker format ({ at: number }, pretty-printed JSON) is the one `tumwater pause` has always
 * written. Returns whether this call changed state: false when the marker already existed, so
 * the CLI can report "already paused" and the dashboard's toggle stays idempotent. Lives here
 * beside isFleetPaused so the producer (CLI, GUI) and every consumer read the same path. */
export function pauseFleet(root: string): boolean {
  const marker = pausedPath(root);
  if (fs.existsSync(marker)) return false;
  writeJsonAtomic(marker, { at: Date.now() });
  return true;
}

/** Resume the fleet by removing its marker (a no-op if absent); returns whether a marker was
 * there to lift, mirroring pauseFleet's changed-state contract. Uses removeQuiet's
 * never-throws delete: a marker vanishing between the check and the unlink is success, not a
 * failure worth surfacing from a toggle. */
export function resumeFleet(root: string): boolean {
  const marker = pausedPath(root);
  if (!fs.existsSync(marker)) return false;
  removeQuiet(marker);
  return true;
}

/** The roles the operator has individually paused (`tumwater pause --role <id>`): a role in
 * this set starts no new ticks — in-flight ones finish, every other role keeps ticking, the
 * director included (the operator named it deliberately). Never throws, like isFleetPaused:
 * a missing or unreadable file reads as no paused roles, so observers (scheduler, dashboards)
 * can poll it every cycle without a guard. Lives here beside pauseFleet for the same
 * single-definition reason: producer (CLI, GUI) and every consumer read one module. */
export function pausedRoles(root: string): string[] {
  const state = readJsonFile<{ roles: unknown; at: number }>(pausedRolesPath(root));
  return Array.isArray(state?.roles)
    ? state.roles.filter((r): r is string => typeof r === "string")
    : [];
}

/** Pause one role by adding it to the paused-roles marker; returns whether this call changed
 * state (false when the role was already paused — idempotent like pauseFleet, so the CLI and
 * a dashboard toggle can report "already paused"). Custom-loop ids are stored verbatim: the
 * marker must survive config edits, which is why callers resolve built-in ids without
 * touching tumwater.json (namedRole in src/operator-commands.ts). */
export function pauseRole(root: string, role: string): boolean {
  const current = pausedRoles(root);
  if (current.includes(role)) return false;
  writeJsonAtomic(pausedRolesPath(root), { roles: [...current, role], at: Date.now() });
  return true;
}

/** Resume one role by removing it from the paused-roles marker; returns whether it was there
 * to lift (resume's changed-state contract, mirroring resumeFleet). The last removal deletes
 * the file outright, so a fully-resumed fleet leaves no marker behind for observers to read. */
export function resumeRole(root: string, role: string): boolean {
  const current = pausedRoles(root);
  if (!current.includes(role)) return false;
  const remaining = current.filter((r) => r !== role);
  if (remaining.length === 0) removeQuiet(pausedRolesPath(root));
  else writeJsonAtomic(pausedRolesPath(root), { roles: remaining, at: Date.now() });
  return true;
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving
 * the fleet, since when, and with which roles. Written by runOrchestrator; read here so
 * observers (status, TUI, GUI) never depend on the scheduler module itself. */
export interface OrchestratorInfo {
  pid: number;
  startedAt: number;
  roles: string[];
  /** The running build's stamp and staleness (src/build-info.ts); absent when dist/ carries no
   * stamp. Written at start and refreshed by the orchestrator whenever main moves, so observers
   * read one file instead of running git themselves. */
  build?: BuildStatus;
  /** Present while the budget gate's fallback breaker (src/budget.ts) holds the configured free
   * fallback demoted: the cap is reached and the pair is priced at zero, but its backend failed
   * the breaker's failureLimit consecutive role ticks, so the scheduler reads the gate as
   * `paused`. Observers must show that instead of the `fallback` the price alone implies.
   * Written by the orchestrator whenever the demotion changes; absent otherwise. */
  fallbackDemoted?: FallbackDemotion;
}

/** Read the running orchestrator's info file; null when it is missing or unreadable.
 * Never throws — a torn write (e.g. a crash mid-write) must not take down observers
 * that poll this every second (TUI, GUI, status). */
export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  return readJsonFile<OrchestratorInfo>(orchestratorStatePath(root));
}

/** True when the recorded orchestrator's pid is still alive (see pidAlive). Callers that have
 * already loaded the info file may pass it in to avoid a second read — snapshot() loads it once
 * per poll and uses it for both the displayed pid and this liveness check. */
export function orchestratorAlive(root: string, info?: OrchestratorInfo | null): boolean {
  const i = info ?? readOrchestratorInfo(root);
  if (!i) return false;
  return pidAlive(i.pid);
}
