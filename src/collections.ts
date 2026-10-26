/** Generic collection shaping shared across the harness — pure, no I/O, no domain types, so
 * any layer may import it: grouping, counter seeding, and the deterministic count/key ranking.
 * Small by design: the harness prefers one named home for a repeated shape over a grab-bag
 * utilities module. */

/** Group items by a key, preserving first-seen key order and input order within each group.
 * The single home of the "append to a Map of arrays" step, shared by the event bucketers
 * (history-queued.ts's bucketMergeEvents, failure/time-spend.ts's rejected-by-role pass) and
 * the team-hold poll's observations-by-provider grouping (team-polls.ts's pollTeamHold), so
 * those sites cannot drift on how a missing key is seeded. Returns a fresh Map; the input is
 * never mutated. */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    getOrCreate(groups, key(item), () => []).push(item);
  }
  return groups;
}

/** Return `map`'s value for `key`, creating and storing `make()`'s result first when the key is
 * absent — the single home of the `map.get(key) ?? fresh; …; map.set(key, value)` step, shared
 * by the failure digest's per-role stats, outcome, and prompt-token accumulators (failure-data.ts),
 * its time-and-spend per-role row (time-spend.ts), the team hold's provider+kind grouping
 * (team-hold.ts), the error-storm reducer's roles-by-key set (src/team/error-storm.ts), and
 * `groupBy` above, so those sites cannot drift on how a missing key is seeded. `make` runs only
 * when the key is absent. A stored value of `undefined` reads as absent, matching the `??` idiom
 * this replaces; the callers above never store one. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = make();
  map.set(key, created);
  return created;
}

/** Filter a list by a keep predicate, returning the kept items and each kept item's 1-based
 * position in the original list — the single home of the "keep some, but number by the whole
 * list" step, shared by the two queue-scope twins `scopeMergeQueue` (src/merge/
 * merge-queue-render.ts) and `scopePostReviews` (src/review/post-merge-review-render.ts), so
 * `tumwater queue --role` and `tumwater reviews --role` keep the same whole-queue positions
 * a later position-addressed verb (`--cancel`, `--accept`) still addresses. The predicate runs
 * once per item, in input order; positions run 1..length, not a kept-only renumbering. */
export function filterKeepPositions<T>(items: readonly T[], keep: (item: T) => boolean): { kept: T[]; positions: number[] } {
  const positions: number[] = [];
  const kept = items.filter((item, i) => {
    const isKept = keep(item);
    if (isKept) positions.push(i + 1);
    return isKept;
  });
  return { kept, positions };
}

/** Increment a Map counter, seeding a missing key at 1 — the single home of the
 * `map.set(k, (map.get(k) ?? 0) + 1)` step, shared by the failure-spread kind tally
 * (src/team/failure-spread.ts), the diff multiset's line tally (merge/merge-diff.ts), the
 * section-title tally (backlog/backlog-structure.ts), the logs' per-type tally
 * (cli/log-commands.ts), the flaky-check tally
 * (doctor/doctor-project-checks.ts), and the multi-runner base tally
 * (orchestrator/orchestrator-scheduling.ts) — the exit-summary round's outcome tally
 * (cli/cli-start-summary.ts) seeds its own copy of this step inline — so those sites cannot
 * drift on how a missing key is seeded. */
export function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Add `amount` to a plain-object counter, seeding a missing key at `amount` — the record
 * sibling of `increment`, the single home of the `record[key] = (record[key] ?? 0) + n`
 * step (the seed matters because `noUncheckedIndexedAccess` reads every entry as possibly
 * undefined), shared by the failure digest's outcome tally per role (failure-data.ts), the
 * usage report's window role totals (report-render.ts), and its per-day fold's run and cost
 * tallies (report-fold.ts), so those sites cannot drift on how a missing key is seeded. The
 * test duration reporter (test/test-durations-reporter.ts) keeps its own copy: it imports no
 * tumwater module by design, since node --test loads it into its own parent process.
 *
 * The seed reads an OWN property (Object.hasOwn), not a bare `record[key] ?? 0`: the
 * custom-role name charset admits "constructor", an Object.prototype key, whose inherited
 * function would otherwise be the seed — storing `function Object() …5` and turning every
 * later `roleSum`/report total into string concatenation (BUGS.md 2026-10-10). The write is
 * an `Object.defineProperty`, not a plain `record[key] = …`: the latter assignment to
 * `__proto__` (another Object.prototype key, reachable through a failing-test name) would
 * trigger the inherited setter and create no own key, silently dropping the count. A
 * defineProperty with the default attribute flags (writable, enumerable, configurable)
 * writes every other key exactly as plain assignment would, so an own `__proto__` key is
 * the only behavior this changes. */
export function addTo<K extends string>(
  record: Partial<Record<K, number>>,
  key: K,
  amount: number,
): void {
  const current = Object.hasOwn(record, key) ? record[key] : 0;
  Object.defineProperty(record, key, {
    value: (current ?? 0) + amount,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Set `key` to `value` in a bounded memo `cache`, moving an existing key to the LRU tail
 * (delete + re-set, so a re-read at the cap does not evict itself) and, when the map would
 * exceed `max` entries, dropping the oldest (first-inserted) one. The single home of the
 * bounded-memo discipline — the `delete(key); set(key, …)` refresh and the
 * `keys().next().value` oldest-eviction — shared by the report fold (report-fold.ts's
 * reportFoldCache), the failure digest (failure-data.ts's failureDigestCache), and the
 * baseline verdict cache (main-baseline.ts's baselineCache), so those sites cannot drift on
 * how a hit is refreshed or an over-cap cache drained. After any call the map holds at most
 * `max` entries. */
export function memoSetLru<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  if (cache.has(key)) cache.delete(key);
  if (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Trim `arr` in place so it holds at most `max` elements, keeping only the newest (last) `max`
 * and dropping the whole overflow from the front in one splice — the single home of the
 * "keep the newest capped buffer" discipline that src/ui/transcript.ts's feedEntries and
 * src/history/history.ts's `logs --follow` buffer both hand-rolled before, so those sites
 * cannot drift on how an over-cap buffer is drained. Batch appends may overflow by more than
 * one at a time, so the whole excess is dropped rather than a single element; an `arr` already
 * at or under `max` is untouched. Mutates `arr` in place and returns nothing. (Deliberately
 * unlike the per-element ring drains of src/scheduling/backoff.ts and src/orchestrator/
 * orchestrator-launch.ts, which shift one entry at a time as they push — each is a different
 * shape and keeps its own copy.) */
export function trimToLast<T>(arr: T[], max: number): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/** One deterministic ranking rule: count descending, then key ascending, so equal counts always
 * order the same way. These two helpers are the single home of that rule; every surface that
 * ranks counters by count calls one of them rather than re-implementing the comparator —
 * `rankCountEntries` serves the `[key, count]` entry shape (src/report/report-render.ts's
 * rankedRoleMap, src/team/failure-spread.ts's strongest-kind pick) and `rankByCount` serves
 * callers whose counts are fields or computations on other shapes
 * (src/failure/failure-cluster.ts's clusters, src/team/error-storm.ts's strongest-cause pick,
 * failure-data.ts's outcome table, and time-spend.ts's time-and-spend table). `sortByValueDesc`
 * is the deliberate sibling for the same value-descending shape that wants a code-unit tiebreak
 * instead of localeCompare, and unlike these two it sorts its input array in place. The one
 * deliberate exception to both orderings is ui/gui/gui-client-report-chart.ts's reportRoleOrder,
 * which keeps its own copy by design: it runs in the browser, where harness modules cannot be
 * imported.
 * These two helpers return a fresh sorted array; their input is never mutated. */
export function rankByCount<T>(
  items: Iterable<T>,
  count: (item: T) => number,
  key: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => count(b) - count(a) || key(a).localeCompare(key(b)));
}

/** Split a list into its first `top` entries and how many were cut off — the pairing five call
 * sites built by hand as `items.slice(0, N)` beside `Math.max(0, items.length - N)`. `visible`
 * aliases `items` when it already fits; `hidden` is `max(0, items.length - top)`, which the
 * slice-length arithmetic yields without the explicit clamp (a slice never returns more than
 * `top` even when the list is shorter). Shared by the merge-intent and conflict-hunk caps
 * (merge-git.ts), the failure digest's loss-cause and message-cluster tops
 * (time-spend.ts, failure-cluster.ts), and the answered-questions cap (question-answer.ts),
 * so those cuts cannot drift on how the remainder is counted. */
export function topAndHidden<T>(items: readonly T[], top: number): { visible: T[]; hidden: number } {
  const visible = items.slice(0, top);
  return { visible, hidden: items.length - visible.length };
}

/** The lower median of a non-empty numeric list: the middle value, or the smaller of the
 * middle two for an even count. Returns a fresh sorted copy; the input is never mutated.
 * Shared by report-data.ts's per-day medians, doctor-project-checks.ts's and doctor-backlog.ts's
 * 24 h phrase medians. (failure-data.ts's `median` is deliberately different: the mean of
 * the middle two for an even count.) */
export function lowerMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** Most-days-waited-first comparator, ties in ascending index (file order) — `b.days - a.days ||
 * a.index - b.index`, the single home of that one-line ordering. Shared by the stale-bug
 * alert (src/ui/alert-feeds.ts's staleOpenBugs) and the stale-waiting-bug doctor row
 * (src/doctor/doctor-backlog-bugs.ts's staleWaitingBugRows), which both build `{index, days}`
 * rows off the same backlog scan, so the two cannot drift on how ties order. The generic holds
 * any row type carrying both fields; a row without a natural index passes its first-seen order. */
export function byDaysThenIndex<T extends { days: number; index: number }>(a: T, b: T): number {
  return b.days - a.days || a.index - b.index;
}

/** Ascending string comparator by UTF-16 code unit — the locale-independent order a bare `.sort()`
 * uses, unlike `localeCompare` (which `rankByCount` uses for its tiebreak). Used directly by
 * src/cli/cli-start-summary.ts, src/cli/completion.ts, src/cli/log-commands.ts,
 * src/history/history-data.ts, src/review/post-merge-review.ts, src/review/quarantine-render.ts,
 * src/budget/budget.ts and src/change/change-data.ts, and by `sortByValueDesc` for its tiebreak. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rank `[key, value, …]` pairs by value descending, breaking ties in code-unit order
 * (compareCodeUnits — the locale-independent order, unlike rankByCount's localeCompare), so
 * equal values always order the same way. The single home of that comparator, which
 * src/cli/log-commands.ts's per-type event-count lines and src/report/report-render.ts's
 * mergeDone sort hand-rolled before; `…rest` lets a site carry extra trailing fields
 * (report-render's third column) through the sort untouched. Mutates and returns the input
 * array, matching the `.sort()` the call sites replaced. */
export function sortByValueDesc<K extends string, Rest extends unknown[]>(
  entries: Array<[K, number, ...Rest]>,
): Array<[K, number, ...Rest]> {
  return entries.sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]));
}

/** Sort `[key, …]` entry pairs by their string key ascending — the single home of the
 * `entries.sort(([a], [b]) => a.localeCompare(b))` step, shared by the budget check's
 * capped-role rows (doctor-holds.ts's checkBudget), the permit pool's provider fragment
 * (ui/badges.ts's permitsBadge), and the doctor's rate-limit standing-holds rows
 * (doctor-holds.ts's checkRateLimitHolds), so those sites cannot drift on how a possibly
 * `undefined` key (a rate-limit hold recorded with no provider) orders. A missing key sorts
 * first, matching the `(a ?? "")` guard the hold site alone needed; on a defined string the
 * guard is a no-op, so the comparator is identical for the other two. Returns a fresh sorted
 * array; the input is never mutated. (Deliberately unlike the value-descending `sortByValueDesc`
 * and the count-then-key `rankCountEntries` above, which sort by a different axis. Also used to
 * stabilize a Map's insertion order before an assertion in test/once-round.test.ts.) */
export function sortEntriesByKey<K extends string | undefined, T>(
  entries: Array<[K, T]>,
): Array<[K, T]> {
  return [...entries].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
}

/** rankByCount for `[key, count]` entry pairs (count first): src/report/report-render.ts's
 * rankedRoleMap, src/team/failure-spread.ts's strongest-kind pick, and
 * src/doctor/doctor-contention-checks.ts's check-wait and provider-wait rankings. */
export function rankCountEntries<K extends string>(
  entries: Iterable<[K, number]>,
): [K, number][] {
  return rankByCount(entries, (e) => e[1], (e) => e[0]);
}
