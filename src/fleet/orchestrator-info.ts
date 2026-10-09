import type { BuildStatus } from "../build/build-info.js";
import type { FallbackDemotion } from "../budget/fallback-breaker.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { pidAlive } from "../process/process.js";
import { orchestratorStatePath } from "../paths.js";

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving the
 * fleet, since when, with which roles, and what its most recent poll published about the world
 * (build staleness, the daily budget, engaged fallback demotions, the disk floor). The
 * orchestrator writes it (writeOrchestratorInfo); the separate-process observers — status, TUI,
 * GUI, doctor, and the second-fleet refusal — read it here so they never depend on the scheduler
 * module itself. The operator pause markers are the other fleet-state domain and live beside
 * this one in fleet-state.ts; this module owns the info file alone. */

/** The disk floor's published state (plans/disk-floor.md, part 4/4): what the orchestrator
 * measured on its most recent poll, so observers (status, TUI, GUI) show the same facts
 * without calling statfs themselves. `freeGB` is rounded to one decimal; `held` is the hold's
 * verdict; `lastReclaim` names the most recent pressure pass that cleaned anything, absent
 * until one has. Published only when it changes; absent when statfs cannot measure the volume
 * or on an older orchestrator. */
export interface DiskStatus {
  freeGB: number;
  holdGB: number;
  reclaimGB: number;
  held: boolean;
  lastReclaim?: { at: number; mode: "pressure" | "idle" | "manual"; freedGB: number };
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving
 * the fleet, since when, and with which roles. Written by runOrchestrator; read here so
 * observers (status, TUI, GUI) never depend on the scheduler module itself. */
export interface OrchestratorInfo {
  pid: number;
  startedAt: number;
  roles: string[];
  /** The running build's stamp and staleness (src/build/build-info.ts); absent when dist/ carries
   * no stamp. Written at start and refreshed by the orchestrator whenever main moves, so observers
   * read one file instead of running git themselves. */
  build?: BuildStatus;
  /** Present while the budget gate's fallback breaker (src/budget/fallback-breaker.ts) holds the
   * configured free fallback demoted: the cap is reached and the pair is priced at zero, but its
   * backend failed the breaker's failureLimit consecutive role ticks, so the scheduler reads the
   * gate as
   * `paused`. Observers must show that instead of the `fallback` the price alone implies.
   * Written by the orchestrator whenever the demotion changes; absent otherwise. */
  fallbackDemoted?: FallbackDemotion;
  /** Every fallback pair's standing demotion, keyed by pair name (part 5c/8): a per-tier
   * fallback can demote a pair the legacy single `fallback` never engages, and the dashboards
   * must show the tier's roles held exactly while the scheduler holds them. Written whenever
   * any breaker's demotion changes; absent when none stands. */
  fallbackDemotions?: Record<string, FallbackDemotion>;
  /** The daily cost budget gate's own figures from the most recent poll
   * (src/gates/budget-gates.ts): today's spend summed over the runners' LIVE in-memory states —
   * charged run-by-run as each pi run folds, not only at the tick-end save — against the
   * cap it was
   * evaluated under. Published whenever it changes so observers (src/status/status-data.ts) can
   * show what the scheduler
   * is actually enforcing; a stopped fleet removes this file at exit, so the absence of a
   * running orchestrator means no published figure exists and the persisted sum is final.
   * Written by the orchestrator whenever the pair changes; absent otherwise. */
  budget?: { spentUsd: number; capUsd: number };
  /** The disk floor's most recent measurement (plans/disk-floor.md, part 4/4): free space,
   * the configured floor and reclaim threshold, whether the hold is on, and the last reclaim
   * pass. Written by the orchestrator's poll whenever it changes; absent when statfs cannot
   * measure the volume or on an older orchestrator, which renders exactly as before. */
  disk?: DiskStatus;
}

/** Assign one field of the orchestrator info file in place, but only when the value differs
 * from what it already carries, and report whether it changed. This is the shared rule for the
 * fields observers cannot recompute (build, budget, fallback demotions, disk): an unchanged
 * poll leaves the file untouched, while a changed one stages the value so the caller can write
 * once after several fields. The comparison uses JSON serialization, matching
 * writeOrchestratorInfo's
 * own output, so a value equal to the stored one is never treated as a change. */
export function assignInfoFieldIfChanged<K extends keyof OrchestratorInfo>(
  info: OrchestratorInfo,
  field: K,
  value: OrchestratorInfo[K],
): boolean {
  if (JSON.stringify(value) === JSON.stringify(info[field])) return false;
  info[field] = value;
  return true;
}

/** Read the running orchestrator's info file; null when it is missing or unreadable.
 * Never throws — a torn write (e.g. a crash mid-write) must not take down observers
 * that poll this every second (TUI, GUI, status). */
export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  return readJsonFile<OrchestratorInfo>(orchestratorStatePath(root));
}

/** Publish the running orchestrator's info file atomically (writeJsonAtomic's tmp + rename).
 * The only writer of that path, so a process killed mid-write — the orchestrator's own poll
 * publishes budget/disk/build changes while `tumwater run` in another terminal reads it to
 * refuse a second fleet — leaves either the previous complete file or the new one, never a
 * torn body that readOrchestratorInfo reports as no running orchestrator. */
export function writeOrchestratorInfo(root: string, info: OrchestratorInfo): void {
  writeJsonAtomic(orchestratorStatePath(root), info);
}

/** True when the recorded orchestrator's pid is still alive (see pidAlive). Callers that have
 * already loaded the info file may pass it in to avoid a second read — snapshot() loads it once
 * per poll and uses it for both the displayed pid and this liveness check. */
export function orchestratorAlive(root: string, info?: OrchestratorInfo | null): boolean {
  const i = info ?? readOrchestratorInfo(root);
  if (!i) return false;
  return pidAlive(i.pid);
}
