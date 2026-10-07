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
    getOrCreate(groups, key(item), () => []).push(item);
  }
  return groups;
}

/** Return `map`'s value for `key`, creating and storing `make()`'s result first when the key
 * is absent — the single home of the `map.get(key) ?? fresh; …; map.set(key, value)` step,
 * shared by the failure digest's per-role stats, outcome, and prompt-token accumulators
 * (failure-data.ts), its time-and-spend per-role row (time-spend.ts), the fleet hold's
 * provider+kind grouping (fleet-hold.ts), the error-storm reducer's roles-by-key set
 * (error-storm.ts), and `groupBy` above, so those sites cannot drift on how a missing key is
 * seeded. `make` runs only when the key is absent. A stored value of `undefined` reads as
 * absent, matching the `??` idiom this replaces; the callers above never store one. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = make();
  map.set(key, created);
  return created;
}

/** Increment a Map counter, seeding a missing key at 1 — the single home of the
 * `map.set(k, (map.get(k) ?? 0) + 1)` step, shared by the failure-spread kind tally
 * (failure-spread.ts), the diff multiset's line tally (landing/landing-diff.ts), the
 * section-title tally (backlog/backlog-structure.ts), and the once-summary outcome tally
 * (cli/cli-run.ts), so those sites cannot drift on how a missing key is seeded. */
export function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Add `amount` to a plain-object counter, seeding a missing key at `amount` — the record
 * sibling of `increment`, the single home of the `record[key] = (record[key] ?? 0) + n`
 * step (the seed matters because `noUncheckedIndexedAccess` reads every entry as possibly
 * undefined), shared by the failure digest's outcome tally per role (failure-data.ts), the
 * usage report's window role totals (report-render.ts), and its per-day fold's tick and cost
 * tallies (report-data.ts), so those sites cannot drift on how a missing key is seeded. The
 * test duration reporter (test/test-durations-reporter.ts) keeps its own copy: it imports no
 * tumwater module by design, since node --test loads it into its own parent process. */
export function addTo<K extends string>(
  record: Partial<Record<K, number>>,
  key: K,
  amount: number,
): void {
  record[key] = (record[key] ?? 0) + amount;
}
