import type { LandingEntry, LoopState, PiRunResult, TickResult } from "./types.js";
import { applyLandingOutcome, saveLoopState } from "./state.js";
import { logEvent } from "./events.js";
import { dropLanding } from "./land-queue.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { removeQuiet } from "./files.js";
import { landingStatePath } from "./paths.js";
import type { LoopRunner } from "./loop.js";

/** The landing pipeline's bookkeeping (merge queue 3/5 and 4/5), split out of the drain
 * (landing-drain.ts, which schedules the vets and the merge) so it lives separate from the
 * landing mechanics themselves (lander.ts and land-batch.ts: review gate, rebase, stack,
 * ff-merge). This module owns the 4/5 in-flight marker — one record per change being vetted,
 * vetted, or merged — the per-landing usage accounting, and the write-back that folds every
 * outcome into the authoring role's state and drops its queue entry. A landing's pi runs charge
 * to the authoring runner (foldLandingUsage). */

/** Where a landing is in its flow, as far as an observer can tell: `merging` — the git steps
 * (lander checkout, rebase onto main, the in-lock re-check and fast-forward); `build-check` —
 * a deterministic check (the gate's pre-check over the change's tree, its one re-run, and the
 * attribution check of main's tip behind a repeat failure, or a stack's shared check); `reviewing` — the adversarial reviewer's pi run,
 * whose live turns/context/tool the dashboards read from the role's raw log. Everything else a
 * landing does (verdict parsing, state saves) is sub-second bookkeeping between these. */
export type LandingStage = "merging" | "build-check" | "reviewing";

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
 * is this change's own LandingStage (setLandingStage), reset to `merging` each time it enters
 * `landing` — every step starts with git (the vet's checkout and rebase, the stack's assembly,
 * a fallback's merge). Keyed by role — invariant 3 caps a role at one in-flight change. */
export interface LandingChange {
  role: string;
  sha: string;
  summary: string;
  status: LandingChangeStatus;
  startedAt?: number;
  stage?: LandingStage;
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
  const headline = marker.changes.find((c) => c.status === "landing");
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

/** Advance one change's record in the live marker — the vet's move to `vetted` and the merge's
 * per-change status hook (BatchContext.onChangeStatus). A read-modify-write of the file, not a
 * rewrite from memory, so the stage a gate last set (setLandingStage, the same process)
 * survives. Each move to `landing` resets the change's stage to `merging` and stamps its
 * `startedAt` if it has none. A no-op when there is no marker or it has no record for `role`.
 * Never throws (rewriteMarker). */
export function setLandingChangeStatus(root: string, role: string, status: LandingChangeStatus): void {
  const marker = readLandingMarker(root);
  const changes = marker?.changes;
  const change = changes?.find((c) => c.role === role);
  if (!marker || !changes || !change) return;
  change.status = status;
  if (status === "landing") {
    change.startedAt ??= Date.now();
    change.stage = "merging";
  }
  rewriteMarker(root, { ...marker, changes });
}

/** Add one change's record as its vet starts: each change is its own task, so records come and
 * go one at a time. The new record starts `landing` at `merging` with its own `startedAt` (a
 * vet opens with its checkout and rebase). Every other record is kept only while its role is in
 * `live` — the roles the pipeline holds right now — so a record a crashed generation left behind
 * never rides along. Never throws (rewriteMarker). */
export function addLandingChange(root: string, entry: LandingEntry, live: ReadonlySet<string>): void {
  const marker = readLandingMarker(root);
  const kept = marker ? landingChanges(marker).filter((c) => c.role !== entry.role && live.has(c.role)) : [];
  const startedAt = Date.now();
  const change: LandingChange = {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    status: "landing",
    startedAt,
    stage: "merging",
  };
  rewriteMarker(root, {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    startedAt,
    stage: "merging",
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
 * its pre-check (`build-check`) and before its reviewer run (`reviewing`), lander.ts's
 * reviewPinnedChange once the gate returns (`merging`, whatever it decided — a finished
 * reviewer's last turns must not sit in the cell accruing a false `no pi output` flag while the
 * change waits for its merge), and land-batch.ts around a stack's shared check. It stages
 * `role`'s own record — every concurrent vet advances its own change's cell. A no-op for a role
 * with no record (a gate run outside the pipeline, as the unit tests drive it). Only the stage
 * changes: sha and startedAt are what the
 * snapshot cross-check and the landing's elapsed read. */
export function setLandingStage(root: string, role: string, stage: LandingStage): void {
  const marker = readLandingMarker(root);
  const change = marker?.changes?.find((c) => c.role === role);
  if (!marker?.changes || !change || change.stage === stage) return;
  change.stage = stage;
  rewriteMarker(root, { ...marker, changes: marker.changes });
}

/** The marker's per-change records, whichever shape it has: `changes` as written, or — for a
 * marker an older generation wrote with one top-level change — that change, `landing` since the
 * marker's start at the marker's stage. The one reader of both shapes, so the snapshot's
 * cross-check, the drain's stale-record dedupe, and the rows cannot disagree about which changes
 * a marker names. */
export function landingChanges(marker: LandingInFlight): LandingChange[] {
  return (
    marker.changes ?? [
      {
        role: marker.role,
        sha: marker.sha,
        summary: marker.summary,
        status: "landing",
        startedAt: marker.startedAt,
        stage: marker.stage,
      },
    ]
  );
}

/** Fold one landing's outcome into its role's state and drop its queue entry — the 3/5
 * write-back every pipeline outcome goes through (a vet's final verdict, a merged change, an
 * aborted vetted change): apply the result to the live state object (paired with the entry's
 * change for the last-result cell — applyLandingOutcome), persist it, log landed/land_failed
 * with the landing's own duration (from its vet's start) and usage (omitted when zero — the 4/5
 * idiom, so review-exempt landings render bare), and drop the entry: EVERY defined result
 * drops. The change's marker record is the caller's concern (removeLandingChange). */
export function writeLandingOutcome(
  root: string,
  entry: LandingEntry,
  state: LoopState,
  result: TickResult,
  durationMs: number,
  usage: { tokens: number; cost: number },
  file: string,
): void {
  applyLandingOutcome(state, result, entry);
  saveLoopState(root, state);
  // `merged` still fires from merge.ts itself — these events mark the QUEUE's bookkeeping:
  // the slot picked the entry up (land_queued, logged at enqueue) and finished with or
  // without landing.
  logEvent(root, {
    loop: entry.role,
    type: result === "changed" ? "landed" : "land_failed",
    commit: entry.sha,
    result,
    durationMs,
    ...(usage.tokens > 0 ? { tokens: usage.tokens } : {}),
    ...(usage.cost > 0 ? { costUsd: usage.cost } : {}),
  });
  dropLanding(file);
}

/** One landing's own spend (reviewer + conflict resolution), accumulated across its pi runs. */
type LandingUsage = { tokens: number; cost: number };

/** A fresh usage accumulator for one landing plus the foldUsage callback that charges each of
 * its pi runs to BOTH the authoring runner's live state (foldLandingUsage: reviewer and
 * conflict-resolution spend belongs to the authoring role) and the landing's own accumulator
 * (the landed/land_failed event's usage). Every vet builds its wiring through this, and its
 * merge reuses it, so the accounting — and any future change to it — lives in one place. */
export function landingUsage(author: LoopRunner): {
  usage: LandingUsage;
  foldUsage: (run: PiRunResult) => void;
} {
  const usage: LandingUsage = { tokens: 0, cost: 0 };
  return {
    usage,
    foldUsage: (run) => {
      author.foldLandingUsage(run);
      usage.tokens += run.outputTokens;
      usage.cost += run.costUsd;
    },
  };
}
