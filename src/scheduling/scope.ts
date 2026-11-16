/** One poll's per-runner scope precompute, built by orchestrator-scheduling.ts's
 * pollRunnerReasons: the shared pass context and the values computed once per poll before the
 * per-runner loop — the merge-queue snapshot, the director pin, per-base claim groups, the
 * gate predicates, and the mutable admission state (quota counter, ordered runners, eligible
 * memo, reasons map). Parts 2/3 and 3/3 lift the loop's skip and admit halves against this
 * scope. */
import { increment } from "../collections.js";
import { claimOf } from "../git/commit-message.js";
import type { RoleRunner } from "../runner/runner.js";
import type { OnceRound } from "./once-round.js";
import type { WorkMergedCache } from "./work-merged-cache.js";
import { DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import { HOUR_MS } from "../text/datetime.js";
import type { MaintenanceQuotaVerdict } from "../gates/maintenance-quota-gates.js";
import { INSTANCE_ROLES, baseRoleOf, runnerEnabled, runnerPaused } from "../roles/runner-ids.js";
import { hasOutstandingWork, saveRunnerStateBestEffort, type SkipReason } from "../runner/runner-state.js";
import { MERGE_CONFLICT_LIMIT } from "../runner/runner-leftover.js";
import { queuedMerges } from "../merge/merge-queue.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { commitExists, commitMessage, isMergedInto, refSha } from "../git/git.js";
import { queuedMergeRoles } from "../merge/merge-queue.js";
import { mergeRefName } from "../paths.js";
import { type EligibleEntry, eligibleEntries } from "../backlog/backlog-eligibility.js";
import {
  CLAIM_IDLE_MAX_MS,
  claimReleaseReason,
  dropWithdrawnWork,
  heldKeys,
  listedKeys,
  withdrawnWorkWarning,
  type ClaimReleaseReason,
} from "./claims.js";
import { deleteRef } from "../git/git.js";
import { rejectedRefName } from "../paths.js";

/** One poll's gate verdicts and context, exactly the local view the poll body holds when
 * the scheduling pass runs (TeamGatePoll's fields beside the pass's own inputs). */
export interface SchedulingPassCtx {
  root: string;
  /** The branch the team merges into ("main") — the pass's leftover-pin and branch-ahead
   * checks read the director's branch against it. */
  mainBranch: string;
  runners: readonly RoleRunner[];
  once: OnceRound;
  now: number;
  mainHead: string;
  userPaused: boolean;
  quietNow: boolean;
  pausedRoles: ReadonlySet<string>;
  capPaused: ReadonlySet<string>;
  /** The roles the new-project bootstrap holds (plans/work-ratio.md, part 2/2). */
  bootstrapHeld: ReadonlySet<string>;
  /** The maintenance allowance's verdict this poll (plans/work-ratio.md, part 1b/4): `allowance`
   * is what the rolling window permits and `used` is the merged maintenance count plus the
   * maintenance roles already in flight. The pass admits at most the remaining
   * `allowance - used` due maintenance roles, so the headroom is never overshot within a poll. */
  maintenanceQuota: MaintenanceQuotaVerdict;
  /** The roles (the director excluded) whose own `quietHoursPerRole` window holds right now. */
  roleQuietHeld: ReadonlySet<string>;
  /** The roles (the director excluded) whose budget tier resolved to pause while the cap is
   * reached (part 5c/8, gate-polls.ts's budgetPausedRoles): a role in this set starts no new
   * run beside the per-role cap set — unless its tier is the one a due probe tests
   * (probeRoles), which pierces the hold for exactly the probed pair's own tier. */
  budgetPausedRoles: ReadonlySet<string>;
  /** The roles whose model tier resolves to the probed pair (part 5c/8): the ONLY roles the
   * budget hold exempts this poll, and the only runners the launch pass may admit as the
   * probe. A probe blind to the pair's tier lifted the pause for every role (an objection to
   * an earlier draft of this pass). */
  probeRoles: ReadonlySet<string>;
  /** The providers whose team-wide failure hold stands (team/team-hold.ts heldProviders —
   * `until` non-null; key presence is relapse memory, not a hold). A role starts no new
   * run while ITS provider is held (the director exempt). */
  heldProviders: ReadonlySet<string | undefined>;
  /** The subset of `heldProviders` held by a subscription window (team-hold.ts
   * windowHeldProviders): the one hold the director is NOT exempt from. */
  windowHeldProviders: ReadonlySet<string | undefined>;
  /** Each runner's run model provider (configForRole at poll time): the key the
   * heldProviders check reads for that role. */
  roleProviders: ReadonlyMap<string, string | undefined>;
  /** The pairs currently under a model-load hold (team-hold.ts heldPairs) and each runner's
   * run pair (the runner's state pair): the pair-scoped keys the skip guard's heldStarts reads
   * so a model-load hold stops only the roles on the failed pair, not the provider. */
  heldPairs: ReadonlySet<string>;
  rolePairs: ReadonlyMap<string, string>;
  /** BUGS.md `## Open` non-empty (backlog.ts's openBugs), read once per poll by the poll body. */
  openBugsNow: boolean;
  /** A pending self-redeploy hold: nothing new starts, on any role. */
  holdForRestart: boolean;
  /** The disk floor holds new work (plans/disk-floor.md, part 1/4): like a restart, nothing new
   * starts on any role — the director included — until free space recovers. */
  diskHeld: boolean;
  /** PLANS.md `## Planned` or BUGS.md `## Open` non-empty, read once per poll by the poll body. */
  workBacklogOpen: boolean;
  /** PLANS.md already holds the plan role's eligible-plan target (planBacklogFull). */
  planBacklogFull: boolean;
  /** Per-role deferred-due memory (one-shot run_deferred events), advanced in place. */
  deferredDue: Map<string, boolean>;
  workMergedSince: WorkMergedCache;
  /** The roles the model check holds (src/model-check/model-check-gate.ts): a due role whose
   * next run's pair is not verified waits with the `model-check` skip reason. The reviewer's
   * verdict is not here — it parks only the no-role post-merge review drain. Absent while the
   * check is off. */
  modelCheckHeld?: ReadonlySet<string>;
}

/** A base role's compiled claim group (part 4/7, per-base, computed once per poll). */
interface ClaimGroup {
  eligible: EligibleEntry[];
  eligibleKeys: Set<string>;
  held: Set<string>;
  /** A group whose runner is mid-entry with no recorded claim holds the whole group's
   * assignment until that runner settles (see buildSchedulingScope). */
  hold: boolean;
}

/** One poll's shared scheduling state: the pass metadata and the once-per-poll precompute the
 * per-runner loop reads — and the mutable admission state the loop advances in place. */
export interface SchedulingScope {
  root: string;
  runners: readonly RoleRunner[];
  once: OnceRound;
  now: number;
  mainHead: string;
  userPaused: boolean;
  quietNow: boolean;
  pausedRoles: ReadonlySet<string>;
  capPaused: ReadonlySet<string>;
  bootstrapHeld: ReadonlySet<string>;
  maintenanceQuota: MaintenanceQuotaVerdict;
  budgetPausedRoles: ReadonlySet<string>;
  probeRoles: ReadonlySet<string>;
  roleQuietHeld: ReadonlySet<string>;
  heldProviders: ReadonlySet<string | undefined>;
  windowHeldProviders: ReadonlySet<string | undefined>;
  roleProviders: ReadonlyMap<string, string | undefined>;
  heldPairs: ReadonlySet<string>;
  rolePairs: ReadonlyMap<string, string>;
  openBugsNow: boolean;
  workBacklogOpen: boolean;
  planBacklogFull: boolean;
  holdForRestart: boolean;
  diskHeld: boolean;
  deferredDue: Map<string, boolean>;
  workMergedSince: WorkMergedCache;
  modelCheckHeld: ReadonlySet<string>;
  /** The director holds a kept merge pin: owed an authoring run to re-pin it. */
  pinnedDirector: boolean;
  claimGroups: Map<string, ClaimGroup>;
  /** Each claim-taking base's entries its OWN queued merges already claim (keyed by base):
   * the keys the poll must not hand back to the authoring runner, and that stay held for the
   * group even after the authoring runner's claim is released (the merge-queue claim record
   * is what the merge's withdrawn check reads). */
  queuedMergeClaims: Map<string, Set<string>>;
  /** Runs writing code per multi-runner base role, advanced in place by the loop. */
  writing: Map<string, number>;
  ownsOutstanding: (r: RoleRunner) => boolean;
  ordered: RoleRunner[];
  eligibleMemo: Map<string, EligibleEntry[]>;
  reasons: Map<RoleRunner, string | undefined>;
  /** The one-poll maintenance admission budget, advanced in place by the loop. */
  quotaAdmitted: number;
  budgetHolds: (role: string) => boolean;
  operatorPauseBlocks: (role: string) => boolean;
  bootstrapHeldNow: (runner: RoleRunner, demand: boolean) => boolean;
  maintenanceQuotaOverLine: (runner: RoleRunner, demand: boolean) => boolean;
}

/** Record why the poll skipped a due role on its state (RunnerState.skipReason), saving only when
 * the value changes: a skipped role gets no run to save its own state, and a role that stays
 * skipped must not rewrite its file every poll. */
export function noteSkip(root: string, runner: RoleRunner, reason: SkipReason | undefined): void {
  if (runner.state.skipReason === reason) return;
  runner.state.skipReason = reason;
  saveRunnerStateBestEffort(root, runner.state);
}

/** The merge queue's claim records, keyed by the authoring runner's base role: every entry a
 * queued or pinned change of that base already claims. The record, not the runner's live
 * claim, is what the merge's withdrawn check reads, so this set is what keeps a released
 * claim's entry held for the group while the change waits. A changed fresh run now leaves
 * only its merge pin (part 3e/7), so a pin with no queue file is read back through its
 * commit's Claim trailer; a missing queue dir reads as nothing queued, like every reader in
 * merge-queue.ts. */
async function queuedMergeClaimKeys(root: string, runners: readonly RoleRunner[]): Promise<Map<string, Set<string>>> {
  const byBase = new Map<string, Set<string>>();
  const roleBases = new Map<string, string>();
  for (const r of runners) roleBases.set(r.role, baseRoleOf(r.role));
  const add = (role: string, key: string): void => {
    const base = roleBases.get(role) ?? baseRoleOf(role);
    if (!INSTANCE_ROLES.has(base)) return;
    let set = byBase.get(base);
    if (set === undefined) {
      set = new Set<string>();
      byBase.set(base, set);
    }
    set.add(key);
  };
  for (const e of queuedMerges(root)) {
    if (e.claim === undefined) continue;
    add(e.role, e.claim.key);
  }
  // A pin-only writer has no queue file to read, so the Claim trailer stamped on its commit
  // (part 3j/7) is its queue record. A role that still holds a queue file is already covered
  // above, and a pin with no Claim trailer simply holds nothing (a user-request run).
  const queuedRoles = queuedMergeRoles(root);
  for (const r of runners) {
    if (queuedRoles.has(r.role) || !INSTANCE_ROLES.has(baseRoleOf(r.role))) continue;
    const sha = await refSha(root, mergeRefName(r.role)).catch(() => null);
    if (!sha) continue;
    const message = await commitMessage(root, sha).catch(() => null);
    const claim = message === null ? undefined : claimOf(message);
    if (claim !== undefined) add(r.role, claim.key);
  }
  return byBase;
}

/** Parallel work instances (plans/parallel-work-instances.md "Claims", part 4/7): a base role
 * with more than one runner assigns each due instance a distinct eligible entry, and releases
 * the claims whose entry left, turned ineligible, was disabled or went stale — or that the
 * runner's own queued merge already recorded (`queued`). Computed once per poll and only for a
 * multi-runner base, so a single-runner team is unchanged. The release runs before the pass's
 * per-runner assignment, so a freed key counts as free. */
async function collectClaimGroups(
  root: string,
  runners: readonly RoleRunner[],
  pausedRoles: ReadonlySet<string>,
  now: number,
  queuedMergeClaims: Map<string, Set<string>>,
): Promise<Map<string, ClaimGroup>> {
  const claimGroups = new Map<string, ClaimGroup>();
  const baseCounts = new Map<string, number>();
  for (const runner of runners) {
    const base = baseRoleOf(runner.role);
    increment(baseCounts, base);
  }
  for (const [base, count] of baseCounts) {
    if (count <= 1) continue;
    const groupRunners = runners.filter((r) => baseRoleOf(r.role) === base);
    const eligible = eligibleEntries(root, base);
    const eligibleKeys = new Set(eligible.map((e) => e.key));
    const listed = listedKeys(root, base);
    // A group whose runner is mid-entry with no recorded claim (it took the entry while it was
    // the only runner, before a live reload raised `instances`) cannot be told WHICH entry that
    // is from state alone. Assigning a free entry to a sibling could then hand it the same
    // work: hold the whole group's assignment until that runner settles (merges, drops or goes
    // idle), at which point its own staging may have recorded a claim. A busy runner that DOES
    // hold a claim is fine — `held` excludes its key and siblings take other entries.
    const hold = await releaseClaims(
      root,
      groupRunners,
      listed,
      eligibleKeys,
      pausedRoles,
      base,
      now,
      queuedMergeClaims.get(base) ?? new Set<string>(),
    );
    // A released `queued` claim keeps its entry held for the group: the queued merge still
    // claims it, so a sibling must not take it while the change waits (and the merge's
    // withdrawn check reads the queue's own claim record, not the runner's released one).
    const held = heldKeys(groupRunners, eligibleKeys, listed);
    for (const k of queuedMergeClaims.get(base) ?? []) held.add(k);
    claimGroups.set(base, {
      eligible,
      eligibleKeys,
      held,
      hold,
    });
  }
  return claimGroups;
}

/** One claim group's release pass (the poll's "which claims does this poll release?"): for each
 * of the group's runners, record the group hold (a mid-entry runner with no claim), test its
 * claim for a release, and on release persist the runner state, log the release, warn on a
 * stale release, and drop withdrawn work. A claim whose entry the runner's own queued merge
 * already recorded is released as `queued` while it is still listed (the entry leaves the
 * section only when the change merges or is withdrawn, and until then the queue's claim record
 * holds it for the group). Returns whether the group holds. */
async function releaseClaims(
  root: string,
  groupRunners: readonly RoleRunner[],
  listed: Set<string>,
  eligibleKeys: Set<string>,
  pausedRoles: ReadonlySet<string>,
  base: string,
  now: number,
  queuedClaims: Set<string>,
): Promise<boolean> {
  let hold = false;
  for (const r of groupRunners) {
    const busy = r.state.running || hasOutstandingWork(r.state);
    if (r.state.claim === undefined && busy) hold = true;
    const claim = r.state.claim;
    // The run's work is already in the merge queue, the entry is still listed, and the runner
    // owes the entry nothing else (no revision or resume): the queued change IS the entry's
    // work, so the claim is released and the runner may take a different free entry. A running
    // runner or one that still owes a revision/resume keeps its claim: the same-entry run it
    // is about to start IS the owed work.
    if (
      claim !== undefined &&
      !r.state.running &&
      !hasOutstandingWork(r.state) &&
      listed.has(claim.key) &&
      eligibleKeys.has(claim.key) &&
      queuedClaims.has(claim.key)
    ) {
      await applyClaimRelease(root, r, "queued");
      continue;
    }
    const released = claimReleaseReason(r, {
      listedKeys: listed,
      eligibleKeys,
      now,
      // Per instance, not per base role: a lowered `instances` leaves the surplus runner in
      // place with `runnerEnabled` false, and its idle claim must be released so a sibling can
      // take the entry instead of the key staying held until the 24h stale sweep.
      enabled: runnerEnabled(r.config, r.role),
      // Only this instance paused (not its whole role; instance 1 under `<role>-1`): a sibling
      // can take the entry. With the base role paused no sibling runs, so the claim stays.
      paused: runnerPaused(pausedRoles, r.role) && !pausedRoles.has(base),
    });
    if (released === null) continue;
    await applyClaimRelease(root, r, released);
  }
  return hold;
}

/** Land one claim release: clear the runner's claim, drop withdrawn work, persist the state so
 * a dead claim does not stay on disk for status/doctor or a restart, log the release, and warn
 * on a stale release. */
async function applyClaimRelease(root: string, r: RoleRunner, reason: ClaimReleaseReason): Promise<void> {
  const claim = r.state.claim;
  const title = claim?.title ?? "";
  const file = claim?.file ?? "PLANS.md";
  r.state.claim = undefined;
  // The entry left main while this runner still owed it a resume or a revision: the operator
  // withdrew it (or another change took it). Drop that work with the claim, so the run that
  // resumes is never the withdrawn one, and let this same poll assign the runner its next
  // free entry.
  if (reason === "withdrawn" && claim !== undefined) {
    const dropped = dropWithdrawnWork(r.state, claim);
    if (dropped.revision) await deleteRef(root, rejectedRefName(r.role));
    warnEventBestEffort(root, r.role, withdrawnWorkWarning(title, file, dropped));
  }
  // Persist the release: an idle extra instance gets no run to save its state, so the dead
  // claim would stay on disk for status/doctor to show and for a restart to release again.
  saveRunnerStateBestEffort(root, r.state);
  logEventBestEffort(root, { source: r.role, type: "claim", action: "released", title, reason });
  if (reason === "stale") {
    warnEventBestEffort(
      root,
      r.role,
      `released "${title}", which a stopped instance was working on (idle ${Math.round(CLAIM_IDLE_MAX_MS / HOUR_MS)}h)`,
    );
  }
}

/** Runs writing code per multi-runner base role (plans/fast-merge.md "Lever 1"): a runner in
 * flight, not one whose change waits in the merge queue. `instances` limits this count, so the
 * role's extra runner ids start work only while fewer than `instances` are running; admissions
 * this poll count at once, so one pass cannot overshoot. */
function countWriters(
  runners: readonly RoleRunner[],
  claimGroups: Map<string, ClaimGroup>,
): Map<string, number> {
  const writing = new Map<string, number>();
  for (const r of runners) {
    if (claimGroups.has(baseRoleOf(r.role)) && r.state.running) {
      increment(writing, baseRoleOf(r.role));
    }
  }
  return writing;
}

/** Whether a runner of a multi-runner base holds outstanding work: its base has a claim group
 * and its state carries a pending revision or conflict hand-back. */
function ownsOutstandingWork(
  runner: RoleRunner,
  claimGroups: Map<string, ClaimGroup>,
): boolean {
  return claimGroups.has(baseRoleOf(runner.role)) && hasOutstandingWork(runner.state);
}

/** Admission order: a runner of a multi-runner base with a pending revision or conflict
 * hand-back comes first (its change came back; it holds no new claim), then the rest in runner
 * order, so the lowest-index free runner takes new work. Other roles keep their place. */
function orderForAdmission(
  runners: readonly RoleRunner[],
  claimGroups: Map<string, ClaimGroup>,
): RoleRunner[] {
  return [
    ...runners.filter((r) => ownsOutstandingWork(r, claimGroups)),
    ...runners.filter((r) => !ownsOutstandingWork(r, claimGroups)),
  ];
}

/** Whether the director is owed a leftover run over its merge pin — a read-only classification
 * of the pin's sha against the pass's main branch and the director's own conflict streak.
 *
 * The pin alone (hasUnmergedPin) used to be the whole answer, and that was the bug: a run now
 * leaves only its pin (part 3e/7 writes no queue file), so a FRESH run's live pin read as
 * "pinned" and the pass's `leftover` reason admitted a run on every poll; each run's leftover
 * recovery re-pinned the same sha and ended `skipped` — the queue waited on a run the queue
 * itself would have answered, hundreds of wasted runs on a 1–2 h queue wait (BUGS.md
 * 2026-11-04 and 2026-11-09, the same spin with and without a second commit). The 2026-11-04
 * fix keyed the suppression off the merge queue's directory — a source a fresh run no longer
 * writes — so in production the queued check was a dead read and the spin returned.
 *
 * The fix classifies the pin the way the DRAIN settles it, but read-only. The drain's own
 * decision (pinnedRetrySha) retries a pin only when it is present, not stale, and under
 * MERGE_CONFLICT_LIMIT — it settles that pin on its own and leaves everything else to the
 * author. This predicate mirrors that decision without its side effects: it must NOT call
 * pinnedRetrySha, whose ref-drop of a stale or dangling pin would corrupt a schedule-only pass
 * (the real poll runs the drain first, but the tests drive the pass in isolation), and it must
 * NOT read readMergePins, which lists every live pin and cannot tell a draining one from a kept
 * one. The three classes:
 *   - stale — main already holds the sha (a crash skipped the un-pin after the merge): OWES a
 *     run; recovery deletes it and continues, so the classification leaves it present;
 *   - draining — live ahead of main and under the cap (a fresh run's change, or one the drain
 *     is mid-retrying): the drain settles it, so the director OWES NO run. This is the spin, gone;
 *   - kept — live at the cap: the drain refuses it (the author's conflict hand-back), so it
 *     OWES a run, which the pass's skip.ts guard then admits or suppresses by hand-back.
 * `pinnedDirector` is true for the stale and kept cases (a present pin that is not draining).
 *
 * The claim-reading `queuedMergeClaimKeys` is a separate reader and is deliberately NOT part of
 * this change: it sources instance-role claims from the pin's Claim trailer (its pin loop) and
 * the legacy queue file, and converting it to readMergePins would drop the `claim` field it
 * exists to serve. Its legacy queue-file loop is trimmed by part 6/6 (the deletion). */
async function directorPinOwedRun(ctx: SchedulingPassCtx): Promise<boolean> {
  const { root, runners, mainBranch } = ctx;
  const sha = await refSha(root, mergeRefName(DIRECTOR_ROLE)).catch(() => null);
  if (sha === null) return false; // no pin at all: the director owes no run
  const streak = runners.find((r) => r.role === DIRECTOR_ROLE)?.state.mergeConflicts;
  const attempts = streak?.sha === sha ? streak.count : 0;
  const present = await commitExists(root, sha).catch(() => false);
  const stale = present && (await isMergedInto(root, sha, mainBranch));
  const draining = present && !stale && attempts < MERGE_CONFLICT_LIMIT;
  return !draining;
}

/** Compute the once-per-poll precompute the scheduling pass's per-runner loop reads. Has the
 * same side effects the poll body's own precompute had: the merge-queue snapshot, the
 * director-pin check, the per-base claim-group build (with its claim-release loop,
 * which mutates runner state, persists and logs), and the writing count. */
export async function buildSchedulingScope(ctx: SchedulingPassCtx): Promise<SchedulingScope> {
  const {
    root,
    runners,
    once,
    now,
    mainHead,
    userPaused,
    quietNow,
    pausedRoles,
    capPaused,
    maintenanceQuota,
    bootstrapHeld,
    budgetPausedRoles,
    probeRoles,
    roleQuietHeld,
    heldProviders,
    windowHeldProviders,
    roleProviders,
    heldPairs,
    rolePairs,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    holdForRestart,
    diskHeld,
    deferredDue,
    workMergedSince,
  } = ctx;
  // The director's merge pin, classified as stale / draining / kept (see directorPinOwedRun):
  // a live pin under the conflict cap is DRAINING (the drain settles it, owes no run) — the
  // 2026-11-04/11-09 spin, gone; a stale pin or a kept pin at the cap owes the run, which the
  // pass's skip guard then splits by hand-back.
  const pinnedDirector = await directorPinOwedRun(ctx);
  const queuedMergeClaims = await queuedMergeClaimKeys(root, runners);
  const claimGroups = await collectClaimGroups(root, runners, pausedRoles, now, queuedMergeClaims);
  // The team gates' block predicate (the director exempt — an explicit human prompt
  // outranks any autonomous gate, quiet hours included): the once-mode settle below and
  // the start gate must agree on exactly when a team gate holds, so the compound lives
  // here once. Quiet hours fold in beside the operator pause and the budget gate — the
  // schedule is not probe-worthy the way a paused budget is, so no probeDue exception.
  // The per-role windows (quietHoursPerRole) fold in beside the team one as a fourth
  // disjunct — a role held by either window (or both, held once) starts no new runs;
  // the director stays exempt by the same role check that covers the other disjuncts.
  // The budget hold, per role (part 5c/8): a tier that resolved to pause holds its own
  // roles. The probe of a demoted pair pierces the hold for EXACTLY the probed pair's tier's
  // roles: the earlier draft's pair-blind pierce lifted the pause team-wide on any due probe.
  const budgetHolds = (role: string): boolean => budgetPausedRoles.has(role) && !probeRoles.has(role);
  const operatorPauseBlocks = (role: string): boolean =>
    (userPaused || quietNow || roleQuietHeld.has(role) || budgetHolds(role)) &&
    role !== DIRECTOR_ROLE;
  // Fresh operator demand: a queued prompt or a wake newer than the role's last run end. The
  // same override the need-based deferral honors (an explicit "try again now" is not idle
  // maintenance); shared by the bootstrap and maintenance-allowance holds so the two cannot
  // drift on what counts as demand. Computed ONCE per runner per poll (the scheduling loop's
  // per-runner `demand`), so a role's queue is listed a single time a poll instead of once per
  // hold check; every consumer takes the boolean rather than re-calling inboxSize.
  // The new-project bootstrap hold (part 2/2): held unless the role has a fresh operator wake
  // or a queued prompt.
  const bootstrapHeldNow = (runner: RoleRunner, demand: boolean): boolean =>
    bootstrapHeld.has(runner.role) && !demand;
  // The maintenance allowance's team-level hold (part 1b/4): `used` has reached `allowance`,
  // so no maintenance role starts unless it carries demand (`tumwater wake <maintenance-role>`
  // gets exactly one run). The per-poll admission headroom is spent separately, after each
  // role's due check, where the pass knows what actually runs; the verdict alone cannot.
  const maintenanceQuotaOverLine = (runner: RoleRunner, demand: boolean): boolean =>
    commitTier(baseRoleOf(runner.role)) === "maintenance" &&
    maintenanceQuota.used >= maintenanceQuota.allowance &&
    !demand;
  const writing = countWriters(runners, claimGroups);
  const ownsOutstanding = (r: RoleRunner): boolean => ownsOutstandingWork(r, claimGroups);
  const ordered = orderForAdmission(runners, claimGroups);
  // The stand-down's eligible lists per base role, read at most once per poll (see the check
  // below).
  const eligibleMemo = new Map<string, EligibleEntry[]>();
  return {
    root,
    runners,
    once,
    now,
    mainHead,
    userPaused,
    quietNow,
    pausedRoles,
    capPaused,
    maintenanceQuota,
    bootstrapHeld,
    budgetPausedRoles,
    probeRoles,
    roleQuietHeld,
    heldProviders,
    windowHeldProviders,
    roleProviders,
    heldPairs,
    rolePairs,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    holdForRestart,
    diskHeld,
    deferredDue,
    workMergedSince,
    modelCheckHeld: ctx.modelCheckHeld ?? new Set<string>(),
    pinnedDirector,
    claimGroups,
    queuedMergeClaims,
    writing,
    ownsOutstanding,
    ordered,
    eligibleMemo,
    reasons: new Map<RoleRunner, string | undefined>(),
    quotaAdmitted: 0,
    budgetHolds,
    operatorPauseBlocks,
    bootstrapHeldNow,
    maintenanceQuotaOverLine,
  };
}
