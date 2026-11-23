/** The orchestrator info file's contract module: `OrchestratorInfo` — everything
 * `.tumwater/state/orchestrator.json` carries, with the nested shapes its readers match — split
 * out of `team-orchestrator-info.ts` the way `status-types.ts` sits beside
 * `src/status/status-data.ts` (and `src/report/report-types.ts` beside `report-data.ts`), so the
 * separate-process observers (status, GUI, doctor, role view) depend on the published shape
 * without importing the module that reads, normalizes and writes the file. Pure types: no logic,
 * no module-level state (the stat cache and the parsers stay in team-orchestrator-info.ts). */
import type { ModelTier } from "../config/config-schema.js";
import type { BuildStatus } from "../build/build-info.js";
import type { FallbackDemotion } from "../budget/fallback-breaker.js";

/** Why the position before a tier's active chain step cannot run. */
type ChainReason = "window" | "reserve" | "cap" | "step-cap" | "overage" | "demoted" | "model-check";

/** Where one tier runs while the budget gate has it off its primary (budget-gates.ts's
 * chainInfo): `step` of `of` in the supplying tier's chain, 1-based. A tier whose primary
 * failed its model check reads `model-check`, at any spend. */
export interface ChainTierInfo {
  pair: string;
  step: number;
  of: number;
  reason: ChainReason;
  /** When the blocked position returns (epoch ms); absent for `demoted`, `overage` and
   * `model-check`. */
  returnsAt?: number;
  spentUsd?: number;
  capUsd?: number;
}

/** The permit pool's published state (plans/provider-concurrency.md §8): the team total's
 * in-use/cap and the maintenance reserve. The orchestrator publishes it through the info
 * file so observers (status, GUI) render the same facts without coupling to the
 * scheduler's Semaphore. */
export interface PermitSnapshot {
  inUse: number;
  limit: number;
  reserve: number;
  /** A permit wait in progress: each parked waiter's scheduling tier and how long it has
   * waited (BUGS.md 2026-11-08). The semaphore writes `provider_wait` only when a wait ENDS,
   * so a live tier-1 starve would otherwise leave the doctor's provider-contention view
   * silent until it ends; publishing the live waiters lets the doctor count and age one.
   * Array entries are `{ tier, waitingMs }` (semaphore.ts's `snapshot`). */
  waiting?: Array<{ tier: number; waitingMs: number }>;
}

/** The check-permit pool's published state (src/concurrency/check-permit.ts checkPermitSnapshot):
 * checks running, the maxConcurrentChecks cap, and checks waiting for a permit. */
export interface CheckPermitSnapshot {
  inUse: number;
  limit: number;
  waiting: number;
}

/** The workspace pool's live state (src/git/worktree-pool.ts `slotPoolSnapshot`): slots leased,
 * the `worktreeSlots` budget, and runs waiting for a slot. */
export interface SlotPoolSnapshot {
  leased: number;
  limit: number;
  waiting: number;
}

/** One provider/model pair's model check as the orchestrator publishes it
 * (src/model-check/model-check-gate.ts): its status, the seams that run on it (role ids, plus
 * `review`, `resolver`, `director` and `fallback:<tier>` labels), and — after a failed probe —
 * why, the reply's excerpt, and when the next probe starts. */
export interface ModelCheckInfo {
  pair: string;
  status: "checking" | "verified" | "failed";
  seams: string[];
  failures?: number;
  reason?: string;
  reply?: string;
  detail?: string;
  probeAt?: number;
  checkedAt?: number;
  /** The persisted verdict store's own stamp (epoch ms, .tumwater/state/model-checks.json): on
   * every row so an observer can tell a verdict read from disk at restart from one probed in
   * this process. */
  savedAt?: number;
}

/** The disk floor's measured state as the orchestrator publishes it into its info file
 * (src/gates/gate-polls.ts, plans/disk-floor.md part 4/4): observers cannot call statfs in step
 * with the poll, so the orchestrator writes what it measured. `freeGB` rounds to one decimal;
 * `held` is the current hold from the poll's disk gate; `lastReclaim` is absent until a reclaim
 * pass has run. A load drops a `disk` lacking finite numbers or a boolean `held`, or carrying
 * an invalid `lastReclaim` (src/team/team-orchestrator-info.ts `normalizeDisk`). */
export interface DiskStatus {
  freeGB: number;
  /** The configured `diskHoldGB` floor the `held` flag is measured against. */
  holdGB: number;
  /** The configured `diskReclaimGB` threshold a pressure pass cleans below. */
  reclaimGB: number;
  held: boolean;
  /** The most recent reclaim pass — its instant, what triggered it, and how much it freed. */
  lastReclaim?: { at: number; mode: "pressure" | "idle" | "manual"; freedGB: number };
}

/** The running orchestrator's info file (.tumwater/state/orchestrator.json): who is driving
 * the team, since when, and with which roles. Written by runOrchestrator; read here so
 * observers (status, GUI) never depend on the scheduler module itself. */
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
   * backend failed the breaker's failureLimit consecutive role runs, so the scheduler reads the
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
   * charged run-by-run as each pi run folds, not only at the run-end save — against the
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
  /** The `tumwater start --for` window's deadline (epoch ms): when the team stops itself. Absent
   * for an unbounded run or a `--once` round. Written once at startup, so every self-redeploy
   * generation publishes the same inherited deadline. */
  stopsAt?: number;
  /** The permit pool's live state (plans/provider-concurrency.md §8): the team in-use/cap,
   * the maintenance reserve, and each referenced provider key's in-use/cap/waiting. Written
   * by the orchestrator's poll whenever it changes, like `budget` and `disk`; absent when the
   * running orchestrator predates it or there is no pool. */
  permits?: PermitSnapshot;
  /** The check-permit pool's live state: checks running, the cap, and checks waiting. Written
   * by the orchestrator's poll whenever it changes; absent when the running orchestrator predates
   * it. */
  checkPermits?: CheckPermitSnapshot;
  /** The workspace pool's live state: leased slots, the `worktreeSlots` budget and the runs
   * waiting for one. Written by the orchestrator's poll whenever it changes; absent when the
   * running orchestrator predates it. */
  slotPool?: SlotPoolSnapshot;
  /** The standing per-provider failure holds (src/team/team-hold.ts `standingHolds`): a
   * provider storm's hold, as the orchestrator's poll publishes them, so the status snapshot
   * and the alert banner name why held providers hold. An entry's `provider` is omitted for
   * pi's default backend. Written by the orchestrator's poll whenever a hold opens or lifts;
   * absent while none stands. */
  providerHolds?: Array<{ provider?: string; until: number; kind: string }>;
  /** Every pair the model check tracks (src/model-check/model-check-gate.ts), in the order the
   * seams resolve: whether a probe showed it can answer, and the seams it serves. Written by
   * the orchestrator's poll whenever a verdict or the pair set changes; absent when the check
   * is off (a `--once` round, an in-process test without a prober). */
  modelChecks?: ModelCheckInfo[];
}
