import { asTestCounts, type TestCounts } from "../build/build-check-counts.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { isLandingChange, type LandingInFlight } from "../landing/landing-slot.js";
import { defaultConfig, loadConfigCached } from "../config/config.js";
import { DEFAULT_EVENT_TAIL, readEvents } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { currentBranchFromHeadFile, readBranchHead, targetBranch } from "../git/git.js";
import { freshLoopState, loadLoopState, type LoopState } from "../loop/loop-state.js";
import { eventsLogPath, statePath } from "../paths.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";

/** The per-poll cached readers behind status/status-data.ts's snapshot(): one poll's view of the
 * three inputs that cost real reads — main's newest merge-scope build check (a stat-cached
 * event-tail scan with its own grown-full memo), the config to display against (stat-keyed, with a
 * last-known-good fallback so a transiently broken tumwater.json never blinds an observer),
 * and each role's loop state (stat-keyed, copied per poll). Split out of status/status-data.ts —
 * which keeps the StatusSnapshot contract and the snapshot assembly — so the contract file
 * carries no module-level cache state of its own. Lives beside it in src/: pure data
 * collection, no presentation concern. */

/** The mainCheck field's shape (StatusSnapshot's contract): a runner summary block as the
 * build_check event carries it (build/build-check-events.ts spreads the outcome's counts through).
 * TestCounts is parseTestCounts's exported type, single-homed in build/build-check-counts.ts beside
 * its parser. Structurally checked on read (asTestCounts in build/build-check-counts.ts): the event
 * log is loose-typed. */
export interface MainCheckStatus {
  sha?: string;
  status: "passed" | "failed" | "skipped";
  counts?: TestCounts;
  at: number;
}

/** How far mainCheckForPoll may grow its event tail. The per-poll default
 * (event-read.ts's DEFAULT_EVENT_TAIL) covers a healthy fleet — a merge-scope check rides
 * every landing and every redeploy — but a burst of quiet or failing ticks logs hundreds
 * of events without moving main, and a tail
 * that ends before the last check makes the header badge vanish and reappear as ticks tick
 * by. Growing until the check is found keeps "absent" meaning what the field's contract says
 * (no merge-scope check has run) rather than "the window ended"; the cap keeps the worst
 * per-poll scan bounded — readTailText reads bytes proportional to the line count, and the scan
 * runs only when events.jsonl changes, so it stays below history's one-ask bound
 * (HISTORY_SCAN_MAX_EVENTS, 20k).
 * Past the cap the badge drops, the same graceful loss log rotation already imposes. */
const MAIN_CHECK_SCAN_MAX_EVENTS = 5_000;

/** Per-root note that the previous scan had to grow past the default event tail
 * (DEFAULT_EVENT_TAIL) without finding a merge-scope check. A check rides every landing, so a poll
 * that grew all the way to the cap is a burst of quiet or failing ticks — hundreds of events
 * between landings — and the next poll's growth starts straight at the cap instead of re-scanning
 * the ×4 ladder's intermediate windows (200→800→3200→5000 ≈ 9.2k re-parsed events per
 * fresh tail, vs 5.2k for 200→cap; measured on a 6k-event check-free log, ~2.3 ms → ~1.2 ms per
 * append+poll). A poll that finds a check clears the note, so the ordinary find-in-200 /
 * find-in-800 path pays the same small windows as before. In-memory only: a wrong guess costs the
 * ladder it skipped, never a wrong verdict — every window's scan is complete for its size. */
const mainCheckGrewFull = new Set<string>();
const MAIN_CHECK_FULL_SET_MAX = 64;

/** The log-derived half of the mainCheck derivation: the newest merge-scope build_check and
 * the landed commits bracketing it — everything the field needs that depends only on the
 * event log. Split out so it can be cached per events.jsonl stat: the scan (the tail ladder,
 * its re-parses, and the landed collection) is a pure function of the log content, while the
 * sha's branch fallback (readBranchHead/currentBranchFromHeadFile) and the config's
 * baseBranch stay per call, so a checkout or a config edit is still observed on the next
 * poll. */
interface MainCheckScan {
  /** The newest merge-scope check in the tail, or undefined when none is within the cap (or
   * the newest one found is malformed). */
  check?: HarnessEvent;
  /** The newest landed commit before or at the check's ts — the fallback when nothing landed
   * after it. */
  landedBeforeCommit?: string;
  /** The newest landed commit after the check's ts — the sha the check verified. */
  landedAfterCommit?: string;
}

/** Per-root scan cache (stat-cache.cachedByStat): both dashboards poll snapshot every second,
 * but events.jsonl is written only at tick boundaries and landings, so an unchanged log serves
 * the whole scan from one stat instead of re-listing the ladder, re-parsing its windows, and
 * re-collecting the landed events. Rotation swaps the inode and every append changes the size,
 * so both invalidate through the same freshness check; keyed by root so distinct repos never
 * collide. Bounded inside cachedByStat. */
const mainCheckScanCache = new Map<string, StatKeyedValue<MainCheckScan>>();

/** Scan the log for MainCheckScan, growing the tail until a merge-scope check is inside it (see
 * MAIN_CHECK_SCAN_MAX_EVENTS): a check older than the default tail must still badge the header,
 * and every event after the check — the landed pairing the sha needs — is newer, so one window
 * holds the whole derivation. */
function scanMainCheck(root: string): MainCheckScan {
  let check: HarnessEvent | undefined;
  // The final window's landed events, in scan order — collected in the same pass that
  // finds the check instead of a second full scan of the window below.
  let landed: HarnessEvent[] = [];
  const grewFull = mainCheckGrewFull.has(root);
  // A set note means the previous scan reached the cap without finding a check, so start
  // there: starting at DEFAULT_EVENT_TAIL would only re-read (and re-parse on a cache miss)
  // a window the next step discards. This is what the note's "starts straight at the cap"
  // promises; the update keeps a non-set scan on the ×4 ladder it has always used.
  for (
    let window = grewFull ? MAIN_CHECK_SCAN_MAX_EVENTS : DEFAULT_EVENT_TAIL;
    ;
    window = grewFull ? MAIN_CHECK_SCAN_MAX_EVENTS : Math.min(window * 4, MAIN_CHECK_SCAN_MAX_EVENTS)
  ) {
    const events = readEvents(root, window);
    check = undefined;
    landed = [];
    // One pass collects both facts the derivation needs: the newest merge-scope check and
    // every landed event. The landings are re-read against the check's ts below — a pass
    // over the landings alone, not a second pass over every event in the window.
    for (const e of events) {
      if (e.type === "build_check" && (e.scope === "landing" || e.scope === "batch" || e.scope === "baseline")) {
        check = e;
      } else if (e.type === "landed" && typeof e.ts === "number") {
        landed.push(e);
      }
    }
    // Found, the log is shorter than the window (nothing older exists to find), or the cap
    // is reached: the tail is final. A stale `check` from a previous, smaller window cannot
    // happen — each iteration rescans from scratch, and a later window's scan sees every
    // event the smaller one did.
    if (check || events.length < window || window >= MAIN_CHECK_SCAN_MAX_EVENTS) break;
  }
  if (mainCheckGrewFull.size >= MAIN_CHECK_FULL_SET_MAX) mainCheckGrewFull.clear();
  if (check) mainCheckGrewFull.delete(root);
  else mainCheckGrewFull.add(root);
  if (!check || typeof check.ts !== "number" || typeof check.status !== "string") {
    return { check: undefined };
  }
  let landedAfter: HarnessEvent | undefined;
  let landedBefore: HarnessEvent | undefined;
  for (const e of landed) {
    if (e.ts > check.ts) landedAfter = e;
    else landedBefore = e;
  }
  return {
    check,
    ...(typeof landedAfter?.commit === "string" ? { landedAfterCommit: landedAfter.commit } : {}),
    ...(typeof landedBefore?.commit === "string" ? { landedBeforeCommit: landedBefore.commit } : {}),
  };
}

/** The cached scan for `root`, computing it through scanMainCheck on a cache miss. The clone
 * copies the one check event and the record, so a caller never receives the cached object
 * itself. */
function mainCheckScanFor(root: string): MainCheckScan {
  return (
    cachedByStat(
      mainCheckScanCache,
      root,
      eventsLogPath(root),
      () => scanMainCheck(root),
      (v) => ({ ...v, ...(v.check ? { check: { ...v.check } } : {}) }),
    ) ?? { check: undefined }
  );
}

/** The newest merge-scope build_check in the event tail, with the main sha it verified
 * (mainCheck's derivation — see the field's comment). A gate-scope check is excluded: it
 * verified a role worktree, not main. The log-derived scan is stat-cached per events.jsonl
 * (mainCheckScanFor); only the branch/sha fallback reads here are per call, so a config or
 * checkout change is observed even while the log sits still. */
export function mainCheckForPoll(root: string, cfg: TumwaterConfig): MainCheckStatus | undefined {
  const scan = mainCheckScanFor(root);
  const check = scan.check;
  if (!check || typeof check.ts !== "number" || typeof check.status !== "string") return undefined;
  const branch = targetBranch(cfg.baseBranch, currentBranchFromHeadFile(root));
  const sha = scan.landedAfterCommit ?? readBranchHead(root, branch) ?? scan.landedBeforeCommit;
  const counts = asTestCounts(check.counts);
  return {
    ...(sha ? { sha } : {}),
    status: check.status as "passed" | "failed" | "skipped",
    ...(counts ? { counts } : {}),
    at: check.ts,
  };
}

/** The 4/5 cross-check against the queue: the marker as observers may display it, or
 * undefined when nothing it names is still in flight. An older generation's single-change
 * marker displays only while its sha is still queued; a marker with per-change records keeps
 * just its records whose sha is still queued — a change whose entry was dropped is finished,
 * whatever its record last said — and displays only while one of those is not `done`. */
export function liveLandingMarker(marker: LandingInFlight, queued: ReadonlySet<string>): LandingInFlight | undefined {
  if (!Array.isArray(marker.changes)) return queued.has(marker.sha) ? marker : undefined;
  // Drop foreign entries before reading their sha/status: a `null`/scalar record in a
  // hand-edited marker would otherwise throw out of the every-second status poll.
  const changes = marker.changes.filter(isLandingChange).filter((c) => queued.has(c.sha));
  return changes.some((c) => c.status !== "done") ? { ...marker, changes } : undefined;
}

// The last config each root loaded successfully. snapshot is polled every second by the
// TUI and GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the fleet with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display loop state against: fresh when valid, otherwise the last
 * known-good one (or defaults if this process never saw a valid file). Never throws.
 * Freshness is stat-keyed (config.loadConfigCached): an unedited tumwater.json costs one
 * stat per poll instead of a read + parse + validate. */
export function configForStatus(root: string): TumwaterConfig {
  const { config } = loadConfigCached(root);
  if (config) {
    lastGoodConfig.set(root, config);
    return config;
  }
  return lastGoodConfig.get(root) ?? defaultConfig();
}

// Per-poll loop-state cache (stat-cache.cachedByStat): the TUI and GUI poll snapshot every second,
// but a role's state file changes only at its tick boundaries (start/end) — between ticks it
// sits unchanged for minutes. Serve an unchanged file from the stat-keyed cache: one stat
// syscall per file per poll instead of re-reading and re-parsing JSON that hasn't moved.
// Keyed by state-file path so distinct roots never collide; capped inside cachedByStat so many
// short-lived roots in tests cannot grow it unbounded.
const loopStateCache = new Map<string, StatKeyedValue<LoopState>>();

/** This poll's view of one role's state: fresh when the file changed since this process last
 * read it, cached otherwise (see above). Returns a copy so each snapshot owns its data —
 * mutating one poll's LoopState must not poison later polls. A missing state file yields a
 * fresh state, as loadLoopState does for an unreadable one. */
export function loopStateForPoll(root: string, role: string): LoopState {
  const file = statePath(root, role);
  return (
    cachedByStat(
      loopStateCache,
      file,
      file,
      () => loadLoopState(root, role),
      (state) => ({ ...state }), // A copy: callers may treat the result as their own.
    ) ?? freshLoopState(role)
  );
}
