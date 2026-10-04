import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events.js";
import { initProject } from "../src/init.js";
import { tickRows, readTickRows, HISTORY_MAX_TICKS } from "../src/history-data.js";
import { displayWidth } from "../src/text-width.js";
import { expectedTimestamp } from "./oracles.js";
import { writeEvents } from "./log-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";

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

test("history CLI keeps the detail column aligned across usage and usage-less rows", async () => {
  // CLI-level pin of the alignment: the usage-less clean row pads its empty usage column, so
  // both detail cells start at the same character index.
  const repo = makeRepo();
  await initProject(repo, "cli history alignment");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "tick_start", tick: 7 },
    { ts: 1787222695956, loop: "feature", type: "tick_end", tick: 7, result: "changed", summary: "added a widget", tokens: 2400, costUsd: 0.02 },
    { ts: 1787222700000, loop: "clean", type: "tick_end", tick: 3, result: "no_change", summary: "tidied" },
  ]);
  const r = await cli(repo, "history");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  // Newest first: the clean (usage-less) row leads, the feature row follows.
  const detail0 = lines[0]!.indexOf("tidied");
  const detail1 = lines[1]!.indexOf("added a widget");
  assert.ok(detail0 > 0 && detail1 > 0, "both rows show their detail");
  assert.equal(detail0, detail1, "detail columns align across a row with no usage");
});

test("history grows the scan window to pair a tick_start the first window's boundary cut off", async () => {
  // The default window (limit*2+50) can end inside a tick's own event block: every tick_end
  // the ask needs sits within it, but the oldest one's tick_start sits just before the
  // boundary — and since the row count is satisfied, growth keyed on short rows alone never
  // re-read. The log holds the start, so the row must show its duration, not a dash.
  const repo = makeRepo();
  await initProject(repo, "cli history boundary");
  const events: HarnessEvent[] = [{ ts: 1000, loop: "feature", type: "tick_start", tick: 1 } as HarnessEvent];
  // Unrelated events inflate the span between the two tick_ends past the first window: 41
  // merged events put tick 1's end at depth 54 of a 55-event log, exactly one event short of
  // carrying its own start (window = 2*2+50 = 54).
  for (let i = 0; i < 41; i++) events.push({ ts: 1001 + i, loop: "other", type: "merged" } as HarnessEvent);
  events.push(
    { ts: 5000, loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "work", tokens: 100, costUsd: 0.01 } as HarnessEvent,
  );
  for (let i = 0; i < 10; i++) events.push({ ts: 5001 + i, loop: "other", type: "merged" } as HarnessEvent);
  events.push(
    { ts: 10000, loop: "feature", type: "tick_start", tick: 2 } as HarnessEvent,
    { ts: 11000, loop: "feature", type: "tick_end", tick: 2, result: "changed", summary: "work 2" } as HarnessEvent,
  );
  writeEvents(repo, events);
  const r = await cli(repo, "history", "-n", "2");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  // Newest first: tick 2 pairs inside the first window (1s); tick 1's start only pairs once
  // the window grows — 4s, from its start at ts 1000 to its end at ts 5000.
  assert.match(lines[0]!, /#2\s+changed\s+1s\s+work 2/);
  assert.match(lines[1]!, /#1\s+changed\s+4s\s+100 tok · \$0\.01\s+work/);
});

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

test("history --role grows its scan window until it reaches the role's ticks", async () => {
  // The dilution case: the first window (limit*2+50 events) fills with a busy sibling loop's
  // tick_ends, so the filtered rows fall short while older qa ticks sit just past it. The
  // command must re-read with a larger window instead of printing fewer rows (or, at the
  // extreme, "no ticks yet" for a role that had ticks).
  const repo = makeRepo();
  await initProject(repo, "history dilution");
  const events: HarnessEvent[] = [];
  for (let i = 0; i < 5; i++) events.push({ ts: 1000 + i, loop: "qa", type: "tick_end", tick: i + 1, result: "changed", summary: `qa fix ${i}` });
  for (let i = 0; i < 60; i++) events.push({ ts: 2000 + i, loop: "clean", type: "tick_end", tick: i + 1, result: "no_change" });
  writeEvents(repo, events);
  const r = await cli(repo, "history", "--role", "qa", "-n", "5");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /qa\s+#5\s+changed\s+—\s+qa fix 4/); // no tick_start seeded: — duration

  // The honest-shortfall case: the log holds fewer qa ticks than asked and the scan reached
  // its start — the growth loop must stop and print what exists, not spin.
  const short = await cli(repo, "history", "--role", "qa", "-n", "10");
  assert.equal(short.code, 0);
  assert.equal(short.stdout.trim().split("\n").length, 5);
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

test("history keeps the loop column aligned when a loop name holds a wide character", async () => {
  // CJK/emoji render two terminal columns per code point but count as one UTF-16 code unit:
  // a width table built from `.length` and padded with padEnd leaves that row's later columns
  // shifted left against its ASCII neighbors.
  const repo = makeRepo();
  await initProject(repo, "cli history wide alignment");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "tick_end", tick: 7, result: "changed", summary: "added a widget" },
    { ts: 1787222700000, loop: "翻译", type: "tick_end", tick: 3, result: "no_change", summary: "tidied" },
  ]);
  const r = await cli(repo, "history");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  // The `#tick` cell opens the first padded column, so its display column must be identical
  // across rows — the boundary the earlier cells pad up to.
  const cols = lines.map((l) => displayWidth(l.slice(0, l.indexOf("#"))));
  assert.equal(new Set(cols).size, 1, `loop columns align across rows: ${lines.join(" | ")}`);
});

test("history --json prints the tick rows as machine-readable data", async () => {
  const repo = await seededHistoryRepo();

  const r = await cli(repo, "history", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { rows: unknown[] };
  // The payload is the collector's own output: identical to what the GUI's /api/history
  // serves for the same log, and to what the table renders.
  assert.deepEqual(payload, JSON.parse(JSON.stringify({ rows: readTickRows(repo, HISTORY_MAX_TICKS, null) })));
  const rows = payload.rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 3); // The tick_start contributes no row.
  // Newest first, with the raw fields the table's renderings are derived from.
  assert.equal(rows[0]!["loop"], "bugfix");
  assert.equal(rows[0]!["ts"], 1787222760000);
  assert.equal(rows[0]!["tokens"], 0); // Omit-when-zero: absent usage fields read as 0.
  assert.equal(rows[0]!["costUsd"], 0);
  assert.equal(rows[1]!["loop"], "clean");
  assert.equal(rows[1]!["result"], "no_change");
  assert.equal(rows[1]!["usage"], "");
  assert.equal(rows[2]!["loop"], "feature");
  assert.equal(rows[2]!["ts"], 1787222695956);
  assert.equal(rows[2]!["tokens"], 2400);
  assert.equal(rows[2]!["costUsd"], 0.02);
  assert.equal(rows[2]!["detail"], "added a widget");
  assert.match(rows[2]!["usage"] as string, /2400 tok · \$0\.02/);
});

test("history --json prints an empty document on an empty log, never the prose", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history json empty");

  const r = await cli(repo, "history", "--json");
  assert.equal(r.code, 0);
  // A JSON document always, so a parsing caller never sees `no ticks yet` on stdout.
  assert.deepEqual(JSON.parse(r.stdout), { rows: [] });
  assert.ok(!r.stdout.includes("no ticks yet"));
});

test("history --json combines with --role and -n and still rejects unknown flags", async () => {
  const repo = await seededHistoryRepo();

  const scoped = await cli(repo, "history", "--json", "--role", "feature", "-n", "5");
  assert.equal(scoped.code, 0);
  const payload = JSON.parse(scoped.stdout) as { rows: Array<{ loop: string; tick: number }> };
  assert.deepEqual(payload.rows.map((r) => [r.loop, r.tick]), [["feature", 7]]);
  // The same scope through the table path renders the same single row's detail.
  const table = await cli(repo, "history", "--role", "feature", "-n", "5");
  assert.match(table.stdout, /added a widget/);
  assert.equal(table.stdout.trim().split("\n").length, 1);

  const unknown = await cli(repo, "history", "--json", "--days");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown argument: --days/);
});

test("history rejects unknown flags, prints no ticks yet on an empty log, and has a help stanza", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history edges");

  const unknown = await cli(repo, "history", "--days");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown argument: --days/);

  const empty = await cli(repo, "history");
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, "no ticks yet\n");

  const help = await cli(repo, "help", "history");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /tumwater history \[--role <id>\] \[-n N\] \[--since <duration>\] \[--grep <text>\] \[--json\]/);
  assert.match(help.stdout, /machine-readable history data/);
});

// --- --since <duration>: the window-shaped view (the sibling of logs --since / report --since)

/** Seed tick pairs at fixed ages before `now` (the pattern cli-logs-filtering.ts uses for
 * --since): one 2-day-old tick_end outside any sane window, then a clean tick (start 50m,
 * end 45m) and a feature tick (start 30m, end 10m) inside a 1h window. */
function seedWindowedHistory(repo: string, now = Date.now()): void {
  const age = (ms: number) => now - ms;
  writeEvents(repo, [
    { ts: age(2 * 86_400_000), loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "old work" },
    { ts: age(50 * 60_000), loop: "clean", type: "tick_start", tick: 2 },
    { ts: age(45 * 60_000), loop: "clean", type: "tick_end", tick: 2, result: "no_change", summary: "tidied" },
    { ts: age(30 * 60_000), loop: "feature", type: "tick_start", tick: 3 },
    { ts: age(10 * 60_000), loop: "feature", type: "tick_end", tick: 3, result: "changed", summary: "new work", tokens: 1200, costUsd: 0.01 },
  ]);
}

test("history --since returns exactly the ticks of the window, newest first, with durations where starts survive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since window");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  // Newest first; the 2-day-old tick is outside the window on both the day key and ts.
  assert.match(lines[0]!, /feature\s+#3\s+changed\s+20m\s+1200 tok · \$0\.01\s+new work/);
  assert.match(lines[1]!, /clean\s+#2\s+no_change\s+5m\s+tidied/);
  assert.ok(!r.stdout.includes("old work"), r.stdout);
  // The log's oldest retained event (2d) predates the cutoff, so the window is provably
  // covered: no rotation note.
  assert.ok(!r.stdout.includes("note:"), r.stdout);

  // --role composes with --since: history's --role is a row filter, not a rival view.
  const scoped = await cli(repo, "history", "--since", "1h", "--role", "clean");
  assert.equal(scoped.code, 0);
  assert.equal(scoped.stdout.trim().split("\n").length, 1);
  assert.match(scoped.stdout, /clean\s+#2/);
  assert.ok(!scoped.stdout.includes("feature"), scoped.stdout);
});

test("history --since --json emits the window's rows raw and an empty document for an empty window", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since json");
  const seededAt = Date.now();
  seedWindowedHistory(repo, seededAt);

  const r = await cli(repo, "history", "--since", "1h", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { rows: Array<Record<string, unknown>> };
  assert.deepEqual(payload.rows.map((row) => [row.loop, row.tick]), [["feature", 3], ["clean", 2]]);
  // Raw epoch ms, not the rendered time: exactly the seeded 10m-ago tick_end's stamp — compared
  // to the seed's own clock, not a read after the CLI ran, which a loaded host pushed past the
  // old 5 s tolerance (7-8 s CLI runs, BUGS.md 2026-10-01).
  assert.equal(payload.rows[0]!["ts"], seededAt - 10 * 60_000, "the 10m-ago instant, as raw epoch ms");
  assert.equal(payload.rows[0]!["tokens"], 1200);
  assert.equal(payload.rows[0]!["costUsd"], 0.01);
  // The note never touches JSON output — a parsing consumer reads rows only.
  assert.ok(!r.stdout.includes("note:"), r.stdout);

  // A window holding no tick_end answers as an empty document, never prose.
  const empty = await cli(repo, "history", "--since", "1s", "--json");
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { rows: [] });
});

test("history --since prints the hedged rotation note after the table, table mode only", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since note");
  // Every event lies inside the 1h window, so the oldest retained event cannot prove the
  // window's coverage (rotation or idleness — the hedged phrasing stays true either way).
  const now = Date.now();
  writeEvents(repo, [
    { ts: now - 10 * 60_000, loop: "clean", type: "tick_start", tick: 1 },
    { ts: now - 5 * 60_000, loop: "clean", type: "tick_end", tick: 1, result: "no_change", summary: "tidied" },
  ]);

  const r = await cli(repo, "history", "--since", "1h");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  assert.match(lines[0]!, /clean\s+#1/);
  assert.equal(
    lines[1],
    "note: the log's oldest retained event lies inside this window; older events may have rotated out",
    "the note rides the table's end, cmdLogs' wording verbatim",
  );

  const json = await cli(repo, "history", "--since", "1h", "--json");
  assert.equal(json.code, 0);
  assert.ok(!json.stdout.includes("note:"), json.stdout);
});

test("history --since refuses the rival shape and validates through the shared duration helpers", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since validation");

  const rival = await cli(repo, "history", "--since", "1h", "-n", "5");
  assert.equal(rival.code, 1);
  assert.match(rival.stderr, /--since .*-n/);
  assert.match(rival.stderr, /rival shapes/);

  const overCap = await cli(repo, "history", "--since", "8d");
  assert.equal(overCap.code, 1);
  assert.match(overCap.stderr, /history --since is capped at 7d \(got 8d\)/);

  const malformed = await cli(repo, "history", "--since", "45x");
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /history --since needs a duration like 45s, 90m, 1h30m, or 2d/);

  const valueless = await cli(repo, "history", "--since");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /history --since needs a value/);

  // Table mode's empty-window prose: `no ticks in <duration>`, durationLabel's phrasing.
  seedWindowedHistory(repo);
  const empty = await cli(repo, "history", "--since", "1s");
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, "no ticks in 1s\n");
});

// --- --grep <text>: the row filter its sibling logs --grep already has

test("history --grep keeps only rows whose rendered line matches, case-insensitively", async () => {
  const repo = await seededHistoryRepo();

  const r = await cli(repo, "history", "--grep", "WIDGET");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /feature\s+#7\s+changed/);
  assert.match(lines[0]!, /added a widget/);

  // An empty match names the pattern, never the empty-log prose: "no ticks yet" would be a
  // false statement about a log this command just scanned (the logs --grep rule).
  const none = await cli(repo, "history", "--grep", "no such text");
  assert.equal(none.code, 0);
  assert.equal(none.stdout, 'no ticks matching "no such text"\n');

  // The stable event id is greppable: the haystack prefixes the raw type.
  const type = await cli(repo, "history", "--grep", "tick_end");
  assert.equal(type.code, 0);
  assert.equal(type.stdout.trim().split("\n").length, 3);
});

test("history --grep treats a flag-shaped pattern as text, not a flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history grep impersonation");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "tick_end", tick: 7, result: "changed", summary: "reverted --since handling" },
  ]);
  const r = await cli(repo, "history", "--grep", "--since");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /reverted --since handling/);
});

test("history --grep composes with -n, which bounds the scanned window", async () => {
  const repo = await seededHistoryRepo();

  // The last two rows are bugfix #9 and clean #3: feature #7 lies outside the scan — a
  // scanned-but-unmatched window says so, it does not claim the log was empty.
  const narrow = await cli(repo, "history", "-n", "2", "--grep", "widget");
  assert.equal(narrow.code, 0);
  assert.equal(narrow.stdout, 'no ticks matching "widget"\n');

  const wide = await cli(repo, "history", "-n", "3", "--grep", "widget");
  assert.equal(wide.code, 0);
  assert.match(wide.stdout, /added a widget/);
});

test("history --grep composes with --role", async () => {
  const repo = await seededHistoryRepo();

  const unscoped = await cli(repo, "history", "--grep", "no_change");
  assert.equal(unscoped.code, 0);
  assert.match(unscoped.stdout, /clean\s+#3/);

  const scoped = await cli(repo, "history", "--role", "feature", "--grep", "no_change");
  assert.equal(scoped.code, 0);
  assert.equal(scoped.stdout, 'no ticks matching "no_change"\n');
});

test("history --since --grep filters the window's rows", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since grep");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h", "--grep", "new work");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.match(r.stdout, /feature\s+#3/);

  // The 2-day-old tick sits outside the window, so its detail matches nothing here — the
  // empty-match wording names the pattern, not a window the log disproves.
  const outside = await cli(repo, "history", "--since", "1h", "--grep", "old work");
  assert.equal(outside.code, 0);
  assert.equal(outside.stdout, 'no ticks matching "old work"\n');

  // Without --grep the empty window keeps its own prose — the pattern branch never leaks.
  const plain = await cli(repo, "history", "--since", "1s");
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout, "no ticks in 1s\n");
});

test("history --grep --json filters the payload and stays a document when empty", async () => {
  const repo = await seededHistoryRepo();

  const r = await cli(repo, "history", "--json", "--grep", "widget");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { rows: Array<{ loop: string }> };
  assert.deepEqual(payload.rows.map((row) => row.loop), ["feature"]);

  const empty = await cli(repo, "history", "--json", "--grep", "no such text");
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { rows: [] });
});

test("history --grep fails with its own wording when the value is missing or empty", async () => {
  const repo = await seededHistoryRepo();

  const valueless = await cli(repo, "history", "--grep");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /history --grep needs a pattern/);

  const empty = await cli(repo, "history", "--grep", "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /history --grep needs a pattern/);
});
