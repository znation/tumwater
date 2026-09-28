import fs from "node:fs";
import type { BuildStatus } from "./build-info.js";
import type { FallbackDemotion } from "./budget.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { ensureParentDir, removeQuiet } from "./files.js";
import { pidAlive } from "./process.js";
import { withSyncLock } from "./lock.js";
import { orchestratorStatePath, pausedPath, pausedRolesLockPath, pausedRolesPath } from "./paths.js";

/** True while the operator has paused the fleet (`tumwater pause` wrote its marker). The
 * marker is persistent state, not a one-shot request: presence means paused until `resume`
 * removes it — pausing before startup starts an already-paused fleet. Never throws (a missing
 * .tumwater/ reads false). Lives here because both the scheduler and every observer must
 * evaluate it from disk without importing each other's modules — the same "single
 * definition" rule that put the daily-cost budget in src/budget.ts. */
export function isFleetPaused(root: string): boolean {
  return standingMarker(pausedPath(root)) !== null;
}

/** The body shape of both pause markers: the write instant plus, for a timed pause
 * (`tumwater pause [--role <id>] --for <duration>`), the ms-epoch deadline. One shared
 * deadline per marker — a set is paused or it is not, and each new pause write carries its
 * own `until` (the last write winning), so per-role deadlines would buy a map plus per-role
 * transition logic for no observed need. */
interface PauseMarker {
  at: number;
  until?: number;
}

/** Read a pause marker as the standing pause it represents: null when the file is missing,
 * unreadable, or carries an `until` in the past. The expiry rule is the read side of the
 * timed pause: every consumer (scheduler, dashboards, a follow-up `pause`) treats an expired
 * marker as absent, so the deadline releases the pause with no new scheduler code — the
 * orchestrator's poll-diff sees an ordinary unpaused transition. Never throws. */
function standingMarker(path: string): PauseMarker | null {
  const m = readJsonFile<PauseMarker>(path);
  if (!m || typeof m.at !== "number") return null;
  if (m.until !== undefined && m.until <= Date.now()) return null;
  return m;
}

/** The fleet marker's standing deadline (ms epoch) while a timed pause holds; undefined when
 * the fleet is not timed-paused — no marker, an indefinite `pause` (no `until`), or an expired
 * `until` (standingMarker already reads that as unpaused, so the field cannot outlive the
 * pause it describes). Fleet-scoped on purpose: the FLEET marker's deadline is what a header
 * badge may claim, since only it covers the whole fleet. Lives here beside isFleetPaused —
 * one module for every marker consumer. */
export function pausedUntil(root: string): number | undefined {
  return standingMarker(pausedPath(root))?.until;
}

/** Pause the fleet by writing its marker, the writer half of isFleetPaused's contract; the
 * marker format ({ at: number }, pretty-printed JSON) is the one `tumwater pause` has always
 * written. Returns whether this call changed state: false when the marker already existed, so
 * the CLI can report "already paused" and the dashboard's toggle stays idempotent. Lives here
 * beside isFleetPaused so the producer (CLI, GUI) and every consumer read the same path. */
export function pauseFleet(root: string, untilMs?: number): boolean {
  const marker = pausedPath(root);
  // An already-standing pause is the idempotent no-op it has always been — except under a
  // fresh `--for`, which overwrites the deadline (extend or shorten): the operator asked for
  // a timed pause, not for a no-op. An expired marker is not standing (standingMarker), so a
  // pause after expiry reports a fresh pause, never the stale "already paused".
  const standing = standingMarker(marker);
  if (standing && untilMs === undefined) return false;
  writeJsonAtomic(marker, untilMs === undefined ? { at: Date.now() } : { at: Date.now(), until: untilMs });
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
  const state = readJsonFile<{ roles: unknown; at: number; until?: number }>(pausedRolesPath(root));
  if (!state || (state.until !== undefined && state.until <= Date.now())) return [];
  return Array.isArray(state.roles)
    ? state.roles.filter((r): r is string => typeof r === "string")
    : [];
}

/** The paused-roles marker is structured state several processes rewrite read-modify-write
 * (the CLI's pause/resume --role and the dashboard's per-row toggle are separate processes),
 * and writeJsonAtomic's last-writer-wins policy — correct for overwrite-style state — silently
 * drops one caller's pause when two whole-set writes race. These writers therefore serialize
 * through withSyncLock (src/lock.ts), the same mkdir-and-pid mutex the merge path uses, so the
 * crash-recovery rules (dead pid, no-pid grace, age) and the ownership-checked release are the
 * tested ones rather than a second hand-rolled lockfile protocol. A lock that cannot be
 * acquired within PAUSED_ROLES_LOCK_TIMEOUT_MS throws rather than writing unlocked — a pause
 * that silently fails to hold is worse than a pause that reports an error. The bound is long
 * enough to out-wait the no-pid grace that recovers a creator crashed mid-acquire, short
 * enough that a wedged holder costs an operator command seconds, not minutes. */
const PAUSED_ROLES_LOCK_TIMEOUT_MS = 10_000;

/** Run `fn` while holding the exclusive cross-process lock on the paused-roles marker. */
function withPausedRolesLock<T>(root: string, fn: () => T): T {
  const lock = pausedRolesLockPath(root);
  ensureParentDir(lock); // pause/resume may run before any marker write has made the state dir.
  return withSyncLock(lock, fn, PAUSED_ROLES_LOCK_TIMEOUT_MS);
}

/** Pause one role by adding it to the paused-roles marker; returns whether this call changed
 * state (false when the role was already paused — idempotent like pauseFleet, so the CLI and
 * a dashboard toggle can report "already paused"). Custom-loop ids are stored verbatim: the
 * marker must survive config edits, which is why callers resolve built-in ids without
 * touching tumwater.json (namedRole in src/operator-commands.ts). */
export function pauseRole(root: string, role: string, untilMs?: number): boolean {
  return withPausedRolesLock(root, () => {
    const path = pausedRolesPath(root);
    // pausedRoles already reads an expired marker as the empty set, so a pause after expiry
    // starts a fresh set (the expired members auto-resumed; re-listing them would re-pause
    // roles the operator's deadline already released) and reports a fresh pause.
    const current = pausedRoles(root);
    if (current.includes(role)) {
      if (untilMs === undefined) return false;
      // The deadline is the marker's one shared field: a fresh `--for` overwrites it —
      // extend or shorten — rather than no-oping behind "already paused".
      writeJsonAtomic(path, { roles: current, at: Date.now(), until: untilMs });
      return true;
    }
    writeJsonAtomic(path, untilMs === undefined ? { roles: [...current, role], at: Date.now() } : { roles: [...current, role], at: Date.now(), until: untilMs });
    return true;
  });
}

/** Resume one role by removing it from the paused-roles marker; returns whether it was there
 * to lift (resume's changed-state contract, mirroring resumeFleet). The last removal deletes
 * the file outright, so a fully-resumed fleet leaves no marker behind for observers to read. */
export function resumeRole(root: string, role: string): boolean {
  return withPausedRolesLock(root, () => {
    const current = pausedRoles(root);
    if (!current.includes(role)) return false;
    const remaining = current.filter((r) => r !== role);
    if (remaining.length === 0) removeQuiet(pausedRolesPath(root));
    else writeJsonAtomic(pausedRolesPath(root), { roles: remaining, at: Date.now() });
    return true;
  });
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
