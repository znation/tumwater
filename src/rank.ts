/** One deterministic ranking for `[key, count]` entries: count descending, then key ascending,
 * so equal counts always order the same way. This "strongest first, alphabetical tiebreak"
 * rule is stated and re-implemented inline at every surface that ranks counters — the usage
 * report's per-role lines (ui/report.ts's rankedRoleMap), the browser twin it is pinned
 * against (ui/gui-client-report.ts's reportRoleOrder, which cannot import harness modules and
 * keeps its own copy by design), the fleet's spread alarm's strongest-kind pick
 * (failure-spread.ts), and, in object shape, the failure digest's clusters (failure-cluster.ts)
 * and the error-storm alarm's strongest-cause pick (error-storm.ts). This is the single home
 * of the entry-shaped form. Returns a fresh sorted array; the input is never mutated. */
export function rankCountEntries<K extends string>(
  entries: Iterable<[K, number]>,
): [K, number][] {
  return [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
