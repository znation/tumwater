/** The queued-row merge join: a "queued" run_end carries no result until its merge batch
 * merges or fails, so this module buckets the merge bookkeeping events per role and resolves
 * each queued run to the verdict of the merge attempt that belongs to it. Split out of
 * history-data.ts, which keeps the run-row shape and collectors; the three consumers of the
 * join (history-data.ts's runRows, failure/time-spend.ts, run/run-detail-data.ts) import it
 * from here. */
import type { HarnessEvent } from "../events/events.js";
import { textOr } from "../text/text.js";
import { groupBy } from "../collections.js";

/** The merge bookkeeping resolveQueuedResult joins over: per role, the `merge_queued` pins
 * and the `merge_done`/`merge_failed` outcomes, each list oldest-first (the scan order). Exported
 * as one helper with exactly three call sites — readRunRows' history-row join, the failure
 * digest's time-and-spend fold (time-spend.ts), and run-detail-data.ts — so the collectors
 * cannot disagree about which events feed the join or in what order they sit: a fourth
 * merge-bookkeeping event
 * type, or a changed order rule, is edited once here. Callers bucket only the events they
 * need; the digest folds its `review_rejected` reasons with its own pass.
 * Roles or cutoffs are the caller's concern: pass a role-scoped or wider-read event list and
 * the maps carry exactly that list's evidence. */
export function bucketMergeEvents(events: HarnessEvent[]): {
  mergeQueuedByRunner: Map<string, HarnessEvent[]>;
  outcomeByRunner: Map<string, HarnessEvent[]>;
} {
  const mergeQueuedByRunner = groupBy(
    events.filter((e) => e.type === "merge_queued"),
    (e) => e.source,
  );
  const outcomeByRunner = groupBy(
    events.filter((e) => e.type === "merge_done" || e.type === "merge_failed"),
    (e) => e.source,
  );
  return { mergeQueuedByRunner, outcomeByRunner };
}

/** Resolve one queued run row's eventual merge verdict: a "queued" run_end carries no
 * result until its merge batch merges or fails, so the row joins its `end` run_end to the
 * run's merge_queued pin and that pin's merge_done/merge_failed outcome (both from the
 * bucketMergeEvents maps, oldest-first per role). The claim cursor `claimTop` (mutated in
 * place) walks the pin list newest-first and hands each queued run the newest unclaimed pin
 * at or before its end, so several queued runs cannot claim one pin.
 *
 * One change can take several merge attempts: a retriable result (RETRIABLE_MERGE_RESULTS:
 * review_error, merge_conflict, merge_blocked) keeps the pin, and the role's next run — a
 * leftover-recovery run that does no work of its own and ends in about a second — re-enqueues
 * it (isRecoveryPin). The authoring run and the recovery runs resolve by different rules, so
 * every attempt's verdict shows on exactly one row:
 * - The run that authored the change (its pin is not a re-enqueue of a kept attempt) takes
 *   the change's FINAL verdict, not its first attempt's: a retriable failure that recovery
 *   later merges reads "changed" (BUGS.md 2026-10-10). While a re-enqueued attempt is still
 *   pending the row keeps the raw "queued" label — the change is waiting to merge again, and
 *   the failure before it already shows on the recovery run's row.
 * - A recovery run takes the verdict of the attempt it re-enqueued — the retriable failure
 *   that kept the pin and made the run happen (recoveredAttemptVerdict). So a change that
 *   timed out in review seven times and was then rejected reads "rejected" once (the
 *   authoring row) and "review failed" seven times (the authoring attempt's and six
 *   recoveries' timeouts, each on the recovery row that followed it), not "rejected" on all
 *   eight rows.
 * When main moved before a retry the verification's syncPinToMain rebased the ref
 * (merge-core.ts), so the recovery pin carries the rebased sha while each attempt's own
 * merge_done/merge_failed logs its entry's sha (merge-slot.ts's entry.sha): the attempts' shas
 * differ, so the authoring row's walk follows the pin sequence (isRecoveryPin), not sha
 * equality alone. It stops at a pin that is not a recovery re-enqueue — a fresh change after a
 * conflict-cap discard — so the row never credits a different change's verdict (BUGS.md
 * 2026-10-10). A recovery pin whose previous attempt shows no retriable verdict (a crash
 * left the commit unpinned or the merge unfinished, or that attempt sits outside the read) is
 * the change's first visible attempt, so its row takes the authoring rule.
 *
 * `joinStarts` maps role#run to its run_start's ts; when `floorTs` (a since-window's cutoff,
 * null in the count view) sits after that start, the row's join evidence is not whole in the
 * windowed read and the row keeps its raw "queued" label (null). A MISSING start needs no
 * guard — it joins, because rotation drops a prefix, so every pin older than the lost start is
 * lost with it and nothing can be mis-claimed (and a skipped run has no start at all but is
 * never queued). A merge with no outcome event in the join set also keeps the raw label: the
 * conservative fallback for a verdict simply not visible here. Returns the verdict's result
 * text plus the pin and outcome of the attempt that produced it (and that pin's sha), or null
 * to keep the raw label. Pure apart from the cursor it owns. */
export function resolveQueuedResult(
  end: HarnessEvent,
  mergeQueuedByRunner: Map<string, HarnessEvent[]>,
  outcomeByRunner: Map<string, HarnessEvent[]>,
  claimTop: Map<string, number>,
  joinStarts: Map<string, number>,
  floorTs: number | null,
): QueuedVerdict | null {
  if (floorTs !== null) {
    const startTs = joinStarts.get(`${end.source}#${end.run}`);
    if (startTs !== undefined && startTs < floorTs) return null;
  }
  const queuedList = mergeQueuedByRunner.get(end.source);
  if (!queuedList || queuedList.length === 0) return null;
  let top = claimTop.get(end.source) ?? queuedList.length - 1;
  while (top >= 0 && queuedList[top]!.ts > end.ts) top--;
  if (top < 0) return null;
  claimTop.set(end.source, top - 1);
  const outcomes = outcomeByRunner.get(end.source) ?? [];
  // A recovery run's row: the attempt it re-enqueued, not the change's final verdict, so the
  // final verdict shows once (on the authoring row) and each retriable failure once (here).
  const recovered = recoveredAttemptVerdict(queuedList, top, outcomes);
  if (recovered !== null) return recovered;
  // The authoring row: walk forward while the next pin is a recovery re-enqueue and resolve to
  // the last attempt's verdict. `findLast` picks the newest same-sha outcome so an un-rebased
  // retry (recovery re-enqueues the identical sha, logged by both pins) does not re-match the
  // first attempt's outcome inside the recovery pin's walk. The returned pin/outcome ride the
  // result so a caller correlating sibling evidence (the failure digest's review-failure
  // message) can key on THIS attempt's position, not a sha a pre-review rebase may have moved
  // (BUGS.md 2026-10-10).
  let idx = top;
  let resolved: QueuedVerdict | null = null;
  for (;;) {
    const pin = queuedList[idx]!;
    const outcome = outcomes.findLast(
      (o) => o.ts >= pin.ts && textOr(o.commit, "") === textOr(pin.commit, ""),
    );
    // No outcome on the run's own pin, or on a recovery pin the walk reached: that attempt is
    // still pending, so the change is waiting to merge — keep the raw label. The previous
    // attempt's retriable verdict already shows on the recovery run's row.
    if (!outcome) return null;
    const verdict = attemptVerdict(pin, outcome);
    if (verdict === null) return resolved;
    // A merge or a rejection ends the change (the pin is discarded, so no recovery pin can
    // follow); any other verdict kept the pin, and the walk continues only if the next pin is
    // the recovery re-enqueue that kept it. Otherwise this attempt's verdict is the final one
    // visible.
    if (endsChange(verdict.result) || !isRecoveryPin(queuedList[idx + 1])) return verdict;
    resolved = verdict;
    idx += 1;
  }
}

/** One merge attempt's verdict as resolveQueuedResult returns it: the result text, the
 * attempt's pin and its sha, and the merge_done/merge_failed outcome that carried the result. */
interface QueuedVerdict {
  result: string;
  sha: string;
  pin: HarnessEvent;
  outcome: HarnessEvent;
}

/** The verdict one attempt's outcome carries, or null for a torn outcome with no result (a
 * merge_failed whose result is missing or not text). A merge_done with no result is a merge. */
function attemptVerdict(pin: HarnessEvent, outcome: HarnessEvent): QueuedVerdict | null {
  const result = textOr(outcome.result, outcome.type === "merge_done" ? "changed" : "");
  return result ? { result, sha: textOr(pin.commit, ""), pin, outcome } : null;
}

/** True when a verdict ends its change: a merge or a rejection discards the pin, so no recovery
 * re-enqueue can follow it. Every other verdict (the retriable ones) kept the pin. The one rule
 * both directions of resolveQueuedResult's chain read — the authoring row's walk forward and a
 * recovery row's step back — so the two cannot disagree on where a change ends. */
function endsChange(result: string): boolean {
  return result === "changed" || result === "rejected";
}

/** A recovery run's own row verdict: when the pin at `idx` is a recovery re-enqueue and the
 * previous pin's attempt ended in a retriable verdict (the kept pin this run re-enqueued), that
 * verdict, carrying the previous attempt's pin and outcome. The outcome is the newest one for
 * the previous pin's sha logged between the two pins: recovery runs only after the previous
 * attempt's outcome is written, and bounding at this pin keeps an un-rebased retry (both pins
 * share a sha) from matching a LATER attempt's outcome. Null when the pin is not a recovery
 * re-enqueue, or is one with no retriable attempt visible before it — a crash's unpinned or
 * unfinished commit, or a previous pin outside the read — so the row takes the authoring rule. */
function recoveredAttemptVerdict(queuedList: HarnessEvent[], idx: number, outcomes: HarnessEvent[]): QueuedVerdict | null {
  const pin = queuedList[idx]!;
  const prev = queuedList[idx - 1];
  if (prev === undefined || !isRecoveryPin(pin)) return null;
  const outcome = outcomes.findLast(
    (o) => o.ts >= prev.ts && o.ts <= pin.ts && textOr(o.commit, "") === textOr(prev.commit, ""),
  );
  const verdict = outcome === undefined ? null : attemptVerdict(prev, outcome);
  return verdict === null || endsChange(verdict.result) ? null : verdict;
}

/** True when a pin re-enqueues the previous attempt's kept pin rather than starting a fresh
 * change. `recoverLeftover` (src/runner/leftover.ts) is the one `merge_queued` producer whose
 * summary starts with this label, so a fresh change's pin after a conflict-cap discard ends
 * `resolveQueuedResult`'s walk. */
function isRecoveryPin(pin: HarnessEvent | undefined): boolean {
  return pin !== undefined && textOr(pin.summary, "").startsWith("recovered leftover work from ");
}
