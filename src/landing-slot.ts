import type { TumwaterConfig } from "./config-schema.js";
import type { LandingEntry, LoopState, PiRunResult, TickResult } from "./types.js";
import { applyLandingOutcome, saveLoopState } from "./state.js";
import { logEvent } from "./events.js";
import { dropLanding } from "./land-queue.js";
import { landChange } from "./lander.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";
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

/** The in-flight landing's marker (plans/merge-queue.md 4/5): which change is landing right
 * now, and since when. The slot writes it before a landing starts and removes it after every
 * outcome, so the separate-process observers (status, TUI, GUI) can show the landing without
 * depending on the scheduler module — the OrchestratorInfo precedent. snapshot() cross-checks
 * it with a matching queue entry and the orchestrator's liveness, so a stale marker from any
 * crash ordering never displays. */
export interface LandingInFlight {
  role: string;
  sha: string;
  summary: string;
  startedAt: number;
}

/** Publish the in-flight landing marker — the one place its shape is constructed, so the
 * interface is enforced here rather than at each caller's inline `writeJsonFile`. */
export function writeLandingMarker(root: string, marker: LandingInFlight): void {
  writeJsonFile(landingStatePath(root), marker);
}

/** Read the in-flight landing marker; null when missing or unreadable. Never throws —
 * observers poll it every second, and a torn write (a crash mid-write) must not take them
 * down (the readOrchestratorInfo precedent). */
export function readLandingMarker(root: string): LandingInFlight | null {
  return readJsonFile<LandingInFlight>(landingStatePath(root));
}

/** Fold one landing's outcome into its role's state and drop its queue entry — the 3/5
 * write-back shared by the single path (landQueuedEntry) and the 5/5 batch slot: apply the
 * result to the live state object (paired with the entry's change for the last-result cell —
 * applyLandingOutcome), persist it, log landed/land_failed with the landing's own
 * duration and usage (omitted when zero — the 4/5 idiom, so review-exempt landings render
 * bare; for a batched change that is the batch's wall clock and its own role's spend), and
 * drop the entry: EVERY defined result drops. The 4/5 marker is each caller's own concern —
 * landQueuedEntry writes/removes it around this call, the batch slot writes it for its head
 * and removes it in its finally. */
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
