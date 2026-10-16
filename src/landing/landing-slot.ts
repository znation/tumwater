// vocabulary: plain
import { dropLanding, type LandingEntry } from "./landing-queue.js";
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
import { landingStatePath } from "../paths.js";
import type { LoopRunner } from "../loop/loop.js";
import type { PermitWaitHooks } from "../concurrency/check-permit.js";
import { consecutiveFailuresWarning } from "../text/phrases.js";

/** The landing pipeline's bookkeeping (merge queue 3/5 and 4/5), split out of the drain
 * (landing-drain.ts, which schedules the vets and the merge) so it lives separate from the
 * landing mechanics themselves (landing-core.ts and landing-batch.ts: review gate, rebase, stack,
 * ff-merge). This module owns the 4/5 in-flight marker — one record per change being vetted,
 * vetted, or merged — the per-landing usage accounting, and the write-back that folds every
 * outcome into the authoring role's state and drops its queue entry. A landing's pi runs charge
 * to the authoring runner (foldLandingUsage). */

/** What the pipeline is doing with one change right now. A vet opens at `rebasing` (its
 * checkout and rebase onto main) and moves through `build-check` — a deterministic check (the
 * gate's pre-check over the change's tree, its one re-run, and the attribution check of main's
 * tip behind a repeat failure, or a stack's shared check) — and `reviewing`, the adversarial
 * reviewer's pi run, whose live turns/context/tool the dashboards read from the role's raw log;
 * `check-wait` covers any wait for a process-wide check permit (check-permit.ts) before a check
 * starts, so a queued check never reads as a running one. `resolving` is the merge's conflict
 * resolver (landing-merge.ts's resolveConflict) — a model run whose live detail reads like a
 * reviewer's — and `resolve-wait` the resolver parked for its agent permit before it starts
 * (resolveWaitStage); both used to read as `merging`, so a resolver holding the whole merge
 * queue for minutes looked like a slow fast-forward (2026-10-12). `merging` is the merge slot's
 * own git steps — the stack's assembly, the in-lock re-check's rebase, and the fast-forward onto
 * main. Everything else a landing does (verdict parsing, state saves) is sub-second bookkeeping
 * between these. */
type LandingStage =
  | "rebasing"
  | "check-wait"
  | "build-check"
  | "reviewing"
  | "resolve-wait"
  | "resolving"
  | "provider-wait"
  | "merging";

/** How each landing stage names itself in the landing cell. */
export const LANDING_STAGE_LABELS: Record<LandingStage, string> = {
  rebasing: "rebasing",
  "check-wait": "waiting to check",
  "build-check": "checking",
  reviewing: "reviewing",
  "resolve-wait": "waiting to resolve conflicts",
  resolving: "resolving conflicts",
  "provider-wait": "waiting for the provider",
  merging: "finishing the merge",
};

/** Where one change stands in the landing pipeline (land-queue speed 2c) — the per-change status
 * the marker carries, so each role's row says what the pipeline is doing with ITS change rather
 * than every row reading as one change's landing (BUGS.md 2026-09-23):
 * - `landing`: a vet or the merge is working on it right now — its checkout, rebase, gate check
 *   and review, or the merge's stack check and fast-forward — `landing <its elapsed> · <stage>`,
 *   the only live state (several changes hold it at once: vets run in parallel, and a stack
 *   lands together);
 * - `vetted`: its vet approved it and it waits for the merge slot (or, in an abandoned stack's
 *   one-at-a-time fallback, for its own turn) — `vetted, awaiting merge`;
 * - `done`: the merge is finished with it — landed, attributed, or left for the next merge —
 *   and the marker shows nothing for it: its row reads its own state until the record goes.
 * A queued change whose vet is still waiting for a permit has no record at all: its row reads
 * plainly queued. */
export type LandingChangeStatus = "landing" | "vetted" | "done";

/** One change's record in the in-flight marker. `startedAt` is stamped when its vet starts and
 * kept through its merge, so its `landing <elapsed>` measures this change's own landing. `stage`
 * is this change's own LandingStage (setLandingStage): `rebasing` when its vet starts, reset to
 * `merging` each time the merge slot moves it back to `landing` (the stack's assembly, a
 * fallback's merge). Keyed by role — invariant 3 caps a role at one in-flight change. */
export interface LandingChange {
  role: string;
  sha: string;
  summary: string;
  status: LandingChangeStatus;
  startedAt?: number;
  stage?: LandingStage;
  /** When this change ENTERED its CURRENT stage (epoch ms) — stamped ONCE on the transition
   * that set `stage`, so the per-stage elapsed a label renders measures only that stage. */
  stageSince?: number;
}

/** The in-flight landing marker (plans/merge-queue.md 4/5): which changes are landing right
 * now, since when, and which stage each is in. The pipeline adds a change's record when its vet
 * starts and removes it after its outcome, so the separate-process observers (status, TUI, GUI)
 * can show the landings without depending on the scheduler module — the OrchestratorInfo
 * precedent. snapshot() cross-checks it with matching queue entries and the orchestrator's
 * liveness, so a stale marker from any crash ordering never displays. `stage` rides the same
 * file rather than a second one — the marker is the one cross-process surface both dashboards
 * already read; the landing path advances it (setLandingStage) and the landing cell renders it
 * (loopPhase). `changes` is the source of truth for every row, one record per change; the
 * top-level fields mirror the first change in `landing`, so an observer from a generation that
 * reads only them still names a change actually in flight, with that change's own start and
 * stage. A marker from an older generation may carry the top-level fields alone (one change) or
 * no stage (the bare elapsed label): read both shapes through landingChanges. */
export interface LandingInFlight {
  role: string;
  sha: string;
  summary: string;
  startedAt: number;
  stage?: LandingStage;
  stageSince?: number;
  changes?: LandingChange[];
}

/** Publish the in-flight landing marker — the one place its shape is constructed, so the
 * interface is enforced here rather than at each caller's inline `writeJsonFile`: every
 * writer names a stage. Atomic (tmp + rename) because the marker is rewritten mid-landing at
 * every stage and per-change status transition while observers poll it every second — a plain
 * overwrite would let a poll read a torn file as "no landing" and flicker the landing row back
 * to its idle label. */
export function writeLandingMarker(root: string, marker: LandingInFlight & { stage: LandingStage }): void {
  writeJsonAtomic(landingStatePath(root), marker);
}

/** Read the in-flight landing marker; null when missing or unreadable. Never throws —
 * observers poll it every second, and a torn write (a crash mid-write) must not take them
 * down (the readOrchestratorInfo precedent). */
export function readLandingMarker(root: string): LandingInFlight | null {
  return readJsonFile<LandingInFlight>(landingStatePath(root));
}

/** Rewrite the marker after one of its records changed: re-point the top level at the first
 * change in `landing` (see LandingInFlight — left as is while none is), then write it. Never
 * throws: the marker is display-only, and a failed write must not fail a landing (the
 * observers keep the previous frame's record until the next write). */
function rewriteMarker(root: string, marker: LandingInFlight & { changes: LandingChange[] }): void {
  const headline = marker.changes.find((c) => isLandingChange(c) && c.status === "landing"); // vocabulary-ok: persisted state value or event scope, renamed by a later series
  if (headline) {
    marker.role = headline.role;
    marker.sha = headline.sha;
    marker.summary = headline.summary;
    marker.startedAt = headline.startedAt ?? marker.startedAt;
    marker.stage = headline.stage ?? "merging";
  }
  try {
    writeLandingMarker(root, { ...marker, stage: marker.stage ?? "merging" });
  } catch {
    /* display-only — see above */
  }
}

/** Read-modify-write one change's record in the live marker — the skeleton setLandingChangeStatus
 * and setLandingStage share: read the marker off disk, hand `apply` the change named by `role`,
 * and write the marker back through rewriteMarker. A read-modify-write of the file, not a
 * rewrite from memory, so the stage a gate last set (the same process) survives. A no-op when
 * there is no marker or it has no record for `role`; `apply` returns whether to write the
 * marker — true when it changed anything, false to skip the write (setLandingStage's guard
 * against re-staging an unchanged stage). Never throws (rewriteMarker). */
function updateLandingChange(
  root: string,
  role: string,
  apply: (change: LandingChange) => boolean,
): void {
  const marker = readLandingMarker(root);
  // A `changes` field that is not an array is as unusable as an absent one — treat it as no
  // per-change records (the legacy shape) and leave the marker untouched, rather than reading
  // `.find` off a scalar and throwing into a live landing.
  if (!marker || !Array.isArray(marker.changes)) return;
  const change = marker.changes.find((c) => isLandingChange(c) && c.role === role);
  if (!change) return;
  if (!apply(change)) return;
  rewriteMarker(root, { ...marker, changes: marker.changes });
}

/** Advance one change's record in the live marker — the vet's move to `vetted` and the merge's
 * per-change status hook (BatchContext.onChangeStatus). A read-modify-write of the file, not a
 * rewrite from memory, so the stage a gate last set (setLandingStage, the same process)
 * survives. Each move to `landing` resets the change's stage to `merging` and stamps its
 * `startedAt` if it has none. A no-op when there is no marker or it has no record for `role`.
 * Never throws (rewriteMarker). */
export function setLandingChangeStatus(root: string, role: string, status: LandingChangeStatus): void {
  updateLandingChange(root, role, (change) => {
    change.status = status;
    if (status === "landing") { // vocabulary-ok: persisted state value or event scope, renamed by a later series
      change.startedAt ??= Date.now();
      change.stage = "merging";
    }
    return true;
  });
}

/** Add one change's record as its vet starts: each change is its own task, so records come and
 * go one at a time. The new record starts `landing` at `rebasing` with its own `startedAt` (a
 * vet opens with its checkout and rebase onto main). Every other record is kept only while its
 * role is in `live` — the roles the pipeline holds right now — so a record a crashed generation
 * left behind never rides along. Never throws (rewriteMarker). */
export function addLandingChange(root: string, entry: LandingEntry, live: ReadonlySet<string>): void {
  const marker = readLandingMarker(root);
  const kept = marker ? landingChanges(marker).filter((c) => c.role !== entry.role && live.has(c.role)) : [];
  const startedAt = Date.now();
  const change: LandingChange = {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    status: "landing", // vocabulary-ok: persisted state value or event scope, renamed by a later series
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
export function removeLandingChange(root: string, role: string): void {
  const marker = readLandingMarker(root);
  if (!marker) return;
  const all = landingChanges(marker);
  const changes = all.filter((c) => c.role !== role);
  if (changes.length === all.length) return;
  if (changes.length === 0) {
    removeQuiet(landingStatePath(root));
    return;
  }
  rewriteMarker(root, { ...marker, changes });
}

/** Advance a landing's stage — called by the landing path at each transition: review.ts before
 * its pre-check (`build-check`) and before its reviewer run (`reviewing`), landing-merge.ts
 * around its conflict resolver run (`resolving`, then `merging`), landing-core.ts's
 * reviewPinnedChange once the gate returns (`merging`, whatever it decided — a finished
 * reviewer's last turns must not sit in the cell accruing a false `no pi output` flag while the
 * change waits for its merge), and landing-stack.ts around a stack's shared check. It stages
 * `role`'s own record — every concurrent vet advances its own change's cell. A no-op for a role
 * with no record (a gate run outside the pipeline, as the unit tests drive it). Only the stage
 * changes: sha and startedAt are what the
 * snapshot cross-check and the landing's elapsed read. */
export function setLandingStage(root: string, role: string, stage: LandingStage): void {
  updateLandingChange(root, role, (change) => {
    if (change.stage === stage) return false; // already there — keep the marker as written
    change.stage = stage;
    change.stageSince = Date.now();
    return true;
  });
}

/** The landing cell's hooks around a build check's wait for its permit (runScopedBuildCheck's
 * `permitWait`): `check-wait` on each of `roles`' records while parked, `build-check` once the
 * permit arrives. Called only when the permit was not free, so an unqueued check never
 * flickers. A no-op for roles with no record, like setLandingStage. */
export function checkWaitStage(root: string, roles: readonly string[]): PermitWaitHooks {
  return {
    waiting: () => roles.forEach((role) => setLandingStage(root, role, "check-wait")),
    granted: () => roles.forEach((role) => setLandingStage(root, role, "build-check")),
  };
}

/** The landing cell's hooks around the merge's conflict resolver waiting for its agent permit
 * (landing-drain.ts's merge wiring): `resolve-wait` while parked, `resolving` once the permit
 * arrives — checkWaitStage's shape for the maxConcurrent semaphore, so a resolver queued behind
 * busy agents never reads as one running. Called only when the permit was not free. A no-op
 * for a role with no record, like setLandingStage. */
export function resolveWaitStage(root: string, role: string): PermitWaitHooks {
  return {
    waiting: () => setLandingStage(root, role, "resolve-wait"),
    granted: () => setLandingStage(root, role, "resolving"),
  };
}

/** The vet's hooks around a re-key onto a full provider (plans/provider-concurrency.md §5,
 * "A re-key wait is visible"): `provider-wait` while the vet's lease parks on the target
 * provider's full cap, `reviewing` once the key frees and the review proceeds. resolveWaitStage's
 * shape for the re-key path — a vet that normally shares its review seam never re-keys, so the
 * stage fires only when a run actually moves to a different, full provider. */
export function providerWaitStage(root: string, role: string): PermitWaitHooks {
  return {
    waiting: () => setLandingStage(root, role, "provider-wait"),
    granted: () => setLandingStage(root, role, "reviewing"),
  };
}

/** The marker's per-change records, whichever shape it has: `changes` as written, or — for a
 * marker an older generation wrote with one top-level change — that change, `landing` since the
 * marker's start at the marker's stage. Reads both shapes into records, so addLandingChange's
 * stale-record filtering and status-model's per-role cell cannot disagree about which changes a
 * marker names. */
export function landingChanges(marker: LandingInFlight): LandingChange[] {
  return Array.isArray(marker.changes)
    ? marker.changes.filter(isLandingChange)
    : [
        {
          role: marker.role,
          sha: marker.sha,
          summary: marker.summary,
          status: "landing", // vocabulary-ok: persisted state value or event scope, renamed by a later series
          startedAt: marker.startedAt,
          stage: marker.stage,
          ...(marker.stageSince !== undefined ? { stageSince: marker.stageSince } : {}),
        },
      ];
}

/** True when a persisted `changes` entry is a record the pipeline and the observers can act on:
 * a role, sha and summary string and one of the three statuses. A hand-edited, torn, or foreign
 * entry (a `null`/scalar, or one missing `status`) is dropped by landingChanges rather than read
 * field-by-field — without this, `c.role` on a `null` entry threw `Cannot read properties of
 * null` straight into setLandingChangeStatus and the every-second status poll. */
export function isLandingChange(value: unknown): value is LandingChange {
  return (
    isJsonObject(value) &&
    typeof value.role === "string" &&
    typeof value.sha === "string" &&
    typeof value.summary === "string" &&
    (value.status === "landing" || value.status === "vetted" || value.status === "done") && // vocabulary-ok: persisted state value or event scope, renamed by a later series
    (value.stageSince === undefined || nonNegativeNumber(value.stageSince, null) !== null)
  );
}

/** Fold one landing's outcome into its role's state and drop its queue entry — the 3/5
 * write-back every pipeline outcome goes through (a vet's final verdict, a merged change, an
 * aborted vetted change): apply the result to the live state object (paired with the entry's
 * change for the last-result cell — applyLandingOutcome), persist it, log merge_done/merge_failed
 * with the landing's own duration (from its vet's start) and usage (omitted when zero — the 4/5
 * idiom, so review-exempt landings render bare), and drop the entry: EVERY defined result
 * drops. Both event writes are best-effort: an unwritable feed (ENOSPC, EACCES) must not
 * skip the drop, or the settled entry would stay queued and be re-vetted and re-merged on
 * the next drain — the queue's "drop after EVERY outcome" contract (landing-queue.ts). The
 * change's marker record is the caller's concern (removeLandingChange). */
export function writeLandingOutcome(
  root: string,
  entry: LandingEntry,
  state: LoopState,
  result: TickResult,
  durationMs: number,
  usage: LandingUsage,
  file: string,
): void {
  applyLandingOutcome(state, result, entry);
  saveLoopState(root, state);
  // One warning per error episode, landing side (BUGS.md 2026-09-30): a review rejection
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
  // `merged` still fires from landing-merge.ts itself — these events mark the QUEUE's
  // bookkeeping: the slot picked the entry up (merge_queued, logged at enqueue) and finished
  // with or without landing.
  logEventBestEffort(root, {
    source: entry.role,
    type: result === "changed" ? "merge_done" : "merge_failed",
    commit: entry.sha,
    result,
    durationMs,
    ...usageFragment(usage.tokens, usage.cost, usage.notionalCost),
    // The landing's per-provider spend, keyed to its reviewer seam (the same reviewProvider
    // key the author-side foldLandingUsage charges), so the report's `Cost by provider` line
    // sees a landing's spend under its reviewer's provider. Omitted when empty (a landing
    // whose runs carried no provider), the same omit-when-empty idiom the usage fields use.
    ...(Object.keys(usage.providerCost).length > 0 ? { providerCost: usage.providerCost } : {}),
  });
  dropLanding(file);
}

/** One landing's own spend (reviewer + conflict resolution), accumulated across its pi runs.
 * `cost` is the real money (API-billed runs and subscription overage); `notionalCost` is a
 * subscription landing's API-equivalent spend, which never charges the cap and rides the
 * landed event's own notional field (plans/agent-backends.md part 6a). The single home of the
 * shape: writeLandingOutcome and landingUsage build it here, and landing-pipeline.ts's
 * VettedLanding and settleLandingOutcome carry the same object. */
export interface LandingUsage {
  tokens: number;
  cost: number;
  notionalCost?: number;
  /** Per-run spend keyed by provider (the landing's reviewer seam — see landingUsage), so the
   * reporting fold can attribute a landing's costs to the provider that ran them. The same
   * seam key the author-side foldLandingUsage charges. */
  providerCost: Record<string, { costUsd: number; notionalCostUsd: number }>;
}

/** A fresh usage accumulator for one landing plus the foldUsage callback that charges each of
 * its pi runs to BOTH the authoring runner's live state (foldLandingUsage: reviewer and
 * conflict-resolution spend belongs to the authoring role) and the landing's own accumulator
 * (the merge_done/merge_failed event's usage). Every vet builds its wiring through this, and its
 * merge reuses it, so the accounting — and any future change to it — lives in one place.
 * `reviewProvider` is this landing's reviewer seam hold key (seamHoldKey of reviewRunConfig),
 * folded onto the rate-limit and backend-failure stamps this fold writes: a 429 on a claude
 * reviewer must hold `claude`, not the pi author's provider (PLANS.md "Mixed claude + pi
 * fleets, part 2/4"). The reviewer's final runs are folded HERE (landing-core.ts's
 * reviewPinnedChange), not inside LoopPi — loop-pi.ts stamps the retried first attempt; this
 * stamps the final run, which ends on a different seam when the reviewer runs on a
 * non-pi backend. */
/** Fetch-or-create a provider's accumulator entry in `usage.providerCost` and add `amount`
 * to one of its two fields — the single home of the real/notional provider bump both
 * branches of foldUsage do, so a future change to the entry shape (or the
 * noUncheckedIndexedAccess seed) lands once instead of twice. */
function addProviderCost(usage: LandingUsage, provider: string, amount: number, notional: boolean): void {
  const e = usage.providerCost[provider] ?? { costUsd: 0, notionalCostUsd: 0 };
  if (notional) e.notionalCostUsd += amount;
  else e.costUsd += amount;
  usage.providerCost[provider] = e;
}

export function landingUsage(author: LoopRunner, root: string): {
  usage: LandingUsage;
  foldUsage: (run: PiRunResult) => void;
} {
  const usage: LandingUsage = { tokens: 0, cost: 0, providerCost: {} };
  const reviewConfig = reviewRunConfig(author.config);
  const reviewProvider = seamHoldKey(reviewConfig);
  const reviewPair = seamPairName(reviewConfig);
  return {
    usage,
    foldUsage: (run) => {
      author.foldLandingUsage(run, reviewProvider, reviewPair);
      // A claude reviewer's or resolver's billing/window readings reach the account file the
      // moment this run folds, not at the author's next tick end — so a pi-author fleet's
      // claude reviewer still updates the five-hour window before the author's next tick
      // starts (PLANS.md "Mixed claude + pi fleets, part 3/4"). Best-effort like tick-finalize.ts's
      // call; the file is a cache and an unwritable state dir must not fail the landing.
      if (run.billing !== undefined || run.rateWindows !== undefined) {
        try {
          observeClaudeAccount(root, { billing: run.billing, rateWindows: run.rateWindows });
        } catch {
          // The next reporting run rewrites it; nothing this landing depends on is lost.
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
