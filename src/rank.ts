/** One deterministic ranking rule: count descending, then key ascending, so equal counts
 * always order the same way. The helpers here are the single home of that rule; every surface
 * that ranks counters calls one of them rather than re-implementing the comparator —
 * `rankCountEntries` serves the `[key, count]` entry shape (ui/report-render.ts's rankedRoleMap,
 * failure-spread.ts's strongest-kind pick) and `rankByCount` serves callers whose counts are
 * fields or computations on other shapes (failure-cluster.ts's clusters, error-storm.ts's
 * strongest-cause pick, and failure-data.ts's outcome and time-spend tables). The one
 * deliberate exception is ui/gui-client-report.ts's reportRoleOrder, which keeps its own copy
 * by design: it runs in the browser, where harness modules cannot be imported. Both helpers
 * return a fresh sorted array; the input is never mutated. */
export function rankByCount<T>(
  items: Iterable<T>,
  count: (item: T) => number,
  key: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => count(b) - count(a) || key(a).localeCompare(key(b)));
}

/** rankByCount for `[key, count]` entry pairs (count first): ui/report-render.ts's rankedRoleMap
 * and failure-spread.ts's strongest-kind pick. */
export function rankCountEntries<K extends string>(
  entries: Iterable<[K, number]>,
): [K, number][] {
  return rankByCount(entries, (e) => e[1], (e) => e[0]);
}
