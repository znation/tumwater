/** Collection half of `tumwater history <role> <n>`: one completed run's full event block,
 * distilled from the event log into a RunDetail payload. The collector-in-core convention
 * beside history-data.ts and src/report/report-data.ts — a pure read over root, so core
 * modules can serve the same payload without reaching into ui/, and the CLI
 * (`run-detail.ts`) and the GUI History drill-down (`src/gui/gui-history-endpoints.ts`) cannot
 * drift on what one run's block contains.
 * Every datum rides the events the harness already writes, so this is a distillation of the
 * existing record, not a new one. The derived shas a run's block names (runCommitSha /
 * runMergedSha) live here beside the payload they describe; the rendering half — the summary
 * header, formatEvent, the stat/patch and transcript text — lives in run-detail-render.ts,
 * and the CLI command in run-detail.ts. */
import { HISTORY_SCAN_MAX_EVENTS } from "../history/history-data.js";
import { bucketMergeEvents, resolveQueuedResult } from "../history/history-queued.js";
import { eventUsage, readEvents, runSpanMs, runStartMap } from "../events/event-read.js";
import { outcomeText, usageText } from "../events/event-format.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { loadConfigSafe, defaultConfig } from "../config/config.js";
import { seamContextWindowForRole } from "../pi/pi-models.js";
import { nonNegativeNumber } from "../files/json-object.js";
import type { HarnessEvent } from "../events/events.js";

/** One run's full event trail, as `tumwater history <role> <n>` and the GUI's run drill-down
 * serve it. `startTs`/`endTs` bound the run's block: `endTs` is null while the run is in
 * flight (no `run_end` yet) or its end was lost to log rotation, `startTs` null when rotation
 * cut the start but the end survived — either way `durationMs` is null (an unpaired run shows
 * no fabricated duration, the history row's dash rule). `result`, `tokens`, and `costUsd` come
 * from the `run_end` event (`result` null, both numbers 0 while it is in flight); `usage` is
 * the same numbers through usageText, empty when the run carries neither (the payload's
 * omit-when-zero convention, matching RunRow). `events` is the run's block oldest-first: the
 * paired `run_start`/`run_end` themselves plus every event filed under this role whose
 * timestamp falls inside the pair — the run-less in-run events (`review_verdict`,
 * `build_check`, `warning`) included, other roles' events excluded. A run that ended `queued`
 * has its merge's verdict resolved the way history rows do: `result` becomes the merge's
 * result and `merge` the `merge_done`/`merge_failed` event that carries it (not in `events`:
 * logged after the block, or — for a leftover-recovery run, whose verdict is the failed
 * attempt it re-queued — before it); `merge` is null for every other run, and for a queued
 * run whose merge is still pending or whose outcome rotated out (`result` stays `queued`). */
export interface RunDetail {
  role: string;
  run: number;
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  result: string | null;
  /** The agent-qualified selector the run's `run_start` carried — a per-role override, a
   * fallback or the primary — the same string `RunRow.model` and the report's `runsByModel`
   * use, or null when the run's start sits outside the scanned window or carried none. */
  model: string | null;
  tokens: number;
  costUsd: number;
  usage: string;
  /** The run's largest single-request context, from the `run_end`'s `peakContextTokens`
   * (runner-state.ts's peakContextTokens, written when the run reported one); 0 when the
   * run carried none or is in flight. The header renders it as `peak ctx …` (
   * run-detail-render.ts) against `contextWindow` below. */
  peakContextTokens?: number;
  /** The `run_end`'s prompt-token total (the uncached + cached input it consumed), from
   * the same field the usage report's `Prompt tokens by role` line reads; 0 when the run
   * reported none or is in flight. The header renders it as `prompt … tok` with the
   * cache-read share (run-detail-render.ts) — the input side a cost-only header hides.
   * Absent on a run that reported none, so a prompt-free or old-log run keeps today's
   * exact payload. */
  promptTokens?: number;
  /** The `run_end`'s cache-read subset of the prompt tokens (clamped to the total), from
   * the same field the failure digest's cache-read share reads; 0 when the run reported
   * none or is in flight. The header renders it as `${n}% cached` beside the prompt count
   * (run-detail-render.ts). Absent on a run that reported none. */
  cacheReadTokens?: number;
  /** The `run_end`'s prompt tokens sent before the run's first edit (clamped to
   * `promptTokens`), from the same field the failure digest prices as the run's
   * `… before first edit` share of its prompt budget; 0 when the run reported none or
   * is in flight. The header renders it as `pre-edit … tok` beside the prompt count
   * (run-detail-render.ts) — the signal that a run spent its context exploring rather
   * than working. Absent on a run that reported none, so an old-log or prompt-free run
   * keeps today's exact payload. */
  preEditPromptTokens?: number;
  /** The `run_end`'s ceiling-truncation flag: true when the run was truncated at its model's
   * context ceiling and the harness resumes its pinned session. Absent when the run did not
   * cut off (and for an in-flight run with no end), so a non-cut-off payload is unchanged. */
  cutOff?: boolean;
  /** The role's resolved primary seam's declared context window — the same seam
   * `tumwater role <id>`'s `- Context window:` line prints — or null when it cannot be
   * known (an unresolvable pair, a broken config, or a missing catalog). Optional so
   * existing payload literals keep compiling; the collector always sets it. */
  contextWindow?: number | null;
  events: HarnessEvent[];
  merge: HarnessEvent | null;
  /** The sha the run's change holds on main, from the role's `merged` event: the newest one in
   * the block for a run that merged directly, or the newest inside the merge's own window
   * (`merge_done` ts minus its `durationMs`, up to its ts) for a queued run. It differs from the
   * pinned commit when the merge rebased. Null for every other run, and when the event rotated
   * out or the merge was a no-op fast-forward (which logs none). */
  mergedSha: string | null;
  /** How long the pipeline between the run's end and its landing on main took: the landing
   * `merged` event's ts minus the run's `run_end` ts (the per-change twin of the day report's
   * `Merge wait median`, which shows only a team median). Set only when the run has both an end
   * and a landing event and the difference is non-negative; absent for every other run (a
   * rejected/failed merge, an in-flight run, a landing that rotated out, a no-op fast-forward
   * that logs no `merged` event), so the trail header stays byte-identical without it. */
  mergeAfterRunMs?: number;
  /** The revert of this run's merged change — an operator's deliberate `tumwater revert`
   * (`kind: "operator"`, from an `operator_revert` event), matched by the event's `runner`
   * (this role) and its `commit` (the run's landed or pinned sha); null when there is none.
   * The automatic main-watch revert no longer exists (Forward, never back). */
  reverted:
    | { kind: "operator"; sha: string; revert: string; failingTests: string[] }
    | null;
}

/** The commit a run pinned: the `commit` of the first `merge_queued`/`merge_done` event in its
 * block carrying a non-empty one, else null. The one rule both the header's sha and --stat use. */
export function runCommitSha(d: RunDetail): string | null {
  const queued = d.events.find(
    (e) => (e.type === "merge_queued" || e.type === "merge_done") && typeof e.commit === "string" && e.commit !== "",
  );
  return queued === undefined ? null : (queued.commit as string);
}

/** The sha a run's change merged under on main: the `merged` sha when the merge logged one, else
 * the pinned commit — a no-op fast-forward logs no `merged` event, so its pinned commit is what
 * merged. Null when the run pinned no commit. */
export function runMergedSha(d: RunDetail): string | null {
  return d.mergedSha ?? runCommitSha(d);
}

/** The event block of `role`'s run `n`, or null when the scanned window holds no such run.
 * The newest `run_start` the log retains for `${role}#${n}` wins (a counter reset can make an
 * old run number recur; the operator asking by number means the most recent one), and the
 * block closes at the first `run_end` for that run after the start — or, when that end is
 * missing (in flight, or its tail lost to rotation), at the role's next `run_start`, so a
 * rotation-cut block never leaks the following run's events into this one. When even the
 * start is gone but a matching `run_end` survives, the end-alone block still answers with
 * `startTs` null and a null duration (the unpaired rule); nothing at all in the scan is the
 * not-found case the caller renders as a not-found line. */
export function readRunDetail(root: string, role: string, runNumber: number): RunDetail | null {
  // The scan rides history-data.ts's shared one-ask ceiling (HISTORY_SCAN_MAX_EVENTS): one
  // run's block is small, but it can sit arbitrarily far back in a long-lived team's log,
  // and readTailText reads bytes proportional to the limit's line count — so the cap is also
  // the largest byte read one command can cost, and every read-only view scans under the
  // same bound.
  const all = readEvents(root, HISTORY_SCAN_MAX_EVENTS);
  const events = all.filter((e) => e.source === role);
  // Newest run_start for this role+run: the block's lower bound.
  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "run_start" && e.run === runNumber) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    // The start is gone (rotation) or the run never ran. A surviving run_end for the same
    // number still answers — unpaired, undated at the front — else there is no such run here.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "run_end" && e.run === runNumber) return detailFrom(root, role, runNumber, all, events, [e], e, null);
    }
    return null;
  }
  const start = events[startIdx]!;
  // The block's upper bound: the first run_end for this run after the start ends it; a
  // later run_start (this run's end lost to rotation) closes the block exclusive — the
  // events after it belong to the next run, not this one. No end and no next start reads as
  // in flight: everything since the start belongs to the open run.
  let end: HarnessEvent | null = null;
  let nextStart: HarnessEvent | null = null;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "run_end" && e.run === runNumber) {
      end = e;
      break;
    }
    if (e.type === "run_start") {
      nextStart = e;
      break;
    }
  }
  // The block itself: the start event plus everything this role logged up to the bound —
  // inclusive at a paired end, exclusive at a next run's start.
  const block: HarnessEvent[] = [];
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i]!;
    if (end !== null ? e.ts > end.ts : nextStart !== null && e.ts >= nextStart.ts) break;
    block.push(e);
  }
  return detailFrom(root, role, runNumber, all, events, block, end, start);
}

/** The verdict a run reports: the `run_end`'s outcome text, resolved through its merge for a
 * run that ended `queued` (its result becomes the merge's result and `merge` the merge_done/
 * merge_failed event carrying it) — the same fresh claim cursor walk the history rows use. */
function runResultOf(
  end: HarnessEvent | null,
  scoped: HarnessEvent[],
): { result: string | null; merge: HarnessEvent | null } {
  let result = end === null ? null : outcomeText(end);
  let merge: HarnessEvent | null = null;
  if (end !== null && result === "queued") {
    // A fresh claim cursor suits one run: the walk starts at the newest pin at or before this
    // run's end, which is its own pin, since later runs' pins sit after it.
    const { mergeQueuedByRunner, outcomeByRunner } = bucketMergeEvents(scoped);
    const resolved = resolveQueuedResult(end, mergeQueuedByRunner, outcomeByRunner, new Map(), runStartMap(scoped), null);
    if (resolved !== null) {
      result = resolved.result;
      merge = resolved.outcome;
    }
  }
  return { result, merge };
}

/** The token and cost totals from the run_end; both zero on an in-flight run. */
function runUsageOf(end: HarnessEvent | null): Pick<RunDetail, "tokens" | "costUsd"> {
  if (end === null) return { tokens: 0, costUsd: 0 };
  const { tokens, costUsd } = eventUsage(end);
  return { tokens, costUsd };
}

/** The run's start/end timestamps and its span: `startTs`/`endTs` null when rotation cut that
 * side, `durationMs` null whenever the pair is incomplete (no fabricated span). */
function runTimesOf(
  start: HarnessEvent | null,
  end: HarnessEvent | null,
  scoped: HarnessEvent[],
): Pick<RunDetail, "startTs" | "endTs" | "durationMs"> {
  return {
    startTs: start === null ? null : start.ts,
    endTs: end === null ? null : end.ts,
    durationMs: end === null ? null : runSpanMs(end, runStartMap(scoped)),
  };
}

/** The model the run's `run_start` named, or null when it carried none or sits outside the scan. */
function runModelOf(start: HarnessEvent | null): string | null {
  return typeof start?.model === "string" && start.model.length > 0 ? start.model : null;
}

/** The run's usage as its header line; empty when the run carries neither total. */
function runUsageTextOf(end: HarnessEvent | null): string {
  return end === null ? "" : usageText(end);
}

/** The run_end's prompt-token total and its cache-read and pre-edit subsets, corrupt-field-
 * guarded reads (nonNegativeNumber) with the subsets clamped to the total so the rendered share
 * never exceeds 100%; all three keys absent on a prompt-free or in-flight run. */
function runPromptFields(
  end: HarnessEvent | null,
): Pick<RunDetail, "promptTokens" | "cacheReadTokens" | "preEditPromptTokens"> {
  const promptTokens = end === null ? 0 : nonNegativeNumber(end.promptTokens, 0);
  const cacheReadTokens = end === null ? 0 : Math.min(nonNegativeNumber(end.cacheReadTokens, 0), promptTokens);
  const preEditPromptTokens = end === null ? 0 : Math.min(nonNegativeNumber(end.preEditPromptTokens, 0), promptTokens);
  return {
    ...(promptTokens > 0 ? { promptTokens } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(preEditPromptTokens > 0 ? { preEditPromptTokens } : {}),
  };
}

/** The run_end's ceiling-truncation flag, absent when the run did not cut off. */
function runCutOffField(end: HarnessEvent | null): Pick<RunDetail, "cutOff"> {
  return end !== null && end.cutOff === true ? { cutOff: true } : {};
}

/** The run's peak context, a corrupt-field-guarded read of the run_end; 0 when in flight. */
function runPeakContextOf(end: HarnessEvent | null): number {
  return end === null ? 0 : nonNegativeNumber(end.peakContextTokens, 0);
}

/** The end-of-run → on-main landing latency (the landing `merged` event's ts minus the run
 * end's), absent without both an end and a landing event — or a landing before the end, or a
 * negative difference. */
function runMergeLatencyField(
  end: HarnessEvent | null,
  mergedEvent: HarnessEvent | null,
): Pick<RunDetail, "mergeAfterRunMs"> {
  return end !== null && mergedEvent !== null && mergedEvent.ts - end.ts >= 0
    ? { mergeAfterRunMs: mergedEvent.ts - end.ts }
    : {};
}

/** Fill the payload around a collected block: each concern resolves in its own named helper
 * (runResultOf, runUsageOf, runTimesOf, runModelOf, runUsageTextOf, runPromptFields,
 * runCutOffField, runPeakContextOf, runMergeLatencyField), and this assembles their results.
 * Events stay oldest-first; usage/duration pair through the shared event-read helpers so this
 * view and the history rows cannot drift on what a span is. */
function detailFrom(
  root: string,
  role: string,
  runNumber: number,
  all: HarnessEvent[],
  scoped: HarnessEvent[],
  block: HarnessEvent[],
  end: HarnessEvent | null,
  start: HarnessEvent | null,
): RunDetail {
  const { result, merge } = runResultOf(end, scoped);
  const mergedEvent = mergedEventOf(result, merge, scoped, block);
  const detail: RunDetail = {
    role,
    run: runNumber,
    ...runTimesOf(start, end, scoped),
    model: runModelOf(start),
    ...runUsageOf(end),
    usage: runUsageTextOf(end),
    result,
    // The window comes from the shared seamContextWindowForRole — same seam the role view and
    // status table print — with loadConfigSafe falling back to defaults, so a broken
    // tumwater.json yields a null window rather than failing this read-only view.
    peakContextTokens: runPeakContextOf(end),
    ...runPromptFields(end),
    ...runCutOffField(end),
    contextWindow: seamContextWindowForRole(loadConfigSafe(root).config ?? defaultConfig(), role, root),
    events: block,
    merge,
    mergedSha: mergedShaOf(result, merge, scoped, block),
    ...runMergeLatencyField(end, mergedEvent),
    reverted: null,
  };
  detail.reverted = revertedOf(detail, all);
  return detail;
}

/** The revert of a run's landed change, matched from the unfiltered event list (the revert
 * events are logged under `tumwater`, not the run's role): the newest `operator_revert` whose
 * `runner` is this role (an instance run's base role — it commits `tumwater(feature): …`) and
 * whose `commit` is the run's landed (`mergedSha`) or pinned (`runCommitSha`) sha — the latter
 * catching a no-op fast-forward that logs no `merged` event. `revert` names the inverse commit
 * (empty when the source logged none) and `failingTests` the tests the revert named (empty
 * when absent); null when nothing matches. The automatic main-watch revert no longer exists. */
function revertedOf(d: RunDetail, all: readonly HarnessEvent[]): RunDetail["reverted"] {
  const targetSha = d.mergedSha ?? runCommitSha(d);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (e.type !== "operator_revert") continue;
    if (typeof e.runner !== "string" || (e.runner !== d.role && e.runner !== baseRoleOf(d.role))) continue;
    if (typeof e.commit !== "string" || e.commit !== targetSha) continue;
    return {
      kind: "operator", // vocabulary-ok: the deliberate-revert kind value names the operator role
      sha: e.commit,
      revert: typeof e.revert === "string" ? e.revert : "",
      failingTests: Array.isArray(e.failingTests) ? (e.failingTests as string[]) : [],
    };
  }
  return null;
}

/** The newest `merged` event in `pool` (oldest-first) inside [from, to], or null when none. */
function newestMergedEvent(pool: HarnessEvent[], from: number, to: number): HarnessEvent | null {
  for (let i = pool.length - 1; i >= 0; i--) {
    const e = pool[i]!;
    if (e.type === "merged" && e.ts >= from && e.ts <= to && typeof e.commit === "string" && e.commit !== "") {
      return e;
    }
  }
  return null;
}

/** The landing `merged` event for a detail, the one behind its `mergedSha` and its
 * `mergeAfterRunMs` span: the newest in the block for a run that merged directly (result
 * `changed`, no queued resolve) or the newest inside the merge's own window (`merge_done` ts
 * minus its `durationMs`, up to its ts) for a queued run; null for every other run and when
 * the event rotated out or the merge was a no-op fast-forward (which logs none). */
function mergedEventOf(
  result: string | null,
  merge: HarnessEvent | null,
  scoped: HarnessEvent[],
  block: HarnessEvent[],
): HarnessEvent | null {
  if (merge === null) {
    return result === "changed" ? newestMergedEvent(block, -Infinity, Infinity) : null;
  }
  if (merge.type !== "merge_done" || typeof merge.durationMs !== "number" || !Number.isFinite(merge.durationMs)) {
    return null;
  }
  return newestMergedEvent(scoped, merge.ts - merge.durationMs, merge.ts);
}

/** The landed sha for a detail: see RunDetail.mergedSha. */
function mergedShaOf(
  result: string | null,
  merge: HarnessEvent | null,
  scoped: HarnessEvent[],
  block: HarnessEvent[],
): string | null {
  const e = mergedEventOf(result, merge, scoped, block);
  return e === null ? null : (e.commit as string);
}
