// vocabulary: plain
/** The failure digest's time-and-spend fold: read the window's `run_end`s and price each one into
 * the per-role × outcome-class table (runs, summed wall-clock ms, cost) plus the loss-cause
 * ranking that weighs causes by agent-hours rather than run counts. Split from
 * src/failure/failure-data.ts, which owns the rest of the collection (outcome tallies, deltas,
 * clustered sections) and calls into timeAndSpend here; the Markdown rendering of both stays in
 * src/failure/failure-render.ts as a pure function of the collected data. */
import type { RunResult } from "../run/run-outcome.js";
import type { HarnessEvent } from "../events/events.js";
import { eventRole, eventUsage, runSpanMs, runStartMap } from "../events/event-read.js";
import { errorTextOrPlaceholder, normalizeClusterKey, poolTimeoutKey, sortedRoles, truncateExample } from "./failure-cluster.js";
import { resolveQueuedResult, bucketMergeEvents } from "../history/history-data.js";
import { nonNegativeNumber, stringList } from "../files/json-object.js";
import { getOrCreate, groupBy, rankByCount } from "../collections.js";

/** How the Outcome table's results collapse for costing:
 * "merged" made progress, "no_change" spent a run and merged nothing, and every remaining
 * result is "error-class" — it burned agent time without merge, whether the cause was a
 * hard failure or the review gate. Typed as a full Record so a result added to
 * src/run/run-outcome.ts and forgotten here is a compile error, like RESULT_ORDER in
 * src/failure/failure-render.ts. */
export const OUTCOME_CLASS: Record<RunResult, "merged" | "no_change" | "error"> = {
  changed: "merged",
  queued: "merged",
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

/** One cell of the time-and-spend table: the runs that ended on one outcome class, their
 * summed wall-clock span (start→end) and cost. `ms` is 0 when no duration is known — an old
 * `run_end` whose `run_start` rotated out of the retained log — so the cell still counts
 * the run but prices no time it cannot attest. */
export interface SpendCell {
  runs: number;
  ms: number;
  costUsd: number;
}

/** One role's row of the time-and-spend table: a SpendCell per outcome class, present even
 * when empty so the render's columns never shift per row. */
export interface TimeSpendRow {
  role: string;
  classes: Record<"merged" | "no_change" | "error", SpendCell>;
}

/** One ranked loss cause: an error cluster — the digest's
 * own clustering, applied to the runs that burned time — a role's total "no_change" spend,
 * the quiet loss no cluster names, or a role's total authoring spend on changes the merge
 * gate rejected (BUGS.md 2026-09-30), or a merge that failed (BUGS.md 2026-10-10).
 * `example` is the newest verbatim occurrence for a cluster (the one at lastSeen, BUGS.md
 * 2026-09-30), a review-rejected cause's newest rejection reason, a refused cause's newest
 * refusal summary (the deliberate objection that blocks the entry), the shared no-text
 * placeholder for a merge failure, or "" for a no_change cause. */
export interface LossCause {
  kind: "error-cluster" | "no_change" | "review-rejected" | "merge-conflict" | "merge-blocked" | "refused";
  roles: string[]; // unique, sorted
  example: string;
  runs: number;
  ms: number;
  costUsd: number;
}

/** A row's summed wall-clock span across its outcome classes — the sort key that puts the
 * burning role first, the way the usage report ranks its cost lines. */
function sumMs(classes: TimeSpendRow["classes"]): number {
  return classes.merged.ms + classes.no_change.ms + classes.error.ms;
}

/** The loss-cause cut, like ERROR_TOP above: the five most expensive causes by time. */
const LOSS_TOP = 5;

/** The raw results whose loss attributes to a cluster — an error, an abort, a quiet kill, or
 * a red-main skip, each carrying its own message on the run_end (main_red's is the
 * redMainMessage the error-clusters section already itemizes, BUGS.md 2026-10-07). A queued
 * run's merge outcomes are owned by the joins below instead: review_error through its
 * matching `review_failed` message, review-rejected through its review reasons, and
 * merge_conflict/merge_blocked by the result itself (BUGS.md 2026-10-10). (A raw
 * `user_aborted` run_end is also error-class but is not in this set, so it stays out of the
 * ranking.) */
const CLUSTERED_RESULTS: ReadonlySet<string> = new Set(["error", "aborted", "quiet_killed", "main_red"]);

/** A loss cause while collecting; `roles` is a set until the final sort. */
interface LossDraft {
  kind: "error-cluster" | "no_change" | "review-rejected" | "merge-conflict" | "merge-blocked" | "refused";
  roles: Set<string>;
  lastSeen: number;
  example: string;
  runs: number;
  ms: number;
  costUsd: number;
}

/** A queued run's resolved merge outcome — the pin/outcome pair `resolveQueuedResult`
 * returns, used as the attempt window an event must fall inside to belong to it. */
type ResolvedMerge = NonNullable<ReturnType<typeof resolveQueuedResult>>;

/** The newest event for `role` inside a merge attempt's pin→outcome window — the attempt no
 * other can occupy. Shared by the review-rejected and review_error cause joins, so the two
 * agree on which event belongs to the attempt (BUGS.md 2026-10-10: the window, not the pin's
 * sha, is the match, since every verification rebases its pin before the gate). */
function newestAttemptEvent(
  eventsByRunner: Map<string, HarnessEvent[]>,
  role: string,
  attempt: ResolvedMerge,
): HarnessEvent | undefined {
  return (eventsByRunner.get(role) ?? [])
    .filter((e) => e.ts >= attempt.pin.ts && e.ts <= attempt.outcome.ts)
    .at(-1);
}

/** The pooled cluster key and truncated example a failure-message source's span prices under:
 * the shared placeholder when the source carries no message, the pooled render
 * (poolTimeoutKey(normalizeClusterKey)) of the message's cluster — so a review timeout pools
 * into the same `timed out after <dur>` cause the error-cluster section counts — and the
 * truncated example the loss-rank cell shows. One copy of the placeholder/pool/truncate chain
 * so the error-cluster and review-failure causes cannot drift on it (BUGS.md 2026-10-10). */
function pooledClusterCause(source: unknown): { key: string; example: string } {
  const text = errorTextOrPlaceholder(source);
  return { key: poolTimeoutKey(normalizeClusterKey(text)), example: truncateExample(text) };
}

/** The time a `run_end` attests: its own `durationMs` when it carries one (every event
 * written since 2026-09-29 does), else the start→end pairing over `starts` — the same
 * fallback history-data.ts renders, so old events read their span the one way it can still be
 * known. 0 when neither source has the start (rotation cut it); the fold prices no time it
 * cannot attest but still counts the run. */
function runDurationMs(ev: HarnessEvent, starts: Map<string, number>): number {
  const own = nonNegativeNumber(ev.durationMs, null);
  if (own !== null) return own;
  return runSpanMs(ev, starts) ?? 0;
}

/** Add one run to a {runs, ms, costUsd} accumulator — the single home of the fold shared
 * by the time-and-spend table's outcome cells (SpendCell) and the loss-cause drafts
 * (LossDraft), so the two tallies cannot drift apart in what they count or price. The
 * caller passes one event's already-computed durationMs and usage, so folding an event
 * into both a cell and a draft parses the usage and pairs the span exactly once. */
function tally(target: { runs: number; ms: number; costUsd: number }, durationMs: number, usage: { costUsd: number }): void {
  target.runs++;
  target.ms += durationMs;
  target.costUsd += usage.costUsd;
}

/** Fold the window's run_ends into the time-and-spend table and the loss ranking. Pairing
 * runs over BOTH windows' events (the caller passes the whole read), so a run that opened
 * in the preceding day and ended in the current one still gets its span. The merge-outcome
 * join runs over that same whole read too (BUGS.md 2026-09-30): a queued run_end resolves
 * through its own merge_queued pin to the later merge_done/merge_failed outcome for the same
 * role+sha — history-data.ts's exact join — so an authoring run whose merge was rejected
 * prices into the error-class cell its contract names instead of the merged cell its
 * transient queued result suggested. A leftover-recovery run resolves to the failed attempt it
 * re-queued (the history row's rule), so its near-zero span counts under that failure — a
 * review timeout's cluster, say — rather than adding a run to the change's final
 * review-rejected cause once per re-queue. A merge still in the pipeline, or an outcome event
 * matching no pin, keeps the queued→merged reading: the conservative fallback. */
export function timeAndSpend(runEvents: HarnessEvent[], allEvents: HarnessEvent[]): {
  timeSpend: TimeSpendRow[];
  lossCauses: LossCause[];
  /** How many distinct causes the LOSS_TOP slice dropped — the render's remainder marker
   * reads it, so a capped ranking never passes as a complete itemization (BUGS.md 2026-10-01). */
  lossCausesHidden: number;
} {
  const starts = runStartMap(allEvents);
  const emptyCell = (): SpendCell => ({ runs: 0, ms: 0, costUsd: 0 });
  const byRole = new Map<string, Record<"merged" | "no_change" | "error", SpendCell>>();
  const losses = new Map<string, LossDraft>();
  // The merge evidence rides history-data.ts's bucketMergeEvents — the same buckets
  // history's rows read — so the digest's join cannot drift from the rows' join.
  const { mergeQueuedByRunner, outcomeByRunner } = bucketMergeEvents(allEvents);
  const rejectedByRunner = groupBy(
    allEvents.filter((e) => e.type === "review_rejected"),
    (e) => e.source,
  );
  // A review_error merge kept its pin but left no message on its own merge_failed; the
  // matching review_failed event for the same role+sha carries it, so the span prices under
  // the same cluster key the digest's review-failure section already counts.
  const reviewFailedByRunner = groupBy(
    allEvents.filter((e) => e.type === "review_failed"),
    (e) => e.source,
  );
  const deadlineKilledByRunner = groupBy(
    allEvents.filter(
      (e) =>
        e.type === "build_check" &&
        e.status === "failed" &&
        (e.scope === "merge" || e.scope === "batch") &&
        typeof e.timeoutMs === "number",
    ),
    (e) => e.source,
  );
  // Queued run_ends resolve newest-first so each claims the newest pin at or before its end
  // that no newer run has claimed — resolveQueuedResult's exact claim rule, shared with the
  // history rows. runEvents is oldest-first, hence the backward walk.
  const claimTop = new Map<string, number>();
  const resolved = new Map<HarnessEvent, ResolvedMerge>();
  for (let i = runEvents.length - 1; i >= 0; i--) {
    const ev = runEvents[i]!;
    if (ev.result !== "queued") continue;
    const joined = resolveQueuedResult(ev, mergeQueuedByRunner, outcomeByRunner, claimTop, new Map(), null);
    if (joined !== null) resolved.set(ev, joined);
  }
  for (const ev of runEvents) {
    let cls = OUTCOME_CLASS[ev.result as RunResult];
    if (cls === undefined) continue; // An unknown result is tallied in the Outcome table; costing it would need a class first.
    let resolvedOutcome: ResolvedMerge | null = null;
    if (ev.result === "queued") {
      resolvedOutcome = resolved.get(ev) ?? null;
      if (resolvedOutcome) {
        const resolvedCls = OUTCOME_CLASS[resolvedOutcome.result as RunResult];
        if (resolvedCls !== undefined) cls = resolvedCls;
      }
    }
    const role = eventRole(ev);
    const usage = eventUsage(ev);
    const durationMs = runDurationMs(ev, starts);
    const row = getOrCreate(byRole, role, () => ({
      merged: emptyCell(),
      no_change: emptyCell(),
      error: emptyCell(),
    }));
    tally(row[cls], durationMs, usage);

    // Loss causes: a clustered failure's cluster owns its time, a no_change's role does, and
    // a merge-gate rejection prices its authoring span under a per-role cause of its own —
    // unrepresentable as an error cluster, since the merge_failed event carries no message;
    // the example is the matching review_rejected's first reason, matched by merge attempt.
    let key: string | null = null;
    let kind: LossDraft["kind"] = "error-cluster";
    let example = "";
    if (ev.result === "refused") {
      // A refusal is a deliberate objection that blocks its entry, not quiet idleness — the
      // reason live in the event + lastSummary (src/verdict/refusal.ts). Rank it as its own
      // per-role cause so the digest surfaces the objection instead of pricing the run
      // exactly like a silently idle one; the branch sits BEFORE the no_change one because a
      // refused run is also no_change-class in the outcome table. The example rides the
      // refusal's summary the way a review-rejected cause rides its reason.
      key = `refused\u0000${role}`;
      kind = "refused";
      example = typeof ev.summary === "string" ? truncateExample(ev.summary) : "";
    } else if (cls === "no_change") {
      key = `no_change\u0000${role}`;
      kind = "no_change";
    } else if (CLUSTERED_RESULTS.has(String(ev.result))) {
      // A clustered result with no error text still owns its time: an abort's run_end never
      // carries one (planRunStart clears s.lastError, run-finalize logs error: undefined),
      // and a malformed error run can lose it too, so both take the same placeholder cause the
      // error-clusters section already itemizes rather than dropping the span itemized nowhere.
      ({ key, example } = pooledClusterCause(ev.error));
    } else if (ev.result === "queued" && resolvedOutcome?.result === "rejected") {
      key = `review-rejected\u0000${role}`;
      kind = "review-rejected";
      // Match the merge ATTEMPT, not the pin's sha: every verification rebases its pin onto main
      // before the gate (syncPinToMain), so `review_rejected.head` is the rebased commit while
      // `merge_queued` keeps the authored one — exact-sha equality names no reason for a rebased
      // rejection (BUGS.md 2026-10-10). The rejection for this attempt is the one inside the
      // claimed pin and its outcome, the window no other attempt can occupy.
      const rej = newestAttemptEvent(rejectedByRunner, role, resolvedOutcome);
      const reasons = stringList(rej?.reasons);
      example = reasons[0] !== undefined ? truncateExample(reasons[0]) : "";
    } else if (ev.result === "queued" && resolvedOutcome?.result === "review_error") {
      // The review process itself failed (a dead backend, a timeout, no parseable verdict):
      // the pin was kept and re-queued, and the matching `review_failed` event carries the
      // message the review-failure section already clusters. Price the authoring span under
      // that cluster's key — a review timeout pools into the shared `timed out after <dur>`
      // cause via poolTimeoutKey — and fall back to the shared placeholder when no event is
      // visible, so the span is itemized rather than hidden. The match keys on the merge
      // ATTEMPT, not the pin's sha: every verification rebases its pin onto main before the gate
      // (syncPinToMain), so `review_failed.head` is the rebased commit while `merge_queued`
      // keeps the authored one — exact-sha equality missed every rebased verification (BUGS.md
      // 2026-10-10). The review failure for this attempt is the one that falls inside the
      // claimed pin and its outcome, the window no other attempt can occupy.
      const failed = newestAttemptEvent(reviewFailedByRunner, role, resolvedOutcome);
      ({ key, example } = pooledClusterCause(failed?.message));
    } else if (
      ev.result === "queued" &&
      (resolvedOutcome?.result === "merge_conflict" || resolvedOutcome?.result === "merge_blocked")
    ) {
      // The merge failed to merge (a conflict, or a blocked fast-forward/rebase): this
      // authoring span burned. The `merge_failed` event carries no message — writeMergeOutcome
      // logs only result/commit/durationMs/usage — so the cause is named by its own result and
      // takes the shared no-text placeholder, the same fallback a message-less aborted run_end
      // uses, rather than dropping a span the error-class cell already priced (BUGS.md
      // 2026-10-10).
      key = `${resolvedOutcome.result}\u0000${role}`;
      kind = resolvedOutcome.result === "merge_conflict" ? "merge-conflict" : "merge-blocked";
      example = errorTextOrPlaceholder(undefined);
      // A merge-scope check the harness killed at its own deadline is the team's load, not a
      // verdict on the change: split it into its own cause so the ranking names it.
      const killed = newestAttemptEvent(deadlineKilledByRunner, role, resolvedOutcome);
      if (kind === "merge-blocked" && killed) {
        key = `merge_blocked_deadline\u0000${role}`;
        example = `${String(killed.scope)} build check killed at its ${Number(killed.timeoutMs) / 1000}s deadline (tumwater's own timeout, not a test failure)`;
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
        runs: 0,
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
      runs: d.runs,
      ms: d.ms,
      costUsd: d.costUsd,
    }))
    .sort((a, b) => b.ms - a.ms || b.runs - a.runs || a.example.localeCompare(b.example));
  const lossCauses = rankedLosses.slice(0, LOSS_TOP);
  return { timeSpend, lossCauses, lossCausesHidden: Math.max(0, rankedLosses.length - LOSS_TOP) };
}
