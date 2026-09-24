import type { TumwaterConfig } from "./config-schema.js";
import type { LandingEntry, LoopState, PiRunResult, TickResult } from "./types.js";
import { applyLandingOutcome, saveLoopState } from "./state.js";
import { logEvent } from "./events.js";
import { dropLanding } from "./land-queue.js";
import { landChange } from "./lander.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { removeQuiet } from "./files.js";
import { landingStatePath } from "./paths.js";
import { errorMessage } from "./text.js";
import type { LoopRunner } from "./loop.js";

/** The poll loop's landing slot (merge queue 3/5): the queue-drain side of landing, split out
 * of orchestrator.ts — which keeps the poll loop and scheduling — so the slot's own bookkeeping
 * lives together, separate from the landing mechanics themselves (lander.ts: review gate,
 * rebase, ff-merge). This module owns the 4/5 in-flight marker around each landing, the
 * per-landing usage accounting, and the write-back that folds every outcome into the authoring
 * role's state and drops its queue entry. A landing's pi runs charge to the authoring runner
 * (foldLandingUsage); orchestrator.ts drives this module once per queue head, per poll. */

/** Where a landing is in its flow, as far as an observer can tell: `merging` — the git steps
 * (lander checkout, rebase onto main, the in-lock re-check and fast-forward); `build-check` —
 * a deterministic check (the gate's pre-check over the change's tree, its one re-run, and the
 * attribution check of main's tip behind a repeat failure, or a batch's shared stack check); `reviewing` — the adversarial reviewer's pi run,
 * whose live turns/context/tool the dashboards read from the role's raw log. Everything else a
 * landing does (verdict parsing, state saves) is sub-second bookkeeping between these. */
export type LandingStage = "merging" | "build-check" | "reviewing";

/** Where one batched change stands in its landing (merge queue 5/5) — the per-change status a
 * batch marker carries, so each batched role's row says what the slot is doing with ITS change
 * rather than the whole batch reading as one change's landing (BUGS.md 2026-09-23):
 * - `waiting`: batched, but the slot has not reached it yet — `queued in batch`;
 * - `landing`: the slot is working on it right now — its review gate, the stack's shared build
 *   check and fast-forward, or its one-at-a-time fallback landing — `landing <its elapsed> ·
 *   <stage>`, the only live state (several changes can hold it at once: Phase A runs gates
 *   concurrently, and a stack lands together);
 * - `approved`: its gate approved it and it waits for the rest of the batch before the stack
 *   lands — `approved, awaiting batch`;
 * - `done`: the batch is finished with it — a final verdict, a failed or aborted gate, or left
 *   queued for the next drain by an early stop — and the marker shows nothing for it: its row
 *   reads its own state. */
export type LandingChangeStatus = "waiting" | "landing" | "approved" | "done";

/** One batched change's record in the in-flight marker. `startedAt` is stamped the first time
 * the change enters `landing` (its gate start) and kept through the rest of the batch, so its
 * `landing <elapsed>` measures this change's own landing, never the batch's; absent until the
 * slot reaches it. `stage` is this change's own LandingStage (setLandingStage), reset to
 * `merging` each time it enters `landing` — every entry starts with git steps (the gate's
 * checkout and rebase, the stack's assembly, a fallback's merge). Keyed by role within a batch
 * — invariant 3 caps a role at one in-flight change, so a stack is N changes from N distinct
 * roles. */
export interface LandingChange {
  role: string;
  sha: string;
  summary: string;
  status: LandingChangeStatus;
  startedAt?: number;
  stage?: LandingStage;
}

/** The in-flight landing's marker (plans/merge-queue.md 4/5): which change is landing right
 * now, since when, and which stage it is in. The slot writes it before a landing starts and
 * removes it after every outcome, so the separate-process observers (status, TUI, GUI) can
 * show the landing without depending on the scheduler module — the OrchestratorInfo
 * precedent. snapshot() cross-checks it with matching queue entries and the orchestrator's
 * liveness, so a stale marker from any crash ordering never displays. `stage` rides the same
 * file rather than a second one — the marker is the one cross-process surface both dashboards
 * already read; the landing path advances it (setLandingStage) and the landing cell renders it
 * (loopPhase). It is optional on READ only: a marker from an older writer mid-upgrade carries
 * none and renders the bare elapsed label, while every writer must name one
 * (writeLandingMarker). A single landing's marker is these top-level fields alone. A batch's
 * marker also carries `changes`, one record per batched request in queue order — the source of
 * truth for every batched row, each advanced as landBatch reaches its change
 * (setLandingChangeStatus) and staged by its own gate (setLandingStage). Its top-level fields
 * then mirror the first change in `landing`, so an observer from a generation that reads only
 * them still names a change actually in flight, with that change's own start and stage. Read
 * both shapes through landingChanges. */
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

/** Open a batch's marker (merge queue 5/5): every batched entry as a `waiting` record in queue
 * order, the top level naming the head at `merging` until landBatch reports the first change it
 * reaches. */
export function writeBatchLandingMarker(root: string, entries: LandingEntry[], startedAt: number): void {
  const head = entries[0]!;
  writeLandingMarker(root, {
    role: head.role,
    sha: head.sha,
    summary: head.summary,
    startedAt,
    stage: "merging",
    changes: entries.map((e) => ({ role: e.role, sha: e.sha, summary: e.summary, status: "waiting" })),
  });
}

/** Rewrite a batch marker after one of its records changed: re-point the top level at the
 * first change in `landing` (see LandingInFlight — left as is while none is), then write it.
 * Never throws: the marker is display-only, and a failed write must not fail a landing
 * mid-batch (the observers keep the previous frame's record until the next write). */
function rewriteBatchMarker(root: string, marker: LandingInFlight & { changes: LandingChange[] }): void {
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

/** Advance one batched change's record in the live marker — landBatch's per-change status
 * hook, wired by the batch slot. A read-modify-write of the file, not a rewrite from the
 * slot's memory, so the stage its own gate last set (setLandingStage, the same process)
 * survives. Each move to `landing` resets the change's stage to `merging` and the first stamps
 * its own `startedAt`. A no-op when there is no marker or it has no record for `role` — a
 * single landing's marker carries none. Never throws (rewriteBatchMarker). */
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
  rewriteBatchMarker(root, { ...marker, changes });
}

/** Advance a landing's stage — called by the landing path at each transition: review.ts before
 * its pre-check (`build-check`) and before its reviewer run (`reviewing`), lander.ts's
 * reviewPinnedChange once the gate returns (`merging`, whatever it decided — a finished
 * reviewer's last turns must not sit in the cell accruing a false `no pi output` flag while a
 * batch works through its other changes), and land-batch.ts around the batch's shared stack
 * check. On a batch marker it stages `role`'s own record — every concurrent Phase-A gate
 * advances its own change's cell, so no stage has to be remembered for a later re-point; on a
 * single landing's marker, the marker itself when it names `role`. A no-op otherwise: the
 * shared gate also runs inside ticks (leftover recovery — no marker; that tick's own reviewing
 * cell carries its detail). Only the stage changes: sha and startedAt are what the snapshot
 * cross-check and the landing's elapsed read. */
export function setLandingStage(root: string, role: string, stage: LandingStage): void {
  const marker = readLandingMarker(root);
  if (!marker) return;
  if (marker.changes) {
    const change = marker.changes.find((c) => c.role === role);
    if (!change || change.stage === stage) return;
    change.stage = stage;
    rewriteBatchMarker(root, { ...marker, changes: marker.changes });
    return;
  }
  if (marker.role !== role || marker.stage === stage) return;
  writeLandingMarker(root, { ...marker, stage });
}

/** The marker's per-change records, whichever shape it has: a batch marker's `changes` as
 * written, or — for a single landing, or a batch marker an older generation wrote before
 * batches carried records — its one top-level change, `landing` since the marker's start at the
 * marker's stage. The one reader of both shapes, so the snapshot's cross-check, the drain's
 * stale-marker dedupe, and the rows cannot disagree about which changes a marker names. */
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
 * write-back shared by the single path (landQueuedEntry) and the 5/5 batch slot: apply the
 * result to the live state object (paired with the entry's change for the last-result cell —
 * applyLandingOutcome), persist it, log landed/land_failed with the landing's own
 * duration and usage (omitted when zero — the 4/5 idiom, so review-exempt landings render
 * bare; for a batched change that is the batch's wall clock up to its outcome and its own
 * role's spend), and drop the entry: EVERY defined result drops. The 4/5 marker is each
 * caller's own concern — landQueuedEntry writes/removes it around this call; the batch slot
 * opens it with a record per batched change, landBatch advances each record as it reaches that
 * change, and the slot removes it in its finally. */
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
 * (the landed/land_failed event's usage). The single path and the 5/5 batch slot build their
 * wiring through this, so the accounting — and any future change to it — lives in one place. */
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

/** Land one queued entry end-to-end — the poll loop's single landing slot, exported so the
 * loop-level tests can drive one landing without standing up the whole orchestrator (the drain
 * calls it exactly once per queue head, per poll): run the pinned sha through the shared
 * lander (review gate, rebase, ff-merge) with the authoring runner's wiring — its live state
 * object, runLandingPi (harness-shutdown signal only), foldLandingUsage (reviewer and
 * conflict-resolution spend charge to the AUTHORING role) — then fold the outcome into that
 * state, save it, log landed/land_failed with the landing's own duration and usage, and drop
 * the entry (writeLandingOutcome): EVERY outcome drops. Non-terminal outcomes keep the
 * landing ref, so the retry is the role's next fresh tick through leftover recovery — normal
 * cadence, same gate, same strike cap — never a queue re-drain. Never rejects: landChange
 * already degrades its own failures to TickResult values; an unexpected throw lands as an
 * "error" outcome (the ref survives for next-tick recovery). */
export async function landQueuedEntry(
  root: string,
  entry: LandingEntry,
  file: string,
  author: LoopRunner,
  config: TumwaterConfig,
  mainBranch: string,
  signal: AbortSignal,
): Promise<TickResult> {
  const startedAt = Date.now();
  // Merge queue 4/5 — publish the in-flight marker the observers read (snapshot cross-checks
  // it with a matching queue entry and the orchestrator's liveness): written before the
  // landing runs, removed on EVERY outcome below (the catch-all turns even an unexpected
  // throw into an outcome, so the removal always runs). A crash in between leaves a stale
  // marker that the cross-check self-heals — no cleanup pass needed.
  writeLandingMarker(root, {
    role: entry.role,
    sha: entry.sha,
    summary: entry.summary,
    startedAt,
    // landChange checks the pin out and rebases it onto main before the gate — git steps, so
    // the marker opens at `merging` and the gate advances it from there.
    stage: "merging",
  });
  const { usage, foldUsage } = landingUsage(author);
  let result: TickResult;
  try {
    result = await landChange(
      {
        root,
        mainBranch,
        config,
        state: author.state,
        runPi: (w, p, s) => author.runLandingPi(w, p, s),
        foldUsage,
        signal: () => signal,
      },
      {
        role: entry.role,
        sha: entry.sha,
        tick: entry.tick,
        summary: entry.summary,
        body: entry.body,
        highFriction: entry.highFriction,
      },
    );
  } catch (err) {
    result = "error";
    author.state.lastError = errorMessage(err);
  }
  writeLandingOutcome(root, entry, author.state, result, Date.now() - startedAt, usage, file);
  // The outcome is fully applied (state saved, event logged, entry dropped): clear the 4/5
  // marker. Between the drop and this removal a poll may briefly see depth 0 with no
  // inFlight — the landing is done, so nothing is misdisplayed.
  removeQuiet(landingStatePath(root));
  return result;
}
