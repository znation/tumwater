// vocabulary: plain
import { dropMerge, type MergeEntry } from "./merge-queue.js";
import type { TickResult } from "../tick/tick-outcome.js";
import { runCostIsReal, type PiRunResult } from "../pi/pi-run-result.js";
import { reviewRunConfig, seamHoldKey, seamPairName } from "../config/config-views.js";
import { saveLoopState, type LoopState } from "../loop/loop-state.js";
import { applyLandingOutcome, ERROR_STREAK_WARN } from "../tick/tick-apply.js";
import { observeClaudeAccount } from "../agent/claude/claude-account.js";
import { logEventBestEffort, usageFragment, warnEventBestEffort } from "../events/events.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject, nonNegativeNumber } from "../files/json-object.js";
import { removeQuiet } from "../files/files.js";
import { mergeStatePath } from "../paths.js";
import type { LoopRunner } from "../loop/loop.js";
import type { PermitWaitHooks } from "../concurrency/check-permit.js";
import { consecutiveFailuresWarning } from "../text/phrases.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** The merge pipeline's bookkeeping (merge queue 3/5 and 4/5), split out of the drain
 * (merge-drain.ts, which schedules the verifications and the merge) so it lives separate from the
 * merge mechanics themselves (merge-core.ts and merge-batch.ts: review gate, rebase, stack,
 * ff-merge). This module owns the 4/5 in-flight marker — one record per change being verified,
 * approved, or merged — the per-merge usage accounting, and the write-back that folds every
 * outcome into the authoring role's state and drops its queue entry. A merge's pi runs charge
 * to the authoring runner (foldLandingUsage). */

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
 * (loopPhase). `changes` is the source of truth for every row, one record per change; the
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

/** The merge cell's hooks around a build check's wait for its permit (runScopedBuildCheck's
 * `permitWait`): `check-wait` on each of `roles`' records while parked, `build-check` once the
 * permit arrives. Called only when the permit was not free, so an unqueued check never
 * flickers. A no-op for roles with no record, like setMergeStage. */
export function checkWaitStage(root: string, roles: readonly string[]): PermitWaitHooks {
  return {
    waiting: () => roles.forEach((role) => setMergeStage(root, role, "check-wait")),
    granted: () => roles.forEach((role) => setMergeStage(root, role, "build-check")),
  };
}

/** The merge cell's hooks around the merge's conflict resolver waiting for its agent permit
 * (merge-drain.ts's merge wiring): `resolve-wait` while parked, `resolving` once the permit
 * arrives — checkWaitStage's shape for the maxConcurrent semaphore, so a resolver queued behind
 * busy agents never reads as one running. Called only when the permit was not free. A no-op
 * for a role with no record, like setMergeStage. */
export function resolveWaitStage(root: string, role: string): PermitWaitHooks {
  return {
    waiting: () => setMergeStage(root, role, "resolve-wait"),
    granted: () => setMergeStage(root, role, "resolving"),
  };
}

/** The verification's hooks around a re-key onto a full provider (plans/provider-concurrency.md §5,
 * "A re-key wait is visible"): `provider-wait` while the verification's lease parks on the target
 * provider's full cap, `reviewing` once the key frees and the review proceeds. resolveWaitStage's
 * shape for the re-key path — a verification that normally shares its review seam never
 * re-keys, so the stage fires only when a run actually moves to a different, full provider. */
export function providerWaitStage(root: string, role: string): PermitWaitHooks {
  return {
    waiting: () => setMergeStage(root, role, "provider-wait"),
    granted: () => setMergeStage(root, role, "reviewing"),
  };
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

/** Fold one merge's outcome into its role's state and drop its queue entry — the 3/5
 * write-back every pipeline outcome goes through (a verification's final verdict, a merged change,
 * an aborted approved change): apply the result to the live state object (paired with the entry's
 * change for the last-result cell — applyLandingOutcome), persist it, log merge_done/merge_failed
 * with the merge's own duration (from its verification's start) and usage (omitted when zero — the
 * 4/5 idiom, so review-exempt merges render bare), and drop the entry: EVERY defined result
 * drops. Both event writes are best-effort: an unwritable feed (ENOSPC, EACCES) must not
 * skip the drop, or the settled entry would stay queued and be re-verified and re-merged on
 * the next drain — the queue's "drop after EVERY outcome" contract (merge-queue.ts). The
 * change's marker record is the caller's concern (removeMergeChange). */
export function writeMergeOutcome(
  root: string,
  entry: MergeEntry,
  state: LoopState,
  result: TickResult,
  durationMs: number,
  usage: MergeUsage,
  file: string,
): void {
  applyLandingOutcome(state, result, entry);
  saveLoopState(root, state);
  // One warning per error episode, merge side (BUGS.md 2026-09-30): a review rejection
  // feeds the same streak the tick-side warn reads (src/tick/tick-finalize.ts), but it resolves
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
    durationMs,
    ...usageFragment(usage.tokens, usage.cost, usage.notionalCost),
    // The merge's per-provider spend, keyed to its reviewer seam (the same reviewProvider
    // key the author-side foldLandingUsage charges), so the report's `Cost by provider` line
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
 * VettedLanding and settleLandingOutcome carry the same object. */
export interface MergeUsage {
  tokens: number;
  cost: number;
  notionalCost?: number;
  /** Per-run spend keyed by provider (the merge's reviewer seam — see mergeUsage), so the
   * reporting fold can attribute a merge's costs to the provider that ran them. The same
   * seam key the author-side foldLandingUsage charges. */
  providerCost: Record<string, { costUsd: number; notionalCostUsd: number }>;
}

/** A fresh usage accumulator for one merge plus the foldUsage callback that charges each of
 * its pi runs to BOTH the authoring runner's live state (foldLandingUsage: reviewer and
 * conflict-resolution spend belongs to the authoring role) and the merge's own accumulator
 * (the merge_done/merge_failed event's usage). Every verification builds its wiring through this,
 * and its merge reuses it, so the accounting — and any future change to it — lives in one place.
 * `reviewProvider` is this merge's reviewer seam hold key (seamHoldKey of reviewRunConfig),
 * folded onto the rate-limit and backend-failure stamps this fold writes: a 429 on a claude
 * reviewer must hold `claude`, not the pi author's provider (PLANS.md "Mixed claude + pi
 * fleets, part 2/4"). The reviewer's final runs are folded HERE (merge-core.ts's
 * reviewPinnedChange), not inside LoopPi — loop-pi.ts stamps the retried first attempt; this
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

export function mergeUsage(author: LoopRunner, root: string): {
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
      author.foldLandingUsage(run, reviewProvider, reviewPair);
      // A claude reviewer's or resolver's billing/window readings reach the account file the
      // moment this run folds, not at the author's next tick end — so a pi-author team's
      // claude reviewer still updates the five-hour window before the author's next tick
      // starts (PLANS.md "Mixed claude + pi fleets, part 3/4"). Best-effort like tick-finalize.ts's
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
