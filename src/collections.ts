/** Generic collection shaping shared across the harness — pure, no I/O, no domain types, so
 * any layer may import it. Small by design: the harness prefers one named home for a repeated
 * shape over a grab-bag utilities module. */

/** Group items by a key, preserving first-seen key order and input order within each group.
 * The single home of the "append to a Map of arrays" step, shared by the event bucketers
 * (history-data.ts's bucketLandingEvents, failure/time-spend.ts's rejected-by-loop pass) and
 * the fleet-hold poll's observations-by-provider grouping, so those sites cannot drift on how
 * a missing key is seeded. Returns a fresh Map; the input is never mutated. */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k) ?? [];
    list.push(item);
    groups.set(k, list);
  }
  return groups;
}
