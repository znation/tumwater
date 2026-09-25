import path from "node:path";
import type { TestEvent } from "node:test/reporters";

/** The node:test reporter behind test-runner.ts's longest-first scheduling: it sums each test
 * file's top-level test durations and, when the run ends, yields them as one JSON object —
 * `{ "<compiled file basename>": ms }` — to its destination file, which the runner merges into
 * the durations it orders the next run by. A top-level test's duration covers its subtests, so
 * nesting 0 alone counts each millisecond once. Kept free of any tumwater import: node --test
 * loads a reporter into its own parent process. */
export default async function* durationsReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const totals: Record<string, number> = {};
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { data } = event;
    if (data.nesting !== 0 || !data.file) continue;
    const name = path.basename(data.file);
    totals[name] = (totals[name] ?? 0) + data.details.duration_ms;
  }
  yield JSON.stringify(totals);
}
