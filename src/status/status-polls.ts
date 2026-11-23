import type { TumwaterConfig } from "../config/config-schema.js";
import { isMergeChange, readMergeMarker, type MergeInFlight } from "../merge/merge-slot.js";
import type { MergeEntry } from "../merge/merge-queue.js";
import { defaultConfig, loadConfigCached } from "../config/config.js";
import { configPath } from "../paths.js";
import { readSlotsState } from "../git/slots-state.js";
import { freshRunnerState, type RunnerState } from "../runner/runner-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { qaCoveragePath, remoteCiPath, slotsStatePath, statePath } from "../paths.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import {
  countMaintenanceWindow,
  maintenanceQuota,
  newMaintenanceWindowCounter,
} from "../gates/maintenance-quota-gates.js";
import { commitTier } from "../roles/roles.js";
import { currentCiParityState, parityIsCurrent, readCiParity } from "../observer/ci-parity.js";
import { readRemoteCi, type RemoteCiEntry } from "../observer/remote-ci.js";
import { newestExercise, qaCoverageStalled, readQaCoverage, type QaCoverage } from "../observer/qa-coverage.js";

/** The per-poll cached readers behind status/status-data.ts's snapshot(): one poll's view of the
 * inputs that cost real reads — the last-known-good config (stat-keyed, so a broken tumwater.json
 * never blinds an observer), each role's runner state (stat-keyed, copied per poll), the pooled
 * worktree slots, the ci and remote-CI ledgers, the merge-in-flight marker, and
 * the maintenance allowance. The main-check reader (a stat-cached event-tail scan with its
 * grown-full memo) lives in status-main-check.ts; the throttled declared-check reader lives
 * in build/build-check-poll.ts, beside the detection it caches. All were split out of
 * status/status-data.ts — which keeps the snapshot assembly, while the StatusSnapshot contract
 * itself lives in status-types.ts — so neither file carries module-level cache state of its
 * own. Pure data collection, no presentation concern. */

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

/** The remoteCi field's shape (StatusSnapshot's contract): the remote-CI ledger's glance
 * verdict beside the ci parity badge — the answer to "is GitHub's CI green on what was
 * pushed?" without opening doctor. `result` is what the ci role last reported on its `REMOTE:`
 * line, `sha` the pushed commit the verdict names (absent for `unavailable`), `checkedAt`
 * when the record was written. Absent — the field is optional — when no record exists (a repo
 * whose ci role has never recorded a remote verdict), so the surfaces render exactly as before
 * the badge existed. */
export interface RemoteCiStatus {
  result: RemoteCiEntry["result"];
  sha?: string;
  checkedAt: number;
}

// Stat-keyed cache (stat-cache.cachedByStat) for the remote-CI ledger, keyed by the ledger
// path: the status snapshot's remoteCiForPoll polls it every second while the ledger changes
// only when a ci run records a remote verdict, so an unchanged file costs one stat per poll
// instead of a re-read plus JSON.parse — the same stat-keyed contract the parity ledger's
// reader in observer/ci-parity.ts uses. recordRemoteCi's write is atomic (tmp + rename), so
// any write invalidates via dev/ino/mtime/size. Bounded inside cachedByStat so many
// short-lived roots in tests cannot grow it unbounded; a null (no data) result is not cached,
// so a torn ledger is re-parsed next poll but a valid record (the steady state) costs one
// stat per poll. readRemoteCi itself stays uncached — it also serves the ci prompt's block
// and the run-dismiss recording paths, which must see the pre-write record in the same
// process.
const remoteCiLedgerCache = new Map<string, StatKeyedValue<RemoteCiEntry | null>>();

/** The remote-CI ledger's glance verdict for one status poll, or undefined when there is no
 * record yet. A pure read — no git, no `gh`, no write: the ledger only (readRemoteCi through
 * the stat-keyed cache above), so a per-second poll costs one stat while the ledger is
 * unchanged and re-reads it once after a write. A missing or malformed ledger reads as
 * undefined — no badge, never a throw — the same omission policy as ciParityForPoll. */
export function remoteCiForPoll(root: string): RemoteCiStatus | undefined {
  const file = remoteCiPath(root);
  const entry = cachedByStat(
    remoteCiLedgerCache,
    file,
    file,
    () => readRemoteCi(root),
    (e) => (e === null ? null : { ...e }), // A copy: callers may treat the result as their own.
  );
  return entry ? { result: entry.result, ...(entry.sha ? { sha: entry.sha } : {}), checkedAt: entry.checkedAt } : undefined;
}

/** The qaCoverage field's shape (StatusSnapshot's contract): the `qa` observer's flow-coverage
 * ledger's glance verdict — the answer to "is the team's flow-level observer still recording
 * exercises?" without opening doctor. `flow` is the newest exercised flow, `lastRunAt` its stamp
 * (so each renderer formats the age from its own clock, as the other glance fields do), and
 * `stale` is `qaCoverageStalled`'s verdict at poll time. Absent — the field is optional — when no
 * ledger exists (a project that never ran qa, or one whose ledger holds no well-formed entry), so
 * the surfaces render exactly as before the badge existed. */
export interface QaCoverageStatus {
  flow: string;
  lastRunAt: number;
  stale: boolean;
}

// Stat-keyed cache (stat-cache.cachedByStat) for the qa flow-coverage ledger, keyed by the ledger
// path: the status snapshot's qaCoverageForPoll polls it every second while the ledger changes only
// when a qa run records a flow, so an unchanged file costs one stat per poll instead of a re-read
// plus JSON.parse — the same stat-keyed contract the remote-CI ledger's reader above uses. A
// missing file never reaches the loader at all: cachedByStat drops its entry when the file has no
// stat. Bounded inside cachedByStat so many short-lived roots in tests cannot grow it unbounded.
// readQaCoverage itself stays uncached — it also serves the doctor `qa coverage` row and the qa
// prompt's coverage block, which must see the pre-write ledger in the same process.
const qaCoverageLedgerCache = new Map<string, StatKeyedValue<QaCoverage>>();

/** The qa flow-coverage ledger's glance verdict for one status poll, or undefined when there is no
 * record yet. A pure read — no git, no spawn, no write: the ledger only (readQaCoverage through the
 * stat-keyed cache above), so a per-second poll costs one stat while the ledger is unchanged and
 * re-reads it once after a write. A missing or malformed ledger reads as undefined — no badge,
 * never a throw — the same omission policy as remoteCiForPoll. The cache holds the LEDGER, never
 * the verdict: `stale` and the age must follow the poll's clock while the file stands still, which
 * is why the verdict is derived from the cached ledger with `now` on every call. The verdict comes
 * from the one home of the decision (newestExercise plus qaCoverageStalled), the same pair the
 * doctor `qa coverage` row reads, so the badge and the row cannot disagree. */
export function qaCoverageForPoll(root: string, now: number): QaCoverageStatus | undefined {
  const file = qaCoveragePath(root);
  const coverage = cachedByStat(
    qaCoverageLedgerCache,
    file,
    file,
    () => readQaCoverage(root),
    (cov) => ({ ...cov }), // A copy: callers may treat the result as their own.
  );
  if (!coverage) return undefined;
  const newest = newestExercise(coverage);
  if (newest === null) return undefined; // No well-formed entry: no badge, like a missing file.
  return { flow: newest.flow, lastRunAt: newest.lastRunAt, stale: qaCoverageStalled(coverage, now) };
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
 * home of this cross-check for the status snapshot and the surfaces that paint the merge queue. */
export function queueInFlight(root: string, entries: readonly MergeEntry[], running: boolean): MergeInFlight | undefined {
  if (!running) return undefined;
  const marker = readMergeMarker(root);
  return marker ? liveMergeMarker(marker, new Set(entries.map((e) => e.sha))) : undefined;
}

// The last config each root loaded successfully. snapshot is polled every second by the
// GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the team with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display runner state against plus the reason the fresh file did not
 * load, for the standing `config-problem` alert: a valid config updates the last
 * known-good one and carries no problem; an error keeps the last good config (or
 * defaults if this process never saw a valid file) and carries its text; a missing file
 * keeps the last good config and names the missing file and the hold. Never throws —
 * one `loadConfigCached` read (stat-keyed, so an unedited tumwater.json costs one stat
 * per poll), so `configForStatus`'s INV-T4 contract is the same read. */
export function configStateForStatus(root: string): { config: TumwaterConfig; problem?: string } {
  const { config, error, missing } = loadConfigCached(root);
  if (config) {
    lastGoodConfig.set(root, config);
    return { config };
  }
  const last = lastGoodConfig.get(root) ?? defaultConfig();
  const problem = missing
    ? `tumwater.json is missing — the team is running on its last known-good config (${configPath(root)})`
    : error;
  return { config: last, problem };
}

/** The config to display runner state against: fresh when valid, otherwise the last
 * known-good one (or defaults if this process never saw a valid file). Never throws.
 * Freshness is stat-keyed (config.loadConfigCached): an unedited tumwater.json costs one
 * stat per poll instead of a read + parse + validate. */
export function configForStatus(root: string): TumwaterConfig {
  return configStateForStatus(root).config;
}

// Per-poll runner-state cache (stat-cache.cachedByStat): the GUI polls snapshot every
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
 * plus the enabled maintenance roles currently in flight (running a role run, so the `used`
 * figure matches the gate's). `held` names the enabled maintenance role ids the scheduler holds
 * while `used >= allowance`. Pure read — unlike the gate it logs nothing and keeps no hold edge,
 * so it can run in the GUI process every second. */
export function maintenanceQuotaForPoll(
  root: string,
  perWorkMerge: number,
  runners: readonly { role: string; running?: boolean }[],
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
    if (runner.running) inFlight++;
  }
  const verdict = maintenanceQuota({ work, maint, inFlight, perWorkMerge });
  return { allowance: verdict.allowance, used: verdict.used, held: verdict.held ? maintenanceRoles : [] };
}
