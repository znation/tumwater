import test from "node:test";
import assert from "node:assert/strict";
import type { TestEvent } from "node:test/reporters";
import durationsReporter from "./test-durations-reporter.js";

/** What the durations reporter does with a hand-fed event stream: only nesting-0 pass/fail
 * events with a file contribute their duration, summed per compiled basename, and the whole
 * run folds into exactly one JSON line. These are the rules test-runner.ts's longest-first
 * scheduling stands on — a mis-summed duration silently reorders the suite, so they are
 * pinned here against a fake event stream instead of a real run. */

/** A minimal valid TestEvent — the reporter only touches type, nesting, file, and
 * details.duration_ms, so a partial object is faithful to the contract it relies on. */
function event(
  type: TestEvent["type"],
  opts: { nesting?: number; file?: string; durationMs?: number } = {},
): TestEvent {
  return {
    type,
    data: {
      nesting: opts.nesting ?? 0,
      file: opts.file,
      details: { duration_ms: opts.durationMs ?? 0 },
    },
  } as unknown as TestEvent;
}

/** Drive the reporter over `events` and return its single yielded JSON line, parsed. */
async function runReporter(events: TestEvent[]): Promise<Record<string, number>> {
  async function* source(): AsyncGenerator<TestEvent> {
    for (const e of events) yield e;
  }
  const lines: string[] = [];
  for await (const line of durationsReporter(source())) lines.push(line);
  assert.equal(lines.length, 1, "the reporter folds the whole run into exactly one output line");
  assert.ok(lines[0]);
  return JSON.parse(lines[0]) as Record<string, number>;
}

test("sums nesting-0 test durations per file, pass and fail alike", async () => {
  const totals = await runReporter([
    event("test:pass", { file: "/dist/test/loop.test.js", durationMs: 100 }),
    event("test:pass", { file: "/dist/test/loop.test.js", durationMs: 50 }),
    event("test:fail", { file: "/dist/test/merge.test.js", durationMs: 20 }),
  ]);
  assert.deepEqual(totals, { "loop.test.js": 150, "merge.test.js": 20 });
});

test("ignores nested tests so a file's time is never counted twice", async () => {
  const totals = await runReporter([
    event("test:pass", { file: "/dist/test/loop.test.js", durationMs: 100 }),
    event("test:pass", { nesting: 1, file: "/dist/test/loop.test.js", durationMs: 90 }),
    event("test:fail", { nesting: 2, file: "/dist/test/loop.test.js", durationMs: 10 }),
  ]);
  assert.deepEqual(totals, { "loop.test.js": 100 });
});

test("ignores events without a duration-bearing file (suites, diagnostics)", async () => {
  const totals = await runReporter([
    event("test:start"),
    event("test:pass", { durationMs: 5 }),
    event("test:diagnostic", { file: "/dist/test/x.test.js" } as never),
    event("test:summary", { file: "/dist/test/x.test.js", durationMs: 999 }),
  ]);
  assert.deepEqual(totals, {});
});

test("a file is keyed by basename, so equal names from different dirs fold together", async () => {
  const totals = await runReporter([
    event("test:pass", { file: "/dist/test/a.test.js", durationMs: 1 }),
    event("test:pass", { file: "/other/dist/test/a.test.js", durationMs: 2 }),
  ]);
  assert.deepEqual(totals, { "a.test.js": 3 });
});

test("an empty stream yields an empty object, not no output", async () => {
  const totals = await runReporter([]);
  assert.deepEqual(totals, {});
});
