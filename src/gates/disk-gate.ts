/** The disk floor's hold (plans/disk-floor.md, "Disk floor 1/4"): when the volume the harness
 * worktrees live on runs low on free space, the fleet starts no new work — role ticks, the
 * director, landing vets and merges — so a fleet of build-heavy checkouts cannot fill the
 * disk. The syscall, the hold's hysteresis, and the edge-triggered `disk_low`/`disk_ok`
 * events live here; the orchestrator owns only the wiring, exactly like the quiet-hours and
 * pause gates. Part 2/4 reclaims build outputs so the hold rarely engages; this part turns
 * "disk full" into "fleet held, with a notification". In-flight work runs on — killing it
 * wastes the work without freeing anything a finished run would not free anyway.
 *
 * The measurement is deliberately language-agnostic: `fs.statfsSync` reports the bytes an
 * unprivileged user can still write, whatever the project builds. */

import fs from "node:fs";
import { worktreesDir } from "../paths.js";
import { logEvent, warnEvent } from "../events/events.js";

/** GB means 10^9 bytes everywhere — in config and in display (plans/disk-floor.md). Exported
 * so doctor's detail renders the same unit the gate holds on. */
export const BYTES_PER_GB = 1_000_000_000;

/** How far free space must climb back ABOVE `diskHoldGB` before the hold lifts. Without it a
 * fleet hovering at the line would flap in and out of the hold every poll. */
export const DISK_HOLD_HYSTERESIS_GB = 5;

/** A synchronous statfs call, shaped so tests can inject a fixed sample. `fs.statfsSync`'s
 * own overloads return a bigint variant too; the sampler below narrows to the number form. */
export type StatfsLike = (path: fs.PathLike) => fs.StatsFs;

/** The volume the fleet's builds write to: the worktrees dir once it exists, else the root
 * (a fleet that has not created a worktree yet measures the checkout's own volume). One home
 * of the choice so the sampler and doctor's detail name the same path. */
export function diskVolumePath(root: string): string {
  const worktrees = worktreesDir(root);
  return fs.existsSync(worktrees) ? worktrees : root;
}

/** Free bytes available to an unprivileged user on the volume the fleet builds on, or null
 * when statfs throws (an unsupported platform or filesystem). A null sample never holds —
 * the fleet keeps running rather than freezing on a measurement it cannot make. */
export function sampleFreeBytes(
  root: string,
  statfs: StatfsLike = (p) => fs.statfsSync(p) as fs.StatsFs,
): number | null {
  try {
    const stats = statfs(diskVolumePath(root));
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** The disk gate's cross-poll memory: the previous hold so each crossing logs exactly one
 * event instead of once per ~2s poll, and whether the unmeasurable warning has fired (one per
 * process — a platform that cannot measure would otherwise warn every poll). In memory only:
 * a restart re-measures and can re-log at most one event per crossing. */
export interface DiskGateState {
  prevHeld: boolean;
  warnedUnmeasurable: boolean;
}

/** A fresh gate state: not held, warning unspent — so the first poll of a fleet with room
 * logs nothing. */
export function newDiskGateState(): DiskGateState {
  return { prevHeld: false, warnedUnmeasurable: false };
}

/** Poll the disk gate for one orchestrator cycle: with `freeBytes` in hand, decide the hold
 * (edge-triggered with `DISK_HOLD_HYSTERESIS_GB` of hysteresis) and log exactly one
 * `disk_low` / `disk_ok` event per crossing. `holdGB` 0 disables the hold outright: a fleet
 * with the key set to 0 never holds, and a live edit to 0 lifts an active hold on the next
 * poll (with its one `disk_ok`). A null sample (statfs threw) logs one `warning` per process
 * and never holds. `waitForReclaim` defers ENTERING the hold while part 2/4's pressure reclaim
 * is still running: the hold may engage only once a pass has settled. It never lifts an
 * already-active hold (that is the hysteresis band's job). Returns whether the disk is holding
 * new work right now. */
export function pollDiskGate(
  root: string,
  freeBytes: number | null,
  holdGB: number,
  state: DiskGateState,
  waitForReclaim = false,
): boolean {
  if (freeBytes === null) {
    if (!state.warnedUnmeasurable) {
      state.warnedUnmeasurable = true;
      warnEvent(
        root,
        "harness",
        "cannot measure free disk space (statfs failed) — the disk hold is off for this process",
      );
    }
    state.prevHeld = false;
    return false;
  }
  const freeGB = freeBytes / BYTES_PER_GB;
  // `holdGB <= 0` first so 0 wins over the previous hold: a live edit to 0 must lift an
  // active hold, not keep it while free space sits inside the old hysteresis band.
  const held =
    holdGB <= 0
      ? false
      : state.prevHeld
        ? freeGB < holdGB + DISK_HOLD_HYSTERESIS_GB // in the hold: leave only clear of the band
        : freeGB < holdGB && !waitForReclaim; // out of it: enter below the floor, once reclaim settled
  if (held !== state.prevHeld) {
    state.prevHeld = held;
    logEvent(
      root,
      held
        ? { loop: "harness", type: "disk_low", freeGB, holdGB }
        : { loop: "harness", type: "disk_ok", freeGB },
    );
  }
  return held;
}
