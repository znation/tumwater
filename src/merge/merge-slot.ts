// vocabulary: plain
import { dropMerge, enqueueMerge, queuedMerges, type MergeEntry } from "./merge-queue.js";
import { RETRIABLE_MERGE_RESULTS } from "./merge-core.js";
import { pinnedRetrySha } from "../runner/leftover.js";
import { branchHead } from "../git/git.js";
import { cachedBaselineVerdict } from "../baseline/main-baseline.js";
import type { TickResult } from "../run/run-outcome.js";
import { runCostIsReal, type PiRunResult } from "../pi/pi-run-result.js";
import { reviewRunConfig, seamHoldKey, seamPairName } from "../config/config-views.js";
import { saveRunnerState, type RunnerState } from "../runner/runner-state.js";
import { applyMergeOutcome, ERROR_STREAK_WARN } from "../run/run-apply.js";
import { observeClaudeAccount } from "../agent/claude/claude-account.js";
import { logEventBestEffort, usageFragment, warnEventBestEffort } from "../events/events.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject, nonNegativeNumber } from "../files/json-object.js";
import { removeQuiet } from "../files/files.js";
import { mergeStatePath } from "../paths.js";
import type { RoleRunner } from "../runner/runner.js";
import type { PermitWaitHooks } from "../concurrency/check-permit.js";
import { consecutiveFailuresWarning } from "../text/phrases.js";
import { truncate } from "../text/text.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** The merge pipeline's bookkeeping (merge queue 3/5 and 4/5), split out of the drain
 * (merge-drain.ts, which schedules the verifications and the merge) so it lives separate from the
 * merge mechanics themselves (merge-core.ts and merge-batch.ts: review gate, rebase, stack,
 * ff-merge). This module owns the 4/5 in-flight marker — one record per change being verified,
 * approved, or merged — the per-merge usage accounting, and the write-back that folds every
 * outcome into the authoring role's state and drops its queue entry. A merge's pi runs charge
 * to the authoring runner (foldMergeUsage). */

/** What the pipeline is doing with one change right now. A verification opens at `rebasing` (its
 * checkout and rebase onto main) and moves through `build-check` — a deterministic check (the
 * gate's pre-check over the change's tree, its one re-run, and the attribution check of main's
 * tip behind a repeat failure, or a stack's shared check) — and `reviewing`, the adversarial
 * reviewer's pi run, whose live turns/context/tool the dashboards read from the role's raw log;
 * `check-wait` covers any wait for a process-wide check permit (check-permit.ts) before a check
 * starts, so a queued check never reads as a running one. `resolving` is the merge's conflict
 * resolver (merge-to-main.ts's resolveConflict) — a model run whose live detail reads like a
 * reviewer's — and `resolve-wait` the resolver parked for its agent permit before it starts
 * (resolveWaitStage); both used to read as `merging`, so a resolver holding the whole merge
 * queue for minutes looked like a slow fast-forward (2026-10-12). `merging` is the merge slot's
 * own git steps — the stack's assembly, the in-lock re-check's rebase, and the fast-forward onto
 * main. Everything else a merge does (verdict parsing, state saves) is sub-second bookkeeping
 * between these. */
type MergeStage =
  | "rebasing"
  | "check-wait"
  | "build-check"
  | "reviewing"
  | "reviewing-check"
  | "resolve-wait"
  | "resolving"
  | "provider-wait"
  | "merging";

/** How each merge stage names itself in the merge cell. */
export const MERGE_STAGE_LABELS: Record<MergeStage, string> = {
  rebasing: "rebasing",
  "check-wait": "waiting to check",
  "build-check": "checking",
  reviewing: "reviewing",
  "reviewing-check": "reviewing, checking",
  "resolve-wait": "waiting to resolve conflicts",
  resolving: "resolving conflicts",
  "provider-wait": "waiting for the provider",
  merging: "finishing the merge",
};

/** Where one change stands in the merge pipeline (land-queue speed 2c) — the per-change status
 * the marker carries, so each role's row says what the pipeline is doing with ITS change rather
 * than every row reading as one change's merge (BUGS.md 2026-09-23):
 * - `merging`: a verification or the merge is working on it right now — its checkout, rebase,
 *   gate check and review, or the merge's stack check and fast-forward —
 *   `merging <its elapsed> · <stage>`, the only live state (several changes hold it at once:
 *   verifications run in parallel, and a stack merges together);
 * - `approved`: its verification approved it and it waits for the merge slot (or, in an
 *   abandoned stack's one-at-a-time fallback, for its own turn) — `approved, waiting to merge`;
 * - `done`: the merge is finished with it — merged, attributed, or left for the next merge —
 *   and the marker shows nothing for it: its row reads its own state until the record goes.
 * A queued change whose verification is still waiting for a permit has no record at all: its row
 * reads plainly queued. */
export type MergeChangeStatus = "merging" | "approved" | "done";

/** One change's record in the in-flight marker. `startedAt` is stamped when its verification starts
 * and kept through its merge, so its `merging <elapsed>` measures this change's own merge. `stage`
 * is this change's own MergeStage (setMergeStage): `rebasing` when its verification starts, reset
 * to `merging` each time the merge slot moves it back to `merging` (the stack's assembly, a
 * fallback's merge). Keyed by role — invariant 3 caps a role at one in-flight change. */
export interface MergeChange {
  role: string;
  sha: string;
  summary: string;
  status: MergeChangeStatus;
  startedAt?: number;
  stage?: MergeStage;
  /** When this change ENTERED its CURRENT stage (epoch ms) — stamped ONCE on the transition
   * that set `stage`, so the per-stage elapsed a label renders measures only that stage. */
  stageSince?: number;
}

/** The in-flight merge marker (plans/merge-queue.md 4/5): which changes are merging right
 * now, since when, and which stage each is in. The pipeline adds a change's record when its
 * verification starts and removes it after its outcome, so the separate-process observers (status,
 * TUI, GUI) can show the merges without depending on the scheduler module — the OrchestratorInfo
 * precedent. snapshot() cross-checks it with matching queue entries and the orchestrator's
 * liveness, so a stale marker from any crash ordering never displays. `stage` rides the same
 * file rather than a second one — the marker is the one cross-process surface both dashboards
 * already read; the merge path advances it (setMergeStage) and the merge cell renders it
 * (rolePhase). `changes` is the source of truth for every row, one record per change; the
 * top-level fields mirror the first change in `merging`, so an observer from a generation that
 * reads only them still names a change actually in flight, with that change's own start and
 * stage. A marker from an older generation may carry the top-level fields alone (one change) or
 * no stage (the bare elapsed label): read both shapes through mergeChanges. */
export interface MergeInFlight {
  role: string;
  sha: string;
  summary: string;
  startedAt: number;
  stage?: MergeStage;
  stageSince?: number;
  changes?: MergeChange[];
}

/** Publish the in-flight merge marker — the one place its shape is constructed, so the
 * interface is enforced here rather than at each caller's inline `writeJsonFile`: every
 * writer names a stage. Atomic (tmp + rename) because the marker is rewritten mid-merge at
 * every stage and per-change status transition while observers poll it every second — a plain
 * overwrite would let a poll read a torn file as "no merge" and flicker the merge row back
 * to its idle label. */
export function writeMergeMarker(root: string, marker: MergeInFlight & { stage: MergeStage }): void {
  writeJsonAtomic(mergeStatePath(root), marker);
}

/** Read the in-flight merge marker; null when missing or unreadable. Never throws —
 * observers poll it every second, and a torn write (a crash mid-write) must not take them
 * down (the readOrchestratorInfo precedent). */
export function readMergeMarker(root: string): MergeInFlight | null {
  const marker = readJsonFile<MergeInFlight>(mergeStatePath(root));
  if (!marker || typeof marker.role !== "string") return marker;
  const out = { ...marker, role: canonicalRoleId(marker.role) };
  if (Array.isArray(marker.changes)) {
    out.changes = marker.changes.map((c) => (c && typeof c.role === "string" ? { ...c, role: canonicalRoleId(c.role) } : c));
  }
  return out;
}

/** Rewrite the marker after one of its records changed: re-point the top level at the first
 * change in `merging` (see MergeInFlight — left as is while none is), then write it. Never
 * throws: the marker is display-only, and a failed write must not fail a merge (the
 * observers keep the previous frame's record until the next write). */
function rewriteMarker(root: string, marker: MergeInFlight & { changes: MergeChange[] }): void {
  const headline = marker.changes.find((c) => isMergeChange(c) && c.status === "merging");
  if (headline) {
    marker.role = headline.role;
    marker.sha = headline.sha;
    marker.summary = headline.summary;
    marker.startedAt = headline.startedAt ?? marker.startedAt;
    marker.stage = headline.stage ?? "merging";
  }
  try {
    writeMergeMarker(root, { ...marker, stage: marker.stage ?? "merging" });
  } catch {
    /* display-only — see above */
  }
}

/** Read-modify-write one change's record in the live marker — the skeleton setMergeChangeStatus
 * and setMergeStage share: read the marker off disk, hand `apply` the change named by `role`,
 * and write the marker back through rewriteMarker. A read-modify-write of the file, not a
 * rewrite from memory, so the stage a gate last set (the same process) survives. A no-op when
 * there is no marker or it has no record for `role`; `apply` returns whether to write the
 * marker — true when it changed anything, false to skip the write (setMergeStage's guard
 * against re-staging an unchanged stage). Never throws (rewriteMarker). */
function updateMergeChange(
  root: string,
  role: string,
  apply: (change: MergeChange) => boolean,
): void {
  const marker = readMergeMarker(root);
  // A `changes` field that is not an array is as unusable as an absent one — treat it as no
  // per-change records (the legacy shape) and leave the marker untouched, rather than reading
  // `.find` off a scalar and throwing into a live merge.
  if (!marker || !Array.isArray(marker.changes)) return;
  const change = marker.changes.find((c) => isMergeChange(c) && c.role === role);
  if (!change) return;
  if (!apply(change)) return;
  rewriteMarker(root, { ...marker, changes: marker.changes });
}

/** Advance one change's record in the live marker — the verification's move to `approved` and the
 * merge's per-change status hook (BatchContext.onChangeStatus). A read-modify-write of the file,
 * not a rewrite from memory, so the stage a gate last set (setMergeStage, the same process)
 * survives. Each move to `merging` resets the change's stage to `merging` and stamps its
 * `startedAt` if it has none. A no-op when there is no marker or it has no record for `role`.
 * Never throws (rewriteMarker). */
export function setMergeChangeStatus(root: string, role: string, status: MergeChangeStatus): void {
  updateMergeChange(root, role, (change) => {
    change.status = status;
    if (status === "merging") {
      change.startedAt ??= Date.now();
      change.stage = "merging";
    }
    return true;
  });
}

/** Add one change's record as its verification starts: each change is its own task, so records come
 * and go one at a time. The new record starts `merging` at `rebasing` with its own `startedAt` (a
 * verification opens with its checkout and rebase onto main). Every other record is kept only while
 * its role is in `live` — the roles the pipeline holds right now — so a record a crashed generation
 * left behind never rides along. Never throws (rewriteMarker). */
export function addMergeChange(root: string, entry: MergeEntry, live: ReadonlySet<string>): void {
  const marker = readMergeMarker(root);
  const kept = marker ? mergeChanges(marker).filter((c) => c.role !== entry.role && live.has(c.role)) : [];
  const startedAt = Date.now();
  const change: MergeChange = {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    status: "merging",
    startedAt,
    stage: "rebasing",
    stageSince: startedAt,
  };
  rewriteMarker(root, {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    startedAt,
    stage: "rebasing",
    stageSince: startedAt,
    changes: [...kept, change],
  });
}

/** Remove one change's record once the pipeline has written its outcome (or dropped it as
 * already on main), deleting the marker when it was the last. A no-op when the marker names no
 * such role. Never throws. */
export function removeMergeChange(root: string, role: string): void {
  const marker = readMergeMarker(root);
  if (!marker) return;
  const all = mergeChanges(marker);
  const changes = all.filter((c) => c.role !== role);
  if (changes.length === all.length) return;
  if (changes.length === 0) {
    removeQuiet(mergeStatePath(root));
    return;
  }
  rewriteMarker(root, { ...marker, changes });
}

/** Advance a merge's stage — called by the merge path at each transition: review.ts before
 * its pre-check (`build-check`) and before its reviewer run (`reviewing`), merge-to-main.ts
 * around its conflict resolver run (`resolving`, then `merging`), merge-core.ts's
 * reviewPinnedChange once the gate returns (`merging`, whatever it decided — a finished
 * reviewer's last turns must not sit in the cell accruing a false `no pi output` flag while the
 * change waits for its merge), and merge-stack.ts around a stack's shared check. It stages
 * `role`'s own record — every concurrent verification advances its own change's cell. A no-op for a
 * role with no record (a gate run outside the pipeline, as the unit tests drive it). Only the stage
 * changes: sha and startedAt are what the snapshot cross-check and the merge's elapsed read. */
export function setMergeStage(root: string, role: string, stage: MergeStage): void {
  updateMergeChange(root, role, (change) => {
    if (change.stage === stage) return false; // already there — keep the marker as written
    change.stage = stage;
    change.stageSince = Date.now();
    return true;
  });
}

/** The merge cell's save-point hooks one of the pipeline's permit waits parks on: `wait` (the
 * stage shown while the caller is parked) set on each of `roles`' records, and `granted` (the
 * stage once the permit arrives). The three permit waits the pipeline uses — the build check's,
 * the conflict resolver's, and the re-key verification's — share this one pair of callbacks,
 * which differ only in their two stage names, so a fourth wait reuses it instead of re-copying
 * the waiting/granted shape. A no-op for a role with no record, like setMergeStage. */
function waitStageHooks(root: string, roles: readonly string[], wait: MergeStage, granted: MergeStage): PermitWaitHooks {
  return {
    waiting: () => roles.forEach((role) => setMergeStage(root, role, wait)),
    granted: () => roles.forEach((role) => setMergeStage(root, role, granted)),
  };
}

/** The merge cell's hooks around a build check's wait for its permit (runScopedBuildCheck's
 * `permitWait`): `check-wait` on each of `roles`' records while parked, `build-check` once the
 * permit arrives. Called only when the permit was not free, so an unqueued check never
 * flickers. */
export function checkWaitStage(root: string, roles: readonly string[]): PermitWaitHooks {
  return waitStageHooks(root, roles, "check-wait", "build-check");
}

/** The merge cell's hooks around the merge's conflict resolver waiting for its agent permit
 * (merge-drain.ts's merge wiring): `resolve-wait` while parked, `resolving` once the permit
 * arrives — checkWaitStage's shape for the maxConcurrent semaphore, so a resolver queued behind
 * busy agents never reads as one running. Called only when the permit was not free. */
export function resolveWaitStage(root: string, role: string): PermitWaitHooks {
  return waitStageHooks(root, [role], "resolve-wait", "resolving");
}

/** The verification's hooks around a re-key onto a full provider (plans/provider-concurrency.md §5,
 * "A re-key wait is visible"): `provider-wait` while the verification's lease parks on the target
 * provider's full cap, `reviewing` once the key frees and the review proceeds. resolveWaitStage's
 * shape for the re-key path — a verification that normally shares its review seam never
 * re-keys, so the stage fires only when a run actually moves to a different, full provider. */
export function providerWaitStage(root: string, role: string): PermitWaitHooks {
  return waitStageHooks(root, [role], "provider-wait", "reviewing");
}

/** The marker's per-change records, whichever shape it has: `changes` as written, or — for a
 * marker an older generation wrote with one top-level change — that change, `merging` since the
 * marker's start at the marker's stage. Reads both shapes into records, so addMergeChange's
 * stale-record filtering and status-model's per-role cell cannot disagree about which changes a
 * marker names. */
export function mergeChanges(marker: MergeInFlight): MergeChange[] {
  return Array.isArray(marker.changes)
    ? marker.changes.filter(isMergeChange)
    : [
        {
          role: marker.role,
          sha: marker.sha,
          summary: marker.summary,
          status: "merging",
          startedAt: marker.startedAt,
          stage: marker.stage,
          ...(marker.stageSince !== undefined ? { stageSince: marker.stageSince } : {}),
        },
      ];
}

/** True when a persisted `changes` entry is a record the pipeline and the observers can act on:
 * a role, sha and summary string and one of the three statuses. A hand-edited, torn, or foreign
 * entry (a `null`/scalar, or one missing `status`) is dropped by mergeChanges rather than read
 * field-by-field — without this, `c.role` on a `null` entry threw `Cannot read properties of
 * null` straight into setMergeChangeStatus and the every-second status poll. */
export function isMergeChange(value: unknown): value is MergeChange {
  return (
    isJsonObject(value) &&
    typeof value.role === "string" &&
    typeof value.sha === "string" &&
    typeof value.summary === "string" &&
    (value.status === "merging" || value.status === "approved" || value.status === "done") &&
    (value.stageSince === undefined || nonNegativeNumber(value.stageSince, null) !== null)
  );
}

/** Why a merge ended without landing, for the `merge_failed` event, or undefined when the
 * state names none. `rejected` reads the review's first reason, only when that review was
 * recorded during this merge (`at >= startedAt`; an older one is stale). Every other failure
 * reads `lastError`, minus its `merge failed: ` and `<result> — ` prefixes; a bare result
 * (the catch-all `merge failed: merge_conflict`) names no reason. */
export function mergeFailureReason(state: RunnerState, result: TickResult, startedAt: number): string | undefined {
  if (result === "changed" || result === "aborted") return undefined;
  if (result === "rejected") {
    const review = state.lastReview;
    if (!review || review.at < startedAt) return undefined;
    return review.reasons[0]?.trim() || undefined;
  }
  let reason = (state.lastError ?? "").trim();
  if (reason.startsWith("merge failed: ")) reason = reason.slice("merge failed: ".length);
  if (reason.startsWith(`${result} — `)) reason = reason.slice(`${result} — `.length);
  reason = reason.trim();
  return reason === "" || reason === result ? undefined : reason;
}

/** Fold one merge's outcome into its role's state and drop its queue entry — the 3/5
 * write-back every pipeline outcome goes through (a verification's final verdict, a merged change,
 * an aborted approved change): apply the result to the live state object (paired with the entry's
 * change for the last-result cell — applyMergeOutcome), persist it, log merge_done/merge_failed
 * (the failed event carries the reason mergeFailureReason derives)
 * with the merge's own duration (from its verification's start) and usage (omitted when zero — the
 * 4/5 idiom, so review-exempt merges render bare), and drop the entry: EVERY defined result
 * drops. Both event writes are best-effort: an unwritable feed (ENOSPC, EACCES) must not
 * skip the drop, or the settled entry would stay queued and be re-verified and re-merged on
 * the next drain — the queue's "drop after EVERY outcome" contract (merge-queue.ts). The
 * change's marker record is the caller's concern (removeMergeChange). */
export function writeMergeOutcome(
  root: string,
  entry: MergeEntry,
  state: RunnerState,
  result: TickResult,
  durationMs: number,
  usage: MergeUsage,
  file: string,
): void {
  applyMergeOutcome(state, result, entry);
  saveRunnerState(root, state);
  const reason = result === "changed" ? undefined : mergeFailureReason(state, result, Date.now() - durationMs);
  // One warning per error episode, merge side (BUGS.md 2026-09-30): a review rejection
  // feeds the same streak the tick-side warn reads (src/run/run-finalize.ts), but it resolves
  // AFTER the tick's end-save, so the crossing warn belongs here — same shape, same bar.
  if (result === "rejected" && (state.consecutiveErrors ?? 0) === ERROR_STREAK_WARN) {
    warnEventBestEffort(
      root,
      entry.role,
      consecutiveFailuresWarning(
        state.consecutiveErrors ?? 0,
        state.lastError ?? "review rejected",
      ),
    );
  }
  // `merged` still fires from merge-to-main.ts itself — these events mark the QUEUE's
  // bookkeeping: the slot picked the entry up (merge_queued, logged at enqueue) and finished
  // with or without merge.
  logEventBestEffort(root, {
    source: entry.role,
    type: result === "changed" ? "merge_done" : "merge_failed",
    commit: entry.sha,
    result,
    summary: entry.summary,
    ...(reason !== undefined ? { reason: truncate(reason, 300) } : {}),
    durationMs,
    // Enqueue-to-outcome span, including the slot's own durationMs. A leftover-recovery
    // re-enqueue writes a new entry with its own enqueuedAt, so a retried change counts from
    // its last enqueue.
    queuedMs: Math.max(0, Date.now() - entry.enqueuedAt),
    ...usageFragment(usage.tokens, usage.cost, usage.notionalCost),
    // The merge's per-provider spend, keyed to its reviewer seam (the same reviewProvider
    // key the author-side foldMergeUsage charges), so the report's `Cost by provider` line
    // sees a merge's spend under its reviewer's provider. Omitted when empty (a merge
    // whose runs carried no provider), the same omit-when-empty idiom the usage fields use.
    ...(Object.keys(usage.providerCost).length > 0 ? { providerCost: usage.providerCost } : {}),
  });
  dropMerge(file);
}

/** One merge's own spend (reviewer + conflict resolution), accumulated across its pi runs.
 * `cost` is the real money (API-billed runs and subscription overage); `notionalCost` is a
 * subscription merge's API-equivalent spend, which never charges the cap and rides the
 * merge_done event's own notional field (plans/agent-backends.md part 6a). The single home of the
 * shape: writeMergeOutcome and mergeUsage build it here, and merge-pipeline.ts's
 * ApprovedMerge and settleMergeOutcome carry the same object. */
export interface MergeUsage {
  tokens: number;
  cost: number;
  notionalCost?: number;
  /** Per-run spend keyed by provider (the merge's reviewer seam — see mergeUsage), so the
   * reporting fold can attribute a merge's costs to the provider that ran them. The same
   * seam key the author-side foldMergeUsage charges. */
  providerCost: Record<string, { costUsd: number; notionalCostUsd: number }>;
}

/** A fresh usage accumulator for one merge plus the foldUsage callback that charges each of
 * its pi runs to BOTH the authoring runner's live state (foldMergeUsage: reviewer and
 * conflict-resolution spend belongs to the authoring role) and the merge's own accumulator
 * (the merge_done/merge_failed event's usage). Every verification builds its wiring through this,
 * and its merge reuses it, so the accounting — and any future change to it — lives in one place.
 * `reviewProvider` is this merge's reviewer seam hold key (seamHoldKey of reviewRunConfig),
 * folded onto the rate-limit and backend-failure stamps this fold writes: a 429 on a claude
 * reviewer must hold `claude`, not the pi author's provider (PLANS.md "Mixed claude + pi
 * fleets, part 2/4"). The reviewer's final runs are folded HERE (merge-core.ts's
 * reviewPinnedChange), not inside RunnerPi — runner-pi.ts stamps the retried first attempt; this
 * stamps the final run, which ends on a different seam when the reviewer runs on a
 * non-pi backend. */
/** Fetch-or-create a provider's accumulator entry in `usage.providerCost` and add `amount`
 * to one of its two fields — the single home of the real/notional provider bump both
 * branches of foldUsage do, so a future change to the entry shape (or the
 * noUncheckedIndexedAccess seed) is merged once instead of twice. */
function addProviderCost(usage: MergeUsage, provider: string, amount: number, notional: boolean): void {
  const e = usage.providerCost[provider] ?? { costUsd: 0, notionalCostUsd: 0 };
  if (notional) e.notionalCostUsd += amount;
  else e.costUsd += amount;
  usage.providerCost[provider] = e;
}

export function mergeUsage(author: RoleRunner, root: string): {
  usage: MergeUsage;
  foldUsage: (run: PiRunResult) => void;
} {
  const usage: MergeUsage = { tokens: 0, cost: 0, providerCost: {} };
  const reviewConfig = reviewRunConfig(author.config);
  const reviewProvider = seamHoldKey(reviewConfig);
  const reviewPair = seamPairName(reviewConfig);
  return {
    usage,
    foldUsage: (run) => {
      author.foldMergeUsage(run, reviewProvider, reviewPair);
      // A claude reviewer's or resolver's billing/window readings reach the account file the
      // moment this run folds, not at the author's next tick end — so a pi-author team's
      // claude reviewer still updates the five-hour window before the author's next tick
      // starts (PLANS.md "Mixed claude + pi fleets, part 3/4"). Best-effort like run-finalize.ts's
      // call; the file is a cache and an unwritable state dir must not fail the merge.
      if (run.billing !== undefined || run.rateWindows !== undefined) {
        try {
          observeClaudeAccount(root, { billing: run.billing, rateWindows: run.rateWindows });
        } catch {
          // The next reporting run rewrites it; nothing this merge depends on is lost.
        }
      }
      usage.tokens += run.outputTokens;
      if (runCostIsReal(run)) {
        usage.cost += run.costUsd;
        // Only a resolved reviewer seam bears a provider: a pi reviewer whose provider was
        // never pinned (reviewProvider undefined) attributes nothing, like the author side.
        if (reviewProvider !== undefined) {
          addProviderCost(usage, reviewProvider, run.costUsd, false);
        }
      } else {
        usage.notionalCost = (usage.notionalCost ?? 0) + run.costUsd;
        if (reviewProvider !== undefined) {
          addProviderCost(usage, reviewProvider, run.costUsd, true);
        }
      }
    },
  };
}

/** How long a re-queued `review_error` change waits before its verification may start. */
const REVIEW_ERROR_RETRY_MS = 60_000;

/** The queue entry that re-queues a settled one: its run, summary, body, friction flag and
 * revision fields unchanged (so the summary is not a recovery label), the pin's current `sha`,
 * and `retry` naming the result it retries. */
function retryEntry(from: Omit<MergeEntry, "sha">, sha: string, result: string): MergeEntry {
  const { notBefore: _notBefore, retry: _retry, ...rest } = from;
  return {
    ...rest,
    sha,
    retry: result,
    enqueuedAt: Date.now(),
    ...(result === "review_error" ? { notBefore: Date.now() + REVIEW_ERROR_RETRY_MS } : {}),
  };
}

function enqueueRetry(root: string, entry: MergeEntry): void {
  enqueueMerge(root, entry);
  logEventBestEffort(root, {
    source: entry.role,
    type: "merge_queued",
    commit: entry.sha,
    summary: entry.summary,
    retry: entry.retry,
  });
}

/** After a settled merge dropped its entry, put a kept change back on the queue itself, so a
 * retry needs no author run (plans/fast-merge.md "Lever 1"). A `merge_blocked`, `review_error`
 * or `merge_conflict` result re-queues at once when its pin survives and pinnedRetrySha allows
 * it (not stale, not held, under MERGE_CONFLICT_LIMIT); a `main_red` pin is recorded on the
 * state with main's head, for requeueMainRedPin to re-queue once main moves to a head whose
 * verdict is not red. Anything else, or a pin that is gone, changes nothing — leftover recovery
 * stays the backstop. */
export async function requeueKeptChange(
  root: string,
  mainBranch: string,
  entry: MergeEntry,
  state: RunnerState,
  result: TickResult,
): Promise<void> {
  const isMainRed = result === "main_red";
  if (!isMainRed && !RETRIABLE_MERGE_RESULTS.has(result)) return;
  const sha = await pinnedRetrySha(root, entry.role, mainBranch, state);
  if (!sha) return;
  if (isMainRed) {
    const { sha: _sha, notBefore: _nb, retry: _r, ...rest } = entry;
    state.mainRedRetry = { head: (await branchHead(root, mainBranch)) ?? "", entry: rest };
    saveRunnerState(root, state);
    return;
  }
  if (queuedMerges(root).some((e) => e.role === entry.role)) return;
  enqueueRetry(root, retryEntry(entry, sha, result));
}

/** The longest a kept `main_red` pin waits for the main watch's verdict on a moved head before it
 * is re-queued anyway. This bounds the wait when no verdict ever arrives, for example after a
 * watch check that timed out or a restart's cold cache. */
export const MAIN_RED_VERDICT_WAIT_MS = 15 * 60_000;

/** Re-queue a `main_red` pin once main's head differs from the one recorded when its attempt
 * settled (the orchestrator poll calls this for every runner), by the head's cached verdict: red
 * leaves the record untouched, so a later poll asks again; no verdict starts (and saves) a wait
 * at `now`, and the pin re-queues once MAIN_RED_VERDICT_WAIT_MS has passed; green re-queues at
 * once. Re-queuing clears the record; no entry is queued when the pin is gone or held back by
 * pinnedRetrySha, or the role already has one queued. */
export async function requeueMainRedPin(
  root: string,
  mainBranch: string,
  state: RunnerState,
  mainHead: string,
  now = Date.now(),
): Promise<void> {
  const kept = state.mainRedRetry;
  if (!kept || mainHead === "" || mainHead === kept.head) return;
  const verdict = cachedBaselineVerdict(mainHead);
  if (verdict === "red") return;
  if (verdict === undefined) {
    if (kept.waitingSince === undefined) {
      state.mainRedRetry = { ...kept, waitingSince: now };
      saveRunnerState(root, state);
      return;
    }
    if (now - kept.waitingSince < MAIN_RED_VERDICT_WAIT_MS) return;
  }
  state.mainRedRetry = undefined;
  saveRunnerState(root, state);
  const sha = await pinnedRetrySha(root, kept.entry.role, mainBranch, state);
  if (!sha || queuedMerges(root).some((e) => e.role === kept.entry.role)) return;
  enqueueRetry(root, retryEntry(kept.entry, sha, "main_red"));
}
