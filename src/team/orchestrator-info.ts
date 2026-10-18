import type { ModelTier } from "../config/config-schema.js";
import type { BuildStatus } from "../build/build-info.js";
import type { FallbackDemotion } from "../budget/fallback-breaker.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { finiteNumber, isJsonObject } from "../files/json-object.js";
import { pidAlive } from "../process/process.js";
import { orchestratorStatePath } from "../paths.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";

/** Why the position before a tier's active chain step cannot run. */
type ChainReason = "window" | "reserve" | "cap" | "step-cap" | "overage" | "demoted";

/** Where one tier runs while the budget gate has it off its primary (budget-gates.ts's
 * chainInfo): `step` of `of` in the supplying tier's chain, 1-based. */
export interface ChainTierInfo {
  pair: string;
  step: number;
  of: number;
  reason: ChainReason;
  /** When the blocked position returns (epoch ms); absent for `demoted` and `overage`. */
  returnsAt?: number;
  spentUsd?: number;
  capUsd?: number;
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving the
 * team, since when, with which roles, and what its most recent poll published about the world
 * (build staleness, the daily budget, engaged fallback demotions, the disk floor). The
 * orchestrator writes it (writeOrchestratorInfo); the separate-process observers — status, TUI,
 * GUI, doctor, and the second-team refusal — read it here so they never depend on the scheduler
 * module itself. The operator pause markers are the other team-state domain and live beside
 * this one in team-state.ts; this module owns the info file alone. */

/** The disk floor's published state (plans/disk-floor.md, part 4/4): what the orchestrator
 * measured on its most recent poll, so observers (status, TUI, GUI) show the same facts
 * without calling statfs themselves. `freeGB` is rounded to one decimal; `held` is the hold's
 * verdict; `lastReclaim` names the most recent pressure pass that cleaned anything, absent
 * until one has. Published only when it changes; absent when statfs cannot measure the volume
 * or on an older orchestrator. */
/** One keyed provider's live permits in the pool's snapshot (plans/provider-concurrency.md
 * §8): `inUse` is the slots that key currently holds, `limit` its configured cap
 * (absent when the key is uncapped — bounded only by the team total), `waiting` the
 * acquirers parked on that key. */
interface PermitKeyState {
  inUse: number;
  limit?: number;
  waiting: number;
}

/** The permit pool's published state (plans/provider-concurrency.md §8): the team total's
 * in-use/cap, the maintenance reserve, and each referenced provider key's own state. The
 * orchestrator publishes it through the info file so observers (status, TUI, GUI) render the
 * same facts without coupling to the scheduler's Semaphore. */
export interface PermitSnapshot {
  inUse: number;
  limit: number;
  reserve: number;
  byKey: Record<string, PermitKeyState>;
}

export interface DiskStatus {
  freeGB: number;
  holdGB: number;
  reclaimGB: number;
  held: boolean;
  lastReclaim?: { at: number; mode: "pressure" | "idle" | "manual"; freedGB: number };
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving
 * the team, since when, and with which roles. Written by runOrchestrator; read here so
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
   * is actually enforcing; a stopped team removes this file at exit, so the absence of a
   * running orchestrator means no published figure exists and the persisted sum is final.
   * Written by the orchestrator whenever the pair changes; absent otherwise. */
  budget?: { spentUsd: number; capUsd: number };
  /** The tiers the budget gate has off their primary and the chain step each runs on; absent
   * when none moved. Written whenever it changes. */
  chain?: Partial<Record<ModelTier, ChainTierInfo>>;
  /** The disk floor's most recent measurement (plans/disk-floor.md, part 4/4): free space,
   * the configured floor and reclaim threshold, whether the hold is on, and the last reclaim
   * pass. Written by the orchestrator's poll whenever it changes; absent when statfs cannot
   * measure the volume or on an older orchestrator, which renders exactly as before. */
  disk?: DiskStatus;
  /** The `tumwater run --for` window's deadline (epoch ms): when the team stops itself. Absent
   * for an unbounded run or a `--once` round. Written once at startup, so every self-redeploy
   * generation publishes the same inherited deadline. */
  stopsAt?: number;
  /** The permit pool's live state (plans/provider-concurrency.md §8): the team in-use/cap,
   * the maintenance reserve, and each referenced provider key's in-use/cap/waiting. Written
   * by the orchestrator's poll whenever it changes, like `budget` and `disk`; absent when the
   * running orchestrator predates it or there is no pool. */
  permits?: PermitSnapshot;
  /** The standing per-provider failure holds (src/team/team-hold.ts `standingHolds`): a
   * provider storm's hold, as the orchestrator's poll publishes them, so the status snapshot
   * and the alert banner name why held providers hold. An entry's `provider` is omitted for
   * pi's default backend. Written by the orchestrator's poll whenever a hold opens or lifts;
   * absent while none stands. */
  providerHolds?: Array<{ provider?: string; until: number; kind: string }>;
}

/** Assign one field of the orchestrator info file in place, but only when the value differs
 * from what it already carries, and report whether it changed. This is the shared rule for the
 * fields observers cannot recompute (build, budget, fallback demotions, disk): an unchanged
 * poll leaves the file untouched, while a changed one stages the value so the caller can write
 * once after several fields. The comparison uses JSON serialization, matching
 * writeOrchestratorInfo's
 * own output, so a value equal to the stored one is never treated as a change. */
function assignInfoFieldIfChanged<K extends keyof OrchestratorInfo>(
  info: OrchestratorInfo,
  field: K,
  value: OrchestratorInfo[K],
): boolean {
  if (JSON.stringify(value) === JSON.stringify(info[field])) return false;
  info[field] = value;
  return true;
}

/** Assign several non-recomputable info fields in place (each via assignInfoFieldIfChanged) and
 * publish the file best-effort once when any of them changed — the publish idiom the
 * orchestrator's poll (permits, build) and gate-polls (the budget trio, disk) apply to every
 * field observers cannot recompute. Every field is staged regardless of the others (this is
 * not a short-circuiting find), so a batch like the budget trio lands as exactly one write no
 * matter how many of its fields changed, while an unchanged batch leaves the file untouched.
 * Returns whether the file was written. The staging primitive and the best-effort writer are
 * private to this module now that publishInfoFields is the only publish path. */
export function publishInfoFields(
  root: string,
  info: OrchestratorInfo,
  fields: ReadonlyArray<[keyof OrchestratorInfo, OrchestratorInfo[keyof OrchestratorInfo]]>,
): boolean {
  let changed = false;
  for (const [field, value] of fields) {
    if (assignInfoFieldIfChanged(info, field, value)) changed = true;
  }
  if (changed) writeOrchestratorInfoBestEffort(root, info);
  return changed;
}

/** Read the running orchestrator's info file; null when it is missing or unreadable.
 * Never throws — a torn write (e.g. a crash mid-write) must not take down observers
 * that poll this every second (TUI, GUI, status). The nested fields cross the same
 * hand-editable boundary as the file body, so each known field is validated here rather than
 * trusted because the `OrchestratorInfo` annotation says so: a foreign shape (a scalar
 * `fallbackDemotions`, a `disk` missing its numbers) would otherwise throw out of a render —
 * `modelPairName(p) in publishedDemotions` or `formatGB(undefined)` — on every second's
 * poll. An unreadable field is dropped, so observers read it as absent. */
export function readOrchestratorInfo(root: string): OrchestratorInfo | null {
  const info = readJsonFile<OrchestratorInfo>(orchestratorStatePath(root));
  if (info === null) return null;
  normalizeInfoFields(info as unknown as Record<string, unknown>);
  return info;
}

/** Number type-guard over the shared `finiteNumber` read (json-object.ts): that helper is the
 * one home of the "the field is the number or it is nothing" rule, narrowed here so callers
 * can assign the checked field to its declared type. */
function isFiniteNumber(v: unknown): v is number {
  return finiteNumber(v, undefined) !== undefined;
}

/** One pair-keyed demotion record, or undefined for any foreign shape. */
function parseDemotion(v: unknown): FallbackDemotion | undefined {
  if (!isJsonObject(v)) return undefined;
  if (typeof v.pair !== "string" || !isFiniteNumber(v.failures) || !isFiniteNumber(v.probeAt))
    return undefined;
  return { pair: v.pair, failures: v.failures, probeAt: v.probeAt };
}

/** The running build's stamp, or undefined for any foreign shape. `sha`/`builtAt` are the
 * required pair observers render; each optional staleness field is kept only when it carries
 * the type its consumer reads, so a foreign value drops rather than reaching a render. */
function parseBuild(v: unknown): BuildStatus | undefined {
  if (!isJsonObject(v)) return undefined;
  if (typeof v.sha !== "string" || !isFiniteNumber(v.builtAt)) return undefined;
  const build: BuildStatus = { sha: v.sha, builtAt: v.builtAt };
  if (typeof v.stale === "boolean") build.stale = v.stale;
  if (isFiniteNumber(v.aheadCommits)) build.aheadCommits = v.aheadCommits;
  if (typeof v.checkedHead === "string") build.checkedHead = v.checkedHead;
  if (typeof v.restartPending === "boolean") build.restartPending = v.restartPending;
  if (typeof v.restartBlocked === "string") build.restartBlocked = v.restartBlocked;
  return build;
}

/** The published permit snapshot, or undefined for any foreign shape. Each `byKey` entry must
 * carry its two numbers; `limit` is kept only when it is a number, so a malformed provider
 * map is dropped to `undefined` rather than reaching a render that reads it as a valid cap. */
/** One entry of the published provider-holds list, or undefined for any foreign shape: a
 * well-formed entry is an object with a finite `until` and a string `kind`; a `provider` that
 * is present but not a string drops the entry, so a guarded list keeps its well-formed
 * siblings rather than dropping wholesale. */
function parseProviderHold(v: unknown): { provider?: string; until: number; kind: string } | undefined {
  if (!isJsonObject(v) || !isFiniteNumber(v.until) || typeof v.kind !== "string") return undefined;
  if (v.provider !== undefined && typeof v.provider !== "string") return undefined;
  return { ...(v.provider !== undefined ? { provider: v.provider } : {}), until: v.until, kind: v.kind };
}

function parsePermits(v: unknown): PermitSnapshot | undefined {
  if (!isJsonObject(v) || !isFiniteNumber(v.inUse) || !isFiniteNumber(v.limit) || !isFiniteNumber(v.reserve)) return undefined;
  if (!isJsonObject(v.byKey)) return undefined;
  const byKey: Record<string, PermitKeyState> = {};
  for (const [key, value] of Object.entries(v.byKey)) {
    if (!isJsonObject(value) || !isFiniteNumber(value.inUse) || !isFiniteNumber(value.waiting)) continue;
    const entry: PermitKeyState = { inUse: value.inUse, waiting: value.waiting };
    if (isFiniteNumber(value.limit)) entry.limit = value.limit;
    byKey[key] = entry;
  }
  return { inUse: v.inUse, limit: v.limit, reserve: v.reserve, byKey };
}

function isLastReclaim(v: unknown): boolean {
  if (!isJsonObject(v)) return false;
  const mode = v.mode;
  return (
    isFiniteNumber(v.at) &&
    isFiniteNumber(v.freedGB) &&
    (mode === "pressure" || mode === "idle" || mode === "manual")
  );
}

/** Degrade each known nested field to a usable shape or drop it, mutating the freshly parsed
 * object in place so a well-formed file keeps its values unchanged. */
function normalizeInfoFields(rec: Record<string, unknown>): void {
  const build = parseBuild(rec.build);
  if (build === undefined) delete rec.build;
  else rec.build = build;

  const demoted = parseDemotion(rec.fallbackDemoted);
  if (demoted === undefined) delete rec.fallbackDemoted;
  else rec.fallbackDemoted = demoted;

  const demotions = rec.fallbackDemotions;
  if (!isJsonObject(demotions)) delete rec.fallbackDemotions;
  else {
    for (const [key, value] of Object.entries(demotions)) {
      const parsed = parseDemotion(value);
      if (parsed === undefined) delete demotions[key];
      else demotions[key] = parsed;
    }
  }

  const budget = rec.budget;
  if (!isJsonObject(budget) || !isFiniteNumber(budget.spentUsd)) delete rec.budget;

  if (rec.chain !== undefined && !isJsonObject(rec.chain)) delete rec.chain;

  if (rec.stopsAt !== undefined && !isFiniteNumber(rec.stopsAt)) delete rec.stopsAt;

  const permits = parsePermits(rec.permits);
  if (permits === undefined) delete rec.permits;
  else rec.permits = permits;

  const providerHolds = rec.providerHolds;
  if (!Array.isArray(providerHolds)) delete rec.providerHolds;
  else {
    const kept: Array<{ provider?: string; until: number; kind: string }> = [];
    for (const value of providerHolds) {
      const parsed = parseProviderHold(value);
      if (parsed !== undefined) kept.push(parsed);
    }
    rec.providerHolds = kept;
  }

  const disk = rec.disk;
  if (
    !isJsonObject(disk) ||
    !isFiniteNumber(disk.freeGB) ||
    !isFiniteNumber(disk.holdGB) ||
    !isFiniteNumber(disk.reclaimGB) ||
    typeof disk.held !== "boolean"
  ) {
    delete rec.disk;
  } else if (disk.lastReclaim !== undefined && !isLastReclaim(disk.lastReclaim)) {
    delete disk.lastReclaim;
  }
}

/** Publish the running orchestrator's info file atomically (writeJsonAtomic's tmp + rename).
 * The only writer of that path, so a process killed mid-write — the orchestrator's own poll
 * publishes budget/disk/build changes while `tumwater run` in another terminal reads it to
 * refuse a second team — leaves either the previous complete file or the new one, never a
 * torn body that readOrchestratorInfo reports as no running orchestrator. */
export function writeOrchestratorInfo(root: string, info: OrchestratorInfo): void {
  writeJsonAtomic(orchestratorStatePath(root), info);
}

/** Publish the info file for a caller on a path that must not throw — the orchestrator's
 * catch-less poll loop, whose build/budget/disk updates run every couple of seconds. The info
 * file is an observation surface, not team state: an unwritable state dir (ENOSPC, EACCES, the
 * path replaced by a directory) must degrade the published snapshot, not end the team. The
 * failure is reported as a best-effort warning; the caller keeps polling and the field is
 * retried the next time its value changes. Startup's first write stays strict
 * (writeOrchestratorInfo): it is what refuses a second team, so a repo that cannot publish it
 * must fail fast rather than boot. */
function writeOrchestratorInfoBestEffort(root: string, info: OrchestratorInfo): void {
  try {
    writeOrchestratorInfo(root, info);
  } catch (err) {
    warnEventBestEffort(root, TUMWATER_SOURCE, `could not publish orchestrator info: ${errorMessage(err)}`);
  }
}

/** True when the recorded orchestrator's pid is still alive (see pidAlive). Callers that have
 * already loaded the info file may pass it in to avoid a second read — snapshot() loads it once
 * per poll and uses it for both the displayed pid and this liveness check. */
export function orchestratorAlive(root: string, info?: OrchestratorInfo | null): boolean {
  const i = info ?? readOrchestratorInfo(root);
  if (!i) return false;
  return pidAlive(i.pid);
}
