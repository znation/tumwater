import type { TickResult } from "../tick/tick-outcome.js";
import type { ModelFallbackState } from "./model-fallback.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject, nonNegativeNumber } from "../files/json-object.js";
import path from "node:path";
import { readdirSync } from "node:fs";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { statePath, STATE_DIR } from "../paths.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { allRoleIds } from "../roles/roles.js";

/** The loop's persisted state file — one JSON object per role under .tumwater/ — and the
 * observation-window counter reset: fresh-state defaults, the tolerant load, the atomic
 * save, and zeroCounters. The scheduling POLICY that mutates this state from tick outcomes
 * and operator wakes — the outcome application and resume limits in tick-apply.ts, the
 * clock arithmetic (backoff ladders, wakes, yield ring) in backoff.ts; the generic file
 * helpers are src/files/files.ts and the JSON convention
 * itself is src/files/json-files.ts. */

/** How many times a progressing-timeout review may be resumed before the next attempt
 * reviews the change from scratch (LoopState.reviewResume). The budget bounds a reviewer that
 * keeps timing out mid-progress, so a wedged review converges to a fresh run instead of
 * resuming the same session forever. */
export const REVIEW_RESUME_LIMIT = 2;

/** Persisted per-loop state in .tumwater/state/<role>.json. */
export interface LoopState {
  role: string;
  ticks: number;
  commits: number;
  /** Epoch ms before which the loop must not run again. */
  nextRunAt: number;
  /** Current backoff in seconds (0 = not backing off). */
  backoffSeconds: number;
  /** main HEAD observed at the end of the last tick; a different HEAD wakes the loop. */
  lastMainHead: string;
  /** The role's recent yield as a ring of one-char codes, oldest first: `L` for a landing
   * (a `changed`/`queued` tick) and `n` for a counted empty tick — every result except the
   * error class (`error`/`aborted`/`quiet_killed`, which are no evidence of yield either
   * way) and the ring keeps the last YIELD_RING entries. Read by yieldMultiplier
   * (backoff.ts) to stretch the role's min-tick gap while it keeps finding nothing;
   * persisted because the gap decision must survive a restart like the rest of the
   * schedule. Absent on states written before the field existed — reads as an empty ring,
   * multiplier 1. */
  recentOutcomes?: string;
  /** The last COMPLETED result and its summary — the pair the dashboards' "last result" cell
   * renders. A `queued` tick never writes it (tick-apply.ts's applyTickOutcome): its change is
   * still in flight, which the state column already shows, so the pair keeps the prior outcome
   * until the landing resolves and applyLandingOutcome records the landing's own. */
  lastResult?: TickResult;
  lastSummary?: string;
  /** The summary a `queued` tick reported for the change it pinned (the text its tick_end
   * carries, high-friction annotation included), keyed by that change's sha. Held back from
   * `lastSummary` while the change waits, then paired with the landing's result by
   * applyLandingOutcome, which clears it — so after a landing the cell reads the landing's
   * outcome next to the summary of the change it landed, never next to the prior tick's.
   * Persisted: the land queue is durable, so the landing can resolve in a later process. */
  queuedSummary?: { sha: string; summary: string };
  lastTickStartedAt?: number;
  lastTickEndedAt?: number;
  /** True while a tick is in flight (best-effort; cleared on orchestrator start). */
  running?: boolean;
  /** Epoch ms since the orchestrator reserved this loop but its tick still waits in the
   * semaphore queue: it holds no maxConcurrent permit and runs no pi yet. Transient — set
   * by the orchestrator, cleared the moment the permit is granted (and defensively on tick
   * outcome / orchestrator start) — and never persisted, so dashboards can render the
   * parked waiter as `awaiting slot` and keep the active-state rows equal to the real
   * permit holders (BUGS.md 2026-09-24). */
  parkedSince?: number;
  /** The provider key a parked waiter is queued on (plans/provider-concurrency.md §8), set
   * alongside `parkedSince` by the orchestrator and cleared the moment the permit is
   * granted — the key the admission lease will acquire. It lets the dashboards render
   * `awaiting omlx slot` instead of the bare `awaiting slot` when that key is at its cap.
   * Transient like `parkedSince` — never persisted — and absent for a fleet-total waiter
   * (no key) or the director (which never queues), so both render exactly as before. */
  parkedOn?: string;
  /** True when the last tick was interrupted mid-task — aborted by a harness shutdown, or
   * truncated at the model's context ceiling — with its pi session (and any uncommitted
   * worktree edits, for shutdowns) left in place: the next tick resumes that session
   * (--continue) instead of starting fresh. Consumed (cleared) by that tick; set again only
   * by another interruption, so a failing resume falls back to a fresh start. */
  resumePending?: boolean;
  /** True when the run that set `resumePending` reported via `PiRunResult.resumeMissing`
   * that the backend no longer holds the session it tried to `--resume` (claude's "No
   * conversation found", or a pruned session). The transcript file the resume guard checks
   * can outlive the conversation — the fake leaves one, and a torn/empty file can — so the
   * next tick must hand off on this verdict rather than trust `agentSessionResumable` and
   * re-resume a session that is gone (BUGS.md 2026-10-09). Set only alongside
   * `resumePending` and cleared with it at tick start. */
  resumeMissing?: boolean;
  /** Why a pending resume happened when it was not a cut-off: "hung-tool" when the quiet
   * watchdog killed a run on a stalled tool call, so the bridge prompt names that cause (and
   * warns against re-running the hung command unchanged); "timeout" when the tick deadline
   * fired on a run still making progress — a slow run, not a failed one — so the bridge asks
   * for the smallest finish against the same limit; "budget-resumed" when the budget gate
   * reopened and the in-flight fallback tick was handed back to the primary model
   * (PLANS.md 2026-09-30); "rate-limit" when a subscription claude usage window rejected the
   * run, so the bridge names the held window rather than a restart (plans/agent-backends.md
   * part 6e); "budget-capped" when an API-billed claude run hit its per-run `--max-budget-usd`
   * cap, so the next tick hands the kept worktree off to the fallback seam (part 7a/7);
   * "image-reroute" when an authoring run read an image its model cannot see and the next
   * tick hands the kept worktree off to an image-capable peer tier (plans/image-input.md
   * part 4/5). Cleared with resumePending at tick start; absent for restart/cut-off resumes,
   * whose causes are derived. */
  resumeCause?: "hung-tool" | "timeout" | "budget-resumed" | "rate-limit" | "budget-capped" | "image-reroute";
  /** Queue file holding the user prompt a resume-owning tick re-queued: the interrupted pi
   * session still owns that request in its context, so the resume must reclaim exactly this
   * file as its own user prompt — the resume's fulfillment consumes it, and only its failure
   * paths re-queue it — instead of leaving the copy queued for a later fresh tick to run the
   * same request twice. Cleared at every tick's start; reclaimed only by a tick that resumes. */
  resumePromptFile?: string;
  /** Epoch ms of the last operator wake (`tumwater wake`, or the auto-wake a queued
   * per-role prompt sends) that cleared this loop's schedule. Scheduling input, not
   * observation: isEligible exempts the role's min-tick interval when the wake is newer
   * than the last tick's end, so an explicit "try again now" brings a slow-clock loop
   * (qa, steward) in within one poll instead of waiting out the interval it ticked inside
   * — the same exemption the director's inbox already grants user prompts. Self-clearing:
   * the next tick's end re-stamps lastTickEndedAt past the wake, restoring the ordinary
   * gap without a separate erase. */
  wokenAt?: number;
  /** Consecutive ticks that ended truncated at the context ceiling. Bounds cut-off resumes:
   * past the limit the loop abandons the runaway task and falls back to a fresh tick. */
  cutOffStreak?: number;
  /** Consecutive ticks ended by the quiet watchdog (`quiet_killed`). Bounds quiet-kill
   * resumes: while at or under the limit the loop resumes the starved session promptly,
   * past it the loop abandons the session and takes a fresh tick on the idle ladder, so a
   * session the backend will not schedule cannot retry immediately forever (BUGS.md
   * 2026-09-18). Reset by any non-quiet-kill outcome. */
  quietKillStreak?: number;
  /** Consecutive failed ticks: an `error`-result tick OR one whose leftover recovery left a
   * landing pin behind (TickOutcome.recoveryFailure). While at or past the warning threshold
   * (tick-apply.ts's ERROR_STREAK_WARN) the state cell reads "failing" instead of "sleeping",
   * and the crossing fires one warning event per episode (BUGS.md 2026-09-15: 44
   * identical tick failures looked like a quiet fleet; BUGS.md 2026-09-21: a dead reviewer
   * backend left every recovery landing failing silently and reset this streak each tick).
   * A review-rejected landing counts in too (BUGS.md 2026-09-30): the authoring tick ends
   * `queued`, which preserves the streak, and applyLandingOutcome's rejected branch is the
   * accumulation point; a landed change resets it. Reset by any other completed result. */
  consecutiveErrors?: number;
  /** Consecutive completed ticks that ended `no_change`. Observational only — the resting
   * state cell's ` · no change ×N` suffix (status-model.ts loopPhase) — so a loop that keeps
   * waking and returning nothing to do stops reading as an ordinary idle; a legitimately idle
   * maintenance loop with an empty backlog can hold a long streak and that is expected, so it
   * never warns (unlike consecutiveErrors/quietKillStreak). Reset by any completed result
   * other than `no_change`. Absent on states written before the field existed — reads as 0. */
  noChangeStreak?: number;
  /** Where in its cycle the loop was when it last persisted state: "review" means the
   * interruption hit during the review gate, so any uncommitted worktree edits are the
   * reviewer's stray output (discarded on resume), not author work. Set + saved around the
   * reviewer run; cleared at tick end alongside `running`. */
  phase?: "pi" | "review";
  /** The most recent review-gate outcome for this loop: what was decided, why, and which
   * branch HEAD it covered. A reject's reasons are injected into the role's next tick prompt
   * — every tick starts a fresh session, so this is the only cross-tick memory of what was
   * built and why it failed. */
  lastReview?: {
    verdict: string;
    reasons: string[];
    head?: string;
    at: number;
    /** Set on a rejection that used up the change's last revision round (plans/revise-
     * rejected.md): the rejected diff is gone, so the next prompt's rejected note says so and
     * no longer reads as an invitation to revise. Cleared implicitly on the next rejection,
     * which writes a fresh lastReview object. */
    exhausted?: boolean;
  };
  /** Branch HEAD that passed review most recently. Leftover commits at exactly this HEAD
   * merge without re-review (a merge_blocked retry must not burn another review run). */
  lastApprovedHead?: string;
  /** git/git.ts patchId of the change at lastApprovedHead against main — the diff the reviewer
   * judged. A different head carrying the same patch (a clean rebase onto a moved main) reuses
   * the approval: no second model review, though the gate's build pre-check still runs. */
  lastApprovedPatchId?: string;
  /** Consecutive failed reviews of the SAME branch HEAD (reset when the reviewed HEAD
   * changes or a review succeeds). Past the limit the leftover is discarded with a warning,
   * so a misconfigured reviewer cannot wedge a loop re-reviewing one commit forever. */
  unreviewFailures?: number;
  /** The reviewer session a progressing-timeout review left for the next attempt: the
   * patch-id it was judging (only the same diff may resume), the per-run session directory to
   * `--continue` in, how many resumes have already been attempted, and when the marker was
   * written. Set when a review run hits its time budget while still making progress; cleared
   * by any verdict, any other failure, a discard, or a landing. Absent for a loop with no
   * timed-out review, so existing state files read unchanged. */
  reviewResume?: { patchId: string; sessionDir: string; attempts: number; at: number };
  /** Consecutive landings of the SAME pinned sha that ended `merge_conflict` — each one a failed
   * conflict-resolution run. Keyed by sha: a pin that rebased cleanly onto a moved main is a new
   * attempt and starts fresh. At MERGE_CONFLICT_LIMIT leftover recovery stops re-queuing: it
   * hands the pin back to its author to resolve (PLANS.md "Robust conflict landing, part 2/2"),
   * or discards it when that lineage was already handed back — either way an unmergeable change
   * cannot hold its role off authoring forever. */
  mergeConflicts?: { sha: string; count: number };
  /** The change leftover recovery discarded at MERGE_CONFLICT_LIMIT, named in the role's
   * prompts until its next change is queued — the author's only memory that the work is gone
   * and must be redone against current main if it is still wanted. */
  conflictDiscard?: { sha: string; summary: string; attempts: number; at: number };
  /** A change handed back to its author when its landings kept ending in unresolved merge
   * conflicts with main, or its revision re-apply conflicted (PLANS.md "Robust conflict
   * landing, part 2/2"): its sha, when, why, the revision round when the hand-back is a
   * revision, and whether the re-apply onto current main has happened yet. The author's next
   * non-resume tick re-applies the sha with conflict markers left as ordinary uncommitted
   * edits, appends the hand-back note, and deletes the landing ref. The record then lives
   * exactly as long as the resolved change: while it is queued or pinned for its landing, a
   * conflict at the cap discards it rather than handing it back a second time. It is cleared
   * when that change lands or is rejected (tick-apply.ts), and when a tick neither commits the
   * marker edits nor leaves a session to resume them (no_change, a deliberate user_aborted, or
   * an error/quiet-kill with no resume), nor while a rejected change's revision still owes
   * them. Absent for a loop with no hand-back, so older state files read unchanged. */
  conflictHandback?: {
    sha: string;
    at: number;
    reason: "landing" | "revision";
    round?: number;
    applied: boolean;
  };
  /** This role's active model-fallback episode (src/loop/model-fallback.ts): set once
   * consecutive provider-class failures on the primary trip it, cleared by a probe tick on
   * the primary that answers without a provider failure. Absent means the role runs its
   * primary model, so existing state files read unchanged. Persisted: an episode must survive
   * a restart like the schedule does. */
  modelFallback?: ModelFallbackState;
  /** The one-shot image-input reroute a blind-read tick left for the next tick
   * (plans/image-input.md "Rerunning on a model that can read images"): the target tier and
   * the resolved target seam (provider/model/thinking), plus `from` (the selector string of
   * the model the blind run was on) and `path` (the image file it read). The next tick starts
   * directly on the target in a FRESH session over the kept worktree, never `--continue`;
   * the field is cleared at that tick's start. Persisted like modelFallback (healed); absent
   * for a loop with no pending reroute, so older state files read unchanged. */
  imageReroute?: {
    tier: "small" | "default" | "strong";
    provider?: string;
    model?: string;
    thinking?: string;
    from?: string;
    path?: string;
  };
  /** True while the CURRENT tick is an image-input reroute — it started on the image-capable
   * target (from a blind-read handoff or an attachment preflight) instead of the loop's own
   * tier. Read by the verdict's one-hop guard, which fails a blind read during a rerouted
   * tick instead of rerouting it again. Transient: reset at every tick start. */
  imageRerouteActive?: boolean;
  /** The pinned change a landing failed to review on a permanent provider configuration error
   * (a 4xx other than 408/429): the request can never succeed until the model config changes,
   * so leftover recovery holds the pin instead of re-queuing it at suite speed (BUGS.md
   * 2026-10-06). `selector` is the resolved reviewer selector that failed — when the loop's
   * current reviewer selector differs, the config has changed and recovery clears the hold and
   * re-queues. Cleared when the pin lands or is rejected. */
  landingReviewError?: { sha: string; selector?: string; message: string };
  /** Consecutive landings of one patch (git/git.ts patchId, stable across a clean rebase) whose
   * in-lock check went red on the rebased tree. At landing-check-failures.ts's
   * LANDING_CHECK_FAILURE_LIMIT the red is attributed through main's own verdict instead of
   * re-queued as merge_blocked again. */
  landingCheckFailures?: { patchId: string; count: number };
  /** Tokens the model generated in this loop's current or last completed tick — a per-tick
   * window (loop-tick.ts resets it at tick start), not a lifetime total. */
  generatedTokens: number;
  /** Largest single-request context of this loop's current or last completed tick (per-tick
   * window, reset at tick start). */
  peakContextTokens: number;
  totalCostUsd: number;
  /** Local calendar day (YYYY-MM-DD) that `dayCostUsd` belongs to; a stale or missing stamp
   * reads as $0 today — spend before this field existed is unknown, and a tick crossing local
   * midnight attributes its spend to the new day. See plans/daily-cost-budget.md. */
  dayStamp?: string;
  /** This loop's spend for `dayStamp`'s local day (the daily cost budget window). Deliberately
   * NOT zeroed by reset-counters: the budget is a safety valve, not an observation window. */
  dayCostUsd?: number;
  lastError?: string;
  /** Epoch ms (Date.now()) of the last time this loop landed a change on main (set only in
   * applyLandingOutcome's `changed` branch, src/tick/tick-apply.ts). Absent until the first
   * landing, and absent on state files written before the field existed, so the last-landed
   * age reads "never" until then. Mirrors lastTickEndedAt: an observational timestamp that
   * reset-counters deliberately leaves alone — the dry-spell question it answers is about
   * landed work, not counters. */
  lastLandedAt?: number;
  /** The backlog entry this instance is assigned to implement or fix (plans/parallel-work-
   * instances.md "Claims", part 4/7): its file, the stamp-free key (backlog-eligibility.ts's
   * entryKey) that survives a done stamp or a Refused note, the verbatim heading at
   * assignment, when it was assigned, and whether the harness assigned it (`assigned`) or an
   * unassigned tick moved it at staging (`staged`). Persisted with the loop's state, so a
   * crash, resume, revision or leftover recovery carries it with no extra store. Absent for a
   * loop with no claim, so existing state files read unchanged. */
  claim?: {
    file: "PLANS.md" | "BUGS.md";
    key: string;
    title: string;
    at: number;
    source: "assigned" | "staged";
  };
  /** Titles of the entries siblings hold while this instance runs unassigned (nothing free to
   * claim): set by the scheduling poll, read by the tick prompt's exclusion note, so a primary
   * does not author an entry a sibling already holds. Cleared whenever the poll finds nothing
   * held or assigns a claim. */
  heldElsewhere?: string[];
  /** Why the scheduling poll last skipped this loop while it was due: set by the poll for an idle
   * extra instance with no free entry, the claim-group hold, or a need-based deferral, and
   * cleared when the poll admits the loop or finds it not due. Absent otherwise. */
  skipReason?: SkipReason;
  /** The rejected change this loop owes a revision to (plans/revise-rejected.md): its head, how
   * many revision rounds have been attempted, and when the rejection was recorded. Set at a gate
   * rejection that keeps revising; consumed when the revision stages, drops, or conflicts;
   * cleared when the rejected change is final (a repeated objection or the backstop, BUGS.md
   * 2026-10-14). `reasonCounts` holds each of that rejection's objections' persistence counts —
   * how many consecutive revisions each has survived — aligned with `lastReview.reasons`;
   * staging copies it onto the queued landing's PriorReview so the next rejection can resolve a
   * `(prior N)` tag to a count. Absent for a loop with no outstanding rejection, so existing
   * state files read unchanged (and an older file without `reasonCounts` reads as all-new). */
  revision?: { sha: string; round: number; at: number; reasonCounts?: number[] };
}

/** Why a due loop was skipped by the scheduling poll (LoopState.skipReason). */
export type SkipReason = "no-free-entry" | "claim-hold" | "deferred-backlog" | "deferred-no-work" | "deferred-plans-full";

const SKIP_REASONS: readonly string[] = [
  "no-free-entry",
  "claim-hold",
  "deferred-backlog",
  "deferred-no-work",
  "deferred-plans-full",
];

/** A new LoopState for one role, before its first tick. */
export function freshLoopState(role: string): LoopState {
  return {
    role,
    ticks: 0,
    commits: 0,
    nextRunAt: 0,
    backoffSeconds: 0,
    lastMainHead: "",
    generatedTokens: 0,
    peakContextTokens: 0,
    totalCostUsd: 0,
    dayStamp: "",
    dayCostUsd: 0,
  };
}

/** A persisted numeric field, healed to a finite non-negative number (the fallback when it is
 * absent, foreign, NaN/±Infinity, or negative). Every numeric field on LoopState — top-level or
 * inside one of the nested records below — is a count, a duration, an epoch-ms stamp, or an
 * amount, so zero is the only sensible repair; the `tick-usage.ts` and `budget.ts` writers floor
 * the same three quantities they own. A guard count (mergeConflicts, landingCheckFailures,
 * unreviewFailures) heals to 0 like the rest: a corrupt strike tally re-accumulates from the
 * next attempt, the same "the field is unusable, start the count over" repair the top-level heal
 * already gives the error streak. */
function healNumber(value: unknown, fallback: number): number {
  return nonNegativeNumber(value, fallback);
}

/** Heal one OPTIONAL numeric field of a persisted record in place, preserving the field's
 * absent shape: an absent field stays absent (an older state file with no such field reads
 * unchanged), while a present field heals by healNumber's rule. Every optional numeric field
 * loadLoopState repairs — the eight top-level stamps/streaks and conflictHandback.round —
 * goes through this one guard, so the "absent stays absent" repair cannot be dropped from
 * one field while another keeps it. */
function healOptionalNumber<T extends object, K extends keyof T>(rec: T, key: K): void {
  const value = rec[key];
  if (value !== undefined) rec[key] = healNumber(value, 0) as T[K];
}

/** Heal one persisted nested record: absent stays absent; a present non-object (a string,
 * number, NaN, null, or array) is dropped to undefined — every consumer of these records reads
 * them with property access or mutation (landing-core sets `lastReview.exhausted`, tick-apply
 * adds to `mergeConflicts.count`), and property access on a torn scalar reads undefined where
 * the mutation throws "Cannot create property … on string" in a strict ES module; a present
 * object keeps its shape with each numeric field repaired by `heal`. */
function healRecord<T extends object>(value: T | undefined, heal: (v: T) => void): T | undefined {
  if (value === undefined || !isJsonObject(value)) return undefined;
  heal(value);
  return value;
}

/** Load the loop's persisted state; never throws — a missing or unreadable file yields a
 * fresh state, fields absent from an older file fall back to defaults, and a numeric field
 * (top-level or nested) that is present but not a finite non-negative number is healed to 0,
 * a nested record that is present but not a plain object is dropped, and lastReview.reasons is
 * rebuilt to its string entries. The load is the one
 * read boundary for the state file (readJsonFile returns an unchecked cast), so healing here
 * keeps a hand-edited string, null, or negative out of the schedulers and the dashboards'
 * arithmetic instead of relying on each reader to guard it. Optional fields that are absent
 * stay absent, so an older state file's shape is preserved. */
export function loadLoopState(root: string, role: string): LoopState {
  const saved = readJsonFile<Partial<LoopState>>(statePath(root, role));
  const s: LoopState = { ...freshLoopState(role), ...(saved ?? {}) };
  s.ticks = healNumber(s.ticks, 0);
  s.commits = healNumber(s.commits, 0);
  s.nextRunAt = healNumber(s.nextRunAt, 0);
  s.backoffSeconds = healNumber(s.backoffSeconds, 0);
  s.generatedTokens = healNumber(s.generatedTokens, 0);
  s.peakContextTokens = healNumber(s.peakContextTokens, 0);
  s.totalCostUsd = healNumber(s.totalCostUsd, 0);
  s.dayCostUsd = healNumber(s.dayCostUsd, 0);
  healOptionalNumber(s, "lastTickStartedAt");
  healOptionalNumber(s, "lastTickEndedAt");
  healOptionalNumber(s, "lastLandedAt");
  healOptionalNumber(s, "wokenAt");
  healOptionalNumber(s, "cutOffStreak");
  healOptionalNumber(s, "quietKillStreak");
  healOptionalNumber(s, "consecutiveErrors");
  healOptionalNumber(s, "noChangeStreak");
  healOptionalNumber(s, "unreviewFailures");
  healOptionalNumber(s, "parkedSince");
  if (s.skipReason !== undefined && !SKIP_REASONS.includes(s.skipReason)) delete s.skipReason;
  if (s.reviewResume !== undefined) {
    const r = healRecord(s.reviewResume, (v) => {
      v.attempts = healNumber(v.attempts, 0);
      v.at = healNumber(v.at, 0);
    });
    // A marker without the two strings it keys on names no session to resume, so a malformed
    // one is dropped here rather than left to throw in sessionResumable.
    s.reviewResume =
      r && typeof r.patchId === "string" && typeof r.sessionDir === "string" ? r : undefined;
  }
  // The nested scheduling records carry the same numeric class — epoch-ms stamps, recovery
  // counts, and the fallback episode's clock — and are read by comparison or arithmetic
  // (`ctx.now - claim.at > CLAIM_IDLE_MAX_MS`, `prior.count + 1`, `cooldownMs * 2`), so a
  // foreign value there is healed the same way the top-level fields are.
  if (s.lastReview !== undefined)
    s.lastReview = healRecord(s.lastReview, (v) => {
      v.at = healNumber(v.at, 0);
      // The one nested non-numeric slot whose foreign type throws rather than reads odd: the
      // rejected-review notes build a numbered list from `reasons` (numberedList's `.map`), so
      // a hand-edited scalar or a missing field would crash the next tick's prompt. Rebuild it
      // to its string entries — the same "the field is unusable, start it over" repair the
      // numeric fields get.
      v.reasons = Array.isArray(v.reasons)
        ? v.reasons.filter((r) => typeof r === "string")
        : [];
    });
  if (s.claim !== undefined)
    s.claim = healRecord(s.claim, (v) => {
      v.at = healNumber(v.at, 0);
    });
  if (s.revision !== undefined)
    s.revision = healRecord(s.revision, (v) => {
      v.round = healNumber(v.round, 0);
      v.at = healNumber(v.at, 0);
      // reasonCounts is a count array (the default of 0/[] for a corrupt or absent value keeps
      // a repeat from reading as a long-standing one) — rebuild it to non-negative numbers.
      v.reasonCounts = Array.isArray(v.reasonCounts)
        ? v.reasonCounts.map((c) => healNumber(c, 0))
        : undefined;
    });
  if (s.mergeConflicts !== undefined)
    s.mergeConflicts = healRecord(s.mergeConflicts, (v) => {
      v.count = healNumber(v.count, 0);
    });
  if (s.conflictDiscard !== undefined)
    s.conflictDiscard = healRecord(s.conflictDiscard, (v) => {
      v.attempts = healNumber(v.attempts, 0);
      v.at = healNumber(v.at, 0);
    });
  if (s.conflictHandback !== undefined)
    s.conflictHandback = healRecord(s.conflictHandback, (v) => {
      v.at = healNumber(v.at, 0);
      healOptionalNumber(v, "round");
    });
  if (s.landingCheckFailures !== undefined)
    s.landingCheckFailures = healRecord(s.landingCheckFailures, (v) => {
      v.count = healNumber(v.count, 0);
    });
  if (s.modelFallback !== undefined)
    s.modelFallback = healRecord(s.modelFallback, (v) => {
      v.failures = healNumber(v.failures, 0);
      v.since = healNumber(v.since, 0);
      v.probeAt = healNumber(v.probeAt, 0);
      v.cooldownMs = healNumber(v.cooldownMs, 0);
    });
  // The image-reroute marker is a one-shot nested record consumed by the next tick; a torn
  // scalar is dropped (its consumers read/mutate fields), and the tier is repaired to a
  // known tier name so a corrupt tier cannot route a rerouted tick to a phantom seam.
  if (s.imageReroute !== undefined) {
    const healed = healRecord(s.imageReroute, () => {});
    s.imageReroute =
      healed && (healed.tier === "small" || healed.tier === "default" || healed.tier === "strong")
        ? healed
        : undefined;
  }
  return s;
}

/** Persist the loop's state atomically via writeJsonAtomic, so a crash mid-write cannot
 * leave a torn file behind. Its per-pid tmp name matters here: two processes can write one
 * role's state concurrently — the orchestrator saves at tick end and around its review gate
 * while `tumwater reset-counters` rewrites the same file from the CLI process — and per-pid
 * names give each writer its own tmp with a clean last-writer-wins. */
export function saveLoopState(root: string, state: LoopState): void {
  writeJsonAtomic(statePath(root, state.role), state);
}

/** Zero the accumulated counters (ticks, commits, tokens, cost) so a fresh observation
 * window can begin. Pure: returns a new state and preserves everything else — scheduling
 * fields (nextRunAt, backoffSeconds), wake tracking (lastMainHead), and the last-result
 * fields. peakContextTokens is zeroed too: under per-tick semantics it holds the loop's
 * last completed tick's peak, so a fresh window must clear it or sleeping loops keep
 * showing their old value until they next tick. The daily cost budget window (dayStamp/
 * dayCostUsd) is deliberately NOT zeroed: the budget is a safety valve, not an observation
 * window — zeroing today's spend would let the cap be bypassed by running reset-counters.
 */
export function zeroCounters(s: LoopState): LoopState {
  return { ...s, ticks: 0, commits: 0, generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0 };
}

/** The skip reason a loop's persisted state yields when it does not run this round: a pending
 * resume wait outranks backoff, anything else is idle. The shared tail of the two skip
 * classifiers — once-round.ts's settleSkipped (which adds the disabled arm) and cli/cli-run.ts's
 * once-summary (which adds the fleet-pause arm) — so the two surfaces cannot drift on which
 * reason wins when several conditions hold at once. */
export function stateSkipReason(
  s: Pick<LoopState, "resumePending" | "backoffSeconds">,
): string {
  if (s.resumePending) return "resume pending";
  if (s.backoffSeconds > 0) return "backoff";
  return "idle";
}

/** True when the loop still owes follow-up work for its current task after a tick: a rejected
 * change it must revise (state.revision) or a session it must resume (state.resumePending).
 * Both keep the instance bound to the same task, so the claim-release rule
 * (tick/tick-finalize.ts), the conflict-handback rule (tick/tick-apply.ts), and claims.ts's
 * idle test all read this one predicate instead of repeating the revision/resume conjunction. */
export function hasOutstandingWork(s: Pick<LoopState, "revision" | "resumePending">): boolean {
  return s.revision !== undefined || s.resumePending === true;
}

/** Per-role cache of the persisted live claim, keyed by the state file's stat — one stat per
 * role per call in steady state, a read only when the file changed (cachedByStat's contract),
 * so a fleet poll's allLiveClaims does no read I/O once every claim is known. */
const liveClaimCache = new Map<string, StatKeyedValue<{ role: string; key: string }>>();

/** Every loop id whose persisted claim must be considered — the built-in catalog roles
 * (allRoleIds) plus the parallel-work instance ids (feature-2, bugfix-3, …) that have a state
 * file. Instances are not in the built-in catalog, so they are enumerated from the state
 * directory rather than the config: a claim lives in its role's state file, and reading the
 * directory catches an instance's claim whether or not the config still lists its count (a
 * lowered or disabled instance that still holds a claim must not open its plan to another
 * base). Any state file whose id resolves away from itself under baseRoleOf is an instance
 * id; the named non-role files in that directory (orchestrator.json, claude-account.json, …)
 * resolve to themselves and so are skipped, as are the base roles allRoleIds already names. */
function liveClaimLoopIds(root: string): string[] {
  const ids = new Set(allRoleIds());
  try {
    for (const name of readdirSync(path.join(root, STATE_DIR, "state"))) {
      const id = name.replace(/\.json$/, "");
      if (baseRoleOf(id) !== id) ids.add(id);
    }
  } catch {
    // no state directory yet — the catalog roles (fresh, claim-less) suffice
  }
  return [...ids];
}

/** The live backlog claim of every built-in role and running instance, keyed by claim
 * entryKey — `Map<key, role>` — for the ones that hold one. The cross-role in-flight hold
 * (BUGS.md 2026-10-09): a plan a `feature` instance claimed stays listed under PLANS.md
 * `## Planned` until its landing merges to main, so an eligibility reader built for another
 * role would otherwise see it as open and let that role implement it a second time — the
 * duplicate then fails review as a claim mismatch. Same-base claims are deliberately NOT
 * filtered here: callers (eligibleEntries) apply their own base rule, because the scheduling
 * pass and staged claims already hold same-base entries and the owner's own claim must stay
 * eligible for its release rules. A `feature-2` instance's claim is therefore read and keyed
 * under `feature-2`; callers fold it to its base. */
export function allLiveClaims(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of liveClaimLoopIds(root)) {
    const file = statePath(root, id);
    const claim = cachedByStat(
      liveClaimCache,
      file,
      file,
      () => {
        const s = loadLoopState(root, id);
        return s.claim ? { role: id, key: s.claim.key } : null;
      },
      (v) => ({ ...v }),
    );
    if (claim) out.set(claim.key, id);
  }
  return out;
}
