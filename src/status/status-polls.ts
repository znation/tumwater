import { asTestCounts, type TestCounts } from "../build/build-check-counts.js";
import { isFullCheckScope } from "../build/build-check-events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { isMergeChange, readMergeMarker, type MergeInFlight } from "../merge/merge-slot.js";
import type { MergeEntry } from "../merge/merge-queue.js";
import { defaultConfig, loadConfigCached } from "../config/config.js";
import { DEFAULT_EVENT_TAIL, readEvents } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { currentBranchFromHeadFile, readBranchHead, targetBranch } from "../git/git.js";
import { readSlotsState } from "../git/slots-state.js";
import { detectBuildCheck, type BuildCheck } from "../build/build-check-detect.js";
import { freshRunnerState, type RunnerState } from "../runner/runner-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { eventsLogPath, slotsStatePath, statePath } from "../paths.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import {
  countMaintenanceWindow,
  maintenanceQuota,
  newMaintenanceWindowCounter,
} from "../gates/maintenance-quota.js";
import { commitTier } from "../roles/roles.js";
import { currentCiParityState, parityIsCurrent, readCiParity } from "../run/ci-parity.js";

/** The per-poll cached readers behind status/status-data.ts's snapshot(): one poll's view of the
 * three inputs that cost real reads — main's newest merge-scope build check (a stat-cached
 * event-tail scan with its own grown-full memo), the config to display against (stat-keyed, with a
 * last-known-good fallback so a transiently broken tumwater.json never blinds an observer),
 * and each role's runner state (stat-keyed, copied per poll). Split out of status/status-data.ts —
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
  /** The red-main evidence the always-on `mainred` alert surfaces (read by
   * team-alert-status.ts's buildStatusAlerts; it also rides the machine-readable `status
   * --json` output through
   * status-payload.ts's wholesale spread of mainCheck): present only when `status` is
   * "failed" and a main_culprit verdict names the very red tip this poll derived a sha for,
   * with a well-formed failingTests list. `failingTests` is the main watch's list for that
   * tip; `culprit` is the same verdict's commit (always a string) and, when the watch named
   * one, the runner. */
  red?: {
    failingTests: string[];
    culprit?: { commit: string; runner?: string };
  };
}

/** Is a value one of MainCheckStatus's three statuses? The one home of the membership test:
 * the event log is loose-typed by design, and a check whose status is not one of the three
 * (a hand-edited or future-format block) is malformed — dropped like any other malformed
 * check (see MainCheckScan.check's note) rather than narrowed with a cast into a status it
 * cannot prove, which would otherwise leak a mystery word to the header badge and the GUI
 * payload (mainCheckVerdict renders any unmatched status verbatim). */
function isMainCheckStatus(status: unknown): status is "passed" | "failed" | "skipped" {
  return status === "passed" || status === "failed" || status === "skipped";
}

/** How far mainCheckForPoll may grow its event tail. The per-poll default
 * (event-read.ts's DEFAULT_EVENT_TAIL) covers a healthy team — a merge-scope check rides
 * every merge and every redeploy — but a burst of quiet or failing runs logs hundreds
 * of events without moving main, and a tail
 * that ends before the last check makes the header badge vanish and reappear as agent runs go
 * by. Growing until the check is found keeps "absent" meaning what the field's contract says
 * (no merge-scope check has run) rather than "the window ended"; the cap keeps the worst
 * per-poll scan bounded — readTailText reads bytes proportional to the line count, and the scan
 * runs only when events.jsonl changes, so it stays below history's one-ask bound
 * (HISTORY_SCAN_MAX_EVENTS, 20k).
 * Past the cap the badge drops, the same graceful loss log rotation already imposes. */
const MAIN_CHECK_SCAN_MAX_EVENTS = 5_000;

/** Per-root note that the previous scan had to grow past the default event tail
 * (DEFAULT_EVENT_TAIL) without finding a merge-scope check. A check rides every merge, so a poll
 * that grew all the way to the cap is a burst of quiet or failing runs — hundreds of events
 * between merges — and the next poll's growth starts straight at the cap instead of re-scanning
 * the ×4 ladder's intermediate windows (200→800→3200→5000 ≈ 9.2k re-parsed events per
 * fresh tail, vs 5.2k for 200→cap; measured on a 6k-event check-free log, ~2.3 ms → ~1.2 ms per
 * append+poll). A poll that finds a check clears the note, so the ordinary find-in-200 /
 * find-in-800 path pays the same small windows as before. In-memory only: a wrong guess costs the
 * ladder it skipped, never a wrong verdict — every window's scan is complete for its size. */
const mainCheckGrewFull = new Set<string>();
const MAIN_CHECK_FULL_SET_MAX = 64;

/** The log-derived half of the mainCheck derivation: the newest merge-scope build_check and
 * the merged commits bracketing it — everything the field needs that depends only on the
 * event log. Split out so it can be cached per events.jsonl stat: the scan (the tail ladder,
 * its re-parses, and the merged collection) is a pure function of the log content, while the
 * sha's branch fallback (readBranchHead/currentBranchFromHeadFile) and the config's
 * baseBranch stay per call, so a checkout or a config edit is still observed on the next
 * poll. */
interface MainCheckScan {
  /** The newest merge-scope check in the tail, or undefined when none is within the cap (or
   * the newest one found is malformed). */
  check?: HarnessEvent;
  /** The newest merged commit before or at the check's ts — the fallback when nothing merged
   * after it. */
  mergeDoneBeforeCommit?: string;
  /** The newest merged commit after the check's ts — the sha the check verified. */
  mergeDoneAfterCommit?: string;
  /** The newest main_culprit event in the tail — the main watch's blame for the newest red
   * tip (src/baseline/main-watch.ts). Collected in the same single pass as the check. */
  culprit?: HarnessEvent;
}

/** Per-root scan cache (stat-cache.cachedByStat): both dashboards poll snapshot every second,
 * but events.jsonl is written only at run boundaries and merges, so an unchanged log serves
 * the whole scan from one stat instead of re-listing the ladder, re-parsing its windows, and
 * re-collecting the merged events. Rotation swaps the inode and every append changes the size,
 * so both invalidate through the same freshness check; keyed by root so distinct repos never
 * collide. Bounded inside cachedByStat. */
const mainCheckScanCache = new Map<string, StatKeyedValue<MainCheckScan>>();

/** Scan the log for MainCheckScan, growing the tail until a merge-scope check is inside it (see
 * MAIN_CHECK_SCAN_MAX_EVENTS): a check older than the default tail must still badge the header,
 * and every event after the check — the merged pairing the sha needs — is newer, so one window
 * holds the whole derivation. */
function scanMainCheck(root: string): MainCheckScan {
  let check: HarnessEvent | undefined;
  // The final window's merged events, in scan order — collected in the same pass that
  // finds the check instead of a second full scan of the window below.
  let mergeDone: HarnessEvent[] = [];
  let culprit: HarnessEvent | undefined;
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
    mergeDone = [];
    culprit = undefined;
    // One pass collects all three facts the derivation needs: the newest merge-scope check,
    // every merged event, and the newest main_culprit blame. The merges are re-read against
    // the check's ts below — a pass over the merges alone, not a second pass over every
    // event in the window.
    for (const e of events) {
      if (e.type === "build_check" && isFullCheckScope(e.scope, e.full)) {
        check = e;
      } else if (e.type === "merge_done" && typeof e.ts === "number") {
        mergeDone.push(e);
      } else if (e.type === "main_culprit") {
        culprit = e;
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
  if (!check || typeof check.ts !== "number" || !isMainCheckStatus(check.status)) {
    return { ...(culprit ? { culprit } : {}) };
  }
  let mergeDoneAfter: HarnessEvent | undefined;
  let mergeDoneBefore: HarnessEvent | undefined;
  for (const e of mergeDone) {
    if (e.ts > check.ts) mergeDoneAfter = e;
    else mergeDoneBefore = e;
  }
  return {
    check,
    ...(culprit ? { culprit } : {}),
    ...(typeof mergeDoneAfter?.commit === "string" ? { mergeDoneAfterCommit: mergeDoneAfter.commit } : {}),
    ...(typeof mergeDoneBefore?.commit === "string" ? { mergeDoneBeforeCommit: mergeDoneBefore.commit } : {}),
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
      (v) => ({
        ...v,
        ...(v.check ? { check: { ...v.check } } : {}),
        ...(v.culprit ? { culprit: { ...v.culprit } } : {}),
      }),
    ) ?? { check: undefined }
  );
}

/** Has main's newest merge-scope check retired a role's stale `main_red` verdict? Only a
 * PASSED check stamped strictly after the role's red run ended counts — the team-level
 * green is newer evidence than the role's own red (BUGS.md 2026-09-30). A failed or skipped
 * newest check, a check from before the red run, or a role with no known run end all leave
 * the verdict standing. Single-homed here beside heldByMainRed. */
function mainCheckRecovered(mainCheck: MainCheckStatus | undefined, s: RunnerState): boolean {
  return mainCheck?.status === "passed"
    && s.lastRunEndedAt !== undefined
    && mainCheck.at > s.lastRunEndedAt;
}

/** Is a role's run verdict still the red-main hold? The one predicate behind the status
 * phase's `main red` label and doctor's `main red` check, so the two cannot disagree. */
export function heldByMainRed(s: RunnerState, mainCheck: MainCheckStatus | undefined): boolean {
  return s.lastResult === "main_red" && s.queuedSummary === undefined && !mainCheckRecovered(mainCheck, s);
}

/** The newest merge-scope build_check in the event tail, with the main sha it verified
 * (mainCheck's derivation — see the field's comment). A gate-scope check is excluded: it
 * verified a role worktree, not main. The log-derived scan is stat-cached per events.jsonl
 * (mainCheckScanFor); only the branch/sha fallback reads here are per call, so a config or
 * checkout change is observed even while the log sits still. */
export function mainCheckForPoll(root: string, cfg: TumwaterConfig): MainCheckStatus | undefined {
  const scan = mainCheckScanFor(root);
  const check = scan.check;
  if (!check || typeof check.ts !== "number" || !isMainCheckStatus(check.status)) return undefined;
  const branch = targetBranch(cfg.baseBranch, currentBranchFromHeadFile(root));
  const sha = scan.mergeDoneAfterCommit ?? readBranchHead(root, branch) ?? scan.mergeDoneBeforeCommit;
  const counts = asTestCounts(check.counts);
  // The red evidence names the failing test and the merge the main watch blamed — and that
  // data lives only on the main_culprit event (the main watch's verdict on the red tip; the
  // build_check event itself carries no failing tests), attributed only when the verdict's
  // commit is exactly the sha this poll derived, so a newer build_check failure can't borrow
  // a blame the watch wrote for a different head. A passing/skipped check, or a failing one
  // whose tip the watch hasn't blamed, keeps today's exact MainCheckStatus shape (no `red`).
  let red: MainCheckStatus["red"] | undefined;
  if (check.status === "failed" && sha !== undefined && scan.culprit && typeof scan.culprit.commit === "string") {
    const c = scan.culprit;
    if (c.commit === sha) {
      const failing =
        Array.isArray(c.failingTests) && typeof c.failingTests[0] === "string"
          ? c.failingTests.filter((f): f is string => typeof f === "string")
          : undefined;
      if (failing) {
        red = {
          failingTests: failing,
          culprit: {
            commit: c.commit,
            ...(typeof c.runner === "string" ? { runner: c.runner } : {}),
          },
        };
      }
    }
  }
  return {
    ...(sha ? { sha } : {}),
    status: check.status,
    ...(counts ? { counts } : {}),
    at: check.ts,
    ...(red ? { red } : {}),
  };
}

/** How long a computed `check` detection answer is reused. Detection needs the project's `check`
 * config plus a walk-up over the filesystem scalars (each ancestor's package.json and
 * node_modules existence, and the package.json's scripts), so it is throttled by time rather than
 * keyed by a single stat: the dashboards poll every second but these inputs change only when the
 * operator edits tumwater.json or the repo structure, and `snapshot()`'s `noDeclaredCheck` asks
 * it every poll. Mirrors the collectRootInstallDrift throttle (status-install.ts), the other
 * multi-read per-second figure. */
const CHECK_POLL_MS = 15_000;

/** Safety cap, as in files/stat-cache.ts: many short-lived roots (tests) cannot grow the map
 * unbounded. */
const MAX_CHECKS_CACHED = 64;

const buildCheckCache = new Map<string, { at: number; value: BuildCheck | null; key: string }>();

/** This poll's view of the project's declared check: `detectBuildCheck` against the live
 * last-known-good config, recomputed at most once per CHECK_POLL_MS per root. Keyed on the
 * config's check slice too, so a live `config set check.*` lands within the throttle instead of
 * waiting out the window. The caller owns the returned value. */
export function buildCheckForPoll(root: string, cfg: TumwaterConfig): BuildCheck | null {
  const checkSlice = cfg.check && typeof cfg.check === "object"
    ? JSON.stringify(cfg.check)
    : "";
  const key = `${root}\u0000${checkSlice}`;
  const hit = buildCheckCache.get(root);
  const now = Date.now();
  if (hit?.key === key && now - hit.at < CHECK_POLL_MS) return hit.value;
  const value = detectBuildCheck(root, cfg);
  if (buildCheckCache.size >= MAX_CHECKS_CACHED) buildCheckCache.clear();
  buildCheckCache.set(root, { at: now, value, key });
  return value;
}

/** The ciParity field's shape (StatusSnapshot's contract): the `ci` ledger's glance verdict
 * beside the fast main check. `state` is the doctor's own `current`/`stale`/`failed` reading
 * (the same rule renderParityBlock applies to the ci prompt), `covered` is the tip the last
 * full-suite run actually exercised as the ledger recorded it (an abbreviated sha the run
 * named on its `CI:` line), and `lastRunAt` is that run's stamp. Absent — the field is
 * optional — when no parity record exists (a repo the ci role has never run), so the surfaces
 * render exactly as before the badge existed. */
export interface CiParityStatus {
  state: "current" | "stale" | "failed";
  covered: string;
  lastRunAt: number;
}

/** The parity ledger's glance verdict for one status poll, or undefined when there is no
 * record yet. Mirrors mainCheckForPoll's shape — a pure read, no spawn, no write: read the
 * record, resolve the current main tip and lock hash the same way the ci prompt's parity
 * block does (currentCiParityState), and classify current/stale/failed with the single
 * parityIsCurrent predicate so a `current` badge and a `current` prompt block cannot
 * disagree. A missing or malformed ledger reads as undefined — no badge, never a throw. */
export function ciParityForPoll(root: string, cfg: TumwaterConfig): CiParityStatus | undefined {
  const entry = readCiParity(root);
  if (!entry) return undefined;
  const { tip, lockHash } = currentCiParityState(root, cfg);
  const state = entry.result === "failed" ? "failed" : parityIsCurrent(entry, tip, lockHash) ? "current" : "stale";
  return { state, covered: entry.tip, lastRunAt: entry.lastRunAt };
}

/** The 4/5 cross-check against the queue: the marker as observers may display it, or
 * undefined when nothing it names is still in flight. An older generation's single-change
 * marker displays only while its sha is still queued; a marker with per-change records keeps
 * just its records whose sha is still queued — a change whose entry was dropped is finished,
 * whatever its record last said — and displays only while one of those is not `done`. */
export function liveMergeMarker(marker: MergeInFlight, queued: ReadonlySet<string>): MergeInFlight | undefined {
  if (!Array.isArray(marker.changes)) return queued.has(marker.sha) ? marker : undefined;
  // Drop foreign entries before reading their sha/status: a `null`/scalar record in a
  // hand-edited marker would otherwise throw out of the every-second status poll.
  const changes = marker.changes.filter(isMergeChange).filter((c) => queued.has(c.sha));
  return changes.some((c) => c.status !== "done") ? { ...marker, changes } : undefined;
}

/** The marker observers display for a queue read: undefined unless the orchestrator is running
 * (`running`) and the marker has a live record for a queued entry (liveMergeMarker). The one
 * home of this cross-check for the status snapshot, `tumwater queue`, and the TUI Pending pane. */
export function queueInFlight(root: string, entries: readonly MergeEntry[], running: boolean): MergeInFlight | undefined {
  if (!running) return undefined;
  const marker = readMergeMarker(root);
  return marker ? liveMergeMarker(marker, new Set(entries.map((e) => e.sha))) : undefined;
}

// The last config each root loaded successfully. snapshot is polled every second by the
// TUI and GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the team with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display runner state against: fresh when valid, otherwise the last
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

// Per-poll runner-state cache (stat-cache.cachedByStat): the TUI and GUI poll snapshot every
// second, but a role's state file changes only at its run boundaries (start/end) — between runs
// it sits unchanged for minutes. Serve an unchanged file from the stat-keyed cache: one stat
// syscall per file per poll instead of re-reading and re-parsing JSON that hasn't moved.
// Keyed by state-file path so distinct roots never collide; capped inside cachedByStat so many
// short-lived roots in tests cannot grow it unbounded.
type SlotsForPoll = ReturnType<typeof readSlotsState>["slots"];

/** Per-poll cached view of the worktree pool layout (status-data's `slots`), stat-cached by
 * file like the other always-on snapshot readers: slots.json changes only at lease boundaries
 * (a run or verify taking/releasing a pooled slot), so an unchanged file costs one stat per
 * poll instead of a full read plus a JSON parse every second (status-data's snapshot used to
 * readSlotsState the file on every poll). Bounded inside cachedByStat. */
const slotsCache = new Map<string, StatKeyedValue<SlotsForPoll>>();

/** This poll's view of the pooled worktree slots: fresh when slots.json changed since this
 * process last read it, cached otherwise (see above). Returns a copy so each snapshot owns
 * its data and read-modify-write callers in this process never alias a shared cached record. */
export function slotsForPoll(root: string): SlotsForPoll {
  return (
    cachedByStat(
      slotsCache,
      slotsStatePath(root),
      slotsStatePath(root),
      () => readSlotsState(root).slots,
      (slots) => slots.map((s) => ({ ...s, lease: s.lease ? { ...s.lease } : null })),
    ) ?? []
  );
}

const runnerStateCache = new Map<string, StatKeyedValue<RunnerState>>();

/** This poll's view of one role's state: fresh when the file changed since this process last
 * read it, cached otherwise (see above). Returns a copy so each snapshot owns its data —
 * mutating one poll's RunnerState must not poison later polls. A missing state file yields a
 * fresh state, as loadRunnerState does for an unreadable one. */
export function runnerStateForPoll(root: string, role: string): RunnerState {
  const file = statePath(root, role);
  return (
    cachedByStat(
      runnerStateCache,
      file,
      file,
      () => loadRunnerState(root, role),
      (state) => ({ ...state }), // A copy: callers may treat the result as their own.
    ) ?? freshRunnerState(role)
  );
}

// Per-root maintenance-window memos (plans/work-ratio.md, part 1b/4): the gate's own
// instant-shaped counter, so a status reader shows the same allowance verdict the scheduler
// enforces without re-folding the whole window each second. The counter folds only appended
// bytes between polls, exactly like the orchestrator's. Keyed by root; in-memory only, so a
// first poll or a restart seeds from a full windowed read.
const maintenanceCounters = new Map<string, ReturnType<typeof newMaintenanceWindowCounter>>();

/** The maintenance allowance verdict as an observer sees it for this poll (status-data's
 * `maintenanceQuota` field): the rolling-window counts over the same event log the gate reads,
 * plus the enabled maintenance roles currently in flight (running a role run or holding a queued
 * merge, so the `used` figure matches the gate's). `held` names the enabled maintenance role
 * ids the scheduler holds while `used >= allowance`. Pure read — unlike the gate it logs nothing
 * and keeps no hold edge, so it can run in the TUI/GUI process every second. */
export function maintenanceQuotaForPoll(
  root: string,
  perWorkMerge: number,
  runners: readonly { role: string; running?: boolean }[],
  queuedMergeRoles: ReadonlySet<string>,
  now: number,
): { allowance: number; used: number; held: string[] } {
  let counter = maintenanceCounters.get(root);
  if (!counter) {
    counter = newMaintenanceWindowCounter();
    maintenanceCounters.set(root, counter);
  }
  const { work, maint } = countMaintenanceWindow(root, counter, now);
  const maintenanceRoles: string[] = [];
  let inFlight = 0;
  for (const runner of runners) {
    if (commitTier(runner.role) !== "maintenance") continue;
    maintenanceRoles.push(runner.role);
    if (runner.running || queuedMergeRoles.has(runner.role)) inFlight++;
  }
  const verdict = maintenanceQuota({ work, maint, inFlight, perWorkMerge });
  return { allowance: verdict.allowance, used: verdict.used, held: verdict.held ? maintenanceRoles : [] };
}
