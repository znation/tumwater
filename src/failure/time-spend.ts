/** The failure digest's time-and-spend fold: read the window's `tick_end`s and price each one into
 * the per-role × outcome-class table (ticks, summed wall-clock ms, cost) plus the loss-cause
 * ranking that weighs causes by agent-hours rather than tick counts. Split from
 * src/failure/failure-data.ts, which owns the rest of the collection (outcome tallies, deltas,
 * clustered sections) and calls into timeAndSpend here; the Markdown rendering of both stays in
 * src/failure/failure-render.ts as a pure function of the collected data. */
import type { TickResult } from "../tick/tick-outcome.js";
import type { HarnessEvent } from "../events/events.js";
import { eventRole, eventUsage, tickSpanMs, tickStartMap } from "../events/event-read.js";
import { errorTextOrPlaceholder, normalizeClusterKey, poolTimeoutKey, sortedRoles, truncateExample } from "./failure-cluster.js";
import { resolveQueuedResult, bucketLandingEvents } from "../history/history-data.js";
import { nonNegativeNumber, stringList } from "../files/json-object.js";
import { getOrCreate, groupBy, rankByCount } from "../collections.js";

/** How the Outcome table's results collapse for costing:
 * "landed" made progress, "no_change" spent a tick and landed nothing, and every remaining
 * result is "error-class" — it burned agent time without landing, whether the cause was a
 * hard failure or the review gate. Typed as a full Record so a result added to
 * src/tick/tick-outcome.ts and forgotten here is a compile error, like RESULT_ORDER in
 * src/failure/failure-render.ts. */
export const OUTCOME_CLASS: Record<TickResult, "landed" | "no_change" | "error"> = {
  changed: "landed",
  queued: "landed",
  no_change: "no_change",
  refused: "no_change",
  skipped: "no_change",
  rejected: "error",
  review_error: "error",
  merge_conflict: "error",
  merge_blocked: "error",
  main_red: "error",
  error: "error",
  quiet_killed: "error",
  aborted: "error",
  user_aborted: "error",
};

/** One cell of the time-and-spend table: the ticks that ended on one outcome class, their
 * summed wall-clock span (start→end) and cost. `ms` is 0 when no duration is known — an old
 * `tick_end` whose `tick_start` rotated out of the retained log — so the cell still counts
 * the tick but prices no time it cannot attest. */
export interface SpendCell {
  ticks: number;
  ms: number;
  costUsd: number;
}

/** One role's row of the time-and-spend table: a SpendCell per outcome class, present even
 * when empty so the render's columns never shift per row. */
export interface TimeSpendRow {
  role: string;
  classes: Record<"landed" | "no_change" | "error", SpendCell>;
}

/** One ranked loss cause: an error cluster — the digest's
 * own clustering, applied to the ticks that burned time — a role's total "no_change" spend,
 * the quiet loss no cluster names, or a role's total authoring spend on changes the landing
 * gate rejected (BUGS.md 2026-09-30), or a landing that failed to merge (BUGS.md 2026-10-10).
 * `example` is the newest verbatim occurrence for a cluster (the one at lastSeen, BUGS.md
 * 2026-09-30), a review-rejected cause's newest rejection reason, a refused cause's newest
 * refusal summary (the deliberate objection that blocks the entry), the shared no-text
 * placeholder for a merge failure, or "" for a no_change cause. */
export interface LossCause {
  kind: "error-cluster" | "no_change" | "review-rejected" | "merge-conflict" | "merge-blocked" | "refused";
  roles: string[]; // unique, sorted
  example: string;
  ticks: number;
  ms: number;
  costUsd: number;
}

/** A row's summed wall-clock span across its outcome classes — the sort key that puts the
 * burning role first, the way the usage report ranks its cost lines. */
function sumMs(classes: TimeSpendRow["classes"]): number {
  return classes.landed.ms + classes.no_change.ms + classes.error.ms;
}

/** The loss-cause cut, like ERROR_TOP above: the five most expensive causes by time. */
const LOSS_TOP = 5;

/** The raw results whose loss attributes to a cluster — an error, an abort, a quiet kill, or
 * a red-main skip, each carrying its own message on the tick_end (main_red's is the
 * redMainMessage the error-clusters section already itemizes, BUGS.md 2026-10-07). A queued
 * tick's landing outcomes are owned by the joins below instead: review_error through its
 * matching `review_failed` message, review-rejected through its review reasons, and
 * merge_conflict/merge_blocked by the result itself (BUGS.md 2026-10-10). (A raw
 * `user_aborted` tick_end is also error-class but is not in this set, so it stays out of the
 * ranking.) */
const CLUSTERED_RESULTS: ReadonlySet<string> = new Set(["error", "aborted", "quiet_killed", "main_red"]);

/** A loss cause while collecting; `roles` is a set until the final sort. */
interface LossDraft {
  kind: "error-cluster" | "no_change" | "review-rejected" | "merge-conflict" | "merge-blocked" | "refused";
  roles: Set<string>;
  lastSeen: number;
  example: string;
  ticks: number;
  ms: number;
  costUsd: number;
}

/** A queued tick's resolved landing outcome — the pin/outcome pair `resolveQueuedResult`
 * returns, used as the attempt window an event must fall inside to belong to it. */
type ResolvedLanding = NonNullable<ReturnType<typeof resolveQueuedResult>>;

/** The newest event for `role` inside a landing attempt's pin→outcome window — the attempt no
 * other can occupy. Shared by the review-rejected and review_error cause joins, so the two
 * agree on which event belongs to the attempt (BUGS.md 2026-10-10: the window, not the pin's
 * sha, is the match, since every vet rebases its pin before the gate). */
function newestAttemptEvent(
  eventsByLoop: Map<string, HarnessEvent[]>,
  role: string,
  attempt: ResolvedLanding,
): HarnessEvent | undefined {
  return (eventsByLoop.get(role) ?? [])
    .filter((e) => e.ts >= attempt.pin.ts && e.ts <= attempt.outcome.ts)
    .at(-1);
}

/** The time a `tick_end` attests: its own `durationMs` when it carries one (every event
 * written since 2026-09-29 does), else the start→end pairing over `starts` — the same
 * fallback history-data.ts renders, so old events read their span the one way it can still be
 * known. 0 when neither source has the start (rotation cut it); the fold prices no time it
 * cannot attest but still counts the tick. */
function tickDurationMs(ev: HarnessEvent, starts: Map<string, number>): number {
  const own = nonNegativeNumber(ev.durationMs, null);
  if (own !== null) return own;
  return tickSpanMs(ev, starts) ?? 0;
}

/** Add one tick to a {ticks, ms, costUsd} accumulator — the single home of the fold shared
 * by the time-and-spend table's outcome cells (SpendCell) and the loss-cause drafts
 * (LossDraft), so the two tallies cannot drift apart in what they count or price. The
 * caller passes one event's already-computed durationMs and usage, so folding an event
 * into both a cell and a draft parses the usage and pairs the span exactly once. */
function tally(target: { ticks: number; ms: number; costUsd: number }, durationMs: number, usage: { costUsd: number }): void {
  target.ticks++;
  target.ms += durationMs;
  target.costUsd += usage.costUsd;
}

/** Fold the window's tick_ends into the time-and-spend table and the loss ranking. Pairing
 * runs over BOTH windows' events (the caller passes the whole read), so a tick that opened
 * in the preceding day and ended in the current one still gets its span. The landing-outcome
 * join runs over that same whole read too (BUGS.md 2026-09-30): a queued tick_end resolves
 * through its own land_queued pin to the later landed/land_failed outcome for the same
 * loop+sha — history-data.ts's exact join — so an authoring tick whose landing was rejected
 * prices into the error-class cell its contract names instead of the landed cell its
 * transient queued result suggested. A landing still in the pipeline, or an outcome event
 * matching no pin, keeps the queued→landed reading: the conservative fallback. */
export function timeAndSpend(tickEvents: HarnessEvent[], allEvents: HarnessEvent[]): {
  timeSpend: TimeSpendRow[];
  lossCauses: LossCause[];
  /** How many distinct causes the LOSS_TOP slice dropped — the render's remainder marker
   * reads it, so a capped ranking never passes as a complete itemization (BUGS.md 2026-10-01). */
  lossCausesHidden: number;
} {
  const starts = tickStartMap(allEvents);
  const emptyCell = (): SpendCell => ({ ticks: 0, ms: 0, costUsd: 0 });
  const byRole = new Map<string, Record<"landed" | "no_change" | "error", SpendCell>>();
  const losses = new Map<string, LossDraft>();
  // The landing evidence rides history-data.ts's bucketLandingEvents — the same buckets
  // history's rows read — so the digest's join cannot drift from the rows' join.
  const { landQueuedByLoop, outcomeByLoop } = bucketLandingEvents(allEvents);
  const rejectedByLoop = groupBy(
    allEvents.filter((e) => e.type === "review_rejected"),
    (e) => e.loop,
  );
  // A review_error landing kept its pin but left no message on its own land_failed; the
  // matching review_failed event for the same loop+sha carries it, so the span prices under
  // the same cluster key the digest's review-failure section already counts.
  const reviewFailedByLoop = groupBy(
    allEvents.filter((e) => e.type === "review_failed"),
    (e) => e.loop,
  );
  const deadlineKilledByLoop = groupBy(
    allEvents.filter(
      (e) =>
        e.type === "build_check" &&
        e.status === "failed" &&
        (e.scope === "landing" || e.scope === "batch") &&
        typeof e.timeoutMs === "number",
    ),
    (e) => e.loop,
  );
  // Queued tick_ends resolve newest-first so each claims the newest pin at or before its end
  // that no newer tick has claimed — resolveQueuedResult's exact claim rule, shared with the
  // history rows. tickEvents is oldest-first, hence the backward walk.
  const claimTop = new Map<string, number>();
  const resolved = new Map<HarnessEvent, ResolvedLanding>();
  for (let i = tickEvents.length - 1; i >= 0; i--) {
    const ev = tickEvents[i]!;
    if (ev.result !== "queued") continue;
    const joined = resolveQueuedResult(ev, landQueuedByLoop, outcomeByLoop, claimTop, new Map(), null);
    if (joined !== null) resolved.set(ev, joined);
  }
  for (const ev of tickEvents) {
    let cls = OUTCOME_CLASS[ev.result as TickResult];
    if (cls === undefined) continue; // An unknown result is tallied in the Outcome table; costing it would need a class first.
    let resolvedOutcome: ResolvedLanding | null = null;
    if (ev.result === "queued") {
      resolvedOutcome = resolved.get(ev) ?? null;
      if (resolvedOutcome) {
        const resolvedCls = OUTCOME_CLASS[resolvedOutcome.result as TickResult];
        if (resolvedCls !== undefined) cls = resolvedCls;
      }
    }
    const role = eventRole(ev);
    const usage = eventUsage(ev);
    const durationMs = tickDurationMs(ev, starts);
    const row = getOrCreate(byRole, role, () => ({
      landed: emptyCell(),
      no_change: emptyCell(),
      error: emptyCell(),
    }));
    tally(row[cls], durationMs, usage);

    // Loss causes: a clustered failure's cluster owns its time, a no_change's role does, and
    // a landing-gate rejection prices its authoring span under a per-role cause of its own —
    // unrepresentable as an error cluster, since the land_failed event carries no message;
    // the example is the matching review_rejected's first reason, matched by landing attempt.
    let key: string | null = null;
    let kind: LossDraft["kind"] = "error-cluster";
    let example = "";
    if (ev.result === "refused") {
      // A refusal is a deliberate objection that blocks its entry, not quiet idleness — the
      // reason live in the event + lastSummary (src/verdict/refusal.ts). Rank it as its own
      // per-role cause so the digest surfaces the objection instead of pricing the tick
      // exactly like a silently idle one; the branch sits BEFORE the no_change one because a
      // refused tick is also no_change-class in the outcome table. The example rides the
      // refusal's summary the way a review-rejected cause rides its reason.
      key = `refused\u0000${role}`;
      kind = "refused";
      example = typeof ev.summary === "string" ? truncateExample(ev.summary) : "";
    } else if (cls === "no_change") {
      key = `no_change\u0000${role}`;
      kind = "no_change";
    } else if (CLUSTERED_RESULTS.has(String(ev.result))) {
      // A clustered result with no error text still owns its time: an abort's tick_end never
      // carries one (planTickStart clears s.lastError, tick-finalize logs error: undefined),
      // and a malformed error tick can lose it too, so both take the same placeholder cause the
      // error-clusters section already itemizes rather than dropping the span itemized nowhere.
      const text = errorTextOrPlaceholder(ev.error);
      key = poolTimeoutKey(normalizeClusterKey(text));
      example = truncateExample(text);
    } else if (ev.result === "queued" && resolvedOutcome?.result === "rejected") {
      key = `review-rejected\u0000${role}`;
      kind = "review-rejected";
      // Match the landing ATTEMPT, not the pin's sha: every vet rebases its pin onto main
      // before the gate (syncPinToMain), so `review_rejected.head` is the rebased commit while
      // `land_queued` keeps the authored one — exact-sha equality names no reason for a rebased
      // rejection (BUGS.md 2026-10-10). The rejection for this attempt is the one inside the
      // claimed pin and its outcome, the window no other attempt can occupy.
      const rej = newestAttemptEvent(rejectedByLoop, role, resolvedOutcome!);
      const reasons = stringList(rej?.reasons);
      example = reasons[0] !== undefined ? truncateExample(reasons[0]) : "";
    } else if (ev.result === "queued" && resolvedOutcome?.result === "review_error") {
      // The review process itself failed (a dead backend, a timeout, no parseable verdict):
      // the pin was kept and re-queued, and the matching `review_failed` event carries the
      // message the review-failure section already clusters. Price the authoring span under
      // that cluster's key — a review timeout pools into the shared `timed out after <dur>`
      // cause via poolTimeoutKey — and fall back to the shared placeholder when no event is
      // visible, so the span is itemized rather than hidden. The match keys on the landing
      // ATTEMPT, not the pin's sha: every vet rebases its pin onto main before the gate
      // (syncPinToMain), so `review_failed.head` is the rebased commit while `land_queued`
      // keeps the authored one — exact-sha equality missed every rebased vet (BUGS.md
      // 2026-10-10). The review failure for this attempt is the one that falls inside the
      // claimed pin and its outcome, the window no other attempt can occupy.
      const failed = newestAttemptEvent(reviewFailedByLoop, role, resolvedOutcome!);
      const text = errorTextOrPlaceholder(failed?.message);
      key = poolTimeoutKey(normalizeClusterKey(text));
      example = truncateExample(text);
    } else if (
      ev.result === "queued" &&
      (resolvedOutcome?.result === "merge_conflict" || resolvedOutcome?.result === "merge_blocked")
    ) {
      // The landing failed to merge (a conflict, or a blocked fast-forward/rebase): this
      // authoring span burned. The `land_failed` event carries no message — writeLandingOutcome
      // logs only result/commit/durationMs/usage — so the cause is named by its own result and
      // takes the shared no-text placeholder, the same fallback a message-less aborted tick_end
      // uses, rather than dropping a span the error-class cell already priced (BUGS.md
      // 2026-10-10).
      key = `${resolvedOutcome.result}\u0000${role}`;
      kind = resolvedOutcome.result === "merge_conflict" ? "merge-conflict" : "merge-blocked";
      example = errorTextOrPlaceholder(undefined);
      // A merge-scope check the harness killed at its own deadline is the fleet's load, not a
      // verdict on the change: split it into its own cause so the ranking names it.
      const killed = newestAttemptEvent(deadlineKilledByLoop, role, resolvedOutcome);
      if (kind === "merge-blocked" && killed) {
        key = `merge_blocked_deadline\u0000${role}`;
        example = `${String(killed.scope)} build check killed at its ${Number(killed.timeoutMs) / 1000}s deadline (the harness's own timeout, not a test failure)`;
      }
    }
    if (key === null) continue;
    let draft = losses.get(key);
    if (!draft) {
      draft = {
        kind,
        roles: new Set<string>(),
        lastSeen: ev.ts,
        example,
        ticks: 0,
        ms: 0,
        costUsd: 0,
      };
      losses.set(key, draft);
    }
    // The example rides lastSeen, like clusterMessages': the cause as it happens now, not
    // the first-seen value a config change retired (BUGS.md 2026-09-30).
    if (ev.ts >= draft.lastSeen) {
      draft.lastSeen = ev.ts;
      draft.example = example;
    }
    draft.roles.add(role);
    tally(draft, durationMs, usage);
  }
  const timeSpend: TimeSpendRow[] = rankByCount(
    [...byRole.entries()].map(([role, classes]) => ({ role, classes })),
    (row) => sumMs(row.classes),
    (row) => row.role,
  );
  const rankedLosses: LossCause[] = [...losses.values()]
    .map((d) => ({
      kind: d.kind,
      roles: sortedRoles(d.roles),
      example: d.example,
      ticks: d.ticks,
      ms: d.ms,
      costUsd: d.costUsd,
    }))
    .sort((a, b) => b.ms - a.ms || b.ticks - a.ticks || a.example.localeCompare(b.example));
  const lossCauses = rankedLosses.slice(0, LOSS_TOP);
  return { timeSpend, lossCauses, lossCausesHidden: Math.max(0, rankedLosses.length - LOSS_TOP) };
}
