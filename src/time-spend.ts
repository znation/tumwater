/** The failure digest's time-and-spend fold: read the window's `tick_end`s and price each
 * one into the per-role × outcome-class table (ticks, summed wall-clock ms, cost) plus the
 * loss-cause ranking that weighs causes by agent-hours rather than tick counts. Split from
 * src/failure/failure-data.ts, which owns the rest of the collection (outcome tallies, deltas, clustered
 * sections) and calls into timeAndSpend here; the Markdown rendering of both stays in
 * src/failure/failure-render.ts as a pure function of the collected data. */
import type { TickResult } from "./tick/tick-outcome.js";
import type { HarnessEvent } from "./events/events.js";
import { eventRole, eventUsage, tickSpanMs, tickStartMap } from "./events/event-read.js";
import { normalizeClusterKey, poolTimeoutKey, sortedRoles, truncateExample } from "./failure/failure-cluster.js";
import { rankByCount } from "./rank.js";
import { resolveQueuedResult, bucketLandingEvents } from "./history/history-data.js";
import { stringList } from "./json-object.js";

/** How the Outcome table's results collapse for costing (PLANS.md, time-and-spend plan):
 * "landed" made progress, "no_change" spent a tick and landed nothing, and every remaining
 * result is "error-class" — it burned agent time without landing, whether the cause was a
 * hard failure or the review gate. Typed as a full Record so a result added to
 * src/tick/tick-outcome.ts and forgotten here is a compile error, like RESULT_ORDER in
 * src/failure/failure-render.ts. */
const OUTCOME_CLASS: Record<TickResult, "landed" | "no_change" | "error"> = {
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

/** One ranked loss cause (PLANS.md, time-and-spend plan): an error cluster — the digest's
 * own clustering, applied to the ticks that burned time — a role's total "no_change" spend,
 * the quiet loss no cluster names, or a role's total authoring spend on changes the landing
 * gate rejected (BUGS.md 2026-09-30). `example` is the newest verbatim occurrence for a
 * cluster (the one at lastSeen, BUGS.md 2026-09-30) or a review-rejected cause's newest
 * rejection reason, "" for a no_change cause. */
export interface LossCause {
  kind: "error-cluster" | "no_change" | "review-rejected";
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

/** The results whose loss attributes to a cluster — exactly the results the plan names:
 * an error, an abort, or a quiet kill. Other error-class results (review_error,
 * merge_conflict, …) price into the table's error-class column but have no message the
 * clustering can own, so they stay out of the loss ranking rather than impersonating one. */
const CLUSTERED_RESULTS: ReadonlySet<string> = new Set(["error", "aborted", "quiet_killed"]);

/** A loss cause while collecting; `roles` is a set until the final sort. */
interface LossDraft {
  kind: "error-cluster" | "no_change" | "review-rejected";
  roles: Set<string>;
  lastSeen: number;
  example: string;
  ticks: number;
  ms: number;
  costUsd: number;
}

/** The time a `tick_end` attests: its own `durationMs` when it carries one (every event
 * written since 2026-09-29 does), else the start→end pairing over `starts` — the same
 * fallback history-data.ts renders, so old events read their span the one way it can still be
 * known. 0 when neither source has the start (rotation cut it); the fold prices no time it
 * cannot attest but still counts the tick. */
function tickDurationMs(ev: HarnessEvent, starts: Map<string, number>): number {
  const own = typeof ev.durationMs === "number" && Number.isFinite(ev.durationMs) && ev.durationMs >= 0
    ? ev.durationMs
    : null;
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
  const perLoop = (map: Map<string, HarnessEvent[]>, e: HarnessEvent): void => {
    const list = map.get(e.loop) ?? [];
    list.push(e);
    map.set(e.loop, list);
  };
  // The landing evidence rides history-data.ts's bucketLandingEvents — the same buckets
  // history's rows read — so the digest's join cannot drift from the rows' join.
  const { landQueuedByLoop, outcomeByLoop } = bucketLandingEvents(allEvents);
  const rejectedByLoop = new Map<string, HarnessEvent[]>();
  for (const e of allEvents) {
    if (e.type === "review_rejected") perLoop(rejectedByLoop, e);
  }
  // Queued tick_ends resolve newest-first so each claims the newest pin at or before its end
  // that no newer tick has claimed — resolveQueuedResult's exact claim rule, shared with the
  // history rows. tickEvents is oldest-first, hence the backward walk.
  const claimTop = new Map<string, number>();
  const resolved = new Map<HarnessEvent, { result: string; sha: string }>();
  for (let i = tickEvents.length - 1; i >= 0; i--) {
    const ev = tickEvents[i]!;
    if (ev.result !== "queued") continue;
    const joined = resolveQueuedResult(ev, landQueuedByLoop, outcomeByLoop, claimTop, new Map(), null);
    if (joined !== null) resolved.set(ev, joined);
  }
  for (const ev of tickEvents) {
    let cls = OUTCOME_CLASS[ev.result as TickResult];
    if (cls === undefined) continue; // An unknown result is tallied in the Outcome table; costing it would need a class first.
    let resolvedOutcome: { result: string; sha: string } | null = null;
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
    const row = byRole.get(role) ?? { landed: emptyCell(), no_change: emptyCell(), error: emptyCell() };
    byRole.set(role, row);
    tally(row[cls], durationMs, usage);

    // Loss causes: a clustered failure's cluster owns its time, a no_change's role does, and
    // a landing-gate rejection prices its authoring span under a per-role cause of its own —
    // unrepresentable as an error cluster, since the land_failed event carries no message;
    // the example is the matching review_rejected's first reason, the same change by sha.
    let key: string | null = null;
    let kind: LossDraft["kind"] = "error-cluster";
    let example = "";
    if (cls === "no_change") {
      key = `no_change\u0000${role}`;
      kind = "no_change";
    } else if (CLUSTERED_RESULTS.has(String(ev.result)) && typeof ev.error === "string" && ev.error !== "") {
      key = poolTimeoutKey(normalizeClusterKey(ev.error));
      example = truncateExample(ev.error);
    } else if (ev.result === "queued" && resolvedOutcome?.result === "rejected") {
      key = `review-rejected\u0000${role}`;
      kind = "review-rejected";
      const rej = (rejectedByLoop.get(role) ?? [])
        .filter((r) => String(r.head ?? "") === resolvedOutcome!.sha)
        .at(-1);
      const reasons = stringList(rej?.reasons);
      example = reasons[0] !== undefined ? truncateExample(reasons[0]) : "";
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
