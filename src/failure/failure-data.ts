/** Collection half of the failure digest: read the harness's event log over a 2×-day window
 * and distill it into a `FailureReportData` — outcome tallies, window deltas, clustered
 * failure messages, merged commits, and the harness's own state transitions, each bounded at
 * collection time. The Markdown rendering of this data lives in failure-render.ts, a pure
 * function of it; the split keeps "what happened" (clustering rules, window math, bounds)
 * apart from "how it prints" (column layout, cell wording), which change for different
 * reasons. The cluster-key rules themselves — normalization, timeout pooling, grouping — live
 * in failure-cluster.ts, shared with the error-storm reducer. The time-and-spend fold —
 * the per-role × outcome-class pricing and the loss ranking — lives in time-spend.ts.
 */
import type { RunResult } from "../run/run-outcome.js";
import { assertReportSinceMs, eventWindowCovers, readWindowEvents, sinceWindowTiming, type EventLogState } from "../events/event-window.js";
import { eventDayKey, eventRole } from "../events/event-read.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { scopeBases } from "../report/report-fold.js";
import { timeAndSpend, type LossCause, type TimeSpendRow } from "./time-spend.js";
import type { HarnessEvent } from "../events/events.js";
import { dayAt, dayKey, dayWindow, formatDate } from "../text/datetime.js";
import { describeStateChange, STATE_CHANGE_TOP, STATE_CHANGE_TYPES } from "./failure-state-change.js";
import { clusterMessages, errorTextOrPlaceholder, truncateExample, type Cluster } from "./failure-cluster.js";
import { addTo, getOrCreate, memoSetLru, rankByCount } from "../collections.js";
import { firstReason } from "../text/phrases.js";
import { sameStatIdentity, statIdentityOrZero, statOrNull } from "../files/files.js";
import { nonNegativeNumber } from "../files/json-object.js";
import { eventsLogPath } from "../paths.js";

/** Caps that keep the digest bounded regardless of how bad the window was — the top-N
 * clusters, one trimmed example each, and the newest N merged commits. See the render-doc
 * byte bound below for what these buy. */
const ERROR_TOP = 7;
const WARNING_TOP = 7;

/** Warnings that name a failing check or a stalled tool call. Each is a once-per-window
 * singleton, so ranking by count alone lets recurring housekeeping lines push it out of the
 * digest; these rank first. */
const URGENT_WARNING = /^(?:landing check red|merge check failed|tool call stalled)/;

/** The pre-07b2664a wording of the merge-check warning, pooled under the current one so a
 * window spanning the reword counts one cause, not two. */
const OLD_MERGE_CHECK_WORDING = /^landing check red \(kept for one re-land\)/;
const REVIEW_FAILURE_TOP = 5;
const REJECTION_TOP = 5;
/** Blocked merges are rare and each one is a signal, so the section gets its own cut, roomier
 * than the other cluster sections'; the digest stays bounded and the render marks any clusters
 * the cut hides. */
const MERGE_FAILURE_TOP = 10;

/** The cause text for a blocked or conflicted merge whose role logged no warning since its
 * previous merge outcome — a block with no stated reason is a signal in itself, so it clusters
 * on its own instead of hiding. */
const NO_MERGE_REASON = "no reason recorded";
const MERGED_TOP = 10;
const SUMMARY_MAX = 100;

/** One clustered section of the digest: the top-N clusters it itemizes, plus what the cut
 * hides — `total` counts every event the section owns in the current window (for rejections,
 * every `review_rejected`, matching the Deltas column even when an event carries no reasons),
 * and `hiddenClusters` is how many distinct clusters the top-N slice dropped. The render uses
 * both to print a remainder line, so a capped section says so instead of reading as a full
 * itemization (BUGS.md 2026-09-22). */
export interface ClusterSection {
  clusters: Cluster[];
  total: number;
  hiddenClusters: number;
}

/** One `run_end` result tally, per role. */
export interface OutcomeRow {
  role: string;
  counts: Partial<Record<RunResult, number>>;
}

/** One role's prompt-token telemetry over the window:
 * the median prompt tokens a run sent, and the share of those sent before the run's first
 * edit. Built only from run_end events that carry `promptTokens`; a log written before the
 * field existed yields no rows, so old digests render unchanged. */
interface PromptStatRow {
  role: string;
  runs: number; // run_end events with a promptTokens reading
  medianPromptTokens: number;
  preEditShare: number; // sum(preEditPromptTokens) / sum(promptTokens), in [0, 1]
  cacheReadShare?: number; // sum(cacheReadTokens) / sum(promptTokens), in [0, 1]; absent when no run in the role reported a cache read
}

/** One role's current-vs-preceding-window metrics. A zero side means the role had no runs
 * there ("new" for a role absent from the preceding window). */
interface DeltaRow {
  role: string;
  prevRuns: number;
  runs: number;
  prevErrors: number;
  errors: number;
  prevQuietKills: number;
  quietKills: number;
  prevRejections: number;
  rejections: number;
}

/** A commit that merged (a `merged` event) inside the window. */
interface MergedCommit {
  ts: number;
  commit: string;
  summary: string;
}

/** One harness decision (a transition event) in the window, pre-described for the digest's
 * Team state changes section. */
interface StateChange {
  ts: number;
  role: string;
  description: string;
}

/** The digest's collected evidence — a pure function of the event log plus a clock; the
 * render step below is a pure function of this. */
export interface FailureReportData {
  role?: string; // the scoped base roles, comma-joined; set by the role-scoped collector; absent on the team digest
  days: number;
  from: string; // current window start, local day key
  to: string; // today
  sinceMs?: number; // trailing-window length; set only by collectFailureReportSince
  fromIso?: string; // cutoff instant as ISO; set only by collectFailureReportSince
  untilMs?: number; // the --until bound; absent when the window ends now
  toIso?: string; // window end as ISO; set only with untilMs
  runs: number; // run_end events in the current window
  hasEvents: boolean; // any event in either window (a day-key read can reach past them)
  emptyLog: boolean; // the retained log holds no parseable events reaching the window
  logState: EventLogState; // the read outcome: "ok" (parseable events), "empty", or "unreadable"
  partial: boolean; // the read window (both halves) starts before the retained log does
  oldestEventDate: string | null; // when partial/empty: the oldest retained event's local date
  outcomes: OutcomeRow[];
  deltas: DeltaRow[];
  timeSpend: TimeSpendRow[]; // per role × outcome class: runs, summed wall-clock ms, cost
  lossCauses: LossCause[]; // top LOSS_TOP causes by time: error clusters, no_change, context cut-off, review-rejected and merge-conflict/merge-blocked authoring
  lossCausesHidden: number; // distinct causes the LOSS_TOP cut dropped — the render marks the cut
  promptStats: PromptStatRow[]; // per-role prompt-token medians, empty when no run_end carries them
  errors: ClusterSection;
  warnings: ClusterSection;
  reviewFailures: ClusterSection;
  rejections: ClusterSection;
  postMergeRejections: number; // the window's `review_rejected` events with `afterMerge: true`, counted before any cluster filter, so it equals the subset `tumwater report`'s `postMergeRejectionsByRole` sums
  mergeFailures: ClusterSection; // blocked or conflicted merge_failed clusters (top MERGE_FAILURE_TOP), by result and role, with the role's nearest preceding warning as the reason
  merged: MergedCommit[];
  mergedTotal: number; // all merges in the window, before the newest-MERGED_TOP cut
  stateChanges: StateChange[];
  stateChangesTotal: number; // all transitions in the window, before the newest-N cut
}

/** Keep only events that belong to the scoped base roles, so a scoped digest aggregates instances
 * (`feature-2`) into their group exactly as `report --role` and the per-role cap do. Role
 * events match on their own role id; the role-scoped harness transitions (a role pause, its
 * streak breaker, its cap, its fallback) log with source "harness" and name the affected role
 * in `role`, so those match on that field too — otherwise a scoped digest would drop exactly
 * the events that explain why the role stopped. Applied to both partitions and the whole read,
 * so every section derived from them narrows. */
function scopeToRole(events: HarnessEvent[], bases: readonly string[]): HarnessEvent[] {
  return events.filter(
    (ev) =>
      bases.includes(baseRoleOf(eventRole(ev))) ||
      (STATE_CHANGE_TYPES.has(ev.type) &&
        typeof ev.role === "string" &&
        bases.includes(baseRoleOf(ev.role))),
  );
}

/** Attach a section's window total (events the section owns, counted before any filter the
 * clustering applies — for rejections, the reasons-less ones too) to the clustered result. */
function section(
  clustered: { clusters: Cluster[]; hiddenClusters: number },
  total: number,
): ClusterSection {
  return { ...clustered, total };
}

/** Cluster one type's message-bearing events on (role, message), as a section whose total
 * counts the selected events. The one home of the filter-then-cluster shape the warnings and
 * review-failure sections share, and of the guard that skips an event whose `message` is
 * missing, non-string, or empty instead of crashing the digest on a torn line. The errors
 * section does not render through it — its text lives on `error`, not `message`, with a
 * fallback phrase — and rejections key on reasons[0] and prefix their cluster keys, so both
 * keep their own blocks. */
function messageSection(
  events: HarnessEvent[],
  type: HarnessEvent["type"],
  top: number,
  urgent?: (message: string) => boolean,
): ClusterSection {
  const selected = events.filter(
    (ev) => ev.type === type && typeof ev.message === "string" && ev.message !== "",
  );
  return section(
    clusterMessages(
      selected.map((ev) => ({ message: ev.message as string, role: eventRole(ev), ts: ev.ts })),
      top,
      urgent,
    ),
    selected.length,
  );
}

/** The merge-failure section: each blocked or conflicted `merge_failed` clusters on
 * (role, result, reason).
 * A `merge_failed` with a `reason` field uses it; an older one carries none, so the reason is
 * the same role's nearest preceding `warning` (a red merge check, a structure or fix-claim
 * block) logged after that role's previous merge outcome; with none, the placeholder. The
 * total counts every blocked or conflicted `merge_failed` in the window. */
function mergeFailureSection(events: HarnessEvent[]): ClusterSection {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const lastWarning = new Map<string, string>();
  const messages: Array<{ message: string; role: string; ts: number; keyPrefix: string }> = [];
  let total = 0;
  for (const ev of ordered) {
    const role = eventRole(ev);
    if (ev.type === "warning" && typeof ev.message === "string" && ev.message !== "") {
      lastWarning.set(role, ev.message.replace(OLD_MERGE_CHECK_WORDING, "merge check failed (kept for one retry)"));
    } else if (ev.type === "merge_done") {
      lastWarning.delete(role);
    } else if (ev.type === "merge_failed") {
      const result = typeof ev.result === "string" ? ev.result : "";
      // Rejected and review_error merges have their own sections; only a block or a conflict
      // is unaccounted for here.
      if (result !== "merge_blocked" && result !== "merge_conflict") {
        lastWarning.delete(role);
        continue;
      }
      total++;
      const own = typeof ev.reason === "string" ? ev.reason.trim() : "";
      const reason = own !== "" ? own : (lastWarning.get(role) ?? NO_MERGE_REASON);
      lastWarning.delete(role);
      messages.push({ message: `${result} — ${reason}`, role, ts: ev.ts, keyPrefix: `${role}\u0000` });
    }
  }
  return section(clusterMessages(messages, MERGE_FAILURE_TOP), total);
}

/** One role's window metrics, used for the delta row: runs/errors/quiet kills from
 * `run_end`, rejections from `review_rejected` (the merge slot logs it after the run). */
interface RoleStats {
  runs: number;
  errors: number;
  quietKills: number;
  rejections: number;
}

function roleStats(events: HarnessEvent[]): Map<string, RoleStats> {
  const byRole = new Map<string, RoleStats>();
  const statsFor = (role: string): RoleStats =>
    getOrCreate(byRole, role, () => ({ runs: 0, errors: 0, quietKills: 0, rejections: 0 }));
  for (const ev of events) {
    // Runs are run_end events; a rejection is now recorded by the merge slot, AFTER the
    // authoring run has already ended `queued` (plans/merge-queue.md 3/5). review_rejected is
    // the one event every reject path logs exactly once (src/review/review.ts), so it — not a
    // run_end result no production path emits — is the rejection source.
    if (ev.type === "run_end") {
      const stats = statsFor(eventRole(ev));
      stats.runs++;
      if (ev.result === "error") stats.errors++;
      else if (ev.result === "quiet_killed") stats.quietKills++;
    } else if (ev.type === "review_rejected") {
      statsFor(eventRole(ev)).rejections++;
    }
  }
  return byRole;
}

/** The live event log's identity at the moment a digest was folded. An append, truncation, or
 * rotation changes at least one field; `dev`/`ino` catch a replaced file whose size matches. */
interface FailureDigestStat {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** One memoized digest plus the window and log identity it was folded from. */
interface FailureDigestEntry {
  from: string;
  to: string;
  priorFrom: string;
  stat: FailureDigestStat;
  data: FailureReportData;
}

/** Bounded memo of whole failure digests, keyed by root and day count. The dashboard's Failures
 * tab, the TUI's Ctrl+T pane, and every selfcheck run re-request the same digest, and the
 * collector re-reads and re-parses up to 2× the window's log bytes each time (~4 MB on this
 * repo's own log, growing toward the rotation cap). An unchanged log and window cost one stat
 * and return the prior result; any change — an append, a rotation, or a new local day —
 * re-derives exactly as uncached. Mirrors report-fold.ts's foldWindowEvents, which already
 * spares the usage report the same re-read. */
const failureDigestCache = new Map<string, FailureDigestEntry>();
const FAILURE_DIGEST_CACHE_MAX = 8;

/** The live log's identity, all zero when the file is missing (the empty-log case). */
function digestStat(root: string): FailureDigestStat {
  return statIdentityOrZero(statOrNull(eventsLogPath(root)));
}

/** Collect the digest over the last `days` local calendar days, reading a 2×-long window once
 * and partitioning it in memory so the delta against the preceding equal window costs no
 * second tail read. Memoized (failureDigestCache): a repeat request whose window and log are
 * unchanged returns the prior digest instead of re-reading and re-folding the same bytes. */
export function collectFailureReport(root: string, days: number, role?: string | readonly string[]): FailureReportData {
  const now = new Date();
  const { from, to } = dayWindow(days, now);
  const priorFrom = formatDate(dayAt(days * 2 - 1, now));
  const bases = scopeBases(role);
  // The base role rides the key, so a scoped and a team digest of the same log cannot
  // collide in the memo.
  const key = `${root}\u0000${days}\u0000${bases?.join(",") ?? ""}`;
  const stat = digestStat(root);
  const cached = failureDigestCache.get(key);
  if (
    cached?.from === from &&
    cached.to === to &&
    cached.priorFrom === priorFrom &&
    sameStatIdentity(cached.stat, stat)
  ) {
    memoSetLru(failureDigestCache, key, cached, FAILURE_DIGEST_CACHE_MAX);
    return cached.data;
  }

  const { events, coversFullWindow, logState } = readWindowEvents(root, priorFrom);
  const current: HarnessEvent[] = [];
  const prior: HarnessEvent[] = [];
  for (const ev of events) {
    const day = eventDayKey(ev);
    if (day === null) continue; // Unreachable: the reader filters on ts.
    if (day >= from && day <= to) current.push(ev);
    else if (day >= priorFrom) prior.push(ev);
  }

  const data = assembleFailureReport(current, prior, events, coversFullWindow, logState, { days, from, to }, role);
  memoSetLru(failureDigestCache, key, { from, to, priorFrom, stat, data }, FAILURE_DIGEST_CACHE_MAX);
  return data;
}

/** Collect the digest over the trailing `sinceMs` window ending now, partitioning the read into
 * the window and the equal-length window immediately before it (the same current/prior split
 * the day collector builds, so the Deltas table compares like with like). The read starts at the
 * prior half's own day key, exactly as the day collector reads 2× its window; the cutoff instant
 * for coverage is the prior half's start, which a day key alone cannot prove. With `untilMs` the
 * window is the bounded `[now - sinceMs, now - untilMs)`; the prior window then has that
 * window's own length, `sinceMs - untilMs`. */
export function collectFailureReportSince(
  root: string,
  sinceMs: number,
  role?: string | readonly string[],
  untilMs?: number,
): FailureReportData {
  assertReportSinceMs(sinceMs);
  const { now, cutoff, end, slice } = sinceWindowTiming(sinceMs, untilMs);
  const length = sinceMs - (untilMs ?? 0);
  const priorFrom = cutoff - length;
  const raw = readWindowEvents(root, dayKey(priorFrom));
  const current: HarnessEvent[] = [];
  const prior: HarnessEvent[] = [];
  for (const ev of raw.events) {
    if (typeof ev.ts !== "number") continue;
    if (ev.ts >= cutoff && (untilMs === undefined ? ev.ts <= now : ev.ts < end)) current.push(ev);
    else if (ev.ts >= priorFrom && ev.ts < cutoff) prior.push(ev);
  }
  return assembleFailureReport(current, prior, raw.events, eventWindowCovers(raw, priorFrom), raw.logState, {
    days: Math.ceil(length / 86_400_000),
    from: dayKey(cutoff),
    to: dayKey(end),
    ...slice,
  }, role);
}

/** Assemble the digest's sections from the two event partitions, the full read, and the
 * coverage proof. One body shared by the day collector above and the trailing-window collector:
 * both shapes print the same sections and differ only in their labels, so the fold must not
 * exist twice. `window` carries the labels the render branches on. */
function assembleFailureReport(
  currentRaw: HarnessEvent[],
  priorRaw: HarnessEvent[],
  allEventsRaw: HarnessEvent[],
  coversFullWindow: boolean,
  logState: EventLogState,
  window: { days: number; from: string; to: string; sinceMs?: number; fromIso?: string; untilMs?: number; toIso?: string },
  role?: string | readonly string[],
): FailureReportData {
  // Scope first when a role was named: every section below derives from these partitions, so
  // narrowing them at the source scopes outcomes, deltas, clusters, merges, and time/spend at
  // once. The unfiltered read's first event is kept for the retention line, so a scoped partial
  // window still names when the log starts, not when the scoped role's own first run does.
  const bases = scopeBases(role);
  const current = bases === undefined ? currentRaw : scopeToRole(currentRaw, bases);
  const prior = bases === undefined ? priorRaw : scopeToRole(priorRaw, bases);
  const allEvents = bases === undefined ? allEventsRaw : scopeToRole(allEventsRaw, bases);
  const oldestRetained = allEventsRaw.length > 0 ? eventDayKey(allEventsRaw[0]!) : null;
  const runEvents = current.filter((ev) => ev.type === "run_end");

  // Outcome table: one row per role, counts per result that occurred.
  const outcomeMap = new Map<string, Partial<Record<RunResult, number>>>();
  for (const ev of runEvents) {
    const role = eventRole(ev);
    const counts = getOrCreate(outcomeMap, role, () => ({}));
    const result = ev.result as RunResult;
    addTo(counts, result, 1);
  }
  // rankByCount orders strongest role first with the ascending-key tiebreak. The old
  // sort-ascending-then-reverse idiom accidentally flipped equal-total ties into
  // reverse-alphabetical order; equal-total roles now follow the stated deterministic rule
  // (pinned by the tie test in test/failure-render.test.ts).
  const outcomes: OutcomeRow[] = rankByCount(
    [...outcomeMap.entries()].map(([role, counts]) => ({ role, counts })),
    (row) => total(row.counts),
    (row) => row.role,
  );

  // Time and spend: the same runs priced by wall-clock span and cost, per role × outcome
  // class, plus the loss ranking that weighs causes by agent-hours rather than run counts.
  const { timeSpend, lossCauses, lossCausesHidden } = timeAndSpend(runEvents, allEvents);

  // Prompt-token telemetry: per role, the median prompt tokens a run sent and how much of
  // the prompt budget went out before the first edit. Only runs carrying the field count, so
  // a pre-feature log leaves the section off entirely.
  const promptStats = promptStatsFor(runEvents);

  // Deltas: current vs preceding window, per role.
  const curStats = roleStats(current);
  const prevStats = roleStats(prior);
  const roles = [...new Set([...curStats.keys(), ...prevStats.keys()])];
  const deltas: DeltaRow[] = roles
    .map((role) => {
      const c = curStats.get(role) ?? { runs: 0, errors: 0, quietKills: 0, rejections: 0 };
      const p = prevStats.get(role) ?? { runs: 0, errors: 0, quietKills: 0, rejections: 0 };
      return {
        role,
        prevRuns: p.runs,
        runs: c.runs,
        prevErrors: p.errors,
        errors: c.errors,
        prevQuietKills: p.quietKills,
        quietKills: c.quietKills,
        prevRejections: p.rejections,
        rejections: c.rejections,
      };
    })
    .sort(
      (a, b) =>
        b.runs - a.runs ||
        b.prevRuns - a.prevRuns ||
        a.role.localeCompare(b.role),
    );

  // Only runs that ENDED as errors carry a run error: `state.lastError` is shared state the
  // merge slot also writes, so a successful run's `run_end` can carry a leftover merge failure's
  // text (BUGS.md 2026-09-21). `main_red` joins them because its cause is written for that result
  // — the baseline gate's own text (src/baseline/main-red.ts), never a leftover — so the
  // section itemizes the outcome that blocks every merge instead of leaving it a bare count
  // (BUGS.md 2026-09-28). The total therefore equals the Outcome table's error column PLUS its
  // main_red cells; the render's section title says so, and merge failures still surface below.
  // The selection predicate is the Outcome table's own — raw `error`/`main_red` results, no
  // error-text test — so a malformed run_end that skipped the text can never be counted above
  // but itemized nowhere: those events cluster under a placeholder cause, keeping the section's
  // total equal to the tables it cross-checks against (BUGS.md 2026-09-30).
  const errorEvents = runEvents.filter(
    (ev) => ev.result === "error" || ev.result === "main_red",
  );
  const errors = section(
    clusterMessages(
      errorEvents.map((ev) => ({
        message: errorTextOrPlaceholder(ev.error),
        role: eventRole(ev),
        ts: ev.ts,
      })),
      ERROR_TOP,
    ),
    errorEvents.length,
  );
  const warnings = messageSection(
    current.map((ev) =>
      ev.type === "warning" && typeof ev.message === "string"
        ? { ...ev, message: ev.message.replace(OLD_MERGE_CHECK_WORDING, "merge check failed (kept for one retry)") }
        : ev,
    ),
    "warning",
    WARNING_TOP,
    (m) => URGENT_WARNING.test(m),
  );
  // Rejections cluster on (role, reasons[0]) — the field the event feed renders — so two
  // different rejection reasons from the same role stay separate rows, and an already-landed
  // one (ev.afterMerge === true) splits apart from a same-reason pre-merge one so the row names
  // the post-merge class whose rejection stands recorded on main. The section's total counts
  // every `review_rejected` in the window, reasons or not, so it equals the Deltas column and
  // the render's remainder line cross-checks against it.
  const rejectedEvents = current.filter((ev) => ev.type === "review_rejected");
  const postMergeRejections = rejectedEvents.filter((ev) => ev.afterMerge === true).length;
  const rejections = section(
    clusterMessages(
      rejectedEvents
        .filter((ev) => Array.isArray(ev.reasons))
        .map((ev) => {
          const reasons = ev.reasons as unknown[];
          const message = ev.afterMerge === true ? `post-merge rejection: ${firstReason(reasons)}` : firstReason(reasons);
          return { message, role: eventRole(ev), ts: ev.ts, keyPrefix: `${eventRole(ev)}\u0000` };
        }),
      REJECTION_TOP,
    ),
    rejectedEvents.length,
  );

  const mergeFailures = mergeFailureSection(current);

  // Merge review failures: a reviewer that could not return a parseable verdict (a dead
  // backend, a transport error) fails closed and keeps the commit, but its authoring run ends
  // `queued`/`no_change` — so the failure lives on the `review_failed` event, never on
  // `run_end.error`. Clustered on their own so the selfcheck role can see a gate that keeps
  // failing without misreading it as a run error (BUGS.md 2026-09-21).
  const reviewFailures = messageSection(current, "review_failed", REVIEW_FAILURE_TOP);

  // The newest MERGED_TOP merges, newest first. The pre-slice count rides along, as it does for
  // the state changes below, so the render can name what the cut left out — a busy window must
  // not read as a MERGED_TOP-merge day (BUGS.md 2026-09-23).
  const allMerged: MergedCommit[] = current
    .filter((ev) => ev.type === "merged")
    .map((ev) => ({
      ts: ev.ts,
      commit: typeof ev.commit === "string" ? ev.commit : "?",
      summary:
        typeof ev.summary === "string" ? truncateExample(ev.summary, SUMMARY_MAX) : "",
    }))
    .sort((a, b) => b.ts - a.ts);
  const merged = allMerged.slice(0, MERGED_TOP);

  // The harness's own decisions, newest STATE_CHANGE_TOP kept in chronological order. The
  // description is bounded at collection so render stays a pure function of this data. The
  // pre-slice count rides along so the render can say when it is showing a cut, not all of them.
  const allStateChanges: StateChange[] = current
    .filter((ev) => STATE_CHANGE_TYPES.has(ev.type))
    .map((ev) => ({ ts: ev.ts, role: eventRole(ev), description: describeStateChange(ev) }))
    .sort((a, b) => a.ts - b.ts);
  const stateChanges: StateChange[] = allStateChanges.slice(-STATE_CHANGE_TOP);

  // Judged on the two partitions, not the whole read: the since collector reads from priorFrom's
  // local day key, which can reach events earlier that day but before priorFrom — outside both
  // windows. Counting those as "events" would suppress the empty-window line with a window that
  // in fact held none. The day collector's read is exactly current ∪ prior (whole local days), so
  // this changes nothing there.
  const hasEvents = current.length > 0 || prior.length > 0;
  const oldestEventDate = hasEvents ? oldestRetained : null;
  // Complete only when the reader proves the whole read window (priorFrom..to) is covered:
  // coversFullWindow fires when the oldest retained line predates priorFrom, so both the delta
  // baseline and the current window reach their starts. Every retained event's day is >= priorFrom
  // (the reader filters on it), so an event-side comparison can never strengthen that proof — the
  // former `oldestEventDate < from` arm declared the digest complete while the prior half was still
  // truncated, leaving the delta table to present a skewed baseline as a real trend. Only a proven
  // window can be trusted as idle rather than truncated by rotation.
  const windowComplete = coversFullWindow;

  return {
    ...window,
    ...(bases === undefined ? {} : { role: bases.join(",") }),
    runs: runEvents.length,
    hasEvents,
    emptyLog: !hasEvents && !coversFullWindow,
    logState,
    partial: hasEvents && !windowComplete,
    oldestEventDate,
    outcomes,
    deltas,
    timeSpend,
    lossCauses,
    lossCausesHidden,
    promptStats,
    errors,
    warnings,
    reviewFailures,
    rejections,
    postMergeRejections,
    mergeFailures,
    merged,
    mergedTotal: allMerged.length,
    stateChanges,
    stateChangesTotal: allStateChanges.length,
  };
}

/** Median of a non-empty numeric list (the mean of the two middles for an even count). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Per-role prompt-token stats from the window's run_end events. Runs without a
 * `promptTokens` reading contribute nothing (and skip a role entirely), so the section only
 * appears once some run ran on a build that records the field. Both reads go through
 * nonNegativeNumber like every other event-log number: a torn or hand-edited line whose
 * `promptTokens` is `1e999` (JSON parses to Infinity) would otherwise land in the median and
 * the `preEditSum / promptSum` ratio as a non-finite value no report can render. */
function promptStatsFor(runs: HarnessEvent[]): PromptStatRow[] {
  interface Acc {
    prompts: number[];
    promptSum: number;
    preEditSum: number;
    cacheReadSum: number;
  }
  const byRole = new Map<string, Acc>();
  for (const ev of runs) {
    const prompt = nonNegativeNumber(ev.promptTokens, 0);
    const preEdit = nonNegativeNumber(ev.preEditPromptTokens, 0);
    if (prompt === 0 && preEdit === 0) continue;
    const role = eventRole(ev);
    const acc = getOrCreate(byRole, role, () => ({ prompts: [], promptSum: 0, preEditSum: 0, cacheReadSum: 0 }));
    if (prompt > 0) {
      acc.prompts.push(prompt);
      acc.promptSum += prompt;
    }
    acc.preEditSum += preEdit;
    const cacheRead = nonNegativeNumber(ev.cacheReadTokens, 0);
    acc.cacheReadSum += cacheRead;
  }
  return [...byRole.entries()]
    .filter(([, acc]) => acc.promptSum > 0)
    .map(([role, acc]) => ({
      role,
      runs: acc.prompts.length,
      medianPromptTokens: median(acc.prompts),
      preEditShare: acc.preEditSum / acc.promptSum,
      ...(acc.cacheReadSum > 0 ? { cacheReadShare: acc.cacheReadSum / acc.promptSum } : {}),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

function total(counts: Partial<Record<RunResult, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}
