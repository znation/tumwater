import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init.js";
import { tickRows, HISTORY_MAX_TICKS } from "../src/ui/history.js";
import { expectedTimestamp, writeEvents } from "./util.js";
import { makeRepo } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";
import type { HarnessEvent } from "../src/types.js";

// The `history` command: the tickRows collector's pairing/filtering/bounding as unit cases,
// plus CLI smoke runs over a seeded event log — the pattern test/cli-logs.test.ts uses.

function endEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_end", tick: 1, result: "changed", ...over } as HarnessEvent;
}

function startEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_start", tick: 1, ...over } as HarnessEvent;
}

test("tickRows pairs each tick_end with its tick_start for the duration", () => {
  const rows = tickRows(
    [
      startEvent({ ts: 1000, loop: "feature", tick: 1 }),
      endEvent({ ts: 46_000, loop: "feature", tick: 1, summary: "tidy up" }),
    ],
    20,
    null,
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.loop, "feature");
  assert.equal(row.tick, 1);
  assert.equal(row.result, "changed");
  assert.equal(row.durationMs, 45_000); // 45s, not 46s: measured from the start event.
  assert.equal(row.detail, "tidy up");
});

test("tickRows renders no duration when the tick's start is outside the scanned window", () => {
  // A skipped tick never logs tick_start; log rotation can drop an older start too. Neither
  // may claim a duration.
  const rows = tickRows([endEvent({ ts: 5000, tick: 2, result: "skipped" })], 20, null);
  assert.equal(rows[0]!.durationMs, null);
  assert.equal(rows[0]!.result, "skipped");
});

test("tickRows returns the newest limit rows, newest first, and filters by role", () => {
  const events = [
    startEvent({ ts: 1000, loop: "feature", tick: 1 }),
    endEvent({ ts: 2000, loop: "feature", tick: 1 }),
    endEvent({ ts: 3000, loop: "clean", tick: 1, result: "no_change" }),
    endEvent({ ts: 4000, loop: "feature", tick: 2, result: "error", error: "boom" }),
    endEvent({ ts: 5000, loop: "feature", tick: 3, result: "no_change" }),
  ];
  assert.deepEqual(
    tickRows(events, 2, null).map((r) => [r.loop, r.tick, r.result]),
    [
      ["feature", 3, "no_change"],
      ["feature", 2, "error"],
    ],
  );
  // The error row's detail is the error; the summary-less no_change row has none.
  const all = tickRows(events, 20, null);
  assert.equal(all[1]!.detail, "boom");
  assert.equal(all[0]!.detail, "");
  // --role narrows to one loop, ends and starts alike: the clean tick vanishes, and feature's
  // durations still pair.
  const scoped = tickRows(events, 20, "clean");
  assert.deepEqual(scoped.map((r) => [r.loop, r.tick]), [["clean", 1]]);
  const feature = tickRows(events, 20, "feature");
  assert.equal(feature.length, 3);
  assert.equal(feature[2]!.durationMs, 1000); // tick 1 still paired within the scoped window.
});

test("tickRows shows tokens and cost only when the event carries them", () => {
  const withUsage = tickRows(
    [endEvent({ ts: 1000, tick: 1, tokens: 1234, costUsd: 0.5 })],
    20,
    null,
  )[0]!;
  assert.equal(withUsage.usage, "1234 tok · $0.50");
  const bare = tickRows([endEvent({ ts: 1000, tick: 1 })], 20, null)[0]!;
  assert.equal(bare.usage, "");
  const zero = tickRows([endEvent({ ts: 1000, tick: 1, tokens: 0, costUsd: 0 })], 20, null)[0]!;
  assert.equal(zero.usage, "");
});

test("tickRows collapses and truncates the detail to keep the row one line", () => {
  const rows = tickRows(
    [endEvent({ ts: 1000, tick: 1, summary: "wrapped  across\nmany   lines" })],
    20,
    null,
  );
  assert.equal(rows[0]!.detail, "wrapped across many lines");
  const long = tickRows([endEvent({ ts: 1000, tick: 1, summary: "x".repeat(200) })], 20, null);
  assert.ok(long[0]!.detail.length < 200);
  assert.ok(long[0]!.detail.endsWith("…"));
});

// --- CLI smoke runs ---

async function seededHistoryRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "cli history test");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "tick_start", tick: 7 },
    { ts: 1787222695956, loop: "feature", type: "tick_end", tick: 7, result: "changed", summary: "added a widget", tokens: 2400, costUsd: 0.02 },
    { ts: 1787222700000, loop: "clean", type: "tick_end", tick: 3, result: "no_change" },
    { ts: 1787222760000, loop: "bugfix", type: "tick_end", tick: 9, result: "error", error: "pi unreachable" },
  ]);
  return repo;
}

test("history prints one row per completed tick, newest first", async () => {
  const repo = await seededHistoryRepo();
  const r = await cli(repo, "history");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /bugfix\s+#9\s+error\s+—\s+pi unreachable/);
  assert.match(lines[1]!, /clean\s+#3\s+no_change/);
  assert.match(lines[2]!, new RegExp(`${expectedTimestamp(1787222695956)}.*feature\\s+#7\\s+changed\\s+4s\\s+2400 tok · \\$0\\.02\\s+added a widget`));
});

test("history --role restricts rows to that loop, including user-defined ids", async () => {
  const repo = await seededHistoryRepo();
  const r = await cli(repo, "history", "--role", "feature");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /feature\s+#7\s+changed/);

  const bogus = await cli(repo, "history", "--role", "bogus");
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /unknown role: bogus/);
});

test("history -n accepts 1..200 and fails zero, negative, non-numeric, and over-large values", async () => {
  const repo = await seededHistoryRepo();
  for (const bad of ["abc", "0", "-5", "2.5"]) {
    const r = await cli(repo, "history", "-n", bad);
    assert.equal(r.code, 1, `-n ${bad} should fail`);
    assert.match(r.stderr, /-n needs a positive integer/);
  }
  const over = await cli(repo, "history", "-n", String(HISTORY_MAX_TICKS + 1));
  assert.equal(over.code, 1);
  assert.match(over.stderr, new RegExp(`-n must be between 1 and ${HISTORY_MAX_TICKS}`));

  const one = await cli(repo, "history", "-n", "1");
  assert.equal(one.code, 0);
  assert.equal(one.stdout.trim().split("\n").length, 1);
  assert.match(one.stdout, /bugfix/);
});

test("history rejects unknown flags, prints no ticks yet on an empty log, and has a help stanza", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history edges");

  const unknown = await cli(repo, "history", "--json");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown argument: --json/);

  const empty = await cli(repo, "history");
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, "no ticks yet\n");

  const help = await cli(repo, "help", "history");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /tumwater history \[--role <id>\] \[-n N\]/);
});
